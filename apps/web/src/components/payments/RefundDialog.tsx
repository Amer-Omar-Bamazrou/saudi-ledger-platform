/**
 * Refund a customer's credit — a deposit still held from a receipt, or the
 * unconsumed balance of an issued credit note. A refund SETTLES the credit
 * (Dr the origin's liability / Cr the bank); the receipt or the note stays
 * exactly as it was, visible beside the refund that consumed it. Two steps:
 * the form, then a confirmation naming customer, origin, amount, bank, reason
 * and the balance that will remain — the reader confirms a fact, not a form.
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { useLanguage } from "@/contexts/LanguageContext";
import { useToast } from "@/hooks/use-toast";
import { businessToday } from "@workspace/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { BankPicker, invalidatePaymentQueries, newIdempotencyKey, useBankOptions } from "./shared";

import type { RefundCustomerInput } from "@workspace/api-client-react";

const json = (b: RefundCustomerInput) => JSON.stringify(b);

export type RefundSource =
  | { origin: "deposit"; paymentId: number; label: string; available: number }
  | { origin: "credit_note"; creditNoteId: number; label: string; available: number };

function Row({ k, v, testId }: { k: string; v: React.ReactNode; testId?: string }) {
  return <div className="flex justify-between gap-4 text-sm"><span className="text-muted-foreground">{k}</span><span className="font-medium text-end" data-testid={testId}>{v}</span></div>;
}

export function RefundDialog({ customer, source, open, onClose }: { customer: { id: number; name: string }; source: RefundSource; open: boolean; onClose: () => void }) {
  const { t } = useLanguage();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { byId } = useBankOptions();
  const [amount, setAmount] = useState(source.available.toFixed(2));
  const [bank, setBank] = useState("");
  const [date, setDate] = useState(businessToday());
  const [reason, setReason] = useState("");
  const [reference, setReference] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [key] = useState(() => newIdempotencyKey("refund"));

  const n = Number(amount);
  const tooMuch = n > source.available + 0.005;
  const valid = n > 0 && !tooMuch && !!bank && reason.trim().length > 0;
  const after = Math.round((source.available - n) * 100) / 100;
  const bankRow = byId(Number(bank));

  const mut = useMutation({
    mutationFn: () =>
      apiFetch("/payments/refunds", {
        method: "POST",
        body: json({
          customerId: customer.id,
          origin: source.origin,
          paymentId: source.origin === "deposit" ? source.paymentId : null,
          creditNoteId: source.origin === "credit_note" ? source.creditNoteId : null,
          amount: n,
          bankAccountId: Number(bank),
          refundedAt: date,
          reason: reason.trim(),
          reference: reference.trim() || null,
          idempotencyKey: key,
        }),
      }),
    onSuccess: () => {
      invalidatePaymentQueries(qc);
      toast({ title: t("Refund recorded", "تم تسجيل الردّ"), description: t(`${fmtNum(n)} paid back to ${customer.name}.`, `أُعيد ${fmtNum(n)} إلى ${customer.name}.`) });
      onClose();
    },
    onError: () => setConfirming(false),
  });

  const originLabel = source.origin === "deposit"
    ? t(`Customer deposit from receipt ${source.label}`, `عربون العميل من الإيصال ${source.label}`)
    : t(`Credit-note balance of ${source.label}`, `رصيد إشعار الدائن ${source.label}`);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-[calc(100vw-1rem)] sm:max-w-md" data-testid="refund-dialog">
        <DialogHeader>
          <DialogTitle>{confirming ? t("Confirm refund", "تأكيد الردّ") : t("Refund customer credit", "ردّ رصيد العميل")}</DialogTitle>
          <DialogDescription>
            {t("A refund settles the credit and pays it out of a bank account. The original receipt or credit note is not changed.",
               "يسوّي الردّ الرصيد ويدفعه من حساب بنكي. لا يتغير الإيصال أو إشعار الدائن الأصلي.")}
          </DialogDescription>
        </DialogHeader>

        {!confirming ? (
          <div className="space-y-3">
            <div className="rounded-md border border-border p-3 space-y-1">
              <Row k={t("Customer", "العميل")} v={customer.name} />
              <Row k={t("Refund origin", "مصدر الردّ")} v={originLabel} />
              <Row k={t("Refundable balance", "الرصيد القابل للردّ")} v={<span className="font-mono">{fmtNum(source.available)}</span>} testId="refund-available" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <p className="text-xs text-muted-foreground mb-1">{t("Amount (SAR) *", "المبلغ (ر.س) *")}</p>
                <Input type="number" min={0} step="0.01" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className={`h-9 text-sm font-mono ${tooMuch ? "border-destructive" : ""}`} data-testid="refund-amount" />
                {tooMuch && <p className="text-xs text-destructive mt-1">{t("More than the refundable balance", "أكبر من الرصيد القابل للردّ")}</p>}
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">{t("Date", "التاريخ")}</p>
                <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="h-9 text-sm" />
              </div>
            </div>
            <BankPicker value={bank} onChange={setBank} testId="refund-bank-account" label={t("Paid from bank account *", "يُدفع من الحساب البنكي *")} />
            <div>
              <p className="text-xs text-muted-foreground mb-1">{t("Reason *", "السبب *")}</p>
              <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} data-testid="refund-reason" placeholder={t("Why the customer is being refunded", "سبب ردّ المبلغ للعميل")} />
            </div>
            <div>
              <p className="text-xs text-muted-foreground mb-1">{t("Bank reference", "المرجع البنكي")}</p>
              <Input value={reference} onChange={(e) => setReference(e.target.value)} className="h-9 text-sm font-mono" placeholder={t("Optional — the transfer reference", "اختياري — مرجع التحويل")} />
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="outline" onClick={onClose}>{t("Cancel", "إلغاء")}</Button>
              <Button onClick={() => setConfirming(true)} disabled={!valid} data-testid="refund-continue">{t("Continue", "متابعة")}</Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="rounded-md border border-border p-3 space-y-1" data-testid="refund-summary">
              <Row k={t("Customer", "العميل")} v={customer.name} />
              <Row k={t("Refund origin", "مصدر الردّ")} v={originLabel} />
              <Row k={t("Amount", "المبلغ")} v={<span className="font-mono">{fmtNum(n)}</span>} testId="refund-confirm-amount" />
              <Row k={t("Paid from", "يُدفع من")} v={bankRow ? `${bankRow.name} — ${bankRow.bankName}` : `#${bank}`} />
              <Row k={t("Date", "التاريخ")} v={date} />
              <Row k={t("Reason", "السبب")} v={reason.trim()} />
              <Row k={t("Balance remaining after", "الرصيد المتبقي بعده")} v={<span className="font-mono">{fmtNum(after)}</span>} testId="refund-after" />
            </div>
            <p className="text-xs text-foreground rounded-md border border-border bg-secondary/20 p-2" data-testid="refund-consequence">
              {t(`This will refund ${fmtNum(n)} of ${customer.name}'s ${source.origin === "deposit" ? "deposit" : "credit-note balance"} from ${bankRow ? bankRow.name : `bank #${bank}`}, leaving ${fmtNum(after)} on ${source.label}. It posts Dr ${source.origin === "deposit" ? "Customer deposits" : "Customer credit balances"} / Cr the bank account; no VAT is touched.`,
                 `سيُردّ ${fmtNum(n)} من ${source.origin === "deposit" ? "عربون" : "رصيد إشعار الدائن لـ"} ${customer.name} من ${bankRow ? bankRow.name : `البنك #${bank}`}، ويبقى ${fmtNum(after)} على ${source.label}. يُرحَّل: من ح/ ${source.origin === "deposit" ? "عرابين العملاء" : "أرصدة دائنة للعملاء"} إلى ح/ الحساب البنكي؛ لا تُمسّ ضريبة القيمة المضافة.`)}
            </p>
            <p className="text-xs text-muted-foreground">
              {t(`The ${source.origin === "deposit" ? "receipt" : "credit note"} ${source.label} stays on the customer's statement; this refund is recorded beside it.`,
                 `يبقى ${source.origin === "deposit" ? "الإيصال" : "إشعار الدائن"} ${source.label} في كشف حساب العميل؛ ويُسجَّل هذا الردّ بجانبه.`)}
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setConfirming(false)} disabled={mut.isPending}>{t("Back", "رجوع")}</Button>
              <Button onClick={() => mut.mutate()} disabled={mut.isPending} data-testid="refund-confirm">
                {mut.isPending ? t("Recording…", "جارٍ التسجيل…") : t("Confirm refund", "تأكيد الردّ")}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
