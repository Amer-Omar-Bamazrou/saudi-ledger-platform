/**
 * Quotations (M21.1) — an OFFER to a customer. Not a supply, not a document.
 *
 * ── The load-bearing property (design §Q-4) ─────────────────────────────────
 * A quotation touches NOTHING. No GL entry, no receivable, no output VAT, no
 * line on any statement or return, at any status, ever. It becomes real only
 * when it is CONVERTED, and conversion works by calling the existing
 * `invoicesService.create` — never by a second posting path.
 *
 * That property is cheap here for a structural reason worth stating: every
 * report and aggregate in the platform queries `invoices` / `bills` /
 * `transactions` / `journal_entries` BY TABLE. A new table is therefore
 * invisible to all of them by construction, rather than by a filter somebody
 * has to remember to add. (Contrast `kind: transfer`, which needed
 * `taxVisible()` threaded through every repository.)
 *
 * ── Two orthogonal axes (design §4) ─────────────────────────────────────────
 * `status` carries the APPROVAL axis ONLY — draft | submitted | approved, the
 * M10 engine's vocabulary, mapped by `quotations.approvable.ts`.
 *
 * The CONVERSION axis (open / partially_converted / converted) is **DERIVED
 * from the conversion rows and is deliberately NOT a column here.** A single
 * status string cannot express "approved AND partially converted", which is
 * the normal state of a partially-accepted quotation; collapsing the two axes
 * would produce a field asserting something the tenant never said (M20.0).
 *
 * `outcome` is the third thing, and it is neither axis: it records a terminal
 * act the TENANT performed — they declined it, or they closed the remainder.
 * NULL means the quotation is live, and NULL is a first-class state: the
 * platform never decides on the tenant's behalf that a remainder is dead
 * (the M17.1 / M20.0 posture, in a fourth place).
 */
