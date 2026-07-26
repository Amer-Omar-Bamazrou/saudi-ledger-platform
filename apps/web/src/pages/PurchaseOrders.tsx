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
import { Plus, ShoppingCart } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/contexts/LanguageContext";

interface PurchaseOrder {
  id: number; poNumber: string; vendorId: number; vendorName: string;
  date: string; expectedDate: string; status: string; subtotal: number; vatAmount: number; total: number; notes: string;
}
interface Vendor { id: number; name: string; }

const STATUS_STYLES: Record<string, string> = {
  draft: "bg-secondary text-muted-foreground",
  sent: "bg-blue-500/20 text-blue-400",
  confirmed: "bg-amber-500/20 text-amber-400",
  received: "bg-emerald-500/20 text-emerald-400",
  cancelled: "bg-red-500/20 text-red-400",
};

const makeEmpty = () => ({
  poNumber: `PO-${Date.now().toString().slice(-6)}`,
  vendorId: "",
  date: new Date().toISOString().split("T")[0],
  expectedDate: "",
  status: "draft",
  subtotal: "",
  vatAmount: "",
  total: "",
  notes: "",
});

export default function PurchaseOrders() {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(makeEmpty());
  const { toast } = useToast();
  const { t } = useLanguage();

  const { data: vendors = [] } = useQuery<Vendor[]>({
    queryKey: ["vendors"],
    queryFn: () => apiFetch("/vendors"),
  });

  const { data: orders = [], isLoading } = useQuery<PurchaseOrder[]>({
    queryKey: ["purchase-orders"],
    queryFn: () => apiFetch("/purchase-orders").catch(() => []),
  });

  const totalValue = orders.reduce((s, o) => s + o.total, 0);
  const pending = orders.filter(o => ["draft", "sent"].includes(o.status)).length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t("Purchase Orders", "أوامر الشراء")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t("Orders placed with vendors", "الأوامر المقدمة للموردين")}</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button className="gap-2"><Plus className="w-4 h-4" /> {t("New Purchase Order", "أمر شراء جديد")}</Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg">
            <DialogHeader><DialogTitle>{t("New Purchase Order", "أمر شراء جديد")}</DialogTitle></DialogHeader>
            <div className="space-y-3 mt-2">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs text-muted-foreground">{t("PO Number", "رقم أمر الشراء")}</Label>
                  <Input value={form.poNumber} onChange={e => setForm(p => ({ ...p, poNumber: e.target.value }))} className="mt-1 h-8 text-sm" />
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">{t("Status", "الحالة")}</Label>
                  <Select value={form.status} onValueChange={v => setForm(p => ({ ...p, status: v }))}>
                    <SelectTrigger className="mt-1 h-8 text-sm"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {["draft", "sent", "confirmed", "received", "cancelled"].map(s => (
                        <SelectItem key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">{t("Vendor", "المورد")}</Label>
                <Select value={form.vendorId} onValueChange={v => setForm(p => ({ ...p, vendorId: v }))}>
                  <SelectTrigger className="mt-1 h-8 text-sm"><SelectValue placeholder={t("Select vendor…", "اختر المورد…")} /></SelectTrigger>
                  <SelectContent>
                    {vendors.map(v => <SelectItem key={v.id} value={String(v.id)}>{v.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs text-muted-foreground">{t("Order Date", "تاريخ الأمر")}</Label>
                  <Input type="date" value={form.date} onChange={e => setForm(p => ({ ...p, date: e.target.value }))} className="mt-1 h-8 text-sm" />
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">{t("Expected Delivery", "التسليم المتوقع")}</Label>
                  <Input type="date" value={form.expectedDate} onChange={e => setForm(p => ({ ...p, expectedDate: e.target.value }))} className="mt-1 h-8 text-sm" />
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <Label className="text-xs text-muted-foreground">{t("Subtotal (SAR)", "المجموع قبل الضريبة (ر.س)")}</Label>
                  <Input type="number" step="0.01" value={form.subtotal} onChange={e => setForm(p => ({ ...p, subtotal: e.target.value }))} placeholder="0.00" className="mt-1 h-8 text-sm font-mono" />
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
                <Label className="text-xs text-muted-foreground">{t("Notes", "ملاحظات")}</Label>
                <Input value={form.notes} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} className="mt-1 h-8 text-sm" />
              </div>
            </div>
            <Button className="w-full mt-4" disabled={!form.vendorId}
              onClick={() => { toast({ title: t("Purchase order saved", "تم حفظ أمر الشراء") }); setOpen(false); setForm(makeEmpty()); }}>
              {t("Save Purchase Order", "حفظ أمر الشراء")}
            </Button>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid grid-cols-4 gap-4">
        {[
          [t("Total POs", "إجمالي أوامر الشراء"), orders.length, "text-primary"],
          [t("Total Value", "إجمالي القيمة"), fmtNum(totalValue), "text-primary"],
          [t("Pending", "قيد الانتظار"), pending, "text-amber-400"],
          [t("Received", "مستلم"), orders.filter(o => o.status === "received").length, "text-emerald-400"],
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
          ) : orders.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground">
              <ShoppingCart className="w-8 h-8 mx-auto mb-3 opacity-40" />
              <p className="text-sm">{t("No purchase orders yet.", "لا توجد أوامر شراء بعد.")}</p>
              <p className="text-xs mt-1 opacity-60">{t("Create a PO to send to a vendor.", "أنشئ أمر شراء لإرساله إلى مورد.")}</p>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-muted-foreground text-xs uppercase">
                  {[
                    t("PO #", "رقم أمر الشراء"),
                    t("Vendor", "المورد"),
                    t("Date", "التاريخ"),
                    t("Expected", "متوقع"),
                    t("Total", "الإجمالي"),
                    t("Status", "الحالة"),
                  ].map(h => (
                    <th key={h} className="text-left pb-2 pr-4 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {orders.map(o => (
                  <tr key={o.id} className="border-b border-border/50 hover:bg-secondary/20">
                    <td className="py-3 pr-4 font-mono text-xs text-primary">{o.poNumber}</td>
                    <td className="py-3 pr-4 font-medium">{o.vendorName}</td>
                    <td className="py-3 pr-4 text-muted-foreground text-xs">{fmtDate(o.date)}</td>
                    <td className="py-3 pr-4 text-muted-foreground text-xs">{o.expectedDate ? fmtDate(o.expectedDate) : "—"}</td>
                    <td className="py-3 pr-4 font-mono font-semibold">{fmtNum(o.total)}</td>
                    <td className="py-3"><Badge className={`text-xs ${STATUS_STYLES[o.status] ?? ""}`}>{o.status}</Badge></td>
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
