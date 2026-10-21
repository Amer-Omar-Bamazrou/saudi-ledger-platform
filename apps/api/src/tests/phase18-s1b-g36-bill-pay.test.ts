/**
 * PHASE 18 · S1-b · G36 PROOF — the direct bill payment: a racing payment, a
 * retried payment, and a sub-halala amount. PROOF ONLY, NOT A FIX.
 *
 * Authorised by the owner on 2026-10-16 (Batch 4B: "proof tests and evidence
 * gathering, with no production changes"). Definition: Phase 18 contract G36
 * (§11.2, §11.3, §16.2 "C-IDEM (G36)") and the plan of 2026-10-16 §9.
 *
 * The mechanism (read at f480a569, `services/bills.payment.ts`):
 *  - `alreadyPaid` is read from `existing.paidAmount` BEFORE the row lock;
 *    the outstanding balance is read UNDER the lock (`outstandingOf(…, { lock })`);
 *    then `paid_amount` is WRITTEN ABSOLUTELY as `alreadyPaid + paid`. Two
 *    concurrent payments both start from the same stale `alreadyPaid`, so the
 *    second overwrites the first's increment. `paid_amount` is part of what a
 *    bill OWES (`repositories/billPosition.ts`, BILL_OUTSTANDING_TEXT), so the
 *    subledger then disagrees with the GL;
 *  - `PaymentInput.idempotencyKey` is promised by the spec ("the same key twice
 *    records one payment", openapi.yaml) and never read by `payBill`;
 *  - `paid = Number(amount)` is never rounded at the gate.
 *
 * The race is FORCED: a holder connection locks the bill row; both payments
 * pass their unlocked read and then WAIT on that row (the test sees exactly two
 * `FOR UPDATE OF b` waiters) before the holder releases.
 *
 * FIX-NEUTRAL invariants are asserted (they hold whether a fix serialises the
 * payments, refuses the second, replays the first result, or refuses a
 * sub-halala amount). Evidence is logged before the assertions. A PREMISE test
 * proves the probes read real, non-zero figures on the unraced path.
 *
 * 🔴 Expected to FAIL while G36 exists: a failure is the reproduction. Untracked
 * S1-b file — never merged red, never weakened. It does NOT call the rate-limit
 * reset hook (Batch 4B rule). DB-backed; skips on the DB-free placeholder.
 */

process.env.PORT ??= "3151";
process.env.SESSION_SECRET ??= "phase18-s1b-g36-proof-session-secret-0001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { BILL_OUTSTANDING_TEXT, BILL_AP_CONTRIBUTION_TEXT } from "../repositories/billPosition";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

const PW = "S1bG36ProofPw123!";

