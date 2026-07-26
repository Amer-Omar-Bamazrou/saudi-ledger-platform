import { useState } from "react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TrendingUp, TrendingDown } from "lucide-react";

interface ISData {
  revenue: { name: string; nameAr?: string; amount: number }[];
  expenses: { name: string; nameAr?: string; amount: number }[];
  totalRevenue: number;
  totalExpenses: number;
  grossProfit: number;
  netIncome: number;
  netIncomeMargin: number;
}

export default function IncomeStatement() {
  const { n, t } = useLanguage();
  const thisYear = new Date().getFullYear();
  const [dateFrom, setDateFrom] = useState(`${thisYear}-01-01`);
  const [dateTo, setDateTo] = useState(`${thisYear}-12-31`);
  const [applied, setApplied] = useState({ from: `${thisYear}-01-01`, to: `${thisYear}-12-31` });

  const { data, isLoading } = useQuery<ISData>({
    queryKey: ["income-statement", applied.from, applied.to],
    queryFn: () => apiFetch(`/reports/income-statement?date_from=${applied.from}&date_to=${applied.to}`),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t("Income Statement", "قائمة الدخل")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t("Profit & Loss — Revenue, Expenses, Net Income", "الربح والخسارة — الإيرادات والمصروفات وصافي الدخل")}</p>
        </div>
      </div>

      <Card className="border-border bg-card">
        <CardContent className="pt-4">
          <div className="flex items-end gap-4">
            <div><Label className="text-xs text-muted-foreground">{t("From", "من")}</Label><Input type="date" value={dateFrom} onChange={e=>setDateFrom(e.target.value)} className="mt-1 h-8 text-sm w-40" /></div>
            <div><Label className="text-xs text-muted-foreground">{t("To", "إلى")}</Label><Input type="date" value={dateTo} onChange={e=>setDateTo(e.target.value)} className="mt-1 h-8 text-sm w-40" /></div>
            <Button size="sm" className="h-8" onClick={()=>setApplied({from:dateFrom,to:dateTo})}>{t("Generate", "إنشاء")}</Button>
          </div>
        </CardContent>
      </Card>

      {data && (
        <div className="grid grid-cols-4 gap-4">
          {[
            [t("Total Revenue", "إجمالي الإيرادات"), fmtNum(data.totalRevenue), "text-emerald-400"],
            [t("Total Expenses", "إجمالي المصروفات"), fmtNum(data.totalExpenses), "text-red-400"],
            [t("Net Income", "صافي الدخل"), fmtNum(data.netIncome), data.netIncome >= 0 ? "text-primary" : "text-red-400"],
            [t("Net Margin", "هامش الربح الصافي"), `${data.netIncomeMargin.toFixed(1)}%`, data.netIncomeMargin >= 0 ? "text-emerald-400" : "text-red-400"],
          ].map(([l, v, c]) => (
            <Card key={String(l)} className="border-border bg-card">
              <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{l}</CardTitle></CardHeader>
              <CardContent><div className={`text-xl font-bold font-mono ${c}`}>{v}</div></CardContent>
            </Card>
          ))}
        </div>
      )}

      {isLoading ? <div className="text-muted-foreground text-sm p-4">{t("Loading...", "جارٍ التحميل...")}</div> : !data ? null : (
        <div className="grid grid-cols-2 gap-4">
          {/* Revenue */}
          <Card className="border-border bg-card">
            <CardHeader className="pb-2">
              <div className="flex items-center gap-2">
                <TrendingUp className="w-4 h-4 text-emerald-400" />
                <CardTitle className="text-sm font-semibold text-emerald-400">{t("Revenue", "الإيرادات")}</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <table className="w-full text-sm">
                <thead><tr className="border-b border-border text-xs text-muted-foreground uppercase"><th className="text-left pb-2">{t("Account", "الحساب")}</th><th className="text-right pb-2">{t("Amount", "المبلغ")}</th></tr></thead>
                <tbody>
                  {data.revenue.map((r, i) => (
                    <tr key={i} className="border-b border-border/30 hover:bg-secondary/10">
                      <td className="py-2.5 text-foreground">{n(r.name, r.nameAr)}</td>
                      <td className="py-2.5 text-right font-mono text-emerald-400">{fmtNum(r.amount)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-emerald-500/30 font-bold text-emerald-400">
                    <td className="py-3 uppercase text-xs tracking-wide">{t("Total Revenue", "إجمالي الإيرادات")}</td>
                    <td className="py-3 text-right font-mono text-base">{fmtNum(data.totalRevenue)}</td>
                  </tr>
                </tfoot>
              </table>
            </CardContent>
          </Card>

          {/* Expenses */}
          <Card className="border-border bg-card">
            <CardHeader className="pb-2">
              <div className="flex items-center gap-2">
                <TrendingDown className="w-4 h-4 text-red-400" />
                <CardTitle className="text-sm font-semibold text-red-400">{t("Expenses", "المصروفات")}</CardTitle>
              </div>
            </CardHeader>
            <CardContent>
              <table className="w-full text-sm">
                <thead><tr className="border-b border-border text-xs text-muted-foreground uppercase"><th className="text-left pb-2">{t("Account", "الحساب")}</th><th className="text-right pb-2">{t("Amount", "المبلغ")}</th></tr></thead>
                <tbody>
                  {data.expenses.map((e, i) => (
                    <tr key={i} className="border-b border-border/30 hover:bg-secondary/10">
                      <td className="py-2.5 text-foreground">{n(e.name, e.nameAr)}</td>
                      <td className="py-2.5 text-right font-mono text-red-400">{fmtNum(e.amount)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-red-500/30 font-bold text-red-400">
                    <td className="py-3 uppercase text-xs tracking-wide">{t("Total Expenses", "إجمالي المصروفات")}</td>
                    <td className="py-3 text-right font-mono text-base">{fmtNum(data.totalExpenses)}</td>
                  </tr>
                </tfoot>
              </table>
            </CardContent>
          </Card>

          {/* Net Income summary */}
          <Card className="col-span-2 border-border bg-card">
            <CardContent className="pt-4">
              <div className="flex items-center justify-between py-3 border-b border-border">
                <span className="text-muted-foreground text-sm">{t("Total Revenue", "إجمالي الإيرادات")}</span>
                <span className="font-mono font-semibold text-emerald-400">{fmtNum(data.totalRevenue)}</span>
              </div>
              <div className="flex items-center justify-between py-3 border-b border-border">
                <span className="text-muted-foreground text-sm">{t("Total Expenses", "إجمالي المصروفات")}</span>
                <span className="font-mono font-semibold text-red-400">({fmtNum(data.totalExpenses)})</span>
              </div>
              <div className={`flex items-center justify-between py-4 rounded-lg px-3 mt-2 ${data.netIncome >= 0 ? "bg-emerald-500/10 border border-emerald-500/20" : "bg-red-500/10 border border-red-500/20"}`}>
                <span className={`font-bold uppercase tracking-wide ${data.netIncome >= 0 ? "text-emerald-400" : "text-red-400"}`}>{data.netIncome >= 0 ? t("Net Income", "صافي الدخل") : t("Net Loss", "صافي الخسارة")}</span>
                <span className={`font-mono font-bold text-xl ${data.netIncome >= 0 ? "text-emerald-400" : "text-red-400"}`}>{fmtNum(Math.abs(data.netIncome))}</span>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
