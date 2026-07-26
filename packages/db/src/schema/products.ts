import { pgTable, serial, text, boolean, timestamp, integer, numeric } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { categoriesTable } from "./categories";

export const productsTable = pgTable("products", {
  id: serial("id").primaryKey(),
  code: text("code"),                    // SKU / product code
  name: text("name").notNull(),
  nameAr: text("name_ar").notNull().default("(not yet translated)"),
  type: text("type").notNull().default("service"), // product | service
  unitPrice: numeric("unit_price", { precision: 15, scale: 2 }).notNull().default("0"),
  unitCost: numeric("unit_cost", { precision: 15, scale: 2 }),
  currency: text("currency").default("SAR"),
  unit: text("unit").default("unit"),    // unit, hour, kg, etc.
  categoryId: integer("category_id").references(() => categoriesTable.id, { onDelete: "set null" }),
  vatApplicable: boolean("vat_applicable").notNull().default(true),
  stockQty: numeric("stock_qty", { precision: 15, scale: 3 }).default("0"),
  reorderPoint: numeric("reorder_point", { precision: 15, scale: 3 }),
  description: text("description"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertProductSchema = createInsertSchema(productsTable)
  .omit({ id: true, createdAt: true })
  .extend({
    unitPrice: z.string().or(z.number()),
    unitCost: z.string().or(z.number()).nullable().optional(),
    stockQty: z.string().or(z.number()).nullable().optional(),
    reorderPoint: z.string().or(z.number()).nullable().optional(),
  });

export type InsertProduct = z.infer<typeof insertProductSchema>;
export type Product = typeof productsTable.$inferSelect;
