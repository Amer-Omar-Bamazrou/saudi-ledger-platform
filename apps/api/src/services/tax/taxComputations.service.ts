/**
 * ZAKAT AND INCOME-TAX COMPUTATIONS — Phase 16B/16C/16D
 * (docs/product/phase-16-17-tax-treasury-decision-pack.md §3–§5).
 *
 *   computation (company × kind × FROZEN fiscal year)
 *     └─ versions: draft → submitted → approved → superseded (the ONE approval engine)
 *          └─ adjustments — the tax-adjustment model: target, effect, amount, reason, article, source
 *
 * Inputs are READ, never re-keyed: the Phase 14 balance sheet and income
 * statement (one seam), the org's Zakat classification, the fixed-asset
 * register's Art. 17 pool. The pure engines (`zakatEngine`, `incomeTaxEngine`)
 * do the arithmetic and return every step with its article.
 *
 * 🔴 The ONLY ledger effect is the approval's ACCRUAL — the difference between
 * this version's amount and what earlier versions of the same computation
 * accrued — posted forward through `postJournalEntry`: dated the fiscal
 * year-end if that period is open, otherwise today, as a change in estimate
 * (SOCPA Zakat Standard para 5; IAS 8.36) — never re-dated into a closed
 * period, never silently skipped. Nothing affects the books before approval.
 */
import { createHash } from "node:crypto";
import { businessToday } from "@workspace/shared";
import { SYSTEM_ACCOUNTS, type TaxComputation, type TaxComputationVersion, type ZakatClass } from "@workspace/db";
import { BadRequestError, BusinessRuleError, NotFoundError, PeriodLockedError } from "../../lib/errors";
import { fromHalalas, toHalalas } from "../../lib/money";
import { isFiscalCalendar, resolveFiscalYear, type FiscalCalendar } from "../../lib/fiscalYear";
import { zakatScopeFor } from "../../lib/zakatScope";
import { companiesRepository } from "../../repositories/companies.repository";
import { taxRepository } from "../../repositories/tax.repository";
import { reportsRepository } from "../../repositories/reports.repository";
import { reportsService } from "../reports.service";
import { incomeTaxPoolService } from "../assets/incomeTaxPool.service";
import { postJournalEntry } from "../accounting/glPosting";
import { checkPeriodOpen } from "../accounting/periodLock";
import { auditService } from "../audit.service";
import { approvalService, type Approvable, type ApprovalState } from "../approval";
import { computeZakat, type ZakatLine, type ZakatResult } from "./zakatEngine";
import { computeIncomeTax, type IncomeTaxResult } from "./incomeTaxEngine";
import { ZAKAT_CLASS_ARTICLE, accountIdOfKey, withoutOwnAccrualH } from "./zakatClassification.service";

export type TaxKind = "zakat" | "income_tax";
const KINDS: TaxKind[] = ["zakat", "income_tax"];
const MAX_ID = 2_147_483_647;
/** Decision 1007 item ثالثاً: the 1445H Regulations apply to fiscal years starting on or after 1/1/2024. */
const ZAKAT_REGULATIONS_FROM = "2024-01-01";

const refuse = (status: number, code: string, error: string, extra: Record<string, unknown> = {}): never => {
  throw new BusinessRuleError(status, { code, error, ...extra });
};
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const H = fromHalalas;

function fiscalYearOf(c: TaxComputation) {
  return { calendar: c.fiscalCalendar as FiscalCalendar, startMonth: c.fiscalStartMonth, label: c.fiscalLabel, startDate: c.fiscalYearStart, endDate: c.fiscalYearEnd };
}
function daysOf(c: TaxComputation): number {
  return Math.round((Date.parse(`${c.fiscalYearEnd}T00:00:00Z`) - Date.parse(`${c.fiscalYearStart}T00:00:00Z`)) / 86_400_000) + 1;
}
function versionOut(v: TaxComputationVersion) {
  return {
    id: v.id, versionNo: v.versionNo, status: v.status as "draft" | "submitted" | "approved" | "superseded",
    basedOnVersionId: v.basedOnVersionId ?? null, notes: v.notes ?? null, sendBackNote: v.sendBackNote ?? null,
    lossCarryforwardAvailable: v.lossCarryforwardAvailable == null ? null : Number(v.lossCarryforwardAvailable),
    lossCarryforwardReference: v.lossCarryforwardReference ?? null,
    createdBy: v.createdBy ?? null, createdAt: iso(v.createdAt)!, submittedBy: v.submittedBy ?? null, submittedAt: iso(v.submittedAt),
    approvedBy: v.approvedBy ?? null, approvedAt: iso(v.approvedAt), supersededAt: iso(v.supersededAt),
    resultAmount: v.resultAmount == null ? null : Number(v.resultAmount),
    accruedAmount: v.accruedAmount == null ? null : Number(v.accruedAmount),
    accrualDate: v.accrualDate ?? null, accrualJournalEntryId: v.accrualJournalEntryId ?? null,
  };
}
const isOpen = (v: TaxComputationVersion) => v.status === "draft" || v.status === "submitted";

// ── inputs: read, never re-keyed ───────────────────────────────────────────

type Blocker = { code: string; message: string; accounts?: { key: string; name: string; nameAr: string; amount: number }[] };


