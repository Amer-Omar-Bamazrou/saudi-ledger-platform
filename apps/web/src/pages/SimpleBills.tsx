import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch, fmtNum, fmtDate } from "@/lib/api";
import { useLanguage } from "@/contexts/LanguageContext";
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
  const { t } = useLanguage();

  const { data: bills = [], isLoading } = useQuery<SimpleBill[]>({
    queryKey: ["simple-bills"],
    queryFn: () => apiFetch<SimpleBill[]>("/simple-bills").catch(() => [] as SimpleBill[]),
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
    toast({ title: t("Receipt scanned", "تم مسح الإيصال"), description: t("Review the fields and save.", "راجع الحقول واحفظ.") });
  };

  const totalUnpaid = bills.filter(b => b.status === "unpaid").reduce((s, b) => s + b.total, 0);
  const totalPaid = bills.filter(b => b.status === "paid").reduce((s, b) => s + b.total, 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t("Simple Bills", "الفواتير البسيطة")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t("Quick one-line expenses — utilities, petty cash, subscriptions", "مصروفات سريعة بسطر واحد — مرافق، عهدة نثرية، اشتراكات")}</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" className="gap-2" onClick={() => setScanOpen(true)}>
            <ScanLine className="w-4 h-4" /> {t("Scan Receipt", "مسح الإيصال")}
          </Button>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button className="gap-2"><Plus className="w-4 h-4" /> {t("New Simple Bill", "فاتورة بسيطة جديدة")}</Button>
            </DialogTrigger>
            <DialogContent className="max-w-lg">
              <DialogHeader><DialogTitle>{t("New Simple Bill", "فاتورة بسيطة جديدة")}</DialogTitle></DialogHeader>
              <div className="space-y-3 mt-2">
                <div>
                  <Label className="text-xs text-muted-foreground">{t("Description / Vendor Name", "الوصف / اسم المورد")}</Label>
                  <Input value={form.description} onChange={e => setForm(p => ({ ...p, description: e.target.value }))} placeholder={t("e.g. STC Internet Invoice", "مثال: فاتورة إنترنت STC")} className="mt-1 h-8 text-sm" />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label className="text-xs text-muted-foreground">{t("Category", "الفئة")}</Label>
                    <Select value={form.category} onValueChange={v => setForm(p => ({ ...p, category: v }))}>
                      <SelectTrigger className="mt-1 h-8 text-sm"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {CATEGORIES.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">{t("Date", "التاريخ")}</Label>
                    <Input type="date" value={form.date} onChange={e => setForm(p => ({ ...p, date: e.target.value }))} className="mt-1 h-8 text-sm" />
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <Label className="text-xs text-muted-foreground">{t("Subtotal (SAR)", "المجموع الفرعي (ر.س)")}</Label>
                    <Input type="number" step="0.01" value={form.amount} onChange={e => setForm(p => ({ ...p, amount: e.target.value }))} placeholder="0.00" className="mt-1 h-8 text-sm font-mono" />
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">{t("VAT 15%", "ضريبة القيمة المضافة 15%")}</Label>
                    <Input type="number" step="0.01" value={form.vatAmount} onChange={e => setForm(p => ({ ...p, vatAmount: e.target.value }))} placeholder="0.00" className="mt-1 h-8 text-sm font-mono" />
                  </div>
                  <div>
                    <Label className="text-xs text-muted-foreground">{t("Total (SAR)", "الإجمالي (ر.س)")}</Label>
                    <Input type="number" step="0.01" value={form.total} onChange={e => setForm(p => ({ ...p, total: e.target.value }))} placeholder="0.00" className="mt-1 h-8 text-sm font-mono" />
                  </div>
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">{t("Status", "الحالة")}</Label>
                  <Select value={form.status} onValueChange={v => setForm(p => ({ ...p, status: v }))}>
                    <SelectTrigger className="mt-1 h-8 text-sm"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="unpaid">{t("Unpaid", "غير مدفوع")}</SelectItem>
                      <SelectItem value="paid">{t("Paid", "مدفوع")}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">{t("Notes", "ملاحظات")}</Label>
                  <Input value={form.notes} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} className="mt-1 h-8 text-sm" />
                </div>
              </div>
              <Button className="w-full mt-4" disabled={!form.description || !form.total}
                onClick={() => { toast({ title: t("Simple bill saved", "تم حفظ الفاتورة البسيطة") }); setOpen(false); setForm(makeEmpty()); }}>
                {t("Save Bill", "حفظ الفاتورة")}
              </Button>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-4">
        {[
          [t("Total Bills", "إجمالي الفواتير"), bills.length, "text-primary"],
          [t("Unpaid", "غير مدفوع"), fmtNum(totalUnpaid), "text-red-400"],
          [t("Paid", "مدفوع"), fmtNum(totalPaid), "text-emerald-400"],
          [t("This Month", "هذا الشهر"), bills.filter(b => b.date?.startsWith(new Date().toISOString().slice(0, 7))).length, "text-primary"],
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
          ) : bills.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground">
              <FileText className="w-8 h-8 mx-auto mb-3 opacity-40" />
              <p className="text-sm">{t("No simple bills yet.", "لا توجد فواتير بسيطة بعد.")}</p>
              <p className="text-xs mt-1 opacity-60">{t("Add a quick expense or scan a receipt.", "أضف مصروفاً سريعاً أو امسح إيصالاً.")}</p>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-muted-foreground text-xs uppercase">
                  {[t("Description", "الوصف"), t("Category", "الفئة"), t("Date", "التاريخ"), t("Subtotal", "المجموع الفرعي"), t("VAT", "ضريبة القيمة المضافة"), t("Total", "الإجمالي"), t("Status", "الحالة")].map(h => (
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
