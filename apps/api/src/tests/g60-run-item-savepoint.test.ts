/**
 * G60 / DR-47 (2026-10-15) — each item of a month-end run in its OWN SAVEPOINT.
 *
 * The defect (proof: `phase18-s1-g60-run-rollback.test.ts`, reproduced on main
 * fd27364e): a database error inside one item of the depreciation or the
 * recognition run aborted the request's transaction; the run carried on,
 * answered 200, and listed as "posted" entries the rollback had removed.
 *
 * Beyond the proof's own invariant, this file holds:
 *  - CONTINUATION: the item AFTER a failed one still posts (the fault sits in
 *    the middle) — what a savepoint gives and a stopped run would not;
 *  - ATOMICITY: the failed item leaves no entry, no posted mark, no asset event
 *    and no audit row, while every posted item has each of them;
 *  - FIGURES: the posted amounts, computed here from the assets' cost and life
 *    and from the schedules' totals, equal the ledger's lines and the run's
 *    total — one figure three ways, non-zero;
 *  - SAFE REASONS: a skipped item's reason names its entry number and carries
 *    no SQL or parameters (the probe is shown to catch the old reason first);
 *    our own refusals pass through unchanged;
 *  - ORDER: the recognition run posts in id order on a fixture whose PHYSICAL
 *    order is not id order — asserted as a precondition, never assumed;
 *  - ISOLATION: company B's and organization Y's due items are absent from
 *    company A's runs and post in their own (presence, absence, movement);
 *  - CLOSED MONTHS, unchanged: a closed month stops the depreciation run with
 *    423 and nothing posted; the recognition run reports each schedule;
 *  - the savepoint helper on its own: an error inside is rolled back to the
 *    savepoint and the transaction stays usable; a transaction already aborted
 *    makes the helper THROW, never report an item.
 *
 * No browser leg (owner, 2026-10-15): no screen and no job calls either run.
 *
 * Test data: organizations and users prefixed `g60fix-`, removed by the
 * harness's prefix-scoped cleanup. This file deliberately does NOT call the
 * rate-limit reset hook, which also deletes other processes' expired rows.
 *
 * DB-backed parts skip on the DB-free placeholder; the reason mapper's unit
 * tests always run.
 */

process.env.PORT ??= "3143";
process.env.SESSION_SECRET ??= "g60-run-item-savepoint-session-secret-01";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { pool, db, beginTenantConnection } from "@workspace/db";
import { BusinessRuleError, PeriodLockedError } from "../lib/errors";
import { logger } from "../lib/logger";
import { round2 } from "../lib/money";
import { runItemFailure } from "../lib/runItemFailure";
import { withSavepoint } from "../lib/savepoint";
import { assetsService } from "../services/assets.service";
import { assetCapitalisationService } from "../services/assets/capitalisation.service";
import { billsService } from "../services/bills.service";
import { periodLocksService } from "../services/periodLocks.service";
import { recognitionSchedulesService } from "../services/accounting/recognitionSchedules.service";
import { g04Harness } from "./helpers/g04Harness";

/** The ways a database error's text gives itself away. Empty means the reason is safe to show. */
const SQL_TELLS = [/failed query/i, /insert into/i, /\bparams\b/i, /journal_entries/i, /\$\d/, /\b(select|update|delete) /i];
const leaks = (reason: string) => SQL_TELLS.filter((re) => re.test(reason)).map(String);

/** The error drizzle throws for a failed query: the SQL and its parameters in the message, the driver's error in `cause`. */
const drizzleError = (code: string, constraint?: string) =>
  Object.assign(
    new Error(`Failed query: insert into "journal_entries" ("id", "entry_number") values (default, $1)\nparams: DEP-FA-00002-2026-08`),
    { cause: { code, constraint, message: "duplicate key value violates unique constraint" } },
  );

