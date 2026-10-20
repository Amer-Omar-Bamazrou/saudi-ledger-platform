/**
 * 🔴 G08 REGRESSION (Phase 18, remediation — G08 only): two acts on one invoice
 * at once can no longer re-stamp its ICV, delete it after it was issued, or
 * answer 2xx for an act that did not happen. This complements the S1-b proof
 * (`phase18-s1b-g08-approval-race.test.ts`, kept unchanged), which pins the two
 * reproduced cases: a zero-total invoice approved twice (its first ICV lost),
 * and a reject queued behind an approval (the issued invoice deleted, its entry
 * left posted).
 *
 * The fix: issuance RE-READS the invoice under the company sequence lock and
 * refuses unless it is still unissued; the issuing update, the reject's delete
 * and `DELETE /invoices/:id` are each CONDITIONAL on the invoice still being
 * unissued. No new lock is taken (the order stays company sequence, then the
 * invoice row).
 *
 * What this file adds:
 *  - legitimate acts are unchanged: a draft rejects, a SUBMITTED invoice
 *    rejects from the queue, a draft deletes; and the sequential refusals are
 *    unchanged;
 *  - the loser of each race gets the SAME 409 a sequential second act gets —
 *    including the non-zero double approve, which was refused only by the
 *    journal-entry key, with the misleading "another entry was recorded";
 *  - `DELETE /invoices/:id` racing an approval (the proof covered reject only);
 *  - the other direction: an approval that loses to a reject or delete —
 *    whether the delete committed before the approval re-read the invoice or
 *    after — answers 409 and issues nothing (no entry, no ICV consumed);
 *  - unforced rounds: approve and reject fired together, round after round.
 *
 * Every race below is FORCED (the QA-11 pattern): each request is seen waiting
 * on the exact lock or statement before the holder releases it. Real requests,
 * real app, real database; nothing is mocked. Three logins stay well inside the
 * rate limits, so this file does not call the rate-limit reset hook.
 *
 * DB-backed; skips on the DB-free placeholder.
 */

process.env.PORT ??= "3162";
process.env.SESSION_SECRET ??= "g08-invoice-approval-race-regression-0001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness, type Res } from "./helpers/g04Harness";
import { lockWaitersOn } from "./helpers/g08rRace";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

const PW = "G08RegressionPw123!";
const REMOVED_WHILE_APPROVING = "This invoice was rejected or deleted while it was being approved — nothing was issued.";

