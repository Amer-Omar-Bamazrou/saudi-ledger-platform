import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { CheckCircle, XCircle, Scale } from "lucide-react";

interface TrialBalanceRow { id: number | null; name: string; nameAr: string; type: string; debit: number; credit: number; balance: number; }
interface TrialBalanceData { accounts: TrialBalanceRow[]; totalDebit: number; totalCredit: number; balanced: boolean; }

const TYPE_STYLES: Record<string, string> = { income: "text-emerald-400", expense: "text-red-400", asset: "text-blue-400", liability: "text-amber-400", equity: "text-purple-400" };

export default function TrialBalance() {
  const thisYear = new Date().getFullYear();
  const [dateFrom, setDateFrom] = useState(`${thisYear}-01-01`);
  const [dateTo, setDateTo] = useState(`${thisYear}-12-31`);
  const [applied, setApplied] = useState({ from: `${thisYear}-01-01`, to: `${thisYear}-12-31` });

  const { data, isLoading } = useQuery<TrialBalanceData>({
    queryKey: ["trial-balance", applied.from, applied.to],
    queryFn: () => apiFetch(`/reports/trial-balance?date_from=${applied.from}&date_to=${applied.to}`),
  });

  const byType = data ? data.accounts.reduce((acc, row) => {
    const t = row.type;
    if (!acc[t]) acc[t] = [];
    acc[t].push(row);
    return acc;
  }, {} as Record<string, TrialBalanceRow[]>) : {};

  const typeOrder = ["income", "expense", "asset", "liability", "equity"];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Trial Balance</h1>
          <p className="text-muted-foreground text-sm mt-1">All ledger account balances — debits must equal credits</p>
        </div>
      </div>

      <Card className="border-border bg-card">
        <CardContent className="pt-4">
          <div className="flex items-end gap-4">
            <div><Label className="text-xs text-muted-foreground">From</Label><Input type="date" value={dateFrom} onChange={e=>setDateFrom(e.target.value)} className="mt-1 h-8 text-sm w-40" /></div>
            <div><Label className="text-xs text-muted-foreground">To</Label><Input type="date" value={dateTo} onChange={e=>setDateTo(e.target.value)} className="mt-1 h-8 text-sm w-40" /></div>
            <Button size="sm" className="h-8" onClick={()=>setApplied({from:dateFrom,to:dateTo})}>Apply</Button>
            {data && (
              <div className={`flex items-center gap-2 ml-auto px-4 py-2 rounded-lg border ${data.balanced ? "border-emerald-500/30 bg-emerald-500/10" : "border-red-500/30 bg-red-500/10"}`}>
                {data.balanced ? <CheckCircle className="w-4 h-4 text-emerald-400" /> : <XCircle className="w-4 h-4 text-red-400" />}
                <span className={`text-sm font-medium ${data.balanced ? "text-emerald-400" : "text-red-400"}`}>{data.balanced ? "Balanced" : "Out of Balance"}</span>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {isLoading ? <div className="text-muted-foreground text-sm p-4">Loading trial balance...</div> : !data ? null : (
        <Card className="border-border bg-card">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm text-muted-foreground uppercase tracking-wide">Trial Balance — {applied.from} to {applied.to}</CardTitle>
            </div>
          </CardHeader>
          <CardContent>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-muted-foreground text-xs uppercase">
                  <th className="text-left pb-3 pr-4 font-medium">Account</th>
                  <th className="text-left pb-3 pr-4 font-medium">Type</th>
                  <th className="text-right pb-3 pr-4 font-medium">Debit (SAR)</th>
                  <th className="text-right pb-3 font-medium">Credit (SAR)</th>
                </tr>
              </thead>
              <tbody>
                {typeOrder.filter(t => byType[t]?.length > 0).map(type => (
                  <>
                    <tr key={`header-${type}`} className="bg-secondary/20">
                      <td colSpan={4} className={`py-2 px-2 text-xs font-bold uppercase tracking-widest ${TYPE_STYLES[type] ?? "text-muted-foreground"}`}>{type}</td>
                    </tr>
                    {byType[type].map(row => (
                      <tr key={row.id} className="border-b border-border/30 hover:bg-secondary/10">
                        <td className="py-2.5 pr-4 pl-2">
                          <span className="text-foreground">{row.name}</span>
                          {row.nameAr && <span className="text-muted-foreground text-xs ml-2" dir="rtl">{row.nameAr}</span>}
                        </td>
                        <td className="py-2.5 pr-4"><Badge variant="outline" className={`text-xs capitalize border-0 px-0 ${TYPE_STYLES[row.type]??""}`}>{row.type}</Badge></td>
                        <td className="py-2.5 pr-4 text-right font-mono text-sm">{row.debit > 0 ? fmtNum(row.debit) : <span className="text-muted-foreground">—</span>}</td>
                        <td className="py-2.5 text-right font-mono text-sm">{row.credit > 0 ? fmtNum(row.credit) : <span className="text-muted-foreground">—</span>}</td>
                      </tr>
                    ))}
                    <tr key={`subtotal-${type}`} className="border-b-2 border-border">
                      <td className="py-2 pl-2 text-xs text-muted-foreground">Subtotal — {type}</td>
                      <td />
                      <td className="py-2 pr-4 text-right font-mono text-xs font-semibold text-foreground">{fmtNum(byType[type].reduce((s,r)=>s+r.debit,0))}</td>
                      <td className="py-2 text-right font-mono text-xs font-semibold text-foreground">{fmtNum(byType[type].reduce((s,r)=>s+r.credit,0))}</td>
                    </tr>
                  </>
                ))}
              </tbody>
              <tfoot>
                <tr className={`font-bold text-sm ${data.balanced ? "text-emerald-400" : "text-red-400"}`}>
                  <td className="py-4 pr-4 pl-2 uppercase tracking-wide">Total</td>
                  <td />
                  <td className="py-4 pr-4 text-right font-mono text-base">{fmtNum(data.totalDebit)}</td>
                  <td className="py-4 text-right font-mono text-base">{fmtNum(data.totalCredit)}</td>
                </tr>
              </tfoot>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
