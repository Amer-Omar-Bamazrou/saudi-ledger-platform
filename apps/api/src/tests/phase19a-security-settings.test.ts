/**
 * 🔴 Phase 19A slice 3 — 19.7 centralised security settings (owner approval of the Phase 19 proposal v2, 2026-11-17).
 * The proving test of control 19A-P (controls/registry.ts).
 *
 *   - one set of settings per organization, read and changed by ITS admins only (presence, absence, movement);
 *   - a setting cannot leave the platform's bounds — refused by the API, naming the bound, and by the database;
 *   - a STRENGTHENING change applies at once; a WEAKENING change by one admin of an organization with two or more
 *     admins is HELD for a second admin — the requester cannot approve it, the database refuses the weakening without
 *     an approval, and an organization with one admin is not held;
 *   - every change is recorded: one event when requested or applied directly, one when decided;
 *   - the settings DO something: "everyone" makes a bookkeeper's next sign-in owe enrolment, the session lifetime and
 *     the idle timeout end sessions at the organization's figure, and another organization is untouched.
 *
 * DB-backed (sl_test / CI); skips on the DB-free placeholder.
 */
process.env.PORT ??= "3223";
process.env.SESSION_SECRET ??= "phase19a-security-settings-test-secret1";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "P19aSettingsPw123!";
const MIN = 60 * 1000;
const DEFAULTS = { mfaRequiredForAll: false, sessionLifetimeHours: 12, idleTimeoutMinutes: 480 };

