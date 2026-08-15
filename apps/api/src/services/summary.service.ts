/**
 * Summary service — income/expense, VAT and by-category rollups.
 *
 * The Zakat rollup was removed in M17.0 along with its hardcoded nisab
 * threshold and 2.5% rate; see the note above `getByCategory`.
 */
import {
  GetSummaryResponse,
  GetVatSummaryResponse,
  GetSummaryByCategoryResponse,
} from "@workspace/api-zod";
import { reportsService } from "./reports.service";
import { summaryRepository, type DateRange } from "../repositories/summary.repository";

export const summaryService = {
  /**
   * 🔴 Flaw #1 / meta-finding #9: THE DASHBOARD SHOWS THE P&L'S NUMBERS.
   *
   * This used to sum  by debit/credit — a second, independent
   * answer to "what were my income and expenses". Observed live, the two
   * disagreed completely: 45,063.25 of expenses here, 0.00 on the income
   * statement, same tenant and month. Worse, summing by TYPE alone meant
   * everything that left the bank counted as an expense — a VAT remittance
   * settling a liability, a loan principal repayment, a fixed-asset purchase,
   * and every uncategorised debit.
   *
   * Now that acceptance posts to the ledger (Option A), the honest fix is not
   * a better sum — it is to STOP COMPUTING IT TWICE. Income and expenses come
   * from , so the dashboard and the P&L cannot drift by
   * construction, and account TYPE decides what counts (a liability payment
   * is not an expense because the ledger says so, not because a rule here
   * remembers to exclude it).
   *
   * VAT and the row counts stay transaction-derived on purpose: they are the
   * reconciliation/operational view M16.1 designed, not ledger claims.
   */
  async getSummary(range: DateRange) {
    const [rows, pl] = await Promise.all([
      summaryRepository.summaryRows(range),
      reportsService.incomeStatement(range.dateFrom ?? undefined, range.dateTo ?? undefined),
    ]);
    const totalIncome = pl.totalRevenue;
    const totalExpenses = pl.totalExpenses;
    let totalVatCollected = 0;
    let totalVatPaid = 0;
    let uncategorizedCount = 0;

    for (const r of rows) {
      const vat = r.vatAmount != null ? Number(r.vatAmount) : 0;
      if (r.categoryId == null) uncategorizedCount++;
      if (r.type === "credit") totalVatCollected += vat;
      else totalVatPaid += vat;
    }

    return GetSummaryResponse.parse({
      totalIncome,
      totalExpenses,
      netPosition: totalIncome - totalExpenses,
      totalVatCollected,
      totalVatPaid,
      netVat: totalVatCollected - totalVatPaid,
      transactionCount: rows.length,
      uncategorizedCount,
    });
  },

  async getVat(range: DateRange) {
    const rows = await summaryRepository.vatRows(range);
    let vatCollected = 0;
    let vatPaid = 0;
    const transactions = rows.map((r) => {
      const vat = Number(r.vatAmount ?? 0);
      if (r.type === "credit") vatCollected += vat;
      else vatPaid += vat;
      return { id: r.id, date: r.date, description: r.description, amount: Number(r.amount), vatAmount: vat, type: r.type };
    });
    return GetVatSummaryResponse.parse({
      vatCollected,
      vatPaid,
      netVatPosition: vatCollected - vatPaid,
      vatRate: 15,
      transactions,
    });
  },

  /**
   * 🔴 `getZakat` was REMOVED in M17.0 (owner decision Q6/Q7). It is recorded
   * here rather than deleted silently, because the next person to notice the
   * platform has no Zakat figure should find out WHY before rebuilding this.
   *
   * It summed `transactions` flagged `is_zakat_relevant`. Almost nothing wrote
   * that flag: exactly ONE categorization rule out of ~40 set it true ("Saudi
   * investment / Tadawul" → INVESTMENT_INCOME), the rest emitted `false`. So
   * the input set was empty for almost every tenant and the endpoint returned a
   * computed-looking SAR 0.00 — and for a tenant who DID trade, something worse
   * than zero: investment INCOME counted as a zakatable ASSET, since the sum
   * added credits and subtracted debits (a flow over all time, presented as a
   * balance). It then compared the result to a nisab threshold hardcoded from a
   * 2024 gold price (`NISAB_SAR = 19550`), which is PERSONAL-Zakat reasoning
   * applied to a company.
   *
   * Zakat returns in M17.4 as a GL-derived working paper: balance-sheet
   * accounts, a real fiscal year, tenant adjustments, and a lock. It is not a
   * summary endpoint and must not be rebuilt as one.
   * See docs/product/design-zakat-module.md.
   */

  async getByCategory(range: DateRange) {
    const rows = await summaryRepository.byCategoryRows(range);
    const result = rows.map((r) => ({
      categoryId: r.categoryId!,
      categoryName: r.categoryName ?? "Unknown",
      categoryNameAr: r.categoryNameAr ?? "",
      type: r.categoryType ?? "expense",
      total: Number(r.total),
      count: Number(r.count),
      vatTotal: Number(r.vatTotal),
    }));
    return GetSummaryByCategoryResponse.parse(result);
  },
};
