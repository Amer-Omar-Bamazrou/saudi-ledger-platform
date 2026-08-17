/**
 * The e-invoice outbox (M12.6).
 *
 * ── 🔴 RUNS ON THE BASE POOL, NOT A TENANT TRANSACTION ──────────────────────
 * The worker is infrastructure, like the M11 identity layer: it runs outside any
 * request, so there is no `app.current_org_id` GUC and **RLS does not filter
 * anything here**. That is the M-1 landmine in reverse.
 *
 * The discipline that replaces RLS:
 *   1. Claiming is deliberately CROSS-TENANT — one worker drains every
 *      organization's queue, which is the whole point of a background worker.
 *   2. Every row carries its own `organization_id` / `company_id`, and any
 *      per-tenant read MUST filter on them explicitly.
 *   3. This module NEVER joins business tables. It reads and writes
 *      `einvoice_documents` and nothing else, so an ambient cross-tenant join
 *      cannot be introduced here by accident.
 */
import { pool } from "@workspace/db";

export interface OutboxRow {
  id: string;
  organizationId: string;
  companyId: string;
  invoiceId: number;
  flow: "clearance" | "reporting";
  status: string;
  /** ZATCA's document UUID — must match `cbc:UUID` in the signed XML. */
  zatcaUuid: string | null;
  invoiceHash: string | null;
  previousInvoiceHash: string | null;
  signedXml: string | null;
  attemptCount: number;
  ambiguous: boolean;
}

const SELECT_COLS = `id, organization_id AS "organizationId", company_id AS "companyId",
  invoice_id AS "invoiceId", flow, status, zatca_uuid AS "zatcaUuid",
  invoice_hash AS "invoiceHash", previous_invoice_hash AS "previousInvoiceHash",
  signed_xml AS "signedXml", attempt_count AS "attemptCount", ambiguous`;

