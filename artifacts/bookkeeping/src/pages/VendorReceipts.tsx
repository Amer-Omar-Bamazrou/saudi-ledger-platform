import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, fmtNum, fmtDate } from "@/lib/api";
import { useLanguage } from "@/contexts/LanguageContext";
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
  const { t } = useLanguage();

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
    toast({ title: t("Receipt scanned", "تم مسح الإيصال"), description: t("Select the vendor and save.", "اختر المورد واحفظ.") });
  };

  const totalPaid = receipts.reduce((s, r) => s + r.amount, 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t("Vendor Receipts", "إيصالات الموردين")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t("Payments made to vendors — proof of payment", "المدفوعات للموردين — إثبات الدفع")}</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" className="gap-2" onClick={() => setScanOpen(true)}>
            <ScanLine className="w-4 h-4" /> {t("Scan Receipt", "مسح الإيصال")}
          </Button>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button className="gap-2"><Plus className="w-4 h-4" /> {t("New Receipt", "إيصال جديد")}</Button>
            </DialogTrigger>
            <DialogContent className="max-w-lg">
              <DialogHeader><DialogTitle>{t("New Vendor Receipt", "إيصال مورد جديد")}</DialogTitle></DialogHeader>
              <div className="space-y-3 mt-2">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label className="text-xs text-muted-foreground">{t("Receipt Number", "رقم الإيصال")}</Label>
                    <Input value={form.receiptNumber} onChange={e => setForm(p => ({ ...p, receiptNumber: e.target.value }))} className="mt-1 h-8 text-sm" />
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">{t("Bill / PO Reference", "مرجع الفاتورة / أمر الشراء")}</Label>
                    <Input value={form.billReference} onChange={e => setForm(p => ({ ...p, billReference: e.target.value }))} placeholder="BILL-XXXXXX" className="mt-1 h-8 text-sm" />
                  </div>
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">{t("Vendor", "مورد")}</Label>
                  <Select value={form.vendorId} onValueChange={v => setForm(p => ({ ...p, vendorId: v }))}>
                    <SelectTrigger className="mt-1 h-8 text-sm"><SelectValue placeholder={t("Select vendor…", "اختر مورداً…")} /></SelectTrigger>
                    <SelectContent>
                      {vendors.map(v => <SelectItem key={v.id} value={String(v.id)}>{v.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label className="text-xs text-muted-foreground">{t("Payment Date", "تاريخ الدفع")}</Label>
                    <Input type="date" value={form.date} onChange={e => setForm(p => ({ ...p, date: e.target.value }))} className="mt-1 h-8 text-sm" />
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">{t("Payment Method", "طريقة الدفع")}</Label>
                    <Select value={form.method} onValueChange={v => setForm(p => ({ ...p, method: v }))}>
                      <SelectTrigger className="mt-1 h-8 text-sm"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {[
                          ["cash", t("Cash", "نقدي")],
                          ["bank_transfer", t("Bank Transfer", "تحويل بنكي")],
                          ["cheque", t("Cheque", "شيك")],
                          ["card", t("Card", "بطاقة")],
                        ].map(([v, l]) => (
                          <SelectItem key={v} value={v}>{l}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">{t("Amount Paid (SAR)", "المبلغ المدفوع (ر.س)")}</Label>
                  <Input type="number" step="0.01" value={form.amount} onChange={e => setForm(p => ({ ...p, amount: e.target.value }))} placeholder="0.00" className="mt-1 h-8 text-sm font-mono" />
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">{t("Notes", "ملاحظات")}</Label>
                  <Input value={form.notes} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} className="mt-1 h-8 text-sm" />
                </div>
              </div>
              <Button className="w-full mt-4 bg-emerald-600 hover:bg-emerald-700" disabled={!form.vendorId || !form.amount}
                onClick={() => { toast({ title: t("Vendor receipt recorded", "تم تسجيل إيصال المورد") }); setOpen(false); setForm(makeEmpty()); }}>
                {t("Record Receipt", "تسجيل الإيصال")}
              </Button>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-4">
        {[
          [t("Total Receipts", "إجمالي الإيصالات"), receipts.length, "text-primary"],
          [t("Total Paid", "إجمالي المدفوع"), fmtNum(totalPaid), "text-red-400"],
          [t("Cash", "نقدي"), fmtNum(receipts.filter(r => r.method === "cash").reduce((s, r) => s + r.amount, 0)), "text-emerald-400"],
          [t("Bank Transfer", "تحويل بنكي"), fmtNum(receipts.filter(r => r.method === "bank_transfer").reduce((s, r) => s + r.amount, 0)), "text-blue-400"],
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
            <div className="text-sm text-muted-foreground p-4">{t("Loading…", "جارٍ التحميل…")}</div>
          ) : receipts.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground">
              <Store className="w-8 h-8 mx-auto mb-3 opacity-40" />
              <p className="text-sm">{t("No vendor receipts yet.", "لا توجد إيصالات موردين بعد.")}</p>
              <p className="text-xs mt-1 opacity-60">{t("Record a payment you made to a vendor.", "سجّل دفعة أجريتها لأحد الموردين.")}</p>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-muted-foreground text-xs uppercase">
                  {[t("Receipt #", "رقم الإيصال"), t("Vendor", "المورد"), t("Bill Ref", "مرجع الفاتورة"), t("Date", "التاريخ"), t("Method", "الطريقة"), t("Amount", "المبلغ")].map(h => (
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
