/**
 * PHASE 18 · S1-b · G65 PROOF — editing a line-bearing bill's HEADER totals,
 * then approving it. PROOF ONLY, NOT A FIX.
 *
 * Authorised by the owner on 2026-10-16 (Batch 4B). Definition: Phase 18
 * contract G65 (§11.2, §16.2 "PATCH a line-bearing bill's header; approve: GL,
 * input-VAT events and the VAT return agree") and the plan of 2026-10-16 §9.
 *
 * The mechanism (read at f480a569):
 *  - `billsService.update` (PATCH /bills/:id) stores `subtotal`, `vatAmount`
 *    and `total` verbatim even when the bill has lines; create recomputes them
 *    from the lines, and the spec says "with lines they are recomputed";
 *  - approval checks only that the header agrees with ITSELF
 *    (`subtotal + vatAmount = total`, bills.approvable.ts) and posts the HEADER
 *    to the GL and to the input-VAT events;
 *  - the VAT return sums the LINES when a bill has lines (reports.service.ts).
 *
 * FIX-NEUTRAL invariant (holds for "recompute on PATCH" and for "refuse header
 * totals on a bill with lines"): after the edit and the approval, the bill's
 * VAT in the GL = the sum of its line VAT = its input-VAT events = (when the
 * VAT is claimed) the VAT return's input VAT for the month; and the AP the GL
 * credits = the sum of its line totals. A CONTROL bill, never edited, shows
 * the four figures agree on the normal path and are non-zero.
 *
 * 🔴 Expected to FAIL while G65 exists. Untracked S1-b file — never merged red,
 * never weakened. Does NOT call the rate-limit reset hook. DB-backed.
 */

process.env.PORT ??= "3152";
process.env.SESSION_SECRET ??= "phase18-s1b-g65-proof-session-secret-0001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

const PW = "S1bG65ProofPw123!";

