/**
 * A credit note as a CREDIT — the customer's entitlement it created, where it
 * has been applied, what was refunded, and what remains (a liability, never a
 * negative receivable). The note's own settlement of its original invoice is
 * the tax document's effect and is shown as immutable; later applications
 * can be corrected.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { useLanguage } from "@/contexts/LanguageContext";
import { Button } from "@/components/ui/button";
import { AllocateDialog } from "./AllocateDialog";
import { RefundDialog } from "./RefundDialog";
import { AllocationRows } from "./PaymentDetail";
import { PermissionHint, useCanPostPayments } from "./shared";

import type { CreditNoteApplications } from "@workspace/api-client-react";

export function useCreditNoteApplications(noteId: number, enabled = true) {
  return useQuery<CreditNoteApplications>({
    queryKey: ["credit-note-applications", noteId],
    queryFn: () => apiFetch(`/payments/credit-notes/${noteId}/applications`),
    enabled,
  });
}

function Fact({ k, v, testId }: { k: string; v: React.ReactNode; testId?: string }) {
  return <div><p className="text-xs text-muted-foreground">{k}</p><p className="text-sm font-medium font-mono" data-testid={testId}>{v}</p></div>;
}

export function CreditNoteDetail({ noteId, customer, invoiceNumbers, originalInvoiceId }: { noteId: number; customer: { id: number; name: string }; invoiceNumbers: Record<number, string>; originalInvoiceId: number | null }) {
  const { t } = useLanguage();
  const canPost = useCanPostPayments();
  const { data, isLoading, error } = useCreditNoteApplications(noteId);
  const [applying, setApplying] = useState(false);
  const [refunding, setRefunding] = useState(false);

  if (isLoading) return <p className="text-sm text-muted-foreground">{t("Loading…", "جارٍ التحميل…")}</p>;
  if (error || !data) return <p className="text-sm text-destructive">{t("Could not load this credit note's applications.", "تعذر تحميل تطبيقات إشعار الدائن هذا.")}</p>;

  // The application recorded at issue against the note's own original is the
  // tax document's effect (Art. 54) — the server refuses to unapply it.
  const originalApp = data.applications.find((a) => a.invoiceId === originalInvoiceId && !a.reversedBy && a.journalEntryId != null);

  return (
    <div className="space-y-3" data-testid={`credit-note-detail-${noteId}`}>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 rounded-md border border-border p-3">
        <Fact k={t("Credit note", "إشعار الدائن")} v={data.invoiceNumber} />
        <Fact k={t("Note total", "إجمالي الإشعار")} v={fmtNum(data.total)} />
        <Fact k={t("Applied", "المطبَّق")} v={fmtNum(data.appliedAmount)} testId="credit-applied" />
        <Fact k={t("Remaining credit", "الرصيد الدائن المتبقي")} v={<span className="text-info">{fmtNum(data.remainingAmount)}</span>} testId="credit-remaining" />
        {data.refundedAmount > 0.005 && <Fact k={t("Refunded", "المردود")} v={fmtNum(data.refundedAmount)} testId="credit-refunded" />}
      </div>
      {originalApp && (
        <p className="text-xs text-muted-foreground">
          {t(`${fmtNum(originalApp.amount)} settled its original invoice ${invoiceNumbers[originalApp.invoiceId] ?? `#${originalApp.invoiceId}`} at issue — that is the tax document's own effect and is corrected only by a further note.`,
             `سُوّي ${fmtNum(originalApp.amount)} من فاتورته الأصلية ${invoiceNumbers[originalApp.invoiceId] ?? `#${originalApp.invoiceId}`} عند الإصدار — وهذا أثر المستند الضريبي نفسه ولا يُصحَّح إلا بإشعار آخر.`)}
        </p>
      )}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-xs uppercase text-muted-foreground">{t("Applications — where this credit went", "التطبيقات — أين ذهب هذا الرصيد")}</p>
        {data.remainingAmount > 0.005 && (
          <div className="flex gap-2">
            <Button size="sm" className="h-8" disabled={!canPost} onClick={() => setApplying(true)} data-testid={`apply-credit-${noteId}`}>{t("Apply to invoice", "تطبيق على فاتورة")}</Button>
            <Button size="sm" variant="outline" className="h-8" disabled={!canPost} onClick={() => setRefunding(true)} data-testid={`refund-credit-${noteId}`}>{t("Refund credit", "ردّ الرصيد")}</Button>
          </div>
        )}
      </div>
      <PermissionHint />
      <AllocationRows allocations={data.applications} invoiceNumbers={invoiceNumbers} customerName={customer.name} sourceLabel={data.invoiceNumber} origin="credit_note" canPost={canPost} locked={new Set(originalApp ? [originalApp.id] : [])} />
      {applying && (
        <AllocateDialog open onClose={() => setApplying(false)} customerName={customer.name}
          source={{ kind: "credit_note", id: noteId, number: data.invoiceNumber, customerId: customer.id, available: data.remainingAmount, allocatedInvoiceIds: data.applications.filter((a) => !a.reversedBy).map((a) => a.invoiceId) }} />
      )}
      {refunding && (
        <RefundDialog open onClose={() => setRefunding(false)} customer={customer}
          source={{ origin: "credit_note", creditNoteId: noteId, label: data.invoiceNumber, available: data.remainingAmount }} />
      )}
    </div>
  );
}
