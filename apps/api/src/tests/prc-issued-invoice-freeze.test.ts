/**
 * 🔴 PR C (Phase 18, T1c; migration 0125) — the issued-invoice freeze: what the G29/G49/G50 proofs
 * (phase18-prc-*.test.ts, landed unchanged) do not already cover.
 *
 *   1. ONE definition of "issued": the database's `invoice_is_issued` agrees with the application's
 *      `UNISSUED_STATUSES`, so the two cannot drift apart.
 *   2. The migration's refusing pre-check is MEANINGFUL: on every document type the product issues it
 *      finds no disagreement with the signed XML (no false refusal, including a seller name that needs
 *      XML escaping), and each planted disagreement is named — the instrument is shown to see a
 *      known-present case before its silence is believed. The migration's own block raises on one.
 *   3. A legacy issued row (no hash, no seller stamp, no signed document) is frozen as it stands, and
 *      the payment path's columns still move on it.
 *   4. No invoice is INSERTED issued — not even under the company's own identity; drafts and opening
 *      items still insert.
 *   5. Opening invoices are OUT of the freeze (owner decision 5).
 *   6. A standard (clearance) and a simplified (reporting) invoice that ZATCA rejects: what happens
 *      TODAY, through the real worker and the real response mapping over a scripted socket. The
 *      rejected invoice and its signed document stay frozen, ZATCA's verdict once recorded cannot be
 *      undone, and the next document takes the next ICV with the rejected document's hash as its PIH.
 *      The correction route itself is not built (see the PR description).
 *   7. Drafts stay editable and removable through the product.
 *
 * Onboarding is the established fixture (self-signed certificate, local-dev KMS). Stand-ins, named: no
 * real PCSID, no ZATCA call — the worker talks to a scripted socket returning HTTP 400.
 * DB-backed (sl_test / CI); skips on the DB-free placeholder.
 */
process.env.PORT ??= "3211";
process.env.SESSION_SECRET ??= "prc-issued-invoice-freeze-session-secret-01";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness } from "./helpers/g04Harness";
import { writeIssuedFixture } from "./helpers/issuedInvoiceFixtures";
import { signingService } from "../services/einvoice/signing/signing.service";
import type { ZatcaCsrInput } from "../services/einvoice/crypto/csr";
import { selfSignedCertificate } from "./helpers/selfSignedCert";
import { UNISSUED_STATUSES } from "../repositories/invoices.repository";
import { EInvoiceWorker } from "../services/einvoice/outbox/worker";
import { createZatcaDirectProvider } from "../services/einvoice/zatca/zatcaDirectProvider";
import type { ZatcaHttpClient, ZatcaRequest, ZatcaResponse } from "../services/einvoice/zatca/zatcaHttpClient";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

const PW = "PrcFreezePw123!";
const VAT = "399999999996013";
const NAME = "PRC Freeze Co";
const DATE = "2026-10-05";
const MIGRATION = join(__dirname, "..", "..", "..", "..", "packages", "db", "migrations", "0125_prc_issued_invoice_freeze.sql");
const REJECTED_400: ZatcaResponse = { httpStatus: 400, body: { errors: [{ code: "BR-KSA-XX", message: "scripted rejection" }] }, networkFailure: false, errorMessage: null };

type Attempt = { refused: boolean; rowCount: number | null; constraint: string | null; message: string | null };

