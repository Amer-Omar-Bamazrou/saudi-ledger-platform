import { useState } from "react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader, StatStrip, Stat, Panel } from "@/components/kit";
import { useFiscalYearsQuery, useReportDefaultRange, type ReportDefaultRange } from "@/hooks/useReportDefaultRange";
import { FiscalRangeNotice, ReportRangeLoading } from "@/components/FiscalRangeNotice";
import { PeriodShortcuts } from "@/components/PeriodShortcuts";
import { CompareSelect, ComparisonUnavailable, priorRangeLabel, type CompareSetting } from "@/components/Comparison";
import { derivePriorRange, fmtPctChange } from "@/lib/priorPeriod";
import { fmtDate } from "@/lib/api";

import type { IncomeStatementReport, ReportKeyedAmount } from "@workspace/api-client-react";

/** Current-order rows first, then prior-only rows — merged by KEY, never by display name. */
function mergeRows(current: ReportKeyedAmount[], prior: ReportKeyedAmount[]): { row: ReportKeyedAmount; priorAmount: number | null }[] {
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

  const { data, isLoading } = useQuery<IncomeStatementReport>({
    queryKey: ["income-statement", applied.from, applied.to],
    queryFn: () => apiFetch(`/reports/income-statement?date_from=${applied.from}&date_to=${applied.to}`),
  });

  // F7-cmp — the prior window is DERIVED from what the applied dates are
  // (fiscal → the resolver's preceding period; calendar month/quarter/year →
  // exact shift; anything else → calendar-year shift, labelled).
  const prior = compare !== "off" ? derivePriorRange(applied.from, applied.to, periods, compare) : null;
  const { data: priorData } = useQuery<IncomeStatementReport>({
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

  // One statement, one column: each section is a <tbody> — a heading row, its
  // account lines, and a subtotal under a single rule. The net line closes the
  // statement under a double rule, the printed ledger's convention.
  const cols = comparing ? 5 : 2;
  const section = (
    title: string,
    titleAr: string,
    rows: ReportKeyedAmount[],
    priorRows: ReportKeyedAmount[] | undefined,
    total: number,
    priorTotal: number | undefined,
    totalLabel: string,
    totalLabelAr: string,
  ) => {
    const merged = comparing && priorRows ? mergeRows(rows, priorRows) : rows.map((row) => ({ row, priorAmount: null }));
    return (
      <tbody>
        <tr>
          <td colSpan={cols} className="px-3 pt-6 pb-2 text-[13px] font-semibold text-foreground">{t(title, titleAr)}</td>
        </tr>
        {merged.map(({ row, priorAmount }) => (
          <tr key={row.key} className="hover:bg-muted/40 transition-colors">
            <td className="py-2 px-3 text-foreground"><span className="ps-4 block">{n(row.name, row.nameAr)}</span></td>
            <td className="py-2 px-3 text-end whitespace-nowrap tabular-nums">{fmtNum(row.amount)}</td>
            {comparing && <td className="py-2 px-3 text-end whitespace-nowrap tabular-nums text-muted-foreground">{fmtNum(priorAmount ?? 0)}</td>}
            {comparing && (
              <td className="py-2 px-3 text-end whitespace-nowrap tabular-nums text-muted-foreground">
                {row.amount - (priorAmount ?? 0) >= 0 ? "+" : ""}{fmtNum(row.amount - (priorAmount ?? 0))}
              </td>
            )}
            {comparing && <td className="py-2 px-3 text-end whitespace-nowrap tabular-nums text-muted-foreground">{fmtPctChange(row.amount, priorAmount ?? 0)}</td>}
          </tr>
        ))}
        <tr className="border-t border-border font-semibold">
          <td className="py-2.5 px-3">{t(totalLabel, totalLabelAr)}</td>
          <td className="py-2.5 px-3 text-end whitespace-nowrap tabular-nums">{fmtNum(total)}</td>
          {comparing && <td className="py-2.5 px-3 text-end whitespace-nowrap tabular-nums text-muted-foreground">{fmtNum(priorTotal ?? 0)}</td>}
          {comparing && (
            <td className="py-2.5 px-3 text-end whitespace-nowrap tabular-nums text-muted-foreground">
              {total - (priorTotal ?? 0) >= 0 ? "+" : ""}{fmtNum(total - (priorTotal ?? 0))}
            </td>
          )}
          {comparing && <td className="py-2.5 px-3 text-end whitespace-nowrap tabular-nums text-muted-foreground">{fmtPctChange(total, priorTotal ?? 0)}</td>}
        </tr>
      </tbody>
    );
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader
        title={t("Income Statement", "قائمة الدخل")}
        description={t("Profit & Loss — Revenue, Expenses, Net Income", "الربح والخسارة — الإيرادات والمصروفات وصافي الدخل")}
      >
        <div className="mt-2"><FiscalRangeNotice source={range.source} /></div>
      </PageHeader>

      <Panel>
        <div className="flex flex-wrap items-end gap-3">
          <div><Label className="text-xs text-muted-foreground">{t("From", "من")}</Label><Input type="date" value={dateFrom} onChange={e=>setDateFrom(e.target.value)} className="mt-1 h-8 text-sm w-40" /></div>
          <div><Label className="text-xs text-muted-foreground">{t("To", "إلى")}</Label><Input type="date" value={dateTo} onChange={e=>setDateTo(e.target.value)} className="mt-1 h-8 text-sm w-40" /></div>
          <Button size="sm" className="h-8" onClick={()=>setApplied({from:dateFrom,to:dateTo})}>{t("Generate", "إنشاء")}</Button>
          <CompareSelect value={compare} onChange={setCompare} />
        </div>
        <div className="mt-3">
          <PeriodShortcuts from={dateFrom} to={dateTo} onSelect={(r)=>{setDateFrom(r.from);setDateTo(r.to);setApplied(r);}} />
        </div>
      </Panel>

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
        <StatStrip cols={4}>
          <Stat label={t("Total Revenue", "إجمالي الإيرادات")} value={fmtNum(data.totalRevenue)} tone="positive" />
          <Stat label={t("Total Expenses", "إجمالي المصروفات")} value={fmtNum(data.totalExpenses)} tone="negative" />
          <Stat label={t("Net Income", "صافي الدخل")} value={fmtNum(data.netIncome)} tone={data.netIncome >= 0 ? "primary" : "negative"} />
          {/* A margin is a ratio, not a state — neutral, per CLAUDE.md §4. */}
          <Stat label={t("Net Margin", "هامش الربح الصافي")} value={`${data.netIncomeMargin.toFixed(1)}%`} />
        </StatStrip>
      )}

      {isLoading ? <div className="text-muted-foreground text-sm p-4">{t("Loading...", "جارٍ التحميل...")}</div> : !data ? null : (
        <Panel
          flush
          title={t("Income Statement", "قائمة الدخل")}
          description={`${fmtDate(applied.from)} – ${fmtDate(applied.to)}`}
        >
          <div className="overflow-x-auto"><table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="text-start px-3">{t("Account", "الحساب")}</th>
                <th className="text-end px-3">{t("Amount", "المبلغ")}</th>
                {comparing && <th className="text-end px-3">{t("Prior", "السابق")}</th>}
                {comparing && <th className="text-end px-3">Δ</th>}
                {comparing && <th className="text-end px-3">Δ%</th>}
              </tr>
            </thead>
            {section("Revenue", "الإيرادات", data.revenue, priorData?.revenue, data.totalRevenue, priorData?.totalRevenue, "Total Revenue", "إجمالي الإيرادات")}
            {section("Expenses", "المصروفات", data.expenses, priorData?.expenses, data.totalExpenses, priorData?.totalExpenses, "Total Expenses", "إجمالي المصروفات")}

            {/* Net income summary */}
            <tbody>
              <tr><td colSpan={cols} className="pt-6" /></tr>
              <tr>
                <td className="py-2 px-3 text-muted-foreground">{t("Total Revenue", "إجمالي الإيرادات")}</td>
                <td className="py-2 px-3 text-end whitespace-nowrap tabular-nums">{fmtNum(data.totalRevenue)}</td>
                {comparing && <td colSpan={3} />}
              </tr>
              <tr>
                <td className="py-2 px-3 text-muted-foreground">{t("Total Expenses", "إجمالي المصروفات")}</td>
                <td className="py-2 px-3 text-end whitespace-nowrap tabular-nums">({fmtNum(data.totalExpenses)})</td>
                {comparing && <td colSpan={3} />}
              </tr>
            </tbody>
            <tfoot>
              <tr className={`font-semibold ${data.netIncome >= 0 ? "text-positive" : "text-negative"}`}>
                <td className="py-3.5 px-3">{data.netIncome >= 0 ? t("Net Income", "صافي الدخل") : t("Net Loss", "صافي الخسارة")}</td>
                <td className="py-3.5 px-3 text-end whitespace-nowrap tabular-nums text-base">{fmtNum(Math.abs(data.netIncome))}</td>
                {comparing && priorData && (
                  <>
                    <td className="py-3.5 px-3 text-end whitespace-nowrap tabular-nums font-normal text-muted-foreground" title={t("Prior net income", "صافي الدخل السابق")}>{fmtNum(priorData.netIncome)}</td>
                    <td className="py-3.5 px-3 text-end whitespace-nowrap tabular-nums font-normal text-muted-foreground">{data.netIncome - priorData.netIncome >= 0 ? "+" : ""}{fmtNum(data.netIncome - priorData.netIncome)}</td>
                    <td className="py-3.5 px-3 text-end whitespace-nowrap tabular-nums font-normal text-muted-foreground">{fmtPctChange(data.netIncome, priorData.netIncome)}</td>
                  </>
                )}
              </tr>
            </tfoot>
          </table></div>
        </Panel>
      )}
    </div>
  );
}
