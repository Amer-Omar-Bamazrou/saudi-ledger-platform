/**
 * 🔴 Phase 18 H-16 — DR-27 (D-10), its tenant-visible audit: a password reset
 * — an admin's, or an operator's break-glass — is visible to the admins of
 * the organizations the reset account belongs to, the operator REDACTED on the
 * tenant copy (G28, G51). DECIDED 2026-10-27 — owner accepted the stated
 * recommendation (register §11.67, the scoped D-4 statement, appended before
 * this file).
 *
 * Read through `GET /orgs/:orgId/security-events`, as each organization's
 * admin reads it. DB-backed (sl_test / CI); skips on the DB-free placeholder.
 */
process.env.PORT ??= "3266";
process.env.SESSION_SECRET ??= "phase18-h16-tenant-visible-reset1";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { operatorService } from "../services/operator.service";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "Phase18H16ResetPw1!";
const OPERATOR_IP = "203.0.113.16";
type Ev = { action: string; actorUserId: number | null; actorEmail: string | null; targetUserId: number | null; ipAddress: string | null; metadata: Record<string, unknown> | null };

describeMaybe("Phase 18 H-16 — password resets are visible to the reset account's organizations, the operator redacted", () => {
  const h = g04Harness("p18h16rst");
  let orgA = "", orgB = "", orgC = "", adminA = 0, targetId = 0, resetee = 0, operatorId = 0;
  const events = async (who: string, orgId: string, action: string, target = targetId) => {
    const r = await h.api(who, "GET", `/orgs/${orgId}/security-events`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return { all: r.body.events as Ev[], raw: JSON.stringify(r.body), mine: (r.body.events as Ev[]).filter((e) => e.action === action && e.targetUserId === target) };
  };

  beforeAll(async () => {
    await h.cleanup();
    orgA = await h.mkOrg("a"); orgB = await h.mkOrg("b"); orgC = await h.mkOrg("c");
    adminA = await h.mkUser("adminA", PW, orgA, "admin");
    // adminA also administers org C, which the reset account does NOT belong to (fixture)
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [adminA, orgC]);
    await h.mkUser("adminB", PW, orgB, "admin");
    targetId = await h.mkUser("target", PW, orgA, "bookkeeper");
    // an admin may reset only an account confined to organizations the admin administers (F1): org A alone
    resetee = await h.mkUser("resetee", PW, orgA, "bookkeeper");
    // the same account is also an active member of org B, which adminA does NOT administer (fixture)
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'viewer','active')`, [targetId, orgB]);
    operatorId = await h.mkUser("operator", PW, null, "admin");
    await pool.query(`INSERT INTO platform_operators (user_id, granted_by) VALUES ($1, $1)`, [operatorId]);
    await h.start();
    for (const who of ["adminA", "adminB"]) expect(await h.login(who, h.email(who), PW), `login ${who}`).toBe(200);
  }, 120_000);

  afterAll(async () => { await h.stop(); await h.cleanup(); });

  it("🔴 an ADMIN's reset is visible to that admin's organization — and only there (not to org B, which the admin does not administer)", async () => {
    const reset = await h.api("adminA", "POST", `/auth/users/${resetee}/reset-password`, { newPassword: "Phase18H16AdminSet1!" });
    expect(reset.status, JSON.stringify(reset.body)).toBe(200);
    const a = await events("adminA", orgA, "user.password_reset", resetee);
    expect(a.mine.map((e) => e.actorUserId)).toEqual([adminA]);
    expect((await events("adminB", orgB, "user.password_reset", resetee)).mine).toEqual([]);
    // Added after the red runs (its red is the surviving mutant M4): not in another organization the admin administers
    expect((await events("adminA", orgC, "user.password_reset", resetee)).mine, "org C: the account is not a member").toEqual([]);
  });

  it("🔴 a BREAK-GLASS reset is visible to EVERY organization the account belongs to — with the operator redacted on the tenant copy", async () => {
    await operatorService.resetUserPassword(operatorId, h.email("target"), { actorEmail: h.email("operator"), ipAddress: OPERATOR_IP });
    for (const [who, orgId] of [["adminA", orgA], ["adminB", orgB]] as const) {
      const v = await events(who, orgId, "user.password_breakglass_reset");
      expect(v.mine.map((e) => [e.actorUserId, e.actorEmail, e.ipAddress, e.metadata?.by]), `${who}'s copy`).toEqual([[null, null, null, "platform_operator"]]);
      expect(v.raw.includes(h.email("operator")) || v.raw.includes(OPERATOR_IP), `${who} reads nothing that identifies the operator`).toBe(false);
    }
  });

  it("the operator-identified row stays, with no organization, for the operator surface", async () => {
    const rows = (await pool.query(
      `SELECT actor_user_id, ip_address FROM security_audit_logs WHERE action = 'user.password_breakglass_reset' AND target_user_id = $1 AND organization_id IS NULL`, [targetId])).rows;
    expect(rows.map((r) => [r.actor_user_id, r.ip_address])).toEqual([[operatorId, OPERATOR_IP]]);
  });

  it("🔴 the operator is told the account holder will be asked to choose their own password at sign-in (H-15)", async () => {
    const out = await operatorService.resetUserPassword(operatorId, h.email("target"), { actorEmail: h.email("operator"), ipAddress: OPERATOR_IP });
    expect(out.guidance).toMatch(/asked to choose their own password/i);
  });
});
