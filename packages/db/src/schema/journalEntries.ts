import { uniqueIndex, pgTable, serial, text, timestamp, integer, numeric, uuid, index, foreignKey } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { categoriesTable } from "./categories";
import { customersTable } from "./customers";
import { vendorsTable } from "./vendors";
import { organizationsTable } from "./organizations";
import { companiesTable } from "./companies";
// Forward-reference users table (avoid circular import — use integer FK directly)

/**
 * 🔴 T1d (Phase 18, G07/G17): what produced a journal entry, replacing
 * provenance-by-number-prefix for every entry written from 0129 on. Each type
 * names the row its `source_id` points at; `manual` has none (the entry is the
 * document), nor `recurring` (the rule's run log links rule and entry). The database CHECK `journal_entries_source_type_chk` (0129) holds
 * this same list; `phase18-t1d-journal-provenance.test.ts` fails if they drift.
 */
export const JOURNAL_SOURCE_TYPES = [
  "manual",                            // no source_id: the entry itself
  "recurring",                         // no source_id: a rule's id is a uuid; its run log names the rule and the entry
  "reversal",                          // journal_entries.id (the entry reversed)
  "invoice",                           // invoices.id (invoice, debit/credit note, advance, recovery)
  "invoice_write_off",                 // invoices.id (bad-debt relief)
  "credit_note_application",           // invoices.id (the credit note applied)
  "customer_payment",                  // payments.id
  "customer_payment_allocation",       // payments.id (the receipt allocated)
  "customer_allocation_correction",    // payment_allocations.id (the allocation corrected)
  "customer_refund",                   // customer_refunds.id
  "customer_payment_reclassification", // payments.id
  "bill",                              // bills.id (bill, supplier note, advance invoice and its note)
  "bill_payment",                      // bill_payments.id
  "vat_evidence",                      // bills.id (the bill whose input VAT the evidence claims)
  "supplier_payment",                  // supplier_payments.id
  "supplier_advance_allocation",       // supplier_payments.id (the advance allocated)
  "supplier_allocation_reversal",      // supplier_payment_allocations.id
  "supplier_payment_reclassification", // supplier_payments.id
  "supplier_refund",                   // supplier_payments.id (the payment refunded)
  "bank_transfer",                     // bank_transfers.id
  "bank_transaction",                  // transactions.id
  "payroll_run",                       // payroll_runs.id (the accrual)
  "payroll_net_pay",                   // payroll_runs.id
  "payroll_gosi_payment",              // payroll_runs.id
  "depreciation",                      // fixed_assets.id (the asset depreciated; the period is in the number)
  "asset_disposal",                    // fixed_assets.id (the asset disposed)
  "recognition",                       // recognition_schedules.id (the period is in the number)
  "tax_computation",                   // tax_computation_versions.id (the version approved)
  "wht_remittance",                    // wht_remittances.id
  "wht_remittance_reversal",           // wht_remittances.id (the remittance reversed)
  "migration_opening",                 // migration_batches.id
  "migration_reversal",                // migration_batches.id
  "opening_correction",                // migration_open_items.id (the opening item corrected)
] as const;
export type JournalSourceType = (typeof JOURNAL_SOURCE_TYPES)[number];

/**
 * 🔴 T1d (SG-11 / G17): the entry-number prefixes the system writes for a
 * document's posting. A user-written entry (manual or recurring) never takes
 * one, in any letter case, nor a reversal's `-REV` suffix — the database CHECK
 * `journal_entries_manual_number_reserved_chk` (0129) holds the same list.
 * The manual auto-number `JE-NNNNNN` is refused TYPED by the service only
 * (an auto-numbered manual entry carries it).
 */
