/**
 * 🔴 N-8 (carry-over Batch 1, the owner, 2026-11-07): ONE rule for a party's name, on every screen and document.
 *
 * Arabic: the Arabic name when it is set (not blank, not the translation sentinel), else the English name.
 * English: the English name when it is set, else the Arabic name.
 *
 * The web app's `n()` and the invoice document both call this, so a customer reads the same in the invoice form,
 * list, detail, confirmation, receipts and the PDF. Before, the screens and the document each had their own copy,
 * and the English PDF never fell back to the Arabic name.
 */
export const TRANSLATION_SENTINEL = "(not yet translated)";

export type NameLang = "ar" | "en";

export function displayName(en: string | null | undefined, ar: string | null | undefined, lang: NameLang): string {
  const english = en?.trim() ?? "";
  const arabic = ar?.trim() ?? "";
  const arabicSet = arabic !== "" && arabic !== TRANSLATION_SENTINEL;
  if (lang === "ar") return arabicSet ? arabic : english;
  return english !== "" ? english : arabicSet ? arabic : "";
}
