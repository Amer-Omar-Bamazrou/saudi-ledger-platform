/**
 * Fixed assets service — straight-line depreciation calc + the depreciate action.
 * All arithmetic and guards preserved byte-for-byte from the pre-M6 route.
 */
import { BadRequestError, NotFoundError } from "../lib/errors";
import { pick, assertAmount, assertDateString } from "../lib/writeGuards";

/** H1 allowlist — user-settable asset fields (computed/depreciation fields excluded). */
const ASSET_FIELDS = [
  "assetNumber", "name", "nameAr", "categoryId", "purchaseDate", "purchaseCost",
  "salvageValue", "usefulLifeYears", "depreciationMethod", "location",
  "serialNumber", "status", "disposalDate", "disposalValue", "notes",
] as const;
import { auditService } from "./audit.service";
import { assetsRepository } from "../repositories/assets.repository";
import type { fixedAssetsTable, depreciationEntriesTable } from "@workspace/db";

type Asset = typeof fixedAssetsTable.$inferSelect;
type DepEntry = typeof depreciationEntriesTable.$inferSelect;
const toNum = (v: unknown) => (v != null ? Number(v) : 0);

const toView = (a: Asset) => ({
  ...a,
  purchaseCost: toNum(a.purchaseCost),
  salvageValue: toNum(a.salvageValue),
  usefulLifeYears: toNum(a.usefulLifeYears),
  accumulatedDepreciation: toNum(a.accumulatedDepreciation),
  currentBookValue: toNum(a.currentBookValue),
  disposalValue: a.disposalValue != null ? toNum(a.disposalValue) : null,
  annualDepreciation: (toNum(a.purchaseCost) - toNum(a.salvageValue)) / toNum(a.usefulLifeYears),
  monthlyDepreciation: (toNum(a.purchaseCost) - toNum(a.salvageValue)) / (toNum(a.usefulLifeYears) * 12),
});

const toEntryView = (e: DepEntry) => ({ ...e, amount: toNum(e.amount), bookValueAfter: toNum(e.bookValueAfter) });

export const assetsService = {
  async list() {
    const rows = await assetsRepository.list();
    return rows.map(toView);
  },

  async getById(id: number) {
    const [asset] = await assetsRepository.findById(id);
    if (!asset) throw new NotFoundError("Not found");
    const entries = await assetsRepository.depreciationByAsset(id);
    return { ...toView(asset), depreciationHistory: entries.map(toEntryView) };
  },

  async create(data: Record<string, unknown>) {
    // 🔴 H1/H2 — ALLOWLIST + validate. `usefulLifeYears: 0` produced
    // `annualDepreciation: Infinity` (→ null in the view); `String(undefined)`
    // → 500. Life must be ≥ 1; costs ≥ 0. currentBookValue/accumulated are
    // computed here, never taken from the client.
    const picked = pick<Record<string, unknown>>(data, ASSET_FIELDS);
    if (data.purchaseDate != null) assertDateString(data.purchaseDate, "purchaseDate");
    const purchaseCost = assertAmount(data.purchaseCost, "purchaseCost", { min: 0, allowZero: true });
    const life = assertAmount(data.usefulLifeYears, "usefulLifeYears", { min: 1 });
    const values = {
      ...picked,
      purchaseCost: purchaseCost.toFixed(2),
      salvageValue: assertAmount(data.salvageValue ?? 0, "salvageValue", { min: 0, allowZero: true }).toFixed(2),
      usefulLifeYears: String(Math.trunc(life)),
      currentBookValue: purchaseCost.toFixed(2),
      accumulatedDepreciation: "0",
    } as typeof fixedAssetsTable.$inferInsert;
    const [row] = await assetsRepository.insert(values);
    await auditService.created("asset", row.id, row);
    return toView(row);
  },

  async update(id: number, data: Record<string, unknown>) {
    const [before] = await assetsRepository.findById(id);
    if (!before) throw new NotFoundError("Not found");
    const updates = pick<Record<string, unknown>>(data, [...ASSET_FIELDS, "currentBookValue"]);
    if (updates.purchaseDate != null) assertDateString(updates.purchaseDate, "purchaseDate");
    for (const f of ["purchaseCost", "salvageValue", "currentBookValue"] as const) {
      if (updates[f] != null) updates[f] = assertAmount(updates[f], f, { min: 0, allowZero: true }).toFixed(2);
    }
    if (updates.usefulLifeYears != null) updates.usefulLifeYears = String(Math.trunc(assertAmount(updates.usefulLifeYears, "usefulLifeYears", { min: 1 })));
    const [row] = await assetsRepository.update(id, updates as Partial<typeof fixedAssetsTable.$inferInsert>);
    await auditService.updated("asset", id, before, row);
    return toView(row);
  },

  /** Run one month of straight-line depreciation for an asset. */
  async depreciate(id: number, period: string) {
    const [asset] = await assetsRepository.findById(id);
    if (!asset) throw new NotFoundError("Not found");
    if (asset.status !== "active") throw new BadRequestError("Asset is not active");

    const bookValue = toNum(asset.currentBookValue);
    const salvage = toNum(asset.salvageValue);
    const monthlyAmount = (toNum(asset.purchaseCost) - salvage) / (toNum(asset.usefulLifeYears) * 12);
    const amount = Math.min(monthlyAmount, Math.max(0, bookValue - salvage));
    if (amount <= 0) throw new BadRequestError("Asset fully depreciated");

    const newBookValue = bookValue - amount;
    const newAccumulated = toNum(asset.accumulatedDepreciation) + amount;

    const [updated] = await assetsRepository.update(id, {
      currentBookValue: String(newBookValue.toFixed(2)),
      accumulatedDepreciation: String(newAccumulated.toFixed(2)),
      status: newBookValue <= salvage ? "fully-depreciated" : "active",
    });

    const [entry] = await assetsRepository.insertDepreciationEntry({
      assetId: id,
      period,
      amount: String(amount.toFixed(2)),
      bookValueAfter: String(newBookValue.toFixed(2)),
    });
    // A depreciation run mutates the asset's book value — record it as an update.
    await auditService.updated("asset", id, asset, { ...updated, depreciationEntry: entry });
    return toEntryView(entry);
  },

  async remove(id: number) {
    const [before] = await assetsRepository.findById(id);
    await assetsRepository.remove(id);
    if (before) await auditService.deleted("asset", id, before);
  },
};
