/**
 * Captured documents (A1) — split by connection, like the outbox.
 *
 *   `capturedDocumentsRepository`      tenant transaction, RLS applies.
 *   `capturedDocumentsJobRepository`   base pool, NO RLS — promotion + purge.
 *
 * The jobs are infrastructure with no active organization, exactly like the
 * e-invoice worker, so they filter explicitly and take the same optional
 * `organizationId` scope that stops parallel test suites mutating each other's
 * rows (findings around M14/A1).
 */
import { db, pool, capturedDocumentsTable } from "@workspace/db";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";

export const capturedDocumentsRepository = {
  async insert(values: typeof capturedDocumentsTable.$inferInsert) {
    const [row] = await db.insert(capturedDocumentsTable).values(values).returning();
    return row;
  },

  async findById(id: string) {
    const [row] = await db
      .select()
      .from(capturedDocumentsTable)
      .where(eq(capturedDocumentsTable.id, id))
      .limit(1);
    return row ?? null;
  },

  /** Captures awaiting review — a refresh no longer loses the extraction. */
  async listStaged(limit = 50) {
    return db
      .select()
      .from(capturedDocumentsTable)
      .where(eq(capturedDocumentsTable.status, "staged"))
      .limit(limit);
  },

  /**
   * 🔴 Link a capture to the bill it became — CALLED INSIDE THE BILL'S
   * TRANSACTION.
   *
   * This is what makes "evidence for a bill that does not exist" impossible: if
   * the bill posting rolls back, so does this. The bytes move afterwards, via
   * the promotion job — object storage is not transactional with Postgres, so
   * the INTENT is what commits atomically. Same pattern as M12.6's outbox.
   */
  async markForPromotion(id: string, billId: number, retainUntil: Date) {
    const [row] = await db
      .update(capturedDocumentsTable)
      .set({ status: "promotion_pending", billId, retainUntil })
      .where(and(eq(capturedDocumentsTable.id, id), eq(capturedDocumentsTable.status, "staged")))
      .returning();
    return row ?? null;
  },

  /**
   * 🔴 Phase 13A — link a STAGED capture to a DRAFT bill as its evidence.
   * The capture stays deletable staging (it is not evidence of a POSTED
   * document yet), but a bill_id makes it the draft's document: the purge job
   * leaves it alone and the approval promotes it. Idempotent for the same bill;
   * a capture already linked to ANOTHER bill, promoted or discarded is refused
   * (null) — one document is not the evidence for two bills.
   */
  async linkToBill(id: string, billId: number) {
    const [row] = await db
      .update(capturedDocumentsTable)
      .set({ billId })
      .where(and(
        eq(capturedDocumentsTable.id, id),
        eq(capturedDocumentsTable.status, "staged"),
        sql`(${capturedDocumentsTable.billId} IS NULL OR ${capturedDocumentsTable.billId} = ${billId})`,
      ))
      .returning();
    return row ?? null;
  },

  /** The evidence document of a bill — the newest capture linked to it that was not discarded. */
  async activeForBill(billId: number) {
    const [row] = await db
      .select()
      .from(capturedDocumentsTable)
      .where(and(eq(capturedDocumentsTable.billId, billId), ne(capturedDocumentsTable.status, "discarded")))
      .orderBy(desc(capturedDocumentsTable.capturedAt))
      .limit(1);
    return row ?? null;
  },

  /** The evidence documents of a PAGE of bills, in one read (never one query per row). */
  async activeForBills(billIds: number[]) {
    if (billIds.length === 0) return [];
    return db
      .select({ id: capturedDocumentsTable.id, billId: capturedDocumentsTable.billId, contentType: capturedDocumentsTable.contentType, source: capturedDocumentsTable.source, signatureStatus: capturedDocumentsTable.signatureStatus, capturedAt: capturedDocumentsTable.capturedAt })
      .from(capturedDocumentsTable)
      .where(and(inArray(capturedDocumentsTable.billId, billIds), ne(capturedDocumentsTable.status, "discarded")))
      .orderBy(desc(capturedDocumentsTable.capturedAt));
  },

  /**
   * A draft bill is being DELETED: its still-staged captures stop being its
   * evidence (they become ordinary abandoned captures the purge job may
   * remove). A capture already promoted is never touched — only a posted bill
   * has one, and a posted bill is not deleted.
   */
  async unlinkStagedFromBill(billId: number) {
    await db
      .update(capturedDocumentsTable)
      .set({ billId: null })
      .where(and(eq(capturedDocumentsTable.billId, billId), eq(capturedDocumentsTable.status, "staged")));
  },

  /** What the reviewer changed, beside — never over — the extraction. */
  async setReviewCorrections(id: string, corrections: unknown) {
    await db.update(capturedDocumentsTable).set({ reviewCorrections: corrections as never }).where(eq(capturedDocumentsTable.id, id));
  },

  /**
   * Phase 13A — the SAME FILE captured before in this company (SHA-256).
   * RLS scopes the organisation; the company predicate is explicit (N1).
   * Discarded captures are excluded: a file the user threw away is not a
   * document they recorded.
   */
  async sameFile(sha256: string, excludeId: string) {
    return db
      .select({
        id: capturedDocumentsTable.id,
        capturedAt: capturedDocumentsTable.capturedAt,
        billId: capturedDocumentsTable.billId,
        status: capturedDocumentsTable.status,
      })
      .from(capturedDocumentsTable)
      .where(and(
        eq(capturedDocumentsTable.sha256, sha256),
        ne(capturedDocumentsTable.id, excludeId),
        ne(capturedDocumentsTable.status, "discarded"),
        sql`${capturedDocumentsTable.companyId}::text = current_setting('app.current_company_id', true)`,
      ))
      .orderBy(desc(capturedDocumentsTable.capturedAt))
      .limit(20);
  },

  async discard(id: string) {
    const [row] = await db
      .update(capturedDocumentsTable)
      .set({ status: "discarded", discardedAt: new Date() })
      .where(and(eq(capturedDocumentsTable.id, id), eq(capturedDocumentsTable.status, "staged")))
      .returning();
    return row ?? null;
  },

  /**
   * The staged image is confirmed gone — drop the pointer (B3).
   *
   * Tenant-scoped twin of the job repository's method: discard happens inside a
   * request, so it goes through RLS rather than the job's owner connection.
   * 🔴 Only ever called AFTER the backend confirms the delete; a non-null
   * `staging_path` is the record of bytes that still exist.
   */
  async clearStagingPath(id: string) {
    await db
      .update(capturedDocumentsTable)
      .set({ stagingPath: null })
      .where(eq(capturedDocumentsTable.id, id));
  },
};

