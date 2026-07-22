import { useState } from "react";
import { arabicFieldStatus } from "@/lib/arabicUtils";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Plus, Search, Users, TrendingUp, AlertCircle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface Customer { id: number; name: string; nameAr: string; taxNumber: string; crNumber: string; phone: string; email: string; city: string; isActive: boolean; creditLimit: number | null; paymentTermsDays: string; totalBilled?: number; totalPaid?: number; balance?: number; }

const emptyForm = { name: "", nameAr: "", taxNumber: "", crNumber: "", phone: "", email: "", address: "", city: "", paymentTermsDays: "30", creditLimit: "" };

export default function Customers() {
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data: customers = [], isLoading } = useQuery<Customer[]>({
    queryKey: ["customers", search],
    queryFn: () => apiFetch(`/customers?search=${encodeURIComponent(search)}&is_active=true`),
  });

  const createMut = useMutation({
    mutationFn: (body: typeof emptyForm) => apiFetch("/customers", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["customers"] }); setOpen(false); setForm(emptyForm); toast({ title: "Customer created" }); },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const totalAR = customers.reduce((s, c) => s + (c.balance ?? 0), 0);
  const totalBilled = customers.reduce((s, c) => s + (c.totalBilled ?? 0), 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Customers</h1>
          <p className="text-muted-foreground text-sm mt-1">Accounts Receivable — {customers.length} active customers</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button className="gap-2"><Plus className="w-4 h-4" /> New Customer</Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg">
            <DialogHeader><DialogTitle>New Customer</DialogTitle></DialogHeader>
            <div className="grid grid-cols-2 gap-3 mt-2">
              {[["name","Company Name *"],["nameAr","اسم الشركة"],["taxNumber","VAT Number"],["crNumber","CR Number"],["phone","Phone"],["email","Email"],["address","Address"],["city","City"],["paymentTermsDays","Payment Terms (days)"],["creditLimit","Credit Limit (SAR)"]].map(([k,l])=>(
                <div key={k} className={k==="address"?"col-span-2":""}>
                  <Label className="text-xs text-muted-foreground">{l}</Label>
                  <Input value={(form as any)[k]} onChange={e=>setForm(p=>({...p,[k]:e.target.value}))} className="mt-1 h-8 text-sm" />
                </div>
              ))}
            </div>
            <Button className="w-full mt-4" onClick={()=>createMut.mutate(form)} disabled={!form.name || createMut.isPending}>
              {createMut.isPending ? "Creating..." : "Create Customer"}
            </Button>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <Card className="border-border bg-card"><CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">Total Customers</CardTitle></CardHeader><CardContent><div className="text-2xl font-bold font-mono text-primary">{customers.length}</div></CardContent></Card>
        <Card className="border-border bg-card"><CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">Total Billed</CardTitle></CardHeader><CardContent><div className="text-2xl font-bold font-mono text-foreground">{fmtNum(totalBilled)}</div></CardContent></Card>
        <Card className="border-border bg-card"><CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">Outstanding AR</CardTitle></CardHeader><CardContent><div className={`text-2xl font-bold font-mono ${totalAR > 0 ? "text-amber-400" : "text-emerald-400"}`}>{fmtNum(totalAR)}</div></CardContent></Card>
      </div>

      <Card className="border-border bg-card">
        <CardHeader className="pb-3">
          <div className="flex items-center gap-3">
            <div className="relative flex-1 max-w-xs">
              <Search className="absolute left-3 top-2.5 w-4 h-4 text-muted-foreground" />
              <Input placeholder="Search customers..." className="pl-9 h-9" value={search} onChange={e=>setSearch(e.target.value)} />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? <div className="text-muted-foreground text-sm p-4">Loading...</div> : customers.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground"><Users className="w-8 h-8 mx-auto mb-3 opacity-40" /><p>No customers yet. Add your first customer.</p></div>
          ) : (
            <table className="w-full text-sm">
              <thead><tr className="border-b border-border text-muted-foreground text-xs uppercase">{["Customer","City","VAT Number","Payment Terms","Billed","Outstanding",""].map(h=><th key={h} className="text-left pb-2 pr-4 font-medium">{h}</th>)}</tr></thead>
              <tbody>{customers.map(c=>(
                <tr key={c.id} className="border-b border-border/50 hover:bg-secondary/20 transition-colors">
                  <td className="py-3 pr-4">
                    <div className="font-medium text-foreground">{c.name}</div>
                    {arabicFieldStatus(c.nameAr) === "ok"
                      ? <div className="text-xs text-muted-foreground" dir="rtl">{c.nameAr}</div>
                      : arabicFieldStatus(c.nameAr) === "wrong-script"
                      ? <div className="text-[10px] text-orange-400 italic mt-0.5">⚠ not Arabic script — please correct</div>
                      : <div className="text-[10px] text-amber-500/60 italic mt-0.5">needs Arabic translation</div>}
                  </td>
                  <td className="py-3 pr-4 text-muted-foreground">{c.city||"—"}</td>
                  <td className="py-3 pr-4 font-mono text-xs text-muted-foreground">{c.taxNumber||"—"}</td>
                  <td className="py-3 pr-4"><Badge variant="outline" className="text-xs font-mono">{c.paymentTermsDays}d</Badge></td>
                  <td className="py-3 pr-4 font-mono text-foreground">{fmtNum(c.totalBilled??0)}</td>
                  <td className="py-3 pr-4"><span className={`font-mono font-medium ${(c.balance??0)>0?"text-amber-400":"text-emerald-400"}`}>{fmtNum(c.balance??0)}</span></td>
                  <td className="py-3"><Button variant="ghost" size="sm" className="text-xs h-7">View</Button></td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
