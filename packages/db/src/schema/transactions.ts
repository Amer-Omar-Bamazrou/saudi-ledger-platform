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
import { bankAccountsTable } from "./bankAccounts";
import { invoicesTable } from "./invoices";
import { billsTable } from "./bills";
import { journalEntriesTable } from "./journalEntries";

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
    /**
     * The M15 holding area — the status column M10 deferred.
     *
     * `pending_review` — imported (upload / future bank feed): visible in the
     *   Transactions list but contributes to NO tax-facing figure. VAT, Zakat,
     *   cash flow, the dashboard and budget actuals all filter to `accepted`.
     * `accepted` — a human has taken responsibility for it.
     *
     * Why a column and not the M10 `Approvable` engine (owner decision): M10
     * models DOCUMENTS with individual legal significance — each a discrete act
     * someone approves after looking at that document. A bank line is not a
     * document; it is EVIDENCE of one that exists elsewhere. Nobody approves a
     * POS purchase the way they approve an invoice — they scan a month for what
     * looks wrong. Forcing hundreds of rows through a per-document engine
     * floods the audit log with transitions nobody reads, burying signal.
     * The M10 PRINCIPLE (zero movement until a human acts) holds; only the
     * mechanism differs: report filters, proven by a zero-movement test.
     *
     * Default is the fail-safe direction. The manual single-entry path sets
     * `accepted` explicitly — a human typing one row IS looking at it (the
     * M10.4 self-approve analogue).
     */
    reviewStatus: text("review_status").notNull().default("pending_review"),
    /**
     * M16.2 — what KIND of money movement this is (design Q2):
     *
     * `operating`  — a real income/expense event. The only kind that reaches
     *                income, expense, VAT, Zakat, per-category and budget
     *                aggregates.
     * `transfer`   — money moving between the business's own pockets (ATM
     *                withdrawal, own-account transfer, credit-card settlement).
     *                An asset movement: NO P&L or tax figure may read it. It
     *                stays visible in the transaction list and in cash flow —
     *                the bank balance genuinely moved.
     * `settlement` — reserved for M16.3: a receipt/payment that settles an
     *                existing invoice/bill. Excluded like a transfer (the income
     *                was recognised at issuance); linked to its document.
     *
     * The classification IS this column — a transfer deliberately carries NO
     * category, because a category states what was bought or earned, and a
     * transfer is neither.
     */
    kind: text("kind").notNull().default("operating"),
    /**
     * M16.2 — VAT treatment (design Q1, reconcile-grade): 'S' | 'Z' | 'E' | 'O',
     * NULL = UNKNOWN and nothing else. Pre-M16.2, `vat_amount IS NULL` conflated
     * four different facts (exempt / zero-rated / out-of-scope / don't know).
     * Stamped from the category's `default_tax_treatment` at categorization,
     * overridable per row. VAT is extracted ONLY when treatment is 'S'.
     */
    taxTreatment: text("tax_treatment"),
    /**
     * 🔴 Flaw #6 — WHETHER VAT WAS ACTUALLY CHARGED, which is a different fact
     * from what the supply IS.
     *
     * `tax_treatment` is the ZATCA supply taxonomy (S/Z/E/O): it says a supply
     * is standard-rated. It cannot say that no VAT reached this bank line —
     * and two common cases mean exactly that:
     *
     *   `reverse_charge`        — a foreign supplier (Google Ireland, AWS
     *                             Luxembourg, Meta) charges no KSA VAT; the
     *                             BUYER self-accounts for it. The supply is
     *                             standard-rated; the payment carries nothing.
     *   `supplier_unregistered` — a small local supplier below the VAT
     *                             threshold charges none.
     *
     * Conflating the two facts is what invented phantom input VAT: a live SME
     * statement produced 450.00 of "input VAT" on a Google Ads charge and
     * 65.22 on an AWS one, none of which existed. VAT is now extracted ONLY
     * when treatment = 'S' AND basis = 'charged', enforced by a DB CHECK.
     *
     * NULL = not yet established. The engine's reverse-charge guess for known
     * foreign suppliers is an ASSUMPTION (some have since registered in KSA),
     * so it is surfaced as overridable in review, never as settled fact.
     */
    vatBasis: text("vat_basis"),
    /**
     * M16.2 — which bank account this line belongs to (design Q2). Statement
     * import asks; a bank feed (A2) is per-account by nature. Scopes duplicate
     * detection and is the foundation for transfer-leg pairing (v2). Nullable:
     * pre-M16.2 rows and manual entries may not name one.
     */
    bankAccountId: integer("bank_account_id").references(() => bankAccountsTable.id, {
      onDelete: "set null",
    }),
    /**
     * M16.3 — reconciliation links (design §3). Set when a human accepts a
     * settlement match: the invoice this credit settled, or the bill this debit
     * paid. Exactly one may be set (DB CHECK), and only alongside
     * `kind = 'settlement'`. Makes "where did this payment go?" answerable from
     * either side. The ledger effect itself is posted by the EXISTING pay path
     * (`invoicesService.pay` / `billsService.pay`) — these columns are the
     * cross-reference, never a second posting mechanism.
     */
    settlesInvoiceId: integer("settles_invoice_id").references(() => invoicesTable.id, {
      onDelete: "set null",
    }),
    settlesBillId: integer("settles_bill_id").references(() => billsTable.id, {
      onDelete: "set null",
    }),
    /**
     * Flaw #1 (Option A) — the journal entry this accepted transaction posted.
     *
     * Acceptance is what turns a bank line into an accounting fact, so it is
     * where the JE is created. Kept as a link (not just an audit trail) because
     * editing a posted row must REVERSE the old entry and post a new one, and
     * that needs the original. NULL for pending rows, transfers, settlements
     * (the pay path already posted those) and pre-Option-A history.
     */
    journalEntryId: integer("journal_entry_id").references(() => journalEntriesTable.id, {
      onDelete: "set null",
    }),
    notes: text("notes"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("transactions_org_date_idx").on(t.organizationId, t.date),
    index("transactions_org_account_idx").on(t.organizationId, t.bankAccountId),
  ],
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
