/**
 * 🔴 A BANK ROW CANNOT BE CATEGORISED TO A CONTROL ACCOUNT — REFUSED AT THE
 * WRITE BOUNDARY, AS A 422 (2026-09-16, the pre-pilot sanity walk).
 *
 * Before: the edit picker on /transactions offered every chart account.
 * Choosing Accounts Receivable for "STC PAYMENT" (or, the natural case,
 * for "CUSTOMER DEPOSIT — NAJD") reached `repost`, which reversed the
 * Suspense entry and asked the posting seam for a party-less AR line; the
 * seam refused — correctly, with `MissingPartyError`, status 500 and a
 * message written for a developer ("pass `party` on the GLLine"). The
 * tenant transaction rolled the reversal back, so the books stayed right,
 * but the accountant saw "Error — failed to update the transaction" from
 * an ordinary control.
 *
 * After: `assertCategoryExists` — the one guard every writer of
 * `category_id` passes (create, update, upload) — refuses a party-required
 * account with 422 `category_needs_party` and a sentence naming the
 * workflow (settle from Review). The web picker no longer offers them. The
 * set is ONE definition, `PARTY_REQUIRED_SYSTEM_CODES` in @workspace/shared,
 * shared with the posting seam.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { PARTY_REQUIRED_SYSTEM_CODES } from "@workspace/shared";
import { auditContext } from "../lib/auditContext";
import { transactionsService } from "../services/transactions.service";
import { BusinessRuleError } from "../lib/errors";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const SLUG = "txn-control-account";
const EMAIL = "txn-control-account@test.local";

describeMaybe("a bank transaction cannot be categorised to a party-required control account", () => {
  let orgId = "";
  let companyId = "";
  let userId = 0;
  let arId = 0;
  let apId = 0;
  let rentId = 0;

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
    for (const t of ["journal_entry_lines", "journal_entries", "transactions", "audit_logs", "organization_memberships", "categories", "companies"]) {
      await pool.query(`DELETE FROM ${t} WHERE organization_id IN ${org}`);
    }
    await pool.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
    await pool.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Control Account Org','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (await pool.query(`INSERT INTO companies (organization_id, name) VALUES ($1,'CA Co') RETURNING id`, [orgId])).rows[0].id;
    userId = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','CA',' ','admin',true) RETURNING id`)).rows[0].id;
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, orgId]);
    const cat = async (code: string) => (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = $2`, [orgId, code])).rows[0].id;
    arId = await cat("AR");
    apId = await cat("AP");
    rentId = await cat("RENT_UTILITIES");
  });
  afterAll(cleanup);

  const state = async (id: number) =>
    (await pool.query(
      `SELECT t.category_id, t.is_manually_overridden, t.journal_entry_id,
              (SELECT json_agg(json_build_object('n', je.entry_number, 's', je.status) ORDER BY je.id)
                 FROM journal_entries je WHERE je.reference = 'TXN-' || t.id) AS entries
         FROM transactions t WHERE t.id = $1`,
      [id],
    )).rows[0];

  it("the set is one definition and holds the receivable and payable control accounts", () => {
    expect([...PARTY_REQUIRED_SYSTEM_CODES]).toEqual(["AR", "AP"]);
  });

  it("🔴 UPDATE to Accounts Receivable is a 422 naming the workflow — the row, its link and its Suspense entry are untouched", async () => {
    const tx = await inTenant(() =>
      transactionsService.create({ date: "2026-05-05", description: "CUSTOMER DEPOSIT — NAJD", amount: 12000, currency: "SAR", type: "credit" }),
    );
    const before = await state(tx.id);
    expect(before.journal_entry_id, "the row posted to Suspense on creation").not.toBeNull();

    let caught: unknown;
    try {
      await inTenant(() => transactionsService.update(tx.id, { categoryId: arId }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BusinessRuleError);
    const e = caught as BusinessRuleError;
    expect(e.statusCode, "a user's mistake is a 422, never a 500").toBe(422);
    expect(e.payload).toMatchObject({ code: "category_needs_party", field: "categoryId" });
    expect(e.message).toMatch(/Accept & settle/);

    const after = await state(tx.id);
    expect(after).toEqual(before);
    expect(after.entries, "no reversal was written").toEqual([{ n: `TXN-${tx.id}`, s: "posted" }]);
  });

  it("🔴 UPDATE to Accounts Payable is refused the same way", async () => {
    const tx = await inTenant(() =>
      transactionsService.create({ date: "2026-05-06", description: "PAYMENT TO TAMIMI", amount: 400, currency: "SAR", type: "debit" }),
    );
    await expect(inTenant(() => transactionsService.update(tx.id, { categoryId: apId }))).rejects.toMatchObject({ statusCode: 422 });
    expect((await state(tx.id)).category_id).toBeNull();
  });

  it("🔴 CREATE with a control-account category is refused and inserts nothing", async () => {
    const n = async () => (await pool.query(`SELECT count(*)::int AS n FROM transactions WHERE organization_id = $1`, [orgId])).rows[0].n;
    const before = await n();
    await expect(
      inTenant(() => transactionsService.create({ date: "2026-05-07", description: "AR by create", amount: 10, currency: "SAR", type: "credit", categoryId: arId })),
    ).rejects.toMatchObject({ statusCode: 422 });
    expect(await n()).toBe(before);
  });

  it("🔴 UPLOAD: a row carrying a control-account category is reported by name and not imported; its sibling imports", async () => {
    const r = (await inTenant(() =>
      transactionsService.upload({
        rows: [
          { date: "2026-05-08", description: "UPLOAD TO AR", amount: 20, currency: "SAR", type: "credit", categoryId: arId },
          { date: "2026-05-08", description: "UPLOAD TO RENT", amount: 30, currency: "SAR", type: "debit", categoryId: rentId },
        ],
        autoCategrize: false,
      } as never),
    )) as { inserted: number; errors: string[] };
    expect(r.inserted).toBe(1);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatch(/UPLOAD TO AR/);
    expect(r.errors[0]).toMatch(/control account/);
  });

  it("MOVEMENT: an ordinary expense category still works — the row re-posts to it", async () => {
    const tx = await inTenant(() =>
      transactionsService.create({ date: "2026-05-09", description: "OFFICE RENT", amount: 3000, currency: "SAR", type: "debit" }),
    );
    await inTenant(() => transactionsService.update(tx.id, { categoryId: rentId }));
    const after = await state(tx.id);
    expect(after.category_id).toBe(rentId);
    expect(after.is_manually_overridden).toBe(true);
    expect(after.entries.map((e: { s: string }) => e.s)).toEqual(["reversed", "posted", "posted"]);
    const { rows: [line] } = await pool.query(
      `SELECT c.system_code FROM journal_entry_lines l JOIN categories c ON c.id = l.account_id
        WHERE l.journal_entry_id = $1 AND l.debit_amount > 0`,
      [after.journal_entry_id],
    );
    expect(line.system_code).toBe("RENT_UTILITIES");
  });
});
