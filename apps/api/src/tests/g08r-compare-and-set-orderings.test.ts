/**
 * 🔴 G08 residuals, PR A — the OTHER ORDERING of every race, and unforced rounds.
 *
 * The B-G08R-P proofs (`phase18-g08r-*.test.ts`) pin the loser that queues
 * BEHIND an approval. This file pins the loser on the other side: the record
 * left the state the engine checked before the losing act's conditional write
 * ran, so that write matches nothing and the act answers 409 and rolls back
 * whole — no entry posted, no audit row, nothing half-written.
 *
 *  - an approval behind a reject or a DELETE: the record is gone;
 *  - an approval behind a send-back or a submit: the record moved to another
 *    unapproved state — "changed while it was being approved";
 *  - a reject behind a send-back: "changed while it was being rejected";
 *  - a submit or send-back behind a reject: the record is gone;
 *  - unforced rounds: approve and reject fired together.
 *
 * Every race is FORCED with `helpers/g08rRace.ts` (a holder locks the row; each
 * act is seen waiting on a lock before the next is sent). Real HTTP, the real
 * app, the real database. DB-backed; skips on the DB-free placeholder.
 */
process.env.PORT ??= "3181";
process.env.SESSION_SECRET ??= "g08r-cas-orderings-regression-000000001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness } from "./helpers/g04Harness";
import { auditsOf, brief, entriesNumbered, queuedBehind } from "./helpers/g08rRace";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "G08rCasPw123!";
const DATE = "2026-10-05";

type Kind = "invoice" | "bill" | "je" | "payroll";
const TABLE: Record<Kind, string> = { invoice: "invoices", bill: "bills", je: "journal_entries", payroll: "payroll_runs" };
const ROUTE: Record<Kind, string> = { invoice: "/invoices", bill: "/bills", je: "/journal-entries", payroll: "/payroll" };
const ENTITY: Record<Kind, string> = { invoice: "invoice", bill: "bill", je: "journal_entry", payroll: "payroll_run" };
const NOUN: Record<Kind, string> = { invoice: "invoice", bill: "bill", je: "journal entry", payroll: "payroll run" };
const changed = (k: Kind, act: "approved" | "rejected") => `This ${NOUN[k]} changed while it was being ${act}. Nothing was changed — reload and try again.`;
const goneWhileApproving = (k: Kind) => `This ${NOUN[k]} was rejected or deleted while it was being approved — nothing was ${k === "invoice" ? "issued" : "posted"}.`;
const goneAlready = (k: Kind) => `This ${NOUN[k]} was already rejected or deleted by another action.`;

