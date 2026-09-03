/**
 * Journal entries service — draft creation (balanced), approval (post to GL),
 * rejection, reversal, and delete.
 *
 * M10.2: the draft→approval transitions (`approve` / `reject`) are delegated to
 * the generic {@link approvalService} via the {@link journalEntryApprovable}
 * adapter — the SAME seam every financial entity will reuse. Approval fires the
 * JE's existing post-to-GL activation (period-lock check → `status: posted`,
 * `postedAt` stamped); nothing about the accounting core changed. `post` is kept
 * as the JE-native alias for `approve` (the frontend and existing API call it).
 *
 * Balancing, immutability guards, and reversal are preserved exactly.
 */
import { ConflictError, NotFoundError, BusinessRuleError } from "../lib/errors";
import { documentNumbersRepository } from "../repositories/documentNumbers.repository";
import { BadRequestError } from "../lib/errors";
import { pick, assertAmount, assertDateString } from "../lib/writeGuards";
import { checkPeriodOpen } from "./accounting/periodLock";
import { GL_BALANCE_TOLERANCE } from "./accounting/glPosting";
import { auditService } from "./audit.service";
import { approvalService } from "./approval";
import { journalEntryApprovable } from "./journalEntries.approvable";
import { buildJEOut } from "./journalEntries.presenter";
import { journalEntriesRepository, DEFAULT_PAGE as JE_PAGE } from "../repositories/journalEntries.repository";
import type { journalEntriesTable } from "@workspace/db";

