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
import { Plus, FileText, CheckCircle, Clock, AlertCircle, XCircle, Repeat } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/contexts/LanguageContext";
import { DualDate } from "@/components/DualDate";
import { PaymentHistory } from "@/components/PaymentHistory";

interface Invoice { id: number; invoiceNumber: string; date: string; dueDate: string; customerId: number; customerName: string; status: string; subtotal: number; vatAmount: number; total: number; paidAmount: number; currency: string; }
interface Customer { id: number; name: string; }

const STATUS_STYLES: Record<string, string> = {
  draft: "bg-secondary text-muted-foreground",
  sent: "bg-blue-500/20 text-blue-400",
  paid: "bg-emerald-500/20 text-emerald-400",
  overdue: "bg-red-500/20 text-red-400",
  cancelled: "bg-secondary text-muted-foreground",
};

const STATUS_ICONS: Record<string, React.ReactNode> = {
  draft: <FileText className="w-3 h-3" />,
  sent: <Clock className="w-3 h-3" />,
  paid: <CheckCircle className="w-3 h-3" />,
  overdue: <AlertCircle className="w-3 h-3" />,
  cancelled: <XCircle className="w-3 h-3" />,
};

const emptyForm = { invoiceNumber: `INV-${Date.now().toString().slice(-6)}`, date: new Date().toISOString().split("T")[0], dueDate: "", customerId: "", status: "draft", notes: "" };

