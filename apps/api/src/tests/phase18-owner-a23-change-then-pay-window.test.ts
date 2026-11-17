/**
 * 🔴 Phase 18 owner decision A23 (2026-11-16) — the change-then-pay finding reads BOTH the payment's date and its
 * recording time.
 *
 * DR-21's finding (control DR-19's first slot) lists a payment to a supplier made soon after that supplier's IBAN changed. It compared business
 * dates only, so a payment RECORDED after the change but DATED before it (back-dated) was never listed — the audit's
 * A23. The owner's rule: the payment is listed when EITHER falls inside the window after the change.
 *
 * The window, exactly (N = the company's `bankChangePaymentWindowDays`):
 *   - the change is an instant T (its audit row's time, set by the database since 0159) with business date
 *     D = businessDate(T) through the Asia/Riyadh seam;
 *   - by DATE:      D ≤ the payment's date ≤ D + N calendar days, both ends inclusive (unchanged);
 *   - by RECORDING: T ≤ the payment row's recording instant ≤ T + N × 24 h, both ends inclusive.
 * Each item names which matched (`date`, `recorded`, `both`) and the recording instant.
 *
 * Boundaries planted (owner, replica mode — the one way to give an audit row a past time): the recording edge one
 * minute either side of T + N days; the date edge at D + N and D + N + 1; a back-dated payment; a payment recorded
 * before the change. DB-backed (sl_test / CI).
 */
process.env.PORT ??= "3391";
process.env.SESSION_SECRET ??= "phase18-owner-a23-change-then-pay-001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { businessDate, businessDateShift, businessToday } from "@workspace/shared";
import { g04Harness } from "./helpers/g04Harness";
import { replica } from "./helpers/replica";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "OwnerA23ChangeThenPayPw1!";
const IBAN_A = "SA0380000000608010167519";
const IBAN_B = "SA4420000001234567891234";
const N = 7;
const SETTINGS = "/companies/current/control-settings";
const FINDING = "/companies/current/control-findings/payment-after-bank-change";
type Item = { vendorId: number; paidAt: string; changedOn: string; matchedBy?: string; recordedAt?: string };

