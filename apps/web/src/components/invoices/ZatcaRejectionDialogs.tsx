/**
 * Phase 18 — THE PR C CORRECTION ROUTE (owner decision 2 of 2026-10-27), one
 * dialog per issued invoice:
 *
 *   - no rejection recorded: an approver records that ZATCA rejected the
 *     submission, with ZATCA's response attached. Nothing is posted, and
 *     nothing on the invoice or its entry changes;
 *   - rejection recorded: it is shown, and the NEW invoice that corrects it is
 *     created as a draft (same customer and date — the supply's tax point —
 *     and the rejected invoice's lines), to correct and approve like any
 *     invoice. The sale is then recorded once, on the correction.
 *
 * Every refusal comes back with its code and is shown as the server's own
 * sentence — the rule the user tripped is the explanation.
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { getGetInvoiceQueryKey, useGetInvoice, type Invoice, type InvoiceRejection, type InvoiceRejectionInput } from "@workspace/api-client-react";
import { apiFetch } from "@/lib/api";
import { useLanguage } from "@/contexts/LanguageContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

const refusal = (e: unknown) => {
  const err = e as { body?: { error?: string }; data?: { error?: string }; message?: string };
  return err?.body?.error ?? err?.data?.error ?? err?.message ?? String(e);
};

export function ZatcaRejectionDialog({ invoice, open, onClose }: { invoice: Invoice; open: boolean; onClose: () => void }) {
  const { t } = useLanguage();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [zatcaResponse, setZatcaResponse] = useState("");
  const [reason, setReason] = useState("");
  const [rejectedAt, setRejectedAt] = useState("");
  const { data: detail } = useGetInvoice(invoice.id, { query: { enabled: open, queryKey: getGetInvoiceQueryKey(invoice.id) } });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["invoices"] });
    qc.invalidateQueries({ queryKey: getGetInvoiceQueryKey(invoice.id) });
  };
  const record = useMutation({
    mutationFn: (body: InvoiceRejectionInput) =>
      apiFetch<InvoiceRejection>(`/invoices/${invoice.id}/rejection`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => { refresh(); toast({ title: t("Rejection recorded", "سُجّل الرفض"), description: t("Correct it with a new invoice.", "صحّحها بفاتورة جديدة.") }); },
    onError: (e) => toast({ title: t("Not recorded", "لم يُسجَّل"), description: refusal(e), variant: "destructive" }),
  });
  const correct = useMutation({
    mutationFn: () => apiFetch<Invoice>(`/invoices/${invoice.id}/correction`, { method: "POST" }),
    onSuccess: (doc) => {
      refresh();
      toast({ title: t("Correction drafted", "أُنشئت مسودة التصحيح"), description: `${doc.invoiceNumber} — ${t("correct it, then approve it to issue", "صحّحها ثم اعتمدها لإصدارها")}` });
      onClose();
    },
    onError: (e) => toast({ title: t("Not created", "لم تُنشأ"), description: refusal(e), variant: "destructive" }),
  });
  const rejection = detail?.rejection ?? null;
  const valid = zatcaResponse.trim() !== "" && reason.trim() !== "";

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("ZATCA rejection", "رفض الهيئة")} — {invoice.invoiceNumber}</DialogTitle>
          <DialogDescription>
            {t(
              "A rejected invoice stays as it is and nothing is posted. It is corrected by a new invoice with its own number, counter and hash, for the same customer and date — never a credit note. The sale is then recorded once, on the correction.",
              "تبقى الفاتورة المرفوضة كما هي ولا يُرحَّل شيء، وتُصحَّح بفاتورة جديدة لها رقمها وعدّادها وبصمتها للعميل والتاريخ نفسيهما، لا بإشعار دائن، فتُسجَّل عملية البيع مرة واحدة على التصحيح.",
            )}
          </DialogDescription>
        </DialogHeader>
        {!detail ? null : !rejection ? (
          <div className="space-y-3">
            <div>
              <Label>{t("ZATCA's response (paste it as received)", "رد الهيئة (الصقه كما ورد)")}</Label>
              <Textarea value={zatcaResponse} onChange={(e) => setZatcaResponse(e.target.value)} rows={5} dir="ltr" data-testid="rejection-response" />
            </div>
            <div>
              <Label>{t("Reason", "السبب")}</Label>
              <Input value={reason} onChange={(e) => setReason(e.target.value)} data-testid="rejection-reason" />
            </div>
            <div>
              <Label>{t("Rejected at (as ZATCA reported it, optional)", "تاريخ الرفض كما أفادت به الهيئة (اختياري)")}</Label>
              <Input type="datetime-local" value={rejectedAt} onChange={(e) => setRejectedAt(e.target.value)} />
            </div>
            <Button
              className="w-full"
              disabled={!valid || record.isPending}
              onClick={() => record.mutate({ zatcaResponse, reason, zatcaRejectedAt: rejectedAt ? new Date(rejectedAt).toISOString() : null })}
              data-testid="rejection-save"
            >
              {t("Record the rejection", "سجّل الرفض")}
            </Button>
          </div>
        ) : (
          <div className="space-y-3 text-sm">
            <div><span className="text-muted-foreground">{t("Reason", "السبب")}: </span>{rejection.reason}</div>
            <pre className="max-h-40 overflow-auto rounded bg-muted p-2 text-xs whitespace-pre-wrap" dir="ltr">{rejection.zatcaResponse}</pre>
            {detail.correctedByInvoiceId != null ? (
              <p>{t("A correcting invoice exists for this invoice.", "توجد فاتورة تصحيح لهذه الفاتورة.")}</p>
            ) : (
              <Button className="w-full" disabled={correct.isPending} onClick={() => correct.mutate()} data-testid="correction-create">
                {t("Create the correcting invoice", "أنشئ فاتورة التصحيح")}
              </Button>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
