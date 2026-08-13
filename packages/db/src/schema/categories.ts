import { pgTable, serial, text, boolean, timestamp, uuid, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./organizations";

export const categoriesTable = pgTable(
  "categories",
  {
    id: serial("id").primaryKey(),
    // Multi-tenancy — enforced NOT NULL in M3 (migrations/0002).
    // Chart-of-accounts scoping (org template vs. per-company) may gain company_id later.
    organizationId: uuid("organization_id")
      .notNull()
      .default(sql`app_default_org_id()`)
      // ON DELETE CASCADE (M13): every organization is auto-seeded with a system
      // chart of accounts by a DB trigger, so it owns rows it never asked for.
      // They must disappear with it — otherwise deleting an organization fails
      // the FK, which is what broke every teardown path when the trigger landed.
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    nameAr: text("name_ar").notNull(),
    type: text("type").notNull(), // income | expense | asset | liability | equity
    /**
     * Stable identity for the accounts the POSTING PATH resolves against (M13).
     * NULL for ordinary user-created categories.
     *
     * 🔴 The posting path names a CODE, never a name. Names are labels the
     * tenant may rename or translate; resolving by name would mean a rename
     * silently breaks classification — which is the bug class M13 removes.
     * See `packages/db/src/chartOfAccounts.ts`.
     */
    systemCode: text("system_code"),
    /**
     * Protected: cannot be deleted and its `type` cannot be changed, because the
     * posting path and every financial statement depend on both. `name`/`name_ar`
     * stay freely editable — the code is the identity, not the label.
     */
    isSystem: boolean("is_system").notNull().default(false),
    vatApplicable: boolean("vat_applicable").notNull().default(false),
    zakatRelevant: boolean("zakat_relevant").notNull().default(false),
    /**
     * M16.2 — the category's default VAT treatment for TRANSACTIONS categorized
     * under it: 'S' | 'Z' | 'E' | 'O', or NULL where no honest default exists
     * (OTHER_INCOME / OTHER_EXPENSES — a catch-all cannot know its treatment).
     * Reconcile-grade (design Q1): drives the transaction-side VAT estimate and
     * the reconciliation view, never the filing return. Overridable per row.
     */
    defaultTaxTreatment: text("default_tax_treatment"),
    description: text("description"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("categories_org_idx").on(t.organizationId),
    // One account per code per org — this is what makes `seedChartOfAccounts`
    // idempotent and safe to run concurrently, including from the migration
    // that back-fills every pre-M13 organization.
    uniqueIndex("categories_org_system_code_unq").on(t.organizationId, t.systemCode),
  ],
);

export const insertCategorySchema = createInsertSchema(categoriesTable).omit({
  id: true,
  createdAt: true,
});

export type InsertCategory = z.infer<typeof insertCategorySchema>;
export type Category = typeof categoriesTable.$inferSelect;