export default function Invoices() {
  const [statusFilter, setStatusFilter] = useState("all");
  const [open, setOpen] = useState(false);
  const [payOpen, setPayOpen] = useState<number | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [payAmount, setPayAmount] = useState("");
  const qc = useQueryClient();
  const { toast } = useToast();
  const { t } = useLanguage();

  const { data: invoices = [], isLoading } = useQuery<Invoice[]>({
    queryKey: ["invoices", statusFilter],
    queryFn: () => apiFetch(`/invoices${statusFilter !== "all" ? `?status=${statusFilter}` : ""}`),
  });

  const { data: customers = [] } = useQuery<Customer[]>({ queryKey: ["customers"], queryFn: () => apiFetch("/customers") });

  const createMut = useMutation({
    mutationFn: (body: any) => apiFetch("/invoices", { method: "POST", body: JSON.stringify({ ...body, customerId: Number(body.customerId), items: [] }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["invoices"] }); setOpen(false); setForm(emptyForm); toast({ title: t("Invoice created", "تم إنشاء الفاتورة") }); },
    onError: (e: Error) => toast({ title: t("Error", "خطأ"), description: e.message, variant: "destructive" }),
  });

  const payMut = useMutation({
    mutationFn: ({ id, amount }: { id: number; amount: number }) => apiFetch(`/invoices/${id}/pay`, { method: "POST", body: JSON.stringify({ amount, paidAt: new Date().toISOString().split("T")[0] }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["invoices"] }); setPayOpen(null); setPayAmount(""); toast({ title: t("Payment recorded", "تم تسجيل الدفعة") }); },
    onError: (e: Error) => toast({ title: t("Error", "خطأ"), description: e.message, variant: "destructive" }),
  });

  /**
   * A3 — "make recurring": repeat this invoice monthly as DRAFTS. The rule
   * copies the invoice's lines and customer; the generation job dates each
   * occurrence and every draft still needs an approver. Manage rules under
   * Settings → Automation Rules.
   */
  const makeRecurringMut = useMutation({
    mutationFn: async (inv: Invoice) => {
      const detail: Invoice & { items?: unknown[] } = await apiFetch(`/invoices/${inv.id}`);
      const day = Number(inv.date?.slice(8, 10)) || 1;
      return apiFetch("/recurring", {
        method: "POST",
        body: JSON.stringify({
          entity: "invoice",
          template: {
            invoiceNumber: `REC-${inv.invoiceNumber}`,
            customerId: inv.customerId,
            // Only the line FACTS — row ids and computed totals must not leak
            // into the template, or every generated draft would try to reuse
            // this invoice's item ids.
            items: ((detail.items ?? []) as Array<Record<string, unknown>>).map((it) => ({
              description: it.description,
              quantity: it.quantity,
              unitPrice: it.unitPrice,
              vatRate: it.vatRate,
              ...(it.taxCategoryCode ? { taxCategoryCode: it.taxCategoryCode } : {}),
            })),
            currency: inv.currency,
          },
          frequency: "monthly",
          dayOfMonth: day,
          startsOn: inv.date,
        }),
      });
    },
    onSuccess: () =>
      toast({
        title: t("Recurring rule created", "تم إنشاء قاعدة التكرار"),
        description: t("Monthly drafts will be generated — see Settings → Automation Rules.", "سيتم إنشاء مسودات شهرية — راجع الإعدادات ← قواعد الأتمتة."),
      }),
    onError: (e: Error) => toast({ title: t("Error", "خطأ"), description: e.message, variant: "destructive" }),
  });

  const totalOutstanding = invoices.filter(i => i.status !== "paid" && i.status !== "cancelled").reduce((s, i) => s + (i.total - i.paidAmount), 0);
  const totalPaid = invoices.filter(i => i.status === "paid").reduce((s, i) => s + i.total, 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t("Invoices", "الفواتير")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t("Customer invoices · Accounts Receivable", "فواتير العملاء · الذمم المدينة")}</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild><Button className="gap-2"><Plus className="w-4 h-4" /> {t("New Invoice", "فاتورة جديدة")}</Button></DialogTrigger>
          <DialogContent className="max-w-md">
            <DialogHeader><DialogTitle>{t("New Invoice", "فاتورة جديدة")}</DialogTitle></DialogHeader>
            <div className="space-y-3 mt-2">
              <div className="grid grid-cols-2 gap-3">
                <div><Label className="text-xs text-muted-foreground">{t("Invoice Number", "رقم الفاتورة")}</Label><Input value={form.invoiceNumber} onChange={e=>setForm(p=>({...p,invoiceNumber:e.target.value}))} className="mt-1 h-8 text-sm" /></div>
                <div><Label className="text-xs text-muted-foreground">{t("Date", "التاريخ")}</Label><Input type="date" value={form.date} onChange={e=>setForm(p=>({...p,date:e.target.value}))} className="mt-1 h-8 text-sm" /></div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div><Label className="text-xs text-muted-foreground">{t("Due Date", "تاريخ الاستحقاق")}</Label><Input type="date" value={form.dueDate} onChange={e=>setForm(p=>({...p,dueDate:e.target.value}))} className="mt-1 h-8 text-sm" /></div>
                <div><Label className="text-xs text-muted-foreground">{t("Status", "الحالة")}</Label>
                  <Select value={form.status} onValueChange={v=>setForm(p=>({...p,status:v}))}><SelectTrigger className="mt-1 h-8 text-sm"><SelectValue /></SelectTrigger><SelectContent>{["draft","sent","paid"].map(s=><SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent></Select>
                </div>
              </div>
              <div><Label className="text-xs text-muted-foreground">{t("Customer", "العميل")}</Label>
                <Select value={form.customerId} onValueChange={v=>setForm(p=>({...p,customerId:v}))}><SelectTrigger className="mt-1 h-8 text-sm"><SelectValue placeholder={t("Select customer...", "اختر العميل...")} /></SelectTrigger><SelectContent>{customers.map(c=><SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}</SelectContent></Select>
              </div>
              <div><Label className="text-xs text-muted-foreground">{t("Notes", "ملاحظات")}</Label><Input value={form.notes} onChange={e=>setForm(p=>({...p,notes:e.target.value}))} className="mt-1 h-8 text-sm" placeholder={t("Optional notes...", "ملاحظات اختيارية...")} /></div>
            </div>
            <Button className="w-full mt-4" onClick={()=>createMut.mutate(form)} disabled={!form.customerId || createMut.isPending}>
              {createMut.isPending ? t("Creating...", "جارٍ الإنشاء...") : t("Create Invoice", "إنشاء فاتورة")}
            </Button>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid grid-cols-4 gap-4">
        {[
          [t("Total Invoices", "إجمالي الفواتير"), invoices.length, "text-primary"],
          [t("Outstanding", "المستحق"), fmtNum(totalOutstanding), "text-amber-400"],
          [t("Collected", "المحصّل"), fmtNum(totalPaid), "text-emerald-400"],
          [t("Overdue", "متأخر"), invoices.filter(i=>i.status==="overdue").length, "text-red-400"],
        ].map(([l,v,c])=>(
          <Card key={String(l)} className="border-border bg-card"><CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{l}</CardTitle></CardHeader><CardContent><div className={`text-2xl font-bold font-mono ${c}`}>{v}</div></CardContent></Card>
        ))}
      </div>

      <Card className="border-border bg-card">
        <CardHeader className="pb-3">
          <div className="flex gap-2 flex-wrap">
            {["all","draft","sent","paid","overdue","cancelled"].map(s=>(
              <Button key={s} variant={statusFilter===s?"default":"ghost"} size="sm" className="h-7 text-xs capitalize" onClick={()=>setStatusFilter(s)}>{s}</Button>
            ))}
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? <div className="text-muted-foreground text-sm p-4">{t("Loading...", "جارٍ التحميل...")}</div> : invoices.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground"><FileText className="w-8 h-8 mx-auto mb-3 opacity-40" /><p>{t("No invoices found.", "لا توجد فواتير.")}</p></div>
          ) : (
            <table className="w-full text-sm">
              <thead><tr className="border-b border-border text-muted-foreground text-xs uppercase">{[
                t("Invoice #", "رقم الفاتورة"),
                t("Customer", "العميل"),
                t("Date", "التاريخ"),
                t("Due Date", "تاريخ الاستحقاق"),
                t("Amount", "المبلغ"),
                t("VAT", "ضريبة القيمة المضافة"),
                t("Total", "الإجمالي"),
                t("Status", "الحالة"),
                "",
              ].map(h=><th key={h} className="text-left pb-2 pr-4 font-medium">{h}</th>)}</tr></thead>
              <tbody>{invoices.map(inv=>(
                <tr key={inv.id} className="border-b border-border/50 hover:bg-secondary/20 transition-colors">
                  <td className="py-3 pr-4 font-mono text-xs text-primary">{inv.invoiceNumber}</td>
                  <td className="py-3 pr-4 font-medium">{inv.customerName ?? "—"}</td>
                  <td className="py-3 pr-4 text-muted-foreground text-xs"><DualDate date={inv.date} /></td>
                  <td className="py-3 pr-4 text-muted-foreground text-xs"><DualDate date={inv.dueDate} /></td>
                  <td className="py-3 pr-4 font-mono">{fmtNum(inv.subtotal)}</td>
                  <td className="py-3 pr-4 font-mono text-muted-foreground">{fmtNum(inv.vatAmount)}</td>
                  <td className="py-3 pr-4 font-mono font-semibold">{fmtNum(inv.total)}</td>
                  <td className="py-3 pr-4"><Badge className={`gap-1 text-xs ${STATUS_STYLES[inv.status] ?? ""}`}>{STATUS_ICONS[inv.status]}{inv.status}</Badge></td>
                  <td className="py-3">
                    <div className="flex items-center gap-1">
                      {inv.status !== "paid" && inv.status !== "cancelled" && (
                        <Button variant="ghost" size="sm" className="text-xs h-7 text-emerald-400" onClick={()=>{setPayOpen(inv.id);setPayAmount(String(inv.total-inv.paidAmount));}}>{t("Mark Paid", "تسجيل كمدفوع")}</Button>
                      )}
                      {/* A3 (hub decision: automation woven into the page) —
                          repeat this invoice monthly as DRAFTS for approval. */}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-xs h-7 text-muted-foreground"
                        title={t("Repeat monthly as drafts", "تكرار شهريًا كمسودات")}
                        onClick={() => makeRecurringMut.mutate(inv)}
                        disabled={makeRecurringMut.isPending}
                      >
                        <Repeat className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Dialog open={payOpen !== null} onOpenChange={()=>setPayOpen(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>{t("Record Payment", "تسجيل دفعة")}</DialogTitle></DialogHeader>
          <div className="space-y-3 mt-2">
            <div><Label className="text-xs text-muted-foreground">{t("Amount Received (SAR)", "المبلغ المستلم (ر.س)")}</Label><Input type="number" value={payAmount} onChange={e=>setPayAmount(e.target.value)} className="mt-1 h-8 text-sm" /></div>
            <PaymentHistory entity="invoices" id={payOpen} />
          </div>
          <Button className="w-full mt-4 bg-emerald-600 hover:bg-emerald-700" onClick={()=>payOpen&&payMut.mutate({id:payOpen,amount:Number(payAmount)})} disabled={!payAmount||payMut.isPending}>
            {payMut.isPending ? t("Recording...", "جارٍ التسجيل...") : t("Record Payment", "تسجيل الدفعة")}
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
