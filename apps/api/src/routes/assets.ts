import { Router } from "express";
import { db } from "@workspace/db";
import { fixedAssetsTable, depreciationEntriesTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";

const router = Router();
function toNum(v: unknown) { return v != null ? Number(v) : 0; }

const toOut = (a: typeof fixedAssetsTable.$inferSelect) => ({
  ...a,
  purchaseCost: toNum(a.purchaseCost),
  salvageValue: toNum(a.salvageValue),
  usefulLifeYears: toNum(a.usefulLifeYears),
  accumulatedDepreciation: toNum(a.accumulatedDepreciation),
  currentBookValue: toNum(a.currentBookValue),
  disposalValue: a.disposalValue != null ? toNum(a.disposalValue) : null,
  annualDepreciation: (toNum(a.purchaseCost) - toNum(a.salvageValue)) / toNum(a.usefulLifeYears),
  monthlyDepreciation: (toNum(a.purchaseCost) - toNum(a.salvageValue)) / (toNum(a.usefulLifeYears) * 12),
});

router.get("/", async (req, res) => {
  try {
    const rows = await db.select().from(fixedAssetsTable).orderBy(fixedAssetsTable.purchaseDate);
    res.json(rows.map(toOut));
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
});

router.get("/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [asset] = await db.select().from(fixedAssetsTable).where(eq(fixedAssetsTable.id, id)).limit(1);
    if (!asset) { res.status(404).json({ error: "Not found" }); return; }
    const entries = await db.select().from(depreciationEntriesTable).where(eq(depreciationEntriesTable.assetId, id)).orderBy(depreciationEntriesTable.period);
    res.json({ ...toOut(asset), depreciationHistory: entries.map(e => ({ ...e, amount: toNum(e.amount), bookValueAfter: toNum(e.bookValueAfter) })) });
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
});

router.post("/", async (req, res) => {
  try {
    const body = { ...req.body, purchaseCost: String(req.body.purchaseCost), salvageValue: String(req.body.salvageValue ?? 0), usefulLifeYears: String(req.body.usefulLifeYears), currentBookValue: String(req.body.purchaseCost), accumulatedDepreciation: "0" };
    const [row] = await db.insert(fixedAssetsTable).values(body).returning();
    res.status(201).json(toOut(row));
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
});

router.patch("/:id", async (req, res) => {
  try {
    const updates = { ...req.body };
    if (updates.purchaseCost != null) updates.purchaseCost = String(updates.purchaseCost);
    if (updates.currentBookValue != null) updates.currentBookValue = String(updates.currentBookValue);
    const [row] = await db.update(fixedAssetsTable).set(updates).where(eq(fixedAssetsTable.id, Number(req.params.id))).returning();
    if (!row) { res.status(404).json({ error: "Not found" }); return; }
    res.json(toOut(row));
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
});

// POST /assets/:id/depreciate — run one month of depreciation
router.post("/:id/depreciate", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { period } = req.body; // YYYY-MM
    const [asset] = await db.select().from(fixedAssetsTable).where(eq(fixedAssetsTable.id, id)).limit(1);
    if (!asset) { res.status(404).json({ error: "Not found" }); return; }
    if (asset.status !== "active") { res.status(400).json({ error: "Asset is not active" }); return; }

    const bookValue = toNum(asset.currentBookValue);
    const salvage = toNum(asset.salvageValue);
    const monthlyAmount = (toNum(asset.purchaseCost) - salvage) / (toNum(asset.usefulLifeYears) * 12);
    const amount = Math.min(monthlyAmount, Math.max(0, bookValue - salvage));
    if (amount <= 0) { res.status(400).json({ error: "Asset fully depreciated" }); return; }

    const newBookValue = bookValue - amount;
    const newAccumulated = toNum(asset.accumulatedDepreciation) + amount;

    await db.update(fixedAssetsTable).set({
      currentBookValue: String(newBookValue.toFixed(2)),
      accumulatedDepreciation: String(newAccumulated.toFixed(2)),
      status: newBookValue <= salvage ? "fully-depreciated" : "active",
    }).where(eq(fixedAssetsTable.id, id));

    const [entry] = await db.insert(depreciationEntriesTable).values({
      assetId: id, period, amount: String(amount.toFixed(2)), bookValueAfter: String(newBookValue.toFixed(2)),
    }).returning();

    res.json({ ...entry, amount: toNum(entry.amount), bookValueAfter: toNum(entry.bookValueAfter) });
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
});

router.delete("/:id", async (req, res) => {
  try {
    await db.delete(fixedAssetsTable).where(eq(fixedAssetsTable.id, Number(req.params.id)));
    res.status(204).send();
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
});

export default router;
