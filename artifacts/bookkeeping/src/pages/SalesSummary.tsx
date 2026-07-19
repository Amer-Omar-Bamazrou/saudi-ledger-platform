import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ShoppingBag, Download } from "lucide-react";

interface SalesSummaryRow {
  month: string; invoiceCount: number; subtotal: number; vat: number; total: number; collected: number; outstanding: number;
}

export default function SalesSummary() {
  const year = new Date().getFullYear();
  const [from, setFrom] = useState(`${year}-01-01`);
  const [to, setTo] = useState(`${year}-12-31`);

  const { data: rows = [], isLoading } = useQuery<SalesSummaryRow[]>({
    queryKey: ["sales-summary", from, to],
    queryFn: () => apiFetch(`/reports/sales-summary?from=${from}&to=${to}`).catch(() => []),
  });

  const totals = rows.reduce(
    (a, r) => ({ invoices: a.invoices + r.invoiceCount, revenue: a.revenue + r.subtotal, vat: a.vat + r.vat, total: a.total + r.total, collected: a.collected + r.collected, outstanding: a.outstanding + r.outstanding }),
    { invoices: 0, revenue: 0, vat: 0, total: 0, collected: 0, outstanding: 0 }
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Sales Summary</h1>
          <p className="text-muted-foreground text-sm mt-1">Revenue by period — invoices, collections, and outstanding</p>
        </div>
        <Button variant="outline" className="gap-2"><Download className="w-4 h-4" /> Export</Button>
      </div>

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
          ["Total Revenue", fmtNum(totals.revenue), "text-primary"],
          ["VAT Collected", fmtNum(totals.vat), "text-amber-400"],
          ["Amount Collected", fmtNum(totals.collected), "text-emerald-400"],
          ["Outstanding", fmtNum(totals.outstanding), "text-red-400"],
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
          : rows.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground">
              <ShoppingBag className="w-8 h-8 mx-auto mb-3 opacity-40" />
              <p className="text-sm">No sales data for this period.</p>
              <p className="text-xs mt-1 opacity-60">Create invoices to see the summary here.</p>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-muted-foreground text-xs uppercase">
                  {["Period", "Invoices", "Subtotal", "VAT", "Total", "Collected", "Outstanding"].map(h => (
                    <th key={h} className="text-left pb-2 pr-4 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.month} className="border-b border-border/50 hover:bg-secondary/20">
                    <td className="py-3 pr-4 font-medium">{r.month}</td>
                    <td className="py-3 pr-4 font-mono">{r.invoiceCount}</td>
                    <td className="py-3 pr-4 font-mono">{fmtNum(r.subtotal)}</td>
                    <td className="py-3 pr-4 font-mono text-amber-400">{fmtNum(r.vat)}</td>
                    <td className="py-3 pr-4 font-mono font-semibold">{fmtNum(r.total)}</td>
                    <td className="py-3 pr-4 font-mono text-emerald-400">{fmtNum(r.collected)}</td>
                    <td className="py-3 font-mono text-red-400">{fmtNum(r.outstanding)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-border font-semibold">
                  <td className="pt-3 text-xs text-muted-foreground">Total</td>
                  <td className="pt-3 font-mono text-xs">{totals.invoices}</td>
                  <td className="pt-3 font-mono text-xs">{fmtNum(totals.revenue)}</td>
                  <td className="pt-3 font-mono text-xs text-amber-400">{fmtNum(totals.vat)}</td>
                  <td className="pt-3 font-mono text-xs">{fmtNum(totals.total)}</td>
                  <td className="pt-3 font-mono text-xs text-emerald-400">{fmtNum(totals.collected)}</td>
                  <td className="pt-3 font-mono text-xs text-red-400">{fmtNum(totals.outstanding)}</td>
                </tr>
              </tfoot>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
