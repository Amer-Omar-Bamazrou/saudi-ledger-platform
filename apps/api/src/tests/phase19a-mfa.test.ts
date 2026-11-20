/**
 * 🔴 Phase 19A slice 2 — 19.1 enrolment, 19.2 verification, 19.3 recovery and the assisted reset (owner approval of
 * the Phase 19 proposal v2 and the MFA policy, 2026-11-17). The proving test of control 19A-M (controls/registry.ts).
 *
 *   - ENROLMENT: an operator and an org admin without a factor reach ONLY enrolment; the factor is inactive until one
 *     correct code; the secret is stored sealed (its bytes appear nowhere in the row) and is never served again;
 *   - VERIFICATION: a session that owes the code reaches only the code step; a used code is refused; the per-ACCOUNT
 *     limit is reached and named; the session id rotates on success;
 *   - BREAK-GLASS satisfies the password step only: then the code, never break-glass alone;
 *   - RECOVERY: a recovery code works once; no email path exists;
 *   - RESET: only a platform operator, after stating the identity check — never an org admin; it ends the account's
 *     sessions and recovery codes, is recorded, and for 30 days that account cannot approve a held bank-detail change
 *     (A1), tested just inside and just outside the window;
 *   - a member who is not an admin is not forced to enrol, and another organisation is untouched (movement).
 *
 * DB-backed (sl_test / CI); skips on the DB-free placeholder. Logins are spread over accounts; the per-IP auth limit
 * (10 per 15 minutes per process) is reset between groups by the product's own test seam — never raised.
 */
process.env.PORT ??= "3221";
process.env.SESSION_SECRET ??= "phase19a-mfa-test-secret-0000000000001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";
process.env.MFA_ENFORCEMENT = "required";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness } from "./helpers/g04Harness";
import { base32Decode, currentTotpStep, totpAt } from "../lib/totp";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "P19aMfaPw123!";
const BUSINESS_GET = "/invoices";