async function zakatInputs(c: TaxComputation, adjustments: Awaited<ReturnType<typeof taxRepository.adjustmentsOf>>) {
  const blockers: Blocker[] = [];
  const company = await companiesRepository.findCurrent();
  const scope = zakatScopeFor(company?.ownershipType ?? null);
  if (scope.status !== "eligible") {
    blockers.push(scope.status === "not_declared"
      ? { code: "zakat_ownership_not_declared", message: "The company has not declared its ownership. Zakat is computed for a 100 % Saudi/GCC-owned company (owner decision Q2); declare it in Company Settings." }
      : { code: "zakat_not_eligible", message: `This company is declared ${scope.ownershipType === "FOREIGN" ? "foreign-owned" : "mixed-owned"}. The Zakat working paper covers a 100 % Saudi/GCC-owned company only (owner decision Q2; mixed ownership's mechanics are open question Z-5).` });
  }
  if (c.fiscalYearStart < ZAKAT_REGULATIONS_FROM) {
    blockers.push({ code: "zakat_regulations_not_in_force", message: `This fiscal year starts ${c.fiscalYearStart}. The 1445H Regulations (Decision 1007) apply to fiscal years starting on or after 1/1/2024; an earlier year's rules are not modelled.` });
  }

  // The computation's own accruals are excluded from its inputs (pack §3.4, Z-3).
  const ownEntries = await taxRepository.accrualEntryIds(c.id);
  const effects = await taxRepository.entryEffects(ownEntries, c.fiscalYearEnd);
  const effectBy = new Map(effects.map((e) => [e.accountId, e.debitPositive]));

  const [bs, is] = await Promise.all([reportsService.balanceSheet(c.fiscalYearEnd), reportsService.incomeStatement(c.fiscalYearStart, c.fiscalYearEnd)]);
  if (!bs.balanced) blockers.push({ code: "zakat_balance_sheet_unbalanced", message: `The balance sheet at ${c.fiscalYearEnd} does not balance (${bs.warning ?? "assets ≠ liabilities + equity"}); the base is read from it, so it must balance first.` });

  const classes = new Map((await taxRepository.classifications()).map((x) => [x.accountId, x.classification as ZakatClass]));
  const lines: ZakatLine[] = [];
  const unclassified: NonNullable<Blocker["accounts"]> = [];
  const legacy: NonNullable<Blocker["accounts"]> = [];
  // P&L effects of the excluded accruals (debit-positive on expense accounts) raise the result back.
  const cats = await reportsRepository.allCategories();
  const plType = new Map(cats.map((x) => [x.id, x.type]));
  let excludedPlH = 0;
  for (const e of effects) {
    const t = plType.get(e.accountId);
    if (t === "expense" || t === "income" || t === "revenue") excludedPlH += toHalalas(e.debitPositive);
  }

  let totalAssetsH = 0;
  const push = (section: "asset" | "liability" | "equity", item: { key: string; name: string; nameAr: string; amount: number }) => {
    const accountId = accountIdOfKey(item.key);
    // undo the own-accrual effect on this account: assets are debit-positive, liabilities/equity credit-positive
    const eff = accountId != null ? toHalalas(effectBy.get(accountId) ?? 0) : 0;
    const amountH = withoutOwnAccrualH(section, toHalalas(item.amount), eff);
    if (section === "asset") totalAssetsH += amountH;
    if (amountH === 0) return;
    if (section === "equity") { lines.push({ accountId, key: item.key, name: item.name, nameAr: item.nameAr, zakatClass: "equity", amountH }); return; }
    if (accountId == null) { legacy.push({ ...item, amount: H(amountH) }); return; }
    const cls = classes.get(accountId);
    if (!cls) { unclassified.push({ ...item, amount: H(amountH) }); return; }
    lines.push({ accountId, key: item.key, name: item.name, nameAr: item.nameAr, zakatClass: cls, amountH });
  };
  for (const a of bs.assets.items) push("asset", a);
  for (const l of bs.liabilities.items) push("liability", l);
  for (const e of bs.equity.items) push("equity", { ...e, nameAr: e.nameAr ?? "" });
  // the result not yet allocated by any entry — prior years and the year itself (D14-05), before this computation's own charge
  const priorH = toHalalas(bs.equity.priorYearsProfit);
  const currentH = toHalalas(bs.equity.currentYearProfit) + excludedPlH;
  if (priorH !== 0) lines.push({ accountId: null, key: "prior_years_result", name: "Result of prior years (not yet allocated)", nameAr: "نتائج سنوات سابقة (غير موزعة)", zakatClass: "equity_computed", amountH: priorH });
  if (currentH !== 0) lines.push({ accountId: null, key: "current_year_result", name: "Result of the year", nameAr: "نتيجة السنة", zakatClass: "equity_computed", amountH: currentH });

  // 🔴 A CONFIDENT ZERO (audit 2026-10-04): with nothing in the books at the year-end — no balance on any
  // account, no result — the engine would compute a base of 0 and an approval would freeze "Zakat 0.00" for a
  // year the books simply do not cover. An empty ledger is not an answer; it blocks, by name.
  if (bs.assets.items.length === 0 && bs.liabilities.items.length === 0 && bs.equity.items.length === 0 && priorH === 0 && currentH === 0) {
    blockers.push({ code: "zakat_no_books", message: `Nothing is in the books at ${c.fiscalYearEnd}: no account carries a balance and the year has no result. A Zakat base read from an empty ledger would be a confident zero — record the year (or its opening balances) first.` });
  }
  if (unclassified.length) blockers.push({ code: "zakat_unclassified_accounts", message: `${unclassified.length} balance-sheet account(s) carry a balance at ${c.fiscalYearEnd} with no Zakat classification. Each must be classified by a person — none is assumed.`, accounts: unclassified });
  if (legacy.length) blockers.push({ code: "zakat_legacy_lines", message: `${legacy.length} ledger line group(s) name no account and cannot be classified.`, accounts: legacy });

  const bookNetProfitH = toHalalas(is.netIncome) + excludedPlH;

  // Z2 — the year's result in the balance sheet IS the income statement for the year (when the company's fiscal year is the computation's)
  const sameYear = bs.equity.fiscalYear != null && bs.equity.fiscalYear.startDate === c.fiscalYearStart && bs.equity.fiscalYear.endDate === c.fiscalYearEnd;
  const reconciliation = {
    // Z1: Σ the asset rows read (after this computation's own accrual is taken out) = the balance sheet's total assets
    balanceSheetTotalAssets: bs.assets.total,
    assetsRead: H(totalAssetsH),
    classifiedAssets: H(lines.filter((l) => l.zakatClass.includes("asset")).reduce((s, l) => s + l.amountH, 0)),
    bookNetProfit: H(bookNetProfitH),
    balanceSheetYearResult: sameYear ? H(currentH) : null,
    bookProfitMatchesBalanceSheet: sameYear ? currentH === bookNetProfitH : null,
    excludedOwnAccruals: ownEntries.length,
  };

  const adj = adjustments.map((a) => ({ target: a.target as "adjusted_net_profit" | "zakat_base", effect: a.effect as "increase" | "decrease", amountH: toHalalas(a.amount) }));
  const inputs = { lines, totalAssetsH, bookNetProfitH, adjustments: adj, calendar: c.fiscalCalendar as "gregorian" | "hijri", fiscalYearDays: daysOf(c) };
  return { inputs, blockers, reconciliation };
}

