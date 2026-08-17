import { useState } from "react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ArrowUpRight, ArrowDownRight, Minus } from "lucide-react";
import { useFiscalYearsQuery, useReportDefaultRange, type ReportDefaultRange } from "@/hooks/useReportDefaultRange";
import { FiscalRangeNotice, ReportRangeLoading } from "@/components/FiscalRangeNotice";
import { PeriodShortcuts } from "@/components/PeriodShortcuts";
import { CompareSelect, ComparisonUnavailable, priorRangeLabel, type CompareSetting } from "@/components/Comparison";
import { derivePriorRange, fmtPctChange } from "@/lib/priorPeriod";
import { fmtDate } from "@/lib/api";

interface CFSection { total: number; items: { name: string; amount: number }[]; }
interface CFData { operating: CFSection; investing: CFSection; financing: CFSection; internal?: CFSection; netChange: number; }

/**
 * F7-cmp — cash flow compares at the SECTION level (operating / investing /
 * financing / internal / net change), which is the statement's real grain:
 * its item lists are per-transaction, not per-account, so a line merge would
 * compare individual bank movements against each other — not a question
 * anyone is asking.
 */
function CFBlock({ title, data, color, icon, prior }: { title: string; data: CFSection; color: string; icon: React.ReactNode; prior?: number }) {
  const { t } = useLanguage();
  return (
    <Card className="border-border bg-card">
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2">
          {icon}
          <CardTitle className={`text-sm font-semibold ${color}`}>{title}</CardTitle>
        </div>
        <div className={`text-2xl font-bold font-mono mt-1 ${color}`}>{fmtNum(data.total)}</div>
        {prior !== undefined && (
          <div className="text-xs text-muted-foreground font-mono">
            {t("prior", "السابق")} {fmtNum(prior)} · Δ {data.total - prior >= 0 ? "+" : ""}{fmtNum(data.total - prior)} · {fmtPctChange(data.total, prior)}
          </div>
        )}
      </CardHeader>
      <CardContent>
        <table className="w-full text-xs">
          <thead><tr className="border-b border-border text-muted-foreground uppercase"><th className="text-left pb-1">{t("Item", "البند")}</th><th className="text-right pb-1">{t("Amount", "المبلغ")}</th></tr></thead>
          <tbody>
            {data.items.length === 0 ? (
              <tr><td colSpan={2} className="py-4 text-center text-muted-foreground">{t("No items", "لا توجد بنود")}</td></tr>
            ) : data.items.slice(0, 10).map((item, i) => (
              <tr key={i} className="border-b border-border/30 hover:bg-secondary/10">
                <td className="py-1.5 pr-2 text-foreground">{item.name}</td>
                <td className={`py-1.5 text-right font-mono ${item.amount >= 0 ? "text-emerald-400" : "text-red-400"}`}>{item.amount >= 0 ? "+" : ""}{fmtNum(item.amount)}</td>
              </tr>
            ))}
            {data.items.length > 10 && <tr><td colSpan={2} className="py-1 text-center text-muted-foreground text-xs">+{data.items.length - 10} {t("more items", "بنود إضافية")}</td></tr>}
          </tbody>
        </table>
      </CardContent>
    </Card>
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

  const { data, isLoading } = useQuery<CFData>({
    queryKey: ["cash-flow", applied.from, applied.to],
    queryFn: () => apiFetch(`/reports/cash-flow?date_from=${applied.from}&date_to=${applied.to}`),
  });

  const prior = compare !== "off" ? derivePriorRange(applied.from, applied.to, periods, compare) : null;
  const { data: priorData } = useQuery<CFData>({
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
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t("Cash Flow Statement", "قائمة التدفق النقدي")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t("Operating · Investing · Financing activities", "الأنشطة التشغيلية · الاستثمارية · التمويلية")}</p>
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
      {comparing && prior && <p className="text-xs text-muted-foreground">{priorRangeLabel(prior, lang)}</p>}
      {prior && priorEmpty && (
        <ComparisonUnavailable reason={`${t("No recorded activity between", "لا يوجد نشاط مسجل بين")} ${fmtDate(prior.from)} ${t("and", "و")} ${fmtDate(prior.to)} — ${t("nothing to compare against.", "لا يوجد ما يُقارن به.")}`} />
      )}

      {data && (
        <div className={`rounded-lg border px-6 py-4 flex items-center justify-between ${data.netChange >= 0 ? "border-emerald-500/30 bg-emerald-500/10" : "border-red-500/30 bg-red-500/10"}`}>
          <div>
            <div className="text-xs uppercase tracking-widest text-muted-foreground">{t("Net Change in Cash", "صافي التغير في النقدية")}</div>
            <div className={`text-3xl font-bold font-mono mt-1 ${data.netChange >= 0 ? "text-emerald-400" : "text-red-400"}`}>{data.netChange >= 0 ? "+" : ""}{fmtNum(data.netChange)}</div>
          </div>
          <div className="text-right text-xs text-muted-foreground space-y-1">
            <div>{t("Operating", "التشغيلية")}: <span className={data.operating.total >= 0 ? "text-emerald-400 font-mono" : "text-red-400 font-mono"}>{fmtNum(data.operating.total)}</span></div>
            <div>{t("Investing", "الاستثمارية")}: <span className={data.investing.total >= 0 ? "text-emerald-400 font-mono" : "text-red-400 font-mono"}>{fmtNum(data.investing.total)}</span></div>
            <div>{t("Financing", "التمويلية")}: <span className={data.financing.total >= 0 ? "text-emerald-400 font-mono" : "text-red-400 font-mono"}>{fmtNum(data.financing.total)}</span></div>
            {comparing && priorData && (
              <div className="pt-1 border-t border-border/50 font-mono">
                {t("prior net", "الصافي السابق")} {fmtNum(priorData.netChange)} · Δ {data.netChange - priorData.netChange >= 0 ? "+" : ""}{fmtNum(data.netChange - priorData.netChange)}
              </div>
            )}
          </div>
        </div>
      )}

      {isLoading ? <div className="text-muted-foreground text-sm p-4">{t("Loading...", "جارٍ التحميل...")}</div> : !data ? null : (
        <div className="grid grid-cols-3 gap-4">
          <CFBlock title={t("Operating Activities", "الأنشطة التشغيلية")} data={data.operating} color={data.operating.total >= 0 ? "text-emerald-400" : "text-red-400"} icon={<ArrowUpRight className="w-4 h-4 text-emerald-400" />} prior={comparing ? priorData!.operating.total : undefined} />
          <CFBlock title={t("Investing Activities", "الأنشطة الاستثمارية")} data={data.investing} color={data.investing.total >= 0 ? "text-emerald-400" : "text-amber-400"} icon={<Minus className="w-4 h-4 text-amber-400" />} prior={comparing ? priorData!.investing.total : undefined} />
          <CFBlock title={t("Financing Activities", "الأنشطة التمويلية")} data={data.financing} color={data.financing.total >= 0 ? "text-emerald-400" : "text-blue-400"} icon={<ArrowDownRight className="w-4 h-4 text-blue-400" />} prior={comparing ? priorData!.financing.total : undefined} />
          {/* Transfers between own accounts + invoice/bill settlements: the
              bank moved, no P&L activity occurred. Previously these were
              mis-bucketed under Operating as "Uncategorized". */}
          {data.internal && data.internal.items.length > 0 && (
            <CFBlock title={t("Internal Movements", "التحويلات الداخلية")} data={data.internal} color={data.internal.total >= 0 ? "text-emerald-400" : "text-muted-foreground"} icon={<Minus className="w-4 h-4 text-muted-foreground" />} prior={comparing ? priorData!.internal?.total ?? 0 : undefined} />
          )}
        </div>
      )}
    </div>
  );
}
