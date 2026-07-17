import { Router } from "express";
import { db } from "@workspace/db";
import { billsTable, billItemsTable, vendorsTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";

const router = Router();
function toNum(v: unknown) { return v != null ? Number(v) : 0; }

async function buildBillOut(bill: typeof billsTable.$inferSelect, vendor?: typeof vendorsTable.$inferSelect | null, items?: typeof billItemsTable.$inferSelect[]) {
  return {
    id: bill.id, billNumber: bill.billNumber, vendorReference: bill.vendorReference,
    date: bill.date, dueDate: bill.dueDate, vendorId: bill.vendorId, vendorName: vendor?.name ?? null,
    status: bill.status, subtotal: toNum(bill.subtotal), vatAmount: toNum(bill.vatAmount),
    total: toNum(bill.total), currency: bill.currency, paidAmount: toNum(bill.paidAmount),
    paidAt: bill.paidAt, notes: bill.notes, createdAt: bill.createdAt.toISOString(),
    items: items?.map(it => ({ id: it.id, billId: it.billId, productId: it.productId, description: it.description, descriptionAr: it.descriptionAr, quantity: toNum(it.quantity), unitPrice: toNum(it.unitPrice), vatRate: toNum(it.vatRate), vatAmount: toNum(it.vatAmount), total: toNum(it.total) })) ?? [],
  };
}

router.get("/", async (req, res) => {
  try {
    const { status, vendor_id } = req.query as Record<string, string>;
    const conditions = [];
    if (status) conditions.push(eq(billsTable.status, status));
    if (vendor_id) conditions.push(eq(billsTable.vendorId, Number(vendor_id)));
    const rows = await db.select({ bill: billsTable, vendor: vendorsTable }).from(billsTable)
      .leftJoin(vendorsTable, eq(billsTable.vendorId, vendorsTable.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(billsTable.date), desc(billsTable.id));
    res.json(await Promise.all(rows.map(r => buildBillOut(r.bill, r.vendor))));
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
});

router.get("/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [row] = await db.select({ bill: billsTable, vendor: vendorsTable }).from(billsTable)
      .leftJoin(vendorsTable, eq(billsTable.vendorId, vendorsTable.id))
      .where(eq(billsTable.id, id)).limit(1);
    if (!row) { res.status(404).json({ error: "Not found" }); return; }
    const items = await db.select().from(billItemsTable).where(eq(billItemsTable.billId, id));
    res.json(await buildBillOut(row.bill, row.vendor, items));
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
});

router.post("/", async (req, res) => {
  try {
    const { items = [], ...billData } = req.body;
    let subtotal = 0, vatTotal = 0;
    const preparedItems = items.map((it: any) => {
      const base = Number(it.quantity) * Number(it.unitPrice);
      const vat = base * (Number(it.vatRate ?? 15) / 100);
      subtotal += base; vatTotal += vat;
      return { ...it, quantity: String(it.quantity), unitPrice: String(it.unitPrice), vatAmount: String(vat.toFixed(2)), total: String((base + vat).toFixed(2)) };
    });
    const [bill] = await db.insert(billsTable).values({ ...billData, subtotal: String(subtotal.toFixed(2)), vatAmount: String(vatTotal.toFixed(2)), total: String((subtotal + vatTotal).toFixed(2)) }).returning();
    if (preparedItems.length > 0) await db.insert(billItemsTable).values(preparedItems.map((it: any) => ({ ...it, billId: bill.id })));
    res.status(201).json(await buildBillOut(bill, null));
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
});

router.patch("/:id", async (req, res) => {
  try {
    const [bill] = await db.update(billsTable).set(req.body).where(eq(billsTable.id, Number(req.params.id))).returning();
    if (!bill) { res.status(404).json({ error: "Not found" }); return; }
    res.json(await buildBillOut(bill, null));
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
});

router.post("/:id/pay", async (req, res) => {
  try {
    const { amount, paidAt } = req.body;
    const [bill] = await db.update(billsTable).set({ paidAmount: String(amount), paidAt: paidAt ?? new Date().toISOString().split("T")[0], status: "paid" }).where(eq(billsTable.id, Number(req.params.id))).returning();
    if (!bill) { res.status(404).json({ error: "Not found" }); return; }
    res.json(await buildBillOut(bill, null));
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
});

router.delete("/:id", async (req, res) => {
  try {
    await db.delete(billsTable).where(eq(billsTable.id, Number(req.params.id)));
    res.status(204).send();
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
});

export default router;
