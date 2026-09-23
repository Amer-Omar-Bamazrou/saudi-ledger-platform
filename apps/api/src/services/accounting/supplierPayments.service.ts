/**
 * SUPPLIER PAYMENTS, ALLOCATIONS, ADVANCES AND REFUNDS
 * (Phase 11 Part 2 — B3/B4, 2026-09-22).
 * Record: docs/product/phase-11-deep-accounting-ap-decision-pack.md §9–§11.
 *
 * ── The accounting, and why it is one entry and not two ────────────────────
 * A supplier payment posts ONE balanced entry naming where every riyal went:
 *
 *   Dr AP (vendor)              the part allocated to bills
 *   Dr <on-account asset>       the part that is not yet against anything
 *     Cr <the bank's own cash account>            the whole amount
 *
 * 🔴 The unallocated part is an ASSET, not a negative payable. A supplier
 * advance is money they hold and owe us goods for; parking it in AP would make
 * the vendor's payable read as if it had been settled and would net silently
 * against unrelated bills in every ageing bucket.
 *
 * A LATER allocation of that on-account money is its own entry:
 *
 *   Dr AP (vendor) / Cr <on-account asset>
 *
 * so the subledger can always answer "which bill did this advance settle, and
 * when" — and no posted entry is ever mutated to do it.
 *
 * ── 🔴 NO INPUT VAT ON ANY PATH IN THIS FILE ───────────────────────────────
 * VAT IR Art. 49(7): input tax may be deducted only where the taxable person
 * HOLDS EVIDENCE of it. Our evidence is the supplier's tax invoice, which in
 * this product is a BILL. Paying money — advance, deposit or settlement —
 * deducts nothing. If a future reader is tempted to add a VAT line here, the
 * document they are missing is the supplier's, and it belongs on a bill.
 */
import { and, eq, sql } from "drizzle-orm";
import {
  db, supplierPaymentsTable, supplierPaymentAllocationsTable,
  supplierPaymentAllocationReversalsTable, supplierPaymentClassificationsTable,
  supplierRefundsTable, billsTable, vendorsTable,
  type SupplierPayment,
} from "@workspace/db";
import { BusinessRuleError, NotFoundError } from "../../lib/errors.js";
import { round2 } from "../../lib/money.js";
import { businessToday } from "@workspace/shared";
import { auditService } from "../audit.service.js";
import { postJournalEntry } from "./glPosting.js";
import { checkPeriodOpen } from "./periodLock.js";
import { assertBankAccount } from "./bankIdentity.js";
import { billsRepository } from "../../repositories/bills.repository.js";
import {
  supplierOnAccountAsset, mayAllocate,
  type SupplierPaymentClassificationKind,
} from "./supplierCreditPolicy.js";

const refuse = (code: string, error: string, field?: string, status = 422): never => {
  throw new BusinessRuleError(status, { code, error, ...(field ? { field } : {}) });
};

export interface AllocationInput { billId: number; amount: number }

