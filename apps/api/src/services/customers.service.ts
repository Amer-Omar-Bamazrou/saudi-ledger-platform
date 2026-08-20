/**
 * Customers service — business logic (AR summary) + view assembly.
 * Behavior preserved exactly from the pre-M6 route handler.
 */
import { NotFoundError } from "../lib/errors";
import { pick, assertAmount } from "../lib/writeGuards";
import { documentSign } from "../repositories/reports.repository";
import { auditService } from "./audit.service";
import { customersRepository, type CustomerListFilter } from "../repositories/customers.repository";
import type { customersTable } from "@workspace/db";

/** H1 allowlist — user-settable customer fields (system columns excluded). */
const CUSTOMER_FIELDS = [
  "name", "nameAr", "taxNumber", "crNumber", "nationalId", "phone", "email",
  "address", "city", "country", "buildingNumber", "street", "district",
  "postalCode", "additionalNumber", "province", "currency", "creditLimit",
  "paymentTermsDays", "notes", "isActive",
] as const;

type Customer = typeof customersTable.$inferSelect;

const toView = (c: Customer) => ({
  ...c,
  creditLimit: c.creditLimit != null ? Number(c.creditLimit) : null,
});

export const customersService = {
  async list(filter: CustomerListFilter) {
    const rows = await customersRepository.list(filter);
    return rows.map(toView);
  },

  async getById(id: number) {
    const [customer] = await customersRepository.findById(id);
    if (!customer) throw new NotFoundError("Customer not found");

    /**
     * Only ISSUED documents count toward a customer's balance.
     *
     * Two fixes here (M12.1b):
     *  1. This query had NO status filter at all, so DRAFT and SUBMITTED
     *     invoices were inflating every customer balance — a gap left by M10,
     *     which added `approvedInvoicesOnly()` to the reports but not to this
     *     path.
     *  2. Credit notes reduce the balance; debit notes add to it. Amounts are
     *     stored positive, so the sign is applied explicitly (see
     *     `documentSign`).
     */
    const invoices = await customersRepository.issuedInvoicesByCustomer(id);
    const totalBilled = invoices.reduce((s, i) => s + documentSign(i.documentType) * Number(i.total), 0);
    const totalPaid = invoices.reduce(
      (s, i) => s + documentSign(i.documentType) * Number(i.paidAmount ?? 0),
      0,
    );

    return {
      ...toView(customer),
      totalBilled,
      totalPaid,
      balance: totalBilled - totalPaid,
      invoiceCount: invoices.length,
    };
  },

  // 🔴 H1 — ALLOWLIST (audit 2026-08-20). RLS blocks setting a foreign
  // organization_id, but the raw spread still let a client set `id`/timestamps
  // and any future sensitive column. `creditLimit` is validated ≥ 0.
  async create(data: typeof customersTable.$inferInsert) {
    const values = pick<typeof customersTable.$inferInsert>(data, CUSTOMER_FIELDS);
    if (values.creditLimit != null) assertAmount(values.creditLimit, "creditLimit", { min: 0, allowZero: true });
    const [row] = await customersRepository.insert(values as typeof customersTable.$inferInsert);
    await auditService.created("customer", row.id, row);
    return row;
  },

  async update(id: number, data: Partial<typeof customersTable.$inferInsert>) {
    const [before] = await customersRepository.findById(id);
    if (!before) throw new NotFoundError("Not found");
    const values = pick<typeof customersTable.$inferInsert>(data, CUSTOMER_FIELDS);
    if (values.creditLimit != null) assertAmount(values.creditLimit, "creditLimit", { min: 0, allowZero: true });
    const [row] = await customersRepository.update(id, values);
    await auditService.updated("customer", id, before, row);
    return row;
  },

  async remove(id: number) {
    const [before] = await customersRepository.findById(id);
    await customersRepository.remove(id);
    if (before) await auditService.deleted("customer", id, before);
  },
};
