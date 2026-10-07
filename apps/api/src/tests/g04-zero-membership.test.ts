/**
 * 🔴 ZERO-MEMBERSHIP ACCOUNTS (G04 batch, 2026-10-07) — no account is ever
 * "nobody's", and nobody can make an account theirs without its consent.
 *
 * THE DEFECT (reproduced on unmodified main): `POST /auth/register` created an
 * account with NO membership, to be assigned by a second call. In that window
 * the account was vacuously "confined" to every organization (an empty
 * footprint lies inside any set), so ANOTHER organization's admin could attach
 * it (`POST /orgs/:id/members`), reset its password and sign in as the person —
 * and the provisioning organization could no longer assign its own hire. G01
 * was the operator instance of the same root; PR #192 closed only that one.
 *
 * THE RULE THESE TESTS HOLD:
 *   1. an account is BORN with its first membership: `/auth/register` creates
 *      both in ONE transaction, in an organization the caller administers —
 *      proven by the server, never trusted from the body;
 *   2. `POST /orgs/:id/members` re-activates or re-roles an EXISTING member of
 *      that organization and never creates a membership. Anyone else — an
 *      unknown id, an operator, another organization's member, an account with
 *      no membership — gets ONE identical 422 `invitation_required`: the
 *      response does not say whether the account exists;
 *   3. an existing account joins another organization only by invitation →
 *      acceptance → membership, and acceptance is atomic too;
 *   4. confinement is no longer vacuous: an account with no membership is
 *      administrable by no tenant admin;
 *   5. platform operators keep zero memberships (G01) and are refused exactly
 *      like everyone else, with the attempt recorded.
 */
process.env.PORT ??= "3126";
process.env.SESSION_SECRET ??= "g04-zero-membership-secret-00000000000001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { __resetRateLimitsForTests } from "../routes/auth";
import { assertAccountConfinedTo } from "../lib/accountScope";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "G04ZeroPw1!";
const NEW_PW = "Initial-Pw-123!";
const STOLEN_PW = "Owned-By-B-123!";

