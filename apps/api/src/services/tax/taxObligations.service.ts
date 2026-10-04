/**
 * THE TAX OBLIGATIONS CALENDAR — what the company owes the State, from the
 * ledger, with the regulation's due date (pack §6, §8.4). Read by the tax
 * workspace and by Treasury (Phase 17) as EXPECTED outflows.
 *
 * Every amount is a ledger or WHT-ledger figure; every date is a statutory
 * rule applied to a declared fact. Where the date (or the amount) cannot be
 * established, the obligation says so — `dueDate: null` with its reason —
 * never a guessed day.
 *
 *   WHT       per month unremitted; due the 10th of the next month (IR Art. 63(9)(a))
 *   Zakat     the ZAKAT_PAYMENT balance; due 120 days after the year-end (Zakat Regs Art. 102(1))
 *   Income    the INCOME_TAX_PAYABLE balance; due 120 days after the year-end (ITL Arts 60(b), 69)
 *   VAT       the return's net VAT for the last completed tax period, less VAT payments booked
 *             since it ended; due the last day of the following month (VAT IR "Payment of Tax")
 */
import { businessToday } from "@workspace/shared";
import { SYSTEM_ACCOUNTS } from "@workspace/db";
import { fromHalalas, round2, toHalalas } from "../../lib/money";
import { reportsRepository } from "../../repositories/reports.repository";
import { taxRepository } from "../../repositories/tax.repository";
import { companiesRepository } from "../../repositories/companies.repository";
import { reportsService } from "../reports.service";
import { addDays } from "./taxComputations.service";
import { whtDueDate } from "./wht.service";

export type TaxObligation = {
  kind: "wht" | "zakat" | "income_tax" | "vat";
  reference: string;
  amount: number;
  dueDate: string | null;
  /** Why the date is null, or what it assumes. */
  note: string | null;
  /** Where the figure comes from — every figure drills to its source. */
  source: { type: "wht_period" | "gl_account" | "vat_return"; period?: string | null; systemCode?: string; from?: string; to?: string };
  overdue: boolean;
};

/** Credit-positive GL balances of system-coded accounts as of a date (this company, in the books) — the Phase 14 seam. */
export async function liabilityBalances(codes: string[], asOf: string): Promise<Map<string, number>> {
  const cats = await reportsRepository.allCategories();
  const idToCode = new Map(cats.filter((c) => c.systemCode && codes.includes(c.systemCode)).map((c) => [c.id, c.systemCode!]));
  const rows = idToCode.size ? await reportsRepository.ledgerBalances({ to: asOf, accountIds: [...idToCode.keys()] }) : [];
  const out = new Map<string, number>(codes.map((c) => [c, 0]));
  for (const r of rows) {
    const code = r.accountId != null ? idToCode.get(r.accountId) : undefined;
    if (!code) continue;
    const debitPositiveH = toHalalas(r.opening) + toHalalas(r.debit) - toHalalas(r.credit);
    out.set(code, fromHalalas(toHalalas(out.get(code) ?? 0) - debitPositiveH));
  }
  return out;
}

const lastDayOfMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); // m 1-based → day 0 of next
/** The VAT tax period containing a date: a calendar month, or (an assumption) a calendar quarter. */
function vatPeriodContaining(date: string, kind: "monthly" | "quarterly") {
  const [y, m] = date.split("-").map(Number) as [number, number];
  const startMonth = kind === "monthly" ? m : Math.floor((m - 1) / 3) * 3 + 1;
  const endMonth = kind === "monthly" ? m : startMonth + 2;
  return { from: `${y}-${String(startMonth).padStart(2, "0")}-01`, to: lastDayOfMonth(y, endMonth) };
}
const dayBefore = (d: string) => addDays(d, -1);
/** The last day of the month following a period end — the VAT payment deadline. */
const vatDue = (periodEnd: string) => {
  const [y, m] = periodEnd.split("-").map(Number) as [number, number];
  return lastDayOfMonth(m === 12 ? y + 1 : y, m === 12 ? 1 : m + 1);
};

