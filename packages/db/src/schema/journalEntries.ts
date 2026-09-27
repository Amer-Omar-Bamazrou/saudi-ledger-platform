import { uniqueIndex, pgTable, serial, text, timestamp, integer, numeric, uuid, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { categoriesTable } from "./categories";
import { organizationsTable } from "./organizations";
import { companiesTable } from "./companies";
// Forward-reference users table (avoid circular import — use integer FK directly)


export const journalEntriesTable = pgTable(
  "journal_entries",
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
    entryNumber: text("entry_number").notNull(),
    /**
     * 🔴 CHECK journal_entries_date_format_chk (migration 0071, hand-written — the
     * 0020/0049/0062 precedent): exactly YYYY-MM-DD, below every application
     * guard. Do not drop on a snapshot diff; drizzle does not track CHECKs.
     * Why, and the audit that preceded it: findings file, "THE DATE-COLUMN
     * AUDIT" (2026-09-15).
     */
    date: text("date").notNull(),
    description: text("description").notNull(),
    reference: text("reference"),          // invoice/bill reference
    status: text("status").notNull().default("draft"), // draft | posted | reversed
    reversalOf: integer("reversal_of"),    // FK to self if reversal
    /**
     * Phase 11 A4 (2026-09-22) — WHY the entry was reversed, on the REVERSING
     * entry (the mirror), not on the original.
     *
     * 🔴 It belongs on the mirror because that is the row the reversal IS.
     * The original is a fact of record whose only change is the `reversed`
     * marker; writing the reason onto it would be editing a posted entry to
     * explain a later event. A reader arriving at the original follows
     * `reversal_of` from the mirror — the same direction every other consumer
     * already travels.
     *
     * NULL on every reversal written before this column existed, and on
     * migration reversals, whose reason is the batch (`source`,
     * `migration_batch_id`).
     */
    reversalReason: text("reversal_reason"),
    /**
     * Batch 1C (2026-09-18): what produced the entry. NULL on every entry
     * written before this column existed (their provenance is the number
     * prefix, as `ledgerInvariants.ts` reads it); `opening` for a migration's
     * opening journal, `opening_reversal` for a reversed migration (the
     * former `opening_clearing` was removed with the OBE mechanism — A5,
     * 2026-09-20). Readers that must exclude
     * the opening from period MOVEMENT key on this, never on the date.
     */
    source: text("source"),
    /** The migration batch that posted this entry (opening, reversal). */
    migrationBatchId: integer("migration_batch_id"),
    notes: text("notes"),
    postedAt: timestamp("posted_at"),      // set when status transitions to posted; entry is locked after this
    createdBy: integer("created_by"),      // FK to users.id (nullable — pre-auth entries have no owner)
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("journal_entries_org_status_idx").on(t.organizationId, t.status),
    // N3: a document number means ONE document. Declared here so drizzle-kit
    // cannot read the index as drift (the N4 lesson); pinned by
    // money-unique-indexes.test.ts, which asserts BOTH the database and this
    // declaration.
    uniqueIndex("journal_entries_company_number_unq").on(t.companyId, t.entryNumber),
  ],
);

export const journalEntryLinesTable = pgTable(
  "journal_entry_lines",
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
    journalEntryId: integer("journal_entry_id").notNull().references(() => journalEntriesTable.id, { onDelete: "cascade" }),
    accountId: integer("account_id").references(() => categoriesTable.id, { onDelete: "restrict" }),
    accountName: text("account_name").notNull(),   // denormalized for history
    /**
     * 🔴 N3 (2026-09-03): THE PARTY DIMENSION. A control-account line (AR/AP)
     * names WHO the receivable/payable is with, so the GL and the per-customer
     * views (aging, statements, ledger) can stop being computed from different
     * tables that structurally cannot agree. `party_type` discriminates;
     * `jel_party_consistency_chk` (migration 0066) makes an inconsistent
     * combination inexpressible. Populated by every document posting path;
     * `postJournalEntry` refuses a systemCode AR/AP line without one.
     */
    partyType: text("party_type"),
    customerId: integer("customer_id"),
    vendorId: integer("vendor_id"),
    description: text("description"),
    debitAmount: numeric("debit_amount", { precision: 15, scale: 2 }).notNull().default("0"),
    creditAmount: numeric("credit_amount", { precision: 15, scale: 2 }).notNull().default("0"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("journal_entry_lines_org_entry_idx").on(t.organizationId, t.journalEntryId)],
);

export const insertJournalEntrySchema = createInsertSchema(journalEntriesTable).omit({ id: true, createdAt: true });
export const insertJournalEntryLineSchema = createInsertSchema(journalEntryLinesTable).omit({ id: true, createdAt: true });
export type InsertJournalEntry = z.infer<typeof insertJournalEntrySchema>;
export type JournalEntry = typeof journalEntriesTable.$inferSelect;
export type JournalEntryLine = typeof journalEntryLinesTable.$inferSelect;
