import { Router } from "express";
import { db } from "@workspace/db";
import { vendorsTable, billsTable } from "@workspace/db";
import { eq, ilike, and } from "drizzle-orm";

const router = Router();

router.get("/", async (req, res) => {
  try {
    const { search, is_active } = req.query as Record<string, string>;
    const conditions = [];
    if (search) conditions.push(ilike(vendorsTable.name, `%${search}%`));
    if (is_active !== undefined) conditions.push(eq(vendorsTable.isActive, is_active === "true"));
    const rows = await db.select().from(vendorsTable)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(vendorsTable.name);
    res.json(rows);
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
});

router.get("/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [vendor] = await db.select().from(vendorsTable).where(eq(vendorsTable.id, id)).limit(1);
    if (!vendor) { res.status(404).json({ error: "Vendor not found" }); return; }
    const bills = await db.select().from(billsTable).where(eq(billsTable.vendorId, id));
    const totalBilled = bills.reduce((s, b) => s + Number(b.total), 0);
    const totalPaid = bills.reduce((s, b) => s + Number(b.paidAmount ?? 0), 0);
    res.json({ ...vendor, totalBilled, totalPaid, balance: totalBilled - totalPaid, billCount: bills.length });
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
});

router.post("/", async (req, res) => {
  try {
    const [row] = await db.insert(vendorsTable).values(req.body).returning();
    res.status(201).json(row);
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
});

router.patch("/:id", async (req, res) => {
  try {
    const [row] = await db.update(vendorsTable).set(req.body).where(eq(vendorsTable.id, Number(req.params.id))).returning();
    if (!row) { res.status(404).json({ error: "Not found" }); return; }
    res.json(row);
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
});

router.delete("/:id", async (req, res) => {
  try {
    await db.delete(vendorsTable).where(eq(vendorsTable.id, Number(req.params.id)));
    res.status(204).send();
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
});

export default router;
