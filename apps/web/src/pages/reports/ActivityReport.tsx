import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Activity, Download } from "lucide-react";
import { PeriodShortcuts } from "@/components/PeriodShortcuts";
import { DualDate } from "@/components/DualDate";

interface ActivityRow { id: number; entryNumber: string; date: string; description: string; reference: string | null; status: string; lineCount: number; totalDebit: number; accounts: string[]; }
interface ActivityData { activities: ActivityRow[]; count: number; hasPosted: number; hasDraft: number; }

const STATUS_STYLES: Record<string, string> = { posted: "bg-emerald-500/20 text-emerald-400", draft: "bg-secondary text-muted-foreground", reversed: "bg-red-500/20 text-red-400" };

export default function ActivityReport() {
  const today = new Date().toISOString().split("T")[0];
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().split("T")[0];
  const [dateFrom, setDateFrom] = useState(thirtyDaysAgo);
  const [dateTo,   setDateTo]   = useState(today);
  const [applied,  setApplied]  = useState({ from: thirtyDaysAgo, to: today });

  const { data, isLoading } = useQuery<ActivityData>({
    queryKey: ["activity-report", applied.from, applied.to],
    queryFn: () => apiFetch(`/reports/activity?date_from=${applied.from}&date_to=${applied.to}`),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Activity Report</h1>
          <p className="text-muted-foreground text-sm mt-1">All journal entry activity — posted, draft, and reversed</p>
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
          <div className="mt-3">
            <PeriodShortcuts from={dateFrom} to={dateTo} onSelect={(r)=>{setDateFrom(r.from);setDateTo(r.to);setApplied(r);}} />
          </div>
        </CardContent>
      </Card>

      {data && (
        <div className="grid grid-cols-3 gap-4">
          {[
            ["Total Entries", data.count, "text-primary"],
            ["Posted", data.hasPosted, "text-emerald-400"],
            ["Draft", data.hasDraft, "text-muted-foreground"],
          ].map(([l, v, c]) => (
            <Card key={String(l)} className="border-border bg-card">
              <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{l}</CardTitle></CardHeader>
              <CardContent><div className={`text-2xl font-bold font-mono ${c}`}>{v}</div></CardContent>
            </Card>
          ))}
        </div>
      )}

      {isLoading ? (
        <div className="text-sm text-muted-foreground p-4">Loading…</div>
      ) : !data || data.activities.length === 0 ? (
        <Card className="border-border bg-card">
          <CardContent className="pt-6">
            <div className="text-center py-16 text-muted-foreground">
              <Activity className="w-8 h-8 mx-auto mb-3 opacity-40" />
              <p className="text-sm">No journal activity in this period.</p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card className="border-border bg-card">
          <CardContent className="pt-6">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-muted-foreground text-xs uppercase">
                  {["Entry #", "Date", "Description", "Reference", "Lines", "Total", "Accounts", "Status"].map(h => (
                    <th key={h} className="text-left pb-2.5 pr-4 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.activities.map(a => (
                  <tr key={a.id} className="border-b border-border/30 hover:bg-secondary/10">
                    <td className="py-2.5 pr-4 font-mono text-xs text-primary">{a.entryNumber}</td>
                    <td className="py-2.5 pr-4 text-xs text-muted-foreground whitespace-nowrap"><DualDate date={a.date} /></td>
                    <td className="py-2.5 pr-4 text-xs max-w-48 truncate">{a.description}</td>
                    <td className="py-2.5 pr-4 text-xs text-muted-foreground">{a.reference ?? "—"}</td>
                    <td className="py-2.5 pr-4 text-xs font-mono">{a.lineCount}</td>
                    <td className="py-2.5 pr-4 font-mono text-xs">{fmtNum(a.totalDebit)}</td>
                    <td className="py-2.5 pr-4 text-xs text-muted-foreground max-w-40 truncate">{a.accounts.join(", ")}</td>
                    <td className="py-2.5"><Badge className={`text-xs ${STATUS_STYLES[a.status] ?? ""}`}>{a.status}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
