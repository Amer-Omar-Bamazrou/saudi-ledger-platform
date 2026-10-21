/**
 * 🔴 DR-45 (I) — the refusals of a WHT correction that would rewrite a
 * payment's recorded cash, as a TITLE in both languages keyed on the
 * structured CODE (CLAUDE.md §3: "explain a refusal … key the UI on the
 * structured CODE, so rewording copy cannot break it"). The server's own
 * sentence stays the description — it names the figures and the dates; the
 * title says what to do next.
 */
type T = (en: string, ar: string) => string;

const TITLES: Record<string, [string, string]> = {
  wht_correction_changes_cash: ["Not corrected — the payment's recorded cash would change", "لم يُصحَّح — كان سيتغيّر النقد المسجَّل للدفعة"],
  wht_correction_cash_mismatch: ["Not corrected — the corrected payment's cash is not the cash you stated", "لم يُصحَّح — نقد الدفعة المصححة ليس النقد الذي ذكرته"],
  wht_actual_cash_required: ["State the cash that actually left the bank", "اذكر النقد الذي خرج فعلًا من البنك"],
  wht_actual_cash_without_statement: ["Tick that the recorded cash was wrong, or clear the cash", "أشِر إلى أن النقد المسجَّل كان خاطئًا، أو امسح مبلغ النقد"],
};

/** The bilingual title for a DR-45 (I) refusal code, or null when the code is not one of these. */
export function whtCorrectionRefusalTitle(code: string | undefined | null, t: T): string | null {
  const pair = code ? TITLES[code] : undefined;
  return pair ? t(pair[0], pair[1]) : null;
}
