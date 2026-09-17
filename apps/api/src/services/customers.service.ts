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

/**
 * Phase E: the position a customer row carries. `balance` is the NET position
 * (receivable − credit − deposit), kept under its old name; the three
 * non-negative components ride beside it so no reader has to infer a
 * liability from a minus sign. A customer with nothing in the books is all
 * zeros — an absence that looks like an absence.
 */
function positionOf(bal: Awaited<ReturnType<typeof customersRepository.customerBalances>>[number] | undefined) {
  const receivable = bal?.receivable ?? 0;
  const creditBalance = bal?.creditBalance ?? 0;
  const depositBalance = bal?.depositBalance ?? 0;
  const netPosition = bal?.netPosition ?? 0;
  return { totalBilled: bal?.totalBilled ?? 0, totalPaid: bal?.totalPaid ?? 0, receivable, creditBalance, depositBalance, netPosition, balance: netPosition };
}
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
    // "" → NULL for every nullable text field, nameAr now included: the
    // sentinel default died (2026-09-14), so absence is stored as absence.
    if (out[key] === "") out[key] = null;
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
    const items = rows.map((c) => ({ ...toView(c), ...positionOf(byCustomer.get(c.id)) }));
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

    return {
      ...toView(customer),
      ...positionOf(bal),
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
