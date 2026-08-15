/** Budgets service — budget-vs-actual computation. Behavior preserved from pre-M6. */
import { NotFoundError } from "../lib/errors";
import { auditService } from "./audit.service";
import { budgetsRepository } from "../repositories/budgets.repository";
import type { budgetsTable } from "@workspace/db";

const toNum = (v: unknown) => (v != null ? Number(v) : 0);

/**
 * 🔴 M19.0 — the actual, with its SIGN, for one budgeted account.
 *
 * The defect this replaces: actuals were `sum(amount)`, and amounts are stored
 * POSITIVE with the direction in `type` (CLAUDE.md §4). So a refund on an
 * expense budget INCREASED "spent" — buy 5,000, refund 5,000, and the budget
 * reported 10,000 consumed instead of nothing. Tolerable while budgets were an
 * unused corner; not tolerable now that Analytics will chart the variance
 * (design-analytics.md §7), because the error becomes a visible claim.
 *
 * Which way is "more" depends on the ACCOUNT TYPE, not on the transaction:
 *
 *   expense, asset               debit-natural  → spending is debits
 *   income, liability, equity    credit-natural → earning  is credits
 *
 * This is the same split `reports.incomeStatement` applies to GL lines
 * (`revenue += credit - debit`, `expenses += debit - credit`), and the
 * unknown-type default matches it too: an orphaned category falls back to
 * expense, because that is what an uncategorised spend almost always is.
 *
 * A negative result is CORRECT and is returned, not clamped: refunds exceeding
 * spend is a real state, and hiding it behind a floor of zero would be the
 * same class of lie as the original bug.
 */
function signedActual(categoryType: string | null | undefined, debit: number, credit: number): number {
  const creditNatural =
    categoryType === "income" || categoryType === "liability" || categoryType === "equity";
  const signed = creditNatural ? credit - debit : debit - credit;
  return Math.round(signed * 100) / 100;
}

export const budgetsService = {
  async list(period?: string) {
    const rows = await budgetsRepository.listWithCategory(period);
    return Promise.all(
      rows.map(async ({ budget, cat }) => {
        // `period` is a YYYY string — budgets are ANNUAL today (see the
        // periodisation fork in docs/product/design-analytics.md §7).
        const periodStart = `${budget.period}-01-01`;
        const periodEnd = `${budget.period}-12-31`;
        let actualAmount = 0;
        if (budget.categoryId) {
          const txs = await budgetsRepository.sumTransactions(budget.categoryId, periodStart, periodEnd);
          actualAmount = signedActual(cat?.type, Number(txs[0]?.debit ?? 0), Number(txs[0]?.credit ?? 0));
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
