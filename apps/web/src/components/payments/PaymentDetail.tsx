/**
 * One PAYMENT, and the ALLOCATIONS under it — two different things on one
 * card, laid out so a reader cannot confuse them: the payment's own facts
 * (date, bank, amount, reference) up top; then "where it went": each
 * allocation to an invoice, its correction if any, and what is still held
 * on account. Every figure comes from the API (allocated / refunded /
 * unapplied are server-computed); the card computes nothing.
 */
import { useState } from "react";
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
import { BankName, ClassificationBadge, PaymentStateBadge, PermissionHint, receiptNumber, useCanPostPayments, useClassificationLabels } from "./shared";

import type { CustomerPayment, PaymentAllocation } from "@workspace/api-client-react";

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
    <div className="space-y-4" data-testid={`payment-detail-${payment.id}`}>
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

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <p className="text-xs uppercase text-muted-foreground">{t("Allocations — where this payment went", "التخصيصات — أين ذهبت هذه الدفعة")}</p>
          <div className="flex gap-2">
            {payment.direction === "in" && payment.customerId != null && payment.unappliedAmount > 0.005 && (
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
          source={{ kind: "payment", id: payment.id, customerId: payment.customerId, available: payment.unappliedAmount, allocatedInvoiceIds: payment.allocations.filter((a) => !a.reversedBy).map((a) => a.invoiceId) }} />
      )}
      {refunding && payment.customerId != null && (
        <RefundDialog open onClose={() => setRefunding(false)} customer={{ id: payment.customerId, name: customerName }}
          source={{ origin: "deposit", paymentId: payment.id, label: number, available: payment.unappliedAmount }} />
      )}
      {classifying && <ClassifyDialog open onClose={() => setClassifying(false)} payment={payment} customerName={customerName} />}
    </div>
  );
}
