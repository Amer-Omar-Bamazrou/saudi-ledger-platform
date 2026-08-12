/**
 * Transactions service — listing/pagination, upload with auto-categorization,
 * CRUD, and OpenAPI/Zod response assembly. Behavior preserved exactly from pre-M6,
 * including the per-row error collection on bulk upload.
 */
import {
  ListTransactionsResponse,
  CreateTransactionBody,
  CreateTransactionResponse,
  GetTransactionResponse,
  UpdateTransactionBody,
  UpdateTransactionResponse,
  UploadTransactionsBody,
  UploadTransactionsResponse,
} from "@workspace/api-zod";
import { AppError, NotFoundError } from "../lib/errors";
import { auditService } from "./audit.service";
import { categorizeTransaction, allEngineCodes } from "./categorization/categorizer.js";
import { AUTO_ASSIGN_CONFIDENCE, resolveSystemCodes, vatFromGross } from "./categorization/resolveCategory.js";

/** A row-failure reason safe to show a user — never the driver's SQL dump. */
function reasonFor(err: unknown): string {
  const code = (err as { code?: string })?.code;
  if (code === "23503") return " — it references a category that does not exist.";
  if (code === "23505") return " — an identical row already exists.";
  if (code === "22007" || code === "22008") return " — its date is not a valid date.";
  if (code === "22P02" || code === "22003") return " — its amount is not a valid number.";
  return ".";
}
import { transactionsRepository, type TransactionFilter } from "../repositories/transactions.repository";
import type { transactionsTable, categoriesTable } from "@workspace/db";

type Tx = typeof transactionsTable.$inferSelect;
type Cat = typeof categoriesTable.$inferSelect;
export type CreateTransactionInput = ReturnType<(typeof CreateTransactionBody)["parse"]>;
export type UpdateTransactionInput = ReturnType<(typeof UpdateTransactionBody)["parse"]>;
export type UploadTransactionsInput = ReturnType<(typeof UploadTransactionsBody)["parse"]>;

function buildTransactionRow(tx: Tx, cat?: Cat | null) {
  return {
    id: tx.id,
    date: tx.date,
    description: tx.description,
    descriptionAr: tx.descriptionAr ?? null,
    amount: Number(tx.amount),
    currency: tx.currency,
    type: tx.type as "debit" | "credit",
    categoryId: tx.categoryId ?? null,
    categoryName: cat?.name ?? null,
    categoryNameAr: cat?.nameAr ?? null,
    vatAmount: tx.vatAmount != null ? Number(tx.vatAmount) : null,
    vatRate: tx.vatRate != null ? Number(tx.vatRate) : null,
    isZakatRelevant: tx.isZakatRelevant,
    confidenceScore: tx.confidenceScore != null ? Number(tx.confidenceScore) : null,
    isManuallyOverridden: tx.isManuallyOverridden,
    source: tx.source ?? null,
    notes: tx.notes ?? null,
    createdAt: tx.createdAt.toISOString(),
  };
}

