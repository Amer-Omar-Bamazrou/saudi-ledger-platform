/**
 * 🔴 B-G08R-P (c3) — PROOF ONLY (owner-approved 2026-10-18), PAYROLL RUNS.
 * Known-failing by design while a defect exists: each assertion states the
 * correct behaviour.
 *
 * Residual R3 (register DR-49). The payroll adapter posts its entry
 * (`PAY-<period>-R<id>`), then sets the status keyed on id only; `onSubmit`,
 * `onSendBack` and `hardDelete` are keyed on id only too. There is no DELETE
 * route for a run. Forced with `helpers/g08rRace.ts`: two approvals at once; a
 * reject, a send-back and a submit, each queued behind an approval.
 * Soft assertions report every consequence.
 *
 * DB-backed (sl_test); skips on the DB-free placeholder. Run through the pre-flight gate.
 */
process.env.PORT ??= "3176";
process.env.SESSION_SECRET ??= "g08r-c3-payroll-proof-00000000000000001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness } from "./helpers/g04Harness";
import { auditsOf, brief, entriesNumbered, queuedBehind, statuses } from "./helpers/g08rRace";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "G08rProofPw123!";

describeMaybe("B-G08R-P (c3) — the G08 races on PAYROLL RUNS", () => {
  const h = g04Harness("g08rc3");
  let orgId = "";
  let month = 0;
  const seqMsg: Record<string, string> = {};
  type Run = { id: number; period: string };

  async function draftRun(): Promise<Run> {
    const period = `2025-${String(++month).padStart(2, "0")}`;
    const r = await h.api("bookkeeper", "POST", "/payroll", { period });
    expect([200, 201], `create run ${period}: ${JSON.stringify(r.body)}`).toContain(r.status);
    return { id: r.body.id as number, period };
  }
  async function evidence(run: Run) {
    const row = (await pool.query(`SELECT status FROM payroll_runs WHERE id = $1`, [run.id])).rows[0] ?? null;
    const items = Number((await pool.query(`SELECT count(*)::int AS n FROM payroll_items WHERE payroll_run_id = $1`, [run.id])).rows[0].n);
    return { run: row, items, gl: await entriesNumbered(orgId, `PAY-${run.period}-R${run.id}`), audits: await auditsOf(orgId, "payroll_run", run.id) };
  }
  const approve = (who: string, id: number) => h.api(who, "POST", `/payroll/${id}/approve`, {});
  const reject = (id: number) => h.api("accountant", "POST", `/payroll/${id}/reject`, {});
  const submit = (id: number) => h.api("bookkeeper", "POST", `/payroll/${id}/submit`, {});
  const sendBack = (id: number) => h.api("accountant", "POST", `/payroll/${id}/send-back`, { note: "please correct" });

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    const companyId = await h.mkCompany(orgId, "G08R-c3 Co", "318181818181876");
    await pool.query(
      `INSERT INTO employees (organization_id, company_id, employee_number, name, nationality, basic_salary, status, gosi_regime) VALUES ($1,$2,'E1','G08R Employee','SA','8000.00','active','law_1421h')`,
      [orgId, companyId],
    );
    for (const [who, role] of [["admin", "admin"], ["accountant", "accountant"], ["bookkeeper", "bookkeeper"]]) await h.mkUser(who, PW, orgId, role);
    await h.start();
    for (const who of ["admin", "accountant", "bookkeeper"]) expect(await h.login(who, h.email(who), PW), `login ${who}`).toBe(200);
  }, 120_000);
  afterAll(async () => { await h.stop(); await h.cleanup(); });

  it("CONTROL (sequential): a run submits, is sent back and rejects; an APPROVED run refuses a second approve, a reject, a submit and a send-back", async () => {
    const a = await draftRun();
    expect((await submit(a.id)).status).toBe(200);
    expect((await sendBack(a.id)).status).toBe(200);
    expect((await reject(a.id)).status, "a draft run rejects").toBe(204);
    const r0 = await draftRun();
    const ok = await approve("admin", r0.id);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const before = await evidence(r0);
    expect(before.run?.status).toBe("approved");
    expect(before.gl, "the approval posted one entry").toHaveLength(1);
    const r = { approveAgain: await approve("accountant", r0.id), reject: await reject(r0.id), submit: await submit(r0.id), sendBack: await sendBack(r0.id) };
    expect(Object.values(r).map((x) => x.status)).toEqual([409, 409, 409, 409]);
    expect(await evidence(r0), "the approved run is untouched by the four refusals").toEqual(before);
    for (const [k, v] of Object.entries(r)) seqMsg[k] = v.body?.error;
  }, 60_000);

  it("🔴 R3 — two approvals of one run at once: one 200, the other the sequential 409; one entry; one approval recorded", async () => {
    const run = await draftRun();
    const rs = await queuedBehind("payroll_runs", run.id, [() => approve("admin", run.id), () => approve("accountant", run.id)]);
    const ev = await evidence(run);
    // eslint-disable-next-line no-console
    console.warn("[G08R-c3] double approve", JSON.stringify({ results: rs.map(brief), ...ev }));
    expect.soft(statuses(rs)).toEqual([200, 409]);
    expect.soft(rs.find((x) => x.status !== 200)?.body?.error, "the loser gets the sequential refusal").toBe(seqMsg.approveAgain);
    expect.soft(ev.gl).toHaveLength(1);
    expect.soft(ev.audits.filter((a) => a.startsWith("approve:"))).toEqual(["approve:1"]);
  }, 60_000);

  it("🔴 R3 — a REJECT queued behind an approval: the approval 200, the reject the sequential 409; the approved run survives with its items and its entry", async () => {
    const run = await draftRun();
    const [ap, lost] = await queuedBehind("payroll_runs", run.id, [() => approve("admin", run.id), () => reject(run.id)]);
    const ev = await evidence(run);
    // eslint-disable-next-line no-console
    console.warn("[G08R-c3] reject behind approve", JSON.stringify({ approve: brief(ap), reject: brief(lost), ...ev }));
    expect(ap.status).toBe(200);
    expect.soft(lost.status).toBe(409);
    expect.soft(lost.body?.error).toBe(seqMsg.reject);
    expect.soft(ev.run?.status, "the approved run still exists, approved").toBe("approved");
    expect.soft(ev.items).toBe(1);
    expect.soft(ev.gl.map((g) => g.status)).toEqual(["posted"]);
  }, 60_000);

  it("🔴 R3 — a SEND-BACK queued behind an approval: the send-back the sequential 409; the approved run stays approved and a later reject is refused", async () => {
    const run = await draftRun();
    expect((await submit(run.id)).status).toBe(200);
    const [ap, back] = await queuedBehind("payroll_runs", run.id, [() => approve("admin", run.id), () => sendBack(run.id)]);
    const afterRace = await evidence(run);
    const later = await reject(run.id);
    const afterReject = await evidence(run);
    // eslint-disable-next-line no-console
    console.warn("[G08R-c3] send-back behind approve", JSON.stringify({ approve: brief(ap), sendBack: brief(back), afterRace, laterReject: brief(later), afterReject }));
    expect(ap.status).toBe(200);
    expect.soft(back.status).toBe(409);
    expect.soft(back.body?.error).toBe(seqMsg.sendBack);
    expect.soft(afterRace.run?.status, "an approved run never returns to draft").toBe("approved");
    expect.soft(later.status, "a later reject of the approved run is refused").toBe(409);
    expect.soft(afterReject.run?.status).toBe("approved");
    expect.soft(afterReject.gl.map((g) => g.status)).toEqual(["posted"]);
  }, 60_000);

  it("🔴 R3 — a SUBMIT queued behind an approval (from draft): the submit the sequential 409; the approved run stays approved", async () => {
    const run = await draftRun();
    const [ap, sub] = await queuedBehind("payroll_runs", run.id, [() => approve("admin", run.id), () => submit(run.id)]);
    const ev = await evidence(run);
    // eslint-disable-next-line no-console
    console.warn("[G08R-c3] submit behind approve", JSON.stringify({ approve: brief(ap), submit: brief(sub), ...ev }));
    expect(ap.status).toBe(200);
    expect.soft(sub.status).toBe(409);
    expect.soft(sub.body?.error).toBe(seqMsg.submit);
    expect.soft(ev.run?.status, "an approved run never returns to submitted").toBe("approved");
  }, 60_000);
});
