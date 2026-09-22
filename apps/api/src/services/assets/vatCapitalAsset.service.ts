/**
 * FA-F (2026-09-22) — the Art. 52 capital-asset adjustment over the register.
 *
 * Record: docs/product/fixed-assets-decision-pack.md §7, §25.
 * The arithmetic and every quotation of the Regulations live in
 * `vatCapitalAsset.ts`; this file knows about companies, supplies and rows.
 *
 * 🔴 IT REFUSES BEFORE IT COMPUTES, and names the act that unblocks it:
 *   `tax_period_not_declared` — Art. 52(5) opens the first twelve-month window
 *                               at the start of the TAX PERIOD of acquisition
 *                               and files the adjustment in the return for the
 *                               last tax period inside it. Monthly and
 *                               quarterly give different windows and different
 *                               returns for the same purchase, so the period is
 *                               declared, never guessed from turnover.
 *
 * 🔴 AND IT NEVER TURNS AN UNKNOWN INTO A ZERO. Art. 52(4) adjusts "based on
 * the actual use during that year". Where a window's use is neither declared
 * nor derivable — a calendar year in which the company made no taxable and no
 * exempt supplies at all — the window reports `unavailable`, an adjustment of
 * nil and NOT Art. 52(6): nobody has established that the use did not change,
 * and a relief the platform did not check must not be evidenced as one.
 */
import { assetsRepository } from "../../repositories/assets.repository.js";
import { companiesRepository } from "../../repositories/companies.repository.js";
import { BusinessRuleError, NotFoundError } from "../../lib/errors.js";
import { auditService } from "../audit.service.js";
import { round2 } from "../../lib/money.js";
import { businessToday } from "@workspace/shared";
import {
  adjustmentPeriodYears, adjustmentWindows, computeAdjustmentYear, computeDisposalAdjustment,
  proportionalDeductionPct, type AdjustmentWindow, type DisposalAdjustmentKind, type VatTaxPeriod,
} from "./vatCapitalAsset.js";

export const VAT_USE_BASES = ["exclusive_use", "approved_alternative_method", "year_end_true_up", "other"] as const;

export type VatAdjustmentStatus = "computed" | "tax_period_not_declared";

/** Art. 51(4)(a)–(b): the calendar year whose supplies give a window its default use. */
const calendarYearOf = (isoDate: string) => Number(isoDate.slice(0, 4));

