/**
 * 🔴 A ZERO-RATED, EXEMPT OR OUT-OF-SCOPE INVOICE LINE CARRIES ITS REASON FROM ZATCA'S CODE LIST (owner, 2026-11-21).
 *
 * Found by BR-KSA-49's live verification pass over real HTTP: the invoice API's line input had no exemption reason, so
 * the request validator dropped it — an onboarded company was refused at issuance for every Z/E/O invoice, and one not
 * onboarded issued it without its reason. The code list is ZATCA's (Electronic Invoice XML Implementation Standard
 * v1.2, §11.2.4, pp. 32–33), held once in @workspace/shared `vatExemptionReasons`.
 *
 * Over REAL HTTP, as the page sends it:
 *   - a Z line with a listed code is stored and returned with the code and ZATCA's own text;
 *   - a code not on the list, a code of another category, a code on a standard-rated line: refused by name (422);
 *   - an out-of-scope line keeps the taxpayer's own text (VATEX-SA-OOS is free text);
 *   - approval of a Z/E/O line WITHOUT its reason is refused by name in both languages, for a company not onboarded to
 *     ZATCA too, and NOTHING is issued (no ICV, no hash); an OOS line needs its text before approval;
 *   - the edit path (PATCH) carries the reason as create does;
 *   - movement: a standard-rated line issues as before.
 *
 * DB-backed (sl_test / CI); skips on the placeholder.
 */
process.env.PORT ??= "3227";
process.env.SESSION_SECRET ??= "zatca-exemption-reasons-test-secret-01";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";
process.env.MFA_ENFORCEMENT = "optional";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "ExemptionReasonPw1!";

