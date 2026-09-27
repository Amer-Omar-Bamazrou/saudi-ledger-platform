/**
 * B5 (Phase 11 Part 2, 2026-09-22) — THE SUPPLIER STATEMENT AND ITS
 * RECONCILIATION. Record: docs/product/phase-11-deep-accounting-ap-decision-pack.md §14.
 *
 * A statement answers two questions that are not the same question:
 *
 *   1. WHAT IS THE POSITION — four non-negative components and a derived net
 *      (`supplierStatement.repository`, which is the one definition).
 *   2. HOW DID IT GET THERE — every event that moved a component, in
 *      chronology, each carrying a RUNNING balance so a reader can put their
 *      finger on the line where our figure and the supplier's diverge. That
 *      line is the whole purpose of a supplier reconciliation.
 *
 * 🔴 THE CLOSING RUNNING BALANCE IS CHECKED AGAINST THE POSITION, and the
 * check is REPORTED rather than assumed. Two computations of one fact — the
 * event stream and the grouped position query — have no forcing function
 * between them, so they are compared on every read and a difference is shown
 * with BOTH figures. A statement that silently disagrees with the ledger is
 * worse than no statement: it is a reconciliation tool that hides the thing it
 * exists to find.
 */
import { eq } from "drizzle-orm";
import { db, vendorsTable } from "@workspace/db";
import { BusinessRuleError, NotFoundError } from "../../lib/errors.js";
import { round2 } from "../../lib/money.js";
import { supplierStatementRepository, type SupplierPositionRow } from "../../repositories/supplierStatement.repository.js";

/** The net a position implies — DERIVED here and nowhere else. */
export function netOf(p: SupplierPositionRow): number {
  return round2(p.payable - p.creditBalance - p.advanceBalance - p.depositBalance - p.unidentifiedBalance);
}

const withNet = (p: SupplierPositionRow) => ({
  ...p,
  payable: round2(p.payable),
  creditBalance: round2(p.creditBalance),
  advanceBalance: round2(p.advanceBalance),
  depositBalance: round2(p.depositBalance),
  unidentifiedBalance: round2(p.unidentifiedBalance),
  netPosition: netOf(p),
});

