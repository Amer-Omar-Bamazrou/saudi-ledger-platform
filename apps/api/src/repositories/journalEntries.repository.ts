/** Journal entries repository — tenant-scoped via RLS. */
import { db, journalEntriesTable, journalEntryLinesTable, categoriesTable, cashLineBankAttributionsTable } from "@workspace/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";

/** The default page. Stated once so the API, the UI and the tests agree. */
export const DEFAULT_PAGE = 50;

export interface JournalEntryListFilter {
  status?: string;
  limit?: number;
  offset?: number;
}

/** One predicate for the rows AND the count — so they cannot describe different sets. */
const jeConditions = (f: JournalEntryListFilter) =>
  f.status ? eq(journalEntriesTable.status, f.status) : undefined;

export const journalEntriesRepository = {
  /** Phase 12C: whether a statement line is reconciled to one of this entry's cash lines by another record (not the line's own posting). */
  async reconciledToStatement(entryId: number): Promise<boolean> {
    const { rows } = await db.execute<{ r: boolean }>(sql`SELECT EXISTS (SELECT 1 FROM bank_line_reconciliation x JOIN journal_entry_lines l ON l.id = x.line_id
      WHERE l.journal_entry_id = ${entryId} AND x.source <> 'posted') AS r`);
    return rows[0]?.r === true;
  },

  /**
   * Phase 12C: the Phase 12 document that owns this entry, if any — it is then
   * reversed through that document. (Invoices, bills and payments are not yet
   * covered here: the decision pack §5.3 records that class as open.)
   */
  async documentOwner(entryId: number): Promise<"bank_transfer" | "statement_line" | null> {
    const { rows } = await db.execute<{ owner: "bank_transfer" | "statement_line" | null }>(sql`
      SELECT CASE WHEN EXISTS (SELECT 1 FROM bank_transfers WHERE journal_entry_id = ${entryId}) THEN 'bank_transfer'
                  WHEN EXISTS (SELECT 1 FROM transactions WHERE journal_entry_id = ${entryId}) THEN 'statement_line'
             END AS owner`);
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
  remove(id: number) {
    return db.delete(journalEntriesTable).where(eq(journalEntriesTable.id, id));
  },
};
