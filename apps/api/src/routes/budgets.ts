import { Router } from "express";
import { db } from "@workspace/db";
import { budgetsTable, categoriesTable, transactionsTable } from "@workspace/db";
import { eq, and, gte, lte, sql } from "drizzle-orm";

const router = Router();
function toNum(v: unknown) { return v != null ? Number(v) : 0; }

router.get("/", async (req, res) => {
  try {
    const { period } = req.query as Record<string, string>;
    const rows = await db.select({ budget: budgetsTable, cat: categoriesTable })
      .from(budgetsTable)
      .leftJoin(categoriesTable, eq(budgetsTable.categoryId, categoriesTable.id))
      .where(period ? eq(budgetsTable.period, period) : undefined)
      .orderBy(categoriesTable.type, categoriesTable.name);

    // For each budget, compute actual spend from transactions
    const budgets = await Promise.all(rows.map(async ({ budget, cat }) => {
      const periodStart = `${budget.period}-01`;
      const periodEnd = `${budget.period}-12-31`;
      let actualAmount = 0;
      if (budget.categoryId) {
        const txs = await db.select({ amount: sql<string>`sum(amount)` })
          .from(transactionsTable)
          .where(and(eq(transactionsTable.categoryId, budget.categoryId), gte(transactionsTable.date, periodStart), lte(transactionsTable.date, periodEnd)));
        actualAmount = Number(txs[0]?.amount ?? 0);
      }
      const budgeted = toNum(budget.budgetedAmount);
      return {
        ...budget, budgetedAmount: budgeted, actualAmount,
        variance: budgeted - actualAmount,
        variancePct: budgeted > 0 ? ((budgeted - actualAmount) / budgeted) * 100 : 0,
        categoryName: cat?.name ?? null, categoryNameAr: cat?.nameAr ?? null, categoryType: cat?.type ?? null,
      };
    }));
    res.json(budgets);
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
});

router.post("/", async (req, res) => {
  try {
    const body = { ...req.body, budgetedAmount: String(req.body.budgetedAmount) };
    const [row] = await db.insert(budgetsTable).values(body).returning();
    res.status(201).json({ ...row, budgetedAmount: toNum(row.budgetedAmount) });
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
});

router.patch("/:id", async (req, res) => {
  try {
    const updates = { ...req.body };
    if (updates.budgetedAmount != null) updates.budgetedAmount = String(updates.budgetedAmount);
    const [row] = await db.update(budgetsTable).set(updates).where(eq(budgetsTable.id, Number(req.params.id))).returning();
    if (!row) { res.status(404).json({ error: "Not found" }); return; }
    res.json({ ...row, budgetedAmount: toNum(row.budgetedAmount) });
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
});

router.delete("/:id", async (req, res) => {
  try {
    await db.delete(budgetsTable).where(eq(budgetsTable.id, Number(req.params.id)));
    res.status(204).send();
  } catch (err) { req.log.error({ err }); res.status(500).json({ error: "Internal server error" }); }
});

export default router;
