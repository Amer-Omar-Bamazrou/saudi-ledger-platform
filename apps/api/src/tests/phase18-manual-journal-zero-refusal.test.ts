/**
 * 🔴 The manual-journal refusal (Phase 18; owner decision 2 of 2026-10-23
 * "refuse saving or posting a manual journal whose amounts are blank or all
 * zero, with a clear refusal in Arabic and English"; final-run memo 2026-10-27
 * §2 C; register §11.11 P-4). An entry whose amounts are blank or all zero
 * balances at 0 = 0, and was saved and posted. It records nothing, so it is
 * refused when it is saved and when it is posted. A single 0.00 line beside
 * real amounts stays allowed (issued invoices and payroll carry such lines).
 *
 * DB-backed (sl_test / CI); skips on the DB-free placeholder.
 */
process.env.PORT ??= "3238";
process.env.SESSION_SECRET ??= "phase18-manual-journal-zero-0001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "Phase18ManualJournalZeroPw1!";

describeMaybe("The manual-journal refusal — blank or all-zero amounts are never saved or posted", () => {
  const h = g04Harness("p18mjz");
  let orgId = "";
  let companyId = "";
  let office = 0;
  let income = 0;

  const account = async (code: string) =>
    Number((await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = $2 AND is_posting`, [orgId, code])).rows[0].id);
  const entry = (n: string, lines: Array<{ accountId: number; debitAmount: unknown; creditAmount: unknown }>) =>
    h.api("admin", "POST", "/journal-entries", { entryNumber: "", date: "2026-08-10", description: n, lines: lines.map((l) => ({ accountName: "Line", ...l })) });
  const count = async (description: string) =>
    Number((await pool.query(`SELECT count(*)::int AS n FROM journal_entries WHERE organization_id = $1 AND description = $2`, [orgId, description])).rows[0].n);

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    companyId = await h.mkCompany(orgId, "Manual Journal Zero Co", "318181818181955");
    await h.mkUser("admin", PW, orgId, "admin");
    await h.start();
    expect(await h.login("admin", h.email("admin"), PW), "login admin").toBe(200);
    office = await account("OFFICE_SUPPLIES");
    income = await account("SALES");
  }, 120_000);

  afterAll(async () => { await h.stop(); await h.cleanup(); });

  it("🔴 saving an entry whose amounts are all zero — what the screen sends for BLANK amounts (Number(\"\") is 0) — is refused, named, and nothing is written", async () => {
    const r = await entry("MJZ-ZERO", [
      { accountId: office, debitAmount: 0, creditAmount: 0 },
      { accountId: income, debitAmount: 0, creditAmount: 0 },
    ]);
    expect([r.status, r.body.code, await count("MJZ-ZERO")], JSON.stringify(r.body)).toEqual([422, "journal_entry_zero_amounts", 0]);
  });

  it("control: a raw body with blank STRINGS never reaches the ledger — the request schema refuses it (400)", async () => {
    const r = await entry("MJZ-BLANK", [
      { accountId: office, debitAmount: "", creditAmount: "" },
      { accountId: income, debitAmount: "", creditAmount: "" },
    ]);
    expect([r.status, await count("MJZ-BLANK")], JSON.stringify(r.body)).toEqual([400, 0]);
  });

  it("🔴 POSTING a draft whose stored amounts are all zero is refused (a draft written before the rule, or by any other writer)", async () => {
    const { rows: [e] } = await pool.query(
      `INSERT INTO journal_entries (organization_id, company_id, entry_number, date, description, status)
       VALUES ($1, $2, 'MJZ-LEGACY-1', '2026-08-11', 'MJZ-LEGACY', 'draft') RETURNING id`, [orgId, companyId]);
    await pool.query(
      `INSERT INTO journal_entry_lines (organization_id, company_id, journal_entry_id, account_id, account_name, debit_amount, credit_amount)
       VALUES ($1, $2, $3, $4, 'Office', 0, 0), ($1, $2, $3, $5, 'Income', 0, 0)`, [orgId, companyId, e.id, office, income]);
    const r = await h.api("admin", "POST", `/journal-entries/${e.id}/approve`, {});
    const status = (await pool.query(`SELECT status FROM journal_entries WHERE id = $1`, [e.id])).rows[0].status;
    expect([r.status, r.body.code, status], JSON.stringify(r.body)).toEqual([422, "journal_entry_zero_amounts", "draft"]);
  });

  it("control: a real entry saves and posts; a 0.00 line beside real amounts is still allowed", async () => {
    const r = await entry("MJZ-REAL", [
      { accountId: office, debitAmount: 25, creditAmount: 0 },
      { accountId: income, debitAmount: 0, creditAmount: 25 },
      { accountId: office, debitAmount: 0, creditAmount: 0 },
    ]);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const posted = await h.api("admin", "POST", `/journal-entries/${r.body.id}/approve`, {});
    expect([posted.status, await count("MJZ-REAL")], JSON.stringify(posted.body)).toEqual([200, 1]);
  });
});
