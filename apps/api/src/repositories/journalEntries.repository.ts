/** Journal entries repository — tenant-scoped via RLS. */
import { db, journalEntriesTable, journalEntryLinesTable } from "@workspace/db";
import { desc, eq, sql } from "drizzle-orm";

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
  linesByEntry(id: number) {
    return db.select().from(journalEntryLinesTable).where(eq(journalEntryLinesTable.journalEntryId, id));
  },
  insertEntry(values: typeof journalEntriesTable.$inferInsert) {
    return db.insert(journalEntriesTable).values(values).returning();
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
