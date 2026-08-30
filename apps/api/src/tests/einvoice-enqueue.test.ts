/**
 * THE M12.8 ACCEPTANCE TEST — issuance actually reaches the ZATCA pipeline,
 * and the chain it builds does not fork.
 *
 * ── Why this test is the point of the milestone ─────────────────────────────
 * Before M12.8 nothing in production ever inserted an `einvoice_documents` row.
 * The UBL generator, the signer, the QR and the outbox were all correct and all
 * unreachable from an invoice a user issued. M12.4 validated six documents
 * against ZATCA's live API — from DIRECTLY-CONSTRUCTED inputs, because nothing
 * else was possible. That proved the implementation was correct; it did not
 * prove it was connected.
 *
 * So this test refuses to hand-build anything. It onboards a company into the
 * real vault, creates and approves invoices through `invoicesService`, and then
 * asserts on rows read back out of Postgres. Fixtures test the code you wrote;
 * only real rows test the code you forgot to write.
 *
 * ── 🔴 THE OUT-OF-ORDER APPROVAL CASE IS THE HEADLINE ──────────────────────
 * M12.1b found that ordering a chain head by ROW ID forks the chain, and fixed
 * it for the homegrown chain. The ZATCA chain — the one that legally matters —
 * kept the same defect until M12.8, hidden because the table was always empty.
 *
 * That bug is NOT a race. `invoices.id` is assigned at CREATE and the chain
 * position at ISSUANCE, so an approver working a queue out of order forks the
 * chain ONE SEQUENTIAL REQUEST AT A TIME, with no concurrency anywhere. A fix
 * reasoned about as a race would have left that case broken, so it is tested
 * first and tested strictly sequentially.
 *
 * And note what could NOT have caught it: `unique(company_id, icv)` sees no
 * duplicate, because a fork produces none. Both documents get distinct, dense
 * ICVs while pointing at the same predecessor. Uniqueness and chain integrity
 * are different properties.
 *
 * Needs a real database; skips on the DB-free placeholder.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { invoicesService } from "../services/invoices.service";
import { signingService } from "../services/einvoice/signing/signing.service";
import type { ZatcaCsrInput } from "../services/einvoice/crypto/csr";
import { selfSignedCertificate } from "./helpers/selfSignedCert";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[einvoice-enqueue] no real DATABASE_URL — skipping.");

const SLUG = "eq-m128";
const EMAIL = "eq-m128@test.local";
const SELLER_VAT = "399999999999993";

const CSR_INPUT: ZatcaCsrInput = {
  commonName: "SLP-EGS-M128",
  organizationName: "Enqueue Test Co",
  organizationalUnitName: "Riyadh Branch",
  countryName: "SA",
  invoiceType: "1100",
  locationAddress: "Riyadh",
  industryBusinessCategory: "Software",
  organizationIdentifier: SELLER_VAT,
  egsSerialNumber: "1-SLP|2-M128|3-EGS001",
  production: false,
};

describeMaybe("M12.8 — issuance enqueues a signed ZATCA document, from real ledger rows", () => {
  let orgId = "";
  let companyId = "";
  let otherCompanyId = "";
  let userId = 0;
  let customerId = 0;

  async function inTenant<T>(company: string, fn: () => Promise<T>): Promise<T> {
    const conn = await beginTenantConnection({
      organizationId: orgId,
      companyId: company,
      role: "authenticated",
    });
    try {
      const out = await conn.run(() =>
        auditContext.run({ userId, organizationId: orgId, ipAddress: "203.0.113.99" }, fn),
      );
      await conn.commit();
      return out;
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  }

  const cleanup = async () => {
    const org = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
    const usr = `(SELECT id FROM users WHERE email = '${EMAIL}')`;
    const comps = `(SELECT id FROM companies WHERE organization_id IN ${org})`;
    await pool.query(`DELETE FROM einvoice_archive WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM zatca_credential_reminders WHERE company_id IN ${comps}`);
    await pool.query(`DELETE FROM zatca_credentials WHERE company_id IN ${comps}`);
    await pool.query(`DELETE FROM einvoice_documents WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM journal_entry_lines WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM journal_entries WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM invoice_items WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM invoice_payments WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id IN ${org})`);
    await pool.query(`DELETE FROM invoices WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM audit_logs WHERE organization_id IN ${org} OR user_id IN ${usr}`);
    await pool.query(`DELETE FROM customers WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM organization_memberships WHERE user_id IN ${usr} OR organization_id IN ${org}`);
    await pool.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
    await pool.query(`DELETE FROM companies WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
  };

  /** Put a working, key-bound credential in the vault — i.e. onboard the company. */
  async function onboard(company: string): Promise<string> {
    const { credentialId } = await signingService.createCredential({
      companyId: company,
      environment: "sandbox",
      csr: { ...CSR_INPUT },
    });
    const certificatePem = await signingService.withCredentialKey(credentialId, ({ privateKey, publicKey }) =>
      selfSignedCertificate(privateKey, publicKey),
    );
    await signingService.activateCredential({
      credentialId,
      certificatePem,
      csidSecret: "csid-secret",
      notBefore: new Date("2026-01-01T00:00:00Z"),
      notAfter: new Date("2031-01-01T00:00:00Z"),
    });
    return credentialId;
  }

  beforeAll(async () => {
    await cleanup();
    orgId = (
      await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Enqueue Org','${SLUG}') RETURNING id`)
    ).rows[0].id;

    const mkCompany = async (name: string, vat: string) =>
      (
        await pool.query(
          `INSERT INTO companies
             (organization_id, name, name_ar, cr_number, vat_number,
              building_number, street, district, city, postal_code, additional_number)
           VALUES ($1,$2,'شركة','1010101010',$3,'1234','King Fahd Rd','Olaya','Riyadh','12345','1234')
           RETURNING id`,
          [orgId, name, vat],
        )
      ).rows[0].id;

    companyId = await mkCompany("Enqueue Test Co", SELLER_VAT);
    otherCompanyId = await mkCompany("Not Onboarded Co", "399999999999994");

    userId = (
      await pool.query(
        `INSERT INTO users (email, name, password_hash, role, is_active)
         VALUES ('${EMAIL}','EQ',' ','viewer',true) RETURNING id`,
      )
    ).rows[0].id;
    await pool.query(
      `INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`,
      [userId, orgId],
    );
    customerId = (
      await pool.query(
        `INSERT INTO customers (organization_id, name, name_ar) VALUES ($1,'B2C Walk-in','عميل') RETURNING id`,
        [orgId],
      )
    ).rows[0].id;

    await onboard(companyId);
  });

  afterAll(cleanup);

  /** Create a draft. Approval is separate so the ORDER of the two can be varied. */
  async function createDraft(company: string, n: number): Promise<number> {
    const inv = await inTenant(company, () =>
      invoicesService.create(
        {
          invoiceNumber: `EQ-${n}`,
          date: "2026-09-10",
          customerId,
          items: [{ description: "Item", quantity: 1, unitPrice: 100, vatRate: 15 }],
        },
        userId),
    );
    return inv.id;
  }

  const approve = (company: string, id: number) =>
    inTenant(company, () => invoicesService.approve(id, userId));

  const docFor = async (invoiceId: number) =>
    (
      await pool.query(
        `SELECT id, flow, status, invoice_hash, previous_invoice_hash, qr_code, signed_xml
           FROM einvoice_documents WHERE invoice_id = $1`,
        [invoiceId],
      )
    ).rows[0];

  it("THE CONNECTION: approving an invoice writes a signed einvoice_documents row", async () => {
    const id = await createDraft(companyId, 1);

    // Nothing queued while it is only a draft — a draft is not a legal document
    // and consumes no chain position.
    expect(await docFor(id)).toBeUndefined();

    await approve(companyId, id);

    const doc = await docFor(id);
    expect(doc).toBeDefined();
    expect(doc.status).toBe("pending");
    // No buyer VAT number ⇒ simplified (B2C) ⇒ REPORTING, not clearance.
    expect(doc.flow).toBe("reporting");

    // The artifacts the worker needs. Its contract is that it never mints a
    // hash or a signature — if these are absent it rejects the document as
    // "never signed", so their presence is what makes the queue usable at all.
    expect(doc.signed_xml).toContain("<Invoice");
    expect(doc.signed_xml).toContain("UBLExtensions");
    expect(doc.invoice_hash).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(Buffer.from(doc.invoice_hash, "base64").length).toBe(32); // SHA-256

    // 🔴 The PIH is ZATCA's genesis constant, NOT the homegrown "GENESIS"
    // string. Feeding the legacy chain here is the bug M12.1b found: it fails
    // loudly on the first document and SILENTLY on every one after, because a
    // 64-char hex hash is accidentally well-formed base64.
    expect(doc.previous_invoice_hash).not.toBe("GENESIS");
    expect(Buffer.from(doc.previous_invoice_hash, "base64").length).toBeGreaterThan(0);

    // The invoice now carries the PHASE 2 (9-tag) QR, not the Phase-1 one.
    const [inv] = (await pool.query(`SELECT qr_code, icv FROM invoices WHERE id = $1`, [id])).rows;
    expect(inv.qr_code).toBe(doc.qr_code);
    expect(inv.icv).toBe(1);
  });

  it("🔴 THE FORK: approving OUT OF CREATION ORDER, strictly sequentially, still builds one chain", async () => {
    // Three drafts created in order, approved 3 → 1 → 2. No concurrency at all:
    // each approval completes before the next begins. This is an approver
    // working their queue in whatever order they like — ordinary behaviour, and
    // exactly what ordering the chain head by `invoice_id` gets wrong.
    const a = await createDraft(companyId, 11);
    const b = await createDraft(companyId, 12);
    const c = await createDraft(companyId, 13);
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);

    await approve(companyId, c);
    await approve(companyId, a);
    await approve(companyId, b);

    const { rows } = await pool.query(
      `SELECT d.invoice_hash, d.previous_invoice_hash, i.icv, i.id AS invoice_id
         FROM einvoice_documents d
         JOIN invoices i ON i.id = d.invoice_id
        WHERE d.company_id = $1
        ORDER BY i.icv`,
      [companyId],
    );

    // Every document links to the one before it IN SEQUENCE ORDER.
    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i].previous_invoice_hash).toBe(rows[i - 1].invoice_hash);
    }

    // And the ICV order is NOT the row-id order — otherwise this test would
    // pass even with the bug present.
    const byIcv = rows.map((r: { invoice_id: number }) => r.invoice_id);
    const byId = [...byIcv].sort((x, y) => x - y);
    expect(byIcv).not.toEqual(byId);

    // 🔴 A FORK PRODUCES NO DUPLICATE, which is why the unique index could
    // never have caught this. Assert both properties separately: ICVs are
    // dense and unique (they always were, even while the chain forked), AND
    // no predecessor is claimed twice.
    const icvs = rows.map((r: { icv: number }) => r.icv);
    expect(new Set(icvs).size).toBe(icvs.length);
    const predecessors = rows.slice(1).map((r: { previous_invoice_hash: string }) => r.previous_invoice_hash);
    expect(new Set(predecessors).size).toBe(predecessors.length);
  });

  it("keeps chains separate per company, and does not queue for a company that is not onboarded", async () => {
    const id = await createDraft(otherCompanyId, 21);
    await approve(otherCompanyId, id);

    // 🔴 Not onboarded ⇒ no document queued, and issuance still SUCCEEDS.
    // Every existing tenant and every existing test depends on this: a company
    // with no ZATCA credential must still be able to invoice.
    expect(await docFor(id)).toBeUndefined();

    const [inv] = (await pool.query(`SELECT status, invoice_hash, icv FROM invoices WHERE id = $1`, [id])).rows;
    expect(inv.status).toBe("sent");
    expect(inv.invoice_hash).toBeTruthy(); // the homegrown chain still advances
    expect(inv.icv).toBe(1); // its own per-company sequence

    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM einvoice_documents WHERE company_id = $1`,
      [otherCompanyId],
    );
    expect(rows[0].n).toBe(0);
  });

  it("a STANDARD (B2B) buyer routes to clearance, not reporting", async () => {
    const b2bId = (
      await pool.query(
        `INSERT INTO customers
           (organization_id, name, name_ar, tax_number, building_number, street, district, city, postal_code, province, country)
         VALUES ($1,'B2B Client','عميل','399999999999995','1234','King Fahd Rd','Olaya','Riyadh','12345','Riyadh Region','SA')
         RETURNING id`,
        [orgId],
      )
    ).rows[0].id;

    const inv = await inTenant(companyId, () =>
      invoicesService.create(
        {
          invoiceNumber: "EQ-B2B-1",
          date: "2026-09-10",
          customerId: b2bId,
          items: [{ description: "Consulting", quantity: 1, unitPrice: 500, vatRate: 15 }],
        },
        userId),
    );
    await approve(companyId, inv.id);

    const doc = await docFor(inv.id);
    expect(doc.flow).toBe("clearance");
  });
});
