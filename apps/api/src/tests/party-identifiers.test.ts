/**
 * 🔴 ITEM 3 (owner, 2026-11-25) — VAT AND CR NUMBERS FOR CUSTOMERS, SUPPLIERS AND MIGRATION IMPORT, ONE DEFINITION.
 *
 * The rules are the ones `lib/saudiIdentifiers.ts` already applies to the company record — no new rule:
 *   VAT registration number  /^3\d{13}3$/  (15 digits, starting and ending with 3)
 *   CR number                /^\d{10}$/     (10 digits)
 *  - applied only where the party is Saudi (its country SA, or unset — the record's default);
 *  - optional fields stay optional: a blank number is accepted;
 *  - checked on create, on edit (when the number is set or CHANGED) and on import; an existing record is never refused
 *    or rewritten — an edit that re-sends the stored number unchanged is accepted, the number left as it is;
 *  - refused 400 `party_identifier_invalid`, naming the number type and the reason, in English and Arabic.
 * DB-backed; skips on the placeholder.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, PERMISSION_MATRIX } from "@workspace/db";
import { primePermissionCache } from "../lib/rbac";
import { partyIdentifierFailures } from "../lib/saudiIdentifiers";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const describeDb = !!url && !url.includes("placeholder") ? describe : describe.skip;
const PW = "party-identifiers-password-2026";
const h = g04Harness("pid");
const VAT_OK = "300000000000003";
const CR_OK = "1010101010";

describe("the one definition (unit)", () => {
  it("valid Saudi numbers pass; blank passes; a party abroad is not checked", () => {
    expect(partyIdentifierFailures({ taxNumber: VAT_OK, crNumber: CR_OK, country: "SA" })).toEqual([]);
    expect(partyIdentifierFailures({ taxNumber: VAT_OK, crNumber: CR_OK, country: null })).toEqual([]);
    expect(partyIdentifierFailures({ taxNumber: null, crNumber: "", country: "SA" })).toEqual([]);
    expect(partyIdentifierFailures({ taxNumber: "GB123456789", crNumber: "12345", country: "GB" })).toEqual([]);
  });
  it("each failure names the number type and the reason", () => {
    const f = (taxNumber: string | null, crNumber: string | null = null) =>
      partyIdentifierFailures({ taxNumber, crNumber, country: "SA" }).map((x) => [x.field, x.identifier, x.reason]);
    expect(f("30000000000003")).toEqual([["taxNumber", "vat_number", "wrong_length"]]);
    expect(f("100000000000001")).toEqual([["taxNumber", "vat_number", "must_start_and_end_with_3"]]);
    expect(f("3000000000000A3")).toEqual([["taxNumber", "vat_number", "not_digits"]]);
    expect(f(null, "101010101")).toEqual([["crNumber", "cr_number", "wrong_length"]]);
    expect(f(null, "10101010-1")).toEqual([["crNumber", "cr_number", "not_digits"]]);
    const [one] = partyIdentifierFailures({ taxNumber: "30000000000003", crNumber: null, country: "SA" });
    expect(one.error).toContain("VAT registration number");
    expect(one.error).toContain("14 digits");
    expect(one.errorAr).toContain("الرقم الضريبي");
  });
});

describeDb("customers, suppliers and migration import — checked through their own routes", () => {
  let orgId = "";
  const ids: Record<string, number> = {};

  beforeAll(async () => {
    await h.cleanup();
    await h.start();
    primePermissionCache(PERMISSION_MATRIX);
    orgId = await h.mkOrg("org");
    await h.mkCompany(orgId, "Party Ids Co", "319393939393933");
    await h.mkUser("admin", PW, orgId, "admin");
    expect(await h.login("admin", h.email("admin"), PW)).toBe(200);
  }, 120_000);
  afterAll(async () => { await h.stop(); await h.cleanup(); });

  const refused = (r: { status: number; body: any }, field: string, identifier: string, reason: string) => {
    expect([r.status, r.body.code, r.body.field, r.body.identifier, r.body.reason]).toEqual([400, "party_identifier_invalid", field, identifier, reason]);
    expect(typeof r.body.errorAr).toBe("string");
  };

  for (const kind of ["customers", "vendors"] as const) {
    it(`🔴 ${kind} — create: valid numbers and blank are accepted; an invalid VAT or CR number of a Saudi party is refused by name; a party abroad is not checked`, async () => {
      const ok = await h.api("admin", "POST", `/${kind}`, { name: `${kind} valid`, taxNumber: VAT_OK, crNumber: CR_OK });
      expect(ok.status, ok.text).toBe(201);
      ids[kind] = ok.body.id;
      expect((await h.api("admin", "POST", `/${kind}`, { name: `${kind} blank` })).status).toBe(201);
      const before = Number((await pool.query(`SELECT count(*)::int n FROM ${kind} WHERE organization_id = $1`, [orgId])).rows[0].n);
      refused(await h.api("admin", "POST", `/${kind}`, { name: `${kind} bad vat`, taxNumber: "30000000000003" }), "taxNumber", "vat_number", "wrong_length");
      refused(await h.api("admin", "POST", `/${kind}`, { name: `${kind} bad cr`, crNumber: "101010101" }), "crNumber", "cr_number", "wrong_length");
      refused(await h.api("admin", "POST", `/${kind}`, { name: `${kind} bad vat sa`, taxNumber: "100000000000001", country: "SA" }), "taxNumber", "vat_number", "must_start_and_end_with_3");
      expect(Number((await pool.query(`SELECT count(*)::int n FROM ${kind} WHERE organization_id = $1`, [orgId])).rows[0].n)).toBe(before);
      const abroad = await h.api("admin", "POST", `/${kind}`, { name: `${kind} abroad`, taxNumber: "GB123456789", crNumber: "12345", country: "GB" });
      expect(abroad.status, abroad.text).toBe(201);
    });

    it(`🔴 ${kind} — edit: a changed number is checked; an existing invalid number re-sent unchanged is neither refused nor rewritten`, async () => {
      const id = ids[kind];
      refused(await h.api("admin", "PATCH", `/${kind}/${id}`, { taxNumber: "3000000000000A3" }), "taxNumber", "vat_number", "not_digits");
      expect((await pool.query(`SELECT tax_number FROM ${kind} WHERE id = $1`, [id])).rows[0].tax_number).toBe(VAT_OK);
      // a record stored before the rule, with an invalid number (as the old code allowed)
      await pool.query(`UPDATE ${kind} SET tax_number = '12345' WHERE id = $1`, [id]);
      const edit = await h.api("admin", "PATCH", `/${kind}/${id}`, { name: `${kind} renamed`, taxNumber: "12345" });
      expect(edit.status, edit.text).toBe(200);
      expect((await pool.query(`SELECT name, tax_number FROM ${kind} WHERE id = $1`, [id])).rows[0]).toEqual({ name: `${kind} renamed`, tax_number: "12345" });
      // and a valid correction is accepted
      expect((await h.api("admin", "PATCH", `/${kind}/${id}`, { taxNumber: VAT_OK })).status).toBe(200);
    });
  }

  it("🔴 import: invalid numbers are refused at import, every failing row named, nothing staged; valid and blank numbers stage", async () => {
    const batch = await h.api("admin", "POST", "/migration/batches", { sourceSystem: "PreviousERP", cutoverDate: "2026-07-01" });
    expect(batch.status, batch.text).toBe(201);
    const id = batch.body.id;
    const bad = await h.api("admin", "PUT", `/migration/batches/${id}/parties`, { rows: [
      { partyType: "customer", sourceId: "C1", name: "Good customer", taxNumber: VAT_OK, crNumber: CR_OK },
      { partyType: "customer", sourceId: "C2", name: "Bad VAT customer", taxNumber: "30000000000003" },
      { partyType: "vendor", sourceId: "V1", name: "Bad CR supplier", crNumber: "10101" },
    ] });
    expect([bad.status, bad.body.code]).toEqual([400, "party_identifier_invalid"]);
    expect((bad.body.rows as any[]).map((r) => [r.row, r.sourceId, r.identifier, r.reason])).toEqual([[1, "C2", "vat_number", "wrong_length"], [2, "V1", "cr_number", "wrong_length"]]);
    expect(bad.body.error).toContain("VAT registration number");
    expect(bad.body.errorAr).toContain("السجل التجاري");
    expect(Number((await pool.query(`SELECT count(*)::int n FROM migration_parties WHERE batch_id = $1`, [id])).rows[0].n)).toBe(0);
    const good = await h.api("admin", "PUT", `/migration/batches/${id}/parties`, { rows: [
      { partyType: "customer", sourceId: "C1", name: "Good customer", taxNumber: VAT_OK, crNumber: CR_OK },
      { partyType: "vendor", sourceId: "V2", name: "Blank supplier" },
    ] });
    expect(good.status, good.text).toBe(200);
    expect(Number((await pool.query(`SELECT count(*)::int n FROM migration_parties WHERE batch_id = $1`, [id])).rows[0].n)).toBe(2);
  });
});
