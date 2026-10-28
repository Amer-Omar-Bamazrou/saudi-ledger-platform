/**
 * 🔴 Phase 18 G2b — owner decision A5(c) (2026-10-27; register §11.30 and
 * §11.39): "filing a VAT return is recorded by an entry clearing output VAT and
 * input VAT to VAT payable (or receivable)". DECIDED 2026-10-27: an owner
 * decision based on research, not a professional opinion; reversible; to be
 * reviewed before go-live. The master plan's DR-38: "record filing; the
 * settlement entry".
 *
 * Recording a filing posts ONE entry, dated the filing date: Dr VAT_OUTPUT /
 * Cr VAT_INPUT for the period's movement (less what earlier filings of the
 * period cleared), the net to VAT_PAYMENT — the seeded account a VAT remittance
 * is categorised to. An amendment clears what is left; nothing to clear posts
 * nothing; held VAT (VAT_AWAITING_EVIDENCE) is on no return and is never
 * cleared; the filing and its entry are one act.
 *
 * Acts over HTTP. DB-backed (sl_test / CI); skips on the DB-free placeholder.
 */
process.env.PORT ??= "3247";
process.env.SESSION_SECRET ??= "phase18-vat-g2b-filing-clearing-0001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "Phase18VatG2bClearingPw1!";

