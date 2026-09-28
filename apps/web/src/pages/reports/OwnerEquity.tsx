import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { PageHeader, StatStrip, Stat, Panel } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useLanguage } from "@/contexts/LanguageContext";
import { cn } from "@/lib/utils";
import { useReportDefaultRange, type ReportDefaultRange } from "@/hooks/useReportDefaultRange";
import { FiscalRangeNotice, ReportRangeLoading } from "@/components/FiscalRangeNotice";
import { PeriodShortcuts } from "@/components/PeriodShortcuts";

import type { OwnerEquityReport } from "@workspace/api-client-react";

export default function OwnerEquity() {
  // M20.1 — the report does not mount until its default window is known, so a
  // wrong window (the old hardcoded Jan–Dec) is never queried or rendered,
  // even for a frame.
  const range = useReportDefaultRange();
  if (!range.ready) return <ReportRangeLoading />;
  return <OwnerEquityInner range={range} />;
}

function OwnerEquityInner({ range }: { range: ReportDefaultRange }) {
  const { t } = useLanguage();
  const [dateFrom, setDateFrom] = useState(range.from);
  const [dateTo,   setDateTo]   = useState(range.to);
  const [applied,  setApplied]  = useState({ from: range.from, to: range.to });

  const { data, isLoading } = useQuery<OwnerEquityReport>({
    queryKey: ["owner-equity", applied.from, applied.to],
    queryFn: () => apiFetch(`/reports/owner-equity?date_from=${applied.from}&date_to=${applied.to}`),
  });

  const labelFor = (key: string, fallback: string) =>
    ({ openingEquity: t("Opening Equity", "حقوق الملكية الافتتاحية"), netIncome: t("Net Income / (Loss)", "صافي الدخل / (الخسارة)"), contributions: t("Capital Contributions", "المساهمات الرأسمالية"), withdrawals: t("Withdrawals / Drawings", "المسحوبات"), closingEquity: t("Closing Equity", "حقوق الملكية الختامية") } as Record<string, string>)[key] ?? fallback;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader
        title={t("Change in Owner Equity Statement", "قائمة التغير في حقوق الملكية")}
        description={t("Opening equity + net income + contributions − withdrawals = closing equity", "حقوق الملكية الافتتاحية + صافي الدخل + المساهمات − المسحوبات = حقوق الملكية الختامية")}
      >
        {/* Export removed: no onClick — one of seven dead Export buttons (2026-09-01). */}
        <div className="mt-2"><FiscalRangeNotice source={range.source} /></div>
      </PageHeader>

      <Panel>
        <div className="flex flex-wrap items-end gap-3">
          <div><Label className="text-xs text-muted-foreground">{t("From", "من")}</Label><Input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="mt-1 h-8 text-sm w-40" /></div>
          <div><Label className="text-xs text-muted-foreground">{t("To", "إلى")}</Label><Input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="mt-1 h-8 text-sm w-40" /></div>
          <Button size="sm" className="h-8" onClick={() => setApplied({ from: dateFrom, to: dateTo })}>{t("Generate", "إنشاء")}</Button>
        </div>
        <div className="mt-3">
          <PeriodShortcuts from={dateFrom} to={dateTo} onSelect={(r)=>{setDateFrom(r.from);setDateTo(r.to);setApplied(r);}} />
        </div>
      </Panel>

      {data && (
        <StatStrip cols={4}>
          <Stat label={t("Opening Equity", "حقوق الملكية الافتتاحية")} value={fmtNum(data.openingEquity)} />
          <Stat label={t("Net Income / (Loss)", "صافي الدخل / (الخسارة)")} value={fmtNum(data.netIncome)} tone={data.netIncome >= 0 ? "positive" : "negative"} />
          <Stat label={t("Contributions", "المساهمات")} value={fmtNum(data.contributions)} />
          <Stat label={t("Withdrawals", "المسحوبات")} value={fmtNum(data.withdrawals)} />
        </StatStrip>
      )}

      {isLoading ? (
        <div className="text-sm text-muted-foreground p-4">{t("Loading…", "جارٍ التحميل…")}</div>
      ) : !data ? null : (
        <Panel
          flush
          title={t("Statement of Changes in Owner's Equity", "قائمة التغيرات في حقوق الملكية")}
          description={<>{data.period.from} {t("to", "إلى")} {data.period.to}</>}
          actions={data.closingEquity !== 0 && (
            <span className="text-[13px] text-muted-foreground">
              {t("Closing Equity", "حقوق الملكية الختامية")}{" "}
              <span className={cn("text-[15px] font-semibold tabular-nums", data.closingEquity >= 0 ? "text-foreground" : "text-negative")}>{fmtNum(data.closingEquity)}</span>
            </span>
          )}
        >
          <table className="w-full text-sm">
            <tbody>
              {data.breakdown.slice(0, -1).map((row) => {
                const isIncome  = row.key === "netIncome";
                const isWithdrawal = row.key === "withdrawals";
                return (
                  <tr key={row.label} className="border-b border-border/70 last:border-b-0">
                    <td className="py-3 px-3 text-foreground">{labelFor(row.key, row.label)}</td>
                    <td className={cn(
                      "py-3 px-3 text-end whitespace-nowrap tabular-nums",
                      isIncome && row.amount < 0 ? "text-negative" : "",
                    )}>
                      {isWithdrawal && row.amount !== 0 ? `(${fmtNum(Math.abs(row.amount))})` : fmtNum(row.amount)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            {data.breakdown.length > 0 && (() => {
              const row = data.breakdown[data.breakdown.length - 1];
              const isWithdrawal = row.key === "withdrawals";
              return (
                <tfoot>
                  <tr className="font-semibold">
                    <td className="py-3.5 px-3 text-foreground">{labelFor(row.key, row.label)}</td>
                    <td className={cn("py-3.5 px-3 text-end whitespace-nowrap tabular-nums text-base", data.closingEquity < 0 ? "text-negative" : "text-foreground")}>
                      {isWithdrawal && row.amount !== 0 ? `(${fmtNum(Math.abs(row.amount))})` : fmtNum(row.amount)}
                    </td>
                  </tr>
                </tfoot>
              );
            })()}
          </table>

          {data.openingEquity === 0 && data.contributions === 0 && (
            <div className="border-t border-border px-5 py-3">
              <p className="text-xs text-muted-foreground">
                <span className="font-semibold">{t("Note:", "ملاحظة:")}</span> {t("Opening equity is zero because no equity-type accounts have been posted in journal entries before this period. Post capital contributions or retained earnings to equity accounts to see a complete statement.", "حقوق الملكية الافتتاحية صفر لأنه لم تُرحّل قيود على حسابات حقوق الملكية قبل هذه الفترة. رحّل مساهمات رأس المال أو الأرباح المحتجزة إلى حسابات حقوق الملكية لرؤية قائمة مكتملة.")}
              </p>
            </div>
          )}
        </Panel>
      )}
    </div>
  );
}
