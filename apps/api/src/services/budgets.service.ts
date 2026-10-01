/**
 * Budgets service — Phase 15 (docs/product/phase-14-15-reporting-budgeting-decision-pack.md §5).
 *
 *   budget (one company, one FROZEN fiscal year, a scenario)
 *     └─ versions (revisions): draft → submitted → approved → superseded
 *          └─ lines: account × fiscal period, or ONE annual amount (never divided)
 *
 * 🔴 A budget never touches the books (P1): nothing here writes a journal. The
 * lifecycle runs through the platform's ONE approval engine (D15-04) and is
 * locked again at the database (migration 0112) — this file is not the only
 * thing standing between an approved budget and an edit.
 *
 * Budget vs actual reads THE LEDGER through the Phase 14 seam
 * (`ledgerMovementsByPeriod`), accrual, signed in each account's natural
 * direction (D15-06). Every figure is summed in integer halalas.
 */
import { businessToday } from "@workspace/shared";
import { BadRequestError, BusinessRuleError, NotFoundError } from "../lib/errors";
import { fromHalalas, money2, round2, toHalalas } from "../lib/money";
import { fiscalMonths, isFiscalCalendar, resolveFiscalYear, type FiscalCalendar, type FiscalMonth } from "../lib/fiscalYear";
import { budgetsRepository, type BudgetRow, type BudgetVersionRow } from "../repositories/budgets.repository";
import { companiesRepository } from "../repositories/companies.repository";
import { reportsRepository } from "../repositories/reports.repository";
import { auditService } from "./audit.service";
import { approvalService, type Approvable, type ApprovalState } from "./approval";

export const BUDGET_SCENARIOS = ["base", "best_case", "worst_case"] as const;
/** The largest amount a budget_lines.amount numeric(15,2) holds, in halalas. */
const MAX_LINE_HALALAS = 999_999_999_999_999;
export type BudgetScenario = (typeof BUDGET_SCENARIOS)[number];
type PlType = "income" | "expense";

const isIncomeType = (t: string | null | undefined) => t === "income" || t === "revenue";
const isPlType = (t: string | null | undefined) => isIncomeType(t) || t === "expense";
const plType = (t: string | null | undefined): PlType => (isIncomeType(t) ? "income" : "expense");
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const sumH = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

// ── presentation ──────────────────────────────────────────────────────────
function fiscalYearOf(b: BudgetRow) {
  return { calendar: b.fiscalCalendar as FiscalCalendar, startMonth: b.fiscalStartMonth, label: b.fiscalLabel, startDate: b.fiscalYearStart, endDate: b.fiscalYearEnd };
}
/** The twelve periods, re-derived from the fields FROZEN on the budget (D15-01) — never from today's company settings. */
function periodsOf(b: BudgetRow): FiscalMonth[] {
  return fiscalMonths({ fiscalYearStart: b.fiscalStartMonth, calendar: b.fiscalCalendar as FiscalCalendar }, b.fiscalLabel);
}
function versionOut(v: BudgetVersionRow) {
  return {
    id: v.id, versionNo: v.versionNo, status: v.status as "draft" | "submitted" | "approved" | "superseded",
    basedOnVersionId: v.basedOnVersionId ?? null, notes: v.notes ?? null, sendBackNote: v.sendBackNote ?? null,
    createdBy: v.createdBy ?? null, createdAt: iso(v.createdAt)!, submittedBy: v.submittedBy ?? null, submittedAt: iso(v.submittedAt),
    approvedBy: v.approvedBy ?? null, approvedAt: iso(v.approvedAt), supersededAt: iso(v.supersededAt),
  };
}
const isOpen = (v: BudgetVersionRow) => v.status === "draft" || v.status === "submitted";
function summaryOut(b: BudgetRow, versions: BudgetVersionRow[]) {
  const mine = versions.filter((v) => v.budgetId === b.id);
  return {
    id: b.id, name: b.name, nameAr: b.nameAr ?? null, scenario: b.scenario as BudgetScenario, fiscalYear: fiscalYearOf(b),
    notes: b.notes ?? null, createdAt: iso(b.createdAt)!, versions: mine.map(versionOut),
    approvedVersionId: mine.find((v) => v.status === "approved")?.id ?? null,
    openVersionId: mine.find(isOpen)?.id ?? null,
  };
}

