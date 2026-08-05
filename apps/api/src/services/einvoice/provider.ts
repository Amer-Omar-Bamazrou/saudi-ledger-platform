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
import type { BuiltDocument, EInvoiceInput } from "./types";

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
  /** One-time password the taxpayer generates in the Fatoora portal. */
  otp: string;
  /** EGS serial in ZATCA's validated `1-<Mfr>|2-<Model>|3-<Serial>` format. */
  egsSerialNumber: string;
  /** 4-digit TSCZ invoice-type flags, e.g. "1100" = standard + simplified. */
  invoiceTypeFlags: string;
}

export interface OnboardingResult {
  /** Opaque handle to the stored credential — NEVER the key material itself. */
  credentialRef: string;
  certificateExpiresAt: Date;
}

export type SubmissionFlow = "clearance" | "reporting";

export interface SubmissionResult {
  /** Mirrors `einvoice_documents.status`. */
  status: "cleared" | "reported" | "rejected" | "failed";
  /** ZATCA's own status string, verbatim. */
  zatcaStatus: string | null;
  /** ZATCA's stamped XML — the legal document. Clearance flow only. */
  clearedXml: string | null;
  warnings: unknown[] | null;
  errors: unknown[] | null;
}

export interface EInvoiceProvider {
  /** Stored on the company; identifies which implementation issued a document. */
  readonly name: string;

  /** CSR → Compliance CSID → compliance checks → Production CSID. */
  onboard(input: OnboardingInput): Promise<OnboardingResult>;

  /** Re-key before PCSID expiry (5-year validity, no grace period). */
  renewCertificate(companyId: string): Promise<OnboardingResult>;

  /**
   * Produce the document: UBL 2.1 XML, and — from M12.3 — the XAdES signature,
   * invoice hash and 9-tag QR. Does NOT transmit.
   */
  buildDocument(input: EInvoiceInput): Promise<BuiltDocument>;

  /** Clearance (standard) or reporting (simplified). */
  submit(doc: BuiltDocument, flow: SubmissionFlow): Promise<SubmissionResult>;
}
