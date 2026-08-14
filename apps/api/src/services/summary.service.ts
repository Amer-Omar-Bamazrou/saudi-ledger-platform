/**
 * Summary service — income/expense, VAT, Zakat, and by-category rollups.
 * All arithmetic (incl. Nisab threshold + 2.5% Zakat rate) preserved from pre-M6.
 */
import {
  GetSummaryResponse,
  GetVatSummaryResponse,
  GetZakatSummaryResponse,
  GetSummaryByCategoryResponse,
} from "@workspace/api-zod";
import { reportsService } from "./reports.service";
import { summaryRepository, type DateRange } from "../repositories/summary.repository";

// Nisab threshold in SAR (approx. 85g gold at ~230 SAR/g as of 2024).
const NISAB_SAR = 19550;
const ZAKAT_RATE = 0.025; // 2.5%

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

  async getZakat() {
    const rows = await summaryRepository.zakatRows();
    let totalZakatableAssets = 0;
    const eligibleTransactions = rows.map((r) => {
      const amt = Number(r.tx.amount);
      if (r.tx.type === "credit") totalZakatableAssets += amt;
      else totalZakatableAssets -= amt;
      return {
        id: r.tx.id,
        date: r.tx.date,
        description: r.tx.description,
        descriptionAr: r.tx.descriptionAr ?? null,
        amount: amt,
        currency: r.tx.currency,
        type: r.tx.type as "debit" | "credit",
        categoryId: r.tx.categoryId ?? null,
        categoryName: r.cat?.name ?? null,
        categoryNameAr: r.cat?.nameAr ?? null,
        vatAmount: r.tx.vatAmount != null ? Number(r.tx.vatAmount) : null,
        vatRate: r.tx.vatRate != null ? Number(r.tx.vatRate) : null,
        isZakatRelevant: r.tx.isZakatRelevant,
        confidenceScore: r.tx.confidenceScore != null ? Number(r.tx.confidenceScore) : null,
        isManuallyOverridden: r.tx.isManuallyOverridden,
        source: r.tx.source ?? null,
        notes: r.tx.notes ?? null,
        createdAt: r.tx.createdAt.toISOString(),
      };
    });

    const zakatablePositive = Math.max(totalZakatableAssets, 0);
    const zakatDue = zakatablePositive >= NISAB_SAR ? zakatablePositive * ZAKAT_RATE : 0;

    return GetZakatSummaryResponse.parse({
      totalZakatableAssets: zakatablePositive,
      nisabThresholdSAR: NISAB_SAR,
      zakatDue,
      eligibleTransactions,
    });
  },

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
