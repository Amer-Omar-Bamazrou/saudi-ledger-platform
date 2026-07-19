import { Router } from "express";
import { db } from "@workspace/db";
import { invoicesTable, invoiceItemsTable, customersTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { postJournalEntry } from "../lib/glPosting";
import { generateZatcaQr, computeInvoiceHash, getPreviousInvoiceHash } from "../lib/zatca";
import { checkPeriodOpen } from "../lib/periodLock";
import { handleRouteError } from "../lib/routeError";

const router = Router();

function toNum(v: unknown) { return v != null ? Number(v) : 0; }

async function buildInvoiceOut(inv: typeof invoicesTable.$inferSelect, customer?: typeof customersTable.$inferSelect | null, items?: typeof invoiceItemsTable.$inferSelect[]) {
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
    items: items?.map(it => ({
      id: it.id, invoiceId: it.invoiceId, productId: it.productId,
      description: it.description, descriptionAr: it.descriptionAr,
      quantity: toNum(it.quantity), unitPrice: toNum(it.unitPrice),
      vatRate: toNum(it.vatRate), vatAmount: toNum(it.vatAmount),
      discount: toNum(it.discount), total: toNum(it.total),
    })) ?? [],
    createdAt: inv.createdAt.toISOString(),
  };
}

// GET /invoices
router.get("/", async (req, res) => {
  try {
    const { status, customer_id } = req.query as Record<string, string>;
    const conditions = [];
    if (status) conditions.push(eq(invoicesTable.status, status));
    if (customer_id) conditions.push(eq(invoicesTable.customerId, Number(customer_id)));

    const rows = await db
      .select({ inv: invoicesTable, cust: customersTable })
      .from(invoicesTable)
      .leftJoin(customersTable, eq(invoicesTable.customerId, customersTable.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(invoicesTable.date), desc(invoicesTable.id));

    res.json(await Promise.all(rows.map(r => buildInvoiceOut(r.inv, r.cust))));
  } catch (err) { handleRouteError(err, req, res); }
});

// GET /invoices/:id
router.get("/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [row] = await db.select({ inv: invoicesTable, cust: customersTable }).from(invoicesTable)
      .leftJoin(customersTable, eq(invoicesTable.customerId, customersTable.id))
      .where(eq(invoicesTable.id, id)).limit(1);
    if (!row) { res.status(404).json({ error: "Not found" }); return; }
    const items = await db.select().from(invoiceItemsTable).where(eq(invoiceItemsTable.invoiceId, id));
    res.json(await buildInvoiceOut(row.inv, row.cust, items));
  } catch (err) { handleRouteError(err, req, res); }
});

// POST /invoices — creates invoice and immediately posts AR journal entry
router.post("/", async (req, res) => {
  try {
    const { items = [], ...invData } = req.body;
    // Compute totals from line items
    let subtotal = 0, vatTotal = 0;
    const preparedItems = items.map((it: any) => {
      const lineTotal = Number(it.quantity) * Number(it.unitPrice);
      const disc = Number(it.discount ?? 0);
      const base = lineTotal - disc;
      const vat = base * (Number(it.vatRate ?? 15) / 100);
      subtotal += base;
      vatTotal += vat;
      return { ...it, quantity: String(it.quantity), unitPrice: String(it.unitPrice), vatAmount: String(vat.toFixed(2)), total: String((base + vat).toFixed(2)) };
    });
    const total = subtotal + vatTotal - Number(invData.discount ?? 0);

    // Period lock check
    await checkPeriodOpen(invData.date ?? new Date().toISOString().split("T")[0]);

    // ── ZATCA: hash chain + QR code ──
    const previousHash = await getPreviousInvoiceHash(db, invoicesTable);
    const sellerVatNumber = invData.sellerVatNumber ?? "300000000000003"; // default if not provided
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

    const [inv] = await db.insert(invoicesTable).values({
      ...invData,
      subtotal: String(subtotal.toFixed(2)),
      vatAmount: String(vatTotal.toFixed(2)),
      total: String(total.toFixed(2)),
      createdBy: req.session?.userId ?? null,
      invoiceHash,
      previousHash,
      qrCode,
      sellerName,
      sellerVatNumber,
    }).returning();

    if (preparedItems.length > 0) {
      await db.insert(invoiceItemsTable).values(preparedItems.map((it: any) => ({ ...it, invoiceId: inv.id })));
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
          { accountName: "Sales Revenue",        description: `Invoice ${inv.invoiceNumber}`, debitAmount: 0,     creditAmount: subtotal },
          { accountName: "VAT Payable",           description: `VAT on invoice ${inv.invoiceNumber}`, debitAmount: 0, creditAmount: vatTotal },
        ],
      });
    }

    const out = await buildInvoiceOut(inv, null);
    res.status(201).json({ ...out, qrCode: inv.qrCode, invoiceHash: inv.invoiceHash, previousHash: inv.previousHash });
  } catch (err) { handleRouteError(err, req, res); }
});

// PATCH /invoices/:id — only allowed while status is draft
router.patch("/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [existing] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, id)).limit(1);
    if (!existing) { res.status(404).json({ error: "Not found" }); return; }
    if (existing.status !== "draft") {
      res.status(409).json({ error: "Only draft invoices can be edited. Use a credit note to correct a posted invoice." });
      return;
    }
    const [inv] = await db.update(invoicesTable).set(req.body).where(eq(invoicesTable.id, id)).returning();
    res.json(await buildInvoiceOut(inv, null));
  } catch (err) { handleRouteError(err, req, res); }
});

// POST /invoices/:id/pay — records payment and posts cash receipt entry
router.post("/:id/pay", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { amount, paidAt } = req.body;
    const payDate = paidAt ?? new Date().toISOString().split("T")[0];

    const [inv] = await db.update(invoicesTable).set({
      paidAmount: String(amount),
      paidAt: payDate,
      status: "paid",
    }).where(eq(invoicesTable.id, id)).returning();
    if (!inv) { res.status(404).json({ error: "Not found" }); return; }

    // ── GL: Dr Cash and Bank / Cr Accounts Receivable ──
    const paid = Number(amount);
    if (paid > 0) {
      await postJournalEntry({
        entryNumber: `GL-${inv.invoiceNumber}-PAY`,
        date: payDate,
        description: `Payment received for invoice ${inv.invoiceNumber}`,
        reference: inv.invoiceNumber,
        lines: [
          { accountName: "Cash and Bank",         description: `Receipt for ${inv.invoiceNumber}`, debitAmount: paid, creditAmount: 0 },
          { accountName: "Accounts Receivable",   description: `Receipt for ${inv.invoiceNumber}`, debitAmount: 0,   creditAmount: paid },
        ],
      });
    }

    res.json(await buildInvoiceOut(inv, null));
  } catch (err) { handleRouteError(err, req, res); }
});

// DELETE /invoices/:id — only draft invoices
router.delete("/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [existing] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, id)).limit(1);
    if (!existing) { res.status(404).json({ error: "Not found" }); return; }
    if (existing.status !== "draft") {
      res.status(409).json({ error: "Only draft invoices can be deleted. Posted invoices must be reversed." });
      return;
    }
    await db.delete(invoicesTable).where(eq(invoicesTable.id, id));
    res.status(204).send();
  } catch (err) { handleRouteError(err, req, res); }
});

export default router;
