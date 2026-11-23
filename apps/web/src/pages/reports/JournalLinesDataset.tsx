/**
 * 🔴 19B S4 — the journal-lines DATASET: the first report dataset's screen (its production caller, v4 §14).
 *
 * Every decision is the server's (`decide()`): the screen shows the columns the response lists, marks a WITHHELD column
 * with the permission it needs (D4 — never a blank that reads as data), and offers the export to every role; a refused
 * export is explained in the server's own words, never hidden (CLAUDE.md §3). The total is the true count; the page is
 * paged, never capped silently.
 */
import { useState } from "react";
import { Download } from "lucide-react";
import { useListReportDatasets, useRunJournalLinesDataset, type ReportDatasetColumn } from "@workspace/api-client-react";
import { apiDownload, fmtNum } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/contexts/LanguageContext";
import { useReportDefaultRange, type ReportDefaultRange } from "@/hooks/useReportDefaultRange";
import { FiscalRangeNotice, ReportRangeLoading } from "@/components/FiscalRangeNotice";
import { ReportFilterRow } from "@/components/reports/ReportFilterRow";

const PAGE = 100;

/** What a withheld class needs, in the reader's words. */
const CLASS_WORDS: Record<string, [string, string]> = {
  bank_narrative: ["the bank text permission", "صلاحية نص كشف البنك"],
  contact: ["the contact details permission", "صلاحية بيانات الاتصال"],
  identity: ["the identity permission", "صلاحية بيانات الهوية"],
  compensation: ["the pay permission", "صلاحية الرواتب"],
  bank_account: ["the bank account permission", "صلاحية الحسابات البنكية"],
};

export default function JournalLinesDataset() {
  const range = useReportDefaultRange();
  if (!range.ready) return <ReportRangeLoading />;
  return <JournalLinesInner range={range} />;
}

