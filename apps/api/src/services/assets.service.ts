/**
 * FIXED ASSETS — the register's service (FA-A foundation, 2026-09-22).
 * Decision record: docs/product/fixed-assets-decision-pack.md §3–§6, §8, §13.
 *
 * What lives here: asset CATEGORIES (the account triple + the two Saudi
 * classifications every asset inherits), DRAFT assets (a register row with
 * its facts and nothing posted — the zero-movement standard), the derived
 * figures (accumulated depreciation and carrying amount computed from the
 * POSTED schedule rows), and the schedule PREVIEW of a draft.
 *
 * What does NOT live here (later FA phases): capitalisation (the entry that
 * puts the cost in the books, from a bill, a transaction or by hand), the
 * monthly run, estimate changes, disposal, migration. Every one of those
 * threads through `postJournalEntry` after `checkPeriodOpen` and never a
 * second posting path.
 */
import { BadRequestError, BusinessRuleError, NotFoundError } from "../lib/errors";
import { round2, money2 } from "../lib/money";
import { assertAmount, assertDateString, nullifyEmptyText } from "../lib/writeGuards";
import { auditService } from "./audit.service";
import { assetsRepository, parseFigures, type DerivedFigures } from "../repositories/assets.repository";
import { DEFAULT_PAGE } from "../lib/httpParams";
import { generateStraightLineSchedule, type ScheduleRow } from "./assets/depreciationSchedule";
import { businessToday } from "@workspace/shared";
import type { AssetCategory, FixedAsset, AssetDepreciationScheduleRow, AssetEvent } from "@workspace/db";

const num = (v: unknown) => (v != null ? Number(v) : 0);
const METHODS = ["straight_line", "declining_balance", "units_of_production"] as const;
const VAT_CLASSES = ["movable", "immovable", "not_capital"] as const;

/** Income Tax Law Art. 17(b) — the statutory rate follows from the group; one definition, read by the pool report. */
export const INCOME_TAX_GROUPS: Record<1 | 2 | 3 | 4 | 5, { ratePct: number; label: string; labelAr: string }> = {
  1: { ratePct: 5, label: "Stationary buildings", labelAr: "المباني الثابتة" },
  2: { ratePct: 10, label: "Movable industrial and agricultural buildings", labelAr: "المباني الصناعية والزراعية المتنقلة" },
  3: { ratePct: 25, label: "Factories, machines, engines, hardware and software, equipment, vehicles", labelAr: "المصانع والآلات والمحركات والأجهزة والبرامج والمعدات والمركبات" },
  4: { ratePct: 20, label: "Geological surveying and exploration expenditure", labelAr: "نفقات المسح الجيولوجي والتنقيب" },
  5: { ratePct: 10, label: "All other tangible and intangible depreciable assets", labelAr: "سائر الأصول الملموسة وغير الملموسة القابلة للإهلاك" },
};

/** VAT IR Art. 52(2): the adjustment period — 6 y movable, 10 y immovable, shortened to the accounting life (part years count as one); none for a non-capital asset. */
export function vatAdjustmentPeriodYears(vatClass: string, usefulLifeMonths: number): number | null {
  if (vatClass === "not_capital") return null;
  const statutory = vatClass === "immovable" ? 10 : 6;
  const lifeYears = Math.ceil(usefulLifeMonths / 12);
  return Math.max(1, Math.min(statutory, lifeYears));
}

