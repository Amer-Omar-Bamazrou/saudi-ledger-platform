/**
 * G16 (Phase 18, migration 0126) — FIXTURE helpers for suites that write the
 * journal tables directly. The freeze refuses, for every role, a change to a
 * posted or reversed entry or its lines, a header inserted already posted, and
 * a line written into a posted entry. Two fixture shapes need a way through:
 *
 *  - TEARDOWN: a suite deleting its own posted entries. The entries are first
 *    put back to `draft` with triggers set aside (`session_replication_role =
 *    replica`, owner-only), and the suite's own DELETEs then run as before —
 *    the PR C pattern (`releaseIssuedInvoicesForTeardown`).
 *  - SETUP: a suite planting a posted entry. It is written the way the product
 *    writes one — a draft header, its lines, then the flip to `posted` — so
 *    every guard, G16's included, sees it exactly as it would see a real one.
 *
 * Neither changes what any test asserts.
 */
import { pool } from "@workspace/db";

/** The client shape these helpers use (`pg`'s own types are not a dependency of this package). */
export type PoolClient = { query: (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }>; release: () => void };

/**
 * FIXTURE ONLY. Puts the posted and reversed journal entries matching `where`
 * (a predicate on `journal_entries`, e.g. `organization_id IN (...)`) back to
 * `draft`, with triggers set aside, so a suite's own teardown can delete them.
 */
export async function releasePostedJournalsForTeardown(where: string, params: unknown[] = []): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL session_replication_role = replica");
    await c.query(`UPDATE journal_entries SET status = 'draft' WHERE (${where}) AND status IN ('posted', 'reversed')`, params);
    await c.query("COMMIT");
  } catch (err) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

export type JournalFixtureHeader = {
  organizationId: string;
  companyId: string;
  entryNumber: string;
  date: string;
  description?: string;
  /** The state the fixture needs: written as a draft and, unless `draft`, flipped to `posted`. */
  status?: "draft" | "posted";
  source?: string | null;
  reference?: string | null;
  reversalOf?: number | null;
};
export type JournalFixtureLine = {
  accountId: number;
  accountName: string;
  debitAmount: number | string;
  creditAmount: number | string;
  description?: string | null;
  partyType?: string | null;
  customerId?: number | null;
  vendorId?: number | null;
};

/**
 * FIXTURE ONLY. Writes one journal entry the way the product does — draft
 * header, lines, then (unless `status: "draft"`) the flip to `posted` — on
 * `client` when given (inside the caller's transaction), else in a transaction
 * of its own. Returns the entry's id.
 */
export async function insertJournalFixture(header: JournalFixtureHeader, lines: JournalFixtureLine[], client?: PoolClient): Promise<number> {
  const run = async (c: PoolClient) => {
    const { rows: [je] } = await c.query(
      `INSERT INTO journal_entries (organization_id, company_id, entry_number, date, description, status, source, reference, reversal_of)
       VALUES ($1, $2, $3, $4, $5, 'draft', $6, $7, $8) RETURNING id`,
      [header.organizationId, header.companyId, header.entryNumber, header.date, header.description ?? "Fixture entry",
        header.source ?? null, header.reference ?? null, header.reversalOf ?? null],
    );
    for (const l of lines) {
      await c.query(
        `INSERT INTO journal_entry_lines (organization_id, company_id, journal_entry_id, account_id, account_name, debit_amount, credit_amount, description, party_type, customer_id, vendor_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [header.organizationId, header.companyId, je.id, l.accountId, l.accountName, l.debitAmount, l.creditAmount,
          l.description ?? null, l.partyType ?? null, l.customerId ?? null, l.vendorId ?? null],
      );
    }
    if ((header.status ?? "posted") === "posted") {
      await c.query(`UPDATE journal_entries SET status = 'posted', posted_at = now() WHERE id = $1 AND status = 'draft'`, [je.id]);
    }
    return je.id as number;
  };
  if (client) return run(client);
  const c = (await pool.connect()) as unknown as PoolClient;
  try {
    await c.query("BEGIN");
    const id = await run(c);
    await c.query("COMMIT");
    return id;
  } catch (err) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}
