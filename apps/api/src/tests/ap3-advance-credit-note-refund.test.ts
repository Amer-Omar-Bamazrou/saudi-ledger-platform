/**
 * AP-3 (2026-09-21) — THE CREDIT NOTE AGAINST AN ADVANCE TAX INVOICE (386)
 * AND THE REFUND IT UNLOCKS.
 * Decision record: docs/product/advance-payments-decision-pack.md §6 E5, §15.
 * Authority: Detailed Guideline v2 §8(g) (a credit note against the advance
 * invoice, cleared/reported); IR Art. 40(1)(a), 40(5), 54; XML Standard
 * BR-KSA-56 (billing reference = the 386's number), BR-KSA-17 (the reason).
 *
 * The three doors stay apart and are asserted apart:
 *   A. an ordinary receipt's refund — Batch 1B, unchanged (asserted here);
 *   B. a 386 applied on a final invoice — AP-2, unchanged (asserted here);
 *   C. a 386 → `advance_credit_note` (E5: Dr VAT Payable / Cr Customer
 *      deposits) → the receipt's deposit refund (Batch 1B's own entry).
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
import { customerStatementService } from "../services/customerStatement.service";
import { customersRepository } from "../repositories/customers.repository";
import { periodLocksService } from "../services/periodLocks.service";
import { loadEInvoiceInput } from "../services/einvoice/einvoiceInput.loader";
import { buildInvoiceXml } from "../services/einvoice/ubl/buildInvoiceXml";
import { createApproved } from "./helpers/createApproved";
import { businessToday } from "@workspace/shared";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

const SLUG = "ap3-cn";
const SLUG_OTHER = "ap3-cn-other";
const EMAIL = "ap3-cn@test.local";
const RECEIPT_DATE = "2026-06-15";
const NOTE_DATE = "2026-07-10";

describeMaybe("AP-3 — credit note against an advance tax invoice, and the refund it unlocks (real rows)", () => {
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
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('AP3 Org','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (await pool.query(
      `INSERT INTO companies (organization_id, name, name_ar, cr_number, vat_number, building_number, street, district, city, postal_code, additional_number)
       VALUES ($1,'AP3 Co','شركة','1010828381','399999999988953','1234','King Fahd Road','Al Olaya','Riyadh','12345','6789') RETURNING id`, [orgId])).rows[0].id;
    otherOrgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('AP3 Other','${SLUG_OTHER}') RETURNING id`)).rows[0].id;
    otherCompanyId = (await pool.query(`INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'AP3 Other Co','1010828383','399999999988963') RETURNING id`, [otherOrgId])).rows[0].id;
    userId = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','AP3',' ','admin',true) RETURNING id`)).rows[0].id;
    for (const o of [orgId, otherOrgId]) await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, o]);
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
  const receiveAdvance = (customerId: number, amount: number, extra: Record<string, unknown> = {}) => receive(customerId, amount, { classification: "advance", vatCategory: "S", ...extra });
  const issueAdvance = async (paymentId: number, amount: number) => {
    const draft = await inTenant(() => advanceInvoicesService.createFromReceipt(paymentId, { amount }, userId));
    return inTenant(() => invoicesService.approve(draft.id, userId));
  };
  const draftNote = (advanceId: number, amount: number, extra: Record<string, unknown> = {}) =>
    inTenant(() => advanceInvoicesService.creditAdvance(advanceId, { amount, reason: "Order cancelled", date: NOTE_DATE, ...extra }, userId));
  const issueNote = async (advanceId: number, amount: number, extra: Record<string, unknown> = {}) => {
    const draft = await draftNote(advanceId, amount, extra);
    return inTenant(() => invoicesService.approve(draft.id, userId));
  };
  const issueFinal = (customerId: number, net: number, prepayments: Array<{ advanceInvoiceId: number; amount?: number }> = []) =>
    inTenant(() =>
      createApproved<Awaited<ReturnType<typeof invoicesService.getById>>>(
        invoicesService,
        { invoiceNumber: nextNumber("AP3-INV"), date: NOTE_DATE, dueDate: NOTE_DATE, customerId, items: [{ description: "Project", quantity: 1, unitPrice: net, vatRate: 15 }], prepayments },
        userId,
      ),
    );
  const refund = (paymentId: number, customerId: number, amount: number, extra: Record<string, unknown> = {}) =>
    inTenant(() => paymentsService.refund({ customerId, origin: "deposit", paymentId, amount, bankAccountId: bank, refundedAt: NOTE_DATE, reason: "advance returned", ...extra }, userId));
  const getPayment = (id: number) => inTenant(() => paymentsService.get(id));
  const getInvoice = (id: number) => inTenant(() => invoicesService.getById(id));
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
    (await pool.query(`SELECT e.id, e.date::text AS date FROM journal_entries e WHERE e.organization_id = $1 AND e.entry_number = $2`, [orgId, entryNumber])).rows[0] ?? null;
  const lines = async (entryNumber: string) =>
    (await pool.query(`SELECT c.system_code, l.debit_amount::text AS d, l.credit_amount::text AS c, l.customer_id FROM journal_entry_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN categories c ON c.id = l.account_id WHERE e.organization_id = $1 AND e.entry_number = $2 ORDER BY l.id`, [orgId, entryNumber])).rows;
  const box = async (period: string) => {
    const r = await inTenant(() => reportsService.vatReturn(period, period));
    return { box1: Number(r.salesSection.box1_standardRatedDomesticSales), box6: Number(r.salesSection.box6_vatOnStandardRatedSales) };
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
  const expectRefusal = async (p: Promise<unknown>, status: number, code?: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let err: any;
    try { await p; } catch (e) { err = e; }
    expect(err, "expected a refusal").toBeTruthy();
    expect(err.statusCode ?? err.status).toBe(status);
    if (code) expect(err.payload?.code ?? err.body?.code ?? err.code).toBe(code);
    return { ...err, body: err.payload ?? err.body ?? {} };
  };

  // ── 4, 11: the door is shut before the note ───────────────────────────
  it("🔴 an invoiced advance cannot be refunded (or allocated) before the credit note: 409 naming the step; the 386 and the receipt untouched", async () => {
    const p = await receiveAdvance(custA, 11_500);
    const adv = await issueAdvance(p.id, 11_500);
    const target = await issueFinal(custA, 1_000);
    const before = { deposits: await gl("CUSTOMER_DEPOSITS", custA), vat: await gl("VAT_OUTPUT"), bank: await bankGl() };
    const e = await expectRefusal(refund(p.id, custA, 11_500), 409, "advance_invoiced_requires_prepayment_adjustment");
    expect(e.body.uninvoicedAmount).toBe("0.00");
    await expectRefusal(refund(p.id, custA, 1), 409, "advance_invoiced_requires_prepayment_adjustment");
    await expectRefusal(inTenant(() => paymentsService.allocate(p.id, { allocations: [{ invoiceId: target.id, amount: 100 }] }, userId)), 409, "advance_invoiced_requires_prepayment_adjustment");
    expect(await gl("CUSTOMER_DEPOSITS", custA)).toBe(before.deposits);
    expect(await gl("VAT_OUTPUT")).toBe(before.vat);
    expect(await bankGl()).toBe(before.bank);
    expect((await getInvoice(adv.id)).status).toBe("sent");
    expect((await getPayment(p.id)).refundedAmount).toBe(0);
    // door C for the rest of the walk
    await issueNote(adv.id, 11_500);
    await refund(p.id, custA, 11_500);
  });

  // ── 3: an ordinary note cannot masquerade ────────────────────────────
  it("🔴 an ORDINARY credit note (or debit note) against a 386 is refused by name; an advance credit note against an ordinary invoice, a draft 386, or a note is refused too", async () => {
    const p = await receiveAdvance(custA, 2_300);
    const adv = await issueAdvance(p.id, 2_300);
    await expectRefusal(inTenant(() => invoicesService.create({ date: NOTE_DATE, customerId: custA, documentType: "credit_note", originalInvoiceId: adv.id, noteReason: "x", items: [{ description: "x", quantity: 1, unitPrice: 100, vatRate: 15 }] }, userId)), 409, "note_original_is_advance_invoice");
    await expectRefusal(inTenant(() => invoicesService.create({ date: NOTE_DATE, customerId: custA, documentType: "debit_note", originalInvoiceId: adv.id, noteReason: "x", items: [{ description: "x", quantity: 1, unitPrice: 100, vatRate: 15 }] }, userId)), 409, "note_original_is_advance_invoice");
    // the front door refuses the type outright — a credit note against an advance is created FROM the advance
    await expectRefusal(inTenant(() => invoicesService.create({ date: NOTE_DATE, customerId: custA, documentType: "advance_credit_note", originalInvoiceId: adv.id, noteReason: "x", items: [{ description: "x", quantity: 1, unitPrice: 100, vatRate: 15 }] }, userId)), 400, "advance_credit_note_via_advance");
    const ordinary = await issueFinal(custA, 1_000);
    await expectRefusal(draftNote(ordinary.id, 100), 409, "advance_credit_note_original_not_advance");
    const pB = await receiveAdvance(custB, 115);
    const draft386 = await inTenant(() => advanceInvoicesService.createFromReceipt(pB.id, { amount: 115 }, userId));
    await expectRefusal(draftNote(draft386.id, 115), 409, "note_original_not_issued");
    await inTenant(() => invoicesService.deleteDraft(draft386.id));
    await refund(pB.id, custB, 115);
    await expectRefusal(draftNote(adv.id, 100, { reason: "" }), 400, "note_reason_required");
    await expectRefusal(draftNote(adv.id, 100, { date: "2026-06-01" }), 422, "advance_credit_note_before_advance");
    // another organisation cannot reach the 386 (no existence oracle)
    await expectRefusal(inOther(() => advanceInvoicesService.creditAdvance(adv.id, { amount: 100, reason: "x" }, userId)), 404);
    await issueNote(adv.id, 2_300);
    await refund(p.id, custA, 2_300);
  });

  // ── 1, 2, 5, 6, 7, 8, 9, 12, 13: the full lifecycle ─────────────────
  it("🔴 386 → credit note (E5: Dr VAT Payable / Cr Customer deposits; the return files it NEGATIVE in the note's period) → the receipt's un-invoiced remainder rises → the Batch 1B refund returns the cash; every document preserved, the chain readable", async () => {
    const p = await receiveAdvance(custA, 11_500);
    const adv = await issueAdvance(p.id, 11_500);
    const before = { deposits: await gl("CUSTOMER_DEPOSITS", custA), vat: await gl("VAT_OUTPUT"), ar: await gl("AR", custA), sales: await gl("SALES"), credits: await gl("CUSTOMER_CREDITS", custA), bank: await bankGl(), pos: await position(custA), june: await box("2026-06"), july: await box("2026-07") };

    // the DRAFT: a document, nothing posted, nothing unlocked
    const draft = await draftNote(adv.id, 11_500);
    expect(draft.documentType).toBe("advance_credit_note");
    expect(draft.originalInvoiceId).toBe(adv.id);
    expect(draft.noteReason).toBe("Order cancelled");
    expect(draft.total).toBe(11_500);
    expect(draft.subtotal).toBe(10_000);
    expect(draft.vatAmount).toBe(1_500);
    expect(draft.customerId).toBe(custA);
    expect(draft.icv).toBeNull();
    expect(await gl("VAT_OUTPUT")).toBe(before.vat);
    const pDraft = await getPayment(p.id);
    expect(pDraft.advanceOpenAmount).toBe(11_500);
    expect(pDraft.uninvoicedAmount).toBe(0);
    expect(pDraft.advanceInvoices[0]!.creditNotes.map((n) => [n.id, n.status])).toEqual([[draft.id, "draft"]]);
    await expectRefusal(refund(p.id, custA, 11_500), 409, "advance_invoiced_requires_prepayment_adjustment");

    // ISSUE the note: ICV consumed (a legal document), E5 posted, and only E5
    const note = await inTenant(() => invoicesService.approve(draft.id, userId));
    expect(note.status).toBe("sent");
    expect(note.icv).not.toBeNull();
    expect(note.invoiceHash).not.toBeNull();
    expect(await gl("VAT_OUTPUT")).toBe(before.vat - 1_500);
    expect(await gl("CUSTOMER_DEPOSITS", custA)).toBe(before.deposits + 1_500); // the deposit is gross again
    expect(await gl("AR", custA)).toBe(before.ar);
    expect(await gl("SALES")).toBe(before.sales);
    expect(await gl("CUSTOMER_CREDITS", custA)).toBe(before.credits); // NOT a Model C credit balance
    expect(await bankGl()).toBe(before.bank);
    const je = await journalOf(`GL-${note.invoiceNumber}`);
    expect(je.date).toBe(NOTE_DATE);
    expect((await lines(`GL-${note.invoiceNumber}`)).map((l) => [l.system_code, l.d, l.c])).toEqual([["VAT_OUTPUT", "1500.00", "0.00"], ["CUSTOMER_DEPOSITS", "0.00", "1500.00"]]);
    // the return: the 386's period unmoved; the note's period −10,000 / −1,500
    expect(await box("2026-06")).toEqual(before.june);
    const julyAfter = await box("2026-07");
    expect(julyAfter.box1).toBeCloseTo(before.july.box1 - 10_000, 2);
    expect(julyAfter.box6).toBeCloseTo(before.july.box6 - 1_500, 2);
    // the three position components: unchanged by the note (the cash is still the deposit; no credit balance, no AR)
    expect(await position(custA)).toEqual(before.pos);
    // the receipt: the advance is no longer open; the whole deposit is un-invoiced again — and says why
    const pNote = await getPayment(p.id);
    expect(pNote.advanceInvoicedAmount).toBe(11_500);
    expect(pNote.advanceAdjustedAmount).toBe(0);
    expect(pNote.advanceOpenAmount).toBe(0);
    expect(pNote.uninvoicedAmount).toBe(11_500);
    expect(pNote.unappliedAmount).toBe(11_500);
    expect(pNote.advanceInvoices[0]).toMatchObject({ id: adv.id, status: "sent", creditedAmount: 11_500, openAmount: 0 });
    expect(pNote.advanceInvoices[0]!.creditNotes[0]).toMatchObject({ id: note.id, status: "sent", total: 11_500, vatAmount: 1_500, noteReason: "Order cancelled" });
    // the 386 is not open to a final invoice any more
    expect((await inTenant(() => advanceInvoicesService.openForCustomer(custA))).find((o) => o.id === adv.id)).toBeUndefined();
    expect(await depositsInvariantViolations()).toEqual([]);

    // the REFUND: the Batch 1B entry, unchanged — Dr deposits / Cr bank — for exactly the credited cash
    const r = await refund(p.id, custA, 11_500);
    expect(r.origin).toBe("deposit");
    expect(r.paymentId).toBe(p.id);
    expect((await lines(`REFUND-${r.id}`)).map((l) => [l.system_code ?? "bank", l.d, l.c])).toEqual([["CUSTOMER_DEPOSITS", "11500.00", "0.00"], ["bank", "0.00", "11500.00"]]);
    expect(await gl("CUSTOMER_DEPOSITS", custA)).toBe(before.deposits + 1_500 - 11_500);
    expect(await bankGl()).toBe(before.bank - 11_500);
    expect(await gl("VAT_OUTPUT")).toBe(before.vat - 1_500); // the refund itself touches no VAT — the note did
    const pAfter = await getPayment(p.id);
    expect(pAfter.unappliedAmount).toBe(0);
    expect(pAfter.refundedAmount).toBe(11_500);
    expect(pAfter.uninvoicedAmount).toBe(0);
    expect((await position(custA)).depositBalance).toBeCloseTo(before.pos.depositBalance - 11_500, 2);
    expect(await depositsInvariantViolations()).toEqual([]);

    // preserved: the receipt, the 386, the note — none edited, none deleted
    const advAfter = await getInvoice(adv.id);
    expect(advAfter.status).toBe("sent");
    expect(advAfter.total).toBe(11_500);
    expect(advAfter.icv).toBe(adv.icv);
    expect(advAfter.invoiceHash).toBe(adv.invoiceHash);
    expect((await getInvoice(note.id)).status).toBe("sent");
    expect(pAfter.amount).toBe(11_500);
    expect(pAfter.journalEntryId).toBe(p.journalEntryId);
    // the provenance chain, readable end to end: receipt → 386 → note → refund; the audit carries each act
    const audit = (await pool.query(`SELECT entity_type, entity_id, action FROM audit_logs WHERE organization_id = $1 AND ((entity_type = 'invoice' AND entity_id IN ($2, $3)) OR (entity_type = 'customer_refund' AND entity_id = $4)) ORDER BY created_at`, [orgId, adv.id, note.id, r.id])).rows;
    // `audit_logs.id` is a random uuid — never an ordering. The two acts are asserted as a SET; their order is the transactions' commit order and is not what this test is about.
    expect(audit.filter((a) => a.entity_type === "invoice" && Number(a.entity_id) === note.id).map((a) => a.action).sort()).toEqual(["approve", "create"]);
    expect(audit.find((a) => a.entity_type === "customer_refund")?.action).toBe("refund");
    const stmt = await inTenant(() => customerStatementService.statement(custA, {}));
    const kinds = stmt.lines.filter((l) => l.paymentId === p.id || l.documentNumber === note.invoiceNumber || l.documentNumber === adv.invoiceNumber).map((l) => l.kind);
    expect(kinds).toEqual(["receipt", "advance_invoice", "advance_credit_note", "refund"]);
    const noteLine = stmt.lines.find((l) => l.kind === "advance_credit_note" && l.documentNumber === note.invoiceNumber)!;
    expect([noteLine.receivableDelta, noteLine.creditDelta, noteLine.depositDelta]).toEqual([0, 0, 0]);
    expect(noteLine.reference).toBe(adv.invoiceNumber);
    expect(stmt.reconciled).toBe(true);
    // the deposit review: nothing held any more
    expect((await inTenant(() => depositReviewService.review({ customerId: custA }))).items.find((i) => i.paymentId === p.id)).toBeUndefined();
  });

  // ── the XML ───────────────────────────────────────────────────────────
  it("🔴 the note's UBL from REAL rows: type 381 with a BillingReference to the 386's NUMBER (BR-KSA-56), the reason (BR-KSA-17), the advance's split, no prepayment fields", async () => {
    const p = await receiveAdvance(custA, 4_600);
    const adv = await issueAdvance(p.id, 4_600);
    const note = await issueNote(adv.id, 4_600);
    const input = await inTenant(() => loadEInvoiceInput(note.id, null));
    expect(input.documentType).toBe("advance_credit_note");
    expect(input.billingReference).toEqual({ invoiceNumber: adv.invoiceNumber });
    expect(input.instructionNote).toBe("Order cancelled");
    expect(input.prepaymentAdjustments).toEqual([]);
    const xml = buildInvoiceXml(input);
    expect(xml).toContain('<cbc:InvoiceTypeCode name="0100000">381</cbc:InvoiceTypeCode>');
    expect(xml).toMatch(new RegExp(`<cac:BillingReference>\\s*<cac:InvoiceDocumentReference>\\s*<cbc:ID>${adv.invoiceNumber}</cbc:ID>`));
    expect(xml).toContain("<cbc:InstructionNote>Order cancelled</cbc:InstructionNote>");
    expect(xml).toContain('<cbc:TaxInclusiveAmount currencyID="SAR">4600.00</cbc:TaxInclusiveAmount>');
    expect(xml).toContain('<cbc:TaxAmount currencyID="SAR">600.00</cbc:TaxAmount>');
    expect(xml).toContain('<cbc:PrepaidAmount currencyID="SAR">0.00</cbc:PrepaidAmount>');
    expect(xml).toContain('<cbc:PayableAmount currencyID="SAR">4600.00</cbc:PayableAmount>');
    expect(xml).not.toContain("Prepayment adjustment");
    await refund(p.id, custA, 4_600);
  });

  // ── 10, 13 (partial): no double credit, no double refund; a partial credit ─
  it("🔴 PARTIAL: crediting part of a 386 unlocks exactly that part; the rest stays open for a final invoice; a second note beyond the open balance and a second refund beyond the credited cash are refused; a fully-applied 386 cannot be credited", async () => {
    const p = await receiveAdvance(custA, 11_500);
    const adv = await issueAdvance(p.id, 11_500);
    const before = { vat: await gl("VAT_OUTPUT"), deposits: await gl("CUSTOMER_DEPOSITS", custA) };
    const note = await issueNote(adv.id, 4_600); // 4,000 + 600
    expect(note.subtotal).toBe(4_000);
    expect(note.vatAmount).toBe(600);
    expect(await gl("VAT_OUTPUT")).toBe(before.vat - 600);
    expect(await gl("CUSTOMER_DEPOSITS", custA)).toBe(before.deposits + 600);
    let pv = await getPayment(p.id);
    expect(pv.advanceOpenAmount).toBe(6_900);
    expect(pv.uninvoicedAmount).toBe(4_600);
    expect((await inTenant(() => advanceInvoicesService.openForCustomer(custA))).find((o) => o.id === adv.id)).toMatchObject({ creditedAmount: 4_600, openAmount: 6_900 });
    // a refund beyond the credited cash is refused; exactly it goes through
    await expectRefusal(refund(p.id, custA, 4_600.01), 409, "advance_invoiced_requires_prepayment_adjustment");
    await refund(p.id, custA, 4_600);
    pv = await getPayment(p.id);
    expect(pv.uninvoicedAmount).toBe(0);
    expect(pv.unappliedAmount).toBe(6_900);
    await expectRefusal(refund(p.id, custA, 1), 409, "advance_invoiced_requires_prepayment_adjustment");
    // a second note beyond the open 6,900 is refused at create; two concurrent drafts → the second is refused at approval, nothing minted
    await expectRefusal(draftNote(adv.id, 6_900.01), 409, "advance_credit_note_exceeds_open");
    const d1 = await draftNote(adv.id, 6_900);
    const d2 = await draftNote(adv.id, 6_900);
    // the remaining 6,900 is applied on a final invoice instead (door B) — which also consumes the open balance the drafts were written against
    const fin = await issueFinal(custA, 6_000, [{ advanceInvoiceId: adv.id }]);
    expect(fin.prepaidAmount).toBe(6_900);
    expect(fin.status).toBe("paid");
    const vatBefore = await gl("VAT_OUTPUT");
    await expectRefusal(inTenant(() => invoicesService.approve(d1.id, userId)), 409, "advance_credit_note_exceeds_open");
    await expectRefusal(inTenant(() => invoicesService.approve(d2.id, userId)), 409, "advance_credit_note_exceeds_open");
    expect(await gl("VAT_OUTPUT")).toBe(vatBefore);
    expect((await getInvoice(d1.id)).icv).toBeNull();
    // a fully-applied (and partly credited) 386 has nothing left to credit
    await expectRefusal(draftNote(adv.id, 1), 409, "advance_credit_note_exceeds_open");
    pv = await getPayment(p.id);
    expect(pv.unappliedAmount).toBe(0);
    expect(pv.advanceAdjustedAmount).toBe(6_900);
    expect(pv.advanceInvoices[0]).toMatchObject({ creditedAmount: 4_600, adjustedAmount: 6_900, openAmount: 0 });
    expect(await depositsInvariantViolations()).toEqual([]);
    for (const d of [d1, d2]) await inTenant(() => invoicesService.deleteDraft(d.id));
  });

  // ── the credited advance can still become a NEW tax point, never the same one twice ─
  it("after a full credit the deposit reads as an un-invoiced advance again (review: advance_not_invoiced); a NEW 386 may be issued for it — the old one stays credited and closed", async () => {
    const p = await receiveAdvance(custB, 2_300);
    const adv = await issueAdvance(p.id, 2_300);
    await issueNote(adv.id, 2_300);
    const item = (await inTenant(() => depositReviewService.review({ customerId: custB }))).items.find((i) => i.paymentId === p.id)!;
    expect(item.reviewState).toBe("advance_not_invoiced");
    expect(item.uninvoicedAmount).toBe(2_300);
    const adv2 = await issueAdvance(p.id, 2_300);
    expect(adv2.id).not.toBe(adv.id);
    const pv = await getPayment(p.id);
    expect(pv.advanceInvoices.map((a) => [a.id, a.openAmount, a.creditedAmount])).toEqual([[adv.id, 0, 2_300], [adv2.id, 2_300, 0]]);
    expect(pv.advanceOpenAmount).toBe(2_300);
    await expectRefusal(draftNote(adv.id, 1), 409, "advance_credit_note_exceeds_open");
    await issueNote(adv2.id, 2_300);
    await refund(p.id, custB, 2_300);
  });

  // ── 14: closed periods ────────────────────────────────────────────────
  it("🔴 closed month: a note dated into it is refused (423) with nothing posted; dated in the open month it issues; the refund is refused into a closed month too (Batch 1B, unchanged)", async () => {
    const p = await receiveAdvance(custB, 1_150);
    const adv = await issueAdvance(p.id, 1_150);
    await inTenant(() => periodLocksService.lock({ period: "2026-07", userId }));
    try {
      const vatBefore = await gl("VAT_OUTPUT");
      await expectRefusal(draftNote(adv.id, 1_150, { date: NOTE_DATE }), 423);
      const d = await draftNote(adv.id, 1_150, { date: businessToday() });
      await inTenant(() => periodLocksService.lock({ period: businessToday().slice(0, 7), userId }));
      await expectRefusal(inTenant(() => invoicesService.approve(d.id, userId)), 423);
      expect(await gl("VAT_OUTPUT")).toBe(vatBefore);
      expect((await getPayment(p.id)).uninvoicedAmount).toBe(0);
      await inTenant(() => periodLocksService.unlock(businessToday().slice(0, 7)));
      await inTenant(() => invoicesService.approve(d.id, userId));
      expect((await getPayment(p.id)).uninvoicedAmount).toBe(1_150);
      await expectRefusal(refund(p.id, custB, 1_150, { refundedAt: NOTE_DATE }), 423);
      await refund(p.id, custB, 1_150, { refundedAt: businessToday() });
    } finally {
      await inTenant(() => periodLocksService.unlock("2026-07"));
    }
  });

  // ── 15, 16, 17: the other doors, unchanged ────────────────────────────
  it("🔴 door A unchanged: an ordinary (unknown / erroneous) deposit refunds directly with no note; door B unchanged: an applied 386 issues a paid final invoice; AP-1's classification is untouched by the note", async () => {
    const plain = await receive(custB, 500, { classification: "erroneous" });
    const r = await refund(plain.id, custB, 500);
    expect(r.amount).toBe(500);
    expect((await getPayment(plain.id)).classification?.classification).toBe("erroneous");
    const p = await receiveAdvance(custB, 5_750);
    const adv = await issueAdvance(p.id, 5_750);
    const fin = await issueFinal(custB, 5_000, [{ advanceInvoiceId: adv.id }]);
    expect(fin.status).toBe("paid");
    expect(fin.prepaidAmount).toBe(5_750);
    await expectRefusal(draftNote(adv.id, 1), 409, "advance_credit_note_exceeds_open");
    // the note leaves the classification record alone (a dated statement, AP-1)
    const p2 = await receiveAdvance(custB, 230);
    const adv2 = await issueAdvance(p2.id, 230);
    const history = await inTenant(() => paymentsService.classificationHistory(p2.id));
    await issueNote(adv2.id, 230);
    expect(await inTenant(() => paymentsService.classificationHistory(p2.id))).toEqual(history);
    expect((await getPayment(p2.id)).classification?.classification).toBe("advance");
    await refund(p2.id, custB, 230);
  });

  // ── 19: Z1 stays blocked ──────────────────────────────────────────────
  it("🔴 Z1: a migrated opening deposit gets no 386 here and so no credit note — the door stays shut", async () => {
    const opening = await pool.query(
      `INSERT INTO payments (organization_id, company_id, direction, party_type, customer_id, bank_account_id, amount, paid_at, source, journal_entry_id)
       SELECT $1, $2, 'in', 'customer', $3, $4, 3000, '2026-01-01', 'opening', (SELECT id FROM journal_entries WHERE organization_id = $1 ORDER BY id LIMIT 1) RETURNING id`,
      [orgId, companyId, custA, bank]);
    await expectRefusal(inTenant(() => advanceInvoicesService.createFromReceipt(opening.rows[0].id, { amount: 3000 }, userId)), 409, "opening_deposit_not_advance_invoiced");
    await pool.query(`DELETE FROM payments WHERE id = $1`, [opening.rows[0].id]);
  });

  it("every journal posted by this suite balances; no advance credit note ever carries AR, revenue, a credit balance or a bank line", async () => {
    const unbalanced = (await pool.query(`SELECT e.entry_number FROM journal_entries e JOIN journal_entry_lines l ON l.journal_entry_id = e.id WHERE e.organization_id = $1 GROUP BY e.id HAVING sum(l.debit_amount) <> sum(l.credit_amount)`, [orgId])).rows;
    expect(unbalanced).toEqual([]);
    const wrong = (await pool.query(`
      SELECT i.invoice_number, c.system_code FROM invoices i
        JOIN journal_entries e ON e.organization_id = i.organization_id AND e.entry_number = 'GL-' || i.invoice_number
        JOIN journal_entry_lines l ON l.journal_entry_id = e.id JOIN categories c ON c.id = l.account_id
       WHERE i.organization_id = $1 AND i.document_type = 'advance_credit_note' AND (c.system_code IN ('AR','SALES','CUSTOMER_CREDITS') OR c.bank_account_id IS NOT NULL)`, [orgId])).rows;
    expect(wrong).toEqual([]);
    expect(await depositsInvariantViolations()).toEqual([]);
  });
});
