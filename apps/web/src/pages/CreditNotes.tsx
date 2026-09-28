import { DEFAULT_VAT_RATE } from "@workspace/shared";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { useLanguage } from "@/contexts/LanguageContext";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, FileMinus, FilePlus, AlertTriangle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { PageHeader, StatStrip, Stat, Panel, EmptyState } from "@/components/kit";
import { DualDate } from "@/components/DualDate";

/**
 * Credit & debit notes (M12.1b).
 *
 * ── This page used to be a SHELL ───────────────────────────────────────────
 * It called `/credit-notes`, which never existed, and swallowed the error with
 * `.catch(() => [])` — so it rendered an empty list forever and its create
 * dialog went nowhere. It is now built on the real backend: notes are `invoices`
 * rows with `documentType` credit_note | debit_note, so they flow through the
 * same approval workflow and the same ZATCA chain as invoices.
 *
 * Amounts are POSITIVE on every document type; the direction is carried by
 * `documentType`. A credit note reduces what the customer owes; a DEBIT note is
 * an additional charge and increases it.
 */
import type { CreateInvoiceInput, Invoice, ListInvoices200 } from "@workspace/api-client-react";
import { businessToday } from "@workspace/shared";

/**
 * Request bodies go through the GENERATED input types (contract batch 3), so
 * this page cannot build a request the server does not accept — the class of
 * defect no server test can see, because every server test builds its request
 * the way the server expects.
 */
const json = { create: (b: CreateInvoiceInput) => JSON.stringify(b) };

const STATUS_STYLES: Record<string, string> = {
  draft: "bg-secondary text-muted-foreground",
  submitted: "bg-attention-surface/20 text-attention",
  sent: "bg-positive-surface/20 text-positive",
  paid: "bg-positive-surface/20 text-positive",
};

const makeEmpty = () => ({
  documentType: "credit_note",
  /**
   * 🔴 AUD-1: EMPTY, so the SERVER allocates from the company's one sequence.
   * This used to be `CN-${Date.now().slice(-6)}`, which put every credit and
   * debit note outside the C12 counter — a second concurrent number series,
   * which the E-Invoicing Resolution §2 lists as a Prohibited Functionality
   * (one sequence per unit, spanning "Electronic Invoices and Electronic
   * Notes"). The suffix was also the last six digits of a millisecond clock,
   * so it wrapped every ~16.7 minutes onto a UNIQUE(company_id, invoice_number)
   * collision. C12 removed exactly this from Invoices.tsx and nobody checked
   * the sibling page that creates the sibling document.
   */
  invoiceNumber: "",
  originalInvoiceId: "",
  date: businessToday(),
  noteReason: "",
  description: "",
  quantity: "1",
  unitPrice: "",
  vatRate: String(DEFAULT_VAT_RATE),
});

