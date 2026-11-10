/**
 * 🔴 Phase 18 audit (2026-11-09), finding A5 — G27's "audit coverage for every posting and OVERRIDE": the bill
 * approval's `force` is recorded in the audit trail (control registry: DR-22).
 *
 * `force: true` lets a bill post although its totals do not reconcile (TOTALS_MISMATCH — the GL then uses the
 * computed total) or its vendor's VAT number is not in ZATCA's format (INVALID_VAT_NUMBER). Each override only
 * wrote a `console.warn`: the trail named an approval and nothing said a check had been overridden, by whom, or
 * with which figures. Whether `force` should exist at all is G13/DR-35, open with the accountant — this records
 * its use, and decides nothing about it.
 *
 * Presence, absence and movement: a forced approval writes one `force_override` row per overridden check, naming
 * the check and its figures; an approval that overrides nothing writes none. DB-backed (sl_test / CI).
 */
process.env.PORT ??= "3394";
process.env.SESSION_SECRET ??= "phase18-audit-a5-force-recorded-000001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "AuditA5ForceRecordedPw1!";

describeMaybe("Phase 18 audit A5 — a forced bill approval is recorded in the audit trail", () => {
  const h = g04Harness("auda5");
  let orgId = "", goodVendor = 0, badVatVendor = 0, adminId = 0;

  const overrides = async (billId: number) => (await pool.query(
    `SELECT user_id, after_state AS after FROM audit_logs WHERE organization_id = $1 AND entity_type = 'bill' AND entity_id = $2 AND action = 'force_override' ORDER BY id`,
    [orgId, String(billId)])).rows as Array<{ user_id: number; after: Record<string, unknown> }>;
  const bill = async (vendorId: number, no: string, header: { subtotal: number; vatAmount: number; total: number }) => {
    const r = await h.api("admin", "POST", "/bills", { vendorId, billNumber: no, date: "2026-10-01", items: [], ...header, supplierDocumentKind: "tax_invoice", vendorReference: `${no}-SUP` });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.id as number;
  };

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    await pool.query(
      `INSERT INTO companies (organization_id, name, cr_number, vat_number, fiscal_year_start, building_number, street, district, city, postal_code, additional_number)
       VALUES ($1,'Audit A5 Co','1010868391','310123456789013',1,'1234','King Fahd Road','Al Olaya','Riyadh','12345','6789')`, [orgId]);
    adminId = await h.mkUser("admin", PW, orgId, "admin");
    goodVendor = (await pool.query(`INSERT INTO vendors (organization_id, name, tax_number) VALUES ($1,'A5 Supplier','300000000000003') RETURNING id`, [orgId])).rows[0].id;
    badVatVendor = (await pool.query(`INSERT INTO vendors (organization_id, name, tax_number) VALUES ($1,'A5 Odd VAT','12345') RETURNING id`, [orgId])).rows[0].id;
    await h.start();
    expect(await h.login("admin", h.email("admin"), PW), "login admin").toBe(200);
  }, 120_000);

  afterAll(async () => { await h.stop(); await h.cleanup(); });

  it("🔴 TOTALS_MISMATCH forced: the approval posts AND the trail says the totals check was overridden, by whom, with the figures", async () => {
    const id = await bill(goodVendor, "A5-B1", { subtotal: 100, vatAmount: 15, total: 120 });
    const refused = await h.api("admin", "POST", `/bills/${id}/approve`, {});
    expect([refused.status, refused.body?.code], JSON.stringify(refused.body)).toEqual([400, "TOTALS_MISMATCH"]);
    expect(await overrides(id), "a refused approval records no override").toEqual([]);
    const forced = await h.api("admin", "POST", `/bills/${id}/approve`, { force: true });
    expect(forced.status, JSON.stringify(forced.body)).toBe(200);
    const rows = await overrides(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.user_id, "the actor who forced it").toBe(adminId);
    expect(rows[0]!.after).toMatchObject({ check: "TOTALS_MISMATCH", subtotal: 100, vatAmount: 15, computedTotal: 115, storedTotal: 120, postedTotal: 115 });
  }, 60_000);

  it("🔴 INVALID_VAT_NUMBER forced: the trail names the check and the vendor's VAT number", async () => {
    const id = await bill(badVatVendor, "A5-B2", { subtotal: 100, vatAmount: 15, total: 115 });
    const refused = await h.api("admin", "POST", `/bills/${id}/approve`, {});
    expect([refused.status, refused.body?.code], JSON.stringify(refused.body)).toEqual([400, "INVALID_VAT_NUMBER"]);
    const forced = await h.api("admin", "POST", `/bills/${id}/approve`, { force: true });
    expect(forced.status, JSON.stringify(forced.body)).toBe(200);
    const rows = await overrides(id);
    expect(rows.map((r) => r.after.check)).toEqual(["INVALID_VAT_NUMBER"]);
    expect(rows[0]!.after).toMatchObject({ vendorId: badVatVendor, vendorVatNumber: "12345" });
  }, 60_000);

  it("absence: an approval that overrides nothing — with or without force:true sent — records no override", async () => {
    const plain = await bill(goodVendor, "A5-B3", { subtotal: 100, vatAmount: 15, total: 115 });
    expect((await h.api("admin", "POST", `/bills/${plain}/approve`, {})).status).toBe(200);
    expect(await overrides(plain)).toEqual([]);
    const needless = await bill(goodVendor, "A5-B4", { subtotal: 200, vatAmount: 30, total: 230 });
    expect((await h.api("admin", "POST", `/bills/${needless}/approve`, { force: true })).status).toBe(200);
    expect(await overrides(needless), "force sent, nothing overridden: nothing to record").toEqual([]);
  }, 60_000);
});
