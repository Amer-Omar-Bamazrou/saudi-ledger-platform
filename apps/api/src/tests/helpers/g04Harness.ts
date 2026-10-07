/**
 * The G04 suites' shared harness: an HTTP server on the real app, a cookie jar
 * per actor, tenant fixtures, and a cleanup that leaves NOTHING behind.
 *
 * 🔴 The cleanup removes EVERY row of the suite's organizations from EVERY
 * table that carries `organization_id`, in one transaction, before the
 * organizations themselves. Triggers are set aside (`session_replication_role
 * = replica`) because posted rows are append-only at the database — which also
 * sets the foreign keys aside, so a cleanup that deleted only SOME tables would
 * leave children pointing at nothing (how the local database came to hold
 * ~9.5k such rows; docs/test-suite-notes.md #9). Deleting every org-scoped
 * table is the shape that cannot orphan a row of the suite's own tenants.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import http from "node:http";
import bcrypt from "bcryptjs";
import { pool, beginTenantConnection, PERMISSION_MATRIX } from "@workspace/db";
import { primePermissionCache } from "../../lib/rbac";
import { auditContext } from "../../lib/auditContext";

export type Res = { status: number; body: any };

export function g04Harness(prefix: string) {
  const state = { server: null as http.Server | null, base: "" };
  const jar: Record<string, string> = {};
  const ORGS = `(SELECT id FROM organizations WHERE slug LIKE '${prefix}-%')`;
  const USERS = `(SELECT id FROM users WHERE email LIKE '${prefix}-%')`;
  const email = (k: string) => `${prefix}-${k}@test.local`;

  async function start(): Promise<void> {
    const app = (await import("../../app")).default;
    primePermissionCache(PERMISSION_MATRIX);
    state.server = http.createServer(app);
    await new Promise<void>((resolve) => state.server!.listen(0, "127.0.0.1", () => resolve()));
    const addr = state.server.address();
    state.base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/api`;
  }

  async function stop(): Promise<void> {
    if (state.server) await new Promise<void>((resolve) => state.server!.close(() => resolve()));
  }

  async function api(who: string, method: string, path: string, body?: unknown): Promise<Res> {
    const res = await fetch(`${state.base}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(jar[who] ? { cookie: jar[who] } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sid = ((res.headers as any).getSetCookie?.() ?? []).find((c: string) => c.startsWith("ksa_ledger_sid="));
    if (sid) jar[who] = sid.split(";")[0];
    const text = await res.text();
    let json: any;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json };
  }

  async function login(who: string, mail: string, password: string): Promise<number> {
    delete jar[who];
    return (await api(who, "POST", "/auth/login", { email: mail, password })).status;
  }

  async function cleanup(): Promise<void> {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL session_replication_role = replica");
      const tables = (await c.query(
        `SELECT DISTINCT c.table_name FROM information_schema.columns c
           JOIN information_schema.tables t ON t.table_name = c.table_name AND t.table_schema = c.table_schema
          WHERE c.table_schema = 'public' AND c.column_name = 'organization_id' AND t.table_type = 'BASE TABLE'
            AND c.table_name NOT IN ('organizations')`,
      )).rows.map((r) => r.table_name as string);
      for (const t of tables) await c.query(`DELETE FROM "${t}" WHERE organization_id IN ${ORGS}`);
      await c.query(`DELETE FROM security_audit_logs WHERE actor_user_id IN ${USERS} OR target_user_id IN ${USERS}`);
      await c.query(`DELETE FROM organization_memberships WHERE user_id IN ${USERS}`);
      await c.query(`DELETE FROM platform_operators WHERE user_id IN ${USERS}`);
      await c.query(`DELETE FROM user_sessions WHERE (sess ->> 'userId')::int IN ${USERS}`);
      await c.query(`DELETE FROM organizations WHERE slug LIKE '${prefix}-%'`);
      await c.query(`DELETE FROM users WHERE email LIKE '${prefix}-%'`);
      await c.query("COMMIT");
    } catch (err) {
      await c.query("ROLLBACK");
      throw err;
    } finally {
      c.release();
    }
  }

  const mkOrg = async (key: string, status = "approved") =>
    (await pool.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ($1,$2,$3) RETURNING id`, [`${prefix} ${key}`, `${prefix}-${key}`, status])).rows[0].id as string;
  const mkCompany = async (orgId: string, name: string, vat: string) =>
    (await pool.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number, fiscal_year_start) VALUES ($1,$2,'1010404040',$3,1) RETURNING id`, [orgId, name, vat])).rows[0].id as string;
  /** A user, and — when `orgId` is given — its membership (raw SQL: a FIXTURE, not the product's provisioning path). */
  const mkUser = async (key: string, password: string, orgId: string | null, role = "admin", status = "active") => {
    const id = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1,$2,$3,'viewer',true) RETURNING id`, [email(key), `${prefix} ${key}`, await bcrypt.hash(password, 4)])).rows[0].id as number;
    if (orgId) await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,$3,$4)`, [id, orgId, role, status]);
    return id;
  };

  /** Run `fn` inside a tenant transaction as the app role — the request's own conditions, without HTTP. */
  async function inTenant<T>(orgId: string, companyId: string, userId: number, fn: () => Promise<T>): Promise<T> {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
    try {
      const out = await conn.run(() => auditContext.run({ userId, organizationId: orgId, ipAddress: null }, fn));
      await conn.commit();
      return out;
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  }

  return { state, api, login, cleanup, start, stop, email, mkOrg, mkCompany, mkUser, inTenant, ORGS, USERS };
}