export const supplierPaymentsService = {
  /**
   * Pay a supplier. Allocations are optional: what is not allocated stays on
   * account, classified (`unknown` unless stated), and can be applied later.
   */
  async create(body: Record<string, unknown>, userId: number | null) {
    /**
     * A retried request is the SAME payment, not a second one: the key is
     * looked up first and the original returned, as the customer side does.
     * The UNIQUE index is the backstop for a race, not the mechanism.
     */
    const idempotencyKey = typeof body.idempotencyKey === "string" && body.idempotencyKey.trim() ? body.idempotencyKey.trim() : null;
    if (idempotencyKey) {
      const [prior] = await db.select().from(supplierPaymentsTable).where(eq(supplierPaymentsTable.idempotencyKey, idempotencyKey)).limit(1);
      if (prior) return this.getById(prior.id);
    }

    const vendorId = Number(body.vendorId);
    const [vendor] = await db.select().from(vendorsTable).where(eq(vendorsTable.id, vendorId)).limit(1);
    if (!vendor) refuse("vendor_unknown", "Name the supplier this payment went to.", "vendorId");

    const amount = round2(Number(body.amount));
    if (!Number.isFinite(amount) || amount <= 0) refuse("amount_invalid", "A supplier payment moves a positive amount.", "amount");

    // D-3: which bank did the money leave? Never a default, never inferred.
    const bankAccountId = await assertBankAccount(body.bankAccountId, { what: "the payment left from" });

    const paidAt = typeof body.paidAt === "string" && body.paidAt ? body.paidAt : businessToday();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(paidAt)) refuse("paid_at_invalid", "The payment date is a YYYY-MM-DD date.", "paidAt");
    // 🔴 The period is checked BEFORE anything is written, and the payment is
    // never silently re-dated into an open month: money moved on a day, and a
    // closed month is a refusal for the user to resolve.
    await checkPeriodOpen(paidAt);

    const classification = (typeof body.classification === "string" ? body.classification : "unknown") as SupplierPaymentClassificationKind;
    if (!["advance", "security_deposit", "erroneous", "unknown"].includes(classification)) {
      refuse("classification_unknown", "A payment on account is an advance, a refundable security deposit, an erroneous payment, or not yet classified.", "classification");
    }

    const requested = Array.isArray(body.allocations) ? (body.allocations as AllocationInput[]) : [];
    const allocations = await this.validateAllocations(requested, vendorId, amount);
    const allocatedTotal = round2(allocations.reduce((a, x) => a + x.amount, 0));
    const onAccount = round2(amount - allocatedTotal);

    // 🔴 Money that is not against a bill must say what it is before it can be
    // applied to one: an advance may be allocated, a deposit and an erroneous
    // or unclassified payment may not (see supplierCreditPolicy). The
    // remainder simply sits on its account until somebody classifies it.

    const asset = supplierOnAccountAsset(classification);
    const lines = [];
    for (const a of allocations) {
      lines.push({
        systemCode: "AP" as const, accountName: "Accounts Payable",
        description: `Payment for ${a.billNumber}`,
        debitAmount: a.amount, creditAmount: 0,
        party: { type: "vendor" as const, vendorId },
      });
    }
    if (onAccount > 0) {
      lines.push({
        systemCode: asset.systemCode, accountName: asset.accountName,
        description: `On account for ${vendor!.name}`,
        debitAmount: onAccount, creditAmount: 0,
        party: { type: "vendor" as const, vendorId },
      });
    }
    lines.push({ bankAccountId, description: `Payment to ${vendor!.name}`, debitAmount: 0, creditAmount: amount });

    const reference = typeof body.reference === "string" ? body.reference : null;
    const entry = await postJournalEntry({
      entryNumber: `SPAY-${vendorId}-${Date.now()}`,
      date: paidAt,
      description: `Payment to ${vendor!.name}`,
      reference: reference ?? undefined,
      lines,
    });

    const [payment] = await db.insert(supplierPaymentsTable).values({
      vendorId, bankAccountId, amount: String(amount), paidAt,
      method: (body.method as string) ?? null,
      reference, notes: (body.notes as string) ?? null,
      classification,
      /**
       * 🔴 `source` is NOT the caller's to state. `opening` is migration
       * provenance — a claim that this money came from a committed batch —
       * and migrated supplier advances are not built (pack §16). A value a
       * client can stamp on a manual payment is provenance nobody can trust,
       * so this path writes the one thing it knows: a person entered it.
       */
      source: "manual",
      journalEntryId: entry.id,
      idempotencyKey,
      createdBy: userId,
    }).returning();

    for (const a of allocations) {
      await db.insert(supplierPaymentAllocationsTable).values({
        supplierPaymentId: payment!.id, billId: a.billId, amount: String(a.amount),
        journalEntryId: entry.id, createdBy: userId,
      });
      await this.refreshBill(a.billId);
    }
    if (classification !== "unknown") {
      await db.insert(supplierPaymentClassificationsTable).values({
        supplierPaymentId: payment!.id, classification, note: (body.classificationNote as string) ?? null, createdBy: userId,
      });
    }

    await auditService.created("supplier_payment", payment!.id, payment);
    return this.getById(payment!.id);
  },

  /**
   * Apply on-account money to a bill, after the fact. Its own entry:
   * `Dr AP (vendor) / Cr <on-account asset>`.
   */
  async allocate(id: number, body: { allocations?: unknown; date?: unknown }, userId: number | null) {
    // 🔴 Locked: what is still on account is read, checked and spent under
    // one row lock, so two concurrent applications cannot both spend it.
    const payment = await this.findOrThrow(id, { lock: true });
    const cls = payment.classification as SupplierPaymentClassificationKind;
    if (!mayAllocate(cls)) {
      refuse(
        "classification_not_allocatable",
        cls === "security_deposit"
          ? "A refundable security deposit is not consideration for a supply — it is money the supplier holds and owes back. Reclassify it as an advance first if that is what it has become."
          : "This payment has not been identified as an advance. Money whose purpose nobody has stated cannot settle a payable — classify it first.",
        "classification", 409,
      );
    }
    const available = await this.availableOf(id);
    const requested = Array.isArray(body.allocations) ? (body.allocations as AllocationInput[]) : [];
    if (requested.length === 0) refuse("allocations_required", "Name at least one bill to apply this advance to.", "allocations");

    // The cap is enforced ONCE, inside validateAllocations — see the note there.
    const allocations = await this.validateAllocations(requested, payment.vendorId, available);
    const total = round2(allocations.reduce((a, x) => a + x.amount, 0));

    const date = typeof body.date === "string" && body.date ? body.date : businessToday();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) refuse("date_invalid", "The allocation date is a YYYY-MM-DD date.", "date");
    // Money cannot be applied before it was paid: the entry would move the
    // advance account on a day it had no balance.
    if (date < payment.paidAt) refuse("date_before_payment", `The advance was paid on ${payment.paidAt}; it cannot be applied on an earlier date.`, "date");
    await checkPeriodOpen(date);

    const asset = supplierOnAccountAsset(cls);
    const [vendor] = await db.select().from(vendorsTable).where(eq(vendorsTable.id, payment.vendorId)).limit(1);
    const entry = await postJournalEntry({
      entryNumber: `SALLOC-${id}-${Date.now()}`,
      date,
      description: `Advance applied for ${vendor?.name ?? "supplier"}`,
      reference: payment.reference ?? undefined,
      lines: [
        ...allocations.map((a) => ({
          systemCode: "AP" as const, accountName: "Accounts Payable",
          description: `Advance applied to ${a.billNumber}`,
          debitAmount: a.amount, creditAmount: 0,
          party: { type: "vendor" as const, vendorId: payment.vendorId },
        })),
        {
          systemCode: asset.systemCode, accountName: asset.accountName,
          description: `Advance applied for ${vendor?.name ?? "supplier"}`,
          debitAmount: 0, creditAmount: total,
          party: { type: "vendor" as const, vendorId: payment.vendorId },
        },
      ],
    });

    for (const a of allocations) {
      await db.insert(supplierPaymentAllocationsTable).values({
        supplierPaymentId: id, billId: a.billId, amount: String(a.amount),
        journalEntryId: entry.id, createdBy: userId,
      });
      await this.refreshBill(a.billId);
    }
    await auditService.record({ action: "allocate", entityType: "supplier_payment", entityId: String(id), before: null, after: { allocations, journalEntryId: entry.id } });
    return this.getById(id);
  },

  /**
   * Undo an allocation with a SUPERSEDING record. The original allocation row
   * stays exactly as it was, beside the reversal that answers it.
   */
  async reverseAllocation(allocationId: number, body: { reason?: unknown; date?: unknown }, userId: number | null) {
    const [alloc] = await db.select().from(supplierPaymentAllocationsTable).where(eq(supplierPaymentAllocationsTable.id, allocationId)).limit(1);
    if (!alloc) throw new NotFoundError("Allocation not found.");
    const [already] = await db.select().from(supplierPaymentAllocationReversalsTable)
      .where(eq(supplierPaymentAllocationReversalsTable.allocationId, allocationId)).limit(1);
    if (already) refuse("allocation_already_reversed", "This allocation has already been corrected once; the record of that correction is its answer.", undefined, 409);

    const reason = String(body.reason ?? "").trim();
    if (!reason) refuse("reason_required", "Say why the allocation is being undone — the supplier's balance moves and the record has to say why.", "reason");

    const date = typeof body.date === "string" && body.date ? body.date : businessToday();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) refuse("date_invalid", "The reversal date is a YYYY-MM-DD date.", "date");
    const amount = Number(alloc.amount);

    /**
     * 🔴 A CREDIT-NOTE APPLICATION IS UNDONE WITH NO ENTRY, because applying
     * it posted none (pack §13.2): the note's debit has sat in AP since the
     * note was approved, and the application only said which bill it
     * answered. Reversing it says "no bill, yet" — AP does not move.
     *
     * The first build routed this through the payment branch below, which —
     * finding no payment — defaulted the classification to `advance` and
     * posted Dr SUPPLIER_ADVANCES / Cr AP: an advance asset no payment
     * explained, and AP raised by a note that had not changed. The superseding
     * row is still written, with a null journal entry — the same shape a
     * reclassification uses to say "recorded, nothing posted".
     */
    if (alloc.supplierCreditNoteId != null) {
      await db.insert(supplierPaymentAllocationReversalsTable).values({
        allocationId, reason, journalEntryId: null, createdBy: userId,
      });
      await this.refreshBill(alloc.billId);
      await auditService.record({ action: "reverse_allocation", entityType: "supplier_payment_allocation", entityId: String(allocationId), before: alloc, after: { reason, journalEntryId: null } });
      return { allocationId, reason, journalEntryId: null, amount };
    }

    // Locked for the same reason as allocate: the on-account balance moves.
    const payment = await this.findOrThrow(alloc.supplierPaymentId!, { lock: true });
    // The mirror cannot pre-date what it mirrors.
    const allocatedOn = alloc.journalEntryId != null ? await this.entryDate(alloc.journalEntryId) : null;
    if (allocatedOn && date < allocatedOn) refuse("date_before_allocation", `The allocation was posted on ${allocatedOn}; it cannot be reversed on an earlier date.`, "date");
    await checkPeriodOpen(date);

    const asset = supplierOnAccountAsset(payment.classification as SupplierPaymentClassificationKind);
    const vendorId = payment.vendorId;

    // The mirror of the allocation: AP goes back up, the on-account asset returns.
    const entry = await postJournalEntry({
      entryNumber: `SALLOC-REV-${allocationId}-${Date.now()}`,
      date,
      description: `Allocation reversed: ${reason}`,
      lines: [
        { systemCode: asset.systemCode, accountName: asset.accountName, description: "Allocation reversed", debitAmount: amount, creditAmount: 0, party: { type: "vendor" as const, vendorId } },
        { systemCode: "AP" as const, accountName: "Accounts Payable", description: "Allocation reversed", debitAmount: 0, creditAmount: amount, party: { type: "vendor" as const, vendorId } },
      ],
    });

    await db.insert(supplierPaymentAllocationReversalsTable).values({
      allocationId, reason, journalEntryId: entry.id, createdBy: userId,
    });
    await this.refreshBill(alloc.billId);
    await auditService.record({ action: "reverse_allocation", entityType: "supplier_payment_allocation", entityId: String(allocationId), before: alloc, after: { reason, journalEntryId: entry.id } });
    return { allocationId, reason, journalEntryId: entry.id, amount };
  },

  /**
   * Reclassify on-account money. When the ACCOUNT changes the balance is moved
   * by ONE entry; when it does not, nothing is posted and the row says so.
   */
  async classify(id: number, body: { classification?: unknown; note?: unknown; effectiveDate?: unknown }, userId: number | null) {
    const payment = await this.findOrThrow(id, { lock: true });
    const next = String(body.classification ?? "") as SupplierPaymentClassificationKind;
    if (!["advance", "security_deposit", "erroneous", "unknown"].includes(next)) {
      refuse("classification_unknown", "Classify the payment as an advance, a refundable security deposit, an erroneous payment, or not yet known.", "classification");
    }
    const current = payment.classification as SupplierPaymentClassificationKind;
    const from = supplierOnAccountAsset(current);
    const to = supplierOnAccountAsset(next);

    // Only what is still ON ACCOUNT can be reclassified — an amount already
    // applied to a bill has left the asset and is the bill's business now.
    const available = await this.availableOf(id);
    let entryId: number | null = null;
    let effectiveDate: string | null = null;

    if (from.systemCode !== to.systemCode && available > 0.005) {
      effectiveDate = typeof body.effectiveDate === "string" && body.effectiveDate ? body.effectiveDate : businessToday();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)) refuse("date_invalid", "The effective date is a YYYY-MM-DD date.", "effectiveDate");
      if (effectiveDate < payment.paidAt) refuse("date_before_payment", `The payment was made on ${payment.paidAt}; it cannot be reclassified on an earlier date.`, "effectiveDate");
      await checkPeriodOpen(effectiveDate);
      const entry = await postJournalEntry({
        entryNumber: `SRECLASS-${id}-${Date.now()}`,
        date: effectiveDate,
        description: `Reclassified ${current} → ${next}`,
        lines: [
          { systemCode: to.systemCode, accountName: to.accountName, description: `Reclassified from ${from.accountName}`, debitAmount: available, creditAmount: 0, party: { type: "vendor" as const, vendorId: payment.vendorId } },
          { systemCode: from.systemCode, accountName: from.accountName, description: `Reclassified to ${to.accountName}`, debitAmount: 0, creditAmount: available, party: { type: "vendor" as const, vendorId: payment.vendorId } },
        ],
      });
      entryId = entry.id;
    }

    await db.insert(supplierPaymentClassificationsTable).values({
      supplierPaymentId: id, classification: next, note: (body.note as string) ?? null,
      effectiveDate, journalEntryId: entryId, createdBy: userId,
    });
    await db.update(supplierPaymentsTable).set({ classification: next }).where(eq(supplierPaymentsTable.id, id));
    await auditService.record({ action: "classify", entityType: "supplier_payment", entityId: String(id), before: { classification: current }, after: { classification: next, journalEntryId: entryId } });
    return this.getById(id);
  },

  /** Money coming back from the supplier: the asset falls, the bank rises. */
  async refund(id: number, body: { amount?: unknown; bankAccountId?: unknown; refundedAt?: unknown; reason?: unknown }, userId: number | null) {
    const payment = await this.findOrThrow(id, { lock: true });
    const available = await this.availableOf(id);
    const amount = round2(Number(body.amount ?? available));
    if (!Number.isFinite(amount) || amount <= 0) refuse("amount_invalid", "A refund returns a positive amount.", "amount");
    if (amount > available + 0.005) {
      refuse("refund_exceeds_available", `Only ${available.toFixed(2)} of this payment is still on account; ${amount.toFixed(2)} was asked for.`, "amount", 409);
    }
    const reason = String(body.reason ?? "").trim();
    if (!reason) refuse("reason_required", "Say why the supplier is returning the money.", "reason");

    const bankAccountId = await assertBankAccount(body.bankAccountId ?? payment.bankAccountId, { what: "the refund was received into" });
    const refundedAt = typeof body.refundedAt === "string" && body.refundedAt ? body.refundedAt : businessToday();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(refundedAt)) refuse("date_invalid", "The refund date is a YYYY-MM-DD date.", "refundedAt");
    if (refundedAt < payment.paidAt) refuse("date_before_payment", `The payment was made on ${payment.paidAt}; money cannot come back before it left.`, "refundedAt");
    await checkPeriodOpen(refundedAt);

    const asset = supplierOnAccountAsset(payment.classification as SupplierPaymentClassificationKind);
    const [vendor] = await db.select().from(vendorsTable).where(eq(vendorsTable.id, payment.vendorId)).limit(1);
    const entry = await postJournalEntry({
      entryNumber: `SREFUND-${id}-${Date.now()}`,
      date: refundedAt,
      description: `Refund from ${vendor?.name ?? "supplier"}: ${reason}`,
      lines: [
        { bankAccountId, description: `Refund from ${vendor?.name ?? "supplier"}`, debitAmount: amount, creditAmount: 0 },
        { systemCode: asset.systemCode, accountName: asset.accountName, description: `Refund from ${vendor?.name ?? "supplier"}`, debitAmount: 0, creditAmount: amount, party: { type: "vendor" as const, vendorId: payment.vendorId } },
      ],
    });

    const [row] = await db.insert(supplierRefundsTable).values({
      supplierPaymentId: id, vendorId: payment.vendorId, bankAccountId,
      amount: String(amount), refundedAt, reason, journalEntryId: entry.id, createdBy: userId,
    }).returning();
    await auditService.created("supplier_refund", row!.id, row);
    return { id: row!.id, amount, refundedAt, journalEntryId: entry.id };
  },

  // ── reads ────────────────────────────────────────────────────────────────

  /**
   * `lock: true` takes the payment row FOR UPDATE inside the request's
   * transaction — every act that spends or moves what is still on account
   * (allocate, reverse, reclassify, refund) takes it, so they serialise.
   */
  async findOrThrow(id: number, opts: { lock?: boolean } = {}): Promise<SupplierPayment> {
    const q = db.select().from(supplierPaymentsTable).where(eq(supplierPaymentsTable.id, id)).limit(1);
    const [row] = opts.lock ? await q.for("update") : await q;
    if (!row) throw new NotFoundError("Supplier payment not found.");
    return row;
  },

  async entryDate(journalEntryId: number): Promise<string | null> {
    const { rows } = await db.execute<{ d: string }>(sql`SELECT date::date::text AS d FROM journal_entries WHERE id = ${journalEntryId}`);
    return rows[0]?.d ?? null;
  },

  /**
   * 🔴 What is still on account — DERIVED from the rows, never a stored
   * counter. Allocations that have been reversed do not count, and neither
   * does anything already refunded.
   */
  async availableOf(id: number): Promise<number> {
    const [row] = await db.execute<{ v: string }>(sql`
      SELECT (p.amount
              - coalesce((SELECT sum(a.amount) FROM supplier_payment_allocations a
                           WHERE a.supplier_payment_id = p.id
                             AND NOT EXISTS (SELECT 1 FROM supplier_payment_allocation_reversals r WHERE r.allocation_id = a.id)), 0)
              - coalesce((SELECT sum(f.amount) FROM supplier_refunds f WHERE f.supplier_payment_id = p.id), 0))::text v
         FROM supplier_payments p WHERE p.id = ${id}`).then((r) => r.rows);
    return round2(Number(row?.v ?? 0));
  },

  async getById(id: number) {
    const payment = await this.findOrThrow(id);
    const allocations = await db.execute<{ id: number; bill_id: number; bill_number: string; amount: string; je: number | null; reversed: boolean }>(sql`
      SELECT a.id, a.bill_id, b.bill_number, a.amount::text amount, a.journal_entry_id je,
             EXISTS (SELECT 1 FROM supplier_payment_allocation_reversals r WHERE r.allocation_id = a.id) reversed
        FROM supplier_payment_allocations a JOIN bills b ON b.id = a.bill_id
       WHERE a.supplier_payment_id = ${id} ORDER BY a.id`);
    const refunds = await db.select().from(supplierRefundsTable).where(eq(supplierRefundsTable.supplierPaymentId, id));
    const classifications = await db.select().from(supplierPaymentClassificationsTable)
      .where(eq(supplierPaymentClassificationsTable.supplierPaymentId, id)).orderBy(supplierPaymentClassificationsTable.id);
    return {
      id: payment.id, vendorId: payment.vendorId, bankAccountId: payment.bankAccountId,
      amount: Number(payment.amount), paidAt: payment.paidAt, method: payment.method,
      reference: payment.reference, notes: payment.notes,
      classification: payment.classification, source: payment.source,
      journalEntryId: payment.journalEntryId,
      availableAmount: await this.availableOf(id),
      allocations: allocations.rows.map((a) => ({
        id: a.id, billId: a.bill_id, billNumber: a.bill_number,
        amount: Number(a.amount), journalEntryId: a.je, reversed: a.reversed,
      })),
      refunds: refunds.map((r) => ({ id: r.id, amount: Number(r.amount), refundedAt: r.refundedAt, reason: r.reason })),
      classificationHistory: classifications.map((c) => ({
        id: c.id, classification: c.classification, note: c.note,
        effectiveDate: c.effectiveDate, journalEntryId: c.journalEntryId,
      })),
      createdAt: payment.createdAt.toISOString(),
    };
  },

  async list(filter: { vendorId?: number; classification?: string } = {}) {
    const rows = await db.select().from(supplierPaymentsTable)
      .where(and(
        filter.vendorId ? eq(supplierPaymentsTable.vendorId, filter.vendorId) : undefined,
        filter.classification ? eq(supplierPaymentsTable.classification, filter.classification) : undefined,
      ))
      .orderBy(supplierPaymentsTable.id);
    const out = [];
    for (const r of rows) {
      out.push({
        id: r.id, vendorId: r.vendorId, amount: Number(r.amount), paidAt: r.paidAt,
        reference: r.reference, classification: r.classification, source: r.source,
        availableAmount: await this.availableOf(r.id),
        journalEntryId: r.journalEntryId,
      });
    }
    return { items: out };
  },

  // ── internals ────────────────────────────────────────────────────────────

  /** Check every requested allocation against the bill it names, and against what the bill still owes. */
  async validateAllocations(requested: AllocationInput[], vendorId: number, cap: number) {
    const out: { billId: number; amount: number; billNumber: string }[] = [];
    let running = 0;

    /**
     * 🔴 A BILL IS NAMED ONCE PER REQUEST. Each line is checked against what
     * the bill owes in the DATABASE, which does not yet include the other
     * lines of the same request — so `[{bill 7, 100}, {bill 7, 100}]` against
     * a bill owing 100 passed both checks and over-settled it by 100. State
     * one amount per bill. (A LATER request applying more from the same
     * source to the same bill is a legitimate second application, checked
     * against the balance the first one left.)
     */
    const seen = new Set<number>();
    for (const r of requested) {
      const billId = Number(r?.billId);
      if (!Number.isInteger(billId) || billId <= 0) refuse("bill_unknown", "Each allocation names a bill.", "allocations");
      if (seen.has(billId)) refuse("allocation_duplicate_bill", `Bill ${billId} is named more than once in this request — state one amount per bill.`, "allocations");
      seen.add(billId);
    }

    /**
     * 🔴 Locked in ascending id order: two requests settling overlapping bills
     * take the locks in the same order, so they queue instead of deadlocking,
     * and the second reads the balance the first left behind.
     */
    const ordered = [...requested].sort((a, b) => Number(a.billId) - Number(b.billId));
    for (const r of ordered) {
      const billId = Number(r.billId);
      const amount = round2(Number(r.amount));
      if (!Number.isFinite(amount) || amount <= 0) refuse("allocation_amount_invalid", "Each allocation applies a positive amount.", "allocations");
      // Identity checks on an UNLOCKED read; the lock is taken below, only on
      // a valid target, so a request that is about to be refused (say, naming
      // a credit note another request is applying) never waits on its lock.
      const [bill] = await db.select().from(billsTable).where(eq(billsTable.id, billId)).limit(1);
      if (!bill) refuse("bill_unknown", `Bill ${billId} does not exist in this company.`, "allocations");
      if (bill!.vendorId !== vendorId) {
        refuse("bill_other_vendor", `Bill ${bill!.billNumber} belongs to a different supplier — money paid to one supplier cannot settle another's payable.`, "allocations");
      }
      if (["draft", "submitted"].includes(bill!.status)) {
        refuse("bill_not_approved", `Bill ${bill!.billNumber} is ${bill!.status} and carries no payable yet.`, "allocations", 409);
      }
      /**
       * 🔴 THE TARGET MUST BE SOMETHING THAT OWES. A posted CREDIT note is a
       * `bills` row in `received` status like any other, so without this an
       * advance could be "applied" to a note — settling a document that is
       * already a reduction of what we owe, and double-counting it. A DEBIT
       * note is a legitimate target: it is an additional charge.
       */
      if (bill!.documentType === "credit_note") {
        refuse("target_is_a_credit_note", `${bill!.billNumber} is a supplier credit note, not something you owe. Apply the note to a bill instead.`, "allocations", 409);
      }
      const outstanding = await billsRepository.outstandingOf(billId, { lock: true });
      if (amount > outstanding + 0.005) {
        refuse("allocation_exceeds_bill", `Bill ${bill!.billNumber} has ${outstanding.toFixed(2)} outstanding; ${amount.toFixed(2)} was applied to it.`, "allocations", 409);
      }
      running = round2(running + amount);
      out.push({ billId, amount, billNumber: bill!.billNumber });
    }
    /**
     * 🔴 THE ONE PLACE the cap is enforced, for BOTH callers and under ONE
     * code. `cap` is "what may be applied": the payment amount on create, what
     * is still on account on allocate. A second copy of this check in the
     * caller could never fire — this one runs first — while advertising a
     * different code to the client, so the rule lives here alone.
     */
    if (running > cap + 0.005) {
      refuse("allocation_exceeds_available", `The allocations total ${running.toFixed(2)} but only ${cap.toFixed(2)} is available.`, "allocations", 409);
    }
    return out;
  },

  /**
   * What a bill still owes — DERIVED, never a stored counter. The definition
   * is `repositories/billPosition` (read through the bills repository), the
   * same one the legacy pay path, the ageing, the Bills list and the vendor
   * balances use: one definition, so the subledger and every figure beside it
   * cannot disagree about a bill.
   */
  async outstandingOf(billId: number): Promise<number> {
    return billsRepository.outstandingOf(billId);
  },

  /**
   * Keep the bill's own status in step with what the subledger says it owes.
   *
   * 🔴 `paid_amount` is NOT touched here. It is the legacy per-bill counter
   * that `billsService.pay` maintains, and having two writers move one number
   * is exactly the drift this subledger exists to end. Outstanding is derived;
   * only `status` is a stored fact this path may set.
   */
  async refreshBill(billId: number) {
    const outstanding = await this.outstandingOf(billId);
    const [bill] = await db.select().from(billsTable).where(eq(billsTable.id, billId)).limit(1);
    if (!bill) return;
    const nextStatus = outstanding < 0.01 ? "paid" : bill.status === "paid" ? "received" : bill.status;
    if (nextStatus !== bill.status) {
      await db.update(billsTable).set({ status: nextStatus }).where(eq(billsTable.id, billId));
    }
  },
};
