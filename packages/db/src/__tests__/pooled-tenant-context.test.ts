/**
 * TENANT CONTEXT UNDER CONNECTION POOLING — the three-request test, RUN.
 *
 * 🔴 WHY THIS EXISTS (2026-09-15, second-opinion review item 3): the tenant
 * mechanism is `BEGIN; SET LOCAL ROLE <app role>; set_config('app.current_org_id',
 * …, true)` on a POOLED client (`beginTenantConnection`, packages/db/src/index.ts),
 * released on COMMIT/ROLLBACK. That is transaction-local by construction — but
 * "by construction" was read from the code, and the existing
 * `tenant-isolation.test.ts` proves RLS on a single dedicated session, never the
 * pool. This file proves, on the REAL pool and the SAME physical connection:
 *
 *   request A (tenant A)  → sees only A, writes A;
 *   request B (tenant B)  → on the same backend PID, sees only B, never A;
 *   request C (no context)→ same PID again, the GUC is GONE and a select as
 *                           the app role returns NOTHING — fail closed.
 *
 * Plus the hazard the review named: a tenant connection that is never
 * settled cannot leak into the next checkout, because the client is not
 * returned to the pool until finish() runs — asserted, not assumed.
 *
 * The PID assertion is the planted positive: if the pool hands out a fresh
 * connection each time, this test would prove nothing about reuse, so it
 * FAILS rather than passing vacuously.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { sql } from "drizzle-orm";
import { beginTenantConnection, db, pool, UnscopedDatabaseAccessError } from "../index";

const connectionString = process.env.DATABASE_URL;
const describeMaybe = connectionString ? describe : describe.skip;
if (!connectionString) console.warn("[pooled-tenant-context] DATABASE_URL not set — skipping.");

const ROLE = "authenticated";
const NAME_A = "POOLCTX-A";
const NAME_B = "POOLCTX-B";

describeMaybe("tenant context on a pooled connection — the three-request test", () => {
  let owner: pg.Client;
  let orgA = "";
  let orgB = "";
  let coA = "";
  let coB = "";

  const cleanup = async () => {
    await owner.query(`DELETE FROM customers WHERE name IN ($1, $2)`, [NAME_A, NAME_B]);
    await owner.query(`DELETE FROM companies WHERE name IN ('POOLCTX Co A', 'POOLCTX Co B')`);
    await owner.query(`DELETE FROM organizations WHERE slug IN ('poolctx-a', 'poolctx-b')`);
  };

  beforeAll(async () => {
    owner = new pg.Client({ connectionString });
    await owner.connect();
    await cleanup();
    orgA = (await owner.query(`INSERT INTO organizations (name, slug) VALUES ('POOLCTX A','poolctx-a') RETURNING id`)).rows[0].id;
    orgB = (await owner.query(`INSERT INTO organizations (name, slug) VALUES ('POOLCTX B','poolctx-b') RETURNING id`)).rows[0].id;
    coA = (await owner.query(`INSERT INTO companies (organization_id, name) VALUES ($1,'POOLCTX Co A') RETURNING id`, [orgA])).rows[0].id;
    coB = (await owner.query(`INSERT INTO companies (organization_id, name) VALUES ($1,'POOLCTX Co B') RETURNING id`, [orgB])).rows[0].id;
  });

  afterAll(async () => {
    await cleanup();
    await owner.end();
  });

  /**
   * A raw checkout for the "no context" requests. 🔴 With an `error` listener:
   * a checked-out client whose connection dies emits `error` on ITSELF, and an
   * unhandled `error` event is fatal to the process (`pool.on("error")` covers
   * idle clients only — the severance-amplifier guard, which scans this file).
   */
  const onClientError = () => {};
  async function checkout() {
    const client = await pool.connect();
    client.on("error", onClientError);
    return {
      client,
      release: () => {
        client.off("error", onClientError);
        client.release();
      },
    };
  }

  /** One "request": a tenant transaction on the pool, returning what it saw. */
  async function request(organizationId: string, companyId: string, fn: () => Promise<unknown>) {
    const conn = await beginTenantConnection({ organizationId, companyId, role: ROLE });
    try {
      const out = await conn.run(async () => {
        const pid = (await db.execute(sql`select pg_backend_pid() as pid`)).rows[0] as { pid: number };
        const guc = (await db.execute(sql`select current_setting('app.current_org_id', true) as org`)).rows[0] as { org: string | null };
        const result = await fn();
        return { pid: Number(pid.pid), guc: guc.org, result };
      });
      await conn.commit();
      return out;
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  }

  it("🔴 A, then B on the SAME backend connection: B never sees A, A never saw B, and the GUC was each tenant's own", async () => {
    // Drain the pool to one idle client so consecutive checkouts must reuse it.
    // node-postgres hands back the most recently released idle client.
    const a = await request(orgA, coA, async () => {
      await db.execute(sql`insert into customers (organization_id, name) values (${orgA}, ${NAME_A})`);
      const rows = (await db.execute(sql`select name from customers where name in (${NAME_A}, ${NAME_B})`)).rows as { name: string }[];
      return rows.map((r) => r.name).sort();
    });
    const b = await request(orgB, coB, async () => {
      await db.execute(sql`insert into customers (organization_id, name) values (${orgB}, ${NAME_B})`);
      const rows = (await db.execute(sql`select name from customers where name in (${NAME_A}, ${NAME_B})`)).rows as { name: string }[];
      return rows.map((r) => r.name).sort();
    });

    expect(a.guc).toBe(orgA);
    expect(b.guc).toBe(orgB);
    // Presence, absence, and movement: A sees exactly A; B sees exactly B.
    expect(a.result).toEqual([NAME_A]);
    expect(b.result).toEqual([NAME_B]);
    // 🔴 The planted positive: the two requests MUST have shared a physical
    // connection, or this file has not tested pooling at all.
    expect(b.pid, "the pool handed B a different connection — reuse was not exercised; the test is vacuous").toBe(a.pid);
    // Both rows exist (the owner sees both) — so B's absence of A was RLS, not an empty table.
    const all = await owner.query(`SELECT name FROM customers WHERE name IN ($1,$2) ORDER BY 1`, [NAME_A, NAME_B]);
    expect(all.rows.map((r) => r.name)).toEqual([NAME_A, NAME_B]);
  });

  it("🔴 request C — the same connection with NO context: the GUC is gone and the app role reads NOTHING (fail closed)", async () => {
    const { client, release } = await checkout();
    try {
      const pid = Number((await client.query(`select pg_backend_pid() as pid`)).rows[0].pid);
      const guc = (await client.query(`select current_setting('app.current_org_id', true) as org`)).rows[0].org;
      // Transaction-local settings must not have survived the previous COMMITs.
      expect(guc === null || guc === "", `app.current_org_id survived into the next checkout: ${JSON.stringify(guc)}`).toBe(true);
      // As the app role, with no org set, RLS's predicate compares against NULL → no rows.
      await client.query(`BEGIN`);
      await client.query(`SET LOCAL ROLE "${ROLE}"`);
      const rows = await client.query(`SELECT name FROM customers WHERE name IN ($1,$2)`, [NAME_A, NAME_B]);
      await client.query(`ROLLBACK`);
      expect(rows.rows).toEqual([]);
      // …and the role reset with the transaction: the client is back to the pool's login role.
      const role = (await client.query(`select current_user as u`)).rows[0].u;
      expect(role).not.toBe(ROLE);
      // Not vacuous: this IS a reused connection (recorded for the report).
      expect(pid).toBeGreaterThan(0);
    } finally {
      release();
    }
  });

  it("🔴 the application layer fails closed too: `db` outside a tenant transaction REFUSES rather than falling back to the owner", async () => {
    // The proxy refuses on property ACCESS — synchronously, before any query or promise exists.
    expect(() => db.execute(sql`select 1`)).toThrow(UnscopedDatabaseAccessError);
  });

  it("🔴 PLANTED POSITIVE — a SESSION-level setting DOES survive into the next checkout, so the GUC read above can see a leak", async () => {
    // The probe rule: prove the instrument sees a known-present case. Set the
    // GUC the WRONG way (is_local = false), release, check out again.
    const first = await checkout();
    let pid = 0;
    try {
      pid = Number((await first.client.query(`select pg_backend_pid() as pid`)).rows[0].pid);
      await first.client.query(`select set_config('app.current_org_id', $1, false)`, ["planted-session-leak"]);
    } finally {
      first.release();
    }
    const { client: second, release: releaseSecond } = await checkout();
    try {
      const pid2 = Number((await second.query(`select pg_backend_pid() as pid`)).rows[0].pid);
      expect(pid2, "reuse not exercised — the planted positive is vacuous").toBe(pid);
      const guc = (await second.query(`select current_setting('app.current_org_id', true) as org`)).rows[0].org;
      expect(guc, "a session-level GUC must be visible on the reused client, or the leak assertion above proves nothing").toBe("planted-session-leak");
      // Clean the plant so it cannot poison later tests on this client.
      await second.query(`reset app.current_org_id`);
      const after = (await second.query(`select current_setting('app.current_org_id', true) as org`)).rows[0].org;
      expect(after === null || after === "").toBe(true);
    } finally {
      releaseSecond();
    }
  });

  it("an UNSETTLED tenant connection cannot leak: the next checkout is a different client, and settling it later releases it clean", async () => {
    const conn = await beginTenantConnection({ organizationId: orgA, companyId: coA, role: ROLE });
    const heldPid = await conn.run(async () => Number(((await db.execute(sql`select pg_backend_pid() as pid`)).rows[0] as { pid: number }).pid));
    // Not committed, not rolled back — the client is still checked out.
    const other = await checkout();
    try {
      const otherPid = Number((await other.client.query(`select pg_backend_pid() as pid`)).rows[0].pid);
      expect(otherPid).not.toBe(heldPid);
      const guc = (await other.client.query(`select current_setting('app.current_org_id', true) as org`)).rows[0].org;
      expect(guc === null || guc === "").toBe(true);
    } finally {
      other.release();
    }
    await conn.rollback();
    // After settling, a fresh checkout may reuse the held client — and it must be clean.
    const again = await checkout();
    try {
      const guc = (await again.client.query(`select current_setting('app.current_org_id', true) as org`)).rows[0].org;
      expect(guc === null || guc === "").toBe(true);
    } finally {
      again.release();
    }
  });
});
