/**
 * 🔴 ONE money formatter, in the reader's language (Phase 18 final round, walk finding 12; register §11.138).
 *
 * SAR is hardcoded because the API REFUSES any other currency (writeGuards.assertSupportedCurrency + DB CHECK 0062).
 * English keeps "SAR 1,150.00". Arabic reads "1,150.00 ر.س": Latin digits like every other figure on the page, the unit
 * after the number as the invoice PDF prints it. The language comes from the document, as `fmtDate` reads it. A left-to-right
 * mark keeps a negative's minus beside its digits inside a right-to-left line.
 */
const english = new Intl.NumberFormat("en-SA", { style: "currency", currency: "SAR", minimumFractionDigits: 2 });
const digits = new Intl.NumberFormat("en-SA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const SAR_AR = "ر.س";

export function isArabicDocument(): boolean {
  return typeof document !== "undefined" && document.documentElement.lang === "ar";
}

export function formatSar(amount: number): string {
  if (!isArabicDocument()) return english.format(amount);
  return `${amount < 0 ? "\u200E-" : ""}${digits.format(Math.abs(amount))} ${SAR_AR}`;
}

/** The currency code as a label: "SAR", or its Arabic form in the Arabic UI. */
export function currencyLabel(code: string): string {
  return code === "SAR" && isArabicDocument() ? SAR_AR : code;
}
