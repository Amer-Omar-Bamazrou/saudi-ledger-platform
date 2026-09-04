import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Receipt } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { cn } from "@/lib/utils";
import { useReportDefaultRange, type ReportDefaultRange } from "@/hooks/useReportDefaultRange";
import { FiscalRangeNotice, ReportRangeLoading } from "@/components/FiscalRangeNotice";
import { PeriodShortcuts } from "@/components/PeriodShortcuts";
import { DualDate } from "@/components/DualDate";

import type { TaxJournalEntriesReport } from "@workspace/api-client-react";

export default function TaxJournalEntries() {
  // M20.1 — the report does not mount until its default window is known, so a
  // wrong window (the old hardcoded Jan–Dec) is never queried or rendered,
  // even for a frame.
  const range = useReportDefaultRange();
  if (!range.ready) return <ReportRangeLoading />;
  return <TaxJournalEntriesInner range={range} />;
}

function TaxJournalEntriesInner({ range }: { range: ReportDefaultRange }) {
  const { t } = useLanguage();
  const [dateFrom, setDateFrom] = useState(range.from);
  const [dateTo,   setDateTo]   = useState(range.to);
  const [applied,  setApplied]  = useState({ from: range.from, to: range.to });

  const { data, isLoading } = useQuery<TaxJournalEntriesReport>({
    queryKey: ["tax-journal-entries", applied.from, applied.to],
    queryFn: () => apiFetch(`/reports/tax-journal-entries?date_from=${applied.from}&date_to=${applied.to}`),
  });

  const totalVatDebit  = data?.entries.reduce((s, e) => s + e.totalVatDebit,  0) ?? 0;
  const totalVatCredit = data?.entries.reduce((s, e) => s + e.totalVatCredit, 0) ?? 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">
            {t("Tax Journal Entries", "قيود اليومية الضريبية")}
          </h1>
          <p className="text-muted-foreground text-sm mt-1">{t("All journal entries that touch VAT or tax accounts", "كل قيود اليومية التي تمس حسابات الضريبة")}</p>
        </div>
        {/* Export removed: no onClick — one of seven dead Export buttons (2026-09-01). */}
      </div>

      <FiscalRangeNotice source={range.source} />

      <Card className="border-border bg-card">
        <CardContent className="pt-4">
          <div className="flex items-end gap-4">
            <div><Label className="text-xs text-muted-foreground">{t("From", "من")}</Label><Input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="mt-1 h-8 text-sm w-40" /></div>
            <div><Label className="text-xs text-muted-foreground">{t("To", "إلى")}</Label><Input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="mt-1 h-8 text-sm w-40" /></div>
            <Button size="sm" className="h-8" onClick={() => setApplied({ from: dateFrom, to: dateTo })}>{t("Generate", "إنشاء")}</Button>
          </div>
          <div className="mt-3">
            <PeriodShortcuts from={dateFrom} to={dateTo} onSelect={(r)=>{setDateFrom(r.from);setDateTo(r.to);setApplied(r);}} />
          </div>
        </CardContent>
      </Card>

      {data && (
        <div className="grid grid-cols-3 gap-4">
          {[
            [t("Tax Entries", "القيود الضريبية"), data.count, "text-primary"],
            [t("Total VAT Debited", "إجمالي الضريبة المدينة"), fmtNum(totalVatDebit), "text-info"],
            [t("Total VAT Credited", "إجمالي الضريبة الدائنة"), fmtNum(totalVatCredit), "text-positive"],
          ].map(([l, v, c]) => (
            <Card key={String(l)} className="border-border bg-card">
              <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{l}</CardTitle></CardHeader>
              <CardContent><div className={`text-2xl font-bold font-mono ${c}`}>{v}</div></CardContent>
            </Card>
          ))}
        </div>
      )}

      {isLoading ? (
        <div className="text-sm text-muted-foreground p-4">{t("Loading…", "جارٍ التحميل…")}</div>
      ) : !data || data.entries.length === 0 ? (
        <Card className="border-border bg-card">
          <CardContent className="pt-6">
            <div className="text-center py-16 text-muted-foreground">
              <Receipt className="w-8 h-8 mx-auto mb-3 opacity-40" />
              <p className="text-sm">{t("No tax journal entries in this period.", "لا توجد قيود ضريبية في هذه الفترة.")}</p>
              <p className="text-xs mt-1 opacity-60">Entries touching accounts with "VAT" or "Tax" in the name will appear here.</p>
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
                  <span className="text-xs text-muted-foreground"><DualDate date={entry.date} /></span>
                </div>
              </CardHeader>
              <CardContent className="pt-0">
                <div className="overflow-x-auto"><table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-muted-foreground text-xs uppercase">
                      <th className="text-start pb-1.5 pe-4 font-medium">{t("Account", "الحساب")}</th>
                      <th className="text-end pb-1.5 pe-4 font-medium">{t("Debit", "مدين")}</th>
                      <th className="text-end pb-1.5 font-medium">{t("Credit", "دائن")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entry.lines.map((line, i) => (
                      <tr key={i} className={cn("border-b border-border/30", line.isTaxLine && "bg-attention-surface/5")}>
                        <td className="py-1.5 pe-4">
                          <span className={cn("text-sm", line.isTaxLine ? "text-attention font-medium" : "text-foreground")}>{line.accountName}</span>
                          {line.isTaxLine && <span className="ms-2 text-xs text-attention/60">● tax</span>}
                        </td>
                        <td className="py-1.5 pe-4 text-end font-mono text-sm text-info">{line.debit > 0 ? fmtNum(line.debit) : "—"}</td>
                        <td className="py-1.5 text-end font-mono text-sm text-positive">{line.credit > 0 ? fmtNum(line.credit) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-border text-xs text-muted-foreground font-semibold">
                      <td className="pt-2">{t("VAT totals for this entry", "إجمالي الضريبة لهذا القيد")}</td>
                      <td className="pt-2 text-end font-mono text-info">{fmtNum(entry.totalVatDebit)}</td>
                      <td className="pt-2 text-end font-mono text-positive">{fmtNum(entry.totalVatCredit)}</td>
                    </tr>
                  </tfoot>
                </table></div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
