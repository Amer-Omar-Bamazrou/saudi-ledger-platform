/**
 * DEPRECIATION ROUNDS ONE ADDEND — purchase cost = book value + accumulated, every month.
 *
 * 🔴 WHY THIS EXISTS (2026-09-15, second-opinion review item 1): `depreciate()`
 * divided cost by months (not a 2-dp number) and stored three values rounded
 * INDEPENDENTLY — `amount.toFixed(2)`, `(book - amount).toFixed(2)`,
 * `(acc + amount).toFixed(2)`. At a half-cent the three round in different
 * directions: 12.06 over 12 months is 1.005 a month; `(1.005).toFixed(2)` is
 * "1.00" (the double is 1.00499…), `(12.06 - 1.005).toFixed(2)` is "11.05" —
 * so after month one the asset read 11.05 + 1.00 = 12.05 for a 12.06 purchase.
 * A halala that no report would reconcile. The fix rounds the addend once and
 * derives the other two from it, so the identity holds by construction.
 *
 * The case is the exact tie, chosen so it FAILED before the fix (asserted red
 * first); a "nice" cost like 1000/36 rounds complementarily and proves nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { assetsService } from "../services/assets.service";

const connectionString = process.env.DATABASE_URL;
const describeMaybe = connectionString ? describe : describe.skip;
const SLUG = "asset-round";

describeMaybe("depreciation — cost = book + accumulated on the STORED values, every month", () => {
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
    await pool.query(`DELETE FROM depreciation_entries WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM fixed_assets WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM audit_logs WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM companies WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM categories WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Asset Round Org','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (
      await pool.query(
        `INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'AR Co','1010101089','399999999999993') RETURNING id`,
        [orgId],
      )
    ).rows[0].id;
  });
  afterAll(cleanup);

  it("🔴 the half-cent tie (12.06 over 12 months = 1.005): the identity holds after EVERY month until fully depreciated", async () => {
    const asset = await inTenant(() =>
      assetsService.create({ assetNumber: "FA-TIE", name: "Tie", purchaseDate: "2026-01-01", purchaseCost: 12.06, usefulLifeYears: 1, salvageValue: 0 }),
    );
    for (let m = 1; m <= 13; m++) {
      const period = `2026-${String(m).padStart(2, "0")}`.replace("2026-13", "2027-01");
      try {
        await inTenant(() => assetsService.depreciate(asset.id, period));
      } catch (err) {
        // The only permitted stop: the asset reached salvage and is no longer
        // active (the service says "not active" once status flipped, or
        // "fully depreciated" if it is asked again with nothing left).
        expect(String((err as Error).message)).toMatch(/fully depreciated|not active/);
        break;
      }
      const { rows } = await pool.query(
        `SELECT purchase_cost, current_book_value, accumulated_depreciation FROM fixed_assets WHERE id = $1`,
        [asset.id],
      );
      const r = rows[0];
      const identity = Math.round((Number(r.current_book_value) + Number(r.accumulated_depreciation)) * 100) / 100;
      expect(identity, `month ${m}: book ${r.current_book_value} + accumulated ${r.accumulated_depreciation} must equal cost ${r.purchase_cost}`).toBe(Number(r.purchase_cost));
    }
    const final = (await pool.query(`SELECT current_book_value, accumulated_depreciation, status FROM fixed_assets WHERE id = $1`, [asset.id])).rows[0];
    expect(final.accumulated_depreciation).toBe("12.06");
    expect(final.current_book_value).toBe("0.00");
    expect(final.status).toBe("fully-depreciated");
    // And every history row's own pair is consistent with the amount it recorded.
    const hist = await pool.query(`SELECT amount, book_value_after FROM depreciation_entries WHERE asset_id = $1 ORDER BY id`, [asset.id]);
    let running = 12.06;
    for (const h of hist.rows) {
      running = Math.round((running - Number(h.amount)) * 100) / 100;
      expect(Number(h.book_value_after)).toBe(running);
    }
  });
});