type LineRow = Awaited<ReturnType<typeof budgetsRepository.linesOf>>[number];
type AccountLine = { accountId: number; accountName: string; accountNameAr: string | null; accountType: PlType; mode: "periods" | "annual"; periodsH: number[] | null; annualH: number | null };
/** Group a version's rows into one line per account: twelve periods, or one annual amount. */
function groupLines(rows: LineRow[]): AccountLine[] {
  const byAccount = new Map<number, AccountLine>();
  for (const r of rows) {
    let l = byAccount.get(r.accountId);
    if (!l) {
      l = { accountId: r.accountId, accountName: r.accountName, accountNameAr: r.accountNameAr ?? null, accountType: plType(r.accountType), mode: r.periodNo == null ? "annual" : "periods", periodsH: r.periodNo == null ? null : Array(12).fill(0), annualH: null };
      byAccount.set(r.accountId, l);
    }
    if (r.periodNo == null) l.annualH = toHalalas(r.amount);
    else l.periodsH![r.periodNo - 1] = toHalalas(r.amount);
  }
  return [...byAccount.values()];
}
const lineTotalH = (l: AccountLine) => (l.mode === "annual" ? l.annualH ?? 0 : sumH(l.periodsH!));
function linesOut(lines: AccountLine[]) {
  return lines.map((l) => ({
    accountId: l.accountId, accountName: l.accountName, accountNameAr: l.accountNameAr, accountType: l.accountType, mode: l.mode,
    periods: l.periodsH ? l.periodsH.map(fromHalalas) : null,
    annualAmount: l.annualH == null ? null : fromHalalas(l.annualH),
    total: fromHalalas(lineTotalH(l)),
  }));
}

// ── guards ────────────────────────────────────────────────────────────────
async function loadBudget(id: number): Promise<BudgetRow> {
  const [b] = await budgetsRepository.findBudget(id);
  if (!b) throw new NotFoundError("Budget not found.");
  return b;
}
/** The version, locked for this transaction, and proven to belong to THIS budget (a foreign id is a 404, never a different budget's version). */
async function loadVersionOf(budgetId: number, versionId: number): Promise<BudgetVersionRow> {
  const [v] = await budgetsRepository.lockVersion(versionId);
  if (!v || v.budgetId !== budgetId) throw new NotFoundError("Budget version not found.");
  return v;
}
function lockedError(v: BudgetVersionRow): BusinessRuleError {
  const next = v.status === "submitted"
    ? "An approver can send it back for correction."
    : "An approved budget is a record — start a revision to change it.";
  return new BusinessRuleError(409, { code: "budget_version_locked", status: v.status, error: `Version ${v.versionNo} is ${v.status}: its lines are locked. ${next}` });
}
async function assertHasLines(v: BudgetVersionRow, act: string) {
  const rows = await budgetsRepository.linesOf(v.id);
  if (rows.length === 0) throw new BusinessRuleError(422, { code: "budget_version_empty", error: `Version ${v.versionNo} has no lines — add at least one account before you ${act} it.` });
}

