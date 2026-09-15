import { DEFAULT_VAT_RATE } from "@workspace/shared";
import { uniqueIndex, pgTable, serial, text, timestamp, integer, numeric, uuid, index } from "drizzle-orm/pg-core";
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
    notes: text("notes"),
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
