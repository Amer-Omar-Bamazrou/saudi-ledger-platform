/**
 * 🔴 L4 (owner, 2026-11-25) — VAT on an OUT-OF-SCOPE expense account (a statutory fee, GOSI, salaries…) is claimed only
 * on a STATED commercial supply, with its reason. The field appears when the SERVER's evidence verdict says the
 * account is out of scope and VAT is entered (keyed on the flag CODE, never on wording, and never decided here):
 * without a reason the save is refused (422 `out_of_scope_vat_unstated`); with one, the verdict warns and the claim
 * still needs a valid tax invoice. A reason already entered stays visible, so the user sees what is sent.
 */
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useLanguage } from "@/contexts/LanguageContext";
import type { VatEvidenceView } from "@/components/VatEvidencePanel";

const CODES = new Set(["out_of_scope_account_vat_unstated", "out_of_scope_account_commercial_supply"]);

/** Does the server's verdict ask for a stated commercial supply? */
export const asksCommercialSupply = (v: VatEvidenceView | null | undefined): boolean => !!v?.flags.some((f) => CODES.has(f.code));

export function CommercialSupplyField({ verdict, value, onChange }: {
  verdict: VatEvidenceView | null | undefined;
  value: string;
  onChange: (v: string) => void;
}) {
  const { t } = useLanguage();
  if (!asksCommercialSupply(verdict) && !value.trim()) return null;
  return (
    <div className="space-y-1" data-testid="commercial-supply">
      <Label htmlFor="commercial-supply-reason" className="text-xs text-muted-foreground">
        {t("Commercial supply — why VAT is charged on this account", "التوريد التجاري — سبب فرض الضريبة على هذا الحساب")}
      </Label>
      <Textarea id="commercial-supply-reason" value={value} maxLength={1000} rows={2}
        onChange={(e) => onChange(e.target.value)}
        className="text-sm" data-testid="commercial-supply-reason"
        placeholder={t("What was bought, and why it is a supply charged with VAT", "ما الذي اشتُري، ولماذا يُعدّ توريدًا خاضعًا للضريبة")} />
      <p className="text-[11px] text-muted-foreground">
        {t("This account is outside the scope of VAT. Leave the VAT at 0, or state the commercial supply here — the claim still needs the supplier's valid tax invoice.",
           "هذا الحساب خارج نطاق ضريبة القيمة المضافة. اترك الضريبة صفرًا، أو اذكر التوريد التجاري هنا — ويبقى الخصم مشروطًا بفاتورة ضريبية صحيحة من المورد.")}
      </p>
    </div>
  );
}
