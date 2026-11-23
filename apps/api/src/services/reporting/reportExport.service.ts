/**
 * PHASE 14 — D14-10: report exports, CSV and PDF, from THE SAME service output
 * the screen shows.
 *
 * Every export calls the report's own `reportsService` function with the
 * report's own parameters, inside the request's tenant + company transaction
 * and behind the `reports` permission AND read on the report's NATIVE resource
 * (`EXPORT_NATIVE_RESOURCE`, Phase 18 H-10 / DR-26) — the screen's own gate.
 * Every export produced is recorded in the audit trail before the file is
 * sent (the request commits before it responds). There is no export
 * query: an export cannot show other data than the screen, cannot cross a
 * company or an organisation, and cannot skip a filter or a date rule — it has
 * no way to express any of those.
 *
 * - CSV: UTF-8 with a BOM (Excel then reads Arabic correctly), amounts with 2
 *   decimals and no grouping (a spreadsheet must parse them), a header block
 *   naming the company, the report, its window and the generation time.
 * - PDF: the document HTML through the ONE shared Chromium
 *   (`document/htmlToPdf`), `dir="rtl"` with Arabic labels and account names
 *   for `lang=ar` (Commercial Books Law Art. 1 — books in Arabic), and the
 *   rounding level stated (IAS 1.51(e)).
 * - Comparative column (IAS 1.38) when a comparison window is requested,
 *   merged by account KEY (never by display name — F7-cmp).
 * - Too large to render is REFUSED with the count, never truncated: a partial
 *   ledger presented as the ledger is a false document.
 */
import type { ProtectedFieldClass } from "@workspace/db";
import { BusinessRuleError, BadRequestError } from "../../lib/errors";
import { businessToday } from "@workspace/shared";
import { companiesRepository } from "../../repositories/companies.repository";
import { reportsService, reportAccountId, reportDate, reportParty, reportWindow, MAX_ID } from "../reports.service";
import { htmlToPdf } from "../document/htmlToPdf";
import { CASH_FLOW_LINE_LABEL, type CashFlowLine } from "./cashFlowClassification";
import { budgetsService } from "../budgets.service";
import { whtService } from "../tax/wht.service";
import { taxComputationsService } from "../tax/taxComputations.service";
import { treasuryService } from "../treasury/treasury.service";
import { auditService } from "../audit.service";
import { isBankText } from "../../lib/fieldClasses/conditions";
import type { ReadDecider } from "../../lib/fieldClasses/walk";
import { reportsRepository } from "../../repositories/reports.repository";

export const EXPORTABLE_REPORTS = ["trial-balance", "income-statement", "balance-sheet", "cash-flow", "general-ledger", "ar-aging", "ap-aging", "budget-vs-actual", "wht-return", "wht-annual", "tax-computation", "treasury-forecast"] as const;
export type ExportableReport = (typeof EXPORTABLE_REPORTS)[number];

/**
 * 🔴 Phase 18 H-10 — DR-26 (register §11.58): each report's NATIVE resource,
 * the permission guarding the report's own screen route. An export requires
 * read on it as well as `reports` (the export route's mount), so a role that
 * cannot open the screen cannot take its data away in a file either. A
 * `Record` over the exportable list: a report added without one does not compile.
 */
export const EXPORT_NATIVE_RESOURCE: Record<ExportableReport, string> = {
  "trial-balance": "reports",
  "income-statement": "reports",
  "balance-sheet": "reports",
  "cash-flow": "reports",
  "general-ledger": "reports",
  "ar-aging": "reports",
  "ap-aging": "reports",
  "budget-vs-actual": "budgets",
  "wht-return": "tax",
  "wht-annual": "tax",
  "tax-computation": "tax",
  "treasury-forecast": "treasury",
};

/** The native resource of an export; null for a name that is not an exportable report (the export answers that 400). */
export function exportNativeResource(report: string): string | null {
  return (EXPORTABLE_REPORTS as readonly string[]).includes(report) ? EXPORT_NATIVE_RESOURCE[report as ExportableReport] : null;
}
export type ExportFormat = "csv" | "pdf";
export type ExportLang = "en" | "ar";

const MAX_ROWS: Record<ExportFormat, number> = { csv: 50_000, pdf: 3_000 };

type Bi = { en: string; ar: string };
type Cell = string | number | null;
type ColumnKind = "text" | "money" | "int" | "date";
/**
 * `subjectTo[i] === false`: column i's protected class does not apply to this row (its class's condition does not
 * hold — a ledger line that did not come from a bank line carries no bank text). Absent: the class applies.
 */
type Row = { kind: "section" | "row" | "subtotal" | "total" | "note"; cells: Cell[]; subjectTo?: Record<number, boolean> };
/**
 * 🔴 19B S1 (v4 §4): EVERY EXPORT COLUMN DECLARES ITS CLASS — `"standard"`, or a protected class with the resource whose
 * field grants decide it. Required by the type, so a column added without one does not compile; the export applies the
 * same class table as the screen. S1 withholds nothing (every role holds every grant); the WHT annual export's address
 * is switched on with S2b (D9 d), and the ledger's bank text with S2c.
 */
export type ExportColumnClass = "standard" | { cls: ProtectedFieldClass; resource: string };
type Column = { label: Bi; kind: ColumnKind; class: ExportColumnClass };
type Table = { title?: Bi; columns: Column[]; rows: Row[] };
export type ReportDocument = { report: ExportableReport; title: Bi; scope: Bi; tables: Table[]; notes: Bi[]; filenameStem: string };

const L = (en: string, ar: string): Bi => ({ en, ar });
const pick = (b: Bi, lang: ExportLang) => (lang === "ar" ? b.ar : b.en);
/** An account's name in the export language — Arabic when the tenant gave one, else the name it has. */
const nameIn = (x: { name: string; nameAr?: string | null }, lang: ExportLang) => (lang === "ar" && x.nameAr ? x.nameAr : x.name);

type Q = Record<string, string | undefined>;

