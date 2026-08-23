/**
 * `zatca-direct` — our own implementation of {@link EInvoiceProvider}.
 *
 * This is the default provider: we build, sign, onboard and submit ourselves
 * rather than paying a vendor per taxpayer.
 *
 * ── 🔴 S1 (M12 close-out): THE SEAM WAS ONLY ONE-THIRD WIRED ────────────────
 * Until now `onboard`, `renewCertificate` and `submit` all threw
 * `NotImplementedError`, and the real code paths bypassed this file entirely:
 * onboarding called `zatcaOnboardingClient` directly and the worker called
 * `ZatcaHttpClient` directly. Only `buildDocument` went through the seam.
 *
 * That mattered because the seam is one of the TWO MANDATORY HEDGES behind the
 * decision to build direct rather than buy from a certified provider. As it
 * stood, a vendor could have been slotted in for document BUILDING only — the
 * part we are strongest at and the least of what a provider actually sells.
 * **A hedge that covers only the part you don't need is not a hedge.** All four
 * methods now route through here, so swapping a vendor per company is a real
 * option rather than a claim.
 *
 * ── Why this is a FACTORY ───────────────────────────────────────────────────
 * Transport dependencies are injected so the outbox tests can drive a fake HTTP
 * boundary through the SAME seam production uses, rather than around it. The
 * default instance wires the live client and the credential vault.
 */
import { buildInvoiceXml } from "../ubl/buildInvoiceXml";
import { assembleSignedInvoice } from "../crypto/assembleSignedInvoice";
import { createLiveZatcaClient } from "./liveZatcaClient";
import { mapZatcaResponse } from "./errorMapping";
import { signingService, SigningError } from "../signing/signing.service";
import { zatcaOnboardingService } from "../onboarding/zatcaOnboarding.service";
import { defaultOnboardingEnvironment } from "../onboarding/zatcaOnboardingClient";
import type { ZatcaHttpClient } from "./zatcaHttpClient";
import {
  type EInvoiceProvider,
  type OnboardingInput,
  type OnboardingResult,
  type RenewalInput,
  type SubmissionContext,
  type SubmissionFlow,
  type SigningCredentials,
  type SubmissionResult,
} from "../provider";
import type { BuiltDocument, EInvoiceInput } from "../types";

/** Transport credentials for ZATCA's Basic auth. */
export interface TransportCredentials {
  certificateBase64: string;
  secret: string;
}

export interface ZatcaDirectDeps {
  /** Defaults to the live client for the configured environment. */
  client?: ZatcaHttpClient;
  /** Defaults to the M12.5 vault. Returns null when the company is not onboarded. */
  resolveTransportCredentials?: (companyId: string) => Promise<TransportCredentials | null>;
}

