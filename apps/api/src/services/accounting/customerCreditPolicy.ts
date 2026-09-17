/**
 * D-4 (2026-09-17) — WHERE A CUSTOMER'S CREDIT LIVES IN THE GL: the one
 * definition.
 *
 * A customer can be in credit for two reasons with two natures:
 *
 *   `deposit`      cash arrived that no invoice explains yet — an unapplied
 *                  receipt, an advance, an over-payment's excess. A contract
 *                  liability: the business must perform or repay.
 *   `credit_note`  a credit note gave back more than its original invoice
 *                  still owed — the customer already paid for value the
 *                  business now acknowledges it did not deliver. A refund
 *                  liability: the business must repay or let it be consumed.
 *
 * Neither is a credit inside Accounts Receivable (accountant-confirmed;
 * decision pack §D-4 and batch-1b pack §1.2). The CURRENT policy is two
 * accounts, one per origin; the accountant may confirm a single account
 * later, and that change is made HERE — every posting path asks this map
 * and never names the code itself, so the payment engine is untouched by
 * the policy.
 *
 * VAT is deliberately NOT decided here or anywhere in Batch 1B Part 1: an
 * advance for a taxable supply is a VAT event on receipt (GCC Agreement
 * Art. 23), an erroneous over-payment is not, and the platform cannot tell
 * them apart. Nothing posts VAT on a deposit; the advance tax invoice is a
 * document the user issues (Part 2 surfaces the exception list).
 */
import type { SystemAccountCode } from "@workspace/db";

export type CustomerCreditOrigin = "deposit" | "credit_note";

export const CUSTOMER_CREDIT_ACCOUNT: Readonly<Record<CustomerCreditOrigin, SystemAccountCode>> = {
  deposit: "CUSTOMER_DEPOSITS",
  credit_note: "CUSTOMER_CREDITS",
};

/** The display label the posting line carries beside the code (a label, never the identity). */
export const CUSTOMER_CREDIT_ACCOUNT_NAME: Readonly<Record<CustomerCreditOrigin, string>> = {
  deposit: "Customer deposits and advances",
  credit_note: "Customer credit balances",
};
