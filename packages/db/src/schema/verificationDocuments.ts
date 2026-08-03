import { pgTable, uuid, varchar, integer, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./organizations";
import { usersTable } from "./users";

/**
 * Verification documents (M11.4) — metadata for the registration documents an
 * applicant uploads (CR certificate, VAT certificate, other supporting files).
 *
 * The FILE BYTES live in a private Supabase Storage bucket (org-prefixed object
 * paths); this table holds only metadata + the storage path. All document I/O is
 * BROKERED through the API (the service-role key stays server-side, and OUR
 * authorization layer — not Storage's own RLS — decides who may read a document:
 * that org's members and platform operators only).
 *
 * Owner-only table (identity/infrastructure layer, base connection): written/read
 * by the /onboarding + /operator surfaces before `resolveTenant`. No RLS, no
 * app-role grants — off the tenant-scoped path.
 */
export const DOCUMENT_TYPES = ["cr_certificate", "vat_certificate", "other"] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const verificationDocumentsTable = pgTable(
  "verification_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizationsTable.id),
    type: varchar("type", { length: 30 }).notNull(),
    storagePath: varchar("storage_path", { length: 512 }).notNull(),
    fileName: varchar("file_name", { length: 255 }).notNull(),
    mimeType: varchar("mime_type", { length: 100 }).notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    uploadedByUserId: integer("uploaded_by_user_id").references(() => usersTable.id),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("verification_documents_org_idx").on(t.organizationId)],
);

export const insertVerificationDocumentSchema = createInsertSchema(verificationDocumentsTable).omit({
  id: true,
  createdAt: true,
});

export type InsertVerificationDocument = typeof verificationDocumentsTable.$inferInsert;
export type VerificationDocument = typeof verificationDocumentsTable.$inferSelect;
