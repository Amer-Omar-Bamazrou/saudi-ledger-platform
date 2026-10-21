/**
 * 🔴 G36-KEY — REGRESSION (Phase 18 authorisation §2.10; plan B-G36-KEY; migration 0124): the bill
 * payment's idempotency key, which the spec promised (`PaymentInput.idempotencyKey`: "unique per company;
 * the same key twice records one payment") and the pay path never read.
 *
 * The 4B proof (`phase18-s1b-g36-bill-pay.test.ts`, landed unchanged) shows the sequential retry. This file
 * pins the rest of the D-4 statement:
 *   - same key, same request, twice → ONE payment and ONE cash posting; the retry answers as the first;
 *   - a retried payment that SETTLED the bill replays (it is not refused as "already paid");
 *   - same key, different request → 409 `idempotency_key_reused`, nothing written;
 *   - the same key sent twice AT ONCE (forced on the bill's lock) → one payment, both answered;
 *   - the one race the bill lock cannot see — the same key on two DIFFERENT bills — reaches the unique
 *     index (0124) and is MAPPED (409 `idempotency_key_in_flight`), never an unmapped 23505 (forced);
 *   - ISOLATION (structural): the index is per company; the lookup is company-scoped (`companyScoped`).
 *
 * DB-backed (sl_test / CI); skips on the DB-free placeholder.
 */
process.env.PORT ??= "3209";
process.env.SESSION_SECRET ??= "g36-key-bill-pay-idempotency-regression1";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness } from "./helpers/g04Harness";
import { lockWaiters, queuedBehind, until } from "./helpers/g08rRace";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "G36KeyRegressionPw123!";

