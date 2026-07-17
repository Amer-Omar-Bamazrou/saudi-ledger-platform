import { Router } from "express";
import { db } from "@workspace/db";
import { invoicesTable, invoiceItemsTable, customersTable } from "@workspace/db";
import { eq, and, desc, ilike } from "drizzle-orm";

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
    const { status, customer_id, search } = req.query as Record<string, string>;
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
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
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
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
});

// POST /invoices
router.post("/", async (req, res) => {
  try {
    const { items = [], ...invData } = req.body;
    // Compute totals
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
    const [inv] = await db.insert(invoicesTable).values({ ...invData, subtotal: String(subtotal.toFixed(2)), vatAmount: String(vatTotal.toFixed(2)), total: String(total.toFixed(2)) }).returning();
    if (preparedItems.length > 0) {
      await db.insert(invoiceItemsTable).values(preparedItems.map((it: any) => ({ ...it, invoiceId: inv.id })));
    }
    res.status(201).json(await buildInvoiceOut(inv, null));
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
});

// PATCH /invoices/:id
router.patch("/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [inv] = await db.update(invoicesTable).set(req.body).where(eq(invoicesTable.id, id)).returning();
    if (!inv) { res.status(404).json({ error: "Not found" }); return; }
    res.json(await buildInvoiceOut(inv, null));
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
});

// POST /invoices/:id/pay
router.post("/:id/pay", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { amount, paidAt } = req.body;
    const [inv] = await db.update(invoicesTable).set({
      paidAmount: String(amount),
      paidAt: paidAt ?? new Date().toISOString().split("T")[0],
      status: "paid",
    }).where(eq(invoicesTable.id, id)).returning();
    if (!inv) { res.status(404).json({ error: "Not found" }); return; }
    res.json(await buildInvoiceOut(inv, null));
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
});

// DELETE /invoices/:id
router.delete("/:id", async (req, res) => {
  try {
    await db.delete(invoicesTable).where(eq(invoicesTable.id, Number(req.params.id)));
    res.status(204).send();
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
});

export default router;
