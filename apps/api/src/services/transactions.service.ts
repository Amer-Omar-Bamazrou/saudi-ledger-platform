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
import { AppError, BadRequestError, ConflictError, NotFoundError } from "../lib/errors";
import { bankAccountsRepository } from "../repositories/bankAccounts.repository";
import { auditService } from "./audit.service";
import { categorizeTransaction, allEngineCodes, looksForeignDigitalSupplier } from "./categorization/categorizer.js";
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
import { reconciliationService } from "./reconciliation.service";
import { categoriesRepository } from "../repositories/categories.repository";
import { transactionPostingService } from "./transactionPosting.service";
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
    confidenceScore: tx.confidenceScore != null ? Number(tx.confidenceScore) : null,
    isManuallyOverridden: tx.isManuallyOverridden,
    source: tx.source ?? null,
    reviewStatus: tx.reviewStatus,
    kind: tx.kind,
    taxTreatment: tx.taxTreatment ?? null,
    vatBasis: tx.vatBasis ?? null,
    bankAccountId: tx.bankAccountId ?? null,
    transferDirection: tx.transferDirection ?? null,
    counterpartyBankAccountId: tx.counterpartyBankAccountId ?? null,
    settlesInvoiceId: tx.settlesInvoiceId ?? null,
    settlesBillId: tx.settlesBillId ?? null,
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
    /**
     * 🔴 Audit finding #10: the duplicates COUNT conflated two different
     * events — "you re-uploaded the same statement" (housekeeping) and "your
     * business genuinely paid the same amount twice today" (lost money). The
     * skipped rows are now returned so the user can see WHAT was dropped and
     * re-enter a genuine second payment. A bare number cannot be acted on.
     */
    const duplicates: Array<{ date: string; description: string; amount: number }> = [];
    let inserted = 0;
    let categorized = 0;

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

    for (const raw of rows) {
      let rowWasCategorized = false;
      try {
        // 🔴 Audit finding #5: NORMALISE THE DESCRIPTION ON INGEST.
        // The duplicate key is exact string equality, so ONE TRAILING SPACE
        // defeated it — the same statement re-exported with different spacing
        // imported twice, double-counting the expense AND its VAT. Trailing,
        // leading and repeated internal whitespace are formatting, not data.
        const description = String(raw.description ?? "").trim().replace(/\s+/g, " ");
        if (!description) {
          errors.push("A row with an empty description could not be imported.");
          continue;
        }
        const row = { ...raw, description, descriptionAr: raw.descriptionAr?.trim() || null };

        // 🔴 Audit finding #4: CURRENCY WAS STORED AND IGNORED. A row of
        // "500.00 USD" was summed as 500 SAR — understating the expense by
        // ~73% and extracting SAR "VAT" from a foreign-currency charge that
        // carried none. No aggregate anywhere consults `currency`, so the only
        // honest options are convert (needs FX rates we do not have) or
        // REFUSE. It refuses, per row, naming the row — silently mis-summing
        // money is the one thing this platform must not do.
        const currency = (row.currency ?? "SAR").toUpperCase();
        if (currency !== "SAR") {
          errors.push(
            `Row "${description.slice(0, 60)}" is in ${currency}. Multi-currency statements are not supported yet — ` +
              `convert it to SAR and re-import, or enter it manually at the SAR amount that left your account.`,
          );
          continue;
        }
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
          duplicates.push({ date: row.date, description, amount: Number(row.amount) });
          continue;
        }

        let catId: number | null = row.categoryId ?? null;
        let vatAmount: string | null = row.vatAmount != null ? String(row.vatAmount) : null;
        let vatRate: string | null = row.vatRate != null ? String(row.vatRate) : null;
        let confidenceScore: string | null = null;
        let kind: string = "operating";
        let taxTreatment: string | null = null;
        // Flaw #6: whether VAT was actually CHARGED — a different fact from
        // what the supply is. Extraction requires BOTH.
        let vatBasis: string | null = null;

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
              // M16.2 — the treatment comes from the CATEGORY's default, and
              // VAT is extracted ONLY for 'S'. 'Z'/'E'/'O' record zero VAT AND
              // say why; null stays honest-unknown (no VAT guessed).
              taxTreatment = resolved.defaultTaxTreatment;
              // 🔴 Flaw #6: a foreign digital supplier charges no KSA VAT (the
              // buyer self-accounts), so a standard-rated supply can still
              // carry nothing. Extracting anyway is what invented 450.00 of
              // input VAT on one Google Ads charge in the live SME run.
              vatBasis =
                taxTreatment === "S"
                  ? (match.vatBasis ?? (looksForeignDigitalSupplier(description) ? "reverse_charge" : "charged"))
                  : null;
              if (taxTreatment === "S" && vatBasis === "charged" && vatAmount == null) {
                const rate =
                  match.suggestedVatRate != null && match.suggestedVatRate > 0 ? match.suggestedVatRate : 15;
                vatAmount = String(vatFromGross(Number(row.amount), rate));
                vatRate = String(rate);
              } else if (taxTreatment === "S" && vatBasis !== "charged") {
                // Standard-rated, but nothing was charged on this payment.
                // Recorded as such rather than left blank: "no VAT because
                // reverse charge" and "no VAT because we don't know" are
                // different answers, and the reconciliation view must not
                // treat them alike.
                vatAmount = null;
                vatRate = null;
              } else if (taxTreatment && taxTreatment !== "S") {
                // 🔴 Audit Tier 2 (finding 4): a CSV-supplied VAT on a row the
                // classification says is Z/E/O is a contradiction — the
                // treatment wins for the reconcile-grade estimate (a human can
                // override either in review). Without this, the row persisted
                // treatment='Z' + VAT and moved the VAT reconciliation by an
                // amount its own treatment says cannot exist. DB CHECK 0034
                // enforces the same at the write boundary.
                vatAmount = null;
                vatRate = null;
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
          confidenceScore,
          isManuallyOverridden: false,
          kind,
          taxTreatment,
          vatBasis,
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
        errors.push(`Row "${String(raw.description ?? "").trim().slice(0, 80)}" could not be imported${reasonFor(err)}`);
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
    return UploadTransactionsResponse.parse({
      inserted,
      categorized,
      duplicatesSkipped: duplicates.length,
      duplicates,
      errors,
    });
  },

  /** Pending imported rows — the holding-area review surface. */
  async pendingReview() {
    const rows = await transactionsRepository.pendingReview();
    // M16.3 — exact-match settlement suggestions, computed server-side so the
    // UI shows them pre-selected. Suggestions only: nothing here applies one.
    const suggestions = await reconciliationService.suggestFor(rows.map((r) => r.tx));
    return rows.map((r) => ({
      suggestion: suggestions.get(r.tx.id) ?? null,
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
      vatBasis: r.tx.vatBasis,
      /**
       * M16.3.1 — an unverified treatment default must be visible where it is
       * USED. Corrected after audit finding #3: this keyed off
       * `isManuallyOverridden`, so once a human assigned the CATEGORY the hint
       * vanished — even though the treatment was still the category's
       * unverified guess, not the human's assertion.
       *
       * The honest test needs no new column: the treatment is "assumed" when
       * it still EQUALS the category's unverified default. If the human
       * changed it to something else, that is their statement and the hint
       * correctly disappears.
       */
      treatmentAssumed:
        r.tx.taxTreatment != null &&
        r.cat?.treatmentVerified === false &&
        r.cat?.defaultTaxTreatment === r.tx.taxTreatment,
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

    /**
     * 🔴 Flaw #1 (Option A): ACCEPTANCE POSTS TO THE LEDGER.
     *
     * Runs inside the same tenant transaction as the acceptance, so a row can
     * never be accepted-but-unposted. Before this, accepted bank lines reached
     * the dashboard and never the income statement — one live SME month showed
     * 0.00 of expenses on the P&L beside 45,063.25 on the dashboard.
     *
     * A posting failure (a locked period, an incomplete chart) is REPORTED,
     * not swallowed: the whole point is that nothing lands in the books
     * silently.
     */
    const posting = result.acceptedIds.length > 0
      ? await transactionPostingService.postMany(result.acceptedIds)
      : { posted: 0, failed: [] as Array<{ id: number; reason: string }> };

    if (result.accepted > 0) {
      await auditService.record({
        action: "update",
        entityType: "transaction",
        entityId: "bulk-accept",
        after: { accepted: result.accepted, mode: ids?.length ? "explicit" : "bulk", posted: posting.posted },
      });
    }
    return { ...result, posted: posting.posted, postingFailures: posting.failed };
  },

  /**
   * M16.3 — accept a pending row AS the settlement of an invoice/bill. One
   * act: acceptance out of the holding area + the payment, through the
   * existing pay path. See reconciliation.service for the full contract.
   */
  async settle(id: number, input: { invoiceId?: number | null; billId?: number | null }, userId: number | null) {
    const tx = await reconciliationService.settle(id, input, userId);
    const [row] = await transactionsRepository.findWithCategory(tx.id);
    return GetTransactionResponse.parse(buildTransactionRow(row!.tx, row!.cat));
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

    // ── Audit Tier 2 (finding 6): a settlement row's classification is the
    // settlement contract. Its category/VAT/treatment were deliberately
    // stripped when the human accepted the match (the VAT fact lives on the
    // settled document); re-adding any of them would contradict the linked
    // payment. Notes and Arabic description stay editable.
    if (
      existing.tx.kind === "settlement" &&
      (data.categoryId !== undefined || data.vatAmount !== undefined || data.vatRate !== undefined ||
        data.taxTreatment !== undefined || data.vatBasis !== undefined)
    ) {
      throw new ConflictError(
        "This transaction settles an invoice/bill — its tax facts live on the settled document and cannot be edited here.",
      );
    }

    // Audit Tier 2 (finding 4): treatment and VAT travel together. Refuse a
    // vatAmount whose effective treatment (the payload's, or the row's when
    // the payload leaves it alone) says no VAT can exist. Null treatment is
    // honest-unknown and MAY carry user-asserted VAT (manual-entry design).
    const effectiveTreatment = data.taxTreatment !== undefined ? data.taxTreatment : existing.tx.taxTreatment;
    if (
      data.vatAmount != null &&
      Number(data.vatAmount) !== 0 &&
      effectiveTreatment != null &&
      effectiveTreatment !== "S"
    ) {
      throw new BadRequestError(
        `This row's VAT treatment is '${effectiveTreatment}' — such a row carries no VAT. Set the treatment to 'S' (or clear it) to record VAT.`,
      );
    }

    // Audit Tier 2 (finding F8): only a change to the row's TAX FACTS claims
    // the human-override marker — it gates the "assumed" hint and bulk-accept
    // eligibility, and a notes-only edit asserts neither.
    const touchesTaxFacts =
      data.categoryId !== undefined || data.vatAmount !== undefined || data.vatRate !== undefined ||
      data.taxTreatment !== undefined || data.vatBasis !== undefined;
    const updates: Partial<typeof transactionsTable.$inferInsert> = touchesTaxFacts
      ? { isManuallyOverridden: true }
      : {};

    // Audit Tier 3: assigning a category to a TRANSFER is the human asserting
    // it is operating after all — so the kind follows, or the row would show a
    // category while staying excluded from every figure the user believes it
    // now appears in (the invisible half of the old "Uncategorized" rendering).
    if (existing.tx.kind === "transfer" && data.categoryId != null) {
      updates.kind = "operating";
    }
    if (data.categoryId !== undefined) updates.categoryId = data.categoryId ?? null;

    /**
     * 🔴 Audit finding #3: A HUMAN'S CATEGORY MUST MEAN WHAT THE ENGINE'S MEANS.
     *
     * Only the categorizer stamped `tax_treatment` and extracted VAT. A row
     * categorised by hand kept `treatment = null, vat = null` — so the VAT
     * reconciliation depended on HOW a row got its category, not on what it
     * is. And the review surface exists precisely so humans categorise what
     * the engine could not, which means every hand-classified row contributed
     * zero to the figure that is supposed to show cash-side VAT.
     *
     * Assigning a category now applies that category's default treatment and
     * the same extraction rule (`vatFromGross`, never rate-on-gross), unless
     * the same request states the treatment explicitly. Clearing the category
     * clears the treatment with it — a treatment with nothing behind it is the
     * conflation M16.2 removed.
     */
    if (data.categoryId !== undefined && data.taxTreatment === undefined) {
      if (data.categoryId == null) {
        updates.taxTreatment = null;
        if (data.vatAmount === undefined) {
          updates.vatAmount = null;
          updates.vatRate = null;
        }
      } else {
        const cat = await categoriesRepository.findById(data.categoryId);
        const treatment = cat?.defaultTaxTreatment ?? null;
        updates.taxTreatment = treatment;
        // Flaw #6: keep the basis coherent with the treatment. A row that is
        // no longer standard-rated cannot have a "VAT was charged" basis.
        // The basis must not depend on HOW the row got its category (flaw #3's
        // lesson): a foreign supplier categorised by hand is still a foreign
        // supplier, so the detector runs here too rather than only in the
        // engine.
        const basis =
          data.vatBasis !== undefined
            ? (data.vatBasis ?? null)
            : treatment === "S"
              ? (existing.tx.vatBasis ??
                 (looksForeignDigitalSupplier(existing.tx.description) ? "reverse_charge" : "charged"))
              : null;
        updates.vatBasis = basis;
        if (data.vatAmount === undefined) {
          if (treatment === "S" && basis === "charged") {
            // Only extract when the row does not already carry a VAT figure —
            // an engine-extracted or user-entered amount is not overwritten.
            if (existing.tx.vatAmount == null) {
              updates.vatAmount = String(vatFromGross(Number(existing.tx.amount), 15));
              updates.vatRate = "15";
            }
          } else {
            // Z/E/O (or unknown): no VAT can exist on this row. Without this
            // the DB CHECK (migration 0034) would reject the write outright.
            updates.vatAmount = null;
            updates.vatRate = null;
          }
        }
      }
    }

    if (data.vatAmount !== undefined) updates.vatAmount = data.vatAmount != null ? String(data.vatAmount) : null;
    if (data.vatRate !== undefined) updates.vatRate = data.vatRate != null ? String(data.vatRate) : null;
    // M16.3.1 — per-row treatment override (the export-sale case; correcting an
    // assumed default). The VAT consequence travels WITH the treatment so the
    // two facts cannot disagree: non-'S' rows carry zero VAT and say why; 'S'
    // with no explicit VAT extracts from the gross amount (never applies to it).
    /**
     * Flaw #6 — an explicit basis override, the human's answer to "did this
     * payment actually carry VAT?". Setting anything other than `charged`
     * clears the VAT; setting it back to `charged` on a standard-rated row
     * re-extracts from the gross amount. This is the control that fixes a
     * wrongly-guessed foreign supplier in either direction.
     */
    if (data.vatBasis !== undefined && data.categoryId === undefined) {
      const basis = data.vatBasis ?? null;
      updates.vatBasis = basis;
      const treatment = data.taxTreatment !== undefined ? data.taxTreatment : existing.tx.taxTreatment;
      if (basis !== "charged") {
        updates.vatAmount = null;
        updates.vatRate = null;
      } else if (treatment === "S" && data.vatAmount === undefined && existing.tx.vatAmount == null) {
        updates.vatAmount = String(vatFromGross(Number(existing.tx.amount), 15));
        updates.vatRate = "15";
      }
    }

    if (data.taxTreatment !== undefined) {
      updates.taxTreatment = data.taxTreatment ?? null;
      if (data.taxTreatment != null && data.taxTreatment !== "S") {
        // Z/E/O: zero VAT, and the row says why. The basis goes with it —
        // "VAT was charged" is meaningless on a non-standard-rated supply.
        updates.vatAmount = null;
        updates.vatRate = null;
        updates.vatBasis = null;
      } else if (data.taxTreatment === "S" && data.vatAmount === undefined && existing.tx.vatAmount == null) {
        updates.vatAmount = String(vatFromGross(Number(existing.tx.amount), 15));
        updates.vatRate = "15";
      }
      // Explicit null = honest-unknown: existing/asserted VAT is kept — a user
      // clearing the classification is not asserting the VAT was wrong.
    }
    /**
     * B5 — the human declaring WHERE a transfer went.
     *
     * 🔴 Only a transfer may carry it, and clearing it returns the row to
     * UNDECLARED rather than to a default. `null` here means "I do not know" —
     * the same first-class unknown as M17.1's ownership and the fiscal year.
     * The DB CHECKs (migration 0043) are the real boundary; these are the
     * named 400s so a mistake is diagnosable instead of a raw constraint error.
     */
    if (data.transferDirection !== undefined) {
      const dir = data.transferDirection ?? null;
      if (existing.tx.kind !== "transfer") {
        throw new BadRequestError(
          "Only a transfer can say where the money went. Change the row's kind first.",
        );
      }
      if (dir !== null && dir !== "own_account" && dir !== "external") {
        throw new BadRequestError("transferDirection must be own_account, external or null.");
      }
      updates.transferDirection = dir;
      // A counterparty means nothing once the money is declared to have left,
      // so it goes with the declaration rather than being left to contradict it.
      if (dir !== "own_account") updates.counterpartyBankAccountId = null;
    }
    if (data.counterpartyBankAccountId !== undefined) {
      const accountId = data.counterpartyBankAccountId ?? null;
      if (accountId != null) {
        const declared = data.transferDirection ?? existing.tx.transferDirection;
        if (declared !== "own_account") {
          throw new BadRequestError(
            "A destination account can only be recorded for a transfer between your own accounts.",
          );
        }
        if (accountId === existing.tx.bankAccountId) {
          throw new BadRequestError("A transfer's destination cannot be the account it left.");
        }
        const [account] = await bankAccountsRepository.findById(accountId);
        if (!account) throw new BadRequestError("That bank account does not exist.");
      }
      updates.counterpartyBankAccountId = accountId;
    }
    if (data.notes !== undefined) updates.notes = data.notes ?? null;
    if (data.descriptionAr !== undefined) updates.descriptionAr = data.descriptionAr ?? null;

    // A notes-less, fact-less PATCH has nothing to write (pre-fix the override
    // stamp made every update non-empty; see F8 above).
    if (Object.keys(updates).length > 0) await transactionsRepository.update(id, updates);

    /**
     * 🔴 Flaw #1 (Option A): an edit to a POSTED row must reach the ledger.
     *
     * Reverse-and-repost, never an in-place update: a posted entry is
     * immutable and the reversal is what keeps the audit trail honest. Only
     * changes that alter the POSTING matter — the account (category) or the
     * classification — so a notes-only edit posts nothing. Without this, a
     * user correcting a miscategorised expense would fix the dashboard and
     * leave the P&L wrong, which is the very divergence this milestone closes.
     */
    const postingChanged = data.categoryId !== undefined;
    if (postingChanged && existing.tx.journalEntryId != null) {
      await transactionPostingService.repost(id);
    }

    const [row] = await transactionsRepository.findWithCategory(id);
    if (!row) throw new AppError(500, "Update failed");
    await auditService.updated("transaction", id, existing.tx, row.tx);
    return UpdateTransactionResponse.parse(buildTransactionRow(row.tx, row.cat));
  },

  async remove(id: number) {
    const [existing] = await transactionsRepository.findWithCategory(id);
    // 🔴 Audit Tier 2 (finding 5): a settlement row is the BANK-SIDE record of
    // a payment that was actually posted (document paidAmount + GL Dr/Cr).
    // Deleting it would leave the payment standing while cash flow loses the
    // movement — and the row would drop out of the duplicate key, so re-
    // uploading the statement re-imports the line, which could then be settled
    // against a SECOND document: two recorded payments from one bank movement.
    if (existing?.tx.kind === "settlement") {
      throw new ConflictError(
        "This transaction settles an invoice/bill and is the bank-side record of that payment. It cannot be deleted while the payment stands.",
      );
    }
    await transactionsRepository.remove(id);
    if (existing) await auditService.deleted("transaction", id, existing.tx);
  },
};
