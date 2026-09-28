import { Fragment, useState } from "react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { PageHeader, Panel } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { CheckCircle, XCircle } from "lucide-react";
import { useReportDefaultRange, type ReportDefaultRange } from "@/hooks/useReportDefaultRange";
import { FiscalRangeNotice, ReportRangeLoading } from "@/components/FiscalRangeNotice";
import { PeriodShortcuts } from "@/components/PeriodShortcuts";

/**
 * 🔴 `accountId`, NOT `id`. This interface declared `id` and the API has never
 * sent one — `reports.service.ts` returns `accountId`. So `row.id` was
 * `undefined` on every row, and the table keyed all of its rows on `undefined`.
 *
 * Two consequences, and the second is the one that matters:
 *   1. A React key warning — invisible until the fixture first seeded a
 *      journal entry, because with no rows there was nothing to key.
 *   2. 🔴 Rows sharing a key can be MIS-RECONCILED on re-render — changing the
 *      date range could leave a figure from the previous range sitting in a
 *      row that now belongs to a different account. A wrong number, quietly,
 *      in the one report whose purpose is that it adds up.
 *
 * The hand-written-interface class again ("a correct API and a UI written
 * against an imagined one"), which TypeScript cannot catch: it checks this
 * declaration against the component, never against the response.
 */
import type { TrialBalanceReport, TrialBalanceRow } from "@workspace/api-client-react";

// The account-TYPE tokens (not the state palette): a type is a category, not a verdict.
const TYPE_STYLES: Record<string, string> = { income: "text-income", expense: "text-expense", asset: "text-asset", liability: "text-liability", equity: "text-equity" };

export default function TrialBalance() {
  // M20.1 — the report does not mount until its default window is known, so a
  // wrong window (the old hardcoded Jan–Dec) is never queried or rendered,
  // even for a frame.
  const range = useReportDefaultRange();
  if (!range.ready) return <ReportRangeLoading />;
  return <TrialBalanceInner range={range} />;
}

