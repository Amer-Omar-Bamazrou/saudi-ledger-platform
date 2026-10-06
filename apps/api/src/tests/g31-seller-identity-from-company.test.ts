/**
 * G31 (pre-Phase-18 hardening, owner decision D-0, 2026-10-07) — the seller's
 * legal identity on a tax invoice has ONE source: the company record, read at
 * issue, and fixed on the document from then on.
 *
 * 🔴 THE DEFECT. `sellerName` / `sellerVatNumber` were accepted from the
 * create and update bodies (any WRITE role, including a bookkeeper), stamped
 * on the draft, and honoured at issuance as an "override" ahead of the
 * company's own registration. So the stored seller, the Phase-1 QR (tags 1–2),
 * the homegrown hash and the PDF could carry a VAT number the company does not
 * hold — while an onboarded company's signed XML used the company's real one.
 * The same precedence made an honest draft STALE: a draft created before an
 * admin corrected the company VAT kept the old number through approval.
 *
 * THE RULE (owner amendment E): the seller VAT number is never accepted from a
 * request body. It is taken from the company record at issue and fixed on the
 * document from then on. The seller NAME follows the same rule — it is the
 * other half of the same legal identity, and the same override carried both.
 *
 * Layers asserted: the HTTP refusal (named code), the issuance read (company
 * record, not the draft's stamp), every artifact built from it (stored row,
 * QR, hash, PDF model in Arabic and English, credit and debit notes), and the
 * DATABASE (an issuing write must carry the company's identity; an issued
 * document's seller identity cannot change).
 *
 * DB-backed; skips on the DB-free placeholder.
 */

process.env.PORT ??= "3110";
process.env.SESSION_SECRET ??= "g31-seller-identity-test-session-secret-000001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import bcrypt from "bcryptjs";
import { pool, beginTenantConnection, PERMISSION_MATRIX } from "@workspace/db";
import { primePermissionCache } from "../lib/rbac";
import { __resetRateLimitsForTests } from "../routes/auth";
import { auditContext } from "../lib/auditContext";
import { computeInvoiceHash } from "../services/accounting/zatca";
import { buildInvoiceDocModel } from "../services/invoiceDocument/invoiceDocument.service";
import { renderInvoiceHtml } from "../services/invoiceDocument/renderInvoiceHtml";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) {
  // eslint-disable-next-line no-console
  console.warn("[g31-seller-identity-from-company] no real DATABASE_URL — skipping.");
}

const PW = "G31SellerPw123!";
const P = "g31si";
const email = (k: string) => `${P}-${k}@test.local`;
const VAT_V1 = "311122233344403";
const VAT_V2 = "322233344455503";
const VAT_FORGED = "399988877766603";
const VAT_OTHER_COMPANY = "377766655544403";
const NAME = "G31 Trading Est.";
const NAME_AR = "مؤسسة جي ٣١ التجارية";

/** Decode a Phase-1 base64 TLV payload into { tag: value }. */
function decodeTlv(base64: string): Record<number, string> {
  const buf = Buffer.from(base64, "base64");
  const out: Record<number, string> = {};
  let i = 0;
  while (i < buf.length) {
    const tag = buf[i];
    const len = buf[i + 1];
    out[tag] = buf.subarray(i + 2, i + 2 + len).toString("utf-8");
    i += 2 + len;
  }
  return out;
}

