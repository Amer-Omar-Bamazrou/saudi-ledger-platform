/**
 * FIXED ASSETS — FA-B: CAPITALISATION, THE MONTHLY RUN, THE ESTIMATE CHANGE
 * (2026-09-22). Decision record: docs/product/fixed-assets-decision-pack.md
 * §3 (entries A1/A2/D), §5, §6, §21.
 *
 * Every effect here goes through `postJournalEntry` after `checkPeriodOpen` —
 * there is no second path to the asset accounts, and nothing posts from a
 * draft.
 *
 *   CAPITALISE (A1) — the act that puts the cost in the books. It runs from
 *     the BILL that bought the asset: the bill's own posting path debits the
 *     asset CATEGORY's cost account instead of an expense account, and this
 *     module turns the draft register row into an asset in service with its
 *     stored schedule. One entry, one writer. Non-deductible VAT (a
 *     restricted motor vehicle — VAT IR Art. 50) is CAPITALISED into the
 *     cost rather than deducted, which is why the asset's recovery % decides
 *     the bill's VAT line.
 *   DEPRECIATE (D) — one period of one asset, or a company-wide run for a
 *     period: `Dr <category expense> / Cr <category accumulated>` dated the
 *     last day of the period, the schedule row marked posted. A period is
 *     depreciated ONCE (the table's unique), a closed month FAILS CLOSED with
 *     the standing remedy (the catch-up posts in an open month and says which
 *     period it depreciates — CLAUDE.md §4).
 *   CHANGE THE ESTIMATE (IAS 16.51, IAS 8) — residual, life or method,
 *     applied PROSPECTIVELY: the posted rows are never touched; the unposted
 *     tail is regenerated from the remaining carrying amount over the
 *     remaining life, and the act is audited with old and new.
 */
import { and, eq, isNull } from "drizzle-orm";
import { db, fixedAssetsTable, assetDepreciationScheduleTable } from "@workspace/db";
import { BadRequestError, BusinessRuleError, NotFoundError } from "../../lib/errors";
import { round2, money2 } from "../../lib/money";
import { assertDateString } from "../../lib/writeGuards";
import { postJournalEntry } from "../accounting/glPosting";
import { checkPeriodOpen } from "../accounting/periodLock";
import { auditService } from "../audit.service";
import { assetsRepository, parseFigures } from "../../repositories/assets.repository";
import { assetsService, recordAssetEvent, plannedScheduleOf } from "../assets.service";
import { generateStraightLineSchedule, assertMethodSupported, lastDayOf, periodOf, shiftPeriod } from "./depreciationSchedule";
import { businessToday } from "@workspace/shared";

const num = (v: unknown) => (v != null ? Number(v) : 0);
const fmt = (n: number) => n.toFixed(2);
const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;

async function loadForAct(assetId: number) {
  const [row] = await assetsRepository.findById(assetId);
  if (!row) throw new NotFoundError("Asset not found");
  const [category] = await assetsRepository.findCategory(row.asset.categoryId);
  if (!category) throw new BusinessRuleError(409, { code: "asset_category_missing", error: `Asset ${row.asset.assetNumber} names a category that no longer exists.`, field: "categoryId" });
  return { asset: row.asset, category, categoryName: row.categoryName ?? null, figures: parseFigures(row.asset, row.figures) };
}

