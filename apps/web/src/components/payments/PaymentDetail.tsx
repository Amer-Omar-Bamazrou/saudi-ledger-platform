/**
 * One PAYMENT, and the ALLOCATIONS under it — two different things on one
 * card, laid out so a reader cannot confuse them: the payment's own facts
 * (date, bank, amount, reference) up top; then "where it went": each
 * allocation to an invoice, its correction if any, and what is still held
 * on account. Every figure comes from the API (allocated / refunded /
 * unapplied are server-computed); the card computes nothing.
 */
import { Fragment, useState } from "react";
import { Link } from "wouter";
import { fmtNum } from "@/lib/api";
import { useLanguage } from "@/contexts/LanguageContext";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DualDate } from "@/components/DualDate";
import { AllocateDialog } from "./AllocateDialog";
import { UnallocateDialog } from "./UnallocateDialog";
import { RefundDialog } from "./RefundDialog";
import { ClassifyDialog } from "./ClassifyDialog";
import { AdvanceInvoiceDialog } from "./AdvanceInvoiceDialog";
import { AdvanceCreditNoteDialog } from "./AdvanceCreditNoteDialog";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import { BankName, ClassificationBadge, PaymentStateBadge, PermissionHint, invalidatePaymentQueries, receiptNumber, useCanPostPayments, useClassificationLabels } from "./shared";

import type { CustomerPayment, PaymentAllocation, ReceiptAdvanceInvoice } from "@workspace/api-client-react";

