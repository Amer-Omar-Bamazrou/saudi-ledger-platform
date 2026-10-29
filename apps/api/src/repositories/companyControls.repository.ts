/**
 * Company controls repository (Phase 18 H-9; register §11.56) — the control
 * settings row, and the two reads DR-23's change-then-pay finding is built
 * from: the suppliers' IBAN changes (the audit trail's vendor update records)
 * and the payments to those suppliers in this company.
 *
 * Tenant-scoped via RLS; every company-scoped table is also read through
 * {@link companyScoped}, so a request with no company reads nothing.
 */
import {
  db,
  auditLogsTable,
  billPaymentsTable,
  billsTable,
  companyControlSettingsTable,
  supplierPaymentsTable,
  vendorsTable,
} from "@workspace/db";
import { and, asc, eq, gte, inArray, sql } from "drizzle-orm";
import { companyScoped } from "./companyScope";

export type PaymentToSupplier = {
  kind: "bill_payment" | "supplier_payment";
  paymentId: number;
  billId: number | null;
  vendorId: number;
  vendorName: string;
  amount: string;
  paidAt: string;
};

export const companyControlsRepository = {
  /** The company's settings row; undefined until the first change (every slot empty). */
  async get() {
    const [row] = await db
      .select()
      .from(companyControlSettingsTable)
      .where(companyScoped(companyControlSettingsTable.companyId))
      .limit(1);
    return row;
  },

  /** One row per company: the first change inserts it, every later one updates it. */
  async upsert(values: { bankChangePaymentWindowDays: number | null; updatedBy: number | null }) {
    const [row] = await db
      .insert(companyControlSettingsTable)
      .values(values)
      .onConflictDoUpdate({ target: companyControlSettingsTable.companyId, set: { ...values, updatedAt: sql`now()` } })
      .returning();
    return row;
  },

  /** Every vendor update record whose before and after IBAN differ, oldest first. */
  vendorIbanChanges() {
    return db
      .select({ entityId: auditLogsTable.entityId, createdAt: auditLogsTable.createdAt })
      .from(auditLogsTable)
      .where(
        and(
          eq(auditLogsTable.entityType, "vendor"),
          eq(auditLogsTable.action, "update"),
          sql`${auditLogsTable.beforeState}->>'iban' IS DISTINCT FROM ${auditLogsTable.afterState}->>'iban'`,
        ),
      )
      .orderBy(asc(auditLogsTable.createdAt), asc(auditLogsTable.id));
  },

  /** This company's bill payments and supplier payments to the given suppliers, dated on or after `from`. */
  async paymentsToVendors(vendorIds: number[], from: string): Promise<PaymentToSupplier[]> {
    if (vendorIds.length === 0) return [];
    const billPayments = await db
      .select({
        paymentId: billPaymentsTable.id,
        billId: billPaymentsTable.billId,
        vendorId: billsTable.vendorId,
        vendorName: vendorsTable.name,
        amount: billPaymentsTable.amount,
        paidAt: billPaymentsTable.paidAt,
      })
      .from(billPaymentsTable)
      .innerJoin(billsTable, eq(billsTable.id, billPaymentsTable.billId))
      .innerJoin(vendorsTable, eq(vendorsTable.id, billsTable.vendorId))
      .where(
        and(
          companyScoped(billPaymentsTable.companyId),
          inArray(billsTable.vendorId, vendorIds),
          gte(billPaymentsTable.paidAt, from),
        ),
      );
    const supplierPayments = await db
      .select({
        paymentId: supplierPaymentsTable.id,
        vendorId: supplierPaymentsTable.vendorId,
        vendorName: vendorsTable.name,
        amount: supplierPaymentsTable.amount,
        paidAt: supplierPaymentsTable.paidAt,
      })
      .from(supplierPaymentsTable)
      .innerJoin(vendorsTable, eq(vendorsTable.id, supplierPaymentsTable.vendorId))
      .where(
        and(
          companyScoped(supplierPaymentsTable.companyId),
          inArray(supplierPaymentsTable.vendorId, vendorIds),
          gte(supplierPaymentsTable.paidAt, from),
        ),
      );
    return [
      ...billPayments.map((p) => ({ kind: "bill_payment" as const, ...p, vendorId: p.vendorId as number })),
      ...supplierPayments.map((p) => ({ kind: "supplier_payment" as const, billId: null, ...p })),
    ];
  },
};
