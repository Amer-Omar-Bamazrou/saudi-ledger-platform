/**
 * Companies repository (M11.6) — the tenant's legal identity.
 *
 * Tenant-scoped: `companies` has RLS, so a plain query here only ever sees the
 * ACTIVE organization's rows (see the development guide §3). The "active
 * company" is the organization's first-created company — the same rule
 * `resolveTenant` uses to derive `req.tenant.companyId` and the
 * `app.current_company_id` GUC, so the two never disagree.
 */
import { db, companiesTable } from "@workspace/db";
import { asc, eq, sql } from "drizzle-orm";

export const companiesRepository = {
  /**
   * The active organization's company (first created), or undefined.
   *
   * Correct for the `/companies/current` endpoint, which is *about* the active
   * company. NOT correct for resolving the seller of a specific invoice — use
   * {@link findById} with that invoice's `companyId`. See the M12.1a note in
   * `services/sellerIdentity.ts`.
   */
  async findActive() {
    const [row] = await db
      .select()
      .from(companiesTable)
      .orderBy(asc(companiesTable.createdAt))
      .limit(1);
    return row;
  },

  /**
   * One company by id. RLS still confines this to the active organization, so a
   * cross-tenant id returns undefined rather than another tenant's row.
   */
  async findById(id: string) {
    const [row] = await db.select().from(companiesTable).where(eq(companiesTable.id, id)).limit(1);
    return row;
  },

  /**
   * The company THIS REQUEST is operating as — the `app.current_company_id` GUC
   * set by `resolveTenant`, which is also the DB default stamped onto any row
   * inserted during the request.
   *
   * Today `resolveTenant` picks the org's first-created company, so this matches
   * {@link findActive}. It is nonetheless the correct thing to key off: it stays
   * right once real per-request company selection exists, whereas "first
   * created" silently becomes wrong. Used to stamp an invoice draft's seller so
   * the draft can never disagree with the `company_id` on its own row (M12.1a).
   */
  async findCurrent() {
    const [row] = await db
      .select()
      .from(companiesTable)
      .where(sql`${companiesTable.id}::text = current_setting('app.current_company_id', true)`)
      .limit(1);
    return row;
  },

  update(id: string, values: Partial<typeof companiesTable.$inferInsert>) {
    return db
      .update(companiesTable)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(companiesTable.id, id))
      .returning();
  },
};
