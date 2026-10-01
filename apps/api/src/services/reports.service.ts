/**
 * Reports service — financial-statement and ledger computations. Every rollup,
 * balance rule, aging bucket, and VAT-return box is copied VERBATIM from the
 * pre-M6 route handlers; only the DB access now goes through reportsRepository.
 */
import { BadRequestError } from "../lib/errors";
import { reportsRepository, documentSign, type GlParty } from "../repositories/reports.repository";
import { supplierStatementService } from "./accounting/supplierStatement.service";
import { customersRepository } from "../repositories/customers.repository";
// N2: ONE tolerance, imported from the write side — a read-side literal 2x the
// write-side constant was the two-constants disease glPosting diagnoses for itself.
import { GL_BALANCE_TOLERANCE } from "./accounting/glPosting";
import { businessToday } from "@workspace/shared";
import { depositReviewService, endOfMonth } from "./depositReview.service";
import { isVatOnlyDocumentType } from "@workspace/shared";
import { fromHalalas, round2, toHalalas } from "../lib/money";
import { fiscalYearContaining, isFiscalCalendar, type FiscalYearSettings } from "../lib/fiscalYear";
import { companiesRepository } from "../repositories/companies.repository";
import { customerStatementRepository } from "../repositories/customerStatement.repository";
import { supplierStatementRepository } from "../repositories/supplierStatement.repository";
import { CASH_FLOW_LINE_ACTIVITY, CASH_FLOW_LINE_LABEL, classifyCashFlowAccount, type CashFlowActivity, type CashFlowLine } from "./reporting/cashFlowClassification";

const toNum = (v: unknown) => (v != null ? Number(v) : 0);
const fmt2 = (n: number) => parseFloat(n.toFixed(2));

/**
 * D14-02 — a report date is `YYYY-MM-DD` and a real calendar day, or it is
 * absent. A malformed date is a 400 — never silently "all time", which is what
 * an unparsed `asOf=` used to produce (F-07: the server ignored it and answered
 * a different question that looked like an answer).
 */
export function reportDate(value: unknown, name: string): string | undefined {
  if (value == null || value === "") return undefined;
  const s = String(value);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  const d = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null;
  if (!m || !d || d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) {
    throw new BadRequestError(`${name} must be a calendar date in the form YYYY-MM-DD; "${s}" is not one.`);
  }
  return s;
}

/** A report window: both ends optional, validated, and in order. */
export function reportWindow(from: unknown, to: unknown): { from?: string; to?: string } {
  const f = reportDate(from, "date_from");
  const t = reportDate(to, "date_to");
  if (f && t && f > t) throw new BadRequestError(`date_from (${f}) is after date_to (${t}).`);
  return { from: f, to: t };
}

/** A report's account id: a positive integer, or a 400 — never read as "all accounts". */
export function reportAccountId(value: unknown): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new BadRequestError(`account_id must be a positive integer; "${String(value)}" is not one.`);
  return n;
}

/** D14-11 — the party filter: both halves or neither, never a half-read one. */
export function reportParty(type: unknown, customerId: unknown, vendorId: unknown): GlParty | undefined {
  if ((type == null || type === "") && (customerId == null || customerId === "") && (vendorId == null || vendorId === "")) return undefined;
  if (type === "customer") return { type: "customer", id: reportAccountIdNamed(customerId, "customer_id") };
  if (type === "vendor") return { type: "vendor", id: reportAccountIdNamed(vendorId, "vendor_id") };
  throw new BadRequestError(`party_type must be "customer" or "vendor" (with customer_id or vendor_id).`);
}
function reportAccountIdNamed(value: unknown, name: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new BadRequestError(`${name} must be a positive integer; "${String(value ?? "")}" is not one.`);
  return n;
}

/** The calendar day before an ISO date (accounting dates are plain days, no zone). */
export function dayBefore(iso: string): string {
  const [y, mo, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y!, mo! - 1, d! - 1)).toISOString().slice(0, 10);
}

/** The scoped company's fiscal settings — null when the fiscal year is NOT declared (M20 F8). */
async function fiscalSettings(): Promise<FiscalYearSettings | null> {
  // the company IN SCOPE (the request's company GUC), never "the org's first company" (F-19)
  const company = await companiesRepository.findCurrent();
  if (!company || company.fiscalYearStart == null) return null;
  return { fiscalYearStart: company.fiscalYearStart, calendar: isFiscalCalendar(company.fiscalCalendar) ? company.fiscalCalendar : "gregorian" };
}

/** Ageing buckets (days past due at the as-of date); amounts in integer halalas. */
type AgingBuckets = { current: number; days_1_30: number; days_31_60: number; days_61_90: number; over_90: number };
function bucketInto(b: AgingBuckets, agedDays: number, amountH: number) {
  if (agedDays <= 0) b.current += amountH;
  else if (agedDays <= 30) b.days_1_30 += amountH;
  else if (agedDays <= 60) b.days_31_60 += amountH;
  else if (agedDays <= 90) b.days_61_90 += amountH;
  else b.over_90 += amountH;
}
const halalaBuckets = (b: AgingBuckets) => ({ current: fromHalalas(b.current), days_1_30: fromHalalas(b.days_1_30), days_31_60: fromHalalas(b.days_31_60), days_61_90: fromHalalas(b.days_61_90), over_90: fromHalalas(b.over_90) });

type CategoryRow = Awaited<ReturnType<typeof reportsRepository.allCategories>>[number];
const isIncomeType = (t: string | null | undefined) => t === "income" || t === "revenue";
const isPlType = (t: string | null | undefined) => isIncomeType(t) || t === "expense";

/**
 * The seam's rows joined to the chart: one entry per account with exact
 * halala figures. The display name is the account's CURRENT name (a rename is
 * a rename, not a second account); a legacy line with no account id keeps its
 * stored name and type "other".
 */
type LedgerAccount = { key: string; accountId: number | null; name: string; nameAr: string; type: string; liquidityClass: string | null; systemCode: string | null; openingH: number; debitH: number; creditH: number };
async function ledgerAccounts(opts: Parameters<typeof reportsRepository.ledgerBalances>[0], cats?: CategoryRow[]): Promise<LedgerAccount[]> {
  const [rows, chart] = await Promise.all([reportsRepository.ledgerBalances(opts), cats ? Promise.resolve(cats) : reportsRepository.allCategories()]);
  const catMap = new Map(chart.map((c) => [c.id, c]));
  return rows.map((r) => {
    const cat = r.accountId != null ? catMap.get(r.accountId) : undefined;
    return {
      key: r.accountId != null ? String(r.accountId) : (r.legacyName ?? "(no account)"),
      accountId: r.accountId,
      name: cat?.name ?? r.legacyName ?? "(no account)",
      nameAr: cat?.nameAr ?? "",
      type: cat?.type ?? "other",
      liquidityClass: cat?.liquidityClass ?? null,
      systemCode: cat?.systemCode ?? null,
      openingH: toHalalas(r.opening),
      debitH: toHalalas(r.debit),
      creditH: toHalalas(r.credit),
    };
  });
}

