/**
 * `zatca-direct` — our own implementation of {@link EInvoiceProvider} (M12.2).
 *
 * This is the default provider: we build, sign and submit to ZATCA ourselves
 * rather than paying a vendor per taxpayer. Only the XML half of
 * `buildDocument` exists today; the rest fail loudly with a typed
 * {@link NotImplementedError} naming the milestone that delivers them, so a
 * caller can never mistake "not built yet" for "succeeded with nulls".
 */
import { buildInvoiceXml } from "../ubl/buildInvoiceXml";
import {
  NotImplementedError,
  type EInvoiceProvider,
  type OnboardingInput,
  type OnboardingResult,
  type SubmissionFlow,
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

  async buildDocument(input: EInvoiceInput): Promise<BuiltDocument> {
    const xml = buildInvoiceXml(input);
    return {
      xml,
      // Minted in M12.3: base64(SHA-256(C14N xml)) and the 9-tag TLV QR. They
      // are explicitly null rather than absent so persistence stays honest
      // about the document being unsigned.
      invoiceHash: null,
      qrCode: null,
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