/** Build the document model for a report: the screen's service call, laid out as tables. */
export async function buildReportDocument(report: string, q: Q, lang: ExportLang): Promise<ReportDocument> {
  switch (report as ExportableReport) {
    case "trial-balance": {
      const { from, to } = reportWindow(q.date_from, q.date_to);
      const tb = await reportsService.trialBalance(from, to);
      return {
        report: "trial-balance",
        title: L("Trial balance", "ميزان المراجعة"),
        scope: windowScope(from, to),
        filenameStem: `trial-balance_${from ?? "start"}_${to ?? "end"}`,
        tables: [{
          columns: [col("Account", "الحساب", "text", "standard"), col("Opening", "الرصيد الافتتاحي", "money", "standard"), col("Debit", "مدين", "money", "standard"), col("Credit", "دائن", "money", "standard"), col("Closing", "الرصيد الختامي", "money", "standard")],
          rows: [
            ...tb.accounts.map((a) => ({ kind: "row" as const, cells: [nameIn(a, lang), a.openingBalance, a.debit, a.credit, a.closingBalance] })),
            { kind: "total", cells: [pick(L("Total", "الإجمالي"), lang), tb.totalOpening, tb.totalDebit, tb.totalCredit, tb.totalClosing] },
          ],
        }],
        notes: [
          L("Opening and closing balances are debit-positive.", "الأرصدة الافتتاحية والختامية موجبة للمدين."),
          ...(tb.plResetFrom ? [L(`Income and expense accounts open at the fiscal-year start (${tb.plResetFrom}); earlier profit or loss is one computed equity row.`, `تبدأ حسابات الإيرادات والمصروفات من بداية السنة المالية (${tb.plResetFrom})؛ وأرباح أو خسائر ما قبلها سطر محسوب واحد ضمن حقوق الملكية.`)] : []),
          ...(tb.fiscalYearDeclared ? [] : [L("The fiscal year is not declared, so income and expense accounts are not reset at a fiscal-year start.", "لم تُحدَّد السنة المالية، لذا لا تُصفَّر حسابات الإيرادات والمصروفات عند بداية سنة مالية.")]),
        ],
      };
    }
    case "income-statement": {
      const { from, to } = reportWindow(q.date_from, q.date_to);
      const cur = await reportsService.incomeStatement(from, to);
      const cmpWin = q.compare_from || q.compare_to ? reportWindow(q.compare_from, q.compare_to) : null;
      const prior = cmpWin ? await reportsService.incomeStatement(cmpWin.from, cmpWin.to) : null;
      const priorBy = (xs: { key: string; amount: number }[] | undefined) => new Map((xs ?? []).map((x) => [x.key, x.amount]));
      const pRev = priorBy(prior?.revenue), pExp = priorBy(prior?.expenses), pTax = priorBy(prior?.zakatAndIncomeTax.items);
      const keysRev = mergeKeys(cur.revenue, prior?.revenue), keysExp = mergeKeys(cur.expenses, prior?.expenses);
      const keysTax = mergeKeys(cur.zakatAndIncomeTax.items, prior?.zakatAndIncomeTax.items);
      const amountCols = prior ? [col(windowLabel(from, to), windowLabel(from, to), "money", "standard"), col(windowLabel(cmpWin!.from, cmpWin!.to), windowLabel(cmpWin!.from, cmpWin!.to), "money", "standard")] : [col("Amount", "المبلغ", "money", "standard")];
      const line = (x: { key: string; name: string; nameAr: string; amount: number } | undefined, key: string, prev: Map<string, number>, fallbackName: string): Row =>
        ({ kind: "row", cells: [x ? nameIn(x, lang) : fallbackName, x?.amount ?? 0, ...(prior ? [prev.get(key) ?? 0] : [])] });
      return {
        report: "income-statement",
        title: L("Statement of profit or loss", "قائمة الأرباح أو الخسائر"),
        scope: windowScope(from, to),
        filenameStem: `profit-or-loss_${from ?? "start"}_${to ?? "end"}`,
        tables: [{
          columns: [col("Account", "الحساب", "text", "standard"), ...amountCols],
          rows: [
            { kind: "section", cells: [pick(L("Revenue", "الإيرادات"), lang)] },
            ...keysRev.map((k) => line(cur.revenue.find((r) => r.key === k), k, pRev, prior?.revenue.find((r) => r.key === k) ? nameIn(prior.revenue.find((r) => r.key === k)!, lang) : k)),
            { kind: "subtotal", cells: [pick(L("Total revenue", "إجمالي الإيرادات"), lang), cur.totalRevenue, ...(prior ? [prior.totalRevenue] : [])] },
            { kind: "section", cells: [pick(L("Expenses (by nature)", "المصروفات (حسب طبيعتها)"), lang)] },
            ...keysExp.map((k) => line(cur.expenses.find((r) => r.key === k), k, pExp, prior?.expenses.find((r) => r.key === k) ? nameIn(prior.expenses.find((r) => r.key === k)!, lang) : k)),
            { kind: "subtotal", cells: [pick(L("Total expenses", "إجمالي المصروفات"), lang), cur.expensesBeforeZakatAndIncomeTax, ...(prior ? [prior.expensesBeforeZakatAndIncomeTax] : [])] },
            { kind: "subtotal", cells: [pick(L("Profit (loss) before Zakat and income tax", "الربح (الخسارة) قبل الزكاة وضريبة الدخل"), lang), cur.profitBeforeZakatAndIncomeTax, ...(prior ? [prior.profitBeforeZakatAndIncomeTax] : [])] },
            // Phase 16 — SOCPA Zakat Accounting Standard para 6: Zakat on its OWN line, with income tax
            ...(keysTax.length > 0
              ? [
                  { kind: "section" as const, cells: [pick(L("Zakat and income tax", "الزكاة وضريبة الدخل"), lang)] },
                  ...keysTax.map((k) => line(cur.zakatAndIncomeTax.items.find((r) => r.key === k), k, pTax, prior?.zakatAndIncomeTax.items.find((r) => r.key === k) ? nameIn(prior.zakatAndIncomeTax.items.find((r) => r.key === k)!, lang) : k)),
                  { kind: "subtotal" as const, cells: [pick(L("Total Zakat and income tax", "إجمالي الزكاة وضريبة الدخل"), lang), cur.zakatAndIncomeTax.total, ...(prior ? [prior.zakatAndIncomeTax.total] : [])] },
                ]
              : []),
            { kind: "total", cells: [pick(L("Profit (loss) for the period", "ربح (خسارة) الفترة"), lang), cur.netIncome, ...(prior ? [prior.netIncome] : [])] },
          ],
        }],
        notes: [L(
          "Expenses are analysed by nature (IAS 1.102). Zakat and income tax are presented on their own line before the profit or loss (SOCPA Zakat Accounting Standard, para 6); they appear once an approved Zakat or income-tax computation accrues them.",
          "تُحلَّل المصروفات حسب طبيعتها (معيار المحاسبة الدولي 1.102). وتُعرض الزكاة وضريبة الدخل في بند مستقل قبل الربح أو الخسارة (معيار الزكاة الصادر عن الهيئة السعودية للمراجعين والمحاسبين، الفقرة 6)، وتظهر متى استُحقت بموجب احتساب زكاة أو ضريبة دخل معتمد.",
        )],
      };
    }
    case "balance-sheet": {
      const asOf = reportDate(q.as_of, "as_of") ?? businessToday();
      const cur = await reportsService.balanceSheet(asOf);
      const cmpAsOf = reportDate(q.compare_as_of, "compare_as_of");
      const prior = cmpAsOf ? await reportsService.balanceSheet(cmpAsOf) : null;
      type It = { key: string; name: string; nameAr: string; amount: number };
      const prevMap = (xs: It[] | undefined) => new Map((xs ?? []).map((x) => [x.key, x]));
      const amountCols = prior ? [col(asOf, asOf, "money", "standard"), col(cmpAsOf!, cmpAsOf!, "money", "standard")] : [col(`As of ${asOf}`, `كما في ${asOf}`, "money", "standard")];
      const rowsOf = (curItems: It[], priorItems: It[] | undefined): Row[] => {
        const pm = prevMap(priorItems);
        const keys = mergeKeys(curItems, priorItems);
        return keys.map((k) => {
          const c = curItems.find((x) => x.key === k);
          const p = pm.get(k);
          return { kind: "row", cells: [nameIn((c ?? p)!, lang), c?.amount ?? 0, ...(prior ? [p?.amount ?? 0] : [])] };
        });
      };
      const sub = (label: Bi, a: number, b?: number): Row => ({ kind: "subtotal", cells: [pick(label, lang), a, ...(prior ? [b ?? 0] : [])] });
      const fyNote = cur.equity.fiscalYear
        ? L(`Current fiscal year: ${cur.equity.fiscalYear.startDate} – ${cur.equity.fiscalYear.endDate}.`, `السنة المالية الحالية: ${cur.equity.fiscalYear.startDate} – ${cur.equity.fiscalYear.endDate}.`)
        : L("The fiscal year is not declared; profit or loss to date is shown as one line.", "لم تُحدَّد السنة المالية؛ لذا تظهر الأرباح أو الخسائر حتى تاريخه في سطر واحد.");
      return {
        report: "balance-sheet",
        title: L("Statement of financial position", "قائمة المركز المالي"),
        scope: L(`As of ${asOf}`, `كما في ${asOf}`),
        filenameStem: `financial-position_${asOf}`,
        tables: [{
          columns: [col("Line", "البند", "text", "standard"), ...amountCols],
          rows: [
            { kind: "section", cells: [pick(L("Current assets", "الأصول المتداولة"), lang)] },
            ...rowsOf(cur.assets.current.items, prior?.assets.current.items),
            sub(L("Total current assets", "إجمالي الأصول المتداولة"), cur.assets.current.total, prior?.assets.current.total),
            { kind: "section", cells: [pick(L("Non-current assets", "الأصول غير المتداولة"), lang)] },
            ...rowsOf(cur.assets.nonCurrent.items, prior?.assets.nonCurrent.items),
            sub(L("Total non-current assets", "إجمالي الأصول غير المتداولة"), cur.assets.nonCurrent.total, prior?.assets.nonCurrent.total),
            ...(cur.assets.unclassified.items.length || prior?.assets.unclassified.items.length ? [
              { kind: "section" as const, cells: [pick(L("Assets not yet classified as current or non-current", "أصول لم تُصنَّف بعد كمتداولة أو غير متداولة"), lang)] },
              ...rowsOf(cur.assets.unclassified.items, prior?.assets.unclassified.items),
            ] : []),
            { kind: "total", cells: [pick(L("Total assets", "إجمالي الأصول"), lang), cur.assets.total, ...(prior ? [prior.assets.total] : [])] },
            { kind: "section", cells: [pick(L("Current liabilities", "الالتزامات المتداولة"), lang)] },
            ...rowsOf(cur.liabilities.current.items, prior?.liabilities.current.items),
            sub(L("Total current liabilities", "إجمالي الالتزامات المتداولة"), cur.liabilities.current.total, prior?.liabilities.current.total),
            { kind: "section", cells: [pick(L("Non-current liabilities", "الالتزامات غير المتداولة"), lang)] },
            ...rowsOf(cur.liabilities.nonCurrent.items, prior?.liabilities.nonCurrent.items),
            sub(L("Total non-current liabilities", "إجمالي الالتزامات غير المتداولة"), cur.liabilities.nonCurrent.total, prior?.liabilities.nonCurrent.total),
            ...(cur.liabilities.unclassified.items.length || prior?.liabilities.unclassified.items.length ? [
              { kind: "section" as const, cells: [pick(L("Liabilities not yet classified as current or non-current", "التزامات لم تُصنَّف بعد كمتداولة أو غير متداولة"), lang)] },
              ...rowsOf(cur.liabilities.unclassified.items, prior?.liabilities.unclassified.items),
            ] : []),
            { kind: "total", cells: [pick(L("Total liabilities", "إجمالي الالتزامات"), lang), cur.liabilities.total, ...(prior ? [prior.liabilities.total] : [])] },
            { kind: "section", cells: [pick(L("Equity", "حقوق الملكية"), lang)] },
            ...rowsOf(cur.equity.items, prior?.equity.items),
            { kind: "row", cells: [pick(cur.equity.fiscalYear ? L("Profit / loss — prior fiscal years (not allocated)", "أرباح / خسائر سنوات مالية سابقة (غير موزعة)") : L("Profit / loss to date (not allocated)", "الأرباح / الخسائر حتى تاريخه (غير موزعة)"), lang), cur.equity.priorYearsProfit, ...(prior ? [prior.equity.priorYearsProfit] : [])] },
            ...(cur.equity.fiscalYear ? [{ kind: "row" as const, cells: [pick(L("Profit / loss — current fiscal year to date", "أرباح / خسائر السنة المالية الحالية حتى تاريخه"), lang), cur.equity.currentYearProfit, ...(prior ? [prior.equity.currentYearProfit] : [])] }] : []),
            sub(L("Total equity", "إجمالي حقوق الملكية"), cur.equity.total, prior?.equity.total),
            { kind: "total", cells: [pick(L("Total liabilities and equity", "إجمالي الالتزامات وحقوق الملكية"), lang), cur.totalLiabilitiesAndEquity, ...(prior ? [prior.totalLiabilitiesAndEquity] : [])] },
          ],
        }],
        notes: [
          fyNote,
          cur.balanced ? L("Assets equal liabilities plus equity.", "الأصول تساوي الالتزامات مضافاً إليها حقوق الملكية.") : L(`NOT BALANCED: ${cur.warning ?? ""}`, `غير متوازنة: ${cur.warning ?? ""}`),
        ],
      };
    }
    case "cash-flow": {
      const { from, to } = reportWindow(q.date_from, q.date_to);
      const cf = await reportsService.cashFlow(from, to);
      const section = (label: Bi, s: { total: number; items: { key: string; amount: number }[] }): Row[] => [
        { kind: "section", cells: [pick(label, lang)] },
        ...s.items.map((i) => ({ kind: "row" as const, cells: [pick(CASH_FLOW_LINE_LABEL[i.key as CashFlowLine] ?? L(i.key, i.key), lang), i.amount] })),
        { kind: "subtotal", cells: [pick(L(`Net cash from ${label.en.toLowerCase()}`, `صافي النقد من ${label.ar}`), lang), s.total] },
      ];
      return {
        report: "cash-flow",
        title: L("Statement of cash flows (direct method)", "قائمة التدفقات النقدية (الطريقة المباشرة)"),
        scope: windowScope(from, to),
        filenameStem: `cash-flows_${from ?? "start"}_${to ?? "end"}`,
        tables: [{
          columns: [col("Line", "البند", "text", "standard"), col("Amount", "المبلغ", "money", "standard")],
          rows: [
            { kind: "row", cells: [pick(L("Cash at the beginning of the period", "النقد في بداية الفترة"), lang), cf.openingCash] },
            ...section(L("operating activities", "الأنشطة التشغيلية"), cf.operating),
            ...section(L("investing activities", "الأنشطة الاستثمارية"), cf.investing),
            ...section(L("financing activities", "الأنشطة التمويلية"), cf.financing),
            ...cf.internal.items.map((i) => ({ kind: "row" as const, cells: [pick(CASH_FLOW_LINE_LABEL[i.key as CashFlowLine] ?? L(i.key, i.key), lang), i.amount] })),
            ...(cf.migrationOpeningCash !== 0 ? [{ kind: "row" as const, cells: [pick(L("Opening balances brought in by migration", "أرصدة افتتاحية مُدخلة بالترحيل"), lang), cf.migrationOpeningCash] }] : []),
            { kind: "total", cells: [pick(L("Cash at the end of the period", "النقد في نهاية الفترة"), lang), cf.closingCash] },
          ],
        }],
        notes: [
          L("Receipts and payments are shown inclusive of VAT; VAT settled with ZATCA is its own line.", "تظهر المقبوضات والمدفوعات شاملة ضريبة القيمة المضافة؛ وتظهر الضريبة المسددة لهيئة الزكاة والضريبة والجمارك في سطر مستقل."),
          cf.reconciles ? L("The statement reconciles to the cash accounts in the ledger.", "تتطابق القائمة مع حسابات النقد في الدفتر.") : L("WARNING: the statement does not reconcile to the cash accounts in the ledger.", "تحذير: القائمة لا تتطابق مع حسابات النقد في الدفتر."),
        ],
      };
    }
    case "general-ledger": {
      const { from, to } = reportWindow(q.date_from, q.date_to);
      const party = reportParty(q.party_type, q.customer_id, q.vendor_id);
      const accountId = q.account_id ? String(reportAccountId(q.account_id)) : undefined;
      const gl = await reportsService.generalLedger(accountId, undefined, from, to, party);
      // 19B S2a (v4 §5.2, D1/D9; D11 amended 2026-11-22): a line's text is BANK TEXT where its entry came from a bank
      // line — withheld from a role without bank_narrative on journal entries (applyWithholding below). Review follow-up
      // (2026-11-24): by the movement's TEXT ORIGIN, which follows a mirror to its original (conditions.ts).
      return {
        report: "general-ledger",
        title: L("General ledger", "دفتر الأستاذ العام"),
        scope: L(`${gl.accountName} · ${windowScope(from, to).en}`, `${gl.accountNameAr || gl.accountName} · ${windowScope(from, to).ar}`),
        filenameStem: `general-ledger_${accountId ?? "all"}_${from ?? "start"}_${to ?? "end"}`,
        tables: [{
          columns: [col("Date", "التاريخ", "date", "standard"), col("Entry", "القيد", "text", "standard"), col("Description", "البيان", "text", { cls: "bank_narrative", resource: "journal_entries" }), col("Account", "الحساب", "text", "standard"), col("Debit", "مدين", "money", "standard"), col("Credit", "دائن", "money", "standard"), col("Balance", "الرصيد", "money", "standard")],
          rows: [
            { kind: "subtotal", cells: [from ?? "", "", pick(L("Opening balance", "الرصيد الافتتاحي"), lang), "", null, null, gl.openingBalance] },
            ...gl.movements.map((m) => ({ kind: "row" as const, cells: [m.date, m.entryNumber, m.description ?? "", lang === "ar" && m.accountNameAr ? m.accountNameAr : m.accountName, m.debit, m.credit, m.balance], subjectTo: { 2: isBankText(m.textOrigin) } })),
            { kind: "total", cells: [to ?? "", "", pick(L("Closing balance", "الرصيد الختامي"), lang), "", gl.totalDebit, gl.totalCredit, gl.closingBalance] },
          ],
        }],
        notes: [],
      };
    }
    case "ar-aging":
    case "ap-aging": {
      const isAr = report === "ar-aging";
      const ag = isAr ? await reportsService.arAging(q.as_of) : await reportsService.apAging(q.as_of);
      const items = ag.items as Array<{ outstanding: number; dueDate: string | null; daysPastDue: number; invoiceNumber?: string; billNumber?: string; customerName?: string; customerNameAr?: string; vendorName?: string; vendorNameAr?: string }>;
      const b = ag.buckets;
      return {
        report: report as ExportableReport,
        title: isAr ? L("Accounts receivable ageing", "أعمار الذمم المدينة") : L("Accounts payable ageing", "أعمار الذمم الدائنة"),
        scope: L(`As of ${ag.asOf}`, `كما في ${ag.asOf}`),
        filenameStem: `${report}_${ag.asOf}`,
        tables: [
          {
            title: L("Buckets (days past due)", "الفئات (أيام التأخر)"),
            columns: [col("Bucket", "الفئة", "text", "standard"), col("Outstanding", "المستحق", "money", "standard")],
            rows: [
              { kind: "row", cells: [pick(L("Not yet due", "غير مستحق بعد"), lang), b.current] },
              { kind: "row", cells: [pick(L("1–30 days", "1–30 يوماً"), lang), b.days_1_30] },
              { kind: "row", cells: [pick(L("31–60 days", "31–60 يوماً"), lang), b.days_31_60] },
              { kind: "row", cells: [pick(L("61–90 days", "61–90 يوماً"), lang), b.days_61_90] },
              { kind: "row", cells: [pick(L("Over 90 days", "أكثر من 90 يوماً"), lang), b.over_90] },
              { kind: "total", cells: [pick(L("Total", "الإجمالي"), lang), ag.total] },
            ],
          },
          {
            title: L("Documents", "المستندات"),
            columns: [col("Document", "المستند", "text", "standard"), col(isAr ? "Customer" : "Supplier", isAr ? "العميل" : "المورد", "text", "standard"), col("Due", "الاستحقاق", "date", "standard"), col("Days past due", "أيام التأخر", "int", "standard"), col("Outstanding", "المستحق", "money", "standard")],
            rows: items.map((i) => ({ kind: "row" as const, cells: [
              (isAr ? i.invoiceNumber : i.billNumber) ?? "",
              isAr ? (lang === "ar" && i.customerNameAr ? i.customerNameAr : (i.customerName ?? "")) : (lang === "ar" && i.vendorNameAr ? i.vendorNameAr : (i.vendorName ?? "")),
              i.dueDate ?? "", i.daysPastDue, i.outstanding,
            ] })),
          },
        ],
        notes: [isAr
          ? L("Customer credit balances and deposits are liabilities, shown beside the buckets, never inside them.", "أرصدة العملاء الدائنة والدفعات المقدمة التزامات، تُعرض بجانب الفئات لا ضمنها.")
          : L("Supplier credits and money held on account are assets, shown beside the buckets, never inside them.", "أرصدة الموردين الدائنة والمبالغ لديهم أصول، تُعرض بجانب الفئات لا ضمنها.")],
      };
    }
    case "budget-vs-actual": {
      // Phase 15 (D15-14): the screen's own call — budgetsService.vsActual — laid out as a table.
      const int = (v: string | undefined, name: string) => {
        if (v == null || v === "") return undefined;
        if (!/^\d+$/.test(v) || Number(v) > MAX_ID) throw new BadRequestError(`${name} must be a positive whole number.`);
        return Number(v);
      };
      const budgetId = int(q.budget_id, "budget_id");
      if (budgetId == null) throw new BadRequestError("budget_id is required to export a budget.");
      const vs = await budgetsService.vsActual(budgetId, { version_id: int(q.version_id, "version_id"), through_period: int(q.through_period, "through_period") });
      const pct = (x: number | null) => (x == null ? "—" : `${x.toFixed(2)}%`);
      const judged = (fav: boolean | null) => (fav == null ? "—" : fav ? pick(L("Favourable", "ملائم"), lang) : pick(L("Unfavourable", "غير ملائم"), lang));
      const mode = (m: string) => pick(m === "periods" ? L("By period", "حسب الفترة") : m === "annual" ? L("Annual only", "سنوي فقط") : L("Not budgeted", "غير مُدرج"), lang);
      type VsLine = (typeof vs.lines)[number];
      const lineRow = (l: VsLine): Row => ({ kind: "row", cells: [
        nameIn({ name: l.accountName, nameAr: l.accountNameAr }, lang), mode(l.mode), l.ytd.budget, l.ytd.actual, l.ytd.variance, pct(l.ytd.variancePct), judged(l.ytd.favourable),
        l.fullYear.budget, l.fullYear.actualToDate, l.forecast.amount,
      ] });
      type VsTotals = typeof vs.totals.income;
      const totalRow = (label: Bi, t: VsTotals, kind: "subtotal" | "total"): Row => ({ kind, cells: [
        pick(label, lang), "", t.ytd.budget, t.ytd.actual, t.ytd.variance, pct(t.ytd.variancePct), judged(t.ytd.favourable), t.fullYear.budget, t.fullYear.actualToDate, t.forecast.amount,
      ] });
      const all = [...vs.lines, ...vs.unbudgeted];
      const group = (type: "income" | "expense") => all.filter((l) => l.accountType === type).map(lineRow);
      const through = vs.throughDate ?? "—";
      return {
        report: "budget-vs-actual",
        title: L("Budget vs actual", "الميزانية مقابل الفعلي"),
        scope: L(
          `${vs.name} · v${vs.version.versionNo} (${vs.version.status}) · fiscal year ${vs.fiscalYear.startDate} – ${vs.fiscalYear.endDate} · year to date through period ${vs.throughPeriod} (${through})`,
          `${vs.nameAr || vs.name} · الإصدار ${vs.version.versionNo} · السنة المالية ${vs.fiscalYear.startDate} – ${vs.fiscalYear.endDate} · منذ بداية السنة حتى الفترة ${vs.throughPeriod} (${through})`,
        ),
        filenameStem: `budget-vs-actual_${vs.budgetId}_v${vs.version.versionNo}_p${vs.throughPeriod}`,
        tables: [{
          columns: [
            col("Account", "الحساب", "text", "standard"), col("Budgeted", "أساس الميزانية", "text", "standard"),
            col("YTD budget", "ميزانية حتى تاريخه", "money", "standard"), col("YTD actual", "الفعلي حتى تاريخه", "money", "standard"), col("Variance", "الانحراف", "money", "standard"), col("Variance %", "نسبة الانحراف", "text", "standard"), col("Judgement", "التقييم", "text", "standard"),
            col("Full-year budget", "ميزانية السنة", "money", "standard"), col("Actual to date", "الفعلي حتى الآن", "money", "standard"), col("Forecast", "التوقع", "money", "standard"),
          ],
          rows: [
            { kind: "section", cells: [pick(L("Income", "الإيرادات"), lang)] },
            ...group("income"),
            totalRow(L("Total income", "إجمالي الإيرادات"), vs.totals.income, "subtotal"),
            { kind: "section", cells: [pick(L("Expenses", "المصروفات"), lang)] },
            ...group("expense"),
            totalRow(L("Total expenses", "إجمالي المصروفات"), vs.totals.expense, "subtotal"),
            totalRow(L("Net", "الصافي"), vs.totals.net, "total"),
          ],
        }],
        notes: [
          L("Actuals are the posted ledger (accrual), in each account's natural direction; variance = actual − budget, judged by account type.", "الفعلي من الدفتر المرحَّل (أساس الاستحقاق) باتجاه كل حساب؛ الانحراف = الفعلي − الميزانية، ويُقيَّم حسب نوع الحساب."),
          L("An annual-only amount is never divided across periods: it has no year-to-date budget and no forecast.", "المبلغ السنوي لا يُقسَّم على الفترات: لا ميزانية له حتى تاريخه ولا توقع."),
          L("Forecast = actuals through the period above + the budget of the remaining periods. It is a projection, not a budget.", "التوقع = الفعلي حتى الفترة المذكورة + ميزانية الفترات المتبقية. وهو إسقاط وليس ميزانية."),
        ],
      };
    }
    case "wht-return": {
      // Phase 16 (pack §2.5): the screen's own call — whtService.monthlyReturn — as Form 06 laid out.
      const period = q.period ?? "";
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new BadRequestError("period (YYYY-MM) is required to export a WHT return.");
      const r = await whtService.monthlyReturn(period);
      const REASONS: Record<string, ReturnType<typeof L>> = {
        goods: L("Payment for goods (IR Art. 63(7))", "دفعة مقابل سلع (المادة 63(7))"),
        not_kingdom_source: L("Not from a source in the Kingdom (Art. 5)", "ليست من مصدر في المملكة (المادة 5)"),
        // Q2 (pack §14.2): not consideration for a supply — no nature applies
        refundable_deposit: L("Refundable deposit — not consideration for a supply", "تأمين مسترد — ليس مقابلًا لتوريد"),
        erroneous_payment: L("Erroneous payment — not consideration for anything", "دفعة خاطئة — ليست مقابلًا لأي شيء"),
      };
      const reason = (x: string | null) => (x && REASONS[x] ? pick(REASONS[x]!, lang) : "—");
      return {
        report: "wht-return",
        title: L("Withholding tax return (Form 06)", "إقرار ضريبة الاستقطاع (النموذج 06)"),
        scope: L(`Month ${r.period} · due ${r.dueDate} · status ${r.status}`, `شهر ${r.period} · الاستحقاق ${r.dueDate} · الحالة ${r.status}`),
        filenameStem: `wht-return_${r.period}`,
        tables: [
          {
            title: L("Return lines", "بنود الإقرار"),
            columns: [col("Row", "البند", "text", "standard"), col("Payment", "نوع الدفعة", "text", "standard"), col("Payment total", "إجمالي المدفوع", "money", "standard"), col("Tax withheld", "الضريبة المستقطعة", "money", "standard")],
            rows: [
              ...r.lines.map((l) => ({ kind: "row" as const, cells: [l.formRow, lang === "ar" ? l.nameAr : l.nameEn, l.paymentTotal, l.taxWithheld] })),
              { kind: "total", cells: [pick(L("Monthly total", "الإجمالي الشهري"), lang), "", r.totals.paymentTotal, r.totals.taxWithheld] },
            ],
          },
          {
            title: L("Schedule of beneficiaries", "جدول المستفيدين"),
            columns: [col("Date", "التاريخ", "date", "standard"), col("Beneficiary", "المستفيد", "text", "standard"), col("Country", "الدولة", "text", "standard"), col("Registration no.", "رقم التسجيل", "text", "standard"), col("Nature", "النوع", "text", "standard"), col("Base", "المبلغ", "money", "standard"), col("Rate", "النسبة", "text", "standard"), col("WHT", "الضريبة", "money", "standard"), col("Document", "المستند", "text", "standard")],
            rows: r.schedule.map((w) => ({ kind: "row" as const, cells: [w.paymentDate, nameIn({ name: w.vendorName, nameAr: w.vendorNameAr }, lang), w.vendorCountry ?? "—", w.vendorForeignTaxId ?? "—", w.paymentType ?? "—", w.baseAmount, `${(w.rate * 100).toFixed(2)}%${w.treatyReliefId ? " (treaty)" : ""}`, w.whtAmount, w.document ?? "—"] })),
          },
          ...(r.excluded.length ? [{
            title: L("Payments to non-residents not subject, with the reason", "مدفوعات لغير مقيمين غير خاضعة، مع السبب"),
            columns: [col("Date", "التاريخ", "date", "standard"), col("Beneficiary", "المستفيد", "text", "standard"), col("Reason", "السبب", "text", "standard"), col("Amount", "المبلغ", "money", "standard")],
            rows: r.excluded.map((w) => ({ kind: "row" as const, cells: [w.paymentDate, nameIn({ name: w.vendorName, nameAr: w.vendorNameAr }, lang), reason(w.notSubjectReason), w.baseAmount] })),
          }] : []),
          ...(r.pending.length ? [{
            title: L("Payments to non-residents pending classification — nothing withheld or claimed", "مدفوعات لغير مقيمين بانتظار التصنيف — لا استقطاع ولا مطالبة"),
            columns: [col("Date", "التاريخ", "date", "standard"), col("Beneficiary", "المستفيد", "text", "standard"), col("Document", "المستند", "text", "standard"), col("Amount", "المبلغ", "money", "standard")],
            rows: r.pending.map((w) => ({ kind: "row" as const, cells: [w.paymentDate, nameIn({ name: w.vendorName, nameAr: w.vendorNameAr }, lang), w.document ?? "—", w.baseAmount] })),
          }] : []),
        ],
        notes: [
          L(`Remitted ${r.totals.remitted.toFixed(2)}; outstanding ${r.totals.outstanding.toFixed(2)}. Due within the first 10 days of the following month (IR Art. 63(9)(a)).`, `المسدد ${r.totals.remitted.toFixed(2)}؛ المتبقي ${r.totals.outstanding.toFixed(2)}. يستحق خلال الأيام العشرة الأولى من الشهر التالي (المادة 63(9)(أ)).`),
          ...(r.delayFineEstimate ? [L(`Delay-fine ESTIMATE: ${r.delayFineEstimate.amount.toFixed(2)} (1% of the unpaid tax per full 30 days late — Art. 77(A)); not posted.`, `تقدير غرامة التأخير: ${r.delayFineEstimate.amount.toFixed(2)} (1% من الضريبة غير المسددة عن كل 30 يومًا كاملة — المادة 77(أ))؛ غير مرحَّل.`)] : []),
          L("Form rows 07 and 08 (services to head office / associated company) have no separate band since Resolution 25; a related-party service is reported on its nature's row (open question W-4).", "البندان 07 و08 (خدمات للمركز الرئيسي/شركة مرتبطة) بلا شريحة مستقلة منذ القرار 25؛ وتُدرج خدمة الطرف المرتبط في بند طبيعتها (سؤال مفتوح W-4)."),
        ],
      };
    }
    case "wht-annual": {
      const a = await whtService.annual(q.fiscal_year);
      return {
        report: "wht-annual",
        title: L("Annual withholding information", "البيانات السنوية لضريبة الاستقطاع"),
        scope: L(`Fiscal year ${a.fiscalYear.startDate} – ${a.fiscalYear.endDate} · due ${a.dueDate}`, `السنة المالية ${a.fiscalYear.startDate} – ${a.fiscalYear.endDate} · الاستحقاق ${a.dueDate}`),
        filenameStem: `wht-annual_${a.fiscalYear.label}`,
        tables: [{
          columns: [col("Beneficiary", "المستفيد", "text", "standard"), col("Country", "الدولة", "text", "standard"), col("Address", "العنوان", "text", { cls: "contact", resource: "vendors" }), col("Registration no.", "رقم التسجيل", "text", "standard"), col("Nature", "النوع", "text", "standard"), col("Payments", "عدد الدفعات", "int", "standard"), col("Paid", "المدفوع", "money", "standard"), col("WHT", "الضريبة", "money", "standard")],
          rows: [
            ...a.beneficiaries.map((b) => ({ kind: "row" as const, cells: [nameIn({ name: b.vendorName, nameAr: b.vendorNameAr }, lang), b.country ?? "—", b.address ?? "—", b.foreignTaxId ?? "—", b.paymentType, b.payments, b.base, b.wht] })),
            { kind: "total", cells: [pick(L("Total", "الإجمالي"), lang), "", "", "", "", a.totals.payments, a.totals.base, a.totals.wht] },
          ],
        }],
        notes: [L("Filed within 120 days of the fiscal year-end (IR Art. 63(9)(b)); the beneficiary's name, address and registration number as Art. 68(B)(3) asks.", "يُقدَّم خلال 120 يومًا من نهاية السنة المالية (المادة 63(9)(ب))؛ مع اسم المستفيد وعنوانه ورقم تسجيله كما تطلب المادة 68(ب)(3).")],
      };
    }
    case "tax-computation": {
      const int = (v: string | undefined, name: string) => {
        if (v == null || v === "") return undefined;
        if (!/^\d+$/.test(v) || Number(v) > MAX_ID || Number(v) === 0) throw new BadRequestError(`${name} must be a positive whole number.`);
        return Number(v);
      };
      const id = int(q.computation_id, "computation_id");
      if (id == null) throw new BadRequestError("computation_id is required to export a tax computation.");
      const d = await taxComputationsService.detail(id, int(q.version_id, "version_id"));
      // an APPROVED version exports its frozen working paper — the figure that was approved, never a recomputation
      const frozen = (d.approvedSnapshot as { computation?: typeof d.live } | null)?.computation ?? null;
      const comp = frozen ?? d.live;
      if (!comp) throw new BadRequestError("This computation has no version to export.");
      const isZakat = d.kind === "zakat";
      const v = d.version;
      const stepRows = (steps: { key: string; article: string; amount: number }[]): Row[] => steps.map((s) => ({ kind: "row" as const, cells: [s.key.replace(/_/g, " "), s.article, s.amount] }));
      const tables: Table[] = [];
      if (isZakat && comp.zakat) {
        tables.push({
          title: L("Balance-sheet accounts at the year-end, by class", "حسابات المركز المالي في نهاية السنة، حسب الفئة"),
          columns: [col("Account", "الحساب", "text", "standard"), col("Class", "الفئة", "text", "standard"), col("Article", "المادة", "text", "standard"), col("Amount", "المبلغ", "money", "standard")],
          rows: comp.zakat.lines.map((l) => ({ kind: "row" as const, cells: [nameIn({ name: l.name, nameAr: l.nameAr }, lang), l.zakatClass, l.article, l.amount] })),
        });
        if (comp.zakat.result) tables.push({
          title: L("The Zakat base (Implementing Regulations, MoF Decision 1007)", "الوعاء الزكوي (اللائحة التنفيذية، القرار 1007)"),
          columns: [col("Step", "الخطوة", "text", "standard"), col("Article", "المادة", "text", "standard"), col("Amount", "المبلغ", "money", "standard")],
          rows: [...stepRows(comp.zakat.result.steps), { kind: "note", cells: [`${pick(L("Rate", "النسبة"), lang)}: ${comp.zakat.result.rate.display}`] }],
        });
      }
      if (!isZakat && comp.incomeTax) tables.push({
        title: L("Income tax on the non-Saudi share (Income Tax Law)", "ضريبة الدخل على حصة غير السعوديين (نظام ضريبة الدخل)"),
        columns: [col("Step", "الخطوة", "text", "standard"), col("Article", "المادة", "text", "standard"), col("Amount", "المبلغ", "money", "standard")],
        rows: stepRows(comp.incomeTax.steps),
      });
      if (comp.adjustments.length) tables.push({
        title: L("Tax adjustments", "التعديلات الضريبية"),
        columns: [col("Target", "البند", "text", "standard"), col("Effect", "الأثر", "text", "standard"), col("Amount", "المبلغ", "money", "standard"), col("Reason", "السبب", "text", "standard"), col("Article", "المادة", "text", "standard"), col("Source", "المستند", "text", "standard")],
        rows: comp.adjustments.map((a) => ({ kind: "row" as const, cells: [a.target, a.effect, a.amount, a.reason, a.legalReference, a.sourceReference ?? "—"] })),
      });
      return {
        report: "tax-computation",
        title: isZakat ? L("Zakat base working paper", "ورقة عمل الوعاء الزكوي") : L("Income-tax computation", "احتساب ضريبة الدخل"),
        scope: L(
          `Fiscal year ${d.fiscalYear.startDate} – ${d.fiscalYear.endDate} · version ${v?.versionNo ?? "—"} (${v?.status ?? "—"})${frozen ? " · the frozen approved working paper" : " · live from the ledger"}`,
          `السنة المالية ${d.fiscalYear.startDate} – ${d.fiscalYear.endDate} · الإصدار ${v?.versionNo ?? "—"}${frozen ? " · ورقة العمل المعتمدة المجمدة" : " · محسوبة الآن من الدفاتر"}`,
        ),
        filenameStem: `${isZakat ? "zakat" : "income-tax"}_${d.fiscalYear.label}_v${v?.versionNo ?? 0}`,
        tables,
        notes: [
          ...(comp.blockers.length ? [L(`Not computable yet: ${comp.blockers.map((b) => b.message).join(" ")}`, `غير قابل للاحتساب بعد: ${comp.blockers.map((b) => b.message).join(" ")}`)] : []),
          isZakat
            ? L("A working paper, not a filing (owner decision Q1). Classes and adjustments are declared by people and cite their articles; open questions Z-1…Z-8 are listed in the decision pack.", "ورقة عمل وليست إقرارًا (قرار المالك Q1). الفئات والتعديلات يقررها أشخاص وتستند إلى موادها؛ والأسئلة المفتوحة Z-1…Z-8 مدرجة في حزمة القرارات.")
            : L("Current tax only — deferred tax (IAS 12 / IFRS for SMEs s.29) is not computed.", "الضريبة الجارية فقط — لا تُحتسب الضريبة المؤجلة (معيار المحاسبة الدولي 12 / القسم 29 للمنشآت الصغيرة والمتوسطة)."),
          L(`Due 120 days after the fiscal year-end: ${d.dueDate}.`, `تستحق بعد 120 يومًا من نهاية السنة المالية: ${d.dueDate}.`),
        ],
      };
    }
    case "treasury-forecast": {
      const f = await treasuryService.forecast(q.weeks);
      const kindLabel = (k: string) => pick({ committed: L("Committed", "ملتزم به"), expected: L("Expected", "متوقع"), forecast: L("Forecast", "تنبؤ"), manual: L("Manual assumption", "افتراض يدوي") }[k as "committed"] ?? L(k, k), lang);
      return {
        report: "treasury-forecast",
        title: L("Cash forecast", "توقع النقد"),
        scope: L(`From ${f.asOf} · ${f.horizonWeeks} weeks (to ${f.horizonEnd}) · opening cash (actual) ${f.opening.amount.toFixed(2)}`, `من ${f.asOf} · ${f.horizonWeeks} أسبوعًا (حتى ${f.horizonEnd}) · النقد الافتتاحي (فعلي) ${f.opening.amount.toFixed(2)}`),
        filenameStem: `cash-forecast_${f.asOf}_${f.horizonWeeks}w`,
        tables: [
          {
            title: L("By week — a projection, never cash", "حسب الأسبوع — إسقاط وليس نقدًا"),
            columns: [col("Bucket", "الفترة", "text", "standard"), col("From", "من", "date", "standard"), col("To", "إلى", "date", "standard"), col("Opening", "الافتتاحي", "money", "standard"), col("In", "داخل", "money", "standard"), col("Out", "خارج", "money", "standard"), col("Closing", "الختامي", "money", "standard")],
            rows: f.buckets.map((b) => ({ kind: "row" as const, cells: [lang === "ar" ? b.labelAr : b.label, b.from ?? "—", b.to ?? "—", b.opening, b.inflow.total, b.outflow.total, b.closing] })),
          },
          {
            title: L("Every row, typed and sourced", "كل بند، بنوعه ومصدره"),
            columns: [col("Bucket", "الفترة", "int", "standard"), col("Date", "التاريخ", "date", "standard"), col("Type", "النوع", "text", "standard"), col("Category", "الفئة", "text", "standard"), col("Item", "البند", "text", "standard"), col("In", "داخل", "money", "standard"), col("Out", "خارج", "money", "standard")],
            rows: f.rows.map((r) => ({ kind: "row" as const, cells: [r.bucket, r.date ?? "—", kindLabel(r.kind), r.category, lang === "ar" ? r.labelAr : r.label, r.direction === "in" ? r.amount : null, r.direction === "out" ? r.amount : null] })),
          },
        ],
        notes: [
          ...(f.funding.recommendation ? [L(`RECOMMENDATION (a calculation, not a transaction): ${f.funding.recommendation.en}`, `توصية (حساب وليست معاملة): ${f.funding.recommendation.ar}`)] : []),
          ...f.notes.map((n) => L(n.en, n.ar)),
        ],
      };
    }
    default:
      throw new BadRequestError(`"${report}" cannot be exported. Exportable reports: ${EXPORTABLE_REPORTS.join(", ")}.`);
  }
}