function assertGroup(v: unknown, field: string): 1 | 2 | 3 | 4 | 5 {
  const n = Number(v);
  if (![1, 2, 3, 4, 5].includes(n)) throw new BadRequestError(`${field} must be an Income Tax Law Art. 17(b) group, 1–5.`);
  return n as 1 | 2 | 3 | 4 | 5;
}
function assertVatClass(v: unknown, field: string): (typeof VAT_CLASSES)[number] {
  if (!VAT_CLASSES.includes(v as never)) throw new BadRequestError(`${field} must be movable, immovable or not_capital (VAT IR Art. 52(2)).`);
  return v as (typeof VAT_CLASSES)[number];
}
function assertMethod(v: unknown, field: string): (typeof METHODS)[number] {
  if (!METHODS.includes(v as never)) throw new BadRequestError(`${field} must be straight_line, declining_balance or units_of_production.`);
  return v as (typeof METHODS)[number];
}
function assertMonths(v: unknown, field: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 1200) throw new BadRequestError(`${field} must be a whole number of months between 1 and 1200.`);
  return n;
}
function assertPct(v: unknown, field: string, opts: { max: number; maxInclusive?: boolean } = { max: 100, maxInclusive: true }): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || (opts.maxInclusive ? n > opts.max : n >= opts.max)) throw new BadRequestError(`${field} must be a percentage between 0 and ${opts.max}${opts.maxInclusive ? "" : " (exclusive)"}.`);
  return round2(n);
}

const toCategoryView = (r: { category: AssetCategory; costAccountName: string; accumulatedAccountName: string; expenseAccountName: string; assetCount: number }) => ({
  ...r.category,
  defaultResidualPct: num(r.category.defaultResidualPct),
  incomeTaxRatePct: INCOME_TAX_GROUPS[r.category.incomeTaxGroup as 1 | 2 | 3 | 4 | 5].ratePct,
  costAccountName: r.costAccountName,
  accumulatedDepreciationAccountName: r.accumulatedAccountName,
  depreciationExpenseAccountName: r.expenseAccountName,
  assetCount: Number(r.assetCount ?? 0),
  createdAt: r.category.createdAt.toISOString(),
});

const toScheduleView = (s: AssetDepreciationScheduleRow) => ({
  id: s.id, assetId: s.assetId, period: s.period, sequence: s.sequence,
  amount: num(s.amount), accumulatedAfter: num(s.accumulatedAfter), carryingAfter: num(s.carryingAfter),
  journalEntryId: s.journalEntryId ?? null, postedAt: s.postedAt ? s.postedAt.toISOString() : null,
});
const toEventView = (e: AssetEvent) => ({
  id: e.id, assetId: e.assetId, kind: e.kind, occurredOn: e.occurredOn, payload: (e.payload ?? {}) as Record<string, unknown>,
  journalEntryId: e.journalEntryId ?? null, documentRef: e.documentRef ?? null, userId: e.userId ?? null, createdAt: e.createdAt.toISOString(),
});

export function toAssetView(a: FixedAsset, categoryName: string | null, figures: DerivedFigures) {
  const cost = num(a.cost);
  const residual = num(a.residualValue);
  const fullyDepreciated = a.status === "in_service" && Math.abs(figures.accumulatedDepreciation - round2(cost - residual)) < 0.005 && cost > residual;
  return {
    id: a.id,
    assetNumber: a.assetNumber, name: a.name, nameAr: a.nameAr ?? null, description: a.description ?? null, serialNumber: a.serialNumber ?? null,
    categoryId: a.categoryId, categoryName: categoryName ?? null, location: a.location ?? null, department: a.department ?? null, custodianUserId: a.custodianUserId ?? null,
    acquisitionDate: a.acquisitionDate, availableForUseDate: a.availableForUseDate ?? null, disposalDate: a.disposalDate ?? null,
    cost, residualValue: residual, usefulLifeMonths: a.usefulLifeMonths, depreciationMethod: a.depreciationMethod,
    openingAccumulatedDepreciation: num(a.openingAccumulatedDepreciation), openingPeriodsBooked: a.openingPeriodsBooked,
    vatInputTaxAmount: num(a.vatInputTaxAmount), vatInitialRecoveryPct: num(a.vatInitialRecoveryPct), vatCapitalAssetClass: a.vatCapitalAssetClass,
    vatAdjustmentPeriodYears: vatAdjustmentPeriodYears(a.vatCapitalAssetClass, a.usefulLifeMonths), vatNonDeductibleReason: a.vatNonDeductibleReason ?? null,
    incomeTaxGroup: a.incomeTaxGroup, incomeTaxRatePct: INCOME_TAX_GROUPS[a.incomeTaxGroup as 1 | 2 | 3 | 4 | 5].ratePct,
    source: a.source, billId: a.billId ?? null, transactionId: a.transactionId ?? null, migrationBatchId: a.migrationBatchId ?? null, sourceReference: a.sourceReference ?? null,
    status: a.status, fullyDepreciated, capitalisationJournalEntryId: a.capitalisationJournalEntryId ?? null, notes: a.notes ?? null,
    // DERIVED, never stored (pack §13): from the posted schedule rows and the opening position
    accumulatedDepreciation: figures.accumulatedDepreciation,
    carryingAmount: figures.carryingAmount,
    depreciableAmount: round2(cost - residual),
    postedPeriods: figures.postedPeriods, plannedPeriods: figures.plannedPeriods, lastPostedPeriod: figures.lastPostedPeriod, nextPeriod: figures.nextPeriod,
    createdAt: a.createdAt.toISOString(), updatedAt: a.updatedAt.toISOString(),
  };
}