describeMaybe("PR C — the issued-invoice freeze (migration 0125)", () => {
  const h = g04Harness("prcfrz");
  let orgId = "";
  let companyId = "";
  let b2c = 0;
  let b2b = 0;
  let bank = 0;

  async function purgeCredentials() {
    const comps = `(SELECT id FROM companies WHERE organization_id IN ${h.ORGS})`;
    await pool.query(`DELETE FROM zatca_credential_reminders WHERE company_id IN ${comps}`);
    await pool.query(`DELETE FROM zatca_credentials WHERE company_id IN ${comps}`);
  }

  const line = (unitPrice: number) => [{ description: "Professional services", quantity: 1, unitPrice, vatRate: 15 }];
  async function create(body: Record<string, unknown>): Promise<number> {
    const r = await h.api("bookkeeper", "POST", "/invoices", { date: DATE, ...body });
    expect(r.status, `create: ${JSON.stringify(r.body)}`).toBe(201);
    return r.body.id as number;
  }
  async function approve(id: number) {
    const r = await h.api("accountant", "POST", `/invoices/${id}/approve`, {});
    expect(r.status, `approve ${id}: ${JSON.stringify(r.body)}`).toBe(200);
  }
  const issue = async (body: Record<string, unknown>) => {
    const id = await create(body);
    await approve(id);
    return id;
  };
  const row = async (id: number) => (await pool.query(`SELECT to_jsonb(i) AS r FROM invoices i WHERE id = $1`, [id])).rows[0]?.r ?? null;
  const doc = async (id: number) => (await pool.query(`SELECT to_jsonb(d) AS r FROM einvoice_documents d WHERE invoice_id = $1`, [id])).rows[0]?.r ?? null;

  const fail = (e: unknown): Attempt => {
    const err = e as { constraint?: string; message?: string };
    return { refused: true, rowCount: null, constraint: err.constraint ?? null, message: String(err.message ?? e).slice(0, 200) };
  };
  async function asOwner(sql: string, params: unknown[]): Promise<Attempt> {
    try {
      const r = await pool.query(sql, params);
      return { refused: false, rowCount: r.rowCount, constraint: null, message: null };
    } catch (e) {
      return fail(e);
    }
  }
  async function asApp(sql: string, params: unknown[]): Promise<Attempt> {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(`SET LOCAL ROLE authenticated`);
      await c.query(`SELECT set_config('app.current_org_id', $1, true)`, [orgId]);
      await c.query(`SELECT set_config('app.current_company_id', $1, true)`, [companyId]);
      try {
        const r = await c.query(sql, params);
        await c.query("COMMIT");
        return { refused: false, rowCount: r.rowCount, constraint: null, message: null };
      } catch (e) {
        await c.query("ROLLBACK");
        return fail(e);
      }
    } finally {
      c.release();
    }
  }

  /**
   * Plant ONE disagreement with the triggers set aside, read what the pre-check's comparison says about
   * that invoice, and roll everything back — the planted state is never committed.
   */
  async function disagreementsAfter(plant: string, params: unknown[], invoiceId: number): Promise<string[]> {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL session_replication_role = replica");
      await c.query(plant, params);
      const r = await c.query(`SELECT why FROM issued_invoice_xml_disagreements() WHERE invoice_id = $1`, [invoiceId]);
      return (r.rows[0]?.why as string[] | undefined) ?? [];
    } finally {
      await c.query("ROLLBACK").catch(() => undefined);
      c.release();
    }
  }

  /** A scripted ZATCA socket under the REAL provider (the einvoice-outbox pattern). */
  function rejectingWorker(maxAttempts: number) {
    const sent: ZatcaRequest[] = [];
    const client: ZatcaHttpClient = {
      async send(req) {
        sent.push(req);
        return REJECTED_400;
      },
    };
    const provider = createZatcaDirectProvider({ client, resolveTransportCredentials: async () => ({ certificateBase64: "CERT", secret: "SECRET" }) });
    // Every due document of this organization is claimed in one batch, oldest first, so the newest is never left out.
    return { worker: new EInvoiceWorker({ provider, maxAttempts, organizationId: orgId, batchSize: 100 }), sent };
  }

  beforeAll(async () => {
    await purgeCredentials();
    await h.cleanup();
    orgId = await h.mkOrg("org");
    companyId = (await pool.query(
      `INSERT INTO companies (organization_id, name, name_ar, cr_number, vat_number, fiscal_year_start,
                              building_number, street, district, city, postal_code, additional_number)
       VALUES ($1,$2,'شركة','1010101010',$3,1,'1234','King Fahd Rd','Olaya','Riyadh','12345','1234') RETURNING id`, [orgId, NAME, VAT],
    )).rows[0].id;
    const csr: ZatcaCsrInput = {
      commonName: "SLP-EGS-PRCFRZ", organizationName: NAME, organizationalUnitName: "Riyadh Branch",
      countryName: "SA", invoiceType: "1100", locationAddress: "Riyadh", industryBusinessCategory: "Software",
      organizationIdentifier: VAT, egsSerialNumber: "1-SLP|2-PRCFRZ|3-EGS001", production: false,
    };
    const { credentialId } = await signingService.createCredential({ companyId, environment: "sandbox", csr });
    const certificatePem = await signingService.withCredentialKey(credentialId, ({ privateKey, publicKey }) => selfSignedCertificate(privateKey, publicKey));
    await signingService.activateCredential({ credentialId, certificatePem, csidSecret: "csid-secret", notBefore: new Date("2026-01-01T00:00:00Z"), notAfter: new Date("2031-01-01T00:00:00Z") });
    b2c = (await pool.query(`INSERT INTO customers (organization_id, name, name_ar) VALUES ($1,'PRC Walk-in Client','عميل') RETURNING id`, [orgId])).rows[0].id;
    b2b = (await pool.query(
      `INSERT INTO customers (organization_id, name, name_ar, tax_number, cr_number, building_number, street, district, city, postal_code, additional_number, country)
       VALUES ($1,'PRC Business Client','عميل تجاري','311111111111113','1010202020','4321','Olaya St','Al Olaya','Riyadh','12211','4321','SA') RETURNING id`, [orgId],
    )).rows[0].id;
    await h.mkUser("admin", PW, orgId, "admin");
    await h.mkUser("accountant", PW, orgId, "accountant");
    await h.mkUser("bookkeeper", PW, orgId, "bookkeeper");
    await h.start();
    for (const who of ["admin", "accountant", "bookkeeper"]) expect(await h.login(who, h.email(who), PW), `login ${who}`).toBe(200);
    const b = await h.api("admin", "POST", "/bank-accounts", { name: "PRC Freeze Main", bankName: "Riyad Bank", iban: "SA0380000000608010167519", currency: "SAR", isDefault: true });
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    bank = b.body.id;
  }, 120_000);

  afterAll(async () => {
    await h.stop();
    await purgeCredentials();
    await h.cleanup();
  });

  it("ONE definition of issued: the database's invoice_is_issued is exactly NOT the application's UNISSUED_STATUSES (and never an opening item)", async () => {
    const statuses = [...UNISSUED_STATUSES, "sent", "paid", "anything-else"];
    const r = await pool.query(
      `SELECT s, invoice_is_issued(s, false) AS issued, invoice_is_issued(s, true) AS opening FROM unnest($1::text[]) s`, [statuses],
    );
    const got = Object.fromEntries(r.rows.map((x) => [x.s, [x.issued, x.opening]]));
    for (const s of UNISSUED_STATUSES) expect(got[s], s).toEqual([false, false]);
    for (const s of ["sent", "paid", "anything-else"]) expect(got[s], s).toEqual([true, false]);
    expect(UNISSUED_STATUSES.length, "anti-vacuity: the application names unissued states").toBeGreaterThan(0);
  });

  it("🔴 PRE-CHECK, no false refusal: every document type the product issues agrees with its own signed XML — including a seller name that needs XML escaping", async () => {
    const simplified = await issue({ customerId: b2c, items: line(2_000) });
    const standard = await issue({ customerId: b2b, items: line(3_000) });
    const credit = await issue({ customerId: b2c, documentType: "credit_note", originalInvoiceId: simplified, noteReason: "Price reduced after delivery", items: line(500) });
    const debit = await issue({ customerId: b2c, documentType: "debit_note", originalInvoiceId: simplified, noteReason: "Additional freight", items: line(300) });
    const receipt = await h.api("admin", "POST", "/payments", { customerId: b2c, amount: 2_300, paidAt: DATE, bankAccountId: bank, classification: "advance", vatCategory: "S" });
    expect(receipt.status, JSON.stringify(receipt.body)).toBe(201);
    const adv = await h.api("admin", "POST", `/payments/${receipt.body.id}/advance-invoices`, { amount: 2_300 });
    expect(adv.status, JSON.stringify(adv.body)).toBe(201);
    await approve(adv.body.id);
    const final = await issue({ customerId: b2c, items: line(4_000), prepayments: [{ advanceInvoiceId: adv.body.id, amount: 1_150 }] });
    const acn = await h.api("admin", "POST", `/invoices/${adv.body.id}/advance-credit-notes`, { amount: 1_150, reason: "Order reduced", date: DATE });
    expect(acn.status, JSON.stringify(acn.body)).toBe(201);
    await approve(acn.body.id);

    // A seller name the XML must escape: the comparison unescapes before comparing.
    const escaped = "PRC Freeze & Sons <Trading>";
    expect((await h.api("admin", "PATCH", "/companies/current", { name: escaped })).status).toBe(200);
    let named = 0;
    try {
      named = await issue({ customerId: b2c, items: line(1_000) });
    } finally {
      expect((await h.api("admin", "PATCH", "/companies/current", { name: NAME })).status).toBe(200);
    }

    const ids = [simplified, standard, credit, debit, adv.body.id as number, final, acn.body.id as number, named];
    const docs = await pool.query(
      `SELECT invoice_id, (signed_xml IS NOT NULL) AS signed, substring(signed_xml from '<cbc:InvoiceTypeCode[^>]*>([0-9]+)<') AS type
         FROM einvoice_documents WHERE invoice_id = ANY($1::int[]) ORDER BY invoice_id`, [ids],
    );
    const found = await pool.query(`SELECT invoice_id, why FROM issued_invoice_xml_disagreements() WHERE invoice_id = ANY($1::int[])`, [ids]);
    // eslint-disable-next-line no-console
    console.warn("[PRC FREEZE] no-false-refusal", JSON.stringify({ documents: docs.rows, disagreements: found.rows, seller: (await row(named)).seller_name }));
    expect(docs.rows.map((d) => d.signed), "anti-vacuity: eight signed documents were compared").toEqual(ids.map(() => true));
    expect(new Set(docs.rows.map((d) => d.type)), "388, 381, 383 and 386 are all among them").toEqual(new Set(["388", "381", "383", "386"]));
    expect((await row(named)).seller_name).toBe(escaped);
    expect(found.rows).toEqual([]);
  }, 180_000);

  it("🔴 PRE-CHECK refuses each planted disagreement and names it (the instrument sees a known-present case); the migration's own block raises", async () => {
    const id = await issue({ customerId: b2c, items: line(1_700) });
    const std = await issue({ customerId: b2b, items: line(1_800) });
    const plants: Array<[string, string, number, string]> = [
      ["total", `UPDATE invoices SET total = total + 1 WHERE id = $1`, id, "total <> TaxInclusiveAmount"],
      ["subtotal", `UPDATE invoices SET subtotal = subtotal + 1 WHERE id = $1`, id, "subtotal <> TaxExclusiveAmount"],
      ["vat_amount", `UPDATE invoices SET vat_amount = vat_amount + 1 WHERE id = $1`, id, "vat_amount <> TaxTotal/TaxAmount"],
      ["invoice_number", `UPDATE invoices SET invoice_number = invoice_number || '-X' WHERE id = $1`, id, "invoice_number <> cbc:ID"],
      ["zatca_uuid", `UPDATE invoices SET zatca_uuid = gen_random_uuid() WHERE id = $1`, id, "zatca_uuid <> cbc:UUID"],
      ["icv", `UPDATE invoices SET icv = icv + 100000 WHERE id = $1`, id, "icv <> ICV reference"],
      ["issued_at (day)", `UPDATE invoices SET issued_at = issued_at - interval '1 day' WHERE id = $1`, id, "issued_at date <> cbc:IssueDate"],
      ["issued_at (time)", `UPDATE invoices SET issued_at = issued_at - interval '7 minutes' WHERE id = $1`, id, "issued_at time <> cbc:IssueTime"],
      ["seller_name", `UPDATE invoices SET seller_name = 'Someone Else' WHERE id = $1`, id, "seller_name <> the supplier's RegistrationName"],
      ["seller_vat_number", `UPDATE invoices SET seller_vat_number = '300000000000003' WHERE id = $1`, id, "seller_vat_number <> the supplier's CompanyID"],
      ["invoices.qr_code", `UPDATE invoices SET qr_code = 'cHJj' WHERE id = $1`, id, "invoices.qr_code <> the signed document's QR"],
      ["document type in the XML", `UPDATE einvoice_documents SET signed_xml = replace(signed_xml, '>388</cbc:InvoiceTypeCode>', '>383</cbc:InvoiceTypeCode>') WHERE invoice_id = $1`, id, "document_type <> cbc:InvoiceTypeCode"],
      ["document flow", `UPDATE einvoice_documents SET flow = 'clearance' WHERE invoice_id = $1`, id, "einvoice_documents.flow <> the InvoiceTypeCode subtype"],
      ["document flow (standard)", `UPDATE einvoice_documents SET flow = 'reporting' WHERE invoice_id = $1`, std, "einvoice_documents.flow <> the InvoiceTypeCode subtype"],
      ["document PIH", `UPDATE einvoice_documents SET previous_invoice_hash = 'cHJj' WHERE invoice_id = $1`, id, "einvoice_documents.previous_invoice_hash <> PIH reference"],
      ["document hash", `UPDATE einvoice_documents SET invoice_hash = 'cHJj' WHERE invoice_id = $1`, id, "einvoice_documents.invoice_hash <> the signed invoice digest"],
      ["document QR", `UPDATE einvoice_documents SET qr_code = 'cHJj' WHERE invoice_id = $1`, id, "einvoice_documents.qr_code <> QR reference"],
      ["document UUID", `UPDATE einvoice_documents SET zatca_uuid = gen_random_uuid() WHERE invoice_id = $1`, id, "einvoice_documents.zatca_uuid <> cbc:UUID"],
      ["unreadable XML", `UPDATE einvoice_documents SET signed_xml = 'not a document' WHERE invoice_id = $1`, id, "signed XML is missing or not a well-formed document"],
    ];
    expect(await disagreementsAfter(`SELECT 1 WHERE $1::int IS NOT NULL`, [id], id), "control: nothing planted, nothing named").toEqual([]);
    const seen: Record<string, string[]> = {};
    for (const [label, plant, target, reason] of plants) {
      seen[label] = await disagreementsAfter(plant, [target], target);
      expect.soft(seen[label], label).toContain(reason);
    }
    // eslint-disable-next-line no-console
    console.warn("[PRC FREEZE] planted", JSON.stringify(seen));
    expect(await row(id), "every plant was rolled back").toMatchObject({ invoice_number: expect.not.stringContaining("-X") });
    expect(await disagreementsAfter(`SELECT 1 WHERE $1::int IS NOT NULL`, [id], id)).toEqual([]);

    // The migration's own refusing block, run as written, against one planted disagreement.
    const src = readFileSync(MIGRATION, "utf8");
    const block = src.slice(src.indexOf("DO $$\nDECLARE\n  refused jsonb;"), src.indexOf("END $$;", src.indexOf("DO $$\nDECLARE\n  refused jsonb;")) + "END $$;".length);
    expect(block).toContain("FROM issued_invoice_xml_disagreements() d");
    const c = await pool.connect();
    let raised = "";
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL session_replication_role = replica");
      await c.query(`UPDATE invoices SET total = total + 1 WHERE id = $1`, [id]);
      await c.query(block).catch((e: Error) => { raised = e.message; });
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
    expect(raised).toMatch(/^PR C pre-check REFUSED: \d+ issued invoice\(s\) state fields that disagree with their own signed e-invoice document; nothing was changed/);
  }, 180_000);

  it("🔴 a LEGACY issued row — no hash, no seller stamp, no signed document — is frozen as it stands; the payment path's columns still move", async () => {
    const legacy = (await writeIssuedFixture(
      `INSERT INTO invoices (organization_id, company_id, customer_id, invoice_number, document_type, date, due_date, subtotal, vat_amount, total, paid_amount, status)
       VALUES ($1,$2,$3,'PRC-LEGACY-1','invoice',$4,$4,1000,150,1150,0,'sent') RETURNING id`, [orgId, companyId, b2c, DATE],
    )).rows[0].id as number;
    await writeIssuedFixture(
      `INSERT INTO invoice_items (organization_id, company_id, invoice_id, description, quantity, unit_price, vat_rate, vat_amount, total, tax_category_code)
       VALUES ($1,$2,$3,'Legacy line',1,1000,15,150,1150,'S')`, [orgId, companyId, legacy],
    );
    const before = await row(legacy);
    const attempts = {
      ownerTotal: await asOwner(`UPDATE invoices SET total = total + 1 WHERE id = $1`, [legacy]),
      appTotal: await asApp(`UPDATE invoices SET total = total + 1 WHERE id = $1`, [legacy]),
      ownerHash: await asOwner(`UPDATE invoices SET invoice_hash = repeat('a', 64) WHERE id = $1`, [legacy]),
      ownerDelete: await asOwner(`DELETE FROM invoices WHERE id = $1`, [legacy]),
      appDelete: await asApp(`DELETE FROM invoices WHERE id = $1`, [legacy]),
      lineDelete: await asOwner(`DELETE FROM invoice_items WHERE invoice_id = $1`, [legacy]),
    };
    // eslint-disable-next-line no-console
    console.warn("[PRC FREEZE] legacy", JSON.stringify(attempts));
    for (const [k, a] of Object.entries(attempts)) expect.soft([k, a.refused], k).toEqual([k, true]);
    expect([attempts.ownerTotal.constraint, attempts.ownerDelete.constraint, attempts.lineDelete.constraint]).toEqual(["invoice_issued_frozen", "invoice_issued_frozen", "invoice_issued_lines_frozen"]);
    expect(await row(legacy)).toEqual(before);

    // Movement: the settlement caches and sent ↔ paid are the writes an issued invoice still takes.
    const settle = await asApp(`UPDATE invoices SET paid_amount = total, paid_at = date, status = 'paid' WHERE id = $1`, [legacy]);
    const reopen = await asApp(`UPDATE invoices SET paid_amount = 0, paid_at = NULL, status = 'sent' WHERE id = $1`, [legacy]);
    expect([settle.rowCount, reopen.rowCount]).toEqual([1, 1]);
  }, 60_000);

  it("🔴 no invoice is INSERTED issued — with no hash, or with a hash under the company's own identity; a draft and an opening item still insert", async () => {
    const issuedRow = (who: string) =>
      [`INSERT INTO invoices (organization_id, company_id, customer_id, invoice_number, document_type, date, status, subtotal, vat_amount, total,
                              invoice_hash, previous_hash, seller_name, seller_vat_number, issued_at)
        VALUES ($1,$2,$3,$4,'invoice',$5,'sent',100,15,115,repeat('b',64),'GENESIS',$6,$7,now())`, [orgId, companyId, b2c, `PRC-BORN-${who}`, DATE, NAME, VAT]] as [string, unknown[]];
    const owner = await asOwner(...issuedRow("OWNER"));
    const app = await asApp(...issuedRow("APP"));
    // The status arm alone: born `sent` (and `paid`) with no hash and no artefacts at all.
    const noHash = await asApp(`INSERT INTO invoices (organization_id, company_id, customer_id, invoice_number, document_type, date, status, subtotal, vat_amount, total) VALUES ($1,$2,$3,'PRC-BORN-NOHASH','invoice',$4,'sent',100,15,115)`, [orgId, companyId, b2c, DATE]);
    const paidNoHash = await asOwner(`INSERT INTO invoices (organization_id, company_id, customer_id, invoice_number, document_type, date, status, subtotal, vat_amount, total, paid_amount) VALUES ($1,$2,$3,'PRC-BORN-PAID','invoice',$4,'paid',100,15,115,115)`, [orgId, companyId, b2c, DATE]);
    const draftOnly = await asApp(`INSERT INTO invoices (organization_id, company_id, customer_id, invoice_number, document_type, date, status) VALUES ($1,$2,$3,'PRC-DRAFT-INS','invoice',$4,'draft')`, [orgId, companyId, b2c, DATE]);
    const opening = await asOwner(
      `INSERT INTO invoices (organization_id, company_id, customer_id, invoice_number, document_type, date, status, subtotal, vat_amount, total, is_opening)
       VALUES ($1,$2,$3,'OPEN-PRC-1','invoice',$4,'sent',500,0,500,true)`, [orgId, companyId, b2c, DATE],
    );
    // eslint-disable-next-line no-console
    console.warn("[PRC FREEZE] insert", JSON.stringify({ owner, app, noHash, paidNoHash, draftOnly, opening }));
    expect([owner.refused, owner.constraint, app.refused, app.constraint]).toEqual([true, "invoice_inserted_issued", true, "invoice_inserted_issued"]);
    expect([noHash.refused, noHash.constraint, paidNoHash.refused, paidNoHash.constraint]).toEqual([true, "invoice_inserted_issued", true, "invoice_inserted_issued"]);
    expect((await pool.query(`SELECT count(*)::int AS n FROM invoices WHERE organization_id = $1 AND invoice_number LIKE 'PRC-BORN-%'`, [orgId])).rows[0].n).toBe(0);
    expect([draftOnly.rowCount, opening.rowCount]).toEqual([1, 1]);
  }, 60_000);

  it("🔴 opening invoices are OUT of the freeze (owner decision 5): their columns and lines still change and they still delete", async () => {
    const opening = (await pool.query(
      `INSERT INTO invoices (organization_id, company_id, customer_id, invoice_number, document_type, date, status, subtotal, vat_amount, total, is_opening)
       VALUES ($1,$2,$3,'OPEN-PRC-2','invoice',$4,'sent',700,0,700,true) RETURNING id`, [orgId, companyId, b2c, DATE],
    )).rows[0].id as number;
    const attempts = {
      notes: await asApp(`UPDATE invoices SET notes = 'opening note' WHERE id = $1`, [opening]),
      addLine: await asApp(`INSERT INTO invoice_items (organization_id, company_id, invoice_id, description, quantity, unit_price, vat_rate, vat_amount, total) VALUES ($1,$2,$3,'Opening line',1,700,0,0,700)`, [orgId, companyId, opening]),
      removeLine: await asApp(`DELETE FROM invoice_items WHERE invoice_id = $1`, [opening]),
      remove: await asOwner(`DELETE FROM invoices WHERE id = $1`, [opening]),
    };
    // eslint-disable-next-line no-console
    console.warn("[PRC FREEZE] opening", JSON.stringify(attempts));
    expect(Object.values(attempts).map((a) => [a.refused, a.rowCount])).toEqual([[false, 1], [false, 1], [false, 1], [false, 1]]);
  }, 60_000);

  it("🔴 a STANDARD invoice ZATCA rejects at clearance, and a SIMPLIFIED one rejected at reporting, through the real worker: retried with the SAME signed document, then needs_review (never recorded as rejected); both stay frozen; the next document takes the next ICV with the rejected document's hash as its PIH", async () => {
    const out: Record<string, unknown> = {};
    for (const [label, customerId, flow] of [["standard", b2b, "clearance"], ["simplified", b2c, "reporting"]] as const) {
      const rejected = await issue({ customerId, items: line(2_500) });
      const invBefore = await row(rejected);
      const docBefore = await doc(rejected);
      expect(docBefore.flow, label).toBe(flow);

      const { worker, sent } = rejectingWorker(2);
      await worker.runOnce(); // attempt 1 → 400 → failed, backoff
      const afterOne = await doc(rejected);
      await pool.query(`UPDATE einvoice_documents SET next_attempt_at = now() - interval '1 hour' WHERE invoice_id = $1`, [rejected]);
      await worker.runOnce(); // attempt 2 → 400 → attempts exhausted
      const afterTwo = await doc(rejected);
      const mine = sent.filter((s) => JSON.stringify(s).includes(docBefore.zatca_uuid));

      // Frozen: the invoice, its lines, and the signed document; ZATCA's state stays the worker's to write.
      const tries = {
        invoiceTotal: await asApp(`UPDATE invoices SET total = total + 1 WHERE id = $1`, [rejected]),
        invoiceToDraft: await asOwner(`UPDATE invoices SET status = 'draft' WHERE id = $1`, [rejected]),
        invoiceDelete: await asOwner(`DELETE FROM invoices WHERE id = $1`, [rejected]),
        docXml: await asOwner(`UPDATE einvoice_documents SET signed_xml = signed_xml || ' ' WHERE invoice_id = $1`, [rejected]),
        docHash: await asApp(`UPDATE einvoice_documents SET invoice_hash = 'cHJj' WHERE invoice_id = $1`, [rejected]),
        docDelete: await asOwner(`DELETE FROM einvoice_documents WHERE invoice_id = $1`, [rejected]),
      };

      // The next document: a corrected NEW invoice, through the ordinary issuance.
      const next = await issue({ customerId, items: line(2_400) });
      const nextRow = await row(next);
      const nextDoc = await doc(next);
      const invAfter = await row(rejected);
      const docAfter = await doc(rejected);
      const ar = await pool.query(
        `SELECT invoice_number, status, total::text FROM invoices WHERE id = ANY($1::int[]) ORDER BY id`, [[rejected, next]],
      );
      out[label] = {
        attempts: [afterOne.status, afterOne.attempt_count, afterTwo.status, afterTwo.attempt_count],
        submissions: mine.length,
        sameDocumentResubmitted: mine.length === 2 && JSON.stringify(mine[0]) === JSON.stringify(mine[1]),
        refusals: Object.fromEntries(Object.entries(tries).map(([k, a]) => [k, a.refused ? a.constraint : `APPLIED ${a.rowCount}`])),
        chain: { rejectedIcv: invBefore.icv, nextIcv: nextRow.icv, rejectedHash: docBefore.invoice_hash, nextPih: nextDoc.previous_invoice_hash },
        numbers: [invBefore.invoice_number, nextRow.invoice_number],
        // EVIDENCE, not asserted: both documents stand in the receivables; the ledger treatment of the
        // rejected one is the open decision the correction route waits on.
        receivables: ar.rows,
      };

      expect(afterOne.status, `${label}: a 400 is not guessed into rejected`).toBe("failed");
      expect([afterTwo.status, afterTwo.attempt_count], `${label}: escalated to a human after the attempts`).toEqual(["needs_review", 2]);
      for (const [k, a] of Object.entries(tries)) expect.soft([label, k, a.refused], k).toEqual([label, k, true]);
      expect(invAfter, `${label}: the rejected invoice is unchanged`).toEqual(invBefore);
      expect([docAfter.invoice_hash, docAfter.signed_xml, docAfter.previous_invoice_hash, docAfter.qr_code, docAfter.zatca_uuid], `${label}: its signed evidence is unchanged`)
        .toEqual([docBefore.invoice_hash, docBefore.signed_xml, docBefore.previous_invoice_hash, docBefore.qr_code, docBefore.zatca_uuid]);
      expect(nextRow.icv, `${label}: no counter is rewound or reused`).toBe(invBefore.icv + 1);
      expect(nextDoc.previous_invoice_hash, `${label}: the rejected document stays in the chain`).toBe(docBefore.invoice_hash);
      expect([nextRow.invoice_number === invBefore.invoice_number, nextRow.zatca_uuid === invBefore.zatca_uuid]).toEqual([false, false]);

      // ZATCA's verdict, once recorded, cannot be undone (no product path records `rejected` today).
      const mark = await asOwner(`UPDATE einvoice_documents SET status = 'rejected' WHERE invoice_id = $1`, [rejected]);
      const undo = await asOwner(`UPDATE einvoice_documents SET status = 'pending' WHERE invoice_id = $1`, [rejected]);
      expect([mark.rowCount, undo.refused, undo.constraint], `${label}: a recorded verdict is final`).toEqual([1, true, "einvoice_document_frozen"]);
    }
    // eslint-disable-next-line no-console
    console.warn("[PRC FREEZE] rejection", JSON.stringify(out));
  }, 240_000);

  it("drafts stay editable and removable through the product: PATCH and DELETE a draft; submit and reject another", async () => {
    const d1 = await create({ customerId: b2c, items: line(900) });
    const patched = await h.api("bookkeeper", "PATCH", `/invoices/${d1}`, { items: line(950) });
    const removed = await h.api("admin", "DELETE", `/invoices/${d1}`); // deleting is admin-only (permissions matrix), unrelated to the freeze
    const d2 = await create({ customerId: b2c, items: line(800) });
    const submitted = await h.api("bookkeeper", "POST", `/invoices/${d2}/submit`, {});
    const rejected = await h.api("accountant", "POST", `/invoices/${d2}/reject`, {});
    // eslint-disable-next-line no-console
    console.warn("[PRC FREEZE] drafts", JSON.stringify({ patched: patched.status, removed: removed.status, submitted: submitted.status, rejected: rejected.status }));
    expect([patched.status, submitted.status]).toEqual([200, 200]);
    expect([removed.status, rejected.status].every((s) => s === 200 || s === 204)).toBe(true);
    expect(await row(d1)).toBeNull();
    expect(await row(d2)).toBeNull();
  }, 60_000);
});