/**
 * 🔴 19B S2a (v4 §4, D4): the class table drives the export as it drives the screen. Each cell of a column with a
 * protected class — on a row its class applies to — that the reader's role may not read is replaced by a marker that
 * names what was withheld (a file has no "absent" cell); the document's notes say so. Nothing else is touched.
 * Returns how many cells were withheld.
 */
export function applyWithholding(doc: ReportDocument, decide: ReadDecider, lang: ExportLang): number {
  let withheld = 0;
  const classes = new Set<string>();
  for (const t of doc.tables) {
    t.columns.forEach((c, i) => {
      if (c.class === "standard") return;
      const { cls, resource } = c.class;
      if (decide(cls, resource) === "read") return;
      for (const r of t.rows) {
        if (r.kind !== "row" || r.subjectTo?.[i] === false || r.cells[i] == null || r.cells[i] === "") continue;
        r.cells[i] = pick(WITHHELD_MARKER[cls] ?? WITHHELD_MARKER.default!, lang);
        withheld++;
        classes.add(cls);
      }
    });
  }
  if (withheld) doc.notes.push(L(
    `${withheld} cell(s) are withheld for your role (${[...classes].join(", ")}).`,
    `حُجبت ${withheld} خانة لدورك (${[...classes].join("، ")}).`,
  ));
  return withheld;
}
const WITHHELD_MARKER: Record<string, Bi> = {
  bank_narrative: L("[withheld: bank text]", "[محجوب: نص كشف البنك]"),
  contact: L("[withheld: contact details]", "[محجوب: بيانات الاتصال]"),
  default: L("[withheld]", "[محجوب]"),
};

