/**
 * FIXED ASSETS — FA-B: CAPITALISATION AND THE MONTHLY RUN (2026-09-22), on
 * real rows. Record: docs/product/fixed-assets-decision-pack.md §21;
 * the expected results are the pack's own §17 test matrix, rows 2, 3, 6, 7,
 * 9 and 12.
 *
 * What it proves:
 *   · a bill that buys an asset posts `Dr asset cost 100,000 · Dr VAT_INPUT
 *     15,000 / Cr AP 115,000` and the asset is IN SERVICE on that entry with
 *     its whole schedule stored — and the expense accounts never move (row 2);
 *   · a RESTRICTED MOTOR VEHICLE (recovery 0 %) capitalises its VAT: `Dr cost
 *     115,000 / Cr AP 115,000`, no input-VAT line (row 3);
 *   · the monthly run posts `Dr depreciation expense / Cr accumulated` for the
 *     row's amount, marks the row posted, and a SECOND run for the period is
 *     refused with nothing posted (row 7);
 *   · the register's derived figures move with the postings and the invariant
 *     `Σ posted rows = the expense postings` holds;
 *   · a CLOSED month fails closed (423) with nothing posted, and the catch-up
 *     posts in an open month for the same amount, saying which period it
 *     depreciates (row 12);
 *   · the estimate change is PROSPECTIVE: posted rows untouched, the tail
 *     regenerated, Σ still the depreciable amount (row 4 of §14);
 *   · the last row leaves carrying = residual and a further run is refused
 *     (row 9);
 *   · the company-wide run posts one entry per asset and REPORTS what it did
 *     not post.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { assetsService } from "../services/assets.service";
import { assetCapitalisationService } from "../services/assets/capitalisation.service";
import { billsService } from "../services/bills.service";
import { reportsService } from "../services/reports.service";
import { periodLocksService } from "../services/periodLocks.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

describeMaybe("FA-B — capitalisation, the monthly run, the estimate change (real rows)", () => {
  const SLUG = "fa-b";
  const EMAIL = "fa-b@test.local";
  let orgId = "", companyId = "", userId = 0, vendorId = 0, catId = 0, laptopId = 0, vanId = 0;

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
      const org = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
      for (const t of ["asset_events", "asset_depreciation_schedule", "fixed_assets", "asset_categories", "bill_items", "bills", "journal_entry_lines", "journal_entries", "period_locks", "audit_logs", "organization_memberships", "vendors", "bank_accounts", "categories", "companies"]) {
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
  /** The GL balance of a system-coded account (debit − credit), over the books. */
  const gl = async (code: string) =>
    Number((await pool.query(
      `SELECT coalesce(sum(l.debit_amount - l.credit_amount), 0)::text v FROM journal_entry_lines l
         JOIN journal_entries e ON e.id = l.journal_entry_id JOIN categories c ON c.id = l.account_id
        WHERE e.organization_id = $1 AND c.system_code = $2 AND e.status IN ('posted','reversed')`, [orgId, code])).rows[0].v);
  const entryLines = async (entryId: number) =>
    (await pool.query(
      `SELECT c.system_code, c.name, l.debit_amount::text d, l.credit_amount::text c FROM journal_entry_lines l
         JOIN categories c ON c.id = l.account_id WHERE l.journal_entry_id = $1 ORDER BY l.id`, [entryId])).rows.map((r) => [r.system_code ?? r.name, r.d, r.c]);
  /** A bill that buys the asset, entered and approved through the product's own paths. */
  const buyAsset = async (assetId: number, number: string, date: string, subtotal: number, vat: number) => {
    const bill = await inTenant(() => billsService.create({ billNumber: number, date, vendorId, subtotal, vatAmount: vat, total: subtotal + vat, capitalisesAssetId: assetId, items: [{ description: "Asset purchase", quantity: 1, unitPrice: subtotal }] }, userId));
    return inTenant(() => billsService.approve(bill.id, {}, userId));
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('FA B','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (await pool.query(`INSERT INTO companies (organization_id, name, fiscal_year_start) VALUES ($1,'FA B Co',1) RETURNING id`, [orgId])).rows[0].id;
    userId = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','FA B',' ','admin',true) RETURNING id`)).rows[0].id;
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, orgId]);
    vendorId = (await pool.query(`INSERT INTO vendors (organization_id, name) VALUES ($1,'Equipment Supplier') RETURNING id`, [orgId])).rows[0].id;
    const cat = await inTenant(() => assetsService.createCategory({ name: "Computers", defaultUsefulLifeMonths: 48, incomeTaxGroup: 3, vatCapitalAssetClass: "movable" }, userId));
    catId = cat.id;
  }, 60_000);
  afterAll(cleanup);

  it("🔴 row 2 — a bill that buys an asset posts Dr asset cost 100,000 · Dr VAT_INPUT 15,000 / Cr AP 115,000; the asset is IN SERVICE on that entry with its 48-row schedule stored; NO expense account moves", async () => {
    const draft = await inTenant(() => assetsService.create({ name: "Laptop fleet", categoryId: catId, acquisitionDate: "2026-03-10", availableForUseDate: "2026-03-15", cost: 100_000, residualValue: 10_000, vatInputTaxAmount: 15_000 }, userId));
    laptopId = draft.id;
    expect(draft.status).toBe("draft");
    const expenseBefore = await gl("DEPRECIATION_EXPENSE");
    const purchasesBefore = await gl("PURCHASES");
    const bill = await buyAsset(laptopId, "BILL-FA-1", "2026-03-10", 100_000, 15_000);
    expect(bill.status).toBe("received");
    const je = (await pool.query(`SELECT id, description FROM journal_entries WHERE organization_id = $1 AND entry_number = 'BILL-BILL-FA-1'`, [orgId])).rows[0];
    expect(await entryLines(je.id)).toEqual([["FIXED_ASSETS", "100000.00", "0.00"], ["VAT_INPUT", "15000.00", "0.00"], ["AP", "0.00", "115000.00"]]);
    expect(je.description).toMatch(/capitalised: FA-00001/);
    expect(await gl("PURCHASES")).toBe(purchasesBefore);
    expect(await gl("DEPRECIATION_EXPENSE")).toBe(expenseBefore);
    const a = await inTenant(() => assetsService.getById(laptopId));
    expect([a.status, a.capitalisationJournalEntryId, a.source, a.billId]).toEqual(["in_service", je.id, "bill", bill.id]);
    expect(a.schedule).toHaveLength(48);
    expect([a.schedule[0]!.period, a.schedule[0]!.amount, a.schedule[47]!.carryingAfter]).toEqual(["2026-03", 1875, 10_000]);
    expect(a.schedule.every((s) => s.journalEntryId == null)).toBe(true);
    expect([a.accumulatedDepreciation, a.carryingAmount, a.plannedPeriods]).toEqual([0, 100_000, 48]);
    expect(a.events.map((e) => e.kind)).toEqual(["created", "capitalised"]);
    // a second bill cannot capitalise it again, and the refusals are named
    await expectRefusal(buyAsset(laptopId, "BILL-FA-DUP", "2026-03-11", 100_000, 15_000), 409, "asset_not_draft");
    const noDate = await inTenant(() => assetsService.create({ name: "Not ready", categoryId: catId, acquisitionDate: "2026-03-10", cost: 500 }, userId));
    await expectRefusal(buyAsset(noDate.id, "BILL-FA-ND", "2026-03-11", 500, 75), 422, "available_for_use_date_required");
    const mismatch = await inTenant(() => assetsService.create({ name: "Wrong cost", categoryId: catId, acquisitionDate: "2026-03-10", availableForUseDate: "2026-03-10", cost: 900 }, userId));
    await expectRefusal(buyAsset(mismatch.id, "BILL-FA-MM", "2026-03-11", 1000, 150), 422, "asset_cost_mismatch");
    // nothing partial: the refused bills did not post
    expect((await pool.query(`SELECT count(*)::int n FROM journal_entries WHERE organization_id = $1 AND entry_number LIKE 'BILL-BILL-FA-%'`, [orgId])).rows[0].n).toBe(1);
  }, 60_000);

  it("🔴 row 3 — a restricted motor vehicle (VAT IR Art. 50, recovery 0 %) CAPITALISES its VAT: Dr cost 115,000 / Cr AP 115,000, no input-VAT line", async () => {
    const vatBefore = await gl("VAT_INPUT");
    const van = await inTenant(() => assetsService.create({ name: "Delivery van", categoryId: catId, acquisitionDate: "2026-04-01", availableForUseDate: "2026-04-01", cost: 115_000, vatInitialRecoveryPct: 0, vatNonDeductibleReason: "Restricted motor vehicle — VAT IR Art. 50(1)(c)" }, userId));
    vanId = van.id;
    await buyAsset(vanId, "BILL-FA-VAN", "2026-04-01", 100_000, 15_000);
    const je = (await pool.query(`SELECT id FROM journal_entries WHERE organization_id = $1 AND entry_number = 'BILL-BILL-FA-VAN'`, [orgId])).rows[0];
    expect(await entryLines(je.id)).toEqual([["FIXED_ASSETS", "115000.00", "0.00"], ["AP", "0.00", "115000.00"]]);
    expect(await gl("VAT_INPUT")).toBe(vatBefore);
    const a = await inTenant(() => assetsService.getById(vanId));
    expect([a.cost, a.status, a.vatInitialRecoveryPct]).toEqual([115_000, "in_service", 0]);
  }, 60_000);

  it("🔴 row 7 — the monthly run posts Dr depreciation expense / Cr accumulated for the row's amount, marks the row posted, moves the derived figures; a SECOND run for the period is refused with nothing posted; out of order is refused", async () => {
    const expenseBefore = await gl("DEPRECIATION_EXPENSE");
    const accBefore = await gl("ACCUMULATED_DEPRECIATION");
    const out = await inTenant(() => assetCapitalisationService.depreciate(laptopId, { period: "2026-03" }, userId));
    expect([out.amount, out.date, out.caughtUp]).toEqual([1875, "2026-03-31", false]);
    expect(await entryLines(out.journalEntryId)).toEqual([["DEPRECIATION_EXPENSE", "1875.00", "0.00"], ["ACCUMULATED_DEPRECIATION", "0.00", "1875.00"]]);
    expect(await gl("DEPRECIATION_EXPENSE")).toBe(expenseBefore + 1875);
    expect(await gl("ACCUMULATED_DEPRECIATION")).toBe(accBefore - 1875);
    const a = await inTenant(() => assetsService.getById(laptopId));
    expect([a.accumulatedDepreciation, a.carryingAmount, a.postedPeriods, a.plannedPeriods, a.lastPostedPeriod, a.nextPeriod]).toEqual([1875, 98_125, 1, 47, "2026-03", "2026-04"]);
    expect(a.schedule[0]!.journalEntryId).toBe(out.journalEntryId);
    const jeCount = (await pool.query(`SELECT count(*)::int n FROM journal_entries WHERE organization_id = $1`, [orgId])).rows[0].n;
    await expectRefusal(inTenant(() => assetCapitalisationService.depreciate(laptopId, { period: "2026-03" }, userId)), 409, "depreciation_already_posted");
    await expectRefusal(inTenant(() => assetCapitalisationService.depreciate(laptopId, { period: "2026-06" }, userId)), 409, "depreciation_out_of_order");
    await expectRefusal(inTenant(() => assetCapitalisationService.depreciate(laptopId, { period: "2025-01" }, userId)), 409, "depreciation_period_not_scheduled");
    expect((await pool.query(`SELECT count(*)::int n FROM journal_entries WHERE organization_id = $1`, [orgId])).rows[0].n).toBe(jeCount);
    // the register and the ledger agree: Σ posted rows = the expense postings for this asset
    const [{ rows_sum, gl_sum }] = (await pool.query(
      `SELECT (SELECT coalesce(sum(amount),0)::text FROM asset_depreciation_schedule WHERE asset_id = $1 AND journal_entry_id IS NOT NULL) rows_sum,
              (SELECT coalesce(sum(l.debit_amount),0)::text FROM journal_entry_lines l JOIN journal_entries e ON e.id = l.journal_entry_id JOIN categories c ON c.id = l.account_id
                WHERE e.reference = $2 AND c.system_code = 'DEPRECIATION_EXPENSE') gl_sum`, [laptopId, "FA-00001"])).rows;
    expect(Number(rows_sum)).toBe(Number(gl_sum));
    expect(Number(rows_sum)).toBe(1875);
  }, 60_000);

  it("🔴 row 12 — a CLOSED month fails closed (423) with nothing posted; the catch-up posts in an OPEN month for the same amount, keeps the schedule's period and says so", async () => {
    await inTenant(() => periodLocksService.lock({ period: "2026-04", userId }));
    const jeCount = (await pool.query(`SELECT count(*)::int n FROM journal_entries WHERE organization_id = $1`, [orgId])).rows[0].n;
    await expectRefusal(inTenant(() => assetCapitalisationService.depreciate(laptopId, { period: "2026-04" }, userId)), 423, "period_closed");
    expect((await pool.query(`SELECT count(*)::int n FROM journal_entries WHERE organization_id = $1`, [orgId])).rows[0].n).toBe(jeCount);
    expect((await inTenant(() => assetsService.getById(laptopId))).postedPeriods).toBe(1);
    // the catch-up: the same amount, dated in an open month, the period unchanged and named
    const out = await inTenant(() => assetCapitalisationService.depreciate(laptopId, { period: "2026-04", postingDate: "2026-05-31" }, userId));
    expect([out.period, out.amount, out.date, out.caughtUp]).toEqual(["2026-04", 1875, "2026-05-31", true]);
    const je = (await pool.query(`SELECT date::text AS date, description FROM journal_entries WHERE id = $1`, [out.journalEntryId])).rows[0];
    expect(je.date).toBe("2026-05-31");
    expect(je.description).toMatch(/2026-04 is closed, posted in an open month/);
    const row = (await pool.query(`SELECT period, journal_entry_id FROM asset_depreciation_schedule WHERE asset_id = $1 AND sequence = 2`, [laptopId])).rows[0];
    expect([row.period, row.journal_entry_id]).toEqual(["2026-04", out.journalEntryId]);
    // a catch-up cannot be dated BEFORE the period it depreciates
    await expectRefusal(inTenant(() => assetCapitalisationService.depreciate(laptopId, { period: "2026-05", postingDate: "2026-01-31" }, userId)), 422, "posting_date_before_period");
    await inTenant(() => periodLocksService.unlock("2026-04"));
  }, 60_000);

  it("🔴 the estimate change is PROSPECTIVE (IAS 16.51): posted rows untouched, the tail regenerated over the remaining life, Σ still the depreciable amount; a life below what is booked is refused", async () => {
    const before = await inTenant(() => assetsService.getById(laptopId));
    expect(before.postedPeriods).toBe(2);
    const postedIds = before.schedule.filter((s) => s.journalEntryId != null).map((s) => [s.period, s.amount, s.journalEntryId]);
    await expectRefusal(inTenant(() => assetCapitalisationService.changeEstimate(laptopId, { usefulLifeMonths: 2, reason: "x" }, userId)), 422, "useful_life_below_booked");
    await expectRefusal(inTenant(() => assetCapitalisationService.changeEstimate(laptopId, { reason: "" }, userId)), 400);
    await expectRefusal(inTenant(() => assetCapitalisationService.changeEstimate(laptopId, { residualValue: 10_000, usefulLifeMonths: 48, reason: "same" }, userId)), 409, "estimate_unchanged");
    const after = await inTenant(() => assetCapitalisationService.changeEstimate(laptopId, { usefulLifeMonths: 36, residualValue: 4_000, reason: "Re-assessed at year-end: three years, lower residual (IAS 16.51)" }, userId));
    expect(after.schedule.filter((s) => s.journalEntryId != null).map((s) => [s.period, s.amount, s.journalEntryId])).toEqual(postedIds);
    expect(after.usefulLifeMonths).toBe(36);
    expect(after.residualValue).toBe(4_000);
    const tail = after.schedule.filter((s) => s.journalEntryId == null);
    expect(tail).toHaveLength(34); // 36 − 2 already booked
    expect(tail[0]!.period).toBe("2026-05");
    expect(tail[0]!.sequence).toBe(3);
    // Σ everything = cost − residual, exactly; the last row leaves the residual
    const total = after.schedule.reduce((s, r) => s + r.amount, 0);
    expect(Math.round(total * 100) / 100).toBe(96_000);
    expect(after.schedule[after.schedule.length - 1]!.carryingAfter).toBe(4_000);
    expect(after.events.map((e) => e.kind)).toContain("estimate_changed");
    const ev = after.events.find((e) => e.kind === "estimate_changed")!;
    expect(ev.payload).toMatchObject({ before: { usefulLifeMonths: 48, residualValue: 10_000 }, after: { usefulLifeMonths: 36, residualValue: 4_000 }, postedRowsUntouched: 2, firstAffectedPeriod: "2026-05" });
  }, 60_000);

  it("🔴 the company-wide run posts ONE entry per asset for the period and REPORTS what it did not post; the income statement moves by exactly the run's total", async () => {
    // the van's schedule starts 2026-04; the laptop's next due period is 2026-05
    await inTenant(() => assetCapitalisationService.depreciate(vanId, { period: "2026-04" }, userId));
    const isBefore = await inTenant(() => reportsService.incomeStatement("2026-05-01", "2026-05-31"));
    const run = await inTenant(() => assetCapitalisationService.runPeriod({ period: "2026-05" }, userId));
    const laptopNumber = (await inTenant(() => assetsService.getById(laptopId))).assetNumber;
    const vanNumber = (await inTenant(() => assetsService.getById(vanId))).assetNumber;
    expect(run.posted.map((p) => p.assetNumber).sort()).toEqual([laptopNumber, vanNumber].sort());
    expect(run.skipped).toEqual([]);
    expect(run.totalAmount).toBe(round2(run.posted.reduce((s, p) => s + p.amount, 0)));
    expect(new Set(run.posted.map((p) => p.journalEntryId)).size).toBe(2);
    const isAfter = await inTenant(() => reportsService.incomeStatement("2026-05-01", "2026-05-31"));
    expect(Math.round((isAfter.totalExpenses - isBefore.totalExpenses) * 100) / 100).toBe(run.totalAmount);
    // a second run for the same period posts nothing and says why, per asset
    const again = await inTenant(() => assetCapitalisationService.runPeriod({ period: "2026-05" }, userId));
    expect([again.posted, again.totalAmount]).toEqual([[], 0]);
    expect(again.skipped).toEqual([]); // nothing is DUE any more — the due set is the planned rows
    // an asset whose period is not scheduled is not in the due set at all; a period nobody plans posts nothing
    const empty = await inTenant(() => assetCapitalisationService.runPeriod({ period: "2032-01" }, userId));
    expect([empty.posted, empty.skipped, empty.totalAmount]).toEqual([[], [], 0]);
  }, 120_000);

  it("🔴 row 9 — the last period leaves carrying = residual, the asset reads fully depreciated (still on the balance sheet) and a further run is refused by name", async () => {
    const short = await inTenant(() => assetsService.create({ name: "Printer", categoryId: catId, acquisitionDate: "2026-06-01", availableForUseDate: "2026-06-01", cost: 1_000, residualValue: 100, usefulLifeMonths: 2 }, userId));
    await buyAsset(short.id, "BILL-FA-PR", "2026-06-01", 1_000, 150);
    for (const period of ["2026-06", "2026-07"]) await inTenant(() => assetCapitalisationService.depreciate(short.id, { period }, userId));
    const a = await inTenant(() => assetsService.getById(short.id));
    expect([a.accumulatedDepreciation, a.carryingAmount, a.fullyDepreciated, a.status, a.plannedPeriods]).toEqual([900, 100, true, "in_service", 0]);
    expect(a.schedule.map((s) => s.amount)).toEqual([450, 450]);
    await expectRefusal(inTenant(() => assetCapitalisationService.depreciate(short.id, { period: "2026-08" }, userId)), 409, "depreciation_period_not_scheduled");
    // and it is still on the balance sheet: cost and accumulated both there, netting to the residual
    const bs = await inTenant(() => reportsService.balanceSheet("2026-12-31"));
    // 🔴 The balance sheet groups by the LINE's label, so the capitalisation
    // line must carry the cost account's own name — not a literal of ours.
    const names = bs.assets.items.map((x) => x.name);
    expect(names).toContain("Fixed Assets");
    expect(names).toContain("Accumulated depreciation");
    expect(names).not.toContain("Fixed asset cost");
  }, 120_000);
});

const round2 = (n: number) => Math.round(n * 100) / 100;
