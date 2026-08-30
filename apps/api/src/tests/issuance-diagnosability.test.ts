/**
 * C5 — a BLOCKED issuance says what to fix.
 *
 * The fail-closed posture is deliberate and unchanged (M12.8): for an onboarded
 * taxpayer, an invoice ZATCA never learns about is a compliance breach, and it
 * would burn an ICV and a chain position that can never be filled. Refusing is
 * recoverable; a gap is not.
 *
 * What was NOT acceptable is how it surfaced: the enqueue threw a bare `Error`,
 * which the global handler mapped to a 500 "Internal server error" — no field,
 * no company, nothing actionable, and indistinguishable from a crash. This
 * suite pins the diagnosis AND the rollback, because a helpful message that
 * left a half-issued invoice behind would be a worse bug than the 500.
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
if (!REAL_DB) console.warn("[issuance-diagnosability] no real DATABASE_URL — skipping.");

const SLUG = "c5-diag";
const EMAIL = "c5-diag@test.local";
const SELLER_VAT = "399999999999993";

const CSR_INPUT: ZatcaCsrInput = {
  commonName: "SLP-EGS-C5",
  organizationName: "C5 Diag Co",
  organizationalUnitName: "Riyadh Branch",
  countryName: "SA",
  invoiceType: "1100",
  locationAddress: "Riyadh",
  industryBusinessCategory: "Software",
  organizationIdentifier: SELLER_VAT,
  egsSerialNumber: "1-SLP|2-C5|3-EGS001",
  production: false,
};

describeMaybe("C5 — a blocked issuance is diagnosable, and rolls back completely", () => {
  let orgId = "";
  let companyId = "";
  let userId = 0;
  let b2bCustomerId = 0;

  async function inTenant<T>(fn: () => Promise<T>): Promise<T> {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
    try {
      const out = await conn.run(() => auditContext.run({ userId, organizationId: orgId, ipAddress: null }, fn));
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
    await pool.query(`DELETE FROM zatca_credential_reminders WHERE company_id IN ${comps}`);
    await pool.query(`DELETE FROM zatca_credentials WHERE company_id IN ${comps}`);
    for (const t of [
      "einvoice_archive", "einvoice_documents", "invoice_payments", "journal_entry_lines",
      "journal_entries", "invoice_items", "invoices", "customers", "categories",
    ]) {
      await pool.query(`DELETE FROM ${t} WHERE organization_id IN ${org}`);
    }
    await pool.query(`DELETE FROM audit_logs WHERE organization_id IN ${org} OR user_id IN ${usr}`);
    await pool.query(`DELETE FROM organization_memberships WHERE user_id IN ${usr} OR organization_id IN ${org}`);
    await pool.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
    await pool.query(`DELETE FROM companies WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('C5 Org','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (
      await pool.query(
        `INSERT INTO companies
           (organization_id, name, name_ar, cr_number, vat_number,
            building_number, street, district, city, postal_code, additional_number)
         VALUES ($1,'C5 Diag Co','شركة','1010101041',$2,'1234','King Fahd Rd','Olaya','Riyadh','12345','1234')
         RETURNING id`,
        [orgId, SELLER_VAT],
      )
    ).rows[0].id;
    userId = (
      await pool.query(
        `INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','C5',' ','viewer',true) RETURNING id`,
      )
    ).rows[0].id;
    await pool.query(
      `INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`,
      [userId, orgId],
    );

    b2bCustomerId = (
      await pool.query(
        `INSERT INTO customers (organization_id, name, name_ar, tax_number,
           building_number, street, district, city, postal_code, province, country)
         VALUES ($1,'B2B Client','عميل','399999999999995','1234','King Fahd Rd','Olaya','Riyadh','12345','Riyadh Region','SA')
         RETURNING id`,
        [orgId],
      )
    ).rows[0].id;

    // Onboard the company: without an active credential, issuance is skipped
    // rather than blocked, and there would be nothing to diagnose.
    const { credentialId } = await signingService.createCredential({
      companyId,
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
  }, 60_000);

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it("🔴 the refusal names the invoice, the company and the reason — not a bare 500", async () => {
    const inv = await inTenant(() =>
      invoicesService.create(
        {
          invoiceNumber: "C5-BLOCKED-1",
          date: "2026-08-10",
          customerId: b2bCustomerId,
          items: [{ description: "Consulting", quantity: 1, unitPrice: 500, vatRate: 15 }],
        },
        userId),
    );

    // 🔴 Break SIGNING, not the document — that is the case that reached the
    // user as an opaque 500. `SigningError`'s message is deliberately a fixed,
    // non-leaking string ("ZATCA signing is unavailable for this company"),
    // which is right for secrecy and useless for action: it names no invoice
    // and no next step. Corrupting the stored key material reproduces exactly
    // what a KMS outage or a wrapped-key mismatch does at approval time.
    await pool.query(
      `UPDATE zatca_credentials SET encrypted_private_key = decode('00', 'hex')
        WHERE company_id = $1 AND status = 'active'`,
      [companyId],
    );

    const err = await inTenant(() => invoicesService.approve(inv.id, userId)).catch((e) => e);

    // 422, not 500: the request was understood and refused for a stated reason.
    expect(err).toMatchObject({ statusCode: 422 });
    const payload = (err as { payload?: Record<string, unknown> }).payload ?? {};
    expect(payload.code).toBe("einvoice_issuance_blocked");
    expect(payload.invoiceId).toBe(inv.id);
    expect(payload.companyId).toBe(companyId);
    // The two families a user acts on differently.
    expect(["invoice_data_incomplete", "signing_unavailable"]).toContain(payload.likelyCause);
    expect(String(payload.error), "the message must state that nothing was posted").toMatch(/remains a draft/i);
    expect(String(payload.error).length, "a reason, not just a code").toBeGreaterThan(60);
  }, 60_000);

  it("🔴 AND NOTHING WAS ISSUED: no ICV consumed, no chain position, no GL movement", async () => {
    // The diagnosis must not have come at the cost of a half-issued invoice —
    // an ICV gap is the unrecoverable failure the fail-closed posture exists
    // to prevent.
    const { rows: [inv] } = await pool.query(
      `SELECT status, icv, invoice_hash, qr_code FROM invoices WHERE organization_id = $1 AND invoice_number = 'C5-BLOCKED-1'`,
      [orgId],
    );
    expect(inv.status, "still a draft — the approval rolled back").toBe("draft");
    expect(inv.icv, "no sequence number was consumed").toBeNull();
    expect(inv.invoice_hash).toBeNull();
    expect(inv.qr_code).toBeNull();

    const { rows: [docs] } = await pool.query(
      `SELECT count(*)::int AS n FROM einvoice_documents WHERE organization_id = $1`,
      [orgId],
    );
    expect(docs.n, "nothing queued for ZATCA").toBe(0);

    const { rows: [gl] } = await pool.query(
      `SELECT count(*)::int AS n FROM journal_entries WHERE organization_id = $1`,
      [orgId],
    );
    expect(gl.n, "no GL entry survived the rollback").toBe(0);
  });
});
