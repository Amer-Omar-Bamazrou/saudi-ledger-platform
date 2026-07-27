import { pgTable, serial, text, timestamp, integer, uuid, unique } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizationsTable } from "./organizations";
import { companiesTable } from "./companies";

/**
 * Fiscal period locks — once a month is locked, no new entries can be posted into it
 * and no existing entries in it can be modified without an explicit, logged reversal.
 *
 * M3: uniqueness is tenant-scoped — each company closes its own periods, so the
 * key is (organization_id, company_id, period) rather than a global (period).
 */
export const periodLocksTable = pgTable(
  "period_locks",
  {
    id: serial("id").primaryKey(),
    // Multi-tenancy — enforced NOT NULL in M3 (migrations/0002).
    organizationId: uuid("organization_id")
      .notNull()
      .default(sql`app_default_org_id()`)
      .references(() => organizationsTable.id),
    companyId: uuid("company_id")
      .notNull()
      .default(sql`app_default_company_id()`)
      .references(() => companiesTable.id),
    period: text("period").notNull(), // YYYY-MM (e.g. "2026-06")
    lockedAt: timestamp("locked_at").defaultNow().notNull(),
    lockedBy: integer("locked_by"),    // FK to users.id
    notes: text("notes"),
  },
  (t) => [
    // Leading with organization_id, this composite unique also serves as the
    // tenant-scoped lookup index for period-lock checks.
    unique("period_locks_org_company_period_key").on(
      t.organizationId,
      t.companyId,
      t.period,
    ),
  ],
);

export type PeriodLock = typeof periodLocksTable.$inferSelect;
