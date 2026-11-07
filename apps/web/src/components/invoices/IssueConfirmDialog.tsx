import { getGetInvoiceQueryKey, useGetInvoice } from "@workspace/api-client-react";
import { fmtNum } from "@/lib/api";
import { useLanguage } from "@/contexts/LanguageContext";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/**
 * 🔴 Approving an invoice issues a legal document (Phase 18 final round, walk finding 6; register §11.140). The act is
 * final, so it is asked first: which invoice, for whom, for how much, and what cannot be undone. Confirm stays disabled
 * until the invoice has been read, so nobody confirms a blank.
 *
 * 🔴 It says what the document IS (owner, 2026-11-05: it "must name the document and the amount being issued"; register
 * §11.151), and only what is true of that document: a credit note is not told that a credit note corrects it.
 */
/** What the document is, in words, where it is not an ordinary invoice. */
const KIND: Partial<Record<string, { en: string; ar: string }>> = {
  advance_invoice: { en: "advance tax invoice", ar: "فاتورة ضريبية عن دفعة مقدمة" },
  advance_credit_note: { en: "credit note against an advance", ar: "إشعار دائن عن دفعة مقدمة" },
  credit_note: { en: "credit note", ar: "إشعار دائن" },
  debit_note: { en: "debit note", ar: "إشعار مدين" },
  recovery_invoice: { en: "recovery tax invoice", ar: "فاتورة ضريبية — استرداد" },
};
const NOTES = new Set(["advance_credit_note", "credit_note", "debit_note"]);

export function IssueConfirmDialog({ invoiceId, pending, onConfirm, onClose }: {
  invoiceId: number | null;
  pending: boolean;
  onConfirm: (invoiceId: number) => void;
  onClose: () => void;
}) {
  const { t, n } = useLanguage();
  const id = invoiceId ?? 0;
  const { data, isError } = useGetInvoice(id, { query: { enabled: invoiceId != null, queryKey: getGetInvoiceQueryKey(id) } });
  const invoice = invoiceId != null && data?.id === invoiceId ? data : null;
  const type = invoice?.documentType ?? "invoice";
  const kind = KIND[type];
  const isNote = NOTES.has(type);
  const originalId = isNote ? (invoice?.originalInvoiceId ?? 0) : 0;
  const { data: original } = useGetInvoice(originalId, { query: { enabled: originalId > 0, queryKey: getGetInvoiceQueryKey(originalId) } });
  return (
    <Dialog open={invoiceId != null} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md" data-testid="issue-confirm-dialog">
        <DialogHeader>
          <DialogTitle>{t(`Approve and issue ${kind ? `${kind.en} ` : ""}${invoice?.invoiceNumber ?? ""}?`, `اعتماد وإصدار ${kind ? `${kind.ar} ` : ""}${invoice?.invoiceNumber ?? ""}؟`)}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          {isError && <p className="text-negative">{t("The invoice could not be read. Close this and try again.", "تعذّرت قراءة الفاتورة. أغلق هذه النافذة وحاول مرة أخرى.")}</p>}
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt className="text-muted-foreground">{t("Customer", "العميل")}</dt>
            <dd className="font-medium">{invoice ? (n(invoice.customerName ?? "", invoice.customerNameAr) || "—") : "…"}</dd>
            {originalId > 0 && (
              <>
                <dt className="text-muted-foreground">{type === "advance_credit_note" ? t("Cancels", "يلغي") : t("Against", "عن الفاتورة")}</dt>
                <dd className="font-mono" data-testid="issue-confirm-original">{original?.invoiceNumber ?? "…"}</dd>
              </>
            )}
            <dt className="text-muted-foreground">{isNote ? t("Note amount", "قيمة الإشعار") : t("Total", "الإجمالي")}</dt>
            <dd className="font-mono font-semibold">{invoice ? fmtNum(invoice.total) : "…"}</dd>
          </dl>
          <p className="rounded-md border border-border p-2">
            {isNote
              ? t("Issuing is final. The note cannot be edited afterwards.", "الإصدار نهائي. لا يمكن تعديل الإشعار بعد ذلك.")
              : type === "recovery_invoice"
                ? t("Issuing is final. The invoice cannot be edited afterwards.", "الإصدار نهائي. لا يمكن تعديل الفاتورة بعد ذلك.")
                : t(
                    "Issuing is final. The invoice cannot be edited afterwards; corrections are made with a credit note.",
                    "الإصدار نهائي. لا يمكن تعديل الفاتورة بعد ذلك، ويكون التصحيح بإشعار دائن.",
                  )}
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" onClick={onClose} data-testid="issue-confirm-cancel">{t("Cancel", "إلغاء")}</Button>
            <Button disabled={!invoice || pending} onClick={() => { if (invoiceId != null) onConfirm(invoiceId); }} data-testid="issue-confirm-approve">
              {t("Approve and issue", "اعتماد وإصدار")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
