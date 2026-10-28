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
 *
 * 🔴 Phase 16 (pack §2.4): a payment to a NON-RESIDENT supplier withholds tax
 * HERE, through `accounting/wht.ts` — Dr AP (the amount settled) / Cr bank
 * (that amount less the tax) / Cr WHT_PAYABLE (the tax). `bill_payments.amount`
 * and `bills.paid_amount` keep meaning what the SUPPLIER is credited with, so
 * `billPosition` is untouched; the bank line is the cash that actually left.
 */
import { createHash } from "node:crypto";
import { BadRequestError, BusinessRuleError, ConflictError, NotFoundError } from "../lib/errors";
import { pgErrorFields } from "../lib/dbRefusals";
import { assertDateString } from "../lib/writeGuards";
import { assertNotReversedOpening } from "./accounting/openingReversed";
import { auditService } from "./audit.service";
import { postJournalEntry } from "./accounting/glPosting";
import { assertBankAccount } from "./accounting/bankIdentity";
import { cashAfterWithholding, decideWithholding, recordWithholding, refuseLateWithholdingOnReentry, returnPeriodFor, whtDeclarationFrom, whtLine, whtOf, type WhtDecision } from "./accounting/wht";
import { billsRepository } from "../repositories/bills.repository";
import { paymentsRepository } from "../repositories/payments.repository";
import { businessToday } from "@workspace/shared";
import { fromHalalas, round2, toHalalas } from "../lib/money";

export interface BillPaymentResult {
  billPaymentId: number;
  journalEntryId: number;
  /** What the supplier was credited with (the AP settled). */
  amount: number;
  /** The cash that left the bank: amount − withheld. */
  cashPaid: number;
  withheld: number;
  withholding: WhtDecision;
}

/**
 * 🔴 G36-KEY — the request is a RETRY of a payment already recorded under its idempotency key. Thrown before
 * anything is written; `billsService.pay` answers it as the first request was answered (the bill as it now
 * stands), so the same key twice records ONE payment and posts cash once.
 */
export class BillPaymentReplay extends Error {
  constructor(readonly billPaymentId: number) {
    super(`Bill payment ${billPaymentId} replayed`);
  }
}

type PayBillBody = { amount: unknown; paidAt?: string; bankAccountId?: unknown; idempotencyKey?: unknown; whtPaymentType?: unknown; whtNotSubjectReason?: unknown; whtNotSubjectNote?: unknown; whtFiledMonthTreatment?: unknown; whtContractId?: unknown };

/** G36-KEY: the request a key was first used with — a retry must repeat it to be the SAME payment. */
function requestFingerprint(billId: number, body: PayBillBody): string {
  const n = (v: unknown) => (v === undefined || v === "" ? null : v);
  const parts: unknown[] = [billId, round2(Number(body.amount)), n(body.paidAt), Number(body.bankAccountId), n(body.whtPaymentType), n(body.whtNotSubjectReason), n(body.whtNotSubjectNote), n(body.whtFiledMonthTreatment)];
  // G4c-1: the contract decides who bears the tax, so it is part of the request — appended only when named, so a
  // key first used without one fingerprints exactly as before
  if (n(body.whtContractId) != null) parts.push(Number(body.whtContractId));
  return createHash("sha256")
    .update(JSON.stringify(parts))
    .digest("hex");
}

/** G36-KEY: a payment already recorded under the key — the same request replays; a different one is refused, nothing written. */
async function replayOrRefuse(idem: { key: string; fingerprint: string }): Promise<void> {
  const [prior] = await paymentsRepository.findBillPaymentByIdempotencyKey(idem.key);
  if (!prior) return;
  if (prior.requestFingerprint === idem.fingerprint) throw new BillPaymentReplay(prior.id);
  throw new BusinessRuleError(409, {
    code: "idempotency_key_reused",
    error: `Idempotency key "${idem.key}" was already used for a different payment (${prior.amount} on ${prior.paidAt}). Nothing was recorded; use a new key for a new payment.`,
  });
}

