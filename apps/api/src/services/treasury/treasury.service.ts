/**
 * TREASURY — cash position, liquidity, the cash forecast, funding requirement
 * (Phase 17; docs/product/phase-16-17-tax-treasury-decision-pack.md §8).
 *
 * 🔴 NO SECOND SOURCE OF TRUTH. Cash is the ledger (`treasuryRepository
 * .cashByBank`, the D-3 view); what customers owe is the customer statement's
 * own predicates; what is owed to suppliers is `billPosition`; tax is the WHT
 * ledger, the GL payables and the VAT return (`taxObligationsService`). This
 * file ARRANGES those figures by date — it stores none of them.
 *
 * 🔴 A FORECAST IS NEVER CASH. Every row is typed — `committed` · `expected`
 * · `forecast` · `manual` — beside the one `actual` figure (the opening), and
 * carries the source it was read from. Overdue and undated items sit in their
 * own bucket, never silently re-dated to today. Every sum is in halalas.
 */
import { businessToday } from "@workspace/shared";
import { SYSTEM_ACCOUNTS } from "@workspace/db";
import { BadRequestError, BusinessRuleError, NotFoundError } from "../../lib/errors";
import { fromHalalas, round2, toHalalas } from "../../lib/money";
import { treasuryRepository } from "../../repositories/treasury.repository";
import { reportsRepository } from "../../repositories/reports.repository";
import { customerStatementRepository } from "../../repositories/customerStatement.repository";
import { supplierStatementRepository } from "../../repositories/supplierStatement.repository";
import { nextOccurrence, type Frequency } from "../recurring/recurring.service";
import { taxObligationsService, liabilityBalances } from "../tax/taxObligations.service";
import { addDays } from "../tax/taxComputations.service";
import { auditService } from "../audit.service";

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const refuse = (status: number, code: string, error: string, field?: string): never => {
  throw new BusinessRuleError(status, { code, error, ...(field ? { field } : {}) });
};

export type FlowKind = "committed" | "expected" | "forecast" | "manual";
export type FlowCategory = "receivables" | "payables" | "payment_plans" | "tax" | "payroll" | "recurring" | "assumptions";
export interface FlowRow {
  kind: FlowKind;
  category: FlowCategory;
  direction: "in" | "out";
  /** 0 = overdue or undated; 1…N = the week. */
  bucket: number;
  date: string | null;
  amount: number;
  label: string;
  labelAr: string;
  /** Overdue (its date has passed) or undated — the reason it is in bucket 0. */
  bucketReason: "overdue" | "undated" | null;
  source: { type: string; id: number | string | null; reference: string | null };
}

/** A party's numeric payment-terms days, or null (the field is free text: "30", "Net 30", …). */
function termsDays(v: string | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(String(v).trim());
  return Number.isInteger(n) && n >= 0 && n <= 365 ? n : null;
}

