/**
 * 🔴 G36 (race half) — REGRESSION: concurrent payments of one bill are
 * serialised, and `paid_amount` is never a lost update.
 *
 * `payBill` read the bill's `paid_amount` BEFORE taking the bill's row lock
 * (`outstandingOf(…, { lock: true })`), then wrote `stale paid + amount`, so a
 * payment queued behind another overwrote the first's increment: `paid_amount`
 * ≠ Σ payments while the GL and the subledger moved twice (reproduced, Phase 18
 * Batch 4B, `phase18-s1b-g36-bill-pay.test.ts` — that file lands with
 * B-G36-KEY, because its retry test needs the idempotency key). The fix re-reads
 * the bill under that lock.
 *
 * Invariants, computed two ways and non-zero: `paid_amount` = Σ `bill_payments`;
 * what the bill owes (`billPosition`) = total − Σ; GL AP for the bill = its
 * subledger contribution; for a non-resident supplier, WHT payable = Σ withheld
 * and the bank moved Σ (amount − withheld).
 *
 * The race is FORCED with `helpers/g08rRace.ts` (`queuedBehind`): a holder
 * locks THIS bill's row; each payment is seen waiting inside the holder's own
 * wait tree before the next is sent. Also: the sequential control; three
 * payments where only two fit (the third gets the overpay 409 and writes
 * nothing); unforced rounds; another organisation's bill (404, nothing moves).
 *
 * DB-backed (sl_test / CI); skips on the DB-free placeholder.
 */
process.env.PORT ??= "3202";
process.env.SESSION_SECRET ??= "g36-bill-pay-race-regression-000000001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { BILL_OUTSTANDING_TEXT, BILL_AP_CONTRIBUTION_TEXT } from "../repositories/billPosition";
import { g04Harness, type Res } from "./helpers/g04Harness";
import { queuedBehind } from "./helpers/g08rRace";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "G36RegressionPw123!";
const PAID_AT = "2026-10-10";

