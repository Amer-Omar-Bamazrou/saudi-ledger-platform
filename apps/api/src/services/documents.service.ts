/**
 * Documents service (M11.4) — upload / list / download of verification documents.
 *
 * Identity/infrastructure layer (called from /onboarding + /operator, base
 * connection, before resolveTenant). The file BYTES are brokered through the API
 * to a private Supabase Storage bucket; this service owns validation (magic-byte
 * sniff + size + filename sanitization), the org-prefixed object path, the
 * metadata row, and the audit trail. Callers MUST authorize first (the routes do:
 * member of the org for applicant endpoints, platform operator for the operator
 * endpoint).
 */
import { randomUUID } from "node:crypto";
import { DOCUMENT_TYPES, type DocumentType } from "@workspace/db";
import { BadRequestError, NotFoundError } from "../lib/errors";
import { storage } from "../lib/storage";
import { validateDocumentBytes, sanitizeFilename } from "../lib/fileValidation";
import { documentsRepository } from "../repositories/documents.repository";
import { securityAuditService } from "./securityAudit.service";

export interface UploadedFile {
  buffer: Buffer;
  originalName: string;
}

export interface DocActionContext {
  actorEmail?: string | null;
  ipAddress?: string | null;
}

export const documentsService = {
  /** Validate, store, and record a document for an organization. */
  async upload(userId: number, orgId: string, type: unknown, file: UploadedFile | undefined, ctx: DocActionContext = {}) {
    if (!file || !file.buffer) throw new BadRequestError("A file is required (field name: 'file').");
    if (!DOCUMENT_TYPES.includes(type as DocumentType)) {
      throw new BadRequestError(`type must be one of: ${DOCUMENT_TYPES.join(" | ")}.`);
    }

    // Trust the bytes, not the declared mime/extension.
    const mimeType = validateDocumentBytes(file.buffer);
    const fileName = sanitizeFilename(file.originalName, mimeType);

    const id = randomUUID();
    const storagePath = `${orgId}/${id}-${fileName}`;

    await storage.ensureBucket();
    await storage.putObject(storagePath, file.buffer, mimeType);

    let inserted;
    try {
      [inserted] = await documentsRepository.insert({
        id,
        organizationId: orgId,
        type: type as DocumentType,
        storagePath,
        fileName,
        mimeType,
        sizeBytes: file.buffer.length,
        uploadedByUserId: userId,
      });
    } catch (err) {
      // Roll back the stored object so we never orphan bytes without metadata.
      await storage.removeObject(storagePath);
      throw err;
    }

    await securityAuditService.record({
      action: "verification.document_uploaded",
      actorUserId: userId,
      actorEmail: ctx.actorEmail,
      organizationId: orgId,
      metadata: { documentId: id, type: inserted.type, fileName },
      ipAddress: ctx.ipAddress,
    });

    return this._meta(inserted);
  },

  /** Metadata for all of an org's documents. */
  async listForOrg(orgId: string) {
    return { documents: await documentsRepository.listByOrg(orgId) };
  },

  /** Fetch a document's bytes for download (authorization is the caller's job). */
  async download(orgId: string, docId: string) {
    const doc = await documentsRepository.findInOrg(docId, orgId);
    if (!doc) throw new NotFoundError("Document not found.");
    const { bytes } = await storage.getObject(doc.storagePath);
    return { bytes, fileName: doc.fileName, mimeType: doc.mimeType };
  },

  /** Operator download — same as download(), but AUDITED as cross-tenant access. */
  async operatorView(operatorUserId: number, orgId: string, docId: string, ctx: DocActionContext = {}) {
    const result = await this.download(orgId, docId);
    await securityAuditService.record({
      action: "verification.document_viewed",
      actorUserId: operatorUserId,
      actorEmail: ctx.actorEmail,
      organizationId: orgId,
      metadata: { documentId: docId, fileName: result.fileName },
      ipAddress: ctx.ipAddress,
    });
    return result;
  },

  _meta(doc: {
    id: string; organizationId: string; type: string; fileName: string;
    mimeType: string; sizeBytes: number; uploadedByUserId: number | null; createdAt: Date;
  }) {
    return {
      id: doc.id,
      organizationId: doc.organizationId,
      type: doc.type,
      fileName: doc.fileName,
      mimeType: doc.mimeType,
      sizeBytes: doc.sizeBytes,
      uploadedByUserId: doc.uploadedByUserId,
      createdAt: doc.createdAt,
    };
  },
};
