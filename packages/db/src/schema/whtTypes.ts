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
