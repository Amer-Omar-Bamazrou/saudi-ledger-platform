/**
 * Documents repository (M11.4) — verification-document METADATA access.
 *
 * Identity/infrastructure layer, BASE (owner) connection, before `resolveTenant`.
 * Every query is explicitly scoped by `organizationId`; there is no RLS backstop,
 * so callers MUST authorize first (member of the org, or platform operator).
 */
// 🔴 The OWNER connection, named deliberately rather than inherited.
// `verification_documents` is an OWNER-ONLY table (it is not the tenant business
// document store — see ownerDb's own doc comment), and it is read from BOTH sides:
// a tenant uploading its own evidence, and a platform OPERATOR reviewing an
// application from outside any tenant scope. The operator path reached it through
// the proxy's silent fallback — RLS bypassed by accident rather than by decision.
// Every query here filters by organizationId explicitly, which is what makes the
// owner connection the right one to name.
import { ownerDb as db, verificationDocumentsTable } from "@workspace/db";
import { and, asc, eq } from "drizzle-orm";

const META = {
  id: verificationDocumentsTable.id,
  organizationId: verificationDocumentsTable.organizationId,
  type: verificationDocumentsTable.type,
  fileName: verificationDocumentsTable.fileName,
  mimeType: verificationDocumentsTable.mimeType,
  sizeBytes: verificationDocumentsTable.sizeBytes,
  uploadedByUserId: verificationDocumentsTable.uploadedByUserId,
  createdAt: verificationDocumentsTable.createdAt,
};

export const documentsRepository = {
  insert(values: typeof verificationDocumentsTable.$inferInsert) {
    return db.insert(verificationDocumentsTable).values(values).returning();
  },

  /** Metadata for all of an org's documents (no storage path — internal only). */
  listByOrg(orgId: string) {
    return db
      .select(META)
      .from(verificationDocumentsTable)
      .where(eq(verificationDocumentsTable.organizationId, orgId))
      .orderBy(asc(verificationDocumentsTable.createdAt));
  },

  /** A single document scoped to its org — full row incl. storage path (for download). */
  async findInOrg(docId: string, orgId: string) {
    const [row] = await db
      .select()
      .from(verificationDocumentsTable)
      .where(
        and(
          eq(verificationDocumentsTable.id, docId),
          eq(verificationDocumentsTable.organizationId, orgId),
        ),
      )
      .limit(1);
    return row;
  },
};
