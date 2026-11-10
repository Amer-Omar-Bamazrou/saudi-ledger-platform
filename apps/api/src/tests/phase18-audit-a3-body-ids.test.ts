/**
 * 🔴 Phase 18 audit (2026-11-09), finding A3 — an id in a request BODY that no integer column could hold is refused
 * at the request boundary, as #306 refuses one in the path.
 *
 * Sweep 3b sent 2147483648 (one past an integer column's maximum) in every id field of every Phase 18 route. Three
 * answered 500: `POST /payroll/:id/pay` and `POST /payroll/:id/gosi/pay` (bankAccountId) and `POST /tax/wht/refund-claims`
 * (vendorId) — Postgres's 22003 reaching the error handler. #306 fixed the class for path ids and NUL; a body id was
 * still each route's to remember. `refuseUnusableInput` now refuses a body field named `id`, `…Id` or `…Ids` holding a
 * number (or numeric text) no integer column can hold, naming the field — before any route runs.
 *
 * DB-backed for the three routes (sl_test / CI); the detector's own cases run everywhere.
 */
process.env.PORT ??= "3396";
process.env.SESSION_SECRET ??= "phase18-audit-a3-body-ids-0000000000001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "AuditA3BodyIdsPw12345!";
const TOO_BIG = 2_147_483_648;

describe("Phase 18 audit A3 — the body-id detector", () => {
  it("names the first id field no integer column can hold (known-present), and passes everything else (known-absent)", async () => {
    const mod = (await import("../middleware/refuseUnusableInput")) as Record<string, unknown>;
    expect(typeof mod.firstImpossibleIdField, "the boundary exports its body-id detector").toBe("function");
    const firstImpossibleIdField = mod.firstImpossibleIdField as (v: unknown) => string | null;
    expect(firstImpossibleIdField({ bankAccountId: TOO_BIG })).toBe("bankAccountId");
    expect(firstImpossibleIdField({ lines: [{ accountId: 1 }, { accountId: TOO_BIG }] })).toBe("lines.1.accountId");
    expect(firstImpossibleIdField({ assetIds: [1, TOO_BIG] })).toBe("assetIds.1");
    expect(firstImpossibleIdField({ id: -TOO_BIG })).toBe("id");
    expect(firstImpossibleIdField({ vendorId: "2147483648" })).toBe("vendorId");
    expect(firstImpossibleIdField({ vendorId: 1.5 })).toBe("vendorId");
    // absent: in range, not an id, not a number, a UUID
    expect(firstImpossibleIdField({ bankAccountId: 2_147_483_647, amount: 1e12, companyId: "3f9a6a52-1c3b-4b8e-9d7f-0a1b2c3d4e5f" })).toBeNull();
    expect(firstImpossibleIdField({ vendorId: "abc", paid: TOO_BIG, valid: true })).toBeNull();
    expect(firstImpossibleIdField(null)).toBeNull();
  });
});

describeMaybe("Phase 18 audit A3 — the three routes that answered 500 now answer 400, naming the field", () => {
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
  const cases: Array<[string, string, Record<string, unknown>, string]> = [
    ["POST", "/payroll/1/pay", { bankAccountId: TOO_BIG }, "bankAccountId"],
    ["POST", "/payroll/1/gosi/pay", { bankAccountId: TOO_BIG }, "bankAccountId"],
    ["POST", "/tax/wht/refund-claims", {
      period: "2026-10", vendorId: TOO_BIG, overpaidTaxYear: 2025, excessAmount: 100, borneBy: "payer", reason: "Withheld at the wrong rate",
      checklist: { contractAndInvoice: checklistItem, correctCategoryAndRate: checklistItem, originalStatementAndReceipt: checklistItem,
        reconciliation: checklistItem, whoBoreTheExcess: checklistItem, beneficiaryAuthorisation: checklistItem },
    }, "vendorId"],
  ];
  for (const [method, path, body, field] of cases) {
    it(`🔴 ${method} ${path} with ${field} = ${TOO_BIG}: 400 invalid_id_in_body naming ${field}, never 500`, async () => {
      const r = await h.api("admin", method, path, body);
      expect([r.status, r.body?.code, r.body?.field], JSON.stringify(r.body)).toEqual([400, "invalid_id_in_body", field]);
    });
  }
});
