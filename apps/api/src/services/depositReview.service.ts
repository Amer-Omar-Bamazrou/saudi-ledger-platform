/**
 * AP-1 (2026-09-20) — DEPOSITS HELD, AND WHICH OF THEM MAY OWE VAT.
 *
 * The one reader that turns "a customer's money is on account" into a
 * review state the VAT page can show. Decision record:
 * docs/product/advance-payments-decision-pack.md §4 (the tax point at
 * receipt — GCC VAT Agreement Art. 23(1); the tax invoice an advance
 * requires — IR Art. 53(1)(a)(2), issued by the 15th of the month after the
 * month of receipt, (1)(b)) and §9 AP-1.
 *
 * What it does: lists every live receipt received on or before `asOf`
 * whose unapplied remainder is still positive, and names for each one
 * whether a human still has something to decide or do:
 *
 *   unclassified          nobody has said what the money is
 *   advance_not_invoiced  an advance for a taxable supply with no advance
 *                         tax invoice (the platform cannot issue one yet —
 *                         AP-2); `deadline` = the 15th of the next month,
 *                         `overdue` once today is past it
 *   vat_silent            erroneous / duplicate payment or a refundable
 *                         security deposit — no VAT expected (the
 *                         accountant's A1 is still to confirm this; nothing
 *                         posts either way)
 *   migrated_invoiced     an opening deposit the previous system tax-
 *                         invoiced — its VAT was declared there
 *   migrated_unknown      an opening deposit whose VAT position the
 *                         migration could not establish — review
 *
 * What it does NOT do: post, alter or compute any VAT; decide tax for the
 * user; read anything but facts the write paths recorded. `needsReview` is
 * a WHO-FINDS-OUT figure (CLAUDE.md §3 "Who finds out?"), never a box of the
 * return. The frame is honest and stated on the response: the unapplied
 * remainder is as of NOW (allocations are not dated back), the receipt date
 * is the filter — so a deposit received in the period and allocated to a
 * full-VAT invoice in a LATER period is a timing difference this list does
 * not show; AP-2/AP-3 close it at the document.
 */
import { businessToday } from "@workspace/shared";
import { round2 } from "../lib/money";
import { paymentsRepository } from "../repositories/payments.repository";
import type { DepositClassification } from "./payments.service";

export type DepositReviewState = "unclassified" | "advance_not_invoiced" | "vat_silent" | "migrated_invoiced" | "migrated_unknown";

export type DepositReviewItem = {
  paymentId: number;
  customerId: number;
  customerName: string;
  customerNameAr: string | null;
  paidAt: string;
  amount: number;
  unappliedAmount: number;
  reference: string | null;
  source: string;
  classification: DepositClassification;
  vatCategory: string | null;
  classifiedAt: string | null;
  migrationVatPosition: "invoiced" | "unknown" | null;
  reviewState: DepositReviewState;
  needsReview: boolean;
  /** For an advance: the last day the advance tax invoice may be issued (IR Art. 53(1)(b) — the 15th of the month after receipt). */
  deadline: string | null;
  overdue: boolean;
};

export type DepositReview = {
  asOf: string;
  today: string;
  items: DepositReviewItem[];
  needsReviewCount: number;
  needsReviewAmount: number;
  overdueCount: number;
  byState: Record<DepositReviewState, { count: number; amount: number }>;
};

/** The 15th of the month after `paidAt` (YYYY-MM-DD in, YYYY-MM-DD out; calendar arithmetic only). */
export function advanceInvoiceDeadline(paidAt: string): string {
  const [y, m] = paidAt.slice(0, 10).split("-").map(Number) as [number, number, number];
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return `${ny}-${String(nm).padStart(2, "0")}-15`;
}

/** The last calendar day of a YYYY-MM month, as YYYY-MM-DD. */
export function endOfMonth(period: string): string {
  const [y, m] = period.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${y}-${String(m).padStart(2, "0")}-${String(last).padStart(2, "0")}`;
}

export function reviewStateOf(row: { source: string; migrationVatPosition: string | null; classification: DepositClassification }): { state: DepositReviewState; needsReview: boolean } {
  if (row.source === "opening") {
    return row.migrationVatPosition === "invoiced" ? { state: "migrated_invoiced", needsReview: false } : { state: "migrated_unknown", needsReview: true };
  }
  switch (row.classification) {
    case "advance": return { state: "advance_not_invoiced", needsReview: true };
    case "erroneous":
    case "security_deposit": return { state: "vat_silent", needsReview: false };
    default: return { state: "unclassified", needsReview: true };
  }
}

const EMPTY = (): Record<DepositReviewState, { count: number; amount: number }> => ({
  unclassified: { count: 0, amount: 0 },
  advance_not_invoiced: { count: 0, amount: 0 },
  vat_silent: { count: 0, amount: 0 },
  migrated_invoiced: { count: 0, amount: 0 },
  migrated_unknown: { count: 0, amount: 0 },
});

export const depositReviewService = {
  /**
   * `asOf` — receipts received on or before this date are in the frame
   * (default: today). The VAT page passes the end of its `period_to` month.
   */
  async review(filter: { asOf?: string | null; customerId?: number } = {}): Promise<DepositReview> {
    const today = businessToday();
    const asOf = filter.asOf && filter.asOf > "0001-01-01" ? filter.asOf : today;
    const rows = await paymentsRepository.depositsHeld({ asOf, customerId: filter.customerId });
    const byState = EMPTY();
    let needsReviewCount = 0;
    let needsReviewAmount = 0;
    let overdueCount = 0;
    const items: DepositReviewItem[] = rows.map((r) => {
      const classification = (r.classification ?? "unknown") as DepositClassification;
      const migrationVatPosition = r.source === "opening" ? ((r.migration_vat_position as "invoiced" | "unknown" | null) ?? "unknown") : null;
      const { state, needsReview } = reviewStateOf({ source: r.source, migrationVatPosition, classification });
      const unapplied = round2(Number(r.unapplied));
      const deadline = state === "advance_not_invoiced" ? advanceInvoiceDeadline(r.paid_at) : null;
      const overdue = deadline != null && today > deadline;
      byState[state].count += 1;
      byState[state].amount = round2(byState[state].amount + unapplied);
      if (needsReview) { needsReviewCount += 1; needsReviewAmount = round2(needsReviewAmount + unapplied); }
      if (overdue) overdueCount += 1;
      return {
        paymentId: r.payment_id, customerId: r.customer_id, customerName: r.customer_name, customerNameAr: r.customer_name_ar ?? null,
        paidAt: r.paid_at, amount: round2(Number(r.amount)), unappliedAmount: unapplied, reference: r.reference ?? null, source: r.source,
        classification, vatCategory: r.vat_category ?? null, classifiedAt: r.classified_at ? new Date(r.classified_at).toISOString() : null,
        migrationVatPosition, reviewState: state, needsReview, deadline, overdue,
      };
    });
    return { asOf, today, items, needsReviewCount, needsReviewAmount, overdueCount, byState };
  },
};
