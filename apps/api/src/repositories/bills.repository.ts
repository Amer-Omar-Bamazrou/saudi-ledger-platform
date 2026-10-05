/** Bills repository — tenant-scoped via RLS. */
import { db, billsTable, billItemsTable, vendorsTable, billPaymentsTable, bankAccountsTable } from "@workspace/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { billNotReversed } from "./openingReversal";
import { billIsPayableSql, billOutstandingSql } from "./billPosition";
import { capturedDocumentsRepository } from "./capturedDocuments.repository";

/**
 * 🔴 PHASE 11 PART 2 — what a bill still owes comes from `billPosition`, the
 * one definition: a credit note owes nothing, and money applied through the AP
 * subledger counts as well as `paid_amount`. Every figure below reads it; none
 * restates `total − paid_amount`.
 */
const OUTSTANDING = billOutstandingSql("bills");
/** Z-AP1: Σ the supplier advance deductions on a final bill (its prepayment rows). */
const PREPAID = sql<string>`coalesce((SELECT sum(bp.amount) FROM bill_prepayments bp WHERE bp.bill_id = ${billsTable}."id"), 0)::text`; // qualified: a bare "id" would bind to bp.id

export interface BillListFilter {
  status?: string;
  vendorId?: number;
  /** Derived, not stored — see `OVERDUE`. `status` is ignored when this is set. */
  overdue?: boolean;
  limit?: number;
  offset?: number;
}

/** The default page. Stated once so the API, the UI and the tests agree. */
export const DEFAULT_PAGE = 50;

/**
 * 🔴 OVERDUE IS DERIVED FROM DATES — the bills half of the same rule.
 *
 * `bills.status` carried an `'overdue'` value nothing wrote. The Bills page
 * counted it with `bills.filter(b => b.status === "overdue").length`, which was
 * wrong twice over: the value never appears, AND the count was taken over the
 * fetched PAGE rather than the filtered set. It rendered 0 either way, so
 * neither defect was visible.
 *
 * Same rule as invoices, including the `COALESCE(due_date, date)` fallback, so
 * AP aging and this figure answer the same question.
 */
const OVERDUE = sql`(
  COALESCE(NULLIF(${billsTable.dueDate}, ''), ${billsTable.date})::date < CURRENT_DATE
  AND ${billsTable.status} NOT IN ('draft','submitted','rejected','paid')
  AND ${billIsPayableSql("bills")}
  AND ${OUTSTANDING} > 0
)`;

/** One predicate for the rows AND the totals — so they cannot describe different sets. */
function billListConditions(filter: BillListFilter) {
  // Policy C: a reversed opening bill is excluded from the live list and its totals (openingReversal.ts).
  const conditions: unknown[] = [billNotReversed()];
  if (filter.overdue) conditions.push(OVERDUE);
  else if (filter.status) conditions.push(eq(billsTable.status, filter.status));
  if (filter.vendorId) conditions.push(eq(billsTable.vendorId, filter.vendorId));
  return and(...(conditions as Parameters<typeof and>));
}

