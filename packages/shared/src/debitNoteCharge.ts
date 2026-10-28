/**
 * 🔴 Phase 18 G1 — OWNER DECISION 8 (2026-10-27): the substance of an extra
 * charge on a sales DEBIT note. The ONE definition, shared by the server's note
 * rules and the screen that raises the note.
 *
 * The user classifies each extra charge by substance, with no default. Only a
 * change to the price of the original supply is a debit note (VAT IR
 * Art. 54(2)); a new supply, compensation and a late-payment fee are refused
 * at the write boundary, each naming its route.
 */
export const CHARGE_SUBSTANCES = ["price_change", "new_supply", "compensation", "late_payment_fee"] as const;
export type ChargeSubstance = (typeof CHARGE_SUBSTANCES)[number];

/**
 * Art. 54(6) (owner decision 8): the debit note is issued by the 15th of the
 * month after the month the price changed. Shown on the note; a late note is
 * never refused — the obligation to issue it stands.
 */
export function art54Deadline(eventDate: string): string {
  const y = Number(eventDate.slice(0, 4));
  const m = Number(eventDate.slice(5, 7));
  const [ny, nm] = m === 12 ? [y + 1, 1] : [y, m + 1];
  return `${ny}-${String(nm).padStart(2, "0")}-15`;
}
