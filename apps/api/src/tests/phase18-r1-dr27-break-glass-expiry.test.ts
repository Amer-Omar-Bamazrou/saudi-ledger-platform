/**
 * 🔴 Phase 18 R-1 — DR-27's expiry: an operator-set (break-glass) password is
 * usable for 24 hours; after that it never signs in again, and a session it
 * opened reaches nothing but the way out. The period is the owner's answer of
 * 2026-11-01 (register §11.82); the scoped D-4 is §11.83, appended before this
 * file. An admin's reset has no expiry (DR-06's forced change only).
 *
 * Acts over HTTP. DB-backed (sl_test / CI); skips on the DB-free placeholder.
 */
process.env.PORT ??= "3267";
process.env.SESSION_SECRET ??= "phase18-r1-break-glass-expiry-1";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { operatorService } from "../services/operator.service";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "Phase18R1OwnPw1!";
const MINE = "Phase18R1MyChoice9!";
const HOUR = 3_600_000;

describeMaybe("Phase 18 R-1 — DR-27: a break-glass password expires after 24 hours", () => {
  const h = g04Harness("p18r1bgx");
  let orgId = "", adminId = 0, targetId = 0, target2Id = 0, operatorId = 0;
  const row = async (id: number) =>
    (await pool.query(`SELECT password_hash AS hash, password_change_required AS owed, break_glass_expires_at AS expires FROM users WHERE id = $1`, [id])).rows[0] as
      { hash: string; owed: boolean; expires: Date | null };
  const expire = (id: number) => pool.query(`UPDATE users SET break_glass_expires_at = now() - interval '1 minute' WHERE id = $1`, [id]);
  const refusedRows = async (id: number) =>
    (await pool.query(`SELECT organization_id, metadata FROM security_audit_logs WHERE action = 'auth.login_failed' AND target_user_id = $1 AND metadata->>'reason' = 'break_glass_expired'`, [id])).rows;
  const breakGlass = (who: string) => operatorService.resetUserPassword(operatorId, h.email(who), { actorEmail: h.email("operator"), ipAddress: "203.0.113.27" });

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    await h.mkCompany(orgId, "R1 Co", "399999999999967");
    adminId = await h.mkUser("admin", PW, orgId, "admin");
    targetId = await h.mkUser("target", PW, orgId, "bookkeeper");
    target2Id = await h.mkUser("target2", PW, orgId, "bookkeeper");
    operatorId = await h.mkUser("operator", PW, null, "admin");
    await pool.query(`INSERT INTO platform_operators (user_id, granted_by) VALUES ($1, $1)`, [operatorId]);
    await h.start();
    expect(await h.login("admin", h.email("admin"), PW)).toBe(200);
  }, 120_000);

  afterAll(async () => { await h.stop(); await h.cleanup(); });

  it("control: inside the window the temporary password signs in, and the stored expiry is 24 hours from the reset", async () => {
    const before = Date.now();
    const out = await breakGlass("target");
    const r = await row(targetId);
    expect(r.owed).toBe(true);
    expect(r.expires, "the reset stamps an expiry").not.toBeNull();
    const ms = r.expires!.getTime() - before;
    expect(ms).toBeGreaterThan(24 * HOUR - 5 * 60_000);
    expect(ms).toBeLessThan(24 * HOUR + 5 * 60_000);
    expect(await h.login("target", h.email("target"), out.temporaryPassword)).toBe(200);
    expect((await h.api("target", "POST", "/auth/logout")).status).toBe(200);
    expect((await refusedRows(targetId)).length, "nothing refused yet").toBe(0);
  });

  it("🔴 EXPIRED: the temporary password is refused with its own code, the refusal is recorded with its reason, and the hash is untouched", async () => {
    const out = await breakGlass("target");
    const { hash } = await row(targetId);
    await expire(targetId);
    const r = await h.api("target", "POST", "/auth/login", { email: h.email("target"), password: out.temporaryPassword });
    expect([r.status, r.body?.code]).toEqual([401, "break_glass_expired"]);
    expect(String(r.body?.error)).toMatch(/expired/i);
    expect((await row(targetId)).hash, "the hash is not changed by a refused sign-in").toBe(hash);
    await expect.poll(async () => (await refusedRows(targetId)).map((x) => x.organization_id)).toEqual([orgId]);
    // a wrong password on the same expired account is still a wrong password, not an oracle for the window
    const wrong = await h.api("target", "POST", "/auth/login", { email: h.email("target"), password: "not-the-temporary-one-1!" });
    expect([wrong.status, wrong.body?.code]).toEqual([401, undefined]);
  });

  it("🔴 a session opened INSIDE the window reaches nothing but the way out once it has passed — the change included", async () => {
    const out = await breakGlass("target");
    expect(await h.login("target", h.email("target"), out.temporaryPassword)).toBe(200);
    await expire(targetId);
    for (const [method, path] of [["GET", "/invoices"], ["GET", "/orgs"], ["POST", "/auth/change-password"]] as const) {
      const r = await h.api("target", method, path, method === "POST" ? { currentPassword: out.temporaryPassword, newPassword: MINE } : undefined);
      expect([path, r.status, r.body?.code]).toEqual([path, 403, "break_glass_expired"]);
    }
    expect((await h.api("target", "GET", "/auth/me")).status, "the page can still read who it is").toBe(200);
    expect((await h.api("target", "POST", "/auth/logout")).status, "signing out stays possible").toBe(200);
    expect((await row(targetId)).owed, "the change is still owed — only a new reset answers it").toBe(true);
  });

  it("🔴 the holder's own change inside the window clears the expiry, and the chosen password signs in with no window at all", async () => {
    const out = await breakGlass("target");
    expect(await h.login("target", h.email("target"), out.temporaryPassword)).toBe(200);
    expect((await h.api("target", "POST", "/auth/change-password", { currentPassword: out.temporaryPassword, newPassword: MINE })).status).toBe(200);
    const r = await row(targetId);
    expect([r.owed, r.expires]).toEqual([false, null]);
    expect((await h.api("target", "POST", "/auth/logout")).status).toBe(200);
    expect(await h.login("target", h.email("target"), MINE)).toBe(200);
    expect((await h.api("target", "GET", "/invoices")).status).toBe(200);
    expect((await h.api("target", "POST", "/auth/logout")).status).toBe(200);
  });

  it("🔴 an ADMIN's reset carries no expiry, and clears a stale break-glass one", async () => {
    await breakGlass("target2");
    await expire(target2Id);
    expect((await h.api("admin", "POST", `/auth/users/${target2Id}/reset-password`, { newPassword: MINE })).status).toBe(200);
    const r = await row(target2Id);
    expect([r.owed, r.expires]).toEqual([true, null]);
    expect(await h.login("target2", h.email("target2"), MINE), "an admin-set password signs in whenever it is used").toBe(200);
    expect((await h.api("target2", "POST", "/auth/logout")).status).toBe(200);
  });

  it("🔴 a second break-glass replaces the window", async () => {
    await breakGlass("target2");
    await expire(target2Id);
    const second = await breakGlass("target2");
    const r = await row(target2Id);
    expect(r.expires!.getTime()).toBeGreaterThan(Date.now() + 23 * HOUR);
    expect(await h.login("target2", h.email("target2"), second.temporaryPassword)).toBe(200);
    expect((await h.api("target2", "POST", "/auth/logout")).status).toBe(200);
  });
});
