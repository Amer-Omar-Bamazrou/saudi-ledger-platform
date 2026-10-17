/**
 * PHASE 18 · S1-b · G08 PROOF — the generic approval engine is check-then-act:
 * (a) one invoice approved TWICE at once; (b) a REJECT racing an approval.
 * PROOF ONLY, NOT A FIX.
 *
 * Authorised by the owner on 2026-10-16 (Batch 4B). Definition: Phase 18
 * contract G08 (§11.2: "(a) a double approve can re-stamp the ICV of a
 * zero-total invoice in a non-onboarded company; (b) reject or delete can
 * remove a just-issued invoice"), §16.2 APR-1 / APR-4, and the plan of
 * 2026-10-16 §9.
 *
 * The mechanism (read at f480a569):
 *  - `approvalService.approve` / `.reject` load the row UNLOCKED, check its
 *    state, then act (services/approval/approval.service.ts);
 *  - issuance takes the company sequence lock, then assigns
 *    `icv = inv.icv ?? nextIcv(...)` from the row loaded BEFORE the lock, and
 *    re-stamps the invoice (invoices.approvable.ts). Only a GL entry
 *    (`GL-<number>`, unique per company) collides on a second issuance — a
 *    zero-total invoice posts none;
 *  - `invoiceApprovable().hardDelete` deletes by id with no state predicate
 *    (invoices.repository.ts `remove`), and no trigger guards a DELETE of an
 *    issued invoice; its foreign keys to a plain invoice cascade.
 *
 * Both races are FORCED, never hoped for:
 *  (a) a holder takes the company sequence advisory lock; both approvals pass
 *      their unlocked state check and WAIT on it (two waiters on THAT key);
 *  (b) a holder locks the invoice ROW; the approval queues on it first (seen
 *      waiting on `update "invoices"`), then the reject queues behind it (seen
 *      waiting on `delete from "invoices"`); the holder releases.
 *
 * FIX-NEUTRAL invariants: of two concurrent acts on one document at most one
 * succeeds; an issued invoice keeps the ONE ICV issuance gave it (no ICV is
 * lost); an invoice whose approval answered 2xx still exists, issued, with its
 * GL entry. CONTROLS: a zero-total invoice issues once on its own (premise);
 * two NON-zero approvals at once — the GL entry key lets only one through.
 *
 * 🔴 Expected to FAIL while G08 exists. Untracked S1-b file — never merged red,
 * never weakened. Does NOT call the rate-limit reset hook. DB-backed.
 */

process.env.PORT ??= "3153";
process.env.SESSION_SECRET ??= "phase18-s1b-g08-proof-session-secret-0001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

const PW = "S1bG08ProofPw123!";

