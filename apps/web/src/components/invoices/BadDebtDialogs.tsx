/**
 * BAD DEBTS (2026-09-22) — the two acts on a receivable that went bad:
 *
 *   WriteOffBadDebtDialog   the Art. 40(7) write-off with VAT relief: ONE act
 *                           (the relief presupposes the write-off), dated the
 *                           day the conditions were met, with the certified
 *                           accountant's certificate and — above SAR 100,000
 *                           unpaid — the legal-procedures evidence.
 *   BadDebtRecoveryDialog   the Art. 40(9) document: a NEW tax invoice for
 *                           consideration received after the relief, from
 *                           the receipt that carried the money. A DRAFT; it is
 *                           approved like any invoice. Dated at the receipt
 *                           (the tax point); its IssueDate is the issuance.
 *
 * Every refusal comes back with its code and is shown as the server's own
 * sentence — the rule the user tripped is the explanation.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { useLanguage } from "@/contexts/LanguageContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { businessToday } from "@workspace/shared";
import type { CreateBadDebtRecoveryInput, CustomerPayment, Invoice, WriteOffBadDebtInput } from "@workspace/api-client-react";

const LEGAL_THRESHOLD = 100_000;

export function WriteOffBadDebtDialog({ invoice, open, onClose }: { invoice: Invoice; open: boolean; onClose: () => void }) {
  const { t } = useLanguage();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [claimedOn, setClaimedOn] = useState(businessToday());
  const [certificateRef, setCertificateRef] = useState("");
  const [legalRef, setLegalRef] = useState("");
  const [note, setNote] = useState("");
  const unpaid = Math.round((invoice.total - invoice.paidAmount - invoice.creditedAmount - (invoice.writtenOffAmount ?? 0)) * 100) / 100;
  const vatShare = invoice.total > 0 ? invoice.vatAmount / invoice.total : 0;
  const reliefVat = Math.round(unpaid * vatShare * 100) / 100;
  const needsLegal = unpaid > LEGAL_THRESHOLD;

  const mut = useMutation({
    mutationFn: () => {
      const body: WriteOffBadDebtInput = { claimedOn, certificateRef: certificateRef.trim(), legalRef: legalRef.trim() || null, note: note.trim() || null };
      return apiFetch<Invoice>(`/invoices/${invoice.id}/bad-debt-relief`, { method: "POST", body: JSON.stringify(body) });
    },
    onSuccess: (inv) => {
      qc.invalidateQueries({ queryKey: ["invoices"] });
      toast({ title: t("Written off — VAT relief claimed", "شُطب الدين — وطُلب إعفاء الضريبة"), description: `${inv.invoiceNumber} · ${fmtNum(inv.writtenOffAmount)} · ${t("VAT", "الضريبة")} ${fmtNum(inv.badDebtRelief?.vatAmount ?? 0)}` });
      onClose();
    },
  });
  const valid = certificateRef.trim().length > 0 && (!needsLegal || legalRef.trim().length > 0) && unpaid > 0;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-[calc(100vw-1rem)] sm:max-w-md" data-testid="bad-debt-write-off-dialog">
        <DialogHeader>
          <DialogTitle>{t("Write off as a bad debt", "شطب كدين معدوم")}</DialogTitle>
          <DialogDescription>
            {t("The unpaid consideration is written off and the VAT on it is claimed back in the return (Art. 40(7)). Twelve months must have passed since the supply, and a certified accountant must have certified the write-off. The tax invoice stays issued; nothing is owed on it any more.",
               "يُشطب المبلغ غير المسدد وتُسترد الضريبة عليه في الإقرار (المادة 40(7)). يلزم مرور اثني عشر شهراً على التوريد وشهادة محاسب قانوني بالشطب. تبقى الفاتورة الضريبية صادرة ولا يُستحق عليها شيء بعد ذلك.")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1 rounded-md border border-border p-3 text-sm">
          <div className="flex justify-between gap-4"><span className="text-muted-foreground">{t("Invoice", "الفاتورة")}</span><span className="font-mono">{invoice.invoiceNumber} · <span dir="ltr">{invoice.date}</span></span></div>
          <div className="flex justify-between gap-4"><span className="text-muted-foreground">{t("Unpaid — written off", "غير المسدد — يُشطب")}</span><span className="font-mono" data-testid="bad-debt-unpaid">{fmtNum(unpaid)}</span></div>
          <div className="flex justify-between gap-4"><span className="text-muted-foreground">{t("VAT relieved (box 7)", "الضريبة المستردة (الخانة 7)")}</span><span className="font-mono" data-testid="bad-debt-relief-vat">{fmtNum(reliefVat)}</span></div>
        </div>
        <div className="space-y-3">
          <div>
            <Label className="text-xs text-muted-foreground">{t("Date the conditions were met (the return period)", "تاريخ استيفاء الشروط (فترة الإقرار)")}</Label>
            <Input type="date" value={claimedOn} onChange={(e) => setClaimedOn(e.target.value)} className="mt-1 h-9" data-testid="bad-debt-claimed-on" />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">{t("Certified accountant's write-off certificate (reference)", "مرجع شهادة المحاسب القانوني بالشطب")}</Label>
            <Input value={certificateRef} onChange={(e) => setCertificateRef(e.target.value)} className="mt-1 h-9" placeholder={t("e.g. CA-2026-12", "مثال: CA-2026-12")} data-testid="bad-debt-certificate" />
          </div>
          {needsLegal && (
            <div>
              <Label className="text-xs text-muted-foreground">{t("Legal procedures taken without success (required above SAR 100,000)", "الإجراءات القانونية دون جدوى (مطلوبة فوق 100,000 ريال)")}</Label>
              <Input value={legalRef} onChange={(e) => setLegalRef(e.target.value)} className="mt-1 h-9" placeholder={t("e.g. court order no. …", "مثال: أمر المحكمة رقم …")} data-testid="bad-debt-legal" />
            </div>
          )}
          <div>
            <Label className="text-xs text-muted-foreground">{t("Note", "ملاحظة")}</Label>
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} className="mt-1" rows={2} data-testid="bad-debt-note" />
          </div>
          {mut.error && <p className="text-sm text-destructive" data-testid="bad-debt-error">{(mut.error as Error).message}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>{t("Cancel", "إلغاء")}</Button>
            <Button onClick={() => mut.mutate()} disabled={!valid || mut.isPending} data-testid="bad-debt-submit">
              {mut.isPending ? t("Writing off…", "جارٍ الشطب…") : t("Write off and claim relief", "شطب وطلب الإعفاء")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function BadDebtRecoveryDialog({ invoice, open, onClose }: { invoice: Invoice; open: boolean; onClose: () => void }) {
  const { t } = useLanguage();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [paymentId, setPaymentId] = useState<string>("");
  const [amount, setAmount] = useState("");
  const [vatRate, setVatRate] = useState("");
  const migrated = invoice.badDebtRelief?.source === "migrated";
  const { data: payments = [] } = useQuery<CustomerPayment[]>({
    queryKey: ["payments", "customer", invoice.customerId],
    queryFn: () => apiFetch(`/payments?customer_id=${invoice.customerId}&limit=200`),
    enabled: open && invoice.customerId != null,
  });
  // a receipt with money on account (recorded relief) — or one allocated to this item (migrated relief)
  const candidates = payments.filter((p) => p.direction === "in" && (migrated ? p.allocations.some((a) => a.invoiceId === invoice.id && a.reversedBy == null) : p.unappliedAmount > 0.005));
  const chosen = candidates.find((p) => String(p.id) === paymentId);
  const amountNum = Number(amount);
  const remaining = migrated ? (chosen?.allocations.filter((a) => a.invoiceId === invoice.id && a.reversedBy == null).reduce((s, a) => s + a.amount, 0) ?? 0) : Math.min(chosen?.unappliedAmount ?? 0, invoice.writtenOffAmount ?? 0);

  const mut = useMutation({
    mutationFn: () => {
      const body: CreateBadDebtRecoveryInput = { paymentId: Number(paymentId), amount: amountNum, vatRate: vatRate ? Number(vatRate) : null };
      return apiFetch<Invoice>(`/invoices/${invoice.id}/bad-debt-recoveries`, { method: "POST", body: JSON.stringify(body) });
    },
    onSuccess: (doc) => {
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["payments"] });
      toast({ title: t("Recovery invoice drafted", "أُنشئت مسودة فاتورة الاسترداد"), description: `${doc.invoiceNumber} · ${fmtNum(doc.total)} — ${t("approve it to issue", "اعتمدها لإصدارها")}` });
      onClose();
    },
  });
  const valid = !!chosen && Number.isFinite(amountNum) && amountNum > 0 && amountNum <= remaining + 0.005;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-[calc(100vw-1rem)] sm:max-w-md" data-testid="bad-debt-recovery-dialog">
        <DialogHeader>
          <DialogTitle>{t("Declare a recovery — tax invoice (Art. 40(9))", "الإفصاح عن استرداد — فاتورة ضريبية (المادة 40(9))")}</DialogTitle>
          <DialogDescription>
            {t("Money received after the VAT was relieved must be declared on a NEW tax invoice, in the period the money arrived. Pick the receipt; the document is dated at the receipt and issued when approved. Its VAT becomes payable again.",
               "المبلغ المستلم بعد استرداد الضريبة يُفصح عنه بفاتورة ضريبية جديدة في فترة استلامه. اختر الإيصال؛ تُؤرَّخ الوثيقة بتاريخ الإيصال وتُصدر عند الاعتماد، وتصبح ضريبتها مستحقة من جديد.")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1 rounded-md border border-border p-3 text-sm">
          <div className="flex justify-between gap-4"><span className="text-muted-foreground">{t("Written-off invoice", "الفاتورة المشطوبة")}</span><span className="font-mono">{invoice.invoiceNumber}</span></div>
          <div className="flex justify-between gap-4"><span className="text-muted-foreground">{t("Relief claimed on", "تاريخ طلب الإعفاء")}</span><span className="font-mono" dir="ltr">{invoice.badDebtRelief?.claimedOn}</span></div>
          {!migrated && <div className="flex justify-between gap-4"><span className="text-muted-foreground">{t("Written off", "المشطوب")}</span><span className="font-mono">{fmtNum(invoice.writtenOffAmount ?? 0)}</span></div>}
        </div>
        <div className="space-y-3">
          <div>
            <Label className="text-xs text-muted-foreground">{migrated ? t("Receipt allocated to this item", "الإيصال المخصص لهذا البند") : t("Receipt with the money on account", "الإيصال الذي يحمل المبلغ على الحساب")}</Label>
            <Select value={paymentId} onValueChange={(v) => { setPaymentId(v); const p = candidates.find((c) => String(c.id) === v); if (p) setAmount(String(migrated ? p.allocations.filter((a) => a.invoiceId === invoice.id && a.reversedBy == null).reduce((s, a) => s + a.amount, 0) : Math.min(p.unappliedAmount, invoice.writtenOffAmount ?? p.unappliedAmount))); }}>
              <SelectTrigger className="mt-1 h-9" data-testid="bad-debt-recovery-payment"><SelectValue placeholder={t("Choose a receipt", "اختر إيصالاً")} /></SelectTrigger>
              <SelectContent>
                {candidates.map((p) => <SelectItem key={p.id} value={String(p.id)} data-testid={`bad-debt-recovery-payment-${p.id}`}>RCPT-{p.id} · <span dir="ltr">{p.paidAt}</span> · {fmtNum(migrated ? p.amount : p.unappliedAmount)}</SelectItem>)}
              </SelectContent>
            </Select>
            {candidates.length === 0 && <p className="text-xs text-muted-foreground mt-1">{migrated ? t("Allocate the receipt to this item first; the recovery invoice then declares the VAT on the amount allocated.", "خصّص الإيصال لهذا البند أولاً؛ ثم تُفصح فاتورة الاسترداد عن الضريبة على المبلغ المخصص.") : t("Record the receipt on account first (Payments).", "سجّل الإيصال على الحساب أولاً (المدفوعات).")}</p>}
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">{t("Amount received (incl. VAT)", "المبلغ المستلم (شامل الضريبة)")}</Label>
            <Input type="number" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className="mt-1 h-9" data-testid="bad-debt-recovery-amount" />
            {chosen && amountNum > remaining + 0.005 && <p className="text-xs text-destructive mt-1">{t("More than can be declared from this receipt.", "أكثر مما يمكن الإفصاح عنه من هذا الإيصال.")}</p>}
          </div>
          {migrated && (
            <div>
              <Label className="text-xs text-muted-foreground">{t("VAT rate the original invoice carried (only if the migration did not record it)", "نسبة الضريبة في الفاتورة الأصلية (فقط إن لم يسجلها الترحيل)")}</Label>
              <Input type="number" inputMode="decimal" value={vatRate} onChange={(e) => setVatRate(e.target.value)} className="mt-1 h-9" placeholder="15" data-testid="bad-debt-recovery-rate" />
            </div>
          )}
          {mut.error && <p className="text-sm text-destructive" data-testid="bad-debt-recovery-error">{(mut.error as Error).message}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>{t("Cancel", "إلغاء")}</Button>
            <Button onClick={() => mut.mutate()} disabled={!valid || mut.isPending} data-testid="bad-debt-recovery-submit">
              {mut.isPending ? t("Creating…", "جارٍ الإنشاء…") : t("Create recovery invoice draft", "إنشاء مسودة فاتورة الاسترداد")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