export const RESERVED_ENTRY_NUMBER_PREFIXES = [
  "GL", "BILL", "BILLCN", "BILLADV", "BILLADVCN", "DEP", "DISP", "WO", "PAY", "VATEV", "MIG", "OPEN",
  "SPAY", "SALLOC", "SRECLASS", "SREFUND", "BTR", "TXN", "RCPT", "ALLOC", "UNALLOC", "REFUND", "RECLASS",
  "ZAKAT", "INCTAX", "WHTREM", "WHTREMREV",
] as const;


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
    /**
     * 🔴 T1d (Phase 18, G07/G17; migration 0129): what produced the entry
     * (`JOURNAL_SOURCE_TYPES`) and the row it came from. NULL on every entry
     * written before 0129 (no back-fill: their provenance stays the number
     * prefix). Every writer from 0129 on sets it.
     */
    sourceType: text("source_type"),
    sourceId: integer("source_id"),
    /**
     * 🔴 T1d (G07): the user whose approval posted the entry; NULL where no
     * approval posted it. Written on the DRAFT, immediately before the draft →
     * posted flip (owner, 2026-10-24): G16's flip check allows only `status`
     * and `posted_at` to change, so it can never be written in the flip. A
     * manual or recurring entry cannot be posted without it (0129).
     */
    approvedBy: integer("approved_by"),
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
    // Phase 14 D14-15 (re-measured 2026-10-01, AS THE TENANT ROLE): the report seam scopes
    // the company with the TYPED predicate (companyScope.ts) — an Index Cond on this index;
    // the earlier `company_id::text` form could not use one under RLS. Plus the date every
    // report bounds. Record: phase-14-15 decision pack D14-15.
    index("journal_entries_company_date_idx").on(t.companyId, t.date),
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
    // 🔴 G04 (0122): no single-column key — the account is referenced WITH the
    // organization (`journal_entry_lines_account_tenant_fk` below).
    accountId: integer("account_id"),
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
  (t) => [
    index("journal_entry_lines_org_entry_idx").on(t.organizationId, t.journalEntryId),
    // Phase 14 D14-15: the seam joins entries → lines by entry id; the org-led
    // index above cannot serve a probe on journal_entry_id alone.
    index("journal_entry_lines_entry_idx").on(t.journalEntryId),
    /**
     * 🔴 G04 (2026-10-07, migration 0122): A LINE NAMES ONLY ITS OWN
     * ORGANIZATION'S ACCOUNT, CUSTOMER AND VENDOR. Postgres checks a foreign key
     * OUTSIDE row-level security, so the plain `account_id → categories.id`
     * accepted another tenant's account (written, approved and posted) and failed
     * a missing one as a raw 23503. Keyed WITH the organization, the database
     * itself compares the tenant, for every writer — and a foreign id and a
     * missing id are the same failure. Accounts, customers and vendors stay
     * organization-level: every company of the organization references them.
     */
    foreignKey({ name: "journal_entry_lines_account_tenant_fk", columns: [t.organizationId, t.accountId], foreignColumns: [categoriesTable.organizationId, categoriesTable.id] }).onDelete("restrict"),
    foreignKey({ name: "journal_entry_lines_customer_tenant_fk", columns: [t.organizationId, t.customerId], foreignColumns: [customersTable.organizationId, customersTable.id] }).onDelete("restrict"),
    foreignKey({ name: "journal_entry_lines_vendor_tenant_fk", columns: [t.organizationId, t.vendorId], foreignColumns: [vendorsTable.organizationId, vendorsTable.id] }).onDelete("restrict"),
  ],
);

export const insertJournalEntrySchema = createInsertSchema(journalEntriesTable).omit({ id: true, createdAt: true });
export const insertJournalEntryLineSchema = createInsertSchema(journalEntryLinesTable).omit({ id: true, createdAt: true });
export type InsertJournalEntry = z.infer<typeof insertJournalEntrySchema>;
export type JournalEntry = typeof journalEntriesTable.$inferSelect;
export type JournalEntryLine = typeof journalEntryLinesTable.$inferSelect;
