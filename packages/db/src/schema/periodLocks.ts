import { pgTable, serial, text, timestamp, integer, uuid } from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";
import { companiesTable } from "./companies";

/**
 * Fiscal period locks — once a month is locked, no new entries can be posted into it
 * and no existing entries in it can be modified without an explicit, logged reversal.
 */
export const periodLocksTable = pgTable("period_locks", {
  id: serial("id").primaryKey(),
  // Multi-tenancy (M2, additive) — nullable until M3 backfill + enforcement.
  // NOTE: the global unique(period) below becomes unique(org, company, period) in M3.
  organizationId: uuid("organization_id").references(() => organizationsTable.id),
  companyId: uuid("company_id").references(() => companiesTable.id),
  period: text("period").notNull().unique(), // YYYY-MM (e.g. "2026-06")
  lockedAt: timestamp("locked_at").defaultNow().notNull(),
  lockedBy: integer("locked_by"),    // FK to users.id
  notes: text("notes"),
});

export type PeriodLock = typeof periodLocksTable.$inferSelect;
