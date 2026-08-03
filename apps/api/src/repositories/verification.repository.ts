/**
 * Verification repository (M11.3) — data access for the operator review surface.
 *
 * Identity/infrastructure layer, BASE (owner) connection, before `resolveTenant`.
 * Reads/writes ONLY verification metadata (organization verification fields, the
 * applicant company's CR/VAT, and the review history) — never a tenant's
 * financial data.
 */
import {
  db,
  organizationsTable,
  companiesTable,
  verificationReviewsTable,
} from "@workspace/db";
import { asc, desc, eq, ne } from "drizzle-orm";

export interface VerificationUpdate {
  verificationStatus: string;
  verificationReason: string | null;
  verificationReviewedBy: number;
  verificationReviewedAt: Date;
}

export const verificationRepository = {
  /** Organizations whose application still needs (or has had) operator attention. */
  listApplications() {
    return db
      .select({
        organizationId: organizationsTable.id,
        name: organizationsTable.name,
        slug: organizationsTable.slug,
        status: organizationsTable.verificationStatus,
        reason: organizationsTable.verificationReason,
        reviewedBy: organizationsTable.verificationReviewedBy,
        reviewedAt: organizationsTable.verificationReviewedAt,
        submittedAt: organizationsTable.verificationSubmittedAt,
        createdAt: organizationsTable.createdAt,
      })
      .from(organizationsTable)
      .where(ne(organizationsTable.verificationStatus, "approved"))
      .orderBy(asc(organizationsTable.createdAt));
  },

  /** One organization's verification header (or undefined). */
  async findOrganization(orgId: string) {
    const [org] = await db
      .select({
        organizationId: organizationsTable.id,
        name: organizationsTable.name,
        slug: organizationsTable.slug,
        status: organizationsTable.verificationStatus,
        reason: organizationsTable.verificationReason,
        reviewedBy: organizationsTable.verificationReviewedBy,
        reviewedAt: organizationsTable.verificationReviewedAt,
        submittedAt: organizationsTable.verificationSubmittedAt,
        createdAt: organizationsTable.createdAt,
      })
      .from(organizationsTable)
      .where(eq(organizationsTable.id, orgId))
      .limit(1);
    return org;
  },

  /** The applicant's companies (name + CR/VAT) — the registration identity. */
  listCompanies(orgId: string) {
    return db
      .select({
        id: companiesTable.id,
        name: companiesTable.name,
        crNumber: companiesTable.crNumber,
        vatNumber: companiesTable.vatNumber,
      })
      .from(companiesTable)
      .where(eq(companiesTable.organizationId, orgId))
      .orderBy(asc(companiesTable.createdAt));
  },

  /** Apply a status decision to the organization. */
  updateVerification(orgId: string, values: VerificationUpdate) {
    return db
      .update(organizationsTable)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(organizationsTable.id, orgId))
      .returning({
        organizationId: organizationsTable.id,
        status: organizationsTable.verificationStatus,
        reason: organizationsTable.verificationReason,
      });
  },

  /** Append a review-history row. */
  insertReview(values: {
    organizationId: string;
    operatorUserId: number;
    fromStatus: string;
    toStatus: string;
    reason: string | null;
  }) {
    return db.insert(verificationReviewsTable).values(values).returning();
  },

  /** An organization's review history, newest first. */
  listReviews(orgId: string) {
    return db
      .select()
      .from(verificationReviewsTable)
      .where(eq(verificationReviewsTable.organizationId, orgId))
      .orderBy(desc(verificationReviewsTable.createdAt));
  },
};
