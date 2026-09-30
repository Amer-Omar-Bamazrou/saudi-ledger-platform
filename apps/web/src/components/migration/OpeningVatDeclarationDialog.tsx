/**
 * PHASE 13B S1 (2026-09-30) — declare what the PREVIOUS system did with an
 * opening payable's input VAT, once, with its evidence.
 * Records: docs/product/phase-13b-level-policy-implementation-contract.md §1,
 * §15, §16 (D4, D7); accountant answers AQ-1 / AQ-2.
 *
 * An opening bill carries no VAT of its own (the history was the previous
 * system's), so until this is declared the payable's VAT position is UNKNOWN
 * and a supplier credit note against it is refused. The declaration is:
 *
 *   - ONE of four histories S1 acts on — deducted; never deducted (carried in
 *     cost); blocked under Art. 50; deducted and fully reversed under
 *     Art. 40(10) with nothing restored. Any other history (partly deducted,
 *     partly restored, apportioned, split by line) is S2's, and the server
 *     refuses it by name rather than approximating it.
 *   - evidenced: each history names the documents it needs, and without them
 *     nothing is declared (the item stays unknown);
 *   - PERMANENT: no edit, no delete, in the database too.
 *
 * Admin or accountant (a dedicated grant — the accountant does not gain
 * migration write). Every refusal is shown with a bilingual title keyed on
 * its code, and the server's own sentence beneath it.
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { useLanguage } from "@/contexts/LanguageContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { openingVatRefusalTitle, refusalOf } from "@/lib/openingVatRefusals";
import {
  useDeclareOpeningVat, getListOpeningVatDeclarationsQueryKey,
  type DeclareOpeningVatInput, type DeclareOpeningVatInputState, type DeclareOpeningVatInputReversedVatLocation,
  type OpeningVatEvidenceInputKind, type MigrationOpenItem,
} from "@workspace/api-client-react";

type Enabled = "DEDUCTED" | "NOT_DEDUCTED" | "BLOCKED_ART50" | "REVERSED_ART40_10";
type Kind = OpeningVatEvidenceInputKind;

/** The evidence each history needs (accountant AQ-1; the server and the database enforce the same list). */
const REQUIRED: Record<Enabled, Kind[]> = {
  DEDUCTED: ["ORIGINAL_TAX_INVOICE", "DEDUCTION_RETURN"],
  NOT_DEDUCTED: ["ORIGINAL_TAX_INVOICE"],
  BLOCKED_ART50: ["ORIGINAL_TAX_INVOICE", "CLASSIFICATION"],
  REVERSED_ART40_10: ["ORIGINAL_TAX_INVOICE", "DEDUCTION_RETURN", "REVERSAL_RETURN", "PAYMENT_RECORDS"],
};

