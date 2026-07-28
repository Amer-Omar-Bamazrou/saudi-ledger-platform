/**
 * Customers service — business logic (AR summary) + view assembly.
 * Behavior preserved exactly from the pre-M6 route handler.
 */
import { NotFoundError } from "../lib/errors";
import { auditService } from "./audit.service";
import { customersRepository, type CustomerListFilter } from "../repositories/customers.repository";
import type { customersTable } from "@workspace/db";

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

    const invoices = await customersRepository.invoicesByCustomer(id);
    const totalBilled = invoices.reduce((s, i) => s + Number(i.total), 0);
    const totalPaid = invoices.reduce((s, i) => s + Number(i.paidAmount ?? 0), 0);

    return {
      ...toView(customer),
      totalBilled,
      totalPaid,
      balance: totalBilled - totalPaid,
      invoiceCount: invoices.length,
    };
  },

  // POST/PATCH preserve the pre-M6 behavior of returning the raw row (no view mapping).
  async create(data: typeof customersTable.$inferInsert) {
    const [row] = await customersRepository.insert(data);
    await auditService.created("customer", row.id, row);
    return row;
  },

  async update(id: number, data: Partial<typeof customersTable.$inferInsert>) {
    const [before] = await customersRepository.findById(id);
    if (!before) throw new NotFoundError("Not found");
    const [row] = await customersRepository.update(id, data);
    await auditService.updated("customer", id, before, row);
    return row;
  },

  async remove(id: number) {
    const [before] = await customersRepository.findById(id);
    await customersRepository.remove(id);
    if (before) await auditService.deleted("customer", id, before);
  },
};
