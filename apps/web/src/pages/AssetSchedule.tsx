import { useQuery } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Package, Download } from "lucide-react";
import { DualDate } from "@/components/DualDate";

interface AssetRow {
  id: number; name: string; category: string; purchaseDate: string; cost: number;
  usefulLife: number; depreciation: string; accumulatedDepreciation: number; bookValue: number; status: string;
}

const STATUS_STYLES: Record<string, string> = {
  active: "bg-emerald-500/20 text-emerald-400",
  disposed: "bg-red-500/20 text-red-400",
  fully_depreciated: "bg-secondary text-muted-foreground",
};

export default function AssetSchedule() {
  const { data: assets = [], isLoading } = useQuery<AssetRow[]>({
    queryKey: ["asset-schedule"],
    queryFn: () => apiFetch<AssetRow[]>("/assets").catch(() => [] as AssetRow[]),
  });

  const totalCost = assets.reduce((s, a) => s + a.cost, 0);
  const totalAccumDep = assets.reduce((s, a) => s + a.accumulatedDepreciation, 0);
  const totalBookValue = assets.reduce((s, a) => s + a.bookValue, 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Fixed Asset Schedule</h1>
          <p className="text-muted-foreground text-sm mt-1">Asset register with cost, depreciation, and net book value</p>
        </div>
        <Button variant="outline" className="gap-2"><Download className="w-4 h-4" /> Export</Button>
      </div>

      <div className="grid grid-cols-4 gap-4">
        {[
          ["Total Assets", assets.filter(a => a.status === "active").length, "text-primary"],
          ["Total Cost", fmtNum(totalCost), "text-primary"],
          ["Accumulated Dep.", fmtNum(totalAccumDep), "text-red-400"],
          ["Net Book Value", fmtNum(totalBookValue), "text-emerald-400"],
        ].map(([l, v, c]) => (
          <Card key={String(l)} className="border-border bg-card">
            <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{l}</CardTitle></CardHeader>
            <CardContent><div className={`text-2xl font-bold font-mono ${c}`}>{v}</div></CardContent>
          </Card>
        ))}
      </div>

      <Card className="border-border bg-card">
        <CardContent className="pt-6">
          {isLoading ? <div className="text-sm text-muted-foreground p-4">Loading…</div>
          : assets.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground">
              <Package className="w-8 h-8 mx-auto mb-3 opacity-40" />
              <p className="text-sm">No fixed assets registered.</p>
              <p className="text-xs mt-1 opacity-60">Add assets in Assets &amp; Inventory to see them here.</p>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-muted-foreground text-xs uppercase">
                  {["Asset", "Category", "Purchase Date", "Cost", "Useful Life", "Method", "Acc. Dep.", "Book Value", "Status"].map(h => (
                    <th key={h} className="text-start pb-2 pe-3 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {assets.map(a => (
                  <tr key={a.id} className="border-b border-border/50 hover:bg-secondary/20">
                    <td className="py-2 pe-3 font-medium text-xs">{a.name}</td>
                    <td className="py-2 pe-3 text-muted-foreground text-xs">{a.category}</td>
                    <td className="py-2 pe-3 text-muted-foreground text-xs"><DualDate date={a.purchaseDate} /></td>
                    <td className="py-2 pe-3 font-mono text-xs">{fmtNum(a.cost)}</td>
                    <td className="py-2 pe-3 font-mono text-xs">{a.usefulLife}y</td>
                    <td className="py-2 pe-3 text-xs text-muted-foreground">{a.depreciation}</td>
                    <td className="py-2 pe-3 font-mono text-xs text-red-400">{fmtNum(a.accumulatedDepreciation)}</td>
                    <td className="py-2 pe-3 font-mono text-xs font-semibold text-emerald-400">{fmtNum(a.bookValue)}</td>
                    <td className="py-2"><Badge className={`text-xs ${STATUS_STYLES[a.status] ?? ""}`}>{a.status.replace("_", " ")}</Badge></td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-border font-semibold">
                  <td colSpan={3} className="pt-3 text-xs text-muted-foreground">Total</td>
                  <td className="pt-3 font-mono text-xs">{fmtNum(totalCost)}</td>
                  <td colSpan={2} />
                  <td className="pt-3 font-mono text-xs text-red-400">{fmtNum(totalAccumDep)}</td>
                  <td className="pt-3 font-mono text-xs text-emerald-400">{fmtNum(totalBookValue)}</td>
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