describeMaybe("Phase 18 G2b — the VAT clearing entry at filing (A5(c))", () => {
  const h = g04Harness("p18vatg2b");
  let orgId = "", customerId = 0, vendorId = 0;

  /** The balance (debit − credit) of a system-coded account, over every entry in the books. */
  const gl = async (code: string) => Number((await pool.query(
    `SELECT coalesce(sum(l.debit_amount - l.credit_amount), 0)::text v FROM journal_entry_lines l
       JOIN journal_entries e ON e.id = l.journal_entry_id JOIN categories c ON c.id = l.account_id
      WHERE e.organization_id = $1 AND c.system_code = $2 AND e.status IN ('posted','reversed')`, [orgId, code])).rows[0].v);
  /** The clearing entries of the company: [date, [code, debit, credit]…]. */
  const clearings = async () => (await pool.query(
    `SELECT e.id, e.date, e.source_id, json_agg(json_build_array(c.system_code, l.debit_amount::float, l.credit_amount::float) ORDER BY l.id) AS lines
       FROM journal_entries e JOIN journal_entry_lines l ON l.journal_entry_id = e.id JOIN categories c ON c.id = l.account_id
      WHERE e.organization_id = $1 AND e.source_type = 'vat_return_filing' GROUP BY e.id ORDER BY e.id`, [orgId])).rows;
  const sale = async (date: string, unitPrice: number) => {
    const inv = await h.api("admin", "POST", "/invoices", { customerId, date, items: [{ description: "Sale", quantity: 1, unitPrice, vatRate: 15 }] });
    expect(inv.status, JSON.stringify(inv.body)).toBe(201);
    expect((await h.api("admin", "POST", `/invoices/${inv.body.id}/approve`, {})).status).toBe(200);
  };
  const purchase = async (date: string, subtotal: number, evidenced = true) => {
    const b = await h.api("admin", "POST", "/bills", {
      vendorId, date, subtotal, vatAmount: subtotal * 0.15, total: subtotal * 1.15, items: [],
      ...(evidenced ? { supplierDocumentKind: "tax_invoice", vendorReference: `SUP-${date}-${subtotal}` } : {}),
    });
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    expect((await h.api("admin", "POST", `/bills/${b.body.id}/approve`, {})).status).toBe(200);
  };
  const file = (periodFrom: string, filedOn: string, zatcaReference: string, extra: Record<string, unknown> = {}) =>
    h.api("admin", "POST", "/tax/vat-return-filings", { periodFrom, periodTo: periodFrom, filedOn, zatcaReference, ...extra });

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    await pool.query(
      `INSERT INTO companies (organization_id, name, cr_number, vat_number, fiscal_year_start, building_number, street, district, city, postal_code, additional_number)
       VALUES ($1,'VAT G2b Co','1010868391','310123456789013',1,'1234','King Fahd Road','Al Olaya','Riyadh','12345','6789')`, [orgId]);
    await h.mkUser("admin", PW, orgId, "admin");
    customerId = (await pool.query(`INSERT INTO customers (organization_id, name) VALUES ($1,'G2b Buyer') RETURNING id`, [orgId])).rows[0].id;
    vendorId = (await pool.query(`INSERT INTO vendors (organization_id, name, tax_number) VALUES ($1,'G2b Supplier','300000000000003') RETURNING id`, [orgId])).rows[0].id;
    await h.start();
    expect(await h.login("admin", h.email("admin"), PW), "login admin").toBe(200);
  }, 120_000);

  afterAll(async () => { await h.stop(); await h.cleanup(); });

  it("🔴 filing a period PAYABLE posts Dr output VAT / Cr input VAT / Cr VAT payable, dated the filing date — the period's VAT accounts are cleared", async () => {
    await sale("2026-08-10", 1_000);       // output VAT 150
    await purchase("2026-08-12", 600);     // input VAT 90, claimed
    const r = await file("2026-08", "2026-09-20", "G2B-RET-2026-08");
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const [c] = await clearings();
    expect(c).toMatchObject({ date: "2026-09-20", source_id: r.body.id, lines: [["VAT_OUTPUT", 150, 0], ["VAT_INPUT", 0, 90], ["VAT_PAYMENT", 0, 60]] });
    expect([await gl("VAT_OUTPUT"), await gl("VAT_INPUT"), await gl("VAT_PAYMENT")]).toEqual([0, 0, -60]);
    expect(r.body.clearing).toMatchObject({ entryId: c.id, outputVat: 150, inputVat: 90, net: 60 });
  });

  it("🔴 an AMENDMENT clears only what the period gained after the original's clearing", async () => {
    await sale("2026-08-25", 100);         // output VAT 15, recorded after the original filing
    const r = await file("2026-08", "2026-10-05", "G2B-RET-2026-08-A1", { kind: "amendment", amendsZatcaReference: "G2B-RET-2026-08" });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const last = (await clearings()).at(-1);
    expect(last).toMatchObject({ date: "2026-10-05", lines: [["VAT_OUTPUT", 15, 0], ["VAT_PAYMENT", 0, 15]] });
    expect([await gl("VAT_OUTPUT"), await gl("VAT_PAYMENT")]).toEqual([0, -75]);
  });

  it("🔴 a period RECEIVABLE debits VAT payable; held VAT (awaiting evidence) is on no return and is never cleared", async () => {
    await purchase("2026-07-08", 1_000);       // input VAT 150, claimed
    await purchase("2026-07-09", 200, false);  // input VAT 30, HELD
    const heldBefore = await gl("VAT_AWAITING_EVIDENCE");
    const r = await file("2026-07", "2026-08-20", "G2B-RET-2026-07");
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect((await clearings()).at(-1)).toMatchObject({ date: "2026-08-20", lines: [["VAT_INPUT", 0, 150], ["VAT_PAYMENT", 150, 0]] });
    expect(await gl("VAT_AWAITING_EVIDENCE")).toBe(heldBefore);
    expect(heldBefore).toBe(30);
  });

  it("control: a period with nothing to clear records the filing and posts nothing", async () => {
    const before = (await clearings()).length;
    const r = await file("2026-05", "2026-06-15", "G2B-RET-2026-05");
    expect([r.status, (await clearings()).length, r.body.clearing ?? null]).toEqual([201, before, null]);
  });

  it("🔴 the filing and its entry are ONE act: a filing dated in a closed month is refused, and neither the filing nor an entry is written", async () => {
    await sale("2026-06-10", 400);
    expect((await h.api("admin", "POST", "/period-locks", { period: "2026-07" })).status).toBe(201);
    const filingsBefore = (await h.api("admin", "GET", "/tax/vat-return-filings")).body.length;
    const clearingsBefore = (await clearings()).length;
    const r = await file("2026-06", "2026-07-20", "G2B-RET-2026-06");
    const filingsAfter = (await h.api("admin", "GET", "/tax/vat-return-filings")).body.length;
    expect([r.status, r.body.code, filingsAfter - filingsBefore, (await clearings()).length - clearingsBefore], JSON.stringify(r.body)).toEqual([423, "period_closed", 0, 0]);
  });
});
