/**
 * D-4 / Batch 1B Part 1 (2026-09-17) — CUSTOMER PAYMENTS, ALLOCATIONS AND
 * CREDIT APPLICATION. The one writer for every customer-side cash effect.
 *
 * Decision record: docs/product/batch-1b-decision-pack.md (§1 credit
 * positions, §3 matching, §4 the three identities). What this file does:
 *
 *   receive()          Dr bank(leaf) / Cr AR(customer) for the allocated part
 *                      / Cr Customer deposits(customer) for the unapplied part.
 *                      One payment row, one journal entry, N allocations.
 *   allocate()         a LATER allocation of an unapplied amount:
 *                      Dr Customer deposits(customer) / Cr AR(customer).
 *   applyCreditNote()  a LATER application of a credit note's unconsumed
 *                      balance: Dr Customer credit balances / Cr AR.
 *   unallocate()       Phase A — the CORRECTION of an allocation: a superseding
 *                      record (never an edit or a delete) whose entry mirrors
 *                      the allocation's effect — Dr AR / Cr deposits (or Cr
 *                      credit balances) — restoring the source's availability
 *                      and the invoice's outstanding by exactly that amount.
 *   refund()           Phase C — a refund SETTLES an existing credit: Dr
 *                      deposits or credit balances / Cr bank leaf, naming the
 *                      receipt or the note whose balance it returns.
 *
 * What it refuses, by construction and not by convention:
 *   - a cash line without a bank (D-3, `assertBankAccount`);
 *   - an allocation beyond the invoice's outstanding (total − paid − credited)
 *     or beyond the payment's / note's remainder — both checked under a row
 *     lock, so two concurrent requests cannot both pass;
 *   - an allocation to another party's invoice (bank identity never implies
 *     the customer; the customer never implies the bank — §4);
 *   - an unapplied amount with no customer to owe it to;
 *   - a note or a draft as an allocation target; a credit note as a payment.
 *
 * Idempotency is the database's, not the client's: a repeated request with
 * the same key returns the first result; a concurrent duplicate is a 409.
 * VAT is decided nowhere here (customerCreditPolicy.ts explains why).
 */
import { BadRequestError, BusinessRuleError, ConflictError, NotFoundError } from "../lib/errors";
import { round2 } from "../lib/money";
import { assertDateString } from "../lib/writeGuards";
import { businessToday } from "@workspace/shared";
import { paymentsRepository, invoiceSettlementRepository } from "../repositories/payments.repository";
import { customersRepository } from "../repositories/customers.repository";
import { customerStatementRepository } from "../repositories/customerStatement.repository";
import { invoicesRepository } from "../repositories/invoices.repository";
import { journalEntriesRepository } from "../repositories/journalEntries.repository";
import { postJournalEntry, type GLLine, type GLParty } from "./accounting/glPosting";
import { assertBankAccount } from "./accounting/bankIdentity";
import { CUSTOMER_CREDIT_ACCOUNT, CUSTOMER_CREDIT_ACCOUNT_NAME } from "./accounting/customerCreditPolicy";
import { auditService } from "./audit.service";
import type { Payment, PaymentAllocation, PaymentAllocationReversal, CustomerRefund } from "@workspace/db";
import { isNoteType } from "./creditNotes";

export type AllocationInput = { invoiceId: number; amount: number };

export type ReceiveInput = {
  customerId?: number | null;
  amount: unknown;
  paidAt?: string | null;
  bankAccountId?: unknown;
  method?: string | null;
  reference?: string | null;
  idempotencyKey?: string | null;
  allocations?: AllocationInput[] | null;
  /** Which path recorded it. Default `manual` (POST /payments). */
  source?: "manual" | "invoice_pay" | "settlement";
  sourceTransactionId?: number | null;
};

export type PaymentOut = {
  id: number;
  direction: string;
  customerId: number | null;
  bankAccountId: number;
  amount: number;
  paidAt: string;
  method: string | null;
  reference: string | null;
  source: string;
  idempotencyKey: string | null;
  journalEntryId: number;
  sourceTransactionId: number | null;
  allocatedAmount: number;
  /** Phase C: Σ deposit refunds paid out of this receipt. */
  refundedAmount: number;
  /** amount − allocated − refunded: the customer's deposit still held from this receipt. */
  unappliedAmount: number;
  allocations: AllocationOut[];
  createdAt: string;
};

export type AllocationOut = {
  id: number;
  invoiceId: number;
  amount: number;
  journalEntryId: number | null;
  createdAt: string;
  /** Phase A: set when a superseding correction reversed this allocation; the row itself is untouched. */
  reversedBy: { id: number; journalEntryId: number; reason: string; createdAt: string } | null;
};

export type RefundOut = {
  id: number;
  customerId: number;
  bankAccountId: number;
  origin: "deposit" | "credit_note";
  paymentId: number | null;
  creditNoteId: number | null;
  amount: number;
  refundedAt: string;
  reason: string;
  reference: string | null;
  journalEntryId: number;
  idempotencyKey: string | null;
  createdAt: string;
};

const num = (v: unknown) => Number(v ?? 0);
const fmt = (n: number) => n.toFixed(2);
const TOL = 0.005;

function toAllocationOut(a: PaymentAllocation, r: PaymentAllocationReversal | null = null): AllocationOut {
  return {
    id: a.id,
    invoiceId: a.invoiceId,
    amount: num(a.amount),
    journalEntryId: a.journalEntryId ?? null,
    createdAt: a.createdAt.toISOString(),
    reversedBy: r ? { id: r.id, journalEntryId: r.journalEntryId, reason: r.reason, createdAt: r.createdAt.toISOString() } : null,
  };
}

