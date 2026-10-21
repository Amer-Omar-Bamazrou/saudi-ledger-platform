/**
 * 🔴 G03 — REGRESSION (owner decision D-4, 2026-10-20): the last USABLE admin
 * cannot be demoted or deactivated on any path; 409.
 *
 * The guard covered `membersService.update` only, as a count taken before the
 * write: `assign` (the UI's role-change path) and account deactivation
 * (`PATCH /auth/users/:id`) were unguarded, the count was of admin MEMBERSHIPS
 * (an admin whose account is inactive still counted), and two acts each allowed
 * alone could pass the same count together. Since G03 every such path goes
 * through `membersRepository.withLastAdminGuard`, which counts usable admins —
 * an active admin membership AND an active account — under a lock, before and
 * after the write (the 4B proof `phase18-s1b-g03-last-admin.test.ts` lands
 * unchanged beside this file).
 *
 * Asserted with presence and absence: each refusal leaves the organisation as
 * it was, and each allowed act (another admin remains) still goes through.
 * The two races are FORCED: a holder locks what the old and the new code both
 * wait on before writing, both acts are seen waiting, then the holder commits.
 *
 * DB-backed (sl_test / CI); skips on the DB-free placeholder.
 */
process.env.PORT ??= "3207";
process.env.SESSION_SECRET ??= "g03-last-admin-guard-regression-000001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness, type Res } from "./helpers/g04Harness";
import { lockWaiters, until } from "./helpers/g08rRace";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "G03RegressionPw123!";
const REFUSAL = "Cannot remove the last admin of the organization.";

