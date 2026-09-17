/**
 * Correct an allocation. The allocation row is never edited: a superseding
 * record is added (Dr AR / Cr the origin's liability, dated today) and the
 * amount returns to the customer's deposit or credit-note balance — from where
 * it can be allocated again. A reason is required; it is the audit trail.
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { useLanguage } from "@/contexts/LanguageContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { invalidatePaymentQueries, newIdempotencyKey } from "./shared";

import type { UnallocateInput } from "@workspace/api-client-react";

const json = (b: UnallocateInput) => JSON.stringify(b);

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return <div className="flex justify-between gap-4 text-sm"><span className="text-muted-foreground">{k}</span><span className="font-medium text-end">{v}</span></div>;
}

export function UnallocateDialog({
  allocation, open, onClose, customerName, sourceLabel, invoiceNumber, origin,
}: {
  allocation: { id: number; amount: number };
  open: boolean;
  onClose: () => void;
  customerName: string;
  /** "RCPT-12" or "CN-0003" — where the amount goes back to. */
  sourceLabel: string;
  invoiceNumber: string;
  origin: "deposit" | "credit_note";
}) {
  const { t } = useLanguage();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [reason, setReason] = useState("");
  const [key] = useState(() => newIdempotencyKey("unalloc"));

  const mut = useMutation({
    mutationFn: () => apiFetch(`/payments/allocations/${allocation.id}/unallocate`, { method: "POST", body: json({ reason: reason.trim(), idempotencyKey: key }) }),
    onSuccess: () => {
      invalidatePaymentQueries(qc);
      toast({ title: t("Allocation corrected", "تم تصحيح التخصيص"), description: t(`${fmtNum(allocation.amount)} is back on ${sourceLabel}.`, `عاد ${fmtNum(allocation.amount)} إلى ${sourceLabel}.`) });
      onClose();
    },
  });

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-[calc(100vw-1rem)] sm:max-w-md" data-testid="unallocate-dialog">
        <DialogHeader>
          <DialogTitle>{t("Correct this allocation", "تصحيح هذا التخصيص")}</DialogTitle>
          <DialogDescription>
            {t("The original allocation stays on record. A correcting entry dated today moves the amount back to where it came from.",
               "يبقى التخصيص الأصلي في السجل. يُضاف قيد تصحيحي بتاريخ اليوم يعيد المبلغ إلى مصدره.")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1 rounded-md border border-border p-3">
          <Row k={t("Customer", "العميل")} v={customerName} />
          <Row k={t("Allocation", "التخصيص")} v={`#${allocation.id}`} />
          <Row k={t("Invoice", "الفاتورة")} v={<span className="font-mono">{invoiceNumber}</span>} />
          <Row k={t("Amount", "المبلغ")} v={<span className="font-mono">{fmtNum(allocation.amount)}</span>} />
          <Row k={t("Returns to", "يعود إلى")} v={`${sourceLabel} · ${origin === "deposit" ? t("customer deposit", "عربون العميل") : t("credit-note balance", "رصيد إشعار الدائن")}`} />
        </div>
        <div>
          <p className="text-xs text-muted-foreground mb-1">{t("Reason *", "السبب *")}</p>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} data-testid="unallocate-reason" placeholder={t("Why this allocation was wrong", "لماذا كان هذا التخصيص خاطئًا")} />
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>{t("Cancel", "إلغاء")}</Button>
          <Button variant="destructive" onClick={() => mut.mutate()} disabled={!reason.trim() || mut.isPending} data-testid="unallocate-submit">
            {mut.isPending ? t("Correcting…", "جارٍ التصحيح…") : t("Unallocate", "إلغاء التخصيص")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
