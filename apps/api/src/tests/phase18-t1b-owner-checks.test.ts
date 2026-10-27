/**
 * 🔴 T1b — the owner's four checks before the push (owner reply of 2026-10-27,
 * item 2; register §11.32):
 *  (a) a clean-up's replica mode ends with the clean-up's own transaction: the
 *      pooled connection is back to normal afterwards, after a commit and after
 *      a failure;
 *  (c) the acting user is set per transaction on a pooled connection: on ONE
 *      connection, user A, then user B, then no one — B cannot write a row as
 *      A, and the no-user transaction inherits nobody; two requests in a row,
 *      as two users, each record their own user;
 *  (d) an action with no signed-in user records as SYSTEM (no user), on every
 *      such path, and a signed-in user's action can never record as system.
 * (b) is the census in the PR description and `demo-reset-ledger-bypass.test.ts`.
 *
 * DB-backed (sl_test / CI); skips on the DB-free placeholder.
 */
process.env.PORT ??= "3241";
process.env.SESSION_SECRET ??= "phase18-t1b-owner-checks-00001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, db, beginTenantConnection } from "@workspace/db";
import { sql } from "drizzle-orm";
import { g04Harness } from "./helpers/g04Harness";
import { replica } from "./helpers/replica";
import { auditContext } from "../lib/auditContext";
import { auditService } from "../services/audit.service";
import { __setMailerForTests } from "../lib/mailer";
import { recurringGenerationService } from "../services/recurring/generation.service";
import { findingsScheduleService } from "../services/findings.schedule.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "Phase18T1bOwnerChecksPw1!";

type PgErr = { code?: string; constraint?: string; message: string };