export function createZatcaDirectProvider(deps: ZatcaDirectDeps = {}): EInvoiceProvider {
  const client = deps.client ?? createLiveZatcaClient(defaultOnboardingEnvironment());

  const resolveCredentials =
    deps.resolveTransportCredentials ??
    (async (companyId: string) => {
      try {
        return await signingService.withTransportCredentials(
          companyId,
          defaultOnboardingEnvironment(),
          (creds) => creds,
        );
      } catch (err) {
        // 🔴 Only the two DURABLE not-ready states mean "not onboarded"
        // (audit 2026-08-20, MED). The old bare `catch → null` conflated a
        // KMS outage or DB error with "no credentials" — so a TRANSIENT
        // failure was reported as "is the company onboarded?" and burned an
        // outbox attempt against the 24-hour deadline with a diagnosis that
        // sent the operator to the wrong place. A real failure now
        // propagates; the outbox records the true reason and retries.
        if (
          err instanceof SigningError &&
          (err.stage === "no-active-credential" || err.stage === "credential-not-activated")
        ) {
          return null;
        }
        throw err;
      }
    });

  return {
    name: "zatca-direct",

    async onboard(input: OnboardingInput): Promise<OnboardingResult> {
      return runOnboarding(input);
    },

    /**
     * Renewal is the SAME FLOW as onboarding, and that is not a shortcut.
     *
     * ZATCA issues a certificate against a fresh CSR authorised by a new OTP —
     * there is no "extend" operation. And `vaultRepository.activate` already
     * supersedes any existing active credential for the (company, environment)
     * **inside one transaction**, so re-running onboarding rotates atomically:
     * there is never a moment with two active credentials or none.
     *
     * The old credential is retained as `superseded`, not deleted — invoices
     * signed under it must stay verifiable for ZATCA's 6–11 year retention.
     */
    async renewCertificate(input: RenewalInput): Promise<OnboardingResult> {
      return runOnboarding(input);
    },

    async buildDocument(input: EInvoiceInput, credentials?: SigningCredentials): Promise<BuiltDocument> {
      const xml = buildInvoiceXml(input);

      // Without credentials this is an UNSIGNED preview: real UBL, but no hash,
      // QR or signature. Issuance must never take this path.
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

    /**
     * Clearance (standard) or reporting (simplified).
     *
     * 🔴 UNPROVEN AGAINST ZATCA. `/invoices/clearance/single` and
     * `/invoices/reporting/single` have never returned a response in any
     * environment — M12.4's green compliance run used `/compliance/invoices`,
     * a different endpoint that validates document CONSTRUCTION. Expect the
     * response mapping below to need correction on first real contact; every
     * previous first contact with a live ZATCA endpoint produced divergences.
     * See `docs/zatca/m12-status.md` §0.
     */
    async submit(
      doc: BuiltDocument,
      flow: SubmissionFlow,
      context: SubmissionContext,
    ): Promise<SubmissionResult> {
      if (!doc.invoiceHash) {
        return {
          status: "failed",
          zatcaStatus: null,
          clearedXml: null,
          warnings: null,
          errors: [{ reason: "document has no invoice hash; it was never signed" }],
          ambiguous: false,
        };
      }

      const credentials = await resolveCredentials(context.companyId);
      if (!credentials) {
        return {
          status: "failed",
          zatcaStatus: null,
          clearedXml: null,
          warnings: null,
          errors: [{ reason: "no ZATCA credentials for this company; is it onboarded?" }],
          ambiguous: false,
        };
      }

      const response = await client.send({
        endpoint: flow,
        invoiceBase64: Buffer.from(doc.xml, "utf-8").toString("base64"),
        // 🔴 ZATCA's document UUID — MUST match `cbc:UUID` in the signed XML.
        uuid: context.uuid,
        invoiceHash: doc.invoiceHash,
        credentials,
      });

      const outcome = mapZatcaResponse(response, flow);
      return {
        // `needs_review` is an OUTBOX state, not a provider outcome — the
        // repository assigns it when attempts are exhausted or the result is
        // ambiguous. At the provider boundary it is simply a failure.
        status: outcome.status === "needs_review" ? "failed" : outcome.status,
        zatcaStatus: outcome.zatcaStatus,
        clearedXml: outcome.clearedXml,
        warnings: outcome.warnings,
        errors: outcome.errors,
        ambiguous: outcome.ambiguous,
      };
    },
  };
}

/** Shared by onboard and renew — see `renewCertificate` for why they are one flow. */
async function runOnboarding(input: OnboardingInput): Promise<OnboardingResult> {
  const result = await zatcaOnboardingService.onboard({
    companyId: input.companyId,
    otp: input.otp,
    environment: input.environment,
  });

  const metadata = result.activated
    ? await signingService.findActiveMetadata(
        input.companyId,
        input.environment ?? defaultOnboardingEnvironment(),
      )
    : null;

  return {
    credentialRef: result.activated ? (metadata?.egsSerialNumber ?? input.companyId) : null,
    certificateExpiresAt: metadata?.notAfter ?? null,
    activated: result.activated,
    documentChecks: result.complianceDocuments.map((d) => ({
      label: d.label,
      passed: d.passed,
      errors: d.errors,
      warnings: d.warnings,
    })),
  };
}

/** The default provider instance — live client, real vault. */
export const zatcaDirectProvider: EInvoiceProvider = createZatcaDirectProvider();

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
