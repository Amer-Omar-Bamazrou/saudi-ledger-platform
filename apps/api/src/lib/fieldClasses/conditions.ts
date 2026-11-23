/**
 * 🔴 19B — the CONDITIONS some classes carry (classTable.ts `conditions` / `rowConditions`), implemented once, here.
 *
 * `bank_narrative` on a journal entry's or line's text applies only where the text is the BANK'S OWN: its TEXT ORIGIN.
 *  - `bank_line` — the entry was posted from a bank statement line or bank row (source `bank_transaction`): its entry
 *    and line texts are the bank's narrative (transactionPosting.service.ts).
 *  - `unknown` — written before the source tag existed (`legacy_unclassified`, A15, migration 0163), with no source,
 *    or a mirror of such an entry: it may have been built from bank rows, so it is treated as bank text — protecting a
 *    typed entry's text by mistake is the safe error, serving a bank's text to a viewer is not.
 *  - `document` — every other source writes its own text (an invoice, a bill, a payroll run, a typed entry).
 *
 * 🔴 A MIRROR TAKES ITS ORIGINAL'S ORIGIN (review follow-up, 2026-11-24): reversing an entry copies its texts onto the
 * mirror ("Reversal of <text>", each line's text as is — journalEntries.service.ts) while the mirror's own source is
 * `reversal`. Read by source alone, a reversed bank entry's text passed as typed text. The origin follows `reversal_of`
 * to the original; a mirror of a mirror is `unknown`.
 *
 * The SQL that computes it is `repositories/entryTextOrigin.ts` — one definition, used by every read that serves an
 * entry's or line's text.
 */
export const TEXT_ORIGINS = ["bank_line", "unknown", "document"] as const;
export type TextOrigin = (typeof TEXT_ORIGINS)[number];

/** The origins whose text is, or may be, the bank's own — `bank_narrative` applies to these rows. */
export const BANK_TEXT_ORIGINS: readonly TextOrigin[] = ["bank_line", "unknown"];

/** A row whose origin is not known to the reader is treated as bank text (the safe error). */
export const isBankText = (origin: string | null | undefined): boolean =>
  origin == null || (BANK_TEXT_ORIGINS as readonly string[]).includes(origin);

/** The source types that are bank text by themselves (the SQL definition reads these). */
export const BANK_LINE_SOURCE_TYPES: readonly string[] = ["bank_transaction"];
export const UNKNOWN_ORIGIN_SOURCE_TYPES: readonly string[] = ["legacy_unclassified"];
