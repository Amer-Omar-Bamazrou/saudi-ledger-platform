/**
 * B-G08R-P proofs — the shared way of FORCING an interleaving (test only).
 *
 * A holder transaction locks one row. Each act is sent in turn and is SEEN
 * waiting on a lock before the next is sent; then the holder commits and the
 * acts run in the order they queued.
 *
 * "Waiting" is counted only inside the HOLDER's wait tree: a session blocked by
 * the holder, or by a session already in the tree (the second act in a row-lock
 * queue waits on the first). Sessions of other test files running in parallel
 * are never counted, so a race is not taken as established before it is.
 */
import { pool } from "@workspace/db";
import type { Res } from "./g04Harness";

/** How many sessions are waiting, directly or through another waiter, on `holderPid`. */
export const lockWaiters = async (holderPid: number): Promise<number> => Number((await pool.query(
  `WITH RECURSIVE tree(pid) AS (
     SELECT $1::int
     UNION
     SELECT a.pid FROM pg_stat_activity a JOIN tree t ON t.pid = ANY (pg_blocking_pids(a.pid))
   )
   SELECT (count(*) - 1)::int AS n FROM tree`, [holderPid],
)).rows[0].n);

export async function until(label: string, check: () => Promise<boolean>, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`${label} — the race was not established`);
    await new Promise((res) => setTimeout(res, 50));
  }
}

export async function queuedBehind(table: string, id: number, acts: Array<() => Promise<Res>>): Promise<Res[]> {
  const holder = await pool.connect();
  let open = false;
  try {
    await holder.query("BEGIN");
    open = true;
    const holderPid = Number((await holder.query(`SELECT pg_backend_pid() AS pid`)).rows[0].pid);
    await holder.query(`SELECT id FROM "${table}" WHERE id = $1 FOR UPDATE`, [id]);
    const sent: Promise<Res>[] = [];
    for (const act of acts) {
      sent.push(act());
      const k = sent.length;
      await until(`act ${k} on ${table} ${id} did not queue on a lock`, async () => (await lockWaiters(holderPid)) >= k);
    }
    await holder.query("COMMIT");
    open = false;
    return await Promise.all(sent);
  } finally {
    if (open) await holder.query("ROLLBACK");
    holder.release();
  }
}

export const brief = (r: Res) => [r.status, r.body?.code ?? null, r.body?.error ?? null];
export const statuses = (rs: Res[]) => rs.map((r) => r.status).sort((x, y) => x - y);

export async function auditsOf(orgId: string, entityType: string, id: number): Promise<string[]> {
  return (await pool.query(
    `SELECT action, count(*)::int AS n FROM audit_logs WHERE organization_id = $1 AND entity_type = $2 AND entity_id = $3 GROUP BY action ORDER BY action`,
    [orgId, entityType, String(id)],
  )).rows.map((r) => `${r.action}:${r.n}`);
}

export async function entriesNumbered(orgId: string, entryNumber: string) {
  return (await pool.query(
    `SELECT je.id, je.status, (SELECT count(*)::int FROM journal_entry_lines l WHERE l.journal_entry_id = je.id) AS lines
       FROM journal_entries je WHERE je.organization_id = $1 AND je.entry_number = $2 ORDER BY je.id`, [orgId, entryNumber],
  )).rows as Array<{ id: number; status: string; lines: number }>;
}
