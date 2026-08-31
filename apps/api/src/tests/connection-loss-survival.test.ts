/**
 * A LOST DATABASE CONNECTION MUST NOT KILL THE API PROCESS.
 *
 * ── 🔴 THE INCIDENT (2026-08-31) ───────────────────────────────────────────
 * Giving the browser fixture real data for the first time made the scheduled
 * findings run do real work: it called the AI provider once per open finding,
 * **inside an open tenant transaction**. The deliberate
 * `idle_in_transaction_session_timeout = '15s'` guardrail fired, as designed,
 * and terminated the connection.
 *
 * Then the API **died**. `node-postgres` emits `error` on the client, an
 * `error` event with no listener is fatal in Node (`throw er`), and every
 * request after that was ECONNREFUSED. 62 of 153 browser tests failed, none of
 * them for the reason they named.
 *
 * 🔴 **A guardrail designed to kill a TRANSACTION was killing the SERVER** —
 * and that generalises past this one bug. Every defence that works by severing
 * a connection had the same amplifier behind it: a database restart, a
 * failover, a network blip, an admin `pg_terminate_backend`. None of those is
 * exotic; all of them are Tuesday.
 *
 * ── 🔴 WHY THE FIRST FIX WAS NOT ENOUGH, WHICH IS THE REUSABLE PART ────────
 * The standard advice is `pool.on("error", ...)`, and it was applied — and the
 * next full browser run crashed **identically**. `pool.on("error")` covers
 * clients sitting IDLE in the pool. A client that is CHECKED OUT emits `error`
 * on itself, the pool does not forward it, and the process still dies.
 *
 * The fix that works attaches a listener to the checked-out client too. The
 * lesson is the older one, applied to a hardening change: *re-run the thing you
 * just hardened.* A fix believed-correct and un-rerun would have shipped, and
 * the crash it was written for would have remained.
 *
 * ── WHAT THIS ASSERTS ──────────────────────────────────────────────────────
 * The condition itself, not a proxy for it: a tenant transaction is opened, its
 * backend is terminated from a second connection, and the process is required
 * to still be here afterwards — with the in-flight query REJECTING rather than
 * resolving, because a query against a dead connection that appears to succeed
 * would be worse than a crash.
 *
 * ── 🔴 HOW THIS TEST FAILS, AND WHY THAT IS WORTH KNOWING ─────────────────
 * Fault-injected before being trusted (the listener removed, then restored),
 * and the result is a live instance of the standing rule about verdicts:
 *
 *     Tests  2 passed (2)      ← both assertions still held
 *     Errors 1 error           ← "Connection terminated unexpectedly"
 *     exit code 1
 *
 * Under vitest the process does not die — the runner installs its own process
 * error handlers — so the failure surfaces as an UNHANDLED ERROR beside a
 * green test count. **Read `Test Files` and the exit code, never `Tests`.**
 * In production there is no runner to catch it and the process simply exits,
 * which is what happened.
 *
 * DB-backed; skips on the DB-free placeholder.
 */

process.env.PORT ??= "3163";
process.env.SESSION_SECRET ??= "connection-loss-secret-0123456789abcdef";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

const SLUG = "connection-loss";

describeMaybe("a lost connection does not take the process with it", () => {
  let orgId = "";
  let companyId = "";

  const wipe = async () => {
    const org = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
    await pool.query(`DELETE FROM categories WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM companies WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
  };

  beforeAll(async () => {
    await wipe();
    orgId = (
      await pool.query(
        `INSERT INTO organizations (name, slug, verification_status)
         VALUES ('Conn Loss Org','${SLUG}','approved') RETURNING id`,
      )
    ).rows[0].id;
    companyId = (
      await pool.query(`INSERT INTO companies (organization_id, name) VALUES ($1,'Conn Loss Co') RETURNING id`, [orgId])
    ).rows[0].id;
  });

  afterAll(wipe);

  it("🔴 the process SURVIVES its tenant connection being terminated mid-transaction", async () => {
    const { beginTenantConnection, db, categoriesTable } = await import("@workspace/db");
    const { sql } = await import("drizzle-orm");
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });

    // Force the connection to actually open and identify itself. A lazily
    // acquired client that never ran a query would have no backend to kill,
    // and the test would pass having exercised nothing.
    const pid = await conn.run(async () => {
      await db.select().from(categoriesTable).limit(1);
      const r = await db.execute(sql`SELECT pg_backend_pid() AS pid`);
      const rows = (r as unknown as { rows: { pid: number }[] }).rows;
      return Number(rows[0].pid);
    });
    expect(pid, "no backend pid — the tenant connection never opened").toBeGreaterThan(0);

    // Terminate it from OUTSIDE, exactly as the idle-in-transaction guardrail,
    // a failover, or an operator would.
    await pool.query(`SELECT pg_terminate_backend($1)`, [pid]);

    // The next use of that connection must REJECT. It must not resolve, and it
    // must not take the process down — if the listener were missing, this file
    // would not report a failure at all; the runner would simply die.
    await expect(
      conn.run(async () => {
        await db.select().from(categoriesTable).limit(1);
      }),
      "a query on a terminated connection did not reject — a silent success here " +
        "would be worse than the crash it replaced",
    ).rejects.toThrow();

    await conn.rollback().catch(() => {
      // Rolling back a dead connection throws; that is expected and is not
      // what this test is about.
    });

    // The assertion that the whole file exists for: we are still running.
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("the pool keeps working afterwards — a dead client is discarded, not poisoned", async () => {
    // Anti-vacuity for the test above: proving we survived is only meaningful
    // if the process is still USEFUL, not merely alive.
    const r = await pool.query(`SELECT 1 AS ok`);
    expect(r.rows[0].ok).toBe(1);

    const { beginTenantConnection, db, categoriesTable } = await import("@workspace/db");
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
    const rows = await conn.run(() => db.select().from(categoriesTable).limit(1));
    await conn.commit();
    expect(Array.isArray(rows)).toBe(true);
  });
});
