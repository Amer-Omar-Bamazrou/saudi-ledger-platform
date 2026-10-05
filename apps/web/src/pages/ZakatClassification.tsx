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
 *
 * 🔴 QA-04 (2026-10-04): the page showed NO balances, so an accountant
 * classified blind, and a computation's "Classify these accounts" link landed
 * on every account with its blockers unmarked. Each account now shows its
 * amount in the statement of financial position at a chosen date (a fiscal
 * year-end by default) — the server reads the SAME balance-sheet rows the
 * computation reads at its year-end (never a second balance computation) — and
 * the "blocking" filter shows exactly the unclassified accounts that would
 * block a computation for a year ending at that date — by what the computation
 * READS (`zakatReads`: the year's own Zakat accrual left out, Z-3), not by the
 * raw balance. The date and the filter live in the
 * URL, so the computation's link opens the page already scoped to its year.
 */
import { useMemo, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListZakatClassifications, useSetZakatClassification, useClearZakatClassification, getListZakatClassificationsQueryKey,
  useListFiscalYears,
  type ZakatAccountClassification, type ZakatClass,
} from "@workspace/api-client-react";
import { businessToday } from "@workspace/shared";
import { fmtDate, fmtNum } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/contexts/LanguageContext";
import { useGuarded } from "@/lib/singleSubmit";
import { zakatClassLabel } from "@/lib/taxLabels";
import { liquidityLabel } from "@/lib/liquidity";
import { defaultComputationYear } from "@/lib/taxYears";

type Filter = "unclassified" | "blocking" | "all";
const FILTERS: Filter[] = ["unclassified", "blocking", "all"];
const ISO = /^\d{4}-\d{2}-\d{2}$/;
/**
 * Carries an amount the Zakat computation for a year ending at the date READS — to the halala, as it counts.
 * Not the raw balance: the year's own Zakat accrual is left out of its base (Z-3), so the Zakat payable holding
 * only that accrual blocks nothing (the page said it did until the walk of 2026-10-04).
 */
const carries = (r: ZakatAccountClassification) => r.zakatReads != null && Math.round(r.zakatReads * 100) !== 0;
const hasBalance = (r: ZakatAccountClassification) => r.balance != null && Math.round(r.balance * 100) !== 0;

export default function ZakatClassification() {
  const { t, n } = useLanguage();
  const today = businessToday();
  const search = useSearch();
  const [location, navigate] = useLocation();
  const params = new URLSearchParams(search);
  const fiscal = useListFiscalYears();
  // the year-ends a balance is read at: every fiscal year that has started (its end — the Zakat date), and today
  const yearEnds = (fiscal.data?.periods ?? []).filter((p) => p.startDate <= today).map((p) => p.endDate);
  const suggested = defaultComputationYear(fiscal.data?.periods ?? [], today);
  const fromUrl = params.get("asOf");
  const asOf = fromUrl && ISO.test(fromUrl) ? fromUrl : suggested && suggested.endDate < today ? suggested.endDate : today;
  const filterParam = params.get("filter");
  const filter: Filter = FILTERS.includes(filterParam as Filter) ? (filterParam as Filter) : "unclassified";
  const term = params.get("q") ?? "";
  /** One writer for the page's scope: the URL (replaced — re-scoping a page is not a step back/forward should walk). */
  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(search);
    if (value == null || value === "") next.delete(key); else next.set(key, value);
    const qs = next.toString();
    navigate(`${location}${qs ? `?${qs}` : ""}`, { replace: true });
  };

  const q = { asOf };
  const list = useListZakatClassifications(q, { query: { queryKey: getListZakatClassificationsQueryKey(q) } });
  const rows = list.data ?? [];
  const shown = useMemo(() => rows
    .filter((r) => (filter === "all" ? true : filter === "blocking" ? r.classification == null && carries(r) : r.classification == null))
    .filter((r) => !term.trim() || `${r.name} ${r.nameAr ?? ""} ${r.systemCode ?? ""}`.toLowerCase().includes(term.trim().toLowerCase())), [rows, filter, term]);
  const unclassified = rows.filter((r) => r.classification == null).length;
  const blocking = rows.filter((r) => r.classification == null && carries(r)).length;
  const dateOptions = [...new Set([...yearEnds, today, asOf])].sort((a, b) => b.localeCompare(a));

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

      <div className="flex flex-wrap items-end gap-3">
        <div>
          <p className="text-xs text-muted-foreground mb-1">{t("Balances at", "الأرصدة في")}</p>
          <Select value={asOf} onValueChange={(v) => setParam("asOf", v)}>
            <SelectTrigger className="h-8 w-56 text-sm" data-testid="zakat-class-asof"><SelectValue /></SelectTrigger>
            <SelectContent>
              {dateOptions.map((d) => (
                <SelectItem key={d} value={d}>{fmtDate(d)}{d === today ? ` — ${t("today", "اليوم")}` : yearEnds.includes(d) ? ` — ${t("year-end", "نهاية السنة")}` : ""}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <p className="text-xs text-muted-foreground mb-1">{t("Show", "عرض")}</p>
          <Select value={filter} onValueChange={(v) => setParam("filter", v === "unclassified" ? null : v)}>
            <SelectTrigger className="h-8 w-72 max-w-full text-sm" data-testid="zakat-class-filter"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="unclassified">{t("Not yet classified", "غير مصنفة بعد")}</SelectItem>
              <SelectItem value="blocking">{t("Not classified — blocking a computation at this date", "غير مصنفة — توقف احتساب هذا التاريخ")}</SelectItem>
              <SelectItem value="all">{t("All asset and liability accounts", "كل حسابات الأصول والالتزامات")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Input className="h-8 w-56 max-w-full text-sm" placeholder={t("Search accounts", "بحث في الحسابات")} value={term} onChange={(e) => setParam("q", e.target.value)} data-testid="zakat-class-search" />
        {list.data && (
          <p className="text-sm text-muted-foreground basis-full" data-testid="zakat-class-counts">
            {t(`${unclassified} of ${rows.length} accounts not yet classified — ${blocking} of them carry an amount a Zakat computation for a year ending ${fmtDate(asOf)} reads, and would block it.`,
              `${unclassified} من ${rows.length} حسابًا غير مصنف بعد — منها ${blocking} تحمل مبلغًا يقرؤه احتساب زكاة سنة تنتهي في ${fmtDate(asOf)}، فتوقفه.`)}
          </p>
        )}
      </div>

      <Card className="border-border"><CardContent className="pt-4">
        {list.isLoading ? <p className="text-sm text-muted-foreground">{t("Loading…", "جارٍ التحميل…")}</p>
          : shown.length === 0 ? <p className="text-sm text-muted-foreground" data-testid="zakat-class-empty">{term.trim() ? t("No account matches.", "لا يوجد حساب مطابق.") : filter === "unclassified" ? t("Every asset and liability account is classified.", "كل حسابات الأصول والالتزامات مصنفة.") : filter === "blocking" ? t(`No unclassified account carries an amount a computation for a year ending ${fmtDate(asOf)} reads — nothing here blocks it.`, `لا يوجد حساب غير مصنف يحمل مبلغًا يقرؤه احتساب سنة تنتهي في ${fmtDate(asOf)} — لا شيء هنا يوقفه.`) : t("No account matches.", "لا يوجد حساب مطابق.")}</p>
          : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="zakat-class-table">
                <thead><tr className="border-b border-border text-xs text-muted-foreground">
                  {[t("Account", "الحساب"), t("Type", "النوع"), t(`Balance at ${fmtDate(asOf)}`, `الرصيد في ${fmtDate(asOf)}`), t("Class", "التصنيف"), t("Basis (optional)", "الأساس (اختياري)"), t("Confirmed", "التأكيد"), ""].map((h) => <th key={h} className="text-start pb-2 pe-3 font-medium whitespace-nowrap">{h}</th>)}
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
      <td className="py-2 pe-3">
        {label}{row.systemCode && <span className="block text-xs text-muted-foreground font-mono" dir="ltr">{row.systemCode}</span>}
        {!row.isPosting && <span className="block text-xs text-muted-foreground max-w-64" data-testid={`zakat-class-header-${row.accountId}`}>{t("Header account — listed because it carries entries of its own from before per-bank cash accounts; the computation reads its balance.", "حساب رئيسي — مُدرج لأنه يحمل قيودًا خاصة به من قبل الحسابات النقدية لكل بنك؛ ويقرأ الاحتساب رصيده.")}</span>}
      </td>
      <td className="py-2 pe-3">{row.type === "asset" ? t("Asset", "أصل") : t("Liability", "التزام")}{liquidityLabel(row.liquidityClass, t) && <span className="block text-xs text-muted-foreground">{liquidityLabel(row.liquidityClass, t)}</span>}</td>
      <td className="py-2 pe-3 text-end whitespace-nowrap" data-testid={`zakat-class-balance-${row.accountId}`}>
        {row.balance == null ? "—" : <span className={`font-mono ${hasBalance(row) ? "" : "text-muted-foreground"}`} dir="ltr">{fmtNum(row.balance)}</span>}
        {row.balance != null && !hasBalance(row) && <span className="block text-xs text-muted-foreground">{t("no balance — blocks nothing", "لا رصيد — لا يوقف شيئًا")}</span>}
        {hasBalance(row) && row.zakatReads != null && Math.round(row.zakatReads * 100) !== Math.round((row.balance ?? 0) * 100) && (
          <span className="block text-xs text-muted-foreground whitespace-normal max-w-56" data-testid={`zakat-class-own-accrual-${row.accountId}`}>
            {t(`The year's own Zakat accrual is left out of its base (Z-3) — the computation reads ${fmtNum(row.zakatReads)}.`, `تُستبعد زكاة السنة نفسها من وعائها (Z-3) — يقرأ الاحتساب ${fmtNum(row.zakatReads)}.`)}
          </span>
        )}
        {carries(row) && row.classification == null && <span className="block text-xs" data-testid={`zakat-class-blocks-${row.accountId}`}>{t("unclassified, with a balance — blocks", "غير مصنف وله رصيد — يوقف الاحتساب")}</span>}
      </td>
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
