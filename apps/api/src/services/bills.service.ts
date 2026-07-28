/**
 * Bills service — AP bills, the single GL posting path (with totals reconciliation
 * + ZATCA VAT-number validation and force override), payment, and edit/delete
 * guards. GL posting + period locks delegated UNCHANGED to services/accounting.
 * Behavior — including the structured 400 error bodies and force-post warnings —
 * preserved exactly from the pre-M6 route.
 */
import { BusinessRuleError, ConflictError, NotFoundError } from "../lib/errors";
import { postJournalEntry } from "./accounting/glPosting";
import { checkPeriodOpen } from "./accounting/periodLock";
import { billsRepository, type BillListFilter } from "../repositories/bills.repository";
import type { billsTable, billItemsTable, vendorsTable } from "@workspace/db";

type Bill = typeof billsTable.$inferSelect;
type BillItem = typeof billItemsTable.$inferSelect;
type Vendor = typeof vendorsTable.$inferSelect;
const toNum = (v: unknown) => (v != null ? Number(v) : 0);

// Validation constants (mirror receiptValidator.ts on the frontend).
const RECONCILE_TOLERANCE = 0.02;
const ZATCA_VAT_RE = /^3\d{13}3$/;

function buildBillOut(bill: Bill, vendor?: Vendor | null, items?: BillItem[]) {
  return {
    id: bill.id,
    billNumber: bill.billNumber,
    vendorReference: bill.vendorReference,
    date: bill.date,
    dueDate: bill.dueDate,
    vendorId: bill.vendorId,
    vendorName: vendor?.name ?? null,
    status: bill.status,
    subtotal: toNum(bill.subtotal),
    vatAmount: toNum(bill.vatAmount),
    total: toNum(bill.total),
    currency: bill.currency,
    paidAmount: toNum(bill.paidAmount),
    paidAt: bill.paidAt,
    notes: bill.notes,
    createdAt: bill.createdAt.toISOString(),
    items:
      items?.map((it) => ({
        id: it.id,
        billId: it.billId,
        productId: it.productId,
        description: it.description,
        descriptionAr: it.descriptionAr,
        quantity: toNum(it.quantity),
        unitPrice: toNum(it.unitPrice),
        vatRate: toNum(it.vatRate),
        vatAmount: toNum(it.vatAmount),
        total: toNum(it.total),
      })) ?? [],
  };
}