describe("G60 — what a run says about an item that did not post (runItemFailure)", () => {
  const item = { label: "asset FA-00002", entryNumber: "DEP-FA-00002-2026-08", log: { run: "test" } };

  it("the probe is not vacuous: the reason the runs used to send (the raw driver message) is caught by it", () => {
    expect(leaks(drizzleError("23505").message).length).toBeGreaterThan(0);
  });

  it("our own refusals pass through unchanged — code and sentence (the G55 'another company' refusal is one)", () => {
    const g55 = new BusinessRuleError(422, { code: "reference_not_found", error: "This is the cash account of a bank account that belongs to another company." });
    expect(runItemFailure(g55, item)).toEqual({ code: "reference_not_found", reason: g55.message });
    const lock = new PeriodLockedError("The books for 2026-08 are closed.", { period: "2026-08", lockedAt: "2026-09-01" });
    expect(runItemFailure(lock, item)).toEqual({ code: "period_closed", reason: "The books for 2026-08 are closed." });
  });

  it("🔴 a taken entry number is NAMED, and the SQL and its parameters are not sent; the error goes to the server log", () => {
    const log = vi.spyOn(logger, "error").mockImplementation(() => undefined as never);
    try {
      const out = runItemFailure(drizzleError("23505", "journal_entries_company_number_unq"), item);
      expect(out.code).toBe("entry_number_taken");
      expect(out.reason).toContain("DEP-FA-00002-2026-08");
      expect(out.reason).toContain("asset FA-00002");
      expect(leaks(out.reason)).toEqual([]);
      expect(log).toHaveBeenCalledTimes(1);
    } finally {
      log.mockRestore();
    }
  });

  it("any other database error, and any non-database error, gets a fixed sentence — never the error's own text", () => {
    const log = vi.spyOn(logger, "error").mockImplementation(() => undefined as never);
    try {
      const dbErr = runItemFailure(drizzleError("23514", "some_check"), item);
      expect(dbErr.code).toBe("database_error");
      expect(leaks(dbErr.reason)).toEqual([]);
      const js = runItemFailure(new TypeError("Cannot read properties of undefined (reading 'amount') at /srv/app/x.ts:12"), item);
      expect(js.code).toBe("unknown");
      expect(js.reason).not.toContain("Cannot read properties");
      expect(js.reason).not.toContain("/srv/app");
      expect(log).toHaveBeenCalledTimes(2);
    } finally {
      log.mockRestore();
    }
  });
});

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

const PW = "G60FixPw12345!";
const LIFE = 48; // months, the categories' default useful life; residual 0, straight line