describeMaybe("G08 — two acts on one invoice at once: one wins, the other gets the sequential 409", () => {
  const h = g04Harness("g08reg");
  let orgId = "";
  let companyId = "";
  let customerId = 0;
  let seq = 0;
  /** The sequential refusals, captured by the control and compared against every race loser. */
  const sequential = { approveAgain: "", rejectIssued: "", deleteIssued: "" };

  type Inv = { id: number; no: string };

  async function draftInvoice(unitPrice: number): Promise<Inv> {
    seq += 1;
    const no = `G08R-INV-${String(seq).padStart(3, "0")}`;
    const created = await h.api("bookkeeper", "POST", "/invoices", {
      invoiceNumber: no, date: "2026-10-05", customerId,
      items: [{ description: "Service", quantity: 1, unitPrice, vatRate: 15 }],
    });
    expect(created.status, `create invoice ${no}: ${JSON.stringify(created.body)}`).toBe(201);
    return { id: created.body.id as number, no };
  }

  const maxIcv = async () => Number((await pool.query(`SELECT coalesce(max(icv), 0)::int AS m FROM invoices WHERE company_id = $1`, [companyId])).rows[0].m);
  /** ICVs missing from the company's sequence above `from` — what a lost ICV looks like. */
  async function missingIcvsAbove(from: number): Promise<number[]> {
    const icvs = new Set((await pool.query(`SELECT icv FROM invoices WHERE company_id = $1 AND icv > $2`, [companyId, from])).rows.map((r) => Number(r.icv)));
    const top = Math.max(from, ...icvs);
    const missing: number[] = [];
    for (let i = from + 1; i <= top; i++) if (!icvs.has(i)) missing.push(i);
    return missing;
  }

  async function evidence(inv: Inv) {
    const row = (await pool.query(
      `SELECT status, icv, (invoice_hash IS NOT NULL) AS issued, total::text FROM invoices WHERE id = $1`, [inv.id],
    )).rows[0] ?? null;
    const items = Number((await pool.query(`SELECT count(*)::int AS n FROM invoice_items WHERE invoice_id = $1`, [inv.id])).rows[0].n);
    const glEntries = (await pool.query(
      `SELECT id, status FROM journal_entries WHERE organization_id = $1 AND entry_number = $2`, [orgId, `GL-${inv.no}`],
    )).rows;
    const audits = (await pool.query(
      `SELECT action, count(*)::int AS n FROM audit_logs WHERE organization_id = $1 AND entity_type = 'invoice' AND entity_id = $2 GROUP BY action ORDER BY action`,
      [orgId, String(inv.id)],
    )).rows.map((r) => `${r.action}:${r.n}`);
    return { invoice: row, items, glEntries, audits };
  }

  const waitersOnSequenceLock = async () => Number((await pool.query(
    `SELECT count(*)::int AS n FROM pg_locks l, (SELECT hashtextextended($1::text, 0) AS k) x
      WHERE l.locktype = 'advisory' AND NOT l.granted AND l.objsubid = 1
        AND l.classid::bigint = ((x.k >> 32) & 4294967295) AND l.objid::bigint = (x.k & 4294967295)`, [companyId],
  )).rows[0].n);
  async function until(label: string, check: () => Promise<boolean>) {
    const deadline = Date.now() + 20_000;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error(`${label} — the race was not established`);
      await new Promise((res) => setTimeout(res, 50));
    }
  }

  /** Two approvals of one invoice, both held at the company sequence lock, then released. */
  async function doubleApprove(id: number): Promise<Res[]> {
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

  /**
   * Two acts queued on the invoice ROW in a chosen order: a holder locks the
   * row, `first` is seen waiting on its statement, then `second`; the holder
   * releases and the first in the queue goes first. A waiter is counted only
   * inside THIS holder's wait tree, never a parallel file's matching one.
   */
  async function queuedOnRow(id: number, first: { send: () => Promise<Res>; waitsOn: string }, second: { send: () => Promise<Res>; waitsOn: string }): Promise<[Res, Res]> {
    const holder = await pool.connect();
    let open = false;
    try {
      await holder.query("BEGIN");
      open = true;
      const holderPid = Number((await holder.query(`SELECT pg_backend_pid() AS pid`)).rows[0].pid);
      await holder.query(`SELECT id FROM invoices WHERE id = $1 FOR UPDATE`, [id]);
      const a = first.send();
      await until(`the first act did not queue on ${first.waitsOn}`, async () => (await lockWaitersOn(holderPid, first.waitsOn)) >= 1);
      const b = second.send();
      await until(`the second act did not queue on ${second.waitsOn}`, async () => (await lockWaitersOn(holderPid, second.waitsOn)) >= 1);
      await holder.query("COMMIT");
      open = false;
      return await Promise.all([a, b]);
    } finally {
      if (open) await holder.query("ROLLBACK");
      holder.release();
    }
  }

  const approve = (who: string, id: number) => h.api(who, "POST", `/invoices/${id}/approve`, {});
  const reject = (who: string, id: number) => h.api(who, "POST", `/invoices/${id}/reject`, {});
  const del = (id: number) => h.api("admin", "DELETE", `/invoices/${id}`);
  const statuses = (rs: Res[]) => rs.map((r) => r.status).sort((x, y) => x - y);

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    companyId = await h.mkCompany(orgId, "G08 Regression Co", "318181818181863");
    customerId = (await pool.query(
      `INSERT INTO customers (organization_id, name, tax_number) VALUES ($1,'G08 Regression Buyer','300000000000003') RETURNING id`, [orgId],
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

  it("CONTROL (sequential): a draft rejects, a SUBMITTED invoice rejects from the queue, a draft deletes; an issued invoice refuses a second approve, a reject and a delete, unchanged", async () => {
    const draft = await draftInvoice(100);
    expect((await reject("accountant", draft.id)).status).toBe(204);
    expect((await evidence(draft)).invoice, "a rejected draft is removed").toBeNull();

    const queued = await draftInvoice(100);
    expect((await h.api("bookkeeper", "POST", `/invoices/${queued.id}/submit`, {})).status).toBe(200);
    expect((await reject("accountant", queued.id)).status, "a submitted invoice still rejects from the queue").toBe(204);
    expect((await evidence(queued)).invoice).toBeNull();

    const deletable = await draftInvoice(100);
    expect((await del(deletable.id)).status).toBe(204);
    expect((await evidence(deletable)).invoice, "a deleted draft is removed").toBeNull();

    const submitted = await draftInvoice(100);
    expect((await h.api("bookkeeper", "POST", `/invoices/${submitted.id}/submit`, {})).status).toBe(200);
    const delSubmitted = await del(submitted.id);
    expect(delSubmitted.status, "DELETE still takes drafts only").toBe(409);
    expect((await evidence(submitted)).invoice?.status).toBe("submitted");

    const issued = await draftInvoice(1_000);
    expect((await approve("admin", issued.id)).status).toBe(200);
    const before = await evidence(issued);
    const again = await approve("accountant", issued.id);
    const rej = await reject("accountant", issued.id);
    const gone = await del(issued.id);
    expect([again.status, rej.status, gone.status]).toEqual([409, 409, 409]);
    expect(await evidence(issued), "the issued invoice is untouched by the three refusals").toEqual(before);
    sequential.approveAgain = again.body?.error;
    sequential.rejectIssued = rej.body?.error;
    sequential.deleteIssued = gone.body?.error;
    expect(sequential.approveAgain).toBe("This invoice is already approved.");
    expect(sequential.rejectIssued).toBe("An approved invoice cannot be rejected — reverse it instead.");
    expect(sequential.deleteIssued).toBe("Only draft invoices can be deleted. Issued invoices must be reversed with a credit note.");
  });

  it("PREMISE: a zero-total invoice issues on its own (it takes the next ICV and posts no entry)", async () => {
    const before = await maxIcv();
    const inv = await draftInvoice(0);
    expect((await approve("admin", inv.id)).status).toBe(200);
    const ev = await evidence(inv);
    expect(ev.invoice?.issued).toBe(true);
    expect(Number(ev.invoice?.icv)).toBe(before + 1);
    expect(ev.glEntries).toHaveLength(0);
  });

  for (const [label, unitPrice] of [["ZERO-total", 0], ["non-zero", 1_000]] as const) {
    it(`🔴 two approvals of one ${label} invoice at once: one 200, the other the sequential 409 "already approved"; one ICV, none lost; one approval recorded`, async () => {
      const before = await maxIcv();
      const inv = await draftInvoice(unitPrice);
      const results = await doubleApprove(inv.id);
      const ev = await evidence(inv);
      const missing = await missingIcvsAbove(before);
      // eslint-disable-next-line no-console
      console.warn(`[G08 REG] double approve ${label}`, JSON.stringify({ results: results.map((r) => [r.status, r.body?.code ?? null, r.body?.error ?? null]), icvBefore: before, missing, ...ev }));
      expect(statuses(results)).toEqual([200, 409]);
      expect(results.find((r) => r.status === 409)?.body?.error, "the loser gets the sequential refusal").toBe(sequential.approveAgain);
      expect(Number(ev.invoice?.icv), "the invoice keeps the ICV issuance gave it — not re-stamped").toBe(before + 1);
      expect(missing, "no ICV is lost").toEqual([]);
      expect(ev.glEntries, "one entry (none for a zero-total invoice)").toHaveLength(unitPrice > 0 ? 1 : 0);
      expect(ev.audits.filter((a) => a.startsWith("approve:"))).toEqual(["approve:1"]);
    }, 60_000);
  }

  it("🔴 a REJECT queued behind an approval: the approval 200, the reject the sequential 409; the issued invoice survives with its lines and its entry", async () => {
    const inv = await draftInvoice(1_000);
    const [approved, rejected] = await queuedOnRow(inv.id,
      { send: () => approve("admin", inv.id), waitsOn: `update "invoices"` },
      { send: () => reject("accountant", inv.id), waitsOn: `delete from "invoices"` });
    const ev = await evidence(inv);
    // eslint-disable-next-line no-console
    console.warn("[G08 REG] reject behind approve", JSON.stringify({ approve: [approved.status], reject: [rejected.status, rejected.body?.error ?? null], ...ev }));
    expect(approved.status).toBe(200);
    expect(rejected.status).toBe(409);
    expect(rejected.body?.error).toBe(sequential.rejectIssued);
    expect(ev.invoice?.issued).toBe(true);
    expect(ev.invoice?.status).toBe("sent");
    expect(ev.items).toBe(1);
    expect(ev.glEntries).toHaveLength(1);
    expect(ev.audits, "no reject is recorded").toEqual(["approve:1", "create:1"]);
  }, 60_000);

  it("🔴 a DELETE queued behind an approval: the approval 200, the delete the sequential 409; the issued invoice survives with its lines and its entry", async () => {
    const inv = await draftInvoice(1_000);
    const [approved, deleted] = await queuedOnRow(inv.id,
      { send: () => approve("accountant", inv.id), waitsOn: `update "invoices"` },
      { send: () => del(inv.id), waitsOn: `delete from "invoices"` });
    const ev = await evidence(inv);
    // eslint-disable-next-line no-console
    console.warn("[G08 REG] delete behind approve", JSON.stringify({ approve: [approved.status], delete: [deleted.status, deleted.body?.error ?? null], ...ev }));
    expect(approved.status).toBe(200);
    expect(deleted.status).toBe(409);
    expect(deleted.body?.error).toBe(sequential.deleteIssued);
    expect(ev.invoice?.issued).toBe(true);
    expect(ev.items).toBe(1);
    expect(ev.glEntries).toHaveLength(1);
    expect(ev.audits, "no delete is recorded").toEqual(["approve:1", "create:1"]);
  }, 60_000);

  it("🔴 an approval that loses to a reject (the reject commits while the approval waits at the sequence lock): the reject 204, the approval 409; nothing issued — no entry, no ICV consumed", async () => {
    const before = await maxIcv();
    const inv = await draftInvoice(1_000);
    const holder = await pool.connect();
    let held = false;
    let approved!: Res;
    let rejected!: Res;
    try {
      await holder.query(`SELECT pg_advisory_lock(hashtextextended($1::text, 0))`, [companyId]);
      held = true;
      const approving = approve("admin", inv.id);
      await until("the approval did not reach the company sequence lock", async () => (await waitersOnSequenceLock()) >= 1);
      rejected = await reject("accountant", inv.id);
      expect(await waitersOnSequenceLock(), "the reject finished while the approval was still waiting").toBe(1);
      await holder.query(`SELECT pg_advisory_unlock(hashtextextended($1::text, 0))`, [companyId]);
      held = false;
      approved = await approving;
    } finally {
      if (held) await holder.query(`SELECT pg_advisory_unlock(hashtextextended($1::text, 0))`, [companyId]);
      holder.release();
    }
    const ev = await evidence(inv);
    // eslint-disable-next-line no-console
    console.warn("[G08 REG] approve after reject", JSON.stringify({ reject: [rejected.status], approve: [approved.status, approved.body?.code ?? null, approved.body?.error ?? null], icvBefore: before, icvAfter: await maxIcv(), ...ev }));
    expect(rejected.status).toBe(204);
    expect(approved.status).toBe(409);
    expect(approved.body?.error).toBe(REMOVED_WHILE_APPROVING);
    expect(ev.invoice).toBeNull();
    expect(ev.glEntries, "no entry for an invoice that no longer exists").toHaveLength(0);
    expect(await maxIcv(), "no ICV consumed").toBe(before);
    expect(ev.audits).toEqual(["create:1", "reject:1"]);
  }, 60_000);

  it("🔴 an approval that loses to a DELETE committing AFTER the approval re-read the invoice: the delete 204, the approval 409; nothing issued — no entry, no ICV consumed", async () => {
    const before = await maxIcv();
    const inv = await draftInvoice(1_000);
    // The delete queues on the row first; the approval passes the sequence lock
    // and its re-read (the row is still there, uncommitted delete), then queues
    // on its issuing update behind the delete.
    const [deleted, approved] = await queuedOnRow(inv.id,
      { send: () => del(inv.id), waitsOn: `delete from "invoices"` },
      { send: () => approve("accountant", inv.id), waitsOn: `update "invoices"` });
    const ev = await evidence(inv);
    // eslint-disable-next-line no-console
    console.warn("[G08 REG] approve behind delete", JSON.stringify({ delete: [deleted.status], approve: [approved.status, approved.body?.code ?? null, approved.body?.error ?? null], icvBefore: before, icvAfter: await maxIcv(), ...ev }));
    expect(deleted.status).toBe(204);
    expect(approved.status).toBe(409);
    expect(approved.body?.error).toBe(REMOVED_WHILE_APPROVING);
    expect(ev.invoice).toBeNull();
    expect(ev.glEntries, "no entry for an invoice that no longer exists").toHaveLength(0);
    expect(await maxIcv(), "no ICV consumed").toBe(before);
    expect(ev.audits).toEqual(["create:1", "delete:1"]);
  }, 60_000);

  it("UNFORCED: approve and reject fired together, round after round — never both succeed, never a 5xx; an approved invoice survives issued; the ICVs stay dense", async () => {
    const before = await maxIcv();
    const rounds: Array<{ total: number; approve: number; reject: number; exists: boolean; issued: boolean; gl: number }> = [];
    for (let i = 0; i < 8; i++) {
      const unitPrice = i % 2 === 0 ? 0 : 1_000;
      const inv = await draftInvoice(unitPrice);
      const [a, r] = await Promise.all([approve("admin", inv.id), reject("accountant", inv.id)]);
      const ev = await evidence(inv);
      rounds.push({ total: unitPrice, approve: a.status, reject: r.status, exists: ev.invoice != null, issued: ev.invoice?.issued ?? false, gl: ev.glEntries.length });
    }
    const missing = await missingIcvsAbove(before);
    // eslint-disable-next-line no-console
    console.warn("[G08 REG] unforced rounds", JSON.stringify({ rounds, icvBefore: before, missing }));
    for (const r of rounds) {
      expect(r.approve < 500 && r.reject < 500, JSON.stringify(r)).toBe(true);
      expect(r.approve < 300 && r.reject < 300, `never both: ${JSON.stringify(r)}`).toBe(false);
      expect(r.approve < 300 || r.reject < 300, `one of them wins: ${JSON.stringify(r)}`).toBe(true);
      if (r.approve < 300) expect([r.exists, r.issued, r.gl], JSON.stringify(r)).toEqual([true, true, r.total > 0 ? 1 : 0]);
      else expect([r.exists, r.gl], JSON.stringify(r)).toEqual([false, 0]);
    }
    expect(missing, "no ICV is lost").toEqual([]);
  }, 120_000);
});
