import { Router } from "express";
import { db } from "@workspace/db";
import { productsTable } from "@workspace/db";
import { eq, ilike, and } from "drizzle-orm";

const router = Router();

const toOut = (p: typeof productsTable.$inferSelect) => ({
  ...p,
  unitPrice: Number(p.unitPrice),
  unitCost: p.unitCost != null ? Number(p.unitCost) : null,
  stockQty: p.stockQty != null ? Number(p.stockQty) : 0,
  reorderPoint: p.reorderPoint != null ? Number(p.reorderPoint) : null,
});

router.get("/", async (req, res) => {
  try {
    const { search, type, is_active } = req.query as Record<string, string>;
    const conditions = [];
    if (search) conditions.push(ilike(productsTable.name, `%${search}%`));
    if (type) conditions.push(eq(productsTable.type, type));
    if (is_active !== undefined) conditions.push(eq(productsTable.isActive, is_active === "true"));
    const rows = await db.select().from(productsTable)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(productsTable.name);
    res.json(rows.map(toOut));
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
});

router.get("/:id", async (req, res) => {
  try {
    const [row] = await db.select().from(productsTable).where(eq(productsTable.id, Number(req.params.id))).limit(1);
    if (!row) { res.status(404).json({ error: "Not found" }); return; }
    res.json(toOut(row));
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
});

router.post("/", async (req, res) => {
  try {
    const body = { ...req.body, unitPrice: String(req.body.unitPrice ?? 0), unitCost: req.body.unitCost != null ? String(req.body.unitCost) : null };
    const [row] = await db.insert(productsTable).values(body).returning();
    res.status(201).json(toOut(row));
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
});

router.patch("/:id", async (req, res) => {
  try {
    const updates = { ...req.body };
    if (updates.unitPrice != null) updates.unitPrice = String(updates.unitPrice);
    if (updates.unitCost != null) updates.unitCost = String(updates.unitCost);
    const [row] = await db.update(productsTable).set(updates).where(eq(productsTable.id, Number(req.params.id))).returning();
    if (!row) { res.status(404).json({ error: "Not found" }); return; }
    res.json(toOut(row));
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
});

router.delete("/:id", async (req, res) => {
  try {
    await db.delete(productsTable).where(eq(productsTable.id, Number(req.params.id)));
    res.status(204).send();
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
});

export default router;