describeMaybe("Phase 18 S1-b · G08 proof — two acts on one invoice at once (double approve; reject vs approve)", () => {
  const h = g04Harness("s1bg08");
  let orgId = "";
  let companyId = "";
  let customerId = 0;
  let seq = 0;

  async function draftInvoice(unitPrice: number): Promise<{ id: number; no: string }> {
    seq += 1;
    const no = `S1BG08-INV-${String(seq).padStart(3, "0")}`;
    const created = await h.api("bookkeeper", "POST", "/invoices", {
      invoiceNumber: no, date: "2026-10-05", customerId,
      items: [{ description: "Service", quantity: 1, unitPrice, vatRate: 15 }],
    });
    expect(created.status, `create invoice ${no}: ${JSON.stringify(created.body)}`).toBe(201);
    return { id: created.body.id as number, no };
  }

  const maxIcv = async () => Number((await pool.query(`SELECT coalesce(max(icv), 0)::int AS m FROM invoices WHERE company_id = $1`, [companyId])).rows[0].m);

  async function evidence(inv: { id: number; no: string }) {
    const row = (await pool.query(
      `SELECT status, icv, (invoice_hash IS NOT NULL) AS issued, total::text FROM invoices WHERE id = $1`, [inv.id],
    )).rows[0] ?? null;
    const items = Number((await pool.query(`SELECT count(*)::int AS n FROM invoice_items WHERE invoice_id = $1`, [inv.id])).rows[0].n);
    const gl = (await pool.query(
      `SELECT id, status FROM journal_entries WHERE organization_id = $1 AND entry_number = $2`, [orgId, `GL-${inv.no}`],
    )).rows;
    const audits = (await pool.query(
      `SELECT action, count(*)::int AS n FROM audit_logs WHERE organization_id = $1 AND entity_type = 'invoice' AND entity_id = $2 GROUP BY action ORDER BY action`,
      [orgId, String(inv.id)],
    )).rows.map((r) => `${r.action}:${r.n}`);
    const icvs = (await pool.query(`SELECT icv FROM invoices WHERE company_id = $1 AND icv IS NOT NULL ORDER BY icv`, [companyId])).rows.map((r) => Number(r.icv));
    return { invoice: row, items, glEntries: gl, audits, companyIcvs: icvs };
  }

  const waitersOnSequenceLock = async () => Number((await pool.query(
    `SELECT count(*)::int AS n FROM pg_locks l, (SELECT hashtextextended($1::text, 0) AS k) x
      WHERE l.locktype = 'advisory' AND NOT l.granted AND l.objsubid = 1
        AND l.classid::bigint = ((x.k >> 32) & 4294967295) AND l.objid::bigint = (x.k & 4294967295)`, [companyId],
  )).rows[0].n);
  const waitingOn = async (statementStart: string) => Number((await pool.query(
    `SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock' AND ltrim(query) ILIKE $1`, [`${statementStart}%`],
  )).rows[0].n);
  async function until(label: string, check: () => Promise<boolean>) {
    const deadline = Date.now() + 20_000;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error(`${label} — the race was not established`);
      await new Promise((res) => setTimeout(res, 50));
    }
  }

  /** Two approvals of one invoice, both held at the company sequence lock, then released. */
  async function doubleApprove(id: number) {
    const holder = await pool.connect();
    let held = false;
    try {
      await holder.query(`SELECT pg_advisory_lock(hashtextextended($1::text, 0))`, [companyId]);
      held = true;
      const racing = Promise.all([
        h.api("admin", "POST", `/invoices/${id}/approve`, {}),
        h.api("accountant", "POST", `/invoices/${id}/approve`, {}),
      ]);
      await until("both approvals did not reach the company sequence lock", async () => (await waitersOnSequenceLock()) >= 2);
      await holder.query(`SELECT pg_advisory_unlock(hashtextextended($1::text, 0))`, [companyId]);
      held = false;
      return await racing;
    } finally {
      if (held) await holder.query(`SELECT pg_advisory_unlock(hashtextextended($1::text, 0))`, [companyId]);
      holder.release();
    }
  }

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    companyId = await h.mkCompany(orgId, "S1b G08 Co", "318181818181853");
    customerId = (await pool.query(
      `INSERT INTO customers (organization_id, name, tax_number) VALUES ($1,'S1b G08 Buyer','300000000000003') RETURNING id`, [orgId],
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

  it("PREMISE: a zero-total invoice can be created and issued on its own (it takes the next ICV, posts no GL entry)", async () => {
    const before = await maxIcv();
    const inv = await draftInvoice(0);
    const approved = await h.api("admin", "POST", `/invoices/${inv.id}/approve`, {});
    const ev = await evidence(inv);
    // eslint-disable-next-line no-console
    console.warn("[S1B G08] PREMISE zero-total", JSON.stringify({ approve: [approved.status, approved.body?.code ?? null], icvBefore: before, ...ev }));
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect(ev.invoice?.issued).toBe(true);
    expect(Number(ev.invoice?.icv)).toBe(before + 1);
    expect(Number(ev.invoice?.total)).toBe(0);
    expect(ev.glEntries.length).toBe(0);
  });

  it("CONTROL (forced race, NON-zero): two approvals at once — only one succeeds (the GL entry key refuses the second); the ICV is the next one", async () => {
    const before = await maxIcv();
    const inv = await draftInvoice(1_000);
    const results = await doubleApprove(inv.id);
    const ev = await evidence(inv);
    // eslint-disable-next-line no-console
    console.warn("[S1B G08] CONTROL non-zero", JSON.stringify({ statuses: results.map((r) => [r.status, r.body?.code ?? null, String(r.body?.error ?? "").slice(0, 160)]), icvBefore: before, ...ev }));
    expect(results.filter((r) => r.status < 300).length, "at most one of two concurrent approvals succeeds").toBe(1);
    expect(Number(ev.invoice?.icv)).toBe(before + 1);
    expect(ev.glEntries.length).toBe(1);
  }, 60_000);

  it("🔴 PROOF (a) (forced race, ZERO-total): two approvals at once — at most one succeeds, and the invoice keeps the ONE ICV issuance gave it (no ICV lost)", async () => {
    const before = await maxIcv();
    const inv = await draftInvoice(0);
    const results = await doubleApprove(inv.id);
    const ev = await evidence(inv);
    const missing = (() => { const s = new Set(ev.companyIcvs); const m: number[] = []; for (let i = 1; i <= Math.max(0, ...ev.companyIcvs); i++) if (!s.has(i)) m.push(i); return m; })();
    // eslint-disable-next-line no-console
    console.warn("[S1B G08] DOUBLE APPROVE zero-total", JSON.stringify({ statuses: results.map((r) => [r.status, r.body?.code ?? null]), icvBefore: before, missingIcvs: missing, ...ev }));
    expect.soft(results.filter((r) => r.status < 300).length, "at most one of two concurrent approvals of one invoice succeeds").toBeLessThanOrEqual(1);
    expect.soft(Number(ev.invoice?.icv), "the invoice holds the next ICV — it was not re-stamped").toBe(before + 1);
    expect.soft(missing, "no ICV in the company's sequence is lost").toEqual([]);
    expect.soft(ev.audits.filter((a) => a.startsWith("approve:")), "one approval is recorded").toEqual(["approve:1"]);
  }, 60_000);

  it("🔴 PROOF (b) (forced interleaving): a REJECT racing an approval — an invoice whose approval answered 2xx still exists, issued, with its GL entry; never both succeed", async () => {
    const inv = await draftInvoice(1_000);
    const holder = await pool.connect();
    let open = false;
    let approveRes: { status: number; body: any } | null = null;
    let rejectRes: { status: number; body: any } | null = null;
    try {
      await holder.query("BEGIN");
      open = true;
      await holder.query(`SELECT id FROM invoices WHERE id = $1 FOR UPDATE`, [inv.id]);
      const approving = h.api("admin", "POST", `/invoices/${inv.id}/approve`, {});
      await until("the approval did not queue on the invoice row", async () => (await waitingOn(`update "invoices"`)) >= 1);
      const rejecting = h.api("accountant", "POST", `/invoices/${inv.id}/reject`, {});
      await until("the reject did not queue on the invoice row", async () => (await waitingOn(`delete from "invoices"`)) >= 1);
      await holder.query("COMMIT");
      open = false;
      [approveRes, rejectRes] = await Promise.all([approving, rejecting]);
    } finally {
      if (open) await holder.query("ROLLBACK");
      holder.release();
    }
    const ev = await evidence(inv);
    // eslint-disable-next-line no-console
    console.warn("[S1B G08] REJECT vs APPROVE", JSON.stringify({ approve: [approveRes!.status, approveRes!.body?.code ?? null], reject: [rejectRes!.status, rejectRes!.body?.code ?? null], ...ev }));
    const bothSucceeded = approveRes!.status < 300 && rejectRes!.status < 300;
    expect.soft(bothSucceeded, "an approval and a reject of one invoice never both succeed").toBe(false);
    if (approveRes!.status < 300) {
      expect.soft(ev.invoice, "the invoice whose approval answered 2xx still exists").not.toBeNull();
      expect.soft(ev.invoice?.issued ?? false, "…issued").toBe(true);
      expect.soft(ev.glEntries.length, "…with its GL entry").toBe(1);
    }
  }, 60_000);
});
