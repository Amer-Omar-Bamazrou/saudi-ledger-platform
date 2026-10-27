/**
 * PHASE 18 · S1 · G60 PROOF — a month-end run that answers 2xx "posted" for
 * work that silently rolled back. PROOF ONLY, NOT A FIX.
 *
 * Authorised by the owner on 2026-10-11 ("Phase 18 S1: proof tests only").
 * Definition: the Phase 18 contract, G60 (§11; §21.4 "next: a focused proof
 * test; whether to fix is decided after it"), its proving-test shape (§16.2,
 * "force a DB error mid-run; assert … nothing is reported as posted"), and
 * X-7 ("a 2xx for work that did not commit").
 *
 * The mechanism (read at HEAD 44427b23):
 *  - the depreciation run (services/assets/capitalisation.service.ts:184-202)
 *    and the recognition run (services/accounting/recognitionSchedules.service.ts:305-329)
 *    catch every per-item error INSIDE the request's single transaction and
 *    report it as "skipped";
 *  - a Postgres error aborts that transaction, but the handler still answers
 *    200 with its "posted" list;
 *  - `finish("COMMIT")` (packages/db/src/index.ts:288-312) discards the
 *    COMMIT's result. On an aborted transaction Postgres completes COMMIT with
 *    the tag ROLLBACK and raises no error, so nothing reaches
 *    responseCommit.ts's 500 path.
 *
 * The fault is NATURAL, with no mocking and no DDL. A bookkeeper's DRAFT manual
 * journal entry carries the number a run is about to generate. User-chosen
 * entry numbers are not reserved today (contract SG-11, NF-1). The run's insert
 * of that number then raises 23505 on `journal_entries_company_number_unq`.
 * The run is driven over HTTP on the real app, so the response the user sees is
 * what is asserted.
 *
 * The SAFE invariant is the one any fix must satisfy, whichever fix is chosen
 * (a savepoint per item, or failing the run): **if a run answers 2xx, every
 * entry it reports as posted exists in the books.** The evidence is logged
 * first. A CONTROL run with no collision shows that the probe sees real entries.
 *
 * 🔴 On unmodified code this proof FAILED BY DESIGN: S1, 2026-10-11; again on
 * 2026-10-13; and on main fd27364e on 2026-10-15 — both PROOFs red (200, one
 * reported entry that did not exist, each), the CONTROL green. It lands, with
 * its assertions unchanged, together with the owner-authorised G60 fix
 * (2026-10-15: each item of a run in its own SAVEPOINT — `lib/savepoint.ts`),
 * as that fix's regression proof. It must never be weakened to pass; see also
 * `g60-run-item-savepoint.test.ts`.
 *
 * DB-backed; skips on the DB-free placeholder.
 */

process.env.PORT ??= "3142";
process.env.SESSION_SECRET ??= "phase18-s1-g60-proof-session-secret-00001";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "@workspace/db";
import { __resetRateLimitsForTests } from "../routes/auth";
import { assetsService } from "../services/assets.service";
import { billsService } from "../services/bills.service";
import { recognitionSchedulesService } from "../services/accounting/recognitionSchedules.service";
import { g04Harness } from "./helpers/g04Harness";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

const PW = "S1G60ProofPw123!";

