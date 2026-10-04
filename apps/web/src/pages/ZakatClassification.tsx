/**
 * Phase 16B — the Zakat classification of the chart (decision pack §3.3; owner
 * Q6 — classification lives on the chart of accounts, org-level).
 *
 * Every asset and liability posting account takes ONE of eight classes, each
 * tied to its article of the 1445H Regulations. 🔴 Only a person's
 * classification is stored. Where the account's role decides the class (a
 * fixed asset's cost and accumulated depreciation; a current account), the
 * server's SUGGESTION is pre-selected and the person confirms it with one
 * click — never applied by itself, never in bulk ("suggestions are
 * pre-selected, the human clicks", CLAUDE.md §9). Equity accounts are equity by
 * their own type (Art. 9, 23(1)) and do not appear here.
 */
import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListZakatClassifications, useSetZakatClassification, useClearZakatClassification, getListZakatClassificationsQueryKey,
  type ZakatAccountClassification, type ZakatClass,
} from "@workspace/api-client-react";
import { fmtDate } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/contexts/LanguageContext";
import { useGuarded } from "@/lib/singleSubmit";
import { zakatClassLabel } from "@/lib/taxLabels";
import { liquidityLabel } from "@/lib/liquidity";

type Filter = "unclassified" | "all";

export default function ZakatClassification() {
  const { t, n } = useLanguage();
  const list = useListZakatClassifications();
  const [filter, setFilter] = useState<Filter>("unclassified");
  const [search, setSearch] = useState("");
  const rows = list.data ?? [];
  const shown = useMemo(() => rows
    .filter((r) => (filter === "all" ? true : r.classification == null))
    .filter((r) => !search.trim() || `${r.name} ${r.nameAr ?? ""} ${r.systemCode ?? ""}`.toLowerCase().includes(search.trim().toLowerCase())), [rows, filter, search]);
  const unclassified = rows.filter((r) => r.classification == null).length;

  return (
    <div className="space-y-6" data-testid="zakat-classification-page">
      <div>
        <p className="text-xs"><Link href="/zakat" className="underline text-muted-foreground">{t("Zakat", "الزكاة")}</Link></p>
        <h1 className="text-2xl font-bold text-foreground">{t("Zakat account classification", "تصنيف الحسابات للزكاة")}</h1>
        <p className="text-sm text-muted-foreground mt-1 max-w-3xl">
          {t("One class per asset and liability account, for the whole organisation's chart. The class decides how the account's year-end balance enters the Zakat base (Art. 9: as SOCPA-endorsed standards classify it; Art. 17: at its value in the year-end statement of financial position). Changing a class changes every computation that reads the account — an approved year keeps its frozen figure and shows that its inputs changed.",
            "تصنيف واحد لكل حساب أصل والتزام، لدليل حسابات المنشأة كلها. يحدد التصنيف كيف يدخل رصيد الحساب في نهاية السنة الوعاءَ الزكوي (المادة 9: وفق تصنيف المعايير المعتمدة؛ المادة 17: بقيمته في قائمة المركز المالي في نهاية السنة). تغيير التصنيف يغيّر كل احتساب يقرأ الحساب — وتحتفظ السنة المعتمدة برقمها المجمّد وتُظهر أن مدخلاتها تغيّرت.")}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Select value={filter} onValueChange={(v) => setFilter(v as Filter)}>
          <SelectTrigger className="h-8 w-64 text-sm" data-testid="zakat-class-filter"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="unclassified">{t("Not yet classified", "غير مصنفة بعد")}</SelectItem>
            <SelectItem value="all">{t("All asset and liability accounts", "كل حسابات الأصول والالتزامات")}</SelectItem>
          </SelectContent>
        </Select>
        <Input className="h-8 w-56 text-sm" placeholder={t("Search accounts", "بحث في الحسابات")} value={search} onChange={(e) => setSearch(e.target.value)} data-testid="zakat-class-search" />
        {list.data && <p className="text-sm text-muted-foreground" data-testid="zakat-class-counts">{t(`${unclassified} of ${rows.length} accounts not yet classified`, `${unclassified} من ${rows.length} حسابًا غير مصنف بعد`)}</p>}
      </div>

      <Card className="border-border"><CardContent className="pt-4">
        {list.isLoading ? <p className="text-sm text-muted-foreground">{t("Loading…", "جارٍ التحميل…")}</p>
          : shown.length === 0 ? <p className="text-sm text-muted-foreground" data-testid="zakat-class-empty">{filter === "unclassified" ? t("Every asset and liability account is classified.", "كل حسابات الأصول والالتزامات مصنفة.") : t("No account matches.", "لا يوجد حساب مطابق.")}</p>
          : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="zakat-class-table">
                <thead><tr className="border-b border-border text-xs text-muted-foreground">
                  {[t("Account", "الحساب"), t("Type", "النوع"), t("Class", "التصنيف"), t("Basis (optional)", "الأساس (اختياري)"), t("Confirmed", "التأكيد"), ""].map((h) => <th key={h} className="text-start pb-2 pe-3 font-medium whitespace-nowrap">{h}</th>)}
                </tr></thead>
                <tbody>{shown.map((r) => <ClassRow key={r.accountId} row={r} label={n(r.name, r.nameAr)} />)}</tbody>
              </table>
            </div>
          )}
        <p className="text-xs text-muted-foreground mt-3">{t("A contra account (accumulated depreciation) takes its asset's class, so the deduction is NET (Art. 48(1)(b)). Whether contra-asset allowances are Art. 24 provisions is open question Z-2 — the class you choose is the answer the computation uses.", "يأخذ الحساب المقابل (مجمع الإهلاك) تصنيف أصله، فيكون الحسم بالصافي (المادة 48(1)(ب)). هل مخصصات مقابلة الأصول مخصصات وفق المادة 24؟ سؤال مفتوح Z-2 — والتصنيف الذي تختاره هو الجواب الذي يستخدمه الاحتساب.")}</p>
      </CardContent></Card>
    </div>
  );
}

