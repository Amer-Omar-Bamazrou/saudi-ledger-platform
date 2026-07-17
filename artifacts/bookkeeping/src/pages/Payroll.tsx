import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Banknote, CheckCircle, Clock, Play } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface PayrollRun { id: number; period: string; status: string; totalBasicSalary: number; totalAllowances: number; totalGosiEmployee: number; totalGosiEmployer: number; totalNetPay: number; processedAt: string | null; }
interface PayrollDetail extends PayrollRun { items: Array<{ id: number; employeeName: string; employeeNumber: string; basicSalary: number; grossSalary: number; gosiEmployee: number; gosiEmployer: number; netPay: number; }>; }

const STATUS_STYLES: Record<string, string> = { draft: "bg-amber-500/20 text-amber-400", approved: "bg-emerald-500/20 text-emerald-400", paid: "bg-blue-500/20 text-blue-400" };

export default function Payroll() {
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [period, setPeriod] = useState(new Date().toISOString().slice(0, 7));
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data: runs = [], isLoading } = useQuery<PayrollRun[]>({ queryKey: ["payroll"], queryFn: () => apiFetch("/payroll") });
  const { data: detail } = useQuery<PayrollDetail>({ queryKey: ["payroll", selectedId], queryFn: () => apiFetch(`/payroll/${selectedId}`), enabled: selectedId !== null });

  const generateMut = useMutation({
    mutationFn: (p: string) => apiFetch("/payroll", { method: "POST", body: JSON.stringify({ period: p }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["payroll"] }); setOpen(false); toast({ title: "Payroll run generated" }); },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const approveMut = useMutation({
    mutationFn: (id: number) => apiFetch(`/payroll/${id}/approve`, { method: "POST" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["payroll"] }); toast({ title: "Payroll approved" }); },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Payroll</h1>
          <p className="text-muted-foreground text-sm mt-1">Saudi payroll processing · GOSI · WPS-ready</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild><Button className="gap-2"><Play className="w-4 h-4" /> Run Payroll</Button></DialogTrigger>
          <DialogContent className="max-w-sm">
            <DialogHeader><DialogTitle>Generate Payroll Run</DialogTitle></DialogHeader>
            <div className="mt-2 space-y-3">
              <div><Label className="text-xs text-muted-foreground">Period (YYYY-MM)</Label><Input type="month" value={period} onChange={e=>setPeriod(e.target.value)} className="mt-1 h-8 text-sm" /></div>
              <p className="text-xs text-muted-foreground">This will generate payroll items for all active employees based on their current salary setup and GOSI rates.</p>
            </div>
            <Button className="w-full mt-4" onClick={()=>generateMut.mutate(period)} disabled={generateMut.isPending}>{generateMut.isPending?"Generating...":"Generate Payroll"}</Button>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid grid-cols-5 gap-4">
        {runs.length > 0 && (() => {
          const last = runs[0];
          return [["Net Pay", fmtNum(last.totalNetPay), "text-primary"],["Basic Salary", fmtNum(last.totalBasicSalary), "text-foreground"],["Allowances", fmtNum(last.totalAllowances), "text-muted-foreground"],["GOSI (Employee)", fmtNum(last.totalGosiEmployee), "text-amber-400"],["GOSI (Employer)", fmtNum(last.totalGosiEmployer), "text-red-400"]].map(([l,v,c])=>(
            <Card key={String(l)} className="border-border bg-card"><CardHeader className="pb-2"><CardTitle className="text-xs text-muted-foreground">{l}</CardTitle></CardHeader><CardContent><div className={`text-lg font-bold font-mono ${c}`}>{v}</div><div className="text-xs text-muted-foreground mt-1">{last.period}</div></CardContent></Card>
          ));
        })()}
      </div>

      <div className="grid grid-cols-5 gap-4">
        <Card className="col-span-2 border-border bg-card">
          <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">Payroll Runs</CardTitle></CardHeader>
          <CardContent>
            {isLoading ? <div className="text-muted-foreground text-sm">Loading...</div> : runs.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground"><Banknote className="w-8 h-8 mx-auto mb-3 opacity-40" /><p className="text-sm">No payroll runs yet.</p></div>
            ) : (
              <div className="space-y-2">
                {runs.map(r=>(
                  <div key={r.id} className={`flex items-center justify-between p-3 rounded-lg border cursor-pointer transition-colors ${selectedId===r.id?"border-primary/40 bg-primary/5":"border-border hover:bg-secondary/20"}`} onClick={()=>setSelectedId(selectedId===r.id?null:r.id)}>
                    <div>
                      <div className="font-mono text-sm font-semibold">{r.period}</div>
                      <div className="text-xs text-muted-foreground mt-0.5">{fmtNum(r.totalNetPay)} net</div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge className={`text-xs ${STATUS_STYLES[r.status]??""}`}>{r.status}</Badge>
                      {r.status==="draft"&&<Button variant="ghost" size="sm" className="h-6 text-xs text-emerald-400" onClick={ev=>{ev.stopPropagation();approveMut.mutate(r.id);}}>Approve</Button>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="col-span-3 border-border bg-card">
          <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{detail ? `Payslips — ${detail.period}` : "Select a Run"}</CardTitle></CardHeader>
          <CardContent>
            {!detail ? <div className="text-center py-12 text-muted-foreground text-sm">Select a payroll run to view payslips</div> : (
              <table className="w-full text-xs">
                <thead><tr className="border-b border-border text-muted-foreground uppercase">{["Employee","Basic","GOSI (Emp)","GOSI (Er)","Net Pay"].map(h=><th key={h} className="text-left pb-2 pr-3 font-medium">{h}</th>)}</tr></thead>
                <tbody>{detail.items.map(item=>(
                  <tr key={item.id} className="border-b border-border/50 hover:bg-secondary/10">
                    <td className="py-2 pr-3"><div className="font-medium text-sm">{item.employeeName}</div><div className="text-muted-foreground font-mono">{item.employeeNumber}</div></td>
                    <td className="py-2 pr-3 font-mono">{fmtNum(item.basicSalary)}</td>
                    <td className="py-2 pr-3 font-mono text-amber-400">{fmtNum(item.gosiEmployee)}</td>
                    <td className="py-2 pr-3 font-mono text-red-400">{fmtNum(item.gosiEmployer)}</td>
                    <td className="py-2 font-mono font-semibold text-emerald-400 text-sm">{fmtNum(item.netPay)}</td>
                  </tr>
                ))}</tbody>
                <tfoot>
                  <tr className="border-t border-border font-semibold text-sm">
                    <td className="py-2 text-muted-foreground">Total</td>
                    <td className="py-2 font-mono">{fmtNum(detail.totalBasicSalary)}</td>
                    <td className="py-2 font-mono text-amber-400">{fmtNum(detail.totalGosiEmployee)}</td>
                    <td className="py-2 font-mono text-red-400">{fmtNum(detail.totalGosiEmployer)}</td>
                    <td className="py-2 font-mono text-emerald-400">{fmtNum(detail.totalNetPay)}</td>
                  </tr>
                </tfoot>
              </table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
