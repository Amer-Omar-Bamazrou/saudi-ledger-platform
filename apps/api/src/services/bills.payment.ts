/**
 * The ONE bill-payment path: Dr Accounts Payable / Cr the bank's own cash
 * account, recorded as a dated `bill_payments` row, under the bill's row lock,
 * against what the bill still owes by `billPosition`'s definition.
 *
 * Moved here UNCHANGED from `billsService.pay` (Phase 13C, 2026-09-24) so an
 * EXPENSE — a bill recorded as already paid — is paid at its approval by this
 * same function rather than by a second path to the same ledger effect (one
 * writer per effect). `billsService.pay` is the HTTP-facing wrapper; the
 * approval adapter calls this directly (it cannot import the service without
 * a cycle).
 */
import { BadRequestError, ConflictError, NotFoundError } from "../lib/errors";
import { assertNotReversedOpening } from "./accounting/openingReversed";
import { auditService } from "./audit.service";
import { postJournalEntry } from "./accounting/glPosting";
import { assertBankAccount } from "./accounting/bankIdentity";
import { billsRepository } from "../repositories/bills.repository";
import { paymentsRepository } from "../repositories/payments.repository";
import { businessToday } from "@workspace/shared";

export async function payBill(id: number, body: { amount: unknown; paidAt?: string; bankAccountId?: unknown }, _userId: number | null): Promise<void> {
    const { amount, paidAt } = body;

    const [existing] = await billsRepository.findById(id);
    if (!existing) throw new NotFoundError("Not found");

    // A bill must be approved (posted to AP) before it can be paid — a draft or
    // queued bill has no payable AP balance yet.
    if (existing.status === "draft" || existing.status === "submitted") {
      throw new ConflictError("Bill must be approved before it can be paid.");
    }
    if (existing.status === "paid") throw new ConflictError("Bill is already paid.");
    /**
     * 🔴 B7 — A CREDIT NOTE IS NOT PAYABLE. It is money the supplier owes US,
     * and a posted note's status is `received` like any other posted purchase
     * document, so without this the pay path would happily post Dr AP / Cr
     * cash against it: paying a document that reduces what we owe. The note's
     * balance leaves by being APPLIED to a bill, or by a refund.
     *
     * A DEBIT note is payable — it is an additional charge.
     */
    if (existing.documentType === "advance_invoice" || existing.documentType === "advance_credit_note") {
      throw new ConflictError(`${existing.billNumber} is a supplier ADVANCE document — the advance was paid before it existed, so there is nothing to pay. It is deducted by the supplier's final bill.`);
    }
    if (existing.documentType === "credit_note") {
      throw new ConflictError(
        `${existing.billNumber} is a supplier CREDIT note — it reduces what you owe, so it is not paid. Apply it to a bill instead.`,
      );
    }
    assertNotReversedOpening(existing, `Bill ${existing.billNumber}`, "paid");

    // Validate the amount up front — a missing/non-numeric amount previously
    // reached the numeric column and surfaced as an unhandled 500.
    const paid = Number(amount);
    if (!Number.isFinite(paid) || paid <= 0) {
      throw new BadRequestError("A positive payment amount is required.");
    }
    // 🔴 D-3 (2026-09-16): WHICH bank did the money move through? Checked at
    // the same boundary as the amount — before any balance arithmetic and
    // before any write — with the one shared rule (accounting/bankIdentity).
    const bankAccountId = await assertBankAccount(body.bankAccountId, { what: "the payment left from" });

    // M16.3: payments accumulate; a partial keeps the bill open (it must stay
    // in AP aging); overpay is refused. Mirrors invoices.service.pay — see the
    // note there.
    //
    // 🔴 Phase 11 Part 2: what the bill still owes is `billPosition`'s
    // definition, read under a row lock — NOT `total − paid_amount`. Money now
    // also reaches a bill through the AP subledger (a supplier payment, an
    // applied advance, an applied credit note); reading the legacy counter
    // alone accepted a full payment on a bill an advance had already settled,
    // and posted Dr AP twice for one debt.
    const alreadyPaid = Number(existing.paidAmount ?? 0);
    const outstanding = await billsRepository.outstandingOf(id, { lock: true });
    if (paid > outstanding + 0.005) {
      throw new ConflictError(
        `Payment of ${paid.toFixed(2)} exceeds the outstanding balance of ${outstanding.toFixed(2)} on this bill.`,
      );
    }
    const newPaid = Math.round((alreadyPaid + paid) * 100) / 100;
    const fullySettled = outstanding - paid < 0.01;

    const payDate = paidAt ?? businessToday();
    const [bill] = await billsRepository.update(id, {
      paidAmount: String(newPaid),
      paidAt: payDate,
      status: fullySettled ? "paid" : existing.status,
    });

    // B4 — the dated record of THIS payment (see invoices.service.pay).
    // 🔴 N3: recorded BEFORE the GL entry so its id makes the entry number
    // unique — `BILL-x-PAY` alone collided on the second partial payment.
    const payment = await paymentsRepository.recordBillPayment(id, paid, payDate, bankAccountId);

    // ── GL: Dr Accounts Payable / Cr <the bank's own cash account> ──
    const payEntry = await postJournalEntry({
      entryNumber: `BILL-${bill.billNumber}-PAY-${payment.id}`,
      date: payDate,
      description: `Payment to vendor for bill ${bill.billNumber}`,
      reference: bill.billNumber ?? undefined,
      lines: [
        { systemCode: "AP", accountName: "Accounts Payable", description: `Payment for ${bill.billNumber}`, debitAmount: paid, creditAmount: 0, party: bill.vendorId != null ? { type: "vendor" as const, vendorId: bill.vendorId } : { type: "none" as const, reason: "bill with no vendor record" } },
        { bankAccountId, description: `Payment for ${bill.billNumber}`, debitAmount: 0, creditAmount: paid },
      ],
    });

    // Phase 12B: the payment names its entry, so its cash line can be reconciled to the bank's statement line.
    await paymentsRepository.setBillPaymentEntry(payment.id, payEntry.id);
    await auditService.record({ action: "pay", entityType: "bill", entityId: id, before: existing, after: bill });
}