export async function payBill(
  id: number,
  body: PayBillBody,
  userId: number | null,
  /**
   * Q1 (pack §14.1): set ONLY by the WHT correction when this payment is the corrected RE-ENTRY — never from a
   * request. Its withholding names the correction, and a subsequent-period report lands in the correction's month.
   */
  opts: { correction?: { id: number; correctionPeriod: string; originalStatus?: string | null } } = {},
): Promise<BillPaymentResult> {
    const { amount, paidAt } = body;

    const [existing] = await billsRepository.findById(id);
    if (!existing) throw new NotFoundError("Not found");

    // 🔴 G36-KEY: a retry is recognised FIRST — before the status checks, so a retried payment that settled the
    // bill replays instead of answering "already paid" — and again under the bill's lock below.
    const key = typeof body.idempotencyKey === "string" && body.idempotencyKey.trim() ? body.idempotencyKey.trim() : null;
    const idem = key ? { key, fingerprint: requestFingerprint(id, body) } : null;
    if (idem) await replayOrRefuse(idem);

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
    // 🔴 G18: a stated payment date is a day that EXISTS, checked here like the amount — `paidAt` was never
    // validated, so `2026-02-31` reached `bills.paid_at` (text) and died as a raw 500 at `bill_payments.paid_at`
    // (a `date`). The same guard invoice pay uses. Omitted → today, unchanged.
    if (paidAt != null) assertDateString(paidAt, "paidAt");
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
    const outstanding = await billsRepository.outstandingOf(id, { lock: true });
    // G36-KEY: the same key sent twice at once — the twin that held this lock has committed; replay it.
    if (idem) await replayOrRefuse(idem);
    // 🔴 G36: the bill is RE-READ here, under that row lock. `paid_amount` used
    //    to come from `existing`, read before the lock, so a payment queued
    //    behind another one wrote `stale paid + its amount` over the first's
    //    increment — `paid_amount` ≠ Σ payments, the bill read as owing money it
    //    did not (reproduced, Phase 18 Batch 4B). Every payment of this bill
    //    holds this lock until it commits, so this read sees each one that
    //    committed first; one that left the bill fully paid gets the refusal
    //    it gets sequentially, and one that no longer fits, the overpay below.
    const [locked] = await billsRepository.findById(id);
    if (!locked) throw new NotFoundError("Not found");
    if (locked.status === "paid") throw new ConflictError("Bill is already paid.");
    const alreadyPaid = Number(locked.paidAmount ?? 0);
    if (paid > outstanding + 0.005) {
      throw new ConflictError(
        `Payment of ${paid.toFixed(2)} exceeds the outstanding balance of ${outstanding.toFixed(2)} on this bill.`,
      );
    }
    const newPaid = Math.round((alreadyPaid + paid) * 100) / 100;
    const fullySettled = outstanding - paid < 0.01;

    const payDate = paidAt ?? businessToday();
    // 🔴 Phase 16: decided BEFORE anything is written — a payment to a
    // non-resident whose nature is not declared is refused here, in words,
    // with nothing posted (wht.ts).
    const declared = whtDeclarationFrom(body as Record<string, unknown>);
    const withholding = await decideWithholding({
      vendorId: existing.vendorId, paymentDate: payDate, base: paid, currency: existing.currency,
      paymentClass: "bill_payment", // settling a bill is consideration: judged by its nature (Q2)
      declared,
    });
    refuseLateWithholdingOnReentry(withholding, opts.correction); // DR-45 (II): before anything is written
    // Q1: which month's return carries it — a FILED month is never changed silently (refused here, before any write)
    const reported = await returnPeriodFor(withholding, payDate, declared.filedMonthTreatment, { today: businessToday(), correctionPeriod: opts.correction?.correctionPeriod });
    const withheld = whtOf(withholding);
    const cashPaid = cashAfterWithholding(paid, withholding); // G4c-1: the full amount when the company bears the tax

    const [bill] = await billsRepository.update(id, {
      paidAmount: String(newPaid),
      paidAt: payDate,
      status: fullySettled ? "paid" : locked.status,
    });

    // B4 — the dated record of THIS payment (see invoices.service.pay).
    // 🔴 N3: recorded BEFORE the GL entry so its id makes the entry number
    // unique — `BILL-x-PAY` alone collided on the second partial payment.
    let payment;
    try {
      payment = await paymentsRepository.recordBillPayment(id, paid, payDate, bankAccountId, idem ?? undefined);
    } catch (err) {
      // G36-KEY: the key's unique index (0124) is the backstop for the one race the bill lock cannot see — the
      // same key on two DIFFERENT bills at once. Mapped, never an unmapped 23505.
      const pg = pgErrorFields(err);
      if (idem && pg.code === "23505" && pg.constraint === "bill_payments_idempotency_unq") {
        throw new BusinessRuleError(409, {
          code: "idempotency_key_in_flight",
          error: `A payment with idempotency key "${idem.key}" was recorded at the same moment. Nothing was recorded by this request; send it again to read that payment.`,
        });
      }
      throw err;
    }

    // ── GL: Dr Accounts Payable / Cr <the bank's own cash account> (/ Cr WHT_PAYABLE) ──
    const payEntry = await postJournalEntry({ sourceType: "bill_payment", sourceId: payment.id,
      entryNumber: `BILL-${bill.billNumber}-PAY-${payment.id}`,
      date: payDate,
      description: `Payment to vendor for bill ${bill.billNumber}`,
      reference: bill.billNumber ?? undefined,
      lines: [
        { systemCode: "AP", accountName: "Accounts Payable", description: `Payment for ${bill.billNumber}`, debitAmount: paid, creditAmount: 0, party: bill.vendorId != null ? { type: "vendor" as const, vendorId: bill.vendorId } : { type: "none" as const, reason: "bill with no vendor record" } },
        { bankAccountId, description: `Payment for ${bill.billNumber}`, debitAmount: 0, creditAmount: cashPaid },
        ...whtLine(withholding, `Withholding tax on payment for ${bill.billNumber}`),
      ],
    });

    // Phase 12B: the payment names its entry, so its cash line can be reconciled to the bank's statement line.
    await paymentsRepository.setBillPaymentEntry(payment.id, payEntry.id);
    // Phase 16: the withholding names the payment and its entry (after both exist — the database checks they are its own).
    await recordWithholding(withholding, { kind: "bill_payment", billPaymentId: payment.id, billId: id }, payDate, payEntry.id, userId, {
      returnPeriod: reported.returnPeriod, filedMonthTreatment: reported.filedMonthTreatment, correctionId: opts.correction?.id ?? null,
    });
    await auditService.record({ action: "pay", entityType: "bill", entityId: id, before: existing, after: { ...bill, withholding: withheld > 0 ? { amount: withheld, cashPaid } : null } });
    return { billPaymentId: payment.id, journalEntryId: payEntry.id, amount: paid, cashPaid, withheld, withholding };
}
