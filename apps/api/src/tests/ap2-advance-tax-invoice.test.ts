/**
 * AP-2 (2026-09-21) — THE ADVANCE TAX INVOICE (ZATCA type 386) and the FINAL
 * invoice's PREPAYMENT ADJUSTMENT.
 * Decision record: docs/product/advance-payments-decision-pack.md §6 (E2 /
 * E3 — accountant A2), §14 (as built). Authority: GCC VAT Agreement Art.
 * 23(1); IR Art. 53(1)(a)(2); ZATCA XML Implementation Standard v1.2 ¶9.5.
 *
 * Every figure is asserted with presence, absence AND movement, on rows the
 * product's own write paths produced:
 *   - E2 at the 386: Dr Customer deposits [VAT] / Cr VAT_OUTPUT, and NOTHING
 *     else moves (AR, revenue, bank, the three position components);
 *   - E3 at the 388: Dr AR (due) · Dr deposits (net advance) / Cr revenue
 *     (full) · Cr VAT_OUTPUT (full − advance VAT) — the VAT declared once;
 *   - the receipt's un-invoiced remainder is the ONLY part a D-4 allocation
 *     or a refund may touch (G-Z-3 fail-closed);
 *   - every AR reader (list totals, ageing, position, ledger, analytics)
 *     ignores the 386; the VAT return files the 386 in its period and the
 *     388 NET; the statement shows the 386 at zero movement, reconciled;
 *   - the folded allocation is immutable; a D-4 allocation stays correctable.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { invoicesService } from "../services/invoices.service";
import { paymentsService } from "../services/payments.service";
import { bankAccountsService } from "../services/bankAccounts.service";
import { reportsService } from "../services/reports.service";
import { depositReviewService, reviewStateOf } from "../services/depositReview.service";
import { advanceInvoicesService, splitGross } from "../services/advanceInvoices.service";
import { customerStatementService } from "../services/customerStatement.service";
import { customersRepository } from "../repositories/customers.repository";
import { analyticsRepository } from "../repositories/analytics.repository";
import { journalEntriesRepository } from "../repositories/journalEntries.repository";
import { periodLocksService } from "../services/periodLocks.service";
import { loadEInvoiceInput } from "../services/einvoice/einvoiceInput.loader";
import { buildInvoiceXml } from "../services/einvoice/ubl/buildInvoiceXml";
import { createApproved } from "./helpers/createApproved";
import { businessToday } from "@workspace/shared";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

const SLUG = "ap2-adv";
const SLUG_OTHER = "ap2-adv-other";
const EMAIL = "ap2-adv@test.local";
const RECEIPT_DATE = "2026-06-15";
const FINAL_DATE = "2026-07-10";

describe("AP-2 — pure helpers", () => {
  it("splitGross: a VAT-inclusive amount splits to the halala with taxable + VAT = amount and VAT = taxable × rate (the standard's own example: 100 → 86.96 + 13.04)", () => {
    expect(splitGross(100, 15)).toEqual({ taxable: 86.96, vat: 13.04 });
    expect(splitGross(11_500, 15)).toEqual({ taxable: 10_000, vat: 1_500 });
    expect(splitGross(1.15, 15)).toEqual({ taxable: 1, vat: 0.15 });
    expect(splitGross(5_750, 0)).toEqual({ taxable: 5_750, vat: 0 });
    // every amount in a sweep splits exactly, or is refused — never stored inconsistent
    for (let c = 1; c <= 20_000; c += 7) {
      const amount = c / 100;
      try {
        const { taxable, vat } = splitGross(amount, 15);
        expect(Math.round((taxable + vat) * 100)).toBe(Math.round(amount * 100));
        expect(Math.abs(vat - Math.round(taxable * 15) / 100)).toBeLessThanOrEqual(0.01 + 1e-9); // a halala of rounding, plus float epsilon
      } catch (e) {
        expect((e as { payload?: { code?: string } }).payload?.code).toBe("advance_amount_does_not_split");
      }
    }
  });
  it("review state: an advance with an un-invoiced remainder needs a 386; one fully covered is advance_invoiced (no review)", () => {
    expect(reviewStateOf({ source: "manual", migrationVatPosition: null, classification: "advance", uninvoiced: 100 })).toEqual({ state: "advance_not_invoiced", needsReview: true });
    expect(reviewStateOf({ source: "manual", migrationVatPosition: null, classification: "advance", uninvoiced: 0 })).toEqual({ state: "advance_invoiced", needsReview: false });
  });
});

describeMaybe("AP-2 — advance tax invoice 386 and the prepayment adjustment (real rows)", () => {
  let orgId = "";
  let companyId = "";
  let otherOrgId = "";
  let otherCompanyId = "";
  let userId = 0;
  let custA = 0;
  let custB = 0;
  let custOther = 0;
  let bank = 0;
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
  const inOther = <T,>(fn: () => Promise<T>) => tenant(otherOrgId, otherCompanyId)(fn);

  const cleanup = async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      for (const slug of [SLUG, SLUG_OTHER]) {
        const org = `(SELECT id FROM organizations WHERE slug = '${slug}')`;
        for (const t of [
          "invoice_prepayments", "payment_classifications", "customer_refunds", "payment_allocation_reversals", "payment_allocations", "payments",
          "journal_entry_lines", "journal_entries", "invoice_items", "einvoice_documents", "invoices", "customers", "period_locks", "audit_logs",
          "organization_memberships", "bank_accounts", "categories", "companies",
        ]) {
          await client.query(`DELETE FROM ${t} WHERE organization_id IN ${org}`);
        }
        await client.query(`DELETE FROM organizations WHERE slug = '${slug}'`);
      }
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
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('AP2 Org','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (await pool.query(
      `INSERT INTO companies (organization_id, name, name_ar, cr_number, vat_number, building_number, street, district, city, postal_code, additional_number)
       VALUES ($1,'AP2 Co','شركة','1010828281','399999999988913','1234','King Fahd Road','Al Olaya','Riyadh','12345','6789') RETURNING id`, [orgId])).rows[0].id;
    otherOrgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('AP2 Other','${SLUG_OTHER}') RETURNING id`)).rows[0].id;
    otherCompanyId = (await pool.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'AP2 Other Co','1010828283','399999999988933') RETURNING id`, [otherOrgId])).rows[0].id;
    userId = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','AP2',' ','admin',true) RETURNING id`)).rows[0].id;
    for (const o of [orgId, otherOrgId]) await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, o]);
    // A VAT-registered buyer with a full national address ⇒ STANDARD documents (subtype 01).
    custA = (await pool.query(
      `INSERT INTO customers (organization_id, name, name_ar, tax_number, cr_number, building_number, street, district, city, postal_code, additional_number, province, country)
       VALUES ($1,'Najd Trading','تجارة نجد','311987654321003','2020202020','4321','Prince Sultan Street','Al Rawdah','Jeddah','23456','9876','Makkah Region','SA') RETURNING id`, [orgId])).rows[0].id;
    custB = (await pool.query(`INSERT INTO customers (organization_id, name) VALUES ($1,'Hail Supplies') RETURNING id`, [orgId])).rows[0].id;
    custOther = (await pool.query(`INSERT INTO customers (organization_id, name) VALUES ($1,'Other Customer') RETURNING id`, [otherOrgId])).rows[0].id;
    bank = (await inTenant(() => bankAccountsService.create({ name: "Riyad Main", bankName: "Riyad Bank", currency: "SAR" }))).id;
    bankOther = (await inOther(() => bankAccountsService.create({ name: "Other Main", bankName: "ANB", currency: "SAR" }))).id;
  });
  afterAll(cleanup);

  // ── helpers ──────────────────────────────────────────────────────────
  let seq = 0;
  const nextNumber = (prefix: string) => `${prefix}-${String(++seq).padStart(3, "0")}`;
  const receive = (customerId: number, amount: number, extra: Record<string, unknown> = {}) =>
    inTenant(() => paymentsService.receive({ customerId, amount, paidAt: RECEIPT_DATE, bankAccountId: bank, ...extra }, userId));
  /** A receipt on account, classified as an advance at receipt (S unless stated). */
  const receiveAdvance = (customerId: number, amount: number, vatCategory: "S" | "Z" | "E" = "S", extra: Record<string, unknown> = {}) =>
    receive(customerId, amount, { classification: "advance", vatCategory, ...extra });
  const draftAdvance = (paymentId: number, amount: number, extra: Record<string, unknown> = {}) =>
    inTenant(() => advanceInvoicesService.createFromReceipt(paymentId, { amount, ...extra }, userId));
  const issueAdvance = async (paymentId: number, amount: number, extra: Record<string, unknown> = {}) => {
    const draft = await draftAdvance(paymentId, amount, extra);
    return inTenant(() => invoicesService.approve(draft.id, userId));
  };
  const issueFinal = (customerId: number, net: number, prepayments: Array<{ advanceInvoiceId: number; amount?: number }> = [], extra: Record<string, unknown> = {}) =>
    inTenant(() =>
      createApproved<Awaited<ReturnType<typeof invoicesService.getById>>>(
        invoicesService,
        { invoiceNumber: nextNumber("AP2-INV"), date: FINAL_DATE, dueDate: FINAL_DATE, customerId, items: [{ description: "Project", quantity: 1, unitPrice: net, vatRate: 15 }], prepayments, ...extra },
        userId,
      ),
    );
  const getInvoice = (id: number) => inTenant(() => invoicesService.getById(id));
  const getPayment = (id: number) => inTenant(() => paymentsService.get(id));
  /** GL balance (credit − debit) of a system account for this org, optionally for one customer party. */
  const gl = async (code: string, customerId?: number) =>
    Number((await pool.query(
      `SELECT coalesce(sum(l.credit_amount - l.debit_amount), 0)::text AS v
         FROM journal_entry_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN categories c ON c.id = l.account_id
        WHERE e.organization_id = $1 AND c.system_code = $2 AND e.status IN ('posted','reversed') ${customerId != null ? "AND l.customer_id = $3" : ""}`,
      customerId != null ? [orgId, code, customerId] : [orgId, code])).rows[0].v);
  const bankGl = async () =>
    Number((await pool.query(
      `SELECT coalesce(sum(l.debit_amount - l.credit_amount), 0)::text AS v
         FROM journal_entry_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN categories c ON c.id = l.account_id
        WHERE e.organization_id = $1 AND c.bank_account_id = $2 AND e.status IN ('posted','reversed')`, [orgId, bank])).rows[0].v);
  const position = async (customerId: number) => {
    const [row] = await inTenant(() => customersRepository.customerBalances(customerId));
    return { receivable: row?.receivable ?? 0, creditBalance: row?.creditBalance ?? 0, depositBalance: row?.depositBalance ?? 0 };
  };
  const journalOf = async (entryNumber: string) =>
    (await pool.query(`SELECT e.id, e.date::text AS date, e.status FROM journal_entries e WHERE e.organization_id = $1 AND e.entry_number = $2`, [orgId, entryNumber])).rows[0] ?? null;
  const vatReturn = (period: string) => inTenant(() => reportsService.vatReturn(period, period));
  const box = async (period: string) => {
    const r = await vatReturn(period);
    return { box1: Number(r.salesSection.box1_standardRatedDomesticSales), box6: Number(r.salesSection.box6_vatOnStandardRatedSales) };
  };
  /** The deposits invariant of scripts/ledgerInvariants.ts, for this org: GL CUSTOMER_DEPOSITS = subledger − open advance-invoice VAT, per customer. */
  const depositsInvariantViolations = async () =>
    (await pool.query(`
      WITH gl AS (SELECT l.customer_id, sum(l.credit_amount - l.debit_amount) v FROM journal_entry_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN categories c ON c.id = l.account_id
                   WHERE e.organization_id = $1 AND c.system_code = 'CUSTOMER_DEPOSITS' AND e.status IN ('posted','reversed') GROUP BY 1),
           adv AS (SELECT i.customer_id, sum(i.vat_amount::numeric) - coalesce(sum((SELECT coalesce(sum(x.tax_amount), 0) FROM invoice_prepayments x WHERE x.advance_invoice_id = i.id AND x.allocation_id IS NOT NULL)), 0) v
                     FROM invoices i WHERE i.organization_id = $1 AND i.document_type = 'advance_invoice' AND i.invoice_hash IS NOT NULL GROUP BY 1),
           sub AS (SELECT p.customer_id,
                          sum(p.amount) - coalesce((SELECT sum(a.amount) FROM payment_allocations a JOIN payments qq ON qq.id = a.payment_id LEFT JOIN payment_allocation_reversals r ON r.allocation_id = a.id WHERE qq.customer_id = p.customer_id AND qq.organization_id = $1 AND r.id IS NULL), 0)
                                      - coalesce((SELECT sum(f.amount) FROM customer_refunds f WHERE f.customer_id = p.customer_id AND f.organization_id = $1 AND f.origin = 'deposit'), 0)
                                      - coalesce((SELECT v FROM adv WHERE adv.customer_id = p.customer_id), 0) v
                     FROM payments p WHERE p.organization_id = $1 AND p.direction = 'in' GROUP BY 1)
      SELECT coalesce(gl.customer_id, sub.customer_id) AS customer_id, coalesce(gl.v,0)::text AS gl, coalesce(sub.v,0)::text AS subledger
        FROM gl FULL JOIN sub ON sub.customer_id = gl.customer_id WHERE coalesce(gl.v,0) <> coalesce(sub.v,0)`, [orgId])).rows;
  const expectRefusal = async (p: Promise<unknown>, status: number, code?: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let err: any;
    try { await p; } catch (e) { err = e; }
    expect(err, "expected a refusal").toBeTruthy();
    expect(err.statusCode ?? err.status).toBe(status);
    if (code) expect(err.body?.code ?? err.payload?.code ?? err.code).toBe(code);
    return { ...err, body: err.payload ?? err.body ?? {} };
  };

  // ── 1, 5, 6: the genuine taxable advance and its entry ───────────────
  it("🔴 a genuine taxable advance → a 386 (draft, then issued): total = the gross received, subtotal + VAT its split, receipt named; E2 posts Dr Customer deposits [VAT] / Cr VAT_OUTPUT and NOTHING else moves", async () => {
    const p = await receiveAdvance(custA, 11_500);
    const before = { deposits: await gl("CUSTOMER_DEPOSITS", custA), vat: await gl("VAT_OUTPUT"), ar: await gl("AR", custA), sales: await gl("SALES"), bank: await bankGl(), pos: await position(custA) };
    expect(before.deposits).toBe(11_500);

    const draft = await draftAdvance(p.id, 11_500);
    expect(draft.documentType).toBe("advance_invoice");
    expect(draft.status).toBe("draft");
    expect(draft.advancePaymentId).toBe(p.id);
    expect(draft.customerId).toBe(custA);
    expect(draft.date).toBe(RECEIPT_DATE); // the tax point: the receipt date (its month is open)
    expect(draft.total).toBe(11_500);
    expect(draft.subtotal).toBe(10_000);
    expect(draft.vatAmount).toBe(1_500);
    expect(draft.items).toHaveLength(1);
    expect(draft.items[0]!.vatRate).toBe(15);
    expect(draft.icv).toBeNull();
    expect(draft.prepaidAmount).toBe(0);
    // a draft declares nothing: the receipt's figures and the GL are untouched
    const pDraft = await getPayment(p.id);
    expect(pDraft.advanceInvoicedAmount).toBe(0);
    expect(pDraft.uninvoicedAmount).toBe(11_500);
    expect(pDraft.advanceInvoices.map((a) => [a.id, a.status, a.openAmount])).toEqual([[draft.id, "draft", 0]]);
    expect(await gl("VAT_OUTPUT")).toBe(before.vat);

    const issued = await inTenant(() => invoicesService.approve(draft.id, userId));
    expect(issued.status).toBe("sent");
    expect(issued.icv).not.toBeNull();
    expect(issued.invoiceHash).not.toBeNull();
    expect(issued.zatcaUuid).not.toBeNull();
    // E2 — and only E2
    expect(await gl("CUSTOMER_DEPOSITS", custA)).toBe(before.deposits - 1_500);
    expect(await gl("VAT_OUTPUT")).toBe(before.vat + 1_500);
    expect(await gl("AR", custA)).toBe(before.ar);
    expect(await gl("SALES")).toBe(before.sales);
    expect(await bankGl()).toBe(before.bank);
    const je = await journalOf(`GL-${issued.invoiceNumber}`);
    expect(je).toBeTruthy();
    expect(je.date).toBe(RECEIPT_DATE);
    expect(je.status).toBe("posted");
    // the three position components: unchanged — the 386 is not a receivable, and the deposit (cash on account) is still the gross
    expect(await position(custA)).toEqual(before.pos);
    // the receipt now carries the advance figures: the whole deposit is covered, none is un-invoiced
    const pAfter = await getPayment(p.id);
    expect(pAfter.unappliedAmount).toBe(11_500);
    expect(pAfter.advanceInvoicedAmount).toBe(11_500);
    expect(pAfter.advanceAdjustedAmount).toBe(0);
    expect(pAfter.advanceOpenAmount).toBe(11_500);
    expect(pAfter.uninvoicedAmount).toBe(0);
    expect(pAfter.advanceInvoices[0]).toMatchObject({ id: issued.id, status: "sent", total: 11_500, vatAmount: 1_500, vatCategory: "S", adjustedAmount: 0, openAmount: 11_500 });
    expect(await depositsInvariantViolations()).toEqual([]);
  });

  // ── 2, 3, 4: what NEVER gets a 386 ───────────────────────────────────
  it("🔴 an erroneous overpayment, a security deposit and an unclassified receipt are REFUSED a 386 by name (accountant A1); a migrated opening deposit too (Z1); nothing is written", async () => {
    const countBefore = Number((await pool.query(`SELECT count(*)::text AS n FROM invoices WHERE organization_id = $1 AND document_type = 'advance_invoice'`, [orgId])).rows[0].n);
    const erroneous = await receive(custA, 900, { classification: "erroneous" });
    const security = await receive(custA, 800, { classification: "security_deposit" });
    const unknown = await receive(custA, 700);
    const e1 = await expectRefusal(draftAdvance(erroneous.id, 900), 409, "advance_invoice_requires_advance_classification");
    expect(e1.body.classification).toBe("erroneous");
    const e2 = await expectRefusal(draftAdvance(security.id, 800), 409, "advance_invoice_requires_advance_classification");
    expect(e2.body.classification).toBe("security_deposit");
    const e3 = await expectRefusal(draftAdvance(unknown.id, 700), 409, "advance_invoice_requires_advance_classification");
    expect(e3.body.classification).toBe("unknown");
    // an advance with no VAT category cannot declare VAT at any category
    const noCat = await receive(custA, 600, { classification: "advance" });
    await expectRefusal(draftAdvance(noCat.id, 600), 422, "advance_vat_category_required");
    // a migrated opening deposit is the previous system's VAT record (Z1 open)
    const opening = await pool.query(
      `INSERT INTO payments (organization_id, company_id, direction, party_type, customer_id, bank_account_id, amount, paid_at, source, journal_entry_id)
       SELECT $1, $2, 'in', 'customer', $3, $4, 3000, '2026-01-01', 'opening', (SELECT id FROM journal_entries WHERE organization_id = $1 ORDER BY id LIMIT 1) RETURNING id`,
      [orgId, companyId, custA, bank]);
    await expectRefusal(draftAdvance(opening.rows[0].id, 3000), 409, "opening_deposit_not_advance_invoiced");
    await pool.query(`DELETE FROM payments WHERE id = $1`, [opening.rows[0].id]);
    // the classification path itself (the AP-1 record) is the ONE model: reclassifying the erroneous receipt as an advance unlocks it
    await inTenant(() => paymentsService.classify(erroneous.id, { classification: "advance", vatCategory: "S" }, userId));
    const d = await draftAdvance(erroneous.id, 900);
    expect(d.total).toBe(900);
    const countAfter = Number((await pool.query(`SELECT count(*)::text AS n FROM invoices WHERE organization_id = $1 AND document_type = 'advance_invoice'`, [orgId])).rows[0].n);
    expect(countAfter).toBe(countBefore + 1);
    await inTenant(() => invoicesService.deleteDraft(d.id));
    // and the front door refuses the type outright: a 386 is never created from nothing
    await expectRefusal(inTenant(() => invoicesService.create({ date: RECEIPT_DATE, customerId: custA, documentType: "advance_invoice", items: [{ description: "x", quantity: 1, unitPrice: 100 }] }, userId)), 400, "advance_invoice_via_receipt");
  });

  // ── 7: the VAT amount, and the return ────────────────────────────────
  it("🔴 the VAT is exactly the gross × 15/115 and the return files the 386 in ITS period (box 1 + box 6 move) and not in the next", async () => {
    const p = await receiveAdvance(custB, 2_300);
    const june = await box("2026-06");
    const july = await box("2026-07");
    const issued = await issueAdvance(p.id, 2_300);
    expect(issued.vatAmount).toBe(300);
    expect(issued.subtotal).toBe(2_000);
    const juneAfter = await box("2026-06");
    expect(juneAfter.box1).toBeCloseTo(june.box1 + 2_000, 2);
    expect(juneAfter.box6).toBeCloseTo(june.box6 + 300, 2);
    expect(await box("2026-07")).toEqual(july);
    // a zero-rated advance is a document with no VAT and no entry
    const pz = await receiveAdvance(custB, 1_000, "Z");
    const z = await issueAdvance(pz.id, 1_000, { taxExemptionReasonCode: "VATEX-SA-32", taxExemptionReasonText: "Export of goods" });
    expect(z.vatAmount).toBe(0);
    expect(z.subtotal).toBe(1_000);
    expect(await journalOf(`GL-${z.invoiceNumber}`)).toBeNull();
    await expectRefusal(draftAdvance((await receiveAdvance(custB, 500, "E")).id, 500), 422, "advance_exemption_reason_required");
  });

  // ── 8: the document ──────────────────────────────────────────────────
  it("🔴 the 386's UBL from REAL rows carries InvoiceTypeCode 386 (subtype 01 — a VAT-registered buyer), the split, PrepaidAmount 0.00 and no adjustment line", async () => {
    const p = await receiveAdvance(custA, 4_600);
    const issued = await issueAdvance(p.id, 4_600);
    const input = await inTenant(() => loadEInvoiceInput(issued.id, null));
    expect(input.documentType).toBe("advance_invoice");
    expect(input.prepaymentAdjustments).toEqual([]);
    const xml = buildInvoiceXml(input);
    expect(xml).toContain('<cbc:InvoiceTypeCode name="0100000">386</cbc:InvoiceTypeCode>');
    expect(xml).toContain(`<cbc:ID>${issued.invoiceNumber}</cbc:ID>`);
    expect(xml).toContain('<cbc:TaxInclusiveAmount currencyID="SAR">4600.00</cbc:TaxInclusiveAmount>');
    expect(xml).toContain('<cbc:PrepaidAmount currencyID="SAR">0.00</cbc:PrepaidAmount>');
    expect(xml).toContain('<cbc:PayableAmount currencyID="SAR">4600.00</cbc:PayableAmount>');
    expect(xml).toContain('<cbc:TaxAmount currencyID="SAR">600.00</cbc:TaxAmount>');
    expect(xml).not.toContain("Prepayment adjustment");
  });

  // ── 9–14: the final invoice ──────────────────────────────────────────
  it("🔴 PARTIAL advance: the final invoice references the 386 (¶9.5 line, PrepaidAmount incl. VAT, PayableAmount net), posts E3 once (VAT not double-recognised), clears the deposit and leaves only the remaining AR", async () => {
    const p = await receiveAdvance(custA, 11_500);
    const adv = await issueAdvance(p.id, 11_500);
    const before = { deposits: await gl("CUSTOMER_DEPOSITS", custA), vat: await gl("VAT_OUTPUT"), ar: await gl("AR", custA), sales: await gl("SALES"), bank: await bankGl(), june: await box("2026-06"), july: await box("2026-07"), pos: await position(custA) };

    // the DRAFT states the selection; it reserves nothing
    const draft = await inTenant(() => invoicesService.create({ invoiceNumber: nextNumber("AP2-INV"), date: FINAL_DATE, dueDate: FINAL_DATE, customerId: custA, items: [{ description: "Consulting project", quantity: 1, unitPrice: 30_000, vatRate: 15 }], prepayments: [{ advanceInvoiceId: adv.id }] }, userId));
    expect(draft.total).toBe(34_500);
    expect(draft.prepayments).toHaveLength(1);
    expect(draft.prepayments[0]).toMatchObject({ advanceInvoiceId: adv.id, advanceInvoiceNumber: adv.invoiceNumber, amount: 11_500, taxableAmount: 10_000, taxAmount: 1_500, taxCategoryCode: "S", vatRate: 15, allocationId: null });
    expect(draft.prepaidAmount).toBe(11_500);
    expect(draft.amountDue).toBe(23_000);
    expect((await getPayment(p.id)).advanceOpenAmount).toBe(11_500);
    expect((await getPayment(p.id)).unappliedAmount).toBe(11_500);
    expect(await gl("VAT_OUTPUT")).toBe(before.vat);

    const issued = await inTenant(() => invoicesService.approve(draft.id, userId));
    expect(issued.status).toBe("sent");
    expect(issued.paidAmount).toBe(11_500); // the folded advance sits in the cash cache
    expect(issued.creditedAmount).toBe(0);
    const full = await getInvoice(issued.id);
    expect(full.prepayments[0]!.allocationId).not.toBeNull();
    expect(full.amountDue).toBe(23_000);

    // E3: Dr AR 23,000 · Dr deposits 10,000 / Cr Sales 30,000 · Cr VAT 3,000 — and nothing to the bank
    expect(await gl("AR", custA)).toBe(before.ar - 23_000);
    expect(await gl("CUSTOMER_DEPOSITS", custA)).toBe(before.deposits - 10_000);
    expect(await gl("SALES")).toBe(before.sales + 30_000);
    expect(await gl("VAT_OUTPUT")).toBe(before.vat + 3_000);
    expect(await bankGl()).toBe(before.bank);
    const je = await journalOf(`GL-${issued.invoiceNumber}`);
    expect(je.date).toBe(FINAL_DATE);
    // the VAT over both documents equals 15% of the supply, once: 1,500 (June, the 386) + 3,000 (July, the 388)
    expect((await box("2026-06"))).toEqual(before.june);
    const julyAfter = await box("2026-07");
    expect(julyAfter.box1).toBeCloseTo(before.july.box1 + 20_000, 2);
    expect(julyAfter.box6).toBeCloseTo(before.july.box6 + 3_000, 2);

    // the receipt: the advance is adjusted, the deposit gone, nothing un-invoiced
    const pAfter = await getPayment(p.id);
    expect(pAfter.unappliedAmount).toBe(0);
    expect(pAfter.advanceAdjustedAmount).toBe(11_500);
    expect(pAfter.advanceOpenAmount).toBe(0);
    expect(pAfter.allocations.filter((a) => !a.reversedBy).map((a) => [a.invoiceId, a.amount, a.journalEntryId])).toEqual([[issued.id, 11_500, je.id]]);
    expect(pAfter.advanceInvoices[0]).toMatchObject({ adjustedAmount: 11_500, openAmount: 0 });
    // the position: AR 23,000 owed, deposit 0 — and the GL/subledger invariant holds
    const pos = await position(custA);
    expect(pos.receivable).toBeCloseTo(before.pos.receivable + 23_000, 2);
    expect(pos.depositBalance).toBeCloseTo(before.pos.depositBalance - 11_500, 2);
    expect(pos.creditBalance).toBe(before.pos.creditBalance);
    expect(await depositsInvariantViolations()).toEqual([]);
    // the XML: full lines, ONE adjustment line referencing the 386 by number / UUID / issue date / time / 386, KSA-31/32, BT-113, net payable
    const input = await inTenant(() => loadEInvoiceInput(issued.id, null));
    expect(input.prepaidAmount).toBe("11500.00");
    expect(input.payableAmount).toBe("23000.00");
    expect(input.taxTotal).toBe("4500.00");
    expect(input.prepaymentAdjustments).toHaveLength(1);
    expect(input.prepaymentAdjustments[0]!.references[0]).toMatchObject({ invoiceNumber: adv.invoiceNumber, uuid: adv.zatcaUuid });
    const xml = buildInvoiceXml(input);
    expect(xml).toContain('<cbc:InvoiceTypeCode name="0100000">388</cbc:InvoiceTypeCode>');
    expect(xml).toContain(`<cac:DocumentReference>`);
    expect(xml).toContain(`<cbc:ID>${adv.invoiceNumber}</cbc:ID>`);
    expect(xml).toContain("<cbc:DocumentTypeCode>386</cbc:DocumentTypeCode>");
    expect(xml).toContain('<cbc:TaxableAmount currencyID="SAR">10000.00</cbc:TaxableAmount>');
    expect(xml).toContain('<cbc:PrepaidAmount currencyID="SAR">11500.00</cbc:PrepaidAmount>');
    expect(xml).toContain('<cbc:PayableAmount currencyID="SAR">23000.00</cbc:PayableAmount>');
    // the remainder is collected by any D-4 path: Mark Paid 23,000 closes it
    const paid = await inTenant(() => invoicesService.pay(issued.id, { amount: 23_000, paidAt: FINAL_DATE, bankAccountId: bank }, userId));
    expect(paid.status).toBe("paid");
    expect(await gl("AR", custA)).toBe(before.ar);
  });

  it("🔴 FULL advance: a 388 covered entirely by the 386 issues PAID with no AR line, amount due 0, and the deposit fully released", async () => {
    const p = await receiveAdvance(custB, 5_750);
    const adv = await issueAdvance(p.id, 5_750);
    const before = { ar: await gl("AR", custB), deposits: await gl("CUSTOMER_DEPOSITS", custB), vat: await gl("VAT_OUTPUT") };
    const issued = await issueFinal(custB, 5_000, [{ advanceInvoiceId: adv.id }]);
    expect(issued.status).toBe("paid");
    expect(issued.amountDue).toBe(0);
    expect(issued.paidAmount).toBe(5_750);
    expect(await gl("AR", custB)).toBe(before.ar); // no AR line at all
    expect(await gl("CUSTOMER_DEPOSITS", custB)).toBe(before.deposits - 5_000);
    expect(await gl("VAT_OUTPUT")).toBe(before.vat); // 750 declared on the 386; the 388 adds 750 − 750
    const lines = (await pool.query(`SELECT c.system_code, l.debit_amount::text AS d, l.credit_amount::text AS c FROM journal_entry_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN categories c ON c.id = l.account_id WHERE e.organization_id = $1 AND e.entry_number = $2 ORDER BY l.id`, [orgId, `GL-${issued.invoiceNumber}`])).rows;
    expect(lines.map((l) => l.system_code)).toEqual(["CUSTOMER_DEPOSITS", "SALES"]);
    expect((await getPayment(p.id)).unappliedAmount).toBe(0);
    expect(await depositsInvariantViolations()).toEqual([]);
  });

  it("several 386s of one receipt on one 388 fold into ONE allocation; a 386 partly adjusted stays open for the next invoice; over-advance and re-adjustment are refused by name", async () => {
    const p = await receiveAdvance(custA, 6_900);
    const a1 = await issueAdvance(p.id, 2_300);
    const a2 = await issueAdvance(p.id, 2_300);
    expect((await getPayment(p.id)).uninvoicedAmount).toBe(2_300);
    // a final invoice smaller than the two advances: refused (§8(g) default — limit to the invoice)
    await expectRefusal(inTenant(() => invoicesService.create({ invoiceNumber: nextNumber("AP2-INV"), date: FINAL_DATE, customerId: custA, items: [{ description: "x", quantity: 1, unitPrice: 3_000, vatRate: 15 }], prepayments: [{ advanceInvoiceId: a1.id }, { advanceInvoiceId: a2.id }] }, userId)), 422, "prepayment_exceeds_invoice");
    // a partial adjustment of a1 (1,150 of 2,300) and all of a2 on a 3,450 invoice (net 3,000)
    const inv = await issueFinal(custA, 3_000, [{ advanceInvoiceId: a1.id, amount: 1_150 }, { advanceInvoiceId: a2.id }]);
    expect(inv.status).toBe("paid");
    expect(inv.prepaidAmount).toBe(3_450);
    const pAfter = await getPayment(p.id);
    expect(pAfter.allocations.filter((a) => !a.reversedBy)).toHaveLength(1);
    expect(pAfter.allocations[0]!.amount).toBe(3_450);
    expect(pAfter.advanceAdjustedAmount).toBe(3_450);
    expect(pAfter.advanceOpenAmount).toBe(1_150);
    expect(pAfter.uninvoicedAmount).toBe(2_300);
    const open = await inTenant(() => advanceInvoicesService.openForCustomer(custA));
    expect(open.find((o) => o.id === a1.id)?.openAmount).toBe(1_150);
    expect(open.find((o) => o.id === a2.id)).toBeUndefined();
    // the XML: one adjustment line (same category and rate) with TWO references
    const xml = buildInvoiceXml(await inTenant(() => loadEInvoiceInput(inv.id, null)));
    expect(xml.match(/<cac:DocumentReference>/g)?.length).toBe(2);
    expect(xml.match(/Prepayment adjustment/g)?.length).toBe(1);
    // adjusting more than a1 still has is refused
    await expectRefusal(inTenant(() => invoicesService.create({ invoiceNumber: nextNumber("AP2-INV"), date: FINAL_DATE, customerId: custA, items: [{ description: "x", quantity: 1, unitPrice: 5_000, vatRate: 15 }], prepayments: [{ advanceInvoiceId: a1.id, amount: 2_300 }] }, userId)), 409, "prepayment_exceeds_open_advance");
    // a second draft against a1's open 1,150 approves AFTER a first one consumed it: refused at approval, nothing posted
    const d1 = await inTenant(() => invoicesService.create({ invoiceNumber: nextNumber("AP2-INV"), date: FINAL_DATE, customerId: custA, items: [{ description: "x", quantity: 1, unitPrice: 1_000, vatRate: 15 }], prepayments: [{ advanceInvoiceId: a1.id }] }, userId));
    const d2 = await inTenant(() => invoicesService.create({ invoiceNumber: nextNumber("AP2-INV"), date: FINAL_DATE, customerId: custA, items: [{ description: "x", quantity: 1, unitPrice: 1_000, vatRate: 15 }], prepayments: [{ advanceInvoiceId: a1.id }] }, userId));
    await inTenant(() => invoicesService.approve(d1.id, userId));
    const vatBefore = await gl("VAT_OUTPUT");
    await expectRefusal(inTenant(() => invoicesService.approve(d2.id, userId)), 409, "prepayment_exceeds_open_advance");
    expect(await gl("VAT_OUTPUT")).toBe(vatBefore);
    expect((await getInvoice(d2.id)).status).toBe("draft");
    expect((await getInvoice(d2.id)).icv).toBeNull();
    expect(await depositsInvariantViolations()).toEqual([]);
  });

  // ── the guards on the existing paths ─────────────────────────────────
  it("🔴 what a 386 has declared VAT for is reserved for the adjustment: a D-4 allocation or a refund beyond the un-invoiced remainder is refused (G-Z-3 fail-closed); the un-invoiced part still moves both ways", async () => {
    const p = await receiveAdvance(custA, 4_600);
    await issueAdvance(p.id, 2_300);
    const target = await issueFinal(custA, 10_000);
    // beyond the un-invoiced 2,300 → refused; exactly 2,300 → a plain D-4 allocation, dated TODAY (A3), Dr deposits / Cr AR
    const e = await expectRefusal(inTenant(() => paymentsService.allocate(p.id, { allocations: [{ invoiceId: target.id, amount: 3_000 }] }, userId)), 409, "advance_invoiced_requires_prepayment_adjustment");
    expect(e.body.uninvoicedAmount).toBe("2300.00");
    const allocated = await inTenant(() => paymentsService.allocate(p.id, { allocations: [{ invoiceId: target.id, amount: 1_000 }] }, userId));
    const alloc = allocated.allocations.find((a) => a.invoiceId === target.id)!;
    const [je] = await inTenant(() => journalEntriesRepository.findById(alloc.journalEntryId!));
    expect(je!.date).toBe(businessToday());
    expect(je!.date).not.toBe(RECEIPT_DATE);
    expect(je!.date).not.toBe(FINAL_DATE);
    expect((await getPayment(p.id)).uninvoicedAmount).toBe(1_300);
    // refund: the same rule
    await expectRefusal(inTenant(() => paymentsService.refund({ customerId: custA, origin: "deposit", paymentId: p.id, amount: 2_000, bankAccountId: bank, reason: "returned" }, userId)), 409, "advance_invoiced_requires_prepayment_adjustment");
    const refund = await inTenant(() => paymentsService.refund({ customerId: custA, origin: "deposit", paymentId: p.id, amount: 1_300, bankAccountId: bank, reason: "returned" }, userId));
    expect(refund.amount).toBe(1_300);
    const pAfter = await getPayment(p.id);
    expect(pAfter.uninvoicedAmount).toBe(0);
    expect(pAfter.advanceOpenAmount).toBe(2_300);
    expect(pAfter.unappliedAmount).toBe(2_300);
    await expectRefusal(inTenant(() => paymentsService.refund({ customerId: custA, origin: "deposit", paymentId: p.id, amount: 1, bankAccountId: bank, reason: "x" }, userId)), 409, "advance_invoiced_requires_prepayment_adjustment");
    expect(await depositsInvariantViolations()).toEqual([]);
  });

  it("a 386 is not payable, not an allocation target, not correctable by a credit note (AP-3), not line-editable as a draft; its draft can be deleted", async () => {
    const p = await receiveAdvance(custA, 1_150);
    const draft = await draftAdvance(p.id, 1_150);
    await expectRefusal(inTenant(() => invoicesService.update(draft.id, { items: [{ description: "x", quantity: 1, unitPrice: 5 }] })), 409, "advance_invoice_line_derived");
    await expectRefusal(inTenant(() => invoicesService.update(draft.id, { customerId: custB })), 409, "advance_invoice_line_derived");
    const renamed = await inTenant(() => invoicesService.update(draft.id, { notes: "advance for order 77" }));
    expect(renamed.notes).toBe("advance for order 77");
    const issued = await inTenant(() => invoicesService.approve(draft.id, userId));
    await expectRefusal(inTenant(() => invoicesService.pay(issued.id, { amount: 1_150, bankAccountId: bank }, userId)), 409, "advance_invoice_not_payable");
    const other = await receive(custA, 500);
    await expectRefusal(inTenant(() => paymentsService.allocate(other.id, { allocations: [{ invoiceId: issued.id, amount: 100 }] }, userId)), 409, "advance_invoice_not_payable");
    await expectRefusal(inTenant(() => invoicesService.create({ date: FINAL_DATE, customerId: custA, documentType: "credit_note", originalInvoiceId: issued.id, noteReason: "cancelled", items: [{ description: "x", quantity: 1, unitPrice: 100, vatRate: 15 }] }, userId)), 409, "note_original_is_advance_invoice");
    // a draft 386 deleted leaves the receipt exactly as it was
    const d2 = await draftAdvance((await receiveAdvance(custB, 230)).id, 230);
    await inTenant(() => invoicesService.deleteDraft(d2.id));
    expect((await inTenant(() => invoicesService.list({}))).items.find((i) => i.id === d2.id)).toBeUndefined();
    // a note or a 386 never carries a prepayment selection
    const original = await issueFinal(custA, 100);
    await expectRefusal(inTenant(() => invoicesService.create({ date: FINAL_DATE, customerId: custA, documentType: "debit_note", originalInvoiceId: original.id, noteReason: "more", items: [{ description: "x", quantity: 1, unitPrice: 10, vatRate: 15 }], prepayments: [{ advanceInvoiceId: issued.id }] }, userId)), 400, "prepayments_on_note");
  });

  it("the draft 386 is re-checked at approval under the receipt's lock: reclassified → refused; two drafts for the same remainder → the second is refused; a date before the receipt → refused", async () => {
    const p = await receiveAdvance(custA, 2_300);
    const d1 = await draftAdvance(p.id, 2_300);
    const d2 = await draftAdvance(p.id, 2_300); // a draft reserves nothing, so both can be drafted
    await inTenant(() => paymentsService.classify(p.id, { classification: "security_deposit" }, userId));
    await expectRefusal(inTenant(() => invoicesService.approve(d1.id, userId)), 409, "advance_invoice_requires_advance_classification");
    await inTenant(() => paymentsService.classify(p.id, { classification: "advance", vatCategory: "S" }, userId));
    await inTenant(() => invoicesService.approve(d1.id, userId));
    await expectRefusal(inTenant(() => invoicesService.approve(d2.id, userId)), 422, "advance_invoice_exceeds_uninvoiced");
    expect((await getInvoice(d2.id)).status).toBe("draft");
    await expectRefusal(draftAdvance((await receiveAdvance(custA, 100)).id, 100, { date: "2026-06-01" }), 422, "advance_invoice_before_receipt");
    // a receipt of another organisation is invisible (no existence oracle): 404
    await expectRefusal(inOther(() => advanceInvoicesService.createFromReceipt(p.id, { amount: 100 }, userId)), 404);
    // and another organisation's 386 cannot be adjusted on this org's invoice
    const foreign = await inOther(() => paymentsService.receive({ customerId: custOther, amount: 1_150, paidAt: RECEIPT_DATE, bankAccountId: bankOther, classification: "advance", vatCategory: "S" }, userId));
    const foreignAdv = await inOther(async () => invoicesService.approve((await advanceInvoicesService.createFromReceipt(foreign.id, { amount: 1_150 }, userId)).id, userId));
    await expectRefusal(inTenant(() => invoicesService.create({ date: FINAL_DATE, customerId: custA, items: [{ description: "x", quantity: 1, unitPrice: 5_000, vatRate: 15 }], prepayments: [{ advanceInvoiceId: foreignAdv.id }] }, userId)), 422, "reference_not_found");
  });

  // ── 16: closed periods ───────────────────────────────────────────────
  it("🔴 closed month: a 386 dated into it is refused (423) and re-dated into the open month by default; a 388 with an adjustment dated into it is refused with nothing posted and the 386 still open; a later D-4 allocation is dated today, never re-dated", async () => {
    const p = await receiveAdvance(custB, 3_450);
    await inTenant(() => periodLocksService.lock({ period: "2026-06", userId }));
    try {
      await expectRefusal(draftAdvance(p.id, 3_450, { date: RECEIPT_DATE }), 423);
      const d = await draftAdvance(p.id, 3_450); // default: the receipt month is closed → today
      expect(d.date).toBe(businessToday());
      const adv = await inTenant(() => invoicesService.approve(d.id, userId));
      expect((await journalOf(`GL-${adv.invoiceNumber}`)).date).toBe(businessToday());
      // a final invoice dated into the closed month
      const vatBefore = await gl("VAT_OUTPUT");
      await expectRefusal(inTenant(() => invoicesService.create({ invoiceNumber: nextNumber("AP2-INV"), date: "2026-06-20", customerId: custB, items: [{ description: "x", quantity: 1, unitPrice: 3_000, vatRate: 15 }], prepayments: [{ advanceInvoiceId: adv.id }] }, userId)), 423);
      expect(await gl("VAT_OUTPUT")).toBe(vatBefore);
      expect((await getPayment(p.id)).advanceOpenAmount).toBe(3_450);
      // an open-month final invoice adjusts it; a D-4 allocation of an un-invoiced part posts today whatever the invoice's month
      const inv = await issueFinal(custB, 3_000, [{ advanceInvoiceId: adv.id }]);
      expect(inv.status).toBe("paid");
    } finally {
      await inTenant(() => periodLocksService.unlock("2026-06"));
    }
  });

  // ── 17: corrections ──────────────────────────────────────────────────
  it("🔴 the folded prepayment allocation is IMMUTABLE (409, the signed document states it); a D-4 allocation of the un-invoiced part is corrected by a superseding record with the original row and the audit intact", async () => {
    const p = await receiveAdvance(custA, 6_900);
    const adv = await issueAdvance(p.id, 3_450);
    const inv = await issueFinal(custA, 6_000, [{ advanceInvoiceId: adv.id }]);
    const folded = (await getPayment(p.id)).allocations.find((a) => a.invoiceId === inv.id)!;
    await expectRefusal(inTenant(() => paymentsService.unallocate(folded.id, { reason: "oops" }, userId)), 409, "prepayment_adjustment_immutable");
    const rowsBefore = (await pool.query(`SELECT id, amount::text AS amount, allocation_id FROM invoice_prepayments WHERE invoice_id = $1`, [inv.id])).rows;
    expect(rowsBefore).toHaveLength(1);
    expect(rowsBefore[0].allocation_id).toBe(folded.id);
    // the frozen row cannot be changed or deleted by anyone once issued — the trigger, not the service
    await expect(pool.query(`UPDATE invoice_prepayments SET amount = 1, taxable_amount = 1, tax_amount = 0 WHERE id = $1`, [rowsBefore[0].id])).rejects.toThrow(/frozen/);
    await expect(pool.query(`DELETE FROM invoice_prepayments WHERE id = $1`, [rowsBefore[0].id])).rejects.toThrow(/frozen/);
    // the un-invoiced 3,450: a D-4 allocation, then its correction — the Phase A superseding record
    const target = await issueFinal(custA, 5_000);
    const allocated = await inTenant(() => paymentsService.allocate(p.id, { allocations: [{ invoiceId: target.id, amount: 3_450 }] }, userId));
    const d4 = allocated.allocations.find((a) => a.invoiceId === target.id)!;
    expect((await getPayment(p.id)).unappliedAmount).toBe(0);
    const corrected = await inTenant(() => paymentsService.unallocate(d4.id, { reason: "wrong invoice" }, userId));
    expect(corrected.reversedBy?.reason).toBe("wrong invoice");
    const pAfter = await getPayment(p.id);
    expect(pAfter.allocations.find((a) => a.id === d4.id)?.amount).toBe(3_450); // the original row is untouched
    expect(pAfter.allocations.find((a) => a.id === d4.id)?.reversedBy).toBeTruthy();
    expect(pAfter.unappliedAmount).toBe(3_450);
    expect(pAfter.uninvoicedAmount).toBe(3_450);
    expect(pAfter.advanceOpenAmount).toBe(0);
    const audit = (await pool.query(`SELECT action FROM audit_logs WHERE organization_id = $1 AND entity_type = 'payment_allocation' AND entity_id = $2`, [orgId, d4.id])).rows.map((r) => r.action);
    expect(audit).toContain("unallocate");
    expect(await depositsInvariantViolations()).toEqual([]);
  });

  // ── the readers ──────────────────────────────────────────────────────
  it("🔴 every AR reader ignores the 386 (list totals, ageing, position, customer ledger, analytics) while the VAT return and the GL move; the statement shows it at zero movement and reconciles", async () => {
    const p = await receiveAdvance(custB, 2_300);
    const before = {
      list: (await inTenant(() => invoicesService.list({}))).totals,
      aging: await inTenant(() => reportsService.arAging()),
      pos: await position(custB),
      ledger: await inTenant(() => reportsService.customerLedger(String(custB))),
      analytics: await inTenant(() => analyticsRepository.customerTotals("2026-01-01", "2026-12-31")),
      vat: await gl("VAT_OUTPUT"),
      june: await box("2026-06"),
    };
    const adv = await issueAdvance(p.id, 2_300);
    const after = {
      list: (await inTenant(() => invoicesService.list({}))).totals,
      aging: await inTenant(() => reportsService.arAging()),
      pos: await position(custB),
      ledger: await inTenant(() => reportsService.customerLedger(String(custB))),
      analytics: await inTenant(() => analyticsRepository.customerTotals("2026-01-01", "2026-12-31")),
    };
    expect(after.list).toEqual(before.list); // outstanding, collected, overdue — unmoved
    expect(after.aging.total).toBe(before.aging.total);
    expect(after.aging.items.find((i) => i.invoiceNumber === adv.invoiceNumber)).toBeUndefined();
    expect(after.pos).toEqual(before.pos);
    expect(after.ledger.customers.map((c) => c.totalInvoiced)).toEqual(before.ledger.customers.map((c) => c.totalInvoiced));
    expect(after.ledger.customers.flatMap((c) => c.invoices).find((i) => i.invoiceNumber === adv.invoiceNumber)).toBeUndefined();
    expect(after.analytics.find((r) => r.id === String(custB))?.total).toBe(before.analytics.find((r) => r.id === String(custB))?.total);
    // ...while the things that MUST move, moved (the planted positive)
    expect(await gl("VAT_OUTPUT")).toBe(before.vat + 300);
    expect((await box("2026-06")).box6).toBeCloseTo(before.june.box6 + 300, 2);
    // the list still SHOWS the document (a reader can find it) with its type and receipt
    const listed = (await inTenant(() => invoicesService.list({ customerId: custB }))).items.find((i) => i.id === adv.id);
    expect(listed?.documentType).toBe("advance_invoice");
    expect(listed?.advancePaymentId).toBe(p.id);
    // the statement: a zero-movement event, in chronology, reconciled
    const statement = await inTenant(() => customerStatementService.statement(custB, {}));
    const line = statement.lines.find((l) => l.kind === "advance_invoice" && l.documentNumber === adv.invoiceNumber);
    expect(line).toBeTruthy();
    expect([line!.receivableDelta, line!.creditDelta, line!.depositDelta]).toEqual([0, 0, 0]);
    expect(line!.amount).toBe(2_300);
    expect(line!.reference).toBe(`RCPT-${p.id}`);
    expect(statement.reconciled).toBe(true);
    // the deposit review: fully covered → advance_invoiced, no review; partly covered → still needs one for the remainder
    const review = await inTenant(() => depositReviewService.review({ customerId: custB }));
    const item = review.items.find((i) => i.paymentId === p.id)!;
    expect(item.reviewState).toBe("advance_invoiced");
    expect(item.needsReview).toBe(false);
    expect(item.advanceOpenAmount).toBe(2_300);
    expect(item.uninvoicedAmount).toBe(0);
    const partial = await receiveAdvance(custB, 4_600);
    await issueAdvance(partial.id, 2_300);
    const r2 = await inTenant(() => depositReviewService.review({ customerId: custB }));
    const it2 = r2.items.find((i) => i.paymentId === partial.id)!;
    expect(it2.reviewState).toBe("advance_not_invoiced");
    expect(it2.uninvoicedAmount).toBe(2_300);
    expect(it2.needsReview).toBe(true);
    expect(r2.byState.advance_not_invoiced.amount).toBeGreaterThanOrEqual(2_300);
  });

  it("every journal posted by this suite balances, and no 386 ever carries AR, revenue or a bank line", async () => {
    const unbalanced = (await pool.query(`SELECT e.entry_number FROM journal_entries e JOIN journal_entry_lines l ON l.journal_entry_id = e.id WHERE e.organization_id = $1 GROUP BY e.id HAVING sum(l.debit_amount) <> sum(l.credit_amount)`, [orgId])).rows;
    expect(unbalanced).toEqual([]);
    const wrong = (await pool.query(`
      SELECT i.invoice_number, c.system_code FROM invoices i
        JOIN journal_entries e ON e.organization_id = i.organization_id AND e.entry_number = 'GL-' || i.invoice_number
        JOIN journal_entry_lines l ON l.journal_entry_id = e.id JOIN categories c ON c.id = l.account_id
       WHERE i.organization_id = $1 AND i.document_type = 'advance_invoice' AND (c.system_code IN ('AR','SALES') OR c.bank_account_id IS NOT NULL)`, [orgId])).rows;
    expect(wrong).toEqual([]);
    expect(await depositsInvariantViolations()).toEqual([]);
  });
});
