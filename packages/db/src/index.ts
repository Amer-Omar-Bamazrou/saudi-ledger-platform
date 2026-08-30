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

/**
 * Dedicated pool for the session store (connect-pg-simple), isolated from the
 * request-transaction `pool`. This prevents slow requests that hold a tenant
 * transaction open from starving login/session queries (M6 / HIGH-1).
 */
export const sessionPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });

type DB = NodePgDatabase<typeof schema>;

/**
 * The base, pool-bound Drizzle instance. Connects as the pool's login role
 * (the table owner today) and is NOT tenant-scoped, so it bypasses RLS. Used for
 * everything that must run before or outside a request's tenant transaction:
 * migrations, seeding, the session store, login/auth, and tenant resolution.
 */
const baseDb: DB = drizzle(pool, { schema });

/**
 * The base/owner connection, exported EXPLICITLY for owner-only tables.
 *
 * Use this — never the `db` proxy — when touching a table that has no app-role
 * grants (`zatca_credentials`, `security_audit_logs`, `platform_operators`,
 * `verification_reviews`, `verification_documents`, `organization_invitations`).
 *
 * Inside a request the `db` proxy resolves to the tenant connection, which has
 * no privileges on those tables, so the query would fail. Depending on that
 * failure would be luck rather than design: state the connection you mean.
 */
export const ownerDb: DB = baseDb;

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
/**
 * The methods on this handle that actually reach the database.
 *
 * Only these are refused outside a tenant scope. Property probes — `then`,
 * `Symbol.toStringTag`, whatever `util.inspect` and drizzle's own internals
 * touch — must stay harmless, or the guard breaks unrelated things while
 * claiming to protect the ledger.
 */
const DB_REACHING_METHODS = new Set([
  "select",
  "selectDistinct",
  "selectDistinctOn",
  "insert",
  "update",
  "delete",
  "execute",
  "transaction",
  "batch",
  "with",
  "$with",
  "$count",
]);

/**
 * Raised when a query is attempted through {@link db} outside a tenant
 * transaction. Named so it can be asserted on and never mistaken for a
 * connection error.
 */
export class UnscopedDatabaseAccessError extends Error {
  constructor(method: string) {
    super(
      `db.${method}() was called outside a tenant transaction. The tenant-scoped handle is ` +
        `unavailable here, and falling back to the owner connection would run the query with ` +
        `RLS BYPASSED and no app.current_org_id — a silent cross-tenant read or write. ` +
        `If this call is deliberately cross-tenant (a platform job, migration, seeding, auth, ` +
        `or tenant resolution), import { ownerDb } and say so; otherwise wrap the call in ` +
        `beginTenantConnection().run().`,
    );
    this.name = "UnscopedDatabaseAccessError";
    Object.setPrototypeOf(this, UnscopedDatabaseAccessError.prototype);
  }
}

