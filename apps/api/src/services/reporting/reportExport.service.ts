/**
 * PHASE 14 — D14-10: report exports, CSV and PDF, from THE SAME service output
 * the screen shows.
 *
 * Every export calls the report's own `reportsService` function with the
 * report's own parameters, inside the request's tenant + company transaction
 * and behind the same `reports` permission as the screen. There is no export
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
import { BusinessRuleError, BadRequestError } from "../../lib/errors";
import { businessToday } from "@workspace/shared";
import { companiesRepository } from "../../repositories/companies.repository";
import { reportsService, reportAccountId, reportDate, reportParty, reportWindow } from "../reports.service";
import { htmlToPdf } from "../document/htmlToPdf";
import { CASH_FLOW_LINE_LABEL, type CashFlowLine } from "./cashFlowClassification";
import { budgetsService } from "../budgets.service";

export const EXPORTABLE_REPORTS = ["trial-balance", "income-statement", "balance-sheet", "cash-flow", "general-ledger", "ar-aging", "ap-aging", "budget-vs-actual"] as const;
export type ExportableReport = (typeof EXPORTABLE_REPORTS)[number];
export type ExportFormat = "csv" | "pdf";
export type ExportLang = "en" | "ar";

const MAX_ROWS: Record<ExportFormat, number> = { csv: 50_000, pdf: 3_000 };

type Bi = { en: string; ar: string };
type Cell = string | number | null;
type ColumnKind = "text" | "money" | "int" | "date";
type Row = { kind: "section" | "row" | "subtotal" | "total" | "note"; cells: Cell[] };
type Table = { title?: Bi; columns: { label: Bi; kind: ColumnKind }[]; rows: Row[] };
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
          columns: [col("Account", "الحساب", "text"), col("Opening", "الرصيد الافتتاحي", "money"), col("Debit", "مدين", "money"), col("Credit", "دائن", "money"), col("Closing", "الرصيد الختامي", "money")],
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
      const pRev = priorBy(prior?.revenue), pExp = priorBy(prior?.expenses);
      const keysRev = mergeKeys(cur.revenue, prior?.revenue), keysExp = mergeKeys(cur.expenses, prior?.expenses);
      const amountCols = prior ? [col(windowLabel(from, to), windowLabel(from, to), "money"), col(windowLabel(cmpWin!.from, cmpWin!.to), windowLabel(cmpWin!.from, cmpWin!.to), "money")] : [col("Amount", "المبلغ", "money")];
      const line = (x: { key: string; name: string; nameAr: string; amount: number } | undefined, key: string, prev: Map<string, number>, fallbackName: string): Row =>
        ({ kind: "row", cells: [x ? nameIn(x, lang) : fallbackName, x?.amount ?? 0, ...(prior ? [prev.get(key) ?? 0] : [])] });
      return {
        report: "income-statement",
        title: L("Statement of profit or loss", "قائمة الأرباح أو الخسائر"),
        scope: windowScope(from, to),
        filenameStem: `profit-or-loss_${from ?? "start"}_${to ?? "end"}`,
        tables: [{
          columns: [col("Account", "الحساب", "text"), ...amountCols],
          rows: [
            { kind: "section", cells: [pick(L("Revenue", "الإيرادات"), lang)] },
            ...keysRev.map((k) => line(cur.revenue.find((r) => r.key === k), k, pRev, prior?.revenue.find((r) => r.key === k) ? nameIn(prior.revenue.find((r) => r.key === k)!, lang) : k)),
            { kind: "subtotal", cells: [pick(L("Total revenue", "إجمالي الإيرادات"), lang), cur.totalRevenue, ...(prior ? [prior.totalRevenue] : [])] },
            { kind: "section", cells: [pick(L("Expenses (by nature)", "المصروفات (حسب طبيعتها)"), lang)] },
            ...keysExp.map((k) => line(cur.expenses.find((r) => r.key === k), k, pExp, prior?.expenses.find((r) => r.key === k) ? nameIn(prior.expenses.find((r) => r.key === k)!, lang) : k)),
            { kind: "subtotal", cells: [pick(L("Total expenses", "إجمالي المصروفات"), lang), cur.totalExpenses, ...(prior ? [prior.totalExpenses] : [])] },
            { kind: "total", cells: [pick(L("Profit (loss) for the period", "ربح (خسارة) الفترة"), lang), cur.netIncome, ...(prior ? [prior.netIncome] : [])] },
          ],
        }],
        notes: [L("Expenses are analysed by nature (IAS 1.102); no zakat expense is recorded in the ledger.", "تُحلَّل المصروفات حسب طبيعتها (معيار المحاسبة الدولي 1.102)؛ ولا يتضمن الدفتر مصروف زكاة مسجَّلاً.")],
      };
    }
    case "balance-sheet": {
      const asOf = reportDate(q.as_of, "as_of") ?? businessToday();
      const cur = await reportsService.balanceSheet(asOf);
      const cmpAsOf = reportDate(q.compare_as_of, "compare_as_of");
      const prior = cmpAsOf ? await reportsService.balanceSheet(cmpAsOf) : null;
      type It = { key: string; name: string; nameAr: string; amount: number };
      const prevMap = (xs: It[] | undefined) => new Map((xs ?? []).map((x) => [x.key, x]));
      const amountCols = prior ? [col(asOf, asOf, "money"), col(cmpAsOf!, cmpAsOf!, "money")] : [col(`As of ${asOf}`, `كما في ${asOf}`, "money")];
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
          columns: [col("Line", "البند", "text"), ...amountCols],
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
          columns: [col("Line", "البند", "text"), col("Amount", "المبلغ", "money")],
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
      return {
        report: "general-ledger",
        title: L("General ledger", "دفتر الأستاذ العام"),
        scope: L(`${gl.accountName} · ${windowScope(from, to).en}`, `${gl.accountNameAr || gl.accountName} · ${windowScope(from, to).ar}`),
        filenameStem: `general-ledger_${accountId ?? "all"}_${from ?? "start"}_${to ?? "end"}`,
        tables: [{
          columns: [col("Date", "التاريخ", "date"), col("Entry", "القيد", "text"), col("Description", "البيان", "text"), col("Account", "الحساب", "text"), col("Debit", "مدين", "money"), col("Credit", "دائن", "money"), col("Balance", "الرصيد", "money")],
          rows: [
            { kind: "subtotal", cells: [from ?? "", "", pick(L("Opening balance", "الرصيد الافتتاحي"), lang), "", null, null, gl.openingBalance] },
            ...gl.movements.map((m) => ({ kind: "row" as const, cells: [m.date, m.entryNumber, m.description ?? "", lang === "ar" && m.accountNameAr ? m.accountNameAr : m.accountName, m.debit, m.credit, m.balance] })),
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
            columns: [col("Bucket", "الفئة", "text"), col("Outstanding", "المستحق", "money")],
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
            columns: [col("Document", "المستند", "text"), col(isAr ? "Customer" : "Supplier", isAr ? "العميل" : "المورد", "text"), col("Due", "الاستحقاق", "date"), col("Days past due", "أيام التأخر", "int"), col("Outstanding", "المستحق", "money")],
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
        if (!/^\d+$/.test(v)) throw new BadRequestError(`${name} must be a positive whole number.`);
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
            col("Account", "الحساب", "text"), col("Budgeted", "أساس الميزانية", "text"),
            col("YTD budget", "ميزانية حتى تاريخه", "money"), col("YTD actual", "الفعلي حتى تاريخه", "money"), col("Variance", "الانحراف", "money"), col("Variance %", "نسبة الانحراف", "text"), col("Judgement", "التقييم", "text"),
            col("Full-year budget", "ميزانية السنة", "money"), col("Actual to date", "الفعلي حتى الآن", "money"), col("Forecast", "التوقع", "money"),
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
    default:
      throw new BadRequestError(`"${report}" cannot be exported. Exportable reports: ${EXPORTABLE_REPORTS.join(", ")}.`);
  }
}

/** The export: the document model rendered to the requested format. */
export async function exportReport(report: string, q: Q, format: ExportFormat, lang: ExportLang): Promise<{ contentType: string; filename: string; body: Buffer }> {
  const doc = await buildReportDocument(report, q, lang);
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
  if (format === "csv") {
    return { contentType: "text/csv; charset=utf-8", filename: `${doc.filenameStem}.csv`, body: Buffer.from("﻿" + toCsv(doc, lang, companyName, stamp), "utf8") };
  }
  const pdf = await htmlToPdf(toHtml(doc, lang, companyName, stamp), { margin: { top: "14mm", bottom: "14mm", left: "12mm", right: "12mm" } });
  return { contentType: "application/pdf", filename: `${doc.filenameStem}.pdf`, body: pdf };
}

// ── rendering ────────────────────────────────────────────────────────────────

function col(en: string, ar: string, kind: ColumnKind) { return { label: L(en, ar), kind }; }
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
