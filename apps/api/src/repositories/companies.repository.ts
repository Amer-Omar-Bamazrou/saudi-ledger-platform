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
import { asc, eq } from "drizzle-orm";

export const companiesRepository = {
  /** The active organization's company (first created), or undefined. */
  async findActive() {
    const [row] = await db
      .select()
      .from(companiesTable)
      .orderBy(asc(companiesTable.createdAt))
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