async function incomeTaxInputs(c: TaxComputation, v: TaxComputationVersion, adjustments: Awaited<ReturnType<typeof taxRepository.adjustmentsOf>>) {
  const blockers: Blocker[] = [];
  const company = await companiesRepository.findCurrent();
  const ownership = company?.ownershipType ?? null;
  let foreignShareBp = 0;
  if (ownership == null) blockers.push({ code: "ownership_not_declared", message: "The company has not declared its ownership; income tax applies to the shares owned by non-Saudis (Income Tax Law Art. 2(a)). Declare it in Company Settings." });
  else if (ownership === "SAUDI_GCC") blockers.push({ code: "income_tax_not_applicable", message: "This company is 100 % Saudi/GCC-owned: it pays Zakat, not income tax (Zakat Regulations Art. 6(1); Income Tax Law Art. 2)." });
  else if (ownership === "FOREIGN") foreignShareBp = 10000;
  else {
    const pct = company?.foreignOwnershipPct == null ? null : Number(company.foreignOwnershipPct);
    if (pct == null) blockers.push({ code: "foreign_share_not_declared", message: "A mixed-owned company declares its non-Saudi share in Company Settings; the tax base is that share of the taxable income (Art. 6(a))." });
    else foreignShareBp = Math.round(pct * 100);
    if (Number(v.lossCarryforwardAvailable ?? 0) > 0) {
      blockers.push({ code: "income_tax_mixed_losses_open", message: "For a mixed-owned company, whether the 25 % loss cap applies before or after the non-Saudi share is not settled by the text (open question I-1); losses carried forward are not computed for it." });
    }
  }

  const ownEntries = await taxRepository.accrualEntryIds(c.id);
  const [is, mv] = await Promise.all([
    reportsService.incomeStatement(c.fiscalYearStart, c.fiscalYearEnd),
    taxRepository.movementBySystemCode([SYSTEM_ACCOUNTS.ZAKAT_EXPENSE, SYSTEM_ACCOUNTS.INCOME_TAX_EXPENSE, SYSTEM_ACCOUNTS.DEPRECIATION_EXPENSE, SYSTEM_ACCOUNTS.ASSET_DISPOSAL_GAIN_LOSS], c.fiscalYearStart, c.fiscalYearEnd),
  ]);
  const taxesInPl = (mv.get(SYSTEM_ACCOUNTS.ZAKAT_EXPENSE) ?? 0) + (mv.get(SYSTEM_ACCOUNTS.INCOME_TAX_EXPENSE) ?? 0);
  // 🔴 A CONFIDENT ZERO (audit 2026-10-04): a year with no income-statement movement at all would compute
  // taxable income 0 and approve "income tax 0.00" for a year the books do not cover — blocked, by name.
  if (is.revenue.length === 0 && is.expenses.length === 0 && is.zakatAndIncomeTax.items.length === 0) {
    blockers.push({ code: "income_tax_no_books", message: `The income statement for ${c.fiscalYearStart} – ${c.fiscalYearEnd} has no movement at all. Taxable income read from an empty year would be a confident zero — record the year first.` });
  }
  const profitBeforeTaxesH = toHalalas(is.netIncome) + toHalalas(taxesInPl);
  // IT-1 (final audit 2026-10-05): book depreciation is added back WHEREVER the register posted it — the system account,
  // and a category's own expense account (the category API accepts any expense account); never other expenses there.
  const bookDepreciationH = toHalalas(mv.get(SYSTEM_ACCOUNTS.DEPRECIATION_EXPENSE) ?? 0)
    + toHalalas(await taxRepository.registerDepreciationOffSystemAccount(c.fiscalYearStart, c.fiscalYearEnd));
  const bookDisposalResultH = -toHalalas(mv.get(SYSTEM_ACCOUNTS.ASSET_DISPOSAL_GAIN_LOSS) ?? 0);

  // Art. 17 — the pool the register computes (FA-1), for this fiscal year
  let poolDeductionH = 0, poolExcessIncomeH = 0, repairsOverCapH = 0;
  let pool: { status: string; reason: string | null } = { status: "not_requested", reason: null };
  if (ownership === "FOREIGN" || ownership === "MIXED") {
    const report = await incomeTaxPoolService.report({ toYear: c.fiscalLabel });
    pool = { status: report.status, reason: (report as { reason?: string | null }).reason ?? null };
    if (report.status !== "computed") {
      blockers.push({ code: "income_tax_pool_not_computed", message: `The Art. 17 depreciation pool cannot be computed for this year: ${pool.reason ?? report.status}. Taxable income deducts the pool, not book depreciation — resolve it on the Income-tax pool page.` });
    } else {
      const year = (report as { years: { taxYear: number; groups: { depreciationDeduction: number; excessTaxableIncome: number; repairs: { addedToPool: number }; elections: { smallBalance: { amount: number; taken: boolean }; groupClosed: { amount: number; taken: boolean } } }[] }[] }).years.find((y) => y.taxYear === c.fiscalLabel);
      if (!year) blockers.push({ code: "income_tax_pool_year_missing", message: `The Art. 17 pool has no year ${c.fiscalLabel} (it starts at its declared anchor year).` });
      else for (const g of year.groups) {
        poolDeductionH += toHalalas(g.depreciationDeduction) + (g.elections.smallBalance.taken ? toHalalas(g.elections.smallBalance.amount) : 0) + (g.elections.groupClosed.taken ? toHalalas(g.elections.groupClosed.amount) : 0);
        poolExcessIncomeH += toHalalas(g.excessTaxableIncome);
        repairsOverCapH += toHalalas(g.repairs.addedToPool);
      }
    }
  }

  const inputs = {
    profitBeforeTaxesH, bookDepreciationH, bookDisposalResultH, poolDeductionH, poolExcessIncomeH, repairsOverCapH,
    adjustments: adjustments.map((a) => ({ effect: a.effect as "increase" | "decrease", amountH: toHalalas(a.amount) })),
    lossCarryforwardAvailableH: toHalalas(v.lossCarryforwardAvailable ?? 0),
    foreignShareBp,
  };
  const reconciliation = { profitPerIncomeStatement: is.netIncome, zakatAndIncomeTaxAddedBack: taxesInPl, pool, excludedOwnAccruals: ownEntries.length, ownership };
  return { inputs, blockers, reconciliation };
}

