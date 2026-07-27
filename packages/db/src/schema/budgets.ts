import { pgTable, serial, text, timestamp, integer, numeric, uuid, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { categoriesTable } from "./categories";
import { organizationsTable } from "./organizations";
import { companiesTable } from "./companies";

export const budgetsTable = pgTable(
  "budgets",
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
    name: text("name").notNull(),
    nameAr: text("name_ar").notNull().default("(not yet translated)"),
    period: text("period").notNull(),       // YYYY
    categoryId: integer("category_id").references(() => categoriesTable.id, { onDelete: "cascade" }),
    budgetedAmount: numeric("budgeted_amount", { precision: 15, scale: 2 }).notNull(),
    notes: text("notes"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("budgets_org_idx").on(t.organizationId)],
);

export const insertBudgetSchema = createInsertSchema(budgetsTable)
  .omit({ id: true, createdAt: true })
  .extend({ budgetedAmount: z.string().or(z.number()) });

export type InsertBudget = z.infer<typeof insertBudgetSchema>;
export type Budget = typeof budgetsTable.$inferSelect;
