/**
 * 🔴 B-G08R-P (R1) — PROOF ONLY (owner-approved 2026-10-18): A PATCH RACING AN
 * APPROVAL DIRECTLY (G08 (c)). Known-failing by design while a defect exists:
 * each assertion states the correct behaviour.
 *
 * Residual R1 (register DR-49): issuance stamps the totals, the hash input and
 * the posted entry from the row it LOADED before the lock; the G08 re-read
 * checks state only. And `invoicesService.update` writes keyed on id only.
 * Both orders, FORCED (`helpers/g08rRace.ts`), on a non-onboarded company:
 *   1. a PATCH queued behind an approval — does the edit land on the issued invoice?
 *   2. an approval queued behind a PATCH — are stale figures issued?
 * Correct, either way: an issued invoice's lines, its stored total and its
 * posted entry agree. Soft assertions report every consequence.
 *
 * DB-backed (sl_test); skips on the DB-free placeholder. Run through the pre-flight gate.
 */
process.env.PORT ??= "3178";
process.env.SESSION_SECRET ??= "g08r-r1-patch-race-proof-0000000000000001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness } from "./helpers/g04Harness";
import { auditsOf, brief, queuedBehind } from "./helpers/g08rRace";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "G08rProofPw123!";
const EDIT = { items: [{ description: "Edited", quantity: 1, unitPrice: 9_999, vatRate: 15 }] };

describeMaybe("B-G08R-P (R1) — a PATCH racing an approval", () => {
  const h = g04Harness("g08rr1");
  let orgId = "";
  let customerId = 0;
  let n = 0;
  type Inv = { id: number; no: string };

  async function draftInvoice(): Promise<Inv> {
    const no = `G08RR1-INV-${String(++n).padStart(3, "0")}`;
    const r = await h.api("bookkeeper", "POST", "/invoices", { invoiceNumber: no, date: "2026-10-05", customerId, items: [{ description: "Service", quantity: 1, unitPrice: 1_000, vatRate: 15 }] });
    expect(r.status, `create ${no}: ${JSON.stringify(r.body)}`).toBe(201);
    return { id: r.body.id as number, no };
  }
  async function evidence(inv: Inv) {
    const row = (await pool.query(`SELECT status, icv, (invoice_hash IS NOT NULL) AS issued, total::text FROM invoices WHERE id = $1`, [inv.id])).rows[0] ?? null;
    const items = (await pool.query(`SELECT description, total::text AS total FROM invoice_items WHERE invoice_id = $1 ORDER BY id`, [inv.id])).rows;
    const gl = (await pool.query(
      `SELECT coalesce(sum(l.debit_amount), 0)::text AS debits FROM journal_entries je JOIN journal_entry_lines l ON l.journal_entry_id = je.id
        WHERE je.organization_id = $1 AND je.entry_number = $2`, [orgId, `GL-${inv.no}`],
    )).rows[0].debits as string;
    const linesTotal = items.reduce((s: number, i: { total: string }) => s + Number(i.total), 0).toFixed(2);
    return { invoice: row, items: items.map((i: { description: string }) => i.description), linesTotal, glDebits: gl, audits: await auditsOf(orgId, "invoice", inv.id) };
  }
  const approve = (id: number) => h.api("admin", "POST", `/invoices/${id}/approve`, {});
  const patch = (id: number) => h.api("bookkeeper", "PATCH", `/invoices/${id}`, EDIT);

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    await h.mkCompany(orgId, "G08R-R1 Co", "318181818181878");
    customerId = (await pool.query(`INSERT INTO customers (organization_id, name, tax_number) VALUES ($1,'G08R-R1 Buyer','300000000000003') RETURNING id`, [orgId])).rows[0].id;
    for (const [who, role] of [["admin", "admin"], ["bookkeeper", "bookkeeper"]]) await h.mkUser(who, PW, orgId, role);
    await h.start();
    for (const who of ["admin", "bookkeeper"]) expect(await h.login(who, h.email(who), PW), `login ${who}`).toBe(200);
  }, 120_000);
  afterAll(async () => { await h.stop(); await h.cleanup(); });

  it("CONTROL (sequential): a PATCH changes a draft (lines, stored total); an issued invoice refuses a PATCH, and its lines, total and entry agree", async () => {
    const d = await draftInvoice();
    expect((await patch(d.id)).status).toBe(200);
    const ed = await evidence(d);
    expect([ed.invoice?.total, ed.linesTotal, ed.items]).toEqual(["11498.85", "11498.85", ["Edited"]]);
    const i = await draftInvoice();
    expect((await approve(i.id)).status).toBe(200);
    expect((await patch(i.id)).status).toBe(409);
    const ei = await evidence(i);
    expect([ei.invoice?.total, ei.linesTotal, ei.glDebits]).toEqual(["1150.00", "1150.00", "1150.00"]);
  }, 60_000);

  it("🔴 R1 — a PATCH queued behind an approval: the approval 200, the PATCH 409; the issued lines, total and entry agree at 1,150.00", async () => {
    const inv = await draftInvoice();
    const [ap, ed] = await queuedBehind("invoices", inv.id, [() => approve(inv.id), () => patch(inv.id)]);
    const ev = await evidence(inv);
    // eslint-disable-next-line no-console
    console.warn("[G08R-R1] patch behind approve", JSON.stringify({ approve: brief(ap), patch: brief(ed), ...ev }));
    expect(ap.status).toBe(200);
    expect.soft(ed.status, "the PATCH that lost to the approval is refused").toBe(409);
    expect.soft(ev.invoice?.issued).toBe(true);
    expect.soft(ev.items, "the issued lines are unchanged").toEqual(["Service"]);
    expect.soft([ev.invoice?.total, ev.linesTotal, ev.glDebits], "stored total = lines = posted entry").toEqual(["1150.00", "1150.00", "1150.00"]);
  }, 60_000);

  it("🔴 R1 — an approval queued behind a PATCH (the approval loaded the invoice before the edit committed): whatever wins, the issued lines, stored total and posted entry agree", async () => {
    const inv = await draftInvoice();
    const [ed, ap] = await queuedBehind("invoices", inv.id, [() => patch(inv.id), () => approve(inv.id)]);
    const ev = await evidence(inv);
    // eslint-disable-next-line no-console
    console.warn("[G08R-R1] approve behind patch", JSON.stringify({ patch: brief(ed), approve: brief(ap), ...ev }));
    expect.soft([ed.status, ap.status].every((s) => s < 500), "never a 5xx").toBe(true);
    if (ev.invoice?.issued) {
      expect.soft(ev.invoice?.total, "the stored total equals its lines").toBe(ev.linesTotal);
      expect.soft(ev.glDebits, "the posted entry carries the issued invoice's total — never figures from before the edit").toBe(ev.invoice?.total);
    }
  }, 60_000);
});
