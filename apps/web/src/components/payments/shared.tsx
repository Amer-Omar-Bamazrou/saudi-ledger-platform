/**
 * Batch 1B Phase F (2026-09-17) — what every payment surface shares.
 *
 * Three identities, kept apart in the copy as well as in the data (decision
 * pack §4.1): a PAYMENT is the cash event (RCPT-n), an ALLOCATION is the link
 * from a payment or a credit note to one invoice for an amount, and a REFUND
 * settles a customer's credit. Nothing here computes a balance the server
 * did not send — the figures rendered are the API's own.
 */
import { useQuery, type QueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import { useLanguage } from "@/contexts/LanguageContext";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";

import type { CustomerPayment } from "@workspace/api-client-react";

/** Receipt / refund numbers as the matching engine reads them from a narrative. */
export const receiptNumber = (id: number) => `RCPT-${id}`;
export const refundNumber = (id: number) => `REFUND-${id}`;

/** The allocation target predicate and the outstanding figure live in `lib/openInvoice.ts` (pure; unit-tested; Issue 1). */
export { outstandingOf, isOpenInvoice } from "@/lib/openInvoice";

/**
 * Every query a payment write can move. Invalidated together so no page shows
 * a stale figure beside a fresh one.
 */
export function invalidatePaymentQueries(qc: QueryClient) {
  for (const key of ["payments", "refunds", "customer", "customer-invoices", "customer-credits", "customer-statement", "credit-note-applications", "invoices", "bank-accounts", "ar-aging", "matching", "customers", "open-advance-invoices"]) {
    qc.invalidateQueries({ queryKey: [key] });
  }
  // AP-1: the deposit review list and the return's summary move with every receipt, allocation, refund and classification (generated-client keys).
  for (const key of ["/api/payments/deposit-review", "/api/reports/vat-return"]) qc.invalidateQueries({ queryKey: [key] });
}

/**
 * The bank picker's options. `/bank-accounts` is not in the contract yet
 * (BankAccounts.tsx is on the ratchet's pinned list); the inline shape here
 * is the one Invoices.tsx already consumes for the same picker.
 */
export function useBankOptions() {
  const { data: banks = [] } = useQuery<Array<{ id: number; name: string; bankName: string; isDefault: boolean; isActive: boolean }>>({
    queryKey: ["bank-accounts"],
    queryFn: () => apiFetch("/bank-accounts"),
  });
  const active = banks.filter((b) => b.isActive);
  return { banks, active, byId: (id: number | null | undefined) => banks.find((b) => b.id === id) ?? null };
}

/** A bank's display name, or a plain "bank #n" when the list has not loaded. */
export function BankName({ id }: { id: number | null | undefined }) {
  const { t } = useLanguage();
  const { byId } = useBankOptions();
  if (id == null) return <span className="text-muted-foreground">{t("no bank", "بدون بنك")}</span>;
  const b = byId(id);
  return <span>{b ? `${b.name} — ${b.bankName}` : `#${id}`}</span>;
}

/**
 * D-3: a cash line names a bank. No default and no single-bank inference —
 * the picker starts EMPTY and the caller's submit stays disabled until a bank
 * is chosen. Same contract as the Record Payment dialog.
 */
export function BankPicker({ value, onChange, testId, label }: { value: string; onChange: (v: string) => void; testId: string; label: string }) {
  const { t } = useLanguage();
  const { active } = useBankOptions();
  return (
    <div>
      <p className="text-xs text-muted-foreground mb-1">{label}</p>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="h-9 text-sm" data-testid={testId}>
          <SelectValue placeholder={t("Choose the bank account", "اختر الحساب البنكي")} />
        </SelectTrigger>
        <SelectContent>
          {active.map((b) => (
            <SelectItem key={b.id} value={String(b.id)}>{b.name} — {b.bankName}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      {active.length === 0 && (
        <p className="text-xs text-destructive mt-1">{t("Add a bank account first — money moves through a named bank account.", "أضف حسابًا بنكيًا أولًا — تتحرك الأموال عبر حساب بنكي محدد.")}</p>
      )}
    </div>
  );
}

/**
 * Allocating, correcting, refunding and matching all carry approver
 * authority on the server (`payments` create/approve = admin, accountant).
 * FOR RENDERING ONLY: the control is shown and DISABLED with the reason, never
 * hidden — a refusal explained teaches the workflow (§3). The server judges.
 */
export function useCanPostPayments(): boolean {
  const { user } = useAuth();
  return user?.organizationRole === "admin" || user?.organizationRole === "accountant";
}

export function PermissionHint() {
  const { t } = useLanguage();
  const can = useCanPostPayments();
  if (can) return null;
  return (
    <p className="text-xs text-muted-foreground" data-testid="permission-hint">
      {t("Recording, allocating and refunding money needs the accountant or admin role — ask an approver.", "يتطلب تسجيل الأموال وتخصيصها وردّها دور المحاسب أو المدير — اطلب ذلك من معتمِد.")}
    </p>
  );
}

/** How much of a receipt is where: settled, refunded, still held on account. */
export function PaymentStateBadge({ p }: { p: CustomerPayment }) {
  const { t } = useLanguage();
  if (p.direction === "out") return <Badge variant="outline" className="text-xs">{t("Refund", "ردّ")}</Badge>;
  if (p.unappliedAmount > 0.005 && p.allocatedAmount > 0.005) return <Badge className="text-xs bg-attention-surface/20 text-attention">{t("Partly allocated", "مخصص جزئيًا")}</Badge>;
  if (p.unappliedAmount > 0.005) return <Badge className="text-xs bg-info-surface/20 text-info">{t("On account (deposit)", "على الحساب (عربون)")}</Badge>;
  if (p.refundedAmount > 0.005 && p.allocatedAmount <= 0.005) return <Badge variant="outline" className="text-xs">{t("Refunded", "مردود")}</Badge>;
  return <Badge className="text-xs bg-positive-surface/20 text-positive">{t("Fully allocated", "مخصص بالكامل")}</Badge>;
}

/** A fresh idempotency key per dialog open — a double-click resolves to ONE record. */
export const newIdempotencyKey = (prefix: string) =>
  `${prefix}-${typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;

// ── AP-1 (2026-09-20): what a deposit IS ─────────────────────────────────
// The server decides every state below; these are its labels. A deposit's
// classification is a dated statement (advance / erroneous / security
// deposit / unknown) that nothing posts from yet; the review state says
// whether a human still has something to decide or do for it.

export const DEPOSIT_CLASSIFICATIONS = ["advance", "erroneous", "security_deposit", "unknown"] as const;
export type DepositClassificationValue = (typeof DEPOSIT_CLASSIFICATIONS)[number];

export function useClassificationLabels() {
  const { t } = useLanguage();
  const label: Record<DepositClassificationValue, string> = {
    advance: t("Advance for a supply", "دفعة مقدمة لتوريد"),
    erroneous: t("Erroneous / duplicate payment", "دفعة خاطئة / مكررة"),
    security_deposit: t("Refundable security deposit", "تأمين قابل للاسترداد"),
    unknown: t("Not yet classified", "غير مصنف بعد"),
  };
  const hint: Record<DepositClassificationValue, string> = {
    advance: t("Money received before a taxable supply — a VAT tax point at receipt; an advance tax invoice (type 386) is due by the 15th of the next month, and is applied on the final invoice.", "مبلغ مستلم قبل توريد خاضع للضريبة — نقطة استحقاق ضريبية عند الاستلام؛ تستحق فاتورة ضريبية عن الدفعة المقدمة (نوع 386) بحلول اليوم الخامس عشر من الشهر التالي، وتُطبَّق على الفاتورة النهائية."),
    erroneous: t("Paid by mistake or twice — not consideration for a supply; refund it or allocate it.", "دُفع خطأً أو مرتين — ليس مقابلًا لتوريد؛ يُردّ أو يُخصَّص."),
    security_deposit: t("Held as security and refundable — not consideration for a supply (the accountant's confirmation is pending).", "محتفظ به كتأمين قابل للاسترداد — ليس مقابلًا لتوريد (بانتظار تأكيد المحاسب)."),
    unknown: t("Nobody has said what this money is yet. It stays on the VAT review list until classified.", "لم يُحدَّد بعد ما هذا المبلغ. يبقى في قائمة مراجعة الضريبة حتى يُصنَّف."),
  };
  const state: Record<string, string> = {
    unclassified: t("Needs classification", "يحتاج إلى تصنيف"),
    advance_not_invoiced: t("Advance — tax invoice not yet issued", "دفعة مقدمة — لم تصدر فاتورتها الضريبية بعد"),
    // AP-2: the deposit is covered by issued advance tax invoices; its VAT is declared, it waits for the final invoice.
    advance_invoiced: t("Advance — tax invoice issued, awaiting the final invoice", "دفعة مقدمة — صدرت فاتورتها الضريبية، بانتظار الفاتورة النهائية"),
    vat_silent: t("No VAT expected", "لا ضريبة متوقعة"),
    migrated_invoiced: t("Migrated — invoiced in the previous system", "مُرحَّل — صدرت فاتورته في النظام السابق"),
    migrated_unknown: t("Migrated — VAT position unknown", "مُرحَّل — الوضع الضريبي غير معروف"),
  };
  return { label, hint, state };
}

/** The current classification, or the migration's VAT position for an opening deposit. */
export function ClassificationBadge({ p }: { p: CustomerPayment }) {
  const { t } = useLanguage();
  const { label } = useClassificationLabels();
  if (p.direction !== "in" || p.customerId == null) return null;
  if (p.source === "opening") return <Badge variant="outline" className="text-xs" data-testid={`classification-${p.id}`} data-classification="opening">{t("Migrated deposit", "عربون مُرحَّل")}</Badge>;
  const c = p.classification?.classification ?? "unknown";
  const cls = c === "advance" ? "bg-attention-surface/20 text-attention" : c === "unknown" ? "bg-secondary text-muted-foreground" : "bg-info-surface/20 text-info";
  return (
    <Badge className={`text-xs ${cls}`} data-testid={`classification-${p.id}`} data-classification={c}>
      {label[c as DepositClassificationValue]}{c === "advance" && p.classification?.vatCategory ? ` · ${p.classification.vatCategory}` : ""}
    </Badge>
  );
}
