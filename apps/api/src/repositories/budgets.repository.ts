/**
 * Budgets repository — Phase 15 (decision pack §5).
 *
 * Every query carries `companyScoped()` (N1): a budget belongs to ONE company,
 * and an org-wide connection reads nothing here — the query layer refuses
 * rather than merging two companies' budgets (RLS's company arm is the second
 * layer). The lifecycle rules live in the DATABASE (migration 0112 triggers);
 * this file only reads and writes rows.
 */
import { db, budgetsTable, budgetVersionsTable, budgetLinesTable, categoriesTable } from "@workspace/db";
import { and, asc, desc, eq, inArray, lte, gte, sql } from "drizzle-orm";
import { companyScoped } from "./companyScope";

export type BudgetRow = typeof budgetsTable.$inferSelect;
export type BudgetVersionRow = typeof budgetVersionsTable.$inferSelect;

export const budgetsRepository = {
  list(opts: { containing?: string; scenario?: string } = {}) {
    const conds = [companyScoped(budgetsTable.companyId)];
    if (opts.containing) conds.push(lte(budgetsTable.fiscalYearStart, opts.containing), gte(budgetsTable.fiscalYearEnd, opts.containing));
    if (opts.scenario) conds.push(eq(budgetsTable.scenario, opts.scenario));
    return db.select().from(budgetsTable).where(and(...conds)).orderBy(desc(budgetsTable.fiscalYearStart), asc(budgetsTable.scenario), asc(budgetsTable.name));
  },

  findBudget(id: number) {
    return db.select().from(budgetsTable).where(and(eq(budgetsTable.id, id), companyScoped(budgetsTable.companyId))).limit(1);
  },

  versionsOf(budgetIds: number[]) {
    if (budgetIds.length === 0) return Promise.resolve([] as BudgetVersionRow[]);
    return db
      .select()
      .from(budgetVersionsTable)
      .where(and(inArray(budgetVersionsTable.budgetId, budgetIds), companyScoped(budgetVersionsTable.companyId)))
      .orderBy(asc(budgetVersionsTable.budgetId), asc(budgetVersionsTable.versionNo));
  },

  findVersion(id: number) {
    return db.select().from(budgetVersionsTable).where(and(eq(budgetVersionsTable.id, id), companyScoped(budgetVersionsTable.companyId))).limit(1);
  },

  /** The version row, locked for the rest of the transaction — line replacement and transitions serialise on it. */
  lockVersion(id: number) {
    return db.select().from(budgetVersionsTable).where(and(eq(budgetVersionsTable.id, id), companyScoped(budgetVersionsTable.companyId))).for("update").limit(1);
  },

  linesOf(versionId: number) {
    return db
      .select({
        accountId: budgetLinesTable.accountId,
        periodNo: budgetLinesTable.periodNo,
        amount: budgetLinesTable.amount,
        accountName: categoriesTable.name,
        accountNameAr: categoriesTable.nameAr,
        accountType: categoriesTable.type,
      })
      .from(budgetLinesTable)
      .innerJoin(categoriesTable, eq(budgetLinesTable.accountId, categoriesTable.id))
      .where(and(eq(budgetLinesTable.versionId, versionId), companyScoped(budgetLinesTable.companyId)))
      .orderBy(asc(categoriesTable.type), asc(categoriesTable.name), asc(budgetLinesTable.periodNo));
  },

  /** Income and expense posting accounts of the tenant — what a line may name (the trigger enforces the same rule). */
  plAccounts() {
    return db
      .select({ id: categoriesTable.id, name: categoriesTable.name, nameAr: categoriesTable.nameAr, type: categoriesTable.type })
      .from(categoriesTable)
      .where(and(inArray(categoriesTable.type, ["income", "revenue", "expense"]), eq(categoriesTable.isPosting, true)))
      .orderBy(asc(categoriesTable.type), asc(categoriesTable.name));
  },

  insertBudget(values: typeof budgetsTable.$inferInsert) {
    return db.insert(budgetsTable).values(values).returning();
  },
  /** Name, Arabic name and notes only — the database refuses any other header change (budgets_guard). */
  updateBudget(id: number, values: { name?: string; nameAr?: string | null; notes?: string | null }) {
    return db.update(budgetsTable).set(values).where(and(eq(budgetsTable.id, id), companyScoped(budgetsTable.companyId))).returning();
  },
  insertVersion(values: typeof budgetVersionsTable.$inferInsert) {
    return db.insert(budgetVersionsTable).values(values).returning();
  },
  nextVersionNo(budgetId: number) {
    return db
      .select({ next: sql<number>`coalesce(max(${budgetVersionsTable.versionNo}), 0) + 1` })
      .from(budgetVersionsTable)
      .where(and(eq(budgetVersionsTable.budgetId, budgetId), companyScoped(budgetVersionsTable.companyId)));
  },
  updateVersion(id: number, values: Partial<typeof budgetVersionsTable.$inferInsert>) {
    return db.update(budgetVersionsTable).set(values).where(and(eq(budgetVersionsTable.id, id), companyScoped(budgetVersionsTable.companyId))).returning();
  },
  deleteVersion(id: number) {
    return db.delete(budgetVersionsTable).where(and(eq(budgetVersionsTable.id, id), companyScoped(budgetVersionsTable.companyId)));
  },
  deleteBudget(id: number) {
    return db.delete(budgetsTable).where(and(eq(budgetsTable.id, id), companyScoped(budgetsTable.companyId)));
  },
  deleteLines(versionId: number) {
    return db.delete(budgetLinesTable).where(and(eq(budgetLinesTable.versionId, versionId), companyScoped(budgetLinesTable.companyId)));
  },
  insertLines(rows: (typeof budgetLinesTable.$inferInsert)[]) {
    if (rows.length === 0) return Promise.resolve([]);
    return db.insert(budgetLinesTable).values(rows).returning({ id: budgetLinesTable.id });
  },
  /** A revision copies the approved version's lines in ONE statement (the trigger admits each row). */
  copyLines(fromVersionId: number, toVersionId: number) {
    return db.execute(sql`
      insert into budget_lines (organization_id, company_id, version_id, account_id, period_no, amount)
      select organization_id, company_id, ${toVersionId}, account_id, period_no, amount
      from budget_lines
      where version_id = ${fromVersionId} and company_id = nullif(current_setting('app.current_company_id', true), '')::uuid`);
  },
};
