/**
 * 🔴 G64 — REGRESSION: one bank-statement line settles ONE document, once.
 *
 * `POST /transactions/:id/settle` read the line's `pending_review` state
 * unlocked, so two concurrent settles of one line both passed it and both
 * recorded a receipt: the bank moved twice for one line (reproduced, Phase 18
 * Batch 4B, `phase18-s1b-g64-double-settle.test.ts`, which lands unchanged
 * beside this file). The fix locks the line (`lockLine`, the lock every
 * reconciliation write for a line takes) before the line is read.
 *
 * Invariants, computed two ways and non-zero: one line → at most one receipt
 * (or one bill payment); the bank moves by exactly the line's amount; the
 * document's `paid_amount` = Σ its receipts = the GL cash on that bank.
 *
 * The race is FORCED with `helpers/g08rRace.ts` (`queuedBehind`): a holder
 * locks THIS line's row and each settle is seen waiting inside the holder's
 * own wait tree before the next is sent — never a database-wide count, so a
 * parallel file's lock waits cannot make the race look established. Also:
 * the sequential control, unforced concurrent rounds, the bill side, and
 * another organisation's line (404, nothing moves).
 *
 * DB-backed (sl_test / CI); skips on the DB-free placeholder.
 */
process.env.PORT ??= "3201";
process.env.SESSION_SECRET ??= "g64-statement-line-settle-regression-0001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness, type Res } from "./helpers/g04Harness";
import { queuedBehind } from "./helpers/g08rRace";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "G64RegressionPw123!";
const REFUSAL = "Only a pending transaction can be settled from review.";

