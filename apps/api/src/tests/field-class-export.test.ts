/**
 * 🔴 19B S2a (owner, 2026-11-22; v4 D11 amended) — THE LEDGER EXPORT'S BANK TEXT IS PROTECTED, as D1 and D9 require.
 *
 * A general-ledger line whose entry came from a bank row (`bank_transaction`) carries the bank's own text; a role
 * without `field.bank_narrative.read` on journal entries gets a marker in that cell, and a note saying cells were
 * withheld — never the text. A line from any other source (here a typed journal entry) keeps its text. Under S1's
 * matrix nothing changes: both texts are in the file. Movement: restoring the grant restores the text.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, PERMISSION_MATRIX, fieldGrantAction } from "@workspace/db";
import { primePermissionCache } from "../lib/rbac";
import { isBankDerivedEntry } from "../lib/fieldClasses/conditions";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const describeDb = !!url && !url.includes("placeholder") ? describe : describe.skip;
const PW = "field-class-export-password-2026";
const h = g04Harness("fc-export");
const BANK_TEXT = "BANKTEXT POS 4412 AL-NAHDI";
const TYPED_TEXT = "Typed accrual for October";
const withoutViewerBankText = PERMISSION_MATRIX.filter((r) => !(r.role === "viewer" && r.resource === "journal_entries" && r.action === fieldGrantAction("bank_narrative", "read")));
const GL = "/reports/export/general-ledger?format=csv&date_from=2026-10-01&date_to=2026-10-31";

describe("the bank-text condition", () => {
  it("bank_transaction and legacy (unknown) entries are bank text; every other source writes its own", () => {
    expect(["bank_transaction", "legacy_unclassified", null].map(isBankDerivedEntry)).toEqual([true, true, true]);
    expect(["manual", "invoice", "payroll_run", "bank_transfer"].map(isBankDerivedEntry)).toEqual([false, false, false, false]);
  });
});

describeDb("19B S2a — the general-ledger export withholds bank text by class", () => {
  beforeAll(async () => {
    await h.cleanup();
    await h.start();
    primePermissionCache(PERMISSION_MATRIX);
    const orgId = await h.mkOrg("org");
    await h.mkCompany(orgId, "FC Export Co", "319191919191993");
    for (const role of ["admin", "viewer"]) await h.mkUser(role, PW, orgId, role);
    for (const role of ["admin", "viewer"]) expect(await h.login(role, h.email(role), PW)).toBe(200);
    const bank = await h.api("admin", "POST", "/bank-accounts", { name: "FC Ops", bankName: "SNB", currency: "SAR" });
    expect(bank.status, JSON.stringify(bank.body)).toBe(201);
    const acct = async (code: string) => (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = $2 AND is_posting`, [orgId, code])).rows[0].id as number;
    const row = await h.api("admin", "POST", "/transactions", { date: "2026-10-10", description: BANK_TEXT, amount: 120, currency: "SAR", type: "debit", categoryId: await acct("RENT_UTILITIES"), bankAccountId: bank.body.id });
    expect(row.status, JSON.stringify(row.body)).toBe(201);
    const je = await h.api("admin", "POST", "/journal-entries", { date: "2026-10-15", description: TYPED_TEXT, lines: [
      { accountId: await acct("RENT_UTILITIES"), accountName: "Rent & Utilities", debitAmount: 50, creditAmount: 0, description: TYPED_TEXT },
      { accountId: await acct("ACCRUED_LIABILITIES"), accountName: "Accrued Liabilities", debitAmount: 0, creditAmount: 50, description: TYPED_TEXT },
    ] });
    expect(je.status, JSON.stringify(je.body)).toBe(201);
    expect((await h.api("admin", "POST", `/journal-entries/${je.body.id}/approve`, {})).status).toBe(200);
    const sources = (await pool.query(`SELECT DISTINCT source_type FROM journal_entries WHERE organization_id = $1`, [orgId])).rows.map((r) => r.source_type).sort();
    expect(sources).toEqual(["bank_transaction", "manual"]); // the fixture really has both kinds
  });
  afterAll(async () => { primePermissionCache(PERMISSION_MATRIX); await h.stop(); await h.cleanup(); });

  it("🔴 S1's matrix: the viewer's export carries both texts, and no withheld note", async () => {
    primePermissionCache(PERMISSION_MATRIX);
    const r = await h.api("viewer", "GET", GL);
    expect(r.status).toBe(200);
    expect(r.text).toContain(BANK_TEXT);
    expect(r.text).toContain(TYPED_TEXT);
    expect(r.text).not.toContain("withheld");
  });

  it("🔴 without the grant: the bank line's text is a marker, the typed line's text stays, and the file says cells were withheld", async () => {
    primePermissionCache(withoutViewerBankText);
    const r = await h.api("viewer", "GET", GL);
    expect(r.status).toBe(200);
    expect(r.text).not.toContain(BANK_TEXT);
    expect(r.text).toContain("[withheld: bank text]");
    expect(r.text).toContain(TYPED_TEXT);
    expect(r.text).toMatch(/cell\(s\) are withheld for your role \(bank_narrative\)/);
    const ar = await h.api("viewer", "GET", `${GL}&lang=ar`);
    expect(ar.text).toContain("[محجوب: نص كشف البنك]");
    expect(ar.text).not.toContain(BANK_TEXT);
    // movement: the admin, whose grant was not removed, still gets the text; restoring the viewer's grant restores it
    expect((await h.api("admin", "GET", GL)).text).toContain(BANK_TEXT);
    primePermissionCache(PERMISSION_MATRIX);
    expect((await h.api("viewer", "GET", GL)).text).toContain(BANK_TEXT);
  });
});
