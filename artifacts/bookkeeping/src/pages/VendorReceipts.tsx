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
import { Plus, Store, ScanLine } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { ReceiptScanner } from "@/components/ReceiptScanner";
import type { ParsedReceipt } from "@/lib/receiptParser";

interface VendorReceipt {
  id: number; receiptNumber: string; vendorId: number; vendorName: string;
  date: string; billReference: string; method: string; amount: number; notes: string;
}
interface Vendor { id: number; name: string; }

const METHOD_STYLES: Record<string, string> = {
  cash: "bg-emerald-500/20 text-emerald-400",
  bank_transfer: "bg-blue-500/20 text-blue-400",
  cheque: "bg-amber-500/20 text-amber-400",
  card: "bg-purple-500/20 text-purple-400",
};

const makeEmpty = () => ({
  receiptNumber: `VREC-${Date.now().toString().slice(-6)}`,
  vendorId: "",
  date: new Date().toISOString().split("T")[0],
  billReference: "",
  method: "bank_transfer",
  amount: "",
  notes: "",
});

export default function VendorReceipts() {
  const [open, setOpen] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);
  const [form, setForm] = useState(makeEmpty());
  const { toast } = useToast();

  const { data: vendors = [] } = useQuery<Vendor[]>({
    queryKey: ["vendors"],
    queryFn: () => apiFetch("/vendors"),
  });

  const { data: receipts = [], isLoading } = useQuery<VendorReceipt[]>({
    queryKey: ["vendor-receipts"],
    queryFn: () => apiFetch("/vendor-receipts").catch(() => []),
  });

  const handleScanned = (data: ParsedReceipt) => {
    setForm(prev => ({
      ...prev,
      billReference: data.vendorReference || prev.billReference,
      date: data.date || prev.date,
      amount: data.total > 0 ? String(data.total) : prev.amount,
      notes: [data.vendorName, data.notes].filter(Boolean).join(" · ") || prev.notes,
    }));
    setOpen(true);
    toast({ title: "Receipt scanned", description: "Select the vendor and save." });
  };

  const totalPaid = receipts.reduce((s, r) => s + r.amount, 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Vendor Receipts</h1>
          <p className="text-muted-foreground text-sm mt-1">Payments made to vendors — proof of payment</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" className="gap-2" onClick={() => setScanOpen(true)}>
            <ScanLine className="w-4 h-4" /> Scan Receipt
          </Button>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button className="gap-2"><Plus className="w-4 h-4" /> New Receipt</Button>
            </DialogTrigger>
            <DialogContent className="max-w-lg">
              <DialogHeader><DialogTitle>New Vendor Receipt</DialogTitle></DialogHeader>
              <div className="space-y-3 mt-2">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label className="text-xs text-muted-foreground">Receipt Number</Label>
                    <Input value={form.receiptNumber} onChange={e => setForm(p => ({ ...p, receiptNumber: e.target.value }))} className="mt-1 h-8 text-sm" />
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
                    <Label className="text-xs text-muted-foreground">Payment Date</Label>
                    <Input type="date" value={form.date} onChange={e => setForm(p => ({ ...p, date: e.target.value }))} className="mt-1 h-8 text-sm" />
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">Payment Method</Label>
                    <Select value={form.method} onValueChange={v => setForm(p => ({ ...p, method: v }))}>
                      <SelectTrigger className="mt-1 h-8 text-sm"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {[["cash", "Cash"], ["bank_transfer", "Bank Transfer"], ["cheque", "Cheque"], ["card", "Card"]].map(([v, l]) => (
                          <SelectItem key={v} value={v}>{l}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">Amount Paid (SAR)</Label>
                  <Input type="number" step="0.01" value={form.amount} onChange={e => setForm(p => ({ ...p, amount: e.target.value }))} placeholder="0.00" className="mt-1 h-8 text-sm font-mono" />
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">Notes</Label>
                  <Input value={form.notes} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} className="mt-1 h-8 text-sm" />
                </div>
              </div>
              <Button className="w-full mt-4 bg-emerald-600 hover:bg-emerald-700" disabled={!form.vendorId || !form.amount}
                onClick={() => { toast({ title: "Vendor receipt recorded" }); setOpen(false); setForm(makeEmpty()); }}>
                Record Receipt
              </Button>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-4">
        {[
          ["Total Receipts", receipts.length, "text-primary"],
          ["Total Paid", fmtNum(totalPaid), "text-red-400"],
          ["Cash", fmtNum(receipts.filter(r => r.method === "cash").reduce((s, r) => s + r.amount, 0)), "text-emerald-400"],
          ["Bank Transfer", fmtNum(receipts.filter(r => r.method === "bank_transfer").reduce((s, r) => s + r.amount, 0)), "text-blue-400"],
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
          ) : receipts.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground">
              <Store className="w-8 h-8 mx-auto mb-3 opacity-40" />
              <p className="text-sm">No vendor receipts yet.</p>
              <p className="text-xs mt-1 opacity-60">Record a payment you made to a vendor.</p>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-muted-foreground text-xs uppercase">
                  {["Receipt #", "Vendor", "Bill Ref", "Date", "Method", "Amount"].map(h => (
                    <th key={h} className="text-left pb-2 pr-4 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {receipts.map(r => (
                  <tr key={r.id} className="border-b border-border/50 hover:bg-secondary/20">
                    <td className="py-3 pr-4 font-mono text-xs text-primary">{r.receiptNumber}</td>
                    <td className="py-3 pr-4 font-medium">{r.vendorName}</td>
                    <td className="py-3 pr-4 text-muted-foreground text-xs">{r.billReference || "—"}</td>
                    <td className="py-3 pr-4 text-muted-foreground text-xs">{fmtDate(r.date)}</td>
                    <td className="py-3 pr-4"><Badge className={`text-xs ${METHOD_STYLES[r.method] ?? ""}`}>{r.method.replace("_", " ")}</Badge></td>
                    <td className="py-3 font-mono font-semibold text-red-400">{fmtNum(r.amount)}</td>
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
