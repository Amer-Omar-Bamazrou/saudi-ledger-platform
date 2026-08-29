/**
 * LEDGER LISTS: a page that says so, and totals that describe the whole set.
 *
 * ── 🔴 THE TWO DEFECTS THIS PREVENTS, WHICH ARE ONE DISEASE ────────────────
 * B-6 named it: **capped where it should be unbounded and unbounded where it
 * should be capped is one illness pointing both ways.** The question is never
 * "is there a limit" but "does the number shown describe the set the reader
 * thinks it describes".
 *
 * The ledger lists had the *unbounded* half. `GET /invoices` returned every
 * invoice a tenant had ever issued, and the page then `reduce`d Outstanding and
 * Collected over whatever came back. That is correct exactly while the list is
 * unbounded — and the moment anyone adds a `LIMIT` for performance, every
 * headline figure silently becomes "the total of this page", which is a number
 * nobody asked for and which no longer matches the ledger.
 *
 * So the two changes are one change: paginate the rows, and compute the money
 * in SQL over the whole filtered set. Neither is safe without the other.
 *
 * 🔴 The fixture is LARGER than the page, because a test at page size passes
 * against both the broken and the fixed code.
 *
 * DB-backed; skips on the DB-free placeholder.
 */

process.env.PORT ??= "3137";
process.env.SESSION_SECRET ??= "ledger-list-pagination-secret-0123456789";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

const SLUG = "ledger-list-pagination";

/** The server's default page. */
const PAGE = 50;
/** Deliberately not a multiple of the page, and larger than it. */
const ROWS = PAGE + 23; // 73

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

describeMaybe("ledger lists paginate, and their totals describe the whole set", () => {
  let orgId = "";
  let companyId = "";
  let customerId = 0;

  const wipe = async () => {
    const org = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
    await pool.query(`DELETE FROM invoice_items WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id IN ${org})`);
    await pool.query(`DELETE FROM invoices WHERE organization_id IN ${org}`);
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
         VALUES ('Pagination Org','${SLUG}','approved') RETURNING id`,
      )
    ).rows[0].id;
    companyId = (
      await pool.query(`INSERT INTO companies (organization_id, name) VALUES ($1,'Page Co') RETURNING id`, [orgId])
    ).rows[0].id;
    customerId = (
      await pool.query(`INSERT INTO customers (organization_id, name) VALUES ($1,'Paged Customer') RETURNING id`, [orgId])
    ).rows[0].id;

    // 73 invoices: every one unpaid at 100.00, so the set-wide outstanding is a
    // number a page-scoped `reduce` cannot produce by accident.
    const values: string[] = [];
    for (let i = 0; i < ROWS; i++) {
      values.push(
        `($1, $2, $3, 'INV-PAGE-${String(i).padStart(3, "0")}', 'invoice', '2026-07-01', '2026-07-31', 100, 0, 100, 0, 'sent')`,
      );
    }
    await pool.query(
      `INSERT INTO invoices
         (organization_id, company_id, customer_id, invoice_number, document_type,
          date, due_date, subtotal, vat_amount, total, paid_amount, status)
       VALUES ${values.join(",")}`,
      [orgId, companyId, customerId],
    );
  });

  afterAll(wipe);

  it("the fixture is LARGER than the page (anti-vacuity)", async () => {
    const { rows } = await pool.query(`SELECT count(*)::int n FROM invoices WHERE organization_id = $1`, [orgId]);
    expect(rows[0].n).toBe(ROWS);
    expect(rows[0].n).toBeGreaterThan(PAGE);
  });

  it("🔴 returns a PAGE of rows, not the whole ledger", async () => {
    const { invoicesService } = await import("../services/invoices.service");
    const out = await inTenant(orgId, companyId, () => invoicesService.list({}));
    expect(out.items).toHaveLength(PAGE);
    expect(out.page.total).toBe(ROWS);
    // The page states the set it is a page OF — the whole point.
    expect(out.page.total).not.toBe(out.items.length);
  });

  it("🔴 the TOTALS describe every matching row, not the page", async () => {
    const { invoicesService } = await import("../services/invoices.service");
    const out = await inTenant(orgId, companyId, () => invoicesService.list({}));
    // 73 × 100.00 outstanding. A page-scoped reduce would give 50 × 100 = 5000,
    // which is the exact number this assertion exists to reject.
    expect(out.totals.outstanding).toBe(ROWS * 100);
    expect(out.totals.outstanding).not.toBe(PAGE * 100);
  });

  it("🔴 the last page returns the remainder, and the totals do not move", async () => {
    const { invoicesService } = await import("../services/invoices.service");
    const first = await inTenant(orgId, companyId, () => invoicesService.list({}));
    const last = await inTenant(orgId, companyId, () => invoicesService.list({ offset: PAGE }));
    expect(last.items).toHaveLength(ROWS - PAGE);
    // Turning the page must not change the headline figures.
    expect(last.totals.outstanding).toBe(first.totals.outstanding);
    expect(last.page.total).toBe(first.page.total);
    // And the two pages must not overlap.
    const ids = new Set([...first.items, ...last.items].map((i: { id: number }) => i.id));
    expect(ids.size).toBe(ROWS);
  });

  it("🔴 a filter narrows the rows AND the totals together — one predicate, not two", async () => {
    const { invoicesService } = await import("../services/invoices.service");
    // Nothing is a draft in this fixture, so both must go to zero together.
    const out = await inTenant(orgId, companyId, () => invoicesService.list({ status: "draft" }));
    expect(out.items).toHaveLength(0);
    expect(out.page.total).toBe(0);
    expect(out.totals.outstanding).toBe(0);
  });
});
