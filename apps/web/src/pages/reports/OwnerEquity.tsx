import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Scale, Download } from "lucide-react";
import { cn } from "@/lib/utils";
import { useReportDefaultRange, type ReportDefaultRange } from "@/hooks/useReportDefaultRange";
import { FiscalRangeNotice, ReportRangeLoading } from "@/components/FiscalRangeNotice";
import { PeriodShortcuts } from "@/components/PeriodShortcuts";

interface EquityRow { label: string; amount: number; }
interface EquityData {
  period: { from: string; to: string };
  openingEquity: number; netIncome: number; contributions: number; withdrawals: number; closingEquity: number;
  breakdown: EquityRow[];
}

export default function OwnerEquity() {
  // M20.1 — the report does not mount until its default window is known, so a
  // wrong window (the old hardcoded Jan–Dec) is never queried or rendered,
  // even for a frame.
  const range = useReportDefaultRange();
  if (!range.ready) return <ReportRangeLoading />;
  return <OwnerEquityInner range={range} />;
}

function OwnerEquityInner({ range }: { range: ReportDefaultRange }) {
  const [dateFrom, setDateFrom] = useState(range.from);
  const [dateTo,   setDateTo]   = useState(range.to);
  const [applied,  setApplied]  = useState({ from: range.from, to: range.to });

  const { data, isLoading } = useQuery<EquityData>({
    queryKey: ["owner-equity", applied.from, applied.to],
    queryFn: () => apiFetch(`/reports/owner-equity?date_from=${applied.from}&date_to=${applied.to}`),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">
            Change in Owner Equity Statement
            <span className="ms-2 text-xs font-normal px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-400 border border-amber-500/20">New</span>
          </h1>
          <p className="text-muted-foreground text-sm mt-1">Opening equity + net income + contributions − withdrawals = closing equity</p>
        </div>
        <Button variant="outline" className="gap-2"><Download className="w-4 h-4" /> Export</Button>
      </div>

      <FiscalRangeNotice source={range.source} />

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
        <div className="grid grid-cols-4 gap-4">
          {[
            ["Opening Equity", fmtNum(data.openingEquity), "text-primary"],
            ["Net Income / (Loss)", fmtNum(data.netIncome), data.netIncome >= 0 ? "text-emerald-400" : "text-red-400"],
            ["Contributions", fmtNum(data.contributions), "text-blue-400"],
            ["Withdrawals", fmtNum(data.withdrawals), "text-amber-400"],
          ].map(([l, v, c]) => (
            <Card key={String(l)} className="border-border bg-card">
              <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{l}</CardTitle></CardHeader>
              <CardContent><div className={`text-xl font-bold font-mono ${c}`}>{v}</div></CardContent>
            </Card>
          ))}
        </div>
      )}

      {isLoading ? (
        <div className="text-sm text-muted-foreground p-4">Loading…</div>
      ) : !data ? null : (
        <Card className="border-border bg-card">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground uppercase tracking-wide">Statement of Changes in Owner's Equity — {data.period.from} to {data.period.to}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="max-w-md">
              {data.breakdown.map((row, i) => {
                const isClosing = i === data.breakdown.length - 1;
                const isIncome  = row.label.includes("Net Income");
                const isWithdrawal = row.label.includes("Withdrawal");
                return (
                  <div key={row.label} className={cn(
                    "flex items-center justify-between py-3",
                    isClosing ? "border-t-2 border-border mt-2 pt-4" : "border-b border-border/30",
                    isClosing && "font-bold"
                  )}>
                    <span className={cn("text-sm", isClosing ? "text-foreground" : "text-muted-foreground")}>{row.label}</span>
                    <span className={cn(
                      "font-mono text-sm",
                      isClosing ? "text-lg font-bold text-foreground" : "",
                      isIncome && row.amount < 0 ? "text-red-400" : "",
                      isIncome && row.amount >= 0 ? "text-emerald-400" : "",
                      isWithdrawal ? "text-amber-400" : "",
                    )}>
                      {isWithdrawal && row.amount !== 0 ? `(${fmtNum(Math.abs(row.amount))})` : fmtNum(row.amount)}
                    </span>
                  </div>
                );
              })}
            </div>

            {data.closingEquity !== 0 && (
              <div className={cn(
                "mt-6 p-4 rounded-lg border",
                data.closingEquity >= 0 ? "border-emerald-500/30 bg-emerald-500/5" : "border-red-500/30 bg-red-500/5"
              )}>
                <div className="flex items-center justify-between">
                  <span className={cn("font-bold text-sm uppercase tracking-wide", data.closingEquity >= 0 ? "text-emerald-400" : "text-red-400")}>Closing Equity</span>
                  <span className={cn("font-mono font-bold text-2xl", data.closingEquity >= 0 ? "text-emerald-400" : "text-red-400")}>{fmtNum(data.closingEquity)}</span>
                </div>
              </div>
            )}

            {data.openingEquity === 0 && data.contributions === 0 && (
              <div className="mt-4 p-3 rounded-lg bg-secondary/30 border border-border">
                <p className="text-xs text-muted-foreground">
                  <span className="font-semibold">Note:</span> Opening equity is zero because no equity-type accounts have been posted in journal entries before this period. Post capital contributions or retained earnings to equity accounts to see a complete statement.
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