export const taxObligationsService = {
  async list(asOfParam?: string) {
    const today = businessToday();
    const asOf = asOfParam ?? today;
    const out: TaxObligation[] = [];

    // ── WHT — per month, the WHT ledger's own unremitted figure ──────────────
    const periods = await taxRepository.periods();
    for (const p of periods) {
      const outstanding = round2(Number(p.withheld) - Number(p.remitted));
      if (outstanding <= 0) continue;
      const due = whtDueDate(p.period);
      out.push({ kind: "wht", reference: p.period, amount: outstanding, dueDate: due, note: null, source: { type: "wht_period", period: p.period }, overdue: due < today });
    }
    const opening = await taxRepository.unremitted(null);
    if (opening > 0) out.push({ kind: "wht", reference: "opening", amount: opening, dueDate: null, note: "Migrated opening WHT payable: its months are the previous system's, so its due date is not known here.", source: { type: "wht_period", period: null }, overdue: false });

    // ── Zakat and income tax — the payable balances, dated by the latest approved computation ──
    const balances = await liabilityBalances([SYSTEM_ACCOUNTS.ZAKAT_PAYMENT, SYSTEM_ACCOUNTS.INCOME_TAX_PAYABLE], asOf);
    const comps = await taxRepository.computations();
    const versions = await taxRepository.versionsOf(comps.map((c) => c.id));
    for (const [kind, code] of [["zakat", SYSTEM_ACCOUNTS.ZAKAT_PAYMENT], ["income_tax", SYSTEM_ACCOUNTS.INCOME_TAX_PAYABLE]] as const) {
      const bal = round2(balances.get(code) ?? 0);
      if (bal <= 0) continue;
      const latest = comps
        .filter((c) => c.kind === kind && versions.some((v) => v.computationId === c.id && (v.status === "approved" || v.status === "superseded")))
        .sort((a, b) => b.fiscalYearEnd.localeCompare(a.fiscalYearEnd))[0];
      const due = latest ? addDays(latest.fiscalYearEnd, 120) : null;
      out.push({
        kind, reference: latest ? `FY ${latest.fiscalYearStart} – ${latest.fiscalYearEnd}` : "payable",
        amount: bal, dueDate: due,
        note: latest ? "120 days after the fiscal year-end of the latest approved computation; a balance from earlier years is shown with it." : "No approved computation dates this balance.",
        source: { type: "gl_account", systemCode: code }, overdue: due != null && due < today,
      });
    }

    // ── VAT — the return's own figure, for a declared tax period ─────────────
    const company = await companiesRepository.findCurrent();
    const vatKind = company?.vatTaxPeriod === "monthly" || company?.vatTaxPeriod === "quarterly" ? company.vatTaxPeriod : null;
    if (!vatKind) {
      out.push({ kind: "vat", reference: "VAT", amount: 0, dueDate: null, note: "The company's VAT tax period (monthly or quarterly) is not declared, so VAT is not projected. Declare it in Company Settings.", source: { type: "vat_return" }, overdue: false });
    } else {
      const assumption = vatKind === "quarterly" ? "Quarters are taken as calendar quarters (ZATCA notifies each taxpayer's own periods)." : null;
      const current = vatPeriodContaining(today, vatKind);
      const last = vatPeriodContaining(dayBefore(current.from), vatKind);
      const lastDue = vatDue(last.to);
      // 🔴 Listed while unpaid — and kept AFTER its due date, flagged overdue (audit 2026-10-04: it used to
      // vanish from the calendar, and from Treasury, the day it became overdue — the case most worth seeing).
      // Earlier periods are not projected (payments name no period); the row says so.
      const ret = await reportsService.vatReturn(last.from, last.to);
      // VAT payments booked since the period ended are presumed to be for it (labelled)
      const paidSince = await taxRepository.movementBySystemCode(["VAT_PAYMENT"], addDays(last.to, 1), today);
      const amount = round2(Number(ret.netVatDue) - (paidSince.get("VAT_PAYMENT") ?? 0));
      if (amount > 0) out.push({ kind: "vat", reference: `${last.from} – ${last.to}`, amount, dueDate: lastDue, note: ["Net VAT per the return, less VAT payments booked since the period ended (presumed for it). Periods before it are not projected here — the VAT return answers for each.", assumption].filter(Boolean).join(" "), source: { type: "vat_return", from: last.from, to: last.to }, overdue: lastDue < today });
      const toDate = await reportsService.vatReturn(current.from, today);
      const amt = round2(Number(toDate.netVatDue));
      if (amt > 0) out.push({ kind: "vat", reference: `${current.from} – ${current.to} (to date)`, amount: amt, dueDate: vatDue(current.to), note: ["The current period TO DATE — it grows until the period ends.", assumption].filter(Boolean).join(" "), source: { type: "vat_return", from: current.from, to: today }, overdue: false });
    }

    out.sort((a, b) => (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999"));
    return { asOf, obligations: out, total: round2(out.reduce((s, o) => s + o.amount, 0)) };
  },
};
