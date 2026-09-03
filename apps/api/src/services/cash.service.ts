/**
 * CASH: the ledger is cash; the bank statement differs for stated reasons.
 *
 * ── The framing changed with A (GL owns cash, 2026-08-17) ──────────────────
 * Under M19.7 this was "two numbers, neither authoritative": transfers never
 * posted, so ledger cash was silent about movements the bank plainly showed
 * (measured at 10,800 on the dev org). Transfers now POST — through clearing
 * (own account), external transfers (declared gone), or transfer suspense
 * (undeclared, visible, blocking the liquidity claim) — so:
 *
 *   • **Ledger cash** is the authoritative figure: movement on
 *     cash-classified GL accounts, which now sees every accepted bank row's
 *     cash leg plus every document payment.
 *   • **Bank movement** stays what the statement shows, and the difference is
 *     no longer a disagreement about transfers — it is the RECONCILIATION:
 *     each remaining item is a stated, deliberate reason the two views differ.
 *
 * The M16 Q0 discipline is unchanged: the gap is itemised line by line and
 * `unexplained` is returned, not asserted, so the page can say a
 * reconciliation FAILED rather than present a tidy list that does not add up.
 */
import { analyticsRepository } from "../repositories/analytics.repository";
import { round2 } from "../lib/money";


/** One month of both figures, with the difference already attributed. */
export interface CashPoint {
  /** `YYYY-MM`. */
  period: string;
  /** Every accepted transaction, all kinds — what the bank shows. */
  bankMovement: number;
  /** Movement on cash-classified GL accounts — the authoritative figure. */
  ledgerCash: number;
  /** `bankMovement − ledgerCash`. */
  gap: number;
}

/**
 * The gap for the whole window, attributed to causes. After A the causes are:
 *
 *   settlements     Deliberate: a settlement row's cash effect is posted by
 *                   the PAY path (one writer per effect), so the bank row
 *                   itself never posts.
 *   unposted_legacy Accepted rows that never posted — locked-period skips
 *                   and pre-backfill history. Should shrink to zero and stay.
 *   ledger_only     Cash the LEDGER has that no bank row shows: document
 *                   payments recorded with no matching statement line.
 */
export interface CashReconciliation {
  from: string;
  to: string;
  bankMovement: number;
  ledgerCash: number;
  gap: number;
  items: Array<{
    code: "settlements" | "unposted_legacy" | "ledger_only";
    amount: number;
  }>;
  /**
   * 🔴 Must be 0. Non-zero means the itemisation is incomplete — a difference
   * exists that no named cause accounts for. Returned rather than asserted so
   * the UI can say so instead of quietly presenting a reconciliation that does
   * not reconcile.
   */
  unexplained: number;
  /**
   * 🔴 Transfer movement nobody has classified (B5). No longer a GAP
   * component — an undeclared transfer POSTS, into Transfer suspense — but
   * still a question only the tenant can answer, surfaced so the page can ask
   * for the declaration. It is the same money the Finance Hub's liquidity
   * claim is withheld over.
   */
  undeclaredTransfers: number;
}

export const cashService = {
  /**
   * Both cash figures per month, and the itemised reason they differ.
   *
   * `from`/`to` are `YYYY-MM`.
   */
  async reconciliation(from: string, to: string, periods: string[]): Promise<{
    points: CashPoint[];
    summary: CashReconciliation;
  }> {
    const fromDate = `${from}-01`;
    const [ty, tm] = to.split("-").map(Number);
    const toDate = new Date(Date.UTC(ty!, tm!, 0)).toISOString().slice(0, 10);

    const [txRows, glRows] = await Promise.all([
      analyticsRepository.monthlyTransactionCash(fromDate, toDate),
      analyticsRepository.monthlyLedgerCash(fromDate, toDate),
    ]);

    const bankByMonth = new Map<string, number>();
    let settlements = 0;
    let unpostedLegacy = 0;
    let postedCash = 0;
    let transfersUndeclared = 0;

    for (const r of txRows) {
      const net = Number(r.net);
      bankByMonth.set(r.month, (bankByMonth.get(r.month) ?? 0) + net);

      // The ASK is orthogonal to the gap now: an undeclared transfer posts
      // (into Transfer suspense), so it appears in postedCash below — but it
      // is still a question only the tenant can answer.
      if (r.kind === "transfer" && !r.transfer_direction) transfersUndeclared += net;

      if (r.kind === "settlement") {
        settlements += net;
      } else if (r.posted) {
        postedCash += net;
      } else {
        // Accepted, postable (operating or transfer), and never posted:
        // locked-period skips and pre-backfill history. Named rather than
        // lumped — it should shrink to zero and stay there.
        unpostedLegacy += net;
      }
    }

    const ledgerByMonth = new Map(glRows.map((r) => [r.month, Number(r.net)]));

    const points: CashPoint[] = periods.map((period) => {
      const bank = bankByMonth.get(period) ?? 0;
      const ledger = ledgerByMonth.get(period) ?? 0;
      return {
        period,
        bankMovement: round2(bank),
        ledgerCash: round2(ledger),
        gap: round2(bank - ledger),
      };
    });

    const bankMovement = [...bankByMonth.values()].reduce((a, b) => a + b, 0);
    const ledgerCash = [...ledgerByMonth.values()].reduce((a, b) => a + b, 0);

    /**
     * Cash the LEDGER has and the bank rows do not: payments recorded on an
     * invoice or bill (Dr/Cr Cash via the pay path) with no matching statement
     * line. Derived as a residual — everything in ledger cash that did not
     * arrive via a posted transaction's cash leg.
     */
    const ledgerOnly = ledgerCash - postedCash;

    const items = (
      [
        { code: "settlements", amount: round2(settlements) },
        { code: "unposted_legacy", amount: round2(unpostedLegacy) },
        { code: "ledger_only", amount: round2(-ledgerOnly) },
      ] as CashReconciliation["items"]
    ).filter((i) => Math.abs(i.amount) >= 0.005);

    const gap = bankMovement - ledgerCash;
    const explained = settlements + unpostedLegacy - ledgerOnly;

    return {
      points,
      summary: {
        from,
        to,
        bankMovement: round2(bankMovement),
        ledgerCash: round2(ledgerCash),
        gap: round2(gap),
        items,
        unexplained: round2(gap - explained),
        undeclaredTransfers: round2(transfersUndeclared),
      },
    };
  },
};
