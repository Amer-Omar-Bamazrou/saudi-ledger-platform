/**
 * Q1 (2026-10-05; docs/product/phase-16-17-tax-treasury-decision-pack.md §14.1)
 * — THE ONE PREDICATE "this payment was reversed by a WHT correction".
 *
 * A correction never deletes or edits the payment it reverses: the bill
 * payment or supplier payment row stays, its entry is marked `reversed`
 * beside its mirror, and the `wht_corrections` row is the record that answers
 * it. Every reader of what a supplier payment still holds ON ACCOUNT reads this
 * predicate, so a reversed payment holds nothing — one definition, imported,
 * never restated. (A bill payment's reversal is carried by `bills.paid_amount`,
 * which the correction reduces, so `billPosition` needs nothing.)
 *
 * Two dialects, like `billPosition.ts`: plain text for raw SQL and the
 * invariant script, and Drizzle `sql` for the repositories. The subquery's own
 * alias (`spr_c`) cannot capture an outer one.
 */
import { sql, type SQL } from "drizzle-orm";

const ident = (alias: string) => {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) throw new Error(`paymentReversal: "${alias}" is not a SQL alias`);
  return alias;
};

/** A supplier payment (aliased `alias`) that a WHT correction reversed. */
export const SUPPLIER_PAYMENT_REVERSED_TEXT = (alias: string) =>
  `EXISTS (SELECT 1 FROM wht_corrections spr_c WHERE spr_c.supplier_payment_id = ${ident(alias)}.id)`;

/** A bill payment (aliased `alias`) that a WHT correction reversed. */
export const BILL_PAYMENT_REVERSED_TEXT = (alias: string) =>
  `EXISTS (SELECT 1 FROM wht_corrections bpr_c WHERE bpr_c.bill_payment_id = ${ident(alias)}.id)`;

export const supplierPaymentReversedSql = (alias: string): SQL => sql.raw(SUPPLIER_PAYMENT_REVERSED_TEXT(alias));
export const billPaymentReversedSql = (alias: string): SQL => sql.raw(BILL_PAYMENT_REVERSED_TEXT(alias));
