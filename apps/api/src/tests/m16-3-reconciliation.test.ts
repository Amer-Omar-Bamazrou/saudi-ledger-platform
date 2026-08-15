/**
 * M16.3 — bank reconciliation (design §3; Q3a/Q3b decided by the owner).
 *
 * The claims under test, each pinned the way the design states them:
 *
 *  - MATCHING IS EXACT AND SUGGESTS ONLY. A document number referenced in the
 *    description, or an amount equal to exactly ONE open document's
 *    outstanding balance. Ambiguity → nothing. Description-referenced
 *    partials are suggested; amount-only partials never (Q3b). A suggestion
 *    changes NO state (Q3a — never auto-applied, even for exact number hits).
 *
 *  - SETTLING IS ONE ACT THROUGH THE EXISTING PAY PATH. Accepting the match
 *    takes the row out of the holding area AND records the payment via
 *    `invoicesService.pay` / `billsService.pay` (Dr Cash/Cr AR — no parallel
 *    posting path). The row becomes `kind: settlement`.
 *
 *  - THE PROPERTY (the double-count the milestone exists to kill): settling a
 *    receipt moves NO income and NO VAT figure — the income was recognised at
 *    issuance — while cash flow and the invoice's paid state DO move (so the
 *    check cannot pass vacuously).
 *
 *  - PARTIAL PAYMENTS ACCUMULATE and keep the document open — a partly-paid
 *    invoice must stay in AR aging (pre-M16.3, any payment flipped status to
 *    "paid" and the residual vanished from aging while balance-sheet AR kept
 *    it: silent drift between two reports).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { transactionsService } from "../services/transactions.service";
import { invoicesService } from "../services/invoices.service";
import { billsService } from "../services/bills.service";
import { reconciliationService, referencesDocumentNumber } from "../services/reconciliation.service";
import { summaryService } from "../services/summary.service";
import { reportsService } from "../services/reports.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[m16-3-reconciliation] no real DATABASE_URL — skipping.");

const SLUG = "m16-reconciliation";
const EMAIL = "m16-recon@test.local";

describeMaybe("M16.3 — bank reconciliation", () => {
  let orgId = "";
  let companyId = "";
  let userId = 0;
  let customerId = 0;
  let vendorId = 0;
  let accountId = 0;

  async function inTenant<T>(fn: () => Promise<T>): Promise<T> {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
    try {
      const out = await conn.run(() =>
        auditContext.run({ userId, organizationId: orgId, ipAddress: null }, fn),
      );
      await conn.commit();
      return out;
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  }

  const cleanup = async () => {
    const org = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
    const usr = `(SELECT id FROM users WHERE email = '${EMAIL}')`;
    await pool.query(`DELETE FROM transactions WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM journal_entry_lines WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM journal_entries WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM invoice_items WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM einvoice_documents WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM invoices WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM bill_items WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM bills WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM customers WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM vendors WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM bank_accounts WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM audit_logs WHERE organization_id IN ${org} OR user_id IN ${usr}`);
    await pool.query(`DELETE FROM organization_memberships WHERE user_id IN ${usr} OR organization_id IN ${org}`);
    await pool.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
    await pool.query(`DELETE FROM categories WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM companies WHERE organization_id IN ${org}`);
    await pool.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Recon Org','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (
      await pool.query(
        `INSERT INTO companies (organization_id, name, cr_number, vat_number) VALUES ($1,'RC','1010101015','399999999999993') RETURNING id`,
        [orgId],
      )
    ).rows[0].id;
    userId = (
      await pool.query(
        `INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','RC',' ','viewer',true) RETURNING id`,
      )
    ).rows[0].id;
    await pool.query(
      `INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`,
      [userId, orgId],
    );
    customerId = (
      await pool.query(`INSERT INTO customers (organization_id, name) VALUES ($1,'Almarai Trading') RETURNING id`, [orgId])
    ).rows[0].id;
    vendorId = (
      await pool.query(`INSERT INTO vendors (organization_id, name) VALUES ($1,'Office Supplies Co') RETURNING id`, [orgId])
    ).rows[0].id;
    accountId = (
      await pool.query(
        `INSERT INTO bank_accounts (organization_id, company_id, name, bank_name) VALUES ($1,$2,'Main SAR','Al Rajhi') RETURNING id`,
        [orgId, companyId],
      )
    ).rows[0].id;
  });

  afterAll(cleanup);

  /** Create + approve an invoice: `unitPrice` net + 15% VAT ⇒ gross 1.15×. */
  async function issueInvoice(num: string, unitPrice: number): Promise<number> {
    const inv = await inTenant(() =>
      invoicesService.create(
        {
          invoiceNumber: num,
          date: "2026-07-01",
          customerId,
          items: [{ description: "Service", quantity: 1, unitPrice, vatRate: 15 }],
        },
        userId,
        { autoApprove: false },
      ),
    );
    await inTenant(() => invoicesService.approve(inv.id, userId));
    return inv.id;
  }

  async function issueBill(num: string, unitPrice: number): Promise<number> {
    const bill = await inTenant(() =>
      billsService.create(
        {
          billNumber: num,
          date: "2026-07-01",
          vendorId,
          items: [{ description: "Supplies", quantity: 1, unitPrice, vatRate: 15 }],
        },
        userId,
      ),
    );
    await inTenant(() => billsService.submit(bill.id, userId));
    await inTenant(() => billsService.approve(bill.id, {}, userId));
    return bill.id;
  }

  /** Upload ONE statement row through the product's own write path. */
  async function uploadRow(row: { date: string; description: string; amount: number; type: "debit" | "credit" }) {
    const res = (await inTenant(() =>
      transactionsService.upload({ rows: [{ ...row, currency: "SAR" }], autoCategrize: true, bankAccountId: accountId } as never),
    )) as { inserted: number };
    expect(res.inserted).toBe(1);
    const { rows } = await pool.query(
      `SELECT id FROM transactions WHERE organization_id = $1 AND description = $2 ORDER BY id DESC LIMIT 1`,
      [orgId, row.description],
    );
    return Number(rows[0].id);
  }

  async function suggestionFor(txId: number) {
    const pending = await inTenant(() => transactionsService.pendingReview());
    const row = pending.find((p) => p.id === txId);
    expect(row, `tx ${txId} should be pending`).toBeTruthy();
    return row!.suggestion;
  }

  let invA = 0; // 1150.00 — unique amount
  let invB = 0; // 575.00 — same outstanding as C (ambiguous by amount)
  let invC = 0;
  let invD = 0; // 2300.00 — the partial-payment target

  beforeAll(async () => {
    invA = await issueInvoice("M163-A", 1000);
    invB = await issueInvoice("M163-B", 500);
    invC = await issueInvoice("M163-C", 500);
    invD = await issueInvoice("M163-D", 2000);
  });

  // ── The matcher itself ─────────────────────────────────────────────────────

  it("document-number matching is token-bounded — M163-1 never matches inside M163-10", () => {
    expect(referencesDocumentNumber("PAYMENT REF M163-10 JULY", "M163-1")).toBe(false);
    expect(referencesDocumentNumber("PAYMENT REF M163-1 JULY", "M163-1")).toBe(true);
    expect(referencesDocumentNumber("payment ref m163-1.", "M163-1")).toBe(true); // case + punctuation boundary
  });

  it("suggests by document number referenced in the description (full match)", async () => {
    const tx = await uploadRow({ date: "2026-07-10", description: "INCOMING SWIFT M163-A SETTLEMENT", amount: 1150, type: "credit" });
    const s = await suggestionFor(tx);
    expect(s).toMatchObject({ documentKind: "invoice", documentId: invA, documentNumber: "M163-A", matchedBy: "number", partial: false });
  });

  it("suggests by amount when it equals exactly ONE open invoice's outstanding balance", async () => {
    const tx = await uploadRow({ date: "2026-07-11", description: "UNKNOWN INCOMING CREDIT 82813", amount: 1150, type: "credit" });
    const s = await suggestionFor(tx);
    expect(s).toMatchObject({ documentKind: "invoice", documentId: invA, matchedBy: "amount", partial: false });
  });

  it("an AMBIGUOUS amount match suggests NOTHING — two invoices share that outstanding", async () => {
    const tx = await uploadRow({ date: "2026-07-12", description: "UNKNOWN INCOMING CREDIT 99120", amount: 575, type: "credit" });
    expect(await suggestionFor(tx)).toBeNull();
  });

  it("Q3b — a description-referenced PARTIAL is suggested; an amount-only partial never is", async () => {
    const referenced = await uploadRow({ date: "2026-07-13", description: "PART PAYMENT M163-D FIRST INSTALMENT", amount: 1000, type: "credit" });
    const s = await suggestionFor(referenced);
    expect(s).toMatchObject({ documentKind: "invoice", documentId: invD, matchedBy: "number", partial: true });

    // 999 equals no outstanding and references nothing ⇒ silence, not a guess.
    const amountOnly = await uploadRow({ date: "2026-07-13", description: "INCOMING 77120 NO REFERENCE", amount: 999, type: "credit" });
    expect(await suggestionFor(amountOnly)).toBeNull();
  });

  it("a DRAFT invoice is never suggested — it has no receivable to settle", async () => {
    const draft = await inTenant(() =>
      invoicesService.create(
        { invoiceNumber: "M163-DRAFT", date: "2026-07-01", customerId, items: [{ description: "S", quantity: 1, unitPrice: 868, vatRate: 15 }] },
        userId,
        { autoApprove: false },
      ),
    );
    // 998.20 gross — unique across ALL documents, but the invoice is a draft.
    const tx = await uploadRow({ date: "2026-07-14", description: "INCOMING MATCHING A DRAFT 55100", amount: 998.2, type: "credit" });
    expect(await suggestionFor(tx)).toBeNull();
    await inTenant(() => invoicesService.remove(draft.id));
  });

  // ── Q3a: suggestions are never actions ────────────────────────────────────

  it("🔴 Q3a — a suggestion changes NOTHING: the row stays pending, the invoice stays unpaid", async () => {
    // The suggestion for M163-A has been computed (twice) above. Nothing moved:
    const { rows: [tx] } = await pool.query(
      `SELECT review_status, kind, settles_invoice_id FROM transactions WHERE organization_id = $1 AND description LIKE 'INCOMING SWIFT M163-A%'`,
      [orgId],
    );
    expect(tx.review_status).toBe("pending_review");
    expect(tx.kind).toBe("operating");
    expect(tx.settles_invoice_id).toBeNull();
    const { rows: [inv] } = await pool.query(`SELECT status, paid_amount::text FROM invoices WHERE id = $1`, [invA]);
    expect(inv.status).toBe("sent");
    expect(Number(inv.paid_amount)).toBe(0);
  });

  // ── The one act, and the property ─────────────────────────────────────────

  // M17.0 — the `zakat` probe was dropped from this test. It called
  // `summaryService.getZakat()`, which summed rows flagged `is_zakat_relevant`;
  // almost nothing wrote that flag (one rule, Tadawul/investment, absent from these fixtures), so before and after were both an empty result
  // and the assertion compared 0 to 0. The income/VAT/cash/AR probes below do
  // carry signal and are unchanged.
  it("🔴 THE PROPERTY: settling moves NO income/VAT figure; cash flow and the invoice DO move", async () => {
    const range = { dateFrom: "2026-01-01", dateTo: "2026-12-31" };
    const before = {
      income: await inTenant(() => reportsService.incomeStatement("2026-01-01", "2026-12-31")),
      vat: await inTenant(() => summaryService.getVat(range)),
      vatReturn: await inTenant(() => reportsService.vatReturn("2026-01", "2026-12")),
      summary: await inTenant(() => summaryService.getSummary(range)),
      cash: await inTenant(() => reportsService.cashFlow("2026-01-01", "2026-12-31")),
      bs: await inTenant(() => reportsService.balanceSheet("2026-12-31")),
    };

    const { rows: [{ id: txId }] } = await pool.query(
      `SELECT id FROM transactions WHERE organization_id = $1 AND description LIKE 'INCOMING SWIFT M163-A%'`,
      [orgId],
    );
    const settled = await inTenant(() => transactionsService.settle(Number(txId), { invoiceId: invA }, userId));
    expect(settled.kind).toBe("settlement");
    expect(settled.reviewStatus).toBe("accepted");
    expect(settled.settlesInvoiceId).toBe(invA);
    expect(settled.vatAmount).toBeNull(); // any guessed VAT is gone — the VAT fact lives on the invoice

    const after = {
      income: await inTenant(() => reportsService.incomeStatement("2026-01-01", "2026-12-31")),
      vat: await inTenant(() => summaryService.getVat(range)),
      vatReturn: await inTenant(() => reportsService.vatReturn("2026-01", "2026-12")),
      summary: await inTenant(() => summaryService.getSummary(range)),
      cash: await inTenant(() => reportsService.cashFlow("2026-01-01", "2026-12-31")),
      bs: await inTenant(() => reportsService.balanceSheet("2026-12-31")),
    };

    // Nothing tax- or P&L-facing moved — byte-identical, not "close":
    expect(after.income).toEqual(before.income);
    expect(after.vat).toEqual(before.vat);
    expect(after.vatReturn).toEqual(before.vatReturn);
    expect((after.summary as { totalIncome: number }).totalIncome).toBe((before.summary as { totalIncome: number }).totalIncome);
    expect((after.summary as { totalExpenses: number }).totalExpenses).toBe((before.summary as { totalExpenses: number }).totalExpenses);

    // …and the check is not vacuous — the things that SHOULD move, moved:
    expect((after.cash as { netChange: number }).netChange).not.toBe((before.cash as { netChange: number }).netChange);
    const arBefore = (before.bs as { assets: { accountsReceivable: number } }).assets.accountsReceivable;
    const arAfter = (after.bs as { assets: { accountsReceivable: number } }).assets.accountsReceivable;
    expect(Math.round((arBefore - arAfter) * 100) / 100).toBe(1150); // Dr Cash / Cr AR posted by the EXISTING pay path
    const { rows: [inv] } = await pool.query(`SELECT status, paid_amount::text FROM invoices WHERE id = $1`, [invA]);
    expect(inv.status).toBe("paid");
    expect(inv.paid_amount).toBe("1150.00");
  });

  it("the GL entry came from the EXISTING pay path — one writer per effect", async () => {
    const { rows } = await pool.query(
      `SELECT entry_number FROM journal_entries WHERE organization_id = $1 AND entry_number = 'GL-M163-A-PAY'`,
      [orgId],
    );
    expect(rows).toHaveLength(1);
  });

  // ── Partials accumulate; aging stays honest ───────────────────────────────

  it("a partial settlement keeps the invoice OPEN, in AR aging, with the residual", async () => {
    const { rows: [{ id: txId }] } = await pool.query(
      `SELECT id FROM transactions WHERE organization_id = $1 AND description LIKE 'PART PAYMENT M163-D%'`,
      [orgId],
    );
    await inTenant(() => transactionsService.settle(Number(txId), { invoiceId: invD }, userId));

    const { rows: [inv] } = await pool.query(`SELECT status, paid_amount::text FROM invoices WHERE id = $1`, [invD]);
    expect(inv.status).toBe("sent"); // 🔴 pre-M16.3 this flipped to "paid" and vanished from aging
    expect(inv.paid_amount).toBe("1000.00");

    const aging = (await inTenant(() => reportsService.arAging())) as { items: Array<{ invoiceNumber: string; outstanding: number }> };
    const aged = aging.items.find((i) => i.invoiceNumber === "M163-D");
    expect(aged?.outstanding).toBe(1300);
  });

  it("a second settlement of the residual closes it", async () => {
    const tx = await uploadRow({ date: "2026-07-20", description: "FINAL PAYMENT M163-D", amount: 1300, type: "credit" });
    const s = await suggestionFor(tx);
    expect(s).toMatchObject({ documentId: invD, matchedBy: "number", partial: false }); // outstanding is now 1300
    await inTenant(() => transactionsService.settle(tx, { invoiceId: invD }, userId));
    const { rows: [inv] } = await pool.query(`SELECT status, paid_amount::text FROM invoices WHERE id = $1`, [invD]);
    expect(inv.status).toBe("paid");
    expect(inv.paid_amount).toBe("2300.00");
  });

  // ── Guards ────────────────────────────────────────────────────────────────

  it("overpaying the outstanding balance is refused (409) — shared with every pay path", async () => {
    const tx = await uploadRow({ date: "2026-07-21", description: "HUGE INCOMING 91223", amount: 5000, type: "credit" });
    await expect(inTenant(() => transactionsService.settle(tx, { invoiceId: invB }, userId))).rejects.toMatchObject({ statusCode: 409 });
  });

  it("a debit cannot settle an invoice; naming both or neither document is a 400", async () => {
    const debit = await uploadRow({ date: "2026-07-22", description: "OUTGOING 55221 MISC", amount: 120, type: "debit" });
    await expect(inTenant(() => transactionsService.settle(debit, { invoiceId: invB }, userId))).rejects.toMatchObject({ statusCode: 400 });
    await expect(inTenant(() => transactionsService.settle(debit, {}, userId))).rejects.toMatchObject({ statusCode: 400 });
    await expect(inTenant(() => transactionsService.settle(debit, { invoiceId: invB, billId: 1 }, userId))).rejects.toMatchObject({ statusCode: 400 });
  });

  it("an already-accepted row cannot be settled from review (409)", async () => {
    const tx = await uploadRow({ date: "2026-07-23", description: "INCOMING 61200 PLAIN", amount: 42, type: "credit" });
    await inTenant(() => transactionsService.acceptPending([tx]));
    await expect(inTenant(() => transactionsService.settle(tx, { invoiceId: invB }, userId))).rejects.toMatchObject({ statusCode: 409 });
  });

  // ── The bills side ────────────────────────────────────────────────────────

  it("a debit settles a BILL symmetrically — and the expense figure does not move", async () => {
    const billId = await issueBill("BILL-M163", 1000); // 1150 gross, in AP
    const tx = await uploadRow({ date: "2026-07-25", description: "SADAD PAYMENT BILL-M163 OFFICE SUPPLIES", amount: 1150, type: "debit" });
    const s = await suggestionFor(tx);
    expect(s).toMatchObject({ documentKind: "bill", documentId: billId, documentNumber: "BILL-M163", matchedBy: "number" });

    const range = { dateFrom: "2026-01-01", dateTo: "2026-12-31" };
    const before = await inTenant(() => summaryService.getSummary(range));
    const settled = await inTenant(() => transactionsService.settle(tx, { billId }, userId));
    expect(settled.kind).toBe("settlement");
    expect(settled.settlesBillId).toBe(billId);
    const after = await inTenant(() => summaryService.getSummary(range));

    // The expense was recognised when the bill was approved (document side);
    // the bank debit settling it must not add a second, transaction-side one.
    expect((after as { totalExpenses: number }).totalExpenses).toBe((before as { totalExpenses: number }).totalExpenses);

    const { rows: [bill] } = await pool.query(`SELECT status, paid_amount::text FROM bills WHERE id = $1`, [billId]);
    expect(bill.status).toBe("paid");
    expect(bill.paid_amount).toBe("1150.00");
  });

  it("every settle transition is audited", async () => {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM audit_logs WHERE organization_id = $1 AND action = 'settle'`,
      [orgId],
    );
    expect(rows[0].n).toBeGreaterThanOrEqual(4);
  });
});
