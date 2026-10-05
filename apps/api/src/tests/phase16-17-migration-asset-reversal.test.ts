/**
 * Q3 — A REVERSED MIGRATION TAKES ITS FIXED ASSETS AND EVERY OPENING BALANCE
 * WITH IT (accountant decision Q3, Option A; pack phase-16-17 §14.3).
 *
 * Every figure here is produced by the product's own paths — migrations staged,
 * validated, COMMITTED and REVERSED through `migrationCommitService`, assets
 * bought on a bill, depreciation posted by the monthly run — and read back out
 * of Postgres. Three companies of ONE organization, and a second organization:
 *
 *   Company A — the migration under test: a bank, an opening receivable, an
 *               opening payable, inventory, a provision, capital and TWO
 *               migrated fixed assets; then UNRELATED activity (a machine bought
 *               on a bill) and two months of depreciation; then the reversal;
 *               then a REPLACEMENT migration.
 *   Company C — the CONTROL: the same unrelated activity, never migrated. After
 *               the reversal, A's balance sheet must read exactly as C's at
 *               every as-of date — the migration never existed in these books.
 *   Company B — a migration whose one asset was DISPOSED of: the reversal is
 *               blocked by name (a disposal posted a gain or loss no path
 *               reverses), and the cross-company probe.
 *   Org X     — a migration with exactly ONE asset and no depreciation, reversed
 *               cleanly; and the cross-organization probe.
 *
 * Option A, as decided: the asset is MARKED reversed — out of the register and
 * out of every run, its rows kept — and the depreciation posted on it since the
 * cutover is mirrored on its own dates. NOT a disposal: no proceeds, no gain or
 * loss, no disposal record. A batch is reversed WHOLE.
 *
 * Inventory and provisions have NO subledger in this product (search shape:
 * `packages/db/src/schema` for invent|provision|stock — none; the seeded chart
 * has an `Inventory` ACCOUNT only): their opening balances are GL lines of the
 * opening journal, and the mirror of that journal is what reverses them. The
 * test proves exactly that — each line listed in the preview, each balance zero
 * afterwards at every date.
 *
 * Rows PLANTED with triggers off (`session_replication_role = replica`) are
 * labelled: probes of a database rule or of the invariant sweep, never a
 * fixture of the feature.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { assetsService } from "../services/assets.service";
import { assetCapitalisationService } from "../services/assets/capitalisation.service";
import { assetDisposalService } from "../services/assets/disposal.service";
import { assetReportsService } from "../services/assets/assetReports.service";
import { vatCapitalAssetService } from "../services/assets/vatCapitalAsset.service";
import { migrationService } from "../services/migration.service";
import { migrationStagingService } from "../services/migrationStaging.service";
import { migrationValidationService } from "../services/migrationValidation.service";
import { migrationCommitService } from "../services/migrationCommit.service";
import { bankAccountsService } from "../services/bankAccounts.service";
import { billsService } from "../services/bills.service";
import { periodLocksService } from "../services/periodLocks.service";
import { reportsService } from "../services/reports.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[phase16-17-migration-asset-reversal] no real DATABASE_URL — skipping.");

describeMaybe("Q3 — a reversed migration takes its fixed assets and every opening balance with it (real rows)", () => {
  const SLUG = "q3-migrev", SLUG_X = "q3-migrev-x", EMAIL = "q3-migrev@test.local";
  let orgId = "", coA = "", coB = "", coC = "", orgX = "", coX = "", userId = 0, vendorId = 0;
  const cat: Record<string, number> = {};
  const bank: Record<string, number> = {};
  let batchA = 0, batchB = 0, batchX = 0, replacementA = 0;
  let fa1 = 0, fa2 = 0, nativeA = 0, nativeC = 0, faB = 0, faX = 0;
  let openingJeA = 0;
  const depJe: Record<string, number> = {}; // `${assetId}:${period}` → its depreciation entry

  const tenant = (org: () => string, co: () => string) => async <T,>(fn: () => Promise<T>): Promise<T> => {
    const conn = await beginTenantConnection({ organizationId: org(), companyId: co(), role: "authenticated" });
    try {
      const out = await conn.run(() => auditContext.run({ userId, organizationId: org(), ipAddress: null }, fn));
      await conn.commit();
      return out;
    } catch (err) { await conn.rollback(); throw err; }
  };
  const inA = tenant(() => orgId, () => coA);
  const inB = tenant(() => orgId, () => coB);
  const inC = tenant(() => orgId, () => coC);
  const inX = tenant(() => orgX, () => coX);
  type Run = typeof inA;

  const cleanup = async () => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      // Teardown only: committed staging rows, the asset register and posted entries refuse deletes by design.
      await c.query("SET LOCAL session_replication_role = replica");
      const ORGS = `(SELECT id FROM organizations WHERE slug IN ('${SLUG}','${SLUG_X}'))`;
      const { rows } = await c.query(
        `SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
          WHERE c.table_schema = 'public' AND c.column_name = 'organization_id' AND t.table_type = 'BASE TABLE' AND c.table_name <> 'organizations'`);
      for (const { table_name } of rows) await c.query(`DELETE FROM "${table_name}" WHERE organization_id IN ${ORGS}`);
      await c.query(`DELETE FROM organizations WHERE slug IN ('${SLUG}','${SLUG_X}')`);
      await c.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
      await c.query("COMMIT");
    } catch (err) { await c.query("ROLLBACK"); throw err; } finally { c.release(); }
  };
  const refusal = async (p: Promise<unknown>) => {
    try { await p; } catch (e) { return e as { statusCode?: number; payload?: { code?: string; error?: string }; message: string; constraint?: string; code?: string }; }
    throw new Error("expected a refusal");
  };
  /** Planted with triggers OFF — a probe (see the header), never a product state. */
  const plant = async (sqlText: string, params: unknown[] = []) => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL session_replication_role = replica");
      const r = await c.query(sqlText, params);
      await c.query("COMMIT");
      return r;
    } catch (err) { await c.query("ROLLBACK"); throw err; } finally { c.release(); }
  };
  const one = async <T = Record<string, unknown>,>(sqlText: string, params: unknown[] = []) => (await pool.query(sqlText, params)).rows[0] as T;
  const costAccountOf = async (catId: number) => Number((await one<{ id: number }>(`SELECT cost_account_id AS id FROM asset_categories WHERE id = $1`, [catId])).id);
  const accountId = async (name: string) => Number((await one<{ id: number }>(`SELECT id FROM categories WHERE organization_id = $1 AND name = $2`, [orgId, name])).id);
  /** A GL account's balance (debit − credit) in ONE company, as at a date — entries IN THE BOOKS (posted + reversed). */
  const glBalance = async (co: string, accId: number, asOf: string) => Number((await one<{ v: string }>(
    `SELECT coalesce(sum(l.debit_amount - l.credit_amount), 0)::text AS v FROM journal_entry_lines l JOIN journal_entries e ON e.id = l.journal_entry_id
      WHERE e.company_id = $1 AND l.account_id = $2 AND e.status IN ('posted','reversed') AND e.date <= $3`, [co, accId, asOf])).v);
  const asset = (id: number, run: Run = inA) => run(() => assetsService.getById(id));
  const assetRow = (sourceId: string, name: string, cost: number, accumulated: number) => ({
    sourceId, name, categoryName: "Machinery", acquisitionDate: "2024-07-01", availableForUseDate: "2024-07-01",
    cost, usefulLifeMonths: 48, openingAccumulatedDepreciation: accumulated, openingPeriodsBooked: 24,
    vatInputTaxAmount: Math.round(cost * 0.15 * 100) / 100, vatInitialRecoveryPct: 100,
  });
  const validateAndCommit = async (run: Run, batchId: number) => {
    const v = await run(() => migrationValidationService.validate(batchId, userId));
    expect(v.ok, JSON.stringify(v.checks.filter((c) => c.status !== "pass"))).toBe(true);
    const out = await run(() => migrationCommitService.commit(batchId, userId));
    expect(out.status).toBe("committed");
  };

  /**
   * Company A's opening position, as at 2026-06-30 (cutover 2026-07-01):
   *   Dr bank 50,000 · AR 8,000 · inventory 12,000 · machinery 100,000
   *   Cr accumulated (18,000 + fa2Accumulated) · AP 6,000 · provision 9,000 · capital (the balance)
   * FA-1 cost 60,000 / accumulated 18,000; FA-2 cost 40,000 / accumulated fa2Accumulated — both 24 of 48 periods booked.
   */
  const migrateA = async (o: { fa2Accumulated: number; replacement?: boolean }) => {
    const b = await inA(() => migrationService.createBatch({ sourceSystem: "PreviousERP", cutoverDate: "2026-07-01" }, userId));
    const accumulated = 18_000 + o.fa2Accumulated;
    await inA(() => migrationService.importChart(b.id, { rows: [
      { sourceCode: "1100", sourceName: "Bank", sourceType: "asset", openingDebit: 50_000, sourceRole: "bank", evidenceNote: "Statement 30 Jun 2026, closing 50,000.00" },
      { sourceCode: "1200", sourceName: "Trade debtors", sourceType: "asset", openingDebit: 8_000, sourceRole: "receivable" },
      { sourceCode: "1300", sourceName: "Stock on hand", sourceType: "asset", openingDebit: 12_000 },
      { sourceCode: "1500", sourceName: "Machinery at cost", sourceType: "asset", openingDebit: 100_000 },
      { sourceCode: "1590", sourceName: "Accumulated depreciation — machinery", sourceType: "asset", openingCredit: accumulated },
      { sourceCode: "2100", sourceName: "Trade creditors", sourceType: "liability", openingCredit: 6_000, sourceRole: "payable" },
      { sourceCode: "2400", sourceName: "Q3 provision for end-of-service benefits", sourceType: "liability", openingCredit: 9_000 },
      { sourceCode: "3100", sourceName: "Q3 owner capital", sourceType: "equity", openingCredit: 50_000 + 8_000 + 12_000 + 100_000 - accumulated - 6_000 - 9_000 },
    ] }, userId));
    const chart = await inA(() => migrationService.getChart(b.id));
    const row = (code: string) => chart.rows.find((r) => r.sourceCode === code)!.id;
    const decide = (code: string, body: Parameters<typeof migrationService.decideChartRow>[2]) => inA(() => migrationService.decideChartRow(b.id, row(code), body, userId));
    await decide("1100", { decision: "map_to_bank", targetBankAccountId: bank.A });
    await decide("1200", { decision: "map_to_system", targetSystemCode: "AR" });
    // inventory lands on the seeded Inventory ACCOUNT (there is no inventory subledger)
    await decide("1300", { decision: "merge_into", targetCategoryId: await accountId("Inventory") });
    await decide("1500", { decision: "merge_into", targetCategoryId: await costAccountOf(cat.A) });
    await decide("1590", { decision: "map_to_system", targetSystemCode: "ACCUMULATED_DEPRECIATION" });
    await decide("2100", { decision: "map_to_system", targetSystemCode: "AP" });
    // the provision and the capital are CREATED by the first migration — and kept by its reversal, so the replacement merges into them
    await decide("2400", o.replacement ? { decision: "merge_into", targetCategoryId: await accountId("Q3 provision for end-of-service benefits") } : { decision: "create" });
    await decide("3100", o.replacement ? { decision: "merge_into", targetCategoryId: await accountId("Q3 owner capital") } : { decision: "create" });
    const parties = await inA(() => migrationStagingService.importParties(b.id, { rows: [
      { partyType: "customer" as const, sourceId: "C1", name: "Q3 Gamma Trading" },
      { partyType: "vendor" as const, sourceId: "V1", name: "Q3 Delta Supplies" },
    ] }, userId));
    if (o.replacement) {
      const p = (sid: string) => parties.rows.find((r) => r.sourceId === sid)!.id;
      const customer = Number((await one<{ id: number }>(`SELECT id FROM customers WHERE organization_id = $1 AND name = 'Q3 Gamma Trading'`, [orgId])).id);
      const vendor = Number((await one<{ id: number }>(`SELECT id FROM vendors WHERE organization_id = $1 AND name = 'Q3 Delta Supplies'`, [orgId])).id);
      await inA(() => migrationStagingService.decideParty(b.id, p("C1"), { decision: "use_existing", existingId: customer }, userId));
      await inA(() => migrationStagingService.decideParty(b.id, p("V1"), { decision: "use_existing", existingId: vendor }, userId));
    }
    await inA(() => migrationStagingService.importOpenItems(b.id, { rows: [
      { itemType: "ar" as const, sourceId: "SI-1", partySourceId: "C1", documentNumber: "Q3-INV-1", issueDate: "2026-05-10", dueDate: "2026-06-10", originalAmount: 8_000, outstandingAmount: 8_000 },
      { itemType: "ap" as const, sourceId: "PI-1", partySourceId: "V1", documentNumber: "Q3-BILL-1", issueDate: "2026-06-01", dueDate: "2026-07-01", originalAmount: 6_000, outstandingAmount: 6_000 },
    ] }, userId));
    await inA(() => migrationStagingService.importAssets(b.id, { rows: [
      assetRow("FA-1", "CNC machine", 60_000, 18_000),
      assetRow("FA-2", "Laser cutter", 40_000, o.fa2Accumulated),
    ] }, userId));
    await validateAndCommit(inA, b.id);
    return b.id;
  };
  /** A small migration of fixed assets only: bank 5,000 + the assets, against retained earnings. */
  const migrateAssetsOnly = async (run: Run, bankId: number, catId: number, assets: ReturnType<typeof assetRow>[]) => {
    const b = await run(() => migrationService.createBatch({ sourceSystem: "PreviousERP", cutoverDate: "2026-07-01" }, userId));
    const cost = assets.reduce((s, a) => s + a.cost, 0), accumulated = assets.reduce((s, a) => s + a.openingAccumulatedDepreciation, 0);
    await run(() => migrationService.importChart(b.id, { rows: [
      { sourceCode: "1100", sourceName: "Bank", sourceType: "asset", openingDebit: 5_000, sourceRole: "bank", evidenceNote: "Statement 30 Jun 2026, closing 5,000.00" },
      { sourceCode: "1500", sourceName: "Machinery at cost", sourceType: "asset", openingDebit: cost },
      { sourceCode: "1590", sourceName: "Accumulated depreciation — machinery", sourceType: "asset", openingCredit: accumulated },
      { sourceCode: "3200", sourceName: "Retained earnings b/f", sourceType: "equity", openingCredit: 5_000 + cost - accumulated, sourceRole: "retained_earnings" },
    ] }, userId));
    const chart = await run(() => migrationService.getChart(b.id));
    const row = (code: string) => chart.rows.find((r) => r.sourceCode === code)!.id;
    const costAccount = Number((await one<{ id: number }>(`SELECT cost_account_id AS id FROM asset_categories WHERE id = $1`, [catId])).id);
    await run(() => migrationService.decideChartRow(b.id, row("1100"), { decision: "map_to_bank", targetBankAccountId: bankId }, userId));
    await run(() => migrationService.decideChartRow(b.id, row("1500"), { decision: "merge_into", targetCategoryId: costAccount }, userId));
    await run(() => migrationService.decideChartRow(b.id, row("1590"), { decision: "map_to_system", targetSystemCode: "ACCUMULATED_DEPRECIATION" }, userId));
    await run(() => migrationService.decideChartRow(b.id, row("3200"), { decision: "map_to_system", targetSystemCode: "RETAINED_EARNINGS" }, userId));
    await run(() => migrationStagingService.importAssets(b.id, { rows: assets }, userId));
    await validateAndCommit(run, b.id);
    return b.id;
  };
  /** The UNRELATED activity, identical in A and C: a press brake bought on a bill on 2026-07-01 (24,000 + VAT 3,600), in service that day. */
  const buyPressBrake = async (run: Run, catId: number, tag: string) => {
    const draft = await run(() => assetsService.create({ name: "Press brake", categoryId: catId, acquisitionDate: "2026-07-01", availableForUseDate: "2026-07-01", cost: 24_000, vatInputTaxAmount: 3_600 }, userId));
    const bill = await run(() => billsService.create({ supplierDocumentKind: "tax_invoice", vendorReference: `SUP-PB-${tag}`, billNumber: `Q3-NB-${tag}`, date: "2026-07-01", vendorId, subtotal: 24_000, vatAmount: 3_600, total: 27_600, capitalisesAssetId: draft.id, items: [{ description: "Press brake", quantity: 1, unitPrice: 24_000 }] }, userId));
    await run(() => billsService.approve(bill.id, {}, userId));
    return draft.id;
  };
  const assetsOfBatch = async (batchId: number) => (await pool.query(`SELECT id, source_reference AS s FROM fixed_assets WHERE migration_batch_id = $1 ORDER BY source_reference`, [batchId])).rows as { id: number; s: string }[];
  /** A balance sheet reduced to what a reader compares: every NON-ZERO line by section and account name, and the totals. */
  const sheet = async (run: Run, asOf: string) => {
    const bs = await run(() => reportsService.balanceSheet(asOf));
    const lines = (section: string, items: { name: string; amount: number }[]) => items.filter((i) => Math.abs(i.amount) >= 0.005).map((i) => `${section}:${i.name}=${i.amount.toFixed(2)}`);
    return {
      lines: [...lines("A", bs.assets.items), ...lines("L", bs.liabilities.items), ...lines("E", bs.equity.items)].sort(),
      totals: { assets: bs.assets.total, liabilities: bs.liabilities.total, equity: bs.equity.total, ar: bs.assets.accountsReceivable, ap: bs.liabilities.accountsPayable, balanced: bs.balanced },
    };
  };
  const DATES = ["2026-06-30", "2026-07-31", "2026-08-31", "2026-09-30"];

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Q3 MigRev','${SLUG}') RETURNING id`)).rows[0].id;
    coA = (await pool.query(`INSERT INTO companies (organization_id, name, fiscal_year_start) VALUES ($1,'Q3 Co A',1) RETURNING id`, [orgId])).rows[0].id;
    coB = (await pool.query(`INSERT INTO companies (organization_id, name, fiscal_year_start) VALUES ($1,'Q3 Co B',1) RETURNING id`, [orgId])).rows[0].id;
    coC = (await pool.query(`INSERT INTO companies (organization_id, name, fiscal_year_start) VALUES ($1,'Q3 Co C (control)',1) RETURNING id`, [orgId])).rows[0].id;
    orgX = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('Q3 MigRev X','${SLUG_X}') RETURNING id`)).rows[0].id;
    coX = (await pool.query(`INSERT INTO companies (organization_id, name, fiscal_year_start) VALUES ($1,'Q3 Co X',1) RETURNING id`, [orgX])).rows[0].id;
    userId = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','Q3',' ','admin',true) RETURNING id`)).rows[0].id;
    for (const o of [orgId, orgX]) await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, o]);
    vendorId = (await pool.query(`INSERT INTO vendors (organization_id, name, tax_number) VALUES ($1,'Q3 Equipment Supplier','300000000000003') RETURNING id`, [orgId])).rows[0].id;
    for (const [k, run] of [["A", inA], ["B", inB], ["C", inC], ["X", inX]] as const) {
      bank[k] = (await run(() => bankAccountsService.create({ name: `Q3 Riyad ${k}`, bankName: "Riyad Bank", currency: "SAR" }))).id;
      cat[k] = (await run(() => assetsService.createCategory({ name: "Machinery", defaultUsefulLifeMonths: 48, incomeTaxGroup: 3, vatCapitalAssetClass: "movable" }, userId))).id;
    }
  }, 120_000);
  afterAll(cleanup);

  it("commit: TWO migrated assets in service on the opening journal; the opening carries inventory, a provision, AR and AP; unrelated activity and two months of depreciation follow — and A's books differ from the control's by exactly the migrated position (the movement half)", async () => {
    batchA = await migrateA({ fa2Accumulated: 12_000 });
    const rows = await assetsOfBatch(batchA);
    expect(rows.map((r) => r.s)).toEqual(["FA-1", "FA-2"]);
    [fa1, fa2] = rows.map((r) => r.id);
    openingJeA = Number((await one<{ id: number }>(`SELECT opening_journal_entry_id AS id FROM migration_batches WHERE id = $1`, [batchA])).id);
    for (const id of [fa1, fa2]) {
      const a = await asset(id);
      expect([a.status, a.source, a.migrationBatchId, a.capitalisationJournalEntryId, a.replacesAssetId, a.reversedAt]).toEqual(["in_service", "migration", batchA, openingJeA, null, null]);
    }
    // the unrelated activity, the same in A and in the never-migrated control C
    nativeA = await buyPressBrake(inA, cat.A, "A");
    nativeC = await buyPressBrake(inC, cat.C, "C");
    // depreciation BEFORE the reversal: the monthly run posts the two migrated assets and the press brake, in A; only the press brake in C
    for (const period of ["2026-07", "2026-08"]) {
      const runA = await inA(() => assetCapitalisationService.runPeriod({ period }, userId));
      expect(runA.posted.map((p) => [p.assetId, p.amount]).sort()).toEqual([[fa1, 1_750], [fa2, 1_166.67], [nativeA, 500]].sort());
      expect(runA.skipped).toEqual([]);
      for (const p of runA.posted) depJe[`${p.assetId}:${period}`] = p.journalEntryId;
      const runC = await inC(() => assetCapitalisationService.runPeriod({ period }, userId));
      expect(runC.posted.map((p) => [p.assetId, p.amount])).toEqual([[nativeC, 500]]);
    }
    // the register ties to the GL with the migration in it
    const rep = await inA(() => assetReportsService.report({ from: "2026-01-01", to: "2026-12-31" }));
    expect(rep.reconciles, JSON.stringify(rep.controls)).toBe(true);
    const ctl = (id: string) => rep.controls.find((c) => c.id === id && c.categoryName === "Machinery")!;
    expect([ctl("FA_COST").register, ctl("FA_ACCUMULATED").register, ctl("FA_EXPENSE").register]).toEqual([124_000, 30_000 + 2 * 2_916.67 + 1_000, 2 * 2_916.67 + 1_000]);
    // MOVEMENT: A is NOT C while the migration stands — by exactly the migrated net position at each date
    const migratedNet = (asOf: string) => 50_000 + 8_000 + 12_000 + 100_000 - 30_000 - (asOf >= "2026-08-31" ? 2 : asOf >= "2026-07-31" ? 1 : 0) * 2_916.67;
    for (const asOf of DATES) {
      const [a, c] = [await sheet(inA, asOf), await sheet(inC, asOf)];
      expect(Math.round((a.totals.assets - c.totals.assets) * 100) / 100, asOf).toBe(Math.round(migratedNet(asOf) * 100) / 100);
      expect(a.totals.balanced && c.totals.balanced, asOf).toBe(true);
    }
  }, 300_000);

  it("🔴 cross-company and cross-organization: another company of the same org, and another org, cannot preview, reverse or read A's batch or assets — and the attempts moved nothing", async () => {
    for (const run of [inB, inX]) {
      expect((await refusal(run(() => migrationCommitService.reversalPreview(batchA)))).statusCode).toBe(404);
      expect((await refusal(run(() => migrationCommitService.reverse(batchA, { reason: "a reversal from the wrong company" }, userId)))).statusCode).toBe(404);
      expect((await refusal(run(() => assetsService.getById(fa1)))).statusCode).toBe(404);
    }
    expect((await one<{ status: string }>(`SELECT status FROM migration_batches WHERE id = $1`, [batchA])).status).toBe("committed");
    expect((await one<{ status: string }>(`SELECT status FROM fixed_assets WHERE id = $1`, [fa1])).status).toBe("in_service");
  }, 60_000);

  it("🔴 the preview names every asset with each POSTED depreciation, and every opening balance (inventory and the provision included); a partial reversal is REFUSED by name and moves nothing", async () => {
    const p = await inA(() => migrationCommitService.reversalPreview(batchA));
    expect(p.blockers).toEqual([]);
    expect(p.wouldReverse.assets.map((a) => [a.id, a.status, a.sourceReference, a.cost, a.openingAccumulatedDepreciation, a.depreciation.map((d) => [d.period, d.amount, d.journalEntryId, d.alreadyReversed])])).toEqual([
      [fa1, "in_service", "FA-1", 60_000, 18_000, [["2026-07", 1_750, depJe[`${fa1}:2026-07`], false], ["2026-08", 1_750, depJe[`${fa1}:2026-08`], false]]],
      [fa2, "in_service", "FA-2", 40_000, 12_000, [["2026-07", 1_166.67, depJe[`${fa2}:2026-07`], false], ["2026-08", 1_166.67, depJe[`${fa2}:2026-08`], false]]],
    ]);
    const ob = new Map(p.wouldReverse.openingBalances.map((l) => [l.accountName, [l.debit, l.credit]]));
    expect(ob.get("Inventory")).toEqual([12_000, 0]);
    expect(ob.get("Q3 provision for end-of-service benefits")).toEqual([0, 9_000]);
    expect(ob.get("Q3 owner capital")).toEqual([0, 125_000]);
    expect(p.wouldReverse.openingBalances.reduce((s, l) => s + l.debit - l.credit, 0)).toBeCloseTo(0, 2);
    expect([p.wouldReverse.invoices.length, p.wouldReverse.bills.length]).toEqual([1, 1]);
    // a batch is reversed WHOLE — naming any scope is refused, never ignored
    for (const body of [{ reason: "withdraw only the laser cutter", assetIds: [fa2] }, { reason: "withdraw the receivables only", scope: "receivables" }]) {
      const e = await refusal(inA(() => migrationCommitService.reverse(batchA, body as never, userId)));
      expect([e.statusCode, e.payload?.code]).toEqual([422, "migration_partial_reversal_unsupported"]);
    }
    expect((await one<{ status: string }>(`SELECT status FROM migration_batches WHERE id = $1`, [batchA])).status).toBe("committed");
    expect((await pool.query(`SELECT id FROM journal_entries WHERE reversal_of = ANY($1::int[])`, [[openingJeA, ...Object.values(depJe)]])).rows).toEqual([]);
  }, 60_000);

  it("🔴 a LOCKED month holding a depreciation to unwind blocks the reversal by name (its mirror is dated as it was — never re-dated); reopened, the block lifts", async () => {
    await inA(() => periodLocksService.lock({ period: "2026-08", userId }));
    const p = await inA(() => migrationCommitService.reversalPreview(batchA));
    expect(p.blockers.join(" | ")).toMatch(/depreciation of fixed asset .* for 2026-08 is posted in 2026-08, which is closed/);
    const e = await refusal(inA(() => migrationCommitService.reverse(batchA, { reason: "withdrawing the opening position" }, userId)));
    expect([e.statusCode, e.payload?.code]).toEqual([422, "migration_reversal_blocked"]);
    expect((await one<{ status: string }>(`SELECT status FROM fixed_assets WHERE id = $1`, [fa1])).status).toBe("in_service");
    await inA(() => periodLocksService.unlock("2026-08"));
    expect((await inA(() => migrationCommitService.reversalPreview(batchA))).blockers).toEqual([]);
  }, 60_000);

  it("🔴 a DISPOSED migrated asset blocks its batch's reversal by name — a disposal posted a gain or loss, and no path reverses it", async () => {
    batchB = await migrateAssetsOnly(inB, bank.B, cat.B, [assetRow("FB-1", "Forklift", 10_000, 2_000)]);
    faB = (await assetsOfBatch(batchB))[0]!.id;
    await inB(() => assetDisposalService.dispose(faB, { date: "2026-07-20", kind: "scrapped", reason: "Burnt-out motor, scrapped" }, userId));
    const p = await inB(() => migrationCommitService.reversalPreview(batchB));
    expect(p.blockers.join(" | ")).toMatch(/was disposed of on 2026-07-20/);
    const e = await refusal(inB(() => migrationCommitService.reverse(batchB, { reason: "withdrawing the opening position" }, userId)));
    expect([e.statusCode, e.payload?.code]).toEqual([422, "migration_reversal_blocked"]);
    expect((await one<{ status: string }>(`SELECT status FROM fixed_assets WHERE id = $1`, [faB])).status).toBe("disposed");
    expect((await one<{ status: string }>(`SELECT status FROM migration_batches WHERE id = $1`, [batchB])).status).toBe("committed");
  }, 120_000);

  it("🔴 ONE asset, nothing depreciated: the reversal marks it reversed with no depreciation to unwind (org X)", async () => {
    batchX = await migrateAssetsOnly(inX, bank.X, cat.X, [assetRow("FX-1", "Compressor", 8_000, 1_000)]);
    faX = (await assetsOfBatch(batchX))[0]!.id;
    // and A's scope cannot reach X's batch either
    expect((await refusal(inA(() => migrationCommitService.reverse(batchX, { reason: "a reversal from the wrong organization" }, userId)))).statusCode).toBe(404);
    const out = await inX(() => migrationCommitService.reverse(batchX, { reason: "the opening position was loaded into the wrong company" }, userId));
    expect("reversed" in out && out.reversed).toEqual({ invoices: 0, bills: 0, deposits: 0, assets: 1, depreciationEntries: 0 });
    const a = await asset(faX, inX);
    expect([a.status, a.reversedByMigrationBatchId, a.carryingAmount]).toEqual(["reversed", batchX, 0]);
    expect(a.events.map((e) => e.kind)).toContain("reversed");
  }, 120_000);

  it("🔴 CONCURRENT reversals of A: exactly one wins — one mirror of the opening journal, one mirror of each of the four depreciation entries; both callers answer, neither errors", async () => {
    const results = await Promise.allSettled([
      inA(() => migrationCommitService.reverse(batchA, { reason: "the previous system's balances were wrong — re-migrating" }, userId)),
      inA(() => migrationCommitService.reverse(batchA, { reason: "the previous system's balances were wrong — re-migrating" }, userId)),
    ]);
    expect(results.map((r) => r.status), JSON.stringify(results.map((r) => (r.status === "rejected" ? String(r.reason) : "")))).toEqual(["fulfilled", "fulfilled"]);
    const outs = results.map((r) => (r as PromiseFulfilledResult<Record<string, unknown>>).value);
    const winner = outs.filter((o) => "reversed" in o);
    expect(winner).toHaveLength(1);
    expect(winner[0]!.reversed).toEqual({ invoices: 1, bills: 1, deposits: 0, assets: 2, depreciationEntries: 4 });
    expect(outs.every((o) => o.status === "reversed")).toBe(true);
    expect(Number((await one<{ n: number }>(`SELECT count(*)::int n FROM journal_entries WHERE reversal_of = $1`, [openingJeA])).n)).toBe(1);
    for (const [key, je] of Object.entries(depJe).filter(([k]) => !k.startsWith(`${nativeA}:`))) {
      const mirrors = (await pool.query(`SELECT r.date::text d, o.date::text od, o.status FROM journal_entries r JOIN journal_entries o ON o.id = r.reversal_of WHERE r.reversal_of = $1`, [je])).rows;
      expect(mirrors, key).toHaveLength(1);
      expect([mirrors[0].d, mirrors[0].status], key).toEqual([mirrors[0].od, "reversed"]); // dated as it was; the original is in the books, marked
    }
    // the press brake's depreciation is untouched
    for (const period of ["2026-07", "2026-08"]) {
      expect((await one<{ status: string }>(`SELECT status FROM journal_entries WHERE id = $1`, [depJe[`${nativeA}:${period}`]])).status).toBe("posted");
    }
    // REPEATED: a third call is a no-op answer — nothing new written
    const jeCount = async () => Number((await one<{ n: number }>(`SELECT count(*)::int n FROM journal_entries WHERE company_id = $1`, [coA])).n);
    const before = await jeCount();
    const again = await inA(() => migrationCommitService.reverse(batchA, { reason: "the previous system's balances were wrong — re-migrating" }, userId));
    expect([again.status, "reversed" in again]).toEqual(["reversed", false]);
    expect(await jeCount()).toBe(before);
  }, 180_000);

  it("🔴 Option A: the assets are MARKED reversed — no disposal, no proceeds, no gain or loss; out of every run; their rows kept; the database refuses to depreciate them or to edit them", async () => {
    for (const [id, unwound] of [[fa1, 2], [fa2, 2]] as const) {
      const a = await asset(id);
      expect([a.status, a.reversedByMigrationBatchId, a.disposal, a.disposalDate, a.carryingAmount]).toEqual(["reversed", batchA, null, null, 0]);
      expect(a.reversedAt).not.toBeNull();
      expect(a.schedule.length).toBe(24); // kept, as history
      const ev = a.events.find((e) => e.kind === "reversed")!;
      expect(ev.payload).toMatchObject({ migrationBatchId: batchA, openingJournalEntryId: openingJeA });
      expect((ev.payload as { depreciationUnwound: unknown[] }).depreciationUnwound).toHaveLength(unwound);
    }
    expect(Number((await one<{ n: number }>(`SELECT count(*)::int n FROM asset_disposals WHERE asset_id = ANY($1::int[])`, [[fa1, fa2]])).n)).toBe(0);
    const gainLoss = await one<{ id: number }>(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = 'ASSET_DISPOSAL_GAIN_LOSS'`, [orgId]);
    if (gainLoss) expect(await glBalance(coA, Number(gainLoss.id), "2099-12-31")).toBe(0);
    // AFTER the reversal: the run posts only the press brake; the act refuses a reversed asset by name
    const sep = await inA(() => assetCapitalisationService.runPeriod({ period: "2026-09" }, userId));
    expect([sep.posted.map((p) => p.assetId), sep.skipped]).toEqual([[nativeA], []]);
    depJe[`${nativeA}:2026-09`] = sep.posted[0]!.journalEntryId;
    const e = await refusal(inA(() => assetCapitalisationService.depreciate(fa1, { period: "2026-09" }, userId)));
    expect([e.statusCode, e.payload?.code]).toEqual([409, "asset_not_in_service"]);
    // the DATABASE refuses it too — posting a planned row, or planting a new one
    const posting = await refusal(pool.query(`UPDATE asset_depreciation_schedule SET journal_entry_id = $2, posted_at = now() WHERE asset_id = $1 AND period = '2026-09'`, [fa1, depJe[`${nativeA}:2026-09`]]));
    expect(posting.constraint).toBe("depreciation_asset_out_of_books");
    const planting = await refusal(pool.query(
      `INSERT INTO asset_depreciation_schedule (organization_id, company_id, asset_id, period, sequence, amount, accumulated_after, carrying_after)
       VALUES ($1, $2, $3, '2030-01', 99, 1, 1, 1)`, [orgId, coA, fa1]));
    expect(planting.constraint).toBe("depreciation_asset_out_of_books");
    // the reversed asset is FROZEN, and nothing un-reverses it
    expect((await refusal(pool.query(`UPDATE fixed_assets SET name = 'renamed' WHERE id = $1`, [fa1]))).constraint).toBe("asset_frozen");
    expect((await refusal(pool.query(`UPDATE fixed_assets SET status = 'in_service', reversed_at = NULL, reversed_by_migration_batch_id = NULL WHERE id = $1`, [fa1]))).constraint).toBe("asset_frozen");
    // and no VAT Art. 52 use is stated for it — the report no longer reads it, so the figure could never be shown
    const use = await refusal(inA(() => vatCapitalAssetService.declareUse({ assetId: fa1, periodIndex: 1, actualUsePct: 50, basis: "exclusive_use" }, userId)));
    expect([use.statusCode, use.payload?.code]).toEqual([409, "asset_reversed"]);
    // and the marker is only ever written by the reversal of the batch that created the asset
    expect((await refusal(pool.query(`UPDATE fixed_assets SET status = 'reversed', reversed_at = now(), reversed_by_migration_batch_id = migration_batch_id WHERE id = $1`, [nativeA]))).constraint).toBe("asset_reversal_marker");
  }, 120_000);

  it("🔴 GL and BALANCE SHEET restored: every opening balance (AR, AP, inventory, the provision, capital, cost, accumulated) is zero at every date, and A's balance sheet reads EXACTLY as the never-migrated control's", async () => {
    await inC(() => assetCapitalisationService.runPeriod({ period: "2026-09" }, userId));
    const accounts = {
      AR: Number((await one<{ id: number }>(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = 'AR'`, [orgId])).id),
      inventory: await accountId("Inventory"),
      provision: await accountId("Q3 provision for end-of-service benefits"),
      capital: await accountId("Q3 owner capital"),
    };
    for (const asOf of DATES) for (const [name, id] of Object.entries(accounts)) expect(await glBalance(coA, id, asOf), `${name} @ ${asOf}`).toBe(0);
    // the opening payable is gone from AP; the press brake's bill (27,600) is all that remains — as in C
    const ap = Number((await one<{ id: number }>(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = 'AP'`, [orgId])).id);
    expect(await glBalance(coA, ap, "2026-06-30")).toBe(0);
    expect(await glBalance(coA, ap, "2026-09-30")).toBe(await glBalance(coC, ap, "2026-09-30"));
    expect(await glBalance(coA, ap, "2026-09-30")).toBe(-27_600);
    // the opening receivable and bill are marked reversed (Policy C), not deleted
    expect((await pool.query(`SELECT invoice_number, reversed_by_migration_batch_id AS b FROM invoices WHERE company_id = $1`, [coA])).rows).toEqual([{ invoice_number: "Q3-INV-1", b: batchA }]);
    // the balance sheet, line by line and in total, at every as-of date
    for (const asOf of DATES) expect(await sheet(inA, asOf), asOf).toEqual(await sheet(inC, asOf));
  }, 180_000);

  it("🔴 the asset register ties to the GL, and the DEPRECIATION register ties to the depreciation expense — both read exactly as the control's", async () => {
    const [rA, rC] = [await inA(() => assetReportsService.report({ from: "2026-01-01", to: "2026-12-31" })), await inC(() => assetReportsService.report({ from: "2026-01-01", to: "2026-12-31" }))];
    expect(rA.reconciles, JSON.stringify(rA.controls)).toBe(true);
    const ctl = (r: typeof rA, id: string) => { const c = r.controls.find((x) => x.id === id && x.categoryName === "Machinery")!; return [c.register, c.ledger, c.status]; };
    expect(ctl(rA, "FA_COST")).toEqual([24_000, 24_000, "pass"]);
    expect(ctl(rA, "FA_ACCUMULATED")).toEqual([1_500, 1_500, "pass"]);
    expect(ctl(rA, "FA_EXPENSE")).toEqual([1_500, 1_500, "pass"]);
    for (const id of ["FA_COST", "FA_ACCUMULATED", "FA_EXPENSE"]) expect(ctl(rA, id)).toEqual(ctl(rC, id));
    expect(rA.totals).toEqual(rC.totals);
    // the depreciation register, read straight from the rows: what the live assets posted = the expense account's balance
    const expense = Number((await one<{ id: number }>(`SELECT depreciation_expense_account_id AS id FROM asset_categories WHERE id = $1`, [cat.A])).id);
    const register = Number((await one<{ v: string }>(
      `SELECT coalesce(sum(s.amount), 0)::text v FROM asset_depreciation_schedule s JOIN fixed_assets a ON a.id = s.asset_id
        WHERE a.company_id = $1 AND a.status <> 'reversed' AND s.journal_entry_id IS NOT NULL`, [coA])).v);
    expect([register, await glBalance(coA, expense, "2026-12-31")]).toEqual([1_500, 1_500]);
    // and the reversed assets' posted rows each point at an entry in the books, mirrored — they net to zero in the GL
    const rev = (await pool.query(
      `SELECT s.journal_entry_id AS je, e.status FROM asset_depreciation_schedule s JOIN journal_entries e ON e.id = s.journal_entry_id WHERE s.asset_id = ANY($1::int[])`, [[fa1, fa2]])).rows;
    expect(rev.map((r) => r.status)).toEqual(["reversed", "reversed", "reversed", "reversed"]);
  }, 120_000);

  it("🔴 REPLACEMENT: a new batch replaces the reversed one; its assets name the assets they replace; ONE live asset per source id (the database refuses a duplicate); the register still ties", async () => {
    replacementA = await migrateA({ fa2Accumulated: 14_000, replacement: true });
    expect((await one<{ r: number }>(`SELECT replaces_batch_id AS r FROM migration_batches WHERE id = $1`, [replacementA])).r).toBe(batchA);
    const rows = await assetsOfBatch(replacementA);
    const [nfa1, nfa2] = rows.map((r) => r.id);
    const [n1, n2] = [await asset(nfa1!), await asset(nfa2!)];
    expect([n1.status, n1.replacesAssetId, n1.sourceReference]).toEqual(["in_service", fa1, "FA-1"]);
    expect([n2.status, n2.replacesAssetId, n2.openingAccumulatedDepreciation]).toEqual(["in_service", fa2, 14_000]);
    // the lineage reads both ways
    expect([(await asset(fa1)).replacedByAssetId, (await asset(fa2)).replacedByAssetId]).toEqual([nfa1, nfa2]);
    expect((await asset(nativeA)).replacedByAssetId).toBeNull();
    // ONE live migrated asset per source id: the two reversed stay, the two live replace them
    const bySource = (await pool.query(
      `SELECT source_reference s, count(*) FILTER (WHERE status <> 'reversed')::int live, count(*) FILTER (WHERE status = 'reversed')::int rev
         FROM fixed_assets WHERE company_id = $1 AND source = 'migration' GROUP BY 1 ORDER BY 1`, [coA])).rows;
    expect(bySource).toEqual([{ s: "FA-1", live: 1, rev: 1 }, { s: "FA-2", live: 1, rev: 1 }]);
    // PLANTED (triggers off, so only the index speaks): a second live asset for FA-1 is refused by the database
    const cols = (await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'fixed_assets' AND column_name NOT IN ('id','asset_number','replaces_asset_id') ORDER BY ordinal_position`)).rows.map((r) => `"${r.column_name}"`).join(", ");
    // (from ANOTHER batch — the FA-D index already refuses one source id twice in ONE batch; this index is per COMPANY)
    const dupCols = cols.split(", ").filter((c) => c !== '"migration_batch_id"').join(", ");
    const dup = await refusal(plant(`INSERT INTO fixed_assets (asset_number, migration_batch_id, ${dupCols}) SELECT 'Q3-DUP-1', $2, ${dupCols} FROM fixed_assets WHERE id = $1`, [nfa1, batchB]));
    expect([dup.code, dup.constraint]).toEqual(["23505", "fixed_assets_migrated_source_live_unq"]);
    // a replacement link may name only a REVERSED migrated asset of this company (triggers ON: the admit trigger speaks)
    const link = await refusal(pool.query(`INSERT INTO fixed_assets (asset_number, replaces_asset_id, ${cols}) SELECT 'Q3-LINK-1', $2, ${cols} FROM fixed_assets WHERE id = $1`, [nfa1, nativeA]));
    expect(link.constraint).toBe("asset_replacement_link");
    // the replacement's schedule resumes in July; catching it up keeps the register tied
    expect((await asset(nfa2!)).schedule[0]).toMatchObject({ period: "2026-07", sequence: 25, amount: 1_083.33 });
    for (const period of ["2026-07", "2026-08", "2026-09"]) {
      const run = await inA(() => assetCapitalisationService.runPeriod({ period }, userId));
      expect(run.posted.map((p) => p.assetId).sort(), period).toEqual([nfa1, nfa2].sort());
    }
    const rep = await inA(() => assetReportsService.report({ from: "2026-01-01", to: "2026-12-31" }));
    expect(rep.reconciles, JSON.stringify(rep.controls)).toBe(true);
    const c = rep.controls.find((x) => x.id === "FA_COST" && x.categoryName === "Machinery")!;
    expect([c.register, c.ledger]).toEqual([124_000, 124_000]);
    // every journal of the company balances
    expect((await pool.query(`SELECT e.entry_number FROM journal_entries e JOIN journal_entry_lines l ON l.journal_entry_id = e.id WHERE e.company_id = $1 GROUP BY e.id HAVING sum(l.debit_amount) <> sum(l.credit_amount)`, [coA])).rows).toEqual([]);
  }, 300_000);

  it("🔴 the ledger invariant sweep: clean for these organizations after everything above — and it SEES a reversed asset whose depreciation is not mirrored (planted)", async () => {
    const { execFileSync } = await import("node:child_process");
    const { mkdtempSync, readFileSync, existsSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join: joinPath } = await import("node:path");
    const sweep = (name: string) => {
      const out = joinPath(mkdtempSync(joinPath(tmpdir(), "q3-inv-")), `${name}.json`);
      try { execFileSync(process.execPath, ["--import", "tsx", "src/scripts/ledgerInvariants.ts", "--json", out], { cwd: joinPath(__dirname, "..", ".."), env: process.env, stdio: "pipe", timeout: 180_000 }); } catch { /* exit 2 is fine; the report is written */ }
      expect(existsSync(out)).toBe(true);
      const report = JSON.parse(readFileSync(out, "utf8")) as Record<string, Array<Record<string, unknown>>>;
      return Object.fromEntries(Object.entries(report).map(([k, rows]) => [k.split(" ")[0], rows.filter((r) => r.org === orgId || r.org === orgX)]).filter(([, rows]) => (rows as unknown[]).length > 0));
    };
    expect(sweep("clean")).toEqual({});
    const je = depJe[`${fa1}:2026-07`]!;
    await plant(`UPDATE journal_entries SET status = 'posted' WHERE id = $1`, [je]);
    try {
      const planted = sweep("planted");
      expect(Object.keys(planted)).toContain("asset_reversed_unwound");
      expect(planted.asset_reversed_unwound).toEqual([expect.objectContaining({ org: orgId, id: fa1, period: "2026-07" })]);
    } finally {
      await plant(`UPDATE journal_entries SET status = 'reversed' WHERE id = $1`, [je]);
    }
    expect(sweep("restored")).toEqual({});
  }, 600_000);
});
