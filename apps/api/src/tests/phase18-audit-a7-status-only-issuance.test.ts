/**
 * 🔴 Phase 18 audit (2026-11-09), finding A7 — G31's database seller check applies to EVERY issuing write.
 *
 * The 0121 trigger (`guard_invoice_issued_identity`) decided "issued" by the homegrown hash: it returned early when
 * the new row had no `invoice_hash`. PR C (0125) decides "issued" by STATUS (`invoice_is_issued`). So a writer that
 * moved a draft to `sent` WITHOUT minting a hash — with the parties captured as 0133 requires — stored any seller
 * name and VAT number it liked, and 0125 then froze that row as an issued document. The product's own approval always
 * mints the hash; this is the database floor the G29/G31 tests hold against "any writer".
 *
 * Now 0121's two branches use the same definition as 0125: a row is issued when it has a hash OR its status says so.
 * Presence, absence and movement: the forged seller is refused at the status-only issuing write; the same write
 * naming the company's own seller is accepted (the check is not blanket); and that row's seller is then frozen.
 * DB-backed (sl_test / CI). Every write runs in a transaction that is rolled back.
 */
process.env.PORT ??= "3395";
process.env.SESSION_SECRET ??= "phase18-audit-a7-status-only-issuance01";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "AuditA7StatusOnlyPw123!";
const SELLER = { name: "Audit A7 Co", vat: "310123456789013" };

describeMaybe("Phase 18 audit A7 — a status-only issuance passes the seller check", () => {
  const h = g04Harness("auda7");
  let orgId = "", companyId = "", customerId = 0;

  /** The issuing write without a hash: status `sent`, parties captured exactly as 0133 requires, the given seller. */
  const issueWithoutHash = (c: { query: (t: string, p: unknown[]) => Promise<unknown> }, id: number, seller: { name: string; vat: string }) => c.query(
    `UPDATE invoices SET status = 'sent', seller_name = $2, seller_vat_number = $3,
            issued_seller = invoice_seller_capture(company_id), issued_buyer = invoice_buyer_capture(customer_id), parties_captured_at = now()
      WHERE id = $1`, [id, seller.name, seller.vat]);
  /** Run `fn` in a transaction that is always rolled back; return the constraint a refusal named, or "admitted". */
  async function attempt(fn: (c: { query: (t: string, p: unknown[]) => Promise<unknown> }) => Promise<unknown>): Promise<string> {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await fn(c);
      return "admitted";
    } catch (e) {
      return (e as { constraint?: string }).constraint ?? `error: ${(e as Error).message}`;
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      c.release();
    }
  }
  async function draft(): Promise<number> {
    const r = await h.api("admin", "POST", "/invoices", { customerId, date: "2026-10-05", items: [{ description: "Service", quantity: 1, unitPrice: 1_000, vatRate: 15 }] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect((await pool.query(`SELECT status, invoice_hash FROM invoices WHERE id = $1`, [r.body.id])).rows[0]).toEqual({ status: "draft", invoice_hash: null });
    return r.body.id as number;
  }

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    companyId = (await pool.query(
      `INSERT INTO companies (organization_id, name, cr_number, vat_number, fiscal_year_start, building_number, street, district, city, postal_code, additional_number)
       VALUES ($1,$2,'1010868391',$3,1,'1234','King Fahd Road','Al Olaya','Riyadh','12345','6789') RETURNING id`, [orgId, SELLER.name, SELLER.vat])).rows[0].id;
    customerId = (await pool.query(`INSERT INTO customers (organization_id, name) VALUES ($1,'A7 Buyer') RETURNING id`, [orgId])).rows[0].id;
    await h.mkUser("admin", PW, orgId, "admin");
    await h.start();
    expect(await h.login("admin", h.email("admin"), PW), "login admin").toBe(200);
  }, 120_000);

  afterAll(async () => { await h.stop(); await h.cleanup(); });

  it("🔴 a status-only issuance naming another seller is refused at the database", async () => {
    const id = await draft();
    expect(await attempt((c) => issueWithoutHash(c, id, { name: "Forged Trading Co", vat: "399999999999993" }))).toBe("invoice_seller_identity_from_company");
  });

  it("🔴 a forged NAME under the company's own VAT number is refused too — both halves of the seller identity are compared", async () => {
    const id = await draft();
    expect(await attempt((c) => issueWithoutHash(c, id, { name: "Audit A7 Co (renamed)", vat: SELLER.vat }))).toBe("invoice_seller_identity_from_company");
  });

  it("movement: the same status-only issuance naming the company's own seller is admitted — the check refuses the forgery, not the write", async () => {
    const id = await draft();
    expect(await attempt((c) => issueWithoutHash(c, id, SELLER))).toBe("admitted");
    expect(companyId).not.toBe("");
  });

  it("presence: once issued that way, its seller is frozen (0125 refuses first; 0121 now also treats the row as issued)", async () => {
    const id = await draft();
    expect(await attempt(async (c) => {
      await issueWithoutHash(c, id, SELLER);
      await c.query(`UPDATE invoices SET seller_name = 'Renamed After Issue' WHERE id = $1`, [id]);
    })).toMatch(/^invoice_issued(_identity)?_frozen$/);
  });
});
