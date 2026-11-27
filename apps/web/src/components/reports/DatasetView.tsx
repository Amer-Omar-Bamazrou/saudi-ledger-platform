/**
 * 🔴 19B S5 — one screen for a report DATASET (the four after journal lines share it; pages/reports/Datasets.tsx).
 *
 * Every decision is the server's (`decide()`): the screen shows the columns the response lists, marks a WITHHELD column
 * with the permission it needs (D4 — never a blank that reads as data), and offers the export to every role; a refusal
 * (a role that may not run the dataset, a refused export) is explained in the server's own words, never hidden. The
 * total is the true count; the page is paged, never capped silently. The rows come through the GENERATED client hook
 * the page passes in — this file declares no response shape of its own.
 */
import { useState } from "react";
import { Download } from "lucide-react";
import { useListReportDatasets, type ReportDatasetColumn, type ReportDatasetWithheld } from "@workspace/api-client-react";
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

interface RowsResponse { columns: ReportDatasetColumn[]; rows: object[]; total: number; withheld: ReportDatasetWithheld[] }
export interface DatasetParams { date_from: string; date_to: string; limit: number; offset: number }
export interface DatasetViewProps {
  /** The dataset's name, as the server lists it (its acts are read from the list). */
  name: string;
  /** The test-id prefix (kebab-case). */
  slug: string;
  title: [en: string, ar: string];
  subtitle: [en: string, ar: string];
  /** The export route — a literal path at the call site. */
  exportPath: string;
  /** The generated client's hook for this dataset's rows. */
  useRows: (params: DatasetParams) => { data?: RowsResponse; isLoading: boolean; error: unknown };
}

export function DatasetView(props: DatasetViewProps) {
  const range = useReportDefaultRange();
  if (!range.ready) return <ReportRangeLoading />;
  return <Inner {...props} range={range} />;
}

function Inner({ name, slug, title, subtitle, exportPath, useRows, range }: DatasetViewProps & { range: ReportDefaultRange }) {
  const { t, lang } = useLanguage();
  const { toast } = useToast();
  const [dateFrom, setDateFrom] = useState(range.from);
  const [dateTo, setDateTo] = useState(range.to);
  const [applied, setApplied] = useState({ from: range.from, to: range.to });
  const [offset, setOffset] = useState(0);
  const [exporting, setExporting] = useState(false);

  const { data, isLoading, error } = useRows({ date_from: applied.from, date_to: applied.to, limit: PAGE, offset });
  const refusal = (error as { data?: { error?: string; errorAr?: string } } | null)?.data;
  const described = useListReportDatasets().data?.items.find((i) => i.name === name);
  const acts = described?.acts;
  const cannotExport = acts != null && !acts.includes("export");

  const needs = (c: ReportDatasetColumn) => {
    const [en, ar] = CLASS_WORDS[c.class] ?? [c.class, c.class];
    return t(`Withheld — needs ${en}`, `محجوب — يحتاج ${ar}`);
  };

  const exportCsv = async () => {
    const qs = new URLSearchParams({ date_from: applied.from, date_to: applied.to, lang });
    setExporting(true);
    try {
      await apiDownload(`${exportPath}?${qs.toString()}`, `${slug}.csv`);
    } catch (e) {
      toast({ title: t("The export was not produced", "لم يتم إنشاء الملف"), description: (e as Error).message, variant: "destructive" });
    } finally {
      setExporting(false);
    }
  };

  const cell = (c: ReportDatasetColumn, row: Record<string, unknown>) => {
    if (!(c.key in row)) {
      return <span className="text-[11px] text-muted-foreground italic" data-testid="dataset-cell-withheld">{t("withheld", "محجوب")}</span>;
    }
    const v = row[c.key];
    if (v == null || v === "") return "—";
    if (typeof v === "boolean") return v ? t("yes", "نعم") : t("no", "لا");
    if (c.kind === "money") return fmtNum(Number(v));
    return String(v);
  };

  // ids are for linking, not for reading: the number and the name are shown
  const columns = (data?.columns ?? []).filter((c) => !/Id$/.test(c.key) && c.key !== "lineNo");

  return (
    <div className="space-y-6" data-testid={`${slug}-page`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t(title[0], title[1])}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t(subtitle[0], subtitle[1])}</p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <Button size="sm" variant="outline" className="h-8" disabled={exporting} onClick={() => void exportCsv()} data-testid={`${slug}-export`}>
            <Download className="w-3.5 h-3.5 me-1" />{exporting ? t("Preparing…", "جارٍ التحضير…") : t("Export CSV", "تصدير CSV")}
          </Button>
          {cannotExport && <span className="text-[11px] text-muted-foreground">{t("Your role cannot export this report.", "دورك لا يسمح بتصدير هذا التقرير.")}</span>}
        </div>
      </div>

      <FiscalRangeNotice source={range.source} />

      {described?.caveat && (
        <p className="text-xs text-attention" data-testid={`${slug}-caveat`}>{lang === "ar" ? described.caveatAr ?? described.caveat : described.caveat}</p>
      )}

      <Card className="border-border bg-card">
        <CardContent className="pt-4">
          <ReportFilterRow>
            <div><Label className="text-xs text-muted-foreground">{t("From", "من")}</Label><Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="mt-1 h-8 text-sm w-40" /></div>
            <div><Label className="text-xs text-muted-foreground">{t("To", "إلى")}</Label><Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="mt-1 h-8 text-sm w-40" /></div>
            <Button size="sm" className="h-8" onClick={() => { setApplied({ from: dateFrom, to: dateTo }); setOffset(0); }} data-testid={`${slug}-generate`}>{t("Generate", "إنشاء")}</Button>
          </ReportFilterRow>
        </CardContent>
      </Card>

      {refusal && (
        <p className="text-sm text-attention" data-testid={`${slug}-refusal`}>{lang === "ar" ? refusal.errorAr ?? refusal.error : refusal.error}</p>
      )}

      {data && data.withheld.length > 0 && (
        <p className="text-xs text-muted-foreground" data-testid={`${slug}-withheld-note`}>
          {t("Some values are withheld for your role; each is marked where it would be.", "بعض القيم محجوبة لدورك، وكل منها مُعلَّم في مكانه.")}
        </p>
      )}

      <Card className="border-border bg-card">
        <CardContent className="pt-4 overflow-x-auto">
          {isLoading ? (
            <p className="text-sm text-muted-foreground">{t("Loading…", "جارٍ التحميل…")}</p>
          ) : data && data.rows.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid={`${slug}-empty`}>{t("Nothing in this window.", "لا توجد بيانات في هذه الفترة.")}</p>
          ) : data ? (
            <table className="w-full text-sm" data-testid={`${slug}-table`}>
              <thead>
                <tr className="text-muted-foreground border-b border-border">
                  {columns.map((c) => (
                    <th key={c.key} className="text-start py-2 pe-3 font-medium align-bottom" data-testid={`${slug}-col-${c.key}`} data-level={c.level}>
                      {lang === "ar" ? c.labelAr : c.label}
                      {c.level !== "read" && <span className="block text-[10px] font-normal text-attention">{needs(c)}</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r, i) => (
                  <tr key={i} className="border-b border-border/50" data-testid={`${slug}-row`}>
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
              <span data-testid={`${slug}-count`}>
                {t(`${offset + 1}–${offset + data.rows.length} of ${data.total}`, `${offset + 1}–${offset + data.rows.length} من ${data.total}`)}
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
