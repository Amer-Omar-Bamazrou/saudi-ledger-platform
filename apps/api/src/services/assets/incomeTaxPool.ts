/**
 * FA-E (2026-09-22) — the Income Tax Law Art. 17 POOL, as arithmetic.
 *
 * Record: docs/product/fixed-assets-decision-pack.md §8.3, §24.
 * Accountant FA-1: the pooled income-tax depreciation IS in scope and is
 * computed SEPARATELY from the book basis.
 *
 * 🔴 Primary text read in this pass (Income Tax Law, Royal Decree M/1 of
 * 15/1/1425H — the English text as deposited with the WTO; the Arabic
 * prevails, so readings that turn on wording are marked below):
 *
 *   17(d) "The depreciation deduction for each group is calculated by applying
 *         its depreciation rate … against the balance of the value of such
 *         group at the end of the taxable year."
 *   17(e) "The balance of the value of each group at the end of the taxable
 *         year is the total of the balance of the value of the group at the
 *         end of the previous taxable year after the depreciation deduction …
 *         for the previous taxable year, and fifty percent (50%) of the cost
 *         base of assets IN USE added to the group in the current and previous
 *         taxable years after the deduction of fifty percent (50%) of the
 *         compensation received from the assets disposed of during the current
 *         and previous taxable years, provided that the balance does not
 *         become in the negative."
 *   17(g) "When fifty percent (50%) of the compensation of the assets disposed
 *         of … exceeds the balance …, regardless of the amount of such
 *         compensation, the value of the group shall be reduced to zero and
 *         the excess is included in the taxpayer's taxable income."
 *   17(h) "If the balance … at the end of the year, AFTER allowing for the
 *         deduction in accordance with paragraph (d), is less than one
 *         thousand (1,000) riyals, the amount of the balance MAY be deducted."
 *   17(i) "Where all the assets in a group are disposed of, the balance of the
 *         group MAY be deducted at the end of the year."
 *   18(a)–(c) repair and improvement expenses are deductible, capped at 4 % of
 *         the group's year-end balance, and "the amount exceeding the limit …
 *         shall be added to the balance of the value of the group".
 *
 * 🔴 THE ADDITION DATE IS NOT A GUESS. 17(e) says "assets IN USE added to the
 * group", and 17(a) allows depreciation only for assets "wholly or partly used
 * in the generation of taxable income". So an asset enters its pool in the tax
 * year it became AVAILABLE FOR USE (IAS 16.55, the same date the book schedule
 * starts), not the year it was bought. The register stores both dates, so the
 * two readings are distinguishable and this one is the text's.
 *
 * 🔴 WHAT THIS MODULE DOES NOT DECIDE. 17(h) and 17(i) both say MAY. They are
 * elections, and an election changes the balance carried into every later year
 * — so the engine computes what is AVAILABLE and applies it only when the
 * taxpayer has said so. Nothing here chooses on the taxpayer's behalf.
 */
import { round2 } from "../../lib/money.js";

/** Art. 17(b): the five groups and their rates. The one definition — `assets.service.ts` re-exports it. */
export const ART17_RATES: Record<1 | 2 | 3 | 4 | 5, number> = { 1: 5, 2: 10, 3: 25, 4: 20, 5: 10 };

/** Art. 17(h). */
export const ART17_SMALL_BALANCE_SAR = 1000;
/** Art. 18(b). */
export const ART18_REPAIR_CAP_PCT = 4;

export type Art17Group = 1 | 2 | 3 | 4 | 5;

/** What the register supplies for one group and one tax year. */
export interface PoolYearFacts {
  /** Σ cost base of assets of this group that became available for use in the year (17(e): "assets in use added"). */
  additions: number;
  /** Σ compensation received for assets of this group disposed of in the year. */
  disposals: number;
  /** Art. 17(i) is available only when the group HAS assets and every one of them has been disposed of. */
  allAssetsDisposed: boolean;
}

/** What the taxpayer declares for one group and one tax year (nothing here is derivable). */
export interface PoolYearDeclaration {
  /** Art. 18(a): the year's total repair and improvement expenditure for the group. `null` = NOT DECLARED, which is not zero. */
  repairs: number | null;
  electSmallBalanceWriteOff: boolean;
  electGroupClosedWriteOff: boolean;
}

export interface PoolYearInput {
  taxYear: number;
  group: Art17Group;
  /** 17(e): the previous year's balance AFTER its deduction and after any election it took. */
  openingBalance: number;
  current: PoolYearFacts;
  /** 17(e) reaches back one year; for the first computed year these come from the anchor declaration. */
  previous: Pick<PoolYearFacts, "additions" | "disposals">;
  declaration: PoolYearDeclaration;
}