describeMaybe("G60 — the month-end runs, each item in its own savepoint (real rows, over HTTP)", () => {
  const h = g04Harness("g60fix");
  let orgX = "", coA = "", coB = "", orgY = "", coY = "";
  let adminX = 0, adminY = 0;
  type Asset = { id: number; number: string; cost: number };
  type Schedule = { id: number; ref: string; total: number };
  let assetsA: Asset[] = [];
  let assetB: Asset, assetY: Asset;
  let schedulesA: Schedule[] = [];
  let scheduleB: Schedule;
  let depRunA: { posted: Array<{ assetId: number }> } | null = null;
  let recRunA: { posted: Array<{ scheduleId: number }> } | null = null;

  const accountOf = async (orgId: string, code: string) =>
    (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = $2 AND is_posting`, [orgId, code])).rows[0].id as number;
  const one = async (q: string, p: unknown[]) => (await pool.query(q, p)).rows[0];
  const count = async (q: string, p: unknown[]) => Number((await one(q, p)).n);

  async function capitalised(orgId: string, companyId: string, userId: number, vendorId: number, categoryId: number, n: string, cost: number): Promise<Asset> {
    const asset = await h.inTenant(orgId, companyId, userId, () => assetsService.create({ name: `G60 asset ${n}`, categoryId, acquisitionDate: "2026-07-01", availableForUseDate: "2026-07-01", cost, residualValue: 0, vatInputTaxAmount: cost * 0.15 }, userId));
    const bill = await h.inTenant(orgId, companyId, userId, () => billsService.create({ supplierDocumentKind: "tax_invoice", vendorReference: `G60FIX-SUP-${n}`, billNumber: `G60FIX-BILL-${n}`, date: "2026-07-01", vendorId, subtotal: cost, vatAmount: cost * 0.15, total: cost * 1.15, capitalisesAssetId: asset.id, items: [{ description: "Asset purchase", quantity: 1, unitPrice: cost }] }, userId));
    await h.inTenant(orgId, companyId, userId, () => billsService.approve(bill.id, {}, userId));
    const number = (await one(`SELECT asset_number FROM fixed_assets WHERE id = $1`, [asset.id])).asset_number as string;
    return { id: asset.id, number, cost };
  }

  async function activeSchedule(orgId: string, companyId: string, userId: number, ref: string, total: number): Promise<Schedule> {
    const s = await h.inTenant(orgId, companyId, userId, async () => recognitionSchedulesService.create({ kind: "prepayment", totalAmount: total, periods: 3, startPeriod: "2026-10", description: `G60 ${ref}`, expenseAccountId: await accountOf(orgId, "RENT_UTILITIES"), balanceAccountId: await accountOf(orgId, "PREPAID_EXPENSES"), reference: ref }, userId));
    await h.inTenant(orgId, companyId, userId, () => recognitionSchedulesService.activate(s.id, {}, userId));
    return { id: s.id, ref, total };
  }

  /**
   * A bookkeeper's DRAFT journal entry carrying a number a run is about to generate (the natural fault).
   * 🔴 T1d (SG-11, 0129): a user can no longer TYPE a document's number (`DEP-…`: 422 `entry_number_reserved`),
   * so that one is written the way a draft from before 0129 stands (no source_type), in the HTTP company (coA).
   * A recognition number (`<reference>-<period>`) is not reserved, and is still typed through the API.
   */
  async function draftNumbered(orgId: string, entryNumber: string, date: string) {
    if (/^DEP-/i.test(entryNumber)) {
      const { rows: [e] } = await pool.query(
        `INSERT INTO journal_entries (organization_id, company_id, entry_number, date, description, status)
         VALUES ($1, $2, $3, $4, 'G60 — a draft that happens to carry this number', 'draft') RETURNING id`, [orgId, coA, entryNumber, date]);
      await pool.query(
        `INSERT INTO journal_entry_lines (organization_id, company_id, journal_entry_id, account_id, account_name, debit_amount, credit_amount)
         VALUES ($1, $2, $3, $4, 'debit', 10, 0), ($1, $2, $3, $5, 'credit', 0, 10)`,
        [orgId, coA, e.id, await accountOf(orgId, "RENT_UTILITIES"), await accountOf(orgId, "OTHER_INCOME")]);
      return;
    }
    const r = await h.api("bookkeeper", "POST", "/journal-entries", {
      entryNumber, date, description: "G60 — a draft that happens to carry this number",
      lines: [
        { accountId: await accountOf(orgId, "RENT_UTILITIES"), accountName: "debit", debitAmount: 10, creditAmount: 0 },
        { accountId: await accountOf(orgId, "OTHER_INCOME"), accountName: "credit", debitAmount: 0, creditAmount: 10 },
      ],
    });
    expect(r.status, `draft ${entryNumber}: ${JSON.stringify(r.body)}`).toBe(201);
  }

  /** In-books lines of these entries: Σ debit and Σ credit. */
  const lineTotals = async (ids: number[]) => {
    const r = await one(`SELECT COALESCE(sum(debit_amount), 0)::numeric AS d, COALESCE(sum(credit_amount), 0)::numeric AS c FROM journal_entry_lines WHERE journal_entry_id = ANY($1::int[])`, [ids]);
    return { debit: Number(r.d), credit: Number(r.c) };
  };

  beforeAll(async () => {
    await h.cleanup();
    orgX = await h.mkOrg("x");
    coA = await h.mkCompany(orgX, "G60 Fix A", "319191919191913"); // first-created: the company HTTP acts as
    coB = await h.mkCompany(orgX, "G60 Fix B", "319191919191923");
    orgY = await h.mkOrg("y");
    coY = await h.mkCompany(orgY, "G60 Fix Y", "319191919191933");
    adminX = await h.mkUser("admin", PW, orgX, "admin");
    await h.mkUser("bookkeeper", PW, orgX, "bookkeeper");
    adminY = await h.mkUser("adminy", PW, orgY, "admin");
    await h.mkUser("bookkeepery", PW, orgY, "bookkeeper");
    const vendor = async (orgId: string) =>
      (await pool.query(`INSERT INTO vendors (organization_id, name, tax_number) VALUES ($1,'G60 Equipment Supplier','300000000000003') RETURNING id`, [orgId])).rows[0].id as number;
    const vendorX = await vendor(orgX);
    const vendorY = await vendor(orgY);
    const category = (orgId: string, companyId: string, userId: number, name: string) =>
      h.inTenant(orgId, companyId, userId, () => assetsService.createCategory({ name, defaultUsefulLifeMonths: LIFE, incomeTaxGroup: 3, vatCapitalAssetClass: "movable" }, userId));
    const catA = await category(orgX, coA, adminX, "G60 Computers A");
    const catB = await category(orgX, coB, adminX, "G60 Computers B");
    const catY = await category(orgY, coY, adminY, "G60 Computers Y");
    // Three assets in company A with distinct monthly charges (250, 500, 100); one each in B and Y.
    assetsA = [
      await capitalised(orgX, coA, adminX, vendorX, catA.id, "A1", 12_000),
      await capitalised(orgX, coA, adminX, vendorX, catA.id, "A2", 24_000),
      await capitalised(orgX, coA, adminX, vendorX, catA.id, "A3", 4_800),
    ];
    assetB = await capitalised(orgX, coB, adminX, vendorX, catB.id, "B1", 9_600);
    assetY = await capitalised(orgY, coY, adminY, vendorY, catY.id, "Y1", 6_000);
    // Three schedules in company A (100, 200, 300 a month), one in B.
    schedulesA = [
      await activeSchedule(orgX, coA, adminX, "G60FIX-RA", 300),
      await activeSchedule(orgX, coA, adminX, "G60FIX-RB", 600),
      await activeSchedule(orgX, coA, adminX, "G60FIX-RC", 900),
    ];
    scheduleB = await activeSchedule(orgX, coB, adminX, "G60FIX-SB", 1_200);
    await h.start();
    for (const who of ["admin", "bookkeeper", "adminy", "bookkeepery"]) expect(await h.login(who, h.email(who), PW), `login ${who}`).toBe(200);
  }, 240_000);

  afterAll(async () => {
    await h.stop();
    await h.cleanup();
  });

  it("🔴 DEPRECIATION: the asset AFTER a failed one still posts; the failed one leaves nothing; the posted ones are whole, and their figure agrees three ways", async () => {
    const period = "2026-07";
    const [a1, a2, a3] = assetsA;
    const taken = `DEP-${a2.number}-${period}`;
    await draftNumbered(orgX, taken, "2026-07-15");

    const r = await h.api("bookkeeper", "POST", "/assets/depreciation-runs", { period });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    depRunA = r.body;
    expect(r.body.posted.map((p: { assetId: number }) => p.assetId), "a1 before the failure AND a3 after it").toEqual([a1.id, a3.id]);
    expect(r.body.skipped.map((s: { assetId: number }) => s.assetId)).toEqual([a2.id]);
    const skip = r.body.skipped[0] as { code: string; reason: string };
    expect(skip.code).toBe("entry_number_taken");
    expect(skip.reason).toContain(taken);
    expect(leaks(skip.reason), skip.reason).toEqual([]);

    // Every entry the run reports exists, posted, in company A, under the right number.
    const ids = r.body.posted.map((p: { journalEntryId: number }) => p.journalEntryId) as number[];
    const entries = (await pool.query(`SELECT entry_number, status, company_id FROM journal_entries WHERE id = ANY($1::int[]) ORDER BY id`, [ids])).rows;
    expect(entries).toEqual([
      { entry_number: `DEP-${a1.number}-${period}`, status: "posted", company_id: coA },
      { entry_number: `DEP-${a3.number}-${period}`, status: "posted", company_id: coA },
    ]);

    // One figure, three ways: cost ÷ life (computed here), the run's own total, the ledger's lines.
    const expected = round2(a1.cost / LIFE + a3.cost / LIFE);
    expect(expected).toBe(350);
    expect(r.body.posted.map((p: { amount: number }) => p.amount)).toEqual([a1.cost / LIFE, a3.cost / LIFE]);
    expect(r.body.totalAmount).toBe(expected);
    expect(await lineTotals(ids)).toEqual({ debit: expected, credit: expected });

    // Each posted asset is whole: its schedule row points at its entry, and its event (the register's audit row) exists.
    for (const [a, id] of [[a1, ids[0]], [a3, ids[1]]] as const) {
      expect((await one(`SELECT journal_entry_id FROM asset_depreciation_schedule WHERE asset_id = $1 AND period = $2`, [a.id, period])).journal_entry_id).toBe(id);
      expect(await count(`SELECT count(*) n FROM asset_events WHERE asset_id = $1 AND kind = 'depreciated' AND journal_entry_id = $2`, [a.id, id])).toBe(1);
    }
    // The failed asset left nothing: no posted mark, no entry but the bookkeeper's draft, no event.
    expect((await one(`SELECT journal_entry_id FROM asset_depreciation_schedule WHERE asset_id = $1 AND period = $2`, [a2.id, period])).journal_entry_id).toBeNull();
    expect((await pool.query(`SELECT status FROM journal_entries WHERE company_id = $1 AND entry_number = $2`, [coA, taken])).rows).toEqual([{ status: "draft" }]);
    expect(await count(`SELECT count(*) n FROM asset_events WHERE asset_id = $1 AND kind = 'depreciated'`, [a2.id])).toBe(0);
  });

  it("🔴 RECOGNITION: id order on a table whose PHYSICAL order is not id order; the schedule after a failed one still posts; the failed one leaves nothing", async () => {
    const period = "2026-10";
    const [ra, rb, rc] = schedulesA;
    const ids = [ra.id, rb.id, rc.id];
    expect([...ids].sort((x, y) => x - y), "fixture: created in this order").toEqual(ids);
    // Move RA physically behind RB and RC: an UPDATE writes a new version of the row. Without
    // ORDER BY the run would then meet RB, RC, RA; with it, RA, RB, RC.
    const physical = async () => (await pool.query(`SELECT id FROM recognition_schedules WHERE id = ANY($1::int[]) ORDER BY ctid`, [ids])).rows.map((x) => x.id as number);
    for (let i = 0; i < 40 && (await physical())[2] !== ra.id; i++) {
      await pool.query(`UPDATE recognition_schedules SET notes = notes WHERE id = $1`, [ra.id]);
    }
    const order = await physical();
    expect(order[2], "precondition: RA, the lowest id, is physically LAST").toBe(ra.id);
    expect(order, "precondition: the table's physical order is NOT id order").not.toEqual(ids);

    const taken = `${rb.ref}-${period}`;
    await draftNumbered(orgX, taken, "2026-10-05");
    const r = await h.api("bookkeeper", "POST", "/recognition-schedules/runs", { period });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    recRunA = r.body;
    expect(r.body.posted.map((p: { reference: string }) => p.reference), "id order, RC after the failed RB").toEqual([ra.ref, rc.ref]);
    expect(r.body.skipped.map((s: { reference: string }) => s.reference)).toEqual([rb.ref]);
    const reason = r.body.skipped[0].reason as string;
    expect(reason).toContain(taken);
    expect(leaks(reason), reason).toEqual([]);

    const entryIds = r.body.posted.map((p: { journalEntryId: number }) => p.journalEntryId) as number[];
    const entries = (await pool.query(`SELECT entry_number, status, company_id FROM journal_entries WHERE id = ANY($1::int[]) ORDER BY id`, [entryIds])).rows;
    expect(entries).toEqual([
      { entry_number: `${ra.ref}-${period}`, status: "posted", company_id: coA },
      { entry_number: `${rc.ref}-${period}`, status: "posted", company_id: coA },
    ]);
    // One figure, three ways: total ÷ periods (computed here), the run's total, the ledger's lines.
    const expected = round2(ra.total / 3 + rc.total / 3);
    expect(expected).toBe(400);
    expect(r.body.posted.map((p: { amount: number }) => p.amount)).toEqual([ra.total / 3, rc.total / 3]);
    expect(r.body.postedTotal).toBe(expected);
    expect(await lineTotals(entryIds)).toEqual({ debit: expected, credit: expected });

    const rowOf = async (s: Schedule) => (await one(`SELECT journal_entry_id FROM recognition_schedule_rows WHERE schedule_id = $1 AND period = $2`, [s.id, period])).journal_entry_id;
    const audited = (s: Schedule) => count(`SELECT count(*) n FROM audit_logs WHERE organization_id = $1 AND action = 'recognise' AND entity_type = 'recognition_schedule' AND entity_id = $2`, [orgX, String(s.id)]);
    expect([await rowOf(ra), await rowOf(rc)]).toEqual(entryIds);
    expect([await audited(ra), await audited(rc)]).toEqual([1, 1]);
    // The failed schedule left nothing: no posted mark, no entry but the draft, no audit row; still active.
    expect(await rowOf(rb)).toBeNull();
    expect(await audited(rb)).toBe(0);
    expect((await pool.query(`SELECT status FROM journal_entries WHERE company_id = $1 AND entry_number = $2`, [coA, taken])).rows).toEqual([{ status: "draft" }]);
    expect((await one(`SELECT status FROM recognition_schedules WHERE id = $1`, [rb.id])).status).toBe("active");
  });

  it("🔴 ISOLATION: company B's and organization Y's due items are absent from company A's runs, and post in their own runs", async () => {
    expect(depRunA && recRunA, "runs A happened above").toBeTruthy();
    // Absence — against runs that DID post (presence is the two tests above).
    expect(depRunA!.posted.length).toBeGreaterThan(0);
    expect(depRunA!.posted.map((p) => p.assetId)).not.toContain(assetB.id);
    expect(depRunA!.posted.map((p) => p.assetId)).not.toContain(assetY.id);
    expect(recRunA!.posted.map((p) => p.scheduleId)).not.toContain(scheduleB.id);
    const rowB = await one(`SELECT journal_entry_id FROM asset_depreciation_schedule WHERE asset_id = $1 AND period = '2026-07'`, [assetB.id]);
    expect(rowB.journal_entry_id, "B's asset was not depreciated by A's run").toBeNull();

    // Movement — each posts in its own scope, and only its own.
    const depB = await h.inTenant(orgX, coB, adminX, () => assetCapitalisationService.runPeriod({ period: "2026-07" }, adminX));
    expect(depB.posted.map((p) => p.assetId)).toEqual([assetB.id]);
    expect((await one(`SELECT company_id FROM journal_entries WHERE id = $1`, [depB.posted[0].journalEntryId])).company_id).toBe(coB);
    expect(depB.posted[0].amount).toBe(assetB.cost / LIFE);
    const recB = await h.inTenant(orgX, coB, adminX, () => recognitionSchedulesService.runPeriod({ period: "2026-10" }, adminX));
    expect(recB.posted.map((p) => p.scheduleId)).toEqual([scheduleB.id]);
    expect(recB.skipped).toEqual([]);
    const depY = await h.api("bookkeepery", "POST", "/assets/depreciation-runs", { period: "2026-07" });
    expect(depY.status, JSON.stringify(depY.body)).toBe(200);
    expect(depY.body.posted.map((p: { assetId: number }) => p.assetId)).toEqual([assetY.id]);
    expect((await one(`SELECT company_id FROM journal_entries WHERE id = $1`, [depY.body.posted[0].journalEntryId])).company_id).toBe(coY);
  });

  it("CLOSED MONTH (behaviour unchanged): the depreciation run stops with 423 and posts nothing; the recognition run reports each schedule with the closed-month sentence", async () => {
    await h.inTenant(orgX, coA, adminX, () => periodLocksService.lock({ period: "2026-08", userId: adminX }));
    try {
      const r = await h.api("bookkeeper", "POST", "/assets/depreciation-runs", { period: "2026-08" });
      expect(r.status, JSON.stringify(r.body)).toBe(423);
      expect(r.body.code).toBe("period_closed");
      expect(await count(`SELECT count(*) n FROM journal_entries WHERE company_id = $1 AND entry_number LIKE 'DEP-%-2026-08'`, [coA])).toBe(0);
      expect(await count(`SELECT count(*) n FROM asset_depreciation_schedule WHERE asset_id = ANY($1::int[]) AND period = '2026-08' AND journal_entry_id IS NOT NULL`, [assetsA.map((a) => a.id)])).toBe(0);
      expect(await count(`SELECT count(*) n FROM asset_events WHERE asset_id = ANY($1::int[]) AND kind = 'depreciated' AND payload->>'period' = '2026-08'`, [assetsA.map((a) => a.id)])).toBe(0);
    } finally {
      await h.inTenant(orgX, coA, adminX, () => periodLocksService.unlock("2026-08"));
    }

    await h.inTenant(orgX, coA, adminX, () => periodLocksService.lock({ period: "2026-11", userId: adminX }));
    try {
      const [ra, rb, rc] = schedulesA;
      const r = await h.api("bookkeeper", "POST", "/recognition-schedules/runs", { period: "2026-11" });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.posted).toEqual([]);
      const reasons = Object.fromEntries((r.body.skipped as Array<{ reference: string; reason: string }>).map((s) => [s.reference, s.reason]));
      expect(Object.keys(reasons)).toEqual([ra.ref, rb.ref, rc.ref]);
      expect(reasons[ra.ref]).toMatch(/^The books for 2026-11 are closed/);
      expect(reasons[rc.ref]).toMatch(/^The books for 2026-11 are closed/);
      expect(reasons[rb.ref], "RB's October is still unposted — its own refusal, unchanged").toMatch(/^Recognise 2026-10 first/);
      expect(await count(`SELECT count(*) n FROM recognition_schedule_rows WHERE schedule_id = ANY($1::int[]) AND period = '2026-11' AND journal_entry_id IS NOT NULL`, [schedulesA.map((s) => s.id)])).toBe(0);
    } finally {
      await h.inTenant(orgX, coA, adminX, () => periodLocksService.unlock("2026-11"));
    }
  });

  describe("withSavepoint on its own (read-only: nothing is written)", () => {
    const pgCode = (err: unknown) => (err as { cause?: { code?: string } })?.cause?.code ?? (err as { code?: string })?.code;
    async function inTx(fn: () => Promise<void>) {
      const conn = await beginTenantConnection({ organizationId: orgX, companyId: coA, role: "authenticated" });
      try {
        await conn.run(fn);
      } finally {
        await conn.rollback();
      }
    }

    it("CONTROL: without a savepoint, one error leaves the transaction unusable (what the runs met)", async () => {
      await inTx(async () => {
        await expect(db.execute(sql`SELECT 1/0`)).rejects.toSatisfy((e) => pgCode(e) === "22012");
        await expect(db.execute(sql`SELECT 1`)).rejects.toSatisfy((e) => pgCode(e) === "25P02");
      });
    });

    it("🔴 an error INSIDE is returned, rolled back to the savepoint, and the transaction stays usable", async () => {
      await inTx(async () => {
        const failed = await withSavepoint(() => db.execute(sql`SELECT 1/0`));
        expect(failed.ok).toBe(false);
        expect(pgCode(!failed.ok && failed.error)).toBe("22012");
        const after = await db.execute<{ one: number }>(sql`SELECT 1 AS one`);
        expect(after.rows[0].one).toBe(1);
        const fine = await withSavepoint(async () => 42);
        expect(fine).toEqual({ ok: true, value: 42 });
      });
    });

    it("🔴 a transaction ALREADY aborted makes the helper throw — it is never reported as one item's failure", async () => {
      await inTx(async () => {
        await expect(db.execute(sql`SELECT 1/0`)).rejects.toBeTruthy();
        await expect(withSavepoint(async () => 1)).rejects.toSatisfy((e) => pgCode(e) === "25P02");
      });
    });
  });
});
