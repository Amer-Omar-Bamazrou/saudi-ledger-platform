/**
 * Period locking — prevents posting into a closed accounting period.
 * Call checkPeriodOpen(date) before any GL posting.
 */
import { db } from "@workspace/db";
import { periodLocksTable } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { PeriodLockedError } from "../../lib/errors";

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
    .where(
      and(
        eq(periodLocksTable.period, period),
        // 🔴 M13 (queue item A4): scope by COMPANY, not by period alone.
        //
        // The uniqueness key is (organization_id, company_id, period), and RLS
        // scopes only to the ORGANIZATION. Filtering on `period` alone meant
        // that in a multi-company org, **company A closing a period blocked
        // company B's postings** — including credit notes correcting company B's
        // own invoices. Not a cross-tenant breach, but a real correctness bug
        // in a platform that advertises multi-company.
        //
        // Folded into M13 because `checkPeriodOpen` is called by
        // `postJournalEntry`, the exact function this milestone rewrites.
        //
        // Matched against the request's active company GUC — the same value the
        // row's own default uses, so a lock and its check always agree.
        eq(periodLocksTable.companyId, sql`(nullif(current_setting('app.current_company_id', true), ''))::uuid`),
      ),
    )
    .limit(1);
  if (lock) {
    const lockedAt = lock.lockedAt.toISOString().slice(0, 10);
    // Plain words, not accountant vocabulary ("post a reversing entry" told a
    // non-accountant nothing). The client keys on the CODE in the payload and
    // renders its own copy; this message is the fallback for API callers and
    // for surfaces that only show text — so it carries the same explanation.
    throw new PeriodLockedError(
      `The books for ${period} are closed (closed on ${lockedAt}), so its figures can't change. ` +
        `Date this in an open month instead — or an admin can reopen ${period} from Closed months.`,
      { period, lockedAt },
    );
  }
}
