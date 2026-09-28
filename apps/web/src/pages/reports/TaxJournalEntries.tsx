import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { PageHeader, StatStrip, Stat, Panel, EmptyState } from "@/components/kit";
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
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        title={t("Tax Journal Entries", "قيود اليومية الضريبية")}
        description={t("All journal entries that touch VAT or tax accounts", "كل قيود اليومية التي تمس حسابات الضريبة")}
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
        <StatStrip cols={3}>
          <Stat label={t("Tax Entries", "القيود الضريبية")} value={data.count} />
          <Stat label={t("Total VAT Debited", "إجمالي الضريبة المدينة")} value={fmtNum(totalVatDebit)} />
          <Stat label={t("Total VAT Credited", "إجمالي الضريبة الدائنة")} value={fmtNum(totalVatCredit)} />
        </StatStrip>
      )}

      {isLoading ? (
        <div className="text-sm text-muted-foreground p-4">{t("Loading…", "جارٍ التحميل…")}</div>
      ) : !data || data.entries.length === 0 ? (
        <Panel>
          <EmptyState
            icon={Receipt}
            title={t("No tax journal entries in this period.", "لا توجد قيود ضريبية في هذه الفترة.")}
            description={t('Entries touching accounts with "VAT" or "Tax" in the name will appear here.', "ستظهر هنا القيود التي تمس حسابات تحمل \"VAT\" أو \"Tax\" في اسمها.")}
          />
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
              actions={<span className="text-[13px] text-muted-foreground whitespace-nowrap"><DualDate date={entry.date} /></span>}
            >
              <div className="overflow-x-auto"><table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-start px-3">{t("Account", "الحساب")}</th>
                    <th className="text-end px-3">{t("Debit", "مدين")}</th>
                    <th className="text-end px-3">{t("Credit", "دائن")}</th>
                  </tr>
                </thead>
                <tbody>
                  {entry.lines.map((line, i) => (
                    <tr key={i} className={cn("border-b border-border/70 last:border-b-0", line.isTaxLine && "bg-attention-surface/10")}>
                      <td className="py-2.5 px-3">
                        <span className={cn(line.isTaxLine ? "text-attention font-medium" : "text-foreground")}>{line.accountName}</span>
                        {line.isTaxLine && <span className="ms-2 text-xs text-attention/70">● tax</span>}
                      </td>
                      <td className="py-2.5 px-3 text-end whitespace-nowrap tabular-nums">{line.debit > 0 ? fmtNum(line.debit) : "—"}</td>
                      <td className="py-2.5 px-3 text-end whitespace-nowrap tabular-nums">{line.credit > 0 ? fmtNum(line.credit) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="font-semibold">
                    <td className="py-3 px-3">{t("VAT totals for this entry", "إجمالي الضريبة لهذا القيد")}</td>
                    <td className="py-3 px-3 text-end whitespace-nowrap tabular-nums">{fmtNum(entry.totalVatDebit)}</td>
                    <td className="py-3 px-3 text-end whitespace-nowrap tabular-nums">{fmtNum(entry.totalVatCredit)}</td>
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
