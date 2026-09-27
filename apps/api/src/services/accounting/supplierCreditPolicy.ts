/**
 * WHERE AP ON-ACCOUNT MONEY SITS (Phase 11 Part 2, B4, 2026-09-22).
 * Record: docs/product/phase-11-deep-accounting-ap-decision-pack.md §10.
 *
 * 🔴 THE DIRECTION IS THE POINT, and it is not a mirror of the customer side.
 * A customer advance is a LIABILITY — we have their money and owe them goods.
 * A supplier advance is an ASSET — they have our money and owe us goods. So
 * every account named here is an asset carrying a DEBIT balance, and none of
 * the customer-side liabilities (`CUSTOMER_DEPOSITS`, `SECURITY_DEPOSITS_HELD`,
 * `UNIDENTIFIED_RECEIPTS`) may ever appear on an AP path.
 *
 * 🔴 THREE ACCOUNTS, NOT ONE, for the same reason the customer side has three:
 * their EXITS differ, and an account is only useful if what leaves it is
 * answerable.
 *   · `SUPPLIER_ADVANCES`      leaves by being applied to a bill.
 *   · `SECURITY_DEPOSITS_PAID` leaves by being returned, or forfeited into
 *                              expense — and until then it is not consideration
 *                              for any supply.
 *   · `UNIDENTIFIED_PAYMENTS`  leaves by being IDENTIFIED. It is never an
 *                              advance until somebody says so: an unclassified
 *                              payment that quietly became an advance would
 *                              assert a commercial fact nobody stated.
 *
 * 🔴 NONE OF THESE CARRIES INPUT VAT. VAT IR Art. 49(7): "Input Tax may only be
 * deducted where the Taxable Person HOLDS EVIDENCE of the amount of Input Tax
 * paid or payable…". Our right to deduct depends on holding the SUPPLIER'S tax
 * invoice, not on our payment — so paying an advance deducts nothing, and VAT
 * enters only when the supplier's document does, which in this product is a
 * BILL. Nothing on an AP payment path may compute input VAT.
 */
import type { SystemAccountCode } from "@workspace/db";

export type SupplierPaymentClassificationKind = "advance" | "security_deposit" | "erroneous" | "unknown";

/** The asset a supplier payment's on-account balance sits on, by its CURRENT classification. */
export const SUPPLIER_ON_ACCOUNT_ASSET: Readonly<Record<SupplierPaymentClassificationKind, SystemAccountCode>> = {
  advance: "SUPPLIER_ADVANCES",
  security_deposit: "SECURITY_DEPOSITS_PAID",
  erroneous: "UNIDENTIFIED_PAYMENTS",
  unknown: "UNIDENTIFIED_PAYMENTS",
};

export const SUPPLIER_ON_ACCOUNT_ASSET_NAME: Readonly<Record<string, string>> = {
  SUPPLIER_ADVANCES: "Supplier advances",
  SECURITY_DEPOSITS_PAID: "Refundable security deposits paid",
  UNIDENTIFIED_PAYMENTS: "Unidentified and erroneous payments",
};

/** Every account an AP on-account balance can sit on — the set the subledger invariant sums over. */
export const SUPPLIER_ON_ACCOUNT_CODES: readonly SystemAccountCode[] = [
  "SUPPLIER_ADVANCES", "SECURITY_DEPOSITS_PAID", "UNIDENTIFIED_PAYMENTS",
];

export function supplierOnAccountAsset(classification: SupplierPaymentClassificationKind | null | undefined): {
  systemCode: SystemAccountCode; accountName: string;
} {
  const systemCode = SUPPLIER_ON_ACCOUNT_ASSET[classification ?? "unknown"];
  return { systemCode, accountName: SUPPLIER_ON_ACCOUNT_ASSET_NAME[systemCode]! };
}

/**
 * 🔴 WHAT MAY BE APPLIED TO A BILL. A security deposit is refundable and is not
 * consideration for a supply; an erroneous or unidentified payment is money
 * whose purpose nobody has stated. Applying either to a bill would settle a
 * payable with money that is not for it — so only an ADVANCE may be allocated,
 * and the others must be reclassified first, which is an act somebody takes and
 * the record shows.
 */
export const ALLOCATABLE_CLASSIFICATIONS: readonly SupplierPaymentClassificationKind[] = ["advance"];

export function mayAllocate(classification: SupplierPaymentClassificationKind): boolean {
  return ALLOCATABLE_CLASSIFICATIONS.includes(classification);
}
