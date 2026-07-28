/**
 * Invoices service — totals computation, ZATCA hash-chain + QR, and AR GL posting.
 * Tax/hash/GL logic is delegated UNCHANGED to services/accounting/{zatca,glPosting,
 * periodLock}; only the surrounding orchestration + data access moved here.
 * Behavior preserved exactly from the pre-M6 route.
 */
import { db, invoicesTable } from "@workspace/db";
import { ConflictError, NotFoundError } from "../lib/errors";
import { auditService } from "./audit.service";
import { postJournalEntry } from "./accounting/glPosting";
import { checkPeriodOpen } from "./accounting/periodLock";
import { generateZatcaQr, computeInvoiceHash, getPreviousInvoiceHash } from "./accounting/zatca";
import { invoicesRepository, type InvoiceListFilter } from "../repositories/invoices.repository";
import type { invoicesTable as InvoicesTable, invoiceItemsTable, customersTable } from "@workspace/db";

type Invoice = typeof InvoicesTable.$inferSelect;
type InvoiceItem = typeof invoiceItemsTable.$inferSelect;
type Customer = typeof customersTable.$inferSelect;
const toNum = (v: unknown) => (v != null ? Number(v) : 0);

function buildInvoiceOut(inv: Invoice, customer?: Customer | null, items?: InvoiceItem[]) {
  return {
    id: inv.id,
    invoiceNumber: inv.invoiceNumber,
    date: inv.date,
    dueDate: inv.dueDate,
    customerId: inv.customerId,
    customerName: customer?.name ?? null,
    status: inv.status,
    subtotal: toNum(inv.subtotal),
    vatAmount: toNum(inv.vatAmount),
    discount: toNum(inv.discount),
    total: toNum(inv.total),
    currency: inv.currency,
    paidAmount: toNum(inv.paidAmount),
    paidAt: inv.paidAt,
    notes: inv.notes,
    items:
      items?.map((it) => ({
        id: it.id,
        invoiceId: it.invoiceId,
        productId: it.productId,
        description: it.description,
        descriptionAr: it.descriptionAr,
        quantity: toNum(it.quantity),
        unitPrice: toNum(it.unitPrice),
        vatRate: toNum(it.vatRate),
        vatAmount: toNum(it.vatAmount),
        discount: toNum(it.discount),
        total: toNum(it.total),
      })) ?? [],
    createdAt: inv.createdAt.toISOString(),
  };
}

