/**
 * 🔴 G02 — REGRESSION (owner D-4 and DR-07(a), Phase 18 authorisation §2.10,
 * 2026-10-20): a session ends when what it was issued for ends — on
 * deactivation, an admin's password reset and a password change — and 12 hours
 * after sign-in, whatever the activity.
 *
 * The 4B proof (`phase18-s1b-g02-session-revocation.test.ts`, landed unchanged)
 * shows the three acts end the existing sessions. This file pins what the proof
 * does not:
 *   - the ABSOLUTE lifetime: just inside 12 hours a session works; just past it,
 *     the SAME session is refused and its row is gone;
 *   - a session from before the check (no sign-in time, no credential) is
 *     refused — it fails closed;
 *   - the check is made on every request against the account as stored, so a
 *     session row written back after the act (an in-flight request saving its
 *     session) is still refused — deletion is hygiene, not the guarantee;
 *   - on one's own password change the CURRENT session is kept;
 *   - ISOLATION: another organisation's sessions, and the acting admin's, keep
 *     working (presence, absence and movement in one file).
 *
 * DB-backed (sl_test / CI); skips on the DB-free placeholder. Eight logins —
 * inside the per-process login limit of 10 (never raised to pass a test).
 */
process.env.PORT ??= "3208";
process.env.SESSION_SECRET ??= "g02-session-lifetime-regression-0000001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "G02RegressionPw123!";
const NEW_PW = "G02RegressionNewPw456!";
const HOUR = 60 * 60 * 1000;
const BUSINESS_GET = "/invoices";

