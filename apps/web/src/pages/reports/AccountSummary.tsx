import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Scale, Download } from "lucide-react";
import { cn } from "@/lib/utils";

interface AccountSummaryRow {
  name: string; type: string;
  openingBalance: number; periodDebit: number; periodCredit: number; closingBalance: number;
}
interface AccountSummaryData { accounts: AccountSummaryRow[]; count: number; }

const TYPE_COLOR: Record<string, string> = { income: "text-emerald-400", expense: "text-red-400", asset: "text-blue-400", liability: "text-amber-400", equity: "text-purple-400" };

export default function AccountSummary() {
  const thisYear = new Date().getFullYear();
  const [dateFrom, setDateFrom] = useState(`${thisYear}-01-01`);
  const [dateTo,   setDateTo]   = useState(`${thisYear}-12-31`);
  const [applied,  setApplied]  = useState({ from: `${thisYear}-01-01`, to: `${thisYear}-12-31` });

  const { data, isLoading } = useQuery<AccountSummaryData>({
    queryKey: ["account-summary", applied.from, applied.to],
    queryFn: () => apiFetch(`/reports/account-summary?date_from=${applied.from}&date_to=${applied.to}`),
  });

  const byType = data ? data.accounts.reduce((acc, r) => {
    if (!acc[r.type]) acc[r.type] = [];
    acc[r.type].push(r);
    return acc;
  }, {} as Record<string, AccountSummaryRow[]>) : {};

  const typeOrder = ["asset", "liability", "equity", "income", "expense"];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Account Summary</h1>
          <p className="text-muted-foreground text-sm mt-1">Opening balance, period movements, and closing balance for every account</p>
        </div>
        <Button variant="outline" className="gap-2"><Download className="w-4 h-4" /> Export</Button>
      </div>

      <Card className="border-border bg-card">
        <CardContent className="pt-4">
          <div className="flex items-end gap-4">
            <div><Label className="text-xs text-muted-foreground">From</Label><Input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="mt-1 h-8 text-sm w-40" /></div>
            <div><Label className="text-xs text-muted-foreground">To</Label><Input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="mt-1 h-8 text-sm w-40" /></div>
            <Button size="sm" className="h-8" onClick={() => setApplied({ from: dateFrom, to: dateTo })}>Generate</Button>
          </div>
        </CardContent>
      </Card>

      {isLoading ? (
        <div className="text-sm text-muted-foreground p-4">Loading…</div>
      ) : !data || data.accounts.length === 0 ? (
        <Card className="border-border bg-card">
          <CardContent className="pt-6">
            <div className="text-center py-16 text-muted-foreground">
              <Scale className="w-8 h-8 mx-auto mb-3 opacity-40" />
              <p className="text-sm">No account data for this period.</p>
              <p className="text-xs mt-1 opacity-60">Post journal entries to see account summaries.</p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card className="border-border bg-card">
          <CardContent className="pt-6">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-muted-foreground text-xs uppercase">
                  {["Account", "Type", "Opening Balance", "Period Debits", "Period Credits", "Closing Balance"].map(h => (
                    <th key={h} className="text-left pb-3 pr-4 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {typeOrder.filter(t => byType[t]?.length > 0).map(type => (
                  <>
                    <tr key={`hdr-${type}`} className="bg-secondary/20">
                      <td colSpan={6} className={cn("py-2 px-2 text-xs font-bold uppercase tracking-widest", TYPE_COLOR[type] ?? "text-muted-foreground")}>{type}</td>
                    </tr>
                    {byType[type].map((r, i) => (
                      <tr key={i} className="border-b border-border/30 hover:bg-secondary/10">
                        <td className="py-2.5 pr-4 pl-4 text-foreground text-sm">{r.name}</td>
                        <td className="py-2.5 pr-4"><Badge variant="outline" className={cn("text-xs capitalize border-0 px-0", TYPE_COLOR[r.type] ?? "")}>{r.type}</Badge></td>
                        <td className="py-2.5 pr-4 font-mono text-xs">{fmtNum(r.openingBalance)}</td>
                        <td className="py-2.5 pr-4 font-mono text-xs text-blue-400">{r.periodDebit > 0 ? fmtNum(r.periodDebit) : "—"}</td>
                        <td className="py-2.5 pr-4 font-mono text-xs text-emerald-400">{r.periodCredit > 0 ? fmtNum(r.periodCredit) : "—"}</td>
                        <td className={cn("py-2.5 font-mono text-xs font-semibold", r.closingBalance < 0 ? "text-red-400" : "")}>{fmtNum(r.closingBalance)}</td>
                      </tr>
                    ))}
                    <tr key={`sub-${type}`} className="border-b-2 border-border/50">
                      <td className="py-2 pl-4 text-xs text-muted-foreground" colSpan={2}>Subtotal — {type}</td>
                      <td className="py-2 font-mono text-xs pr-4">{fmtNum(byType[type].reduce((s, r) => s + r.openingBalance, 0))}</td>
                      <td className="py-2 font-mono text-xs pr-4 text-blue-400">{fmtNum(byType[type].reduce((s, r) => s + r.periodDebit, 0))}</td>
                      <td className="py-2 font-mono text-xs pr-4 text-emerald-400">{fmtNum(byType[type].reduce((s, r) => s + r.periodCredit, 0))}</td>
                      <td className="py-2 font-mono text-xs font-bold">{fmtNum(byType[type].reduce((s, r) => s + r.closingBalance, 0))}</td>
                    </tr>
                  </>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
