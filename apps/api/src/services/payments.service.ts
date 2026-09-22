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
 *   classify()         AP-1 — a dated statement of WHAT a deposit is
 *                      (advance / erroneous / security_deposit / unknown); a
 *                      new record per change, nothing posted, no VAT decided
 *                      (advance-payments decision pack §9 AP-1).
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
import { businessToday, isReceivableInBooks } from "@workspace/shared";
import { paymentsRepository, invoiceSettlementRepository } from "../repositories/payments.repository";
import { customersRepository } from "../repositories/customers.repository";
import { customerStatementRepository } from "../repositories/customerStatement.repository";
import { invoicesRepository } from "../repositories/invoices.repository";
import { journalEntriesRepository } from "../repositories/journalEntries.repository";
import { postJournalEntry, type GLLine, type GLParty } from "./accounting/glPosting";
import { checkPeriodOpen } from "./accounting/periodLock";
import { assertBankAccount } from "./accounting/bankIdentity";
import { CUSTOMER_CREDIT_ACCOUNT, CUSTOMER_CREDIT_ACCOUNT_NAME, depositLiabilityAccount, type DepositClassificationKind } from "./accounting/customerCreditPolicy";
import { auditService } from "./audit.service";
import { assertNotReversedOpening } from "./accounting/openingReversed";
import type { Payment, PaymentAllocation, PaymentAllocationReversal, CustomerRefund, PaymentClassification, SystemAccountCode } from "@workspace/db";
import { isNoteType } from "./creditNotes";
import { isAdvanceInvoiceType } from "@workspace/shared";
import { advanceInvoicesService, type ReceiptAdvanceInvoiceOut } from "./advanceInvoices.service";
import { advanceInvoicesRepository } from "../repositories/advanceInvoices.repository";

export type AllocationInput = { invoiceId: number; amount: number };

/** AP-1 — what the business says a deposit is. Informational; the later VAT workflow keys on it. */
export type DepositClassification = "advance" | "erroneous" | "security_deposit" | "unknown";
export const DEPOSIT_CLASSIFICATIONS: readonly DepositClassification[] = ["advance", "erroneous", "security_deposit", "unknown"];
export type DepositVatCategory = "S" | "Z" | "E";

export type ClassificationOut = {
  id: number;
  classification: DepositClassification;
  vatCategory: DepositVatCategory | null;
  note: string | null;
  classifiedBy: number | null;
  classifiedAt: string;
  /** 2026-09-22: when the classification took effect in the books, and the reclassification entry it posted (null when the liability account did not change). */
  effectiveDate: string | null;
  reclassificationJournalEntryId: number | null;
};

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
  /** AP-1: what the unapplied part is, stated at receipt (a classification record in the same transaction). */
  classification?: DepositClassification | null;
  vatCategory?: DepositVatCategory | null;
  classificationNote?: string | null;
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
  /** AP-1: the CURRENT classification (the newest record), or null when nobody has said what the deposit is. */
  classification: ClassificationOut | null;
  /** 2026-09-22: the liability account the on-account balance sits on (customerCreditPolicy.ts), null once nothing is on account. */
  liabilityAccountCode: "CUSTOMER_DEPOSITS" | "SECURITY_DEPOSITS_HELD" | "UNIDENTIFIED_RECEIPTS" | null;
  /** AP-2: Σ issued advance tax invoices (386) on this receipt — the part of the deposit whose VAT is declared. */
  advanceInvoicedAmount: number;
  /** AP-2: Σ adjusted by issued final invoices (the prepayment adjustment). */
  advanceAdjustedAmount: number;
  /** AP-2: invoiced − adjusted — reserved for a final invoice's adjustment; a D-4 allocation or a refund cannot touch it. */
  advanceOpenAmount: number;
  /** AP-2: unapplied − advanceOpen — what may still be advance-invoiced, allocated or refunded. */
  uninvoicedAmount: number;
  /** AP-2: every advance tax invoice (any status) issued from this receipt. */
  advanceInvoices: ReceiptAdvanceInvoiceOut[];
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

