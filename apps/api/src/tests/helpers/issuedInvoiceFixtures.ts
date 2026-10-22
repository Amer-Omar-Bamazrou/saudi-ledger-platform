/**
 * 🔴 PR C (migration 0125) — the issued-invoice freeze, from the fixtures' side.
 *
 * An issued invoice (any status but draft/submitted, not an opening item) can no longer be deleted,
 * its lines and its signed e-invoice document can no longer be deleted, and no invoice can be INSERTED
 * already issued. Suites that clean up the invoices they issued, or that insert an issued-looking row
 * as a fixture, do both on purpose. These two helpers are the only places they do it, and both set the
 * triggers aside the established way (`session_replication_role = replica`, as `g04Harness` does) for
 * exactly the rows the suite names — never as a step before an assertion about the freeze.
 */
import { pool } from "@workspace/db";
import { UNISSUED_STATUSES } from "../../repositories/invoices.repository";

// Issued = not an opening item and not in an unissued state — the predicate of the database's
// `invoice_is_issued`, built from the application's one list of unissued states.
const ISSUED = `NOT is_opening AND status NOT IN (${UNISSUED_STATUSES.map((s) => `'${s}'`).join(", ")})`;

/**
 * TEARDOWN ONLY. Hands the suite's own issued invoices (`where`, a predicate over `invoices`) back to
 * an unissued state and removes their signed e-invoice documents, triggers set aside, in one
 * transaction — so the suite's existing cleanup statements then delete them unchanged, through the
 * ordinary foreign keys and their cascades (a replica-mode DELETE would skip the cascades and leave
 * orphans). Call it first in the cleanup, before the suite's own DELETEs.
 */
export async function releaseIssuedInvoicesForTeardown(where: string, params: unknown[] = []): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL session_replication_role = replica");
    await c.query(`DELETE FROM einvoice_documents WHERE invoice_id IN (SELECT id FROM invoices WHERE ${where})`, params);
    await c.query(`UPDATE invoices SET status = 'draft' WHERE (${where}) AND ${ISSUED}`, params);
    await c.query("COMMIT");
  } catch (err) {
    await c.query("ROLLBACK");
    throw err;
  } finally {
    c.release();
  }
}

/**
 * FIXTURE ONLY. Runs one statement that writes an issued invoice row (or its e-invoice document)
 * directly — inserting a row already issued, moving a fixture date, clearing a suite's queued documents
 * between tests — with triggers set aside, exactly as the suite wrote it before the freeze. Returns the
 * statement's result.
 */
export async function writeIssuedFixture(sql: string, params: unknown[] = []) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL session_replication_role = replica");
    const r = await c.query(sql, params);
    await c.query("COMMIT");
    return r;
  } catch (err) {
    await c.query("ROLLBACK");
    throw err;
  } finally {
    c.release();
  }
}
