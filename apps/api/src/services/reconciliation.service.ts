/**
 * M16.3 — bank reconciliation (design §3, Q3a/Q3b decided by the owner).
 *
 * Two halves, deliberately asymmetric in authority:
 *
 *  1. SUGGESTIONS (`suggestFor`) — pure, read-only matching. v1 is EXACT-MATCH
 *     only: a document number appearing in the bank-line description, or an
 *     amount equal to exactly ONE open document's outstanding balance. A
 *     suggestion is never applied by the system — however exact the match —
 *     because auto-applying would be consent-to-a-pattern (the A3 lesson).
 *     Unmatched rows stay plain transactions.
 *
 *  2. SETTLE (`settle`) — the human's acceptance. ONE act: the row leaves the
 *     holding area AND the payment is recorded — through the EXISTING pay path
 *     (`invoicesService.pay` / `billsService.pay`), which posts Dr Cash/Cr AR
 *     (or Dr AP/Cr Cash) through M13's chart. No parallel posting path: this
 *     service never touches the GL itself. The transaction becomes
 *     `kind: settlement` — excluded from income/expense/VAT/Zakat/budget
 *     aggregates (the income was recognised at issuance; counting the receipt
 *     again double-counts revenue) while cash flow keeps it.
 *
 * The human may settle against ANY open document, not only the suggested one —
 * the suggestion is a default, not a constraint; the server re-validates
 * either way (open document, amount within outstanding — enforced in the pay
 * path, shared with every other payment).
 */
import { BadRequestError, ConflictError, NotFoundError } from "../lib/errors";
import { auditService } from "./audit.service";
import { billsService } from "./bills.service";
import { invoicesService } from "./invoices.service";
import { billsRepository } from "../repositories/bills.repository";
import { invoicesRepository } from "../repositories/invoices.repository";
import { transactionsRepository } from "../repositories/transactions.repository";
import type { transactionsTable } from "@workspace/db";

type Tx = typeof transactionsTable.$inferSelect;

export interface SettlementSuggestion {
  documentKind: "invoice" | "bill";
  documentId: number;
  documentNumber: string;
  counterpartyName: string | null;
  outstanding: number;
  matchedBy: "number" | "amount";
  partial: boolean;
}

interface OpenDocument {
  id: number;
  number: string;
  counterpartyName: string | null;
  outstanding: number;
}

const EPS = 0.005;
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Does `documentNumber` appear in the description as a whole token?
 *
 * Bounded by non-alphanumerics on both sides so "INV-1" does NOT match inside
 * "INV-10" — a prefix hit on a shorter number would be a confident wrong match
 * on a legal document reference. Case-insensitive: banks upper-case freely.
 */
export function referencesDocumentNumber(description: string, documentNumber: string): boolean {
  const escaped = documentNumber.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, "i").test(description);
}

/**
 * The v1 exact-match rules, for one pending row against one candidate set.
 *
 *  - number match: the document's number is referenced in the description AND
 *    the amount does not exceed the outstanding balance. Equal → full match;
 *    less → a description-referenced PARTIAL (Q3b: suggested); more → no
 *    suggestion (an overpay is never a safe suggestion).
 *  - amount match: the amount equals exactly ONE candidate's outstanding
 *    balance. Two candidates with the same outstanding → ambiguous → nothing.
 *    Amount-only partials are guesswork and never suggested (Q3b).
 */
function matchAgainst(
  description: string,
  amount: number,
  candidates: OpenDocument[],
  documentKind: "invoice" | "bill",
): SettlementSuggestion | null {
  const referenced = candidates.filter(
    (c) => referencesDocumentNumber(description, c.number) && amount <= c.outstanding + EPS,
  );
  if (referenced.length === 1) {
    const c = referenced[0];
    return {
      documentKind,
      documentId: c.id,
      documentNumber: c.number,
      counterpartyName: c.counterpartyName,
      outstanding: c.outstanding,
      matchedBy: "number",
      partial: amount < c.outstanding - EPS,
    };
  }
  if (referenced.length > 1) return null; // ambiguous reference — a human decides unaided

  const byAmount = candidates.filter((c) => Math.abs(c.outstanding - amount) <= EPS);
  if (byAmount.length === 1) {
    const c = byAmount[0];
    return {
      documentKind,
      documentId: c.id,
      documentNumber: c.number,
      counterpartyName: c.counterpartyName,
      outstanding: c.outstanding,
      matchedBy: "amount",
      partial: false,
    };
  }
  return null;
}

