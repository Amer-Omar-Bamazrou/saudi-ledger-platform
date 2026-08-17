import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, fmtNum, fmtDate } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { ClipboardList, Download } from "lucide-react";
import { useReportDefaultRange, type ReportDefaultRange } from "@/hooks/useReportDefaultRange";
import { FiscalRangeNotice, ReportRangeLoading } from "@/components/FiscalRangeNotice";

interface QuoteRow {
  id: number; quoteNumber: string; customerName: string; date: string;
  expiryDate: string; status: string; total: number;
}

const STATUS_STYLES: Record<string, string> = {
  draft: "bg-secondary text-muted-foreground",
  sent: "bg-blue-500/20 text-blue-400",
  accepted: "bg-emerald-500/20 text-emerald-400",
  rejected: "bg-red-500/20 text-red-400",
  expired: "bg-amber-500/20 text-amber-400",
};

export default function QuotationReport() {
  // M20.1 — the report does not mount until its default window is known, so a
  // wrong window (the old hardcoded Jan–Dec) is never queried or rendered,
  // even for a frame.
  const range = useReportDefaultRange();
  if (!range.ready) return <ReportRangeLoading />;
  return <QuotationReportInner range={range} />;
}

function QuotationReportInner({ range }: { range: ReportDefaultRange }) {
  const [from, setFrom] = useState(range.from);
  const [to, setTo] = useState(range.to);

  const { data: quotes = [], isLoading } = useQuery<QuoteRow[]>({
    queryKey: ["quotation-report", from, to],
    queryFn: () => apiFetch<QuoteRow[]>("/quotations").catch(() => [] as QuoteRow[]),
  });

  const filtered = quotes.filter(q => q.date >= from && q.date <= to);
  const accepted = filtered.filter(q => q.status === "accepted");
  const conversionRate = filtered.length > 0 ? Math.round((accepted.length / filtered.length) * 100) : 0;
  const totalAcceptedValue = accepted.reduce((s, q) => s + q.total, 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Quotation Report</h1>
          <p className="text-muted-foreground text-sm mt-1">Quote pipeline, conversion rates, and won value</p>
        </div>
        <Button variant="outline" className="gap-2"><Download className="w-4 h-4" /> Export</Button>
      </div>

      <FiscalRangeNotice source={range.source} />

      <Card className="border-border bg-card">
        <CardContent className="pt-4 pb-4">
          <div className="flex gap-4 items-end">
            <div><Label className="text-xs text-muted-foreground">From</Label>
              <Input type="date" value={from} onChange={e => setFrom(e.target.value)} className="mt-1 h-8 text-sm w-40" /></div>
            <div><Label className="text-xs text-muted-foreground">To</Label>
              <Input type="date" value={to} onChange={e => setTo(e.target.value)} className="mt-1 h-8 text-sm w-40" /></div>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-4 gap-4">
        {[
          ["Total Quotes", filtered.length, "text-primary"],
          ["Accepted", accepted.length, "text-emerald-400"],
          ["Conversion Rate", `${conversionRate}%`, "text-blue-400"],
          ["Won Value", fmtNum(totalAcceptedValue), "text-emerald-400"],
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
              <ClipboardList className="w-8 h-8 mx-auto mb-3 opacity-40" />
              <p className="text-sm">No quotations in this date range.</p>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-muted-foreground text-xs uppercase">
                  {["Quote #", "Customer", "Date", "Expiry", "Total", "Status"].map(h => (
                    <th key={h} className="text-left pb-2 pr-4 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(q => (
                  <tr key={q.id} className="border-b border-border/50 hover:bg-secondary/20">
                    <td className="py-2 pr-4 font-mono text-xs text-primary">{q.quoteNumber}</td>
                    <td className="py-2 pr-4 font-medium text-xs">{q.customerName}</td>
                    <td className="py-2 pr-4 text-muted-foreground text-xs">{fmtDate(q.date)}</td>
                    <td className="py-2 pr-4 text-muted-foreground text-xs">{q.expiryDate ? fmtDate(q.expiryDate) : "—"}</td>
                    <td className="py-2 pr-4 font-mono text-xs font-semibold">{fmtNum(q.total)}</td>
                    <td className="py-2"><Badge className={`text-xs ${STATUS_STYLES[q.status] ?? ""}`}>{q.status}</Badge></td>
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
