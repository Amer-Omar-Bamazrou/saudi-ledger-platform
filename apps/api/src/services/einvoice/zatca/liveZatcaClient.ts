/**
 * The live clearance / reporting transport (M12.8).
 *
 * ── Why this had to exist before "instantiate the worker" meant anything ────
 * M12.6 shipped `unconfiguredZatcaClient`, which THROWS, and deferred the real
 * one until base URLs and headers could be established from live responses
 * rather than guessed from the PDF. That was the right call — guessing is what
 * produced thirteen documented divergences. But it means an instantiated worker
 * would have failed every send and pushed every document to `needs_review`.
 * Wiring the outbox while leaving this throwing would have reproduced exactly
 * the "correct but not connected" defect M12.8 exists to close.
 *
 * M12.4 established the missing facts against the live sandbox: the base URL per
 * environment, `Accept-Version: V2`, and Basic auth built from the PCSID's
 * binary security token plus the CSID secret. This reuses `zatcaBaseUrl` and
 * `basicAuth` from the onboarding client rather than restating them.
 *
 * ── Deliberately dumb ───────────────────────────────────────────────────────
 * It reports what happened at the HTTP level and nothing more; `errorMapping.ts`
 * decides what a response MEANS. The one judgement made here is
 * `networkFailure`, because only the transport can distinguish "ZATCA said no"
 * from "we never learned what ZATCA did" — and that distinction is what forbids
 * a blind retry.
 */
import { basicAuth, zatcaBaseUrl } from "../onboarding/zatcaOnboardingClient";
import type { ZatcaEnvironment } from "@workspace/db";
import type { ZatcaHttpClient, ZatcaRequest, ZatcaResponse } from "./zatcaHttpClient";

/** Requests are abandoned after this; a hung socket must not stall the queue. */
const REQUEST_TIMEOUT_MS = 30_000;

export function createLiveZatcaClient(environment: ZatcaEnvironment): ZatcaHttpClient {
  return {
    async send(request: ZatcaRequest): Promise<ZatcaResponse> {
      if (request.endpoint === "status") {
        return {
          httpStatus: null,
          body: null,
          networkFailure: false,
          errorMessage:
            "The ZATCA status/reconciliation endpoint is not implemented; ambiguous documents " +
            "are queued for human review instead.",
        };
      }

      const path =
        request.endpoint === "clearance" ? "/invoices/clearance/single" : "/invoices/reporting/single";

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "application/json",
        "Accept-Version": "V2",
        "Accept-Language": "en",
        Authorization: basicAuth(request.credentials.certificateBase64, request.credentials.secret),
      };
      // Only the clearance endpoint takes this header. `1` asks ZATCA to clear
      // the document and return it stamped; the reporting endpoint rejects the
      // header outright, so it is not sent there.
      if (request.endpoint === "clearance") headers["Clearance-Status"] = "1";

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      try {
        const res = await fetch(`${zatcaBaseUrl(environment)}${path}`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            invoiceHash: request.invoiceHash,
            uuid: request.uuid,
            invoice: request.invoiceBase64,
          }),
          signal: controller.signal,
        });

        // A non-JSON body is still a real answer (an HTML error page from a
        // gateway, say) — surface the status rather than calling it a network
        // failure, because ZATCA's state is NOT unknown in that case.
        const body = await res.json().catch(() => null);
        return { httpStatus: res.status, body, networkFailure: false, errorMessage: null };
      } catch (err) {
        // 🔴 Timeout / abort / DNS / socket reset — the request MAY have been
        // processed. This is the ambiguous case: never retried blindly.
        return {
          httpStatus: null,
          body: null,
          networkFailure: true,
          errorMessage: err instanceof Error ? err.message : String(err),
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