export interface PoolYearResult {
  taxYear: number;
  group: Art17Group;
  ratePct: number;
  openingBalance: number;
  additionsCurrent: number;
  additionsPrevious: number;
  disposalsCurrent: number;
  disposalsPrevious: number;
  /** 50 % of (current + previous) additions — the half the year contributes. */
  additionsHalf: number;
  /** 50 % of (current + previous) disposal compensation. */
  disposalsHalf: number;
  /** Art. 18: what was declared, the 4 % cap, what is deductible as expense and what is added back to the pool. */
  repairs: { declared: number | null; capBase: number; cap: number; deductibleAsExpense: number; addedToPool: number };
  /** The Art. 17(e) balance before the year's own deduction — never negative. */
  balanceBeforeDeduction: number;
  /** Art. 17(g): what 50 % of the disposals exceeded, and therefore falls into taxable income. */
  excessTaxableIncome: number;
  /** Art. 17(d): rate × balance. */
  depreciationDeduction: number;
  /** The balance after 17(d), before any election. */
  balanceAfterDeduction: number;
  /** The elections — what each is worth, whether it is available, and whether the taxpayer took it. */
  elections: {
    smallBalance: { available: boolean; amount: number; taken: boolean };
    groupClosed: { available: boolean; amount: number; taken: boolean };
  };
  /** 17(d) + whichever election was taken — what the tax computation deducts this year. */
  totalDeduction: number;
  /** What carries into the next year as its opening balance. */
  closingBalance: number;
}

/**
 * One group, one tax year. Pure: every input is passed in, so the Art. 17
 * arithmetic is testable without a register, a company or a clock.
 *
 * Order of operations, and why:
 *
 *  1. Art. 17(e) first — opening + 50 % additions − 50 % disposals. If that
 *     goes negative, 17(g) fires: the group is reduced to zero and the excess
 *     is taxable income. 17(e)'s "provided that the balance does not become in
 *     the negative" and 17(g)'s "regardless of the amount of such
 *     compensation" are the same event described twice, from the two sides.
 *
 *  2. Art. 18 next. The cap is "4 % of the balance of the value of the group at
 *     the end of that year", which is circular once the excess is "added to the
 *     balance" — so the cap is taken on the Art. 17(e) balance BEFORE the
 *     add-back. *Reasoned-not-verified* (the Arabic prevails): the alternative
 *     reading — a cap on the post-add-back balance — solves to a slightly
 *     larger cap and is not derivable from the English text, so the smaller,
 *     non-circular base is used and the choice is stated on the report.
 *
 *  3. Art. 17(d) applies the rate to the balance that results.
 *
 *  4. The elections last, because 17(h) is defined on the balance "after
 *     allowing for the deduction in accordance with paragraph (d)".
 */
export function computePoolYear(input: PoolYearInput): PoolYearResult {
  const { taxYear, group, openingBalance, current, previous, declaration } = input;
  const ratePct = ART17_RATES[group];

  const additionsHalf = round2((current.additions + previous.additions) / 2);
  const disposalsHalf = round2((current.disposals + previous.disposals) / 2);

  // 1. Art. 17(e) / 17(g)
  const raw = round2(openingBalance + additionsHalf - disposalsHalf);
  const excessTaxableIncome = raw < 0 ? round2(-raw) : 0;
  const art17eBalance = raw < 0 ? 0 : raw;

  // 2. Art. 18
  const capBase = art17eBalance;
  const cap = round2((capBase * ART18_REPAIR_CAP_PCT) / 100);
  const declaredRepairs = declaration.repairs;
  const deductibleAsExpense = declaredRepairs === null ? 0 : round2(Math.min(declaredRepairs, cap));
  const addedToPool = declaredRepairs === null ? 0 : round2(Math.max(0, declaredRepairs - cap));

  const balanceBeforeDeduction = round2(art17eBalance + addedToPool);

  // 3. Art. 17(d)
  const depreciationDeduction = round2((balanceBeforeDeduction * ratePct) / 100);
  const balanceAfterDeduction = round2(balanceBeforeDeduction - depreciationDeduction);

  // 4. Art. 17(i) then 17(h). 17(i) is the wider one — it writes off whatever
  // remains when the group is empty of assets — so taking it makes 17(h) moot;
  // they are never both applied, and the report shows both amounts regardless.
  const groupClosedAvailable = current.allAssetsDisposed && balanceAfterDeduction > 0;
  const smallBalanceAvailable = balanceAfterDeduction > 0 && balanceAfterDeduction < ART17_SMALL_BALANCE_SAR;
  const groupClosedTaken = groupClosedAvailable && declaration.electGroupClosedWriteOff;
  const smallBalanceTaken = !groupClosedTaken && smallBalanceAvailable && declaration.electSmallBalanceWriteOff;

  const electionAmount = groupClosedTaken || smallBalanceTaken ? balanceAfterDeduction : 0;

  return {
    taxYear,
    group,
    ratePct,
    openingBalance: round2(openingBalance),
    additionsCurrent: round2(current.additions),
    additionsPrevious: round2(previous.additions),
    disposalsCurrent: round2(current.disposals),
    disposalsPrevious: round2(previous.disposals),
    additionsHalf,
    disposalsHalf,
    repairs: { declared: declaredRepairs, capBase, cap, deductibleAsExpense, addedToPool },
    balanceBeforeDeduction,
    excessTaxableIncome,
    depreciationDeduction,
    balanceAfterDeduction,
    elections: {
      smallBalance: { available: smallBalanceAvailable, amount: smallBalanceAvailable ? balanceAfterDeduction : 0, taken: smallBalanceTaken },
      groupClosed: { available: groupClosedAvailable, amount: groupClosedAvailable ? balanceAfterDeduction : 0, taken: groupClosedTaken },
    },
    totalDeduction: round2(depreciationDeduction + electionAmount),
    closingBalance: round2(balanceAfterDeduction - electionAmount),
  };
}