describeMaybe("G03 — the last usable admin cannot be removed on any path", () => {
  const h = g04Harness("g03reg");
  const ids: Record<string, number> = {};
  const orgs: Record<string, string> = {};

  /** Admins of `orgId` who can sign in: an active admin membership AND an active account. */
  const usableAdmins = async (orgId: string) => Number((await pool.query(
    `SELECT count(*)::int AS n FROM organization_memberships m JOIN users u ON u.id = m.user_id
      WHERE m.organization_id = $1 AND m.role = 'admin' AND m.status = 'active' AND u.is_active`, [orgId],
  )).rows[0].n);
  const state = async (orgId: string) => (await pool.query(
    `SELECT m.user_id, m.role, m.status, u.is_active FROM organization_memberships m JOIN users u ON u.id = m.user_id
      WHERE m.organization_id = $1 ORDER BY m.user_id`, [orgId],
  )).rows;

  /** A race's two results, order-free: one act applied (2xx), the other refused (409). */
  const outcome = (rs: Res[]) => rs.map((r) => (r.status === 409 ? "refused" : r.status < 300 ? "applied" : String(r.status))).sort();

  /** Hold the admin memberships of `orgId` (and, optionally, accounts) while `acts` queue behind them; then release. */
  async function raced(orgId: string, userIds: number[], acts: Array<() => Promise<Res>>): Promise<Res[]> {
    const holder = await pool.connect();
    let open = false;
    try {
      await holder.query("BEGIN");
      open = true;
      const pid = Number((await holder.query(`SELECT pg_backend_pid() AS pid`)).rows[0].pid);
      await holder.query(`SELECT id FROM organization_memberships WHERE organization_id = $1 AND role = 'admin' ORDER BY id FOR UPDATE`, [orgId]);
      if (userIds.length) await holder.query(`SELECT id FROM users WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE`, [userIds]);
      const sent: Promise<Res>[] = [];
      for (const act of acts) {
        sent.push(act());
        const k = sent.length;
        await until(`act ${k} did not queue on a lock`, async () => (await lockWaiters(pid)) >= k);
      }
      await holder.query("COMMIT");
      open = false;
      return await Promise.all(sent);
    } finally {
      if (open) await holder.query("ROLLBACK");
      holder.release();
    }
  }

  beforeAll(async () => {
    await h.cleanup();
    for (const key of ["solo", "pair", "dormant", "self", "acct", "race", "mixed"]) {
      orgs[key] = await h.mkOrg(key);
      await h.mkCompany(orgs[key]!, `G03 ${key}`, `31818181818${String(Object.keys(orgs).length).padStart(2, "0")}03`);
    }
    ids.solo = await h.mkUser("solo", PW, orgs.solo!, "admin");
    ids.solobk = await h.mkUser("solobk", PW, orgs.solo!, "bookkeeper");
    ids.pair1 = await h.mkUser("pair1", PW, orgs.pair!, "admin");
    ids.pair2 = await h.mkUser("pair2", PW, orgs.pair!, "admin");
    ids.dormant1 = await h.mkUser("dormant1", PW, orgs.dormant!, "admin");
    ids.dormant2 = await h.mkUser("dormant2", PW, orgs.dormant!, "admin");
    ids.self1 = await h.mkUser("self1", PW, orgs.self!, "admin");
    ids.acct1 = await h.mkUser("acct1", PW, orgs.acct!, "admin");
    ids.acct2 = await h.mkUser("acct2", PW, orgs.acct!, "admin");
    ids.race1 = await h.mkUser("race1", PW, orgs.race!, "admin");
    ids.race2 = await h.mkUser("race2", PW, orgs.race!, "admin");
    ids.mixed1 = await h.mkUser("mixed1", PW, orgs.mixed!, "admin");
    ids.mixed2 = await h.mkUser("mixed2", PW, orgs.mixed!, "admin");
    await h.start();
    for (const who of ["solo", "pair1", "dormant1", "self1", "acct1", "race1", "race2", "mixed1", "mixed2"]) {
      expect(await h.login(who, h.email(who), PW), `login ${who}`).toBe(200);
    }
    // dormant2 holds an ACTIVE admin membership on an INACTIVE account: an admin who cannot sign in.
    await pool.query(`UPDATE users SET is_active = false WHERE id = $1`, [ids.dormant2]);
  }, 120_000);
  afterAll(async () => { await h.stop(); await h.cleanup(); });

  it("assign: the last admin re-assigning themselves a lesser role is refused (409, the guard's message) and nothing changes; a bookkeeper's role still changes (control)", async () => {
    const before = await state(orgs.solo!);
    const r = await h.api("solo", "POST", `/orgs/${orgs.solo}/members`, { userId: ids.solo, role: "bookkeeper" });
    expect([r.status, r.body?.error]).toEqual([409, REFUSAL]);
    expect(await state(orgs.solo!)).toEqual(before);
    const ok = await h.api("solo", "POST", `/orgs/${orgs.solo}/members`, { userId: ids.solobk, role: "accountant" });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect((await state(orgs.solo!)).find((m) => m.user_id === ids.solobk)?.role).toBe("accountant");
  });

  it("assign by a SECOND admin: demoting the other admin goes through while one remains (201, usable 2 → 1); the remaining admin cannot then demote themselves (409)", async () => {
    expect(await usableAdmins(orgs.pair!)).toBe(2);
    const first = await h.api("pair1", "POST", `/orgs/${orgs.pair}/members`, { userId: ids.pair2, role: "bookkeeper" });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(await usableAdmins(orgs.pair!)).toBe(1);
    const last = await h.api("pair1", "POST", `/orgs/${orgs.pair}/members`, { userId: ids.pair1, role: "viewer" });
    expect([last.status, last.body?.error]).toEqual([409, REFUSAL]);
    expect(await usableAdmins(orgs.pair!)).toBe(1);
  });

  it("USABLE, not merely a membership: with the other admin's ACCOUNT inactive, the one admin who can sign in cannot demote or deactivate their membership (409 ×2)", async () => {
    expect(await usableAdmins(orgs.dormant!)).toBe(1);
    const demote = await h.api("dormant1", "PATCH", `/orgs/${orgs.dormant}/members/${ids.dormant1}`, { role: "bookkeeper" });
    const deactivate = await h.api("dormant1", "PATCH", `/orgs/${orgs.dormant}/members/${ids.dormant1}`, { status: "inactive" });
    expect([demote.status, deactivate.status]).toEqual([409, 409]);
    expect(await usableAdmins(orgs.dormant!)).toBe(1);
  });

  it("account deactivation: the last usable admin cannot deactivate their own account (409; they can still sign in); deactivating ANOTHER admin's account while one remains goes through (200)", async () => {
    const self = await h.api("self1", "PATCH", `/auth/users/${ids.self1}`, { isActive: false });
    expect([self.status, self.body?.error]).toEqual([409, REFUSAL]);
    expect(await h.login("self1-again", h.email("self1"), PW)).toBe(200);
    const other = await h.api("acct1", "PATCH", `/auth/users/${ids.acct2}`, { isActive: false });
    expect(other.status, JSON.stringify(other.body)).toBe(200);
    expect(await usableAdmins(orgs.acct!)).toBe(1);
    const then = await h.api("acct1", "PATCH", `/auth/users/${ids.acct1}`, { isActive: false });
    expect([then.status, then.body?.error]).toEqual([409, REFUSAL]);
    expect(await usableAdmins(orgs.acct!)).toBe(1);
  });

  it("🔴 RACE (forced) — two admins demote EACH OTHER at once: one applied, the other the guard's 409; the organisation keeps one usable admin", async () => {
    expect(await usableAdmins(orgs.race!)).toBe(2);
    const rs = await raced(orgs.race!, [], [
      () => h.api("race1", "PATCH", `/orgs/${orgs.race}/members/${ids.race2}`, { role: "bookkeeper" }),
      () => h.api("race2", "PATCH", `/orgs/${orgs.race}/members/${ids.race1}`, { role: "bookkeeper" }),
    ]);
    // eslint-disable-next-line no-console
    console.warn("[G03] demote-demote", JSON.stringify({ results: rs.map((r) => [r.status, r.body?.error ?? null]), state: await state(orgs.race!) }));
    expect(outcome(rs)).toEqual(["applied", "refused"]);
    expect(rs.find((r) => r.status === 409)?.body?.error).toBe(REFUSAL);
    expect(await usableAdmins(orgs.race!)).toBe(1);
  }, 60_000);

  it("🔴 RACE (forced) — a demotion through assign beside an account deactivation, each allowed alone: one applied, the other 409; one usable admin remains", async () => {
    expect(await usableAdmins(orgs.mixed!)).toBe(2);
    const rs = await raced(orgs.mixed!, [ids.mixed1!], [
      () => h.api("mixed1", "POST", `/orgs/${orgs.mixed}/members`, { userId: ids.mixed2, role: "bookkeeper" }),
      () => h.api("mixed2", "PATCH", `/auth/users/${ids.mixed1}`, { isActive: false }),
    ]);
    // eslint-disable-next-line no-console
    console.warn("[G03] demote-deactivate", JSON.stringify({ results: rs.map((r) => [r.status, r.body?.error ?? null]), state: await state(orgs.mixed!) }));
    expect(outcome(rs)).toEqual(["applied", "refused"]);
    expect(rs.find((r) => r.status === 409)?.body?.error).toBe(REFUSAL);
    expect(await usableAdmins(orgs.mixed!)).toBe(1);
  }, 60_000);
});
