/**
 * D-3 / G3 — PER-BANK CASH GL: the structural invariants (2026-09-16).
 *
 * Decision record: docs/product/accounting-architecture-decision-pack.md §D-3.
 * As-built: docs/product/design-per-bank-cash.md. Migration: 0073.
 *
 * What is pinned here, and why each is a property rather than a number:
 *   • the relationship is CONSTRUCTED — a bank account gets its own GL cash
 *     account from the DB trigger, whichever writer inserted the bank, and the
 *     leaf follows a rename; one leaf per bank, one bank per leaf;
 *   • the relationship is TENANT-BOUND — a leaf cannot name another org's bank,
 *     another company's bank cannot be posted to, and org B's chart shows no
 *     leaf of org A (presence, absence AND movement);
 *   • the relationship is PROTECTED at the database — the leaf cannot be
 *     deleted or reassigned by the app role, the header cannot be re-opened,
 *     and a bank with ledger history cannot be deleted (a bank without one can);
 *   • every cash-posting path FAILS CLOSED without a bank — payment, import,
 *     manual row, settlement, acceptance — with the same structured 422, and
 *     the header ("Cash and Bank") accepts no line by code, by id, or by raw
 *     SQL;
 *   • what DOES post lands on the named bank's own account, carries its name,
 *     and is reported per bank (bank accounts API, cash reconciliation).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";
import { auditContext } from "../lib/auditContext";
import { bankAccountsService } from "../services/bankAccounts.service";
import { invoicesService } from "../services/invoices.service";
import { billsService } from "../services/bills.service";
import { transactionsService } from "../services/transactions.service";
import { journalEntriesService } from "../services/journalEntries.service";
import { categoriesService } from "../services/categories.service";
import { cashService } from "../services/cash.service";
import { postJournalEntry, NonPostingAccountError, BankAccountUnresolvedError } from "../services/accounting/glPosting";
import { BankAccountRequiredError } from "../lib/errors";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

const SLUG = "d3-bank-gl";
const SLUG_OTHER = "d3-bank-gl-other";
const EMAIL = "d3-bank-gl@test.local";
const DATE = "2026-06-15";

/** pg's SQLSTATE, whether the error came straight from pg or wrapped by drizzle. */
const pgCode = (err: unknown) => (err as { code?: string; cause?: { code?: string } }).code ?? (err as { cause?: { code?: string } }).cause?.code;

