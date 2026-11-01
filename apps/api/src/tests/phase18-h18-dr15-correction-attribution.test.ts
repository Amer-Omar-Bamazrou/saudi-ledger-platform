/**
 * 🔴 Phase 18 H-18 — DR-15 (OD-5): a correction captures its attribution. The
 * mirror `journalEntriesService.reverse` writes carries, beside the reason and
 * the awareness date it already records (T1e): its classification (error /
 * estimate / policy), the fiscal year the ORIGINAL belongs to, the statement
 * authorisation covering that year, and the filed VAT return whose period holds
 * the original's date — as snapshots. DECIDED 2026-10-27 — owner accepted the
 * stated recommendation (register §11.73, the scoped D-4 statement, appended
 * before this file).
 *
 * Acts over HTTP. DB-backed (sl_test / CI); skips on the DB-free placeholder.
 */
process.env.PORT ??= "3269";
process.env.SESSION_SECRET ??= "phase18-h18-correction-attribution1";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { businessToday } from "@workspace/shared";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "Phase18H18AttrPw1!";

describeMaybe("Phase 18 H-18 — DR-15: a correction captures its attribution", () => {
  const h = g04Harness("p18h18att");
  const today = businessToday();
  const thisYear = Number(today.slice(0, 4));
  const lastYear = thisYear - 1;
  let orgId = "", expense = 0, income = 0, seq = 0;
  const posted = async (date: string) => {
    const r = await h.api("admin", "POST", "/journal-entries", { entryNumber: `H18-${++seq}`, date, description: `H18 original ${seq}`, lines: [
      { accountId: expense, accountName: "debit", debitAmount: 70, creditAmount: 0 },
      { accountId: income, accountName: "credit", debitAmount: 0, creditAmount: 70 },
    ] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect((await h.api("admin", "POST", `/journal-entries/${r.body.id}/approve`, {})).status).toBe(200);
    return r.body.id as number;
  };
  const mirrorRow = async (reversalId: number) => (await pool.query(
    `SELECT correction_kind, origin_fiscal_year_start::text AS fy_start, origin_fiscal_year_end::text AS fy_end, origin_authorised_on::text AS auth_on,
            origin_authorised_by AS auth_by, origin_vat_filing_reference AS vat_ref FROM journal_entries WHERE id = $1`, [reversalId])).rows[0];

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    await pool.query(`INSERT INTO companies (organization_id, name, fiscal_year_start, fiscal_calendar, vat_number, cr_number, ownership_type, vat_tax_period)
      VALUES ($1,'H18 Co',1,'gregorian','399999999999913','1010808081','SAUDI_GCC','quarterly')`, [orgId]);
    await h.mkUser("admin", PW, orgId, "admin");
    await h.start();
    expect(await h.login("admin", h.email("admin"), PW)).toBe(200);
    const acct = async (code: string) =>
      (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = $2 AND is_posting`, [orgId, code])).rows[0].id as number;
    expense = await acct("RENT_UTILITIES");
    income = await acct("OTHER_INCOME");
    // the records the attribution is read from (DR-10, built): last year's statements authorised in March; Q2 of last year filed in July
    const auth = await h.api("admin", "POST", "/statement-authorisations", { fiscalYearEnd: `${lastYear}-12-31`, authorisedOn: `${thisYear}-03-15`, authorisedBy: "The board of directors" });
    expect(auth.status, JSON.stringify(auth.body)).toBe(201);
    const filing = await h.api("admin", "POST", "/tax/vat-return-filings", { periodFrom: `${lastYear}-04`, periodTo: `${lastYear}-06`, filedOn: `${lastYear}-07-20`, zatcaReference: "ZF-H18-Q2" });
    expect(filing.status, JSON.stringify(filing.body)).toBe(201);
  }, 120_000);

  afterAll(async () => { await h.stop(); await h.cleanup(); });

  it("🔴 a classified correction of an entry in an authorised, filed year carries the kind, the year, the authorisation and the filing", async () => {
    const original = await posted(`${lastYear}-06-30`);
    const rev = await h.api("admin", "POST", `/journal-entries/${original}/reverse`, { reason: "Posted to the wrong account", correctionKind: "error", discoveredOn: today, date: today });
    expect(rev.status, JSON.stringify(rev.body)).toBe(200);
    const out = rev.body.reversal;
    expect([out.correctionKind, out.originFiscalYearStart, out.originFiscalYearEnd, out.originAuthorisedOn, out.originAuthorisedBy, out.originVatFilingReference])
      .toEqual(["error", `${lastYear}-01-01`, `${lastYear}-12-31`, `${thisYear}-03-15`, "The board of directors", "ZF-H18-Q2"]);
    // the read of the mirror carries the same
    const read = await h.api("admin", "GET", `/journal-entries/${out.id}`);
    expect([read.body.correctionKind, read.body.originAuthorisedBy, read.body.originVatFilingReference]).toEqual(["error", "The board of directors", "ZF-H18-Q2"]);
    // …and the row stores it (snapshots, not references)
    expect(await mirrorRow(out.id)).toEqual({ correction_kind: "error", fy_start: `${lastYear}-01-01`, fy_end: `${lastYear}-12-31`, auth_on: `${thisYear}-03-15`, auth_by: "The board of directors", vat_ref: "ZF-H18-Q2" });
    // …and the audit image of the mirror
    const image = (await pool.query(`SELECT after_state->>'correctionKind' AS k FROM audit_logs WHERE organization_id = $1 AND entity_type = 'journal_entry' AND action = 'create' AND entity_id = $2`, [orgId, String(out.id)])).rows;
    expect(image.map((r) => r.k)).toEqual(["error"]);
  });

  it("🔴 a kind outside error / estimate / policy is refused (400) — and nothing is reversed", async () => {
    const original = await posted(`${lastYear}-03-31`);
    const rev = await h.api("admin", "POST", `/journal-entries/${original}/reverse`, { reason: "typo", correctionKind: "mistake", date: today });
    expect(rev.status).toBe(400);
    expect((await pool.query(`SELECT status FROM journal_entries WHERE id = $1`, [original])).rows[0].status).toBe("posted");
  });

  it("🔴 an unclassified correction (a system one passes no kind) still carries the derived attribution; a year with no authorisation and no filing carries nulls there", async () => {
    const original = await posted(`${thisYear}-01-15`); // this year: not authorised, not filed
    const rev = await h.api("admin", "POST", `/journal-entries/${original}/reverse`, { reason: "duplicate", date: today });
    expect(rev.status, JSON.stringify(rev.body)).toBe(200);
    const out = rev.body.reversal;
    expect([out.correctionKind, out.originFiscalYearStart, out.originFiscalYearEnd, out.originAuthorisedOn, out.originVatFilingReference])
      .toEqual([null, `${thisYear}-01-01`, `${thisYear}-12-31`, null, null]);
  });
});
