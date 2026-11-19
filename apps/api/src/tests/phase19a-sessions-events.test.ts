/**
 * 🔴 Phase 19A, slice 1 — 19.4 active-session visibility, 19.5 individual and bulk revocation, 19.8 the events they
 * write (owner approval of the Phase 19 proposal v2, 2026-11-17; §3 acceptance criteria):
 *   - a session record per sign-in; a user sees only their own, the current one marked; never the session id itself;
 *   - an org admin sees the sessions of the accounts they administer (confined to their organizations) and no one
 *     else's — presence, absence and MOVEMENT across two organizations;
 *   - ending one session, all others, a member's (admin), anyone's (operator): the ended session's NEXT request is 401,
 *     the others keep working, and an admin cannot reach another organization's sessions (concealed, 404);
 *   - each act writes EXACTLY ONE security event, with actor, target, organization and the request id;
 *   - an ended record stays ended at the database; a session with no record fails closed.
 *
 * DB-backed (sl_test / CI); skips on the DB-free placeholder. Nine logins — inside the per-process login limit of 10
 * (never raised to pass a test).
 */
process.env.PORT ??= "3219";
process.env.SESSION_SECRET ??= "phase19a-sessions-events-test-secret-01";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "P19aSessionsPw123!";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Event = { action: string; actor_user_id: number | null; target_user_id: number | null; organization_id: string | null; request_id: string | null; metadata: any };

