/**
 * Phase 16 + 17 — what the MANUAL QA walk of 2026-10-04 found, pinned over real HTTP.
 * Record: docs/history/phase-16-17-manual-qa-2026-10-04.md.
 *
 * Every case here was invisible to the existing suites for one reason: they
 * call the SERVICE, where a database refusal is a thrown error and "refused" is
 * all a test can say. The defect lived one layer up, in what the CLIENT is told
 * (CLAUDE.md §3, "verified below the layer that had the bug"):
 *
 *   QA-11  a Phase 16/17 trigger's refusal answered 500 "Internal server error"
 *          (a remittance race; a treaty rate above the statutory one) — the 0112
 *          budget triggers were mapped, none of 0113–0115's were;
 *   QA-11b a journal line on WHT_PAYABLE (the DEFERRED W3 trigger, refusing at
 *          COMMIT) answered 500 `commit_failed` — "please try again", which can
 *          never pass — and paged a critical database-health alert;
 *   QA-13  a payment plan's WHT estimate ignored the supplier's declared default
 *          nature ("no estimate") and an approved treaty relief (statutory rate).
 *
 * Each refusal is asserted with its status, its code and that NOTHING was
 * written; each is paired with the same request succeeding where it may.
 */
process.env.PORT ??= "3000";
process.env.SESSION_SECRET ??= "test-secret-value-at-least-32-chars!!";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import http from "node:http";
import bcrypt from "bcryptjs";
import { pool, PERMISSION_MATRIX } from "@workspace/db";
import { businessToday } from "@workspace/shared";
import { primePermissionCache } from "../lib/rbac";
import { __resetRateLimitsForTests } from "../routes/auth";
import { addDays } from "../services/tax/taxComputations.service";
import { translateDbRefusal } from "../lib/dbRefusals";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[phase16-17-qa-fixes] no real DATABASE_URL — skipping the HTTP half.");

const P = "p1617-qa";
const PASSWORD = "p1617-qa-pw-1";

describe("QA-11 — the database's refusals translate to 409/422, by constraint, as an exact allow-list", () => {
  it("🔴 every Phase 16/17 trigger family is a refusal with its constraint as the code; an unknown constraint stays a 500", () => {
    const t = (constraint: string, code = "23514") => translateDbRefusal({ code, constraint, message: "the database's sentence" });
    expect([t("wht_remittance_exceeds")?.status, t("wht_remittance_exceeds")?.body.code]).toEqual([409, "wht_remittance_exceeds"]);
    expect(t("wht_relief_rate")?.status).toBe(422);
    expect(t("wht_payable_unowned")?.status).toBe(422);
    expect(t("scheduled_payment_transition")?.status).toBe(409);
    expect(t("scheduled_payment_bill_reversed")?.status).toBe(409);
    expect(t("tax_adjustment_locked")?.status).toBe(409);
    expect(t("tax_computation_version_transition")?.status).toBe(409);
    expect(t("zakat_classification_type")?.status).toBe(422);
    expect(t("treasury_forecast_entry_tenant")?.status).toBe(422);
    // wrapped by Drizzle in `cause`
    expect(translateDbRefusal({ message: "Failed query", cause: { code: "23514", constraint: "wht_relief_rate", message: "rate above statutory" } })).toEqual({ status: 422, body: { code: "wht_relief_rate", error: "rate above statutory" } });
    // unique indexes two concurrent requests can collide on
    expect(t("tax_computations_company_kind_year_unq", "23505")).toMatchObject({ status: 409, body: { code: "concurrent_conflict" } });
    // a clock-numbered system entry meeting another in the same millisecond: nothing duplicated, a retry passes
    expect(t("journal_entries_company_number_unq", "23505")).toMatchObject({ status: 409, body: { code: "concurrent_conflict" } });
    // the budget and banking translations are unchanged by the move
    expect(t("budget_line_locked")?.status).toBe(409);
    expect(translateDbRefusal({ code: "23514", message: "bank 3 is reconciled through 2026-09-30" })?.body.code).toBe("bank_reconciled_through");
    // an EXACT allow-list: the rate schedule (no tenant path writes it), a plain CHECK, an unnamed one → a logged 500
    expect(t("wht_rates_owner_only")).toBeNull();
    expect(t("scheduled_payments_amount_chk")).toBeNull();
    expect(translateDbRefusal({ code: "23514", message: "x" })).toBeNull();
    expect(t("scheduled_payments_pkey", "23505")).toBeNull();
  });
});

