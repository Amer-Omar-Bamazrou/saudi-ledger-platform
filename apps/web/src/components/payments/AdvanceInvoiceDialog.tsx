/**
 * AP-2 (2026-09-21) — ISSUE AN ADVANCE TAX INVOICE (ZATCA type 386) for a
 * deposit the business has classified as an advance for a taxable supply.
 *
 * What the dialog collects: the VAT-inclusive amount (default: everything
 * of the deposit not yet covered by one), the accounting date (default: the
 * receipt date — the tax point — or today when that month is closed) and a
 * description. The server derives the line (the split at the deposit's
 * classified VAT category), refuses what is not an advance, and makes a
 * DRAFT: approval is a separate act on the document, as for any invoice
 * (the Approve control sits beside the draft on the receipt card).
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { useLanguage } from "@/contexts/LanguageContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { invalidatePaymentQueries, newIdempotencyKey, receiptNumber } from "./shared";

import type { CreateAdvanceInvoiceInput, CustomerPayment, Invoice } from "@workspace/api-client-react";

const json = (b: CreateAdvanceInvoiceInput) => JSON.stringify(b);

export function AdvanceInvoiceDialog({ payment, customerName, open, onClose }: { payment: CustomerPayment; customerName: string; open: boolean; onClose: () => void }) {
  const { t } = useLanguage();
  const { toast } = useToast();
  const qc = useQueryClient();
  const category = payment.classification?.vatCategory ?? null;
  const [amount, setAmount] = useState(String(payment.uninvoicedAmount));
  const [date, setDate] = useState("");
  const [description, setDescription] = useState("");
  const [exemptionCode, setExemptionCode] = useState("");
  const [exemptionText, setExemptionText] = useState("");
  const [key] = useState(() => newIdempotencyKey("advance-invoice"));
  const amountNum = Number(amount);
  const rate = category === "S" ? 15 : 0;
  const taxable = Math.round((amountNum / (1 + rate / 100)) * 100) / 100;
  const vat = Math.round((amountNum - taxable) * 100) / 100;

  const mut = useMutation({
    mutationFn: () =>
      apiFetch<Invoice>(`/payments/${payment.id}/advance-invoices`, {
        method: "POST",
        body: json({
          amount: amountNum,
          date: date || null,
          description: description.trim() || null,
          taxExemptionReasonCode: exemptionCode.trim() || null,
          taxExemptionReasonText: exemptionText.trim() || null,
          idempotencyKey: key,
        }),
      }),
    onSuccess: (inv) => {
      invalidatePaymentQueries(qc);
      toast({ title: t("Advance tax invoice drafted", "أُنشئت مسودة الفاتورة الضريبية للدفعة المقدمة"), description: `${inv.invoiceNumber} · ${fmtNum(inv.total)} — ${t("approve it to issue", "اعتمدها لإصدارها")}` });
      onClose();
    },
  });

  const valid = Number.isFinite(amountNum) && amountNum > 0 && amountNum <= payment.uninvoicedAmount + 0.005 && (category === "S" || exemptionCode.trim() || exemptionText.trim());

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-[calc(100vw-1rem)] sm:max-w-md" data-testid="advance-invoice-dialog">
        <DialogHeader>
          <DialogTitle>{t("Issue advance tax invoice", "إصدار فاتورة ضريبية عن دفعة مقدمة")}</DialogTitle>
          <DialogDescription>
            {t("A tax invoice (ZATCA type 386) for money received before the supply — its VAT is declared in the period of the receipt. It becomes a draft; approve it to issue it. The advance is applied on the customer's final invoice.",
               "فاتورة ضريبية (نوع 386 لدى هيئة الزكاة والضريبة) عن مبلغ مستلم قبل التوريد — تُقرَّر ضريبتها في فترة الاستلام. تُنشأ كمسودة؛ اعتمدها لإصدارها. تُطبَّق الدفعة المقدمة على الفاتورة النهائية للعميل.")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1 rounded-md border border-border p-3 text-sm">
          <div className="flex justify-between gap-4"><span className="text-muted-foreground">{t("Receipt", "الإيصال")}</span><span className="font-mono">{receiptNumber(payment.id)} · <span dir="ltr">{payment.paidAt}</span></span></div>
          <div className="flex justify-between gap-4"><span className="text-muted-foreground">{t("Customer", "العميل")}</span><span>{customerName}</span></div>
          <div className="flex justify-between gap-4"><span className="text-muted-foreground">{t("VAT category", "فئة الضريبة")}</span><span className="font-mono">{category ?? "—"}</span></div>
          <div className="flex justify-between gap-4"><span className="text-muted-foreground">{t("Not yet invoiced", "لم تُصدر فاتورته بعد")}</span><span className="font-mono" data-testid="advance-uninvoiced">{fmtNum(payment.uninvoicedAmount)}</span></div>
        </div>
        <div className="space-y-3">
          <div>
            <Label className="text-xs text-muted-foreground">{t("Amount (incl. VAT)", "المبلغ (شامل الضريبة)")}</Label>
            <Input type="number" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className="mt-1 h-9" data-testid="advance-amount" />
            {Number.isFinite(amountNum) && amountNum > 0 && (
              <p className="text-xs text-muted-foreground mt-1" data-testid="advance-split">
                {t("Taxable", "الخاضع للضريبة")} <span className="font-mono">{fmtNum(taxable)}</span> · {t("VAT", "الضريبة")} {rate}% <span className="font-mono">{fmtNum(vat)}</span>
              </p>
            )}
            {amountNum > payment.uninvoicedAmount + 0.005 && <p className="text-xs text-destructive mt-1">{t("More than the part of this deposit not yet invoiced.", "أكثر من الجزء الذي لم تُصدر فاتورته من هذا العربون.")}</p>}
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">{t("Date (default: the receipt date — the tax point)", "التاريخ (الافتراضي: تاريخ الاستلام — نقطة الاستحقاق الضريبي)")}</Label>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="mt-1 h-9" data-testid="advance-date" />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">{t("Description", "الوصف")}</Label>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} className="mt-1 h-9" placeholder={t("Advance payment received…", "دفعة مقدمة مستلمة…")} data-testid="advance-description" />
          </div>
          {category && category !== "S" && (
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label className="text-xs text-muted-foreground">{t("Exemption code", "رمز الإعفاء")}</Label>
                <Input value={exemptionCode} onChange={(e) => setExemptionCode(e.target.value)} className="mt-1 h-9" placeholder="VATEX-SA-…" />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">{t("Exemption reason", "سبب الإعفاء")}</Label>
                <Input value={exemptionText} onChange={(e) => setExemptionText(e.target.value)} className="mt-1 h-9" />
              </div>
            </div>
          )}
          {mut.error && <p className="text-sm text-destructive" data-testid="advance-error">{(mut.error as Error).message}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>{t("Cancel", "إلغاء")}</Button>
            <Button onClick={() => mut.mutate()} disabled={!valid || mut.isPending} data-testid="advance-submit">
              {mut.isPending ? t("Creating…", "جارٍ الإنشاء…") : t("Create draft", "إنشاء المسودة")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
