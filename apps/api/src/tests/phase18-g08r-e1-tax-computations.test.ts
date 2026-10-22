/**
 * 🔴 Phase 18 decision 2.4 (e1) — PROOF ONLY, TAX COMPUTATIONS
 * (`taxComputationVersionApprovable`). Each assertion states the correct
 * behaviour; a failing soft assertion IS the finding. No product code is
 * changed by this file.
 *
 * The one adapter of the four whose approval POSTS: `onApprove` writes the
 * Zakat / income-tax accrual journal (`INCTAX-<year>-<computation>-V<n>`, the
 * difference from what earlier versions accrued) and supersedes the prior
 * approved version. It is NOT on compare-and-set (approval-compare-and-set-
 * ratchet), but by reading it is serialised another way: every transition's
 * service wrapper locks the version (`loadVersionOf` → `lockVersion`, SELECT …
 * FOR UPDATE) and the adapter's `load` locks it again; the edits (adjustments)
 * lock it too; and migration 0113's `tax_computation_versions_guard` refuses an
 * illegal step or the deletion of an approved version at the database. Reading
 * is not proof — so each interleaving is FORCED with `helpers/g08rRace.ts` (a
 * holder locks the version row; each act is SEEN waiting inside the holder's
 * wait tree before the next is sent):
 *  - two approvals; a reject, a send-back and a submit, each queued behind an
 *    approval; an approval queued behind a reject;
 *  - an edit (an adjustment) queued behind an approval, and an approval queued
 *    behind an edit;
 *  - a DELETE of the computation queued behind an approval, and an approval
 *    queued behind a DELETE;
 *  - a REVISION: two approvals of v2 at once — one difference entry, v1
 *    superseded once.
 *
 * The invariant: one winner; the loser gets the refusal it gets sequentially
 * (the CONTROL captures each); never a 5xx; the accrual is posted ONCE (one
 * entry per version, two lines), the posted version and its entry survive
 * (no orphaned journal, no version without its entry), and the figure is the
 * same computed two ways (the version's frozen result = the income-tax expense
 * the ledger holds for the computation).
 *
 * Fixture: a FOREIGN-owned company (income tax, Art. 2), Gregorian fiscal year
 * from January; a nil Art. 17 pool anchor for 2013 (so every year 2014–2025
 * computes); a 100,000 sale in each year, posted through the product — income
 * tax 20 % = 20,000 a year. One computation per (company, kind, year), so each
 * case takes its own year.
 *
 * DB-backed (sl_test); skips on the DB-free placeholder. Run through the pre-flight gate.
 */
process.env.PORT ??= "3190";
process.env.SESSION_SECRET ??= "g08r-e1-tax-computations-proof-00000001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { g04Harness, type Res } from "./helpers/g04Harness";
import { auditsOf, brief, entriesNumbered, queuedBehind, statuses } from "./helpers/g08rRace";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "G08rProofPw123!";
const ANCHOR = 2013;
const YEARS = Array.from({ length: 12 }, (_, i) => 2014 + i); // 2014 … 2025, all ended before 2026-10
const SALE = 100_000;
const TAX = "20000.00";
const ADJUSTMENT = { target: "taxable_income", effect: "increase", amount: 10_000, reason: "G08R-E1 race probe", legalReference: "Income Tax Law Art. 9" };

