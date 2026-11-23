/**
 * 🔴 19B S3, the demo seed (owner 2026-11-23, item 1c; v4 §13.3): "create an accountant, and give the demo suppliers
 * IBANs through the hold, approved by that accountant, as v4 planned."
 *
 * `seedPartyIbanThroughHold` is how a raw-row seed gives a supplier or an employee an IBAN: a held change requested by
 * one member (its own transaction), then approved — and the IBAN written — by another member who can approve bank
 * details (a second transaction). The database decides exactly as it does for the product (0170); nothing is bypassed.
 *
 *  - presence: the accountant approves the admin's request — the IBAN is in place, the request approved, marked
 *    at_creation, naming both;
 *  - refusal beside it: the requester approving their own request, and a bookkeeper approving one, are refused by the
 *    database — the IBAN stays empty and the request stays pending (it was recorded; only the approval failed);
 *  - the employee kind as well;
 *  - its production caller: the demo seed calls it, with the demo accountant (standing check, part 1).
 *
 * DB-backed (sl_test / CI); skips on the DB-free placeholder.
 */
process.env.PORT ??= "3241";
process.env.SESSION_SECRET ??= "demo-seed-held-iban-0000000000001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, seedPartyIbanThroughHold } from "@workspace/db";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const describeDb = !!url && !url.includes("placeholder") ? describe : describe.skip;
const PW = "demo-seed-held-iban-password-2026";
const IBAN_A = "SA0380000000608010167519";
const IBAN_B = "SA4420000001234567891234";

describeDb("19B S3 — the demo seed's IBANs go through the hold (seedPartyIbanThroughHold)", () => {
  const h = g04Harness("dsiban");
  const ids: Record<string, number> = {};
  let orgId = "";
  let companyId = "";

  const vendor = async (name: string) =>
    (await pool.query(`INSERT INTO vendors (organization_id, name) VALUES ($1, $2) RETURNING id`, [orgId, name])).rows[0].id as number;
  const ibanOf = async (table: "vendors" | "employees", id: number) => (await pool.query(`SELECT iban FROM ${table} WHERE id = $1`, [id])).rows[0].iban as string | null;
  const requestsOf = async (column: "vendor_id" | "employee_id", id: number) =>
    (await pool.query(`SELECT status, requested_by, decided_by, at_creation, iban_before, iban_after FROM bank_detail_change_requests WHERE ${column} = $1 ORDER BY id`, [id])).rows;
  const hold = async (kind: "vendor_iban" | "employee_iban", subjectId: number, iban: string, approvedBy: number) => {
    const c = await pool.connect();
    try {
      return await seedPartyIbanThroughHold(c, { kind, organizationId: orgId, companyId, subjectId, iban, requestedBy: ids.admin!, approvedBy, atCreation: true });
    } finally {
      c.release();
    }
  };

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    companyId = await h.mkCompany(orgId, "Demo Seed IBAN Co", "319191919191943");
    for (const role of ["admin", "accountant", "bookkeeper"] as const) ids[role] = await h.mkUser(role, PW, orgId, role);
  }, 120_000);
  afterAll(async () => { await h.cleanup(); });

  it("🔴 the accountant approves the admin's request: the IBAN is in place, the request approved and marked at_creation, naming both", async () => {
    const v = await vendor("Demo Seed Supplier");
    await hold("vendor_iban", v, IBAN_A, ids.accountant!);
    expect(await ibanOf("vendors", v)).toBe(IBAN_A);
    expect(await requestsOf("vendor_id", v)).toEqual([
      { status: "approved", requested_by: ids.admin, decided_by: ids.accountant, at_creation: true, iban_before: null, iban_after: IBAN_A },
    ]);
  });

  it("🔴 the database refuses the requester's own approval, and a bookkeeper's: nothing is written, the request stays pending", async () => {
    for (const who of ["admin", "bookkeeper"] as const) {
      const v = await vendor(`Demo Seed Refused ${who}`);
      await expect(hold("vendor_iban", v, IBAN_B, ids[who]!)).rejects.toMatchObject({ constraint: "bank_detail_change_second_admin" });
      expect(await ibanOf("vendors", v)).toBeNull();
      expect((await requestsOf("vendor_id", v)).map((r) => [r.status, r.requested_by, r.decided_by])).toEqual([["pending", ids.admin, null]]);
    }
  });

  it("an employee's IBAN the same way", async () => {
    const e = (await pool.query(`INSERT INTO employees (organization_id, company_id, employee_number, name) VALUES ($1, $2, 'DSI-1', 'Demo Seed Employee') RETURNING id`, [orgId, companyId])).rows[0].id as number;
    await hold("employee_iban", e, IBAN_B, ids.accountant!);
    expect(await ibanOf("employees", e)).toBe(IBAN_B);
    expect((await requestsOf("employee_id", e)).map((r) => [r.status, r.decided_by])).toEqual([["approved", ids.accountant]]);
  });

  it("its production caller: the demo seed gives its suppliers IBANs through it, approved by the demo accountant", () => {
    const seed = readFileSync(fileURLToPath(new URL("../../../../scripts/src/demo-seed.mts", import.meta.url)), "utf8");
    expect(seed).toMatch(/seedPartyIbanThroughHold\(/);
    expect(seed).toMatch(/DEMO_ACCOUNTANT_EMAIL/);
    expect(seed).not.toMatch(/INSERT INTO vendors \([^)]*\biban\b/); // never written with the row
  });
});
