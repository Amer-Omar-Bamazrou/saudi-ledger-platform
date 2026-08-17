import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, ClipboardList } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/contexts/LanguageContext";
import { DualDate } from "@/components/DualDate";

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
  const { t } = useLanguage();

  const { data: customers = [] } = useQuery<Customer[]>({
    queryKey: ["customers"],
    queryFn: () => apiFetch("/customers"),
  });

  // Quotations endpoint — gracefully empty until backend is wired
  const { data: quotes = [], isLoading } = useQuery<Quotation[]>({
    queryKey: ["quotations"],
    queryFn: () => apiFetch<Quotation[]>("/quotations").catch(() => [] as Quotation[]),
  });

  const total = quotes.reduce((s, q) => s + q.total, 0);
  const accepted = quotes.filter(q => q.status === "accepted").length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t("Quotations", "عروض الأسعار")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t("Sales quotes sent to customers", "عروض الأسعار المرسلة للعملاء")}</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button className="gap-2"><Plus className="w-4 h-4" /> {t("New Quotation", "عرض سعر جديد")}</Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg">
            <DialogHeader><DialogTitle>{t("New Quotation", "عرض سعر جديد")}</DialogTitle></DialogHeader>
            <div className="space-y-3 mt-2">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs text-muted-foreground">{t("Quote Number", "رقم عرض السعر")}</Label>
                  <Input value={form.quoteNumber} onChange={e => setForm(p => ({ ...p, quoteNumber: e.target.value }))} className="mt-1 h-8 text-sm" />
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">{t("Status", "الحالة")}</Label>
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
                <Label className="text-xs text-muted-foreground">{t("Customer", "العميل")}</Label>
                <Select value={form.customerId} onValueChange={v => setForm(p => ({ ...p, customerId: v }))}>
                  <SelectTrigger className="mt-1 h-8 text-sm"><SelectValue placeholder={t("Select customer…", "اختر العميل…")} /></SelectTrigger>
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
                  <Label className="text-xs text-muted-foreground">{t("Expiry Date", "تاريخ انتهاء الصلاحية")}</Label>
                  <Input type="date" value={form.expiryDate} onChange={e => setForm(p => ({ ...p, expiryDate: e.target.value }))} className="mt-1 h-8 text-sm" />
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
            <Button className="w-full mt-4" disabled={!form.customerId}
              onClick={() => { toast({ title: t("Quotation saved", "تم حفظ عرض السعر") }); setOpen(false); setForm(makeEmpty()); }}>
              {t("Save Quotation", "حفظ عرض السعر")}
            </Button>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid grid-cols-4 gap-4">
        {[
          [t("Total Quotes", "إجمالي عروض الأسعار"), quotes.length, "text-primary"],
          [t("Total Value", "إجمالي القيمة"), fmtNum(total), "text-primary"],
          [t("Accepted", "مقبول"), accepted, "text-emerald-400"],
          [t("Pending", "قيد الانتظار"), quotes.filter(q => q.status === "sent").length, "text-amber-400"],
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
            <div className="text-muted-foreground text-sm p-4">{t("Loading…", "جارٍ التحميل…")}</div>
          ) : quotes.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground">
              <ClipboardList className="w-8 h-8 mx-auto mb-3 opacity-40" />
              <p className="text-sm">{t("No quotations yet.", "لا توجد عروض أسعار بعد.")}</p>
              <p className="text-xs mt-1 opacity-60">{t("Create a quote to send to a customer.", "أنشئ عرض سعر لإرساله إلى عميل.")}</p>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-muted-foreground text-xs uppercase">
                  {[
                    t("Quote #", "رقم العرض"),
                    t("Customer", "العميل"),
                    t("Date", "التاريخ"),
                    t("Expiry", "انتهاء الصلاحية"),
                    t("Total", "الإجمالي"),
                    t("Status", "الحالة"),
                  ].map(h => (
                    <th key={h} className="text-left pb-2 pr-4 font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {quotes.map(q => (
                  <tr key={q.id} className="border-b border-border/50 hover:bg-secondary/20">
                    <td className="py-3 pr-4 font-mono text-xs text-primary">{q.quoteNumber}</td>
                    <td className="py-3 pr-4 font-medium">{q.customerName}</td>
                    <td className="py-3 pr-4 text-muted-foreground text-xs"><DualDate date={q.date} /></td>
                    <td className="py-3 pr-4 text-muted-foreground text-xs"><DualDate date={q.expiryDate} /></td>
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
