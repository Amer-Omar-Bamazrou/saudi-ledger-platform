import { pgTable, serial, text, timestamp, integer, numeric, uuid, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { vendorsTable } from "./vendors";
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
    date: text("date").notNull(),
    dueDate: text("due_date"),
    vendorId: integer("vendor_id").references(() => vendorsTable.id, { onDelete: "restrict" }),
    status: text("status").notNull().default("draft"), // draft | received | approved | paid | overdue
    subtotal: numeric("subtotal", { precision: 15, scale: 2 }).notNull().default("0"),
    vatAmount: numeric("vat_amount", { precision: 15, scale: 2 }).notNull().default("0"),
    total: numeric("total", { precision: 15, scale: 2 }).notNull().default("0"),
    currency: text("currency").default("SAR"),
    paidAmount: numeric("paid_amount", { precision: 15, scale: 2 }).default("0"),
    paidAt: text("paid_at"),
    notes: text("notes"),
    createdBy: integer("created_by"),    // FK to users.id (nullable for pre-auth records)
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("bills_org_status_idx").on(t.organizationId, t.status)],
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
    vatRate: numeric("vat_rate", { precision: 5, scale: 2 }).default("15"),
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
