import { useState } from "react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TrendingUp, TrendingDown } from "lucide-react";
import { useFiscalYearsQuery, useReportDefaultRange, type ReportDefaultRange } from "@/hooks/useReportDefaultRange";
import { FiscalRangeNotice, ReportRangeLoading } from "@/components/FiscalRangeNotice";
import { PeriodShortcuts } from "@/components/PeriodShortcuts";
import { CompareSelect, ComparisonUnavailable, priorRangeLabel, type CompareSetting } from "@/components/Comparison";
import { derivePriorRange, fmtPctChange } from "@/lib/priorPeriod";
import { fmtDate } from "@/lib/api";

interface ISRow { key: string; name: string; nameAr?: string; amount: number }
interface ISData {
  revenue: ISRow[];
  expenses: ISRow[];
  totalRevenue: number;
  totalExpenses: number;
  grossProfit: number;
  netIncome: number;
  netIncomeMargin: number;
  /** journal_entries | transactions — see the source-mismatch rule below. */
  source: string;
}

/** Current-order rows first, then prior-only rows — merged by KEY, never by display name. */
function mergeRows(current: ISRow[], prior: ISRow[]): { row: ISRow; priorAmount: number | null }[] {
  const priorByKey = new Map(prior.map((r) => [r.key, r]));
  const out = current.map((row) => ({ row, priorAmount: priorByKey.get(row.key)?.amount ?? 0 }));
  const currentKeys = new Set(current.map((r) => r.key));
  for (const p of prior) {
    if (!currentKeys.has(p.key)) out.push({ row: { ...p, amount: 0 }, priorAmount: p.amount });
  }
  return out;
}

export default function IncomeStatement() {
  // M20.1 — the report does not mount until its default window is known, so a
  // wrong window (the old hardcoded Jan–Dec) is never queried or rendered,
  // even for a frame.
  const range = useReportDefaultRange();
  if (!range.ready) return <ReportRangeLoading />;
  return <IncomeStatementInner range={range} />;
}