export function AllocationRows({
  allocations, invoiceNumbers, customerName, sourceLabel, origin, canPost, locked,
}: {
  allocations: PaymentAllocation[];
  invoiceNumbers: Record<number, string>;
  customerName: string;
  sourceLabel: string;
  origin: "deposit" | "credit_note";
  canPost: boolean;
  /** Allocations the server will not unapply (a credit note's settlement of its own original). */
  locked?: ReadonlySet<number>;
}) {
  const { t } = useLanguage();
  const [correcting, setCorrecting] = useState<PaymentAllocation | null>(null);
  const label = (id: number) => invoiceNumbers[id] ?? `#${id}`;
  if (allocations.length === 0) {
    return <p className="text-sm text-muted-foreground py-2" data-testid="no-allocations">{t("No allocations yet — the whole amount is on account.", "لا توجد تخصيصات بعد — المبلغ كله على الحساب.")}</p>;
  }
  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-muted-foreground text-xs uppercase">
              <th className="text-start pb-2 pe-3 font-medium">{t("Allocation", "التخصيص")}</th>
              <th className="text-start pb-2 pe-3 font-medium">{t("To invoice", "إلى الفاتورة")}</th>
              <th className="text-start pb-2 pe-3 font-medium">{t("Amount", "المبلغ")}</th>
              <th className="text-start pb-2 pe-3 font-medium hidden sm:table-cell">{t("Date", "التاريخ")}</th>
              <th className="text-start pb-2 pe-3 font-medium">{t("State", "الحالة")}</th>
              <th className="pb-2" />
            </tr>
          </thead>
          <tbody>
            {allocations.map((a) => (
              <tr key={a.id} className={`border-b border-border/50 ${a.reversedBy ? "opacity-70" : ""}`} data-testid={`allocation-${a.id}`} data-allocation-state={a.reversedBy ? "corrected" : "active"}>
                <td className="py-2 pe-3 font-mono text-xs">#{a.id}</td>
                <td className="py-2 pe-3 font-mono text-xs">
                  <Link href="/invoices" className="text-primary hover:underline">{label(a.invoiceId)}</Link>
                </td>
                <td className={`py-2 pe-3 font-mono ${a.reversedBy ? "line-through" : ""}`}>{fmtNum(a.amount)}</td>
                <td className="py-2 pe-3 text-muted-foreground hidden sm:table-cell"><DualDate date={a.createdAt.slice(0, 10)} inline /></td>
                <td className="py-2 pe-3">
                  {a.reversedBy ? (
                    <div>
                      <Badge variant="outline" className="text-xs">{t("Corrected", "مُصحَّح")}</Badge>
                      <p className="text-xs text-muted-foreground mt-1 max-w-[16rem]">
                        {t("Unapplied on", "أُلغي التخصيص في")} {a.reversedBy.createdAt.slice(0, 10)} · {a.reversedBy.reason}
                      </p>
                    </div>
                  ) : (
                    <Badge className="text-xs bg-positive-surface/20 text-positive">{t("Active", "نشط")}</Badge>
                  )}
                </td>
                <td className="py-2 text-end">
                  {!a.reversedBy && locked?.has(a.id) ? (
                    <span className="text-xs text-muted-foreground whitespace-nowrap">{t("Tax document effect", "أثر المستند الضريبي")}</span>
                  ) : !a.reversedBy ? (
                    <Button variant="ghost" size="sm" className="h-7 text-xs" disabled={!canPost} onClick={() => setCorrecting(a)} data-testid={`unallocate-${a.id}`}>
                      {t("Unallocate", "إلغاء التخصيص")}
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {correcting && (
        <UnallocateDialog
          open
          onClose={() => setCorrecting(null)}
          allocation={{ id: correcting.id, amount: correcting.amount }}
          customerName={customerName}
          sourceLabel={sourceLabel}
          invoiceNumber={label(correcting.invoiceId)}
          origin={origin}
        />
      )}
    </>
  );
}

/**
 * AP-2 — the ADVANCE TAX INVOICES (386) issued from this receipt: what the
 * deposit's VAT position is (invoiced / adjusted / open / not yet invoiced —
 * the server's figures), each document with its status, and the two acts:
 * issue one (a draft from the receipt) and approve a draft (the separate
 * act on the document, as for any invoice). Shown for a receipt classified
 * as an advance, or once any 386 exists on it.
 */
function AdvanceInvoicesSection({ payment, customerName, canPost }: { payment: CustomerPayment; customerName: string; canPost: boolean }) {
  const { t, lang } = useLanguage();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [issuing, setIssuing] = useState(false);
  // AP-3: the 386 being cancelled (a credit note against it), if any.
  const [crediting, setCrediting] = useState<ReceiptAdvanceInvoice | null>(null);
  const isAdvance = payment.classification?.classification === "advance";
  const approve = useMutation({
    mutationFn: (id: number) => apiFetch(`/invoices/${id}/approve`, { method: "POST" }),
    onSuccess: () => { invalidatePaymentQueries(qc); toast({ title: t("Advance tax invoice issued", "صدرت الفاتورة الضريبية للدفعة المقدمة") }); },
    onError: (e: Error) => toast({ title: t("Error", "خطأ"), description: e.message, variant: "destructive" }),
  });
  const approveNote = useMutation({
    mutationFn: (id: number) => apiFetch(`/invoices/${id}/approve`, { method: "POST" }),
    onSuccess: () => { invalidatePaymentQueries(qc); toast({ title: t("Credit note issued — the advance is cancelled", "صدر الإشعار الدائن — أُلغيت الدفعة المقدمة") }); },
    onError: (e: Error) => toast({ title: t("Error", "خطأ"), description: e.message, variant: "destructive" }),
  });
  if (!isAdvance && payment.advanceInvoices.length === 0) return null;
  const statusLabel = (s: string) => (s === "draft" ? t("Draft", "مسودة") : s === "submitted" ? t("Submitted", "مُرسلة") : t("Issued", "صادرة"));
  return (
    <div className="space-y-2 rounded-md border border-border p-3" data-testid={`advance-invoices-${payment.id}`}>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-xs uppercase text-muted-foreground">{t("Advance tax invoices (386)", "الفواتير الضريبية للدفعات المقدمة (386)")}</p>
        {isAdvance && payment.uninvoicedAmount > 0.005 && (
          <Button size="sm" className="h-8" disabled={!canPost} onClick={() => setIssuing(true)} data-testid={`issue-advance-${payment.id}`}>
            {t("Issue advance tax invoice", "إصدار فاتورة ضريبية عن الدفعة المقدمة")}
          </Button>
        )}
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Fact k={t("Invoiced (VAT declared)", "صدرت فاتورته (الضريبة مقرَّرة)")} v={<span className="font-mono">{fmtNum(payment.advanceInvoicedAmount)}</span>} testId={`advance-invoiced-${payment.id}`} />
        <Fact k={t("Applied on final invoices", "طُبِّق على فواتير نهائية")} v={<span className="font-mono">{fmtNum(payment.advanceAdjustedAmount)}</span>} testId={`advance-adjusted-${payment.id}`} />
        <Fact k={t("Awaiting the final invoice", "بانتظار الفاتورة النهائية")} v={<span className="font-mono text-info">{fmtNum(payment.advanceOpenAmount)}</span>} testId={`advance-open-${payment.id}`} />
        <Fact k={t("Not yet invoiced", "لم تُصدر فاتورته بعد")} v={<span className={`font-mono ${payment.uninvoicedAmount > 0.005 && isAdvance ? "text-attention" : ""}`}>{fmtNum(payment.uninvoicedAmount)}</span>} testId={`advance-uninvoiced-${payment.id}`} />
      </div>
      {payment.advanceOpenAmount > 0.005 && (
        <p className="text-xs text-muted-foreground max-w-[min(70ch,calc(100vw-5rem))]" data-testid={`advance-open-hint-${payment.id}`}>
          {t("The invoiced part is applied by selecting the advance tax invoice on the customer's final invoice (the prepayment adjustment). To refund it instead, first cancel the advance with a credit note (below); the refund is unlocked once the note is issued.",
             "يُطبَّق الجزء الذي صدرت فاتورته باختيار الفاتورة الضريبية للدفعة المقدمة على الفاتورة النهائية للعميل (تسوية الدفعة المقدمة). ولردّه بدلًا من ذلك، ألغِ الدفعة المقدمة أولًا بإشعار دائن (أدناه)؛ يُتاح الردّ بعد إصدار الإشعار.")}
        </p>
      )}
      {payment.advanceInvoices.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-muted-foreground text-xs uppercase">
                <th className="text-start pb-2 pe-3 font-medium">{t("Document", "المستند")}</th>
                <th className="text-start pb-2 pe-3 font-medium hidden sm:table-cell">{t("Date", "التاريخ")}</th>
                <th className="text-start pb-2 pe-3 font-medium">{t("Total", "الإجمالي")}</th>
                <th className="text-start pb-2 pe-3 font-medium hidden sm:table-cell">{t("VAT", "الضريبة")}</th>
                {/* Phone: the four figures above already carry applied/credited; the row keeps document, total, status and the act. */}
                <th className="text-start pb-2 pe-3 font-medium hidden sm:table-cell">{t("Applied", "المطبَّق")}</th>
                <th className="text-start pb-2 pe-3 font-medium hidden sm:table-cell">{t("Credited", "المُلغى")}</th>
                <th className="text-start pb-2 pe-3 font-medium">{t("Status", "الحالة")}</th>
                <th className="pb-2" />
              </tr>
            </thead>
            <tbody>
              {payment.advanceInvoices.map((a) => (
                <Fragment key={a.id}>
                <tr className="border-b border-border/50" data-testid={`advance-invoice-${a.id}`} data-status={a.status} data-open={a.openAmount}>
                  <td className="py-2 pe-3 font-mono text-xs"><Link href="/invoices" className="text-primary hover:underline">{a.invoiceNumber}</Link>{a.vatCategory ? <span className="text-muted-foreground"> · {a.vatCategory}</span> : null}</td>
                  <td className="py-2 pe-3 text-muted-foreground hidden sm:table-cell"><DualDate date={a.date} inline /></td>
                  <td className="py-2 pe-3 font-mono">{fmtNum(a.total)}</td>
                  <td className="py-2 pe-3 font-mono text-muted-foreground hidden sm:table-cell">{fmtNum(a.vatAmount)}</td>
                  <td className="py-2 pe-3 font-mono hidden sm:table-cell">{fmtNum(a.adjustedAmount)}</td>
                  <td className="py-2 pe-3 font-mono hidden sm:table-cell" data-testid={`advance-credited-${a.id}`}>{fmtNum(a.creditedAmount)}</td>
                  <td className="py-2 pe-3">
                    <Badge variant={a.status === "draft" || a.status === "submitted" ? "outline" : "default"} className={`text-xs ${a.status === "draft" || a.status === "submitted" ? "" : a.openAmount > 0.005 ? "bg-positive-surface/20 text-positive" : "bg-secondary text-muted-foreground"}`}>
                      {a.status === "draft" || a.status === "submitted" ? statusLabel(a.status) : a.openAmount > 0.005 ? t("Issued · open", "صادرة · متبقٍ") : a.creditedAmount > 0.005 && a.adjustedAmount < 0.005 ? t("Cancelled", "مُلغاة") : t("Applied", "مطبَّقة")}
                    </Badge>
                  </td>
                  <td className="py-2 text-end whitespace-nowrap">
                    {(a.status === "draft" || a.status === "submitted") ? (
                      <Button variant="outline" size="sm" className="h-7 text-xs" disabled={!canPost || approve.isPending} onClick={() => approve.mutate(a.id)} data-testid={`approve-advance-${a.id}`}>
                        {t("Approve & issue", "اعتماد وإصدار")}
                      </Button>
                    ) : (
                      <span className="inline-flex items-center gap-2">
                        {/* AP-3: cancel the open part with a credit note — the only door to refunding an invoiced advance. */}
                        {a.openAmount > 0.005 && (
                          <Button variant="ghost" size="sm" className="h-7 text-xs text-attention" disabled={!canPost} onClick={() => setCrediting(a)} data-testid={`credit-advance-${a.id}`}>
                            {t("Credit note", "إشعار دائن")}
                          </Button>
                        )}
                        <a href={`/api/invoices/${a.id}/document?lang=${lang === "ar" ? "ar" : "en"}`} download className="text-xs text-primary hover:underline">PDF</a>
                      </span>
                    )}
                  </td>
                </tr>
                {/* AP-3: the credit notes against this advance — the chain receipt → 386 → note → refund, readable on the card. */}
                {a.creditNotes.map((n) => (
                  <tr key={`cn-${n.id}`} className="border-b border-border/50 bg-secondary/10" data-testid={`advance-credit-note-${n.id}`} data-status={n.status}>
                    <td className="py-2 pe-3 ps-4 font-mono text-xs" colSpan={2}>
                      <span className="text-muted-foreground">↳ {t("Credit note", "إشعار دائن")}</span> <Link href="/invoices" className="text-primary hover:underline">{n.invoiceNumber}</Link>
                      {n.noteReason && <span className="text-muted-foreground font-sans"> · {n.noteReason}</span>}
                    </td>
                    <td className="py-2 pe-3 font-mono">−{fmtNum(n.total)}</td>
                    <td className="py-2 pe-3 font-mono text-muted-foreground hidden sm:table-cell">−{fmtNum(n.vatAmount)}</td>
                    <td className="py-2 pe-3 text-muted-foreground text-xs hidden sm:table-cell" colSpan={2}><DualDate date={n.date} inline /></td>
                    <td className="py-2 pe-3"><Badge variant={n.status === "draft" || n.status === "submitted" ? "outline" : "default"} className={`text-xs ${n.status === "draft" || n.status === "submitted" ? "" : "bg-attention-surface/20 text-attention"}`}>{statusLabel(n.status)}</Badge></td>
                    <td className="py-2 text-end whitespace-nowrap">
                      {(n.status === "draft" || n.status === "submitted") ? (
                        <Button variant="outline" size="sm" className="h-7 text-xs" disabled={!canPost || approveNote.isPending} onClick={() => approveNote.mutate(n.id)} data-testid={`approve-advance-credit-note-${n.id}`}>
                          {t("Approve & issue", "اعتماد وإصدار")}
                        </Button>
                      ) : (
                        <a href={`/api/invoices/${n.id}/document?lang=${lang === "ar" ? "ar" : "en"}`} download className="text-xs text-primary hover:underline">PDF</a>
                      )}
                    </td>
                  </tr>
                ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {issuing && <AdvanceInvoiceDialog open onClose={() => setIssuing(false)} payment={payment} customerName={customerName} />}
      {crediting && <AdvanceCreditNoteDialog open onClose={() => setCrediting(null)} advance={crediting} customerName={customerName} />}
    </div>
  );
}

/** One labelled fact on the payment card. Module-level so React keeps the node across renders. */
function Fact({ k, v, testId }: { k: string; v: React.ReactNode; testId?: string }) {
  return <div><p className="text-xs text-muted-foreground">{k}</p><p className="text-sm font-medium" data-testid={testId}>{v}</p></div>;
}

export function PaymentDetail({ payment, customerName, invoiceNumbers }: { payment: CustomerPayment; customerName: string; invoiceNumbers: Record<number, string> }) {
  const { t } = useLanguage();
  const canPost = useCanPostPayments();
  const [allocating, setAllocating] = useState(false);
  const [refunding, setRefunding] = useState(false);
  const [classifying, setClassifying] = useState(false);
  const { hint } = useClassificationLabels();
  const number = receiptNumber(payment.id);
  // AP-1: a deposit — money on account now, or classified before — can be classified; a migrated one carries the migration's VAT position instead.
  const classifiable = payment.direction === "in" && payment.customerId != null && payment.source !== "opening" && (payment.unappliedAmount > 0.005 || payment.classification != null);

  return (
    // On a phone the payments table scrolls sideways and this card sits in a
    // cell as wide as the table; pinned to the visible inline-start edge and
    // bounded to the viewport it stays readable without the sideways scroll
    // (AP-2 walk, 2026-09-21: the advance section sat off-screen after the
    // row's toggle scrolled the table).
    <div className="space-y-4 sticky start-0 max-w-[calc(100vw-2.5rem)] sm:static sm:max-w-none" data-testid={`payment-detail-${payment.id}`}>
      <div className="rounded-md border border-border p-3 space-y-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <p className="text-xs uppercase text-muted-foreground">{t("Payment", "الدفعة")}</p>
          <PaymentStateBadge p={payment} />
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Fact k={t("Receipt", "الإيصال")} v={<span className="font-mono">{number}</span>} />
          <Fact k={t("Customer", "العميل")} v={customerName} />
          <Fact k={t("Received on", "تاريخ الاستلام")} v={<DualDate date={payment.paidAt} inline />} />
          <Fact k={t("Bank", "البنك")} v={<BankName id={payment.bankAccountId} />} />
          <Fact k={t("Amount", "المبلغ")} v={<span className="font-mono">{fmtNum(payment.amount)}</span>} testId="payment-amount" />
          <Fact k={t("Allocated", "المخصص")} v={<span className="font-mono">{fmtNum(payment.allocatedAmount)}</span>} testId="payment-allocated" />
          <Fact k={t("Refunded", "المردود")} v={<span className="font-mono">{fmtNum(payment.refundedAmount)}</span>} testId="payment-refunded" />
          <Fact k={t("On account (available)", "على الحساب (المتاح)")} v={<span className="font-mono text-info">{fmtNum(payment.unappliedAmount)}</span>} testId="payment-unapplied" />
        </div>
        {(payment.reference || payment.method) && (
          <p className="text-xs text-muted-foreground">
            {payment.method && <span>{t("Method", "الطريقة")}: {payment.method} · </span>}
            {payment.reference && <span>{t("Reference", "المرجع")}: <span className="font-mono">{payment.reference}</span></span>}
          </p>
        )}
        {(classifiable || payment.source === "opening") && (
          <div className="flex items-start justify-between gap-2 flex-wrap border-t border-border/50 pt-2" data-testid={`deposit-classification-${payment.id}`}>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">{t("What this deposit is", "ما هذا العربون")}</p>
              <ClassificationBadge p={payment} />
              <p className="text-xs text-muted-foreground max-w-[min(65ch,calc(100vw-5rem))] break-words">
                {payment.source === "opening"
                  ? t("A migrated deposit: its VAT position (invoiced in the previous system, or unknown) is the migration's record.", "عربون مُرحَّل: وضعه الضريبي (صدرت فاتورته في النظام السابق، أو غير معروف) هو سجل الترحيل.")
                  : hint[(payment.classification?.classification ?? "unknown") as keyof typeof hint]}
                {payment.classification?.note && payment.source !== "opening" ? ` — ${payment.classification.note}` : ""}
              </p>
            </div>
            {classifiable && (
              <Button size="sm" variant="outline" className="h-8" disabled={!canPost} onClick={() => setClassifying(true)} data-testid={`classify-${payment.id}`}>
                {payment.classification ? t("Reclassify", "إعادة التصنيف") : t("Classify", "تصنيف")}
              </Button>
            )}
          </div>
        )}
      </div>

      <AdvanceInvoicesSection payment={payment} customerName={customerName} canPost={canPost} />

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <p className="text-xs uppercase text-muted-foreground">{t("Allocations — where this payment went", "التخصيصات — أين ذهبت هذه الدفعة")}</p>
          <div className="flex gap-2 flex-wrap">
            {/* AP-2: only the UN-invoiced part of a deposit can be allocated or refunded here; the invoiced part is applied on the final invoice. */}
            {payment.direction === "in" && payment.customerId != null && payment.uninvoicedAmount > 0.005 && (
              <>
                <Button size="sm" className="h-8" disabled={!canPost} onClick={() => setAllocating(true)} data-testid={`allocate-${payment.id}`}>
                  {t("Allocate", "تخصيص")}
                </Button>
                <Button size="sm" variant="outline" className="h-8" disabled={!canPost} onClick={() => setRefunding(true)} data-testid={`refund-deposit-${payment.id}`}>
                  {t("Refund deposit", "ردّ العربون")}
                </Button>
              </>
            )}
          </div>
        </div>
        <PermissionHint />
        <AllocationRows allocations={payment.allocations} invoiceNumbers={invoiceNumbers} customerName={customerName} sourceLabel={number} origin="deposit" canPost={canPost} />
      </div>

      {allocating && payment.customerId != null && (
        <AllocateDialog open onClose={() => setAllocating(false)} customerName={customerName}
          source={{ kind: "payment", id: payment.id, customerId: payment.customerId, available: payment.uninvoicedAmount, allocatedInvoiceIds: payment.allocations.filter((a) => !a.reversedBy).map((a) => a.invoiceId) }} />
      )}
      {refunding && payment.customerId != null && (
        <RefundDialog open onClose={() => setRefunding(false)} customer={{ id: payment.customerId, name: customerName }}
          source={{ origin: "deposit", paymentId: payment.id, label: number, available: payment.uninvoicedAmount }} />
      )}
      {classifying && <ClassifyDialog open onClose={() => setClassifying(false)} payment={payment} customerName={customerName} />}
    </div>
  );
}
