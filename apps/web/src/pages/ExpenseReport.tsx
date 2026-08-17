import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, fmtNum, fmtDate } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PieChart, Download } from "lucide-react";
import { useReportDefaultRange, type ReportDefaultRange } from "@/hooks/useReportDefaultRange";
import { FiscalRangeNotice, ReportRangeLoading } from "@/components/FiscalRangeNotice";
import { PeriodShortcuts } from "@/components/PeriodShortcuts";

interface ExpenseRow {
  category: string; count: number; subtotal: number; vat: number; total: number; percentage: number;
}

export default function ExpenseReport() {
  // M20.1 — the report does not mount until its default window is known, so a
  // wrong window (the old hardcoded Jan–Dec) is never queried or rendered,
  // even for a frame.
  const range = useReportDefaultRange();
  if (!range.ready) return <ReportRangeLoading />;
  return <ExpenseReportInner range={range} />;
}

function ExpenseReportInner({ range }: { range: ReportDefaultRange }) {
  const [from, setFrom] = useState(range.from);
  const [to, setTo] = useState(range.to);

  const { data: rows = [], isLoading } = useQuery<ExpenseRow[]>({
    queryKey: ["expense-report", from, to],
    queryFn: () => apiFetch<ExpenseRow[]>(`/reports/expenses?from=${from}&to=${to}`).catch(() => [] as ExpenseRow[]),
  });

  const totalExpenses = rows.reduce((s, r) => s + r.subtotal, 0);
  const totalVat = rows.reduce((s, r) => s + r.vat, 0);
  const totalWithVat = rows.reduce((s, r) => s + r.total, 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Expense Report</h1>
          <p className="text-muted-foreground text-sm mt-1">All costs grouped by category — bills, simple bills, and payroll</p>
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
          <div className="mt-3">
            <PeriodShortcuts from={from} to={to} onSelect={(r)=>{setFrom(r.from);setTo(r.to);}} />
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-3 gap-4">
        {[
          ["Total Expenses", fmtNum(totalExpenses), "text-red-400"],
          ["VAT Paid", fmtNum(totalVat), "text-amber-400"],
          ["Total (incl. VAT)", fmtNum(totalWithVat), "text-red-400"],
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
              <PieChart className="w-8 h-8 mx-auto mb-3 opacity-40" />
              <p className="text-sm">No expense data for this period.</p>
              <p className="text-xs mt-1 opacity-60">Post bills or simple bills to see them here.</p>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-muted-foreground text-xs uppercase">
                  {["Category", "Transactions", "Subtotal", "VAT", "Total", "% of Expenses"].map(h => (
                    <th key={h} className="text-left pb-2 pr-4 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.category} className="border-b border-border/50 hover:bg-secondary/20">
                    <td className="py-3 pr-4 font-medium">{r.category}</td>
                    <td className="py-3 pr-4 font-mono">{r.count}</td>
                    <td className="py-3 pr-4 font-mono">{fmtNum(r.subtotal)}</td>
                    <td className="py-3 pr-4 font-mono text-amber-400">{fmtNum(r.vat)}</td>
                    <td className="py-3 pr-4 font-mono font-semibold text-red-400">{fmtNum(r.total)}</td>
                    <td className="py-3">
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 bg-border rounded-full w-24 overflow-hidden">
                          <div className="h-full bg-primary rounded-full" style={{ width: `${r.percentage}%` }} />
                        </div>
                        <span className="text-xs text-muted-foreground">{r.percentage.toFixed(1)}%</span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-border font-semibold">
                  <td className="pt-3 text-xs text-muted-foreground">Total</td>
                  <td className="pt-3 font-mono text-xs">{rows.reduce((s, r) => s + r.count, 0)}</td>
                  <td className="pt-3 font-mono text-xs">{fmtNum(totalExpenses)}</td>
                  <td className="pt-3 font-mono text-xs text-amber-400">{fmtNum(totalVat)}</td>
                  <td className="pt-3 font-mono text-xs text-red-400">{fmtNum(totalWithVat)}</td>
                  <td className="pt-3 font-mono text-xs">100%</td>
                </tr>
              </tfoot>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
