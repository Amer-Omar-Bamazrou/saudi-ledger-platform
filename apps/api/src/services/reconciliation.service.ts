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
 *     (`invoicesService.pay` / `payBill`), which posts Dr Cash/Cr AR
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
import { BadRequestError, BankAccountRequiredError, BusinessRuleError, ConflictError, NotFoundError } from "../lib/errors";
import { auditService } from "./audit.service";
import { invoicesService } from "./invoices.service";
import { billsRepository } from "../repositories/bills.repository";
import { invoicesRepository } from "../repositories/invoices.repository";
import { transactionsRepository } from "../repositories/transactions.repository";
import type { transactionsTable } from "@workspace/db";
import { fromHalalas, round2, toHalalas } from "../lib/money";
import { payBill } from "./bills.payment";
import { baseForCash, decideWithholding } from "./accounting/wht";
import { paymentsRepository } from "../repositories/payments.repository";
import { bankReconciliationService } from "./accounting/bankReconciliation.service";
import { bankReconciliationRepository } from "../repositories/bankReconciliation.repository";

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

    // Audit Tier 3 (finding 6): outstanding is CREDIT-AWARE — the customer
    // pays `total − credited − paid`, and that is the amount a bank credit
    // will actually carry, so it is the amount matching must quote and match.
    // D-4: `credited_amount` is the cache of credit-note allocations to the invoice.
    const openInvoices: OpenDocument[] = invoiceRows
      .map(({ inv, cust }) => ({
        id: inv.id,
        number: inv.invoiceNumber,
        counterpartyName: cust?.name ?? null,
        outstanding: round2(Number(inv.total) - Number(inv.creditedAmount ?? 0) - Number(inv.writtenOffAmount ?? 0) - Number(inv.paidAmount ?? 0)),
      }))
      .filter((d) => d.outstanding >= 0.01); // fully credited ⇒ nothing to settle
    // Phase 11 Part 2: the repository computes outstanding through
    // `billPosition` — net of AP-subledger allocations, and never offering a
    // credit note — so a bank debit is matched to what the bill still owes.
    const openBills: OpenDocument[] = billRows.map(({ bill, vendor, outstanding }) => ({
      id: bill.id,
      number: bill.billNumber ?? String(bill.id),
      counterpartyName: vendor?.name ?? null,
      outstanding: round2(Number(outstanding)),
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
    // 🔴 D-3: a settlement's bank is the ROW'S bank — the one deterministic
    // fact a statement line carries. A row with no bank cannot settle
    // anything (the pay path would have no account to post cash to); the
    // refusal names the row so the reviewer can set its bank first.
    if (tx.bankAccountId == null) {
      throw new BankAccountRequiredError(
        `Transaction ${tx.id} names no bank account, so it cannot settle a document. Set the bank account on the row first.`,
        "bankAccountId",
        { transactionId: tx.id },
      );
    }
    if (invoiceId != null) {
      if (tx.type !== "credit") {
        throw new BadRequestError("Only a credit (money in) can settle a customer invoice.");
      }
      // The EXISTING pay path: validates the invoice is approved and unpaid,
      // refuses an amount beyond the outstanding balance, accumulates partial
      // payments, and posts Dr <bank leaf> / Cr AR. One writer per effect.
      // D-4: the payment records the bank row it was settled from (`source = settlement`).
      await invoicesService.pay(invoiceId, { amount, paidAt: tx.date, bankAccountId: tx.bankAccountId }, userId, { source: "settlement", sourceTransactionId: tx.id });
    } else {
      if (tx.type !== "debit") {
        throw new BadRequestError("Only a debit (money out) can pay a vendor bill.");
      }
      // 🔴 WHT-1 (final audit 2026-10-05): the statement line is the CASH that left the bank. Where the canonical
      // decision withholds (a non-resident supplier's consideration), the bill is settled by the GROSS whose cash is
      // this line — the pay path's own arithmetic, inverted (wht.ts `baseForCash`) — never by the cash itself, which
      // understated what was settled, the tax and the bank movement all three. No second engine: the decision and the
      // rounding are the pay path's; the pay path re-decides on the gross, and the cash it moves must equal the line.
      const [billRow] = await billsRepository.findById(billId!);
      if (!billRow) throw new NotFoundError("Bill not found");
      let gross = amount;
      const decision = await decideWithholding({ vendorId: billRow.vendorId, paymentDate: tx.date, base: amount, currency: billRow.currency, paymentClass: "bill_payment", declared: {} });
      if (decision.kind === "withheld") {
        const outstandingH = toHalalas(await billsRepository.outstandingOf(billId!));
        const baseH = baseForCash(toHalalas(amount), decision.rate, outstandingH);
        if (baseH == null) {
          throw new BusinessRuleError(422, {
            code: "settlement_wht_gross_ambiguous",
            error: `Statement line ${tx.id} paid ${amount.toFixed(2)}, net of withholding tax at ${(Number(decision.rate) * 100).toFixed(2)} %; two gross amounts a halala apart give that cash. Pay the bill from its pay dialog (the withholding is shown there), then reconcile this line to that payment.`,
            field: "billId",
          });
        }
        gross = fromHalalas(baseH!);
      }
      const paid = await payBill(billId!, { amount: gross, paidAt: tx.date, bankAccountId: tx.bankAccountId }, userId);
      if (toHalalas(paid.cashPaid) !== toHalalas(amount)) {
        // the invariant this path exists for: the books move exactly the cash the bank moved — or nothing is written
        throw new BusinessRuleError(409, {
          code: "settlement_cash_mismatch",
          error: `Settling bill ${billRow.billNumber ?? billId} from statement line ${tx.id} would move ${paid.cashPaid.toFixed(2)} of cash for a line of ${amount.toFixed(2)}. Nothing was recorded — pay the bill from its pay dialog, then reconcile the line to that payment.`,
          field: "billId",
        });
      }
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

    /**
     * 🔴 Phase 12B — a BILL settled from Review is reconciled explicitly to
     * the payment's cash line (the receipt side has always been reachable
     * through `payments.source_transaction_id`; the bill side had nothing but
     * an entry-number convention). One writer per effect: the pay path posted;
     * this only records which cash line the statement line IS.
     */
    if (billId != null) {
      const [bp] = await paymentsRepository.latestBillPayment(billId);
      const cash = bp?.journalEntryId != null ? await bankReconciliationRepository.cashLineOf(bp.journalEntryId, tx.bankAccountId) : [];
      if (cash.length !== 1) {
        throw new ConflictError(`The bill payment for statement line ${transactionId} has no single cash line on its bank; it cannot be reconciled.`);
      }
      await bankReconciliationService.link(transactionId, { lines: [{ journalLineId: cash[0]!.line_id, amount: Number(cash[0]!.amount) }] }, userId, "settlement", { billId, billPaymentId: bp!.id });
    }

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
