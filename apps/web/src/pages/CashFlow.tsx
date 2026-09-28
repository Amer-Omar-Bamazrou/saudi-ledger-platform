import { useState } from "react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { PageHeader, StatStrip, Stat, Panel } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useFiscalYearsQuery, useReportDefaultRange, type ReportDefaultRange } from "@/hooks/useReportDefaultRange";
import { FiscalRangeNotice, ReportRangeLoading } from "@/components/FiscalRangeNotice";
import { PeriodShortcuts } from "@/components/PeriodShortcuts";
import { CompareSelect, ComparisonUnavailable, priorRangeLabel, type CompareSetting } from "@/components/Comparison";
import { derivePriorRange, fmtPctChange } from "@/lib/priorPeriod";
import { fmtDate } from "@/lib/api";

import type { CashFlowReport, CashFlowSection } from "@workspace/api-client-react";

/**
 * F7-cmp — cash flow compares at the SECTION level (operating / investing /
 * financing / internal / net change), which is the statement's real grain:
 * its item lists are per-transaction, not per-account, so a line merge would
 * compare individual bank movements against each other — not a question
 * anyone is asking.
 */
function CFBlock({ title, data, prior }: { title: string; data: CashFlowSection; prior?: number }) {
  const { t } = useLanguage();
  return (
    <tbody>
      <tr>
        <td colSpan={2} className="px-3 pt-6 pb-2 text-[13px] font-semibold text-foreground">{title}</td>
      </tr>
      {data.items.length === 0 ? (
        <tr><td colSpan={2} className="py-2 px-3 text-muted-foreground"><span className="block ps-4">{t("No items", "لا توجد بنود")}</span></td></tr>
      ) : data.items.slice(0, 10).map((item, i) => (
        <tr key={i} className="hover:bg-muted/40 transition-colors">
          <td className="py-2 px-3 text-foreground"><span className="block ps-4">{item.name}</span></td>
          <td className={`py-2 px-3 text-end whitespace-nowrap tabular-nums ${item.amount >= 0 ? "text-positive" : "text-negative"}`}>{item.amount >= 0 ? "+" : ""}{fmtNum(item.amount)}</td>
        </tr>
      ))}
      {data.items.length > 10 && <tr><td colSpan={2} className="py-1.5 px-3 text-muted-foreground text-xs"><span className="block ps-4">+{data.items.length - 10} {t("more items", "بنود إضافية")}</span></td></tr>}
      <tr className="border-t border-border font-semibold">
        <td className="py-2.5 px-3">{t("Total", "الإجمالي")} — {title}</td>
        <td className="py-2.5 px-3 text-end whitespace-nowrap tabular-nums">{fmtNum(data.total)}</td>
      </tr>
      {prior !== undefined && (
        <tr>
          <td colSpan={2} className="pb-2 px-3 text-end text-xs text-muted-foreground tabular-nums">
            {t("prior", "السابق")} {fmtNum(prior)} · Δ {data.total - prior >= 0 ? "+" : ""}{fmtNum(data.total - prior)} · {fmtPctChange(data.total, prior)}
          </td>
        </tr>
      )}
    </tbody>
  );
}

export default function CashFlow() {
  // M20.1 — the report does not mount until its default window is known, so a
  // wrong window (the old hardcoded Jan–Dec) is never queried or rendered,
  // even for a frame.
  const range = useReportDefaultRange();
  if (!range.ready) return <ReportRangeLoading />;
  return <CashFlowInner range={range} />;
}

