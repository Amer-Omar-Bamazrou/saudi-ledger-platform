/**
 * 🔴 T1b (Phase 18; owner 2026-10-27 §1.3): rows of both audit tables, and a
 * CLOSED month's lock, cannot be deleted by any role — the database refuses
 * it, with `session_replication_role = replica` as the only bypass (migration
 * 0132, the G16 pattern). A test's cleanup of them goes through here: the one
 * statement, in its own transaction, with triggers set aside the established
 * way (as `g04Harness` does).
 *
 * 🔴 Replica mode sets foreign keys aside too, so a cleanup still deletes
 * children before their parents itself (docs/test-suite-notes.md, "A
 * replica-mode cleanup that deletes SOME tables leaves orphans").
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { pool as sharedPool } from "@workspace/db";

type Result = { rows: Array<Record<string, any>>; rowCount: number | null };
type Client = { query: (text: string, values?: unknown[]) => Promise<Result>; release: () => void };
type Queryable = { query: (text: string, values?: unknown[]) => Promise<Result> };

/** The tables migration 0132 refuses to delete from outside replica mode (any audit row; a CLOSED month's lock). */
export const REPLICA_ONLY_DELETES = new Set(["audit_logs", "security_audit_logs", "period_locks"]);

/**
 * For a cleanup loop that deletes table by table: a table 0132 guards goes
 * through replica mode on its own connection; every other table keeps `q`, so
 * its foreign keys still refuse an out-of-order delete loudly.
 */
export function deleterFor(q: Queryable, table: string): Queryable {
  if (REPLICA_ONLY_DELETES.has(table)) return replica(sharedPool as unknown as { connect: () => Promise<Client> });
  return { query: (text, values) => q.query(text, values) };
}

export function replica(pool: { connect: () => Promise<Client> }) {
  return {
    async query(text: string, values?: unknown[]): Promise<Result> {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await c.query("SET LOCAL session_replication_role = replica");
        const r = await c.query(text, values);
        await c.query("COMMIT");
        return r;
      } catch (err) {
        await c.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        c.release();
      }
    },
  };
}
