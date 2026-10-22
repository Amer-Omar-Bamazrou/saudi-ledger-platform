/**
 * 🔴 G59 PROOF (Phase 18, B-SMALL-1; proof first): the allocation an Art. 40(9)
 * RECOVERY invoice FOLDED into its own issue entry cannot be unapplied.
 *
 * The mechanism (main at b1705b55):
 *  - `invoices.approvable.ts:476-532` — issuing a recovery invoice for a
 *    receivable written off HERE posts `Dr <receipt's liability> / Cr Bad debts`
 *    inside the document's own entry `GL-<number>` (no AR: the receivable was
 *    written off, `WO-<number>` credited it) and records an allocation
 *    receipt → recovery invoice for the gross (`insertAllocation`, line 531),
 *    marking the document paid.
 *  - `payments.service.ts:700-816` (`unallocate`) refuses the prepayment
 *    adjustment folded into a final invoice (`prepayment_adjustment_immutable`)
 *    and a credit note's settlement of its original — but NOT this fold. It
 *    mirrors the allocation as if it were an ordinary one: `Dr AR(customer) /
 *    Cr <receipt's liability>` and reopens the document. AR is then debited
 *    against a document that never carried AR (`recovery_invoice` is a
 *    NON-receivable type, `@workspace/shared` documentTypes.ts:52, so no
 *    subledger reader counts it): the GL's AR and the AR subledger part.
 *
 * What this file asserts, fix-neutral (any 4xx refusal satisfies it):
 *  1. the instrument SEES movement: an ORDINARY allocation's correction moves
 *     the snapshot (a correction row, an UNALLOC entry, AR up on both sides,
 *     the tie still holding) — so an unmoved snapshot later is evidence;
 *  2. unapplying the recovery's folded allocation is REFUSED (4xx) and NOTHING
 *     moves: no correction row, no journal entry, the recovery stays paid,
 *     the receipt stays applied, AR in the GL and in the subledger unchanged,
 *     AR subledger = GL for the customer, and the statement still reconciles.
 *
 * Everything is the PRODUCT's own HTTP path on rows it created itself (the
 * customer, the invoice, the write-off, the receipt, the recovery document and
 * its fold); the database is only READ. DB-backed (sl_test / CI); skips on the
 * DB-free placeholder.
 */
process.env.PORT ??= "3212";
process.env.SESSION_SECRET ??= "g59-recovery-allocation-unallocate-proof-01";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { __resetRateLimitsForTests } from "../routes/auth";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

const PW = "G59RecoveryProofPw123!";
// Twelve months must pass between the supply and the relief (Art. 40(7)(c)); the receipt follows the relief.
const SUPPLY_DATE = "2025-06-01";
const CLAIMED_ON = "2026-07-01";
const RECEIPT_DATE = "2026-08-15";

