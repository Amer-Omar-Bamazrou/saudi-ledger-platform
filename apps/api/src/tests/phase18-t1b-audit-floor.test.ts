/**
 * 🔴 T1b (Phase 18; G24, G25; DR-09 "trigger now", owner 2026-10-24 evening;
 * final-run memo 2026-10-27 §2 A and §1.3; contract AU-1, AU-2):
 *   - the two audit tables cannot be updated, deleted or truncated by ANY role,
 *     the owner included; replica mode is the only bypass;
 *   - an audit row names the connection's declared actor and no one else;
 *   - a CLOSED month's lock cannot be deleted, or the locks truncated, by any role.
 *
 * DB-backed (sl_test / CI); skips on the DB-free placeholder.
 */
process.env.PORT ??= "3237";
process.env.SESSION_SECRET ??= "phase18-t1b-audit-floor-0000001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, db, beginTenantConnection } from "@workspace/db";
import { sql } from "drizzle-orm";
import { g04Harness } from "./helpers/g04Harness";
import { auditContext } from "../lib/auditContext";
import { auditService } from "../services/audit.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "Phase18T1bAuditFloorPw1!";

type Client = { query: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, any>>; rowCount?: number | null }>; release: () => void };
type PgErr = { code?: string; constraint?: string; message: string };