/** The export: the document model rendered to the requested format, after withholding (19B S2a). */
export async function exportReport(report: string, q: Q, format: ExportFormat, lang: ExportLang, decide: ReadDecider): Promise<{ contentType: string; filename: string; body: Buffer }> {
  const doc = await buildReportDocument(report, q, lang);
  const withheldCells = applyWithholding(doc, decide, lang);
  const rowCount = doc.tables.reduce((s, t) => s + t.rows.length, 0);
  if (rowCount > MAX_ROWS[format]) {
    throw new BusinessRuleError(422, {
      code: "export_too_large",
      error: `This ${format.toUpperCase()} would hold ${rowCount} rows; the limit is ${MAX_ROWS[format]}. Narrow the window (or export CSV) — an export is never cut short.`,
    });
  }
  const company = await companiesRepository.findCurrent(); // the company in scope (F-19)
  const companyName = company ? (lang === "ar" && company.nameAr ? company.nameAr : company.name) : "";
  const stamp = businessToday();
  const out = format === "csv"
    ? { contentType: "text/csv; charset=utf-8", filename: `${doc.filenameStem}.csv`, body: Buffer.from("﻿" + toCsv(doc, lang, companyName, stamp), "utf8") }
    : { contentType: "application/pdf", filename: `${doc.filenameStem}.pdf`, body: await htmlToPdf(toHtml(doc, lang, companyName, stamp), { margin: { top: "14mm", bottom: "14mm", left: "12mm", right: "12mm" } }) };
  // 🔴 DR-26: recorded BEFORE the file is sent — the request commits before it responds, so a failed record sends no file.
  const params = Object.fromEntries(Object.entries(q).filter(([k]) => k !== "format" && k !== "lang"));
  await auditService.record({ action: "export", entityType: "report_export", entityId: report, after: { format, lang, filename: out.filename, rows: rowCount, params, withheldCells } });
  return out;
}