/** The live computation of a version: its inputs, the engine's result (or why there is none), and their fingerprint. */
async function compute(c: TaxComputation, v: TaxComputationVersion) {
  const adjustments = await taxRepository.adjustmentsOf(v.id);
  if (c.kind === "zakat") {
    const { inputs, blockers, reconciliation } = await zakatInputs(c, adjustments);
    const result: ZakatResult | null = blockers.length ? null : computeZakat(inputs);
    return { kind: "zakat" as const, inputs, blockers, reconciliation, result, amountH: result?.zakatH ?? null, fingerprint: fingerprintOf(inputs), adjustments };
  }
  const { inputs, blockers, reconciliation } = await incomeTaxInputs(c, v, adjustments);
  const result: IncomeTaxResult | null = blockers.length ? null : computeIncomeTax(inputs);
  return { kind: "income_tax" as const, inputs, blockers, reconciliation, result, amountH: result?.incomeTaxH ?? null, fingerprint: fingerprintOf(inputs), adjustments };
}

function fingerprintOf(inputs: unknown): string {
  return createHash("sha256").update(JSON.stringify(inputs)).digest("hex");
}

/** A computation as the API shows it: halalas → riyals, articles beside every class. */
function presentComputation(x: Awaited<ReturnType<typeof compute>>) {
  const adjustments = x.adjustments.map((a) => ({
    id: a.id, target: a.target, effect: a.effect, amount: Number(a.amount), reason: a.reason, legalReference: a.legalReference,
    sourceReference: a.sourceReference ?? null, accountId: a.accountId ?? null, createdBy: a.createdBy ?? null, createdAt: iso(a.createdAt)!,
  }));
  if (x.kind === "zakat") {
    const r = x.result;
    return {
      kind: x.kind, blockers: x.blockers, reconciliation: x.reconciliation, adjustments, fingerprint: x.fingerprint,
      amount: x.amountH == null ? null : H(x.amountH),
      zakat: {
        lines: x.inputs.lines.map((l) => ({ accountId: l.accountId, key: l.key, name: l.name, nameAr: l.nameAr, zakatClass: l.zakatClass, article: l.zakatClass === "equity_computed" ? "23(1)" : ZAKAT_CLASS_ARTICLE[l.zakatClass], amount: H(l.amountH) })),
        bookNetProfit: H(x.inputs.bookNetProfitH), fiscalYearDays: x.inputs.fiscalYearDays, calendar: x.inputs.calendar,
        result: r == null ? null : {
          equity: H(r.equityH), provisions: H(r.provisionsH),
          nonCurrentAssets: H(r.nonCurrentAssetsH), nonCurrentDeducted: H(r.nonCurrentDeductedH), nonCurrentNotDeducted: H(r.nonCurrentNotDeductedH),
          currentAssets: H(r.currentAssetsH), currentDeducted: H(r.currentDeductedH), currentNotDeducted: H(r.currentNotDeductedH),
          nonCurrentLiabilities: H(r.nonCurrentLiabilitiesH), currentLiabilities: H(r.currentLiabilitiesH),
          deductions: H(r.deductionsH),
          nonCurrentLiabilitiesExcluded: r.nclExcluded.map((e) => ({ accountId: e.accountId, name: e.name, nameAr: e.nameAr, asset: H(e.assetH), excluded: H(e.excludedH) })),
          nonCurrentLiabilitiesExcludedTotal: H(r.nclExcludedH),
          currentLiabilitiesAddedForDeducted: r.clAddedForDeducted.map((e) => ({ accountId: e.accountId, name: e.name, nameAr: e.nameAr, asset: H(e.assetH), added: H(e.addedH) })),
          currentLiabilitiesAddedForDeductedTotal: H(r.clAddedForDeductedH),
          currentLiabilitiesExcessOverCurrentAssets: H(r.clExcessOverCaH),
          liabilitiesAddedBeforeCap: H(r.liabilitiesAddedBeforeCapH), liabilitiesAdded: H(r.liabilitiesAddedH),
          bookNetProfit: H(r.bookNetProfitH), netProfitAdjustments: H(r.netProfitAdjustmentsH), adjustedNetProfit: H(r.adjustedNetProfitH),
          baseAdjustments: H(r.baseAdjustmentsH), difference: H(r.differenceH),
          baseByMethod: H(r.baseByMethodH), undeductedAssets: H(r.undeductedAssetsH), minimumRule: r.minimumRule,
          baseAfterMinimum: H(r.baseAfterMinimumH), maximum: H(r.maximumH), maximumApplied: r.maximumApplied, floorAboveCeiling: r.floorAboveCeiling,
          zakatBase: H(r.zakatBaseH), rate: r.rate, zakat: H(r.zakatH),
          steps: r.steps.map((s) => ({ key: s.key, article: s.article, amount: H(s.amountH) })),
        },
      },
      incomeTax: null,
    };
  }
  const r = x.result;
  return {
    kind: x.kind, blockers: x.blockers, reconciliation: x.reconciliation, adjustments, fingerprint: x.fingerprint,
    amount: x.amountH == null ? null : H(x.amountH),
    zakat: null,
    incomeTax: r == null ? null : {
      profitBeforeTaxes: H(r.profitBeforeTaxesH), bookDepreciationAddBack: H(r.bookDepreciationAddBackH), bookDisposalReversal: H(r.bookDisposalReversalH),
      poolDeduction: H(r.poolDeductionH), poolExcessIncome: H(r.poolExcessIncomeH), repairsOverCap: H(r.repairsOverCapH),
      declaredAdjustments: H(r.declaredAdjustmentsH), taxableIncome: H(r.taxableIncomeH),
      lossCap: H(r.lossCapH), lossUsed: H(r.lossUsedH), taxableIncomeAfterLosses: H(r.taxableIncomeAfterLossesH),
      foreignSharePct: r.foreignShareBp / 100, taxableShare: H(r.taxableShareH), rate: r.rate, incomeTax: H(r.incomeTaxH), lossOfTheYear: H(r.lossOfTheYearH),
      steps: r.steps.map((s) => ({ key: s.key, article: s.article, amount: H(s.amountH) })),
    },
  };
}