export const supplierStatementService = {
  /** Every supplier with any activity, with its position. */
  async positions(vendorId?: number) {
    const rows = await supplierStatementRepository.positions(vendorId != null ? { vendorId } : {});
    return { items: rows.map(withNet) };
  },

  /**
   * A supplier statement for a WINDOW: the balance brought forward at the
   * start (`opening`), the events inside it, and the balance carried at the
   * end (`closing`).
   *
   * 🔴 DETERMINISTIC BY CONSTRUCTION. The window is on BUSINESS dates, both
   * ends inclusive, and the running balances are computed over the WHOLE
   * stream in its one fixed order (date, recorded time, kind rank, id) before
   * the window is cut — so the opening of a window is exactly the closing of
   * the window before it, and the same request returns the same figures
   * however the rows were typed. A back-dated event moves the opening of every
   * later window, which is what "the books as dated" means.
   *
   * The self-check (event stream vs position) is always over the whole
   * stream, because the position is "now"; the window never hides a
   * disagreement.
   */
  async statement(vendorId: number, window: { from?: string; to?: string } = {}) {
    const [vendor] = await db.select().from(vendorsTable).where(eq(vendorsTable.id, vendorId)).limit(1);
    if (!vendor) throw new NotFoundError("Supplier not found.");
    const from = window.from || null;
    const to = window.to || null;
    for (const [field, v] of [["from", from], ["to", to]] as const) {
      if (v != null && !/^\d{4}-\d{2}-\d{2}$/.test(v)) {
        throw new BusinessRuleError(422, { code: "date_invalid", error: `\`${field}\` is a YYYY-MM-DD date.`, field });
      }
    }
    if (from && to && from > to) {
      throw new BusinessRuleError(422, { code: "window_inverted", error: `The statement window starts (${from}) after it ends (${to}).`, field: "from" });
    }

    const [position] = await supplierStatementRepository.positions({ vendorId });
    const events = await supplierStatementRepository.events(vendorId);
    const gl = await supplierStatementRepository.glBalances(vendorId);

    let payable = 0, credit = 0, onAccount = 0;
    const allLines = events.map((e) => {
      payable = round2(payable + e.payableDelta);
      credit = round2(credit + e.creditDelta);
      onAccount = round2(onAccount + e.onAccountDelta);
      return {
        ...e,
        runningPayable: payable,
        runningCredit: credit,
        runningOnAccount: onAccount,
        // What the supplier and we would each call "the balance" at this line.
        runningNet: round2(payable - credit - onAccount),
      };
    });

    const pos = position ? withNet(position) : {
      vendorId, totalBilled: 0, totalPaid: 0, billCount: 0,
      payable: 0, creditBalance: 0, advanceBalance: 0, depositBalance: 0, unidentifiedBalance: 0, netPosition: 0,
    };

    /**
     * 🔴 The two computations, compared and REPORTED. `onAccount` in the event
     * stream is the three on-account classifications together, because an
     * event's effect on "money the supplier holds" does not depend on what we
     * have decided to call it — so it is compared against their sum.
     */
    const positionOnAccount = round2(pos.advanceBalance + pos.depositBalance + pos.unidentifiedBalance);
    const difference = round2(pos.netPosition - round2(payable - credit - onAccount));

    // The window: brought forward = the running balance of the last event
    // BEFORE `from`; carried = that of the last event ON OR BEFORE `to`.
    const balanceAt = (l?: (typeof allLines)[number]) => ({
      payable: l?.runningPayable ?? 0, credit: l?.runningCredit ?? 0,
      onAccount: l?.runningOnAccount ?? 0, net: l?.runningNet ?? 0,
    });
    const before = from ? allLines.filter((l) => l.date < from) : [];
    const upTo = to ? allLines.filter((l) => l.date <= to) : allLines;
    const lines = allLines.filter((l) => (!from || l.date >= from) && (!to || l.date <= to));

    /**
     * 🔴 THE GL TIE — subledger ↔ AP control ↔ GL, reported per component.
     * `payable − credit` is what AP should carry for this supplier (a credit
     * note's debit sits in AP), and each on-account component is its own
     * asset. Reported, not asserted: pre-N3 control lines with no party
     * (RULE-P) and bills approved around the posting path (RULE-J) are not
     * attributable, and hiding a real difference behind "legacy" is the thing
     * a reconciliation must never do.
     */
    const glTie = {
      ap: { fromSubledger: round2(pos.payable - pos.creditBalance), fromGl: round2(gl.ap) },
      advances: { fromSubledger: pos.advanceBalance, fromGl: round2(gl.advances) },
      deposits: { fromSubledger: pos.depositBalance, fromGl: round2(gl.deposits) },
      unidentified: { fromSubledger: pos.unidentifiedBalance, fromGl: round2(gl.unidentified) },
    };
    const glAgrees = Object.values(glTie).every((c) => Math.abs(c.fromSubledger - c.fromGl) < 0.01);

    return {
      vendor: { id: vendor.id, name: vendor.name, nameAr: vendor.nameAr ?? null },
      window: { from, to },
      opening: balanceAt(before[before.length - 1]),
      closing: balanceAt(upTo[upTo.length - 1]),
      position: pos,
      lines,
      gl: { agrees: glAgrees, components: glTie },
      reconciliation: {
        agrees: Math.abs(difference) < 0.01,
        fromPosition: pos.netPosition,
        fromEvents: round2(payable - credit - onAccount),
        difference,
        components: {
          payable: { fromPosition: pos.payable, fromEvents: payable },
          credit: { fromPosition: pos.creditBalance, fromEvents: credit },
          onAccount: { fromPosition: positionOnAccount, fromEvents: onAccount },
        },
      },
    };
  },
};