// ── the approval adapter (D15-04) ──────────────────────────────────────────
type VersionSnapshot = ReturnType<typeof versionOut> & { budgetId: number; lines: ReturnType<typeof linesOut> };
async function versionSnapshot(v: BudgetVersionRow): Promise<VersionSnapshot> {
  return { ...versionOut(v), budgetId: v.budgetId, lines: linesOut(groupLines(await budgetsRepository.linesOf(v.id))) };
}
export function budgetVersionApprovable(): Approvable<BudgetVersionRow, VersionSnapshot> {
  return {
    entityType: "budget_version",
    async load(id) {
      const [v] = await budgetsRepository.lockVersion(id);
      return v ?? null;
    },
    state(v): ApprovalState {
      if (v.status === "draft") return "draft";
      if (v.status === "submitted") return "submitted";
      return "approved"; // approved, superseded
    },
    snapshot: versionSnapshot,
    async onSubmit(v, actor) {
      await assertHasLines(v, "submit");
      const [u] = await budgetsRepository.updateVersion(v.id, { status: "submitted", submittedAt: new Date(), submittedBy: actor.userId, sendBackNote: null });
      return versionSnapshot(u!);
    },
    async onSendBack(v, _actor, note) {
      const [u] = await budgetsRepository.updateVersion(v.id, { status: "draft", sendBackNote: note?.trim() ? note.trim() : null });
      return versionSnapshot(u!);
    },
    async onApprove(v, actor) {
      await assertHasLines(v, "approve");
      // 🔴 Supersede FIRST, then approve: the partial unique index admits one
      // approved version per budget, and the database refuses to supersede an
      // approved version unless a NEWER open one exists (this one).
      const current = (await budgetsRepository.versionsOf([v.budgetId])).find((x) => x.status === "approved" && x.id !== v.id);
      if (current) {
        const [sup] = await budgetsRepository.updateVersion(current.id, { status: "superseded", supersededAt: new Date() });
        await auditService.record({ action: "supersede", entityType: "budget_version", entityId: current.id, before: versionOut(current), after: versionOut(sup!) });
      }
      const [u] = await budgetsRepository.updateVersion(v.id, { status: "approved", approvedAt: new Date(), approvedBy: actor.userId, sendBackNote: null });
      return versionSnapshot(u!);
    },
    async hardDelete(v) {
      await budgetsRepository.deleteVersion(v.id);
      // a budget with no version is a shape with no content — it goes too
      if ((await budgetsRepository.versionsOf([v.budgetId])).length === 0) await budgetsRepository.deleteBudget(v.budgetId);
    },
  };
}

// ── budget vs actual (D15-06 … D15-09) ─────────────────────────────────────
type Figure = { budget: number | null; actual: number; variance: number | null; variancePct: number | null; favourable: boolean | null };
type FigureH = { budgetH: number | null; actualH: number };
function figure(f: FigureH, type: PlType | "net"): Figure {
  const varianceH = f.budgetH == null ? null : f.actualH - f.budgetH;
  return {
    budget: f.budgetH == null ? null : fromHalalas(f.budgetH),
    actual: fromHalalas(f.actualH),
    variance: varianceH == null ? null : fromHalalas(varianceH),
    // 🔴 withheld at a zero budget — a percentage of nothing means nothing
    // divided by |budget|, so the percentage carries the variance's own sign (a negative net plan included)
    variancePct: varianceH == null || !f.budgetH ? null : round2((varianceH / Math.abs(f.budgetH)) * 100),
    favourable: varianceH == null ? null : type === "expense" ? varianceH <= 0 : varianceH >= 0,
  };
}

