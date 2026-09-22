/**
 * ADVANCE PAYMENTS — THE ACCOUNTING-PERIOD CORRECTION AND BAD DEBTS
 * (2026-09-22, on the accountant's answers 1(a), 1(b), 2 and 4).
 * Record: docs/product/advance-payments-decision-pack.md §17.
 *
 *   1(a) tax point = the receipt date: the 386's VAT period, accounting date
 *        and supply date (KSA-5) are the receipt's; its IssueDate is real.
 *   1(b) a locked receipt month FAILS CLOSED with the Art. 63 remedy named.
 *   2    FOUR liabilities, kept apart: unidentified/erroneous receipts,
 *        customer advances, refundable security deposits, credit balances.
 *   4    an Art. 40(9) recovery is a NEW ZATCA document (`recovery_invoice`,
 *        a 388), and the Art. 40(7) relief is a structured, posted fact.
 *
 * Every figure: presence, absence AND movement, on rows the product wrote.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { invoicesService } from "../services/invoices.service";
import { paymentsService } from "../services/payments.service";
import { bankAccountsService } from "../services/bankAccounts.service";
import { reportsService } from "../services/reports.service";
import { depositReviewService } from "../services/depositReview.service";
import { advanceInvoicesService } from "../services/advanceInvoices.service";
import { badDebtService, twelveMonthsAfter } from "../services/badDebt.service";
import { customerStatementService } from "../services/customerStatement.service";
import { customersRepository } from "../repositories/customers.repository";
import { periodLocksService } from "../services/periodLocks.service";
import { loadEInvoiceInput } from "../services/einvoice/einvoiceInput.loader";
import { buildInvoiceXml } from "../services/einvoice/ubl/buildInvoiceXml";
import { splitIssuedAt } from "../services/einvoice/issuedAt";
import { createApproved } from "./helpers/createApproved";
import { businessToday } from "@workspace/shared";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

const SLUG = "ap-corr";
const EMAIL = "ap-corr@test.local";
/** the receipt: 30 January; the 386: issued today (a later month) */
const JAN_RECEIPT = "2026-01-30";
const MAR_DATE = "2026-03-10";

