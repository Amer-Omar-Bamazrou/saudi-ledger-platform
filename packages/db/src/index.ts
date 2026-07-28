import { AsyncLocalStorage } from "node:async_hooks";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });

type DB = NodePgDatabase<typeof schema>;

/**
 * The base, pool-bound Drizzle instance. Connects as the pool's login role
 * (the table owner today) and is NOT tenant-scoped, so it bypasses RLS. Used for
 * everything that must run before or outside a request's tenant transaction:
 * migrations, seeding, the session store, login/auth, and tenant resolution.
 */
const baseDb: DB = drizzle(pool, { schema });

interface TenantStore {
  db: DB;
}

// Holds the per-request tenant-scoped Drizzle instance for the duration of a
// request, propagated across async boundaries via AsyncLocalStorage.
const tenantStorage = new AsyncLocalStorage<TenantStore>();

/**
 * The database handle every call site imports.
 *
 * Inside a tenant transaction (established by {@link beginTenantConnection}) it
 * transparently resolves to that request's dedicated client — running as the
 * non-owner DB role with `app.current_org_id` set, so Postgres RLS applies.
 * Outside any tenant scope it falls back to {@link baseDb}. This lets existing
 * `import { db }` call sites become tenant-scoped with no code changes, while
 * the M6 layering refactor is still pending.
 */
export const db: DB = new Proxy(baseDb, {
  get(target, prop) {
    const active = tenantStorage.getStore()?.db ?? target;
    const value = Reflect.get(active as object, prop);
    return typeof value === "function"
      ? (value as (...args: unknown[]) => unknown).bind(active)
      : value;
  },
});

export interface TenantScope {
  organizationId: string;
  companyId?: string | null;
  /**
   * Non-owner Postgres role to `SET LOCAL ROLE` to for this request so RLS is
   * enforced. Must be a plain SQL identifier the login role is a member of.
   */
  role: string;
}

export interface TenantConnection {
  /** Run `fn` (and its async continuation) with the tenant-scoped db bound. */
  run: <T>(fn: () => T) => T;
  /** Commit the request transaction and release the client (idempotent). */
  commit: () => Promise<void>;
  /** Roll back the request transaction and release the client (idempotent). */
  rollback: () => Promise<void>;
}

// Only ever interpolated after passing this test — SET LOCAL ROLE cannot be
// parameterized, so the role name must be a validated identifier.
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Check out a dedicated pooled client, open a transaction, drop to the non-owner
 * `scope.role`, and set the tenant GUCs — all transaction-locally (`SET LOCAL` /
 * `set_config(..., true)`), so nothing leaks to the next request that reuses the
 * connection. Business queries issued through {@link db} inside `run(...)` then
 * execute on this client under RLS. The caller must `commit()` or `rollback()`.
 */
export async function beginTenantConnection(scope: TenantScope): Promise<TenantConnection> {
  if (!SAFE_IDENTIFIER.test(scope.role)) {
    throw new Error(`Unsafe DB role identifier: ${JSON.stringify(scope.role)}`);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL ROLE "${scope.role}"`);
    await client.query("SELECT set_config('app.current_org_id', $1, true)", [scope.organizationId]);
    await client.query("SELECT set_config('app.current_company_id', $1, true)", [scope.companyId ?? ""]);
  } catch (err) {
    // Failed while establishing scope — undo and release before propagating.
    try {
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    throw err;
  }

  const scopedDb = drizzle(client, { schema });
  let settled = false;

  const finish = async (action: "COMMIT" | "ROLLBACK"): Promise<void> => {
    if (settled) return;
    settled = true;
    try {
      await client.query(action);
    } finally {
      client.release();
    }
  };

  return {
    run: (fn) => tenantStorage.run({ db: scopedDb }, fn),
    commit: () => finish("COMMIT"),
    rollback: () => finish("ROLLBACK"),
  };
}

export * from "./schema";
