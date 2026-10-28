/**
 * 🔴 Phase 18 H-1 — DR-24 (D-5), duplicate supplier invoices: "keep 'warn,
 * never refuse', and add the server-side warning in the API response
 * (contract G39's proposed control). Today the warning exists only in the UI
 * path." DECIDED 2026-10-27 — owner accepted the stated recommendation
 * (register §11.47, the scoped D-4 statement, appended before this file).
 *
 * A bill's create and update responses carry `possibleDuplicates`: what the
 * ONE existing definition (`duplicatesService.forBill`) finds for the bill as
 * saved. Never a refusal — the bill saves exactly as before.
 *
 * Acts over HTTP. DB-backed (sl_test / CI); skips on the DB-free placeholder.
 */
process.env.PORT ??= "3253";
process.env.SESSION_SECRET ??= "phase18-h1-dr24-duplicates-0001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "Phase18H1Dr24Pw1!";

describeMaybe("Phase 18 H-1 — DR-24: a bill's create and update responses warn of possible duplicates, server-side", () => {
  const h = g04Harness("p18h1dr24");
  let vendorId = 0, seq = 0, first = 0;
  type Dup = { reason: string; billId: number | null };
  const bill = (body: Record<string, unknown>) => h.api("admin", "POST", "/bills", {
    supplierDocumentKind: "tax_invoice", billNumber: `H1-${++seq}`, date: "2026-10-05", dueDate: "2026-10-30", vendorId,
    items: [{ description: "Stationery", quantity: 1, unitPrice: 1_000, vatRate: 0 }], ...body,
  });
  const dups = (b: { possibleDuplicates?: Dup[] }) => (b.possibleDuplicates ?? null) && b.possibleDuplicates!.map((d) => `${d.reason}:${d.billId}`);

  beforeAll(async () => {
    await h.cleanup();
    const orgId = await h.mkOrg("org");
    await pool.query(`INSERT INTO companies (organization_id, name, fiscal_year_start, fiscal_calendar, vat_number, cr_number, ownership_type) VALUES ($1,'H1 Co',1,'gregorian','399999999999993','1010303031','SAUDI_GCC')`, [orgId]);
    await h.mkUser("admin", PW, orgId, "admin");
    await h.start();
    expect(await h.login("admin", h.email("admin"), PW), "login admin").toBe(200);
    const v = await h.api("admin", "POST", "/vendors", { name: "H1 Riyadh Stationers", residency: "resident" });
    expect(v.status, JSON.stringify(v.body)).toBe(201);
    vendorId = v.body.id;
  }, 120_000);

  afterAll(async () => { await h.stop(); await h.cleanup(); });

  it("control: the first bill of its kind is created with an EMPTY warning list — none found, said as none", async () => {
    const r = await bill({ vendorReference: "INV-7" });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    first = r.body.id;
    expect(dups(r.body)).toEqual([]);
  });

  it("🔴 the same supplier's invoice number again: SAVED (a warning, never a refusal) — and the response names the earlier bill", async () => {
    const r = await bill({ vendorReference: " inv-7 ", date: "2026-10-06" });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.status, "saved as a draft, exactly as before").toBe("draft");
    expect(dups(r.body)).toContain(`same_supplier_invoice:${first}`);
    expect(dups(r.body), "never itself").not.toContain(`same_supplier_invoice:${r.body.id}`);
  });

  it("🔴 the same supplier, date and total under another number: the response names the earlier bill", async () => {
    const r = await bill({ vendorReference: "INV-8" });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(dups(r.body)).toContain(`same_supplier_date_amount:${first}`);
  });

  it("🔴 an UPDATE that makes a bill a duplicate warns in its response too", async () => {
    const r = await bill({ vendorReference: "INV-99", date: "2026-10-20", items: [{ description: "Paper", quantity: 1, unitPrice: 300, vatRate: 0 }] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(dups(r.body)).toEqual([]);
    const u = await h.api("admin", "PATCH", `/bills/${r.body.id}`, { vendorReference: "INV-7" });
    expect(u.status, JSON.stringify(u.body)).toBe(200);
    expect(dups(u.body)).toContain(`same_supplier_invoice:${first}`);
  });
});
