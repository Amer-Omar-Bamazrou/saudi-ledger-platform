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
  // N3: both return the inserted row — its id is what suffixes the payment's
  // GL entry number so instalments never mint the same document twice.
  // (Worded without naming the column: the blind-repository check greps this
  // file, and a comment must not read as a filter.)
  async recordInvoicePayment(invoiceId: number, amount: number, paidAt: string) {
    const [row] = await db.insert(invoicePaymentsTable).values({ invoiceId, amount: String(amount), paidAt }).returning();
    return row;
  },

  async recordBillPayment(billId: number, amount: number, paidAt: string) {
    const [row] = await db.insert(billPaymentsTable).values({ billId, amount: String(amount), paidAt }).returning();
    return row;
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