describeMaybe("Phase 16 + 17 QA — the client is told the truth over HTTP", () => {
  let server: http.Server;
  let base = "";
  let orgId = "", companyId = "";
  let bank = 0, vendorNR = 0;
  const today = businessToday();

  const cleanup = async () => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL session_replication_role = replica");
      const O = `(SELECT id FROM organizations WHERE slug LIKE '${P}-%')`;
      const { rows } = await c.query(
        `SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
          WHERE c.table_schema = 'public' AND c.column_name = 'organization_id' AND t.table_type = 'BASE TABLE' AND c.table_name <> 'organizations'`);
      for (const { table_name } of rows) await c.query(`DELETE FROM "${table_name}" WHERE organization_id IN ${O}`);
      await c.query(`DELETE FROM audit_logs WHERE user_id IN (SELECT id FROM users WHERE email LIKE '${P}-%@test.local')`);
      await c.query(`DELETE FROM organization_memberships WHERE user_id IN (SELECT id FROM users WHERE email LIKE '${P}-%@test.local')`);
      await c.query(`DELETE FROM users WHERE email LIKE '${P}-%@test.local'`);
      await c.query(`DELETE FROM organizations WHERE slug LIKE '${P}-%'`);
      await c.query("COMMIT");
    } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
  };

  let cookie = "";
  const as = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const sid = ((res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? []).find((c) => c.startsWith("ksa_ledger_sid="));
    if (sid) cookie = sid.split(";")[0];
    const text = await res.text();
    let json: any;
    try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: res.status, json, text };
  };
  const count = async (sql: string) => Number((await pool.query(sql, [companyId])).rows[0].n);
  const account = async (code: string) => Number((await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = $2`, [orgId, code])).rows[0].id);
  const bankLeaf = async () => Number((await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND bank_account_id = $2`, [orgId, bank])).rows[0].id);
  async function paidNonResidentBill(no: string, amount: number) {
    const b = await as("POST", "/bills", { supplierDocumentKind: "tax_invoice", vendorReference: no, billNumber: no, date: addDays(today, -2), dueDate: addDays(today, 20), vendorId: vendorNR,
      items: [{ description: "Consulting", quantity: 1, unitPrice: amount, vatRate: 0 }] });
    expect(b.status, b.text).toBe(201);
    expect((await as("POST", `/bills/${b.json.id}/approve`, {})).status).toBe(200);
    return b.json.id as number;
  }

  beforeAll(async () => {
    await __resetRateLimitsForTests();
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ($1,$1,'approved') RETURNING id`, [`${P}-x`])).rows[0].id;
    companyId = (await pool.query(`INSERT INTO companies (organization_id, name, fiscal_year_start, fiscal_calendar, vat_number, cr_number, ownership_type) VALUES ($1,'QA co',1,'gregorian','399999999999993','1010303032','SAUDI_GCC') RETURNING id`, [orgId])).rows[0].id;
    const hash = await bcrypt.hash(PASSWORD, 4);
    const uid = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1,'QA',$2,'viewer',true) RETURNING id`, [`${P}-admin@test.local`, hash])).rows[0].id;
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [uid, orgId]);
    const app = (await import("../app")).default;
    primePermissionCache(PERMISSION_MATRIX);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/api`;
    expect((await as("POST", "/auth/login", { email: `${P}-admin@test.local`, password: PASSWORD })).status).toBe(200);
    bank = (await as("POST", "/bank-accounts", { name: "Ops", bankName: "SNB", currency: "SAR" })).json.id;
    vendorNR = (await as("POST", "/vendors", { name: "QA Consulting Ltd", country: "IE", residency: "non_resident", whtDefaultPaymentType: "technical_consulting", foreignTaxId: "IE1" })).json.id;
  }, 120_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await cleanup();
  });

  it("🔴 QA-11b — a manual journal line on WHT_PAYABLE (refused at COMMIT) is a 422 wht_payable_unowned with the trigger's sentence — not 500 commit_failed — and writes nothing", async () => {
    const before = await count(`SELECT count(*) n FROM journal_entries WHERE company_id = $1`);
    const r = await as("POST", "/journal-entries", { date: today, description: "manual WHT", lines: [
      { accountId: await account("WHT_PAYABLE"), accountName: "WHT payable", debitAmount: 100, creditAmount: 0 },
      { accountId: await bankLeaf(), accountName: "Ops", debitAmount: 0, creditAmount: 100 },
    ] });
    expect([r.status, r.json?.code], r.text).toEqual([422, "wht_payable_unowned"]);
    expect(r.json.error).toMatch(/no WHT record owns it/);
    expect(await count(`SELECT count(*) n FROM journal_entries WHERE company_id = $1`), "nothing written").toBe(before);
    // movement: the same request on an ordinary account goes through, so the 422 is about WHT_PAYABLE
    const ok = await as("POST", "/journal-entries", { date: today, description: "ordinary", lines: [
      { accountId: await account("OFFICE_SUPPLIES"), accountName: "Office", debitAmount: 100, creditAmount: 0 },
      { accountId: await bankLeaf(), accountName: "Ops", debitAmount: 0, creditAmount: 100 },
    ] });
    expect(ok.status, ok.text).toBe(201);
  });

  it("🔴 QA-11 — a treaty relief above the statutory rate is a 422 wht_relief_rate, not a 500; one below it is recorded", async () => {
    const body = (reducedRate: number) => ({ vendorId: vendorNR, paymentType: "royalty", reducedRate, treatyCountry: "IE", zatcaApprovalReference: "Z-1", residencyCertificateReference: "R-1", validFrom: addDays(today, -30), validTo: addDays(today, 300) });
    const above = await as("POST", "/tax/wht/reliefs", body(0.2)); // royalty is 15 %
    expect([above.status, above.json?.code], above.text).toEqual([422, "wht_relief_rate"]);
    expect(await count(`SELECT count(*) n FROM vendor_wht_treaty_reliefs WHERE company_id = $1`)).toBe(0);
    expect((await as("POST", "/tax/wht/reliefs", body(0.1))).status).toBe(201);
  });

  it("🔴 QA-11 — two remittances RACE over HTTP and the DATABASE decides the loser: one 200, one 409 wht_remittance_exceeds (never a 500), one remittance", async () => {
    const billId = await paidNonResidentBill("QA-RACE-1", 10_000);
    expect((await as("POST", `/bills/${billId}/pay`, { amount: 10_000, paidAt: today, bankAccountId: bank })).status).toBe(200); // withholds 500
    const period = today.slice(0, 7);
    // Hold the month's remittance lock, so BOTH requests pass the service's pre-check and then wait inside the trigger.
    const holder = await pool.connect();
    // 🔴 The clock is PINNED for the race: the remittance's entry number used to carry `Date.now()`, so two
    // requests in one millisecond collided on the journal number (a 500) before the trigger could decide.
    // Pinning makes that collision certain under the old numbering instead of a matter of luck.
    const pinned = vi.spyOn(Date, "now").mockReturnValue(Date.now());
    try {
      await holder.query(`SELECT pg_advisory_lock(hashtext($1))`, [`wht-remit:${companyId}:${period}`]);
      const pay = () => as("POST", `/tax/wht/periods/${period}/pay`, { bankAccountId: bank, paidAt: today });
      const racing = Promise.all([pay(), pay()]);
      const deadline = Date.now() + 15_000;
      for (;;) {
        const waiting = Number((await pool.query(`SELECT count(*) n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`)).rows[0].n);
        if (waiting >= 2) break;
        if (Date.now() > deadline) throw new Error(`only ${waiting} request(s) reached the remittance lock`);
        await new Promise((r) => setTimeout(r, 50));
      }
      await holder.query(`SELECT pg_advisory_unlock(hashtext($1))`, [`wht-remit:${companyId}:${period}`]);
      const results = await racing;
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(results.find((r) => r.status === 409)!.json.code).toBe("wht_remittance_exceeds");
    } finally { pinned.mockRestore(); holder.release(); }
    expect(await count(`SELECT count(*) n FROM wht_remittances WHERE company_id = $1`)).toBe(1);
    const ov = await as("GET", "/tax/wht/overview");
    expect(ov.json.reconciliation.reconciles).toBe(true);
  });

  it("QA-16 — the funding recommendation's words carry the page's money format (thousands separators, two decimals) in both languages", async () => {
    expect((await as("PUT", "/treasury/settings", { minimumCashBalance: 100_000_000, forecastHorizonWeeks: 13 })).status).toBe(200);
    const f = (await as("GET", "/treasury/forecast")).json;
    expect(f.funding.requirement).toBeGreaterThan(1_000);
    expect(f.funding.recommendation.en).toContain("the minimum balance of SAR 100,000,000.00");
    expect(f.funding.recommendation.en).toMatch(/Arrange funding of SAR \d{1,3}(,\d{3})+\.\d{2} /);
    expect(f.funding.recommendation.ar).toContain("100,000,000.00 ريال");
    expect((await as("PUT", "/treasury/settings", { minimumCashBalance: null, forecastHorizonWeeks: 13 })).status).toBe(200);
  });

  it("🔴 QA-13 — a plan's WHT estimate is the pay path's own decision: the supplier's declared default nature, and an approved treaty relief", async () => {
    const billId = await paidNonResidentBill("QA-PLAN-1", 20_000);
    const plan = await as("POST", "/treasury/payment-plans", { billId, plannedDate: addDays(today, 5), amount: 20_000 }); // no nature on the plan
    expect(plan.status, plan.text).toBe(201);
    // technical consulting (the supplier's declared default) is 5 %: 1,000 — it said "no estimate" before
    expect([plan.json.whtPaymentType, plan.json.whtEstimate, plan.json.cashEstimate]).toEqual([null, 1_000, 19_000]);
    // an approved treaty relief for that nature: 2 % → 400 (it showed the statutory 1,000)
    const relief = await as("POST", "/tax/wht/reliefs", { vendorId: vendorNR, paymentType: "technical_consulting", reducedRate: 0.02, treatyCountry: "IE", zatcaApprovalReference: "Z-2", residencyCertificateReference: "R-2", validFrom: addDays(today, -30), validTo: addDays(today, 300) });
    expect(relief.status, relief.text).toBe(201);
    const pending = (await as("GET", "/treasury/payment-plans")).json.find((p: { id: number }) => p.id === plan.json.id);
    expect(pending.whtEstimate, "a PENDING relief changes nothing").toBe(1_000);
    expect((await as("POST", `/tax/wht/reliefs/${relief.json.id}/approve`, {})).status).toBe(200);
    const after = (await as("GET", "/treasury/payment-plans")).json.find((p: { id: number }) => p.id === plan.json.id);
    expect([after.whtEstimate, after.cashEstimate]).toEqual([400, 19_600]);
    // and the estimate is what paying the plan withholds
    expect((await as("POST", `/treasury/payment-plans/${plan.json.id}/approve`, {})).status).toBe(200);
    const paid = await as("POST", `/treasury/payment-plans/${plan.json.id}/pay`, { bankAccountId: bank });
    expect(paid.status, paid.text).toBe(200);
    expect(Number((await pool.query(`SELECT wht_amount FROM wht_withholdings WHERE bill_id = $1`, [billId])).rows[0].wht_amount)).toBe(400);
  });
});
