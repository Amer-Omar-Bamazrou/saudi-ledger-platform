/**
 * 🔴 Phase 18 R-6 — DR-23 (D-6), its dual control (register §11.98): "Dual
 * control only where two admins exist."
 *
 * Where an organisation has two or more USABLE admins (G03's definition: an
 * active admin membership AND an active account), a change of a bank detail —
 * a supplier's IBAN, a company bank account's IBAN, or which account is the
 * default (the IBAN printed on future invoices, G30) — is not written: it is
 * recorded as a PENDING request, and a second admin (never the requester)
 * applies it. Below two, the change applies at once, as before (H-8's audit
 * record). The database refuses the write itself without an approval made in
 * the same transaction, so no path can skip the request.
 *
 * Every refusal is asserted beside its control (the act that IS allowed), and
 * the isolation case shows each organisation its own request (presence,
 * absence, movement).
 *
 * DB-backed (sl_test / CI); skips on the DB-free placeholder.
 */
process.env.PORT ??= "3216";
process.env.SESSION_SECRET ??= "r6-dr23-dual-control-000000000000001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, db, vendorsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "R6DualControlPw123!";
const IBAN_A = "SA0380000000608010167519";
const IBAN_B = "SA1310000000111122223333";
const IBAN_C = "SA5145000000444455556666";
const IBAN_D = "SA8980000000777788889999";
const CHANGES = "/companies/current/bank-detail-changes";

