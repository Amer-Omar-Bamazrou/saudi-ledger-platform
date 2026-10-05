import { sql } from "drizzle-orm";

/**
 * Phase 16 — the payment natures of Income Tax Implementing Regulations Art.
 * 63(1) as amended by MoF Resolution 25 (in force 12-09-2023). THE ONE
 * definition: the `wht_rates`, `wht_withholdings`, treaty-relief and vendor
 * CHECKs are all built from this list, so a nature cannot exist in one place
 * and not another (the two-definitions lesson). Rates live in `wht_rates`.
 */
export const WHT_PAYMENT_TYPES = [
  "rent", "royalty", "management_fee", "air_tickets_or_air_freight", "sea_freight", "intl_telecom",
  "dividends", "technical_consulting", "loan_returns", "insurance_premiums", "other_payments",
] as const;
export type WhtPaymentType = (typeof WHT_PAYMENT_TYPES)[number];

/** `'rent', 'royalty', …` — for a CHECK constraint. */
export const WHT_PAYMENT_TYPES_SQL = sql.raw(WHT_PAYMENT_TYPES.map((t) => `'${t}'`).join(", "));

/**
 * Accountant Q2 (2026-10-05; pack §14.2): why a payment to a NON-RESIDENT is
 * not subject. The first two are the payment's own nature or source, declared
 * by a person; the last two follow from what the money WAS — a refundable
 * deposit and an erroneous payment are not consideration for a supply, so no
 * IR Art. 63(1) nature applies to them and nothing is withheld.
 */
export const WHT_NOT_SUBJECT_REASONS = ["goods", "not_kingdom_source", "refundable_deposit", "erroneous_payment"] as const;
export type WhtNotSubjectReason = (typeof WHT_NOT_SUBJECT_REASONS)[number];
/** The two a person declares on a payment that IS consideration (a bill payment, an advance). */
export const WHT_DECLARABLE_NOT_SUBJECT_REASONS = ["goods", "not_kingdom_source"] as const satisfies readonly WhtNotSubjectReason[];

/**
 * What the money was, as the pay path knew it when the withholding was
 * decided — frozen on the record (a later reclassification adds a superseding
 * record, never an edit):
 *   bill_payment   — settles a bill: consideration
 *   advance        — on account, identified as an advance: consideration
 *   allocated      — a supplier payment wholly allocated to bills: consideration
 *   security_deposit · erroneous — not consideration: not subject, by class
 *   unknown        — on account, purpose not identified: PENDING, nothing withheld
 */
export const WHT_PAYMENT_CLASSES = ["bill_payment", "advance", "allocated", "security_deposit", "erroneous", "unknown"] as const;
export type WhtPaymentClass = (typeof WHT_PAYMENT_CLASSES)[number];

/** How the payment's nature was established: stated on the payment, the supplier's declared default, or its classification. */
export const WHT_NATURE_BASES = ["declared", "supplier_default", "payment_class"] as const;
export type WhtNatureBasis = (typeof WHT_NATURE_BASES)[number];

const sqlList = (xs: readonly string[]) => sql.raw(xs.map((t) => `'${t}'`).join(", "));
export const WHT_NOT_SUBJECT_REASONS_SQL = sqlList(WHT_NOT_SUBJECT_REASONS);
export const WHT_PAYMENT_CLASSES_SQL = sqlList(WHT_PAYMENT_CLASSES);
export const WHT_NATURE_BASES_SQL = sqlList(WHT_NATURE_BASES);
