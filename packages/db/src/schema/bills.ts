import { DEFAULT_VAT_RATE } from "@workspace/shared";
import { uniqueIndex, pgTable, serial, text, boolean, timestamp, integer, numeric, uuid, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { vendorsTable } from "./vendors";
import { categoriesTable } from "./categories";
import { productsTable } from "./products";
import { organizationsTable } from "./organizations";
import { companiesTable } from "./companies";

export const billsTable = pgTable(
  "bills",
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
    billNumber: text("bill_number").notNull(),
    /**
     * B7 (2026-09-22) — `bill` | `credit_note` | `debit_note`.
     *
     * 🔴 A PURCHASE-SIDE NOTE IS THE SUPPLIER'S DOCUMENT, NOT OURS. The VAT
     * IR's Credit and Debit Notes ¶1 puts the obligation on "the Taxable Person
     * WHO HAS MADE THE SUPPLY": when our tenant is the customer it ISSUES
     * nothing — no ICV is consumed, no QR is minted, no position is taken in
     * the ZATCA hash chain, nothing is queued to the outbox. We RECORD a
     * document we received. That is the whole difference from
     * `invoices.document_type`, which looks identical and is not.
     *
     * 🔴 And the period is the supplier's, not ours: Art. 40(6) has the
     * CUSTOMER correct its INPUT tax "in the Tax Period in which the Credit
     * Note or Debit Note is ISSUED" — so the note carries its own `date` (the
     * supplier's issue date) and the VAT return reads that, never the original
     * bill's date and never the day we keyed it in.
     */
    documentType: text("document_type").notNull().default("bill"),
    /** The bill this note adjusts. Required on a note, forbidden on a bill. */
    creditNoteAgainstBillId: integer("credit_note_against_bill_id"),
    vendorReference: text("vendor_reference"),
    /**
     * 🔴 CHECK bills_date_format_chk (migration 0071, hand-written — the
     * 0020/0049/0062 precedent): exactly YYYY-MM-DD, below every application
     * guard. Do not drop on a snapshot diff; drizzle does not track CHECKs.
     * Why, and the audit that preceded it: findings file, "THE DATE-COLUMN
     * AUDIT" (2026-09-15).
     */
    date: text("date").notNull(),
    dueDate: text("due_date"),
    vendorId: integer("vendor_id").references(() => vendorsTable.id, { onDelete: "restrict" }),
    // Draft/approval workflow (M10.3): draft = editable, not in books nor in the
    // approval queue; submitted = awaiting approval (locked); received = approved
    // & posted to the GL (in AP/expense/VAT). paid/overdue are post-approval.
    // `overdue` removed — DERIVED from due_date (see bills.repository `OVERDUE`).
    status: text("status").notNull().default("draft"), // draft | submitted | received | approved | paid
    subtotal: numeric("subtotal", { precision: 15, scale: 2 }).notNull().default("0"),
    vatAmount: numeric("vat_amount", { precision: 15, scale: 2 }).notNull().default("0"),
    total: numeric("total", { precision: 15, scale: 2 }).notNull().default("0"),
    currency: text("currency").default("SAR"),
    paidAmount: numeric("paid_amount", { precision: 15, scale: 2 }).default("0"),
    paidAt: text("paid_at"),
    // Correction note an approver leaves when sending a submitted bill back to the
    // bookkeeper for edit; shown while editing, cleared on resubmit/approve (M10.3).
    reviewNote: text("review_note"),
    /**
     * The expense account the bill posts to, chosen at entry (2026-09-15,
     * workflow audit W2 G1). It lives ON the bill so it survives submit →
     * approve: the Approvals queue sends no body, and the choice used to exist
     * only in the post request, so every two-person bill fell back to
     * Purchases. Resolved by `resolveExpenseLine` when the post/approve body
     * supplies nothing; a body value still wins. Nullable — the seeded default
     * (PURCHASES) applies when neither is given.
     */
    expenseAccountId: integer("expense_account_id").references(() => categoriesTable.id, { onDelete: "set null" }),
    /**
     * FA-B (2026-09-22): the DRAFT fixed asset this bill buys. Set on the
     * draft bill; at approval the debit line becomes the asset category's
     * COST account and the asset is capitalised on that entry (one writer,
     * one effect — fixed-assets pack §3 A1, §21). NULL = an ordinary expense
     * bill. No FK to fixed_assets here: the register is the newer table and
     * the link is read forward (fixed_assets.bill_id carries the other side).
     */
    capitalisesAssetId: integer("capitalises_asset_id"),
    notes: text("notes"),
    /** Batch 1C: an opening payable migrated at cut-off (see invoices.isOpening). */
    isOpening: boolean("is_opening").notNull().default(false),
    migrationOpenItemId: integer("migration_open_item_id"),
    /** Batch 1C Policy C — the reversed marker and the replacement link; see invoices.reversedAt (pack §16.12.1). */
    reversedAt: timestamp("reversed_at", { withTimezone: true }),
    reversedByMigrationBatchId: integer("reversed_by_migration_batch_id"),
    /** 2026-09-22: on an ORIGINAL opening payable corrected under A4/answer 5 — the entry whose other side is retained earnings (see invoices.openingCorrectionJournalEntryId). */
    openingCorrectionJournalEntryId: integer("opening_correction_journal_entry_id"),
    replacesBillId: integer("replaces_bill_id"),
    createdBy: integer("created_by"),    // FK to users.id (nullable for pre-auth records)
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("bills_org_status_idx").on(t.organizationId, t.status),
    // N3: a bill number means ONE bill. Declared so drizzle-kit cannot read
    // the index as drift (the N4 lesson); pinned by money-unique-indexes.
    uniqueIndex("bills_company_number_unq").on(t.companyId, t.billNumber),
  ],
);

export const billItemsTable = pgTable(
  "bill_items",
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
    billId: integer("bill_id").notNull().references(() => billsTable.id, { onDelete: "cascade" }),
    productId: integer("product_id").references(() => productsTable.id, { onDelete: "set null" }),
    description: text("description").notNull(),
    descriptionAr: text("description_ar"),
    quantity: numeric("quantity", { precision: 15, scale: 3 }).notNull().default("1"),
    unitPrice: numeric("unit_price", { precision: 15, scale: 2 }).notNull(),
    vatRate: numeric("vat_rate", { precision: 5, scale: 2 }).default(String(DEFAULT_VAT_RATE)),
    vatAmount: numeric("vat_amount", { precision: 15, scale: 2 }).default("0"),
    total: numeric("total", { precision: 15, scale: 2 }).notNull().default("0"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("bill_items_org_bill_idx").on(t.organizationId, t.billId)],
);

export const insertBillSchema = createInsertSchema(billsTable).omit({ id: true, createdAt: true });
export const insertBillItemSchema = createInsertSchema(billItemsTable).omit({ id: true, createdAt: true });
export type InsertBill = z.infer<typeof insertBillSchema>;
export type Bill = typeof billsTable.$inferSelect;
export type BillItem = typeof billItemsTable.$inferSelect;
