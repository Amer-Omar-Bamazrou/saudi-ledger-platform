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

/**
 * ── Exact sums: integer halalas (Phase 14, 2026-10-01) ────────────────────
 *
 * A report that adds many money values as JS doubles drifts by representation
 * error before anything rounds it (0.1 + 0.2 ≠ 0.3), and rounding the total at
 * the end only hides the drift until the day it crosses a halala. The ledger
 * seam (`reports.repository` `ledgerBalances`) sums in PostgreSQL `numeric`
 * and returns DECIMAL STRINGS; these helpers carry those strings into exact
 * integer halalas, add integers, and convert back once.
 *
 * `toHalalas` parses a decimal string WITHOUT going through a float, so
 * "1234567.89" is 123456789 exactly. A value with more than two decimals is
 * refused rather than truncated (partial data is not lenient data): money in
 * this platform is numeric(15,2), and a third decimal means the input is not
 * a stored amount.
 */
export const toHalalas = (v: string | number | null | undefined): number => {
  if (v == null || v === "") return 0;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new RangeError(`Not a money amount: ${v}`);
    return Math.round(v * 100);
  }
  const m = /^(-)?(\d+)(?:\.(\d{1,2})?)?$/.exec(v.trim());
  if (!m) {
    // numeric aggregates may come back with trailing zeros beyond 2 places ("12.3400")
    const t = /^(-)?(\d+)\.(\d{2})(0+)$/.exec(v.trim());
    if (!t) throw new RangeError(`Not a 2-decimal money amount: "${v}"`);
    const h = Number(t[2]) * 100 + Number(t[3]);
    return t[1] ? -h : h;
  }
  const units = Number(m[2]);
  const cents = m[3] ? Number(m[3].padEnd(2, "0")) : 0;
  const h = units * 100 + cents;
  if (!Number.isSafeInteger(h)) throw new RangeError(`Money amount out of range: "${v}"`);
  return m[1] ? -h : h;
};

/** Integer halalas back to the 2-decimal number the API returns. */
export const fromHalalas = (h: number): number => {
  if (!Number.isSafeInteger(h)) throw new RangeError(`Not an integer halala amount: ${h}`);
  return h / 100;
};

/** Σ of money values, exact (integer halalas), returned as a 2-decimal number. */
export const sumMoney = (values: Iterable<string | number | null | undefined>): number => {
  let h = 0;
  for (const v of values) h += toHalalas(v);
  return fromHalalas(h);
};

/**
 * Split a total into `parts` rounded addends that sum EXACTLY to the total.
 *
 * 🔴 ONE DEFINITION OF THE CONVENTION (Phase 11, 2026-09-22). Every equal
 * addend is `round2(total / parts)` and the LAST one absorbs the residue, so
 * Σ rows = the total to the halala with no drift and no plug. This is the rule
 * the fixed-asset depreciation schedule has used since FA-A; it lives here now
 * because the accrual and prepayment schedules need the same one, and two
 * copies of a formula diverge invisibly until something joins them.
 *
 * Throws on a non-positive `parts`: a schedule of zero periods is not a
 * schedule, and returning [] would let a caller believe it had recognised
 * something.
 */
export const spreadOverPeriods = (total: number, parts: number): number[] => {
  const n = Math.trunc(parts);
  if (!(n > 0)) throw new RangeError("A schedule needs at least one period.");
  const each = round2(total / n);
  return Array.from({ length: n }, (_, i) => (i === n - 1 ? round2(total - round2(each * (n - 1))) : each));
};