describeMaybe("Phase 18 S1-b · G36 proof — the direct bill payment (race, retry, sub-halala)", () => {
  const h = g04Harness("s1bg36");
  let orgId = "";
  let vendorId = 0;
  let bankId = 0;
  let seq = 0;

  /** An approved bill of `net` + 15 % VAT, through the product's HTTP paths. Returns id and number. */
  async function approvedBill(net: number): Promise<{ id: number; no: string }> {
    seq += 1;
    const no = `S1BG36-B${String(seq).padStart(3, "0")}`;
    const created = await h.api("bookkeeper", "POST", "/bills", {
      supplierDocumentKind: "tax_invoice", vendorReference: `${no}-SUP`, billNumber: no,
      date: "2026-10-01", dueDate: "2026-10-31", vendorId,
      items: [{ description: "Supplies", quantity: 1, unitPrice: net, vatRate: 15 }],
    });
    expect(created.status, `create bill: ${JSON.stringify(created.body)}`).toBe(201);
    const approved = await h.api("admin", "POST", `/bills/${created.body.id}/approve`, {});
    expect(approved.status, `approve bill: ${JSON.stringify(approved.body)}`).toBe(200);
    return { id: created.body.id as number, no };
  }

  const pay = (billId: number, amount: number, idempotencyKey?: string) =>
    h.api("admin", "POST", `/bills/${billId}/pay`, { amount, paidAt: "2026-10-10", bankAccountId: bankId, ...(idempotencyKey ? { idempotencyKey } : {}) });

  /** One bill, every way the product states what was paid and what is owed. */
  async function evidence(bill: { id: number; no: string }) {
    const row = (await pool.query(
      `SELECT total::text, paid_amount::text, status,
              (${BILL_OUTSTANDING_TEXT("b")})::text AS outstanding,
              (${BILL_AP_CONTRIBUTION_TEXT("b")})::text AS ap_contribution
         FROM bills b WHERE b.id = $1`, [bill.id],
    )).rows[0];
    const payments = (await pool.query(
      `SELECT amount::text FROM bill_payments WHERE bill_id = $1 ORDER BY id`, [bill.id],
    )).rows.map((r) => r.amount as string);
    // AP in the GL for THIS bill: its approval entry (BILL-<no>) and its payment entries (BILL-<no>-PAY-<id>).
    const gl = (await pool.query(
      `SELECT coalesce(sum(l.credit_amount - l.debit_amount), 0)::text AS ap_net,
              coalesce(sum(l.debit_amount) FILTER (WHERE e.entry_number LIKE $2), 0)::text AS ap_paid_debits
         FROM journal_entry_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN categories c ON c.id = l.account_id
        WHERE e.organization_id = $3 AND c.system_code = 'AP' AND e.status IN ('posted','reversed')
          AND (e.entry_number = $1 OR e.entry_number LIKE $2)`,
      [`BILL-${bill.no}`, `BILL-${bill.no}-PAY-%`, orgId],
    )).rows[0];
    const sumPayments = Math.round(payments.reduce((s, a) => s + Number(a), 0) * 100) / 100;
    return {
      total: Number(row.total), paidAmount: Number(row.paid_amount), status: row.status as string,
      outstanding: Number(row.outstanding), apContribution: Number(row.ap_contribution),
      payments, paymentCount: payments.length, sumPayments,
      glApNet: Number(gl.ap_net), glApPaidDebits: Number(gl.ap_paid_debits),
    };
  }

  /** Requests waiting on THIS test's bill row lock (the `outstandingOf(…, { lock: true })` statement). */
  const waitersOnBillRow = async () => Number((await pool.query(
    `SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%FROM bills b WHERE b.id%FOR UPDATE OF b%'`,
  )).rows[0].n);

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    await h.mkCompany(orgId, "S1b G36 Co", "318181818181833");
    vendorId = (await pool.query(
      `INSERT INTO vendors (organization_id, name, tax_number) VALUES ($1,'S1b G36 Supplier','300000000000003') RETURNING id`, [orgId],
    )).rows[0].id;
    await h.mkUser("admin", PW, orgId, "admin");
    await h.mkUser("bookkeeper", PW, orgId, "bookkeeper");
    await h.start();
    for (const who of ["admin", "bookkeeper"]) expect(await h.login(who, h.email(who), PW), `login ${who}`).toBe(200);
    const bank = await h.api("admin", "POST", "/bank-accounts", { name: "S1b G36 Ops", bankName: "SNB", currency: "SAR" });
    expect(bank.status, JSON.stringify(bank.body)).toBe(201);
    bankId = bank.body.id;
  }, 120_000);

  afterAll(async () => {
    await h.stop();
    await h.cleanup();
  });

  it("PREMISE (unraced, one payment): paid_amount = Σ payments; outstanding = total − Σ; GL AP for the bill = its subledger contribution — all non-zero", async () => {
    const bill = await approvedBill(1_000); // 1,150.00 with VAT
    const r = await pay(bill.id, 400);
    const ev = await evidence(bill);
    // eslint-disable-next-line no-console
    console.warn("[S1B G36] PREMISE", JSON.stringify({ httpStatus: r.status, ...ev }));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(ev.total).toBe(1_150);
    expect(ev.paymentCount).toBe(1);
    expect(ev.paidAmount).toBe(400);
    expect(ev.sumPayments).toBe(400);
    expect(ev.outstanding).toBe(750);
    expect(ev.glApNet).toBe(750);
    expect(ev.apContribution).toBe(750);
  });

  it("🔴 PROOF (forced race): two payments at once — paid_amount = Σ payments, outstanding = total − Σ payments, GL AP = subledger", async () => {
    const bill = await approvedBill(1_000); // 1,150.00
    const holder = await pool.connect();
    let open = false;
    let results: Array<{ status: number; body: any }> = [];
    try {
      await holder.query("BEGIN");
      open = true;
      await holder.query(`SELECT id FROM bills WHERE id = $1 FOR UPDATE`, [bill.id]);
      const racing = Promise.all([pay(bill.id, 400), pay(bill.id, 400)]);
      const deadline = Date.now() + 20_000;
      for (;;) {
        const waiting = await waitersOnBillRow();
        if (waiting >= 2) break;
        if (Date.now() > deadline) throw new Error(`only ${waiting} payment(s) reached the bill row lock — the race was not established`);
        await new Promise((res) => setTimeout(res, 50));
      }
      await holder.query("COMMIT");
      open = false;
      results = await racing;
    } finally {
      if (open) await holder.query("ROLLBACK");
      holder.release();
    }
    const ev = await evidence(bill);
    // eslint-disable-next-line no-console
    console.warn("[S1B G36] RACE", JSON.stringify({ statuses: results.map((x) => [x.status, x.body?.code ?? null]), ...ev }));
    expect.soft(ev.paidAmount, "bills.paid_amount equals the sum of the bill's payments").toBe(ev.sumPayments);
    expect.soft(ev.outstanding, "what the bill owes = total − Σ payments").toBe(Math.round((ev.total - ev.sumPayments) * 100) / 100);
    expect.soft(ev.glApNet, "AP in the GL for this bill = its subledger contribution (one figure, two ways)").toBe(ev.apContribution);
  }, 60_000);

  it("🔴 PROOF (retry): the same payment sent twice with the SAME idempotencyKey records ONE payment (control: two different keys record two)", async () => {
    const bill = await approvedBill(1_000);
    const first = await pay(bill.id, 100, "S1BG36-KEY-SAME");
    const second = await pay(bill.id, 100, "S1BG36-KEY-SAME");
    const ev = await evidence(bill);
    const control = await approvedBill(1_000);
    const c1 = await pay(control.id, 100, "S1BG36-KEY-A");
    const c2 = await pay(control.id, 100, "S1BG36-KEY-B");
    const evC = await evidence(control);
    // eslint-disable-next-line no-console
    console.warn("[S1B G36] RETRY", JSON.stringify({ sameKey: { statuses: [first.status, second.status], ...ev }, differentKeys: { statuses: [c1.status, c2.status], paymentCount: evC.paymentCount, sumPayments: evC.sumPayments } }));
    // control first: two legitimate payments are two
    expect(evC.paymentCount, "CONTROL: two different keys record two payments").toBe(2);
    expect(evC.sumPayments).toBe(200);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect.soft(ev.paymentCount, "the same key twice records ONE payment (spec: PaymentInput.idempotencyKey)").toBe(1);
    expect.soft(ev.sumPayments, "the bill is paid once").toBe(100);
  }, 60_000);

  it("🔴 PROOF (sub-halala): a payment of 100.005 — the payment row, paid_amount and the GL AP debit agree, each at 2 dp (or the amount is refused and nothing is written)", async () => {
    const bill = await approvedBill(1_000);
    const r = await pay(bill.id, 100.005);
    const ev = await evidence(bill);
    // eslint-disable-next-line no-console
    console.warn("[S1B G36] SUB-HALALA", JSON.stringify({ httpStatus: r.status, code: r.body?.code ?? null, ...ev }));
    if (r.status >= 400) {
      expect.soft(ev.paymentCount, "a refused payment writes nothing").toBe(0);
      expect.soft(ev.paidAmount).toBe(0);
      return;
    }
    const twoDp = (n: number) => Math.round(n * 100) / 100 === n;
    expect.soft(ev.paymentCount).toBe(1);
    expect.soft(twoDp(ev.paidAmount) && twoDp(ev.sumPayments) && twoDp(ev.glApPaidDebits), "every stored figure is at 2 dp").toBe(true);
    expect.soft(ev.paidAmount, "paid_amount = the recorded payment").toBe(ev.sumPayments);
    expect.soft(ev.glApPaidDebits, "the GL AP debit = the recorded payment").toBe(ev.sumPayments);
    expect.soft(ev.glApNet, "GL AP for the bill = its subledger contribution").toBe(ev.apContribution);
  }, 60_000);
});
