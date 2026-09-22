/**
 * Statutory Saudi rates — ONE definition each (the 2026-09-03 constants
 * sweep; consolidated 2026-09-14). Before this file, the GOSI rates existed
 * as four sets of literals (the payroll posting path, two previews, and the
 * client's display copy) and the default VAT rate as seven `?? 15`s — four
 * or seven files to edit when a statutory rate changes, agreeing only
 * because the literals happened to match.
 *
 * 🔴 A rate change edits THIS file and nothing else. If a consumer cannot
 * import it (raw SQL, a spec default), it must carry a comment pointing
 * here and a test pinning it equal.
 */

/**
 * GOSI contribution rates, as decimal fractions of BASIC salary.
 * Saudi nationals: 9.75% employee / 11.75% employer.
 * Non-Saudi: employer-only 2% (occupational hazards).
 */
export const GOSI_RATES = {
  saudiEmployee: 0.0975,
  saudiEmployer: 0.1175,
  nonSaudiEmployer: 0.02,
} as const;

/** "9.75%" from 0.0975 — the display form derived, never restated. */
export function gosiPercentLabel(rate: number): string {
  return `${rate * 100}%`;
}

/**
 * Default VAT rate (percent) when a line does not carry one.
 * Moved 5% → 15% in real life in 2020 — the argument for one definition.
 */
export const DEFAULT_VAT_RATE = 15;

/**
 * 🔴 System accounts whose GL lines must NAME A PARTY (a customer or a
 * vendor): the receivable and payable control accounts. ONE definition
 * (2026-09-16): the posting seam refuses a party-less line on these, the
 * transaction writers refuse categorising a bank row to them (a bank line
 * carries no party — the movement belongs to an invoice or bill, settled
 * from Review), and the web picker does not offer them. Before this the
 * set lived only inside `glPosting.ts`, so the picker offered Accounts
 * Receivable for "CUSTOMER DEPOSIT — NAJD" and the save was a 500.
 *
 * D-4 (2026-09-17): the two customer-credit liabilities join the set. A
 * deposit is a deposit FROM someone and a credit balance is owed TO someone
 * — a party-less line on either would be a balance nobody can apply or
 * refund. Which of the two an amount lands on is decided in ONE place,
 * `services/accounting/customerCreditPolicy.ts`, never at a call site.
 */
export const PARTY_REQUIRED_SYSTEM_CODES = ["AR", "AP", "CUSTOMER_DEPOSITS", "CUSTOMER_CREDITS", "UNIDENTIFIED_RECEIPTS", "SECURITY_DEPOSITS_HELD"] as const;
