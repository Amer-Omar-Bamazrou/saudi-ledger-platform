import { useQuery } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { AlertCircle } from "lucide-react";
import { DualDate } from "@/components/DualDate";

interface AgingData {
  buckets: { current: number; days_1_30: number; days_31_60: number; days_61_90: number; over_90: number };
  total: number;
  items: { id: number; invoiceNumber: string; customerName: string; dueDate: string; outstanding: number; daysPastDue: number }[];
}

const BUCKET_COLORS: Record<string, string> = {
  current: "text-emerald-400",
  days_1_30: "text-amber-400",
  days_31_60: "text-orange-400",
  days_61_90: "text-red-400",
  over_90: "text-red-600",
};

const BUCKET_LABELS: Record<string, string> = {
  current: "Current",
  days_1_30: "1–30 Days",
  days_31_60: "31–60 Days",
  days_61_90: "61–90 Days",
  over_90: "90+ Days",
};

function agingBucket(days: number): string {
  if (days <= 0) return "current";
  if (days <= 30) return "days_1_30";
  if (days <= 60) return "days_31_60";
  if (days <= 90) return "days_61_90";
  return "over_90";
}

export default function ArAging() {
  const { data, isLoading } = useQuery<AgingData>({
    queryKey: ["ar-aging"],
    queryFn: () => apiFetch("/reports/ar-aging"),
    refetchInterval: 60_000,
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">AR Aging Report</h1>
        <p className="text-muted-foreground text-sm mt-1">Outstanding customer balances by age · Auto-refreshes every minute</p>
      </div>

      {data && (
        <>
          <div className="grid grid-cols-5 gap-3">
            {Object.entries(BUCKET_LABELS).map(([key, label]) => (
              <Card key={key} className="border-border bg-card">
                <CardHeader className="pb-1"><CardTitle className="text-xs text-muted-foreground">{label}</CardTitle></CardHeader>
                <CardContent>
                  <div className={`text-lg font-bold font-mono ${BUCKET_COLORS[key]}`}>{fmtNum((data.buckets as any)[key] ?? 0)}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    {((((data.buckets as any)[key] ?? 0) / (data.total || 1)) * 100).toFixed(0)}%
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          {/* Visual bar */}
          <Card className="border-border bg-card">
            <CardContent className="pt-4">
              <div className="flex items-center gap-1 h-4 rounded-full overflow-hidden">
                {Object.entries(BUCKET_LABELS).map(([key]) => {
                  const pct = data.total > 0 ? ((data.buckets as any)[key] / data.total) * 100 : 0;
                  if (pct === 0) return null;
                  const bg: Record<string, string> = { current: "bg-emerald-500", days_1_30: "bg-amber-500", days_31_60: "bg-orange-500", days_61_90: "bg-red-500", over_90: "bg-red-700" };
                  return <div key={key} style={{ width: `${pct}%` }} className={`h-full transition-all ${bg[key]}`} title={`${BUCKET_LABELS[key]}: ${fmtNum((data.buckets as any)[key])}`} />;
                })}
              </div>
              <div className="flex justify-between mt-2 text-xs text-muted-foreground">
                <span>Least overdue ←</span>
                <span className="font-bold text-foreground">Total Outstanding: {fmtNum(data.total)}</span>
                <span>→ Most overdue</span>
              </div>
            </CardContent>
          </Card>
        </>
      )}

      <Card className="border-border bg-card">
        <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">Outstanding Invoices</CardTitle></CardHeader>
        <CardContent>
          {isLoading ? <div className="text-muted-foreground text-sm p-4">Loading...</div> : !data || data.items.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              <AlertCircle className="w-8 h-8 mx-auto mb-3 opacity-40" />
              <p>No outstanding invoices. All payments are current.</p>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-muted-foreground text-xs uppercase">
                  {["Invoice #", "Customer", "Due Date", "Days Past Due", "Outstanding", "Aging"].map(h => (
                    <th key={h} className="text-start pb-2 pe-4 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.items.map(item => {
                  const bucket = agingBucket(item.daysPastDue);
                  return (
                    <tr key={item.id} className="border-b border-border/50 hover:bg-secondary/20 transition-colors">
                      <td className="py-3 pe-4 font-mono text-xs text-primary">{item.invoiceNumber}</td>
                      <td className="py-3 pe-4 font-medium">{item.customerName}</td>
                      <td className="py-3 pe-4 text-xs text-muted-foreground"><DualDate date={item.dueDate} /></td>
                      <td className="py-3 pe-4">
                        <span className={`font-mono font-bold ${BUCKET_COLORS[bucket]}`}>
                          {item.daysPastDue <= 0 ? "Current" : `${item.daysPastDue}d`}
                        </span>
                      </td>
                      <td className="py-3 pe-4 font-mono font-semibold text-foreground">{fmtNum(item.outstanding)}</td>
                      <td className="py-3">
                        <Badge className={`text-xs ${bucket === "current" ? "bg-emerald-500/20 text-emerald-400" : bucket === "days_1_30" ? "bg-amber-500/20 text-amber-400" : "bg-red-500/20 text-red-400"}`}>
                          {BUCKET_LABELS[bucket]}
                        </Badge>
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
