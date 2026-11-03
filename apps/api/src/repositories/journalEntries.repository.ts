/** Journal entries repository — tenant-scoped via RLS. */
import { db, journalEntriesTable, journalEntryLinesTable, categoriesTable, cashLineBankAttributionsTable } from "@workspace/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { JE_IN_BOOKS } from "./reports.repository";

/** The default page. Stated once so the API, the UI and the tests agree. */
export const DEFAULT_PAGE = 50;

/**
 * R-2 (G23; register §11.85): whether the company has any entry IN THE BOOKS — posted or reversed, the one
 * definition (`JE_IN_BOOKS`) — which is what fixes its fiscal-year start. A draft or submitted entry counts for nothing.
 */
export async function companyHasEntriesInBooks(companyId: string): Promise<boolean> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(journalEntriesTable)
    .where(and(eq(journalEntriesTable.companyId, companyId), inArray(journalEntriesTable.status, JE_IN_BOOKS)));
  return (row?.n ?? 0) > 0;
}

export interface JournalEntryListFilter {
  status?: string;
  limit?: number;
  offset?: number;
}

/**
 * Who owns a journal entry, when a document does. The Phase 13B-1 values are
 * the ones `input_vat_journal_owner()` (migration 0107) returns.
 */
export type JournalEntryOwner =
  | "bank_transfer" | "statement_line" | "bill" | "supplier_note" | "bill_vat_claim" | "input_vat_event"
  // Phase 13B-1a (migration 0108): a supplier advance invoice's BILLADV- entry and an advance credit note's BILLADVCN-.
  | "advance_invoice" | "advance_credit_note"
  // Phase 16 (migration 0113, `tax_journal_owner()`): a payment that withheld tax, a WHT remittance and its reversal, a tax computation's accrual.
  | "wht_withholding" | "wht_remittance" | "wht_remittance_reversal" | "tax_accrual"
  // Q1 (migration 0117): the reversal a WHT correction posted — itself the correction.
  | "wht_correction"
  // Phase 18 H-6 (DR-34): an invoice-side document's entry (its own posting, a correction's issue) and a bad-debt
  // write-off — read from the entry's recorded source (T1d).
  | "invoice" | "invoice_write_off"
  // 🔴 Phase 18 R-10 (DR-34 finished, memo §2a, register §11.109): every other source type with its OWN correction
  // path, named by its source type — each refusal names that path.
  | "credit_note_application" | "customer_payment_allocation" | "customer_payment_reclassification"
  | "supplier_advance_allocation" | "supplier_payment_reclassification" | "vat_return_filing";

/** One predicate for the rows AND the count — so they cannot describe different sets. */
const jeConditions = (f: JournalEntryListFilter) =>
  f.status ? eq(journalEntriesTable.status, f.status) : undefined;