export function OpeningVatDeclarationDialog({ item, open, onClose }: { item: MigrationOpenItem; open: boolean; onClose: () => void }) {
  const { t } = useLanguage();
  const { toast } = useToast();
  const qc = useQueryClient();
  const staged = item.historicalVat ?? null;
  const [state, setState] = useState<Enabled | "">("");
  const [historicalVat, setHistoricalVat] = useState(staged?.amount != null ? String(staged.amount) : "");
  const [vatRate, setVatRate] = useState(staged?.rate != null ? String(staged.rate) : "");
  const [deductedPeriod, setDeductedPeriod] = useState("");
  const [reversedPeriod, setReversedPeriod] = useState("");
  const [location, setLocation] = useState<"" | "cost" | "adjustment_account">("");
  const [reason, setReason] = useState("");
  const [carriedInCost, setCarriedInCost] = useState(false);
  const [ground, setGround] = useState("");
  const [recordReference, setRecordReference] = useState("");
  const [files, setFiles] = useState<Partial<Record<Kind, File>>>({});
  const [uploading, setUploading] = useState(false);
  const [refusal, setRefusal] = useState<{ title: string; words: string } | null>(null);

  const KIND_LABEL: Record<Kind, string> = {
    ORIGINAL_TAX_INVOICE: t("The supplier's original tax invoice", "فاتورة المورّد الضريبية الأصلية"),
    DEDUCTION_RETURN: t("The VAT return that deducted it", "الإقرار الضريبي الذي خُصمت فيه"),
    REVERSAL_RETURN: t("The VAT return that reversed it", "الإقرار الضريبي الذي عُكست فيه"),
    PAYMENT_RECORDS: t("The payment records (unpaid at the trigger)", "سجلات السداد (غير مسددة عند الاستحقاق)"),
    CLASSIFICATION: t("The Art. 50 classification record", "سجل التصنيف وفق المادة 50"),
  };
  const STATE_LABEL: Record<Enabled, string> = {
    DEDUCTED: t("Deducted in a VAT return", "خُصمت في إقرار ضريبي"),
    NOT_DEDUCTED: t("Never deducted — carried in cost", "لم تُخصم قط — حُمِّلت على التكلفة"),
    BLOCKED_ART50: t("Not deductible — blocked under Art. 50", "غير قابلة للخصم — محظورة وفق المادة 50"),
    REVERSED_ART40_10: t("Deducted, then fully reversed under Art. 40(10)", "خُصمت ثم عُكست كليًا وفق المادة 40(10)"),
  };

  const declare = useDeclareOpeningVat({
    mutation: {
      onSuccess: () => {
        void qc.invalidateQueries({ queryKey: getListOpeningVatDeclarationsQueryKey() });
        toast({ title: t("VAT history declared", "أُعلن تاريخ الضريبة"), description: item.documentNumber });
        onClose();
      },
      // handled here (the dialog shows it in place), so the global cache toast stays silent
      onError: (e: unknown) => setRefusal(asRefusal(e)),
    },
  });

  function asRefusal(e: unknown) {
    const { code, words } = refusalOf(e);
    return { title: openingVatRefusalTitle(code, t) ?? t("Nothing was declared", "لم يُعلن شيء"), words };
  }

  const needed = state ? REQUIRED[state] : [];

  async function submit() {
    if (!state) return;
    setRefusal(null);
    setUploading(true);
    try {
      // Each file is STAGED through the capture pipeline; the declaration then binds it to the opening bill as evidence.
      const evidence: DeclareOpeningVatInput["evidence"] = [];
      for (const kind of needed) {
        const file = files[kind];
        if (!file) continue; // the server names what is missing — the refusal is the explanation
        const fd = new FormData();
        fd.append("document", file, file.name);
        fd.append("source", "manual");
        const cap: { captureId: string } = await apiFetch("/capture", { method: "POST", body: fd });
        evidence.push({ kind, captureId: cap.captureId });
      }
      const body: DeclareOpeningVatInput = {
        itemId: item.id,
        state: state as DeclareOpeningVatInputState,
        historicalVat: historicalVat.trim() === "" ? null : Number(historicalVat),
        vatRate: vatRate.trim() === "" ? null : Number(vatRate),
        deductedPeriod: state === "DEDUCTED" || state === "REVERSED_ART40_10" ? deductedPeriod || null : null,
        reversedPeriod: state === "REVERSED_ART40_10" ? reversedPeriod || null : null,
        reversedVatLocation: state === "REVERSED_ART40_10" ? ((location || null) as DeclareOpeningVatInputReversedVatLocation) : null,
        notDeductedReason: state === "NOT_DEDUCTED" ? reason.trim() || null : null,
        carriedInCost: state === "NOT_DEDUCTED" ? carriedInCost : null,
        art50Ground: state === "BLOCKED_ART50" ? ground.trim() || null : null,
        recordReference: recordReference.trim() || null,
        evidence,
      };
      declare.mutate({ data: body });
    } catch (e) {
      setRefusal(asRefusal(e));
    } finally {
      setUploading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-[calc(100vw-1rem)] sm:max-w-lg max-h-[90vh] overflow-y-auto" data-testid="opening-vat-dialog">
        <DialogHeader>
          <DialogTitle>{t("Declare the VAT history", "إعلان تاريخ الضريبة")} <span className="font-mono text-sm" dir="ltr">{item.documentNumber}</span></DialogTitle>
          <DialogDescription>
            {t("What did the previous system do with this bill's input VAT? Declared once, with its evidence, and permanent — it decides what a supplier credit note against this bill does to your input VAT. Without it, such a note is refused.",
               "ماذا فعل النظام السابق بضريبة المدخلات على هذه الفاتورة؟ يُعلن مرة واحدة مع أدلته، وهو دائم — ويحدد أثر أي إشعار دائن من المورّد على ضريبة مدخلاتك. ومن دونه يُرفض هذا الإشعار.")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1">
            <Label>{t("What happened to the VAT", "ما الذي حدث للضريبة")}</Label>
            <Select value={state} onValueChange={(v) => { setState(v as Enabled); setRefusal(null); }}>
              <SelectTrigger data-testid="opening-vat-state"><SelectValue placeholder={t("Choose the history", "اختر التاريخ")} /></SelectTrigger>
              <SelectContent>
                {(Object.keys(STATE_LABEL) as Enabled[]).map((s) => <SelectItem key={s} value={s} data-testid={`opening-vat-state-${s}`}>{STATE_LABEL[s]}</SelectItem>)}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">{t("A partly deducted, partly restored, apportioned or line-split history is not supported yet.", "التاريخ المخصوم جزئيًا أو المسترد جزئيًا أو الموزّع أو المجزّأ حسب البنود غير مدعوم بعد.")}</p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>{t("Historical VAT", "الضريبة التاريخية")}</Label>
              <Input type="number" step="0.01" dir="ltr" value={historicalVat} onChange={(e) => setHistoricalVat(e.target.value)} readOnly={staged?.amount != null} data-testid="opening-vat-amount" />
            </div>
            <div className="space-y-1">
              <Label>{t("Rate %", "النسبة %")}</Label>
              <Input type="number" step="0.01" dir="ltr" value={vatRate} onChange={(e) => setVatRate(e.target.value)} readOnly={staged?.rate != null} data-testid="opening-vat-rate" />
            </div>
          </div>
          {(staged?.amount != null || staged?.rate != null) && <p className="text-[11px] text-muted-foreground -mt-2">{t("Staged by the migration — a declaration restates it, never contradicts it.", "مجهّزة من الترحيل — الإعلان يعيد ذكرها ولا يناقضها.")}</p>}

          {(state === "DEDUCTED" || state === "REVERSED_ART40_10") && (
            <div className="space-y-1">
              <Label>{t("Deducted in the return for (YYYY-MM)", "خُصمت في إقرار شهر (YYYY-MM)")}</Label>
              <Input dir="ltr" placeholder="2026-05" value={deductedPeriod} onChange={(e) => setDeductedPeriod(e.target.value)} data-testid="opening-vat-deducted-period" />
            </div>
          )}
          {state === "REVERSED_ART40_10" && (
            <>
              <div className="space-y-1">
                <Label>{t("Reversed in the return for (YYYY-MM)", "عُكست في إقرار شهر (YYYY-MM)")}</Label>
                <Input dir="ltr" placeholder="2026-03" value={reversedPeriod} onChange={(e) => setReversedPeriod(e.target.value)} data-testid="opening-vat-reversed-period" />
              </div>
              <div className="space-y-1">
                <Label>{t("Where did the previous system carry the reversed VAT?", "أين حمّل النظام السابق الضريبة المعكوسة؟")}</Label>
                <Select value={location} onValueChange={(v) => setLocation(v as "cost" | "adjustment_account")}>
                  <SelectTrigger data-testid="opening-vat-location"><SelectValue placeholder={t("Not assumed — choose", "لا يُفترض — اختر")} /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="cost">{t("In the cost of the purchase", "في تكلفة المشتريات")}</SelectItem>
                    <SelectItem value="adjustment_account">{t("In a VAT adjustment account", "في حساب تسوية ضريبية")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </>
          )}
          {state === "NOT_DEDUCTED" && (
            <>
              <div className="space-y-1">
                <Label>{t("Why it was never deducted", "سبب عدم خصمها")}</Label>
                <Textarea value={reason} onChange={(e) => setReason(e.target.value)} data-testid="opening-vat-reason" />
              </div>
              <label className="flex items-start gap-2 text-sm">
                <Checkbox checked={carriedInCost} onCheckedChange={(v) => setCarriedInCost(v === true)} data-testid="opening-vat-carried-in-cost" />
                <span>{t("The undeducted VAT was carried in the cost of the purchase (or the asset).", "حُمِّلت الضريبة غير المخصومة على تكلفة المشتريات (أو الأصل).")}</span>
              </label>
            </>
          )}
          {state === "BLOCKED_ART50" && (
            <div className="space-y-1">
              <Label>{t("The Art. 50 ground", "سند المادة 50")}</Label>
              <Input value={ground} onChange={(e) => setGround(e.target.value)} data-testid="opening-vat-ground" />
            </div>
          )}

          {needed.length > 0 && (
            <div className="space-y-2 rounded-md border border-border p-3" data-testid="opening-vat-evidence">
              <p className="text-sm font-medium">{t("Evidence this history needs", "الأدلة التي يتطلبها هذا التاريخ")}</p>
              {needed.map((kind) => (
                <div key={kind} className="space-y-1">
                  <Label className="text-xs">{KIND_LABEL[kind]}</Label>
                  <Input type="file" accept="application/pdf,image/*" onChange={(e) => { const f = e.target.files?.[0]; setFiles((m) => ({ ...m, [kind]: f })); }} data-testid={`opening-vat-file-${kind}`} />
                </div>
              ))}
            </div>
          )}

          <div className="space-y-1">
            <Label>{t("Reference in the previous system (optional)", "المرجع في النظام السابق (اختياري)")}</Label>
            <Input value={recordReference} onChange={(e) => setRecordReference(e.target.value)} data-testid="opening-vat-reference" />
          </div>

          {refusal && (
            <div role="alert" className="rounded-md border border-destructive/50 p-3 text-sm" data-testid="opening-vat-refusal">
              <p className="font-medium text-destructive">{refusal.title}</p>
              <p className="text-muted-foreground mt-1" dir="auto">{refusal.words}</p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("Cancel", "إلغاء")}</Button>
          <Button onClick={() => void submit()} disabled={!state || uploading || declare.isPending} data-testid="opening-vat-submit">
            {t("Declare — permanent", "إعلان — دائم")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
