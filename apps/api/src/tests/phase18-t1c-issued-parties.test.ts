/**
 * 🔴 T1c (Phase 18; G32; final-run memo 2026-10-27 §2 B): an issued invoice
 * keeps the buyer block and the seller's Arabic name, CR, address and logo as
 * they stood AT ISSUE, so a reprint never reads the live customer or company.
 * The capture is taken by the issuing write from the records themselves (the
 * database checks it against them, as 0121 does for the seller's name and VAT),
 * and an issued capture never changes. The logo an issued invoice prints is
 * kept when the company replaces or removes its logo.
 *
 * DB-backed (sl_test / CI); skips on the DB-free placeholder.
 */
process.env.PORT ??= "3239";
process.env.SESSION_SECRET ??= "phase18-t1c-issued-parties-0001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness } from "./helpers/g04Harness";
import { replica } from "./helpers/replica";
import { buildInvoiceDocModel } from "../services/invoiceDocument/invoiceDocument.service";
import { renderInvoiceHtml } from "../services/invoiceDocument/renderInvoiceHtml";
import { companiesService } from "../services/companies.service";

/** The storage seam's delete, recorded instead of performed (no real bucket in the test). */
const removed = vi.hoisted(() => [] as string[]);
vi.mock("../lib/storage", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../lib/storage")>();
  mod.storage.removeObject = async (objectPath: string) => { removed.push(objectPath); };
  return mod;
});

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "Phase18T1cIssuedPartiesPw1!";

type PgErr = { code?: string; constraint?: string; message: string };

