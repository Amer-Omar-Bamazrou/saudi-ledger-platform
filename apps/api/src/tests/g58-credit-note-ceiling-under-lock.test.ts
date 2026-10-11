/**
 * 🔴 G58 REGRESSION (Phase 18, remediation batch 1): a credit note's ceiling is
 * re-checked UNDER the company sequence lock, so concurrent approvals can never
 * credit an invoice beyond its total. This complements the S1 proof
 * (`phase18-s1-g58-credit-note-race.test.ts`, kept unchanged), which pins the
 * reproduced case of two 920.00 notes against a 1,150.00 invoice.
 *
 * What this file adds:
 *  - notes that FIT are not refused: concurrency must not cost a legitimate
 *    note;
 *  - with room for two of three, exactly two issue;
 *  - the refused approval leaves NOTHING behind: the note stays a draft, with
 *    no hash, ICV or UUID; no journal entry, allocation, e-invoice document or
 *    approve audit row; and no gap in the company's ICV sequence;
 *  - repeated UNFORCED concurrency: a plain parallel race, round after round;
 *  - authorisation is unchanged: a bookkeeper still cannot approve.
 *
 * The race is FORCED where it matters (the QA-11 pattern): a holder takes the
 * company's sequence advisory lock, and every approval must be seen WAITING on
 * that exact key before it is released. Real requests, real app, real
 * database; nothing is mocked.
 *
 * DB-backed; skips on the DB-free placeholder.
 */

process.env.PORT ??= "3146";
process.env.SESSION_SECRET ??= "g58-credit-note-ceiling-under-lock-secret-001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { __resetRateLimitsForTests } from "../routes/auth";
import { g04Harness, type Res } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

const PW = "G58RegressionPw123!";