describeMaybe("Phase 19A slice 1 — session records, revocation, and the events they write", () => {
  const h = g04Harness("p19a");
  const ids: Record<string, number> = {};
  let orgA = "";
  let orgB = "";
  let since = new Date(0);

  const eventsSince = async (action: string, targetUserId: number): Promise<Event[]> =>
    (await pool.query(
      `SELECT action, actor_user_id, target_user_id, organization_id, request_id, metadata FROM security_audit_logs
        WHERE action = $1 AND target_user_id = $2 AND created_at >= $3 ORDER BY created_at`,
      [action, targetUserId, since],
    )).rows;
  /** The database clock (security_audit_logs.created_at has no time zone): a JS Date would be shifted by the offset. */
  const dbNow = async (): Promise<Date> => (await pool.query(`SELECT localtimestamp AS t`)).rows[0].t;
  const mine = async (who: string) => (await h.api(who, "GET", "/auth/sessions")).body.sessions as any[];

  beforeAll(async () => {
    await h.cleanup();
    await pool.query(`DELETE FROM session_records WHERE user_id IN ${h.USERS}`).catch(() => undefined);
    orgA = await h.mkOrg("a");
    await h.mkCompany(orgA, "P19A Sessions A", "318181818181827");
    orgB = await h.mkOrg("b");
    await h.mkCompany(orgB, "P19A Sessions B", "318181818181837");
    ids.aAdmin = await h.mkUser("a-admin", PW, orgA, "admin");
    ids.a1 = await h.mkUser("a1", PW, orgA, "bookkeeper");
    ids.a2 = await h.mkUser("a2", PW, orgA, "accountant");
    ids.bAdmin = await h.mkUser("b-admin", PW, orgB, "admin");
    ids.b1 = await h.mkUser("b1", PW, orgB, "bookkeeper");
    // an account in BOTH organizations: account-wide acts on it belong to neither admin alone (the F1 confinement)
    ids.ab = await h.mkUser("ab", PW, orgA, "bookkeeper");
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1, $2, 'bookkeeper', 'active')`, [ids.ab, orgB]);
    ids.op = await h.mkUser("op", PW, null);
    await pool.query(`INSERT INTO platform_operators (user_id) VALUES ($1)`, [ids.op]);
    await h.start();
    for (const [who, key] of [["aAdmin", "a-admin"], ["a1-x", "a1"], ["a1-y", "a1"], ["a2-x", "a2"], ["a2-y", "a2"], ["bAdmin", "b-admin"], ["b1", "b1"], ["ab", "ab"], ["op", "op"]] as const) {
      expect(await h.login(who, h.email(key), PW), `login ${who}`).toBe(200);
    }
  }, 120_000);
  afterAll(async () => {
    await h.stop();
    await pool.query(`DELETE FROM session_records WHERE user_id IN ${h.USERS}`).catch(() => undefined);
    await h.cleanup();
  });

  it("19.4 — a user sees only their OWN sessions, the current one marked, and never a session id", async () => {
    const a1 = await mine("a1-x");
    expect(a1, "a1 signed in twice").toHaveLength(2);
    expect(a1.filter((s) => s.current), "exactly one is the session asking").toHaveLength(1);
    for (const s of a1) {
      expect(s).toMatchObject({ id: expect.stringMatching(UUID), kind: "sign_in", createdAt: expect.any(String), lastSeenAt: expect.any(String) });
      expect(Object.keys(s)).not.toContain("sid");
    }
    const sids = (await pool.query(`SELECT sid FROM user_sessions WHERE (sess ->> 'userId')::int = $1`, [ids.a1])).rows.map((r) => r.sid as string);
    expect(sids, "anti-vacuity: the session ids exist").toHaveLength(2);
    const text = JSON.stringify(a1);
    for (const sid of sids) expect(text, "the bearer session id never leaves the server").not.toContain(sid);
    const a2 = await mine("a2-x");
    expect(a2, "a2 sees their own two").toHaveLength(2);
    expect(a2.map((s) => s.id).some((id) => a1.map((x) => x.id).includes(id)), "and none of a1's").toBe(false);
  });

  it("19.4 — an org admin sees the sessions of the accounts THEY administer: presence, absence and movement", async () => {
    const listA = (await h.api("aAdmin", "GET", "/auth/sessions/members")).body.sessions as any[];
    const usersA = listA.map((s) => s.user.id);
    expect(usersA.filter((u) => u === ids.a1), "a1's two sessions").toHaveLength(2);
    expect(usersA.filter((u) => u === ids.a2), "a2's two sessions").toHaveLength(2);
    expect(usersA, "the admin's own").toContain(ids.aAdmin);
    for (const foreign of [ids.b1, ids.bAdmin, ids.op]) expect(usersA, `org A's admin never sees ${foreign}`).not.toContain(foreign);
    const listB = (await h.api("bAdmin", "GET", "/auth/sessions/members")).body.sessions as any[];
    const usersB = listB.map((s) => s.user.id);
    expect(usersB, "movement: org B's admin sees org B's own").toEqual(expect.arrayContaining([ids.b1, ids.bAdmin]));
    for (const foreign of [ids.a1, ids.a2, ids.aAdmin, ids.op]) expect(usersB, `org B's admin never sees ${foreign}`).not.toContain(foreign);
    expect((await h.api("a1-x", "GET", "/auth/sessions/members")).status, "a bookkeeper administers no one").toBe(403);
    expect(usersA, "an account that also belongs to org B is not org A's to list").not.toContain(ids.ab);
    expect(usersB, "nor org B's").not.toContain(ids.ab);
    expect((await mine("ab")).length, "anti-vacuity: that account has a live session").toBe(1);
  });

  it("🔴 19.5 — an account that also belongs to another organization: ending its sessions is explained (409), and they keep working", async () => {
    since = await dbNow();
    const res = await h.api("aAdmin", "POST", `/auth/users/${ids.ab}/sessions/end`);
    expect(res.status).toBe(409);
    expect((await h.api("ab", "GET", "/auth/me")).status).toBe(200);
    expect(await eventsSince("session.revoked_all", ids.ab!), "a refused act writes no revocation event").toHaveLength(0);
  });

  it("19.5 — ending ONE of one's own sessions: its next request is 401, the asking session keeps working, one event", async () => {
    since = await dbNow();
    const other = (await mine("a1-x")).find((s) => !s.current)!;
    expect((await h.api("a1-y", "GET", "/auth/me")).status, "anti-vacuity: the other session works first").toBe(200);
    const res = await h.api("a1-x", "POST", `/auth/sessions/${other.id}/end`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ended: 1 });
    expect((await h.api("a1-y", "GET", "/auth/me")).status, "the ended session's next request").toBe(401);
    expect((await h.api("a1-x", "GET", "/auth/me")).status, "the session that asked").toBe(200);
    const ev = await eventsSince("session.revoked", ids.a1!);
    expect(ev, "exactly one event").toHaveLength(1);
    expect(ev[0]).toMatchObject({ actor_user_id: ids.a1, target_user_id: ids.a1, organization_id: orgA, request_id: expect.stringMatching(UUID) });
    expect(ev[0]!.metadata).toMatchObject({ sessionIds: [other.id], by: "self" });
  });

  it("19.5 — the CURRENT session is not ended through this route (refused, naming Sign out); another user's session is concealed", async () => {
    const current = (await mine("a1-x")).find((s) => s.current)!;
    const self = await h.api("a1-x", "POST", `/auth/sessions/${current.id}/end`);
    expect(self.status).toBe(409);
    expect(self.body).toMatchObject({ code: "session_is_current" });
    expect(self.body.errorAr, "the refusal is in Arabic too").toEqual(expect.any(String));
    const a2s = await mine("a2-x");
    const foreign = await h.api("a1-x", "POST", `/auth/sessions/${a2s[0]!.id}/end`);
    expect(foreign.status, "someone else's session: not found, not forbidden").toBe(404);
    expect((await h.api("a2-x", "GET", "/auth/me")).status).toBe(200);
    expect((await h.api("a2-y", "GET", "/auth/me")).status).toBe(200);
    expect((await h.api("a1-x", "POST", "/auth/sessions/not-a-uuid/end")).status).toBe(404);
  });

  it("19.5 — ending ALL OTHER sessions: they are 401, the asking one works, one event naming the count", async () => {
    since = await dbNow();
    const res = await h.api("a2-x", "POST", "/auth/sessions/end-others");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ended: 1 });
    expect((await h.api("a2-y", "GET", "/auth/me")).status).toBe(401);
    expect((await h.api("a2-x", "GET", "/auth/me")).status).toBe(200);
    expect(await mine("a2-x"), "only the asking session is left").toHaveLength(1);
    const ev = await eventsSince("session.revoked_all", ids.a2!);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ actor_user_id: ids.a2, target_user_id: ids.a2, organization_id: orgA, request_id: expect.stringMatching(UUID) });
    expect(ev[0]!.metadata).toMatchObject({ count: 1, by: "self", scope: "others" });
  });

  it("🔴 19.5 — an admin ends a member's sessions; another organization's admin cannot reach them (404) and they keep working", async () => {
    since = await dbNow();
    const cross = await h.api("bAdmin", "POST", `/auth/users/${ids.a2}/sessions/end`);
    expect(cross.status, "another organization's member: concealed").toBe(404);
    expect((await h.api("a2-x", "GET", "/auth/me")).status, "movement: the member's session survives the foreign attempt").toBe(200);
    expect(await eventsSince("session.revoked_all", ids.a2!), "a refused act writes no revocation event").toHaveLength(0);
    const own = await h.api("aAdmin", "POST", `/auth/users/${ids.a2}/sessions/end`);
    expect(own.status).toBe(200);
    expect(own.body).toMatchObject({ ended: 1 });
    expect((await h.api("a2-x", "GET", "/auth/me")).status, "the member's session ended").toBe(401);
    expect((await h.api("aAdmin", "GET", "/auth/me")).status, "the admin's own session is untouched").toBe(200);
    expect((await h.api("b1", "GET", "/auth/me")).status, "another organization's session is untouched").toBe(200);
    const ev = await eventsSince("session.revoked_all", ids.a2!);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ actor_user_id: ids.aAdmin, target_user_id: ids.a2, organization_id: orgA, request_id: expect.stringMatching(UUID) });
    expect(ev[0]!.metadata).toMatchObject({ count: 1, by: "admin" });
  });

  it("🔴 19.5 — an operator sees operator sessions only, and ends a tenant user's sessions (audited); a tenant admin cannot reach the operator surface", async () => {
    since = await dbNow();
    const list = await h.api("op", "GET", "/operator/sessions");
    expect(list.status).toBe(200);
    const users = (list.body.sessions as any[]).map((s) => s.user.id);
    expect(users, "the operator's own session").toContain(ids.op);
    for (const tenant of [ids.aAdmin, ids.a1, ids.b1, ids.bAdmin]) expect(users, `no tenant session (${tenant})`).not.toContain(tenant);
    expect((await h.api("aAdmin", "GET", "/operator/sessions")).status).toBe(403);
    expect((await h.api("b1", "GET", "/auth/me")).status, "anti-vacuity").toBe(200);
    const res = await h.api("op", "POST", "/operator/users/end-sessions", { email: h.email("b1") });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ended: 1 });
    expect((await h.api("b1", "GET", "/auth/me")).status).toBe(401);
    expect((await h.api("bAdmin", "GET", "/auth/me")).status, "the rest of org B is untouched").toBe(200);
    const ev = await eventsSince("session.revoked_all", ids.b1!);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ actor_user_id: ids.op, target_user_id: ids.b1, request_id: expect.stringMatching(UUID) });
    expect(ev[0]!.metadata).toMatchObject({ count: 1, by: "operator" });
  });

  it("🔴 an ended record stays ended AT THE DATABASE, and its identity cannot be rewritten", async () => {
    const [ended] = (await pool.query(`SELECT id FROM session_records WHERE user_id = $1 AND ended_at IS NOT NULL LIMIT 1`, [ids.a1])).rows;
    expect(ended, "anti-vacuity: an ended record exists").toBeDefined();
    await expect(pool.query(`UPDATE session_records SET ended_at = NULL, end_reason = NULL, ended_by_user_id = NULL WHERE id = $1`, [ended.id])).rejects.toThrow(/ended/i);
    const [live] = (await pool.query(`SELECT id FROM session_records WHERE user_id = $1 AND ended_at IS NULL LIMIT 1`, [ids.aAdmin])).rows;
    await expect(pool.query(`UPDATE session_records SET user_id = $2 WHERE id = $1`, [live.id, ids.b1])).rejects.toThrow(/session_records/i);
  });

  it("a session with no record (from before records existed) fails closed", async () => {
    expect((await h.api("bAdmin", "GET", "/auth/me")).status, "anti-vacuity").toBe(200);
    await pool.query(`UPDATE user_sessions SET sess = (sess::jsonb - 'sessionRecordId')::json WHERE (sess ->> 'userId')::int = $1`, [ids.bAdmin]);
    expect((await h.api("bAdmin", "GET", "/auth/me")).status).toBe(401);
  });
});
