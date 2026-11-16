/**
 * 🔴 Phase 18 owner decision A1 (2026-11-16) — DR-23's second admin is not an identity the requester controls.
 *
 * DR-23 holds a bank-detail change for a second admin (0151 refuses the requester). The audit's A1 found the gap: an
 * admin can create another admin identity (or reset its password, or re-activate it) and approve their own change
 * from it. The owner's rule: approval of a held bank-detail change is refused when the approver is the requester, or
 * an identity the requester CREATED, RE-ACTIVATED or RESET (password; MFA once it exists) within the preceding 30
 * days. Enforced at the write boundary (the database guard that already owns the decision), refused with a code
 * naming the rule, and the refusal recorded in the security trail (the request's own transaction rolls back, so the
 * record is written outside it).
 *
 * The window: an identity event by the requester on the approver at an instant AFTER now() − 30 days blocks; one at
 * or before it does not (planted one minute either side). The links are made through the product's own paths.
 * Presence, absence, movement: each link refuses; an unlinked admin approves; an event of the other direction, or by
 * someone else, does not block. DB-backed (sl_test / CI).
 */
process.env.PORT ??= "3393";
process.env.SESSION_SECRET ??= "phase18-owner-a1-linked-approver-001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness } from "./helpers/g04Harness";
import { until } from "./helpers/g08rRace";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "OwnerA1LinkedApproverPw1!";
const SET = "OwnerA1SetByAdminPw2!";
const MINE = "OwnerA1MyOwnPassword3!";
const IBAN_A = "SA0380000000608010167519";
const IBAN_B = "SA1310000000111122223333";
const CHANGES = "/companies/current/bank-detail-changes";
const CODE = "bank_detail_approver_linked";

