/**
 * Categorization service — runs the deterministic rule engine over transactions
 * and persists matches. AI PROPOSES; this applies the rule-based categorizer
 * (never the LLM directly to the ledger). Behavior preserved exactly from pre-M6.
 */
import { RunCategorizationBody, RunCategorizationResponse } from "@workspace/api-zod";
import { categorizeTransaction } from "./categorization/categorizer.js";
import { categorizeRepository } from "../repositories/categorize.repository";

type RunInput = ReturnType<(typeof RunCategorizationBody)["parse"]>;

export const categorizeService = {
  async run({ transactionIds, overrideExisting }: RunInput) {
    const rows = await categorizeRepository.fetchTransactions(transactionIds ?? undefined, overrideExisting);
    const categories = await categorizeRepository.allCategories();
    const catMap = new Map(categories.map((c) => [c.id, c]));

    let categorized = 0;
    let skipped = 0;
    const results: Array<{
      transactionId: number;
      categoryId: number;
      categoryName: string;
      confidence: number;
      matchedRule: string | null;
    }> = [];

    for (const { tx } of rows) {
      if (tx.isManuallyOverridden && !transactionIds?.includes(tx.id)) {
        skipped++;
        continue;
      }
      if (tx.categoryId != null && !overrideExisting && !transactionIds?.includes(tx.id)) {
        skipped++;
        continue;
      }

      const match = categorizeTransaction(
        tx.description,
        Number(tx.amount),
        tx.type as "debit" | "credit",
        tx.descriptionAr,
      );

      if (!match) {
        skipped++;
        continue;
      }

      let vatAmount: string | null = tx.vatAmount;
      let vatRate: string | null = tx.vatRate;
      if (match.vatApplicable && match.suggestedVatRate != null && match.suggestedVatRate > 0 && vatAmount == null) {
        vatRate = String(match.suggestedVatRate);
        vatAmount = String((Number(tx.amount) * match.suggestedVatRate) / 100);
      }

      await categorizeRepository.updateCategory(tx.id, {
        categoryId: match.categoryId,
        confidenceScore: String(match.confidence),
        isZakatRelevant: match.isZakatRelevant,
        vatAmount,
        vatRate,
        isManuallyOverridden: false,
      });

      const cat = catMap.get(match.categoryId);
      results.push({
        transactionId: tx.id,
        categoryId: match.categoryId,
        categoryName: cat?.name ?? match.categoryName,
        confidence: match.confidence,
        matchedRule: match.matchedRule,
      });
      categorized++;
    }

    return RunCategorizationResponse.parse({ processed: rows.length, categorized, skipped, results });
  },
};
