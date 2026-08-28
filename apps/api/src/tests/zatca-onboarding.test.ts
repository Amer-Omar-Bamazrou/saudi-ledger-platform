/**
 * M12.4 — the per-tenant onboarding flow.
 *
 * The ZATCA API is injected, so these prove the FLOW: prerequisites, the OTP
 * boundary, that compliance failure blocks activation, and that a certificate
 * which is not ours is refused. Whether ZATCA accepts our documents is proven
 * by `zatca-compliance-live.test.ts` against the real API.
 */
process.env.SESSION_SECRET ??= "zatca-onboarding-test-session-secret-0123456789ab";
process.env.PORT ??= "3000";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";
process.env.ZATCA_KMS_PROVIDER ??= "local-dev";
process.env.ZATCA_DEV_MASTER_KEY ??= "onboarding-test-master-key-0123456789abcdef";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSign } from "node:crypto";
import { pool } from "@workspace/db";
import { zatcaOnboardingService } from "../services/einvoice/onboarding/zatcaOnboarding.service";
import { signingService, CertificateMismatchError } from "../services/einvoice/signing/signing.service";
import type {
  ComplianceValidation,
  ZatcaOnboardingClient,
} from "../services/einvoice/onboarding/zatcaOnboardingClient";
import { selfSignedCertificate } from "./helpers/selfSignedCert";
import { generateZatcaKeyPair } from "../services/einvoice/crypto/keys";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[zatca-onboarding] no real DATABASE_URL — skipping.");

const SLUG = "m124-onboarding";
const PASS: ComplianceValidation = { status: "PASS", errors: [], warnings: [] };

/**
 * Stands in for the certificate ZATCA's sandbox returns from /production/csids.
 *
 * 🔴 The real one is a SHARED CANNED CERTIFICATE:
 *     CN=TST-886431145-399999999900003
 *     O=Maximum Speed Tech Supply LTD, issued 2024-01-11, VAT 399999999900003
 * It is handed to every caller and is bound to a key that is not ours —
 * confirmed against the live sandbox, where decoding it against a freshly
 * generated key pair gives "binds OUR key: false".
 *
 * It is REGENERATED here rather than embedded as a captured blob: the property
 * under test is "the public key is not ours", and a self-signed certificate over
 * an unrelated key expresses that exactly, deterministically, without depending
 * on a transcribed artifact.
 */
function foreignCertificate(): string {
  const stranger = generateZatcaKeyPair();
  return selfSignedCertificate(stranger.privateKey, stranger.publicKey, {
    commonName: "TST-886431145-399999999900003",
  });
}

const FOREIGN_CERT_PEM = foreignCertificate();

/** A scripted ZATCA API. */
function fakeClient(overrides: Partial<ZatcaOnboardingClient> = {}): ZatcaOnboardingClient & {
  otpsSeen: string[];
} {
  const otpsSeen: string[] = [];
  return {
    otpsSeen,
    async requestComplianceCsid(_env, _csr, otp) {
      otpsSeen.push(otp);
      return {
        requestId: "1234567890123",
        certificatePem: FOREIGN_CERT_PEM,
        secret: "ccsid-secret",
        binarySecurityToken: "dG9rZW4=",
      };
    },
    async submitComplianceDocument() {
      return PASS;
    },
    async requestProductionCsid() {
      return {
        requestId: "30368",
        certificatePem: FOREIGN_CERT_PEM,
        secret: "pcsid-secret",
        binarySecurityToken: "dG9rZW4=",
      };
    },
    ...overrides,
  };
}