function JournalLinesInner({ range }: { range: ReportDefaultRange }) {
  const { t, lang } = useLanguage();
  const { toast } = useToast();
  const [dateFrom, setDateFrom] = useState(range.from);
  const [dateTo, setDateTo] = useState(range.to);
  const [applied, setApplied] = useState({ from: range.from, to: range.to });
  const [offset, setOffset] = useState(0);
  const [exporting, setExporting] = useState(false);

  const params = { date_from: applied.from, date_to: applied.to, limit: PAGE, offset };
  const { data, isLoading, error } = useRunJournalLinesDataset(params);
  const refusal = (error as { data?: { error?: string; errorAr?: string } } | null)?.data;
  // what this role may do with the dataset (decide(), server-side) — said up front; the button stays, and a refused
  // export is explained in the server's words
  const acts = useListReportDatasets().data?.items.find((i) => i.name === "journal_lines")?.acts;
  const cannotExport = acts != null && !acts.includes("export");

  const needs = (c: ReportDatasetColumn) => {
    const [en, ar] = CLASS_WORDS[c.class] ?? [c.class, c.class];
    return t(`Withheld — needs ${en}`, `محجوب — يحتاج ${ar}`);
  };

  const exportCsv = async () => {
    const qs = new URLSearchParams({ date_from: applied.from, date_to: applied.to, lang });
    setExporting(true);
    try {
      await apiDownload(`/reports/datasets/journal_lines/export?${qs.toString()}`, "journal-lines.csv");
    } catch (e) {
      toast({ title: t("The export was not produced", "لم يتم إنشاء الملف"), description: (e as Error).message, variant: "destructive" });
    } finally {
      setExporting(false);
    }
  };

  const cell = (c: ReportDatasetColumn, row: Record<string, unknown>) => {
    if (!(c.key in row)) {
      // absent: withheld on this row (the response lists the column as withheld) — say so, never a blank
      return <span className="text-[11px] text-muted-foreground italic" data-testid="dataset-cell-withheld">{t("withheld", "محجوب")}</span>;
    }
    const v = row[c.key];
    if (v == null || v === "") return "—";
    if (c.kind === "money") return fmtNum(Number(v));
    if (c.key === "accountName" && lang === "ar" && row.accountNameAr) return String(row.accountNameAr);
    return String(v);
  };

  const columns = (data?.columns ?? []).filter((c) => c.key !== "accountNameAr" && c.key !== "lineId" && c.key !== "accountId");

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t("Journal lines", "سطور القيود")}</h1>
          <p className="text-muted-foreground text-sm mt-1">
            {t("Every line of every journal entry in the books, in this company — the report data your role may see.", "كل سطر من كل قيد في الدفاتر، في هذه المنشأة — بيانات التقرير التي يسمح بها دورك.")}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <Button size="sm" variant="outline" className="h-8" disabled={exporting} onClick={() => void exportCsv()} data-testid="journal-lines-export">
            <Download className="w-3.5 h-3.5 me-1" />{exporting ? t("Preparing…", "جارٍ التحضير…") : t("Export CSV", "تصدير CSV")}
          </Button>
          {cannotExport && <span className="text-[11px] text-muted-foreground" data-testid="journal-lines-no-export">{t("Your role cannot export these lines.", "دورك لا يسمح بتصدير هذه السطور.")}</span>}
        </div>
      </div>

      <FiscalRangeNotice source={range.source} />

      <Card className="border-border bg-card">
        <CardContent className="pt-4">
          <ReportFilterRow>
            <div><Label className="text-xs text-muted-foreground">{t("From", "من")}</Label><Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="mt-1 h-8 text-sm w-40" /></div>
            <div><Label className="text-xs text-muted-foreground">{t("To", "إلى")}</Label><Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="mt-1 h-8 text-sm w-40" /></div>
            <Button size="sm" className="h-8" onClick={() => { setApplied({ from: dateFrom, to: dateTo }); setOffset(0); }} data-testid="journal-lines-generate">{t("Generate", "إنشاء")}</Button>
          </ReportFilterRow>
        </CardContent>
      </Card>

      {refusal && (
        <p className="text-sm text-attention" data-testid="journal-lines-refusal">{lang === "ar" ? refusal.errorAr ?? refusal.error : refusal.error}</p>
      )}

      {data && data.withheld.length > 0 && (
        <p className="text-xs text-muted-foreground" data-testid="journal-lines-withheld-note">
          {t("Some values are withheld for your role; each is marked where it would be.", "بعض القيم محجوبة لدورك، وكل منها مُعلَّم في مكانه.")}
        </p>
      )}

      <Card className="border-border bg-card">
        <CardContent className="pt-4 overflow-x-auto">
          {isLoading ? (
            <p className="text-sm text-muted-foreground">{t("Loading…", "جارٍ التحميل…")}</p>
          ) : data && data.rows.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="journal-lines-empty">{t("No journal lines in this window.", "لا توجد سطور قيود في هذه الفترة.")}</p>
          ) : data ? (
            <table className="w-full text-sm" data-testid="journal-lines-table">
              <thead>
                <tr className="text-muted-foreground border-b border-border">
                  {columns.map((c) => (
                    <th key={c.key} className="text-start py-2 pe-3 font-medium align-bottom" data-testid={`journal-lines-col-${c.key}`} data-level={c.level}>
                      {lang === "ar" ? c.labelAr : c.label}
                      {c.level !== "read" && <span className="block text-[10px] font-normal text-attention">{needs(c)}</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r, i) => (
                  <tr key={String((r as Record<string, unknown>).lineId ?? i)} className="border-b border-border/50" data-testid="journal-lines-row">
                    {columns.map((c) => (
                      <td key={c.key} className={`py-2 pe-3 ${c.kind === "money" ? "font-mono" : ""}`}>{cell(c, r as Record<string, unknown>)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          {data && data.total > 0 && (
            <div className="flex items-center justify-between pt-3 text-xs text-muted-foreground">
              <span data-testid="journal-lines-count">
                {t(`${offset + 1}–${offset + data.rows.length} of ${data.total} lines`, `${offset + 1}–${offset + data.rows.length} من ${data.total} سطراً`)}
              </span>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" className="h-7" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>{t("Previous", "السابق")}</Button>
                <Button size="sm" variant="outline" className="h-7" disabled={offset + PAGE >= data.total} onClick={() => setOffset(offset + PAGE)}>{t("Next", "التالي")}</Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