function toRefundOut(f: CustomerRefund): RefundOut {
  return {
    id: f.id, customerId: f.customerId, bankAccountId: f.bankAccountId, origin: f.origin as "deposit" | "credit_note",
    paymentId: f.paymentId ?? null, creditNoteId: f.creditNoteId ?? null, amount: num(f.amount), refundedAt: f.refundedAt,
    reason: f.reason, reference: f.reference ?? null, journalEntryId: f.journalEntryId, idempotencyKey: f.idempotencyKey ?? null, createdAt: f.createdAt.toISOString(),
  };
}

/** A receipt's ACTIVE allocated total and what is still available (unapplied and not refunded). */
async function paymentAvailability(p: Payment): Promise<{ allocated: number; refunded: number; available: number }> {
  const allocated = round2((await paymentsRepository.allocatedTotals([p.id])).get(p.id) ?? 0);
  const refunded = round2(await paymentsRepository.refundedFrom({ paymentId: p.id }));
  return { allocated, refunded, available: round2(num(p.amount) - allocated - refunded) };
}

async function view(p: Payment): Promise<PaymentOut> {
  const rows = await paymentsRepository.allocationsOfPayment(p.id);
  const allocated = round2(rows.filter((r) => r.reversal == null).reduce((s, r) => s + num(r.alloc.amount), 0));
  const refunded = round2(await paymentsRepository.refundedFrom({ paymentId: p.id }));
  return {
    id: p.id,
    direction: p.direction,
    customerId: p.customerId ?? null,
    bankAccountId: p.bankAccountId,
    amount: num(p.amount),
    paidAt: p.paidAt,
    method: p.method ?? null,
    reference: p.reference ?? null,
    source: p.source,
    idempotencyKey: p.idempotencyKey ?? null,
    journalEntryId: p.journalEntryId,
    sourceTransactionId: p.sourceTransactionId ?? null,
    allocatedAmount: allocated,
    refundedAmount: refunded,
    unappliedAmount: round2(num(p.amount) - allocated - refunded),
    allocations: rows.map((r) => toAllocationOut(r.alloc, r.reversal)),
    createdAt: p.createdAt.toISOString(),
  };
}

/** Parse and sanity-check an allocation list: positive amounts, distinct invoices. */
function parseAllocations(raw: AllocationInput[] | null | undefined): AllocationInput[] {
  const list = (raw ?? []).map((a, i) => {
    const invoiceId = Number(a?.invoiceId);
    const amount = Number(a?.amount);
    if (!Number.isInteger(invoiceId) || invoiceId <= 0) throw new BadRequestError(`allocations[${i}].invoiceId must be a positive integer.`);
    if (!Number.isFinite(amount) || amount <= 0) throw new BadRequestError(`allocations[${i}].amount must be a positive number.`);
    return { invoiceId, amount: round2(amount) };
  });
  const seen = new Set<number>();
  for (const a of list) {
    if (seen.has(a.invoiceId)) {
      throw new BusinessRuleError(422, { error: `Invoice ${a.invoiceId} appears twice in the allocations — one line per invoice.`, code: "allocation_duplicate_invoice", field: "allocations" });
    }
    seen.add(a.invoiceId);
  }
  return list;
}

/**
 * Lock the target invoices and check each one can take its allocation:
 * exists in this tenant, is an invoice (not a note), is issued, belongs to
 * the paying party, and has the outstanding balance. Returns the locked
 * rows keyed by id. Every check is a 4xx that names the invoice.
 */
async function lockAndCheckTargets(
  allocations: AllocationInput[],
  party: { customerId: number | null },
  source: { paymentId?: number; creditNoteId?: number } = {},
): Promise<Map<number, Awaited<ReturnType<typeof invoiceSettlementRepository.lockInvoices>>[number]>> {
  const rows = await invoiceSettlementRepository.lockInvoices(allocations.map((a) => a.invoiceId));
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const a of allocations) {
    const inv = byId.get(a.invoiceId);
    // One ACTIVE allocation per (source, invoice) — checked under the source's
    // lock and the invoice's row lock (Phase A dropped the pair index so a
    // corrected allocation can be re-made to the same invoice).
    if (source.paymentId != null || source.creditNoteId != null) {
      const [dup] = await paymentsRepository.activeAllocationFor(source, a.invoiceId);
      if (dup) {
        throw new ConflictError(
          `${source.paymentId != null ? `Payment ${source.paymentId}` : "This credit note"} is already allocated to invoice ${a.invoiceId} (allocation ${dup.id}). ` +
            "One active allocation per (source, invoice); correct the existing one first, or record a further amount on a new receipt.",
        );
      }
    }
    if (!inv) {
      // RLS hides another tenant's invoice, so "not found" and "not yours" are the same refusal — no existence oracle.
      throw new BusinessRuleError(422, { error: `Invoice ${a.invoiceId} does not exist for this organization.`, code: "reference_not_found", field: "allocations" });
    }
    if (isNoteType(inv.documentType)) {
      throw new ConflictError(`${inv.invoiceNumber} is a credit or debit note and cannot be settled by a payment. A credit note is applied to an invoice; it is never paid.`);
    }
    if (inv.status === "draft" || inv.status === "submitted" || inv.status === "rejected" || inv.invoiceHash == null) {
      throw new ConflictError(`Invoice ${inv.invoiceNumber} has not been issued (status: ${inv.status}); only an issued invoice has a receivable to settle.`);
    }
    if ((inv.customerId ?? null) !== party.customerId) {
      throw new BusinessRuleError(422, {
        error:
          inv.customerId == null
            ? `Invoice ${inv.invoiceNumber} has no identified customer (a simplified/B2C invoice); a payment recorded for a customer cannot settle it.`
            : `Invoice ${inv.invoiceNumber} belongs to a different customer than this payment. A payment settles its own customer's invoices only.`,
        code: "allocation_party_mismatch",
        field: "allocations",
      });
    }
    const outstanding = round2(num(inv.total) - num(inv.paidAmount) - num(inv.creditedAmount));
    if (a.amount > outstanding + TOL) {
      throw new ConflictError(
        `Allocation of ${fmt(a.amount)} to ${inv.invoiceNumber} exceeds its outstanding balance of ${fmt(outstanding)}. ` +
          "Allocate up to the outstanding amount; anything beyond it stays on the customer's deposit.",
      );
    }
  }
  return byId;
}

