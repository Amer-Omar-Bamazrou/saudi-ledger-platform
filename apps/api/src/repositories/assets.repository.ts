/**
 * Fixed assets repository — tenant-scoped via RLS (FA-A, 2026-09-22).
 *
 * The register stores FACTS; accumulated depreciation and the carrying amount
 * are DERIVED here from the POSTED schedule rows (journal_entry_id set) plus
 * a migrated asset's opening position — the same rows that posted the GL, so
 * the register and the ledger cannot disagree by construction.
 */
import { db, fixedAssetsTable, assetCategoriesTable, assetDepreciationScheduleTable, assetEventsTable, assetDisposalsTable, assetTaxPoolDeclarationsTable, categoriesTable } from "@workspace/db";
import { and, eq, sql, isNull, isNotNull, inArray } from "drizzle-orm";
import { DEFAULT_PAGE } from "../lib/httpParams";

export type DerivedFigures = { accumulatedDepreciation: number; carryingAmount: number; postedPeriods: number; plannedPeriods: number; lastPostedPeriod: string | null; nextPeriod: string | null };

const figuresSql = sql<string>`
  (SELECT json_build_object(
      'accumulated', (${fixedAssetsTable}."opening_accumulated_depreciation" + coalesce(sum(s.amount) FILTER (WHERE s.journal_entry_id IS NOT NULL), 0))::text,
      'posted', count(*) FILTER (WHERE s.journal_entry_id IS NOT NULL),
      'planned', count(*) FILTER (WHERE s.journal_entry_id IS NULL),
      'last_posted', max(s.period) FILTER (WHERE s.journal_entry_id IS NOT NULL),
      'next', min(s.period) FILTER (WHERE s.journal_entry_id IS NULL)
    )::text
   FROM asset_depreciation_schedule s WHERE s.asset_id = ${fixedAssetsTable}."id")`;

export function parseFigures(asset: { cost: string; status: string }, raw: string | null): DerivedFigures {
  const j = raw ? (JSON.parse(raw) as { accumulated: string; posted: number; planned: number; last_posted: string | null; next: string | null }) : null;
  const accumulated = Number(j?.accumulated ?? 0);
  const cost = Number(asset.cost);
  return {
    accumulatedDepreciation: accumulated,
    carryingAmount: asset.status === "disposed" ? 0 : Math.round((cost - accumulated) * 100) / 100,
    postedPeriods: Number(j?.posted ?? 0),
    plannedPeriods: Number(j?.planned ?? 0),
    lastPostedPeriod: j?.last_posted ?? null,
    nextPeriod: j?.next ?? null,
  };
}

