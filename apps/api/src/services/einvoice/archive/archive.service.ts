/**
 * The e-invoice archival sweep (M12.8).
 *
 * ── Why a sweep and not a call at the end of submission ─────────────────────
 * Archival could have been appended to `markAccepted`. It is a separate pass on
 * purpose: a storage outage must not turn a document ZATCA has ALREADY ACCEPTED
 * into a failed submission. Coupling them would mean the worker retries a
 * cleared invoice because a bucket was briefly unreachable — resubmitting a
 * document ZATCA already holds. The sweep is idempotent and self-healing, so
 * storage can be down for a day and the archive catches up.
 *
 * ── What gets archived ──────────────────────────────────────────────────────
 *   clearance (STANDARD/B2B)   → ZATCA's stamped `cleared_xml`, the legal document.
 *   reporting (SIMPLIFIED/B2C) → our `signed_xml`. ZATCA returns NO stamped
 *                                document for reporting, so this is not a
 *                                fallback, it is the artifact to retain.
 */
import { loadEnv } from "@workspace/config";
import { logger } from "../../../lib/logger";
import {
  einvoiceArchiveJobRepository,
  type ArchivableDocument,
} from "../../../repositories/einvoiceArchive.repository";
import { archiveFileName, archiveObjectPath } from "./archiveNaming";
import { ArchiveConflictError, type ArchiveStore } from "./archiveStore";
import { resolveArchiveStore } from "./resolveArchiveStore";

export interface SweepResult {
  scanned: number;
  archived: number;
  skipped: number;
  failed: number;
}

/** Add whole years without the 29-Feb surprise `setFullYear` alone can produce. */
function addYears(from: Date, years: number): Date {
  const d = new Date(from.getTime());
  const day = d.getUTCDate();
  d.setUTCFullYear(d.getUTCFullYear() + years);
  if (d.getUTCDate() !== day) d.setUTCDate(0); // 29 Feb → 28 Feb
  return d;
}

export const archiveService = {
  /**
   * Archive every accepted document that has no archive row yet.
   *
   * One failure never stops the pass: a document whose XML is missing, or whose
   * bytes cannot be stored, is logged and skipped so the rest still land.
   */
  async runOnce(store: ArchiveStore = resolveArchiveStore()): Promise<SweepResult> {
    const env = loadEnv();
    const due = await einvoiceArchiveJobRepository.listUnarchived();
    const result: SweepResult = { scanned: due.length, archived: 0, skipped: 0, failed: 0 };

    for (const doc of due) {
      try {
        const outcome = await archiveOne(doc, store, env.ZATCA_ARCHIVE_RETENTION_YEARS, env.ZATCA_ARCHIVE_BUCKET);
        if (outcome === "archived") result.archived += 1;
        else result.skipped += 1;
      } catch (err) {
        result.failed += 1;
        logger.error(
          { err, documentId: doc.documentId, invoiceId: doc.invoiceId },
          "e-invoice archive: failed to archive a document",
        );
      }
    }

    if (result.archived > 0 || result.failed > 0) {
      logger.info(result, "e-invoice archive sweep complete");
    }
    return result;
  },

  stats: () => einvoiceArchiveJobRepository.stats(),
};

async function archiveOne(
  doc: ArchivableDocument,
  store: ArchiveStore,
  retentionYears: number,
  bucket: string,
): Promise<"archived" | "skipped"> {
  const artifact: "cleared" | "signed" = doc.clearedXml ? "cleared" : "signed";
  const xml = doc.clearedXml ?? doc.signedXml;

  if (!xml) {
    // Accepted by ZATCA but carrying no XML at all — a data fault, not a
    // transient one. Skip loudly rather than retry forever.
    logger.error(
      { documentId: doc.documentId, invoiceId: doc.invoiceId },
      "e-invoice archive: accepted document has no XML to retain",
    );
    return "skipped";
  }

  // 🔴 The GENERATION instant, per ZATCA §5.5 — NOT the clearance time and NOT
  // now(). `issued_at` is the real issuance instant M12.1a added. Falling back
  // to now() would silently misname the archive, so a document without one is
  // refused instead.
  if (!doc.issuedAt) {
    logger.error(
      { documentId: doc.documentId, invoiceId: doc.invoiceId },
      "e-invoice archive: invoice has no issued_at; cannot build the ZATCA filename",
    );
    return "skipped";
  }

  if (!doc.sellerVatNumber) {
    logger.error(
      { documentId: doc.documentId, invoiceId: doc.invoiceId },
      "e-invoice archive: invoice has no seller VAT number; cannot build the ZATCA filename",
    );
    return "skipped";
  }

  const naming = {
    sellerVatNumber: doc.sellerVatNumber,
    generatedAt: doc.issuedAt,
    invoiceReference: doc.invoiceNumber,
  };
  const objectPath = archiveObjectPath(doc.organizationId, doc.companyId, naming);
  const bytes = Buffer.from(xml, "utf-8");

  let stored;
  try {
    stored = await store.put(objectPath, bytes, "application/xml");
  } catch (err) {
    // The bytes are already there from an earlier pass whose index insert did
    // not land. Recover by indexing what exists rather than failing forever.
    if (err instanceof ArchiveConflictError) {
      logger.warn({ objectPath }, "e-invoice archive: object already stored; indexing it");
      const existing = await store.get(objectPath);
      stored = {
        sha256: (await import("node:crypto")).createHash("sha256").update(existing.bytes).digest("hex"),
        byteSize: existing.bytes.byteLength,
      };
    } else {
      throw err;
    }
  }

  const inserted = await einvoiceArchiveJobRepository.insert({
    organizationId: doc.organizationId,
    companyId: doc.companyId,
    einvoiceDocumentId: doc.documentId,
    invoiceId: doc.invoiceId,
    artifact,
    fileName: archiveFileName(naming),
    objectPath,
    storageProvider: store.provider,
    storageBucket: store.provider === "supabase-storage" ? bucket : null,
    sha256: stored.sha256,
    byteSize: stored.byteSize,
    generatedAt: doc.issuedAt,
    retainUntil: addYears(doc.issuedAt, retentionYears),
  });

  return inserted ? "archived" : "skipped";
}