describeMaybe("G36 — concurrent payments of one bill are serialised; paid_amount is never a lost update", () => {
  const h = g04Harness("g36reg");
  let orgId = "";
  let otherOrgId = "";
  let residentId = 0;
  let nonResidentId = 0;
  let otherVendorId = 0;
  let bankId = 0;
  let otherBankId = 0;
  let seq = 0;
  type Bill = { id: number; no: string };

  /** An approved bill, through the product's HTTP paths. */
  async function approvedBill(who: string, vendorId: number, net: number, vatRate: number): Promise<Bill> {
    seq += 1;
    const no = `G36REG-B${String(seq).padStart(3, "0")}`;
    const created = await h.api(who, "POST", "/bills", {
      supplierDocumentKind: "tax_invoice", vendorReference: `${no}-SUP`, billNumber: no, date: "2026-10-01", dueDate: "2026-10-31", vendorId,
      items: [{ description: "Supplies", quantity: 1, unitPrice: net, vatRate }],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const approver = who === "otheradmin" ? "otheradmin" : "admin";
    const approved = await h.api(approver, "POST", `/bills/${created.body.id}/approve`, {});
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    return { id: created.body.id as number, no };
  }

  const pay = (who: string, bill: Bill, amount: number, bank = bankId) =>
    h.api(who, "POST", `/bills/${bill.id}/pay`, { amount, paidAt: PAID_AT, bankAccountId: bank });

  /** One bill, every way the product states what was paid, owed and moved. */
  async function evidence(bill: Bill) {
    const row = (await pool.query(
      `SELECT total::text, paid_amount::text, status, (${BILL_OUTSTANDING_TEXT("b")})::text AS outstanding, (${BILL_AP_CONTRIBUTION_TEXT("b")})::text AS ap_contribution
         FROM bills b WHERE b.id = $1`, [bill.id],
    )).rows[0];
    const payments = (await pool.query(`SELECT amount::text FROM bill_payments WHERE bill_id = $1 ORDER BY id`, [bill.id])).rows.map((r) => Number(r.amount));
    const gl = (await pool.query(
      `SELECT coalesce(sum(l.credit_amount - l.debit_amount) FILTER (WHERE c.system_code = 'AP'), 0)::text AS ap_net,
              coalesce(sum(l.credit_amount - l.debit_amount) FILTER (WHERE c.system_code = 'WHT_PAYABLE'), 0)::text AS wht,
              count(DISTINCT e.id) FILTER (WHERE e.entry_number LIKE $2)::int AS pay_entries
         FROM journal_entry_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN categories c ON c.id = l.account_id
        WHERE e.organization_id = $3 AND e.status IN ('posted','reversed') AND (e.entry_number = $1 OR e.entry_number LIKE $2)`,
      [`BILL-${bill.no}`, `BILL-${bill.no}-PAY-%`, orgId],
    )).rows[0];
    const bank = Number((await pool.query(
      `SELECT coalesce(sum(v.debit_amount - v.credit_amount), 0)::text AS v
         FROM journal_line_bank_identity v JOIN journal_entries e ON e.id = v.journal_entry_id
        WHERE v.bank_account_id = $1 AND e.status IN ('posted','reversed') AND e.entry_number LIKE $2`, [bankId, `BILL-${bill.no}-PAY-%`],
    )).rows[0].v);
    const sum = Math.round(payments.reduce((s, a) => s + a, 0) * 100) / 100;
    return {
      total: Number(row.total), paidAmount: Number(row.paid_amount), status: row.status as string,
      outstanding: Number(row.outstanding), apContribution: Number(row.ap_contribution),
      paymentCount: payments.length, sumPayments: sum, payEntries: gl.pay_entries as number,
      glApNet: Number(gl.ap_net), whtPayable: Number(gl.wht), bankMoved: bank,
    };
  }

  /** The figures that must agree, whatever the order of the payments. */
  function expectConsistent(ev: Awaited<ReturnType<typeof evidence>>, label: string) {
    expect(ev.sumPayments, `${label}: some payment was recorded (non-zero)`).toBeGreaterThan(0);
    expect(ev.paidAmount, `${label}: paid_amount = Σ payments`).toBe(ev.sumPayments);
    expect(ev.outstanding, `${label}: owed = total − Σ payments`).toBe(Math.round((ev.total - ev.sumPayments) * 100) / 100);
    expect(ev.glApNet, `${label}: GL AP for the bill = its subledger contribution`).toBe(ev.apContribution);
    expect(ev.payEntries, `${label}: one payment entry per payment row`).toBe(ev.paymentCount);
  }
  const statuses = (rs: Res[]) => rs.map((r) => r.status).sort((a, b) => a - b);

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    await h.mkCompany(orgId, "G36 Regression Co", "318181818181883");
    otherOrgId = await h.mkOrg("other");
    await h.mkCompany(otherOrgId, "G36 Other Co", "318181818181884");
    residentId = (await pool.query(`INSERT INTO vendors (organization_id, name, tax_number) VALUES ($1,'G36 Supplier','300000000000003') RETURNING id`, [orgId])).rows[0].id;
    nonResidentId = (await pool.query(
      `INSERT INTO vendors (organization_id, name, residency, wht_default_payment_type, country, foreign_tax_id) VALUES ($1,'G36 London Consulting','non_resident','technical_consulting','GB','GB-123') RETURNING id`, [orgId],
    )).rows[0].id;
    otherVendorId = (await pool.query(`INSERT INTO vendors (organization_id, name, tax_number) VALUES ($1,'G36 Other Supplier','300000000000003') RETURNING id`, [otherOrgId])).rows[0].id;
    for (const [who, role] of [["admin", "admin"], ["accountant", "accountant"], ["bookkeeper", "bookkeeper"]]) await h.mkUser(who, PW, orgId, role);
    await h.mkUser("otheradmin", PW, otherOrgId, "admin");
    await h.start();
    for (const who of ["admin", "accountant", "bookkeeper", "otheradmin"]) expect(await h.login(who, h.email(who), PW), `login ${who}`).toBe(200);
    const bank = await h.api("admin", "POST", "/bank-accounts", { name: "G36 Ops", bankName: "SNB", currency: "SAR" });
    expect(bank.status, JSON.stringify(bank.body)).toBe(201);
    bankId = bank.body.id;
    const other = await h.api("otheradmin", "POST", "/bank-accounts", { name: "G36 Other Ops", bankName: "SNB", currency: "SAR" });
    expect(other.status, JSON.stringify(other.body)).toBe(201);
    otherBankId = other.body.id;
  }, 120_000);
  afterAll(async () => { await h.stop(); await h.cleanup(); });

  it("CONTROL (sequential): two payments accumulate; a third that no longer fits gets the overpay 409 and writes nothing", async () => {
    const b = await approvedBill("bookkeeper", residentId, 1_000, 15); // 1,150.00
    expect((await pay("admin", b, 500)).status).toBe(200);
    expect((await pay("accountant", b, 500)).status).toBe(200);
    const third = await pay("admin", b, 500);
    expect(third.status).toBe(409);
    expect(String(third.body?.error)).toMatch(/exceeds the outstanding balance of 150\.00/);
    const ev = await evidence(b);
    expectConsistent(ev, "control");
    expect([ev.paymentCount, ev.sumPayments, ev.outstanding, ev.bankMoved]).toEqual([2, 1_000, 150, -1_000]);
  }, 60_000);

  it("🔴 FORCED: two payments queued behind a holder on THIS bill — both 200; paid_amount = Σ payments = 800; owed 350; GL AP = subledger", async () => {
    const b = await approvedBill("bookkeeper", residentId, 1_000, 15);
    const rs = await queuedBehind("bills", b.id, [() => pay("admin", b, 400), () => pay("accountant", b, 400)]);
    const ev = await evidence(b);
    // eslint-disable-next-line no-console
    console.warn("[G36 REG] forced two", JSON.stringify({ statuses: rs.map((r) => [r.status, r.body?.error ?? null]), ...ev }));
    expect(statuses(rs)).toEqual([200, 200]);
    expectConsistent(ev, "forced two");
    expect([ev.paymentCount, ev.sumPayments, ev.paidAmount, ev.outstanding, ev.bankMoved]).toEqual([2, 800, 800, 350, -800]);
  }, 60_000);

  it("🔴 FORCED: three payments where only two fit — two 200, one overpay 409; nothing of the third is written", async () => {
    const b = await approvedBill("bookkeeper", residentId, 1_000, 15);
    const rs = await queuedBehind("bills", b.id, [() => pay("admin", b, 500), () => pay("accountant", b, 500), () => pay("admin", b, 500)]);
    const ev = await evidence(b);
    // eslint-disable-next-line no-console
    console.warn("[G36 REG] forced three", JSON.stringify({ statuses: rs.map((r) => [r.status, r.body?.error ?? null]), ...ev }));
    expect(statuses(rs)).toEqual([200, 200, 409]);
    expect(String(rs.find((r) => r.status === 409)?.body?.error)).toMatch(/exceeds the outstanding balance of 150\.00/);
    expectConsistent(ev, "forced three");
    expect([ev.paymentCount, ev.sumPayments, ev.outstanding, ev.bankMoved]).toEqual([2, 1_000, 150, -1_000]);
  }, 60_000);

  it("🔴 FORCED (non-resident, WHT 5 %): two payments at once — paid_amount = Σ = 800; WHT payable = 40; the bank moved 760", async () => {
    const b = await approvedBill("bookkeeper", nonResidentId, 1_000, 0);
    const rs = await queuedBehind("bills", b.id, [() => pay("admin", b, 400), () => pay("accountant", b, 400)]);
    const ev = await evidence(b);
    // eslint-disable-next-line no-console
    console.warn("[G36 REG] forced wht", JSON.stringify({ statuses: rs.map((r) => [r.status, r.body?.error ?? null]), ...ev }));
    expect(statuses(rs)).toEqual([200, 200]);
    expectConsistent(ev, "forced wht");
    expect([ev.sumPayments, ev.paidAmount, ev.outstanding, ev.whtPayable, ev.bankMoved]).toEqual([800, 800, 200, 40, -760]);
  }, 60_000);

  it("UNFORCED: five rounds of two payments fired together — every round's figures agree", async () => {
    for (let round = 1; round <= 5; round++) {
      const b = await approvedBill("bookkeeper", residentId, 1_000, 15);
      const rs = await Promise.all([pay("admin", b, 400), pay("accountant", b, 400)]);
      const ev = await evidence(b);
      expect(statuses(rs), `round ${round}`).toEqual([200, 200]);
      expectConsistent(ev, `round ${round}`);
      expect([ev.sumPayments, ev.paidAmount], `round ${round}`).toEqual([800, 800]);
    }
  }, 180_000);

  it("ISOLATION: another organisation's bill cannot be paid (404), and nothing moves on either side", async () => {
    const foreign = await approvedBill("otheradmin", otherVendorId, 1_000, 15);
    const r = await pay("admin", foreign, 100);
    expect(r.status).toBe(404);
    const row = (await pool.query(`SELECT paid_amount::text FROM bills WHERE id = $1`, [foreign.id])).rows[0];
    const payments = Number((await pool.query(`SELECT count(*)::int AS n FROM bill_payments WHERE bill_id = $1`, [foreign.id])).rows[0].n);
    expect([Number(row.paid_amount), payments]).toEqual([0, 0]);
    const ours = Number((await pool.query(`SELECT count(*)::int AS n FROM bill_payments WHERE organization_id = $1 AND amount = 100`, [orgId])).rows[0].n);
    expect(ours, "nothing was recorded in the paying organisation either").toBe(0);
    expect(otherBankId).toBeGreaterThan(0);
  }, 60_000);
});