export const treasuryService = {
  // ── D17-01: the cash position ───────────────────────────────────────────
  async position(asOfParam?: unknown) {
    const today = businessToday();
    const asOf = asOfParam == null || asOfParam === "" ? today : String(asOfParam);
    if (!ISO.test(asOf)) throw new BadRequestError("as_of must be a calendar date in the form YYYY-MM-DD.");
    // 🔴 a position is ACTUAL: the future is the forecast's (the ageing reports' rule)
    if (asOf > today) refuse(400, "as_of_in_future", `A cash position is what the ledger holds on a day that has happened; ${asOf} is after today (${today}). The forecast projects the future.`, "as_of");

    const [byBank, banks, cats] = await Promise.all([treasuryRepository.cashByBank(asOf), treasuryRepository.banks(asOf), reportsRepository.allCategories()]);
    const balanceH = new Map<number | null, number>(byBank.map((r) => [r.bank_account_id == null ? null : Number(r.bank_account_id), toHalalas(r.balance)]));
    const bankRows = banks.map((b) => {
      const ledgerH = balanceH.get(Number(b.id)) ?? 0;
      const statementClosing = b.statement_closing == null ? null : Number(b.statement_closing);
      return {
        bankAccountId: Number(b.id), name: b.name, bankName: b.bank_name, currency: b.currency, isActive: b.is_active,
        ledgerBalance: fromHalalas(ledgerH),
        overdrawn: ledgerH < 0,
        latestStatement: b.statement_id == null ? null : { id: Number(b.statement_id), periodTo: b.statement_to!, closingBalance: statementClosing! },
        reconciledThrough: b.reconciled_through,
      };
    });
    const unattributedH = balanceH.get(null) ?? 0;
    const totalH = [...balanceH.values()].reduce((s, v) => s + v, 0);

    // T1 — the same total read through the balance-sheet seam: every cash-class account, dated ≤ as_of
    const cashIds = cats.filter((c) => c.liquidityClass === "cash").map((c) => c.id);
    const transferClearing = cats.find((c) => c.systemCode === "TRANSFER_CLEARING");
    const [cashSeam, clearing] = await Promise.all([
      reportsRepository.ledgerBalances({ to: asOf, accountIds: cashIds }),
      reportsRepository.ledgerBalances({ to: asOf, accountIds: transferClearing ? [transferClearing.id] : [] }),
    ]);
    const seamH = cashSeam.reduce((s, r) => s + toHalalas(r.opening) + toHalalas(r.debit) - toHalalas(r.credit), 0);
    const inTransitH = clearing.reduce((s, r) => s + toHalalas(r.opening) + toHalalas(r.debit) - toHalalas(r.credit), 0);

    return {
      asOf,
      banks: bankRows,
      /** Pre-D-3 history on the CASH header, attributed to no bank (CLAUDE.md §5: the cut-over is blocked) — its own line, so the total is right. */
      unattributedCash: fromHalalas(unattributedH),
      totalCash: fromHalalas(totalH),
      /** Own-account transfers in transit (TRANSFER_CLEARING) — beside cash, never in it (IAS 7.9). */
      inTransit: fromHalalas(inTransitH),
      reconciliation: { balanceSheetCash: fromHalalas(seamH), reconciles: seamH === totalH },
      policy: {
        en: "Cash is the ledger: every cash-class account (each bank's own account, and history still on the Cash and Bank header), entries in the books dated on or before the date. An overdrawn bank shows negative and stays in the total, as on the balance sheet (IAS 7.8).",
        ar: "النقد هو ما في الدفاتر: كل حساب من فئة النقد (حساب كل بنك، والحركات التاريخية التي ما زالت على حساب النقد والبنك الرئيسي)، بالقيود المرحَّلة المؤرخة في ذلك التاريخ أو قبله. يظهر البنك المكشوف بالسالب ويبقى ضمن الإجمالي كما في قائمة المركز المالي (معيار المحاسبة الدولي 7.8).",
      },
    };
  },

  // ── D17-03: the forecast ────────────────────────────────────────────────
  async forecast(weeksParam?: unknown) {
    const today = businessToday();
    const settings = await treasuryRepository.settings();
    const weeks = weeksParam == null || weeksParam === "" ? (settings?.forecastHorizonWeeks ?? 13) : Number(weeksParam);
    if (!Number.isInteger(weeks) || weeks < 1 || weeks > 52) throw new BadRequestError("weeks must be a whole number from 1 to 52.");
    const horizonEnd = addDays(today, weeks * 7 - 1);
    const buckets = [
      { index: 0, from: null as string | null, to: null as string | null, label: "Overdue and undated", labelAr: "المتأخر وغير المؤرَّخ" },
      ...Array.from({ length: weeks }, (_, i) => ({ index: i + 1, from: addDays(today, i * 7), to: addDays(today, i * 7 + 6), label: `Week ${i + 1}`, labelAr: `الأسبوع ${i + 1}` })),
    ];
    const bucketOf = (date: string | null): { bucket: number; reason: FlowRow["bucketReason"] } | null => {
      if (date == null) return { bucket: 0, reason: "undated" };
      if (date < today) return { bucket: 0, reason: "overdue" };
      if (date > horizonEnd) return null;
      return { bucket: Math.floor((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / (7 * 86_400_000)) + 1, reason: null };
    };

    const [position, receivables, payables, plans, obligations, payroll, rules, journalRules, entries] = await Promise.all([
      this.position(today),
      customerStatementRepository.openReceivables(),
      supplierStatementRepository.openPayables(),
      treasuryRepository.plans({ status: ["planned", "approved"] }),
      taxObligationsService.list(today),
      liabilityBalances([SYSTEM_ACCOUNTS.SALARIES_PAYABLE, SYSTEM_ACCOUNTS.GOSI_PAYABLE], today),
      treasuryRepository.recurringBases(),
      treasuryRepository.journalRuleCount(),
      treasuryRepository.entries(),
    ]);

    const rows: FlowRow[] = [];
    const beyond = { inflow: 0, outflow: 0, count: 0 };
    const add = (r: Omit<FlowRow, "bucket" | "bucketReason">) => {
      const b = bucketOf(r.date);
      if (!b) {
        beyond.count += 1;
        if (r.direction === "in") beyond.inflow = fromHalalas(toHalalas(beyond.inflow) + toHalalas(r.amount));
        else beyond.outflow = fromHalalas(toHalalas(beyond.outflow) + toHalalas(r.amount));
        return;
      }
      rows.push({ ...r, bucket: b.bucket, bucketReason: b.reason });
    };

    // receivables — EXPECTED at their due date (or their own date when none is stated)
    for (const r of receivables) {
      const amount = Number(r.outstanding);
      if (!(amount > 0)) continue;
      add({ kind: "expected", category: "receivables", direction: "in", date: r.due_date ?? r.date, amount,
        label: `${r.invoice_number ?? `Invoice ${r.id}`}${r.customer_name ? ` — ${r.customer_name}` : ""}`,
        labelAr: `${r.invoice_number ?? `فاتورة ${r.id}`}${r.customer_name_ar || r.customer_name ? ` — ${r.customer_name_ar ?? r.customer_name}` : ""}`,
        source: { type: "invoice", id: Number(r.id), reference: r.invoice_number } });
    }

    // payables — a PLAN displaces the due-date expectation for what it covers (never counted twice)
    const outstandingH = new Map(payables.map((p) => [Number(p.id), Math.max(0, toHalalas(p.outstanding))]));
    const planFlags: Record<number, { coveredH: number; exceeds: boolean; reversed: boolean }> = {};
    for (const p of plans) {
      const billId = Number(p.bill_id);
      // Policy C: a reversed opening bill owes nothing (openPayables already leaves it out) — its plan covers nothing and is flagged
      const left = p.bill_reversed ? 0 : (outstandingH.get(billId) ?? 0);
      const wantH = toHalalas(p.amount);
      const coveredH = Math.min(left, wantH);
      if (!p.bill_reversed) outstandingH.set(billId, left - coveredH);
      planFlags[Number(p.id)] = { coveredH, exceeds: coveredH < wantH, reversed: p.bill_reversed === true };
      if (coveredH <= 0) continue;
      add({ kind: p.status === "approved" ? "committed" : "expected", category: "payment_plans", direction: "out", date: p.planned_date, amount: fromHalalas(coveredH),
        label: `Plan #${p.id}: ${p.bill_number ?? `bill ${billId}`}${p.vendor_name ? ` — ${p.vendor_name}` : ""}${p.status === "approved" ? "" : " (not yet approved)"}`,
        labelAr: `خطة رقم ${p.id}: ${p.bill_number ?? `فاتورة ${billId}`}${p.vendor_name_ar || p.vendor_name ? ` — ${p.vendor_name_ar ?? p.vendor_name}` : ""}${p.status === "approved" ? "" : " (لم تُعتمد بعد)"}`,
        source: { type: "scheduled_payment", id: Number(p.id), reference: p.bill_number } });
    }
    for (const b of payables) {
      const leftH = outstandingH.get(Number(b.id)) ?? 0;
      if (leftH <= 0) continue;
      add({ kind: "expected", category: "payables", direction: "out", date: b.due_date ?? b.date, amount: fromHalalas(leftH),
        label: `${b.bill_number ?? `Bill ${b.id}`}${b.vendor_name ? ` — ${b.vendor_name}` : ""}`,
        labelAr: `${b.bill_number ?? `فاتورة مورد ${b.id}`}${b.vendor_name_ar || b.vendor_name ? ` — ${b.vendor_name_ar ?? b.vendor_name}` : ""}`,
        source: { type: "bill", id: Number(b.id), reference: b.bill_number } });
    }

    // tax — the obligations calendar (statutory due dates; undated when the rule cannot date it)
    for (const o of obligations.obligations) {
      if (!(o.amount > 0)) continue;
      const nameEn = { wht: "Withholding tax", zakat: "Zakat", income_tax: "Income tax", vat: "VAT" }[o.kind];
      const nameAr = { wht: "ضريبة الاستقطاع", zakat: "الزكاة", income_tax: "ضريبة الدخل", vat: "ضريبة القيمة المضافة" }[o.kind];
      add({ kind: "expected", category: "tax", direction: "out", date: o.dueDate, amount: o.amount,
        label: `${nameEn} — ${o.reference}`, labelAr: `${nameAr} — ${o.reference}`,
        source: { type: `tax_${o.kind}`, id: o.reference, reference: o.note } });
    }

    // payroll — the payable balances; no payroll payment path or pay date exists, so UNDATED
    for (const [code, en, ar] of [[SYSTEM_ACCOUNTS.SALARIES_PAYABLE, "Salaries payable", "رواتب مستحقة"], [SYSTEM_ACCOUNTS.GOSI_PAYABLE, "GOSI payable", "تأمينات اجتماعية مستحقة"]] as const) {
      const bal = round2(payroll.get(code) ?? 0);
      if (bal > 0) add({ kind: "expected", category: "payroll", direction: "out", date: null, amount: bal, label: en, labelAr: ar, source: { type: "gl_account", id: code, reference: null } });
    }

    // recurring — FORECAST: each projected run in the horizon, at the run date + the party's numeric terms,
    // for the amount of the LAST document the rule generated (never re-derived from the template)
    let rulesWithoutHistory = 0;
    for (const r of rules) {
      if (r.last_total == null) { rulesWithoutHistory += 1; continue; }
      const terms = termsDays(r.payment_terms_days) ?? 0;
      let run = r.next_run_on;
      for (let guard = 0; guard < 60 && run <= horizonEnd && (!r.ends_on || run <= r.ends_on); guard++) {
        const when = addDays(run, terms);
        add({ kind: "forecast", category: "recurring", direction: r.entity === "invoice" ? "in" : "out", date: when, amount: Number(r.last_total),
          label: `Recurring ${r.entity === "invoice" ? "invoice" : "bill"} run ${run}${r.party_name ? ` — ${r.party_name}` : ""} (as ${r.last_number ?? "the last run"})`,
          labelAr: `تشغيل ${r.entity === "invoice" ? "فاتورة" : "فاتورة مورد"} متكررة ${run}${r.party_name ? ` — ${r.party_name}` : ""} (بمبلغ ${r.last_number ?? "آخر تشغيل"})`,
          source: { type: "recurring_rule", id: r.id, reference: r.last_number } });
        run = nextOccurrence(run, r.frequency as Frequency, r.day_of_month);
      }
    }

    // manual assumptions — dated today or later; a past-dated one is stale and listed, never counted
    let staleAssumptions = 0;
    for (const e of entries) {
      if (e.entryDate < today) { staleAssumptions += 1; continue; }
      add({ kind: "manual", category: "assumptions", direction: e.direction === "inflow" ? "in" : "out", date: e.entryDate, amount: Number(e.amount),
        label: e.description, labelAr: e.description, source: { type: "treasury_forecast_entry", id: e.id, reference: e.category } });
    }

    // ── per bucket: in, out, closing — exact ──────────────────────────────
    const openingH = toHalalas(position.totalCash);
    let runningH = openingH;
    const bucketTotals = buckets.map((b) => {
      const mine = rows.filter((r) => r.bucket === b.index);
      const sumKind = (dir: "in" | "out", kind: FlowKind) => fromHalalas(mine.filter((r) => r.direction === dir && r.kind === kind).reduce((s, r) => s + toHalalas(r.amount), 0));
      const inH = mine.filter((r) => r.direction === "in").reduce((s, r) => s + toHalalas(r.amount), 0);
      const outH = mine.filter((r) => r.direction === "out").reduce((s, r) => s + toHalalas(r.amount), 0);
      const openingOfBucketH = runningH;
      runningH = runningH + inH - outH;
      return {
        index: b.index, from: b.from, to: b.to, label: b.label, labelAr: b.labelAr,
        opening: fromHalalas(openingOfBucketH),
        inflow: { total: fromHalalas(inH), expected: sumKind("in", "expected"), forecast: sumKind("in", "forecast"), manual: sumKind("in", "manual") },
        outflow: { total: fromHalalas(outH), committed: sumKind("out", "committed"), expected: sumKind("out", "expected"), forecast: sumKind("out", "forecast"), manual: sumKind("out", "manual") },
        net: fromHalalas(inH - outH),
        closing: fromHalalas(runningH),
      };
    });

    // ── D17-04: funding requirement — the CALCULATION, then the RECOMMENDATION; never a transaction ──
    const bufferDeclared = settings?.minimumCashBalance != null;
    const bufferH = bufferDeclared ? toHalalas(settings!.minimumCashBalance!) : 0;
    let peakH = 0, firstShortfall: number | null = null, peakBucket: number | null = null;
    for (const b of bucketTotals) {
      const gapH = bufferH - toHalalas(b.closing);
      if (gapH > 0) {
        if (firstShortfall == null) firstShortfall = b.index;
        if (gapH > peakH) { peakH = gapH; peakBucket = b.index; }
      }
    }
    const first = firstShortfall != null ? bucketTotals[firstShortfall]! : null;
    const requirement = fromHalalas(peakH);
    // the sentence carries the page's money format (QA 2026-10-04: "SAR 149028.08" beside "SAR 149,028.08")
    const sar = (x: number) => x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const recommendation = requirement > 0 && first
      ? {
          en: `Arrange funding of SAR ${sar(requirement)} ${first.index === 0 ? "now" : `before ${first.from}`} to keep cash at or above ${bufferDeclared ? `the minimum balance of SAR ${sar(fromHalalas(bufferH))}` : "zero (no minimum balance is declared)"}. This is a calculation from the forecast, not a financing transaction.`,
          ar: `رتّب تمويلاً بمبلغ ${sar(requirement)} ريال ${first.index === 0 ? "الآن" : `قبل ${first.from}`} ليبقى النقد عند ${bufferDeclared ? `الحد الأدنى البالغ ${sar(fromHalalas(bufferH))} ريال` : "الصفر (لم يُحدَّد حد أدنى للرصيد)"} أو فوقه. هذا حساب من التوقع، وليس معاملة تمويل.`,
        }
      : null;

    // ── liquidity — the next 30 days, from the same rows ──────────────────
    const in30 = addDays(today, 29);
    const sumRows = (pred: (r: FlowRow) => boolean) => fromHalalas(rows.filter(pred).reduce((s, r) => s + toHalalas(r.amount), 0));
    const committedH = toHalalas(sumRows((r) => r.kind === "committed"));
    const liquidity = {
      actualCash: position.totalCash,
      committed: fromHalalas(committedH),
      /** Actual cash less what approved payment plans have committed. */
      available: fromHalalas(openingH - committedH),
      expectedInflows30: sumRows((r) => r.direction === "in" && r.date != null && r.date >= today && r.date <= in30),
      expectedOutflows30: sumRows((r) => r.direction === "out" && r.date != null && r.date >= today && r.date <= in30),
      overdueReceivables: sumRows((r) => r.category === "receivables" && r.bucketReason === "overdue"),
      overduePayables: sumRows((r) => r.direction === "out" && r.bucketReason === "overdue"),
      undatedObligations: sumRows((r) => r.bucketReason === "undated"),
      lowestClosing: bucketTotals.reduce((m, b) => (b.closing < m ? b.closing : m), bucketTotals[0]!.closing),
    };

    return {
      asOf: today, horizonWeeks: weeks, horizonEnd,
      opening: { kind: "actual" as const, amount: position.totalCash },
      buckets: bucketTotals,
      rows: rows.sort((a, b) => a.bucket - b.bucket || (a.date ?? "").localeCompare(b.date ?? "") || a.category.localeCompare(b.category)),
      liquidity,
      funding: {
        minimumBalance: bufferDeclared ? fromHalalas(bufferH) : null, bufferDeclared,
        requirement, firstShortfallBucket: firstShortfall, peakShortfallBucket: peakBucket,
        recommendation,
      },
      excluded: { beyondHorizon: beyond, staleAssumptions, journalEntryRules: journalRules, rulesWithoutHistory },
      planFlags: Object.entries(planFlags).map(([id, f]) => ({ planId: Number(id), covered: fromHalalas(f.coveredH), exceedsOutstanding: f.exceeds, billReversed: f.reversed })),
      notes: [
        { en: "A forecast is a projection, never cash. Receipts and supplier payments are read from what is owed today, at each document's due date (or its own date when none is stated); a payment plan replaces its bill's due date for the part it covers.", ar: "التوقع إسقاط وليس نقدًا. تُقرأ المقبوضات ومدفوعات الموردين مما هو مستحق اليوم، في تاريخ استحقاق كل مستند (أو تاريخه إن لم يُذكر)؛ وتحل خطة الدفع محل تاريخ استحقاق فاتورتها في الجزء الذي تغطيه." },
        { en: "Overdue and undated items are shown in their own bucket and counted at once — their timing is unknown, not today.", ar: "يُعرض المتأخر وغير المؤرَّخ في خانة مستقلة ويُحتسب فورًا — توقيته غير معروف، وليس اليوم." },
        { en: "Payments to non-resident suppliers are shown in full on the payment date; the withheld tax leaves for ZATCA by the 10th of the next month.", ar: "تُعرض المدفوعات للموردين غير المقيمين كاملة في تاريخ الدفع؛ وتُسدَّد الضريبة المستقطعة إلى الهيئة بحلول العاشر من الشهر التالي." },
        { en: "Budgets, purchase orders, draft documents and journal-entry recurring rules are not forecast inputs: budgets are accrual P&L amounts, and the others are not yet in the books.", ar: "الميزانيات وأوامر الشراء والمستندات المسودة وقواعد القيود المتكررة ليست مدخلات للتوقع: الميزانيات مبالغ ربح وخسارة على أساس الاستحقاق، والبقية ليست في الدفاتر بعد." },
      ],
    };
  },

  /** The dashboard: the position, the forecast (with liquidity and funding), and the next 30 days' items. */
  async dashboard(weeks?: unknown) {
    const [position, forecast] = await Promise.all([this.position(), this.forecast(weeks)]);
    const in30 = addDays(forecast.asOf, 29);
    const upcoming = forecast.rows.filter((r) => r.direction === "out" && (r.bucketReason != null || (r.date != null && r.date <= in30))).slice(0, 200);
    return { position, forecast, upcomingOutflows: upcoming, upcomingOutflowsTotal: forecast.rows.filter((r) => r.direction === "out" && (r.bucketReason != null || (r.date != null && r.date <= in30))).length };
  },

  // ── settings ─────────────────────────────────────────────────────────────
  async settings() {
    const s = await treasuryRepository.settings();
    return {
      minimumCashBalance: s?.minimumCashBalance == null ? null : Number(s.minimumCashBalance),
      forecastHorizonWeeks: s?.forecastHorizonWeeks ?? 13,
      updatedBy: s?.updatedBy ?? null, updatedAt: s?.updatedAt ? s.updatedAt.toISOString() : null,
    };
  },
  async updateSettings(body: { minimumCashBalance?: unknown; forecastHorizonWeeks?: unknown }, userId: number | null) {
    const current = await this.settings();
    let minimum: number | null = current.minimumCashBalance;
    if (body.minimumCashBalance !== undefined) {
      if (body.minimumCashBalance === null || body.minimumCashBalance === "") minimum = null;
      else {
        const n = Number(body.minimumCashBalance);
        if (!Number.isFinite(n) || n < 0 || Math.abs(n * 100 - Math.round(n * 100)) > 1e-6 || n > 9_999_999_999_999.99) throw new BadRequestError("minimumCashBalance is a non-negative amount with at most two decimals, or null.");
        minimum = n;
      }
    }
    let weeks = current.forecastHorizonWeeks;
    if (body.forecastHorizonWeeks !== undefined) {
      const n = Number(body.forecastHorizonWeeks);
      if (!Number.isInteger(n) || n < 1 || n > 52) throw new BadRequestError("forecastHorizonWeeks is a whole number from 1 to 52.");
      weeks = n;
    }
    const { before, after } = await treasuryRepository.upsertSettings({ minimumCashBalance: minimum == null ? null : minimum.toFixed(2), forecastHorizonWeeks: weeks, updatedBy: userId });
    await auditService.record({ action: before ? "update" : "create", entityType: "treasury_settings", entityId: after.id, before, after });
    return this.settings();
  },

  // ── manual assumptions ──────────────────────────────────────────────────
  async entries() {
    return (await treasuryRepository.entries()).map(entryOut);
  },
  async createEntry(body: Record<string, unknown>, userId: number | null) {
    const v = parseEntry(body);
    const [row] = await treasuryRepository.insertEntry({ ...v, createdBy: userId });
    await auditService.created("treasury_forecast_entry", row!.id, row);
    return entryOut(row!);
  },
  async updateEntry(id: number, body: Record<string, unknown>, userId: number | null) {
    const before = await treasuryRepository.entryById(id);
    if (!before) throw new NotFoundError("Assumption not found.");
    const v = parseEntry({ entryDate: before.entryDate, direction: before.direction, amount: before.amount, category: before.category, description: before.description, notes: before.notes, ...body });
    const [after] = await treasuryRepository.updateEntry(id, { ...v, updatedBy: userId, updatedAt: new Date() });
    await auditService.updated("treasury_forecast_entry", id, before, after);
    return entryOut(after!);
  },
  async removeEntry(id: number) {
    const before = await treasuryRepository.entryById(id);
    if (!before) throw new NotFoundError("Assumption not found.");
    await treasuryRepository.deleteEntry(id);
    await auditService.deleted("treasury_forecast_entry", id, before);
  },
};

const CATEGORIES = ["financing", "capex", "tax", "payroll", "receipt", "payment", "other"] as const;
function parseEntry(body: Record<string, unknown>) {
  const entryDate = String(body.entryDate ?? "");
  if (!ISO.test(entryDate)) throw new BadRequestError("entryDate is a YYYY-MM-DD date.");
  const direction = String(body.direction ?? "");
  if (direction !== "inflow" && direction !== "outflow") throw new BadRequestError("direction is inflow or outflow.");
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0 || Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6 || amount > 9_999_999_999_999.99) throw new BadRequestError("amount is a positive amount with at most two decimals.");
  const category = String(body.category ?? "other");
  if (!(CATEGORIES as readonly string[]).includes(category)) throw new BadRequestError(`category is one of ${CATEGORIES.join(", ")}.`);
  const description = typeof body.description === "string" ? body.description.trim() : "";
  if (description.length < 3) refuse(422, "description_required", "Describe the assumption — what money, and why it is expected.", "description");
  const notes = typeof body.notes === "string" && body.notes.trim() ? body.notes.trim() : null;
  return { entryDate, direction, amount: amount.toFixed(2), category, description, notes };
}
function entryOut(e: Awaited<ReturnType<typeof treasuryRepository.entries>>[number]) {
  return {
    id: e.id, entryDate: e.entryDate, direction: e.direction as "inflow" | "outflow", amount: Number(e.amount), category: e.category,
    description: e.description, notes: e.notes ?? null, createdBy: e.createdBy ?? null, createdAt: e.createdAt.toISOString(),
    updatedBy: e.updatedBy ?? null, updatedAt: e.updatedAt ? e.updatedAt.toISOString() : null,
  };
}
