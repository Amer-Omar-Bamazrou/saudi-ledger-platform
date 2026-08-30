/**
 * Customers service — business logic (AR summary) + view assembly.
 * Behavior preserved exactly from the pre-M6 route handler.
 */
import { NotFoundError } from "../lib/errors";
import { pick, assertAmount } from "../lib/writeGuards";
import { auditService } from "./audit.service";
import { customersRepository, type CustomerListFilter } from "../repositories/customers.repository";
import { DEFAULT_PAGE } from "../lib/httpParams";
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
  /**
   * 🔴 The list carries each customer's AR, because the page shows it.
   *
   * It did not, and the page summed `c.balance ?? 0` over a field that was
   * never in the response — so "Total AR" and "Total Billed" read 0.00 for
   * every tenant, forever, looking exactly like a true answer. Two queries,
   * not N+1: the balances come back grouped and are matched in memory.
   */
  async list(filter: CustomerListFilter) {
    const [rows, balances, total, totals] = await Promise.all([
      customersRepository.list(filter),
      customersRepository.customerBalances(),
      customersRepository.listCount(filter),
      customersRepository.listTotals(filter),
    ]);
    const byCustomer = new Map(balances.map((b) => [b.customerId, b]));
    const items = rows.map((c) => {
      const bal = byCustomer.get(c.id);
      const totalBilled = Number(bal?.totalBilled ?? 0);
      const totalPaid = Number(bal?.totalPaid ?? 0);
      return { ...toView(c), totalBilled, totalPaid, balance: totalBilled - totalPaid };
    });
    return {
      items,
      page: { limit: filter.limit ?? DEFAULT_PAGE, offset: filter.offset ?? 0, total },
      totals,
    };
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
     *
     * 🔴 Both rules now live in `customerBalances`, in SQL, so this page and the
     * list cannot answer the same question differently. The rules did not
     * change; where they are stated did.
     */
    const [bal] = await customersRepository.customerBalances(id);
    const totalBilled = Number(bal?.totalBilled ?? 0);
    const totalPaid = Number(bal?.totalPaid ?? 0);

    return {
      ...toView(customer),
      totalBilled,
      totalPaid,
      balance: totalBilled - totalPaid,
      invoiceCount: Number(bal?.invoiceCount ?? 0),
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
