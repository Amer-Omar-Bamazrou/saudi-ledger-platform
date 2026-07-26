import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, fmtNum, fmtDate } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Users, Download } from "lucide-react";

interface Customer { id: number; name: string; }
interface StatementRow {
  date: string; reference: string; type: string; description: string;
  debit: number; credit: number; balance: number;
}

const TYPE_STYLES: Record<string, string> = {
  invoice: "bg-blue-500/20 text-blue-400",
  receipt: "bg-emerald-500/20 text-emerald-400",
  "credit note": "bg-red-500/20 text-red-400",
};

export default function CustomerStatement() {
  const today = new Date().toISOString().split("T")[0];
  const firstOfYear = `${new Date().getFullYear()}-01-01`;
  const [customerId, setCustomerId] = useState("");
  const [from, setFrom] = useState(firstOfYear);
  const [to, setTo] = useState(today);

  const { data: customers = [] } = useQuery<Customer[]>({
    queryKey: ["customers"],
    queryFn: () => apiFetch("/customers"),
  });

  const { data: rows = [], isLoading } = useQuery<StatementRow[]>({
    queryKey: ["customer-statement", customerId, from, to],
    queryFn: () => customerId
      ? apiFetch<StatementRow[]>(`/reports/customer-statement?customerId=${customerId}&from=${from}&to=${to}`).catch(() => [] as StatementRow[])
      : Promise.resolve([] as StatementRow[]),
    enabled: !!customerId,
  });

  const openingBalance = 0;
  const closingBalance = rows.length > 0 ? rows[rows.length - 1].balance : 0;
  const selectedCustomer = customers.find(c => String(c.id) === customerId);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Customer Statement</h1>
          <p className="text-muted-foreground text-sm mt-1">Full transaction history for a single customer</p>
        </div>
        <Button variant="outline" className="gap-2" disabled={!customerId}><Download className="w-4 h-4" /> Export PDF</Button>
      </div>

      <Card className="border-border bg-card">
        <CardContent className="pt-4 pb-4">
          <div className="flex gap-4 items-end flex-wrap">
            <div>
              <Label className="text-xs text-muted-foreground">Customer</Label>
              <Select value={customerId} onValueChange={setCustomerId}>
                <SelectTrigger className="mt-1 h-8 text-sm w-56"><SelectValue placeholder="Select customer…" /></SelectTrigger>
                <SelectContent>
                  {customers.map(c => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div><Label className="text-xs text-muted-foreground">From</Label>
              <Input type="date" value={from} onChange={e => setFrom(e.target.value)} className="mt-1 h-8 text-sm w-40" /></div>
            <div><Label className="text-xs text-muted-foreground">To</Label>
              <Input type="date" value={to} onChange={e => setTo(e.target.value)} className="mt-1 h-8 text-sm w-40" /></div>
          </div>
        </CardContent>
      </Card>

      {selectedCustomer && (
        <div className="grid grid-cols-3 gap-4">
          {[
            ["Opening Balance", fmtNum(openingBalance), "text-primary"],
            ["Transactions", rows.length, "text-primary"],
            ["Closing Balance", fmtNum(closingBalance), closingBalance > 0 ? "text-red-400" : "text-emerald-400"],
          ].map(([l, v, c]) => (
            <Card key={String(l)} className="border-border bg-card">
              <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{l}</CardTitle></CardHeader>
              <CardContent><div className={`text-2xl font-bold font-mono ${c}`}>{v}</div></CardContent>
            </Card>
          ))}
        </div>
      )}

      <Card className="border-border bg-card">
        <CardContent className="pt-6">
          {!customerId ? (
            <div className="text-center py-16 text-muted-foreground">
              <Users className="w-8 h-8 mx-auto mb-3 opacity-40" />
              <p className="text-sm">Select a customer to view their statement.</p>
            </div>
          ) : isLoading ? <div className="text-sm text-muted-foreground p-4">Loading…</div>
          : rows.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground">
              <Users className="w-8 h-8 mx-auto mb-3 opacity-40" />
              <p className="text-sm">No transactions for {selectedCustomer?.name} in this period.</p>
            </div>
          ) : (
            <>
              {selectedCustomer && (
                <div className="mb-4 text-sm font-semibold text-foreground">{selectedCustomer.name} — Statement {fmtDate(from)} to {fmtDate(to)}</div>
              )}
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-muted-foreground text-xs uppercase">
                    {["Date", "Reference", "Type", "Description", "Debit", "Credit", "Balance"].map(h => (
                      <th key={h} className="text-left pb-2 pr-4 font-medium">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i} className="border-b border-border/50 hover:bg-secondary/20">
                      <td className="py-2 pr-4 text-xs text-muted-foreground">{fmtDate(r.date)}</td>
                      <td className="py-2 pr-4 font-mono text-xs text-primary">{r.reference}</td>
                      <td className="py-2 pr-4"><Badge className={`text-xs ${TYPE_STYLES[r.type] ?? ""}`}>{r.type}</Badge></td>
                      <td className="py-2 pr-4 text-xs text-muted-foreground">{r.description}</td>
                      <td className="py-2 pr-4 font-mono text-xs text-blue-400">{r.debit > 0 ? fmtNum(r.debit) : "—"}</td>
                      <td className="py-2 pr-4 font-mono text-xs text-emerald-400">{r.credit > 0 ? fmtNum(r.credit) : "—"}</td>
                      <td className="py-2 font-mono text-xs font-semibold">{fmtNum(r.balance)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
