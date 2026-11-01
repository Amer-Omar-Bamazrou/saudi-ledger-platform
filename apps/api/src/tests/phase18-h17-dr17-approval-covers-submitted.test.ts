/**
 * 🔴 Phase 18 H-17 — DR-17 (D-15; contract G10): an approval covers the figures
 * that were submitted. A tax computation's inputs are fingerprinted at submit
 * and compared at approval; an approved quotation or purchase order is refused
 * an edit. DECIDED 2026-10-27 — owner accepted the stated recommendation
 * (register §11.68, the scoped D-4 statement, appended before this file).
 *
 * Acts over HTTP. DB-backed (sl_test / CI); skips on the DB-free placeholder.
 */
process.env.PORT ??= "3267";
process.env.SESSION_SECRET ??= "phase18-h17-approval-covers-subm1";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { businessToday } from "@workspace/shared";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "Phase18H17ApprPw1!";

describeMaybe("Phase 18 H-17 — DR-17: an approval covers the figures that were submitted", () => {
  const h = g04Harness("p18h17apr");
  const today = businessToday();
  const lastYear = Number(today.slice(0, 4)) - 1;
  let orgId = "", companyId = "", bankLeaf = 0;
  const accruals = async () => Number((await pool.query(`SELECT count(*) n FROM journal_entries WHERE company_id = $1 AND entry_number LIKE 'ZAKAT-%'`, [companyId])).rows[0].n);

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    companyId = (await pool.query(`INSERT INTO companies (organization_id, name, fiscal_year_start, fiscal_calendar, vat_number, cr_number, ownership_type, vat_tax_period)
      VALUES ($1,'H17 Co',1,'gregorian','399999999999933','1010707071','SAUDI_GCC','quarterly') RETURNING id`, [orgId])).rows[0].id;
    for (const role of ["admin", "accountant", "bookkeeper"]) await h.mkUser(role, PW, orgId, role);
    await h.start();
    for (const who of ["admin", "accountant", "bookkeeper"]) expect(await h.login(who, h.email(who), PW), `login ${who}`).toBe(200);
    // a capital injection last year into a classified bank: a Zakat base (the gap-closure suite's fixture)
    const bank = (await h.api("admin", "POST", "/bank-accounts", { name: "Ops", bankName: "SNB", currency: "SAR" })).body.id;
    bankLeaf = Number((await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND bank_account_id = $2`, [orgId, bank])).rows[0].id);
    const capital = (await pool.query(`INSERT INTO categories (organization_id, name, name_ar, type, vat_applicable) VALUES ($1,'H17 capital','رأس المال','equity',false) RETURNING id`, [orgId])).rows[0].id;
    const je = await h.api("admin", "POST", "/journal-entries", { date: `${lastYear}-06-30`, description: "Capital paid in", lines: [
      { accountId: bankLeaf, accountName: "Ops", debitAmount: 100_000, creditAmount: 0 },
      { accountId: capital, accountName: "H17 capital", debitAmount: 0, creditAmount: 100_000 },
    ] });
    expect(je.status, JSON.stringify(je.body)).toBe(201);
    expect((await h.api("admin", "POST", `/journal-entries/${je.body.id}/approve`, {})).status).toBe(200);
    expect((await h.api("admin", "PUT", `/tax/zakat/classifications/${bankLeaf}`, { classification: "current_asset_not_deducted" })).status).toBe(200);
  }, 180_000);

  afterAll(async () => { await h.stop(); await h.cleanup(); });

  it("🔴 a tax computation whose inputs changed after submission is refused approval — nothing posted; resubmitted, it is approved", async () => {
    const c = await h.api("bookkeeper", "POST", "/tax/computations", { kind: "zakat", fiscalYearLabel: lastYear });
    expect(c.status, JSON.stringify(c.body)).toBe(201);
    const base = `/tax/computations/${c.body.id}/versions/${c.body.version.id}`;
    expect((await h.api("bookkeeper", "POST", `${base}/submit`, {})).status).toBe(200);
    // the input changes after submission: the bank is reclassified
    expect((await h.api("bookkeeper", "PUT", `/tax/zakat/classifications/${bankLeaf}`, { classification: "current_asset_deducted" })).status).toBe(200);
    const stale = await h.api("accountant", "POST", `${base}/approve`, {});
    expect([stale.status, stale.body?.code]).toEqual([409, "inputs_changed_since_submission"]);
    expect(await accruals(), "nothing posted on the refusal").toBe(0);
    // sent back, reviewed, resubmitted on the inputs as they now stand → approved
    expect((await h.api("accountant", "POST", `${base}/send-back`, { note: "The bank was reclassified" })).status).toBe(200);
    expect((await h.api("bookkeeper", "POST", `${base}/submit`, {})).status).toBe(200);
    const ok = await h.api("accountant", "POST", `${base}/approve`, {});
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(await accruals()).toBe(1);
  });

  it("🔴 an APPROVED quotation is refused an edit, and stays as it was approved", async () => {
    const customerId = (await h.api("admin", "POST", "/customers", { name: "H17 Customer" })).body.id;
    const q = await h.api("admin", "POST", "/quotations", { customerId, date: today, items: [{ description: "Consulting", quantity: 10, unitPrice: 100, vatRate: 15 }] });
    expect(q.status, JSON.stringify(q.body)).toBe(201);
    expect((await h.api("admin", "POST", `/quotations/${q.body.id}/submit`, {})).status).toBe(200);
    expect((await h.api("accountant", "POST", `/quotations/${q.body.id}/approve`, {})).status).toBe(200);
    const edit = await h.api("admin", "PATCH", `/quotations/${q.body.id}`, { items: [{ description: "Consulting (renegotiated)", quantity: 10, unitPrice: 90, vatRate: 15 }] });
    expect(edit.status, JSON.stringify(edit.body)).toBe(409);
    const after = await h.api("admin", "GET", `/quotations/${q.body.id}`);
    expect([after.body.status, Number(after.body.total)]).toEqual(["approved", 1150]);
  });

  it("🔴 an APPROVED purchase order is refused an edit, and stays as it was approved", async () => {
    const vendorId = (await h.api("admin", "POST", "/vendors", { name: "H17 Supplier", residency: "resident" })).body.id;
    const po = await h.api("admin", "POST", "/purchase-orders", { vendorId, date: today, items: [{ description: "Stock", quantity: 4, unitPrice: 250, vatRate: 15 }] });
    expect(po.status, JSON.stringify(po.body)).toBe(201);
    expect((await h.api("admin", "POST", `/purchase-orders/${po.body.id}/submit`, {})).status).toBe(200);
    expect((await h.api("accountant", "POST", `/purchase-orders/${po.body.id}/approve`, {})).status).toBe(200);
    const edit = await h.api("admin", "PATCH", `/purchase-orders/${po.body.id}`, { items: [{ description: "Stock (more)", quantity: 8, unitPrice: 250, vatRate: 15 }] });
    expect(edit.status, JSON.stringify(edit.body)).toBe(409);
    const after = await h.api("admin", "GET", `/purchase-orders/${po.body.id}`);
    expect([after.body.status, Number(after.body.total)]).toEqual(["approved", 1150]);
  });
});
