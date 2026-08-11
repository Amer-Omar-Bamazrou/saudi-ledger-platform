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
import type { EInvoiceProvider } from "../provider";
import { logger } from "../../../lib/logger";

export interface WorkerOptions {
  /**
   * The e-invoice provider (S1, M12 close-out).
   *
   * 🔴 This used to be a `ZatcaHttpClient` plus a credential resolver, which
   * meant the worker **bypassed the `EInvoiceProvider` seam entirely** — the
   * seam that exists so a certified vendor can be swapped in per company. Taking
   * the provider instead is what makes that hedge real for submission, which is
   * most of what a vendor sells. The provider resolves its own credentials, as a
   * vendor would.
   */
  provider: EInvoiceProvider;
  batchSize?: number;
  /** Attempts before a document stops retrying and escalates to needs_review. */
  maxAttempts?: number;
  /** Reclaim rows stuck in `submitting` longer than this. */
  staleClaimSeconds?: number;
  /**
   * Restrict claiming to ONE organization. Omitted in production, where a worker
   * drains every tenant's queue — that is the whole point of a background worker.
   *
   * It exists because claiming is deliberately CROSS-TENANT and global, which
   * makes any two test suites that both touch `einvoice_documents` interfere:
   * one suite's worker will happily claim and submit another suite's documents.
   * That is not hypothetical — it broke three tests the moment M12.8 gave more
   * than one suite real documents to create. Scoping the test worker is the
   * honest fix; the alternative (asserting on partial counts) would weaken the
   * assertions to accommodate the harness.
   *
   * It is also the seam a future sharded/per-tenant worker would use.
   */
  organizationId?: string;
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
  private readonly opts: Required<Omit<WorkerOptions, "provider" | "organizationId">> &
    Pick<WorkerOptions, "provider" | "organizationId">;
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

    const batch = await einvoiceOutboxRepository.claimDue(this.id, this.opts.batchSize, this.opts.organizationId);
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

    // 🔴 ZATCA's own document UUID, which MUST match `cbc:UUID` inside the
    // signed XML. This previously sent `String(row.invoiceId)` — our internal
    // row id, which is not the document UUID and would have been rejected. The
    // mismatch is invisible to every offline check (the XML is valid, the hash
    // is correct, the signature verifies) and could only ever have surfaced on a
    // real submission — which has never happened. See m12-status.md §0.
    if (!row.zatcaUuid) {
      await einvoiceOutboxRepository.markFailed(row.id, {
        errors: [{ reason: "document has no ZATCA UUID; it cannot be submitted" }],
        zatcaStatus: null,
        ambiguous: false,
        retryInSeconds: null,
      });
      return;
    }

    const outcome = await this.opts.provider.submit(
      {
        xml: row.signedXml,
        invoiceHash: row.invoiceHash,
        qrCode: null,
        previousInvoiceHash: row.previousInvoiceHash ?? "",
        uuid: row.zatcaUuid,
        icv: 0,
      },
      row.flow,
      { companyId: row.companyId, uuid: row.zatcaUuid },
    );

    if (outcome.status === "cleared" || outcome.status === "reported") {
      await einvoiceOutboxRepository.markAccepted(row.id, {
        status: outcome.status,
        zatcaStatus: outcome.zatcaStatus,
        warnings: outcome.warnings,
        clearedXml: outcome.clearedXml,
      });
      return;
    }

    // An ambiguous failure never schedules a blind retry. `markFailed` routes it
    // to `needs_review`, where a HUMAN reconciles it — see the note on
    // `reclaimStale` about what "reconciliation" does and does not mean here.
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