// ── loading ────────────────────────────────────────────────────────────────
async function loadComputation(id: number): Promise<TaxComputation> {
  if (!Number.isSafeInteger(id) || id <= 0 || id > MAX_ID) throw new NotFoundError("Tax computation not found.");
  const c = await taxRepository.computationById(id);
  if (!c) throw new NotFoundError("Tax computation not found.");
  return c;
}
async function loadVersionOf(computationId: number, versionId: number): Promise<TaxComputationVersion> {
  if (!Number.isSafeInteger(versionId) || versionId <= 0 || versionId > MAX_ID) throw new NotFoundError("Version not found.");
  const v = await taxRepository.lockVersion(versionId);
  if (!v || v.computationId !== computationId) throw new NotFoundError("Version not found.");
  return v;
}
function lockedError(v: TaxComputationVersion) {
  return new BusinessRuleError(409, {
    code: "tax_version_locked", status: v.status,
    error: `Version ${v.versionNo} is ${v.status}: it is locked. ${v.status === "submitted" ? "An approver can send it back for correction." : "Start a revision to change an approved computation."}`,
  });
}

/** The accrual date: the fiscal year-end if its period is open, else today — a change in estimate (pack §3.5). */
async function accrualDate(c: TaxComputation): Promise<{ date: string; basis: "fiscal_year_end" | "change_in_estimate" }> {
  try {
    await checkPeriodOpen(c.fiscalYearEnd);
    return { date: c.fiscalYearEnd, basis: "fiscal_year_end" };
  } catch (e) {
    if (!(e instanceof PeriodLockedError)) throw e;
    const today = businessToday();
    await checkPeriodOpen(today); // a closed TODAY is a loud refusal, never a silent re-date
    return { date: today, basis: "change_in_estimate" };
  }
}

// ── the approval adapter (one engine for every approvable) ─────────────────
type VersionSnapshot = ReturnType<typeof versionOut> & { computationId: number };
const snapshotOf = (v: TaxComputationVersion): VersionSnapshot => ({ ...versionOut(v), computationId: v.computationId });

