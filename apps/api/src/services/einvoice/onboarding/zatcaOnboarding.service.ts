/**
 * Per-tenant ZATCA onboarding (M12.4): CSR → Compliance CSID → the six
 * compliance documents → Production CSID.
 *
 * ── The OTP boundary ────────────────────────────────────────────────────────
 * The tenant generates the OTP themselves in their own Fatoora portal and pastes
 * it here. We never see, store, or proxy their ERAD credentials — the OTP is
 * used once, in-memory, for a single CSID request and is never persisted.
 *
 * ── 🔴 Sandbox traps this flow must not be read through ─────────────────────
 *   - The sandbox accepts ANY OTP. A successful sandbox onboarding says NOTHING
 *     about whether the real OTP path works.
 *   - The sandbox's compliance `requestID` is the constant stub 1234567890123.
 *     No reconciliation logic may depend on it.
 *   - The sandbox issues a PCSID even when compliance documents FAIL, and the
 *     certificate it returns is a SHARED CANNED CERT bound to another key. That
 *     is caught by `activateCredential`'s public-key check, which refuses it.
 *
 * Because of the third point, compliance results are asserted HERE rather than
 * inferred from "we got a PCSID".
 */
import { randomUUID } from "node:crypto";
import type { ZatcaEnvironment } from "@workspace/db";
import { BusinessRuleError, NotFoundError } from "../../../lib/errors";
import { companiesRepository } from "../../../repositories/companies.repository";
import { signingService } from "../signing/signing.service";
import { buildInvoiceXml } from "../ubl/buildInvoiceXml";
import { assembleSignedInvoice } from "../crypto/assembleSignedInvoice";
import { complianceDocumentSet } from "./complianceDocuments";
import {
  defaultOnboardingEnvironment,
  zatcaOnboardingClient,
  type ComplianceValidation,
  type ZatcaOnboardingClient,
} from "./zatcaOnboardingClient";

/** One prerequisite the tenant must satisfy before onboarding can start. */
export interface Prerequisite {
  key: string;
  label: string;
  satisfied: boolean;
  hint: string;
}

export interface OnboardingStatus {
  environment: ZatcaEnvironment;
  prerequisites: Prerequisite[];
  ready: boolean;
  certificate: {
    status: string;
    notAfter: string | null;
    daysUntilExpiry: number | null;
    egsSerialNumber: string | null;
  } | null;
}

