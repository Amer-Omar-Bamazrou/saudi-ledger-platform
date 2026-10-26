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
 *
 * 🔴 SIBLINGS TAKE TURNS (B-O6-PRE, Phase 18). Savepoints on one connection are
 * a STACK, so two scopes open at once interleave: the first RELEASE also
 * releases the second (whose own RELEASE then fails), and a ROLLBACK TO the
 * first undoes the second's writes. `/llm/compare` meters up to 50 model calls
 * at once inside one request (Promise.all → meteredChat → the meter's
 * savepoint). So scopes opened side by side in one transaction run one at a
 * time. A scope opened INSIDE an item nests in it, taking turns only with its
 * own siblings: waiting for the enclosing item to finish would deadlock.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { sql } from "drizzle-orm";
import { db, currentTenantTransaction } from "@workspace/db";

export type SavepointOutcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

// Savepoint names are SQL identifiers and cannot be bound as parameters; this
// counter is the only thing ever interpolated, and it is a number we produce.
let counter = 0;

/** The scope an item runs in: its transaction, and a token its own nested scopes take turns on. */
const enclosing = new AsyncLocalStorage<{ tx: object; token: object }>();
/** The last turn queued on each key (a transaction, or an enclosing item's token). */
const lastTurn = new WeakMap<object, Promise<void>>();

async function takeTurn<T>(key: object, fn: () => Promise<T>): Promise<T> {
  const previous = lastTurn.get(key) ?? Promise.resolve();
  let finished!: () => void;
  lastTurn.set(key, new Promise<void>((resolve) => (finished = resolve)));
  await previous;
  try {
    return await fn();
  } finally {
    finished();
  }
}

async function inSavepoint<T>(item: () => Promise<T>): Promise<SavepointOutcome<T>> {
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

export async function withSavepoint<T>(item: () => Promise<T>): Promise<SavepointOutcome<T>> {
  const tx = currentTenantTransaction();
  // Outside a tenant transaction there is nothing to coordinate: the SAVEPOINT
  // itself is refused (UnscopedDatabaseAccessError) and re-thrown, as before.
  if (!tx) return inSavepoint(item);
  const parent = enclosing.getStore();
  const key = parent?.tx === tx ? parent.token : tx;
  return takeTurn(key, () => enclosing.run({ tx, token: {} }, () => inSavepoint(item)));
}
