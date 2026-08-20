/**
 * Document capture (A1 part 2) — stage, verify, and later promote.
 *
 * Closes the audit gap part 1 left open. Before this, extraction lived in
 * `sessionStorage`: a refresh lost it, no image was retained, and a posted bill
 * could not be traced back to the photograph it came from. Nothing recorded
 * whether a figure had been decoded, read by OCR, or typed — which is the
 * question a disputed VAT figure actually raises.
 */
import { loadEnv } from "@workspace/config";
import { randomUUID } from "node:crypto";
import { BadRequestError, NotFoundError } from "../../lib/errors";
import { logger } from "../../lib/logger";
import { auditService } from "../audit.service";
import { sanitizeFilename, validateDocumentBytes } from "../../lib/fileValidation";
import { assertFileIsClean } from "../../lib/malwareScanner";
import { capturedDocumentsRepository } from "../../repositories/capturedDocuments.repository";
import { sha256Hex, verifyQrSignature } from "./signatureVerification";
import { stagingStore } from "./stagingStore";

export interface CaptureInput {
  bytes: Buffer;
  fileName: string;
  /** `qr` when a ZATCA QR was decoded client-side, `ocr` otherwise. */
  source: "qr" | "ocr" | "manual";
  /** Raw TLV payload, when a QR was read. Verified HERE, never client-side. */
  qrPayload?: string;
  /** The extraction as captured, before any human edit. */
  extraction?: unknown;
  /** Per-field provenance, so an edited field stops claiming to be decoded. */
  fieldSources?: Record<string, string>;
}

export interface CaptureResult {
  captureId: string;
  signatureStatus: string | null;
  signatureDetail: string | null;
  /** 🔴 True when the document's signature did NOT verify — surface prominently. */
  signatureFailed: boolean;
}

