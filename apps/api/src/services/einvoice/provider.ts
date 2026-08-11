/**
 * The `EInvoiceProvider` seam (M12.2) — the swap point between building ZATCA
 * compliance ourselves and buying it from a certified vendor.
 *
 * ── Why the interface is COARSE ─────────────────────────────────────────────
 * A third-party provider (Wafeq, ClearTax, Complyance, …) does not expose
 * "generate XML", "sign", and "submit" as separate operations — you hand it
 * invoice data and it hands back finished, ZATCA-accepted artifacts. An
 * interface shaped around OUR internal steps could not be implemented by any of
 * them, which would defeat the point of having a seam at all. So the contract is
 * expressed in terms of what a provider actually sells: onboard a company,
 * build a document, submit it.
 *
 * ── Why it is declared in full NOW ──────────────────────────────────────────
 * M12.2 only implements the XML half of {@link EInvoiceProvider.buildDocument}.
 * The rest throw {@link NotImplementedError} until their milestone (M12.3
 * signing, M12.4/M12.5 onboarding, M12.6 transport). Declaring the whole shape
 * up front is the difference between a seam and a retrofit: M12.6 slots
 * transport into an existing contract instead of re-architecting around one.
 *
 * ── Selection is PER COMPANY ────────────────────────────────────────────────
 * ZATCA identity is per EGS unit, i.e. per company, so provider choice is too.
 * One tenant can be moved to a vendor — or back — without affecting any other.
 */
import type { KeyObject } from "crypto";
import type { ZatcaEnvironment } from "@workspace/db";
import type { BuiltDocument, EInvoiceInput } from "./types";

/**
 * Key material for signing ONE company's invoices.
 *
 * Passed in per call and never held by the provider. In M12.3 these come from a
 * test fixture only — there is deliberately NO persistence path until the M12.5
 * KMS-encrypted, owner-only vault exists.
 */
export interface SigningCredentials {
  certificatePem: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
}

/** Thrown by provider methods whose milestone has not landed yet. */
export class NotImplementedError extends Error {
  readonly code = "not_implemented";
  constructor(what: string, milestone: string) {
    super(`${what} is not implemented yet (arrives in ${milestone}).`);
    this.name = "NotImplementedError";
  }
}

export interface OnboardingInput {
  companyId: string;
  /**
   * One-time password the taxpayer generates in the Fatoora portal.
   *
   * We never see or store their ERAD credentials; the OTP is used once and
   * discarded. This is why onboarding cannot be automated on the tenant's behalf
   * — and why a renewal reminder that fires late cannot be fixed by us.
   */
  otp: string;
  /** Which ZATCA environment. Defaults to the configured one. */
  environment?: ZatcaEnvironment;
}

/**
 * Renewal takes the same inputs as onboarding, and deliberately so.
 *
 * 🔴 The M12.2 declaration was `renewCertificate(companyId: string)` — no OTP.
 * That was wrong: ZATCA re-issues a certificate only against a fresh CSR
 * authorised by a new OTP from the taxpayer's own portal. The original signature
 * quietly implied renewal was something the platform could do unattended, which
 * is the opposite of true and is the single most important operational fact
 * about certificate expiry. Corrected in M12.8's follow-up.
 */
export type RenewalInput = OnboardingInput;

export interface OnboardingResult {
  /**
   * Opaque handle to the stored credential — NEVER the key material itself.
   * `null` when onboarding did not activate (e.g. compliance checks failed).
   */
  credentialRef: string | null;
  certificateExpiresAt: Date | null;
  /** Whether the company can now sign. False ⇒ inspect `documentChecks`. */
  activated: boolean;
  /**
   * Per-document validation detail, when the provider exposes it.
   *
   * For `zatca-direct` these are ZATCA's six compliance documents. Optional
   * because a vendor performs its own onboarding and may report only success or
   * failure — but when detail IS available it must reach the UI, since "ZATCA
   * rejected you" without the rule that failed is not actionable.
   */
  documentChecks?: { label: string; passed: boolean; errors: unknown[]; warnings: unknown[] }[];
}

export type SubmissionFlow = "clearance" | "reporting";

/** What a provider needs to know about WHOSE invoice it is submitting. */
export interface SubmissionContext {
  /**
   * ZATCA identity is per EGS unit, i.e. per company. The provider resolves its
   * own credentials from this — they are never passed in, because a vendor holds
   * its own and ours must not leave the vault's scoped callback.
   */
  companyId: string;
  /**
   * ZATCA's document UUID (`cbc:UUID`), which MUST match the value inside the
   * signed XML. Carried explicitly rather than re-derived, because a mismatch
   * is rejected and is invisible to every offline check.
   */
  uuid: string;
}

export interface SubmissionResult {
  /** Mirrors `einvoice_documents.status`. */
  status: "cleared" | "reported" | "rejected" | "failed";
  /** ZATCA's own status string, verbatim. */
  zatcaStatus: string | null;
  /** ZATCA's stamped XML — the legal document. Clearance flow only. */
  clearedXml: string | null;
  warnings: unknown[] | null;
  errors: unknown[] | null;
  /**
   * TRUE when the outcome is UNKNOWN — a timeout or socket failure that may or
   * may not have been processed. Forbids a blind retry; the document goes to
   * `needs_review` instead.
   */
  ambiguous: boolean;
}

export interface EInvoiceProvider {
  /** Stored on the company; identifies which implementation issued a document. */
  readonly name: string;

  /** CSR → Compliance CSID → compliance checks → Production CSID. */
  onboard(input: OnboardingInput): Promise<OnboardingResult>;

  /**
   * Re-key before PCSID expiry (5-year validity, no grace period).
   *
   * Requires the tenant's OTP — see {@link RenewalInput}.
   */
  renewCertificate(input: RenewalInput): Promise<OnboardingResult>;

  /**
   * Produce the document: UBL 2.1 XML plus, when `credentials` are supplied, the
   * XAdES signature, invoice hash and 9-tag QR. Does NOT transmit.
   *
   * Omitting `credentials` yields an UNSIGNED preview with null hash/QR — never
   * valid for issuance.
   */
  buildDocument(input: EInvoiceInput, credentials?: SigningCredentials): Promise<BuiltDocument>;

  /** Clearance (standard) or reporting (simplified). */
  submit(doc: BuiltDocument, flow: SubmissionFlow, context: SubmissionContext): Promise<SubmissionResult>;
}