export default function CreditNotes() {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(makeEmpty());
  const [error, setError] = useState("");
  const { toast } = useToast();
  const { t } = useLanguage();
  const qc = useQueryClient();

  /**
   * 🔴 `/invoices` answers with a PAGE envelope since the pagination change.
   * This read it as a bare array and called `.filter` on it, which throws —
   * the blank-page defect B-1 named, reintroduced by a shape change whose
   * client consumers were not swept. Caught by a typecheck error two files
   * away, not by a test: nothing renders this page.
   */
  const { data: invoicePage, isLoading } = useQuery<ListInvoices200>({
    queryKey: ["invoices"],
    queryFn: () => apiFetch<ListInvoices200>("/invoices?limit=200"),
  });
  const all = invoicePage?.items ?? [];

  const notes = all.filter((i) => i.documentType === "credit_note" || i.documentType === "debit_note");
  // Only ISSUED invoices can be corrected — a draft has nothing in the books.
  // 2026-09-22 (accountant answer 3): a credit note against an invoice the
  // PREVIOUS solution issued is issued here, through Fatoora, naming the
  // original — so an OPENING item is offered once its e-invoicing identity is
  // recorded (Migration → open items → Record identity) and it is the live
  // row of its correction chain; the server refuses the rest by name
  // (opening_item_einvoicing_identity_missing, opening_item_reversed).
  const correctable = all.filter(
    (i) => i.documentType === "invoice" && ["sent", "paid"].includes(i.status) && (!i.isOpening || (!!i.openingEinvoicingStatus && i.reversedAt == null)),
  );

  const create = useMutation({
    mutationFn: () =>
      apiFetch("/invoices", {
        method: "POST",
        body: json.create({
          invoiceNumber: form.invoiceNumber,
          date: form.date,
          documentType: form.documentType as CreateInvoiceInput["documentType"],
          originalInvoiceId: Number(form.originalInvoiceId),
          noteReason: form.noteReason,
          customerId: correctable.find((i) => i.id === Number(form.originalInvoiceId))?.customerId,
          items: [
            {
              description: form.description,
              quantity: Number(form.quantity),
              unitPrice: Number(form.unitPrice),
              vatRate: Number(form.vatRate),
              taxCategoryCode: "S",
              unitCode: "PCE",
            },
          ],
        }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["invoices"] });
      setOpen(false);
      setForm(makeEmpty());
      setError("");
      toast({ title: "Note created" });
    },
    // The server's message is the useful one — it names the ZATCA rule or the
    // remaining creditable amount.
    onError: (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
  });

  const isCredit = form.documentType === "credit_note";
  const totalCredited = notes
    .filter((n) => n.documentType === "credit_note")
    .reduce((s, n) => s + n.total, 0);
  const totalDebited = notes
    .filter((n) => n.documentType === "debit_note")
    .reduce((s, n) => s + n.total, 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("Credit & debit notes", "الإشعارات الدائنة والمدينة")}
        description={t(
          "Corrections to issued invoices. A credit note reduces what the customer owes; a debit note charges more.",
          "تصحيحات على الفواتير الصادرة. الإشعار الدائن يخفّض المبلغ المستحق على العميل؛ والإشعار المدين يزيده.",
        )}
        actions={
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button disabled={correctable.length === 0} data-testid="new-note">
              <Plus className="h-4 w-4 me-2" />
              {t("New note", "إشعار جديد")}
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{isCredit ? t("New credit note", "إشعار دائن جديد") : t("New debit note", "إشعار مدين جديد")}</DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <div>
                <Label className="text-[13px] mb-1.5">{t("Type", "النوع")}</Label>
                <Select
                  value={form.documentType}
                  onValueChange={(v) =>
                    setForm({
                      ...form,
                      documentType: v,
                    })
                  }
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="credit_note">{t("Credit note — reduce the amount owed", "إشعار دائن — تخفيض المبلغ المستحق")}</SelectItem>
                    <SelectItem value="debit_note">{t("Debit note — charge more", "إشعار مدين — زيادة المبلغ")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label className="text-[13px] mb-1.5">{t("Original invoice", "الفاتورة الأصلية")}</Label>
                <Select
                  value={form.originalInvoiceId}
                  onValueChange={(v) => setForm({ ...form, originalInvoiceId: v })}
                >
                  <SelectTrigger data-testid="note-original"><SelectValue placeholder={t("Select an issued invoice", "اختر فاتورة صادرة")} /></SelectTrigger>
                  <SelectContent>
                    {correctable.map((i) => (
                      <SelectItem key={i.id} value={String(i.id)}>
                        {i.invoiceNumber} — {i.customerName ?? "—"} — {fmtNum(i.total)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label className="text-[13px] mb-1.5">{t("Number", "الرقم")}</Label>
                {/* Left blank = the server allocates the next number in the
                    company's single sequence (C12). A value typed here is
                    honoured for legacy imports and judged by the unique
                    constraint, exactly as on the invoice form. */}
                <Input
                  value={form.invoiceNumber}
                  placeholder={t("Assigned automatically", "يُخصص تلقائيًا")}
                  onChange={(e) => setForm({ ...form, invoiceNumber: e.target.value })}
                />
              </div>
              <div>
                <Label className="text-[13px] mb-1.5">{t("Date", "التاريخ")}</Label>
                <Input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
                <p className="text-xs text-muted-foreground mt-1">
                  {t(
                    "The note posts to ITS OWN period. Correcting an invoice from a closed period is fine — date the note in an open one.",
                    "يُرحَّل الإشعار في فترته هو. تصحيح فاتورة من فترة مقفلة أمر سليم — أرِّخ الإشعار في فترة مفتوحة.",
                  )}
                </p>
              </div>
              <div>
                <Label className="text-[13px] mb-1.5">{t("Reason", "السبب")}</Label>
                <Input
                  value={form.noteReason}
                  onChange={(e) => setForm({ ...form, noteReason: e.target.value })}
                  placeholder={isCredit ? t("Goods returned", "بضاعة مرتجعة") : t("Price correction", "تصحيح سعر")}
                />
                <p className="text-xs text-muted-foreground mt-1">
                  {t("Required by ZATCA (BR-KSA-17) — every note must say why it was issued.", "مطلوب من هيئة الزكاة والضريبة (BR-KSA-17) — يجب أن يذكر كل إشعار سبب إصداره.")}
                </p>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div className="col-span-3">
                  <Label className="text-[13px] mb-1.5">{t("Description", "الوصف")}</Label>
                  <Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
                </div>
                <div>
                  <Label className="text-[13px] mb-1.5">{t("Qty", "الكمية")}</Label>
                  <Input value={form.quantity} onChange={(e) => setForm({ ...form, quantity: e.target.value })} />
                </div>
                <div>
                  <Label className="text-[13px] mb-1.5">{t("Unit price", "سعر الوحدة")}</Label>
                  <Input value={form.unitPrice} onChange={(e) => setForm({ ...form, unitPrice: e.target.value })} />
                </div>
                <div>
                  <Label className="text-[13px] mb-1.5">VAT %</Label>
                  <Input value={form.vatRate} onChange={(e) => setForm({ ...form, vatRate: e.target.value })} />
                </div>
              </div>

              {error && (
                <Alert variant="destructive">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}

              <Button
                className="w-full"
                disabled={!form.originalInvoiceId || !form.noteReason || !form.unitPrice || create.isPending}
                onClick={() => create.mutate()}
              >
                {create.isPending ? t("Creating…", "جارٍ الإنشاء…") : t("Create note", "إنشاء الإشعار")}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
        }
      />

      {correctable.length === 0 && (
        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            {t(
              "There are no issued invoices to correct yet. A note can only be raised against an invoice that has been approved and issued.",
              "لا توجد فواتير صادرة للتصحيح بعد. لا يُصدر الإشعار إلا على فاتورة معتمدة وصادرة.",
            )}
          </AlertDescription>
        </Alert>
      )}

      <StatStrip cols={2}>
        <Stat label={<span className="inline-flex items-center gap-1.5"><FileMinus className="h-3.5 w-3.5" /> {t("Total credited", "إجمالي الإشعارات الدائنة")}</span>} value={fmtNum(totalCredited)} />
        <Stat label={<span className="inline-flex items-center gap-1.5"><FilePlus className="h-3.5 w-3.5" /> {t("Total debited", "إجمالي الإشعارات المدينة")}</span>} value={fmtNum(totalDebited)} />
      </StatStrip>

      <Panel flush title={t("Notes", "الإشعارات")}>
        {isLoading ? (
          <p className="text-sm text-muted-foreground p-5">{t("Loading…", "جارٍ التحميل…")}</p>
        ) : notes.length === 0 ? (
          <EmptyState icon={FileMinus} title={t("No credit or debit notes yet.", "لا توجد إشعارات دائنة أو مدينة بعد.")} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-start px-3">{t("Number", "الرقم")}</th>
                  <th className="text-start px-3">{t("Type", "النوع")}</th>
                  <th className="text-start px-3">{t("Date", "التاريخ")}</th>
                  <th className="text-start px-3">{t("Customer", "العميل")}</th>
                  <th className="text-start px-3">{t("Reason", "السبب")}</th>
                  <th className="text-start px-3">{t("Status", "الحالة")}</th>
                  <th className="text-end px-3">{t("Amount", "المبلغ")}</th>
                </tr>
              </thead>
              <tbody>
                {notes.map((n) => (
                  <tr key={n.id} className="border-b border-border/70 hover:bg-muted/40 transition-colors">
                    <td className="py-3 px-3 whitespace-nowrap font-medium text-primary">{n.invoiceNumber}</td>
                    <td className="py-3 px-3">
                      <Badge variant="outline">
                        {n.documentType === "credit_note" ? t("Credit", "دائن") : t("Debit", "مدين")}
                      </Badge>
                    </td>
                    <td className="py-3 px-3 whitespace-nowrap text-muted-foreground"><DualDate date={n.date} /></td>
                    <td className="py-3 px-3 min-w-[10rem]">{n.customerName ?? "—"}</td>
                    <td className="py-3 px-3 max-w-[16rem] truncate text-muted-foreground">{n.noteReason ?? "—"}</td>
                    <td className="py-3 px-3">
                      <Badge className={`capitalize ${STATUS_STYLES[n.status] ?? ""}`}>{n.status}</Badge>
                    </td>
                    {/* Displayed with the sign the books apply, so the row reads
                        the way it affects the customer's balance. */}
                    <td className="py-3 px-3 text-end whitespace-nowrap tabular-nums font-medium">
                      {n.documentType === "credit_note" ? "−" : "+"}
                      {fmtNum(n.total)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