export function taxComputationVersionApprovable(): Approvable<TaxComputationVersion, VersionSnapshot> {
  return {
    entityType: "tax_computation_version",
    async load(id) { return taxRepository.lockVersion(id); },
    state(v): ApprovalState {
      if (v.status === "draft") return "draft";
      if (v.status === "submitted") return "submitted";
      return "approved";
    },
    snapshot: snapshotOf,
    async onSubmit(v, actor) {
      const c = await loadComputation(v.computationId);
      const live = await compute(c, v);
      if (live.blockers.length) refuse(422, "tax_computation_blocked", "This computation cannot be submitted yet: " + live.blockers.map((b) => b.message).join(" "), { blockers: live.blockers });
      const [u] = await taxRepository.updateVersion(v.id, { status: "submitted", submittedAt: new Date(), submittedBy: actor.userId, sendBackNote: null });
      return snapshotOf(u!);
    },
    async onSendBack(v, _actor, note) {
      const [u] = await taxRepository.updateVersion(v.id, { status: "draft", sendBackNote: note?.trim() ? note.trim() : null });
      return snapshotOf(u!);
    },
    async onApprove(v, actor) {
      const c = await loadComputation(v.computationId);
      // 🔴 a year's Zakat or income tax is approved once the year has ENDED: before that its figures are
      // still moving, and its accrual would be dated in the future (pack §3.5; a draft computes live meanwhile)
      if (c.fiscalYearEnd >= businessToday()) {
        refuse(422, "tax_year_not_ended", `The fiscal year ends ${c.fiscalYearEnd}. A computation is approved after its year has ended — until then the working paper is a live projection.`);
      }
      const live = await compute(c, v);
      if (live.blockers.length || live.amountH == null) refuse(422, "tax_computation_blocked", "This computation cannot be approved: " + live.blockers.map((b) => b.message).join(" "), { blockers: live.blockers });
      const amountH = live.amountH!;
      const accruedH = toHalalas(await taxRepository.accruedSoFar(c.id));
      const diffH = amountH - accruedH;

      let entryId: number | null = null;
      let posted: { date: string; basis: string } | null = null;
      if (diffH !== 0) {
        const when = await accrualDate(c);
        const expense = c.kind === "zakat" ? SYSTEM_ACCOUNTS.ZAKAT_EXPENSE : SYSTEM_ACCOUNTS.INCOME_TAX_EXPENSE;
        const payable = c.kind === "zakat" ? SYSTEM_ACCOUNTS.ZAKAT_PAYMENT : SYSTEM_ACCOUNTS.INCOME_TAX_PAYABLE;
        const what = c.kind === "zakat" ? "Zakat" : "Income tax";
        const amt = H(Math.abs(diffH));
        const entry = await postJournalEntry({
          entryNumber: `${c.kind === "zakat" ? "ZAKAT" : "INCTAX"}-${c.fiscalLabel}-${c.id}-V${v.versionNo}`,
          date: when.date,
          description: `${what} for the fiscal year ${c.fiscalYearStart} – ${c.fiscalYearEnd} (computation v${v.versionNo}${accruedH !== 0 ? ", the difference from the earlier accrual" : ""})`,
          reference: `TAXCOMP-${c.id}-V${v.versionNo}`,
          lines: diffH > 0
            ? [
                { systemCode: expense, accountName: what, description: `${what} ${c.fiscalLabel}`, debitAmount: amt, creditAmount: 0 },
                { systemCode: payable, accountName: `${what} payable`, description: `${what} ${c.fiscalLabel}`, debitAmount: 0, creditAmount: amt },
              ]
            : [
                { systemCode: payable, accountName: `${what} payable`, description: `${what} ${c.fiscalLabel} (re-estimate)`, debitAmount: amt, creditAmount: 0 },
                { systemCode: expense, accountName: what, description: `${what} ${c.fiscalLabel} (re-estimate)`, debitAmount: 0, creditAmount: amt },
              ],
        });
        entryId = entry.id;
        posted = when;
      }

      // supersede the current approved version FIRST (one approved per computation — the partial unique index)
      const current = (await taxRepository.versionsOf([c.id])).find((x) => x.status === "approved" && x.id !== v.id);
      if (current) {
        const [sup] = await taxRepository.updateVersion(current.id, { status: "superseded", supersededAt: new Date() });
        await auditService.record({ action: "supersede", entityType: "tax_computation_version", entityId: current.id, before: versionOut(current), after: versionOut(sup!) });
      }
      const snapshot = {
        frozenAt: new Date().toISOString(), kind: c.kind, fiscalYear: fiscalYearOf(c),
        computation: presentComputation(live),
        accrual: { previouslyAccrued: H(accruedH), thisApproval: H(diffH), date: posted?.date ?? null, basis: posted?.basis ?? null, journalEntryId: entryId },
      };
      const [u] = await taxRepository.updateVersion(v.id, {
        status: "approved", approvedAt: new Date(), approvedBy: actor.userId, sendBackNote: null,
        snapshot, inputsFingerprint: live.fingerprint, resultAmount: H(amountH).toFixed(2),
        accrualJournalEntryId: entryId, accruedAmount: H(diffH).toFixed(2), accrualDate: posted?.date ?? null,
      });
      return snapshotOf(u!);
    },
    async hardDelete(v) {
      await taxRepository.deleteVersion(v.id);
      if ((await taxRepository.versionsOf([v.computationId])).length === 0) await taxRepository.deleteComputation(v.computationId);
    },
  };
}

// ── the service ────────────────────────────────────────────────────────────
function parseKind(k: unknown): TaxKind {
  if (!KINDS.includes(k as TaxKind)) throw new BadRequestError(`kind must be one of ${KINDS.join(", ")}.`);
  return k as TaxKind;
}

