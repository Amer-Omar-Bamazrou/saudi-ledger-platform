/**
 * PHASE 18 · PR C (issued-invoice freeze) · G29 PROOF — an ISSUED invoice's stated fields,
 * its lines and its e-invoice document can be changed or deleted at the database.
 * PROOF ONLY, NOT A FIX. Untracked; never merged red; never weakened.
 *
 * Audit row G29 (HIGH): "Issued-invoice hash/PIH/ICV/QR/totals/status/date not frozen;
 * einvoice_documents app-mutable with cascade" (0121:60-66 freezes seller and bank only;
 * 0016:74 grants the app role UPDATE/DELETE on einvoice_documents; the schema cascades
 * invoice → items and invoice → einvoice_documents).
 *
 * "Issued" HERE means exactly what the product's approval writes (phase18-prc-issued-state):
 * a row the product's own HTTP path created and approved — status `sent`, invoice_hash,
 * previous_hash, icv, zatca_uuid, issued_at, qr_code and the seller set by one issuing
 * write, plus one queued einvoice_documents row (the company is ZATCA-onboarded with the
 * established self-signed fixture). Opening invoices are NOT exercised (excluded from PR C).
 *
 * FIX-NEUTRAL invariants (each case is independent, on its own freshly issued invoice):
 *   - a single-statement UPDATE of a frozen field, as the OWNER connection (`pool`) and as
 *     the APP ROLE (`SET LOCAL ROLE authenticated` + the tenant GUCs), is REFUSED and the
 *     row is unchanged;
 *   - DELETE of the issued invoice, and DELETE/UPDATE of its lines, are REFUSED;
 *   - the einvoice_documents row's signed artefacts cannot be UPDATEd, it cannot be DELETEd,
 *     and no cascade removes it;
 *   - the chain (homegrown hash, ICV, ZATCA PIH) a later issuance reads is the one the
 *     earlier document was issued with.
 * Status is tested as a REVERSAL to `draft` only: `sent → paid` is a legitimate post-issue
 * write of the payment path (the CONTROL in phase18-prc-issued-state).
 * CONTROL (anti-vacuity): the SAME mechanics write a DRAFT invoice without refusal.
 *
 * 🔴 Expected to FAIL while G29 exists. DB-backed (sl_test); skips on the DB-free placeholder.
 */

process.env.PORT ??= "3182";
process.env.SESSION_SECRET ??= "phase18-prc-g29-proof-session-secret-00001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness } from "./helpers/g04Harness";
import { signingService } from "../services/einvoice/signing/signing.service";
import type { ZatcaCsrInput } from "../services/einvoice/crypto/csr";
import { selfSignedCertificate } from "./helpers/selfSignedCert";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

const PW = "PrcG29ProofPw123!";
const DATE = "2026-10-05";

type Role = "owner" | "app";
type Attempt = { refused: boolean; rowCount: number | null; code: string | null; constraint: string | null; message: string | null };

/** The invoice's own frozen fields: one single-statement UPDATE each. */
const FIELD_CASES: Array<[string, string]> = [
  ["invoice_hash", `UPDATE invoices SET invoice_hash = 'prc' || substr(invoice_hash, 4) WHERE id = $1`],
  ["previous_hash", `UPDATE invoices SET previous_hash = 'prc-tampered-previous' WHERE id = $1`],
  ["icv", `UPDATE invoices SET icv = icv + 100000 WHERE id = $1`],
  ["qr_code", `UPDATE invoices SET qr_code = 'cHJjLXRhbXBlcmVkLXFy' WHERE id = $1`],
  ["subtotal", `UPDATE invoices SET subtotal = subtotal + 1 WHERE id = $1`],
  ["vat_amount", `UPDATE invoices SET vat_amount = vat_amount + 1 WHERE id = $1`],
  ["total", `UPDATE invoices SET total = total + 1 WHERE id = $1`],
  ["status (sent → draft)", `UPDATE invoices SET status = 'draft' WHERE id = $1`],
  ["date", `UPDATE invoices SET date = '2026-10-01' WHERE id = $1`],
  ["issued_at", `UPDATE invoices SET issued_at = issued_at - interval '1 day' WHERE id = $1`],
  ["zatca_uuid", `UPDATE invoices SET zatca_uuid = gen_random_uuid() WHERE id = $1`],
  ["invoice_number", `UPDATE invoices SET invoice_number = invoice_number || '-X' WHERE id = $1`],
];

