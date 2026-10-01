/**
 * Phase 14 (D14-10) — CSV / PDF export of the report ON SCREEN.
 *
 * The buttons send the page's own parameters (window, as-of date, comparison,
 * account, party) to `GET /reports/export/:report`, which runs the report's own
 * service call — so the file holds exactly what the screen shows. The language
 * is the UI's: an Arabic user gets Arabic labels, Arabic account names and a
 * right-to-left PDF (Commercial Books Law Art. 1 — books in Arabic).
 *
 * A refusal (a file too large to render, no PDF renderer on the server) is
 * shown in the server's own words — the export is never silently cut short.
 */
import { useState } from "react";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiDownload } from "@/lib/api";
import type { getExportReportUrl } from "@workspace/api-client-react";

/**
 * The exportable reports, taken from the CONTRACT (the generated export URL builder's own
 * parameter) — never a hand-kept copy of the server's list (§3: two definitions drift).
 */
export type ExportableReport = Parameters<typeof getExportReportUrl>[0];

export function ReportExportButtons({ report, params }: { report: ExportableReport; params: Record<string, string | number | null | undefined> }) {
  const { t, lang } = useLanguage();
  const { toast } = useToast();
  const [busy, setBusy] = useState<"csv" | "pdf" | null>(null);

  const run = async (format: "csv" | "pdf") => {
    const qs = new URLSearchParams({ format, lang });
    for (const [k, v] of Object.entries(params)) if (v != null && v !== "") qs.set(k, String(v));
    setBusy(format);
    try {
      await apiDownload(`/reports/export/${report}?${qs.toString()}`, `${report}.${format}`);
    } catch (e) {
      toast({ title: t("The export was not produced", "لم يتم إنشاء الملف"), description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex gap-2" data-testid={`export-${report}`}>
      <Button size="sm" variant="outline" className="h-8" disabled={busy != null} onClick={() => void run("csv")} data-testid={`export-${report}-csv`}>
        <Download className="w-3.5 h-3.5 me-1" />{busy === "csv" ? t("Preparing…", "جارٍ التحضير…") : t("CSV", "CSV")}
      </Button>
      <Button size="sm" variant="outline" className="h-8" disabled={busy != null} onClick={() => void run("pdf")} data-testid={`export-${report}-pdf`}>
        <Download className="w-3.5 h-3.5 me-1" />{busy === "pdf" ? t("Preparing…", "جارٍ التحضير…") : "PDF"}
      </Button>
    </div>
  );
}
