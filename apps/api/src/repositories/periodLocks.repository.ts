/**
 * Period locks repository — tenant-scoped via RLS, and COMPANY-scoped explicitly.
 *
 * 🔴 RLS confines these rows to the active ORGANIZATION. It does NOT confine them
 * to the active company, and the uniqueness key is
 * `(organization_id, company_id, period)`. So every query here must filter on
 * `company_id` itself — otherwise a multi-company org sees, locks and unlocks
 * across companies:
 *
 *   - `list()` showed company B's locks to company A;
 *   - `findByPeriod()` reported a period "already locked" because ANOTHER company
 *     had locked it, so the real lock could never be created;
 *   - `removeByPeriod()` **deleted every company's lock for that period** — one
 *     company's unlock silently reopened closed books for all of them.
 *
 * M13 fixed the same omission in `checkPeriodOpen` (the posting-path check); this
 * is the route/repository half that stayed queued.
 *
 * 🔴 T1e (PER-2, 0130): nothing here deletes a lock — the request's role cannot.
 * A reopen UPDATES the row (who, when, why) and a re-close clears that; every
 * close and reopen is appended to `period_lock_events`. A month is CLOSED while
 * `reopened_at` is NULL.
 *
 * The filter uses the request's `app.current_company_id` GUC — the same value the
 * row's own column default uses, so a lock and its lookup can never disagree.
 */
import { db, periodLocksTable, periodLockEventsTable, migrationBatchesTable, statementAuthorisationsTable } from "@workspace/db";
import { and, asc, eq, gte, isNull, lte, sql } from "drizzle-orm";

/** The request's active company, as the row default sees it. */
const currentCompany = sql`(nullif(current_setting('app.current_company_id', true), ''))::uuid`;

export const periodLocksRepository = {
  /** The CLOSED months (a reopened row is history, not a closed month). */
  list() {
    return db
      .select()
      .from(periodLocksTable)
      .where(and(eq(periodLocksTable.companyId, currentCompany), isNull(periodLocksTable.reopenedAt)))
      .orderBy(periodLocksTable.period);
  },
  /** The month's lock row, closed or reopened. */
  findByPeriod(period: string) {
    return db
      .select()
      .from(periodLocksTable)
      .where(and(eq(periodLocksTable.period, period), eq(periodLocksTable.companyId, currentCompany)))
      .limit(1);
  },
  insert(values: typeof periodLocksTable.$inferInsert) {
    return db.insert(periodLocksTable).values(values).returning();
  },
  update(id: number, values: Partial<typeof periodLocksTable.$inferInsert>) {
    return db.update(periodLocksTable).set(values).where(and(eq(periodLocksTable.id, id), eq(periodLocksTable.companyId, currentCompany))).returning();
  },
  /** PER-1: the month's exclusive guard, so a close or reopen is serialised with postings into it (0130). */
  async guard(period: string) {
    await db.execute(sql`SELECT period_close_guard(${currentCompany}, ${period})`);
  },
  appendEvent(values: typeof periodLockEventsTable.$inferInsert) {
    return db.insert(periodLockEventsTable).values(values).returning();
  },
  events(period: string) {
    return db
      .select()
      .from(periodLockEventsTable)
      .where(and(eq(periodLockEventsTable.period, period), eq(periodLockEventsTable.companyId, currentCompany)))
      .orderBy(asc(periodLockEventsTable.at), asc(periodLockEventsTable.id));
  },
  /** G57: a COMMITTED migration batch whose opening month is this lock (its own reversal reopens it, recorded). */
  async migrationBatchOf(lockId: number) {
    const [row] = await db
      .select({ id: migrationBatchesTable.id })
      .from(migrationBatchesTable)
      .where(and(eq(migrationBatchesTable.periodLockId, lockId), eq(migrationBatchesTable.companyId, currentCompany), eq(migrationBatchesTable.status, "committed")))
      .limit(1);
    return row ?? null;
  },
  /** DR-30: the statements authorisation of the fiscal year containing this month's first day, if any. */
  async authorisationCovering(monthStart: string) {
    const [row] = await db
      .select()
      .from(statementAuthorisationsTable)
      .where(and(
        eq(statementAuthorisationsTable.companyId, currentCompany),
        lte(statementAuthorisationsTable.fiscalYearStart, monthStart),
        gte(statementAuthorisationsTable.fiscalYearEnd, monthStart),
      ))
      .limit(1);
    return row ?? null;
  },
};
