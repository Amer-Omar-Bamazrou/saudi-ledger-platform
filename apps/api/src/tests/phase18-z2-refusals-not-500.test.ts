/**
 * 🔴 Phase 18 final round (owner, 2026-11-04): "POST /api/supplier-payments with no or a non-numeric supplier id answers
 * 422, not 500." and "Sign-in with a NUL character in the email answers 400 or 401, not 500." Register §11.134.
 *
 * Each case is measured over real HTTP. The sweep cases are the same shapes on sibling paths: an id read with a bare
 * `Number()`, and an email used as a database lookup key. Postgres refuses a NUL in text and "NaN" for an integer, and
 * a refusal the caller's input caused is the caller's 4xx, never our 500. DB-backed (sl_test / CI).
 */
process.env.PORT ??= "3219";
process.env.SESSION_SECRET ??= "z2-refusals-not-500-0000000000000001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "Z2RefusalsNot500Pw1!";

describeMaybe("the caller's bad input is refused, never a 500", () => {
  const h = g04Harness("z2ref");
  let vendorId = 0;
  let bankId = 0;
  let orgId = "";

  const paymentCount = async () =>
    (await pool.query(`SELECT count(*)::int AS n FROM supplier_payments WHERE organization_id = $1`, [orgId])).rows[0].n as number;

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("main");
    await h.mkCompany(orgId, "Z2 Co", "300000000000003");
    await h.mkUser("admin", PW, orgId, "admin");
    const operatorId = await h.mkUser("operator", PW, null);
    await pool.query(`INSERT INTO platform_operators (user_id, granted_by) VALUES ($1, $1)`, [operatorId]);
    await h.start();
    expect(await h.login("admin", h.email("admin"), PW)).toBe(200);
    expect(await h.login("operator", h.email("operator"), PW)).toBe(200);
    const vendor = await h.api("admin", "POST", "/vendors", { name: "Z2 Supplier", residency: "resident" });
    expect(vendor.status, JSON.stringify(vendor.body)).toBe(201);
    vendorId = vendor.body.id;
    const bank = await h.api("admin", "POST", "/bank-accounts", { name: "Z2 Bank", bankName: "SNB", currency: "SAR" });
    expect(bank.status, JSON.stringify(bank.body)).toBe(201);
    bankId = bank.body.id;
  }, 120_000);

  afterAll(async () => {
    await h.stop();
    await h.cleanup();
  });

  describe("POST /supplier-payments: the supplier id", () => {
    const body = (vendor: Record<string, unknown>) => ({ ...vendor, bankAccountId: bankId, amount: 100, paidAt: "2026-06-12", classification: "unknown" });

    it.each([
      ["missing", {}],
      ["null", { vendorId: null }],
      ["non-numeric text", { vendorId: "abc" }],
      ["empty text", { vendorId: "" }],
      ["a fraction", { vendorId: 1.5 }],
      ["negative", { vendorId: -1 }],
      ["past an integer column", { vendorId: 1e20 }],
      ["an object", { vendorId: {} }],
      ["unknown", { vendorId: 2_147_483_647 }],
    ])("🔴 %s: 422 vendor_unknown, naming the field, and nothing is written", async (_name, vendor) => {
      const before = await paymentCount();
      const r = await h.api("admin", "POST", "/supplier-payments", body(vendor));
      expect(r.status, JSON.stringify(r.body)).toBe(422);
      expect([r.body.code, r.body.field]).toEqual(["vendor_unknown", "vendorId"]);
      expect(await paymentCount()).toBe(before);
    });

    it("🔴 the same request naming a real supplier is accepted (the refusal is about the id, not the request)", async () => {
      const before = await paymentCount();
      const r = await h.api("admin", "POST", "/supplier-payments", body({ vendorId }));
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(await paymentCount()).toBe(before + 1);
    });

    it("sweep: a non-numeric bank account or bill on the same request is refused too", async () => {
      const bank = await h.api("admin", "POST", "/supplier-payments", { ...body({ vendorId }), bankAccountId: "abc" });
      expect(bank.status, JSON.stringify(bank.body)).toBe(422);
      const bill = await h.api("admin", "POST", "/supplier-payments", { ...body({ vendorId }), classification: "advance", allocations: [{ billId: "abc", amount: 10 }] });
      expect(bill.status, JSON.stringify(bill.body)).toBe(422);
    });

    it("sweep: a bill naming a non-numeric supplier is refused too", async () => {
      const r = await h.api("admin", "POST", "/bills", { vendorId: "abc", billNumber: "Z2-BILL-1", issueDate: "2026-06-12", dueDate: "2026-07-12", lines: [{ description: "x", quantity: 1, unitPrice: 10, vatRate: 15 }] });
      expect(r.status, JSON.stringify(r.body)).toBeGreaterThanOrEqual(400);
      expect(r.status, JSON.stringify(r.body)).toBeLessThan(500);
    });
  });

  describe("a NUL in an email used as a lookup key", () => {
    const expectRefused = (r: { status: number; body: unknown }, allowed: number[]) =>
      expect(allowed, `${r.status} ${JSON.stringify(r.body)}`).toContain(r.status);

    it("🔴 sign-in: an email with a NUL answers 400 or 401", async () => {
      expectRefused(await h.api("nul", "POST", "/auth/login", { email: "z2ref-nobody\u0000@test.local", password: PW }), [400, 401]);
    });

    it("🔴 sign-in: a real account's email with a NUL added does not sign in", async () => {
      const r = await h.api("nul2", "POST", "/auth/login", { email: `${h.email("admin")}\u0000`, password: PW });
      expectRefused(r, [400, 401]);
      expect((await h.api("nul2", "GET", "/auth/me")).status).toBe(401);
    });

    it("🔴 sign-in: the same account with its real email still signs in", async () => {
      expect(await h.login("again", h.email("admin"), PW)).toBe(200);
    });

    it("sweep: sign-up with a NUL in the email answers 400", async () => {
      const r = await h.api("nul3", "POST", "/auth/signup", {
        email: "z2ref-new\u0000@test.local", name: "Z2 New", password: PW, organizationName: "Z2 New Org", crNumber: "1010404041", vatNumber: "300000000000003",
      });
      expectRefused(r, [400]);
    });

    it("sweep: the operator's password reset with a NUL in the email answers 400", async () => {
      expectRefused(await h.api("operator", "POST", "/operator/users/reset-password", { email: "z2ref-admin\u0000@test.local" }), [400]);
    });

    it("sweep: an administrator adding an account with a NUL in the email answers 400", async () => {
      const r = await h.api("admin", "POST", "/auth/register", { email: "z2ref-reg\u0000@test.local", name: "Z2 Reg", password: PW, organizationId: orgId });
      expectRefused(r, [400]);
    });

    it("sweep: a member invited with a NUL in the email answers 400", async () => {
      const r = await h.api("admin", "POST", `/orgs/${orgId}/invitations`, { email: "z2ref-inv\u0000@test.local", role: "viewer" });
      expectRefused(r, [400]);
    });
  });
});
