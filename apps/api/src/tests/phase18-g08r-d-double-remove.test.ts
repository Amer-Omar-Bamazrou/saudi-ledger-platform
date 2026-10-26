/**
 * 🔴 B-G08R-P (d) — PROOF ONLY (owner-approved 2026-10-18): TWO CONCURRENT
 * REJECTS, OR TWO DELETES, of one draft. Known-failing by design while a
 * defect exists: each assertion states the correct behaviour.
 *
 * Residual R5 (register DR-49): by reading, the second of two invoice removals
 * now answers 409 (the G08 conditional delete removes nothing and says so).
 * The bill, journal-entry and payroll removals are keyed on id only, so the
 * second would delete nothing and still answer 2xx with a second audit row.
 * Each pair is FORCED (`helpers/g08rRace.ts`): both removals queue on the row,
 * then run in turn. Correct: exactly one 2xx, the other a refusal (4xx), never
 * a 5xx, and ONE removal recorded.
 *
 * DB-backed (sl_test); skips on the DB-free placeholder. Run through the pre-flight gate.
 */
process.env.PORT ??= "3177";
process.env.SESSION_SECRET ??= "g08r-d-double-remove-proof-00000000000001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness, type Res } from "./helpers/g04Harness";
import { auditsOf, brief, queuedBehind } from "./helpers/g08rRace";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "G08rProofPw123!";
const DATE = "2026-10-05";
const INVOICE_ALREADY_REMOVED = "This invoice was already rejected or deleted by another action.";

