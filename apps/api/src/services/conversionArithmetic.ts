/**
 * Shared arithmetic for partial conversion (M21.2 → M21.3).
 *
 * 🔴 WHY THIS FILE EXISTS AS ITS OWN MODULE.
 *
 * Exactly one rule in here is an OPEN QUESTION with the owner's accountant —
 * how a line-level discount behaves when only part of the line is converted.
 * Quotation→invoice already needs it, and PO→bill will need the identical
 * rule. Two copies would mean the answer arrives and one of them gets updated,
 * which is the "green fixes the case, not the class" shape in advance.
 *
 * So the rule lives here once. When the answer comes back, this is the ONLY
 * function to change, and both conversion paths follow.
 */

/**
 * Scale a line-level discount to the proportion of the line being converted.
 *
 * 🔴 **PENDING: owner's accountant (asked 2026-08-20).** The current behaviour
 * is PROPORTIONAL — a 100 SAR discount on 10 units contributes 40 SAR when 4
 * units are invoiced.
 *
 * The reasoning, so the accountant is answering a stated question rather than
 * a silent default: the discount was quoted against the whole line, so
 * applying it in full to the first partial invoice would undercharge that
 * invoice and overcharge the remainder — the customer's total across all
 * conversions would still come out right, but every intermediate document
 * would be wrong, and each of those is a real tax invoice.
 *
 * The plausible alternatives, if the answer differs:
 *   - **Whole discount on the FIRST conversion** (some systems do this, on the
 *     grounds that a discount is an incentive granted once).
 *   - **Whole discount on the LAST**, i.e. settle up at the end.
 *   - **Not scalable at all** — a discounted line must convert in full.
 *
 * Any of those is a change to THIS FUNCTION and its callers' tests, and
 * nothing else. Until the answer arrives, proportional is what ships, and it
 * is recorded as a decision-in-force rather than an assumption nobody stated.
 *
 * @param lineDiscount the discount quoted against the WHOLE line
 * @param convertedQuantity how much of the line is being converted now
 * @param quotedQuantity the line's full quoted quantity
 */
export function scaleLineDiscount(
  lineDiscount: number,
  convertedQuantity: number,
  quotedQuantity: number,
): number {
  if (!Number.isFinite(lineDiscount) || lineDiscount === 0) return 0;
  // A zero/absent quoted quantity cannot be a denominator. Returning 0 rather
  // than throwing keeps a malformed legacy row from blocking a conversion, and
  // 0 is the safe direction: it charges the customer MORE, which surfaces as a
  // question rather than as silent revenue loss.
  if (!Number.isFinite(quotedQuantity) || quotedQuantity <= 0) return 0;

  const proportion = convertedQuantity / quotedQuantity;
  return Math.round(lineDiscount * proportion * 100) / 100;
}
