/**
 * Flaw #1 (Option A) — ACCEPTED TRANSACTIONS BECOME LEDGER FACTS.
 *
 * ── The defect this closes ─────────────────────────────────────────────────
 * Observed on a live SME statement: an income statement reporting **0.00 of
 * expenses** for a month with 45,063.25 of accepted bank debits, beside a
 * dashboard reporting all of it. Nothing posted a transaction to the general
 * ledger, so the ledger family (income statement, trial balance, balance
 * sheet) and the transaction family (dashboard, VAT reconciliation, Zakat,
 * cash flow, budgets) answered the same questions from disjoint stores —
 * meta-finding #9. For a cash-based SME, the P&L was empty.
 *
 * ── Why posting rather than a report that reads both ──────────────────────
 * A union-read would leave the trial balance and balance sheet still ignoring
 * transactions, so net income would no longer tie to the equity movement — an
 * accounting system that does not reconcile — and it would add a THIRD reader
 * of the same fact, which is the hazard #9 names. Posting collapses the two
 * families instead of papering over them.
 *
 * ── The posting rules, each a decision ────────────────────────────────────
 *  1. **Acceptance is the trigger.** Accepting is already the human act that
 *     means "these numbers are mine"; pending rows must keep moving nothing.
 *  2. **GROSS, with no input-VAT line.** Input VAT may only be reclaimed with
 *     a valid tax invoice, and a bank line is not one. The transaction-side
 *     VAT figure stays what M16.1 made it — a reconciliation ESTIMATE — and
 *     never becomes a ledger claim. Cost, stated: a registered buyer's expense
 *     is overstated by the VAT until the supplier's invoice is captured (A1)
 *     and the row is settled against the resulting bill.
 *  3. **Uncategorised posts to SUSPENSE**, not to an expense account. Refusing
 *     acceptance would strand the review queue; posting to expenses is the
 *     defect. Suspense keeps the books balanced and makes "unknown" a visible
 *     balance somebody must clear.
 *  4. **Transfers POST (A — GL owns cash, 2026-08-17); settlements never do.**
 *     A settlement's ledger effect was already posted by `invoicesService.pay`
 *     / `billsService.pay`; posting again would double-count the cash and the
 *     receivable. One writer per effect. Transfers post by DECLARED direction
 *     (B5), which is what made this safe to build:
 *       own_account → TRANSFER_CLEARING — both legs uploaded nets to zero;
 *                     a residual is the tenant's money in an own account the
 *                     platform does not track. Real, visible, not noise.
 *       external    → EXTERNAL_TRANSFERS (equity) — the tenant declared the
 *                     money left the business; see the reasoning recorded on
 *                     the account in chartOfAccounts.ts.
 *       undeclared  → TRANSFER_SUSPENSE — it still posts (the bank genuinely
 *                     moved, so ledger cash must be right), but the offset is
 *                     a visible balance demanding a declaration, and it
 *                     blocks the Finance Hub liquidity claim like SUSPENSE.
 *                     Declaring later reverses and re-posts.
 *  5. **The category's TYPE decides the statement it lands in**, which is what
 *     makes the classification corrections real: `VAT_PAYMENT` and
 *     `ZAKAT_PAYMENT` are liabilities (migration 0036), so paying them debits
 *     the liability and never touches the P&L; a fixed asset debits an asset.
 *  6. **Period locks apply** — `postJournalEntry` refuses a closed period, so
 *     accepting a row dated into one fails closed like every other posting.
 */
import { db, transactionsTable, categoriesTable, type SystemAccountCode } from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { postJournalEntry, type GLLine } from "./accounting/glPosting";
import { journalEntriesService } from "./journalEntries.service";
import { logger } from "../lib/logger";

type Tx = typeof transactionsTable.$inferSelect;
type Cat = typeof categoriesTable.$inferSelect;

/** The transfer offset by DECLARED direction — see the file header and chartOfAccounts.ts. */
function transferOffset(tx: Tx): { accountName: string; systemCode: SystemAccountCode } {
  if (tx.transferDirection === "own_account") {
    return { accountName: "Transfer clearing (own accounts)", systemCode: "TRANSFER_CLEARING" };
  }
  if (tx.transferDirection === "external") {
    return { accountName: "External transfers (money leaving the business)", systemCode: "EXTERNAL_TRANSFERS" };
  }
  return { accountName: "Transfers awaiting declaration", systemCode: "TRANSFER_SUSPENSE" };
}

/** Money out of the bank is a debit to something and a credit to cash. */
function linesFor(tx: Tx, cat: Cat | null): GLLine[] {
  const amount = Math.round(Number(tx.amount) * 100) / 100;
  const label = tx.description.slice(0, 120);

  // The account this movement belongs to. A system account resolves by CODE
  // (rename-proof, M13); a tenant's own category resolves by id. A transfer
  // carries no category BY DESIGN — its offset is decided by the declared
  // direction alone.
  const account: Pick<GLLine, "accountName"> &
    ({ systemCode: never } | { accountId: number }) =
    tx.kind === "transfer"
      ? (transferOffset(tx) as never)
      : cat && cat.id
        ? ({ accountName: cat.name, accountId: cat.id } as never)
        : ({ accountName: "Suspense (unclassified)", systemCode: "SUSPENSE" } as never);

  const cash = { accountName: "Cash and Bank", systemCode: "CASH" as const };

  return tx.type === "debit"
    ? [
        { ...(account as object), description: label, debitAmount: amount, creditAmount: 0 } as GLLine,
        { ...cash, description: label, debitAmount: 0, creditAmount: amount },
      ]
    : [
        { ...cash, description: label, debitAmount: amount, creditAmount: 0 },
        { ...(account as object), description: label, debitAmount: 0, creditAmount: amount } as GLLine,
      ];
}

