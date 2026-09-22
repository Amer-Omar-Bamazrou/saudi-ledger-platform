/**
 * MIGRATION FOLLOW-UPS (2026-09-22) — the two acts on a COMMITTED migrated
 * open item, both keyed on the STAGING row (the migrated document's identity
 * survives every correction):
 *
 *   CorrectOpenItemDialog   the accountant's answer 5 inside Policy C / A4:
 *                           100,000 → 90,000. The original ledger row stays
 *                           (marked reversed by its own batch, frozen,
 *                           carrying the entry); a replacement OPEN-<batch>-
 *                           <seq> for the corrected amount links back to it;
 *                           ONE entry with OPENING RETAINED EARNINGS on the
 *                           other side — never an opening-balance-equity
 *                           plug, never an edit, never a delete.
 *   RecordIdentityDialog    the accountant's answer 3: a credit note against
 *                           a migrated tax invoice names it through Fatoora,
 *                           so the previous solution's e-invoicing identity
 *                           (cleared / reported with its UUID, or issued
 *                           before e-invoicing) is recorded ONCE — and never
 *                           invented.
 *
 * Every refusal comes back with its code and is shown as the server's own
 * sentence — the rule the user tripped is the explanation.
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { businessToday } from "@workspace/shared";
import { invalidateMigration } from "./shared";
import type { CorrectMigratedOpenItemInput, MigratedOpenItemCorrection, MigratedOpenItemIdentity, MigrationOpenItem, RecordMigratedOpenItemIdentityInput } from "@workspace/api-client-react";

export function CorrectOpenItemDialog({ batchId, item, open, onClose }: { batchId: number; item: MigrationOpenItem; open: boolean; onClose: () => void }) {
  const { t } = useLanguage();
  const { toast } = useToast();
  const qc = useQueryClient();
  const current = item.liveOutstanding ?? item.outstandingAmount;
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [date, setDate] = useState(businessToday());
  const isAr = item.itemType === "ar";
  const correct = Number(amount);
  const delta = Number.isFinite(correct) ? Math.round((correct - current) * 100) / 100 : 0;
  const valid = amount.trim() !== "" && Number.isFinite(correct) && correct > 0 && Math.abs(delta) >= 0.005 && reason.trim().length > 0 && /^\d{4}-\d{2}-\d{2}$/.test(date);
  // the entry's shape, shown BEFORE the act: a receivable decrease is Dr Retained earnings / Cr AR; payables mirror
  const controlDebit = isAr ? delta > 0 : delta < 0;

  const mut = useMutation({
    mutationFn: () => {
      const body: CorrectMigratedOpenItemInput = { correctOutstanding: correct, reason: reason.trim(), date };
      return apiFetch<MigratedOpenItemCorrection>(`/migration/open-items/${item.id}/correct`, { method: "POST", body: JSON.stringify(body) });
    },
    onSuccess: (out) => {
      invalidateMigration(qc, batchId);
      qc.invalidateQueries();
      toast({ title: t("Migrated item corrected", "تم تصحيح البند المرحَّل"), description: `${out.original.number} → ${out.replacement.number} · ${fmtNum(out.original.total)} → ${fmtNum(out.replacement.total)} · ${out.entryNumber}` });
      onClose();
    },
  });

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-[calc(100vw-1rem)] sm:max-w-md" data-testid="correct-open-item-dialog">
        <DialogHeader>
          <DialogTitle>{t("Correct the migrated amount", "تصحيح المبلغ المرحَّل")}</DialogTitle>
          <DialogDescription>
            {t("The original stays in the books, marked reversed by its migration and frozen; a replacement with a new OPEN number carries the corrected amount; one entry dated today moves the difference against opening retained earnings. Nothing is edited or deleted, and no opening-balance-equity account is used.",
               "يبقى الأصل في الدفاتر موسومًا بأنه معكوس بترحيله ومجمَّدًا؛ ويحمل بديلٌ برقم OPEN جديد المبلغ المصحَّح؛ وقيدٌ واحد بتاريخ اليوم ينقل الفرق مقابل الأرباح المبقاة الافتتاحية. لا يُعدَّل شيء ولا يُحذف، ولا يُستخدم حساب حقوق ملكية للأرصدة الافتتاحية.")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1 rounded-md border border-border p-3 text-sm">
          <div className="flex justify-between gap-4"><span className="text-muted-foreground">{t("Source document", "المستند المصدري")}</span><span className="font-mono" dir="ltr">{item.documentNumber}</span></div>
          <div className="flex justify-between gap-4"><span className="text-muted-foreground">{t("Live ledger row", "الصف الحي في الدفتر")}</span><span className="font-mono" dir="ltr">{item.liveDocumentNumber ?? "—"}</span></div>
          <div className="flex justify-between gap-4"><span className="text-muted-foreground">{t("Stands at", "الرصيد الحالي")}</span><span className="font-mono" data-testid="correct-current">{fmtNum(current)}</span></div>
          {item.corrections > 0 && <div className="flex justify-between gap-4"><span className="text-muted-foreground">{t("Corrections so far", "التصحيحات حتى الآن")}</span><span className="font-mono">{item.corrections}</span></div>}
        </div>
        <div className="space-y-3">
          <div>
            <Label className="text-xs text-muted-foreground">{t("Correct outstanding amount (SAR)", "المبلغ المتبقي الصحيح (ر.س)")}</Label>
            <Input type="number" inputMode="decimal" min="0.01" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className="mt-1 h-9 font-mono" dir="ltr" data-testid="correct-amount" />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">{t("Date (an open month, on or after the opening date)", "التاريخ (شهر مفتوح، في تاريخ الافتتاح أو بعده)")}</Label>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="mt-1 h-9" data-testid="correct-date" />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">{t("Reason (the audit trail's explanation)", "السبب (تفسير سجل التدقيق)")}</Label>
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} className="mt-1" data-testid="correct-reason" />
          </div>
          {valid && (
            <div className="rounded-md bg-muted/50 p-2 text-xs" data-testid="correct-preview">
              <span className="font-mono">{fmtNum(current)} → {fmtNum(correct)}</span>
              <span className="block text-muted-foreground mt-1">
                {controlDebit
                  ? t(`Dr ${isAr ? "Accounts receivable" : "Accounts payable"} ${fmtNum(Math.abs(delta))} / Cr Retained earnings ${fmtNum(Math.abs(delta))}`, `من ح/ ${isAr ? "الذمم المدينة" : "الذمم الدائنة"} ${fmtNum(Math.abs(delta))} / إلى ح/ الأرباح المبقاة ${fmtNum(Math.abs(delta))}`)
                  : t(`Dr Retained earnings ${fmtNum(Math.abs(delta))} / Cr ${isAr ? "Accounts receivable" : "Accounts payable"} ${fmtNum(Math.abs(delta))}`, `من ح/ الأرباح المبقاة ${fmtNum(Math.abs(delta))} / إلى ح/ ${isAr ? "الذمم المدينة" : "الذمم الدائنة"} ${fmtNum(Math.abs(delta))}`)}
              </span>
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>{t("Cancel", "إلغاء")}</Button>
          <Button onClick={() => mut.mutate()} disabled={!valid || mut.isPending} data-testid="correct-submit">{mut.isPending ? t("Posting…", "جارٍ الترحيل…") : t("Correct and post", "تصحيح وترحيل")}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function RecordIdentityDialog({ batchId, item, open, onClose }: { batchId: number; item: MigrationOpenItem; open: boolean; onClose: () => void }) {
  const { t } = useLanguage();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [status, setStatus] = useState<"" | "cleared" | "reported" | "pre_einvoicing">("");
  const [uuid, setUuid] = useState("");
  const needsUuid = status === "cleared" || status === "reported";
  const valid = status !== "" && (!needsUuid || uuid.trim().length > 0) && uuid.trim().length <= 64;

  const mut = useMutation({
    mutationFn: () => {
      const body: RecordMigratedOpenItemIdentityInput = { einvoicingStatus: status as Exclude<typeof status, "">, sourceUuid: needsUuid ? uuid.trim() : null };
      return apiFetch<MigratedOpenItemIdentity>(`/migration/open-items/${item.id}/identity`, { method: "PUT", body: JSON.stringify(body) });
    },
    onSuccess: (out) => {
      invalidateMigration(qc, batchId);
      qc.invalidateQueries({ queryKey: ["invoices"] });
      toast({ title: t("Identity recorded", "تم تسجيل الهوية"), description: `${out.invoiceNumber} · ${out.einvoicingStatus}${out.sourceUuid ? ` · ${out.sourceUuid}` : ""}` });
      onClose();
    },
  });

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-[calc(100vw-1rem)] sm:max-w-md" data-testid="record-identity-dialog">
        <DialogHeader>
          <DialogTitle>{t("Record the previous solution's e-invoicing identity", "تسجيل هوية الفوترة الإلكترونية من الحل السابق")}</DialogTitle>
          <DialogDescription>
            {t("A credit note against this document must name it through Fatoora. Record what the previous solution did with it — cleared (standard), reported (simplified), with its UUID — or that it was issued before e-invoicing applied. Recorded once; never changed; never guessed.",
               "أي إشعار دائن على هذا المستند يجب أن يسميه عبر فاتورة. سجِّل ما فعله الحل السابق به — تم اعتماده (قياسي) أو الإبلاغ عنه (مبسَّط) مع معرّفه UUID — أو أنه صدر قبل تطبيق الفوترة الإلكترونية. يُسجَّل مرة واحدة؛ ولا يُغيَّر؛ ولا يُخمَّن.")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1 rounded-md border border-border p-3 text-sm">
          <div className="flex justify-between gap-4"><span className="text-muted-foreground">{t("Source document", "المستند المصدري")}</span><span className="font-mono" dir="ltr">{item.documentNumber}</span></div>
          <div className="flex justify-between gap-4"><span className="text-muted-foreground">{t("Issued", "الإصدار")}</span><span className="font-mono" dir="ltr">{item.issueDate}</span></div>
        </div>
        <div className="space-y-3">
          <div>
            <Label className="text-xs text-muted-foreground">{t("E-invoicing status in the previous solution", "حالة الفوترة الإلكترونية في الحل السابق")}</Label>
            <Select value={status} onValueChange={(v) => setStatus(v as typeof status)}>
              <SelectTrigger className="mt-1 h-9" data-testid="identity-status"><SelectValue placeholder={t("Choose…", "اختر…")} /></SelectTrigger>
              <SelectContent>
                <SelectItem value="cleared">{t("Cleared (standard tax invoice)", "تم اعتمادها (فاتورة ضريبية قياسية)")}</SelectItem>
                <SelectItem value="reported">{t("Reported (simplified tax invoice)", "تم الإبلاغ عنها (فاتورة ضريبية مبسَّطة)")}</SelectItem>
                <SelectItem value="pre_einvoicing">{t("Issued before e-invoicing applied", "صدرت قبل تطبيق الفوترة الإلكترونية")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {needsUuid && (
            <div>
              <Label className="text-xs text-muted-foreground">{t("The previous solution's document UUID (verbatim)", "معرّف المستند UUID في الحل السابق (حرفيًا)")}</Label>
              <Input value={uuid} onChange={(e) => setUuid(e.target.value)} className="mt-1 h-9 font-mono" dir="ltr" maxLength={64} data-testid="identity-uuid" />
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>{t("Cancel", "إلغاء")}</Button>
          <Button onClick={() => mut.mutate()} disabled={!valid || mut.isPending} data-testid="identity-submit">{mut.isPending ? t("Recording…", "جارٍ التسجيل…") : t("Record once", "تسجيل مرة واحدة")}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