describeMaybe("Phase 18 (e1) — the approval-flow races on TAX COMPUTATIONS (income tax)", () => {
  const h = g04Harness("g08re1");
  let orgId = "";
  let companyId = "";
  let inventory = 0;
  let sales = 0;
  let jeSeq = 0;
  const seq: Record<string, Res> = {};
  type C = { id: number; versionId: number; versionNo: number; year: number };

  async function postSale(year: number, amount: number, date = `${year}-06-30`): Promise<void> {
    const je = await h.api("bookkeeper", "POST", "/journal-entries", {
      entryNumber: `G08RE1-SALE-${++jeSeq}`, date, description: `G08R-E1 sale ${year}`,
      lines: [
        { accountId: inventory, accountName: "inventory", debitAmount: amount, creditAmount: 0 },
        { accountId: sales, accountName: "sales", debitAmount: 0, creditAmount: amount },
      ],
    });
    expect(je.status, `JE ${year}: ${JSON.stringify(je.body)}`).toBe(201);
    const ap = await h.api("admin", "POST", `/journal-entries/${je.body.id}/approve`, {});
    expect(ap.status, `JE approve ${year}: ${JSON.stringify(ap.body)}`).toBe(200);
  }
  async function draft(year: number): Promise<C> {
    const r = await h.api("bookkeeper", "POST", "/tax/computations", { kind: "income_tax", fiscalYearLabel: year });
    expect(r.status, `create computation ${year}: ${JSON.stringify(r.body)}`).toBe(201);
    expect(r.body.live?.blockers, `computation ${year} is computable`).toEqual([]);
    return { id: r.body.id as number, versionId: r.body.version.id as number, versionNo: r.body.version.versionNo as number, year };
  }
  const entryNo = (c: C) => `INCTAX-${c.year}-${c.id}-V${c.versionNo}`;
  async function evidence(c: C) {
    const computation = (await pool.query(`SELECT 1 FROM tax_computations WHERE id = $1`, [c.id])).rowCount;
    const version = (await pool.query(
      `SELECT version_no, status, result_amount::text AS result, accrued_amount::text AS accrued, accrual_journal_entry_id AS entry_id FROM tax_computation_versions WHERE id = $1`, [c.versionId],
    )).rows[0] ?? null;
    const entries = await entriesNumbered(orgId, entryNo(c));
    // the same figure computed the other way: the income-tax expense the ledger holds for THIS computation's accruals
    const ledgerExpense = (await pool.query(
      `SELECT coalesce(sum(l.debit_amount - l.credit_amount), 0)::numeric(15,2)::text AS v
         FROM journal_entry_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN categories k ON k.id = l.account_id
        WHERE e.organization_id = $1 AND e.entry_number LIKE $2 AND k.system_code = 'INCOME_TAX_EXPENSE' AND e.status IN ('posted','reversed')`,
      [orgId, `INCTAX-${c.year}-${c.id}-V%`],
    )).rows[0].v as string;
    const adjustments = (await pool.query(`SELECT count(*)::int AS n FROM tax_adjustments WHERE version_id = $1`, [c.versionId])).rows[0].n as number;
    return { computation, version, entries, ledgerExpense, adjustments, audits: await auditsOf(orgId, "tax_computation_version", c.versionId) };
  }

  const v = (c: C, act: string) => `/tax/computations/${c.id}/versions/${c.versionId}/${act}`;
  const approve = (who: string, c: C) => h.api(who, "POST", v(c, "approve"), {});
  const reject = (c: C) => h.api("accountant", "POST", v(c, "reject"), {});
  const submit = (c: C) => h.api("bookkeeper", "POST", v(c, "submit"), {});
  const sendBack = (c: C) => h.api("accountant", "POST", v(c, "send-back"), { note: "please correct" });
  const edit = (c: C) => h.api("bookkeeper", "POST", v(c, "adjustments"), ADJUSTMENT);
  const del = (c: C) => h.api("admin", "DELETE", `/tax/computations/${c.id}`);
  // eslint-disable-next-line no-console
  const log = (label: string, ev: unknown) => console.warn(`[G08R-e1] ${label}`, JSON.stringify(ev));

  beforeAll(async () => {
    await h.cleanup();
    orgId = await h.mkOrg("org");
    companyId = (await pool.query(
      `INSERT INTO companies (organization_id, name, cr_number, vat_number, fiscal_year_start, fiscal_calendar, ownership_type, foreign_ownership_pct)
       VALUES ($1,'G08R-e1 Foreign Co','1010404040','318181818181891',1,'gregorian','FOREIGN',100) RETURNING id`, [orgId],
    )).rows[0].id;
    const cat = async (name: string, type: string, liquidity: string | null) =>
      (await pool.query(`INSERT INTO categories (organization_id, name, name_ar, type, vat_applicable, liquidity_class) VALUES ($1,$2,$2,$3,false,$4) RETURNING id`, [orgId, name, type, liquidity])).rows[0].id as number;
    inventory = await cat("G08R-E1 goods", "asset", "current");
    sales = await cat("G08R-E1 sales", "income", null);
    for (const [who, role] of [["admin", "admin"], ["accountant", "accountant"], ["bookkeeper", "bookkeeper"]]) await h.mkUser(who, PW, orgId, role);
    await h.start();
    for (const who of ["admin", "accountant", "bookkeeper"]) expect(await h.login(who, h.email(who), PW), `login ${who}`).toBe(200);
    // the Art. 17 pool: a nil anchor for every group, so the pool computes for every later year (no assets → no deduction)
    for (const g of [1, 2, 3, 4, 5]) {
      const d = await h.api("admin", "POST", "/assets/income-tax-pool/declarations", { incomeTaxGroup: g, taxYear: ANCHOR, closingBalanceDeclared: 0, additionsDeclared: 0, disposalsDeclared: 0 });
      expect([200, 201], `pool anchor group ${g}: ${JSON.stringify(d.body)}`).toContain(d.status);
    }
    for (const y of YEARS) await postSale(y, SALE);
  }, 240_000);
  afterAll(async () => { await h.stop(); await h.cleanup(); });

  it("CONTROL (sequential): each act works alone, the approval posts ONE accrual, and each refusal a race loser should get is captured", async () => {
    expect(companyId).not.toBe("");
    // a draft: an adjustment edits it, submit and send-back move it, reject removes it (and the computation with it)
    const a = await draft(2014);
    expect((await edit(a)).status, "a draft version takes an adjustment").toBe(200);
    expect((await evidence(a)).adjustments, "anti-vacuity: the edit probe changes a draft").toBe(1);
    expect((await submit(a)).status).toBe(200);
    expect((await sendBack(a)).status).toBe(200);
    expect((await evidence(a)).version?.status).toBe("draft");
    expect((await reject(a)).status).toBe(204);
    expect([(await evidence(a)).version, (await evidence(a)).computation], "a reject removes the draft and its computation").toEqual([null, 0]);
    seq.approveGone = await approve("admin", a);
    expect(seq.approveGone.status, "approving a removed version answers 404").toBe(404);
    const d = await draft(2014);
    expect((await del(d)).status, "a never-approved computation deletes").toBe(204);
    seq.approveDeleted = await approve("admin", d);
    expect(seq.approveDeleted.status, "approving a version of a deleted computation answers 404").toBe(404);
    expect(await entriesNumbered(orgId, entryNo(a)), "nothing was posted for a removed draft").toEqual([]);

    // an APPROVED version: one accrual entry (2 lines), the same figure two ways; then six refusals that move nothing
    const p = await draft(2015);
    const ok = await approve("admin", p);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const before = await evidence(p);
    expect([before.version?.status, before.version?.result, before.version?.accrued]).toEqual(["approved", TAX, TAX]);
    expect(before.entries.map((e) => [e.status, e.lines]), "the approval posted ONE entry").toEqual([["posted", 2]]);
    expect(before.version?.entry_id, "the version names its entry").toBe(before.entries[0]?.id);
    expect(before.ledgerExpense, "the frozen result = the expense in the ledger").toBe(TAX);
    seq.approveAgain = await approve("accountant", p);
    seq.reject = await reject(p);
    seq.submit = await submit(p);
    seq.sendBack = await sendBack(p);
    seq.edit = await edit(p);
    seq.del = await del(p);
    expect([seq.approveAgain, seq.reject, seq.submit, seq.sendBack, seq.edit, seq.del].map((x) => x.status)).toEqual([409, 409, 409, 409, 409, 409]);
    expect(await evidence(p), "the approved version and its entry are untouched by the six refusals").toEqual(before);
    log("CONTROL refusals", Object.fromEntries(Object.entries(seq).map(([k, x]) => [k, brief(x)])));
  }, 120_000);

  /** The posted state every "X behind an approval" case must leave. */
  function expectPostedOnce(ev: Awaited<ReturnType<typeof evidence>>, amount = TAX) {
    expect.soft([ev.computation, ev.version?.status, ev.version?.result], "the computation and its approved version survive").toEqual([1, "approved", amount]);
    expect.soft(ev.entries.map((e) => [e.status, e.lines]), "ONE accrual entry, posted, two lines").toEqual([["posted", 2]]);
    expect.soft(ev.version?.entry_id, "the version still names its entry (no orphaned journal)").toBe(ev.entries[0]?.id);
    expect.soft(ev.ledgerExpense, "the frozen result = the expense in the ledger").toBe(amount);
    expect.soft(ev.audits.filter((a) => a.startsWith("approve:")), "one approval recorded").toEqual(["approve:1"]);
  }

  it("two approvals of one version at once: one 200, the other the sequential 409; ONE accrual posted", async () => {
    const c = await draft(2016);
    const rs = await queuedBehind("tax_computation_versions", c.versionId, [() => approve("admin", c), () => approve("accountant", c)]);
    const ev = await evidence(c);
    log("double approve", { results: rs.map(brief), ...ev });
    expect.soft(rs.every((r) => r.status < 500), "never a 5xx").toBe(true);
    expect.soft(statuses(rs)).toEqual([200, 409]);
    const loser = rs.find((x) => x.status !== 200);
    expect.soft([loser?.body?.code, loser?.body?.error], "the loser gets the sequential refusal").toEqual([seq.approveAgain?.body?.code, seq.approveAgain?.body?.error]);
    expectPostedOnce(ev);
  }, 90_000);

  for (const [label, act, key, from, year] of [
    ["REJECT", reject, "reject", "draft", 2017],
    ["SEND-BACK", sendBack, "sendBack", "submitted", 2018],
    ["SUBMIT", submit, "submit", "draft", 2019],
  ] as const) {
    it(`a ${label} queued behind an approval (from ${from}): the approval 200, the ${label.toLowerCase()} the sequential 409; the posted version and its entry survive`, async () => {
      const c = await draft(year);
      if (from === "submitted") expect((await submit(c)).status).toBe(200);
      const [ap, lost] = await queuedBehind("tax_computation_versions", c.versionId, [() => approve("admin", c), () => act(c)]);
      const ev = await evidence(c);
      log(`${label.toLowerCase()} behind approve`, { approve: brief(ap), [label.toLowerCase()]: brief(lost), ...ev });
      expect(ap.status).toBe(200);
      expect.soft(lost.status).toBe(409);
      expect.soft([lost.body?.code, lost.body?.error], "the loser gets the sequential refusal").toEqual([seq[key]?.body?.code, seq[key]?.body?.error]);
      expectPostedOnce(ev);
    }, 90_000);
  }

  it("an APPROVAL queued behind a REJECT: the reject 204, the approval refused 404 (never a 5xx); NOTHING posted", async () => {
    const c = await draft(2020);
    const [rej, ap] = await queuedBehind("tax_computation_versions", c.versionId, [() => reject(c), () => approve("admin", c)]);
    const ev = await evidence(c);
    log("approve behind reject", { reject: brief(rej), approve: brief(ap), ...ev });
    expect(rej.status).toBe(204);
    expect.soft(ap.status < 500, "never a 5xx").toBe(true);
    expect.soft(ap.status, "refused as sequentially").toBe(seq.approveGone?.status);
    expect.soft([ev.computation, ev.version], "the computation is gone").toEqual([0, null]);
    expect.soft(ev.entries, "no accrual posted for a removed version").toEqual([]);
    expect.soft(ev.ledgerExpense).toBe("0.00");
    // wording: sequentially the computation is found missing first ("Tax computation not found.")
    expect.soft(ap.body?.error, "the sequential refusal text").toBe(seq.approveGone?.body?.error);
  }, 90_000);

  it("an EDIT (adjustment) queued behind an approval: the edit the sequential 409 (locked); the approved figure and its entry are unchanged", async () => {
    const c = await draft(2021);
    const [ap, ed] = await queuedBehind("tax_computation_versions", c.versionId, [() => approve("admin", c), () => edit(c)]);
    const ev = await evidence(c);
    log("edit behind approve", { approve: brief(ap), edit: brief(ed), ...ev });
    expect(ap.status).toBe(200);
    expect.soft(ed.status).toBe(409);
    expect.soft(ed.body?.code, "the loser gets the sequential refusal").toBe(seq.edit?.body?.code);
    expect.soft(ev.adjustments, "no adjustment lands on the approved version").toBe(0);
    expectPostedOnce(ev);
  }, 90_000);

  it("an APPROVAL queued behind an EDIT: both 200 — the sequential order (edit, then approve); the approval accrues the adjusted figure, once", async () => {
    const c = await draft(2022);
    const [ed, ap] = await queuedBehind("tax_computation_versions", c.versionId, [() => edit(c), () => approve("admin", c)]);
    const ev = await evidence(c);
    log("approve behind edit", { edit: brief(ed), approve: brief(ap), ...ev });
    expect.soft([ed.status, ap.status]).toEqual([200, 200]);
    expect.soft(ev.adjustments).toBe(1);
    expectPostedOnce(ev, "22000.00"); // 20 % of (100,000 + the 10,000 adjustment)
  }, 90_000);

  it("a DELETE of the computation queued behind an approval: the approval 200, the DELETE refused 409; the computation, its approved version and its entry survive", async () => {
    const c = await draft(2023);
    const [ap, rm] = await queuedBehind("tax_computation_versions", c.versionId, [() => approve("admin", c), () => del(c)]);
    const ev = await evidence(c);
    log("delete behind approve", { approve: brief(ap), delete: brief(rm), ...ev });
    expect(ap.status).toBe(200);
    expect.soft(rm.status < 500, "never a 5xx").toBe(true);
    expect.soft(rm.status, "the DELETE is refused").toBe(409);
    expectPostedOnce(ev);
    // wording: the sequential refusal names the rule; a refusal raised by the database trigger instead is reported, not hidden
    expect.soft([rm.body?.code, rm.body?.error], "the loser gets the sequential refusal (code and text)").toEqual([seq.del?.body?.code, seq.del?.body?.error]);
  }, 90_000);

  it("an APPROVAL queued behind a DELETE of the computation: the DELETE 204, the approval refused 404 (never a 5xx); NOTHING posted", async () => {
    const c = await draft(2024);
    const [rm, ap] = await queuedBehind("tax_computation_versions", c.versionId, [() => del(c), () => approve("admin", c)]);
    const ev = await evidence(c);
    log("approve behind delete", { delete: brief(rm), approve: brief(ap), ...ev });
    expect(rm.status).toBe(204);
    expect.soft(ap.status < 500, "never a 5xx").toBe(true);
    expect.soft(ap.status, "refused as sequentially").toBe(seq.approveDeleted?.status);
    expect.soft([ev.computation, ev.version], "the computation is gone").toEqual([0, null]);
    expect.soft(ev.entries, "no accrual posted for a deleted computation").toEqual([]);
    expect.soft(ev.ledgerExpense).toBe("0.00");
    expect.soft(ap.body?.error, "the sequential refusal text").toBe(seq.approveDeleted?.body?.error);
  }, 90_000);

  it("a REVISION: two approvals of v2 at once — one 200, the other the sequential 409; ONE difference entry; v1 superseded once; Σ accruals = the approved figure", async () => {
    const c1 = await draft(2025);
    expect((await approve("admin", c1)).status).toBe(200);
    await postSale(2025, 10_000, "2025-09-30"); // the year moved: income tax 22,000 now, 2,000 more than v1 accrued
    const rev = await h.api("bookkeeper", "POST", `/tax/computations/${c1.id}/versions`, {});
    expect(rev.status, JSON.stringify(rev.body)).toBe(200); // tax `revise` answers 200 with the detail (tax.controller.ts)
    const c2: C = { id: c1.id, versionId: rev.body.version.id as number, versionNo: rev.body.version.versionNo as number, year: 2025 };
    expect(c2.versionNo).toBe(2);
    const rs = await queuedBehind("tax_computation_versions", c2.versionId, [() => approve("admin", c2), () => approve("accountant", c2)]);
    const ev1 = await evidence(c1);
    const ev2 = await evidence(c2);
    const versions = (await pool.query(`SELECT version_no, status, accrued_amount::text AS accrued FROM tax_computation_versions WHERE computation_id = $1 ORDER BY version_no`, [c1.id])).rows;
    const accruedSum = versions.reduce((s, r) => s + Number(r.accrued ?? 0), 0).toFixed(2);
    log("revision double approve", { results: rs.map(brief), v1: ev1, v2: ev2, versions, accruedSum });
    expect.soft(rs.every((r) => r.status < 500), "never a 5xx").toBe(true);
    expect.soft(statuses(rs)).toEqual([200, 409]);
    expect.soft(rs.find((x) => x.status !== 200)?.body?.code).toBe(seq.approveAgain?.body?.code);
    expect.soft([ev1.version?.status, ev2.version?.status, ev2.version?.result, ev2.version?.accrued]).toEqual(["superseded", "approved", "22000.00", "2000.00"]);
    expect.soft(ev2.entries.map((e) => [e.status, e.lines]), "ONE difference entry for v2").toEqual([["posted", 2]]);
    expect.soft(ev1.entries.map((e) => [e.status, e.lines]), "v1's entry stands").toEqual([["posted", 2]]);
    expect.soft(ev1.audits.filter((a) => a.startsWith("supersede:")), "v1 superseded once").toEqual(["supersede:1"]);
    expect.soft(ev2.audits.filter((a) => a.startsWith("approve:")), "v2 approved once").toEqual(["approve:1"]);
    expect.soft([accruedSum, ev2.ledgerExpense], "Σ accruals = the ledger's expense = the approved figure").toEqual(["22000.00", "22000.00"]);
  }, 120_000);
});