function toClassificationOut(c: PaymentClassification): ClassificationOut {
  return {
    id: c.id, classification: c.classification as DepositClassification, vatCategory: (c.vatCategory as DepositVatCategory | null) ?? null,
    note: c.note ?? null, classifiedBy: c.createdBy ?? null, classifiedAt: c.createdAt.toISOString(),
    effectiveDate: c.effectiveDate ?? null, reclassificationJournalEntryId: c.journalEntryId ?? null,
  };
}

/** Parse a classification request — the value set is the table's CHECK, restated here so the refusal is a 400 with the field named. */
function parseClassification(body: { classification?: unknown; vatCategory?: unknown; note?: unknown }): { classification: DepositClassification; vatCategory: DepositVatCategory | null; note: string | null } {
  const classification = body.classification;
  if (typeof classification !== "string" || !(DEPOSIT_CLASSIFICATIONS as readonly string[]).includes(classification)) {
    throw new BadRequestError(`classification must be one of ${DEPOSIT_CLASSIFICATIONS.join(", ")}.`);
  }
  const vatCategory = body.vatCategory == null || body.vatCategory === "" ? null : body.vatCategory;
  if (vatCategory != null && vatCategory !== "S" && vatCategory !== "Z" && vatCategory !== "E") throw new BadRequestError("vatCategory must be S, Z or E.");
  if (vatCategory != null && classification !== "advance") {
    throw new BusinessRuleError(422, { error: "A VAT category belongs to an advance for a taxable supply only; an erroneous payment or a security deposit has none.", code: "vat_category_requires_advance", field: "vatCategory" });
  }
  const note = typeof body.note === "string" && body.note.trim() ? body.note.trim().slice(0, 500) : null;
  return { classification: classification as DepositClassification, vatCategory: vatCategory as DepositVatCategory | null, note };
}

function toRefundOut(f: CustomerRefund): RefundOut {
  return {
    id: f.id, customerId: f.customerId, bankAccountId: f.bankAccountId, origin: f.origin as "deposit" | "credit_note",
    paymentId: f.paymentId ?? null, creditNoteId: f.creditNoteId ?? null, amount: num(f.amount), refundedAt: f.refundedAt,
    reason: f.reason, reference: f.reference ?? null, journalEntryId: f.journalEntryId, idempotencyKey: f.idempotencyKey ?? null, createdAt: f.createdAt.toISOString(),
  };
}

/** A receipt's ACTIVE allocated total and what is still available (unapplied and not refunded). */
/** Policy C: a migrated deposit the migration reversed is history — never allocated, never refunded (its superseding record is in migration_deposit_reversals). */
async function assertDepositNotReversed(p: Payment): Promise<void> {
  if (p.source !== "opening") return;
  const [reversal] = await paymentsRepository.findDepositReversal(p.id);
  if (!reversal) return;
  throw new BusinessRuleError(409, {
    code: "opening_item_reversed",
    error: `Receipt ${p.id} is a migrated deposit that the migration reversed (batch ${reversal.batchId}); it is history and cannot be allocated or refunded. The corrected migration's replacement deposit is the one to act on.`,
    field: "paymentId",
  });
}

async function paymentAvailability(p: Payment): Promise<{ allocated: number; refunded: number; available: number }> {
  const allocated = round2((await paymentsRepository.allocatedTotals([p.id])).get(p.id) ?? 0);
  const refunded = round2(await paymentsRepository.refundedFrom({ paymentId: p.id }));
  return { allocated, refunded, available: round2(num(p.amount) - allocated - refunded) };
}

/**
 * The liability account a receipt's on-account money sits on TODAY — by its
 * latest classification (customerCreditPolicy.ts, the one seam). Every path
 * that moves that money (allocate, unallocate, refund, reclassify) reads it
 * here, never a constant.
 */
async function depositAccountOf(p: Payment, current?: PaymentClassification | null): Promise<{ systemCode: "CUSTOMER_DEPOSITS" | "SECURITY_DEPOSITS_HELD" | "UNIDENTIFIED_RECEIPTS"; accountName: string; classification: DepositClassificationKind | null }> {
  const c = current !== undefined ? current : (await paymentsRepository.latestClassifications([p.id])).get(p.id) ?? null;
  const kind = (c?.classification as DepositClassificationKind | undefined) ?? null;
  return { ...depositLiabilityAccount(kind), classification: kind };
}

