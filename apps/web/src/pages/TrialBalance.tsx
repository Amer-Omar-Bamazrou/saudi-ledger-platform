import { Fragment, useState } from "react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CheckCircle, XCircle } from "lucide-react";
import { useReportDefaultRange, type ReportDefaultRange } from "@/hooks/useReportDefaultRange";
import { FiscalRangeNotice, ReportRangeLoading } from "@/components/FiscalRangeNotice";
import { PeriodShortcuts } from "@/components/PeriodShortcuts";
import { Link } from "wouter";
import { ReportExportButtons } from "@/components/reports/ReportExport";
import { glDrillHref } from "@/lib/reportDrill";

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

const TYPE_STYLES: Record<string, string> = { income: "text-positive", expense: "text-negative", asset: "text-info", liability: "text-attention", equity: "text-purple-400" };
/** Section labels by account TYPE key — never the raw English key on an Arabic page. */
const TYPE_LABELS: Record<string, { en: string; ar: string }> = {
  income: { en: "Income", ar: "الإيرادات" }, revenue: { en: "Revenue", ar: "الإيرادات" }, expense: { en: "Expenses", ar: "المصروفات" },
  asset: { en: "Assets", ar: "الأصول" }, liability: { en: "Liabilities", ar: "الالتزامات" }, equity: { en: "Equity", ar: "حقوق الملكية" },
  other: { en: "Lines with no account type", ar: "قيود بلا نوع حساب" },
};

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
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t("Trial Balance", "ميزان المراجعة")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t("Opening, period movement and closing balance of every account — debits must equal credits", "الرصيد الافتتاحي وحركة الفترة والرصيد الختامي لكل حساب — المدين يجب أن يساوي الدائن")}</p>
        </div>
        <ReportExportButtons report="trial-balance" params={{ date_from: applied.from, date_to: applied.to }} />
      </div>

      <FiscalRangeNotice source={range.source} />

      <Card className="border-border bg-card">
        <CardContent className="pt-4">
          <div className="flex flex-wrap items-end gap-4">
            <div><Label className="text-xs text-muted-foreground">{t("From", "من")}</Label><Input type="date" value={dateFrom} onChange={e=>setDateFrom(e.target.value)} className="mt-1 h-8 text-sm w-40" data-testid="tb-from" /></div>
            <div><Label className="text-xs text-muted-foreground">{t("To", "إلى")}</Label><Input type="date" value={dateTo} onChange={e=>setDateTo(e.target.value)} className="mt-1 h-8 text-sm w-40" data-testid="tb-to" /></div>
            <Button size="sm" className="h-8" onClick={()=>setApplied({from:dateFrom,to:dateTo})} data-testid="tb-generate">{t("Apply", "تطبيق")}</Button>
            {data && (
              <div className={`flex items-center gap-2 ms-auto px-4 py-2 rounded-lg border ${data.balanced ? "border-positive-surface/30 bg-positive-surface/10" : "border-negative-surface/30 bg-negative-surface/10"}`}>
                {data.balanced ? <CheckCircle className="w-4 h-4 text-positive" /> : <XCircle className="w-4 h-4 text-negative" />}
                <span className={`text-sm font-medium ${data.balanced ? "text-positive" : "text-negative"}`}>{data.balanced ? t("Balanced", "متوازن") : t("Out of Balance", "غير متوازن")}</span>
              </div>
            )}
          </div>
          <div className="mt-3">
            <PeriodShortcuts from={dateFrom} to={dateTo} onSelect={(r)=>{setDateFrom(r.from);setDateTo(r.to);setApplied(r);}} />
          </div>
        </CardContent>
      </Card>

      {isLoading ? <div className="text-muted-foreground text-sm p-4">{t("Loading trial balance...", "جارٍ التحميل...")}</div> : !data ? null : (
        <Card className="border-border bg-card">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm text-muted-foreground uppercase tracking-wide">{t("Trial Balance", "ميزان المراجعة")} — {applied.from} {t("to", "إلى")} {applied.to}</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto"><table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-muted-foreground text-xs uppercase">
                  <th className="text-start pb-3 pe-4 font-medium">{t("Account", "الحساب")}</th>
                  <th className="text-end pb-3 pe-4 font-medium">{t("Opening", "الرصيد الافتتاحي")}</th>
                  <th className="text-end pb-3 pe-4 font-medium">{t("Debit (SAR)", "مدين (ر.س)")}</th>
                  <th className="text-end pb-3 pe-4 font-medium">{t("Credit (SAR)", "دائن (ر.س)")}</th>
                  <th className="text-end pb-3 font-medium">{t("Closing", "الرصيد الختامي")}</th>
                </tr>
              </thead>
              <tbody>
                {typeOrder.filter(tp => byType[tp]?.length > 0).map(type => (
                  <Fragment key={type}>
                    <tr className="bg-secondary/20">
                      <td colSpan={5} className={`py-2 px-2 text-xs font-bold uppercase tracking-widest ${TYPE_STYLES[type] ?? "text-muted-foreground"}`}>{t(TYPE_LABELS[type]?.en ?? type, TYPE_LABELS[type]?.ar ?? type)}</td>
                    </tr>
                    {byType[type].map(row => (
                      <tr key={row.key} className="border-b border-border/30 hover:bg-secondary/10" data-testid={`tb-row-${row.key}`}>
                        <td className="py-2.5 pe-4 ps-2">
                          {/* D14-09: an account row opens the ledger of THAT account for THIS window */}
                          {row.accountId != null ? (
                            <Link href={glDrillHref(row.accountId, applied.from, applied.to)} className="text-foreground hover:text-primary hover:underline" data-testid={`tb-drill-${row.accountId}`}>{n(row.name, row.nameAr)}</Link>
                          ) : (
                            <span className={row.computed ? "text-foreground italic" : "text-foreground"}>{n(row.name, row.nameAr)}</span>
                          )}
                          {row.nameAr && row.nameAr !== "(not yet translated)" && lang === "en" && <span className="text-muted-foreground text-xs ms-2" dir="rtl">{row.nameAr}</span>}
                        </td>
                        <td className="py-2.5 pe-4 text-end font-mono text-sm">{row.openingBalance !== 0 ? fmtNum(row.openingBalance) : <span className="text-muted-foreground">—</span>}</td>
                        <td className="py-2.5 pe-4 text-end font-mono text-sm">{row.debit > 0 ? fmtNum(row.debit) : <span className="text-muted-foreground">—</span>}</td>
                        <td className="py-2.5 pe-4 text-end font-mono text-sm">{row.credit > 0 ? fmtNum(row.credit) : <span className="text-muted-foreground">—</span>}</td>
                        <td className="py-2.5 text-end font-mono text-sm">{row.closingBalance !== 0 ? fmtNum(row.closingBalance) : <span className="text-muted-foreground">—</span>}</td>
                      </tr>
                    ))}
                    <tr className="border-b-2 border-border">
                      <td className="py-2 ps-2 text-xs text-muted-foreground">{t("Subtotal", "المجموع الفرعي")} — {t(TYPE_LABELS[type]?.en ?? type, TYPE_LABELS[type]?.ar ?? type)}</td>
                      <td className="py-2 pe-4 text-end font-mono text-xs font-semibold text-foreground">{fmtNum(byType[type].reduce((s,r)=>s+r.openingBalance,0))}</td>
                      <td className="py-2 pe-4 text-end font-mono text-xs font-semibold text-foreground">{fmtNum(byType[type].reduce((s,r)=>s+r.debit,0))}</td>
                      <td className="py-2 pe-4 text-end font-mono text-xs font-semibold text-foreground">{fmtNum(byType[type].reduce((s,r)=>s+r.credit,0))}</td>
                      <td className="py-2 text-end font-mono text-xs font-semibold text-foreground">{fmtNum(byType[type].reduce((s,r)=>s+r.closingBalance,0))}</td>
                    </tr>
                  </Fragment>
                ))}
              </tbody>
              <tfoot>
                <tr className={`font-bold text-sm ${data.balanced ? "text-positive" : "text-negative"}`}>
                  <td className="py-4 pe-4 ps-2 uppercase tracking-wide">{t("Total", "الإجمالي")}</td>
                  <td className="py-4 pe-4 text-end font-mono text-base" data-testid="tb-total-opening">{fmtNum(data.totalOpening)}</td>
                  <td className="py-4 pe-4 text-end font-mono text-base" data-testid="tb-total-debit">{fmtNum(data.totalDebit)}</td>
                  <td className="py-4 pe-4 text-end font-mono text-base" data-testid="tb-total-credit">{fmtNum(data.totalCredit)}</td>
                  <td className="py-4 text-end font-mono text-base" data-testid="tb-total-closing">{fmtNum(data.totalClosing)}</td>
                </tr>
              </tfoot>
            </table></div>
            <ul className="mt-3 space-y-1 text-xs text-muted-foreground" data-testid="tb-notes">
              <li>{t("Opening and closing balances are debit-positive; a credit balance shows as negative.", "الأرصدة الافتتاحية والختامية موجبة للمدين؛ ويظهر الرصيد الدائن بالسالب.")}</li>
              {data.plResetFrom && <li>{t(`Income and expense accounts open at the fiscal-year start (${data.plResetFrom}); earlier profit or loss is one computed equity row.`, `تبدأ حسابات الإيرادات والمصروفات من بداية السنة المالية (${data.plResetFrom})؛ وأرباح أو خسائر ما قبلها سطر محسوب واحد ضمن حقوق الملكية.`)}</li>}
              {!data.fiscalYearDeclared && <li>{t("The fiscal year is not declared, so income and expense accounts are not reset at a fiscal-year start.", "لم تُحدَّد السنة المالية، لذا لا تُصفَّر حسابات الإيرادات والمصروفات عند بداية سنة مالية.")}</li>}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