/** 19B S4: the most rows a dataset's CSV holds — the fixed reports' CSV limit. Above it the export is refused, never cut. */
export const DATASET_EXPORT_MAX_ROWS = MAX_ROWS.csv;
export type DatasetDocument = Omit<ReportDocument, "report">;
export type ExportBi = Bi;
export type ExportRow = Row;
export type ExportColumn = Column;

/**
 * 🔴 19B S4: a report DATASET'S export — the same withholding, the same CSV rendering and the same audit record (before
 * the file is sent) as a fixed report's export; no second export path. The caller has already refused a count above
 * DATASET_EXPORT_MAX_ROWS (refused with the count, never cut short) and dropped every column the role may not read at
 * all; a conditional column's cells are withheld here, row by row (`subjectTo`).
 */
export async function exportDatasetCsv(doc: DatasetDocument, lang: ExportLang, decide: ReadDecider, audit: { dataset: string; params: Record<string, unknown> }): Promise<{ contentType: string; filename: string; body: Buffer }> {
  const full = doc as ReportDocument; // `report` names a fixed report; rendering never reads it
  const withheldCells = applyWithholding(full, decide, lang);
  const rowCount = full.tables.reduce((n, t) => n + t.rows.length, 0);
  const company = await companiesRepository.findCurrent();
  const companyName = company ? (lang === "ar" && company.nameAr ? company.nameAr : company.name) : "";
  const out = { contentType: "text/csv; charset=utf-8", filename: `${full.filenameStem}.csv`, body: Buffer.from("\ufeff" + toCsv(full, lang, companyName, businessToday()), "utf8") };
  // 🔴 recorded BEFORE the file is sent, as every export is (DR-26)
  await auditService.record({ action: "export", entityType: "report_dataset_export", entityId: audit.dataset, after: { format: "csv", lang, filename: out.filename, rows: rowCount, params: audit.params, withheldCells } });
  return out;
}

