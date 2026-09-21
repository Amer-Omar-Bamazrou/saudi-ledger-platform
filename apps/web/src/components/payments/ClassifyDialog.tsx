/**
 * AP-1 (2026-09-20) — say what a deposit IS. A dated record the server keeps
 * beside the receipt (a new row per change; the history stays readable);
 * nothing posts, no VAT is decided — the dialog says so in words. The four
 * values and their consequences are the server's (decision pack §5 step 4);
 * this form only collects the statement.
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch, fmtNum } from "@/lib/api";
import { useLanguage } from "@/contexts/LanguageContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DEPOSIT_CLASSIFICATIONS, invalidatePaymentQueries, newIdempotencyKey, receiptNumber, useClassificationLabels, type DepositClassificationValue } from "./shared";

import type { ClassifyPaymentInput, CustomerPayment } from "@workspace/api-client-react";

const json = (b: ClassifyPaymentInput) => JSON.stringify(b);

export function ClassifyDialog({ payment, customerName, open, onClose }: { payment: CustomerPayment; customerName: string; open: boolean; onClose: () => void }) {
  const { t } = useLanguage();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { label, hint } = useClassificationLabels();
  const current = payment.classification?.classification ?? "unknown";
  const [classification, setClassification] = useState<DepositClassificationValue>(current as DepositClassificationValue);
  const [vatCategory, setVatCategory] = useState<string>(payment.classification?.vatCategory ?? "");
  const [note, setNote] = useState("");
  const [key] = useState(() => newIdempotencyKey("classify"));

  const mut = useMutation({
    mutationFn: () =>
      apiFetch(`/payments/${payment.id}/classify`, {
        method: "POST",
        body: json({ classification, vatCategory: classification === "advance" && vatCategory ? (vatCategory as "S" | "Z" | "E") : null, note: note.trim() || null, idempotencyKey: key }),
      }),
    onSuccess: () => {
      invalidatePaymentQueries(qc);
      toast({ title: t("Deposit classified", "تم تصنيف العربون"), description: `${receiptNumber(payment.id)} · ${label[classification]}` });
      onClose();
    },
  });

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-[calc(100vw-1rem)] sm:max-w-md" data-testid="classify-dialog">
        <DialogHeader>
          <DialogTitle>{t("What is this deposit?", "ما هذا العربون؟")}</DialogTitle>
          <DialogDescription>
            {t("A dated statement kept beside the receipt. Nothing is posted and no VAT is decided by it — it is what the VAT review list keys on.",
               "بيان مؤرخ يُحفظ بجانب الإيصال. لا يُرحَّل منه شيء ولا يقرر ضريبة — وهو ما تستند إليه قائمة مراجعة الضريبة.")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1 rounded-md border border-border p-3 text-sm">
          <div className="flex justify-between gap-4"><span className="text-muted-foreground">{t("Receipt", "الإيصال")}</span><span className="font-mono">{receiptNumber(payment.id)}</span></div>
          <div className="flex justify-between gap-4"><span className="text-muted-foreground">{t("Customer", "العميل")}</span><span>{customerName}</span></div>
          <div className="flex justify-between gap-4"><span className="text-muted-foreground">{t("On account", "على الحساب")}</span><span className="font-mono">{fmtNum(payment.unappliedAmount)}</span></div>
          <div className="flex justify-between gap-4"><span className="text-muted-foreground">{t("Currently", "حاليًا")}</span><span>{label[current as DepositClassificationValue]}</span></div>
        </div>
        <div>
          <p className="text-xs text-muted-foreground mb-1">{t("Classification *", "التصنيف *")}</p>
          <Select value={classification} onValueChange={(v) => setClassification(v as DepositClassificationValue)}>
            <SelectTrigger className="h-9 text-sm" data-testid="classify-select"><SelectValue /></SelectTrigger>
            <SelectContent>
              {DEPOSIT_CLASSIFICATIONS.map((c) => <SelectItem key={c} value={c} data-testid={`classify-option-${c}`}>{label[c]}</SelectItem>)}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground mt-1" data-testid="classify-hint">{hint[classification]}</p>
        </div>
        {classification === "advance" && (
          <div>
            <p className="text-xs text-muted-foreground mb-1">{t("VAT category of the supply (if known)", "الفئة الضريبية للتوريد (إن عُرفت)")}</p>
            <Select value={vatCategory || "none"} onValueChange={(v) => setVatCategory(v === "none" ? "" : v)}>
              <SelectTrigger className="h-9 text-sm" data-testid="classify-vat-category"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">{t("Not known yet", "غير معروفة بعد")}</SelectItem>
                <SelectItem value="S">{t("S — standard rate 15%", "S — النسبة الأساسية 15%")}</SelectItem>
                <SelectItem value="Z">{t("Z — zero-rated", "Z — نسبة الصفر")}</SelectItem>
                <SelectItem value="E">{t("E — exempt", "E — معفى")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}
        <div>
          <p className="text-xs text-muted-foreground mb-1">{t("Note", "ملاحظة")}</p>
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} data-testid="classify-note" placeholder={t("What the money is for, the contract or order it belongs to…", "لماذا هذا المبلغ، والعقد أو الطلب الذي يخصه…")} />
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>{t("Cancel", "إلغاء")}</Button>
          <Button onClick={() => mut.mutate()} disabled={mut.isPending} data-testid="classify-submit">
            {mut.isPending ? t("Saving…", "جارٍ الحفظ…") : t("Save classification", "حفظ التصنيف")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