describeMaybe("T1b — the audit floor binds every role; the actor comes from the connection; closed locks stay", () => {
  const h = g04Harness("p18t1b");
  let orgId = "";
  let companyId = "";
  let adminId = 0;
  let otherId = 0;

  /** Run `fn` on one owner connection in a transaction that is ALWAYS rolled back; the error, if any. */
  const rolledBack = async (fn: (c: Client) => Promise<unknown>): Promise<PgErr | null> => {
    const c = (await pool.connect()) as unknown as Client;
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL lock_timeout = '10s'");
      await fn(c);
      return null;
    } catch (err) {
      return err as PgErr;
    } finally {
      await c.query("ROLLBACK").catch(() => {});
      c.release();
    }
  };
  /** As the request's own role, in this tenant, with `actor` declared the way the connection layer declares it. */
  const asAppActing = (actor: number | null, sql: string, values: unknown[] = []) => rolledBack(async (c) => {
    await c.query("SET LOCAL ROLE authenticated");
    await c.query("SELECT set_config('app.current_org_id', $1, true)", [orgId]);
    await c.query("SELECT set_config('app.current_company_id', $1, true)", [companyId]);
    await c.query("SELECT set_config('app.current_user_id', $1, true)", [actor == null ? "" : String(actor)]);
    await c.query(sql, values);
  });
  const auditRow = async (c: Client, entityId: string) =>
    (await c.query(`INSERT INTO audit_logs (organization_id, action, entity_type, entity_id) VALUES ($1, 'create', 't1b', $2) RETURNING id`, [orgId, entityId])).rows[0].id as string;
  const securityRow = async (c: Client) =>
    (await c.query(`INSERT INTO security_audit_logs (organization_id, action) VALUES ($1, 't1b.probe') RETURNING id`, [orgId])).rows[0].id as string;
  /**
   * TRUNCATE is proven in two halves, never on the shared table itself: a real
   * TRUNCATE takes an ACCESS EXCLUSIVE lock that would stall every other test
   * file writing audit rows. (1) The table carries an ordinary BEFORE TRUNCATE
   * statement trigger running `fn` (so replica mode is its only bypass); (2)
   * `fn` refuses a TRUNCATE, on a temporary table it is attached to.
   */
  const truncateTrigger = async (table: string) =>
    (await pool.query(
      `SELECT p.proname AS fn, t.tgenabled AS enabled
         FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
        WHERE t.tgrelid = $1::regclass AND NOT t.tgisinternal
          AND (t.tgtype & 32) <> 0 AND (t.tgtype & 2) <> 0 AND (t.tgtype & 1) = 0`, [table])).rows.map((r) => `${r.fn}:${r.enabled}`);
  const truncateRefusedBy = (fn: string) => rolledBack(async (c) => {
    await c.query(`CREATE TEMP TABLE t1b_truncate_probe (id int) ON COMMIT DROP`);
    await c.query(`CREATE TRIGGER t1b_truncate_probe_trg BEFORE TRUNCATE ON t1b_truncate_probe FOR EACH STATEMENT EXECUTE FUNCTION ${fn}()`);
    await c.query(`TRUNCATE t1b_truncate_probe`);
  });

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    companyId = await h.mkCompany(orgId, "T1b Audit Floor Co", "318181818181944");
    adminId = await h.mkUser("admin", PW, orgId, "admin");
    otherId = await h.mkUser("other", PW, orgId, "accountant");
    await h.start();
    expect(await h.login("admin", h.email("admin"), PW), "login admin").toBe(200);
  }, 120_000);

  afterAll(async () => { await h.stop(); await h.cleanup(); });

  // ── AU-1 (G24): append-only for EVERY role ─────────────────────────────────

  it("🔴 AU-1: the OWNER cannot UPDATE or DELETE an audit_logs row", async () => {
    const update = await rolledBack(async (c) => { const id = await auditRow(c, "T1B-U"); await c.query(`UPDATE audit_logs SET action = 'tampered' WHERE id = $1`, [id]); });
    const del = await rolledBack(async (c) => { const id = await auditRow(c, "T1B-D"); await c.query(`DELETE FROM audit_logs WHERE id = $1`, [id]); });
    expect([update?.constraint, del?.constraint], [update?.message, del?.message].join(" | "))
      .toEqual(["audit_log_append_only", "audit_log_append_only"]);
  });

  it("🔴 AU-1: the OWNER cannot UPDATE or DELETE a security_audit_logs row", async () => {
    const update = await rolledBack(async (c) => { const id = await securityRow(c); await c.query(`UPDATE security_audit_logs SET action = 'tampered' WHERE id = $1`, [id]); });
    const del = await rolledBack(async (c) => { const id = await securityRow(c); await c.query(`DELETE FROM security_audit_logs WHERE id = $1`, [id]); });
    expect([update?.constraint, del?.constraint], [update?.message, del?.message].join(" | "))
      .toEqual(["audit_log_append_only", "audit_log_append_only"]);
  });

  it("🔴 AU-1: neither audit table can be TRUNCATEd — an ordinary BEFORE TRUNCATE trigger on each, whose function refuses", async () => {
    const attached = [await truncateTrigger("audit_logs"), await truncateTrigger("security_audit_logs")];
    const refused = await truncateRefusedBy("zz_audit_append_only");
    expect([attached, refused?.constraint], refused?.message)
      .toEqual([[["zz_audit_append_only:O"], ["zz_audit_append_only:O"]], "audit_log_append_only"]);
  });

  it("control: replica mode is the one bypass — the owner in replica mode deletes an audit row; the app role is still refused by privilege", async () => {
    const replica = await rolledBack(async (c) => {
      const a = await auditRow(c, "T1B-R");
      const s = await securityRow(c);
      await c.query("SET LOCAL session_replication_role = replica");
      const n = (await c.query(`DELETE FROM audit_logs WHERE id = $1`, [a])).rowCount;
      const m = (await c.query(`DELETE FROM security_audit_logs WHERE id = $1`, [s])).rowCount;
      if (n !== 1 || m !== 1) throw new Error(`replica delete removed ${n} and ${m} rows`);
    });
    const app = await asAppActing(null, `DELETE FROM audit_logs WHERE organization_id = $1`, [orgId]);
    expect([replica?.message ?? null, app?.code], app?.message).toEqual([null, "42501"]);
  });

  // ── AU-2 (G25): the actor is the connection's, never the writer's ──────────

  it("🔴 AU-2: a raw app-role row naming another user than the declared actor is refused; naming a user with no actor declared is refused", async () => {
    const forged = await asAppActing(adminId, `INSERT INTO audit_logs (organization_id, user_id, action, entity_type, entity_id) VALUES ($1, $2, 'create', 't1b', 'T1B-FORGE')`, [orgId, otherId]);
    const unowned = await asAppActing(null, `INSERT INTO audit_logs (organization_id, user_id, action, entity_type, entity_id) VALUES ($1, $2, 'create', 't1b', 'T1B-NOACTOR')`, [orgId, otherId]);
    const own = await asAppActing(adminId, `INSERT INTO audit_logs (organization_id, user_id, action, entity_type, entity_id) VALUES ($1, $2, 'create', 't1b', 'T1B-OWN')`, [orgId, adminId]);
    expect([forged?.constraint, unowned?.constraint, own?.message ?? null], [forged?.message, unowned?.message].join(" | "))
      .toEqual(["audit_log_actor_from_session", "audit_log_actor_from_session", null]);
  });

  it("🔴 AU-2: a row that names no user takes the declared actor — the writer never chooses it", async () => {
    let named: number | null | undefined;
    const err = await rolledBack(async (c) => {
      await c.query("SET LOCAL ROLE authenticated");
      await c.query("SELECT set_config('app.current_org_id', $1, true)", [orgId]);
      await c.query("SELECT set_config('app.current_user_id', $1, true)", [String(adminId)]);
      named = (await c.query(`INSERT INTO audit_logs (organization_id, action, entity_type, entity_id) VALUES ($1, 'create', 't1b', 'T1B-DEFAULT') RETURNING user_id`, [orgId])).rows[0].user_id;
    });
    expect([err?.message ?? null, named]).toEqual([null, adminId]);
  });

  it("🔴 AU-2: the audit service on a connection declared for one user records THAT user, whatever its own context says", async () => {
    // `actorUserId` is the connection layer's declaration of who is acting (on main the field does not exist, so it is ignored).
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated", actorUserId: adminId } as Parameters<typeof beginTenantConnection>[0]);
    let recorded: unknown[] = [];
    try {
      await conn.run(() => auditContext.run({ userId: otherId, organizationId: orgId, ipAddress: null }, () => auditService.created("t1b", "T1B-SERVICE", { probe: true })));
      recorded = await conn.run(async () =>
        (await db.execute(sql`SELECT user_id FROM audit_logs WHERE entity_id = 'T1B-SERVICE'`)).rows.map((r) => (r as { user_id: number | null }).user_id));
    } catch (err) {
      recorded = [`threw: ${(err as Error).message}`];
    } finally {
      await conn.rollback();
    }
    expect(recorded).toEqual([adminId]);
  });

  it("control: a request's audit row names the session's user (the request path declares its actor)", async () => {
    const r = await h.api("admin", "POST", "/customers", { name: "T1b Audit Customer" });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const { rows } = await pool.query(`SELECT user_id FROM audit_logs WHERE organization_id = $1 AND entity_type = 'customer' AND entity_id = $2`, [orgId, String(r.body.id)]);
    expect(rows.map((x) => x.user_id)).toEqual([adminId]);
  });

  // ── A closed month's lock (T1e interpretation 2, owner 2026-10-27 §1.3) ─────

  it("🔴 a CLOSED month's lock cannot be deleted by the owner, and period_locks cannot be truncated", async () => {
    const closed = await h.api("admin", "POST", "/period-locks", { period: "2026-02" });
    expect(closed.status, JSON.stringify(closed.body)).toBe(201);
    const del = await rolledBack(async (c) => { await c.query(`DELETE FROM period_locks WHERE id = $1`, [closed.body.id]); });
    const attached = await truncateTrigger("period_locks");
    const trunc = await truncateRefusedBy("zz_period_locks_closed_undeletable");
    expect([del?.constraint, attached, trunc?.constraint], [del?.message, trunc?.message].join(" | "))
      .toEqual(["period_lock_closed_undeletable", ["zz_period_locks_closed_undeletable:O"], "period_lock_closed_undeletable"]);
  });

  it("control: replica mode deletes a closed lock; the request's role still has no DELETE; the reasoned reopen still works", async () => {
    const closed = await h.api("admin", "POST", "/period-locks", { period: "2026-07" });
    expect(closed.status, JSON.stringify(closed.body)).toBe(201);
    const replica = await rolledBack(async (c) => {
      await c.query("SET LOCAL session_replication_role = replica");
      const n = (await c.query(`DELETE FROM period_locks WHERE id = $1`, [closed.body.id])).rowCount;
      if (n !== 1) throw new Error(`replica delete removed ${n} rows`);
    });
    const app = await asAppActing(adminId, `DELETE FROM period_locks WHERE id = $1`, [closed.body.id]);
    const reopen = await h.api("admin", "POST", "/period-locks/2026-07/reopen", { reason: "T1b control: the reasoned reopen" });
    expect([replica?.message ?? null, app?.code, reopen.status], JSON.stringify(reopen.body)).toEqual([null, "42501", 200]);
  });
});
