/**
 * 🔴 Phase 19A follow-up (owner, 2026-11-20) — WHO RESETS A SECOND FACTOR. The decision: an organisation admin may
 * reset another member's two-step verification in their own organisation, never their own; a platform operator resets
 * only as the break-glass, when the organisation has no other usable admin; every reset is audited and counts under A1.
 *
 *   - THE ADMIN PATH has the operator's effects: the factor and the recovery codes removed, every session of the
 *     account ended, the person told, one `mfa.reset` record per organization — and A1 counts it;
 *   - an admin's OWN factor: refused, named, in both languages;
 *   - an admin of ANOTHER organization: refused exactly as an id that does not exist is (no existence leak), and the
 *     same member IS reset by their own admin (movement — the refusal is not vacuous);
 *   - an account that also belongs to another organization is no single admin's to reset (the F1 confinement rule):
 *     refused by name to both admins, and then the operator may;
 *   - THE OPERATOR is refused while an admin can do it, named in both languages, and allowed once none can: a sole
 *     admin, an organization whose other admin's account is deactivated, an organization not yet verified;
 *   - nothing to reset (no active factor) is refused, so a reset record always means a factor was removed.
 *
 * A proving test of control 19A-M (controls/registry.ts). DB-backed (sl_test / CI); skips on the DB-free placeholder.
 */
process.env.PORT ??= "3226";
process.env.SESSION_SECRET ??= "phase19a-admin-mfa-reset-test-secret-01";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";
process.env.MFA_ENFORCEMENT = "optional";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness } from "./helpers/g04Harness";
import { base32Decode, currentTotpStep, totpAt } from "../lib/totp";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "P19aAdminResetPw1!";
const NO_SUCH_USER = 2_000_000_007;

