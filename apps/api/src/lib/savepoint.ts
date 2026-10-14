/**
 * 🔴 G60 / DR-47 (2026-10-15): ONE ITEM OF A RUN, IN ITS OWN SAVEPOINT.
 *
 * A Postgres error aborts the whole transaction it happens in. The month-end
 * runs (depreciation, recognition) post many items inside the request's ONE
 * transaction and report each item's failure rather than failing the run. They
 * caught the error and went on, but the transaction was already aborted: the
 * COMMIT then came back with the tag ROLLBACK, which raises no error, and the
 * run answered 200 listing entries as "posted" that did not exist (proof:
 * `phase18-s1-g60-run-rollback.test.ts`, reproduced on main fd27364e).
 *
 * Here the item runs between `SAVEPOINT` and `RELEASE`. When it throws, the
 * transaction is rolled back to the savepoint: the item's own writes (its
 * entry, its posted mark, its event, its audit row) are undone, everything
 * before it stays, and the transaction is usable again for the next item.
 *
 * 🔴 EXPLICIT SQL, NEVER `db.transaction()`. The request's handle is drizzle
 * over one client, not a pool, and drizzle's `transaction()` on such a handle
 * sends BEGIN … COMMIT on the request's own connection: Postgres ignores the
 * second BEGIN and the COMMIT ends the REQUEST's transaction early. Nesting
 * has to be said in SQL.
 *
 * 🔴 TWO KINDS OF FAILURE, KEPT APART. What the ITEM threw comes back as a
 * value — the caller decides whether that item is skipped or stops the run.
 * What the SAVEPOINT statements themselves throw is re-thrown: if the
 * transaction cannot be brought back to the savepoint it is still aborted, and
 * carrying on would be this defect again, so the request must fail.
 */
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

export type SavepointOutcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

// Savepoint names are SQL identifiers and cannot be bound as parameters; this
// counter is the only thing ever interpolated, and it is a number we produce.
let counter = 0;

export async function withSavepoint<T>(item: () => Promise<T>): Promise<SavepointOutcome<T>> {
  const name = `run_item_${++counter}`;
  await db.execute(sql.raw(`SAVEPOINT ${name}`));
  let value: T;
  try {
    value = await item();
  } catch (error) {
    await db.execute(sql.raw(`ROLLBACK TO SAVEPOINT ${name}`));
    await db.execute(sql.raw(`RELEASE SAVEPOINT ${name}`));
    return { ok: false, error };
  }
  await db.execute(sql.raw(`RELEASE SAVEPOINT ${name}`));
  return { ok: true, value };
}
