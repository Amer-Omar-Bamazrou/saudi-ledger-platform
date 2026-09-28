import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { PageHeader, StatStrip, Stat, Panel, EmptyState } from "@/components/kit";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { BookOpen, CheckCircle, XCircle } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useReportDefaultRange, type ReportDefaultRange } from "@/hooks/useReportDefaultRange";
import { FiscalRangeNotice, ReportRangeLoading } from "@/components/FiscalRangeNotice";
import { PeriodShortcuts } from "@/components/PeriodShortcuts";
import { DualDate } from "@/components/DualDate";

import type { JournalReport as JournalReportData } from "@workspace/api-client-react";

export default function JournalReport() {
  // M20.1 — the report does not mount until its default window is known, so a
  // wrong window (the old hardcoded Jan–Dec) is never queried or rendered,
  // even for a frame.
  const range = useReportDefaultRange();
  if (!range.ready) return <ReportRangeLoading />;
  return <JournalReportInner range={range} />;
}

function JournalReportInner({ range }: { range: ReportDefaultRange }) {
  const { t } = useLanguage();
  const [dateFrom, setDateFrom] = useState(range.from);
  const [dateTo,   setDateTo]   = useState(range.to);
  const [applied,  setApplied]  = useState({ from: range.from, to: range.to });

  const { data, isLoading } = useQuery<JournalReportData>({
    queryKey: ["journal-report", applied.from, applied.to],
    queryFn: () => apiFetch(`/reports/journal-report?date_from=${applied.from}&date_to=${applied.to}`),
  });

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        title={t("Journal Report", "تقرير اليومية")}
        description={t("All posted journal entries — each entry shows its debit/credit lines", "كل قيود اليومية المرحّلة — يعرض كل قيد سطوره المدينة والدائنة")}
        actions={data && (
          <span className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-[13px] font-medium ${data.balanced ? "border-positive/30 bg-positive-surface/15 text-positive" : "border-negative/30 bg-negative-surface/15 text-negative"}`}>
            {data.balanced ? <CheckCircle className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
            {data.balanced ? t("Balanced", "متوازن") : t("Out of Balance", "غير متوازن")}
          </span>
        )}
      >
        {/* Export removed: it had no onClick — one of seven dead Export buttons
            found 2026-09-01. Omit the control rather than promise nothing (the
            VendorDetail precedent); export belongs to L1's artifact design. */}
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
        <StatStrip cols={3}>
          <Stat label={t("Entries", "القيود")} value={data.count} />
          <Stat label={t("Total Debits", "إجمالي المدين")} value={fmtNum(data.grandDebit)} />
          <Stat label={t("Total Credits", "إجمالي الدائن")} value={fmtNum(data.grandCredit)} />
        </StatStrip>
      )}

      {isLoading ? (
        <div className="text-muted-foreground text-sm p-4">{t("Loading journal entries…", "جارٍ تحميل قيود اليومية…")}</div>
      ) : !data ? null : data.entries.length === 0 ? (
        <Panel>
          <EmptyState icon={BookOpen} title={t("No posted journal entries in this period.", "لا توجد قيود مرحّلة في هذه الفترة.")} />
        </Panel>
      ) : (
        <div className="space-y-4">
          {data.entries.map(entry => (
            <Panel
              key={entry.id}
              flush
              title={
                <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="text-primary whitespace-nowrap">{entry.entryNumber}</span>
                  <span className="font-medium">{entry.description}</span>
                </span>
              }
              description={entry.reference ?? undefined}
              actions={
                <>
                  <span className="text-[13px] text-muted-foreground whitespace-nowrap"><DualDate date={entry.date} /></span>
                  <Badge variant="outline" className={`text-xs ${entry.balanced ? "border-positive/30 text-positive" : "border-negative/30 text-negative"}`}>
                    {entry.balanced ? t("✓ Balanced", "✓ متوازن") : t("✗ Unbalanced", "✗ غير متوازن")}
                  </Badge>
                </>
              }
            >
              <div className="overflow-x-auto"><table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-start px-3">{t("Account", "الحساب")}</th>
                    <th className="text-start px-3">{t("Description", "الوصف")}</th>
                    <th className="text-end px-3">{t("Debit", "مدين")}</th>
                    <th className="text-end px-3">{t("Credit", "دائن")}</th>
                  </tr>
                </thead>
                <tbody>
                  {entry.lines.map(line => (
                    <tr key={line.id} className="border-b border-border/70 last:border-b-0">
                      <td className="py-2.5 px-3 text-foreground">{line.accountName}</td>
                      <td className="py-2.5 px-3 text-muted-foreground">{line.description ?? "—"}</td>
                      <td className="py-2.5 px-3 text-end whitespace-nowrap tabular-nums">{line.debit > 0 ? fmtNum(line.debit) : <span className="text-muted-foreground/50">—</span>}</td>
                      <td className="py-2.5 px-3 text-end whitespace-nowrap tabular-nums">{line.credit > 0 ? fmtNum(line.credit) : <span className="text-muted-foreground/50">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="font-semibold">
                    <td colSpan={2} className="py-3 px-3">{t("Total", "الإجمالي")}</td>
                    <td className="py-3 px-3 text-end whitespace-nowrap tabular-nums">{fmtNum(entry.totalDebit)}</td>
                    <td className="py-3 px-3 text-end whitespace-nowrap tabular-nums">{fmtNum(entry.totalCredit)}</td>
                  </tr>
                </tfoot>
              </table></div>
            </Panel>
          ))}
        </div>
      )}
    </div>
  );
}
