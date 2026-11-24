/**
 * 🔴 19B S2c — MEMBER SECURITY: "own sessions only" for every role but the admin (v4 §6.1 D2).
 *
 * Member security (a session's IP address, a member's email in a security trail or a session list) is served only on
 * routes that run before an organization role is resolved, so the response seam cannot decide it by the role's grants
 * (seam.ts: no organization role reads it as served). What keeps it to "own sessions only" is each route's OWN gate:
 *
 *  - `GET /auth/sessions` serves the caller's own sessions, and nothing else;
 *  - every route that serves ANOTHER member's member security refuses a non-admin: the members' sessions, the
 *    organization's security events, the member list (its emails).
 * This test holds those gates for the viewer, the bookkeeper and the accountant, with the admin's presence. A route
 * added tomorrow that serves another member's member security without such a gate is the case this cannot see by
 * itself — the class table's `member_security` rows on `users` name the nodes (SecurityEvent, SessionRecord,
 * SessionUser), and the S2c review lists the routes that serve them.
 * DB-backed; skips on the placeholder.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, PERMISSION_MATRIX } from "@workspace/db";
import { primePermissionCache } from "../lib/rbac";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const describeDb = !!url && !url.includes("placeholder") ? describe : describe.skip;
const PW = "s2c-member-security-password-2026";
const h = g04Harness("s2c-ms");
const NON_ADMINS = ["viewer", "bookkeeper", "accountant"] as const;

describeDb("19B S2c — member security: own sessions only, but for the admin", () => {
  let orgId = "";
  const userIds: Record<string, number> = {};

  beforeAll(async () => {
    await h.cleanup();
    await h.start();
    primePermissionCache(PERMISSION_MATRIX);
    orgId = await h.mkOrg("org");
    await h.mkCompany(orgId, "S2c Members Co", "319797979797983");
    for (const role of ["admin", ...NON_ADMINS]) userIds[role] = await h.mkUser(role, PW, orgId, role);
    for (const role of ["admin", ...NON_ADMINS]) expect(await h.login(role, h.email(role), PW), role).toBe(200);
  }, 120_000);
  afterAll(async () => { await h.stop(); await h.cleanup(); });

  it("🔴 each role's own session list carries its own sessions only — never another member's", async () => {
    for (const who of ["admin", ...NON_ADMINS]) {
      const r = await h.api(who, "GET", "/auth/sessions");
      expect([who, r.status]).toEqual([who, 200]);
      const own = new Set((await pool.query(`SELECT id::text FROM session_records WHERE user_id = $1`, [userIds[who]])).rows.map((x) => x.id as string));
      const others = (await pool.query(`SELECT id::text FROM session_records WHERE user_id = ANY($1) AND user_id <> $2`, [Object.values(userIds), userIds[who]])).rows.map((x) => x.id as string);
      const served = (r.body.sessions as { id: string | number }[]).map((s) => String(s.id));
      expect([who, served.length > 0, served.every((id) => own.has(id))]).toEqual([who, true, true]);
      expect([who, others.length > 0, others.filter((id) => r.text.includes(id))]).toEqual([who, true, []]);
    }
  });

  it("🔴 another member's sessions, the security trail and the member list (emails) refuse the viewer, the bookkeeper and the accountant", async () => {
    const routes = ["/auth/sessions/members", `/orgs/${orgId}/security-events`, `/orgs/${orgId}/members`];
    for (const who of NON_ADMINS) {
      for (const path of routes) {
        const r = await h.api(who, "GET", path);
        expect([who, path, r.status]).toEqual([who, path, 403]);
        for (const other of ["admin", ...NON_ADMINS].filter((x) => x !== who)) expect([who, path, r.text.includes(h.email(other))]).toEqual([who, path, false]);
      }
    }
  });

  it("presence: the admin reads each of them, every member's email included", async () => {
    for (const path of ["/auth/sessions/members", `/orgs/${orgId}/security-events`, `/orgs/${orgId}/members`]) {
      expect([path, (await h.api("admin", "GET", path)).status]).toEqual([path, 200]);
    }
    const members = await h.api("admin", "GET", `/orgs/${orgId}/members`);
    for (const who of NON_ADMINS) expect([who, members.text.includes(h.email(who))]).toEqual([who, true]);
  });
});
