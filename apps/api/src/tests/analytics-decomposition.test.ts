/**
 * M19.2 — WHERE a change came from.
 *
 * 🔴 THE RULE this file guards (design-analytics.md §5, hub-structure-decision
 * §4): **state where a change came from, never why it happened.** Decomposition
 * is arithmetic; causation is inference. That distinction is what keeps this
 * feature outside the parked-AI trigger, so the output is ranked numbers — no
 * sentence, no cause, no recommendation.
 *
 * The two cases worth the most care are the ones a naive implementation gets
 * wrong:
 *
 *   1. **Offsetting movements.** One customer up 50k, another down 50k, net
 *      zero. Dividing by a net of zero gives every mover an infinite share of
 *      "nothing changed". The movers are real and must still be listed.
 *   2. **Arrivals and departures.** A customer present in only one window is
 *      exactly the biggest kind of mover — an inner join silently drops them.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, beginTenantConnection } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { analyticsService } from "../services/analytics.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[analytics-decomposition] no real DATABASE_URL — skipping.");

const SLUG = "m19-decomp";
const EMAIL = "m19-decomp@test.local";

const CUR = { from: "2026-06-01", to: "2026-06-30" };
const PRIOR = { from: "2026-05-01", to: "2026-05-31" };

describeMaybe("M19.2 — decomposition", () => {
  let orgId = "";
  let companyId = "";
  let userId = 0;
  let invNo = 0;

  async function inTenant<T>(fn: () => Promise<T>): Promise<T> {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
    try {
      const out = await conn.run(() =>
        auditContext.run({ userId, organizationId: orgId, ipAddress: null }, fn),
      );
      await conn.commit();
      return out;
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  }

  async function customer(name: string): Promise<number> {
    const { rows } = await pool.query(
      `INSERT INTO customers (organization_id, name) VALUES ($1,$2) RETURNING id`,
      [orgId, name],
    );
    return Number(rows[0].id);
  }

  /**
   * Returns the new id, because a credit note must reference its original —
   * `invoices_note_reference_chk` enforces it (M12.1b) — AND a note_reason, so
   * a note can never exist without saying why. A fixture that skipped either
   * would be testing a document the platform cannot actually produce.
   */
  async function invoice(
    customerId: number,
    date: string,
    total: number,
    documentType = "invoice",
    originalInvoiceId: number | null = null,
  ): Promise<number> {
    invNo += 1;
    const { rows } = await pool.query(
      `INSERT INTO invoices (organization_id, company_id, invoice_number, date, customer_id,
                             subtotal, vat_amount, total, status, document_type, original_invoice_id, note_reason)
       VALUES ($1,$2,$3,$4,$5,$6,0,$6,'sent',$7,$8,$9) RETURNING id`,
      [orgId, companyId, `DC-${invNo}`, date, customerId, String(total), documentType, originalInvoiceId,
       documentType === 'invoice' ? null : 'goods returned'],
    );
    return Number(rows[0].id);
  }

  const cleanup = async () => {
    const O = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
    const U = `(SELECT id FROM users WHERE email = '${EMAIL}')`;
    await pool.query(`DELETE FROM invoices WHERE organization_id IN ${O}`);
    await pool.query(`DELETE FROM transactions WHERE organization_id IN ${O}`);
    await pool.query(`DELETE FROM customers WHERE organization_id IN ${O}`);
    await pool.query(`DELETE FROM audit_logs WHERE organization_id IN ${O} OR user_id IN ${U}`);
    await pool.query(`DELETE FROM organization_memberships WHERE user_id IN ${U} OR organization_id IN ${O}`);
    await pool.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
    await pool.query(`DELETE FROM categories WHERE organization_id IN ${O}`);
    await pool.query(`DELETE FROM companies WHERE organization_id IN ${O}`);
    await pool.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Decomp Org','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (
      await pool.query(
        `INSERT INTO companies (organization_id, name, cr_number) VALUES ($1,'DC Co','1010101024') RETURNING id`,
        [orgId],
      )
    ).rows[0].id;
    userId = (
      await pool.query(
        `INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','DC',' ','viewer',true) RETURNING id`,
      )
    ).rows[0].id;
    await pool.query(
      `INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`,
      [userId, orgId],
    );
  });

  afterAll(cleanup);

  it("ranks contributors by the size of their change, and reports the share", async () => {
    const big = await customer("Big Client");
    const small = await customer("Small Client");
    await invoice(big, "2026-05-10", 100000);
    await invoice(small, "2026-05-12", 10000);
    await invoice(big, "2026-06-10", 60000); // −40,000
    await invoice(small, "2026-06-12", 5000); // −5,000

    const d = await inTenant(() =>
      analyticsService.decompose("customer", CUR.from, CUR.to, PRIOR),
    );

    expect(d.change).toBeCloseTo(-45000, 2);
    expect(d.contributors[0]!.name).toBe("Big Client");
    expect(d.contributors[0]!.change).toBeCloseTo(-40000, 2);
    // 40,000 of a 45,000 fall.
    expect(d.contributors[0]!.shareOfChange).toBeCloseTo(40000 / 45000, 2);
    // One name covers ≥80% of the movement.
    expect(d.concentration).toEqual({ count: 1, share: expect.closeTo(40000 / 45000, 2) });
  });

  it("🔴 the prior window defaults to the equal-length period immediately before", async () => {
    // Derived, not guessed at from intent. June 1–30 ⇒ May 2–31 (30 days).
    const d = await inTenant(() => analyticsService.decompose("customer", CUR.from, CUR.to));
    expect(d.prior.to).toBe("2026-05-31");
    expect(d.prior.from).toBe("2026-05-02");
  });

  it("🔴 ARRIVALS AND DEPARTURES are the biggest movers — never dropped by a join", async () => {
    await pool.query(`DELETE FROM invoices WHERE organization_id = $1`, [orgId]);
    const leaving = await customer("Left Us");
    const arriving = await customer("Just Arrived");
    await invoice(leaving, "2026-05-15", 30000); // present only in prior
    await invoice(arriving, "2026-06-15", 20000); // present only in current

    const d = await inTenant(() =>
      analyticsService.decompose("customer", CUR.from, CUR.to, PRIOR),
    );

    const byName = Object.fromEntries(d.contributors.map((c) => [c.name, c]));
    expect(byName["Left Us"]).toBeDefined();
    expect(byName["Left Us"]!.current).toBe(0);
    expect(byName["Left Us"]!.change).toBeCloseTo(-30000, 2);
    expect(byName["Just Arrived"]).toBeDefined();
    expect(byName["Just Arrived"]!.prior).toBe(0);
    expect(byName["Just Arrived"]!.change).toBeCloseTo(20000, 2);
  });

  it("🔴 OFFSETTING MOVEMENTS: net zero ⇒ share is NULL, but the movers are still listed", async () => {
    await pool.query(`DELETE FROM invoices WHERE organization_id = $1`, [orgId]);
    const up = await customer("Grew");
    const down = await customer("Shrank");
    await invoice(up, "2026-05-05", 10000);
    await invoice(down, "2026-05-06", 60000);
    await invoice(up, "2026-06-05", 60000); // +50,000
    await invoice(down, "2026-06-06", 10000); // −50,000

    const d = await inTenant(() =>
      analyticsService.decompose("customer", CUR.from, CUR.to, PRIOR),
    );

    expect(d.change).toBeCloseTo(0, 2);
    // 🔴 Undefined, not Infinity and not 0 — "50k of nothing" is not a share.
    expect(d.contributors.every((c) => c.shareOfChange === null)).toBe(true);
    // …and the two real movements are still reported and ranked.
    expect(d.contributors).toHaveLength(2);
    expect(Math.abs(d.contributors[0]!.change)).toBeCloseTo(50000, 2);
    // Concentration uses ABSOLUTE movement, so it still answers the question.
    expect(d.concentration!.count).toBeGreaterThanOrEqual(1);
  });

  it("🔴 a credit note SUBTRACTS — a credited customer is not their biggest month", async () => {
    await pool.query(`DELETE FROM invoices WHERE organization_id = $1`, [orgId]);
    const c = await customer("Credited Co");
    const original = await invoice(c, "2026-06-10", 50000);
    await invoice(c, "2026-06-20", 20000, "credit_note", original);

    const d = await inTenant(() =>
      analyticsService.decompose("customer", CUR.from, CUR.to, PRIOR),
    );
    // 50,000 − 20,000, not 70,000: the M12.1b sign discipline survives grouping.
    expect(d.current.total).toBeCloseTo(30000, 2);
  });

  it("drafts are excluded — they are not in the books", async () => {
    await pool.query(`DELETE FROM invoices WHERE organization_id = $1`, [orgId]);
    const c = await customer("Draft Co");
    await invoice(c, "2026-06-10", 1000);
    invNo += 1;
    await pool.query(
      `INSERT INTO invoices (organization_id, company_id, invoice_number, date, customer_id,
                             subtotal, vat_amount, total, status, document_type)
       VALUES ($1,$2,$3,'2026-06-11',$4,'99999',0,'99999','draft','invoice')`,
      [orgId, companyId, `DC-${invNo}`, c],
    );

    const d = await inTenant(() =>
      analyticsService.decompose("customer", CUR.from, CUR.to, PRIOR),
    );
    expect(d.current.total).toBeCloseTo(1000, 2);
  });

  it("an unchanged period reports no contributors and no concentration", async () => {
    await pool.query(`DELETE FROM invoices WHERE organization_id = $1`, [orgId]);
    const d = await inTenant(() =>
      analyticsService.decompose("customer", CUR.from, CUR.to, PRIOR),
    );
    expect(d.change).toBe(0);
    expect(d.contributors).toEqual([]);
    expect(d.concentration).toBeNull();
  });
});