export type AssetView = ReturnType<typeof toAssetView>;

async function loadAsset(id: number) {
  const [row] = await assetsRepository.findById(id);
  if (!row) throw new NotFoundError("Asset not found");
  return { asset: row.asset, categoryName: row.categoryName ?? null, figures: parseFigures(row.asset, row.figures) };
}

/** Insert the register's audit spine row beside `audit_logs`. */
export async function recordAssetEvent(assetId: number, kind: AssetEvent["kind"], occurredOn: string, payload: Record<string, unknown>, opts: { journalEntryId?: number | null; documentRef?: string | null; userId?: number | null } = {}) {
  const [ev] = await assetsRepository.insertEvent({ assetId, kind, occurredOn, payload, journalEntryId: opts.journalEntryId ?? null, documentRef: opts.documentRef ?? null, userId: opts.userId ?? null });
  return ev!;
}

/** The planned schedule of an asset from its facts — the preview for a draft; the rows a capitalisation stores. */
export function plannedScheduleOf(a: Pick<FixedAsset, "cost" | "residualValue" | "usefulLifeMonths" | "depreciationMethod" | "availableForUseDate" | "openingAccumulatedDepreciation" | "openingPeriodsBooked">, openingDate?: string | null): ScheduleRow[] | null {
  if (!a.availableForUseDate) return null;
  return generateStraightLineSchedule({
    cost: num(a.cost), residualValue: num(a.residualValue), usefulLifeMonths: a.usefulLifeMonths, depreciationMethod: a.depreciationMethod,
    availableForUseDate: a.availableForUseDate, openingAccumulated: num(a.openingAccumulatedDepreciation), openingPeriodsBooked: a.openingPeriodsBooked, openingDate: openingDate ?? null,
  });
}

