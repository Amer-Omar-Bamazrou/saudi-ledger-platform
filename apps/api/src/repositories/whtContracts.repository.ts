/**
 * 🔴 Phase 18 G4c-1 (WHT decision 15): a supplier's contracts and the
 * tax-bearing setting each was confirmed with — APPEND-ONLY (0141 grants SELECT
 * and INSERT). There is no update or delete here. Tenant-scoped by RLS,
 * company-scoped explicitly.
 */
import { db, whtContractsTable } from "@workspace/db";
import { and, desc, eq, sql } from "drizzle-orm";

const currentCompany = sql`(nullif(current_setting('app.current_company_id', true), ''))::uuid`;

export const whtContractsRepository = {
  list(opts: { vendorId?: number } = {}) {
    const company = eq(whtContractsTable.companyId, currentCompany);
    return db.select().from(whtContractsTable)
      .where(opts.vendorId == null ? company : and(company, eq(whtContractsTable.vendorId, opts.vendorId)))
      .orderBy(desc(whtContractsTable.id));
  },
  insert(values: typeof whtContractsTable.$inferInsert) {
    return db.insert(whtContractsTable).values(values).returning();
  },
};
