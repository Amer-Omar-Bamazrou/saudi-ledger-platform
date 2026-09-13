/**
 * The sentinel-default family is DEAD (2026-09-14) — and cannot return.
 *
 * L1 killed `invoice_items.description_ar`'s "(not yet translated)" default
 * (migration 0067) and named the ~8 surviving columns a FAMILY for the same
 * treatment. This migration converts them all; this test is the standing
 * guard, checked mechanically against information_schema rather than a list
 * kept by hand:
 *
 *   1. NO column in the schema carries the sentinel as its default — any new
 *      column trying to reintroduce the pattern fails here by construction.
 *   2. The write boundary stores ABSENCE as NULL: an empty Arabic field on a
 *      create becomes NULL, never "" (the same stand-in typed instead of
 *      migrated) — proven through a real service write.
 *
 * The probe is validated (the unvalidated-probe rule): the same
 * information_schema query SEES a known-present default before it is trusted
 * to report an absence.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { customersService } from "../services/customers.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[sentinel-family] no real DATABASE_URL — skipping.");

const SLUG = "sentinel-family";

describeMaybe("the sentinel family — dead, and inexpressible to reintroduce", () => {
  let orgId = "";
  let companyId = "";

  async function inTenant<T>(fn: () => Promise<T>): Promise<T> {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
    try {
      const out = await conn.run(() => auditContext.run({ userId: null, organizationId: orgId, ipAddress: null }, fn));
      await conn.commit();
      return out;
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  }

  const cleanup = async () => {
    const org = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
    await pool.query(`DELETE FROM audit_logs WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM customers WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM companies WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM categories WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('SF Org','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (
      await pool.query(
        `INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'SF','1010101055','399999999999993') RETURNING id`,
        [orgId],
      )
    ).rows[0].id;
  });

  afterAll(cleanup);

  it("🔴 NO column in the schema defaults to the sentinel — checked against information_schema, not a hand list", async () => {
    // Validate the probe first: the same query sees a known-present default.
    const known = await pool.query(
      `SELECT column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'invoice_items' AND column_name = 'quantity'`,
    );
    expect(known.rows[0]?.column_default).toContain("1");

    const { rows } = await pool.query(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_default LIKE '%not yet translated%'`,
    );
    expect(rows).toEqual([]);
  });

  it("🔴 the nine family columns are nullable — absence is storable as absence", async () => {
    const { rows } = await pool.query(
      `SELECT table_name, column_name, is_nullable FROM information_schema.columns
        WHERE table_schema = 'public'
          AND (table_name, column_name) IN (
            ('customers','name_ar'), ('vendors','name_ar'), ('products','name_ar'),
            ('employees','name_ar'), ('employees','job_title_ar'), ('fixed_assets','name_ar'),
            ('budgets','name_ar'), ('quotation_items','description_ar'), ('purchase_order_items','description_ar')
          )`,
    );
    expect(rows).toHaveLength(9);
    for (const r of rows) expect(r.is_nullable, `${r.table_name}.${r.column_name}`).toBe("YES");
  });

  it("🔴 the write boundary stores '' as NULL — the stand-in cannot be typed back in", async () => {
    const created = await inTenant(() => customersService.create({ name: "SF Client", nameAr: "" } as never, null));
    const { rows } = await pool.query(`SELECT name_ar FROM customers WHERE id = $1`, [(created as { id: number }).id]);
    expect(rows[0].name_ar).toBeNull();
    // Movement: real Arabic persists as itself.
    const withAr = await inTenant(() => customersService.create({ name: "SF Client 2", nameAr: "عميل" } as never, null));
    const r2 = await pool.query(`SELECT name_ar FROM customers WHERE id = $1`, [(withAr as { id: number }).id]);
    expect(r2.rows[0].name_ar).toBe("عميل");
  });
});