function ClassRow({ row, label }: { row: ZakatAccountClassification; label: string }) {
  const { t } = useLanguage();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [cls, setCls] = useState<string>(row.classification ?? row.suggestion ?? "");
  const [note, setNote] = useState(row.basisNote ?? "");
  const refresh = () => qc.invalidateQueries({ queryKey: getListZakatClassificationsQueryKey() });
  const save = useGuarded(useSetZakatClassification({ mutation: { onSuccess: () => { refresh(); toast({ title: t("Classification confirmed", "تم تأكيد التصنيف") }); } } }));
  const clear = useGuarded(useClearZakatClassification({ mutation: { onSuccess: () => { refresh(); setCls(row.suggestion ?? ""); toast({ title: t("Classification withdrawn", "تم سحب التصنيف") }); } } }));
  const changed = cls !== (row.classification ?? "") || (note.trim() || null) !== (row.basisNote ?? null);
  return (
    <tr className="border-b border-border/50 align-top" data-testid={`zakat-class-row-${row.accountId}`}>
      <td className="py-2 pe-3">{label}{row.systemCode && <span className="block text-xs text-muted-foreground font-mono" dir="ltr">{row.systemCode}</span>}</td>
      <td className="py-2 pe-3">{row.type === "asset" ? t("Asset", "أصل") : t("Liability", "التزام")}{liquidityLabel(row.liquidityClass, t) && <span className="block text-xs text-muted-foreground">{liquidityLabel(row.liquidityClass, t)}</span>}</td>
      <td className="py-2 pe-3 min-w-56">
        <Select value={cls} onValueChange={setCls}>
          <SelectTrigger className="h-8 text-sm" data-testid={`zakat-class-select-${row.accountId}`}><SelectValue placeholder={t("Choose a class…", "اختر تصنيفًا…")} /></SelectTrigger>
          <SelectContent>{row.allowed.map((c: ZakatClass) => <SelectItem key={c} value={c}>{zakatClassLabel(c, t)}</SelectItem>)}</SelectContent>
        </Select>
        {row.classification == null && row.suggestion && <p className="text-xs text-muted-foreground mt-1" data-testid={`zakat-class-suggested-${row.accountId}`}>{t("Suggested from the account's role — confirm it to apply.", "مقترح من دور الحساب — أكّده ليُطبَّق.")}</p>}
      </td>
      <td className="py-2 pe-3 min-w-48"><Input className="h-8 text-sm" value={note} onChange={(e) => setNote(e.target.value)} placeholder={t("e.g. Art. 45 conditions met", "مثلًا: شروط المادة 45 متحققة")} data-testid={`zakat-class-note-${row.accountId}`} /></td>
      <td className="py-2 pe-3 whitespace-nowrap text-xs text-muted-foreground">{row.confirmedAt ? fmtDate(row.confirmedAt) : t("Not confirmed", "غير مؤكد")}</td>
      <td className="py-2 whitespace-nowrap">
        <div className="flex flex-wrap gap-1">
          <Button size="sm" className="h-7" disabled={!cls || !changed || save.isPending} data-testid={`zakat-class-save-${row.accountId}`}
            onClick={() => save.mutate({ accountId: row.accountId, data: { classification: cls as ZakatClass, basisNote: note.trim() || null } })}>
            {row.classification == null ? t("Confirm", "تأكيد") : t("Save", "حفظ")}
          </Button>
          {row.classification != null && <Button size="sm" variant="ghost" className="h-7" disabled={clear.isPending} onClick={() => clear.mutate({ accountId: row.accountId })} data-testid={`zakat-class-clear-${row.accountId}`}>{t("Withdraw", "سحب")}</Button>}
        </div>
      </td>
    </tr>
  );
}
