/**
 * 🔴 Phase 18 decision 2.4 (e3) — PROOF ONLY, PURCHASE ORDERS
 * (`purchaseOrderApprovable`). Known-failing by design while a defect exists:
 * each assertion states the correct behaviour, and a failing soft assertion IS
 * the finding. No product code is changed by this file.
 *
 * The adapter is the declared mirror of quotations and is NOT on
 * compare-and-set (approval-compare-and-set-ratchet): `load` is a plain SELECT
 * (no lock), and every write — `onApprove`, `onSubmit`, `onSendBack`,
 * `hardDelete` — is keyed on the id only. The PATCH
 * (`purchaseOrdersService.update`) and the DELETE (`deleteDraft`) are the same
 * check-then-act shape. Forced with `helpers/g08rRace.ts` (a holder locks the
 * purchase-order row; each act is SEEN waiting inside the holder's wait tree
 * before the next is sent):
 *  - two approvals; a reject, a DELETE, a send-back and a submit, each queued
 *    behind an approval; an approval queued behind a reject and behind a
 *    DELETE; a submit and a send-back queued behind a reject;
 *  - an edit (PATCH) queued behind a SUBMIT (a submitted order is locked) and
 *    behind an approval (an approved order is editable by design);
 *  - conversion-adjacent: recording the supplier's bill (convert) and a
 *    DELETE, both orders.
 * And SEQUENTIALLY (no race): whether `DELETE /purchase-orders/:id`
 * (`deleteDraft`) removes an APPROVED, unbilled order — and a SUBMITTED one.
 *
 * The invariant: the outcome of any interleaving is one a sequential order
 * could produce — one winner; the loser gets the refusal it gets sequentially
 * (the CONTROL captures each); never a 5xx; an approved order and its lines
 * survive; one approval recorded.
 *
 * DB-backed (sl_test); skips on the DB-free placeholder. Run through the pre-flight gate.
 */
process.env.PORT ??= "3192";
process.env.SESSION_SECRET ??= "g08r-e3-purchase-orders-proof-0000000001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness, type Res } from "./helpers/g04Harness";
import { auditsOf, brief, queuedBehind, statuses } from "./helpers/g08rRace";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "G08rProofPw123!";
const DATE = "2026-10-05";
const EDIT = { notes: "EDITED BY THE RACE" };
const is4xx = (r: Res | undefined) => !!r && r.status >= 400 && r.status < 500;
const is2xx = (r: Res | undefined) => !!r && r.status >= 200 && r.status < 300;

