/** Payroll repository — tenant-scoped via RLS. */
import { db, payrollRunsTable, payrollItemsTable, employeesTable, journalEntriesTable, transactionsTable } from "@workspace/db";
import { and, asc, desc, eq, gte, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { companyScoped } from "./companyScope";

/**
 * What a payable still owes in this company: its books balance (credit − debit, in the books), less the statement
 * lines already waiting in review against it. Each company predicate sits in a FROM with exactly one table carrying
 * company_id, so it binds there however the column renders. One definition for SALARIES_PAYABLE (DR-41) and
 * GOSI_PAYABLE (Phase 18).
 */
const openPayableOf = (code: "SALARIES_PAYABLE" | "GOSI_PAYABLE") => sql`
    (SELECT coalesce(sum((SELECT coalesce(sum(l.credit_amount - l.debit_amount), 0) FROM journal_entry_lines l
                            WHERE l.journal_entry_id = journal_entries.id
                              AND l.account_id IN (SELECT id FROM categories WHERE system_code = ${code}))), 0)
       FROM journal_entries
      WHERE journal_entries.status IN ('posted', 'reversed') AND ${companyScoped(journalEntriesTable.companyId)})
    - (SELECT coalesce(sum(transactions.amount), 0)
       FROM transactions
      WHERE transactions.review_status = 'pending_review'
        AND transactions.category_id IN (SELECT id FROM categories WHERE system_code = ${code})
        AND ${companyScoped(transactionsTable.companyId)})`;

export const payrollRepository = {
  listRuns() {
    return db.select().from(payrollRunsTable).orderBy(desc(payrollRunsTable.period));
  },
  /**
   * 🔴 Per-run headcount and gross, from the ITEM rows.
   *
   * A payroll run stores `total_basic_salary` and `total_allowances` but no
   * gross and no headcount, and the Payroll Report was reading `grossSalary`
   * and `employeeCount` off the run — fields no response contained. It also
   * filtered on `r.month`, which does not exist either, so `undefined >= "2026-01"`
   * was false for every row and **the report rendered empty whatever the tenant
   * had run**.
   *
   * Gross is SUMmed from `payroll_items.gross_salary` rather than added up from
   * the run's two header columns, per §4: when line-level truth exists,
   * header-level arithmetic is a second computation of the same fact and will
   * drift. GOSI is the two employer/employee headers, which ARE the stored
   * fact.
   */
  runItemTotals() {
    return db
      .select({
        payrollRunId: payrollItemsTable.payrollRunId,
        employeeCount: sql<number>`COUNT(*)::int`,
        grossSalary: sql<number>`COALESCE(SUM(${payrollItemsTable.grossSalary}), 0)::float8`,
      })
      .from(payrollItemsTable)
      .groupBy(payrollItemsTable.payrollRunId);
  },
  findRun(id: number) {
    return db.select().from(payrollRunsTable).where(eq(payrollRunsTable.id, id)).limit(1);
  },
  itemsWithEmployee(runId: number) {
    return db
      .select({ item: payrollItemsTable, emp: employeesTable })
      .from(payrollItemsTable)
      .leftJoin(employeesTable, eq(payrollItemsTable.employeeId, employeesTable.id))
      .where(eq(payrollItemsTable.payrollRunId, runId));
  },
  activeEmployees() {
    return db.select().from(employeesTable).where(eq(employeesTable.status, "active"));
  },
  insertRun(values: typeof payrollRunsTable.$inferInsert) {
    return db.insert(payrollRunsTable).values(values).returning();
  },
  insertItems(values: (typeof payrollItemsTable.$inferInsert)[]) {
    return db.insert(payrollItemsTable).values(values);
  },
  updateRun(id: number, values: Partial<typeof payrollRunsTable.$inferInsert>) {
    return db.update(payrollRunsTable).set(values).where(eq(payrollRunsTable.id, id)).returning();
  },
  /** 🔴 G08 residuals (PR A) — applied only while the run is still in `status` (compare-and-set); no row when it was not. */
  updateRunIfStatus(id: number, status: string, values: Partial<typeof payrollRunsTable.$inferInsert>) {
    return db.update(payrollRunsTable).set(values).where(and(eq(payrollRunsTable.id, id), eq(payrollRunsTable.status, status))).returning();
  },
  // Reject (hard-delete) a non-approved run; payroll_items cascade on the FK.
  deleteRun(id: number) {
    return db.delete(payrollRunsTable).where(eq(payrollRunsTable.id, id));
  },
  /** 🔴 G08 residuals (PR A) — `deleteRun`, only while the run is still in `status`; returns the removed id, or nothing. */
  deleteRunIfStatus(id: number, status: string) {
    return db.delete(payrollRunsTable).where(and(eq(payrollRunsTable.id, id), eq(payrollRunsTable.status, status))).returning({ id: payrollRunsTable.id });
  },

  /** 🔴 DR-41 — the run's row lock: two payments of one run are serialised before either decides anything. */
  async lockRun(id: number) {
    await db.execute(sql`SELECT id FROM payroll_runs WHERE id = ${id} FOR UPDATE`);
  },

  /**
   * 🔴 DR-41 (Phase 18, owner decision 2.9) — what a salary bank line could PAY in this company: whether it runs
   * payroll (an approved or paid run), and the net pay its runs still owe — the books' `SALARIES_PAYABLE` balance,
   * less the statement lines already waiting in review against it. Company-scoped (N1), so one company's payroll
   * never changes another's suggestion.
   */
  async salaryPayableContext(): Promise<{ usesPayroll: boolean; openPayable: number }> {
    // Each company predicate sits in a FROM with exactly one table carrying company_id, so it binds there however
    // the column renders (a bare name inside a join of two such tables would be ambiguous).
    const { rows } = await db.execute<{ uses: boolean; open: string }>(sql`
      SELECT
        EXISTS (SELECT 1 FROM payroll_runs WHERE payroll_runs.status IN ('approved', 'paid') AND ${companyScoped(payrollRunsTable.companyId)}) AS uses,
        (${openPayableOf("SALARIES_PAYABLE")})::text AS open`);
    const r = rows[0];
    return { usesPayroll: !!r?.uses, openPayable: Math.round(Number(r?.open ?? 0) * 100) / 100 };
  },

  /**
   * 🔴 GOSI (Phase 18, owner 2026-10-26 night) — the same definition for GOSI_PAYABLE: the books' balance, less the
   * statement lines already waiting in review against it. Read by the GOSI pay path and the categoriser alike.
   */
  async gosiPayableOpen(): Promise<number> {
    const { rows } = await db.execute<{ open: string }>(sql`SELECT (${openPayableOf("GOSI_PAYABLE")})::text AS open`);
    return Math.round(Number(rows[0]?.open ?? 0) * 100) / 100;
  },

  /** 🔴 GOSI (Phase 18): approved or paid runs whose GOSI was not paid through the GOSI pay path, newest first. */
  runsWithUnpaidGosi() {
    return db
      .select()
      .from(payrollRunsTable)
      .where(and(sql`${payrollRunsTable.status} IN ('approved', 'paid')`, sql`${payrollRunsTable.gosiPaidAt} IS NULL`))
      .orderBy(desc(payrollRunsTable.period), desc(payrollRunsTable.id));
  },

  /** 🔴 GO-11 (Phase 18): each run's GOSI (both shares) by the regime its lines were computed under. */
  gosiByRegime(runIds: number[]) {
    if (runIds.length === 0) return Promise.resolve([]);
    return db
      .select({
        payrollRunId: payrollItemsTable.payrollRunId,
        regime: payrollItemsTable.gosiRegime,
        total: sql<string>`COALESCE(SUM(${payrollItemsTable.gosiEmployee} + ${payrollItemsTable.gosiEmployer}), 0)::text`,
      })
      .from(payrollItemsTable)
      .where(inArray(payrollItemsTable.payrollRunId, runIds))
      .groupBy(payrollItemsTable.payrollRunId, payrollItemsTable.gosiRegime);
  },

  /**
   * 🔴 GO-12 (Phase 18, 1421H law): each employee's FIRST line under `regime` in `period`'s calendar year, before
   * `period`, from any run still standing (a rejected run is deleted) — the line that fixed the year's contributory
   * wage. Earliest period first, then the earliest line.
   */
  firstLinesOfYear(employeeIds: number[], period: string, regime: string) {
    if (employeeIds.length === 0) return Promise.resolve([]);
    return db
      .selectDistinctOn([payrollItemsTable.employeeId], {
        employeeId: payrollItemsTable.employeeId,
        period: payrollRunsTable.period,
        wageBase: payrollItemsTable.gosiWageBase,
        inKindHousing: payrollItemsTable.gosiInKindHousing,
        fixedPeriod: payrollItemsTable.gosiWageFixedPeriod,
      })
      .from(payrollItemsTable)
      .innerJoin(payrollRunsTable, eq(payrollRunsTable.id, payrollItemsTable.payrollRunId))
      .where(and(
        inArray(payrollItemsTable.employeeId, employeeIds),
        eq(payrollItemsTable.gosiRegime, regime),
        isNotNull(payrollItemsTable.gosiWageBase),
        gte(payrollRunsTable.period, `${period.slice(0, 4)}-01`),
        lt(payrollRunsTable.period, period),
      ))
      .orderBy(payrollItemsTable.employeeId, asc(payrollRunsTable.period), asc(payrollItemsTable.id));
  },

  /** 🔴 GOSI (Phase 18): lines of a run computed before migration 0127 — no record of the rates and wage they used. */
  async itemsWithoutGosiSnapshot(runId: number): Promise<number> {
    const [r] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(payrollItemsTable)
      .where(and(eq(payrollItemsTable.payrollRunId, runId), sql`${payrollItemsTable.gosiWageBase} IS NULL`));
    return Number(r?.n ?? 0);
  },

  /** 🔴 GOSI (Phase 18): mark a run's GOSI paid ONCE — only while it is approved or paid and not yet marked. */
  markGosiPaidIfUnpaid(id: number, paidAt: string) {
    return db
      .update(payrollRunsTable)
      .set({ gosiPaidAt: paidAt })
      .where(and(eq(payrollRunsTable.id, id), sql`${payrollRunsTable.status} IN ('approved', 'paid')`, sql`${payrollRunsTable.gosiPaidAt} IS NULL`))
      .returning();
  },
};