/** The invoice's lines. */
const ITEM_CASES: Array<[string, string]> = [
  ["UPDATE lines (unit_price, total)", `UPDATE invoice_items SET unit_price = unit_price + 1, total = total + 1 WHERE invoice_id = $1`],
  ["DELETE lines", `DELETE FROM invoice_items WHERE invoice_id = $1`],
];

/** The queued e-invoice document's signed artefacts, and the row itself. */
const DOC_CASES: Array<[string, string]> = [
  ["einvoice_documents.invoice_hash", `UPDATE einvoice_documents SET invoice_hash = 'cHJj' || substr(invoice_hash, 5) WHERE invoice_id = $1`],
  ["einvoice_documents.previous_invoice_hash", `UPDATE einvoice_documents SET previous_invoice_hash = 'cHJjLXRhbXBlcmVkLXBpaA==' WHERE invoice_id = $1`],
  ["einvoice_documents.qr_code", `UPDATE einvoice_documents SET qr_code = 'cHJjLXRhbXBlcmVkLXFy' WHERE invoice_id = $1`],
  ["einvoice_documents.signed_xml", `UPDATE einvoice_documents SET signed_xml = signed_xml || '<!-- prc -->' WHERE invoice_id = $1`],
  ["DELETE einvoice_documents", `DELETE FROM einvoice_documents WHERE invoice_id = $1`],
];

function diff(before: Record<string, unknown> | null, after: Record<string, unknown> | null): Record<string, [unknown, unknown]> | string {
  if (!before || !after) return `before ${before ? "present" : "ABSENT"} → after ${after ? "present" : "ABSENT"}`;
  const out: Record<string, [unknown, unknown]> = {};
  const cut = (v: unknown) => (typeof v === "string" && v.length > 48 ? `${v.slice(0, 24)}…(${v.length})` : v);
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) out[k] = [cut(before[k]), cut(after[k])];
  }
  return out;
}