describeMaybe("Zero-membership accounts — born with a membership, attached only by consent", () => {
  const h = g04Harness("g04z");
  const { api, email } = h;
  const org: Record<string, string> = {};
  const uid: Record<string, number> = {};

  const memberships = async (id: number) =>
    (await pool.query(`SELECT organization_id, role, status FROM organization_memberships WHERE user_id = $1 ORDER BY organization_id`, [id])).rows;
  const userIdOf = async (mail: string) => (await pool.query(`SELECT id FROM users WHERE email = $1`, [mail])).rows[0]?.id as number | undefined;
  const register = (who: string, key: string, organizationId: unknown, role = "bookkeeper") =>
    api(who, "POST", "/auth/register", { email: email(key), name: key, password: NEW_PW, role, organizationId });
  const attach = (who: string, orgId: string, userId: number, role = "admin") => api(who, "POST", `/orgs/${orgId}/members`, { userId, role });

  /** A test-only trigger that refuses a membership for marker emails — the failure injected BETWEEN the two writes. */
  const MARKER = "g04z-atomic-%";
  const installMembershipFault = async () => {
    await pool.query(`CREATE OR REPLACE FUNCTION g04z_refuse_marker_membership() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id AND email LIKE '${MARKER}') THEN
          RAISE EXCEPTION 'g04z atomicity probe: membership refused';
        END IF;
        RETURN NEW;
      END $$`);
    await pool.query(`DROP TRIGGER IF EXISTS g04z_refuse_marker_membership ON organization_memberships`);
    await pool.query(`CREATE TRIGGER g04z_refuse_marker_membership BEFORE INSERT ON organization_memberships FOR EACH ROW EXECUTE FUNCTION g04z_refuse_marker_membership()`);
  };
  const removeMembershipFault = async () => {
    await pool.query(`DROP TRIGGER IF EXISTS g04z_refuse_marker_membership ON organization_memberships`);
    await pool.query(`DROP FUNCTION IF EXISTS g04z_refuse_marker_membership()`);
  };

  beforeAll(async () => {
    await __resetRateLimitsForTests();
    await removeMembershipFault();
    await h.cleanup();
    org.a = await h.mkOrg("a");
    org.b = await h.mkOrg("b");
    org.pendingA = await h.mkOrg("pending-a", "pending_review");
    org.c = await h.mkOrg("c");
    for (const k of ["a", "b", "c"]) await pool.query(`INSERT INTO companies (organization_id, name, fiscal_year_start) VALUES ($1,$2,1)`, [org[k], `G04Z ${k} Co`]);
    // Admin A ADMINISTERS org A and the pending org, and is only a BOOKKEEPER of org C.
    uid.adminA = await h.mkUser("adminA", PW, org.a);
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [uid.adminA, org.pendingA]);
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'bookkeeper','active')`, [uid.adminA, org.c]);
    uid.adminB = await h.mkUser("adminB", PW, org.b);
    uid.memberA = await h.mkUser("memberA", PW, org.a, "bookkeeper");
    uid.inactiveA = await h.mkUser("inactiveA", PW, org.a, "viewer", "inactive");
    // The local database's one zero-membership account (a `scale-and-collision`
    // leftover) is LEFT UNTOUCHED (owner, 2026-10-07). This is a stand-in in
    // its exact state — a users row, no membership, no operator row — so the
    // proof runs on every database, CI's included.
    uid.orphan = await h.mkUser("orphan", PW, null);
    uid.op = await h.mkUser("op", PW, null);
    await pool.query(`INSERT INTO platform_operators (user_id) VALUES ($1)`, [uid.op]);
    await h.start();
    for (const k of ["adminA", "adminB"]) expect(await h.login(k, email(k), PW)).toBe(200);
  }, 120_000);

  afterAll(async () => {
    await removeMembershipFault();
    await h.stop();
    await h.cleanup();
  });

  // ── 1. registration ─────────────────────────────────────────────────────────
  it("🔴 REGISTER creates the account WITH its first membership, in the caller's organization", async () => {
    const r = await register("adminA", "hire1", org.a, "bookkeeper");
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(await memberships(r.body.id)).toEqual([{ organization_id: org.a, role: "bookkeeper", status: "active" }]);
  });

  it("🔴 REGISTER refuses an organization the caller does not administer — identical to an unknown one — and creates nothing", async () => {
    const notAdmin = await register("adminA", "nope-b", org.b);
    const bookkeeperOnly = await register("adminA", "nope-c", org.c);
    const unknown = await register("adminA", "nope-unknown", "00000000-0000-4000-8000-000000000000");
    const pending = await register("adminA", "nope-pending", org.pendingA);
    const malformed = await register("adminA", "nope-malformed", "not-a-uuid");
    expect(notAdmin.status, JSON.stringify(notAdmin.body)).toBe(403);
    for (const r of [bookkeeperOnly, unknown, pending, malformed]) expect(r, "identical to the not-administered refusal").toEqual(notAdmin);
    for (const k of ["nope-b", "nope-c", "nope-unknown", "nope-pending", "nope-malformed"]) expect(await userIdOf(email(k)), `${k}: no account`).toBeUndefined();
  });

  it("🔴 REGISTER refuses when the organization is not named (400) — the body alone never decides, and nothing is created", async () => {
    const r = await register("adminA", "nope-unnamed", undefined);
    expect(r.status).toBe(400);
    expect(await userIdOf(email("nope-unnamed"))).toBeUndefined();
  });

  it("🔴 REGISTER is ATOMIC: when the membership cannot be written, the account is not written either", async () => {
    await installMembershipFault();
    try {
      const r = await register("adminA", "atomic-reg", org.a);
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(await userIdOf(email("atomic-reg")), "no account without its membership").toBeUndefined();
    } finally {
      await removeMembershipFault();
    }
  });

  it("an unauthenticated caller cannot register at all", async () => {
    expect((await api("anon", "POST", "/auth/register", { email: email("anon"), name: "a", password: NEW_PW, role: "viewer", organizationId: org.a })).status).toBe(401);
    expect(await userIdOf(email("anon"))).toBeUndefined();
  });

  // ── 2. the takeover path, closed ────────────────────────────────────────────
  it("🔴 PATH 1 CLOSED: org B cannot attach org A's new hire, reset its password, or sign in as it", async () => {
    const created = await register("adminA", "newhire", org.a, "viewer");
    expect(created.status).toBe(201);
    const id = created.body.id as number;
    const a = await attach("adminB", org.b, id);
    expect(a.status, JSON.stringify(a.body)).toBe(422);
    expect(a.body.code).toBe("invitation_required");
    expect((await api("adminB", "POST", `/auth/users/${id}/reset-password`, { newPassword: STOLEN_PW })).status).toBe(404);
    expect(await h.login("victim", email("newhire"), STOLEN_PW)).toBe(401);
    expect(await h.login("victim", email("newhire"), NEW_PW)).toBe(200);
    expect(await memberships(id)).toEqual([{ organization_id: org.a, role: "viewer", status: "active" }]);
    // …and org A still administers its own hire.
    expect((await attach("adminA", org.a, id, "bookkeeper")).status).toBe(201);
  });

  it("🔴 CONCURRENT: org A provisions while org B hammers the next user ids — B never attaches one, every new account holds exactly A's membership", async () => {
    const maxId = Number((await pool.query(`SELECT coalesce(max(id),0)::int AS n FROM users`)).rows[0].n);
    const guesses = Array.from({ length: 20 }, (_, i) => maxId + 1 + i);
    const [created, attempts] = await Promise.all([
      Promise.all(Array.from({ length: 5 }, (_, i) => register("adminA", `race${i}`, org.a, "viewer"))),
      Promise.all(guesses.flatMap((g) => [attach("adminB", org.b, g), attach("adminB", org.b, g, "viewer")])),
    ]);
    expect(created.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
    expect(attempts.filter((r) => r.status >= 200 && r.status < 300).map((r) => r.status), "no attach succeeds").toEqual([]);
    for (const r of created) expect(await memberships(r.body.id)).toEqual([{ organization_id: org.a, role: "viewer", status: "active" }]);
    const inB = Number((await pool.query(`SELECT count(*)::int AS n FROM organization_memberships WHERE organization_id = $1 AND user_id > $2`, [org.b, maxId])).rows[0].n);
    expect(inB).toBe(0);
  });

  // ── 3. one refusal for every non-member ─────────────────────────────────────
  it("🔴 INDISTINGUISHABLE: an unknown id, an operator, another org's member and a no-membership account get the SAME status and body", async () => {
    const unknown = await attach("adminB", org.b, 2_000_000_000);
    const operator = await attach("adminB", org.b, uid.op);
    const foreignMember = await attach("adminB", org.b, uid.memberA);
    const noMembership = await attach("adminB", org.b, uid.orphan);
    expect(unknown.status).toBe(422);
    expect(unknown.body.code).toBe("invitation_required");
    expect(operator).toEqual(unknown);
    expect(foreignMember).toEqual(unknown);
    expect(noMembership).toEqual(unknown);
    for (const id of [uid.op, uid.memberA, uid.orphan]) {
      expect((await memberships(id)).filter((m) => m.organization_id === org.b), "no membership in B").toEqual([]);
    }
  });

  it("the operator-target attempt is still RECORDED in the security trail", async () => {
    const before = Number((await pool.query(`SELECT count(*)::int AS n FROM security_audit_logs WHERE action = 'account.operator_target_refused' AND target_user_id = $1`, [uid.op])).rows[0].n);
    await attach("adminB", org.b, uid.op, "viewer");
    const rows = (await pool.query(
      `SELECT actor_user_id, metadata FROM security_audit_logs WHERE action = 'account.operator_target_refused' AND target_user_id = $1 ORDER BY id DESC`, [uid.op])).rows;
    expect(rows.length).toBe(before + 1);
    expect(rows[0]).toMatchObject({ actor_user_id: uid.adminB, metadata: { attempted: "membership.assign" } });
  });

  it("🔴 the zero-membership account (the leftover's state): neither org may attach it or reset its password", async () => {
    for (const [who, o] of [["adminA", org.a], ["adminB", org.b]] as const) {
      const r = await attach(who, o, uid.orphan);
      expect(r.status).toBe(422);
      expect(r.body.code).toBe("invitation_required");
      expect((await api(who, "POST", `/auth/users/${uid.orphan}/reset-password`, { newPassword: STOLEN_PW })).status).toBe(404);
    }
    expect(await memberships(uid.orphan)).toEqual([]);
    expect(await h.login("orphan", email("orphan"), PW), "its own password still works").toBe(200);
  });

  it("🔴 CONFINEMENT is not vacuous: an account with no membership is administrable by NO tenant admin (service level)", async () => {
    await expect(assertAccountConfinedTo(uid.orphan, [org.a, org.b], "conceal")).rejects.toMatchObject({ statusCode: 404 });
    await expect(assertAccountConfinedTo(uid.orphan, [org.a, org.b], "explain")).rejects.toMatchObject({ statusCode: 404 });
    // CONTROL: a member confined to the actor's organization passes.
    await expect(assertAccountConfinedTo(uid.memberA, [org.a], "conceal")).resolves.toBeUndefined();
  });

  // ── 4. what an admin CAN still do (anti-vacuity) ────────────────────────────
  it("CONTROL: re-activating an existing INACTIVE member returns 201, and re-roling an existing member works", async () => {
    const r = await attach("adminA", org.a, uid.inactiveA, "bookkeeper");
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(await memberships(uid.inactiveA)).toEqual([{ organization_id: org.a, role: "bookkeeper", status: "active" }]);
  });

  it("CONTROL: a REMOVED member stays confined — removal keeps the row, and org B is refused identically", async () => {
    const removed = await api("adminA", "DELETE", `/orgs/${org.a}/members/${uid.memberA}`);
    expect(removed.status).toBe(200);
    expect(await memberships(uid.memberA)).toEqual([{ organization_id: org.a, role: "bookkeeper", status: "inactive" }]);
    const r = await attach("adminB", org.b, uid.memberA, "viewer");
    expect(r.body.code).toBe("invitation_required");
    // Org A re-activates its own member.
    expect((await attach("adminA", org.a, uid.memberA, "bookkeeper")).status).toBe(201);
  });

  // ── 5. the consented path ───────────────────────────────────────────────────
  it("REQUIRED PATH: invitation → acceptance → membership — for a new person and for an existing account", async () => {
    const fresh = await api("adminB", "POST", `/orgs/${org.b}/invitations`, { email: email("invitee"), role: "viewer" });
    expect(fresh.status, JSON.stringify(fresh.body)).toBe(201);
    const t1 = new URL(fresh.body.link).searchParams.get("token")!;
    const a1 = await api("anon2", "POST", `/invitations/${t1}/accept`, { name: "Invitee", password: NEW_PW });
    expect(a1.status, JSON.stringify(a1.body)).toBeLessThan(300);
    expect(await memberships((await userIdOf(email("invitee")))!)).toEqual([{ organization_id: org.b, role: "viewer", status: "active" }]);

    // An EXISTING account (org A's member) joins org B only by accepting, signed in as itself.
    const ex = await api("adminB", "POST", `/orgs/${org.b}/invitations`, { email: email("memberA"), role: "viewer" });
    expect(ex.status).toBe(201);
    const t2 = new URL(ex.body.link).searchParams.get("token")!;
    expect(await h.login("memberA", email("memberA"), PW)).toBe(200);
    const a2 = await api("memberA", "POST", `/invitations/${t2}/accept`, {});
    expect(a2.status, JSON.stringify(a2.body)).toBeLessThan(300);
    expect((await memberships(uid.memberA)).map((m) => m.organization_id).sort()).toEqual([org.a, org.b].sort());
  });

  it("🔴 ACCEPTANCE is ATOMIC: when the membership cannot be written, no account is created and the invitation stays pending", async () => {
    const sent = await api("adminB", "POST", `/orgs/${org.b}/invitations`, { email: email("atomic-inv"), role: "viewer" });
    expect(sent.status).toBe(201);
    const token = new URL(sent.body.link).searchParams.get("token")!;
    await installMembershipFault();
    try {
      const r = await api("anon3", "POST", `/invitations/${token}/accept`, { name: "Atomic", password: NEW_PW });
      expect(r.status).toBeGreaterThanOrEqual(400);
    } finally {
      await removeMembershipFault();
    }
    expect(await userIdOf(email("atomic-inv")), "no account without its membership").toBeUndefined();
    expect((await pool.query(`SELECT status FROM organization_invitations WHERE id = $1`, [sent.body.id])).rows[0].status).toBe("pending");
  });

  it("G01 holds: the operator still holds zero memberships", async () => {
    expect(await memberships(uid.op)).toEqual([]);
  });
});
