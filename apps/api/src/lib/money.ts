/**
 * 🔴 N2 — MONEY ROUNDING IS ONE SEAM (2026-09-03).
 *
 * ── Why this file exists ───────────────────────────────────────────────────
 * `round2 = (n) => Math.round(n * 100) / 100` was defined TWELVE times across
 * the services, while ~90 call sites stored money with a bare `.toFixed(2)` —
 * and those are DIFFERENT rounding functions. `.toFixed(2)` operates on the
 * raw IEEE-754 double, so the two disagree exactly where float representation
 * error sits on a half-cent: 2.675 → `round2` 2.68, `.toFixed(2)` "2.67";
 * 1.045 → 1.05 vs "1.04". Both were used in the SAME paths — compute with one,
 * store with the other.
 *
 * The measured consequence (`erpnext-comparison-2026-09-03.md` §3): headers
 * accumulated UNROUNDED while lines stored ROUNDED, so payroll's GL — built
 * from the headers — failed the balance check for **10.3% of salary values**
 * (185/1,801 swept), surfacing as a 500 on approve. The invoice path had fixed
 * exactly this shape once ("HEADER = Σ ROUNDED LINES, exactly",
 * `invoices.service.ts`) and the sweep never reached payroll — §3's "the
 * report is a sample, not an inventory".
 *
 * ── The rules this seam enforces ───────────────────────────────────────────
 * 1. **One rounding function.** Every service imports `round2` from here; a
 *    local `const round2 = …` is the two-constants disease (`glPosting.ts`'s
 *    own GL_BALANCE_TOLERANCE lesson) at 12×.
 * 2. **Storage goes through `money2`, which rounds THE SAME WAY first.**
 *    `money2(n) === round2(n).toFixed(2)`, so the number checked and the
 *    string stored can never disagree. A bare `.toFixed(2)` on an unrounded
 *    float is the bug this file retires.
 * 3. **Accumulate ROUNDED addends when a header must equal the sum of its
 *    stored lines.** A total built from unrounded addends and rounded once at
 *    the end will drift from the rounded lines by up to a halala per line —
 *    which is precisely a number that "satisfies every check while meaning
 *    nothing" once the lines are what actually persisted.
 *
 * ERPNext's equivalent (`general_ledger.py:397-427`) rounds every entry to
 * precision FIRST, sums the rounded values, and re-checks after any
 * adjustment; their rounding policy is likewise a single system setting.
 */

/** Round to 2 decimal places — the platform's ONE money rounding. */
export const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * The storage form: round with `round2`, THEN format. Use this — never a bare
 * `.toFixed(2)` — wherever a money number becomes a string for a numeric
 * column, so the value stored is exactly the value the arithmetic checked.
 */
export const money2 = (n: number): string => round2(n).toFixed(2);