describeMaybe("G64 — one statement line settles one document, once", () => {
  const h = g04Harness("g64reg");
  let orgId = "";
  let otherOrgId = "";
  let customerId = 0;
  let vendorId = 0;
  let bankId = 0;
  let otherBankId = 0;
  let seq = 0;

  async function issuedInvoice(): Promise<number> {
    seq += 1;
    const created = await h.api("bookkeeper", "POST", "/invoices", {
      invoiceNumber: `G64REG-INV-${seq}`, date: "2026-10-01", customerId,
      items: [{ description: "Service", quantity: 1, unitPrice: 1_000, vatRate: 15 }], // 1,150.00: room for two partial receipts of 400
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const approved = await h.api("admin", "POST", `/invoices/${created.body.id}/approve`, {});
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    return created.body.id as number;
  }

  async function postedBill(): Promise<number> {
    seq += 1;
    const no = `G64REG-BL-${seq}`;
    const created = await h.api("bookkeeper", "POST", "/bills", {
      supplierDocumentKind: "tax_invoice", vendorReference: `VR-${no}`, billNumber: no, date: "2026-10-01", dueDate: "2026-10-01", vendorId,
      subtotal: 1_000, vatAmount: 0, total: 1_000, // room for two partial payments of 400
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const approved = await h.api("admin", "POST", `/bills/${created.body.id}/approve`, {});
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    return created.body.id as number;
  }

  /** One uploaded statement line, waiting in review. */
  async function pendingLine(who: string, bank: number, org: string, type: "credit" | "debit", amount = 400): Promise<number> {
    seq += 1;
    const description = `G64REG LINE ${seq}`;
    const up = await h.api(who, "POST", "/transactions/upload", { rows: [{ date: "2026-10-05", description, amount, currency: "SAR", type }], bankAccountId: bank });
    expect(up.status, JSON.stringify(up.body)).toBe(200);
    const row = (await pool.query(`SELECT id, review_status FROM transactions WHERE organization_id = $1 AND description = $2`, [org, description])).rows[0];
    expect(row?.review_status).toBe("pending_review");
    return row.id as number;
  }

  /** The bank's GL cash, read through the one "which bank" view. */
  const bankCash = async (bank: number) => Number((await pool.query(
    `SELECT coalesce(sum(v.debit_amount - v.credit_amount), 0)::text AS v
       FROM journal_line_bank_identity v JOIN journal_entries e ON e.id = v.journal_entry_id
      WHERE v.bank_account_id = $1 AND e.status IN ('posted','reversed')`, [bank],
  )).rows[0].v);

  async function invoiceEvidence(txId: number, invoiceId: number) {
    const receipts = (await pool.query(`SELECT amount::text FROM payments WHERE organization_id = $1 AND source_transaction_id = $2`, [orgId, txId])).rows;
    // Σ receipts applied to the invoice: its live allocations (a receipt reaches an invoice through payment_allocations).
    const allReceipts = (await pool.query(
      `SELECT coalesce(sum(a.amount), 0)::text AS s FROM payment_allocations a
        WHERE a.organization_id = $1 AND a.invoice_id = $2
          AND NOT EXISTS (SELECT 1 FROM payment_allocation_reversals r WHERE r.allocation_id = a.id)`, [orgId, invoiceId],
    )).rows[0].s;
    const inv = (await pool.query(`SELECT paid_amount::text FROM invoices WHERE id = $1`, [invoiceId])).rows[0];
    const line = (await pool.query(`SELECT review_status, kind, settles_invoice_id FROM transactions WHERE id = $1`, [txId])).rows[0];
    return { receiptCount: receipts.length, receiptTotal: receipts.reduce((s: number, r: { amount: string }) => s + Number(r.amount), 0), invoicePaid: Number(inv.paid_amount), allReceipts: Number(allReceipts), line };
  }

  const settle = (who: string, txId: number, doc: { invoiceId?: number; billId?: number }) => h.api(who, "POST", `/transactions/${txId}/settle`, doc);
  const outcome = (rs: Res[]) => rs.map((r) => r.status).sort((a, b) => a - b);

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    await h.mkCompany(orgId, "G64 Regression Co", "318181818181881");
    otherOrgId = await h.mkOrg("other");
    await h.mkCompany(otherOrgId, "G64 Other Co", "318181818181882");
    customerId = (await pool.query(`INSERT INTO customers (organization_id, name, tax_number) VALUES ($1,'G64 Buyer','300000000000003') RETURNING id`, [orgId])).rows[0].id;
    vendorId = (await pool.query(`INSERT INTO vendors (organization_id, name) VALUES ($1,'G64 Supplier') RETURNING id`, [orgId])).rows[0].id;
    for (const [who, role] of [["admin", "admin"], ["accountant", "accountant"], ["bookkeeper", "bookkeeper"]]) await h.mkUser(who, PW, orgId, role);
    await h.mkUser("otheradmin", PW, otherOrgId, "admin");
    await h.start();
    for (const who of ["admin", "accountant", "bookkeeper", "otheradmin"]) expect(await h.login(who, h.email(who), PW), `login ${who}`).toBe(200);
    const bank = await h.api("admin", "POST", "/bank-accounts", { name: "G64 Ops", bankName: "SNB", currency: "SAR" });
    expect(bank.status, JSON.stringify(bank.body)).toBe(201);
    bankId = bank.body.id;
    const other = await h.api("otheradmin", "POST", "/bank-accounts", { name: "G64 Other Ops", bankName: "SNB", currency: "SAR" });
    expect(other.status, JSON.stringify(other.body)).toBe(201);
    otherBankId = other.body.id;
  }, 120_000);
  afterAll(async () => { await h.stop(); await h.cleanup(); });

  it("CONTROL (sequential): a settled line refuses a second settle with the review refusal; one receipt; the bank moves by the line once", async () => {
    const invoiceId = await issuedInvoice();
    const txId = await pendingLine("bookkeeper", bankId, orgId, "credit");
    const cash0 = await bankCash(bankId);
    expect((await settle("admin", txId, { invoiceId })).status).toBe(200);
    const second = await settle("accountant", txId, { invoiceId });
    expect(second.status).toBe(409);
    expect(second.body?.error).toBe(REFUSAL);
    const ev = await invoiceEvidence(txId, invoiceId);
    expect([ev.receiptCount, ev.receiptTotal, ev.invoicePaid, ev.allReceipts]).toEqual([1, 400, 400, 400]);
    expect(await bankCash(bankId) - cash0).toBe(400);
    expect(ev.line).toEqual({ review_status: "accepted", kind: "settlement", settles_invoice_id: invoiceId });
  }, 60_000);

  it("🔴 FORCED (invoice): two settles of one line queued behind a holder on THAT line — one 200, one 409 with the review refusal; one receipt; paid = Σ receipts = the bank's movement = 400", async () => {
    const invoiceId = await issuedInvoice();
    const txId = await pendingLine("bookkeeper", bankId, orgId, "credit");
    const cash0 = await bankCash(bankId);
    const rs = await queuedBehind("transactions", txId, [() => settle("admin", txId, { invoiceId }), () => settle("accountant", txId, { invoiceId })]);
    const ev = await invoiceEvidence(txId, invoiceId);
    const moved = await bankCash(bankId) - cash0;
    // eslint-disable-next-line no-console
    console.warn("[G64 REG] forced invoice", JSON.stringify({ statuses: rs.map((r) => [r.status, r.body?.error ?? null]), moved, ...ev }));
    expect(outcome(rs)).toEqual([200, 409]);
    expect(rs.find((r) => r.status === 409)?.body?.error).toBe(REFUSAL);
    expect([ev.receiptCount, ev.receiptTotal]).toEqual([1, 400]);
    expect(ev.invoicePaid, "the invoice's paid amount equals its receipts").toBe(ev.allReceipts);
    expect(moved, "the bank's GL cash moved by the line's amount, once").toBe(ev.receiptTotal);
    expect(moved).toBe(400);
  }, 60_000);

  it("🔴 FORCED (bill): two settles of one debit line against a bill — one 200, one 409; one bill payment; paid = Σ payments = the bank's movement = −400", async () => {
    const billId = await postedBill();
    const txId = await pendingLine("bookkeeper", bankId, orgId, "debit");
    const cash0 = await bankCash(bankId);
    const rs = await queuedBehind("transactions", txId, [() => settle("admin", txId, { billId }), () => settle("accountant", txId, { billId })]);
    const payments = (await pool.query(`SELECT amount::text FROM bill_payments WHERE organization_id = $1 AND bill_id = $2`, [orgId, billId])).rows;
    const paidSum = payments.reduce((s: number, r: { amount: string }) => s + Number(r.amount), 0);
    const bill = (await pool.query(`SELECT paid_amount::text FROM bills WHERE id = $1`, [billId])).rows[0];
    const moved = await bankCash(bankId) - cash0;
    // eslint-disable-next-line no-console
    console.warn("[G64 REG] forced bill", JSON.stringify({ statuses: rs.map((r) => [r.status, r.body?.error ?? null]), moved, payments: payments.length, paidSum, billPaid: bill.paid_amount }));
    expect(outcome(rs)).toEqual([200, 409]);
    expect(rs.find((r) => r.status === 409)?.body?.error).toBe(REFUSAL);
    expect([payments.length, paidSum]).toEqual([1, 400]);
    expect(Number(bill.paid_amount), "the bill's paid amount equals its payments").toBe(paidSum);
    expect(moved, "the bank's GL cash moved by the line's amount, once").toBe(-paidSum);
  }, 60_000);

  it("UNFORCED: five rounds of two settles of one line fired together — never more than one receipt per line, and every round's figures agree", async () => {
    for (let round = 1; round <= 5; round++) {
      const invoiceId = await issuedInvoice();
      const txId = await pendingLine("bookkeeper", bankId, orgId, "credit");
      const cash0 = await bankCash(bankId);
      const rs = await Promise.all([settle("admin", txId, { invoiceId }), settle("accountant", txId, { invoiceId })]);
      const ev = await invoiceEvidence(txId, invoiceId);
      const moved = await bankCash(bankId) - cash0;
      expect(outcome(rs), `round ${round}`).toEqual([200, 409]);
      expect([ev.receiptCount, ev.receiptTotal, ev.invoicePaid, moved], `round ${round}`).toEqual([1, 400, 400, 400]);
    }
  }, 120_000);

  it("ISOLATION: another organisation's statement line cannot be settled against this organisation's invoice (404), and nothing moves on either side", async () => {
    const invoiceId = await issuedInvoice();
    const foreignTx = await pendingLine("otheradmin", otherBankId, otherOrgId, "credit");
    const cash0 = await bankCash(bankId);
    const otherCash0 = await bankCash(otherBankId);
    const r = await settle("admin", foreignTx, { invoiceId });
    expect(r.status).toBe(404);
    const ev = await invoiceEvidence(foreignTx, invoiceId);
    expect([ev.receiptCount, ev.invoicePaid, ev.allReceipts]).toEqual([0, 0, 0]);
    expect(await bankCash(bankId)).toBe(cash0);
    expect(await bankCash(otherBankId)).toBe(otherCash0);
    expect(ev.line.review_status, "the foreign line is untouched").toBe("pending_review");
  }, 60_000);
});
