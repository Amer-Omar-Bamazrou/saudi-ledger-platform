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
 * The filter uses the request's `app.current_company_id` GUC — the same value the
 * row's own column default uses, so a lock and its lookup can never disagree.
 */
import { db, periodLocksTable } from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";

/** The request's active company, as the row default sees it. */
const currentCompany = sql`(nullif(current_setting('app.current_company_id', true), ''))::uuid`;

export const periodLocksRepository = {
  list() {
    return db
      .select()
      .from(periodLocksTable)
      .where(eq(periodLocksTable.companyId, currentCompany))
      .orderBy(periodLocksTable.period);
  },
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
  removeByPeriod(period: string) {
    return db
      .delete(periodLocksTable)
      .where(and(eq(periodLocksTable.period, period), eq(periodLocksTable.companyId, currentCompany)));
  },
};