async function view(p: Payment, classification?: PaymentClassification | null): Promise<PaymentOut> {
  const rows = await paymentsRepository.allocationsOfPayment(p.id);
  const allocated = round2(rows.filter((r) => r.reversal == null).reduce((s, r) => s + num(r.alloc.amount), 0));
  const refunded = round2(await paymentsRepository.refundedFrom({ paymentId: p.id }));
  const current = classification !== undefined ? classification : (await paymentsRepository.latestClassifications([p.id])).get(p.id) ?? null;
  const unapplied = round2(num(p.amount) - allocated - refunded);
  const adv = (await advanceInvoicesRepository.figuresForPayments([p.id])).get(p.id) ?? { invoiced: 0, invoicedVat: 0, adjusted: 0, adjustedVat: 0, credited: 0, creditedVat: 0, open: 0, openVat: 0 };
  const advRows = await advanceInvoicesRepository.advanceInvoicesOfPayment(p.id);
  const noteRows = await advanceInvoicesRepository.creditNotesOfAdvances(advRows.map((r) => r.inv.id));
  const advanceInvoices: ReceiptAdvanceInvoiceOut[] = advRows.map(({ inv, adjusted, credited, vatCategory }) => ({
    id: inv.id, invoiceNumber: inv.invoiceNumber, status: inv.status, date: inv.date, total: num(inv.total), subtotal: num(inv.subtotal), vatAmount: num(inv.vatAmount),
    vatCategory, adjustedAmount: round2(adjusted), creditedAmount: round2(credited),
    openAmount: inv.status === "draft" || inv.status === "submitted" ? 0 : round2(num(inv.total) - adjusted - credited),
    // AP-3: the provenance chain reads receipt → 386 → credit note(s) → (the receipt's) refund.
    creditNotes: noteRows.filter((n) => n.originalInvoiceId === inv.id).map((n) => ({ id: n.id, invoiceNumber: n.invoiceNumber, status: n.status, date: n.date, total: num(n.total), vatAmount: num(n.vatAmount), noteReason: n.noteReason ?? null })),
  }));
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
    unappliedAmount: unapplied,
    allocations: rows.map((r) => toAllocationOut(r.alloc, r.reversal)),
    classification: current ? toClassificationOut(current) : null,
    liabilityAccountCode: unapplied > 0.005 ? depositLiabilityAccount((current?.classification as DepositClassificationKind | undefined) ?? null).systemCode : null,
    advanceInvoicedAmount: round2(adv.invoiced),
    advanceAdjustedAmount: round2(adv.adjusted),
    advanceOpenAmount: round2(adv.open),
    uninvoicedAmount: round2(unapplied - adv.open),
    advanceInvoices,
    createdAt: p.createdAt.toISOString(),
  };
}

/**
 * AP-1 — what may be classified: a receipt (direction in) with a customer,
 * that IS or WAS a deposit (some part not allocated at receipt), that is not
 * a migrated deposit (its VAT position is the MIGRATION's record — one
 * definition, never two) and not a reversed one. Throws the named refusal.
 */
