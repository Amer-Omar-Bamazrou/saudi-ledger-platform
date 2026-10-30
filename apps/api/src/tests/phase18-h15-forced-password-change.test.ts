/**
 * 🔴 Phase 18 H-15 — DR-06 part 1 and DR-27 (the forced change): a password
 * set by someone other than the account holder — an admin creating the account,
 * an admin's reset, an operator's break-glass — must be changed before the
 * session reaches anything else. DECIDED 2026-10-27 — owner accepted the stated
 * recommendations (register §11.66, the scoped D-4 statement, appended before
 * this file).
 *
 * Acts over HTTP. DB-backed (sl_test / CI); skips on the DB-free placeholder.
 */
process.env.PORT ??= "3265";
process.env.SESSION_SECRET ??= "phase18-h15-forced-password-chg1";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { operatorService } from "../services/operator.service";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "Phase18H15OwnPw1!";
const SET = "Phase18H15SetByOther1!";
const MINE = "Phase18H15MyChoice9!";

describeMaybe("Phase 18 H-15 — a password someone else set must be changed before anything else", () => {
  const h = g04Harness("p18h15pwd");
  let orgId = "", adminId = 0, admin2Id = 0, targetId = 0, operatorId = 0;
  const flagOf = async (id: number) => (await pool.query(`SELECT password_change_required AS f FROM users WHERE id = $1`, [id])).rows[0]?.f;
  /** A business route, an identity route and an admin act under /auth — each refused while a change is owed. */
  const refusedEverywhere = async (who: string) => {
    for (const [method, path] of [["GET", "/invoices"], ["GET", "/orgs"], ["POST", "/auth/register"]] as const) {
      const r = await h.api(who, method, path, method === "POST" ? {} : undefined);
      expect([path, r.status, r.body?.code]).toEqual([path, 403, "password_change_required"]);
    }
  };

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    await h.mkCompany(orgId, "H15 Co", "399999999999943");
    adminId = await h.mkUser("admin", PW, orgId, "admin");
    admin2Id = await h.mkUser("admin2", PW, orgId, "admin");
    targetId = await h.mkUser("target", PW, orgId, "bookkeeper");
    operatorId = await h.mkUser("operator", PW, null, "admin");
    await pool.query(`INSERT INTO platform_operators (user_id, granted_by) VALUES ($1, $1)`, [operatorId]);
    await h.start();
    expect(await h.login("admin", h.email("admin"), PW)).toBe(200);
  }, 120_000);

  afterAll(async () => { await h.stop(); await h.cleanup(); });

  it("control: an account holder who chose their own password reaches everything", async () => {
    expect((await h.api("admin", "GET", "/invoices")).status).toBe(200);
    expect((await h.api("admin", "GET", "/orgs")).status).toBe(200);
  });

  it("🔴 an account an ADMIN created with a password: the holder signs in, is refused everywhere but the way to change it, and is free once they have", async () => {
    const created = await h.api("admin", "POST", "/auth/register", { email: h.email("created"), name: "H15 Created", password: SET, role: "bookkeeper", organizationId: orgId });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(await h.login("created", h.email("created"), SET)).toBe(200);
    const me = await h.api("created", "GET", "/auth/me");
    expect([me.status, me.body?.passwordChangeRequired]).toEqual([200, true]);
    await refusedEverywhere("created");
    expect((await h.api("created", "POST", "/auth/change-password", { currentPassword: SET, newPassword: MINE })).status).toBe(200);
    expect((await h.api("created", "GET", "/invoices")).status).toBe(200);
    expect((await h.api("created", "GET", "/auth/me")).body?.passwordChangeRequired).toBe(false);
  });

  it("🔴 an ADMIN's reset of another admin: the reset admin cannot administer anyone until they change it", async () => {
    expect((await h.api("admin", "POST", `/auth/users/${admin2Id}/reset-password`, { newPassword: SET })).status).toBe(200);
    expect(await h.login("admin2", h.email("admin2"), SET)).toBe(200);
    await refusedEverywhere("admin2");
    expect(await flagOf(admin2Id)).toBe(true);
    expect((await h.api("admin2", "POST", "/auth/logout")).status, "signing out stays possible").toBe(200);
  });

  it("🔴 an OPERATOR's break-glass reset: the holder is held to the change as well", async () => {
    const out = await operatorService.resetUserPassword(operatorId, h.email("target"), { actorEmail: h.email("operator"), ipAddress: "203.0.113.15" });
    expect(await h.login("target", h.email("target"), out.temporaryPassword)).toBe(200);
    await refusedEverywhere("target");
    expect(await flagOf(targetId)).toBe(true);
    expect((await h.api("target", "POST", "/auth/change-password", { currentPassword: out.temporaryPassword, newPassword: MINE })).status).toBe(200);
    expect([(await h.api("target", "GET", "/invoices")).status, await flagOf(targetId)]).toEqual([200, false]);
  });
});