describeMaybe("Phase 18 R-6 (DR-23) — dual control on bank details, only where two admins exist", () => {
  const h = g04Harness("r6dual");
  const orgs: Record<string, string> = {};
  const cos: Record<string, string> = {};
  const ids: Record<string, number> = {};

  /** G03's definition of a usable admin, read the way the G03 suites read it. */
  const g03UsableAdmins = async (orgId: string) => Number((await pool.query(
    `SELECT count(*)::int AS n FROM organization_memberships m JOIN users u ON u.id = m.user_id
      WHERE m.organization_id = $1 AND m.role = 'admin' AND m.status = 'active' AND u.is_active`, [orgId],
  )).rows[0].n);
  const storedIban = async (vendorId: number) => (await pool.query(`SELECT iban FROM vendors WHERE id = $1`, [vendorId])).rows[0].iban as string | null;
  const account = async (id: number) => (await pool.query(`SELECT iban, is_default FROM bank_accounts WHERE id = $1`, [id])).rows[0] as { iban: string | null; is_default: boolean };
  const mkVendor = async (who: string, name: string, iban: string) => {
    const r = await h.api(who, "POST", "/vendors", { name, residency: "resident", iban });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.id as number;
  };
  const mkAccount = async (who: string, name: string, extra: Record<string, unknown> = {}) => {
    const r = await h.api(who, "POST", "/bank-accounts", { name, bankName: "SNB", currency: "SAR", ...extra });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body;
  };
  const pendingOf = (body: any) => (body?.pendingBankDetailChanges ?? []) as Array<Record<string, any>>;
  /** A second admin's decision on a request: PUT, the company resource's admin-only write (register §11.99). */
  const decide = (who: string, id: number, decision: string) => h.api(who, "PUT", `${CHANGES}/${id}/decision`, { decision });

  beforeAll(async () => {
    await h.cleanup();
    for (const [i, key] of ["solo", "pair", "dormant", "other"].entries()) {
      orgs[key] = await h.mkOrg(key);
      cos[key] = await h.mkCompany(orgs[key]!, `R6 ${key}`, `31919191919${String(i + 1).padStart(2, "0")}03`);
    }
    ids.solo = await h.mkUser("solo", PW, orgs.solo!, "admin");
    ids.pairA = await h.mkUser("pairA", PW, orgs.pair!, "admin");
    ids.pairB = await h.mkUser("pairB", PW, orgs.pair!, "admin");
    ids.pairBk = await h.mkUser("pairBk", PW, orgs.pair!, "bookkeeper");
    ids.dormA = await h.mkUser("dormA", PW, orgs.dormant!, "admin");
    ids.dormB = await h.mkUser("dormB", PW, orgs.dormant!, "admin");
    ids.othA = await h.mkUser("othA", PW, orgs.other!, "admin");
    ids.othB = await h.mkUser("othB", PW, orgs.other!, "admin");
    await h.start();
    for (const who of ["solo", "pairA", "pairB", "pairBk", "dormA", "othA", "othB"]) {
      expect(await h.login(who, h.email(who), PW), `login ${who}`).toBe(200);
    }
    // dormB holds an ACTIVE admin membership on an INACTIVE account: an admin who cannot sign in, so not usable.
    await pool.query(`UPDATE users SET is_active = false WHERE id = $1`, [ids.dormB]);
  }, 120_000);
  afterAll(async () => { await h.stop(); await h.cleanup(); });

  it("control — ONE usable admin: a supplier's IBAN change applies at once, as before", async () => {
    const v = await mkVendor("solo", "R6 Solo Supplier", IBAN_A);
    const r = await h.api("solo", "PATCH", `/vendors/${v}`, { iban: IBAN_B });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect([r.body.iban, await storedIban(v)]).toEqual([IBAN_B, IBAN_B]);
  });

  it("the database's count of usable admins is G03's, on every planted state (one, two, one usable of two)", async () => {
    for (const [key, expected] of [["solo", 1], ["pair", 2], ["dormant", 1], ["other", 2]] as const) {
      const sqlCount = Number((await pool.query(`SELECT org_usable_admin_count($1) AS n`, [orgs[key]])).rows[0].n);
      expect([key, sqlCount, await g03UsableAdmins(orgs[key]!)]).toEqual([key, expected, expected]);
    }
  });

  it("🔴 an admin whose account is INACTIVE does not count: one usable admin of two applies at once", async () => {
    const v = await mkVendor("dormA", "R6 Dormant Supplier", IBAN_A);
    const r = await h.api("dormA", "PATCH", `/vendors/${v}`, { iban: IBAN_B });
    expect([r.status, await storedIban(v), pendingOf(r.body)]).toEqual([200, IBAN_B, []]);
  });

  describe("two usable admins", () => {
    let v = 0;
    let requestId = 0;

    it("🔴 the change WAITS: the stored IBAN is unchanged, the other field is written, and one pending request is recorded and listed", async () => {
      v = await mkVendor("pairA", "R6 Pair Supplier", IBAN_A);
      const r = await h.api("pairA", "PATCH", `/vendors/${v}`, { iban: IBAN_B, city: "Jeddah" });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect([r.body.iban, r.body.city, await storedIban(v)]).toEqual([IBAN_A, "Jeddah", IBAN_A]);
      const pending = pendingOf(r.body);
      expect(pending.map((p) => [p.kind, p.vendorId, p.ibanBefore, p.ibanAfter, p.status, p.requestedBy])).toEqual([
        ["vendor_iban", v, IBAN_A, IBAN_B, "pending", ids.pairA],
      ]);
      requestId = pending[0]!.id;
      const list = await h.api("pairB", "GET", CHANGES);
      expect(list.status).toBe(200);
      const mine = (list.body.items as any[]).find((x) => x.id === requestId);
      expect([mine?.status, mine?.subjectName, mine?.requestedByName]).toEqual(["pending", "R6 Pair Supplier", "r6dual pairA"]);
    });

    it("🔴 a second change of the same supplier while one waits is refused (409) — and nothing in that request is written", async () => {
      const r = await h.api("pairB", "PATCH", `/vendors/${v}`, { iban: IBAN_C, city: "Dammam" });
      expect([r.status, r.body?.code]).toEqual([409, "bank_detail_change_pending"]);
      const row = (await pool.query(`SELECT iban, city FROM vendors WHERE id = $1`, [v])).rows[0];
      expect([row.iban, row.city]).toEqual([IBAN_A, "Jeddah"]);
    });

    it("🔴 the REQUESTER cannot approve their own change (409); the stored IBAN stays", async () => {
      const r = await decide("pairA", requestId, "approve");
      expect([r.status, r.body?.code]).toEqual([409, "second_admin_required"]);
      expect(await storedIban(v)).toBe(IBAN_A);
    });

    it("🔴 a bookkeeper cannot approve (the seeded matrix: company writes are admin-only)", async () => {
      const r = await decide("pairBk", requestId, "approve");
      expect(r.status).toBe(403);
      expect(await storedIban(v)).toBe(IBAN_A);
    });

    it("🔴 a SECOND admin approves: the IBAN is written, with its audit record naming the approver, and the request is approved", async () => {
      const r = await decide("pairB", requestId, "approve");
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect([r.body.status, r.body.decidedBy, r.body.decidedByName]).toEqual(["approved", ids.pairB, "r6dual pairB"]);
      expect(await storedIban(v)).toBe(IBAN_B);
      const audit = (await pool.query(
        `SELECT user_id, before_state->>'iban' AS b, after_state->>'iban' AS a FROM audit_logs
          WHERE organization_id = $1 AND entity_type = 'vendor' AND entity_id = $2 AND action = 'update'
            AND before_state->>'iban' IS DISTINCT FROM after_state->>'iban'`, [orgs.pair, String(v)],
      )).rows;
      expect(audit.map((x) => [x.user_id, x.b, x.a])).toEqual([[ids.pairB, IBAN_A, IBAN_B]]);
    });

    it("🔴 a decided request is final: approving or rejecting it again is refused (409)", async () => {
      for (const act of ["approve", "reject"] as const) {
        const r = await decide("pairA", requestId, act);
        expect([act, r.status, r.body?.code]).toEqual([act, 409, "bank_detail_change_decided"]);
      }
    });

    it("rejection by the other admin, and withdrawal by the requester: nothing is written either way", async () => {
      const first = pendingOf((await h.api("pairA", "PATCH", `/vendors/${v}`, { iban: IBAN_C })).body)[0]!;
      const rej = await decide("pairB", first.id, "reject");
      expect([rej.status, rej.body.status, await storedIban(v)]).toEqual([200, "rejected", IBAN_B]);
      const second = pendingOf((await h.api("pairA", "PATCH", `/vendors/${v}`, { iban: IBAN_D })).body)[0]!;
      const wd = await decide("pairA", second.id, "reject");
      expect([wd.status, wd.body.status, wd.body.decidedBy, await storedIban(v)]).toEqual([200, "rejected", ids.pairA, IBAN_B]);
    });

    it("🔴 STALE: when the stored IBAN no longer equals the request's 'before', the approval is refused (409) and nothing moves", async () => {
      const req = pendingOf((await h.api("pairA", "PATCH", `/vendors/${v}`, { iban: IBAN_C })).body)[0]!;
      // the stored value moved underneath the request (planted as the owner, triggers aside — a fixture, not a product path)
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await c.query("SET LOCAL session_replication_role = replica");
        await c.query(`UPDATE vendors SET iban = $2 WHERE id = $1`, [v, IBAN_D]);
        await c.query("COMMIT");
      } finally { c.release(); }
      const r = await decide("pairB", req.id, "approve");
      expect([r.status, r.body?.code, await storedIban(v)]).toEqual([409, "bank_detail_change_stale", IBAN_D]);
      expect((await pool.query(`SELECT status FROM bank_detail_change_requests WHERE id = $1`, [req.id])).rows[0].status).toBe("pending");
      expect((await decide("pairB", req.id, "reject")).status).toBe(200);
    });

    it("a BOOKKEEPER's change waits too, and either admin applies it", async () => {
      const w = await mkVendor("pairA", "R6 Bookkeeper Supplier", IBAN_A);
      const req = pendingOf((await h.api("pairBk", "PATCH", `/vendors/${w}`, { iban: IBAN_B })).body)[0]!;
      expect([req.kind, req.requestedBy, await storedIban(w)]).toEqual(["vendor_iban", ids.pairBk, IBAN_A]);
      expect((await decide("pairA", req.id, "approve")).status).toBe(200);
      expect(await storedIban(w)).toBe(IBAN_B);
    });

    it("🔴 a company bank account: its IBAN change waits, and becoming the DEFAULT waits — on update and at creation", async () => {
      const first = await mkAccount("pairA", "R6 Main", { iban: IBAN_A });
      // the first default of a company with two admins is a change of the printed details too
      const mkDefault = await h.api("pairA", "PATCH", `/bank-accounts/${first.id}`, { isDefault: true });
      const p0 = pendingOf(mkDefault.body);
      expect([mkDefault.status, (await account(first.id)).is_default, p0.map((p) => p.kind)]).toEqual([200, false, ["default_bank_account"]]);
      expect((await decide("pairB", p0[0]!.id, "approve")).status).toBe(200);
      expect((await account(first.id)).is_default).toBe(true);

      const ibanReq = await h.api("pairA", "PATCH", `/bank-accounts/${first.id}`, { iban: IBAN_B, notes: "moved" });
      const p1 = pendingOf(ibanReq.body);
      expect([ibanReq.status, (await account(first.id)).iban, p1.map((p) => [p.kind, p.ibanBefore, p.ibanAfter])]).toEqual([
        200, IBAN_A, [["bank_account_iban", IBAN_A, IBAN_B]],
      ]);
      expect((await decide("pairB", p1[0]!.id, "approve")).status).toBe(200);
      expect((await account(first.id)).iban).toBe(IBAN_B);

      const second = await mkAccount("pairA", "R6 New", { iban: IBAN_C, isDefault: true });
      const p2 = pendingOf(second);
      expect([second.isDefault, p2.map((p) => [p.kind, p.bankAccountId, p.ibanBefore, p.ibanAfter])]).toEqual([
        false, [["default_bank_account", second.id, IBAN_B, IBAN_C]],
      ]);
      expect([(await account(first.id)).is_default, (await account(second.id)).is_default]).toEqual([true, false]);
      expect((await decide("pairB", p2[0]!.id, "approve")).status).toBe(200);
      expect([(await account(first.id)).is_default, (await account(second.id)).is_default]).toEqual([false, true]);
    });

    it("🔴 THE WRITE BOUNDARY: a direct UPDATE of a supplier's IBAN as the app role is refused with two usable admins — and applies with one", async () => {
      const w = await mkVendor("pairA", "R6 Direct Supplier", IBAN_A);
      const outcome = await h.inTenant(orgs.pair!, cos.pair!, ids.pairA, () =>
        db.update(vendorsTable).set({ iban: IBAN_B }).where(eq(vendorsTable.id, w)),
      ).then(() => "accepted", (e: any) => `refused:${e.constraint ?? e.cause?.constraint}`);
      expect(outcome).toBe("refused:bank_detail_dual_control");
      expect(await storedIban(w)).toBe(IBAN_A);
      const s = await mkVendor("solo", "R6 Direct Solo Supplier", IBAN_A);
      await h.inTenant(orgs.solo!, cos.solo!, ids.solo, () => db.update(vendorsTable).set({ iban: IBAN_B }).where(eq(vendorsTable.id, s)));
      expect(await storedIban(s)).toBe(IBAN_B);
    });
  });

  it("🔴 ISOLATION: each organisation lists only its own requests, each has one, and another's request cannot be decided", async () => {
    const ov = await mkVendor("othA", "R6 Other Supplier", IBAN_A);
    const theirs = pendingOf((await h.api("othA", "PATCH", `/vendors/${ov}`, { iban: IBAN_C })).body)[0]!;
    expect(theirs?.status).toBe("pending");
    const pv = await mkVendor("pairA", "R6 Pair Iso Supplier", IBAN_A);
    const ours = pendingOf((await h.api("pairA", "PATCH", `/vendors/${pv}`, { iban: IBAN_D })).body)[0]!;
    const pairIds = ((await h.api("pairB", "GET", CHANGES)).body.items as any[]).map((x) => x.id);
    const otherIds = ((await h.api("othB", "GET", CHANGES)).body.items as any[]).map((x) => x.id);
    expect([pairIds.includes(ours.id), pairIds.includes(theirs.id), otherIds.includes(theirs.id), otherIds.includes(ours.id)]).toEqual([true, false, true, false]);
    const cross = await decide("pairB", theirs.id, "approve");
    expect(cross.status).toBe(404);
    expect(await storedIban(ov)).toBe(IBAN_A);
  });
});
