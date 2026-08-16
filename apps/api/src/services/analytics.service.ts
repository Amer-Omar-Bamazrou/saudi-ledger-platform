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
export function monthsBetween(from: string, to: string): string[] {
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

/**
 * One month of the RECEIVABLES BRIDGE (design §4).
 *
 * 🔴 The bridge exists because a rising AR balance does not say whether you
 * invoiced more or collected less, and those call for opposite responses. The
 * "receivables outstanding" series shows the gap as a STOCK; this shows it as a
 * FLOW. It is the WHERE-not-WHY rule applied to cash timing — it states what
 * moved, never why.
 */
export interface BridgePoint {
  /** `YYYY-MM`. */
  period: string;
  /** Receivables at the START of the month. */
  opening: number;
  /** Debits to AR — invoices AND debit notes (a debit note does not reverse). */
  invoiced: number;
  /** Credits to AR settled in cash. */
  collected: number;
  /** Credits to AR that reversed revenue — credit notes. */
  credited: number;
  /**
   * Credits to AR that were neither. A write-off or an offset is not a payment
   * and not a credit note; reporting it separately is the difference between a
   * bridge that understands the movement and one that mislabels it. Normally 0.
   */
  other: number;
  /** Receivables at the END of the month. Equals the balance-sheet AR figure. */
  closing: number;
}

export type Dimension = "category" | "customer" | "vendor";

export interface Contributor {
  id: string;
  name: string;
  nameAr: string;
  current: number;
  prior: number;
  change: number;
  /**
   * This contributor's share of the NET change, 0–1.
   *
   * 🔴 NULL when the net change is ~zero. That is not an edge case to tidy
   * away — offsetting movements are the interesting case: one customer up
   * 50,000 and another down 50,000 is a real thing that happened, and dividing
   * by a net of zero would report each as an infinite or absurd share of
   * "nothing changed". The movers are still listed and still ranked; only the
   * SHARE is undefined, and the caller must say "these moved" rather than
   * "these caused the change".
   */
  shareOfChange: number | null;
}

export interface Decomposition {
  dimension: Dimension;
  current: { from: string; to: string; total: number };
  prior: { from: string; to: string; total: number };
  change: number;
  /** Ranked by ABSOLUTE change — the biggest movers, in either direction. */
  contributors: Contributor[];
  /**
   * How concentrated the movement is: the fewest contributors whose absolute
   * changes cover ≥80% of the total absolute movement. Answers "is this three
   * customers, or everyone a little?" without asserting a cause.
   */
  concentration: { count: number; share: number } | null;
}

/** The window of equal length immediately before [from, to]. */
function priorWindow(from: string, to: string): { from: string; to: string } {
  const MS = 86_400_000;
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  const lengthDays = Math.round((end - start) / MS) + 1;
  const priorEnd = start - MS;
  const priorStart = priorEnd - (lengthDays - 1) * MS;
  return {
    from: new Date(priorStart).toISOString().slice(0, 10),
    to: new Date(priorEnd).toISOString().slice(0, 10),
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

  /**
   * The receivables bridge, one point per month (design §4, §6.1).
   *
   *     opening + invoiced − collected − credited − other = closing
   *
   * 🔴 THE IDENTITY IS STRUCTURAL, NOT CHECKED-AND-HOPED. Every term is a debit
   * or a credit on the SAME GL account, so the arithmetic cannot drift: the
   * sums of debits and credits ARE the change in the balance, whatever the
   * credits are labelled. That is why the split is a labelling of the credit
   * side rather than a second computation from the invoice tables — five
   * numbers taken from two stores would reconcile only by luck, and an identity
   * that "usually holds" is worth nothing.
   *
   * It also means `closing` is the balance-sheet AR figure by construction, not
   * by agreement — the M13 AR-agreement pattern, obtained for free rather than
   * pinned by a test. (A test pins it anyway: free is not the same as proven.)
   *
   * Single pass, like `trend`, and for the same reason — a per-month AR balance
   * query would re-read from the beginning of time per point (M19.1).
   */
  async receivablesBridge(from: string, to: string): Promise<BridgePoint[]> {
    const periods = monthsBetween(from, to);
    if (periods.length === 0) return [];

    const rows = await analyticsRepository.monthlyReceivables(
      endOfMonth(periods[periods.length - 1]!),
    );
    const byMonth = new Map(rows.map((r) => [r.month, r]));

    // Everything before the window start is the first point's opening balance.
    // A bridge that started from zero would report the whole history as this
    // month's invoicing.
    const first = periods[0]!;
    let balance = 0;
    for (const r of rows) {
      if (r.month < first) {
        balance += Number(r.invoiced) - Number(r.collected) - Number(r.credited) - Number(r.other);
      }
    }

    const out: BridgePoint[] = [];
    for (const period of periods) {
      const r = byMonth.get(period);
      const invoiced = Number(r?.invoiced ?? 0);
      const collected = Number(r?.collected ?? 0);
      const credited = Number(r?.credited ?? 0);
      const other = Number(r?.other ?? 0);
      const opening = balance;
      balance = opening + invoiced - collected - credited - other;
      out.push({
        period,
        opening: round2(opening),
        invoiced: round2(invoiced),
        collected: round2(collected),
        credited: round2(credited),
        other: round2(other),
        closing: round2(balance),
      });
    }
    return out;
  },

  /**
   * ── M19.2: WHERE a change came from ───────────────────────────────────────
   *
   * 🔴 THE RULE (design-analytics.md §5, and hub-structure-decision.md §4):
   *
   *   > State WHERE a change came from, never WHY it happened.
   *   > Decomposition is arithmetic; causation is inference.
   *
   * So this returns ranked contributors and their arithmetic shares. It returns
   * no sentence, no cause, no recommendation, and it never says "because".
   * That is what keeps it outside the parked-AI trigger: it computes over rows
   * we already store, and a better model could not make it more correct.
   *
   * `prior` defaults to the equal-length window immediately before `from`. It
   * is derived rather than guessed at from intent — a caller wanting
   * year-over-year passes the window explicitly.
   */
  async decompose(
    dimension: Dimension,
    from: string,
    to: string,
    prior = priorWindow(from, to),
  ): Promise<Decomposition> {
    const fetch = (f: string, t: string) =>
      dimension === "category"
        ? analyticsRepository.categoryTotals(f, t)
        : dimension === "customer"
          ? analyticsRepository.customerTotals(f, t)
          : analyticsRepository.vendorTotals(f, t);

    const [currentRows, priorRows] = await Promise.all([fetch(from, to), fetch(prior.from, prior.to)]);

    /**
     * 🔴 A UNION of both windows, never an inner join. A customer who appeared
     * this period (prior 0) or disappeared (current 0) is precisely the kind of
     * mover worth reporting — joining would drop exactly the largest changes.
     */
    const merged = new Map<string, Contributor>();
    const put = (
      rows: Array<{ id: string; name: string; nameAr: string; total: string }>,
      side: "current" | "prior",
    ) => {
      for (const r of rows) {
        const c =
          merged.get(r.id) ??
          ({ id: r.id, name: r.name, nameAr: r.nameAr, current: 0, prior: 0, change: 0, shareOfChange: null } as Contributor);
        c[side] = round2(Number(r.total));
        // Keep whichever window has a name — a deleted customer still has one
        // in the older window.
        if (!c.name && r.name) c.name = r.name;
        merged.set(r.id, c);
      }
    };
    put(currentRows, "current");
    put(priorRows, "prior");

    const contributors = [...merged.values()].map((c) => ({
      ...c,
      change: round2(c.current - c.prior),
    }));

    const currentTotal = round2(contributors.reduce((s, c) => s + c.current, 0));
    const priorTotal = round2(contributors.reduce((s, c) => s + c.prior, 0));
    const netChange = round2(currentTotal - priorTotal);

    // Share of the NET change — undefined when the net is ~zero (see Contributor).
    const shareDenominator = Math.abs(netChange) >= 0.01 ? netChange : null;
    for (const c of contributors) {
      c.shareOfChange = shareDenominator === null ? null : round2(c.change / shareDenominator);
    }

    contributors.sort((a, b) => Math.abs(b.change) - Math.abs(a.change));

    /**
     * Concentration uses ABSOLUTE movement, not the net, so it still answers
     * "is this a few names or everyone?" when the net is zero — which is when
     * the question matters most.
     */
    const totalAbs = contributors.reduce((s, c) => s + Math.abs(c.change), 0);
    let concentration: Decomposition["concentration"] = null;
    if (totalAbs >= 0.01) {
      let running = 0;
      let count = 0;
      for (const c of contributors) {
        running += Math.abs(c.change);
        count += 1;
        if (running / totalAbs >= 0.8) break;
      }
      concentration = { count, share: round2(running / totalAbs) };
    }

    return {
      dimension,
      current: { from, to, total: currentTotal },
      prior: { from: prior.from, to: prior.to, total: priorTotal },
      change: netChange,
      contributors: contributors.filter((c) => Math.abs(c.change) >= 0.01),
      concentration,
    };
  },
};
