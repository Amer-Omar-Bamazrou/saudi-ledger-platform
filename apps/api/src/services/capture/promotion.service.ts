/**
 * Promotion and purge for captured documents (A1 part 2).
 *
 * ── Promotion: the outbox pattern, not a transaction ───────────────────────
 * When a capture is posted to a bill it becomes **evidence for an input-VAT
 * deduction**, so it moves from deletable staging into the immutable archive.
 *
 * Object storage is not transactional with Postgres, so "atomic with the bill
 * posting" cannot mean two-phase commit. It means what M12.6 already does for
 * ZATCA: **the intent commits inside the bill's transaction**
 * (`status = 'promotion_pending'`, `bill_id`, `retain_until`), and this job
 * moves the bytes afterwards, idempotently.
 *
 * The two wrong states are therefore impossible or visible:
 *   • *evidence for a bill that does not exist* — impossible: the link rolls
 *     back with the bill;
 *   • *a bill whose evidence never promoted* — visible as `promotion_pending`,
 *     retried here, and countable rather than silent.
 *
 * ── Purge: only what is evidence of nothing ────────────────────────────────
 * The purge job removes abandoned captures — `staged` past the window, or
 * explicitly `discarded`. It **never** touches `promotion_pending` or
 * `promoted`: those are evidence, and this job is not their business.
 */
import { loadEnv } from "@workspace/config";
import { logger } from "../../lib/logger";
import { capturedDocumentsJobRepository } from "../../repositories/capturedDocuments.repository";
import { archiveFileName } from "../einvoice/archive/archiveNaming";
import { stagingStore } from "./stagingStore";

export interface PromotionResult {
  pending: number;
  promoted: number;
  failed: number;
}

export interface PurgeResult {
  scanned: number;
  purged: number;
}

/** How long an untouched capture survives before it is treated as abandoned. */
const DEFAULT_PURGE_AFTER_DAYS = 30;

export const capturePromotionService = {
  async runOnce(organizationId?: string): Promise<PromotionResult> {
    const due = await capturedDocumentsJobRepository.listPendingPromotion(50, organizationId);
    const result: PromotionResult = { pending: due.length, promoted: 0, failed: 0 };

    for (const doc of due) {
      try {
        if (!doc.stagingPath) {
          // Already moved by an earlier pass that died after the copy; the row
          // just needs finishing. Idempotency, not an error.
          await capturedDocumentsJobRepository.markPromoted(doc.id, `${doc.organizationId}/${doc.companyId}/${doc.id}`);
          result.promoted += 1;
          continue;
        }

        // Named for the bill it evidences, under the same convention as
        // outbound archives so one naming rule covers the whole archive.
        const archivePath = `inbound/${doc.organizationId}/${doc.companyId}/${doc.capturedAt
          .toISOString()
          .slice(0, 4)}/${archiveFileName({
          sellerVatNumber: "BILL",
          generatedAt: doc.capturedAt,
          invoiceReference: `${doc.billId}-${doc.id}`,
        })}`;

        await stagingStore.promote(doc.stagingPath, archivePath, doc.contentType);
        await capturedDocumentsJobRepository.markPromoted(doc.id, archivePath);
        // Best-effort: the archive copy is authoritative from here.
        await stagingStore.remove(doc.stagingPath).catch(() => {});
        result.promoted += 1;
      } catch (err) {
        result.failed += 1;
        logger.error(
          { err, captureId: doc.id, billId: doc.billId },
          "captured document failed to promote — it stays pending and will be retried",
        );
      }
    }

    if (result.promoted > 0 || result.failed > 0) {
      logger.info(result, "captured document promotion pass complete");
    }
    return result;
  },

  /** Abandoned captures only. Never `promotion_pending` or `promoted`. */
  async purgeOnce(organizationId?: string): Promise<PurgeResult> {
    const env = loadEnv();
    const days = env.CAPTURE_PURGE_AFTER_DAYS ?? DEFAULT_PURGE_AFTER_DAYS;
    const rows = await capturedDocumentsJobRepository.listPurgeable(days, 100, organizationId);

    for (const row of rows) {
      if (row.stagingPath) await stagingStore.remove(row.stagingPath).catch(() => {});
    }
    const purged = await capturedDocumentsJobRepository.deleteRows(rows.map((r) => r.id));

    if (purged > 0) {
      logger.info({ purged, olderThanDays: days }, "purged abandoned captured documents");
    }
    return { scanned: rows.length, purged };
  },
};