describeMaybe("G36-KEY — the bill payment's idempotency key", () => {
  const h = g04Harness("g36key");
  let orgId = "";
  let vendorId = 0;
  let bankId = 0;
  let seq = 0;

  async function approvedBill(net: number): Promise<{ id: number; no: string }> {
    seq += 1;
    const no = `G36KEY-B${String(seq).padStart(3, "0")}`;
    const created = await h.api("admin", "POST", "/bills", {
      supplierDocumentKind: "tax_invoice", vendorReference: `${no}-SUP`, billNumber: no,
      date: "2026-10-01", dueDate: "2026-10-31", vendorId,
      items: [{ description: "Supplies", quantity: 1, unitPrice: net, vatRate: 0 }],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect((await h.api("admin", "POST", `/bills/${created.body.id}/approve`, {})).status).toBe(200);
    return { id: created.body.id as number, no };
  }
  const pay = (billId: number, amount: number, key?: string) =>
    h.api("admin", "POST", `/bills/${billId}/pay`, { amount, paidAt: "2026-10-10", bankAccountId: bankId, ...(key ? { idempotencyKey: key } : {}) });
  const payments = async (billId: number) =>
    (await pool.query(`SELECT id, amount::text, idempotency_key FROM bill_payments WHERE bill_id = $1 ORDER BY id`, [billId])).rows;
  const payEntries = async (bill: { no: string }) =>
    Number((await pool.query(`SELECT count(*)::int AS n FROM journal_entries WHERE organization_id = $1 AND entry_number LIKE $2`, [orgId, `BILL-${bill.no}-PAY-%`])).rows[0].n);
  const paid = async (billId: number) => (await pool.query(`SELECT paid_amount::text, status FROM bills WHERE id = $1`, [billId])).rows[0];

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    await h.mkCompany(orgId, "G36 Key Co", "318181818181843");
    vendorId = (await pool.query(`INSERT INTO vendors (organization_id, name, tax_number) VALUES ($1,'G36 Key Supplier','300000000000003') RETURNING id`, [orgId])).rows[0].id;
    await h.mkUser("admin", PW, orgId, "admin");
    await h.start();
    expect(await h.login("admin", h.email("admin"), PW)).toBe(200);
    const bank = await h.api("admin", "POST", "/bank-accounts", { name: "G36 Key Ops", bankName: "SNB", currency: "SAR" });
    expect(bank.status, JSON.stringify(bank.body)).toBe(201);
    bankId = bank.body.id;
  }, 120_000);
  afterAll(async () => { await h.stop(); await h.cleanup(); });

  it("🔴 same key, same request, twice: ONE payment and ONE cash posting; the retry answers 200 with the same bill", async () => {
    const b = await approvedBill(1_000);
    const first = await pay(b.id, 250, "G36KEY-SAME-1");
    const second = await pay(b.id, 250, "G36KEY-SAME-1");
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(second.body.paidAmount, "the retry reads the bill as the first left it").toEqual(first.body.paidAmount);
    expect((await payments(b.id)).map((p) => [p.amount, p.idempotency_key])).toEqual([["250.00", "G36KEY-SAME-1"]]);
    expect(await payEntries(b)).toBe(1);
    expect(await paid(b.id)).toMatchObject({ paid_amount: "250.00" });
    // movement: a NEW key on the same bill is a new payment
    expect((await pay(b.id, 250, "G36KEY-SAME-2")).status).toBe(200);
    expect(await payEntries(b)).toBe(2);
  });

  it("a retried payment that SETTLED the bill replays (200) — it is not refused as \"already paid\"; still one payment", async () => {
    const b = await approvedBill(400);
    const first = await pay(b.id, 400, "G36KEY-FULL");
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(await paid(b.id)).toMatchObject({ status: "paid" });
    const retry = await pay(b.id, 400, "G36KEY-FULL");
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    expect(await payments(b.id)).toHaveLength(1);
    // control: WITHOUT a key, a second full payment is refused exactly as before
    expect((await pay(b.id, 400)).status).toBe(409);
  });

  it("🔴 same key, a DIFFERENT request: 409 idempotency_key_reused, and nothing is written", async () => {
    const b = await approvedBill(1_000);
    expect((await pay(b.id, 100, "G36KEY-DIFF")).status).toBe(200);
    const before = [await payments(b.id), await payEntries(b), await paid(b.id)];
    const other = await pay(b.id, 150, "G36KEY-DIFF");
    expect([other.status, other.body?.code], JSON.stringify(other.body)).toEqual([409, "idempotency_key_reused"]);
    const elsewhere = await approvedBill(1_000);
    const onAnotherBill = await pay(elsewhere.id, 100, "G36KEY-DIFF");
    expect([onAnotherBill.status, onAnotherBill.body?.code]).toEqual([409, "idempotency_key_reused"]);
    expect([await payments(b.id), await payEntries(b), await paid(b.id)]).toEqual(before);
    expect(await payments(elsewhere.id)).toEqual([]);
  });

  it("🔴 RACE (forced on the bill's lock) — the same key twice at once: one payment, both answered 200", async () => {
    const b = await approvedBill(1_000);
    const rs = await queuedBehind("bills", b.id, [() => pay(b.id, 300, "G36KEY-RACE"), () => pay(b.id, 300, "G36KEY-RACE")]);
    // eslint-disable-next-line no-console
    console.warn("[G36-KEY] race", JSON.stringify(rs.map((r) => [r.status, r.body?.code ?? null])));
    expect(rs.map((r) => r.status)).toEqual([200, 200]);
    expect(await payments(b.id)).toHaveLength(1);
    expect(await payEntries(b)).toBe(1);
    expect(await paid(b.id)).toMatchObject({ paid_amount: "300.00" });
  }, 60_000);

  it("🔴 RACE (forced on the key's index) — the same key on a DIFFERENT bill while another payment holds it uncommitted: mapped 409 idempotency_key_in_flight, never a 500", async () => {
    const held = await approvedBill(1_000);
    const b = await approvedBill(1_000);
    const holder = await pool.connect();
    let open = false;
    try {
      await holder.query("BEGIN");
      open = true;
      const pid = Number((await holder.query(`SELECT pg_backend_pid() AS pid`)).rows[0].pid);
      const companyId = (await holder.query(`SELECT company_id FROM bills WHERE id = $1`, [held.id])).rows[0].company_id;
      await holder.query(
        `INSERT INTO bill_payments (organization_id, company_id, bill_id, amount, paid_at, bank_account_id, idempotency_key, request_fingerprint)
         VALUES ($1, $2, $3, 1, '2026-10-10', $4, 'G36KEY-INDEX', 'held-by-the-test')`, [orgId, companyId, held.id, bankId],
      );
      const sent = pay(b.id, 100, "G36KEY-INDEX");
      await until("the payment did not queue on the key's index", async () => (await lockWaiters(pid)) >= 1);
      await holder.query("COMMIT");
      open = false;
      const r = await sent;
      expect([r.status, r.body?.code], JSON.stringify(r.body)).toEqual([409, "idempotency_key_in_flight"]);
      expect(await payments(b.id)).toEqual([]);
      expect(await payEntries(b)).toBe(0);
    } finally {
      if (open) await holder.query("ROLLBACK");
      holder.release();
      await pool.query(`DELETE FROM bill_payments WHERE bill_id = $1 AND request_fingerprint = 'held-by-the-test'`, [held.id]);
    }
  }, 60_000);

  it("ISOLATION (structural): the key is unique per COMPANY — the index is (company_id, idempotency_key) over non-NULL keys, and the lookup is company-scoped", async () => {
    const def = (await pool.query(`SELECT indexdef FROM pg_indexes WHERE indexname = 'bill_payments_idempotency_unq'`)).rows[0]?.indexdef as string;
    expect(def).toMatch(/UNIQUE INDEX bill_payments_idempotency_unq ON public\.bill_payments USING btree \(company_id, idempotency_key\) WHERE \(idempotency_key IS NOT NULL\)/);
  });
});