export const journalEntriesService = {
  /** A PAGE of entries, plus the count for the whole filtered set. */
  async list(filter: { status?: string; limit?: number; offset?: number } = {}) {
    const [rows, meta] = await Promise.all([
      journalEntriesRepository.list(filter),
      journalEntriesRepository.listMeta(filter),
    ]);
    // Each row's OWN totals, aggregated from its lines — never zero because the
    // lines were not loaded (see lineTotals). Lines themselves stay off the
    // list; the detail endpoint carries them.
    const totals = await journalEntriesRepository.lineTotals(rows.map((r) => r.id));
    return {
      items: rows.map((r) => ({ ...buildJEOut(r), ...(totals.get(r.id) ?? { totalDebit: 0, totalCredit: 0 }) })),
      page: { limit: filter.limit ?? JE_PAGE, offset: filter.offset ?? 0, total: meta.total },
    };
  },

  async getById(id: number) {
    const [je] = await journalEntriesRepository.findById(id);
    if (!je) throw new NotFoundError("Not found");
    const lines = await journalEntriesRepository.linesByEntry(id);
    return buildJEOut(je, lines);
  },

  async create(body: Record<string, unknown>, userId: number | null) {
    const { lines = [] } = body as { lines?: unknown[] };
    // 🔴 H1 — ALLOWLIST, not a raw spread. `status`/`postedAt`/`reversalOf`
    // can NEVER come from the client: a POST with `{status:"posted"}` used to
    // bypass approval straight into every report. The entry is always a draft;
    // posting is the approval transition.

    /**
     * 🔴 Server-allocated when the caller leaves it blank — the AUD-1 fix,
     * swept to the documents it originally missed.
     *
     * The browser used to mint `JE-${Date.now().toString().slice(-6)}`, which
     * wraps every ~16.7 minutes onto a column with NO unique index: a collision
     * produced two financial records claiming to be the same document, and
     * nothing refused it. A caller-supplied number is still honoured (legacy
     * imports and a user who types their own); blank is what asks the server.
     */
    if (!String(body.entryNumber ?? "").trim()) {
      body.entryNumber = await documentNumbersRepository.allocate("journal_entry");
    }

    const jeData = pick<{ entryNumber: string; date: string; description: string; reference: string; notes: string }>(
      body,
      ["entryNumber", "date", "description", "reference", "notes"],
    );

    // 🔴 H2 — validate each line amount BEFORE the balance check. A non-numeric
    // amount made `Math.abs(NaN - NaN) > 0.01` false, so garbage PASSED the
    // balance check and posted to the GL (or died as a raw 500). Amounts are
    // non-negative (direction is debit vs credit, not a sign); DB CHECK 0049
    // is the backstop.
    const parsedLines = (lines as any[]).map((l, i) => ({
      accountId: l.accountId as number | null,
      accountName: String(l.accountName ?? ""),
      description: (l.description ?? null) as string | null,
      debitAmount: assertAmount(l.debitAmount ?? 0, `line ${i + 1} debit`),
      creditAmount: assertAmount(l.creditAmount ?? 0, `line ${i + 1} credit`),
    }));

    const totalDebit = parsedLines.reduce((s, l) => s + l.debitAmount, 0);
    const totalCredit = parsedLines.reduce((s, l) => s + l.creditAmount, 0);
    // 🔴 The tolerance is IMPORTED, not restated. This gate used to refuse at
    // `> 0.01` while the GL's own guard refuses at `> 0.005` — one invariant,
    // two numbers, the user-facing one LOOSER than the ledger's. See
    // GL_BALANCE_TOLERANCE for what that gap was and why it stayed latent.
    if (Math.abs(totalDebit - totalCredit) > GL_BALANCE_TOLERANCE) {
      /**
       * 🔴 422, not 400 — the status policy (2026-08-23): 400 is a SCHEMA
       * failure, 422 is input that parsed cleanly and is semantically invalid.
       * Every line here is a well-formed number; they simply do not balance,
       * which is exactly the 422 case. It answered 400 only because it predates
       * the policy.
       *
       * The message now carries both totals and the difference, because "must
       * balance" without them makes the user hunt for a discrepancy the server
       * has already computed.
       */
      const difference = Math.round((totalDebit - totalCredit) * 100) / 100;
      throw new BusinessRuleError(422, {
        error:
          `Journal entry must balance: debits (${totalDebit.toFixed(2)}) must equal ` +
          `credits (${totalCredit.toFixed(2)}). Difference: ${difference.toFixed(2)}.`,
        code: "journal_entry_unbalanced",
        field: "lines",
      });
    }

    // 🔴 M13: every line must name an account. This is a BEHAVIOURAL CHANGE.
    //
    // A line with no `accountId` cannot be classified: the income statement and
    // balance sheet bucket by the account's TYPE, so an accountless line is
    // invisible to both — which is exactly the defect M13 exists to remove, just
    // reached from the manual side instead of the automated one. Leaving manual
    // entries optional would preserve the hole in a different place.
    //
    // Existing rows are unaffected (migration 0024 back-fills what it can and
    // leaves the rest); this applies to NEW entries only.
    const missingAccount = parsedLines.findIndex((l) => l.accountId == null);
    if (missingAccount >= 0) {
      throw new BadRequestError(
        `Journal entry line ${missingAccount + 1} has no account. Every line must post to an ` +
          "account, otherwise it cannot appear on the income statement or balance sheet.",
      );
    }

    if (jeData.date) assertDateString(jeData.date, "date");
    if (jeData.date) await checkPeriodOpen(jeData.date as string);

    let je: typeof journalEntriesTable.$inferSelect;
    try {
      [je] = await journalEntriesRepository.insertEntry({
        ...(jeData as typeof journalEntriesTable.$inferInsert),
        createdBy: userId ?? null,
      });
    } catch (err) {
      // N3: unique(company_id, entry_number) — a user-supplied duplicate is
      // the user's to fix, so it answers as a 409 naming the number, not a
      // raw 23505 surfacing as a 500.
      // drizzle wraps the pg error; the SQLSTATE lives on the cause.
      const code = (err as { code?: string }).code ?? ((err as { cause?: { code?: string } }).cause?.code);
      if (code === "23505") {
        throw new ConflictError(`Entry number ${String(jeData.entryNumber)} is already used in this company.`);
      }
      throw err;
    }
    const savedLines =
      parsedLines.length > 0
        ? await journalEntriesRepository.insertLines(
            parsedLines.map((l) => ({
              ...l,
              journalEntryId: je.id,
              debitAmount: l.debitAmount.toFixed(2),
              creditAmount: l.creditAmount.toFixed(2),
            })),
          )
        : [];
    const out = buildJEOut(je, savedLines);
    await auditService.created("journal_entry", je.id, out);
    return out;
  },

  /**
   * Approve a draft journal entry — the workflow transition that posts it to the
   * GL. Runs through the generic approval seam; the JE adapter performs the
   * period-lock check and status flip. `post` is the JE-native alias.
   */
  approve(id: number, userId: number | null) {
    return approvalService.approve(journalEntryApprovable, id, { userId: userId ?? null });
  },

  /** JE-native alias for {@link approve} (POST /:id/post). */
  post(id: number, userId: number | null) {
    return this.approve(id, userId);
  },

  /**
   * Reject a pending draft — hard-deletes it (no archive, spec §4). Only a draft
   * can be rejected; a posted/reversed entry must be reversed, not rejected.
   */
  reject(id: number, userId: number | null) {
    return approvalService.reject(journalEntryApprovable, id, { userId: userId ?? null });
  },

  async reverse(id: number) {
    const [original] = await journalEntriesRepository.findById(id);
    if (!original) throw new NotFoundError("Not found");
    if (original.status !== "posted") throw new ConflictError("Only posted entries can be reversed.");

    const lines = await journalEntriesRepository.linesByEntry(id);
    const today = new Date().toISOString().split("T")[0];
    const now = new Date();
    const [reversal] = await journalEntriesRepository.insertEntry({
      entryNumber: `${original.entryNumber}-REV`,
      date: today,
      description: `Reversal of ${original.description}`,
      reference: original.reference,
      status: "posted",
      postedAt: now,
      reversalOf: id,
    });
    await journalEntriesRepository.insertLines(
      lines.map((l) => ({
        journalEntryId: reversal.id,
        accountId: l.accountId,
        accountName: l.accountName,
        description: l.description,
        // swap debit ↔ credit
        debitAmount: l.creditAmount,
        creditAmount: l.debitAmount,
      })),
    );
    await journalEntriesRepository.updateEntry(id, { status: "reversed" });
    const reversalLines = await journalEntriesRepository.linesByEntry(reversal.id);
    const reversalOut = buildJEOut(reversal, reversalLines);
    // Two things happened: a new reversal entry was posted, and the original was reversed.
    await auditService.created("journal_entry", reversal.id, reversalOut);
    await auditService.updated("journal_entry", id, original, { ...original, status: "reversed", reversalId: reversal.id });
    return { message: "Reversed", reversalId: reversal.id, reversal: reversalOut };
  },

  /**
   * 🔴 Named `deleteDraft`, not `remove`, because that is what it does.
   *
   * The route is `DELETE /<resource>/:id` — correct, it addresses the resource —
   * but the verb implies a delete that mostly is NOT one: an issued invoice
   * cannot be deleted at all, and the refusal ("Issued invoices must be
   * reversed with a credit note") is the normal case rather than the edge. A
   * service method called `remove` invites a caller to believe otherwise. The
   * name now states the precondition the body enforces, so a reader sees it
   * before reaching the guard.
   */
  async deleteDraft(id: number) {
    const [existing] = await journalEntriesRepository.findById(id);
    if (!existing) throw new NotFoundError("Not found");
    if (existing.status !== "draft") {
      throw new ConflictError(`Cannot delete a ${existing.status} journal entry. Post a reversing entry instead.`);
    }
    await journalEntriesRepository.remove(id);
    await auditService.deleted("journal_entry", id, existing);
  },
};
