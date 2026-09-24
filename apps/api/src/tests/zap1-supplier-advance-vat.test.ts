/**
 * Z-AP1 — THE SUPPLIER'S ADVANCE TAX INVOICE (2026-09-24), on real rows.
 * Accountant answer A: claim the input VAT from the supplier's advance tax
 * invoice in THAT invoice's VAT period; the final invoice must never claim it
 * again. Record: docs/product/phase-12-banking-reconciliation-decision-pack.md §8.
 *
 *  1. 🔴 the advance invoice claims its input VAT in ITS period (return + GL);
 *  2. 🔴 the final bill does NOT claim it again — each period exact, the total
 *     over both periods equal to the supply's VAT ONCE;
 *  3. partial application, across two final bills — the deductions sum to the
 *     advance's VAT exactly;
 *  4. two advances deducted by one final bill;
 *  5. corrections: the supplier's credit note against the advance invoice
 *     (VAT reversed in the note's period, then the refund it unlocks); a B7
 *     credit note on the final bill; the folded deduction is never undone;
 *  6. VAT return totals across periods (inside 1–5);
 *  7. closed periods refuse — at entry and at approval, nothing posted;
 *  plus: the invoiced part cannot be spent another way; the database freezes
 *  an approved bill's deductions (proven red without the trigger); the
 *  invariants script SEES a double claim; isolation.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";
import { auditContext } from "../lib/auditContext";
import { billsService } from "../services/bills.service";
import { reportsService } from "../services/reports.service";
import { supplierPaymentsService } from "../services/accounting/supplierPayments.service";
import { supplierAdvanceInvoicesService } from "../services/accounting/supplierAdvanceInvoices.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

describeMaybe("Z-AP1 — supplier advance tax invoice: claimed once (real rows)", () => {
  const SLUG = "zap1-adv", SLUG_B = "zap1-adv-other";
  const EMAIL = "zap1-adv@test.local";
  let orgId = "", companyId = "", userId = 0, vendorId = 0, bankId = 0;
  let orgB = "", companyB = "";

  const inTenant = async <T,>(fn: () => Promise<T>, org = orgId, co = companyId): Promise<T> => {
    const conn = await beginTenantConnection({ organizationId: org, companyId: co, role: "authenticated" });
    try {
      const out = await conn.run(() => auditContext.run({ userId, organizationId: org, ipAddress: null }, fn));
      await conn.commit();
      return out;
    } catch (err) { await conn.rollback(); throw err; }
  };
  const cleanup = async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      for (const slug of [SLUG, SLUG_B]) {
        const org = `(SELECT id FROM organizations WHERE slug = '${slug}')`;
        for (const t of ["bill_prepayments", "supplier_refunds", "supplier_payment_allocation_reversals", "supplier_payment_allocations",
                         "supplier_payment_classifications", "supplier_payments", "bill_payments", "bill_items", "bills",
                         "journal_entry_lines", "journal_entries", "period_locks", "audit_logs",
                         "organization_memberships", "vendors", "bank_accounts", "categories", "companies"]) {
          await client.query(`DELETE FROM ${t} WHERE organization_id IN ${org}`);
        }
        await client.query(`DELETE FROM organizations WHERE slug = '${slug}'`);
      }
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
  const pgCode = (e: unknown) => { const x = e as { code?: string; cause?: { code?: string } }; return x?.code && /^[0-9A-Z]{5}$/.test(x.code) ? x.code : x?.cause?.code; };
  /** Debit − credit on a system account, over the books. */
  const gl = async (code: string) => Number((await pool.query(
    `SELECT coalesce(sum(l.debit_amount - l.credit_amount), 0)::text v FROM journal_entry_lines l
       JOIN journal_entries e ON e.id = l.journal_entry_id JOIN categories c ON c.id = l.account_id
      WHERE e.organization_id = $1 AND c.system_code = $2 AND e.status IN ('posted','reversed')`, [orgId, code])).rows[0].v);
  /** The return's purchase side for one month. */
  const purchases = async (month: string) => {
    const [y, m] = month.split("-").map(Number);
    const last = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
    const r = await inTenant(() => reportsService.vatReturn(`${month}-01`, `${month}-${String(last).padStart(2, "0")}`));
    return { base: Number(r.purchasesSection.box9_standardRatedPurchases), vat: Number(r.purchasesSection.box13_recoverableInputVat) };
  };
  const pay = (amount: number, paidAt: string) =>
    inTenant(() => supplierPaymentsService.create({ vendorId, bankAccountId: bankId, amount, paidAt, classification: "advance" }, userId));
  const advanceInvoice = async (paymentId: number, amount: number, date: string, ref: string) => {
    const d = await inTenant(() => supplierAdvanceInvoicesService.createFromPayment(paymentId, { amount, date, vendorReference: ref }, userId));
    return inTenant(() => billsService.approve(d.id, {}, userId));
  };
  const finalBill = async (net: number, date: string, prepayments: Array<{ advanceBillId: number; amount?: number; taxAmount?: number }>, number: string) => {
    const b = await inTenant(() => billsService.create({ billNumber: number, date, vendorId, items: [{ description: "Supply", quantity: 1, unitPrice: net, vatRate: 15 }], prepayments }, userId));
    return inTenant(() => billsService.approve(b.id, {}, userId));
  };
  const payment = (id: number) => inTenant(() => supplierPaymentsService.getById(id));

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Z-AP1','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (await pool.query(`INSERT INTO companies (organization_id, name) VALUES ($1,'Z-AP1 Co') RETURNING id`, [orgId])).rows[0].id;
    userId = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','Z',' ','admin',true) RETURNING id`)).rows[0].id;
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, orgId]);
    vendorId = (await pool.query(`INSERT INTO vendors (organization_id, name) VALUES ($1,'Najd Steel') RETURNING id`, [orgId])).rows[0].id;
    bankId = (await pool.query(`INSERT INTO bank_accounts (organization_id, company_id, name, bank_name) VALUES ($1,$2,'ZAP Bank','SNB') RETURNING id`, [orgId, companyId])).rows[0].id;
    orgB = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Z-AP1 Other','${SLUG_B}') RETURNING id`)).rows[0].id;
    companyB = (await pool.query(`INSERT INTO companies (organization_id, name) VALUES ($1,'Z-AP1 Other Co') RETURNING id`, [orgB])).rows[0].id;
  }, 120_000);
  afterAll(cleanup);

  let adv1 = 0, pay1 = 0, final1 = 0;

  it("1 🔴 the advance invoice claims its input VAT in ITS period — the return and the GL", async () => {
    const p = await pay(11_500, "2026-03-05");
    pay1 = p.id;
    expect(await gl("SUPPLIER_ADVANCES")).toBeCloseTo(11_500, 2);
    const before = { vatIn: await gl("VAT_INPUT"), march: await purchases("2026-03") };
    const inv = await advanceInvoice(p.id, 11_500, "2026-03-08", "NS-ADV-77");
    adv1 = inv.id;
    expect(inv).toMatchObject({ documentType: "advance_invoice", subtotal: 10_000, vatAmount: 1_500, total: 11_500, advanceSupplierPaymentId: p.id, amountDue: 0 });
    const march = await purchases("2026-03");
    expect(march.base - before.march.base, "March files the advance's base").toBeCloseTo(10_000, 2);
    expect(march.vat - before.march.vat, "March claims the advance's input VAT").toBeCloseTo(1_500, 2);
    expect(await gl("VAT_INPUT") - before.vatIn, "Input VAT receivable up by the claim").toBeCloseTo(1_500, 2);
    expect(await gl("SUPPLIER_ADVANCES"), "the advance asset now holds the net prepayment").toBeCloseTo(10_000, 2);
    expect(await gl("AP"), "an advance invoice owes nothing").toBeCloseTo(0, 2);
    const f = await payment(p.id);
    expect(f).toMatchObject({ advanceInvoicedAmount: 11_500, advanceOpenAmount: 11_500, advanceOpenVat: 1_500, uninvoicedAmount: 0, availableAmount: 11_500 });
  }, 90_000);

  it("2 🔴 the final bill does NOT claim it again — each period exact, 4,500 claimed ONCE over both", async () => {
    const may0 = await purchases("2026-05");
    const b = await finalBill(30_000, "2026-05-10", [{ advanceBillId: adv1 }], "NS-FINAL-1");
    final1 = b.id;
    expect(b).toMatchObject({ total: 34_500, vatAmount: 4_500, prepaidAmount: 11_500, amountDue: 23_000 });
    const may = await purchases("2026-05");
    expect(may.base - may0.base, "May files the supply net of the advance's base").toBeCloseTo(20_000, 2);
    expect(may.vat - may0.vat, "May claims only the VAT the advance did not").toBeCloseTo(3_000, 2);
    const march = await purchases("2026-03");
    expect(march.vat + (may.vat - may0.vat), "over both periods: the supply's VAT, once").toBeCloseTo(1_500 + 3_000, 2);
    // The entry: Dr expense 30,000 · Dr input VAT 3,000 / Cr AP 23,000 · Cr advances 10,000.
    expect(await gl("VAT_INPUT"), "Input VAT = 1,500 + 3,000, never 1,500 + 4,500").toBeCloseTo(4_500, 2);
    expect(await gl("AP"), "AP holds only what is still owed").toBeCloseTo(-23_000, 2);
    expect(await gl("SUPPLIER_ADVANCES")).toBeCloseTo(0, 2);
    const detail = await inTenant(() => billsService.getById(b.id));
    expect(Number(detail.outstanding)).toBeCloseTo(23_000, 2);
    expect(detail.prepayments).toEqual([expect.objectContaining({ advanceBillId: adv1, amount: 11_500, taxableAmount: 10_000, taxAmount: 1_500, finalised: true })]);
    expect(await payment(pay1)).toMatchObject({ availableAmount: 0, advanceAdjustedAmount: 11_500, advanceOpenAmount: 0 });
    // The same advance cannot be deducted twice.
    await expectRefusal(finalBill(1_000, "2026-05-20", [{ advanceBillId: adv1, amount: 100 }], "NS-FINAL-DUP"), 409, "prepayment_exceeds_open");
  }, 90_000);

  it("3 partial application across two final bills — the deductions sum to the advance's VAT exactly", async () => {
    const p = await pay(5_000, "2025-10-02");
    const inv = await advanceInvoice(p.id, 5_000, "2025-10-03", "NS-ADV-P");
    const octVat = (await purchases("2025-10")).vat;
    expect(octVat).toBeCloseTo(652.17, 2); // 5,000 / 1.15 = 4,347.83 + 652.17
    const a = await finalBill(3_000, "2025-11-05", [{ advanceBillId: inv.id, amount: 2_300 }], "NS-P-A");
    expect(a).toMatchObject({ prepaidAmount: 2_300, amountDue: 3_450 - 2_300 });
    expect((await purchases("2025-11")).vat, "November: 450 − 300 deducted").toBeCloseTo(150, 2);
    const open = (await payment(p.id)).advanceInvoices[0]!;
    expect(open.open).toBeCloseTo(2_700, 2);
    // The rest: no amount stated → everything open, the remaining split EXACTLY (no halala drift).
    const b = await finalBill(10_000, "2025-12-05", [{ advanceBillId: inv.id }], "NS-P-B");
    expect(b.prepaidAmount).toBeCloseTo(2_700, 2);
    const deducted = Number((await pool.query(`SELECT sum(tax_amount)::text v FROM bill_prepayments WHERE advance_bill_id = $1`, [inv.id])).rows[0].v);
    expect(deducted, "the two deductions' VAT = the advance invoice's VAT, to the halala").toBeCloseTo(652.17, 2);
    const total = octVat + (await purchases("2025-11")).vat + (await purchases("2025-12")).vat;
    expect(total, "over three periods: the two bills' VAT once (450 + 1,500)").toBeCloseTo(450 + 1_500, 2);
    expect((await payment(p.id)).advanceOpenAmount).toBeCloseTo(0, 2);
  }, 90_000);

  it("4 two advances deducted by one final bill — two folded allocations, both payments spent", async () => {
    const p1 = await pay(1_150, "2025-07-01");
    const p2 = await pay(2_300, "2025-07-02");
    const i1 = await advanceInvoice(p1.id, 1_150, "2025-07-03", "NS-M-1");
    const i2 = await advanceInvoice(p2.id, 2_300, "2025-07-04", "NS-M-2");
    expect((await purchases("2025-07")).vat).toBeCloseTo(150 + 300, 2);
    const b = await finalBill(5_000, "2025-08-10", [{ advanceBillId: i1.id }, { advanceBillId: i2.id }], "NS-M-F");
    expect(b).toMatchObject({ prepaidAmount: 3_450, amountDue: 5_750 - 3_450 });
    expect((await purchases("2025-08")).vat, "750 − 150 − 300").toBeCloseTo(300, 2);
    const allocs = (await pool.query(`SELECT supplier_payment_id, amount::text FROM supplier_payment_allocations WHERE bill_id = $1 ORDER BY supplier_payment_id`, [b.id])).rows;
    expect(allocs.map((a) => [a.supplier_payment_id, Number(a.amount)])).toEqual([[p1.id, 1_150], [p2.id, 2_300]]);
    expect((await payment(p1.id)).availableAmount).toBe(0);
    expect((await payment(p2.id)).availableAmount).toBe(0);
  }, 90_000);

  it("5 corrections: the supplier's credit note reverses the VAT in ITS period and unlocks the refund; a B7 note on the final bill; the folded deduction is never undone", async () => {
    const p = await pay(2_300, "2025-04-01");
    const inv = await advanceInvoice(p.id, 2_300, "2025-04-02", "NS-C-ADV");
    // The invoiced money cannot be spent another way.
    await expectRefusal(inTenant(() => supplierPaymentsService.refund(p.id, { amount: 100, reason: "test" }, userId)), 409, "refund_exceeds_available");
    await expectRefusal(inTenant(() => supplierPaymentsService.classify(p.id, { classification: "security_deposit" }, userId)), 409, "advance_invoiced_cannot_reclassify");
    await expectRefusal(inTenant(() => billsService.pay(inv.id, { amount: 10, bankAccountId: bankId }, userId)), 409);
    await expectRefusal(inTenant(() => supplierAdvanceInvoicesService.createCreditNote(inv.id, { amount: 2_400, vendorReference: "CN-X" }, userId)), 409, "credit_exceeds_open_advance_invoice");
    const vatIn0 = await gl("VAT_INPUT");
    const draft = await inTenant(() => supplierAdvanceInvoicesService.createCreditNote(inv.id, { date: "2025-06-03", vendorReference: "NS-CN-1" }, userId));
    await inTenant(() => billsService.approve(draft.id, {}, userId));
    expect((await purchases("2025-06")).vat, "June: the claim reversed in the note's period").toBeCloseTo(-300, 2);
    expect((await purchases("2025-04")).vat, "April keeps its claim — nothing re-dated").toBeCloseTo(300, 2);
    expect(await gl("VAT_INPUT") - vatIn0).toBeCloseTo(-300, 2);
    expect(await payment(p.id)).toMatchObject({ advanceOpenAmount: 0, uninvoicedAmount: 2_300 });
    await inTenant(() => supplierPaymentsService.refund(p.id, { amount: 2_300, reason: "order cancelled", refundedAt: "2025-06-04" }, userId));
    expect((await payment(p.id)).availableAmount).toBe(0);

    // A B7 credit note on the FINAL bill of test 2: the ordinary purchase-note path, unchanged.
    const cn = await inTenant(() => billsService.create({ billNumber: "NS-FINAL-1-CN", documentType: "credit_note", creditNoteAgainstBillId: final1, date: "2026-06-05", vendorId, items: [{ description: "Price reduction", quantity: 1, unitPrice: 1_000, vatRate: 15 }] }, userId));
    await inTenant(() => billsService.approve(cn.id, {}, userId));
    expect((await purchases("2026-06")).vat, "the B7 note reduces June's input VAT").toBeCloseTo(-150, 2);
    // The folded deduction is corrected by that note, never undone.
    const folded = (await pool.query(`SELECT allocation_id FROM bill_prepayments WHERE bill_id = $1`, [final1])).rows[0].allocation_id;
    await expectRefusal(inTenant(() => supplierPaymentsService.reverseAllocation(folded, { reason: "test" }, userId)), 409, "prepayment_adjustment_immutable");
  }, 90_000);

  it("7 closed periods refuse — at entry and at approval, and nothing is claimed", async () => {
    const p = await pay(1_150, "2025-01-10");
    await pool.query(`INSERT INTO period_locks (organization_id, company_id, period) VALUES ($1,$2,'2025-02')`, [orgId, companyId]);
    await expectRefusal(inTenant(() => supplierAdvanceInvoicesService.createFromPayment(p.id, { amount: 1_150, date: "2025-02-10", vendorReference: "LOCKED" }, userId)), 423);
    const d = await inTenant(() => supplierAdvanceInvoicesService.createFromPayment(p.id, { amount: 1_150, date: "2025-01-20", vendorReference: "NS-L-1" }, userId));
    await pool.query(`INSERT INTO period_locks (organization_id, company_id, period) VALUES ($1,$2,'2025-01')`, [orgId, companyId]);
    const vatIn = await gl("VAT_INPUT");
    await expectRefusal(inTenant(() => billsService.approve(d.id, {}, userId)), 423);
    expect(await gl("VAT_INPUT"), "nothing claimed").toBeCloseTo(vatIn, 2);
    expect((await purchases("2025-01")).vat, "a draft files nothing").toBeCloseTo(0, 2);
    // A final bill dated into a closed month is refused as before.
    await expectRefusal(inTenant(() => billsService.create({ billNumber: "NS-L-F", date: "2025-02-15", vendorId, items: [{ description: "x", quantity: 1, unitPrice: 100, vatRate: 15 }] }, userId)), 423);
    await pool.query(`DELETE FROM period_locks WHERE organization_id = $1 AND period IN ('2025-01','2025-02')`, [orgId]);
  }, 90_000);

  it("🔴 the database freezes an approved bill's deductions, and refuses a deduction joined to the wrong documents", async () => {
    let err: unknown;
    try { await inTenant(() => db.execute(sql`UPDATE bill_prepayments SET tax_amount = 0, taxable_amount = amount WHERE bill_id = ${final1}`)); } catch (e) { err = e; }
    expect(pgCode(err), "an approved bill's deduction cannot be edited").toBe("23514");
    let del: unknown;
    try { await inTenant(() => db.execute(sql`DELETE FROM bill_prepayments WHERE bill_id = ${final1}`)); } catch (e) { del = e; }
    expect(pgCode(del)).toBe("23514");
    // A draft bill cannot join a deduction to something that is not an advance invoice.
    const draft = await inTenant(() => billsService.create({ billNumber: "NS-D-1", date: "2026-07-01", vendorId, items: [{ description: "x", quantity: 1, unitPrice: 100, vatRate: 15 }] }, userId));
    let wrong: unknown;
    try { await pool.query(`INSERT INTO bill_prepayments (organization_id, company_id, bill_id, advance_bill_id, amount, taxable_amount, tax_amount, vat_rate) VALUES ($1,$2,$3,$4,10,10,0,0)`, [orgId, companyId, draft.id, final1]); } catch (e) { wrong = e; }
    expect(pgCode(wrong)).toBe("23514");
  }, 60_000);

  it("🔴 the invariants script SEES an advance invoice's VAT used twice — planted past the triggers, then removed", async () => {
    const { execFileSync } = await import("node:child_process");
    const { mkdtempSync, readFileSync, existsSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const run = (name: string) => {
      const out = join(mkdtempSync(join(tmpdir(), "zap1-inv-")), `${name}.json`);
      try { execFileSync(process.execPath, ["--import", "tsx", "src/scripts/ledgerInvariants.ts", "--json", out], { cwd: join(__dirname, "..", ".."), env: process.env, stdio: "pipe", timeout: 120_000 }); } catch { /* exit 2 is fine; the report is written */ }
      expect(existsSync(out)).toBe(true);
      const report = JSON.parse(readFileSync(out, "utf8")) as Record<string, Array<Record<string, unknown>>>;
      const of = (prefix: string) => (Object.entries(report).find(([k]) => k.startsWith(prefix))?.[1] ?? []).filter((r) => r.org === orgId);
      return { overused: of("advance_invoice_vat_overused"), onAccount: of("ap_on_account_gl_vs_subledger") };
    };
    expect(run("clean"), "the whole scenario leaves both invariants clean").toEqual({ overused: [], onAccount: [] });
    const c = await pool.connect();
    let planted = 0;
    try {
      await c.query("BEGIN"); await c.query("SET LOCAL session_replication_role = replica");
      planted = (await c.query(`INSERT INTO bill_prepayments (organization_id, company_id, bill_id, advance_bill_id, amount, taxable_amount, tax_amount, vat_rate, allocation_id)
                                SELECT organization_id, company_id, bill_id, advance_bill_id, amount, taxable_amount, tax_amount, vat_rate, allocation_id FROM bill_prepayments WHERE bill_id = $1 LIMIT 1
                                ON CONFLICT DO NOTHING RETURNING id`, [final1])).rows[0]?.id;
      if (!planted) {
        planted = (await c.query(`INSERT INTO bill_prepayments (organization_id, company_id, bill_id, advance_bill_id, amount, taxable_amount, tax_amount, vat_rate, allocation_id)
                                  SELECT organization_id, company_id, (SELECT id FROM bills WHERE bill_number = 'NS-M-F' AND organization_id = $2), advance_bill_id, amount, taxable_amount, tax_amount, vat_rate, allocation_id
                                    FROM bill_prepayments WHERE bill_id = $1 RETURNING id`, [final1, orgId])).rows[0].id;
      }
      await c.query("COMMIT");
    } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
    try {
      expect(run("planted").overused.map((r) => r.advance_bill_id), "the instrument sees the second claim").toEqual([adv1]);
    } finally {
      const c2 = await pool.connect();
      try { await c2.query("BEGIN"); await c2.query("SET LOCAL session_replication_role = replica"); await c2.query(`DELETE FROM bill_prepayments WHERE id = $1`, [planted]); await c2.query("COMMIT"); } finally { c2.release(); }
    }
  }, 400_000);

  it("🔴 isolation: another company neither sees these advance invoices nor can deduct them", async () => {
    const mine = await inTenant(() => supplierAdvanceInvoicesService.openForVendor(vendorId));
    const vendorB = (await pool.query(`INSERT INTO vendors (organization_id, name) VALUES ($1,'Other Vendor') RETURNING id`, [orgB])).rows[0].id;
    const theirs = await inTenant(() => supplierAdvanceInvoicesService.openForVendor(vendorB), orgB, companyB);
    expect(theirs).toEqual([]);
    const visible = await inTenant(() => supplierAdvanceInvoicesService.openForVendor(vendorId), orgB, companyB);
    expect(visible, "RLS: none of ours").toEqual([]);
    expect(Array.isArray(mine)).toBe(true);
    await expectRefusal(inTenant(() => billsService.create({ billNumber: "B-X", date: "2026-07-02", vendorId: vendorB, items: [{ description: "x", quantity: 1, unitPrice: 100, vatRate: 15 }], prepayments: [{ advanceBillId: adv1 }] }, userId), orgB, companyB), 422, "advance_invoice_unknown");
  }, 60_000);
});