function IncomeStatementInner({ range }: { range: ReportDefaultRange }) {
  const { n, t, lang } = useLanguage();
  const [dateFrom, setDateFrom] = useState(range.from);
  const [dateTo, setDateTo] = useState(range.to);
  const [applied, setApplied] = useState({ from: range.from, to: range.to });
  const [compare, setCompare] = useState<CompareSetting>("off");

  const { data: fiscalYears } = useFiscalYearsQuery();
  const periods = fiscalYears?.periods ?? [];

  const { data, isLoading } = useQuery<ISData>({
    queryKey: ["income-statement", applied.from, applied.to],
    queryFn: () => apiFetch(`/reports/income-statement?date_from=${applied.from}&date_to=${applied.to}`),
  });

  // F7-cmp — the prior window is DERIVED from what the applied dates are
  // (fiscal → the resolver's preceding period; calendar month/quarter/year →
  // exact shift; anything else → calendar-year shift, labelled).
  const prior = compare !== "off" ? derivePriorRange(applied.from, applied.to, periods, compare) : null;
  const { data: priorData } = useQuery<ISData>({
    queryKey: ["income-statement", prior?.from, prior?.to],
    queryFn: () => apiFetch(`/reports/income-statement?date_from=${prior!.from}&date_to=${prior!.to}`),
    enabled: !!prior,
  });

  const priorEmpty = !!priorData && priorData.revenue.length === 0 && priorData.expenses.length === 0;
  // 🔴 The finding-#9 rule, applied before it can grow a fourth costume: the
  // income statement falls back to transaction-derived figures when a window
  // has no journal lines, so the two windows can answer from DIFFERENT
  // sources — gross-incl-VAT beside net-of-VAT in one table, invisibly. If
  // the sources differ, the comparison refuses and says so.
  const sourceMismatch = !!data && !!priorData && !priorEmpty && data.source !== priorData.source;
  const comparing = !!prior && !!priorData && !priorEmpty && !sourceMismatch;

  const section = (
    title: string,
    titleAr: string,
    rows: ISRow[],
    priorRows: ISRow[] | undefined,
    total: number,
    priorTotal: number | undefined,
    color: string,
    border: string,
    icon: React.ReactNode,
    totalLabel: string,
    totalLabelAr: string,
  ) => {
    const merged = comparing && priorRows ? mergeRows(rows, priorRows) : rows.map((row) => ({ row, priorAmount: null }));
    return (
      <Card className="border-border bg-card">
        <CardHeader className="pb-2">
          <div className="flex items-center gap-2">
            {icon}
            <CardTitle className={`text-sm font-semibold ${color}`}>{t(title, titleAr)}</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-xs text-muted-foreground uppercase">
                <th className="text-start pb-2">{t("Account", "الحساب")}</th>
                <th className="text-end pb-2">{t("Amount", "المبلغ")}</th>
                {comparing && <th className="text-end pb-2">{t("Prior", "السابق")}</th>}
                {comparing && <th className="text-end pb-2">Δ</th>}
                {comparing && <th className="text-end pb-2">Δ%</th>}
              </tr>
            </thead>
            <tbody>
              {merged.map(({ row, priorAmount }) => (
                <tr key={row.key} className="border-b border-border/30 hover:bg-secondary/10">
                  <td className="py-2.5 text-foreground">{n(row.name, row.nameAr)}</td>
                  <td className={`py-2.5 text-end font-mono ${color}`}>{fmtNum(row.amount)}</td>
                  {comparing && <td className="py-2.5 text-end font-mono text-muted-foreground">{fmtNum(priorAmount ?? 0)}</td>}
                  {comparing && (
                    <td className="py-2.5 text-end font-mono text-muted-foreground">
                      {row.amount - (priorAmount ?? 0) >= 0 ? "+" : ""}{fmtNum(row.amount - (priorAmount ?? 0))}
                    </td>
                  )}
                  {comparing && <td className="py-2.5 text-end font-mono text-muted-foreground">{fmtPctChange(row.amount, priorAmount ?? 0)}</td>}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className={`border-t-2 ${border} font-bold ${color}`}>
                <td className="py-3 uppercase text-xs tracking-wide">{t(totalLabel, totalLabelAr)}</td>
                <td className="py-3 text-end font-mono text-base">{fmtNum(total)}</td>
                {comparing && <td className="py-3 text-end font-mono text-muted-foreground">{fmtNum(priorTotal ?? 0)}</td>}
                {comparing && (
                  <td className="py-3 text-end font-mono text-muted-foreground">
                    {total - (priorTotal ?? 0) >= 0 ? "+" : ""}{fmtNum(total - (priorTotal ?? 0))}
                  </td>
                )}
                {comparing && <td className="py-3 text-end font-mono text-muted-foreground">{fmtPctChange(total, priorTotal ?? 0)}</td>}
              </tr>
            </tfoot>
          </table>
        </CardContent>
      </Card>
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t("Income Statement", "قائمة الدخل")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t("Profit & Loss — Revenue, Expenses, Net Income", "الربح والخسارة — الإيرادات والمصروفات وصافي الدخل")}</p>
        </div>
      </div>

      <FiscalRangeNotice source={range.source} />

      <Card className="border-border bg-card">
        <CardContent className="pt-4">
          <div className="flex items-end gap-4">
            <div><Label className="text-xs text-muted-foreground">{t("From", "من")}</Label><Input type="date" value={dateFrom} onChange={e=>setDateFrom(e.target.value)} className="mt-1 h-8 text-sm w-40" /></div>
            <div><Label className="text-xs text-muted-foreground">{t("To", "إلى")}</Label><Input type="date" value={dateTo} onChange={e=>setDateTo(e.target.value)} className="mt-1 h-8 text-sm w-40" /></div>
            <Button size="sm" className="h-8" onClick={()=>setApplied({from:dateFrom,to:dateTo})}>{t("Generate", "إنشاء")}</Button>
            <CompareSelect value={compare} onChange={setCompare} />
          </div>
          <div className="mt-3">
            <PeriodShortcuts from={dateFrom} to={dateTo} onSelect={(r)=>{setDateFrom(r.from);setDateTo(r.to);setApplied(r);}} />
          </div>
        </CardContent>
      </Card>

      {compare !== "off" && !prior && (
        <ComparisonUnavailable reason={t(
          "No earlier fiscal year is known to compare against.",
          "لا توجد سنة مالية سابقة معروفة للمقارنة.",
        )} />
      )}
      {comparing && prior && (
        <p className="text-xs text-muted-foreground">{priorRangeLabel(prior, lang)}</p>
      )}
      {prior && priorEmpty && (
        <ComparisonUnavailable reason={`${t("No recorded activity between", "لا يوجد نشاط مسجل بين")} ${fmtDate(prior.from)} ${t("and", "و")} ${fmtDate(prior.to)} — ${t("nothing to compare against.", "لا يوجد ما يُقارن به.")}`} />
      )}
      {sourceMismatch && (
        <ComparisonUnavailable reason={t(
          "The two periods answered from different sources (posted journal entries vs bank transactions), so their figures are not comparable in one table.",
          "الفترتان مستمدتان من مصدرين مختلفين (قيود اليومية المرحّلة مقابل الحركات البنكية)، لذا لا يمكن مقارنة أرقامهما في جدول واحد.",
        )} />
      )}

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
          {section("Revenue", "الإيرادات", data.revenue, priorData?.revenue, data.totalRevenue, priorData?.totalRevenue, "text-emerald-400", "border-emerald-500/30", <TrendingUp className="w-4 h-4 text-emerald-400" />, "Total Revenue", "إجمالي الإيرادات")}
          {section("Expenses", "المصروفات", data.expenses, priorData?.expenses, data.totalExpenses, priorData?.totalExpenses, "text-red-400", "border-red-500/30", <TrendingDown className="w-4 h-4 text-red-400" />, "Total Expenses", "إجمالي المصروفات")}

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
              {comparing && priorData && (
                <div className="flex items-center justify-between py-2 px-3 text-xs text-muted-foreground">
                  <span>{t("Prior net income", "صافي الدخل السابق")}</span>
                  <span className="font-mono">
                    {fmtNum(priorData.netIncome)} · Δ {data.netIncome - priorData.netIncome >= 0 ? "+" : ""}{fmtNum(data.netIncome - priorData.netIncome)} · {fmtPctChange(data.netIncome, priorData.netIncome)}
                  </span>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
