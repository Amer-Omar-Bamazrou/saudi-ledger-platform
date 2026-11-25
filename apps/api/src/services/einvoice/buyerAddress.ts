/**
 * 🔴 THE BUYER'S ADDRESS ON A STANDARD TAX INVOICE (owner, 2026-11-24: "the address fields required for a Saudi buyer on
 * a standard invoice before approval").
 *
 * The rule, from the primary sources in trust order (LIVE API > SDK > PDF):
 *  - LIVE, ZATCA's sandbox, 2026-11-24 (customer-form-standard-invoice-live.test.ts): a standard invoice to a Saudi
 *    buyer with no structured address is flagged BR-KSA-63 ("If the buyer country code (BT-55) is SA, then these fields
 *    are mandatory: street name (BT-50), building number (KSA-18), postal code (BT-53), city (BT-52), District (KSA-4),
 *    country code (BT-55)"), BR-KSA-67 (the postal code must be 5 digits) and BR-KSA-10, now worded for a buyer OUTSIDE
 *    Saudi Arabia ("street (BT-50), city (BT-52), country code (BT-55)"). The sandbox returns them as WARNINGS today.
 *  - The pinned XML Implementation Standard v1.2 (docs/zatca/specs, p.59) states the same two rules.
 *
 * A standard invoice is one to a VAT-registered buyer (subtypeFor — the one definition). Checked at APPROVAL, before
 * the ICV, for every company, onboarded to ZATCA or not: a refusal issues, writes and sends nothing, and names each
 * missing field in both languages (422 `buyer_address_incomplete`). The country is the customer's, and an unset
 * country is Saudi Arabia — as the XML says it (the assembler's default).
 *
 * Credit notes are not refused: a credit note corrects an invoice already issued, possibly before this rule, and
 * refusing it would remove the correction.
 */
import { BusinessRuleError } from "../../lib/errors";
import { subtypeFor } from "./einvoiceInput.assembler";
import { isSaudiParty } from "../../lib/saudiIdentifiers";

export interface BuyerAddressFields {
  taxNumber?: string | null;
  buildingNumber?: string | null;
  street?: string | null;
  district?: string | null;
  city?: string | null;
  postalCode?: string | null;
  additionalNumber?: string | null;
  country?: string | null;
}

type Field = "street" | "buildingNumber" | "postalCode" | "city" | "district" | "additionalNumber" | "country";
const LABELS: Record<Field, [string, string]> = {
  street: ["street", "الشارع"],
  buildingNumber: ["building number", "رقم المبنى"],
  postalCode: ["postal code (5 digits)", "الرمز البريدي (5 أرقام)"],
  city: ["city", "المدينة"],
  district: ["district", "الحي"],
  additionalNumber: ["additional number (4 digits)", "الرقم الإضافي (4 أرقام)"],
  country: ["country", "الدولة"],
};

const blank = (v: string | null | undefined) => (v ?? "").trim() === "";

/** The fields a standard invoice's buyer is missing (none for a simplified invoice's buyer). */
export function missingBuyerAddressFields(buyer: BuyerAddressFields | null | undefined): Field[] {
  if (!buyer || subtypeFor(buyer.taxNumber) !== "standard") return [];
  // a Saudi buyer: country SA or unset — the one reading (lib/saudiIdentifiers.ts isSaudiParty)
  if (isSaudiParty(buyer.country)) {
    const missing: Field[] = [];
    if (blank(buyer.street)) missing.push("street");
    if (blank(buyer.buildingNumber)) missing.push("buildingNumber");
    if (!/^\d{5}$/.test((buyer.postalCode ?? "").trim())) missing.push("postalCode");
    if (blank(buyer.city)) missing.push("city");
    if (blank(buyer.district)) missing.push("district");
    // the pinned standard: "Buyer Address Additional number (KSA-19) must be 4 digits if it exists"
    if (!blank(buyer.additionalNumber) && !/^\d{4}$/.test((buyer.additionalNumber ?? "").trim())) missing.push("additionalNumber");
    return missing;
  }
  return (["street", "city"] as const).filter((f) => blank(buyer[f]));
}

/** Refuse (422, named, both languages) a standard invoice whose buyer's address is incomplete. Credit notes pass. */
export function assertBuyerAddressForStandardInvoice(documentType: string, buyer: BuyerAddressFields | null | undefined): void {
  if (documentType === "credit_note" || documentType === "advance_credit_note") return;
  const missing = missingBuyerAddressFields(buyer);
  if (missing.length === 0) return;
  throw new BusinessRuleError(422, {
    code: "buyer_address_incomplete",
    error: `A standard tax invoice needs the buyer's address. Missing on this customer: ${missing.map((f) => LABELS[f][0]).join(", ")}. Complete the customer's address, then approve again. Nothing was issued.`,
    errorAr: `تحتاج الفاتورة الضريبية عنوان المشتري. الناقص لدى هذا العميل: ${missing.map((f) => LABELS[f][1]).join("، ")}. أكمل عنوان العميل ثم اعتمد الفاتورة مرة أخرى. لم يُصدر شيء.`,
    missing,
  });
}
