import { pgTable, serial, text, boolean, timestamp, numeric, uuid, integer, index, unique } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./organizations";
import { companiesTable } from "./companies";

export const bankAccountsTable = pgTable(
  "bank_accounts",
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
    name: text("name").notNull(),
    bankName: text("bank_name").notNull(),
    accountNumber: text("account_number"),
    iban: text("iban"),
    currency: text("currency").default("SAR"),
    balance: numeric("balance", { precision: 15, scale: 2 }).notNull().default("0"),
    openingBalance: numeric("opening_balance", { precision: 15, scale: 2 }).default("0"),
    isDefault: boolean("is_default").notNull().default(false),
    isActive: boolean("is_active").notNull().default(true),
    notes: text("notes"),
    /**
     * Batch 1C / G2 (2026-09-18): the opening journal that POSTED this bank's
     * opening balance to its D-3 leaf. While NULL the typed `openingBalance`
     * is display-only (the pre-1C state, recorded as a known gap); once set,
     * `openingBalance` equals the posted line and is read-only — one
     * definition, the ledger's.
     */
    openingJournalEntryId: integer("opening_journal_entry_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("bank_accounts_org_idx").on(t.organizationId),
    // G04 (0151, Phase 18 R-6): the target of a tenant-carrying reference — bank_detail_change_requests.
    unique("bank_accounts_org_id_unq").on(t.organizationId, t.id),
  ],
);

export const insertBankAccountSchema = createInsertSchema(bankAccountsTable)
  .omit({ id: true, createdAt: true })
  .extend({
    balance: z.string().or(z.number()).optional(),
    openingBalance: z.string().or(z.number()).optional(),
  });

export type InsertBankAccount = z.infer<typeof insertBankAccountSchema>;
export type BankAccount = typeof bankAccountsTable.$inferSelect;
