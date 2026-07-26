import { pgTable, serial, text, timestamp, integer } from "drizzle-orm/pg-core";

/**
 * Fiscal period locks — once a month is locked, no new entries can be posted into it
 * and no existing entries in it can be modified without an explicit, logged reversal.
 */
export const periodLocksTable = pgTable("period_locks", {
  id: serial("id").primaryKey(),
  period: text("period").notNull().unique(), // YYYY-MM (e.g. "2026-06")
  lockedAt: timestamp("locked_at").defaultNow().notNull(),
  lockedBy: integer("locked_by"),    // FK to users.id
  notes: text("notes"),
});

export type PeriodLock = typeof periodLocksTable.$inferSelect;
