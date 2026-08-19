/**
 * C9 — Art. 50-blocked input VAT (the FOOD_MEALS correction).
 *
 * The live wrong default this pins closed: the engine counted meal VAT as
 * recoverable input VAT, while VAT Implementing Regulations Art. 50(1)(b)
 * forbids deducting it. The design: `input_vat_blocked` is a THIRD axis —
 * the receipt still shows VAT (treatment 'S' is right), the buyer still
 * paid it (basis 'charged' is right), and the recoverable estimate must
 * still exclude it. The excluded amount is RETURNED as `vatBlocked`, never
 * silently dropped.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { transactionsService } from "../services/transactions.service";
import { summaryService } from "../services/summary.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[vat-blocked-input] no real DATABASE_URL — skipping.");

const SLUG = "c9-blocked";
const EMAIL = "c9-blocked@test.local";
const RANGE = { dateFrom: "2026-06-01", dateTo: "2026-06-30" };

describeMaybe("C9 — blocked input VAT is a cost, not a claim", () => {
  let orgId = "";
  let companyId = "";
  let userId = 0;

  async function inTenant<T>(fn: () => Promise<T>): Promise<T> {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
    try {
      const out = await conn.run(() => auditContext.run({ userId, organizationId: orgId, ipAddress: null }, fn));
      await conn.commit();
      return out;
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  }

  const cleanup = async () => {
    const org = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
    const usr = `(SELECT id FROM users WHERE email = '${EMAIL}')`;
    for (const t of ["transactions", "journal_entry_lines", "journal_entries", "categories"]) {
      await pool.query(`DELETE FROM ${t} WHERE organization_id IN ${org}`);
    }
    await pool.query(`DELETE FROM audit_logs WHERE organization_id IN ${org} OR user_id IN ${usr}`);
    await pool.query(`DELETE FROM organization_memberships WHERE user_id IN ${usr} OR organization_id IN ${org}`);
    await pool.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
    await pool.query(`DELETE FROM companies WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('C9 Org','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (
      await pool.query(
        `INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'C9','1010101023','399999999999993') RETURNING id`,
        [orgId],
      )
    ).rows[0].id;
    userId = (
      await pool.query(
        `INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','C9',' ','viewer',true) RETURNING id`,
      )
    ).rows[0].id;
    await pool.query(
      `INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`,
      [userId, orgId],
    );
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it("🔴 the seeded chart carries the Art. 50 flag — FOOD_MEALS blocked, TELECOM not", async () => {
    // Seeded by the org-creation trigger; if the trigger ever stops copying
    // the column, every NEW tenant silently un-blocks meals — the 0041 shape.
    const { rows } = await pool.query(
      `SELECT system_code, input_vat_blocked, treatment_verified FROM categories
        WHERE organization_id = $1 AND system_code IN ('FOOD_MEALS','TELECOM') ORDER BY system_code`,
      [orgId],
    );
    expect(rows).toEqual([
      expect.objectContaining({ system_code: "FOOD_MEALS", input_vat_blocked: true, treatment_verified: true }),
      expect.objectContaining({ system_code: "TELECOM", input_vat_blocked: false, treatment_verified: true }),
    ]);
  });

  it("🔴 meal VAT is excluded from the recoverable estimate AND returned as a named figure", async () => {
    // Through the real write path: upload + auto-categorize. The engine
    // still EXTRACTS the VAT (the receipt fact) — the correction is at the
    // read: vatPaid excludes it, vatBlocked names it.
    await inTenant(() =>
      transactionsService.upload({
        rows: [
          { date: "2026-06-10", description: "AL BAIK RESTAURANT RIYADH", amount: 115, currency: "SAR", type: "debit" },
          { date: "2026-06-12", description: "SADAD PAYMENT - STC 0100", amount: 230, currency: "SAR", type: "debit" },
        ],
        autoCategrize: true,
      } as never),
    );
    const ids = (
      await pool.query(`SELECT id FROM transactions WHERE organization_id = $1 ORDER BY id`, [orgId])
    ).rows.map((r: { id: number }) => Number(r.id));
    await inTenant(() => transactionsService.acceptPending(ids));

    // Both rows carry extracted VAT (S, charged) — the fact is stored.
    const { rows: stored } = await pool.query(
      `SELECT c.system_code, t.vat_amount::numeric AS vat FROM transactions t
         JOIN categories c ON c.id = t.category_id WHERE t.organization_id = $1 ORDER BY t.id`,
      [orgId],
    );
    expect(stored).toEqual([
      expect.objectContaining({ system_code: "FOOD_MEALS", vat: "15.00" }),
      expect.objectContaining({ system_code: "TELECOM", vat: "30.00" }),
    ]);

    const vat = await inTenant(() => summaryService.getVat(RANGE));
    expect(vat.vatPaid, "recoverable estimate excludes the meal VAT").toBe(30);
    expect(vat.vatBlocked, "the excluded amount is NAMED, not dropped").toBe(15);
    // The transaction list still shows the meal row's VAT — the receipt fact.
    expect(vat.transactions).toHaveLength(2);

    const summary = await inTenant(() => summaryService.getSummary(RANGE));
    expect((summary as { totalVatPaid: number }).totalVatPaid, "the dashboard figure agrees").toBe(30);
  });
});
