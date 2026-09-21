/**
 * AP-2 (2026-09-21) — the ADVANCE TAX INVOICE (type 386) and the FINAL
 * invoice's PREPAYMENT ADJUSTMENT: every Drizzle read and write, tenant-
 * scoped by RLS and company-scoped in the query layer (N1) where a figure
 * crosses documents.
 *
 * The figures this file computes, and their ONE definition each:
 *
 *   invoiced(receipt)   Σ total of ISSUED 386s whose `advance_payment_id` is
 *                       the receipt — the part of the deposit whose VAT has
 *                       been declared (a draft 386 declares nothing).
 *   adjusted(386)       Σ `invoice_prepayments.amount` of rows FINALISED at a
 *                       final invoice's approval (`allocation_id IS NOT NULL`)
 *                       — a draft 388's selection reserves nothing.
 *   open(386)           total − adjusted: what a later final invoice may
 *                       still adjust.
 *   uninvoiced(receipt) unapplied − Σ open(386s of the receipt): the part of
 *                       the deposit a D-4 allocation or a refund may still
 *                       touch without leaving a 386's VAT declared against
 *                       cash that has gone (pack §14; G-Z-3 fail-closed).
 */
import { db, invoicesTable, invoicePrepaymentsTable, paymentsTable } from "@workspace/db";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { INVOICE_IN_BOOKS_STATUSES, ADVANCE_INVOICE_TYPE } from "@workspace/shared";
import { invoiceNotReversed, paymentNotReversed } from "./openingReversal";

const ISSUED = [...INVOICE_IN_BOOKS_STATUSES];

// 🔴 The correlated subqueries below name the outer row as `${invoicesTable}."id"`,
// never `${invoicesTable.id}`: inside a SELECT list drizzle renders a column
// reference UNQUALIFIED ("id"), which a subquery over another table resolves to
// ITS OWN id — a silent wrong join that read every adjustment as 0.00 (found by
// the AP-2 suite's movement assertion, 2026-09-21).

export type AdvanceFigures = { invoiced: number; invoicedVat: number; adjusted: number; adjustedVat: number; open: number; openVat: number };

