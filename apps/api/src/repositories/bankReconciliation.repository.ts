/**
 * PHASE 12B — reads over `bank_line_reconciliation`, the ONE definition of how
 * much of a statement line is reconciled and to which GL cash lines
 * (migration 0100). Nothing here re-derives reconciliation from the source
 * tables: a reader that did would be a second definition, and the two would
 * drift the first time a new source was added to the view and not to it.
 *
 * Tenant-scoped by RLS (the view is security_invoker) and company-scoped in
 * the query layer too (N1).
 */
import { db, bankStatementLinksTable, bankStatementLinkReversalsTable } from "@workspace/db";
import { eq, sql, type SQL } from "drizzle-orm";

const scoped = (alias: string) => sql.raw(`${alias}.company_id::text = current_setting('app.current_company_id', true)`);

/** How a GL cash line's entry is identified to a person: the document that posted it. */
const SOURCE_OF_ENTRY = (entryAlias: string, idColumn = "id") => sql.raw(`
  LEFT JOIN LATERAL (
    SELECT * FROM (
      SELECT 'supplier_payment'::text AS kind, sp.id, coalesce(sp.reference, 'SPAY-' || sp.id) AS ref, vd.name AS party
        FROM supplier_payments sp LEFT JOIN vendors vd ON vd.id = sp.vendor_id WHERE sp.journal_entry_id = ${entryAlias}.${idColumn}
      UNION ALL
      SELECT 'supplier_refund', sr.id, 'SREFUND-' || sr.id, vd.name
        FROM supplier_refunds sr LEFT JOIN vendors vd ON vd.id = sr.vendor_id WHERE sr.journal_entry_id = ${entryAlias}.${idColumn}
      UNION ALL
      SELECT 'bill_payment', bp.id, b.bill_number, vd.name
        FROM bill_payments bp JOIN bills b ON b.id = bp.bill_id LEFT JOIN vendors vd ON vd.id = b.vendor_id WHERE bp.journal_entry_id = ${entryAlias}.${idColumn}
      UNION ALL
      SELECT 'receipt', p.id, coalesce(p.reference, 'RCPT-' || p.id), cu.name
        FROM payments p LEFT JOIN customers cu ON cu.id = p.customer_id WHERE p.journal_entry_id = ${entryAlias}.${idColumn}
      UNION ALL
      SELECT 'customer_refund', f.id, 'REFUND-' || f.id, cu.name
        FROM customer_refunds f LEFT JOIN customers cu ON cu.id = f.customer_id WHERE f.journal_entry_id = ${entryAlias}.${idColumn}
      UNION ALL
      SELECT 'bank_transfer', bt.id, coalesce(bt.reference, 'BTR-' || bt.id), fa.name || ' → ' || ta.name
        FROM bank_transfers bt JOIN bank_accounts fa ON fa.id = bt.from_bank_account_id JOIN bank_accounts ta ON ta.id = bt.to_bank_account_id
       WHERE bt.journal_entry_id = ${entryAlias}.${idColumn}
      UNION ALL
      SELECT 'statement_line', st.id, st.description, NULL
        FROM transactions st WHERE st.journal_entry_id = ${entryAlias}.${idColumn}
    ) s LIMIT 1
  ) src ON true`);

/**
 * 🔴 Phase 12C — the ONE predicate "this statement line is the leg of a
 * RECORDED transfer that no statement line has answered yet": a live
 * `bank_transfers` row whose cash line on the line's bank moves the same money
 * the same way, within the matching window, with something left to reconcile.
 * Such a line is RECONCILED to the transfer, never accepted — acceptance would
 * post the cash a second time. Used by both acceptance modes and the refusal.
 */
