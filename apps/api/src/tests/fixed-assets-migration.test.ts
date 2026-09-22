/**
 * FIXED ASSETS — FA-D: MIGRATED ASSETS (2026-09-22), on real rows.
 * Record: docs/product/fixed-assets-decision-pack.md §10, §23; the expected
 * result is the pack's own §17 test matrix, row 14.
 *
 *   · the staged assets create NO journal line: the opening journal carries
 *     `Dr cost / Cr accumulated` from the TRIAL BALANCE, and the register ties
 *     to it — the control FIXED_ASSETS_CONTROL passes only when the two agree
 *     and BLOCKS the commit when they do not (presence, absence AND movement:
 *     the same position passes, then fails when one asset is removed, then
 *     passes again);
 *   · no opening-balance-equity account is involved and the position stays
 *     balanced (A5);
 *   · at commit each asset becomes a register row IN SERVICE on the opening
 *     journal, carrying its opening accumulated depreciation and periods,
 *     with a schedule that RESUMES the month after the opening date over the
 *     remaining life (pack §17 row 8's arithmetic, now end to end);
 *   · the next monthly run posts that resumed row, and the derived figures
 *     read opening + posted;
 *   · an asset still inside its VAT Art. 52 adjustment period must carry its
 *     input-tax facts, and an asset in service AFTER the opening date is
 *     refused — both by name.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { assetsService } from "../services/assets.service";
import { assetCapitalisationService } from "../services/assets/capitalisation.service";
import { migrationService } from "../services/migration.service";
import { migrationStagingService } from "../services/migrationStaging.service";
import { migrationValidationService } from "../services/migrationValidation.service";
import { migrationCommitService } from "../services/migrationCommit.service";
import { bankAccountsService } from "../services/bankAccounts.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

describeMaybe("FA-D — migrated fixed assets (real rows)", () => {
  const SLUG = "fa-d";
  const EMAIL = "fa-d@test.local";
  let orgId = "", companyId = "", userId = 0, bank = 0, batchId = 0, catId = 0;

  const inTenant = async <T,>(fn: () => Promise<T>): Promise<T> => {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
    try {
      const out = await conn.run(() => auditContext.run({ userId, organizationId: orgId, ipAddress: null }, fn));
      await conn.commit();
      return out;
    } catch (err) { await conn.rollback(); throw err; }
  };
  const cleanup = async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Teardown only: a committed migration's staging rows are immutable by
      // trigger (Batch 1C) and the asset register refuses deletes by design —
      // both guard the APP, and a fixture must still be removable. The same
      // posture the AP suites use.
      await client.query("SET LOCAL session_replication_role = replica");
      const org = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
      for (const t of ["asset_disposals", "asset_events", "asset_depreciation_schedule", "migration_assets", "fixed_assets", "asset_categories", "migration_advances", "migration_open_items", "migration_parties", "migration_chart_rows", "journal_entry_lines", "journal_entries", "migration_batches", "period_locks", "audit_logs", "organization_memberships", "bank_accounts", "categories", "companies"]) {
        await client.query(`DELETE FROM ${t} WHERE organization_id IN ${org}`);
      }
      await client.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
      await client.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
      await client.query("COMMIT");
    } catch (err) { await client.query("ROLLBACK"); throw err; } finally { client.release(); }
  };
  const control = (checks: Array<{ id: string; status: string; detail: string; expected: unknown; actual: unknown }>, id: string) => checks.find((c) => c.id === id)!;
  /** The staged chart: a bank, the asset cost, its accumulated depreciation and capital to balance. */
  const stageChart = async (cost: number, accumulated: number) => {
    await inTenant(() => migrationService.importChart(batchId, { rows: [
      { sourceCode: "1100", sourceName: "Bank", sourceType: "asset", openingDebit: 10_000, sourceRole: "bank", evidenceNote: "stmt" },
      { sourceCode: "1500", sourceName: "Machinery at cost", sourceType: "asset", openingDebit: cost },
      { sourceCode: "1590", sourceName: "Accumulated depreciation — machinery", sourceType: "asset", openingCredit: accumulated },
      { sourceCode: "3100", sourceName: "Capital", sourceType: "equity", openingCredit: 10_000 + cost - accumulated },
    ] }, userId));
    const chart = await inTenant(() => migrationService.getChart(batchId));
    const row = (code: string) => chart.rows.find((r) => r.sourceCode === code)!;
    // FIXED_ASSETS is an M15 DEFAULT category (merged into by id); ACCUMULATED_DEPRECIATION is a platform SYSTEM account (mapped by code) — the two doors the chart mapper offers
    const costAccountId = (await pool.query(`SELECT cost_account_id FROM asset_categories WHERE id = $1`, [catId])).rows[0].cost_account_id;
    await inTenant(() => migrationService.decideChartRow(batchId, row("1100").id, { decision: "map_to_bank", targetBankAccountId: bank }, userId));
    await inTenant(() => migrationService.decideChartRow(batchId, row("1500").id, { decision: "merge_into", targetCategoryId: costAccountId }, userId));
    await inTenant(() => migrationService.decideChartRow(batchId, row("1590").id, { decision: "map_to_system", targetSystemCode: "ACCUMULATED_DEPRECIATION" }, userId));
    await inTenant(() => migrationService.decideChartRow(batchId, row("3100").id, { decision: "create" }, userId));
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('FA D','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (await pool.query(`INSERT INTO companies (organization_id, name, fiscal_year_start) VALUES ($1,'FA D Co',1) RETURNING id`, [orgId])).rows[0].id;
    userId = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','FA D',' ','admin',true) RETURNING id`)).rows[0].id;
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, orgId]);
    bank = (await inTenant(() => bankAccountsService.create({ name: "Riyad Main", bankName: "Riyad Bank", currency: "SAR" }))).id;
    catId = (await inTenant(() => assetsService.createCategory({ name: "Machinery", defaultUsefulLifeMonths: 48, incomeTaxGroup: 3, vatCapitalAssetClass: "movable" }, userId))).id;
    const b = await inTenant(() => migrationService.createBatch({ sourceSystem: "PreviousERP", cutoverDate: "2026-07-01" }, userId));
    batchId = b.id;
    await stageChart(100_000, 30_000);
  }, 120_000);
  afterAll(cleanup);

  it("🔴 the register must TIE to the trial balance: the control passes on the true position, FAILS when an asset is missing, and passes again when it is staged — no balancing entry anywhere", async () => {
    // the true position: one asset of 100,000 with 30,000 accumulated
    await inTenant(() => migrationStagingService.importAssets(batchId, { rows: [
      { sourceId: "FA-1", name: "CNC machine", categoryName: "Machinery", acquisitionDate: "2024-07-01", availableForUseDate: "2024-07-01", cost: 100_000, usefulLifeMonths: 48, openingAccumulatedDepreciation: 30_000, openingPeriodsBooked: 24, vatInputTaxAmount: 15_000, vatInitialRecoveryPct: 100 },
    ] }, userId));
    const ok = await inTenant(() => migrationValidationService.validate(batchId, userId));
    expect(control(ok.checks, "FIXED_ASSETS_CONTROL").status).toBe("pass");
    expect(control(ok.checks, "FIXED_ASSETS_WELL_FORMED").status).toBe("pass");
    expect(control(ok.checks, "CHART_BALANCED").status).toBe("pass");
    // MOVEMENT: understate the register and the control must see it (a register that does not tie is two truths)
    await inTenant(() => migrationStagingService.importAssets(batchId, { rows: [
      { sourceId: "FA-1", name: "CNC machine", categoryName: "Machinery", acquisitionDate: "2024-07-01", availableForUseDate: "2024-07-01", cost: 60_000, usefulLifeMonths: 48, openingAccumulatedDepreciation: 30_000, openingPeriodsBooked: 24, vatInputTaxAmount: 9_000, vatInitialRecoveryPct: 100 },
    ] }, userId));
    const bad = await inTenant(() => migrationValidationService.validate(batchId, userId));
    expect(bad.ok).toBe(false);
    const c = control(bad.checks, "FIXED_ASSETS_CONTROL");
    expect(c.status).toBe("fail");
    expect(String(c.expected)).toContain("100000.00");
    expect(String(c.actual)).toContain("60000.00");
    expect(c.detail).toMatch(/adds NO journal line/);
    // and back: the position is unchanged, only the register was wrong
    await inTenant(() => migrationStagingService.importAssets(batchId, { rows: [
      { sourceId: "FA-1", name: "CNC machine", categoryName: "Machinery", acquisitionDate: "2024-07-01", availableForUseDate: "2024-07-01", cost: 100_000, usefulLifeMonths: 48, openingAccumulatedDepreciation: 30_000, openingPeriodsBooked: 24, vatInputTaxAmount: 15_000, vatInitialRecoveryPct: 100 },
    ] }, userId));
    const again = await inTenant(() => migrationValidationService.validate(batchId, userId));
    expect(control(again.checks, "FIXED_ASSETS_CONTROL").status).toBe("pass");
    // there is no opening-balance-equity account anywhere in this company (A5)
    expect((await pool.query(`SELECT count(*)::int n FROM categories WHERE organization_id = $1 AND system_code = 'OPENING_BALANCE_EQUITY'`, [orgId])).rows[0].n).toBe(0);
  }, 120_000);

  it("🔴 named refusals: an asset in service AFTER the opening date, an unknown category, and one still inside its Art. 52 adjustment period with no input-tax facts", async () => {
    const problemsOf = async (row: Record<string, unknown>) => {
      await inTenant(() => migrationStagingService.importAssets(batchId, { rows: [
        { sourceId: "FA-1", name: "CNC machine", categoryName: "Machinery", acquisitionDate: "2024-07-01", availableForUseDate: "2024-07-01", cost: 100_000, usefulLifeMonths: 48, openingAccumulatedDepreciation: 30_000, openingPeriodsBooked: 24, vatInputTaxAmount: 15_000, vatInitialRecoveryPct: 100 },
        row as never,
      ] }, userId));
      const staged = await inTenant(() => migrationStagingService.getAssets(batchId));
      return staged.rows.find((r) => r.sourceId === "FA-X")!.problems;
    };
    expect((await problemsOf({ sourceId: "FA-X", name: "Late", categoryName: "Machinery", acquisitionDate: "2026-08-01", availableForUseDate: "2026-08-15", cost: 1_000, usefulLifeMonths: 12, openingAccumulatedDepreciation: 0, openingPeriodsBooked: 0, vatInputTaxAmount: 150, vatInitialRecoveryPct: 100 })).join(" ")).toMatch(/after the opening date/);
    expect((await problemsOf({ sourceId: "FA-X", name: "Odd", categoryName: "Nonexistent", acquisitionDate: "2024-01-01", availableForUseDate: "2024-01-01", cost: 1_000, usefulLifeMonths: 12, openingAccumulatedDepreciation: 0, openingPeriodsBooked: 0 })).join(" ")).toMatch(/does not exist in this company/);
    // acquired 2025: still inside the 4-year (life-shortened) adjustment period, so the input-tax facts are required
    expect((await problemsOf({ sourceId: "FA-X", name: "Recent", categoryName: "Machinery", acquisitionDate: "2025-01-01", availableForUseDate: "2025-01-01", cost: 1_000, usefulLifeMonths: 48, openingAccumulatedDepreciation: 0, openingPeriodsBooked: 0 })).join(" ")).toMatch(/still inside its \d+-year VAT adjustment period/);
    // the import guards refuse the impossible outright
    await expect(inTenant(() => migrationStagingService.importAssets(batchId, { rows: [{ sourceId: "A", name: "x", categoryName: "Machinery", acquisitionDate: "2024-01-01", availableForUseDate: "2024-01-01", cost: 100, usefulLifeMonths: 12, openingAccumulatedDepreciation: 200, openingPeriodsBooked: 1 }] }, userId))).rejects.toThrow(/exceeds the depreciable amount/);
    await expect(inTenant(() => migrationStagingService.importAssets(batchId, { rows: [{ sourceId: "A", name: "x", categoryName: "Machinery", acquisitionDate: "2024-01-01", availableForUseDate: "2024-01-01", cost: 100, usefulLifeMonths: 12, openingAccumulatedDepreciation: 0, openingPeriodsBooked: 0, vatInitialRecoveryPct: 0 }] }, userId))).rejects.toThrow(/Art\. 50/);
    // restore the good single row
    await inTenant(() => migrationStagingService.importAssets(batchId, { rows: [
      { sourceId: "FA-1", name: "CNC machine", categoryName: "Machinery", acquisitionDate: "2024-07-01", availableForUseDate: "2024-07-01", cost: 100_000, usefulLifeMonths: 48, openingAccumulatedDepreciation: 30_000, openingPeriodsBooked: 24, vatInputTaxAmount: 15_000, vatInitialRecoveryPct: 100 },
    ] }, userId));
  }, 120_000);

  it("🔴 row 14 — at commit the opening journal carries Dr cost 100,000 / Cr accumulated 30,000 from the TRIAL BALANCE and the asset is a register row IN SERVICE on that entry; its schedule resumes 2026-07 at sequence 25; the next run posts it", async () => {
    const v = await inTenant(() => migrationValidationService.validate(batchId, userId));
    expect(v.ok, JSON.stringify(v.checks.filter((c) => c.status === "fail"))).toBe(true);
    await inTenant(() => migrationCommitService.commit(batchId, userId));
    const je = (await pool.query(`SELECT id FROM journal_entries WHERE organization_id = $1 AND entry_number = $2`, [orgId, `MIG-${batchId}-OPEN`])).rows[0];
    const lines = (await pool.query(
      `SELECT c.name, l.debit_amount::text d, l.credit_amount::text c FROM journal_entry_lines l JOIN categories c ON c.id = l.account_id WHERE l.journal_entry_id = $1 ORDER BY c.name`, [je.id])).rows.map((r) => [r.name, r.d, r.c]);
    expect(lines).toContainEqual(["Fixed Assets", "100000.00", "0.00"]);
    expect(lines).toContainEqual(["Accumulated depreciation", "0.00", "30000.00"]);
    // the register row: in service on THAT entry, its opening position recorded, nothing else posted
    const staged = await inTenant(() => migrationStagingService.getAssets(batchId));
    const assetId = staged.rows[0]!.resolvedAssetId!;
    const a = await inTenant(() => assetsService.getById(assetId));
    expect([a.status, a.source, a.migrationBatchId, a.sourceReference, a.capitalisationJournalEntryId]).toEqual(["in_service", "migration", batchId, "FA-1", je.id]);
    expect([a.cost, a.openingAccumulatedDepreciation, a.openingPeriodsBooked, a.accumulatedDepreciation, a.carryingAmount]).toEqual([100_000, 30_000, 24, 30_000, 70_000]);
    expect([a.incomeTaxGroup, a.vatCapitalAssetClass, a.vatInputTaxAmount]).toEqual([3, "movable", 15_000]);
    // the schedule RESUMES after the opening date, at the right sequence, over the remaining life
    expect(a.schedule).toHaveLength(24); // 48 − 24 booked
    // the opening position is as at 2026-06-30 (the day before the cutover), so the first period the PRODUCT depreciates is July 2026
    expect([a.schedule[0]!.period, a.schedule[0]!.sequence, a.schedule[0]!.amount]).toEqual(["2026-07", 25, 2_916.67]);
    expect([a.schedule[23]!.period, a.schedule[23]!.sequence, a.schedule[23]!.carryingAfter]).toEqual(["2028-06", 48, 0]);
    expect(Math.round(a.schedule.reduce((s, r) => s + r.amount, 0) * 100) / 100).toBe(70_000);
    expect(a.events.map((e) => e.kind)).toEqual(["capitalised"]);
    expect(a.events[0]!.payload).toMatchObject({ migrated: true, batchId, sourceId: "FA-1", openingPeriodsBooked: 24 });
    // the next monthly run posts the resumed row, and the figures read opening + posted
    const run = await inTenant(() => assetCapitalisationService.depreciate(assetId, { period: "2026-07" }, userId));
    expect(run.amount).toBe(2_916.67);
    const after = await inTenant(() => assetsService.getById(assetId));
    expect([after.accumulatedDepreciation, after.carryingAmount, after.postedPeriods]).toEqual([32_916.67, 67_083.33, 1]);
    // the staging row is frozen now (Batch 1C's own trigger), and every journal balances
    await expect(pool.query(`UPDATE migration_assets SET cost = 1 WHERE batch_id = $1`, [batchId])).rejects.toThrow(/staging rows are immutable/);
    expect((await pool.query(`SELECT e.entry_number FROM journal_entries e JOIN journal_entry_lines l ON l.journal_entry_id = e.id WHERE e.organization_id = $1 GROUP BY e.id HAVING sum(l.debit_amount) <> sum(l.credit_amount)`, [orgId])).rows).toEqual([]);
  }, 180_000);
});
