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
import { GL_BALANCE_TOLERANCE } from "./accounting/glPosting";
import { BusinessRuleError } from "../lib/errors";
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
    // 🔴 And the balance — on the STORED lines, not on whatever request created
    // them (2026-09-15, review item 2). The invariant that matters is that an
    // entry cannot BECOME posted while unbalanced; the create path's check is a
    // different moment and a different set of numbers. Stored amounts are
    // exact 2-dp strings, so the sum is compared under the GL tolerance only
    // to absorb float addition, never to admit a real halala.
    const storedLines = await journalEntriesRepository.linesByEntry(je.id);
    /**
     * 🔴 D-3 (2026-09-17): approval only flips `status` — it inserts no line,
     * so the DB trigger that refuses a header line never fires here. A draft
     * created BEFORE 0073 with a line on "Cash and Bank" would post into the
     * header through this door. Refused on the STORED lines, like the balance.
     */
    const headerLines = await journalEntriesRepository.nonPostingAccountsOf(storedLines.map((l) => l.accountId).filter((id): id is number => id != null));
    if (headerLines.length > 0) {
      throw new BusinessRuleError(422, {
        error:
          `Journal entry cannot be posted: it has a line on ${headerLines.map((h) => h.name).join(", ")}, which is a header account and accepts no postings. ` +
          "Edit the draft to use the bank account's own cash account.",
        code: "account_not_posting",
        field: "lines",
      });
    }
    const totalDebit = storedLines.reduce((s, l) => s + Number(l.debitAmount), 0);
    const totalCredit = storedLines.reduce((s, l) => s + Number(l.creditAmount), 0);
    if (Math.abs(totalDebit - totalCredit) > GL_BALANCE_TOLERANCE) {
      throw new BusinessRuleError(422, {
        error:
          `Journal entry cannot be posted: its stored lines do not balance — debits ${totalDebit.toFixed(2)} ` +
          `vs credits ${totalCredit.toFixed(2)}. Correct the entry before posting.`,
        code: "journal_entry_unbalanced",
        field: "lines",
      });
    }
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
