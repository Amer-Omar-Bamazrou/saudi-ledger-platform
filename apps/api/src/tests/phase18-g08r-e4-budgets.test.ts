/**
 * 🔴 Phase 18 decision 2.4 (e4) — PROOF ONLY, BUDGETS (`budgetVersionApprovable`).
 * Each assertion states the correct behaviour; a failing soft assertion IS the
 * finding. No product code is changed by this file.
 *
 * The adapter is NOT on compare-and-set (approval-compare-and-set-ratchet),
 * but by reading it is serialised another way: every transition's service
 * wrapper locks the version first (`loadVersionOf` → `lockVersion`, SELECT …
 * FOR UPDATE) and the adapter's `load` locks it again; the edit
 * (`replaceLines`) locks it too; and migration 0112's `budget_versions_guard`
 * refuses an illegal step or the deletion of an approved version at the
 * database. Reading is not proof — so each interleaving is FORCED with
 * `helpers/g08rRace.ts` (a holder locks the version row; each act is SEEN
 * waiting inside the holder's wait tree before the next is sent):
 *  - two approvals; a reject, a send-back and a submit, each queued behind an
 *    approval; an approval queued behind a reject;
 *  - an edit (PUT lines) queued behind an approval, and an approval queued
 *    behind an edit;
 *  - a DELETE of the budget queued behind an approval, and an approval queued
 *    behind a DELETE;
 *  - a REVISION: two approvals of v2 at once — v1 superseded exactly once.
 *
 * The invariant: the outcome of any interleaving is one a sequential order
 * could produce — one winner; the loser gets the refusal it gets sequentially
 * (the CONTROL captures each); never a 5xx; an approved version and its lines
 * survive; one approval (and one supersede) recorded. A budget never posts:
 * no journal entry is written by any of it.
 *
 * DB-backed (sl_test); skips on the DB-free placeholder. Run through the pre-flight gate.
 */
process.env.PORT ??= "3193";
process.env.SESSION_SECRET ??= "g08r-e4-budgets-proof-00000000000000001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness, type Res } from "./helpers/g04Harness";
import { auditsOf, brief, queuedBehind, statuses } from "./helpers/g08rRace";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "G08rProofPw123!";
const FY = 2026;
const LINES_TOTAL = "12000.00";
const EDITED_TOTAL = "24000.00";