// ── rendering ────────────────────────────────────────────────────────────────

function col(en: string, ar: string, kind: ColumnKind, cls: ExportColumnClass): Column { return { label: L(en, ar), kind, class: cls }; }
function windowLabel(from?: string, to?: string) { return `${from ?? "…"} – ${to ?? "…"}`; }
function windowScope(from?: string, to?: string): Bi {
  if (from && to) return L(`${from} to ${to}`, `من ${from} إلى ${to}`);
  if (to) return L(`Up to ${to}`, `حتى ${to}`);
  if (from) return L(`From ${from}`, `من ${from}`);
  return L("All dates", "جميع التواريخ");
}
function mergeKeys(a: { key: string }[], b?: { key: string }[]) {
  const out: string[] = [];
  for (const x of [...a, ...(b ?? [])]) if (!out.includes(x.key)) out.push(x.key);
  return out;
}

/** CSV money: two decimals, no grouping, a plain minus — a spreadsheet must parse it. */
function csvCell(v: Cell, kind: ColumnKind): string {
  if (v == null) return "";
  let s = kind === "money" && typeof v === "number" ? v.toFixed(2) : String(v);
  // 🔴 CSV formula injection (OWASP): a TEXT cell a spreadsheet would read as a
  // formula — an account, customer or entry description beginning = + - @ TAB CR,
  // all user-entered — is neutralised with a leading apostrophe. A number the
  // export itself wrote ("-37.50%", a negative amount) is left exactly as it is.
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?%?$/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCsv(doc: ReportDocument, lang: ExportLang, companyName: string, stamp: string): string {
  const lines: string[] = [];
  const kv = (k: Bi, v: string) => lines.push(`${csvCell(pick(k, lang), "text")},${csvCell(v, "text")}`);
  kv(L("Company", "المنشأة"), companyName);
  kv(L("Report", "التقرير"), pick(doc.title, lang));
  kv(L("Period", "الفترة"), pick(doc.scope, lang));
  kv(L("Amounts", "المبالغ"), pick(L("SAR, rounded to the halala", "بالريال السعودي، مقرّبة إلى الهللة"), lang));
  kv(L("Generated on", "تاريخ الإنشاء"), stamp);
  for (const t of doc.tables) {
    lines.push("");
    if (t.title) lines.push(csvCell(pick(t.title, lang), "text"));
    lines.push(t.columns.map((c) => csvCell(pick(c.label, lang), "text")).join(","));
    for (const r of t.rows) lines.push(t.columns.map((c, i) => csvCell(r.cells[i] ?? null, c.kind)).join(","));
  }
  if (doc.notes.length) {
    lines.push("");
    for (const n of doc.notes) lines.push(csvCell(pick(n, lang), "text"));
  }
  return lines.join("\r\n") + "\r\n";
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
function htmlCell(v: Cell, kind: ColumnKind): string {
  if (v == null || v === "") return "";
  if (kind === "money" && typeof v === "number") {
    const s = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(v));
    // numbers stay LTR inside an RTL page; a negative is shown in parentheses
    return `<span dir="ltr">${v < 0 ? `(${s})` : s}</span>`;
  }
  if (kind === "int" || kind === "date") return `<span dir="ltr">${esc(String(v))}</span>`;
  return esc(String(v));
}
function toHtml(doc: ReportDocument, lang: ExportLang, companyName: string, stamp: string): string {
  const dir = lang === "ar" ? "rtl" : "ltr";
  const tables = doc.tables.map((t) => `
    ${t.title ? `<h3>${esc(pick(t.title, lang))}</h3>` : ""}
    <table>
      <thead><tr>${t.columns.map((c) => `<th class="${c.kind}">${esc(pick(c.label, lang))}</th>`).join("")}</tr></thead>
      <tbody>${t.rows.map((r) => `<tr class="${r.kind}">${r.kind === "section"
        ? `<td colspan="${t.columns.length}">${esc(String(r.cells[0] ?? ""))}</td>`
        : t.columns.map((c, i) => `<td class="${c.kind}">${htmlCell(r.cells[i] ?? null, c.kind)}</td>`).join("")}</tr>`).join("")}</tbody>
    </table>`).join("");
  return `<!doctype html><html lang="${lang}" dir="${dir}"><head><meta charset="utf-8"><title>${esc(pick(doc.title, lang))}</title>
<style>
  body { font-family: "Segoe UI", "Noto Naskh Arabic", "Noto Sans Arabic", "Traditional Arabic", Tahoma, sans-serif; font-size: 10pt; color: #111; }
  header { border-bottom: 1px solid #999; margin-bottom: 10px; padding-bottom: 6px; }
  h1 { font-size: 15pt; margin: 0 0 2px; } h2 { font-size: 11pt; margin: 0; font-weight: normal; color: #333; } h3 { font-size: 11pt; margin: 14px 0 4px; }
  .meta { font-size: 8.5pt; color: #555; margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; margin-top: 6px; }
  th, td { padding: 3px 6px; border-bottom: 1px solid #e3e3e3; text-align: start; vertical-align: top; }
  th { background: #f2f2f2; font-weight: 600; }
  td.money, th.money, td.int, th.int { text-align: end; white-space: nowrap; font-variant-numeric: tabular-nums; }
  tr.section td { font-weight: 700; background: #fafafa; padding-top: 8px; }
  tr.subtotal td { font-weight: 600; border-top: 1px solid #bbb; }
  tr.total td { font-weight: 700; border-top: 2px solid #333; border-bottom: 2px solid #333; }
  ul.notes { font-size: 8.5pt; color: #444; margin-top: 12px; padding-inline-start: 16px; }
</style></head><body>
<header>
  <h1>${esc(pick(doc.title, lang))}</h1>
  <h2>${esc(companyName)} · ${esc(pick(doc.scope, lang))}</h2>
  <div class="meta">${esc(pick(L("Amounts in SAR, rounded to the halala", "المبالغ بالريال السعودي، مقرّبة إلى الهللة"), lang))} · ${esc(pick(L("Generated on", "تاريخ الإنشاء"), lang))} <span dir="ltr">${esc(stamp)}</span></div>
</header>
${tables}
${doc.notes.length ? `<ul class="notes">${doc.notes.map((n) => `<li>${esc(pick(n, lang))}</li>`).join("")}</ul>` : ""}
</body></html>`;
}
