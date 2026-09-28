/**
 * Phase 13A — possible duplicates of the purchase document being entered.
 * 🔴 A WARNING, never a refusal (owner decision): two identical receipts on
 * the same day can be two real purchases. The earlier documents are shown so
 * the user decides; saving is never blocked by this panel.
 */
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { AlertTriangle } from "lucide-react";
import { fmtNum } from "@/lib/api";
import { listBillPossibleDuplicates, type ListBillPossibleDuplicatesParams } from "@workspace/api-client-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { duplicateReasonLabel } from "@/lib/vatEvidence";

export function DuplicateWarning({ billId, vendorId, vendorReference, date, total, captureId }: {
  billId?: number | null; vendorId?: number | null; vendorReference?: string | null; date?: string | null; total?: number | null; captureId?: string | null;
}) {
  const { t } = useLanguage();
  // The GENERATED client and types — the response shape is the contract's, not a claim made here.
  const params: ListBillPossibleDuplicatesParams = {
    ...(billId ? { bill_id: billId } : {}),
    ...(vendorId ? { vendor_id: vendorId } : {}),
    ...(vendorReference?.trim() ? { vendor_reference: vendorReference.trim() } : {}),
    ...(date ? { date } : {}),
    ...(total && total > 0 ? { total } : {}),
    ...(captureId ? { capture_id: captureId } : {}),
  };
  const enabled = !!(captureId || vendorId);
  const { data } = useQuery({
    queryKey: ["bill-duplicates", params],
    queryFn: () => listBillPossibleDuplicates(params),
    enabled,
  });
  const items = data?.items ?? [];
  if (items.length === 0) return null;
  return (
    <div className="rounded-lg border border-attention-surface/40 bg-attention-surface/10 px-4 py-3 space-y-2" data-testid="duplicate-warning">
      <p className="text-sm font-medium flex items-center gap-2">
        <AlertTriangle className="w-4 h-4 text-attention" />
        {t("This may be a document you have already recorded", "قد يكون هذا مستندًا سبق تسجيله")}
      </p>
      <p className="text-xs text-muted-foreground">
        {t("Check the earlier document before continuing. Nothing is blocked — two identical receipts can be two real purchases.",
           "راجع المستند السابق قبل المتابعة. لا شيء محظور — قد يكون إيصالان متطابقان مشتريين حقيقيين.")}
      </p>
      <ul className="space-y-1">
        {items.map((d, i) => (
          <li key={`${d.reason}-${d.billId ?? d.captureId}-${i}`} className="text-xs flex flex-wrap gap-x-2" data-reason={d.reason}>
            <span className="text-muted-foreground">{duplicateReasonLabel(d.reason, t)}:</span>
            {d.billId != null ? (
              <Link href={`/bills?edit=${d.billId}`} className="font-mono text-primary underline" dir="ltr">{d.billNumber}</Link>
            ) : (
              <span className="text-muted-foreground">{t("a capture not yet recorded as a bill", "صورة لم تُسجّل كفاتورة بعد")}</span>
            )}
            {d.vendorReference && <span className="font-mono" dir="ltr">{d.vendorReference}</span>}
            {d.date && <span dir="ltr">{d.date}</span>}
            {d.total != null && <span className="font-mono" dir="ltr">{fmtNum(d.total)}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
