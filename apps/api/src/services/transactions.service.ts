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
  AcceptPendingTransactionsResponse,
} from "@workspace/api-zod";
import { AppError, BadRequestError, BankAccountRequiredError, BusinessRuleError, ConflictError, NotFoundError, PeriodLockedError } from "../lib/errors";
import { bankAccountsRepository } from "../repositories/bankAccounts.repository";
import { assertBankAccount } from "./accounting/bankIdentity";
import { bankStatementsService } from "./accounting/bankStatements.service";
import { bankReconciliationRepository } from "../repositories/bankReconciliation.repository";
import { bankReconciliationsRepository } from "../repositories/bankReconciliations.repository";
import { MATCH_DATE_WINDOW_DAYS } from "./accounting/matchingPolicy";
import { auditService } from "./audit.service";
import { categorizeTransaction, allEngineCodes, looksForeignDigitalSupplier } from "./categorization/categorizer.js";
import { AUTO_ASSIGN_CONFIDENCE, resolveSystemCodes, vatFromGross, type ResolvedCategory } from "./categorization/resolveCategory.js";
import { PARTY_REQUIRED_SYSTEM_CODES } from "@workspace/shared";

/** A row-failure reason safe to show a user — never the driver's SQL dump. */
function reasonFor(err: unknown): string {
  // A refusal WE wrote (a 422 from the category guard) already reads as a sentence.
  if (err instanceof BusinessRuleError) return ` — ${err.message}`;
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
import { journalEntriesService } from "./journalEntries.service";
import type { transactionsTable, categoriesTable } from "@workspace/db";

/**
 * MED (audit 2026-08-20): the SINGLE create path let a nonexistent categoryId
 * reach the FK as a raw 23503 500 while the BULK path mapped it — "green fixed
 * the case, not the class". Tenant-scoped lookup (the FK check itself runs
 * outside RLS, so it would accept another tenant's id); 422 per the status
 * policy (2026-08-23) — semantically invalid input that passed schema
 * validation.
 */
async function assertCategoryExists(categoryId: unknown): Promise<void> {
  if (categoryId == null) return;
  const cat = await categoriesRepository.findById(Number(categoryId));
  if (!cat) {
    throw new BusinessRuleError(422, {
      error: `Category ${categoryId} does not exist for this organization.`,
      code: "reference_not_found",
      field: "categoryId",
    });
  }
  // 🔴 A bank row cannot be categorised to a CONTROL account (2026-09-16, the
  // pre-pilot sanity walk). The picker offered Accounts Receivable for
  // "CUSTOMER DEPOSIT — NAJD"; the posting seam then refused the party-less
  // AR line — correctly — as a 500 with a developer message. The refusal
  // belongs HERE, at the write boundary every writer of `category_id` passes
  // (create, update, upload), as a 422 that names the workflow: a customer
  // or supplier movement is an invoice or bill payment, settled from Review.
  /**
   * 🔴 D-3 (2026-09-17): a bank's OWN cash account is not a category. A bank
   * row categorised to a bank leaf would post cash against cash — a transfer
   * expressed as a classification, bypassing the declared-direction rule
   * transfers post by (kind = transfer). Refused with the same shape as the
   * control-account rule; the picker hides leaves too.
   */
  if (cat.bankAccountId != null) {
    throw new BusinessRuleError(422, {
      error: `${cat.name} is a bank account's own cash account and cannot be a bank transaction's category. Money moving between your accounts is a transfer — mark the row's kind as transfer and declare where it went.`,
      code: "category_is_bank_account",
      field: "categoryId",
    });
  }
  if (cat.systemCode && (PARTY_REQUIRED_SYSTEM_CODES as readonly string[]).includes(cat.systemCode)) {
    throw new BusinessRuleError(422, {
      error:
        `${cat.name} is a customer/supplier control account and cannot be a bank transaction's category. ` +
        `A payment from a customer or to a supplier belongs to their invoice or bill — accept the row with ` +
        `"Accept & settle" on the Review page, or leave it uncategorised (Suspense) until the document exists.`,
      code: "category_needs_party",
      field: "categoryId",
    });
  }
}

type Tx = typeof transactionsTable.$inferSelect;
type Cat = typeof categoriesTable.$inferSelect;

/**
 * A row acceptance refused — by the period lock, or (D-3) because the row
 * names no bank account — back in review, named to the caller.
 */
export interface AcceptPendingRejection {
  id: number;
  date: string | null;
  reason: string;
  code: "period_closed" | "bank_account_required";
  period: string | null;
  lockedAt: string | null;
}
/** The wire shape — parsed through the generated contract before it leaves. */
export type AcceptPendingOutcome = ReturnType<(typeof AcceptPendingTransactionsResponse)["parse"]>;
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

  async upload(data: UploadTransactionsInput, userId: number | null = null) {
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
    /**
     * Per duplicate-key state for THIS upload: how many identical rows the
     * account already held when the upload began, and how many this file has
     * presented so far. See the multiplicity note at the check below.
     */
    const seenByKey = new Map<string, { alreadyHeld: number; seen: number }>();
    let inserted = 0;
    let categorized = 0;

    // M16.2 — which bank account is this statement from? RLS scopes the lookup,
    // so another tenant's id simply does not resolve. Fail closed on an unknown
    // id rather than silently importing unattributed rows.
    // 🔴 D-3 (2026-09-16): REQUIRED. An accepted row's cash leg posts to this
    // bank's own GL account, so a statement that names no bank would import
    // rows nothing can ever accept. 422 `bank_account_required` /
    // `reference_not_found` — one shared check (accounting/bankIdentity.ts).
    const bankAccountId: number = await assertBankAccount(data.bankAccountId, { what: "this statement belongs to" });

    // 🔴 Phase 12D: a completed bank reconciliation fixes this bank's lines
    // through its date — a line dated inside it would change what it proved.
    // Refused whole and in words here; the trigger on `transactions` is the
    // boundary for every other writer.
    const reconciledThrough = await bankReconciliationsRepository.reconciledThrough(bankAccountId);
    if (reconciledThrough) {
      const inside = rows.filter((r) => typeof r.date === "string" && r.date.slice(0, 10) <= reconciledThrough);
      if (inside.length > 0) {
        throw new BusinessRuleError(409, {
          code: "bank_reconciled_through",
          error: `This bank is reconciled through ${reconciledThrough}; ${inside.length} line(s) are dated on or before it. Reopen that reconciliation first, or import only later lines.`,
        });
      }
    }

    /**
     * 🔴 Phase 12A — a STATEMENT upload is all or nothing. Every row is
     * validated, the period and the stated balances checked, and a re-imported
     * file refused, BEFORE the first line is written (bankStatements.service).
     * Each line then carries the statement it came from. Without a statement
     * block the upload behaves as it always has (per-row errors).
     */
    const statement = data.statement
      ? await bankStatementsService.record(await bankStatementsService.prepare(bankAccountId, data.statement, rows), userId)
      : null;

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
        /**
         * M15: an identical row is skipped and REPORTED — uploading the same
         * statement twice used to double every figure in the dashboard, VAT
         * summary and Zakat base, silently. M16.2 scoped the key to the account.
         *
         * 🔴 2026-08-28 — BY MULTIPLICITY, NOT BY EXISTENCE. The old test asked
         * "does an identical row exist?", which cannot distinguish a re-uploaded
         * statement from a statement that genuinely lists the same charge twice
         * — two taxi fares, two identical fees, two identical transfers on one
         * day. It answered both with "skip", so the second REAL charge never
         * entered the books and the expense (and its input VAT) was understated
         * by exactly that amount. The comment above `duplicates` had already
         * named the conflation and mitigated it by RETURNING the dropped rows —
         * but no UI reads that field, so the mitigation had no consumer and the
         * loss was silent.
         *
         * The rule now: import as many copies as this file carries MINUS as many
         * as the account already holds. Re-upload ⇒ nothing imported. A real
         * repeat ⇒ every copy imported. `alreadyHeld` is read ONCE per distinct
         * key (before this run inserts anything) and `seen` counts occurrences
         * within the file, so the arithmetic is not disturbed by our own inserts.
         */
        const dupKey = `${row.date}|${row.description}|${String(row.amount)}|${row.type}|${bankAccountId ?? "-"}`;
        let seenState = seenByKey.get(dupKey);
        if (!seenState) {
          seenState = {
            alreadyHeld: await transactionsRepository.countIdentical({
              date: row.date,
              description: row.description,
              amount: String(row.amount),
              type: row.type,
              bankAccountId,
            }),
            seen: 0,
          };
          seenByKey.set(dupKey, seenState);
        }
        seenState.seen += 1;
        if (seenState.seen <= seenState.alreadyHeld) {
          duplicates.push({ date: row.date, description, amount: Number(row.amount) });
          continue;
        }

        let catId: number | null = row.categoryId ?? null;
        if (catId != null) await assertCategoryExists(catId);
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
          bankStatementId: statement?.id ?? null,
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

    // A statement is whole or not at all: a row that failed at insert (after
    // validation passed) rolls the whole import back, statement included.
    if (statement && errors.length > 0) {
      throw new BusinessRuleError(422, {
        code: "statement_rows_invalid",
        error: `The statement was not imported — ${errors.length} line(s) could not be. A statement is imported whole or not at all.`,
        problems: errors,
      });
    }

    if (inserted > 0) {
      // Bulk import → one summary audit record (not one per row).
      await auditService.record({
        action: "create",
        entityType: "transaction",
        entityId: "bulk",
        after: { inserted, categorized, bankStatementId: statement?.id ?? null },
      });
    }
    if (statement) {
      await auditService.created("bank_statement", statement.id, statement);
    }
    return UploadTransactionsResponse.parse({
      statement: statement ? await bankStatementsService.get(statement.id) : null,
      inserted,
      categorized,
      duplicatesSkipped: duplicates.length,
      duplicates,
      errors,
    });
  },

  /** Pending imported rows — the holding-area review surface. */
  /**
   * Counts over the FULL pending set (SQL), for callers that want a number
   * rather than rows. Never derive a count from `pendingReview().length` — that
   * list is capped and the count would silently saturate.
   */
  async pendingReviewCounts() {
    return transactionsRepository.pendingReviewCounts(AUTO_ASSIGN_CONFIDENCE);
  },

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
  async acceptPending(ids?: number[]): Promise<AcceptPendingOutcome> {
    // 12B: naming a reconciled line is refused in words, not silently skipped.
    if (ids?.length) {
      // Only lines another record answers: a line that posted its OWN entry is
      // already accepted, and naming it again stays the idempotent no-op it was.
      const reconciled = await bankReconciliationRepository.reconciledIds(ids, { byAnotherRecord: true });
      if (reconciled.size > 0) {
        throw new BusinessRuleError(409, {
          code: "line_reconciled",
          error: `Statement line(s) ${[...reconciled].join(", ")} are already reconciled to a recorded payment, refund or entry. Accepting would post the same money again — undo the reconciliation first if it is wrong.`,
          ids: [...reconciled],
        });
      }
    }
    // 12C: the open leg of a RECORDED transfer is refused in words too — it is
    // reconciled to the transfer in the workbench, never accepted.
    if (ids?.length) {
      const legs = await bankReconciliationRepository.openTransferLegIds(ids, MATCH_DATE_WINDOW_DAYS);
      if (legs.size > 0) {
        throw new BusinessRuleError(409, {
          code: "line_is_recorded_transfer_leg",
          error: `Statement line(s) ${[...legs].join(", ")} are a leg of a transfer already recorded between your banks. Reconcile them to that transfer in the Reconciliation Workbench — accepting would move the money twice.`,
          ids: [...legs],
        });
      }
    }
    const result = await transactionsRepository.acceptPending({
      ids,
      minConfidence: AUTO_ASSIGN_CONFIDENCE,
      transferWindowDays: MATCH_DATE_WINDOW_DAYS,
    });

    /**
     * 🔴 Flaw #1 (Option A): ACCEPTANCE POSTS TO THE LEDGER.
     *
     * Runs inside the same tenant transaction as the acceptance, so a row can
     * never be accepted-but-unposted. Before this, accepted bank lines reached
     * the dashboard and never the income statement — one live SME month showed
     * 0.00 of expenses on the P&L beside 45,063.25 on the dashboard.
     *
     * 🔴 A REFUSED ROW IS NOT ACCEPTED (2026-09-16, the pre-pilot batch). The
     * first version of this handed the ids to `postMany`, which caught EVERY
     * failure per row and returned a list nothing read: a row dated in a
     * closed month committed as accepted with no entry, the request said
     * 200, and the closed-month dialog never fired — the accepted-but-unposted
     * state this comment promised could not happen, reached through the one
     * path that swallowed it. Now, per row:
     *
     *  - the period lock (`PeriodLockedError`, thrown by `checkPeriodOpen`
     *    BEFORE the seam writes anything, so the transaction stays usable)
     *    puts the row BACK to pending and is reported under `rejected` with
     *    its structured code — a mixed batch names both halves;
     *  - anything else (an incomplete chart, an unbalanced line, a driver
     *    error) is RE-THROWN: the request fails and the tenant transaction
     *    rolls the whole acceptance back. Partial silence is the defect.
     *
     * If NOTHING was accepted and something was refused, the request IS the
     * 423 — so a single row's Accept, and a bulk whose every row is closed,
     * reach the client the way every other closed-month write does (the
     * dialog keys on the code). The rejected list rides in the payload.
     */
    const rejected: AcceptPendingRejection[] = [];
    let posted = 0;
    const acceptedIds: number[] = [];
    for (const id of result.acceptedIds) {
      try {
        if (await transactionPostingService.post(id)) posted++;
        acceptedIds.push(id);
      } catch (err) {
        // 🔴 D-3 (2026-09-16): a row with NO BANK is refused the same way a
        // closed month is — put back to pending, reported with its code,
        // never accepted-but-unposted. Both are thrown by the seam's callers
        // BEFORE any write, so the tenant transaction stays usable.
        const isLock = err instanceof PeriodLockedError;
        const isBank = err instanceof BankAccountRequiredError;
        if (!isLock && !isBank) throw err;
        await transactionsRepository.revertAcceptance(id);
        const [row] = await transactionsRepository.findWithCategory(id);
        const detail = (err.payload ?? {}) as { period?: string; lockedAt?: string };
        rejected.push({
          id,
          date: row?.tx.date ?? null,
          reason: err.message,
          code: isLock ? "period_closed" : "bank_account_required",
          period: isLock ? (detail.period ?? null) : null,
          lockedAt: isLock ? (detail.lockedAt ?? null) : null,
        });
      }
    }

    if (acceptedIds.length === 0 && rejected.length > 0) {
      const first = rejected[0];
      if (first.code === "bank_account_required") {
        throw new BankAccountRequiredError(first.reason, "bankAccountId", { rejected });
      }
      throw new PeriodLockedError(first.reason, {
        period: first.period ?? "",
        lockedAt: first.lockedAt ?? "",
        rejected,
      });
    }

    if (acceptedIds.length > 0) {
      await auditService.record({
        action: "update",
        entityType: "transaction",
        entityId: "bulk-accept",
        after: {
          accepted: acceptedIds.length,
          mode: ids?.length ? "explicit" : "bulk",
          posted,
          rejected: rejected.length,
          rejectedIds: rejected.map((r) => r.id),
        },
      });
    }
    return AcceptPendingTransactionsResponse.parse({ accepted: acceptedIds.length, posted, rejected });
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
    await assertCategoryExists(d.categoryId);
    // 🔴 D-3: a manual row is accepted AND POSTED on creation, so it must name
    // the bank its cash leg posts to — refused here (422) before the insert,
    // the same rule the seam and the DB trigger enforce beneath.
    const bankAccountId = await assertBankAccount(d.bankAccountId, { what: "this movement belongs to" });
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
      bankAccountId,
    });
    await auditService.created("transaction", tx.id, tx);

    // 🔴 A MANUAL ROW POSTS LIKE AN IMPORTED ONE (2026-09-15, workflow audit
    // W7 B3). This path inserted the row as accepted and returned; only
    // `acceptPending` called the posting seam, so a hand-typed row appeared in
    // the transactions list and never in the ledger. Same seam, same rules:
    // `post` derives the lines, numbers the entry, enforces the period lock
    // and balance through `postJournalEntry`, and links the row — inside this
    // request's tenant transaction, so a refused post (a closed month, an
    // unbalanced line) rolls the INSERT back with it and the caller sees the
    // error, never an accepted-but-unposted row. Unlike bulk accept, a single
    // row does not swallow the failure.
    await transactionPostingService.post(tx.id);

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

    // 🔴 12B: a MATCHED line is the bank-side record of money another record
    // posted. Only its notes and Arabic description may change; anything that
    // would post it (a category, a transfer declaration) or change what the
    // bank said is refused — undo the reconciliation instead.
    if (existing.tx.kind === "matched") {
      const allowed = new Set(["notes", "descriptionAr"]);
      const touched = Object.keys(data).filter((k) => (data as Record<string, unknown>)[k] !== undefined && !allowed.has(k));
      if (touched.length > 0) {
        throw new BusinessRuleError(409, {
          code: "line_reconciled",
          error: `This statement line is reconciled to a recorded payment, refund or entry — ${touched.join(", ")} cannot be changed here. Undo the reconciliation first.`,
        });
      }
    }

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
    if (data.categoryId !== undefined) {
      await assertCategoryExists(data.categoryId);
      updates.categoryId = data.categoryId ?? null;
    }

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
        if (!account) {
          throw new BusinessRuleError(422, {
            error: "That bank account does not exist.",
            code: "reference_not_found",
            field: "counterpartyBankAccountId",
          });
        }
      }
      updates.counterpartyBankAccountId = accountId;
    }
    if (data.notes !== undefined) updates.notes = data.notes ?? null;
    if (data.descriptionAr !== undefined) updates.descriptionAr = data.descriptionAr ?? null;

    /**
     * 🔴 D-3 (2026-09-16): recording WHICH bank a row belongs to.
     *
     * A bank is a fact about the movement, not a classification to revise,
     * so it is settable only while the row has none — the remediation path
     * for history imported or typed before a bank was required, and the one
     * the cash cut-over's dry-run names for an AMBIGUOUS transaction line.
     * Changing an already-named bank is refused (409): that is a different
     * movement, entered as one.
     *
     * Whether the ledger moves depends on WHERE the row's cash sits:
     *   - never posted → nothing to move; `acceptPending` posts it later;
     *   - posted to the "Cash and Bank" HEADER (pre-cut-over history) →
     *     nothing moves now; the cut-over remaps the line to this bank's
     *     leaf, because the transaction now carries the deterministic link;
     *   - posted to a bank LEAF cannot happen here (a leaf posting requires a
     *     bank, and a bank cannot be changed) — recorded for completeness.
     */
    if (data.bankAccountId !== undefined) {
      if (existing.tx.bankAccountId != null) {
        if (data.bankAccountId !== existing.tx.bankAccountId) {
          throw new ConflictError(
            "This transaction already names its bank account. A movement through a different account is a different transaction — enter it as one.",
          );
        }
      } else {
        updates.bankAccountId = await assertBankAccount(data.bankAccountId, { what: "this movement belongs to" });
      }
    }

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
    // A — GL owns cash: a transfer's DIRECTION now decides its posting (the
    // clearing / external / transfer-suspense offset), so a declaration is a
    // posting change too. And no `journalEntryId != null` guard: `repost`
    // reverses only when an entry exists and then re-checks `shouldPost`, so
    // it both moves a posted balance (suspense → clearing on declaration)
    // and posts a row that had never posted.
    // D-3: naming the bank is NOT a posting change — a never-posted row is
    // posted by `acceptPending`, and a header-era posting is remapped by the
    // cut-over. (A category/direction change on a row with no bank now fails
    // closed at the re-post, rolling the whole edit back: set the bank in the
    // same request.)
    const postingChanged = data.categoryId !== undefined || data.transferDirection !== undefined;
    if (postingChanged) {
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
    // 12B: a line with ANY reconciliation (matched, or partly linked) is the
    // bank-side record of money the ledger holds; deleting it would orphan the
    // reconciliation. Undo the reconciliation first.
    if (existing && existing.tx.journalEntryId == null && (await bankReconciliationRepository.reconciledIds([id])).has(id)) {
      throw new BusinessRuleError(409, {
        code: "line_reconciled",
        error: "This statement line is reconciled to a recorded payment, refund or entry. Undo the reconciliation before deleting the line.",
      });
    }
    // 🔴 A POSTED ROW IS REVERSED BEFORE IT IS DELETED (2026-09-15, workflow
    // audit W5 G1 / W7 B4). This path deleted an accepted-and-posted row and
    // the FK nulled the link, leaving its journal entry in the books with
    // nothing pointing at it: the P&L kept the expense, ledger cash stayed
    // reduced, and the cash reconciliation folded the orphan into a residual
    // so it read as explained. The same seam the edit path uses (reverse,
    // then re-post) is used here without the re-post: the original stays in
    // the books as the trail, its mirror cancels it, and the delete follows in
    // the same tenant transaction — a refused reversal (a closed month) rolls
    // the delete back with it.
    if (existing?.tx.journalEntryId != null) {
      await journalEntriesService.reverse(existing.tx.journalEntryId, {}, { document: "statement_line" });
    }
    await transactionsRepository.remove(id);
    if (existing) await auditService.deleted("transaction", id, existing.tx);
  },
};