describeMaybe("G08 residuals, PR A — the other ordering of every race, and unforced rounds", () => {
  const h = g04Harness("g08rcas1");
  let orgId = "";
  let customerId = 0;
  let vendorId = 0;
  let debitAccount = 0;
  let creditAccount = 0;
  let n = 0;
  let month = 0;
  const next = () => String(++n).padStart(3, "0");

  /** A draft of each kind, with the entry number its approval posts under. */
  async function draft(k: Kind): Promise<{ id: number; entry: string }> {
    if (k === "invoice") {
      const no = `CAS1-INV-${next()}`;
      const r = await h.api("bookkeeper", "POST", "/invoices", { invoiceNumber: no, date: DATE, customerId, items: [{ description: "Service", quantity: 1, unitPrice: 100, vatRate: 15 }] });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return { id: r.body.id, entry: `GL-${no}` };
    }
    if (k === "bill") {
      const no = `CAS1-BL-${next()}`;
      const r = await h.api("bookkeeper", "POST", "/bills", { supplierDocumentKind: "tax_invoice", vendorReference: `VR-${no}`, billNumber: no, date: DATE, dueDate: DATE, vendorId, items: [{ description: "Supply", quantity: 1, unitPrice: 100, vatRate: 0 }] });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return { id: r.body.id, entry: `BILL-${no}` };
    }
    if (k === "je") {
      const no = `CAS1-JE-${next()}`;
      const r = await h.api("bookkeeper", "POST", "/journal-entries", { entryNumber: no, date: DATE, description: "PR A", lines: [
        { accountId: debitAccount, accountName: "debit", debitAmount: 10, creditAmount: 0 },
        { accountId: creditAccount, accountName: "credit", debitAmount: 0, creditAmount: 10 },
      ] });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return { id: r.body.id, entry: no };
    }
    const period = `2023-${String((month++ % 12) + 1).padStart(2, "0")}`;
    const r = await h.api("bookkeeper", "POST", "/payroll", { period });
    expect([200, 201], JSON.stringify(r.body)).toContain(r.status);
    return { id: r.body.id, entry: `PAY-${period}-R${r.body.id}` };
  }
  const act = {
    approve: (k: Kind, id: number) => () => h.api("admin", "POST", `${ROUTE[k]}/${id}/approve`, {}),
    reject: (k: Kind, id: number) => () => h.api("accountant", "POST", `${ROUTE[k]}/${id}/reject`, {}),
    del: (k: Kind, id: number) => () => h.api("admin", "DELETE", `${ROUTE[k]}/${id}`),
    submit: (k: Kind, id: number) => () => h.api("bookkeeper", "POST", `${ROUTE[k]}/${id}/submit`, {}),
    sendBack: (k: Kind, id: number) => () => h.api("accountant", "POST", `${ROUTE[k]}/${id}/send-back`, { note: "correct it" }),
  };
  const statusOf = async (k: Kind, id: number) => ((await pool.query(`SELECT status FROM "${TABLE[k]}" WHERE id = $1`, [id])).rows[0]?.status as string | undefined) ?? null;
  const posted = async (entry: string) => (await entriesNumbered(orgId, entry)).length;
  const log = (label: string, data: unknown) => console.warn(`[G08R-CAS1] ${label}`, JSON.stringify(data)); // eslint-disable-line no-console

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    const companyId = await h.mkCompany(orgId, "CAS1 Co", "318181818181881");
    customerId = (await pool.query(`INSERT INTO customers (organization_id, name, tax_number) VALUES ($1,'CAS1 Buyer','300000000000003') RETURNING id`, [orgId])).rows[0].id;
    vendorId = (await pool.query(`INSERT INTO vendors (organization_id, name) VALUES ($1,'CAS1 Supplier') RETURNING id`, [orgId])).rows[0].id;
    const accountOf = async (code: string) => Number((await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = $2 AND is_posting`, [orgId, code])).rows[0].id);
    debitAccount = await accountOf("RENT_UTILITIES");
    creditAccount = await accountOf("OTHER_INCOME");
    await pool.query(`INSERT INTO employees (organization_id, company_id, employee_number, name, nationality, basic_salary, status, gosi_regime) VALUES ($1,$2,'E1','CAS1 Employee','SA','8000.00','active','law_1421h')`, [orgId, companyId]);
    for (const [who, role] of [["admin", "admin"], ["accountant", "accountant"], ["bookkeeper", "bookkeeper"]]) await h.mkUser(who, PW, orgId, role);
    await h.start();
    for (const who of ["admin", "accountant", "bookkeeper"]) expect(await h.login(who, h.email(who), PW), `login ${who}`).toBe(200);
  }, 120_000);
  afterAll(async () => { await h.stop(); await h.cleanup(); });

  for (const k of ["invoice", "bill", "je", "payroll"] as const) {
    it(`${k.toUpperCase()} — an approval behind a REJECT: the reject 204, the approval 409 "rejected or deleted while it was being approved"; nothing posted, nothing recorded for the approval`, async () => {
      const d = await draft(k);
      const [rej, ap] = await queuedBehind(TABLE[k], d.id, [act.reject(k, d.id), act.approve(k, d.id)]);
      const audits = await auditsOf(orgId, ENTITY[k], d.id);
      log(`${k} approve behind reject`, { reject: brief(rej), approve: brief(ap), audits, posted: await posted(d.entry) });
      expect(rej.status).toBe(204);
      expect(ap.status).toBe(409);
      expect(ap.body?.error).toBe(goneWhileApproving(k));
      expect(await statusOf(k, d.id)).toBeNull();
      expect(await posted(d.entry), "the losing approval posted nothing").toBe(0);
      expect(audits.filter((a) => a.startsWith("approve:")), "no approval is recorded").toEqual([]);
    }, 60_000);
  }

  for (const k of ["bill", "je"] as const) {
    it(`${k.toUpperCase()} — an approval behind a DELETE: the delete 204, the approval 409; nothing posted`, async () => {
      const d = await draft(k);
      const [del, ap] = await queuedBehind(TABLE[k], d.id, [act.del(k, d.id), act.approve(k, d.id)]);
      log(`${k} approve behind delete`, { delete: brief(del), approve: brief(ap), posted: await posted(d.entry) });
      expect(del.status).toBe(204);
      expect(ap.status).toBe(409);
      expect(ap.body?.error).toBe(goneWhileApproving(k));
      expect(await posted(d.entry)).toBe(0);
    }, 60_000);
  }

  for (const k of ["invoice", "bill", "payroll"] as const) {
    it(`${k.toUpperCase()} — an approval (from submitted) behind a SEND-BACK: the send-back 200, the approval 409 "changed while it was being approved"; the record is a draft again, nothing posted`, async () => {
      const d = await draft(k);
      expect((await act.submit(k, d.id)()).status).toBe(200);
      const [back, ap] = await queuedBehind(TABLE[k], d.id, [act.sendBack(k, d.id), act.approve(k, d.id)]);
      log(`${k} approve behind send-back`, { sendBack: brief(back), approve: brief(ap), status: await statusOf(k, d.id), posted: await posted(d.entry) });
      expect(back.status).toBe(200);
      expect(ap.status).toBe(409);
      expect(ap.body?.error).toBe(changed(k, "approved"));
      expect(await statusOf(k, d.id)).toBe("draft");
      expect(await posted(d.entry)).toBe(0);
    }, 60_000);

    it(`${k.toUpperCase()} — a REJECT (from submitted) behind a SEND-BACK: the send-back 200, the reject 409 "changed while it was being rejected"; the record survives as a draft`, async () => {
      const d = await draft(k);
      expect((await act.submit(k, d.id)()).status).toBe(200);
      const [back, rej] = await queuedBehind(TABLE[k], d.id, [act.sendBack(k, d.id), act.reject(k, d.id)]);
      log(`${k} reject behind send-back`, { sendBack: brief(back), reject: brief(rej), status: await statusOf(k, d.id) });
      expect(back.status).toBe(200);
      expect(rej.status).toBe(409);
      expect(rej.body?.error).toBe(changed(k, "rejected"));
      expect(await statusOf(k, d.id)).toBe("draft");
      expect((await auditsOf(orgId, ENTITY[k], d.id)).filter((a) => a.startsWith("reject:"))).toEqual([]);
    }, 60_000);

    it(`${k.toUpperCase()} — a SUBMIT behind a REJECT, and a SEND-BACK behind a REJECT: each 409 "already rejected or deleted by another action"`, async () => {
      const a = await draft(k);
      const [rej1, sub] = await queuedBehind(TABLE[k], a.id, [act.reject(k, a.id), act.submit(k, a.id)]);
      const b = await draft(k);
      expect((await act.submit(k, b.id)()).status).toBe(200);
      const [rej2, back] = await queuedBehind(TABLE[k], b.id, [act.reject(k, b.id), act.sendBack(k, b.id)]);
      log(`${k} submit/send-back behind reject`, { reject1: brief(rej1), submit: brief(sub), reject2: brief(rej2), sendBack: brief(back) });
      expect([rej1.status, rej2.status]).toEqual([204, 204]);
      expect([sub.status, back.status]).toEqual([409, 409]);
      expect([sub.body?.error, back.body?.error]).toEqual([goneAlready(k), goneAlready(k)]);
    }, 60_000);
  }

  it("INVOICE — an approval (from draft) behind a SUBMIT: the submit 200, the approval 409 \"changed while it was being approved\"; nothing issued", async () => {
    const d = await draft("invoice");
    const [sub, ap] = await queuedBehind("invoices", d.id, [act.submit("invoice", d.id), act.approve("invoice", d.id)]);
    const row = (await pool.query(`SELECT status, icv, invoice_hash FROM invoices WHERE id = $1`, [d.id])).rows[0];
    log("invoice approve behind submit", { submit: brief(sub), approve: brief(ap), row });
    expect(sub.status).toBe(200);
    expect(ap.status).toBe(409);
    expect(ap.body?.error).toBe(changed("invoice", "approved"));
    expect([row.status, row.icv, row.invoice_hash]).toEqual(["submitted", null, null]);
    expect(await posted(d.entry)).toBe(0);
  }, 60_000);

  for (const k of ["bill", "je", "payroll"] as const) {
    it(`${k.toUpperCase()} — UNFORCED: approve and reject fired together, round after round — never both succeed, never a 5xx; an approved record keeps its one entry, a rejected one leaves none`, async () => {
      const rounds: Array<{ approve: number; reject: number; exists: boolean; posted: number }> = [];
      for (let i = 0; i < 6; i++) {
        const d = await draft(k);
        const [ap, rej] = await Promise.all([act.approve(k, d.id)(), act.reject(k, d.id)()]);
        rounds.push({ approve: ap.status, reject: rej.status, exists: (await statusOf(k, d.id)) != null, posted: await posted(d.entry) });
      }
      log(`${k} unforced`, rounds);
      for (const r of rounds) {
        expect(r.approve < 500 && r.reject < 500, JSON.stringify(r)).toBe(true);
        expect(r.approve < 300 && r.reject < 300, `never both: ${JSON.stringify(r)}`).toBe(false);
        expect(r.approve < 300 || r.reject < 300, `one wins: ${JSON.stringify(r)}`).toBe(true);
        if (r.approve < 300) expect([r.exists, r.posted], JSON.stringify(r)).toEqual([true, 1]);
        else expect([r.exists, r.posted], JSON.stringify(r)).toEqual([false, 0]);
      }
    }, 120_000);
  }
});