/** Write the allocation rows and move the invoice caches — one place, both caches. */
async function writeAllocations(
  allocations: AllocationInput[],
  targets: Map<number, { id: number; total: string; paidAmount: string | null; creditedAmount: string; status: string }>,
  ref: { paymentId?: number; creditNoteId?: number; journalEntryId: number | null; idempotencyKey?: string | null; createdBy: number | null; paidAt?: string; ids?: number[] },
): Promise<PaymentAllocation[]> {
  const out: PaymentAllocation[] = [];
  for (const [i, a] of allocations.entries()) {
    const row = await paymentsRepository.insertAllocation({
      ...(ref.ids ? { id: ref.ids[i]! } : {}),
      paymentId: ref.paymentId ?? null,
      creditNoteId: ref.creditNoteId ?? null,
      invoiceId: a.invoiceId,
      amount: fmt(a.amount),
      journalEntryId: ref.journalEntryId,
      // The key marks the FIRST row only: the index is per key, and one request is one act.
      idempotencyKey: i === 0 ? (ref.idempotencyKey ?? null) : null,
      createdBy: ref.createdBy,
    });
    out.push(row);
    const inv = targets.get(a.invoiceId)!;
    const outstandingAfter = round2(num(inv.total) - num(inv.paidAmount) - num(inv.creditedAmount) - a.amount);
    // Status flips to `paid` on CASH settlement (the existing rule). A credit
    // note that settles the remainder leaves the status alone — "paid" says
    // money arrived, and here none did.
    const settledByCash = ref.paymentId != null && outstandingAfter < 0.01;
    await invoiceSettlementRepository.bumpSettled(
      a.invoiceId,
      ref.paymentId != null ? { paid: a.amount } : { credited: a.amount },
      ref.paidAt,
      settledByCash ? "paid" : undefined,
    );
  }
  return out;
}

function partyOf(customerId: number | null): GLParty {
  return customerId != null ? { type: "customer", customerId } : { type: "none", reason: "simplified/B2C invoice — no identified customer" };
}

/** The Postgres error behind a failed query — Drizzle wraps it as `cause`. */
function pgError(err: unknown): { code?: string; constraint?: string } {
  const e = err as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } };
  return e?.cause && typeof e.cause === "object" ? e.cause : e;
}

/** A Postgres unique violation on the idempotency index → the request's twin won the race. */
function isIdempotencyRace(err: unknown): boolean {
  const e = pgError(err);
  return e?.code === "23505" && /idempotency/.test(e.constraint ?? "");
}

