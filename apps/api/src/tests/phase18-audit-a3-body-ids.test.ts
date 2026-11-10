/**
 * 🔴 Phase 18 audit (2026-11-09), finding A3 — an id that no integer column could hold gets the route's OWN refusal,
 * never a 500.
 *
 * Sweep 3b sent 2147483648 (one past an integer column's maximum) in every id field of every Phase 18 route. Three
 * answered 500: `POST /payroll/:id/pay` and `POST /payroll/:id/gosi/pay` (bankAccountId) and `POST /tax/wht/refund-claims`
 * (vendorId). Each route already refuses -1 by name (422 invalid_reference / reference_not_found); its guard checked
 * "whole and positive" but not "inside an integer column", so a too-large id reached the query and Postgres's 22003
 * reached the error handler. The report is a sample: the same incomplete guard stood at 27 sites. Each now uses
 * `isIntegerId` (lib/inputGuards), and a source ratchet refuses the incomplete forms.
 *
 * (A first attempt refused body ids at the request boundary; it pre-empted routes that answer such an id with their
 * own refusal — phase18-z2-refusals-not-500 asserts 422 vendor_unknown — and was reverted.)
 *
 * DB-backed for the three routes (sl_test / CI); the ratchet runs everywhere.
 */
process.env.PORT ??= "3396";
process.env.SESSION_SECRET ??= "phase18-audit-a3-body-ids-0000000000001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "AuditA3BodyIdsPw12345!";
const TOO_BIG = 2_147_483_648;

describe("Phase 18 audit A3 — the source ratchet: an id guard checks the column's range, not only the sign", () => {
  const SRC = fileURLToPath(new URL("..", import.meta.url));
  /** `!Number.isInteger(x) || x <= 0` and `Number.isInteger(x) && x > 0` — the guard that lets 2147483648 through. */
  const INCOMPLETE = /!Number\.isInteger\(([\w.]+)\) \|\| \1 <= 0|Number\.isInteger\(([\w.]+)\) && \2 > 0(?! && \2 <=)/g;
  const files = (d: string): string[] => readdirSync(d).flatMap((n) => {
    const p = join(d, n);
    if (statSync(p).isDirectory()) return n === "tests" || n === "generated" ? [] : files(p);
    return /\.ts$/.test(n) ? [p] : [];
  });

  it("the detector sees the incomplete forms (known-present) and not the complete one (known-absent)", () => {
    expect("if (!Number.isInteger(id) || id <= 0) throw x;".match(INCOMPLETE)).toHaveLength(1);
    expect("const ok = Number.isInteger(vendorId) && vendorId > 0 ? a : b;".match(INCOMPLETE)).toHaveLength(1);
    expect("return Number.isInteger(id) && id > 0 && id <= MAX_INTEGER_ID;".match(INCOMPLETE)).toBeNull();
    expect("if (!isIntegerId(id)) throw x;".match(INCOMPLETE)).toBeNull();
  });

  it("🔴 no id guard in the API's source stops at the sign", () => {
    const all = files(SRC);
    expect(all.length, "the walk found the source").toBeGreaterThan(200);
    const found = all.flatMap((f) => (readFileSync(f, "utf8").match(INCOMPLETE) ?? []).map((m) => `${f.slice(SRC.length)}: ${m}`));
    expect(found).toEqual([]);
  });
});

describeMaybe("Phase 18 audit A3 — the three routes that answered 500 now give their own refusal", () => {
  const h = g04Harness("auda3");

  beforeAll(async () => {
    await h.cleanup();
    const orgId = await h.mkOrg("org");
    await pool.query(
      `INSERT INTO companies (organization_id, name, cr_number, vat_number, fiscal_year_start, building_number, street, district, city, postal_code, additional_number)
       VALUES ($1,'Audit A3 Co','1010868391','310123456789013',1,'1234','King Fahd Road','Al Olaya','Riyadh','12345','6789')`, [orgId]);
    await h.mkUser("admin", PW, orgId, "admin");
    await h.start();
    expect(await h.login("admin", h.email("admin"), PW), "login admin").toBe(200);
  }, 120_000);

  afterAll(async () => { await h.stop(); await h.cleanup(); });

  const checklistItem = { held: true, note: "checked" };
  const refund = (vendorId: unknown) => ({
    period: "2026-10", vendorId, overpaidTaxYear: 2025, excessAmount: 100, borneBy: "payer", reason: "Withheld at the wrong rate",
    checklist: { contractAndInvoice: checklistItem, correctCategoryAndRate: checklistItem, originalStatementAndReceipt: checklistItem,
      reconciliation: checklistItem, whoBoreTheExcess: checklistItem, beneficiaryAuthorisation: checklistItem },
  });
  const cases: Array<[string, (v: unknown) => Record<string, unknown>, string, string]> = [
    ["/payroll/1/pay", (v) => ({ bankAccountId: v }), "bankAccountId", "invalid_reference"],
    ["/payroll/1/gosi/pay", (v) => ({ bankAccountId: v }), "bankAccountId", "invalid_reference"],
    ["/tax/wht/refund-claims", refund, "vendorId", "reference_not_found"],
  ];
  for (const [path, body, field, code] of cases) {
    it(`🔴 POST ${path}: ${field} = ${TOO_BIG} is refused exactly as ${field} = -1 is (422 ${code}), never 500`, async () => {
      const control = await h.api("admin", "POST", path, body(-1));
      expect([control.status, control.body?.code, control.body?.field], `the route's own refusal: ${JSON.stringify(control.body)}`).toEqual([422, code, field]);
      const r = await h.api("admin", "POST", path, body(TOO_BIG));
      expect([r.status, r.body?.code, r.body?.field], JSON.stringify(r.body)).toEqual([422, code, field]);
    });
  }
});
