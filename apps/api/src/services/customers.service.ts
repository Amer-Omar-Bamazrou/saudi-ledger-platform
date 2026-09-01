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
type CustomerInsert = typeof customersTable.$inferInsert;

const toView = (c: Customer) => ({
  ...c,
  creditLimit: c.creditLimit != null ? Number(c.creditLimit) : null,
});

/**
 * 🔴 The write boundary (contract batch 2). Two things the contract made
 * visible:
 *  1. `create`/`update` returned the RAW row while `list`/`getById` returned
 *     `toView` — so `creditLimit` was a number on two paths and a string on the
 *     other two. One presentation now, on every path.
 *  2. The UI sent `creditLimit: ""` for "no limit"; `Number("")` is 0, so the
 *     guard passed and "" was stored, which every read then presented as a
 *     limit of 0.00. The generated body schema now refuses "" (number|null),
 *     and nullable text fields sent as "" are stored as NULL rather than as an
 *     empty string that reads as a value.
 */
function normalize(values: Partial<CustomerInsert>): Partial<CustomerInsert> {
  const out: Record<string, unknown> = { ...values };
  for (const key of CUSTOMER_FIELDS) {
    if (out[key] === "") {
      if (key === "nameAr") delete out[key]; // NOT NULL with a default — let the default apply
      else out[key] = null;
    }
  }
  if (out.creditLimit != null) {
    out.creditLimit = String(assertAmount(out.creditLimit, "creditLimit", { min: 0, allowZero: true }));
  }
  return out as Partial<CustomerInsert>;
}

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
  async create(data: unknown) {
    const values = normalize(pick<CustomerInsert>(data, CUSTOMER_FIELDS));
    const [row] = await customersRepository.insert(values as CustomerInsert);
    await auditService.created("customer", row.id, row);
    return toView(row);
  },

  async update(id: number, data: unknown) {
    const [before] = await customersRepository.findById(id);
    if (!before) throw new NotFoundError("Not found");
    const values = normalize(pick<CustomerInsert>(data, CUSTOMER_FIELDS));
    const [row] = await customersRepository.update(id, values);
    await auditService.updated("customer", id, before, row);
    return toView(row);
  },

  async remove(id: number) {
    const [before] = await customersRepository.findById(id);
    await customersRepository.remove(id);
    if (before) await auditService.deleted("customer", id, before);
  },
};