export const einvoiceOutboxRepository = {
  /**
   * Atomically claim due work.
   *
   * `FOR UPDATE SKIP LOCKED` is what makes this safe across processes: two
   * workers never claim the same row, and neither blocks waiting for the other.
   * Single-instance today, but scaling out needs more processes rather than a
   * redesign.
   *
   * The claim UPDATE and the SELECT are one statement, so there is no
   * read-then-write window in which a second worker could see the same row as
   * unclaimed.
   */
  async claimDue(workerId: string, batchSize: number, organizationId?: string): Promise<OutboxRow[]> {
    const { rows } = await pool.query(
      `UPDATE einvoice_documents
          SET status = 'submitting',
              claimed_at = now(),
              claimed_by = $1,
              attempt_count = attempt_count + 1,
              updated_at = now()
        WHERE id IN (
          SELECT id FROM einvoice_documents
           WHERE status IN ('pending', 'failed')
             AND ambiguous = false
             AND (next_attempt_at IS NULL OR next_attempt_at <= now())
             AND ($3::uuid IS NULL OR organization_id = $3::uuid)
           ORDER BY created_at
           FOR UPDATE SKIP LOCKED
           LIMIT $2
        )
        RETURNING ${SELECT_COLS}`,
      [workerId, batchSize, organizationId ?? null],
    );
    return rows;
  },

  /**
   * Reclaim rows abandoned by a dead worker.
   *
   * Returns them to `pending` but marks them **ambiguous**: the worker may have
   * sent the document before dying, so ZATCA's state is unknown and the row must
   * NOT be resubmitted blindly — a second submission of a document ZATCA already
   * holds is a duplicate invoice, not a retry.
   *
   * 🔴 S2: "reconciliation" here means **a human checks the Fatoora portal**.
   * It does not mean asking ZATCA, and it never did: **ZATCA's API exposes no
   * invoice-status or query endpoint** (Compliance CSID, Production CSID,
   * Clearance and Reporting are the whole surface). An ambiguous row lands in
   * `needs_review` and waits for a person. Correct under the constraint — but
   * earlier comments described an automated query that does not and cannot
   * exist, which is the same disease as a schema with no consumer.
   */
  async reclaimStale(olderThanSeconds: number, organizationId?: string): Promise<number> {
    // 🔴 Scoped for the same reason as `claimDue`, and M14 missing this is why
    // the outbox suite flaked. Reclaiming is global by default — correct in
    // production, where one worker drains every tenant — but it means any two
    // test suites holding a row in `submitting` reclaim each other's, flipping
    // it to `pending` + `ambiguous` under the owning suite's feet.
    //
    // M14 scoped `claimDue` and left this one global: half a fix, which reads
    // as a whole one. Both global operations need the same escape hatch.
    const { rowCount } = await pool.query(
      `UPDATE einvoice_documents
          SET status = 'pending', ambiguous = true, claimed_at = NULL, claimed_by = NULL,
              updated_at = now()
        WHERE status = 'submitting'
          AND claimed_at < now() - ($1 || ' seconds')::interval
          AND ($2::uuid IS NULL OR organization_id = $2::uuid)`,
      [String(olderThanSeconds), organizationId ?? null],
    );
    return rowCount ?? 0;
  },

  /** Record a terminal success. */
  async markAccepted(
    id: string,
    v: { status: "cleared" | "reported"; zatcaStatus: string | null; warnings: unknown[] | null; clearedXml: string | null },
  ): Promise<void> {
    await pool.query(
      `UPDATE einvoice_documents
          SET status = $2, zatca_status = $3, zatca_warnings = $4, cleared_xml = $5,
              completed_at = now(), submitted_at = COALESCE(submitted_at, now()),
              last_error = NULL, claimed_at = NULL, claimed_by = NULL, updated_at = now()
        WHERE id = $1`,
      [id, v.status, v.zatcaStatus, v.warnings ? JSON.stringify(v.warnings) : null, v.clearedXml],
    );
  },

  /** Schedule a retry with backoff, or escalate when attempts are exhausted. */
  async markFailed(
    id: string,
    v: { errors: unknown[] | null; zatcaStatus: string | null; ambiguous: boolean; retryInSeconds: number | null },
  ): Promise<void> {
    // retryInSeconds === null ⇒ no further automatic attempts.
    const terminal = v.retryInSeconds === null;
    await pool.query(
      `UPDATE einvoice_documents
          SET status = $2,
              last_error = $3,
              zatca_status = $4,
              ambiguous = $5,
              next_attempt_at = CASE WHEN $6::int IS NULL THEN NULL
                                     ELSE now() + ($6 || ' seconds')::interval END,
              submitted_at = COALESCE(submitted_at, now()),
              claimed_at = NULL, claimed_by = NULL, updated_at = now()
        WHERE id = $1`,
      [
        id,
        terminal || v.ambiguous ? "needs_review" : "failed",
        v.errors ? JSON.stringify(v.errors) : null,
        v.zatcaStatus,
        v.ambiguous,
        v.retryInSeconds === null ? null : String(v.retryInSeconds),
      ],
    );
  },

  /** Rows a human must look at — the operator queue. */
  async listNeedingReview(limit = 100): Promise<OutboxRow[]> {
    const { rows } = await pool.query(
      `SELECT ${SELECT_COLS} FROM einvoice_documents
        WHERE status IN ('needs_review', 'rejected') ORDER BY updated_at DESC LIMIT $1`,
      [limit],
    );
    return rows;
  },

  /**
   * Documents overdue for submission — the AGE ALARM.
   *
   * The dangerous failure is not a loud rejection but quiet neglect: a
   * simplified invoice silently missing ZATCA's 24-hour reporting deadline is
   * legal exposure for the tenant, and nothing about it looks broken.
   */
  async listOverdue(olderThanMinutes: number, limit = 100, organizationId?: string): Promise<OutboxRow[]> {
    // Scoped for the same reason as `claimDue`/`reclaimStale`: evaluation is
    // global by design (one alarm pass watches every tenant), and in the test
    // suite that means one suite's aged documents fire another suite's alarm.
    const { rows } = await pool.query(
      `SELECT ${SELECT_COLS} FROM einvoice_documents
        WHERE status IN ('pending', 'failed', 'submitting')
          AND created_at < now() - ($1 || ' minutes')::interval
          AND ($3::uuid IS NULL OR organization_id = $3::uuid)
        ORDER BY created_at LIMIT $2`,
      [String(olderThanMinutes), limit, organizationId ?? null],
    );
    return rows;
  },

  /** Read one row by id — used by tests and the operator surface. */
  async findById(id: string): Promise<OutboxRow | undefined> {
    const { rows } = await pool.query(`SELECT ${SELECT_COLS} FROM einvoice_documents WHERE id = $1`, [id]);
    return rows[0];
  },
};
