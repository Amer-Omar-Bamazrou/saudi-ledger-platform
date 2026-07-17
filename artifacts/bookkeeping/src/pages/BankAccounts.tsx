import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Plus, Landmark, CreditCard } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface BankAccount { id: number; name: string; bankName: string; accountNumber?: string; iban?: string; currency: string; balance: number; openingBalance: number; isDefault: boolean; isActive: boolean; notes?: string; }

const SAUDI_BANKS = ["Al-Rajhi Bank الراجحي","Saudi National Bank SNB","Riyad Bank بنك الرياض","Banque Saudi Fransi","Arab National Bank ANB","Saudi British Bank SABB","Alinma Bank بنك الإنماء","Al-Jazira Bank بنك الجزيرة","SAMBA Financial Group","Albilad Bank بنك البلاد"];

const emptyForm = { name: "", bankName: "", accountNumber: "", iban: "", currency: "SAR", balance: "", isDefault: false, notes: "" };

export default function BankAccounts() {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data: accounts = [], isLoading } = useQuery<BankAccount[]>({ queryKey: ["bank-accounts"], queryFn: () => apiFetch("/bank-accounts") });

  const createMut = useMutation({
    mutationFn: (body: any) => apiFetch("/bank-accounts", { method: "POST", body: JSON.stringify({ ...body, balance: Number(body.balance || 0), openingBalance: Number(body.balance || 0) }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["bank-accounts"] }); setOpen(false); setForm(emptyForm); toast({ title: "Bank account added" }); },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const totalBalance = accounts.filter(a => a.isActive && a.currency === "SAR").reduce((s, a) => s + a.balance, 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Bank Accounts</h1>
          <p className="text-muted-foreground text-sm mt-1">Cash & banking · {accounts.length} accounts</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild><Button className="gap-2"><Plus className="w-4 h-4" /> Add Account</Button></DialogTrigger>
          <DialogContent className="max-w-md">
            <DialogHeader><DialogTitle>Add Bank Account</DialogTitle></DialogHeader>
            <div className="space-y-3 mt-2">
              <div><Label className="text-xs text-muted-foreground">Account Name *</Label><Input value={form.name} onChange={e=>setForm(p=>({...p,name:e.target.value}))} className="mt-1 h-8 text-sm" placeholder="e.g., Al-Rajhi Business Account" /></div>
              <div><Label className="text-xs text-muted-foreground">Bank *</Label>
                <select className="w-full mt-1 h-8 text-sm rounded-md border border-input bg-background px-3 py-1" value={form.bankName} onChange={e=>setForm(p=>({...p,bankName:e.target.value}))}>
                  <option value="">Select bank...</option>
                  {SAUDI_BANKS.map(b=><option key={b} value={b}>{b}</option>)}
                  <option value="Other">Other</option>
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div><Label className="text-xs text-muted-foreground">Account Number</Label><Input value={form.accountNumber} onChange={e=>setForm(p=>({...p,accountNumber:e.target.value}))} className="mt-1 h-8 text-sm font-mono" /></div>
                <div><Label className="text-xs text-muted-foreground">Currency</Label><Input value={form.currency} onChange={e=>setForm(p=>({...p,currency:e.target.value}))} className="mt-1 h-8 text-sm" /></div>
              </div>
              <div><Label className="text-xs text-muted-foreground">IBAN (SA00 0000 0000 0000 0000 0000)</Label><Input value={form.iban} onChange={e=>setForm(p=>({...p,iban:e.target.value}))} className="mt-1 h-8 text-sm font-mono" /></div>
              <div><Label className="text-xs text-muted-foreground">Opening Balance (SAR)</Label><Input type="number" value={form.balance} onChange={e=>setForm(p=>({...p,balance:e.target.value}))} className="mt-1 h-8 text-sm font-mono" /></div>
            </div>
            <Button className="w-full mt-4" onClick={()=>createMut.mutate(form)} disabled={!form.name||!form.bankName||createMut.isPending}>{createMut.isPending?"Adding...":"Add Account"}</Button>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <Card className="border-border bg-card"><CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">Total Cash (SAR)</CardTitle></CardHeader><CardContent><div className="text-2xl font-bold font-mono text-emerald-400">{fmtNum(totalBalance)}</div></CardContent></Card>
        <Card className="border-border bg-card"><CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">Accounts</CardTitle></CardHeader><CardContent><div className="text-2xl font-bold font-mono text-primary">{accounts.length}</div></CardContent></Card>
        <Card className="border-border bg-card"><CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">Banks</CardTitle></CardHeader><CardContent><div className="text-2xl font-bold font-mono text-foreground">{new Set(accounts.map(a=>a.bankName)).size}</div></CardContent></Card>
      </div>

      {isLoading ? <div className="text-muted-foreground text-sm p-4">Loading...</div> : accounts.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground"><Landmark className="w-8 h-8 mx-auto mb-3 opacity-40" /><p>No bank accounts yet.</p></div>
      ) : (
        <div className="grid grid-cols-2 gap-4">
          {accounts.map(acc=>(
            <Card key={acc.id} className={`border-border bg-card transition-colors hover:border-primary/30 ${acc.isDefault?"border-primary/30":""}`}>
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <CreditCard className="w-4 h-4 text-primary" />
                      <span className="font-semibold text-foreground">{acc.name}</span>
                      {acc.isDefault && <Badge className="text-xs bg-primary/20 text-primary">Default</Badge>}
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">{acc.bankName}</p>
                  </div>
                  <span className="text-xs font-mono text-muted-foreground">{acc.currency}</span>
                </div>
              </CardHeader>
              <CardContent>
                <div className={`text-3xl font-bold font-mono ${acc.balance >= 0 ? "text-emerald-400" : "text-red-400"}`}>{fmtNum(acc.balance)}</div>
                <div className="flex items-center justify-between mt-3 pt-3 border-t border-border">
                  <div className="text-xs text-muted-foreground">IBAN: <span className="font-mono">{acc.iban ? acc.iban.slice(0, 16) + "..." : "—"}</span></div>
                  <div className="text-xs text-muted-foreground">A/C: <span className="font-mono">{acc.accountNumber || "—"}</span></div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
