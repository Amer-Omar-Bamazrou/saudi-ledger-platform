/**
 * PHASE 18 · S1 · G58 PROOF — two credit notes approved AT ONCE against one
 * invoice. PROOF ONLY, NOT A FIX.
 *
 * Authorised by the owner on 2026-10-11 ("Phase 18 S1: proof tests only").
 * Definition: the Phase 18 contract, G58 (§11; §21.4 "next: a focused proof
 * test; whether to fix is decided after it"), and its proving-test shape
 * (§16.2): "Two credit notes against one invoice approved at once: one
 * refused, Σ credited ≤ total".
 *
 * The mechanism (read at HEAD 44427b23):
 *  - approval RE-VALIDATES a note with `assertNoteIsValid`
 *    (services/invoices.approvable.ts:182-194), whose own comment says it
 *    exists because "a concurrent note may have consumed the remaining credit";
 *  - but that check sums only ISSUED notes (`notesAgainst`,
 *    repositories/invoices.repository.ts:413-425, `invoice_hash IS NOT NULL`;
 *    services/creditNotes.ts:168-189) and runs BEFORE the company sequence
 *    lock (invoices.approvable.ts:242) and the original-invoice row lock (:492);
 *  - so two approvals can both pass it before either commits. The lock then
 *    serialises them AFTER the check, and the second note's credit beyond the
 *    original's open balance is posted to CUSTOMER_CREDITS (:494-516).
 *
 * The race is FORCED, not hoped for (the QA-11 pattern,
 * phase16-17-qa-fixes.test.ts). A holder connection takes the company's
 * sequence advisory lock, `hashtextextended(companyId, 0)`. Both approvals run
 * their validation and then WAIT on that lock. The test sees exactly two
 * waiters on THAT key (not any advisory lock in the database) before it
 * releases. If either request never reaches the lock, the test fails loudly
 * instead of passing.
 *
 * The SAFE invariant is asserted. The evidence is logged before the
 * assertions. A CONTROL proves that the guard and the probe work: the same two
 * notes approved one after the other give 200, then 409 `note_over_credit`.
 * No production code is changed by this file.
 *
 * 🔴 On unmodified code this proof FAILED BY DESIGN: S1, 2026-10-11, both
 * approvals 200, Σ 1,840.00 against 1,150.00, and 690.00 to CUSTOMER_CREDITS.
 * It lands, with its assertions unchanged, together with the owner-authorised
 * G58 fix (the ceiling re-checked under the company sequence lock,
 * services/invoices.approvable.ts), as that fix's regression proof. It must
 * never be weakened to pass; see also `g58-credit-note-ceiling-under-lock.test.ts`.
 *
 * DB-backed; skips on the DB-free placeholder.
 */

process.env.PORT ??= "3141";
process.env.SESSION_SECRET ??= "phase18-s1-g58-proof-session-secret-00001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { __resetRateLimitsForTests } from "../routes/auth";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

const PW = "S1G58ProofPw123!";

