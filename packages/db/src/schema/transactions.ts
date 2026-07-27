import {
  pgTable,
  serial,
  text,
  boolean,
  timestamp,
  numeric,
  integer,
  uuid,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { categoriesTable } from "./categories";
import { organizationsTable } from "./organizations";
import { companiesTable } from "./companies";

export const transactionsTable = pgTable(
  "transactions",
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
    date: text("date").notNull(), // stored as YYYY-MM-DD string
    description: text("description").notNull(),
    descriptionAr: text("description_ar"),
    amount: numeric("amount", { precision: 15, scale: 2 }).notNull(),
    currency: text("currency").notNull().default("SAR"),
    type: text("type").notNull(), // debit | credit
    categoryId: integer("category_id").references(() => categoriesTable.id, {
      onDelete: "set null",
    }),
    vatAmount: numeric("vat_amount", { precision: 15, scale: 2 }),
    vatRate: numeric("vat_rate", { precision: 5, scale: 2 }),
    isZakatRelevant: boolean("is_zakat_relevant").notNull().default(false),
    confidenceScore: numeric("confidence_score", { precision: 5, scale: 4 }),
    isManuallyOverridden: boolean("is_manually_overridden")
      .notNull()
      .default(false),
    source: text("source"),
    notes: text("notes"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("transactions_org_date_idx").on(t.organizationId, t.date)],
);

export const insertTransactionSchema = createInsertSchema(transactionsTable)
  .omit({ id: true, createdAt: true })
  .extend({
    amount: z.string().or(z.number()),
    vatAmount: z.string().or(z.number()).nullable().optional(),
    vatRate: z.string().or(z.number()).nullable().optional(),
    confidenceScore: z.string().or(z.number()).nullable().optional(),
  });

export type InsertTransaction = z.infer<typeof insertTransactionSchema>;
export type Transaction = typeof transactionsTable.$inferSelect;
