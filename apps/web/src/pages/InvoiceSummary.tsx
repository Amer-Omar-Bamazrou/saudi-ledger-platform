import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { FileText, Download } from "lucide-react";
import { useReportDefaultRange, type ReportDefaultRange } from "@/hooks/useReportDefaultRange";
import { FiscalRangeNotice, ReportRangeLoading } from "@/components/FiscalRangeNotice";
import { PeriodShortcuts } from "@/components/PeriodShortcuts";
import { DualDate } from "@/components/DualDate";
import { useLanguage } from "@/contexts/LanguageContext";

interface InvoiceSummaryRow {
  id: number; invoiceNumber: string; customerName: string; date: string;
  dueDate: string; status: string; subtotal: number; vatAmount: number; total: number; paidAmount: number;
}

const STATUS_STYLES: Record<string, string> = {
  draft: "bg-secondary text-muted-foreground",
  sent: "bg-info-surface/20 text-info",
  paid: "bg-positive-surface/20 text-positive",

  partial: "bg-attention-surface/20 text-attention",
};

export default function InvoiceSummary() {
  // M20.1 — the report does not mount until its default window is known, so a
  // wrong window (the old hardcoded Jan–Dec) is never queried or rendered,
  // even for a frame.
  const range = useReportDefaultRange();
  if (!range.ready) return <ReportRangeLoading />;
  return <InvoiceSummaryInner range={range} />;
}

function InvoiceSummaryInner({ range }: { range: ReportDefaultRange }) {
  const { t } = useLanguage();
  const [from, setFrom] = useState(range.from);
  const [to, setTo] = useState(range.to);

  const { data: invoices = [], isLoading } = useQuery<InvoiceSummaryRow[]>({
    queryKey: ["invoice-summary", from, to],
    /**
     * 🔴 Reads the PAGE envelope, and no longer swallows a failure into an
     * empty list. The old `.catch(() => [])` turned a shape mismatch into "No
     * invoices in this date range" — a confident empty answer on a report,
     * which is the same defensive-fallback trap that hid the AP-aging break.
     */
    queryFn: async () => {
      const page = await apiFetch<{ items: InvoiceSummaryRow[] }>(
        `/invoices?limit=200&from=${from}&to=${to}`,
      );
      return page.items;
    },
  });

  const filtered = invoices.filter(i => i.date >= from && i.date <= to);
  const totalRevenue = filtered.reduce((s, i) => s + i.subtotal, 0);
  const totalVat = filtered.reduce((s, i) => s + i.vatAmount, 0);
  const totalOutstanding = filtered.filter(i => i.status !== "paid").reduce((s, i) => s + (i.total - i.paidAmount), 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t("Invoice Summary", "ملخص الفواتير")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t("All invoices with totals and status breakdown", "جميع الفواتير مع الإجماليات وتوزيع الحالات")}</p>
        </div>
        <Button variant="outline" className="gap-2"><Download className="w-4 h-4" /> Export</Button>
      </div>

      <FiscalRangeNotice source={range.source} />

      <Card className="border-border bg-card">
        <CardContent className="pt-4 pb-4">
          <div className="flex gap-4 items-end">
            <div><Label className="text-xs text-muted-foreground">{t("From", "من")}</Label>
              <Input type="date" value={from} onChange={e => setFrom(e.target.value)} className="mt-1 h-8 text-sm w-40" /></div>
            <div><Label className="text-xs text-muted-foreground">{t("To", "إلى")}</Label>
              <Input type="date" value={to} onChange={e => setTo(e.target.value)} className="mt-1 h-8 text-sm w-40" /></div>
          </div>
          <div className="mt-3">
            <PeriodShortcuts from={from} to={to} onSelect={(r)=>{setFrom(r.from);setTo(r.to);}} />
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-4 gap-4">
        {[
          ["Total Invoices", filtered.length, "text-primary"],
          ["Revenue (excl. VAT)", fmtNum(totalRevenue), "text-primary"],
          ["VAT Charged", fmtNum(totalVat), "text-attention"],
          ["Outstanding", fmtNum(totalOutstanding), "text-negative"],
        ].map(([l, v, c]) => (
          <Card key={String(l)} className="border-border bg-card">
            <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{l}</CardTitle></CardHeader>
            <CardContent><div className={`text-2xl font-bold font-mono ${c}`}>{v}</div></CardContent>
          </Card>
        ))}
      </div>

      <Card className="border-border bg-card">
        <CardContent className="pt-6">
          {isLoading ? <div className="text-sm text-muted-foreground p-4">Loading…</div>
          : filtered.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground">
              <FileText className="w-8 h-8 mx-auto mb-3 opacity-40" />
              <p className="text-sm">{t("No invoices in this date range.", "لا توجد فواتير في هذا النطاق الزمني.")}</p>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-muted-foreground text-xs uppercase">
                  {["Invoice #", "Customer", "Date", "Due Date", "Subtotal", "VAT", "Total", "Outstanding", "Status"].map(h => (
                    <th key={h} className="text-start pb-2 pe-3 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(i => (
                  <tr key={i.id} className="border-b border-border/50 hover:bg-secondary/20">
                    <td className="py-2 pe-3 font-mono text-xs text-primary">{i.invoiceNumber}</td>
                    <td className="py-2 pe-3 font-medium text-xs">{i.customerName}</td>
                    <td className="py-2 pe-3 text-muted-foreground text-xs"><DualDate date={i.date} /></td>
                    <td className="py-2 pe-3 text-muted-foreground text-xs"><DualDate date={i.dueDate} /></td>
                    <td className="py-2 pe-3 font-mono text-xs">{fmtNum(i.subtotal)}</td>
                    <td className="py-2 pe-3 font-mono text-xs text-attention">{fmtNum(i.vatAmount)}</td>
                    <td className="py-2 pe-3 font-mono text-xs font-semibold">{fmtNum(i.total)}</td>
                    <td className="py-2 pe-3 font-mono text-xs text-negative">{fmtNum(i.total - i.paidAmount)}</td>
                    <td className="py-2"><Badge className={`text-xs ${STATUS_STYLES[i.status] ?? ""}`}>{i.status}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
