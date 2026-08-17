/**
 * B4 — the dated payment record (invoice_payments / bill_payments).
 *
 * Written ONLY by the pay paths (`invoicesService.pay` / `billsService.pay`),
 * in the same tenant transaction as the running-total update — a record
 * beside the posting, never a second posting path. Append-only at the DB
 * grants (no UPDATE/DELETE for the app role).
 *
 * 🔴 `backfilled` rows are AGGREGATES of pre-B4 payments (the split and
 * earlier dates were never recorded). Consumers that would be wrong on
 * aggregates — DSO, collection-speed, instalment analytics — must filter
 * `backfilled = false`.
 */
import { db, invoicePaymentsTable, billPaymentsTable } from "@workspace/db";
import { desc, eq } from "drizzle-orm";

export const paymentsRepository = {
  async recordInvoicePayment(invoiceId: number, amount: number, paidAt: string) {
    await db.insert(invoicePaymentsTable).values({ invoiceId, amount: String(amount), paidAt });
  },

  async recordBillPayment(billId: number, amount: number, paidAt: string) {
    await db.insert(billPaymentsTable).values({ billId, amount: String(amount), paidAt });
  },

  async listForInvoice(invoiceId: number) {
    return db
      .select()
      .from(invoicePaymentsTable)
      .where(eq(invoicePaymentsTable.invoiceId, invoiceId))
      .orderBy(desc(invoicePaymentsTable.paidAt), desc(invoicePaymentsTable.id));
  },

  async listForBill(billId: number) {
    return db
      .select()
      .from(billPaymentsTable)
      .where(eq(billPaymentsTable.billId, billId))
      .orderBy(desc(billPaymentsTable.paidAt), desc(billPaymentsTable.id));
  },
};
