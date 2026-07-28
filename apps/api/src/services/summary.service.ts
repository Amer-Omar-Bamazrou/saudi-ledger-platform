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
import { summaryRepository, type DateRange } from "../repositories/summary.repository";

// Nisab threshold in SAR (approx. 85g gold at ~230 SAR/g as of 2024).
const NISAB_SAR = 19550;
const ZAKAT_RATE = 0.025; // 2.5%

export const summaryService = {
  async getSummary(range: DateRange) {
    const rows = await summaryRepository.summaryRows(range);
    let totalIncome = 0;
    let totalExpenses = 0;
    let totalVatCollected = 0;
    let totalVatPaid = 0;
    let uncategorizedCount = 0;

    for (const r of rows) {
      const amt = Number(r.amount);
      const vat = r.vatAmount != null ? Number(r.vatAmount) : 0;
      if (r.categoryId == null) uncategorizedCount++;
      if (r.type === "credit") {
        totalIncome += amt;
        totalVatCollected += vat;
      } else {
        totalExpenses += amt;
        totalVatPaid += vat;
      }
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
