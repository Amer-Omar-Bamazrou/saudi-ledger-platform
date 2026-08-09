/**
 * `zatca-direct` — our own implementation of {@link EInvoiceProvider}
 * (M12.2 XML, M12.3 signing).
 *
 * This is the default provider: we build, sign and submit to ZATCA ourselves
 * rather than paying a vendor per taxpayer. `buildDocument` now builds AND
 * signs; onboarding and submission still fail loudly with a typed
 * {@link NotImplementedError} naming the milestone that delivers them, so a
 * caller can never mistake "not built yet" for "succeeded with nulls".
 */
import { buildInvoiceXml } from "../ubl/buildInvoiceXml";
import { assembleSignedInvoice } from "../crypto/assembleSignedInvoice";
import {
  NotImplementedError,
  type EInvoiceProvider,
  type OnboardingInput,
  type OnboardingResult,
  type SubmissionFlow,
  type SigningCredentials,
  type SubmissionResult,
} from "../provider";
import type { BuiltDocument, EInvoiceInput } from "../types";

export const zatcaDirectProvider: EInvoiceProvider = {
  name: "zatca-direct",

  async onboard(_input: OnboardingInput): Promise<OnboardingResult> {
    // CSR (secp256k1, invoice type in `title` NOT businessCategory) → Compliance
    // CSID → the six compliance documents → Production CSID.
    throw new NotImplementedError("ZATCA onboarding", "M12.4/M12.5");
  },

  async renewCertificate(_companyId: string): Promise<OnboardingResult> {
    throw new NotImplementedError("Certificate renewal", "M12.5");
  },

  async buildDocument(input: EInvoiceInput, credentials?: SigningCredentials): Promise<BuiltDocument> {
    const xml = buildInvoiceXml(input);

    // Without credentials this is an UNSIGNED preview: the document is real UBL
    // but carries no hash, QR or signature. Issuance must never take this path —
    // the caller supplies credentials from the M12.5 vault once it exists.
    if (!credentials) {
      return {
        xml,
        invoiceHash: null,
        qrCode: null,
        previousInvoiceHash: input.previousInvoiceHash,
        uuid: input.uuid,
        icv: input.icv,
      };
    }

    const assembled = assembleSignedInvoice({
      xml,
      certificatePem: credentials.certificatePem,
      privateKey: credentials.privateKey,
      publicKey: credentials.publicKey,
      qr: {
        sellerName: input.seller.legalName,
        vatNumber: input.seller.vatNumber ?? "",
        // The Date itself — assembleSignedInvoice formats it with the SAME
        // helper the XML uses, so tag 3 cannot drift from cbc:IssueTime.
        issuedAt: input.issuedAt,
        totalWithVat: input.taxInclusiveTotal,
        vatTotal: input.taxTotal,
      },
    });

    return {
      xml: assembled.signedXml,
      invoiceHash: assembled.invoiceHash,
      qrCode: assembled.qrCode,
      previousInvoiceHash: input.previousInvoiceHash,
      uuid: input.uuid,
      icv: input.icv,
    };
  },

  async submit(_doc: BuiltDocument, _flow: SubmissionFlow): Promise<SubmissionResult> {
    // Clearance/reporting runs OUTSIDE the request transaction via the outbox —
    // a synchronous ZATCA call cannot be held inside the tenant transaction.
    throw new NotImplementedError("Clearance/reporting submission", "M12.6");
  },
};

/**
 * Resolve the provider for a company. Selection is per-company because ZATCA
 * identity is per EGS unit; today everyone is `zatca-direct`, and a vendor
 * implementation registers here without touching call sites.
 */
export function resolveProvider(providerName?: string | null): EInvoiceProvider {
  switch (providerName ?? "zatca-direct") {
    case "zatca-direct":
      return zatcaDirectProvider;
    default:
      throw new Error(`Unknown e-invoice provider: ${providerName}`);
  }
}
