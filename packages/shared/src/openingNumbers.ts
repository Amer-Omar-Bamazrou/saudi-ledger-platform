/**
 * Batch 1C — Policy C (accountant A4, 2026-09-20; decision pack §16.12.1,
 * §16.12.3): the Saudi-Ledger-controlled number of a REPLACEMENT opening
 * item. When a committed migration is reversed and re-run, the re-run's
 * opening invoices and bills receive `OPEN-<batch>-<seq>` — the replacement
 * batch's id and the item's ordinal within it — never the previous system's
 * number (which stays verbatim on the reversed row and on the staging row as
 * provenance) and never anything derived from it (a suffix would let the
 * source system dictate a ledger number and collide with what a customer
 * types later).
 *
 * The prefix is RESERVED: `invoices_reserved_number_chk` /
 * `bills_reserved_number_chk` (migration 0081) refuse the shape on any
 * non-opening row, and the create/update services refuse it with a named
 * 422 before the database does. This module is the ONE definition of the
 * shape on the TypeScript side; `tests/opening-number-shape.test.ts` proves
 * it agrees with the SQL CHECK (two definitions with a forcing function).
 */
export const OPENING_NUMBER_PREFIX = "OPEN-";

/** The exact shape the database reserves: `OPEN-<digits>-<digits>`. */
export const OPENING_REPLACEMENT_NUMBER = /^OPEN-\d+-\d+$/;

export function openingReplacementNumber(batchId: number, seq: number): string {
  if (!Number.isInteger(batchId) || batchId <= 0 || !Number.isInteger(seq) || seq <= 0) {
    throw new RangeError(`openingReplacementNumber needs positive integers (batch ${batchId}, seq ${seq})`);
  }
  return `${OPENING_NUMBER_PREFIX}${batchId}-${seq}`;
}

export const isReservedOpeningNumber = (n: string): boolean => OPENING_REPLACEMENT_NUMBER.test(n.trim());
