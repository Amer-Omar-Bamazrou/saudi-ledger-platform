/**
 * 🔴 Phase 18 G2a — VAT corrections: owner decisions 9, 10, 11, 12 and A5(a)
 * (register §11.30; final-run memo §2 G; scoped D-4 statement register §11.39).
 * Each DECIDED 2026-10-27: an owner decision based on research, not a
 * professional opinion; reversible; to be reviewed before go-live.
 *
 *  - 9: the SAR 15,000 threshold is measured on the NET tax difference of ALL
 *    the errors of one return (never split); exactly 15,000 needs notification;
 *    errors in more than one return are flagged for review.
 *  - 10: the ACTUAL discovery date is recorded; an earlier "arguably apparent"
 *    date is a separate field.
 *  - 11: at or above the threshold, amend the original return and notify
 *    within 20 days; below it, the return for the period of discovery; where
 *    that return is already filed, the user's choice with a note to obtain
 *    ZATCA's direction. Nothing is automated.
 *  - 12: no Art. 42(2) waiver is automated; Resolution 1117's recorded
 *    conditions are shown for a return due before 1 July 2026.
 *  - A5(a): a document dated in a filed period is ALLOWED, with a warning; the
 *    VAT entries recorded after a filing in its period are listed.
 *
 * Acts over HTTP. DB-backed (sl_test / CI); skips on the DB-free placeholder.
 */
process.env.PORT ??= "3246";
process.env.SESSION_SECRET ??= "phase18-vat-g2a-corrections-0001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "Phase18VatG2aCorrectionsPw1!";