describeMaybe("Phase 18 owner decision A23 — a payment is listed when its date OR its recording time falls in the window after the change", () => {
  const h = g04Harness("owna23");
  const today = businessToday();
  let orgId = "", bankId = 0, seq = 0;
  const v: Record<string, number> = {};
  const d: Record<string, string> = {}; // each planted change's business date D

  const ok = async (method: string, path: string, body?: unknown) => {
    const r = await h.api("admin", method, path, body);
    expect(r.status, `${method} ${path}: ${JSON.stringify(r.body)}`).toBeLessThan(300);
    return r.body;
  };
  const vendor = async (key: string) => (v[key] = (await ok("POST", "/vendors", { name: `A23 ${key}`, residency: "resident", iban: IBAN_A })).id);
  const pay = async (vendorId: number, paidAt: string) => {
    seq += 1;
    const b = await ok("POST", "/bills", { supplierDocumentKind: "tax_invoice", vendorReference: `A23-R-${seq}`, billNumber: `A23-${seq}`, date: paidAt, dueDate: paidAt, vendorId,
      items: [{ description: "Supplies", quantity: 1, unitPrice: 100 + seq, vatRate: 0 }] });
    await ok("POST", `/bills/${b.id}/approve`, {});
    await ok("POST", `/bills/${b.id}/pay`, { amount: 100 + seq, paidAt, bankAccountId: bankId });
  };
  /** An IBAN change recorded at an exact past instant (owner, replica mode); returns its business date D. */
  const plantChange = async (vendorId: number, ageSql: string) => {
    const ms = Number((await replica(pool as never).query(
      `INSERT INTO audit_logs (organization_id, action, entity_type, entity_id, before_state, after_state, created_at)
       VALUES ($1, 'update', 'vendor', $2, $3::jsonb, $4::jsonb, (now() - (${ageSql}))::timestamp)
       RETURNING (extract(epoch from created_at::timestamptz) * 1000)::bigint AS ms`,
      [orgId, String(vendorId), JSON.stringify({ iban: IBAN_A }), JSON.stringify({ iban: IBAN_B })])).rows[0]!.ms);
    return businessDate(new Date(ms));
  };
  const items = async () => {
    const r = await h.api("admin", "GET", FINDING);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return (r.body.items as Item[]);
  };
  const of = (list: Item[], key: string) => list.filter((i) => i.vendorId === v[key]);

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    await pool.query(`INSERT INTO companies (organization_id, name, fiscal_year_start, fiscal_calendar, vat_number, cr_number, ownership_type) VALUES ($1,'A23 Co',1,'gregorian','399999999999993','1010303031','SAUDI_GCC')`, [orgId]);
    await h.mkUser("admin", PW, orgId, "admin");
    await h.start();
    expect(await h.login("admin", h.email("admin"), PW)).toBe(200);
    bankId = (await ok("POST", "/bank-accounts", { name: "A23 Bank", bankName: "SNB", currency: "SAR" })).id;
    await ok("PUT", SETTINGS, { bankChangePaymentWindowDays: N });
    for (const k of ["backdated", "recInside", "recOutside", "dateEdge", "before"]) await vendor(k);

    // a payment recorded BEFORE the change, dated the day before it: neither rule — then the change, through the product
    await pay(v.before!, businessDateShift(today, -1));
    await ok("PATCH", `/vendors/${v.before}`, { iban: IBAN_B });

    // back-dated: the change now (through the product), the payment recorded after it but dated 40 days earlier —
    // before every change of the company, so only the recording time can bring it in (the repository's filter too)
    await ok("PATCH", `/vendors/${v.backdated}`, { iban: IBAN_B });
    await pay(v.backdated!, businessDateShift(today, -40));

    // the recording edge: changes N days less / more one minute ago; payments recorded now, dated 3 days before D
    d.recInside = await plantChange(v.recInside!, `interval '${N} days' - interval '1 minute'`);
    await pay(v.recInside!, businessDateShift(d.recInside, -3));
    d.recOutside = await plantChange(v.recOutside!, `interval '${N} days' + interval '1 minute'`);
    await pay(v.recOutside!, businessDateShift(d.recOutside, -3));

    // the date edge: a change 30 days ago (its recording window long past); payments dated D + N and D + N + 1
    d.dateEdge = await plantChange(v.dateEdge!, `interval '30 days'`);
    await pay(v.dateEdge!, businessDateShift(d.dateEdge, N));
    await pay(v.dateEdge!, businessDateShift(d.dateEdge, N + 1));
  }, 180_000);

  afterAll(async () => { await h.stop(); await h.cleanup(); });

  it("🔴 a BACK-DATED payment (recorded after the change, dated before it) is listed, matched by its recording time", async () => {
    const mine = of(await items(), "backdated");
    expect(mine.map((i) => [i.paidAt, i.matchedBy])).toEqual([[businessDateShift(today, -40), "recorded"]]);
    expect(typeof mine[0]?.recordedAt, "the recording instant is named").toBe("string");
  });

  it("🔴 the recording edge, inside: recorded N days less one minute after the change — listed", async () => {
    expect(of(await items(), "recInside").map((i) => [i.paidAt, i.changedOn, i.matchedBy])).toEqual([[businessDateShift(d.recInside!, -3), d.recInside, "recorded"]]);
  });

  it("the recording edge, outside: recorded N days and one minute after the change, and dated before it — not listed", async () => {
    expect(of(await items(), "recOutside")).toEqual([]);
  });

  it("the date edge: dated D + N is listed (by date; the end is inclusive); dated D + N + 1 is not", async () => {
    expect(of(await items(), "dateEdge").map((i) => [i.paidAt, i.matchedBy])).toEqual([[businessDateShift(d.dateEdge!, N), "date"]]);
  });

  it("absence: a payment recorded before the change and dated before it is not listed", async () => {
    expect(of(await items(), "before")).toEqual([]);
  });
});
