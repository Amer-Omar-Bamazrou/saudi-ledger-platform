/**
 * FIXED ASSETS — FA-C: DISPOSAL (2026-09-22). Decision record:
 * docs/product/fixed-assets-decision-pack.md §9, §22.
 *
 * Derecognition (IAS 16.67): the asset leaves the books and the difference
 * between what came in and what it was carried at is a GAIN OR LOSS in
 * profit or loss — never revenue (IAS 16.68, 71). Two doors:
 *
 *   SALE (E1) — an ordinary tax invoice of this product that NAMES the asset
 *     (`invoices.disposes_asset_id`). Its revenue line credits
 *     `ASSET_DISPOSAL_GAIN_LOSS` instead of `SALES`, and approval
 *     derecognises the asset on the same entry:
 *         Dr Accumulated depreciation   (everything posted to date)
 *         Dr Asset disposal gain/loss   (the carrying amount)
 *             Cr Asset cost             (the cost)
 *     Net of the two, the account holds `proceeds − carrying amount`.
 *   SCRAP / DESTROYED / STOLEN / WITHDRAWN (E2) — a disposal document with no
 *     proceeds, posting the same derecognition alone.
 *
 * 🔴 DEPRECIATION RUNS UP TO THE DISPOSAL MONTH FIRST (IAS 16.55: it ceases at
 * derecognition, not before). The act posts every outstanding period up to and
 * including the month of disposal through the ordinary run — its own entry
 * each, its own period lock — and reports them. A closed month therefore stops
 * a disposal, by the same rule and with the same remedy.
 *
 * The Saudi VAT consequence is a FACT OF THE KIND, recorded on the disposal:
 *   · sold → a taxable supply (Art. 3(5)) — unless the asset was a restricted
 *     motor vehicle bought without deduction, whose sale is outside the
 *     economic activity (Art. 50(3)): the invoice must then carry no VAT, and
 *     a VAT-bearing one is REFUSED by name;
 *   · scrapped / destroyed / stolen → no Art. 52(7) adjustment (the text says
 *     so in terms);
 *   · withdrawn while still usable → a NOMINAL SUPPLY, valued by the
 *     Art. 52(8) formula (purchase value × initial recovery % × remaining
 *     useful life ÷ adjustment period) and STORED. Whether v1 declares it is
 *     the FA-2 engine's business; storing the number is not declaring it.
 */
import { db, assetDisposalsTable, type AssetDisposalKind } from "@workspace/db";
import { BadRequestError, BusinessRuleError, NotFoundError } from "../../lib/errors";
import { round2, money2 } from "../../lib/money";
import { assertDateString } from "../../lib/writeGuards";
import { postJournalEntry, type GLLine } from "../accounting/glPosting";
import { checkPeriodOpen } from "../accounting/periodLock";
import { auditService } from "../audit.service";
import { assetsRepository, parseFigures } from "../../repositories/assets.repository";
import { assetsService, recordAssetEvent, vatAdjustmentPeriodYears } from "../assets.service";
import { assetCapitalisationService } from "./capitalisation.service";
import { periodOf } from "./depreciationSchedule";

const num = (v: unknown) => (v != null ? Number(v) : 0);
const fmt = (n: number) => n.toFixed(2);
const KINDS: readonly string[] = ["sold", "scrapped", "destroyed", "stolen", "withdrawn"];

export type DisposalPlan = {
  asset: Awaited<ReturnType<typeof assetsRepository.findById>>[number]["asset"];
  accumulated: number;
  carrying: number;
  costAccountId: number;
  costAccountName: string;
  accumulatedAccountId: number;
  disposalAccountId: number;
  disposalAccountName: string;
  restrictedVehicle: boolean;
};

async function load(assetId: number) {
  const [row] = await assetsRepository.findById(assetId);
  if (!row) throw new NotFoundError("Asset not found");
  const [category] = await assetsRepository.findCategory(row.asset.categoryId);
  if (!category) throw new BusinessRuleError(409, { code: "asset_category_missing", error: `Asset ${row.asset.assetNumber} names a category that no longer exists.`, field: "categoryId" });
  return { asset: row.asset, category, figures: parseFigures(row.asset, row.figures) };
}

