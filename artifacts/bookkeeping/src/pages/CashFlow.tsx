import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ArrowUpRight, ArrowDownRight, Minus } from "lucide-react";

interface CFSection { total: number; items: { name: string; amount: number }[]; }
interface CFData { operating: CFSection; investing: CFSection; financing: CFSection; netChange: number; }

function CFBlock({ title, data, color, icon }: { title: string; data: CFSection; color: string; icon: React.ReactNode }) {
  return (
    <Card className="border-border bg-card">
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2">
          {icon}
          <CardTitle className={`text-sm font-semibold ${color}`}>{title}</CardTitle>
        </div>
        <div className={`text-2xl font-bold font-mono mt-1 ${color}`}>{fmtNum(data.total)}</div>
      </CardHeader>
      <CardContent>
        <table className="w-full text-xs">
          <thead><tr className="border-b border-border text-muted-foreground uppercase"><th className="text-left pb-1">Item</th><th className="text-right pb-1">Amount</th></tr></thead>
          <tbody>
            {data.items.length === 0 ? (
              <tr><td colSpan={2} className="py-4 text-center text-muted-foreground">No items</td></tr>
            ) : data.items.slice(0, 10).map((item, i) => (
              <tr key={i} className="border-b border-border/30 hover:bg-secondary/10">
                <td className="py-1.5 pr-2 text-foreground">{item.name}</td>
                <td className={`py-1.5 text-right font-mono ${item.amount >= 0 ? "text-emerald-400" : "text-red-400"}`}>{item.amount >= 0 ? "+" : ""}{fmtNum(item.amount)}</td>
              </tr>
            ))}
            {data.items.length > 10 && <tr><td colSpan={2} className="py-1 text-center text-muted-foreground text-xs">+{data.items.length - 10} more items</td></tr>}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

export default function CashFlow() {
  const thisYear = new Date().getFullYear();
  const [dateFrom, setDateFrom] = useState(`${thisYear}-01-01`);
  const [dateTo, setDateTo] = useState(`${thisYear}-12-31`);
  const [applied, setApplied] = useState({ from: `${thisYear}-01-01`, to: `${thisYear}-12-31` });

  const { data, isLoading } = useQuery<CFData>({
    queryKey: ["cash-flow", applied.from, applied.to],
    queryFn: () => apiFetch(`/reports/cash-flow?date_from=${applied.from}&date_to=${applied.to}`),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Cash Flow Statement</h1>
          <p className="text-muted-foreground text-sm mt-1">Operating · Investing · Financing activities</p>
        </div>
      </div>

      <Card className="border-border bg-card">
        <CardContent className="pt-4">
          <div className="flex items-end gap-4">
            <div><Label className="text-xs text-muted-foreground">From</Label><Input type="date" value={dateFrom} onChange={e=>setDateFrom(e.target.value)} className="mt-1 h-8 text-sm w-40" /></div>
            <div><Label className="text-xs text-muted-foreground">To</Label><Input type="date" value={dateTo} onChange={e=>setDateTo(e.target.value)} className="mt-1 h-8 text-sm w-40" /></div>
            <Button size="sm" className="h-8" onClick={()=>setApplied({from:dateFrom,to:dateTo})}>Generate</Button>
          </div>
        </CardContent>
      </Card>

      {data && (
        <div className={`rounded-lg border px-6 py-4 flex items-center justify-between ${data.netChange >= 0 ? "border-emerald-500/30 bg-emerald-500/10" : "border-red-500/30 bg-red-500/10"}`}>
          <div>
            <div className="text-xs uppercase tracking-widest text-muted-foreground">Net Change in Cash</div>
            <div className={`text-3xl font-bold font-mono mt-1 ${data.netChange >= 0 ? "text-emerald-400" : "text-red-400"}`}>{data.netChange >= 0 ? "+" : ""}{fmtNum(data.netChange)}</div>
          </div>
          <div className="text-right text-xs text-muted-foreground space-y-1">
            <div>Operating: <span className={data.operating.total >= 0 ? "text-emerald-400 font-mono" : "text-red-400 font-mono"}>{fmtNum(data.operating.total)}</span></div>
            <div>Investing: <span className={data.investing.total >= 0 ? "text-emerald-400 font-mono" : "text-red-400 font-mono"}>{fmtNum(data.investing.total)}</span></div>
            <div>Financing: <span className={data.financing.total >= 0 ? "text-emerald-400 font-mono" : "text-red-400 font-mono"}>{fmtNum(data.financing.total)}</span></div>
          </div>
        </div>
      )}

      {isLoading ? <div className="text-muted-foreground text-sm p-4">Loading...</div> : !data ? null : (
        <div className="grid grid-cols-3 gap-4">
          <CFBlock title="Operating Activities" data={data.operating} color={data.operating.total >= 0 ? "text-emerald-400" : "text-red-400"} icon={<ArrowUpRight className="w-4 h-4 text-emerald-400" />} />
          <CFBlock title="Investing Activities" data={data.investing} color={data.investing.total >= 0 ? "text-emerald-400" : "text-amber-400"} icon={<Minus className="w-4 h-4 text-amber-400" />} />
          <CFBlock title="Financing Activities" data={data.financing} color={data.financing.total >= 0 ? "text-emerald-400" : "text-blue-400"} icon={<ArrowDownRight className="w-4 h-4 text-blue-400" />} />
        </div>
      )}
    </div>
  );
}