describeMaybe("Advance payments — tax point, the four liabilities, bad-debt relief and the Art. 40(9) document (real rows)", () => {
  let orgId = "";
  let companyId = "";
  let userId = 0;
  let custA = 0;
  let custB = 0;
  let bank = 0;

  const inTenant = async <T,>(fn: () => Promise<T>): Promise<T> => {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
    try {
      const out = await conn.run(() => auditContext.run({ userId, organizationId: orgId, ipAddress: null }, fn));
      await conn.commit();
      return out;
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  };

  const cleanup = async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      const org = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
      for (const t of [
        "invoice_prepayments", "payment_classifications", "customer_refunds", "payment_allocation_reversals", "payment_allocations", "payments",
        "journal_entry_lines", "journal_entries", "invoice_items", "einvoice_documents", "invoices", "customers", "period_locks", "audit_logs",
        "organization_memberships", "bank_accounts", "categories", "companies",
      ]) {
        await client.query(`DELETE FROM ${t} WHERE organization_id IN ${org}`);
      }
      await client.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
      await client.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('AP Correction','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (await pool.query(
      `INSERT INTO companies (organization_id, name, cr_number, vat_number, building_number, street, district, city, postal_code, additional_number)
       VALUES ($1,'Al-Rashid Trading Est.','1010828391','310123456789013','1234','King Fahd Road','Al Olaya','Riyadh','12345','6789') RETURNING id`, [orgId])).rows[0].id;
    userId = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','AP Corr',' ','admin',true) RETURNING id`)).rows[0].id;
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, orgId]);
    custA = (await pool.query(
      `INSERT INTO customers (organization_id, name, tax_number, cr_number, building_number, street, district, city, postal_code, additional_number, province, country)
       VALUES ($1,'Beta Logistics Co.','311987654321003','2020202020','4321','Prince Sultan Street','Al Rawdah','Jeddah','23456','9876','Makkah Region','SA') RETURNING id`, [orgId])).rows[0].id;
    custB = (await pool.query(`INSERT INTO customers (organization_id, name) VALUES ($1,'Hail Supplies') RETURNING id`, [orgId])).rows[0].id;
    bank = (await inTenant(() => bankAccountsService.create({ name: "Riyad Main", bankName: "Riyad Bank", currency: "SAR" }))).id;
  });
  afterAll(cleanup);

  // ── helpers ──────────────────────────────────────────────────────────
  let seq = 0;
  const nextNumber = (prefix: string) => `${prefix}-${String(++seq).padStart(3, "0")}`;
  const receive = (customerId: number, amount: number, extra: Record<string, unknown> = {}) =>
    inTenant(() => paymentsService.receive({ customerId, amount, paidAt: JAN_RECEIPT, bankAccountId: bank, ...extra }, userId));
  const classify = (paymentId: number, classification: string, extra: Record<string, unknown> = {}) =>
    inTenant(() => paymentsService.classify(paymentId, { classification, ...extra }, userId));
  const issueAdvance = async (paymentId: number, amount: number) => {
    const draft = await inTenant(() => advanceInvoicesService.createFromReceipt(paymentId, { amount }, userId));
    return inTenant(() => invoicesService.approve(draft.id, userId));
  };
  const issueInvoice = (customerId: number, net: number, date: string) =>
    inTenant(() =>
      createApproved<Awaited<ReturnType<typeof invoicesService.getById>>>(
        invoicesService,
        { invoiceNumber: nextNumber("APC-INV"), date, dueDate: date, customerId, items: [{ description: "Project", quantity: 1, unitPrice: net, vatRate: 15 }] },
        userId,
      ),
    );
  const getPayment = (id: number) => inTenant(() => paymentsService.get(id));
  const getInvoice = (id: number) => inTenant(() => invoicesService.getById(id));
  const gl = async (code: string, customerId?: number) =>
    Number((await pool.query(
      `SELECT coalesce(sum(l.credit_amount - l.debit_amount), 0)::text AS v
         FROM journal_entry_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN categories c ON c.id = l.account_id
        WHERE e.organization_id = $1 AND c.system_code = $2 AND e.status IN ('posted','reversed') ${customerId != null ? "AND l.customer_id = $3" : ""}`,
      customerId != null ? [orgId, code, customerId] : [orgId, code])).rows[0].v);
  const drGl = async (code: string) => -(await gl(code));
  const journalOf = async (entryNumber: string) =>
    (await pool.query(`SELECT e.id, e.date::text AS date FROM journal_entries e WHERE e.organization_id = $1 AND e.entry_number = $2`, [orgId, entryNumber])).rows[0] ?? null;
  const lines = async (entryNumber: string) =>
    (await pool.query(`SELECT c.system_code, l.debit_amount::text AS d, l.credit_amount::text AS c FROM journal_entry_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN categories c ON c.id = l.account_id WHERE e.organization_id = $1 AND e.entry_number = $2 ORDER BY l.id`, [orgId, entryNumber])).rows.map((r) => [r.system_code, r.d, r.c]);
  const box = async (period: string) => {
    const r = await inTenant(() => reportsService.vatReturn(period, period));
    return { box1: Number(r.salesSection.box1_standardRatedDomesticSales), box6: Number(r.salesSection.box6_vatOnStandardRatedSales), box7: Number(r.salesSection.box7_vatAdjustments), box8: Number(r.salesSection.box8_totalOutputVat), reliefs: r.salesSection.badDebtReliefs };
  };
  const expectRefusal = async (p: Promise<unknown>, status: number, code?: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let err: any;
    try { await p; } catch (e) { err = e; }
    expect(err, "expected a refusal").toBeTruthy();
    expect(err.statusCode ?? err.status, err.message).toBe(status);
    if (code) expect(err.payload?.code ?? err.body?.code ?? err.code).toBe(code);
    return { ...err, body: err.payload ?? err.body ?? {} };
  };
  const depositsInvariantViolations = async () =>
    (await pool.query(`
      WITH gl AS (SELECT l.customer_id, sum(l.credit_amount - l.debit_amount) v FROM journal_entry_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN categories c ON c.id = l.account_id
                   WHERE e.organization_id = $1 AND c.system_code IN ('CUSTOMER_DEPOSITS','UNIDENTIFIED_RECEIPTS','SECURITY_DEPOSITS_HELD') AND e.status IN ('posted','reversed') GROUP BY 1),
           adv AS (SELECT i.customer_id, sum(i.vat_amount::numeric)
                          - coalesce(sum((SELECT coalesce(sum(x.tax_amount), 0) FROM invoice_prepayments x WHERE x.advance_invoice_id = i.id AND x.allocation_id IS NOT NULL)), 0)
                          - coalesce(sum((SELECT coalesce(sum(n.vat_amount::numeric), 0) FROM invoices n WHERE n.original_invoice_id = i.id AND n.document_type = 'advance_credit_note' AND n.invoice_hash IS NOT NULL)), 0) v
                     FROM invoices i WHERE i.organization_id = $1 AND i.document_type = 'advance_invoice' AND i.invoice_hash IS NOT NULL GROUP BY 1),
           sub AS (SELECT p.customer_id,
                          sum(p.amount) - coalesce((SELECT sum(a.amount) FROM payment_allocations a JOIN payments qq ON qq.id = a.payment_id LEFT JOIN payment_allocation_reversals r ON r.allocation_id = a.id WHERE qq.customer_id = p.customer_id AND qq.organization_id = $1 AND r.id IS NULL), 0)
                                      - coalesce((SELECT sum(f.amount) FROM customer_refunds f WHERE f.customer_id = p.customer_id AND f.organization_id = $1 AND f.origin = 'deposit'), 0)
                                      - coalesce((SELECT v FROM adv WHERE adv.customer_id = p.customer_id), 0) v
                     FROM payments p WHERE p.organization_id = $1 AND p.direction = 'in' GROUP BY 1)
      SELECT coalesce(gl.customer_id, sub.customer_id) AS customer_id, coalesce(gl.v,0)::text AS gl, coalesce(sub.v,0)::text AS subledger
        FROM gl FULL JOIN sub ON sub.customer_id = gl.customer_id WHERE coalesce(gl.v,0) <> coalesce(sub.v,0)`, [orgId])).rows;

  // ── A/B: the tax point ───────────────────────────────────────────────
  it("🔴 1(a): a January receipt, a 386 issued later — VAT in JANUARY, the document dated 30 Jan, supply date (KSA-5) 30 Jan, IssueDate the real issuance; the E2 entry dated 30 Jan", async () => {
    const p = await receive(custA, 11_500, { classification: "advance", vatCategory: "S" });
    const jan = await box("2026-01");
    const adv = await issueAdvance(p.id, 11_500);
    expect(adv.date).toBe(JAN_RECEIPT);
    // the accounting date and the VAT period are the receipt's
    expect((await journalOf(`GL-${adv.invoiceNumber}`)).date).toBe(JAN_RECEIPT);
    const janAfter = await box("2026-01");
    expect(janAfter.box1).toBe(Math.round((jan.box1 + 10_000) * 100) / 100);
    expect(janAfter.box6).toBe(Math.round((jan.box6 + 1_500) * 100) / 100);
    const thisMonth = businessToday().slice(0, 7);
    if (thisMonth !== "2026-01") {
      const now = await box(thisMonth);
      expect(now.box6, "nothing of the advance files in the issuance month").toBe(0);
    }
    // the document: three dates kept apart
    const row = (await pool.query(`SELECT issued_at FROM invoices WHERE id = $1`, [adv.id])).rows[0];
    const [issueDate, issueTime] = splitIssuedAt(new Date(row.issued_at));
    expect(issueDate, "IssueDate is the real issuance, never overwritten").toBe(new Date().toISOString().slice(0, 10));
    const input = await inTenant(() => loadEInvoiceInput(adv.id, null));
    expect(input.supplyDate).toBe(JAN_RECEIPT);
    const xml = buildInvoiceXml(input);
    expect(xml).toContain(`<cbc:IssueDate>${issueDate}</cbc:IssueDate>`);
    expect(xml).toContain(`<cbc:IssueTime>${issueTime}</cbc:IssueTime>`);
    expect(xml).toContain(`<cbc:ActualDeliveryDate>${JAN_RECEIPT}</cbc:ActualDeliveryDate>`);
    expect(xml).toContain("<cbc:InvoiceTypeCode name=\"0100000\">386</cbc:InvoiceTypeCode>");
    // an ordinary invoice keeps KSA-5 = its issue date (unchanged behaviour)
    const inv = await issueInvoice(custA, 1_000, MAR_DATE);
    const invInput = await inTenant(() => loadEInvoiceInput(inv.id, null));
    expect(invInput.supplyDate).toBeNull();
    expect(buildInvoiceXml(invInput)).toContain(`<cbc:ActualDeliveryDate>${issueDate}</cbc:ActualDeliveryDate>`);
    expect(await depositsInvariantViolations()).toEqual([]);
  });

  it("🔴 1(b): a January receipt identified as an advance later — VAT in January when January is OPEN; when January is LOCKED the 386 fails closed naming Art. 63 (20 days / SAR 5,000 / the reopen), nothing posts, nothing slides to the current month", async () => {
    const p = await receive(custA, 5_750); // unstated at receipt (presumed deposit)
    const before = await box("2026-01");
    await classify(p.id, "advance", { vatCategory: "S" });
    await inTenant(() => periodLocksService.lock({ period: "2026-01", userId }));
    try {
      const vatBefore = await gl("VAT_OUTPUT");
      const refused = await expectRefusal(inTenant(() => advanceInvoicesService.createFromReceipt(p.id, { amount: 5_750 }, userId)), 423, "advance_tax_point_period_locked");
      expect(refused.body.period).toBe("2026-01");
      expect(refused.body.taxPoint).toBe(JAN_RECEIPT);
      expect(refused.body.error).toMatch(/Art\. 63/);
      expect(refused.body.error).toMatch(/20 days/);
      expect(refused.body.error).toMatch(/5,000/);
      expect(refused.body.error).toMatch(/reopen/i);
      expect(await gl("VAT_OUTPUT"), "nothing posted").toBe(vatBefore);
      expect((await pool.query(`SELECT count(*)::int n FROM invoices WHERE organization_id = $1 AND advance_payment_id = $2`, [orgId, p.id])).rows[0].n).toBe(0);
      expect((await box("2026-01")).box6).toBe(before.box6);
    } finally {
      await inTenant(() => periodLocksService.unlock("2026-01"));
    }
    // reopened: the 386 issues at its tax point
    const adv = await issueAdvance(p.id, 5_750);
    expect(adv.date).toBe(JAN_RECEIPT);
    expect((await box("2026-01")).box6).toBe(Math.round((before.box6 + 750) * 100) / 100);
  });

  // ── C: the four liabilities ──────────────────────────────────────────
  it("🔴 2: four liabilities, kept apart — unstated → presumed deposit; unknown/erroneous → UNIDENTIFIED_RECEIPTS; advance → CUSTOMER_DEPOSITS; security deposit → SECURITY_DEPOSITS_HELD (never an advance, outside VAT, not allocatable); a credit note → CUSTOMER_CREDITS; each reclassification is ONE dated entry between liabilities", async () => {
    const before = { dep: await gl("CUSTOMER_DEPOSITS", custB), unid: await gl("UNIDENTIFIED_RECEIPTS", custB), sec: await gl("SECURITY_DEPOSITS_HELD", custB), cred: await gl("CUSTOMER_CREDITS", custB), vat: await gl("VAT_OUTPUT") };
    // stated AT receipt: the receipt's own entry credits the classification's account
    const unknown = await receive(custB, 1_000, { classification: "unknown" });
    const erroneous = await receive(custB, 2_000, { classification: "erroneous" });
    const advance = await receive(custB, 3_450, { classification: "advance", vatCategory: "S" });
    const security = await receive(custB, 4_000, { classification: "security_deposit" });
    const unstated = await receive(custB, 500);
    expect((await getPayment(unknown.id)).liabilityAccountCode).toBe("UNIDENTIFIED_RECEIPTS");
    expect((await getPayment(erroneous.id)).liabilityAccountCode).toBe("UNIDENTIFIED_RECEIPTS");
    expect((await getPayment(advance.id)).liabilityAccountCode).toBe("CUSTOMER_DEPOSITS");
    expect((await getPayment(security.id)).liabilityAccountCode).toBe("SECURITY_DEPOSITS_HELD");
    expect((await getPayment(unstated.id)).liabilityAccountCode).toBe("CUSTOMER_DEPOSITS");
    expect(await gl("UNIDENTIFIED_RECEIPTS", custB)).toBe(before.unid + 3_000);
    expect(await gl("CUSTOMER_DEPOSITS", custB)).toBe(before.dep + 3_950);
    expect(await gl("SECURITY_DEPOSITS_HELD", custB)).toBe(before.sec + 4_000);
    expect((await lines(`RCPT-${security.id}`)).map(([c, d, cr]) => [c ?? "BANK", d, cr])).toEqual([["BANK", "4000.00", "0.00"], ["SECURITY_DEPOSITS_HELD", "0.00", "4000.00"]]);
    expect(await gl("VAT_OUTPUT"), "no classification decides VAT").toBe(before.vat);
    // a security deposit settles nothing while it is one
    const inv = await issueInvoice(custB, 1_000, MAR_DATE);
    await expectRefusal(inTenant(() => paymentsService.allocate(security.id, { allocations: [{ invoiceId: inv.id, amount: 1_150 }] }, userId)), 409, "security_deposit_not_allocatable");
    // … and a 386 is refused for it (AP-1's rule holds)
    await expectRefusal(inTenant(() => advanceInvoicesService.createFromReceipt(security.id, { amount: 4_000 }, userId)), 409, "advance_invoice_requires_advance_classification");
    // it is refunded from ITS account
    await inTenant(() => paymentsService.refund({ customerId: custB, origin: "deposit", paymentId: security.id, amount: 1_000, bankAccountId: bank, refundedAt: MAR_DATE, reason: "deposit returned" }, userId));
    expect(await gl("SECURITY_DEPOSITS_HELD", custB)).toBe(before.sec + 3_000);
    // reclassified to an advance on a stated date: ONE entry security → deposits for the balance still held; then a 386 is possible
    const re = await classify(security.id, "advance", { vatCategory: "S", effectiveDate: MAR_DATE });
    expect(re.liabilityAccountCode).toBe("CUSTOMER_DEPOSITS");
    expect(re.classification?.effectiveDate).toBe(MAR_DATE);
    const reclass = (await pool.query(`SELECT e.entry_number, e.date::text AS date FROM journal_entries e WHERE e.id = $1`, [re.classification?.reclassificationJournalEntryId])).rows[0];
    expect(reclass.date).toBe(MAR_DATE);
    expect(await lines(reclass.entry_number)).toEqual([["SECURITY_DEPOSITS_HELD", "3000.00", "0.00"], ["CUSTOMER_DEPOSITS", "0.00", "3000.00"]]);
    expect(await gl("SECURITY_DEPOSITS_HELD", custB)).toBe(before.sec);
    // an unknown receipt allocated to an invoice leaves UNIDENTIFIED_RECEIPTS
    await inTenant(() => paymentsService.allocate(unknown.id, { allocations: [{ invoiceId: inv.id, amount: 1_000 }] }, userId));
    expect(await gl("UNIDENTIFIED_RECEIPTS", custB)).toBe(before.unid + 2_000);
    // an erroneous receipt is refunded from it
    await inTenant(() => paymentsService.refund({ customerId: custB, origin: "deposit", paymentId: erroneous.id, amount: 2_000, bankAccountId: bank, refundedAt: MAR_DATE, reason: "sent in error" }, userId));
    expect(await gl("UNIDENTIFIED_RECEIPTS", custB)).toBe(before.unid);
    // a credit note's excess stays a credit balance — the fourth liability, untouched by any of this
    const cn = await inTenant(() => createApproved<Awaited<ReturnType<typeof invoicesService.getById>>>(invoicesService, { invoiceNumber: nextNumber("APC-CN"), date: MAR_DATE, customerId: custB, documentType: "credit_note", originalInvoiceId: inv.id, noteReason: "Goods returned", items: [{ description: "Return", quantity: 1, unitPrice: 200, vatRate: 15 }] }, userId));
    expect(cn.documentType).toBe("credit_note");
    expect(await gl("CUSTOMER_CREDITS", custB)).toBe(before.cred + 80); // 1,150 invoiced, 1,000 allocated → 150 open; the 230 note applies 150 and 80 is a credit balance
    // an advance with an issued 386 cannot leave CUSTOMER_DEPOSITS until the 386 is credited
    await issueAdvance(advance.id, 3_450);
    await expectRefusal(classify(advance.id, "erroneous"), 409, "advance_invoiced_cannot_reclassify");
    // a reclassification into a locked month is refused; before the receipt is refused
    await expectRefusal(classify(unstated.id, "erroneous", { effectiveDate: "2026-01-01" }), 422, "classification_before_receipt");
    await inTenant(() => periodLocksService.lock({ period: "2026-02", userId }));
    try {
      await expectRefusal(classify(unstated.id, "erroneous", { effectiveDate: "2026-02-10" }), 423);
    } finally {
      await inTenant(() => periodLocksService.unlock("2026-02"));
    }
    expect(await depositsInvariantViolations()).toEqual([]);
  });

  // ── D: the exception list keys on the receipt ─────────────────────────
  it("D: the VAT exception list's deadline is the 15th of the month after the RECEIPT, whatever month the 386 is issued in", async () => {
    const p = await receive(custA, 2_300, { classification: "advance", vatCategory: "S" });
    const review = await inTenant(() => depositReviewService.review({ customerId: custA }));
    const item = review.items.find((i) => i.paymentId === p.id)!;
    expect(item.reviewState).toBe("advance_not_invoiced");
    expect(item.deadline).toBe("2026-02-15");
    expect(item.overdue).toBe(true);
    await issueAdvance(p.id, 2_300);
    const after = await inTenant(() => depositReviewService.review({ customerId: custA }));
    expect(after.items.find((i) => i.paymentId === p.id)?.reviewState).toBe("advance_invoiced");
  });

  // ── E/F: bad-debt relief and the Art. 40(9) document ─────────────────
  it("🔴 4: write-off with Art. 40(7) relief (conditions enforced) → the return's box 7 in the claim period → a RECEIPT arrives → the Art. 40(9) RECOVERY INVOICE (388, dated the payment, KSA-5 the payment, BillingReference the original, IssueDate real) → VAT payable again in the payment's period; the chain readable end to end", async () => {
    // an invoice of 2025-01-10 for 10,000 + 1,500, half paid
    const inv = await inTenant(() => createApproved<Awaited<ReturnType<typeof invoicesService.getById>>>(invoicesService, { invoiceNumber: nextNumber("APC-INV"), date: "2025-01-10", dueDate: "2025-02-10", customerId: custA, items: [{ description: "Consulting", quantity: 1, unitPrice: 10_000, vatRate: 15 }] }, userId));
    await inTenant(() => paymentsService.receive({ customerId: custA, amount: 5_750, paidAt: "2025-02-01", bankAccountId: bank, allocations: [{ invoiceId: inv.id, amount: 5_750 }] }, userId));
    expect(Number((await getInvoice(inv.id)).paidAmount)).toBe(5_750);

    // the conditions, refused by name
    await expectRefusal(inTenant(() => badDebtService.writeOffWithRelief(inv.id, { claimedOn: "2025-12-01", certificateRef: "CA-2025-77" }, userId)), 422, "bad_debt_relief_too_early");
    expect(twelveMonthsAfter("2025-01-10")).toBe("2026-01-10");
    await expectRefusal(inTenant(() => badDebtService.writeOffWithRelief(inv.id, { claimedOn: "2026-01-20", certificateRef: "" }, userId)), 400);
    // (legal procedures above 100,000 unpaid)
    const big = await inTenant(() => createApproved<Awaited<ReturnType<typeof invoicesService.getById>>>(invoicesService, { invoiceNumber: nextNumber("APC-INV"), date: "2024-06-01", dueDate: "2024-07-01", customerId: custA, items: [{ description: "Big", quantity: 1, unitPrice: 200_000, vatRate: 15 }] }, userId));
    const before = { ar: await drGl("AR"), vat: await gl("VAT_OUTPUT"), bad: await drGl("BAD_DEBT_EXPENSE"), jan26: await box("2026-01"), mar26: await box("2026-03"), pos: Number((await inTenant(() => customersRepository.customerBalances(custA)))[0]?.receivable ?? 0) };
    await expectRefusal(inTenant(() => badDebtService.writeOffWithRelief(big.id, { claimedOn: "2026-01-20", certificateRef: "CA-1" }, userId)), 422, "bad_debt_legal_procedures_required");
    // a draft, a note, a VAT-only document: refused
    const draft = await inTenant(() => invoicesService.create({ invoiceNumber: nextNumber("APC-INV"), date: MAR_DATE, customerId: custA, items: [{ description: "d", quantity: 1, unitPrice: 10, vatRate: 15 }] }, userId));
    await expectRefusal(inTenant(() => badDebtService.writeOffWithRelief(draft.id, { claimedOn: "2026-01-20", certificateRef: "CA-1" }, userId)), 409, "bad_debt_not_issued");

    // THE WRITE-OFF WITH RELIEF: 5,750 unpaid = 5,000 net + 750 VAT, claimed 20 Jan 2026
    const written = await inTenant(() => badDebtService.writeOffWithRelief(inv.id, { claimedOn: "2026-01-20", certificateRef: "CA-2026-12", note: "customer insolvent" }, userId));
    expect(written.writtenOffAmount).toBe(5_750);
    expect(written.badDebtRelief).toMatchObject({ claimedOn: "2026-01-20", vatAmount: 750, returnPeriod: "2026-01", certificateRef: "CA-2026-12", legalRef: null, source: "recorded" });
    expect(written.status, "the tax invoice stays issued").toBe("sent");
    expect(await lines(`WO-${inv.invoiceNumber}`)).toEqual([["BAD_DEBT_EXPENSE", "5000.00", "0.00"], ["VAT_OUTPUT", "750.00", "0.00"], ["AR", "0.00", "5750.00"]]);
    expect((await journalOf(`WO-${inv.invoiceNumber}`)).date).toBe("2026-01-20");
    expect(await drGl("AR")).toBe(Math.round((before.ar - 5_750) * 100) / 100);
    expect(await gl("VAT_OUTPUT")).toBe(Math.round((before.vat - 750) * 100) / 100);
    // no longer outstanding anywhere: ageing, ledger, statement, position
    const aging = await inTenant(() => reportsService.arAging());
    expect(JSON.stringify(aging)).not.toContain(inv.invoiceNumber);
    const [pos] = await inTenant(() => customersRepository.customerBalances(custA));
    expect(Number(pos?.receivable ?? 0)).toBe(Math.round((before.pos - 5_750) * 100) / 100);
    // the return: box 7 carries the relief in JANUARY 2026 (the claim period), box 8 = box 6 + box 7; the supply's own period is untouched
    const jan = await box("2026-01");
    expect(jan.box7).toBe(Math.round((before.jan26.box7 - 750) * 100) / 100);
    expect(jan.box8).toBe(Math.round((jan.box6 + jan.box7) * 100) / 100);
    expect(jan.reliefs.map((r) => [r.invoiceNumber, r.reliefVat, r.writtenOffAmount])).toContainEqual([inv.invoiceNumber, 750, 5_750]);
    expect((await box("2025-01")).box7).toBe(0);
    // a second write-off is refused; a recovery without money is refused
    await expectRefusal(inTenant(() => badDebtService.writeOffWithRelief(inv.id, { claimedOn: "2026-02-01", certificateRef: "CA-x" }, userId)), 409, "bad_debt_already_written_off");

    // THE RECOVERY: the customer pays 2,300 on 10 Mar 2026, on account (the receivable is gone)
    const rcpt = await inTenant(() => paymentsService.receive({ customerId: custA, amount: 2_300, paidAt: MAR_DATE, bankAccountId: bank, classification: "unknown" }, userId));
    expect((await getPayment(rcpt.id)).liabilityAccountCode).toBe("UNIDENTIFIED_RECEIPTS");
    await expectRefusal(inTenant(() => badDebtService.createRecovery(inv.id, { paymentId: rcpt.id, amount: 6_000 }, userId)), 409, "recovery_exceeds_receipt");
    await expectRefusal(inTenant(() => badDebtService.createRecovery(big.id, { paymentId: rcpt.id, amount: 100 }, userId)), 409, "recovery_requires_relief");
    const draftRec = await inTenant(() => badDebtService.createRecovery(inv.id, { paymentId: rcpt.id, amount: 2_300 }, userId));
    expect(draftRec.documentType).toBe("recovery_invoice");
    expect(draftRec.recoversInvoiceId).toBe(inv.id);
    expect(draftRec.recoveryPaymentId).toBe(rcpt.id);
    expect(draftRec.date, "dated at the tax point — the payment").toBe(MAR_DATE);
    expect([draftRec.subtotal, draftRec.vatAmount, draftRec.total].map(Number)).toEqual([2_000, 300, 2_300]);
    expect(draftRec.icv).toBeNull();
    const vatBeforeIssue = await gl("VAT_OUTPUT");
    // the front door refuses the type; the draft's line is derived; it is not payable
    await expectRefusal(inTenant(() => invoicesService.create({ invoiceNumber: "X", date: MAR_DATE, customerId: custA, documentType: "recovery_invoice", items: [{ description: "x", quantity: 1, unitPrice: 1, vatRate: 15 }] }, userId)), 400, "recovery_invoice_via_recovery");
    await expectRefusal(inTenant(() => invoicesService.update(draftRec.id, { items: [{ description: "x", quantity: 1, unitPrice: 1, vatRate: 15 }] })), 409, "advance_invoice_line_derived");
    // ISSUE it
    const rec = await inTenant(() => invoicesService.approve(draftRec.id, userId));
    expect(rec.status).toBe("paid");
    expect(rec.icv).not.toBeNull();
    expect(await lines(`GL-${rec.invoiceNumber}`)).toEqual([
      ["BAD_DEBT_EXPENSE", "300.00", "0.00"], ["VAT_OUTPUT", "0.00", "300.00"],
      ["UNIDENTIFIED_RECEIPTS", "2300.00", "0.00"], ["BAD_DEBT_EXPENSE", "0.00", "2300.00"],
    ]);
    expect((await journalOf(`GL-${rec.invoiceNumber}`)).date).toBe(MAR_DATE);
    expect(await gl("VAT_OUTPUT")).toBe(Math.round((vatBeforeIssue + 300) * 100) / 100);
    expect((await getPayment(rcpt.id)).unappliedAmount, "the receipt's money is applied to the recovery").toBe(0);
    expect(await drGl("AR"), "no AR from the recovery").toBe(Math.round((before.ar - 5_750) * 100) / 100);
    await expectRefusal(inTenant(() => invoicesService.pay(rec.id, { amount: 1, bankAccountId: bank }, userId)), 409, "recovery_invoice_not_payable");
    // the return: +2,000 / +300 in MARCH (the payment's period), nothing in January
    const mar = await box("2026-03");
    expect(mar.box1).toBe(Math.round((before.mar26.box1 + 2_000) * 100) / 100);
    expect(mar.box6).toBe(Math.round((before.mar26.box6 + 300) * 100) / 100);
    expect((await box("2026-01")).box6).toBe(jan.box6);
    // the document from real rows: 388, BillingReference = the original, KSA-5 = the payment date, IssueDate real, the note explains
    const input = await inTenant(() => loadEInvoiceInput(rec.id, null));
    expect(input.documentType).toBe("recovery_invoice");
    expect(input.billingReference).toEqual({ invoiceNumber: inv.invoiceNumber });
    expect(input.supplyDate).toBe(MAR_DATE);
    expect(input.notes).toMatch(/Art\. 40\(9\)/);
    expect(input.notes).toContain(inv.invoiceNumber);
    const xml = buildInvoiceXml(input);
    expect(xml).toContain("<cbc:InvoiceTypeCode name=\"0100000\">388</cbc:InvoiceTypeCode>");
    expect(xml).toMatch(new RegExp(`<cac:BillingReference>\\s*<cac:InvoiceDocumentReference>\\s*<cbc:ID>${inv.invoiceNumber}</cbc:ID>`));
    expect(xml).toContain(`<cbc:ActualDeliveryDate>${MAR_DATE}</cbc:ActualDeliveryDate>`);
    expect(xml).toContain(`<cbc:IssueDate>${new Date().toISOString().slice(0, 10)}</cbc:IssueDate>`);
    expect(xml).toContain('<cbc:TaxInclusiveAmount currencyID="SAR">2300.00</cbc:TaxInclusiveAmount>');
    expect(xml).toContain('<cbc:PayableAmount currencyID="SAR">2300.00</cbc:PayableAmount>');
    // bounded: a second recovery beyond what was written off is refused; the chain is readable
    const rcpt2 = await inTenant(() => paymentsService.receive({ customerId: custA, amount: 4_000, paidAt: MAR_DATE, bankAccountId: bank, classification: "unknown" }, userId));
    await expectRefusal(inTenant(() => badDebtService.createRecovery(inv.id, { paymentId: rcpt2.id, amount: 4_000 }, userId)), 409, "recovery_exceeds_written_off");
    const rec2Draft = await inTenant(() => badDebtService.createRecovery(inv.id, { paymentId: rcpt2.id, amount: 3_450 }, userId));
    const rec2 = await inTenant(() => invoicesService.approve(rec2Draft.id, userId));
    expect((await inTenant(() => badDebtService.recoveriesOf(inv.id))).map((r) => [r.invoiceNumber, r.total])).toEqual([[rec.invoiceNumber, 2_300], [rec2.invoiceNumber, 3_450]]);
    const stmt = await inTenant(() => customerStatementService.statement(custA, {}));
    const kinds = stmt.lines.filter((l) => [inv.invoiceNumber, rec.invoiceNumber, rec2.invoiceNumber].includes(l.documentNumber ?? "")).map((l) => l.kind);
    expect(kinds).toEqual(expect.arrayContaining(["invoice", "bad_debt_write_off", "recovery_invoice"]));
    const audit = (await pool.query(`SELECT action FROM audit_logs WHERE organization_id = $1 AND entity_type = 'invoice' AND entity_id = $2`, [orgId, String(inv.id)])).rows.map((r) => r.action);
    expect(audit).toContain("write_off");
    expect(await depositsInvariantViolations()).toEqual([]);
  });

  it("🔴 a MIGRATED relief (the previous system claimed it; the item is open here): the receipt settles the item by an ordinary allocation, and the Art. 40(9) invoice carries the VAT leg only, bounded by that allocation — box 7 never carries a migrated relief", async () => {
    // an opening item with the relief recorded as the migration's fact (the Phase 2 writer sets exactly these columns)
    const num = nextNumber("OPEN-MIG");
    const { rows: [row] } = await pool.query(
      `INSERT INTO invoices (organization_id, company_id, invoice_number, date, due_date, customer_id, document_type, status, subtotal, vat_amount, discount, total, currency, paid_amount, is_opening,
                             bad_debt_relief_claimed_on, bad_debt_relief_vat_amount, bad_debt_relief_source, bad_debt_relief_return_period)
       VALUES ($1, $2, $3, '2024-11-01', '2024-12-01', $4, 'invoice', 'sent', 11500, 0, 0, 11500, 'SAR', 0, true, '2025-12-15', 1500, 'migrated', '2025-12') RETURNING id`,
      [orgId, companyId, num, custA]);
    await pool.query(`INSERT INTO invoice_items (organization_id, company_id, invoice_id, description, quantity, unit_price, vat_rate, vat_amount, discount, total, tax_category_code, unit_code) VALUES ($1,$2,$3,'Migrated open item',1,11500,0,0,0,11500,'S','PCE')`, [orgId, companyId, row.id]);
    const openItem = await getInvoice(row.id);
    expect(openItem.badDebtRelief?.source).toBe("migrated");
    // the write-off act is refused on it (the migration's fact, not ours)
    await expectRefusal(inTenant(() => badDebtService.writeOffWithRelief(row.id, { claimedOn: MAR_DATE, certificateRef: "x" }, userId)), 409, "opening_item_relief_is_migration_fact");
    // a recovery before the receipt is allocated: refused
    const rcpt = await inTenant(() => paymentsService.receive({ customerId: custA, amount: 4_600, paidAt: MAR_DATE, bankAccountId: bank }, userId));
    await expectRefusal(inTenant(() => badDebtService.createRecovery(row.id, { paymentId: rcpt.id, amount: 4_600 }, userId)), 409, "recovery_requires_allocation");
    // the D-4 allocation settles the item (the cash side); then the recovery invoice declares the VAT — the VAT leg ONLY
    await inTenant(() => paymentsService.allocate(rcpt.id, { allocations: [{ invoiceId: row.id, amount: 4_600 }] }, userId));
    const vatBefore = await gl("VAT_OUTPUT");
    const badBefore = await drGl("BAD_DEBT_EXPENSE");
    await expectRefusal(inTenant(() => badDebtService.createRecovery(row.id, { paymentId: rcpt.id, amount: 5_000, vatRate: 15 }, userId)), 409, "recovery_exceeds_allocation");
    // the migration recorded no rate for this item, so the rate must be STATED (5% before July 2020, 15% after) — never defaulted
    await expectRefusal(inTenant(() => badDebtService.createRecovery(row.id, { paymentId: rcpt.id, amount: 4_600 }, userId)), 422, "recovery_rate_unknown");
    const recDraft = await inTenant(() => badDebtService.createRecovery(row.id, { paymentId: rcpt.id, amount: 4_600, vatRate: 15 }, userId));
    const rec = await inTenant(() => invoicesService.approve(recDraft.id, userId));
    expect(rec.status, "no cash application of its own — the allocation did that").toBe("sent");
    expect(await lines(`GL-${rec.invoiceNumber}`)).toEqual([["BAD_DEBT_EXPENSE", "600.00", "0.00"], ["VAT_OUTPUT", "0.00", "600.00"]]);
    expect(await gl("VAT_OUTPUT")).toBe(Math.round((vatBefore + 600) * 100) / 100);
    expect(await drGl("BAD_DEBT_EXPENSE")).toBe(Math.round((badBefore + 600) * 100) / 100);
    // the migrated relief is not in OUR return's box 7 — it was in the previous system's
    expect((await box("2025-12")).reliefs.map((r) => r.invoiceNumber)).not.toContain(num);
    // a second recovery for the same allocation is refused (declared once)
    await expectRefusal(inTenant(() => badDebtService.createRecovery(row.id, { paymentId: rcpt.id, amount: 1, vatRate: 15 }, userId)), 409, "recovery_exceeds_allocation");
    expect(await depositsInvariantViolations()).toEqual([]);
  });

  it("every journal posted by this suite balances; the recovery invoice never carries AR, revenue or a bank line; the write-off never touches a deposit liability", async () => {
    const unbalanced = (await pool.query(`SELECT e.entry_number FROM journal_entries e JOIN journal_entry_lines l ON l.journal_entry_id = e.id WHERE e.organization_id = $1 GROUP BY e.id HAVING sum(l.debit_amount) <> sum(l.credit_amount)`, [orgId])).rows;
    expect(unbalanced).toEqual([]);
    const forbidden = (await pool.query(`
      SELECT e.entry_number, c.system_code FROM journal_entries e JOIN journal_entry_lines l ON l.journal_entry_id = e.id JOIN categories c ON c.id = l.account_id
       WHERE e.organization_id = $1 AND (
         (e.entry_number IN (SELECT 'GL-' || invoice_number FROM invoices WHERE organization_id = $1 AND document_type = 'recovery_invoice') AND (c.system_code IN ('AR','SALES') OR c.bank_account_id IS NOT NULL))
         OR (e.entry_number LIKE 'WO-%' AND c.system_code IN ('CUSTOMER_DEPOSITS','UNIDENTIFIED_RECEIPTS','SECURITY_DEPOSITS_HELD','CUSTOMER_CREDITS','SALES')))`, [orgId])).rows;
    expect(forbidden).toEqual([]);
  });
});
