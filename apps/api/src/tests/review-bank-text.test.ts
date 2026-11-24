/**
 * 🔴 19B review follow-up, item 1 (owner, 2026-11-24): "Where a row can be built from a bank line, apply the same rule
 * (bank-derived or of unknown origin is bank_narrative)" — on every report and journal read that serves an entry's or a
 * line's text, by the row's TEXT ORIGIN (lib/fieldClasses/conditions.ts, repositories/entryTextOrigin.ts).
 *
 * On rows the product wrote: a bank row posted from a transaction; the same row RE-CATEGORISED, which reverses its entry
 * (the mirror copies the bank's text, with source `reversal`) and posts it again; a bank row on VAT_PAYMENT (it reaches
 * the tax journal); and a typed journal entry.
 *  - the SQL origin: the bank entry and its MIRROR are `bank_line`; the typed entry is `document`;
 *  - for a viewer WITHOUT the bank-text grant, every read serves no bank text — the mirror's included — while the typed
 *    text is still served (presence, absence); WITH the grant the same reads serve the bank text (movement); an
 *    accountant keeps it throughout.
 *
 * DB-backed (sl_test / CI); skips on the DB-free placeholder.
 */
process.env.PORT ??= "3243";
process.env.SESSION_SECRET ??= "review-bank-text-000000000000001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, PERMISSION_MATRIX, fieldGrantAction } from "@workspace/db";
import { primePermissionCache } from "../lib/rbac";
import { rowConditionApplies } from "../lib/fieldClasses/classTable";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const describeDb = !!url && !url.includes("placeholder") ? describe : describe.skip;
const PW = "review-bank-text-password-2026";
const BANK_TEXT = "RVWBANK SARIE 99117 AL-QASR";
const BANK_VAT_TEXT = "RVWBANK ZATCA SADAD 44120";
const TYPED_TEXT = "RVW typed accrual November";
const h = g04Harness("rvwbank");
const noViewerBankText = PERMISSION_MATRIX.filter((r) => !(r.role === "viewer" && r.resource === "journal_entries" && r.action === fieldGrantAction("bank_narrative", "read")));
// Restated for S2c's removal: the matrix itself lacks the viewer's grant now; the "WITH" half re-adds exactly that one grant.
const withViewerBankText = [...noViewerBankText, { role: "viewer" as const, resource: "journal_entries", action: fieldGrantAction("bank_narrative", "read") }];
const WINDOW = "date_from=2026-10-01&date_to=2026-10-31";

// 🔴 the SAFE ERROR, pinned (mutant V4 survived without it): a row that does not say where its text came from is bank text
describe("the row condition's safe error", () => {
  it("a row without its text origin — absent, null, or no row at all — is treated as bank text; a document's own text is not", () => {
    const c = { by: "textOrigin", in: ["bank_line", "unknown"] };
    expect([rowConditionApplies(c, undefined), rowConditionApplies(c, {}), rowConditionApplies(c, { textOrigin: null }), rowConditionApplies(c, { textOrigin: "bank_line" }), rowConditionApplies(c, { textOrigin: "unknown" })]).toEqual([true, true, true, true, true]);
    expect(rowConditionApplies(c, { textOrigin: "document" })).toBe(false);
  });
});

