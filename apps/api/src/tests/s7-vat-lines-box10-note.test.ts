/**
 * 🔴 19B — THE VAT LINES REPORT DATA INHERITS THE BOX 10 FINDING, AND SAYS SO (owner, 2026-11-26: "if it shows which
 * return box a line falls in, mark that it inherits the box 10 finding until the VAT batch fixes it").
 *
 * The finding (docs/history/findings-and-lessons.md, "THE VAT RETURN'S BOX 10 TAKES EVERY ZERO-VAT PURCHASE"; open, not
 * fixed): a bill line carries no tax category, so the return files every purchase recorded with no VAT in box 10
 * (zero-rated purchases) — exempt and out-of-scope ones included — and box 11 (exempt purchases) is always 0. The VAT
 * lines report data shows each line's box, and its rows ARE the return's own addends, so it shows the same.
 *
 *  - it does inherit it: a purchase with no VAT, on an account whose purchases are out of scope, is a row in box 10;
 *  - it says so wherever the box is shown: the dataset's description carries the note (English and Arabic), and so do
 *    its CSV file's notes; no other dataset carries one.
 *
 * 🔴 WHEN THE VAT BATCH FIXES THE RETURN the first test goes red: that is the moment to take the note away, here and in
 * `lib/reports/datasets.ts` — not before, and not later.
 * DB-backed; skips on the placeholder.
 */
process.env.PORT ??= "3251";
process.env.SESSION_SECRET ??= "s7-vat-lines-box10-000000000000001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, PERMISSION_MATRIX } from "@workspace/db";
import { primePermissionCache } from "../lib/rbac";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const describeDb = !!url && !url.includes("placeholder") ? describe : describe.skip;
const PW = "s7-vat-lines-box10-password-26";
const h = g04Harness("s7box");
const WINDOW = "date_from=2026-10-01&date_to=2026-10-31";

describeDb("19B — the VAT lines report data says it inherits the box 10 finding", () => {
  let billId = 0;
  const ok = (r: { status: number; text: string; body: any }, status = 200) => { expect(r.status, r.text).toBe(status); return r.body; };

  beforeAll(async () => {
    await h.cleanup();
    await h.start();
    primePermissionCache(PERMISSION_MATRIX);
    const orgId = await h.mkOrg("org");
    await h.mkCompany(orgId, "S7 Box Ten Co", "319898989899023");
    for (const role of ["admin", "accountant", "viewer"]) await h.mkUser(role, PW, orgId, role);
    for (const role of ["admin", "accountant", "viewer"]) expect(await h.login(role, h.email(role), PW)).toBe(200);
    const vendor = ok(await h.api("admin", "POST", "/vendors", { name: "S7 Ministry", residency: "resident" }), 201);
    // a government fee: no VAT, and outside the scope of VAT altogether
    const bill = ok(await h.api("admin", "POST", "/bills", { supplierDocumentKind: "tax_invoice", vendorReference: "S7-FEE-1", billNumber: "S7-FEE-B1", date: "2026-10-06", dueDate: "2026-10-06", vendorId: vendor.id, items: [{ description: "Licence fee", quantity: 1, unitPrice: 750, vatRate: 0 }] }), 201);
    ok(await h.api("admin", "POST", `/bills/${bill.id}/approve`, {}));
    billId = bill.id;
    void pool;
  }, 180_000);
  afterAll(async () => { primePermissionCache(PERMISSION_MATRIX); await h.stop(); await h.cleanup(); });

  it("🔴 it inherits the finding (KNOWN, NOT FIXED): a purchase with no VAT is a row in box 10, and the return's box 10 is that row", async () => {
    const d = ok(await h.api("accountant", "GET", `/reports/datasets/vat_lines/rows?${WINDOW}`));
    const row = d.rows.find((r: any) => r.documentId === billId && r.side === "purchases");
    expect(row, JSON.stringify(d.rows)).toBeTruthy();
    expect([row.taxableBox, row.taxable, row.vat]).toEqual([10, 750, null]);
    const ret = ok(await h.api("admin", "GET", "/reports/vat-return?period_from=2026-10&period_to=2026-10"));
    expect(JSON.stringify(ret.purchasesSection)).toContain("750");
    const boxes = Object.entries(ret.purchasesSection as Record<string, number>);
    expect(boxes.find(([k]) => /^box10_/.test(k))?.[1]).toBe(750);
    expect(boxes.find(([k]) => /^box11_/.test(k))?.[1]).toBe(0);
  });

  it("🔴 it says so: the VAT lines description carries the note in English and Arabic, naming box 10 and box 11 — and no other report data carries one", async () => {
    const list = ok(await h.api("accountant", "GET", "/reports/datasets")).items as Array<{ name: string; caveat: string | null; caveatAr: string | null }>;
    const vat = list.find((i) => i.name === "vat_lines")!;
    expect(vat.caveat).toMatch(/box 10/);
    expect(vat.caveat).toMatch(/box 11/);
    expect(vat.caveat).toMatch(/no VAT/);
    expect(vat.caveatAr).toMatch(/الخانة 10/);
    expect(vat.caveatAr).toMatch(/الخانة 11/);
    expect(/[A-Za-z]{4,}/.test(vat.caveatAr!.replace(/VAT/g, ""))).toBe(false); // Arabic, not a copy of the English
    expect(list.filter((i) => i.name !== "vat_lines").map((i) => [i.name, i.caveat, i.caveatAr])).toEqual(list.filter((i) => i.name !== "vat_lines").map((i) => [i.name, null, null]));
    // a viewer is not offered VAT lines at all, so sees no note
    expect((ok(await h.api("viewer", "GET", "/reports/datasets")).items as Array<{ name: string }>).some((i) => i.name === "vat_lines")).toBe(false);
  });

  it("🔴 the file says so too: the CSV's notes carry it, in the file's language", async () => {
    const en = await h.api("accountant", "GET", `/reports/datasets/vat_lines/export?${WINDOW}`);
    const ar = await h.api("accountant", "GET", `/reports/datasets/vat_lines/export?${WINDOW}&lang=ar`);
    expect([en.status, ar.status]).toEqual([200, 200]);
    expect(en.text).toMatch(/box 10/);
    expect(ar.text).toMatch(/الخانة 10/);
    // another dataset's file carries no such note
    expect((await h.api("accountant", "GET", `/reports/datasets/purchase_documents/export?${WINDOW}`)).text).not.toMatch(/box 10/);
  });
});
