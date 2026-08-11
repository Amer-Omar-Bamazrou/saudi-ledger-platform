import { pgTable, text, timestamp, integer, uuid, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { organizationsTable } from "./organizations";
import { companiesTable } from "./companies";
import { invoicesTable } from "./invoices";
import { einvoiceDocumentsTable } from "./einvoiceDocuments";

/**
 * The e-invoice ARCHIVE index (M12.8) — one row per retained XML artifact.
 *
 * ── What lives here vs in the storage backend ───────────────────────────────
 * The bytes live in an {@link ArchiveStore} (Supabase Storage, or a filesystem
 * for on-premises deployment — the backend is deliberately swappable because
 * the hosting region is still an open decision). This table is the INDEX: where
 * the object is, what it hashes to, the ZATCA-convention filename, and when it
 * may be disposed of. Keeping the index in Postgres means retention and
 * accessibility are queryable without listing a bucket.
 *
 * ── 🔴 APPEND-ONLY, ENFORCED IN THE DATABASE ────────────────────────────────
 * ZATCA §5.5: "Once invoices are generated, they should not be deleted or
 * altered by any user", and the solution must protect them "from any alteration
 * or undetected deletion". That is a property of the archive, not a duration.
 *
 * So this table follows the discipline already proven on `audit_logs` (M7) and
 * `security_audit_logs` (M11.1): the migration GRANTs only SELECT + INSERT to
 * the app role and REVOKEs UPDATE, DELETE — and, unlike those two, also
 * TRUNCATE/REFERENCES/TRIGGER, which Supabase's base `ALTER DEFAULT PRIVILEGES`
 * hands out on every new table. TRUNCATE is not subject to row-level security,
 * so without that REVOKE one statement could erase every tenant's archive index
 * regardless of RLS. A DB boundary test pins all of it.
 *
 * ── Tenant-scoped, like `einvoice_documents` ────────────────────────────────
 * The tenant is legally required to retain and produce their own invoices, so
 * they must be able to read this. RLS + app-role SELECT/INSERT, not owner-only.
 *
 * The FK to `einvoice_documents` is deliberately NOT `ON DELETE CASCADE`: an
 * archived document must not be removable by deleting the row that produced it.
 */
export const einvoiceArchiveTable = pgTable(
  "einvoice_archive",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .default(sql`(nullif(current_setting('app.current_org_id', true), ''))::uuid`)
      .references(() => organizationsTable.id),
    companyId: uuid("company_id")
      .notNull()
      .default(sql`(nullif(current_setting('app.current_company_id', true), ''))::uuid`)
      .references(() => companiesTable.id),

    einvoiceDocumentId: uuid("einvoice_document_id")
      .notNull()
      .references(() => einvoiceDocumentsTable.id),
    invoiceId: integer("invoice_id")
      .notNull()
      .references(() => invoicesTable.id),

    /**
     * Which artifact was retained.
     *
     * `cleared`  — ZATCA's stamped XML, returned by the clearance flow. The
     *              legal document for a STANDARD (B2B) invoice.
     * `signed`   — our XAdES-signed XML. For the REPORTING flow ZATCA returns
     *              no stamped document at all, so this IS the artifact to
     *              retain for a simplified invoice.
     */
    artifact: text("artifact").notNull(),

    /**
     * The ZATCA §5.5 filename: VAT number + generation timestamp + invoice
     * reference. 🔴 GENERATION, not clearance — see `archiveNaming.ts`.
     */
    fileName: text("file_name").notNull(),
    /** Path within the backend; unique, so a re-archive is rejected not silently overwritten. */
    objectPath: text("object_path").notNull(),
    /** Which backend holds the bytes — a later migration needs to know. */
    storageProvider: text("storage_provider").notNull(),
    storageBucket: text("storage_bucket"),

    /** SHA-256 (hex) of the stored bytes — detects the "undetected alteration" §5.5 names. */
    sha256: text("sha256").notNull(),
    byteSize: integer("byte_size").notNull(),

    /** The GENERATION instant the filename is built from (`invoices.issued_at`). */
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }).notNull().defaultNow(),
    /**
     * Earliest date this may be disposed of — 6 years by VAT regulation, 11 for
     * certain cases. Stored per row rather than computed at read time so a
     * change to the configured default can never retroactively shorten the
     * retention of something already archived.
     */
    retainUntil: timestamp("retain_until", { withTimezone: true }).notNull(),
  },
  (table) => [
    // One archived artifact per document per kind. This is what makes the
    // archive sweep idempotent and safely re-runnable, including when two API
    // instances run the job concurrently.
    uniqueIndex("einvoice_archive_document_artifact_unq").on(table.einvoiceDocumentId, table.artifact),
    uniqueIndex("einvoice_archive_object_path_unq").on(table.objectPath),
    index("einvoice_archive_org_idx").on(table.organizationId, table.companyId),
    index("einvoice_archive_retain_idx").on(table.retainUntil),
  ],
);

export const insertEinvoiceArchiveSchema = createInsertSchema(einvoiceArchiveTable).omit({
  id: true,
  archivedAt: true,
});

export type InsertEinvoiceArchive = typeof einvoiceArchiveTable.$inferInsert;
export type EinvoiceArchive = typeof einvoiceArchiveTable.$inferSelect;
