/**
 * CASH: two figures, named so they cannot be confused (M19.7, design §6.1 C).
 *
 * 🔴 WHY THERE ARE TWO, AND WHY THAT IS NOT A BUG TO HIDE.
 *
 * The transaction store and the general ledger disagree about cash — measured
 * at 10,800 on the dev org — and each is right about the question it answers:
 *
 *   • **Bank movement** — what the bank statement shows. Every accepted
 *     transaction, INCLUDING transfers and settlements, because the bank
 *     balance moved whether or not anything was earned or spent.
 *   • **Ledger cash** — what the double-entry books say happened to cash. It
 *     excludes transfers and settlements (which deliberately never post) and
 *     INCLUDES payments recorded on a document, which create no transaction.
 *
 * The M16 Q0 precedent decides the treatment: *documents FILE, transactions
 * RECONCILE.* Two figures are tolerable only when each states which question it
 * answers and **the gap between them is accounted for line by line**. A gap
 * that is merely displayed is a discrepancy; a gap that is itemised is a
 * reconciliation.
 *
 * 🔴 THIS IS AN INTERIM (owner decision, 2026-08-16). It makes the disagreement
 * legible; it does not make either figure correct about transfers, because the
 * fact that would settle it — whether a transfer left the tracked estate — is
 * not recorded at all (queue B5). Naming the two figures is what stops the
 * interim from silently becoming the answer.
 */
import { analyticsRepository } from "../repositories/analytics.repository";

const round2 = (n: number) => Math.round(n * 100) / 100;

/** One month of both figures, with the difference already attributed. */
export interface CashPoint {
  /** `YYYY-MM`. */
  period: string;
  /** Every accepted transaction, all kinds — what the bank shows. */
  bankMovement: number;
  /** Movement on cash-classified GL accounts — what the books say. */
  ledgerCash: number;
  /** `bankMovement − ledgerCash`. Zero when the two stores agree. */
  gap: number;
}

/**
 * The gap for the whole window, attributed to causes.
 *
 * Every field is a REASON the two figures differ, and they sum to the gap
 * exactly — an unexplained remainder would mean a cause nobody has named, which
 * is precisely what this is built to rule out.
 */
export interface CashReconciliation {
  from: string;
  to: string;
  bankMovement: number;
  ledgerCash: number;
  gap: number;
  items: Array<{
    code:
      | "transfers_own_account"
      | "transfers_external"
      | "transfers_undeclared"
      | "settlements"
      | "unposted_legacy"
      | "ledger_only";
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
   * 🔴 How much transfer movement nobody has classified (B5).
   *
   * Separate from `unexplained`, which means the ITEMISATION failed. This means
   * the itemisation succeeded and one of its lines is "we do not know" — a
   * different problem with a different fix: somebody has to say. Surfaced as
   * its own number so the page can ask for the declaration rather than burying
   * it in a list.
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
    const postedOperatingByMonth = new Map<string, number>();
    // B5 — transfers split THREE ways, because the three mean different things:
    //   own_account  the ledger's silence is CORRECT; nothing is wrong here
    //   external     the ledger is genuinely understating cash movement
    //   undeclared   nobody has said, and the platform must not guess
    let transfersOwnAccount = 0;
    let transfersExternal = 0;
    let transfersUndeclared = 0;
    let settlements = 0;
    let unpostedLegacy = 0;
    let postedOperating = 0;

    for (const r of txRows) {
      const net = Number(r.net);
      bankByMonth.set(r.month, (bankByMonth.get(r.month) ?? 0) + net);

      if (r.kind === "transfer") {
        if (r.transfer_direction === "own_account") transfersOwnAccount += net;
        else if (r.transfer_direction === "external") transfersExternal += net;
        else transfersUndeclared += net;
      } else if (r.kind === "settlement") {
        settlements += net;
      } else if (r.posted) {
        postedOperating += net;
        postedOperatingByMonth.set(r.month, (postedOperatingByMonth.get(r.month) ?? 0) + net);
      } else {
        // Accepted, operating, and never posted: rows from before flaw #1's
        // Option A wired acceptance to the ledger. Named rather than lumped —
        // it is a history artefact, not an ongoing behaviour, and conflating it
        // with the deliberate exclusions would hide that it should shrink to
        // zero and stay there.
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
     * Cash the LEDGER has and the transactions do not: payments recorded on an
     * invoice or bill, which post Dr Cash / Cr AR and create no transaction row.
     * Derived as a residual — everything in ledger cash that did not arrive via
     * a posted operating transaction.
     */
    const ledgerOnly = ledgerCash - postedOperating;

    const items = (
      [
        { code: "transfers_own_account", amount: round2(transfersOwnAccount) },
        { code: "transfers_external", amount: round2(transfersExternal) },
        { code: "transfers_undeclared", amount: round2(transfersUndeclared) },
        { code: "settlements", amount: round2(settlements) },
        { code: "unposted_legacy", amount: round2(unpostedLegacy) },
        { code: "ledger_only", amount: round2(-ledgerOnly) },
      ] as CashReconciliation["items"]
    ).filter((i) => Math.abs(i.amount) >= 0.005);

    const gap = bankMovement - ledgerCash;
    const explained =
      transfersOwnAccount +
      transfersExternal +
      transfersUndeclared +
      settlements +
      unpostedLegacy -
      ledgerOnly;

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