describeMaybe("B-G08R-P (d) — two removals of one draft at once", () => {
  const h = g04Harness("g08rd");
  let orgId = "";
  let customerId = 0;
  let vendorId = 0;
  let debitAccount = 0;
  let creditAccount = 0;
  let n = 0;
  const next = () => String(++n).padStart(3, "0");

  const create = {
    invoice: async () => (await h.api("bookkeeper", "POST", "/invoices", { invoiceNumber: `G08RD-INV-${next()}`, date: DATE, customerId, items: [{ description: "Service", quantity: 1, unitPrice: 100, vatRate: 15 }] })).body.id as number,
    bill: async () => { const no = `G08RD-BL-${next()}`; return (await h.api("bookkeeper", "POST", "/bills", { supplierDocumentKind: "tax_invoice", vendorReference: `VR-${no}`, billNumber: no, date: DATE, dueDate: DATE, vendorId, items: [{ description: "Supply", quantity: 1, unitPrice: 100, vatRate: 0 }] })).body.id as number; },
    je: async () => (await h.api("bookkeeper", "POST", "/journal-entries", { entryNumber: `G08RD-JE-${next()}`, date: DATE, description: "B-G08R-P (d)", lines: [
      { accountId: debitAccount, accountName: "debit", debitAmount: 10, creditAmount: 0 },
      { accountId: creditAccount, accountName: "credit", debitAmount: 0, creditAmount: 10 },
    ] })).body.id as number,
    payroll: async () => (await h.api("bookkeeper", "POST", "/payroll", { period: `2024-${String((n++ % 12) + 1).padStart(2, "0")}` })).body.id as number,
  };
  const table = { invoice: "invoices", bill: "bills", je: "journal_entries", payroll: "payroll_runs" } as const;
  const route = { invoice: "/invoices", bill: "/bills", je: "/journal-entries", payroll: "/payroll" } as const;
  const entityType = { invoice: "invoice", bill: "bill", je: "journal_entry", payroll: "payroll_run" } as const;
  type Kind = keyof typeof table;
  const reject = (k: Kind, id: number) => () => h.api("accountant", "POST", `${route[k]}/${id}/reject`, {});
  const del = (k: Kind, id: number) => () => h.api("admin", "DELETE", `${route[k]}/${id}`);

  async function pair(k: Kind, label: string, acts: (id: number) => Array<() => Promise<Res>>) {
    const id = await create[k]();
    expect(id, `create ${k}`).toBeGreaterThan(0);
    const rs = await queuedBehind(table[k], id, acts(id));
    const exists = (await pool.query(`SELECT 1 FROM "${table[k]}" WHERE id = $1`, [id])).rowCount;
    const audits = await auditsOf(orgId, entityType[k], id);
    // eslint-disable-next-line no-console
    console.warn(`[G08R-d] ${k} ${label}`, JSON.stringify({ results: rs.map(brief), exists, audits }));
    const ok = rs.filter((r) => r.status >= 200 && r.status < 300);
    const loser = rs.find((r) => !(r.status >= 200 && r.status < 300));
    expect.soft(rs.every((r) => r.status < 500), "never a 5xx").toBe(true);
    expect.soft(ok.length, "exactly one removal succeeds").toBe(1);
    expect.soft(loser && loser.status >= 400 && loser.status < 500, "the other is refused (4xx)").toBe(true);
    expect.soft(exists, "the record is gone").toBe(0);
    expect.soft(audits.filter((a) => a.startsWith("reject:") || a.startsWith("delete:")), "ONE removal is recorded").toHaveLength(1);
    expect.soft(audits.filter((a) => a.startsWith("reject:") || a.startsWith("delete:")).every((a) => a.endsWith(":1")), "ONE removal is recorded").toBe(true);
    return { rs, loser };
  }

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    const companyId = await h.mkCompany(orgId, "G08R-d Co", "318181818181877");
    customerId = (await pool.query(`INSERT INTO customers (organization_id, name, tax_number) VALUES ($1,'G08R-d Buyer','300000000000003') RETURNING id`, [orgId])).rows[0].id;
    vendorId = (await pool.query(`INSERT INTO vendors (organization_id, name) VALUES ($1,'G08R-d Supplier') RETURNING id`, [orgId])).rows[0].id;
    const accountOf = async (code: string) => Number((await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = $2 AND is_posting`, [orgId, code])).rows[0].id);
    debitAccount = await accountOf("RENT_UTILITIES");
    creditAccount = await accountOf("OTHER_INCOME");
    await pool.query(`INSERT INTO employees (organization_id, company_id, employee_number, name, nationality, basic_salary, status, gosi_regime) VALUES ($1,$2,'E1','G08R-d Employee','SA','8000.00','active','law_1421h')`, [orgId, companyId]);
    for (const [who, role] of [["admin", "admin"], ["accountant", "accountant"], ["bookkeeper", "bookkeeper"]]) await h.mkUser(who, PW, orgId, role);
    await h.start();
    for (const who of ["admin", "accountant", "bookkeeper"]) expect(await h.login(who, h.email(who), PW), `login ${who}`).toBe(200);
  }, 120_000);
  afterAll(async () => { await h.stop(); await h.cleanup(); });

  it("R5 — INVOICE: two rejects at once — one 204, the other 409 'already rejected or deleted'; one recorded", async () => {
    const { loser } = await pair("invoice", "reject+reject", (id) => [reject("invoice", id), reject("invoice", id)]);
    expect.soft(loser?.status).toBe(409);
    expect.soft(loser?.body?.error).toBe(INVOICE_ALREADY_REMOVED);
  }, 60_000);
  it("R5 — INVOICE: two DELETEs at once — one 204, the other 409; one recorded", async () => {
    const { loser } = await pair("invoice", "delete+delete", (id) => [del("invoice", id), del("invoice", id)]);
    expect.soft(loser?.status).toBe(409);
    expect.soft(loser?.body?.error).toBe(INVOICE_ALREADY_REMOVED);
  }, 60_000);
  it("R5 — INVOICE: a reject and a DELETE at once — one succeeds, the other is refused; one recorded", async () => {
    await pair("invoice", "reject+delete", (id) => [reject("invoice", id), del("invoice", id)]);
  }, 60_000);

  for (const k of ["bill", "je", "payroll"] as const) {
    it(`🔴 R3/R5 — ${k.toUpperCase()}: two rejects at once — one succeeds, the other is refused; one recorded`, async () => {
      await pair(k, "reject+reject", (id) => [reject(k, id), reject(k, id)]);
    }, 60_000);
  }
  for (const k of ["bill", "je"] as const) {
    it(`🔴 R3/R5 — ${k.toUpperCase()}: two DELETEs (deleteDraft) at once — one succeeds, the other is refused; one recorded`, async () => {
      await pair(k, "delete+delete", (id) => [del(k, id), del(k, id)]);
    }, 60_000);
  }
});