describeMaybe("Phase 18 (e3) — the approval-flow races on PURCHASE ORDERS", () => {
  const h = g04Harness("g08re3");
  let orgId = "";
  let vendorId = 0;
  let n = 0;
  const seq: Record<string, Res> = {};

  async function draft(): Promise<number> {
    const r = await h.api("bookkeeper", "POST", "/purchase-orders", {
      date: DATE, vendorId, notes: `G08R-E3 order ${++n}`,
      items: [{ description: "Bolts", quantity: 10, unitPrice: 100, vatRate: 15 }],
    });
    expect(r.status, `create purchase order: ${JSON.stringify(r.body)}`).toBe(201);
    return r.body.id as number;
  }
  async function evidence(id: number) {
    const row = (await pool.query(`SELECT status, outcome, notes, review_note FROM purchase_orders WHERE id = $1`, [id])).rows[0] ?? null;
    const items = (await pool.query(`SELECT description FROM purchase_order_items WHERE purchase_order_id = $1 ORDER BY id`, [id])).rows.map((r) => r.description as string);
    const conversions = (await pool.query(`SELECT count(*)::int AS n FROM purchase_order_conversions WHERE purchase_order_id = $1`, [id])).rows[0].n as number;
    return { row, items, conversions, audits: await auditsOf(orgId, "purchase_order", id) };
  }
  const marker = (id: number) => `G08R-E3 bill for purchase order ${id}`;
  const billsFrom = async (id: number) =>
    (await pool.query(`SELECT count(*)::int AS n FROM bills WHERE organization_id = $1 AND notes = $2`, [orgId, marker(id)])).rows[0].n as number;

  const approve = (who: string, id: number) => h.api(who, "POST", `/purchase-orders/${id}/approve`, {});
  const reject = (id: number) => h.api("accountant", "POST", `/purchase-orders/${id}/reject`, {});
  const del = (id: number) => h.api("admin", "DELETE", `/purchase-orders/${id}`);
  const submit = (id: number) => h.api("bookkeeper", "POST", `/purchase-orders/${id}/submit`, {});
  const sendBack = (id: number) => h.api("accountant", "POST", `/purchase-orders/${id}/send-back`, { note: "please correct" });
  const patch = (id: number) => h.api("bookkeeper", "PATCH", `/purchase-orders/${id}`, EDIT);
  const convert = (id: number) => h.api("bookkeeper", "POST", `/purchase-orders/${id}/convert`, {
    date: DATE, notes: marker(id), billNumber: `G08RE3-B-${id}`, vendorReference: `G08RE3-VR-${id}`,
  });
  // eslint-disable-next-line no-console
  const log = (label: string, ev: unknown) => console.warn(`[G08R-e3] ${label}`, JSON.stringify(ev));

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    await h.mkCompany(orgId, "G08R-e3 Co", "318181818181893");
    vendorId = (await pool.query(`INSERT INTO vendors (organization_id, name) VALUES ($1,'G08R-e3 Supplier') RETURNING id`, [orgId])).rows[0].id;
    for (const [who, role] of [["admin", "admin"], ["accountant", "accountant"], ["bookkeeper", "bookkeeper"]]) await h.mkUser(who, PW, orgId, role);
    await h.start();
    for (const who of ["admin", "accountant", "bookkeeper"]) expect(await h.login(who, h.email(who), PW), `login ${who}`).toBe(200);
  }, 120_000);
  afterAll(async () => {
    await h.stop();
    await h.cleanup();
    // the server logs through an async transport (pino-pretty in a worker): give it time to write the last
    // requests' error causes (the 5xx above) into the run log before the test process exits
    await new Promise((res) => setTimeout(res, 2_000));
  }, 60_000);

  it("CONTROL (sequential): each act works alone, and each refusal a race loser should get is captured", async () => {
    // a draft: PATCH edits it, submit and send-back move it, reject removes it
    const a = await draft();
    expect((await patch(a)).status, "a draft order is editable").toBe(200);
    expect((await evidence(a)).row?.notes, "anti-vacuity: the PATCH probe changes a draft").toBe(EDIT.notes);
    expect((await submit(a)).status).toBe(200);
    seq.patchSubmitted = await patch(a);
    expect(seq.patchSubmitted.status, "a SUBMITTED order is locked").toBe(409);
    expect((await sendBack(a)).status).toBe(200);
    expect((await evidence(a)).row?.status).toBe("draft");
    expect((await reject(a)).status).toBe(204);
    expect((await evidence(a)).row, "a reject removes the draft").toBeNull();
    // what each act answers once the order is gone
    seq.approveGone = await approve("admin", a);
    seq.submitGone = await submit(a);
    seq.sendBackGone = await sendBack(a);
    expect([seq.approveGone.status, seq.submitGone.status, seq.sendBackGone.status]).toEqual([404, 404, 404]);
    const d = await draft();
    expect((await del(d)).status, "a draft deletes").toBe(204);
    expect((await evidence(d)).row).toBeNull();

    // an APPROVED order refuses approve, reject, submit and send-back — and nothing moves
    const p = await draft();
    const ok = await approve("admin", p);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const before = await evidence(p);
    expect(before.row?.status).toBe("approved");
    seq.approveAgain = await approve("accountant", p);
    seq.reject = await reject(p);
    seq.submit = await submit(p);
    seq.sendBack = await sendBack(p);
    expect([seq.approveAgain, seq.reject, seq.submit, seq.sendBack].map((x) => x.status)).toEqual([409, 409, 409, 409]);
    expect(await evidence(p), "the approved order is untouched by the four refusals").toEqual(before);
    // an approved order is EDITABLE by design (purchaseOrdersService.update) — the sequential answer to a PATCH
    seq.patchApproved = await patch(p);
    expect(seq.patchApproved.status, "PATCH of an approved order is allowed sequentially").toBe(200);

    // conversion: an approved order records the supplier's DRAFT bill; a billed order refuses DELETE
    const c = await draft();
    expect((await approve("admin", c)).status).toBe(200);
    const conv = await convert(c);
    expect(conv.status, JSON.stringify(conv.body)).toBe(201);
    seq.delConverted = await del(c);
    expect(seq.delConverted.status, "a billed order refuses DELETE").toBe(409);
    const ce = await evidence(c);
    expect([ce.row?.status, ce.items, ce.conversions, await billsFrom(c)]).toEqual(["approved", ["Bolts"], 1, 1]);
    seq.convertGone = await convert(d);
    expect(seq.convertGone.status, "billing a removed order answers 404").toBe(404);
    log("CONTROL refusals", Object.fromEntries(Object.entries(seq).map(([k, v]) => [k, brief(v)])));
  }, 90_000);

  // ── SEQUENTIAL — the owner-named defect: what does the plain DELETE remove? ──
  it("🔴 SEQUENTIAL — DELETE (deleteDraft) of an APPROVED, UNBILLED purchase order: refused like its invoice/bill siblings; the approved order and its lines survive", async () => {
    const q = await draft();
    expect((await approve("admin", q)).status).toBe(200);
    const before = await evidence(q);
    const r = await del(q);
    const after = await evidence(q);
    log("SEQUENTIAL delete of an approved, unbilled purchase order", { delete: brief(r), before, after });
    expect(before.row?.status).toBe("approved");
    expect.soft(r.status, "DELETE of an approved order is refused (4xx)").toBe(409);
    expect.soft(after.row?.status, "the approved order still exists").toBe("approved");
    expect.soft(after.items, "its lines survive").toEqual(["Bolts"]);
    expect.soft(after.audits.filter((x) => x.startsWith("delete:")), "no delete is recorded").toEqual([]);
  }, 60_000);

  it("🔴 SEQUENTIAL — DELETE (deleteDraft) of a SUBMITTED purchase order (in the approver's queue): refused like its siblings; it stays submitted", async () => {
    const q = await draft();
    expect((await submit(q)).status).toBe(200);
    const r = await del(q);
    const after = await evidence(q);
    log("SEQUENTIAL delete of a submitted purchase order", { delete: brief(r), after });
    expect.soft(r.status, "DELETE of a submitted order is refused (4xx)").toBe(409);
    expect.soft(after.row?.status, "the submitted order still exists").toBe("submitted");
  }, 60_000);

  // ── forced interleavings ─────────────────────────────────────────────────
  it("🔴 two approvals of one purchase order at once: one 200, the other the sequential 409; one approval recorded", async () => {
    const q = await draft();
    const rs = await queuedBehind("purchase_orders", q, [() => approve("admin", q), () => approve("accountant", q)]);
    const ev = await evidence(q);
    log("double approve", { results: rs.map(brief), ...ev });
    expect.soft(rs.every((r) => r.status < 500), "never a 5xx").toBe(true);
    expect.soft(statuses(rs)).toEqual([200, 409]);
    expect.soft(rs.find((x) => x.status !== 200)?.body?.error, "the loser gets the sequential refusal").toBe(seq.approveAgain?.body?.error);
    expect.soft(ev.row?.status).toBe("approved");
    expect.soft(ev.audits.filter((a) => a.startsWith("approve:"))).toEqual(["approve:1"]);
  }, 60_000);

  for (const [label, act, key] of [["REJECT", reject, "reject"], ["DELETE", del, null]] as const) {
    it(`🔴 a ${label} queued behind an approval (from draft): the approval 200, the ${label.toLowerCase()} refused 409; the approved order survives with its lines`, async () => {
      const q = await draft();
      const [ap, lost] = await queuedBehind("purchase_orders", q, [() => approve("admin", q), () => act(q)]);
      const ev = await evidence(q);
      log(`${label.toLowerCase()} behind approve`, { approve: brief(ap), [label.toLowerCase()]: brief(lost), ...ev });
      expect(ap.status).toBe(200);
      expect.soft(lost.status, `the ${label.toLowerCase()} is refused`).toBe(409);
      // a reject of an approved order has a sequential refusal; a DELETE of one does NOT (see the SEQUENTIAL test)
      if (key) expect.soft(lost.body?.error, "the loser gets the sequential refusal").toBe(seq[key]?.body?.error);
      expect.soft(ev.row?.status, "the approved order still exists").toBe("approved");
      expect.soft(ev.items).toEqual(["Bolts"]);
    }, 60_000);
  }

  it("🔴 a SEND-BACK queued behind an approval (from submitted): the send-back the sequential 409; the order stays approved", async () => {
    const q = await draft();
    expect((await submit(q)).status).toBe(200);
    const [ap, back] = await queuedBehind("purchase_orders", q, [() => approve("admin", q), () => sendBack(q)]);
    const ev = await evidence(q);
    log("send-back behind approve", { approve: brief(ap), sendBack: brief(back), ...ev });
    expect(ap.status).toBe(200);
    expect.soft(back.status).toBe(409);
    expect.soft(back.body?.error).toBe(seq.sendBack?.body?.error);
    expect.soft(ev.row?.status, "an approved order never returns to draft").toBe("approved");
    expect.soft(ev.audits.filter((a) => a.startsWith("send_back:")), "no send-back recorded after the approval").toEqual([]);
  }, 60_000);

  it("🔴 a SUBMIT queued behind an approval (from draft): the submit the sequential 409; the order stays approved", async () => {
    const q = await draft();
    const [ap, sub] = await queuedBehind("purchase_orders", q, [() => approve("admin", q), () => submit(q)]);
    const ev = await evidence(q);
    log("submit behind approve", { approve: brief(ap), submit: brief(sub), ...ev });
    expect(ap.status).toBe(200);
    expect.soft(sub.status).toBe(409);
    expect.soft(sub.body?.error).toBe(seq.submit?.body?.error);
    expect.soft(ev.row?.status, "an approved order never returns to submitted").toBe("approved");
  }, 60_000);

  for (const [label, first] of [["REJECT", reject], ["DELETE", del]] as const) {
    it(`🔴 an APPROVAL queued behind a ${label}: the ${label.toLowerCase()} 204, the approval refused (4xx, never 5xx); nothing approved is recorded`, async () => {
      const q = await draft();
      const [gone, ap] = await queuedBehind("purchase_orders", q, [() => first(q), () => approve("admin", q)]);
      const ev = await evidence(q);
      log(`approve behind ${label.toLowerCase()}`, { [label.toLowerCase()]: brief(gone), approve: brief(ap), ...ev });
      expect(gone.status).toBe(204);
      expect.soft(ap.status < 500, "never a 5xx").toBe(true);
      expect.soft(is4xx(ap), `the approval is refused (sequentially: ${seq.approveGone?.status})`).toBe(true);
      expect.soft(ev.row, "the order is gone").toBeNull();
      expect.soft(ev.audits.filter((a) => a.startsWith("approve:")), "no approval recorded").toEqual([]);
    }, 60_000);
  }

  it("🔴 a SUBMIT queued behind a REJECT (from draft), and a SEND-BACK queued behind a REJECT (from submitted): each refused (4xx, never 5xx)", async () => {
    const a = await draft();
    const [rej1, sub] = await queuedBehind("purchase_orders", a, [() => reject(a), () => submit(a)]);
    const b = await draft();
    expect((await submit(b)).status).toBe(200);
    const [rej2, back] = await queuedBehind("purchase_orders", b, [() => reject(b), () => sendBack(b)]);
    log("submit / send-back behind reject", { reject1: brief(rej1), submit: brief(sub), reject2: brief(rej2), sendBack: brief(back), a: await evidence(a), b: await evidence(b) });
    expect([rej1.status, rej2.status]).toEqual([204, 204]);
    expect.soft([sub.status < 500, back.status < 500], "never a 5xx").toEqual([true, true]);
    expect.soft([is4xx(sub), is4xx(back)], `each refused (sequentially: ${seq.submitGone?.status} / ${seq.sendBackGone?.status})`).toEqual([true, true]);
  }, 60_000);

  // ── edit racing the workflow ─────────────────────────────────────────────
  it("🔴 a PATCH queued behind a SUBMIT (from draft): the PATCH the sequential 409 (a submitted order is locked); the submitted content is unchanged", async () => {
    const q = await draft();
    const before = await evidence(q);
    const [sub, edit] = await queuedBehind("purchase_orders", q, [() => submit(q), () => patch(q)]);
    const ev = await evidence(q);
    log("PATCH behind submit", { submit: brief(sub), patch: brief(edit), before: before.row, ...ev });
    expect(sub.status).toBe(200);
    expect.soft(edit.status).toBe(409);
    expect.soft(edit.body?.error).toBe(seq.patchSubmitted?.body?.error);
    expect.soft(ev.row?.status).toBe("submitted");
    expect.soft(ev.row?.notes, "the submitted order's content is what was submitted").toBe(before.row?.notes);
    expect.soft(ev.audits.filter((a) => a.startsWith("update:")), "no edit recorded on the submitted order").toEqual([]);
  }, 60_000);

  it("a PATCH queued behind an APPROVAL (from draft): both 200 — the sequential answer (an approved order is editable by design); the order stays approved", async () => {
    const q = await draft();
    const [ap, edit] = await queuedBehind("purchase_orders", q, [() => approve("admin", q), () => patch(q)]);
    const ev = await evidence(q);
    log("PATCH behind approve", { approve: brief(ap), patch: brief(edit), ...ev });
    expect(ap.status).toBe(200);
    expect.soft(edit.status < 500, "never a 5xx").toBe(true);
    expect.soft(edit.status, "the sequential answer to a PATCH of an approved order").toBe(seq.patchApproved?.status);
    expect.soft(ev.row?.status, "the edit does not move the status").toBe("approved");
  }, 60_000);

  // ── conversion-adjacent: recording the supplier's bill (a draft bill) ──────
  for (const order of ["convert, then DELETE", "DELETE, then convert"] as const) {
    it(`🔴 a CONVERSION (the supplier's bill) and a DELETE of one approved order (${order}): one succeeds, the other gets its sequential refusal (never a 5xx); no conversion without its order, no bill without its conversion`, async () => {
      const q = await draft();
      expect((await approve("admin", q)).status).toBe(200);
      const convertFirst = order === "convert, then DELETE";
      const rs = await queuedBehind("purchase_orders", q, convertFirst ? [() => convert(q), () => del(q)] : [() => del(q), () => convert(q)]);
      const [conv, rm] = convertFirst ? rs : [rs[1]!, rs[0]!];
      const ev = await evidence(q);
      const bills = await billsFrom(q);
      log(`convert vs delete (${order})`, { convert: brief(conv), delete: brief(rm), ...ev, billsFromConversion: bills });
      expect.soft(rs.every((r) => r.status < 500), "never a 5xx").toBe(true);
      expect.soft(rs.filter(is2xx).length, "exactly one succeeds").toBe(1);
      // the sequential answer of the second act
      if (convertFirst) {
        expect.soft([conv.status, rm.status], "convert 201, then DELETE refused (billed)").toEqual([201, seq.delConverted?.status]);
        expect.soft(rm.body?.error).toBe(seq.delConverted?.body?.error);
      } else {
        // AMENDED 2026-10-21 before landing (the only change to this file): this branch expected the DELETE of an
        // APPROVED order to succeed (204) — the very defect the SEQUENTIAL test above proves and owner decision 2.4
        // corrects. With an approved order not deletable, the DELETE that comes first is refused and the conversion
        // then succeeds; "exactly one succeeds" and the consistency checks below are unchanged.
        expect.soft([rm.status, conv.status], "DELETE refused (an approved order is not deleted), then convert 201").toEqual([409, 201]);
      }
      // consistency, whichever won
      if (ev.row) expect.soft(ev.items, "a surviving order keeps its lines").toEqual(["Bolts"]);
      else expect.soft(ev.conversions, "a deleted order has no conversion").toBe(0);
      expect.soft(bills, "every draft bill the conversion produced has its conversion row, and no other").toBe(ev.conversions);
    }, 60_000);
  }
});