export const transactionsService = {
  async list(filter: TransactionFilter) {
    const [rows, countResult] = await Promise.all([
      transactionsRepository.list(filter),
      transactionsRepository.count(filter),
    ]);
    const total = countResult[0]?.count ?? 0;
    const transactions = rows.map((r) => buildTransactionRow(r.tx, r.cat));
    return ListTransactionsResponse.parse({
      transactions,
      total,
      offset: filter.offset ?? 0,
      limit: filter.limit ?? 50,
    });
  },

  async upload(data: UploadTransactionsInput) {
    const { rows, autoCategrize } = data;
    const errors: string[] = [];
    let inserted = 0;
    let categorized = 0;
    let duplicatesSkipped = 0;

    // Resolve every code the engine could emit ONCE, inside the tenant tx.
    const resolvedCodes = autoCategrize
      ? await resolveSystemCodes(allEngineCodes())
      : new Map<string, number>();

    for (const row of rows) {
      let rowWasCategorized = false;
      try {
        // M15: an identical row (date+description+amount+type) is skipped and
        // REPORTED — uploading the same statement twice used to double every
        // figure in the dashboard, VAT summary and Zakat base, silently.
        if (await transactionsRepository.existsIdentical({
          date: row.date,
          description: row.description,
          amount: String(row.amount),
          type: row.type,
        })) {
          duplicatesSkipped++;
          continue;
        }

        let catId: number | null = row.categoryId ?? null;
        let vatAmount: string | null = row.vatAmount != null ? String(row.vatAmount) : null;
        let vatRate: string | null = row.vatRate != null ? String(row.vatRate) : null;
        let isZakatRelevant = row.isZakatRelevant ?? false;
        let confidenceScore: string | null = null;

        if (autoCategrize) {
          const match = categorizeTransaction(
            row.description,
            Number(row.amount),
            row.type as "debit" | "credit",
            row.descriptionAr,
          );
          // 🔴 THREE M15 RULES, all fixed together:
          //  - the match carries a SYSTEM CODE resolved against the tenant's own
          //    chart, never the engine's private ids (which the FK rejected —
          //    the default upload path imported NOTHING);
          //  - a low-confidence match is a HINT: it does not assign, the row
          //    stays uncategorized for the Categorize page. This is the first
          //    consumer confidence_score has ever had;
          //  - VAT is EXTRACTED from the gross statement amount (rate/(100+rate)),
          //    never applied to it. The old arithmetic overstated every input-VAT
          //    figure by 15% and flowed straight into the VAT position.
          if (match && catId == null && match.confidence >= AUTO_ASSIGN_CONFIDENCE) {
            const resolved = resolvedCodes.get(match.systemCode);
            if (resolved != null) {
              catId = resolved;
              confidenceScore = String(match.confidence);
              isZakatRelevant = match.isZakatRelevant;
              if (match.vatApplicable && match.suggestedVatRate != null && vatAmount == null) {
                if (match.suggestedVatRate > 0) {
                  vatAmount = String(vatFromGross(Number(row.amount), match.suggestedVatRate));
                  vatRate = String(match.suggestedVatRate);
                }
              }
              // Counted here — AFTER resolution succeeded and BEFORE the insert
              // whose failure is caught below. See the categorized-- on failure.
              categorized++;
              rowWasCategorized = true;
            }
          }
        }

        await transactionsRepository.insert({
          date: row.date,
          description: row.description,
          descriptionAr: row.descriptionAr ?? null,
          amount: String(row.amount),
          currency: row.currency ?? "SAR",
          type: row.type,
          categoryId: catId,
          vatAmount,
          vatRate,
          isZakatRelevant,
          confidenceScore,
          isManuallyOverridden: false,
          source: row.source ?? "upload",
          notes: row.notes ?? null,
        });
        inserted++;
      } catch (err) {
        // 🔴 If this row had been counted as categorized, uncount it: a count of
        // work that did not persist is a lie about state. The pre-M15 response
        // reported categorized:1 / inserted:0 — claiming success while inserting
        // nothing.
        if (rowWasCategorized) categorized--;
        // 🔴 Never leak the raw driver error: it contained the full SQL text and
        // every parameter. A row failure names the row and the KIND of problem.
        errors.push(`Row "${row.description.slice(0, 80)}" could not be imported${reasonFor(err)}`);
      }
    }

    if (inserted > 0) {
      // Bulk import → one summary audit record (not one per row).
      await auditService.record({
        action: "create",
        entityType: "transaction",
        entityId: "bulk",
        after: { inserted, categorized },
      });
    }
    return UploadTransactionsResponse.parse({ inserted, categorized, duplicatesSkipped, errors });
  },

  async create(d: CreateTransactionInput) {
    const [tx] = await transactionsRepository.insert({
      date: d.date,
      description: d.description,
      descriptionAr: d.descriptionAr ?? null,
      amount: String(d.amount),
      currency: d.currency ?? "SAR",
      type: d.type,
      categoryId: d.categoryId ?? null,
      vatAmount: d.vatAmount != null ? String(d.vatAmount) : null,
      vatRate: d.vatRate != null ? String(d.vatRate) : null,
      isZakatRelevant: d.isZakatRelevant ?? false,
      confidenceScore: null,
      isManuallyOverridden: false,
      source: d.source ?? "manual",
      notes: d.notes ?? null,
    });
    await auditService.created("transaction", tx.id, tx);

    const [row] = await transactionsRepository.findWithCategory(tx.id);
    if (!row) throw new AppError(500, "Insert failed");
    return CreateTransactionResponse.parse(buildTransactionRow(row.tx, row.cat));
  },

  async getById(id: number) {
    const [row] = await transactionsRepository.findWithCategory(id);
    if (!row) throw new NotFoundError("Transaction not found");
    return GetTransactionResponse.parse(buildTransactionRow(row.tx, row.cat));
  },

  async update(id: number, data: UpdateTransactionInput) {
    const [existing] = await transactionsRepository.findWithCategory(id);
    if (!existing) throw new NotFoundError("Transaction not found");

    const updates: Partial<typeof transactionsTable.$inferInsert> = { isManuallyOverridden: true };
    if (data.categoryId !== undefined) updates.categoryId = data.categoryId ?? null;
    if (data.isZakatRelevant !== undefined) updates.isZakatRelevant = data.isZakatRelevant ?? false;
    if (data.vatAmount !== undefined) updates.vatAmount = data.vatAmount != null ? String(data.vatAmount) : null;
    if (data.vatRate !== undefined) updates.vatRate = data.vatRate != null ? String(data.vatRate) : null;
    if (data.notes !== undefined) updates.notes = data.notes ?? null;
    if (data.descriptionAr !== undefined) updates.descriptionAr = data.descriptionAr ?? null;

    await transactionsRepository.update(id, updates);

    const [row] = await transactionsRepository.findWithCategory(id);
    if (!row) throw new AppError(500, "Update failed");
    await auditService.updated("transaction", id, existing.tx, row.tx);
    return UpdateTransactionResponse.parse(buildTransactionRow(row.tx, row.cat));
  },

  async remove(id: number) {
    const [existing] = await transactionsRepository.findWithCategory(id);
    await transactionsRepository.remove(id);
    if (existing) await auditService.deleted("transaction", id, existing.tx);
  },
};
