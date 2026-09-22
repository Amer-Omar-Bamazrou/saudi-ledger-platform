/**
 * FA-G (2026-09-22) — the fixed-asset reports, and the reconciliation that is
 * the point of them.
 *
 * Record: docs/product/fixed-assets-decision-pack.md §11, §26.
 *
 * 🔴 THE RECONCILIATION IS THE FORCING FUNCTION THE OLD REGISTER LACKED. Before
 * FA-A the register held a cost and a book value beside the rows that produced
 * them — two value spaces with nothing joining them — and its depreciation never
 * reached the GL at all. FA-A removed the stored figures; this report removes
 * the remaining way the two could drift unnoticed, by asking the question out
 * loud and per category:
 *
 *   FA_COST        Σ cost of the assets IN SERVICE  = the cost account
 *   FA_ACCUMULATED Σ accumulated of those assets    = the accumulated account
 *   FA_EXPENSE     Σ posted schedule rows, all time = the expense account
 *
 * 🔴 The GL side is the WHOLE account, not the lines the register produced. The
 * categorizer can map a bank transaction straight onto a fixed-asset account,
 * and a difference arriving from outside the register is exactly what this
 * report exists to surface — netting it out would make the control pass while
 * the books disagreed. A difference is reported with BOTH figures and their
 * gap, never as a bare verdict.
 *
 * 🔴 The status palette is not used for a judgement (CLAUDE.md §4): a control
 * either RECONCILES or it does not, which is a state, and the difference is a
 * number the reader can chase.
 */
import { assetsRepository } from "../../repositories/assets.repository.js";
import { companiesRepository } from "../../repositories/companies.repository.js";
import { NotFoundError } from "../../lib/errors.js";
import { round2 } from "../../lib/money.js";
import { businessToday } from "@workspace/shared";

/** Money agrees to the halala; anything larger is a difference worth a reader's time. */
const TOLERANCE = 0.005;

export interface AssetControl {
  id: string;
  title: string;
  status: "pass" | "fail";
  categoryName: string;
  register: number;
  ledger: number;
  difference: number;
  detail: string;
}

export const assetReportsService = {
  /**
   * The roll-forward (IAS 16.73(e)), the additions and disposals behind it, and
   * the register-to-GL reconciliation, for one window.
   *
   * The window defaults to the current year to date in the business calendar —
   * `Asia/Riyadh` through `businessToday()`, never the server's own midnight.
   */
  async report(opts: { from?: string; to?: string } = {}) {
    const company = await companiesRepository.findActive();
    if (!company) throw new NotFoundError("No company is configured for this organization.");
    const today = businessToday();
    const to = opts.to ?? today;
    const from = opts.from ?? `${to.slice(0, 4)}-01-01`;

    const [movement, recon, lists] = await Promise.all([
      assetsRepository.movementByCategory(from, to),
      assetsRepository.reconciliationByCategory(),
      assetsRepository.additionsAndDisposals(from, to),
    ]);

    const controls: AssetControl[] = [];
    for (const r of recon) {
      const add = (id: string, title: string, register: number, ledger: number, what: string, account: string) => {
        const difference = round2(register - ledger);
        controls.push({
          id, title, categoryName: r.categoryName, register: round2(register), ledger: round2(ledger), difference,
          status: Math.abs(difference) <= TOLERANCE ? "pass" : "fail",
          detail: Math.abs(difference) <= TOLERANCE
            ? `${what} agrees with “${account}”.`
            // 🔴 The message names BOTH figures and the account, because the
            // reader's next act is to open that account — a bare "does not
            // reconcile" sends them looking for the number itself.
            : `${what} is ${register.toFixed(2)} in the register and ${ledger.toFixed(2)} on “${account}” — a difference of ${difference.toFixed(2)}. A fixed-asset account can also be posted to from outside the register (a bank transaction coded straight to it), and that is the first place to look.`,
        });
      };
      add("FA_COST", "The cost of the assets in service is the cost account's balance", r.registerCost, r.glCost, "The cost of the assets in service", r.costAccount);
      add("FA_ACCUMULATED", "The accumulated depreciation of those assets is the accumulated account's balance", r.registerAccumulated, r.glAccumulated, "Accumulated depreciation", r.accumulatedAccount);
      add("FA_EXPENSE", "Every posted schedule row reached the depreciation expense account", r.registerCharge, r.glExpense, "The depreciation posted from the register", r.expenseAccount);
    }

    const sum = (ns: number[]) => round2(ns.reduce((a, b) => a + b, 0));
    return {
      companyId: company.id,
      companyName: company.name,
      from,
      to,
      movement: movement.map((m) => ({
        ...m,
        openingNetBookValue: round2(m.openingCost - m.openingAccumulated),
        closingNetBookValue: round2(m.closingCost - m.closingAccumulated),
      })),
      totals: {
        openingCost: sum(movement.map((m) => m.openingCost)),
        additions: sum(movement.map((m) => m.additions)),
        disposalsCost: sum(movement.map((m) => m.disposalsCost)),
        closingCost: sum(movement.map((m) => m.closingCost)),
        openingAccumulated: sum(movement.map((m) => m.openingAccumulated)),
        charge: sum(movement.map((m) => m.charge)),
        disposalsAccumulated: sum(movement.map((m) => m.disposalsAccumulated)),
        closingAccumulated: sum(movement.map((m) => m.closingAccumulated)),
        closingNetBookValue: round2(sum(movement.map((m) => m.closingCost)) - sum(movement.map((m) => m.closingAccumulated))),
      },
      additions: lists.additions,
      disposals: lists.disposals,
      /** The gain or loss the disposals of the window produced (IAS 16.71) — never revenue. */
      disposalGainLoss: sum(lists.disposals.map((d) => d.gainLoss)),
      controls,
      reconciles: controls.every((c) => c.status === "pass"),
      /**
       * 🔴 Zakat reads the BOOK figures (Zakat Regulations Art. 48(1)(b), 49,
       * 63(2)) — the same closing net book value above, per category. It is
       * stated here rather than recomputed anywhere else, so the Zakat working
       * paper and this report cannot disagree about "net fixed assets".
       */
      zakatNetFixedAssets: movement.map((m) => ({ categoryName: m.categoryName, netBookValue: round2(m.closingCost - m.closingAccumulated) })),
    };
  },
};
