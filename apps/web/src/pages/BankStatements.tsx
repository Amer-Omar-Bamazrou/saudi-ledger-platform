/**
 * THE BANK STATEMENT REGISTER (Phase 12A, 2026-09-23).
 * Record: docs/product/phase-12-banking-reconciliation-decision-pack.md §3.
 *
 * Every statement imported, per bank, oldest first — with what the bank said
 * (period, opening and closing balance), what the file held, what was actually
 * imported (DERIVED — a re-exported period can import nothing new), and how
 * each statement FOLLOWS the one before it.
 *
 * 🔴 Continuity is shown, never used to refuse an import. A gap means a
 * statement is missing; a balance break means the bank's own figures do not
 * hand over. Both are facts the user must see and fix by importing what is
 * missing — which is exactly what the reconciliation (12D) depends on.
 */
import { useState } from "react";
import { Link } from "wouter";
import { fmtNum } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FileSpreadsheet, UploadCloud } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { PageHeader, Panel, EmptyState } from "@/components/kit";
import { useBankOptions } from "@/components/payments/shared";
import { useListBankStatements, getListBankStatementsQueryKey, type BankStatementContinuity, type ListBankStatementsParams } from "@workspace/api-client-react";

const Money = ({ v }: { v: number | null | undefined }) =>
  v == null ? <span className="text-muted-foreground">—</span> : <span className="tabular-nums" dir="ltr">{fmtNum(v)}</span>;

/** How a statement follows the previous one — one label set, used by the register and by the upload page. */
export const CONTINUITY: Record<BankStatementContinuity, { en: string; ar: string; attention: boolean }> = {
  first: { en: "First statement", ar: "أول كشف", attention: false },
  continuous: { en: "Follows on", ar: "متصل", attention: false },
  gap: { en: "Gap — a statement is missing", ar: "فجوة — كشف مفقود", attention: true },
  overlap: { en: "Overlaps the previous one", ar: "يتداخل مع السابق", attention: true },
  balance_break: { en: "Opening ≠ previous closing", ar: "الافتتاحي ≠ الختامي السابق", attention: true },
  unknown: { en: "Balances not stated", ar: "الأرصدة غير محددة", attention: false },
};

export default function BankStatements() {
  const { t, lang } = useLanguage();
  const { banks, byId } = useBankOptions();
  const [bank, setBank] = useState<string>("all");
  const params: ListBankStatementsParams = bank === "all" ? {} : { bankAccountId: Number(bank) };
  const { data, isLoading, isError } = useListBankStatements(params, { query: { queryKey: getListBankStatementsQueryKey(params) } });
  const items = data?.items ?? [];

  return (
    <div className="space-y-6" data-testid="page-bank-statements">
      <PageHeader
        title={t("Bank statements", "كشوف الحسابات البنكية")}
        description={t("Every statement imported, with what the bank stated and how each one follows the last. A gap or a balance break means a statement is missing — import it; nothing here is refused for it.",
               "كل كشف تم استيراده، مع ما ذكره البنك وكيف يتبع كل كشف سابقه. الفجوة أو انقطاع الرصيد تعني أن كشفًا مفقود — استورده؛ ولا يُرفض شيء هنا بسببها.")}
        actions={<Link href="/upload"><Button className="gap-2" data-testid="bank-statements-import"><UploadCloud className="w-4 h-4" />{t("Import a statement", "استيراد كشف")}</Button></Link>}
      />

      <Panel flush>
        <div className="border-b border-border px-5 py-3">
          <div className="w-full sm:w-64">
            <Select value={bank} onValueChange={setBank}>
              <SelectTrigger data-testid="bank-statements-bank"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("All bank accounts", "كل الحسابات البنكية")}</SelectItem>
                {banks.map((b) => <SelectItem key={b.id} value={String(b.id)}>{b.name} — {b.bankName}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>
          {isLoading ? <p className="p-5 text-sm text-muted-foreground">{t("Loading…", "جارٍ التحميل…")}</p>
           : isError ? <p className="p-5 text-sm text-negative">{t("Could not load the statements.", "تعذّر تحميل الكشوف.")}</p>
           : items.length === 0 ? (
            <EmptyState
              icon={FileSpreadsheet}
              title={<span data-testid="no-bank-statements">{t("No statement has been imported as a statement yet. Lines imported before statements were recorded carry none.", "لم يُستورد أي كشف ككشف بعد. الأسطر المستوردة قبل تسجيل الكشوف لا تحمل كشفًا.")}</span>}
            />
          ) : (
            <div className="overflow-x-auto"><table className="w-full text-sm">
              <thead><tr className="border-b border-border">
                {([[t("Bank", "البنك"), false], [t("Period", "الفترة"), false], [t("Opening", "الافتتاحي"), true], [t("Closing", "الختامي"), true], [t("Lines imported", "الأسطر المستوردة"), true], [t("File", "الملف"), false], [t("Continuity", "الاتصال"), false]] as const).map(([h, num]) => (
                  <th key={h} className={`${num ? "text-end" : "text-start"} px-3`}>{h}</th>
                ))}
              </tr></thead>
              <tbody>
                {items.map((s) => {
                  const c = CONTINUITY[s.continuity];
                  const b = byId(s.bankAccountId);
                  return (
                    <tr key={s.id} className="border-b border-border/70 hover:bg-muted/40 transition-colors align-top" data-testid={`bank-statement-${s.id}`}>
                      <td className="py-3 px-3 min-w-[10rem]">{b ? `${b.name} — ${b.bankName}` : `#${s.bankAccountId}`}</td>
                      <td className="py-3 px-3 text-[13px] whitespace-nowrap tabular-nums"><span dir="ltr">{s.periodFrom} → {s.periodTo}</span></td>
                      <td className="py-3 px-3 text-end whitespace-nowrap"><Money v={s.openingBalance} /></td>
                      <td className="py-3 px-3 text-end whitespace-nowrap"><Money v={s.closingBalance} /></td>
                      <td className="py-3 px-3 text-end whitespace-nowrap tabular-nums" data-testid={`bank-statement-imported-${s.id}`}><span dir="ltr">{s.importedCount} / {s.lineCount}</span></td>
                      <td className="py-3 px-3 text-[13px] text-muted-foreground max-w-48 truncate" title={s.fileSha256 ?? undefined}>
                        {s.fileName ?? (s.source === "manual_entry" ? t("Entered, not a file", "مُدخل، ليس ملفًا") : "—")}
                      </td>
                      <td className="py-3 px-3">
                        <Badge variant="outline" className={`text-[11px] font-normal ${c.attention ? "text-attention border-attention/40" : ""}`} data-testid={`bank-statement-continuity-${s.id}`}>{t(c.en, c.ar)}</Badge>
                        {/* The detail is the server's sentence (English, with the dates and
                            amounts); the badge carries the state in both languages. */}
                        {s.continuityDetail && lang !== "ar" && <p className="text-[12px] text-muted-foreground mt-1 max-w-64">{s.continuityDetail}</p>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table></div>
          )}
      </Panel>
    </div>
  );
}
