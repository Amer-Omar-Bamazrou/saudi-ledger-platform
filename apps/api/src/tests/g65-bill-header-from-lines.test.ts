/**
 * 🔴 G65 — REGRESSION (owner decision DR-07(b), 2026-10-20): a bill WITH LINES
 * carries the header its lines make.
 *
 * PATCH /bills/:id stored `subtotal`, `vatAmount` and `total` verbatim even
 * when the bill had lines, and approval posts the HEADER (GL, input-VAT
 * events) while the VAT return sums the LINES — so one edit made the GL, the
 * events and the return disagree (reproduced, Batch 4B; the proof
 * `phase18-s1b-g65-bill-header-patch.test.ts` lands unchanged beside this
 * file). The header of a lined bill is now recomputed from its stored lines on
 * every edit; a bill without lines keeps the header it states.
 *
 * Invariants, four ways and non-zero: header = Σ lines; after approval the GL
 * VAT = Σ line VAT = the input-VAT events, and the GL AP = Σ line totals.
 * Also: an approved bill's figures never move; another organisation's bill is
 * refused (404).
 *
 * DB-backed (sl_test / CI); skips on the DB-free placeholder.
 */
process.env.PORT ??= "3206";
process.env.SESSION_SECRET ??= "g65-bill-header-from-lines-regression-01";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "G65RegressionPw123!";

describeMaybe("G65 — a bill with lines carries the header its lines make", () => {
  const h = g04Harness("g65reg");
  let orgId = "";
  let otherOrgId = "";
  let vendorId = 0;
  let otherVendorId = 0;
  let seq = 0;

  async function draft(who: string, vendor: number, withLines: boolean) {
    seq += 1;
    const no = `G65REG-B${seq}`;
    const body: Record<string, unknown> = { supplierDocumentKind: "tax_invoice", vendorReference: `${no}-SUP`, billNumber: no, date: "2026-09-10", dueDate: "2026-09-30", vendorId: vendor };
    if (withLines) body.items = [{ description: "Service A", quantity: 2, unitPrice: 300, vatRate: 15 }, { description: "Service B", quantity: 1, unitPrice: 400, vatRate: 15 }];
    else Object.assign(body, { subtotal: 500, vatAmount: 0, total: 500 });
    const r = await h.api(who, "POST", "/bills", body);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return { id: r.body.id as number, no };
  }
  const header = async (id: number) => (await pool.query(`SELECT subtotal::text AS s, vat_amount::text AS v, total::text AS t, status FROM bills WHERE id = $1`, [id])).rows[0];
  const lines = async (id: number) => (await pool.query(
    `SELECT coalesce(sum(total - vat_amount), 0)::text AS s, coalesce(sum(vat_amount), 0)::text AS v, coalesce(sum(total), 0)::text AS t FROM bill_items WHERE bill_id = $1`, [id],
  )).rows[0];

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    await h.mkCompany(orgId, "G65 Regression Co", "318181818181890");
    otherOrgId = await h.mkOrg("other");
    await h.mkCompany(otherOrgId, "G65 Other Co", "318181818181891");
    vendorId = (await pool.query(`INSERT INTO vendors (organization_id, name, tax_number) VALUES ($1,'G65 Supplier','300000000000003') RETURNING id`, [orgId])).rows[0].id;
    otherVendorId = (await pool.query(`INSERT INTO vendors (organization_id, name, tax_number) VALUES ($1,'G65 Other Supplier','300000000000003') RETURNING id`, [otherOrgId])).rows[0].id;
    for (const [who, role] of [["admin", "admin"], ["bookkeeper", "bookkeeper"]]) await h.mkUser(who, PW, orgId, role);
    await h.mkUser("otheradmin", PW, otherOrgId, "admin");
    await h.start();
    for (const who of ["admin", "bookkeeper", "otheradmin"]) expect(await h.login(who, h.email(who), PW), `login ${who}`).toBe(200);
  }, 120_000);
  afterAll(async () => { await h.stop(); await h.cleanup(); });

  it("🔴 a header total sent for a bill WITH LINES is not stored: the header is recomputed from the lines (1,000.00 + 150.00 = 1,150.00), and the approval posts the lines' figures four ways", async () => {
    const b = await draft("bookkeeper", vendorId, true);
    const r = await h.api("bookkeeper", "PATCH", `/bills/${b.id}`, { subtotal: 1_200, vatAmount: 180, total: 1_380, notes: "edited" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await header(b.id)).toMatchObject({ s: "1000.00", v: "150.00", t: "1150.00" });
    expect(await lines(b.id)).toEqual({ s: "1000.00", v: "150.00", t: "1150.00" });
    expect((await h.api("admin", "POST", `/bills/${b.id}/approve`, {})).status).toBe(200);
    const gl = (await pool.query(
      `SELECT coalesce(sum(l.debit_amount - l.credit_amount) FILTER (WHERE c.system_code IN ('VAT_INPUT','VAT_AWAITING_EVIDENCE')), 0)::text AS vat,
              coalesce(sum(l.credit_amount - l.debit_amount) FILTER (WHERE c.system_code = 'AP'), 0)::text AS ap
         FROM journal_entry_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN categories c ON c.id = l.account_id
        WHERE e.organization_id = $1 AND e.status IN ('posted','reversed') AND e.entry_number = $2`, [orgId, `BILL-${b.no}`],
    )).rows[0];
    const events = Number((await pool.query(`SELECT coalesce(sum(amount), 0)::text AS a FROM input_vat_events WHERE document_id = $1`, [b.id])).rows[0].a);
    expect([Number(gl.vat), events, Number(gl.ap)], "GL VAT = events = Σ line VAT; GL AP = Σ line totals").toEqual([150, 150, 1_150]);
  }, 60_000);

  it("an edit of another field keeps a lined bill's header equal to its lines", async () => {
    const b = await draft("bookkeeper", vendorId, true);
    expect((await h.api("bookkeeper", "PATCH", `/bills/${b.id}`, { notes: "just a note" })).status).toBe(200);
    expect(await header(b.id)).toMatchObject({ s: "1000.00", v: "150.00", t: "1150.00" });
  }, 60_000);

  it("CONTROL: a bill WITHOUT lines keeps the header it states (unchanged behaviour)", async () => {
    const b = await draft("bookkeeper", vendorId, false);
    expect((await h.api("bookkeeper", "PATCH", `/bills/${b.id}`, { subtotal: 750, vatAmount: 0, total: 750 })).status).toBe(200);
    expect(await header(b.id)).toMatchObject({ s: "750.00", v: "0.00", t: "750.00" });
  }, 60_000);

  it("an APPROVED bill's figures never move: its PATCH is refused (409) and its header and lines read the same before and after", async () => {
    const b = await draft("bookkeeper", vendorId, true);
    expect((await h.api("admin", "POST", `/bills/${b.id}/approve`, {})).status).toBe(200);
    const before = [await header(b.id), await lines(b.id)];
    expect((await h.api("bookkeeper", "PATCH", `/bills/${b.id}`, { subtotal: 1, vatAmount: 0, total: 1 })).status).toBe(409);
    expect([await header(b.id), await lines(b.id)]).toEqual(before);
  }, 60_000);

  it("ISOLATION: another organisation's bill is not found (404), and it is untouched", async () => {
    const foreign = await draft("otheradmin", otherVendorId, true);
    const before = await header(foreign.id);
    expect((await h.api("bookkeeper", "PATCH", `/bills/${foreign.id}`, { notes: "cross-tenant" })).status).toBe(404);
    expect(await header(foreign.id)).toEqual(before);
  }, 60_000);
});
