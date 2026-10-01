/**
 * A test's cleanup of the input-VAT event ledger — FIRST, before its bills and
 * journal entries.
 *
 * 🔴 Phase 13B-3 (migration 0109): every approved purchase document now has
 * input-VAT events, written by the approval itself. Events are APPEND-ONLY for
 * every role, the owner included (`input_vat_events_immutable`), they hold
 * their documents and entries by `ON DELETE RESTRICT`, and an entry an event
 * references cannot lose its lines (`journal_entry_lines_vat_guard`). So a
 * suite that deletes its own bills or entries must remove its events first —
 * with triggers out of the way (`session_replication_role = replica`, the
 * pattern every cleanup here uses), in a transaction of its own, scoped to
 * the suite's own organisations. Nothing outside a test ever deletes an event.
 *
 * `orgIds` is a SQL expression yielding the suite's organisation ids, e.g.
 * `SELECT id FROM organizations WHERE slug = 'x'`, or `$1` with `params`.
 */
import { pool } from "@workspace/db";

export async function purgeInputVatLedger(orgIds: string, params: unknown[] = []): Promise<void> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL session_replication_role = replica");
    await c.query(`DELETE FROM input_vat_events WHERE organization_id IN (${orgIds})`, params);
    await c.query(`DELETE FROM input_vat_balances WHERE organization_id IN (${orgIds})`, params);
    // Phase 13B S1 (0110): the historical VAT declarations are append-only too, and
    // hold their bills, items and captures by RESTRICT — evidence first.
    await c.query(`DELETE FROM opening_payable_vat_declaration_evidence WHERE organization_id IN (${orgIds})`, params);
    await c.query(`DELETE FROM opening_payable_vat_declarations WHERE organization_id IN (${orgIds})`, params);
    await c.query("COMMIT");
  } catch (err) {
    await c.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}
