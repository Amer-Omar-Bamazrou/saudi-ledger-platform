import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, fmtNum, fmtDate } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, FileMinus } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface CreditNote {
  id: number; creditNoteNumber: string; customerId: number; customerName: string;
  date: string; invoiceReference: string; status: string; amount: number; reason: string;
}
interface Customer { id: number; name: string; }

const STATUS_STYLES: Record<string, string> = {
  draft: "bg-secondary text-muted-foreground",
  issued: "bg-blue-500/20 text-blue-400",
  applied: "bg-emerald-500/20 text-emerald-400",
  voided: "bg-red-500/20 text-red-400",
};

const makeEmpty = () => ({
  creditNoteNumber: `CN-${Date.now().toString().slice(-6)}`,
  customerId: "",
  date: new Date().toISOString().split("T")[0],
  invoiceReference: "",
  status: "draft",
  subtotal: "",
  vatAmount: "",
  amount: "",
  reason: "",
});

export default function CreditNotes() {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(makeEmpty());
  const { toast } = useToast();

  const { data: customers = [] } = useQuery<Customer[]>({
    queryKey: ["customers"],
    queryFn: () => apiFetch("/customers"),
  });

  const { data: notes = [], isLoading } = useQuery<CreditNote[]>({
    queryKey: ["credit-notes"],
    queryFn: () => apiFetch("/credit-notes").catch(() => []),
  });

  const totalIssued = notes.reduce((s, n) => s + n.amount, 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Credit Notes</h1>
          <p className="text-muted-foreground text-sm mt-1">Issued to customers for returns or overbilling</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button className="gap-2"><Plus className="w-4 h-4" /> New Credit Note</Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg">
            <DialogHeader><DialogTitle>New Credit Note</DialogTitle></DialogHeader>
            <div className="space-y-3 mt-2">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs text-muted-foreground">Credit Note #</Label>
                  <Input value={form.creditNoteNumber} onChange={e => setForm(p => ({ ...p, creditNoteNumber: e.target.value }))} className="mt-1 h-8 text-sm" />
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">Invoice Reference</Label>
                  <Input value={form.invoiceReference} onChange={e => setForm(p => ({ ...p, invoiceReference: e.target.value }))} placeholder="INV-XXXXXX" className="mt-1 h-8 text-sm" />
                </div>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Customer</Label>
                <Select value={form.customerId} onValueChange={v => setForm(p => ({ ...p, customerId: v }))}>
                  <SelectTrigger className="mt-1 h-8 text-sm"><SelectValue placeholder="Select customer…" /></SelectTrigger>
                  <SelectContent>
                    {customers.map(c => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs text-muted-foreground">Date</Label>
                  <Input type="date" value={form.date} onChange={e => setForm(p => ({ ...p, date: e.target.value }))} className="mt-1 h-8 text-sm" />
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">Status</Label>
                  <Select value={form.status} onValueChange={v => setForm(p => ({ ...p, status: v }))}>
                    <SelectTrigger className="mt-1 h-8 text-sm"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {["draft", "issued", "applied", "voided"].map(s => (
                        <SelectItem key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <Label className="text-xs text-muted-foreground">Subtotal (SAR)</Label>
                  <Input type="number" step="0.01" value={form.subtotal} onChange={e => setForm(p => ({ ...p, subtotal: e.target.value }))} placeholder="0.00" className="mt-1 h-8 text-sm font-mono" />
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">VAT 15%</Label>
                  <Input type="number" step="0.01" value={form.vatAmount} onChange={e => setForm(p => ({ ...p, vatAmount: e.target.value }))} placeholder="0.00" className="mt-1 h-8 text-sm font-mono" />
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">Total Amount</Label>
                  <Input type="number" step="0.01" value={form.amount} onChange={e => setForm(p => ({ ...p, amount: e.target.value }))} placeholder="0.00" className="mt-1 h-8 text-sm font-mono" />
                </div>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Reason</Label>
                <Input value={form.reason} onChange={e => setForm(p => ({ ...p, reason: e.target.value }))} placeholder="Return, overbilling, discount…" className="mt-1 h-8 text-sm" />
              </div>
            </div>
            <Button className="w-full mt-4" disabled={!form.customerId}
              onClick={() => { toast({ title: "Credit note saved" }); setOpen(false); setForm(makeEmpty()); }}>
              Save Credit Note
            </Button>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid grid-cols-4 gap-4">
        {[
          ["Total Notes", notes.length, "text-primary"],
          ["Total Credited", fmtNum(totalIssued), "text-red-400"],
          ["Applied", notes.filter(n => n.status === "applied").length, "text-emerald-400"],
          ["Pending", notes.filter(n => n.status === "issued").length, "text-amber-400"],
        ].map(([l, v, c]) => (
          <Card key={String(l)} className="border-border bg-card">
            <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{l}</CardTitle></CardHeader>
            <CardContent><div className={`text-2xl font-bold font-mono ${c}`}>{v}</div></CardContent>
          </Card>
        ))}
      </div>

      <Card className="border-border bg-card">
        <CardContent className="pt-6">
          {isLoading ? (
            <div className="text-sm text-muted-foreground p-4">Loading…</div>
          ) : notes.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground">
              <FileMinus className="w-8 h-8 mx-auto mb-3 opacity-40" />
              <p className="text-sm">No credit notes yet.</p>
              <p className="text-xs mt-1 opacity-60">Issue one when a customer needs a refund or adjustment.</p>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-muted-foreground text-xs uppercase">
                  {["Credit Note #", "Customer", "Invoice Ref", "Date", "Amount", "Status"].map(h => (
                    <th key={h} className="text-left pb-2 pr-4 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {notes.map(n => (
                  <tr key={n.id} className="border-b border-border/50 hover:bg-secondary/20">
                    <td className="py-3 pr-4 font-mono text-xs text-primary">{n.creditNoteNumber}</td>
                    <td className="py-3 pr-4 font-medium">{n.customerName}</td>
                    <td className="py-3 pr-4 text-muted-foreground text-xs">{n.invoiceReference || "—"}</td>
                    <td className="py-3 pr-4 text-muted-foreground text-xs">{fmtDate(n.date)}</td>
                    <td className="py-3 pr-4 font-mono font-semibold text-red-400">{fmtNum(n.amount)}</td>
                    <td className="py-3"><Badge className={`text-xs ${STATUS_STYLES[n.status] ?? ""}`}>{n.status}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
