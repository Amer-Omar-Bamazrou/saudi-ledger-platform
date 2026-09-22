/**
 * FA-E (2026-09-22) — the Art. 17 pool over the register.
 *
 * Record: docs/product/fixed-assets-decision-pack.md §8.3, §24.
 * The arithmetic and every quotation of the Law are in `incomeTaxPool.ts`;
 * this file is the part that knows about companies, fiscal years and rows.
 *
 * 🔴 THE REPORT REFUSES TO GUESS, AND SAYS WHICH INPUT IS MISSING. Four states
 * come back instead of figures, each naming the one act that resolves it:
 *
 *   `regime_not_declared`  — the company has not stated its non-Saudi/non-GCC
 *                            share, and Art. 17 applies only to persons subject
 *                            to the Income Tax Law (Art. 2; Zakat Regulations
 *                            Art. 6(1) mirrors it). A platform that assumed
 *                            0 % would hide the whole regime from a taxpayer
 *                            who owes it; one that assumed otherwise would
 *                            invent a tax for a Zakat payer.
 *   `not_applicable`       — the share is 0 %: a Zakat payer, for whom there is
 *                            ONE basis and it is the book basis (Zakat Regs
 *                            Art. 48(1)(b), 63(2)).
 *   `fiscal_year_not_declared` — no tax year to compute over (Art. 22 takes the
 *                            taxpayer's own twelve-month period; M20.0 keeps
 *                            "not declared" a first-class state).
 *   `anchor_not_declared`  — the chain has no start. See below.
 *
 * 🔴 WHY AN ANCHOR IS REQUIRED AND NEVER ASSUMED. A pool balance is a
 * declining-balance figure from the taxpayer's own filed returns; no book
 * register can produce it, and Art. 81(a) puts pre-Law assets into the group at
 * cost less depreciation previously allowed — a number only the taxpayer has.
 * Assuming nil would be the confident zero the standing rules name: it reads
 * exactly like an answer. A company with no pool history declares a nil anchor,
 * which is an ACT and is audited as one.
 *
 * 🔴 THE FRAME IS PART OF THE COUNT. Five things Art. 17 contemplates are
 * outside what the register can see, and the report NAMES each one rather than
 * omitting it silently — `frameLimits` travels with the figures:
 *   · 17(a) land is not depreciable, and the register has no land marker;
 *   · 17(f) a conversion to personal use is a deemed disposal AT MARKET VALUE,
 *     which is not a figure any of our disposal kinds captures;
 *   · 17(k) partial business use;
 *   · 17(j) land bought or sold with constructions on it;
 *   · 17(l) BOT/BOOT contracts.
 */
import { assetsRepository } from "../../repositories/assets.repository.js";
import { companiesRepository } from "../../repositories/companies.repository.js";
import { fiscalYearContaining, isFiscalCalendar, resolveFiscalYear, type FiscalCalendar, type FiscalPeriod } from "../../lib/fiscalYear.js";
import { businessToday } from "@workspace/shared";
import { BusinessRuleError, NotFoundError } from "../../lib/errors.js";
import { auditService } from "../audit.service.js";
import { round2 } from "../../lib/money.js";
import { ART17_RATES, computePoolYear, type Art17Group, type PoolYearResult } from "./incomeTaxPool.js";

export const ART17_GROUPS: Art17Group[] = [1, 2, 3, 4, 5];

export type PoolStatus = "computed" | "regime_not_declared" | "not_applicable" | "fiscal_year_not_declared" | "anchor_not_declared";

const FRAME_LIMITS = [
  { article: "17(a)", limit: "Land is not depreciable, and the register carries no land marker — a category put into an Art. 17 group is treated as depreciable here." },
  { article: "17(f)", limit: "A conversion to personal use is a deemed disposal AT MARKET VALUE. The register stores the proceeds actually received, so a withdrawal enters the pool at 0 unless a value is recorded; each one is listed beside the figures." },
  { article: "17(j)", limit: "Land bought or sold together with constructions on it must be apportioned. Nothing here apportions." },
  { article: "17(k)", limit: "Partial business use restricts the deduction to the business part. The register holds no business-use fraction." },
  { article: "17(l)", limit: "Assets under BOT/BOOT contracts depreciate over the contract period, not by group rate." },
] as const;

