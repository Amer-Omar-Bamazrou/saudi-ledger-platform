import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { fetchPickerOptions } from "@/lib/pagedList";
import { PickerLimitNotice } from "@/components/PickerLimitNotice";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, FileText, CheckCircle, Clock, AlertCircle, XCircle, Repeat, FileDown } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/contexts/LanguageContext";
import { FilterScope } from "@/components/FilterScope";
import { INVOICE_FILTERS, initialStatusFilter, syncStatusToUrl } from "@/lib/listFilters";
import { DualDate } from "@/components/DualDate";
import { PaymentHistory } from "@/components/PaymentHistory";

const PAGE_SIZE = 50;

import type { CreateInvoiceInput, Customer, Invoice, ListInvoices200, PaymentInput, UpdateInvoiceInput } from "@workspace/api-client-react";

/**
 * Request bodies go through the GENERATED input types (contract batch 3), so
 * this page cannot build a request the server does not accept — the class of
 * defect no server test can see, because every server test builds its request
 * the way the server expects.
 */
const json = {
  create: (b: CreateInvoiceInput) => JSON.stringify(b),
  update: (b: UpdateInvoiceInput) => JSON.stringify(b),
  pay: (b: PaymentInput) => JSON.stringify(b),
};


const STATUS_STYLES: Record<string, string> = {
  draft: "bg-secondary text-muted-foreground",
  sent: "bg-info-surface/20 text-info",
  paid: "bg-positive-surface/20 text-positive",
};

const STATUS_ICONS: Record<string, React.ReactNode> = {
  draft: <FileText className="w-3 h-3" />,
  sent: <Clock className="w-3 h-3" />,
  paid: <CheckCircle className="w-3 h-3" />,
};

// 🔴 C12: the invoice number is NO LONGER minted here.
//
// It used to default to `INV-${Date.now().toString().slice(-6)}` — a truncated
// millisecond clock, on a value that becomes the ZATCA document's `cbc:ID`.
// VAT IR Art. 53(5)(b) requires "a sequential number which uniquely identifies
// the Tax Invoice", which a clock reading is not, and nothing enforced
// uniqueness. The server now allocates from a monotonic per-company counter;
// leaving this blank is what asks it to. A number typed here is still honoured
// (legacy imports), and the DB constraint judges it.
const emptyForm = { invoiceNumber: "", date: new Date().toISOString().split("T")[0], dueDate: "", customerId: "", status: "draft", notes: "" };

