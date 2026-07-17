import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch, fmtNum, fmtDate } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Package, TrendingDown } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface Asset { id: number; assetNumber: string; name: string; nameAr?: string; purchaseDate: string; purchaseCost: number; salvageValue: number; usefulLifeYears: number; accumulatedDepreciation: number; currentBookValue: number; annualDepreciation: number; monthlyDepreciation: number; depreciationMethod: string; status: string; location?: string; }

const STATUS_STYLES: Record<string, string> = { active: "bg-emerald-500/20 text-emerald-400", "fully-depreciated": "bg-secondary text-muted-foreground", disposed: "bg-red-500/20 text-red-400", sold: "bg-blue-500/20 text-blue-400" };

const emptyForm = { assetNumber: `FA-${Date.now().toString().slice(-5)}`, name: "", nameAr: "", purchaseDate: new Date().toISOString().split("T")[0], purchaseCost: "", salvageValue: "0", usefulLifeYears: "5", depreciationMethod: "straight-line", location: "", serialNumber: "", notes: "" };

export default function Assets() {
  const [open, setOpen] = useState(false);
  const [depOpen, setDepOpen] = useState<number | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [depPeriod, setDepPeriod] = useState(new Date().toISOString().slice(0, 7));
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data: assets = [], isLoading } = useQuery<Asset[]>({ queryKey: ["assets"], queryFn: () => apiFetch("/assets") });

  const createMut = useMutation({
    mutationFn: (body: any) => apiFetch("/assets", { method: "POST", body: JSON.stringify({ ...body, purchaseCost: Number(body.purchaseCost), salvageValue: Number(body.salvageValue), usefulLifeYears: Number(body.usefulLifeYears) }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["assets"] }); setOpen(false); setForm(emptyForm); toast({ title: "Asset registered" }); },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const depMut = useMutation({
    mutationFn: ({ id, period }: { id: number; period: string }) => apiFetch(`/assets/${id}/depreciate`, { method: "POST", body: JSON.stringify({ period }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["assets"] }); setDepOpen(null); toast({ title: "Depreciation recorded" }); },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const totalCost = assets.reduce((s, a) => s + a.purchaseCost, 0);
  const totalBookValue = assets.reduce((s, a) => s + a.currentBookValue, 0);
  const totalDepreciation = assets.reduce((s, a) => s + a.accumulatedDepreciation, 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Fixed Assets</h1>
          <p className="text-muted-foreground text-sm mt-1">Asset register · Straight-line & declining balance depreciation</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild><Button className="gap-2"><Plus className="w-4 h-4" /> Register Asset</Button></DialogTrigger>
          <DialogContent className="max-w-lg">
            <DialogHeader><DialogTitle>Register Fixed Asset</DialogTitle></DialogHeader>
            <div className="grid grid-cols-2 gap-3 mt-2">
              {([["assetNumber","Asset #"],["name","Asset Name *"],["nameAr","الاسم بالعربي"],["location","Location"],["serialNumber","Serial Number"]] as [string,string][]).map(([k,l])=>(
                <div key={k}><Label className="text-xs text-muted-foreground">{l}</Label><Input value={(form as any)[k]} onChange={e=>setForm(p=>({...p,[k]:e.target.value}))} className="mt-1 h-8 text-sm" /></div>
              ))}
              <div><Label className="text-xs text-muted-foreground">Purchase Date</Label><Input type="date" value={form.purchaseDate} onChange={e=>setForm(p=>({...p,purchaseDate:e.target.value}))} className="mt-1 h-8 text-sm" /></div>
              <div><Label className="text-xs text-muted-foreground">Depreciation Method</Label>
                <Select value={form.depreciationMethod} onValueChange={v=>setForm(p=>({...p,depreciationMethod:v}))}><SelectTrigger className="mt-1 h-8 text-sm"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="straight-line">Straight-Line</SelectItem><SelectItem value="declining">Declining Balance</SelectItem></SelectContent></Select>
              </div>
              {([["purchaseCost","Purchase Cost (SAR) *"],["salvageValue","Salvage Value (SAR)"],["usefulLifeYears","Useful Life (Years)"]] as [string,string][]).map(([k,l])=>(
                <div key={k}><Label className="text-xs text-muted-foreground">{l}</Label><Input type="number" value={(form as any)[k]} onChange={e=>setForm(p=>({...p,[k]:e.target.value}))} className="mt-1 h-8 text-sm font-mono" /></div>
              ))}
              {form.purchaseCost && form.usefulLifeYears && (
                <div className="col-span-2 bg-secondary/30 rounded-lg p-3 text-xs">
                  <p className="text-muted-foreground mb-1">Depreciation Preview (Straight-Line)</p>
                  <div className="flex justify-between"><span>Annual</span><span className="font-mono text-amber-400">{fmtNum((Number(form.purchaseCost)-Number(form.salvageValue))/Number(form.usefulLifeYears))}</span></div>
                  <div className="flex justify-between mt-0.5"><span>Monthly</span><span className="font-mono text-amber-400">{fmtNum((Number(form.purchaseCost)-Number(form.salvageValue))/(Number(form.usefulLifeYears)*12))}</span></div>
                </div>
              )}
            </div>
            <Button className="w-full mt-4" onClick={()=>createMut.mutate(form)} disabled={!form.name||!form.purchaseCost||createMut.isPending}>{createMut.isPending?"Registering...":"Register Asset"}</Button>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid grid-cols-4 gap-4">
        {[["Assets", assets.length, "text-primary"],["Total Cost", fmtNum(totalCost), "text-foreground"],["Book Value", fmtNum(totalBookValue), "text-amber-400"],["Accumulated Depreciation", fmtNum(totalDepreciation), "text-muted-foreground"]].map(([l,v,c])=>(
          <Card key={String(l)} className="border-border bg-card"><CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{l}</CardTitle></CardHeader><CardContent><div className={`text-xl font-bold font-mono ${c}`}>{v}</div></CardContent></Card>
        ))}
      </div>

      <Card className="border-border bg-card">
        <CardContent className="pt-4">
          {isLoading ? <div className="text-muted-foreground text-sm p-4">Loading...</div> : assets.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground"><Package className="w-8 h-8 mx-auto mb-3 opacity-40" /><p>No fixed assets registered.</p></div>
          ) : (
            <table className="w-full text-sm">
              <thead><tr className="border-b border-border text-muted-foreground text-xs uppercase">{["Asset","Purchase Date","Cost","Book Value","Accum. Dep.","Monthly Dep.","Status",""].map(h=><th key={h} className="text-left pb-2 pr-3 font-medium">{h}</th>)}</tr></thead>
              <tbody>{assets.map(a=>(
                <tr key={a.id} className="border-b border-border/50 hover:bg-secondary/20 transition-colors">
                  <td className="py-3 pr-3"><div className="font-medium">{a.name}</div><div className="text-xs text-muted-foreground font-mono">{a.assetNumber}</div></td>
                  <td className="py-3 pr-3 text-xs text-muted-foreground">{fmtDate(a.purchaseDate)}</td>
                  <td className="py-3 pr-3 font-mono">{fmtNum(a.purchaseCost)}</td>
                  <td className="py-3 pr-3 font-mono font-semibold text-amber-400">{fmtNum(a.currentBookValue)}</td>
                  <td className="py-3 pr-3 font-mono text-muted-foreground">{fmtNum(a.accumulatedDepreciation)}</td>
                  <td className="py-3 pr-3 font-mono text-xs text-muted-foreground">{fmtNum(a.monthlyDepreciation)}</td>
                  <td className="py-3 pr-3"><Badge className={`text-xs ${STATUS_STYLES[a.status]??""}`}>{a.status}</Badge></td>
                  <td className="py-3">{a.status==="active"&&<Button variant="ghost" size="sm" className="text-xs h-7 gap-1" onClick={()=>setDepOpen(a.id)}><TrendingDown className="w-3 h-3"/>Depreciate</Button>}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Dialog open={depOpen !== null} onOpenChange={()=>setDepOpen(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>Run Depreciation</DialogTitle></DialogHeader>
          <div className="mt-2"><Label className="text-xs text-muted-foreground">Period (YYYY-MM)</Label><Input type="month" value={depPeriod} onChange={e=>setDepPeriod(e.target.value)} className="mt-1 h-8 text-sm" /></div>
          <Button className="w-full mt-4" onClick={()=>depOpen&&depMut.mutate({id:depOpen,period:depPeriod})} disabled={depMut.isPending}>{depMut.isPending?"Running...":"Run Depreciation"}</Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
