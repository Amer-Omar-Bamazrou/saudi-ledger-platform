/**
 * 🔴 B-G08R-P (a) — PROOF ONLY (owner-approved 2026-10-18). Known-failing BY DESIGN
 * while the defect exists: every assertion states the CORRECT behaviour, so a red
 * test is the evidence. No product code is changed by this file.
 *
 * Residual R2 (register DR-49): the invoice adapter's `onSubmit` and `onSendBack`
 * update the status UNCONDITIONALLY (`invoicesRepository.update`, keyed on id
 * only), while only issuance (`markIssued`) and removal (`removeUnissued`) are
 * conditional on the invoice still being unissued. So a submit or a send-back
 * that loaded the invoice before an approval committed, and queued on its row
 * behind that approval, would set an ISSUED invoice (hash, ICV, posted entry)
 * back to `submitted` or `draft`. `PATCH /invoices/:id` checks only
 * `status === "draft"`, so the issued invoice could then be EDITED.
 *
 * The questions, each asked with a FORCED interleaving (the QA-11 pattern of
 * `g08-invoice-approval-race.test.ts`): a holder locks the invoice row; the
 * approval is seen waiting on its issuing UPDATE, then the second act on its
 * own UPDATE; the holder commits and the queue runs in that order.
 *   1. Can a send-back queued behind an approval return the issued invoice to
 *      `draft`, and can PATCH then edit it?
 *   2. Can a submit queued behind an approval return it to `submitted`, and can
 *      a following send-back and PATCH then edit it?
 * Soft assertions, so every consequence is reported, not only the first.
 *
 * DB-backed (sl_test); skips on the DB-free placeholder. Run through the pre-flight gate.
 */

process.env.PORT ??= "3171";
process.env.SESSION_SECRET ??= "g08r-a-status-revert-proof-000000001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness, type Res } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

const PW = "G08rProofPw123!";
const EDIT = { items: [{ description: "Edited after issue", quantity: 1, unitPrice: 9_999, vatRate: 15 }] };