describeMaybe("Phase 19A slice 3 — security settings: bounds, dual control for weakening, and what they enforce", () => {
  const h = g04Harness("p19s");
  const ids: Record<string, number> = {};
  let orgA = "";
  let orgB = "";
  const settings = (org: string) => `/orgs/${org}/security-settings`;
  const events = async (org: string) =>
    (await pool.query(`SELECT actor_user_id, metadata, request_id FROM security_audit_logs WHERE action = 'security_settings.changed' AND organization_id = $1 ORDER BY created_at, id`, [org])).rows;
  const stored = async (org: string) => (await pool.query(`SELECT mfa_required_for_all, session_lifetime_hours, idle_timeout_minutes FROM org_security_settings WHERE organization_id = $1`, [org])).rows[0];

  beforeAll(async () => {
    await h.cleanup();
    orgA = await h.mkOrg("a");
    await h.mkCompany(orgA, "P19S A", "318181818181867");
    orgB = await h.mkOrg("b");
    await h.mkCompany(orgB, "P19S B", "318181818181877");
    ids.a1 = await h.mkUser("a1", PW, orgA, "admin");
    ids.a2 = await h.mkUser("a2", PW, orgA, "admin");
    ids.book = await h.mkUser("book", PW, orgA, "bookkeeper");
    ids.b1 = await h.mkUser("b1", PW, orgB, "admin");
    ids.bBook = await h.mkUser("b-book", PW, orgB, "bookkeeper");
    await h.start();
    for (const [who, key] of [["a1", "a1"], ["a2", "a2"], ["book", "book"], ["b1", "b1"], ["bBook", "b-book"]] as const) {
      expect(await h.login(who, h.email(key), PW), `login ${who}`).toBe(200);
    }
  }, 120_000);
  afterAll(async () => {
    await h.stop();
    await pool.query(`DELETE FROM org_security_setting_changes WHERE organization_id IN ${h.ORGS}`).catch(() => undefined);
    await h.cleanup();
  });

  it("19.7 — an organization's settings start at the platform defaults and are its ADMINS' alone: presence, absence, movement", async () => {
    const mine = await h.api("a1", "GET", settings(orgA));
    expect(mine.status, JSON.stringify(mine.body)).toBe(200);
    expect(mine.body).toMatchObject({
      settings: DEFAULTS, pendingChange: null, usableAdmins: 2,
      bounds: { sessionLifetimeHours: { min: 1, max: 12 }, idleTimeoutMinutes: { min: 15, max: 480 } },
    });
    expect((await h.api("book", "GET", settings(orgA))).status, "a bookkeeper").toBe(403);
    expect((await h.api("b1", "GET", settings(orgA))).status, "another organization's admin").toBe(403);
    expect((await h.api("b1", "PUT", settings(orgA), { ...DEFAULTS, mfaRequiredForAll: true })).status).toBe(403);
    expect((await h.api("b1", "GET", settings(orgB))).body.settings, "movement: org B reads its own").toEqual(DEFAULTS);
    expect(await stored(orgA), "a refused change wrote nothing").toBeUndefined();
  });

  it("🔴 19.7 — a setting cannot leave the platform's bounds: refused by the API naming the bound, and by the database", async () => {
    for (const [body, field] of [
      [{ ...DEFAULTS, sessionLifetimeHours: 13 }, "sessionLifetimeHours"], [{ ...DEFAULTS, sessionLifetimeHours: 0 }, "sessionLifetimeHours"],
      [{ ...DEFAULTS, idleTimeoutMinutes: 481 }, "idleTimeoutMinutes"], [{ ...DEFAULTS, idleTimeoutMinutes: 14 }, "idleTimeoutMinutes"],
      [{ ...DEFAULTS, sessionLifetimeHours: 1.5 }, "sessionLifetimeHours"], [{ ...DEFAULTS, mfaRequiredForAll: "yes" }, "mfaRequiredForAll"],
    ] as const) {
      const res = await h.api("a1", "PUT", settings(orgA), body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect(res.body).toMatchObject({ code: "security_setting_out_of_bounds", field, errorAr: expect.any(String) });
    }
    await expect(pool.query(`INSERT INTO org_security_settings (organization_id, session_lifetime_hours) VALUES ($1, 13)`, [orgB])).rejects.toThrow(/lifetime/);
    await expect(pool.query(`INSERT INTO org_security_settings (organization_id, idle_timeout_minutes) VALUES ($1, 5)`, [orgB])).rejects.toThrow(/idle/);
  });

  it("🔴 19.7 — a STRENGTHENING change by one admin applies at once, and is recorded", async () => {
    const res = await h.api("a1", "PUT", settings(orgA), { mfaRequiredForAll: true, sessionLifetimeHours: 8, idleTimeoutMinutes: 60 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ applied: true, held: false, settings: { mfaRequiredForAll: true, sessionLifetimeHours: 8, idleTimeoutMinutes: 60 } });
    expect(await stored(orgA)).toEqual({ mfa_required_for_all: true, session_lifetime_hours: 8, idle_timeout_minutes: 60 });
    const ev = await events(orgA);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ actor_user_id: ids.a1, request_id: expect.any(String) });
    expect(ev[0]!.metadata).toMatchObject({ stage: "applied", before: DEFAULTS, after: { mfaRequiredForAll: true, sessionLifetimeHours: 8, idleTimeoutMinutes: 60 } });
    expect((await h.api("a1", "PUT", settings(orgA), { mfaRequiredForAll: true, sessionLifetimeHours: 8, idleTimeoutMinutes: 60 })).body, "no change is not a change").toMatchObject({ applied: false, held: false });
    expect(await events(orgA)).toHaveLength(1);
  });

  it("🔴 19.7 — a WEAKENING change by one admin is HELD: nothing changes, the requester cannot approve it, a second admin can", async () => {
    const weaker = { mfaRequiredForAll: true, sessionLifetimeHours: 10, idleTimeoutMinutes: 60 };
    const held = await h.api("a1", "PUT", settings(orgA), weaker);
    expect(held.status, JSON.stringify(held.body)).toBe(202);
    expect(held.body).toMatchObject({ applied: false, held: true, pendingChange: { requestedBy: { id: ids.a1 }, after: weaker } });
    expect((await stored(orgA)).session_lifetime_hours, "held: nothing changed").toBe(8);
    const changeId = held.body.pendingChange.id as string;
    // one at a time
    const second = await h.api("a2", "PUT", settings(orgA), { ...weaker, idleTimeoutMinutes: 120 });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe("security_settings_change_pending");
    // … and that holds for ANY change, a stricter one included: the waiting request was made against these settings
    const stricter = await h.api("a2", "PUT", settings(orgA), { mfaRequiredForAll: true, sessionLifetimeHours: 8, idleTimeoutMinutes: 30 });
    expect(stricter.status).toBe(409);
    expect(stricter.body.code).toBe("security_settings_change_pending");
    expect((await stored(orgA)).idle_timeout_minutes, "nothing moved under the waiting request").toBe(60);
    // the requester is not the second admin; a bookkeeper and another organization's admin are nobody here
    const own = await h.api("a1", "PUT", `${settings(orgA)}/changes/${changeId}/decision`, { decision: "approve" });
    expect(own.status).toBe(409);
    expect(own.body).toMatchObject({ code: "security_settings_second_admin_required", errorAr: expect.any(String) });
    expect(own.body.error, "the SERVICE's own refusal (the database's is proven separately below)").toContain("You asked for this change");
    expect((await h.api("book", "PUT", `${settings(orgA)}/changes/${changeId}/decision`, { decision: "approve" })).status).toBe(403);
    expect((await h.api("b1", "PUT", `${settings(orgA)}/changes/${changeId}/decision`, { decision: "approve" })).status).toBe(403);
    expect((await stored(orgA)).session_lifetime_hours).toBe(8);
    const approved = await h.api("a2", "PUT", `${settings(orgA)}/changes/${changeId}/decision`, { decision: "approve" });
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(approved.body).toMatchObject({ applied: true, settings: weaker, pendingChange: null });
    expect((await stored(orgA)).session_lifetime_hours).toBe(10);
    const stages = (await events(orgA)).map((e) => [e.metadata.stage, e.actor_user_id]);
    expect(stages).toEqual([["applied", ids.a1], ["requested", ids.a1], ["approved", ids.a2]]);
    // a rejected request changes nothing
    const again = await h.api("a2", "PUT", settings(orgA), { ...weaker, mfaRequiredForAll: false });
    expect(again.status).toBe(202);
    const rejected = await h.api("a1", "PUT", `${settings(orgA)}/changes/${again.body.pendingChange.id}/decision`, { decision: "reject" });
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
    expect((await stored(orgA)).mfa_required_for_all).toBe(true);
    expect((await h.api("a1", "GET", settings(orgA))).body.pendingChange).toBeNull();
  });

  it("🔴 the dual control is the DATABASE's: a weakening written without an approval is refused; one admin's organization is not held", async () => {
    await expect(pool.query(`UPDATE org_security_settings SET session_lifetime_hours = 12 WHERE organization_id = $1`, [orgA])).rejects.toThrow(/second admin/);
    await expect(pool.query(`UPDATE org_security_settings SET mfa_required_for_all = false WHERE organization_id = $1`, [orgA])).rejects.toThrow(/second admin/);
    // strengthening needs no approval
    await pool.query(`UPDATE org_security_settings SET idle_timeout_minutes = 45 WHERE organization_id = $1`, [orgA]);
    // 🔴 the REQUEST's own rules, with no service in front: one pending at a time; the requester never approves; a
    // decision is recorded for the person acting; a decided request is not decided again
    const insert = `INSERT INTO org_security_setting_changes (organization_id, mfa_before, mfa_after, lifetime_before, lifetime_after, idle_before, idle_after, requested_by)
                    VALUES ($1, true, true, 10, 12, 45, 45, $2) RETURNING id`;
    const changeId = (await pool.query(insert, [orgA, ids.a1])).rows[0].id as string;
    await expect(pool.query(insert, [orgA, ids.a2]), "one pending request per organization").rejects.toThrow(/pending_unq/);
    const decideAs = async (acting: number, decidedBy: number, status: string) => {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await c.query(`SELECT set_config('app.current_user_id', $1, true)`, [String(acting)]);
        await c.query(`UPDATE org_security_setting_changes SET status = $2, decided_by = $3, decided_at = now() WHERE id = $1`, [changeId, status, decidedBy]);
        await c.query("COMMIT");
      } catch (err) { await c.query("ROLLBACK"); throw err; } finally { c.release(); }
    };
    await expect(decideAs(ids.a1!, ids.a1!, "approved"), "the requester approving").rejects.toThrow(/does not approve it/);
    await expect(decideAs(ids.a1!, ids.a2!, "approved"), "a decision written for someone else").rejects.toThrow(/person acting/);
    await expect(decideAs(ids.book!, ids.book!, "approved"), "not an admin").rejects.toThrow(/only an admin/);
    await decideAs(ids.a2!, ids.a2!, "rejected");
    await expect(decideAs(ids.a2!, ids.a2!, "approved"), "decided once").rejects.toThrow(/already decided/);
    // movement: org B has ONE admin — a weakening applies at once
    expect((await h.api("b1", "PUT", settings(orgB), { mfaRequiredForAll: false, sessionLifetimeHours: 4, idleTimeoutMinutes: 30 })).body).toMatchObject({ applied: true });
    const weak = await h.api("b1", "PUT", settings(orgB), { mfaRequiredForAll: false, sessionLifetimeHours: 6, idleTimeoutMinutes: 30 });
    expect(weak.status, JSON.stringify(weak.body)).toBe(200);
    expect(weak.body).toMatchObject({ applied: true, held: false });
    expect((await stored(orgB)).session_lifetime_hours).toBe(6);
  });

  it("🔴 ENFORCED — 'everyone': a bookkeeper's next sign-in owes enrolment; another organization's bookkeeper does not", async () => {
    expect((await h.api("book", "GET", "/invoices")).status, "the session opened before the setting is not interrupted").toBe(200);
    const next = await h.api("book2", "POST", "/auth/login", { email: h.email("book"), password: PW });
    expect(next.body.user.mfaStep).toBe("enrol");
    expect((await h.api("book2", "GET", "/invoices")).body.code).toBe("mfa_enrolment_required");
    expect((await h.api("book2", "GET", "/auth/mfa")).body).toMatchObject({ required: true });
    const other = await h.api("bBook2", "POST", "/auth/login", { email: h.email("b-book"), password: PW });
    expect(other.body.user.mfaStep ?? null).toBeNull();
    expect((await h.api("bBook2", "GET", "/invoices")).status).toBe(200);
  });

  it("🔴 ENFORCED — the session lifetime and the idle timeout end sessions at the ORGANIZATION's figure", async () => {
    // org A: lifetime 10 hours, idle 45 minutes. org B: lifetime 6 hours, idle 30 minutes.
    const signedInAgo = (userId: number, ms: number) => pool.query(
      `UPDATE user_sessions SET sess = jsonb_set(sess::jsonb, '{authenticatedAt}', to_jsonb($2::bigint))::json WHERE (sess ->> 'userId')::int = $1 AND sess ->> 'mfaStep' IS NULL`, [userId, Date.now() - ms]);
    const lastSeenAgo = (userId: number, minutes: number) => pool.query(
      `UPDATE session_records SET last_seen_at = now() - ($2 || ' minutes')::interval WHERE user_id = $1 AND ended_at IS NULL`, [userId, String(minutes)]);
    await signedInAgo(ids.a2!, 10 * 60 * MIN - MIN);
    expect((await h.api("a2", "GET", "/auth/me")).status, "9h59m: inside org A's 10 hours").toBe(200);
    await signedInAgo(ids.b1!, 6 * 60 * MIN + MIN);
    expect((await h.api("b1", "GET", "/auth/me")).status, "6h01m: past org B's 6 hours").toBe(401);
    await signedInAgo(ids.a2!, 10 * 60 * MIN + MIN);
    expect((await h.api("a2", "GET", "/auth/me")).status, "10h01m: past org A's 10 hours").toBe(401);
    // idle
    await lastSeenAgo(ids.a1!, 44);
    expect((await h.api("a1", "GET", "/auth/me")).status, "idle 44 minutes: inside org A's 45").toBe(200);
    await lastSeenAgo(ids.a1!, 46);
    expect((await h.api("a1", "GET", "/auth/me")).status, "idle 46 minutes: past org A's 45").toBe(401);
    await lastSeenAgo(ids.bBook!, 31);
    expect((await h.api("bBook", "GET", "/auth/me")).status, "idle 31 minutes: past org B's 30").toBe(401);
  });
});
