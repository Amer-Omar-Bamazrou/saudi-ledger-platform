/**
 * B6 — a COUNT derived from a CAPPED list saturates, and lies quietly.
 *
 * ── The defect ─────────────────────────────────────────────────────────────
 * `financeHub.booksStatus()` answered "are my books current?" with
 * `(await transactionsService.pendingReview()).length` — and `pendingReview`
 * is capped at 200 rows because it feeds a screen. So a tenant with 5,000
 * unreviewed transactions was told **200**. `needsAttentionCount` was worse: it
 * filtered WITHIN that capped page, so it was not even a proportional sample —
 * it was "how many of the 200 most recent need attention", presented as a total.
 *
 * The same shape sat on `operatorZatca.health()`: `overdue.total =
 * listOverdue(…, 500).length`, saturating at 500 — on the one surface that
 * watches ZATCA's 24-hour reporting deadline, where under-reporting is exactly
 * the failure the surface exists to prevent.
 *
 * ── 🔴 THE TIMING PROPERTY — why this is the reusable part ─────────────────
 * **It is invisible on any dataset small enough to develop against, and appears
 * the month a tenant gets busy.** The dev org has 45 transactions; every
 * fixture in this suite is smaller still. No amount of care at fixture scale
 * finds it, because at fixture scale the capped answer and the true answer are
 * the same number.
 *
 * That indicts the verification approach, not the reviewer: small fixtures, dev
 * orgs and sample seeds are STRUCTURALLY blind to any defect whose trigger is
 * volume. The class includes at least: counts over capped lists (this file),
 * aggregates computed client-side over a fetched page, pagination that silently
 * truncates, unbounded queries that only become slow, and any `LIMIT` whose
 * result is measured rather than rendered.
 *
 * 🔴 So this test does the one thing that catches it: it builds a dataset
 * **larger than the cap**. That is the whole point — a test at fixture size
 * would pass against the broken code.
 *
 * DB-backed; skips on the DB-free placeholder.
 */

process.env.PORT ??= "3110";
process.env.SESSION_SECRET ??= "counts-over-capped-lists-test-secret-0123456789";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) {
  // eslint-disable-next-line no-console
  console.warn("[counts-over-capped-lists] no real DATABASE_URL — skipping.");
}

/** The cap inside `pendingReview`. The dataset must exceed it to prove anything. */
const REVIEW_CAP = 200;
const OVER_CAP = REVIEW_CAP + 37; // deliberately not a round number

describeMaybe("B6 — counts must not saturate at a list cap", () => {
  let orgId = "";
  let companyId = "";
  let bankAccountId: number | null = null;

  beforeAll(async () => {
    const org = await pool.query(
      `INSERT INTO organizations (name, slug, verification_status)
       VALUES ('B6 Count Org','b6count','approved') RETURNING id`,
    );
    orgId = org.rows[0].id;
    const co = await pool.query(
      `INSERT INTO companies (organization_id, name) VALUES ($1,'B6 Co') RETURNING id`,
      [orgId],
    );
    companyId = co.rows[0].id;

    // OVER_CAP pending rows. Half uncategorised (⇒ needsAttention), half not.
    const values: string[] = [];
    const params: any[] = [orgId, companyId];
    for (let i = 0; i < OVER_CAP; i++) {
      const needsAttention = i % 2 === 0;
      values.push(
        `($1, $2, '2026-08-0${(i % 9) + 1}', ${100 + i}, 'B6 row ${i}', 'expense',` +
          ` 'pending_review', ${needsAttention ? "NULL" : "NULL"}, 'operating', ${needsAttention ? "NULL" : "0.95"}, false)`,
      );
    }
    await pool.query(
      `INSERT INTO transactions
         (organization_id, company_id, date, amount, description, type,
          review_status, category_id, kind, confidence_score, is_manually_overridden)
       VALUES ${values.join(",")}`,
      params,
    );
    expect(bankAccountId).toBeNull(); // unused; keeps the shape explicit
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM transactions WHERE organization_id = $1`, [orgId]);
    await pool.query(`DELETE FROM companies WHERE organization_id = $1`, [orgId]);
    await pool.query(`DELETE FROM organizations WHERE id = $1`, [orgId]);
  });

  it("the fixture is genuinely LARGER than the cap (anti-vacuity)", async () => {
    // Without this the whole file could pass at fixture size against the very
    // bug it exists to catch.
    const { rows } = await pool.query(
      `SELECT count(*)::int n FROM transactions WHERE organization_id = $1 AND review_status = 'pending_review'`,
      [orgId],
    );
    expect(rows[0].n).toBe(OVER_CAP);
    expect(rows[0].n).toBeGreaterThan(REVIEW_CAP);
  });

  it("🔴 the SQL count returns the true total, not the cap", async () => {
    const { transactionsRepository } = await import("../repositories/transactions.repository");
    const { AUTO_ASSIGN_CONFIDENCE } = await import("../services/categorization/resolveCategory");
    const counts = await withOrg(orgId, companyId, () =>
      transactionsRepository.pendingReviewCounts(AUTO_ASSIGN_CONFIDENCE),
    );
    expect(counts.total).toBe(OVER_CAP);
    // The value the broken code returned. Named, so a regression is unmistakable.
    expect(counts.total).not.toBe(REVIEW_CAP);
  });

  it("🔴 needsAttention counts the whole set, not the visible page", async () => {
    const { transactionsRepository } = await import("../repositories/transactions.repository");
    const { AUTO_ASSIGN_CONFIDENCE } = await import("../services/categorization/resolveCategory");
    const counts = await withOrg(orgId, companyId, () =>
      transactionsRepository.pendingReviewCounts(AUTO_ASSIGN_CONFIDENCE),
    );
    // Every row is uncategorised and non-transfer, so all of them qualify.
    expect(counts.needsAttention).toBe(OVER_CAP);
    expect(counts.needsAttention).toBeGreaterThan(REVIEW_CAP);
  });

  it("the row LIST is still capped — the fix is the count, not removing the cap", async () => {
    const { transactionsRepository } = await import("../repositories/transactions.repository");
    const rows = await withOrg(orgId, companyId, () => transactionsRepository.pendingReview());
    // The screen still receives a bounded page; that was never the bug.
    expect(rows.length).toBe(REVIEW_CAP);
    expect(rows.length).toBeLessThan(OVER_CAP);
  });
});

/** Run a callback inside a tenant-scoped transaction for this org. */
async function withOrg<T>(orgId: string, companyId: string, fn: () => Promise<T>): Promise<T> {
  const { beginTenantConnection } = await import("@workspace/db");
  const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
  try {
    const out = await conn.run(fn);
    await conn.commit();
    return out;
  } catch (e) {
    await conn.rollback();
    throw e;
  }
}
