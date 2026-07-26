import { pgTable, serial, text, timestamp, integer, numeric } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { categoriesTable } from "./categories";

export const fixedAssetsTable = pgTable("fixed_assets", {
  id: serial("id").primaryKey(),
  assetNumber: text("asset_number").notNull(),
  name: text("name").notNull(),
  nameAr: text("name_ar").notNull().default("(not yet translated)"),
  categoryId: integer("category_id").references(() => categoriesTable.id, { onDelete: "set null" }),
  purchaseDate: text("purchase_date").notNull(),
  purchaseCost: numeric("purchase_cost", { precision: 15, scale: 2 }).notNull(),
  salvageValue: numeric("salvage_value", { precision: 15, scale: 2 }).default("0"),
  usefulLifeYears: numeric("useful_life_years", { precision: 5, scale: 1 }).notNull(),
  depreciationMethod: text("depreciation_method").notNull().default("straight-line"), // straight-line | declining
  accumulatedDepreciation: numeric("accumulated_depreciation", { precision: 15, scale: 2 }).default("0"),
  currentBookValue: numeric("current_book_value", { precision: 15, scale: 2 }).notNull(),
  location: text("location"),
  serialNumber: text("serial_number"),
  status: text("status").notNull().default("active"), // active | fully-depreciated | disposed | sold
  disposalDate: text("disposal_date"),
  disposalValue: numeric("disposal_value", { precision: 15, scale: 2 }),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const depreciationEntriesTable = pgTable("depreciation_entries", {
  id: serial("id").primaryKey(),
  assetId: integer("asset_id").notNull().references(() => fixedAssetsTable.id, { onDelete: "cascade" }),
  period: text("period").notNull(),       // YYYY-MM
  amount: numeric("amount", { precision: 15, scale: 2 }).notNull(),
  bookValueAfter: numeric("book_value_after", { precision: 15, scale: 2 }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertFixedAssetSchema = createInsertSchema(fixedAssetsTable)
  .omit({ id: true, createdAt: true })
  .extend({
    purchaseCost: z.string().or(z.number()),
    salvageValue: z.string().or(z.number()).optional(),
    usefulLifeYears: z.string().or(z.number()),
    currentBookValue: z.string().or(z.number()),
    accumulatedDepreciation: z.string().or(z.number()).optional(),
  });

export type InsertFixedAsset = z.infer<typeof insertFixedAssetSchema>;
export type FixedAsset = typeof fixedAssetsTable.$inferSelect;
export type DepreciationEntry = typeof depreciationEntriesTable.$inferSelect;
