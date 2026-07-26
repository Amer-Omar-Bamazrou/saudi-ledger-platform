/**
 * receiptValidator.ts
 *
 * Field-level validation rules applied after OCR extraction, before anything
 * is saved or shown as confirmed.
 *
 * Rules (per spec):
 *   1. VAT number must be exactly 15 digits, starting AND ending with '3'
 *      (ZATCA convention).  A 15-digit integer must never flow into vatAmount.
 *   2. VAT amount must be < subtotal and must not be a 15-digit integer.
 *   3. subtotal + vatAmount must equal total within 0.02 SAR tolerance.
 *   4. VAT rate (vatAmount / subtotal) must be close to 0%, 5%, or 15%
 *      (Saudi standard/zero/exempt rates).  Other rates are flagged.
 */

export type FlagSeverity = "error" | "warning";
export type FlagField = "vat_number" | "vat_amount" | "totals" | "vat_rate";

export interface ValidationFlag {
  field: FlagField;
  severity: FlagSeverity;
  message: string;
}

export interface ReceiptForValidation {
  supplierVatNumber: string;
  subtotal: number;
  vatAmount: number;
  total: number;
}

/** Saudi standard VAT rates (in %).  Anything outside ±0.5 pp is flagged. */
const VALID_RATES = [0, 5, 15];

/** Tolerance in SAR for subtotal + vatAmount ≈ total */
const RECONCILE_TOLERANCE = 0.02;

export function validateReceipt(data: ReceiptForValidation): ValidationFlag[] {
  const flags: ValidationFlag[] = [];

  // ── Rule 1: VAT registration number format ────────────────────────────────
  if (data.supplierVatNumber) {
    // Must be exactly 15 digits, start AND end with '3'
    if (!/^3\d{13}3$/.test(data.supplierVatNumber)) {
      flags.push({
        field: "vat_number",
        severity: "error",
        message: `VAT number "${data.supplierVatNumber}" is not in ZATCA format (15 digits, first and last digit '3').`,
      });
    }
  }

  // ── Rule 2: VAT amount sanity ──────────────────────────────────────────────
  if (data.vatAmount > 0) {
    // Must never be a 15-digit number (would indicate a VAT reg number)
    if (Number.isInteger(data.vatAmount) && String(Math.round(data.vatAmount)).length >= 14) {
      flags.push({
        field: "vat_amount",
        severity: "error",
        message: "VAT amount looks like a registration number, not a monetary value.",
      });
    }
    // Must be strictly less than subtotal
    if (data.subtotal > 0 && data.vatAmount >= data.subtotal) {
      flags.push({
        field: "vat_amount",
        severity: "error",
        message: `VAT amount (${fmt(data.vatAmount)}) must be less than the subtotal (${fmt(data.subtotal)}).`,
      });
    }
  }

  // ── Rule 3: Totals reconciliation ─────────────────────────────────────────
  if (data.total > 0 && data.subtotal > 0) {
    const computed = Math.round((data.subtotal + data.vatAmount) * 100) / 100;
    const diff = Math.abs(computed - data.total);
    if (diff > RECONCILE_TOLERANCE) {
      flags.push({
        field: "totals",
        severity: "error",
        message:
          `Totals don't reconcile: ${fmt(data.subtotal)} + ${fmt(data.vatAmount)} = ${fmt(computed)} ` +
          `but total is ${fmt(data.total)} (difference: ${fmt(diff)} SAR). ` +
          `Please correct the fields before posting.`,
      });
    }
  }

  // ── Rule 4: Unusual VAT rate ──────────────────────────────────────────────
  if (data.subtotal > 0 && data.vatAmount > 0) {
    const rate = (data.vatAmount / data.subtotal) * 100;
    const isValidRate = VALID_RATES.some((r) => Math.abs(rate - r) <= 0.5);
    if (!isValidRate) {
      flags.push({
        field: "vat_rate",
        severity: "warning",
        message:
          `Implied VAT rate is ${rate.toFixed(1)}% — not a recognised Saudi rate (0%, 5%, or 15%). ` +
          `Verify the subtotal and VAT amount.`,
      });
    }
  }

  return flags;
}

/** Returns true if any error-severity flag exists */
export function hasErrors(flags: ValidationFlag[]): boolean {
  return flags.some((f) => f.severity === "error");
}

function fmt(n: number): string {
  return `SAR ${n.toLocaleString("en-SA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