export default function Invoices() {
  /**
   * 🔴 The filter is read from the URL, so a nav deep-link lands with it
   * applied. Five nav entries point here — Drafts, Pending Approval, Issued,
   * Paid, Overdue — and each is a claim about what this page will show.
   */
  const [statusFilter, setStatusFilter] = useState(() => initialStatusFilter(INVOICE_FILTERS));
  const [page, setPage] = useState(0);
  const applyFilter = (v: string) => { setStatusFilter(v); setPage(0); syncStatusToUrl(v); };
  const [open, setOpen] = useState(false);
  const [payOpen, setPayOpen] = useState<number | null>(null);
  const [form, setForm] = useState(emptyForm);
  /**
   * 🔴 THE LINES. This form had none — it collected a number, dates, a status,
   * a customer and notes, and the create mutation hardcoded `items: []`. So
   * every invoice made from this page was SAR 0.00, and because an approver's
   * own invoice is auto-approved it was ISSUED at zero: an ICV consumed, a
   * position taken in the ZATCA hash chain, a QR minted. It could not be
   * corrected afterwards either — PATCH has no caller (AUD-11) and an issued
   * invoice cannot be deleted. An invoicing product whose invoice form could
   * not express an amount.
   */
  // L1: `descriptionAr` joins the line — real Arabic is CAPTURED going
  // forward; where it is absent the Arabic PDF falls back to the English
  // description (the sentinel default is never prefilled and never printed).
  const [lines, setLines] = useState<Array<{ description: string; descriptionAr: string; quantity: string; unitPrice: string; vatRate: string }>>([
    { description: "", descriptionAr: "", quantity: "1", unitPrice: "", vatRate: "15" },
  ]);
  const lineTotal = (l: { quantity: string; unitPrice: string; vatRate: string }) => {
    const net = (Number(l.quantity) || 0) * (Number(l.unitPrice) || 0);
    return net + (net * (Number(l.vatRate) || 0)) / 100;
  };
  const invoiceTotal = lines.reduce((sum, l) => sum + lineTotal(l), 0);
  const [payAmount, setPayAmount] = useState("");
  /** AUD-11/AUD-12 — editing and deleting a DRAFT, the only states the API allows. */
  const [editing, setEditing] = useState<Invoice | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Invoice | null>(null);
  const qc = useQueryClient();
  const { toast } = useToast();
  const { t, lang } = useLanguage();

  /**
   * 🔴 A PAGE, and totals that describe the whole set.
   *
   * This read the entire ledger and then `reduce`d its headline figures over
   * whatever came back — correct only while the list stayed unbounded, which is
   * the B-6 trade in reverse. The server now returns `page` and `totals`, so
   * the Outstanding and Collected figures do not change when the reader turns
   * the page.
   */
  const { data: pageData, isLoading } = useQuery<ListInvoices200>({
    queryKey: ["invoices", statusFilter, page],
    queryFn: () =>
      apiFetch(
        `/invoices?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}` +
          (statusFilter !== "all" ? `&status=${statusFilter}` : ""),
      ),
  });

  const { data: customersPage } = useQuery<{ items: Customer[]; total: number }>({ queryKey: ["customers", "picker"], queryFn: () => fetchPickerOptions<Customer>("/customers") });
  const customers = customersPage?.items ?? [];

  const createMut = useMutation({
    mutationFn: (body: typeof emptyForm) =>
      apiFetch("/invoices", {
        method: "POST",
        body: json.create({
          invoiceNumber: body.invoiceNumber,
          date: body.date,
          dueDate: body.dueDate || null,
          notes: body.notes || null,
          customerId: Number(body.customerId),
          items: lines
            .filter((l) => l.description.trim() && Number(l.unitPrice) > 0)
            .map((l) => ({
              description: l.description.trim(),
              ...(l.descriptionAr.trim() ? { descriptionAr: l.descriptionAr.trim() } : {}),
              quantity: Number(l.quantity) || 1,
              unitPrice: Number(l.unitPrice),
              vatRate: Number(l.vatRate) || 0,
            })),
        }),
      }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["invoices"] }); setOpen(false); setForm(emptyForm); setLines([{ description: "", descriptionAr: "", quantity: "1", unitPrice: "", vatRate: "15" }]); toast({ title: t("Invoice created", "تم إنشاء الفاتورة") }); },
    onError: (e: Error) => toast({ title: t("Error", "خطأ"), description: e.message, variant: "destructive" }),
  });

  const payMut = useMutation({
    mutationFn: ({ id, amount }: { id: number; amount: number }) => apiFetch(`/invoices/${id}/pay`, { method: "POST", body: json.pay({ amount, paidAt: new Date().toISOString().split("T")[0] }) }),
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
            /**
             * 🔴 AUD-2: NO invoiceNumber. This used to carry
             * `REC-${inv.invoiceNumber}`, a fixed literal, and the generator
             * spreads the template straight into invoicesService.create — so
             * every month reused ONE number. Run 1 succeeded; run 2 violated
             * UNIQUE(company_id, invoice_number) and the rule failed for good,
             * on a feature whose whole point is running unattended. A number is
             * a property of a DOCUMENT, never of a pattern: the server
             * allocates one per generated draft.
             */
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

  const updateMut = useMutation({
    mutationFn: (body: any) =>
      apiFetch(`/invoices/${editing!.id}`, {
        method: "PATCH",
        body: json.update({
          date: body.date,
          dueDate: body.dueDate || undefined,
          customerId: body.customerId ? Number(body.customerId) : undefined,
          notes: body.notes || undefined,
          items: lines
            .filter((l) => l.description.trim() && Number(l.unitPrice) > 0)
            .map((l) => ({
              description: l.description.trim(),
              ...(l.descriptionAr.trim() ? { descriptionAr: l.descriptionAr.trim() } : {}),
              quantity: Number(l.quantity) || 1,
              unitPrice: Number(l.unitPrice),
              vatRate: Number(l.vatRate) || 0,
            })),
        }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["invoices"] });
      setOpen(false); setEditing(null); setForm(emptyForm);
      setLines([{ description: "", descriptionAr: "", quantity: "1", unitPrice: "", vatRate: "15" }]);
      toast({ title: t("Changes saved", "تم حفظ التعديلات") });
    },
    onError: (e: Error) => toast({ title: t("Error", "خطأ"), description: e.message, variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) => apiFetch(`/invoices/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["invoices"] });
      setConfirmDelete(null);
      toast({ title: t("Draft deleted", "تم حذف المسودة") });
    },
    onError: (e: Error) => toast({ title: t("Error", "خطأ"), description: e.message, variant: "destructive" }),
  });

  /** Open the shared dialog in EDIT mode, prefilled from the full record. */
  const openEdit = async (row: Invoice) => {
    try {
      const detail: any = await apiFetch(`/invoices/${row.id}`);
      setForm({
        invoiceNumber: detail.invoiceNumber ?? "",
        date: detail.date ?? "",
        dueDate: detail.dueDate ?? "",
        customerId: String(detail.customerId ?? ""),
        status: detail.status ?? "draft",
        notes: detail.notes ?? "",
      });
      setLines(
        (detail.items ?? []).map((i: any) => ({
          description: i.description ?? "",
          // the stored default "(not yet translated)" is a sentinel, not a
          // value — an empty input is the honest prefill.
          descriptionAr: i.descriptionAr === "(not yet translated)" ? "" : (i.descriptionAr ?? ""),
          quantity: String(i.quantity ?? 1),
          unitPrice: String(i.unitPrice ?? ""),
          vatRate: String(i.vatRate ?? 15),
        })),
      );
      setEditing(row);
      setOpen(true);
    } catch (e) {
      toast({ title: t("Error", "خطأ"), description: (e as Error).message, variant: "destructive" });
    }
  };

  const invoices = pageData?.items ?? [];
  const totals = pageData?.totals;
  const pageInfo = pageData?.page;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">{t("Invoices", "الفواتير")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t("Customer invoices · Accounts Receivable", "فواتير العملاء · الذمم المدينة")}</p>
        </div>
        <Dialog
          open={open}
          onOpenChange={(o) => {
            setOpen(o);
            if (!o) {
              // Leaving EDIT mode explicitly, or the next "New Invoice" would
              // silently PATCH the record just edited.
              setEditing(null);
              setForm(emptyForm);
              setLines([{ description: "", descriptionAr: "", quantity: "1", unitPrice: "", vatRate: "15" }]);
            }
          }}
        >
          <DialogTrigger asChild><Button className="gap-2"><Plus className="w-4 h-4" /> {t("New Invoice", "فاتورة جديدة")}</Button></DialogTrigger>
          <DialogContent className="max-w-md">
            <DialogHeader><DialogTitle>{editing ? `${t("Edit invoice", "تعديل الفاتورة")} — ${editing.invoiceNumber}` : t("New Invoice", "فاتورة جديدة")}</DialogTitle></DialogHeader>
            <div className="space-y-3 mt-2">
              <div className="grid grid-cols-2 gap-3">
                <div><Label className="text-xs text-muted-foreground">{t("Invoice Number", "رقم الفاتورة")}</Label><Input value={form.invoiceNumber} onChange={e=>setForm(p=>({...p,invoiceNumber:e.target.value}))} placeholder={t("Assigned automatically", "يُخصص تلقائيًا")} className="mt-1 h-8 text-sm" /></div>
                <div><Label className="text-xs text-muted-foreground">{t("Date", "التاريخ")}</Label><Input type="date" value={form.date} onChange={e=>setForm(p=>({...p,date:e.target.value}))} className="mt-1 h-8 text-sm" /></div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div><Label className="text-xs text-muted-foreground">{t("Due Date", "تاريخ الاستحقاق")}</Label><Input type="date" value={form.dueDate} onChange={e=>setForm(p=>({...p,dueDate:e.target.value}))} className="mt-1 h-8 text-sm" /></div>
                <div><Label className="text-xs text-muted-foreground">{t("Status", "الحالة")}</Label>
                  <Select value={form.status} onValueChange={v=>setForm(p=>({...p,status:v}))}><SelectTrigger className="mt-1 h-8 text-sm"><SelectValue /></SelectTrigger><SelectContent>{["draft","sent","paid"].map(s=><SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent></Select>
                </div>
              </div>
              <div><Label className="text-xs text-muted-foreground">{t("Customer", "العميل")}</Label>
                <Select value={form.customerId} onValueChange={v=>setForm(p=>({...p,customerId:v}))}><SelectTrigger className="mt-1 h-8 text-sm"><SelectValue placeholder={t("Select customer...", "اختر العميل...")} /></SelectTrigger><SelectContent>{customers.map(c=><SelectItem key={c.id} value={String(c.id)}>{c.name}</SelectItem>)}<PickerLimitNotice shown={customers.length} total={customersPage?.total ?? customers.length} /></SelectContent></Select>
              </div>
              <div><Label className="text-xs text-muted-foreground">{t("Notes", "ملاحظات")}</Label><Input value={form.notes} onChange={e=>setForm(p=>({...p,notes:e.target.value}))} className="mt-1 h-8 text-sm" placeholder={t("Optional notes...", "ملاحظات اختيارية...")} /></div>

              {/* ── Lines. Without these the invoice is SAR 0.00 and, once
                  issued, permanently so: it cannot be edited or deleted. ── */}
              <div className="space-y-2 border-t border-border pt-3">
                <Label className="text-xs text-muted-foreground">{t("Lines", "البنود")}</Label>
                {lines.map((l, i) => (
                  <div key={i} className="grid grid-cols-12 gap-2">
                    <Input
                      className="col-span-3 h-8 text-sm"
                      placeholder={t("Description", "الوصف")}
                      value={l.description}
                      onChange={(e) => setLines((p) => p.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))}
                    />
                    <Input
                      className="col-span-2 h-8 text-sm"
                      dir="rtl"
                      placeholder={t("Arabic description", "الوصف بالعربية")}
                      value={l.descriptionAr}
                      onChange={(e) => setLines((p) => p.map((x, j) => (j === i ? { ...x, descriptionAr: e.target.value } : x)))}
                    />
                    <Input
                      className="col-span-2 h-8 text-sm"
                      type="number"
                      placeholder={t("Qty", "الكمية")}
                      value={l.quantity}
                      onChange={(e) => setLines((p) => p.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))}
                    />
                    <Input
                      className="col-span-3 h-8 text-sm"
                      type="number"
                      placeholder={t("Unit price", "سعر الوحدة")}
                      value={l.unitPrice}
                      onChange={(e) => setLines((p) => p.map((x, j) => (j === i ? { ...x, unitPrice: e.target.value } : x)))}
                    />
                    <Input
                      className="col-span-2 h-8 text-sm"
                      type="number"
                      placeholder={t("VAT %", "الضريبة %")}
                      value={l.vatRate}
                      onChange={(e) => setLines((p) => p.map((x, j) => (j === i ? { ...x, vatRate: e.target.value } : x)))}
                    />
                  </div>
                ))}
                <div className="flex items-center justify-between">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setLines((p) => [...p, { description: "", descriptionAr: "", quantity: "1", unitPrice: "", vatRate: "15" }])}
                  >
                    {t("Add line", "إضافة بند")}
                  </Button>
                  <span className="text-sm">
                    <span className="text-muted-foreground me-2">{t("Total (incl. VAT)", "الإجمالي شامل الضريبة")}</span>
                    <span className="font-mono">{fmtNum(invoiceTotal)}</span>
                  </span>
                </div>
              </div>
            </div>
            <Button
              className="w-full mt-4"
              onClick={()=> (editing ? updateMut.mutate(form) : createMut.mutate(form))}
              disabled={
                !form.customerId ||
                createMut.isPending ||
                updateMut.isPending ||
                // An invoice with no priced line is SAR 0.00 — and once issued,
                // permanently so. The server refuses it too; this stops it here.
                !lines.some((l) => l.description.trim() && Number(l.unitPrice) > 0)
              }
            >
              {createMut.isPending || updateMut.isPending
                ? t("Saving…", "جارٍ الحفظ…")
                : editing
                  ? t("Save changes", "حفظ التعديلات")
                  : t("Create Invoice", "إنشاء فاتورة")}
            </Button>
          </DialogContent>
        </Dialog>
      </div>

      {/* 🔴 Draft-only delete. The confirm names what is and is NOT possible:
          this works because the invoice is a draft, and would be refused the
          moment it is issued — at which point a credit note is the only
          correction. */}
      <Dialog open={!!confirmDelete} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {t(`Delete draft ${confirmDelete?.invoiceNumber ?? ""}?`, `حذف مسودة ${confirmDelete?.invoiceNumber ?? ""}؟`)}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p>
              {t(
                "The draft is removed permanently. Nothing has been issued, so no number, no ledger entry and no ZATCA record is affected.",
                "تُحذف المسودة نهائيًا. لم يتم إصدار أي شيء، فلا يتأثر أي رقم أو قيد أو سجل لدى هيئة الزكاة والضريبة.",
              )}
            </p>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(null)}>{t("Cancel", "إلغاء")}</Button>
              <Button size="sm" variant="destructive" disabled={deleteMut.isPending}
                onClick={() => confirmDelete && deleteMut.mutate(confirmDelete.id)}>
                {deleteMut.isPending ? t("Deleting…", "جارٍ الحذف…") : t("Delete draft", "حذف المسودة")}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <div className="grid grid-cols-4 gap-4">
        {[
          // Every figure here is the SERVER's, over the whole filtered set.
          [t("Total Invoices", "إجمالي الفواتير"), pageInfo?.total ?? "—", "text-primary"],
          [t("Outstanding", "المستحق"), totals ? fmtNum(totals.outstanding) : "—", "text-attention"],
          [t("Collected", "المحصّل"), totals ? fmtNum(totals.collected) : "—", "text-positive"],
          [t("Overdue", "متأخر"), totals?.overdue ?? "—", "text-negative"],
        ].map(([l,v,c])=>(
          <Card key={String(l)} className="border-border bg-card"><CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{l}</CardTitle></CardHeader><CardContent><div className={`text-2xl font-bold font-mono ${c}`}>{v}</div></CardContent></Card>
        ))}
      </div>

      <Card className="border-border bg-card">
        <CardHeader className="pb-3">
          <div className="flex gap-2 flex-wrap">
            {/* "overdue" is answered from the dates by the API; "cancelled" is gone —
                an invoice that must not stand is reversed by a credit note. */}
            {INVOICE_FILTERS.map(o=>(
              <Button key={o.value} variant={statusFilter===o.value?"default":"ghost"} size="sm" className="h-7 text-xs" onClick={()=>applyFilter(o.value)}>
                {lang === "ar" ? o.labelAr : o.label}
              </Button>
            ))}
          </div>
          <div className="mt-3">
            <FilterScope options={INVOICE_FILTERS} value={statusFilter} total={pageInfo?.total} onClear={() => applyFilter("all")} />
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
              ].map(h=><th key={h} className="text-start pb-2 pe-4 font-medium">{h}</th>)}</tr></thead>
              <tbody>{invoices.map(inv=>(
                <tr key={inv.id} className="border-b border-border/50 hover:bg-secondary/20 transition-colors">
                  <td className="py-3 pe-4 font-mono text-xs text-primary">{inv.invoiceNumber}</td>
                  <td className="py-3 pe-4 font-medium">{inv.customerName ?? "—"}</td>
                  <td className="py-3 pe-4 text-muted-foreground text-xs"><DualDate date={inv.date} /></td>
                  <td className="py-3 pe-4 text-muted-foreground text-xs"><DualDate date={inv.dueDate} /></td>
                  <td className="py-3 pe-4 font-mono">{fmtNum(inv.subtotal)}</td>
                  <td className="py-3 pe-4 font-mono text-muted-foreground">{fmtNum(inv.vatAmount)}</td>
                  <td className="py-3 pe-4 font-mono font-semibold">{fmtNum(inv.total)}</td>
                  <td className="py-3 pe-4"><Badge className={`gap-1 text-xs ${STATUS_STYLES[inv.status] ?? ""}`}>{STATUS_ICONS[inv.status]}{inv.status}</Badge></td>
                  <td className="py-3">
                    <div className="flex items-center gap-1">
                      {/*
                        🔴 AUD-11/AUD-12: draft-only Edit and Delete. Both routes
                        existed and had no caller, so a mistyped draft could be
                        neither corrected nor removed. They are offered ONLY on a
                        draft because that is the only state the server permits —
                        an issued invoice is corrected by credit note, and the
                        service says so in its refusal.
                      */}
                      {inv.status === "draft" && (
                        <>
                          <Button variant="ghost" size="sm" className="text-xs h-7"
                            onClick={() => openEdit(inv)}>
                            {t("Edit", "تعديل")}
                          </Button>
                          <Button variant="ghost" size="sm" className="text-xs h-7 text-negative"
                            onClick={() => setConfirmDelete(inv)}>
                            {t("Delete", "حذف")}
                          </Button>
                        </>
                      )}
                      {inv.status !== "paid" && (
                        <Button variant="ghost" size="sm" className="text-xs h-7 text-positive" onClick={()=>{setPayOpen(inv.id);setPayAmount(String(inv.total-inv.paidAmount));}}>{t("Mark Paid", "تسجيل كمدفوع")}</Button>
                      )}
                      {/* L1 — the invoice leaves the product. ع is THE tax
                          invoice (Arabic, PDF/A-3); EN is a labelled
                          translation — its banner says the Arabic document is
                          the tax invoice. Anchors, not fetch: the session
                          cookie rides the same-origin GET and the server's
                          Content-Disposition does the saving. Issued documents
                          only — a draft has no QR and no legal existence. */}
                      {inv.status !== "draft" && inv.status !== "submitted" && (
                        <>
                          <a href={`/api/invoices/${inv.id}/document?lang=ar`} download
                            className="inline-flex items-center gap-1 text-xs h-7 px-2 rounded hover:bg-secondary/60 text-primary"
                            title={t("Download the tax invoice (Arabic PDF)", "تنزيل الفاتورة الضريبية (PDF عربي)")}>
                            <FileDown className="h-3.5 w-3.5" />PDF
                          </a>
                          <a href={`/api/invoices/${inv.id}/document?lang=en`} download
                            className="inline-flex items-center gap-1 text-xs h-7 px-2 rounded hover:bg-secondary/60 text-muted-foreground"
                            title={t("Download the English translation — not the tax invoice", "تنزيل الترجمة الإنجليزية — ليست الفاتورة الضريبية")}>
                            EN
                          </a>
                        </>
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

            {/*
              🔴 The page says what it is showing and of how many, and gives a
              way to the rest. A list that silently stops at 50 is the same
              defect as a count that saturates at 200 — the number describes a
              set the reader does not think they are looking at (B-6).
            */}
            {pageInfo && pageInfo.total > 0 && (
              <div className="flex items-center justify-between pt-3 text-sm text-muted-foreground">
                <span>
                  {t(
                    `Showing ${pageInfo.offset + 1}–${Math.min(pageInfo.offset + invoices.length, pageInfo.total)} of ${pageInfo.total}`,
                    `عرض ${pageInfo.offset + 1}–${Math.min(pageInfo.offset + invoices.length, pageInfo.total)} من ${pageInfo.total}`,
                  )}
                </span>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
                    {t("Previous", "السابق")}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={pageInfo.offset + invoices.length >= pageInfo.total}
                    onClick={() => setPage((p) => p + 1)}
                  >
                    {t("Next", "التالي")}
                  </Button>
                </div>
              </div>
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
