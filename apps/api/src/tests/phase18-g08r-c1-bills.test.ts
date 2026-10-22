/**
 * 🔴 B-G08R-P (c1) — PROOF ONLY (owner-approved 2026-10-18), BILLS. Known-failing
 * by design while a defect exists: each assertion states the correct behaviour.
 *
 * Residual R3 (register DR-49). The bill adapter was left unchanged by the G08
 * fix: `onSubmit`/`onSendBack` update the status keyed on id only, `hardDelete`
 * deletes keyed on id only, and `deleteDraft` checks the status, then deletes.
 * Forced with `helpers/g08rRace.ts`: two approvals at once; a reject, a DELETE,
 * a send-back and a submit, each queued behind an approval. The loser should
 * get the refusal it gets sequentially (the CONTROL captures it), and the
 * posted bill should survive intact. Soft assertions report every consequence.
 *
 * DB-backed (sl_test); skips on the DB-free placeholder. Run through the pre-flight gate.
 */
process.env.PORT ??= "3174";
process.env.SESSION_SECRET ??= "g08r-c1-bills-proof-000000000000000001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness } from "./helpers/g04Harness";
import { auditsOf, brief, entriesNumbered, queuedBehind, statuses } from "./helpers/g08rRace";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "G08rProofPw123!";
const DATE = "2026-10-05";
// A bill's PATCH edits its header (the allowlist in billsService.update), not its lines. RE-POINTED 2026-10-21 with
// G65 (owner decision DR-07(b)): a LINED bill's header totals now follow its lines, so the totals below no longer
// change a draft; the probe carries a `notes` edit, which a draft still takes, and the control checks that instead.
const PROBE_NOTE = "EDITED BY THE PATCH PROBE";
const EDIT = { subtotal: 9_999, vatAmount: 0, total: 9_999, notes: PROBE_NOTE };

