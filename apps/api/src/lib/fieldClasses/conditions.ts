/**
 * 🔴 19B — the CONDITIONS some classes carry (classTable.ts `conditions`), implemented once, here.
 *
 * `bank_narrative` on a journal line's text applies only where the line came from a bank statement line: its entry's
 * source is `bank_transaction` (posted from a statement or bank row). `legacy_unclassified` entries were written before
 * the source tag existed (A15, migration 0163) and may have been built from bank rows; their origin is unknown, so they
 * are treated as bank text too — protecting a manual entry's text by mistake is the safe error, serving a bank's text
 * to a viewer is not. Every other source writes its own text (an invoice, a bill, a payroll run, a typed entry).
 */
export const BANK_DERIVED_SOURCE_TYPES: readonly string[] = ["bank_transaction", "legacy_unclassified"];

export const isBankDerivedEntry = (sourceType: string | null | undefined): boolean =>
  sourceType == null || BANK_DERIVED_SOURCE_TYPES.includes(sourceType);