export const assetsRepository = {
  // ── categories ──
  categories(includeInactive = false) {
    return db
      .select({
        category: assetCategoriesTable,
        costAccountName: sql<string>`(SELECT c.name FROM categories c WHERE c.id = ${assetCategoriesTable}."cost_account_id")`,
        accumulatedAccountName: sql<string>`(SELECT c.name FROM categories c WHERE c.id = ${assetCategoriesTable}."accumulated_depreciation_account_id")`,
        expenseAccountName: sql<string>`(SELECT c.name FROM categories c WHERE c.id = ${assetCategoriesTable}."depreciation_expense_account_id")`,
        assetCount: sql<number>`(SELECT count(*)::int FROM fixed_assets a WHERE a.category_id = ${assetCategoriesTable}."id" AND a.status <> 'cancelled')`,
      })
      .from(assetCategoriesTable)
      .where(includeInactive ? undefined : eq(assetCategoriesTable.isActive, true))
      .orderBy(assetCategoriesTable.name);
  },
  findCategory(id: number) {
    return db.select().from(assetCategoriesTable).where(eq(assetCategoriesTable.id, id)).limit(1);
  },
  insertCategory(values: typeof assetCategoriesTable.$inferInsert) {
    return db.insert(assetCategoriesTable).values(values).returning();
  },
  updateCategory(id: number, values: Partial<typeof assetCategoriesTable.$inferInsert>) {
    return db.update(assetCategoriesTable).set(values).where(eq(assetCategoriesTable.id, id)).returning();
  },
  /** The account rows a category binds, with their types — the service refuses a mistyped triple. */
  accountsByIds(ids: number[]): Promise<{ id: number; name: string; type: string; systemCode: string | null; isPosting: boolean | null }[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return db.select({ id: categoriesTable.id, name: categoriesTable.name, type: categoriesTable.type, systemCode: categoriesTable.systemCode, isPosting: categoriesTable.isPosting }).from(categoriesTable).where(inArray(categoriesTable.id, ids));
  },
  systemAccount(code: string) {
    return db.select({ id: categoriesTable.id, name: categoriesTable.name }).from(categoriesTable).where(eq(categoriesTable.systemCode, code)).limit(1);
  },

  // ── assets ──
  list(page: { limit?: number; offset?: number } = {}, filter: { status?: string; categoryId?: number } = {}) {
    const conditions = [sql`${fixedAssetsTable.status} <> 'cancelled'`];
    if (filter.status) conditions.push(eq(fixedAssetsTable.status, filter.status));
    if (filter.categoryId) conditions.push(eq(fixedAssetsTable.categoryId, filter.categoryId));
    return db
      .select({ asset: fixedAssetsTable, categoryName: assetCategoriesTable.name, figures: figuresSql })
      .from(fixedAssetsTable)
      .leftJoin(assetCategoriesTable, eq(fixedAssetsTable.categoryId, assetCategoriesTable.id))
      .where(and(...conditions))
      .orderBy(fixedAssetsTable.acquisitionDate, fixedAssetsTable.id)
      .limit(page.limit ?? DEFAULT_PAGE)
      .offset(page.offset ?? 0);
  },
  /**
   * 🔴 The register's figures over EVERY asset, never over the page (B-6):
   * cost, accumulated (opening + posted rows) and carrying amount of the
   * assets in the books (in service), plus the counts per state.
   */
  async listTotals(filter: { status?: string; categoryId?: number } = {}) {
    const conditions = [sql`a.status <> 'cancelled'`];
    if (filter.status) conditions.push(sql`a.status = ${filter.status}`);
    if (filter.categoryId) conditions.push(sql`a.category_id = ${filter.categoryId}`);
    const where = sql.join(conditions, sql` AND `);
    const [row] = (await db.execute<{ total: number; drafts: number; in_service: number; disposed: number; cost: string; accumulated: string }>(sql`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE a.status = 'draft')::int AS drafts,
             count(*) FILTER (WHERE a.status = 'in_service')::int AS in_service,
             count(*) FILTER (WHERE a.status = 'disposed')::int AS disposed,
             coalesce(sum(a.cost) FILTER (WHERE a.status = 'in_service'), 0)::text AS cost,
             coalesce(sum(a.opening_accumulated_depreciation + coalesce((SELECT sum(s.amount) FROM asset_depreciation_schedule s WHERE s.asset_id = a.id AND s.journal_entry_id IS NOT NULL), 0)) FILTER (WHERE a.status = 'in_service'), 0)::text AS accumulated
        FROM fixed_assets a WHERE ${where}`)).rows;
    const cost = Number(row?.cost ?? 0);
    const accumulated = Number(row?.accumulated ?? 0);
    return {
      total: Number(row?.total ?? 0),
      drafts: Number(row?.drafts ?? 0),
      inService: Number(row?.in_service ?? 0),
      disposed: Number(row?.disposed ?? 0),
      cost,
      accumulatedDepreciation: accumulated,
      carryingAmount: Math.round((cost - accumulated) * 100) / 100,
    };
  },
  findById(id: number) {
    return db
      .select({ asset: fixedAssetsTable, categoryName: assetCategoriesTable.name, figures: figuresSql })
      .from(fixedAssetsTable)
      .leftJoin(assetCategoriesTable, eq(fixedAssetsTable.categoryId, assetCategoriesTable.id))
      .where(eq(fixedAssetsTable.id, id))
      .limit(1);
  },
  findByNumber(assetNumber: string) {
    return db.select({ id: fixedAssetsTable.id }).from(fixedAssetsTable).where(eq(fixedAssetsTable.assetNumber, assetNumber)).limit(1);
  },
  insert(values: typeof fixedAssetsTable.$inferInsert) {
    return db.insert(fixedAssetsTable).values(values).returning();
  },
  update(id: number, values: Partial<typeof fixedAssetsTable.$inferInsert>) {
    return db.update(fixedAssetsTable).set({ ...values, updatedAt: new Date() }).where(eq(fixedAssetsTable.id, id)).returning();
  },

  // ── schedule ──
  schedule(assetId: number) {
    return db.select().from(assetDepreciationScheduleTable).where(eq(assetDepreciationScheduleTable.assetId, assetId)).orderBy(assetDepreciationScheduleTable.sequence);
  },
  plannedRows(assetId: number) {
    return db.select().from(assetDepreciationScheduleTable).where(and(eq(assetDepreciationScheduleTable.assetId, assetId), isNull(assetDepreciationScheduleTable.journalEntryId))).orderBy(assetDepreciationScheduleTable.sequence);
  },
  postedRows(assetId: number) {
    return db.select().from(assetDepreciationScheduleTable).where(and(eq(assetDepreciationScheduleTable.assetId, assetId), isNotNull(assetDepreciationScheduleTable.journalEntryId))).orderBy(assetDepreciationScheduleTable.sequence);
  },
  insertScheduleRows(rows: (typeof assetDepreciationScheduleTable.$inferInsert)[]) {
    if (rows.length === 0) return Promise.resolve([]);
    return db.insert(assetDepreciationScheduleTable).values(rows).returning();
  },
  /** Only PLANNED rows go (the trigger refuses a posted one anyway). */
  deletePlannedRows(assetId: number) {
    return db.delete(assetDepreciationScheduleTable).where(and(eq(assetDepreciationScheduleTable.assetId, assetId), isNull(assetDepreciationScheduleTable.journalEntryId))).returning({ id: assetDepreciationScheduleTable.id });
  },
  markRowPosted(rowId: number, journalEntryId: number) {
    return db.update(assetDepreciationScheduleTable).set({ journalEntryId, postedAt: new Date() }).where(and(eq(assetDepreciationScheduleTable.id, rowId), isNull(assetDepreciationScheduleTable.journalEntryId))).returning();
  },

  /**
   * FA-B: every asset in service whose schedule PLANS this period — the
   * company-wide run's candidate set. Ordered by number so the run's report
   * reads in the register's own order.
   */
  async assetsDueForPeriod(period: string): Promise<{ id: number; assetNumber: string }[]> {
    const rows = await db.execute<{ id: number; asset_number: string }>(sql`
      SELECT a.id, a.asset_number FROM fixed_assets a
       WHERE a.status = 'in_service'
         AND EXISTS (SELECT 1 FROM asset_depreciation_schedule s WHERE s.asset_id = a.id AND s.period = ${period} AND s.journal_entry_id IS NULL)
       ORDER BY a.asset_number`);
    return rows.rows.map((r) => ({ id: r.id, assetNumber: r.asset_number }));
  },

  /** FA-C: the asset's terminal record (one per asset, by the table's unique). */
  async disposalOf(assetId: number) {
    const [row] = await db.select().from(assetDisposalsTable).where(eq(assetDisposalsTable.assetId, assetId)).limit(1);
    return row ?? null;
  },

  // ── FA-E: the Income Tax Law Art. 17 pool ──

  /**
   * Every fact the pool needs from the register, per Art. 17(b) group, in ONE
   * pass over the whole history — the chain walks many years and a query per
   * year per group would be 5 × N round trips for the same rows.
   *
   * 🔴 The ADDITION date is `available_for_use_date`, because Art. 17(e) says
   * "the cost base of assets IN USE added to the group" and 17(a) allows
   * depreciation only for assets used in generating taxable income. The
   * register stores the purchase date separately, so this is a reading of the
   * text, not the only date available (see `incomeTaxPool.ts`).
   *
   * Drafts and cancelled assets are outside every figure: a draft is not in
   * use, and a cancelled one never was.
   */
  async art17RegisterFacts(): Promise<{
    additions: { group: number; onDate: string; cost: number; assetNumber: string; name: string }[];
    disposals: { group: number; onDate: string; proceeds: number; kind: string; assetNumber: string }[];
    assetsByGroup: { group: number; total: number; disposed: number }[];
  }> {
    const [additions, disposals, counts] = await Promise.all([
      db.execute<{ g: number; d: string; c: string; n: string; nm: string }>(sql`
        SELECT a.income_tax_group g, a.available_for_use_date::text d, a.cost::text c, a.asset_number n, a.name nm
          FROM fixed_assets a
         WHERE a.status IN ('in_service', 'disposed') AND a.available_for_use_date IS NOT NULL
         ORDER BY a.available_for_use_date, a.id`),
      db.execute<{ g: number; d: string; p: string; k: string; n: string }>(sql`
        SELECT a.income_tax_group g, dp.date::text d, dp.proceeds::text p, dp.kind k, a.asset_number n
          FROM asset_disposals dp JOIN fixed_assets a ON a.id = dp.asset_id
         WHERE a.status = 'disposed'
         ORDER BY dp.date, dp.id`),
      db.execute<{ g: number; total: number; disposed: number }>(sql`
        SELECT a.income_tax_group g, count(*)::int total,
               count(*) FILTER (WHERE a.status = 'disposed')::int disposed
          FROM fixed_assets a
         WHERE a.status IN ('in_service', 'disposed')
         GROUP BY a.income_tax_group`),
    ]);
    return {
      additions: additions.rows.map((r) => ({ group: r.g, onDate: r.d, cost: Number(r.c), assetNumber: r.n, name: r.nm })),
      disposals: disposals.rows.map((r) => ({ group: r.g, onDate: r.d, proceeds: Number(r.p), kind: r.k, assetNumber: r.n })),
      assetsByGroup: counts.rows.map((r) => ({ group: r.g, total: r.total, disposed: r.disposed })),
    };
  },

  poolDeclarations() {
    return db.select().from(assetTaxPoolDeclarationsTable).orderBy(assetTaxPoolDeclarationsTable.taxYear, assetTaxPoolDeclarationsTable.incomeTaxGroup);
  },
  findPoolDeclaration(group: number, taxYear: number) {
    return db
      .select()
      .from(assetTaxPoolDeclarationsTable)
      .where(and(eq(assetTaxPoolDeclarationsTable.incomeTaxGroup, group), eq(assetTaxPoolDeclarationsTable.taxYear, taxYear)))
      .limit(1);
  },
  insertPoolDeclaration(values: typeof assetTaxPoolDeclarationsTable.$inferInsert) {
    return db.insert(assetTaxPoolDeclarationsTable).values(values).returning();
  },
  updatePoolDeclaration(id: number, values: Partial<typeof assetTaxPoolDeclarationsTable.$inferInsert>) {
    return db.update(assetTaxPoolDeclarationsTable).set(values).where(eq(assetTaxPoolDeclarationsTable.id, id)).returning();
  },
  deletePoolDeclaration(id: number) {
    return db.delete(assetTaxPoolDeclarationsTable).where(eq(assetTaxPoolDeclarationsTable.id, id)).returning();
  },

  // ── events ──
  events(assetId: number) {
    return db.select().from(assetEventsTable).where(eq(assetEventsTable.assetId, assetId)).orderBy(assetEventsTable.id);
  },
  insertEvent(values: typeof assetEventsTable.$inferInsert) {
    return db.insert(assetEventsTable).values(values).returning();
  },
};