export const OPEN_TRANSFER_LEG = (txId: SQL, windowDays: number) => sql`EXISTS (
  SELECT 1 FROM transactions tt
    JOIN bank_transfers bt ON bt.company_id = tt.company_id
    JOIN journal_line_bank_identity v ON v.journal_entry_id = bt.journal_entry_id AND v.bank_account_id = tt.bank_account_id
   WHERE tt.id = ${txId}
     AND NOT EXISTS (SELECT 1 FROM bank_transfer_reversals btr WHERE btr.transfer_id = bt.id)
     AND (CASE WHEN tt.type = 'credit' THEN v.debit_amount ELSE v.credit_amount END) = abs(tt.amount::numeric)
     AND abs(bt.transfer_date - tt.date::date) <= ${windowDays}
     AND abs(v.debit_amount - v.credit_amount)
         - coalesce((SELECT sum(x.amount) FROM bank_line_reconciliation x WHERE x.line_id = v.line_id), 0) > 0.005)`;

export type LineStatus = "unreconciled" | "partial" | "reconciled";

export type StatementLineRow = {
  id: number; bank_account_id: number; bank_statement_id: number | null; date: string; description: string;
  type: "debit" | "credit"; amount: string; review_status: string; kind: string; journal_entry_id: number | null;
  reconciled: string;
};

export type CandidateRow = {
  line_id: number; journal_entry_id: number; entry_number: string; date: string; description: string | null;
  line_amount: string; remaining: string; source_kind: string | null; source_id: number | null; source_ref: string | null; party: string | null;
};

