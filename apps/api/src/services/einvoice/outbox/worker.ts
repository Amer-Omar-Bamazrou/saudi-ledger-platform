/**
 * The e-invoice submission worker (M12.6).
 *
 * ── Why submission cannot happen in the request ─────────────────────────────
 * `resolveTenant` holds a Postgres transaction for the whole request with
 * `idle_in_transaction_session_timeout='15s'`. A synchronous call to a
 * government API cannot live inside it.
 *
 * But the timeout is the lesser reason. The real one: if the request
 * transaction rolled back AFTER ZATCA accepted the invoice, the ledger would
 * have no record of a document ZATCA considers issued — **a permanently
 * consumed ICV with no invoice behind it, and a gap in a legally-required
 * sequence that cannot be repaired.** The outbox makes that impossible by
 * committing the queue row in the same transaction as the ledger effect.
 *
 * ── What is proven without ZATCA ────────────────────────────────────────────
 * Everything here is exercised through an injected {@link ZatcaHttpClient}, so
 * claiming, backoff, state transitions, idempotency and reconciliation are all
 * verifiable offline. **That proves the TRANSPORT, not that ZATCA accepts our
 * documents** — which is M12.4/M12.7 against the live API.
 */
import { randomUUID } from "crypto";
import { einvoiceOutboxRepository, type OutboxRow } from "../../../repositories/einvoiceOutbox.repository";
import { mapZatcaResponse } from "../zatca/errorMapping";
import type { ZatcaHttpClient } from "../zatca/zatcaHttpClient";
import { logger } from "../../../lib/logger";

export interface WorkerOptions {
  client: ZatcaHttpClient;
  /** Credentials come from the M12.5 vault; injected until it exists. */
  resolveCredentials: (companyId: string) => Promise<{ certificateBase64: string; secret: string } | null>;
  batchSize?: number;
  /** Attempts before a document stops retrying and escalates to needs_review. */
  maxAttempts?: number;
  /** Reclaim rows stuck in `submitting` longer than this. */
  staleClaimSeconds?: number;
}

const DEFAULTS = { batchSize: 10, maxAttempts: 5, staleClaimSeconds: 300 };

/**
 * Exponential backoff, capped.
 *
 * Attempt 1 → 30s, 2 → 60s, 3 → 120s, 4 → 240s, 5 → 480s. Returns `null` when
 * attempts are exhausted, which the repository turns into `needs_review` rather
 * than an endless retry against a government API.
 */
export function backoffSeconds(attempt: number, maxAttempts: number): number | null {
  if (attempt >= maxAttempts) return null;
  return Math.min(30 * 2 ** (attempt - 1), 3600);
}

export class EInvoiceWorker {
  private readonly id = `worker-${randomUUID().slice(0, 8)}`;
  private readonly opts: Required<Omit<WorkerOptions, "client" | "resolveCredentials">> &
    Pick<WorkerOptions, "client" | "resolveCredentials">;
  private running = false;

  constructor(options: WorkerOptions) {
    this.opts = { ...DEFAULTS, ...options };
  }

  /**
   * Process one batch. Returns how many documents were handled.
   *
   * Exposed separately from the polling loop so tests drive it deterministically
   * rather than racing a timer.
   */
  async runOnce(): Promise<number> {
    // Return abandoned rows to the queue FIRST — flagged ambiguous, so they go
    // through reconciliation rather than being resubmitted blindly.
    const reclaimed = await einvoiceOutboxRepository.reclaimStale(this.opts.staleClaimSeconds);
    if (reclaimed > 0) {
      logger.warn({ reclaimed }, "e-invoice outbox: reclaimed stale claims (flagged for reconciliation)");
    }

    const batch = await einvoiceOutboxRepository.claimDue(this.id, this.opts.batchSize);
    for (const row of batch) {
      await this.submitOne(row);
    }
    return batch.length;
  }

  private async submitOne(row: OutboxRow): Promise<void> {
    // The worker NEVER mints a uuid, icv, hash or signature — it only reads what
    // approval already committed. That is what makes a retry byte-identical and
    // therefore safe: nothing here can produce a second document for one invoice.
    if (!row.signedXml || !row.invoiceHash) {
      await einvoiceOutboxRepository.markFailed(row.id, {
        errors: [{ reason: "document has no signed XML or hash; it was never signed" }],
        zatcaStatus: null,
        ambiguous: false,
        retryInSeconds: null, // unrecoverable without re-issuing — needs a human
      });
      return;
    }

    const credentials = await this.opts.resolveCredentials(row.companyId);
    if (!credentials) {
      // Not the document's fault: the company is not onboarded yet. Retry rather
      // than reject, since onboarding may complete at any time.
      await einvoiceOutboxRepository.markFailed(row.id, {
        errors: [{ reason: "no ZATCA credentials for this company; is it onboarded?" }],
        zatcaStatus: null,
        ambiguous: false,
        retryInSeconds: backoffSeconds(row.attemptCount, this.opts.maxAttempts),
      });
      return;
    }

    const response = await this.opts.client.send({
      endpoint: row.flow,
      invoiceBase64: Buffer.from(row.signedXml, "utf-8").toString("base64"),
      uuid: String(row.invoiceId),
      invoiceHash: row.invoiceHash,
      credentials,
    });

    const outcome = mapZatcaResponse(response, row.flow);

    if (outcome.status === "cleared" || outcome.status === "reported") {
      await einvoiceOutboxRepository.markAccepted(row.id, {
        status: outcome.status,
        zatcaStatus: outcome.zatcaStatus,
        warnings: outcome.warnings,
        clearedXml: outcome.clearedXml,
      });
      return;
    }

    // An ambiguous failure never schedules a blind retry: `markFailed` routes it
    // to needs_review so it is reconciled by ASKING ZATCA what happened.
    await einvoiceOutboxRepository.markFailed(row.id, {
      errors: outcome.errors,
      zatcaStatus: outcome.zatcaStatus,
      ambiguous: outcome.ambiguous,
      retryInSeconds: outcome.ambiguous ? null : backoffSeconds(row.attemptCount, this.opts.maxAttempts),
    });
  }

  /** Poll until {@link stop} is called. Off by default; see `ZATCA_WORKER_ENABLED`. */
  async start(intervalMs = 15_000): Promise<void> {
    if (this.running) return;
    this.running = true;
    logger.info({ workerId: this.id }, "e-invoice outbox worker started");
    while (this.running) {
      try {
        await this.runOnce();
      } catch (err) {
        // A worker must never die on one bad batch.
        logger.error({ err }, "e-invoice outbox worker batch failed");
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  stop(): void {
    this.running = false;
  }
}
