/**
 * 🔴 Phase 18 audit (2026-11-09), G47 — a recurring rule that asks to ISSUE automatically is refused, over HTTP.
 *
 * A3 ships drafts only: issuing an invoice consumes a ZATCA sequence number and cannot be undone, so it is not done
 * unattended (CLAUDE.md §3, "an act about a document is not an act about a pattern"). The refusal lives in
 * `recurringService.create`; G47 recorded it FIXED, and the only test that named `autoIssue` set it to false — the
 * refusal itself was never exercised.
 *
 * Presence, absence, movement: `autoIssue: true` is answered 400 with words that name why, and writes no rule; the
 * same body with `autoIssue: false` is accepted and writes one — so the refusal is the flag's, not the body's.
 * DB-backed (sl_test / CI).
 */
process.env.PORT ??= "3397";
process.env.SESSION_SECRET ??= "phase18-audit-g47-auto-issue-refused1";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "AuditG47AutoIssuePw1!";

describeMaybe("Phase 18 audit G47 — a recurring rule cannot issue automatically", () => {
  const h = g04Harness("audg47");
  let orgId = "", customerId = 0;

  const rules = async () => Number((await pool.query(`SELECT count(*)::int AS n FROM recurring_rules WHERE organization_id = $1`, [orgId])).rows[0].n);
  const body = (autoIssue: boolean) => ({
    entity: "invoice",
    template: { customerId, items: [{ description: "Monthly service", quantity: 1, unitPrice: 1_000, vatRate: 15 }] },
    frequency: "monthly",
    dayOfMonth: 5,
    startsOn: "2026-12-05",
    autoIssue,
  });

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    await pool.query(
      `INSERT INTO companies (organization_id, name, cr_number, vat_number, fiscal_year_start, building_number, street, district, city, postal_code, additional_number)
       VALUES ($1,'Audit G47 Co','1010868391','310123456789013',1,'1234','King Fahd Road','Al Olaya','Riyadh','12345','6789')`, [orgId]);
    await h.mkUser("admin", PW, orgId, "admin");
    customerId = (await pool.query(`INSERT INTO customers (organization_id, name) VALUES ($1,'G47 Buyer') RETURNING id`, [orgId])).rows[0].id;
    await h.start();
    expect(await h.login("admin", h.email("admin"), PW)).toBe(200);
  }, 120_000);

  afterAll(async () => { await h.stop(); await h.cleanup(); });

  it("🔴 autoIssue: true is refused 400, in words that say a rule makes drafts — and no rule is written", async () => {
    const before = await rules();
    const r = await h.api("admin", "POST", "/recurring", body(true));
    expect(r.status, JSON.stringify(r.body)).toBe(400);
    expect(String(r.body?.error)).toMatch(/Automatic issuing is not available/);
    expect(String(r.body?.error)).toMatch(/draft/);
    expect(await rules()).toBe(before);
  });

  it("movement: the same rule with autoIssue: false is accepted as a drafts-only rule, and one rule is written", async () => {
    const before = await rules();
    const r = await h.api("admin", "POST", "/recurring", body(false));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ entity: "invoice", autoIssue: false });
    expect(await rules()).toBe(before + 1);
  });
});
