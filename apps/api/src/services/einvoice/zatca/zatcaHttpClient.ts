/**
 * The ZATCA HTTP boundary (M12.6).
 *
 * ── Why this is a separate, narrow interface ────────────────────────────────
 * This is the ONLY place the worker touches the network, which makes every
 * other part of the transport — claiming, backoff, state transitions,
 * idempotency, reconciliation — testable without ZATCA connectivity. That is
 * not merely convenient: at time of writing ZATCA's API hosts are unreachable
 * (see `docs/zatca/README.md`), so a design that could only be exercised
 * against the live API could not be verified at all.
 *
 * **Tests that mock this boundary prove the TRANSPORT MECHANICS. They prove
 * nothing about whether ZATCA accepts our documents** — that is M12.4/M12.7,
 * against the real API.
 */

/** What ZATCA endpoints the worker can call. */
export type ZatcaEndpoint = "clearance" | "reporting" | "status";

export interface ZatcaRequest {
  endpoint: ZatcaEndpoint;
  /** base64 of the signed UBL. */
  invoiceBase64: string;
  /** The document UUID — ZATCA's own identifier for the invoice. */
  uuid: string;
  /** base64 invoice hash. */
  invoiceHash: string;
  /** OAuth 2.0 Basic: the PCSID certificate as client id, secret from onboarding. */
  credentials: { certificateBase64: string; secret: string };
}

/**
 * A raw, UNINTERPRETED response.
 *
 * Deliberately dumb: the client reports what happened at the HTTP level and
 * nothing more. Deciding what a response *means* is `errorMapping.ts`'s job, so
 * that the interpretation can be corrected from real observations without
 * touching transport.
 */
export interface ZatcaResponse {
  /** HTTP status, or null when no response was received at all. */
  httpStatus: number | null;
  body: unknown;
  /**
   * TRUE when the request failed in a way that leaves ZATCA's state UNKNOWN —
   * timeout, socket reset, DNS failure. The request MAY have been processed.
   * This is what drives the `ambiguous` flag and forbids a blind retry.
   */
  networkFailure: boolean;
  errorMessage: string | null;
}

export interface ZatcaHttpClient {
  send(request: ZatcaRequest): Promise<ZatcaResponse>;
}

/**
 * The real client — deliberately unimplemented until M12.4 establishes the
 * actual base URLs, headers and response shapes against the live sandbox.
 *
 * Guessing them from the PDF would repeat the mistake that produced thirteen
 * documented divergences, so this throws rather than shipping a plausible
 * fiction. The worker is fully exercised through an injected fake until then.
 */
export const unconfiguredZatcaClient: ZatcaHttpClient = {
  async send(): Promise<ZatcaResponse> {
    throw new Error(
      "The live ZATCA HTTP client is not implemented yet — it is defined in M12.4, " +
        "from real sandbox responses rather than from the specification. Inject a client " +
        "explicitly (the worker takes one) or leave ZATCA_WORKER_ENABLED off.",
    );
  },
};