async function assertClassifiable(p: Payment): Promise<void> {
  if (p.direction !== "in" || p.customerId == null) {
    throw new BusinessRuleError(422, { error: `Receipt ${p.id} has no identified customer; only a customer's deposit can be classified.`, code: "classification_requires_customer", field: "paymentId" });
  }
  if (p.source === "opening") {
    throw new BusinessRuleError(409, { error: `Receipt ${p.id} is a migrated opening deposit; its VAT position (invoiced or unknown) is the migration's record and is not reclassified here.`, code: "opening_deposit_classified_by_migration", field: "paymentId" });
  }
  await assertDepositNotReversed(p);
  const atReceipt = round2(await paymentsRepository.allocatedAtReceipt(p.id));
  if (num(p.amount) - atReceipt < 0.005) {
    throw new BusinessRuleError(409, { error: `Receipt ${p.id} was fully allocated to invoices when it was recorded; it was never a deposit and there is nothing to classify.`, code: "no_deposit_to_classify", field: "paymentId" });
  }
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
    // AP-2: an advance tax invoice declares VAT on cash that already arrived; it is not a receivable and nothing settles it.
    if (isAdvanceInvoiceType(inv.documentType)) {
      throw new BusinessRuleError(409, { error: `${inv.invoiceNumber} is an advance tax invoice for money already received; it has no receivable to settle. Apply it on the customer's final invoice.`, code: "advance_invoice_not_payable", field: "allocations" });
    }
    assertNotReversedOpening(inv, `Invoice ${inv.invoiceNumber}`, "settled");
    // Issue 1 (Batch 1C): "issued" is a BUSINESS state, not a tax artefact. An
    // opening receivable migrated at cut-off is in the books with no hash, no
    // ICV and no QR — by design, forever — and a receipt settles it exactly as
    // it settles an invoice this system issued. The one predicate lives in
    // @workspace/shared; a hash test here refused the migration's reason to
    // exist, and it is not what "has a receivable" means.
    if (!isReceivableInBooks(inv)) {
      throw new ConflictError(`Invoice ${inv.invoiceNumber} has not been issued (status: ${inv.status}); only an invoice in the books — issued here, or migrated as an opening item — has a receivable to settle.`);
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
    const outstanding = round2(num(inv.total) - num(inv.paidAmount) - num(inv.creditedAmount) - num(inv.writtenOffAmount));
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
  targets: Map<number, { id: number; total: string; paidAmount: string | null; creditedAmount: string; writtenOffAmount: string; status: string }>,
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
    const outstandingAfter = round2(num(inv.total) - num(inv.paidAmount) - num(inv.creditedAmount) - num(inv.writtenOffAmount) - a.amount);
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
    const classification = body.classification != null ? parseClassification({ classification: body.classification, vatCategory: body.vatCategory, note: body.classificationNote }) : null;
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
    if (classification && unapplied < 0.005) {
      throw new BusinessRuleError(422, { error: "This receipt is fully allocated to invoices; there is no deposit to classify.", code: "no_deposit_to_classify", field: "classification" });
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
      // The liability the money is: by the classification stated AT receipt (customerCreditPolicy.ts); unstated → the presumed deposit.
      const liability = depositLiabilityAccount(classification?.classification ?? null);
      lines.push({ systemCode: liability.systemCode, accountName: liability.accountName, description: classification ? `Receipt on account — ${classification.classification.replace("_", " ")}` : "Receipt on account — not yet allocated", debitAmount: 0, creditAmount: unapplied, party });
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
    let classified: PaymentClassification | null = null;
    if (classification) {
      classified = await paymentsRepository.insertClassification({ paymentId, ...classification, idempotencyKey: null, createdBy: userId });
    }

    const out = await view(payment, classified);
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
    await assertDepositNotReversed(payment);

    const allocations = parseAllocations(body.allocations);
    if (allocations.length === 0) throw new BadRequestError("At least one allocation is required.");
    const { available: unapplied } = await paymentAvailability(payment);
    const requested = round2(allocations.reduce((s, a) => s + a.amount, 0));
    if (requested > unapplied + TOL) {
      throw new BusinessRuleError(422, { error: `Allocations total ${fmt(requested)} but only ${fmt(unapplied)} of payment ${paymentId} is unapplied.`, code: "allocation_exceeds_payment", field: "allocations" });
    }
    // AP-2 (G-Z-3, fail-closed): what an advance tax invoice has declared VAT
    // for is applied through the final invoice's prepayment adjustment, never
    // by a plain allocation — that would settle AR while the 386's VAT stays
    // declared and the final invoice declares it again.
    await advanceInvoicesService.assertWithinUninvoiced(payment, requested, "allocated");
    const liability = await depositAccountOf(payment);
    if (liability.classification === "security_deposit") {
      // A refundable security deposit is contractually unavailable for use: it settles nothing until the business RECLASSIFIES it (a dated, audited act) — never by an allocation.
      throw new BusinessRuleError(409, { error: `Receipt ${paymentId} is classified as a refundable security deposit; it cannot be applied to an invoice while it is. Reclassify it (advance or unknown) first, or refund it.`, code: "security_deposit_not_allocatable", field: "paymentId" });
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
        { systemCode: liability.systemCode, accountName: liability.accountName, description: `Deposit applied from receipt ${paymentId}`, debitAmount: requested, creditAmount: 0, party },
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
    const classifications = await paymentsRepository.latestClassifications(rows.map((p) => p.id));
    const out: PaymentOut[] = [];
    for (const p of rows) out.push(await view(p, classifications.get(p.id) ?? null));
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
      // AP-2: an allocation FOLDED into a final invoice's issue entry (the
      // prepayment adjustment) is what the signed document states — the
      // deposit's NET part left the liability and the VAT was netted there,
      // so mirroring it here would restore the GROSS. Corrected by a credit
      // note on that invoice, never unapplied (the Phase A rule for a note's
      // own settlement, applied to the adjustment).
      const [prepayment] = await advanceInvoicesRepository.findByAllocation(alloc.id);
      if (prepayment) {
        throw new BusinessRuleError(409, {
          error: `Allocation ${allocationId} is the prepayment adjustment stated on the issued invoice (advance tax invoice ${prepayment.advanceInvoiceId} applied); the signed document carries it and it cannot be unapplied. Issue a credit note against the invoice to correct it.`,
          code: "prepayment_adjustment_immutable",
          field: "id",
        });
      }
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
    // deposit origin: back onto the account the receipt's money sits on TODAY (its classification), never a constant
    const depositSide = origin === "deposit" && alloc.paymentId != null ? await depositAccountOf((await paymentsRepository.findPaymentById(alloc.paymentId))[0]!) : null;
    const account = depositSide ? depositSide.systemCode : CUSTOMER_CREDIT_ACCOUNT[origin];
    const accountName = depositSide ? depositSide.accountName : CUSTOMER_CREDIT_ACCOUNT_NAME[origin];
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
    const outstandingAfter = round2(num(inv.total) - num(inv.paidAmount) - num(inv.creditedAmount) - num(inv.writtenOffAmount) + amount);
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
    let refundAccount: { systemCode: string; accountName: string } = { systemCode: CUSTOMER_CREDIT_ACCOUNT[origin], accountName: CUSTOMER_CREDIT_ACCOUNT_NAME[origin] };
    if (origin === "deposit") {
      paymentId = Number(body.paymentId);
      if (!Number.isInteger(paymentId) || paymentId <= 0) throw new BadRequestError("paymentId must name the receipt whose deposit is refunded.");
      const [payment] = await paymentsRepository.lockPayment(paymentId);
      if (!payment) throw new BusinessRuleError(422, { error: `Receipt ${paymentId} does not exist for this organization.`, code: "reference_not_found", field: "paymentId" });
      if (payment.direction !== "in" || (payment.customerId ?? null) !== customerId) {
        throw new BusinessRuleError(422, { error: `Receipt ${paymentId} is not a receipt from this customer.`, code: "refund_source_mismatch", field: "paymentId" });
      }
      await assertDepositNotReversed(payment);
      available = (await paymentAvailability(payment)).available;
      // AP-2 (G-Z-3, fail-closed): a deposit an advance tax invoice covers is
      // refunded only after a credit note against that 386 (AP-3) — refunding
      // the cash now would leave its VAT declared against nothing.
      if (rounded <= available + TOL) await advanceInvoicesService.assertWithinUninvoiced(payment, rounded, "refunded");
      refundAccount = await depositAccountOf(payment);
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
        { systemCode: refundAccount.systemCode as SystemAccountCode, accountName: refundAccount.accountName, description: `Refund of ${sourceLabel}`, debitAmount: rounded, creditAmount: 0, party },
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
   * AP-1 — CLASSIFY a deposit: a new dated record (never an edit) saying what
   * the money is. Nothing posts; no VAT is decided or altered; the later VAT
   * workflow (AP-2) reads the CURRENT record. Refuses what is not a deposit
   * (`assertClassifiable`). Idempotent per key.
   */
  async classify(paymentId: number, body: { classification?: unknown; vatCategory?: unknown; note?: unknown; effectiveDate?: string | null; idempotencyKey?: string | null }, userId: number | null): Promise<PaymentOut> {
    const parsed = parseClassification(body);
    const idempotencyKey = body.idempotencyKey?.trim() || null;
    if (idempotencyKey) {
      const [existing] = await paymentsRepository.findClassificationByIdempotencyKey(idempotencyKey);
      if (existing) {
        if (existing.paymentId !== paymentId) throw new ConflictError(`Idempotency key "${idempotencyKey}" was already used for a different classification. Use a new key.`);
        return this.get(paymentId);
      }
    }
    const [payment] = await paymentsRepository.lockPayment(paymentId);
    if (!payment) throw new NotFoundError("Payment not found");
    await assertClassifiable(payment);
    const before = (await paymentsRepository.latestClassifications([paymentId])).get(paymentId) ?? null;
    /**
     * 🔴 A CLASSIFICATION THAT CHANGES THE LIABILITY MOVES THE MONEY (accountant,
     * 2026-09-22). The receipt's on-account balance leaves the account it sits
     * on for the account its new classification names, by ONE entry dated the
     * classification's effective date, in an open month — never silently, never
     * in a locked month. A deposit whose advance tax invoice is issued and not
     * fully cancelled cannot leave CUSTOMER_DEPOSITS: the 386 declared VAT on
     * it, and only its credit note (AP-3) undoes that.
     */
    const fromAccount = await depositAccountOf(payment, before);
    const toAccount = depositLiabilityAccount(parsed.classification);
    const effectiveDate = body.effectiveDate ? assertDateString(body.effectiveDate, "effectiveDate") : businessToday();
    if (effectiveDate < payment.paidAt) {
      throw new BusinessRuleError(422, { error: `A classification cannot take effect on ${effectiveDate}, before the receipt of ${payment.paidAt}.`, code: "classification_before_receipt", field: "effectiveDate" });
    }
    let reclassEntryId: number | null = null;
    if (fromAccount.systemCode !== toAccount.systemCode) {
      const adv = (await advanceInvoicesRepository.figuresForPayments([paymentId])).get(paymentId);
      if (adv && adv.invoiced - adv.credited > 0.005) {
        throw new BusinessRuleError(409, {
          error: `Receipt ${paymentId} has an advance tax invoice issued on ${fmt(adv.invoiced - adv.credited)} of it that is not cancelled; it stays an advance until that invoice is credited (a credit note against it, then reclassify).`,
          code: "advance_invoiced_cannot_reclassify",
          field: "classification",
        });
      }
      const { available } = await paymentAvailability(payment);
      if (available > 0.005) {
        await checkPeriodOpen(effectiveDate);
        const party = partyOf(payment.customerId ?? null);
        const je = await postJournalEntry({
          entryNumber: `RECLASS-${paymentId}-${Date.now()}`,
          date: effectiveDate,
          description: `Receipt ${paymentId} reclassified: ${before?.classification ?? "unstated"} → ${parsed.classification} (${fromAccount.accountName} → ${toAccount.accountName})`,
          reference: payment.reference ?? undefined,
          lines: [
            { systemCode: fromAccount.systemCode, accountName: fromAccount.accountName, description: `Receipt ${paymentId} reclassified out`, debitAmount: available, creditAmount: 0, party },
            { systemCode: toAccount.systemCode, accountName: toAccount.accountName, description: `Receipt ${paymentId} reclassified in`, debitAmount: 0, creditAmount: available, party },
          ],
        });
        reclassEntryId = je.id;
      }
    }
    let row: PaymentClassification;
    try {
      row = await paymentsRepository.insertClassification({ paymentId, ...parsed, idempotencyKey, createdBy: userId, effectiveDate, journalEntryId: reclassEntryId });
    } catch (err) {
      if (isIdempotencyRace(err)) throw new ConflictError(`Classification "${idempotencyKey}" was recorded concurrently. Retry the request to read it.`);
      throw err;
    }
    const out = await view(payment, row);
    await auditService.record({
      action: "classify", entityType: "payment", entityId: paymentId,
      before: before ? toClassificationOut(before) : null,
      after: { ...toClassificationOut(row), unappliedAmount: out.unappliedAmount, reclassified: reclassEntryId != null ? { from: fromAccount.systemCode, to: toAccount.systemCode, journalEntryId: reclassEntryId, effectiveDate } : null },
    });
    return out;
  },

  /** AP-1 — every classification a receipt has carried, oldest first. */
  async classificationHistory(paymentId: number): Promise<ClassificationOut[]> {
    const [p] = await paymentsRepository.findPaymentById(paymentId);
    if (!p) throw new NotFoundError("Payment not found");
    return (await paymentsRepository.classificationHistory(paymentId)).map(toClassificationOut);
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
