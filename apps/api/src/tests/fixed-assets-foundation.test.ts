/**
 * FIXED ASSETS — FA-A FOUNDATION (2026-09-22), on real rows.
 * Decision record: docs/product/fixed-assets-decision-pack.md §3, §6, §13, §17.
 *
 * What the foundation must prove before anything posts:
 *   1. the schedule arithmetic (pack §17 row 6): 48 rows, one rounded addend,
 *      the last row absorbs the residue, Σ = the depreciable amount exactly,
 *      carrying after the last row = the residual; a migrated asset resumes
 *      its life after the opening date (row 8); an unsupported method is a
 *      NAMED refusal;
 *   2. a DRAFT moves nothing (row 1 — the zero-movement standard): the trial
 *      balance and the income statement are unchanged, and the register's
 *      totals count it as a draft, not as cost on the balance sheet;
 *   3. the DATABASE, not the caller, owns the invariants: one row per
 *      (asset, period); a posted schedule row is frozen; asset_events is
 *      append-only; a capitalised asset's facts of record cannot be edited;
 *      an asset is never hard-deleted by the app role;
 *   4. the three system accounts exist for a new org (the trigger) and for
 *      an old one (the backfill);
 *   5. the company's income-tax share is pinned to its ownership type;
 *   6. a category's tax group / VAT class / accounts are frozen while an
 *      asset is under it; a mistyped account is refused.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool, SYSTEM_CHART_OF_ACCOUNTS } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { assetsService } from "../services/assets.service";
import { reportsService } from "../services/reports.service";
import { postJournalEntry } from "../services/accounting/glPosting";
import { generateStraightLineSchedule, lastDayOf, shiftPeriod } from "../services/assets/depreciationSchedule";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

describe("the depreciation schedule — pure arithmetic", () => {
  it("🔴 straight-line, 100,000 / residual 10,000 / 48 months / in service 15 Mar: 48 rows Mar Y1 … Feb Y5, 47 × 1,875.00 and a last row absorbing the residue; Σ = 90,000; carrying after the last row = 10,000", () => {
    const rows = generateStraightLineSchedule({ cost: 100_000, residualValue: 10_000, usefulLifeMonths: 48, depreciationMethod: "straight_line", availableForUseDate: "2026-03-15" });
    expect(rows).toHaveLength(48);
    expect(rows[0]).toMatchObject({ sequence: 1, period: "2026-03", amount: 1875, accumulatedAfter: 1875, carryingAfter: 98_125 });
    expect(rows[47]).toMatchObject({ sequence: 48, period: "2030-02", accumulatedAfter: 90_000, carryingAfter: 10_000 });
    expect(rows.slice(0, 47).every((r) => r.amount === 1875)).toBe(true);
    expect(Math.round(rows.reduce((s, r) => s + r.amount, 0) * 100) / 100).toBe(90_000);
  });
  it("🔴 rounding: 1,000 over 12 months is 83.33 × 11 + 83.37 — one rounded addend per row, the last row takes the residue, Σ exact", () => {
    const rows = generateStraightLineSchedule({ cost: 1_000, residualValue: 0, usefulLifeMonths: 12, depreciationMethod: "straight_line", availableForUseDate: "2026-01-01" });
    expect(rows.map((r) => r.amount)).toEqual([...Array(11).fill(83.33), 83.37]);
    expect(rows[11]!.carryingAfter).toBe(0);
  });
  it("🔴 a migrated asset (opening accumulated 30,000; 16 periods booked; opening date 2026-06-30) resumes at sequence 17 in 2026-07 with 32 rows over the remaining 60,000", () => {
    const rows = generateStraightLineSchedule({ cost: 100_000, residualValue: 10_000, usefulLifeMonths: 48, depreciationMethod: "straight_line", availableForUseDate: "2025-03-01", openingAccumulated: 30_000, openingPeriodsBooked: 16, openingDate: "2026-06-30" });
    expect(rows).toHaveLength(32);
    expect(rows[0]).toMatchObject({ sequence: 17, period: "2026-07", amount: 1875, accumulatedAfter: 31_875 });
    expect(rows[31]).toMatchObject({ sequence: 48, period: "2029-02", accumulatedAfter: 90_000, carryingAfter: 10_000 });
  });
  it("a fully-depreciated arrival has no rows; an unsupported method is a NAMED refusal; period helpers", () => {
    expect(generateStraightLineSchedule({ cost: 1_000, residualValue: 0, usefulLifeMonths: 12, depreciationMethod: "straight_line", availableForUseDate: "2024-01-01", openingAccumulated: 1_000, openingPeriodsBooked: 12, openingDate: "2025-12-31" })).toEqual([]);
    expect(() => generateStraightLineSchedule({ cost: 1_000, residualValue: 0, usefulLifeMonths: 12, depreciationMethod: "declining_balance", availableForUseDate: "2026-01-01" })).toThrow(/depreciation_method_unsupported|not computed yet/);
    expect(shiftPeriod("2026-11", 3)).toBe("2027-02");
    expect(shiftPeriod("2026-01", -1)).toBe("2025-12");
    expect(lastDayOf("2028-02")).toBe("2028-02-29");
    expect(lastDayOf("2026-04")).toBe("2026-04-30");
  });
});

describeMaybe("FA-A foundation — the register on real rows", () => {
  const SLUG = "fa-a";
  const EMAIL = "fa-a@test.local";
  let orgId = "", companyId = "", userId = 0, catId = 0, draftId = 0;

  const inTenant = async <T,>(fn: () => Promise<T>): Promise<T> => {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
    try {
      const out = await conn.run(() => auditContext.run({ userId, organizationId: orgId, ipAddress: null }, fn));
      await conn.commit();
      return out;
    } catch (err) { await conn.rollback(); throw err; }
  };
  /** The app role's own raw SQL inside the tenant transaction (what a service COULD do) — the DB must refuse it. */
  const asApp = async (sqlText: string, params: unknown[] = []) => {
    const conn = await beginTenantConnection({ organizationId: orgId, companyId, role: "authenticated" });
    try {
      const out = await conn.run(async () => (await (await import("@workspace/db")).db.execute((await import("drizzle-orm")).sql.raw(sqlText.replace(/\$(\d+)/g, (_, i) => { const v = params[Number(i) - 1]; return typeof v === "string" ? `'${v.replace(/'/g, "''")}'` : String(v); })))).rows);
      await conn.commit();
      return { ok: true as const, rows: out };
    } catch (err) { await conn.rollback(); return { ok: false as const, error: err as Error & { cause?: { code?: string; constraint?: string; message?: string } } }; }
  };
  const cleanup = async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const org = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
      for (const t of ["asset_events", "asset_depreciation_schedule", "fixed_assets", "asset_categories", "journal_entry_lines", "journal_entries", "period_locks", "audit_logs", "organization_memberships", "bank_accounts", "categories", "companies"]) {
        await client.query(`DELETE FROM ${t} WHERE organization_id IN ${org}`);
      }
      await client.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
      await client.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
      await client.query("COMMIT");
    } catch (err) { await client.query("ROLLBACK"); throw err; } finally { client.release(); }
  };
  const expectRefusal = async (p: Promise<unknown>, status: number, code?: string) => {
    let err: { statusCode?: number; status?: number; payload?: { code?: string }; body?: { code?: string }; code?: string; message?: string } | undefined;
    try { await p; } catch (e) { err = e as typeof err; }
    expect(err, "expected a refusal").toBeTruthy();
    expect(err!.statusCode ?? err!.status, err!.message).toBe(status);
    if (code) expect(err!.payload?.code ?? err!.body?.code ?? err!.code).toBe(code);
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('FA A','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (await pool.query(`INSERT INTO companies (organization_id, name, ownership_type) VALUES ($1,'FA A Co','SAUDI_GCC') RETURNING id`, [orgId])).rows[0].id;
    userId = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','FA A',' ','admin',true) RETURNING id`)).rows[0].id;
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, orgId]);
  }, 60_000);
  afterAll(cleanup);

  it("🔴 the three FA-A system accounts exist for a NEW org (the trigger) and for every OLD org (the backfill) — and they are in the one TypeScript definition", async () => {
    for (const code of ["ACCUMULATED_DEPRECIATION", "DEPRECIATION_EXPENSE", "ASSET_DISPOSAL_GAIN_LOSS"]) {
      expect(SYSTEM_CHART_OF_ACCOUNTS.some((a) => a.code === code)).toBe(true);
      const mine = await pool.query(`SELECT type, liquidity_class FROM categories WHERE organization_id = $1 AND system_code = $2`, [orgId, code]);
      expect(mine.rows, code).toHaveLength(1);
      // 🔴 The backfill's claim is about orgs that HAVE a chart. Counting every
      // organization row would also count another fork's fixture mid-teardown
      // (its categories deleted, its org row not yet) — an unscoped global
      // assertion, which is what test-suite-notes §4/§5 is about. SALES is the
      // pre-0088 marker that a chart exists at all.
      const missing = await pool.query(
        `SELECT count(*)::int n FROM organizations o
          WHERE EXISTS (SELECT 1 FROM categories c WHERE c.organization_id = o.id AND c.system_code = 'SALES')
            AND NOT EXISTS (SELECT 1 FROM categories c WHERE c.organization_id = o.id AND c.system_code = $1)`, [code]);
      expect(missing.rows[0].n, `${code} missing on an org that has a chart`).toBe(0);
    }
    expect((await pool.query(`SELECT type FROM categories WHERE organization_id = $1 AND system_code = 'ASSET_DISPOSAL_GAIN_LOSS'`, [orgId])).rows[0].type).toBe("income");
    expect((await pool.query(`SELECT liquidity_class FROM categories WHERE organization_id = $1 AND system_code = 'ACCUMULATED_DEPRECIATION'`, [orgId])).rows[0].liquidity_class).toBe("non_current");
  });

  it("🔴 a category defaults its accounts to the triple (FIXED_ASSETS · ACCUMULATED_DEPRECIATION · DEPRECIATION_EXPENSE), refuses a mistyped account by name, and carries the Art. 17 group's rate", async () => {
    const cat = await inTenant(() => assetsService.createCategory({ name: "Computers", nameAr: "حواسيب", defaultUsefulLifeMonths: 48, incomeTaxGroup: 3, vatCapitalAssetClass: "movable" }, userId));
    catId = cat.id;
    expect([cat.costAccountName, cat.accumulatedDepreciationAccountName, cat.depreciationExpenseAccountName]).toEqual(["Fixed Assets", "Accumulated depreciation", "Depreciation expense"]);
    expect(cat.incomeTaxRatePct).toBe(25);
    const sales = (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = 'SALES'`, [orgId])).rows[0].id;
    await expectRefusal(inTenant(() => assetsService.createCategory({ name: "Bad", defaultUsefulLifeMonths: 12, incomeTaxGroup: 5, vatCapitalAssetClass: "movable", costAccountId: sales }, userId)), 422, "asset_category_account_type");
    await expect(inTenant(() => assetsService.createCategory({ name: "Bad", defaultUsefulLifeMonths: 12, incomeTaxGroup: 6, vatCapitalAssetClass: "movable" }, userId))).rejects.toThrow(/17\(b\)/);
    const list = await inTenant(() => assetsService.listCategories());
    expect(list.incomeTaxGroups.map((g) => [g.group, g.ratePct])).toEqual([[1, 5], [2, 10], [3, 25], [4, 20], [5, 10]]);
  });

  it("🔴 a DRAFT moves nothing: trial balance and income statement unchanged, totals count it as a draft (not cost on the balance sheet), the preview is the 48-row schedule, the events and audit rows exist", async () => {
    const tbBefore = await inTenant(() => reportsService.trialBalance());
    const isBefore = await inTenant(() => reportsService.incomeStatement());
    const a = await inTenant(() => assetsService.create({ name: "Laptop", categoryId: catId, acquisitionDate: "2026-03-10", availableForUseDate: "2026-03-15", cost: 100_000, residualValue: 10_000, vatInputTaxAmount: 15_000 }, userId));
    draftId = a.id;
    expect(a.status).toBe("draft");
    expect(a.assetNumber).toBe("FA-00001");
    expect([a.incomeTaxGroup, a.incomeTaxRatePct, a.vatCapitalAssetClass, a.vatAdjustmentPeriodYears]).toEqual([3, 25, "movable", 4]); // 6 y movable, shortened to the 4-year life (Art. 52(2))
    expect([a.accumulatedDepreciation, a.carryingAmount, a.depreciableAmount]).toEqual([0, 100_000, 90_000]);
    expect(a.plannedSchedule).toHaveLength(48);
    expect(a.schedule).toEqual([]);
    expect(a.events.map((e) => e.kind)).toEqual(["created"]);
    const tbAfter = await inTenant(() => reportsService.trialBalance());
    const isAfter = await inTenant(() => reportsService.incomeStatement());
    expect(tbAfter).toEqual(tbBefore);
    expect(isAfter).toEqual(isBefore);
    expect((await pool.query(`SELECT count(*)::int n FROM journal_entries WHERE organization_id = $1`, [orgId])).rows[0].n).toBe(0);
    const list = await inTenant(() => assetsService.list());
    expect(list.totals).toEqual({ drafts: 1, inService: 0, disposed: 0, cost: 0, accumulatedDepreciation: 0, carryingAmount: 0 });
    expect((await pool.query(`SELECT count(*)::int n FROM audit_logs WHERE organization_id = $1 AND entity_type = 'asset' AND entity_id = $2`, [orgId, String(draftId)])).rows[0].n).toBe(1);
    // a second draft takes the next number; a taken number is refused by name; a recovery of 0 % on a capital asset needs its Art. 50 reason
    const b = await inTenant(() => assetsService.create({ name: "Van", categoryId: catId, acquisitionDate: "2026-04-01", cost: 80_000, vatInitialRecoveryPct: 0, vatNonDeductibleReason: "Restricted motor vehicle — Art. 50(1)(c)" }, userId));
    expect(b.assetNumber).toBe("FA-00002");
    await expectRefusal(inTenant(() => assetsService.create({ name: "Dup", assetNumber: "FA-00001", categoryId: catId, acquisitionDate: "2026-04-01", cost: 1 }, userId)), 409, "asset_number_taken");
    await expectRefusal(inTenant(() => assetsService.create({ name: "Car", categoryId: catId, acquisitionDate: "2026-04-01", cost: 1, vatInitialRecoveryPct: 0 }, userId)), 422, "vat_non_deductible_reason_required");
    await expectRefusal(inTenant(() => assetsService.create({ name: "X", categoryId: catId, acquisitionDate: "2026-04-01", cost: 100, residualValue: 200 }, userId)), 422, "residual_value_invalid");
    // the category's identity is frozen while assets are under it
    await expectRefusal(inTenant(() => assetsService.updateCategory(catId, { incomeTaxGroup: 5 }, userId)), 409, "asset_category_in_use");
    const renamed = await inTenant(() => assetsService.updateCategory(catId, { name: "Computers & equipment" }, userId));
    expect(renamed.name).toBe("Computers & equipment");
  });

  it("🔴 the DATABASE owns the invariants: unique(asset, period); a POSTED schedule row is frozen (UPDATE and DELETE refused) while a planned one is re-plannable; asset_events is append-only; an asset cannot be hard-deleted", async () => {
    // plant two schedule rows on the draft (the FA-B capitalisation will do this through the service; the table's guards are what is under test here)
    const ins = await asApp(`INSERT INTO asset_depreciation_schedule (asset_id, period, sequence, amount, accumulated_after, carrying_after) VALUES ($1, '2026-03', 1, 1875, 1875, 98125), ($1, '2026-04', 2, 1875, 3750, 96250) RETURNING id`, [draftId]);
    expect(ins.ok, JSON.stringify(ins)).toBe(true);
    const [row1, row2] = (ins as unknown as { rows: { id: number }[] }).rows.map((r) => r.id);
    const dup = await asApp(`INSERT INTO asset_depreciation_schedule (asset_id, period, sequence, amount, accumulated_after, carrying_after) VALUES ($1, '2026-03', 3, 1, 1, 1)`, [draftId]);
    expect(dup.ok).toBe(false);
    expect(dup.ok === false && (dup.error.cause?.code ?? (dup.error as { code?: string }).code)).toBe("23505");
    // post row 1 through a real entry (the shape FA-B posts), then it is frozen
    const je = await inTenant(() => postJournalEntry({ entryNumber: `DEP-TEST-${Date.now()}`, date: "2026-03-31", description: "test", lines: [
      { systemCode: "DEPRECIATION_EXPENSE", accountName: "Depreciation expense", debitAmount: 1875, creditAmount: 0 },
      { systemCode: "ACCUMULATED_DEPRECIATION", accountName: "Accumulated depreciation", debitAmount: 0, creditAmount: 1875 },
    ] }));
    const posted = await asApp(`UPDATE asset_depreciation_schedule SET journal_entry_id = $1, posted_at = now() WHERE id = $2 RETURNING id`, [je.id, row1]);
    expect(posted.ok).toBe(true);
    const edit = await asApp(`UPDATE asset_depreciation_schedule SET amount = 1 WHERE id = $1`, [row1]);
    expect(edit.ok).toBe(false);
    expect(edit.ok === false && (edit.error.cause?.constraint ?? edit.error.message)).toMatch(/depreciation_posted_frozen/);
    const del = await asApp(`DELETE FROM asset_depreciation_schedule WHERE id = $1`, [row1]);
    expect(del.ok).toBe(false);
    expect(del.ok === false && (del.error.cause?.constraint ?? del.error.message)).toMatch(/depreciation_posted_frozen/);
    // a planned row may be re-planned and removed (an estimate change regenerates the unposted tail)
    expect((await asApp(`UPDATE asset_depreciation_schedule SET amount = 1900 WHERE id = $1`, [row2])).ok).toBe(true);
    expect((await asApp(`DELETE FROM asset_depreciation_schedule WHERE id = $1`, [row2])).ok).toBe(true);
    // posted_at and journal_entry_id travel together
    const half = await asApp(`INSERT INTO asset_depreciation_schedule (asset_id, period, sequence, amount, accumulated_after, carrying_after, posted_at) VALUES ($1, '2026-05', 3, 1, 1, 1, now())`, [draftId]);
    expect(half.ok).toBe(false);
    // asset_events: append-only — the app role holds neither UPDATE nor DELETE (42501); the owner is bound against UPDATE by the trigger
    const evId = (await pool.query(`SELECT id FROM asset_events WHERE asset_id = $1 ORDER BY id LIMIT 1`, [draftId])).rows[0].id;
    const evUpd = await asApp(`UPDATE asset_events SET kind = 'updated' WHERE id = $1`, [evId]);
    expect(evUpd.ok === false && (evUpd.error.cause?.code ?? (evUpd.error as { code?: string }).code)).toBe("42501");
    const evDel = await asApp(`DELETE FROM asset_events WHERE id = $1`, [evId]);
    expect(evDel.ok === false && (evDel.error.cause?.code ?? (evDel.error as { code?: string }).code)).toBe("42501");
    await expect(pool.query(`UPDATE asset_events SET kind = 'updated' WHERE id = $1`, [evId])).rejects.toThrow(/append-only/);
    // the register is never hard-deleted by the app role
    const hard = await asApp(`DELETE FROM fixed_assets WHERE id = $1`, [draftId]);
    expect(hard.ok).toBe(false);
    expect(hard.ok === false && (hard.error.cause?.code ?? (hard.error as { code?: string }).code)).toBe("42501");
    // the derived figures read the posted row: accumulated 1,875 (row 1), carrying 98,125, one posted period
    const got = await inTenant(() => assetsService.getById(draftId));
    expect([got.accumulatedDepreciation, got.carryingAmount, got.postedPeriods, got.lastPostedPeriod]).toEqual([1875, 98_125, 1, "2026-03"]);
  });

  it("🔴 a capitalised asset's facts of record are frozen by the DB (cost, dates, group, class, provenance, entry) while its descriptive fields may change; a cancelled draft is frozen whole; the service names the refusal first", async () => {
    // put the draft in service by hand (the FA-B act will do this through postJournalEntry; here the state's guard is under test)
    const faAccountId = (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = 'FIXED_ASSETS'`, [orgId])).rows[0].id as number;
    const je = await inTenant(() => postJournalEntry({ entryNumber: `CAP-TEST-${Date.now()}`, date: "2026-03-10", description: "test", lines: [
      { accountId: faAccountId, accountName: "Fixed Assets", debitAmount: 100_000, creditAmount: 0 },
      { systemCode: "SUSPENSE", accountName: "Suspense", debitAmount: 0, creditAmount: 100_000 },
    ] }));
    // in service needs its entry and its date — the CHECK refuses the state without them
    expect((await asApp(`UPDATE fixed_assets SET status = 'in_service' WHERE id = $1`, [draftId])).ok).toBe(false);
    expect((await asApp(`UPDATE fixed_assets SET status = 'in_service', capitalisation_journal_entry_id = $2 WHERE id = $1`, [draftId, je.id])).ok).toBe(true);
    for (const stmt of [
      `UPDATE fixed_assets SET cost = 1 WHERE id = $1`,
      `UPDATE fixed_assets SET acquisition_date = '2026-01-01' WHERE id = $1`,
      `UPDATE fixed_assets SET income_tax_group = 5 WHERE id = $1`,
      `UPDATE fixed_assets SET vat_capital_asset_class = 'immovable' WHERE id = $1`,
      `UPDATE fixed_assets SET vat_input_tax_amount = 0 WHERE id = $1`,
      `UPDATE fixed_assets SET source = 'bill' WHERE id = $1`,
      `UPDATE fixed_assets SET capitalisation_journal_entry_id = NULL, status = 'draft' WHERE id = $1`,
      `UPDATE fixed_assets SET asset_number = 'X' WHERE id = $1`,
    ]) {
      const r = await asApp(stmt, [draftId]);
      expect(r.ok, stmt).toBe(false);
      expect(r.ok === false && (r.error.cause?.constraint ?? r.error.message), stmt).toMatch(/asset_capitalised_facts_frozen|fixed_assets_state_chk/);
    }
    expect((await asApp(`UPDATE fixed_assets SET location = 'HQ', residual_value = 5000 WHERE id = $1`, [draftId])).ok).toBe(true); // descriptive + the estimate (the act that regenerates the tail)
    await expectRefusal(inTenant(() => assetsService.update(draftId, { cost: 1 }, userId)), 409, "asset_capitalised_facts_frozen");
    const named = await inTenant(() => assetsService.update(draftId, { location: "Riyadh HQ", notes: "moved" }, userId));
    expect([named.location, named.notes, named.status]).toEqual(["Riyadh HQ", "moved", "in_service"]);
    await expectRefusal(inTenant(() => assetsService.cancel(draftId, {}, userId)), 409, "asset_not_draft");
    // a draft is CANCELLED, never deleted, then frozen whole; the number stays taken
    const van = (await inTenant(() => assetsService.list())).items.find((a) => a.assetNumber === "FA-00002")!;
    const cancelled = await inTenant(() => assetsService.cancel(van.id, { reason: "entered twice" }, userId));
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.events.map((e) => e.kind)).toEqual(["created", "cancelled"]);
    expect((await asApp(`UPDATE fixed_assets SET name = 'x' WHERE id = $1`, [van.id])).ok).toBe(false);
    await expectRefusal(inTenant(() => assetsService.create({ name: "Dup", assetNumber: "FA-00002", categoryId: catId, acquisitionDate: "2026-04-01", cost: 1 }, userId)), 409, "asset_number_taken");
    expect((await inTenant(() => assetsService.list())).items.map((a) => a.assetNumber)).toEqual(["FA-00001"]); // the cancelled draft leaves the register's list and totals
    expect((await inTenant(() => assetsService.list())).totals).toMatchObject({ drafts: 0, inService: 1, cost: 100_000, accumulatedDepreciation: 1875, carryingAmount: 98_125 });
  });

  it("🔴 the company's income-tax share is pinned to its ownership type (SAUDI_GCC ⇒ 0, FOREIGN ⇒ 100, MIXED ⇒ strictly between); NULL = not declared", async () => {
    await expect(pool.query(`UPDATE companies SET foreign_ownership_pct = 40 WHERE id = $1`, [companyId])).rejects.toThrow(/companies_foreign_ownership_pct_chk/);
    await pool.query(`UPDATE companies SET foreign_ownership_pct = 0 WHERE id = $1`, [companyId]);
    await pool.query(`UPDATE companies SET ownership_type = 'MIXED', foreign_ownership_pct = 40 WHERE id = $1`, [companyId]);
    await expect(pool.query(`UPDATE companies SET foreign_ownership_pct = 100 WHERE id = $1`, [companyId])).rejects.toThrow(/companies_foreign_ownership_pct_chk/);
    await pool.query(`UPDATE companies SET ownership_type = 'FOREIGN', foreign_ownership_pct = 100 WHERE id = $1`, [companyId]);
    await pool.query(`UPDATE companies SET ownership_type = 'SAUDI_GCC', foreign_ownership_pct = NULL WHERE id = $1`, [companyId]);
  });
});
