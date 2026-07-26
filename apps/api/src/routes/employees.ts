import { Router } from "express";
import { db } from "@workspace/db";
import { employeesTable } from "@workspace/db";
import { eq, ilike, and } from "drizzle-orm";

const router = Router();
function toNum(v: unknown) { return v != null ? Number(v) : 0; }

const toOut = (e: typeof employeesTable.$inferSelect) => ({
  ...e,
  basicSalary: toNum(e.basicSalary),
  housingAllowance: toNum(e.housingAllowance),
  transportAllowance: toNum(e.transportAllowance),
  otherAllowances: toNum(e.otherAllowances),
  grossSalary: toNum(e.basicSalary) + toNum(e.housingAllowance) + toNum(e.transportAllowance) + toNum(e.otherAllowances),
  // GOSI: Saudi nationals 9.75% employee / 11.75% employer; Expats 0%/2%
  gosiEmployee: e.nationality === "SA" ? toNum(e.basicSalary) * 0.0975 : 0,
  gosiEmployer: e.nationality === "SA" ? toNum(e.basicSalary) * 0.1175 : toNum(e.basicSalary) * 0.02,
});

router.get("/", async (req, res) => {
  try {
    const { search, status, department } = req.query as Record<string, string>;
    const conditions = [];
    if (search) conditions.push(ilike(employeesTable.name, `%${search}%`));
    if (status) conditions.push(eq(employeesTable.status, status));
    if (department) conditions.push(eq(employeesTable.department, department));
    const rows = await db.select().from(employeesTable)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(employeesTable.name);
    res.json(rows.map(toOut));
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
});

router.get("/:id", async (req, res) => {
  try {
    const [row] = await db.select().from(employeesTable).where(eq(employeesTable.id, Number(req.params.id))).limit(1);
    if (!row) { res.status(404).json({ error: "Not found" }); return; }
    res.json(toOut(row));
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
});

router.post("/", async (req, res) => {
  try {
    const body = { ...req.body, basicSalary: String(req.body.basicSalary), housingAllowance: String(req.body.housingAllowance ?? 0), transportAllowance: String(req.body.transportAllowance ?? 0), otherAllowances: String(req.body.otherAllowances ?? 0) };
    const [row] = await db.insert(employeesTable).values(body).returning();
    res.status(201).json(toOut(row));
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
});

router.patch("/:id", async (req, res) => {
  try {
    const updates = { ...req.body };
    if (updates.basicSalary != null) updates.basicSalary = String(updates.basicSalary);
    if (updates.housingAllowance != null) updates.housingAllowance = String(updates.housingAllowance);
    if (updates.transportAllowance != null) updates.transportAllowance = String(updates.transportAllowance);
    const [row] = await db.update(employeesTable).set(updates).where(eq(employeesTable.id, Number(req.params.id))).returning();
    if (!row) { res.status(404).json({ error: "Not found" }); return; }
    res.json(toOut(row));
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
});

router.delete("/:id", async (req, res) => {
  try {
    await db.delete(employeesTable).where(eq(employeesTable.id, Number(req.params.id)));
    res.status(204).send();
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
});

export default router;
