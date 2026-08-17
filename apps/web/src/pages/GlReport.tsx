import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, fmtNum, fmtDate } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BookOpen, Download } from "lucide-react";
import { PeriodShortcuts } from "@/components/PeriodShortcuts";

interface GlEntry {
  id: number; date: string; journalNumber: string; description: string;
  accountCode: string; accountName: string; debit: number; credit: number; balance: number;
}

export default function GlReport() {
  const today = new Date();
  const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().split("T")[0];
  const [from, setFrom] = useState(firstOfMonth);
  const [to, setTo] = useState(today.toISOString().split("T")[0]);

  const { data: entries = [], isLoading } = useQuery<GlEntry[]>({
    queryKey: ["gl-report", from, to],
    queryFn: () => apiFetch<GlEntry[]>(`/reports/gl?from=${from}&to=${to}`).catch(() => [] as GlEntry[]),
  });

  const totalDebit = entries.reduce((s, e) => s + e.debit, 0);
  const totalCredit = entries.reduce((s, e) => s + e.credit, 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">General Ledger Report</h1>
          <p className="text-muted-foreground text-sm mt-1">All posted transactions across every account</p>
        </div>
        <Button variant="outline" className="gap-2"><Download className="w-4 h-4" /> Export</Button>
      </div>

      {/* Date filter */}
      <Card className="border-border bg-card">
        <CardContent className="pt-4 pb-4">
          <div className="flex gap-4 items-end">
            <div>
              <Label className="text-xs text-muted-foreground">From</Label>
              <Input type="date" value={from} onChange={e => setFrom(e.target.value)} className="mt-1 h-8 text-sm w-40" />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">To</Label>
              <Input type="date" value={to} onChange={e => setTo(e.target.value)} className="mt-1 h-8 text-sm w-40" />
            </div>
          </div>
          <div className="mt-3">
            <PeriodShortcuts from={from} to={to} onSelect={(r)=>{setFrom(r.from);setTo(r.to);}} />
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-3 gap-4">
        {[
          ["Total Entries", entries.length, "text-primary"],
          ["Total Debits", fmtNum(totalDebit), "text-blue-400"],
          ["Total Credits", fmtNum(totalCredit), "text-emerald-400"],
        ].map(([l, v, c]) => (
          <Card key={String(l)} className="border-border bg-card">
            <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{l}</CardTitle></CardHeader>
            <CardContent><div className={`text-2xl font-bold font-mono ${c}`}>{v}</div></CardContent>
          </Card>
        ))}
      </div>

      <Card className="border-border bg-card">
        <CardContent className="pt-6">
          {isLoading ? (
            <div className="text-sm text-muted-foreground p-4">Loading…</div>
          ) : entries.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground">
              <BookOpen className="w-8 h-8 mx-auto mb-3 opacity-40" />
              <p className="text-sm">No ledger entries for this period.</p>
              <p className="text-xs mt-1 opacity-60">Post journal entries to see them here.</p>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-muted-foreground text-xs uppercase">
                  {["Date", "Journal #", "Account", "Description", "Debit", "Credit", "Balance"].map(h => (
                    <th key={h} className="text-left pb-2 pr-4 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {entries.map(e => (
                  <tr key={e.id} className="border-b border-border/50 hover:bg-secondary/20">
                    <td className="py-2 pr-4 text-xs text-muted-foreground">{fmtDate(e.date)}</td>
                    <td className="py-2 pr-4 font-mono text-xs text-primary">{e.journalNumber}</td>
                    <td className="py-2 pr-4 text-xs">{e.accountCode} · {e.accountName}</td>
                    <td className="py-2 pr-4 text-xs text-muted-foreground">{e.description}</td>
                    <td className="py-2 pr-4 font-mono text-xs text-blue-400">{e.debit > 0 ? fmtNum(e.debit) : "—"}</td>
                    <td className="py-2 pr-4 font-mono text-xs text-emerald-400">{e.credit > 0 ? fmtNum(e.credit) : "—"}</td>
                    <td className="py-2 font-mono text-xs font-semibold">{fmtNum(e.balance)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-border font-semibold">
                  <td colSpan={4} className="pt-3 text-xs text-muted-foreground">Totals</td>
                  <td className="pt-3 font-mono text-xs text-blue-400">{fmtNum(totalDebit)}</td>
                  <td className="pt-3 font-mono text-xs text-emerald-400">{fmtNum(totalCredit)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