export const vatCapitalAssetService = {
  /**
   * The Art. 52 working paper: every capital asset in the register, each of its
   * twelve-month windows, and the disposal adjustment where one has happened.
   */
  async report(opts: { assetId?: number } = {}) {
    const company = await companiesRepository.findActive();
    if (!company) throw new NotFoundError("No company is configured for this organization.");

    const base = {
      companyId: company.id,
      companyName: company.name,
      vatTaxPeriod: (company.vatTaxPeriod ?? null) as VatTaxPeriod | null,
      /** Art. 51(4): the fraction per calendar year, shown so the derived use can be checked rather than trusted. */
      proportionalDeduction: [] as { calendarYear: number; taxableSupplies: number; exemptSupplies: number; pct: number | null }[],
      assets: [] as unknown[],
    };

    if (!company.vatTaxPeriod) {
      return {
        ...base,
        status: "tax_period_not_declared" as VatAdjustmentStatus,
        reason: "The company has not declared its VAT tax period. Art. 52(5) opens a capital asset's first twelve-month window at the start of the TAX PERIOD in which it was acquired, and files the adjustment in the return for the last tax period inside that window — so monthly and quarterly produce different windows and different returns for the same purchase. Declare it in Company Settings.",
      };
    }
    const taxPeriod = company.vatTaxPeriod as VatTaxPeriod;

    const assets = await assetsRepository.vatCapitalAssets(opts.assetId);
    if (assets.length === 0) {
      return { ...base, status: "computed" as VatAdjustmentStatus, reason: null };
    }

    // Every calendar year any window touches — Art. 51's fraction is annual and
    // shared, so it is computed ONCE per year rather than once per asset-window.
    const years = new Set<number>();
    const perAsset = assets.map((a) => {
      const periodYears = adjustmentPeriodYears(a.vatCapitalAssetClass, a.usefulLifeMonths);
      const windows = periodYears === null ? [] : adjustmentWindows(a.acquisitionDate, taxPeriod, periodYears);
      for (const w of windows) years.add(calendarYearOf(w.endDate));
      return { asset: a, periodYears, windows };
    });

    const supplies = await assetsRepository.suppliesByCalendarYear([...years]);
    const fractionOf = (year: number) => {
      const row = supplies.find((s) => s.calendarYear === year);
      const taxable = row?.taxableSupplies ?? 0;
      const exempt = row?.exemptSupplies ?? 0;
      return { taxable, exempt, pct: proportionalDeductionPct(taxable, exempt) };
    };

    const useRecords = await assetsRepository.vatUseRecords(assets.map((a) => a.id));
    const today = businessToday();

    const out = perAsset.map(({ asset, periodYears, windows }) => {
      const initialDeduction = round2((asset.vatInputTaxAmount * asset.vatInitialRecoveryPct) / 100);
      const potentiallyAdjustable = periodYears === null ? 0 : round2(initialDeduction / periodYears);

      const rows = windows.map((w: AdjustmentWindow) => {
        const declared = useRecords.find((r) => r.assetId === asset.id && r.periodIndex === w.index);
        const derived = fractionOf(calendarYearOf(w.endDate));
        const actualUsePct = declared ? declared.actualUsePct : derived.pct;
        const source = declared ? "declared" as const : derived.pct === null ? "unavailable" as const : "proportional" as const;
        const r = computeAdjustmentYear({ window: w, potentiallyAdjustable, initialRecoveryPct: asset.vatInitialRecoveryPct, actualUsePct, actualUseSource: source });
        return {
          ...r,
          window: undefined,
          periodIndex: w.index,
          startDate: w.startDate,
          endDate: w.endDate,
          returnPeriodStart: w.returnPeriodStart,
          returnPeriodEnd: w.returnPeriodEnd,
          /** The window has ended, so its adjustment is due (or was) in the return named beside it. */
          due: w.endDate <= today,
          declaredBasis: declared?.basis ?? null,
          declaredNote: declared?.note ?? null,
          declarationId: declared?.id ?? null,
        };
      });

      // Art. 52(7)/(8): the permanent change, where one has happened.
      let disposal = null as null | (ReturnType<typeof computeDisposalAdjustment> & { date: string; kind: string; vatTreatment: string; nominalSupplyValue: number | null });
      if (asset.disposal) {
        const idx = windows.findIndex((w) => asset.disposal!.date >= w.startDate && asset.disposal!.date <= w.endDate);
        const d = computeDisposalAdjustment({
          kind: asset.disposal.kind as DisposalAdjustmentKind,
          // 🔴 A disposal AFTER the last window is outside the period entirely,
          // so no window remains; `findIndex` returning -1 must not be read as
          // "the window before the first", which would leave the whole period
          // outstanding and adjust the lot.
          windowIndexOfDisposal: idx >= 0 ? idx + 1 : (asset.disposal.date > (windows.at(-1)?.endDate ?? "") ? (periodYears ?? 0) : 0),
          adjustmentPeriodYears: periodYears ?? 0,
          potentiallyAdjustable,
          initialRecoveryPct: asset.vatInitialRecoveryPct,
          saleIsTaxableSupply: asset.disposal.vatTreatment === "taxable_supply",
        });
        disposal = { ...d, date: asset.disposal.date, kind: asset.disposal.kind, vatTreatment: asset.disposal.vatTreatment, nominalSupplyValue: asset.disposal.nominalSupplyValue };
      }

      return {
        assetId: asset.id,
        assetNumber: asset.assetNumber,
        name: asset.name,
        acquisitionDate: asset.acquisitionDate,
        vatCapitalAssetClass: asset.vatCapitalAssetClass,
        usefulLifeMonths: asset.usefulLifeMonths,
        adjustmentPeriodYears: periodYears,
        vatInputTaxAmount: asset.vatInputTaxAmount,
        initialRecoveryPct: asset.vatInitialRecoveryPct,
        vatNonDeductibleReason: asset.vatNonDeductibleReason,
        initialDeduction,
        potentiallyAdjustable,
        /** Art. 66(1): the adjustment period plus five years from acquisition. */
        recordsRetainedUntil: periodYears === null ? null : `${calendarYearOf(asset.acquisitionDate) + periodYears + 5}-12-31`,
        windows: rows,
        disposal,
      };
    });

    return {
      ...base,
      status: "computed" as VatAdjustmentStatus,
      reason: null,
      proportionalDeduction: [...years].sort().map((y) => {
        const f = fractionOf(y);
        return { calendarYear: y, taxableSupplies: f.taxable, exemptSupplies: f.exempt, pct: f.pct };
      }),
      assets: out,
    };
  },

  /** The declared use records — the engine's only stored input, listed so they can be corrected. */
  async useRecords(assetId?: number) {
    const rows = await assetsRepository.vatUseRecords(assetId ? [assetId] : undefined);
    return rows.map((r) => ({ ...r, actualUsePct: r.actualUsePct, updatedAt: r.updatedAt.toISOString() }));
  },

  /**
   * State, or correct, the actual taxable use of one asset in one twelve-month
   * window — overriding the Art. 51 default for that window only.
   */
  async declareUse(input: { assetId: number; periodIndex: number; actualUsePct: number; basis: string; note?: string | null }, userId: number | null) {
    const [row0] = await assetsRepository.findById(input.assetId);
    if (!row0) throw new NotFoundError("Asset not found.");
    const asset = row0.asset;
    if (!VAT_USE_BASES.includes(input.basis as (typeof VAT_USE_BASES)[number])) {
      throw new BusinessRuleError(422, { error: `A use record states WHY it differs from the Art. 51 default: ${VAT_USE_BASES.join(", ")}.`, code: "vat_use_basis_unknown", field: "basis" });
    }
    if (!Number.isFinite(input.actualUsePct) || input.actualUsePct < 0 || input.actualUsePct > 100) {
      throw new BusinessRuleError(422, { error: "The actual use is a share of the period's use, between 0 and 100.", code: "vat_use_pct_invalid", field: "actualUsePct" });
    }
    const periodYears = adjustmentPeriodYears(asset.vatCapitalAssetClass, asset.usefulLifeMonths);
    if (periodYears === null) {
      throw new BusinessRuleError(422, { error: "This asset is not a capital asset for VAT (Art. 52(2)), so it has no adjustment period and no use to state.", code: "not_a_capital_asset", field: "assetId" });
    }
    // 🔴 A window outside the adjustment period is not a window. Accepting one
    // would store a figure the report can never show, which is the quietest way
    // for a declaration to be lost.
    if (!Number.isInteger(input.periodIndex) || input.periodIndex < 1 || input.periodIndex > periodYears) {
      throw new BusinessRuleError(422, {
        error: `This asset's adjustment period is ${periodYears} year(s) (Art. 52(2)), so its windows are 1–${periodYears}; ${input.periodIndex} is outside it.`,
        code: "adjustment_period_out_of_range", field: "periodIndex",
      });
    }

    const [existing] = await assetsRepository.findVatUseRecord(input.assetId, input.periodIndex);
    const values = {
      assetId: input.assetId,
      periodIndex: input.periodIndex,
      actualUsePct: String(round2(input.actualUsePct)),
      basis: input.basis,
      note: input.note ?? null,
      declaredBy: userId,
    };
    const [row] = existing
      ? await assetsRepository.updateVatUseRecord(existing.id, values)
      : await assetsRepository.insertVatUseRecord(values);

    if (existing) await auditService.updated("asset_vat_use_record", row!.id, existing, row);
    else await auditService.created("asset_vat_use_record", row!.id, row);
    await assetsRepository.insertEvent({
      assetId: input.assetId, kind: "vat_use_recorded", occurredOn: businessToday(),
      payload: { periodIndex: input.periodIndex, actualUsePct: values.actualUsePct, basis: input.basis }, userId,
    });
    return { ...row!, actualUsePct: Number(row!.actualUsePct), updatedAt: row!.updatedAt.toISOString() };
  },

  async removeUse(id: number) {
    const [row] = await assetsRepository.deleteVatUseRecord(id);
    if (!row) throw new NotFoundError("Use record not found.");
    await auditService.deleted("asset_vat_use_record", id, row);
    return { id };
  },
};
