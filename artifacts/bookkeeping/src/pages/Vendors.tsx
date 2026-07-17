import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Plus, Search, Building2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface Vendor { id: number; name: string; nameAr: string; taxNumber: string; crNumber: string; phone: string; email: string; city: string; iban: string; paymentTermsDays: string; isActive: boolean; totalBilled?: number; totalPaid?: number; balance?: number; }

const emptyForm = { name: "", nameAr: "", taxNumber: "", crNumber: "", phone: "", email: "", address: "", city: "", iban: "", paymentTermsDays: "30" };

export default function Vendors() {
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data: vendors = [], isLoading } = useQuery<Vendor[]>({
    queryKey: ["vendors", search],
    queryFn: () => apiFetch(`/vendors?search=${encodeURIComponent(search)}&is_active=true`),
  });

  const createMut = useMutation({
    mutationFn: (body: typeof emptyForm) => apiFetch("/vendors", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["vendors"] }); setOpen(false); setForm(emptyForm); toast({ title: "Vendor created" }); },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const totalAP = vendors.reduce((s, v) => s + (v.balance ?? 0), 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Vendors</h1>
          <p className="text-muted-foreground text-sm mt-1">Accounts Payable — {vendors.length} active vendors</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild><Button className="gap-2"><Plus className="w-4 h-4" /> New Vendor</Button></DialogTrigger>
          <DialogContent className="max-w-lg">
            <DialogHeader><DialogTitle>New Vendor</DialogTitle></DialogHeader>
            <div className="grid grid-cols-2 gap-3 mt-2">
              {[["name","Vendor Name *"],["nameAr","اسم المورد"],["taxNumber","VAT Number"],["crNumber","CR Number"],["phone","Phone"],["email","Email"],["address","Address"],["city","City"],["iban","IBAN"],["paymentTermsDays","Payment Terms (days)"]].map(([k,l])=>(
                <div key={k} className={k==="address"||k==="iban"?"col-span-2":""}>
                  <Label className="text-xs text-muted-foreground">{l}</Label>
                  <Input value={(form as any)[k]} onChange={e=>setForm(p=>({...p,[k]:e.target.value}))} className="mt-1 h-8 text-sm" />
                </div>
              ))}
            </div>
            <Button className="w-full mt-4" onClick={()=>createMut.mutate(form)} disabled={!form.name || createMut.isPending}>
              {createMut.isPending ? "Creating..." : "Create Vendor"}
            </Button>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <Card className="border-border bg-card"><CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">Total Vendors</CardTitle></CardHeader><CardContent><div className="text-2xl font-bold font-mono text-primary">{vendors.length}</div></CardContent></Card>
        <Card className="border-border bg-card"><CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">Total AP</CardTitle></CardHeader><CardContent><div className="text-2xl font-bold font-mono text-foreground">{fmtNum(vendors.reduce((s,v)=>s+(v.totalBilled??0),0))}</div></CardContent></Card>
        <Card className="border-border bg-card"><CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">Outstanding AP</CardTitle></CardHeader><CardContent><div className={`text-2xl font-bold font-mono ${totalAP > 0 ? "text-red-400" : "text-emerald-400"}`}>{fmtNum(totalAP)}</div></CardContent></Card>
      </div>

      <Card className="border-border bg-card">
        <CardHeader className="pb-3">
          <div className="relative max-w-xs">
            <Search className="absolute left-3 top-2.5 w-4 h-4 text-muted-foreground" />
            <Input placeholder="Search vendors..." className="pl-9 h-9" value={search} onChange={e=>setSearch(e.target.value)} />
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? <div className="text-muted-foreground text-sm p-4">Loading...</div> : vendors.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground"><Building2 className="w-8 h-8 mx-auto mb-3 opacity-40" /><p>No vendors yet. Add your first vendor.</p></div>
          ) : (
            <table className="w-full text-sm">
              <thead><tr className="border-b border-border text-muted-foreground text-xs uppercase">{["Vendor","City","VAT Number","IBAN","Total Bills","Outstanding",""].map(h=><th key={h} className="text-left pb-2 pr-4 font-medium">{h}</th>)}</tr></thead>
              <tbody>{vendors.map(v=>(
                <tr key={v.id} className="border-b border-border/50 hover:bg-secondary/20 transition-colors">
                  <td className="py-3 pr-4"><div className="font-medium text-foreground">{v.name}</div>{v.nameAr&&<div className="text-xs text-muted-foreground" dir="rtl">{v.nameAr}</div>}</td>
                  <td className="py-3 pr-4 text-muted-foreground">{v.city||"—"}</td>
                  <td className="py-3 pr-4 font-mono text-xs text-muted-foreground">{v.taxNumber||"—"}</td>
                  <td className="py-3 pr-4 font-mono text-xs text-muted-foreground">{v.iban ? `${v.iban.slice(0,12)}...` : "—"}</td>
                  <td className="py-3 pr-4 font-mono text-foreground">{fmtNum(v.totalBilled??0)}</td>
                  <td className="py-3 pr-4"><span className={`font-mono font-medium ${(v.balance??0)>0?"text-red-400":"text-emerald-400"}`}>{fmtNum(v.balance??0)}</span></td>
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