export const capturedDocumentsJobRepository = {
  /** Captures whose bill committed but whose bytes have not moved yet. */
  async listPendingPromotion(limit = 50, organizationId?: string) {
    const { rows } = await pool.query(
      `SELECT id, organization_id AS "organizationId", company_id AS "companyId",
              staging_path AS "stagingPath", content_type AS "contentType",
              bill_id AS "billId", retain_until AS "retainUntil", captured_at AS "capturedAt"
         FROM captured_documents
        WHERE status = 'promotion_pending'
          AND ($2::uuid IS NULL OR organization_id = $2::uuid)
        ORDER BY captured_at
        LIMIT $1`,
      [limit, organizationId ?? null],
    );
    return rows as {
      id: string;
      organizationId: string;
      companyId: string;
      stagingPath: string | null;
      contentType: string;
      billId: number;
      retainUntil: Date | null;
      capturedAt: Date;
    }[];
  },

  /**
   * 🔴 `staging_path` is deliberately LEFT SET here (B3).
   *
   * It used to be nulled in this same statement, which meant a failed staged-copy
   * deletion left bytes in storage with no row pointing at them — unfindable,
   * unretryable, unprovable. The pointer is now cleared only once the bytes are
   * confirmed gone ({@link clearStagingPath}), so a promoted row that still
   * carries a `staging_path` IS the backlog: it enumerates exactly what was left
   * behind, and `listPromotedWithStagedCopy` retries it.
   *
   * Consumers must therefore choose the object path by STATUS, never by which
   * column happens to be non-null.
   */
  async markPromoted(id: string, archivePath: string) {
    await pool.query(
      `UPDATE captured_documents
          SET status = 'promoted', archive_path = $2, promoted_at = now()
        WHERE id = $1`,
      [id, archivePath],
    );
  },

  /** The staged copy is confirmed gone — drop the pointer to it. */
  async clearStagingPath(id: string) {
    await pool.query(`UPDATE captured_documents SET staging_path = NULL WHERE id = $1`, [id]);
  },

  /**
   * Promoted captures whose staged duplicate was NOT successfully deleted.
   *
   * The archive copy is authoritative, so nothing is at risk of being lost —
   * what is at risk is a pile of undeleted photographs nobody can enumerate,
   * which is the PDPL-shaped half of the problem (queue C8).
   */
  async listPromotedWithStagedCopy(limit = 100, organizationId?: string) {
    // Scoped for the same reason as the outbox's `claimDue`/`reclaimStale`:
    // the sweep is global by design (a job drains every tenant's backlog), but
    // parallel test suites each mount their OWN staging root against ONE shared
    // database — so one suite's sweep resolves another suite's relative path
    // under the wrong root, "succeeds" (missing file), and nulls the pointer
    // while the bytes still exist. Exactly the disease B3 fixed, re-created by
    // the test topology.
    const { rows } = await pool.query(
      `SELECT id, staging_path AS "stagingPath"
         FROM captured_documents
        WHERE status = 'promoted' AND staging_path IS NOT NULL
          AND ($2::uuid IS NULL OR organization_id = $2::uuid)
        ORDER BY promoted_at
        LIMIT $1`,
      [limit, organizationId ?? null],
    );
    return rows as { id: string; stagingPath: string }[];
  },

  /**
   * Abandoned captures eligible for purge.
   *
   * 🔴 `promotion_pending` and `promoted` are NEVER returned. A capture that
   * reached a bill is evidence for an input-VAT deduction and is not the purge
   * job's business — only staged and explicitly discarded ones are.
   *
   * 🔴 Phase 13A: nor is a STAGED capture linked to a draft bill — it is that
   * draft's evidence, and a draft held for evidence may wait longer than the
   * purge window. It becomes purgeable only if the draft is deleted (which
   * unlinks it).
   */
  async listPurgeable(olderThanDays: number, limit = 100, organizationId?: string) {
    const { rows } = await pool.query(
      `SELECT id, staging_path AS "stagingPath"
         FROM captured_documents
        WHERE (status = 'discarded' OR (status = 'staged' AND bill_id IS NULL))
          AND captured_at < now() - ($1 || ' days')::interval
          AND ($3::uuid IS NULL OR organization_id = $3::uuid)
        ORDER BY captured_at
        LIMIT $2`,
      [String(olderThanDays), limit, organizationId ?? null],
    );
    return rows as { id: string; stagingPath: string | null }[];
  },

  async deleteRows(ids: string[]) {
    if (ids.length === 0) return 0;
    const { rowCount } = await pool.query(`DELETE FROM captured_documents WHERE id = ANY($1)`, [ids]);
    return rowCount ?? 0;
  },
};

/** Re-exported so services need not import drizzle helpers. */
export { inArray };