/** An ILIKE pattern for a free-text search, with the wildcards in the user's text escaped; null when blank. */
function likeOf(q: string | undefined): string | null {
  const s = (q ?? "").trim();
  return s ? `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
}

export const billsRepository = {
  /** A PAGE. See the note on `invoicesRepository.list` for why offset, not cursor. */
  list(filter: BillListFilter) {
    return db
      .select({ bill: billsTable, vendor: vendorsTable, outstanding: sql<string>`${OUTSTANDING}`, prepaid: PREPAID })
      .from(billsTable)
      .leftJoin(vendorsTable, eq(billsTable.vendorId, vendorsTable.id))
      .where(billListConditions(filter))
      .orderBy(desc(billsTable.date), desc(billsTable.id))
      .limit(filter.limit ?? DEFAULT_PAGE)
      .offset(filter.offset ?? 0);
  },

  /** Totals in SQL over the WHOLE filtered set — never over the page. */
  async listMeta(filter: BillListFilter) {
    const [row] = await db
      .select({
        total: sql<number>`count(*)::int`,
        // A credit note owes nothing and is never "paid" — see billPosition.
        outstanding: sql<number>`COALESCE(SUM(
          CASE WHEN ${billsTable.status} NOT IN ('draft','submitted','rejected')
               THEN greatest(${OUTSTANDING}, 0) ELSE 0 END), 0)::float8`,
        paid: sql<number>`COALESCE(SUM(
          CASE WHEN ${billsTable.status} = 'paid' AND ${billIsPayableSql("bills")} THEN ${billsTable.total} ELSE 0 END), 0)::float8`,
        // In SQL over the whole filtered set — the page-local `.filter().length`
        // it replaces was a count of one page wearing a total's label.
        overdue: sql<number>`COUNT(*) FILTER (WHERE ${OVERDUE})::int`,
      })
      .from(billsTable)
      .where(billListConditions(filter));
    return {
      total: Number(row?.total ?? 0),
      outstanding: Number(row?.outstanding ?? 0),
      paid: Number(row?.paid ?? 0),
      overdue: Number(row?.overdue ?? 0),
    };
  },

  findWithVendor(id: number) {
    return db
      .select({ bill: billsTable, vendor: vendorsTable, outstanding: sql<string>`${OUTSTANDING}`, prepaid: PREPAID })
      .from(billsTable)
      .leftJoin(vendorsTable, eq(billsTable.vendorId, vendorsTable.id))
      .where(eq(billsTable.id, id))
      .limit(1);
  },

  findById(id: number) {
    return db.select().from(billsTable).where(eq(billsTable.id, id)).limit(1);
  },

  /**
   * What one document still owes — `billPosition`'s definition, read in SQL.
   *
   * 🔴 `lock: true` takes the bill row FOR UPDATE inside the request's
   * transaction. Every path that applies money to a bill — the legacy pay
   * path and the AP subledger — reads this under the lock, so two concurrent
   * writers serialise on the bill and the second reads the balance the first
   * left, instead of both reading the same balance and over-settling it.
   */
  async outstandingOf(id: number, opts: { lock?: boolean } = {}): Promise<number> {
    const { rows } = await db.execute<{ v: string }>(sql`
      SELECT ${billOutstandingSql("b")}::text AS v FROM bills b WHERE b.id = ${id}
      ${opts.lock ? sql`FOR UPDATE OF b` : sql``}`);
    return Math.round(Number(rows[0]?.v ?? 0) * 100) / 100;
  },

  /**
   * Open bills a bank debit could pay (M16.3 reconciliation). "Open" mirrors
   * AP aging: approved (bills have no hash — `status` past the draft/submitted
   * queue IS the approval marker), not fully paid, outstanding >= 0.01.
   */
  openForSettlement() {
    return db
      .select({ bill: billsTable, vendor: vendorsTable, outstanding: sql<string>`${OUTSTANDING}`, prepaid: PREPAID })
      .from(billsTable)
      .leftJoin(vendorsTable, eq(billsTable.vendorId, vendorsTable.id))
      .where(
        and(
          sql`${billsTable.status} NOT IN ('draft','submitted','paid')`,
          billNotReversed(), // Policy C: a reversed opening bill is never offered for settlement
          // A credit note is not something a bank debit pays; a bill already
          // settled through the AP subledger is not open.
          billIsPayableSql("bills"),
          sql`${OUTSTANDING} >= 0.01`,
        ),
      )
      .orderBy(desc(billsTable.date), desc(billsTable.id));
  },

  itemsByBill(id: number) {
    return db.select().from(billItemsTable).where(eq(billItemsTable.billId, id));
  },

  insert(values: typeof billsTable.$inferInsert) {
    return db.insert(billsTable).values(values).returning();
  },

  insertItems(values: (typeof billItemsTable.$inferInsert)[]) {
    return db.insert(billItemsTable).values(values);
  },

  update(id: number, values: Partial<typeof billsTable.$inferInsert>) {
    return db.update(billsTable).set(values).where(eq(billsTable.id, id)).returning();
  },

  /**
   * Q1 (pack §14.1): a bill payment a WHT correction REVERSED leaves the legacy
   * counter — `paid_amount` stays "Σ live bill payments", so `billPosition` reads
   * the bill as owing it again with no change to the one definition. The second
   * writer of the counter, beside the pay path; one statement, under the bill's
   * row lock the caller already holds. Refuses (no row) rather than go negative.
   */
  async reverseBillPayment(id: number, amount: number) {
    const { rows } = await db.execute<{ id: number }>(sql`
      UPDATE bills SET paid_amount = (coalesce(paid_amount::numeric, 0) - ${amount}::numeric)
       WHERE id = ${id} AND coalesce(paid_amount::numeric, 0) - ${amount}::numeric >= 0 RETURNING id`);
    return rows.length === 1;
  },

  /**
   * 🔴 Phase 13A — the bill row, locked FOR UPDATE. Every write to a posted
   * document's held input VAT (a credit note reducing it, the evidence entry
   * claiming it) takes this lock first, so the two serialise and the second
   * reads the balance the first left.
   */
  async lockForUpdate(id: number) {
    const { rows } = await db.execute<{ id: number }>(sql`SELECT id FROM bills WHERE id = ${id} FOR UPDATE`);
    if (rows.length === 0) return null;
    const [row] = await db.select().from(billsTable).where(eq(billsTable.id, id)).limit(1);
    return row ?? null;
  },

  /**
   * Phase 13A (X3) — the posted supplier credit notes whose VAT reduced THIS
   * bill's held VAT: they follow it into the claim, in the same period.
   */
  /** The latest date among the posted credit notes still following this bill's held VAT, or null. */
  async latestHeldNoteDate(originalId: number): Promise<string | null> {
    const [row] = await db
      .select({ d: sql<string | null>`max(${billsTable.date})` })
      .from(billsTable)
      .where(and(
        eq(billsTable.creditNoteAgainstBillId, originalId),
        eq(billsTable.documentType, "credit_note"),
        eq(billsTable.inputVatState, "awaiting_evidence"),
        sql`${billsTable.status} NOT IN ('draft','submitted')`,
      ));
    return row?.d ?? null;
  },

  claimNotesFollowing(originalId: number, claimedOn: string, entryId: number | null) {
    return db
      .update(billsTable)
      .set({ inputVatState: "claimed", inputVatClaimedOn: claimedOn, inputVatClaimEntryId: entryId })
      .where(and(
        eq(billsTable.creditNoteAgainstBillId, originalId),
        eq(billsTable.documentType, "credit_note"),
        eq(billsTable.inputVatState, "awaiting_evidence"),
        sql`${billsTable.status} NOT IN ('draft','submitted')`,
      ))
      .returning({ id: billsTable.id });
  },

  /** Phase 13A: every UNPOSTED bill of a supplier — re-decided when the supplier's VAT number changes. */
  async unpostedIdsForVendor(vendorId: number): Promise<number[]> {
    const rows = await db
      .select({ id: billsTable.id })
      .from(billsTable)
      .where(and(eq(billsTable.vendorId, vendorId), sql`${billsTable.status} IN ('draft','submitted')`));
    return rows.map((r) => r.id);
  },

  /**
   * 🔴 Phase 13A — THE DOCUMENTS HELD FOR VAT EVIDENCE: purchase documents
   * whose input VAT is NOT claimed because the evidence does not support it
   * yet. This list is where held VAT is found and released, so it is a real
   * list: filterable by reason, searchable, paged, with set-wide counts (never
   * a count of the page).
   *
   * Held (accountant X1, 2026-09-27) =
   *   · POSTED with its VAT in VAT_AWAITING_EVIDENCE (`input_vat_state`), or
   *   · a DRAFT whose verdict is awaiting evidence (it will post into the
   *     holding account), or a draft older than Phase 13 carrying VAT.
   * NOT held: Art. 50 blocked VAT and a 0 %-recovery asset — their VAT is part
   * of the cost (X5), a final treatment with nothing to wait for. The one
   * membership predicate below serves the list, its counts and its reasons.
   * Company scope explicit (N1).
   */
  heldSql(alias: string) {
    const c = (col: string) => sql.raw(`${alias}.${col}`);
    return sql`(${c("company_id")}::text = current_setting('app.current_company_id', true)
      AND ((${c("status")} NOT IN ('draft','submitted') AND ${c("input_vat_state")} = 'awaiting_evidence')
        OR (${c("status")} IN ('draft','submitted')
            AND (${c("vat_evidence_status")} = 'awaiting_evidence'
              OR (${c("vat_evidence_status")} = 'not_evaluated' AND ${c("vat_amount")} > 0)))))`;
  },

  heldConditions(filter: { reason?: string; q?: string }) {
    const conds = [this.heldSql('"bills"')];
    if (filter.reason) {
      conds.push(filter.reason === "not_evaluated"
        ? sql`${billsTable.vatEvidenceStatus} = 'not_evaluated'`
        : sql`${billsTable.vatEvidenceFlags} @> ${JSON.stringify([{ code: filter.reason }])}::jsonb`);
    }
    const like = likeOf(filter.q);
    if (like) conds.push(sql`(${billsTable.billNumber} ILIKE ${like} OR ${billsTable.vendorReference} ILIKE ${like} OR ${vendorsTable.name} ILIKE ${like})`);
    return and(...conds);
  },

  heldForEvidence(filter: { reason?: string; q?: string; limit: number; offset: number }) {
    return db
      .select({ bill: billsTable, vendor: vendorsTable })
      .from(billsTable)
      .leftJoin(vendorsTable, eq(billsTable.vendorId, vendorsTable.id))
      .where(this.heldConditions(filter))
      .orderBy(billsTable.date, billsTable.id)
      .limit(filter.limit)
      .offset(filter.offset);
  },

  /**
   * Set-wide figures for the held list — over every matching row, never the
   * page. Held VAT is what is actually not claimed: a posted document's HELD
   * amount (net of credit notes and of advance VAT already claimed), a
   * draft's VAT.
   */
  async heldMeta(filter: { reason?: string; q?: string }) {
    const posted = sql`${billsTable.status} NOT IN ('draft','submitted')`;
    const [row] = await db
      .select({
        total: sql<number>`count(*)::int`,
        heldVat: sql<number>`coalesce(sum(CASE WHEN ${posted} THEN ${billsTable.inputVatPending} ELSE ${billsTable.vatAmount} END), 0)::float8`,
        postedHeld: sql<number>`count(*) FILTER (WHERE ${posted})::int`,
        awaiting: sql<number>`count(*) FILTER (WHERE NOT (${posted}) AND ${billsTable.vatEvidenceStatus} = 'awaiting_evidence')::int`,
        notEvaluated: sql<number>`count(*) FILTER (WHERE NOT (${posted}) AND ${billsTable.vatEvidenceStatus} = 'not_evaluated')::int`,
      })
      .from(billsTable)
      .leftJoin(vendorsTable, eq(billsTable.vendorId, vendorsTable.id))
      .where(this.heldConditions(filter));
    // Every reason, counted over the whole held set (not narrowed by the chosen reason, so each chip shows its own count).
    const { rows } = await db.execute<{ code: string; n: number }>(sql`
      SELECT f->>'code' AS code, count(*)::int AS n
        FROM bills b, jsonb_array_elements(coalesce(b.vat_evidence_flags, '[]'::jsonb)) f
       WHERE ${this.heldSql("b")}
         AND f->>'severity' = 'blocking'
       GROUP BY 1 ORDER BY 2 DESC, 1`);
    return {
      total: Number(row?.total ?? 0),
      heldVat: Math.round(Number(row?.heldVat ?? 0) * 100) / 100,
      byStatus: { postedHeld: Number(row?.postedHeld ?? 0), awaitingEvidence: Number(row?.awaiting ?? 0), notEvaluated: Number(row?.notEvaluated ?? 0) },
      byReason: rows.map((r) => ({ code: r.code, count: Number(r.n) })),
    };
  },

  /**
   * 🔴 Phase 13C — EXPENSES are bills recorded as paid-at-recording. No
   * second table and no second source of truth: this reads the bills, what
   * they still owe (`billPosition`), and their payments.
   */
  expenseConditions(filter: { status?: string; q?: string }) {
    const conds = [
      sql`${billsTable.companyId}::text = current_setting('app.current_company_id', true)`,
      eq(billsTable.recordedAsExpense, true),
    ];
    if (filter.status === "unposted") conds.push(sql`${billsTable.status} IN ('draft','submitted')`);
    else if (filter.status === "posted") conds.push(sql`${billsTable.status} NOT IN ('draft','submitted')`);
    const like = likeOf(filter.q);
    if (like) conds.push(sql`(${billsTable.billNumber} ILIKE ${like} OR ${billsTable.vendorReference} ILIKE ${like} OR ${vendorsTable.name} ILIKE ${like})`);
    return and(...conds);
  },

  expenses(filter: { status?: string; q?: string; limit: number; offset: number }) {
    return db
      .select({
        bill: billsTable, vendor: vendorsTable, outstanding: sql<string>`${OUTSTANDING}`,
        bankName: bankAccountsTable.name,
        expenseAccountName: sql<string | null>`(SELECT c.name FROM categories c WHERE c.id = ${billsTable}."expense_account_id")`,
      })
      .from(billsTable)
      .leftJoin(vendorsTable, eq(billsTable.vendorId, vendorsTable.id))
      .leftJoin(bankAccountsTable, eq(billsTable.expensePaidFromBankAccountId, bankAccountsTable.id))
      .where(this.expenseConditions(filter))
      .orderBy(desc(billsTable.date), desc(billsTable.id))
      .limit(filter.limit)
      .offset(filter.offset);
  },

  async expensesMeta(filter: { status?: string; q?: string }) {
    const [row] = await db
      .select({
        total: sql<number>`count(*)::int`,
        amount: sql<number>`coalesce(sum(${billsTable.total}) FILTER (WHERE ${billsTable.status} NOT IN ('draft','submitted')), 0)::float8`,
        vat: sql<number>`coalesce(sum(${billsTable.vatAmount}) FILTER (WHERE ${billsTable.status} NOT IN ('draft','submitted')), 0)::float8`,
        unposted: sql<number>`count(*) FILTER (WHERE ${billsTable.status} IN ('draft','submitted'))::int`,
      })
      .from(billsTable)
      .leftJoin(vendorsTable, eq(billsTable.vendorId, vendorsTable.id))
      .where(this.expenseConditions(filter));
    return {
      total: Number(row?.total ?? 0),
      postedAmount: Math.round(Number(row?.amount ?? 0) * 100) / 100,
      postedVat: Math.round(Number(row?.vat ?? 0) * 100) / 100,
      unposted: Number(row?.unposted ?? 0),
    };
  },

  /** The payments of a page of bills, in ONE read (never one query per row). */
  paymentsForBills(ids: number[]) {
    if (ids.length === 0) return Promise.resolve([] as (typeof billPaymentsTable.$inferSelect)[]);
    return db.select().from(billPaymentsTable).where(inArray(billPaymentsTable.billId, ids)).orderBy(desc(billPaymentsTable.id));
  },

  /**
   * Delete a DRAFT. 🔴 Phase 13A: a staged capture linked to the draft as its
   * evidence is unlinked first — the FK would otherwise refuse the delete —
   * and becomes an ordinary abandoned capture the purge job removes.
   */
  async remove(id: number) {
    await capturedDocumentsRepository.unlinkStagedFromBill(id);
    return db.delete(billsTable).where(eq(billsTable.id, id));
  },
};
