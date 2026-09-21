/**
 * AP-3 (2026-09-21) — CANCEL AN ADVANCE: a credit note against an issued
 * advance tax invoice (ZATCA 381 referencing the 386), for part or all of
 * its open balance, with the reason ZATCA requires (KSA-10).
 *
 * What it does in words, because the user is about to move VAT: the note
 * returns the advance's declared VAT to the deposit; the money stays on the
 * customer's account until it is refunded from the receipt (the ordinary
 * refund, unlocked by this note) or advance-invoiced again. It becomes a
 * DRAFT; approving it is the separate act on the document.
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { useLanguage } from "@/contexts/LanguageContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { invalidatePaymentQueries, newIdempotencyKey } from "./shared";

import type { CreateAdvanceCreditNoteInput, Invoice, ReceiptAdvanceInvoice } from "@workspace/api-client-react";

const json = (b: CreateAdvanceCreditNoteInput) => JSON.stringify(b);

export function AdvanceCreditNoteDialog({ advance, customerName, open, onClose }: { advance: ReceiptAdvanceInvoice; customerName: string; open: boolean; onClose: () => void }) {
  const { t } = useLanguage();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [amount, setAmount] = useState(String(advance.openAmount));
  const [reason, setReason] = useState("");
  const [date, setDate] = useState("");
  const [key] = useState(() => newIdempotencyKey("advance-credit-note"));
  const amountNum = Number(amount);
  const rate = advance.vatCategory === "S" ? 15 : 0;
  const taxable = Math.round((amountNum / (1 + rate / 100)) * 100) / 100;
  const vat = Math.round((amountNum - taxable) * 100) / 100;

  const mut = useMutation({
    mutationFn: () =>
      apiFetch<Invoice>(`/invoices/${advance.id}/advance-credit-notes`, {
        method: "POST",
        body: json({ amount: amountNum, reason: reason.trim(), date: date || null, idempotencyKey: key }),
      }),
    onSuccess: (inv) => {
      invalidatePaymentQueries(qc);
      toast({ title: t("Credit note drafted", "أُنشئت مسودة الإشعار الدائن"), description: `${inv.invoiceNumber} · ${fmtNum(inv.total)} — ${t("approve it to issue", "اعتمده لإصداره")}` });
      onClose();
    },
  });

  const valid = Number.isFinite(amountNum) && amountNum > 0 && amountNum <= advance.openAmount + 0.005 && reason.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-[calc(100vw-1rem)] sm:max-w-md" data-testid="advance-credit-note-dialog">
        <DialogHeader>
          <DialogTitle>{t("Cancel advance — credit note", "إلغاء الدفعة المقدمة — إشعار دائن")}</DialogTitle>
          <DialogDescription>
            {t("A credit note against the advance tax invoice returns the VAT declared on it to the deposit. The money stays on the customer's account until you refund it from the receipt — that refund is unlocked by this note. It becomes a draft; approve it to issue it.",
               "إشعار دائن مقابل الفاتورة الضريبية للدفعة المقدمة يعيد الضريبة المقرَّرة عليها إلى العربون. يبقى المبلغ على حساب العميل حتى تردّه من الإيصال — وهذا الإشعار هو ما يتيح ذلك الردّ. يُنشأ كمسودة؛ اعتمده لإصداره.")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1 rounded-md border border-border p-3 text-sm">
          <div className="flex justify-between gap-4"><span className="text-muted-foreground">{t("Advance tax invoice", "الفاتورة الضريبية للدفعة المقدمة")}</span><span className="font-mono">{advance.invoiceNumber} · <span dir="ltr">{advance.date}</span></span></div>
          <div className="flex justify-between gap-4"><span className="text-muted-foreground">{t("Customer", "العميل")}</span><span>{customerName}</span></div>
          <div className="flex justify-between gap-4"><span className="text-muted-foreground">{t("Issued (incl. VAT)", "الصادر (شامل الضريبة)")}</span><span className="font-mono">{fmtNum(advance.total)}</span></div>
          <div className="flex justify-between gap-4"><span className="text-muted-foreground">{t("Open — can be cancelled", "المتبقي — يمكن إلغاؤه")}</span><span className="font-mono" data-testid="advance-cn-open">{fmtNum(advance.openAmount)}</span></div>
        </div>
        <div className="space-y-3">
          <div>
            <Label className="text-xs text-muted-foreground">{t("Amount to cancel (incl. VAT)", "المبلغ المُلغى (شامل الضريبة)")}</Label>
            <Input type="number" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className="mt-1 h-9" data-testid="advance-cn-amount" />
            {Number.isFinite(amountNum) && amountNum > 0 && (
              <p className="text-xs text-muted-foreground mt-1" data-testid="advance-cn-split">
                {t("Taxable", "الخاضع للضريبة")} <span className="font-mono">{fmtNum(taxable)}</span> · {t("VAT returned to the deposit", "الضريبة المعادة إلى العربون")} <span className="font-mono">{fmtNum(vat)}</span>
              </p>
            )}
            {amountNum > advance.openAmount + 0.005 && <p className="text-xs text-destructive mt-1">{t("More than the open part of this advance tax invoice.", "أكثر من الجزء المتبقي من هذه الفاتورة.")}</p>}
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">{t("Reason (required by ZATCA)", "السبب (تطلبه هيئة الزكاة والضريبة)")}</Label>
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} className="mt-1" rows={2} placeholder={t("e.g. Order cancelled", "مثال: إلغاء الطلب")} data-testid="advance-cn-reason" />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">{t("Date (default: today)", "التاريخ (الافتراضي: اليوم)")}</Label>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="mt-1 h-9" data-testid="advance-cn-date" />
          </div>
          {mut.error && <p className="text-sm text-destructive" data-testid="advance-cn-error">{(mut.error as Error).message}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>{t("Cancel", "إلغاء")}</Button>
            <Button onClick={() => mut.mutate()} disabled={!valid || mut.isPending} data-testid="advance-cn-submit">
              {mut.isPending ? t("Creating…", "جارٍ الإنشاء…") : t("Create credit note draft", "إنشاء مسودة الإشعار الدائن")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