export const reportsService = {
  /**
   * D14-04 — the trial balance: opening / period debit / period credit /
   * closing per account, from the ledger seam, exact.
   *
   * - `debit`, `credit`, `balance` keep their pre-Phase-14 meaning: the PERIOD
   *   movement (`balance` = debit − credit of the window).
   * - `openingBalance` / `closingBalance` are debit-positive.
   * - Migration opening entries are OPENING even inside the window (D14-03).
   * - With `date_from` and a declared fiscal year, income and expense accounts
   *   open at the start of the fiscal year containing `date_from` (PRECEDENT:
   *   ERPNext trial_balance.py; Odoo include_initial_balance); everything they
   *   accumulated before it is ONE computed equity row — so Σ opening = Σ
   *   closing = 0 still holds (IAS 1.106: no closing journal is required; this
   *   is a presentation of the same ledger).
   */
  async trialBalance(date_from?: string, date_to?: string) {
    const { from, to } = reportWindow(date_from, date_to);
    const cats = await reportsRepository.allCategories();
    const accounts = await ledgerAccounts({ from, to, openingSourcesAsOpening: true }, cats);

    const settings = await fiscalSettings();
    let plResetFrom: string | null = null;
    let priorPlH = 0;
    if (from && settings) {
      plResetFrom = fiscalYearContaining(settings, from).startDate;
      if (plResetFrom > from) plResetFrom = null; // cannot happen; defensive — never reset forward
    }
    if (plResetFrom) {
      const plIds = cats.filter((c) => isPlType(c.type)).map((c) => c.id);
      const prior = await ledgerAccounts({ to: dayBefore(plResetFrom), accountIds: plIds }, cats);
      const priorByKey = new Map(prior.map((p) => [p.key, p.debitH - p.creditH]));
      for (const a of accounts) {
        if (!isPlType(a.type)) continue;
        const p = priorByKey.get(a.key) ?? 0;
        a.openingH -= p;
        priorPlH += p;
      }
    }

    const rows = accounts
      .filter((a) => a.openingH !== 0 || a.debitH !== 0 || a.creditH !== 0)
      .map((a) => ({
        key: a.key,
        name: a.name,
        nameAr: a.nameAr,
        accountId: a.accountId,
        type: a.type,
        computed: false,
        openingBalance: fromHalalas(a.openingH),
        debit: fromHalalas(a.debitH),
        credit: fromHalalas(a.creditH),
        balance: fromHalalas(a.debitH - a.creditH),
        closingBalance: fromHalalas(a.openingH + a.debitH - a.creditH),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (priorPlH !== 0) {
      // The P&L of earlier fiscal years, not yet allocated by any entry — on
      // the equity side, debit-positive like every row (a prior PROFIT is a
      // credit, so it shows negative here and positive on the balance sheet).
      rows.push({
        key: "pl_prior_years", name: "Profit / loss of prior fiscal years — not yet allocated", nameAr: "أرباح / خسائر سنوات مالية سابقة — غير موزعة",
        accountId: null, type: "equity", computed: true,
        openingBalance: fromHalalas(priorPlH), debit: 0, credit: 0, balance: 0, closingBalance: fromHalalas(priorPlH),
      });
    }

    /**
     * D14-03, refined (accounting review M1, 2026-10-01): a migration opening entry dated in the
     * window is SPLIT — its balance-sheet lines are opening, its income and expense lines (the
     * previous system's year-to-date P&L) are period movement, as the income statement counts them.
     * One balanced entry across two columns leaves each column off by the migrated result X, so a
     * computed row carries X in the opening column and −X in the period: Σ opening = Σ closing = 0
     * and debits = credits again, and the row itself closes at zero — it moves the result from the
     * opening position into the period, it adds nothing.
     */
    const plIdsAll = cats.filter((c) => isPlType(c.type)).map((c) => c.id);
    const migRows = await reportsRepository.openingSourceMovements(from ?? "0001-01-01", to ?? "9999-12-31", { accountIds: plIdsAll });
    const migratedResultH = migRows.reduce((t, r) => t + toHalalas(r.debit) - toHalalas(r.credit), 0); // debit-positive
    const migDebitH = migratedResultH < 0 ? -migratedResultH : 0;
    const migCreditH = migratedResultH > 0 ? migratedResultH : 0;
    if (migratedResultH !== 0) {
      rows.push({
        key: "migrated_ytd_result", name: "Year-to-date result brought in by migration (opening → period)", nameAr: "نتيجة ما سبق من السنة المُدخلة بالترحيل (من الافتتاحي إلى الفترة)",
        accountId: null, type: "equity", computed: true,
        openingBalance: fromHalalas(migratedResultH), debit: fromHalalas(migDebitH), credit: fromHalalas(migCreditH),
        balance: fromHalalas(migDebitH - migCreditH), closingBalance: 0,
      });
    }

    const sumH = (f: (a: LedgerAccount) => number) => accounts.reduce((s, a) => s + f(a), 0);
    const totalDebitH = sumH((a) => a.debitH) + migDebitH;
    const totalCreditH = sumH((a) => a.creditH) + migCreditH;
    const totalOpeningH = sumH((a) => a.openingH) + priorPlH + migratedResultH;
    const totalClosingH = sumH((a) => a.openingH + a.debitH - a.creditH) + priorPlH;
    return {
      window: { from: from ?? null, to: to ?? null },
      fiscalYearDeclared: settings != null,
      plResetFrom,
      accounts: rows,
      totalDebit: fromHalalas(totalDebitH),
      totalCredit: fromHalalas(totalCreditH),
      totalOpening: fromHalalas(totalOpeningH),
      totalClosing: fromHalalas(totalClosingH),
      // EXACT (accounting review M4): the sums are integer halalas, so a halala off is unbalanced
      balanced: totalDebitH === totalCreditH && totalOpeningH === 0 && totalClosingH === 0,
    };
  },

  /**
   * D14-06 — profit or loss from THE LEDGER ONLY. The pre-Phase-14
   * transactions fallback (a second truth, gross of VAT — known issue) is
   * gone: a window with no GL lines reports zero. Expenses are presented BY
   * NATURE (IAS 1.102 — each expense account is a nature), so there is no
   * gross-profit line: IAS 1.103 asks for cost of sales only under the
   * function method, and there is no cost-of-sales account here (no
   * inventory). `grossProfit` is therefore null — the old value was simply
   * revenue under another name.
   */
  async incomeStatement(date_from?: string, date_to?: string) {
    const { from, to } = reportWindow(date_from, date_to);
    const cats = await reportsRepository.allCategories();
    const plIds = cats.filter((c) => isPlType(c.type)).map((c) => c.id);
    const accounts = await ledgerAccounts({ from, to, accountIds: plIds, movementOnly: true }, cats);

    // `key` travels to the RESPONSE (F7-cmp): the prior-period comparison
    // merges lines across two windows by account id, never by display name.
    const revenue: { key: string; name: string; nameAr: string; amountH: number }[] = [];
    const expenses: { key: string; name: string; nameAr: string; amountH: number }[] = [];
    for (const a of accounts) {
      // an account appears when it MOVED in the window (as before), even if it nets to zero;
      // the seam also returns accounts whose only lines are before `from` — those did not move.
      if (a.debitH === 0 && a.creditH === 0) continue;
      if (isIncomeType(a.type)) revenue.push({ key: a.key, name: a.name, nameAr: a.nameAr, amountH: a.creditH - a.debitH });
      else if (a.type === "expense") expenses.push({ key: a.key, name: a.name, nameAr: a.nameAr, amountH: a.debitH - a.creditH });
    }
    const out = (xs: typeof revenue) => xs.map((x) => ({ key: x.key, name: x.name, nameAr: x.nameAr, amount: fromHalalas(x.amountH) })).sort((a, b) => b.amount - a.amount);
    const totalRevenueH = revenue.reduce((s, r) => s + r.amountH, 0);
    const totalExpensesH = expenses.reduce((s, e) => s + e.amountH, 0);
    const netIncomeH = totalRevenueH - totalExpensesH;

    return {
      window: { from: from ?? null, to: to ?? null },
      revenue: out(revenue),
      expenses: out(expenses),
      totalRevenue: fromHalalas(totalRevenueH),
      totalExpenses: fromHalalas(totalExpensesH),
      grossProfit: null as number | null,
      expenseAnalysis: "nature" as const,
      netIncome: fromHalalas(netIncomeH),
      // a ratio, rounded once for display — never fed back into money arithmetic
      netIncomeMargin: totalRevenueH > 0 ? round2((netIncomeH / totalRevenueH) * 100) : 0,
      source: "journal_entries" as const,
    };
  },

  /**
   * The balance sheet AS OF a date (D14-02: lines dated ≤ as_of; default the
   * business day, echoed in `asOf`).
   *
   * D14-05 — equity shows the equity ACCOUNTS (the migrated
   * `RETAINED_EARNINGS` account among them) plus the profit or loss not yet
   * allocated by any entry, SPLIT by the fiscal year containing `as_of`:
   *   - prior fiscal years = Σ income − expense dated before that year's start;
   *   - current fiscal year to date = Σ income − expense from its start to as_of.
   * AUTHORITY: IAS 1.106(d)/108 and IFRS for SMEs 6.5 — retained earnings is
   * opening + profit for the period; no closing journal is required.
   * PRECEDENT: Odoo computes current-year earnings in real time; ERPNext shows
   * a provisional P&L — but NOT ERPNext's plug (assets − liabilities − equity),
   * which balances by construction and so could never reveal an error: these
   * lines are computed from income and expense, and the balance is then CHECKED.
   * The computed lines never carry the label "Retained earnings" — that is the
   * account's name (the two-lines-one-label defect, F-04).
   *
   * Every figure is exact (integer halalas from the ledger seam), so `balanced`
   * is EXACT — a halala off is unbalanced (accounting review M4, 2026-10-01).
   */
  async balanceSheet(as_of?: string) {
    const asOf = reportDate(as_of, "as_of") ?? businessToday();
    const cats = await reportsRepository.allCategories();
    const settings = await fiscalSettings();
    const fy = settings ? fiscalYearContaining(settings, asOf) : null;
    // One seam read. With a declared fiscal year, `from` = its start splits the
    // income/expense lines into before (opening) and within (movement); balance-
    // sheet accounts use opening + movement, so the split does not touch them.
    const accounts = await ledgerAccounts({ to: asOf, from: fy?.startDate }, cats);

    /**
     * M18.2 — every balance-sheet item carries its liquidity class, so the
     * current / non-current breakout is a GROUPING of the same numbers rather
     * than a second computation of them: the sections cannot drift from the
     * total, because they are partitions of it.
     */
    // `key` travels to the response for the same reason as the income
    // statement's (F7-cmp): the comparison merges lines across two as-of
    // dates, and a name join breaks silently on a rename.
    type BsItemH = { key: string; accountId: number | null; name: string; nameAr: string; amountH: number; liquidityClass: string | null };
    const assets: BsItemH[] = [];
    const liabilities: BsItemH[] = [];
    const equityAccounts: BsItemH[] = [];
    const unmapped: BsItemH[] = [];
    let priorPlH = 0;   // credit-positive: a profit is positive
    let currentPlH = 0;

    for (const a of accounts) {
      const netH = a.openingH + a.debitH - a.creditH; // debit-positive closing
      if (netH === 0 && !isPlType(a.type)) continue;
      // NULL liquidity class is UNCLASSIFIED and stays null all the way to the
      // response — never coerced to "current", which would hide it inside a
      // figure the Finance Hub presents as a plain-language claim.
      const item = { key: a.key, accountId: a.accountId, name: a.name, nameAr: a.nameAr, amountH: 0, liquidityClass: a.liquidityClass };
      if (a.type === "asset") assets.push({ ...item, amountH: netH });
      else if (a.type === "liability") liabilities.push({ ...item, amountH: -netH });
      else if (a.type === "equity") equityAccounts.push({ ...item, amountH: -netH });
      else if (isPlType(a.type)) {
        priorPlH += -a.openingH;
        currentPlH += -(a.debitH - a.creditH);
      } else unmapped.push({ ...item, amountH: netH });
    }
    // Without a declared fiscal year there is no "current year": everything is
    // one line, and the response says why.
    if (!fy) { priorPlH += currentPlH; currentPlH = 0; }
    const retainedEarningsH = priorPlH + currentPlH;

    // ── M13: AR and AP come from the GENERAL LEDGER (by system code) ─────────
    // AR/AP are ordinary GL accounts inside assets/liabilities; adding the
    // document-derived totals again would DOUBLE-COUNT. AR/AP **aging** stays
    // document-derived (it needs the per-document dimension), and a permanent
    // test asserts the two computations agree.
    const systemIdByCode = new Map<string, number>();
    for (const c of cats) if (c.systemCode) systemIdByCode.set(c.systemCode, c.id);
    const balanceOf = (items: BsItemH[], code: string) => {
      const id = systemIdByCode.get(code);
      return fromHalalas(id != null ? (items.find((i) => i.accountId === id)?.amountH ?? 0) : 0);
    };
    const arBalance = balanceOf(assets, "AR");
    const apBalance = balanceOf(liabilities, "AP");
    // the ROW keys of the AR / AP accounts, resolved by system CODE — a page
    // marks those rows by key, never by sniffing a tenant-owned name (M18.1)
    const keyOf = (items: BsItemH[], code: string) => { const id = systemIdByCode.get(code); return id != null && items.some((i) => i.accountId === id) ? String(id) : null; };
    /**
     * M18.3 — SUSPENSE (an accepted-but-uncategorised bank line) and A's
     * TRANSFER_SUSPENSE (an undeclared transfer): not liquidity, a DATA-QUALITY
     * signal. A non-zero balance blocks the Finance Hub's plain-language
     * liquidity claim (design §5.1, owner decision).
     */
    const suspenseBalance = balanceOf(assets, "SUSPENSE");
    const transferSuspenseBalance = balanceOf(assets, "TRANSFER_SUSPENSE");

    const toItem = (i: BsItemH) => ({ key: i.key, name: i.name, nameAr: i.nameAr, amount: fromHalalas(i.amountH), liquidityClass: i.liquidityClass });
    const sumH = (xs: BsItemH[]) => xs.reduce((s, x) => s + x.amountH, 0);
    const totalAssetsH = sumH(assets);
    const totalLiabH = sumH(liabilities);
    const totalEquityH = sumH(equityAccounts) + retainedEarningsH;
    const totalLiabAndEquityH = totalLiabH + totalEquityH;
    const balanced = totalAssetsH === totalLiabAndEquityH && unmapped.length === 0;

    /**
     * ── M18.2: the current / non-current breakout ──────────────────────────
     * 🔴 THREE buckets, not two (IAS 1.60 classified presentation; IAS 1.66–76).
     * `unclassified` holds every balance-sheet account whose `liquidity_class`
     * is NULL, returned even when empty — an account that fits no bucket is
     * exactly what a control surface exists to report. The partition is the
     * guarantee: current + nonCurrent + unclassified = total by construction.
     */
    const isCurrent = (c: string | null) => c === "cash" || c === "quick" || c === "current";
    const isNonCurrent = (c: string | null) => c === "non_current";
    const isUnclassified = (c: string | null) => c == null;
    const bucket = (items: BsItemH[], pred: (c: string | null) => boolean) => {
      const picked = items.filter((i) => pred(i.liquidityClass));
      return { items: picked.map(toItem), total: fromHalalas(sumH(picked)) };
    };
    /** Cash + quick — the acid-test numerator the Finance Hub needs (M18.3). */
    const quickTotal = fromHalalas(sumH(assets.filter((i) => i.liquidityClass === "cash" || i.liquidityClass === "quick")));

    return {
      asOf,
      assets: {
        items: assets.map(toItem).sort((a, b) => b.amount - a.amount),
        accountsReceivable: arBalance,
        accountsReceivableKey: keyOf(assets, "AR"),
        total: fromHalalas(totalAssetsH),
        current: bucket(assets, isCurrent),
        nonCurrent: bucket(assets, isNonCurrent),
        unclassified: bucket(assets, isUnclassified),
        quickTotal,
        suspenseBalance,
        transferSuspenseBalance,
      },
      liabilities: {
        items: liabilities.map(toItem),
        accountsPayable: apBalance,
        accountsPayableKey: keyOf(liabilities, "AP"),
        total: fromHalalas(totalLiabH),
        current: bucket(liabilities, isCurrent),
        nonCurrent: bucket(liabilities, isNonCurrent),
        unclassified: bucket(liabilities, isUnclassified),
      },
      equity: {
        items: equityAccounts.map((e) => ({ key: e.key, name: e.name, nameAr: e.nameAr, amount: fromHalalas(e.amountH) })),
        // Σ of the two computed lines below — kept for compatibility (Finance
        // Hub, comparisons). It is NOT the RETAINED_EARNINGS account.
        retainedEarnings: fromHalalas(retainedEarningsH),
        priorYearsProfit: fromHalalas(priorPlH),
        currentYearProfit: fromHalalas(currentPlH),
        fiscalYear: fy ? { label: fy.label, startDate: fy.startDate, endDate: fy.endDate, calendar: fy.calendar } : null,
        total: fromHalalas(totalEquityH),
      },
      /** Ledger lines on no balance-sheet or P&L account type — never folded in; listed so they are seen. */
      unmapped: unmapped.map(toItem),
      totalLiabilitiesAndEquity: fromHalalas(totalLiabAndEquityH),
      balanced,
      warning: balanced
        ? null
        : unmapped.length > 0
          ? `${unmapped.length} ledger account(s) carry a balance but no balance-sheet or P&L type; they are listed under "unmapped".`
          : `Assets (${fromHalalas(totalAssetsH)}) ≠ Liabilities + Equity (${fromHalalas(totalLiabAndEquityH)}).`,
    };
  },

  /**
   * D14-07 — the statement of cash flows, DIRECT method, from THE LEDGER.
   *
   * The pre-Phase-14 report read the bank-feed `transactions` table, which
   * never sees a payment made through the document flows (customer receipts
   * and supplier payments post no transaction row — `analytics.repository.ts`
   * says so) and so could not reconcile to the cash accounts (F-01).
   *
   * Cash = every account with liquidity class 'cash' (the per-bank D-3 leaves,
   * and the `CASH` header that still carries pre-D-3 history). For each
   * in-books entry of the window that touches cash, every NON-cash line
   * contributes −(debit − credit) to the line of its account
   * (`classifyCashFlowAccount`); the entry balances, so the contributions sum
   * to the cash it moved, exactly. Migration opening entries are not cash
   * flows (D14-03): they are one reconciling line.
   *
   * 🔴 THE STATEMENT MUST RECONCILE (invariant H): opening cash + operating +
   * investing + financing + transfers in transit + migration openings =
   * closing cash, all from the GL. `reconciles` says whether it does; it is a
   * check, never a plug.
   *
   * Disclosed: flows are INCLUSIVE of VAT (IFRIC 2005); VAT settled with ZATCA
   * is its own line; interest is classified by the account it hits (IAS 7.33,
   * the IAS 1-era policy choice). The indirect method is a roadmap item (owner,
   * 2026-08-31).
   */
  async cashFlow(date_from?: string, date_to?: string) {
    const { from, to } = reportWindow(date_from, date_to);
    const cats = await reportsRepository.allCategories();
    const catMap = new Map(cats.map((c) => [c.id, c]));
    const cashIds = cats.filter((c) => c.liquidityClass === "cash").map((c) => c.id);

    const [contribs, migration, openingRows, closingRows, faAccounts] = await Promise.all([
      reportsRepository.cashFlowContributions(from, to, cashIds),
      reportsRepository.cashFromOpeningSources(from, to, cashIds),
      from ? ledgerAccounts({ to: dayBefore(from), accountIds: cashIds }, cats) : Promise.resolve([] as LedgerAccount[]),
      ledgerAccounts({ to, accountIds: cashIds }, cats),
      reportsRepository.fixedAssetAccounts(),
    ]);
    const fixedAssetIds = new Set(faAccounts.flatMap((r) => [r.cost, r.accumulated]));
    const cashBalanceH = (rows: LedgerAccount[]) => rows.reduce((s, r) => s + r.openingH + r.debitH - r.creditH, 0);
    const openingCashH = cashBalanceH(openingRows);
    const closingCashH = cashBalanceH(closingRows);
    const migrationH = toHalalas(migration[0]?.amount ?? "0");

    type Detail = { key: string; name: string; nameAr: string; amountH: number };
    const lines = new Map<CashFlowLine, Detail[]>();
    for (const c of contribs) {
      const cat = c.accountId != null ? catMap.get(c.accountId) : undefined;
      const line = classifyCashFlowAccount({ type: cat?.type, liquidityClass: cat?.liquidityClass, systemCode: cat?.systemCode, fixedAsset: c.accountId != null && fixedAssetIds.has(c.accountId) });
      const amountH = toHalalas(c.amount);
      if (amountH === 0) continue;
      if (!lines.has(line)) lines.set(line, []);
      lines.get(line)!.push({
        key: c.accountId != null ? String(c.accountId) : (c.legacyName ?? "(no account)"),
        name: cat?.name ?? c.legacyName ?? "(no account)",
        nameAr: cat?.nameAr ?? "",
        amountH,
      });
    }
    const section = (activity: CashFlowActivity) => {
      const items = (Object.keys(CASH_FLOW_LINE_ACTIVITY) as CashFlowLine[])
        .filter((l) => CASH_FLOW_LINE_ACTIVITY[l] === activity && lines.has(l))
        .map((l) => {
          const accounts = lines.get(l)!.sort((a, b) => Math.abs(b.amountH) - Math.abs(a.amountH));
          const amountH = accounts.reduce((s, a) => s + a.amountH, 0);
          return {
            key: l, name: CASH_FLOW_LINE_LABEL[l].en, nameAr: CASH_FLOW_LINE_LABEL[l].ar, amount: fromHalalas(amountH), amountH,
            accounts: accounts.map((a) => ({ key: a.key, name: a.name, nameAr: a.nameAr, amount: fromHalalas(a.amountH) })),
          };
        });
      const totalH = items.reduce((s, i) => s + i.amountH, 0);
      return { total: fromHalalas(totalH), totalH, items: items.map(({ amountH: _h, ...rest }) => rest) };
    };
    const operating = section("operating");
    const investing = section("investing");
    const financing = section("financing");
    const internal = section("internal");
    const netActivitiesH = operating.totalH + investing.totalH + financing.totalH;
    const explainedH = openingCashH + netActivitiesH + internal.totalH + migrationH;
    const strip = (s: typeof operating) => ({ total: s.total, items: s.items });
    return {
      window: { from: from ?? null, to: to ?? null },
      method: "direct" as const,
      vatBasis: "inclusive" as const,
      openingCash: fromHalalas(openingCashH),
      operating: strip(operating),
      investing: strip(investing),
      financing: strip(financing),
      /** Own-account transfers still in transit at the window's end (TRANSFER_CLEARING) — not a cash flow (IAS 7.9). */
      internal: strip(internal),
      /** Cash brought in by a migration's opening journal inside the window — an opening balance, not a flow. */
      migrationOpeningCash: fromHalalas(migrationH),
      /** Net cash from operating + investing + financing. */
      netCashFromActivities: fromHalalas(netActivitiesH),
      /** Closing − opening cash, from the GL. */
      netChange: fromHalalas(closingCashH - openingCashH),
      closingCash: fromHalalas(closingCashH),
      reconciles: explainedH === closingCashH,
      limitations: ["L-CF1", "L-CF2"],
    };
  },

  async journalReport(date_from?: string, date_to?: string) {
    const entries = await reportsRepository.postedEntries(date_from, date_to);
    const lines = entries.length > 0 ? await reportsRepository.jeLinesByEntryIds(entries.map((e) => e.id)) : [];

    const linesByEntry = new Map<number, typeof lines>();
    for (const l of lines) {
      if (!linesByEntry.has(l.journalEntryId)) linesByEntry.set(l.journalEntryId, []);
      linesByEntry.get(l.journalEntryId)!.push(l);
    }

    const result = entries.map((e) => {
      const entryLines = linesByEntry.get(e.id) ?? [];
      const totalDebit = fmt2(entryLines.reduce((s, l) => s + toNum(l.debitAmount), 0));
      const totalCredit = fmt2(entryLines.reduce((s, l) => s + toNum(l.creditAmount), 0));
      return {
        id: e.id,
        entryNumber: e.entryNumber,
        date: e.date,
        description: e.description,
        reference: e.reference,
        status: e.status,
        lines: entryLines.map((l) => ({ id: l.id, accountName: l.accountName, accountId: l.accountId, description: l.description, debit: fmt2(toNum(l.debitAmount)), credit: fmt2(toNum(l.creditAmount)) })),
        totalDebit,
        totalCredit,
        balanced: Math.abs(totalDebit - totalCredit) <= GL_BALANCE_TOLERANCE,
      };
    });

    const grandDebit = fmt2(result.reduce((s, e) => s + e.totalDebit, 0));
    const grandCredit = fmt2(result.reduce((s, e) => s + e.totalCredit, 0));
    return { entries: result, count: result.length, grandDebit, grandCredit, balanced: Math.abs(grandDebit - grandCredit) <= GL_BALANCE_TOLERANCE };
  },

  /**
   * The general ledger: an opening, the lines of the window in date order with
   * a running balance, and a closing — exact (integer halalas).
   *
   * - The opening is computed when the ledger is scoped (an account, or a
   *   party): an unscoped all-accounts ledger has no meaningful running
   *   balance, so it opens at 0 (as before).
   * - D14-11: `party` filters to the lines that NAME one customer or vendor
   *   (the N3 dimension); the opening applies the same filter.
   * - D14-09: every row carries `jeId`, the drill-down target.
   */
  async generalLedger(account_id?: string, account_name?: string, date_from?: string, date_to?: string, party?: GlParty) {
    const { from, to } = reportWindow(date_from, date_to);
    const accountId = account_id != null && account_id !== "" ? reportAccountId(account_id) : undefined;
    const cats = await reportsRepository.allCategories();
    const catMap = new Map(cats.map((c) => [c.id, c]));
    const cat = accountId != null ? catMap.get(accountId) : undefined;

    // D14-09 — the ledger a trial-balance row drills into OPENS ON THAT ROW'S
    // OPENING: an income or expense account starts at the fiscal year
    // containing `from` (the TB's P&L reset), and migration opening entries
    // are opening, not movement (D14-03). Otherwise the link would land on a
    // different question than the row the reader clicked (§3).
    let plResetFrom: string | null = null;
    if (from && cat && isPlType(cat.type)) {
      const settings = await fiscalSettings();
      if (settings) plResetFrom = fiscalYearContaining(settings, from).startDate;
    }
    let openingH = 0;
    if (accountId != null || account_name || party) {
      const [o] = await reportsRepository.glOpening({ from, to, notBefore: plResetFrom ?? undefined, accountId, accountName: account_name, party });
      openingH = toHalalas(o?.amount);
    }

    const rows = await reportsRepository.glRows(from, to, accountId != null ? String(accountId) : undefined, account_name, party);

    let runningH = openingH, debitH = 0, creditH = 0;
    const movements = rows.map((r) => {
      const d = toHalalas(r.debit), c = toHalalas(r.credit);
      runningH += d - c; debitH += d; creditH += c;
      return {
        date: r.date, entryNumber: r.entryNumber, jeId: r.jeId,
        description: r.lineDesc ?? r.description, reference: r.reference,
        accountName: r.accountName, accountId: r.accountId,
        accountNameAr: (r.accountId ? catMap.get(r.accountId)?.nameAr : undefined) ?? "",
        partyType: r.partyType, customerId: r.customerId, vendorId: r.vendorId,
        debit: fromHalalas(d), credit: fromHalalas(c), balance: fromHalalas(runningH),
      };
    });

    return {
      window: { from: from ?? null, to: to ?? null },
      plResetFrom,
      accountId: accountId ?? null,
      accountName: cat?.name ?? account_name ?? rows[0]?.accountName ?? "All Accounts",
      accountNameAr: cat?.nameAr ?? "",
      party: party ?? null,
      openingBalance: fromHalalas(openingH),
      movements,
      closingBalance: fromHalalas(runningH),
      totalDebit: fromHalalas(debitH),
      totalCredit: fromHalalas(creditH),
    };
  },

  async accountStatement(account_id?: string, account_name?: string, date_from?: string, date_to?: string) {
    if (!account_id && !account_name) throw new BadRequestError("account_id or account_name is required");
    // D14-09 — ONE definition of an account's opening and movements: the
    // statement is the general ledger for one account, in its own shape.
    const gl = await reportsService.generalLedger(account_id, account_name, date_from, date_to);
    const cat = gl.accountId != null ? await reportsRepository.categoryById(gl.accountId) : [];
    return {
      account: cat[0] ?? { name: account_name ?? "Unknown", type: "other" },
      openingBalance: gl.openingBalance,
      movements: gl.movements.map((m) => ({ date: m.date, entryNumber: m.entryNumber, reference: m.reference, description: m.description, debit: m.debit, credit: m.credit, balance: m.balance })),
      closingBalance: gl.closingBalance,
      totalDebit: gl.totalDebit,
      totalCredit: gl.totalCredit,
    };
  },

  async accountSummary(date_from?: string, date_to?: string) {
    // ONE definition (accounting review M3, 2026-10-01): the summary is the trial balance's rows —
    // the same P&L reset at the fiscal-year start, the same prior-years row — in the summary's shape.
    // It used to sum its own way and disagreed with the TB for the same dates.
    const tb = await reportsService.trialBalance(date_from, date_to);
    const rows = tb.accounts.map((a) => ({
      key: a.key,
      accountId: a.accountId,
      name: a.name,
      nameAr: a.nameAr,
      type: a.type,
      openingBalance: a.openingBalance,
      periodDebit: a.debit,
      periodCredit: a.credit,
      closingBalance: a.closingBalance,
    }));
    return { window: tb.window, accounts: rows, count: rows.length };
  },

  async customerLedger(customer_id?: string, date_from?: string, date_to?: string) {
    const rows = await reportsRepository.customerInvoices(customer_id, date_from, date_to);
    const custMap = new Map<number, { customer: any; invoices: any[] }>();
    for (const { inv, cust } of rows) {
      // AP-2: an advance tax invoice is not a receivable document — the
      // customer ledger lists what is owed; the statement carries the 386
      // in the chronology and the receipt card carries it beside its deposit.
      if (isVatOnlyDocumentType(inv.documentType)) continue; // AP-2/AP-3/40(9): VAT-only documents own no receivable
      const cid = inv.customerId ?? 0;
      if (!custMap.has(cid)) custMap.set(cid, { customer: cust, invoices: [] });
      // M12.1b: a credit note appears on the ledger as a NEGATIVE line (its
      // total, VAT and subtotal), so the document list reads as the customer
      // saw it. `documentType` is surfaced so the UI can label the row rather
      // than infer from the sign.
      //
      // Phase E (2026-09-17): a row's `outstanding` is what THAT document still
      // has receivable — total − paid − credited for an invoice or debit note,
      // and 0 for a credit note, whose unapplied remainder is a LIABILITY
      // carried in `position.creditBalance`, never a negative receivable.
      // Pre-E the note row carried −total as "outstanding" and the invoice row
      // ignored `credited_amount`, so a credited invoice still read as owed.
      const sign = documentSign(inv.documentType);
      const isNote = inv.documentType === "credit_note";
      const credited = toNum(inv.creditedAmount);
      custMap.get(cid)!.invoices.push({
        id: inv.id, invoiceNumber: inv.invoiceNumber, date: inv.date, dueDate: inv.dueDate,
        documentType: inv.documentType,
        status: inv.status,
        total: fmt2(sign * toNum(inv.total)), paidAmount: fmt2(isNote ? 0 : toNum(inv.paidAmount)),
        creditedAmount: fmt2(isNote ? 0 : credited),
        outstanding: fmt2(isNote ? 0 : toNum(inv.total) - toNum(inv.paidAmount) - credited - toNum(inv.writtenOffAmount)),
        vatAmount: fmt2(sign * toNum(inv.vatAmount)), subtotal: fmt2(sign * toNum(inv.subtotal)),
      });
    }
    // The CURRENT position of each listed customer (whole history, not the
    // window): three non-negative components and the derived net.
    const positions = new Map((await customersRepository.customerBalances()).map((p) => [p.customerId, p]));
    const customers = Array.from(custMap.values()).map(({ customer, invoices }) => {
      const pos = customer?.id != null ? positions.get(customer.id) : undefined;
      return {
        customerId: customer?.id, customerName: customer?.name ?? "Unknown", taxNumber: customer?.taxNumber,
        invoices,
        totalInvoiced: fmt2(invoices.reduce((s, i) => s + i.total, 0)),
        totalPaid: fmt2(invoices.reduce((s, i) => s + i.paidAmount, 0)),
        // Σ outstanding over the LISTED documents — receivable within the window, ≥ 0.
        balance: fmt2(invoices.reduce((s, i) => s + i.outstanding, 0)),
        position: {
          receivable: fmt2(pos?.receivable ?? 0),
          creditBalance: fmt2(pos?.creditBalance ?? 0),
          depositBalance: fmt2(pos?.depositBalance ?? 0),
          netPosition: fmt2(pos?.netPosition ?? 0),
        },
      };
    });
    return {
      customers,
      totalBalance: fmt2(customers.reduce((s, c) => s + c.balance, 0)),
      totalReceivable: fmt2(customers.reduce((s, c) => s + c.position.receivable, 0)),
      totalCreditBalance: fmt2(customers.reduce((s, c) => s + c.position.creditBalance, 0)),
      totalDepositBalance: fmt2(customers.reduce((s, c) => s + c.position.depositBalance, 0)),
      totalNetPosition: fmt2(customers.reduce((s, c) => s + c.position.netPosition, 0)),
    };
  },

  /**
   * Changes in equity over a window (IAS 1.106: for each component, a
   * reconciliation from opening to closing showing profit or loss separately).
   *
   * 🔴 F-11 (fixed 2026-10-01): opening equity used to count only the equity
   * ACCOUNTS before `date_from`, leaving out every profit earned before the
   * window — so "closing equity" never equalled the balance sheet's total
   * equity, the figure this statement exists to reconcile to. Opening equity
   * is now equity accounts + all profit or loss before the window, and the
   * closing figure equals `balanceSheet(date_to).equity.total` exactly (a
   * test asserts it).
   *
   * Migration opening entries are OPENING (D14-03): the cut-over equity is the
   * position brought in, not a capital contribution of the window.
   * Contributions / withdrawals are the gross credits / debits on equity
   * accounts in the window (each ledger line is one-sided).
   */
  async ownerEquity(date_from?: string, date_to?: string) {
    const { from, to } = reportWindow(date_from, date_to);
    const accounts = await ledgerAccounts({ from, to, openingSourcesAsOpening: true });
    let openingH = 0, revenueH = 0, expensesH = 0, contributionsH = 0, withdrawalsH = 0;
    for (const a of accounts) {
      if (a.type === "equity") {
        openingH += -a.openingH;
        contributionsH += a.creditH;
        withdrawalsH += a.debitH;
      } else if (isIncomeType(a.type)) {
        openingH += -a.openingH;
        revenueH += a.creditH - a.debitH;
      } else if (a.type === "expense") {
        openingH += -a.openingH;
        expensesH += a.debitH - a.creditH;
      }
    }
    const netIncomeH = revenueH - expensesH;
    const closingH = openingH + netIncomeH + contributionsH - withdrawalsH;
    const openingEquity = fromHalalas(openingH);
    const netIncome = fromHalalas(netIncomeH);
    const closingEquity = fromHalalas(closingH);
    return {
      period: { from: from ?? "all", to: to ?? "all" },
      openingEquity, netIncome, contributions: fromHalalas(contributionsH), withdrawals: fromHalalas(withdrawalsH), closingEquity,
      // `key` is the contract; `label` is the English fallback. The page
      // translates by key — it used to match SUBSTRINGS of the English label
      // (D's English-coupling count, instance 6; closed 2026-09-15).
      breakdown: [
        { key: "openingEquity", label: "Opening Equity", amount: openingEquity },
        { key: "netIncome", label: "Net Income / (Loss)", amount: netIncome },
        { key: "contributions", label: "Capital Contributions", amount: fromHalalas(contributionsH) },
        { key: "withdrawals", label: "Withdrawals / Drawings", amount: fromHalalas(-withdrawalsH) },
        { key: "closingEquity", label: "Closing Equity", amount: closingEquity },
      ],
    };
  },

  /**
   * AR ageing AS OF a date (D14-08).
   *
   * - No date, or the business day: TODAY's ageing from the subledger caches
   *   (paid / credited / written-off amounts and the current customer
   *   positions) — unchanged from before Phase 14.
   * - A past date: the SAME documents, with what each still owed ON THAT DATE,
   *   rebuilt by replaying the customer-statement events up to it
   *   (`customerStatementRepository.events(null, { upTo })` — the one
   *   definition of "what moved the receivable"; an allocation is effective on
   *   the date of the journal it posted). Customer credits and deposits beside
   *   the buckets are replayed the same way.
   * PRECEDENT: Odoo 13 aged partner balance rebuilds the residual from
   * reconciliations dated on or before the as-of date and ages on
   * COALESCE(date_maturity, date); ERPNext `accounts_receivable.py`
   * `report_date` excludes later payments and ages on due date.
   * Invariants (F): at today both paths agree; at any date the buckets net of
   * the credits and deposits tie to the GL (a test pins both).
   */
  async arAging(as_of?: string) {
    const today = businessToday();
    const asOf = reportDate(as_of, "as_of") ?? today;
    // An ageing is a fact about a day that has happened: a future as-of date
    // would age TODAY's balances at a date nobody has seen. Refused, not guessed.
    if (asOf > today) throw new BadRequestError(`as_of (${asOf}) is in the future; an ageing can be taken up to today (${today}).`);
    // 🔴 Phase 11 B6: the business day, never the server's — due dates and
    // the as-of date are calendar days, so the difference is whole days.
    const asOfDay = new Date(`${asOf}T00:00:00Z`);
    const rows = await reportsRepository.invoicesWithCustomer();
    const docs = rows.filter(({ inv }) => inv.documentType !== "credit_note" && !isVatOnlyDocumentType(inv.documentType));

    let outstandingById: Map<number, number>; // halalas
    let creditsH: number, depositsH: number;
    if (asOf >= today) {
      outstandingById = new Map(docs.map(({ inv }) => [inv.id,
        toHalalas(inv.total) - toHalalas(inv.paidAmount) - toHalalas(inv.creditedAmount) - toHalalas(inv.writtenOffAmount)]));
      const positions = await customersRepository.customerBalances();
      creditsH = positions.reduce((s, p) => s + toHalalas(p.creditBalance), 0);
      depositsH = positions.reduce((s, p) => s + toHalalas(p.depositBalance), 0);
    } else {
      const events = await customerStatementRepository.events(null, { upTo: asOf });
      outstandingById = new Map();
      creditsH = 0; depositsH = 0;
      for (const e of events) {
        if (e.invoiceId != null && e.receivableDelta !== 0) outstandingById.set(e.invoiceId, (outstandingById.get(e.invoiceId) ?? 0) + toHalalas(e.receivableDelta));
        creditsH += toHalalas(e.creditDelta);
        depositsH += toHalalas(e.depositDelta);
      }
    }

    const buckets = { current: 0, days_1_30: 0, days_31_60: 0, days_61_90: 0, over_90: 0 };
    const items: { id: number; invoiceNumber: string; customerName: string; customerNameAr: string; dueDate: string | null; outstanding: number; daysPastDue: number }[] = [];
    for (const { inv, cust } of docs) {
      if (inv.date > asOf) continue; // not yet issued on the as-of date
      const outH = outstandingById.get(inv.id) ?? 0;
      if (Math.abs(outH) < 1) continue;
      const due = new Date(`${inv.dueDate ?? inv.date}T00:00:00Z`);
      const daysPast = Math.floor((asOfDay.getTime() - due.getTime()) / 86400000);
      const agedDays = outH > 0 ? daysPast : 0;
      items.push({ id: inv.id, invoiceNumber: inv.invoiceNumber, customerName: cust?.name ?? "Unknown", customerNameAr: cust?.nameAr ?? "", dueDate: inv.dueDate, outstanding: fromHalalas(outH), daysPastDue: Math.max(0, agedDays) });
      bucketInto(buckets, agedDays, outH);
    }
    const totalH = Object.values(buckets).reduce((s, v) => s + v, 0);
    return {
      asOf,
      basis: asOf >= today ? ("subledger" as const) : ("events" as const),
      buckets: halalaBuckets(buckets),
      total: fromHalalas(totalH),
      liabilities: { customerCredits: fromHalalas(creditsH), customerDeposits: fromHalalas(depositsH) },
      netCustomerPosition: fromHalalas(totalH - creditsH - depositsH),
      items: items.sort((a, b) => b.daysPastDue - a.daysPastDue),
    };
  },

  /**
   * AP ageing AS OF a date (D14-08) — the same two paths as AR. Today: what
   * each bill OWES by `billPosition`'s one definition, and the supplier
   * positions. A past date: the supplier-statement events replayed up to it.
   * Supplier money held on account (advances, deposits, unidentified) is one
   * figure at a past date — the events carry it as one component — and is
   * itemised only for today, where the classified positions exist.
   */
  async apAging(as_of?: string) {
    const today = businessToday();
    const asOf = reportDate(as_of, "as_of") ?? today;
    // An ageing is a fact about a day that has happened: a future as-of date
    // would age TODAY's balances at a date nobody has seen. Refused, not guessed.
    if (asOf > today) throw new BadRequestError(`as_of (${asOf}) is in the future; an ageing can be taken up to today (${today}).`);
    const asOfDay = new Date(`${asOf}T00:00:00Z`);
    const rows = await reportsRepository.billsWithVendor();
    const docs = rows.filter(({ bill }) => bill.documentType !== "credit_note");

    let owedById: Map<number, number>;
    let creditsH: number;
    let onAccount: { supplierAdvances: number | null; supplierDeposits: number | null; unidentifiedPayments: number | null; totalH: number };
    if (asOf >= today) {
      owedById = new Map(docs.map(({ bill, outstanding }) => [bill.id, toHalalas(outstanding)]));
      const positions = await supplierStatementService.positions();
      creditsH = positions.items.reduce((s, p) => s + toHalalas(p.creditBalance), 0);
      const adv = positions.items.reduce((s, p) => s + toHalalas(p.advanceBalance), 0);
      const dep = positions.items.reduce((s, p) => s + toHalalas(p.depositBalance), 0);
      const uni = positions.items.reduce((s, p) => s + toHalalas(p.unidentifiedBalance), 0);
      onAccount = { supplierAdvances: fromHalalas(adv), supplierDeposits: fromHalalas(dep), unidentifiedPayments: fromHalalas(uni), totalH: adv + dep + uni };
    } else {
      const events = await supplierStatementRepository.events(null, { upTo: asOf });
      owedById = new Map();
      creditsH = 0;
      let onAccountH = 0;
      for (const e of events) {
        if (e.billId != null && e.payableDelta !== 0) owedById.set(e.billId, (owedById.get(e.billId) ?? 0) + toHalalas(e.payableDelta));
        creditsH += toHalalas(e.creditDelta);
        onAccountH += toHalalas(e.onAccountDelta);
      }
      onAccount = { supplierAdvances: null, supplierDeposits: null, unidentifiedPayments: null, totalH: onAccountH };
    }

    const buckets = { current: 0, days_1_30: 0, days_31_60: 0, days_61_90: 0, over_90: 0 };
    const items: { id: number; billNumber: string; documentType: string; vendorName: string; vendorNameAr: string; dueDate: string | null; outstanding: number; daysPastDue: number }[] = [];
    for (const { bill, vendor } of docs) {
      if (bill.date > asOf) continue;
      const owedH = owedById.get(bill.id) ?? 0;
      if (owedH < 1) continue;
      const due = new Date(`${bill.dueDate ?? bill.date}T00:00:00Z`);
      const daysPast = Math.floor((asOfDay.getTime() - due.getTime()) / 86400000);
      items.push({ id: bill.id, billNumber: bill.billNumber, documentType: bill.documentType, vendorName: vendor?.name ?? "Unknown", vendorNameAr: vendor?.nameAr ?? "", dueDate: bill.dueDate, outstanding: fromHalalas(owedH), daysPastDue: Math.max(0, daysPast) });
      bucketInto(buckets, daysPast, owedH);
    }
    const totalH = Object.values(buckets).reduce((s, v) => s + v, 0);
    return {
      asOf,
      basis: asOf >= today ? ("subledger" as const) : ("events" as const),
      buckets: halalaBuckets(buckets),
      total: fromHalalas(totalH),
      assets: {
        supplierCredits: fromHalalas(creditsH),
        supplierAdvances: onAccount.supplierAdvances,
        supplierDeposits: onAccount.supplierDeposits,
        unidentifiedPayments: onAccount.unidentifiedPayments,
        onAccountTotal: fromHalalas(onAccount.totalH),
      },
      netSupplierPosition: fromHalalas(totalH - creditsH - onAccount.totalH),
      items: items.sort((a, b) => b.daysPastDue - a.daysPastDue),
    };
  },

  async taxJournalEntries(date_from?: string, date_to?: string) {
    const taxLines = await reportsRepository.taxLineEntryIds(date_from, date_to);
    const taxJeIds = [...new Set(taxLines.map((l) => l.journalEntryId))];
    if (taxJeIds.length === 0) return { entries: [], count: 0 };

    const entries = await reportsRepository.entriesByIds(taxJeIds);
    const lines = await reportsRepository.jeLinesByEntryIds(taxJeIds);

    const linesByEntry = new Map<number, typeof lines>();
    for (const l of lines) {
      if (!linesByEntry.has(l.journalEntryId)) linesByEntry.set(l.journalEntryId, []);
      linesByEntry.get(l.journalEntryId)!.push(l);
    }

    // 🔴 A tax line is a line on a TAX ACCOUNT — by system_code, the one
    // definition the posting path uses (2026-09-15, walk item 3; D's
    // English-coupling class, instance 7). The old test was a name regex
    // (/vat|tax|ضريبة|زكاة/), which flagged "Taxi expenses" and missed a
    // renamed VAT account.
    const taxIds = new Set((await reportsRepository.taxAccountIds()).map((r) => r.id));
    const isTax = (l: { accountId: number | null }) => l.accountId != null && taxIds.has(l.accountId);
    const result = entries.map((e) => {
      const entryLines = linesByEntry.get(e.id) ?? [];
      return {
        id: e.id, entryNumber: e.entryNumber, date: e.date, description: e.description, reference: e.reference,
        lines: entryLines.map((l) => ({ accountName: l.accountName, debit: fmt2(toNum(l.debitAmount)), credit: fmt2(toNum(l.creditAmount)), isTaxLine: isTax(l) })),
        totalVatDebit: fmt2(entryLines.filter(isTax).reduce((s, l) => s + toNum(l.debitAmount), 0)),
        totalVatCredit: fmt2(entryLines.filter(isTax).reduce((s, l) => s + toNum(l.creditAmount), 0)),
      };
    });

    return { entries: result, count: result.length };
  },

  async activity(date_from?: string, date_to?: string) {
    const entries = await reportsRepository.activityEntries(date_from, date_to);
    const lines = entries.length > 0 ? await reportsRepository.jeLinesByEntryIds(entries.map((e) => e.id)) : [];

    const linesByEntry = new Map<number, typeof lines>();
    for (const l of lines) {
      if (!linesByEntry.has(l.journalEntryId)) linesByEntry.set(l.journalEntryId, []);
      linesByEntry.get(l.journalEntryId)!.push(l);
    }

    const result = entries.map((e) => {
      const el = linesByEntry.get(e.id) ?? [];
      return {
        id: e.id, entryNumber: e.entryNumber, date: e.date, description: e.description, reference: e.reference, status: e.status,
        lineCount: el.length,
        totalDebit: fmt2(el.reduce((s, l) => s + toNum(l.debitAmount), 0)),
        accounts: [...new Set(el.map((l) => l.accountName))].slice(0, 3),
      };
    });

    return { activities: result, count: result.length, hasPosted: result.filter((r) => r.status === "posted").length, hasDraft: result.filter((r) => r.status === "draft").length };
  },

  async vatReturn(period_from?: string, period_to?: string) {
    const dateFrom = period_from ? `${period_from}-01` : "1900-01-01";
    const dateTo = period_to ? `${period_to}-31` : "2099-12-31";
    // AP-1: the deposits held at the end of the window that may carry VAT the
    // boxes do not show — a WHO-FINDS-OUT figure beside the return, never a
    // box (advance-payments decision pack §4; the boxes read documents only).
    const review = await depositReviewService.review({ asOf: period_to ? endOfMonth(period_to) : null });

    const [invoiceRows, invoiceLines, billRows, billLines, prepaymentRows, reliefRows, billPrepaymentRows, claimedBillRows, claimedBillLines, claimedBillPrepaymentRows] = await Promise.all([
      reportsRepository.invoicesInRange(dateFrom, dateTo),
      reportsRepository.invoiceLinesInRange(dateFrom, dateTo),
      reportsRepository.billsInRange(dateFrom, dateTo),
      reportsRepository.billLinesInRange(dateFrom, dateTo),
      reportsRepository.prepaymentsInRange(dateFrom, dateTo),
      reportsRepository.badDebtReliefsInRange(dateFrom, dateTo),
      reportsRepository.billPrepaymentsInRange(dateFrom, dateTo),
      reportsRepository.billsClaimedInRange(dateFrom, dateTo),
      reportsRepository.billLinesClaimedInRange(dateFrom, dateTo),
      reportsRepository.billPrepaymentsClaimedInRange(dateFrom, dateTo),
    ]);

    /**
     * 🔴 AUDIT FIX (Tier 1, finding 1): classify per LINE from
     * `tax_category_code`, never by reconstructing a rate from rounded header
     * cents. The old header inference (`vat/subtotal*100`, branches `>= 14.9`
     * / `=== 0`) silently dropped every MIXED-RATE document (S+Z lines ⇒
     * header rate between the branches ⇒ absent from every box, including
     * output VAT the GL had posted), dropped small 15% documents whose rounded
     * rate fell below 14.9%, and filed EXEMPT documents in the zero-rated box.
     * Credit notes against such documents never reduced output VAT.
     *
     * The M12.1b sign discipline is unchanged: amounts are stored positive,
     * `documentSign()` is applied to every contribution, per line.
     *
     * Legacy fallbacks, stated: a line with NULL `tax_category_code` (pre-
     * M12.1a data; 0%-rate lines the migration deliberately left ambiguous)
     * classifies by VAT presence — vat > 0 ⇒ 'S', else 'Z' (preserving the old
     * report's placement for legacy zero-VAT lines). A document with NO line
     * rows at all (bills may be created header-only) classifies its header the
     * same way. 'O' (out of scope) lines are not consideration for a supply
     * and appear in no box. Box 4 (exports) stays 0 — nothing marks a sale as
     * an export yet; an export today is a 'Z' line and lands in box 2.
     */
    const invLinesByDoc = new Map<number, (typeof invoiceLines)[number][]>();
    for (const l of invoiceLines) {
      (invLinesByDoc.get(l.invoiceId) ?? invLinesByDoc.set(l.invoiceId, []).get(l.invoiceId)!).push(l);
    }

    let standardRatedSales = 0, outputVat = 0, zeroRatedSales = 0, exemptSales = 0;
    for (const inv of invoiceRows) {
      const sign = documentSign(inv.documentType);
      const lines = invLinesByDoc.get(inv.id) ?? [];
      if (lines.length === 0) {
        const subtotal = toNum(inv.subtotal);
        const vat = toNum(inv.vatAmount);
        if (vat > 0) { standardRatedSales += sign * subtotal; outputVat += sign * vat; }
        else zeroRatedSales += sign * subtotal;
        continue;
      }
      for (const { line } of lines) {
        const vat = toNum(line.vatAmount);
        const net = toNum(line.total) - vat;
        const code = line.taxCategoryCode ?? (vat > 0 ? "S" : "Z");
        if (code === "S") { standardRatedSales += sign * net; outputVat += sign * vat; }
        else if (code === "Z") zeroRatedSales += sign * net;
        else if (code === "E") exemptSales += sign * net;
        // "O": out of scope — on no box of the return.
      }
    }
    /**
     * 🔴 AP-2 — the ADVANCE and its ADJUSTMENT, declared ONCE. An advance tax
     * invoice (386) is an invoice row above: its line files the advance's
     * base and VAT in the period of ITS date (the tax point at receipt —
     * GCC Agreement Art. 23(1), IR Art. 53(1)(a)(2)). The final invoice's
     * lines above carry the FULL supply (the XML shows full lines plus the
     * adjustment lines, XML Standard ¶9.5), so the part the 386 already
     * declared is taken back here, per category, from the prepayment rows
     * finalised at that invoice's issue — the same rows its GL entry netted
     * (invoices.approvable E3). Box 1 + box 6 over both periods then equal
     * the supply once; nothing is declared twice and nothing is dropped.
     */
    for (const { row } of prepaymentRows) {
      const taxable = toNum(row.taxableAmount);
      const tax = toNum(row.taxAmount);
      if (row.taxCategoryCode === "S") { standardRatedSales -= taxable; outputVat -= tax; }
      else if (row.taxCategoryCode === "Z") zeroRatedSales -= taxable;
      else if (row.taxCategoryCode === "E") exemptSales -= taxable;
    }

    /**
     * The purchase side, per line — ONE set of rules, run over two selections
     * of the same documents (Phase 13A narrow guard): the PURCHASE amounts of
     * the documents dated in this period (boxes 9/10/12, unchanged), and the
     * INPUT VAT of the documents whose VAT is CLAIMED in this period (boxes
     * 13/15 — `billsClaimedInRange`: evidenced VAT in its claim period; held,
     * blocked and capitalised VAT on no return). Nothing else moved.
     */
    const purchasesOf = (
      billSet: typeof billRows, lineSet: typeof billLines, prepaymentSet: typeof billPrepaymentRows,
    ) => {
      const billLinesByDoc = new Map<number, (typeof lineSet)[number][]>();
      for (const l of lineSet) {
        (billLinesByDoc.get(l.billId) ?? billLinesByDoc.set(l.billId, []).get(l.billId)!).push(l);
      }

      let standardRatedPurchases = 0, inputVat = 0, zeroRatedPurchases = 0;
      for (const bill of billSet) {
        /**
         * 🔴 B7 (2026-09-22) — THE PURCHASE SIDE CARRIES A SIGN, and until
         * this batch it did not. A supplier CREDIT NOTE reduces the input tax we
         * may deduct; filing it positive would claim a deduction twice, in the
         * one direction the taxpayer benefits from and the auditor looks for.
         *
         * 🔴 And it lands in the note's OWN period: IR Art. 40(6) has the
         * CUSTOMER correct its Input Tax "in the Tax Period in which the Credit
         * Note or Debit Note is issued". This loop filters on `bills.date`, which
         * for a note is the SUPPLIER'S issue date — so the correction files in
         * the right period by construction, never re-dated into the supply's.
         *
         * A DEBIT note is +1: an additional charge, not a reversal.
         */
        const sign = documentSign(bill.documentType);
        const lines = billLinesByDoc.get(bill.id) ?? [];
        if (lines.length === 0) {
          if (toNum(bill.vatAmount) > 0) { standardRatedPurchases += sign * toNum(bill.subtotal); inputVat += sign * toNum(bill.vatAmount); }
          else zeroRatedPurchases += sign * toNum(bill.subtotal);
          continue;
        }
        for (const { line } of lines) {
          const vat = toNum(line.vatAmount);
          const net = toNum(line.total) - vat;
          if (vat > 0) { standardRatedPurchases += sign * net; inputVat += sign * vat; }
          else zeroRatedPurchases += sign * net;
        }
      }

      /**
       * 🔴 Z-AP1 (2026-09-24, accountant answer A) — THE SAME INPUT VAT IS NEVER
       * CLAIMED TWICE. The supplier's ADVANCE tax invoice is a bill row above: its
       * line claimed the advance's base and VAT in ITS period (IR Art. 49(7) —
       * we held the invoice; GCC Agreement Art. 23(1) — their tax point was our
       * payment). The supplier's FINAL invoice shows the full supply (the XML
       * Standard's worked example: TaxInclusiveAmount on the full base, the
       * prepayment only in KSA-31/32), so its lines above claimed the full VAT;
       * the part the advance invoice already claimed is taken back here, per
       * rate, from the prepayment rows finalised at the bill's approval — the
       * same rows its GL entry netted. A refund of the advance is the supplier's
       * credit note against the advance invoice: a bill row above, signed −1, in
       * the note's period (IR Art. 40(6)).
       */
      for (const { row } of prepaymentSet) {
        const taxable = toNum(row.taxableAmount);
        const tax = toNum(row.taxAmount);
        if (tax > 0) { standardRatedPurchases -= taxable; inputVat -= tax; }
        else zeroRatedPurchases -= taxable;
      }
      return { standardRatedPurchases, zeroRatedPurchases, inputVat };
    };
    const { standardRatedPurchases, zeroRatedPurchases } = purchasesOf(billRows, billLines, billPrepaymentRows);
    const { inputVat } = purchasesOf(claimedBillRows, claimedBillLines, claimedBillPrepaymentRows);

    /**
     * 🔴 2026-09-22 — BAD-DEBT RELIEF (IR Art. 40(7)): the Output Tax on
     * consideration never received is REDUCED in the return for the period in
     * which the conditions were met (the claim date) — box 7, an adjustment,
     * never a rewrite of the supply's own period. The Art. 40(9) recovery
     * invoice is an ordinary row above: it files positive in the payment's
     * period. Only reliefs claimed HERE appear; a migrated relief was in the
     * previous system's return.
     */
    const badDebtReliefVat = fmt2(reliefRows.reduce((s, r) => s + toNum(r.reliefVat), 0));
    const vatAdjustments = -badDebtReliefVat;
    const netVatDue = outputVat + vatAdjustments - inputVat;
    return {
      period: { from: dateFrom, to: dateTo },
      depositReview: { asOf: review.asOf, needsReviewCount: review.needsReviewCount, needsReviewAmount: fmt2(review.needsReviewAmount), overdueCount: review.overdueCount },
      salesSection: {
        box1_standardRatedDomesticSales: fmt2(standardRatedSales),
        box2_zeroRatedDomesticSales: fmt2(zeroRatedSales),
        box3_exemptSales: fmt2(exemptSales),
        box4_exportSales: 0,
        box5_totalSales: fmt2(standardRatedSales + zeroRatedSales + exemptSales),
        box6_vatOnStandardRatedSales: fmt2(outputVat),
        box7_vatAdjustments: fmt2(vatAdjustments),
        box8_totalOutputVat: fmt2(outputVat + vatAdjustments),
        badDebtReliefs: reliefRows.map((r) => ({ invoiceId: r.id, invoiceNumber: r.invoiceNumber, claimedOn: r.claimedOn!, writtenOffAmount: fmt2(toNum(r.writtenOff)), reliefVat: fmt2(toNum(r.reliefVat)) })),
      },
      purchasesSection: {
        box9_standardRatedPurchases: fmt2(standardRatedPurchases),
        box10_zeroRatedPurchases: fmt2(zeroRatedPurchases),
        box11_exemptPurchases: 0,
        box12_totalPurchases: fmt2(standardRatedPurchases + zeroRatedPurchases),
        box13_recoverableInputVat: fmt2(inputVat),
        box14_inputVatAdjustments: 0,
        box15_totalInputVat: fmt2(inputVat),
      },
      netVatDue: fmt2(netVatDue),
      vatPayable: netVatDue > 0 ? fmt2(netVatDue) : 0,
      vatRefund: netVatDue < 0 ? fmt2(-netVatDue) : 0,
      invoiceCount: invoiceRows.length,
      billCount: billRows.length,
    };
  },
};
