/**
 * 🔴 Phase 18 G4b — WHT: owner decisions 17 (the refund-claim record) and 18
 * (the instalment-request record) (register §11.30; final-run memo §2 G;
 * scoped D-4 statement register §11.43, appended before this file). Each
 * DECIDED 2026-10-27: an owner decision based on research, not a professional
 * opinion; reversible; to be reviewed before go-live. Records only: nothing
 * here posts, refunds, offsets, reverses or waives anything.
 *
 *  - 17: an over-withheld amount is pursued by a REFUND-CLAIM record with an
 *    evidence checklist and a five-year clock from the overpaid tax year
 *    (Law Art. 65(c); shown as 31 December of that year + 5 — a reasoned
 *    reading); its life is append-only events (submitted, refunded, refused).
 *  - 18: an instalment plan under Resolution 1117 is a REQUEST record for WHT
 *    months whose returns were due before 1 July 2026; it counts only once
 *    ZATCA's WRITTEN acceptance is recorded; Regulations Art. 65(1)(c) is noted.
 *
 * Acts over HTTP. DB-backed (sl_test / CI); skips on the DB-free placeholder.
 */
process.env.PORT ??= "3250";
process.env.SESSION_SECRET ??= "phase18-wht-g4b-claims-0001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "Phase18WhtG4bPw1!";

