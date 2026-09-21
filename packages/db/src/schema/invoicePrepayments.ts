/**
 * AP-2 (2026-09-21) — THE PREPAYMENT ADJUSTMENT: how much of an ADVANCE TAX
 * INVOICE (type 386) a FINAL invoice (type 388) adjusts, per pair.
 *
 * Decision record: docs/product/advance-payments-decision-pack.md §6 (E3,
 * accountant A2) and §14 (AP-2 as built). Authority for the shape: ZATCA
 * XML Implementation Standard v1.2 ¶9.5 and BR-KSA-73…82 — the final invoice
 * carries `PrepaidAmount` (BT-113) = Σ (KSA-31 + KSA-32) and, per VAT
 * category and rate, one adjustment line referencing the 386(s) by number,
 * issue date, issue time and type code 386.
 *
 * One row per (final invoice, advance invoice). `amount` is VAT-INCLUSIVE
 * (the part of the 386's total this invoice adjusts); `taxable_amount` and
 * `tax_amount` are its split at the 386's category and rate (KSA-31…34),
 * and `amount = taxable + tax` by CHECK. Written on the DRAFT when the user
 * selects the advance(s) — a draft reserves nothing and posts nothing — and
 * FINALISED at approval: `allocation_id` names the `payment_allocations`
 * row (receipt → this invoice, for `amount`) that the issue entry folds in,
 * so the receipt's unapplied remainder, the invoice's `paid_amount` and
 * this row agree from the first day.
 *
 * 🔴 IMMUTABLE ONCE ISSUED. A row whose invoice carries a hash is frozen by
 * trigger (`refuse_issued_prepayment_change`, migration 0083): the
 * adjustment is what the signed XML says, and the allocation it folded is
 * corrected by a credit note on the invoice, never unapplied (the Phase A
 * rule for a note's own settlement, applied here — `paymentsService.
 * unallocate` refuses it by code).
 */
import { pgTable, serial, integer, numeric, uuid, text, timestamp, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizationsTable } from "./organizations";
import { companiesTable } from "./companies";
import { invoicesTable } from "./invoices";
import { paymentAllocationsTable } from "./payments";

export const invoicePrepaymentsTable = pgTable(
  "invoice_prepayments",
  {
    id: serial("id").primaryKey(),
    organizationId: uuid("organization_id")
      .notNull()
      .default(sql`(nullif(current_setting('app.current_org_id', true), ''))::uuid`)
      .references(() => organizationsTable.id),
    companyId: uuid("company_id")
      .notNull()
      .default(sql`(nullif(current_setting('app.current_company_id', true), ''))::uuid`)
      .references(() => companiesTable.id),
    /** The FINAL invoice (388) carrying the adjustment. */
    invoiceId: integer("invoice_id")
      .notNull()
      .references(() => invoicesTable.id, { onDelete: "cascade" }),
    /** The ADVANCE tax invoice (386) being adjusted — an issued row of document_type advance_invoice. */
    advanceInvoiceId: integer("advance_invoice_id")
      .notNull()
      .references(() => invoicesTable.id, { onDelete: "restrict" }),
    /** VAT-inclusive part of the 386 adjusted here (Σ over a 386's rows ≤ its total, enforced under lock). */
    amount: numeric("amount", { precision: 15, scale: 2 }).notNull(),
    /** KSA-31 — the taxable part, at the 386's category and rate. */
    taxableAmount: numeric("taxable_amount", { precision: 15, scale: 2 }).notNull(),
    /** KSA-32 — the VAT part. */
    taxAmount: numeric("tax_amount", { precision: 15, scale: 2 }).notNull(),
    /** KSA-33 — S / Z / E, copied from the 386's line. */
    taxCategoryCode: text("tax_category_code").notNull(),
    /** KSA-34 — the 386's rate (may differ from today's, e.g. a pre-2020 5% advance). */
    vatRate: numeric("vat_rate", { precision: 5, scale: 2 }).notNull(),
    /** Set at the final invoice's approval: the folded receipt → invoice allocation. NULL on a draft. */
    allocationId: integer("allocation_id").references(() => paymentAllocationsTable.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("invoice_prepayments_pair_unq").on(t.invoiceId, t.advanceInvoiceId),
    index("invoice_prepayments_advance_idx").on(t.advanceInvoiceId),
    check("invoice_prepayments_amount_positive_chk", sql`amount > 0`),
    check("invoice_prepayments_split_chk", sql`amount = taxable_amount + tax_amount AND taxable_amount >= 0 AND tax_amount >= 0`),
    check("invoice_prepayments_category_chk", sql`tax_category_code IN ('S', 'Z', 'E')`),
    check("invoice_prepayments_not_self_chk", sql`invoice_id <> advance_invoice_id`),
  ],
);

export type InvoicePrepayment = typeof invoicePrepaymentsTable.$inferSelect;
