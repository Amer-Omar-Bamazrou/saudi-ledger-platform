/**
 * FIXED ASSETS — FA-D: MIGRATED ASSETS (2026-09-22). Decision record:
 * docs/product/fixed-assets-decision-pack.md §10, §23.
 *
 * The assets the previous system held at cut-off enter Batch 1C as a STAGING
 * set beside the parties, open items and advances, and become register rows
 * at commit.
 *
 * 🔴 THEY CREATE NO JOURNAL LINE. Their cost and accumulated depreciation are
 * already in the staged trial balance — A5: ONE balanced opening position,
 * never a plug — so the register RECONCILES to those mapped balances instead
 * of adding to them. That reconciliation is a validation control (R-ASSETS),
 * exactly as open items reconcile to AR/AP, and it BLOCKS the commit when the
 * register and the trial balance disagree.
 *
 * At commit each staged asset becomes a `fixed_assets` row: `source =
 * migration`, the batch and the source id as provenance, `in_service` with
 * the OPENING JOURNAL as its capitalisation entry, its opening accumulated
 * depreciation and periods booked recorded, and its schedule resuming the
 * month AFTER the opening date over the remaining life (the original schedule
 * continued — an estimate change is a separate, audited act).
 */
import { BadRequestError, BusinessRuleError } from "../../lib/errors";
import { round2, money2 } from "../../lib/money";
import { migrationRepository } from "../../repositories/migration.repository";
import { assetsRepository } from "../../repositories/assets.repository";
import { recordAssetEvent, vatAdjustmentPeriodYears } from "../assets.service";
import { generateStraightLineSchedule } from "./depreciationSchedule";
import type { MigrationAsset, MigrationBatch, AssetCategory } from "@workspace/db";

const num = (v: unknown) => (v != null ? Number(v) : 0);
const fmt = (n: number) => n.toFixed(2);
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const METHODS: readonly string[] = ["straight_line", "declining_balance", "units_of_production"];

export type MigrationAssetInput = {
  sourceId: string;
  name: string;
  nameAr?: string | null;
  serialNumber?: string | null;
  categoryName: string;
  acquisitionDate: string;
  availableForUseDate: string;
  cost: number;
  residualValue?: number | null;
  usefulLifeMonths: number;
  depreciationMethod?: string | null;
  openingAccumulatedDepreciation: number;
  openingPeriodsBooked: number;
  vatInputTaxAmount?: number | null;
  vatInitialRecoveryPct?: number | null;
  vatNonDeductibleReason?: string | null;
  location?: string | null;
  description?: string | null;
};

/** Every problem of one staged asset, computed on READ from the staged content (Batch 1C's own posture). */
export function migrationAssetProblems(a: MigrationAsset, batch: Pick<MigrationBatch, "openingDate">, categories: AssetCategory[]): string[] {
  const problems: string[] = [];
  const category = categories.find((c) => c.name.trim().toLowerCase() === a.categoryName.trim().toLowerCase());
  if (!category) problems.push(`asset category "${a.categoryName}" does not exist in this company — create it first (it carries the accounts, the Art. 17 group and the Art. 52 class)`);
  else if (!category.isActive) problems.push(`asset category "${category.name}" is inactive`);
  if (a.availableForUseDate > batch.openingDate) problems.push(`available for use ${a.availableForUseDate}, after the opening date ${batch.openingDate} — an asset that entered service after the cut-off is bought in the product, not migrated`);
  if (a.depreciationMethod !== "straight_line") problems.push(`${a.depreciationMethod} is not computed yet — only straight-line schedules can be generated (pack §6, §12)`);
  // VAT IR Art. 52: an asset still INSIDE its adjustment period must carry its input-tax facts, because an adjustment may still fall due on it
  if (category) {
    const period = vatAdjustmentPeriodYears(category.vatCapitalAssetClass, a.usefulLifeMonths);
    if (period != null) {
      const elapsedYears = Math.ceil(Math.max(0, (Number(batch.openingDate.slice(0, 4)) - Number(a.acquisitionDate.slice(0, 4))) * 12 + (Number(batch.openingDate.slice(5, 7)) - Number(a.acquisitionDate.slice(5, 7)))) / 12);
      const inside = elapsedYears < period;
      if (inside && (a.vatInputTaxAmount == null || a.vatInitialRecoveryPct == null)) {
        problems.push(`acquired ${a.acquisitionDate}, still inside its ${period}-year VAT adjustment period (Art. 52(2)) — state the input tax deducted and the recovery %, or the adjustment cannot be computed`);
      }
    }
  }
  const depreciable = round2(num(a.cost) - num(a.residualValue));
  if (num(a.openingAccumulatedDepreciation) > depreciable + 0.005) problems.push(`accumulated ${fmt(num(a.openingAccumulatedDepreciation))} exceeds the depreciable amount ${fmt(depreciable)}`);
  return problems;
}

