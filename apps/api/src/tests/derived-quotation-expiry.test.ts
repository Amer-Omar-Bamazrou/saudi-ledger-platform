/**
 * EXPIRED IS DERIVED FROM `valid_until` — the quotation twin of derived-overdue.
 *
 * ── WHY IT EXISTS ──────────────────────────────────────────────────────────
 * The approved navigation tree offers "Quotations → Expired" as a filter. The
 * owner's answer to what it means: derived from the date, for the same reason
 * overdue is — the dates hold the truth, and a stored `expired` status would be
 * a second representation of one fact, which drifts. `valid_until` already
 * existed (M21.1), so no column was added.
 *
 * ── 🔴 WHY THE ASSERTIONS ARE PAIRED, NOT COUNTED ──────────────────────────
 * The standing rule: when the CORRECT answer equals the BROKEN one, the test
 * proves nothing. A filter that returned an empty set would satisfy "no
 * unexpired quotation appears" perfectly. So every case below asserts both
 * that the right rows are PRESENT and that each wrong row is ABSENT for its
 * own distinct reason — seven quotations, six arms of the predicate, so a
 * predicate that drops any one arm returns a different list rather than the
 * same one by luck.
 *
 * ── 🔴 THE ONE THAT WOULD HAVE PASSED FOR THE WRONG REASON ─────────────────
 * `QUO-EX-5` is declined and lapsed. The predicate agreed in the doc aims a
 * term at it naming `status = 'declined'`, which is a value `status` cannot
 * hold — yet the row is still excluded, because a second CHECK constraint
 * (`outcome IS NULL OR status = 'approved'`) means every declined quotation is
 * also approved, and the `approved` term catches it. The fixture keeps that row
 * so the behaviour is pinned by a test rather than by a constraint in another
 * file nobody would think to re-read before relaxing it.
 *
 * DB-backed; skips on the DB-free placeholder.
 */

process.env.PORT ??= "3157";
process.env.SESSION_SECRET ??= "quotation-expiry-secret-0123456789abcdef";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

const SLUG = "derived-quotation-expiry";

/** Comfortably past and comfortably future, so the test never sits on today. */
const PAST = "2020-01-15";
const FUTURE = "2999-01-15";

