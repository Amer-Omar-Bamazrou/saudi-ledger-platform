/**
 * 🔴 L4 (owner, 2026-11-25) — VAT ON AN OUT-OF-SCOPE ACCOUNT.
 *
 * A statutory fee, a GOSI contribution, a salary are not supplies: the expense accounts whose own treatment is
 * out of scope (`categories.default_tax_treatment = 'O'`, on an EXPENSE account — the one definition) carry no VAT by
 * default. A bill could nevertheless claim 15 % input VAT on GOVT_FEES (finding, 2026-11-24). Now:
 *  - VAT defaults to 0 on such an account (a line without a rate);
 *  - VAT above 0 there needs a STATED commercial supply with a reason — refused at entry, at edit and at approval
 *    without one, by name, in both languages; who stated it and when are kept;
 *  - the claim still needs a valid tax invoice: the Phase 13A evidence verdict (the one definition) decides whether the
 *    VAT is claimed or held;
 *  - the evidence verdict warns at entry (the form's preview) and in review (the stored verdict).
 * A credit note reduces a claim and is never refused for it. Nothing here touches an existing posted bill.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { billsService } from "../services/bills.service";
import { purgeInputVatLedger } from "./helpers/purgeInputVatLedger";
import { releasePostedJournalsForTeardown } from "./helpers/journalFixtures";
import { deleterFor } from "./helpers/replica";

const connectionString = process.env.DATABASE_URL;
const describeMaybe = connectionString ? describe : describe.skip;
const SLUG = "l4-out-of-scope-vat";
const EMAIL = "l4-oos@test.local";
const DATE = "2026-09-10";
const REASON = "The chamber of commerce sold us printed certificates — a commercial supply, VAT charged on its tax invoice";

describeMaybe("L4 — VAT on an out-of-scope account needs a stated commercial supply", () => {
  let orgId = "";
  let companyId = "";
  let vendorId = 0;
  let userId = 0;
  let govtFeesId = 0;
  let gosiId = 0;
  let tenantOosId = 0;
  let purchasesId = 0;

  async function inTenant<T>(fn: () => Promise<T>): Promise<T> {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated", actorUserId: userId });
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
    await purgeInputVatLedger(`SELECT id FROM organizations WHERE slug = '${SLUG}'`);
    const O = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
    await releasePostedJournalsForTeardown(`organization_id IN ${O}`);
    for (const t of ["journal_entry_lines", "journal_entries", "bill_items", "bills", "document_numbers", "vendors", "audit_logs", "categories", "organization_memberships", "companies"]) {
      await deleterFor(pool, t).query(`DELETE FROM ${t} WHERE organization_id IN ${O}`).catch((e: Error) => {
        if (!/does not exist/.test(e.message)) throw e;
      });
    }
    await deleterFor(pool, "audit_logs").query(`DELETE FROM audit_logs WHERE user_id IN (SELECT id FROM users WHERE email = '${EMAIL}')`);
    await pool.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
    await pool.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
  };

  const account = async (code: string) =>
    (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = $2`, [orgId, code])).rows[0].id as number;

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('L4 Org','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (await pool.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'L4 Co','1010101098','399999999999993') RETURNING id`, [orgId])).rows[0].id;
    userId = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','L4',' ','viewer',true) RETURNING id`)).rows[0].id;
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, orgId]);
    vendorId = (await pool.query(`INSERT INTO vendors (organization_id, name, tax_number) VALUES ($1,'L4 Vendor','300000000000003') RETURNING id`, [orgId])).rows[0].id;
    govtFeesId = await account("GOVT_FEES");
    gosiId = await account("GOSI_EXPENSE");
    purchasesId = await account("PURCHASES");
    // A tenant's OWN account marked out of scope — "any other out-of-scope category" is the account's treatment, not a list of codes.
    tenantOosId = (await pool.query(
      `INSERT INTO categories (organization_id, name, name_ar, type, default_tax_treatment) VALUES ($1,'Municipality permits','رسوم البلدية','expense','O') RETURNING id`,
      [orgId],
    )).rows[0].id;
  });
  afterAll(cleanup);

  const header = (expenseAccountId: number, extra: Record<string, unknown> = {}) => ({
    supplierDocumentKind: "tax_invoice", vendorReference: `SUP-${Math.random().toString(36).slice(2, 8)}`, date: DATE, vendorId,
    subtotal: 500, vatAmount: 75, total: 575, items: [], expenseAccountId, ...extra,
  });
  const billRow = async (id: number) => (await pool.query(`SELECT * FROM bills WHERE id = $1`, [id])).rows[0];
  const billCount = async () => Number((await pool.query(`SELECT count(*) FROM bills WHERE organization_id = $1`, [orgId])).rows[0].count);
  const vatInputLine = async (billNumber: string) =>
    (await pool.query(
      `SELECT l.debit_amount FROM journal_entry_lines l JOIN journal_entries je ON je.id = l.journal_entry_id JOIN categories c ON c.id = l.account_id
        WHERE je.organization_id = $1 AND je.entry_number = $2 AND c.system_code = 'VAT_INPUT'`,
      [orgId, `BILL-${billNumber}`],
    )).rows[0];

  it("🔴 a line WITHOUT a rate carries 0 VAT on an out-of-scope account — and still 15 % on Purchases (the default moved only there)", async () => {
    const item = { description: "Commercial registration renewal", quantity: 1, unitPrice: 500 };
    const oos = await inTenant(() => billsService.create({ ...header(govtFeesId), subtotal: undefined, vatAmount: undefined, total: undefined, items: [item] }, userId));
    expect(Number(oos.vatAmount)).toBe(0);
    expect(Number(oos.total)).toBe(500);
    const normal = await inTenant(() => billsService.create({ ...header(purchasesId), subtotal: undefined, vatAmount: undefined, total: undefined, items: [item] }, userId));
    expect(Number(normal.vatAmount)).toBe(75);
  });

  it("🔴 VAT on GOVT_FEES, GOSI and a tenant's own out-of-scope account WITHOUT a stated commercial supply is refused at entry, by name, in both languages — nothing is written", async () => {
    for (const id of [govtFeesId, gosiId, tenantOosId]) {
      const before = await billCount();
      await expect(inTenant(() => billsService.create(header(id), userId))).rejects.toMatchObject({
        statusCode: 422,
        payload: { code: "out_of_scope_vat_unstated", field: "commercialSupplyReason", errorAr: expect.stringContaining("خارج نطاق") },
      });
      expect(await billCount()).toBe(before);
    }
    // a blank reason is no statement
    await expect(inTenant(() => billsService.create(header(govtFeesId, { commercialSupplyReason: "   " }), userId))).rejects.toMatchObject({
      statusCode: 422, payload: { code: "out_of_scope_vat_unstated" },
    });
  });

  it("🔴 with a stated commercial supply the VAT is accepted: the reason, who and when are kept; review warns; the VAT is claimed on a valid tax invoice", async () => {
    const bill = await inTenant(() => billsService.create(header(govtFeesId, { commercialSupplyReason: `  ${REASON}  ` }), userId));
    expect(bill.commercialSupplyReason).toBe(REASON);
    const row = await billRow(bill.id);
    expect(row.commercial_supply_reason).toBe(REASON);
    expect(row.commercial_supply_stated_by).toBe(userId);
    expect(row.commercial_supply_stated_at).not.toBeNull();
    // review: the stored verdict carries the warning (never silently claimed)
    expect(bill.vatEvidence.flags).toEqual(expect.arrayContaining([expect.objectContaining({ code: "out_of_scope_account_commercial_supply", severity: "warning" })]));
    expect(bill.vatEvidence.status).toBe("evidenced");
    const posted = await inTenant(() => billsService.post(bill.id, {}, userId));
    expect(posted.inputVat?.state).toBe("claimed");
    expect(Number((await vatInputLine(bill.billNumber)).debit_amount)).toBe(75);
  });

  it("a stated supply WITHOUT a tax invoice does not claim: the VAT is held for evidence (the 13A verdict, unchanged)", async () => {
    const bill = await inTenant(() => billsService.create(header(govtFeesId, { commercialSupplyReason: REASON, supplierDocumentKind: "no_tax_invoice" }), userId));
    const posted = await inTenant(() => billsService.post(bill.id, {}, userId));
    expect(posted.inputVat?.state).toBe("awaiting_evidence");
    expect(await vatInputLine(bill.billNumber)).toBeUndefined();
  });

  it("🔴 edit: moving a VAT-bearing draft onto an out-of-scope account without a reason is refused; the draft is unchanged", async () => {
    const bill = await inTenant(() => billsService.create(header(purchasesId), userId));
    await expect(inTenant(() => billsService.update(bill.id, { expenseAccountId: govtFeesId }))).rejects.toMatchObject({
      statusCode: 422, payload: { code: "out_of_scope_vat_unstated" },
    });
    expect((await billRow(bill.id)).expense_account_id).toBe(purchasesId);
    // stating it on the edit is accepted, and recorded
    const edited = await inTenant(() => billsService.update(bill.id, { expenseAccountId: govtFeesId, commercialSupplyReason: REASON }));
    expect(edited.expenseAccountId).toBe(govtFeesId);
    expect((await billRow(bill.id)).commercial_supply_reason).toBe(REASON);
  });

  it("🔴 approval: an out-of-scope account named AT APPROVAL for a VAT bill with no reason is refused; nothing posts", async () => {
    const bill = await inTenant(() => billsService.create(header(purchasesId), userId));
    await expect(inTenant(() => billsService.post(bill.id, { debitAccountId: govtFeesId }, userId))).rejects.toMatchObject({
      statusCode: 422, payload: { code: "out_of_scope_vat_unstated" },
    });
    expect((await billRow(bill.id)).status).toBe("draft");
    expect(await vatInputLine(bill.billNumber)).toBeUndefined();
  });

  it("🔴 a draft written BEFORE this rule (VAT on GOVT_FEES, no reason) is not rewritten — its approval is refused, the row unchanged", async () => {
    const bill = await inTenant(() => billsService.create(header(purchasesId), userId));
    await pool.query(`UPDATE bills SET expense_account_id = $1 WHERE id = $2`, [govtFeesId, bill.id]); // as the old code allowed
    const before = await billRow(bill.id);
    await expect(inTenant(() => billsService.post(bill.id, {}, userId))).rejects.toMatchObject({
      statusCode: 422, payload: { code: "out_of_scope_vat_unstated" },
    });
    const after = await billRow(bill.id);
    expect(after.status).toBe("draft");
    expect(after.vat_amount).toBe(before.vat_amount);
    expect(after.expense_account_id).toBe(govtFeesId);
  });

  it("a credit note on an out-of-scope account reduces a claim and is never refused for it", async () => {
    const original = await inTenant(() => billsService.create(header(govtFeesId, { commercialSupplyReason: REASON }), userId));
    await inTenant(() => billsService.post(original.id, {}, userId));
    const note = await inTenant(() => billsService.create({
      documentType: "credit_note", creditNoteAgainstBillId: original.id, vendorReference: "CN-L4-1", date: DATE,
      subtotal: 100, vatAmount: 15, total: 115, items: [], expenseAccountId: govtFeesId,
    }, userId));
    expect(Number(note.vatAmount)).toBe(15);
  });

  it("🔴 warn at entry — the form's preview: an out-of-scope account says VAT is 0; VAT there without a reason is held; with one, a warning", async () => {
    const base = { supplierDocumentKind: "tax_invoice", vendorId, vendorReference: "SUP-PREVIEW", date: DATE, expenseAccountId: govtFeesId };
    const zero = await inTenant(() => billsService.evidencePreview({ ...base, subtotal: 500, vatAmount: 0, total: 500 }));
    expect(zero.flags).toEqual([expect.objectContaining({ code: "out_of_scope_account", severity: "info" })]);
    const unstated = await inTenant(() => billsService.evidencePreview({ ...base, subtotal: 500, vatAmount: 75, total: 575 }));
    expect(unstated.status).toBe("awaiting_evidence");
    expect(unstated.flags).toEqual(expect.arrayContaining([expect.objectContaining({ code: "out_of_scope_account_vat_unstated", severity: "blocking" })]));
    const stated = await inTenant(() => billsService.evidencePreview({ ...base, subtotal: 500, vatAmount: 75, total: 575, commercialSupplyReason: REASON }));
    expect(stated.status).toBe("evidenced");
    expect(stated.flags).toEqual(expect.arrayContaining([expect.objectContaining({ code: "out_of_scope_account_commercial_supply", severity: "warning" })]));
    // Purchases (standard) is untouched by the rule
    const normal = await inTenant(() => billsService.evidencePreview({ ...base, expenseAccountId: purchasesId, subtotal: 500, vatAmount: 75, total: 575 }));
    expect(normal.flags.map((f) => f.code)).not.toEqual(expect.arrayContaining([expect.stringMatching(/^out_of_scope/)]));
  });
});
