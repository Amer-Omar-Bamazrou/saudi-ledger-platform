/**
 * PHASE 13C — EXPENSES (2026-09-24), on real rows.
 *
 * An EXPENSE is a supplier purchase PAID WHEN IT IS RECORDED. It is a bill —
 * one posting path — that names the bank it was paid from and the date; its
 * approval posts it AND pays it through THE bill-payment path (`payBill`) in
 * the same transaction, so no payable is left outstanding.
 *
 *  1. 🔴 recording creates a DRAFT and moves nothing; the approval posts and
 *     pays: AP nets to zero, the named bank is credited, input VAT claimed
 *     once, `billPosition` owes nothing, one dated payment row names its entry;
 *  2. 🔴 no second payment: the pay path and a second approval both refuse;
 *  3. 🔴 atomic: a payment that cannot post (its month closed after drafting)
 *     rolls the posting back with it — nothing half-recorded;
 *  4. 🔴 an expense with insufficient VAT evidence (X1) posts AND pays like
 *     any other — the supplier was paid — with its VAT in the HOLDING account,
 *     never VAT_INPUT, and is listed as held; an Art. 50 expense (X5) posts
 *     and pays with its VAT in the expense's cost;
 *  5. the write boundary: bank and paid date required and never defaulted;
 *     only a plain bill; a closed paid-date refused at entry;
 *  6. the Expenses view reads the bills — no second source of truth — and is
 *     company-scoped.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { billsService } from "../services/bills.service";
import { expensesService } from "../services/expenses.service";
import { periodLocksService } from "../services/periodLocks.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

describeMaybe("Phase 13C — expenses: paid when recorded, through the bill paths (real rows)", () => {
  const SLUG = "p13-expenses";
  const EMAIL = "p13-expenses@test.local";
  let orgId = "", companyId = "", company2 = "", userId = 0, vendorId = 0, bankId = 0, bank2 = 0;

  const inTenant = async <T,>(fn: () => Promise<T>, co = companyId): Promise<T> => {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId: co, role: "authenticated" });
    try {
      const out = await conn.run(() => auditContext.run({ userId, organizationId: orgId, ipAddress: null }, fn));
      await conn.commit();
      return out;
    } catch (err) { await conn.rollback(); throw err; }
  };
  const cleanup = async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      const org = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
      for (const t of ["captured_documents", "bill_payments", "bill_items", "bills", "journal_entry_lines", "journal_entries",
                       "period_locks", "audit_logs", "organization_memberships", "vendors", "bank_accounts", "categories", "companies"]) {
        await client.query(`DELETE FROM ${t} WHERE organization_id IN ${org}`);
      }
      await client.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
      await client.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
      await client.query("COMMIT");
    } catch (err) { await client.query("ROLLBACK"); throw err; } finally { client.release(); }
  };
  const expectRefusal = async (p: Promise<unknown>, status: number, code?: string) => {
    let err: { statusCode?: number; status?: number; payload?: { code?: string }; message?: string } | undefined;
    try { await p; } catch (e) { err = e as typeof err; }
    expect(err, "expected a refusal").toBeTruthy();
    expect(err!.statusCode ?? err!.status, err!.message).toBe(status);
    if (code) expect(err!.payload?.code, err!.message).toBe(code);
    return err!;
  };
  /** Debit − credit on a system account, over the books. */
  const gl = async (code: string) => Number((await pool.query(
    `SELECT coalesce(sum(l.debit_amount - l.credit_amount), 0)::text v FROM journal_entry_lines l
       JOIN journal_entries e ON e.id = l.journal_entry_id JOIN categories c ON c.id = l.account_id
      WHERE e.organization_id = $1 AND c.system_code = $2 AND e.status IN ('posted','reversed')`, [orgId, code])).rows[0].v);
  /** Debit − credit on ONE bank's own cash account (D-3). */
  const bankGl = async (id: number) => Number((await pool.query(
    `SELECT coalesce(sum(l.debit_amount - l.credit_amount), 0)::text v FROM journal_entry_lines l
       JOIN journal_entries e ON e.id = l.journal_entry_id JOIN categories c ON c.id = l.account_id
      WHERE e.organization_id = $1 AND c.bank_account_id = $2 AND e.status IN ('posted','reversed')`, [orgId, id])).rows[0].v);
  const expense = (over: Record<string, unknown> = {}) => inTenant(() => billsService.create({
    date: "2026-06-03", vendorId, vendorReference: `EXP-${Math.random().toString(36).slice(2, 8)}`, supplierDocumentKind: "tax_invoice",
    subtotal: 200, vatAmount: 30, total: 230, items: [],
    recordedAsExpense: true, expensePaidFromBankAccountId: bankId, expensePaidAt: "2026-06-03", ...over,
  }, userId));

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('P13 Expenses','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (await pool.query(`INSERT INTO companies (organization_id, name) VALUES ($1,'P13 Exp Co') RETURNING id`, [orgId])).rows[0].id;
    company2 = (await pool.query(`INSERT INTO companies (organization_id, name) VALUES ($1,'P13 Exp Co 2') RETURNING id`, [orgId])).rows[0].id;
    userId = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','E',' ','admin',true) RETURNING id`)).rows[0].id;
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, orgId]);
    vendorId = (await pool.query(`INSERT INTO vendors (organization_id, name, tax_number) VALUES ($1,'Jeddah Office Supply','300000000000003') RETURNING id`, [orgId])).rows[0].id;
    bankId = (await pool.query(`INSERT INTO bank_accounts (organization_id, company_id, name, bank_name) VALUES ($1,$2,'Operating','SNB') RETURNING id`, [orgId, companyId])).rows[0].id;
    bank2 = (await pool.query(`INSERT INTO bank_accounts (organization_id, company_id, name, bank_name) VALUES ($1,$2,'Card account','Rajhi') RETURNING id`, [orgId, companyId])).rows[0].id;
  }, 120_000);
  afterAll(cleanup);

  let paidId = 0;

  it("1 🔴 recording creates a DRAFT and moves nothing; APPROVAL posts it and PAYS it from the named bank — AP nets to zero, nothing left owing", async () => {
    const before = { ap: await gl("AP"), vat: await gl("VAT_INPUT"), bank: await bankGl(bank2), other: await bankGl(bankId) };
    const d = await expense({ expensePaidFromBankAccountId: bank2 });
    paidId = d.id;
    expect(d).toMatchObject({ status: "draft", recordedAsExpense: true, expensePaidFromBankAccountId: bank2, expensePaidAt: "2026-06-03" });
    expect(d.vatEvidence.status).toBe("evidenced");
    expect(await gl("AP"), "a draft moves nothing").toBe(before.ap);
    expect(await bankGl(bank2)).toBe(before.bank);

    const posted = await inTenant(() => billsService.approve(d.id, {}, userId));
    expect(posted.status, "posted AND paid in one act").toBe("paid");
    expect(posted.outstanding, "billPosition: nothing owed").toBe(0);
    expect(await gl("AP") - before.ap, "AP credited then debited — nets to zero").toBeCloseTo(0, 2);
    expect(await gl("VAT_INPUT") - before.vat, "input VAT claimed once").toBeCloseTo(30, 2);
    expect(await bankGl(bank2) - before.bank, "the NAMED bank is credited the total").toBeCloseTo(-230, 2);
    expect(await bankGl(bankId), "no other bank moves").toBe(before.other);

    const pays = (await pool.query(`SELECT amount::text, paid_at::text AS paid_at, bank_account_id, journal_entry_id FROM bill_payments WHERE bill_id = $1`, [d.id])).rows;
    expect(pays).toHaveLength(1);
    expect(pays[0]).toMatchObject({ amount: "230.00", paid_at: "2026-06-03", bank_account_id: bank2 });
    expect(pays[0].journal_entry_id, "the payment names its entry (Phase 12B reconcilable)").not.toBeNull();
    const entry = (await pool.query(`SELECT date::text AS date FROM journal_entries WHERE id = $1`, [pays[0].journal_entry_id])).rows[0];
    expect(entry.date).toBe("2026-06-03");
  });

  it("2 🔴 no duplicate payment: the pay path refuses a paid expense, and so does a second approval", async () => {
    await expectRefusal(inTenant(() => billsService.pay(paidId, { amount: 1, bankAccountId: bankId, paidAt: "2026-06-04" }, userId)), 409);
    await expectRefusal(inTenant(() => billsService.approve(paidId, {}, userId)), 409);
    expect(Number((await pool.query(`SELECT count(*) n FROM bill_payments WHERE bill_id = $1`, [paidId])).rows[0].n)).toBe(1);
  });

  it("3 🔴 ATOMIC: when the paid month is closed after drafting, the approval fails and NOTHING is left — no posting without its payment", async () => {
    const before = { ap: await gl("AP"), vat: await gl("VAT_INPUT") };
    const d = await expense({ date: "2026-07-02", expensePaidAt: "2026-08-05" });
    await inTenant(() => periodLocksService.lock({ period: "2026-08", userId }));
    try {
      await expectRefusal(inTenant(() => billsService.approve(d.id, {}, userId)), 423);
      expect((await pool.query(`SELECT status FROM bills WHERE id = $1`, [d.id])).rows[0].status, "still a draft").toBe("draft");
      expect(await gl("AP"), "the bill's posting rolled back with the payment").toBe(before.ap);
      expect(await gl("VAT_INPUT")).toBe(before.vat);
      expect(Number((await pool.query(`SELECT count(*) n FROM bill_payments WHERE bill_id = $1`, [d.id])).rows[0].n)).toBe(0);
    } finally {
      await inTenant(() => periodLocksService.unlock("2026-08"));
    }
  });

  it("4 🔴 X1: an expense with insufficient VAT evidence posts AND pays — its VAT HELD, never VAT_INPUT — and is listed as held", async () => {
    const before = { ap: await gl("AP"), vat: await gl("VAT_INPUT"), hold: await gl("VAT_AWAITING_EVIDENCE"), bank: await bankGl(bankId) };
    const d = await expense({ supplierDocumentKind: "no_tax_invoice" });
    expect(d.vatEvidence.status).toBe("awaiting_evidence");
    const posted = await inTenant(() => billsService.approve(d.id, {}, userId));
    expect(posted.status, "posted AND paid in one act").toBe("paid");
    expect(posted.inputVat).toMatchObject({ state: "awaiting_evidence", pending: 30 });
    expect(await gl("AP") - before.ap, "AP nets to zero").toBeCloseTo(0, 2);
    expect(await gl("VAT_INPUT"), "no input VAT claimed").toBe(before.vat);
    expect(await gl("VAT_AWAITING_EVIDENCE") - before.hold, "the VAT is held").toBeCloseTo(30, 2);
    expect(await bankGl(bankId) - before.bank, "the supplier was paid the gross").toBeCloseTo(-230, 2);
    const held = await inTenant(() => billsService.heldForEvidence({ limit: 50, offset: 0 }));
    expect(held.items.map((i) => i.id)).toContain(d.id);
  });

  it("4b 🔴 X5: an expense on an Art. 50 BLOCKED account posts and pays with its VAT in the expense's cost — never input VAT", async () => {
    const meals = (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = 'FOOD_MEALS'`, [orgId])).rows[0].id as number;
    const before = { vat: await gl("VAT_INPUT"), hold: await gl("VAT_AWAITING_EVIDENCE"), bank: await bankGl(bankId) };
    const d = await expense({ expenseAccountId: meals });
    expect(d.vatEvidence.status).toBe("not_deductible");
    const posted = await inTenant(() => billsService.approve(d.id, {}, userId));
    expect(posted.status).toBe("paid");
    expect(posted.inputVat.state).toBe("not_deductible");
    expect(await gl("VAT_INPUT")).toBe(before.vat);
    expect(await gl("VAT_AWAITING_EVIDENCE")).toBe(before.hold);
    expect(await gl("FOOD_MEALS"), "the gross is the expense").toBeCloseTo(230, 2);
    expect(await bankGl(bankId) - before.bank).toBeCloseTo(-230, 2);
  });

  it("5 the write boundary: bank and paid date REQUIRED (never defaulted, never inferred), only a plain bill, a closed paid-date refused at entry", async () => {
    await expectRefusal(expense({ expensePaidFromBankAccountId: null }), 422, "bank_account_required");
    await expectRefusal(expense({ expensePaidAt: null }), 422, "expense_paid_at_required");
    await expectRefusal(expense({ expensePaidAt: "03/06/2026" }), 400);
    const orig = (await expense({ recordedAsExpense: false, expensePaidFromBankAccountId: null, expensePaidAt: null }));
    expect(orig).toMatchObject({ recordedAsExpense: false, expensePaidFromBankAccountId: null, expensePaidAt: null });
    await inTenant(() => billsService.approve(orig.id, {}, userId));
    await expectRefusal(expense({ documentType: "credit_note", creditNoteAgainstBillId: orig.id, subtotal: 20, vatAmount: 3, total: 23 }), 422, "expense_must_be_bill");
    await inTenant(() => periodLocksService.lock({ period: "2026-09", userId }));
    try {
      await expectRefusal(expense({ date: "2026-10-01", expensePaidAt: "2026-09-30" }), 423);
    } finally {
      await inTenant(() => periodLocksService.unlock("2026-09"));
    }
    // a DRAFT bill can become an expense later ("reuse"), judged as it will stand
    const plain = await expense({ recordedAsExpense: false, expensePaidFromBankAccountId: null, expensePaidAt: null });
    await expectRefusal(inTenant(() => billsService.update(plain.id, { recordedAsExpense: true })), 422, "bank_account_required");
    const converted = await inTenant(() => billsService.update(plain.id, { recordedAsExpense: true, expensePaidFromBankAccountId: bankId, expensePaidAt: "2026-06-03" }));
    expect(converted.recordedAsExpense).toBe(true);
  });

  it("6 the Expenses view READS the bills — status, payment, bank, evidence — and is company-scoped", async () => {
    const page = await inTenant(() => expensesService.list({ limit: 50, offset: 0 }));
    const row = page.items.find((i) => i.id === paidId)!;
    expect(row).toMatchObject({ paymentStatus: "paid", paidFromBankName: "Card account", recordedAsExpense: true, status: "paid" });
    expect(row.payments).toHaveLength(1);
    expect(row.payments[0]).toMatchObject({ amount: 230, bankAccountId: bank2 });
    expect(row.vatEvidence.status).toBe("evidenced");
    const unposted = await inTenant(() => expensesService.list({ status: "unposted", limit: 50, offset: 0 }));
    expect(unposted.items.every((i) => i.paymentStatus === "not_posted")).toBe(true);
    expect(unposted.items.map((i) => i.id)).not.toContain(paidId);
    expect(page.totals.unposted).toBe(unposted.page.total);
    // a bill that is NOT an expense is not in the view
    expect(page.items.every((i) => i.recordedAsExpense)).toBe(true);
    // company scope, with movement: the second company sees only its own
    const own = await inTenant(() => billsService.create({
      date: "2026-06-03", vendorId, vendorReference: "CO2-1", supplierDocumentKind: "tax_invoice", subtotal: 10, vatAmount: 1.5, total: 11.5, items: [],
      recordedAsExpense: true, expensePaidFromBankAccountId: bankId, expensePaidAt: "2026-06-03",
    }, userId), company2).catch((e) => e);
    // the first company's bank is not the second company's: refused, never borrowed
    expect((own as { statusCode?: number }).statusCode).toBe(422);
    const co2 = await inTenant(() => expensesService.list({ limit: 50, offset: 0 }), company2);
    expect(co2.items.map((i) => i.id)).not.toContain(paidId);
    expect(co2.page.total).toBe(0);
  });
});
