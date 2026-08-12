/**
 * Categorization service — runs the deterministic rule engine over transactions
 * and persists matches. AI PROPOSES; this applies the rule-based categorizer
 * (never the LLM directly to the ledger). Behavior preserved exactly from pre-M6.
 */
import { RunCategorizationBody, RunCategorizationResponse } from "@workspace/api-zod";
import { auditService } from "./audit.service";
import { categorizeTransaction, allEngineCodes } from "./categorization/categorizer.js";
import { AUTO_ASSIGN_CONFIDENCE, resolveSystemCodes, vatFromGross } from "./categorization/resolveCategory.js";
import { categorizeRepository } from "../repositories/categorize.repository";

type RunInput = ReturnType<(typeof RunCategorizationBody)["parse"]>;

export const categorizeService = {
  async run({ transactionIds, overrideExisting }: RunInput) {
    const rows = await categorizeRepository.fetchTransactions(transactionIds ?? undefined, overrideExisting);
    const resolvedCodes = await resolveSystemCodes(allEngineCodes());
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

      // M15: the engine now says "I don't know" (null), and a low-confidence
      // match is a hint rather than an assignment. Both leave the row for the
      // human on this very page.
      if (!match || match.confidence < AUTO_ASSIGN_CONFIDENCE) {
        skipped++;
        continue;
      }

      // M15: resolve the SYSTEM CODE against the tenant's own chart. This
      // service carried its own copy of the id assignment — and of the VAT
      // arithmetic below — and both copies had both bugs. One shared
      // implementation now (`resolveCategory.ts`).
      const resolvedId = resolvedCodes.get(match.systemCode);
      if (resolvedId == null) {
        skipped++;
        continue;
      }

      let vatAmount: string | null = tx.vatAmount;
      let vatRate: string | null = tx.vatRate;
      if (match.vatApplicable && match.suggestedVatRate != null && match.suggestedVatRate > 0 && vatAmount == null) {
        vatRate = String(match.suggestedVatRate);
        // M15: EXTRACTED from the gross statement amount, never applied to it.
        vatAmount = String(vatFromGross(Number(tx.amount), match.suggestedVatRate));
      }

      await categorizeRepository.updateCategory(tx.id, {
        categoryId: resolvedId,
        confidenceScore: String(match.confidence),
        isZakatRelevant: match.isZakatRelevant,
        vatAmount,
        vatRate,
        isManuallyOverridden: false,
      });

      const cat = catMap.get(resolvedId);
      results.push({
        transactionId: tx.id,
        categoryId: resolvedId,
        categoryName: cat?.name ?? match.categoryName,
        confidence: match.confidence,
        matchedRule: match.matchedRule,
      });
      categorized++;
    }

    if (categorized > 0) {
      // Bulk auto-categorization → one summary audit record (not one per row).
      await auditService.record({
        action: "update",
        entityType: "transaction",
        entityId: "bulk",
        after: { processed: rows.length, categorized, skipped },
      });
    }
    return RunCategorizationResponse.parse({ processed: rows.length, categorized, skipped, results });
  },
};
