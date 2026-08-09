/**
 * Interpreting ZATCA responses (M12.6).
 *
 * ── 🔴 THE MAPPING TABLE IS DELIBERATELY EMPTY ──────────────────────────────
 * There is no list of ZATCA error codes here, and that is not an oversight.
 * The only available source is the specification PDF — the same source that has
 * been wrong THIRTEEN times (see
 * `docs/zatca/spec-vs-implementation-divergences.md`). Populating this from it
 * would encode guesses in the place where a wrong guess is most expensive:
 *
 *   A retryable error misclassified as TERMINAL strands a legally valid invoice
 *   that would have succeeded on the next attempt — the tenant cannot invoice.
 *
 *   A terminal error misclassified as RETRYABLE hammers a government API
 *   forever with a document that can never be accepted, burning quota and
 *   hiding the real problem behind an endless backoff.
 *
 * So the table gets populated from REAL RESPONSES observed in M12.4/M12.7, and
 * recorded with the same evidence discipline as every other ZATCA behaviour.
 *
 * ── Until then: fail SAFE, not smart ────────────────────────────────────────
 * Anything not a definitive acceptance is `failed` (retryable, with backoff),
 * escalating to `needs_review` when attempts are exhausted. Nothing is ever
 * guessed into `rejected`, because `rejected` is terminal and unrecoverable
 * without human action.
 */
import type { ZatcaResponse } from "./zatcaHttpClient";

export type SubmissionStatus =
  | "cleared"
  | "reported"
  | "rejected"
  | "failed"
  | "needs_review";

export interface ZatcaOutcome {
  status: SubmissionStatus;
  /** ZATCA's own status string, verbatim, for the audit trail. */
  zatcaStatus: string | null;
  warnings: unknown[] | null;
  errors: unknown[] | null;
  /** Actionable, tenant-facing. Null when there is nothing useful to say yet. */
  userMessage: string | null;
  /** ZATCA's stamped XML — clearance only. */
  clearedXml: string | null;
  /** ZATCA's state is UNKNOWN; reconcile by asking, never by blind retry. */
  ambiguous: boolean;
}

/**
 * Interpret a response.
 *
 * @param flow which endpoint was called — decides `cleared` vs `reported`.
 */
export function mapZatcaResponse(response: ZatcaResponse, flow: "clearance" | "reporting"): ZatcaOutcome {
  // ── No response at all: ZATCA's state is UNKNOWN ────────────────────────
  // The request may have been fully processed. Marked ambiguous so the
  // reconciliation path ASKS rather than resubmitting.
  if (response.networkFailure || response.httpStatus === null) {
    return {
      status: "failed",
      zatcaStatus: null,
      warnings: null,
      errors: response.errorMessage ? [response.errorMessage] : null,
      userMessage: "Could not reach ZATCA. The invoice will be retried automatically.",
      clearedXml: null,
      ambiguous: true,
    };
  }

  // ── Definitive acceptance — the ONLY path to a terminal success ─────────
  // 200 alone is not enough: the body must also not be a rejection. Until real
  // response shapes are known (M12.4) we recognise only an unambiguous 2xx and
  // treat everything else conservatively.
  if (response.httpStatus >= 200 && response.httpStatus < 300) {
    const body = (response.body ?? {}) as Record<string, unknown>;
    return {
      status: flow === "clearance" ? "cleared" : "reported",
      zatcaStatus: typeof body["status"] === "string" ? (body["status"] as string) : null,
      warnings: Array.isArray(body["warnings"]) ? (body["warnings"] as unknown[]) : null,
      errors: null,
      userMessage: null,
      clearedXml: typeof body["clearedInvoice"] === "string" ? (body["clearedInvoice"] as string) : null,
      ambiguous: false,
    };
  }

  // ── Everything else: RETRYABLE, never guessed into `rejected` ───────────
  // A 4xx very likely IS a permanent rejection, and once M12.4 tells us which
  // codes mean what, most of these will map to `rejected` directly. But
  // asserting that now would be inferring ZATCA's semantics from the PDF, and
  // the cost of being wrong is a tenant unable to invoice. Backoff plus
  // escalation to `needs_review` gets a human to look, which is the correct
  // behaviour under genuine uncertainty.
  const body = (response.body ?? {}) as Record<string, unknown>;
  return {
    status: "failed",
    zatcaStatus: typeof body["status"] === "string" ? (body["status"] as string) : null,
    warnings: Array.isArray(body["warnings"]) ? (body["warnings"] as unknown[]) : null,
    errors: Array.isArray(body["errors"])
      ? (body["errors"] as unknown[])
      : [{ httpStatus: response.httpStatus, body: response.body }],
    userMessage:
      `ZATCA returned an error (HTTP ${response.httpStatus}). The invoice will be retried, ` +
      "and flagged for review if it keeps failing.",
    clearedXml: null,
    // A response WAS received, so ZATCA's state is known — not ambiguous.
    ambiguous: false,
  };
}
