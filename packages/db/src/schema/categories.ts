import { pgTable, serial, text, boolean, timestamp, uuid } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./organizations";

export const categoriesTable = pgTable("categories", {
  id: serial("id").primaryKey(),
  // Multi-tenancy (M2, additive) — nullable until M3 backfill + enforcement.
  // Chart-of-accounts scoping (org template vs. per-company) is decided in M3;
  // company_id is intentionally omitted for now.
  organizationId: uuid("organization_id").references(() => organizationsTable.id),
  name: text("name").notNull(),
  nameAr: text("name_ar").notNull(),
  type: text("type").notNull(), // income | expense | asset | liability | equity
  vatApplicable: boolean("vat_applicable").notNull().default(false),
  zakatRelevant: boolean("zakat_relevant").notNull().default(false),
  description: text("description"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertCategorySchema = createInsertSchema(categoriesTable).omit({
  id: true,
  createdAt: true,
});

export type InsertCategory = z.infer<typeof insertCategorySchema>;
export type Category = typeof categoriesTable.$inferSelect;
