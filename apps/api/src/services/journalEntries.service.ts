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
import { ConflictError, NotFoundError } from "../lib/errors";
import { BadRequestError } from "../lib/errors";
import { checkPeriodOpen } from "./accounting/periodLock";
import { auditService } from "./audit.service";
import { approvalService } from "./approval";
import { journalEntryApprovable } from "./journalEntries.approvable";
import { buildJEOut } from "./journalEntries.presenter";
import { journalEntriesRepository } from "../repositories/journalEntries.repository";
import type { journalEntriesTable } from "@workspace/db";

export const journalEntriesService = {
  async list(status?: string) {
    const rows = await journalEntriesRepository.list(status);
    return rows.map((r) => buildJEOut(r));
  },

  async getById(id: number) {
    const [je] = await journalEntriesRepository.findById(id);
    if (!je) throw new NotFoundError("Not found");
    const lines = await journalEntriesRepository.linesByEntry(id);
    return buildJEOut(je, lines);
  },

  async create(body: Record<string, unknown>, userId: number | null) {
    const { lines = [], ...jeData } = body as { lines?: unknown[] } & Record<string, unknown>;
    const totalDebit = (lines as any[]).reduce((s, l) => s + Number(l.debitAmount ?? 0), 0);
    const totalCredit = (lines as any[]).reduce((s, l) => s + Number(l.creditAmount ?? 0), 0);
    if (Math.abs(totalDebit - totalCredit) > 0.01) {
      throw new BadRequestError("Journal entry must balance: debits must equal credits");
    }
    if (jeData.date) await checkPeriodOpen(jeData.date as string);

    const [je] = await journalEntriesRepository.insertEntry({
      ...(jeData as typeof journalEntriesTable.$inferInsert),
      createdBy: userId ?? null,
    });
    const savedLines =
      (lines as any[]).length > 0
        ? await journalEntriesRepository.insertLines(
            (lines as any[]).map((l) => ({
              ...l,
              journalEntryId: je.id,
              debitAmount: String(l.debitAmount ?? 0),
              creditAmount: String(l.creditAmount ?? 0),
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

  async remove(id: number) {
    const [existing] = await journalEntriesRepository.findById(id);
    if (!existing) throw new NotFoundError("Not found");
    if (existing.status !== "draft") {
      throw new ConflictError(`Cannot delete a ${existing.status} journal entry. Post a reversing entry instead.`);
    }
    await journalEntriesRepository.remove(id);
    await auditService.deleted("journal_entry", id, existing);
  },
};