describeMaybe("Phase 18 (e4) — the approval-flow races on BUDGETS", () => {
  const h = g04Harness("g08re4");
  let orgId = "";
  let sales = 0;
  let n = 0;
  const seq: Record<string, Res> = {};
  type B = { budgetId: number; versionId: number };

  const lines = (amount: number) => ({ lines: [{ accountId: sales, periods: Array(12).fill(amount) }] });
  async function draft(): Promise<B> {
    const r = await h.api("bookkeeper", "POST", "/budgets", { name: `G08R-E4 budget ${++n}`, fiscalYearLabel: FY });
    expect(r.status, `create budget: ${JSON.stringify(r.body)}`).toBe(201);
    const b = { budgetId: r.body.id as number, versionId: r.body.version.id as number };
    const l = await h.api("bookkeeper", "PUT", `/budgets/${b.budgetId}/versions/${b.versionId}/lines`, lines(1_000));
    expect(l.status, `lines: ${JSON.stringify(l.body)}`).toBe(200);
    return b;
  }
  async function evidence(b: B) {
    const budget = (await pool.query(`SELECT 1 FROM budgets WHERE id = $1`, [b.budgetId])).rowCount;
    const version = (await pool.query(`SELECT version_no, status FROM budget_versions WHERE id = $1`, [b.versionId])).rows[0] ?? null;
    const total = (await pool.query(`SELECT coalesce(sum(amount), 0)::numeric(15,2)::text AS t FROM budget_lines WHERE version_id = $1`, [b.versionId])).rows[0].t as string;
    const approvedVersions = (await pool.query(`SELECT count(*)::int AS n FROM budget_versions WHERE budget_id = $1 AND status = 'approved'`, [b.budgetId])).rows[0].n as number;
    return { budget, version, total, approvedVersions, audits: await auditsOf(orgId, "budget_version", b.versionId) };
  }
  const entriesInOrg = async () => (await pool.query(`SELECT count(*)::int AS n FROM journal_entries WHERE organization_id = $1`, [orgId])).rows[0].n as number;

  const v = (b: B, act: string) => `/budgets/${b.budgetId}/versions/${b.versionId}/${act}`;
  const approve = (who: string, b: B) => h.api(who, "POST", v(b, "approve"), {});
  const reject = (b: B) => h.api("accountant", "POST", v(b, "reject"), {});
  const submit = (b: B) => h.api("bookkeeper", "POST", v(b, "submit"), {});
  const sendBack = (b: B) => h.api("accountant", "POST", v(b, "send-back"), { note: "please correct" });
  const edit = (b: B) => h.api("bookkeeper", "PUT", v(b, "lines"), lines(2_000));
  const del = (b: B) => h.api("admin", "DELETE", `/budgets/${b.budgetId}`);
  // eslint-disable-next-line no-console
  const log = (label: string, ev: unknown) => console.warn(`[G08R-e4] ${label}`, JSON.stringify(ev));

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    await h.mkCompany(orgId, "G08R-e4 Co", "318181818181894");
    sales = (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = 'SALES'`, [orgId])).rows[0].id;
    for (const [who, role] of [["admin", "admin"], ["accountant", "accountant"], ["bookkeeper", "bookkeeper"]]) await h.mkUser(who, PW, orgId, role);
    await h.start();
    for (const who of ["admin", "accountant", "bookkeeper"]) expect(await h.login(who, h.email(who), PW), `login ${who}`).toBe(200);
  }, 120_000);
  afterAll(async () => { await h.stop(); await h.cleanup(); });

  it("CONTROL (sequential): each act works alone, and each refusal a race loser should get is captured", async () => {
    // a draft: PUT lines edits it, submit and send-back move it, reject removes it (and the budget with it)
    const a = await draft();
    expect((await evidence(a)).total).toBe(LINES_TOTAL);
    expect((await edit(a)).status, "a draft version's lines are editable").toBe(200);
    expect((await evidence(a)).total, "anti-vacuity: the edit probe changes a draft's lines").toBe(EDITED_TOTAL);
    expect((await submit(a)).status).toBe(200);
    expect((await sendBack(a)).status).toBe(200);
    expect((await evidence(a)).version?.status).toBe("draft");
    expect((await reject(a)).status).toBe(204);
    expect((await evidence(a)).version, "a reject removes the draft version").toBeNull();
    seq.approveGone = await approve("admin", a);
    expect(seq.approveGone.status, "approving a removed version answers 404").toBe(404);
    const d = await draft();
    expect((await del(d)).status, "a never-approved budget deletes").toBe(204);
    expect((await evidence(d)).budget).toBe(0);
    seq.approveDeleted = await approve("admin", d);
    expect(seq.approveDeleted.status, "approving a version of a deleted budget answers 404").toBe(404);

    // an APPROVED version refuses approve, reject, submit, send-back, an edit, and a DELETE of its budget
    const p = await draft();
    const ok = await approve("admin", p);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const before = await evidence(p);
    expect(before.version?.status).toBe("approved");
    seq.approveAgain = await approve("accountant", p);
    seq.reject = await reject(p);
    seq.submit = await submit(p);
    seq.sendBack = await sendBack(p);
    seq.edit = await edit(p);
    seq.del = await del(p);
    expect([seq.approveAgain, seq.reject, seq.submit, seq.sendBack, seq.edit, seq.del].map((x) => x.status)).toEqual([409, 409, 409, 409, 409, 409]);
    expect(await evidence(p), "the approved version is untouched by the six refusals").toEqual(before);
    expect(await entriesInOrg(), "a budget never posts").toBe(0);
    log("CONTROL refusals", Object.fromEntries(Object.entries(seq).map(([k, x]) => [k, brief(x)])));
  }, 90_000);

  it("two approvals of one version at once: one 200, the other the sequential 409; one approval recorded", async () => {
    const b = await draft();
    const rs = await queuedBehind("budget_versions", b.versionId, [() => approve("admin", b), () => approve("accountant", b)]);
    const ev = await evidence(b);
    log("double approve", { results: rs.map(brief), ...ev });
    expect.soft(rs.every((r) => r.status < 500), "never a 5xx").toBe(true);
    expect.soft(statuses(rs)).toEqual([200, 409]);
    const loser = rs.find((x) => x.status !== 200);
    expect.soft([loser?.body?.code, loser?.body?.error], "the loser gets the sequential refusal").toEqual([seq.approveAgain?.body?.code, seq.approveAgain?.body?.error]);
    expect.soft([ev.version?.status, ev.approvedVersions, ev.total]).toEqual(["approved", 1, LINES_TOTAL]);
    expect.soft(ev.audits.filter((a) => a.startsWith("approve:"))).toEqual(["approve:1"]);
  }, 60_000);

  for (const [label, act, key, from] of [
    ["REJECT", reject, "reject", "draft"],
    ["SEND-BACK", sendBack, "sendBack", "submitted"],
    ["SUBMIT", submit, "submit", "draft"],
  ] as const) {
    it(`a ${label} queued behind an approval (from ${from}): the approval 200, the ${label.toLowerCase()} the sequential 409; the approved version and its lines survive`, async () => {
      const b = await draft();
      if (from === "submitted") expect((await submit(b)).status).toBe(200);
      const [ap, lost] = await queuedBehind("budget_versions", b.versionId, [() => approve("admin", b), () => act(b)]);
      const ev = await evidence(b);
      log(`${label.toLowerCase()} behind approve`, { approve: brief(ap), [label.toLowerCase()]: brief(lost), ...ev });
      expect(ap.status).toBe(200);
      expect.soft(lost.status).toBe(409);
      expect.soft([lost.body?.code, lost.body?.error], "the loser gets the sequential refusal").toEqual([seq[key]?.body?.code, seq[key]?.body?.error]);
      expect.soft([ev.version?.status, ev.total], "the approved version and its lines survive").toEqual(["approved", LINES_TOTAL]);
    }, 60_000);
  }

  it("an APPROVAL queued behind a REJECT: the reject 204, the approval the sequential 404; nothing approved is recorded", async () => {
    const b = await draft();
    const [rej, ap] = await queuedBehind("budget_versions", b.versionId, [() => reject(b), () => approve("admin", b)]);
    const ev = await evidence(b);
    log("approve behind reject", { reject: brief(rej), approve: brief(ap), ...ev });
    expect(rej.status).toBe(204);
    expect.soft(ap.status < 500, "never a 5xx").toBe(true);
    expect.soft([ap.status, ap.body?.error], "the sequential refusal").toEqual([seq.approveGone?.status, seq.approveGone?.body?.error]);
    expect.soft([ev.version, ev.budget]).toEqual([null, 0]);
    expect.soft(ev.audits.filter((a) => a.startsWith("approve:"))).toEqual([]);
  }, 60_000);

  it("an EDIT (PUT lines) queued behind an approval: the edit the sequential 409 (locked); the approved lines are unchanged", async () => {
    const b = await draft();
    const [ap, ed] = await queuedBehind("budget_versions", b.versionId, [() => approve("admin", b), () => edit(b)]);
    const ev = await evidence(b);
    log("edit behind approve", { approve: brief(ap), edit: brief(ed), ...ev });
    expect(ap.status).toBe(200);
    expect.soft(ed.status).toBe(409);
    expect.soft(ed.body?.code, "the loser gets the sequential refusal").toBe(seq.edit?.body?.code);
    expect.soft([ev.version?.status, ev.total], "the approved lines are what was approved").toEqual(["approved", LINES_TOTAL]);
  }, 60_000);

  it("an APPROVAL queued behind an EDIT: both 200 — the sequential order (edit, then approve); what is approved is the edited lines, and the approval's snapshot says so", async () => {
    const b = await draft();
    const [ed, ap] = await queuedBehind("budget_versions", b.versionId, [() => edit(b), () => approve("admin", b)]);
    const ev = await evidence(b);
    const approvedSnapshot = (await pool.query(
      `SELECT after_state AS after FROM audit_logs WHERE organization_id = $1 AND entity_type = 'budget_version' AND entity_id = $2 AND action = 'approve'`, [orgId, String(b.versionId)],
    )).rows[0]?.after as { lines?: { total: number }[] } | undefined;
    log("approve behind edit", { edit: brief(ed), approve: brief(ap), ...ev, approvedSnapshotTotal: approvedSnapshot?.lines?.map((l) => l.total) });
    expect.soft([ed.status, ap.status]).toEqual([200, 200]);
    expect.soft([ev.version?.status, ev.total]).toEqual(["approved", EDITED_TOTAL]);
    expect.soft(approvedSnapshot?.lines?.map((l) => l.total), "the approval recorded the lines it approved").toEqual([24_000]);
  }, 60_000);

  it("a DELETE of the budget queued behind an approval: the approval 200, the DELETE refused 409; the approved version, its lines and its budget survive", async () => {
    const b = await draft();
    const [ap, rm] = await queuedBehind("budget_versions", b.versionId, [() => approve("admin", b), () => del(b)]);
    const ev = await evidence(b);
    log("delete behind approve", { approve: brief(ap), delete: brief(rm), ...ev });
    expect(ap.status).toBe(200);
    expect.soft(rm.status < 500, "never a 5xx").toBe(true);
    expect.soft(rm.status, "the DELETE is refused").toBe(409);
    expect.soft([ev.budget, ev.version?.status, ev.total], "nothing approved is lost").toEqual([1, "approved", LINES_TOTAL]);
    // wording: the sequential refusal names the rule; a refusal raised by the database trigger instead is reported, not hidden
    expect.soft([rm.body?.code, rm.body?.error], "the loser gets the sequential refusal (code and text)").toEqual([seq.del?.body?.code, seq.del?.body?.error]);
  }, 60_000);

  it("an APPROVAL queued behind a DELETE of the budget: the DELETE 204, the approval the sequential 404; nothing approved is recorded", async () => {
    const b = await draft();
    const [rm, ap] = await queuedBehind("budget_versions", b.versionId, [() => del(b), () => approve("admin", b)]);
    const ev = await evidence(b);
    log("approve behind delete", { delete: brief(rm), approve: brief(ap), ...ev });
    expect(rm.status).toBe(204);
    expect.soft(ap.status < 500, "never a 5xx").toBe(true);
    expect.soft([ap.status, ap.body?.error], "the sequential refusal").toEqual([seq.approveDeleted?.status, seq.approveDeleted?.body?.error]);
    expect.soft([ev.version, ev.budget]).toEqual([null, 0]);
    expect.soft(ev.audits.filter((a) => a.startsWith("approve:"))).toEqual([]);
  }, 60_000);

  it("a REVISION: two approvals of v2 at once — one 200, the other the sequential 409; v1 superseded exactly once; one approved version", async () => {
    const b1 = await draft();
    expect((await approve("admin", b1)).status).toBe(200);
    const rev = await h.api("bookkeeper", "POST", `/budgets/${b1.budgetId}/versions`, {});
    expect(rev.status, JSON.stringify(rev.body)).toBe(201);
    const b2 = { budgetId: b1.budgetId, versionId: rev.body.version.id as number };
    expect(b2.versionId).not.toBe(b1.versionId);
    const rs = await queuedBehind("budget_versions", b2.versionId, [() => approve("admin", b2), () => approve("accountant", b2)]);
    const ev1 = await evidence(b1);
    const ev2 = await evidence(b2);
    log("revision double approve", { results: rs.map(brief), v1: ev1, v2: ev2 });
    expect.soft(rs.every((r) => r.status < 500), "never a 5xx").toBe(true);
    expect.soft(statuses(rs)).toEqual([200, 409]);
    expect.soft(rs.find((x) => x.status !== 200)?.body?.code).toBe(seq.approveAgain?.body?.code);
    expect.soft([ev1.version?.status, ev2.version?.status, ev2.approvedVersions]).toEqual(["superseded", "approved", 1]);
    expect.soft(ev1.audits.filter((a) => a.startsWith("supersede:")), "v1 superseded once").toEqual(["supersede:1"]);
    expect.soft(ev2.audits.filter((a) => a.startsWith("approve:")), "v2 approved once").toEqual(["approve:1"]);
    expect.soft(await entriesInOrg(), "a budget never posts").toBe(0);
  }, 60_000);
});
