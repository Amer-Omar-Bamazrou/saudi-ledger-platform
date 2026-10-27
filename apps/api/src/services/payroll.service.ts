/**
 * Payroll service — run generation (GOSI computed per employee) and the
 * draft/approval workflow (M10.5).
 *
 * The draft→submitted→approved transitions are delegated to the generic
 * {@link approvalService} via the {@link payrollApprovable} adapter — the same
 * engine journal entries, bills, and invoices use. Approval fires the run's
 * existing GL posting (via services/accounting/glPosting), unchanged. Payroll
 * has always been a two-step create→approve flow, so there is no
 * self-approve-on-create: `create` yields a draft for everyone.
 *
 * GOSI rates + all arithmetic preserved exactly from the pre-M6 route.
 */
import { BadRequestError, BusinessRuleError, NotFoundError } from "../lib/errors";
import { auditService } from "./audit.service";
import { approvalService } from "./approval";
import { payrollApprovable } from "./payroll.approvable";
import { runToOut, itemToOut, toNum } from "./payroll.presenter";
import { payrollRepository } from "../repositories/payroll.repository";
import { round2, money2 } from "../lib/money";
import {
  businessToday, gosiContributoryWage, gosiHazardsMinimumOpen, gosiInKindHousingValue, gosiLineAmounts, gosiRatesFor, gosiServiceDays, type GosiRegime,
} from "@workspace/shared";
import { postJournalEntry } from "./accounting/glPosting";
import { assertBankAccount } from "./accounting/bankIdentity";
import { assertDateString } from "../lib/writeGuards";