describeMaybe("D-3 — per-bank cash GL", () => {
  let orgId = "";
  let companyId = "";
  let company2Id = "";
  let otherOrgId = "";
  let otherCompanyId = "";
  let userId = 0;
  let customerId = 0;
  let vendorId = 0;
  let rentId = 0;
  let bank1 = 0;
  let bank2 = 0;
  let bankC2 = 0;
  let bankOther = 0;

  const tenant = (org: string, company: string) => async <T,>(fn: () => Promise<T>): Promise<T> => {
    const conn = await beginTenantConnection({ organizationId: org, companyId: company, role: "authenticated" });
    try {
      const out = await conn.run(() => auditContext.run({ userId, organizationId: org, ipAddress: null }, fn));
      await conn.commit();
      return out;
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  };
  const inTenant = <T,>(fn: () => Promise<T>) => tenant(orgId, companyId)(fn);

  const cleanup = async () => {
    for (const slug of [SLUG, SLUG_OTHER]) {
      const org = `(SELECT id FROM organizations WHERE slug = '${slug}')`;
      await pool.query(`DELETE FROM invoice_payments WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id IN ${org})`);
      await pool.query(`DELETE FROM bill_payments WHERE bill_id IN (SELECT id FROM bills WHERE organization_id IN ${org})`);
      for (const t of [
        "cash_line_bank_attributions", "cash_cutover_runs", "journal_entry_lines", "journal_entries", "transactions",
        "invoice_items", "einvoice_documents", "invoices", "bill_items", "bills", "customers", "vendors", "period_locks",
        "audit_logs", "organization_memberships", "bank_accounts", "categories", "companies",
      ]) {
        await pool.query(`DELETE FROM ${t} WHERE organization_id IN ${org}`);
      }
      await pool.query(`DELETE FROM organizations WHERE slug = '${slug}'`);
    }
    await pool.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('D3 Org','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (await pool.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'D3 Co','1010707071','399999999955503') RETURNING id`, [orgId])).rows[0].id;
    company2Id = (await pool.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'D3 Co 2','1010707072','399999999955513') RETURNING id`, [orgId])).rows[0].id;
    otherOrgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('D3 Other','${SLUG_OTHER}') RETURNING id`)).rows[0].id;
    otherCompanyId = (await pool.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'D3 Other Co','1010707073','399999999955523') RETURNING id`, [otherOrgId])).rows[0].id;
    userId = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','D3',' ','admin',true) RETURNING id`)).rows[0].id;
    for (const o of [orgId, otherOrgId]) {
      await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, o]);
    }
    customerId = (await pool.query(`INSERT INTO customers (organization_id, name) VALUES ($1,'D3 Customer') RETURNING id`, [orgId])).rows[0].id;
    vendorId = (await pool.query(`INSERT INTO vendors (organization_id, name, name_ar) VALUES ($1,'D3 Vendor','مورد') RETURNING id`, [orgId])).rows[0].id;
    rentId = (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = 'RENT_UTILITIES'`, [orgId])).rows[0].id;
    // Two banks in company 1, one in company 2, one in the other org — the
    // company-1 banks through the SERVICE (the product path), the rest raw.
    bank1 = (await inTenant(() => bankAccountsService.create({ name: "Riyad Operating", bankName: "Riyad Bank", currency: "SAR" }))).id;
    bank2 = (await inTenant(() => bankAccountsService.create({ name: "Riyad Payroll", bankName: "Riyad Bank", currency: "SAR" }))).id;
    bankC2 = (await pool.query(`INSERT INTO bank_accounts (organization_id, company_id, name, bank_name) VALUES ($1,$2,'Co2 Main','ANB') RETURNING id`, [orgId, company2Id])).rows[0].id;
    bankOther = (await pool.query(`INSERT INTO bank_accounts (organization_id, company_id, name, bank_name) VALUES ($1,$2,'Other Main','ANB') RETURNING id`, [otherOrgId, otherCompanyId])).rows[0].id;
  });
  afterAll(cleanup);

  const leafOf = async (bankId: number) =>
    (await pool.query(`SELECT id, name, name_ar, type, is_system, system_code, liquidity_class, parent_id, is_posting, organization_id FROM categories WHERE bank_account_id = $1`, [bankId])).rows;
  const headerOf = async (org: string) =>
    (await pool.query(`SELECT id, is_posting FROM categories WHERE organization_id = $1 AND system_code = 'CASH'`, [org])).rows[0];
  const linesOf = async (entryNumber: string) =>
    (await pool.query(
      `SELECT l.account_id, l.account_name, c.bank_account_id, c.system_code, l.debit_amount::text AS dr, l.credit_amount::text AS cr
         FROM journal_entry_lines l JOIN categories c ON c.id = l.account_id JOIN journal_entries je ON je.id = l.journal_entry_id
        WHERE je.organization_id = $1 AND je.entry_number = $2 ORDER BY l.id`,
      [orgId, entryNumber],
    )).rows;
  const issueInvoice = async (n: string, price: number) => {
    const inv = await inTenant(() => invoicesService.create({ invoiceNumber: n, date: DATE, dueDate: "2026-07-15", customerId, items: [{ description: "S", quantity: 1, unitPrice: price, vatRate: 15 }] }, userId));
    await inTenant(() => invoicesService.approve(inv.id, userId));
    return inv.id;
  };
  const postBill = async (n: string, price: number) => {
    const bill = await inTenant(() => billsService.create({ billNumber: n, date: DATE, vendorId, items: [{ description: "S", quantity: 1, unitPrice: price, vatRate: 15 }] } as never, userId));
    await inTenant(() => billsService.approve(bill.id, {}, userId));
    return bill.id;
  };

  // ── The relationship is constructed ─────────────────────────────────────

  it("🔴 creating a bank account creates exactly ONE GL cash leaf — system, cash-classified, postable, under the org's CASH header, and the service reads it back", async () => {
    for (const b of [bank1, bank2, bankC2, bankOther]) {
      const rows = await leafOf(b);
      expect(rows, `bank ${b} has exactly one leaf`).toHaveLength(1);
      const leaf = rows[0];
      expect(leaf.type).toBe("asset");
      expect(leaf.is_system).toBe(true);
      expect(leaf.system_code).toBeNull();
      expect(leaf.liquidity_class).toBe("cash");
      expect(leaf.is_posting).toBe(true);
    }
    const header = await headerOf(orgId);
    expect((await leafOf(bank1))[0].parent_id).toBe(header.id);
    expect((await leafOf(bankOther))[0].parent_id).toBe((await headerOf(otherOrgId)).id);
    // The raw-SQL bank (a fixture's shape) got its leaf from the trigger too —
    // the relationship does not depend on which writer created the bank.
    expect((await leafOf(bankC2))[0].organization_id).toBe(orgId);
    // And the service exposes the GL side.
    const view = await inTenant(() => bankAccountsService.getById(bank1));
    expect(view.glAccountId).toBe((await leafOf(bank1))[0].id);
    expect(view.glAccountName).toBe("Riyad Operating");
    expect(view.ledgerBalance).toBe(0);
  });

  it("the header is NON-POSTING for every organization, and renaming the bank renames the leaf (the relationship survives the rename)", async () => {
    expect((await headerOf(orgId)).is_posting).toBe(false);
    expect((await headerOf(otherOrgId)).is_posting).toBe(false);
    await inTenant(() => bankAccountsService.update(bank2, { name: "Riyad Payroll Renamed" }));
    const [leaf] = await leafOf(bank2);
    expect(leaf.name).toBe("Riyad Payroll Renamed");
    expect(leaf.name_ar).toBe("Riyad Payroll Renamed");
    await inTenant(() => bankAccountsService.update(bank2, { name: "Riyad Payroll" }));
  });

  it("🔴 ONE-TO-ONE: a second leaf for the same bank is refused at the unique index", async () => {
    const header = await headerOf(orgId);
    await expect(
      pool.query(
        `INSERT INTO categories (organization_id, name, name_ar, type, is_system, liquidity_class, parent_id, bank_account_id, is_posting)
         VALUES ($1,'dup','dup','asset',true,'cash',$2,$3,true)`,
        [orgId, header.id, bank1],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("🔴 TENANT BOUND: a leaf cannot name another organization's bank account (the FK edge is closed by the trigger, even for the owner)", async () => {
    const header = await headerOf(orgId);
    await expect(
      pool.query(
        `INSERT INTO categories (organization_id, name, name_ar, type, is_system, liquidity_class, parent_id, bank_account_id, is_posting)
         VALUES ($1,'x-tenant','x-tenant','asset',true,'cash',$2,$3,true)`,
        [orgId, header.id, bankOther],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  // ── The relationship is protected ───────────────────────────────────────

  it("🔴 PROTECTED at the database: the app role cannot delete a leaf, reassign its bank, or re-open the header", async () => {
    const [leaf] = await leafOf(bank1);
    const header = await headerOf(orgId);
    const attempt = async (q: ReturnType<typeof sql>) => {
      try {
        await inTenant(() => db.execute(q));
        return null;
      } catch (err) {
        return pgCode(err);
      }
    };
    expect(await attempt(sql`DELETE FROM categories WHERE id = ${leaf.id}`), "delete the leaf").toBe("23001");
    expect(await attempt(sql`UPDATE categories SET bank_account_id = ${bank2} WHERE id = ${leaf.id}`), "reassign the leaf").toBe("23001");
    expect(await attempt(sql`UPDATE categories SET is_posting = true WHERE id = ${header.id}`), "re-open the header").toBe("23001");
    expect(await attempt(sql`UPDATE categories SET parent_id = NULL WHERE id = ${leaf.id}`), "move the leaf").toBe("23001");
    // Still there, unchanged.
    expect((await leafOf(bank1))[0].parent_id).toBe(header.id);
    expect((await headerOf(orgId)).is_posting).toBe(false);
  });

  it("🔴 a bank account WITHOUT ledger history deletes cleanly and its leaf goes with it; one WITH history is refused (409) and both survive", async () => {
    const spare = await inTenant(() => bankAccountsService.create({ name: "Spare", bankName: "ANB", currency: "SAR" }));
    expect(await leafOf(spare.id)).toHaveLength(1);
    await inTenant(() => bankAccountsService.remove(spare.id));
    expect(await leafOf(spare.id)).toHaveLength(0);
    expect((await pool.query(`SELECT count(*)::int AS n FROM bank_accounts WHERE id = $1`, [spare.id])).rows[0].n).toBe(0);

    const inv = await issueInvoice("D3-DEL-1", 100);
    await inTenant(() => invoicesService.pay(inv, { amount: 115, bankAccountId: bank2 }, userId));
    await expect(inTenant(() => bankAccountsService.remove(bank2))).rejects.toMatchObject({ statusCode: 409 });
    expect(await leafOf(bank2)).toHaveLength(1);
    expect((await pool.query(`SELECT count(*)::int AS n FROM bank_accounts WHERE id = $1`, [bank2])).rows[0].n).toBe(1);
  });

  // ── Posting resolves through the relationship ───────────────────────────

  it("🔴 a payment posts to the NAMED bank's own account — two banks, two accounts, each carrying its own name; never the header", async () => {
    const inv1 = await issueInvoice("D3-PAY-1", 1000);
    const inv2 = await issueInvoice("D3-PAY-2", 2000);
    await inTenant(() => invoicesService.pay(inv1, { amount: 1150, bankAccountId: bank1 }, userId));
    await inTenant(() => invoicesService.pay(inv2, { amount: 500, bankAccountId: bank2 }, userId));
    // D-4: the payment record is the `payments` row (one per receipt), reached through its allocation.
    const p1 = (await pool.query(`SELECT p.id, p.bank_account_id FROM payments p JOIN payment_allocations a ON a.payment_id = p.id WHERE a.invoice_id = $1`, [inv1])).rows[0];
    const p2 = (await pool.query(`SELECT p.id, p.bank_account_id FROM payments p JOIN payment_allocations a ON a.payment_id = p.id WHERE a.invoice_id = $1`, [inv2])).rows[0];
    expect(p1.bank_account_id, "the payment record carries its bank").toBe(bank1);
    expect(p2.bank_account_id).toBe(bank2);
    const l1 = (await linesOf(`GL-D3-PAY-1-RCPT-${p1.id}`)).find((l) => l.dr === "1150.00")!;
    const l2 = (await linesOf(`GL-D3-PAY-2-RCPT-${p2.id}`)).find((l) => l.dr === "500.00")!;
    expect(l1.bank_account_id).toBe(bank1);
    expect(l1.account_name).toBe("Riyad Operating");
    expect(l2.bank_account_id).toBe(bank2);
    expect(l2.account_name).toBe("Riyad Payroll");
    expect(l1.system_code).toBeNull();
    // Presence, absence and movement: each leaf holds exactly its own money.
    const v1 = await inTenant(() => bankAccountsService.getById(bank1));
    const v2 = await inTenant(() => bankAccountsService.getById(bank2));
    expect(v1.ledgerBalance).toBe(1150);
    expect(v2.ledgerBalance).toBe(500 + 115); // + the D3-DEL-1 receipt above
    // A bill paid FROM bank1 credits bank1's account.
    const bill = await postBill("D3-BILL-1", 400);
    await inTenant(() => billsService.pay(bill, { amount: 460, bankAccountId: bank1 }, userId));
    expect((await inTenant(() => bankAccountsService.getById(bank1))).ledgerBalance).toBe(1150 - 460);
    const bp = (await pool.query(`SELECT bank_account_id FROM bill_payments WHERE bill_id = $1`, [bill])).rows[0];
    expect(bp.bank_account_id).toBe(bank1);
  });

  it("🔴 the header accepts NO line: by system code, by id (422 account_not_posting), and by raw SQL at the database — even from the owner", async () => {
    const header = await headerOf(orgId);
    await expect(
      inTenant(() => postJournalEntry({ entryNumber: "D3-HDR-CODE", date: DATE, description: "cash by code", lines: [
        { systemCode: "CASH", accountName: "Cash and Bank", debitAmount: 10, creditAmount: 0 },
        { systemCode: "SALES", accountName: "Sales", debitAmount: 0, creditAmount: 10 },
      ] })),
    ).rejects.toBeInstanceOf(NonPostingAccountError);
    await expect(
      inTenant(() => postJournalEntry({ entryNumber: "D3-HDR-ID", date: DATE, description: "cash by id", lines: [
        { accountId: header.id, accountName: "Cash and Bank", debitAmount: 10, creditAmount: 0 },
        { systemCode: "SALES", accountName: "Sales", debitAmount: 0, creditAmount: 10 },
      ] })),
    ).rejects.toMatchObject({ statusCode: 422, payload: expect.objectContaining({ code: "account_not_posting" }) });
    // The manual-JE service refuses it with its own readable 422.
    const [salesId] = (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = 'SALES'`, [orgId])).rows.map((r) => r.id);
    await expect(
      inTenant(() => journalEntriesService.create({ date: DATE, description: "manual on header", lines: [
        { accountId: header.id, accountName: "Cash and Bank", debitAmount: 10, creditAmount: 0 },
        { accountId: salesId, accountName: "Sales", debitAmount: 0, creditAmount: 10 },
      ] } as never, userId)),
    ).rejects.toMatchObject({ statusCode: 422, payload: expect.objectContaining({ code: "account_not_posting", field: "lines[0].accountId" }) });
    // And the database itself, for any writer.
    const je = (await pool.query(`INSERT INTO journal_entries (organization_id, company_id, entry_number, date, description, status) VALUES ($1,$2,'D3-HDR-RAW',$3,'raw','posted') RETURNING id`, [orgId, companyId, DATE])).rows[0].id;
    await expect(
      pool.query(`INSERT INTO journal_entry_lines (organization_id, company_id, journal_entry_id, account_id, account_name, debit_amount, credit_amount) VALUES ($1,$2,$3,$4,'Cash and Bank',10,0)`, [orgId, companyId, je, header.id]),
    ).rejects.toMatchObject({ code: "23514" });
    await pool.query(`DELETE FROM journal_entries WHERE id = $1`, [je]);
    expect((await pool.query(`SELECT count(*)::int AS n FROM journal_entries WHERE organization_id = $1 AND entry_number LIKE 'D3-HDR-%'`, [orgId])).rows[0].n).toBe(0);
    // A manual line on the LEAF posts.
    const [leaf] = await leafOf(bank1);
    const out = await inTenant(() => journalEntriesService.create({ date: DATE, description: "manual on leaf", lines: [
      { accountId: leaf.id, accountName: leaf.name, debitAmount: 10, creditAmount: 0 },
      { accountId: salesId, accountName: "Sales", debitAmount: 0, creditAmount: 10 },
    ] } as never, userId));
    expect(out.id).toBeGreaterThan(0);
  });

  // ── Every cash path fails closed without a bank ─────────────────────────

  it("🔴 FAIL CLOSED: payment, bill payment, import, manual row and settlement each refuse with 422 bank_account_required — and nothing posts", async () => {
    const inv = await issueInvoice("D3-NOBANK-1", 100);
    const bill = await postBill("D3-NOBANK-B", 100);
    const before = (await pool.query(`SELECT count(*)::int AS n FROM journal_entries WHERE organization_id = $1`, [orgId])).rows[0].n;
    const refusals = [
      () => inTenant(() => invoicesService.pay(inv, { amount: 115 } as never, userId)),
      () => inTenant(() => billsService.pay(bill, { amount: 115 } as never, userId)),
      () => inTenant(() => transactionsService.upload({ rows: [{ date: DATE, description: "NO BANK IMPORT", amount: 10, currency: "SAR", type: "debit" }], autoCategrize: false } as never)),
      () => inTenant(() => transactionsService.create({ date: DATE, description: "NO BANK MANUAL", amount: 10, currency: "SAR", type: "debit", categoryId: rentId } as never)),
    ];
    for (const r of refusals) {
      await expect(r()).rejects.toMatchObject({ statusCode: 422, payload: expect.objectContaining({ code: "bank_account_required", field: "bankAccountId" }) });
    }
    // An unknown bank (another org's, or nonexistent) is the reference class.
    await expect(inTenant(() => invoicesService.pay(inv, { amount: 115, bankAccountId: bankOther }, userId)))
      .rejects.toMatchObject({ statusCode: 422, payload: expect.objectContaining({ code: "reference_not_found", field: "bankAccountId" }) });
    await expect(inTenant(() => invoicesService.pay(inv, { amount: 115, bankAccountId: 999999999 }, userId)))
      .rejects.toMatchObject({ statusCode: 422, payload: expect.objectContaining({ code: "reference_not_found" }) });
    // A settlement from a pending row with NO bank refuses too.
    const pending = (await pool.query(
      `INSERT INTO transactions (organization_id, company_id, date, description, amount, type, kind, review_status) VALUES ($1,$2,$3,'NO BANK ROW',115,'credit','operating','pending_review') RETURNING id`,
      [orgId, companyId, DATE],
    )).rows[0].id;
    await expect(inTenant(() => transactionsService.settle(pending, { invoiceId: inv }, userId)))
      .rejects.toMatchObject({ statusCode: 422, payload: expect.objectContaining({ code: "bank_account_required" }) });
    const after = (await pool.query(`SELECT count(*)::int AS n FROM journal_entries WHERE organization_id = $1`, [orgId])).rows[0].n;
    expect(after, "nothing posted").toBe(before);
    expect((await pool.query(`SELECT count(*)::int AS n FROM transactions WHERE organization_id = $1 AND description IN ('NO BANK IMPORT','NO BANK MANUAL')`, [orgId])).rows[0].n).toBe(0);
    expect((await pool.query(`SELECT paid_amount::text AS p FROM invoices WHERE id = $1`, [inv])).rows[0].p).toBe("0.00");
  });

  it("🔴 ACCEPTANCE: a pending row with no bank goes BACK to pending with code bank_account_required; a batch of them is a 422; a sibling with a bank posts to its leaf", async () => {
    const noBank = (await pool.query(
      `INSERT INTO transactions (organization_id, company_id, date, description, amount, type, kind, review_status, category_id) VALUES ($1,$2,$3,'ACCEPT NO BANK',30,'debit','operating','pending_review',$4) RETURNING id`,
      [orgId, companyId, DATE, rentId],
    )).rows[0].id;
    const withBank = (await pool.query(
      `INSERT INTO transactions (organization_id, company_id, date, description, amount, type, kind, review_status, category_id, bank_account_id) VALUES ($1,$2,$3,'ACCEPT WITH BANK',40,'debit','operating','pending_review',$4,$5) RETURNING id`,
      [orgId, companyId, DATE, rentId, bank1],
    )).rows[0].id;
    const r = await inTenant(() => transactionsService.acceptPending([noBank, withBank]));
    expect(r.accepted).toBe(1);
    expect(r.rejected).toEqual([expect.objectContaining({ id: noBank, code: "bank_account_required" })]);
    const rows = (await pool.query(`SELECT id, review_status, journal_entry_id FROM transactions WHERE id = ANY($1::int[]) ORDER BY id`, [[noBank, withBank]])).rows;
    expect(rows.find((x) => x.id === noBank)).toMatchObject({ review_status: "pending_review", journal_entry_id: null });
    expect(rows.find((x) => x.id === withBank)?.journal_entry_id).not.toBeNull();
    expect((await linesOf(`TXN-${withBank}`)).find((l) => l.cr === "40.00")?.bank_account_id).toBe(bank1);
    // Alone, the refusal IS the response.
    await expect(inTenant(() => transactionsService.acceptPending([noBank])))
      .rejects.toMatchObject({ statusCode: 422, payload: expect.objectContaining({ code: "bank_account_required", rejected: [expect.objectContaining({ id: noBank })] }) });
    // Remediation through the product: name the bank once, accept again.
    await inTenant(() => transactionsService.update(noBank, { bankAccountId: bank2 } as never));
    const r2 = await inTenant(() => transactionsService.acceptPending([noBank]));
    expect(r2.accepted).toBe(1);
    expect((await linesOf(`TXN-${noBank}`)).find((l) => l.cr === "30.00")?.bank_account_id).toBe(bank2);
    // A bank, once named, is not a classification to revise.
    await expect(inTenant(() => transactionsService.update(noBank, { bankAccountId: bank1 } as never))).rejects.toMatchObject({ statusCode: 409 });
  });

  it("🔴 an INACTIVE bank cannot carry a new movement (422 bank_account_inactive); its history and leaf are untouched; reactivated, it works again", async () => {
    const inv = await issueInvoice("D3-INACTIVE-1", 100);
    await inTenant(() => bankAccountsService.update(bank2, { isActive: false }));
    const before = await inTenant(() => bankAccountsService.getById(bank2));
    await expect(inTenant(() => invoicesService.pay(inv, { amount: 115, bankAccountId: bank2 }, userId)))
      .rejects.toMatchObject({ statusCode: 422, payload: expect.objectContaining({ code: "bank_account_inactive", field: "bankAccountId" }) });
    await expect(inTenant(() => transactionsService.upload({ rows: [{ date: DATE, description: "INACTIVE IMPORT", amount: 5, currency: "SAR", type: "debit" }], autoCategrize: false, bankAccountId: bank2 } as never)))
      .rejects.toMatchObject({ statusCode: 422, payload: expect.objectContaining({ code: "bank_account_inactive" }) });
    expect((await inTenant(() => bankAccountsService.getById(bank2))).ledgerBalance).toBe(before.ledgerBalance);
    expect(await leafOf(bank2)).toHaveLength(1);
    await inTenant(() => bankAccountsService.update(bank2, { isActive: true }));
    await inTenant(() => invoicesService.pay(inv, { amount: 115, bankAccountId: bank2 }, userId));
    expect((await inTenant(() => bankAccountsService.getById(bank2))).ledgerBalance).toBe((before.ledgerBalance ?? 0) + 115);
  });

  it("🔴 a bank's own cash account is NOT a category for a bank row (422 category_is_bank_account) — cash against cash is a transfer, declared as one", async () => {
    const [leaf] = await leafOf(bank1);
    const row = (await pool.query(
      `INSERT INTO transactions (organization_id, company_id, date, description, amount, type, kind, review_status, bank_account_id) VALUES ($1,$2,$3,'LEAF AS CATEGORY',12,'debit','operating','pending_review',$4) RETURNING id`,
      [orgId, companyId, DATE, bank1],
    )).rows[0].id;
    await expect(inTenant(() => transactionsService.update(row, { categoryId: leaf.id } as never)))
      .rejects.toMatchObject({ statusCode: 422, payload: expect.objectContaining({ code: "category_is_bank_account", field: "categoryId" }) });
    await expect(inTenant(() => transactionsService.create({ date: DATE, description: "LEAF AS CATEGORY 2", amount: 12, currency: "SAR", type: "debit", categoryId: leaf.id, bankAccountId: bank1 } as never)))
      .rejects.toMatchObject({ statusCode: 422, payload: expect.objectContaining({ code: "category_is_bank_account" }) });
    expect((await pool.query(`SELECT category_id, review_status FROM transactions WHERE id = $1`, [row])).rows[0]).toEqual({ category_id: null, review_status: "pending_review" });
  });

  // ── Company and tenant boundaries ───────────────────────────────────────

  it("🔴 COMPANY BOUNDARY: company 2 cannot pay into company 1's bank (422 at the write boundary), and the seam itself refuses the leaf of a bank the company cannot see", async () => {
    const c2 = tenant(orgId, company2Id);
    const cust2 = (await pool.query(`INSERT INTO customers (organization_id, name) VALUES ($1,'Co2 Customer') RETURNING id`, [orgId])).rows[0].id;
    const inv = await c2(() => invoicesService.create({ invoiceNumber: "D3-CO2-1", date: DATE, dueDate: "2026-07-15", customerId: cust2, items: [{ description: "S", quantity: 1, unitPrice: 100, vatRate: 15 }] }, userId));
    await c2(() => invoicesService.approve(inv.id, userId));
    await expect(c2(() => invoicesService.pay(inv.id, { amount: 115, bankAccountId: bank1 }, userId)))
      .rejects.toMatchObject({ statusCode: 422, payload: expect.objectContaining({ code: "reference_not_found" }) });
    await expect(
      c2(() => postJournalEntry({ entryNumber: "D3-CO2-SEAM", date: DATE, description: "other company's bank", lines: [
        { bankAccountId: bank1, debitAmount: 10, creditAmount: 0 },
        { systemCode: "SALES", accountName: "Sales", debitAmount: 0, creditAmount: 10 },
      ] })),
    ).rejects.toBeInstanceOf(BankAccountUnresolvedError);
    // Its OWN bank works.
    await c2(() => invoicesService.pay(inv.id, { amount: 115, bankAccountId: bankC2 }, userId));
    expect((await c2(() => bankAccountsService.getById(bankC2))).ledgerBalance).toBe(115);
  });

  it("🔴 TENANT ISOLATION — presence, absence, movement: org B's chart lists its own leaf and none of org A's; org B cannot post to org A's bank; org A's balances are untouched by the attempt", async () => {
    const other = tenant(otherOrgId, otherCompanyId);
    const mine = await inTenant(() => categoriesService.list());
    const theirs = await other(() => categoriesService.list());
    const myLeaves = mine.filter((c) => c.bankAccountId != null).map((c) => c.bankAccountId).sort();
    const theirLeaves = theirs.filter((c) => c.bankAccountId != null).map((c) => c.bankAccountId);
    expect(myLeaves).toEqual([bank1, bank2, bankC2].sort());
    expect(theirLeaves).toEqual([bankOther]);
    expect(mine.find((c) => c.systemCode === "CASH")?.isPosting).toBe(false);
    const before = await inTenant(() => bankAccountsService.getById(bank1));
    await expect(
      other(() => postJournalEntry({ entryNumber: "D3-XORG", date: DATE, description: "org A's bank from org B", lines: [
        { bankAccountId: bank1, debitAmount: 10, creditAmount: 0 },
        { systemCode: "SALES", accountName: "Sales", debitAmount: 0, creditAmount: 10 },
      ] })),
    ).rejects.toBeInstanceOf(BankAccountUnresolvedError);
    expect((await inTenant(() => bankAccountsService.getById(bank1))).ledgerBalance).toBe(before.ledgerBalance);
    // Movement: org B posting to its OWN bank moves its own figure only.
    await other(() => postJournalEntry({ entryNumber: "D3-OTHER-OWN", date: DATE, description: "own bank", lines: [
      { bankAccountId: bankOther, debitAmount: 77, creditAmount: 0 },
      { systemCode: "SALES", accountName: "Sales", debitAmount: 0, creditAmount: 77 },
    ] }));
    expect((await other(() => bankAccountsService.getById(bankOther))).ledgerBalance).toBe(77);
    expect((await inTenant(() => bankAccountsService.getById(bank1))).ledgerBalance).toBe(before.ledgerBalance);
  });

  // ── Reporting per bank ──────────────────────────────────────────────────

  it("the cash reconciliation narrows to ONE bank: its accepted rows against its own GL account; the whole-company view still sums every cash account", async () => {
    // A window that holds everything posted above: the fixture rows are dated
    // June, the payments today (no paidAt was given), so June → December.
    const months = ["2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11", "2026-12"];
    const all = await inTenant(() => cashService.reconciliation("2026-06", "2026-12", months));
    const b1 = await inTenant(() => cashService.reconciliation("2026-06", "2026-12", months, bank1));
    const b2 = await inTenant(() => cashService.reconciliation("2026-06", "2026-12", months, bank2));
    // bank1's rows: ACCEPT WITH BANK (−40); bank2's rows: ACCEPT NO BANK, later named bank2 (−30).
    expect(b1.summary.bankMovement).toBe(-40);
    expect(b2.summary.bankMovement).toBe(-30);
    expect(all.summary.bankMovement).toBe(-70);
    // Ledger side per bank = that leaf's movement; the company view = every cash account.
    const v1 = await inTenant(() => bankAccountsService.getById(bank1));
    const v2 = await inTenant(() => bankAccountsService.getById(bank2));
    expect(b1.summary.ledgerCash).toBe(v1.ledgerBalance);
    expect(b2.summary.ledgerCash).toBe(v2.ledgerBalance);
    expect(all.summary.ledgerCash).toBe(Math.round(((v1.ledgerBalance ?? 0) + (v2.ledgerBalance ?? 0)) * 100) / 100);
    expect(all.summary.unexplained).toBe(0);
  });
});
