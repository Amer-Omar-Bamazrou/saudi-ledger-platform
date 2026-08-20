/**
 * Invitations (M11.7) — lifecycle + the SECURITY invariants of a public,
 * token-authenticated endpoint that can create a user AND grant a membership.
 *
 * That is the same shape as the M11.5.1 CRITICAL (a self-grantable capability),
 * so each invariant from the threat model is asserted here, not assumed:
 *   1. accepting NEVER grants a privileged GLOBAL role (only a membership);
 *   2. no role escalation — the offered role is validated, fail closed;
 *   3. an org must be APPROVED to invite AND to be joined (blocks an unvetted
 *      org minting accounts / email-squatting, and blocks joining a rejected org);
 *   4. a token cannot be redeemed twice (atomic claim), nor after
 *      revoke/expiry;
 *   5. a signed-in acceptor must BE the invited email;
 *   6. only the token HASH is stored — the raw token never touches the DB.
 *
 * DB-backed; skips on the DB-free placeholder.
 */

process.env.PORT ??= "3105";
process.env.SESSION_SECRET ??= "invitations-test-session-secret-0123456789abcdef";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import bcrypt from "bcryptjs";
import { pool } from "@workspace/db";
import { hashToken } from "../lib/tokens";
import { __resetRateLimitsForTests } from "../routes/auth";
import { invitationsService } from "../services/invitations.service";
import { membersService } from "../services/members.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) {
  // eslint-disable-next-line no-console
  console.warn("[invitations] no real DATABASE_URL — skipping.");
}

const PW = "InvitePw123!";
const ADMIN = "invtest-admin@test.local";
const OUTSIDER = "invtest-outsider@test.local";
const NEWBIE = "invtest-newbie@test.local";
const EXISTING = "invtest-existing@test.local";

