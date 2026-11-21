/**
 * 🔴 Phase 19A — WHO RESETS A SECOND FACTOR (the owner's MFA policy of 2026-11-17, restored 2026-11-21): organisation
 * admins must not reset another user's MFA; only platform operators perform an assisted reset, after identity
 * verification. The reset is audited, tells the person, and ends the account's sessions and recovery codes.
 *
 *   - AN ADMIN HAS NO PATH to reset anyone's factor — another member's, another admin's, their own, or a member of
 *     another organization — by any route shape; neither has a member who is not an admin. Nothing changes: the
 *     factors and recovery codes stay, no reset is recorded, and the member's session still works;
 *   - THE OPERATOR resets a member of an organization that HAS admins (a bookkeeper, and an admin whose organization
 *     has another admin), stating the identity check: the factor, the recovery codes and every session go; it is
 *     recorded with the operator named and in the organization's own trail; A1 counts it; the person is told;
 *   - an account that belongs to two organizations is reset the same way, and each organization's trail sees it;
 *   - nothing to reset (no active factor) is refused by name, so a reset record always means a factor was removed.
 *
 * A proving test of control 19A-M (controls/registry.ts). DB-backed (sl_test / CI); skips on the DB-free placeholder.
 */
process.env.PORT ??= "3226";
process.env.SESSION_SECRET ??= "phase19a-mfa-reset-operator-test-secret";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";
process.env.MFA_ENFORCEMENT = "optional";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness } from "./helpers/g04Harness";
import { base32Decode, currentTotpStep, totpAt } from "../lib/totp";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "P19aOperatorResetPw1!";
const BASIS = "Video call; national ID matched the verification file.";