export const journalEntriesRepository = {
  /**
   * 🔴 Phase 18 R-11a — DR-14: who approved a document's OWN posting — the approver T1d records on the entry the
   * approval posted (the earliest entry of that source that is not a mirror), or null when none is recorded.
   */
  async documentApprover(sourceType: "bill", sourceId: number): Promise<number | null> {
    const { rows } = await db.execute<{ approved_by: number | null }>(sql`
      SELECT approved_by FROM journal_entries
       WHERE source_type = ${sourceType} AND source_id = ${sourceId} AND reversal_of IS NULL
       ORDER BY id LIMIT 1`);
    return rows[0]?.approved_by == null ? null : Number(rows[0].approved_by);
  },

  /** Phase 12C: whether a statement line is reconciled to one of this entry's cash lines by another record (not the line's own posting). */
  async reconciledToStatement(entryId: number): Promise<boolean> {
    const { rows } = await db.execute<{ r: boolean }>(sql`SELECT EXISTS (SELECT 1 FROM bank_line_reconciliation x JOIN journal_entry_lines l ON l.id = x.line_id
      WHERE l.journal_entry_id = ${entryId} AND x.source <> 'posted') AS r`);
    return rows[0]?.r === true;
  },

  /**
   * The document that owns this entry, if any — it is then corrected through
   * that document, never reversed generically.
   *
   * Phase 12C: a bank transfer, a statement line's own posting.
   * 🔴 Phase 13B-1 (A-5): a bill's or supplier note's own entry, a bill's
   * evidence-claim entry, and any entry an input-VAT event references — read
   * through `input_vat_journal_owner()`, the ONE definition migration 0107
   * gives, which the database guards also use (never restated here). It runs
   * as the caller, under RLS. (Invoices and payments are still not covered —
   * the rest of CLAUDE.md §5 rank 2.)
   * Phase 13B-1a (migration 0108): also a supplier advance invoice's
   * `BILLADV-` entry and an advance credit note's `BILLADVCN-` entry — the
   * prefixes 0107's definition missed.
   * 🔴 Phase 18 R-10 (DR-34 finished, register §11.109): EVERY T1d source type is decided. A type with its own
   * correction path is owned by its source type (H-6 began with the invoice side). And a type a TABLE owns is still
   * owned when no row of that table names the entry — read from its source type AFTER the table lookups, so an
   * owning path that passes its owner (the transfer, the statement line, WHT) is unchanged.
   */
  async documentOwner(entryId: number): Promise<JournalEntryOwner | null> {
    const { rows } = await db.execute<{ owner: JournalEntryOwner | null }>(sql`
      SELECT CASE WHEN EXISTS (SELECT 1 FROM bank_transfers WHERE journal_entry_id = ${entryId}) THEN 'bank_transfer'
                  WHEN EXISTS (SELECT 1 FROM transactions WHERE journal_entry_id = ${entryId}) THEN 'statement_line'
                  -- 🔴 Phase 18 H-6 (DR-34): the invoice side, by the entry's recorded source (T1d)
                  WHEN s.st IN ('invoice', 'invoice_correction') THEN 'invoice'
                  WHEN s.st = 'invoice_write_off' THEN 'invoice_write_off'
                  -- 🔴 R-10: the types with their own correction path, each refused in words naming it
                  WHEN s.st IN ('credit_note_application', 'customer_payment_allocation', 'customer_payment_reclassification',
                                'supplier_advance_allocation', 'supplier_payment_reclassification', 'vat_return_filing') THEN s.st
                  ELSE coalesce(input_vat_journal_owner(${entryId}), tax_journal_owner(${entryId}),
                                -- 🔴 R-10: a type a table owns, when no row of that table names the entry
                                CASE s.st WHEN 'bill' THEN 'bill' WHEN 'vat_evidence' THEN 'bill_vat_claim'
                                          WHEN 'bank_transfer' THEN 'bank_transfer' WHEN 'bank_transaction' THEN 'statement_line'
                                          WHEN 'tax_computation' THEN 'tax_accrual' WHEN 'wht_remittance' THEN 'wht_remittance'
                                          WHEN 'wht_remittance_reversal' THEN 'wht_remittance_reversal' END)
             END AS owner
        FROM (SELECT (SELECT source_type FROM journal_entries WHERE id = ${entryId}) AS st) s`);
    return rows[0]?.owner ?? null;
  },


  /** A PAGE. See `invoicesRepository.list` for why offset rather than cursor. */
  list(f: JournalEntryListFilter = {}) {
    return db
      .select()
      .from(journalEntriesTable)
      .where(jeConditions(f))
      .orderBy(desc(journalEntriesTable.date), desc(journalEntriesTable.id))
      .limit(f.limit ?? DEFAULT_PAGE)
      .offset(f.offset ?? 0);
  },

  /**
   * The count over the WHOLE filtered set.
   *
   * 🔴 No money aggregate here, deliberately: an entry's debit and credit totals
   * are equal by construction (the balance guard), so a "total" across entries
   * would be a number with no meaning — twice the turnover, or zero, depending
   * which column you picked. The page reports how many entries there are, which
   * is the only set-wide figure this list can honestly state.
   */
  async listMeta(f: JournalEntryListFilter = {}) {
    const [row] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(journalEntriesTable)
      .where(jeConditions(f));
    return { total: Number(row?.total ?? 0) };
  },
  findById(id: number) {
    return db.select().from(journalEntriesTable).where(eq(journalEntriesTable.id, id)).limit(1);
  },
  /**
   * 🔴 DR-45 (I) — the CASH an entry moved: per bank, the net that left (credit − debit, in halalas, so an
   * outflow is positive), read through `journal_line_bank_identity`, the one "which bank" definition (D-3).
   * Sorted by bank, so two movements compare as values.
   */
  async cashMovementOf(entryId: number): Promise<Array<{ bankAccountId: number; outH: number }>> {
    const { rows } = await db.execute<{ bank_account_id: number; out_h: string }>(sql`
      SELECT v.bank_account_id, round(sum(v.credit_amount - v.debit_amount) * 100)::bigint::text AS out_h
        FROM journal_line_bank_identity v
       WHERE v.journal_entry_id = ${entryId} AND v.bank_account_id IS NOT NULL
       GROUP BY v.bank_account_id
      HAVING sum(v.credit_amount - v.debit_amount) <> 0
       ORDER BY v.bank_account_id`);
    return rows.map((r) => ({ bankAccountId: Number(r.bank_account_id), outH: Number(r.out_h) }));
  },
  /** D-3: which of these accounts are non-posting headers (the approval gate). */
  async nonPostingAccountsOf(accountIds: number[]) {
    if (accountIds.length === 0) return [];
    return db
      .select({ id: categoriesTable.id, name: categoriesTable.name })
      .from(categoriesTable)
      .where(and(inArray(categoriesTable.id, accountIds), eq(categoriesTable.isPosting, false)));
  },

  linesByEntry(id: number) {
    return db.select().from(journalEntryLinesTable).where(eq(journalEntryLinesTable.journalEntryId, id));
  },

  /**
   * 🔴 Per-entry debit/credit totals for a PAGE of entries, in one grouped
   * query (contract batch 4). The list used to build each row from the header
   * alone, so every list row read `totalDebit: 0, totalCredit: 0` — the ledger
   * page printed those zeros, and the approvals queue showed 0.00 for every
   * pending entry. A confident zero on the ledger.
   */
  async lineTotals(entryIds: number[]) {
    if (entryIds.length === 0) return new Map<number, { totalDebit: number; totalCredit: number }>();
    const rows = await db
      .select({
        journalEntryId: journalEntryLinesTable.journalEntryId,
        totalDebit: sql<number>`COALESCE(SUM(${journalEntryLinesTable.debitAmount}), 0)::float8`,
        totalCredit: sql<number>`COALESCE(SUM(${journalEntryLinesTable.creditAmount}), 0)::float8`,
      })
      .from(journalEntryLinesTable)
      .where(inArray(journalEntryLinesTable.journalEntryId, entryIds))
      .groupBy(journalEntryLinesTable.journalEntryId);
    return new Map(rows.map((r) => [r.journalEntryId, { totalDebit: Number(r.totalDebit), totalCredit: Number(r.totalCredit) }]));
  },
  insertEntry(values: typeof journalEntriesTable.$inferInsert) {
    return db.insert(journalEntriesTable).values(values).returning();
  },
  /**
   * D-3: for every mirror line whose ORIGINAL line carries a bank attribution,
   * insert the same attribution for the mirror (rule A3, no run). Idempotent
   * on the unique line_id; a mirror of an unattributed line gets nothing.
   */
  async copyBankAttributions(pairs: Array<{ originalLineId: number; mirrorLineId: number; journalEntryId: number }>) {
    if (pairs.length === 0) return;
    const originals = await db
      .select()
      .from(cashLineBankAttributionsTable)
      .where(inArray(cashLineBankAttributionsTable.lineId, pairs.map((p) => p.originalLineId)));
    if (originals.length === 0) return;
    const byOriginal = new Map(originals.map((a) => [a.lineId, a]));
    const mirrors = await db
      .select({ id: journalEntryLinesTable.id, accountId: journalEntryLinesTable.accountId, accountName: journalEntryLinesTable.accountName })
      .from(journalEntryLinesTable)
      .where(inArray(journalEntryLinesTable.id, pairs.map((p) => p.mirrorLineId)));
    const mirrorById = new Map(mirrors.map((m) => [m.id, m]));
    const rows = pairs
      .filter((p) => byOriginal.has(p.originalLineId))
      .map((p) => {
        const a = byOriginal.get(p.originalLineId)!;
        const m = mirrorById.get(p.mirrorLineId)!;
        return {
          runId: null,
          lineId: p.mirrorLineId,
          journalEntryId: p.journalEntryId,
          accountId: m.accountId!,
          accountName: m.accountName,
          bankAccountId: a.bankAccountId,
          glAccountId: a.glAccountId,
          classification: "DETERMINISTIC",
          rule: "A3_mirror_of_attributed",
        };
      });
    if (rows.length > 0) await db.insert(cashLineBankAttributionsTable).values(rows).onConflictDoNothing({ target: cashLineBankAttributionsTable.lineId });
  },

  insertLines(values: (typeof journalEntryLinesTable.$inferInsert)[]) {
    return db.insert(journalEntryLinesTable).values(values).returning();
  },
  updateEntry(id: number, values: Partial<typeof journalEntriesTable.$inferInsert>) {
    return db.update(journalEntriesTable).set(values).where(eq(journalEntriesTable.id, id)).returning();
  },
  /** 🔴 G08 residuals (PR A) — applied only while the entry is still in `status` (compare-and-set); no row when it was not. */
  updateEntryIfStatus(id: number, status: string, values: Partial<typeof journalEntriesTable.$inferInsert>) {
    return db.update(journalEntriesTable).set(values).where(and(eq(journalEntriesTable.id, id), eq(journalEntriesTable.status, status))).returning();
  },
  remove(id: number) {
    return db.delete(journalEntriesTable).where(eq(journalEntriesTable.id, id));
  },
  /** 🔴 G08 residuals (PR A) — removes the entry (its lines cascade) only while it is still in `status`; returns the removed id, or nothing. */
  removeIfStatus(id: number, status: string) {
    return db.delete(journalEntriesTable).where(and(eq(journalEntriesTable.id, id), eq(journalEntriesTable.status, status))).returning({ id: journalEntriesTable.id });
  },
};
