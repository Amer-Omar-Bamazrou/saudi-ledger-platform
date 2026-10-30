/**
 * 🔴 Phase 18 H-12 — DR-22 (D-13), its first batch: sign-ins, refused sign-ins
 * and sign-outs are recorded in the security audit trail. DECIDED 2026-10-27 —
 * owner accepted the stated recommendation (register §11.62, the scoped D-4
 * statement, appended before this file).
 *
 * One row per ACTIVE membership, so each organization's admins see their own
 * members' events; an unknown address is recorded without the typed address.
 * Refusals are written after the 401 is sent, so they are polled for.
 *
 * Acts over HTTP. DB-backed (sl_test / CI); skips on the DB-free placeholder.
 */
process.env.PORT ??= "3262";
process.env.SESSION_SECRET ??= "phase18-h12-sign-in-events-00001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness } from "./helpers/g04Harness";
import { __resetRateLimitsForTests } from "../routes/auth";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "Phase18H12SignPw1!";
const WRONG = "Phase18H12WrongPw9!";

describeMaybe("Phase 18 H-12 — DR-22: sign-ins, refused sign-ins and sign-outs are recorded", () => {
  const h = g04Harness("p18h12sig");
  let orgA = "", orgB = "", orgC = "", member = 0, dormant = 0;
  /** This run's start on the DATABASE's clock, as text (created_at has no zone; a bound JS Date would be read in the wrong one). */
  let runStart = "";
  const ghost = `p18h12sig-nobody-${Date.now()}@test.local`;
  const rows = async (action: string, target: number) => (await pool.query(
    `SELECT organization_id, ip_address, metadata FROM security_audit_logs WHERE action = $1 AND target_user_id = $2 ORDER BY organization_id`, [action, target])).rows;
  const orgsOf = (rs: Array<{ organization_id: string | null }>) => rs.map((r) => r.organization_id).sort();

  beforeAll(async () => {
    await h.cleanup();
    runStart = (await pool.query(`SELECT now()::timestamp::text AS t`)).rows[0].t;
    orgA = await h.mkOrg("a"); orgB = await h.mkOrg("b"); orgC = await h.mkOrg("c");
    member = await h.mkUser("member", PW, orgA, "admin");
    // the same account, active in a second organization and INACTIVE in a third (fixtures)
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'viewer','active'), ($1,$3,'viewer','inactive')`, [member, orgB, orgC]);
    dormant = await h.mkUser("dormant", PW, orgA, "viewer");
    await pool.query(`UPDATE users SET is_active = false WHERE id = $1`, [dormant]);
    await h.start();
  }, 120_000);

  // the security audit trail is append-only for every role (T1b): its rows stay, as every suite's do
  afterAll(async () => { await h.stop(); await h.cleanup(); });

  it("🔴 a sign-in is recorded once per ACTIVE membership — not for the inactive one", async () => {
    expect(await h.login("member", h.email("member"), PW)).toBe(200);
    const r = await rows("auth.login", member);
    expect(orgsOf(r)).toEqual([orgA, orgB].sort());
    expect(r.every((x) => x.ip_address)).toBe(true);
  });

  it("🔴 a sign-out is recorded the same way", async () => {
    expect((await h.api("member", "POST", "/auth/logout")).status).toBe(200);
    expect(orgsOf(await rows("auth.logout", member))).toEqual([orgA, orgB].sort());
  });

  it("🔴 a wrong password is recorded against the account, per active membership, with its reason — written after the 401", async () => {
    expect(await h.login("member", h.email("member"), WRONG)).toBe(401);
    await expect.poll(async () => (await rows("auth.login_failed", member)).map((x) => [x.organization_id, x.metadata?.reason]).sort())
      .toEqual([[orgA, "wrong_password"], [orgB, "wrong_password"]].sort());
  });

  it("🔴 an inactive account's refused sign-in says so", async () => {
    expect(await h.login("dormant", h.email("dormant"), PW)).toBe(401);
    await expect.poll(async () => (await rows("auth.login_failed", dormant)).map((x) => [x.organization_id, x.metadata?.reason]))
      .toEqual([[orgA, "inactive"]]);
  });

  it("🔴 an unknown address is recorded with no account and no organization — and the typed address is stored NOWHERE", async () => {
    // counted before and after — not a time window: created_at has no zone, so a bound JS Date is read in the wrong one
    const unknownRows = async () => Number((await pool.query(
      `SELECT count(*)::int AS n FROM security_audit_logs WHERE action = 'auth.login_failed' AND organization_id IS NULL AND target_user_id IS NULL
          AND metadata->>'reason' = 'unknown_account'`)).rows[0].n);
    const before = await unknownRows();
    expect(await h.login("ghost", ghost, PW)).toBe(401);
    await expect.poll(unknownRows).toBeGreaterThan(before);
    const leaked = (await pool.query(
      `SELECT count(*)::int AS n FROM security_audit_logs WHERE coalesce(actor_email, '') = $1 OR coalesce(metadata::text, '') LIKE $2`, [ghost, `%${ghost}%`])).rows[0].n;
    expect(leaked).toBe(0);
    // what such a row stores, for EVERY one written during this run: the reason, the IP and the time — no identity, no
    // typed text. (Scoped to the run: the trail is append-only, so rows a mutation run wrote on purpose stay for good.)
    const shape = (await pool.query(
      `SELECT count(*)::int AS n, count(*) FILTER (WHERE NOT (actor_user_id IS NULL AND actor_email IS NULL AND organization_id IS NULL AND target_user_id IS NULL
          AND metadata = '{"reason":"unknown_account"}'::jsonb AND ip_address IS NOT NULL))::int AS bad
         FROM security_audit_logs WHERE action = 'auth.login_failed' AND metadata->>'reason' = 'unknown_account' AND created_at >= $1::timestamp`, [runStart])).rows[0];
    expect([shape.n > 0, shape.bad]).toEqual([true, 0]);
  });

  it("🔴 no password material is recorded anywhere for these accounts", async () => {
    const all = (await pool.query(`SELECT coalesce(metadata::text, '') AS m FROM security_audit_logs WHERE target_user_id IN ($1, $2)`, [member, dormant])).rows;
    expect(all.length).toBeGreaterThan(0);
    expect(all.filter((x) => x.m.includes(PW) || x.m.includes(WRONG))).toEqual([]);
    // …and in NO column of ANY row of the whole table (both passwords are unique to this file)
    const anywhere = (await pool.query(
      `SELECT count(*)::int AS n FROM security_audit_logs s WHERE row_to_json(s)::text LIKE $1 OR row_to_json(s)::text LIKE $2`, [`%${PW}%`, `%${WRONG}%`])).rows[0].n;
    expect(anywhere).toBe(0);
  });

  // Owner, 2026-10-30 (resume instruction §2e): anonymous writes into a table nothing can clean up must stay bounded —
  // a refused sign-in is recorded only when the sign-in rate limiter has ADMITTED the request.
  it("🔴 a refused sign-in is written only after the limiter admits it — a request the limiter refuses (429) writes nothing", async () => {
    await __resetRateLimitsForTests();
    const failed = async () => (await rows("auth.login_failed", member)).length;
    const start = await failed();
    try {
      // the IP limit admits ten attempts in its window; each admitted refusal writes one row per active membership (two)
      for (let i = 0; i < 10; i++) expect(await h.login("member", h.email("member"), WRONG), `attempt ${i + 1}`).toBe(401);
      await expect.poll(failed).toBe(start + 20);
      // the eleventh is refused by the limiter, before the handler runs
      expect(await h.login("member", h.email("member"), WRONG)).toBe(429);
      // the admitted refusals' rows landed within the poll above; a row for the eleventh would land as fast
      await new Promise((r) => setTimeout(r, 1_000));
      expect(await failed()).toBe(start + 20);
    } finally {
      await __resetRateLimitsForTests();
    }
  });
});
