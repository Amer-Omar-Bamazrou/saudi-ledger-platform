import { Router } from "express";
import { db } from "@workspace/db";
import { customersTable, invoicesTable } from "@workspace/db";
import { eq, ilike, and, sql, desc } from "drizzle-orm";

const router = Router();

// GET /customers
router.get("/", async (req, res) => {
  try {
    const { search, is_active } = req.query as Record<string, string>;
    const conditions = [];
    if (search) conditions.push(ilike(customersTable.name, `%${search}%`));
    if (is_active !== undefined) conditions.push(eq(customersTable.isActive, is_active === "true"));
    const rows = await db.select().from(customersTable)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(customersTable.name);
    res.json(rows.map(c => ({
      ...c,
      creditLimit: c.creditLimit != null ? Number(c.creditLimit) : null,
    })));
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
});

// GET /customers/:id
router.get("/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [customer] = await db.select().from(customersTable).where(eq(customersTable.id, id)).limit(1);
    if (!customer) { res.status(404).json({ error: "Customer not found" }); return; }

    // Compute AR summary
    const invoices = await db.select().from(invoicesTable).where(eq(invoicesTable.customerId, id));
    const totalBilled = invoices.reduce((s, i) => s + Number(i.total), 0);
    const totalPaid = invoices.reduce((s, i) => s + Number(i.paidAmount ?? 0), 0);

    res.json({ ...customer, creditLimit: customer.creditLimit != null ? Number(customer.creditLimit) : null, totalBilled, totalPaid, balance: totalBilled - totalPaid, invoiceCount: invoices.length });
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
});

// POST /customers
router.post("/", async (req, res) => {
  try {
    const [row] = await db.insert(customersTable).values(req.body).returning();
    res.status(201).json(row);
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
});

// PATCH /customers/:id
router.patch("/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [row] = await db.update(customersTable).set(req.body).where(eq(customersTable.id, id)).returning();
    if (!row) { res.status(404).json({ error: "Not found" }); return; }
    res.json(row);
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
});

// DELETE /customers/:id
router.delete("/:id", async (req, res) => {
  try {
    await db.delete(customersTable).where(eq(customersTable.id, Number(req.params.id)));
    res.status(204).send();
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
});

export default router;
