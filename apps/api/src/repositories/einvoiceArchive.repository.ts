/**
 * The e-invoice archive index (M12.8).
 *
 * Two exports, split by CONNECTION — the same discipline as
 * `einvoiceDocuments.repository` vs `einvoiceOutbox.repository`, and for the
 * same reason: the archive is written by a background job that has no tenant
 * context, and read by tenants who must only ever see their own.
 *
 *   `einvoiceArchiveRepository`      tenant transaction, RLS applies.
 *   `einvoiceArchiveJobRepository`   base pool, NO RLS — filters explicitly.
 *
 * Mixing them fails in opposite, equally bad directions: a job query on the
 * tenant proxy silently returns nothing (no GUC ⇒ RLS matches zero rows), and a
 * tenant query on the base pool silently returns every organization's rows.
 */
import { db, pool, einvoiceArchiveTable } from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";

/** A document awaiting archival, joined to everything the filename needs. */
export interface ArchivableDocument {
  documentId: string;
  organizationId: string;
  companyId: string;
  invoiceId: number;
  status: string;
  clearedXml: string | null;
  signedXml: string | null;
  /** 🔴 `invoices.issued_at` — the GENERATION instant ZATCA's filename uses. */
  issuedAt: Date | null;
  invoiceNumber: string;
  sellerVatNumber: string | null;
}

export const einvoiceArchiveRepository = {
  /** One tenant's archive index, newest first. */
  async listForCompany(companyId: string, limit = 200) {
    return db
      .select()
      .from(einvoiceArchiveTable)
      .where(eq(einvoiceArchiveTable.companyId, companyId))
      .orderBy(desc(einvoiceArchiveTable.archivedAt))
      .limit(limit);
  },

  async findByInvoice(invoiceId: number) {
    const [row] = await db
      .select()
      .from(einvoiceArchiveTable)
      .where(eq(einvoiceArchiveTable.invoiceId, invoiceId))
      .limit(1);
    return row ?? null;
  },

  async findById(id: string) {
    const [row] = await db
      .select()
      .from(einvoiceArchiveTable)
      .where(and(eq(einvoiceArchiveTable.id, id)))
      .limit(1);
    return row ?? null;
  },
};

export const einvoiceArchiveJobRepository = {
  /**
   * Accepted documents with nothing archived yet — the sweep's work list.
   *
   * Joins `invoices` for the seller VAT number and the GENERATION timestamp,
   * which the ZATCA filename needs and `einvoice_documents` does not carry.
   * (`einvoiceOutbox.repository` forbids business joins so an ambient
   * cross-tenant join can't slip in there; this module is archival-specific and
   * joins deliberately, filtering by the document's own ids.)
   */
  async listUnarchived(limit = 100): Promise<ArchivableDocument[]> {
    const { rows } = await pool.query(
      `SELECT d.id                AS "documentId",
              d.organization_id   AS "organizationId",
              d.company_id        AS "companyId",
              d.invoice_id        AS "invoiceId",
              d.status,
              d.cleared_xml       AS "clearedXml",
              d.signed_xml        AS "signedXml",
              i.issued_at         AS "issuedAt",
              i.invoice_number    AS "invoiceNumber",
              i.seller_vat_number AS "sellerVatNumber"
         FROM einvoice_documents d
         JOIN invoices i ON i.id = d.invoice_id
        WHERE d.status IN ('cleared', 'reported')
          AND NOT EXISTS (
                SELECT 1 FROM einvoice_archive a
                 WHERE a.einvoice_document_id = d.id
              )
        ORDER BY d.completed_at NULLS LAST, d.created_at
        LIMIT $1`,
      [limit],
    );
    return rows;
  },

  /**
   * Record an archived artifact.
   *
   * `ON CONFLICT DO NOTHING` against the (document, artifact) unique index makes
   * the sweep safely re-runnable and concurrent-safe: two API instances running
   * the job cannot create two index rows for one artifact. Returns null when the
   * row already existed.
   */
  async insert(v: {
    organizationId: string;
    companyId: string;
    einvoiceDocumentId: string;
    invoiceId: number;
    artifact: "cleared" | "signed";
    fileName: string;
    objectPath: string;
    storageProvider: string;
    storageBucket: string | null;
    sha256: string;
    byteSize: number;
    generatedAt: Date;
    retainUntil: Date;
  }): Promise<{ id: string } | null> {
    const { rows } = await pool.query(
      `INSERT INTO einvoice_archive
         (organization_id, company_id, einvoice_document_id, invoice_id, artifact,
          file_name, object_path, storage_provider, storage_bucket, sha256, byte_size,
          generated_at, retain_until)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (einvoice_document_id, artifact) DO NOTHING
       RETURNING id`,
      [
        v.organizationId,
        v.companyId,
        v.einvoiceDocumentId,
        v.invoiceId,
        v.artifact,
        v.fileName,
        v.objectPath,
        v.storageProvider,
        v.storageBucket,
        v.sha256,
        v.byteSize,
        v.generatedAt,
        v.retainUntil,
      ],
    );
    return rows[0] ?? null;
  },

  /** Archive coverage for the operator dashboard. */
  async stats(): Promise<{ archived: number; pendingArchive: number }> {
    const { rows } = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM einvoice_archive) AS archived,
         (SELECT count(*)::int
            FROM einvoice_documents d
           WHERE d.status IN ('cleared','reported')
             AND NOT EXISTS (SELECT 1 FROM einvoice_archive a WHERE a.einvoice_document_id = d.id)
         ) AS "pendingArchive"`,
    );
    return rows[0];
  },
};
