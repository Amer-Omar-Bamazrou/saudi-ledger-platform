/** Budgets service — budget-vs-actual computation. Behavior preserved from pre-M6. */
import { NotFoundError } from "../lib/errors";
import { auditService } from "./audit.service";
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
    await auditService.created("budget", row.id, row);
    return { ...row, budgetedAmount: toNum(row.budgetedAmount) };
  },

  async update(id: number, data: Record<string, unknown>) {
    const [before] = await budgetsRepository.findById(id);
    if (!before) throw new NotFoundError("Not found");
    const updates = { ...data } as Record<string, unknown>;
    if (updates.budgetedAmount != null) updates.budgetedAmount = String(updates.budgetedAmount);
    const [row] = await budgetsRepository.update(id, updates as Partial<typeof budgetsTable.$inferInsert>);
    await auditService.updated("budget", id, before, row);
    return { ...row, budgetedAmount: toNum(row.budgetedAmount) };
  },

  async remove(id: number) {
    const [before] = await budgetsRepository.findById(id);
    await budgetsRepository.remove(id);
    if (before) await auditService.deleted("budget", id, before);
  },
};