describeMaybe("B-G08R-P (c1) — the G08 races on BILLS", () => {
  const h = g04Harness("g08rc1");
  let orgId = "";
  let vendorId = 0;
  let n = 0;
  const seqMsg: Record<string, string> = {};
  type Bill = { id: number; no: string };

  async function draftBill(): Promise<Bill> {
    const no = `G08RC1-BL-${String(++n).padStart(3, "0")}`;
    const r = await h.api("bookkeeper", "POST", "/bills", {
      supplierDocumentKind: "tax_invoice", vendorReference: `VR-${no}`, billNumber: no, date: DATE, dueDate: DATE, vendorId,
      items: [{ description: "Supply", quantity: 1, unitPrice: 1_000, vatRate: 0 }],
    });
    expect(r.status, `create ${no}: ${JSON.stringify(r.body)}`).toBe(201);
    return { id: r.body.id as number, no };
  }
  async function evidence(b: Bill) {
    const row = (await pool.query(`SELECT status, total::text FROM bills WHERE id = $1`, [b.id])).rows[0] ?? null;
    const items = (await pool.query(`SELECT description FROM bill_items WHERE bill_id = $1 ORDER BY id`, [b.id])).rows.map((r) => r.description);
    return { bill: row, posted: row ? !["draft", "submitted"].includes(row.status) : false, items, gl: await entriesNumbered(orgId, `BILL-${b.no}`), audits: await auditsOf(orgId, "bill", b.id) };
  }
  const approve = (who: string, id: number) => h.api(who, "POST", `/bills/${id}/approve`, {});
  const reject = (id: number) => h.api("accountant", "POST", `/bills/${id}/reject`, {});
  const del = (id: number) => h.api("admin", "DELETE", `/bills/${id}`);
  const submit = (id: number) => h.api("bookkeeper", "POST", `/bills/${id}/submit`, {});
  const sendBack = (id: number) => h.api("accountant", "POST", `/bills/${id}/send-back`, { note: "please correct" });
  const patch = (id: number) => h.api("bookkeeper", "PATCH", `/bills/${id}`, EDIT);

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    await h.mkCompany(orgId, "G08R-c1 Co", "318181818181874");
    vendorId = (await pool.query(`INSERT INTO vendors (organization_id, name) VALUES ($1,'G08R-c1 Supplier') RETURNING id`, [orgId])).rows[0].id;
    for (const [who, role] of [["admin", "admin"], ["accountant", "accountant"], ["bookkeeper", "bookkeeper"]]) await h.mkUser(who, PW, orgId, role);
    await h.start();
    for (const who of ["admin", "accountant", "bookkeeper"]) expect(await h.login(who, h.email(who), PW), `login ${who}`).toBe(200);
  }, 120_000);
  afterAll(async () => { await h.stop(); await h.cleanup(); });

  it("CONTROL (sequential): the acts work alone (PATCH changes a draft's total; DELETE removes a draft), and a POSTED bill refuses approve, reject, DELETE, submit, send-back and PATCH", async () => {
    const a = await draftBill();
    expect((await submit(a.id)).status).toBe(200);
    expect((await sendBack(a.id)).status).toBe(200);
    expect((await patch(a.id)).status, "a draft bill is editable").toBe(200);
    const probed = (await pool.query(`SELECT notes, total::text AS total FROM bills WHERE id = $1`, [a.id])).rows[0];
    expect(probed.notes, "anti-vacuity: the PATCH probe changes a draft").toBe(PROBE_NOTE);
    expect(probed.total, "G65: a lined draft's total follows its lines, whatever the PATCH sent").toBe("1000.00");
    const d = await draftBill();
    expect((await del(d.id)).status, "a draft bill deletes").toBe(204);

    const p = await draftBill();
    const ok = await approve("admin", p.id);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const before = await evidence(p);
    expect(before.posted).toBe(true);
    expect(before.gl, "the posting wrote one entry").toHaveLength(1);
    const r = { approveAgain: await approve("accountant", p.id), reject: await reject(p.id), del: await del(p.id), submit: await submit(p.id), sendBack: await sendBack(p.id), patch: await patch(p.id) };
    expect(Object.values(r).map((x) => x.status)).toEqual([409, 409, 409, 409, 409, 409]);
    expect(await evidence(p), "the posted bill is untouched by the six refusals").toEqual(before);
    for (const [k, v] of Object.entries(r)) seqMsg[k] = v.body?.error;
  }, 60_000);

  it("🔴 R3 — two approvals of one bill at once: one 200, the other the sequential 409; one entry; one approval recorded", async () => {
    const b = await draftBill();
    const rs = await queuedBehind("bills", b.id, [() => approve("admin", b.id), () => approve("accountant", b.id)]);
    const ev = await evidence(b);
    // eslint-disable-next-line no-console
    console.warn("[G08R-c1] double approve", JSON.stringify({ results: rs.map(brief), ...ev }));
    expect.soft(statuses(rs)).toEqual([200, 409]);
    expect.soft(rs.find((x) => x.status !== 200)?.body?.error, "the loser gets the sequential refusal").toBe(seqMsg.approveAgain);
    expect.soft(ev.gl).toHaveLength(1);
    expect.soft(ev.audits.filter((a) => a.startsWith("approve:"))).toEqual(["approve:1"]);
  }, 60_000);

  for (const [label, act] of [["REJECT", reject], ["DELETE", del]] as const) {
    it(`🔴 R3 — a ${label} queued behind an approval: the approval 200, the ${label.toLowerCase()} the sequential 409; the posted bill survives with its lines and its entry`, async () => {
      const b = await draftBill();
      const [ap, lost] = await queuedBehind("bills", b.id, [() => approve("admin", b.id), () => act(b.id)]);
      const ev = await evidence(b);
      // eslint-disable-next-line no-console
      console.warn(`[G08R-c1] ${label.toLowerCase()} behind approve`, JSON.stringify({ approve: brief(ap), [label.toLowerCase()]: brief(lost), ...ev }));
      expect(ap.status).toBe(200);
      expect.soft(lost.status).toBe(409);
      expect.soft(lost.body?.error).toBe(label === "REJECT" ? seqMsg.reject : seqMsg.del);
      expect.soft(ev.bill, "the posted bill still exists").not.toBeNull();
      expect.soft(ev.posted).toBe(true);
      expect.soft(ev.items).toEqual(["Supply"]);
      expect.soft(ev.gl.map((g) => [g.status, g.lines])).toEqual([["posted", 2]]);
    }, 60_000);
  }

  it("🔴 R3 — a SEND-BACK queued behind an approval: the send-back the sequential 409; the posted bill stays posted and cannot then be edited", async () => {
    const b = await draftBill();
    expect((await submit(b.id)).status).toBe(200);
    const [ap, back] = await queuedBehind("bills", b.id, [() => approve("admin", b.id), () => sendBack(b.id)]);
    const afterRace = await evidence(b);
    const edit = await patch(b.id);
    const afterPatch = await evidence(b);
    // eslint-disable-next-line no-console
    console.warn("[G08R-c1] send-back behind approve", JSON.stringify({ approve: brief(ap), sendBack: brief(back), afterRace, patch: brief(edit), afterPatch }));
    expect(ap.status).toBe(200);
    expect.soft(back.status).toBe(409);
    expect.soft(back.body?.error).toBe(seqMsg.sendBack);
    expect.soft(afterRace.posted, "a posted bill never returns to draft").toBe(true);
    expect.soft(edit.status, "PATCH of the posted bill is refused").toBe(409);
    expect.soft(afterPatch.bill?.total, "the posted total is unchanged").toBe("1000.00");
    expect.soft(afterPatch.items).toEqual(["Supply"]);
  }, 60_000);

  it("🔴 R3 — a SUBMIT queued behind an approval (from draft): the submit the sequential 409; the posted bill stays posted", async () => {
    const b = await draftBill();
    const [ap, sub] = await queuedBehind("bills", b.id, [() => approve("admin", b.id), () => submit(b.id)]);
    const ev = await evidence(b);
    // eslint-disable-next-line no-console
    console.warn("[G08R-c1] submit behind approve", JSON.stringify({ approve: brief(ap), submit: brief(sub), ...ev }));
    expect(ap.status).toBe(200);
    expect.soft(sub.status).toBe(409);
    expect.soft(sub.body?.error).toBe(seqMsg.submit);
    expect.soft(ev.posted, "a posted bill never returns to submitted").toBe(true);
  }, 60_000);
});