describeMaybe("Phase 19A follow-up — an org admin resets a member's second factor; the operator only when no admin can", () => {
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
  const sansRequestId = (body: any) => { const { requestId: _r, ...rest } = body ?? {}; return rest; };

  beforeAll(async () => {
    await h.cleanup();
    orgs.a = await h.mkOrg("a");
    await h.mkCompany(orgs.a, "P19R A", "318181818181867");
    orgs.b = await h.mkOrg("b");
    await h.mkCompany(orgs.b, "P19R B", "318181818181877");
    orgs.c = await h.mkOrg("c");
    orgs.d = await h.mkOrg("d");
    orgs.e = await h.mkOrg("e", "pending_review");
    orgs.f = await h.mkOrg("f");
    ids.admina = await h.mkUser("admina", PW, orgs.a, "admin");
    ids.admina2 = await h.mkUser("admina2", PW, orgs.a, "admin");
    ids.book = await h.mkUser("book", PW, orgs.a, "bookkeeper");
    ids.book2 = await h.mkUser("book2", PW, orgs.a, "bookkeeper");
    ids.book3 = await h.mkUser("book3", PW, orgs.a, "bookkeeper");
    ids.plain = await h.mkUser("plain", PW, orgs.a, "bookkeeper");
    ids.shared = await h.mkUser("shared", PW, orgs.a, "bookkeeper");
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1, $2, 'viewer', 'active')`, [ids.shared, orgs.b]);
    ids.adminb = await h.mkUser("adminb", PW, orgs.b, "admin");
    ids.soloc = await h.mkUser("soloc", PW, orgs.c, "admin");
    ids.d1 = await h.mkUser("d1", PW, orgs.d, "admin");
    ids.d2 = await h.mkUser("d2", PW, orgs.d, "admin");
    ids.e1 = await h.mkUser("e1", PW, orgs.e, "admin");
    ids.e2 = await h.mkUser("e2", PW, orgs.e, "admin");
    ids.solof = await h.mkUser("solof", PW, orgs.f, "admin");
    ids.op = await h.mkUser("op", PW, null);
    await pool.query(`INSERT INTO platform_operators (user_id) VALUES ($1)`, [ids.op]);
    for (const who of ["book2", "book3", "shared", "soloc", "d1", "e1"]) await plantFactor(ids[who]!);
    await h.start();
    await resetLimits();
    for (const who of ["admina", "adminb", "plain", "op"]) expect(await h.login(who, h.email(who), PW), who).toBe(200);
  }, 120_000);
  afterAll(async () => { await resetLimits(); await h.stop(); await h.cleanup(); });

  it("🔴 an admin resets a member's factor in their own organization, with the operator's effects; A1 counts it", async () => {
    await enrol("book");
    expect(await factorState(ids.book!)).toBe("active");
    expect(await codesLeft(ids.book!)).toBe(10);
    expect((await h.api("book", "GET", "/invoices")).status, "anti-vacuity: the member's session works before the reset").toBe(200);
    const done = await h.api("admina", "POST", `/auth/users/${ids.book}/mfa-reset`);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toMatchObject({ sessionsEnded: 1, recoveryCodesInvalidated: 10, notified: expect.stringMatching(/^(email_and_next_sign_in|next_sign_in)$/) });
    expect(await factorState(ids.book!), "the factor is removed").toBe("none");
    expect((await pool.query(`SELECT count(*)::int AS n FROM user_mfa_recovery_codes WHERE user_id = $1`, [ids.book])).rows[0].n, "and every recovery code").toBe(0);
    expect((await h.api("book", "GET", "/invoices")).status, "every session of the account ended").toBe(401);
    const ev = await resets(ids.book!);
    expect(ev, "one record, in the organization, naming the admin").toHaveLength(1);
    expect(ev[0]).toMatchObject({ actor_user_id: ids.admina, organization_id: orgs.a, metadata: { by: "admin", hadFactor: true, sessionsEnded: 1, recoveryCodesInvalidated: 10 } });
    expect((await pool.query(`SELECT bank_detail_approver_recent_mfa_reset($1) AS r`, [ids.book])).rows[0].r, "A1 counts an admin's reset").toBe(true);
    expect((await pool.query(`SELECT bank_detail_approver_recent_mfa_reset($1) AS r`, [ids.plain])).rows[0].r, "movement: a member nobody reset").toBe(false);
    // the person is told at their next sign-in, and by whom
    expect(await h.login("book", h.email("book"), PW)).toBe(200);
    expect((await h.api("book", "GET", "/auth/mfa")).body).toMatchObject({ state: "none", lastResetAt: expect.any(String), lastResetBy: "admin" });
  });

  it("🔴 an admin cannot reset their OWN factor — refused by name, in both languages; the factor stays", async () => {
    await enrol("admina2");
    const own = await h.api("admina2", "POST", `/auth/users/${ids.admina2}/mfa-reset`);
    expect(own.status).toBe(409);
    expect(own.body).toMatchObject({ code: "mfa_reset_own_refused", error: expect.stringContaining("another admin"), errorAr: expect.stringContaining("مسؤول آخر") });
    expect(await factorState(ids.admina2!)).toBe("active");
    expect(await resets(ids.admina2!)).toHaveLength(0);
    expect((await h.api("admina2", "GET", "/invoices")).status, "and the admin's own session is untouched").toBe(200);
  });

  it("🔴 an admin of ANOTHER organization is refused exactly as a missing id is — no existence leak; the member's own admin can", async () => {
    const foreign = await h.api("adminb", "POST", `/auth/users/${ids.book2}/mfa-reset`);
    const missing = await h.api("adminb", "POST", `/auth/users/${NO_SUCH_USER}/mfa-reset`);
    const operatorId = await h.api("adminb", "POST", `/auth/users/${ids.op}/mfa-reset`);
    expect(foreign.status).toBe(404);
    expect(foreign.body).toMatchObject({ code: "user_not_found", errorAr: expect.any(String) });
    expect({ status: missing.status, body: sansRequestId(missing.body) }, "a member of another organization reads as no one").toEqual({ status: foreign.status, body: sansRequestId(foreign.body) });
    expect({ status: operatorId.status, body: sansRequestId(operatorId.body) }, "and so does an operator").toEqual({ status: foreign.status, body: sansRequestId(foreign.body) });
    expect(await factorState(ids.book2!), "untouched").toBe("active");
    expect(await resets(ids.book2!)).toHaveLength(0);
    // movement: the same member, reset by an admin of THEIR organization
    const own = await h.api("admina", "POST", `/auth/users/${ids.book2}/mfa-reset`);
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    expect(await factorState(ids.book2!)).toBe("none");
  });

  it("🔴 a member who is not an admin cannot reset anyone's factor (named)", async () => {
    const res = await h.api("plain", "POST", `/auth/users/${ids.book3}/mfa-reset`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "mfa_reset_admin_only", errorAr: expect.any(String) });
    expect(await factorState(ids.book3!)).toBe("active");
  });

  it("🔴 nothing to reset is refused by name: a reset record always means a factor was removed", async () => {
    const res = await h.api("admina", "POST", `/auth/users/${ids.plain}/mfa-reset`);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "mfa_not_set_up", errorAr: expect.any(String) });
    expect(await resets(ids.plain!)).toHaveLength(0);
    // the operator path too — on a sole admin with no factor (no admin could do it, so only "nothing to reset" refuses)
    const viaOperator = await h.api("op", "POST", "/operator/users/mfa-reset", { email: h.email("solof"), identityVerified: true, basis: "Video call with the member; ID matched." });
    expect(viaOperator.status).toBe(409);
    expect(viaOperator.body).toMatchObject({ code: "mfa_not_set_up" });
    expect(await resets(ids.solof!)).toHaveLength(0);
  });

  it("🔴 the OPERATOR is refused while an admin of the organization can reset — named, in both languages; nothing changes", async () => {
    await resetLimits();
    for (const who of ["book3", "admina2"]) {
      const res = await h.api("op", "POST", "/operator/users/mfa-reset", { email: h.email(who), identityVerified: true, basis: "Video call; national ID matched the verification file." });
      expect(res.status, `${who}: ${JSON.stringify(res.body)}`).toBe(409);
      expect(res.body).toMatchObject({ code: "mfa_reset_admin_available", error: expect.stringContaining("Users page"), errorAr: expect.stringContaining("صفحة المستخدمين") });
      expect(await factorState(ids[who]!), `${who}: untouched`).toBe("active");
      expect(await resets(ids[who]!), `${who}: not recorded`).toHaveLength(0);
    }
  });

  it("🔴 the operator may reset once NO admin can: a sole admin; an organization whose other admin is deactivated; one not yet verified", async () => {
    const reset = (who: string) => h.api("op", "POST", "/operator/users/mfa-reset", { email: h.email(who), identityVerified: true, basis: "Video call; national ID matched the verification file." });
    const solo = await reset("soloc");
    expect(solo.status, JSON.stringify(solo.body)).toBe(200);
    expect(await factorState(ids.soloc!)).toBe("none");
    expect((await resets(ids.soloc!)).find((r) => r.actor_user_id === ids.op)!.metadata).toMatchObject({ by: "platform_operator", identityVerified: true });
    // organization D: another admin exists and is usable — refused; deactivate that account — allowed (movement)
    expect((await reset("d1")).status).toBe(409);
    await pool.query(`UPDATE users SET is_active = false WHERE id = $1`, [ids.d2]);
    const d = await reset("d1");
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    // organization E is not yet verified: its admins cannot act on members, so the operator may
    const e = await reset("e1");
    expect(e.status, JSON.stringify(e.body)).toBe(200);
  });

  it("🔴 an account that also belongs to another organization is no single admin's to reset (confinement); then the operator may", async () => {
    for (const who of ["admina", "adminb"]) {
      const res = await h.api(who, "POST", `/auth/users/${ids.shared}/mfa-reset`);
      expect(res.status, `${who}: ${JSON.stringify(res.body)}`).toBe(409);
      expect(res.body).toMatchObject({ code: "mfa_reset_account_shared", errorAr: expect.any(String) });
    }
    expect(await factorState(ids.shared!)).toBe("active");
    const op = await h.api("op", "POST", "/operator/users/mfa-reset", { email: h.email("shared"), identityVerified: true, basis: "Video call; national ID matched the verification file." });
    expect(op.status, JSON.stringify(op.body)).toBe(200);
    expect(await factorState(ids.shared!)).toBe("none");
    const ev = await resets(ids.shared!);
    expect(ev.filter((r) => r.organization_id === orgs.a), "each organization's trail sees it").toHaveLength(1);
    expect(ev.filter((r) => r.organization_id === orgs.b)).toHaveLength(1);
  });
});