describeMaybe("G31 — the seller identity on a tax invoice comes from the company record, fixed at issue", () => {
  let server: http.Server;
  let base = "";
  let orgId = "";
  let companyId = "";
  let otherOrgId = "";
  let customerId = 0;
  const ids: Record<string, number> = {};

  const ORG_FILTER = `(SELECT id FROM organizations WHERE slug LIKE '${P}-%')`;
  const cleanup = async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      for (const t of ["journal_entry_lines", "journal_entries", "invoice_items", "einvoice_documents", "invoices", "customers", "audit_logs", "organization_memberships", "categories", "companies"]) {
        await client.query(`DELETE FROM ${t} WHERE organization_id IN ${ORG_FILTER}`);
      }
      await client.query(`DELETE FROM security_audit_logs WHERE actor_user_id IN (SELECT id FROM users WHERE email LIKE '${P}-%')`);
      await client.query(`DELETE FROM organizations WHERE slug LIKE '${P}-%'`);
      await client.query(`DELETE FROM users WHERE email LIKE '${P}-%'`);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  };

  const jar: Record<string, string> = {};
  async function api(who: string, method: string, path: string, body?: unknown) {
    const cookie = jar[who] ?? "";
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const sid = ((res.headers as any).getSetCookie?.() ?? []).find((c: string) => c.startsWith("ksa_ledger_sid="));
    if (sid) jar[who] = sid.split(";")[0];
    let json: any;
    try { json = await res.json(); } catch { json = undefined; }
    return { status: res.status, body: json };
  }

  const inTenant = async <T,>(fn: () => Promise<T>): Promise<T> => {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
    try {
      const out = await conn.run(() => auditContext.run({ userId: ids.admin, organizationId: orgId, ipAddress: null }, fn));
      await conn.commit();
      return out;
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  };

  const row = async (id: number) =>
    (await pool.query(
      `SELECT invoice_number, date, status, seller_name, seller_vat_number, qr_code, invoice_hash, previous_hash, total, vat_amount
         FROM invoices WHERE id = $1`,
      [id],
    )).rows[0];
  const invoiceCount = async () =>
    Number((await pool.query(`SELECT count(*)::int AS n FROM invoices WHERE organization_id = $1`, [orgId])).rows[0].n);

  const draftBody = (n: string, extra: Record<string, unknown> = {}) => ({
    invoiceNumber: n,
    date: "2026-10-01",
    customerId,
    items: [{ description: "Consulting", quantity: 1, unitPrice: 1000, vatRate: 15 }],
    ...extra,
  });

  async function issue(n: string): Promise<number> {
    const created = await api("bookkeeper", "POST", "/invoices", draftBody(n));
    expect(created.status, `create ${n}`).toBe(201);
    const approved = await api("admin", "POST", `/invoices/${created.body.id}/approve`, {});
    expect(approved.status, `approve ${n}: ${JSON.stringify(approved.body)}`).toBe(200);
    return created.body.id as number;
  }

  beforeAll(async () => {
    await __resetRateLimitsForTests();
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('G31 Org','${P}-org','approved') RETURNING id`)).rows[0].id;
    companyId = (await pool.query(
      `INSERT INTO companies (organization_id, name, name_ar, cr_number, vat_number, fiscal_year_start) VALUES ($1,$2,$3,'1010313131',$4,1) RETURNING id`,
      [orgId, NAME, NAME_AR, VAT_V1],
    )).rows[0].id;
    otherOrgId = (await pool.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('G31 Other','${P}-other','approved') RETURNING id`)).rows[0].id;
    await pool.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number, fiscal_year_start) VALUES ($1,'G31 Other Co','1010313132',$2,1)`, [otherOrgId, VAT_OTHER_COMPANY]);
    customerId = (await pool.query(`INSERT INTO customers (organization_id, name, tax_number) VALUES ($1,'G31 Buyer','300000000000003') RETURNING id`, [orgId])).rows[0].id;
    const hash = await bcrypt.hash(PW, 4);
    for (const role of ["admin", "bookkeeper"]) {
      ids[role] = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ($1,$2,$3,'viewer',true) RETURNING id`, [email(role), role, hash])).rows[0].id;
      await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,$3,'active')`, [ids[role], orgId, role]);
    }
    const app = (await import("../app")).default;
    primePermissionCache(PERMISSION_MATRIX);
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/api`;
    for (const who of ["admin", "bookkeeper"]) {
      expect((await api(who, "POST", "/auth/login", { email: email(who), password: PW })).status).toBe(200);
    }
  });

  afterAll(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await cleanup();
  });

  it("PREMISE: an ordinary invoice issues with the company's own VAT and name (anti-vacuity)", async () => {
    const id = await issue("G31-001");
    const r = await row(id);
    expect(r.seller_vat_number).toBe(VAT_V1);
    expect(r.seller_name).toBe(NAME);
    expect(decodeTlv(r.qr_code)[2]).toBe(VAT_V1);
  });

  it("🔴 DIRECT API: a create that names a seller VAT number is REFUSED, with a named code, and writes nothing", async () => {
    const before = await invoiceCount();
    const r = await api("bookkeeper", "POST", "/invoices", draftBody("G31-002", { sellerVatNumber: VAT_FORGED }));
    expect(r.status).toBe(400);
    expect(r.body?.code).toBe("seller_identity_not_settable");
    expect(await invoiceCount(), "no draft is created").toBe(before);
  });

  it("🔴 DIRECT API: a create that names a seller NAME is refused the same way", async () => {
    const r = await api("bookkeeper", "POST", "/invoices", draftBody("G31-003", { sellerName: "Someone Else LLC" }));
    expect(r.status).toBe(400);
    expect(r.body?.code).toBe("seller_identity_not_settable");
  });

  it("🔴 DIRECT API: a draft update that names a seller VAT number is refused, and the draft is unchanged", async () => {
    const created = await api("bookkeeper", "POST", "/invoices", draftBody("G31-004"));
    expect(created.status).toBe(201);
    const before = await row(created.body.id);
    const r = await api("bookkeeper", "PATCH", `/invoices/${created.body.id}`, { sellerVatNumber: VAT_FORGED, notes: "x" });
    expect(r.status).toBe(400);
    expect(r.body?.code).toBe("seller_identity_not_settable");
    expect(await row(created.body.id)).toEqual(before);
  });

  it("🔴 STALE DRAFT: a draft created BEFORE the company VAT changed issues with the company's CURRENT VAT — every artifact", async () => {
    const created = await api("bookkeeper", "POST", "/invoices", draftBody("G31-005"));
    expect(created.status).toBe(201);
    const changed = await api("admin", "PATCH", "/companies/current", { vatNumber: VAT_V2 });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);

    const approved = await api("admin", "POST", `/invoices/${created.body.id}/approve`, {});
    expect(approved.status).toBe(200);
    const r = await row(created.body.id);
    expect(r.seller_vat_number, "stored seller VAT").toBe(VAT_V2);
    expect(decodeTlv(r.qr_code)[2], "QR tag 2").toBe(VAT_V2);
    expect(decodeTlv(r.qr_code)[1], "QR tag 1").toBe(NAME);
    expect(r.invoice_hash, "hash input").toBe(
      computeInvoiceHash({
        invoiceNumber: r.invoice_number,
        date: r.date,
        sellerVatNumber: VAT_V2,
        total: Number(r.total).toFixed(2),
        vatAmount: Number(r.vat_amount).toFixed(2),
        previousHash: r.previous_hash,
      }),
    );
    for (const lang of ["ar", "en"] as const) {
      const model = await inTenant(() => buildInvoiceDocModel(created.body.id, lang));
      expect(model.seller.vatNumber, `${lang} document`).toBe(VAT_V2);
      const html = renderInvoiceHtml(model);
      expect(html).toContain(VAT_V2);
      expect(html).not.toContain(VAT_V1);
    }
  });

  it("🔴 ISSUED DOCUMENTS ARE FIXED: the company changing its VAT again does not change an issued invoice's PDF", async () => {
    const id = (await pool.query(`SELECT id FROM invoices WHERE organization_id = $1 AND invoice_number = 'G31-005'`, [orgId])).rows[0].id;
    expect((await api("admin", "PATCH", "/companies/current", { vatNumber: VAT_V1 })).status).toBe(200);
    expect((await row(id)).seller_vat_number).toBe(VAT_V2);
    for (const lang of ["ar", "en"] as const) {
      const model = await inTenant(() => buildInvoiceDocModel(id, lang));
      expect(model.seller.vatNumber, `${lang} document keeps the issue-time VAT`).toBe(VAT_V2);
    }
  });

  it("🔴 CREDIT AND DEBIT NOTES: refuse a seller override, and issue with the company's VAT at THEIR issue", async () => {
    const original = await issue("G31-006");
    const noteBody = (n: string, documentType: string, extra: Record<string, unknown> = {}) => ({
      ...draftBody(n),
      items: [{ description: "Adjustment", quantity: 1, unitPrice: 100, vatRate: 15 }],
      documentType,
      originalInvoiceId: original,
      noteReason: "Price correction",
      ...extra,
    });
    for (const [n, type] of [["G31-CN-1", "credit_note"], ["G31-DN-1", "debit_note"]] as const) {
      const forged = await api("bookkeeper", "POST", "/invoices", noteBody(`${n}-F`, type, { sellerVatNumber: VAT_FORGED }));
      expect(forged.status, `${type} with an override`).toBe(400);
      expect(forged.body?.code).toBe("seller_identity_not_settable");

      const created = await api("bookkeeper", "POST", "/invoices", noteBody(n, type));
      expect(created.status, `${type}: ${JSON.stringify(created.body)}`).toBe(201);
      expect((await api("admin", "POST", `/invoices/${created.body.id}/approve`, {})).status).toBe(200);
      const r = await row(created.body.id);
      expect(r.seller_vat_number, type).toBe(VAT_V1);
      expect(decodeTlv(r.qr_code)[2], `${type} QR`).toBe(VAT_V1);
    }
  });

  it("🔴 DATABASE: an issued invoice's seller identity cannot be changed, by any writer", async () => {
    const id = (await pool.query(`SELECT id FROM invoices WHERE organization_id = $1 AND invoice_number = 'G31-001'`, [orgId])).rows[0].id;
    await expect(pool.query(`UPDATE invoices SET seller_vat_number = $1 WHERE id = $2`, [VAT_FORGED, id])).rejects.toMatchObject({ code: "23514" });
    await expect(pool.query(`UPDATE invoices SET seller_name = 'Renamed' WHERE id = $1`, [id])).rejects.toMatchObject({ code: "23514" });
    expect((await row(id)).seller_vat_number).toBe(VAT_V1);
  });

  it("🔴 DATABASE: an issuing write must carry the company's VAT — a forged or another company's number is refused", async () => {
    const created = await api("bookkeeper", "POST", "/invoices", draftBody("G31-007"));
    expect(created.status).toBe(201);
    for (const forged of [VAT_FORGED, VAT_OTHER_COMPANY]) {
      await expect(
        pool.query(
          `UPDATE invoices SET status = 'sent', invoice_hash = 'x', previous_hash = 'y', seller_vat_number = $1, seller_name = $2, issued_at = now() WHERE id = $3`,
          [forged, NAME, created.body.id],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    }
    expect((await row(created.body.id)).status).toBe("draft");
  });
});
