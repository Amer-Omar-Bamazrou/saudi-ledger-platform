/**
 * `einvoice_documents` — the TENANT-SCOPED half (M12.8).
 *
 * ── Why this exists alongside `einvoiceOutbox.repository` ───────────────────
 * The same table is reached two ways, and conflating them is how tenant context
 * leaks:
 *
 *   - **This module** runs inside the request's tenant transaction on the `db`
 *     proxy, so RLS applies and an insert commits ATOMICALLY with the ledger
 *     effect that produced it. That atomicity is the whole reason the outbox
 *     row is written at issuance rather than by a later sweep: a rolled-back
 *     approval must leave no queued document, and an issued invoice must never
 *     fail to be queued.
 *   - **`einvoiceOutbox.repository`** runs on the base pool with NO RLS, because
 *     the worker is infrastructure with no active organization. It claims and
 *     completes work cross-tenant.
 *
 * Keep the split. A worker query that accidentally lands here would silently
 * return nothing (no GUC ⇒ RLS matches zero rows); a request query that landed
 * there would silently see every tenant.
 */
import { db, einvoiceDocumentsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";

export interface NewEInvoiceDocument {
  organizationId: string;
  companyId: string;
  invoiceId: number;
  flow: "clearance" | "reporting";
  invoiceHash: string;
  previousInvoiceHash: string;
  qrCode: string;
  signedXml: string;
}

export const einvoiceDocumentsRepository = {
  /**
   * Queue a signed document for transmission.
   *
   * 🔴 `organizationId` and `companyId` are passed EXPLICITLY rather than left to
   * the column defaults, which read `app.current_org_id` / `app.current_company_id`.
   * The org GUC is always right, but the COMPANY GUC is the request's active
   * company — and in a multi-company org that is not necessarily the company the
   * invoice belongs to. Defaulting it would file the document under the wrong EGS
   * unit, i.e. the wrong certificate and the wrong hash chain. This is the same
   * mistake M12.1a fixed twice (`findActive()` vs the invoice's own company); it
   * is not repeated here.
   */
  async insert(doc: NewEInvoiceDocument) {
    const [row] = await db
      .insert(einvoiceDocumentsTable)
      .values({
        organizationId: doc.organizationId,
        companyId: doc.companyId,
        invoiceId: doc.invoiceId,
        flow: doc.flow,
        status: "pending",
        invoiceHash: doc.invoiceHash,
        previousInvoiceHash: doc.previousInvoiceHash,
        qrCode: doc.qrCode,
        signedXml: doc.signedXml,
      })
      .returning();
    return row;
  },

  /** The queued document for one invoice, if it has been signed. */
  async findByInvoice(invoiceId: number) {
    const [row] = await db
      .select()
      .from(einvoiceDocumentsTable)
      .where(eq(einvoiceDocumentsTable.invoiceId, invoiceId))
      .limit(1);
    return row ?? null;
  },

  /** Transmission state for one company — the tenant-facing ZATCA status view. */
  async listByCompany(companyId: string, limit = 100) {
    return db
      .select({
        id: einvoiceDocumentsTable.id,
        invoiceId: einvoiceDocumentsTable.invoiceId,
        flow: einvoiceDocumentsTable.flow,
        status: einvoiceDocumentsTable.status,
        zatcaStatus: einvoiceDocumentsTable.zatcaStatus,
        attemptCount: einvoiceDocumentsTable.attemptCount,
        createdAt: einvoiceDocumentsTable.createdAt,
        completedAt: einvoiceDocumentsTable.completedAt,
      })
      .from(einvoiceDocumentsTable)
      .where(and(eq(einvoiceDocumentsTable.companyId, companyId)))
      .limit(limit);
  },
};
