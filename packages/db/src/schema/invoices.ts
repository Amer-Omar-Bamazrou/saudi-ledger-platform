import { pgTable, serial, text, boolean, timestamp, integer, numeric } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { customersTable } from "./customers";
import { productsTable } from "./products";

export const invoicesTable = pgTable("invoices", {
  id: serial("id").primaryKey(),
  invoiceNumber: text("invoice_number").notNull(),
  date: text("date").notNull(),
  dueDate: text("due_date"),
  customerId: integer("customer_id").references(() => customersTable.id, { onDelete: "restrict" }),
  status: text("status").notNull().default("draft"), // draft | sent | paid | overdue | cancelled
  subtotal: numeric("subtotal", { precision: 15, scale: 2 }).notNull().default("0"),
  vatAmount: numeric("vat_amount", { precision: 15, scale: 2 }).notNull().default("0"),
  discount: numeric("discount", { precision: 15, scale: 2 }).default("0"),
  total: numeric("total", { precision: 15, scale: 2 }).notNull().default("0"),
  currency: text("currency").default("SAR"),
  paidAmount: numeric("paid_amount", { precision: 15, scale: 2 }).default("0"),
  paidAt: text("paid_at"),
  notes: text("notes"),
  termsAndConditions: text("terms_and_conditions"),
  createdBy: integer("created_by"),    // FK to users.id (nullable for pre-auth records)
  // ZATCA e-invoicing fields
  invoiceHash: text("invoice_hash"),   // SHA-256 of this invoice's canonical fields
  previousHash: text("previous_hash"), // Hash of the immediately preceding invoice (hash chain)
  qrCode: text("qr_code"),            // Base64 TLV-encoded QR code per ZATCA Phase 1 spec
  sellerName: text("seller_name"),     // Denormalized for QR (changes over time)
  sellerVatNumber: text("seller_vat_number"), // Denormalized for QR
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const invoiceItemsTable = pgTable("invoice_items", {
  id: serial("id").primaryKey(),
  invoiceId: integer("invoice_id").notNull().references(() => invoicesTable.id, { onDelete: "cascade" }),
  productId: integer("product_id").references(() => productsTable.id, { onDelete: "set null" }),
  description: text("description").notNull(),
  descriptionAr: text("description_ar").notNull().default("(not yet translated)"),
  quantity: numeric("quantity", { precision: 15, scale: 3 }).notNull().default("1"),
  unitPrice: numeric("unit_price", { precision: 15, scale: 2 }).notNull(),
  vatRate: numeric("vat_rate", { precision: 5, scale: 2 }).default("15"),
  vatAmount: numeric("vat_amount", { precision: 15, scale: 2 }).default("0"),
  discount: numeric("discount", { precision: 15, scale: 2 }).default("0"),
  total: numeric("total", { precision: 15, scale: 2 }).notNull().default("0"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertInvoiceSchema = createInsertSchema(invoicesTable).omit({ id: true, createdAt: true });
export const insertInvoiceItemSchema = createInsertSchema(invoiceItemsTable).omit({ id: true, createdAt: true });
export type InsertInvoice = z.infer<typeof insertInvoiceSchema>;
export type Invoice = typeof invoicesTable.$inferSelect;
export type InvoiceItem = typeof invoiceItemsTable.$inferSelect;
