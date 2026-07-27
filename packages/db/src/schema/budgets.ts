import { pgTable, serial, text, timestamp, integer, numeric, uuid } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { categoriesTable } from "./categories";
import { organizationsTable } from "./organizations";
import { companiesTable } from "./companies";

export const budgetsTable = pgTable("budgets", {
  id: serial("id").primaryKey(),
  // Multi-tenancy (M2, additive) — nullable until M3 backfill + enforcement.
  organizationId: uuid("organization_id").references(() => organizationsTable.id),
  companyId: uuid("company_id").references(() => companiesTable.id),
  name: text("name").notNull(),
  nameAr: text("name_ar").notNull().default("(not yet translated)"),
  period: text("period").notNull(),       // YYYY
  categoryId: integer("category_id").references(() => categoriesTable.id, { onDelete: "cascade" }),
  budgetedAmount: numeric("budgeted_amount", { precision: 15, scale: 2 }).notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertBudgetSchema = createInsertSchema(budgetsTable)
  .omit({ id: true, createdAt: true })
  .extend({ budgetedAmount: z.string().or(z.number()) });

export type InsertBudget = z.infer<typeof insertBudgetSchema>;
export type Budget = typeof budgetsTable.$inferSelect;
