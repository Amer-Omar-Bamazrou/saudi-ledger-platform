import { useMemo, useState } from "react";
import { useParams, Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, FileText, FileMinus, ClipboardList, Banknote, AlertCircle, ChevronDown, ChevronUp, Undo2, Plus } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { statusLabel } from "@/lib/statusLabel";
import { computeAging, toFetched, DETAIL_FETCH_LIMIT, type FetchedDocs } from "@/lib/partyDetail";
import type { Paged } from "@/lib/pagedList";
import { DualDate } from "@/components/DualDate";
import { OpeningRecordBadge } from "@/components/migration/OpeningRecord";
import { PaymentDetail } from "@/components/payments/PaymentDetail";
import { CreditNoteDetail, useCreditNoteApplications } from "@/components/payments/CreditNoteDetail";
import { ReceiveDialog } from "@/components/payments/ReceiveDialog";
import { BankName, PaymentStateBadge, PermissionHint, receiptNumber, refundNumber, useCanPostPayments } from "@/components/payments/shared";

/**
 * One customer, everything about them.
 *
 * The question "show me this customer" was previously answered by four pages
 * and manual filtering, which is the same complaint as a document not being
 * reachable from its serial number — pointed at the PARTY rather than the
 * document.
 *
 * 🔴 Every figure here is either returned by the server over the whole set
 * (`GET /customers/:id` computes the three-component position in SQL) or
 * computed over a fetched page that states when it was cut. Nothing is
 * silently page-scoped.
 *
 * Batch 1B Phase F (2026-09-17): the position is THREE components and a
 * derived net — what the customer owes (AR), what we owe them from credit
 * notes (a liability), and what we hold on account (a deposit liability).
 * A liability is never shown as a negative receivable. Payments and credit
 * notes open into their allocations, where they are allocated, corrected
 * and refunded.
 */

import type { CustomerDetail as CustomerDetailView, CustomerPayment, CustomerRefund, Invoice, Quotation } from "@workspace/api-client-react";

const money = (n: number) => fmtNum(n ?? 0);

function StatTile({ label, value, tone, testId, hint }: { label: string; value: string; tone?: "warn" | "good" | "info"; testId?: string; hint?: string }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <p className="text-xs uppercase text-muted-foreground mb-1">{label}</p>
        <p className={`text-xl sm:text-2xl font-mono font-semibold ${tone === "warn" ? "text-attention" : tone === "good" ? "text-positive" : tone === "info" ? "text-info" : "text-foreground"}`} data-testid={testId}>
          {value}
        </p>
        {hint && <p className="text-xs text-muted-foreground mt-1">{hint}</p>}
      </CardContent>
    </Card>
  );
}

/** A stated cap, not a silent one — see partyDetail.ts. */
function TruncationNotice({ shown, total }: { shown: number; total: number }) {
  const { t } = useLanguage();
  return (
    <div className="flex items-start gap-2 rounded-md border border-attention-surface/30 bg-attention-surface/10 p-3 text-xs text-amber-200">
      <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
      <span>
        {t(
          `Showing ${shown} of ${total} documents. The aging figures on this page cover only the documents shown.`,
          `يتم عرض ${shown} من ${total} مستند. تغطي أرقام الأعمار في هذه الصفحة المستندات المعروضة فقط.`,
        )}
      </span>
    </div>
  );
}

