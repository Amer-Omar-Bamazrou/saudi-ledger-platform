/**
 * 🔴 BR-KSA-49 — PRIVATE EDUCATION AND PRIVATE HEALTHCARE TO CITIZENS NAME THE BUYER'S SAUDI NATIONAL ID (2026-11-21).
 *
 * The rule (ZATCA E-Invoice XML Implementation Standard v1.2, BR-KSA-49): when an invoice line uses the exemption
 * VATEX-SA-EDU or VATEX-SA-HEA ("Private education to citizen", "Private healthcare to citizen"), the other buyer ID
 * (BT-46) is mandatory and must be the national ID, scheme NAT (BT-46-1 = NAT). BR-KSA-25 makes the buyer's name
 * mandatory too. ZATCA's E-Invoicing Implementation Resolution (2023-05-19), annex, item 5.3: the additional buyer ID
 * "should contain the National ID only" for those supplies. Our live sandbox test pins the rejection when it is
 * absent (zatca-compliance-live.test.ts).
 *
 * The format checked: TEN DIGITS STARTING WITH 1. Source — the Saudi Central Bank's Account Opening Rules, Appendix (C)
 * (SAMA Rulebook, https://rulebook.sama.gov.sa/en/node/2420): the Ministry of Interior's ten-digit computer number
 * starts with 1 for a Saudi citizen (the national ID) and with 2 for a foreign resident (the number of the iqama).
 * So an iqama number (starting with 2) is refused by name: these exemptions are for supplies to citizens.
 *
 * 🔴 NOT CHECKED, deliberately: the tenth digit. SAMA's appendix says it is a verification digit "derived from the
 * values of the other nine digits" and that the formula is available from the National Information Center on request;
 * it does not publish it. An unofficial formula is not implemented here (the owner, 2026-11-21) — a number with the
 * right shape and a wrong check digit passes this guard and is left to ZATCA and the buyer's own records.
 *
 * Enforced at ISSUANCE for every company (invoices.approvable.ts, before the ICV is consumed — a refusal writes and
 * sends nothing), and again by the e-invoice assembler, which also writes the ID into the XML as BT-46 scheme NAT.
 */
import { BusinessRuleError } from "../../lib/errors";

export const BUYER_IDENTIFIED_EXEMPTIONS: readonly string[] = ["VATEX-SA-EDU", "VATEX-SA-HEA"];

/** Ten digits starting with 1: a Saudi citizen's national ID (SAMA Appendix C). The check digit is not verified. */
export const SAUDI_NATIONAL_ID = /^1\d{9}$/;
const IQAMA_NUMBER = /^2\d{9}$/;

export const BUYER_ID_REFUSALS = {
  missing: {
    code: "exemption_requires_buyer_national_id",
    error: "This invoice uses a private education or private healthcare exemption, which ZATCA allows only for a buyer identified by their Saudi national ID (BR-KSA-49). Add the national ID to the customer record before issuing.",
    errorAr: "تستخدم هذه الفاتورة إعفاء التعليم الخاص أو الرعاية الصحية الخاصة، ولا تقبله هيئة الزكاة والضريبة والجمارك إلا لمشترٍ محدَّد برقم هويته الوطنية السعودية (BR-KSA-49). أضف رقم الهوية الوطنية إلى سجل العميل قبل الإصدار.",
  },
  iqama: {
    code: "exemption_requires_saudi_national_id",
    error: "The customer's ID starts with 2, so it is an iqama number. The private education and private healthcare exemptions are for supplies to Saudi citizens, and ZATCA requires the buyer's Saudi national ID (10 digits starting with 1). Use the standard VAT treatment for a resident, or correct the customer's ID.",
    errorAr: "يبدأ رقم هوية العميل بالرقم 2، فهو رقم إقامة. إعفاء التعليم الخاص والرعاية الصحية الخاصة مخصص للتوريدات إلى المواطنين السعوديين، وتشترط الهيئة رقم الهوية الوطنية السعودية للمشتري (10 أرقام تبدأ بالرقم 1). طبّق المعاملة الضريبية الأساسية للمقيم، أو صحّح رقم هوية العميل.",
  },
  invalid: {
    code: "buyer_national_id_invalid",
    error: "The customer's national ID is not a Saudi national ID: it must be 10 digits starting with 1. Correct it on the customer record before issuing.",
    errorAr: "رقم هوية العميل ليس رقم هوية وطنية سعودية: يجب أن يتكون من 10 أرقام ويبدأ بالرقم 1. صحّحه في سجل العميل قبل الإصدار.",
  },
} as const;

export function usesBuyerIdentifiedExemption(items: ReadonlyArray<{ taxExemptionReasonCode?: string | null }>): boolean {
  return items.some((it) => BUYER_IDENTIFIED_EXEMPTIONS.includes(it.taxExemptionReasonCode ?? ""));
}

/** Which refusal (if any) a buyer's ID earns on an education or healthcare invoice. */
export function buyerNationalIdRefusal(nationalId: string | null | undefined): (typeof BUYER_ID_REFUSALS)[keyof typeof BUYER_ID_REFUSALS] | null {
  const id = (nationalId ?? "").trim();
  if (!id) return BUYER_ID_REFUSALS.missing;
  if (SAUDI_NATIONAL_ID.test(id)) return null;
  if (IQAMA_NUMBER.test(id)) return BUYER_ID_REFUSALS.iqama;
  return BUYER_ID_REFUSALS.invalid;
}

/** Refuse (422, named, in both languages) unless an education or healthcare invoice's buyer has a Saudi national ID. */
export function assertBuyerNationalIdForExemptions(
  items: ReadonlyArray<{ taxExemptionReasonCode?: string | null }>,
  nationalId: string | null | undefined,
): void {
  if (!usesBuyerIdentifiedExemption(items)) return;
  const refusal = buyerNationalIdRefusal(nationalId);
  if (refusal) throw new BusinessRuleError(422, { ...refusal });
}