describeMaybe("T1b — the owner's checks: replica mode ends with its clean-up; the actor per transaction; system paths", () => {
  const h = g04Harness("p18t1bo");
  let orgId = "";
  let companyId = "";
  let adminA = 0;
  let adminB = 0;
  let customerId = 0;

  /** One tenant transaction, as the connection layer opens it, declaring `actor` (or none). */
  const tenantTx = async <T,>(actor: number | null, fn: () => Promise<T>): Promise<{ pid: number; setting: string; out: T | PgErr }> => {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated", actorUserId: actor });
    try {
      return await conn.run(async () => {
        const r = (await db.execute(sql`SELECT pg_backend_pid() AS pid, current_setting('app.current_user_id', true) AS setting`)).rows[0] as { pid: number; setting: string | null };
        let out: T | PgErr;
        try { out = await fn(); } catch (err) { out = ((err as { cause?: PgErr }).cause ?? err) as PgErr; }
        return { pid: Number(r.pid), setting: r.setting ?? "", out };
      });
    } finally {
      await conn.rollback();
    }
  };
  /** A refused statement aborts its transaction, so each forged row is tried inside its own savepoint. */
  const tryForged = async (userId: number | null, entityId: string) => {
    await db.execute(sql`SAVEPOINT forged`);
    try {
      await db.execute(sql`INSERT INTO audit_logs (organization_id, user_id, action, entity_type, entity_id) VALUES (${orgId}, ${userId}, 'create', 't1b-owner', ${entityId})`);
      await db.execute(sql`RELEASE SAVEPOINT forged`);
      return null;
    } catch (err) {
      await db.execute(sql`ROLLBACK TO SAVEPOINT forged`);
      return ((err as { cause?: PgErr }).cause ?? (err as PgErr)).constraint ?? "other";
    }
  };
  const as = <T,>(userId: number, fn: () => Promise<T>) => auditContext.run({ userId, organizationId: orgId, ipAddress: null }, fn);
  const auditUserOf = async (entityId: string) =>
    (await db.execute(sql`SELECT user_id FROM audit_logs WHERE entity_id = ${entityId}`)).rows.map((r) => (r as { user_id: number | null }).user_id);

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    companyId = await h.mkCompany(orgId, "T1b Owner Checks Co", "318181818181988");
    adminA = await h.mkUser("a", PW, orgId, "admin");
    adminB = await h.mkUser("b", PW, orgId, "admin");
    customerId = (await pool.query(`INSERT INTO customers (organization_id, name) VALUES ($1, 'T1b Owner Checks Buyer') RETURNING id`, [orgId])).rows[0].id;
    await h.start();
    expect(await h.login("a", h.email("a"), PW), "login a").toBe(200);
    expect(await h.login("b", h.email("b"), PW), "login b").toBe(200);
  }, 120_000);

  afterAll(async () => {
    __setMailerForTests(null);
    await pool.query(`DELETE FROM recurring_rules WHERE organization_id = $1`, [orgId]);
    await h.stop();
    await h.cleanup();
  });

  // ── (a) ───────────────────────────────────────────────────────────────────
  it("🔴 (a) a clean-up's replica mode ends with its own transaction: the SAME pooled connection is back to origin, after a commit and after a failure", async () => {
    const inside = (await replica(pool).query(`SELECT pg_backend_pid() AS pid, current_setting('session_replication_role') AS mode`)).rows[0];
    const afterCommit = await pool.connect();
    let after: Record<string, unknown>;
    try { after = (await afterCommit.query(`SELECT pg_backend_pid() AS pid, current_setting('session_replication_role') AS mode`)).rows[0]; } finally { afterCommit.release(); }
    const failed = await replica(pool).query(`SELECT 1 / 0`).then(() => null, (e: PgErr) => e.code);
    const afterFailure = await pool.connect();
    let later: Record<string, unknown>;
    try { later = (await afterFailure.query(`SELECT pg_backend_pid() AS pid, current_setting('session_replication_role') AS mode`)).rows[0]; } finally { afterFailure.release(); }
    expect([inside.mode, after.pid === inside.pid, after.mode, failed, later.mode]).toEqual(["replica", true, "origin", "22012", "origin"]);
  });

  // ── (c) ───────────────────────────────────────────────────────────────────
  it("🔴 (c) on ONE pooled connection: A's transaction, then B's, then one with no user — each declares its own actor; B cannot write as A; the last inherits nobody", async () => {
    const asA = await tenantTx(adminA, () => as(adminA, () => auditService.created("t1b-owner", "OC-A", { probe: true })).then(() => auditUserOf("OC-A")));
    const asB = await tenantTx(adminB, async () => {
      const forged = await tryForged(adminA, "OC-B-FORGED");
      await as(adminA, () => auditService.created("t1b-owner", "OC-B", { probe: true }));
      return { forged, recorded: await auditUserOf("OC-B") };
    });
    const asNoOne = await tenantTx(null, async () => {
      const forged = await tryForged(adminB, "OC-N-FORGED");
      await as(adminB, () => auditService.created("t1b-owner", "OC-N", { probe: true }));
      return { forged, recorded: await auditUserOf("OC-N") };
    });
    expect([asB.pid, asNoOne.pid], "the three transactions ran on one pooled connection").toEqual([asA.pid, asA.pid]);
    expect([asA.setting, asB.setting, asNoOne.setting]).toEqual([String(adminA), String(adminB), ""]);
    expect([asA.out, asB.out, asNoOne.out]).toEqual([
      [adminA],
      { forged: "audit_log_actor_from_session", recorded: [adminB] },
      { forged: "audit_log_actor_from_session", recorded: [null] },
    ]);
  });

  it("control (c): two requests in a row, as two different users, each record their own user", async () => {
    const first = await h.api("a", "PATCH", `/customers/${customerId}`, { notes: "first, by A" });
    const second = await h.api("b", "PATCH", `/customers/${customerId}`, { notes: "second, by B" });
    expect([first.status, second.status], JSON.stringify([first.body, second.body])).toEqual([200, 200]);
    const { rows } = await pool.query(
      `SELECT user_id FROM audit_logs WHERE organization_id = $1 AND entity_type = 'customer' AND entity_id = $2 AND action = 'update' ORDER BY created_at`,
      [orgId, String(customerId)]);
    expect(rows.map((r) => r.user_id)).toEqual([adminA, adminB]);
  });

  // ── (d) ───────────────────────────────────────────────────────────────────
  it("🔴 (d) a signed-in user's action can never record as system: an explicit no-user row is refused while a user is acting", async () => {
    const r = await tenantTx(adminA, () => tryForged(null, "OC-SYSTEM-FORGED"));
    expect(r.out).toBe("audit_log_actor_from_session");
  });

  it("🔴 (d) the recurring job records as system: the document it generates is audited with no user, not as the rule's creator", async () => {
    const template = { invoiceNumber: "", customerId, items: [{ description: "Monthly service", quantity: 1, unitPrice: 100, vatRate: 15 }] };
    const ruleId = (await pool.query(
      `INSERT INTO recurring_rules (organization_id, company_id, entity, template, frequency, day_of_month, starts_on, next_run_on, created_by)
       VALUES ($1, $2, 'invoice', $3, 'monthly', 1, '2026-09-01'::date, '2026-09-01'::date, $4) RETURNING id`,
      [orgId, companyId, JSON.stringify(template), adminA])).rows[0].id;
    const result = await recurringGenerationService.runOnce("2026-09-01", orgId);
    const { rows } = await pool.query(
      `SELECT a.user_id FROM audit_logs a JOIN invoices i ON a.entity_type = 'invoice' AND a.entity_id = i.id::text
        WHERE i.organization_id = $1 AND a.action = 'create'`, [orgId]);
    expect([result.generated, result.failed, rows.length > 0, rows.map((r) => r.user_id)], `rule ${ruleId}: ${JSON.stringify(result)}`)
      .toEqual([1, 0, true, rows.map(() => null)]);
  });

  it("🔴 (d) scheduled findings record as system: the run's audit row has no user", async () => {
    __setMailerForTests({ async send() { return { delivered: true }; } });
    const r = await findingsScheduleService.runOnce(new Date("2026-08-24T12:00:00Z"), orgId);
    const { rows } = await pool.query(`SELECT user_id FROM audit_logs WHERE organization_id = $1 AND entity_type = 'findings_run'`, [orgId]);
    expect([(r as { ran?: number }).ran, rows.length > 0, rows.map((x) => x.user_id)], JSON.stringify(r)).toEqual([1, true, rows.map(() => null)]);
  });

  it("🔴 (d) by construction: only the request path declares an actor; every other tenant connection in production code is system", () => {
    const src = join(__dirname, "..");
    const files: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) { if (n !== "tests" && n !== "node_modules") walk(p); } else if (p.endsWith(".ts")) files.push(p);
      }
    };
    walk(src);
    // Search shape: each `beginTenantConnection({ … })` call's own argument object, and whether it declares `actorUserId`.
    const calls = files.flatMap((f) =>
      [...readFileSync(f, "utf8").matchAll(/beginTenantConnection\(\s*\{[\s\S]*?\}\s*\)/g)].map((m) => ({ file: relative(src, f).split(sep).join("/"), text: m[0] })));
    const declaring = [...new Set(calls.filter((c) => /actorUserId/.test(c.text)).map((c) => c.file))];
    const opening = calls.length;
    // Anti-vacuity: the census sees the openers (the request path, the jobs, the scripts).
    expect([declaring, opening >= 8]).toEqual([["lib/tenant.ts"], true]);
  });
});
