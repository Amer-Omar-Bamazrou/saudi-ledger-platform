import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Target } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface Budget { id: number; name: string; period: string; categoryId?: number; categoryName?: string; categoryType?: string; budgetedAmount: number; actualAmount: number; variance: number; variancePct: number; }
interface Category { id: number; name: string; type: string; }

const emptyForm = { name: "", period: String(new Date().getFullYear()), categoryId: "", budgetedAmount: "", notes: "" };

export default function Budgets() {
  const [period, setPeriod] = useState(String(new Date().getFullYear()));
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data: budgets = [], isLoading } = useQuery<Budget[]>({
    queryKey: ["budgets", period],
    queryFn: () => apiFetch(`/budgets?period=${period}`),
  });

  const { data: categories = [] } = useQuery<Category[]>({ queryKey: ["categories"], queryFn: () => apiFetch("/categories") });

  const createMut = useMutation({
    mutationFn: (body: any) => apiFetch("/budgets", { method: "POST", body: JSON.stringify({ ...body, categoryId: body.categoryId ? Number(body.categoryId) : null, budgetedAmount: Number(body.budgetedAmount) }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["budgets"] }); setOpen(false); setForm(emptyForm); toast({ title: "Budget line added" }); },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => apiFetch(`/budgets/${id}`, { method: "DELETE" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["budgets"] }); toast({ title: "Budget line deleted" }); },
  });

  const totalBudgeted = budgets.reduce((s, b) => s + b.budgetedAmount, 0);
  const totalActual = budgets.reduce((s, b) => s + b.actualAmount, 0);
  const totalVariance = totalBudgeted - totalActual;
  const budgetsOver = budgets.filter(b => b.variance < 0).length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Budgeting</h1>
          <p className="text-muted-foreground text-sm mt-1">Budget vs. Actual · Variance analysis</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex gap-1">
            {[String(new Date().getFullYear()-1), String(new Date().getFullYear()), String(new Date().getFullYear()+1)].map(y=>(
              <Button key={y} variant={period===y?"default":"ghost"} size="sm" className="h-8 text-xs" onClick={()=>setPeriod(y)}>{y}</Button>
            ))}
          </div>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild><Button className="gap-2"><Plus className="w-4 h-4" /> Add Budget</Button></DialogTrigger>
            <DialogContent className="max-w-md">
              <DialogHeader><DialogTitle>Add Budget Line</DialogTitle></DialogHeader>
              <div className="space-y-3 mt-2">
                <div><Label className="text-xs text-muted-foreground">Budget Name</Label><Input value={form.name} onChange={e=>setForm(p=>({...p,name:e.target.value}))} className="mt-1 h-8 text-sm" placeholder="e.g., Marketing Budget 2025" /></div>
                <div className="grid grid-cols-2 gap-3">
                  <div><Label className="text-xs text-muted-foreground">Period (Year)</Label><Input value={form.period} onChange={e=>setForm(p=>({...p,period:e.target.value}))} className="mt-1 h-8 text-sm" /></div>
                  <div><Label className="text-xs text-muted-foreground">Budgeted Amount (SAR)</Label><Input type="number" value={form.budgetedAmount} onChange={e=>setForm(p=>({...p,budgetedAmount:e.target.value}))} className="mt-1 h-8 text-sm font-mono" /></div>
                </div>
                <div><Label className="text-xs text-muted-foreground">Category (optional)</Label>
                  <Select value={form.categoryId} onValueChange={v=>setForm(p=>({...p,categoryId:v}))}><SelectTrigger className="mt-1 h-8 text-sm"><SelectValue placeholder="Select category..." /></SelectTrigger><SelectContent>{categories.map(c=><SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}</SelectContent></Select>
                </div>
              </div>
              <Button className="w-full mt-4" onClick={()=>createMut.mutate(form)} disabled={!form.name||!form.budgetedAmount||createMut.isPending}>{createMut.isPending?"Adding...":"Add Budget Line"}</Button>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-4">
        {[["Total Budgeted", fmtNum(totalBudgeted), "text-primary"],["Total Actual", fmtNum(totalActual), "text-foreground"],["Variance", fmtNum(totalVariance), totalVariance >= 0 ? "text-emerald-400" : "text-red-400"],["Over Budget Lines", budgetsOver, "text-red-400"]].map(([l,v,c])=>(
          <Card key={String(l)} className="border-border bg-card"><CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{l}</CardTitle></CardHeader><CardContent><div className={`text-xl font-bold font-mono ${c}`}>{v}</div></CardContent></Card>
        ))}
      </div>

      <Card className="border-border bg-card">
        <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">Budget vs. Actual — {period}</CardTitle></CardHeader>
        <CardContent>
          {isLoading ? <div className="text-muted-foreground text-sm p-4">Loading...</div> : budgets.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground"><Target className="w-8 h-8 mx-auto mb-3 opacity-40" /><p>No budget lines for {period}.</p></div>
          ) : (
            <table className="w-full text-sm">
              <thead><tr className="border-b border-border text-muted-foreground text-xs uppercase">{["Budget","Category","Budgeted","Actual","Variance","Utilization",""].map(h=><th key={h} className="text-left pb-2 pr-4 font-medium">{h}</th>)}</tr></thead>
              <tbody>{budgets.map(b=>{
                const pct = b.budgetedAmount > 0 ? Math.min((b.actualAmount / b.budgetedAmount) * 100, 100) : 0;
                const over = b.variance < 0;
                return (
                  <tr key={b.id} className="border-b border-border/50 hover:bg-secondary/20">
                    <td className="py-3 pr-4 font-medium">{b.name}</td>
                    <td className="py-3 pr-4 text-muted-foreground text-xs">{b.categoryName || "—"}</td>
                    <td className="py-3 pr-4 font-mono">{fmtNum(b.budgetedAmount)}</td>
                    <td className="py-3 pr-4 font-mono">{fmtNum(b.actualAmount)}</td>
                    <td className={`py-3 pr-4 font-mono font-semibold ${over?"text-red-400":"text-emerald-400"}`}>{over?"-":"+"}{ fmtNum(Math.abs(b.variance))}</td>
                    <td className="py-3 pr-4">
                      <div className="flex items-center gap-2">
                        <div className="w-24 bg-secondary rounded-full h-1.5">
                          <div className={`h-1.5 rounded-full transition-all ${over?"bg-red-400":"bg-emerald-400"}`} style={{width:`${pct}%`}} />
                        </div>
                        <span className={`text-xs font-mono ${over?"text-red-400":"text-muted-foreground"}`}>{b.budgetedAmount > 0 ? ((b.actualAmount/b.budgetedAmount)*100).toFixed(0) : 0}%</span>
                      </div>
                    </td>
                    <td className="py-3"><Button variant="ghost" size="sm" className="h-6 text-xs text-muted-foreground" onClick={()=>deleteMut.mutate(b.id)}>Delete</Button></td>
                  </tr>
                );
              })}</tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
