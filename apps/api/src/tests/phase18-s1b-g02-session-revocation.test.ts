/**
 * PHASE 18 · S1-b · G02 PROOF — sessions that outlive the act meant to end
 * them: a deactivation, a user's own password change, an admin's password
 * reset. PROOF ONLY, NOT A FIX.
 *
 * Authorised by the owner on 2026-10-16 (Batch 4B). Definition: Phase 18
 * contract G02 (§11.2: "Deactivating a user, an admin reset and a password
 * change do not end sessions; guards never read `users.isActive`"), register
 * DR-07(a) (the absolute lifetime is the owner's number and is NOT tested
 * here), and the plan of 2026-10-16 §9.
 *
 * The mechanism (read at f480a569): `requireAuth` (lib/auth.ts) checks only
 * that the session names a user; only LOGIN reads `isActive`; neither
 * `/auth/change-password` nor `/auth/users/:id/reset-password` ends any
 * existing session.
 *
 * FIX-NEUTRAL invariant: after each act, the affected user's EXISTING session
 * is refused (401 or 403) on its next business request. CONTROLS: a fresh
 * login confirms each act took effect (the deactivated account and the old
 * passwords are refused), and an unaffected colleague's session keeps working.
 *
 * 🔴 Expected to FAIL while G02 exists. Untracked S1-b file — never merged red,
 * never weakened. Does NOT call the rate-limit reset hook. DB-backed.
 */

process.env.PORT ??= "3156";
process.env.SESSION_SECRET ??= "phase18-s1b-g02-proof-session-secret-0001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

const PW = "S1bG02ProofPw123!";
const NEW_PW = "S1bG02NewPassword456!";
const BUSINESS_GET = "/invoices";

describeMaybe("Phase 18 S1-b · G02 proof — existing sessions after deactivation, password change and admin reset", () => {
  const h = g04Harness("s1bg02");
  let orgId = "";
  const ids: Record<string, number> = {};

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    await h.mkCompany(orgId, "S1b G02 Co", "318181818181803");
    ids.admin = await h.mkUser("admin", PW, orgId, "admin");
    for (const k of ["deact", "chg", "reset", "bystander"]) ids[k] = await h.mkUser(k, PW, orgId, "bookkeeper");
    await h.start();
    for (const who of ["admin", "deact", "reset", "bystander"]) expect(await h.login(who, h.email(who), PW), `login ${who}`).toBe(200);
    // The password changer holds TWO sessions: it changes the password in one; the other is the one under test.
    expect(await h.login("chg-a", h.email("chg"), PW)).toBe(200);
    expect(await h.login("chg-b", h.email("chg"), PW)).toBe(200);
  }, 120_000);

  afterAll(async () => {
    await h.stop();
    await h.cleanup();
  });

  it("PREMISE: every session reaches a business route before any act", async () => {
    const statuses = await Promise.all(["admin", "deact", "reset", "bystander", "chg-a", "chg-b"].map(async (w) => [w, (await h.api(w, "GET", BUSINESS_GET)).status]));
    // eslint-disable-next-line no-console
    console.warn("[S1B G02] PREMISE", JSON.stringify(statuses));
    for (const [, s] of statuses) expect(s).toBe(200);
  });

  it("🔴 PROOF (deactivation): after an admin deactivates the account, its EXISTING session is refused", async () => {
    const act = await h.api("admin", "PATCH", `/auth/users/${ids.deact}`, { isActive: false });
    const old = await h.api("deact", "GET", BUSINESS_GET);
    const me = await h.api("deact", "GET", "/auth/me");
    const fresh = await h.login("deact-fresh", h.email("deact"), PW);
    const bystander = await h.api("bystander", "GET", BUSINESS_GET);
    const account = (await pool.query(`SELECT is_active FROM users WHERE id = $1`, [ids.deact])).rows[0];
    // eslint-disable-next-line no-console
    console.warn("[S1B G02] DEACTIVATE", JSON.stringify({ act: act.status, accountIsActive: account.is_active, oldSessionBusinessGet: old.status, oldSessionMe: me.status, freshLogin: fresh, bystander: bystander.status }));
    expect(act.status, JSON.stringify(act.body)).toBe(200);
    expect(fresh, "CONTROL: the deactivation took effect (a fresh login is refused)").toBe(401);
    expect(bystander.status, "CONTROL: an unaffected session keeps working").toBe(200);
    expect.soft([401, 403], "the deactivated account's existing session is refused").toContain(old.status);
  });

  it("🔴 PROOF (own password change): after the user changes the password in one session, the user's OTHER existing session is refused", async () => {
    const act = await h.api("chg-a", "POST", "/auth/change-password", { currentPassword: PW, newPassword: NEW_PW });
    const other = await h.api("chg-b", "GET", BUSINESS_GET);
    const oldPw = await h.login("chg-oldpw", h.email("chg"), PW);
    const newPw = await h.login("chg-newpw", h.email("chg"), NEW_PW);
    // eslint-disable-next-line no-console
    console.warn("[S1B G02] CHANGE-PASSWORD", JSON.stringify({ act: act.status, otherSessionBusinessGet: other.status, loginOldPassword: oldPw, loginNewPassword: newPw }));
    expect(act.status, JSON.stringify(act.body)).toBe(200);
    expect(oldPw, "CONTROL: the old password no longer signs in").toBe(401);
    expect(newPw, "CONTROL: the new password signs in").toBe(200);
    expect.soft([401, 403], "the user's other existing session is refused after a password change").toContain(other.status);
  });

  it("🔴 PROOF (admin reset): after an admin resets the user's password, the user's EXISTING session is refused", async () => {
    // CONTROL by the stored hash, not by a login: this file's logins exhaust the per-IP login limiter (run 1 saw 429).
    const hash = async () => (await pool.query(`SELECT password_hash FROM users WHERE id = $1`, [ids.reset])).rows[0].password_hash as string;
    const hashBefore = await hash();
    const act = await h.api("admin", "POST", `/auth/users/${ids.reset}/reset-password`, { newPassword: NEW_PW });
    const old = await h.api("reset", "GET", BUSINESS_GET);
    const hashChanged = (await hash()) !== hashBefore;
    // eslint-disable-next-line no-console
    console.warn("[S1B G02] ADMIN-RESET", JSON.stringify({ act: act.status, oldSessionBusinessGet: old.status, storedHashChanged: hashChanged }));
    expect(act.status, JSON.stringify(act.body)).toBe(200);
    expect(hashChanged, "CONTROL: the reset took effect (the stored password hash changed)").toBe(true);
    expect.soft([401, 403], "the reset user's existing session is refused").toContain(old.status);
  });
});