export const billsService = {
  async list(filter: BillListFilter) {
    const rows = await billsRepository.list(filter);
    return rows.map((r) => buildBillOut(r.bill, r.vendor));
  },

  async getById(id: number) {
    const [row] = await billsRepository.findWithVendor(id);
    if (!row) throw new NotFoundError("Not found");
    const items = await billsRepository.itemsByBill(id);
    return buildBillOut(row.bill, row.vendor, items);
  },

  async create(body: Record<string, any>, userId: number | null) {
    const { items = [], ...billData } = body;
    let subtotal = 0;
    let vatTotal = 0;
    const preparedItems = items.map((it: any) => {
      const base = Number(it.quantity) * Number(it.unitPrice);
      const vat = base * (Number(it.vatRate ?? 15) / 100);
      subtotal += base;
      vatTotal += vat;
      return {
        ...it,
        quantity: String(it.quantity),
        unitPrice: String(it.unitPrice),
        vatAmount: String(vat.toFixed(2)),
        total: String((base + vat).toFixed(2)),
      };
    });

    // If no line items, trust the submitted subtotal/vatAmount/total values.
    const finalSubtotal = items.length > 0 ? subtotal : Number(billData.subtotal ?? 0);
    const finalVatAmount = items.length > 0 ? vatTotal : Number(billData.vatAmount ?? 0);
    const finalTotal = items.length > 0 ? subtotal + vatTotal : Number(billData.total ?? 0);

    await checkPeriodOpen(billData.date ?? new Date().toISOString().split("T")[0]);
    const [bill] = await billsRepository.insert({
      ...billData,
      subtotal: String(finalSubtotal.toFixed(2)),
      vatAmount: String(finalVatAmount.toFixed(2)),
      total: String(finalTotal.toFixed(2)),
      status: billData.status ?? "draft",
      createdBy: userId ?? null,
    } as Parameters<typeof billsRepository.insert>[0]);

    if (preparedItems.length > 0) {
      await billsRepository.insertItems(preparedItems.map((it: any) => ({ ...it, billId: bill.id })));
    }

    return buildBillOut(bill, null);
  },

  async post(id: number, body: { debitAccount?: unknown; force?: boolean }, userId: number | null) {
    const { debitAccount, force = false } = body;

    const [row] = await billsRepository.findWithVendor(id);
    if (!row) throw new NotFoundError("Bill not found");
    if (row.bill.status === "paid") throw new ConflictError("Bill is already paid — cannot re-post.");

    const subtotal = toNum(row.bill.subtotal);
    const vatAmount = toNum(row.bill.vatAmount);
    const total = toNum(row.bill.total);

    if (total <= 0) {
      throw new BusinessRuleError(400, { error: "Bill total must be greater than zero to post.", code: "ZERO_TOTAL" });
    }

    // ── totals reconciliation ──
    const computed = Math.round((subtotal + vatAmount) * 100) / 100;
    const diff = Math.abs(computed - total);
    let effectiveTotal = total;
    if (diff > RECONCILE_TOLERANCE) {
      if (!force) {
        throw new BusinessRuleError(400, {
          error: `Totals don't reconcile: ${subtotal} + ${vatAmount} = ${computed} but total is ${total} (difference: ${diff.toFixed(2)} SAR). Correct the amounts or pass force:true to override.`,
          code: "TOTALS_MISMATCH",
          detail: { subtotal, vatAmount, computedTotal: computed, storedTotal: total, diff },
        });
      }
      effectiveTotal = computed;
      console.warn(
        `[FORCE-POST] bill ${id} (${row.bill.billNumber}) posted with TOTALS_MISMATCH ` +
          `diff=${diff.toFixed(2)} SAR; using computed total ${computed} for GL — ` +
          `userId=${userId ?? "unknown"} at ${new Date().toISOString()}`,
      );
    }

    // ── vendor ZATCA VAT number format ──
    const vendorVat = row.vendor?.taxNumber?.trim() ?? "";
    if (vendorVat && !ZATCA_VAT_RE.test(vendorVat)) {
      if (!force) {
        throw new BusinessRuleError(400, {
          error: `Vendor VAT number "${vendorVat}" is not in ZATCA format (15 digits, first and last digit '3'). Correct the vendor record or pass force:true to override.`,
          code: "INVALID_VAT_NUMBER",
          detail: { vendorId: row.vendor?.id, vendorVat },
        });
      }
      console.warn(
        `[FORCE-POST] bill ${id} (${row.bill.billNumber}) posted with INVALID_VAT_NUMBER ` +
          `vatNumber=${vendorVat} — userId=${userId ?? "unknown"} at ${new Date().toISOString()}`,
      );
    }

    // ── GL: Dr Purchases/Input VAT / Cr Accounts Payable ──
    const expenseAccount =
      typeof debitAccount === "string" && debitAccount.trim() ? debitAccount.trim() : "Purchases and Cost of Sales";

    await postJournalEntry({
      entryNumber: `BILL-${row.bill.billNumber}`,
      date: row.bill.date,
      description: `Vendor bill ${row.bill.billNumber}${row.vendor?.name ? ` – ${row.vendor.name}` : ""}`,
      reference: row.bill.billNumber ?? undefined,
      lines: [
        { accountName: expenseAccount, description: `Bill ${row.bill.billNumber}`, debitAmount: subtotal, creditAmount: 0 },
        { accountName: "Input VAT Receivable", description: `VAT on ${row.bill.billNumber}`, debitAmount: vatAmount, creditAmount: 0 },
        { accountName: "Accounts Payable", description: `Bill ${row.bill.billNumber}`, debitAmount: 0, creditAmount: effectiveTotal },
      ],
    });

    const [updated] = await billsRepository.update(id, { status: "received" });
    return buildBillOut(updated, row.vendor);
  },

  async update(id: number, data: Record<string, unknown>) {
    const [existing] = await billsRepository.findById(id);
    if (!existing) throw new NotFoundError("Not found");
    if (existing.status !== "draft") throw new ConflictError("Only draft bills can be edited.");
    const [bill] = await billsRepository.update(id, data);
    return buildBillOut(bill, null);
  },

  async pay(id: number, body: { amount: unknown; paidAt?: string }) {
    const { amount, paidAt } = body;
    const payDate = paidAt ?? new Date().toISOString().split("T")[0];

    const [bill] = await billsRepository.update(id, {
      paidAmount: String(amount),
      paidAt: payDate,
      status: "paid",
    });
    if (!bill) throw new NotFoundError("Not found");

    // ── GL: Dr Accounts Payable / Cr Cash and Bank ──
    const paid = Number(amount);
    if (paid > 0) {
      await postJournalEntry({
        entryNumber: `BILL-${bill.billNumber}-PAY`,
        date: payDate,
        description: `Payment to vendor for bill ${bill.billNumber}`,
        reference: bill.billNumber ?? undefined,
        lines: [
          { accountName: "Accounts Payable", description: `Payment for ${bill.billNumber}`, debitAmount: paid, creditAmount: 0 },
          { accountName: "Cash and Bank", description: `Payment for ${bill.billNumber}`, debitAmount: 0, creditAmount: paid },
        ],
      });
    }

    return buildBillOut(bill, null);
  },

  async remove(id: number) {
    const [existing] = await billsRepository.findById(id);
    if (!existing) throw new NotFoundError("Not found");
    if (existing.status !== "draft") throw new ConflictError("Only draft bills can be deleted.");
    await billsRepository.remove(id);
  },
};