/**
 * M19.3 — the edge validates, so a malformed period is an ERROR not an empty
 * chart. An empty chart reads as "your business had no activity", which is a
 * false statement about the tenant rather than about the request.
 */
describe("M19.3 — the analytics endpoints validate their periods", () => {
  it("rejects a malformed trend period rather than returning nothing", async () => {
    const { analyticsController } = await import("../controllers/analytics.controller");
    const res = { json: () => undefined } as never;
    for (const q of [{ from: "2026", to: "2026-06" }, { from: "2026-06", to: "june" }, {}]) {
      await expect(
        analyticsController.trend({ query: q } as never, res),
      ).rejects.toThrow(/YYYY-MM/);
    }
  });

  it("rejects a reversed window", async () => {
    const { analyticsController } = await import("../controllers/analytics.controller");
    await expect(
      analyticsController.trend({ query: { from: "2026-09", to: "2026-03" } } as never, {} as never),
    ).rejects.toThrow(/must not be after/);
  });

  it("rejects an unknown dimension", async () => {
    const { analyticsController } = await import("../controllers/analytics.controller");
    await expect(
      analyticsController.decomposition(
        { query: { dimension: "product", from: "2026-06-01", to: "2026-06-30" } } as never,
        {} as never,
      ),
    ).rejects.toThrow(/category, customer or vendor/);
  });
});
