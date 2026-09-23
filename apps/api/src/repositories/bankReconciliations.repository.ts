/**
 * PHASE 12D — the terms of a bank reconciliation as of a date, and the
 * completed reconciliations. Every figure here is read from the two single
 * definitions and nothing else:
 *   · a bank's ledger  = `journal_line_bank_identity` over entries IN THE BOOKS
 *                        (`posted` + `reversed` — a reversed entry and its
 *                        mirror are both in the books; JE_IN_BOOKS);
 *   · what reconciles  = `bank_line_reconciliation`.
 * A reader that re-derived either would be a second definition.
 *
 * Signs: a ledger cash line is Dr − Cr (money in positive); a statement line
 * is + for a credit (money in), − for a debit.
 */
import { db, bankReconciliationsTable, bankReconciliationReopeningsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";

const scoped = (alias: string) => sql.raw(`${alias}.company_id::text = current_setting('app.current_company_id', true)`);

export type LedgerOnlyItem = {
  line_id: number; journal_entry_id: number; entry_number: string; date: string; description: string | null;
  signed_amount: string; reconciled: string; outstanding: string;
};
export type StatementOnlyItem = {
  transaction_id: number; date: string; description: string; signed_amount: string; reconciled: string; outstanding: string;
  review_status: string; kind: string;
};

export const bankReconciliationsRepository = {
  /** The bank's ledger balance as of a date, over entries in the books. */
  async ledgerBalance(bankAccountId: number, asOf: string): Promise<number> {
    const { rows } = await db.execute<{ v: string }>(sql`
      SELECT coalesce(sum(v.debit_amount - v.credit_amount), 0)::text AS v
        FROM journal_line_bank_identity v
        JOIN journal_entries e ON e.id = v.journal_entry_id
       WHERE v.bank_account_id = ${bankAccountId} AND ${scoped("e")}
         AND e.status IN ('posted', 'reversed') AND e.date::date <= ${asOf}::date`);
    return Number(rows[0]?.v ?? 0);
  },

  /**
   * Ledger cash lines dated on or before the date whose money the bank had not
   * shown by then: the part NOT reconciled to a statement line dated on or
   * before the date (a cheque that cleared after it is outstanding AT it).
   */
  async ledgerOnly(bankAccountId: number, asOf: string) {
    // The view is aggregated ONCE (answers from statement lines dated by D), then joined.
    const { rows } = await db.execute<LedgerOnlyItem>(sql`
      WITH answered AS MATERIALIZED (
        SELECT r.line_id, sum(r.amount) AS amount
          FROM bank_line_reconciliation r JOIN transactions t ON t.id = r.transaction_id
         WHERE t.bank_account_id = ${bankAccountId} AND t.date::date <= ${asOf}::date
         GROUP BY r.line_id
      )
      SELECT * FROM (
        SELECT v.line_id, e.id AS journal_entry_id, e.entry_number, e.date::date::text AS date,
               coalesce(l.description, e.description) AS description,
               (v.debit_amount - v.credit_amount)::text AS signed_amount,
               coalesce(a.amount, 0)::text AS reconciled,
               (abs(v.debit_amount - v.credit_amount) - coalesce(a.amount, 0))::text AS outstanding
          FROM journal_line_bank_identity v
          JOIN journal_entries e ON e.id = v.journal_entry_id
          JOIN journal_entry_lines l ON l.id = v.line_id
          LEFT JOIN answered a ON a.line_id = v.line_id
         WHERE v.bank_account_id = ${bankAccountId} AND ${scoped("e")}
           AND e.status IN ('posted', 'reversed') AND e.date::date <= ${asOf}::date
      ) x WHERE x.outstanding::numeric > 0.005
      ORDER BY x.date, x.line_id`);
    return rows;
  },

  /**
   * Statement lines dated on or before the date that the books had not
   * recorded by then: the part NOT reconciled to a ledger cash line dated on
   * or before the date.
   */
  async statementOnly(bankAccountId: number, asOf: string) {
    // The view is aggregated ONCE (answers from cash lines dated by D), then joined.
    const { rows } = await db.execute<StatementOnlyItem>(sql`
      WITH answered AS MATERIALIZED (
        SELECT r.transaction_id, sum(r.amount) AS amount
          FROM bank_line_reconciliation r
          JOIN journal_entry_lines l ON l.id = r.line_id JOIN journal_entries e ON e.id = l.journal_entry_id
         WHERE e.date::date <= ${asOf}::date
         GROUP BY r.transaction_id
      )
      SELECT * FROM (
        SELECT t.id AS transaction_id, t.date::date::text AS date, t.description,
               (CASE WHEN t.type = 'credit' THEN 1 ELSE -1 END * abs(t.amount::numeric))::text AS signed_amount,
               coalesce(a.amount, 0)::text AS reconciled,
               (abs(t.amount::numeric) - coalesce(a.amount, 0))::text AS outstanding,
               t.review_status, t.kind
          FROM transactions t
          LEFT JOIN answered a ON a.transaction_id = t.id
         WHERE t.bank_account_id = ${bankAccountId} AND ${scoped("t")} AND t.date::date <= ${asOf}::date
      ) x WHERE x.outstanding::numeric > 0.005
      ORDER BY x.date, x.transaction_id`);
    return rows;
  },

  /** Completed reconciliations of a bank (or all), newest first, each with its reopening if any. */
  async list(bankAccountId?: number) {
    const { rows } = await db.execute<{
      id: number; bank_account_id: number; bank_name: string; as_of: string; bank_statement_id: number | null;
      statement_balance: string; ledger_balance: string; ledger_only_total: string; statement_only_total: string; difference: string;
      snapshot: unknown; notes: string | null; completed_by: number | null; created_at: string;
      reopen_reason: string | null; reopened_at: string | null;
    }>(sql`
      SELECT r.id, r.bank_account_id, b.name AS bank_name, r.as_of::text AS as_of, r.bank_statement_id,
             r.statement_balance::text, r.ledger_balance::text, r.ledger_only_total::text, r.statement_only_total::text,
             r.difference::text, r.snapshot, r.notes, r.completed_by, r.created_at::text AS created_at,
             o.reason AS reopen_reason, o.created_at::text AS reopened_at
        FROM bank_reconciliations r
        JOIN bank_accounts b ON b.id = r.bank_account_id
        LEFT JOIN bank_reconciliation_reopenings o ON o.reconciliation_id = r.id
       WHERE ${scoped("r")} ${bankAccountId != null ? sql`AND r.bank_account_id = ${bankAccountId}` : sql``}
       ORDER BY r.as_of DESC, r.id DESC`);
    return rows;
  },

  /** The latest reconciliation of a bank that has NOT been reopened — the lock. */
  async latestActive(bankAccountId: number) {
    const { rows } = await db.execute<{ id: number; as_of: string }>(sql`
      SELECT r.id, r.as_of::text AS as_of FROM bank_reconciliations r
       WHERE r.bank_account_id = ${bankAccountId} AND ${scoped("r")}
         AND NOT EXISTS (SELECT 1 FROM bank_reconciliation_reopenings o WHERE o.reconciliation_id = r.id)
       ORDER BY r.as_of DESC, r.id DESC LIMIT 1`);
    return rows[0] ?? null;
  },

  /** The date a bank is reconciled through (the lock), or null — the same function the triggers use. */
  async reconciledThrough(bankAccountId: number): Promise<string | null> {
    const { rows } = await db.execute<{ d: string | null }>(sql`SELECT bank_reconciled_through(${bankAccountId})::text AS d`);
    return rows[0]?.d ?? null;
  },

  /** The company-wide reconciliation lock (the same key the link triggers take). */
  async lockCompany() {
    await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext('bank-rec:' || current_setting('app.current_company_id', true)))`);
  },

  insert(values: typeof bankReconciliationsTable.$inferInsert) {
    return db.insert(bankReconciliationsTable).values(values).returning();
  },
  findReopening(reconciliationId: number) {
    return db.select().from(bankReconciliationReopeningsTable).where(eq(bankReconciliationReopeningsTable.reconciliationId, reconciliationId)).limit(1);
  },
  insertReopening(values: typeof bankReconciliationReopeningsTable.$inferInsert) {
    return db.insert(bankReconciliationReopeningsTable).values(values).returning();
  },

  /**
   * Cash position per bank, in one read: the ledger balance today, the latest
   * statement that states a closing balance, how many lines are unreconciled
   * or partial (and their outstanding money), and the reconciled-through date.
   */
  async cashPosition(today: string) {
    const { rows } = await db.execute<{
      id: number; name: string; bank_name: string; currency: string; is_active: boolean;
      ledger_balance: string; statement_id: number | null; statement_to: string | null; statement_closing: string | null;
      ledger_at_statement: string | null;
      unreconciled_lines: number; partial_lines: number; outstanding_in: string; outstanding_out: string;
      reconciled_through: string | null;
    }>(sql`
      WITH rec_by_tx AS MATERIALIZED (SELECT r.transaction_id, sum(r.amount) AS amount FROM bank_line_reconciliation r GROUP BY r.transaction_id)
      SELECT b.id, b.name, b.bank_name, b.currency, b.is_active,
             coalesce((SELECT sum(v.debit_amount - v.credit_amount) FROM journal_line_bank_identity v
                         JOIN journal_entries e ON e.id = v.journal_entry_id
                        WHERE v.bank_account_id = b.id AND e.status IN ('posted', 'reversed') AND e.date::date <= ${today}::date), 0)::text AS ledger_balance,
             s.id AS statement_id, s.period_to::text AS statement_to, s.closing_balance::text AS statement_closing,
             CASE WHEN s.id IS NULL THEN NULL ELSE
               coalesce((SELECT sum(v.debit_amount - v.credit_amount) FROM journal_line_bank_identity v
                           JOIN journal_entries e ON e.id = v.journal_entry_id
                          WHERE v.bank_account_id = b.id AND e.status IN ('posted', 'reversed') AND e.date::date <= s.period_to), 0)::text END AS ledger_at_statement,
             coalesce(st.unreconciled, 0)::int AS unreconciled_lines, coalesce(st.partial, 0)::int AS partial_lines,
             coalesce(st.out_in, 0)::text AS outstanding_in, coalesce(st.out_out, 0)::text AS outstanding_out,
             (SELECT max(r.as_of)::text FROM bank_reconciliations r WHERE r.bank_account_id = b.id
                 AND NOT EXISTS (SELECT 1 FROM bank_reconciliation_reopenings o WHERE o.reconciliation_id = r.id)) AS reconciled_through
        FROM bank_accounts b
        LEFT JOIN LATERAL (
          SELECT bs.id, bs.period_to, bs.closing_balance FROM bank_statements bs
           WHERE bs.bank_account_id = b.id AND bs.closing_balance IS NOT NULL
           ORDER BY bs.period_to DESC, bs.id DESC LIMIT 1) s ON true
        LEFT JOIN (
          -- the view aggregated ONCE per statement line, then grouped per bank
          SELECT y.bank_account_id,
                 count(*) FILTER (WHERE y.rec <= 0.005) AS unreconciled,
                 count(*) FILTER (WHERE y.rec > 0.005) AS partial,
                 sum(y.left_) FILTER (WHERE y.type = 'credit') AS out_in,
                 sum(y.left_) FILTER (WHERE y.type = 'debit') AS out_out
            FROM (SELECT t.bank_account_id, t.type, coalesce(a.amount, 0) AS rec, abs(t.amount::numeric) - coalesce(a.amount, 0) AS left_
                    FROM transactions t
                    LEFT JOIN rec_by_tx a ON a.transaction_id = t.id
                   WHERE t.bank_account_id IS NOT NULL AND ${scoped("t")}) y
           WHERE y.left_ > 0.005
           GROUP BY y.bank_account_id) st ON st.bank_account_id = b.id
       WHERE ${scoped("b")}
       ORDER BY b.is_active DESC, b.name`);
    return rows;
  },
  /** The rows behind the banking exceptions (the service shapes them). Each capped list returns its true total. */
  async exceptions(stale: string, cap: number) {
    const lines = await db.execute<{ id: number; bank_account_id: number; date: string; description: string; amount: string; type: string; reconciled: string; total: number }>(sql`
      WITH rec_by_tx AS MATERIALIZED (SELECT r.transaction_id, sum(r.amount) AS amount FROM bank_line_reconciliation r GROUP BY r.transaction_id)
      SELECT x.*, count(*) OVER ()::int AS total FROM (
        SELECT t.id, t.bank_account_id, t.date::date::text AS date, t.description, abs(t.amount::numeric)::text AS amount, t.type,
               coalesce(a.amount, 0)::text AS reconciled
          FROM transactions t
          LEFT JOIN rec_by_tx a ON a.transaction_id = t.id
         WHERE t.bank_account_id IS NOT NULL AND ${scoped("t")}) x
       WHERE x.reconciled::numeric < x.amount::numeric - 0.005
         AND (x.date::date <= ${stale}::date OR x.reconciled::numeric > 0.005)
       ORDER BY x.date, x.id LIMIT ${cap}`);
    const clearing = await db.execute<{ balance: string; lines: number }>(sql`
      SELECT coalesce(sum(l.debit_amount - l.credit_amount), 0)::text AS balance, count(*)::int AS lines
        FROM journal_entry_lines l JOIN categories c ON c.id = l.account_id JOIN journal_entries e ON e.id = l.journal_entry_id
       WHERE c.system_code = 'TRANSFER_CLEARING' AND ${scoped("e")} AND e.status IN ('posted', 'reversed')`);
    const transfers = await db.execute<{ id: number; transfer_date: string; amount: string; from_name: string; to_name: string; reconciled: number }>(sql`
      SELECT * FROM (
        SELECT bt.id, bt.transfer_date::text AS transfer_date, bt.amount::text AS amount, fa.name AS from_name, ta.name AS to_name,
               (SELECT count(DISTINCT x.line_id)::int FROM bank_line_reconciliation x JOIN journal_entry_lines l ON l.id = x.line_id
                 WHERE l.journal_entry_id = bt.journal_entry_id) AS reconciled
          FROM bank_transfers bt JOIN bank_accounts fa ON fa.id = bt.from_bank_account_id JOIN bank_accounts ta ON ta.id = bt.to_bank_account_id
         WHERE ${scoped("bt")} AND bt.transfer_date <= ${stale}::date
           AND NOT EXISTS (SELECT 1 FROM bank_transfer_reversals r WHERE r.transfer_id = bt.id)) y
       WHERE y.reconciled < 2 ORDER BY y.transfer_date, y.id`);
    const ledger = await db.execute<{ line_id: number; journal_entry_id: number; bank_account_id: number; entry_number: string; date: string; amount: string; outstanding: string; total: number }>(sql`
      WITH rec_by_line AS MATERIALIZED (SELECT r.line_id, sum(r.amount) AS amount FROM bank_line_reconciliation r GROUP BY r.line_id)
      SELECT x.*, count(*) OVER ()::int AS total FROM (
        SELECT v.line_id, e.id AS journal_entry_id, v.bank_account_id, e.entry_number, e.date::date::text AS date,
               abs(v.debit_amount - v.credit_amount)::text AS amount,
               (abs(v.debit_amount - v.credit_amount) - coalesce(a.amount, 0))::text AS outstanding
          FROM journal_line_bank_identity v JOIN journal_entries e ON e.id = v.journal_entry_id
          LEFT JOIN rec_by_line a ON a.line_id = v.line_id
         WHERE ${scoped("e")} AND e.status = 'posted' AND e.reversal_of IS NULL AND e.date::date <= ${stale}::date) x
       WHERE x.outstanding::numeric > 0.005
       ORDER BY x.date, x.line_id LIMIT ${cap}`);
    return {
      lines: { rows: lines.rows.map((r) => ({ ...r, id: Number(r.id), bank_account_id: Number(r.bank_account_id) })), total: lines.rows[0]?.total ?? 0 },
      clearing: { balance: Number(clearing.rows[0]?.balance ?? 0), lines: Number(clearing.rows[0]?.lines ?? 0) },
      transfers: transfers.rows.map((r) => ({ ...r, id: Number(r.id), reconciled: Number(r.reconciled) })),
      ledger: { rows: ledger.rows.map((r) => ({ ...r, line_id: Number(r.line_id), journal_entry_id: Number(r.journal_entry_id), bank_account_id: Number(r.bank_account_id) })), total: ledger.rows[0]?.total ?? 0 },
    };
  },
};
