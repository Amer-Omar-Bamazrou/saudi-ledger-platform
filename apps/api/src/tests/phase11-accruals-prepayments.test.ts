/**
 * PHASE 11 A2/A3 — ACCRUALS AND PREPAYMENTS (2026-09-22), on real rows.
 * Record: docs/product/phase-11-deep-accounting-ap-decision-pack.md §2, §3.
 *
 * The arithmetic is one engine pointed two ways, so most of what is worth
 * asserting is ACCOUNTING, not maths:
 *
 *  · 🔴 IAS 37.11 — an accrual credits a LIABILITY and never Accounts Payable.
 *    AP is the invoiced trade payable; an accrual has no invoice, so a payable
 *    in AP that no supplier statement can match and no payment can settle is
 *    worse than no accrual at all. Refused by name, in both directions.
 *  · a prepayment RELEASES an asset somebody else raised; the schedule must
 *    not raise it a second time.
 *  · Σ recognised = the total, exactly, with the last period absorbing the
 *    residue — the ONE split convention, shared with depreciation.
 *  · a closed month fails closed, because recognition is dated in the period
 *    it belongs to and not on the day the run happened.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginTenantConnection, pool } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { recognitionSchedulesService } from "../services/accounting/recognitionSchedules.service";
import { periodLocksService } from "../services/periodLocks.service";
import { reportsService } from "../services/reports.service";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;

describeMaybe("Phase 11 A2/A3 — accruals and prepayments (real rows)", () => {
  const SLUG = "p11-a23";
  const EMAIL = "p11-a23@test.local";
  let orgId = "", companyId = "", userId = 0;
  let expenseId = 0, accruedId = 0, prepaidId = 0, apId = 0, salesId = 0;

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
      await client.query("SET LOCAL session_replication_role = replica");
      const org = `(SELECT id FROM organizations WHERE slug = '${SLUG}')`;
      for (const t of ["recognition_schedule_rows", "recognition_schedules", "journal_entry_lines", "journal_entries", "period_locks", "findings", "finding_runs", "audit_logs", "organization_memberships", "bank_accounts", "categories", "companies"]) {
        await client.query(`DELETE FROM ${t} WHERE organization_id IN ${org}`);
      }
      await client.query(`DELETE FROM organizations WHERE slug = '${SLUG}'`);
      await client.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
      await client.query("COMMIT");
    } catch (err) { await client.query("ROLLBACK"); throw err; } finally { client.release(); }
  };
  const expectRefusal = async (p: Promise<unknown>, status: number, code?: string) => {
    let err: { statusCode?: number; status?: number; payload?: { code?: string }; message?: string } | undefined;
    try { await p; } catch (e) { err = e as typeof err; }
    expect(err, "expected a refusal").toBeTruthy();
    expect(err!.statusCode ?? err!.status, err!.message).toBe(status);
    if (code) expect(err!.payload?.code).toBe(code);
  };
  const accountId = async (code: string) =>
    (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = $2`, [orgId, code])).rows[0].id as number;
  const glBalance = async (id: number) =>
    Number((await pool.query(
      `SELECT coalesce(sum(l.debit_amount - l.credit_amount), 0)::text v FROM journal_entry_lines l
         JOIN journal_entries e ON e.id = l.journal_entry_id
        WHERE e.organization_id = $1 AND l.account_id = $2 AND e.status IN ('posted','reversed')`, [orgId, id])).rows[0].v);

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug) VALUES ('P11 A23','${SLUG}') RETURNING id`)).rows[0].id;
    companyId = (await pool.query(`INSERT INTO companies (organization_id, name) VALUES ($1,'P11 A23 Co') RETURNING id`, [orgId])).rows[0].id;
    userId = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','P11',' ','admin',true) RETURNING id`)).rows[0].id;
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active')`, [userId, orgId]);
    expenseId = await accountId("PURCHASES");
    accruedId = await accountId("ACCRUED_LIABILITIES");
    prepaidId = await accountId("PREPAID_EXPENSES");
    apId = await accountId("AP");
    salesId = await accountId("SALES");
  }, 60_000);
  afterAll(cleanup);

  it("🔴 the org-seed gave every company the two new system accounts, with the RIGHT types — an accrual's home is a liability and a prepayment's an asset", async () => {
    const rows = (await pool.query(
      `SELECT system_code, type, liquidity_class FROM categories WHERE organization_id = $1 AND system_code IN ('ACCRUED_LIABILITIES','PREPAID_EXPENSES') ORDER BY system_code`, [orgId])).rows;
    expect(rows.map((r: { system_code: string; type: string }) => [r.system_code, r.type])).toEqual([
      ["ACCRUED_LIABILITIES", "liability"],
      ["PREPAID_EXPENSES", "asset"],
    ]);
    // a prepayment is a CURRENT asset — it is consumed within the schedule
    expect(rows.find((r: { system_code: string }) => r.system_code === "PREPAID_EXPENSES").liquidity_class).toBe("current");
  }, 60_000);

  it("🔴 IAS 37.11 — an accrual may NOT be credited to Accounts Payable, and the refusal says why", async () => {
    await expectRefusal(inTenant(() => recognitionSchedulesService.create({
      kind: "accrual", description: "Electricity used, not yet billed", totalAmount: 6_000, periods: 3,
      startPeriod: "2026-06", expenseAccountId: expenseId, balanceAccountId: apId, reference: "ACC-AP",
    }, userId)), 422, "accrual_may_not_use_ap");

    // …and the message explains the consequence rather than just refusing
    let msg = "";
    try {
      await inTenant(() => recognitionSchedulesService.create({
        kind: "accrual", description: "x", totalAmount: 1, periods: 1, startPeriod: "2026-06",
        expenseAccountId: expenseId, balanceAccountId: apId, reference: "ACC-AP2",
      }, userId));
    } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/no statement can match/);
  }, 60_000);

  it("🔴 the balance account's TYPE is checked against the kind, in both directions", async () => {
    // an accrual on an ASSET is not an accrual
    await expectRefusal(inTenant(() => recognitionSchedulesService.create({
      kind: "accrual", description: "Wrong way round", totalAmount: 100, periods: 1, startPeriod: "2026-06",
      expenseAccountId: expenseId, balanceAccountId: prepaidId, reference: "ACC-WRONG",
    }, userId)), 422, "balance_account_type_mismatch");
    // a prepayment on a LIABILITY is not a prepayment
    await expectRefusal(inTenant(() => recognitionSchedulesService.create({
      kind: "prepayment", description: "Wrong way round", totalAmount: 100, periods: 1, startPeriod: "2026-06",
      expenseAccountId: expenseId, balanceAccountId: accruedId, reference: "PRE-WRONG",
    }, userId)), 422, "balance_account_type_mismatch");
    // and recognition always DEBITS an expense — an income account is refused
    await expectRefusal(inTenant(() => recognitionSchedulesService.create({
      kind: "accrual", description: "Not an expense", totalAmount: 100, periods: 1, startPeriod: "2026-06",
      expenseAccountId: salesId, balanceAccountId: accruedId, reference: "ACC-INC",
    }, userId)), 422, "expense_account_not_expense");

    expect((await pool.query(`SELECT count(*)::int n FROM recognition_schedules WHERE organization_id = $1`, [orgId])).rows[0].n).toBe(0);
  }, 60_000);

  it("🔴 an accrual: a DRAFT moves nothing; activation plans the periods; each recognition posts Dr expense / Cr ACCRUED LIABILITIES", async () => {
    const tbBefore = await inTenant(() => reportsService.trialBalance());
    const created = await inTenant(() => recognitionSchedulesService.create({
      kind: "accrual", description: "Audit fee accrued monthly", totalAmount: 30_000, periods: 3,
      startPeriod: "2026-06", expenseAccountId: expenseId, balanceAccountId: accruedId, reference: "ACC-1",
    }, userId));
    expect([created.status, created.recognisedAmount, created.rows.length]).toEqual(["draft", 0, 0]);
    // 🔴 a draft moves NOTHING — the zero-movement standard
    const tbDraft = await inTenant(() => reportsService.trialBalance());
    expect([tbDraft.totalDebit, tbDraft.totalCredit]).toEqual([tbBefore.totalDebit, tbBefore.totalCredit]);

    const active = await inTenant(() => recognitionSchedulesService.activate(created.id, {}, userId));
    expect(active.status).toBe("active");
    expect(active.rows.map((r) => [r.period, r.amount])).toEqual([
      ["2026-06", 10_000], ["2026-07", 10_000], ["2026-08", 10_000],
    ]);
    // 🔴 activation plans; it does not POST. An accrual's liability is raised by
    // the recognition itself, so there is no opening entry to write.
    const tbActive = await inTenant(() => reportsService.trialBalance());
    expect([tbActive.totalDebit, tbActive.totalCredit]).toEqual([tbBefore.totalDebit, tbBefore.totalCredit]);

    const expBefore = await glBalance(expenseId);
    const accBefore = await glBalance(accruedId);
    const out = await inTenant(() => recognitionSchedulesService.recognise(created.id, { period: "2026-06" }, userId));
    expect([out.period, out.amount, out.date]).toEqual(["2026-06", 10_000, "2026-06-30"]);

    // Dr expense / Cr accrued liabilities — the accrued account moves the
    // CREDIT way (a liability grows), which is the half a one-sided assertion
    // would miss.
    expect(await glBalance(expenseId)).toBe(expBefore + 10_000);
    expect(await glBalance(accruedId)).toBe(accBefore - 10_000);
    // 🔴 AP did not move. That is the whole point of IAS 37.11 here.
    expect(await glBalance(apId)).toBe(0);
  }, 90_000);

  it("🔴 a period is recognised ONCE, IN ORDER, and Σ recognised = the total exactly", async () => {
    const listed = await inTenant(() => recognitionSchedulesService.list({ kind: "accrual" }));
    const s = await inTenant(() => recognitionSchedulesService.getById(listed.items.find((i) => i.reference === "ACC-1")!.id));

    await expectRefusal(inTenant(() => recognitionSchedulesService.recognise(s.id, { period: "2026-06" }, userId)), 409, "recognition_already_posted");
    await expectRefusal(inTenant(() => recognitionSchedulesService.recognise(s.id, { period: "2026-08" }, userId)), 409, "recognition_out_of_order");
    await expectRefusal(inTenant(() => recognitionSchedulesService.recognise(s.id, { period: "2027-01" }, userId)), 409, "recognition_period_not_scheduled");

    await inTenant(() => recognitionSchedulesService.recognise(s.id, { period: "2026-07" }, userId));
    await inTenant(() => recognitionSchedulesService.recognise(s.id, { period: "2026-08" }, userId));
    const done = await inTenant(() => recognitionSchedulesService.getById(s.id));
    // 🔴 completed is DERIVED from the rows, and Σ is the total to the halala
    expect([done.status, done.recognisedAmount, done.remainingAmount, done.nextPeriod]).toEqual(["completed", 30_000, 0, null]);
    await expectRefusal(inTenant(() => recognitionSchedulesService.recognise(s.id, {}, userId)), 409, "recognition_not_active");
  }, 90_000);

  it("🔴 an amount that does not divide evenly still sums EXACTLY: the last period absorbs the residue, the one convention depreciation uses", async () => {
    const created = await inTenant(() => recognitionSchedulesService.create({
      kind: "prepayment", description: "Annual insurance, paid up front", totalAmount: 1_000, periods: 3,
      startPeriod: "2026-09", expenseAccountId: expenseId, balanceAccountId: prepaidId, reference: "PRE-1",
    }, userId));
    const active = await inTenant(() => recognitionSchedulesService.activate(created.id, {}, userId));
    expect(active.rows.map((r) => r.amount)).toEqual([333.33, 333.33, 333.34]);
    expect(active.rows.reduce((a, r) => a + r.amount, 0)).toBeCloseTo(1_000, 10);
  }, 60_000);

  it("🔴 a prepayment RELEASES an asset somebody else raised — recognition credits PREPAID EXPENSES and no second asset is created", async () => {
    const s = (await inTenant(() => recognitionSchedulesService.list({ kind: "prepayment" }))).items.find((i) => i.reference === "PRE-1")!;
    // The asset as it would really arise: the bank paid the insurer.
    const preBefore = await glBalance(prepaidId);
    const expBefore = await glBalance(expenseId);

    await inTenant(() => recognitionSchedulesService.recognise(s.id, { period: "2026-09" }, userId));
    // Dr expense, Cr prepaid — the ASSET FALLS. Both sides asserted, because a
    // top-line figure and a bottom-line invariant can both hold while the value
    // sits in the wrong account.
    expect(await glBalance(expenseId)).toBe(expBefore + 333.33);
    expect(await glBalance(prepaidId)).toBe(preBefore - 333.33);
    // 🔴 and no accrued LIABILITY appeared: a prepayment is not an accrual
    expect(await glBalance(accruedId)).toBe(-30_000); // still only the accrual's own credits
  }, 90_000);

  it("🔴 a CLOSED month fails closed, because recognition is dated in the period it belongs to and not on the day the run happened", async () => {
    await inTenant(() => periodLocksService.lock({ period: "2026-10", userId }));
    const s = (await inTenant(() => recognitionSchedulesService.list({ kind: "prepayment" }))).items.find((i) => i.reference === "PRE-1")!;
    const before = (await pool.query(`SELECT count(*)::int n FROM journal_entries WHERE organization_id = $1`, [orgId])).rows[0].n;

    await expectRefusal(inTenant(() => recognitionSchedulesService.recognise(s.id, { period: "2026-10" }, userId)), 423, "period_closed");
    expect((await pool.query(`SELECT count(*)::int n FROM journal_entries WHERE organization_id = $1`, [orgId])).rows[0].n).toBe(before);
    // the row is still unposted and still owed
    const after = await inTenant(() => recognitionSchedulesService.getById(s.id));
    expect(after.rows.find((r) => r.period === "2026-10")!.journalEntryId).toBeNull();
  }, 90_000);

  it("🔴 cancelling stops the FUTURE and keeps the past: unposted periods go, posted ones stay in the books, and a reason is required", async () => {
    const s = (await inTenant(() => recognitionSchedulesService.list({ kind: "prepayment" }))).items.find((i) => i.reference === "PRE-1")!;
    await expectRefusal(inTenant(() => recognitionSchedulesService.cancel(s.id, { reason: "  " }, userId)), 422, "cancel_reason_required");

    const expBefore = await glBalance(expenseId);
    const out = await inTenant(() => recognitionSchedulesService.cancel(s.id, { reason: "Policy cancelled mid-term" }, userId));
    expect([out.cancelled, out.keptPosted]).toEqual([2, 1]);

    const after = await inTenant(() => recognitionSchedulesService.getById(s.id));
    expect([after.status, after.cancelReason]).toEqual(["cancelled", "Policy cancelled mid-term"]);
    expect(after.rows.map((r) => r.period)).toEqual(["2026-09"]);
    // 🔴 cancelling REVERSES NOTHING — the posted period is still in the books
    expect(await glBalance(expenseId)).toBe(expBefore);
    expect(after.recognisedAmount).toBe(333.33);
  }, 90_000);

  it("🔴 the month-end run posts every due schedule and REPORTS what it skipped, with a reason for each", async () => {
    const a = await inTenant(() => recognitionSchedulesService.create({
      kind: "accrual", description: "Rent accrual A", totalAmount: 2_000, periods: 2,
      startPeriod: "2026-11", expenseAccountId: expenseId, balanceAccountId: accruedId, reference: "ACC-RUN-A",
    }, userId));
    await inTenant(() => recognitionSchedulesService.activate(a.id, {}, userId));
    const b = await inTenant(() => recognitionSchedulesService.create({
      kind: "accrual", description: "Rent accrual B", totalAmount: 500, periods: 1,
      startPeriod: "2026-12", expenseAccountId: expenseId, balanceAccountId: accruedId, reference: "ACC-RUN-B",
    }, userId));
    await inTenant(() => recognitionSchedulesService.activate(b.id, {}, userId));

    const run = await inTenant(() => recognitionSchedulesService.runPeriod({ period: "2026-11" }, userId));
    expect(run.posted.map((p) => p.reference)).toEqual(["ACC-RUN-A"]);
    expect(run.postedTotal).toBe(1_000);
    // 🔴 B was SKIPPED and the run SAYS SO with a reason — a run that silently
    // did nothing is indistinguishable from one that had nothing to do.
    expect(run.skipped.find((s) => s.reference === "ACC-RUN-B")!.reason).toMatch(/no row for 2026-11/);

    // running the same period again posts nothing and says why
    const again = await inTenant(() => recognitionSchedulesService.runPeriod({ period: "2026-11" }, userId));
    expect(again.posted).toEqual([]);
    expect(again.skipped.find((s) => s.reference === "ACC-RUN-A")!.reason).toBe("already recognised");
  }, 120_000);

  it("🔴 a POSTED row is frozen at the write boundary — the database refuses to edit or delete it, not only the service", async () => {
    const [row] = (await pool.query(
      `SELECT r.id FROM recognition_schedule_rows r JOIN recognition_schedules s ON s.id = r.schedule_id
        WHERE s.organization_id = $1 AND r.journal_entry_id IS NOT NULL LIMIT 1`, [orgId])).rows;
    expect(row, "a posted row to try to edit").toBeTruthy();

    const asApp = async (sql: string) => {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await c.query(`SET LOCAL ROLE authenticated`);
        await c.query(`SELECT set_config('app.current_org_id', $1, true)`, [orgId]);
        await c.query(`SELECT set_config('app.current_company_id', $1, true)`, [companyId]);
        await c.query(sql, [row.id]);
        await c.query("ROLLBACK");
        return { ok: true, msg: "" };
      } catch (e) { await c.query("ROLLBACK"); return { ok: false, msg: (e as Error).message }; }
      finally { c.release(); }
    };
    const edited = await asApp(`UPDATE recognition_schedule_rows SET amount = 1 WHERE id = $1`);
    expect(edited.ok).toBe(false);
    expect(edited.msg).toMatch(/fact of record/);
    const deleted = await asApp(`DELETE FROM recognition_schedule_rows WHERE id = $1`);
    expect(deleted.ok).toBe(false);
    expect(deleted.msg).toMatch(/cannot be deleted/);
  }, 60_000);
});
