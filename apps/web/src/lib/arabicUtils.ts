/**
 * arabicUtils.ts
 *
 * Shared helpers for Arabic script detection and bilingual field status
 * used across entity-form list views and display components.
 */

/** The sentinel value written by the DB migration for untranslated rows. */
export const AR_SENTINEL = "(not yet translated)";

/**
 * Returns true when `str` contains Arabic Unicode characters (≥10 % of
 * non-space chars are in U+0600–U+06FF).  The 10 % threshold catches fully-
 * Arabic names and bilingual names while tolerating isolated Arabic currency
 * markers (ريال / ر.س) on otherwise-English lines.
 */
export function hasArabicScript(str: string): boolean {
  const chars = str.replace(/\s/g, "");
  if (!chars.length) return false;
  const ar = (chars.match(/[\u0600-\u06FF]/g) ?? []).length;
  return ar / chars.length >= 0.1;
}

/**
 * Classify the status of an Arabic name field value:
 *  "needs-translation" — value is empty, null, or the sentinel placeholder
 *  "wrong-script"      — value is non-empty but contains no Arabic chars
 *                        (e.g. a Latin transliteration was pasted in by mistake)
 *  "ok"                — value has Arabic script ≥ 10 %
 */
export type ArStatus = "needs-translation" | "wrong-script" | "ok";

/**
 * A party's Arabic name. Its main name field may itself be Arabic, in which case nothing needs translating
 * (Phase 18 final round, walk finding 15; register §11.138).
 */
export function arabicNameStatus(name: string | null | undefined, nameAr: string | null | undefined): ArStatus {
  const status = arabicFieldStatus(nameAr);
  return status === "needs-translation" && name && hasArabicScript(name) ? "ok" : status;
}

/** A number of days in Arabic, with the noun form the number takes: يوم واحد · يومان · ٣–١٠ أيام · ١١ فأكثر يومًا. */
export function arabicDays(n: number): string {
  if (n === 1) return "يوم واحد";
  if (n === 2) return "يومان";
  if (n >= 3 && n <= 10) return `${n} أيام`;
  if (n === 0) return "0 يوم";
  return `${n} يومًا`;
}

export function arabicFieldStatus(value: string | null | undefined): ArStatus {
  if (!value || value.trim() === "" || value.trim() === AR_SENTINEL) return "needs-translation";
  if (!hasArabicScript(value)) return "wrong-script";
  return "ok";
}
