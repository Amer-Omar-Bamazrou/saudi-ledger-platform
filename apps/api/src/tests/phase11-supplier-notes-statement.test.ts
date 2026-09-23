/**
 * PHASE 11 PART 2 — B5/B6/B7: SUPPLIER CREDIT NOTES, THE AP AGEING AND THE
 * SUPPLIER STATEMENT (2026-09-22), on real rows.
 * Record: docs/product/phase-11-deep-accounting-ap-decision-pack.md §13–§15.
 *
 * What is worth asserting here is ACCOUNTING and TAX, not plumbing:
 *
 *  · 🔴 a purchase note posts MIRRORED through the SAME bill path — Dr AP,
 *    Cr expense, Cr input VAT — and never through a second posting path.
 *  · 🔴 Art. 40(6): the input-tax correction files in the period the note was
 *    ISSUED, and the return files it NEGATIVE. Filing it positive would claim
 *    a deduction twice, in the direction the taxpayer benefits from.
 *  · 🔴 applying an approved note posts NOTHING: its debit is already in AP.
 *  · 🔴 the ageing nets live allocations, skips notes as rows, and shows what
 *    the supplier holds BESIDE the buckets rather than inside them.
 *  · 🔴 the statement's event stream and the position agree — two computations
 *    of one fact, compared rather than assumed.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { billsService } from "../services/bills.service";
import { supplierCreditNotesService } from "../services/accounting/supplierCreditNotes.service";
import { supplierPaymentsService } from "../services/accounting/supplierPayments.service";
import { supplierStatementService } from "../services/accounting/supplierStatement.service";
import { reportsService } from "../services/reports.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

describeMaybe("Phase 11 B5/B6/B7 — supplier notes, ageing and statement (real rows)", () => {
  const SLUG = "p11-apnote";
  const EMAIL = "p11-apnote@test.local";
  let orgId = "", companyId = "", userId = 0, vendorId = 0, bankId = 0;
  let billId = 0, noteId = 0;

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
      for (const t of ["supplier_refunds", "supplier_payment_allocation_reversals", "supplier_payment_allocations",
                       "supplier_payment_classifications", "supplier_payments",
                       "bill_payments", "bill_items", "bills", "journal_entry_lines", "journal_entries",
                       "period_locks", "findings", "finding_runs", "audit_logs",
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
  /** Debit − credit on a system account, over the books. */
  const gl = async (code: string) =>
    Number((await pool.query(
      `SELECT coalesce(sum(l.debit_amount - l.credit_amount), 0)::text v FROM journal_entry_lines l
         JOIN journal_entries e ON e.id = l.journal_entry_id JOIN categories c ON c.id = l.account_id
        WHERE e.organization_id = $1 AND c.system_code = $2 AND e.status IN ('posted','reversed')`, [orgId, code])).rows[0].v);
  const entryCount = async () =>
    Number((await pool.query(`SELECT count(*)::int n FROM journal_entries WHERE organization_id = $1`, [orgId])).rows[0].n);

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('P11 AP Note','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (await pool.query(`INSERT INTO companies (organization_id, name) VALUES ($1,'P11 Note Co') RETURNING id`, [orgId])).rows[0].id;
    userId = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','P11',' ','admin',true) RETURNING id`)).rows[0].id;
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, orgId]);
    vendorId = (await pool.query(`INSERT INTO vendors (organization_id, name) VALUES ($1,'Note Supplies') RETURNING id`, [orgId])).rows[0].id;
    bankId = (await pool.query(
      `INSERT INTO bank_accounts (organization_id, company_id, name, bank_name) VALUES ($1,$2,'Note Bank','Riyad') RETURNING id`,
      [orgId, companyId])).rows[0].id;

    // One approved bill: 10,000 net + 1,500 VAT = 11,500, dated in MAY.
    const bill = await inTenant(() => billsService.create({
      billNumber: "NB-1", date: "2026-05-10", dueDate: "2026-06-10", vendorId,
      items: [{ description: "Supply", quantity: 1, unitPrice: 10_000, vatRate: 15 }],
    }, userId));
    const approved = await inTenant(() => billsService.approve(bill.id, {}, userId));
    billId = approved.id;
    expect(Number(approved.total)).toBe(11_500);
  }, 120_000);
  afterAll(cleanup);

  it("🔴 a purchase note is refused unless it adjusts an approved bill, and a CREDIT note may not exceed what was charged", async () => {
    // a bill that names a document it adjusts is a note somebody forgot to type
    await expectRefusal(inTenant(() => billsService.create({
      billNumber: "NB-BAD", date: "2026-06-01", vendorId, creditNoteAgainstBillId: billId,
      items: [{ description: "x", quantity: 1, unitPrice: 10, vatRate: 0 }],
    }, userId)), 422, "against_bill_on_a_bill");

    // a note with nothing to adjust
    await expectRefusal(inTenant(() => billsService.create({
      billNumber: "NB-BAD2", date: "2026-06-01", vendorId, documentType: "credit_note",
      items: [{ description: "x", quantity: 1, unitPrice: 10, vatRate: 0 }],
    }, userId)), 422, "against_bill_required");

    // 🔴 the ceiling is what was CHARGED (11,500), not what is outstanding
    await expectRefusal(inTenant(() => billsService.create({
      billNumber: "NB-BAD3", date: "2026-06-01", vendorId, documentType: "credit_note",
      creditNoteAgainstBillId: billId,
      items: [{ description: "x", quantity: 1, unitPrice: 20_000, vatRate: 0 }],
    }, userId)), 409, "credit_exceeds_bill");
  }, 90_000);

  it("🔴 an approved credit note posts MIRRORED through the SAME bill path: Dr AP, Cr expense, Cr input VAT", async () => {
    const apBefore = await gl("AP");
    const vatBefore = await gl("VAT_INPUT");

    // 2,000 net + 300 VAT, ISSUED BY THE SUPPLIER IN JUNE — a different period
    // from the bill's May, which is the whole point of Art. 40(6).
    const draft = await inTenant(() => billsService.create({
      billNumber: "NB-CN-1", date: "2026-06-05", vendorId, documentType: "credit_note",
      creditNoteAgainstBillId: billId,
      items: [{ description: "Returned goods", quantity: 1, unitPrice: 2_000, vatRate: 15 }],
    }, userId));
    // 🔴 the note INHERITS the original's supplier; it is not taken from the body
    expect(draft.vendorId).toBe(vendorId);

    // a DRAFT moves nothing
    expect(await gl("AP")).toBe(apBefore);

    const posted = await inTenant(() => billsService.approve(draft.id, {}, userId));
    noteId = posted.id;

    // 🔴 AP goes UP (a debit reduces the payable); input VAT comes BACK OFF
    expect(await gl("AP")).toBe(apBefore + 2_300);
    expect(await gl("VAT_INPUT")).toBe(vatBefore - 300);

    const lines = (await pool.query(
      `SELECT c.system_code, l.debit_amount::text d, l.credit_amount::text c FROM journal_entry_lines l
         JOIN categories c ON c.id = l.account_id
         JOIN journal_entries e ON e.id = l.journal_entry_id
        WHERE e.entry_number = 'BILLCN-NB-CN-1' ORDER BY l.id`, [])).rows;
    expect(lines.map((l: { system_code: string; d: string; c: string }) => [l.system_code, l.d, l.c])).toEqual([
      ["PURCHASES", "0.00", "2000.00"],
      ["VAT_INPUT", "0.00", "300.00"],
      ["AP", "2300.00", "0.00"],
    ]);
  }, 120_000);

  it("🔴 Art. 40(6): the return corrects INPUT TAX in the NOTE'S period, and files it NEGATIVE", async () => {
    // May: the bill alone.
    const may = await inTenant(() => reportsService.vatReturn("2026-05-01", "2026-05-31"));
    expect(Number(may.purchasesSection.box9_standardRatedPurchases)).toBe(10_000);
    expect(Number(may.purchasesSection.box13_recoverableInputVat)).toBe(1_500);

    // 🔴 June: the note alone, NEGATIVE. The correction did not re-date into
    // May, and it did not file positive.
    const june = await inTenant(() => reportsService.vatReturn("2026-06-01", "2026-06-30"));
    expect(Number(june.purchasesSection.box9_standardRatedPurchases)).toBe(-2_000);
    expect(Number(june.purchasesSection.box13_recoverableInputVat)).toBe(-300);

    // and over BOTH periods the supply nets to what was actually bought
    const both = await inTenant(() => reportsService.vatReturn("2026-05-01", "2026-06-30"));
    expect(Number(both.purchasesSection.box9_standardRatedPurchases)).toBe(8_000);
    expect(Number(both.purchasesSection.box13_recoverableInputVat)).toBe(1_200);
  }, 120_000);

  it("🔴 applying an approved note posts NOTHING — its debit is already in AP — and the bill's outstanding falls", async () => {
    const entriesBefore = await entryCount();
    const apBefore = await gl("AP");

    const before = await inTenant(() => supplierPaymentsService.outstandingOf(billId));
    expect(before).toBe(11_500);

    const out = await inTenant(() => supplierCreditNotesService.apply(noteId, {
      allocations: [{ billId, amount: 2_300 }],
    }, userId));

    // 🔴 NOT ONE new journal entry, and AP did not move a second time
    expect(await entryCount()).toBe(entriesBefore);
    expect(await gl("AP")).toBe(apBefore);

    expect(out.availableAmount).toBe(0);
    expect(await inTenant(() => supplierPaymentsService.outstandingOf(billId))).toBe(9_200);

    // over-applying what is left is refused
    await expectRefusal(inTenant(() => supplierCreditNotesService.apply(noteId, {
      allocations: [{ billId, amount: 100 }],
    }, userId)), 409, "allocation_exceeds_available");
  }, 120_000);

  it("🔴 B6 — the ageing ages what is ACTUALLY owed: the note is not a row, its application reduces the bill, and advances sit BESIDE the buckets", async () => {
    // an advance that settles nothing yet: an ASSET, never a negative payable
    await inTenant(() => supplierPaymentsService.create({
      vendorId, amount: 1_000, bankAccountId: bankId, paidAt: "2026-06-15",
      classification: "advance", reference: "ADV-NOTE-1",
    }, userId));

    const aging = await inTenant(() => reportsService.apAging());

    // 🔴 the note is NOT aged as a row of its own
    expect(aging.items.map((i: { billNumber: string }) => i.billNumber)).toEqual(["NB-1"]);
    // the bill ages at 11,500 − 2,300 applied
    expect(Number(aging.items[0].outstanding)).toBe(9_200);
    expect(Number(aging.total)).toBe(9_200);

    // 🔴 the advance is BESIDE the buckets, never inside one
    expect(Number(aging.assets.supplierAdvances)).toBe(1_000);
    expect(Number(aging.netSupplierPosition)).toBe(8_200);
    // and no bucket absorbed it
    const bucketSum = Object.values(aging.buckets).reduce((s: number, v) => s + Number(v), 0);
    expect(bucketSum).toBe(9_200);
  }, 120_000);

  it("🔴 B5 — the statement's EVENT STREAM and the POSITION agree, and the components map to the GL", async () => {
    const st = await inTenant(() => supplierStatementService.statement(vendorId));

    // the position, component by component
    expect(st.position.payable).toBe(9_200);
    expect(st.position.creditBalance).toBe(0);   // the note is fully applied
    expect(st.position.advanceBalance).toBe(1_000);
    expect(st.position.netPosition).toBe(8_200);

    // 🔴 the two computations, compared — this is the assertion the whole
    // statement exists for, and it is non-vacuous because both sides are
    // non-zero.
    expect(st.reconciliation.agrees, JSON.stringify(st.reconciliation)).toBe(true);
    expect(st.reconciliation.fromEvents).toBe(st.position.netPosition);
    expect(st.position.netPosition).not.toBe(0);

    // every kind of event is present, in business-date order
    const kinds = st.lines.map((l) => l.kind);
    expect(kinds).toContain("bill");
    expect(kinds).toContain("credit_note");
    expect(kinds).toContain("credit_application");
    expect(kinds).toContain("payment");
    const dates = st.lines.map((l) => l.date);
    expect([...dates].sort()).toEqual(dates);

    // 🔴 AND THE COMPONENTS TIE TO THE GENERAL LEDGER. AP carries payable less
    // the credit balance, because a purchase note's debit sits in AP; the
    // advance is its own account.
    expect(-(await gl("AP"))).toBeCloseTo(st.position.payable - st.position.creditBalance, 2);
    expect(await gl("SUPPLIER_ADVANCES")).toBeCloseTo(st.position.advanceBalance, 2);
  }, 120_000);
  it("🔴 A CREDIT NOTE IS NOT SOMETHING YOU OWE: it cannot be paid, and nothing can be allocated TO it", async () => {
    /**
     * 🔴 Both of these were reachable, and both are the same mistake: a
     * posted credit note is a `bills` row in `received` status, exactly like a
     * bill, so every path that keys on STATUS alone would treat it as payable.
     * Found by reading the paths rather than by a failing test — which is why
     * they are asserted here now.
     */
    await expectRefusal(
      inTenant(() => billsService.pay(noteId, { amount: 100, bankAccountId: bankId, paidAt: "2026-07-10" }, userId)),
      409,
    );

    const p = await inTenant(() => supplierPaymentsService.create({
      vendorId, amount: 200, bankAccountId: bankId, paidAt: "2026-07-11",
      classification: "advance", reference: "ADV-TARGET",
    }, userId));
    await expectRefusal(
      inTenant(() => supplierPaymentsService.allocate(p.id, { allocations: [{ billId: noteId, amount: 100 }] }, userId)),
      409, "target_is_a_credit_note",
    );
  }, 120_000);

});
