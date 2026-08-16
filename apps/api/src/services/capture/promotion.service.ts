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
  /** Promoted, but the staged duplicate survived — a backlog, not a failure. */
  stagedCopyRetained: number;
  /** Leftovers from earlier passes cleaned up this run. */
  leftoversCleared: number;
}

export interface PurgeResult {
  scanned: number;
  purged: number;
  /**
   * Rows KEPT because their bytes could not be deleted.
   *
   * 🔴 This number is the whole point of B3's fix. It used to be structurally
   * impossible for it to be anything but zero: the row was deleted whatever
   * happened to the bytes, so a failed purge looked exactly like a successful
   * one and the orphans became unfindable.
   */
  retained: number;
}

/** How long an untouched capture survives before it is treated as abandoned. */
const DEFAULT_PURGE_AFTER_DAYS = 30;

export const capturePromotionService = {
  async runOnce(organizationId?: string): Promise<PromotionResult> {
    const due = await capturedDocumentsJobRepository.listPendingPromotion(50, organizationId);
    const result: PromotionResult = {
      pending: due.length,
      promoted: 0,
      failed: 0,
      stagedCopyRetained: 0,
      leftoversCleared: 0,
    };

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
        // 🔴 markPromoted no longer nulls `staging_path` (B3). The archive copy
        // is authoritative from here, so the staged duplicate is not needed —
        // but until it is CONFIRMED gone, the pointer to it is the only way to
        // find it again. Clearing the pointer first is what used to orphan
        // bytes with no index, on exactly the backend that could not delete.
        await capturedDocumentsJobRepository.markPromoted(doc.id, archivePath);
        result.promoted += 1;

        try {
          await stagingStore.remove(doc.stagingPath);
          await capturedDocumentsJobRepository.clearStagingPath(doc.id);
        } catch (err) {
          // NOT a promotion failure — the evidence is safely archived. It is a
          // deletion backlog, retried by `sweepStagedLeftovers` and visible in
          // the meantime as a promoted row that still carries a staging path.
          result.stagedCopyRetained += 1;
          logger.warn(
            { err, captureId: doc.id },
            "promoted, but the staged copy could not be deleted — it stays enumerable and will be retried",
          );
        }
      } catch (err) {
        result.failed += 1;
        logger.error(
          { err, captureId: doc.id, billId: doc.billId },
          "captured document failed to promote — it stays pending and will be retried",
        );
      }
    }

    // Retry anything an earlier pass promoted but could not un-stage. Runs on
    // every pass so the backlog drains by itself once the backend can delete
    // again — a leftover list nothing sweeps is the same disease one step on.
    const swept = await this.sweepStagedLeftovers();
    result.leftoversCleared = swept.cleared;

    if (result.promoted > 0 || result.failed > 0 || swept.scanned > 0) {
      logger.info(result, "captured document promotion pass complete");
    }
    return result;
  },

  /**
   * Abandoned captures only. Never `promotion_pending` or `promoted`.
   *
   * 🔴 BYTES FIRST, ROW SECOND — and the row is kept if the bytes survive (B3).
   *
   * The previous order deleted every row regardless of what happened to the
   * objects, on top of a `remove` that reported success without doing anything
   * on cloud storage. The result was orphaned photographs plus the destruction
   * of the only record of them: nothing to enumerate, nothing to retry, no way
   * to say what had been left behind.
   *
   * The invariant is the one `capture.service.stage` already states for the
   * opposite direction — *never orphan bytes without metadata*. A purge that
   * drops the metadata first breaks it just as thoroughly as a failed insert
   * would, and is harder to notice because it looks like success.
   */
  async purgeOnce(organizationId?: string): Promise<PurgeResult> {
    const env = loadEnv();
    const days = env.CAPTURE_PURGE_AFTER_DAYS ?? DEFAULT_PURGE_AFTER_DAYS;
    const rows = await capturedDocumentsJobRepository.listPurgeable(days, 100, organizationId);

    const deletable: string[] = [];
    const retained: { id: string; err: unknown }[] = [];

    for (const row of rows) {
      if (!row.stagingPath) {
        // No bytes to lose — the row is safe to drop.
        deletable.push(row.id);
        continue;
      }
      try {
        await stagingStore.remove(row.stagingPath);
        deletable.push(row.id);
      } catch (err) {
        retained.push({ id: row.id, err });
      }
    }

    const purged = await capturedDocumentsJobRepository.deleteRows(deletable);

    if (purged > 0) {
      logger.info({ purged, olderThanDays: days }, "purged abandoned captured documents");
    }
    if (retained.length > 0) {
      // Loud, and re-attempted on the next pass because the rows are still
      // purgeable. A user who pressed "discard" was told the capture was
      // discarded; if the bytes are still there, that is worth shouting about.
      logger.error(
        { retained: retained.length, captureIds: retained.map((r) => r.id), err: retained[0]?.err },
        "captures could NOT be purged — their bytes are still in storage, so their rows were KEPT",
      );
    }
    return { scanned: rows.length, purged, retained: retained.length };
  },

  /**
   * Retry staged duplicates left behind by an earlier promotion.
   *
   * Separate from `purgeOnce` because these rows are evidence — the archive
   * copy is authoritative and must never be touched. Only the redundant staged
   * copy is deleted, and only its pointer is cleared.
   */
  async sweepStagedLeftovers(): Promise<{ scanned: number; cleared: number }> {
    const rows = await capturedDocumentsJobRepository.listPromotedWithStagedCopy(100);
    let cleared = 0;
    for (const row of rows) {
      try {
        await stagingStore.remove(row.stagingPath);
        await capturedDocumentsJobRepository.clearStagingPath(row.id);
        cleared += 1;
      } catch {
        // Stays enumerable; retried next pass. Already logged when it happened.
      }
    }
    if (rows.length > 0) {
      logger.info({ scanned: rows.length, cleared }, "staged-copy leftover sweep complete");
    }
    return { scanned: rows.length, cleared };
  },
};
