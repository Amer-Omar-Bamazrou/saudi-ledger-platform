/**
 * Refusing input the database would refuse (Phase 18 final round; register §11.134).
 *
 * Postgres refuses a NUL in text and anything but an in-range integer for an integer column. Input like that reaching a
 * query is the caller's mistake, and it used to surface as our 500. Check it before the query.
 */

/** An integer column's largest value. */
const MAX_INTEGER_ID = 2_147_483_647;

/** True when the value is usable as a lookup key in an integer id column: a whole number from 1 to the column's maximum. */
export function isIntegerId(id: number): boolean {
  return Number.isInteger(id) && id > 0 && id <= MAX_INTEGER_ID;
}

/** A body's id, as a number when it was sent as a number or as text; otherwise NaN, never a coerced object or boolean. */
export function idFromBody(value: unknown): number {
  return typeof value === "number" || typeof value === "string" ? Number(value) : Number.NaN;
}

/** Postgres text cannot hold a NUL: a query carrying one fails, so an email with one can match no account. */
export function hasNul(text: string): boolean {
  return text.includes("\0");
}
