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
  const { t } = useLanguage();

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
          <h1 className="text-2xl font-bold text-foreground">{t("Debit Notes", "إشعارات مدين")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t("Raised against vendors for returns or underbilling", "تُرفع ضد الموردين مقابل المرتجعات أو الفوترة الناقصة")}</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button className="gap-2"><Plus className="w-4 h-4" /> {t("New Debit Note", "إشعار مدين جديد")}</Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg">
            <DialogHeader><DialogTitle>{t("New Debit Note", "إشعار مدين جديد")}</DialogTitle></DialogHeader>
            <div className="space-y-3 mt-2">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs text-muted-foreground">{t("Debit Note #", "رقم الإشعار المدين")}</Label>
                  <Input value={form.debitNoteNumber} onChange={e => setForm(p => ({ ...p, debitNoteNumber: e.target.value }))} className="mt-1 h-8 text-sm" />
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
                  <Label className="text-xs text-muted-foreground">{t("Date", "التاريخ")}</Label>
                  <Input type="date" value={form.date} onChange={e => setForm(p => ({ ...p, date: e.target.value }))} className="mt-1 h-8 text-sm" />
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">{t("Status", "الحالة")}</Label>
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
                  <Label className="text-xs text-muted-foreground">{t("Subtotal (SAR)", "المجموع الفرعي (ر.س)")}</Label>
                  <Input type="number" step="0.01" value={form.subtotal} onChange={e => setForm(p => ({ ...p, subtotal: e.target.value }))} placeholder="0.00" className="mt-1 h-8 text-sm font-mono" />
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">{t("VAT 15%", "ضريبة القيمة المضافة 15%")}</Label>
                  <Input type="number" step="0.01" value={form.vatAmount} onChange={e => setForm(p => ({ ...p, vatAmount: e.target.value }))} placeholder="0.00" className="mt-1 h-8 text-sm font-mono" />
                </div>
                <div>
                  <Label className="text-xs text-muted-foreground">{t("Total Amount", "المبلغ الإجمالي")}</Label>
                  <Input type="number" step="0.01" value={form.amount} onChange={e => setForm(p => ({ ...p, amount: e.target.value }))} placeholder="0.00" className="mt-1 h-8 text-sm font-mono" />
                </div>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">{t("Reason", "السبب")}</Label>
                <Input value={form.reason} onChange={e => setForm(p => ({ ...p, reason: e.target.value }))} placeholder={t("Return, price discrepancy…", "مرتجع، فارق في السعر…")} className="mt-1 h-8 text-sm" />
              </div>
            </div>
            <Button className="w-full mt-4" disabled={!form.vendorId}
              onClick={() => { toast({ title: t("Debit note saved", "تم حفظ الإشعار المدين") }); setOpen(false); setForm(makeEmpty()); }}>
              {t("Save Debit Note", "حفظ الإشعار المدين")}
            </Button>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid grid-cols-4 gap-4">
        {[
          [t("Total Notes", "إجمالي الإشعارات"), notes.length, "text-primary"],
          [t("Total Deducted", "إجمالي المخصوم"), fmtNum(totalIssued), "text-amber-400"],
          [t("Applied", "مطبّق"), notes.filter(n => n.status === "applied").length, "text-emerald-400"],
          [t("Pending", "معلّق"), notes.filter(n => n.status === "issued").length, "text-amber-400"],
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
          ) : notes.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground">
              <FilePlus className="w-8 h-8 mx-auto mb-3 opacity-40" />
              <p className="text-sm">{t("No debit notes yet.", "لا توجد إشعارات مدين بعد.")}</p>
              <p className="text-xs mt-1 opacity-60">{t("Raise one when a vendor owes you a credit.", "أنشئ واحداً عندما يكون للمورد رصيد دائن لصالحك.")}</p>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-muted-foreground text-xs uppercase">
                  {[t("Debit Note #", "رقم الإشعار المدين"), t("Vendor", "المورد"), t("Bill Ref", "مرجع الفاتورة"), t("Date", "التاريخ"), t("Amount", "المبلغ"), t("Status", "الحالة")].map(h => (
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