describeMaybe("PR C proof · G29 — an issued invoice, its lines and its e-invoice document are not frozen", () => {
  const h = g04Harness("prcg29");
  /** Two onboarded companies, each its own organization: `main` for the per-field cases, `chain` for the chain consequences. */
  const t = {
    main: { orgId: "", companyId: "", customerId: 0, vat: "399999999992013" },
    chain: { orgId: "", companyId: "", customerId: 0, vat: "399999999992023" },
  };
  type Tenant = keyof typeof t;
  const actor = (tenant: Tenant, who: string) => `${tenant}-${who}`;

  async function purgeCredentials() {
    const comps = `(SELECT id FROM companies WHERE organization_id IN ${h.ORGS})`;
    await pool.query(`DELETE FROM zatca_credential_reminders WHERE company_id IN ${comps}`);
    await pool.query(`DELETE FROM zatca_credentials WHERE company_id IN ${comps}`);
  }

  async function onboard(tenant: Tenant) {
    const x = t[tenant];
    x.orgId = await h.mkOrg(tenant);
    x.companyId = (await pool.query(
      `INSERT INTO companies (organization_id, name, name_ar, cr_number, vat_number, fiscal_year_start,
                              building_number, street, district, city, postal_code, additional_number)
       VALUES ($1,$2,'شركة','1010101010',$3,1,'1234','King Fahd Rd','Olaya','Riyadh','12345','1234') RETURNING id`, [x.orgId, `PRC G29 ${tenant} Co`, x.vat],
    )).rows[0].id;
    const csr: ZatcaCsrInput = {
      commonName: `SLP-EGS-PRCG29-${tenant}`, organizationName: `PRC G29 ${tenant} Co`, organizationalUnitName: "Riyadh Branch",
      countryName: "SA", invoiceType: "1100", locationAddress: "Riyadh", industryBusinessCategory: "Software",
      organizationIdentifier: x.vat, egsSerialNumber: `1-SLP|2-PRCG29${tenant}|3-EGS001`, production: false,
    };
    const { credentialId } = await signingService.createCredential({ companyId: x.companyId, environment: "sandbox", csr });
    const certificatePem = await signingService.withCredentialKey(credentialId, ({ privateKey, publicKey }) => selfSignedCertificate(privateKey, publicKey));
    await signingService.activateCredential({ credentialId, certificatePem, csidSecret: "csid-secret", notBefore: new Date("2026-01-01T00:00:00Z"), notAfter: new Date("2031-01-01T00:00:00Z") });
    x.customerId = (await pool.query(`INSERT INTO customers (organization_id, name, name_ar) VALUES ($1,'PRC G29 Client','عميل') RETURNING id`, [x.orgId])).rows[0].id;
    await h.mkUser(actor(tenant, "accountant"), PW, x.orgId, "accountant");
    await h.mkUser(actor(tenant, "bookkeeper"), PW, x.orgId, "bookkeeper");
  }

  async function draft(tenant: Tenant, unitPrice = 1_000): Promise<number> {
    const r = await h.api(actor(tenant, "bookkeeper"), "POST", "/invoices", {
      date: DATE, customerId: t[tenant].customerId, items: [{ description: "Professional services", quantity: 1, unitPrice, vatRate: 15 }],
    });
    expect(r.status, `create: ${JSON.stringify(r.body)}`).toBe(201);
    return r.body.id as number;
  }
  /** An invoice ISSUED by the product's own path: HTTP create, then HTTP approve. */
  async function issued(tenant: Tenant = "main", unitPrice = 1_000): Promise<number> {
    const id = await draft(tenant, unitPrice);
    const r = await h.api(actor(tenant, "accountant"), "POST", `/invoices/${id}/approve`, {});
    expect(r.status, `approve: ${JSON.stringify(r.body)}`).toBe(200);
    return id;
  }

  const rowOf = async (id: number) => (await pool.query(`SELECT to_jsonb(i) AS r FROM invoices i WHERE id = $1`, [id])).rows[0]?.r ?? null;
  const itemsOf = async (id: number) => (await pool.query(`SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.id), '[]'::jsonb) AS r FROM invoice_items x WHERE invoice_id = $1`, [id])).rows[0].r;
  const docOf = async (id: number) => (await pool.query(`SELECT to_jsonb(d) AS r FROM einvoice_documents d WHERE invoice_id = $1`, [id])).rows[0]?.r ?? null;
  const glOf = async (tenant: Tenant, number: string) => Number((await pool.query(
    `SELECT count(*)::int AS n FROM journal_entries WHERE organization_id = $1 AND entry_number = $2`, [t[tenant].orgId, `GL-${number}`],
  )).rows[0].n);

  const fail = (e: unknown): Attempt => {
    const err = e as { code?: string; constraint?: string; message?: string };
    return { refused: true, rowCount: null, code: err.code ?? null, constraint: err.constraint ?? null, message: String(err.message ?? e).slice(0, 220) };
  };
  /** One statement as the OWNER connection (autocommit). */
  async function asOwner(sql: string, params: unknown[]): Promise<Attempt> {
    try {
      const r = await pool.query(sql, params);
      return { refused: false, rowCount: r.rowCount, code: null, constraint: null, message: null };
    } catch (e) {
      return fail(e);
    }
  }
  /** One statement as the APP ROLE, inside its own transaction, committed when it succeeds — a request's own conditions. */
  async function asApp(sql: string, params: unknown[], tenant: Tenant = "main"): Promise<Attempt> {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(`SET LOCAL ROLE authenticated`);
      await c.query(`SELECT set_config('app.current_org_id', $1, true)`, [t[tenant].orgId]);
      await c.query(`SELECT set_config('app.current_company_id', $1, true)`, [t[tenant].companyId]);
      try {
        const r = await c.query(sql, params);
        await c.query("COMMIT");
        return { refused: false, rowCount: r.rowCount, code: null, constraint: null, message: null };
      } catch (e) {
        await c.query("ROLLBACK");
        return fail(e);
      }
    } finally {
      c.release();
    }
  }
  const as = (role: Role, sql: string, params: unknown[]) => (role === "owner" ? asOwner(sql, params) : asApp(sql, params));

  beforeAll(async () => {
    await purgeCredentials();
    await h.cleanup();
    await onboard("main");
    await onboard("chain");
    await h.start();
    for (const tenant of ["main", "chain"] as const) {
      for (const who of ["accountant", "bookkeeper"]) expect(await h.login(actor(tenant, who), h.email(actor(tenant, who)), PW), `login ${tenant} ${who}`).toBe(200);
    }
  }, 120_000);

  afterAll(async () => {
    await h.stop();
    await purgeCredentials();
    await h.cleanup();
  });

  it("PREMISE: an approved invoice is ISSUED — status sent, hash, previous hash, ICV, UUID, issued_at, QR and seller set; ONE signed e-invoice document queued; one GL entry", async () => {
    const id = await issued();
    const r = await rowOf(id);
    const d = await docOf(id);
    // eslint-disable-next-line no-console
    console.warn("[PRC G29] PREMISE", JSON.stringify({ status: r.status, hash: !!r.invoice_hash, prev: r.previous_hash ? "set" : null, icv: r.icv, uuid: !!r.zatca_uuid, issued_at: r.issued_at, qr: !!r.qr_code, seller: r.seller_vat_number, doc: d && { flow: d.flow, status: d.status, hash: !!d.invoice_hash, pih: !!d.previous_invoice_hash, xml: !!d.signed_xml }, gl: await glOf("main", r.invoice_number) }));
    expect(r.status).toBe("sent");
    expect(r.invoice_hash).toMatch(/^[0-9a-f]{64}$/);
    expect([r.icv, r.zatca_uuid, r.issued_at, r.qr_code, r.previous_hash].every((v) => v != null)).toBe(true);
    expect(d?.status).toBe("pending");
    expect(d?.invoice_hash && d?.signed_xml && d?.previous_invoice_hash).toBeTruthy();
    expect(await glOf("main", r.invoice_number)).toBe(1);
  }, 60_000);

  it("CONTROL (anti-vacuity): the SAME owner and app-role mechanics write a DRAFT — an UPDATE of subtotal and of a line applies (rowCount 1) and a DELETE removes it", async () => {
    const results: Record<string, Attempt> = {};
    for (const role of ["owner", "app"] as const) {
      const id = await draft("main");
      results[`${role} UPDATE subtotal`] = await as(role, `UPDATE invoices SET subtotal = subtotal + 1 WHERE id = $1`, [id]);
      results[`${role} UPDATE line`] = await as(role, `UPDATE invoice_items SET unit_price = unit_price + 1 WHERE invoice_id = $1`, [id]);
      results[`${role} DELETE`] = await as(role, `DELETE FROM invoices WHERE id = $1`, [id]);
      expect(await rowOf(id), `${role}: the draft is gone`).toBeNull();
    }
    // eslint-disable-next-line no-console
    console.warn("[PRC G29] CONTROL draft", JSON.stringify(results));
    for (const [k, r] of Object.entries(results)) expect([k, r.refused, r.rowCount]).toEqual([k, false, 1]);
  }, 60_000);

  for (const [label, sql] of FIELD_CASES) {
    for (const role of ["owner", "app"] as const) {
      it(`🔴 G29 · ${label} · ${role}: a single UPDATE of an ISSUED invoice is REFUSED and the row is unchanged`, async () => {
        const id = await issued();
        const before = await rowOf(id);
        const r = await as(role, sql, [id]);
        const after = await rowOf(id);
        // eslint-disable-next-line no-console
        console.warn(`[PRC G29] FIELD ${label} ${role}`, JSON.stringify({ invoiceId: id, attempt: r, changed: diff(before, after) }));
        expect.soft(r.refused, "the database refuses the write").toBe(true);
        expect.soft(after, "the issued row is unchanged").toEqual(before);
      }, 60_000);
    }
  }

  for (const role of ["owner", "app"] as const) {
    it(`🔴 G29 · DELETE an ISSUED invoice · ${role}: REFUSED; the invoice, its lines and its e-invoice document all remain (no cascade)`, async () => {
      const id = await issued();
      const [before, items, doc] = [await rowOf(id), await itemsOf(id), await docOf(id)];
      const r = await as(role, `DELETE FROM invoices WHERE id = $1`, [id]);
      const [after, itemsAfter, docAfter] = [await rowOf(id), await itemsOf(id), await docOf(id)];
      const glAfter = await glOf("main", before.invoice_number);
      // eslint-disable-next-line no-console
      console.warn(`[PRC G29] DELETE invoice ${role}`, JSON.stringify({ invoiceId: id, attempt: r, invoiceAfter: after ? "present" : "ABSENT", linesBefore: items.length, linesAfter: itemsAfter.length, docAfter: docAfter ? "present" : "ABSENT", glEntriesStillPosted: glAfter }));
      expect.soft(r.refused, "the database refuses the delete").toBe(true);
      expect.soft(after, "the issued invoice remains").toEqual(before);
      expect.soft(itemsAfter, "its lines remain").toEqual(items);
      expect.soft(docAfter, "its e-invoice document remains — no cascade removes it").toEqual(doc);
    }, 60_000);

    for (const [label, sql] of ITEM_CASES) {
      it(`🔴 G29 · ${label} of an ISSUED invoice · ${role}: REFUSED; the lines are unchanged`, async () => {
        const id = await issued();
        const items = await itemsOf(id);
        const r = await as(role, sql, [id]);
        const itemsAfter = await itemsOf(id);
        // eslint-disable-next-line no-console
        console.warn(`[PRC G29] ITEMS ${label} ${role}`, JSON.stringify({ invoiceId: id, attempt: r, linesBefore: items.length, linesAfter: itemsAfter.length, changed: items.length === itemsAfter.length && items.length > 0 ? diff(items[0], itemsAfter[0]) : "line count changed" }));
        expect.soft(r.refused, "the database refuses the write").toBe(true);
        expect.soft(itemsAfter, "the issued lines are unchanged").toEqual(items);
      }, 60_000);
    }

    for (const [label, sql] of DOC_CASES) {
      it(`🔴 G29 · ${label} of an ISSUED invoice · ${role}: REFUSED; the queued document is unchanged`, async () => {
        const id = await issued();
        const doc = await docOf(id);
        expect(doc, "premise: the document was queued").not.toBeNull();
        const r = await as(role, sql, [id]);
        const docAfter = await docOf(id);
        // eslint-disable-next-line no-console
        console.warn(`[PRC G29] DOC ${label} ${role}`, JSON.stringify({ invoiceId: id, attempt: r, changed: diff(doc, docAfter) }));
        expect.soft(r.refused, "the database refuses the write").toBe(true);
        expect.soft(docAfter, "the queued document is unchanged").toEqual(doc);
      }, 60_000);
    }
  }

  // ── Consequences for what a LATER issuance reads (owner connection; the per-field
  //    refusals for both roles are the cases above). A separate company, so the chain
  //    head is the invoice under test and nothing else in this file. ──
  it("🔴 G29 · chain (ZATCA PIH): after an attempt to rewrite the head document's stored hash, the NEXT document's PIH is the hash the head was ISSUED with", async () => {
    const head = await issued("chain");
    const issuedHash = (await docOf(head)).invoice_hash as string;
    const r = await asOwner(`UPDATE einvoice_documents SET invoice_hash = 'cHJjLXRhbXBlcmVkLWhlYWQ=' WHERE invoice_id = $1`, [head]);
    const next = await issued("chain");
    const nextPih = (await docOf(next)).previous_invoice_hash as string;
    // eslint-disable-next-line no-console
    console.warn("[PRC G29] CHAIN pih", JSON.stringify({ attempt: r, headIssuedHash: issuedHash, nextDocumentPih: nextPih }));
    expect.soft(nextPih, "the next PIH is the head's issued hash").toBe(issuedHash);
  }, 60_000);

  it("🔴 G29 · chain (ICV): after an attempt to move the head's ICV, the NEXT document's ICV follows the head's ISSUED ICV with no gap", async () => {
    const head = await issued("chain");
    const issuedIcv = Number((await rowOf(head)).icv);
    const r = await asOwner(`UPDATE invoices SET icv = icv + 50 WHERE id = $1`, [head]);
    const next = await issued("chain");
    const nextIcv = Number((await rowOf(next)).icv);
    // eslint-disable-next-line no-console
    console.warn("[PRC G29] CHAIN icv", JSON.stringify({ attempt: r, headIssuedIcv: issuedIcv, nextIcv }));
    expect.soft(nextIcv, "no ICV gap").toBe(issuedIcv + 1);
  }, 60_000);

  it("🔴 G29 · chain (homegrown hash): after an attempt to rewrite the head's invoice_hash, the NEXT invoice's previous_hash is the hash the head was ISSUED with", async () => {
    const head = await issued("chain");
    const issuedHash = (await rowOf(head)).invoice_hash as string;
    const r = await asOwner(`UPDATE invoices SET invoice_hash = repeat('0', 64) WHERE id = $1`, [head]);
    const next = await issued("chain");
    const nextPrev = (await rowOf(next)).previous_hash as string;
    // eslint-disable-next-line no-console
    console.warn("[PRC G29] CHAIN homegrown", JSON.stringify({ attempt: r, headIssuedHash: issuedHash, nextPreviousHash: nextPrev }));
    expect.soft(nextPrev, "the next previous_hash is the head's issued hash").toBe(issuedHash);
  }, 60_000);
});
