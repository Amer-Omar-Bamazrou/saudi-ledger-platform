import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t("Journal Report", "تقرير اليومية")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t("All posted journal entries — each entry shows its debit/credit lines", "كل قيود اليومية المرحّلة — يعرض كل قيد سطوره المدينة والدائنة")}</p>
        </div>
        {/* Export removed: it had no onClick — one of seven dead Export buttons
            found 2026-09-01. Omit the control rather than promise nothing (the
            VendorDetail precedent); export belongs to L1's artifact design. */}
      </div>

      <FiscalRangeNotice source={range.source} />

      <Card className="border-border bg-card">
        <CardContent className="pt-4">
          <div className="flex items-end gap-4">
            <div><Label className="text-xs text-muted-foreground">{t("From", "من")}</Label><Input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="mt-1 h-8 text-sm w-40" /></div>
            <div><Label className="text-xs text-muted-foreground">{t("To", "إلى")}</Label><Input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="mt-1 h-8 text-sm w-40" /></div>
            <Button size="sm" className="h-8" onClick={() => setApplied({ from: dateFrom, to: dateTo })}>{t("Generate", "إنشاء")}</Button>
            {data && (
              <div className={`flex items-center gap-2 ms-auto px-3 py-1.5 rounded-lg border ${data.balanced ? "border-positive-surface/30 bg-positive-surface/10" : "border-negative-surface/30 bg-negative-surface/10"}`}>
                {data.balanced ? <CheckCircle className="w-4 h-4 text-positive" /> : <XCircle className="w-4 h-4 text-negative" />}
                <span className={`text-xs font-medium ${data.balanced ? "text-positive" : "text-negative"}`}>{data.balanced ? t("Balanced", "متوازن") : t("Out of Balance", "غير متوازن")}</span>
              </div>
            )}
          </div>
          <div className="mt-3">
            <PeriodShortcuts from={dateFrom} to={dateTo} onSelect={(r)=>{setDateFrom(r.from);setDateTo(r.to);setApplied(r);}} />
          </div>
        </CardContent>
      </Card>

      {data && (
        <div className="grid grid-cols-3 gap-4">
          {[[t("Entries", "القيود"), data.count, "text-primary"], [t("Total Debits", "إجمالي المدين"), fmtNum(data.grandDebit), "text-info"], [t("Total Credits", "إجمالي الدائن"), fmtNum(data.grandCredit), "text-positive"]].map(([l, v, c]) => (
            <Card key={String(l)} className="border-border bg-card">
              <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{l}</CardTitle></CardHeader>
              <CardContent><div className={`text-xl font-bold font-mono ${c}`}>{v}</div></CardContent>
            </Card>
          ))}
        </div>
      )}

      {isLoading ? (
        <div className="text-muted-foreground text-sm p-4">{t("Loading journal entries…", "جارٍ تحميل قيود اليومية…")}</div>
      ) : !data ? null : data.entries.length === 0 ? (
        <Card className="border-border bg-card">
          <CardContent className="pt-6">
            <div className="text-center py-16 text-muted-foreground">
              <BookOpen className="w-8 h-8 mx-auto mb-3 opacity-40" />
              <p className="text-sm">{t("No posted journal entries in this period.", "لا توجد قيود مرحّلة في هذه الفترة.")}</p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {data.entries.map(entry => (
            <Card key={entry.id} className="border-border bg-card">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-xs text-primary font-semibold">{entry.entryNumber}</span>
                    <span className="text-sm font-medium text-foreground">{entry.description}</span>
                    {entry.reference && <span className="text-xs text-muted-foreground">· {entry.reference}</span>}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground"><DualDate date={entry.date} /></span>
                    <Badge variant="outline" className={`text-xs ${entry.balanced ? "border-positive-surface/30 text-positive" : "border-negative-surface/30 text-negative"}`}>
                      {entry.balanced ? t("✓ Balanced", "✓ متوازن") : t("✗ Unbalanced", "✗ غير متوازن")}
                    </Badge>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="pt-0">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-muted-foreground text-xs uppercase">
                      <th className="text-start pb-1.5 pe-4 font-medium">{t("Account", "الحساب")}</th>
                      <th className="text-start pb-1.5 pe-4 font-medium">{t("Description", "الوصف")}</th>
                      <th className="text-end pb-1.5 pe-4 font-medium">{t("Debit", "مدين")}</th>
                      <th className="text-end pb-1.5 font-medium">{t("Credit", "دائن")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entry.lines.map(line => (
                      <tr key={line.id} className="border-b border-border/30">
                        <td className="py-1.5 pe-4 text-foreground">{line.accountName}</td>
                        <td className="py-1.5 pe-4 text-muted-foreground text-xs">{line.description ?? "—"}</td>
                        <td className="py-1.5 pe-4 text-end font-mono text-sm">{line.debit > 0 ? <span className="text-info">{fmtNum(line.debit)}</span> : <span className="text-muted-foreground/30">—</span>}</td>
                        <td className="py-1.5 text-end font-mono text-sm">{line.credit > 0 ? <span className="text-positive">{fmtNum(line.credit)}</span> : <span className="text-muted-foreground/30">—</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-border font-semibold text-xs text-muted-foreground">
                      <td colSpan={2} className="pt-2">{t("Total", "الإجمالي")}</td>
                      <td className="pt-2 text-end font-mono text-info">{fmtNum(entry.totalDebit)}</td>
                      <td className="pt-2 text-end font-mono text-positive">{fmtNum(entry.totalCredit)}</td>
                    </tr>
                  </tfoot>
                </table>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
