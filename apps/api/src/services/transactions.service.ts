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
import { AppError, BadRequestError, NotFoundError } from "../lib/errors";
import { bankAccountsRepository } from "../repositories/bankAccounts.repository";
import { auditService } from "./audit.service";
import { categorizeTransaction, allEngineCodes } from "./categorization/categorizer.js";
import { AUTO_ASSIGN_CONFIDENCE, resolveSystemCodes, vatFromGross, type ResolvedCategory } from "./categorization/resolveCategory.js";

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
    reviewStatus: tx.reviewStatus,
    kind: tx.kind,
    taxTreatment: tx.taxTreatment ?? null,
    bankAccountId: tx.bankAccountId ?? null,
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

    // M16.2 — which bank account is this statement from? RLS scopes the lookup,
    // so another tenant's id simply does not resolve. Fail closed on an unknown
    // id rather than silently importing unattributed rows.
    const bankAccountId = data.bankAccountId ?? null;
    if (bankAccountId != null) {
      const [account] = await bankAccountsRepository.findById(bankAccountId);
      if (!account) throw new BadRequestError("Unknown bank account for this organization");
    }

    // Resolve every code the engine could emit ONCE, inside the tenant tx.
    const resolvedCodes = autoCategrize
      ? await resolveSystemCodes(allEngineCodes())
      : new Map<string, ResolvedCategory>();

    for (const row of rows) {
      let rowWasCategorized = false;
      try {
        // M15: an identical row (date+description+amount+type) is skipped and
        // REPORTED — uploading the same statement twice used to double every
        // figure in the dashboard, VAT summary and Zakat base, silently.
        // M16.2 — the duplicate key now includes the account: the same salary
        // paid from two accounts is two real rows, and a statement re-uploaded
        // against ITS OWN account is the duplicate case.
        if (await transactionsRepository.existsIdentical({
          date: row.date,
          description: row.description,
          amount: String(row.amount),
          type: row.type,
          bankAccountId,
        })) {
          duplicatesSkipped++;
          continue;
        }

        let catId: number | null = row.categoryId ?? null;
        let vatAmount: string | null = row.vatAmount != null ? String(row.vatAmount) : null;
        let vatRate: string | null = row.vatRate != null ? String(row.vatRate) : null;
        let isZakatRelevant = row.isZakatRelevant ?? false;
        let confidenceScore: string | null = null;
        let kind: string = "operating";
        let taxTreatment: string | null = null;

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
          if (match && match.kind === "transfer" && catId == null) {
            // M16.2 — a TRANSFER: money between the business's own pockets.
            // No category (a category states what was bought or earned; a
            // transfer is neither), no VAT, excluded from every P&L/tax
            // aggregate by `kind`. Counted as classified — the engine gave a
            // confident answer; it is just not a category.
            kind = "transfer";
            confidenceScore = String(match.confidence);
            vatAmount = null;
            vatRate = null;
            categorized++;
            rowWasCategorized = true;
          } else if (match && catId == null && match.confidence >= AUTO_ASSIGN_CONFIDENCE) {
            const resolved = resolvedCodes.get(match.systemCode);
            if (resolved != null) {
              catId = resolved.id;
              confidenceScore = String(match.confidence);
              isZakatRelevant = match.isZakatRelevant;
              // M16.2 — the treatment comes from the CATEGORY's default, and
              // VAT is extracted ONLY for 'S'. 'Z'/'E'/'O' record zero VAT AND
              // say why; null stays honest-unknown (no VAT guessed).
              taxTreatment = resolved.defaultTaxTreatment;
              if (taxTreatment === "S" && vatAmount == null) {
                const rate =
                  match.suggestedVatRate != null && match.suggestedVatRate > 0 ? match.suggestedVatRate : 15;
                vatAmount = String(vatFromGross(Number(row.amount), rate));
                vatRate = String(rate);
              }
              // Counted here — AFTER resolution succeeded and BEFORE the insert
              // whose failure is caught below. See the categorized-- on failure.
              categorized++;
              rowWasCategorized = true;
            }
          }
        }

        await transactionsRepository.insert({
          // M15 holding area: imported rows are PENDING until a human accepts.
          reviewStatus: "pending_review",
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
          kind,
          taxTreatment,
          bankAccountId,
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

  /** Pending imported rows — the holding-area review surface. */
  async pendingReview() {
    const rows = await transactionsRepository.pendingReview();
    return rows.map((r) => ({
      id: r.tx.id,
      date: r.tx.date,
      description: r.tx.description,
      descriptionAr: r.tx.descriptionAr,
      amount: Number(r.tx.amount),
      type: r.tx.type,
      categoryId: r.tx.categoryId,
      categoryName: r.cat?.name ?? null,
      confidenceScore: r.tx.confidenceScore != null ? Number(r.tx.confidenceScore) : null,
      vatAmount: r.tx.vatAmount != null ? Number(r.tx.vatAmount) : null,
      kind: r.tx.kind,
      taxTreatment: r.tx.taxTreatment,
      // The UI separates these; the SERVER enforces the separation in
      // acceptPending. needsAttention rows are excluded from bulk accept.
      // M16.2: a confident TRANSFER is classified — the classification is the
      // kind, not a category — so it does not demand attention.
      needsAttention:
        (r.tx.categoryId == null && r.tx.kind !== "transfer") ||
        (r.tx.confidenceScore != null && Number(r.tx.confidenceScore) < AUTO_ASSIGN_CONFIDENCE && !r.tx.isManuallyOverridden),
    }));
  },

  /**
   * Accept pending rows. `ids` present = deliberate, named acceptance (any
   * pending row, including uncategorized). `ids` absent = bulk mode, which the
   * repository restricts to rows safe to accept unread.
   */
  async acceptPending(ids?: number[]) {
    const result = await transactionsRepository.acceptPending({
      ids,
      minConfidence: AUTO_ASSIGN_CONFIDENCE,
    });
    if (result.accepted > 0) {
      await auditService.record({
        action: "update",
        entityType: "transaction",
        entityId: "bulk-accept",
        after: { accepted: result.accepted, mode: ids?.length ? "explicit" : "bulk" },
      });
    }
    return result;
  },

  async create(d: CreateTransactionInput) {
    const [tx] = await transactionsRepository.insert({
      // M15: manual single entry is ACCEPTED on creation — a human typing one
      // row is looking at that row (the M10.4 self-approve analogue). Only
      // IMPORTED rows land pending, because import changes the authorship of
      // rows that move tax figures.
      reviewStatus: "accepted",
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
