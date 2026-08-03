/**
 * Saudi statutory identifier formats — ONE definition, used everywhere.
 *
 * These rules were previously inlined in `signup.service.ts` and would have been
 * re-inlined by the M11.6 company settings. Duplicated constants are exactly how
 * the ZATCA sandbox-VAT production blocker happened (`DEFAULT_SELLER_*` drifted
 * across two files), so the format rules live here and are imported.
 */

/**
 * ZATCA VAT registration number: 15 digits, beginning AND ending with 3.
 * (Digits 2-10 are the taxpayer number; the rest are structural.)
 */
export const VAT_NUMBER_RE = /^3\d{13}3$/;

/** Saudi Commercial Registration (CR) number: exactly 10 digits. */
export const CR_NUMBER_RE = /^\d{10}$/;

/** Saudi national short address postal code: exactly 5 digits. */
export const POSTAL_CODE_RE = /^\d{5}$/;

/** Saudi national short address building number: exactly 4 digits. */
export const BUILDING_NUMBER_RE = /^\d{4}$/;

export const VAT_NUMBER_HELP =
  "VAT registration number must be 15 digits, starting and ending with 3.";
export const CR_NUMBER_HELP = "Commercial Registration (CR) number must be 10 digits.";

export const isValidVatNumber = (v: string): boolean => VAT_NUMBER_RE.test(v);
export const isValidCrNumber = (v: string): boolean => CR_NUMBER_RE.test(v);
