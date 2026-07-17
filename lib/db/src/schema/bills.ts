import { pgTable, serial, text, timestamp, integer, numeric } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { vendorsTable } from "./vendors";
import { productsTable } from "./products";

export const billsTable = pgTable("bills", {
  id: serial("id").primaryKey(),
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
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const billItemsTable = pgTable("bill_items", {
  id: serial("id").primaryKey(),
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
});

export const insertBillSchema = createInsertSchema(billsTable).omit({ id: true, createdAt: true });
export const insertBillItemSchema = createInsertSchema(billItemsTable).omit({ id: true, createdAt: true });
export type InsertBill = z.infer<typeof insertBillSchema>;
export type Bill = typeof billsTable.$inferSelect;
export type BillItem = typeof billItemsTable.$inferSelect;
