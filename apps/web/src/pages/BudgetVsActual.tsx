import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Target, Download } from "lucide-react";
import { cn } from "@/lib/utils";

interface BvaRow {
  category: string; budgeted: number; actual: number; variance: number; variancePct: number;
}

export default function BudgetVsActual() {
  const year = new Date().getFullYear();
  const [period, setPeriod] = useState(`${year}`);

  const { data: rows = [], isLoading } = useQuery<BvaRow[]>({
    queryKey: ["budget-vs-actual", period],
    queryFn: () => apiFetch<BvaRow[]>(`/reports/budget-vs-actual?period=${period}`).catch(() => [] as BvaRow[]),
  });

  const totalBudget = rows.reduce((s, r) => s + r.budgeted, 0);
  const totalActual = rows.reduce((s, r) => s + r.actual, 0);
  const totalVariance = totalBudget - totalActual;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Budget vs Actual</h1>
          <p className="text-muted-foreground text-sm mt-1">Compare planned budgets against actual spending by category</p>
        </div>
        <Button variant="outline" className="gap-2"><Download className="w-4 h-4" /> Export</Button>
      </div>

      <Card className="border-border bg-card">
        <CardContent className="pt-4 pb-4">
          <div className="flex gap-4 items-end">
            <div>
              <Label className="text-xs text-muted-foreground">Period (Year)</Label>
              <Input type="number" value={period} onChange={e => setPeriod(e.target.value)} min={2020} max={2099} className="mt-1 h-8 text-sm w-32" />
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-3 gap-4">
        {[
          ["Total Budget", fmtNum(totalBudget), "text-blue-400"],
          ["Total Actual", fmtNum(totalActual), "text-primary"],
          ["Variance", fmtNum(Math.abs(totalVariance)), totalVariance >= 0 ? "text-emerald-400" : "text-red-400"],
        ].map(([l, v, c]) => (
          <Card key={String(l)} className="border-border bg-card">
            <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{l}</CardTitle></CardHeader>
            <CardContent><div className={`text-2xl font-bold font-mono ${c}`}>{l === "Variance" && totalVariance < 0 ? "-" : ""}{v}</div></CardContent>
          </Card>
        ))}
      </div>

      <Card className="border-border bg-card">
        <CardContent className="pt-6">
          {isLoading ? <div className="text-sm text-muted-foreground p-4">Loading…</div>
          : rows.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground">
              <Target className="w-8 h-8 mx-auto mb-3 opacity-40" />
              <p className="text-sm">No budget data for {period}.</p>
              <p className="text-xs mt-1 opacity-60">Set up budgets in Planning to compare against actuals.</p>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-muted-foreground text-xs uppercase">
                  {["Category", "Budgeted", "Actual", "Variance", "% Used", "Status"].map(h => (
                    <th key={h} className="text-left pb-2 pr-4 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map(r => {
                  const usedPct = r.budgeted > 0 ? Math.min((r.actual / r.budgeted) * 100, 100) : 0;
                  const over = r.actual > r.budgeted;
                  return (
                    <tr key={r.category} className="border-b border-border/50 hover:bg-secondary/20">
                      <td className="py-3 pr-4 font-medium">{r.category}</td>
                      <td className="py-3 pr-4 font-mono text-blue-400">{fmtNum(r.budgeted)}</td>
                      <td className="py-3 pr-4 font-mono">{fmtNum(r.actual)}</td>
                      <td className={cn("py-3 pr-4 font-mono font-semibold", r.variance >= 0 ? "text-emerald-400" : "text-red-400")}>
                        {r.variance >= 0 ? "+" : ""}{fmtNum(r.variance)}
                      </td>
                      <td className="py-3 pr-4">
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 bg-border rounded-full w-20 overflow-hidden">
                            <div className={cn("h-full rounded-full", over ? "bg-red-500" : "bg-primary")} style={{ width: `${usedPct}%` }} />
                          </div>
                          <span className="text-xs text-muted-foreground">{usedPct.toFixed(0)}%</span>
                        </div>
                      </td>
                      <td className="py-3">
                        <span className={cn("text-xs font-semibold", over ? "text-red-400" : "text-emerald-400")}>
                          {over ? "Over budget" : "On track"}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
