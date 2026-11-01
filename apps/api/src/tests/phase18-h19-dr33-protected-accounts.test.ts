/**
 * 🔴 Phase 18 H-19 — DR-33 (OD-11; F-7): ONE protected-account list, read by
 * the three free routes — the manual journal, the bank-line categorisation and
 * a recognition schedule. Retained earnings only through a CLASSIFIED
 * correction (a manual journal carrying an IAS 8 kind); salaries and GOSI
 * payable only through payroll and its pay paths; the VAT accounts only through
 * documents, the evidence claim and the filing's clearing. DECIDED 2026-10-27 —
 * owner accepted the stated recommendation (register §11.75, the scoped D-4
 * statement, appended before this file).
 *
 * Acts over HTTP. DB-backed (sl_test / CI); skips on the DB-free placeholder.
 */
process.env.PORT ??= "3270";
process.env.SESSION_SECRET ??= "phase18-h19-protected-accounts-01";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { businessToday } from "@workspace/shared";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "Phase18H19ProtPw1!";

describeMaybe("Phase 18 H-19 — DR-33: one protected-account list, read by the three free routes", () => {
  const h = g04Harness("p18h19prt");
  const today = businessToday();
  let orgId = "", bankId = 0, seq = 0;
  const acct: Record<string, number> = {};
  const je = (lines: Array<{ accountId: number; debit: number; credit: number }>, extra: Record<string, unknown> = {}) =>
    h.api("admin", "POST", "/journal-entries", { entryNumber: `H19-${++seq}`, date: today, description: `H19 ${seq}`, ...extra,
      lines: lines.map((l) => ({ accountId: l.accountId, accountName: "x", debitAmount: l.debit, creditAmount: l.credit })) });
  const txn = (categoryId: number) =>
    h.api("admin", "POST", "/transactions", { date: today, description: `H19 txn ${++seq}`, amount: 50, currency: "SAR", type: "debit", bankAccountId: bankId, categoryId });
  const schedule = (balanceAccountId: number, expenseAccountId = acct.RENT_UTILITIES) =>
    h.api("admin", "POST", "/recognition-schedules", { kind: "accrual", description: `H19 accrual ${++seq}`, totalAmount: 300, periods: 3, startPeriod: today.slice(0, 7), expenseAccountId, balanceAccountId });
  const refused = (r: { status: number; body: any }, path: string) => expect([path, r.status, r.body?.code]).toEqual([path, 422, "protected_account"]);

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    await pool.query(`INSERT INTO companies (organization_id, name, fiscal_year_start, fiscal_calendar, vat_number, cr_number, ownership_type, vat_tax_period)
      VALUES ($1,'H19 Co',1,'gregorian','399999999999903','1010909091','SAUDI_GCC','quarterly')`, [orgId]);
    await h.mkUser("admin", PW, orgId, "admin");
    await h.start();
    expect(await h.login("admin", h.email("admin"), PW)).toBe(200);
    bankId = (await h.api("admin", "POST", "/bank-accounts", { name: "Ops", bankName: "SNB", currency: "SAR" })).body.id;
    for (const code of ["RETAINED_EARNINGS", "SALARIES_PAYABLE", "GOSI_PAYABLE", "VAT_INPUT", "VAT_OUTPUT", "VAT_PAYMENT", "VAT_AWAITING_EVIDENCE", "RENT_UTILITIES", "OTHER_INCOME", "ACCRUED_LIABILITIES"]) {
      const row = (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = $2 AND is_posting`, [orgId, code])).rows[0];
      expect(row, `the chart has ${code}`).toBeTruthy();
      acct[code] = row.id;
    }
  }, 120_000);

  afterAll(async () => { await h.stop(); await h.cleanup(); });

  it("control: the three routes still take an ordinary account", async () => {
    expect((await je([{ accountId: acct.RENT_UTILITIES, debit: 10, credit: 0 }, { accountId: acct.OTHER_INCOME, debit: 0, credit: 10 }])).status).toBe(201);
    expect((await txn(acct.RENT_UTILITIES)).status).toBe(201);
    expect((await schedule(acct.ACCRUED_LIABILITIES)).status).toBe(201);
  });

  it("🔴 the MANUAL JOURNAL refuses salaries, GOSI and the VAT accounts — on create and on an update that brings one in", async () => {
    for (const code of ["SALARIES_PAYABLE", "GOSI_PAYABLE", "VAT_INPUT", "VAT_OUTPUT", "VAT_PAYMENT", "VAT_AWAITING_EVIDENCE"]) {
      refused(await je([{ accountId: acct.RENT_UTILITIES, debit: 10, credit: 0 }, { accountId: acct[code], debit: 0, credit: 10 }]), `manual journal → ${code}`);
    }
    const draft = await je([{ accountId: acct.RENT_UTILITIES, debit: 10, credit: 0 }, { accountId: acct.OTHER_INCOME, debit: 0, credit: 10 }]);
    expect(draft.status).toBe(201);
    refused(await h.api("admin", "PATCH", `/journal-entries/${draft.body.id}`, { lines: [
      { accountId: acct.RENT_UTILITIES, accountName: "x", debitAmount: 10, creditAmount: 0 },
      { accountId: acct.VAT_OUTPUT, accountName: "x", debitAmount: 0, creditAmount: 10 },
    ] }), "manual journal update → VAT_OUTPUT");
  });

  it("🔴 RETAINED EARNINGS only through a CLASSIFIED correction: unclassified is refused; classified is a draft carrying its kind, and posts", async () => {
    const lines = [{ accountId: acct.RETAINED_EARNINGS, debit: 100, credit: 0 }, { accountId: acct.RENT_UTILITIES, debit: 0, credit: 100 }];
    const bare = await je(lines);
    expect([bare.status, bare.body?.code]).toEqual([422, "correction_kind_required"]);
    const bad = await je(lines, { correctionKind: "oops" });
    expect(bad.status).toBe(400);
    const classified = await je(lines, { correctionKind: "error" });
    expect(classified.status, JSON.stringify(classified.body)).toBe(201);
    expect((await pool.query(`SELECT correction_kind FROM journal_entries WHERE id = $1`, [classified.body.id])).rows[0].correction_kind).toBe("error");
    expect((await h.api("admin", "POST", `/journal-entries/${classified.body.id}/approve`, {})).status).toBe(200);
  });

  it("🔴 the BANK-LINE categorisation refuses every protected account, retained earnings included — on create and on re-categorisation", async () => {
    for (const code of ["RETAINED_EARNINGS", "SALARIES_PAYABLE", "VAT_INPUT", "VAT_PAYMENT"]) refused(await txn(acct[code]), `bank line → ${code}`);
    const ok = await txn(acct.RENT_UTILITIES);
    expect(ok.status).toBe(201);
    refused(await h.api("admin", "PATCH", `/transactions/${ok.body.id}`, { categoryId: acct.GOSI_PAYABLE }), "bank line re-categorised → GOSI_PAYABLE");
  });

  it("🔴 a RECOGNITION schedule refuses a protected balance account", async () => {
    for (const code of ["VAT_OUTPUT", "SALARIES_PAYABLE", "GOSI_PAYABLE"]) refused(await schedule(acct[code]), `recognition balance → ${code}`);
  });
});