/**
 * VAT IR Art. 52(8): the nominal-supply value of an asset withdrawn from the
 * activity while it still has life — `purchase value × initial recovery % ×
 * remaining useful life ÷ adjustment period`. The remaining life and the
 * adjustment period are both counted in WHOLE YEARS (52(2): "part years
 * count as one"); a withdrawal past the adjustment period is zero.
 */
export function nominalSupplyValue(a: { cost: string | number; vatInitialRecoveryPct: string | number; vatCapitalAssetClass: string; usefulLifeMonths: number; acquisitionDate: string }, onDate: string): number {
  const period = vatAdjustmentPeriodYears(a.vatCapitalAssetClass, a.usefulLifeMonths);
  if (period == null || period <= 0) return 0;
  const acquiredYear = Number(a.acquisitionDate.slice(0, 4));
  const acquiredMonth = Number(a.acquisitionDate.slice(5, 7));
  const onYear = Number(onDate.slice(0, 4));
  const onMonth = Number(onDate.slice(5, 7));
  const elapsedMonths = (onYear - acquiredYear) * 12 + (onMonth - acquiredMonth);
  const elapsedYears = Math.ceil(Math.max(0, elapsedMonths) / 12); // part years count as one
  const remaining = Math.max(0, period - elapsedYears);
  return round2((num(a.cost) * (num(a.vatInitialRecoveryPct) / 100) * remaining) / period);
}