describeMaybe("T1c — the parties an issued invoice prints are fixed at issue", () => {
  const h = g04Harness("p18t1c");
  let orgId = "";
  let companyId = "";
  let adminId = 0;
  let customerId = 0;

  const issue = async (n: string): Promise<number> => {
    const created = await h.api("admin", "POST", "/invoices", {
      invoiceNumber: n, date: "2026-10-01", customerId,
      items: [{ description: "Consulting", quantity: 1, unitPrice: 1000, vatRate: 15 }],
    });
    expect(created.status, `create ${n}: ${JSON.stringify(created.body)}`).toBe(201);
    const approved = await h.api("admin", "POST", `/invoices/${created.body.id}/approve`, {});
    expect(approved.status, `approve ${n}: ${JSON.stringify(approved.body)}`).toBe(200);
    return created.body.id as number;
  };
  const model = (id: number) => h.inTenant(orgId, companyId, adminId, () => buildInvoiceDocModel(id, "en"));
  const blocks = (m: Awaited<ReturnType<typeof model>>) => ({
    seller: { nameAr: m.seller.nameAr, crNumber: m.seller.crNumber, address: m.seller.address },
    buyer: m.buyer ? { name: m.buyer.name, nameAr: m.buyer.nameAr, vatNumber: m.buyer.vatNumber, crNumber: m.buyer.crNumber, address: m.buyer.address } : null,
  });
  const ownerTx = async (sql: string, values: unknown[]): Promise<PgErr | null> => {
    const c = await pool.connect();
    try { await c.query("BEGIN"); await c.query(sql, values); await c.query("COMMIT"); return null; }
    catch (err) { await c.query("ROLLBACK").catch(() => {}); return err as PgErr; }
    finally { c.release(); }
  };

  const AT_ISSUE = {
    seller: { nameAr: "شركة الأطراف الثابتة", crNumber: "1010323232", address: "1234، طريق الملك فهد، العليا، الرياض، 12211" },
    buyer: { name: "T1c Buyer", nameAr: "المشتري الأول", vatNumber: "300000000000003", crNumber: "2050112233", address: "77، شارع التحلية، الروضة، جدة، 23435" },
  };

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    companyId = await h.mkCompany(orgId, "T1c Parties Co", "318181818181966");
    await pool.query(
      `UPDATE companies SET name_ar = $2, cr_number = $3, building_number = '1234', street = 'طريق الملك فهد', district = 'العليا', city = 'الرياض', postal_code = '12211' WHERE id = $1`,
      [companyId, AT_ISSUE.seller.nameAr, AT_ISSUE.seller.crNumber]);
    customerId = (await pool.query(
      `INSERT INTO customers (organization_id, name, name_ar, tax_number, cr_number, building_number, street, district, city, postal_code)
       VALUES ($1, 'T1c Buyer', 'المشتري الأول', '300000000000003', '2050112233', '77', 'شارع التحلية', 'الروضة', 'جدة', '23435') RETURNING id`, [orgId])).rows[0].id;
    adminId = await h.mkUser("admin", PW, orgId, "admin");
    await h.start();
    expect(await h.login("admin", h.email("admin"), PW), "login admin").toBe(200);
  }, 120_000);

  afterAll(async () => { await h.stop(); await h.cleanup(); });

  it("control: at issue, the document prints the parties as recorded", async () => {
    const id = await issue("T1C-001");
    expect(blocks(await model(id))).toEqual(AT_ISSUE);
  });

  it("🔴 a reprint after the CUSTOMER and the COMPANY change prints the parties as they stood at issue", async () => {
    const id = await issue("T1C-002");
    await pool.query(`UPDATE customers SET name = 'Renamed Buyer', name_ar = 'مشترٍ آخر', tax_number = '300000000000099', cr_number = '2050999999', city = 'الدمام' WHERE id = $1`, [customerId]);
    await pool.query(`UPDATE companies SET name_ar = 'اسم جديد', cr_number = '1010999999', city = 'مكة' WHERE id = $1`, [companyId]);
    try {
      expect(blocks(await model(id))).toEqual(AT_ISSUE);
    } finally {
      await pool.query(`UPDATE customers SET name = 'T1c Buyer', name_ar = 'المشتري الأول', tax_number = '300000000000003', cr_number = '2050112233', city = 'جدة' WHERE id = $1`, [customerId]);
      await pool.query(`UPDATE companies SET name_ar = $2, cr_number = $3, city = 'الرياض' WHERE id = $1`, [companyId, AT_ISSUE.seller.nameAr, AT_ISSUE.seller.crNumber]);
    }
  });

  it("🔴 the capture is the issuing write's, and an issued invoice's capture never changes — by any writer", async () => {
    const id = await issue("T1C-003");
    const { rows: [r] } = await pool.query(`SELECT issued_buyer ->> 'name' AS buyer, issued_seller ->> 'crNumber' AS cr, parties_captured_at IS NOT NULL AS captured FROM invoices WHERE id = $1`, [id]);
    const changed = await ownerTx(`UPDATE invoices SET issued_buyer = jsonb_set(issued_buyer, '{name}', '"Someone Else"') WHERE id = $1`, [id]);
    expect([r, changed?.constraint], changed?.message).toEqual([{ buyer: "T1c Buyer", cr: "1010323232", captured: true }, "invoice_issued_parties_fixed"]);
  });

  it("🔴 an issuing write that captures anything but the records themselves is refused by the database", async () => {
    const created = await h.api("admin", "POST", "/invoices", {
      invoiceNumber: "T1C-004", date: "2026-10-01", customerId,
      items: [{ description: "Consulting", quantity: 1, unitPrice: 1000, vatRate: 15 }],
    });
    expect(created.status).toBe(201);
    const { rows: [co] } = await pool.query(`SELECT name, vat_number FROM companies WHERE id = $1`, [companyId]);
    // The issuing write, by hand, with a buyer block the customer record does not hold.
    const forged = await ownerTx(
      `UPDATE invoices SET status = 'sent', invoice_hash = 't1c-forged', seller_name = $2, seller_vat_number = $3, issued_at = now(), icv = 999001,
              issued_seller = $4::jsonb, issued_buyer = $5::jsonb, parties_captured_at = now() WHERE id = $1`,
      [created.body.id, co.name, co.vat_number,
       JSON.stringify({ nameAr: AT_ISSUE.seller.nameAr, crNumber: AT_ISSUE.seller.crNumber, street: "طريق الملك فهد", buildingNumber: "1234", district: "العليا", city: "الرياض", postalCode: "12211", logoPath: null }),
       JSON.stringify({ name: "Not The Buyer", nameAr: null, vatNumber: null, crNumber: null, street: null, buildingNumber: null, district: null, city: null, postalCode: null })]);
    expect(forged?.constraint, forged?.message).toBe("invoice_parties_from_records");
  });

  it("🔴 an invoice issued BEFORE parties were captured is never back-filled: it prints today's records, and the page says so", async () => {
    const id = await issue("T1C-005");
    // The state of a row issued before migration 0133 (set aside the one sanctioned way, replica mode).
    await replica(pool).query(`UPDATE invoices SET issued_seller = NULL, issued_buyer = NULL, parties_captured_at = NULL WHERE id = $1`, [id]);
    const m = await model(id);
    const html = renderInvoiceHtml(m);
    expect([blocks(m), (m as { partiesAsRecordedToday?: boolean }).partiesAsRecordedToday, html.includes("this invoice was issued before they were fixed at issue")])
      .toEqual([AT_ISSUE, true, true]);
  });

  it("🔴 the logo an issued invoice prints is KEPT when the company removes it; a logo no issued invoice prints is removed", async () => {
    const printed = `${orgId}/logo/t1c-printed.png`;
    const unused = `${orgId}/logo/t1c-unused.png`;
    await pool.query(`UPDATE companies SET logo_path = $2 WHERE id = $1`, [companyId, printed]);
    try {
      await issue("T1C-006");
      removed.length = 0;
      await h.inTenant(orgId, companyId, adminId, () => companiesService.removeLogo());
      await pool.query(`UPDATE companies SET logo_path = $2 WHERE id = $1`, [companyId, unused]);
      await h.inTenant(orgId, companyId, adminId, () => companiesService.removeLogo());
      expect(removed).toEqual([unused]);
    } finally {
      await pool.query(`UPDATE companies SET logo_path = NULL WHERE id = $1`, [companyId]);
    }
  });
});