export const budgetsService = {
  async list(opts: { as_of?: string; scenario?: string } = {}) {
    if (opts.as_of != null && opts.as_of !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(opts.as_of)) throw new BadRequestError("as_of must be YYYY-MM-DD.");
    if (opts.scenario != null && opts.scenario !== "" && !(BUDGET_SCENARIOS as readonly string[]).includes(opts.scenario)) throw new BadRequestError(`scenario must be one of ${BUDGET_SCENARIOS.join(", ")}.`);
    const budgets = await budgetsRepository.list({ containing: opts.as_of || undefined, scenario: opts.scenario || undefined });
    const versions = await budgetsRepository.versionsOf(budgets.map((b) => b.id));
    return budgets.map((b) => summaryOut(b, versions));
  },

  accounts() {
    return budgetsRepository.plAccounts().then((rows) => rows.map((a) => ({ id: a.id, name: a.name, nameAr: a.nameAr ?? null, type: plType(a.type) })));
  },

  async detail(id: number, versionId?: number) {
    const b = await loadBudget(id);
    const versions = await budgetsRepository.versionsOf([id]);
    let chosen: BudgetVersionRow | undefined;
    if (versionId != null) {
      chosen = versions.find((v) => v.id === versionId);
      if (!chosen) throw new NotFoundError("Budget version not found.");
    } else {
      chosen = versions.find(isOpen) ?? versions.find((v) => v.status === "approved") ?? versions[versions.length - 1];
    }
    const lines = chosen ? groupLines(await budgetsRepository.linesOf(chosen.id)) : [];
    return {
      ...summaryOut(b, versions),
      periods: periodsOf(b),
      version: chosen ? versionOut(chosen) : null,
      lines: linesOut(lines),
      totals: {
        income: fromHalalas(sumH(lines.filter((l) => l.accountType === "income").map(lineTotalH))),
        expense: fromHalalas(sumH(lines.filter((l) => l.accountType === "expense").map(lineTotalH))),
      },
    };
  },

  async create(input: { name: string; nameAr?: string | null; fiscalYearLabel: number; scenario?: string; notes?: string | null }, userId: number | null) {
    // the company IN SCOPE (the request's company GUC) — a budget belongs to it (F-19)
    const company = await companiesRepository.findCurrent();
    if (!company) throw new NotFoundError("No company is configured for this organization.");
    // D15-15 — M20's F8 rule: an undeclared fiscal year is never assumed to be the calendar year
    if (company.fiscalYearStart == null) {
      throw new BusinessRuleError(422, {
        code: "fiscal_year_undeclared",
        error: "Declare the company's fiscal year in Company Settings before creating a budget. A budget is set per fiscal year, and an undeclared year is never assumed to be the calendar year.",
      });
    }
    const calendar: FiscalCalendar = isFiscalCalendar(company.fiscalCalendar) ? company.fiscalCalendar : "gregorian";
    const scenario = (input.scenario ?? "base") as BudgetScenario;
    if (!(BUDGET_SCENARIOS as readonly string[]).includes(scenario)) throw new BadRequestError(`scenario must be one of ${BUDGET_SCENARIOS.join(", ")}.`);
    if (!Number.isInteger(input.fiscalYearLabel)) throw new BadRequestError("fiscalYearLabel must be a year number.");
    let fy;
    try {
      fy = resolveFiscalYear({ fiscalYearStart: company.fiscalYearStart, calendar }, input.fiscalYearLabel);
    } catch (e) {
      throw new BadRequestError(e instanceof Error ? e.message : "That fiscal year cannot be resolved.");
    }
    const name = input.name.trim();
    if (!name) throw new BadRequestError("name is required.");
    const existing = await budgetsRepository.list({ scenario });
    if (existing.some((b) => b.fiscalYearStart === fy.startDate && b.name === name)) {
      throw new BusinessRuleError(409, { code: "budget_exists", error: `A ${scenario} budget named "${name}" already exists for the fiscal year ${fy.startDate} – ${fy.endDate}.` });
    }
    const [b] = await budgetsRepository.insertBudget({
      name, nameAr: input.nameAr?.trim() ? input.nameAr.trim() : null, scenario,
      fiscalCalendar: calendar, fiscalStartMonth: company.fiscalYearStart, fiscalLabel: fy.label, fiscalYearStart: fy.startDate, fiscalYearEnd: fy.endDate,
      notes: input.notes?.trim() ? input.notes.trim() : null, createdBy: userId,
    });
    const [v] = await budgetsRepository.insertVersion({ budgetId: b!.id, versionNo: 1, status: "draft", createdBy: userId });
    await auditService.created("budget", b!.id, { budget: b, version: versionOut(v!) });
    return budgetsService.detail(b!.id, v!.id);
  },

  async update(id: number, input: { name?: string; nameAr?: string | null; notes?: string | null }) {
    const before = await loadBudget(id);
    const patch: Record<string, unknown> = {};
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name) throw new BadRequestError("name cannot be empty.");
      patch.name = name;
    }
    if (input.nameAr !== undefined) patch.nameAr = input.nameAr?.trim() ? input.nameAr.trim() : null;
    if (input.notes !== undefined) patch.notes = input.notes?.trim() ? input.notes.trim() : null;
    if (Object.keys(patch).length > 0) {
      const [after] = await budgetsRepository.updateBudget(id, patch);
      await auditService.updated("budget", id, before, after);
    }
    return budgetsService.detail(id);
  },

  async remove(id: number) {
    const before = await loadBudget(id);
    const versions = await budgetsRepository.versionsOf([id]);
    if (versions.some((v) => v.status === "approved" || v.status === "superseded")) {
      throw new BusinessRuleError(409, { code: "budget_ever_approved", error: "This budget has been approved — an approved budget is a record and is never deleted. Start a revision to change it." });
    }
    await budgetsRepository.deleteBudget(id);
    await auditService.deleted("budget", id, { budget: before, versions: versions.map(versionOut) });
  },

  async replaceLines(budgetId: number, versionId: number, input: { lines: { accountId: number; periods?: number[]; annualAmount?: number }[] }) {
    await loadBudget(budgetId);
    const v = await loadVersionOf(budgetId, versionId);
    if (v.status !== "draft") throw lockedError(v);

    const seen = new Set<number>();
    const rows: { versionId: number; accountId: number; periodNo: number | null; amount: string }[] = [];
    for (const [i, l] of input.lines.entries()) {
      if (seen.has(l.accountId)) throw new BadRequestError(`lines[${i}]: account ${l.accountId} appears twice — one line per account.`);
      seen.add(l.accountId);
      const hasPeriods = Array.isArray(l.periods), hasAnnual = l.annualAmount != null;
      if (hasPeriods === hasAnnual) throw new BadRequestError(`lines[${i}]: give EITHER twelve period amounts OR one annual amount — an annual amount is never divided across periods.`);
      const toH = (x: number, where: string) => {
        try {
          // a number with a fraction of a halala is REFUSED, never rounded (1.005 is not 1.00 or 1.01)
          if (typeof x === "number" && Math.abs(x * 100 - Math.round(x * 100)) > 1e-6) throw new RangeError("sub-halala");
          const h = toHalalas(x);
          // numeric(15,2): at most 9,999,999,999,999.99 — refused here, not overflowed into a 500
          if (h < 0 || h > MAX_LINE_HALALAS) throw new RangeError("out of range");
          return h;
        } catch {
          throw new BadRequestError(`${where}: ${x} is not an amount from 0 to 9,999,999,999,999.99 with at most two decimals.`);
        }
      };
      if (hasPeriods) {
        if (l.periods!.length !== 12) throw new BadRequestError(`lines[${i}]: exactly twelve period amounts are required.`);
        l.periods!.forEach((x, p) => rows.push({ versionId, accountId: l.accountId, periodNo: p + 1, amount: money2(fromHalalas(toH(x, `lines[${i}].periods[${p}]`))) }));
      } else {
        rows.push({ versionId, accountId: l.accountId, periodNo: null, amount: money2(fromHalalas(toH(l.annualAmount!, `lines[${i}].annualAmount`))) });
      }
    }
    // the database admits only income/expense posting accounts of this organisation; say which ones failed first
    const allowed = new Set((await budgetsRepository.plAccounts()).map((a) => a.id));
    const bad = [...seen].filter((id) => !allowed.has(id));
    if (bad.length > 0) {
      throw new BusinessRuleError(422, { code: "budget_account_invalid", accountIds: bad, error: `Account${bad.length > 1 ? "s" : ""} ${bad.join(", ")} ${bad.length > 1 ? "are" : "is"} not an income or expense posting account of this organisation — a budget line names a P&L account.` });
    }

    const before = linesOut(groupLines(await budgetsRepository.linesOf(versionId)));
    await budgetsRepository.deleteLines(versionId);
    await budgetsRepository.insertLines(rows);
    const after = linesOut(groupLines(await budgetsRepository.linesOf(versionId)));
    await auditService.record({ action: "update", entityType: "budget_version_lines", entityId: versionId, before: { lines: before }, after: { lines: after } });
    return budgetsService.detail(budgetId, versionId);
  },

  async revise(budgetId: number, userId: number | null) {
    await loadBudget(budgetId);
    const versions = await budgetsRepository.versionsOf([budgetId]);
    const open = versions.find(isOpen);
    if (open) throw new BusinessRuleError(409, { code: "budget_version_open", error: `Version ${open.versionNo} is still ${open.status} — finish or reject it before starting another revision.` });
    const approved = versions.find((v) => v.status === "approved");
    if (!approved) throw new BusinessRuleError(409, { code: "budget_not_approved", error: "Only an approved budget is revised. This budget has no approved version." });
    const [{ next }] = await budgetsRepository.nextVersionNo(budgetId);
    const [nv] = await budgetsRepository.insertVersion({ budgetId, versionNo: Number(next), status: "draft", basedOnVersionId: approved.id, createdBy: userId });
    await budgetsRepository.copyLines(approved.id, nv!.id);
    await auditService.created("budget_version", nv!.id, { ...versionOut(nv!), basedOn: approved.versionNo });
    return budgetsService.detail(budgetId, nv!.id);
  },

  // ── transitions — the ONE approval engine (D15-04) ──────────────────────
  async submit(budgetId: number, versionId: number, userId: number | null) {
    await loadVersionOf(budgetId, versionId);
    await approvalService.submit(budgetVersionApprovable(), versionId, { userId });
    return budgetsService.detail(budgetId, versionId);
  },
  async approve(budgetId: number, versionId: number, userId: number | null) {
    const v = await loadVersionOf(budgetId, versionId);
    if (v.status === "approved" || v.status === "superseded") {
      throw new BusinessRuleError(409, { code: "budget_version_approved", error: `Version ${v.versionNo} is already ${v.status}.` });
    }
    await approvalService.approve(budgetVersionApprovable(), versionId, { userId });
    return budgetsService.detail(budgetId, versionId);
  },
  async sendBack(budgetId: number, versionId: number, note: string | null | undefined, userId: number | null) {
    await loadVersionOf(budgetId, versionId);
    await approvalService.sendBack(budgetVersionApprovable(), versionId, { userId }, note ?? undefined);
    return budgetsService.detail(budgetId, versionId);
  },
  async reject(budgetId: number, versionId: number, userId: number | null) {
    const v = await loadVersionOf(budgetId, versionId);
    if (v.status === "approved" || v.status === "superseded") {
      throw new BusinessRuleError(409, { code: "budget_version_approved", error: `Version ${v.versionNo} is ${v.status} — an approved budget is a record and cannot be rejected. Start a revision to change it.` });
    }
    await approvalService.reject(budgetVersionApprovable(), versionId, { userId });
  },

  /**
   * D15-06 … D15-09. `through_period` defaults to the last fiscal period that
   * ENDED before today (business date): a whole period's budget is never set
   * against part of a period's actual.
   */
  async vsActual(budgetId: number, opts: { version_id?: number; through_period?: number } = {}) {
    const b = await loadBudget(budgetId);
    const versions = await budgetsRepository.versionsOf([budgetId]);
    const version = opts.version_id != null
      ? versions.find((v) => v.id === opts.version_id)
      : versions.find((v) => v.status === "approved") ?? versions.find(isOpen) ?? versions[versions.length - 1];
    if (!version) throw new NotFoundError("Budget version not found.");
    const periods = periodsOf(b);
    const today = businessToday();
    const k = opts.through_period ?? periods.filter((p) => p.endDate < today).length;
    if (!Number.isInteger(k) || k < 0 || k > 12) throw new BadRequestError("through_period must be a whole number from 0 to 12.");

    const lines = groupLines(await budgetsRepository.linesOf(version.id));
    const cats = await reportsRepository.allCategories();
    const plCats = cats.filter((c) => isPlType(c.type));
    const typeOf = new Map(plCats.map((c) => [c.id, plType(c.type)]));
    // ONE seam read: every P&L account's movement in each of the twelve periods (Phase 14 D14-12)
    const [moved, migratedRows] = await Promise.all([
      reportsRepository.ledgerMovementsByPeriod(
        periods.map((p) => ({ key: String(p.no), start: p.startDate, end: p.endDate })),
        { accountIds: plCats.map((c) => c.id), excludeOpeningSources: true },
      ),
      // a migration's year-to-date P&L is ONE amount on its date: never spread across the months it
      // covers — the "do not apportion" rule applied to actuals (accounting review M2, 2026-10-01)
      reportsRepository.openingSourceMovements(b.fiscalYearStart, b.fiscalYearEnd, { accountIds: plCats.map((c) => c.id) }),
    ]);
    const actualH = new Map<number, number[]>();
    for (const r of moved) {
      if (r.accountId == null) continue;
      const t = typeOf.get(r.accountId);
      if (!t) continue;
      const arr = actualH.get(r.accountId) ?? Array(12).fill(0);
      const signed = t === "income" ? toHalalas(r.credit) - toHalalas(r.debit) : toHalalas(r.debit) - toHalalas(r.credit);
      arr[Number(r.period) - 1] += signed;
      actualH.set(r.accountId, arr);
    }

    const migrated = new Map<number, { h: number; date: string }>();
    for (const r of migratedRows) {
      if (r.accountId == null) continue;
      const t = typeOf.get(r.accountId);
      if (!t) continue;
      const h = t === "income" ? toHalalas(r.credit) - toHalalas(r.debit) : toHalalas(r.debit) - toHalalas(r.credit);
      if (h !== 0) migrated.set(r.accountId, { h, date: r.date });
    }
    const throughDate = k > 0 ? periods[k - 1]!.endDate : null;
    type Built = { type: PlType; mode: "periods" | "annual" | "unbudgeted"; ytdBudgetH: number | null; ytdActualH: number; fyBudgetH: number | null; fyActualH: number; forecastH: number | null; restBudgetH: number };
    const built: Built[] = [];
    const buildLine = (l: { accountId: number; accountName: string; accountNameAr: string | null; accountType: PlType; mode: "periods" | "annual" | "unbudgeted"; periodsH: number[] | null; annualH: number | null }) => {
      const act = actualH.get(l.accountId) ?? Array(12).fill(0);
      const mig = migrated.get(l.accountId);
      // the migrated amount is in the year to date once its date is
      const migInH = mig && throughDate && mig.date <= throughDate ? mig.h : 0;
      const ytdActualH = sumH(act.slice(0, k)) + migInH;
      const fyActualH = sumH(act) + (mig?.h ?? 0);
      const ytdBudgetH = l.mode === "periods" ? sumH(l.periodsH!.slice(0, k)) : null;
      const fyBudgetH = l.mode === "periods" ? sumH(l.periodsH!) : l.mode === "annual" ? l.annualH : null;
      const restBudgetH = l.mode === "periods" ? sumH(l.periodsH!.slice(k)) : 0;
      const forecastH = l.mode === "periods" ? ytdActualH + restBudgetH : null;
      const fVarH = forecastH == null || fyBudgetH == null ? null : forecastH - fyBudgetH;
      const out = {
        accountId: l.accountId, accountName: l.accountName, accountNameAr: l.accountNameAr, accountType: l.accountType, mode: l.mode,
        migrated: mig ? { amount: fromHalalas(mig.h), date: mig.date } : null,
        periods: act.map((a, i) => {
          const budgetH = l.mode === "periods" ? l.periodsH![i]! : null;
          const f = figure({ budgetH, actualH: a }, l.accountType);
          return { no: i + 1, budget: f.budget, actual: f.actual, variance: f.variance, variancePct: f.variancePct };
        }),
        ytd: figure({ budgetH: ytdBudgetH, actualH: ytdActualH }, l.accountType),
        fullYear: { budget: fyBudgetH == null ? null : fromHalalas(fyBudgetH), actualToDate: fromHalalas(fyActualH), remaining: fyBudgetH == null ? null : fromHalalas(fyBudgetH - fyActualH) },
        forecast: {
          amount: forecastH == null ? null : fromHalalas(forecastH),
          variance: fVarH == null ? null : fromHalalas(fVarH),
          favourable: fVarH == null ? null : l.accountType === "expense" ? fVarH <= 0 : fVarH >= 0,
          reason: l.mode === "annual" ? ("annual_only" as const) : l.mode === "unbudgeted" ? ("unbudgeted" as const) : null,
        },
      };
      built.push({ type: l.accountType, mode: l.mode, ytdBudgetH, ytdActualH, fyBudgetH, fyActualH, forecastH, restBudgetH });
      return out;
    };
    const lineOut = lines
      .sort((a, b2) => (a.accountType === b2.accountType ? a.accountName.localeCompare(b2.accountName) : a.accountType === "income" ? -1 : 1))
      .map((l) => buildLine(l));
    const budgeted = new Set(lines.map((l) => l.accountId));
    const catById = new Map(plCats.map((c) => [c.id, c]));
    const movedIds = new Set([...actualH.entries()].filter(([, arr]) => arr.some((x) => x !== 0)).map(([id]) => id).concat([...migrated.keys()]));
    const unbudgeted = [...movedIds]
      .filter((id) => !budgeted.has(id))
      .map((id) => catById.get(id)!)
      .sort((a, b2) => (plType(a.type) === plType(b2.type) ? a.name.localeCompare(b2.name) : plType(a.type) === "income" ? -1 : 1))
      .map((c) => buildLine({ accountId: c.id, accountName: c.name, accountNameAr: c.nameAr ?? null, accountType: plType(c.type), mode: "unbudgeted", periodsH: null, annualH: null }));

    // Totals: actual covers budgeted AND unbudgeted accounts, so it ties to the income statement (P4);
    // a YTD budget or forecast total is withheld (null) rather than PARTIAL when an annual-only line is in the group.
    const totalsFor = (type: PlType) => {
      const g = built.filter((x) => x.type === type);
      const annualOnly = g.filter((x) => x.mode === "annual").length;
      const ytdBudgetH = annualOnly > 0 ? null : sumH(g.filter((x) => x.mode === "periods").map((x) => x.ytdBudgetH!));
      const fyBudgetH = sumH(g.filter((x) => x.mode !== "unbudgeted").map((x) => x.fyBudgetH ?? 0));
      const ytdActualH = sumH(g.map((x) => x.ytdActualH));
      const fyActualH = sumH(g.map((x) => x.fyActualH));
      const forecastH = annualOnly > 0 ? null : ytdActualH + sumH(g.map((x) => x.restBudgetH));
      return { ytdBudgetH, ytdActualH, fyBudgetH, fyActualH, forecastH, annualOnly };
    };
    const shape = (t: ReturnType<typeof totalsFor>, type: PlType | "net") => {
      const fVarH = t.forecastH == null ? null : t.forecastH - t.fyBudgetH;
      return {
        ytd: figure({ budgetH: t.ytdBudgetH, actualH: t.ytdActualH }, type),
        fullYear: { budget: fromHalalas(t.fyBudgetH), actualToDate: fromHalalas(t.fyActualH), remaining: fromHalalas(t.fyBudgetH - t.fyActualH) },
        forecast: {
          amount: t.forecastH == null ? null : fromHalalas(t.forecastH),
          variance: fVarH == null ? null : fromHalalas(fVarH),
          favourable: fVarH == null ? null : type === "expense" ? fVarH <= 0 : fVarH >= 0,
          reason: t.forecastH == null ? ("annual_only" as const) : null,
        },
        annualOnlyLines: t.annualOnly,
      };
    };
    const inc = totalsFor("income"), exp = totalsFor("expense");
    const net = {
      ytdBudgetH: inc.ytdBudgetH == null || exp.ytdBudgetH == null ? null : inc.ytdBudgetH - exp.ytdBudgetH,
      ytdActualH: inc.ytdActualH - exp.ytdActualH,
      fyBudgetH: inc.fyBudgetH - exp.fyBudgetH,
      fyActualH: inc.fyActualH - exp.fyActualH,
      forecastH: inc.forecastH == null || exp.forecastH == null ? null : inc.forecastH - exp.forecastH,
      annualOnly: inc.annualOnly + exp.annualOnly,
    };

    return {
      budgetId: b.id, name: b.name, nameAr: b.nameAr ?? null, scenario: b.scenario as BudgetScenario,
      version: versionOut(version), fiscalYear: fiscalYearOf(b), periods,
      throughPeriod: k, throughDate,
      basis: "accrual_gl" as const,
      lines: lineOut, unbudgeted,
      totals: { income: shape(inc, "income"), expense: shape(exp, "expense"), net: shape(net, "net") },
    };
  },
};