export const taxComputationsService = {
  async list(kind?: string) {
    const k = kind == null || kind === "" ? undefined : parseKind(kind);
    const comps = await taxRepository.computations(k);
    const versions = await taxRepository.versionsOf(comps.map((c) => c.id));
    return comps.map((c) => {
      const mine = versions.filter((v) => v.computationId === c.id);
      const approved = mine.find((v) => v.status === "approved");
      return {
        id: c.id, kind: c.kind as TaxKind, fiscalYear: fiscalYearOf(c), notes: c.notes ?? null, createdAt: iso(c.createdAt)!,
        versions: mine.map(versionOut),
        approvedVersionId: approved?.id ?? null, openVersionId: mine.find(isOpen)?.id ?? null,
        approvedAmount: approved?.resultAmount == null ? null : Number(approved.resultAmount),
        dueDate: addDays(c.fiscalYearEnd, 120),
      };
    });
  },

  async create(body: { kind?: unknown; fiscalYearLabel?: unknown; notes?: unknown }, userId: number | null) {
    const kind = parseKind(body.kind);
    const company = await companiesRepository.findCurrent();
    if (!company) throw new NotFoundError("No company is configured for this organization.");
    if (company.fiscalYearStart == null) {
      refuse(422, "fiscal_year_undeclared", "Declare the company's fiscal year in Company Settings first: a Zakat or income-tax year is the fiscal year, and an undeclared year is never assumed.");
    }
    const label = Number(body.fiscalYearLabel);
    if (!Number.isInteger(label)) throw new BadRequestError("fiscalYearLabel must be a year number.");
    const calendar: FiscalCalendar = isFiscalCalendar(company.fiscalCalendar) ? company.fiscalCalendar : "gregorian";
    let fy;
    try { fy = resolveFiscalYear({ fiscalYearStart: company.fiscalYearStart!, calendar }, label); }
    catch (e) { throw new BadRequestError(e instanceof Error ? e.message : "That fiscal year cannot be resolved."); }
    if (kind === "zakat" && fy.startDate < ZAKAT_REGULATIONS_FROM) {
      refuse(422, "zakat_regulations_not_in_force", `This fiscal year starts ${fy.startDate}. The 1445H Zakat Regulations apply to fiscal years starting on or after 1/1/2024 (Decision 1007); an earlier year is not computed here.`);
    }
    const existing = (await taxRepository.computations(kind)).find((c) => c.fiscalYearStart === fy.startDate);
    if (existing) refuse(409, "tax_computation_exists", `A ${kind === "zakat" ? "Zakat" : "income-tax"} computation for the fiscal year ${fy.startDate} – ${fy.endDate} already exists.`, { computationId: existing.id });
    const [c] = await taxRepository.insertComputation({
      kind, fiscalCalendar: calendar, fiscalStartMonth: company.fiscalYearStart!, fiscalLabel: fy.label,
      fiscalYearStart: fy.startDate, fiscalYearEnd: fy.endDate,
      notes: typeof body.notes === "string" && body.notes.trim() ? body.notes.trim() : null, createdBy: userId,
    });
    const [v] = await taxRepository.insertVersion({ computationId: c!.id, versionNo: 1, status: "draft", createdBy: userId });
    await auditService.created("tax_computation", c!.id, { computation: c, version: versionOut(v!) });
    return this.detail(c!.id, v!.id);
  },

  async detail(id: number, versionId?: number) {
    const c = await loadComputation(id);
    const versions = await taxRepository.versionsOf([id]);
    let chosen: TaxComputationVersion | undefined;
    if (versionId != null) {
      chosen = versions.find((v) => v.id === versionId);
      if (!chosen) throw new NotFoundError("Version not found.");
    } else chosen = versions.find(isOpen) ?? versions.find((v) => v.status === "approved") ?? versions[versions.length - 1];
    const live = chosen ? presentComputation(await compute(c, chosen)) : null;
    const frozen = chosen && (chosen.status === "approved" || chosen.status === "superseded") ? (chosen.snapshot as Record<string, unknown>) : null;
    return {
      id: c.id, kind: c.kind as TaxKind, fiscalYear: fiscalYearOf(c), notes: c.notes ?? null, createdAt: iso(c.createdAt)!,
      dueDate: addDays(c.fiscalYearEnd, 120),
      versions: versions.map(versionOut),
      approvedVersionId: versions.find((v) => v.status === "approved")?.id ?? null,
      openVersionId: versions.find(isOpen)?.id ?? null,
      version: chosen ? versionOut(chosen) : null,
      live,
      approvedSnapshot: frozen,
      /** 🔴 a verification is a claim about a moment: the ledger moved since this version was approved */
      ledgerChangedSinceApproval: frozen && live ? chosen!.inputsFingerprint !== live.fingerprint : null,
    };
  },

  async update(id: number, body: { notes?: unknown }) {
    const before = await loadComputation(id);
    const notes = typeof body.notes === "string" && body.notes.trim() ? body.notes.trim() : null;
    const [after] = await taxRepository.updateComputation(id, { notes });
    await auditService.updated("tax_computation", id, before, after);
    return this.detail(id);
  },

  async remove(id: number) {
    const before = await loadComputation(id);
    const versions = await taxRepository.versionsOf([id]);
    if (versions.some((v) => v.status === "approved" || v.status === "superseded")) {
      refuse(409, "tax_computation_ever_approved", "This computation has been approved — it is a record and is never deleted. Start a revision to change it.");
    }
    await taxRepository.deleteComputation(id);
    await auditService.deleted("tax_computation", id, { computation: before, versions: versions.map(versionOut) });
  },

  // ── adjustments (the tax-adjustment model, pack §5) ──────────────────────
  async addAdjustment(id: number, versionId: number, body: Record<string, unknown>, userId: number | null) {
    const c = await loadComputation(id);
    const v = await loadVersionOf(id, versionId);
    if (v.status !== "draft") throw lockedError(v);
    const values = await parseAdjustment(c, body);
    const [row] = await taxRepository.insertAdjustment({ ...values, versionId, createdBy: userId });
    await auditService.created("tax_adjustment", row!.id, row);
    return this.detail(id, versionId);
  },
  async updateAdjustment(id: number, versionId: number, adjustmentId: number, body: Record<string, unknown>) {
    const c = await loadComputation(id);
    const v = await loadVersionOf(id, versionId);
    if (v.status !== "draft") throw lockedError(v);
    const before = await taxRepository.adjustmentById(adjustmentId);
    if (!before || before.versionId !== versionId) throw new NotFoundError("Adjustment not found.");
    const values = await parseAdjustment(c, { ...before, ...body, amount: body.amount ?? before.amount });
    const [after] = await taxRepository.updateAdjustment(adjustmentId, values);
    await auditService.updated("tax_adjustment", adjustmentId, before, after);
    return this.detail(id, versionId);
  },
  async removeAdjustment(id: number, versionId: number, adjustmentId: number) {
    await loadComputation(id);
    const v = await loadVersionOf(id, versionId);
    if (v.status !== "draft") throw lockedError(v);
    const before = await taxRepository.adjustmentById(adjustmentId);
    if (!before || before.versionId !== versionId) throw new NotFoundError("Adjustment not found.");
    await taxRepository.deleteAdjustment(adjustmentId);
    await auditService.deleted("tax_adjustment", adjustmentId, before);
    return this.detail(id, versionId);
  },

  /** Income tax: the losses carried forward available, from audited statutory accounts (Art. 21; IR Art. 11). */
  async setLosses(id: number, versionId: number, body: { amount?: unknown; reference?: unknown }) {
    const c = await loadComputation(id);
    if (c.kind !== "income_tax") refuse(422, "tax_losses_income_tax_only", "Losses carried forward belong to an income-tax computation.");
    const v = await loadVersionOf(id, versionId);
    if (v.status !== "draft") throw lockedError(v);
    const raw = body.amount == null || body.amount === "" ? null : Number(body.amount);
    if (raw != null && (!Number.isFinite(raw) || raw < 0 || Math.abs(raw * 100 - Math.round(raw * 100)) > 1e-6)) throw new BadRequestError("amount is a non-negative amount with at most two decimals.");
    const reference = typeof body.reference === "string" && body.reference.trim() ? body.reference.trim() : null;
    if (raw != null && raw > 0 && !reference) refuse(422, "tax_losses_reference_required", "Name the audited statutory accounts the losses come from — only losses shown in them are carried forward (IR Art. 11).");
    const [after] = await taxRepository.updateVersion(versionId, { lossCarryforwardAvailable: raw == null ? null : raw.toFixed(2), lossCarryforwardReference: reference });
    await auditService.updated("tax_computation_version", versionId, versionOut(v), versionOut(after!));
    return this.detail(id, versionId);
  },

  // ── transitions — the ONE approval engine ────────────────────────────────
  async submit(id: number, versionId: number, userId: number | null) {
    await loadComputation(id); await loadVersionOf(id, versionId);
    await approvalService.submit(taxComputationVersionApprovable(), versionId, { userId });
    return this.detail(id, versionId);
  },
  async approve(id: number, versionId: number, userId: number | null) {
    await loadComputation(id);
    const v = await loadVersionOf(id, versionId);
    if (v.status === "approved" || v.status === "superseded") refuse(409, "tax_version_approved", `Version ${v.versionNo} is already ${v.status}.`);
    await approvalService.approve(taxComputationVersionApprovable(), versionId, { userId });
    return this.detail(id, versionId);
  },
  async sendBack(id: number, versionId: number, note: string | undefined, userId: number | null) {
    await loadComputation(id); await loadVersionOf(id, versionId);
    await approvalService.sendBack(taxComputationVersionApprovable(), versionId, { userId }, note);
    return this.detail(id, versionId);
  },
  async reject(id: number, versionId: number, userId: number | null) {
    await loadComputation(id);
    const v = await loadVersionOf(id, versionId);
    if (v.status === "approved" || v.status === "superseded") refuse(409, "tax_version_approved", `Version ${v.versionNo} is ${v.status} — an approved computation is a record and cannot be rejected. Start a revision.`);
    await approvalService.reject(taxComputationVersionApprovable(), versionId, { userId });
  },
  async revise(id: number, userId: number | null) {
    const c = await loadComputation(id);
    const versions = await taxRepository.versionsOf([id]);
    const open = versions.find(isOpen);
    if (open) refuse(409, "tax_version_open", `Version ${open.versionNo} is still ${open.status} — finish or reject it before starting another revision.`);
    const approved = versions.find((v) => v.status === "approved");
    if (!approved) refuse(409, "tax_not_approved", "Only an approved computation is revised.");
    const next = await taxRepository.nextVersionNo(id);
    const [nv] = await taxRepository.insertVersion({
      computationId: c.id, versionNo: next, status: "draft", basedOnVersionId: approved!.id, createdBy: userId,
      lossCarryforwardAvailable: approved!.lossCarryforwardAvailable, lossCarryforwardReference: approved!.lossCarryforwardReference,
    });
    await taxRepository.copyAdjustments(approved!.id, nv!.id);
    await auditService.created("tax_computation_version", nv!.id, { ...versionOut(nv!), basedOn: approved!.versionNo });
    return this.detail(id, nv!.id);
  },
};