export const db: DB = new Proxy(baseDb, {
  get(target, prop) {
    const active = tenantStorage.getStore()?.db;

    /**
     * 🔴 NO SILENT FALLBACK. This used to be `?? target` — outside a tenant
     * scope the handle quietly became the OWNER connection: RLS bypassed, no
     * `app.current_org_id`, full cross-tenant reach, and no error of any kind.
     *
     * The accounting core depends on that never happening and says so in a
     * comment: `glPosting.resolveAccounts` writes no organization filter
     * because "this runs inside the request's tenant transaction". So the core
     * trusted a fact its CALLER controlled, and the failure mode was a wrong
     * answer rather than a refusal — posting one tenant's entries against
     * another's accounts, silently, in the layer with the least tolerance for
     * it. Ranked first in §5 despite having no live instance, because nothing
     * stopped the next caller from creating one.
     *
     * Now the wrong thing is INEXPRESSIBLE rather than merely unwise (§3): the
     * unscoped query cannot be written through this handle at all, and the
     * deliberate cross-tenant path has a different name — `ownerDb` — that a
     * reader can see and a reviewer can question.
     */
    if (!active && typeof prop === "string" && DB_REACHING_METHODS.has(prop)) {
      throw new UnscopedDatabaseAccessError(prop);
    }

    const resolved = active ?? target;
    const value = Reflect.get(resolved as object, prop);
    return typeof value === "function"
      ? (value as (...args: unknown[]) => unknown).bind(resolved)
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

// Bounds a stuck-open tenant transaction (set transaction-locally per request).
const IDLE_IN_TX_TIMEOUT = "15s";

/**
 * A pg-compatible client that LAZILY checks out a real pooled connection on the
 * first query. On acquisition it opens the request transaction, drops to the
 * non-owner `scope.role`, and sets the tenant GUCs — all transaction-locally
 * (`SET LOCAL` / `set_config(..., true)`), so nothing leaks across pooled
 * connections. A request that issues NO query never acquires a connection
 * (HIGH-1: DB-less routes like /llm no longer hold the pool). drizzle-orm calls
 * only `.query(...)`, verified against drizzle before adoption.
 */
class LazyTenantClient {
  private client: pg.PoolClient | null = null;
  private opening: Promise<pg.PoolClient> | null = null;

  constructor(private readonly scope: TenantScope) {}

  private acquire(): Promise<pg.PoolClient> {
    if (this.client) return Promise.resolve(this.client);
    if (!this.opening) {
      this.opening = (async () => {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query(`SET LOCAL ROLE "${this.scope.role}"`);
          await client.query(`SET LOCAL idle_in_transaction_session_timeout = '${IDLE_IN_TX_TIMEOUT}'`);
          await client.query("SELECT set_config('app.current_org_id', $1, true)", [this.scope.organizationId]);
          await client.query("SELECT set_config('app.current_company_id', $1, true)", [this.scope.companyId ?? ""]);
        } catch (err) {
          this.opening = null;
          client.release();
          throw err;
        }
        this.client = client;
        return client;
      })();
    }
    return this.opening;
  }

  /** drizzle-orm/node-postgres invokes this for every query. */
  query(...args: unknown[]): unknown {
    return this.acquire().then((client) => (client.query as (...a: unknown[]) => unknown)(...args));
  }

  /** Commit/rollback + release ONLY if a connection was actually acquired. */
  async finish(action: "COMMIT" | "ROLLBACK"): Promise<void> {
    if (!this.client && this.opening) {
      // An acquisition is in flight — wait for it so we don't leak the client.
      try {
        await this.opening;
      } catch {
        return; // acquisition failed; nothing to release
      }
    }
    const client = this.client;
    if (!client) return; // never acquired → nothing to do (the HIGH-1 win)
    this.client = null;
    try {
      await client.query(action);
    } finally {
      client.release();
    }
  }
}

/**
 * Build a per-request tenant connection. No I/O happens here — the underlying
 * pooled client and its `BEGIN`/`SET LOCAL ROLE`/GUCs are established lazily on
 * the first query issued through {@link db} inside `run(...)`. The caller must
 * `commit()` (on success) or `rollback()` (on error/abort).
 */
export async function beginTenantConnection(scope: TenantScope): Promise<TenantConnection> {
  if (!SAFE_IDENTIFIER.test(scope.role)) {
    throw new Error(`Unsafe DB role identifier: ${JSON.stringify(scope.role)}`);
  }

  const lazy = new LazyTenantClient(scope);
  const scopedDb = drizzle(lazy as unknown as pg.PoolClient, { schema });
  let settled = false;

  const finish = async (action: "COMMIT" | "ROLLBACK"): Promise<void> => {
    if (settled) return;
    settled = true;
    await lazy.finish(action);
  };

  return {
    run: (fn) => tenantStorage.run({ db: scopedDb }, fn),
    commit: () => finish("COMMIT"),
    rollback: () => finish("ROLLBACK"),
  };
}

export * from "./schema";
export * from "./permissions";
export * from "./chartOfAccounts";
