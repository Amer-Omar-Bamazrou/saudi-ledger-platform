/**
 * OVERDUE IS DERIVED FROM DATES — and nothing writes it as a status.
 *
 * ── 🔴 THE DEFECT THIS CLOSES: A CONSUMER WITH NO PRODUCER ─────────────────
 * `invoices.status` and `bills.status` carried an `'overdue'` value that was
 * READ in six places and WRITTEN in none. The Invoices page counted it for a
 * KPI, both pages offered it as a filter chip, and `creditNotes.ts` listed it
 * among issued statuses.
 *
 * None of that errored. The KPI rendered a confident **0**, permanently, and
 * the chip returned an empty set that looked like clean books — which is why it
 * survived: a missing consumer leaves a dead column nobody sees, while a
 * missing producer produces *an answer*.
 *
 * `'cancelled'` was the same defect one value over, and it gets no replacement:
 * an invoice that must not stand is reversed by a CREDIT NOTE, which is the
 * ZATCA-correct mechanism and already works.
 *
 * ── WHY DERIVE RATHER THAN WRITE ───────────────────────────────────────────
 * The dates already hold the truth. A status column would be a SECOND
 * representation of one fact, and the aging report already derives overdue from
 * dates — so a written status would need machinery to stay in step with a
 * figure that is computed. Deriving makes the two agree by construction.
 *
 * ── WHAT THIS TEST ASSERTS, IN BOTH DIRECTIONS ─────────────────────────────
 * A presence assertion AND an absence assertion, deliberately paired:
 *
 *  - PRESENCE: the derived count is right, and it MOVES when a due date passes.
 *    A count that is merely 0 would pass against the broken code too.
 *  - ABSENCE: no row in `invoices` or `bills` anywhere holds either value. If a
 *    writer is ever added, this goes red rather than silently blessing a second
 *    representation of the fact.
 *
 * DB-backed; skips on the DB-free placeholder.
 */

process.env.PORT ??= "3149";
process.env.SESSION_SECRET ??= "derived-overdue-secret-0123456789abcdef";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

const SLUG = "derived-overdue";

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

