/**
 * B4 — the dated payment record (invoice_payments / bill_payments).
 *
 * Written ONLY by the pay paths (`invoicesService.pay` / `billsService.pay`),
 * in the same tenant transaction as the running-total update — a record
 * beside the posting, never a second posting path. Append-only at the DB
 * grants (no UPDATE/DELETE for the app role).
 *
 * 🔴 `backfilled` rows are AGGREGATES of pre-B4 payments (the split and
 * earlier dates were never recorded). Consumers that would be wrong on
 * aggregates — DSO, collection-speed, instalment analytics — must filter
 * `backfilled = false`.
 */
import { db, invoicePaymentsTable, billPaymentsTable, paymentsTable, paymentAllocationsTable, paymentAllocationReversalsTable, customerRefundsTable, invoicesTable } from "@workspace/db";
import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";

export const paymentsRepository = {
  // N3: both return the inserted row — its id is what suffixes the payment's
  // GL entry number so instalments never mint the same document twice.
  // (Worded without naming the column: the blind-repository check greps this
  // file, and a comment must not read as a filter.)
  // D-3: the bank the money moved through is part of the record — the
  // evidence that makes this payment's bank identity deterministic later.
  async recordInvoicePayment(invoiceId: number, amount: number, paidAt: string, bankAccountId: number) {
    const [row] = await db.insert(invoicePaymentsTable).values({ invoiceId, amount: String(amount), paidAt, bankAccountId }).returning();
    return row;
  },

  async recordBillPayment(billId: number, amount: number, paidAt: string, bankAccountId: number) {
    const [row] = await db.insert(billPaymentsTable).values({ billId, amount: String(amount), paidAt, bankAccountId }).returning();
    return row;
  },

  async listForInvoice(invoiceId: number) {
    return db
      .select()
      .from(invoicePaymentsTable)
      .where(eq(invoicePaymentsTable.invoiceId, invoiceId))
      .orderBy(desc(invoicePaymentsTable.paidAt), desc(invoicePaymentsTable.id));
  },

  async listForBill(billId: number) {
    return db
      .select()
      .from(billPaymentsTable)
      .where(eq(billPaymentsTable.billId, billId))
      .orderBy(desc(billPaymentsTable.paidAt), desc(billPaymentsTable.id));
  },

  // ── D-4 (2026-09-17): the payment entity and its allocations ────────────
  // `payments` / `payment_allocations` are append-only for the app role (no
  // UPDATE/DELETE grant); a payment's journal entry is numbered from the
  // payment's id, so the id is drawn from the sequence BEFORE the entry is
  // posted and the row is inserted with that id afterwards — one payment,
  // one entry, no update.

  async nextPaymentId(): Promise<number> {
    const r = await db.execute<{ id: string }>(sql`SELECT nextval('payments_id_seq') AS id`);
    return Number(r.rows[0]!.id);
  },

  async nextAllocationId(): Promise<number> {
    const r = await db.execute<{ id: string }>(sql`SELECT nextval('payment_allocations_id_seq') AS id`);
    return Number(r.rows[0]!.id);
  },

  async insertPayment(values: typeof paymentsTable.$inferInsert) {
    const [row] = await db.insert(paymentsTable).values(values).returning();
    return row!;
  },

  async insertAllocation(values: typeof paymentAllocationsTable.$inferInsert) {
    const [row] = await db.insert(paymentAllocationsTable).values(values).returning();
    return row!;
  },

  findPaymentById(id: number) {
    return db.select().from(paymentsTable).where(eq(paymentsTable.id, id)).limit(1);
  },

  /**
   * The payment row, serialised for the rest of this transaction — allocation
   * arithmetic reads it under the lock. A transaction-scoped ADVISORY lock,
   * not `FOR UPDATE`: the app role has no UPDATE privilege on `payments`
   * (append-only), and Postgres requires it for a row lock. Two concurrent
   * allocations of one payment therefore queue here and the second sees the
   * first's rows when it reads the allocated total.
   */
  async lockPayment(id: number) {
    await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${"payment:" + id}, 0))`);
    return db.select().from(paymentsTable).where(eq(paymentsTable.id, id)).limit(1);
  },

  findPaymentByIdempotencyKey(key: string) {
    return db.select().from(paymentsTable).where(eq(paymentsTable.idempotencyKey, key)).limit(1);
  },

  findAllocationByIdempotencyKey(key: string) {
    return db.select().from(paymentAllocationsTable).where(eq(paymentAllocationsTable.idempotencyKey, key)).limit(1);
  },

  listPayments(filter: { customerId?: number; limit: number; offset: number }) {
    return db
      .select()
      .from(paymentsTable)
      .where(filter.customerId != null ? eq(paymentsTable.customerId, filter.customerId) : undefined)
      .orderBy(desc(paymentsTable.paidAt), desc(paymentsTable.id))
      .limit(filter.limit)
      .offset(filter.offset);
  },

  // Phase A: an allocation is ACTIVE until a reversal row names it. Readers
  // carry the reversal beside the allocation (history stays visible) and sum
  // only the active ones.

  allocationsOfPayment(paymentId: number) {
    return db
      .select({ alloc: paymentAllocationsTable, reversal: paymentAllocationReversalsTable })
      .from(paymentAllocationsTable)
      .leftJoin(paymentAllocationReversalsTable, eq(paymentAllocationReversalsTable.allocationId, paymentAllocationsTable.id))
      .where(eq(paymentAllocationsTable.paymentId, paymentId))
      .orderBy(paymentAllocationsTable.id);
  },

  allocationsOfCreditNote(creditNoteId: number) {
    return db
      .select({ alloc: paymentAllocationsTable, reversal: paymentAllocationReversalsTable })
      .from(paymentAllocationsTable)
      .leftJoin(paymentAllocationReversalsTable, eq(paymentAllocationReversalsTable.allocationId, paymentAllocationsTable.id))
      .where(eq(paymentAllocationsTable.creditNoteId, creditNoteId))
      .orderBy(paymentAllocationsTable.id);
  },

  /** Every ACTIVE allocation that settled one invoice, with the payment behind it when there is one. */
  allocationsForInvoice(invoiceId: number) {
    return db
      .select({ alloc: paymentAllocationsTable, payment: paymentsTable })
      .from(paymentAllocationsTable)
      .leftJoin(paymentsTable, eq(paymentsTable.id, paymentAllocationsTable.paymentId))
      .leftJoin(paymentAllocationReversalsTable, eq(paymentAllocationReversalsTable.allocationId, paymentAllocationsTable.id))
      .where(and(eq(paymentAllocationsTable.invoiceId, invoiceId), isNull(paymentAllocationReversalsTable.id)))
      .orderBy(paymentAllocationsTable.id);
  },

  /** One allocation with its reversal (if any) — the unallocation path's read. */
  findAllocation(id: number) {
    return db
      .select({ alloc: paymentAllocationsTable, reversal: paymentAllocationReversalsTable })
      .from(paymentAllocationsTable)
      .leftJoin(paymentAllocationReversalsTable, eq(paymentAllocationReversalsTable.allocationId, paymentAllocationsTable.id))
      .where(eq(paymentAllocationsTable.id, id))
      .limit(1);
  },

  /** An ACTIVE allocation already linking this source to this invoice, if any (one active per pair — enforced under the source lock). */
  activeAllocationFor(source: { paymentId?: number; creditNoteId?: number }, invoiceId: number) {
    return db
      .select({ id: paymentAllocationsTable.id })
      .from(paymentAllocationsTable)
      .leftJoin(paymentAllocationReversalsTable, eq(paymentAllocationReversalsTable.allocationId, paymentAllocationsTable.id))
      .where(
        and(
          source.paymentId != null ? eq(paymentAllocationsTable.paymentId, source.paymentId) : eq(paymentAllocationsTable.creditNoteId, source.creditNoteId!),
          eq(paymentAllocationsTable.invoiceId, invoiceId),
          isNull(paymentAllocationReversalsTable.id),
        ),
      )
      .limit(1);
  },

  async insertReversal(values: typeof paymentAllocationReversalsTable.$inferInsert) {
    const [row] = await db.insert(paymentAllocationReversalsTable).values(values).returning();
    return row!;
  },

  async nextReversalId(): Promise<number> {
    const r = await db.execute<{ id: string }>(sql`SELECT nextval('payment_allocation_reversals_id_seq') AS id`);
    return Number(r.rows[0]!.id);
  },

  findReversalByIdempotencyKey(key: string) {
    return db.select().from(paymentAllocationReversalsTable).where(eq(paymentAllocationReversalsTable.idempotencyKey, key)).limit(1);
  },

  /** Σ ACTIVE allocations per payment — the unapplied remainder is `amount − this − refunds`. */
  async allocatedTotals(paymentIds: number[]): Promise<Map<number, number>> {
    if (paymentIds.length === 0) return new Map();
    const rows = await db
      .select({ paymentId: paymentAllocationsTable.paymentId, total: sql<string>`sum(${paymentAllocationsTable.amount})` })
      .from(paymentAllocationsTable)
      .leftJoin(paymentAllocationReversalsTable, eq(paymentAllocationReversalsTable.allocationId, paymentAllocationsTable.id))
      .where(and(isNotNull(paymentAllocationsTable.paymentId), inArray(paymentAllocationsTable.paymentId, paymentIds), isNull(paymentAllocationReversalsTable.id)))
      .groupBy(paymentAllocationsTable.paymentId);
    return new Map(rows.map((r) => [r.paymentId as number, Number(r.total)]));
  },

  // ── Phase C: refunds ────────────────────────────────────────────────────
  async nextRefundId(): Promise<number> {
    const r = await db.execute<{ id: string }>(sql`SELECT nextval('customer_refunds_id_seq') AS id`);
    return Number(r.rows[0]!.id);
  },

  async insertRefund(values: typeof customerRefundsTable.$inferInsert) {
    const [row] = await db.insert(customerRefundsTable).values(values).returning();
    return row!;
  },

  findRefundById(id: number) {
    return db.select().from(customerRefundsTable).where(eq(customerRefundsTable.id, id)).limit(1);
  },

  findRefundByIdempotencyKey(key: string) {
    return db.select().from(customerRefundsTable).where(eq(customerRefundsTable.idempotencyKey, key)).limit(1);
  },

  listRefunds(filter: { customerId?: number; limit: number; offset: number }) {
    return db
      .select()
      .from(customerRefundsTable)
      .where(filter.customerId != null ? eq(customerRefundsTable.customerId, filter.customerId) : undefined)
      .orderBy(desc(customerRefundsTable.refundedAt), desc(customerRefundsTable.id))
      .limit(filter.limit)
      .offset(filter.offset);
  },

  /** Σ refunded out of one receipt's deposit, or out of one credit note's balance. */
  async refundedFrom(source: { paymentId?: number; creditNoteId?: number }): Promise<number> {
    const rows = await db
      .select({ total: sql<string>`coalesce(sum(${customerRefundsTable.amount}), 0)` })
      .from(customerRefundsTable)
      .where(source.paymentId != null ? eq(customerRefundsTable.paymentId, source.paymentId) : eq(customerRefundsTable.creditNoteId, source.creditNoteId!));
    return Number(rows[0]?.total ?? 0);
  },
};

/** Kept beside the payments repository so the two caches have one writer set. */
export const invoiceSettlementRepository = {
  /** The invoices, locked FOR UPDATE — every outstanding-balance check and cache write happens under this lock. */
  lockInvoices(ids: number[]) {
    if (ids.length === 0) return Promise.resolve([] as (typeof invoicesTable.$inferSelect)[]);
    return db.select().from(invoicesTable).where(inArray(invoicesTable.id, ids)).for("update");
  },

  /** paid_amount / credited_amount are CACHES of Σ allocations, written only here and asserted equal by the invariants test. */
  async bumpSettled(invoiceId: number, delta: { paid?: number; credited?: number }, paidAt?: string, status?: string) {
    const [row] = await db
      .update(invoicesTable)
      .set({
        ...(delta.paid ? { paidAmount: sql`coalesce(${invoicesTable.paidAmount}, 0) + ${delta.paid.toFixed(2)}::numeric` } : {}),
        ...(delta.credited ? { creditedAmount: sql`${invoicesTable.creditedAmount} + ${delta.credited.toFixed(2)}::numeric` } : {}),
        ...(paidAt ? { paidAt } : {}),
        ...(status ? { status } : {}),
      })
      .where(eq(invoicesTable.id, invoiceId))
      .returning();
    return row!;
  },
};