export const migratedAssetsService = {
  /** Validate and replace the batch's staged assets (a draft batch only — the trigger is the boundary). */
  async parseRows(batch: MigrationBatch, rows: MigrationAssetInput[]) {
    if (rows.length === 0) throw new BadRequestError("At least one asset is required.");
    const seen = new Set<string>();
    return rows.map((r, i) => {
      const where = `rows[${i}]`;
      const sourceId = String(r.sourceId ?? "").trim();
      if (!sourceId) throw new BadRequestError(`${where}.sourceId is required.`);
      if (seen.has(sourceId)) throw new BadRequestError(`${where}: source id ${sourceId} appears twice in the file.`);
      seen.add(sourceId);
      const name = String(r.name ?? "").trim();
      if (!name) throw new BadRequestError(`${where}.name is required.`);
      const categoryName = String(r.categoryName ?? "").trim();
      if (!categoryName) throw new BadRequestError(`${where}.categoryName is required — it carries the asset's accounts, its Art. 17 group and its Art. 52 class.`);
      for (const [k, v] of [["acquisitionDate", r.acquisitionDate], ["availableForUseDate", r.availableForUseDate]] as const) {
        if (typeof v !== "string" || !ISO.test(v)) throw new BadRequestError(`${where}.${k} must be YYYY-MM-DD.`);
      }
      if (r.availableForUseDate < r.acquisitionDate) throw new BadRequestError(`${where}: available for use precedes the acquisition date.`);
      const cost = round2(num(r.cost));
      if (!Number.isFinite(cost) || cost <= 0) throw new BadRequestError(`${where}.cost must be a positive amount.`);
      const residualValue = r.residualValue == null ? 0 : round2(num(r.residualValue));
      if (!Number.isFinite(residualValue) || residualValue < 0 || residualValue > cost) throw new BadRequestError(`${where}.residualValue must lie between zero and the cost.`);
      const usefulLifeMonths = Math.trunc(num(r.usefulLifeMonths));
      if (!Number.isInteger(usefulLifeMonths) || usefulLifeMonths < 1 || usefulLifeMonths > 1200) throw new BadRequestError(`${where}.usefulLifeMonths must be a whole number of months between 1 and 1200.`);
      const openingAccumulatedDepreciation = round2(num(r.openingAccumulatedDepreciation));
      if (!Number.isFinite(openingAccumulatedDepreciation) || openingAccumulatedDepreciation < 0) throw new BadRequestError(`${where}.openingAccumulatedDepreciation must be zero or more — what the previous system had depreciated at the opening date.`);
      if (openingAccumulatedDepreciation > round2(cost - residualValue) + 0.005) throw new BadRequestError(`${where}.openingAccumulatedDepreciation (${fmt(openingAccumulatedDepreciation)}) exceeds the depreciable amount (${fmt(round2(cost - residualValue))}).`);
      const openingPeriodsBooked = Math.trunc(num(r.openingPeriodsBooked));
      if (!Number.isInteger(openingPeriodsBooked) || openingPeriodsBooked < 0 || openingPeriodsBooked > usefulLifeMonths) throw new BadRequestError(`${where}.openingPeriodsBooked must be between 0 and the useful life.`);
      const depreciationMethod = r.depreciationMethod?.trim() || "straight_line";
      if (!METHODS.includes(depreciationMethod)) throw new BadRequestError(`${where}.depreciationMethod must be straight_line, declining_balance or units_of_production.`);
      const vatInputTaxAmount = r.vatInputTaxAmount == null ? null : round2(num(r.vatInputTaxAmount));
      if (vatInputTaxAmount != null && (!Number.isFinite(vatInputTaxAmount) || vatInputTaxAmount < 0)) throw new BadRequestError(`${where}.vatInputTaxAmount must be zero or more.`);
      const vatInitialRecoveryPct = r.vatInitialRecoveryPct == null ? null : round2(num(r.vatInitialRecoveryPct));
      if (vatInitialRecoveryPct != null && (!Number.isFinite(vatInitialRecoveryPct) || vatInitialRecoveryPct < 0 || vatInitialRecoveryPct > 100)) throw new BadRequestError(`${where}.vatInitialRecoveryPct must be a percentage.`);
      const vatNonDeductibleReason = r.vatNonDeductibleReason?.trim() || null;
      if (vatInitialRecoveryPct === 0 && !vatNonDeductibleReason) throw new BadRequestError(`${where}: a recovery of 0 % records WHY the input tax was not deducted (VAT IR Art. 50) — it decides how the asset's later sale is taxed.`);
      return {
        batchId: batch.id, sourceSystem: batch.sourceSystem, sourceId, name,
        nameAr: r.nameAr?.trim() || null, serialNumber: r.serialNumber?.trim() || null, categoryName,
        acquisitionDate: r.acquisitionDate, availableForUseDate: r.availableForUseDate,
        cost: fmt(cost), residualValue: fmt(residualValue), usefulLifeMonths, depreciationMethod,
        openingAccumulatedDepreciation: fmt(openingAccumulatedDepreciation), openingPeriodsBooked,
        vatInputTaxAmount: vatInputTaxAmount == null ? null : fmt(vatInputTaxAmount),
        vatInitialRecoveryPct: vatInitialRecoveryPct == null ? null : fmt(vatInitialRecoveryPct),
        vatNonDeductibleReason,
        location: r.location?.trim() || null, description: r.description?.trim() || null,
      };
    });
  },

  /**
   * The RECONCILIATION the opening position must satisfy (R-ASSETS): the
   * register's cost equals the trial balance's mapped cost accounts, and its
   * opening accumulated depreciation equals the mapped accumulated accounts.
   * Returns the two figures each way; the control compares them.
   */
  async reconciliation(batchId: number) {
    const [assets, categories] = await Promise.all([migrationRepository.migrationAssets(batchId), assetsRepository.categories(true)]);
    const cats = categories.map((c) => c.category);
    const registerCost = round2(assets.reduce((s, a) => s + num(a.cost), 0));
    const registerAccumulated = round2(assets.reduce((s, a) => s + num(a.openingAccumulatedDepreciation), 0));
    /**
     * 🔴 The ACCOUNT SETS are every asset category's, not only the categories
     * the staged assets happen to name. Deriving them from the staged rows
     * made the dangerous case invisible: with asset balances in the trial
     * balance and an EMPTY register, both sets were empty, the mapped figures
     * read zero, and the control stayed silent — a confident pass over the
     * very mismatch it exists to catch.
     */
    const costAccountIds = new Set(cats.map((c) => c.costAccountId));
    const accumulatedAccountIds = new Set(cats.map((c) => c.accumulatedDepreciationAccountId));
    return { assets, registerCost, registerAccumulated, costAccountIds: [...costAccountIds], accumulatedAccountIds: [...accumulatedAccountIds] };
  },

  /**
   * At commit: one register row per staged asset, in service on the OPENING
   * JOURNAL, with its schedule resuming after the opening date. No journal
   * line of its own (the trial balance already carries the figures).
   */
  async materialise(batch: MigrationBatch, openingJournalEntryId: number, userId: number | null) {
    const assets = await migrationRepository.migrationAssets(batch.id);
    if (assets.length === 0) return [];
    const categories = (await assetsRepository.categories(true)).map((c) => c.category);
    const created: { id: number; assetNumber: string; sourceId: string; periods: number }[] = [];
    for (const a of assets) {
      const category = categories.find((c) => c.name.trim().toLowerCase() === a.categoryName.trim().toLowerCase());
      if (!category) {
        throw new BusinessRuleError(422, { code: "migration_asset_category_missing", error: `Staged asset ${a.sourceId} names the category "${a.categoryName}", which does not exist in this company.`, field: "categoryName" });
      }
      const assetNumber = `MIG-${batch.id}-${a.sourceId}`.slice(0, 60);
      const [row] = await assetsRepository.insert({
        assetNumber, name: a.name, nameAr: a.nameAr, serialNumber: a.serialNumber, description: a.description,
        categoryId: category.id, location: a.location,
        acquisitionDate: a.acquisitionDate, availableForUseDate: a.availableForUseDate,
        cost: a.cost, residualValue: a.residualValue, usefulLifeMonths: a.usefulLifeMonths, depreciationMethod: a.depreciationMethod,
        openingAccumulatedDepreciation: a.openingAccumulatedDepreciation, openingPeriodsBooked: a.openingPeriodsBooked,
        vatInputTaxAmount: a.vatInputTaxAmount ?? "0", vatInitialRecoveryPct: a.vatInitialRecoveryPct ?? "100",
        vatCapitalAssetClass: category.vatCapitalAssetClass, vatNonDeductibleReason: a.vatNonDeductibleReason,
        incomeTaxGroup: category.incomeTaxGroup,
        source: "migration", migrationBatchId: batch.id, sourceReference: a.sourceId,
        status: "draft",
        notes: `Fixed asset migrated from ${a.sourceSystem} (${a.sourceId}) at the opening date ${batch.openingDate}; original cost ${fmt(num(a.cost))}, accumulated ${fmt(num(a.openingAccumulatedDepreciation))} over ${a.openingPeriodsBooked} period(s).`,
      });
      // the schedule RESUMES the month after the opening date, over the remaining life
      const rows = generateStraightLineSchedule({
        cost: num(a.cost), residualValue: num(a.residualValue), usefulLifeMonths: a.usefulLifeMonths,
        depreciationMethod: a.depreciationMethod, availableForUseDate: a.availableForUseDate,
        openingAccumulated: num(a.openingAccumulatedDepreciation), openingPeriodsBooked: a.openingPeriodsBooked,
        openingDate: batch.openingDate,
      });
      await assetsRepository.update(row!.id, { status: "in_service", capitalisationJournalEntryId: openingJournalEntryId });
      await assetsRepository.insertScheduleRows(rows.map((r) => ({
        assetId: row!.id, period: r.period, sequence: r.sequence,
        amount: money2(r.amount), accumulatedAfter: money2(r.accumulatedAfter), carryingAfter: money2(r.carryingAfter),
      })));
      await recordAssetEvent(row!.id, "capitalised", batch.openingDate, {
        migrated: true, batchId: batch.id, sourceSystem: a.sourceSystem, sourceId: a.sourceId,
        cost: num(a.cost), openingAccumulated: num(a.openingAccumulatedDepreciation), openingPeriodsBooked: a.openingPeriodsBooked,
        remainingPeriods: rows.length, firstPeriod: rows[0]?.period ?? null,
      }, { journalEntryId: openingJournalEntryId, documentRef: `migration:${batch.id}`, userId });
      await migrationRepository.updateMigrationAsset(a.id, { resolvedAssetId: row!.id });
      created.push({ id: row!.id, assetNumber, sourceId: a.sourceId, periods: rows.length });
    }
    return created;
  },
};