import { pgTable, serial, text, timestamp, integer, numeric, uuid, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { customersTable } from "./customers";
import { productsTable } from "./products";
import { organizationsTable } from "./organizations";
import { companiesTable } from "./companies";

export const quotationsTable = pgTable(
  "quotations",
  {
    id: serial("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .default(sql`app_default_org_id()`)
      .references(() => organizationsTable.id),
    companyId: uuid("company_id")
      .notNull()
      .default(sql`app_default_company_id()`)
      .references(() => companiesTable.id),

    /**
     * `QUO-{YYYY}-{NNNN}`, allocated SERVER-side inside the creating
     * transaction and unique per company (the index below is the real
     * guarantee, not the allocator).
     *
     * 🔴 Deliberately NOT the pattern `invoices` uses. Invoice numbers are
     * minted in the BROWSER from a truncated millisecond clock with no unique
     * constraint anywhere — a live collision risk on a value that becomes the
     * ZATCA document's `cbc:ID`. That is queue item C12; copying it here would
     * have propagated the defect into a second document type.
     *
     * Equally deliberately NOT ZATCA machinery: no ICV, no hash chain, and no
     * borrowing of `lockCompanySequence` — that advisory lock exists for the
     * legally meaningful chain and must not acquire a second, unrelated
     * caller.
     */
    quotationNumber: text("quotation_number").notNull(),
    customerId: integer("customer_id").references(() => customersTable.id, { onDelete: "restrict" }),
    date: text("date").notNull(),
    /**
     * Expiry. NULL = no expiry was stated, a first-class state.
     *
     * DISPLAYED and warned on; it does NOT block conversion. A customer
     * accepting a lapsed quotation is a commercial decision, not an error the
     * software is entitled to refuse (design §8.8).
     */
    validUntil: text("valid_until"),

    /** APPROVAL axis only: draft | submitted | approved. See the header. */
    status: text("status").notNull().default("draft"),
    /**
     * Terminal act by the TENANT: `declined` (the customer said no) or
     * `closed` (the remainder is abandoned). NULL = live.
     *
     * Constrained by a DB CHECK — the write-boundary rule, because three
     * writers (create, update, the close/decline actions) could otherwise each
     * put a different vocabulary in here.
     */
    outcome: text("outcome"),

    subtotal: numeric("subtotal", { precision: 15, scale: 2 }).notNull().default("0"),
    vatAmount: numeric("vat_amount", { precision: 15, scale: 2 }).notNull().default("0"),
    discount: numeric("discount", { precision: 15, scale: 2 }).default("0"),
    total: numeric("total", { precision: 15, scale: 2 }).notNull().default("0"),
    currency: text("currency").default("SAR"),

    /** Correction note an approver leaves on send-back (the M10 pattern). */
    reviewNote: text("review_note"),
    notes: text("notes"),
    termsAndConditions: text("terms_and_conditions"),
    createdBy: integer("created_by"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("quotations_org_status_idx").on(t.organizationId, t.status),
    index("quotations_customer_idx").on(t.customerId),
    // The REAL uniqueness guarantee. The allocator reads max+1; this is what
    // makes a concurrent duplicate a failed insert rather than a silent clash.
    uniqueIndex("quotations_company_number_unq").on(t.companyId, t.quotationNumber),
  ],
);

export const quotationItemsTable = pgTable(
  "quotation_items",
  {
    id: serial("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .default(sql`app_default_org_id()`)
      .references(() => organizationsTable.id),
    companyId: uuid("company_id")
      .notNull()
      .default(sql`app_default_company_id()`)
      .references(() => companiesTable.id),
    quotationId: integer("quotation_id")
      .notNull()
      .references(() => quotationsTable.id, { onDelete: "cascade" }),
    productId: integer("product_id").references(() => productsTable.id, { onDelete: "set null" }),
    description: text("description").notNull(),
    descriptionAr: text("description_ar").notNull().default("(not yet translated)"),
    quantity: numeric("quantity", { precision: 15, scale: 3 }).notNull().default("1"),
    /**
     * 🔴 The QUOTED price, and the reason this column exists rather than a
     * lookup: conversion FREEZES it (design §8.3). An invoice built from this
     * quotation copies this value and never re-reads `products.unit_price` —
     * re-reading would silently honour a different price than the one the
     * customer agreed to.
     */
    unitPrice: numeric("unit_price", { precision: 15, scale: 2 }).notNull(),
    vatRate: numeric("vat_rate", { precision: 5, scale: 2 }).default("15"),
    vatAmount: numeric("vat_amount", { precision: 15, scale: 2 }).default("0"),
    discount: numeric("discount", { precision: 15, scale: 2 }).default("0"),
    total: numeric("total", { precision: 15, scale: 2 }).notNull().default("0"),

    /**
     * Stamped by the same rule invoices use (positive rate ⇒ 'S'; 0% left NULL
     * because zero-rated / exempt / out-of-scope are different tax facts an
     * amount cannot distinguish).
     *
     * 🔴 But a quotation NEVER fails closed on it. A quotation is not issued
     * to ZATCA, so the single tax gate stays where it already is — at invoice
     * creation. Carrying the code here means conversion has something to hand
     * over; it does not mean a second place can assert a tax position.
     */
    taxCategoryCode: text("tax_category_code"),
    /** UN/ECE Rec 20 unit of measure. 'PCE' (piece) is the safe default. */
    unitCode: text("unit_code").notNull().default("PCE"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("quotation_items_org_quotation_idx").on(t.organizationId, t.quotationId)],
);

export const insertQuotationSchema = createInsertSchema(quotationsTable).omit({ id: true, createdAt: true });
export const insertQuotationItemSchema = createInsertSchema(quotationItemsTable).omit({ id: true, createdAt: true });
export type InsertQuotation = z.infer<typeof insertQuotationSchema>;
export type Quotation = typeof quotationsTable.$inferSelect;
export type QuotationItem = typeof quotationItemsTable.$inferSelect;
