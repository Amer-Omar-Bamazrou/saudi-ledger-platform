import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { useLanguage } from "@/contexts/LanguageContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, ReceiptText, ScanLine } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { ReceiptScanner } from "@/components/ReceiptScanner";
import type { ParsedReceipt } from "@/lib/receiptParser";
import { DualDate } from "@/components/DualDate";

interface CustomerReceipt {
  id: number; receiptNumber: string; customerId: number; customerName: string;
  date: string; invoiceReference: string; method: string; amount: number; notes: string;
}
interface Customer { id: number; name: string; }

const METHOD_STYLES: Record<string, string> = {
  cash: "bg-emerald-500/20 text-emerald-400",
  bank_transfer: "bg-blue-500/20 text-blue-400",
  cheque: "bg-amber-500/20 text-amber-400",
  card: "bg-purple-500/20 text-purple-400",
};

const makeEmpty = () => ({
  receiptNumber: `REC-${Date.now().toString().slice(-6)}`,
  customerId: "",
  date: new Date().toISOString().split("T")[0],
  invoiceReference: "",
  method: "bank_transfer",
  amount: "",
  notes: "",
});

export default function CustomerReceipts() {
  const [open, setOpen] = useState(false);
  const [scanOpen, setScanOpen] = useState(false);
  const [form, setForm] = useState(makeEmpty());
  const { toast } = useToast();
  const { t } = useLanguage();

  const { data: customers = [] } = useQuery<Customer[]>({
    queryKey: ["customers"],
    queryFn: () => apiFetch("/customers"),
  });

  const { data: receipts = [], isLoading } = useQuery<CustomerReceipt[]>({
    queryKey: ["customer-receipts"],
    queryFn: () => apiFetch<CustomerReceipt[]>("/customer-receipts").catch(() => [] as CustomerReceipt[]),
  });

  const handleScanned = (data: ParsedReceipt) => {
    setForm(prev => ({
      ...prev,
      invoiceReference: data.vendorReference || prev.invoiceReference,
      date: data.date || prev.date,
      amount: data.total > 0 ? String(data.total) : prev.amount,
      notes: data.notes || prev.notes,
    }));
    setOpen(true);
    toast({ title: t("Receipt scanned", "تم مسح الإيصال"), description: t("Fields pre-filled. Select the customer and save.", "تم ملء الحقول مسبقاً. اختر العميل واحفظ.") });
  };

  const totalReceived = receipts.reduce((s, r) => s + r.amount, 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t("Customer Receipts", "إيصالات العملاء")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t("Payments received from customers", "المدفوعات الواردة من العملاء")}</p>
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
              <DialogHeader><DialogTitle>{t("New Customer Receipt", "إيصال عميل جديد")}</DialogTitle></DialogHeader>
              <div className="space-y-3 mt-2">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label className="text-xs text-muted-foreground">{t("Receipt Number", "رقم الإيصال")}</Label>
                    <Input value={form.receiptNumber} onChange={e => setForm(p => ({ ...p, receiptNumber: e.target.value }))} className="mt-1 h-8 text-sm" />
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">{t("Invoice Reference", "مرجع الفاتورة")}</Label>
                    <Input value={form.invoiceReference} onChange={e => setForm(p => ({ ...p, invoiceReference: e.target.value }))} placeholder="INV-XXXXXX" className="mt-1 h-8 text-sm" />
                  </div>
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">{t("Customer", "عميل")}</Label>
                  <Select value={form.customerId} onValueChange={v => setForm(p => ({ ...p, customerId: v }))}>
                    <SelectTrigger className="mt-1 h-8 text-sm"><SelectValue placeholder={t("Select customer…", "اختر عميلاً…")} /></SelectTrigger>
                    <SelectContent>
                      {customers.map(c => <SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label className="text-xs text-muted-foreground">{t("Date", "التاريخ")}</Label>
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
                  <Label className="text-xs text-muted-foreground">{t("Amount Received (SAR)", "المبلغ المستلم (ر.س)")}</Label>
                  <Input type="number" step="0.01" value={form.amount} onChange={e => setForm(p => ({ ...p, amount: e.target.value }))} placeholder="0.00" className="mt-1 h-8 text-sm font-mono" />
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">{t("Notes", "ملاحظات")}</Label>
                  <Input value={form.notes} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} className="mt-1 h-8 text-sm" />
                </div>
              </div>
              <Button className="w-full mt-4 bg-emerald-600 hover:bg-emerald-700" disabled={!form.customerId || !form.amount}
                onClick={() => { toast({ title: t("Receipt recorded", "تم تسجيل الإيصال") }); setOpen(false); setForm(makeEmpty()); }}>
                {t("Record Receipt", "تسجيل الإيصال")}
              </Button>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-4">
        {[
          [t("Total Receipts", "إجمالي الإيصالات"), receipts.length, "text-primary"],
          [t("Total Received", "إجمالي المستلم"), fmtNum(totalReceived), "text-emerald-400"],
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
              <ReceiptText className="w-8 h-8 mx-auto mb-3 opacity-40" />
              <p className="text-sm">{t("No customer receipts yet.", "لا توجد إيصالات عملاء بعد.")}</p>
              <p className="text-xs mt-1 opacity-60">{t("Record a payment received from a customer.", "سجّل دفعة واردة من أحد العملاء.")}</p>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-muted-foreground text-xs uppercase">
                  {[t("Receipt #", "رقم الإيصال"), t("Customer", "العميل"), t("Invoice Ref", "مرجع الفاتورة"), t("Date", "التاريخ"), t("Method", "الطريقة"), t("Amount", "المبلغ")].map(h => (
                    <th key={h} className="text-left pb-2 pr-4 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {receipts.map(r => (
                  <tr key={r.id} className="border-b border-border/50 hover:bg-secondary/20">
                    <td className="py-3 pr-4 font-mono text-xs text-primary">{r.receiptNumber}</td>
                    <td className="py-3 pr-4 font-medium">{r.customerName}</td>
                    <td className="py-3 pr-4 text-muted-foreground text-xs">{r.invoiceReference || "—"}</td>
                    <td className="py-3 pr-4 text-muted-foreground text-xs"><DualDate date={r.date} /></td>
                    <td className="py-3 pr-4"><Badge className={`text-xs ${METHOD_STYLES[r.method] ?? ""}`}>{r.method.replace("_", " ")}</Badge></td>
                    <td className="py-3 font-mono font-semibold text-emerald-400">{fmtNum(r.amount)}</td>
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
