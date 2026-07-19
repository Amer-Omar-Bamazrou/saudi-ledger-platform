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
import { Plus, FilePlus } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface DebitNote {
  id: number; debitNoteNumber: string; vendorId: number; vendorName: string;
  date: string; billReference: string; status: string; amount: number; reason: string;
}
interface Vendor { id: number; name: string; }

const STATUS_STYLES: Record<string, string> = {
  draft: "bg-secondary text-muted-foreground",
  issued: "bg-blue-500/20 text-blue-400",
  applied: "bg-emerald-500/20 text-emerald-400",
  voided: "bg-red-500/20 text-red-400",
};

const makeEmpty = () => ({
  debitNoteNumber: `DN-${Date.now().toString().slice(-6)}`,
  vendorId: "",
  date: new Date().toISOString().split("T")[0],
  billReference: "",
  status: "draft",
  subtotal: "",
  vatAmount: "",
  amount: "",
  reason: "",
});

export default function DebitNotes() {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(makeEmpty());
  const { toast } = useToast();

  const { data: vendors = [] } = useQuery<Vendor[]>({
    queryKey: ["vendors"],
    queryFn: () => apiFetch("/vendors"),
  });

  const { data: notes = [], isLoading } = useQuery<DebitNote[]>({
    queryKey: ["debit-notes"],
    queryFn: () => apiFetch("/debit-notes").catch(() => []),
  });

  const totalIssued = notes.reduce((s, n) => s + n.amount, 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Debit Notes</h1>
          <p className="text-muted-foreground text-sm mt-1">Raised against vendors for returns or underbilling</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button className="gap-2"><Plus className="w-4 h-4" /> New Debit Note</Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg">
            <DialogHeader><DialogTitle>New Debit Note</DialogTitle></DialogHeader>
            <div className="space-y-3 mt-2">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs text-muted-foreground">Debit Note #</Label>
                  <Input value={form.debitNoteNumber} onChange={e => setForm(p => ({ ...p, debitNoteNumber: e.target.value }))} className="mt-1 h-8 text-sm" />
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">Bill / PO Reference</Label>
                  <Input value={form.billReference} onChange={e => setForm(p => ({ ...p, billReference: e.target.value }))} placeholder="BILL-XXXXXX" className="mt-1 h-8 text-sm" />
                </div>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Vendor</Label>
                <Select value={form.vendorId} onValueChange={v => setForm(p => ({ ...p, vendorId: v }))}>
                  <SelectTrigger className="mt-1 h-8 text-sm"><SelectValue placeholder="Select vendor…" /></SelectTrigger>
                  <SelectContent>
                    {vendors.map(v => <SelectItem key={v.id} value={String(v.id)}>{v.name}</SelectItem>)}
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
                <Input value={form.reason} onChange={e => setForm(p => ({ ...p, reason: e.target.value }))} placeholder="Return, price discrepancy…" className="mt-1 h-8 text-sm" />
              </div>
            </div>
            <Button className="w-full mt-4" disabled={!form.vendorId}
              onClick={() => { toast({ title: "Debit note saved" }); setOpen(false); setForm(makeEmpty()); }}>
              Save Debit Note
            </Button>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid grid-cols-4 gap-4">
        {[
          ["Total Notes", notes.length, "text-primary"],
          ["Total Deducted", fmtNum(totalIssued), "text-amber-400"],
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
              <FilePlus className="w-8 h-8 mx-auto mb-3 opacity-40" />
              <p className="text-sm">No debit notes yet.</p>
              <p className="text-xs mt-1 opacity-60">Raise one when a vendor owes you a credit.</p>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-muted-foreground text-xs uppercase">
                  {["Debit Note #", "Vendor", "Bill Ref", "Date", "Amount", "Status"].map(h => (
                    <th key={h} className="text-left pb-2 pr-4 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {notes.map(n => (
                  <tr key={n.id} className="border-b border-border/50 hover:bg-secondary/20">
                    <td className="py-3 pr-4 font-mono text-xs text-primary">{n.debitNoteNumber}</td>
                    <td className="py-3 pr-4 font-medium">{n.vendorName}</td>
                    <td className="py-3 pr-4 text-muted-foreground text-xs">{n.billReference || "—"}</td>
                    <td className="py-3 pr-4 text-muted-foreground text-xs">{fmtDate(n.date)}</td>
                    <td className="py-3 pr-4 font-mono font-semibold text-amber-400">{fmtNum(n.amount)}</td>
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
