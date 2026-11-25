/**
 * 🔴 THE MEMBER LIST FOR EVERY MEMBER: NAMES AND ROLES (owner, 2026-11-25, item 4).
 *
 * "Non-admins may list members' names and roles. Other members' emails, two-step status and sessions stay admin-only;
 * every member keeps their own. Test at the API, not only the page."
 *
 *  - `GET /orgs/:id/members` answers every ACTIVE member of that organization: the admin as before (emails included);
 *    the viewer, the bookkeeper and the accountant with each member's id, name, role and membership status — and no
 *    email, on any row, their own included (it is theirs at /auth/me).
 *  - Still the admin's alone: another member's sessions (`/auth/sessions/members`), the invitations (their emails and
 *    links). A member's two-step status is served by no member-list route at all.
 *  - Every member keeps their own: /auth/me (own email), /auth/mfa (own two-step status), /auth/sessions (own sessions).
 *  - Someone who is not an active member of THAT organization — another organization's admin, an inactive member — is
 *    refused, as before.
 * The route runs before an organization role is resolved, so the response seam withholds nothing there (seam.ts): the
 * service's own projection is what keeps the emails out, and this test holds it. DB-backed; skips on the placeholder.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, PERMISSION_MATRIX } from "@workspace/db";
import { primePermissionCache } from "../lib/rbac";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const describeDb = !!url && !url.includes("placeholder") ? describe : describe.skip;
const PW = "members-names-roles-password-2026";
const h = g04Harness("mem-nr");
const NON_ADMINS = ["viewer", "bookkeeper", "accountant"] as const;
const ALL = ["admin", ...NON_ADMINS] as const;

describeDb("item 4 — every member lists names and roles; emails, two-step status and sessions stay the admin's", () => {
  let orgId = "";
  const userIds: Record<string, number> = {};

  beforeAll(async () => {
    await h.cleanup();
    await h.start();
    primePermissionCache(PERMISSION_MATRIX);
    orgId = await h.mkOrg("org");
    await h.mkCompany(orgId, "Members NR Co", "319494949494943");
    for (const role of ALL) userIds[role] = await h.mkUser(role, PW, orgId, role);
    // refused, as before: another organization's admin, and an inactive member of this one
    const otherOrg = await h.mkOrg("other");
    await h.mkCompany(otherOrg, "Other NR Co", "319595959595953");
    userIds.outsider = await h.mkUser("outsider", PW, otherOrg, "admin");
    userIds.former = await h.mkUser("former", PW, orgId, "bookkeeper");
    for (const who of [...ALL, "outsider", "former"]) expect(await h.login(who, h.email(who), PW), who).toBe(200);
    await pool.query(`UPDATE organization_memberships SET status = 'inactive' WHERE user_id = $1`, [userIds.former]);
  }, 120_000);
  afterAll(async () => { await h.stop(); await h.cleanup(); });

  it("🔴 the viewer, the bookkeeper and the accountant list every member's name and role — and no email, on any row, their own included", async () => {
    for (const who of NON_ADMINS) {
      const r = await h.api(who, "GET", `/orgs/${orgId}/members`);
      expect([who, r.status]).toEqual([who, 200]);
      const rows = r.body.members as Array<Record<string, unknown>>;
      // presence: every active member, by name and role
      expect([who, ALL.filter((m) => !rows.some((x) => x.userId === userIds[m] && x.role === m && typeof x.name === "string" && (x.name as string).length > 0))]).toEqual([who, []]);
      // absence: no email key on any row, and no member's email anywhere in the answer
      expect([who, rows.filter((x) => "email" in x).length]).toEqual([who, 0]);
      expect([who, ALL.filter((m) => r.text.includes(h.email(m)))]).toEqual([who, []]);
      // exactly the four fields
      expect([who, [...new Set(rows.flatMap((x) => Object.keys(x)))].sort()]).toEqual([who, ["name", "role", "status", "userId"]]);
    }
  });

  it("movement: the admin's list carries every member's email, as before", async () => {
    const r = await h.api("admin", "GET", `/orgs/${orgId}/members`);
    expect(r.status).toBe(200);
    expect(ALL.filter((m) => !r.text.includes(h.email(m)))).toEqual([]);
  });

  it("🔴 still the admin's alone: another member's sessions and the invitations refuse every non-admin", async () => {
    for (const who of NON_ADMINS) {
      for (const path of ["/auth/sessions/members", `/orgs/${orgId}/invitations`]) {
        const r = await h.api(who, "GET", path);
        expect([who, path, r.status]).toEqual([who, path, 403]);
        expect([who, path, ALL.filter((m) => m !== who && r.text.includes(h.email(m)))]).toEqual([who, path, []]);
      }
    }
    for (const path of ["/auth/sessions/members", `/orgs/${orgId}/invitations`]) expect([path, (await h.api("admin", "GET", path)).status]).toEqual([path, 200]);
  });

  it("🔴 every member keeps their own: their email at /auth/me, their two-step status at /auth/mfa, their sessions at /auth/sessions", async () => {
    for (const who of ALL) {
      const me = await h.api(who, "GET", "/auth/me");
      expect([who, me.status, me.text.includes(h.email(who))]).toEqual([who, 200, true]);
      expect([who, (await h.api(who, "GET", "/auth/mfa")).status]).toEqual([who, 200]);
      expect([who, (await h.api(who, "GET", "/auth/sessions")).status]).toEqual([who, 200]);
    }
  });

  it("someone who is not an active member of THIS organization is refused — another organization's admin, an inactive member", async () => {
    for (const who of ["outsider", "former"]) {
      const r = await h.api(who, "GET", `/orgs/${orgId}/members`);
      expect([who, r.status]).toEqual([who, 403]);
      expect([who, ALL.filter((m) => r.text.includes(h.email(m)))]).toEqual([who, []]);
    }
  });
});