async function inTenant<T>(orgId: string, companyId: string, fn: () => Promise<T>): Promise<T> {
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

interface QuotationRow {
  quotationNumber: string;
}

describeMaybe("expired is derived from valid_until, and no row stores it", () => {
  let orgId = "";
  let companyId = "";
  let customerId = 0;

  const wipe = async () => {
    const org = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
    await pool.query(
      `DELETE FROM quotation_conversion_items WHERE conversion_id IN
         (SELECT id FROM quotation_conversions WHERE organization_id IN ${org})`,
    );
    await pool.query(`DELETE FROM quotation_conversions WHERE organization_id IN ${org}`);
    await pool.query(
      `DELETE FROM quotation_items WHERE quotation_id IN (SELECT id FROM quotations WHERE organization_id IN ${org})`,
    );
    await pool.query(`DELETE FROM quotations WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM customers WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM categories WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM companies WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
  };

  beforeAll(async () => {
    await wipe();
    orgId = (
      await pool.query(
        `INSERT INTO organizations (name, slug, verification_status)
         VALUES ('Expiry Org','${SLUG}','approved') RETURNING id`,
      )
    ).rows[0].id;
    companyId = (
      await pool.query(`INSERT INTO companies (organization_id, name) VALUES ($1,'Expiry Co') RETURNING id`, [orgId])
    ).rows[0].id;
    customerId = (
      await pool.query(`INSERT INTO customers (organization_id, name) VALUES ($1,'Expiry Customer') RETURNING id`, [
        orgId,
      ])
    ).rows[0].id;

    /**
     *   QUO-EX-1  EXPIRED  submitted, validity lapsed
     *   QUO-EX-2  not      validity has not arrived yet
     *   QUO-EX-3  not      NULL valid_until — no expiry was ever stated, and
     *                      NULL is a first-class state (the column's own rule)
     *   QUO-EX-4  not      APPROVED — the customer accepted it; a lapsed date
     *                      does not un-accept it
     *   QUO-EX-5  not      DECLINED and lapsed (see the header — excluded by a
     *                      different term than the one aimed at it)
     *   QUO-EX-7  EXPIRED  submitted, lapsed — a second live row, so the
     *                      expected set is not a single row that could match
     *                      by accident
     *   QUO-EX-6  not      DRAFT and lapsed. 🔴 The owner closed this the
     *                      other way on 2026-08-31: a draft is not an offer
     *                      anyone received, so it cannot lapse — matching the
     *                      invoice precedent, where OVERDUE excludes drafts.
     */
    await pool.query(
      `INSERT INTO quotations
         (organization_id, company_id, customer_id, quotation_number,
          date, valid_until, subtotal, vat_amount, total, status, outcome)
       VALUES
         ($1,$2,$3,'QUO-EX-1','${PAST}','${PAST}',  100,0,100,'submitted',NULL),
         ($1,$2,$3,'QUO-EX-2','${PAST}','${FUTURE}',100,0,100,'submitted',NULL),
         ($1,$2,$3,'QUO-EX-3','${PAST}',NULL,       100,0,100,'submitted',NULL),
         ($1,$2,$3,'QUO-EX-4','${PAST}','${PAST}',  100,0,100,'approved', NULL),
         ($1,$2,$3,'QUO-EX-5','${PAST}','${PAST}',  100,0,100,'approved', 'declined'),
         ($1,$2,$3,'QUO-EX-6','${PAST}','${PAST}',  100,0,100,'draft',    NULL),
         ($1,$2,$3,'QUO-EX-7','${PAST}','${PAST}',  100,0,100,'submitted',NULL)`,
      [orgId, companyId, customerId],
    );
  });

  afterAll(wipe);

  it("the fixture actually landed (anti-vacuity — an empty org passes every assertion below)", async () => {
    const q = await pool.query(`SELECT count(*)::int n FROM quotations WHERE organization_id = $1`, [orgId]);
    expect(q.rows[0].n).toBe(7);
  });

  it("🔴 the expired filter returns exactly the two lapsed-and-live quotations", async () => {
    const { quotationsService } = await import("../services/quotations.service");
    const out = await inTenant(orgId, companyId, () => quotationsService.list({ expired: true }));
    const numbers = out.items.map((q: QuotationRow) => q.quotationNumber).sort();
    expect(numbers).toEqual(["QUO-EX-1", "QUO-EX-7"]);
  });

  it("🔴 each excluded quotation is excluded for its OWN reason", async () => {
    const { quotationsService } = await import("../services/quotations.service");
    const out = await inTenant(orgId, companyId, () => quotationsService.list({ expired: true }));
    const numbers = out.items.map((q: QuotationRow) => q.quotationNumber);
    expect(numbers, "a future validity date is not expiry").not.toContain("QUO-EX-2");
    expect(numbers, "NULL valid_until never expires — the column's stated rule").not.toContain("QUO-EX-3");
    expect(numbers, "an accepted quotation is not expired").not.toContain("QUO-EX-4");
    expect(numbers, "a declined quotation is terminated, not expired").not.toContain("QUO-EX-5");
    expect(
      numbers,
      "🔴 a DRAFT cannot expire — it is not an offer anyone received. This arm was " +
        "decided the opposite way at first and closed by the owner on 2026-08-31, " +
        "matching the invoice precedent where OVERDUE excludes drafts.",
    ).not.toContain("QUO-EX-6");
  });

  it("🔴 the figure MOVES — it is not a constant that happens to match", async () => {
    const { quotationsService } = await import("../services/quotations.service");
    const before = await inTenant(orgId, companyId, () => quotationsService.list({ expired: true }));
    expect(before.page.total).toBe(2);

    // Push QUO-EX-1's validity into the future: the count must drop by exactly
    // one, and that row must be the one that left.
    await pool.query(
      `UPDATE quotations SET valid_until = '${FUTURE}' WHERE organization_id = $1 AND quotation_number = 'QUO-EX-1'`,
      [orgId],
    );
    const after = await inTenant(orgId, companyId, () => quotationsService.list({ expired: true }));
    expect(after.page.total).toBe(1);
    expect(after.items.map((q: QuotationRow) => q.quotationNumber)).toEqual(["QUO-EX-7"]);

    await pool.query(
      `UPDATE quotations SET valid_until = '${PAST}' WHERE organization_id = $1 AND quotation_number = 'QUO-EX-1'`,
      [orgId],
    );
  });

  it("🔴 the count and the rows describe the SAME set", async () => {
    const { quotationsService } = await import("../services/quotations.service");
    const out = await inTenant(orgId, companyId, () => quotationsService.list({ expired: true }));
    // One predicate feeds both; this is what makes that structural rather than
    // a claim in a comment.
    expect(out.page.total).toBe(out.items.length);
  });

  it("🔴 nothing WRITES 'expired' as a status — it is derived, in one place only", async () => {
    const rows = await pool.query(`SELECT count(*)::int n FROM quotations WHERE status = 'expired'`);
    expect(rows.rows[0].n).toBe(0);
    // The constraint itself is asserted, not just the absence of rows: if a
    // migration ever widens the status domain to include 'expired', this goes
    // red rather than silently blessing a second representation of a fact the
    // date already holds.
    const constrained = await pool.query(
      `SELECT pg_get_constraintdef(oid) def FROM pg_constraint WHERE conname = 'quotations_status_check'`,
    );
    expect(constrained.rows[0]?.def ?? "").not.toContain("expired");
  });

  it("🔴 the CONVERTED filter is derived from conversion rows, and starts empty here", async () => {
    const { quotationsService } = await import("../services/quotations.service");
    const out = await inTenant(orgId, companyId, () => quotationsService.list({ converted: true }));
    // Anti-vacuity: this org has six quotations and no conversions, so an empty
    // result is the RIGHT answer — which is exactly why the assertion below
    // pairs it with the unfiltered count. Nothing here proves the filter works;
    // it proves the filter is not returning everything.
    expect(out.page.total).toBe(0);
    const all = await inTenant(orgId, companyId, () => quotationsService.list({}));
    expect(all.page.total).toBe(7);
  });
});