export const captureService = {
  /**
   * Stage a captured document.
   *
   * Bytes go to **deletable staging**, not the immutable archive: at this point
   * the document is a photograph, not evidence. It becomes evidence — and
   * immutable — only when posted to a bill. See the schema note on
   * `captured_documents` for why inbound cannot inherit `ArchiveStore`'s
   * no-delete guarantee wholesale.
   */
  async capture(
    input: CaptureInput,
    ctx: { organizationId: string; companyId: string; userId: number | null },
  ): Promise<CaptureResult> {
    // Same magic-byte sniff M11.4 uses: the declared mime and the extension are
    // both spoofable, the bytes are not. Reused rather than reimplemented — a
    // second file-validation path would be a second place to get it wrong.
    const mimeType = validateDocumentBytes(input.bytes);
    const validated = { mimeType, fileName: sanitizeFilename(input.fileName, mimeType) };

    // C4 — the same scan gate as the verification-document path, for the same
    // reason it shares the sniff: a second file-handling path is a second place
    // to get it wrong. Phone captures are the HIGHER-volume untrusted input.
    await assertFileIsClean(input.bytes, { kind: "captured_document" });

    const id = randomUUID();
    const stagingPath = `${ctx.organizationId}/${ctx.companyId}/${id}-${validated.fileName}`;

    // 🔴 SERVER-SIDE signature verification. A client-side "verified" badge can
    // be faked, and the claim is about whether the customer's input-VAT
    // deduction survives ZATCA — i.e. about their money.
    const verdict = input.qrPayload
      ? verifyQrSignature(input.qrPayload)
      : { status: null as string | null, detail: null as string | null };

    await stagingStore.put(stagingPath, input.bytes, validated.mimeType);

    let row;
    try {
      row = await capturedDocumentsRepository.insert({
        id,
        organizationId: ctx.organizationId,
        companyId: ctx.companyId,
        status: "staged",
        stagingPath,
        contentType: validated.mimeType,
        byteSize: input.bytes.byteLength,
        sha256: sha256Hex(input.bytes),
        source: input.source,
        fieldSources: input.fieldSources ?? null,
        extraction: (input.extraction as never) ?? null,
        qrPayload: input.qrPayload ?? null,
        signatureStatus: verdict.status,
        signatureDetail: verdict.detail,
        capturedBy: ctx.userId,
      });
    } catch (err) {
      // Never orphan bytes without metadata — the same rollback M11.4 does.
      await stagingStore.remove(stagingPath).catch(() => {});
      throw err;
    }

    await auditService.created("captured_document", row.id, {
      source: input.source,
      signatureStatus: verdict.status,
      byteSize: input.bytes.byteLength,
    });

    if (verdict.status === "failed") {
      // Loud in the log as well as in the UI: a supplier issuing documents whose
      // signatures do not verify is worth noticing across tenants, not only by
      // the one person looking at this receipt.
      logger.warn(
        { captureId: row.id, organizationId: ctx.organizationId },
        "🔴 captured document FAILED ZATCA signature verification",
      );
    }

    return {
      captureId: row.id,
      signatureStatus: verdict.status,
      signatureDetail: verdict.detail,
      signatureFailed: verdict.status === "failed",
    };
  },

  /** Load a staged capture — the review page resumes from this, not sessionStorage. */
  async get(captureId: string) {
    const row = await capturedDocumentsRepository.findById(captureId);
    if (!row) throw new NotFoundError("Captured document not found");
    return {
      id: row.id,
      status: row.status,
      source: row.source,
      extraction: row.extraction,
      fieldSources: row.fieldSources,
      signatureStatus: row.signatureStatus,
      signatureDetail: row.signatureDetail,
      signatureFailed: row.signatureStatus === "failed",
      contentType: row.contentType,
      capturedAt: row.capturedAt,
      billId: row.billId,
    };
  },

  /** The stored image, for the review page and for a posted bill's audit trail. */
  async image(captureId: string): Promise<{ bytes: Buffer; contentType: string; fileName: string }> {
    const row = await capturedDocumentsRepository.findById(captureId);
    if (!row) throw new NotFoundError("Captured document not found");
    // 🔴 By STATUS, not by which column happens to be set (B3). This used to be
    // `stagingPath ?? archivePath`, which was only ever correct because
    // `markPromoted` nulled the staging path in the same statement. It no
    // longer does — a promoted row keeps the pointer until the staged copy is
    // confirmed deleted — so preferring `stagingPath` would now read a promoted
    // capture from the wrong prefix. An implicit coupling between two modules,
    // removed rather than re-established.
    const path = row.status === "promoted" ? row.archivePath : row.stagingPath;
    if (!path) throw new NotFoundError("This capture has no stored document");
    const { bytes } = await stagingStore.get(path, row.status);
    return { bytes, contentType: row.contentType, fileName: `capture-${row.id}` };
  },

  /**
   * 🔴 Link a capture to the bill it became — CALL INSIDE THE BILL'S TRANSACTION.
   *
   * Only the INTENT commits here; the bytes move afterwards via the promotion
   * job. Object storage is not transactional with Postgres, so this is the
   * M12.6 outbox pattern rather than a two-phase commit — and it makes both
   * wrong states impossible or visible:
   *
   *   • *evidence for a bill that does not exist* — impossible: this rolls back
   *     with the bill;
   *   • *a bill whose evidence never promoted* — visible as `promotion_pending`
   *     and retried, rather than silently lost.
   */
  async attachToBill(captureId: string, billId: number): Promise<void> {
    const env = loadEnv();
    const retainUntil = new Date();
    // Conservative default (queue C7). A supplier invoice is the evidence for
    // an input-VAT deduction; not retaining and being wrong means the evidence
    // is gone exactly when ZATCA asks for it. NOT a settled reading — C7 and C8
    // must be answered together.
    retainUntil.setUTCFullYear(retainUntil.getUTCFullYear() + env.ZATCA_ARCHIVE_RETENTION_YEARS);

    const row = await capturedDocumentsRepository.markForPromotion(captureId, billId, retainUntil);
    if (!row) {
      throw new BadRequestError(
        "That captured document is not available to attach — it may already be attached to a bill, or discarded.",
      );
    }
  },

  /**
   * Discard a capture AND delete its image now (B3).
   *
   * 🔴 The status flip comes first and is never rolled back: it is the user's
   * INSTRUCTION, and losing it would leave a capture they meant to abandon
   * still attachable to a bill. The bytes go immediately after — waiting up to
   * thirty days for the purge job is not what "discard" means to the person who
   * just realised their ID card was in frame.
   *
   * If the backend cannot delete, the staging pointer is KEPT so the object
   * stays findable and the purge job retries it, and the caller is told
   * `imageDeleted: false`. Reporting a deletion that did not happen is exactly
   * the defect this endpoint was half of.
   */
  async discard(captureId: string): Promise<{ status: string; imageDeleted: boolean }> {
    const row = await capturedDocumentsRepository.discard(captureId);
    if (!row) throw new BadRequestError("That capture cannot be discarded.");

    let imageDeleted = true;
    if (row.stagingPath) {
      try {
        await stagingStore.remove(row.stagingPath);
        await capturedDocumentsRepository.clearStagingPath(captureId);
      } catch (err) {
        imageDeleted = false;
        logger.error(
          { err, captureId },
          "capture discarded but its image could NOT be deleted — the row is kept so the purge job retries it",
        );
      }
    }

    await auditService.deleted("captured_document", captureId, {
      status: "discarded",
      imageDeleted,
    });
    return { status: "discarded", imageDeleted };
  },
};
