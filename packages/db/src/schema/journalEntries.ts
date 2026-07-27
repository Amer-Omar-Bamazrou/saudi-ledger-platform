import { pgTable, serial, text, timestamp, integer, numeric, uuid } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { categoriesTable } from "./categories";
import { organizationsTable } from "./organizations";
import { companiesTable } from "./companies";
// Forward-reference users table (avoid circular import — use integer FK directly)


export const journalEntriesTable = pgTable("journal_entries", {
  id: serial("id").primaryKey(),
  // Multi-tenancy (M2, additive) — nullable until M3 backfill + enforcement.
  organizationId: uuid("organization_id").references(() => organizationsTable.id),
  companyId: uuid("company_id").references(() => companiesTable.id),
  entryNumber: text("entry_number").notNull(),
  date: text("date").notNull(),
  description: text("description").notNull(),
  reference: text("reference"),          // invoice/bill reference
  status: text("status").notNull().default("draft"), // draft | posted | reversed
  reversalOf: integer("reversal_of"),    // FK to self if reversal
  notes: text("notes"),
  postedAt: timestamp("posted_at"),      // set when status transitions to posted; entry is locked after this
  createdBy: integer("created_by"),      // FK to users.id (nullable — pre-auth entries have no owner)
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const journalEntryLinesTable = pgTable("journal_entry_lines", {
  id: serial("id").primaryKey(),
  // Multi-tenancy (M2, additive) — nullable until M3 backfill + enforcement.
  organizationId: uuid("organization_id").references(() => organizationsTable.id),
  companyId: uuid("company_id").references(() => companiesTable.id),
  journalEntryId: integer("journal_entry_id").notNull().references(() => journalEntriesTable.id, { onDelete: "cascade" }),
  accountId: integer("account_id").references(() => categoriesTable.id, { onDelete: "restrict" }),
  accountName: text("account_name").notNull(),   // denormalized for history
  description: text("description"),
  debitAmount: numeric("debit_amount", { precision: 15, scale: 2 }).notNull().default("0"),
  creditAmount: numeric("credit_amount", { precision: 15, scale: 2 }).notNull().default("0"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertJournalEntrySchema = createInsertSchema(journalEntriesTable).omit({ id: true, createdAt: true });
export const insertJournalEntryLineSchema = createInsertSchema(journalEntryLinesTable).omit({ id: true, createdAt: true });
export type InsertJournalEntry = z.infer<typeof insertJournalEntrySchema>;
export type JournalEntry = typeof journalEntriesTable.$inferSelect;
export type JournalEntryLine = typeof journalEntryLinesTable.$inferSelect;
