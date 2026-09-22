import { DEFAULT_VAT_RATE } from "@workspace/shared";
import { useRef, useState } from "react";
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
import { statusLabel } from "@/lib/statusLabel";
import { FilterScope } from "@/components/FilterScope";
import { INVOICE_FILTERS, initialStatusFilter, syncStatusToUrl } from "@/lib/listFilters";
import { DualDate } from "@/components/DualDate";
import { OpeningRecordBadge, OpeningRecordNote } from "@/components/migration/OpeningRecord";
import { PaymentHistory } from "@/components/PaymentHistory";
import { BadDebtRecoveryDialog, WriteOffBadDebtDialog } from "@/components/invoices/BadDebtDialogs";

const PAGE_SIZE = 50;

import type { CreateInvoiceInput, Customer, Invoice, ListInvoices200, OpenAdvanceInvoice, PaymentInput, UpdateInvoiceInput } from "@workspace/api-client-react";
import { businessToday } from "@workspace/shared";

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
const emptyForm = { invoiceNumber: "", date: businessToday(), dueDate: "", customerId: "", notes: "" };

/** One definition of a fresh line — the default VAT rate comes from @workspace/shared, never a literal. */
const emptyLine = () => ({ description: "", descriptionAr: "", quantity: "1", unitPrice: "", vatRate: String(DEFAULT_VAT_RATE) });

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
  // 🔴 One idempotency key per New-Invoice dialog open (QA fix). It rides every
  // create attempt from this open, so a double-click / retry resolves to the
  // SAME invoice server-side. Regenerated when the dialog re-opens for a new one.
  const idempotencyKey = useRef<string>("");
  // 🔴 The double-click gate. A ref, NOT `isPending`: mutation state is a
  // render snapshot, so it cannot stop two clicks in one frame — this can.
  // Set in the submit onClick, cleared in both mutations' onSettled.
  const submittingRef = useRef(false);
  // Same gate for the PAY dialog — the one double-fire the server does not
  // fully absorb: a PARTIAL payment sent twice is two accepted payments
  // (full-amount repeats die on the overpay guard). Money moves; a ref, not
  // a render snapshot.
  const payingRef = useRef(false);
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
  const [lines, setLines] = useState<Array<{ description: string; descriptionAr: string; quantity: string; unitPrice: string; vatRate: string }>>([emptyLine()]);
  const lineTotal = (l: { quantity: string; unitPrice: string; vatRate: string }) => {
    const net = (Number(l.quantity) || 0) * (Number(l.unitPrice) || 0);
    return net + (net * (Number(l.vatRate) || 0)) / 100;
  };
  const invoiceTotal = lines.reduce((sum, l) => sum + lineTotal(l), 0);
  /**
   * AP-2 — the ADVANCE TAX INVOICES (386) this FINAL invoice applies. The
   * customer's open ones are listed; the user TICKS the ones to apply and may
   * enter a part (VAT inclusive; blank = the whole open balance). A human
   * selection on the document — nothing is auto-applied (CLAUDE.md §9). The
   * server computes the split, the PrepaidAmount and the amount due; the
   * summary below is the same arithmetic for the reader's benefit only.
   */
  const [prepayments, setPrepayments] = useState<Record<number, { on: boolean; amount: string }>>({});
  const { data: openAdvances = [] } = useQuery<OpenAdvanceInvoice[]>({
    queryKey: ["open-advance-invoices", form.customerId],
    queryFn: () => apiFetch(`/customers/${form.customerId}/advance-invoices`),
    enabled: !!form.customerId && open,
  });
  const selectedPrepayments = openAdvances
    .filter((a) => prepayments[a.id]?.on)
    .map((a) => ({ advanceInvoiceId: a.id, amount: prepayments[a.id]?.amount.trim() ? Number(prepayments[a.id]!.amount) : a.openAmount }));
  const prepaidTotal = selectedPrepayments.reduce((s, p) => s + (Number.isFinite(p.amount) ? p.amount : 0), 0);
  const prepaymentsBody = () => selectedPrepayments.map((p) => ({ advanceInvoiceId: p.advanceInvoiceId, amount: p.amount }));
  const [payAmount, setPayAmount] = useState("");
  /**
   * D-3 (2026-09-16): a payment posts to the bank's OWN GL account, so the
   * dialog asks which account the money arrived in. The default account is
   * pre-selected and the human clicks — a suggestion, never a silent choice
   * (the server refuses a payment with no bank: 422 bank_account_required).
   */
  const [payBank, setPayBank] = useState<string>("");
  const { data: bankAccounts = [] } = useQuery<Array<{ id: number; name: string; bankName: string; isDefault: boolean; isActive: boolean }>>({
    queryKey: ["bank-accounts"],
    queryFn: () => apiFetch("/bank-accounts"),
  });
  const activeBanks = bankAccounts.filter((b) => b.isActive);
  // Pre-selection is the bank the user MARKED default — an explicit setting.
  // "There is only one" is not a setting anyone chose, so it pre-selects
  // nothing: the user names the bank (D-3: no single-bank inference).
  const defaultBankId = activeBanks.find((b) => b.isDefault)?.id;
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
          idempotencyKey: idempotencyKey.current || undefined,
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
          ...(selectedPrepayments.length > 0 ? { prepayments: prepaymentsBody() } : {}),
        }),
      }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["invoices"] }); qc.invalidateQueries({ queryKey: ["open-advance-invoices"] }); setOpen(false); setForm(emptyForm); setLines([emptyLine()]); setPrepayments({}); toast({ title: t("Invoice created", "تم إنشاء الفاتورة") }); },
    onError: (e: Error) => toast({ title: t("Error", "خطأ"), description: e.message, variant: "destructive" }),
    onSettled: () => { submittingRef.current = false; },
  });

  // 2026-09-22: bad debts — the Art. 40(7) write-off with relief, and the Art. 40(9) recovery document.
  const [writeOffFor, setWriteOffFor] = useState<Invoice | null>(null);
  const [recoveryFor, setRecoveryFor] = useState<Invoice | null>(null);

  const payMut = useMutation({
    mutationFn: ({ id, amount, bankAccountId }: { id: number; amount: number; bankAccountId: number }) =>
      apiFetch(`/invoices/${id}/pay`, { method: "POST", body: json.pay({ amount, paidAt: businessToday(), bankAccountId }) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["invoices"] }); qc.invalidateQueries({ queryKey: ["bank-accounts"] }); setPayOpen(null); setPayAmount(""); toast({ title: t("Payment recorded", "تم تسجيل الدفعة") }); },
    onError: (e: Error) => toast({ title: t("Error", "خطأ"), description: e.message, variant: "destructive" }),
    onSettled: () => { payingRef.current = false; },
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
          // The selection is replaced whole, like the lines (an empty list clears it).
          prepayments: prepaymentsBody(),
        }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["open-advance-invoices"] });
      setOpen(false); setEditing(null); setForm(emptyForm);
      setLines([emptyLine()]);
      setPrepayments({});
      toast({ title: t("Changes saved", "تم حفظ التعديلات") });
    },
    onError: (e: Error) => toast({ title: t("Error", "خطأ"), description: e.message, variant: "destructive" }),
    onSettled: () => { submittingRef.current = false; },
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
          vatRate: String(i.vatRate ?? DEFAULT_VAT_RATE),
        })),
      );
      // AP-2: the draft's current prepayment selection, prefilled so a save keeps it.
      setPrepayments(Object.fromEntries(((detail.prepayments ?? []) as Array<{ advanceInvoiceId: number; amount: number }>).map((p) => [p.advanceInvoiceId, { on: true, amount: String(p.amount) }])));
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
            if (o && !editing) idempotencyKey.current = crypto.randomUUID();
            if (!o) {
              // Leaving EDIT mode explicitly, or the next "New Invoice" would
              // silently PATCH the record just edited.
              setEditing(null);
              setForm(emptyForm);
              setLines([emptyLine()]);
              setPrepayments({});
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
{/* 🔴 No Status here (2026-09-15, walk item 2): a create is ALWAYS a draft and the
                    server forces it — the select that stood here was collected and never sent. */}

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
                    onClick={() => setLines((p) => [...p, emptyLine()])}
                  >
                    {t("Add line", "إضافة بند")}
                  </Button>
                  <span className="text-sm">
                    <span className="text-muted-foreground me-2">{t("Total (incl. VAT)", "الإجمالي شامل الضريبة")}</span>
                    <span className="font-mono">{fmtNum(invoiceTotal)}</span>
                  </span>
                </div>
              </div>

              {/* ── AP-2: apply the customer's advance tax invoices (386). Shown only when the customer has open ones. ── */}
              {(!editing || editing.documentType === "invoice") && openAdvances.length > 0 && (
                <div className="space-y-2 border-t border-border pt-3" data-testid="prepayments-section">
                  <Label className="text-xs text-muted-foreground">{t("Apply advance tax invoices (prepayment adjustment)", "تطبيق الفواتير الضريبية للدفعات المقدمة (تسوية الدفعة المقدمة)")}</Label>
                  <p className="text-xs text-muted-foreground">
                    {t("Tick the advance tax invoices this invoice settles. Their VAT was declared when they were issued; the invoice files the rest and shows the advance as PrepaidAmount.",
                       "حدّد الفواتير الضريبية للدفعات المقدمة التي تسوّيها هذه الفاتورة. قُرِّرت ضريبتها عند إصدارها؛ تُدرج الفاتورة الباقي وتُظهر الدفعة المقدمة كمبلغ مدفوع مقدمًا.")}
                  </p>
                  {openAdvances.map((a) => {
                    const sel = prepayments[a.id] ?? { on: false, amount: "" };
                    return (
                      <div key={a.id} className="grid grid-cols-12 gap-2 items-center" data-testid={`prepayment-${a.id}`}>
                        <label className="col-span-7 flex items-center gap-2 text-sm">
                          <input type="checkbox" className="h-4 w-4" checked={sel.on} onChange={(e) => setPrepayments((p) => ({ ...p, [a.id]: { on: e.target.checked, amount: sel.amount } }))} data-testid={`prepayment-check-${a.id}`} />
                          <span className="font-mono text-xs">{a.invoiceNumber}</span>
                          <span className="text-xs text-muted-foreground"><span dir="ltr">{a.date}</span> · {t("open", "المتبقي")} <span className="font-mono">{fmtNum(a.openAmount)}</span></span>
                        </label>
                        <Input
                          className="col-span-5 h-8 text-sm"
                          type="number"
                          disabled={!sel.on}
                          placeholder={fmtNum(a.openAmount)}
                          value={sel.amount}
                          onChange={(e) => setPrepayments((p) => ({ ...p, [a.id]: { on: true, amount: e.target.value } }))}
                          data-testid={`prepayment-amount-${a.id}`}
                        />
                      </div>
                    );
                  })}
                  {selectedPrepayments.length > 0 && (
                    <div className="text-sm space-y-0.5" data-testid="prepayment-summary">
                      <div className="flex justify-between"><span className="text-muted-foreground">{t("Prepaid (advance, incl. VAT)", "مدفوع مقدمًا (الدفعة المقدمة، شامل الضريبة)")}</span><span className="font-mono">{fmtNum(prepaidTotal)}</span></div>
                      <div className="flex justify-between font-medium"><span>{t("Amount due", "المبلغ المستحق")}</span><span className="font-mono" data-testid="prepayment-amount-due">{fmtNum(invoiceTotal - prepaidTotal)}</span></div>
                      {prepaidTotal > invoiceTotal + 0.005 && <p className="text-xs text-destructive">{t("The advances applied exceed this invoice's total — apply at most the total; the rest stays on the customer's deposit.", "الدفعات المقدمة المطبّقة تتجاوز إجمالي هذه الفاتورة — طبّق الإجمالي على الأكثر؛ يبقى الباقي في عربون العميل.")}</p>}
                    </div>
                  )}
                </div>
              )}
            </div>
            <Button
              className="w-full mt-4"
              onClick={()=> {
                // 🔴 TRULY synchronous guard (2026-09-14). The first version
                // checked `createMut.isPending` here and CLAIMED it flips
                // synchronously — it does not: it is a render snapshot, so two
                // clicks landing before the re-render both saw `false`, and CI
                // caught the second POST under load (a claim inside a guard is
                // still a claim). A ref has no render in its loop. (The server
                // idempotency key remains the durable half either way.)
                if (submittingRef.current) return;
                submittingRef.current = true;
                editing ? updateMut.mutate(form) : createMut.mutate(form);
              }}
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

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {[
          // Every figure here is the SERVER's, over the whole filtered set.
          [t("Total Invoices", "إجمالي الفواتير"), pageInfo?.total ?? "—", "text-primary"],
          [t("Outstanding", "المستحق"), totals ? fmtNum(totals.outstanding) : "—", "text-attention"],
          [t("Collected", "المحصّل"), totals ? fmtNum(totals.collected) : "—", "text-positive"],
          [t("Overdue", "متأخر"), totals?.overdue ?? "—", "text-negative"],
        ].map(([l,v,c])=>(
          <Card key={String(l)} className="border-border bg-card"><CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{l}</CardTitle></CardHeader><CardContent><div className={`text-xl sm:text-2xl font-bold font-mono ${c}`}>{v}</div></CardContent></Card>
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
            <div className="overflow-x-auto"><table className="w-full text-sm">
              <thead><tr className="border-b border-border text-muted-foreground text-xs uppercase">{[
                t("Invoice #", "رقم الفاتورة"),
                t("Customer", "العميل"),
                t("Date", "التاريخ"),
                t("Due Date", "تاريخ الاستحقاق"),
                t("Amount", "المبلغ"),
                t("VAT", "ضريبة القيمة المضافة"),
                t("Total", "الإجمالي"),
                t("Due", "المستحق"),
                t("Status", "الحالة"),
                "",
              ].map(h=><th key={h} className="text-start pb-2 pe-4 font-medium">{h}</th>)}</tr></thead>
              <tbody>{invoices.map(inv=>(
                <tr key={inv.id} className="border-b border-border/50 hover:bg-secondary/20 transition-colors">
                  <td className="py-3 pe-4 font-mono text-xs text-primary">
                    {inv.invoiceNumber}{inv.isOpening && <OpeningRecordBadge />}
                    {/* AP-2: the document's TYPE beside its number — a 386 declares VAT on a deposit and is never owed; a 388 that applied one says so. */}
                    {inv.documentType === "advance_invoice" && <Badge variant="outline" className="ms-2 text-[10px] font-sans" data-testid={`type-advance-${inv.id}`}>{t("Advance tax invoice", "فاتورة دفعة مقدمة")}</Badge>}
                    {inv.documentType === "advance_credit_note" && <Badge variant="outline" className="ms-2 text-[10px] font-sans" data-testid={`type-advance-cn-${inv.id}`}>{t("Credit note — advance", "إشعار دائن — دفعة مقدمة")}</Badge>}
                    {inv.documentType === "recovery_invoice" && <Badge variant="outline" className="ms-2 text-[10px] font-sans" data-testid={`type-recovery-${inv.id}`}>{t("Tax invoice — recovery (Art. 40(9))", "فاتورة ضريبية — استرداد (م. 40(9))")}</Badge>}
                    {inv.badDebtRelief && <Badge variant="outline" className="ms-2 text-[10px] font-sans" data-testid={`type-written-off-${inv.id}`}>{t("Written off", "مشطوبة")} {fmtNum(inv.writtenOffAmount)}</Badge>}
                    {inv.documentType === "invoice" && inv.prepaidAmount > 0.005 && <Badge variant="outline" className="ms-2 text-[10px] font-sans" data-testid={`type-prepaid-${inv.id}`}>{t("Advance applied", "طُبّقت دفعة مقدمة")} {fmtNum(inv.prepaidAmount)}</Badge>}
                  </td>
                  <td className="py-3 pe-4 font-medium">{inv.customerName ?? "—"}</td>
                  <td className="py-3 pe-4 text-muted-foreground text-xs"><DualDate date={inv.date} /></td>
                  <td className="py-3 pe-4 text-muted-foreground text-xs"><DualDate date={inv.dueDate} /></td>
                  <td className="py-3 pe-4 font-mono">{fmtNum(inv.subtotal)}</td>
                  <td className="py-3 pe-4 font-mono text-muted-foreground">{fmtNum(inv.vatAmount)}</td>
                  <td className="py-3 pe-4 font-mono font-semibold">{fmtNum(inv.total)}</td>
                  {/* What is still OWED on the document: nothing on a 386 or a note; total − paid − credited otherwise (the advance, once applied, sits in paid). */}
                  <td className="py-3 pe-4 font-mono text-muted-foreground" data-testid={`due-${inv.id}`}>
                    {inv.documentType === "advance_invoice" || inv.documentType === "advance_credit_note" || inv.documentType === "recovery_invoice" || inv.documentType === "credit_note" || inv.status === "draft" || inv.status === "submitted" ? "—" : fmtNum(inv.total - inv.paidAmount - inv.creditedAmount - inv.writtenOffAmount)}
                  </td>
                  <td className="py-3 pe-4"><Badge className={`gap-1 text-xs ${STATUS_STYLES[inv.status] ?? ""}`}>{STATUS_ICONS[inv.status]}{statusLabel(inv.status, lang)}</Badge></td>
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
                          {/* A draft 386's amount is the receipt's; only its notes are editable, so Edit is not offered (Delete is). */}
                          {inv.documentType !== "advance_invoice" && inv.documentType !== "advance_credit_note" && inv.documentType !== "recovery_invoice" && <Button variant="ghost" size="sm" className="text-xs h-7"
                            onClick={() => openEdit(inv)}>
                            {t("Edit", "تعديل")}
                          </Button>}
                          <Button variant="ghost" size="sm" className="text-xs h-7 text-negative"
                            onClick={() => setConfirmDelete(inv)}>
                            {t("Delete", "حذف")}
                          </Button>
                        </>
                      )}
                      {/* 🔴 QA fix (2026-09-04): Mark Paid ONLY on an ISSUED
                          invoice. The server refuses a draft/submitted payment
                          ("Invoice must be approved before a payment can be
                          recorded"), so offering it there was a control that
                          could only fail — the same show-only-where-valid rule
                          the draft-only Edit/Delete already follow. */}
                      {inv.status === "sent" && inv.documentType === "invoice" && (
                        <Button variant="ghost" size="sm" className="text-xs h-7 text-positive" onClick={()=>{setPayOpen(inv.id);setPayAmount(String(inv.total-inv.paidAmount));}}>{t("Mark Paid", "تسجيل كمدفوع")}</Button>
                      )}
                      {/* 2026-09-22: a receivable that went bad — the Art. 40(7) write-off with relief (an issued, unpaid, non-migrated invoice) and, once relieved, the Art. 40(9) recovery document. */}
                      {inv.status === "sent" && inv.documentType === "invoice" && !inv.isOpening && !inv.badDebtRelief && inv.total - inv.paidAmount - inv.creditedAmount > 0.005 && (
                        <Button variant="ghost" size="sm" className="text-xs h-7 text-muted-foreground" onClick={() => setWriteOffFor(inv)} data-testid={`write-off-${inv.id}`}>{t("Write off", "شطب")}</Button>
                      )}
                      {inv.documentType === "invoice" && inv.badDebtRelief && (
                        <Button variant="ghost" size="sm" className="text-xs h-7 text-primary" onClick={() => setRecoveryFor(inv)} data-testid={`declare-recovery-${inv.id}`}>{t("Declare recovery", "إفصاح عن استرداد")}</Button>
                      )}
                      {/* L1 — the invoice leaves the product. ع is THE tax
                          invoice (Arabic, PDF/A-3); EN is a labelled
                          translation — its banner says the Arabic document is
                          the tax invoice. Anchors, not fetch: the session
                          cookie rides the same-origin GET and the server's
                          Content-Disposition does the saving. Issued documents
                          only — a draft has no QR and no legal existence. */}
                      {/* Batch 1C, Issue 1 carry-over: an OPENING receivable is a
                          historical record from the previous system, not a tax
                          invoice issued here — there is no tax-invoice document
                          to download, so the buttons are not offered (the server
                          refuses the render with 409 opening_item_not_a_tax_invoice
                          as defence in depth). The note says what the row is. */}
                      {inv.isOpening && <OpeningRecordNote />}
                      {!inv.isOpening && inv.status !== "draft" && inv.status !== "submitted" && (
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
                          repeat this invoice monthly as DRAFTS for approval.
                          Not on an opening item: a historical balance is not a
                          document to repeat (walk, 2026-09-20). */}
                      {!inv.isOpening && <Button
                        variant="ghost"
                        size="sm"
                        className="text-xs h-7 text-muted-foreground"
                        title={t("Repeat monthly as drafts", "تكرار شهريًا كمسودات")}
                        onClick={() => makeRecurringMut.mutate(inv)}
                        disabled={makeRecurringMut.isPending}
                      >
                        <Repeat className="h-3.5 w-3.5" />
                      </Button>}
                    </div>
                  </td>
                </tr>
              ))}</tbody>
            </table></div>
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

      {writeOffFor && <WriteOffBadDebtDialog invoice={writeOffFor} open onClose={() => setWriteOffFor(null)} />}
      {recoveryFor && <BadDebtRecoveryDialog invoice={recoveryFor} open onClose={() => setRecoveryFor(null)} />}
      <Dialog open={payOpen !== null} onOpenChange={()=>setPayOpen(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>{t("Record Payment", "تسجيل دفعة")}</DialogTitle></DialogHeader>
          <div className="space-y-3 mt-2">
            <div><Label className="text-xs text-muted-foreground">{t("Amount Received (SAR)", "المبلغ المستلم (ر.س)")}</Label><Input type="number" value={payAmount} onChange={e=>setPayAmount(e.target.value)} className="mt-1 h-8 text-sm" /></div>
            <div>
              <Label className="text-xs text-muted-foreground">{t("Received into bank account *", "استُلم في الحساب البنكي *")}</Label>
              <Select value={payBank || (defaultBankId != null ? String(defaultBankId) : "")} onValueChange={setPayBank}>
                <SelectTrigger className="mt-1 h-8 text-sm" data-testid="pay-bank-account"><SelectValue placeholder={t("Choose the bank account", "اختر الحساب البنكي")} /></SelectTrigger>
                <SelectContent>{activeBanks.map((b) => <SelectItem key={b.id} value={String(b.id)}>{b.name} — {b.bankName}</SelectItem>)}</SelectContent>
              </Select>
              {activeBanks.length === 0 && <p className="text-xs text-destructive mt-1">{t("Add a bank account first — a payment is recorded against the account it arrived in.", "أضف حسابًا بنكيًا أولًا — تُسجَّل الدفعة على الحساب الذي وصلت إليه.")}</p>}
            </div>
            <PaymentHistory entity="invoices" id={payOpen} />
          </div>
          <Button className="w-full mt-4 bg-emerald-600 hover:bg-emerald-700" onClick={()=>{ const bank = Number(payBank || defaultBankId); if (payingRef.current || !payOpen || !bank) return; payingRef.current = true; payMut.mutate({id:payOpen,amount:Number(payAmount),bankAccountId:bank}); }} disabled={!payAmount||payMut.isPending||!(payBank||defaultBankId)}>
            {payMut.isPending ? t("Recording...", "جارٍ التسجيل...") : t("Record Payment", "تسجيل الدفعة")}
          </Button>
        </DialogContent>
      </Dialog>
    </div>
  );
}