export const assetDisposalService = {
  /**
   * What a SALE invoice needs of the asset it sells, resolved before the
   * invoice posts: the account its revenue line credits (the disposal
   * gain/loss, never SALES) and whether the sale may carry VAT at all.
   * Called by `invoices.approvable` inside the approval transaction.
   */
  async saleInvoicePlan(assetId: number, invoiceVat: number): Promise<DisposalPlan> {
    const { asset, category, figures } = await load(assetId);
    if (asset.status !== "in_service") {
      throw new BusinessRuleError(409, { code: "asset_not_in_service", error: `${asset.assetNumber} is ${asset.status}; only an asset in service is sold. A disposed asset is history.`, field: "disposesAssetId" });
    }
    const accounts = await assetsRepository.accountsByIds([category.costAccountId, category.accumulatedDepreciationAccountId]);
    const cost = accounts.find((a) => a.id === category.costAccountId);
    const [disposalAccount] = await assetsRepository.systemAccount("ASSET_DISPOSAL_GAIN_LOSS");
    if (!cost || !disposalAccount) throw new BusinessRuleError(422, { code: "asset_disposal_account_missing", error: "This company's chart is missing the asset cost or the disposal gain/loss account.", field: "categoryId" });
    // VAT IR Art. 50(3): a restricted motor vehicle bought without deduction is sold OUTSIDE the economic activity.
    const restrictedVehicle = num(asset.vatInitialRecoveryPct) === 0 && !!asset.vatNonDeductibleReason;
    if (restrictedVehicle && invoiceVat > 0.005) {
      throw new BusinessRuleError(422, {
        code: "restricted_vehicle_sale_out_of_scope",
        error: `${asset.assetNumber} was bought without deducting its input tax (${asset.vatNonDeductibleReason}). Its sale is not in the course of an economic activity (VAT IR Art. 50(3)), so the invoice carries NO VAT. Issue it at ${fmt(0)} VAT, or correct the asset's VAT facts if the deduction was in fact taken.`,
        field: "vatAmount",
      });
    }
    return {
      asset, accumulated: figures.accumulatedDepreciation, carrying: figures.carryingAmount,
      costAccountId: cost.id, costAccountName: cost.name,
      accumulatedAccountId: category.accumulatedDepreciationAccountId,
      disposalAccountId: disposalAccount.id, disposalAccountName: disposalAccount.name,
      restrictedVehicle,
    };
  },

  /**
   * The derecognition LINES for an asset, to be appended to the entry the
   * caller is already posting (the sale invoice's own entry), or posted alone
   * (a scrap). Never a second entry for the same act.
   */
  derecognitionLines(plan: Pick<DisposalPlan, "asset" | "accumulated" | "carrying" | "costAccountId" | "costAccountName" | "accumulatedAccountId" | "disposalAccountId" | "disposalAccountName">): GLLine[] {
    const lines: GLLine[] = [];
    if (plan.accumulated > 0.005) lines.push({ accountId: plan.accumulatedAccountId, accountName: "Accumulated depreciation", description: `Derecognition of ${plan.asset.assetNumber}`, debitAmount: plan.accumulated, creditAmount: 0 });
    if (plan.carrying > 0.005) lines.push({ accountId: plan.disposalAccountId, accountName: plan.disposalAccountName, description: `Carrying amount of ${plan.asset.assetNumber} on disposal`, debitAmount: plan.carrying, creditAmount: 0 });
    lines.push({ accountId: plan.costAccountId, accountName: plan.costAccountName, description: `Cost of ${plan.asset.assetNumber} removed on disposal`, debitAmount: 0, creditAmount: round2(num(plan.asset.cost)) });
    return lines;
  },

  /** Depreciate every outstanding period up to and including the disposal month (IAS 16.55). */
  async runDepreciationToDisposal(assetId: number, disposalDate: string, userId: number | null) {
    const upTo = periodOf(disposalDate);
    const schedule = await assetsRepository.schedule(assetId);
    const due = schedule.filter((s) => s.journalEntryId == null && s.period <= upTo);
    const posted: Array<{ period: string; amount: number; journalEntryId: number }> = [];
    for (const row of due) {
      const out = await assetCapitalisationService.depreciate(assetId, { period: row.period }, userId);
      posted.push({ period: out.period, amount: out.amount, journalEntryId: out.journalEntryId });
    }
    return posted;
  },

  /** Write the disposal record and close the asset. Shared by both doors. */
  async recordDisposal(input: {
    assetId: number; date: string; kind: AssetDisposalKind; proceeds: number; invoiceId: number | null;
    accumulated: number; carrying: number; vatTreatment: string; nominalSupplyValue: number | null; reason: string | null;
    journalEntryId: number; userId: number | null;
  }) {
    const gainLoss = round2(input.proceeds - input.carrying);
    const [row] = await db.insert(assetDisposalsTable).values({
      assetId: input.assetId, date: input.date, kind: input.kind, proceeds: money2(input.proceeds), invoiceId: input.invoiceId,
      accumulatedAtDisposal: money2(input.accumulated), carryingAmountAtDisposal: money2(input.carrying), gainLoss: money2(gainLoss),
      vatTreatment: input.vatTreatment, nominalSupplyValue: input.nominalSupplyValue != null ? money2(input.nominalSupplyValue) : null,
      reason: input.reason, journalEntryId: input.journalEntryId, createdBy: input.userId,
    }).returning();
    await assetsRepository.update(input.assetId, { status: "disposed", disposalDate: input.date });
    // the unposted tail is gone: nothing is depreciated after derecognition (IAS 16.55)
    await assetsRepository.deletePlannedRows(input.assetId);
    await recordAssetEvent(input.assetId, "disposed", input.date, {
      kind: input.kind, proceeds: input.proceeds, accumulated: input.accumulated, carrying: input.carrying, gainLoss,
      vatTreatment: input.vatTreatment, nominalSupplyValue: input.nominalSupplyValue, reason: input.reason, invoiceId: input.invoiceId,
    }, { journalEntryId: input.journalEntryId, userId: input.userId });
    return { ...row!, gainLossNumber: gainLoss };
  },

  /**
   * The SALE's derecognition, on the invoice's own entry. Called by
   * `invoices.approvable` after it posts, inside the same transaction.
   */
  async completeSale(plan: DisposalPlan, invoice: { id: number; date: string; invoiceNumber: string; subtotal: string | number }, journalEntryId: number, userId: number | null) {
    const proceeds = round2(num(invoice.subtotal));
    const disposal = await this.recordDisposal({
      assetId: plan.asset.id, date: invoice.date, kind: "sold", proceeds, invoiceId: invoice.id,
      accumulated: plan.accumulated, carrying: plan.carrying,
      vatTreatment: plan.restrictedVehicle ? "out_of_scope_restricted_vehicle" : "taxable_supply",
      nominalSupplyValue: null, reason: `Sold on ${invoice.invoiceNumber}`,
      journalEntryId, userId,
    });
    await auditService.created("asset_disposal", disposal.id, { ...disposal, by: userId });
    return disposal;
  },

  /**
   * SCRAP / DESTROYED / STOLEN / WITHDRAWN — no proceeds, no invoice: the
   * derecognition alone, on its own entry.
   */
  async dispose(assetId: number, body: { date?: unknown; kind?: unknown; reason?: unknown }, userId: number | null) {
    const kind = typeof body.kind === "string" ? body.kind : "";
    if (!KINDS.includes(kind)) throw new BadRequestError("kind must be scrapped, destroyed, stolen or withdrawn (a SALE is an invoice that names the asset, not this act).");
    if (kind === "sold") {
      throw new BusinessRuleError(422, { code: "sale_is_an_invoice", error: "A sale is a tax invoice that names the asset (Invoices → New invoice → this asset), so the supply and its VAT are documented. This act is for an asset that leaves with no proceeds.", field: "kind" });
    }
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    if (!reason) throw new BadRequestError("A reason is required — it is the disposal's evidence (VAT IR Art. 66 records).");
    const date = body.date ? assertDateString(body.date, "date") : undefined;
    if (!date) throw new BadRequestError("date is required (YYYY-MM-DD).");
    const { asset, category, figures } = await load(assetId);
    if (asset.status !== "in_service") throw new BusinessRuleError(409, { code: "asset_not_in_service", error: `${asset.assetNumber} is ${asset.status}; only an asset in service is disposed of.`, field: "id" });
    if (date < asset.availableForUseDate!) throw new BusinessRuleError(422, { code: "disposal_before_in_service", error: `${asset.assetNumber} cannot be disposed of on ${date}, before it was available for use (${asset.availableForUseDate}).`, field: "date" });
    await checkPeriodOpen(date);
    // IAS 16.55 — depreciate up to the disposal month first (its own entries, its own locks)
    const depreciated = await this.runDepreciationToDisposal(assetId, date, userId);
    const after = await load(assetId);
    const accounts = await assetsRepository.accountsByIds([category.costAccountId]);
    const cost = accounts[0]!;
    const [disposalAccount] = await assetsRepository.systemAccount("ASSET_DISPOSAL_GAIN_LOSS");
    if (!disposalAccount) throw new BusinessRuleError(422, { code: "asset_disposal_account_missing", error: "This company's chart is missing the disposal gain/loss account.", field: "categoryId" });
    const plan = {
      asset: after.asset, accumulated: after.figures.accumulatedDepreciation, carrying: after.figures.carryingAmount,
      costAccountId: cost.id, costAccountName: cost.name, accumulatedAccountId: category.accumulatedDepreciationAccountId,
      disposalAccountId: disposalAccount.id, disposalAccountName: disposalAccount.name,
    };
    const je = await postJournalEntry({
      entryNumber: `DISP-${asset.assetNumber}`,
      date,
      description: `Disposal (${kind}) of ${asset.assetNumber} ${asset.name} — ${reason}`,
      reference: asset.assetNumber,
      lines: this.derecognitionLines(plan),
    });
    // Art. 52(7) vs 52(8): destroyed/stolen/scrapped attract NO adjustment; a withdrawal while still usable is a nominal supply.
    const withdrawn = kind === "withdrawn";
    const nominal = withdrawn ? nominalSupplyValue(after.asset, date) : null;
    const disposal = await this.recordDisposal({
      assetId, date, kind: kind as AssetDisposalKind, proceeds: 0, invoiceId: null,
      accumulated: plan.accumulated, carrying: plan.carrying,
      vatTreatment: withdrawn ? "nominal_supply" : "no_adjustment",
      nominalSupplyValue: nominal, reason, journalEntryId: je.id, userId,
    });
    await auditService.created("asset_disposal", disposal.id, { ...disposal, by: userId });
    const asset2 = await assetsService.getById(assetId);
    return {
      asset: asset2,
      disposal: {
        id: disposal.id, date, kind, proceeds: 0, gainLoss: disposal.gainLossNumber,
        accumulatedAtDisposal: plan.accumulated, carryingAmountAtDisposal: plan.carrying,
        vatTreatment: withdrawn ? "nominal_supply" : "no_adjustment", nominalSupplyValue: nominal,
        journalEntryId: je.id, entryNumber: je.entryNumber, invoiceId: null, reason,
      },
      depreciatedFirst: depreciated,
    };
  },

};
