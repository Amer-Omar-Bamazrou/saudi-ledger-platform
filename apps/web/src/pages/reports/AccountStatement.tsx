import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, fmtNum, fmtDate } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FileText, Download } from "lucide-react";

interface Category { id: number; name: string; nameAr: string; type: string; }
interface Movement { date: string; entryNumber: string; reference: string | null; description: string; debit: number; credit: number; balance: number; }
interface StatementData { account: Category; openingBalance: number; movements: Movement[]; closingBalance: number; totalDebit: number; totalCredit: number; }

export default function AccountStatement() {
  const thisYear = new Date().getFullYear();
  const [accountId, setAccountId] = useState("");
  const [dateFrom,  setDateFrom]  = useState(`${thisYear}-01-01`);
  const [dateTo,    setDateTo]    = useState(`${thisYear}-12-31`);
  const [applied,   setApplied]   = useState<{ accountId: string; from: string; to: string } | null>(null);

  const { data: cats = [] } = useQuery<Category[]>({
    queryKey: ["categories"],
    queryFn: () => apiFetch("/categories"),
  });

  const { data, isLoading } = useQuery<StatementData>({
    queryKey: ["account-statement", applied],
    queryFn: () => applied
      ? apiFetch(`/reports/account-statement?account_id=${applied.accountId}&date_from=${applied.from}&date_to=${applied.to}`)
      : Promise.reject("no selection"),
    enabled: !!applied,
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Account Statement</h1>
          <p className="text-muted-foreground text-sm mt-1">Opening balance + movements + closing balance for a single account</p>
        </div>
        <Button variant="outline" className="gap-2" disabled={!data}><Download className="w-4 h-4" /> Export</Button>
      </div>

      <Card className="border-border bg-card">
        <CardContent className="pt-4">
          <div className="flex items-end gap-4 flex-wrap">
            <div className="min-w-56">
              <Label className="text-xs text-muted-foreground">Account</Label>
              <Select value={accountId} onValueChange={setAccountId}>
                <SelectTrigger className="mt-1 h-8 text-sm"><SelectValue placeholder="Select account…" /></SelectTrigger>
                <SelectContent>
                  {cats.map(c => (
                    <SelectItem key={c.id} value={String(c.id)}>
                      {c.name} <span className="text-muted-foreground text-xs ml-1">({c.type})</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div><Label className="text-xs text-muted-foreground">From</Label><Input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="mt-1 h-8 text-sm w-40" /></div>
            <div><Label className="text-xs text-muted-foreground">To</Label><Input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="mt-1 h-8 text-sm w-40" /></div>
            <Button size="sm" className="h-8" disabled={!accountId} onClick={() => setApplied({ accountId, from: dateFrom, to: dateTo })}>Generate</Button>
          </div>
        </CardContent>
      </Card>

      {data && (
        <div className="grid grid-cols-4 gap-4">
          {[
            ["Account", data.account.name, "text-primary"],
            ["Opening Balance", fmtNum(data.openingBalance), data.openingBalance >= 0 ? "text-blue-400" : "text-red-400"],
            ["Closing Balance", fmtNum(data.closingBalance), data.closingBalance >= 0 ? "text-emerald-400" : "text-red-400"],
            ["Movements", data.movements.length, "text-primary"],
          ].map(([l, v, c]) => (
            <Card key={String(l)} className="border-border bg-card">
              <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{l}</CardTitle></CardHeader>
              <CardContent><div className={`text-lg font-bold font-mono ${c} truncate`}>{v}</div></CardContent>
            </Card>
          ))}
        </div>
      )}

      {isLoading ? (
        <div className="text-muted-foreground text-sm p-4">Loading…</div>
      ) : !data ? (
        <Card className="border-border bg-card">
          <CardContent className="pt-6">
            <div className="text-center py-16 text-muted-foreground">
              <FileText className="w-8 h-8 mx-auto mb-3 opacity-40" />
              <p className="text-sm">Select an account and click Generate.</p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card className="border-border bg-card">
          <CardContent className="pt-6">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-muted-foreground text-xs uppercase">
                  {["Date", "Entry #", "Reference", "Description", "Debit", "Credit", "Balance"].map(h => (
                    <th key={h} className="text-left pb-2 pr-4 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {/* Opening row */}
                <tr className="border-b border-border/50 bg-secondary/20">
                  <td colSpan={4} className="py-2.5 pr-4 text-xs font-semibold text-muted-foreground">Opening Balance</td>
                  <td className="py-2.5 pr-4" />
                  <td className="py-2.5 pr-4" />
                  <td className="py-2.5 font-mono font-semibold text-xs">{fmtNum(data.openingBalance)}</td>
                </tr>
                {data.movements.map((m, i) => (
                  <tr key={i} className="border-b border-border/30 hover:bg-secondary/10">
                    <td className="py-2 pr-4 text-xs text-muted-foreground">{fmtDate(m.date)}</td>
                    <td className="py-2 pr-4 font-mono text-xs text-primary">{m.entryNumber}</td>
                    <td className="py-2 pr-4 text-xs text-muted-foreground">{m.reference ?? "—"}</td>
                    <td className="py-2 pr-4 text-xs">{m.description}</td>
                    <td className="py-2 pr-4 font-mono text-xs text-blue-400">{m.debit > 0 ? fmtNum(m.debit) : "—"}</td>
                    <td className="py-2 pr-4 font-mono text-xs text-emerald-400">{m.credit > 0 ? fmtNum(m.credit) : "—"}</td>
                    <td className="py-2 font-mono text-xs font-semibold">{fmtNum(m.balance)}</td>
                  </tr>
                ))}
                {/* Closing row */}
                <tr className="border-t-2 border-border font-bold">
                  <td colSpan={4} className="pt-3 text-xs font-semibold">Closing Balance</td>
                  <td className="pt-3 font-mono text-xs text-blue-400">{fmtNum(data.totalDebit)}</td>
                  <td className="pt-3 font-mono text-xs text-emerald-400">{fmtNum(data.totalCredit)}</td>
                  <td className="pt-3 font-mono text-sm font-bold">{fmtNum(data.closingBalance)}</td>
                </tr>
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