describeMaybe("Phase 18 G2a — VAT corrections (decisions 9–12) and the filed-period warning (A5(a))", () => {
  const h = g04Harness("p18vatg2a");
  let orgId = "", companyId = "", userId = 0, customerId = 0;

  const file = async (periodFrom: string, periodTo: string, filedOn: string, zatcaReference: string) => {
    const r = await h.api("admin", "POST", "/tax/vat-return-filings", { periodFrom, periodTo, filedOn, zatcaReference });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body;
  };
  const correct = (body: Record<string, unknown>) => h.api("admin", "POST", "/tax/vat-corrections", { description: "Output VAT understated on a missed sale", ...body });
  const returnsView = async () => {
    const r = await h.api("admin", "GET", "/tax/vat-corrections");
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body as { items: unknown[]; returns: Array<Record<string, any>> };
  };
  const viewOf = async (ref: string) => (await returnsView()).returns.find((x) => x.zatcaReference === ref);

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    companyId = (await pool.query(
      `INSERT INTO companies (organization_id, name, cr_number, vat_number, fiscal_year_start, building_number, street, district, city, postal_code, additional_number)
       VALUES ($1,'VAT G2a Co','1010868391','310123456789013',1,'1234','King Fahd Road','Al Olaya','Riyadh','12345','6789') RETURNING id`, [orgId])).rows[0].id;
    userId = await h.mkUser("admin", PW, orgId, "admin");
    customerId = (await pool.query(`INSERT INTO customers (organization_id, name) VALUES ($1,'G2a Buyer') RETURNING id`, [orgId])).rows[0].id;
    await h.start();
    expect(await h.login("admin", h.email("admin"), PW), "login admin").toBe(200);
    await file("2026-03", "2026-03", "2026-04-20", "G2A-RET-2026-03");
    await file("2026-05", "2026-05", "2026-06-20", "G2A-RET-2026-05");
    await file("2026-08", "2026-08", "2026-09-25", "G2A-RET-2026-08");
    await file("2026-09", "2026-09", "2026-10-12", "G2A-RET-2026-09");
  }, 120_000);

  afterAll(async () => { await h.stop(); await h.cleanup(); });

  // ── decisions 9, 10, 11 ───────────────────────────────────────────────────

  it("🔴 9/11: errors are AGGREGATED per return — 9,000 + 6,000 = exactly 15,000 needs notification: amend the original and notify within 20 days of the discovery that reached it", async () => {
    const a = await correct({ correctsZatcaReference: "G2A-RET-2026-08", netTaxDifference: 9_000, discoveredOn: "2026-10-01" });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    const after1 = await viewOf("G2A-RET-2026-08");
    expect([after1?.netTaxDifference, after1?.route]).toEqual([9_000, "discovery_period_return"]);
    const b = await correct({ correctsZatcaReference: "G2A-RET-2026-08", netTaxDifference: 6_000, discoveredOn: "2026-10-05" });
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    expect(await viewOf("G2A-RET-2026-08")).toMatchObject({ netTaxDifference: 15_000, route: "amend_and_notify", notifyBy: "2026-10-25", errors: 2 });
  });

  it("🔴 9: the threshold reads the NET difference — +10,000 and −4,000 is 6,000, the small-error route in the period of DISCOVERY (Art. 63(3))", async () => {
    await file("2026-06", "2026-06", "2026-07-20", "G2A-RET-2026-06");
    expect((await correct({ correctsZatcaReference: "G2A-RET-2026-06", netTaxDifference: 10_000, discoveredOn: "2026-10-20" })).status).toBe(201);
    expect((await correct({ correctsZatcaReference: "G2A-RET-2026-06", netTaxDifference: -4_000, discoveredOn: "2026-10-21" })).status).toBe(201);
    expect(await viewOf("G2A-RET-2026-06")).toMatchObject({ netTaxDifference: 6_000, route: "discovery_period_return", discoveryPeriod: "2026-10", discoveryReturnFiled: false });
  });

  it("🔴 11: below the threshold, when the discovery period's return is ALREADY filed, the route is the user's choice — with a note to obtain ZATCA's direction; nothing is automated", async () => {
    expect((await correct({ correctsZatcaReference: "G2A-RET-2026-05", netTaxDifference: 1_200, discoveredOn: "2026-09-14" })).status).toBe(201);
    const v = await viewOf("G2A-RET-2026-05");
    expect(v).toMatchObject({ route: "user_choice", discoveryPeriod: "2026-09", discoveryReturnFiled: true });
    expect(String(v?.routeNote)).toMatch(/ZATCA/);
  });

  it("🔴 10: the ACTUAL discovery date is required and real; an earlier 'arguably apparent' date is kept SEPARATELY — and the refusals are named", async () => {
    const ok = await correct({ correctsZatcaReference: "G2A-RET-2026-03", netTaxDifference: 300, discoveredOn: "2026-09-02", apparentOn: "2026-05-10" });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body).toMatchObject({ discoveredOn: "2026-09-02", apparentOn: "2026-05-10" });
    const got: Array<[number, string]> = [];
    for (const body of [
      { correctsZatcaReference: "G2A-RET-2026-03", netTaxDifference: 300 },
      { correctsZatcaReference: "G2A-RET-2026-03", netTaxDifference: 300, discoveredOn: "2099-01-01" },
      { correctsZatcaReference: "G2A-RET-2026-03", netTaxDifference: 300, discoveredOn: "2026-03-15" },
      { correctsZatcaReference: "G2A-RET-2026-03", netTaxDifference: 300, discoveredOn: "2026-09-02", apparentOn: "2026-09-03" },
      { correctsZatcaReference: "G2A-RET-2026-03", netTaxDifference: 0, discoveredOn: "2026-09-02" },
      { correctsZatcaReference: "NO-SUCH-REF", netTaxDifference: 300, discoveredOn: "2026-09-02" },
    ]) { const r = await correct(body); got.push([r.status, r.body.code]); }
    expect(got).toEqual([
      [400, "discovered_on_required"], [422, "discovered_on_in_future"], [422, "discovered_before_period_end"],
      [422, "apparent_after_discovery"], [422, "net_tax_difference_zero"], [422, "corrected_filing_not_found"],
    ]);
  });

  it("🔴 9: errors in more than one return are flagged for review; a single return is not", async () => {
    const view = await returnsView();
    const flagged = view.returns.filter((x) => x.errors > 0).map((x) => [x.zatcaReference, x.repeatedErrors]);
    expect(flagged.length).toBeGreaterThanOrEqual(2);
    expect(flagged.every(([, r]) => r === true)).toBe(true);
  });

  // ── decision 12 ───────────────────────────────────────────────────────────

  it("🔴 12: no penalty waiver is automated; Resolution 1117's recorded conditions show for a return DUE before 1 July 2026, and not for a later one", async () => {
    const early = await viewOf("G2A-RET-2026-03"); // due 2026-04-30
    const late = await viewOf("G2A-RET-2026-08"); // due 2026-09-30
    expect([early?.penaltyWaiverAutomated, late?.penaltyWaiverAutomated]).toEqual([false, false]);
    expect(early?.resolution1117).toMatchObject({ returnDueOn: "2026-04-30", mayQualify: true, conditionsBy: "2026-12-31" });
    expect(late?.resolution1117).toMatchObject({ returnDueOn: "2026-09-30", mayQualify: false });
  });

  it("🔴 the correction record is APPEND-ONLY for the request's role — an update or a delete is refused by the database", async () => {
    const tryAs = async (stmt: ReturnType<typeof sql>) => {
      // drizzle wraps the database's error ("Failed query: …"); the refusal itself is its cause.
      try { await h.inTenant(orgId, companyId, userId, () => db.execute(stmt)); return "ok"; } catch (e) { const err = e as Error & { cause?: Error }; return `${err.message} | ${err.cause?.message ?? ""}`; }
    };
    expect(await tryAs(sql`UPDATE vat_corrections SET net_tax_difference = 1`)).toMatch(/permission denied/);
    expect(await tryAs(sql`DELETE FROM vat_corrections`)).toMatch(/permission denied/);
  });

  // ── A5(a) ─────────────────────────────────────────────────────────────────

  it("control A5(a): a document dated in a period with no filed return carries no warning", async () => {
    const inv = await h.api("admin", "POST", "/invoices", { customerId, date: "2026-10-03", items: [{ description: "Service", quantity: 1, unitPrice: 100, vatRate: 15 }] });
    expect(inv.status, JSON.stringify(inv.body)).toBe(201);
    expect(inv.body.filedVatPeriod ?? null).toBeNull();
  });

  it("A5(a): an entry recorded BEFORE its period's filing is not listed; one recorded after it is (presence and absence in one period)", async () => {
    const issue = async (date: string) => {
      const inv = await h.api("admin", "POST", "/invoices", { customerId, date, items: [{ description: "July sale", quantity: 1, unitPrice: 500, vatRate: 15 }] });
      expect(inv.status, JSON.stringify(inv.body)).toBe(201);
      expect((await h.api("admin", "POST", `/invoices/${inv.body.id}/approve`, {})).status).toBe(200);
      return inv.body.id as number;
    };
    const before = await issue("2026-07-10");
    await file("2026-07", "2026-07", "2026-08-25", "G2A-RET-2026-07");
    const after = await issue("2026-07-28");
    const listed = (await h.api("admin", "GET", "/tax/vat-return-filings/entries-after-filing")).body.items
      .filter((x: { sourceType: string }) => x.sourceType === "invoice").map((x: { sourceId: number }) => x.sourceId);
    expect([listed.includes(before), listed.includes(after)]).toEqual([false, true]);
  });

  it("🔴 A5(a): an invoice dated in a FILED period is issued — never refused — and carries the filing as a warning; its entry is listed as recorded after the filing", async () => {
    const inv = await h.api("admin", "POST", "/invoices", { customerId, date: "2026-08-20", items: [{ description: "Late-recorded sale", quantity: 1, unitPrice: 1_000, vatRate: 15 }] });
    expect(inv.status, JSON.stringify(inv.body)).toBe(201);
    const issued = await h.api("admin", "POST", `/invoices/${inv.body.id}/approve`, {});
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    const read = await h.api("admin", "GET", `/invoices/${inv.body.id}`);
    expect(read.body.filedVatPeriod).toMatchObject({ zatcaReference: "G2A-RET-2026-08", periodFrom: "2026-08", periodTo: "2026-08", filedOn: "2026-09-25" });
    const list = await h.api("admin", "GET", "/tax/vat-return-filings/entries-after-filing");
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.items.find((x: { sourceId: number; sourceType: string }) => x.sourceType === "invoice" && x.sourceId === inv.body.id)).toMatchObject({ date: "2026-08-20", zatcaReference: "G2A-RET-2026-08" });
  });
});