describeMaybe("Phase 18 G4b — the WHT refund-claim and instalment-request records (decisions 17, 18)", () => {
  const h = g04Harness("p18whtg4b");
  let orgId = "", companyId = "", userId = 0, vendorId = 0;
  const CHECKLIST = {
    contractAndInvoice: { held: true, note: "Agreement LA-7 and invoice 2026-031" },
    correctCategoryAndRate: { held: true, note: "Technical services at 5 %, not royalty at 15 %" },
    originalStatementAndReceipt: { held: true, note: "Form 06 for 2026-03 and SADAD receipt" },
    reconciliation: { held: false, note: "" },
    whoBoreTheExcess: { held: true, note: "Withheld from the supplier" },
    beneficiaryAuthorisation: { held: false, note: "Requested from the supplier" },
  };
  const claim = (body: Record<string, unknown>) => h.api("admin", "POST", "/tax/wht/refund-claims", {
    period: "2026-03", vendorId, overpaidTaxYear: 2026, excessAmount: 1_000, borneBy: "beneficiary",
    reason: "Technical services withheld at the royalty rate", checklist: CHECKLIST, ...body,
  });

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    companyId = (await pool.query(`INSERT INTO companies (organization_id, name, fiscal_year_start, fiscal_calendar, vat_number, cr_number, ownership_type) VALUES ($1,'G4b Co',1,'gregorian','399999999999993','1010303031','SAUDI_GCC') RETURNING id`, [orgId])).rows[0].id;
    userId = await h.mkUser("admin", PW, orgId, "admin");
    await h.start();
    expect(await h.login("admin", h.email("admin"), PW), "login admin").toBe(200);
    const v = await h.api("admin", "POST", "/vendors", { name: "G4b London Advisory", residency: "non_resident", whtDefaultPaymentType: "technical_consulting", country: "GB" });
    expect(v.status, JSON.stringify(v.body)).toBe(201);
    vendorId = v.body.id;
  }, 120_000);

  afterAll(async () => { await h.stop(); await h.cleanup(); });

  // ── decision 17 ───────────────────────────────────────────────────────────

  it("🔴 17: an over-withheld amount is recorded as a REFUND CLAIM — the checklist kept item by item, the five-year clock shown — and nothing posts", async () => {
    const before = (await pool.query(`SELECT count(*)::int n FROM journal_entries WHERE organization_id = $1`, [orgId])).rows[0].n;
    const r = await claim({});
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ period: "2026-03", vendorId, overpaidTaxYear: 2026, excessAmount: 1_000, borneBy: "beneficiary", deadline: "2031-12-31", state: "open", evidenceHeld: 4, evidenceItems: 6 });
    expect(r.body.checklist.reconciliation).toEqual({ held: false, note: "" });
    expect((await pool.query(`SELECT count(*)::int n FROM journal_entries WHERE organization_id = $1`, [orgId])).rows[0].n).toBe(before);
  });

  it("🔴 17: the claim's life is EVENTS — submitted, then refunded — and the record keeps every step", async () => {
    const c = (await claim({ period: "2026-04", excessAmount: 600 })).body;
    const sub = await h.api("admin", "POST", `/tax/wht/refund-claims/${c.id}/events`, { kind: "submitted", onDate: "2026-10-05", reference: "ZATCA-RF-11" });
    const ref = await h.api("admin", "POST", `/tax/wht/refund-claims/${c.id}/events`, { kind: "refunded", onDate: "2026-10-20", amount: 600 });
    expect([sub.status, ref.status], JSON.stringify([sub.body, ref.body])).toEqual([201, 201]);
    expect(ref.body).toMatchObject({ state: "refunded", events: [{ kind: "submitted", reference: "ZATCA-RF-11" }, { kind: "refunded", amount: 600 }] });
  });

  it("🔴 17: refusals are named — an unknown supplier, a zero excess, an unknown checklist item, an event out of order", async () => {
    const got: Array<[number, string]> = [];
    for (const body of [{ vendorId: 999_999 }, { excessAmount: 0 }, { checklist: { ...CHECKLIST, aRumour: { held: true, note: "" } } }]) {
      const r = await claim(body); got.push([r.status, r.body.code]);
    }
    const c = (await claim({ period: "2026-05", excessAmount: 50 })).body;
    const early = await h.api("admin", "POST", `/tax/wht/refund-claims/${c.id}/events`, { kind: "refunded", onDate: "2026-10-20", amount: 50 });
    got.push([early.status, early.body.code]);
    expect(got).toEqual([[422, "reference_not_found"], [422, "wht_refund_excess_invalid"], [400, "wht_refund_checklist_invalid"], [409, "wht_refund_claim_not_submitted"]]);
  });

  // ── decision 18 ───────────────────────────────────────────────────────────

  it("🔴 18: an instalment request covers WHT months due before 1 July 2026 only; it COUNTS only once ZATCA's written acceptance is recorded; Art. 65(1)(c) is noted", async () => {
    const late = await h.api("admin", "POST", "/tax/wht/instalment-requests", { periodFrom: "2026-05", periodTo: "2026-06", principal: 5_000, requestedOn: "2026-10-10", reference: "REQ-1" });
    expect([late.status, late.body.code]).toEqual([422, "wht_instalment_month_ineligible"]);
    const r = await h.api("admin", "POST", "/tax/wht/instalment-requests", { periodFrom: "2026-03", periodTo: "2026-05", principal: 5_000, requestedOn: "2026-10-10", reference: "REQ-2" });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect([r.body.state, r.body.counts]).toEqual(["requested", false]);
    expect(String(r.body.note)).toMatch(/65\(1\)\(c\)/);
    const acc = await h.api("admin", "POST", `/tax/wht/instalment-requests/${r.body.id}/events`, { kind: "accepted", onDate: "2026-10-25", reference: "ZATCA-ACC-9" });
    expect(acc.status, JSON.stringify(acc.body)).toBe(201);
    expect([acc.body.state, acc.body.counts, acc.body.acceptance]).toEqual(["accepted", true, { onDate: "2026-10-25", reference: "ZATCA-ACC-9" }]);
  });

  it("🔴 both records are APPEND-ONLY for the request's role", async () => {
    const tryAs = async (stmt: ReturnType<typeof sql>) => {
      try { await h.inTenant(orgId, companyId, userId, () => db.execute(stmt)); return "ok"; } catch (e) { const err = e as Error & { cause?: Error }; return `${err.message} | ${err.cause?.message ?? ""}`; }
    };
    expect(await tryAs(sql`UPDATE wht_refund_claims SET excess_amount = 1`)).toMatch(/permission denied/);
    expect(await tryAs(sql`DELETE FROM wht_instalment_requests`)).toMatch(/permission denied/);
  });
});