describeMaybe("Phase 18 S1 · G60 proof — a run that answers 2xx for work that rolled back", () => {
  const h = g04Harness("s1g60");
  let orgId = "";
  let companyId = "";
  let adminId = 0;
  let vendorId = 0;
  let assetNumbers: string[] = [];

  const inCo = <T,>(fn: () => Promise<T>) => h.inTenant(orgId, companyId, adminId, fn);
  const accountOf = async (code: string) =>
    (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = $2 AND is_posting`, [orgId, code])).rows[0].id as number;
  /** Posted entries with these ids that actually exist in the books. */
  const existing = async (ids: number[]) =>
    Number((await pool.query(
      `SELECT count(*)::int AS n FROM journal_entries WHERE id = ANY($1::int[]) AND status IN ('posted','reversed')`, [ids],
    )).rows[0].n);
  const persistedNamed = async (pattern: string) =>
    (await pool.query(
      `SELECT entry_number, status FROM journal_entries WHERE organization_id = $1 AND entry_number LIKE $2 ORDER BY entry_number`, [orgId, pattern],
    )).rows as Array<{ entry_number: string; status: string }>;
  /**
   * A DRAFT manual journal entry with a caller-chosen number, entered by the bookkeeper over HTTP.
   * 🔴 T1d (SG-11, 0129): a user can no longer TYPE a document's number (`DEP-…`: 422 `entry_number_reserved`),
   * so that one is written the way a draft from before 0129 stands (no source_type). A recognition number
   * (`<reference>-<period>`) is not reserved, and is still typed through the API.
   */
  async function draftEntryNumbered(entryNumber: string, date: string) {
    if (/^DEP-/i.test(entryNumber)) {
      const { rows: [e] } = await pool.query(
        `INSERT INTO journal_entries (organization_id, company_id, entry_number, date, description, status)
         VALUES ($1, $2, $3, $4, 'S1 G60 — a draft that happens to carry this number', 'draft') RETURNING id`, [orgId, companyId, entryNumber, date]);
      await pool.query(
        `INSERT INTO journal_entry_lines (organization_id, company_id, journal_entry_id, account_id, account_name, debit_amount, credit_amount)
         VALUES ($1, $2, $3, $4, 'debit', 10, 0), ($1, $2, $3, $5, 'credit', 0, 10)`,
        [orgId, companyId, e.id, await accountOf("RENT_UTILITIES"), await accountOf("OTHER_INCOME")]);
      return e.id as number;
    }
    const r = await h.api("bookkeeper", "POST", "/journal-entries", {
      entryNumber,
      date,
      description: "S1 G60 — a draft that happens to carry this number",
      lines: [
        { accountId: await accountOf("RENT_UTILITIES"), accountName: "debit", debitAmount: 10, creditAmount: 0 },
        { accountId: await accountOf("OTHER_INCOME"), accountName: "credit", debitAmount: 0, creditAmount: 10 },
      ],
    });
    expect(r.status, `draft ${entryNumber}: ${JSON.stringify(r.body)}`).toBe(201);
    return r.body.id as number;
  }

  beforeAll(async () => {
    await __resetRateLimitsForTests();
    await h.cleanup();
    orgId = await h.mkOrg("org");
    companyId = await h.mkCompany(orgId, "S1 G60 Co", "318181818181813");
    adminId = await h.mkUser("admin", PW, orgId, "admin");
    await h.mkUser("bookkeeper", PW, orgId, "bookkeeper");
    vendorId = (await pool.query(
      `INSERT INTO vendors (organization_id, name, tax_number) VALUES ($1,'S1 G60 Equipment Supplier','300000000000003') RETURNING id`, [orgId],
    )).rows[0].id;
    // Two assets, capitalised through the product's own path (a bill that buys each), both due from 2026-07.
    const cat = await inCo(() => assetsService.createCategory({ name: "S1 G60 Computers", defaultUsefulLifeMonths: 48, incomeTaxGroup: 3, vatCapitalAssetClass: "movable" }, adminId));
    for (const n of [1, 2]) {
      const asset = await inCo(() => assetsService.create({ name: `S1 G60 asset ${n}`, categoryId: cat.id, acquisitionDate: "2026-07-01", availableForUseDate: "2026-07-01", cost: 12_000, residualValue: 0, vatInputTaxAmount: 1_800 }, adminId));
      const bill = await inCo(() => billsService.create({ supplierDocumentKind: "tax_invoice", vendorReference: `S1G60-SUP-${n}`, billNumber: `S1G60-BILL-${n}`, date: "2026-07-01", vendorId, subtotal: 12_000, vatAmount: 1_800, total: 13_800, capitalisesAssetId: asset.id, items: [{ description: "Asset purchase", quantity: 1, unitPrice: 12_000 }] }, adminId));
      await inCo(() => billsService.approve(bill.id, {}, adminId));
    }
    assetNumbers = (await pool.query(`SELECT asset_number FROM fixed_assets WHERE organization_id = $1 ORDER BY asset_number`, [orgId])).rows.map((r) => r.asset_number);
    await h.start();
    for (const who of ["admin", "bookkeeper"]) expect(await h.login(who, h.email(who), PW), `login ${who}`).toBe(200);
  }, 180_000);

  afterAll(async () => {
    await h.stop();
    await h.cleanup();
  });

  it("CONTROL: a depreciation run with no fault answers 200, and every entry it reports as posted exists", async () => {
    expect(assetNumbers).toHaveLength(2);
    const r = await h.api("bookkeeper", "POST", "/assets/depreciation-runs", { period: "2026-07" });
    const ids = (r.body?.posted ?? []).map((p: { journalEntryId: number }) => p.journalEntryId);
    // eslint-disable-next-line no-console
    console.warn("[S1 G60] DEPRECIATION CONTROL", JSON.stringify({ status: r.status, body: r.body, existing: await existing(ids) }));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.posted).toHaveLength(2);
    expect(await existing(ids)).toBe(2);
  });

  it("🔴 PROOF (depreciation): a run whose 2nd asset hits a database error — if it answers 2xx, every entry it reports as posted EXISTS", async () => {
    const period = "2026-08";
    // The natural fault: the bookkeeper's draft already holds DEP-<2nd asset>-2026-08.
    const draftId = await draftEntryNumbered(`DEP-${assetNumbers[1]}-${period}`, "2026-08-15");
    const r = await h.api("bookkeeper", "POST", "/assets/depreciation-runs", { period });
    const posted = (r.body?.posted ?? []) as Array<{ assetNumber: string; journalEntryId: number }>;
    const ids = posted.map((p) => p.journalEntryId);
    const evidence = {
      status: r.status,
      body: r.body,
      reportedPosted: posted.length,
      reportedPostedThatExist: await existing(ids),
      depEntriesPersistedForPeriod: await persistedNamed(`DEP-%-${period}`),
      draftStillThere: (await pool.query(`SELECT entry_number, status FROM journal_entries WHERE id = $1`, [draftId])).rows[0] ?? null,
    };
    // eslint-disable-next-line no-console
    console.warn("[S1 G60] DEPRECIATION PROOF", JSON.stringify(evidence));
    // Precondition: the run did reach the faulting asset AFTER posting the first (otherwise the proof is vacuous).
    expect(posted.map((p) => p.assetNumber), "precondition: the 1st asset was reported posted before the fault").toContain(assetNumbers[0]);
    if (r.status < 300) {
      expect.soft(evidence.reportedPostedThatExist, "every entry a 2xx run reports as posted must exist").toBe(posted.length);
    }
  });

  it("🔴 PROOF (recognition): a run whose LAST schedule hits a database error — if it answers 2xx, every entry it reports as posted EXISTS", async () => {
    const period = "2026-10";
    const prepaid = await accountOf("PREPAID_EXPENSES");
    const expense = await accountOf("RENT_UTILITIES");
    for (const ref of ["S1G60-RA", "S1G60-RB"]) {
      const s = await inCo(() => recognitionSchedulesService.create({ kind: "prepayment", totalAmount: 300, periods: 3, startPeriod: period, description: `S1 G60 ${ref}`, expenseAccountId: expense, balanceAccountId: prepaid, reference: ref }, adminId));
      await inCo(() => recognitionSchedulesService.activate(s.id, {}, adminId));
    }
    // The natural fault on the schedule created LAST: its entry number S1G60-RB-2026-10 is already taken by a draft.
    const draftId = await draftEntryNumbered(`S1G60-RB-${period}`, "2026-10-05");
    const r = await h.api("bookkeeper", "POST", "/recognition-schedules/runs", { period });
    const posted = (r.body?.posted ?? []) as Array<{ reference: string; journalEntryId: number }>;
    const ids = posted.map((p) => p.journalEntryId);
    const evidence = {
      status: r.status,
      body: r.body,
      reportedPosted: posted.length,
      reportedPostedThatExist: await existing(ids),
      recognitionEntriesPersisted: await persistedNamed(`S1G60-R_-${period}`),
      draftStillThere: (await pool.query(`SELECT entry_number, status FROM journal_entries WHERE id = $1`, [draftId])).rows[0] ?? null,
    };
    // eslint-disable-next-line no-console
    console.warn("[S1 G60] RECOGNITION PROOF", JSON.stringify(evidence));
    // Precondition: `actives` has no ORDER BY (recognitionSchedules.service.ts:310). The silent 2xx needs the faulting
    // schedule to be processed LAST; if it came first, the next schedule's read throws outside the catch and the run
    // honestly fails. This states which order happened, so the result is never read as a pass by accident.
    expect(posted.map((p) => p.reference), "precondition: schedule RA was reported posted before RB's fault").toContain("S1G60-RA");
    if (r.status < 300) {
      expect.soft(evidence.reportedPostedThatExist, "every entry a 2xx run reports as posted must exist").toBe(posted.length);
    }
  });
});
