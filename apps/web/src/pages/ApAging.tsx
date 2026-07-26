import { useQuery } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Building2, Download } from "lucide-react";

interface ApAgingRow {
  vendorId: number; vendorName: string;
  current: number; days1_30: number; days31_60: number; days61_90: number; over90: number; total: number;
}

export default function ApAging() {
  const { data: rows = [], isLoading } = useQuery<ApAgingRow[]>({
    queryKey: ["ap-aging"],
    queryFn: () => apiFetch<ApAgingRow[]>("/reports/ap-aging").catch(() => [] as ApAgingRow[]),
  });

  const totals = rows.reduce(
    (a, r) => ({ current: a.current + r.current, d1: a.d1 + r.days1_30, d31: a.d31 + r.days31_60, d61: a.d61 + r.days61_90, d91: a.d91 + r.over90, total: a.total + r.total }),
    { current: 0, d1: 0, d31: 0, d61: 0, d91: 0, total: 0 }
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">AP Aging</h1>
          <p className="text-muted-foreground text-sm mt-1">Accounts Payable aging — overdue bills by vendor</p>
        </div>
        <Button variant="outline" className="gap-2"><Download className="w-4 h-4" /> Export</Button>
      </div>

      <div className="grid grid-cols-5 gap-3">
        {[
          ["Current", fmtNum(totals.current), "text-emerald-400"],
          ["1–30 Days", fmtNum(totals.d1), "text-amber-400"],
          ["31–60 Days", fmtNum(totals.d31), "text-orange-400"],
          ["61–90 Days", fmtNum(totals.d61), "text-red-400"],
          ["Over 90", fmtNum(totals.d91), "text-red-600"],
        ].map(([l, v, c]) => (
          <Card key={String(l)} className="border-border bg-card">
            <CardHeader className="pb-2"><CardTitle className="text-xs text-muted-foreground">{l}</CardTitle></CardHeader>
            <CardContent><div className={`text-xl font-bold font-mono ${c}`}>{v}</div></CardContent>
          </Card>
        ))}
      </div>

      <Card className="border-border bg-card">
        <CardContent className="pt-6">
          {isLoading ? <div className="text-sm text-muted-foreground p-4">Loading…</div>
          : rows.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground">
              <Building2 className="w-8 h-8 mx-auto mb-3 opacity-40" />
              <p className="text-sm">No outstanding payables.</p>
              <p className="text-xs mt-1 opacity-60">All bills are paid or no bills have been created.</p>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-muted-foreground text-xs uppercase">
                  {["Vendor", "Current", "1–30 Days", "31–60 Days", "61–90 Days", "Over 90", "Total"].map(h => (
                    <th key={h} className="text-left pb-2 pr-4 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.vendorId} className="border-b border-border/50 hover:bg-secondary/20">
                    <td className="py-3 pr-4 font-medium">{r.vendorName}</td>
                    <td className="py-3 pr-4 font-mono text-emerald-400">{fmtNum(r.current)}</td>
                    <td className="py-3 pr-4 font-mono text-amber-400">{fmtNum(r.days1_30)}</td>
                    <td className="py-3 pr-4 font-mono text-orange-400">{fmtNum(r.days31_60)}</td>
                    <td className="py-3 pr-4 font-mono text-red-400">{fmtNum(r.days61_90)}</td>
                    <td className="py-3 pr-4 font-mono text-red-600">{fmtNum(r.over90)}</td>
                    <td className="py-3 font-mono font-semibold">{fmtNum(r.total)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-border font-semibold">
                  <td className="pt-3 text-xs text-muted-foreground">Total</td>
                  <td className="pt-3 font-mono text-xs text-emerald-400">{fmtNum(totals.current)}</td>
                  <td className="pt-3 font-mono text-xs text-amber-400">{fmtNum(totals.d1)}</td>
                  <td className="pt-3 font-mono text-xs text-orange-400">{fmtNum(totals.d31)}</td>
                  <td className="pt-3 font-mono text-xs text-red-400">{fmtNum(totals.d61)}</td>
                  <td className="pt-3 font-mono text-xs text-red-600">{fmtNum(totals.d91)}</td>
                  <td className="pt-3 font-mono text-xs font-bold">{fmtNum(totals.total)}</td>
                </tr>
              </tfoot>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