export const assetsService = {
  // ── categories ──────────────────────────────────────────────────────────
  async listCategories(includeInactive = false) {
    const rows = await assetsRepository.categories(includeInactive);
    return { items: rows.map(toCategoryView), incomeTaxGroups: Object.entries(INCOME_TAX_GROUPS).map(([g, v]) => ({ group: Number(g), ...v })) };
  },

  async createCategory(body: Record<string, unknown>, userId: number | null) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) throw new BadRequestError("name is required.");
    const incomeTaxGroup = assertGroup(body.incomeTaxGroup, "incomeTaxGroup");
    const vatClass = assertVatClass(body.vatCapitalAssetClass, "vatCapitalAssetClass");
    const life = assertMonths(body.defaultUsefulLifeMonths, "defaultUsefulLifeMonths");
    const method = body.defaultMethod == null ? "straight_line" : assertMethod(body.defaultMethod, "defaultMethod");
    const residualPct = body.defaultResidualPct == null ? 0 : assertPct(body.defaultResidualPct, "defaultResidualPct", { max: 100, maxInclusive: false });
    // the account triple: explicit, or the defaults — the M15 FIXED_ASSETS cost account and the two FA-A system accounts
    const resolve = async (given: unknown, code: string, wantType: string, field: string) => {
      if (given != null && given !== "") {
        const id = Number(given);
        if (!Number.isInteger(id) || id <= 0) throw new BadRequestError(`${field} must be an account id.`);
        const [acct] = await assetsRepository.accountsByIds([id]);
        if (!acct) throw new BadRequestError(`${field}: account ${id} does not exist in this company.`);
        if (acct.type !== wantType) throw new BusinessRuleError(422, { code: "asset_category_account_type", error: `${field} must be a ${wantType} account; ${acct.name} is ${acct.type}.`, field });
        if (acct.isPosting === false) throw new BusinessRuleError(422, { code: "asset_category_account_header", error: `${field}: ${acct.name} is a non-posting header.`, field });
        return acct.id;
      }
      const [sys] = await assetsRepository.systemAccount(code);
      if (!sys) throw new BusinessRuleError(422, { code: "asset_category_account_required", error: `${field} is required: this company has no ${code} account to default to.`, field });
      return sys.id;
    };
    const costAccountId = await resolve(body.costAccountId, "FIXED_ASSETS", "asset", "costAccountId");
    const accumulatedDepreciationAccountId = await resolve(body.accumulatedDepreciationAccountId, "ACCUMULATED_DEPRECIATION", "asset", "accumulatedDepreciationAccountId");
    const depreciationExpenseAccountId = await resolve(body.depreciationExpenseAccountId, "DEPRECIATION_EXPENSE", "expense", "depreciationExpenseAccountId");
    if (costAccountId === accumulatedDepreciationAccountId) throw new BusinessRuleError(422, { code: "asset_category_accounts_distinct", error: "The cost account and the accumulated-depreciation account must differ (one is the contra of the other).", field: "accumulatedDepreciationAccountId" });
    const [row] = await assetsRepository.insertCategory({
      name, nameAr: typeof body.nameAr === "string" && body.nameAr.trim() ? body.nameAr.trim() : null,
      costAccountId, accumulatedDepreciationAccountId, depreciationExpenseAccountId,
      defaultUsefulLifeMonths: life, defaultMethod: method, defaultResidualPct: money2(residualPct),
      incomeTaxGroup, vatCapitalAssetClass: vatClass, isActive: true,
    });
    await auditService.created("asset_category", row!.id, { ...row, by: userId });
    const [full] = await assetsRepository.categories(true).then((rows) => rows.filter((r) => r.category.id === row!.id));
    return toCategoryView(full!);
  },

  async updateCategory(id: number, body: Record<string, unknown>, userId: number | null) {
    const [before] = await assetsRepository.findCategory(id);
    if (!before) throw new NotFoundError("Asset category not found");
    const patch: Partial<AssetCategory> = {};
    if (body.name != null) { const n = String(body.name).trim(); if (!n) throw new BadRequestError("name cannot be empty."); patch.name = n; }
    if (body.nameAr !== undefined) patch.nameAr = typeof body.nameAr === "string" && body.nameAr.trim() ? body.nameAr.trim() : null;
    if (body.defaultUsefulLifeMonths != null) patch.defaultUsefulLifeMonths = assertMonths(body.defaultUsefulLifeMonths, "defaultUsefulLifeMonths");
    if (body.defaultMethod != null) patch.defaultMethod = assertMethod(body.defaultMethod, "defaultMethod");
    if (body.defaultResidualPct != null) patch.defaultResidualPct = money2(assertPct(body.defaultResidualPct, "defaultResidualPct", { max: 100, maxInclusive: false }));
    if (body.isActive != null) patch.isActive = Boolean(body.isActive);
    // the Saudi classifications and the account triple are the category's IDENTITY for the assets already under it: changed only while nothing is under it
    const identity = ["incomeTaxGroup", "vatCapitalAssetClass", "costAccountId", "accumulatedDepreciationAccountId", "depreciationExpenseAccountId"].filter((k) => body[k] != null);
    if (identity.length > 0) {
      const [withCount] = (await assetsRepository.categories(true)).filter((r) => r.category.id === id);
      if ((withCount?.assetCount ?? 0) > 0) throw new BusinessRuleError(409, { code: "asset_category_in_use", error: `${before.name} has ${withCount!.assetCount} asset(s): its tax group, VAT class and accounts are the identity those assets carry. Create a new category for a different treatment.`, field: identity[0] });
      if (body.incomeTaxGroup != null) patch.incomeTaxGroup = assertGroup(body.incomeTaxGroup, "incomeTaxGroup");
      if (body.vatCapitalAssetClass != null) patch.vatCapitalAssetClass = assertVatClass(body.vatCapitalAssetClass, "vatCapitalAssetClass");
      const accountIds = [body.costAccountId, body.accumulatedDepreciationAccountId, body.depreciationExpenseAccountId].filter((v) => v != null).map(Number);
      if (accountIds.length > 0) {
        const accts = await assetsRepository.accountsByIds(accountIds);
        const want: Array<[string, unknown, string]> = [["costAccountId", body.costAccountId, "asset"], ["accumulatedDepreciationAccountId", body.accumulatedDepreciationAccountId, "asset"], ["depreciationExpenseAccountId", body.depreciationExpenseAccountId, "expense"]];
        for (const [field, given, wantType] of want) {
          if (given == null) continue;
          const acct = accts.find((a) => a.id === Number(given));
          if (!acct) throw new BadRequestError(`${field}: account ${given} does not exist in this company.`);
          if (acct.type !== wantType) throw new BusinessRuleError(422, { code: "asset_category_account_type", error: `${field} must be a ${wantType} account; ${acct.name} is ${acct.type}.`, field });
          (patch as Record<string, unknown>)[field] = acct.id;
        }
      }
    }
    const [after] = await assetsRepository.updateCategory(id, patch);
    await auditService.updated("asset_category", id, before, { ...after, by: userId });
    const [full] = (await assetsRepository.categories(true)).filter((r) => r.category.id === id);
    return toCategoryView(full!);
  },

  // ── assets ──────────────────────────────────────────────────────────────
  async list(page: { limit?: number; offset?: number } = {}, filter: { status?: string; categoryId?: number } = {}) {
    const [rows, totals] = await Promise.all([assetsRepository.list(page, filter), assetsRepository.listTotals(filter)]);
    const { total, ...rest } = totals;
    return {
      items: rows.map((r) => toAssetView(r.asset, r.categoryName ?? null, parseFigures(r.asset, r.figures))),
      page: { limit: page.limit ?? DEFAULT_PAGE, offset: page.offset ?? 0, total },
      totals: rest,
    };
  },

  async getById(id: number) {
    const { asset, categoryName, figures } = await loadAsset(id);
    const [schedule, events] = await Promise.all([assetsRepository.schedule(id), assetsRepository.events(id)]);
    // a draft shows what its schedule WILL be; once capitalised the stored rows are the schedule
    let plannedSchedule: ScheduleRow[] | null = null;
    if (asset.status === "draft") {
      try { plannedSchedule = plannedScheduleOf(asset); } catch (e) { if (!(e instanceof BusinessRuleError)) throw e; plannedSchedule = null; }
    }
    return { ...toAssetView(asset, categoryName, figures), schedule: schedule.map(toScheduleView), plannedSchedule, events: events.map(toEventView) };
  },

  /** A DRAFT: the register row with its facts; nothing posts, nothing moves (the zero-movement standard). */
  async create(body: Record<string, unknown>, userId: number | null) {
    const categoryId = Number(body.categoryId);
    if (!Number.isInteger(categoryId) || categoryId <= 0) throw new BadRequestError("categoryId is required — an asset belongs to a category (its accounts, tax group and VAT class).");
    const [category] = await assetsRepository.findCategory(categoryId);
    if (!category) throw new BadRequestError(`Asset category ${categoryId} does not exist in this company.`);
    if (!category.isActive) throw new BusinessRuleError(409, { code: "asset_category_inactive", error: `${category.name} is inactive.`, field: "categoryId" });
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) throw new BadRequestError("name is required.");
    const acquisitionDate = assertDateString(body.acquisitionDate, "acquisitionDate");
    const availableForUseDate = body.availableForUseDate ? assertDateString(body.availableForUseDate, "availableForUseDate") : null;
    if (availableForUseDate && availableForUseDate < acquisitionDate) throw new BusinessRuleError(422, { code: "available_before_acquisition", error: "The available-for-use date cannot precede the acquisition date.", field: "availableForUseDate" });
    const cost = assertAmount(body.cost, "cost", { min: 0, allowZero: true });
    const usefulLifeMonths = body.usefulLifeMonths == null ? category.defaultUsefulLifeMonths : assertMonths(body.usefulLifeMonths, "usefulLifeMonths");
    const residualValue = body.residualValue == null ? round2((cost * num(category.defaultResidualPct)) / 100) : assertAmount(body.residualValue, "residualValue", { min: 0, allowZero: true });
    if (residualValue > cost) throw new BusinessRuleError(422, { code: "residual_value_invalid", error: "The residual value cannot exceed the cost (IAS 16.53).", field: "residualValue" });
    const depreciationMethod = body.depreciationMethod == null ? category.defaultMethod : assertMethod(body.depreciationMethod, "depreciationMethod");
    const vatInputTaxAmount = body.vatInputTaxAmount == null ? 0 : assertAmount(body.vatInputTaxAmount, "vatInputTaxAmount", { min: 0, allowZero: true });
    const vatInitialRecoveryPct = body.vatInitialRecoveryPct == null ? (vatInputTaxAmount > 0 ? 100 : category.vatCapitalAssetClass === "not_capital" ? 100 : 100) : assertPct(body.vatInitialRecoveryPct, "vatInitialRecoveryPct");
    const vatNonDeductibleReason = typeof body.vatNonDeductibleReason === "string" && body.vatNonDeductibleReason.trim() ? body.vatNonDeductibleReason.trim() : null;
    if (vatInitialRecoveryPct === 0 && vatInputTaxAmount === 0 && !vatNonDeductibleReason && category.vatCapitalAssetClass !== "not_capital") {
      // a capital asset whose input tax was NOT deducted names why (Art. 50: restricted vehicle, private use…) — the fact the Art. 52 regime and a later sale (Art. 50(3)) read
      throw new BusinessRuleError(422, { code: "vat_non_deductible_reason_required", error: "A capital asset with no input tax deducted (recovery 0 %) records why — VAT IR Art. 50 (a restricted motor vehicle, private use…).", field: "vatNonDeductibleReason" });
    }
    let assetNumber = typeof body.assetNumber === "string" ? body.assetNumber.trim() : "";
    if (!assetNumber) {
      const totals = await assetsRepository.listTotals();
      let seq = totals.total + 1;
      while ((await assetsRepository.findByNumber(`FA-${String(seq).padStart(5, "0")}`)).length > 0) seq++;
      assetNumber = `FA-${String(seq).padStart(5, "0")}`;
    } else if ((await assetsRepository.findByNumber(assetNumber)).length > 0) {
      throw new BusinessRuleError(409, { code: "asset_number_taken", error: `Asset number ${assetNumber} already exists in this company.`, field: "assetNumber" });
    }
    const text = nullifyEmptyText({ nameAr: body.nameAr, description: body.description, serialNumber: body.serialNumber, location: body.location, department: body.department, notes: body.notes, sourceReference: body.sourceReference } as Record<string, unknown>, ["nameAr", "description", "serialNumber", "location", "department", "notes", "sourceReference"]);
    // the draft is checked against the schedule engine NOW so an unbuildable schedule (an unsupported method) is a named refusal at creation, not at capitalisation
    if (availableForUseDate) {
      generateStraightLineSchedule({ cost, residualValue, usefulLifeMonths, depreciationMethod, availableForUseDate });
    }
    const [row] = await assetsRepository.insert({
      assetNumber, name,
      nameAr: text.nameAr as string | null, description: text.description as string | null, serialNumber: text.serialNumber as string | null,
      categoryId, location: text.location as string | null, department: text.department as string | null,
      custodianUserId: body.custodianUserId != null ? Number(body.custodianUserId) : null,
      acquisitionDate, availableForUseDate,
      cost: money2(cost), residualValue: money2(residualValue), usefulLifeMonths, depreciationMethod,
      vatInputTaxAmount: money2(vatInputTaxAmount), vatInitialRecoveryPct: money2(vatInitialRecoveryPct), vatCapitalAssetClass: category.vatCapitalAssetClass, vatNonDeductibleReason,
      incomeTaxGroup: category.incomeTaxGroup,
      source: "manual", sourceReference: text.sourceReference as string | null,
      status: "draft", notes: text.notes as string | null,
    });
    await recordAssetEvent(row!.id, "created", businessToday(), { assetNumber, name, cost, categoryId, incomeTaxGroup: category.incomeTaxGroup, vatCapitalAssetClass: category.vatCapitalAssetClass }, { userId });
    await auditService.created("asset", row!.id, { ...row, by: userId });
    return this.getById(row!.id);
  },

  /** A draft's facts may change freely; an in-service asset's facts of record may not (the DB trigger is the boundary — this names the refusal first). */
  async update(id: number, body: Record<string, unknown>, userId: number | null) {
    const { asset: before } = await loadAsset(id);
    if (before.status === "cancelled" || before.status === "disposed") throw new BusinessRuleError(409, { code: "asset_frozen", error: `${before.assetNumber} is ${before.status} and frozen.`, field: "id" });
    const patch: Partial<FixedAsset> = {};
    const text = nullifyEmptyText({ nameAr: body.nameAr, description: body.description, serialNumber: body.serialNumber, location: body.location, department: body.department, notes: body.notes, sourceReference: body.sourceReference } as Record<string, unknown>, ["nameAr", "description", "serialNumber", "location", "department", "notes", "sourceReference"]);
    if (body.name != null) { const n = String(body.name).trim(); if (!n) throw new BadRequestError("name cannot be empty."); patch.name = n; }
    for (const k of ["nameAr", "description", "serialNumber", "location", "department", "notes", "sourceReference"] as const) if (body[k] !== undefined) (patch as Record<string, unknown>)[k] = text[k];
    if (body.custodianUserId !== undefined) patch.custodianUserId = body.custodianUserId == null ? null : Number(body.custodianUserId);
    const factKeys = ["assetNumber", "categoryId", "acquisitionDate", "availableForUseDate", "cost", "residualValue", "usefulLifeMonths", "depreciationMethod", "vatInputTaxAmount", "vatInitialRecoveryPct", "vatNonDeductibleReason"].filter((k) => body[k] !== undefined);
    if (factKeys.length > 0) {
      if (before.status !== "draft") {
        throw new BusinessRuleError(409, { code: "asset_capitalised_facts_frozen", error: `${before.assetNumber} is in service: ${factKeys.join(", ")} are facts of record. The residual value, useful life and method change through the estimate-change act; the cost and dates through a reversal and a new capitalisation — never an edit.`, field: factKeys[0] });
      }
      if (body.assetNumber !== undefined) {
        const n = String(body.assetNumber).trim();
        if (!n) throw new BadRequestError("assetNumber cannot be empty.");
        if (n !== before.assetNumber && (await assetsRepository.findByNumber(n)).length > 0) throw new BusinessRuleError(409, { code: "asset_number_taken", error: `Asset number ${n} already exists in this company.`, field: "assetNumber" });
        patch.assetNumber = n;
      }
      if (body.categoryId !== undefined) {
        const [cat] = await assetsRepository.findCategory(Number(body.categoryId));
        if (!cat) throw new BadRequestError(`Asset category ${body.categoryId} does not exist in this company.`);
        patch.categoryId = cat.id; patch.incomeTaxGroup = cat.incomeTaxGroup; patch.vatCapitalAssetClass = cat.vatCapitalAssetClass;
      }
      if (body.acquisitionDate !== undefined) patch.acquisitionDate = assertDateString(body.acquisitionDate, "acquisitionDate");
      if (body.availableForUseDate !== undefined) patch.availableForUseDate = body.availableForUseDate ? assertDateString(body.availableForUseDate, "availableForUseDate") : null;
      if (body.cost !== undefined) patch.cost = money2(assertAmount(body.cost, "cost", { min: 0, allowZero: true }));
      if (body.residualValue !== undefined) patch.residualValue = money2(assertAmount(body.residualValue, "residualValue", { min: 0, allowZero: true }));
      if (body.usefulLifeMonths !== undefined) patch.usefulLifeMonths = assertMonths(body.usefulLifeMonths, "usefulLifeMonths");
      if (body.depreciationMethod !== undefined) patch.depreciationMethod = assertMethod(body.depreciationMethod, "depreciationMethod");
      if (body.vatInputTaxAmount !== undefined) patch.vatInputTaxAmount = money2(assertAmount(body.vatInputTaxAmount, "vatInputTaxAmount", { min: 0, allowZero: true }));
      if (body.vatInitialRecoveryPct !== undefined) patch.vatInitialRecoveryPct = money2(assertPct(body.vatInitialRecoveryPct, "vatInitialRecoveryPct"));
      if (body.vatNonDeductibleReason !== undefined) patch.vatNonDeductibleReason = typeof body.vatNonDeductibleReason === "string" && body.vatNonDeductibleReason.trim() ? body.vatNonDeductibleReason.trim() : null;
      const merged = { ...before, ...patch };
      if (num(merged.residualValue) > num(merged.cost)) throw new BusinessRuleError(422, { code: "residual_value_invalid", error: "The residual value cannot exceed the cost (IAS 16.53).", field: "residualValue" });
      if (merged.availableForUseDate && merged.availableForUseDate < merged.acquisitionDate) throw new BusinessRuleError(422, { code: "available_before_acquisition", error: "The available-for-use date cannot precede the acquisition date.", field: "availableForUseDate" });
      if (merged.availableForUseDate) plannedScheduleOf(merged);
    }
    const [after] = await assetsRepository.update(id, patch);
    await recordAssetEvent(id, "updated", businessToday(), { changed: Object.keys(patch) }, { userId });
    await auditService.updated("asset", id, before, { ...after, by: userId });
    return this.getById(id);
  },

  /** A draft never entered the books; it is CANCELLED by status (never hard-deleted — the number stays taken, the audit trail stays). */
  async cancel(id: number, body: { reason?: unknown }, userId: number | null) {
    const { asset } = await loadAsset(id);
    if (asset.status !== "draft") throw new BusinessRuleError(409, { code: "asset_not_draft", error: `${asset.assetNumber} is ${asset.status}; only a draft is cancelled. An asset in service leaves the books by disposal.`, field: "id" });
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    await assetsRepository.update(id, { status: "cancelled" });
    await recordAssetEvent(id, "cancelled", businessToday(), { reason: reason || null }, { userId });
    await auditService.updated("asset", id, asset, { status: "cancelled", reason: reason || null, by: userId });
    return this.getById(id);
  },
};
