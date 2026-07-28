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
import { categorizeTransaction } from "./categorization/categorizer.js";
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

    for (const row of rows) {
      try {
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
          if (match && catId == null) {
            catId = match.categoryId;
            confidenceScore = String(match.confidence);
            isZakatRelevant = match.isZakatRelevant;
            if (match.vatApplicable && match.suggestedVatRate != null && vatAmount == null) {
              const vatRate15 = match.suggestedVatRate;
              if (vatRate15 > 0) {
                vatAmount = String((Number(row.amount) * vatRate15) / 100);
                vatRate = String(vatRate15);
              }
            }
            categorized++;
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
        errors.push(`Row "${row.description}" — ${String(err)}`);
      }
    }

    return UploadTransactionsResponse.parse({ inserted, categorized, errors });
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
    return UpdateTransactionResponse.parse(buildTransactionRow(row.tx, row.cat));
  },

  async remove(id: number) {
    await transactionsRepository.remove(id);
  },
};