describeMaybe("B-G08R-P (a) — a submit or send-back queued behind an approval, then a PATCH", () => {
  const h = g04Harness("g08ra");
  let orgId = "";
  let companyId = "";
  let customerId = 0;
  let seq = 0;
  const sequential = { submitIssued: "", sendBackIssued: "", patchIssued: "" };

  type Inv = { id: number; no: string };

  async function draftInvoice(unitPrice = 1_000): Promise<Inv> {
    seq += 1;
    const no = `G08RA-INV-${String(seq).padStart(3, "0")}`;
    const created = await h.api("bookkeeper", "POST", "/invoices", {
      invoiceNumber: no, date: "2026-10-05", customerId,
      items: [{ description: "Service", quantity: 1, unitPrice, vatRate: 15 }],
    });
    expect(created.status, `create invoice ${no}: ${JSON.stringify(created.body)}`).toBe(201);
    return { id: created.body.id as number, no };
  }

  async function evidence(inv: Inv) {
    const row = (await pool.query(
      `SELECT status, icv, (invoice_hash IS NOT NULL) AS issued, invoice_hash, subtotal::text, vat_amount::text, total::text FROM invoices WHERE id = $1`, [inv.id],
    )).rows[0] ?? null;
    const items = (await pool.query(`SELECT description, unit_price::text AS unit_price FROM invoice_items WHERE invoice_id = $1 ORDER BY id`, [inv.id])).rows;
    const gl = (await pool.query(
      `SELECT je.id, je.status, coalesce(sum(l.debit_amount), 0)::text AS debits
         FROM journal_entries je LEFT JOIN journal_entry_lines l ON l.journal_entry_id = je.id
        WHERE je.organization_id = $1 AND je.entry_number = $2 GROUP BY je.id, je.status`, [orgId, `GL-${inv.no}`],
    )).rows;
    const audits = (await pool.query(
      `SELECT action, count(*)::int AS n FROM audit_logs WHERE organization_id = $1 AND entity_type = 'invoice' AND entity_id = $2 GROUP BY action ORDER BY action`,
      [orgId, String(inv.id)],
    )).rows.map((r) => `${r.action}:${r.n}`);
    return { invoice: row, inBooks: row ? ["sent", "paid"].includes(row.status) : false, items, gl, audits };
  }

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

  /** Acts queued on the invoice ROW in the given order; the holder then commits and they run in that order. */
  async function queuedOnRow(id: number, acts: Array<{ send: () => Promise<Res>; waitsOn: string }>): Promise<Res[]> {
    const holder = await pool.connect();
    let open = false;
    try {
      await holder.query("BEGIN");
      open = true;
      await holder.query(`SELECT id FROM invoices WHERE id = $1 FOR UPDATE`, [id]);
      const sent: Promise<Res>[] = [];
      const queued = new Map<string, number>();
      for (const act of acts) {
        sent.push(act.send());
        const n = (queued.get(act.waitsOn) ?? 0) + 1;
        queued.set(act.waitsOn, n);
        await until(`act ${sent.length} did not queue on ${act.waitsOn}`, async () => (await waitingOn(act.waitsOn)) >= n);
      }
      await holder.query("COMMIT");
      open = false;
      return await Promise.all(sent);
    } finally {
      if (open) await holder.query("ROLLBACK");
      holder.release();
    }
  }

  const approve = (id: number) => h.api("admin", "POST", `/invoices/${id}/approve`, {});
  const submit = (id: number) => h.api("bookkeeper", "POST", `/invoices/${id}/submit`, {});
  const sendBack = (id: number) => h.api("accountant", "POST", `/invoices/${id}/send-back`, { note: "please correct" });
  const patch = (id: number) => h.api("bookkeeper", "PATCH", `/invoices/${id}`, EDIT);
  const brief = (r: Res) => [r.status, r.body?.code ?? null, r.body?.error ?? null];

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    companyId = await h.mkCompany(orgId, "G08R-a Co", "318181818181871");
    customerId = (await pool.query(
      `INSERT INTO customers (organization_id, name, tax_number) VALUES ($1,'G08R-a Buyer','300000000000003') RETURNING id`, [orgId],
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

  it("CONTROL (sequential): each act works on its own, the PATCH probe can see an edit, and an ISSUED invoice refuses submit, send-back and PATCH", async () => {
    const a = await draftInvoice();
    expect((await submit(a.id)).status, "a draft submits").toBe(200);
    expect((await sendBack(a.id)).status, "a submitted invoice is sent back").toBe(200);
    expect((await evidence(a)).invoice?.status).toBe("draft");
    const edited = await patch(a.id);
    expect(edited.status, `a draft is editable: ${JSON.stringify(edited.body)}`).toBe(200);
    expect((await evidence(a)).invoice?.total, "anti-vacuity: the PATCH probe really changes a draft's total").toBe("11498.85");

    const issued = await draftInvoice();
    expect((await approve(issued.id)).status).toBe(200);
    const before = await evidence(issued);
    const s = await submit(issued.id);
    const b = await sendBack(issued.id);
    const p = await patch(issued.id);
    expect([s.status, b.status, p.status]).toEqual([409, 409, 409]);
    expect(await evidence(issued), "the issued invoice is untouched by the three refusals").toEqual(before);
    sequential.submitIssued = s.body?.error;
    sequential.sendBackIssued = b.body?.error;
    sequential.patchIssued = p.body?.error;
  });

  it("🔴 R2 — a SEND-BACK queued behind an approval: the approval 200, the send-back the sequential 409; the issued invoice stays `sent` and cannot then be edited", async () => {
    const inv = await draftInvoice();
    expect((await submit(inv.id)).status).toBe(200);
    const [approved, sentBack] = await queuedOnRow(inv.id, [
      { send: () => approve(inv.id), waitsOn: `update "invoices"` },
      { send: () => sendBack(inv.id), waitsOn: `update "invoices"` },
    ]);
    const afterRace = await evidence(inv);
    const edit = await patch(inv.id);
    const afterPatch = await evidence(inv);
    // EVIDENCE ONLY (not asserted): can the invoice, in whatever state the race left it, be issued again, rejected or deleted?
    const recovery = { approveAgain: brief(await approve(inv.id)), reject: brief(await h.api("accountant", "POST", `/invoices/${inv.id}/reject`, {})), del: brief(await h.api("admin", "DELETE", `/invoices/${inv.id}`)) };
    const afterRecovery = await evidence(inv);
    // eslint-disable-next-line no-console
    console.warn("[G08R-a] send-back behind approve", JSON.stringify({ approve: brief(approved), sendBack: brief(sentBack), afterRace, patch: brief(edit), afterPatch, recovery, afterRecovery }));

    expect(approved.status).toBe(200);
    expect.soft(sentBack.status, "the send-back that lost to the approval").toBe(409);
    expect.soft(sentBack.body?.error, "the loser gets the sequential refusal").toBe(sequential.sendBackIssued);
    expect.soft(afterRace.invoice?.issued, "the invoice is issued (hash present)").toBe(true);
    expect.soft(afterRace.invoice?.status, "an ISSUED invoice stays `sent`, never `draft`").toBe("sent");
    expect.soft(afterRace.inBooks, "the issued invoice stays in the books (sent/paid)").toBe(true);
    expect.soft(edit.status, "PATCH of the issued invoice is refused").toBe(409);
    expect.soft(afterPatch.invoice?.total, "the issued total is unchanged").toBe(afterRace.invoice?.total);
    expect.soft(afterPatch.items.map((i: { description: string }) => i.description), "the issued lines are unchanged").toEqual(["Service"]);
    expect.soft(afterPatch.gl.map((g: { debits: string }) => g.debits), "the posted entry still carries the invoice's total").toEqual([afterPatch.invoice?.total]);
    expect.soft(afterPatch.audits.filter((a: string) => a.startsWith("send_back") || a.startsWith("update")), "no send-back or edit is recorded on the issued invoice").toEqual([]);
  }, 60_000);

  it("🔴 R2 — a SUBMIT queued behind an approval (from draft): the approval 200, the submit the sequential 409; the issued invoice stays `sent`, and a following send-back and PATCH are refused", async () => {
    const inv = await draftInvoice();
    const [approved, submitted] = await queuedOnRow(inv.id, [
      { send: () => approve(inv.id), waitsOn: `update "invoices"` },
      { send: () => submit(inv.id), waitsOn: `update "invoices"` },
    ]);
    const afterRace = await evidence(inv);
    const back = await sendBack(inv.id);
    const afterSendBack = await evidence(inv);
    const edit = await patch(inv.id);
    const afterPatch = await evidence(inv);
    // eslint-disable-next-line no-console
    console.warn("[G08R-a] submit behind approve", JSON.stringify({ approve: brief(approved), submit: brief(submitted), afterRace, sendBack: brief(back), afterSendBack, patch: brief(edit), afterPatch }));

    expect(approved.status).toBe(200);
    expect.soft(submitted.status, "the submit that lost to the approval").toBe(409);
    expect.soft(submitted.body?.error, "the loser gets the sequential refusal").toBe(sequential.submitIssued);
    expect.soft(afterRace.invoice?.issued).toBe(true);
    expect.soft(afterRace.invoice?.status, "an ISSUED invoice stays `sent`, never `submitted`").toBe("sent");
    expect.soft(afterRace.inBooks, "the issued invoice stays in the books (sent/paid)").toBe(true);
    expect.soft(back.status, "a later send-back of the issued invoice is refused").toBe(409);
    expect.soft(afterSendBack.invoice?.status).toBe("sent");
    expect.soft(edit.status, "PATCH of the issued invoice is refused").toBe(409);
    expect.soft(afterPatch.invoice?.total, "the issued total is unchanged").toBe(afterRace.invoice?.total);
    expect.soft(afterPatch.gl.map((g: { debits: string }) => g.debits), "the posted entry still carries the invoice's total").toEqual([afterPatch.invoice?.total]);
  }, 60_000);
});