export const assetCapitalisationService = {
  /**
   * The facts a BILL needs of the asset it capitalises, resolved before the
   * bill posts: which account its cost line debits, and whether its VAT is
   * deductible or capitalised. Called by `bills.approvable` inside the
   * approval transaction — it never posts anything itself.
   */
  async billCapitalisationPlan(assetId: number, billSubtotal: number, billVat: number) {
    const { asset, category } = await loadForAct(assetId);
    if (asset.status !== "draft") {
      throw new BusinessRuleError(409, { code: "asset_not_draft", error: `${asset.assetNumber} is ${asset.status}; only a draft asset is capitalised by a bill. A further cost on an asset in service is an addition, not a capitalisation.`, field: "capitalisesAssetId" });
    }
    if (!asset.availableForUseDate) {
      throw new BusinessRuleError(422, { code: "available_for_use_date_required", error: `${asset.assetNumber} has no available-for-use date. Depreciation begins in the month the asset is available for use (IAS 16.55), so capitalisation cannot proceed without it.`, field: "availableForUseDate" });
    }
    assertMethodSupported(asset.depreciationMethod);
    // VAT IR Art. 50: a capital asset whose input tax is not deductible carries it in the COST (IAS 16.16 — non-refundable purchase taxes).
    const capitaliseVat = num(asset.vatInitialRecoveryPct) === 0 && billVat > 0;
    const capitalised = round2(billSubtotal + (capitaliseVat ? billVat : 0));
    if (Math.abs(capitalised - num(asset.cost)) > 0.005) {
      throw new BusinessRuleError(422, {
        code: "asset_cost_mismatch",
        error: `${asset.assetNumber} records a cost of ${fmt(num(asset.cost))} but the bill capitalises ${fmt(capitalised)}${capitaliseVat ? " (its VAT is capitalised — recovery 0 %)" : ""}. Correct the asset's cost or the bill; the two must state the same amount.`,
        field: "cost",
      });
    }
    // 🔴 The line's label is the ACCOUNT's own name, never a literal of ours
    // (bills.approvable: the label and the account cannot disagree by
    // construction — a balance sheet groups by the label, so a literal would
    // file the cost under a name the chart does not have).
    const [costAccount] = await assetsRepository.accountsByIds([category.costAccountId]);
    if (!costAccount) throw new BusinessRuleError(422, { code: "asset_cost_account_missing", error: `The category ${category.name} names a cost account that no longer exists in this company's chart.`, field: "categoryId" });
    return { asset, category, capitaliseVat, capitalised, costAccountId: costAccount.id, costAccountName: costAccount.name };
  },

  /**
   * Turn the draft into an asset in service, on the entry the bill just
   * posted: the state, the stored schedule, the event. Runs inside the bill's
   * approval transaction — if anything here throws, the bill does not post.
   */
  async capitaliseOnEntry(assetId: number, journalEntryId: number, source: { kind: "bill"; billId: number; reference: string }, userId: number | null) {
    const { asset } = await loadForAct(assetId);
    const rows = plannedScheduleOf(asset);
    if (rows == null) throw new BusinessRuleError(422, { code: "available_for_use_date_required", error: `${asset.assetNumber} has no available-for-use date.`, field: "availableForUseDate" });
    const [updated] = await assetsRepository.update(assetId, {
      status: "in_service",
      capitalisationJournalEntryId: journalEntryId,
      source: source.kind,
      billId: source.billId,
      sourceReference: source.reference,
    });
    await assetsRepository.insertScheduleRows(rows.map((r) => ({
      assetId, period: r.period, sequence: r.sequence,
      amount: money2(r.amount), accumulatedAfter: money2(r.accumulatedAfter), carryingAfter: money2(r.carryingAfter),
    })));
    await recordAssetEvent(assetId, "capitalised", asset.availableForUseDate!, {
      cost: num(asset.cost), residualValue: num(asset.residualValue), usefulLifeMonths: asset.usefulLifeMonths,
      method: asset.depreciationMethod, periods: rows.length, firstPeriod: rows[0]?.period ?? null, lastPeriod: rows[rows.length - 1]?.period ?? null,
      vatInputTaxAmount: num(asset.vatInputTaxAmount), vatInitialRecoveryPct: num(asset.vatInitialRecoveryPct),
    }, { journalEntryId, documentRef: source.reference, userId });
    await auditService.updated("asset", assetId, asset, { ...updated, capitalisedBy: userId, journalEntryId });
    return updated!;
  },

  /**
   * One period of one asset. The entry is dated the LAST DAY of the period;
   * when that month is closed the run FAILS CLOSED and names the remedy — a
   * catch-up dated in an OPEN month, which posts the same amount, keeps the
   * schedule row's period unchanged and says in its description which period
   * it depreciates (CLAUDE.md §4: never re-date into a closed period, never
   * silently skip).
   */
  async depreciate(assetId: number, body: { period?: unknown; postingDate?: string | null }, userId: number | null) {
    const period = typeof body.period === "string" ? body.period.trim() : "";
    if (!PERIOD.test(period)) throw new BadRequestError("period must be YYYY-MM.");
    const { asset, category, categoryName } = await loadForAct(assetId);
    if (asset.status !== "in_service") {
      throw new BusinessRuleError(409, { code: "asset_not_in_service", error: `${asset.assetNumber} is ${asset.status}; depreciation runs on an asset in service.`, field: "id" });
    }
    const schedule = await assetsRepository.schedule(assetId);
    const row = schedule.find((s) => s.period === period);
    if (!row) {
      const first = schedule[0]?.period, last = schedule[schedule.length - 1]?.period;
      throw new BusinessRuleError(409, {
        code: "depreciation_period_not_scheduled",
        error: schedule.length === 0
          ? `${asset.assetNumber} has no schedule: its depreciable amount is exhausted (fully depreciated) or its life is over.`
          : `${period} is not in ${asset.assetNumber}'s schedule (${first} … ${last}).`,
        field: "period",
      });
    }
    if (row.journalEntryId != null) {
      throw new BusinessRuleError(409, { code: "depreciation_already_posted", error: `${asset.assetNumber} is already depreciated for ${period} (entry ${row.journalEntryId}). A period is depreciated once; a correction reverses that entry.`, field: "period" });
    }
    const earlier = schedule.find((s) => s.sequence < row.sequence && s.journalEntryId == null);
    if (earlier) {
      throw new BusinessRuleError(409, { code: "depreciation_out_of_order", error: `${asset.assetNumber} has not been depreciated for ${earlier.period} yet. The schedule posts in order, so the accumulated figure each row states is the figure in the books.`, field: "period" });
    }
    // the date: the period's last day, or an explicit catch-up date in an open month
    const scheduled = lastDayOf(period);
    let date = scheduled;
    if (body.postingDate != null && body.postingDate !== "") {
      date = assertDateString(body.postingDate, "postingDate");
      if (date < scheduled) throw new BusinessRuleError(422, { code: "posting_date_before_period", error: `A catch-up for ${period} cannot be dated ${date}, before the period it depreciates.`, field: "postingDate" });
    }
    await checkPeriodOpen(date);
    const caughtUp = date !== scheduled;
    const je = await postJournalEntry({
      entryNumber: `DEP-${asset.assetNumber}-${period}`,
      date,
      description: `Depreciation ${period} — ${asset.assetNumber} ${asset.name}${caughtUp ? ` (caught up: ${period} is closed, posted in an open month)` : ""}`,
      reference: asset.assetNumber,
      lines: [
        { accountId: category.depreciationExpenseAccountId, accountName: "Depreciation expense", description: `${asset.assetNumber} ${period}`, debitAmount: num(row.amount), creditAmount: 0 },
        { accountId: category.accumulatedDepreciationAccountId, accountName: "Accumulated depreciation", description: `${asset.assetNumber} ${period}`, debitAmount: 0, creditAmount: num(row.amount) },
      ],
    });
    const [posted] = await assetsRepository.markRowPosted(row.id, je.id);
    if (!posted) throw new BusinessRuleError(409, { code: "depreciation_already_posted", error: `${asset.assetNumber} was depreciated for ${period} by another request.`, field: "period" });
    await recordAssetEvent(assetId, "depreciated", date, { period, amount: num(row.amount), sequence: row.sequence, accumulatedAfter: num(row.accumulatedAfter), carryingAfter: num(row.carryingAfter), caughtUp, categoryName }, { journalEntryId: je.id, userId });
    return { assetId, period, amount: num(row.amount), date, journalEntryId: je.id, entryNumber: je.entryNumber, caughtUp };
  },

  /**
   * The company-wide run for one period: every asset in service with that
   * period planned and every earlier period posted. Each asset posts its OWN
   * entry (one entry per asset per period — the schedule row IS the entry),
   * and an asset that cannot run is REPORTED by name rather than skipped
   * silently.
   */
  async runPeriod(body: { period?: unknown; postingDate?: string | null }, userId: number | null) {
    const period = typeof body.period === "string" ? body.period.trim() : "";
    if (!PERIOD.test(period)) throw new BadRequestError("period must be YYYY-MM.");
    const due = await assetsRepository.assetsDueForPeriod(period);
    const posted: Array<{ assetId: number; assetNumber: string; amount: number; journalEntryId: number }> = [];
    const skipped: Array<{ assetId: number; assetNumber: string; code: string; reason: string }> = [];
    for (const a of due) {
      try {
        const out = await this.depreciate(a.id, { period, postingDate: body.postingDate ?? null }, userId);
        posted.push({ assetId: a.id, assetNumber: a.assetNumber, amount: out.amount, journalEntryId: out.journalEntryId });
      } catch (err) {
        // 🔴 A period lock stops the WHOLE run (it is one act on one company's books), and anything else is reported per asset.
        const e = err as { statusCode?: number; payload?: { code?: string; error?: string } };
        if (e.statusCode === 423) throw err;
        skipped.push({ assetId: a.id, assetNumber: a.assetNumber, code: e.payload?.code ?? "unknown", reason: e.payload?.error ?? (err as Error).message });
      }
    }
    return { period, posted, skipped, totalAmount: round2(posted.reduce((s, p) => s + p.amount, 0)) };
  },

  /**
   * IAS 16.51 / IAS 8 — a change in ESTIMATE, applied prospectively. Posted
   * rows are history; the unposted tail is regenerated from the remaining
   * carrying amount over the remaining life. Nothing posts.
   */
  async changeEstimate(assetId: number, body: { residualValue?: unknown; usefulLifeMonths?: unknown; depreciationMethod?: unknown; reason?: unknown }, userId: number | null) {
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (!reason) throw new BadRequestError("A reason for the estimate change is required (IAS 8 — it is disclosed).");
    const { asset } = await loadForAct(assetId);
    if (asset.status !== "in_service") throw new BusinessRuleError(409, { code: "asset_not_in_service", error: `${asset.assetNumber} is ${asset.status}; an estimate change applies to an asset in service.`, field: "id" });
    const residualValue = body.residualValue == null ? num(asset.residualValue) : round2(Number(body.residualValue));
    const usefulLifeMonths = body.usefulLifeMonths == null ? asset.usefulLifeMonths : Math.trunc(Number(body.usefulLifeMonths));
    const depreciationMethod = body.depreciationMethod == null ? asset.depreciationMethod : String(body.depreciationMethod);
    if (!Number.isFinite(residualValue) || residualValue < 0 || residualValue > num(asset.cost)) throw new BusinessRuleError(422, { code: "residual_value_invalid", error: "The residual value must lie between zero and the cost (IAS 16.53).", field: "residualValue" });
    if (!Number.isInteger(usefulLifeMonths) || usefulLifeMonths < 1) throw new BadRequestError("usefulLifeMonths must be a whole number of months, at least 1.");
    assertMethodSupported(depreciationMethod);
    if (residualValue === num(asset.residualValue) && usefulLifeMonths === asset.usefulLifeMonths && depreciationMethod === asset.depreciationMethod) {
      throw new BusinessRuleError(409, { code: "estimate_unchanged", error: `${asset.assetNumber} already carries that residual value, life and method.`, field: "residualValue" });
    }
    const postedRows = await assetsRepository.postedRows(assetId);
    const bookedPeriods = postedRows.length + asset.openingPeriodsBooked;
    if (usefulLifeMonths <= bookedPeriods) {
      throw new BusinessRuleError(422, { code: "useful_life_below_booked", error: `${asset.assetNumber} has ${bookedPeriods} period(s) already depreciated; a life of ${usefulLifeMonths} month(s) would rewrite them. A life shorter than what is booked is an impairment or a disposal, not an estimate change.`, field: "usefulLifeMonths" });
    }
    const accumulated = round2(num(asset.openingAccumulatedDepreciation) + postedRows.reduce((s, r) => s + num(r.amount), 0));
    if (accumulated > round2(num(asset.cost) - residualValue)) {
      throw new BusinessRuleError(422, { code: "residual_above_carrying", error: `${asset.assetNumber} has ${fmt(accumulated)} depreciated; a residual value of ${fmt(residualValue)} would exceed the remaining carrying amount.`, field: "residualValue" });
    }
    const last = postedRows[postedRows.length - 1];
    const resumeAfter = last ? `${last.period}-01` : null;
    const rows = generateStraightLineSchedule({
      cost: num(asset.cost), residualValue, usefulLifeMonths, depreciationMethod,
      availableForUseDate: asset.availableForUseDate!,
      openingAccumulated: accumulated, openingPeriodsBooked: bookedPeriods,
      openingDate: resumeAfter ?? (asset.openingPeriodsBooked > 0 ? shiftPeriod(periodOf(asset.availableForUseDate!), asset.openingPeriodsBooked - 1) + "-01" : null),
    });
    await assetsRepository.deletePlannedRows(assetId);
    await assetsRepository.insertScheduleRows(rows.map((r) => ({
      assetId, period: r.period, sequence: r.sequence,
      amount: money2(r.amount), accumulatedAfter: money2(r.accumulatedAfter), carryingAfter: money2(r.carryingAfter),
    })));
    const [updated] = await assetsRepository.update(assetId, { residualValue: money2(residualValue), usefulLifeMonths, depreciationMethod });
    await recordAssetEvent(assetId, "estimate_changed", businessToday(), {
      reason,
      before: { residualValue: num(asset.residualValue), usefulLifeMonths: asset.usefulLifeMonths, method: asset.depreciationMethod },
      after: { residualValue, usefulLifeMonths, method: depreciationMethod },
      firstAffectedPeriod: rows[0]?.period ?? null, regeneratedRows: rows.length, postedRowsUntouched: postedRows.length,
    }, { userId });
    await auditService.updated("asset", assetId, asset, { ...updated, reason, by: userId });
    return assetsService.getById(assetId);
  },
};

/** Exported for the register's own read: what the asset's next act is. */
export async function nextDueRow(assetId: number) {
  const [row] = await db
    .select()
    .from(assetDepreciationScheduleTable)
    .where(and(eq(assetDepreciationScheduleTable.assetId, assetId), isNull(assetDepreciationScheduleTable.journalEntryId)))
    .orderBy(assetDepreciationScheduleTable.sequence)
    .limit(1);
  return row ?? null;
}

export { fixedAssetsTable };
