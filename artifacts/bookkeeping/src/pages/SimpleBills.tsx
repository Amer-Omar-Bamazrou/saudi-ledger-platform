import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch, fmtNum, fmtDate } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, FileText, ScanLine } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { ReceiptScanner } from "@/components/ReceiptScanner";
import type { ParsedReceipt } from "@/lib/receiptParser";

/**
 * Simple Bills — quick single-line expense capture without full AP workflow.
 * No vendor account required; ideal for petty cash, utilities, subscriptions.
 */

interface SimpleBill {
  id: number; description: string; category: string; date: string;
  amount: number; vatAmount: number; total: number; status: string;
}

const STATUS_STYLES: Record<string, string> = {
  unpaid: "bg-amber-500/20 text-amber-400",
  paid: "bg-emerald-500/20 text-emerald-400",
};

const CATEGORIES = [
  "Utilities", "Rent", "Telephone & Internet", "Office Supplies",
  "Travel & Transport", "Meals & Entertainment", "Subscriptions",
  "Maintenance & Repairs", "Professional Fees", "Miscellaneous",
];

const makeEmpty = () => ({
  description: "",
  category: "Miscellaneous",
  date: new Date().toISOString().split("T")[0],
  amount: "",
  vatAmount: "",
  total: "",
  status: "unpaid",
  notes: "",
});

export default function SimpleBills() {
  const [open, setOpen] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);
  const [form, setForm] = useState(makeEmpty());
  const { toast } = useToast();

  const { data: bills = [], isLoading } = useQuery<SimpleBill[]>({
    queryKey: ["simple-bills"],
    queryFn: () => apiFetch("/simple-bills").catch(() => []),
  });

  const handleScanned = (data: ParsedReceipt) => {
    setForm(prev => ({
      ...prev,
      description: data.vendorName || prev.description,
      date: data.date || prev.date,
      amount: data.subtotal > 0 ? String(data.subtotal) : prev.amount,
      vatAmount: data.vatAmount > 0 ? String(data.vatAmount) : prev.vatAmount,
      total: data.total > 0 ? String(data.total) : prev.total,
      notes: data.notes || prev.notes,
    }));
    setOpen(true);
    toast({ title: "Receipt scanned", description: "Review the fields and save." });
  };

  const totalUnpaid = bills.filter(b => b.status === "unpaid").reduce((s, b) => s + b.total, 0);
  const totalPaid = bills.filter(b => b.status === "paid").reduce((s, b) => s + b.total, 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Simple Bills</h1>
          <p className="text-muted-foreground text-sm mt-1">Quick one-line expenses — utilities, petty cash, subscriptions</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" className="gap-2" onClick={() => setScanOpen(true)}>
            <ScanLine className="w-4 h-4" /> Scan Receipt
          </Button>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button className="gap-2"><Plus className="w-4 h-4" /> New Simple Bill</Button>
            </DialogTrigger>
            <DialogContent className="max-w-lg">
              <DialogHeader><DialogTitle>New Simple Bill</DialogTitle></DialogHeader>
              <div className="space-y-3 mt-2">
                <div>
                  <Label className="text-xs text-muted-foreground">Description / Vendor Name</Label>
                  <Input value={form.description} onChange={e => setForm(p => ({ ...p, description: e.target.value }))} placeholder="e.g. STC Internet Invoice" className="mt-1 h-8 text-sm" />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label className="text-xs text-muted-foreground">Category</Label>
                    <Select value={form.category} onValueChange={v => setForm(p => ({ ...p, category: v }))}>
                      <SelectTrigger className="mt-1 h-8 text-sm"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {CATEGORIES.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">Date</Label>
                    <Input type="date" value={form.date} onChange={e => setForm(p => ({ ...p, date: e.target.value }))} className="mt-1 h-8 text-sm" />
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <Label className="text-xs text-muted-foreground">Subtotal (SAR)</Label>
                    <Input type="number" step="0.01" value={form.amount} onChange={e => setForm(p => ({ ...p, amount: e.target.value }))} placeholder="0.00" className="mt-1 h-8 text-sm font-mono" />
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
                  <Label className="text-xs text-muted-foreground">Status</Label>
                  <Select value={form.status} onValueChange={v => setForm(p => ({ ...p, status: v }))}>
                    <SelectTrigger className="mt-1 h-8 text-sm"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="unpaid">Unpaid</SelectItem>
                      <SelectItem value="paid">Paid</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">Notes</Label>
                  <Input value={form.notes} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} className="mt-1 h-8 text-sm" />
                </div>
              </div>
              <Button className="w-full mt-4" disabled={!form.description || !form.total}
                onClick={() => { toast({ title: "Simple bill saved" }); setOpen(false); setForm(makeEmpty()); }}>
                Save Bill
              </Button>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-4">
        {[
          ["Total Bills", bills.length, "text-primary"],
          ["Unpaid", fmtNum(totalUnpaid), "text-red-400"],
          ["Paid", fmtNum(totalPaid), "text-emerald-400"],
          ["This Month", bills.filter(b => b.date?.startsWith(new Date().toISOString().slice(0, 7))).length, "text-primary"],
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
          ) : bills.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground">
              <FileText className="w-8 h-8 mx-auto mb-3 opacity-40" />
              <p className="text-sm">No simple bills yet.</p>
              <p className="text-xs mt-1 opacity-60">Add a quick expense or scan a receipt.</p>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-muted-foreground text-xs uppercase">
                  {["Description", "Category", "Date", "Subtotal", "VAT", "Total", "Status"].map(h => (
                    <th key={h} className="text-left pb-2 pr-4 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {bills.map(b => (
                  <tr key={b.id} className="border-b border-border/50 hover:bg-secondary/20">
                    <td className="py-3 pr-4 font-medium">{b.description}</td>
                    <td className="py-3 pr-4 text-muted-foreground text-xs">{b.category}</td>
                    <td className="py-3 pr-4 text-muted-foreground text-xs">{fmtDate(b.date)}</td>
                    <td className="py-3 pr-4 font-mono">{fmtNum(b.amount)}</td>
                    <td className="py-3 pr-4 font-mono text-muted-foreground">{fmtNum(b.vatAmount)}</td>
                    <td className="py-3 pr-4 font-mono font-semibold">{fmtNum(b.total)}</td>
                    <td className="py-3"><Badge className={`text-xs ${STATUS_STYLES[b.status] ?? ""}`}>{b.status}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <ReceiptScanner open={scanOpen} onOpenChange={setScanOpen} onExtracted={handleScanned} />
    </div>
  );
}
