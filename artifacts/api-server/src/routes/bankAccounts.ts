import { Router } from "express";
import { db } from "@workspace/db";
import { bankAccountsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const router = Router();
function toNum(v: unknown) { return v != null ? Number(v) : 0; }
const toOut = (b: typeof bankAccountsTable.$inferSelect) => ({ ...b, balance: toNum(b.balance), openingBalance: toNum(b.openingBalance) });

router.get("/", async (req, res) => {
  try {
    const rows = await db.select().from(bankAccountsTable).orderBy(bankAccountsTable.name);
    res.json(rows.map(toOut));
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
});

router.get("/:id", async (req, res) => {
  try {
    const [row] = await db.select().from(bankAccountsTable).where(eq(bankAccountsTable.id, Number(req.params.id))).limit(1);
    if (!row) { res.status(404).json({ error: "Not found" }); return; }
    res.json(toOut(row));
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
});

router.post("/", async (req, res) => {
  try {
    const body = { ...req.body, balance: String(req.body.balance ?? req.body.openingBalance ?? 0), openingBalance: String(req.body.openingBalance ?? 0) };
    const [row] = await db.insert(bankAccountsTable).values(body).returning();
    res.status(201).json(toOut(row));
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
});

router.patch("/:id", async (req, res) => {
  try {
    const updates = { ...req.body };
    if (updates.balance != null) updates.balance = String(updates.balance);
    const [row] = await db.update(bankAccountsTable).set(updates).where(eq(bankAccountsTable.id, Number(req.params.id))).returning();
    if (!row) { res.status(404).json({ error: "Not found" }); return; }
    res.json(toOut(row));
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
});

router.delete("/:id", async (req, res) => {
  try {
    await db.delete(bankAccountsTable).where(eq(bankAccountsTable.id, Number(req.params.id)));
    res.status(204).send();
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
});

export default router;
