/**
 * THE TENANT-SCOPE PRECONDITION, MADE INEXPRESSIBLE.
 *
 * ── 🔴 WHAT THIS REPLACED ──────────────────────────────────────────────────
 * `db` is a Proxy. Inside a tenant transaction it resolves to the RLS-scoped
 * client; outside one it used to fall back **silently** to the owner
 * connection — RLS bypassed, no `app.current_org_id`, full cross-tenant reach,
 * and no error of any kind.
 *
 * The accounting core depends on that never happening and says so in a comment:
 * `glPosting.resolveAccounts` writes no organization filter because "this runs
 * inside the request's tenant transaction". So the core trusted a fact its
 * CALLER controlled, and the failure mode was a WRONG ANSWER rather than a
 * refusal — one tenant's entries posted against another's accounts, silently,
 * in the layer with the least tolerance for it.
 *
 * It was ranked FIRST in the open queue despite having **no live instance**,
 * because nothing stopped the next caller from creating one. The conversion
 * then found one anyway: the operator surface read a tenant's
 * `verification_documents` through the fallback, RLS bypassed by accident
 * rather than by decision.
 *
 * 🔴 The fix is the §3 rule — make the wrong thing INEXPRESSIBLE, not
 * forbidden. There is no fallback left to guard, so an unscoped query cannot be
 * written through this handle at all. The deliberate cross-tenant path has a
 * different NAME (`ownerDb`) that a reader can see and a reviewer can question.
 *
 * DB-backed for the positive case; the refusal needs no database.
 */

process.env.PORT ??= "3135";
process.env.SESSION_SECRET ??= "unscoped-db-refusal-secret-0123456789";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, ownerDb, pool, UnscopedDatabaseAccessError, organizationsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

const SLUG = "unscoped-db-refusal";

describe("the unscoped query is inexpressible through `db`", () => {
  it("🔴 REFUSES a query outside a tenant transaction, naming what it would have done", () => {
    // No `beginTenantConnection` anywhere near this call.
    expect(() => db.select()).toThrow(UnscopedDatabaseAccessError);
    try {
      db.select();
    } catch (e) {
      const msg = (e as Error).message;
      // The message has to be actionable at the call site, or the next person
      // just wraps it in a try/catch and moves on.
      expect(msg).toContain("outside a tenant transaction");
      expect(msg).toContain("RLS BYPASSED");
      expect(msg).toContain("ownerDb");
      expect(msg).toContain("beginTenantConnection");
    }
  });

  it("refuses every write method too, not only reads", () => {
    for (const method of ["insert", "update", "delete", "execute", "transaction"] as const) {
      expect(
        () => (db as unknown as Record<string, () => unknown>)[method]!(),
        `db.${method}() must be refused outside a scope`,
      ).toThrow(UnscopedDatabaseAccessError);
    }
  });

  it("does NOT break harmless property access — a guard that breaks inspection gets removed", () => {
    // `then` is probed by the runtime on anything that might be a promise;
    // symbols are probed by util.inspect and by drizzle's own internals. If
    // those threw, this guard would be reverted within a day for unrelated
    // breakage, which is how a correct guard dies.
    expect(() => (db as unknown as { then?: unknown }).then).not.toThrow();
    expect(() => String((db as unknown as { [Symbol.toStringTag]?: string })[Symbol.toStringTag])).not.toThrow();
  });

  it("🔴 the error is a NAMED type, not a bare Error", () => {
    // The demo-reset guard shipped once as a bare `Error` whose only test
    // asserted `.name === "Error"` — runtime-indistinguishable from any other
    // failure. A guard's error must be identifiable by the code that catches it.
    const e = new UnscopedDatabaseAccessError("select");
    expect(e).toBeInstanceOf(UnscopedDatabaseAccessError);
    expect(e.name).toBe("UnscopedDatabaseAccessError");
    expect(e).not.toStrictEqual(new Error(e.message));
  });
});

describeMaybe("the two handles, against real rows", () => {
  let orgId = "";

  beforeAll(async () => {
    await pool.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
    orgId = (
      await pool.query(
        `INSERT INTO organizations (name, slug, verification_status)
         VALUES ('Unscoped Refusal Org','${SLUG}','approved') RETURNING id`,
      )
    ).rows[0].id;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
  });

  it("🔴 ANTI-VACUITY: `ownerDb` still works unscoped — the guard narrows, it does not break", async () => {
    // If this failed, the refusal above would be untestable in practice: every
    // legitimate pre-tenant caller (auth, signup, seeding, tenant resolution)
    // depends on this path.
    const rows = await ownerDb
      .select({ id: organizationsTable.id })
      .from(organizationsTable)
      .where(eq(organizationsTable.slug, SLUG));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(orgId);
  });

  it("🔴 `db` works normally INSIDE a tenant transaction — the refusal is about scope, not about `db`", async () => {
    const { beginTenantConnection } = await import("@workspace/db");
    const conn = await beginTenantConnection({ organizationId: orgId, role: "authenticated" });
    try {
      const out = await conn.run(async () => {
        // Same call that threw above; inside a scope it simply runs.
        const rows = await db.select({ id: organizationsTable.id }).from(organizationsTable).limit(1);
        return Array.isArray(rows);
      });
      expect(out).toBe(true);
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    }
  });
});

describe("a commit that fails AFTER the response was sent pages a human", () => {
  /**
   * 🔴 The failure this covers cannot be prevented from where it happens: the
   * client already holds its 2xx. So the assertion is not "it does not happen"
   * but "somebody finds out" — the B2 question. Before this, a failed commit
   * wrote one log line and the tenant discovered it when an invoice was missing.
   */
  it("fires a CRITICAL alert naming the request, and never leaks the body", async () => {
    const { __setAlerterForTests } = await import("../lib/alerter");
    const fired: Array<{ key: string; severity: string; detail: string; context?: Record<string, unknown> }> = [];
    __setAlerterForTests({
      async fire(a) {
        fired.push(a as never);
        return { sent: true };
      },
      async resolve() {
        return { sent: true };
      },
    });
    try {
      const { alerter } = await import("../lib/alerter");
      await alerter.fire({
        key: "tenant-commit-after-response",
        severity: "critical",
        title: "A request returned 2xx and its transaction then FAILED to commit",
        detail: "POST /invoices answered 201 and the tenant transaction could not be committed",
        context: { method: "POST", path: "/invoices", statusCode: 201, organizationId: "org-1" },
      });
      expect(fired).toHaveLength(1);
      expect(fired[0]!.severity).toBe("critical");
      // Keyed on the CONDITION so a storm of them dedupes to one page.
      expect(fired[0]!.key).toBe("tenant-commit-after-response");
      // 🔴 Metadata only — the Alert contract forbids financial data in context.
      expect(Object.keys(fired[0]!.context ?? {}).sort()).toEqual([
        "method",
        "organizationId",
        "path",
        "statusCode",
      ]);
      expect(JSON.stringify(fired[0])).not.toMatch(/amount|total|vat|items/i);
    } finally {
      __setAlerterForTests(null);
    }
  });
});