describeMaybe("G02 — a session ends when what it was issued for ends, and 12 hours after sign-in", () => {
  const h = g04Harness("g02reg");
  const ids: Record<string, number> = {};
  let orgA = "";
  let orgB = "";

  type Row = { sid: string; sess: unknown; expire: Date };
  const rowsOf = async (userId: number): Promise<Row[]> =>
    (await pool.query(`SELECT sid, sess, expire FROM user_sessions WHERE (sess ->> 'userId')::int = $1 ORDER BY sid`, [userId])).rows;
  /** Write a captured session row back, as an in-flight request saving its session after the act would. */
  const writeBack = (r: Row) =>
    pool.query(`INSERT INTO user_sessions (sid, sess, expire) VALUES ($1, $2::json, $3) ON CONFLICT (sid) DO UPDATE SET sess = EXCLUDED.sess`, [r.sid, JSON.stringify(r.sess), r.expire]);
  /** Move the ONE session of `userId` to having signed in `msAgo` ago. */
  const signedInAgo = (userId: number, msAgo: number) =>
    pool.query(
      `UPDATE user_sessions SET sess = jsonb_set(sess::jsonb, '{authenticatedAt}', to_jsonb($2::bigint))::json WHERE (sess ->> 'userId')::int = $1`,
      [userId, Date.now() - msAgo],
    );

  beforeAll(async () => {
    await h.cleanup();
    orgA = await h.mkOrg("a");
    await h.mkCompany(orgA, "G02 Regression A", "318181818181807");
    orgB = await h.mkOrg("b");
    await h.mkCompany(orgB, "G02 Regression B", "318181818181817");
    ids.admin = await h.mkUser("admin", PW, orgA, "admin");
    for (const k of ["a1", "chg", "young", "legacy"]) ids[k] = await h.mkUser(k, PW, orgA, "bookkeeper");
    ids.b1 = await h.mkUser("b1", PW, orgB, "bookkeeper");
    await h.start();
    for (const who of ["admin", "a1", "young", "legacy", "b1"]) expect(await h.login(who, h.email(who), PW), `login ${who}`).toBe(200);
    expect(await h.login("chg-a", h.email("chg"), PW)).toBe(200);
    expect(await h.login("chg-b", h.email("chg"), PW)).toBe(200);
  }, 120_000);
  afterAll(async () => { await h.stop(); await h.cleanup(); });

  it("every session is stamped at sign-in with its time and credential, and works", async () => {
    for (const who of ["admin", "a1", "young", "legacy", "b1", "chg-a", "chg-b"]) expect((await h.api(who, "GET", BUSINESS_GET)).status, who).toBe(200);
    const [row] = await rowsOf(ids.young!);
    expect(row!.sess).toMatchObject({ userId: ids.young, authenticatedAt: expect.any(Number), credential: expect.any(String) });
  });

  it("🔴 ABSOLUTE LIFETIME: just inside 12 hours the session works; moved just past 12 hours, the SAME session is refused (401) and its row is gone", async () => {
    await signedInAgo(ids.young!, 12 * HOUR - 60_000);
    expect((await h.api("young", "GET", BUSINESS_GET)).status, "11h59m after sign-in").toBe(200);
    await signedInAgo(ids.young!, 12 * HOUR + 1_000);
    expect((await h.api("young", "GET", BUSINESS_GET)).status, "12h00m01s after sign-in").toBe(401);
    expect((await h.api("young", "GET", "/auth/me")).status).toBe(401);
    expect(await rowsOf(ids.young!), "the ended session's row is destroyed").toEqual([]);
  });

  it("a session from before the check — no sign-in time, no credential — is refused (fails closed)", async () => {
    await pool.query(`UPDATE user_sessions SET sess = (sess::jsonb - 'authenticatedAt' - 'credential')::json WHERE (sess ->> 'userId')::int = $1`, [ids.legacy]);
    expect((await h.api("legacy", "GET", BUSINESS_GET)).status).toBe(401);
  });

  it("🔴 DEACTIVATION: the session ends, and a row written back after the act is STILL refused; the acting admin and another organisation's user keep working", async () => {
    const [captured] = await rowsOf(ids.a1!);
    expect(captured, "anti-vacuity: the session row exists before the act").toBeDefined();
    expect((await h.api("admin", "PATCH", `/auth/users/${ids.a1}`, { isActive: false })).status).toBe(200);
    expect(await rowsOf(ids.a1!), "the act deletes the sessions").toEqual([]);
    await writeBack(captured!);
    expect((await h.api("a1", "GET", BUSINESS_GET)).status, "the written-back session is refused on the account's state").toBe(401);
    expect((await h.api("admin", "GET", BUSINESS_GET)).status, "the acting admin's session is untouched").toBe(200);
    expect((await h.api("b1", "GET", BUSINESS_GET)).status, "another organisation's session is untouched").toBe(200);
  });

  it("🔴 OWN PASSWORD CHANGE: the session it was made in is KEPT; the other session ends, and written back it is STILL refused", async () => {
    const rows = await rowsOf(ids.chg!);
    expect(rows).toHaveLength(2);
    expect((await h.api("chg-a", "POST", "/auth/change-password", { currentPassword: PW, newPassword: NEW_PW })).status).toBe(200);
    expect((await h.api("chg-a", "GET", BUSINESS_GET)).status, "the current session is kept").toBe(200);
    expect((await h.api("chg-a", "GET", "/auth/me")).status).toBe(200);
    const left = await rowsOf(ids.chg!);
    expect(left, "only the current session is left").toHaveLength(1);
    const other = rows.find((r) => r.sid !== left[0]!.sid)!;
    await writeBack(other);
    expect((await h.api("chg-b", "GET", BUSINESS_GET)).status, "the other session, written back, is refused on its credential").toBe(401);
    expect((await h.api("chg-a", "GET", BUSINESS_GET)).status, "and the kept one still works").toBe(200);
  });

  it("🔴 ADMIN RESET: every session of the reset account ends; another organisation's user keeps working", async () => {
    expect((await h.api("admin", "POST", `/auth/users/${ids.chg}/reset-password`, { newPassword: "G02AdminResetPw789!" })).status).toBe(200);
    expect(await rowsOf(ids.chg!)).toEqual([]);
    expect((await h.api("chg-a", "GET", BUSINESS_GET)).status, "even the session kept through the user's own change").toBe(401);
    expect((await h.api("b1", "GET", BUSINESS_GET)).status).toBe(200);
  });
});