describeMaybe("G58 — a credit note's ceiling holds under concurrent approval", () => {
  const h = g04Harness("g58reg");
  let orgId = "";
  let companyId = "";
  let customerId = 0;
  let seq = 0;

  async function issueInvoice(net: number): Promise<number> {
    seq += 1;
    const created = await h.api("bookkeeper", "POST", "/invoices", {
      invoiceNumber: `G58R-INV-${seq}`, date: "2026-10-01", customerId,
      items: [{ description: "Service", quantity: 1, unitPrice: net, vatRate: 15 }],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const approved = await h.api("admin", "POST", `/invoices/${created.body.id}/approve`, {});
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    return created.body.id as number;
  }

  async function draftCreditNote(originalInvoiceId: number, net: number): Promise<{ id: number; number: string }> {
    seq += 1;
    const number = `G58R-CN-${seq}`;
    const created = await h.api("bookkeeper", "POST", "/invoices", {
      invoiceNumber: number, documentType: "credit_note", originalInvoiceId, noteReason: "Goods returned",
      date: "2026-10-02", customerId, items: [{ description: "Return", quantity: 1, unitPrice: net, vatRate: 15 }],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return { id: created.body.id as number, number };
  }

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

  /** Approve every note at once, with the race FORCED: all must wait on the company sequence lock before it is released. */
  async function forcedRace(noteIds: number[]): Promise<Res[]> {
    const approvers = ["admin", "accountant"];
    const holder = await pool.connect();
    let held = false;
    try {
      await holder.query(`SELECT pg_advisory_lock(hashtextextended($1::text, 0))`, [companyId]);
      held = true;
      const racing = Promise.all(noteIds.map((id, i) => h.api(approvers[i % approvers.length]!, "POST", `/invoices/${id}/approve`, {})));
      const deadline = Date.now() + 20_000;
      for (;;) {
        const waiting = await waitersOnSequenceLock();
        if (waiting >= noteIds.length) break;
        if (Date.now() > deadline) throw new Error(`only ${waiting} of ${noteIds.length} approvals reached the company sequence lock`);
        await new Promise((r) => setTimeout(r, 50));
      }
      await holder.query(`SELECT pg_advisory_unlock(hashtextextended($1::text, 0))`, [companyId]);
      held = false;
      return await racing;
    } finally {
      if (held) await holder.query(`SELECT pg_advisory_unlock(hashtextextended($1::text, 0))`, [companyId]);
      holder.release();
    }
  }

  async function ceiling(originalId: number) {
    const original = (await pool.query(`SELECT total::text, credited_amount::text FROM invoices WHERE id = $1`, [originalId])).rows[0];
    const notes = (await pool.query(
      `SELECT invoice_number, total::text FROM invoices
        WHERE original_invoice_id = $1 AND document_type = 'credit_note' AND invoice_hash IS NOT NULL`, [originalId],
    )).rows as Array<{ invoice_number: string; total: string }>;
    const customerCredits = Number((await pool.query(
      `SELECT coalesce(sum(l.credit_amount - l.debit_amount), 0)::text AS v
         FROM journal_entry_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN categories c ON c.id = l.account_id
        WHERE e.organization_id = $1 AND c.system_code = 'CUSTOMER_CREDITS' AND e.status IN ('posted','reversed')
          AND e.entry_number = ANY($2::text[])`,
      [orgId, notes.map((n) => `GL-${n.invoice_number}`)],
    )).rows[0].v);
    return {
      total: Number(original.total),
      credited: Number(original.credited_amount),
      issuedNotes: notes.length,
      issuedSum: Math.round(notes.reduce((s, n) => s + Number(n.total), 0) * 100) / 100,
      customerCredits,
    };
  }

  /** Everything an approval of `note` could have written. A refused one must have written none of it. */
  async function traceOf(note: { id: number; number: string }) {
    const row = (await pool.query(
      `SELECT status, invoice_hash, icv, zatca_uuid FROM invoices WHERE id = $1`, [note.id],
    )).rows[0];
    const count = async (sql: string, args: unknown[]) => Number((await pool.query(sql, args)).rows[0].n);
    return {
      status: row.status as string,
      hash: row.invoice_hash as string | null,
      icv: row.icv as number | null,
      uuid: row.zatca_uuid as string | null,
      journalEntries: await count(`SELECT count(*)::int AS n FROM journal_entries WHERE organization_id = $1 AND entry_number = $2`, [orgId, `GL-${note.number}`]),
      allocations: await count(`SELECT count(*)::int AS n FROM payment_allocations WHERE credit_note_id = $1`, [note.id]),
      einvoiceDocuments: await count(`SELECT count(*)::int AS n FROM einvoice_documents WHERE invoice_id = $1`, [note.id]),
      approveAudits: await count(`SELECT count(*)::int AS n FROM audit_logs WHERE entity_type = 'invoice' AND entity_id = $1 AND action = 'approve'`, [String(note.id)]),
    };
  }

  const maxIcv = async () =>
    Number((await pool.query(`SELECT coalesce(max(icv), 0)::int AS n FROM invoices WHERE company_id = $1`, [companyId])).rows[0].n);
  const companyEntries = async () =>
    Number((await pool.query(`SELECT count(*)::int AS n FROM journal_entries WHERE company_id = $1`, [companyId])).rows[0].n);

  beforeAll(async () => {
    await __resetRateLimitsForTests();
    await h.cleanup();
    orgId = await h.mkOrg("org");
    companyId = await h.mkCompany(orgId, "G58 Regression Co", "318181818181863");
    customerId = (await pool.query(
      `INSERT INTO customers (organization_id, name, tax_number) VALUES ($1,'G58 Regression Buyer','300000000000003') RETURNING id`, [orgId],
    )).rows[0].id;
    await h.mkUser("admin", PW, orgId, "admin");
    await h.mkUser("accountant", PW, orgId, "accountant");
    await h.mkUser("bookkeeper", PW, orgId, "bookkeeper");
    await h.start();
    for (const who of ["admin", "accountant", "bookkeeper"]) expect(await h.login(who, h.email(who), PW), `login ${who}`).toBe(200);
  }, 120_000);

  afterAll(async () => {
    await h.stop();
    await h.cleanup();
  });

  it("🔴 notes that FIT are not refused: two concurrent notes summing exactly to the invoice both issue", async () => {
    const original = await issueInvoice(1_000); // 1,150.00
    const a = await draftCreditNote(original, 500); // 575.00
    const b = await draftCreditNote(original, 500); // 575.00, together exactly 1,150.00
    const results = await forcedRace([a.id, b.id]);
    expect(results.map((r) => r.status), JSON.stringify(results.map((r) => r.body))).toEqual([200, 200]);
    expect(await ceiling(original)).toEqual({ total: 1_150, credited: 1_150, issuedNotes: 2, issuedSum: 1_150, customerCredits: 0 });
  });

  it("🔴 three concurrent notes with room for two: two issue, one is refused 409 note_over_credit; Σ issued = the invoice", async () => {
    const original = await issueInvoice(1_000);
    const notes = [await draftCreditNote(original, 500), await draftCreditNote(original, 500), await draftCreditNote(original, 500)];
    const results = await forcedRace(notes.map((n) => n.id));
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 409]);
    expect(results.find((r) => r.status === 409)!.body.code).toBe("note_over_credit");
    expect(await ceiling(original)).toEqual({ total: 1_150, credited: 1_150, issuedNotes: 2, issuedSum: 1_150, customerCredits: 0 });
  });

  it("🔴 the REFUSED approval leaves nothing behind: still a draft, no hash/ICV/UUID, no entry, allocation, e-invoice document or audit row, and no ICV gap", async () => {
    const original = await issueInvoice(1_000);
    const a = await draftCreditNote(original, 800); // 920.00
    const b = await draftCreditNote(original, 800); // 920.00
    const icvBefore = await maxIcv();
    const entriesBefore = await companyEntries();
    const results = await forcedRace([a.id, b.id]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const [winner, loser] = results[0]!.status === 200 ? [a, b] : [b, a];

    const lost = await traceOf(loser);
    expect(lost).toEqual({ status: "draft", hash: null, icv: null, uuid: null, journalEntries: 0, allocations: 0, einvoiceDocuments: 0, approveAudits: 0 });
    const won = await traceOf(winner);
    expect([won.status, won.journalEntries, won.approveAudits]).toEqual(["sent", 1, 1]);
    // exactly ONE entry was added (the winner's), and the winner took the next ICV
    expect(await companyEntries()).toBe(entriesBefore + 1);
    expect(won.icv).toBe(icvBefore + 1);
    expect(await ceiling(original)).toEqual({ total: 1_150, credited: 920, issuedNotes: 1, issuedSum: 920, customerCredits: 0 });
    // the loser consumed no ICV: the next document issued takes the very next number
    const next = await issueInvoice(10);
    expect((await pool.query(`SELECT icv FROM invoices WHERE id = $1`, [next])).rows[0].icv).toBe(icvBefore + 2);
    // and approving the refused note again, now alone, is still refused by name, still with nothing written
    const again = await h.api("admin", "POST", `/invoices/${loser.id}/approve`, {});
    expect([again.status, again.body?.code]).toEqual([409, "note_over_credit"]);
    expect((await traceOf(loser)).journalEntries).toBe(0);
  });

  it("🔴 repeated UNFORCED concurrency — five rounds of a plain parallel race: every round, one issues, one is refused, and the ceiling holds", async () => {
    for (let round = 1; round <= 5; round++) {
      const original = await issueInvoice(1_000);
      const a = await draftCreditNote(original, 800);
      const b = await draftCreditNote(original, 800);
      const results = await Promise.all([
        h.api("admin", "POST", `/invoices/${a.id}/approve`, {}),
        h.api("accountant", "POST", `/invoices/${b.id}/approve`, {}),
      ]);
      expect(results.map((r) => r.status).sort(), `round ${round}: ${JSON.stringify(results.map((r) => r.body?.code ?? null))}`).toEqual([200, 409]);
      const c = await ceiling(original);
      expect(c.issuedSum, `round ${round}`).toBeLessThanOrEqual(c.total);
      expect(c.customerCredits, `round ${round}`).toBe(0);
    }
  }, 120_000);

  it("authorisation is unchanged: a bookkeeper still cannot approve a credit note (403), and nothing is issued", async () => {
    const original = await issueInvoice(1_000);
    const note = await draftCreditNote(original, 100);
    const r = await h.api("bookkeeper", "POST", `/invoices/${note.id}/approve`, {});
    expect(r.status, JSON.stringify(r.body)).toBe(403);
    expect((await traceOf(note)).status).toBe("draft");
  });
});