describeMaybe("Z/E/O invoice lines carry their reason from ZATCA's code list, over HTTP", () => {
  const h = g04Harness("zexr");
  let orgId = "";
  let companyId = "";
  let citizen = 0;
  let business = 0;
  const line = (extra: Record<string, unknown>) => ({ description: "Line", quantity: 1, unitPrice: 1000, ...extra });
  const create = (customerId: number, items: unknown[]) => h.api("admin", "POST", "/invoices", { date: "2026-08-01", dueDate: "2026-08-31", customerId, items });
  const approve = async (id: number) => {
    const s = await h.api("admin", "POST", `/invoices/${id}/submit`);
    if (s.status !== 200) return s;
    return h.api("admin", "POST", `/invoices/${id}/approve`);
  };
  const issued = async (id: number) => (await pool.query(`SELECT icv, invoice_hash FROM invoices WHERE id = $1`, [id])).rows[0];

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("a");
    companyId = await h.mkCompany(orgId, "Al-Noor Private School", "310123456789013");
    await pool.query(`UPDATE companies SET building_number = '1234', street = 'King Fahd Road', district = 'Al Olaya', city = 'Riyadh', postal_code = '12345', additional_number = '6789' WHERE id = $1`, [companyId]);
    await h.mkUser("admin", PW, orgId, "admin");
    await h.start();
    expect(await h.login("admin", h.email("admin"), PW)).toBe(200);
    citizen = (await h.api("admin", "POST", "/customers", { name: "Abdulrahman Al-Harbi", nationalId: "1012345678" })).body.id;
    business = (await h.api("admin", "POST", "/customers", { name: "Gulf Exports Co", taxNumber: "311111111111113" })).body.id;
    expect(citizen && business, "anti-vacuity: both customers exist").toBeTruthy();
  }, 120_000);
  afterAll(async () => { await h.stop(); await h.cleanup(); });

  it("🔴 a zero-rated line with a listed code is stored and returned with the code and ZATCA's own text", async () => {
    const res = await create(citizen, [line({ vatRate: 0, taxCategoryCode: "Z", taxExemptionReasonCode: "VATEX-SA-EDU" })]);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const detail = await h.api("admin", "GET", `/invoices/${res.body.id}`);
    expect(detail.body.items[0]).toMatchObject({ taxCategoryCode: "Z", taxExemptionReasonCode: "VATEX-SA-EDU", taxExemptionReasonText: "Private education to citizen" });
  });

  for (const [label, item, code] of [
    ["a code not on ZATCA's list", { vatRate: 0, taxCategoryCode: "Z", taxExemptionReasonCode: "VATEX-SA-99" }, "line_exemption_reason_invalid"],
    ["an export code on an EXEMPT line", { vatRate: 0, taxCategoryCode: "E", taxExemptionReasonCode: "VATEX-SA-32" }, "line_exemption_reason_mismatch"],
    ["an exempt code on a ZERO-RATED line", { vatRate: 0, taxCategoryCode: "Z", taxExemptionReasonCode: "VATEX-SA-29" }, "line_exemption_reason_mismatch"],
    ["a reason on a STANDARD-rated line", { vatRate: 15, taxCategoryCode: "S", taxExemptionReasonCode: "VATEX-SA-32" }, "line_exemption_reason_mismatch"],
  ] as const) {
    it(`🔴 ${label} is refused by name`, async () => {
      const res = await create(business, [line(item)]);
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.body).toMatchObject({ code, errorAr: expect.any(String) });
    });
  }

  it("🔴 an out-of-scope line keeps the taxpayer's own text", async () => {
    const res = await create(business, [line({ vatRate: 0, taxCategoryCode: "O", taxExemptionReasonCode: "VATEX-SA-OOS", taxExemptionReasonText: "Reimbursed government fee, outside the scope of VAT" })]);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const detail = await h.api("admin", "GET", `/invoices/${res.body.id}`);
    expect(detail.body.items[0]).toMatchObject({ taxCategoryCode: "O", taxExemptionReasonCode: "VATEX-SA-OOS", taxExemptionReasonText: "Reimbursed government fee, outside the scope of VAT" });
    const ok = await approve(res.body.id);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  for (const [label, item] of [
    ["a zero-rated line with no reason", { vatRate: 0, taxCategoryCode: "Z" }],
    ["an exempt line with no reason", { vatRate: 0, taxCategoryCode: "E" }],
    ["an out-of-scope line with no text", { vatRate: 0, taxCategoryCode: "O", taxExemptionReasonCode: "VATEX-SA-OOS" }],
  ] as const) {
    it(`🔴 approval of ${label} is refused by name, in both languages, and nothing is issued`, async () => {
      const draft = await create(business, [line(item)]);
      expect(draft.status, `a draft may lack it: ${JSON.stringify(draft.body)}`).toBe(201);
      const res = await approve(draft.body.id);
      expect(res.status, JSON.stringify(res.body)).toBe(422);
      expect(res.body).toMatchObject({ code: "line_exemption_reason_missing", error: expect.any(String), errorAr: expect.any(String) });
      expect(await issued(draft.body.id), "no ICV, no hash").toEqual({ icv: null, invoice_hash: null });
    });
  }

  it("🔴 the edit path carries the reason as create does", async () => {
    const draft = await create(business, [line({ vatRate: 0, taxCategoryCode: "Z" })]);
    const patched = await h.api("admin", "PATCH", `/invoices/${draft.body.id}`, { items: [line({ vatRate: 0, taxCategoryCode: "Z", taxExemptionReasonCode: "VATEX-SA-32" })] });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    const detail = await h.api("admin", "GET", `/invoices/${draft.body.id}`);
    expect(detail.body.items[0]).toMatchObject({ taxCategoryCode: "Z", taxExemptionReasonCode: "VATEX-SA-32", taxExemptionReasonText: "Export of goods" });
    const ok = await approve(draft.body.id);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it("movement: a standard-rated line issues as before, with no reason", async () => {
    const draft = await create(business, [line({ vatRate: 15 })]);
    const ok = await approve(draft.body.id);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await issued(draft.body.id)).icv).not.toBeNull();
  });
});