function TrialBalanceInner({ range }: { range: ReportDefaultRange }) {
  const { n, lang, t } = useLanguage();
  const [dateFrom, setDateFrom] = useState(range.from);
  const [dateTo, setDateTo] = useState(range.to);
  const [applied, setApplied] = useState({ from: range.from, to: range.to });

  const { data, isLoading } = useQuery<TrialBalanceReport>({
    queryKey: ["trial-balance", applied.from, applied.to],
    queryFn: () => apiFetch(`/reports/trial-balance?date_from=${applied.from}&date_to=${applied.to}`),
  });

  const byType = data ? data.accounts.reduce((acc, row) => {
    const tp = row.type;
    if (!acc[tp]) acc[tp] = [];
    acc[tp].push(row);
    return acc;
  }, {} as Record<string, TrialBalanceRow[]>) : {};

  /**
   * 🔴 EVERY TYPE PRESENT IN THE DATA IS RENDERED — the known ones in a chosen
   * order, then anything else.
   *
   * This was a fixed list of five, and the service assigns `type: "other"` to
   * any journal line whose account does not resolve to a category
   * (`reports.service.ts`: `cat?.type ?? "other"`). `account_id` is nullable
   * and the manual journal-entry form lets a user type a free-text account
   * name, so "other" is reachable from the product's own UI.
   *
   * The result was a TRIAL BALANCE THAT DID NOT FOOT. Those rows were dropped
   * from the table, while `totalDebit` / `totalCredit` in the tfoot come from
   * the SERVER and included them — so the visible rows summed to less than the
   * stated total, with nothing saying so. A trial balance is the one report
   * whose entire purpose is that it adds up.
   *
   * 🔴 Found only when the fixture first seeded a journal entry (2026-08-31).
   * No test could have caught it before: with no journal lines at all, both the
   * table and the total were empty and agreed perfectly.
   *
   * Deriving the order from the data rather than listing it makes the silent
   * drop INEXPRESSIBLE — a new account type appears in the report instead of
   * vanishing from it.
   */
  const KNOWN_TYPES = ["income", "expense", "asset", "liability", "equity"];
  const typeOrder = [
    ...KNOWN_TYPES.filter(t => byType[t]?.length),
    ...Object.keys(byType).filter(t => !KNOWN_TYPES.includes(t)).sort(),
  ];

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader
        title={t("Trial Balance", "ميزان المراجعة")}
        description={t("All ledger account balances — debits must equal credits", "جميع أرصدة الحسابات — المدين يجب أن يساوي الدائن")}
        actions={data && (
          <span className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[13px] font-medium ${data.balanced ? "border-positive/30 bg-positive-surface/15 text-positive" : "border-negative/30 bg-negative-surface/15 text-negative"}`}>
            {data.balanced ? <CheckCircle className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
            {data.balanced ? t("Balanced", "متوازن") : t("Out of Balance", "غير متوازن")}
          </span>
        )}
      >
        <div className="mt-2"><FiscalRangeNotice source={range.source} /></div>
      </PageHeader>

      <Panel>
        <div className="flex flex-wrap items-end gap-3">
          <div><Label className="text-xs text-muted-foreground">{t("From", "من")}</Label><Input type="date" value={dateFrom} onChange={e=>setDateFrom(e.target.value)} className="mt-1 h-8 text-sm w-40" /></div>
          <div><Label className="text-xs text-muted-foreground">{t("To", "إلى")}</Label><Input type="date" value={dateTo} onChange={e=>setDateTo(e.target.value)} className="mt-1 h-8 text-sm w-40" /></div>
          <Button size="sm" className="h-8" onClick={()=>setApplied({from:dateFrom,to:dateTo})}>{t("Apply", "تطبيق")}</Button>
        </div>
        <div className="mt-3">
          <PeriodShortcuts from={dateFrom} to={dateTo} onSelect={(r)=>{setDateFrom(r.from);setDateTo(r.to);setApplied(r);}} />
        </div>
      </Panel>

      {isLoading ? <div className="text-muted-foreground text-sm p-4">{t("Loading trial balance...", "جارٍ التحميل...")}</div> : !data ? null : (
        <Panel flush title={<>{t("Trial Balance", "ميزان المراجعة")} — {applied.from} {t("to", "إلى")} {applied.to}</>}>
          <div className="overflow-x-auto"><table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="text-start px-3">{t("Account", "الحساب")}</th>
                <th className="text-start px-3">{t("Type", "النوع")}</th>
                <th className="text-end px-3">{t("Debit (SAR)", "مدين (ر.س)")}</th>
                <th className="text-end px-3">{t("Credit (SAR)", "دائن (ر.س)")}</th>
              </tr>
            </thead>
            <tbody>
              {typeOrder.filter(tp => byType[tp]?.length > 0).map(type => (
                <Fragment key={type}>
                  <tr>
                    <td colSpan={4} className={`px-3 pt-6 pb-2 text-[13px] font-semibold capitalize text-foreground`}>{type}</td>
                  </tr>
                  {byType[type].map(row => (
                    <tr key={row.accountId ?? row.name} className="hover:bg-muted/40 transition-colors">
                      <td className="py-2 px-3">
                        <span className="block ps-4">
                          <span className="text-foreground">{n(row.name, row.nameAr)}</span>
                          {row.nameAr && row.nameAr !== "(not yet translated)" && lang === "en" && <span className="text-muted-foreground text-xs ms-2"><span dir="rtl">{row.nameAr}</span></span>}
                        </span>
                      </td>
                      <td className="py-2 px-3"><Badge variant="outline" className={`text-xs capitalize border-0 px-0 ${TYPE_STYLES[row.type]??""}`}>{row.type}</Badge></td>
                      <td className="py-2 px-3 text-end whitespace-nowrap tabular-nums">{row.debit > 0 ? fmtNum(row.debit) : <span className="text-muted-foreground">—</span>}</td>
                      <td className="py-2 px-3 text-end whitespace-nowrap tabular-nums">{row.credit > 0 ? fmtNum(row.credit) : <span className="text-muted-foreground">—</span>}</td>
                    </tr>
                  ))}
                  <tr className="border-t border-border font-semibold">
                    <td className="py-2.5 px-3">{t("Subtotal", "المجموع الفرعي")} — <span className="capitalize">{type}</span></td>
                    <td />
                    <td className="py-2.5 px-3 text-end whitespace-nowrap tabular-nums">{fmtNum(byType[type].reduce((s,r)=>s+r.debit,0))}</td>
                    <td className="py-2.5 px-3 text-end whitespace-nowrap tabular-nums">{fmtNum(byType[type].reduce((s,r)=>s+r.credit,0))}</td>
                  </tr>
                </Fragment>
              ))}
            </tbody>
            <tfoot>
              <tr className={`font-semibold ${data.balanced ? "text-positive" : "text-negative"}`}>
                <td className="py-3.5 px-3">{t("Total", "الإجمالي")}</td>
                <td />
                <td className="py-3.5 px-3 text-end whitespace-nowrap tabular-nums text-base">{fmtNum(data.totalDebit)}</td>
                <td className="py-3.5 px-3 text-end whitespace-nowrap tabular-nums text-base">{fmtNum(data.totalCredit)}</td>
              </tr>
            </tfoot>
          </table></div>
        </Panel>
      )}
    </div>
  );
}
