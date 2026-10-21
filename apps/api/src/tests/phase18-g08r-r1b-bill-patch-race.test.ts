/**
 * 🔴 PR B (bill half) — PROOF FIRST (owner decision 2.3, 2026-10-20/21): A BILL
 * PATCH RACING AN APPROVAL. Known-failing by design while the defect exists:
 * each assertion states the correct behaviour.
 *
 * `billsService.update` reads the bill without a lock, checks `draft`, then
 * writes keyed on id only; the approval posts the figures it LOADED, and its
 * status write is conditional on state only (PR A). Both orders, FORCED with
 * `helpers/g08rRace.ts` (a holder locks the bill row; each act is seen waiting
 * inside the holder's wait tree before the next is sent):
 *   1. a PATCH queued behind an approval — does the edit land on the posted bill?
 *   2. an approval queued behind a PATCH — does it post figures the bill no
 *      longer carries?
 * Correct, either way: a posted bill's stored total equals its posted entry,
 * and nothing answers 5xx. Soft assertions report every consequence.
 *
 * A HEADER-ONLY bill (no lines) is used so the edit is a plain header change,
 * independent of G65 (a header total sent for a bill WITH lines). Zero VAT,
 * so no input-VAT evidence is involved.
 *
 * DB-backed (sl_test); skips on the DB-free placeholder. Run through the pre-flight gate.
 */
process.env.PORT ??= "3179";
process.env.SESSION_SECRET ??= "g08r-r1b-bill-patch-race-proof-000000001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness } from "./helpers/g04Harness";
import { auditsOf, brief, queuedBehind } from "./helpers/g08rRace";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "G08rProofPw123!";
const DATE = "2026-10-05";
const EDIT = { subtotal: 9_999, vatAmount: 0, total: 9_999 };

describeMaybe("PR B (bill half) — a bill PATCH racing an approval", () => {
  const h = g04Harness("g08rr1b");
  let orgId = "";
  let vendorId = 0;
  let n = 0;
  type Bill = { id: number; no: string };

  async function draftBill(): Promise<Bill> {
    const no = `G08RR1B-BL-${String(++n).padStart(3, "0")}`;
    const r = await h.api("bookkeeper", "POST", "/bills", {
      supplierDocumentKind: "tax_invoice", vendorReference: `VR-${no}`, billNumber: no, date: DATE, dueDate: DATE, vendorId,
      subtotal: 1_000, vatAmount: 0, total: 1_000,
    });
    expect(r.status, `create ${no}: ${JSON.stringify(r.body)}`).toBe(201);
    return { id: r.body.id as number, no };
  }
  async function evidence(b: Bill) {
    const row = (await pool.query(`SELECT status, total::text FROM bills WHERE id = $1`, [b.id])).rows[0] ?? null;
    const gl = (await pool.query(
      `SELECT count(DISTINCT je.id)::int AS entries, coalesce(sum(l.debit_amount), 0)::text AS debits
         FROM journal_entries je JOIN journal_entry_lines l ON l.journal_entry_id = je.id
        WHERE je.organization_id = $1 AND je.entry_number = $2`, [orgId, `BILL-${b.no}`],
    )).rows[0] as { entries: number; debits: string };
    const posted = row ? !["draft", "submitted"].includes(row.status) : false;
    return { bill: row, posted, entries: gl.entries, glDebits: Number(gl.debits).toFixed(2), audits: await auditsOf(orgId, "bill", b.id) };
  }
  const approve = (id: number) => h.api("admin", "POST", `/bills/${id}/approve`, {});
  const patch = (id: number) => h.api("bookkeeper", "PATCH", `/bills/${id}`, EDIT);

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    await h.mkCompany(orgId, "G08R-R1B Co", "318181818181879");
    vendorId = (await pool.query(`INSERT INTO vendors (organization_id, name) VALUES ($1,'G08R-R1B Supplier') RETURNING id`, [orgId])).rows[0].id;
    for (const [who, role] of [["admin", "admin"], ["bookkeeper", "bookkeeper"]]) await h.mkUser(who, PW, orgId, role);
    await h.start();
    for (const who of ["admin", "bookkeeper"]) expect(await h.login(who, h.email(who), PW), `login ${who}`).toBe(200);
  }, 120_000);
  afterAll(async () => { await h.stop(); await h.cleanup(); });

  it("CONTROL (sequential): a PATCH changes a draft's total (the probe is not vacuous); a posted bill refuses a PATCH, and its total equals its entry", async () => {
    const d = await draftBill();
    const ed = await patch(d.id);
    expect(ed.status, JSON.stringify(ed.body)).toBe(200);
    expect((await evidence(d)).bill?.total, "the PATCH probe changes a draft's total").toBe("9999.00");
    const p = await draftBill();
    const ap = await approve(p.id);
    expect(ap.status, JSON.stringify(ap.body)).toBe(200);
    const refused = await patch(p.id);
    expect(refused.status).toBe(409);
    const ev = await evidence(p);
    expect([ev.posted, ev.entries, ev.bill?.total, ev.glDebits]).toEqual([true, 1, "1000.00", "1000.00"]);
  }, 60_000);

  it("🔴 a PATCH queued behind an approval: the approval 200, the PATCH 409; the posted bill's total stays 1,000.00 and equals its entry", async () => {
    const b = await draftBill();
    const [ap, ed] = await queuedBehind("bills", b.id, [() => approve(b.id), () => patch(b.id)]);
    const ev = await evidence(b);
    // eslint-disable-next-line no-console
    console.warn("[G08R-R1B] patch behind approve", JSON.stringify({ approve: brief(ap), patch: brief(ed), ...ev }));
    expect(ap.status).toBe(200);
    expect.soft(ed.status, "the PATCH that lost to the approval is refused").toBe(409);
    expect.soft(ev.posted).toBe(true);
    expect.soft([ev.bill?.total, ev.glDebits], "stored total = posted entry = the approved figure").toEqual(["1000.00", "1000.00"]);
    expect.soft(ev.entries, "one entry").toBe(1);
  }, 60_000);

  it("🔴 an approval queued behind a PATCH (the approval loaded the bill before the edit committed): whatever wins, a posted bill's stored total equals its entry, and nothing answers 5xx", async () => {
    const b = await draftBill();
    const [ed, ap] = await queuedBehind("bills", b.id, [() => patch(b.id), () => approve(b.id)]);
    const ev = await evidence(b);
    // eslint-disable-next-line no-console
    console.warn("[G08R-R1B] approve behind patch", JSON.stringify({ patch: brief(ed), approve: brief(ap), ...ev }));
    expect.soft([ed.status, ap.status].every((s) => s < 500), "never a 5xx").toBe(true);
    if (ev.posted) {
      expect.soft(ev.glDebits, "the posted entry carries the bill's stored total — never figures from before the edit").toBe(ev.bill?.total);
      expect.soft(ev.entries, "one entry").toBe(1);
    }
  }, 60_000);
});
