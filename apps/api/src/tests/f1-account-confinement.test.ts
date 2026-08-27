/**
 * F1 — cross-tenant account takeover via SELF-GRANTED membership. HIGH.
 *
 * THE VULNERABILITY. M11.5.1 confined the user-administration surface to users
 * who share an organization with the actor (`isMemberOfAny`). That predicate
 * reads as a tenant boundary and is not one, because the actor can CREATE the
 * sharing it tests: `POST /orgs/:orgId/members {userId, role}` inserted a
 * membership for ANY userId that existed — no consent, no invitation, no email
 * — and `users.id` is a `serial`, so the ids are counted rather than guessed.
 *
 * From a legitimate admin of any verification-approved organization:
 *   1. POST /api/orgs/<mine>/members {userId: N, role: "viewer"}
 *   2. POST /api/auth/users/N/reset-password {newPassword}   <- now "in scope"
 *   3. log in as N — every organization N belongs to, at N's role there.
 *
 * Step 1 is what the M11.5.1 fix trusted. This is CLAUDE.md §4's
 * self-grantable-privilege rule one layer down: the privilege was MEMBERSHIP,
 * and the guard that trusted it was the previous cross-tenant hotfix itself.
 *
 * WHAT THESE TESTS PIN — both halves of the fix, and both directions:
 *   A. step 1 is refused, so the scope cannot be forged;
 *   B. even when the membership is REAL (a consented M11.7 invitation makes
 *      genuinely multi-org accounts), the account act is refused — otherwise
 *      org B's admin could take over an account that also reaches org A;
 *   C. anti-vacuity — the confined cases still work. Without C, "it refused"
 *      could mean "it refuses everything", which is not a fix, it is an outage.
 *
 * DB-backed; skips on the DB-free placeholder.
 */

process.env.PORT ??= "3106";
process.env.SESSION_SECRET ??= "f1-confinement-test-session-secret-0123456789ab";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import bcrypt from "bcryptjs";
import { pool } from "@workspace/db";
import { __resetRateLimitsForTests } from "../routes/auth";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) {
  // eslint-disable-next-line no-console
  console.warn("[f1-confinement] no real DATABASE_URL — skipping.");
}

const PW = "F1TestPw123!";
const TAKEOVER_PW = "AttackerOwnsYou123!";
const ATTACKER_EMAIL = "f1test-attacker@test.local";
const VICTIM_EMAIL = "f1test-victim@test.local";
const COLLEAGUE_EMAIL = "f1test-colleague@test.local";
const UNPLACED_EMAIL = "f1test-unplaced@test.local";

