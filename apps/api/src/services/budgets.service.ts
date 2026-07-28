/** Budgets service — budget-vs-actual computation. Behavior preserved from pre-M6. */
import { NotFoundError } from "../lib/errors";
import { budgetsRepository } from "../repositories/budgets.repository";
import type { budgetsTable } from "@workspace/db";

const toNum = (v: unknown) => (v != null ? Number(v) : 0);

export const budgetsService = {
  async list(period?: string) {
    const rows = await budgetsRepository.listWithCategory(period);
    return Promise.all(
      rows.map(async ({ budget, cat }) => {
        const periodStart = `${budget.period}-01`;
        const periodEnd = `${budget.period}-12-31`;
        let actualAmount = 0;
        if (budget.categoryId) {
          const txs = await budgetsRepository.sumTransactions(budget.categoryId, periodStart, periodEnd);
          actualAmount = Number(txs[0]?.amount ?? 0);
        }
        const budgeted = toNum(budget.budgetedAmount);
        return {
          ...budget,
          budgetedAmount: budgeted,
          actualAmount,
          variance: budgeted - actualAmount,
          variancePct: budgeted > 0 ? ((budgeted - actualAmount) / budgeted) * 100 : 0,
          categoryName: cat?.name ?? null,
          categoryNameAr: cat?.nameAr ?? null,
          categoryType: cat?.type ?? null,
        };
      }),
    );
  },

  async create(data: Record<string, unknown>) {
    const values = { ...data, budgetedAmount: String(data.budgetedAmount) } as typeof budgetsTable.$inferInsert;
    const [row] = await budgetsRepository.insert(values);
    return { ...row, budgetedAmount: toNum(row.budgetedAmount) };
  },

  async update(id: number, data: Record<string, unknown>) {
    const updates = { ...data } as Record<string, unknown>;
    if (updates.budgetedAmount != null) updates.budgetedAmount = String(updates.budgetedAmount);
    const [row] = await budgetsRepository.update(id, updates as Partial<typeof budgetsTable.$inferInsert>);
    if (!row) throw new NotFoundError("Not found");
    return { ...row, budgetedAmount: toNum(row.budgetedAmount) };
  },

  async remove(id: number) {
    await budgetsRepository.remove(id);
  },
};
