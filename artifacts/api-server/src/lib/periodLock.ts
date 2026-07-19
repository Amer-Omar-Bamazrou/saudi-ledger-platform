/**
 * Period locking — prevents posting into a closed accounting period.
 * Call checkPeriodOpen(date) before any GL posting.
 */
import { db } from "@workspace/db";
import { periodLocksTable } from "@workspace/db";
import { eq } from "drizzle-orm";

/** Extract YYYY-MM from a date string or Date. */
function toPeriod(date: string | Date): string {
  const d = typeof date === "string" ? date : date.toISOString();
  return d.slice(0, 7); // "YYYY-MM"
}

/**
 * Throws a 423-style error if the period containing `date` is locked.
 * Call this before inserting any journal entry, invoice, or bill.
 */
export async function checkPeriodOpen(date: string | Date): Promise<void> {
  const period = toPeriod(date);
  const [lock] = await db
    .select()
    .from(periodLocksTable)
    .where(eq(periodLocksTable.period, period))
    .limit(1);
  if (lock) {
    throw Object.assign(
      new Error(`Period ${period} is locked. It was closed on ${lock.lockedAt.toISOString().slice(0, 10)}. Post a reversing entry in an open period.`),
      { statusCode: 423 }
    );
  }
}