describeMaybe("Phase 19A slice 2 — MFA: enrolment, verification, recovery, the assisted reset, and A1", () => {
  const h = g04Harness("p19m");
  const ids: Record<string, number> = {};
  const secrets: Record<string, Buffer> = {};
  const recovery: Record<string, string[]> = {};
  let orgA = "";
  let companyA = "";
  let orgB = "";
  /** The exact code activation accepted — replayed later, never recomputed (a step boundary would make it a new code). */
  let activationCode = "";
  /** A code for a step nobody has used yet (each call moves one step on, inside the accepted drift). */
  const code = (who: string, at = 0) => totpAt(secrets[who]!, currentTotpStep() + at);
  /**
   * FIXTURE: forget the last step a factor accepted, so the test can sign in again inside the same 30 seconds. Only
   * replica mode can do it — the product cannot rewind the guard (the last test proves that).
   */
  const forgetLastStep = async (userId: number) => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL session_replication_role = replica");
      await c.query(`UPDATE user_mfa_factors SET last_used_step = NULL WHERE user_id = $1`, [userId]);
      await c.query("COMMIT");
    } finally { c.release(); }
  };
  const resetLimits = async () => { await (await import("../routes/auth")).__resetRateLimitsForTests(); };
  const events = async (action: string, target: number) =>
    (await pool.query(`SELECT actor_user_id, organization_id, request_id, metadata FROM security_audit_logs WHERE action = $1 AND target_user_id = $2 ORDER BY created_at`, [action, target])).rows;

  /** Sign in, enrol and activate — the product's own path — and keep the secret and recovery codes. */
  async function enrol(who: string, key: string): Promise<void> {
    expect(await h.login(who, h.email(key), PW)).toBe(200);
    const begun = await h.api(who, "POST", "/auth/mfa/enrol");
    expect(begun.status, JSON.stringify(begun.body)).toBe(200);
    secrets[who] = base32Decode(begun.body.secret);
    const done = await h.api(who, "POST", "/auth/mfa/activate", { code: code(who) });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    recovery[who] = done.body.recoveryCodes;
  }

  beforeAll(async () => {
    await h.cleanup();
    orgA = await h.mkOrg("a");
    companyA = await h.mkCompany(orgA, "P19M A", "318181818181847");
    orgB = await h.mkOrg("b");
    await h.mkCompany(orgB, "P19M B", "318181818181857");
    ids.admin = await h.mkUser("admin", PW, orgA, "admin");
    ids.admin2 = await h.mkUser("admin2", PW, orgA, "admin");
    ids.admin3 = await h.mkUser("admin3", PW, orgA, "admin");
    ids.book = await h.mkUser("book", PW, orgA, "bookkeeper");
    ids.bAdmin = await h.mkUser("b-admin", PW, orgB, "admin");
    ids.op = await h.mkUser("op", PW, null);
    ids.op2 = await h.mkUser("op2", PW, null);
    await pool.query(`INSERT INTO platform_operators (user_id) VALUES ($1), ($2)`, [ids.op, ids.op2]);
    await h.start();
  }, 120_000);
  afterAll(async () => { await h.stop(); await h.cleanup(); });

  it("🔴 19.1 — an admin without a factor reaches ONLY enrolment; a bookkeeper is not forced; the login says which step is owed", async () => {
    const login = await h.api("admin", "POST", "/auth/login", { email: h.email("admin"), password: PW });
    expect(login.status).toBe(200);
    expect(login.body.user.mfaStep).toBe("enrol");
    const refused = await h.api("admin", "GET", BUSINESS_GET);
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ code: "mfa_enrolment_required", errorAr: expect.any(String) });
    expect((await h.api("admin", "GET", "/auth/users")).status, "the admin surface is held too").toBe(403);
    expect((await h.api("admin", "GET", "/auth/sessions")).status).toBe(403);
    expect((await h.api("admin", "GET", "/auth/me")).body.mfaStep).toBe("enrol");
    expect((await h.api("admin", "GET", "/auth/mfa")).body).toMatchObject({ required: true, state: "none", step: "enrol" });
    // movement: a member who is not an admin works without a factor
    const book = await h.api("book", "POST", "/auth/login", { email: h.email("book"), password: PW });
    expect(book.body.user.mfaStep ?? null).toBeNull();
    expect((await h.api("book", "GET", BUSINESS_GET)).status).toBe(200);
    expect((await h.api("book", "GET", "/auth/mfa")).body).toMatchObject({ required: false, state: "none", step: null });
  });

  it("🔴 19.1 — the factor is INACTIVE until one correct code; the stored secret is sealed; activation issues recovery codes once and rotates the session", async () => {
    const begun = await h.api("admin", "POST", "/auth/mfa/enrol");
    expect(begun.status).toBe(200);
    expect(begun.body).toMatchObject({ secret: expect.stringMatching(/^[A-Z2-7]{32}$/), otpauthUri: expect.stringContaining("otpauth://totp/"), qrSvg: expect.stringContaining("<svg") });
    secrets.admin = base32Decode(begun.body.secret);
    const row = (await pool.query(`SELECT * FROM user_mfa_factors WHERE user_id = $1`, [ids.admin])).rows[0];
    expect(row.state).toBe("pending");
    for (const col of ["encrypted_secret", "wrapped_data_key", "secret_iv", "secret_auth_tag"]) {
      expect(Buffer.isBuffer(row[col]), col).toBe(true);
      expect((row[col] as Buffer).includes(secrets.admin!), `${col} does not hold the secret in the clear`).toBe(false);
    }
    expect(JSON.stringify(row)).not.toContain(begun.body.secret);
    expect((await h.api("admin", "GET", BUSINESS_GET)).status, "pending is not enrolled").toBe(403);
    const wrong = await h.api("admin", "POST", "/auth/mfa/activate", { code: "000000" === code("admin") ? "111111" : "000000" });
    expect(wrong.status).toBe(422);
    expect(wrong.body).toMatchObject({ code: "mfa_code_invalid", errorAr: expect.any(String) });
    expect((await pool.query(`SELECT state FROM user_mfa_factors WHERE user_id = $1`, [ids.admin])).rows[0].state).toBe("pending");
    const sidBefore = (await pool.query(`SELECT sid FROM user_sessions WHERE (sess ->> 'userId')::int = $1`, [ids.admin])).rows.map((r) => r.sid);
    activationCode = code("admin");
    const done = await h.api("admin", "POST", "/auth/mfa/activate", { code: activationCode });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    recovery.admin = done.body.recoveryCodes;
    expect(recovery.admin).toHaveLength(10);
    expect(new Set(recovery.admin).size).toBe(10);
    const sidAfter = (await pool.query(`SELECT sid FROM user_sessions WHERE (sess ->> 'userId')::int = $1`, [ids.admin])).rows.map((r) => r.sid);
    expect(sidAfter).toHaveLength(1);
    expect(sidBefore, "the session id rotated").not.toContain(sidAfter[0]);
    expect((await h.api("admin", "GET", BUSINESS_GET)).status, "enrolled: the session is whole").toBe(200);
    // the secret and the codes are never served again
    const status = await h.api("admin", "GET", "/auth/mfa");
    expect(status.body).toMatchObject({ required: true, state: "active", step: null, recoveryCodesLeft: 10 });
    expect(JSON.stringify(status.body)).not.toContain(begun.body.secret);
    expect((await h.api("admin", "POST", "/auth/mfa/enrol")).status, "an active factor is not re-enrolled").toBe(409);
    const hashes = (await pool.query(`SELECT code_hash FROM user_mfa_recovery_codes WHERE user_id = $1`, [ids.admin])).rows.map((r) => r.code_hash as string);
    expect(hashes).toHaveLength(10);
    for (const c of recovery.admin!) expect(hashes.join("|"), "codes are stored hashed").not.toContain(c);
    expect(await events("mfa.enrolled", ids.admin!)).toHaveLength(1);
    expect((await events("mfa.failed", ids.admin!)).map((e) => e.metadata.at), "the wrong activation code is recorded").toEqual(["activation"]);
    const activated = await events("mfa.activated", ids.admin!);
    expect(activated).toHaveLength(1);
    expect(activated[0]).toMatchObject({ actor_user_id: ids.admin, organization_id: orgA, request_id: expect.any(String) });
  });

  it("🔴 19.2 — a session that owes the code reaches only the code step; a used code is refused; success rotates the session", async () => {
    await resetLimits();
    const login = await h.api("admin-b", "POST", "/auth/login", { email: h.email("admin"), password: PW });
    expect(login.body.user.mfaStep).toBe("code");
    const refused = await h.api("admin-b", "GET", BUSINESS_GET);
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ code: "mfa_code_required", errorAr: expect.any(String) });
    for (const path of ["/auth/users", "/auth/sessions", "/auth/mfa/enrol"]) {
      expect((await h.api("admin-b", path === "/auth/mfa/enrol" ? "POST" : "GET", path)).status, path).toBe(403);
    }
    expect((await h.api("admin-b", "POST", "/auth/change-password", { currentPassword: PW, newPassword: "Another1Pw!23" })).status, "not even a password change").toBe(403);
    // the step activation accepted is USED: the same code is a replay
    const replay = await h.api("admin-b", "POST", "/auth/mfa/verify", { code: activationCode });
    expect(replay.status).toBe(422);
    expect(replay.body.code).toBe("mfa_code_invalid");
    expect((await h.api("admin-b", "GET", BUSINESS_GET)).status).toBe(403);
    const sidBefore = (await pool.query(`SELECT sid FROM user_sessions WHERE (sess ->> 'userId')::int = $1 AND sess ->> 'mfaStep' = 'code'`, [ids.admin])).rows.map((r) => r.sid);
    expect(sidBefore).toHaveLength(1);
    const ok = await h.api("admin-b", "POST", "/auth/mfa/verify", { code: code("admin", 1) });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await h.api("admin-b", "GET", BUSINESS_GET)).status).toBe(200);
    const sids = (await pool.query(`SELECT sid FROM user_sessions WHERE (sess ->> 'userId')::int = $1`, [ids.admin])).rows.map((r) => r.sid);
    expect(sids, "the session id rotated").not.toContain(sidBefore[0]);
    const verified = await events("mfa.verified", ids.admin!);
    expect(verified).toHaveLength(1);
    expect(verified[0]).toMatchObject({ actor_user_id: ids.admin, organization_id: orgA, request_id: expect.any(String) });
    expect((await events("mfa.failed", ids.admin!)).filter((e) => e.metadata.at === "sign_in"), "the replay is recorded as a failure").toHaveLength(1);
  });

  it("🔴 19.2 — attempts are limited per ACCOUNT: the limit is reached and named, and a correct code is then refused too", async () => {
    await resetLimits();
    expect(await h.login("admin-c", h.email("admin"), PW)).toBe(200);
    let last = { status: 0, body: {} as any };
    for (let i = 0; i < 5; i++) last = await h.api("admin-c", "POST", "/auth/mfa/verify", { code: "12345" + i });
    expect(last.status).toBe(422);
    const limited = await h.api("admin-c", "POST", "/auth/mfa/verify", { code: "123459" });
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe("rate_limited");
    // per ACCOUNT, not per session: another session of the same account is limited too, even with a right code
    expect(await h.login("admin-d", h.email("admin"), PW)).toBe(200);
    await forgetLastStep(ids.admin!);
    expect((await h.api("admin-d", "POST", "/auth/mfa/verify", { code: code("admin") })).status, "a RIGHT, unused code").toBe(429);
    // movement: another account is not limited
    await enrol("bAdmin", "b-admin");
    expect((await h.api("bAdmin", "GET", BUSINESS_GET)).status).toBe(200);
    await resetLimits();
  });

  it("🔴 19.3 — a recovery code works ONCE, in place of the code; there is no email path", async () => {
    await resetLimits();
    expect(await h.login("admin-e", h.email("admin"), PW)).toBe(200);
    const bad = await h.api("admin-e", "POST", "/auth/mfa/recovery", { code: "AAAAA-AAAAA" });
    expect(bad.status).toBe(422);
    const used = recovery.admin![0]!;
    const ok = await h.api("admin-e", "POST", "/auth/mfa/recovery", { code: used });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ recoveryCodesLeft: 9 });
    expect((await h.api("admin-e", "GET", BUSINESS_GET)).status).toBe(200);
    expect(await events("mfa.recovery_code_used", ids.admin!)).toHaveLength(1);
    expect(await h.login("admin-f", h.email("admin"), PW)).toBe(200);
    const again = await h.api("admin-f", "POST", "/auth/mfa/recovery", { code: used });
    expect(again.status, "a used code is refused").toBe(422);
    expect((await h.api("admin-f", "GET", BUSINESS_GET)).status).toBe(403);
    await expect(pool.query(`UPDATE user_mfa_recovery_codes SET used_at = NULL WHERE user_id = $1 AND used_at IS NOT NULL`, [ids.admin])).rejects.toThrow(/stays used/);
    for (const path of ["/auth/mfa/email", "/auth/mfa/recover-by-email", "/auth/mfa/reset", "/auth/forgot-mfa"]) {
      expect((await h.api("admin-f", "POST", path, { email: h.email("admin") })).status, `${path} does not exist`).toBeGreaterThanOrEqual(403);
    }
  });

  it("🔴 19.1 — an operator without a factor reaches only enrolment: no operator surface until enrolled", async () => {
    await resetLimits();
    const login = await h.api("op", "POST", "/auth/login", { email: h.email("op"), password: PW });
    expect(login.body.user.mfaStep).toBe("enrol");
    const refused = await h.api("op", "GET", "/operator/applications");
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("mfa_enrolment_required");
    expect((await h.api("op", "POST", "/operator/users/reset-password", { email: h.email("book") })).status).toBe(403);
    await enrol("op", "op");
    expect((await h.api("op", "GET", "/operator/applications")).status).toBe(200);
  });

  it("🔴 BREAK-GLASS satisfies the password step ONLY: the temporary password opens a session that still owes the code", async () => {
    await resetLimits();
    const reset = await h.api("op", "POST", "/operator/users/reset-password", { email: h.email("admin") });
    expect(reset.status, JSON.stringify(reset.body)).toBe(200);
    const temp = reset.body.temporaryPassword as string;
    expect(temp, "anti-vacuity: the break-glass issued a password").toEqual(expect.any(String));
    const login = await h.api("admin-g", "POST", "/auth/login", { email: h.email("admin"), password: temp });
    expect(login.status).toBe(200);
    expect(login.body.user.mfaStep).toBe("code");
    for (const path of [BUSINESS_GET, "/auth/users"]) expect((await h.api("admin-g", "GET", path)).body.code, path).toBe("mfa_code_required");
    expect((await h.api("admin-g", "POST", "/auth/change-password", { currentPassword: temp, newPassword: PW + "x" })).body.code, "the change waits for the code").toBe("mfa_code_required");
    await forgetLastStep(ids.admin!);
    expect((await h.api("admin-g", "POST", "/auth/mfa/verify", { code: code("admin") })).status).toBe(200);
    // after the code, the break-glass rule applies as before: the password must be changed first
    expect((await h.api("admin-g", "GET", BUSINESS_GET)).body.code).toBe("password_change_required");
    expect((await h.api("admin-g", "POST", "/auth/change-password", { currentPassword: temp, newPassword: PW })).status).toBe(200);
    expect((await h.api("admin-g", "GET", BUSINESS_GET)).status).toBe(200);
  });

  it("🔴 19.3 — an org admin CANNOT reset another person's factor; only a platform operator can, stating the identity check", async () => {
    await resetLimits();
    await enrol("admin2", "admin2");
    for (const [method, path, body] of [
      ["POST", `/auth/users/${ids.admin2}/mfa/reset`, {}], ["POST", `/auth/users/${ids.admin2}/mfa-reset`, {}], ["DELETE", `/auth/users/${ids.admin2}/mfa`, {}],
      ["POST", "/operator/users/mfa-reset", { email: h.email("admin2"), identityVerified: true, basis: "an admin trying the operator route" }],
    ] as const) {
      const res = await h.api("admin-g", method, path, body);
      expect(res.status, `${method} ${path}`).toBeGreaterThanOrEqual(403);
    }
    expect((await pool.query(`SELECT state FROM user_mfa_factors WHERE user_id = $1`, [ids.admin2])).rows[0].state, "the factor is untouched").toBe("active");
    const noCheck = await h.api("op", "POST", "/operator/users/mfa-reset", { email: h.email("admin2"), basis: "called support" });
    expect(noCheck.status).toBe(422);
    expect(noCheck.body).toMatchObject({ code: "mfa_reset_identity_unverified" });
    const noBasis = await h.api("op", "POST", "/operator/users/mfa-reset", { email: h.email("admin2"), identityVerified: true, basis: "  " });
    expect(noBasis.status).toBe(422);
    expect((await h.api("admin2", "GET", BUSINESS_GET)).status, "anti-vacuity: the account's session works before the reset").toBe(200);
    const done = await h.api("op", "POST", "/operator/users/mfa-reset", { email: h.email("admin2"), identityVerified: true, basis: "Video call; CR extract and national ID matched the verification file." });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toMatchObject({ sessionsEnded: 1, recoveryCodesInvalidated: 10, notified: expect.any(String) });
    expect((await h.api("admin2", "GET", BUSINESS_GET)).status, "its sessions ended").toBe(401);
    expect((await pool.query(`SELECT count(*)::int n FROM user_mfa_factors WHERE user_id = $1`, [ids.admin2])).rows[0].n).toBe(0);
    expect((await pool.query(`SELECT count(*)::int n FROM user_mfa_recovery_codes WHERE user_id = $1`, [ids.admin2])).rows[0].n).toBe(0);
    const ev = await events("mfa.reset", ids.admin2!);
    expect(ev.filter((e) => e.actor_user_id === ids.op), "one operator-identified record").toHaveLength(1);
    expect(ev.find((e) => e.actor_user_id === ids.op)!.metadata).toMatchObject({ identityVerified: true, basis: expect.stringContaining("Video call"), sessionsEnded: 1 });
    expect(ev.filter((e) => e.organization_id === orgA), "and the organisation's admins see it").toHaveLength(1);
    // an operator does not reset their own factor, and the reset account must enrol again
    expect((await h.api("op", "POST", "/operator/users/mfa-reset", { email: h.email("op"), identityVerified: true, basis: "The operator asking for their own reset." })).status).toBe(409);
    const relogin = await h.api("admin2", "POST", "/auth/login", { email: h.email("admin2"), password: PW });
    expect(relogin.body.user.mfaStep).toBe("enrol");
    expect((await h.api("admin2", "GET", "/auth/mfa")).body.lastResetAt, "the person is told at their next sign-in").toEqual(expect.any(String));
  });

  it("🔴 A1 — for 30 days after its factor was reset, an account cannot approve a held bank-detail change; just outside the window it can", async () => {
    await resetLimits();
    await enrol("admin2", "admin2");
    const vendor = await h.api("admin-g", "POST", "/vendors", { name: "P19M Vendor", residency: "resident", iban: "SA0380000000608010167519" });
    expect(vendor.status, JSON.stringify(vendor.body)).toBeLessThan(300);
    const change = await h.api("admin-g", "PATCH", `/vendors/${vendor.body.id}`, { iban: "SA1310000000111122223333" });
    expect(change.status, JSON.stringify(change.body)).toBeLessThan(300);
    const pending = (change.body.pendingBankDetailChanges ?? []) as Array<{ id: number }>;
    expect(pending.length, "the change is held for a second admin").toBe(1);
    const decide = (who: string) => h.api(who, "PUT", `/companies/current/bank-detail-changes/${pending[0]!.id}/decision`, { decision: "approve" });
    const refused = await decide("admin2");
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body).toMatchObject({ code: "bank_detail_approver_mfa_reset", errorAr: expect.any(String) });
    expect(refused.body.error).toContain("internal control");
    // just INSIDE the window: 29 days 23 hours ago — still refused
    const move = (interval: string) => pool.connect().then(async (c) => {
      try {
        await c.query("BEGIN");
        await c.query("SET LOCAL session_replication_role = replica");
        await c.query(`UPDATE security_audit_logs SET created_at = localtimestamp - $2::interval WHERE action = 'mfa.reset' AND target_user_id = $1`, [ids.admin2, interval]);
        await c.query("COMMIT");
      } finally { c.release(); }
    });
    await move("29 days 23 hours");
    expect((await decide("admin2")).status, "29d 23h after the reset").toBe(409);
    await move("30 days 1 hour");
    const ok = await decide("admin2");
    expect(ok.status, `30d 1h after the reset: ${JSON.stringify(ok.body)}`).toBe(200);
    void companyA;
  });

  it("an active factor's secret is fixed AT THE DATABASE, and an accepted step never goes backwards", async () => {
    await expect(pool.query(`UPDATE user_mfa_factors SET encrypted_secret = '\\x00' WHERE user_id = $1`, [ids.admin])).rejects.toThrow(/never rewritten/);
    await expect(pool.query(`UPDATE user_mfa_factors SET state = 'pending', activated_at = NULL WHERE user_id = $1`, [ids.admin])).rejects.toThrow(/never rewritten/);
    await expect(pool.query(`UPDATE user_mfa_factors SET last_used_step = last_used_step - 5 WHERE user_id = $1`, [ids.admin])).rejects.toThrow(/never goes backwards/);
  });
});