export const reconciliationService = {
  /**
   * Compute settlement suggestions for a page of pending rows. Loads each open
   * side at most once (and only when a row could use it), then matches in
   * memory — no per-row queries.
   */
  async suggestFor(rows: Tx[]): Promise<Map<number, SettlementSuggestion>> {
    const out = new Map<number, SettlementSuggestion>();
    // Only an OPERATING pending row can turn out to be a settlement; a
    // classified transfer is money between own pockets, not a receipt/payment.
    const eligible = rows.filter((r) => r.reviewStatus === "pending_review" && r.kind === "operating");
    if (eligible.length === 0) return out;

    const wantInvoices = eligible.some((r) => r.type === "credit");
    const wantBills = eligible.some((r) => r.type === "debit");

    const [invoiceRows, billRows] = await Promise.all([
      wantInvoices ? invoicesRepository.openForSettlement() : Promise.resolve([]),
      wantBills ? billsRepository.openForSettlement() : Promise.resolve([]),
    ]);

    const openInvoices: OpenDocument[] = invoiceRows.map(({ inv, cust }) => ({
      id: inv.id,
      number: inv.invoiceNumber,
      counterpartyName: cust?.name ?? null,
      outstanding: round2(Number(inv.total) - Number(inv.paidAmount ?? 0)),
    }));
    const openBills: OpenDocument[] = billRows.map(({ bill, vendor }) => ({
      id: bill.id,
      number: bill.billNumber ?? String(bill.id),
      counterpartyName: vendor?.name ?? null,
      outstanding: round2(Number(bill.total) - Number(bill.paidAmount ?? 0)),
    }));

    for (const r of eligible) {
      const suggestion =
        r.type === "credit"
          ? matchAgainst(r.description, Number(r.amount), openInvoices, "invoice")
          : matchAgainst(r.description, Number(r.amount), openBills, "bill");
      if (suggestion) out.set(r.id, suggestion);
    }
    return out;
  },

  /**
   * Accept a pending row AS a settlement — the one human act of design §3.
   * Runs inside the request's tenant transaction, so the payment, the GL
   * posting, the row update and both audit records commit atomically.
   */
  async settle(
    transactionId: number,
    input: { invoiceId?: number | null; billId?: number | null },
    userId: number | null,
  ): Promise<Tx> {
    const invoiceId = input.invoiceId ?? null;
    const billId = input.billId ?? null;
    if ((invoiceId == null) === (billId == null)) {
      throw new BadRequestError("Name exactly one document to settle: invoiceId or billId.");
    }

    const [found] = await transactionsRepository.findWithCategory(transactionId);
    if (!found) throw new NotFoundError("Transaction not found");
    const tx = found.tx;

    // Settlement is the review-surface act. A row already in the books was
    // accepted as operating income/expense — reclassifying it is a correction
    // flow, not a settle.
    if (tx.reviewStatus !== "pending_review") {
      throw new ConflictError("Only a pending transaction can be settled from review.");
    }

    const amount = Number(tx.amount);
    if (invoiceId != null) {
      if (tx.type !== "credit") {
        throw new BadRequestError("Only a credit (money in) can settle a customer invoice.");
      }
      // The EXISTING pay path: validates the invoice is approved and unpaid,
      // refuses an amount beyond the outstanding balance, accumulates partial
      // payments, and posts Dr Cash / Cr AR. One writer per effect.
      await invoicesService.pay(invoiceId, { amount, paidAt: tx.date }, userId);
    } else {
      if (tx.type !== "debit") {
        throw new BadRequestError("Only a debit (money out) can pay a vendor bill.");
      }
      await billsService.pay(billId!, { amount, paidAt: tx.date }, userId);
    }

    // The row itself: accepted out of the holding area, classified as a
    // settlement (excluded from P&L/tax aggregates — the income/expense lives
    // on the document), stripped of any guessed category/VAT (the VAT fact
    // lives on the invoice/bill lines, and a settlement is not a supply).
    await transactionsRepository.update(transactionId, {
      reviewStatus: "accepted",
      kind: "settlement",
      settlesInvoiceId: invoiceId,
      settlesBillId: billId,
      categoryId: null,
      vatAmount: null,
      vatRate: null,
      taxTreatment: null,
    });

    const [updated] = await transactionsRepository.findWithCategory(transactionId);
    if (!updated) throw new NotFoundError("Transaction not found after settle");
    await auditService.record({
      action: "settle",
      entityType: "transaction",
      entityId: transactionId,
      before: tx,
      after: updated.tx,
    });
    return updated.tx;
  },
};