describeMaybe("Phase 18 S1-b · G65 proof — a bill's header edited after its lines, then approved", () => {
  const h = g04Harness("s1bg65");
  let orgId = "";
  let vendorId = 0;

  async function draftBill(no: string, date: string) {
    const created = await h.api("bookkeeper", "POST", "/bills", {
      supplierDocumentKind: "tax_invoice", vendorReference: `${no}-SUP`, billNumber: no, date, dueDate: date, vendorId,
      items: [{ description: "Office equipment service", quantity: 1, unitPrice: 1_000, vatRate: 15 }],
    });
    expect(created.status, `create bill: ${JSON.stringify(created.body)}`).toBe(201);
    return created.body.id as number;
  }

  /** The bill's VAT and AP, every way the product states them. `month` is the VAT-return month (YYYY-MM). */
  async function evidence(billId: number, no: string, month: string) {
    const bill = (await pool.query(
      `SELECT subtotal::text, vat_amount::text, total::text, status, input_vat_state FROM bills WHERE id = $1`, [billId],
    )).rows[0];
    const lines = (await pool.query(
      `SELECT coalesce(sum(vat_amount), 0)::text AS vat, coalesce(sum(total), 0)::text AS total FROM bill_items WHERE bill_id = $1`, [billId],
    )).rows[0];
    const gl = (await pool.query(
      `SELECT coalesce(sum(l.debit_amount - l.credit_amount) FILTER (WHERE c.system_code IN ('VAT_INPUT','VAT_AWAITING_EVIDENCE')), 0)::text AS vat,
              coalesce(sum(l.credit_amount - l.debit_amount) FILTER (WHERE c.system_code = 'AP'), 0)::text AS ap
         FROM journal_entry_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN categories c ON c.id = l.account_id
        WHERE e.organization_id = $1 AND e.status IN ('posted','reversed') AND e.entry_number = $2`, [orgId, `BILL-${no}`],
    )).rows[0];
    const events = (await pool.query(
      `SELECT coalesce(sum(amount), 0)::text AS amount, string_agg(DISTINCT to_bucket, ',') AS buckets FROM input_vat_events WHERE document_id = $1`, [billId],
    )).rows[0];
    const ret = await h.api("admin", "GET", `/reports/vat-return?period_from=${month}&period_to=${month}`);
    const box13 = Number(ret.body?.purchasesSection?.box13_recoverableInputVat ?? NaN);
    return {
      header: { subtotal: Number(bill.subtotal), vat: Number(bill.vat_amount), total: Number(bill.total) },
      status: bill.status as string, inputVatState: bill.input_vat_state as string | null,
      linesVat: Number(lines.vat), linesTotal: Number(lines.total),
      glVat: Number(gl.vat), glAp: Number(gl.ap),
      eventsAmount: Number(events.amount), eventBuckets: events.buckets as string | null,
      vatReturnStatus: ret.status, vatReturnBox13: box13,
    };
  }

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    await h.mkCompany(orgId, "S1b G65 Co", "318181818181843");
    vendorId = (await pool.query(
      `INSERT INTO vendors (organization_id, name, tax_number) VALUES ($1,'S1b G65 Supplier','300000000000003') RETURNING id`, [orgId],
    )).rows[0].id;
    await h.mkUser("admin", PW, orgId, "admin");
    await h.mkUser("bookkeeper", PW, orgId, "bookkeeper");
    await h.start();
    for (const who of ["admin", "bookkeeper"]) expect(await h.login(who, h.email(who), PW), `login ${who}`).toBe(200);
  }, 120_000);

  afterAll(async () => {
    await h.stop();
    await h.cleanup();
  });

  it("CONTROL (never edited): GL VAT = Σ line VAT = input-VAT events = the VAT return's input VAT; GL AP = Σ line totals — all non-zero", async () => {
    const id = await draftBill("S1BG65-CTRL", "2026-08-12");
    const approved = await h.api("admin", "POST", `/bills/${id}/approve`, {});
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    const ev = await evidence(id, "S1BG65-CTRL", "2026-08");
    // eslint-disable-next-line no-console
    console.warn("[S1B G65] CONTROL", JSON.stringify(ev));
    expect(ev.linesVat).toBe(150);
    expect(ev.glVat).toBe(150);
    expect(ev.eventsAmount).toBe(150);
    expect(ev.glAp).toBe(1_150);
    expect(ev.linesTotal).toBe(1_150);
    if (ev.inputVatState === "claimed") expect(ev.vatReturnBox13).toBe(150);
  });

  it("🔴 PROOF: after a header edit on a line-bearing bill and its approval, GL VAT = Σ line VAT = events = the return; GL AP = Σ line totals", async () => {
    const id = await draftBill("S1BG65-EDIT", "2026-09-10");
    // A self-consistent header that disagrees with the lines: 1,200 + 180 = 1,380 (lines: 1,000 + 150 = 1,150).
    const patched = await h.api("bookkeeper", "PATCH", `/bills/${id}`, { subtotal: 1_200, vatAmount: 180, total: 1_380 });
    const afterPatch = (await pool.query(`SELECT subtotal::text, vat_amount::text, total::text FROM bills WHERE id = $1`, [id])).rows[0];
    const approved = await h.api("admin", "POST", `/bills/${id}/approve`, {});
    const ev = await evidence(id, "S1BG65-EDIT", "2026-09");
    // eslint-disable-next-line no-console
    console.warn("[S1B G65] EDIT", JSON.stringify({ patch: [patched.status, patched.body?.code ?? null], storedAfterPatch: afterPatch, approve: [approved.status, approved.body?.code ?? null], ...ev }));
    if (patched.status >= 400 || approved.status >= 400) {
      // A fix that refuses the edit (or the approval) must leave the bill unposted, or posted from its lines.
      expect.soft(ev.glVat === 0 || ev.glVat === ev.linesVat, "nothing posted, or posted from the lines").toBe(true);
      return;
    }
    expect.soft(ev.glVat, "the VAT the GL posted = Σ line VAT").toBe(ev.linesVat);
    expect.soft(ev.eventsAmount, "the input-VAT events = Σ line VAT").toBe(ev.linesVat);
    expect.soft(ev.glAp, "the AP the GL credited = Σ line totals").toBe(ev.linesTotal);
    if (ev.inputVatState === "claimed") expect.soft(ev.vatReturnBox13, "the VAT return's input VAT for the month = the GL VAT").toBe(ev.glVat);
  }, 60_000);
});
