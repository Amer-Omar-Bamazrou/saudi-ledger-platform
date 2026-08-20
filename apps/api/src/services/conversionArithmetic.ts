/**
 * Shared arithmetic for partial conversion (M21.2 quotation→invoice, M21.3
 * PO→bill).
 *
 * 🔴 WHY THIS IS ITS OWN MODULE. Both conversion directions need the identical
 * discount rule. Two copies would mean a future correction updates one of them
 * — "green fixes the case, not the class", avoided before the second case
 * existed.
 */

/** Round to halalas, the same 2dp discipline the line arithmetic uses. */
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Allocate a line-level discount across partial conversions.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 * ✅ **VERIFIED with the owner's accountant (2026-08-20)**, not reasoned:
 *
 * > "the invoice should reflect the exact math on the quotation"
 *
 * So a discount is **proportional** to the quantity converted — a 100 SAR
 * discount on 10 units contributes 40 SAR when 4 units are invoiced. Neither
 * "the whole discount on the first conversion" nor "no discount until the
 * last" is correct; each would make an intermediate tax invoice misstate what
 * was agreed, and every one of those documents is real.
 *
 * ── 🔴 Why this takes `alreadyConvertedQuantity` ────────────────────────────
 * Scaling each conversion INDEPENDENTLY and rounding each result drifts, and a
 * scaled discount is precisely where halalas drift between a quotation and the
 * invoices that come out of it. Three conversions of a third of a 100.00
 * discount:
 *
 *     round2(33.333) × 3  =  33.33 + 33.33 + 33.33  =  99.99   ✗ short by 0.01
 *
 * The quotation says 100.00 and the invoices in aggregate would say 99.99 —
 * exactly the "exact math" the accountant's answer rules out.
 *
 * This allocates on the CUMULATIVE quantity and subtracts what has already
 * been allocated, so the per-conversion figures telescope:
 *
 *     round2(100 × 1/3) − 0      = 33.33
 *     round2(100 × 2/3) − 33.33  = 66.67 − 33.33 = 33.34
 *     round2(100 × 3/3) − 66.67  = 100.00 − 66.67 = 33.33
 *                                  ─────────────────────────
 *                                  Σ = 100.00                  ✓ exact
 *
 * The final conversion absorbs the rounding remainder by construction, because
 * the cumulative figure at full conversion is `round2(discount × 1) =
 * discount`. Same family as the header = Σ rounded lines rule the invoice
 * totals already follow: round at the finest grain, and derive the rest.
 *
 * @param lineDiscount            the discount quoted against the WHOLE line
 * @param alreadyConvertedQuantity how much of the line was converted BEFORE now
 * @param thisQuantity            how much is being converted in this event
 * @param quotedQuantity          the line's full quoted quantity
 */
export function allocateLineDiscount(
  lineDiscount: number,
  alreadyConvertedQuantity: number,
  thisQuantity: number,
  quotedQuantity: number,
): number {
  if (!Number.isFinite(lineDiscount) || lineDiscount === 0) return 0;
  // A zero/absent quoted quantity cannot be a denominator. Returning 0 rather
  // than throwing keeps a malformed legacy row from blocking a conversion, and
  // 0 is the safe direction: it charges MORE, which surfaces as a question
  // rather than as silent revenue loss.
  if (!Number.isFinite(quotedQuantity) || quotedQuantity <= 0) return 0;

  const before = round2(lineDiscount * (alreadyConvertedQuantity / quotedQuantity));
  const after = round2(lineDiscount * ((alreadyConvertedQuantity + thisQuantity) / quotedQuantity));
  return round2(after - before);
}
