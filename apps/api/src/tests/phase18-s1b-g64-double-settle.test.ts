/**
 * PHASE 18 · S1-b · G64 PROOF — ONE bank-statement line settled TWICE at once
 * against an invoice. PROOF ONLY, NOT A FIX.
 *
 * Authorised by the owner on 2026-10-16 (Batch 4B). Definition: Phase 18
 * contract G64 (§11.2: "Two concurrent settles of one statement line both pass
 * an unlocked `pending_review` check; with partial amounts both receipts
 * post"), §16.2 "Two settles of one statement line: one receipt", and the
 * plan of 2026-10-16 §9.
 *
 * The mechanism (read at f480a569, services/reconciliation.service.ts
 * `settle`): the line's `pending_review` state is read UNLOCKED; the receipt
 * is then recorded through the invoice pay path; the line is marked accepted
 * only at the end. The invoice's own ceiling allows both receipts when each is
 * a partial payment.
 *
 * The race is FORCED: a holder locks the statement line's row. The first
 * settle passes its check, records its receipt and WAITS to mark the line;
 * the second passes the same check (the first has not committed) and WAITS
 * too (two lock waiters) before the holder releases.
 *
 * FIX-NEUTRAL invariant: a statement line produces at most ONE receipt, and
 * the bank moves by at most that line's amount. CONTROL: settling an
 * already-settled line, one request after the other, is refused.
 *
 * 🔴 Expected to FAIL while G64 exists. Untracked S1-b file — never merged red,
 * never weakened. Does NOT call the rate-limit reset hook. DB-backed.
 */

process.env.PORT ??= "3154";
process.env.SESSION_SECRET ??= "phase18-s1b-g64-proof-session-secret-0001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

const PW = "S1bG64ProofPw123!";

