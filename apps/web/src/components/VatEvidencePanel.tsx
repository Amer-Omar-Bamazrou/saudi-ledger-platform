/**
 * Phase 13A — the server's VAT-evidence verdict, shown where a purchase
 * document is entered or reviewed. The verdict is a real STATE of the
 * document (it IS held, or it IS evidenced), so it takes the status palette.
 *
 * Every reason is rendered from its structured code (lib/vatEvidence), in the
 * user's language. Blocking reasons are listed first and say what to do.
 */
import { AlertCircle, AlertTriangle, CheckCircle2, Info } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { basisLabel, flagText, statusLabel, type EvidenceFlag } from "@/lib/vatEvidence";

export interface VatEvidenceView {
  status: string;
  basis?: string | null;
  flags: EvidenceFlag[];
}

export function VatEvidencePanel({ verdict, context = "draft" }: { verdict: VatEvidenceView | null | undefined; context?: "preview" | "draft" }) {
  const { t } = useLanguage();
  if (!verdict) return null;
  const blocking = verdict.flags.filter((f) => f.severity === "blocking");
  const others = verdict.flags.filter((f) => f.severity !== "blocking");
  // Held = the evidence does not support the claim. Art. 50 / 0 %-recovery VAT is not held: it is cost (X5).
  const held = verdict.status === "awaiting_evidence" || blocking.length > 0;
  const tone = held
    ? "border-attention-surface/40 bg-attention-surface/10"
    : verdict.status === "evidenced"
      ? "border-positive-surface/30 bg-positive-surface/10"
      : "border-border bg-secondary/30";
  const basis = basisLabel(verdict.basis, t);
  return (
    <div className={`rounded-lg border px-4 py-3 space-y-2 ${tone}`} data-testid="vat-evidence-panel" data-status={verdict.status}>
      <p className="text-sm font-medium flex items-center gap-2">
        {held ? <AlertTriangle className="w-4 h-4 text-attention" /> : verdict.status === "evidenced" ? <CheckCircle2 className="w-4 h-4 text-positive" /> : <Info className="w-4 h-4 text-muted-foreground" />}
        <span data-testid="vat-evidence-status">{statusLabel(verdict.status, t)}</span>
        {basis && <span className="text-xs font-normal text-muted-foreground">· {basis}</span>}
      </p>
      {held && (
        <p className="text-xs text-muted-foreground">
          {context === "preview"
            ? t("You can save and post it. Its VAT will not be claimed: it is held in \"Input VAT awaiting evidence\" and listed under VAT evidence. When the evidence is supplied, the VAT is claimed in the period you hold it.",
                "يمكنك حفظه وترحيله، لكن ضريبته لن تُخصم: تُحفظ في حساب «ضريبة مدخلات بانتظار الإثبات» ويظهر في قائمة إثبات الضريبة. وعند استكمال الإثبات تُخصم الضريبة في الفترة التي تحوزه فيها.")
            : t("If posted, this document's VAT is held in \"Input VAT awaiting evidence\" — not claimed — until the evidence is supplied; it is then claimed in the period you hold it.",
                "عند الترحيل تُحفظ ضريبة هذا المستند في حساب «ضريبة مدخلات بانتظار الإثبات» دون خصمها حتى يُستكمل الإثبات، ثم تُخصم في الفترة التي تحوزه فيها.")}
        </p>
      )}
      {blocking.length > 0 && (
        <ul className="space-y-1" data-testid="vat-evidence-reasons">
          {blocking.map((f) => (
            <li key={f.code} className="flex items-start gap-2 text-xs" data-code={f.code}>
              <AlertCircle className="w-3.5 h-3.5 text-attention shrink-0 mt-0.5" />
              <span>{flagText(f, t)}</span>
            </li>
          ))}
        </ul>
      )}
      {others.length > 0 && (
        <ul className="space-y-1">
          {others.map((f) => (
            <li key={f.code} className="flex items-start gap-2 text-xs text-muted-foreground" data-code={f.code}>
              <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>{flagText(f, t)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
