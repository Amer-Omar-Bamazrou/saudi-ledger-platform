import { Router } from "express";
import { db } from "@workspace/db";
import { transactionsTable, categoriesTable } from "@workspace/db";
import { eq, isNull, inArray } from "drizzle-orm";
import { RunCategorizationBody, RunCategorizationResponse } from "@workspace/api-zod";
import { categorizeTransaction } from "../services/categorization/categorizer.js";

const router = Router();

router.post("/", async (req, res) => {
  const body = RunCategorizationBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const { transactionIds, overrideExisting } = body.data;

  try {
    // Fetch transactions to process
    let query = db
      .select({ tx: transactionsTable })
      .from(transactionsTable)
      .$dynamic();

    if (transactionIds && transactionIds.length > 0) {
      query = query.where(inArray(transactionsTable.id, transactionIds)) as typeof query;
    } else if (!overrideExisting) {
      query = query.where(isNull(transactionsTable.categoryId)) as typeof query;
    }
    // If overrideExisting but no specific ids, process all

    const rows = await query;

    // Load all categories for name lookup
    const categories = await db.select().from(categoriesTable);
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
      // Skip manually overridden unless explicitly targeting by id
      if (tx.isManuallyOverridden && !transactionIds?.includes(tx.id)) {
        skipped++;
        continue;
      }
      // Skip already categorized unless override
      if (tx.categoryId != null && !overrideExisting && !transactionIds?.includes(tx.id)) {
        skipped++;
        continue;
      }

      const match = categorizeTransaction(
        tx.description,
        Number(tx.amount),
        tx.type as "debit" | "credit",
        tx.descriptionAr
      );

      if (!match) {
        skipped++;
        continue;
      }

      // Compute VAT if applicable
      let vatAmount: string | null = tx.vatAmount;
      let vatRate: string | null = tx.vatRate;
      if (match.vatApplicable && match.suggestedVatRate != null && match.suggestedVatRate > 0 && vatAmount == null) {
        vatRate = String(match.suggestedVatRate);
        vatAmount = String((Number(tx.amount) * match.suggestedVatRate) / 100);
      }

      await db
        .update(transactionsTable)
        .set({
          categoryId: match.categoryId,
          confidenceScore: String(match.confidence),
          isZakatRelevant: match.isZakatRelevant,
          vatAmount,
          vatRate,
          isManuallyOverridden: false,
        })
        .where(eq(transactionsTable.id, tx.id));

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

    const parsed = RunCategorizationResponse.parse({
      processed: rows.length,
      categorized,
      skipped,
      results,
    });
    res.json(parsed);
  } catch (err) {
    req.log.error({ err }, "runCategorization failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