export const payrollService = {
  async list() {
    const [rows, itemTotals] = await Promise.all([
      payrollRepository.listRuns(),
      payrollRepository.runItemTotals(),
    ]);
    const byRun = new Map(itemTotals.map((t) => [t.payrollRunId, t]));
    return rows.map((r) => {
      const t = byRun.get(r.id);
      return {
        ...runToOut(r),
        employeeCount: Number(t?.employeeCount ?? 0),
        grossSalary: Number(t?.grossSalary ?? 0),
      };
    });
  },

  async getById(id: number) {
    const [run] = await payrollRepository.findRun(id);
    if (!run) throw new NotFoundError("Not found");
    const items = await payrollRepository.itemsWithEmployee(id);
    return {
      ...runToOut(run),
      items: items.map((r) => ({
        ...itemToOut(r.item),
        employeeName: r.emp?.name ?? null,
        employeeNumber: r.emp?.employeeNumber ?? null,
      })),
    };
  },

  async create(body: { period: string; notes?: string | null }, userId: number | null) {
    const { period, notes } = body;
    const employees = await payrollRepository.activeEmployees();
    if (employees.length === 0) throw new BadRequestError("No active employees found");

    let totalBasic = 0;
    let totalAllowances = 0;
    let totalGosiEmp = 0;
    let totalGosiEr = 0;
    let totalNet = 0;
    /**
     * 🔴 N2 (2026-09-03): every per-employee figure is ROUNDED BEFORE it is
     * accumulated, so the run's headers equal the sum of the stored payslips
     * EXACTLY — the invoice path's "header = Σ rounded lines" rule
     * (invoices.service.create), which this file never received.
     *
     * The old shape accumulated raw `basic * 0.0975` while each payslip
     * stored `.toFixed(2)`, so header ≠ Σ payslips by up to a halala per
     * employee — and the GL, built from the headers, failed the balance check
     * for 10.3% of salary values (185/1,801 measured; basic 3,010 × 3 Saudi
     * employees is the worked example), surfacing as an opaque 500 on
     * approve. With rounded accumulation the GL balances BY CONSTRUCTION:
     * net_i = gross_i − gosiEmp_i holds exactly at 2dp per employee, so
     * Σnet = Σgross − ΣgosiEmp holds exactly for the headers too.
     */
    /**
     * 🔴 GOSI (Phase 18, owner 2026-10-26 night): each line is computed from the
     * effective-dated table (`@workspace/shared` gosi.ts) for its regime and this
     * run's period, on the contributory wage (basic + housing, capped at SAR
     * 45,000), and RECORDS what it used. Two refusals, nothing written:
     *  - a Saudi employee whose law is not stated (it is the employer's fact, from
     *    contribution history; a guessed regime would be a precise, wrong figure);
     *  - a period the table does not cover for a regime (a 2024-law period before
     *    July 2024, when that law took effect).
     */
    const regimeOf = (emp: (typeof employees)[number]): GosiRegime | null =>
      emp.nationality === "SA" ? ((emp.gosiRegime as GosiRegime | null) ?? null) : "non_saudi";
    const unstated = employees.filter((e) => regimeOf(e) === null);
    if (unstated.length > 0) {
      throw new BusinessRuleError(422, {
        code: "gosi_regime_required",
        error:
          `GOSI cannot be computed for ${unstated.length} Saudi employee(s) whose Social Insurance law is not stated: ` +
          `${unstated.map((e) => e.name).join(", ")}. Set each one's GOSI law (the 1421H law or the 2024 law, from their ` +
          `contribution history — not their hire date) on the Employees page, then generate the run again. Nothing was created.`,
        employees: unstated.map((e) => ({ id: e.id, name: e.name, nameAr: e.nameAr ?? null })),
      });
    }
    const uncovered = [...new Set(employees.map((e) => regimeOf(e)!))].filter((r) => gosiRatesFor(r, period) === null);
    if (uncovered.length > 0) {
      throw new BusinessRuleError(422, {
        code: "gosi_rate_unknown_for_period",
        error:
          `No GOSI rate is recorded for ${period} under ${uncovered.join(", ")} (a 2024-law rate starts in July 2024, when ` +
          `that law took effect), so the run is not computed at a guessed rate. Check the period and each employee's GOSI law. ` +
          `Nothing was created.`,
        period,
        regimes: uncovered,
      });
    }

    /**
     * 🔴 GO-10..GO-13 (Phase 18, owner 2026-10-27): the rules on each regime's table entry. In-kind housing counts in
     * the wage (both laws); a 1421H-law line takes the wage its year's first line fixed and the pension floor; a
     * joining or leaving month is charged by days (both laws). Each line records what it used.
     */
    const fixedWages = new Map<number, Awaited<ReturnType<typeof payrollRepository.firstLinesOfYear>>[number]>();
    for (const regime of new Set(employees.map((e) => regimeOf(e)!))) {
      if (!gosiRatesFor(regime, period)!.entry.wageFixedForYear) continue;
      const ids = employees.filter((e) => regimeOf(e) === regime).map((e) => e.id);
      for (const line of await payrollRepository.firstLinesOfYear(ids, period, regime)) fixedWages.set(line.employeeId!, line);
    }

    const items = employees.map((emp) => {
      const basic = toNum(emp.basicSalary);
      const housing = toNum(emp.housingAllowance);
      const transport = toNum(emp.transportAllowance);
      const other = toNum(emp.otherAllowances);
      const gross = round2(basic + housing + transport + other);
      const regime = regimeOf(emp)!;
      const rates = gosiRatesFor(regime, period)!;
      const fixed = rates.entry.wageFixedForYear ? fixedWages.get(emp.id) : undefined;
      const inKind = fixed
        ? (fixed.inKindHousing == null ? null : toNum(fixed.inKindHousing))
        : emp.gosiInKindHousing && !emp.gosiInKindHousingExempt && basic > 0 ? round2(gosiInKindHousingValue(basic)) : null;
      const wage = fixed ? toNum(fixed.wageBase) : round2(gosiContributoryWage(basic, housing, inKind ?? 0));
      const days = rates.entry.prorateJoiningAndLeavingMonths ? gosiServiceDays(period, emp.joiningDate, emp.endDate) : null;
      const amounts = gosiLineAmounts({ rates, wage, serviceDays: days?.serviceDays, periodDays: days?.periodDays });
      const gosiEmp = round2(amounts.employee);
      const gosiEr = round2(amounts.employer);
      const net = round2(gross - gosiEmp);
      totalBasic += basic;
      totalAllowances += housing + transport + other;
      totalGosiEmp += gosiEmp;
      totalGosiEr += gosiEr;
      totalNet += net;
      return {
        employeeId: emp.id,
        basicSalary: String(basic.toFixed(2)),
        housingAllowance: String(housing.toFixed(2)),
        transportAllowance: String(transport.toFixed(2)),
        otherAllowances: String(other.toFixed(2)),
        grossSalary: String(gross.toFixed(2)),
        gosiEmployee: String(gosiEmp.toFixed(2)),
        gosiEmployer: String(gosiEr.toFixed(2)),
        gosiRegime: regime,
        gosiWageBase: money2(wage),
        gosiEmployeeRate: rates.employeeRate.toFixed(4),
        gosiEmployerRate: rates.employerRate.toFixed(4),
        gosiInKindHousing: inKind == null ? null : money2(inKind),
        gosiPensionFloorWage: amounts.pensionFloorWage == null ? null : money2(amounts.pensionFloorWage),
        gosiHazardsFloorOpen: gosiHazardsMinimumOpen(regime, wage),
        gosiServiceDays: days?.serviceDays ?? null,
        gosiPeriodDays: days?.periodDays ?? null,
        gosiWageFixedPeriod: rates.entry.wageFixedForYear ? (fixed ? (fixed.fixedPeriod ?? fixed.period) : period) : null,
        additions: "0",
        deductions: "0",
        netPay: String(net.toFixed(2)),
      };
    });

    const [run] = await payrollRepository.insertRun({
      period,
      status: "draft",
      notes,
      // money2 = round2 then format: sheds the float dust of summing 2dp
      // doubles, so the stored header is the exact sum of the stored payslips.
      totalBasicSalary: money2(totalBasic),
      totalAllowances: money2(totalAllowances),
      totalGosiEmployee: money2(totalGosiEmp),
      totalGosiEmployer: money2(totalGosiEr),
      totalDeductions: "0",
      totalNetPay: money2(totalNet),
      createdBy: userId ?? null,
    } as Parameters<typeof payrollRepository.insertRun>[0]);
    await payrollRepository.insertItems(items.map((i) => ({ ...i, payrollRunId: run.id })));
    await auditService.created("payroll_run", run.id, run);
    return runToOut(run);
  },

  /** Submit a draft run into the approval queue (bookkeeper action). */
  submit(id: number, userId: number | null) {
    return approvalService.submit(payrollApprovable(), id, { userId: userId ?? null });
  },

  /** Send a submitted run back to the enterer for correction (approver action). */
  sendBack(id: number, note: string | undefined, userId: number | null) {
    return approvalService.sendBack(payrollApprovable(), id, { userId: userId ?? null }, note);
  },

  /** Reject (hard-delete) a non-approved run (approver action). */
  reject(id: number, userId: number | null) {
    return approvalService.reject(payrollApprovable(), id, { userId: userId ?? null });
  },

  /** Approve a run — posts the payroll GL entry (Dr Salaries+GOSI / Cr Net+GOSI Payable). */
  approve(id: number, userId: number | null) {
    return approvalService.approve(payrollApprovable(), id, { userId: userId ?? null });
  },

  /**
   * 🔴 DR-41 / DR-39 (Phase 18, owner decision 2.9) — PAY a run's net pay from a bank: Dr Salaries Payable / Cr the
   * bank's cash account. The approval already EXPENSED the salaries; there was no pay path, so the only way to
   * clear the payable was a bank line — which the categoriser booked to the EXPENSE, a second time (reproduced).
   * Paying never touches SALARIES. One payment per run: the run's row is locked, it must be `approved`, and it
   * becomes `paid` only from `approved`. It is refused while Salaries Payable no longer owes the net pay (a bank
   * line already paid it, or one is waiting in review against it — `salaryPayableContext`, the one definition the
   * categoriser also reads). Dated the PAYMENT's day (default today); the accrual's date is AQ-7's open question and
   * is not changed here. A closed period refuses through the posting seam (423).
   */
  async pay(id: number, body: { bankAccountId?: unknown; paidAt?: unknown }, userId: number | null) {
    const bankAccountId = await assertBankAccount(body.bankAccountId, { what: "the net pay left from" });
    const paidAt = body.paidAt == null || body.paidAt === "" ? businessToday() : assertDateString(body.paidAt, "paidAt");
    await payrollRepository.lockRun(id);
    const [run] = await payrollRepository.findRun(id);
    if (!run) throw new NotFoundError("Payroll run not found");
    if (run.status === "paid") throw new BusinessRuleError(409, { code: "payroll_already_paid", error: `Payroll run ${run.period} is already paid.` });
    if (run.status !== "approved") {
      throw new BusinessRuleError(409, { code: "payroll_not_approved", error: `Payroll run ${run.period} is not approved yet; its salaries are not in the books, so there is nothing to pay. Approve it first.` });
    }
    const netPay = toNum(run.totalNetPay);
    const { openPayable } = await payrollRepository.salaryPayableContext();
    if (openPayable + 0.005 < netPay) {
      throw new BusinessRuleError(409, {
        code: "payroll_payable_already_settled",
        error: `Salaries Payable owes ${openPayable.toFixed(2)} (after statement lines waiting in review against it), less than this run's net pay of ${netPay.toFixed(2)}: a bank line has already paid it, or is waiting to. Nothing was recorded. Reconcile that line instead.`,
      });
    }
    const [paid] = await payrollRepository.updateRunIfStatus(id, "approved", { status: "paid" });
    if (!paid) throw new BusinessRuleError(409, { code: "payroll_not_approved", error: `Payroll run ${run.period} changed while it was being paid. Nothing was recorded — reload and try again.` });
    const entry = await postJournalEntry({ sourceType: "payroll_net_pay", sourceId: run.id,
      entryNumber: `PAY-${run.period}-R${run.id}-NET`,
      date: paidAt,
      description: `Net pay for payroll run ${run.period}`,
      reference: `Payroll-${run.id}`,
      lines: [
        { systemCode: "SALARIES_PAYABLE", accountName: "Salaries Payable", description: `Net pay paid ${run.period}`, debitAmount: netPay, creditAmount: 0 },
        { bankAccountId, description: `Net pay ${run.period}`, debitAmount: 0, creditAmount: netPay },
      ],
    });
    await auditService.record({ action: "pay", entityType: "payroll_run", entityId: id, before: runToOut(run), after: { ...runToOut(paid), paidAt, bankAccountId, journalEntryId: entry?.id ?? null, by: userId } });
    return runToOut(paid);
  },

  /**
   * 🔴 GOSI (Phase 18, owner 2026-10-26 night) — PAY a run's GOSI contributions (the employee share withheld plus
   * the employer share) from a bank: Dr GOSI Payable / Cr the bank's cash account. The approval already expensed
   * the employer share and withheld the employee share; nothing settled the payable, so a GOSI bank line was booked
   * to the EXPENSE a second time (DR-41's shape). Paying never touches GOSI_EXPENSE.
   *
   * Once per run (`gosi_paid_at`, set by compare-and-set), for an approved or paid run (net pay and GOSI are paid
   * separately). Refused while GOSI Payable no longer owes the run's contributions: a bank line already paid them,
   * or one is waiting in review against them (`gosiPayableOpen`, the one definition the categoriser also reads).
   * Dated the payment's day (default today). A closed period refuses through the posting seam (423).
   */
  async payGosi(id: number, body: { bankAccountId?: unknown; paidAt?: unknown; invoicedAmount?: unknown; gosiInvoiceReference?: unknown }, userId: number | null) {
    // 🔴 GOSI decision 22 (owner 2026-10-27): GOSI's INVOICED amount, when stated, is what the bank pays.
    // Its difference from the accrual is shown on the run as a reconciling item — never posted to an account
    // the platform would have to guess (a fine, a wage change, a rounding: the user resolves it).
    let invoiced: number | null = null;
    if (body.invoicedAmount != null && body.invoicedAmount !== "") {
      invoiced = Number(body.invoicedAmount);
      if (!Number.isFinite(invoiced) || !(round2(invoiced) > 0)) {
        throw new BusinessRuleError(422, { code: "gosi_invoiced_amount_invalid", field: "invoicedAmount", error: "GOSI's invoiced amount is a positive amount in riyals. Nothing was paid." });
      }
      invoiced = round2(invoiced);
    }
    const invoiceReference = typeof body.gosiInvoiceReference === "string" && body.gosiInvoiceReference.trim() ? body.gosiInvoiceReference.trim() : null;
    const bankAccountId = await assertBankAccount(body.bankAccountId, { what: "the GOSI contributions left from" });
    const paidAt = body.paidAt == null || body.paidAt === "" ? businessToday() : assertDateString(body.paidAt, "paidAt");
    await payrollRepository.lockRun(id);
    const [run] = await payrollRepository.findRun(id);
    if (!run) throw new NotFoundError("Payroll run not found");
    if (run.gosiPaidAt) {
      throw new BusinessRuleError(409, { code: "payroll_gosi_already_paid", error: `Payroll run ${run.period}'s GOSI contributions were already paid on ${run.gosiPaidAt}.` });
    }
    if (run.status !== "approved" && run.status !== "paid") {
      throw new BusinessRuleError(409, { code: "payroll_not_approved", error: `Payroll run ${run.period} is not approved yet; its GOSI contributions are not in the books, so there is nothing to pay. Approve it first.` });
    }
    const amount = round2(toNum(run.totalGosiEmployee) + toNum(run.totalGosiEmployer));
    if (!(amount > 0)) {
      throw new BusinessRuleError(409, { code: "payroll_gosi_nothing_due", error: `Payroll run ${run.period} carries no GOSI contributions, so there is nothing to pay.` });
    }
    const openGosiPayable = await payrollRepository.gosiPayableOpen();
    if (openGosiPayable + 0.005 < amount) {
      throw new BusinessRuleError(409, {
        code: "payroll_gosi_payable_already_settled",
        error: `GOSI Payable owes ${openGosiPayable.toFixed(2)} (after statement lines waiting in review against it), less than this run's GOSI contributions of ${amount.toFixed(2)}: a bank line has already paid them, or is waiting to. Nothing was recorded. Reconcile that line instead.`,
      });
    }
    const [marked] = await payrollRepository.markGosiPaidIfUnpaid(id, paidAt, invoiced, invoiceReference);
    const paidAmount = invoiced ?? amount;
    if (!marked) throw new BusinessRuleError(409, { code: "payroll_gosi_already_paid", error: `Payroll run ${run.period} changed while its GOSI was being paid. Nothing was recorded — reload and try again.` });
    const entry = await postJournalEntry({ sourceType: "payroll_gosi_payment", sourceId: run.id,
      entryNumber: `PAY-${run.period}-R${run.id}-GOSI`,
      date: paidAt,
      description: `GOSI contributions for payroll run ${run.period}`,
      reference: `Payroll-${run.id}`,
      lines: [
        { systemCode: "GOSI_PAYABLE", accountName: "GOSI Payable", description: `GOSI paid ${run.period}${invoiceReference ? ` — GOSI invoice ${invoiceReference}` : ""}`, debitAmount: paidAmount, creditAmount: 0 },
        { bankAccountId, description: `GOSI ${run.period}`, debitAmount: 0, creditAmount: paidAmount },
      ],
    });
    await auditService.record({ action: "pay_gosi", entityType: "payroll_run", entityId: id, before: runToOut(run), after: { ...runToOut(marked), gosiPaidAt: paidAt, amount: paidAmount, accrued: amount, bankAccountId, journalEntryId: entry?.id ?? null, by: userId } });
    return runToOut(marked);
  },
};