describeMaybe("F1 — an org admin cannot take over an account that reaches another tenant", () => {
  let server: http.Server;
  let base = "";
  let attackerOrg = "";
  let victimOrg = "";
  let victimUserId = 0;
  let colleagueUserId = 0;
  let unplacedUserId = 0;

  const ORG_FILTER = `(SELECT id FROM organizations WHERE slug LIKE 'f1test%')`;
  const USER_FILTER = `(SELECT id FROM users WHERE email LIKE 'f1test-%')`;

  const cleanup = async () => {
    await pool.query(`DELETE FROM audit_logs WHERE organization_id IN ${ORG_FILTER}`);
    await pool.query(
      `DELETE FROM security_audit_logs WHERE organization_id IN ${ORG_FILTER} OR actor_user_id IN ${USER_FILTER} OR target_user_id IN ${USER_FILTER}`,
    );
    await pool.query(`DELETE FROM verification_reviews WHERE organization_id IN ${ORG_FILTER}`);
    await pool.query(`DELETE FROM organization_memberships WHERE user_id IN ${USER_FILTER}`);
    await pool.query(`DELETE FROM companies WHERE organization_id IN ${ORG_FILTER}`);
    await pool.query(`DELETE FROM organizations WHERE slug LIKE 'f1test%'`);
    await pool.query(`DELETE FROM users WHERE email LIKE 'f1test-%'`);
  };

  const jar: Record<string, string> = {};
  async function api(who: string | null, method: string, path: string, body?: unknown) {
    const cookie = who ? jar[who] ?? "" : "";
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sid = ((res.headers as any).getSetCookie?.() ?? []).find((c: string) =>
      c.startsWith("ksa_ledger_sid="),
    );
    if (sid && who) jar[who] = sid.split(";")[0];
    let json: any;
    try {
      json = await res.json();
    } catch {
      json = undefined;
    }
    return { status: res.status, body: json };
  }
  const login = (who: string, email: string, password = PW) =>
    api(who, "POST", "/auth/login", { email, password });

  const mkOrg = async (name: string, slug: string) =>
    (
      await pool.query(
        `INSERT INTO organizations (name, slug, verification_status) VALUES ($1,$2,'approved') RETURNING id`,
        [name, slug],
      )
    ).rows[0].id as string;

  const mkUser = async (email: string, name: string) => {
    const hash = await bcrypt.hash(PW, 12);
    return (
      await pool.query(
        `INSERT INTO users (email,name,password_hash,role,is_active) VALUES ($1,$2,$3,'viewer',true) RETURNING id`,
        [email, name, hash],
      )
    ).rows[0].id as number;
  };

  const mkMembership = (userId: number, orgId: string, role: string, status = "active") =>
    pool.query(
      `INSERT INTO organization_memberships (user_id,organization_id,role,status) VALUES ($1,$2,$3,$4)`,
      [userId, orgId, role, status],
    );

  const membershipCount = async (userId: number, orgId: string) =>
    Number(
      (
        await pool.query(
          `SELECT count(*)::int AS n FROM organization_memberships WHERE user_id = $1 AND organization_id = $2`,
          [userId, orgId],
        )
      ).rows[0].n,
    );

  beforeAll(async () => {
    await __resetRateLimitsForTests();
    await cleanup();

    // The ATTACKER is not an outsider — that is the point. They are an ordinary,
    // fully approved tenant admin, which is the least privilege this needs.
    attackerOrg = await mkOrg("F1Test Attacker Ltd", "f1test-attacker");
    victimOrg = await mkOrg("F1Test Victim Ltd", "f1test-victim");

    const attackerUserId = await mkUser(ATTACKER_EMAIL, "Attacker Admin");
    await mkMembership(attackerUserId, attackerOrg, "admin");

    // The victim belongs ONLY to the victim org. Nothing connects them to the
    // attacker; the attacker knows their user id only by counting.
    victimUserId = await mkUser(VICTIM_EMAIL, "Victim Bookkeeper");
    await mkMembership(victimUserId, victimOrg, "bookkeeper");

    // A genuine colleague of the attacker — confined to the attacker's org.
    colleagueUserId = await mkUser(COLLEAGUE_EMAIL, "Real Colleague");
    await mkMembership(colleagueUserId, attackerOrg, "bookkeeper");

    // An account with NO memberships at all (M10.6's provisioning case).
    unplacedUserId = await mkUser(UNPLACED_EMAIL, "Unplaced Account");

    const app = (await import("../app")).default;
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/api`;

    expect((await login("attacker", ATTACKER_EMAIL)).status).toBe(200);
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await cleanup();
  });

  // ── A. The forged scope: step 1 of the chain ──────────────────────────────
  describe("A — the membership that made the scope forgeable", () => {
    it("HIGH: CANNOT graft a foreign account into their own org (404, concealed)", async () => {
      const r = await api("attacker", "POST", `/orgs/${attackerOrg}/members`, {
        userId: victimUserId,
        role: "viewer",
      });
      // 404 and not 409/403: a distinct answer would confirm the id belongs to
      // someone, which is the enumeration oracle M11.5.1 removed.
      expect(r.status).toBe(404);
      expect(await membershipCount(victimUserId, attackerOrg)).toBe(0);
    });

    it("a nonexistent id is answered IDENTICALLY (no existence oracle)", async () => {
      const r = await api("attacker", "POST", `/orgs/${attackerOrg}/members`, {
        userId: 2_000_000_000,
        role: "viewer",
      });
      expect(r.status).toBe(404);
      expect(r.body?.error).toBe("User not found.");
    });

    it("step 2 is therefore out of reach: reset-password on the victim is 404", async () => {
      const r = await api("attacker", "POST", `/auth/users/${victimUserId}/reset-password`, {
        newPassword: TAKEOVER_PW,
      });
      expect(r.status).toBe(404);
    });

    it("the victim's account is UNTOUCHED — the takeover password does not work", async () => {
      expect(
        (await api("v1", "POST", "/auth/login", { email: VICTIM_EMAIL, password: TAKEOVER_PW })).status,
      ).toBe(401);
      expect((await login("victim", VICTIM_EMAIL)).status).toBe(200);
    });
  });

  // ── B. A REAL shared membership — the consented path still must not grant
  //      authority over the account itself. ─────────────────────────────────
  describe("B — a genuinely multi-org account is not administrable from one org", () => {
    beforeAll(async () => {
      // What accepting an M11.7 invitation to the attacker's org produces: a
      // real, consented membership. The victim still reaches their own org.
      await mkMembership(victimUserId, attackerOrg, "bookkeeper");
      expect(await membershipCount(victimUserId, attackerOrg)).toBe(1);
    });

    it("the account IS now in scope — it appears in the attacker's user list", async () => {
      const r = await api("attacker", "GET", "/auth/users");
      expect(r.status).toBe(200);
      expect((r.body as Array<{ email: string }>).map((u) => u.email)).toContain(VICTIM_EMAIL);
    });

    it("HIGH: reset-password is REFUSED anyway (409), because the account reaches another tenant", async () => {
      const r = await api("attacker", "POST", `/auth/users/${victimUserId}/reset-password`, {
        newPassword: TAKEOVER_PW,
      });
      expect(r.status).toBe(409);
      // Explains, and points at the act that IS theirs to take...
      expect(r.body?.error).toMatch(/remove their membership/i);
      // ...without naming the other organization.
      expect(r.body?.error).not.toMatch(/F1Test Victim/i);
    });

    it("the password really did not change", async () => {
      expect(
        (await api("v2", "POST", "/auth/login", { email: VICTIM_EMAIL, password: TAKEOVER_PW })).status,
      ).toBe(401);
      expect((await login("victim", VICTIM_EMAIL)).status).toBe(200);
    });

    it("deactivating the account is refused too (409) — it would lock them out of the other tenant", async () => {
      const r = await api("attacker", "PATCH", `/auth/users/${victimUserId}`, { isActive: false });
      expect(r.status).toBe(409);
      const row = await pool.query(`SELECT is_active FROM users WHERE id = $1`, [victimUserId]);
      expect(row.rows[0].is_active).toBe(true);
    });

    it("the act the refusal NAMES does work: remove the membership from their own org", async () => {
      const r = await api("attacker", "DELETE", `/orgs/${attackerOrg}/members/${victimUserId}`);
      expect(r.status).toBe(200);
      const row = await pool.query(
        `SELECT status FROM organization_memberships WHERE user_id = $1 AND organization_id = $2`,
        [victimUserId, attackerOrg],
      );
      expect(row.rows[0].status).toBe("inactive");
    });

    it("and an INACTIVE foreign membership still blocks the account act", async () => {
      // The row above is now inactive in the attacker's org, while the victim's
      // own org membership is untouched — so the victim is still foreign.
      // Re-activation is the other org's decision to make about an account
      // whose password would by then be known.
      const r = await api("attacker", "POST", `/auth/users/${victimUserId}/reset-password`, {
        newPassword: TAKEOVER_PW,
      });
      expect([404, 409]).toContain(r.status);
      expect((await login("victim", VICTIM_EMAIL)).status).toBe(200);
    });
  });

  // ── C. Anti-vacuity: the confined cases still work. ───────────────────────
  describe("C — anti-vacuity: this is a boundary, not an outage", () => {
    it("CAN assign an account with no memberships (M10.6's provisioning case)", async () => {
      const r = await api("attacker", "POST", `/orgs/${attackerOrg}/members`, {
        userId: unplacedUserId,
        role: "bookkeeper",
      });
      expect(r.status).toBe(201);
      expect(await membershipCount(unplacedUserId, attackerOrg)).toBe(1);
    });

    it("CAN reset the password of a colleague confined to their own org", async () => {
      const fresh = "ConfinedFreshPw123!";
      const r = await api("attacker", "POST", `/auth/users/${colleagueUserId}/reset-password`, {
        newPassword: fresh,
      });
      expect(r.status).toBe(200);
      // The reset genuinely took effect — otherwise a 200 proves nothing.
      expect(
        (await api("c1", "POST", "/auth/login", { email: COLLEAGUE_EMAIL, password: PW })).status,
      ).toBe(401);
      expect(
        (await api("c2", "POST", "/auth/login", { email: COLLEAGUE_EMAIL, password: fresh })).status,
      ).toBe(200);
    });

    it("CAN change a confined colleague's role", async () => {
      const r = await api("attacker", "PATCH", `/auth/users/${colleagueUserId}`, { role: "accountant" });
      expect(r.status).toBe(200);
      expect(r.body.role).toBe("accountant");
    });
  });
});
