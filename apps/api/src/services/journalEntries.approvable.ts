/**
 * Journal-entry approval adapter — plugs journal entries into the generic
 * {@link approvalService} (M10.2).
 *
 * The JE is the reference implementation of the workflow: its long-standing
 * `draft → posted` lifecycle already gates ledger impact (reports filter
 * `status = 'posted'`), so approval here is exactly "post to GL" — the existing,
 * trusted activation path, unchanged. This adapter only maps the JE's native
 * status onto the abstract `pending | approved` and names the on-approve action.
 *
 * State mapping (spec §9, §10):
 *   draft    → draft     (no effect on the books; approved directly — JE has no
 *                         submit/send-back stage, so it omits onSubmit/onSendBack)
 *   posted   → approved  (active in the ledger)
 *   reversed → approved  (was posted; a post-approval terminal state — cannot be
 *                         re-approved, which the service's "already approved"
 *                         guard enforces)
 *
 * Period locks (spec Q#5): the period-lock check runs at APPROVAL time, so a
 * draft created while a period was open but approved after it locks is rejected
 * with the standard closed-period error — approval is when it hits the GL.
 */
import { checkPeriodOpen } from "./accounting/periodLock";
import { journalEntriesRepository } from "../repositories/journalEntries.repository";
import { buildJEOut, type JournalEntryOut } from "./journalEntries.presenter";
import type { Approvable, ApprovalState } from "./approval";
import type { journalEntriesTable } from "@workspace/db";

type JournalEntry = typeof journalEntriesTable.$inferSelect;

export const journalEntryApprovable: Approvable<JournalEntry, JournalEntryOut> = {
  entityType: "journal_entry",

  async load(id) {
    const [je] = await journalEntriesRepository.findById(id);
    return je ?? null;
  },

  state(je): ApprovalState {
    // JE has no editable-draft/submit stage — a draft is approved (posted) directly.
    return je.status === "draft" ? "draft" : "approved";
  },

  async onApprove(je) {
    // Approval is the ledger-affecting moment — enforce the period lock here.
    await checkPeriodOpen(je.date);
    const [posted] = await journalEntriesRepository.updateEntry(je.id, {
      status: "posted",
      postedAt: new Date(),
    });
    const lines = await journalEntriesRepository.linesByEntry(je.id);
    return buildJEOut(posted, lines);
  },

  async snapshot(je) {
    const lines = await journalEntriesRepository.linesByEntry(je.id);
    return buildJEOut(je, lines);
  },

  async hardDelete(je) {
    await journalEntriesRepository.remove(je.id);
  },
};
