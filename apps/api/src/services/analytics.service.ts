/**
 * Analytics — the trend read model (M19.1, design-analytics.md §6).
 *
 * The Finance Hub owns the point-in-time claim ("can you pay what you owe
 * NOW"); Analytics owns the trend ("has that been getting better or worse").
 * Same figures, different question (design §3).
 *
 * ── 🔴 The two things this file exists to get right ────────────────────────
 *
 * 1. **A SINGLE PASS.** One pre-aggregated query, folded forward. Never a loop
 *    over `balanceSheet(as_of)` — that re-reads from the beginning of time per
 *    point and is quadratic in history (4,612ms for 12 points over 6,000 lines).
 *
 * 2. **PER-POINT `claimable`.** M18.3 withholds the liquidity claim when it
 *    cannot be stood behind. Analytics must not chart over time what the hub
 *    refuses to state today — otherwise the discipline is defeated by DRAWING
 *    it instead of SAYING it. But a blocker is a fact about a MOMENT: last March
 *    may have been perfectly clean while today is not. So each point is judged
 *    on its own balances, and an unclaimable point breaks the line rather than
 *    being silently omitted or drawn as an ordinary segment.
 *
 *    🔴 This is the thing a restructuring loses. The blockers are computed from
 *    the SAME folded balances as the ratios, in the same function, so a point's
 *    numbers and its trustworthiness cannot come apart.
 */
import { analyticsRepository } from "../repositories/analytics.repository";

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Everything but `non_current` is current; `cash` + `quick` are quick. */
const isCurrent = (c: string | null) => c === "cash" || c === "quick" || c === "current";
const isQuick = (c: string | null) => c === "cash" || c === "quick";

export interface TrendPoint {
  /** `YYYY-MM` — the month this position is as at the END of. */
  period: string;
  currentAssets: number;
  quickAssets: number;
  currentLiabilities: number;
  workingCapital: number;
  /** NULL when there are no current liabilities — undefined, not zero (M18.3). */
  currentRatio: number | null;
  quickRatio: number | null;
  /** Solvency (design §6.3) — NULL when equity is zero or negative. */
  debtToEquity: number | null;
  netWorth: number;
  /** 🔴 False ⇒ this point must not be drawn as an ordinary segment. */
  claimable: boolean;
  blockers: Array<{ code: "suspense_balance" | "unclassified_accounts"; amount: number; count?: number }>;
}

/** A running balance per account, plus the classification needed to bucket it. */
interface AccountState {
  type: string | null;
  liquidityClass: string | null;
  systemCode: string | null;
  /** Debits less credits. Natural for assets/expenses; negate for the rest. */
  net: number;
}

/** The `YYYY-MM` labels from `from` to `to` inclusive. */
function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.split("-").map(Number);
  const [ey, em] = to.split("-").map(Number);
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