describeDb("19B review follow-up — bank text on every report and journal read, by the row's text origin", () => {
  let orgId = "";
  const ids: Record<string, number> = {};
  const reads: Array<{ name: string; path: () => string }> = [];

  beforeAll(async () => {
    await h.cleanup();
    await h.start();
    primePermissionCache(PERMISSION_MATRIX);
    orgId = await h.mkOrg("org");
    await h.mkCompany(orgId, "RVW Bank Text Co", "319191919191963");
    for (const role of ["admin", "accountant", "viewer"]) ids[`user_${role}`] = await h.mkUser(role, PW, orgId, role);
    for (const role of ["admin", "accountant", "viewer"]) expect(await h.login(role, h.email(role), PW)).toBe(200);
    const acct = async (code: string) => (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = $2 AND is_posting`, [orgId, code])).rows[0].id as number;
    ids.rent = await acct("RENT_UTILITIES");
    ids.office = await acct("OFFICE_SUPPLIES");
    const bank = await h.api("admin", "POST", "/bank-accounts", { name: "RVW Ops", bankName: "SNB", currency: "SAR" });
    expect(bank.status, JSON.stringify(bank.body)).toBe(201);
    const row = await h.api("admin", "POST", "/transactions", { date: "2026-10-10", description: BANK_TEXT, amount: 120, currency: "SAR", type: "debit", categoryId: ids.rent, bankAccountId: bank.body.id });
    expect(row.status, JSON.stringify(row.body)).toBe(201);
    ids.txn = row.body.id;
    ids.bankJe = (await pool.query(`SELECT id FROM journal_entries WHERE organization_id = $1 AND source_type = 'bank_transaction' ORDER BY id LIMIT 1`, [orgId])).rows[0].id;
    // re-categorised: the entry is reversed (the mirror copies the bank's text) and the row posted again
    const recat = await h.api("admin", "PATCH", `/transactions/${ids.txn}`, { categoryId: ids.office });
    expect(recat.status, JSON.stringify(recat.body)).toBe(200);
    const mirror = (await pool.query(`SELECT id, source_type FROM journal_entries WHERE organization_id = $1 AND reversal_of = $2`, [orgId, ids.bankJe])).rows[0];
    expect(mirror?.source_type, "the re-categorisation reversed the bank entry").toBe("reversal");
    ids.mirrorJe = mirror.id;
    const vat = await h.api("admin", "POST", "/transactions", { date: "2026-10-12", description: BANK_VAT_TEXT, amount: 300, currency: "SAR", type: "debit", categoryId: await acct("VAT_PAYMENT"), bankAccountId: bank.body.id });
    expect(vat.status, JSON.stringify(vat.body)).toBe(201);
    const je = await h.api("admin", "POST", "/journal-entries", { date: "2026-10-15", description: TYPED_TEXT, lines: [
      { accountId: ids.rent, accountName: "Rent & Utilities", debitAmount: 50, creditAmount: 0, description: TYPED_TEXT },
      { accountId: await acct("ACCRUED_LIABILITIES"), accountName: "Accrued Liabilities", debitAmount: 0, creditAmount: 50, description: TYPED_TEXT },
    ] });
    expect(je.status, JSON.stringify(je.body)).toBe(201);
    expect((await h.api("admin", "POST", `/journal-entries/${je.body.id}/approve`, {})).status).toBe(200);
    ids.typedJe = je.body.id;
    reads.push(
      { name: "general ledger", path: () => `/reports/general-ledger?account_id=${ids.rent}&${WINDOW}` },
      { name: "account statement", path: () => `/reports/account-statement?account_id=${ids.rent}&${WINDOW}` },
      { name: "journal report", path: () => `/reports/journal-report?${WINDOW}` },
      { name: "tax journal entries", path: () => `/reports/tax-journal-entries?${WINDOW}` },
      { name: "activity", path: () => `/reports/activity?${WINDOW}` },
      { name: "journal entries list", path: () => `/journal-entries?limit=200` },
      { name: "a bank entry", path: () => `/journal-entries/${ids.bankJe}` },
      { name: "its mirror", path: () => `/journal-entries/${ids.mirrorJe}` },
      { name: "the journal-lines dataset", path: () => `/reports/datasets/journal_lines/rows?${WINDOW}&limit=500` },
      { name: "the general ledger's export", path: () => `/reports/export/general-ledger?format=csv&account_id=${ids.rent}&${WINDOW}` },
    );
  }, 120_000);
  afterAll(async () => { primePermissionCache(PERMISSION_MATRIX); await h.stop(); await h.cleanup(); });

  it("🔴 the SQL origin: the bank entry and its MIRROR are bank lines; the typed entry is a document's own text", async () => {
    const { entryTextOriginRepository } = await import("../repositories/entryTextOrigin");
    const companyId = (await pool.query(`SELECT id FROM companies WHERE organization_id = $1`, [orgId])).rows[0].id as string;
    const origins = await h.inTenant(orgId, companyId, ids.user_admin!, () => entryTextOriginRepository.textOrigins([ids.bankJe!, ids.mirrorJe!, ids.typedJe!]));
    expect([origins.get(ids.bankJe!), origins.get(ids.mirrorJe!), origins.get(ids.typedJe!)]).toEqual(["bank_line", "bank_line", "document"]);
    // the same fact through the served rows: the mirror's detail says bank_line
    const mirror = await h.api("accountant", "GET", `/journal-entries/${ids.mirrorJe}`);
    const typed = await h.api("accountant", "GET", `/journal-entries/${ids.typedJe}`);
    expect([mirror.body.textOrigin, mirror.body.lines[0].textOrigin, typed.body.textOrigin]).toEqual(["bank_line", "bank_line", "document"]);
    expect(mirror.text).toContain(BANK_TEXT); // the mirror really carries the bank's text
  });

  it("🔴 WITHOUT the grant: no read serves the bank's text — the mirror's included — and the typed text is still served", async () => {
    primePermissionCache(noViewerBankText);
    const leaks: string[] = [];
    for (const r of reads) {
      const res = await h.api("viewer", "GET", r.path());
      expect([r.name, res.status]).toEqual([r.name, 200]);
      for (const text of [BANK_TEXT, BANK_VAT_TEXT]) if (res.text.includes(text)) leaks.push(`${r.name}: ${text}`);
    }
    expect(leaks).toEqual([]);
    // presence: the typed text is served where the read covers it
    for (const name of ["general ledger", "account statement", "journal report", "activity", "journal entries list", "the journal-lines dataset", "the general ledger's export"]) {
      const res = await h.api("viewer", "GET", reads.find((x) => x.name === name)!.path());
      expect([name, res.text.includes(TYPED_TEXT)]).toEqual([name, true]);
    }
    primePermissionCache(PERMISSION_MATRIX);
  });

  it("🔴 WITH the grant the same reads serve the bank's text (movement), and the accountant keeps it under the narrowed matrix", async () => {
    primePermissionCache(withViewerBankText);
    for (const r of reads) {
      const res = await h.api("viewer", "GET", r.path());
      const expected = r.name === "tax journal entries" ? BANK_VAT_TEXT : BANK_TEXT;
      expect([r.name, res.text.includes(expected)]).toEqual([r.name, true]);
    }
    primePermissionCache(noViewerBankText);
    const acc = await h.api("accountant", "GET", reads[0]!.path());
    expect(acc.text.includes(BANK_TEXT)).toBe(true);
    primePermissionCache(PERMISSION_MATRIX);
  });
});