const TARGETS: Record<TaxKind, string[]> = { zakat: ["adjusted_net_profit", "zakat_base"], income_tax: ["taxable_income"] };
async function parseAdjustment(c: TaxComputation, body: Record<string, unknown>) {
  const kind = c.kind as TaxKind;
  const target = String(body.target ?? "");
  if (!TARGETS[kind].includes(target)) throw new BadRequestError(`target must be one of ${TARGETS[kind].join(", ")} for a ${kind} computation.`);
  const effect = String(body.effect ?? "");
  if (effect !== "increase" && effect !== "decrease") throw new BadRequestError("effect must be increase or decrease.");
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0 || Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6 || amount > 9_999_999_999_999.99) {
    throw new BadRequestError("amount is a positive amount with at most two decimals.");
  }
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (reason.length < 3) refuse(422, "tax_adjustment_reason_required", "Say why — an adjustment without its reason cannot be reviewed.", { field: "reason" });
  const legalReference = typeof body.legalReference === "string" ? body.legalReference.trim() : "";
  if (legalReference.length < 2) refuse(422, "tax_adjustment_reference_required", "Name the article the adjustment stands on (e.g. \"Zakat Regulations Art. 63(2)\").", { field: "legalReference" });
  const sourceReference = typeof body.sourceReference === "string" && body.sourceReference.trim() ? body.sourceReference.trim() : null;
  const accountId = body.accountId == null || body.accountId === "" ? null : Number(body.accountId);
  if (accountId != null && (!Number.isSafeInteger(accountId) || accountId <= 0 || accountId > MAX_ID)) throw new BadRequestError("accountId must be a positive integer.");
  return { target, effect, amount: amount.toFixed(2), reason, legalReference, sourceReference, accountId };
}

/** A plain-day date plus n days (accounting dates have no zone). */
export function addDays(isoDate: string, n: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + n)).toISOString().slice(0, 10);
}
