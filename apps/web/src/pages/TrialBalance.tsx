import { useState } from "react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { CheckCircle, XCircle } from "lucide-react";
import { useReportDefaultRange, type ReportDefaultRange } from "@/hooks/useReportDefaultRange";
import { FiscalRangeNotice, ReportRangeLoading } from "@/components/FiscalRangeNotice";

interface TrialBalanceRow { id: number | null; name: string; nameAr: string; type: string; debit: number; credit: number; balance: number; }
interface TrialBalanceData { accounts: TrialBalanceRow[]; totalDebit: number; totalCredit: number; balanced: boolean; }

const TYPE_STYLES: Record<string, string> = { income: "text-emerald-400", expense: "text-red-400", asset: "text-blue-400", liability: "text-amber-400", equity: "text-purple-400" };

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

  const { data, isLoading } = useQuery<TrialBalanceData>({
    queryKey: ["trial-balance", applied.from, applied.to],
    queryFn: () => apiFetch(`/reports/trial-balance?date_from=${applied.from}&date_to=${applied.to}`),
  });

  const byType = data ? data.accounts.reduce((acc, row) => {
    const tp = row.type;
    if (!acc[tp]) acc[tp] = [];
    acc[tp].push(row);
    return acc;
  }, {} as Record<string, TrialBalanceRow[]>) : {};

  const typeOrder = ["income", "expense", "asset", "liability", "equity"];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t("Trial Balance", "ميزان المراجعة")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t("All ledger account balances — debits must equal credits", "جميع أرصدة الحسابات — المدين يجب أن يساوي الدائن")}</p>
        </div>
      </div>

      <FiscalRangeNotice source={range.source} />

      <Card className="border-border bg-card">
        <CardContent className="pt-4">
          <div className="flex items-end gap-4">
            <div><Label className="text-xs text-muted-foreground">{t("From", "من")}</Label><Input type="date" value={dateFrom} onChange={e=>setDateFrom(e.target.value)} className="mt-1 h-8 text-sm w-40" /></div>
            <div><Label className="text-xs text-muted-foreground">{t("To", "إلى")}</Label><Input type="date" value={dateTo} onChange={e=>setDateTo(e.target.value)} className="mt-1 h-8 text-sm w-40" /></div>
            <Button size="sm" className="h-8" onClick={()=>setApplied({from:dateFrom,to:dateTo})}>{t("Apply", "تطبيق")}</Button>
            {data && (
              <div className={`flex items-center gap-2 ml-auto px-4 py-2 rounded-lg border ${data.balanced ? "border-emerald-500/30 bg-emerald-500/10" : "border-red-500/30 bg-red-500/10"}`}>
                {data.balanced ? <CheckCircle className="w-4 h-4 text-emerald-400" /> : <XCircle className="w-4 h-4 text-red-400" />}
                <span className={`text-sm font-medium ${data.balanced ? "text-emerald-400" : "text-red-400"}`}>{data.balanced ? t("Balanced", "متوازن") : t("Out of Balance", "غير متوازن")}</span>
              </div>
            )}
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
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-muted-foreground text-xs uppercase">
                  <th className="text-left pb-3 pr-4 font-medium">{t("Account", "الحساب")}</th>
                  <th className="text-left pb-3 pr-4 font-medium">{t("Type", "النوع")}</th>
                  <th className="text-right pb-3 pr-4 font-medium">{t("Debit (SAR)", "مدين (ر.س)")}</th>
                  <th className="text-right pb-3 font-medium">{t("Credit (SAR)", "دائن (ر.س)")}</th>
                </tr>
              </thead>
              <tbody>
                {typeOrder.filter(tp => byType[tp]?.length > 0).map(type => (
                  <>
                    <tr key={`header-${type}`} className="bg-secondary/20">
                      <td colSpan={4} className={`py-2 px-2 text-xs font-bold uppercase tracking-widest ${TYPE_STYLES[type] ?? "text-muted-foreground"}`}>{type}</td>
                    </tr>
                    {byType[type].map(row => (
                      <tr key={row.id} className="border-b border-border/30 hover:bg-secondary/10">
                        <td className="py-2.5 pr-4 pl-2">
                          <span className="text-foreground">{n(row.name, row.nameAr)}</span>
                          {row.nameAr && row.nameAr !== "(not yet translated)" && lang === "en" && <span className="text-muted-foreground text-xs ml-2" dir="rtl">{row.nameAr}</span>}
                        </td>
                        <td className="py-2.5 pr-4"><Badge variant="outline" className={`text-xs capitalize border-0 px-0 ${TYPE_STYLES[row.type]??""}`}>{row.type}</Badge></td>
                        <td className="py-2.5 pr-4 text-right font-mono text-sm">{row.debit > 0 ? fmtNum(row.debit) : <span className="text-muted-foreground">—</span>}</td>
                        <td className="py-2.5 text-right font-mono text-sm">{row.credit > 0 ? fmtNum(row.credit) : <span className="text-muted-foreground">—</span>}</td>
                      </tr>
                    ))}
                    <tr key={`subtotal-${type}`} className="border-b-2 border-border">
                      <td className="py-2 pl-2 text-xs text-muted-foreground">{t("Subtotal", "المجموع الفرعي")} — {type}</td>
                      <td />
                      <td className="py-2 pr-4 text-right font-mono text-xs font-semibold text-foreground">{fmtNum(byType[type].reduce((s,r)=>s+r.debit,0))}</td>
                      <td className="py-2 text-right font-mono text-xs font-semibold text-foreground">{fmtNum(byType[type].reduce((s,r)=>s+r.credit,0))}</td>
                    </tr>
                  </>
                ))}
              </tbody>
              <tfoot>
                <tr className={`font-bold text-sm ${data.balanced ? "text-emerald-400" : "text-red-400"}`}>
                  <td className="py-4 pr-4 pl-2 uppercase tracking-wide">{t("Total", "الإجمالي")}</td>
                  <td />
                  <td className="py-4 pr-4 text-right font-mono text-base">{fmtNum(data.totalDebit)}</td>
                  <td className="py-4 text-right font-mono text-base">{fmtNum(data.totalCredit)}</td>
                </tr>
              </tfoot>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
