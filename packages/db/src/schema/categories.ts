import { pgTable, serial, text, boolean, timestamp, uuid, varchar, index, uniqueIndex } from "drizzle-orm/pg-core";
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
    //
    // 🔴 `zakat_relevant` was REMOVED in M17.0 (migration 0038), together with
    // `transactions.is_zakat_relevant`.
    //
    // Owner decision Q6: Zakat classification moves to this table, but as a
    // real chart-of-accounts mapping (which worksheet line does this GL account
    // feed — capital, retained earnings, a provision, a long-term liability, a
    // deductible long-term asset), NOT as a boolean. A yes/no flag cannot
    // express a working paper's structure, and this one barely expressed
    // anything: of the seeded accounts only INVESTMENT_INCOME carried `true`,
    // and its sole reader (`GET /summary/zakat`) has also been deleted.
    //
    // The replacement lands in M17.3. See docs/product/design-zakat-module.md.
    /**
     * M16.2 — the category's default VAT treatment for TRANSACTIONS categorized
     * under it: 'S' | 'Z' | 'E' | 'O', or NULL where no honest default exists
     * (OTHER_INCOME / OTHER_EXPENSES — a catch-all cannot know its treatment).
     * Reconcile-grade (design Q1): drives the transaction-side VAT estimate and
     * the reconciliation view, never the filing return. Overridable per row.
     */
    defaultTaxTreatment: text("default_tax_treatment"),
    /**
     * M16.3.1 — has `default_tax_treatment` been VERIFIED against actual KSA
     * VAT rules, or is it an assumed majority-default? (Owner decision at the
     * M16.3 close-out: an unverified default must be visible where it is USED,
     * not only where it is documented.) Only BANK_CHARGES and INSURANCE were
     * checked at M16.2; everything else is assumed until verified the same
     * way — see the verification-status flag in
     * docs/product/design-transaction-accounting.md and queue item C9.
     * Flipping this to true is a deliberate act recording a rule lookup,
     * never a side effect.
     */
    treatmentVerified: boolean("treatment_verified").notNull().default(false),
    /**
     * M18.1 — where this account sits on the liquidity scale, for the Finance
     * Hub's "can I pay what I owe?" block: `cash` | `quick` | `current` |
     * `non_current`. Meaningful for `asset` and `liability` accounts ONLY (a DB
     * CHECK enforces that); income/expense/equity stay NULL forever.
     *
     * Four values rather than a boolean because the ratios need two facts:
     * current assets are everything but `non_current`; QUICK assets are `cash`
     * + `quick`. A boolean answers the first and forces a hardcoded
     * "…except inventory" rule for the second, which breaks the moment a tenant
     * adds a prepayments account.
     *
     * 🔴 NULL on a balance-sheet account means UNCLASSIFIED and must stay
     * visible: an account that quietly counted as current would make the ratio
     * wrong in a way nothing surfaces. The hub reports unclassified accounts as
     * a control signal rather than silently defaulting them.
     */
    liquidityClass: varchar("liquidity_class", { length: 20 }),
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
