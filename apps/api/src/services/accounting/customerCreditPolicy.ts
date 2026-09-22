/**
 * THE ONE PLACE that decides which liability account customer money sits on.
 *
 * D-4 (2026-09-17): a deposit and a credit-note balance are two liabilities
 * with different natures, VAT states and exits — `CUSTOMER_DEPOSITS` (a
 * contract liability, never a credit inside AR) and `CUSTOMER_CREDITS` (a
 * refund liability).
 *
 * 2026-09-22 (accountant, advance-payments answer 2): the deposit side is
 * itself THREE liabilities, decided by the receipt's classification (AP-1):
 *
 *   `advance`          → CUSTOMER_DEPOSITS        an advance for a supply — the
 *                                                  VAT tax point (Art. 23(1))
 *   `security_deposit` → SECURITY_DEPOSITS_HELD   refundable, contractually
 *                                                  unavailable for use — outside
 *                                                  VAT while it stays so
 *   `erroneous`        → UNIDENTIFIED_RECEIPTS    owed back
 *   `unknown`          → UNIDENTIFIED_RECEIPTS    reviewed, still unidentified
 *   (no record)        → CUSTOMER_DEPOSITS        🔴 a PRESUMPTION, recorded as
 *                                                  one: money an identified
 *                                                  customer sent on account is
 *                                                  presumed a deposit until the
 *                                                  business says otherwise; the
 *                                                  review list (AP-1) makes the
 *                                                  silence visible.
 *
 * A classification that changes the account moves the receipt's on-account
 * balance by ONE reclassification entry (payments.service `classify`), so the
 * GL and this map never disagree; a deposit whose advance tax invoice (386) is
 * issued and not fully cancelled cannot leave CUSTOMER_DEPOSITS (the 386 must
 * be credited first — AP-3).
 */
import type { SystemAccountCode } from "@workspace/db";

export type CustomerCreditOrigin = "deposit" | "credit_note";
export type DepositClassificationKind = "advance" | "erroneous" | "security_deposit" | "unknown";

export const CUSTOMER_CREDIT_ACCOUNT: Readonly<Record<CustomerCreditOrigin, SystemAccountCode>> = {
  deposit: "CUSTOMER_DEPOSITS",
  credit_note: "CUSTOMER_CREDITS",
};

export const CUSTOMER_CREDIT_ACCOUNT_NAME: Readonly<Record<CustomerCreditOrigin, string>> = {
  deposit: "Customer deposits and advances",
  credit_note: "Customer credit balances",
};

/** The three deposit-side liabilities, by the receipt's CURRENT classification. */
export const DEPOSIT_LIABILITY_ACCOUNT: Readonly<Record<DepositClassificationKind, SystemAccountCode>> = {
  advance: "CUSTOMER_DEPOSITS",
  security_deposit: "SECURITY_DEPOSITS_HELD",
  erroneous: "UNIDENTIFIED_RECEIPTS",
  unknown: "UNIDENTIFIED_RECEIPTS",
};

export const DEPOSIT_LIABILITY_ACCOUNT_NAME: Readonly<Record<SystemAccountCode & ("CUSTOMER_DEPOSITS" | "SECURITY_DEPOSITS_HELD" | "UNIDENTIFIED_RECEIPTS"), string>> = {
  CUSTOMER_DEPOSITS: "Customer deposits and advances",
  SECURITY_DEPOSITS_HELD: "Refundable security deposits held",
  UNIDENTIFIED_RECEIPTS: "Unidentified and erroneous receipts",
};

export type DepositLiabilityCode = keyof typeof DEPOSIT_LIABILITY_ACCOUNT_NAME;

/** The account a receipt's on-account balance sits on, given its latest classification (or none). */
export function depositLiabilityAccount(classification: DepositClassificationKind | null | undefined): { systemCode: DepositLiabilityCode; accountName: string } {
  const systemCode = (classification ? DEPOSIT_LIABILITY_ACCOUNT[classification] : CUSTOMER_CREDIT_ACCOUNT.deposit) as DepositLiabilityCode;
  return { systemCode, accountName: DEPOSIT_LIABILITY_ACCOUNT_NAME[systemCode] };
}

/** Every account a deposit-side balance can sit on — the set the subledger invariant and the position readers sum over. */
export const DEPOSIT_LIABILITY_CODES: readonly DepositLiabilityCode[] = ["CUSTOMER_DEPOSITS", "SECURITY_DEPOSITS_HELD", "UNIDENTIFIED_RECEIPTS"];
