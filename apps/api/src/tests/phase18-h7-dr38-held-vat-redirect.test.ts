/**
 * 🔴 Phase 18 H-7 — DR-38 (OD-16; F-17; G67), the held-VAT half: "Once a filed
 * state exists, redirect a held-VAT claim dated into a filed month to the
 * current period." DECIDED 2026-10-27 — owner accepted the stated
 * recommendation (register §11.54, the scoped D-4 statement, appended before
 * this file).
 *
 *  - evidence dated inside a FILED VAT period claims the held VAT on the first
 *    day after that period — never back into a return already filed;
 *  - control: evidence dated in an unfiled period claims on its own date.
 *
 * Acts over HTTP. DB-backed (sl_test / CI); skips on the DB-free placeholder.
 */
process.env.PORT ??= "3257";
process.env.SESSION_SECRET ??= "phase18-h7-dr38-redirect-0001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "Phase18H7Dr38Pw1!";

describeMaybe("Phase 18 H-7 — DR-38: a held-VAT claim dated into a filed period moves to the next open period", () => {
  const h = g04Harness("p18h7dr38");
  let orgId = "", vendorId = 0, seq = 0;
  const ok = (r: { status: number; body: unknown }, status: number) => expect(r.status, JSON.stringify(r.body)).toBe(status);
  /** A bill posted with its input VAT HELD — no supplier document kind stated, so no evidence yet. */
  const heldBill = async (date: string) => {
    seq += 1;
    const b = await h.api("admin", "POST", "/bills", { vendorReference: `H7-R-${seq}`, billNumber: `H7-${seq}`, date, dueDate: date, vendorId,
      items: [{ description: "Office supplies", quantity: 1, unitPrice: 1_000, vatRate: 15 }] });
    ok(b, 201);
    ok(await h.api("admin", "POST", `/bills/${b.body.id}/approve`, {}), 200);
    expect((await pool.query(`SELECT input_vat_state FROM bills WHERE id = $1`, [b.body.id])).rows[0].input_vat_state).toBe("awaiting_evidence");
    return b.body.id as number;
  };
  const claimEntryDate = async (billId: number) => (await pool.query(
    `SELECT date::text AS d FROM journal_entries WHERE organization_id = $1 AND source_type = 'vat_evidence' AND source_id = $2`, [orgId, billId])).rows.map((r) => r.d);

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    await pool.query(`INSERT INTO companies (organization_id, name, fiscal_year_start, fiscal_calendar, vat_number, cr_number, ownership_type) VALUES ($1,'H7 Co',1,'gregorian','399999999999993','1010303031','SAUDI_GCC')`, [orgId]);
    await h.mkUser("admin", PW, orgId, "admin");
    await h.start();
    expect(await h.login("admin", h.email("admin"), PW), "login admin").toBe(200);
    const v = await h.api("admin", "POST", "/vendors", { name: "H7 Riyadh Stationers", residency: "resident", taxNumber: "300000000000003" });
    ok(v, 201);
    vendorId = v.body.id;
  }, 120_000);

  afterAll(async () => { await h.stop(); await h.cleanup(); });

  it("control: evidence dated in an UNFILED period claims on its own date", async () => {
    const id = await heldBill("2026-08-10");
    ok(await h.api("admin", "POST", `/bills/${id}/evidence`, { supplierDocumentKind: "tax_invoice", evidenceDate: "2026-08-20" }), 200);
    expect(await claimEntryDate(id)).toEqual(["2026-08-20"]);
  });

  it("🔴 evidence dated inside a FILED period claims on the first day after it — never back into a filed return", async () => {
    const id = await heldBill("2026-09-05");
    ok(await h.api("admin", "POST", "/tax/vat-return-filings", { periodFrom: "2026-09", periodTo: "2026-09", filedOn: "2026-10-12", zatcaReference: "VAT-H7-0009" }), 201);
    const r = await h.api("admin", "POST", `/bills/${id}/evidence`, { supplierDocumentKind: "tax_invoice", evidenceDate: "2026-09-20" });
    ok(r, 200);
    expect(await claimEntryDate(id)).toEqual(["2026-10-01"]);
    expect(r.body.inputVat).toMatchObject({ state: "claimed", claimedOn: "2026-10-01" });
  });
});
