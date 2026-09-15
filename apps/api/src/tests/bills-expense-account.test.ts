/**
 * THE BILL'S EXPENSE ACCOUNT IS RESOLVED BY ID, AND NEVER SILENTLY ELSEWHERE.
 *
 * 🔴 WHY THIS EXISTS (2026-09-15): the post path took an account NAME from the
 * client, matched it against the chart, and on a miss posted the line to
 * PURCHASES while storing the NAME THE USER CHOSE as the line's label. Only 3
 * of the 14 names the picker offered existed in the seeded chart; the other
 * 11 — the default included — posted to Purchases under a label that said
 * otherwise. Posts AND hides. The audit of existing rows is in the findings
 * file ("ACCOUNTS.TS, CLOSED"); this file is the guard:
 *
 *   - a NAME that resolves to nothing is REFUSED (the regression the owner
 *     asked for: a name-based lookup returning nothing must fail, not fall
 *     back);
 *   - an id resolves against the tenant's own chart and the line carries that
 *     account's REAL name;
 *   - an id that is not an expense account, or belongs to another org, is
 *     refused the same way;
 *   - with nothing supplied, the one default posts to PURCHASES under its real
 *     name — the label and the account cannot disagree.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { billsService } from "../services/bills.service";

const connectionString = process.env.DATABASE_URL;
const describeMaybe = connectionString ? describe : describe.skip;
const SLUG = "bill-expense-acct";
const SLUG_OTHER = "bill-expense-acct-other";
const DATE = "2026-09-10";

describeMaybe("bill posting — the expense account is resolved by id, refused when unresolved, never relabelled", () => {
  let orgId = "";
  let companyId = "";
  let vendorId = 0;
  let otherOrgId = "";
  let otherExpenseId = 0;
  let rentId = 0;
  let rentName = "";
  let cashId = 0;

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
    for (const slug of [SLUG, SLUG_OTHER]) {
      const O = `(SELECT id FROM organizations WHERE slug = '${slug}')`;
      for (const t of ["journal_entry_lines", "journal_entries", "bill_items", "bills", "document_numbers", "vendors", "audit_logs", "categories", "companies"]) {
        await pool.query(`DELETE FROM ${t} WHERE organization_id IN ${O}`).catch((e: Error) => {
          if (!/does not exist/.test(e.message)) throw e;
        });
      }
      await pool.query(`DELETE FROM organizations WHERE slug = '${slug}'`);
    }
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Bill Acct Org','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (await pool.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'BA Co','1010101097','399999999999993') RETURNING id`, [orgId])).rows[0].id;
    vendorId = (await pool.query(`INSERT INTO vendors (organization_id, name) VALUES ($1,'BA Vendor') RETURNING id`, [orgId])).rows[0].id;
    // The seeded chart (the org-seed trigger) is the chart the picker will offer.
    // "Rent & Utilities" — a seeded expense account that is NOT Purchases, so
    // a resolved id is distinguishable from the default.
    const rent = (await pool.query(`SELECT id, name FROM categories WHERE organization_id = $1 AND type = 'expense' AND system_code = 'RENT_UTILITIES' LIMIT 1`, [orgId])).rows[0];
    rentId = rent.id;
    rentName = rent.name;
    cashId = (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND type = 'asset' LIMIT 1`, [orgId])).rows[0].id;
    otherOrgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Other Org','${SLUG_OTHER}') RETURNING id`)).rows[0].id;
    otherExpenseId = (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND type = 'expense' LIMIT 1`, [otherOrgId])).rows[0].id;
  });
  afterAll(cleanup);

  const draft = () => billsService.create({ date: DATE, vendorId, subtotal: 400, vatAmount: 60, total: 460, items: [] }, null);
  const expenseLine = async (billNumber: string) =>
    (await pool.query(
      `SELECT l.account_id, l.account_name, c.name AS real_name, c.system_code
         FROM journal_entry_lines l JOIN journal_entries je ON je.id = l.journal_entry_id JOIN categories c ON c.id = l.account_id
        WHERE je.organization_id = $1 AND je.entry_number = $2 AND l.debit_amount > 0 AND c.type = 'expense'`,
      [orgId, `BILL-${billNumber}`],
    )).rows[0];

  it("🔴 REGRESSION: a NAME that resolves to nothing is refused — it used to post to Purchases under that name", async () => {
    const bill = await inTenant(draft);
    await expect(inTenant(() => billsService.post(bill.id, { debitAccount: "Rent Expense" }, null))).rejects.toMatchObject({
      statusCode: 422,
      payload: { code: "expense_account_unresolved" },
    });
    const after = await pool.query(`SELECT status FROM bills WHERE id = $1`, [bill.id]);
    expect(after.rows[0].status).toBe("draft");
    expect(await expenseLine(bill.billNumber)).toBeUndefined();
  });

  it("an ID resolves against the tenant's chart, and the line carries the account's REAL name", async () => {
    const bill = await inTenant(draft);
    await inTenant(() => billsService.post(bill.id, { debitAccountId: rentId }, null));
    const line = await expenseLine(bill.billNumber);
    expect(line.account_id).toBe(rentId);
    expect(line.account_name).toBe(rentName);
    expect(line.account_name).toBe(line.real_name);
  });

  it("a legacy NAME that does match resolves to that account — and the stored label is the account's name, not the request's casing", async () => {
    const bill = await inTenant(draft);
    await inTenant(() => billsService.post(bill.id, { debitAccount: rentName.toUpperCase() }, null));
    const line = await expenseLine(bill.billNumber);
    expect(line.account_id).toBe(rentId);
    expect(line.account_name).toBe(rentName);
  });

  it("🔴 an id that is not an EXPENSE account, or belongs to ANOTHER org, is the same refusal", async () => {
    for (const id of [cashId, otherExpenseId, 999999999]) {
      const bill = await inTenant(draft);
      await expect(inTenant(() => billsService.post(bill.id, { debitAccountId: id }, null))).rejects.toMatchObject({
        statusCode: 422,
        payload: { code: "expense_account_unresolved" },
      });
    }
  });

  it("🔴 TWO-PERSON FLOW: the account chosen at ENTRY survives submit → approve with NO body — it used to fall back to Purchases", async () => {
    const bill = await inTenant(() => billsService.create({ date: DATE, vendorId, subtotal: 400, vatAmount: 60, total: 460, items: [], expenseAccountId: rentId }, null));
    expect(bill.expenseAccountId).toBe(rentId);
    await inTenant(() => billsService.submit(bill.id, null));
    // The Approvals queue approves with an EMPTY body — exactly what the page sends.
    await inTenant(() => billsService.approve(bill.id, {}, null));
    const line = await expenseLine(bill.billNumber);
    expect(line.account_id).toBe(rentId);
    expect(line.account_name).toBe(rentName);
  });

  it("the body still WINS over the bill's own choice, and a non-expense account is refused at ENTRY", async () => {
    const bill = await inTenant(() => billsService.create({ date: DATE, vendorId, subtotal: 400, vatAmount: 60, total: 460, items: [], expenseAccountId: rentId }, null));
    const purchases = (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = 'PURCHASES'`, [orgId])).rows[0].id;
    await inTenant(() => billsService.post(bill.id, { debitAccountId: purchases }, null));
    expect((await expenseLine(bill.billNumber)).system_code).toBe("PURCHASES");
    await expect(
      inTenant(() => billsService.create({ date: DATE, vendorId, subtotal: 1, vatAmount: 0, total: 1, items: [], expenseAccountId: cashId }, null)),
    ).rejects.toMatchObject({ statusCode: 422, payload: { code: "expense_account_unresolved", field: "expenseAccountId" } });
  });

  it("with NOTHING supplied, the one default posts to PURCHASES under its real name — label = account", async () => {
    const bill = await inTenant(draft);
    await inTenant(() => billsService.post(bill.id, {}, null));
    const line = await expenseLine(bill.billNumber);
    expect(line.system_code).toBe("PURCHASES");
    expect(line.account_name).toBe(line.real_name);
    expect(line.account_name).not.toBe("Purchases and Cost of Sales");
  });
});