export const invoicesService = {
  async list(filter: InvoiceListFilter) {
    const rows = await invoicesRepository.list(filter);
    return rows.map((r) => buildInvoiceOut(r.inv, r.cust));
  },

  async getById(id: number) {
    const [row] = await invoicesRepository.findWithCustomer(id);
    if (!row) throw new NotFoundError("Not found");
    const items = await invoicesRepository.itemsByInvoice(id);
    return buildInvoiceOut(row.inv, row.cust, items);
  },

  async create(body: Record<string, any>, userId: number | null) {
    const { items = [], ...invData } = body;
    let subtotal = 0;
    let vatTotal = 0;
    const preparedItems = items.map((it: any) => {
      const lineTotal = Number(it.quantity) * Number(it.unitPrice);
      const disc = Number(it.discount ?? 0);
      const base = lineTotal - disc;
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
    const total = subtotal + vatTotal - Number(invData.discount ?? 0);

    await checkPeriodOpen(invData.date ?? new Date().toISOString().split("T")[0]);

    // ── ZATCA: hash chain + QR code ──
    const previousHash = await getPreviousInvoiceHash(db, invoicesTable);
    const sellerVatNumber = invData.sellerVatNumber ?? "300000000000003";
    const sellerName = invData.sellerName ?? "KSA Ledger Company";
    const invoiceDateTime = `${invData.date ?? new Date().toISOString().split("T")[0]}T00:00:00Z`;
    const invoiceHash = computeInvoiceHash({
      invoiceNumber: invData.invoiceNumber,
      date: invData.date,
      sellerVatNumber,
      total: total.toFixed(2),
      vatAmount: vatTotal.toFixed(2),
      previousHash,
    });
    const qrCode = generateZatcaQr({
      sellerName,
      vatNumber: sellerVatNumber,
      invoiceDateTime,
      totalWithVat: total.toFixed(2),
      vatAmount: vatTotal.toFixed(2),
    });

    const [inv] = await invoicesRepository.insert({
      ...invData,
      subtotal: String(subtotal.toFixed(2)),
      vatAmount: String(vatTotal.toFixed(2)),
      total: String(total.toFixed(2)),
      createdBy: userId ?? null,
      invoiceHash,
      previousHash,
      qrCode,
      sellerName,
      sellerVatNumber,
    } as Parameters<typeof invoicesRepository.insert>[0]);

    if (preparedItems.length > 0) {
      await invoicesRepository.insertItems(preparedItems.map((it: any) => ({ ...it, invoiceId: inv.id })));
    }

    // ── GL: Dr Accounts Receivable / Cr Sales Revenue + VAT Payable ──
    if (total > 0) {
      await postJournalEntry({
        entryNumber: `GL-${inv.invoiceNumber}`,
        date: inv.date,
        description: `Customer invoice ${inv.invoiceNumber}`,
        reference: inv.invoiceNumber,
        lines: [
          { accountName: "Accounts Receivable", description: `Invoice ${inv.invoiceNumber}`, debitAmount: total, creditAmount: 0 },
          { accountName: "Sales Revenue", description: `Invoice ${inv.invoiceNumber}`, debitAmount: 0, creditAmount: subtotal },
          { accountName: "VAT Payable", description: `VAT on invoice ${inv.invoiceNumber}`, debitAmount: 0, creditAmount: vatTotal },
        ],
      });
    }

    await auditService.created("invoice", inv.id, inv);
    const out = buildInvoiceOut(inv, null);
    return { ...out, qrCode: inv.qrCode, invoiceHash: inv.invoiceHash, previousHash: inv.previousHash };
  },

  async update(id: number, data: Record<string, unknown>) {
    const [existing] = await invoicesRepository.findById(id);
    if (!existing) throw new NotFoundError("Not found");
    if (existing.status !== "draft") {
      throw new ConflictError("Only draft invoices can be edited. Use a credit note to correct a posted invoice.");
    }
    const [inv] = await invoicesRepository.update(id, data);
    await auditService.updated("invoice", id, existing, inv);
    return buildInvoiceOut(inv, null);
  },

  async pay(id: number, body: { amount: unknown; paidAt?: string }) {
    const { amount, paidAt } = body;
    const payDate = paidAt ?? new Date().toISOString().split("T")[0];

    const [before] = await invoicesRepository.findById(id);
    const [inv] = await invoicesRepository.update(id, {
      paidAmount: String(amount),
      paidAt: payDate,
      status: "paid",
    });
    if (!inv) throw new NotFoundError("Not found");

    // ── GL: Dr Cash and Bank / Cr Accounts Receivable ──
    const paid = Number(amount);
    if (paid > 0) {
      await postJournalEntry({
        entryNumber: `GL-${inv.invoiceNumber}-PAY`,
        date: payDate,
        description: `Payment received for invoice ${inv.invoiceNumber}`,
        reference: inv.invoiceNumber,
        lines: [
          { accountName: "Cash and Bank", description: `Receipt for ${inv.invoiceNumber}`, debitAmount: paid, creditAmount: 0 },
          { accountName: "Accounts Receivable", description: `Receipt for ${inv.invoiceNumber}`, debitAmount: 0, creditAmount: paid },
        ],
      });
    }

    await auditService.updated("invoice", id, before ?? null, inv);
    return buildInvoiceOut(inv, null);
  },

  async remove(id: number) {
    const [existing] = await invoicesRepository.findById(id);
    if (!existing) throw new NotFoundError("Not found");
    if (existing.status !== "draft") {
      throw new ConflictError("Only draft invoices can be deleted. Posted invoices must be reversed.");
    }
    await invoicesRepository.remove(id);
    await auditService.deleted("invoice", id, existing);
  },
};