function fiscalYearOfDate(settings: { fiscalYearStart: number; calendar: FiscalCalendar }, date: string): number {
  return fiscalYearContaining(settings, date).label;
}

export interface PoolGroupYear extends PoolYearResult {
  /** Which assets made up this year's additions and disposals, so a figure can be opened. */
  additionItems: { assetNumber: string; name: string; date: string; cost: number }[];
  disposalItems: { assetNumber: string; date: string; proceeds: number; kind: string; deemedValueMissing: boolean }[];
  /** True while the year's repairs have not been declared (Art. 18) — NOT the same as a declared zero. */
  repairsNotDeclared: boolean;
}

export const incomeTaxPoolService = {
  /**
   * The whole chain, from the year after the anchor up to `toYear`
   * (default: the fiscal year containing today's business date).
   */
  async report(opts: { toYear?: number } = {}) {
    const company = await companiesRepository.findActive();
    if (!company) throw new NotFoundError("No company is configured for this organization.");

    const base = {
      companyId: company.id,
      companyName: company.name,
      ownershipType: company.ownershipType ?? null,
      foreignOwnershipPct: company.foreignOwnershipPct == null ? null : Number(company.foreignOwnershipPct),
      frameLimits: FRAME_LIMITS.map((f) => ({ ...f })),
      rates: ART17_GROUPS.map((g) => ({ group: g, ratePct: ART17_RATES[g] })),
      years: [] as { taxYear: number; startDate: string; endDate: string; groups: PoolGroupYear[] }[],
      anchorYear: null as number | null,
    };

    // ── the two gates that are facts about the COMPANY, not about assets ──
    if (company.foreignOwnershipPct == null) {
      return { ...base, status: "regime_not_declared" as PoolStatus, reason: "The company has not declared its non-Saudi/non-GCC ownership share. Income Tax Law Art. 17 applies only to persons subject to that Law (Art. 2); a Zakat-only payer has one basis, the book basis. Declare the share in Company Settings." };
    }
    const foreignPct = Number(company.foreignOwnershipPct);
    if (foreignPct === 0) {
      return { ...base, status: "not_applicable" as PoolStatus, reason: "This company is 100 % Saudi/GCC-owned, so it pays Zakat and not income tax (Zakat Regulations Art. 6(1)). The Art. 17 pool does not apply; the Zakat base takes the BOOK figures (Art. 48(1)(b), 63(2))." };
    }
    if (company.fiscalYearStart == null) {
      return { ...base, status: "fiscal_year_not_declared" as PoolStatus, reason: "The company has not declared its fiscal year, and the pool is computed per taxable year (Art. 22). Declare it in Company Settings." };
    }

    const settings = { fiscalYearStart: company.fiscalYearStart, calendar: (isFiscalCalendar(company.fiscalCalendar) ? company.fiscalCalendar : "gregorian") as FiscalCalendar };
    const currentYear = fiscalYearContaining(settings, businessToday()).label;
    const toYear = opts.toYear ?? currentYear;

    const declarations = await assetsRepository.poolDeclarations();
    const anchors = declarations.filter((d) => d.closingBalanceDeclared != null);
    if (anchors.length === 0) {
      return { ...base, status: "anchor_not_declared" as PoolStatus, reason: "The pool has no opening position. A group's balance at the end of an already-filed year comes from the taxpayer's own return — no book register can produce it (Art. 81(a) puts pre-Law assets in at cost less depreciation previously allowed). Declare the anchor year, per group; a company with no pool history declares nil, which is an act and is recorded as one." };
    }
    // 🔴 ONE anchor year for the whole pool. Per-group anchor years would make
    // "which year does the chain start in" a per-group fact, and a group with a
    // later anchor would silently drop every year in between.
    const anchorYear = Math.max(...anchors.map((d) => d.taxYear));

    const facts = await assetsRepository.art17RegisterFacts();

    const yearOf = (date: string) => fiscalYearOfDate(settings, date);
    const additionsIn = (g: number, y: number) => facts.additions.filter((a) => a.group === g && yearOf(a.onDate) === y);
    const disposalsIn = (g: number, y: number) => facts.disposals.filter((d) => d.group === g && yearOf(d.onDate) === y);
    const sum = (ns: number[]) => round2(ns.reduce((s, n) => s + n, 0));

    /** Art. 17(i) is available only once every asset the group HAS is disposed of — a group with no assets is not a closed group. */
    const allDisposed = (g: number) => {
      const c = facts.assetsByGroup.find((r) => r.group === g);
      return !!c && c.total > 0 && c.disposed === c.total;
    };

    const years: { taxYear: number; startDate: string; endDate: string; groups: PoolGroupYear[] }[] = [];
    // The running opening balance per group: the anchor's declared closing.
    const opening = new Map<number, number>();
    for (const g of ART17_GROUPS) {
      const a = anchors.find((d) => d.incomeTaxGroup === g && d.taxYear === anchorYear);
      opening.set(g, a?.closingBalanceDeclared == null ? 0 : Number(a.closingBalanceDeclared));
    }

    for (let y = anchorYear + 1; y <= toYear; y++) {
      const period: FiscalPeriod = resolveFiscalYear(settings, y);
      const groups: PoolGroupYear[] = [];
      for (const g of ART17_GROUPS) {
        const decl = declarations.find((d) => d.incomeTaxGroup === g && d.taxYear === y);
        const anchorDecl = anchors.find((d) => d.incomeTaxGroup === g && d.taxYear === anchorYear);

        const curAdd = additionsIn(g, y);
        const curDisp = disposalsIn(g, y);
        // 🔴 The previous year's halves come from the ANCHOR for the first
        // computed year and from the REGISTER afterwards — never from both, or
        // an addition in the anchor year would be counted twice.
        const prevAdditions = y === anchorYear + 1
          ? (anchorDecl?.additionsDeclared == null ? 0 : Number(anchorDecl.additionsDeclared))
          : sum(additionsIn(g, y - 1).map((a) => a.cost));
        const prevDisposals = y === anchorYear + 1
          ? (anchorDecl?.disposalsDeclared == null ? 0 : Number(anchorDecl.disposalsDeclared))
          : sum(disposalsIn(g, y - 1).map((d) => d.proceeds));

        const result = computePoolYear({
          taxYear: y,
          group: g,
          openingBalance: opening.get(g) ?? 0,
          current: { additions: sum(curAdd.map((a) => a.cost)), disposals: sum(curDisp.map((d) => d.proceeds)), allAssetsDisposed: allDisposed(g) },
          previous: { additions: prevAdditions, disposals: prevDisposals },
          declaration: {
            repairs: decl?.repairsDeclared == null ? null : Number(decl.repairsDeclared),
            electSmallBalanceWriteOff: decl?.electSmallBalanceWriteOff ?? false,
            electGroupClosedWriteOff: decl?.electGroupClosedWriteOff ?? false,
          },
        });

        groups.push({
          ...result,
          additionItems: curAdd.map((a) => ({ assetNumber: a.assetNumber, name: a.name, date: a.onDate, cost: a.cost })),
          // 🔴 Art. 17(f): a withdrawal is a deemed disposal at MARKET VALUE, which
          // the register does not hold. The row is shown with the flag rather than
          // quietly contributing zero to the group's disposals.
          disposalItems: curDisp.map((d) => ({ assetNumber: d.assetNumber, date: d.onDate, proceeds: d.proceeds, kind: d.kind, deemedValueMissing: d.kind === "withdrawn" && d.proceeds === 0 })),
          repairsNotDeclared: decl?.repairsDeclared == null,
        });
        opening.set(g, result.closingBalance);
      }
      years.push({ taxYear: y, startDate: period.startDate, endDate: period.endDate, groups });
    }

    return { ...base, status: "computed" as PoolStatus, reason: null, anchorYear, years };
  },

  /** The declarations as stated — the pool's only stored input, listed so it can be corrected. */
  async declarations() {
    const rows = await assetsRepository.poolDeclarations();
    return rows.map(toDeclarationView);
  },

  /**
   * State, or correct, one group's declaration for one tax year.
   *
   * A declaration is CORRECTABLE, unlike anything that posts: it records what
   * the taxpayer filed, and a mis-keyed balance must be fixable. What is
   * refused is a declaration that cannot mean anything.
   */
  async declare(input: {
    incomeTaxGroup: number;
    taxYear: number;
    closingBalanceDeclared?: number | null;
    additionsDeclared?: number | null;
    disposalsDeclared?: number | null;
    repairsDeclared?: number | null;
    electSmallBalanceWriteOff?: boolean;
    electGroupClosedWriteOff?: boolean;
    note?: string | null;
  }, userId: number | null) {
    if (!ART17_GROUPS.includes(input.incomeTaxGroup as Art17Group)) {
      throw new BusinessRuleError(422, { error: `Income Tax Law Art. 17(b) names five groups (1–5); ${input.incomeTaxGroup} is not one of them.`, code: "income_tax_group_unknown", field: "incomeTaxGroup" });
    }
    // 🔴 An ANCHOR is a complete statement of the year it closes. Art. 17(e)
    // reaches back one year, so a balance with no additions/disposals figure
    // would make the next year read as a year with no additions — a plausible
    // number that is not a stated one. The DB CHECK says the same; this is the
    // message that explains it.
    const isAnchor = input.closingBalanceDeclared != null;
    if (isAnchor && (input.additionsDeclared == null || input.disposalsDeclared == null)) {
      throw new BusinessRuleError(422, { error: "An opening balance must come with that year's own additions and disposals: Art. 17(e) takes 50 % of them into the following year. State 0 if there were none.", code: "anchor_incomplete", field: "additionsDeclared" });
    }
    if (!isAnchor && input.repairsDeclared == null && !input.electSmallBalanceWriteOff && !input.electGroupClosedWriteOff) {
      throw new BusinessRuleError(422, { error: "A declaration states something: an opening balance, the year's Art. 18 repairs, or an election.", code: "declaration_empty" });
    }

    const [existing] = await assetsRepository.findPoolDeclaration(input.incomeTaxGroup, input.taxYear);
    const values = {
      incomeTaxGroup: input.incomeTaxGroup,
      taxYear: input.taxYear,
      closingBalanceDeclared: input.closingBalanceDeclared == null ? null : String(round2(input.closingBalanceDeclared)),
      additionsDeclared: input.additionsDeclared == null ? null : String(round2(input.additionsDeclared)),
      disposalsDeclared: input.disposalsDeclared == null ? null : String(round2(input.disposalsDeclared)),
      repairsDeclared: input.repairsDeclared == null ? null : String(round2(input.repairsDeclared)),
      electSmallBalanceWriteOff: input.electSmallBalanceWriteOff ?? false,
      electGroupClosedWriteOff: input.electGroupClosedWriteOff ?? false,
      note: input.note ?? null,
      declaredBy: userId,
    };

    const [row] = existing
      ? await assetsRepository.updatePoolDeclaration(existing.id, values)
      : await assetsRepository.insertPoolDeclaration(values);

    if (existing) await auditService.updated("asset_tax_pool_declaration", row!.id, existing, row);
    else await auditService.created("asset_tax_pool_declaration", row!.id, row);
    return toDeclarationView(row!);
  },

  async remove(id: number) {
    const [row] = await assetsRepository.deletePoolDeclaration(id);
    if (!row) throw new NotFoundError("Declaration not found.");
    await auditService.deleted("asset_tax_pool_declaration", id, row);
    return { id };
  },
};

function toDeclarationView(r: {
  id: number; incomeTaxGroup: number; taxYear: number;
  closingBalanceDeclared: string | null; additionsDeclared: string | null; disposalsDeclared: string | null; repairsDeclared: string | null;
  electSmallBalanceWriteOff: boolean; electGroupClosedWriteOff: boolean; note: string | null; updatedAt: Date;
}) {
  const n = (v: string | null) => (v == null ? null : Number(v));
  return {
    id: r.id,
    incomeTaxGroup: r.incomeTaxGroup,
    taxYear: r.taxYear,
    ratePct: ART17_RATES[r.incomeTaxGroup as Art17Group],
    closingBalanceDeclared: n(r.closingBalanceDeclared),
    additionsDeclared: n(r.additionsDeclared),
    disposalsDeclared: n(r.disposalsDeclared),
    repairsDeclared: n(r.repairsDeclared),
    electSmallBalanceWriteOff: r.electSmallBalanceWriteOff,
    electGroupClosedWriteOff: r.electGroupClosedWriteOff,
    note: r.note,
    updatedAt: r.updatedAt.toISOString(),
  };
}
