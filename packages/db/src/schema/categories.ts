import { pgTable, serial, text, boolean, timestamp, uuid, varchar, index, uniqueIndex, integer, type AnyPgColumn } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./organizations";
import { bankAccountsTable } from "./bankAccounts";

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
     * C9 (2026-08-19) — input VAT on this expenditure CLASS is not deductible
     * (VAT Implementing Regulations Art. 50; FOOD_MEALS = 50(1)(a)-(b),
     * entertainment and catering).
     *
     * 🔴 A THIRD AXIS, deliberately — do not fold it into treatment or basis
     * (owner decision). The supplier CHARGES VAT (treatment 'S' is factually
     * right), the buyer PAID it (basis 'charged' is right), and the law still
     * forbids DEDUCTING it. Folding into treatment would falsify the receipt
     * ('E' on a receipt that shows VAT); folding into basis would falsify the
     * payment. Readers of the recoverable-input-VAT estimate exclude blocked
     * categories; the paid-VAT FACT stays stored on the transaction.
     */
    inputVatBlocked: boolean("input_vat_blocked").notNull().default(false),
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
    /**
     * 🔴 D-3 / G3 (2026-09-16) — THE MINIMUM HIERARCHY: a bank cash leaf under
     * the "Cash and cash equivalents" header. `parent_id` exists for exactly
     * that relationship today; it is NOT a general chart-of-accounts tree
     * (no depth, no roll-up API, no user-managed parents — recorded as an
     * architectural limitation in docs/product/design-per-bank-cash.md).
     * Immutable on system rows (trigger `protect_system_categories`).
     */
    parentId: integer("parent_id").references((): AnyPgColumn => categoriesTable.id, { onDelete: "restrict" }),
    /**
     * 🔴 D-3: THE EXPLICIT bank-account → GL-account relationship. One leaf per
     * application bank account (unique), created by the DB trigger
     * `ensure_bank_gl_account` on `bank_accounts` INSERT — so the relationship
     * is a property of construction, not of whichever writer remembered it.
     * Never resolved by name: renaming the bank renames the leaf, and the
     * posting seam resolves a cash line by this column alone. Immutable once
     * set; the leaf goes with its bank (ON DELETE CASCADE), and only then —
     * the protection trigger refuses a direct delete, and the lines FK
     * (RESTRICT) refuses the cascade while history references the leaf.
     */
    bankAccountId: integer("bank_account_id").references(() => bankAccountsTable.id, { onDelete: "cascade" }),
    /**
     * 🔴 D-3: a NON-POSTING account is a header — `CASH` ("Cash and Bank")
     * since migration 0073. No new line may name it: the seam refuses it on
     * both arms, the manual-JE service refuses it with a 422, and the DB
     * trigger `refuse_non_posting_account_line` refuses every other writer.
     * The one permitted exception is a REVERSAL mirror of a historical header
     * line (`journal_entries.reversal_of IS NOT NULL`) — a mirror must name
     * the account it cancels. Immutable on system rows.
     */
    isPosting: boolean("is_posting").notNull().default(true),
    description: text("description"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("categories_org_idx").on(t.organizationId),
    // D-3: one GL leaf per bank account, and one bank account per leaf.
    uniqueIndex("categories_bank_account_unq").on(t.bankAccountId),
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