describeMaybe("G59 — the Art. 40(9) recovery's folded allocation cannot be unapplied", () => {
  const h = g04Harness("g59proof");
  let orgId = "";
  let customerId = 0;
  let bankId = 0;
  let seq = 0;

  const ok = (r: { status: number; body: unknown }, status: number) => expect(r.status, JSON.stringify(r.body)).toBe(status);

  async function issueInvoice(net: number, date: string): Promise<{ id: number; total: number }> {
    seq += 1;
    const created = await h.api("bookkeeper", "POST", "/invoices", {
      invoiceNumber: `G59P-INV-${seq}`, date, customerId,
      items: [{ description: "Consulting", quantity: 1, unitPrice: net, vatRate: 15 }],
    });
    ok(created, 201);
    const approved = await h.api("admin", "POST", `/invoices/${created.body.id}/approve`, {});
    ok(approved, 200);
    return { id: created.body.id as number, total: Number(approved.body.total) };
  }

  /** A receivable written off with relief, a later receipt on account, and the issued Art. 40(9) document that applies it. */
  async function recoveryChain(net: number, recovered: number) {
    const inv = await issueInvoice(net, SUPPLY_DATE);
    ok(await h.api("admin", "POST", `/invoices/${inv.id}/bad-debt-relief`, { claimedOn: CLAIMED_ON, certificateRef: `CA-G59-${seq}` }), 200);
    const rcpt = await h.api("admin", "POST", "/payments", { customerId, amount: recovered, paidAt: RECEIPT_DATE, bankAccountId: bankId, classification: "unknown" });
    ok(rcpt, 201);
    const draft = await h.api("admin", "POST", `/invoices/${inv.id}/bad-debt-recoveries`, { paymentId: rcpt.body.id, amount: recovered });
    ok(draft, 201);
    const issued = await h.api("admin", "POST", `/invoices/${draft.body.id}/approve`, {});
    ok(issued, 200);
    expect(issued.body.status, "the recovery is issued paid — its fold applied the receipt").toBe("paid");
    const folds = (await pool.query(
      `SELECT id, amount::text AS amount FROM payment_allocations WHERE invoice_id = $1 AND payment_id = $2`, [draft.body.id, rcpt.body.id],
    )).rows as Array<{ id: number; amount: string }>;
    expect(folds.map((f) => Number(f.amount)), "exactly one fold, for the gross").toEqual([recovered]);
    return { invoiceId: inv.id, receiptId: rcpt.body.id as number, recoveryId: draft.body.id as number, allocationId: folds[0]!.id };
  }

  const glFor = async (codes: string[]) => Number((await pool.query(
    `SELECT coalesce(sum(l.debit_amount - l.credit_amount), 0)::text AS v
       FROM journal_entry_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN categories c ON c.id = l.account_id
      WHERE e.organization_id = $1 AND e.status IN ('posted','reversed') AND c.system_code = ANY($2::text[]) AND l.customer_id = $3`,
    [orgId, codes, customerId],
  )).rows[0].v);

  /** Everything an unallocation could move, read from the ledger, the subledger tables and the product's own readers. */
  async function snapshot(recoveryId: number | null, receiptId: number | null) {
    const count = async (sql: string) => Number((await pool.query(sql, [orgId])).rows[0].n);
    const customer = await h.api("admin", "GET", `/customers/${customerId}`);
    ok(customer, 200);
    const statement = await h.api("admin", "GET", `/customers/${customerId}/statement`);
    ok(statement, 200);
    const arGl = await glFor(["AR"]);
    const depositGl = -(await glFor(["CUSTOMER_DEPOSITS", "SECURITY_DEPOSITS_HELD", "UNIDENTIFIED_RECEIPTS"]));
    const recovery = recoveryId == null ? null : (await pool.query(`SELECT status, paid_amount::text AS paid FROM invoices WHERE id = $1`, [recoveryId])).rows[0];
    const receipt = receiptId == null ? null : await h.api("admin", "GET", `/payments/${receiptId}`);
    return {
      corrections: await count(`SELECT count(*)::int AS n FROM payment_allocation_reversals WHERE organization_id = $1`),
      unallocEntries: await count(`SELECT count(*)::int AS n FROM journal_entries WHERE organization_id = $1 AND entry_number LIKE 'UNALLOC-%'`),
      journalEntries: await count(`SELECT count(*)::int AS n FROM journal_entries WHERE organization_id = $1`),
      recoveryStatus: recovery?.status ?? null,
      recoveryPaid: recovery ? Number(recovery.paid) : null,
      receiptUnapplied: receipt ? Number(receipt.body.unappliedAmount) : null,
      arGl,
      arSubledger: Number(customer.body.receivable),
      arTie: Math.round((arGl - Number(customer.body.receivable)) * 100) / 100,
      depositGl,
      depositSubledger: Number(customer.body.depositBalance),
      statementReconciled: statement.body.reconciled as boolean,
    };
  }

  beforeAll(async () => {
    await __resetRateLimitsForTests();
    await h.cleanup();
    orgId = await h.mkOrg("org");
    await h.mkCompany(orgId, "G59 Proof Co", "318181818181896");
    await h.mkUser("admin", PW, orgId, "admin");
    await h.mkUser("bookkeeper", PW, orgId, "bookkeeper");
    await h.start();
    for (const who of ["admin", "bookkeeper"]) expect(await h.login(who, h.email(who), PW), `login ${who}`).toBe(200);
    const cust = await h.api("admin", "POST", "/customers", { name: "G59 Proof Buyer", taxNumber: "300000000000003" });
    ok(cust, 201);
    customerId = cust.body.id;
    const bank = await h.api("admin", "POST", "/bank-accounts", { name: "G59 Proof Ops", bankName: "Riyad", currency: "SAR" });
    ok(bank, 201);
    bankId = bank.body.id;
  }, 120_000);

  afterAll(async () => {
    await h.stop();
    await h.cleanup();
  });

  it("🔴 the instrument sees movement: an ORDINARY allocation's correction moves AR on both sides by its amount, and the tie holds", async () => {
    const inv = await issueInvoice(1_000, "2026-08-01"); // 1,150.00
    const rcpt = await h.api("admin", "POST", "/payments", { customerId, amount: 1_150, paidAt: "2026-08-02", bankAccountId: bankId, allocations: [{ invoiceId: inv.id, amount: 1_150 }] });
    ok(rcpt, 201);
    const alloc = (await pool.query(`SELECT id FROM payment_allocations WHERE invoice_id = $1 AND payment_id = $2`, [inv.id, rcpt.body.id])).rows[0].id as number;
    const before = await snapshot(null, rcpt.body.id);
    expect(before.arTie, "AR subledger = GL before").toBe(0);
    const res = await h.api("admin", "POST", `/payments/allocations/${alloc}/unallocate`, { reason: "applied to the wrong invoice" });
    ok(res, 200);
    const after = await snapshot(null, rcpt.body.id);
    expect(after).toEqual({
      ...before,
      corrections: before.corrections + 1,
      unallocEntries: before.unallocEntries + 1,
      journalEntries: before.journalEntries + 1,
      receiptUnapplied: before.receiptUnapplied! + 1_150,
      arGl: before.arGl + 1_150,
      arSubledger: before.arSubledger + 1_150,
      depositGl: before.depositGl + 1_150,
      depositSubledger: before.depositSubledger + 1_150,
    });
    expect(after.arTie, "AR subledger = GL after an ordinary correction").toBe(0);
  });

  it("🔴 unapplying the recovery's folded allocation is REFUSED (4xx) and nothing moves: no correction, no entry, the recovery stays paid, AR subledger = GL", async () => {
    const chain = await recoveryChain(5_000, 2_300); // 5,750.00 written off; 2,300.00 recovered
    const before = await snapshot(chain.recoveryId, chain.receiptId);
    expect(before.arTie, "AR subledger = GL before").toBe(0);
    expect([before.recoveryStatus, before.recoveryPaid, before.receiptUnapplied]).toEqual(["paid", 2_300, 0]);

    const res = await h.api("admin", "POST", `/payments/allocations/${chain.allocationId}/unallocate`, { reason: "try to unapply the recovery" });
    const after = await snapshot(chain.recoveryId, chain.receiptId);
    expect(
      { refused4xx: res.status >= 400 && res.status < 500, ...after },
      `HTTP ${res.status} ${JSON.stringify(res.body)}`,
    ).toEqual({ refused4xx: true, ...before });
    expect(after.arTie, "AR subledger = GL after the refusal").toBe(0);
    expect(after.statementReconciled).toBe(true);
  });

  it("D-4 (added with the fix, after the red runs): the refusal is 409 recovery_allocation_immutable, and a retry with an idempotency key is refused the same way", async () => {
    const chain = await recoveryChain(2_000, 1_150); // 2,300.00 written off; 1,150.00 recovered
    const before = await snapshot(chain.recoveryId, chain.receiptId);
    const first = await h.api("admin", "POST", `/payments/allocations/${chain.allocationId}/unallocate`, { reason: "unapply the recovery" });
    expect([first.status, first.body?.code], JSON.stringify(first.body)).toEqual([409, "recovery_allocation_immutable"]);
    const keyed = await h.api("admin", "POST", `/payments/allocations/${chain.allocationId}/unallocate`, { reason: "unapply the recovery", idempotencyKey: `g59-${chain.allocationId}` });
    expect([keyed.status, keyed.body?.code], JSON.stringify(keyed.body)).toEqual([409, "recovery_allocation_immutable"]);
    expect(await snapshot(chain.recoveryId, chain.receiptId)).toEqual(before);
  });
});
