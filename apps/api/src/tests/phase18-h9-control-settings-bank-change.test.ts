/**
 * 🔴 Phase 18 H-9 — DR-19 (a typed control-settings table), DR-21 (threshold
 * slots EMPTY and DISABLED by default; no default numbers ship) and DR-23's
 * finding ("a payment within N days of a bank-detail change"). Each DECIDED
 * 2026-10-27 — owner accepted the stated recommendation (register §11.56, the
 * scoped D-4 statement, appended before this file).
 *
 * Acts over HTTP. DB-backed (sl_test / CI); skips on the DB-free placeholder.
 */
process.env.PORT ??= "3259";
process.env.SESSION_SECRET ??= "phase18-h9-control-settings-0001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { businessToday } from "@workspace/shared";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "Phase18H9CtlPw1!";
const IBAN_A = "SA0380000000608010167519";
const IBAN_B = "SA4420000001234567891234";
const SETTINGS = "/companies/current/control-settings";
const FINDING = "/companies/current/control-findings/payment-after-bank-change";

describeMaybe("Phase 18 H-9 — the control-settings table; an empty slot; payments soon after a bank-detail change", () => {
  const h = g04Harness("p18h9ctl");
  const today = businessToday();
  let orgId = "", bankId = 0, changed = 0, steady = 0, seq = 0;
  const pay = async (vendorId: number, amount: number, paidAt: string) => {
    seq += 1;
    const b = await h.api("admin", "POST", "/bills", { supplierDocumentKind: "tax_invoice", vendorReference: `H9-R-${seq}`, billNumber: `H9-${seq}`, date: paidAt, dueDate: paidAt, vendorId,
      items: [{ description: "Supplies", quantity: 1, unitPrice: amount, vatRate: 0 }] });
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    expect((await h.api("admin", "POST", `/bills/${b.body.id}/approve`, {})).status).toBe(200);
    const p = await h.api("admin", "POST", `/bills/${b.body.id}/pay`, { amount, paidAt, bankAccountId: bankId });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    return b.body.id as number;
  };
  const finding = async () => {
    const r = await h.api("admin", "GET", FINDING);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body as { enabled: boolean; windowDays: number | null; items: Array<{ kind: string; vendorId: number; amount: number; paidAt: string; changedOn: string }> };
  };

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    await pool.query(`INSERT INTO companies (organization_id, name, fiscal_year_start, fiscal_calendar, vat_number, cr_number, ownership_type) VALUES ($1,'H9 Co',1,'gregorian','399999999999993','1010303031','SAUDI_GCC')`, [orgId]);
    await h.mkUser("admin", PW, orgId, "admin");
    await h.mkUser("bookkeeper", PW, orgId, "bookkeeper");
    await h.start();
    for (const who of ["admin", "bookkeeper"]) expect(await h.login(who, h.email(who), PW), `login ${who}`).toBe(200);
    bankId = (await h.api("admin", "POST", "/bank-accounts", { name: "Ops", bankName: "SNB", currency: "SAR" })).body.id;
    changed = (await h.api("admin", "POST", "/vendors", { name: "H9 Changed Supplier", residency: "resident", iban: IBAN_A })).body.id;
    steady = (await h.api("admin", "POST", "/vendors", { name: "H9 Steady Supplier", residency: "resident", iban: IBAN_A })).body.id;
    // the change, through the product: today
    expect((await h.api("admin", "PATCH", `/vendors/${changed}`, { iban: IBAN_B })).status).toBe(200);
    await pay(changed, 1_000, today); // on the day of the change
    await pay(steady, 2_000, today); // a supplier whose bank details did not change
  }, 120_000);

  afterAll(async () => { await h.stop(); await h.cleanup(); });

  it("🔴 DR-21: the slot ships EMPTY — no number — and the finding says it is disabled, listing nothing", async () => {
    const s = await h.api("admin", "GET", SETTINGS);
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    expect(s.body.bankChangePaymentWindowDays).toBeNull();
    expect(await finding()).toEqual({ enabled: false, windowDays: null, items: [] });
  });

  it("🔴 an admin sets the window; a bookkeeper cannot; a value outside 1–365 is refused", async () => {
    expect((await h.api("bookkeeper", "PUT", SETTINGS, { bankChangePaymentWindowDays: 7 })).status).toBe(403);
    expect((await h.api("admin", "PUT", SETTINGS, { bankChangePaymentWindowDays: 0 })).status).toBe(400);
    expect((await h.api("admin", "PUT", SETTINGS, { bankChangePaymentWindowDays: 366 })).status).toBe(400);
    const ok = await h.api("admin", "PUT", SETTINGS, { bankChangePaymentWindowDays: 7 });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.bankChangePaymentWindowDays).toBe(7);
  });

  it("🔴 DR-23: with the window set, a payment within N days AFTER a supplier's IBAN changed is found — not a steady supplier's", async () => {
    const f = await finding();
    expect([f.enabled, f.windowDays]).toEqual([true, 7]);
    expect(f.items.map((i) => [i.vendorId, i.amount, i.paidAt, i.changedOn])).toEqual([[changed, 1_000, today, today]]);
  });

  // Added after the proof commit (812858ce): its red is shown by the mutant that drops "before IBAN ≠ after IBAN" (mutants/, H-9).
  it("🔴 a supplier update that leaves the IBAN as it was is not a change — the steady supplier's payment stays off the list", async () => {
    expect((await h.api("admin", "PATCH", `/vendors/${steady}`, { name: "H9 Steady Supplier (renamed)" })).status).toBe(200);
    const f = await finding();
    expect(f.items.some((i) => i.vendorId === changed), "the changed supplier is still listed").toBe(true);
    expect(f.items.filter((i) => i.vendorId === steady)).toEqual([]);
  });

  it("🔴 the window's bound: a change 20 days ago — a payment 2 days after it is found, one 10 days after is not", async () => {
    const d = (n: number) => { const x = new Date(`${today}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
    const old = (await h.api("admin", "POST", "/vendors", { name: "H9 Old Change", residency: "resident", iban: IBAN_B })).body.id as number;
    // an IBAN change recorded 20 days ago (planted in the append-only audit trail, as the product would have written it)
    await pool.query(
      `INSERT INTO audit_logs (organization_id, action, entity_type, entity_id, before_state, after_state, created_at)
       VALUES ($1, 'update', 'vendor', $2, $3::jsonb, $4::jsonb, ($5::date + time '09:00') AT TIME ZONE 'Asia/Riyadh')`,
      [orgId, String(old), JSON.stringify({ iban: IBAN_A }), JSON.stringify({ iban: IBAN_B }), d(-20)]);
    await pay(old, 300, d(-18)); // 2 days after: inside 7
    await pay(old, 400, d(-10)); // 10 days after: outside 7
    const f = await finding();
    const mine = f.items.filter((i) => i.vendorId === old).map((i) => [i.amount, i.paidAt, i.changedOn]);
    expect(mine).toEqual([[300, d(-18), d(-20)]]);
  });

  // Added after the proof commit (812858ce): its red is shown by the mutant that measures a payment from the supplier's
  // LATEST change instead of the change it follows (mutants/, H-9, M7 — which survived the proof without this case).
  it("🔴 two changes: each payment is measured from the change it FOLLOWS, not from the latest one", async () => {
    const d = (n: number) => { const x = new Date(`${today}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
    const twice = (await h.api("admin", "POST", "/vendors", { name: "H9 Twice Changed", residency: "resident", iban: IBAN_A })).body.id as number;
    for (const [day, from, to] of [[d(-30), IBAN_A, IBAN_B], [d(-15), IBAN_B, IBAN_A]]) {
      await pool.query(
        `INSERT INTO audit_logs (organization_id, action, entity_type, entity_id, before_state, after_state, created_at)
         VALUES ($1, 'update', 'vendor', $2, $3::jsonb, $4::jsonb, ($5::date + time '09:00') AT TIME ZONE 'Asia/Riyadh')`,
        [orgId, String(twice), JSON.stringify({ iban: from }), JSON.stringify({ iban: to }), day]);
    }
    await pay(twice, 600, d(-28)); // 2 days after the first change: found, against it
    await pay(twice, 700, d(-20)); // 10 days after the first, before the second: not found
    await pay(twice, 800, d(-14)); // 1 day after the second: found, against it
    const mine = (await finding()).items.filter((i) => i.vendorId === twice).map((i) => [i.amount, i.paidAt, i.changedOn]);
    expect(mine).toEqual([[800, d(-14), d(-15)], [600, d(-28), d(-30)]]);
  });

  // Added after the proof commit (812858ce), for §11.56's "it covers bill payments and supplier payments":
  // its red is shown by the mutant that drops the supplier-payment read (mutants/, H-9).
  it("🔴 a SUPPLIER payment soon after the change is found as well as a bill payment", async () => {
    const sp = await h.api("admin", "POST", "/supplier-payments", { vendorId: changed, bankAccountId: bankId, amount: 500, paidAt: today, classification: "unknown" });
    expect(sp.status, JSON.stringify(sp.body)).toBe(201);
    const mine = (await finding()).items.filter((i) => i.vendorId === changed).map((i) => [i.kind, i.amount, i.paidAt, i.changedOn]);
    expect(mine).toEqual([["bill_payment", 1_000, today, today], ["supplier_payment", 500, today, today]]);
  });

  it("🔴 cleared again, the slot is empty and the finding disabled — and every change of the setting is recorded", async () => {
    expect((await h.api("admin", "PUT", SETTINGS, { bankChangePaymentWindowDays: null })).status).toBe(200);
    expect((await finding()).enabled).toBe(false);
    const recs = (await pool.query(
      `SELECT before_state->>'bankChangePaymentWindowDays' AS b, after_state->>'bankChangePaymentWindowDays' AS a FROM audit_logs
        WHERE organization_id = $1 AND entity_type = 'company_control_settings' ORDER BY created_at`, [orgId])).rows;
    expect(recs.map((r) => r.a)).toEqual(["7", null]);
  });
});
