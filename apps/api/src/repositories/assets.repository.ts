/**
 * Fixed assets repository — tenant-scoped via RLS (FA-A, 2026-09-22).
 *
 * The register stores FACTS; accumulated depreciation and the carrying amount
 * are DERIVED here from the POSTED schedule rows (journal_entry_id set) plus
 * a migrated asset's opening position — the same rows that posted the GL, so
 * the register and the ledger cannot disagree by construction.
 */
import { db, fixedAssetsTable, assetCategoriesTable, assetDepreciationScheduleTable, assetEventsTable, assetDisposalsTable, assetTaxPoolDeclarationsTable, assetVatUseRecordsTable, categoriesTable } from "@workspace/db";
import { and, eq, sql, isNull, isNotNull, inArray } from "drizzle-orm";
import { DEFAULT_PAGE } from "../lib/httpParams";
import { INVOICE_NOT_IN_BOOKS } from "./reports.repository";
import { invoiceNotReversedSql } from "./openingReversal";

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

  // ── FA-F: the VAT IR Art. 52 capital-asset adjustment ──

  /**
   * Every asset that HAS a VAT adjustment period, with its disposal if it has
   * one. Drafts and cancelled assets are excluded: an asset never put into
   * service acquired no input tax to adjust.
   */
  async vatCapitalAssets(assetId?: number): Promise<Array<{
    id: number; assetNumber: string; name: string; acquisitionDate: string; usefulLifeMonths: number;
    vatCapitalAssetClass: string; vatInputTaxAmount: number; vatInitialRecoveryPct: number; vatNonDeductibleReason: string | null;
    disposal: { date: string; kind: string; vatTreatment: string; nominalSupplyValue: number | null } | null;
  }>> {
    const rows = await db.execute<{
      id: number; asset_number: string; name: string; acquisition_date: string; useful_life_months: number;
      vat_class: string; vat_input: string; vat_pct: string; vat_reason: string | null;
      d_date: string | null; d_kind: string | null; d_treatment: string | null; d_nominal: string | null;
    }>(sql`
      SELECT a.id, a.asset_number, a.name, a.acquisition_date::text, a.useful_life_months,
             a.vat_capital_asset_class vat_class, a.vat_input_tax_amount::text vat_input,
             a.vat_initial_recovery_pct::text vat_pct, a.vat_non_deductible_reason vat_reason,
             dp.date::text d_date, dp.kind d_kind, dp.vat_treatment d_treatment, dp.nominal_supply_value::text d_nominal
        FROM fixed_assets a
        LEFT JOIN asset_disposals dp ON dp.asset_id = a.id
       WHERE a.status IN ('in_service', 'disposed')
         AND a.vat_capital_asset_class <> 'not_capital'
         ${assetId ? sql`AND a.id = ${assetId}` : sql``}
       ORDER BY a.asset_number`);
    return rows.rows.map((r) => ({
      id: r.id, assetNumber: r.asset_number, name: r.name, acquisitionDate: r.acquisition_date,
      usefulLifeMonths: r.useful_life_months, vatCapitalAssetClass: r.vat_class,
      vatInputTaxAmount: Number(r.vat_input), vatInitialRecoveryPct: Number(r.vat_pct), vatNonDeductibleReason: r.vat_reason,
      disposal: r.d_date ? { date: r.d_date, kind: r.d_kind!, vatTreatment: r.d_treatment!, nominalSupplyValue: r.d_nominal === null ? null : Number(r.d_nominal) } : null,
    }));
  },

  /**
   * VAT IR Art. 51(4)–(5): TAXABLE and EXEMPT supplies per CALENDAR YEAR — the
   * default proportional-deduction fraction.
   *
   * 🔴 Classified per LINE from `tax_category_code`, the same discipline the
   * VAT return uses (a header rate reconstructed from rounded cents drops every
   * mixed-rate document). S and Z are both TAXABLE supplies — zero-rated is
   * taxable at 0 %, not exempt — E is exempt, and O (out of scope) belongs to
   * neither side of the fraction.
   *
   * 🔴 Art. 51(5)(a) excludes "Supplies of Capital Assets by the Taxable
   * Person" from the fraction, and FA-C made that identifiable: a disposal sale
   * is an invoice that NAMES the asset (`invoices.disposes_asset_id`). Without
   * that marker the exclusion could not be applied at all, and a tenant selling
   * a building would see its recovery rate jump for a year.
   *
   * Credit notes reverse (`documentSign`), so the sign is applied here rather
   * than left to the caller.
   */
  async suppliesByCalendarYear(years: number[]): Promise<Array<{ calendarYear: number; taxableSupplies: number; exemptSupplies: number }>> {
    if (years.length === 0) return [];
    const rows = await db.execute<{ y: number; taxable: string; exempt: string }>(sql`
      SELECT left(i.date::text, 4)::int y,
             coalesce(sum(CASE WHEN coalesce(li.tax_category_code, CASE WHEN li.vat_amount > 0 THEN 'S' ELSE 'Z' END) IN ('S','Z')
                               THEN (CASE WHEN i.document_type = 'credit_note' THEN -1 ELSE 1 END) * (li.total - li.vat_amount) ELSE 0 END), 0)::text taxable,
             coalesce(sum(CASE WHEN li.tax_category_code = 'E'
                               THEN (CASE WHEN i.document_type = 'credit_note' THEN -1 ELSE 1 END) * (li.total - li.vat_amount) ELSE 0 END), 0)::text exempt
        FROM invoice_items li
        JOIN invoices i ON i.id = li.invoice_id
       WHERE i.status NOT IN (${sql.join(INVOICE_NOT_IN_BOOKS.map((st) => sql`${st}`), sql`, `)}) AND ${invoiceNotReversedSql("i")}
         AND i.disposes_asset_id IS NULL
         AND left(i.date::text, 4)::int IN (${sql.join(years.map((y) => sql`${y}`), sql`, `)})
       GROUP BY 1`);
    return rows.rows.map((r) => ({ calendarYear: r.y, taxableSupplies: Number(r.taxable), exemptSupplies: Number(r.exempt) }));
  },

  async vatUseRecords(assetIds?: number[]) {
    const rows = await db
      .select()
      .from(assetVatUseRecordsTable)
      .where(assetIds ? inArray(assetVatUseRecordsTable.assetId, assetIds) : undefined)
      .orderBy(assetVatUseRecordsTable.assetId, assetVatUseRecordsTable.periodIndex);
    return rows.map((r) => ({ ...r, actualUsePct: Number(r.actualUsePct) }));
  },
  findVatUseRecord(assetId: number, periodIndex: number) {
    return db
      .select()
      .from(assetVatUseRecordsTable)
      .where(and(eq(assetVatUseRecordsTable.assetId, assetId), eq(assetVatUseRecordsTable.periodIndex, periodIndex)))
      .limit(1);
  },
  insertVatUseRecord(values: typeof assetVatUseRecordsTable.$inferInsert) {
    return db.insert(assetVatUseRecordsTable).values(values).returning();
  },
  updateVatUseRecord(id: number, values: Partial<typeof assetVatUseRecordsTable.$inferInsert>) {
    return db.update(assetVatUseRecordsTable).set(values).where(eq(assetVatUseRecordsTable.id, id)).returning();
  },
  deleteVatUseRecord(id: number) {
    return db.delete(assetVatUseRecordsTable).where(eq(assetVatUseRecordsTable.id, id)).returning();
  },

  // ── FA-G: the reports, and the reconciliation that is their point ──

  /**
   * IAS 16.73(e) roll-forward, per asset CATEGORY, over a window.
   *
   * 🔴 Every figure is an EVENT in the window, never a balance read at the
   * end of it: opening cost is the cost of assets in service BEFORE the window
   * opened, additions are those capitalised INSIDE it, disposals those disposed
   * INSIDE it. A roll-forward assembled from two balance snapshots cannot show
   * an asset that was bought and sold within the window at all, and that is the
   * movement a reader most needs to see.
   */
  async movementByCategory(from: string, to: string) {
    const rows = await db.execute<{
      category_id: number; category_name: string;
      opening_cost: string; additions: string; disposals_cost: string; closing_cost: string;
      opening_accum: string; charge: string; disposals_accum: string; closing_accum: string;
    }>(sql`
      WITH a AS (
        SELECT fa.id, fa.category_id, fa.cost,
               fa.available_for_use_date AS in_service_on,
               dp.date AS disposed_on,
               fa.opening_accumulated_depreciation AS opening_accum
          FROM fixed_assets fa
          LEFT JOIN asset_disposals dp ON dp.asset_id = fa.id
         WHERE fa.status IN ('in_service', 'disposed')
      ),
      posted AS (
        SELECT s.asset_id, s.period, s.amount
          FROM asset_depreciation_schedule s
         WHERE s.journal_entry_id IS NOT NULL
      )
      SELECT c.id category_id, c.name category_name,
             coalesce(sum(a.cost) FILTER (WHERE a.in_service_on < ${from} AND (a.disposed_on IS NULL OR a.disposed_on >= ${from})), 0)::text opening_cost,
             coalesce(sum(a.cost) FILTER (WHERE a.in_service_on BETWEEN ${from} AND ${to}), 0)::text additions,
             coalesce(sum(a.cost) FILTER (WHERE a.disposed_on BETWEEN ${from} AND ${to}), 0)::text disposals_cost,
             coalesce(sum(a.cost) FILTER (WHERE a.in_service_on <= ${to} AND (a.disposed_on IS NULL OR a.disposed_on > ${to})), 0)::text closing_cost,
             (coalesce(sum(a.opening_accum) FILTER (WHERE a.in_service_on < ${from} AND (a.disposed_on IS NULL OR a.disposed_on >= ${from})), 0)
               + coalesce((SELECT sum(p.amount) FROM posted p JOIN a a2 ON a2.id = p.asset_id
                            WHERE a2.category_id = c.id AND p.period < left(${from}, 7)
                              AND (a2.disposed_on IS NULL OR a2.disposed_on >= ${from})), 0))::text opening_accum,
             coalesce((SELECT sum(p.amount) FROM posted p JOIN a a2 ON a2.id = p.asset_id
                        WHERE a2.category_id = c.id AND p.period BETWEEN left(${from}, 7) AND left(${to}, 7)), 0)::text charge,
             (coalesce((SELECT sum(p.amount) FROM posted p JOIN a a2 ON a2.id = p.asset_id
                        WHERE a2.category_id = c.id AND a2.disposed_on BETWEEN ${from} AND ${to}), 0)
               + coalesce(sum(a.opening_accum) FILTER (WHERE a.disposed_on BETWEEN ${from} AND ${to}), 0))::text disposals_accum,
             (coalesce(sum(a.opening_accum) FILTER (WHERE a.in_service_on <= ${to} AND (a.disposed_on IS NULL OR a.disposed_on > ${to})), 0)
               + coalesce((SELECT sum(p.amount) FROM posted p JOIN a a2 ON a2.id = p.asset_id
                            WHERE a2.category_id = c.id AND p.period <= left(${to}, 7)
                              AND (a2.disposed_on IS NULL OR a2.disposed_on > ${to})), 0))::text closing_accum
        FROM asset_categories c
        LEFT JOIN a ON a.category_id = c.id
       GROUP BY c.id, c.name
       ORDER BY c.name`);
    const n = (v: string) => Number(v);
    return rows.rows.map((r) => ({
      categoryId: r.category_id, categoryName: r.category_name,
      openingCost: n(r.opening_cost), additions: n(r.additions), disposalsCost: n(r.disposals_cost), closingCost: n(r.closing_cost),
      openingAccumulated: n(r.opening_accum), charge: n(r.charge), disposalsAccumulated: n(r.disposals_accum), closingAccumulated: n(r.closing_accum),
    }));
  },

  /**
   * The REGISTER side and the GL side of each category's three accounts, for
   * the reconciliation that the pre-FA register had no way to perform.
   *
   * 🔴 The GL side is the WHOLE account balance, not only the lines the
   * register produced. That is deliberate: the categorizer can map a bank
   * transaction straight to a fixed-asset account, and a difference that comes
   * from outside the register is exactly what this report exists to surface.
   * Netting it out would make the control pass while the books disagreed.
   */
  async reconciliationByCategory() {
    const rows = await db.execute<{
      category_id: number; category_name: string;
      cost_account: string; accum_account: string; expense_account: string;
      register_cost: string; register_accum: string; register_charge: string;
      gl_cost: string; gl_accum: string; gl_expense: string;
    }>(sql`
      SELECT c.id category_id, c.name category_name,
             cc.name cost_account, ca.name accum_account, ce.name expense_account,
             coalesce((SELECT sum(fa.cost) FROM fixed_assets fa WHERE fa.category_id = c.id AND fa.status = 'in_service'), 0)::text register_cost,
             (coalesce((SELECT sum(fa.opening_accumulated_depreciation) FROM fixed_assets fa WHERE fa.category_id = c.id AND fa.status = 'in_service'), 0)
              + coalesce((SELECT sum(s.amount) FROM asset_depreciation_schedule s JOIN fixed_assets fa ON fa.id = s.asset_id
                           WHERE fa.category_id = c.id AND fa.status = 'in_service' AND s.journal_entry_id IS NOT NULL), 0))::text register_accum,
             coalesce((SELECT sum(s.amount) FROM asset_depreciation_schedule s JOIN fixed_assets fa ON fa.id = s.asset_id
                        WHERE fa.category_id = c.id AND s.journal_entry_id IS NOT NULL), 0)::text register_charge,
             coalesce((SELECT sum(l.debit_amount - l.credit_amount) FROM journal_entry_lines l JOIN journal_entries e ON e.id = l.journal_entry_id
                        WHERE l.account_id = c.cost_account_id AND e.status IN ('posted', 'reversed')), 0)::text gl_cost,
             coalesce((SELECT sum(l.credit_amount - l.debit_amount) FROM journal_entry_lines l JOIN journal_entries e ON e.id = l.journal_entry_id
                        WHERE l.account_id = c.accumulated_depreciation_account_id AND e.status IN ('posted', 'reversed')), 0)::text gl_accum,
             coalesce((SELECT sum(l.debit_amount - l.credit_amount) FROM journal_entry_lines l JOIN journal_entries e ON e.id = l.journal_entry_id
                        WHERE l.account_id = c.depreciation_expense_account_id AND e.status IN ('posted', 'reversed')), 0)::text gl_expense
        FROM asset_categories c
        JOIN categories cc ON cc.id = c.cost_account_id
        JOIN categories ca ON ca.id = c.accumulated_depreciation_account_id
        JOIN categories ce ON ce.id = c.depreciation_expense_account_id
       ORDER BY c.name`);
    const n = (v: string) => Number(v);
    return rows.rows.map((r) => ({
      categoryId: r.category_id, categoryName: r.category_name,
      costAccount: r.cost_account, accumulatedAccount: r.accum_account, expenseAccount: r.expense_account,
      registerCost: n(r.register_cost), glCost: n(r.gl_cost),
      registerAccumulated: n(r.register_accum), glAccumulated: n(r.gl_accum),
      registerCharge: n(r.register_charge), glExpense: n(r.gl_expense),
    }));
  },

  /** Additions and disposals INSIDE a window, listed — the rows behind the movement figures. */
  async additionsAndDisposals(from: string, to: string) {
    const [adds, disps] = await Promise.all([
      db.execute<{ id: number; n: string; name: string; cat: string; d: string; cost: string; je: number | null }>(sql`
        SELECT fa.id, fa.asset_number n, fa.name, c.name cat, fa.available_for_use_date::text d, fa.cost::text cost, fa.capitalisation_journal_entry_id je
          FROM fixed_assets fa JOIN asset_categories c ON c.id = fa.category_id
         WHERE fa.status IN ('in_service', 'disposed') AND fa.available_for_use_date BETWEEN ${from} AND ${to}
         ORDER BY fa.available_for_use_date, fa.asset_number`),
      db.execute<{ id: number; n: string; name: string; cat: string; d: string; kind: string; proceeds: string; carrying: string; gain: string; je: number | null; inv: number | null }>(sql`
        SELECT fa.id, fa.asset_number n, fa.name, c.name cat, dp.date::text d, dp.kind, dp.proceeds::text proceeds,
               dp.carrying_amount_at_disposal::text carrying, dp.gain_loss::text gain, dp.journal_entry_id je, dp.invoice_id inv
          FROM asset_disposals dp JOIN fixed_assets fa ON fa.id = dp.asset_id JOIN asset_categories c ON c.id = fa.category_id
         WHERE dp.date BETWEEN ${from} AND ${to}
         ORDER BY dp.date, fa.asset_number`),
    ]);
    return {
      additions: adds.rows.map((r) => ({ assetId: r.id, assetNumber: r.n, name: r.name, categoryName: r.cat, date: r.d, cost: Number(r.cost), journalEntryId: r.je })),
      disposals: disps.rows.map((r) => ({ assetId: r.id, assetNumber: r.n, name: r.name, categoryName: r.cat, date: r.d, kind: r.kind, proceeds: Number(r.proceeds), carryingAmount: Number(r.carrying), gainLoss: Number(r.gain), journalEntryId: r.je, invoiceId: r.inv })),
    };
  },

  // ── events ──
  events(assetId: number) {
    return db.select().from(assetEventsTable).where(eq(assetEventsTable.assetId, assetId)).orderBy(assetEventsTable.id);
  },
  insertEvent(values: typeof assetEventsTable.$inferInsert) {
    return db.insert(assetEventsTable).values(values).returning();
  },
};