describeMaybe("overdue is derived from dates, and no row stores it", () => {
  let orgId = "";
  let companyId = "";
  let customerId = 0;
  let vendorId = 0;

  const wipe = async () => {
    const org = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
    await pool.query(
      `DELETE FROM invoice_items WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id IN ${org})`,
    );
    await pool.query(`DELETE FROM invoices WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM bill_items WHERE bill_id IN (SELECT id FROM bills WHERE organization_id IN ${org})`);
    await pool.query(`DELETE FROM bills WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM customers WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM vendors WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM categories WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM companies WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
  };

  beforeAll(async () => {
    await wipe();
    orgId = (
      await pool.query(
        `INSERT INTO organizations (name, slug, verification_status)
         VALUES ('Overdue Org','${SLUG}','approved') RETURNING id`,
      )
    ).rows[0].id;
    companyId = (
      await pool.query(`INSERT INTO companies (organization_id, name) VALUES ($1,'Overdue Co') RETURNING id`, [orgId])
    ).rows[0].id;
    customerId = (
      await pool.query(`INSERT INTO customers (organization_id, name) VALUES ($1,'Overdue Customer') RETURNING id`, [
        orgId,
      ])
    ).rows[0].id;
    vendorId = (
      await pool.query(`INSERT INTO vendors (organization_id, name) VALUES ($1,'Overdue Vendor') RETURNING id`, [orgId])
    ).rows[0].id;

    /**
     * Six invoices covering every arm of the predicate. Three are overdue, and
     * the three that are NOT each fail for a DIFFERENT reason — so a predicate
     * that drops any one arm produces a different number rather than the same
     * one by luck.
     *
     *   INV-OD-1  overdue     issued, past due, unpaid
     *   INV-OD-2  not         the due date has not arrived
     *   INV-OD-3  not         fully paid, so nothing is outstanding
     *   INV-OD-4  not         a DRAFT moves nothing (zero-movement standard)
     *   INV-OD-5  overdue     no due date, so it ages from its own date
     *   INV-OD-6  overdue     partially paid, remainder still outstanding
     */
    await pool.query(
      `INSERT INTO invoices
         (organization_id, company_id, customer_id, invoice_number, document_type,
          date, due_date, subtotal, vat_amount, total, paid_amount, status)
       VALUES
         ($1,$2,$3,'INV-OD-1','invoice','${PAST}','${PAST}',100,0,100,0,'sent'),
         ($1,$2,$3,'INV-OD-2','invoice','${PAST}','${FUTURE}',100,0,100,0,'sent'),
         ($1,$2,$3,'INV-OD-3','invoice','${PAST}','${PAST}',100,0,100,100,'paid'),
         ($1,$2,$3,'INV-OD-4','invoice','${PAST}','${PAST}',100,0,100,0,'draft'),
         ($1,$2,$3,'INV-OD-5','invoice','${PAST}',NULL,100,0,100,0,'sent'),
         ($1,$2,$3,'INV-OD-6','invoice','${PAST}','${PAST}',100,0,100,40,'sent')`,
      [orgId, companyId, customerId],
    );

    await pool.query(
      `INSERT INTO bills
         (organization_id, company_id, vendor_id, bill_number, date, due_date,
          subtotal, vat_amount, total, paid_amount, status)
       VALUES
         ($1,$2,$3,'BILL-OD-1','${PAST}','${PAST}',100,0,100,0,'received'),
         ($1,$2,$3,'BILL-OD-2','${PAST}','${FUTURE}',100,0,100,0,'received'),
         ($1,$2,$3,'BILL-OD-3','${PAST}','${PAST}',100,0,100,100,'paid'),
         ($1,$2,$3,'BILL-OD-4','${PAST}','${PAST}',100,0,100,0,'draft'),
         ($1,$2,$3,'BILL-OD-5','${PAST}',NULL,100,0,100,0,'received')`,
      [orgId, companyId, vendorId],
    );
  });

  afterAll(wipe);

  it("the fixture actually landed (anti-vacuity — a zero count would pass every assertion below)", async () => {
    const inv = await pool.query(`SELECT count(*)::int n FROM invoices WHERE organization_id = $1`, [orgId]);
    const bill = await pool.query(`SELECT count(*)::int n FROM bills WHERE organization_id = $1`, [orgId]);
    expect(inv.rows[0].n).toBe(6);
    expect(bill.rows[0].n).toBe(5);
  });

  it("🔴 the derived overdue count is 3 — NOT the 0 the status column would have given", async () => {
    const { invoicesService } = await import("../services/invoices.service");
    const out = await inTenant(orgId, companyId, () => invoicesService.list({}));
    expect(out.totals.overdue).toBe(3);
    // The exact number the broken implementation returned, named so this
    // assertion cannot pass for the old reason.
    expect(out.totals.overdue).not.toBe(0);
  });

  it("🔴 each non-overdue invoice is excluded for its OWN reason", async () => {
    const { invoicesService } = await import("../services/invoices.service");
    const out = await inTenant(orgId, companyId, () => invoicesService.list({ overdue: true }));
    const numbers = out.items.map((i: { invoiceNumber: string }) => i.invoiceNumber).sort();
    expect(numbers).toEqual(["INV-OD-1", "INV-OD-5", "INV-OD-6"]);
    // Not due yet, fully paid, and still a draft — three different arms.
    expect(numbers).not.toContain("INV-OD-2");
    expect(numbers).not.toContain("INV-OD-3");
    expect(numbers).not.toContain("INV-OD-4");
  });

  it("🔴 the COUNT and the FILTER describe the same set — one predicate, not two", async () => {
    const { invoicesService } = await import("../services/invoices.service");
    const all = await inTenant(orgId, companyId, () => invoicesService.list({}));
    const filtered = await inTenant(orgId, companyId, () => invoicesService.list({ overdue: true }));
    expect(filtered.page.total).toBe(all.totals.overdue);
    expect(filtered.items).toHaveLength(all.totals.overdue);
  });

  it("🔴 the count MOVES when a due date passes — the assertion a static 0 cannot fake", async () => {
    const { invoicesService } = await import("../services/invoices.service");
    const before = await inTenant(orgId, companyId, () => invoicesService.list({}));
    expect(before.totals.overdue).toBe(3);

    // The only change: INV-OD-2's due date moves from the future into the past.
    // No status is written and no other column is touched.
    await pool.query(
      `UPDATE invoices SET due_date = '${PAST}' WHERE organization_id = $1 AND invoice_number = 'INV-OD-2'`,
      [orgId],
    );
    const after = await inTenant(orgId, companyId, () => invoicesService.list({}));
    expect(after.totals.overdue).toBe(4);

    // And back, so the fixture is unchanged for whatever runs next.
    await pool.query(
      `UPDATE invoices SET due_date = '${FUTURE}' WHERE organization_id = $1 AND invoice_number = 'INV-OD-2'`,
      [orgId],
    );
    const restored = await inTenant(orgId, companyId, () => invoicesService.list({}));
    expect(restored.totals.overdue).toBe(3);
  });

  it("🔴 bills derive it the same way, and the count is over the SET, not the page", async () => {
    const { billsService } = await import("../services/bills.service");
    const out = await inTenant(orgId, companyId, () => billsService.list({}));
    // BILL-OD-1 (past due) and BILL-OD-5 (no due date, ages from its own date).
    expect(out.totals.overdue).toBe(2);
    const filtered = await inTenant(orgId, companyId, () => billsService.list({ overdue: true }));
    expect(filtered.page.total).toBe(out.totals.overdue);
  });

  /**
   * 🔴 The absence half. Global, not scoped to this fixture: the claim is that
   * NOTHING writes these values, so the guard fails the moment any writer is
   * added anywhere — which is the event that would quietly restore the second
   * representation this change removed.
   */
  it("🔴 no invoice or bill ANYWHERE holds 'overdue' or 'cancelled' — the absence half", async () => {
    const inv = await pool.query(`SELECT count(*)::int n FROM invoices WHERE status IN ('overdue','cancelled')`);
    const bill = await pool.query(`SELECT count(*)::int n FROM bills WHERE status IN ('overdue','cancelled')`);
    expect(
      inv.rows[0].n,
      "a writer of invoices.status = 'overdue'/'cancelled' has appeared — see the header of derived-overdue.test.ts",
    ).toBe(0);
    expect(
      bill.rows[0].n,
      "a writer of bills.status = 'overdue'/'cancelled' has appeared — see the header of derived-overdue.test.ts",
    ).toBe(0);
  });
});