export const advanceInvoicesRepository = {
  /** Every 386 (any status) created from one receipt, oldest first, with what issued final invoices have adjusted from each. */
  async advanceInvoicesOfPayment(paymentId: number) {
    const rows = await db
      .select({
        inv: invoicesTable,
        adjusted: sql<string>`coalesce((SELECT sum(p.amount) FROM invoice_prepayments p WHERE p.advance_invoice_id = ${invoicesTable}."id" AND p.allocation_id IS NOT NULL), 0)`,
        vatCategory: sql<string | null>`(SELECT it.tax_category_code FROM invoice_items it WHERE it.invoice_id = ${invoicesTable}."id" ORDER BY it.id LIMIT 1)`,
      })
      .from(invoicesTable)
      // Policy C: a 386 is never an opening item and its receipt is never an opening deposit (refused at create); the predicate is consumed so the reader is provably in the sweep.
      .where(and(eq(invoicesTable.documentType, ADVANCE_INVOICE_TYPE), eq(invoicesTable.advancePaymentId, paymentId), invoiceNotReversed()))
      .orderBy(invoicesTable.id);
    return rows.map((r) => ({ inv: r.inv, adjusted: Number(r.adjusted), vatCategory: r.vatCategory ?? null }));
  },

  /** The advance figures of each receipt (issued 386s only) — one grouped query, never N+1. */
  async figuresForPayments(paymentIds: number[]): Promise<Map<number, AdvanceFigures>> {
    if (paymentIds.length === 0) return new Map();
    const rows = await db
      .select({
        paymentId: invoicesTable.advancePaymentId,
        invoiced: sql<string>`coalesce(sum(${invoicesTable.total}::numeric), 0)`,
        invoicedVat: sql<string>`coalesce(sum(${invoicesTable.vatAmount}::numeric), 0)`,
        adjusted: sql<string>`coalesce(sum((SELECT coalesce(sum(p.amount), 0) FROM invoice_prepayments p WHERE p.advance_invoice_id = ${invoicesTable}."id" AND p.allocation_id IS NOT NULL)), 0)`,
        adjustedVat: sql<string>`coalesce(sum((SELECT coalesce(sum(p.tax_amount), 0) FROM invoice_prepayments p WHERE p.advance_invoice_id = ${invoicesTable}."id" AND p.allocation_id IS NOT NULL)), 0)`,
      })
      .from(invoicesTable)
      .where(and(eq(invoicesTable.documentType, ADVANCE_INVOICE_TYPE), inArray(invoicesTable.advancePaymentId, paymentIds), inArray(invoicesTable.status, ISSUED), invoiceNotReversed()))
      .groupBy(invoicesTable.advancePaymentId);
    const out = new Map<number, AdvanceFigures>();
    for (const r of rows) {
      const invoiced = Number(r.invoiced), invoicedVat = Number(r.invoicedVat), adjusted = Number(r.adjusted), adjustedVat = Number(r.adjustedVat);
      out.set(r.paymentId as number, { invoiced, invoicedVat, adjusted, adjustedVat, open: Math.round((invoiced - adjusted) * 100) / 100, openVat: Math.round((invoicedVat - adjustedVat) * 100) / 100 });
    }
    return out;
  },

  /** Σ adjusted (finalised rows) per 386 id. */
  async adjustedTotals(advanceInvoiceIds: number[]): Promise<Map<number, number>> {
    if (advanceInvoiceIds.length === 0) return new Map();
    const rows = await db
      .select({ advanceInvoiceId: invoicePrepaymentsTable.advanceInvoiceId, total: sql<string>`sum(${invoicePrepaymentsTable.amount})` })
      .from(invoicePrepaymentsTable)
      .where(and(inArray(invoicePrepaymentsTable.advanceInvoiceId, advanceInvoiceIds), isNotNull(invoicePrepaymentsTable.allocationId)))
      .groupBy(invoicePrepaymentsTable.advanceInvoiceId);
    return new Map(rows.map((r) => [r.advanceInvoiceId, Number(r.total)]));
  },

  /**
   * A customer's ISSUED advance invoices with an open (not yet adjusted)
   * balance — the picker on the final invoice. Company-scoped in the query
   * layer: a 386 adjusted on another company's invoice would fork two
   * companies' VAT (N1).
   */
  async openForCustomer(customerId: number) {
    const rows = await db
      .select({
        inv: invoicesTable,
        payment: paymentsTable,
        adjusted: sql<string>`coalesce((SELECT sum(p.amount) FROM invoice_prepayments p WHERE p.advance_invoice_id = ${invoicesTable}."id" AND p.allocation_id IS NOT NULL), 0)`,
      })
      .from(invoicesTable)
      .innerJoin(paymentsTable, eq(paymentsTable.id, invoicesTable.advancePaymentId))
      .where(
        and(
          eq(invoicesTable.documentType, ADVANCE_INVOICE_TYPE),
          eq(invoicesTable.customerId, customerId),
          inArray(invoicesTable.status, ISSUED),
          invoiceNotReversed(),
          paymentNotReversed(),
          sql`${invoicesTable.companyId}::text = current_setting('app.current_company_id', true)`,
        ),
      )
      .orderBy(invoicesTable.date, invoicesTable.id);
    return rows
      .map((r) => ({ inv: r.inv, payment: r.payment, adjusted: Number(r.adjusted), open: Math.round((Number(r.inv.total) - Number(r.adjusted)) * 100) / 100 }))
      .filter((r) => r.open > 0.005);
  },

  /** The prepayment rows of one final invoice with the 386 each one adjusts (number, dates, UUID — the XML's document reference). */
  prepaymentsOfInvoice(invoiceId: number) {
    return db
      .select({ row: invoicePrepaymentsTable, advance: invoicesTable })
      .from(invoicePrepaymentsTable)
      .innerJoin(invoicesTable, eq(invoicesTable.id, invoicePrepaymentsTable.advanceInvoiceId))
      .where(eq(invoicePrepaymentsTable.invoiceId, invoiceId))
      .orderBy(invoicePrepaymentsTable.id);
  },

  /** The prepayment rows of many final invoices at once, each with its 386 (the list page, the VAT return). */
  prepaymentsOfInvoices(invoiceIds: number[]) {
    if (invoiceIds.length === 0) return Promise.resolve([] as Array<{ row: typeof invoicePrepaymentsTable.$inferSelect; advance: typeof invoicesTable.$inferSelect }>);
    return db
      .select({ row: invoicePrepaymentsTable, advance: invoicesTable })
      .from(invoicePrepaymentsTable)
      .innerJoin(invoicesTable, eq(invoicesTable.id, invoicePrepaymentsTable.advanceInvoiceId))
      .where(inArray(invoicePrepaymentsTable.invoiceId, invoiceIds))
      .orderBy(invoicePrepaymentsTable.id);
  },

  insertPrepayments(values: (typeof invoicePrepaymentsTable.$inferInsert)[]) {
    if (values.length === 0) return Promise.resolve([] as (typeof invoicePrepaymentsTable.$inferSelect)[]);
    return db.insert(invoicePrepaymentsTable).values(values).returning();
  },

  /** A DRAFT's selection is replaced whole, like its lines. The trigger refuses this on an issued invoice. */
  deletePrepayments(invoiceId: number) {
    return db.delete(invoicePrepaymentsTable).where(eq(invoicePrepaymentsTable.invoiceId, invoiceId));
  },

  /** The approval's one permitted change: name the folded allocation, once. */
  async setAllocation(id: number, allocationId: number) {
    const [row] = await db.update(invoicePrepaymentsTable).set({ allocationId }).where(eq(invoicePrepaymentsTable.id, id)).returning();
    return row!;
  },

  /** The prepayment row that a folded allocation belongs to, if any — the unallocate guard's read. */
  findByAllocation(allocationId: number) {
    return db.select().from(invoicePrepaymentsTable).where(eq(invoicePrepaymentsTable.allocationId, allocationId)).limit(1);
  },
};
