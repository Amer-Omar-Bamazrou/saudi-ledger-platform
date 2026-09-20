/**
 * Phase D — the statement ↔ payment/refund matching reads and the two
 * append-only writes. Every query runs inside the tenant transaction (RLS).
 */
import { db, transactionsTable, paymentsTable, customerRefundsTable, statementMatchesTable, statementMatchReversalsTable, paymentAllocationsTable, paymentAllocationReversalsTable, invoicesTable } from "@workspace/db";
import { and, desc, eq, gte, isNotNull, isNull, lte, ne, sql } from "drizzle-orm";
import { paymentNotReversed, paymentNotReversedSql } from "./openingReversal";
import { companyScoped } from "./companyScope";

/** A Postgres text[] literal from already-validated upper-case tokens (letters, digits, hyphens only — `referenceTokens` guarantees it). */
function pgTextArray(tokens: string[]): string {
  const safe = tokens.filter((t) => /^[A-Z0-9-]+$/.test(t));
  return safe.length === 0 ? "ARRAY[]::text[]" : `ARRAY[${safe.map((t) => `'${t}'`).join(",")}]::text[]`;
}

export const statementMatchesRepository = {
  /** Statement rows (bank movements) in one bank — or every bank of the company — newest first. */
  statementRows(filter: { bankAccountId?: number; from?: string; to?: string; limit: number }) {
    return db
      .select()
      .from(transactionsTable)
      .where(
        and(
          // N1: the scoped company's rows only (RLS's company arm says the same; the query layer says it too).
          companyScoped(transactionsTable.companyId),
          isNotNull(transactionsTable.bankAccountId),
          filter.bankAccountId != null ? eq(transactionsTable.bankAccountId, filter.bankAccountId) : undefined,
          filter.from ? gte(transactionsTable.date, filter.from) : undefined,
          filter.to ? lte(transactionsTable.date, filter.to) : undefined,
        ),
      )
      .orderBy(desc(transactionsTable.date), desc(transactionsTable.id))
      .limit(filter.limit);
  },

  findRow(id: number) {
    return db.select().from(transactionsTable).where(eq(transactionsTable.id, id)).limit(1);
  },

  /** Every ACTIVE match of the company, keyed by row and by target by the caller. */
  activeMatches() {
    return db
      .select({ m: statementMatchesTable })
      .from(statementMatchesTable)
      .leftJoin(statementMatchReversalsTable, eq(statementMatchReversalsTable.matchId, statementMatchesTable.id))
      .where(isNull(statementMatchReversalsTable.id));
  },

  findMatch(id: number) {
    return db
      .select({ m: statementMatchesTable, r: statementMatchReversalsTable })
      .from(statementMatchesTable)
      .leftJoin(statementMatchReversalsTable, eq(statementMatchReversalsTable.matchId, statementMatchesTable.id))
      .where(eq(statementMatchesTable.id, id))
      .limit(1);
  },

  matchesForRow(transactionId: number) {
    return db
      .select({ m: statementMatchesTable, r: statementMatchReversalsTable })
      .from(statementMatchesTable)
      .leftJoin(statementMatchReversalsTable, eq(statementMatchReversalsTable.matchId, statementMatchesTable.id))
      .where(eq(statementMatchesTable.transactionId, transactionId))
      .orderBy(statementMatchesTable.id);
  },

  findMatchByIdempotencyKey(key: string) {
    return db.select().from(statementMatchesTable).where(eq(statementMatchesTable.idempotencyKey, key)).limit(1);
  },

  /** Receipts in the company that could be a statement row's counterpart: not created FROM a statement row, not actively matched. */
  candidateReceipts(filter: { bankAccountId: number; amount: number; from: string; to: string }) {
    return db
      .select({ p: paymentsTable })
      .from(paymentsTable)
      .leftJoin(
        statementMatchesTable,
        and(eq(statementMatchesTable.paymentId, paymentsTable.id), sql`NOT EXISTS (SELECT 1 FROM statement_match_reversals r WHERE r.match_id = ${statementMatchesTable.id})`),
      )
      .where(
        and(
          companyScoped(paymentsTable.companyId),
          eq(paymentsTable.direction, "in"),
          // A migrated deposit's cash is INSIDE the bank's opening balance (Batch 1C): it has no
          // statement row of its own, reversed or not — and a reversed one is history (openingReversal.ts).
          ne(paymentsTable.source, "opening"),
          paymentNotReversed(),
          eq(paymentsTable.bankAccountId, filter.bankAccountId),
          eq(paymentsTable.amount, filter.amount.toFixed(2)),
          gte(paymentsTable.paidAt, filter.from),
          lte(paymentsTable.paidAt, filter.to),
          isNull(paymentsTable.sourceTransactionId),
          isNull(statementMatchesTable.id),
        ),
      );
  },

  /** Refunds in the company that could be a debit row's counterpart: not actively matched. */
  candidateRefunds(filter: { bankAccountId: number; amount: number; from: string; to: string }) {
    return db
      .select({ f: customerRefundsTable })
      .from(customerRefundsTable)
      .leftJoin(
        statementMatchesTable,
        and(eq(statementMatchesTable.refundId, customerRefundsTable.id), sql`NOT EXISTS (SELECT 1 FROM statement_match_reversals r WHERE r.match_id = ${statementMatchesTable.id})`),
      )
      .where(
        and(
          companyScoped(customerRefundsTable.companyId),
          eq(customerRefundsTable.bankAccountId, filter.bankAccountId),
          eq(customerRefundsTable.amount, filter.amount.toFixed(2)),
          gte(customerRefundsTable.refundedAt, filter.from),
          lte(customerRefundsTable.refundedAt, filter.to),
          isNull(statementMatchesTable.id),
        ),
      );
  },

  /** Every receipt whose own reference, receipt number or an allocated invoice number appears in the text — regardless of bank/amount/date (the INCONSISTENT probe). */
  async receiptsReferencedBy(tokens: string[]) {
    if (tokens.length === 0) return [] as Array<{ id: number; bankAccountId: number; amount: string; paidAt: string; direction: string; reference: string | null; sourceTransactionId: number | null; via: string }>;
    const rows = await db.execute<{ id: number; bank_account_id: number; amount: string; paid_at: string; direction: string; reference: string | null; source_transaction_id: number | null; via: string }>(sql`
      SELECT DISTINCT p.id, p.bank_account_id, p.amount::text, p.paid_at::text, p.direction, p.reference, p.source_transaction_id,
             CASE WHEN upper(coalesce(p.reference,'')) = ANY(${sql.raw(pgTextArray(tokens))}) THEN 'reference'
                  WHEN ('RCPT-' || p.id::text) = ANY(${sql.raw(pgTextArray(tokens))}) THEN 'receipt_number'
                  ELSE 'invoice_number' END AS via
        FROM payments p
        LEFT JOIN payment_allocations a ON a.payment_id = p.id AND NOT EXISTS (SELECT 1 FROM payment_allocation_reversals r WHERE r.allocation_id = a.id)
        LEFT JOIN invoices i ON i.id = a.invoice_id
       WHERE p.direction = 'in' AND p.source <> 'opening' AND ${paymentNotReversedSql("p")}
         AND (upper(coalesce(p.reference,'')) = ANY(${sql.raw(pgTextArray(tokens))}) OR ('RCPT-' || p.id::text) = ANY(${sql.raw(pgTextArray(tokens))}) OR upper(coalesce(i.invoice_number,'')) = ANY(${sql.raw(pgTextArray(tokens))}))`);
    return rows.rows.map((r) => ({ id: r.id, bankAccountId: r.bank_account_id, amount: r.amount, paidAt: r.paid_at, direction: r.direction, reference: r.reference, sourceTransactionId: r.source_transaction_id, via: r.via }));
  },

  async refundsReferencedBy(tokens: string[]) {
    if (tokens.length === 0) return [] as Array<{ id: number; bankAccountId: number; amount: string; refundedAt: string; reference: string | null; via: string }>;
    const rows = await db.execute<{ id: number; bank_account_id: number; amount: string; refunded_at: string; reference: string | null; via: string }>(sql`
      SELECT f.id, f.bank_account_id, f.amount::text, f.refunded_at::text, f.reference,
             CASE WHEN upper(coalesce(f.reference,'')) = ANY(${sql.raw(pgTextArray(tokens))}) THEN 'reference' ELSE 'refund_number' END AS via
        FROM customer_refunds f
       WHERE upper(coalesce(f.reference,'')) = ANY(${sql.raw(pgTextArray(tokens))}) OR ('REFUND-' || f.id::text) = ANY(${sql.raw(pgTextArray(tokens))})`);
    return rows.rows.map((r) => ({ id: r.id, bankAccountId: r.bank_account_id, amount: r.amount, refundedAt: r.refunded_at, reference: r.reference, via: r.via }));
  },

  /** Invoice numbers a receipt is actively allocated to — the reference tokens a payment can be identified by. */
  async allocatedInvoiceNumbers(paymentId: number): Promise<string[]> {
    const rows = await db
      .select({ n: invoicesTable.invoiceNumber })
      .from(paymentAllocationsTable)
      .innerJoin(invoicesTable, eq(invoicesTable.id, paymentAllocationsTable.invoiceId))
      .leftJoin(paymentAllocationReversalsTable, eq(paymentAllocationReversalsTable.allocationId, paymentAllocationsTable.id))
      .where(and(eq(paymentAllocationsTable.paymentId, paymentId), isNull(paymentAllocationReversalsTable.id)));
    return rows.map((r) => r.n);
  },

  async nextMatchId(): Promise<number> {
    const r = await db.execute<{ id: string }>(sql`SELECT nextval('statement_matches_id_seq') AS id`);
    return Number(r.rows[0]!.id);
  },

  async insertMatch(values: typeof statementMatchesTable.$inferInsert) {
    const [row] = await db.insert(statementMatchesTable).values(values).returning();
    return row!;
  },

  async insertReversal(values: typeof statementMatchReversalsTable.$inferInsert) {
    const [row] = await db.insert(statementMatchReversalsTable).values(values).returning();
    return row!;
  },

  /** The receipt created FROM this row by a settlement, if any — matched by construction. */
  settlementPaymentFor(transactionId: number) {
    return db.select().from(paymentsTable).where(eq(paymentsTable.sourceTransactionId, transactionId)).limit(1);
  },

  findPayment(id: number) {
    return db.select().from(paymentsTable).where(eq(paymentsTable.id, id)).limit(1);
  },

  findRefund(id: number) {
    return db.select().from(customerRefundsTable).where(eq(customerRefundsTable.id, id)).limit(1);
  },
};
