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
import { Plus, FileInput } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface Bill { id: number; billNumber: string; vendorReference: string; date: string; dueDate: string; vendorId: number; vendorName: string; status: string; subtotal: number; vatAmount: number; total: number; paidAmount: number; }
interface Vendor { id: number; name: string; }

const STATUS_STYLES: Record<string, string> = { draft: "bg-secondary text-muted-foreground", received: "bg-blue-500/20 text-blue-400", approved: "bg-amber-500/20 text-amber-400", paid: "bg-emerald-500/20 text-emerald-400", overdue: "bg-red-500/20 text-red-400" };

const emptyForm = { billNumber: `BILL-${Date.now().toString().slice(-6)}`, vendorReference: "", date: new Date().toISOString().split("T")[0], dueDate: "", vendorId: "", status: "received", notes: "" };

export default function Bills() {
  const [statusFilter, setStatusFilter] = useState("all");
  const [open, setOpen] = useState(false);
  const [payOpen, setPayOpen] = useState<number | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [payAmount, setPayAmount] = useState("");
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data: bills = [], isLoading } = useQuery<Bill[]>({
    queryKey: ["bills", statusFilter],
    queryFn: () => apiFetch(`/bills${statusFilter !== "all" ? `?status=${statusFilter}` : ""}`),
  });

  const { data: vendors = [] } = useQuery<Vendor[]>({ queryKey: ["vendors"], queryFn: () => apiFetch("/vendors") });

  const createMut = useMutation({
    mutationFn: (body: any) => apiFetch("/bills", { method: "POST", body: JSON.stringify({ ...body, vendorId: Number(body.vendorId), items: [] }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["bills"] }); setOpen(false); setForm(emptyForm); toast({ title: "Bill created" }); },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const payMut = useMutation({
    mutationFn: ({ id, amount }: { id: number; amount: number }) => apiFetch(`/bills/${id}/pay`, { method: "POST", body: JSON.stringify({ amount, paidAt: new Date().toISOString().split("T")[0] }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["bills"] }); setPayOpen(null); setPayAmount(""); toast({ title: "Payment recorded" }); },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const totalOutstanding = bills.filter(b => b.status !== "paid").reduce((s, b) => s + (b.total - b.paidAmount), 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Bills</h1>
          <p className="text-muted-foreground text-sm mt-1">Vendor bills · Accounts Payable</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild><Button className="gap-2"><Plus className="w-4 h-4" /> New Bill</Button></DialogTrigger>
          <DialogContent className="max-w-md">
            <DialogHeader><DialogTitle>New Bill</DialogTitle></DialogHeader>
            <div className="space-y-3 mt-2">
              <div className="grid grid-cols-2 gap-3">
                <div><Label className="text-xs text-muted-foreground">Bill Number</Label><Input value={form.billNumber} onChange={e=>setForm(p=>({...p,billNumber:e.target.value}))} className="mt-1 h-8 text-sm" /></div>
                <div><Label className="text-xs text-muted-foreground">Vendor Ref</Label><Input value={form.vendorReference} onChange={e=>setForm(p=>({...p,vendorReference:e.target.value}))} className="mt-1 h-8 text-sm" /></div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div><Label className="text-xs text-muted-foreground">Date</Label><Input type="date" value={form.date} onChange={e=>setForm(p=>({...p,date:e.target.value}))} className="mt-1 h-8 text-sm" /></div>
                <div><Label className="text-xs text-muted-foreground">Due Date</Label><Input type="date" value={form.dueDate} onChange={e=>setForm(p=>({...p,dueDate:e.target.value}))} className="mt-1 h-8 text-sm" /></div>
              </div>
              <div><Label className="text-xs text-muted-foreground">Vendor</Label>
                <Select value={form.vendorId} onValueChange={v=>setForm(p=>({...p,vendorId:v}))}><SelectTrigger className="mt-1 h-8 text-sm"><SelectValue placeholder="Select vendor..." /></SelectTrigger><SelectContent>{vendors.map(v=><SelectItem key={v.id} value={String(v.id)}>{v.name}</SelectItem>)}</SelectContent></Select>
              </div>
              <div><Label className="text-xs text-muted-foreground">Status</Label>
                <Select value={form.status} onValueChange={v=>setForm(p=>({...p,status:v}))}><SelectTrigger className="mt-1 h-8 text-sm"><SelectValue /></SelectTrigger><SelectContent>{["draft","received","approved"].map(s=><SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent></Select>
              </div>
              <div><Label className="text-xs text-muted-foreground">Notes</Label><Input value={form.notes} onChange={e=>setForm(p=>({...p,notes:e.target.value}))} className="mt-1 h-8 text-sm" /></div>
            </div>
            <Button className="w-full mt-4" onClick={()=>createMut.mutate(form)} disabled={!form.vendorId || createMut.isPending}>
              {createMut.isPending ? "Creating..." : "Create Bill"}
            </Button>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid grid-cols-4 gap-4">
        {[["Total Bills", bills.length, "text-primary"],["Outstanding AP", fmtNum(totalOutstanding), "text-red-400"],["Paid", fmtNum(bills.filter(b=>b.status==="paid").reduce((s,b)=>s+b.total,0)), "text-emerald-400"],["Overdue", bills.filter(b=>b.status==="overdue").length, "text-red-400"]].map(([l,v,c])=>(
          <Card key={String(l)} className="border-border bg-card"><CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{l}</CardTitle></CardHeader><CardContent><div className={`text-2xl font-bold font-mono ${c}`}>{v}</div></CardContent></Card>
        ))}
      </div>

      <Card className="border-border bg-card">
        <CardHeader className="pb-3">
          <div className="flex gap-2 flex-wrap">
            {["all","draft","received","approved","paid","overdue"].map(s=>(
              <Button key={s} variant={statusFilter===s?"default":"ghost"} size="sm" className="h-7 text-xs capitalize" onClick={()=>setStatusFilter(s)}>{s}</Button>
            ))}
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? <div className="text-muted-foreground text-sm p-4">Loading...</div> : bills.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground"><FileInput className="w-8 h-8 mx-auto mb-3 opacity-40" /><p>No bills found.</p></div>
          ) : (
            <table className="w-full text-sm">
              <thead><tr className="border-b border-border text-muted-foreground text-xs uppercase">{["Bill #","Vendor","Date","Due Date","Subtotal","VAT","Total","Status",""].map(h=><th key={h} className="text-left pb-2 pr-4 font-medium">{h}</th>)}</tr></thead>
              <tbody>{bills.map(b=>(
                <tr key={b.id} className="border-b border-border/50 hover:bg-secondary/20 transition-colors">
                  <td className="py-3 pr-4 font-mono text-xs text-primary">{b.billNumber}</td>
                  <td className="py-3 pr-4 font-medium">{b.vendorName ?? "—"}</td>
                  <td className="py-3 pr-4 text-muted-foreground text-xs">{fmtDate(b.date)}</td>
                  <td className="py-3 pr-4 text-muted-foreground text-xs">{b.dueDate ? fmtDate(b.dueDate) : "—"}</td>
                  <td className="py-3 pr-4 font-mono">{fmtNum(b.subtotal)}</td>
                  <td className="py-3 pr-4 font-mono text-muted-foreground">{fmtNum(b.vatAmount)}</td>
                  <td className="py-3 pr-4 font-mono font-semibold">{fmtNum(b.total)}</td>
                  <td className="py-3 pr-4"><Badge className={`text-xs ${STATUS_STYLES[b.status] ?? ""}`}>{b.status}</Badge></td>
                  <td className="py-3">{b.status !== "paid" && <Button variant="ghost" size="sm" className="text-xs h-7 text-emerald-400" onClick={()=>{setPayOpen(b.id);setPayAmount(String(b.total-b.paidAmount));}}>Pay</Button>}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Dialog open={payOpen !== null} onOpenChange={()=>setPayOpen(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>Record Payment</DialogTitle></DialogHeader>
          <div className="mt-2"><Label className="text-xs text-muted-foreground">Amount Paid (SAR)</Label><Input type="number" value={payAmount} onChange={e=>setPayAmount(e.target.value)} className="mt-1 h-8 text-sm" /></div>
          <Button className="w-full mt-4 bg-emerald-600 hover:bg-emerald-700" onClick={()=>payOpen&&payMut.mutate({id:payOpen,amount:Number(payAmount)})} disabled={!payAmount||payMut.isPending}>{payMut.isPending?"Recording...":"Record Payment"}</Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