export interface ComplianceDocumentOutcome {
  label: string;
  passed: boolean;
  errors: { code: string; message: string }[];
  warnings: { code: string; message: string }[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The M11.6 company fields ZATCA needs. Surfaced BEFORE onboarding starts so a
 * tenant fixes them in Company Settings rather than hitting an opaque rejection
 * from ZATCA halfway through.
 */
function prerequisitesFor(company: {
  vatNumber: string | null;
  crNumber: string | null;
  nameAr: string | null;
  buildingNumber: string | null;
  street: string | null;
  district: string | null;
  city: string | null;
  postalCode: string | null;
  additionalNumber: string | null;
}): Prerequisite[] {
  const req = (key: string, label: string, value: string | null, hint: string): Prerequisite => ({
    key,
    label,
    satisfied: Boolean(value && value.trim()),
    hint,
  });

  return [
    req("vatNumber", "VAT registration number", company.vatNumber, "15 digits, starting and ending with 3. Stamped into every invoice's QR and hash."),
    req("crNumber", "Commercial registration (CR)", company.crNumber, "10 digits. Identifies the seller on standard invoices."),
    req("nameAr", "Arabic legal name", company.nameAr, "Required on ZATCA Phase 2 invoices."),
    req("buildingNumber", "Building number", company.buildingNumber, "4 digits — BR-KSA-09, and capped at 4 characters by BR-CL-KSA-17."),
    req("street", "Street", company.street, "National Address street name."),
    req("district", "District / neighbourhood", company.district, "KSA-3 — required by BR-KSA-09."),
    req("city", "City", company.city, "BT-37."),
    req("postalCode", "Postal code", company.postalCode, "5 digits — BT-38."),
    req("additionalNumber", "Additional number", company.additionalNumber, "KSA-23, 4 digits. BR-KSA-09 needs it; the rule text does not say so."),
  ];
}

export const zatcaOnboardingService = {
  /** The checklist plus the current certificate state. */
  async status(companyId: string, environment?: ZatcaEnvironment): Promise<OnboardingStatus> {
    const env = environment ?? defaultOnboardingEnvironment();
    const company = await companiesRepository.findById(companyId);
    if (!company) throw new NotFoundError("Company not found");

    const prerequisites = prerequisitesFor(company);
    const active = await signingService.findActiveMetadata(companyId, env);

    return {
      environment: env,
      prerequisites,
      ready: prerequisites.every((p) => p.satisfied),
      certificate: active
        ? {
            status: active.status,
            notAfter: active.notAfter ? active.notAfter.toISOString() : null,
            daysUntilExpiry: active.notAfter
              ? Math.floor((active.notAfter.getTime() - Date.now()) / DAY_MS)
              : null,
            egsSerialNumber: active.egsSerialNumber,
          }
        : null,
    };
  },

  /**
   * Run the whole onboarding. The OTP is used once and never stored.
   *
   * Compliance results are RETURNED rather than swallowed: if any document
   * fails, the production CSID is not requested and the caller sees exactly
   * which ZATCA rule rejected which document.
   */
  async onboard(
    input: { companyId: string; otp: string; environment?: ZatcaEnvironment },
    client: ZatcaOnboardingClient = zatcaOnboardingClient,
  ): Promise<{ complianceDocuments: ComplianceDocumentOutcome[]; activated: boolean }> {
    const env = input.environment ?? defaultOnboardingEnvironment();
    const company = await companiesRepository.findById(input.companyId);
    if (!company) throw new NotFoundError("Company not found");

    const missing = prerequisitesFor(company).filter((p) => !p.satisfied);
    if (missing.length > 0) {
      throw new BusinessRuleError(400, {
        code: "zatca_prerequisites_missing",
        error:
          "Complete these in Company Settings before onboarding to ZATCA: " +
          missing.map((m) => m.label).join(", ") + ".",
        missing: missing.map((m) => m.key),
      });
    }
    if (!input.otp?.trim()) {
      throw new BusinessRuleError(400, {
        code: "zatca_otp_required",
        error: "Generate a one-time password in your Fatoora portal and paste it here.",
      });
    }

    // EGS serial identifies this solution unit to ZATCA. Stable per company.
    const egsSerialNumber = company.egsSerialNumber ?? `1-SaudiLedger|2-Platform|3-${company.id}`;

    // 1. Key + CSR, stored encrypted before the key is ever used.
    const { credentialId, csrPem } = await signingService.createCredential({
      companyId: input.companyId,
      environment: env,
      csr: {
        commonName: `SLP-${company.id.slice(0, 8)}`,
        organizationName: company.name,
        organizationalUnitName: company.name,
        countryName: "SA",
        // Both invoice types ⇒ all six compliance documents.
        invoiceType: "1100",
        locationAddress: [company.buildingNumber, company.street, company.city]
          .filter(Boolean)
          .join(", "),
        industryBusinessCategory: "General",
        organizationIdentifier: company.vatNumber!,
        egsSerialNumber,
        production: env === "production",
      },
    });

    // 2. Compliance CSID. The OTP dies here.
    const ccsid = await client.requestComplianceCsid(env, csrPem, input.otp.trim());

    // 3. Sign all six compliance documents INSIDE one scoped key access — the
    //    key never leaves the callback, and no network call happens while it is
    //    in memory.
    const documents = complianceDocumentSet({
      seller: {
        legalName: company.name,
        vatNumber: company.vatNumber!,
        identification: { schemeId: "CRN", value: company.crNumber! },
        address: {
          buildingNumber: company.buildingNumber!,
          street: company.street!,
          district: company.district!,
          city: company.city!,
          postalCode: company.postalCode!,
          additionalNumber: company.additionalNumber!,
          province: null,
          countryCode: "SA",
        },
      },
      uuid: () => randomUUID(),
    });

    const signedDocuments = await signingService.withCredentialKey(credentialId, ({ privateKey, publicKey }) =>
      documents.map((doc) => {
        const assembled = assembleSignedInvoice({
          xml: buildInvoiceXml(doc.input),
          certificatePem: ccsid.certificatePem,
          privateKey,
          publicKey,
          qr: {
            sellerName: doc.input.seller.legalName,
            // Non-null: the prerequisites check above rejects a company with no
            // VAT number before any key or document is created.
            vatNumber: company.vatNumber!,
            issuedAt: doc.input.issuedAt,
            totalWithVat: doc.input.taxInclusiveTotal,
            vatTotal: doc.input.taxTotal,
          },
        });
        return {
          label: doc.label,
          uuid: doc.input.uuid,
          invoiceHash: assembled.invoiceHash,
          signedXmlBase64: Buffer.from(assembled.signedXml, "utf8").toString("base64"),
        };
      }),
    );

    const complianceDocuments: ComplianceDocumentOutcome[] = [];
    for (const doc of signedDocuments) {
      const result: ComplianceValidation = await client.submitComplianceDocument(
        env,
        { binarySecurityToken: ccsid.binarySecurityToken, secret: ccsid.secret },
        { invoiceHash: doc.invoiceHash, uuid: doc.uuid, signedXmlBase64: doc.signedXmlBase64 },
      );
      complianceDocuments.push({
        label: doc.label,
        passed: result.status === "PASS" && result.errors.length === 0,
        errors: result.errors,
        warnings: result.warnings,
      });
    }

    // 🔴 Asserted here, NOT inferred from PCSID issuance — the sandbox issues a
    // PCSID even when documents fail.
    if (complianceDocuments.some((d) => !d.passed)) {
      await signingService.revokeCredential(credentialId, "compliance checks failed");
      return { complianceDocuments, activated: false };
    }

    // 4. Production CSID, then activate. `activateCredential` refuses a
    //    certificate whose public key is not ours — which is exactly what the
    //    sandbox returns.
    const pcsid = await client.requestProductionCsid(
      env,
      { binarySecurityToken: ccsid.binarySecurityToken, secret: ccsid.secret },
      ccsid.requestId,
    );

    const cert = signingService.certificateValidity(pcsid.certificatePem);
    await signingService.activateCredential({
      credentialId,
      certificatePem: pcsid.certificatePem,
      csidSecret: pcsid.secret,
      notBefore: cert.notBefore,
      notAfter: cert.notAfter,
    });

    return { complianceDocuments, activated: true };
  },
};
