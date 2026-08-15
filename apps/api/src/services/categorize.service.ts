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

      // M16.2 — a TRANSFER gets a kind, never a category: no VAT, no category
      // id, excluded from P&L/tax aggregates by the kind filter.
      if (match.kind === "transfer") {
        await categorizeRepository.updateCategory(tx.id, {
          categoryId: null,
          kind: "transfer",
          taxTreatment: null,
          vatBasis: null,
          confidenceScore: String(match.confidence),
          vatAmount: null,
          vatRate: null,
        });
        categorized++;
        results.push({
          transactionId: tx.id,
          categoryId: 0,
          categoryName: match.categoryName,
          confidence: match.confidence,
          matchedRule: match.matchedRule,
        });
        continue;
      }

      // M15: resolve the SYSTEM CODE against the tenant's own chart. This
      // service carried its own copy of the id assignment — and of the VAT
      // arithmetic below — and both copies had both bugs. One shared
      // implementation now (`resolveCategory.ts`).
      const resolved = resolvedCodes.get(match.systemCode);
      if (resolved == null) {
        skipped++;
        continue;
      }
      const resolvedId = resolved.id;

      let vatAmount: string | null = tx.vatAmount;
      let vatRate: string | null = tx.vatRate;
      // M16.2: VAT is extracted ONLY when the category's default treatment is
      // 'S'. Z/E/O record zero VAT and say why via tax_treatment; a null
      // treatment stays honest-unknown.
      // Flaw #6: standard-rated does not mean VAT was charged — a foreign
      // digital supplier charges none and the buyer self-accounts.
      const vatBasis =
        resolved.defaultTaxTreatment === "S" ? (match.vatBasis ?? "charged") : null;
      if (resolved.defaultTaxTreatment === "S" && vatBasis !== "charged") {
        vatAmount = null;
        vatRate = null;
      } else if (resolved.defaultTaxTreatment === "S" && vatAmount == null) {
        const rate = match.suggestedVatRate != null && match.suggestedVatRate > 0 ? match.suggestedVatRate : 15;
        vatRate = String(rate);
        // M15: EXTRACTED from the gross statement amount, never applied to it.
        vatAmount = String(vatFromGross(Number(tx.amount), rate));
      } else if (resolved.defaultTaxTreatment && resolved.defaultTaxTreatment !== "S") {
        // 🔴 Audit Tier 2 (finding 4): the treatment and the VAT travel
        // TOGETHER. Assigning a Z/E/O category used to keep a stale/CSV
        // vat_amount alongside the very treatment that says none can exist —
        // and vatRows counts any non-null vat_amount, so the reconciliation
        // moved by VAT the platform itself labelled impossible. Also enforced
        // by the DB CHECK (migration 0034); this keeps the write from 500ing.
        vatAmount = null;
        vatRate = null;
      }

      await categorizeRepository.updateCategory(tx.id, {
        categoryId: resolvedId,
        confidenceScore: String(match.confidence),
        vatAmount,
        vatRate,
        taxTreatment: resolved.defaultTaxTreatment,
        vatBasis,
        // Audit Tier 2: the engine never erases the human-override marker —
        // it gates treatmentAssumed and bulk-accept eligibility, and only a
        // human PATCH may claim it.
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