describeMaybe("Phase 18 S1-b · G64 proof — one statement line settled twice at once", () => {
  const h = g04Harness("s1bg64");
  let orgId = "";
  let customerId = 0;
  let bankId = 0;
  let seq = 0;

  async function issuedInvoice(net: number): Promise<number> {
    seq += 1;
    const created = await h.api("bookkeeper", "POST", "/invoices", {
      invoiceNumber: `S1BG64-INV-${seq}`, date: "2026-10-01", customerId,
      items: [{ description: "Service", quantity: 1, unitPrice: net, vatRate: 15 }],
    });
    expect(created.status, `create invoice: ${JSON.stringify(created.body)}`).toBe(201);
    const approved = await h.api("admin", "POST", `/invoices/${created.body.id}/approve`, {});
    expect(approved.status, `approve invoice: ${JSON.stringify(approved.body)}`).toBe(200);
    return created.body.id as number;
  }

  /** One uploaded credit line, waiting in review. */
  async function pendingLine(description: string, amount: number): Promise<number> {
    const up = await h.api("bookkeeper", "POST", "/transactions/upload", {
      rows: [{ date: "2026-10-05", description, amount, currency: "SAR", type: "credit" }],
      bankAccountId: bankId,
    });
    expect(up.status, JSON.stringify(up.body)).toBe(200);
    const row = (await pool.query(
      `SELECT id, review_status FROM transactions WHERE organization_id = $1 AND description = $2`, [orgId, description],
    )).rows[0];
    expect(row?.review_status).toBe("pending_review");
    return row.id as number;
  }

  async function evidence(txId: number, invoiceId: number) {
    const receipts = (await pool.query(
      `SELECT id, amount::text, journal_entry_id FROM payments WHERE organization_id = $1 AND source_transaction_id = $2 ORDER BY id`, [orgId, txId],
    )).rows;
    const inv = (await pool.query(`SELECT total::text, paid_amount::text, status FROM invoices WHERE id = $1`, [invoiceId])).rows[0];
    const bank = Number((await pool.query(
      `SELECT coalesce(sum(v.debit_amount - v.credit_amount), 0)::text AS v
         FROM journal_line_bank_identity v JOIN journal_entries e ON e.id = v.journal_entry_id
        WHERE v.bank_account_id = $1 AND e.status IN ('posted','reversed')`, [bankId],
    )).rows[0].v);
    const line = (await pool.query(`SELECT review_status, kind, settles_invoice_id, amount::text FROM transactions WHERE id = $1`, [txId])).rows[0];
    return {
      receipts: receipts.map((r) => ({ id: r.id, amount: Number(r.amount), journalEntryId: r.journal_entry_id })),
      receiptCount: receipts.length,
      receiptTotal: Math.round(receipts.reduce((s, r) => s + Number(r.amount), 0) * 100) / 100,
      invoice: { total: Number(inv.total), paid: Number(inv.paid_amount), status: inv.status },
      bankMovement: bank, line,
    };
  }

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    await h.mkCompany(orgId, "S1b G64 Co", "318181818181863");
    customerId = (await pool.query(
      `INSERT INTO customers (organization_id, name, tax_number) VALUES ($1,'S1b G64 Buyer','300000000000003') RETURNING id`, [orgId],
    )).rows[0].id;
    await h.mkUser("admin", PW, orgId, "admin");
    await h.mkUser("accountant", PW, orgId, "accountant");
    await h.mkUser("bookkeeper", PW, orgId, "bookkeeper");
    await h.start();
    for (const who of ["admin", "accountant", "bookkeeper"]) expect(await h.login(who, h.email(who), PW), `login ${who}`).toBe(200);
    const bank = await h.api("admin", "POST", "/bank-accounts", { name: "S1b G64 Ops", bankName: "SNB", currency: "SAR" });
    expect(bank.status, JSON.stringify(bank.body)).toBe(201);
    bankId = bank.body.id;
  }, 120_000);

  afterAll(async () => {
    await h.stop();
    await h.cleanup();
  });

  it("CONTROL (sequential): a settled line cannot be settled again — one receipt, the bank moves by the line once", async () => {
    const invoiceId = await issuedInvoice(1_000); // 1,150.00
    const txId = await pendingLine("S1BG64 CONTROL TRANSFER", 400);
    const bank0 = (await evidence(txId, invoiceId)).bankMovement;
    const first = await h.api("admin", "POST", `/transactions/${txId}/settle`, { invoiceId });
    const second = await h.api("accountant", "POST", `/transactions/${txId}/settle`, { invoiceId });
    const ev = await evidence(txId, invoiceId);
    // eslint-disable-next-line no-console
    console.warn("[S1B G64] CONTROL", JSON.stringify({ first: [first.status, first.body?.code ?? null], second: [second.status, second.body?.code ?? null, String(second.body?.error ?? "").slice(0, 120)], bankBefore: bank0, ...ev }));
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(second.status).toBe(409);
    expect(ev.receiptCount).toBe(1);
    expect(ev.receiptTotal).toBe(400);
    expect(ev.bankMovement - bank0).toBe(400);
  });

  it("🔴 PROOF (forced race): one statement line settled twice at once — at most ONE receipt; the bank moves by at most the line's amount", async () => {
    const invoiceId = await issuedInvoice(1_000); // 1,150.00: room for two partial receipts of 400
    const txId = await pendingLine("S1BG64 RACE TRANSFER", 400);
    const bank0 = (await evidence(txId, invoiceId)).bankMovement;
    const holder = await pool.connect();
    let open = false;
    let results: Array<{ status: number; body: any }> = [];
    let holderPid = 0;
    try {
      await holder.query("BEGIN");
      open = true;
      holderPid = Number((await holder.query(`SELECT pg_backend_pid() AS p`)).rows[0].p);
      await holder.query(`SELECT id FROM transactions WHERE id = $1 FOR UPDATE`, [txId]);
      const waiting = async () => Number((await pool.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> $1`, [holderPid],
      )).rows[0].n);
      const first = h.api("admin", "POST", `/transactions/${txId}/settle`, { invoiceId });
      const deadline1 = Date.now() + 20_000;
      while ((await waiting()) < 1) {
        if (Date.now() > deadline1) throw new Error("the first settle did not reach a lock — the race was not established");
        await new Promise((res) => setTimeout(res, 50));
      }
      const second = h.api("accountant", "POST", `/transactions/${txId}/settle`, { invoiceId });
      const deadline2 = Date.now() + 20_000;
      while ((await waiting()) < 2) {
        if (Date.now() > deadline2) throw new Error("the second settle did not reach a lock — the race was not established");
        await new Promise((res) => setTimeout(res, 50));
      }
      await holder.query("COMMIT");
      open = false;
      results = await Promise.all([first, second]);
    } finally {
      if (open) await holder.query("ROLLBACK");
      holder.release();
    }
    const ev = await evidence(txId, invoiceId);
    // eslint-disable-next-line no-console
    console.warn("[S1B G64] RACE", JSON.stringify({ statuses: results.map((r) => [r.status, r.body?.code ?? null]), bankBefore: bank0, bankMovedBy: ev.bankMovement - bank0, ...ev }));
    expect.soft(ev.receiptCount, "one statement line produces at most one receipt").toBeLessThanOrEqual(1);
    expect.soft(ev.bankMovement - bank0, "the bank moves by at most the line's amount").toBeLessThanOrEqual(400);
    expect.soft(results.filter((r) => r.status < 300).length, "at most one of two concurrent settles succeeds").toBeLessThanOrEqual(1);
  }, 60_000);
});
