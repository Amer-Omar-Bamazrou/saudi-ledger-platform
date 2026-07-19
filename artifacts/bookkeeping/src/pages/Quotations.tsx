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
import { Plus, ClipboardList } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface Quotation {
  id: number; quoteNumber: string; customerId: number; customerName: string;
  date: string; expiryDate: string; status: string; total: number; notes: string;
}
interface Customer { id: number; name: string; }

const STATUS_STYLES: Record<string, string> = {
  draft: "bg-secondary text-muted-foreground",
  sent: "bg-blue-500/20 text-blue-400",
  accepted: "bg-emerald-500/20 text-emerald-400",
  rejected: "bg-red-500/20 text-red-400",
  expired: "bg-amber-500/20 text-amber-400",
};

const makeEmpty = () => ({
  quoteNumber: `QUO-${Date.now().toString().slice(-6)}`,
  customerId: "",
  date: new Date().toISOString().split("T")[0],
  expiryDate: "",
  status: "draft",
  subtotal: "",
  vatAmount: "",
  total: "",
  notes: "",
});

export default function Quotations() {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(makeEmpty());
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data: customers = [] } = useQuery<Customer[]>({
    queryKey: ["customers"],
    queryFn: () => apiFetch("/customers"),
  });

  // Quotations endpoint — gracefully empty until backend is wired
  const { data: quotes = [], isLoading } = useQuery<Quotation[]>({
    queryKey: ["quotations"],
    queryFn: () => apiFetch("/quotations").catch(() => []),
  });

  const total = quotes.reduce((s, q) => s + q.total, 0);
  const accepted = quotes.filter(q => q.status === "accepted").length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Quotations</h1>
          <p className="text-muted-foreground text-sm mt-1">Sales quotes sent to customers</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button className="gap-2"><Plus className="w-4 h-4" /> New Quotation</Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg">
            <DialogHeader><DialogTitle>New Quotation</DialogTitle></DialogHeader>
            <div className="space-y-3 mt-2">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs text-muted-foreground">Quote Number</Label>
                  <Input value={form.quoteNumber} onChange={e => setForm(p => ({ ...p, quoteNumber: e.target.value }))} className="mt-1 h-8 text-sm" />
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">Status</Label>
                  <Select value={form.status} onValueChange={v => setForm(p => ({ ...p, status: v }))}>
                    <SelectTrigger className="mt-1 h-8 text-sm"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {["draft", "sent", "accepted", "rejected", "expired"].map(s => (
                        <SelectItem key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
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
                  <Label className="text-xs text-muted-foreground">Expiry Date</Label>
                  <Input type="date" value={form.expiryDate} onChange={e => setForm(p => ({ ...p, expiryDate: e.target.value }))} className="mt-1 h-8 text-sm" />
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
                  <Label className="text-xs text-muted-foreground">Total (SAR)</Label>
                  <Input type="number" step="0.01" value={form.total} onChange={e => setForm(p => ({ ...p, total: e.target.value }))} placeholder="0.00" className="mt-1 h-8 text-sm font-mono" />
                </div>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Notes</Label>
                <Input value={form.notes} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} className="mt-1 h-8 text-sm" />
              </div>
            </div>
            <Button className="w-full mt-4" disabled={!form.customerId}
              onClick={() => { toast({ title: "Quotation saved (local)" }); setOpen(false); setForm(makeEmpty()); }}>
              Save Quotation
            </Button>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid grid-cols-4 gap-4">
        {[
          ["Total Quotes", quotes.length, "text-primary"],
          ["Total Value", fmtNum(total), "text-primary"],
          ["Accepted", accepted, "text-emerald-400"],
          ["Pending", quotes.filter(q => q.status === "sent").length, "text-amber-400"],
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
            <div className="text-muted-foreground text-sm p-4">Loading…</div>
          ) : quotes.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground">
              <ClipboardList className="w-8 h-8 mx-auto mb-3 opacity-40" />
              <p className="text-sm">No quotations yet.</p>
              <p className="text-xs mt-1 opacity-60">Create a quote to send to a customer.</p>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-muted-foreground text-xs uppercase">
                  {["Quote #", "Customer", "Date", "Expiry", "Total", "Status"].map(h => (
                    <th key={h} className="text-left pb-2 pr-4 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {quotes.map(q => (
                  <tr key={q.id} className="border-b border-border/50 hover:bg-secondary/20">
                    <td className="py-3 pr-4 font-mono text-xs text-primary">{q.quoteNumber}</td>
                    <td className="py-3 pr-4 font-medium">{q.customerName}</td>
                    <td className="py-3 pr-4 text-muted-foreground text-xs">{fmtDate(q.date)}</td>
                    <td className="py-3 pr-4 text-muted-foreground text-xs">{q.expiryDate ? fmtDate(q.expiryDate) : "—"}</td>
                    <td className="py-3 pr-4 font-mono font-semibold">{fmtNum(q.total)}</td>
                    <td className="py-3"><Badge className={`text-xs ${STATUS_STYLES[q.status] ?? ""}`}>{q.status}</Badge></td>
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
