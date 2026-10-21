/**
 * PHASE 18 · S1-b · G03 PROOF — an organisation's LAST admin removed through
 * the paths the last-admin guard does not cover. PROOF ONLY, NOT A FIX.
 *
 * Authorised by the owner on 2026-10-16 (Batch 4B). Definition: Phase 18
 * contract G03 (§11.2: "The last-admin guard covers `update` only. `assign`
 * (now the UI role-change path) and self-deactivation are unguarded"), register
 * DR-05, and the plan of 2026-10-16 §9.
 *
 * The mechanism (read at f480a569):
 *  - `membersService.update` (PATCH /orgs/:orgId/members/:userId) refuses to
 *    demote or deactivate the last active admin (409);
 *  - `membersService.assign` (POST /orgs/:orgId/members) upserts the role with
 *    no such check;
 *  - `userAdminService.update` (PATCH /auth/users/:id { isActive: false })
 *    deactivates the ACCOUNT with no such check, and login refuses an inactive
 *    account — so an organisation can be left with no admin who can sign in.
 *
 * FIX-NEUTRAL invariant: after any act, the organisation still has at least one
 * ACTIVE admin membership whose ACCOUNT is active (an admin who can sign in).
 * CONTROL: the guarded path (`update`) refuses the same demotion with 409.
 *
 * 🔴 Expected to FAIL while G03 exists. Untracked S1-b file — never merged red,
 * never weakened. Does NOT call the rate-limit reset hook. DB-backed.
 */

process.env.PORT ??= "3155";
process.env.SESSION_SECRET ??= "phase18-s1b-g03-proof-session-secret-0001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

const PW = "S1bG03ProofPw123!";

describeMaybe("Phase 18 S1-b · G03 proof — the last admin removed through an unguarded path", () => {
  const h = g04Harness("s1bg03");
  let orgX = "", orgY = "", orgZ = "";
  let adminX = 0, adminY = 0, adminZ = 0;

  /** Admins of `orgId` who can actually sign in: active admin membership AND an active account. */
  const usableAdmins = async (orgId: string) => Number((await pool.query(
    `SELECT count(*)::int AS n FROM organization_memberships m JOIN users u ON u.id = m.user_id
      WHERE m.organization_id = $1 AND m.role = 'admin' AND m.status = 'active' AND u.is_active`, [orgId],
  )).rows[0].n);
  const membership = async (orgId: string, userId: number) => (await pool.query(
    `SELECT m.role, m.status, u.is_active FROM organization_memberships m JOIN users u ON u.id = m.user_id
      WHERE m.organization_id = $1 AND m.user_id = $2`, [orgId, userId],
  )).rows[0];

  beforeAll(async () => {
    await h.cleanup();
    orgX = await h.mkOrg("x");
    await h.mkCompany(orgX, "S1b G03 X", "318181818181873");
    orgY = await h.mkOrg("y");
    await h.mkCompany(orgY, "S1b G03 Y", "318181818181883");
    orgZ = await h.mkOrg("z");
    await h.mkCompany(orgZ, "S1b G03 Z", "318181818181893");
    adminX = await h.mkUser("adminx", PW, orgX, "admin");
    await h.mkUser("bookx", PW, orgX, "bookkeeper");
    adminY = await h.mkUser("adminy", PW, orgY, "admin");
    await h.mkUser("booky", PW, orgY, "bookkeeper");
    adminZ = await h.mkUser("adminz", PW, orgZ, "admin");
    await h.start();
    for (const who of ["adminx", "adminy", "adminz"]) expect(await h.login(who, h.email(who), PW), `login ${who}`).toBe(200);
  }, 120_000);

  afterAll(async () => {
    await h.stop();
    await h.cleanup();
  });

  it("PREMISE + CONTROL: each organisation has exactly one usable admin; the GUARDED path (PATCH member) refuses to demote it with 409", async () => {
    expect([await usableAdmins(orgX), await usableAdmins(orgY), await usableAdmins(orgZ)]).toEqual([1, 1, 1]);
    const r = await h.api("adminz", "PATCH", `/orgs/${orgZ}/members/${adminZ}`, { role: "bookkeeper" });
    const after = await membership(orgZ, adminZ);
    // eslint-disable-next-line no-console
    console.warn("[S1B G03] CONTROL update", JSON.stringify({ status: r.status, error: String(r.body?.error ?? "").slice(0, 120), membership: after, usableAdmins: await usableAdmins(orgZ) }));
    expect(r.status).toBe(409);
    expect(await usableAdmins(orgZ)).toBe(1);
  });

  it("🔴 PROOF (assign): the last admin re-assigned to bookkeeper through POST /orgs/:orgId/members — the organisation still has a usable admin", async () => {
    const r = await h.api("adminx", "POST", `/orgs/${orgX}/members`, { userId: adminX, role: "bookkeeper" });
    const after = await membership(orgX, adminX);
    const usable = await usableAdmins(orgX);
    // eslint-disable-next-line no-console
    console.warn("[S1B G03] ASSIGN", JSON.stringify({ status: r.status, body: r.body, membership: after, usableAdmins: usable }));
    expect.soft(usable, "the organisation keeps at least one admin who can sign in").toBeGreaterThanOrEqual(1);
  });

  it("🔴 PROOF (self-deactivation): the last admin deactivates their own account (PATCH /auth/users/:id) — the organisation still has a usable admin", async () => {
    const r = await h.api("adminy", "PATCH", `/auth/users/${adminY}`, { isActive: false });
    const after = await membership(orgY, adminY);
    const usable = await usableAdmins(orgY);
    const relogin = await h.login("adminy-relogin", h.email("adminy"), PW);
    // eslint-disable-next-line no-console
    console.warn("[S1B G03] SELF-DEACTIVATE", JSON.stringify({ status: r.status, body: typeof r.body === "object" ? { isActive: r.body?.isActive, error: r.body?.error } : r.body, membership: after, usableAdmins: usable, reloginStatus: relogin }));
    expect.soft(usable, "the organisation keeps at least one admin who can sign in").toBeGreaterThanOrEqual(1);
  });
});