/**
 * A transaction posts only if it is accepted, operating OR a transfer (A —
 * GL owns cash), and not already posted. Settlements stay out: their ledger
 * effect belongs to the pay paths.
 */
export function shouldPost(tx: Pick<Tx, "reviewStatus" | "kind" | "journalEntryId">): boolean {
  return (
    tx.reviewStatus === "accepted" &&
    (tx.kind === "operating" || tx.kind === "transfer") &&
    tx.journalEntryId == null
  );
}

export const transactionPostingService = {
  /**
   * Post one accepted transaction. Runs INSIDE the caller's tenant
   * transaction, so the journal entry and the `journal_entry_id` link commit
   * atomically with the acceptance — a row can never be accepted-but-unposted
   * or posted-but-unlinked.
   */
  async post(txId: number): Promise<number | null> {
    const [row] = await db
      .select({ tx: transactionsTable, cat: categoriesTable })
      .from(transactionsTable)
      .leftJoin(categoriesTable, eq(transactionsTable.categoryId, categoriesTable.id))
      .where(eq(transactionsTable.id, txId))
      .limit(1);
    if (!row || !shouldPost(row.tx)) return null;

    const je = await postJournalEntry({
      entryNumber: `TXN-${row.tx.id}`,
      date: row.tx.date,
      description: `Bank ${row.tx.kind === "transfer" ? "transfer" : row.tx.type === "debit" ? "payment" : "receipt"}: ${row.tx.description.slice(0, 80)}`,
      reference: `TXN-${row.tx.id}`,
      lines: linesFor(row.tx, row.cat),
    });

    await db.update(transactionsTable).set({ journalEntryId: je.id }).where(eq(transactionsTable.id, txId));
    return je.id;
  },

  /** Post many (bulk accept). One failure must not strand the rest. */
  async postMany(ids: number[]): Promise<{ posted: number; failed: Array<{ id: number; reason: string }> }> {
    let posted = 0;
    const failed: Array<{ id: number; reason: string }> = [];
    for (const id of ids) {
      try {
        if (await this.post(id)) posted++;
      } catch (err) {
        // Recorded, never swallowed: an accepted row that did not post is the
        // exact silence this milestone exists to remove.
        const reason = err instanceof Error ? err.message : String(err);
        logger.error({ err, transactionId: id }, "transaction accepted but could not post to the ledger");
        failed.push({ id, reason });
      }
    }
    return { posted, failed };
  },

  /**
   * Re-post after an edit: REVERSE the original entry and post a new one.
   *
   * Not an in-place update — a posted entry is immutable, and reversal leaves
   * the audit trail intact (the M10 posting discipline). Returns the new entry
   * id, or null when the row is not in a posting state.
   */
  async repost(txId: number): Promise<number | null> {
    const [row] = await db
      .select({ tx: transactionsTable })
      .from(transactionsTable)
      .where(eq(transactionsTable.id, txId))
      .limit(1);
    if (!row) return null;

    if (row.tx.journalEntryId != null) {
      await journalEntriesService.reverse(row.tx.journalEntryId);
      await db.update(transactionsTable).set({ journalEntryId: null }).where(eq(transactionsTable.id, txId));
    }
    // Re-read through `post`, which re-checks `shouldPost` — an edit that made
    // the row a transfer, or un-accepted it, correctly leaves it unposted.
    return this.post(txId);
  },

  /**
   * Backfill: post every accepted operating transaction that predates Option A.
   *
   * Cheap now and expensive later — there are no customers, so the alternative
   * ("from now on", leaving a permanent hole in every historical P&L) buys
   * nothing. Skips rows whose period is locked and reports them rather than
   * failing the run.
   */
  async backfill(limit = 5000, companyId?: string): Promise<{ posted: number; skipped: number; failed: Array<{ id: number; reason: string }> }> {
    // `companyId` matters when an org has several companies: the journal
    // entry's company resolves from the tenant GUC, so a backfill pass must
    // only touch rows belonging to the company its connection is scoped to.
    const rows = await db
      .select({ id: transactionsTable.id })
      .from(transactionsTable)
      .where(
        companyId
          ? and(inArray(transactionsTable.reviewStatus, ["accepted"]), eq(transactionsTable.companyId, companyId))
          : inArray(transactionsTable.reviewStatus, ["accepted"]),
      )
      .limit(limit);

    const { posted, failed } = await this.postMany(rows.map((r) => r.id));
    return { posted, skipped: rows.length - posted - failed.length, failed };
  },
};
