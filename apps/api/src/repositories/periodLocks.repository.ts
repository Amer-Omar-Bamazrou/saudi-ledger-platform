/** Period locks repository — tenant-scoped via RLS. */
import { db, periodLocksTable } from "@workspace/db";
import { eq } from "drizzle-orm";

export const periodLocksRepository = {
  list() {
    return db.select().from(periodLocksTable).orderBy(periodLocksTable.period);
  },
  findByPeriod(period: string) {
    return db.select().from(periodLocksTable).where(eq(periodLocksTable.period, period)).limit(1);
  },
  insert(values: typeof periodLocksTable.$inferInsert) {
    return db.insert(periodLocksTable).values(values).returning();
  },
  removeByPeriod(period: string) {
    return db.delete(periodLocksTable).where(eq(periodLocksTable.period, period));
  },
};