describeMaybe("Phase 18 S1 · G58 proof — two credit notes approved at once against one invoice", () => {
  const h = g04Harness("s1g58");
  let orgId = "";
  let companyId = "";
  let customerId = 0;
  let seq = 0;

  /** An issued invoice (net + 15% VAT), through the product's own HTTP paths. */
  async function issueInvoice(net: number): Promise<number> {
    seq += 1;
    const created = await h.api("bookkeeper", "POST", "/invoices", {
      invoiceNumber: `S1G58-INV-${seq}`,
      date: "2026-10-01",
      customerId,
      items: [{ description: "Service", quantity: 1, unitPrice: net, vatRate: 15 }],
    });
    expect(created.status, `create invoice: ${JSON.stringify(created.body)}`).toBe(201);
    const approved = await h.api("admin", "POST", `/invoices/${created.body.id}/approve`, {});
    expect(approved.status, `approve invoice: ${JSON.stringify(approved.body)}`).toBe(200);
    return created.body.id as number;
  }

  /** A DRAFT credit note against `originalInvoiceId` (net + 15% VAT). */
  async function draftCreditNote(originalInvoiceId: number, net: number): Promise<number> {
    seq += 1;
    const created = await h.api("bookkeeper", "POST", "/invoices", {
      invoiceNumber: `S1G58-CN-${seq}`,
      documentType: "credit_note",
      originalInvoiceId,
      noteReason: "Goods returned",
      date: "2026-10-02",
      customerId,
      items: [{ description: "Return", quantity: 1, unitPrice: net, vatRate: 15 }],
    });
    expect(created.status, `create credit note: ${JSON.stringify(created.body)}`).toBe(201);
    return created.body.id as number;
  }

  /** What the ledger and the documents say about one original and its credit notes. */
  async function evidence(originalId: number) {
    const original = (await pool.query(
      `SELECT invoice_number, total::text, credited_amount::text FROM invoices WHERE id = $1`, [originalId],
    )).rows[0];
    const notes = (await pool.query(
      `SELECT id, invoice_number, status, total::text, (invoice_hash IS NOT NULL) AS issued
         FROM invoices WHERE original_invoice_id = $1 AND document_type = 'credit_note' ORDER BY id`, [originalId],
    )).rows as Array<{ id: number; invoice_number: string; status: string; total: string; issued: boolean }>;
    const issuedNotesTotal = Math.round(notes.filter((n) => n.issued).reduce((s, n) => s + Number(n.total), 0) * 100) / 100;
    // Σ (Cr − Dr) on CUSTOMER_CREDITS from THESE notes' own entries (GL-<note number>), in the books.
    const customerCreditsFromNotes = Number((await pool.query(
      `SELECT coalesce(sum(l.credit_amount - l.debit_amount), 0)::text AS v
         FROM journal_entry_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN categories c ON c.id = l.account_id
        WHERE e.organization_id = $1 AND c.system_code = 'CUSTOMER_CREDITS' AND e.status IN ('posted','reversed')
          AND e.entry_number = ANY($2::text[])`,
      [orgId, notes.map((n) => `GL-${n.invoice_number}`)],
    )).rows[0].v);
    return {
      originalNumber: original.invoice_number as string,
      originalTotal: Number(original.total),
      originalCreditedAmount: Number(original.credited_amount),
      notes: notes.map((n) => ({ id: n.id, number: n.invoice_number, status: n.status, total: Number(n.total), issued: n.issued })),
      issuedNotesTotal,
      customerCreditsFromNotes,
    };
  }

  /** Requests WAITING on this company's sequence advisory lock, and no other advisory lock. */
  async function waitersOnSequenceLock(): Promise<number> {
    return Number((await pool.query(
      `SELECT count(*)::int AS n
         FROM pg_locks l, (SELECT hashtextextended($1::text, 0) AS k) x
        WHERE l.locktype = 'advisory' AND NOT l.granted AND l.objsubid = 1
          AND l.classid::bigint = ((x.k >> 32) & 4294967295)
          AND l.objid::bigint = (x.k & 4294967295)`,
      [companyId],
    )).rows[0].n);
  }

  beforeAll(async () => {
    await __resetRateLimitsForTests();
    await h.cleanup();
    orgId = await h.mkOrg("org");
    companyId = await h.mkCompany(orgId, "S1 G58 Co", "318181818181803");
    customerId = (await pool.query(
      `INSERT INTO customers (organization_id, name, tax_number) VALUES ($1,'S1 G58 Buyer','300000000000003') RETURNING id`, [orgId],
    )).rows[0].id;
    await h.mkUser("admin", PW, orgId, "admin");
    await h.mkUser("accountant", PW, orgId, "accountant");
    await h.mkUser("bookkeeper", PW, orgId, "bookkeeper");
    await h.start();
    for (const who of ["admin", "accountant", "bookkeeper"]) {
      expect(await h.login(who, h.email(who), PW), `login ${who}`).toBe(200);
    }
  }, 120_000);

  afterAll(async () => {
    await h.stop();
    await h.cleanup();
  });

  it("CONTROL (sequential): the second note is refused 409 note_over_credit; Σ issued ≤ the invoice; nothing goes to CUSTOMER_CREDITS", async () => {
    const original = await issueInvoice(1_000); // 1,150.00 with VAT
    // Both drafts are ACCEPTED at create: the create-time check also counts issued notes only.
    const n1 = await draftCreditNote(original, 800); // 920.00
    const n2 = await draftCreditNote(original, 800); // 920.00, together 1,840.00 > 1,150.00
    const first = await h.api("admin", "POST", `/invoices/${n1}/approve`, {});
    const second = await h.api("accountant", "POST", `/invoices/${n2}/approve`, {});
    const ev = await evidence(original);
    // eslint-disable-next-line no-console
    console.warn("[S1 G58] CONTROL", JSON.stringify({ first: [first.status, first.body?.code], second: [second.status, second.body?.code], ...ev }));
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect([second.status, second.body?.code], JSON.stringify(second.body)).toEqual([409, "note_over_credit"]);
    expect(ev.originalTotal).toBe(1_150);
    expect(ev.issuedNotesTotal).toBe(920);
    expect(ev.issuedNotesTotal).toBeLessThanOrEqual(ev.originalTotal);
    expect(ev.customerCreditsFromNotes).toBe(0);
    expect(ev.originalCreditedAmount).toBe(920);
  });

  it("🔴 PROOF (forced race): of two notes approved at once, ONE is refused; Σ issued ≤ the invoice; nothing goes to CUSTOMER_CREDITS", async () => {
    const original = await issueInvoice(1_000); // 1,150.00 with VAT
    const n1 = await draftCreditNote(original, 800);
    const n2 = await draftCreditNote(original, 800);

    const holder = await pool.connect();
    let held = false;
    let results: Array<{ status: number; body: any }> = [];
    try {
      await holder.query(`SELECT pg_advisory_lock(hashtextextended($1::text, 0))`, [companyId]);
      held = true;
      const racing = Promise.all([
        h.api("admin", "POST", `/invoices/${n1}/approve`, {}),
        h.api("accountant", "POST", `/invoices/${n2}/approve`, {}),
      ]);
      // Both approvals must have PASSED validation and be WAITING on the sequence lock before it is released.
      const deadline = Date.now() + 20_000;
      for (;;) {
        const waiting = await waitersOnSequenceLock();
        if (waiting >= 2) break;
        if (Date.now() > deadline) throw new Error(`only ${waiting} approval(s) reached the company sequence lock — the race was not established`);
        await new Promise((r) => setTimeout(r, 50));
      }
      await holder.query(`SELECT pg_advisory_unlock(hashtextextended($1::text, 0))`, [companyId]);
      held = false;
      results = await racing;
    } finally {
      if (held) await holder.query(`SELECT pg_advisory_unlock(hashtextextended($1::text, 0))`, [companyId]);
      holder.release();
    }

    const ev = await evidence(original);
    // Evidence for the report, recorded before the assertions.
    // eslint-disable-next-line no-console
    console.warn("[S1 G58] RACE", JSON.stringify({ statuses: results.map((r) => [r.status, r.body?.code ?? null]), ...ev }));

    expect.soft(results.map((r) => r.status).sort(), "exactly one approval succeeds; the other is refused").toEqual([200, 409]);
    expect.soft(ev.issuedNotesTotal, "Σ issued credit notes must not exceed the invoice total").toBeLessThanOrEqual(ev.originalTotal);
    expect.soft(ev.customerCreditsFromNotes, "no over-credit lands in CUSTOMER_CREDITS").toBe(0);
  }, 60_000);
});