export const bankReconciliationRepository = {
  /** Statement lines of one bank (or all), each with how much the view says is reconciled. */
  async lines(filter: { bankAccountId?: number; from?: string; to?: string; status?: LineStatus; limit: number; offset: number }) {
    const status: SQL = filter.status === "reconciled" ? sql`AND x.reconciled >= abs(x.amount::numeric) - 0.005`
      : filter.status === "partial" ? sql`AND x.reconciled > 0.005 AND x.reconciled < abs(x.amount::numeric) - 0.005`
      : filter.status === "unreconciled" ? sql`AND x.reconciled <= 0.005`
      : sql``;
    const { rows } = await db.execute<StatementLineRow & { total: number }>(sql`
      WITH rec_by_tx AS MATERIALIZED (SELECT r.transaction_id, sum(r.amount) AS amount FROM bank_line_reconciliation r GROUP BY r.transaction_id)
      SELECT x.*, count(*) OVER ()::int AS total FROM (
        SELECT t.id, t.bank_account_id, t.bank_statement_id, t.date, t.description, t.type, t.amount::text AS amount,
               t.review_status, t.kind, t.journal_entry_id,
               coalesce(a.amount, 0) AS reconciled
          FROM transactions t
          -- the view aggregated ONCE, then joined (a status filter reads every line)
          LEFT JOIN rec_by_tx a ON a.transaction_id = t.id
         WHERE t.bank_account_id IS NOT NULL AND ${scoped("t")}
           ${filter.bankAccountId != null ? sql`AND t.bank_account_id = ${filter.bankAccountId}` : sql``}
           ${filter.from ? sql`AND t.date >= ${filter.from}` : sql``}
           ${filter.to ? sql`AND t.date <= ${filter.to}` : sql``}
      ) x
      WHERE true ${status}
      ORDER BY x.date DESC, x.id DESC
      LIMIT ${filter.limit} OFFSET ${filter.offset}`);
    return rows;
  },

  /** Every pending statement line nothing reconciles yet (all of them — no page). */
  async pendingUnreconciled(bankAccountId?: number) {
    const { rows } = await db.execute<StatementLineRow>(sql`
      SELECT t.id, t.bank_account_id, t.bank_statement_id, t.date, t.description, t.type, t.amount::text AS amount,
             t.review_status, t.kind, t.journal_entry_id, '0'::text AS reconciled
        FROM transactions t
       WHERE t.bank_account_id IS NOT NULL AND ${scoped("t")}
         AND t.review_status = 'pending_review' AND t.journal_entry_id IS NULL
         ${bankAccountId != null ? sql`AND t.bank_account_id = ${bankAccountId}` : sql``}
         -- evaluated ONCE (a hashed subplan over the view), not probed per line
         AND t.id NOT IN (SELECT r.transaction_id FROM bank_line_reconciliation r WHERE r.transaction_id IS NOT NULL)
       ORDER BY t.date, t.id`);
    return rows;
  },

  async line(id: number) {
    const { rows } = await db.execute<StatementLineRow>(sql`
      SELECT t.id, t.bank_account_id, t.bank_statement_id, t.date, t.description, t.type, t.amount::text AS amount,
             t.review_status, t.kind, t.journal_entry_id,
             coalesce((SELECT sum(r.amount) FROM bank_line_reconciliation r WHERE r.transaction_id = t.id), 0)::text AS reconciled
        FROM transactions t WHERE t.id = ${id} AND ${scoped("t")}`);
    return rows[0] ?? null;
  },

  /**
   * Statement lines (of those given) that the view already reconciles — by ANY
   * source, or (`byAnotherRecord`) by a source OTHER than the line's own
   * posting: a match, a settlement, a link. The distinction matters to
   * acceptance: re-accepting a line that posted its own entry is an idempotent
   * no-op, while accepting a line another record answers would post twice.
   */
  async reconciledIds(ids: number[], opts: { byAnotherRecord?: boolean } = {}): Promise<Set<number>> {
    if (ids.length === 0) return new Set();
    const { rows } = await db.execute<{ transaction_id: number }>(sql`
      SELECT DISTINCT transaction_id FROM bank_line_reconciliation
       WHERE transaction_id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
         ${opts.byAnotherRecord ? sql`AND source <> 'posted'` : sql``}`);
    return new Set(rows.map((r) => Number(r.transaction_id)));
  },

  /** Statement lines (of those given) that are the open leg of a recorded transfer (OPEN_TRANSFER_LEG). */
  async openTransferLegIds(ids: number[], windowDays: number): Promise<Set<number>> {
    if (ids.length === 0) return new Set();
    const { rows } = await db.execute<{ id: number }>(sql`
      SELECT t.id FROM transactions t
       WHERE t.id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)}) AND t.review_status = 'pending_review'
         AND ${OPEN_TRANSFER_LEG(sql`t.id`, windowDays)}`);
    return new Set(rows.map((r) => Number(r.id)));
  },

  /** Row lock on the statement line — every reconciliation write for a line takes it. */
  async lockLine(id: number) {
    await db.execute(sql`SELECT id FROM transactions WHERE id = ${id} FOR UPDATE`);
  },

  /** What reconciles one statement line, per source, with the cash line's document. */
  async reconciliationOf(transactionId: number) {
    const { rows } = await db.execute<{
      source: string; source_id: number; line_id: number; amount: string; entry_id: number; entry_number: string; entry_date: string;
      source_kind: string | null; source_ref: string | null; party: string | null;
    }>(sql`
      SELECT r.source, r.source_id, r.line_id, r.amount::text AS amount, e.id AS entry_id, e.entry_number, e.date::date::text AS entry_date,
             src.kind AS source_kind, src.ref AS source_ref, src.party
        FROM bank_line_reconciliation r
        JOIN journal_entry_lines l ON l.id = r.line_id
        JOIN journal_entries e ON e.id = l.journal_entry_id
        ${SOURCE_OF_ENTRY("e")}
       WHERE r.transaction_id = ${transactionId}
       ORDER BY r.source, r.source_id`);
    return rows;
  },

  /**
   * GL cash lines that could answer a statement line: same bank, same
   * direction (money in on the statement = a debit to the bank), a POSTED
   * entry, still not fully reconciled, dated inside the window.
   */
  async candidates(t: { bankAccountId: number; type: "debit" | "credit"; from: string; to: string; excludeEntryId: number | null; lineIds?: number[] }) {
    // The view is aggregated ONCE for the cash lines in play and joined — not
    // probed per cash line (a correlated probe per row made the reference pass
    // take seconds at a few hundred lines; found by the full browser run).
    const { rows } = await db.execute<CandidateRow>(sql`
      WITH cash AS MATERIALIZED (
        SELECT v.line_id, e.id AS entry_id, e.entry_number, e.date::date AS d, coalesce(l.description, e.description) AS description,
               abs(v.debit_amount - v.credit_amount) AS line_amount
          FROM journal_line_bank_identity v
          JOIN journal_entries e ON e.id = v.journal_entry_id
          JOIN journal_entry_lines l ON l.id = v.line_id
         WHERE v.bank_account_id = ${t.bankAccountId}
           AND ${scoped("e")}
           AND e.status = 'posted'
           -- nor a reversing mirror: its original is 'reversed' and not offered, and
           -- half of a netted pair is never a bank movement on its own
           AND e.reversal_of IS NULL
           AND ${t.type === "credit" ? sql`v.debit_amount > 0` : sql`v.credit_amount > 0`}
           AND e.date::date BETWEEN ${t.from}::date AND ${t.to}::date
           ${t.excludeEntryId != null ? sql`AND e.id <> ${t.excludeEntryId}` : sql``}
           ${t.lineIds?.length ? sql`AND v.line_id IN (${sql.join(t.lineIds.map((i) => sql`${i}`), sql`, `)})` : sql``}
      ),
      rec AS MATERIALIZED (
        SELECT r.line_id, sum(r.amount) AS reconciled
          FROM bank_line_reconciliation r
         WHERE r.line_id IN (SELECT line_id FROM cash)
         GROUP BY r.line_id
      ),
      open_lines AS (
        SELECT c.*, c.line_amount - coalesce(rec.reconciled, 0) AS remaining
          FROM cash c LEFT JOIN rec ON rec.line_id = c.line_id
         WHERE c.line_amount - coalesce(rec.reconciled, 0) > 0.005
      )
      SELECT o.line_id, o.entry_id AS journal_entry_id, o.entry_number, o.d::text AS date, o.description,
             o.line_amount::text AS line_amount, o.remaining::text AS remaining,
             src.kind AS source_kind, src.id AS source_id, src.ref AS source_ref, src.party
        FROM open_lines o
        ${SOURCE_OF_ENTRY("o", "entry_id")}
       ORDER BY o.d, o.line_id`);
    return rows;
  },

  insertLink(values: typeof bankStatementLinksTable.$inferInsert) {
    return db.insert(bankStatementLinksTable).values(values).returning();
  },

  findLink(id: number) {
    return db.select().from(bankStatementLinksTable).where(eq(bankStatementLinksTable.id, id)).limit(1);
  },

  findLinkByIdempotencyKey(key: string) {
    return db.select().from(bankStatementLinksTable).where(eq(bankStatementLinksTable.idempotencyKey, key)).limit(1);
  },

  findReversal(linkId: number) {
    return db.select().from(bankStatementLinkReversalsTable).where(eq(bankStatementLinkReversalsTable.linkId, linkId)).limit(1);
  },

  insertReversal(values: typeof bankStatementLinkReversalsTable.$inferInsert) {
    return db.insert(bankStatementLinkReversalsTable).values(values).returning();
  },

  /** A line's cash line on its own bank, for a known entry (the Review settlement link). */
  async cashLineOf(entryId: number, bankAccountId: number) {
    const { rows } = await db.execute<{ line_id: number; amount: string }>(sql`
      SELECT v.line_id, abs(v.debit_amount - v.credit_amount)::text AS amount
        FROM journal_line_bank_identity v WHERE v.journal_entry_id = ${entryId} AND v.bank_account_id = ${bankAccountId}
       ORDER BY v.line_id LIMIT 2`);
    return rows;
  },

  /** Mark a line reconciled / return it to review. Only this repository changes a line's reconciliation state. */
  async setMatched(id: number) {
    await db.execute(sql`
      UPDATE transactions SET review_status = 'accepted', kind = 'matched', category_id = NULL,
             vat_amount = NULL, vat_rate = NULL, tax_treatment = NULL, vat_basis = NULL,
             -- a transfer declaration goes too: the line is now described by the
             -- record it is reconciled to (a CHECK allows these on a transfer only,
             -- so leaving them made reconciling a categorised transfer leg fail)
             transfer_direction = NULL, counterparty_bank_account_id = NULL
       WHERE id = ${id} AND journal_entry_id IS NULL AND kind <> 'settlement'`);
  },
  async returnToReview(id: number) {
    await db.execute(sql`
      UPDATE transactions SET review_status = 'pending_review', kind = 'operating'
       WHERE id = ${id} AND kind = 'matched'`);
  },
};