describeMaybe("Phase 19A — only a platform operator resets a second factor; an organization admin has no path to it", () => {
  const h = g04Harness("p19r");
  const ids: Record<string, number> = {};
  const orgs: Record<string, string> = {};
  const resetLimits = async () => { await (await import("../routes/auth")).__resetRateLimitsForTests(); };
  const resets = async (target: number) =>
    (await pool.query(`SELECT actor_user_id, organization_id, metadata FROM security_audit_logs WHERE action = 'mfa.reset' AND target_user_id = $1 ORDER BY created_at, id`, [target])).rows;
  const factorState = async (userId: number) =>
    (await pool.query(`SELECT state FROM user_mfa_factors WHERE user_id = $1`, [userId])).rows[0]?.state ?? "none";
  const codesLeft = async (userId: number) =>
    (await pool.query(`SELECT count(*)::int AS n FROM user_mfa_recovery_codes WHERE user_id = $1 AND used_at IS NULL`, [userId])).rows[0].n as number;
  const operatorReset = (who: string, extra: Record<string, unknown> = {}) =>
    h.api("op", "POST", "/operator/users/mfa-reset", { email: h.email(who), identityVerified: true, basis: BASIS, ...extra });

  /** The product's own path: sign in, enrol, activate with one code. Leaves the session whole. */
  async function enrol(who: string): Promise<void> {
    expect(await h.login(who, h.email(who), PW)).toBe(200);
    const begun = await h.api(who, "POST", "/auth/mfa/enrol");
    expect(begun.status, JSON.stringify(begun.body)).toBe(200);
    const secret = base32Decode(begun.body.secret);
    const done = await h.api(who, "POST", "/auth/mfa/activate", { code: totpAt(secret, currentTotpStep()) });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
  }
  /** FIXTURE: an active factor and recovery codes as rows (a reset never opens the secret, so the bytes are inert). */
  async function plantFactor(userId: number): Promise<void> {
    await pool.query(
      `INSERT INTO user_mfa_factors (user_id, state, kms_provider, kms_key_id, wrapped_data_key, encrypted_secret, secret_iv, secret_auth_tag, activated_at)
       VALUES ($1, 'active', 'local-dev', 'fixture', '\\x01', '\\x02', '\\x03', '\\x04', now())`, [userId]);
    await pool.query(`INSERT INTO user_mfa_recovery_codes (user_id, code_hash) SELECT $1, 'fixture-' || g FROM generate_series(1, 10) g`, [userId]);
  }

  beforeAll(async () => {
    await h.cleanup();
    orgs.a = await h.mkOrg("a");
    await h.mkCompany(orgs.a, "P19R A", "318181818181867");
    orgs.b = await h.mkOrg("b");
    await h.mkCompany(orgs.b, "P19R B", "318181818181877");
    ids.admina = await h.mkUser("admina", PW, orgs.a, "admin");
    ids.admina2 = await h.mkUser("admina2", PW, orgs.a, "admin");
    ids.book = await h.mkUser("book", PW, orgs.a, "bookkeeper");
    ids.book2 = await h.mkUser("book2", PW, orgs.a, "bookkeeper");
    ids.admina3 = await h.mkUser("admina3", PW, orgs.a, "admin");
    ids.plain = await h.mkUser("plain", PW, orgs.a, "bookkeeper");
    ids.shared = await h.mkUser("shared", PW, orgs.a, "bookkeeper");
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1, $2, 'viewer', 'active')`, [ids.shared, orgs.b]);
    ids.adminb = await h.mkUser("adminb", PW, orgs.b, "admin");
    ids.bookb = await h.mkUser("bookb", PW, orgs.b, "bookkeeper");
    ids.op = await h.mkUser("op", PW, null);
    await pool.query(`INSERT INTO platform_operators (user_id) VALUES ($1)`, [ids.op]);
    for (const who of ["admina2", "admina3", "shared", "bookb"]) await plantFactor(ids[who]!);
    await h.start();
    await resetLimits();
    for (const who of ["adminb", "plain", "op"]) expect(await h.login(who, h.email(who), PW), who).toBe(200);
  }, 120_000);
  afterAll(async () => { await resetLimits(); await h.stop(); await h.cleanup(); });

  it("🔴 an admin has NO path to reset anyone's factor — a member's, another admin's, their own, another organization's — and neither has a member", async () => {
    await enrol("admina");
    await enrol("book");
    const targets = ["book", "admina2", "admina", "bookb"] as const;
    for (const who of targets) {
      expect(await factorState(ids[who]!), `anti-vacuity: ${who} holds an active factor`).toBe("active");
      expect(await codesLeft(ids[who]!), `anti-vacuity: ${who} holds recovery codes`).toBe(10);
    }
    expect((await h.api("book", "GET", "/invoices")).status, "anti-vacuity: the member's session works before the attempts").toBe(200);
    for (const actor of ["admina", "plain"] as const) {
      for (const who of targets) {
        const id = ids[who]!;
        for (const [method, path, body] of [
          ["POST", `/auth/users/${id}/mfa-reset`, {}],
          ["POST", `/auth/users/${id}/mfa/reset`, {}],
          ["DELETE", `/auth/users/${id}/mfa`, {}],
          ["POST", "/operator/users/mfa-reset", { email: h.email(who), identityVerified: true, basis: "an admin trying the operator route" }],
        ] as const) {
          const res = await h.api(actor, method, path, body);
          expect(res.status, `${actor} → ${method} ${path} (${who}): ${JSON.stringify(res.body)}`).toBeGreaterThanOrEqual(403);
        }
      }
    }
    for (const path of ["/auth/mfa/reset", "/auth/mfa-reset"]) {
      expect((await h.api("admina", "POST", path, {})).status, `${path}: no own-reset path either`).toBeGreaterThanOrEqual(403);
    }
    for (const who of targets) {
      expect(await factorState(ids[who]!), `${who}: the factor is untouched`).toBe("active");
      expect(await codesLeft(ids[who]!), `${who}: and its recovery codes`).toBe(10);
      expect(await resets(ids[who]!), `${who}: nothing is recorded as a reset`).toHaveLength(0);
    }
    expect((await h.api("book", "GET", "/invoices")).status, "the member's session still works").toBe(200);
    expect((await h.api("admina", "GET", "/invoices")).status, "and the admin's own").toBe(200);
  });

  it("🔴 the operator resets a member of an organization that HAS admins: the factor, the codes and every session go; recorded; A1 counts it; the person is told", async () => {
    await resetLimits();
    await enrol("book2");
    expect(await factorState(ids.book2!)).toBe("active");
    expect((await h.api("book2", "GET", "/invoices")).status, "anti-vacuity: the member's session works before the reset").toBe(200);
    const noCheck = await h.api("op", "POST", "/operator/users/mfa-reset", { email: h.email("book2"), basis: BASIS });
    expect(noCheck.status, "not without the identity check").toBe(422);
    expect(noCheck.body).toMatchObject({ code: "mfa_reset_identity_unverified", errorAr: expect.any(String) });
    expect(await factorState(ids.book2!)).toBe("active");

    const done = await operatorReset("book2");
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toMatchObject({ sessionsEnded: 1, recoveryCodesInvalidated: 10, notified: expect.stringMatching(/^(email_and_next_sign_in|next_sign_in)$/) });
    expect(await factorState(ids.book2!), "the factor is removed").toBe("none");
    expect((await pool.query(`SELECT count(*)::int AS n FROM user_mfa_recovery_codes WHERE user_id = $1`, [ids.book2])).rows[0].n, "and every recovery code").toBe(0);
    expect((await h.api("book2", "GET", "/invoices")).status, "every session of the account ended").toBe(401);
    const ev = await resets(ids.book2!);
    expect(ev.filter((r) => r.actor_user_id === ids.op), "one record naming the operator").toHaveLength(1);
    expect(ev.find((r) => r.actor_user_id === ids.op)).toMatchObject({ organization_id: null, metadata: { identityVerified: true, basis: BASIS, hadFactor: true, sessionsEnded: 1, recoveryCodesInvalidated: 10 } });
    expect(ev.filter((r) => r.organization_id === orgs.a), "and one in the organization's own trail").toHaveLength(1);
    expect(ev, "nothing else").toHaveLength(2);
    expect((await pool.query(`SELECT bank_detail_approver_recent_mfa_reset($1) AS r`, [ids.book2])).rows[0].r, "A1 counts the reset").toBe(true);
    expect((await pool.query(`SELECT bank_detail_approver_recent_mfa_reset($1) AS r`, [ids.plain])).rows[0].r, "movement: a member nobody reset").toBe(false);
    // the person is told at their next sign-in
    expect(await h.login("book2", h.email("book2"), PW)).toBe(200);
    expect((await h.api("book2", "GET", "/auth/mfa")).body).toMatchObject({ state: "none", lastResetAt: expect.any(String) });

    // an ADMIN whose organization has another admin: the operator resets them too
    const admin = await operatorReset("admina3");
    expect(admin.status, JSON.stringify(admin.body)).toBe(200);
    expect(await factorState(ids.admina3!)).toBe("none");
    expect(await codesLeft(ids.admina3!)).toBe(0);
    // movement: the organization's other admin, nobody reset, keeps their factor
    expect(await factorState(ids.admina2!)).toBe("active");
  });

  it("🔴 an account that belongs to two organizations is reset by the operator, and each organization's trail sees it", async () => {
    const res = await operatorReset("shared");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await factorState(ids.shared!)).toBe("none");
    const ev = await resets(ids.shared!);
    expect(ev.filter((r) => r.organization_id === orgs.a)).toHaveLength(1);
    expect(ev.filter((r) => r.organization_id === orgs.b)).toHaveLength(1);
    // movement: organization B's own member, nobody reset, keeps their factor
    expect(await factorState(ids.bookb!)).toBe("active");
  });

  it("🔴 nothing to reset is refused by name: a reset record always means a factor was removed", async () => {
    expect(await factorState(ids.plain!), "anti-vacuity: no factor").toBe("none");
    const res = await operatorReset("plain");
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body).toMatchObject({ code: "mfa_not_set_up", errorAr: expect.any(String) });
    expect(await resets(ids.plain!)).toHaveLength(0);
    expect((await h.api("plain", "GET", "/invoices")).status, "and the person's session is untouched").toBe(200);
  });
});
