/**
 * PHASE 11 PART 2 — B3/B4: SUPPLIER PAYMENTS, ADVANCES AND ALLOCATION
 * (2026-09-22), on real rows.
 * Record: docs/product/phase-11-deep-accounting-ap-decision-pack.md §9–§11.
 *
 * What is worth asserting here is ACCOUNTING, not plumbing:
 *
 *  · 🔴 the DIRECTION. A customer advance is a liability; a supplier advance is
 *    an ASSET. Every on-account balance below is a debit on an asset account,
 *    and the customer-side liabilities must never appear.
 *  · 🔴 NO INPUT VAT anywhere on a payment path (VAT IR Art. 49(7): deduction
 *    needs the SUPPLIER'S tax invoice, which is a bill, not our payment).
 *  · what may be applied to a bill: an advance, and nothing else — a security
 *    deposit is refundable and not consideration for a supply, and an
 *    unidentified payment has no stated purpose.
 *  · every figure DERIVED from rows: available, outstanding, status.
 *  · posted accounting immutable; corrections are SUPERSEDING records.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { supplierPaymentsService } from "../services/accounting/supplierPayments.service";
import { billsService } from "../services/bills.service";
import { periodLocksService } from "../services/periodLocks.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

describeMaybe("Phase 11 B3/B4 — supplier payments, advances and allocation (real rows)", () => {
  const SLUG = "p11-ap";
  const EMAIL = "p11-ap@test.local";
  let orgId = "", companyId = "", userId = 0, vendorId = 0, otherVendorId = 0, bankId = 0;

  const inTenant = async <T,>(fn: () => Promise<T>): Promise<T> => {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
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
      for (const t of ["supplier_refunds", "supplier_payment_allocation_reversals", "supplier_payment_allocations", "supplier_payment_classifications", "supplier_payments",
                       "bill_payments", "bill_items", "bills", "journal_entry_lines", "journal_entries", "period_locks", "findings", "finding_runs", "audit_logs",
                       "organization_memberships", "vendors", "bank_accounts", "categories", "companies"]) {
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
    if (code) expect(err!.payload?.code).toBe(code);
  };
  const accountId = async (code: string) =>
    (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = $2`, [orgId, code])).rows[0].id as number;
  /** Debit − credit on a system account, over the books. */
  const gl = async (code: string) =>
    Number((await pool.query(
      `SELECT coalesce(sum(l.debit_amount - l.credit_amount), 0)::text v FROM journal_entry_lines l
         JOIN journal_entries e ON e.id = l.journal_entry_id JOIN categories c ON c.id = l.account_id
        WHERE e.organization_id = $1 AND c.system_code = $2 AND e.status IN ('posted','reversed')`, [orgId, code])).rows[0].v);
  /**
   * 🔴 `vatRate: 0` is STATED on the line rather than left to the default.
   * `billsService.create` recomputes the header from the LINES
   * (`it.vatRate ?? DEFAULT_VAT_RATE`), so a line that omits the rate makes a
   * "5,000" bill total 5,750 while every assertion below still reasons about
   * 5,000 — which is exactly how this file first went red: the service was
   * right and the fixture was not. The assertion makes the fixture state its
   * own claim, so a change to that default fails HERE rather than as a
   * mystery further down.
   */
  const makeBill = async (n: string, total: number, v = vendorId) => {
    const bill = await inTenant(() => billsService.create({
      billNumber: n, date: "2026-06-01", vendorId: v,
      items: [{ description: "Supply", quantity: 1, unitPrice: total, vatRate: 0 }],
    }, userId));
    const approved = await inTenant(() => billsService.approve(bill.id, {}, userId));
    expect(Number(approved.total), `fixture bill ${n} must total exactly ${total}`).toBe(total);
    return approved;
  };
  /**
   * 🔴 A payment is picked by the REFERENCE it was created with, never by
   * `list({classification})[0]`: several payments share a classification, so
   * the index quietly selects a different payment than the test names.
   */
  const byRef = async (reference: string) => {
    const { items } = await inTenant(() => supplierPaymentsService.list({}));
    const hit = items.find((i) => i.reference === reference);
    expect(hit, `a payment referenced ${reference}`).toBeTruthy();
    return hit!;
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('P11 AP','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (await pool.query(`INSERT INTO companies (organization_id, name) VALUES ($1,'P11 AP Co') RETURNING id`, [orgId])).rows[0].id;
    userId = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','P11',' ','admin',true) RETURNING id`)).rows[0].id;
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, orgId]);
    vendorId = (await pool.query(`INSERT INTO vendors (organization_id, name) VALUES ($1,'Acme Supplies') RETURNING id`, [orgId])).rows[0].id;
    otherVendorId = (await pool.query(`INSERT INTO vendors (organization_id, name) VALUES ($1,'Other Supplier') RETURNING id`, [orgId])).rows[0].id;
    bankId = (await pool.query(
      `INSERT INTO bank_accounts (organization_id, company_id, name, bank_name) VALUES ($1,$2,'AP Fixture Bank','Riyad') RETURNING id`,
      [orgId, companyId])).rows[0].id;
  }, 90_000);
  afterAll(cleanup);

  it("🔴 D-3 and the period: a payment with no bank is refused, and one into a CLOSED month is refused with nothing written", async () => {
    await expectRefusal(inTenant(() => supplierPaymentsService.create({ vendorId, amount: 100 }, userId)), 422, "bank_account_required");

    await inTenant(() => periodLocksService.lock({ period: "2026-01", userId }));
    const before = (await pool.query(`SELECT count(*)::int n FROM supplier_payments WHERE organization_id = $1`, [orgId])).rows[0].n;
    await expectRefusal(
      inTenant(() => supplierPaymentsService.create({ vendorId, amount: 100, bankAccountId: bankId, paidAt: "2026-01-15" }, userId)),
      423, "period_closed",
    );
    expect((await pool.query(`SELECT count(*)::int n FROM supplier_payments WHERE organization_id = $1`, [orgId])).rows[0].n).toBe(before);
    // 🔴 and no journal entry was left behind either
    expect((await pool.query(
      `SELECT count(*)::int n FROM journal_entries WHERE organization_id = $1 AND date = '2026-01-15'`, [orgId])).rows[0].n).toBe(0);
  }, 90_000);

  it("🔴 a payment allocated in full posts Dr AP (vendor) / Cr bank — and NO on-account asset and NO input VAT move", async () => {
    const bill = await makeBill("AP-BILL-1", 5_000);
    const apBefore = await gl("AP");
    const vatBefore = await gl("VAT_INPUT");

    const p = await inTenant(() => supplierPaymentsService.create({
      vendorId, amount: 5_000, bankAccountId: bankId, paidAt: "2026-06-10", reference: "TT-1",
      allocations: [{ billId: bill.id, amount: 5_000 }],
    }, userId));

    expect([p.amount, p.availableAmount, p.allocations.length]).toEqual([5_000, 0, 1]);
    // AP falls by the payment; the advance accounts never moved
    expect(await gl("AP")).toBe(apBefore + 5_000);
    expect(await gl("SUPPLIER_ADVANCES")).toBe(0);
    expect(await gl("UNIDENTIFIED_PAYMENTS")).toBe(0);
    // 🔴 Art. 49(7): paying deducts nothing. Input VAT is untouched.
    expect(await gl("VAT_INPUT")).toBe(vatBefore);

    // the entry names the vendor on the AP line (N3) and balances
    const lines = (await pool.query(
      `SELECT c.system_code, l.debit_amount::text d, l.credit_amount::text c, l.vendor_id FROM journal_entry_lines l
         JOIN categories c ON c.id = l.account_id WHERE l.journal_entry_id = $1 ORDER BY l.id`, [p.journalEntryId])).rows;
    expect(lines.map((l: { system_code: string; d: string; c: string }) => [l.system_code, l.d, l.c])).toEqual([
      ["AP", "5000.00", "0.00"],
      [null, "0.00", "5000.00"],   // the bank's own cash account carries no system code
    ]);
    expect(lines[0].vendor_id).toBe(vendorId);

    // the bill is settled, derived from the allocation
    const [b] = (await pool.query(`SELECT status FROM bills WHERE id = $1`, [bill.id])).rows;
    expect(b.status).toBe("paid");
  }, 90_000);

  it("🔴 an unallocated payment is an ASSET, not a negative payable — and an UNCLASSIFIED one lands in UNIDENTIFIED_PAYMENTS, never in advances", async () => {
    const apBefore = await gl("AP");
    const p = await inTenant(() => supplierPaymentsService.create({
      vendorId, amount: 3_000, bankAccountId: bankId, paidAt: "2026-06-11", reference: "ON-ACC-1",
    }, userId));

    expect([p.classification, p.availableAmount]).toEqual(["unknown", 3_000]);
    // 🔴 AP did NOT move: nothing was settled, so no payable was reduced
    expect(await gl("AP")).toBe(apBefore);
    // 🔴 it is a DEBIT on an asset — the supplier holds our money
    expect(await gl("UNIDENTIFIED_PAYMENTS")).toBe(3_000);
    expect(await gl("SUPPLIER_ADVANCES")).toBe(0);
    // 🔴 and none of the CUSTOMER-side liabilities was touched
    expect(await gl("CUSTOMER_DEPOSITS")).toBe(0);
    expect(await gl("SECURITY_DEPOSITS_HELD")).toBe(0);
  }, 90_000);

  it("🔴 only an ADVANCE may settle a bill: an unidentified payment and a security deposit are refused BY NAME", async () => {
    const bill = await makeBill("AP-BILL-2", 1_000);
    const unknownPayment = await byRef("ON-ACC-1");
    await expectRefusal(
      inTenant(() => supplierPaymentsService.allocate(unknownPayment.id, { allocations: [{ billId: bill.id, amount: 500 }] }, userId)),
      409, "classification_not_allocatable",
    );

    const dep = await inTenant(() => supplierPaymentsService.create({
      vendorId, amount: 2_000, bankAccountId: bankId, paidAt: "2026-06-12", classification: "security_deposit", reference: "DEP-1",
    }, userId));
    expect(await gl("SECURITY_DEPOSITS_PAID")).toBe(2_000);
    let msg = "";
    try {
      await inTenant(() => supplierPaymentsService.allocate(dep.id, { allocations: [{ billId: bill.id, amount: 500 }] }, userId));
    } catch (e) { msg = (e as Error).message; }
    // the refusal EXPLAINS rather than merely declining
    expect(msg).toMatch(/not consideration for a supply/);
  }, 90_000);

  it("🔴 classifying moves the balance between ASSETS with ONE entry, and the history keeps every act", async () => {
    const unknownPayment = await byRef("ON-ACC-1");
    const unidentifiedBefore = await gl("UNIDENTIFIED_PAYMENTS");

    const out = await inTenant(() => supplierPaymentsService.classify(unknownPayment.id, {
      classification: "advance", note: "Confirmed with the supplier", effectiveDate: "2026-06-20",
    }, userId));

    expect(out.classification).toBe("advance");
    // the money MOVED between two assets, and both sides are asserted
    expect(await gl("UNIDENTIFIED_PAYMENTS")).toBe(unidentifiedBefore - 3_000);
    expect(await gl("SUPPLIER_ADVANCES")).toBe(3_000);
    // the act is recorded with its entry
    const last = out.classificationHistory.at(-1)!;
    expect([last.classification, last.effectiveDate]).toEqual(["advance", "2026-06-20"]);
    expect(last.journalEntryId).not.toBeNull();

    // 🔴 a classification that does NOT change the account posts nothing
    const again = await inTenant(() => supplierPaymentsService.classify(unknownPayment.id, { classification: "advance", note: "Re-stated" }, userId));
    expect(again.classificationHistory.at(-1)!.journalEntryId).toBeNull();
    expect(await gl("SUPPLIER_ADVANCES")).toBe(3_000);
  }, 90_000);

  it("🔴 an advance settles bills by its own entry (Dr AP / Cr advances), across SEVERAL bills, and cannot exceed what is on account", async () => {
    const b2 = (await pool.query(`SELECT id FROM bills WHERE organization_id = $1 AND bill_number = 'AP-BILL-2'`, [orgId])).rows[0];
    const b3 = await makeBill("AP-BILL-3", 4_000);
    const advance = await byRef("ON-ACC-1");
    expect(advance.availableAmount).toBe(3_000);

    const apBefore = await gl("AP");
    await inTenant(() => supplierPaymentsService.allocate(advance.id, {
      allocations: [{ billId: b2.id, amount: 1_000 }, { billId: b3.id, amount: 1_500 }], date: "2026-06-21",
    }, userId));

    // Dr AP 2,500 / Cr supplier advances 2,500 — both sides
    expect(await gl("AP")).toBe(apBefore + 2_500);
    expect(await gl("SUPPLIER_ADVANCES")).toBe(500);
    const after = await inTenant(() => supplierPaymentsService.getById(advance.id));
    expect(after.availableAmount).toBe(500);

    // 🔴 what is left cannot be over-applied
    await expectRefusal(inTenant(() => supplierPaymentsService.allocate(advance.id, {
      allocations: [{ billId: b3.id, amount: 900 }],
    }, userId)), 409, "allocation_exceeds_available");

    // …nor may it settle ANOTHER supplier's bill
    const foreign = await makeBill("AP-BILL-OTHER", 300, otherVendorId);
    await expectRefusal(inTenant(() => supplierPaymentsService.allocate(advance.id, {
      allocations: [{ billId: foreign.id, amount: 300 }],
    }, userId)), 422, "bill_other_vendor");
  }, 120_000);

  it("🔴 an allocation is corrected by a SUPERSEDING record: the original row stays, the balances return, and a second correction is refused", async () => {
    const advanceRef = await byRef("ON-ACC-1");
    const advance = await inTenant(() => supplierPaymentsService.getById(advanceRef.id));
    const alloc = advance.allocations.find((a) => !a.reversed)!;
    const apBefore = await gl("AP");
    const advBefore = await gl("SUPPLIER_ADVANCES");

    await expectRefusal(inTenant(() => supplierPaymentsService.reverseAllocation(alloc.id, { reason: "  " }, userId)), 422, "reason_required");
    const out = await inTenant(() => supplierPaymentsService.reverseAllocation(alloc.id, { reason: "Applied to the wrong bill", date: "2026-06-25" }, userId));

    // the balances return by exactly the allocation's amount and nothing else
    expect(await gl("AP")).toBe(apBefore - out.amount);
    expect(await gl("SUPPLIER_ADVANCES")).toBe(advBefore + out.amount);

    // 🔴 the ORIGINAL allocation row is still there, marked reversed
    const after = await inTenant(() => supplierPaymentsService.getById(advance.id));
    expect(after.allocations.find((a) => a.id === alloc.id)!.reversed).toBe(true);
    expect(after.availableAmount).toBe(500 + out.amount);
    // one correction only — the database refuses a second
    await expectRefusal(inTenant(() => supplierPaymentsService.reverseAllocation(alloc.id, { reason: "again" }, userId)), 409, "allocation_already_reversed");
  }, 120_000);

  it("🔴 a refund returns money from the supplier: the asset falls, the bank rises, and it cannot exceed what is on account", async () => {
    const dep = await byRef("DEP-1");
    const depBefore = await gl("SECURITY_DEPOSITS_PAID");

    await expectRefusal(inTenant(() => supplierPaymentsService.refund(dep.id, { amount: 9_999, reason: "too much", bankAccountId: bankId }, userId)), 409, "refund_exceeds_available");
    await expectRefusal(inTenant(() => supplierPaymentsService.refund(dep.id, { amount: 500, reason: "  ", bankAccountId: bankId }, userId)), 422, "reason_required");

    const out = await inTenant(() => supplierPaymentsService.refund(dep.id, {
      amount: 2_000, reason: "Contract ended, deposit returned", bankAccountId: bankId, refundedAt: "2026-06-28",
    }, userId));
    expect(out.amount).toBe(2_000);
    expect(await gl("SECURITY_DEPOSITS_PAID")).toBe(depBefore - 2_000);
    const after = await inTenant(() => supplierPaymentsService.getById(dep.id));
    expect(after.availableAmount).toBe(0);
  }, 120_000);

  it("🔴 a posted payment and a posted allocation are immutable at the DATABASE, not only in the service", async () => {
    const [p] = (await pool.query(`SELECT id FROM supplier_payments WHERE organization_id = $1 ORDER BY id LIMIT 1`, [orgId])).rows;
    const [a] = (await pool.query(
      `SELECT id FROM supplier_payment_allocations WHERE organization_id = $1 AND journal_entry_id IS NOT NULL ORDER BY id LIMIT 1`, [orgId])).rows;

    const asApp = async (sql: string, id: number) => {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await c.query(`SET LOCAL ROLE authenticated`);
        await c.query(`SELECT set_config('app.current_org_id', $1, true)`, [orgId]);
        await c.query(`SELECT set_config('app.current_company_id', $1, true)`, [companyId]);
        await c.query(sql, [id]);
        await c.query("ROLLBACK");
        return { ok: true, msg: "" };
      } catch (e) { await c.query("ROLLBACK"); return { ok: false, msg: (e as Error).message }; }
      finally { c.release(); }
    };
    const editPayment = await asApp(`UPDATE supplier_payments SET amount = 1 WHERE id = $1`, p.id);
    expect(editPayment.ok).toBe(false);
    expect(editPayment.msg).toMatch(/fact of record/);
    // 0098: the append-only tables carry NO UPDATE grant at all (0096's
    // trigger guarded only allocations WITH a journal entry, so a credit-note
    // application — journal entry NULL — was editable). Every one refuses.
    const editAlloc = await asApp(`UPDATE supplier_payment_allocations SET amount = 1 WHERE id = $1`, a.id);
    expect(editAlloc.ok).toBe(false);
    expect(editAlloc.msg).toMatch(/permission denied/i);
    for (const table of ["supplier_payment_allocation_reversals", "supplier_payment_classifications", "supplier_refunds"]) {
      const edit = await asApp(`UPDATE ${table} SET created_by = created_by WHERE id = $1`, 0);
      expect(edit.ok, `${table} must not be updatable by the app role`).toBe(false);
      expect(edit.msg).toMatch(/permission denied/i);
    }
    // …and the positive control: the ONE table that keeps UPDATE (for its
    // classification column) still refuses a change to what was paid.
    const reclass = await asApp(`UPDATE supplier_payments SET notes = notes WHERE id = $1`, p.id);
    expect(reclass.ok, "supplier_payments keeps UPDATE for classification — the denial above is the grant, not a broken probe").toBe(true);
    // and DELETE is not granted to the app role at all
    const del = await asApp(`DELETE FROM supplier_payments WHERE id = $1`, p.id);
    expect(del.ok).toBe(false);
    expect(del.msg).toMatch(/permission denied/i);
  }, 90_000);

  it("🔴 THE SUBLEDGER RECONCILES TO THE CONTROL ACCOUNT: Σ outstanding per bill = the AP balance, and Σ on-account = the three asset accounts", async () => {
    // AP control = what the bills still owe, by construction
    const [apRow] = (await pool.query(
      `SELECT coalesce(sum(b.total - coalesce(b.paid_amount,0)
              - coalesce((SELECT sum(a.amount) FROM supplier_payment_allocations a
                           WHERE a.bill_id = b.id
                             AND NOT EXISTS (SELECT 1 FROM supplier_payment_allocation_reversals r WHERE r.allocation_id = a.id)), 0)), 0)::text v
         FROM bills b WHERE b.organization_id = $1 AND b.status NOT IN ('draft','submitted')`, [orgId])).rows;
    const subledgerOutstanding = Number(apRow.v);
    // the GL's AP balance is a CREDIT balance, so debit−credit is its negative
    expect(-(await gl("AP"))).toBeCloseTo(subledgerOutstanding, 2);

    const [onAcc] = (await pool.query(
      `SELECT coalesce(sum(p.amount
              - coalesce((SELECT sum(a.amount) FROM supplier_payment_allocations a
                           WHERE a.supplier_payment_id = p.id
                             AND NOT EXISTS (SELECT 1 FROM supplier_payment_allocation_reversals r WHERE r.allocation_id = a.id)), 0)
              - coalesce((SELECT sum(f.amount) FROM supplier_refunds f WHERE f.supplier_payment_id = p.id), 0)), 0)::text v
         FROM supplier_payments p WHERE p.organization_id = $1`, [orgId])).rows;
    const assets = (await gl("SUPPLIER_ADVANCES")) + (await gl("SECURITY_DEPOSITS_PAID")) + (await gl("UNIDENTIFIED_PAYMENTS"));
    expect(assets).toBeCloseTo(Number(onAcc.v), 2);
    // 🔴 non-vacuous: there really is money on account and really is a payable
    expect(Number(onAcc.v)).toBeGreaterThan(0);
    expect(subledgerOutstanding).toBeGreaterThan(0);
  }, 90_000);
});
