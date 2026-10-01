/**
 * PHASE 15 — budgets, on real rows (decision pack §5; invariants P1–P11).
 *
 * Every actual here is a journal line the product POSTED (journalEntriesService
 * create + approve); every budget moved through the service and the ONE approval
 * engine. The database-level locks are then attacked DIRECTLY (owner SQL,
 * bypassing the service) — a lock only the service enforces is a convention
 * (§3), and P2 says the database refuses.
 *
 * Fixture (fiscal year = calendar 2026, Gregorian, company A):
 *   Sales (income)      Jan 10,000 · Feb 12,000 · Mar 8,000 · Jul 1,000
 *   Consulting (income) Feb 500 — UNBUDGETED
 *   Rent (expense)      Jan 2,000 · Feb 2,000           — budgeted ANNUAL 24,000
 *   Purchases (expense) Mar 5,000                       — budgeted 0 then 4,000 × 11
 *   Sales budget        9,000 · 11,000 · 10,000 · then 10,000 × 9
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, beginTenantConnection } from "@workspace/db";
import { auditContext } from "../lib/auditContext";
import { budgetsService } from "../services/budgets.service";
import { journalEntriesService } from "../services/journalEntries.service";
import { reportsService } from "../services/reports.service";
import { analyticsService } from "../services/analytics.service";
import { fiscalMonths, resolveFiscalYear } from "../lib/fiscalYear";
import { businessToday } from "@workspace/shared";

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
if (!REAL_DB) console.warn("[phase15-budgets] no real DATABASE_URL — skipping.");

const SLUG = "p15-budgets";
const SLUG_C = "p15-budgets-c";
const EMAIL = "p15-budgets@test.local";

// ── pure: the periods (P11) ─────────────────────────────────────────────────
describe("Phase 15 — fiscal months (pure)", () => {
  it("🔴 P11 — a Hijri fiscal year is twelve Umm al-Qura months: contiguous, 29 or 30 days, covering the year exactly", () => {
    const settings = { fiscalYearStart: 1, calendar: "hijri" as const };
    const months = fiscalMonths(settings, 1447);
    const fy = resolveFiscalYear(settings, 1447);
    expect(months[0]!.startDate).toBe("2025-06-26"); // 1 Muharram 1447 (pinned in fiscal-year.test.ts)
    expect([months[0]!.startDate, months[11]!.endDate]).toEqual([fy.startDate, fy.endDate]);
    const day = (d: string) => Date.parse(`${d}T00:00:00Z`) / 86_400_000;
    for (let i = 0; i < 12; i++) {
      const len = day(months[i]!.endDate) - day(months[i]!.startDate) + 1;
      expect([29, 30], `month ${i + 1}`).toContain(len);
      if (i > 0) expect(day(months[i]!.startDate), `month ${i + 1} starts the day after ${i} ends`).toBe(day(months[i - 1]!.endDate) + 1);
      expect([months[i]!.calendarMonth, months[i]!.calendarYear]).toEqual([i + 1, 1447]);
    }
  });

  it("a Gregorian year starting in April runs April … March, the last month in the next calendar year", () => {
    const months = fiscalMonths({ fiscalYearStart: 4, calendar: "gregorian" }, 2026);
    expect(months.map((m) => m.startDate.slice(0, 7))).toEqual([
      "2026-04", "2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11", "2026-12", "2027-01", "2027-02", "2027-03",
    ]);
    expect([months[10]!.endDate, months[11]!.endDate]).toEqual(["2027-02-28", "2027-03-31"]);
  });
});

describeMaybe("Phase 15 — budgets on real rows", () => {
  let orgId = "", orgC = "", coA = "", coB = "", coC = "", coH = "";
  let userId = 0;
  const ids: Record<string, number> = {};
  let budgetA = 0, v1 = 0, v2 = 0;

  const inCo = async <T,>(org: string, co: string | null, fn: () => Promise<T>): Promise<T> => {
    const conn = await beginTenantConnection({ organizationId: org, ...(co ? { companyId: co } : {}), role: "authenticated" });
    try {
      const out = await conn.run(() => auditContext.run({ userId, organizationId: org, ipAddress: null }, fn));
      await conn.commit();
      return out;
    } catch (err) { await conn.rollback(); throw err; }
  };
  const inA = <T,>(fn: () => Promise<T>) => inCo(orgId, coA, fn);
  const inB = <T,>(fn: () => Promise<T>) => inCo(orgId, coB, fn);
  const inC = <T,>(fn: () => Promise<T>) => inCo(orgC, coC, fn);

  const ORGS = `(SELECT id FROM organizations WHERE slug IN ('${SLUG}','${SLUG_C}'))`;
  const cleanup = async () => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      // approved budget versions are immutable at the database (0112): triggers off; replica mode also skips FK checks
      await c.query("SET LOCAL session_replication_role = replica");
      const { rows } = await c.query(
        `SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
          WHERE c.table_schema = 'public' AND c.column_name = 'organization_id' AND t.table_type = 'BASE TABLE' AND c.table_name <> 'organizations'`);
      for (const { table_name } of rows) await c.query(`DELETE FROM "${table_name}" WHERE organization_id IN ${ORGS}`);
      await c.query(`DELETE FROM organizations WHERE slug IN ('${SLUG}','${SLUG_C}')`);
      await c.query(`DELETE FROM users WHERE email = '${EMAIL}'`);
      await c.query("COMMIT");
    } catch (err) { await c.query("ROLLBACK"); throw err; } finally { c.release(); }
  };

  const catId = async (org: string, code: string) => (await pool.query(`SELECT id FROM categories WHERE organization_id = $1 AND system_code = $2`, [org, code])).rows[0].id as number;
  const newCat = async (org: string, name: string, type: string) =>
    (await pool.query(`INSERT INTO categories (organization_id, name, name_ar, type, vat_applicable) VALUES ($1,$2,$2,$3,false) RETURNING id`, [org, name, type])).rows[0].id as number;
  let seq = 0;
  /** One posted entry: `account` moved on its natural side against the clearing account. */
  const post = async (inX: <T>(fn: () => Promise<T>) => Promise<T>, account: number, side: "debit" | "credit", amount: number, date: string, clearing = ids.clearing!) => {
    const lines = side === "debit"
      ? [{ accountId: account, debitAmount: amount, creditAmount: 0 }, { accountId: clearing, debitAmount: 0, creditAmount: amount }]
      : [{ accountId: clearing, debitAmount: amount, creditAmount: 0 }, { accountId: account, debitAmount: 0, creditAmount: amount }];
    await inX(async () => {
      const e = (await journalEntriesService.create({ entryNumber: `P15-${++seq}`, date, description: `p15 ${seq}`, lines }, userId)) as { id: number };
      await journalEntriesService.approve(e.id, userId);
    });
  };
  /** Owner SQL that MUST be refused by a 0112 trigger; resolves to the constraint name the database raised. */
  const refusedBy = async (sql: string, params: unknown[] = []): Promise<string> => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(sql, params);
      throw new Error(`NOT REFUSED: ${sql}`);
    } catch (err) {
      const e = err as { constraint?: string; code?: string; message: string };
      if (e.message.startsWith("NOT REFUSED")) throw err;
      return e.constraint ?? `${e.code}:${e.message}`;
    } finally {
      await c.query("ROLLBACK").catch(() => {});
      c.release();
    }
  };
  const glState = async () => {
    const lines = Number((await pool.query(`SELECT count(*) FROM journal_entry_lines WHERE organization_id = $1`, [orgId])).rows[0].count);
    const tb = await inA(() => reportsService.trialBalance("2026-01-01", "2026-12-31"));
    return { lines, debit: tb.totalDebit, credit: tb.totalCredit };
  };

  beforeAll(async () => {
    await cleanup();
    orgId = (await pool.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('P15 Org','${SLUG}','approved') RETURNING id`)).rows[0].id;
    coA = (await pool.query(`INSERT INTO companies (organization_id, name, fiscal_year_start, fiscal_calendar) VALUES ($1,'P15 Co A',1,'gregorian') RETURNING id`, [orgId])).rows[0].id;
    await new Promise((r) => setTimeout(r, 20));
    coB = (await pool.query(`INSERT INTO companies (organization_id, name, fiscal_year_start, fiscal_calendar) VALUES ($1,'P15 Co B',1,'gregorian') RETURNING id`, [orgId])).rows[0].id;
    coH = (await pool.query(`INSERT INTO companies (organization_id, name, fiscal_year_start, fiscal_calendar) VALUES ($1,'P15 Co H',1,'hijri') RETURNING id`, [orgId])).rows[0].id;
    orgC = (await pool.query(`INSERT INTO organizations (name, slug, verification_status) VALUES ('P15 Org C','${SLUG_C}','approved') RETURNING id`)).rows[0].id;
    coC = (await pool.query(`INSERT INTO companies (organization_id, name, fiscal_year_start, fiscal_calendar) VALUES ($1,'P15 Co C',1,'gregorian') RETURNING id`, [orgC])).rows[0].id;
    userId = (await pool.query(`INSERT INTO users (email, name, password_hash, role, is_active) VALUES ('${EMAIL}','P15',' ','admin',true) RETURNING id`)).rows[0].id;
    await pool.query(`INSERT INTO organization_memberships (user_id, organization_id, role, status) VALUES ($1,$2,'admin','active'), ($1,$3,'admin','active')`, [userId, orgId, orgC]);

    ids.sales = await catId(orgId, "SALES");
    ids.purchases = await catId(orgId, "PURCHASES");
    ids.consulting = await newCat(orgId, "Consulting", "income");
    ids.rent = await newCat(orgId, "Rent", "expense");
    ids.clearing = await newCat(orgId, "P15 clearing", "asset");
    ids.capital = await newCat(orgId, "P15 capital", "equity");
    ids.salesC = await catId(orgC, "SALES");
    ids.clearingC = await newCat(orgC, "P15 C clearing", "asset");

    await post(inA, ids.sales, "credit", 10000, "2026-01-20");
    await post(inA, ids.sales, "credit", 12000, "2026-02-20");
    await post(inA, ids.sales, "credit", 8000, "2026-03-20");
    await post(inA, ids.sales, "credit", 1000, "2026-07-20");
    await post(inA, ids.consulting, "credit", 500, "2026-02-10");
    await post(inA, ids.rent, "debit", 2000, "2026-01-05");
    await post(inA, ids.rent, "debit", 2000, "2026-02-05");
    await post(inA, ids.purchases, "debit", 5000, "2026-03-15");
    // company B (same org): its own sale — must never reach A's budget
    await post(inB, ids.sales, "credit", 77777, "2026-02-20");
    // org C: another tenant's sale
    await post(inC, ids.salesC, "credit", 4444, "2026-02-20", ids.clearingC);
  }, 240_000);
  afterAll(cleanup);

  // ════════════════════════════════════════════════════════════════════════
  it("🔴 P1 + lifecycle — draft → submit → send back → resubmit → approve; the books never move", async () => {
    const before = await glState();
    expect(before.lines).toBeGreaterThan(0);

    const created = await inA(() => budgetsService.create({ name: "Operating 2026", fiscalYearLabel: 2026 }, userId));
    budgetA = created.id; v1 = created.version!.id;
    expect([created.version!.status, created.version!.versionNo, created.fiscalYear.startDate, created.fiscalYear.endDate]).toEqual(["draft", 1, "2026-01-01", "2026-12-31"]);

    const lines = await inA(() => budgetsService.replaceLines(budgetA, v1, {
      lines: [
        { accountId: ids.sales!, periods: [9000, 11000, 10000, ...Array(9).fill(10000)] },
        { accountId: ids.rent!, annualAmount: 24000 },
        { accountId: ids.purchases!, periods: [0, ...Array(11).fill(4000)] },
      ],
    }));
    expect(lines.lines.map((l) => [l.accountId, l.mode, l.total])).toEqual(expect.arrayContaining([[ids.sales, "periods", 120000], [ids.rent, "annual", 24000], [ids.purchases, "periods", 44000]]));
    expect(lines.lines.find((l) => l.accountId === ids.rent)!.periods, "an annual amount is never divided (P7)").toBeNull();

    await inA(() => budgetsService.submit(budgetA, v1, userId));
    // submitted: the lines are locked — by the service, with the next step named
    await expect(inA(() => budgetsService.replaceLines(budgetA, v1, { lines: [] }))).rejects.toMatchObject({ statusCode: 409, payload: { code: "budget_version_locked" } });
    const back = await inA(() => budgetsService.sendBack(budgetA, v1, "Rent looks low", userId));
    expect([back.version!.status, back.version!.sendBackNote]).toEqual(["draft", "Rent looks low"]);
    await inA(() => budgetsService.submit(budgetA, v1, userId));
    const approved = await inA(() => budgetsService.approve(budgetA, v1, userId));
    expect([approved.version!.status, approved.approvedVersionId, approved.openVersionId]).toEqual(["approved", v1, null]);

    expect(await glState(), "a budget never touches the books (P1)").toEqual(before);
    const acts = (await pool.query(`SELECT action FROM audit_logs WHERE organization_id = $1 AND entity_type = 'budget_version' AND entity_id = $2 ORDER BY created_at`, [orgId, String(v1)])).rows.map((r) => r.action);
    expect(acts).toEqual(["submit", "send_back", "submit", "approve"]);
  });

  it("🔴 P3 — a revision copies the approved lines; approving it supersedes the old version in the same act; one approved, one open, at most", async () => {
    const rev = await inA(() => budgetsService.revise(budgetA, userId));
    v2 = rev.version!.id;
    expect([rev.version!.versionNo, rev.version!.status, rev.version!.basedOnVersionId, rev.lines.length]).toEqual([2, "draft", v1, 3]);
    // a second revision while one is open is refused
    await expect(inA(() => budgetsService.revise(budgetA, userId))).rejects.toMatchObject({ statusCode: 409, payload: { code: "budget_version_open" } });
    await inA(() => budgetsService.replaceLines(budgetA, v2, {
      lines: [
        { accountId: ids.sales!, periods: [9000, 11000, 10000, ...Array(9).fill(10000)] },
        { accountId: ids.rent!, annualAmount: 24000 },
        { accountId: ids.purchases!, periods: [0, ...Array(11).fill(4000)] },
      ],
    }));
    const done = await inA(() => budgetsService.approve(budgetA, v2, userId));
    expect(done.versions.map((v) => [v.versionNo, v.status])).toEqual([[1, "superseded"], [2, "approved"]]);
    const sup = (await pool.query(`SELECT action FROM audit_logs WHERE organization_id = $1 AND entity_type = 'budget_version' AND entity_id = $2 AND action = 'supersede'`, [orgId, String(v1)])).rows;
    expect(sup.length).toBe(1);
    // reject: an open revision is deleted (the engine's rule); the budget keeps its approved version
    const v3 = (await inA(() => budgetsService.revise(budgetA, userId))).version!.id;
    await inA(() => budgetsService.reject(budgetA, v3, userId));
    expect((await inA(() => budgetsService.detail(budgetA))).versions.map((v) => v.status)).toEqual(["superseded", "approved"]);
    // an approved budget is a record: never deleted, never rejected
    await expect(inA(() => budgetsService.remove(budgetA))).rejects.toMatchObject({ statusCode: 409, payload: { code: "budget_ever_approved" } });
    await expect(inA(() => budgetsService.reject(budgetA, v2, userId))).rejects.toMatchObject({ statusCode: 409 });
  });

  it("🔴 P2 — the DATABASE refuses what the service would: an approved version's lines, its status, its deletion; the header's fiscal year; TRUNCATE", async () => {
    expect(await refusedBy(`UPDATE budget_lines SET amount = 1 WHERE version_id = $1`, [v2])).toBe("budget_line_locked");
    expect(await refusedBy(`DELETE FROM budget_lines WHERE version_id = $1`, [v2])).toBe("budget_line_locked");
    expect(await refusedBy(`INSERT INTO budget_lines (organization_id, company_id, version_id, account_id, period_no, amount) VALUES ($1,$2,$3,$4,NULL,1)`, [orgId, coA, v2, ids.consulting])).toBe("budget_line_locked");
    expect(await refusedBy(`UPDATE budget_versions SET status = 'draft' WHERE id = $1`, [v2])).toBe("budget_version_transition");
    expect(await refusedBy(`UPDATE budget_versions SET approved_at = now() - interval '1 day' WHERE id = $1`, [v2])).toBe("budget_version_immutable");
    expect(await refusedBy(`UPDATE budget_versions SET status = 'superseded', superseded_at = now() WHERE id = $1`, [v2]), "superseded only by approving a NEWER open version").toBe("budget_version_transition");
    expect(await refusedBy(`DELETE FROM budget_versions WHERE id = $1`, [v1]), "even a superseded version").toBe("budget_version_immutable");
    expect(await refusedBy(`DELETE FROM budgets WHERE id = $1`, [budgetA]), "not even by cascade").toBe("budget_version_immutable");
    expect(await refusedBy(`UPDATE budgets SET fiscal_year_start = '2027-01-01' WHERE id = $1`, [budgetA])).toBe("budget_header_frozen");
    expect(await refusedBy(`TRUNCATE budget_lines`)).toBe("budget_no_truncate"); // inside a transaction that is rolled back regardless
    // versions are BORN drafts, numbered in order, revised only from the approved version
    expect(await refusedBy(`INSERT INTO budget_versions (organization_id, company_id, budget_id, version_no, status, approved_at) VALUES ($1,$2,$3,3,'approved',now())`, [orgId, coA, budgetA])).toBe("budget_version_born_draft");
    expect(await refusedBy(`INSERT INTO budget_versions (organization_id, company_id, budget_id, version_no) VALUES ($1,$2,$3,9)`, [orgId, coA, budgetA])).toBe("budget_version_sequence");
    expect(await refusedBy(`INSERT INTO budget_versions (organization_id, company_id, budget_id, version_no, based_on_version_id) VALUES ($1,$2,$3,3,$4)`, [orgId, coA, budgetA, v1])).toBe("budget_version_revision_base");
  });

  it("🔴 P10 — a line names an income or expense posting account of THIS organisation; a foreign or missing id is answered alike (no existence oracle); a mode is never mixed", async () => {
    const draft = await inA(() => budgetsService.create({ name: "P10 probe", fiscalYearLabel: 2026, scenario: "worst_case" }, userId));
    const dv = draft.version!.id;
    const ins = (account: number, period: number | null) =>
      refusedBy(`INSERT INTO budget_lines (organization_id, company_id, version_id, account_id, period_no, amount) VALUES ($1,$2,$3,$4,$5,1)`, [orgId, coA, dv, account, period]);
    const balanceSheet = await ins(ids.clearing!, null);
    const foreign = await ins(ids.salesC!, null);
    const missing = await ins(2_000_000_000, null);
    expect([balanceSheet, foreign, missing]).toEqual(["budget_line_account", "budget_line_account", "budget_line_account"]);
    // the same refusal through the service: a 422 naming the ids
    await expect(inA(() => budgetsService.replaceLines(draft.id, dv, { lines: [{ accountId: ids.salesC!, annualAmount: 5 }] })))
      .rejects.toMatchObject({ statusCode: 422, payload: { code: "budget_account_invalid", accountIds: [ids.salesC] } });
    // mixed mode: an annual row beside period rows for the same account
    await inA(() => budgetsService.replaceLines(draft.id, dv, { lines: [{ accountId: ids.sales!, periods: Array(12).fill(1) }] }));
    expect(await ins(ids.sales!, null)).toBe("budget_line_mode");
    // a row in company A that names company B's version is refused as a foreign row
    const b = await inB(() => budgetsService.create({ name: "B budget", fiscalYearLabel: 2026 }, userId));
    expect(await refusedBy(`INSERT INTO budget_lines (organization_id, company_id, version_id, account_id, period_no, amount) VALUES ($1,$2,$3,$4,1,1)`, [orgId, coA, b.version!.id, ids.sales])).toBe("budget_line_tenant");
    expect(await refusedBy(`INSERT INTO budget_versions (organization_id, company_id, budget_id, version_no) VALUES ($1,$2,$3,2)`, [orgId, coA, b.id])).toBe("budget_version_tenant");
  });

  it("🔴 P4…P8 — budget vs actual through period 3: the ledger, signed, judged by type; nothing apportioned; the forecast deterministic; Σ actual = the income statement", async () => {
    const vs = await inA(() => budgetsService.vsActual(budgetA, { through_period: 3 }));
    expect([vs.version.id, vs.version.status, vs.throughPeriod, vs.throughDate, vs.basis]).toEqual([v2, "approved", 3, "2026-03-31", "accrual_gl"]);
    const line = (id: number) => vs.lines.find((l) => l.accountId === id)!;

    const sales = line(ids.sales!);
    expect(sales.periods.slice(0, 3).map((p) => [p.budget, p.actual])).toEqual([[9000, 10000], [11000, 12000], [10000, 8000]]);
    expect(sales.ytd).toEqual({ budget: 30000, actual: 30000, variance: 0, variancePct: 0, favourable: true });
    // P8: actuals 1–3 (30,000) + budget 4–12 (90,000) — July's posted 1,000 is NOT in it (period 7 is still budget)
    expect(sales.forecast).toEqual({ amount: 120000, variance: 0, favourable: true, reason: null });
    expect(sales.fullYear).toEqual({ budget: 120000, actualToDate: 31000, remaining: 89000 });

    // P7: the annual rent has NO period, YTD or forecast budget — never 24,000 ÷ 12
    const rent = line(ids.rent!);
    expect([rent.mode, rent.periods.every((p) => p.budget === null), rent.ytd.budget, rent.ytd.actual, rent.forecast.amount, rent.forecast.reason]).toEqual(["annual", true, null, 4000, null, "annual_only"]);
    expect(rent.fullYear).toEqual({ budget: 24000, actualToDate: 4000, remaining: 20000 });

    // P6: expense under budget is favourable; a zero-budget period has NO percentage
    const purchases = line(ids.purchases!);
    expect(purchases.ytd).toEqual({ budget: 8000, actual: 5000, variance: -3000, variancePct: -37.5, favourable: true });
    expect(purchases.periods[0]).toEqual({ no: 1, budget: 0, actual: 0, variance: 0, variancePct: null });
    expect(purchases.periods[2]).toEqual({ no: 3, budget: 4000, actual: 5000, variance: 1000, variancePct: 25 });

    // D15-09: the unbudgeted account is listed, so nothing that moved is hidden
    expect(vs.unbudgeted.map((u) => [u.accountId, u.mode, u.ytd.actual, u.ytd.budget])).toEqual([[ids.consulting, "unbudgeted", 500, null]]);

    // totals: income fully periodised → a YTD budget; expense holds an annual line → withheld, not partial
    expect(vs.totals.income.ytd).toEqual({ budget: 30000, actual: 30500, variance: 500, variancePct: round(500 / 30000 * 100), favourable: true });
    expect([vs.totals.expense.ytd.budget, vs.totals.expense.ytd.actual, vs.totals.expense.forecast.amount, vs.totals.expense.annualOnlyLines]).toEqual([null, 9000, null, 1]);
    expect([vs.totals.net.ytd.budget, vs.totals.net.ytd.actual]).toEqual([null, 21500]);

    // 🔴 P4: Σ actual (budgeted + unbudgeted) IS the income statement for the same dates — and company B's 77,777 is nowhere
    const is = await inA(() => reportsService.incomeStatement("2026-01-01", "2026-03-31"));
    expect([vs.totals.income.ytd.actual, vs.totals.expense.ytd.actual, vs.totals.net.ytd.actual]).toEqual([is.totalRevenue, is.totalExpenses, is.netIncome]);
    expect(JSON.stringify(vs)).not.toContain("77777");

    // P5: each period's actual = that month's P&L in the trend (the same seam)
    const trend = await inA(() => analyticsService.pnlTrend("2026-01", "2026-03"));
    for (let i = 0; i < 3; i++) {
      const income = vs.lines.concat(vs.unbudgeted).filter((l) => l.accountType === "income").reduce((s, l) => s + l.periods[i]!.actual, 0);
      expect(income, `period ${i + 1}`).toBe(trend.points[i]!.revenue);
    }
  });

  it("🔴 YTD MOVES with the period and defaults to the last COMPLETED one (never a whole month's budget against part of its actual)", async () => {
    const one = await inA(() => budgetsService.vsActual(budgetA, { through_period: 1 }));
    const three = await inA(() => budgetsService.vsActual(budgetA, { through_period: 3 }));
    const s1 = one.lines.find((l) => l.accountId === ids.sales)!.ytd, s3 = three.lines.find((l) => l.accountId === ids.sales)!.ytd;
    expect([s1.budget, s1.actual, s3.budget, s3.actual]).toEqual([9000, 10000, 30000, 30000]);
    const dflt = await inA(() => budgetsService.vsActual(budgetA));
    const completed = fiscalMonths({ fiscalYearStart: 1, calendar: "gregorian" }, 2026).filter((p) => p.endDate < businessToday()).length;
    expect(dflt.throughPeriod).toBe(completed);
    await expect(inA(() => budgetsService.vsActual(budgetA, { through_period: 13 }))).rejects.toMatchObject({ statusCode: 400 });
  });

  it("🔴 P9 — isolation: presence, absence, movement; another company or tenant gets a 404; an org-wide connection reads nothing", async () => {
    const listA = await inA(() => budgetsService.list({}));
    const listB = await inB(() => budgetsService.list({}));
    expect(listA.map((b) => b.id)).toContain(budgetA);
    expect(listB.map((b) => b.id)).not.toContain(budgetA);
    expect(listB.length, "B shows its own budget, so the absence is not vacuous").toBeGreaterThan(0);
    await expect(inB(() => budgetsService.vsActual(budgetA))).rejects.toMatchObject({ statusCode: 404 });
    await expect(inC(() => budgetsService.detail(budgetA))).rejects.toMatchObject({ statusCode: 404 });
    // the query layer refuses an org-wide scope (RLS alone would read both companies)
    expect(await inCo(orgId, null, () => budgetsService.list({}))).toEqual([]);
    await expect(inCo(orgId, null, () => budgetsService.detail(budgetA))).rejects.toMatchObject({ statusCode: 404 });
  });

  it("🔴 D15-15 — an undeclared fiscal year is refused, never defaulted to the calendar year; a Hijri company's budget freezes Hijri periods", async () => {
    await pool.query(`UPDATE companies SET fiscal_year_start = NULL WHERE id = $1`, [coB]);
    try {
      await expect(inB(() => budgetsService.create({ name: "No year", fiscalYearLabel: 2026 }, userId))).rejects.toMatchObject({ statusCode: 422, payload: { code: "fiscal_year_undeclared" } });
    } finally {
      await pool.query(`UPDATE companies SET fiscal_year_start = 1 WHERE id = $1`, [coB]);
    }
    const h = await inCo(orgId, coH, () => budgetsService.create({ name: "Hijri", fiscalYearLabel: 1447 }, userId));
    expect([h.fiscalYear.calendar, h.fiscalYear.label, h.periods[0]!.startDate, h.periods.length]).toEqual(["hijri", 1447, "2025-06-26", 12]);
    // the budget keeps ITS year when the company changes its settings afterwards (D15-01)
    await pool.query(`UPDATE companies SET fiscal_calendar = 'gregorian' WHERE id = $1`, [coH]);
    const again = await inCo(orgId, coH, () => budgetsService.detail(h.id));
    expect([again.fiscalYear.calendar, again.periods[0]!.startDate]).toEqual(["hijri", "2025-06-26"]);
  });

  it("🔴 D15-11 — the M19 import: a legacy row WITH a P&L account becomes a DRAFT annual line; one without stays in the archive; a second run imports nothing", async () => {
    await pool.query(`INSERT INTO budgets_legacy (organization_id, company_id, name, period, category_id, budgeted_amount) VALUES ($1,$2,'Legacy sales','2027',$3,60000), ($1,$2,'Legacy no account','2027',NULL,5000)`, [orgId, coA, ids.sales]);
    const first = (await pool.query(`SELECT * FROM budgets_import_legacy($1)`, [orgId])).rows[0];
    expect([first.imported, first.not_imported]).toEqual([1, 1]);
    const imported = await inA(() => budgetsService.list({ as_of: "2027-06-30" }));
    const b = imported.find((x) => x.name === "Budget 2027 (imported)")!;
    expect(b.versions.map((v) => v.status), "never approved by a migration").toEqual(["draft"]);
    const d = await inA(() => budgetsService.detail(b.id));
    expect(d.lines).toEqual([expect.objectContaining({ accountId: ids.sales, mode: "annual", annualAmount: 60000 })]);
    const second = (await pool.query(`SELECT * FROM budgets_import_legacy($1)`, [orgId])).rows[0];
    expect([second.imported, second.not_imported]).toEqual([0, 1]);
    // the archive is the OWNER's: the application role holds no privilege on it
    const grants = (await pool.query(`SELECT privilege_type FROM information_schema.role_table_grants WHERE table_name = 'budgets_legacy' AND grantee = 'authenticated'`)).rows;
    expect(grants).toEqual([]);
  });

  // ═══ the three reviews (2026-10-01): each test FAILS on the code it was written against ═══

  it("🔴 review M2 — a migration's year-to-date P&L is ONE amount on its date: never spread over the periods it covers, in the YTD only once the period reaches its date — and Σ actual still IS the income statement", async () => {
    const coM = (await pool.query(`INSERT INTO companies (organization_id, name, fiscal_year_start, fiscal_calendar) VALUES ($1,'P15 Co M',1,'gregorian') RETURNING id`, [orgId])).rows[0].id as string;
    const inM = <T,>(fn: () => Promise<T>) => inCo(orgId, coM, fn);
    const bank = (await pool.query(`INSERT INTO bank_accounts (organization_id, company_id, name, bank_name) VALUES ($1,$2,'M Main','SNB') RETURNING id`, [orgId, coM])).rows[0].id as number;
    const { postJournalEntry } = await import("../services/accounting/glPosting");
    await inM(() => postJournalEntry({ entryNumber: "P15-M-OPEN", date: "2026-06-30", description: "Opening position", source: "opening", lines: [
      { bankAccountId: bank, debitAmount: 900, creditAmount: 0 },
      { accountId: ids.sales!, accountName: "Sales", debitAmount: 0, creditAmount: 900 },
    ] }));
    await post(inM, ids.sales!, "credit", 150, "2026-08-10");
    const b = await inM(() => budgetsService.create({ name: "M", fiscalYearLabel: 2026 }, userId));
    await inM(() => budgetsService.replaceLines(b.id, b.version!.id, { lines: [{ accountId: ids.sales!, periods: Array(12).fill(100) }] }));
    for (const [k, ytd] of [[3, 0], [6, 900], [8, 1050]] as const) {
      const vs = await inM(() => budgetsService.vsActual(b.id, { through_period: k }));
      const l = vs.lines[0]!;
      expect([l.ytd.actual, l.migrated], `k=${k}`).toEqual([ytd, { amount: 900, date: "2026-06-30" }]);
      expect(l.periods[5]!.actual, "June is not credited with the half-year").toBe(0);
      const is = await inM(() => reportsService.incomeStatement("2026-01-01", vs.throughDate!));
      expect(vs.totals.income.ytd.actual, `P4 at k=${k}`).toBe(is.totalRevenue);
    }
  });

  it("🔴 review — P4 at the year END, P5 on the EXPENSE side, and the income forecast total (non-null when every income line is by period)", async () => {
    const full = await inA(() => budgetsService.vsActual(budgetA, { through_period: 12 }));
    const is = await inA(() => reportsService.incomeStatement("2026-01-01", "2026-12-31"));
    expect([full.totals.income.ytd.actual, full.totals.expense.ytd.actual, full.totals.net.ytd.actual]).toEqual([is.totalRevenue, is.totalExpenses, is.netIncome]);
    const trend = await inA(() => analyticsService.pnlTrend("2026-01", "2026-12"));
    for (let i = 0; i < 12; i++) {
      const expense = full.lines.concat(full.unbudgeted).filter((l) => l.accountType === "expense").reduce((t, l) => t + l.periods[i]!.actual, 0);
      expect(expense, `expense, period ${i + 1}`).toBe(trend.points[i]!.expenses);
    }
    const three = await inA(() => budgetsService.vsActual(budgetA, { through_period: 3 }));
    // sales: actual 1–3 (30,000) + budget 4–12 (90,000); consulting (unbudgeted): its actual through 3 (500)
    expect(three.totals.income.forecast).toEqual({ amount: 120500, variance: 500, favourable: true, reason: null });
  });

  it("🔴 review L2/L3 — a NEGATIVE planned net keeps its percentage's sign; an amount with a fraction of a halala is refused, never rounded", async () => {
    const b = await inB(() => budgetsService.create({ name: "Loss plan", fiscalYearLabel: 2026, scenario: "best_case" }, userId));
    await inB(() => budgetsService.replaceLines(b.id, b.version!.id, { lines: [
      { accountId: ids.sales!, periods: Array(12).fill(1000) },
      { accountId: ids.purchases!, periods: Array(12).fill(2000) },
    ] }));
    const vs = await inB(() => budgetsService.vsActual(b.id, { through_period: 2 }));
    // planned net −2,000; actual net +77,777 (company B's February sale) → better than planned
    expect(vs.totals.net.ytd).toEqual({ budget: -2000, actual: 77777, variance: 79777, variancePct: 3988.85, favourable: true });
    await expect(inB(() => budgetsService.replaceLines(b.id, b.version!.id, { lines: [{ accountId: ids.sales!, annualAmount: 1.005 }] })))
      .rejects.toMatchObject({ statusCode: 400 });
    const ok = await inB(() => budgetsService.replaceLines(b.id, b.version!.id, { lines: [{ accountId: ids.sales!, annualAmount: 1.01 }] }));
    expect(ok.lines[0]!.annualAmount).toBe(1.01);
  });

  it("🔴 review — the database pins the APPROVAL EVIDENCE, refuses a superseded version left alone at COMMIT, a budget naming another organisation's company, and a malformed fiscal date", async () => {
    // a newer open version exists (v3), so a supersede of v2 is a legal step — but not one that rewrites who approved it
    const v3 = (await inA(() => budgetsService.revise(budgetA, userId))).version!.id;
    try {
      expect(await refusedBy(`UPDATE budget_versions SET status = 'superseded', superseded_at = now(), approved_by = 999999 WHERE id = $1`, [v2])).toBe("budget_version_transition");
      // the step alone, committed without approving v3: refused at COMMIT by the deferred check
      const c = await pool.connect();
      let code = "";
      try {
        await c.query("BEGIN");
        await c.query(`UPDATE budget_versions SET status = 'superseded', superseded_at = now() WHERE id = $1`, [v2]);
        await c.query("COMMIT");
      } catch (e) {
        code = (e as { constraint?: string }).constraint ?? String(e);
        await c.query("ROLLBACK").catch(() => {});
      } finally { c.release(); }
      expect(code).toBe("budget_version_superseded_alone");
      expect((await inA(() => budgetsService.detail(budgetA))).approvedVersionId, "v2 is still the approved version").toBe(v2);
    } finally {
      await inA(() => budgetsService.reject(budgetA, v3, userId));
    }
    expect(await refusedBy(
      `INSERT INTO budgets (organization_id, company_id, name, fiscal_calendar, fiscal_start_month, fiscal_label, fiscal_year_start, fiscal_year_end) VALUES ($1,$2,'foreign company','gregorian',1,2026,'2026-01-01','2026-12-31')`, [orgId, coC],
    )).toBe("budget_header_tenant");
    expect(await refusedBy(
      `INSERT INTO budgets (organization_id, company_id, name, fiscal_calendar, fiscal_start_month, fiscal_label, fiscal_year_start, fiscal_year_end) VALUES ($1,$2,'bad date','gregorian',1,2026,'2026-1-1','2026-12-31')`, [orgId, coA],
    )).toBe("budgets_year_format_chk");
  });

  it("🔴 review — the legacy import is the OWNER's alone (no application role may execute it), and a negative M19 amount stays in the archive", async () => {
    const roles = (await pool.query(`SELECT rolname FROM pg_roles WHERE rolname IN ('authenticated','anon','service_role')`)).rows.map((r) => r.rolname as string);
    expect(roles).toContain("authenticated");
    for (const r of roles) {
      const can = (await pool.query(`SELECT has_function_privilege($1, 'budgets_import_legacy(uuid)', 'EXECUTE') AS can`, [r])).rows[0].can;
      expect(can, r).toBe(false);
    }
    await pool.query(`INSERT INTO budgets_legacy (organization_id, company_id, name, period, category_id, budgeted_amount) VALUES ($1,$2,'Legacy refund plan','2028',$3,-50)`, [orgId, coA, ids.sales]);
    const r = (await pool.query(`SELECT * FROM budgets_import_legacy($1)`, [orgId])).rows[0];
    expect(r.imported).toBe(0);
    expect((await inA(() => budgetsService.list({ as_of: "2028-06-30" }))).length).toBe(0);
  });
});

function round(n: number) {
  return Math.round(n * 100) / 100;
}
