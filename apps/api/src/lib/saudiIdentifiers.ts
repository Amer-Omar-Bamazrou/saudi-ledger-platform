/**
 * Saudi statutory identifier formats — ONE definition, used everywhere.
 *
 * These rules were previously inlined in `signup.service.ts` and would have been
 * re-inlined by the M11.6 company settings. Duplicated constants are exactly how
 * the ZATCA sandbox-VAT production blocker happened (`DEFAULT_SELLER_*` drifted
 * across two files), so the format rules live here and are imported.
 */
import { BusinessRuleError } from "./errors";

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

/**
 * 🔴 Item 3 (owner, 2026-11-25) — a PARTY is Saudi when its country is SA or unset (the record's default, and how the
 * ZATCA XML states an unset country). The one reading, shared with the buyer-address rule (einvoice/buyerAddress.ts).
 */
export const isSaudiParty = (country: string | null | undefined): boolean => {
  const c = (country ?? "").trim().toUpperCase();
  return c === "" || c === "SA";
};

/**
 * 🔴 Item 3 — a customer's or supplier's create or edit, at its write boundary. Only a number this request SETS or
 * CHANGES is judged (with the country as the record will stand): an existing record is never refused or rewritten for
 * a number it already holds — an edit that re-sends it unchanged passes. 400 `party_identifier_invalid`.
 */
export function assertPartyIdentifiers(
  values: { taxNumber?: string | null; crNumber?: string | null; country?: string | null },
  before: { taxNumber: string | null; crNumber: string | null; country: string | null } | null,
): void {
  const judged = (k: "taxNumber" | "crNumber") => (values[k] != null && values[k] !== (before?.[k] ?? null) ? values[k] : null);
  const failures = partyIdentifierFailures({
    taxNumber: judged("taxNumber"),
    crNumber: judged("crNumber"),
    country: values.country !== undefined ? values.country : (before?.country ?? null),
  });
  if (failures.length === 0) return;
  const [first] = failures;
  throw new BusinessRuleError(400, {
    code: "party_identifier_invalid",
    field: first!.field,
    identifier: first!.identifier,
    reason: first!.reason,
    error: failures.map((f) => f.error).join(" "),
    errorAr: failures.map((f) => f.errorAr).join(" "),
    failures: failures.map(({ field, identifier, reason }) => ({ field, identifier, reason })),
  });
}

/** Why a number fails the rule above — an explanation of the SAME regular expression, never a rule of its own. */
export type IdentifierReason = "not_digits" | "wrong_length" | "must_start_and_end_with_3";

export interface PartyIdentifierFailure {
  field: "taxNumber" | "crNumber";
  identifier: "vat_number" | "cr_number";
  reason: IdentifierReason;
  error: string;
  errorAr: string;
}

/** "N digits" in Arabic: 1 رقم واحد · 2 رقمان · 3–10 أرقام · 11 and up رقمًا. */
function digitsAr(n: number): string {
  if (n === 1) return "رقم واحد";
  if (n === 2) return "رقمين";
  return n >= 3 && n <= 10 ? `${n} أرقام` : `${n} رقمًا`;
}

function vatReason(v: string): IdentifierReason | null {
  if (VAT_NUMBER_RE.test(v)) return null;
  if (!/^\d+$/.test(v)) return "not_digits";
  if (v.length !== 15) return "wrong_length";
  return "must_start_and_end_with_3";
}
function crReason(v: string): IdentifierReason | null {
  if (CR_NUMBER_RE.test(v)) return null;
  return /^\d+$/.test(v) ? "wrong_length" : "not_digits";
}

/**
 * 🔴 Item 3 — THE ONE CHECK of a customer's or supplier's VAT and CR numbers (create, edit, migration import), with
 * the company record's own rules (VAT_NUMBER_RE, CR_NUMBER_RE) and no other: only for a Saudi party; a blank number is
 * no failure (both fields are optional). Each failure names the number type and the reason, in English and Arabic.
 */
export function partyIdentifierFailures(p: { taxNumber?: string | null; crNumber?: string | null; country?: string | null }): PartyIdentifierFailure[] {
  if (!isSaudiParty(p.country)) return [];
  const out: PartyIdentifierFailure[] = [];
  const vat = p.taxNumber ?? "";
  const vr = vat === "" ? null : vatReason(vat);
  if (vr) {
    const why = vr === "not_digits" ? ["it contains characters other than digits", "يحتوي على رموز غير الأرقام"]
      : vr === "wrong_length" ? [`it has ${vat.length} digits`, `يتكون من ${digitsAr(vat.length)}`]
      : ["it does not start and end with 3", "لا يبدأ وينتهي بالرقم 3"];
    out.push({
      field: "taxNumber", identifier: "vat_number", reason: vr,
      error: `The VAT registration number "${vat}" is not valid: ${why[0]}. A Saudi VAT registration number is 15 digits, starting and ending with 3.`,
      errorAr: `الرقم الضريبي (رقم التسجيل في ضريبة القيمة المضافة) «${vat}» غير صحيح: ${why[1]}. الرقم الضريبي السعودي 15 رقمًا، يبدأ وينتهي بالرقم 3.`,
    });
  }
  const cr = p.crNumber ?? "";
  const cr2 = cr === "" ? null : crReason(cr);
  if (cr2) {
    const why = cr2 === "not_digits" ? ["it contains characters other than digits", "يحتوي على رموز غير الأرقام"] : [`it has ${cr.length} digits`, `يتكون من ${digitsAr(cr.length)}`];
    out.push({
      field: "crNumber", identifier: "cr_number", reason: cr2,
      error: `The Commercial Registration (CR) number "${cr}" is not valid: ${why[0]}. A Saudi CR number is 10 digits.`,
      errorAr: `رقم السجل التجاري «${cr}» غير صحيح: ${why[1]}. رقم السجل التجاري السعودي 10 أرقام.`,
    });
  }
  return out;
}