/** Last day of a `YYYY-MM`, as `YYYY-MM-DD`. */
function endOfMonth(period: string): string {
  const [y, m] = period.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/**
 * Snapshot the folded balances into one point.
 *
 * Kept as one function precisely so the ratios and the blockers are derived
 * from the same state — see the note at the top about what a rewrite loses.
 */
function snapshot(period: string, accounts: Map<number | string, AccountState>): TrendPoint {
  let currentAssets = 0;
  let quickAssets = 0;
  let currentLiabilities = 0;
  let totalAssets = 0;
  let totalLiabilities = 0;
  let equityAccounts = 0;
  let retainedEarnings = 0;
  let suspense = 0;
  let unclassifiedAmount = 0;
  let unclassifiedCount = 0;

  for (const a of accounts.values()) {
    if (Math.abs(a.net) < 0.005 && a.type !== "asset" && a.type !== "liability") continue;

    if (a.type === "asset") {
      const bal = a.net; // debit-natural
      totalAssets += bal;
      if (a.systemCode === "SUSPENSE") suspense += bal;
      if (a.liquidityClass == null) {
        if (Math.abs(bal) >= 0.005) {
          unclassifiedAmount += bal;
          unclassifiedCount += 1;
        }
      } else {
        if (isCurrent(a.liquidityClass)) currentAssets += bal;
        if (isQuick(a.liquidityClass)) quickAssets += bal;
      }
    } else if (a.type === "liability") {
      const bal = -a.net; // credit-natural
      totalLiabilities += bal;
      if (a.liquidityClass == null) {
        if (Math.abs(bal) >= 0.005) {
          unclassifiedAmount += bal;
          unclassifiedCount += 1;
        }
      } else if (isCurrent(a.liquidityClass)) {
        currentLiabilities += bal;
      }
    } else if (a.type === "equity") {
      equityAccounts += -a.net;
    } else if (a.type === "income" || a.type === "revenue") {
      retainedEarnings += -a.net;
    } else if (a.type === "expense") {
      retainedEarnings -= a.net;
    }
    // A line whose account never resolved (type null) contributes to nothing —
    // the same silence `reports.balanceSheet` gives it.
  }

  const totalEquity = equityAccounts + retainedEarnings;
  const ratio = (n: number) => (currentLiabilities > 0 ? round2(n / currentLiabilities) : null);

  const blockers: TrendPoint["blockers"] = [];
  if (Math.abs(suspense) >= 0.01) {
    blockers.push({ code: "suspense_balance", amount: round2(suspense) });
  }
  if (unclassifiedCount > 0) {
    blockers.push({
      code: "unclassified_accounts",
      amount: round2(unclassifiedAmount),
      count: unclassifiedCount,
    });
  }

  return {
    period,
    currentAssets: round2(currentAssets),
    quickAssets: round2(quickAssets),
    currentLiabilities: round2(currentLiabilities),
    workingCapital: round2(currentAssets - currentLiabilities),
    currentRatio: ratio(currentAssets),
    quickRatio: ratio(quickAssets),
    // Same null discipline as the ratios: negative or zero equity is real, and
    // the ratio is undefined rather than catastrophic.
    debtToEquity: totalEquity > 0 ? round2(totalLiabilities / totalEquity) : null,
    netWorth: round2(totalAssets - totalLiabilities),
    claimable: blockers.length === 0,
    blockers,
  };
}

export const analyticsService = {
  /**
   * The liquidity and solvency trend, one point per month end.
   *
   * `from`/`to` are `YYYY-MM`. Months with no movement still produce a point —
   * a balance persists whether or not anything happened, and a gap in the x
   * axis would misread as "no data" when it means "nothing changed".
   */
  async trend(from: string, to: string): Promise<TrendPoint[]> {
    const periods = monthsBetween(from, to);
    if (periods.length === 0) return [];

    const rows = await analyticsRepository.monthlyMovements(endOfMonth(periods[periods.length - 1]!));

    // Movements grouped by month, so the fold walks each month once.
    const byMonth = new Map<string, typeof rows>();
    for (const r of rows) {
      const list = byMonth.get(r.month);
      if (list) list.push(r);
      else byMonth.set(r.month, [r]);
    }

    // 🔴 Every month from the FIRST movement, not from `from` — the opening
    // position of the first charted month is everything that happened before it.
    const earliest = rows.length > 0 ? rows[0]!.month : periods[0]!;
    const walk = monthsBetween(
      earliest < periods[0]! ? earliest : periods[0]!,
      periods[periods.length - 1]!,
    );

    const accounts = new Map<number | string, AccountState>();
    const wanted = new Set(periods);
    const out: TrendPoint[] = [];

    for (const month of walk) {
      for (const r of byMonth.get(month) ?? []) {
        const key = r.accountId ?? `unresolved:${r.systemCode ?? month}`;
        const state = accounts.get(key) ?? {
          type: r.type,
          liquidityClass: r.liquidityClass,
          systemCode: r.systemCode,
          net: 0,
        };
        state.net += Number(r.debit) - Number(r.credit);
        accounts.set(key, state);
      }
      if (wanted.has(month)) out.push(snapshot(month, accounts));
    }

    return out;
  },
};