describeMaybe("Phase 18 owner decision A1 — the approver of a held bank-detail change is not an identity the requester controls", () => {
  const h = g04Harness("owna1");
  let orgId = "";
  const ids: Record<string, number> = {};

  const ok = async (who: string, method: string, path: string, body?: unknown) => {
    const r = await h.api(who, method, path, body);
    expect(r.status, `${who} ${method} ${path}: ${JSON.stringify(r.body)}`).toBeLessThan(300);
    return r.body;
  };
  /** A held change, requested by the requester: a vendor's IBAN, held because the organisation has two or more admins. */
  const heldChange = async (name: string) => {
    const v = (await ok("requester", "POST", "/vendors", { name, residency: "resident", iban: IBAN_A })).id as number;
    const r = await ok("requester", "PATCH", `/vendors/${v}`, { iban: IBAN_B });
    const pending = (r.pendingBankDetailChanges ?? []) as Array<{ id: number }>;
    expect(pending.length, "the change is held for a second admin").toBe(1);
    return pending[0]!.id;
  };
  const decide = (who: string, id: number) => h.api(who, "PUT", `${CHANGES}/${id}/decision`, { decision: "approve" });
  const refusalsRecorded = async (approver: number, changeId: number) => Number((await pool.query(
    `SELECT count(*)::int AS n FROM security_audit_logs WHERE action = 'bank_detail_change.approval_refused'
       AND actor_user_id = $1 AND organization_id = $2 AND (metadata ->> 'changeId')::int = $3`, [approver, orgId, changeId])).rows[0].n);
  /** Plants an identity event in the security trail at an exact age (owner connection; the table is append-only, never updated). */
  const plant = (action: string, actor: number, target: number, ageSql: string) => pool.query(
    `INSERT INTO security_audit_logs (action, actor_user_id, target_user_id, organization_id, created_at) VALUES ($1, $2, $3, $4, now() - (${ageSql}))`,
    [action, actor, target, orgId]);

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    await pool.query(
      `INSERT INTO companies (organization_id, name, cr_number, vat_number, fiscal_year_start, building_number, street, district, city, postal_code, additional_number)
       VALUES ($1,'Owner A1 Co','1010868391','310123456789013',1,'1234','King Fahd Road','Al Olaya','Riyadh','12345','6789')`, [orgId]);
    for (const k of ["requester", "independent", "reset", "reactivated", "inside", "outside", "createdOnly"]) ids[k] = await h.mkUser(k, PW, orgId, "admin");
    await h.start();
    for (const k of ["requester", "independent", "reactivated", "inside", "outside", "createdOnly"]) expect(await h.login(k, h.email(k), PW), `login ${k}`).toBe(200);

    // CREATED by the requester, through the product's own path (an admin-set password, changed at first sign-in, H-15)
    ids.created = (await ok("requester", "POST", "/auth/register", { name: "A1 Created", email: h.email("created"), password: SET, role: "admin", organizationId: orgId })).id;
    expect(await h.login("created", h.email("created"), SET)).toBe(200);
    await ok("created", "POST", "/auth/change-password", { currentPassword: SET, newPassword: MINE });

    // RESET by the requester (the reset ends its sessions; it signs in with the set password and changes it)
    await ok("requester", "POST", `/auth/users/${ids.reset}/reset-password`, { newPassword: SET });
    expect(await h.login("reset", h.email("reset"), SET)).toBe(200);
    await ok("reset", "POST", "/auth/change-password", { currentPassword: SET, newPassword: MINE });

    // RE-ACTIVATED by the requester: its membership set inactive, then active again
    await ok("requester", "PATCH", `/orgs/${orgId}/members/${ids.reactivated}`, { status: "inactive" });
    await ok("requester", "PATCH", `/orgs/${orgId}/members/${ids.reactivated}`, { status: "active" });
    // (its session survives: deactivating a membership ends no session; the sign-in limiter's budget is spent with care)

    // The window's two sides, planted one minute either side of 30 days (a reset by the requester)
    await plant("user.password_reset", ids.requester!, ids.inside!, "interval '30 days' - interval '1 minute'");
    await plant("user.password_reset", ids.requester!, ids.outside!, "interval '30 days' + interval '1 minute'");
    // The creation clause on its own: a `user.created` by the requester, with no membership event beside it
    await plant("user.created", ids.requester!, ids.createdOnly!, "interval '1 day'");
    // Not links: the approver acting on the requester (the other direction), and a third admin acting on the approver
    await plant("user.password_reset", ids.independent!, ids.requester!, "interval '1 day'");
    await plant("user.password_reset", ids.outside!, ids.independent!, "interval '1 day'");
  }, 180_000);

  afterAll(async () => { await h.stop(); await h.cleanup(); });

  for (const [who, how] of [["created", "created"], ["reset", "had its password reset"], ["reactivated", "re-activated"]] as const) {
    it(`🔴 an admin the requester ${how} within 30 days cannot approve the requester's change — refused by name, and recorded`, async () => {
      const id = await heldChange(`A1 ${who}`);
      const r = await decide(who, id);
      expect([r.status, r.body?.code], JSON.stringify(r.body)).toEqual([409, CODE]);
      expect(typeof r.body?.errorAr, "the refusal speaks Arabic too").toBe("string");
      expect((await pool.query(`SELECT status FROM bank_detail_change_requests WHERE id = $1`, [id])).rows[0].status).toBe("pending");
      // The refusal is recorded best-effort, after the response (as R-9's reference refusals are): wait for the row,
      // bounded, then require exactly one. Reading at once raced the write (CI run 43965670173).
      await until("the refusal is recorded", async () => (await refusalsRecorded(ids[who]!, id)) >= 1, 5_000).catch(() => undefined);
      expect(await refusalsRecorded(ids[who]!, id), "the refusal is in the security trail").toBe(1);
    });
  }

  it("🔴 a creation by the requester links on its own (no membership event beside it)", async () => {
    const id = await heldChange("A1 created only");
    const r = await decide("createdOnly", id);
    expect([r.status, r.body?.code], JSON.stringify(r.body)).toEqual([409, CODE]);
  });

  it("🔴 the window's inside edge: a reset 30 days less one minute ago still blocks", async () => {
    const id = await heldChange("A1 inside");
    const r = await decide("inside", id);
    expect([r.status, r.body?.code], JSON.stringify(r.body)).toEqual([409, CODE]);
  });

  it("movement — the window's outside edge: a reset 30 days and one minute ago no longer blocks", async () => {
    const id = await heldChange("A1 outside");
    const r = await decide("outside", id);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body?.status).toBe("approved");
  });

  it("movement — an admin the requester never touched approves; the other direction, or a third admin's act, links nobody", async () => {
    const id = await heldChange("A1 independent");
    const r = await decide("independent", id);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body?.status).toBe("approved");
  });

  it("the requester still cannot approve its own change (0151's rule, unchanged)", async () => {
    const id = await heldChange("A1 self");
    const r = await decide("requester", id);
    expect([r.status, r.body?.code]).toEqual([409, "second_admin_required"]);
  });
});