export const paymentsService = {
  /**
   * Record a customer receipt. Allocations are optional: none ⇒ the whole
   * amount is a deposit; some ⇒ the rest is; all ⇒ the invoice(s) settle.
   * The API never refuses a receipt for being larger than the invoices —
   * it refuses an ALLOCATION beyond an invoice's outstanding (§1.3 (3)).
   */
  async receive(body: ReceiveInput, userId: number | null): Promise<PaymentOut> {
    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw new BadRequestError("A positive payment amount is required.");
    const rounded = round2(amount);
    const paidAt = body.paidAt ? assertDateString(body.paidAt, "paidAt") : businessToday();
    const bankAccountId = await assertBankAccount(body.bankAccountId, { what: "the payment arrived in" });
    const idempotencyKey = body.idempotencyKey?.trim() || null;
    const source = body.source ?? "manual";

    if (idempotencyKey) {
      const [existing] = await paymentsRepository.findPaymentByIdempotencyKey(idempotencyKey);
      if (existing) {
        if (num(existing.amount) !== rounded || (existing.customerId ?? null) !== (body.customerId ?? null) || existing.bankAccountId !== bankAccountId) {
          throw new ConflictError(`Idempotency key "${idempotencyKey}" was already used for a different payment (${fmt(num(existing.amount))} on ${existing.paidAt}). Use a new key.`);
        }
        return view(existing);
      }
    }

    const allocations = parseAllocations(body.allocations);
    const allocated = round2(allocations.reduce((s, a) => s + a.amount, 0));
    if (allocated > rounded + TOL) {
      throw new BusinessRuleError(422, { error: `Allocations total ${fmt(allocated)} but the payment is ${fmt(rounded)}. Allocate at most the amount received.`, code: "allocation_exceeds_payment", field: "allocations" });
    }
    const unapplied = round2(rounded - allocated);

    const customerId = body.customerId != null ? Number(body.customerId) : null;
    if (customerId != null) {
      if (!Number.isInteger(customerId) || customerId <= 0) throw new BadRequestError("customerId must be a positive integer.");
      const [cust] = await customersRepository.findById(customerId);
      if (!cust) throw new BusinessRuleError(422, { error: "Unknown customer for this organization", code: "reference_not_found", field: "customerId" });
    }
    if (customerId == null && unapplied > 0) {
      // A deposit is owed TO someone. With no customer there is nobody to owe it to — refuse rather than park it.
      throw new BusinessRuleError(422, {
        error: `${fmt(unapplied)} of this receipt is not allocated to any invoice and the receipt names no customer. Name the customer the money came from, or allocate the full amount to identified invoices.`,
        code: "customer_required_for_unapplied",
        field: "customerId",
      });
    }

    const targets = await lockAndCheckTargets(allocations, { customerId });

    const party = partyOf(customerId);
    const paymentId = await paymentsRepository.nextPaymentId();
    const single = allocations.length === 1 ? targets.get(allocations[0]!.invoiceId)! : null;
    const entryNumber = single ? `GL-${single.invoiceNumber}-RCPT-${paymentId}` : `RCPT-${paymentId}`;
    const description = single ? `Payment received for invoice ${single.invoiceNumber}` : allocations.length > 1 ? `Payment received against ${allocations.length} invoices` : "Payment received on account";
    const lines: GLLine[] = [{ bankAccountId, description, debitAmount: rounded, creditAmount: 0 }];
    if (allocated > 0) {
      lines.push({ systemCode: "AR", accountName: "Accounts Receivable", description, debitAmount: 0, creditAmount: allocated, party });
    }
    if (unapplied > 0) {
      lines.push({ systemCode: CUSTOMER_CREDIT_ACCOUNT.deposit, accountName: CUSTOMER_CREDIT_ACCOUNT_NAME.deposit, description: "Receipt on account — not yet allocated", debitAmount: 0, creditAmount: unapplied, party });
    }
    const je = await postJournalEntry({ entryNumber, date: paidAt, description, reference: single?.invoiceNumber ?? body.reference ?? undefined, lines });

    let payment: Payment;
    try {
      payment = await paymentsRepository.insertPayment({
        id: paymentId,
        direction: "in",
        partyType: customerId != null ? "customer" : "none",
        customerId,
        bankAccountId,
        amount: fmt(rounded),
        paidAt,
        method: body.method?.trim() || null,
        reference: body.reference?.trim() || null,
        idempotencyKey,
        source,
        journalEntryId: je.id,
        sourceTransactionId: body.sourceTransactionId ?? null,
        createdBy: userId,
      });
    } catch (err) {
      if (isIdempotencyRace(err)) throw new ConflictError(`A payment with idempotency key "${idempotencyKey}" was recorded concurrently. Retry the request to read it.`);
      throw err;
    }

    const rows = await writeAllocations(allocations, targets, { paymentId, journalEntryId: null, createdBy: userId, paidAt });

    const out = await view(payment);
    await auditService.record({ action: "create", entityType: "payment", entityId: payment.id, after: { ...out, allocationIds: rows.map((r) => r.id) } });
    if (unapplied > 0) {
      await auditService.record({ action: "unapplied", entityType: "payment", entityId: payment.id, after: { customerId, unappliedAmount: unapplied, journalEntryId: je.id } });
    }
    return out;
  },

  /** A later allocation of a payment's unapplied remainder: Dr Customer deposits / Cr AR. */
  async allocate(paymentId: number, body: { allocations?: AllocationInput[] | null; idempotencyKey?: string | null }, userId: number | null): Promise<PaymentOut> {
    const idempotencyKey = body.idempotencyKey?.trim() || null;
    if (idempotencyKey) {
      const [existing] = await paymentsRepository.findAllocationByIdempotencyKey(idempotencyKey);
      if (existing) {
        if (existing.paymentId !== paymentId) throw new ConflictError(`Idempotency key "${idempotencyKey}" was already used for a different allocation. Use a new key.`);
        const [p] = await paymentsRepository.findPaymentById(paymentId);
        return view(p!);
      }
    }
    const [payment] = await paymentsRepository.lockPayment(paymentId);
    if (!payment) throw new NotFoundError("Payment not found");
    if (payment.direction !== "in") throw new ConflictError("Only a receipt can be allocated to invoices.");

    const allocations = parseAllocations(body.allocations);
    if (allocations.length === 0) throw new BadRequestError("At least one allocation is required.");
    const { available: unapplied } = await paymentAvailability(payment);
    const requested = round2(allocations.reduce((s, a) => s + a.amount, 0));
    if (requested > unapplied + TOL) {
      throw new BusinessRuleError(422, { error: `Allocations total ${fmt(requested)} but only ${fmt(unapplied)} of payment ${paymentId} is unapplied.`, code: "allocation_exceeds_payment", field: "allocations" });
    }

    const targets = await lockAndCheckTargets(allocations, { customerId: payment.customerId ?? null }, { paymentId });
    const party = partyOf(payment.customerId ?? null);
    const ids: number[] = [];
    for (let i = 0; i < allocations.length; i++) ids.push(await paymentsRepository.nextAllocationId());
    const je = await postJournalEntry({
      entryNumber: `ALLOC-${ids[0]}`,
      date: businessToday(),
      description: `Allocation of receipt ${paymentId} to ${allocations.length === 1 ? targets.get(allocations[0]!.invoiceId)!.invoiceNumber : `${allocations.length} invoices`}`,
      reference: payment.reference ?? undefined,
      lines: [
        { systemCode: CUSTOMER_CREDIT_ACCOUNT.deposit, accountName: CUSTOMER_CREDIT_ACCOUNT_NAME.deposit, description: `Deposit applied from receipt ${paymentId}`, debitAmount: requested, creditAmount: 0, party },
        { systemCode: "AR", accountName: "Accounts Receivable", description: `Deposit applied from receipt ${paymentId}`, debitAmount: 0, creditAmount: requested, party },
      ],
    });
    let rows: PaymentAllocation[];
    try {
      rows = await writeAllocations(allocations, targets, { paymentId, journalEntryId: je.id, idempotencyKey, createdBy: userId, paidAt: payment.paidAt, ids });
    } catch (err) {
      if (isIdempotencyRace(err)) throw new ConflictError(`Allocation "${idempotencyKey}" was recorded concurrently. Retry the request to read it.`);
      throw err;
    }
    const out = await view(payment);
    await auditService.record({ action: "allocate", entityType: "payment", entityId: paymentId, after: { journalEntryId: je.id, allocations: rows.map((a) => toAllocationOut(a)), unappliedAfter: out.unappliedAmount } });
    return out;
  },

  /**
   * Apply a credit note's unconsumed balance to other invoices of the same
   * customer: Dr Customer credit balances / Cr AR. The note is not touched
   * (its own entry adjusted revenue and VAT at issue); the application is a
   * separate, dated, auditable act.
   */
  async applyCreditNote(noteId: number, body: { allocations?: AllocationInput[] | null; idempotencyKey?: string | null }, userId: number | null) {
    const idempotencyKey = body.idempotencyKey?.trim() || null;
    if (idempotencyKey) {
      const [existing] = await paymentsRepository.findAllocationByIdempotencyKey(idempotencyKey);
      if (existing) {
        if (existing.creditNoteId !== noteId) throw new ConflictError(`Idempotency key "${idempotencyKey}" was already used for a different application. Use a new key.`);
        return this.creditNoteApplications(noteId);
      }
    }
    const [note] = await invoiceSettlementRepository.lockInvoices([noteId]);
    if (!note) throw new NotFoundError("Credit note not found");
    if (note.documentType !== "credit_note") throw new ConflictError(`${note.invoiceNumber} is not a credit note.`);
    if (note.invoiceHash == null) throw new ConflictError(`Credit note ${note.invoiceNumber} has not been issued; only an approved note carries a credit.`);
    if (note.customerId == null) {
      throw new BusinessRuleError(422, { error: `Credit note ${note.invoiceNumber} has no identified customer, so its balance cannot be applied to a customer's invoices.`, code: "credit_note_no_customer", field: "id" });
    }
    const allocations = parseAllocations(body.allocations);
    if (allocations.length === 0) throw new BadRequestError("At least one allocation is required.");
    if (allocations.some((a) => a.invoiceId === noteId)) throw new ConflictError("A credit note cannot be applied to itself.");
    const consumed = round2((await paymentsRepository.allocationsOfCreditNote(noteId)).filter((r) => r.reversal == null).reduce((s, r) => s + num(r.alloc.amount), 0));
    const refunded = round2(await paymentsRepository.refundedFrom({ creditNoteId: noteId }));
    const remaining = round2(num(note.total) - consumed - refunded);
    const requested = round2(allocations.reduce((s, a) => s + a.amount, 0));
    if (requested > remaining + TOL) {
      throw new BusinessRuleError(422, { error: `Applications total ${fmt(requested)} but only ${fmt(remaining)} of credit note ${note.invoiceNumber} remains unapplied.`, code: "allocation_exceeds_credit", field: "allocations" });
    }
    const targets = await lockAndCheckTargets(allocations, { customerId: note.customerId }, { creditNoteId: noteId });
    const party = partyOf(note.customerId);
    const ids: number[] = [];
    for (let i = 0; i < allocations.length; i++) ids.push(await paymentsRepository.nextAllocationId());
    const je = await postJournalEntry({
      entryNumber: `GL-${note.invoiceNumber}-APP-${ids[0]}`,
      date: businessToday(),
      description: `Credit note ${note.invoiceNumber} applied to ${allocations.length === 1 ? targets.get(allocations[0]!.invoiceId)!.invoiceNumber : `${allocations.length} invoices`}`,
      reference: note.invoiceNumber,
      lines: [
        { systemCode: CUSTOMER_CREDIT_ACCOUNT.credit_note, accountName: CUSTOMER_CREDIT_ACCOUNT_NAME.credit_note, description: `Credit note ${note.invoiceNumber} applied`, debitAmount: requested, creditAmount: 0, party },
        { systemCode: "AR", accountName: "Accounts Receivable", description: `Credit note ${note.invoiceNumber} applied`, debitAmount: 0, creditAmount: requested, party },
      ],
    });
    let rows: PaymentAllocation[];
    try {
      rows = await writeAllocations(allocations, targets, { creditNoteId: noteId, journalEntryId: je.id, idempotencyKey, createdBy: userId, ids });
    } catch (err) {
      if (isIdempotencyRace(err)) throw new ConflictError(`Application "${idempotencyKey}" was recorded concurrently. Retry the request to read it.`);
      throw err;
    }
    await auditService.record({ action: "apply", entityType: "credit_note", entityId: noteId, after: { journalEntryId: je.id, allocations: rows.map((a) => toAllocationOut(a)), remainingAfter: round2(remaining - requested) } });
    return this.creditNoteApplications(noteId);
  },

  /** A credit note's applications and remaining balance. */
  async creditNoteApplications(noteId: number) {
    const [n] = await invoicesRepository.findById(noteId);
    if (!n || n.documentType !== "credit_note") throw new NotFoundError("Credit note not found");
    const rows = await paymentsRepository.allocationsOfCreditNote(noteId);
    const applied = round2(rows.filter((r) => r.reversal == null).reduce((s, r) => s + num(r.alloc.amount), 0));
    const refunded = round2(await paymentsRepository.refundedFrom({ creditNoteId: noteId }));
    return {
      creditNoteId: noteId, invoiceNumber: n.invoiceNumber, total: num(n.total), appliedAmount: applied, refundedAmount: refunded,
      remainingAmount: round2(num(n.total) - applied - refunded), applications: rows.map((r) => toAllocationOut(r.alloc, r.reversal)),
    };
  },

  async get(id: number): Promise<PaymentOut> {
    const [p] = await paymentsRepository.findPaymentById(id);
    if (!p) throw new NotFoundError("Payment not found");
    return view(p);
  },

  async list(filter: { customerId?: number; limit?: number; offset?: number }): Promise<PaymentOut[]> {
    const rows = await paymentsRepository.listPayments({ customerId: filter.customerId, limit: Math.min(200, Math.max(1, filter.limit ?? 50)), offset: Math.max(0, filter.offset ?? 0) });
    const out: PaymentOut[] = [];
    for (const p of rows) out.push(await view(p));
    return out;
  },

  /**
   * Phase A — CORRECT AN ALLOCATION with a superseding record. The original
   * allocation is not edited or deleted: a `payment_allocation_reversals` row
   * names it (UNIQUE — one correction, concurrent attempts serialise into one
   * success and one 409), and a new entry mirrors the allocation's own effect:
   *   payment allocation  Dr AR(customer) / Cr Customer deposits(customer)
   *   credit application  Dr AR(customer) / Cr Customer credit balances(customer)
   * dated today, period-controlled, party-correct. The source's availability
   * and the invoice's outstanding return by exactly the allocation's amount.
   */
  async unallocate(allocationId: number, body: { reason?: string | null; idempotencyKey?: string | null }, userId: number | null) {
    const reason = body.reason?.trim();
    if (!reason) throw new BadRequestError("A reason for the correction is required.");
    const idempotencyKey = body.idempotencyKey?.trim() || null;
    if (idempotencyKey) {
      const [existing] = await paymentsRepository.findReversalByIdempotencyKey(idempotencyKey);
      if (existing) {
        if (existing.allocationId !== allocationId) throw new ConflictError(`Idempotency key "${idempotencyKey}" was already used for a different correction. Use a new key.`);
        return this.allocation(allocationId);
      }
    }
    const [found] = await paymentsRepository.findAllocation(allocationId);
    if (!found) throw new NotFoundError("Allocation not found");
    const { alloc } = found;
    if (found.reversal) {
      throw new BusinessRuleError(409, { error: `Allocation ${allocationId} was already corrected by correction ${found.reversal.id} on ${found.reversal.createdAt.toISOString().slice(0, 10)}.`, code: "allocation_already_corrected", field: "id" });
    }

    // Serialise on the SOURCE (the same locks allocation takes), then the invoice.
    let customerId: number | null;
    let origin: "deposit" | "credit_note";
    let noteNumber: string | null = null;
    if (alloc.paymentId != null) {
      const [payment] = await paymentsRepository.lockPayment(alloc.paymentId);
      if (!payment) throw new NotFoundError("Payment not found");
      customerId = payment.customerId ?? null;
      origin = "deposit";
    } else {
      const [note] = await invoiceSettlementRepository.lockInvoices([alloc.creditNoteId!]);
      if (!note) throw new NotFoundError("Credit note not found");
      // The note's own settlement of its ORIGINAL is the tax document's effect
      // (Art. 54: the note references that invoice); it is corrected by a new
      // note or a debit note, never by unapplying it here.
      if (note.originalInvoiceId === alloc.invoiceId && alloc.journalEntryId != null) {
        const [entry] = await journalEntriesRepository.findById(alloc.journalEntryId);
        if (entry && entry.entryNumber === `GL-${note.invoiceNumber}`) {
          throw new BusinessRuleError(409, {
            error: `Credit note ${note.invoiceNumber} settles invoice ${alloc.invoiceId} as its original — that is the tax document's own effect and cannot be unapplied. Issue a debit note or a further credit note to correct it.`,
            code: "credit_note_original_application_immutable",
            field: "id",
          });
        }
      }
      customerId = note.customerId ?? null;
      origin = "credit_note";
      noteNumber = note.invoiceNumber;
    }
    if (customerId == null) {
      throw new BusinessRuleError(422, { error: "This allocation belongs to a receipt with no identified customer; unapplying it would leave money owed to nobody. Identify the customer first.", code: "customer_required_for_unapplied", field: "id" });
    }
    const [inv] = await invoiceSettlementRepository.lockInvoices([alloc.invoiceId]);
    if (!inv) throw new NotFoundError("Invoice not found");

    const amount = round2(num(alloc.amount));
    const party = partyOf(customerId);
    const reversalId = await paymentsRepository.nextReversalId();
    const account = CUSTOMER_CREDIT_ACCOUNT[origin];
    const accountName = CUSTOMER_CREDIT_ACCOUNT_NAME[origin];
    const what = origin === "deposit" ? `receipt ${alloc.paymentId}` : `credit note ${noteNumber}`;
    const je = await postJournalEntry({
      entryNumber: `UNALLOC-${reversalId}`,
      date: businessToday(),
      description: `Correction: allocation ${allocationId} of ${what} to ${inv.invoiceNumber} unapplied — ${reason}`,
      reference: inv.invoiceNumber,
      lines: [
        { systemCode: "AR", accountName: "Accounts Receivable", description: `Allocation ${allocationId} unapplied`, debitAmount: amount, creditAmount: 0, party },
        { systemCode: account, accountName, description: `Allocation ${allocationId} unapplied — back on ${accountName.toLowerCase()}`, debitAmount: 0, creditAmount: amount, party },
      ],
    });
    let reversal: PaymentAllocationReversal;
    try {
      reversal = await paymentsRepository.insertReversal({ id: reversalId, allocationId, amount: fmt(amount), journalEntryId: je.id, reason, idempotencyKey, createdBy: userId });
    } catch (err) {
      const e = pgError(err);
      if (e?.code === "23505" && e.constraint === "payment_allocation_reversals_allocation_unq") {
        throw new BusinessRuleError(409, { error: `Allocation ${allocationId} was corrected concurrently by another request.`, code: "allocation_already_corrected", field: "id" });
      }
      if (isIdempotencyRace(err)) throw new ConflictError(`Correction "${idempotencyKey}" was recorded concurrently. Retry the request to read it.`);
      throw err;
    }
    // The caches move back by exactly this allocation; a cash-settled invoice reopens.
    const outstandingAfter = round2(num(inv.total) - num(inv.paidAmount) - num(inv.creditedAmount) + amount);
    await invoiceSettlementRepository.bumpSettled(
      alloc.invoiceId,
      origin === "deposit" ? { paid: -amount } : { credited: -amount },
      undefined,
      inv.status === "paid" && outstandingAfter > 0.005 ? "sent" : undefined,
    );
    await auditService.record({
      action: "unallocate",
      entityType: "payment_allocation",
      entityId: allocationId,
      before: { invoiceId: alloc.invoiceId, amount, paymentId: alloc.paymentId, creditNoteId: alloc.creditNoteId },
      after: { reversalId: reversal.id, journalEntryId: je.id, reason, customerId, origin },
    });
    return this.allocation(allocationId);
  },

  /** One allocation with its correction, if any. */
  async allocation(id: number): Promise<AllocationOut & { paymentId: number | null; creditNoteId: number | null }> {
    const [found] = await paymentsRepository.findAllocation(id);
    if (!found) throw new NotFoundError("Allocation not found");
    return { ...toAllocationOut(found.alloc, found.reversal), paymentId: found.alloc.paymentId ?? null, creditNoteId: found.alloc.creditNoteId ?? null };
  },

  /**
   * Phase C — REFUND A CUSTOMER CREDIT. Settles an existing balance; never
   * reverses the receipt or the note. The origin names a specific source:
   * `deposit` → the receipt whose unapplied remainder is returned;
   * `credit_note` → the issued note whose unconsumed balance is returned.
   * Journal: Dr the origin's liability(customer) / Cr the bank leaf.
   *
   * VAT: nothing is posted or altered. A credit note carried its VAT
   * adjustment at issue; a note that is NOT issued has no tax effect and is
   * refused (the refund would settle a credit that does not exist for VAT).
   * A deposit cannot have been tax-invoiced through this platform — no
   * advance-invoice document exists — so no credit-note step is owed
   * before returning it; when advance invoices exist (D-7) this is where
   * that precondition goes.
   */
  async refund(
    body: { customerId: unknown; origin: unknown; paymentId?: unknown; creditNoteId?: unknown; amount: unknown; bankAccountId?: unknown; refundedAt?: string | null; reason?: string | null; reference?: string | null; idempotencyKey?: string | null },
    userId: number | null,
  ): Promise<RefundOut> {
    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw new BadRequestError("A positive refund amount is required.");
    const rounded = round2(amount);
    const reason = body.reason?.trim();
    if (!reason) throw new BadRequestError("A reason for the refund is required.");
    const origin = body.origin;
    if (origin !== "deposit" && origin !== "credit_note") throw new BadRequestError('origin must be "deposit" or "credit_note".');
    const customerId = Number(body.customerId);
    if (!Number.isInteger(customerId) || customerId <= 0) throw new BadRequestError("customerId must be a positive integer.");
    const refundedAt = body.refundedAt ? assertDateString(body.refundedAt, "refundedAt") : businessToday();
    const bankAccountId = await assertBankAccount(body.bankAccountId, { what: "the refund is paid from" });
    const idempotencyKey = body.idempotencyKey?.trim() || null;
    if (idempotencyKey) {
      const [existing] = await paymentsRepository.findRefundByIdempotencyKey(idempotencyKey);
      if (existing) {
        if (num(existing.amount) !== rounded || existing.customerId !== customerId || existing.origin !== origin) {
          throw new ConflictError(`Idempotency key "${idempotencyKey}" was already used for a different refund. Use a new key.`);
        }
        return toRefundOut(existing);
      }
    }
    const [cust] = await customersRepository.findById(customerId);
    if (!cust) throw new BusinessRuleError(422, { error: "Unknown customer for this organization", code: "reference_not_found", field: "customerId" });

    let paymentId: number | null = null;
    let creditNoteId: number | null = null;
    let available: number;
    let sourceLabel: string;
    if (origin === "deposit") {
      paymentId = Number(body.paymentId);
      if (!Number.isInteger(paymentId) || paymentId <= 0) throw new BadRequestError("paymentId must name the receipt whose deposit is refunded.");
      const [payment] = await paymentsRepository.lockPayment(paymentId);
      if (!payment) throw new BusinessRuleError(422, { error: `Receipt ${paymentId} does not exist for this organization.`, code: "reference_not_found", field: "paymentId" });
      if (payment.direction !== "in" || (payment.customerId ?? null) !== customerId) {
        throw new BusinessRuleError(422, { error: `Receipt ${paymentId} is not a receipt from this customer.`, code: "refund_source_mismatch", field: "paymentId" });
      }
      available = (await paymentAvailability(payment)).available;
      sourceLabel = `receipt ${paymentId}`;
    } else {
      creditNoteId = Number(body.creditNoteId);
      if (!Number.isInteger(creditNoteId) || creditNoteId <= 0) throw new BadRequestError("creditNoteId must name the credit note whose balance is refunded.");
      const [note] = await invoiceSettlementRepository.lockInvoices([creditNoteId]);
      if (!note || note.documentType !== "credit_note") throw new BusinessRuleError(422, { error: `Credit note ${creditNoteId} does not exist for this organization.`, code: "reference_not_found", field: "creditNoteId" });
      if ((note.customerId ?? null) !== customerId) {
        throw new BusinessRuleError(422, { error: `Credit note ${note.invoiceNumber} does not belong to this customer.`, code: "refund_source_mismatch", field: "creditNoteId" });
      }
      if (note.invoiceHash == null) {
        // Tax safety: an unissued note has no VAT effect; refunding its "balance" would settle a credit that does not exist.
        throw new BusinessRuleError(409, { error: `Credit note ${note.invoiceNumber} has not been issued. Issue the credit note (the tax document) first; only an issued note carries a refundable balance.`, code: "credit_note_not_issued", field: "creditNoteId" });
      }
      const consumed = round2((await paymentsRepository.allocationsOfCreditNote(creditNoteId)).filter((r) => r.reversal == null).reduce((s, r) => s + num(r.alloc.amount), 0));
      const refunded = round2(await paymentsRepository.refundedFrom({ creditNoteId }));
      available = round2(num(note.total) - consumed - refunded);
      sourceLabel = `credit note ${note.invoiceNumber}`;
    }
    if (rounded > available + TOL) {
      throw new BusinessRuleError(422, { error: `Refund of ${fmt(rounded)} exceeds the refundable balance of ${fmt(available)} on ${sourceLabel}.`, code: "refund_exceeds_balance", field: "amount" });
    }

    const party = partyOf(customerId);
    const refundId = await paymentsRepository.nextRefundId();
    const je = await postJournalEntry({
      entryNumber: `REFUND-${refundId}`,
      date: refundedAt,
      description: `Refund to ${cust.name} of ${sourceLabel} — ${reason}`,
      reference: body.reference?.trim() || undefined,
      lines: [
        { systemCode: CUSTOMER_CREDIT_ACCOUNT[origin], accountName: CUSTOMER_CREDIT_ACCOUNT_NAME[origin], description: `Refund of ${sourceLabel}`, debitAmount: rounded, creditAmount: 0, party },
        { bankAccountId, description: `Refund to ${cust.name}`, debitAmount: 0, creditAmount: rounded },
      ],
    });
    let refund: CustomerRefund;
    try {
      refund = await paymentsRepository.insertRefund({
        id: refundId, customerId, bankAccountId, origin, paymentId, creditNoteId, amount: fmt(rounded), refundedAt, reason,
        reference: body.reference?.trim() || null, journalEntryId: je.id, idempotencyKey, createdBy: userId,
      });
    } catch (err) {
      if (isIdempotencyRace(err)) throw new ConflictError(`A refund with idempotency key "${idempotencyKey}" was recorded concurrently. Retry the request to read it.`);
      throw err;
    }
    const out = toRefundOut(refund);
    await auditService.record({ action: "refund", entityType: "customer_refund", entityId: refund.id, after: { ...out, availableBefore: available, availableAfter: round2(available - rounded) } });
    return out;
  },

  async getRefund(id: number): Promise<RefundOut> {
    const [f] = await paymentsRepository.findRefundById(id);
    if (!f) throw new NotFoundError("Refund not found");
    return toRefundOut(f);
  },

  async listRefunds(filter: { customerId?: number; limit?: number; offset?: number }): Promise<RefundOut[]> {
    const rows = await paymentsRepository.listRefunds({ customerId: filter.customerId, limit: Math.min(200, Math.max(1, filter.limit ?? 50)), offset: Math.max(0, filter.offset ?? 0) });
    return rows.map(toRefundOut);
  },

  /**
   * A customer's credit position — deposits and credit-note balances, shown
   * apart. Phase E: read from the ONE position definition
   * (`customerStatementRepository.positions`), the same figures the customer
   * row, the statement and the ageing report carry.
   */
  async customerCredits(customerId: number) {
    const [cust] = await customersRepository.findById(customerId);
    if (!cust) throw new NotFoundError("Customer not found");
    const [pos] = await customerStatementRepository.positions({ customerId });
    return { customerId, deposits: round2(pos?.depositBalance ?? 0), creditNotes: round2(pos?.creditBalance ?? 0) };
  },
};
