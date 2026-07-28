/** Journal entries repository — tenant-scoped via RLS. */
import { db, journalEntriesTable, journalEntryLinesTable } from "@workspace/db";
import { desc, eq } from "drizzle-orm";

export const journalEntriesRepository = {
  list(status?: string) {
    return db
      .select()
      .from(journalEntriesTable)
      .where(status ? eq(journalEntriesTable.status, status) : undefined)
      .orderBy(desc(journalEntriesTable.date), desc(journalEntriesTable.id));
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