function CashFlowInner({ range }: { range: ReportDefaultRange }) {
  const { t, lang } = useLanguage();
  const [dateFrom, setDateFrom] = useState(range.from);
  const [dateTo, setDateTo] = useState(range.to);
  const [applied, setApplied] = useState({ from: range.from, to: range.to });
  const [compare, setCompare] = useState<CompareSetting>("off");

  const { data: fiscalYears } = useFiscalYearsQuery();
  const periods = fiscalYears?.periods ?? [];

  const { data, isLoading } = useQuery<CashFlowReport>({
    queryKey: ["cash-flow", applied.from, applied.to],
    queryFn: () => apiFetch(`/reports/cash-flow?date_from=${applied.from}&date_to=${applied.to}`),
  });

  const prior = compare !== "off" ? derivePriorRange(applied.from, applied.to, periods, compare) : null;
  const { data: priorData } = useQuery<CashFlowReport>({
    queryKey: ["cash-flow", prior?.from, prior?.to],
    queryFn: () => apiFetch(`/reports/cash-flow?date_from=${prior!.from}&date_to=${prior!.to}`),
    enabled: !!prior,
  });

  const priorEmpty =
    !!priorData &&
    priorData.operating.items.length === 0 &&
    priorData.investing.items.length === 0 &&
    priorData.financing.items.length === 0 &&
    (priorData.internal?.items.length ?? 0) === 0;
  const comparing = !!prior && !!priorData && !priorEmpty;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader
        title={t("Cash Flow Statement", "قائمة التدفق النقدي")}
        description={t("Operating · Investing · Financing activities", "الأنشطة التشغيلية · الاستثمارية · التمويلية")}
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
      {comparing && prior && <p className="text-xs text-muted-foreground">{priorRangeLabel(prior, lang)}</p>}
      {prior && priorEmpty && (
        <ComparisonUnavailable reason={`${t("No recorded activity between", "لا يوجد نشاط مسجل بين")} ${fmtDate(prior.from)} ${t("and", "و")} ${fmtDate(prior.to)} — ${t("nothing to compare against.", "لا يوجد ما يُقارن به.")}`} />
      )}

      {data && (
        <StatStrip cols={4}>
          <Stat
            label={t("Net Change in Cash", "صافي التغير في النقدية")}
            value={<>{data.netChange >= 0 ? "+" : ""}{fmtNum(data.netChange)}</>}
            tone={data.netChange >= 0 ? "positive" : "negative"}
            hint={comparing && priorData ? <span className="tabular-nums">{t("prior net", "الصافي السابق")} {fmtNum(priorData.netChange)} · Δ {data.netChange - priorData.netChange >= 0 ? "+" : ""}{fmtNum(data.netChange - priorData.netChange)}</span> : undefined}
          />
          <Stat label={t("Operating", "التشغيلية")} value={fmtNum(data.operating.total)} tone={data.operating.total > 0 ? "positive" : data.operating.total < 0 ? "negative" : "default"} />
          <Stat label={t("Investing", "الاستثمارية")} value={fmtNum(data.investing.total)} tone={data.investing.total > 0 ? "positive" : data.investing.total < 0 ? "negative" : "default"} />
          <Stat label={t("Financing", "التمويلية")} value={fmtNum(data.financing.total)} tone={data.financing.total > 0 ? "positive" : data.financing.total < 0 ? "negative" : "default"} />
        </StatStrip>
      )}

      {isLoading ? <div className="text-muted-foreground text-sm p-4">{t("Loading...", "جارٍ التحميل...")}</div> : !data ? null : (
        <Panel flush title={t("Cash Flow Statement", "قائمة التدفق النقدي")} description={`${fmtDate(applied.from)} – ${fmtDate(applied.to)}`}>
          <div className="overflow-x-auto"><table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="text-start px-3">{t("Item", "البند")}</th>
                <th className="text-end px-3">{t("Amount", "المبلغ")}</th>
              </tr>
            </thead>
            <CFBlock title={t("Operating Activities", "الأنشطة التشغيلية")} data={data.operating} prior={comparing ? priorData!.operating.total : undefined} />
            <CFBlock title={t("Investing Activities", "الأنشطة الاستثمارية")} data={data.investing} prior={comparing ? priorData!.investing.total : undefined} />
            <CFBlock title={t("Financing Activities", "الأنشطة التمويلية")} data={data.financing} prior={comparing ? priorData!.financing.total : undefined} />
            {/* Transfers between own accounts + invoice/bill settlements: the
                bank moved, no P&L activity occurred. Previously these were
                mis-bucketed under Operating as "Uncategorized". */}
            {data.internal && data.internal.items.length > 0 && (
              <CFBlock title={t("Internal Movements", "التحويلات الداخلية")} data={data.internal} prior={comparing ? priorData!.internal?.total ?? 0 : undefined} />
            )}
            <tfoot>
              <tr className={`font-semibold ${data.netChange >= 0 ? "text-positive" : "text-negative"}`}>
                <td className="py-3.5 px-3">{t("Net Change in Cash", "صافي التغير في النقدية")}</td>
                <td className="py-3.5 px-3 text-end whitespace-nowrap tabular-nums text-base">{data.netChange >= 0 ? "+" : ""}{fmtNum(data.netChange)}</td>
              </tr>
            </tfoot>
          </table></div>
        </Panel>
      )}
    </div>
  );
}