describeMaybe("M12.4 — ZATCA onboarding flow", () => {
  let completeCompanyId: string;
  let orgId = "";
  let incompleteCompanyId: string;

  async function cleanup(): Promise<void> {
    await pool.query(
      `DELETE FROM zatca_credentials WHERE company_id IN
         (SELECT id FROM companies WHERE organization_id IN
           (SELECT id FROM organizations WHERE slug = $1))`,
      [SLUG],
    );
    await pool.query(
      `DELETE FROM companies WHERE organization_id IN (SELECT id FROM organizations WHERE slug=$1)`,
      [SLUG],
    );
    await pool.query(`DELETE FROM organizations WHERE slug = $1`, [SLUG]);
  }

  /**
   * 🔴 The service calls below now run INSIDE a tenant transaction, as they do
   * in production: `/zatca/onboarding` is mounted on the tenant router, so
   * `companiesRepository.findById` resolves to the RLS-scoped handle there.
   * This fixture used to call the services bare and reach the database through
   * the proxy's silent owner fallback — testing the code with RLS bypassed,
   * which is not the configuration the product runs in.
   */
  async function inTenant<T>(fn: () => Promise<T>): Promise<T> {
    const { beginTenantConnection } = await import("@workspace/db");
    const conn = await beginTenantConnection({
      organizationId: orgId,
      companyId: completeCompanyId,
      role: "authenticated",
    });
    try {
      const out = await conn.run(fn);
      await conn.commit();
      return out;
    } catch (e) {
      await conn.rollback();
      throw e;
    }
  }

  beforeAll(async () => {
    await cleanup();
    const org = await pool.query(
      `INSERT INTO organizations (name, slug, verification_status)
       VALUES ('Onboarding','${SLUG}','approved') RETURNING id`,
    );
    completeCompanyId = (
      await pool.query(
        `INSERT INTO companies
           (organization_id, name, name_ar, cr_number, vat_number,
            building_number, street, district, city, postal_code, additional_number)
         VALUES ($1,'Al-Rashid Trading Est.','مؤسسة الراشد','1010101010','310123456789013',
                 '1234','King Fahd Road','Al Olaya','Riyadh','12345','6789')
         RETURNING id`,
        [org.rows[0].id],
      )
    ).rows[0].id;
    incompleteCompanyId = (
      await pool.query(
        `INSERT INTO companies (organization_id, name) VALUES ($1,'Bare Co') RETURNING id`,
        [org.rows[0].id],
      )
    ).rows[0].id;
    orgId = org.rows[0].id;
  });

  afterAll(async () => {
    await cleanup();
  });

  it("surfaces every missing prerequisite before onboarding can start", async () => {
    const status = await inTenant(() => zatcaOnboardingService.status(incompleteCompanyId, "sandbox"));
    expect(status.ready).toBe(false);

    const missing = status.prerequisites.filter((p) => !p.satisfied).map((p) => p.key);
    // The M11.6 fields, including the two that only schematron reveals.
    expect(missing).toContain("vatNumber");
    expect(missing).toContain("crNumber");
    expect(missing).toContain("nameAr");
    expect(missing).toContain("additionalNumber");
    // Every unmet item explains itself — the checklist is actionable.
    expect(status.prerequisites.filter((p) => !p.satisfied).every((p) => p.hint.length > 0)).toBe(true);
  });

  it("reports ready when the company is complete", async () => {
    const status = await inTenant(() => zatcaOnboardingService.status(completeCompanyId, "sandbox"));
    expect(status.ready).toBe(true);
    expect(status.certificate).toBeNull();
  });

  it("refuses to onboard an incomplete company, naming the missing fields", async () => {
    await expect(
      inTenant(() =>
        zatcaOnboardingService.onboard(
          { companyId: incompleteCompanyId, otp: "123456", environment: "sandbox" },
          fakeClient(),
        ),
      ),
    ).rejects.toMatchObject({
      statusCode: 400,
      payload: { code: "zatca_prerequisites_missing" },
    });
  });

  it("requires an OTP", async () => {
    await expect(
      inTenant(() =>
        zatcaOnboardingService.onboard(
          { companyId: completeCompanyId, otp: "   ", environment: "sandbox" },
          fakeClient(),
        ),
      ),
    ).rejects.toMatchObject({ statusCode: 400, payload: { code: "zatca_otp_required" } });
  });

  it("submits all SIX compliance documents", async () => {
    const labels: string[] = [];
    const client = fakeClient({
      async submitComplianceDocument(_e, _c, doc) {
        labels.push(doc.uuid);
        return PASS;
      },
    });

    const result = await inTenant(() =>
      zatcaOnboardingService.onboard(
        { companyId: completeCompanyId, otp: "123456", environment: "sandbox" },
        client,
      ),
    ).catch((e: unknown) => e);

    // Activation fails on the canned certificate (next test), but all six
    // documents must have been submitted before that point.
    expect(labels).toHaveLength(6);
    void result;
  });

  it("🔴 REFUSES the sandbox's canned production certificate — it is not bound to our key", async () => {
    /**
     * The most dangerous thing found in M12.4. ZATCA's sandbox returns a SHARED
     * certificate (CN=TST-886431145-399999999900003, "Maximum Speed Tech Supply
     * LTD") that belongs to no one. Storing it would leave the tenant holding a
     * credential that cannot sign — or signing as another taxpayer.
     *
     * The public-key check in activateCredential is correct in EVERY
     * environment and catches this automatically.
     */
    const err = await inTenant(() =>
        zatcaOnboardingService.onboard({ companyId: completeCompanyId, otp: "123456", environment: "sandbox" }, fakeClient()),
      )
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CertificateMismatchError);

    // Nothing was activated.
    const status = await inTenant(() => zatcaOnboardingService.status(completeCompanyId, "sandbox"));
    expect(status.certificate).toBeNull();
  });

  it("does NOT request a production CSID when a compliance document fails", async () => {
    let productionRequested = false;
    const client = fakeClient({
      async submitComplianceDocument(_e, _c, _d) {
        return {
          status: "ERROR",
          errors: [{ code: "BR-KSA-10", message: "buyer address invalid" }],
          warnings: [],
        };
      },
      async requestProductionCsid() {
        productionRequested = true;
        throw new Error("must not be called");
      },
    });

    const result = await inTenant(() => zatcaOnboardingService.onboard(
      { companyId: completeCompanyId, otp: "123456", environment: "sandbox" },
      client,
    ));

    // 🔴 Asserted here rather than inferred from PCSID issuance: the sandbox
    // issues a PCSID even when documents FAIL, so "we got a certificate" is not
    // evidence of compliance.
    expect(productionRequested).toBe(false);
    expect(result.activated).toBe(false);
    expect(result.complianceDocuments.every((d) => !d.passed)).toBe(true);
    expect(result.complianceDocuments[0].errors[0].code).toBe("BR-KSA-10");
  });

  it("passes the OTP through exactly once and never stores it", async () => {
    const client = fakeClient();
    await inTenant(() =>
        zatcaOnboardingService.onboard({ companyId: completeCompanyId, otp: " 987654 ", environment: "sandbox" }, client),
      )
      .catch(() => undefined);

    expect(client.otpsSeen).toEqual(["987654"]); // trimmed, used once

    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM zatca_credentials
        WHERE company_id = $1 AND (csr_pem LIKE '%987654%' OR egs_serial_number LIKE '%987654%')`,
      [completeCompanyId],
    );
    expect(rows[0].n).toBe(0);
  });

  it("activates when the certificate DOES match the generated key", async () => {
    // The honest positive path: mint a certificate over the credential's own
    // public key, which is what simulation/production actually return.
    const created = await signingService.createCredential({
      companyId: completeCompanyId,
      environment: "simulation",
      csr: {
        commonName: "SLP-MATCH",
        organizationName: "Al-Rashid Trading Est.",
        organizationalUnitName: "Head Office",
        countryName: "SA",
        invoiceType: "1100",
        locationAddress: "Riyadh",
        industryBusinessCategory: "Trading",
        organizationIdentifier: "310123456789013",
        egsSerialNumber: "1-SLP|2-Platform|3-MATCH",
        production: false,
      },
    });

    const selfSigned = await signingService.withCredentialKey(
      created.credentialId,
      ({ privateKey, publicKey }) => selfSignedCertificate(privateKey, publicKey),
    );

    await signingService.activateCredential({
      credentialId: created.credentialId,
      certificatePem: selfSigned,
      csidSecret: "pcsid-secret",
      notBefore: new Date("2026-08-09T00:00:00Z"),
      notAfter: new Date("2031-08-08T21:00:00Z"),
    });

    const status = await inTenant(() => zatcaOnboardingService.status(completeCompanyId, "simulation"));
    expect(status.certificate?.status).toBe("active");
    // The 5-year expiry the renewal reminders key off.
    expect(status.certificate?.daysUntilExpiry).toBeGreaterThan(1000);

    // And it can actually sign.
    const sig = await signingService.withSigningKey(completeCompanyId, "simulation", (key) =>
      createSign("sha256").update(Buffer.from("x")).sign(key),
    );
    expect(sig.length).toBeGreaterThan(0);
  });
});