describeMaybe("M11.7 — organization invitations", () => {
  let server: http.Server;
  let base = "";
  let approvedOrg = "";
  let pendingOrg = "";
  let adminId = 0;
  let outsiderId = 0;
  let existingId = 0;

  const ORG_FILTER = `(SELECT id FROM organizations WHERE slug LIKE 'invtest-%')`;
  const USER_FILTER = `(SELECT id FROM users WHERE email LIKE 'invtest-%')`;

  const cleanup = async () => {
    await pool.query(`DELETE FROM security_audit_logs WHERE organization_id IN ${ORG_FILTER} OR actor_user_id IN ${USER_FILTER} OR target_user_id IN ${USER_FILTER}`);
    await pool.query(`DELETE FROM organization_invitations WHERE organization_id IN ${ORG_FILTER}`);
    await pool.query(`DELETE FROM organization_memberships WHERE user_id IN ${USER_FILTER}`);
    await pool.query(`DELETE FROM companies WHERE organization_id IN ${ORG_FILTER}`);
    await pool.query(`DELETE FROM users WHERE email LIKE 'invtest-%'`);
    await pool.query(`DELETE FROM organizations WHERE slug LIKE 'invtest-%'`);
  };

  const mkUser = async (email: string) =>
    (await pool.query(
      `INSERT INTO users (email,name,password_hash,role,is_active) VALUES ($1,$1,$2,'viewer',true) RETURNING id`,
      [email, await bcrypt.hash(PW, 12)],
    )).rows[0].id as number;

  const jar: Record<string, string> = {};
  async function api(who: string | null, method: string, path: string, body?: unknown) {
    const cookie = who ? jar[who] ?? "" : "";
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sid = ((res.headers as any).getSetCookie?.() ?? []).find((c: string) => c.startsWith("ksa_ledger_sid="));
    if (sid && who) jar[who] = sid.split(";")[0];
    let json: any; try { json = await res.json(); } catch { json = undefined; }
    return { status: res.status, body: json };
  }
  const tokenFromLink = (link: string) => new URL(link).searchParams.get("token")!;

  beforeAll(async () => {
    // C1: the rate-limit store is now SHARED (Postgres), so a suite that
    // logs in repeatedly consumes the SAME budget as every parallel suite —
    // the per-fork privacy MemoryStore accidentally provided is gone.
    await __resetRateLimitsForTests();
    await cleanup();
    approvedOrg = (await pool.query(
      `INSERT INTO organizations (name, slug, verification_status) VALUES ('InvTest Approved','invtest-approved','approved') RETURNING id`,
    )).rows[0].id;
    pendingOrg = (await pool.query(
      `INSERT INTO organizations (name, slug, verification_status) VALUES ('InvTest Pending','invtest-pending','pending_review') RETURNING id`,
    )).rows[0].id;

    adminId = await mkUser(ADMIN);
    outsiderId = await mkUser(OUTSIDER);
    existingId = await mkUser(EXISTING);
    // Same admin administers BOTH orgs — so the approved-org check is the only
    // thing that can distinguish them.
    for (const org of [approvedOrg, pendingOrg]) {
      await pool.query(`INSERT INTO organization_memberships (user_id,organization_id,role,status) VALUES ($1,$2,'admin','active')`, [adminId, org]);
    }

    const app = (await import("../app")).default;
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/api`;
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await cleanup();
  });

  describe("sending invitations (authorization)", () => {
    it("an org admin of an APPROVED org can invite; only the token HASH is stored", async () => {
      const out = await invitationsService.send(adminId, approvedOrg, NEWBIE, "bookkeeper");
      expect(out).toMatchObject({ email: NEWBIE, role: "bookkeeper", status: "pending" });
      expect(out.link).toContain("token=");
      expect(out.emailDelivered).toBe(false); // no provider configured — link is returned

      const raw = tokenFromLink(out.link);
      const row = (await pool.query(
        `SELECT token_hash FROM organization_invitations WHERE id = $1`, [out.id],
      )).rows[0];
      // INVARIANT 6: the raw token is nowhere in the DB; only its SHA-256 is.
      expect(row.token_hash).toBe(hashToken(raw));
      expect(row.token_hash).not.toBe(raw);
    });

    it("INVARIANT 3: a PENDING (unverified) org cannot invite anyone", async () => {
      await expect(invitationsService.send(adminId, pendingOrg, "invtest-x@test.local", "viewer"))
        .rejects.toMatchObject({ statusCode: 403 });
    });

    it("a non-admin of the org cannot invite (403)", async () => {
      await expect(invitationsService.send(outsiderId, approvedOrg, "invtest-y@test.local", "viewer"))
        .rejects.toMatchObject({ statusCode: 403 });
    });

    it("INVARIANT 2: an invalid/escalated role is rejected (400)", async () => {
      for (const role of ["superuser", "operator", "", null]) {
        await expect(invitationsService.send(adminId, approvedOrg, "invtest-z@test.local", role))
          .rejects.toMatchObject({ statusCode: 400 });
      }
    });

    it("rejects a malformed email and duplicate pending invites", async () => {
      await expect(invitationsService.send(adminId, approvedOrg, "not-an-email", "viewer"))
        .rejects.toMatchObject({ statusCode: 400 });
      await expect(invitationsService.send(adminId, approvedOrg, NEWBIE, "viewer"))
        .rejects.toMatchObject({ statusCode: 409 });
    });
  });

  describe("accepting — new account path", () => {
    let link = "";

    it("previews the invite publicly without a session", async () => {
      const { invitations } = await invitationsService.list(adminId, approvedOrg);
      const pending = invitations.find((i) => i.email === NEWBIE)!;
      expect(pending.status).toBe("pending");

      // Re-issue so we hold a known raw token for the HTTP flow.
      const resent = await invitationsService.resend(adminId, approvedOrg, pending.id);
      link = resent.link;

      const preview = await api(null, "GET", `/invitations/${tokenFromLink(link)}`);
      expect(preview.status).toBe(200);
      expect(preview.body).toMatchObject({
        organizationName: "InvTest Approved", email: NEWBIE, role: "bookkeeper", hasAccount: false,
      });
    });

    it("creates the user + membership atomically and signs them in", async () => {
      const accepted = await api("newbie", "POST", `/invitations/${tokenFromLink(link)}/accept`, {
        name: "New Bee", password: PW,
      });
      expect(accepted.status).toBe(200);
      expect(accepted.body.role).toBe("bookkeeper");

      const membership = (await pool.query(
        `SELECT m.role, m.status FROM organization_memberships m JOIN users u ON u.id=m.user_id
          WHERE u.email = $1 AND m.organization_id = $2`, [NEWBIE, approvedOrg],
      )).rows[0];
      expect(membership).toMatchObject({ role: "bookkeeper", status: "active" });

      // The session works.
      expect((await api("newbie", "GET", "/auth/me")).status).toBe(200);
    });

    it("INVARIANT 1: the accepted user has a NON-privileged global role", async () => {
      const user = (await pool.query(`SELECT role FROM users WHERE email = $1`, [NEWBIE])).rows[0];
      expect(user.role).not.toBe("admin");
      expect(user.role).toBe("viewer");

      // ...and therefore cannot reach the user-administration surface.
      expect((await api("newbie", "GET", "/auth/users")).status).toBe(403);
    });

    it("INVARIANT 4: the same token cannot be redeemed twice", async () => {
      const again = await api(null, "POST", `/invitations/${tokenFromLink(link)}/accept`, {
        name: "Impostor", password: PW,
      });
      expect(again.status).toBe(409);

      const count = (await pool.query(
        `SELECT count(*)::int c FROM organization_memberships m JOIN users u ON u.id=m.user_id
          WHERE u.email = $1 AND m.organization_id = $2`, [NEWBIE, approvedOrg],
      )).rows[0].c;
      expect(count).toBe(1); // exactly one membership, no duplicate
    });

    it("audits the whole lifecycle", async () => {
      const actions = (await pool.query(
        `SELECT action FROM security_audit_logs WHERE organization_id = $1`, [approvedOrg],
      )).rows.map((r) => r.action);
      expect(actions).toContain("invite.sent");
      expect(actions).toContain("invite.resent");
      expect(actions).toContain("invite.accepted");
    });
  });

  describe("accepting — existing account path", () => {
    let link = "";

    beforeAll(async () => {
      const out = await invitationsService.send(adminId, approvedOrg, EXISTING, "accountant");
      link = out.link;
    });

    it("refuses anonymous acceptance when an account already exists (must sign in)", async () => {
      const r = await api(null, "POST", `/invitations/${tokenFromLink(link)}/accept`, {});
      expect(r.status).toBe(409);
    });

    it("INVARIANT 5: a signed-in user with a DIFFERENT email cannot redeem it", async () => {
      expect((await api("outsider", "POST", "/auth/login", { email: OUTSIDER, password: PW })).status).toBe(200);
      const r = await api("outsider", "POST", `/invitations/${tokenFromLink(link)}/accept`, {});
      expect(r.status).toBe(403);

      const count = (await pool.query(
        `SELECT count(*)::int c FROM organization_memberships WHERE user_id = $1 AND organization_id = $2`,
        [outsiderId, approvedOrg],
      )).rows[0].c;
      expect(count).toBe(0);
    });

    it("the invited user, signed in, joins successfully", async () => {
      expect((await api("existing", "POST", "/auth/login", { email: EXISTING, password: PW })).status).toBe(200);
      const r = await api("existing", "POST", `/invitations/${tokenFromLink(link)}/accept`, {});
      expect(r.status).toBe(200);
      expect(r.body.role).toBe("accountant");

      const membership = (await pool.query(
        `SELECT role FROM organization_memberships WHERE user_id = $1 AND organization_id = $2`,
        [existingId, approvedOrg],
      )).rows[0];
      expect(membership.role).toBe("accountant");
    });

    it("re-inviting an existing member is refused (409)", async () => {
      await expect(invitationsService.send(adminId, approvedOrg, EXISTING, "viewer"))
        .rejects.toMatchObject({ statusCode: 409 });
    });
  });

  describe("revoke / expiry", () => {
    it("a revoked invitation cannot be accepted", async () => {
      const out = await invitationsService.send(adminId, approvedOrg, "invtest-revoked@test.local", "viewer");
      await invitationsService.revoke(adminId, approvedOrg, out.id);

      const r = await api(null, "POST", `/invitations/${tokenFromLink(out.link)}/accept`, {
        name: "Nope", password: PW,
      });
      expect(r.status).toBe(409);
      expect((await pool.query(`SELECT count(*)::int c FROM users WHERE email='invtest-revoked@test.local'`)).rows[0].c).toBe(0);
    });

    it("an expired invitation cannot be accepted", async () => {
      const out = await invitationsService.send(adminId, approvedOrg, "invtest-expired@test.local", "viewer");
      await pool.query(`UPDATE organization_invitations SET expires_at = now() - interval '1 day' WHERE id = $1`, [out.id]);

      const r = await api(null, "POST", `/invitations/${tokenFromLink(out.link)}/accept`, {
        name: "Late", password: PW,
      });
      expect(r.status).toBe(409);
    });

    it("an unknown token is a 404 that does not distinguish guesses", async () => {
      const r = await api(null, "GET", `/invitations/definitely-not-a-real-token`);
      expect(r.status).toBe(404);
    });

    it("INVARIANT 3 (accept side): an org de-approved after sending cannot be joined", async () => {
      const out = await invitationsService.send(adminId, approvedOrg, "invtest-dequal@test.local", "viewer");
      await pool.query(`UPDATE organizations SET verification_status='rejected' WHERE id=$1`, [approvedOrg]);
      try {
        const r = await api(null, "POST", `/invitations/${tokenFromLink(out.link)}/accept`, {
          name: "Blocked", password: PW,
        });
        expect(r.status).toBe(403);
      } finally {
        await pool.query(`UPDATE organizations SET verification_status='approved' WHERE id=$1`, [approvedOrg]);
      }
    });
  });

  describe("member removal", () => {
    it("removes a member (deactivates) and audits it", async () => {
      const out = await membersService.remove(adminId, approvedOrg, existingId);
      expect(out.status).toBe("inactive");

      const actions = (await pool.query(
        `SELECT action FROM security_audit_logs WHERE organization_id = $1 AND target_user_id = $2`,
        [approvedOrg, existingId],
      )).rows.map((r) => r.action);
      expect(actions).toContain("membership.removed");
    });

    it("refuses to remove the LAST admin (409)", async () => {
      await expect(membersService.remove(adminId, approvedOrg, adminId))
        .rejects.toMatchObject({ statusCode: 409 });
    });
  });
});