function InvoiceTable({ rows }: { rows: Invoice[] }) {
  const { t, lang } = useLanguage();
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground py-4">{t("Nothing here yet.", "لا يوجد شيء هنا بعد.")}</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-muted-foreground text-xs uppercase">
            {[t("Number", "الرقم"), t("Date", "التاريخ"), t("Due", "الاستحقاق"), t("Status", "الحالة"), t("Total", "الإجمالي"), t("Outstanding", "المستحق")].map((h) => (
              <th key={h} className="text-start pb-2 pe-4 font-medium">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            // Outstanding as the server defines it (D-4): total − paid − credited.
            const outstanding = Number(r.total ?? 0) - Number(r.paidAmount ?? 0) - Number(r.creditedAmount ?? 0);
            return (
              <tr key={r.id} className="border-b border-border/50 hover:bg-secondary/20 transition-colors" data-testid={`invoice-row-${r.invoiceNumber}`}>
                <td className="py-3 pe-4 font-mono text-xs">{r.invoiceNumber}{r.isOpening && <OpeningRecordBadge />}</td>
                <td className="py-3 pe-4 text-muted-foreground"><DualDate date={r.date} inline /></td>
                <td className="py-3 pe-4 text-muted-foreground"><DualDate date={r.dueDate} inline /></td>
                <td className="py-3 pe-4"><Badge variant="outline" className="text-xs">{statusLabel(r.status, lang)}</Badge></td>
                <td className="py-3 pe-4 font-mono">{money(r.total)}</td>
                <td className="py-3 pe-4 font-mono">
                  <span className={outstanding > 0.005 ? "text-attention" : "text-positive"} data-testid={`invoice-outstanding-${r.invoiceNumber}`}>{money(outstanding)}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** One payment row that opens into its allocations. */
function PaymentRow({ p, customerName, invoiceNumbers }: { p: CustomerPayment; customerName: string; invoiceNumbers: Record<number, string> }) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr className="border-b border-border/50 hover:bg-secondary/20 transition-colors" data-testid={`payment-row-${p.id}`}>
        <td className="py-3 pe-4 font-mono text-xs">{receiptNumber(p.id)}</td>
        <td className="py-3 pe-4 text-muted-foreground"><DualDate date={p.paidAt} inline /></td>
        <td className="py-3 pe-4 text-muted-foreground hidden md:table-cell"><BankName id={p.bankAccountId} /></td>
        <td className="py-3 pe-4 font-mono text-positive">{money(p.amount)}</td>
        <td className="py-3 pe-4 font-mono hidden sm:table-cell">{money(p.allocatedAmount)}</td>
        <td className="py-3 pe-4 font-mono" data-testid={`payment-row-unapplied-${p.id}`}>{money(p.unappliedAmount)}</td>
        <td className="py-3 pe-4 hidden sm:table-cell"><PaymentStateBadge p={p} /></td>
        <td className="py-3 text-end">
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setOpen((o) => !o)} data-testid={`payment-toggle-${p.id}`} aria-expanded={open}>
            {open ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            <span className="ms-1">{open ? t("Hide", "إخفاء") : t("Details", "التفاصيل")}</span>
          </Button>
        </td>
      </tr>
      {open && (
        <tr className="border-b border-border/50 bg-secondary/10">
          <td colSpan={8} className="py-3 px-2 sm:px-4">
            <PaymentDetail payment={p} customerName={customerName} invoiceNumbers={invoiceNumbers} />
          </td>
        </tr>
      )}
    </>
  );
}

/** One credit note row: its remaining credit from the API, opening into its applications. */
function CreditNoteRow({ n, customer, invoiceNumbers }: { n: Invoice; customer: { id: number; name: string }; invoiceNumbers: Record<number, string> }) {
  const { t, lang } = useLanguage();
  const [open, setOpen] = useState(false);
  const issued = n.invoiceHash != null;
  const { data } = useCreditNoteApplications(n.id, issued);
  return (
    <>
      <tr className="border-b border-border/50 hover:bg-secondary/20 transition-colors" data-testid={`credit-note-row-${n.invoiceNumber}`}>
        <td className="py-3 pe-4 font-mono text-xs">{n.invoiceNumber}</td>
        <td className="py-3 pe-4 text-muted-foreground"><DualDate date={n.date} inline /></td>
        <td className="py-3 pe-4 hidden sm:table-cell"><Badge variant="outline" className="text-xs">{statusLabel(n.status, lang)}</Badge></td>
        <td className="py-3 pe-4 text-muted-foreground text-xs hidden md:table-cell max-w-[12rem] truncate">{n.noteReason || "—"}</td>
        <td className="py-3 pe-4 font-mono">{money(n.total)}</td>
        <td className="py-3 pe-4 font-mono text-info" data-testid={`credit-note-remaining-${n.invoiceNumber}`}>
          {!issued ? <span className="text-muted-foreground text-xs font-sans">{t("not issued", "غير صادر")}</span> : data ? money(data.remainingAmount) : "…"}
        </td>
        <td className="py-3 text-end">
          {issued && (
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setOpen((o) => !o)} data-testid={`credit-note-toggle-${n.invoiceNumber}`} aria-expanded={open}>
              {open ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
              <span className="ms-1">{open ? t("Hide", "إخفاء") : t("Details", "التفاصيل")}</span>
            </Button>
          )}
        </td>
      </tr>
      {open && (
        <tr className="border-b border-border/50 bg-secondary/10">
          <td colSpan={7} className="py-3 px-2 sm:px-4">
            <CreditNoteDetail noteId={n.id} customer={customer} invoiceNumbers={invoiceNumbers} originalInvoiceId={n.originalInvoiceId} />
          </td>
        </tr>
      )}
    </>
  );
}

export default function CustomerDetail() {
  const params = useParams<{ id: string }>();
  const id = Number(params.id);
  const { t, lang } = useLanguage();
  const canPost = useCanPostPayments();
  const [receiving, setReceiving] = useState(false);

  const { data: customer, isLoading, error } = useQuery<CustomerDetailView>({
    queryKey: ["customer", id],
    queryFn: () => apiFetch(`/customers/${id}`),
    enabled: Number.isFinite(id),
  });

  const { data: invoiceData } = useQuery<FetchedDocs<Invoice>>({
    queryKey: ["customer-invoices", id],
    queryFn: async () =>
      toFetched(await apiFetch<Paged<Invoice>>(`/invoices?customer_id=${id}&limit=${DETAIL_FETCH_LIMIT}`)),
    enabled: Number.isFinite(id),
  });

  const { data: payments = [], isLoading: paymentsLoading, error: paymentsError } = useQuery<CustomerPayment[]>({
    queryKey: ["payments", "customer", id],
    queryFn: () => apiFetch(`/payments?customer_id=${id}&limit=200`),
    enabled: Number.isFinite(id),
  });

  const { data: refunds = [] } = useQuery<CustomerRefund[]>({
    queryKey: ["refunds", "customer", id],
    queryFn: () => apiFetch(`/payments/refunds?customer_id=${id}&limit=200`),
    enabled: Number.isFinite(id),
  });

  const { data: quotationData } = useQuery<FetchedDocs<Quotation>>({
    queryKey: ["customer-quotations", id],
    queryFn: async () =>
      toFetched(await apiFetch<Paged<Quotation>>(`/quotations?customer_id=${id}&limit=${DETAIL_FETCH_LIMIT}`)),
    enabled: Number.isFinite(id),
  });

  const all = invoiceData?.items ?? [];
  const invoiceNumbers = useMemo(() => Object.fromEntries(all.map((d) => [d.id, d.invoiceNumber])) as Record<number, string>, [all]);

  if (isLoading) return <p className="text-muted-foreground">{t("Loading…", "جارٍ التحميل…")}</p>;
  if (error || !customer) {
    return (
      <div className="space-y-4">
        <Link href="/customers"><Button variant="ghost" size="sm"><ArrowLeft className="w-4 h-4 me-2" />{t("Back to customers", "العودة إلى العملاء")}</Button></Link>
        <p className="text-destructive">{t("Customer not found.", "لم يتم العثور على العميل.")}</p>
      </div>
    );
  }

  // Credit notes are NOT receivables — they are listed as credits, with the
  // balance each still carries, and excluded from aging (which sums what is owed).
  const invoices = all.filter((d) => d.documentType !== "credit_note");
  const creditNotes = all.filter((d) => d.documentType === "credit_note");
  const aging = computeAging(invoices);
  const who = { id: customer.id, name: customer.name };

  return (
    <div className="space-y-6">
      <div>
        <Link href="/customers">
          <Button variant="ghost" size="sm" className="mb-2 -ms-2">
            <ArrowLeft className="w-4 h-4 me-2" />{t("Back to customers", "العودة إلى العملاء")}
          </Button>
        </Link>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-semibold text-foreground">{customer.name}</h1>
            {customer.nameAr && <p className="text-muted-foreground" dir="rtl">{customer.nameAr}</p>}
            <div className="flex gap-2 mt-2 flex-wrap">
              {!customer.isActive && <Badge variant="destructive" className="text-xs">{t("Inactive", "غير نشط")}</Badge>}
              {customer.taxNumber && <Badge variant="outline" className="text-xs font-mono">{t("VAT", "ض.ق.م")} {customer.taxNumber}</Badge>}
              {customer.crNumber && <Badge variant="outline" className="text-xs font-mono">{t("CR", "س.ت")} {customer.crNumber}</Badge>}
              {customer.paymentTermsDays && <Badge variant="outline" className="text-xs font-mono">{customer.paymentTermsDays}d</Badge>}
            </div>
          </div>
          <div className="flex gap-2 flex-wrap">
            <Link href={`/customers/${customer.id}/statement`}>
              <Button variant="outline" size="sm" data-testid="open-statement">{t("Open statement", "فتح كشف الحساب")}</Button>
            </Link>
            <Link href={`/reports/customer-ledger?customer_id=${customer.id}`}>
              <Button variant="ghost" size="sm" data-testid="open-ledger-report">{t("Ledger report", "تقرير دفتر الأستاذ")}</Button>
            </Link>
            <Button size="sm" className="gap-1" disabled={!canPost} onClick={() => setReceiving(true)} data-testid="record-receipt">
              <Plus className="w-4 h-4" />{t("Record receipt", "تسجيل إيصال")}
            </Button>
          </div>
        </div>
      </div>

      {/* The position: three components apart, and a derived net. */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label={t("Accounts receivable", "الذمم المدينة")} hint={t("what the customer owes", "ما يدين به العميل")} value={money(customer.receivable)} tone={customer.receivable > 0.005 ? "warn" : "good"} testId="position-receivable" />
        <StatTile label={t("Customer credits", "أرصدة دائنة للعميل")} hint={t("credit-note balances we owe", "أرصدة إشعارات دائنة ندين بها")} value={money(customer.creditBalance)} tone={customer.creditBalance > 0.005 ? "info" : undefined} testId="position-credits" />
        <StatTile label={t("Customer deposits", "عرابين العميل")} hint={t("receipts held on account", "إيصالات محتفظ بها على الحساب")} value={money(customer.depositBalance)} tone={customer.depositBalance > 0.005 ? "info" : undefined} testId="position-deposits" />
        <StatTile label={t("Net position", "صافي المركز")} hint={t("receivable − credits − deposits", "الذمم − الأرصدة الدائنة − العرابين")} value={money(customer.netPosition)} testId="position-net" />
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <StatTile label={t("Billed", "المفوتر")} value={money(customer.totalBilled)} />
        <StatTile label={t("Paid", "المدفوع")} value={money(customer.totalPaid)} tone="good" />
        <StatTile label={t("Invoices", "الفواتير")} value={String(customer.invoiceCount)} />
      </div>

      {(customer.phone || customer.email || customer.address || customer.city) && (
        <Card>
          <CardHeader><CardTitle className="text-base">{t("Contact", "بيانات الاتصال")}</CardTitle></CardHeader>
          <CardContent className="grid gap-2 sm:grid-cols-2 text-sm">
            {customer.phone && <p><span className="text-muted-foreground">{t("Phone", "الهاتف")}: </span>{customer.phone}</p>}
            {customer.email && <p><span className="text-muted-foreground">{t("Email", "البريد الإلكتروني")}: </span>{customer.email}</p>}
            {customer.address && <p><span className="text-muted-foreground">{t("Address", "العنوان")}: </span>{customer.address}</p>}
            {customer.city && <p><span className="text-muted-foreground">{t("City", "المدينة")}: </span>{customer.city}</p>}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle className="text-base">{t("Aging", "أعمار الذمم")}</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {invoiceData?.truncated && <TruncationNotice shown={all.length} total={invoiceData.total} />}
          <div className="grid gap-3 grid-cols-2 lg:grid-cols-5 text-sm">
            {[
              { l: t("Current", "جارٍ"), v: aging.current },
              { l: t("1–30 days", "١–٣٠ يوم"), v: aging.d1to30 },
              { l: t("31–60 days", "٣١–٦٠ يوم"), v: aging.d31to60 },
              { l: t("61–90 days", "٦١–٩٠ يوم"), v: aging.d61to90 },
              { l: t("90+ days", "أكثر من ٩٠ يوم"), v: aging.d90plus },
            ].map((b) => (
              <div key={b.l} className="rounded-md border border-border p-3">
                <p className="text-xs text-muted-foreground mb-1">{b.l}</p>
                <p className="font-mono font-medium">{money(b.v)}</p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base flex items-center gap-2"><FileText className="w-4 h-4" />{t("Invoices", "الفواتير")} ({invoices.length})</CardTitle></CardHeader>
        <CardContent><InvoiceTable rows={invoices} /></CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2"><Banknote className="w-4 h-4" />{t("Payments", "المدفوعات")} ({payments.length})</CardTitle>
          <p className="text-xs text-muted-foreground">{t("Each payment is a receipt of money; open one to see the allocations that link it to invoices, and what is still on account.", "كل دفعة هي إيصال استلام مال؛ افتح إحداها لترى التخصيصات التي تربطها بالفواتير وما لا يزال على الحساب.")}</p>
        </CardHeader>
        <CardContent>
          <PermissionHint />
          {paymentsLoading ? (
            <p className="text-sm text-muted-foreground py-4">{t("Loading…", "جارٍ التحميل…")}</p>
          ) : paymentsError ? (
            <p className="text-sm text-destructive py-4">{t("Payments could not be loaded.", "تعذر تحميل المدفوعات.")} {(paymentsError as Error).message}</p>
          ) : payments.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4">{t("No payments recorded.", "لا توجد مدفوعات مسجلة.")}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-muted-foreground text-xs uppercase">
                    <th className="text-start pb-2 pe-4 font-medium">{t("Receipt", "الإيصال")}</th>
                    <th className="text-start pb-2 pe-4 font-medium">{t("Received", "الاستلام")}</th>
                    <th className="text-start pb-2 pe-4 font-medium hidden md:table-cell">{t("Bank", "البنك")}</th>
                    <th className="text-start pb-2 pe-4 font-medium">{t("Amount", "المبلغ")}</th>
                    <th className="text-start pb-2 pe-4 font-medium hidden sm:table-cell">{t("Allocated", "المخصص")}</th>
                    <th className="text-start pb-2 pe-4 font-medium">{t("On account", "على الحساب")}</th>
                    <th className="text-start pb-2 pe-4 font-medium hidden sm:table-cell">{t("State", "الحالة")}</th>
                    <th className="pb-2" />
                  </tr>
                </thead>
                <tbody>
                  {payments.map((p) => <PaymentRow key={p.id} p={p} customerName={customer.name} invoiceNumbers={invoiceNumbers} />)}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2"><FileMinus className="w-4 h-4" />{t("Credit Notes", "إشعارات الدائن")} ({creditNotes.length})</CardTitle>
          <p className="text-xs text-muted-foreground">{t("A credit note's unconsumed balance is a credit we owe the customer — apply it to an invoice or refund it.", "الرصيد غير المستهلك من إشعار الدائن هو رصيد ندين به للعميل — طبّقه على فاتورة أو اردده.")}</p>
        </CardHeader>
        <CardContent>
          {creditNotes.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4">{t("Nothing here yet.", "لا يوجد شيء هنا بعد.")}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-muted-foreground text-xs uppercase">
                    <th className="text-start pb-2 pe-4 font-medium">{t("Number", "الرقم")}</th>
                    <th className="text-start pb-2 pe-4 font-medium">{t("Date", "التاريخ")}</th>
                    <th className="text-start pb-2 pe-4 font-medium hidden sm:table-cell">{t("Status", "الحالة")}</th>
                    <th className="text-start pb-2 pe-4 font-medium hidden md:table-cell">{t("Reason", "السبب")}</th>
                    <th className="text-start pb-2 pe-4 font-medium">{t("Total", "الإجمالي")}</th>
                    <th className="text-start pb-2 pe-4 font-medium">{t("Remaining credit", "الرصيد المتبقي")}</th>
                    <th className="pb-2" />
                  </tr>
                </thead>
                <tbody>
                  {creditNotes.map((n) => <CreditNoteRow key={n.id} n={n} customer={who} invoiceNumbers={invoiceNumbers} />)}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {refunds.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2"><Undo2 className="w-4 h-4" />{t("Refunds", "المبالغ المردودة")} ({refunds.length})</CardTitle>
            <p className="text-xs text-muted-foreground">{t("Money paid back to the customer. Each refund settled a deposit or a credit-note balance; the source stays listed above.", "أموال أُعيدت إلى العميل. سوّى كل ردّ عربونًا أو رصيد إشعار دائن؛ ويبقى المصدر مدرجًا أعلاه.")}</p>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-muted-foreground text-xs uppercase">
                    <th className="text-start pb-2 pe-4 font-medium">{t("Refund", "الردّ")}</th>
                    <th className="text-start pb-2 pe-4 font-medium">{t("Date", "التاريخ")}</th>
                    <th className="text-start pb-2 pe-4 font-medium">{t("Origin", "المصدر")}</th>
                    <th className="text-start pb-2 pe-4 font-medium hidden md:table-cell">{t("Bank", "البنك")}</th>
                    <th className="text-start pb-2 pe-4 font-medium">{t("Amount", "المبلغ")}</th>
                    <th className="text-start pb-2 pe-4 font-medium hidden sm:table-cell">{t("Reason", "السبب")}</th>
                  </tr>
                </thead>
                <tbody>
                  {refunds.map((r) => (
                    <tr key={r.id} className="border-b border-border/50" data-testid={`refund-row-${r.id}`}>
                      <td className="py-3 pe-4 font-mono text-xs">{refundNumber(r.id)}</td>
                      <td className="py-3 pe-4 text-muted-foreground"><DualDate date={r.refundedAt} inline /></td>
                      <td className="py-3 pe-4 text-xs">
                        {r.origin === "deposit"
                          ? <>{t("Deposit", "عربون")} · <span className="font-mono">{receiptNumber(r.paymentId ?? 0)}</span></>
                          : <>{t("Credit note", "إشعار دائن")} · <span className="font-mono">{r.creditNoteId != null ? (invoiceNumbers[r.creditNoteId] ?? `#${r.creditNoteId}`) : "—"}</span></>}
                      </td>
                      <td className="py-3 pe-4 text-muted-foreground hidden md:table-cell"><BankName id={r.bankAccountId} /></td>
                      <td className="py-3 pe-4 font-mono text-negative">−{money(r.amount)}</td>
                      <td className="py-3 pe-4 text-xs text-muted-foreground hidden sm:table-cell max-w-[16rem] truncate">{r.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle className="text-base flex items-center gap-2"><ClipboardList className="w-4 h-4" />{t("Quotations", "عروض الأسعار")} ({quotationData?.items.length ?? 0})</CardTitle></CardHeader>
        <CardContent>
          {(quotationData?.items.length ?? 0) === 0 ? (
            <p className="text-sm text-muted-foreground py-4">{t("No quotations.", "لا توجد عروض أسعار.")}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-muted-foreground text-xs uppercase">
                    {[t("Number", "الرقم"), t("Date", "التاريخ"), t("Status", "الحالة"), t("Total", "الإجمالي")].map((h) => (
                      <th key={h} className="text-start pb-2 pe-4 font-medium">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {quotationData!.items.map((q) => (
                    <tr key={q.id} className="border-b border-border/50">
                      <td className="py-3 pe-4 font-mono text-xs">{q.quotationNumber}</td>
                      <td className="py-3 pe-4 text-muted-foreground"><DualDate date={q.date} inline /></td>
                      <td className="py-3 pe-4"><Badge variant="outline" className="text-xs">{statusLabel(q.status, lang)}</Badge></td>
                      <td className="py-3 pe-4 font-mono">{money(q.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {receiving && <ReceiveDialog open onClose={() => setReceiving(false)} customer={who} />}
    </div>
  );
}
