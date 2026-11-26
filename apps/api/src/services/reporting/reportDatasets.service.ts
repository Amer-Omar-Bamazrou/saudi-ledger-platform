/**
 * 🔴 19B S4 — the report datasets, through `decide()` (lib/reports/decide.ts): list, run, export.
 *
 *  - RUN: a shown column the role may not read is absent from every row and listed in `withheld` (D4); a conditional
 *    class (the bank's text) is withheld on the rows it applies to only. A refused run is not recorded (D6).
 *  - EXPORT: the same decision with the `export` act. Refused for a permission → RECORDED as a refusal event (names
 *    only, never a value) and answered. Otherwise counted first — too many rows is refused WITH the count, never cut
 *    short — then rendered and recorded by the fixed reports' own export path (`exportDatasetCsv`). A column the role
 *    may not read at all is absent from the file; a conditional column's cells are marked row by row.
 *
 * The company and the organization are the request's (RLS and `companyScoped`): a dataset request cannot name either.
 */
import { REPORT_ACTS, reportDatasetResource } from "@workspace/db";
import { BusinessRuleError } from "../../lib/errors";
import type { ReadDecider } from "../../lib/fieldClasses/walk";
import type { DatasetDef, DatasetRow } from "../../lib/reports/datasets";
import { rowConditionApplies } from "../../lib/fieldClasses/classTable";
import { decide, NO_USE, type DecidedColumn, type Has, type Use } from "../../lib/reports/decide";
import { reportDatasetsRepository, type JournalLinesFilter, type JournalLinesSortKey, type JournalLineRow } from "../../repositories/reportDatasets.repository";
import { refusalEventsService } from "../refusalEvents.service";
import { datasetRowLimit, exportDataset, type DatasetDocument, type ExportColumn, type ExportRow } from "./reportExport.service";
import { compareGroupKeys, groupKeyOf, groupRows, type Grouped } from "../../lib/reports/grouping";
import { DATASETS, WINDOW_REQUIRED } from "../../lib/reports/datasets";
import { documentDatasetsRepository, type WindowFilter } from "../../repositories/reportDatasets.repository";
import { reportsService } from "../reports.service";
import { MAX_ID } from "../reports.service";

export interface DatasetActor { userId: number | null; organizationId: string; companyId: string | null }
type Query = Record<string, string | undefined>;

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const badRequest = (error: string, errorAr: string) => new BusinessRuleError(400, { code: "report_bad_filter", error, errorAr });

/** A request's columns, filters, grouping and sort — each a USE of a column — and the query those filters make. */
export function parseRequest(ds: DatasetDef, q: Query, paged: boolean) {
  const list = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const present = Object.keys(ds.filters).filter((p) => q[p] != null && q[p] !== "");
  const sortRaw = (q.sort ?? "").trim();
  const use: Use = {
    show: list(q.columns),
    filter: present.map((p) => ds.filters[p]!),
    group: list(q.group),
    sort: sortRaw ? [sortRaw.replace(/^-/, "")] : [],
  };
  const filter: JournalLinesFilter = {};
  if (q.date_from) { if (!DATE.test(q.date_from)) throw badRequest("date_from must be a date (YYYY-MM-DD).", "يجب أن يكون date_from تاريخاً (YYYY-MM-DD)."); filter.dateFrom = q.date_from; }
  if (q.date_to) { if (!DATE.test(q.date_to)) throw badRequest("date_to must be a date (YYYY-MM-DD).", "يجب أن يكون date_to تاريخاً (YYYY-MM-DD)."); filter.dateTo = q.date_to; }
  if (q.account_id) {
    const n = Number(q.account_id);
    // the column's range, not only the sign (Phase 18 A3): an id past int4 would reach the database as a 500
    if (!Number.isSafeInteger(n) || n <= 0 || n > MAX_ID) throw badRequest("account_id must be a positive whole number.", "يجب أن يكون account_id عدداً صحيحاً موجباً.");
    filter.accountId = n;
  }
  if (q.source_type) filter.sourceType = q.source_type;
  const sort = sortRaw ? { key: sortRaw.replace(/^-/, "") as JournalLinesSortKey, desc: sortRaw.startsWith("-") } : null;
  let page: { limit: number; offset: number } | null = null;
  if (paged) {
    const limit = q.limit ? Number(q.limit) : DEFAULT_LIMIT;
    const offset = q.offset ? Number(q.offset) : 0;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw badRequest(`limit must be between 1 and ${MAX_LIMIT}.`, `يجب أن يكون limit بين 1 و${MAX_LIMIT}.`);
    if (!Number.isInteger(offset) || offset < 0) throw badRequest("offset must be 0 or more.", "يجب أن يكون offset صفراً أو أكثر.");
    page = { limit, offset };
  }
  return { use, filter, sort, page };
}

export function refusalError(d: Extract<ReturnType<typeof decide>, { allowed: false }>) {
  return new BusinessRuleError(d.status, { code: d.code, error: d.error, errorAr: d.errorAr, dataset: d.dataset, act: d.act, fields: d.fields });
}

const columnOut = (c: DecidedColumn) => ({
  key: c.column.key,
  label: c.column.label,
  labelAr: c.column.labelAr,
  kind: c.column.kind,
  class: c.cls,
  level: c.level,
  conditional: c.rowCondition ? (c.column.conditionLabel?.label ?? `rows whose ${c.rowCondition.by} is ${c.rowCondition.in.join(" or ")}`) : null,
  filterable: c.column.filterable,
  sortable: c.column.sortable,
});

/** A cell the role may see on this row: read, or a conditional class that does not apply to this row. */
function visible(c: DecidedColumn, row: DatasetRow): boolean {
  return c.level === "read" || (c.rowCondition != null && !rowConditionApplies(c.rowCondition, row));
}

type Sort = { key: string; desc: boolean } | null;
type Page = { limit: number; offset: number } | null;
type Reader = (f: WindowFilter, sort: Sort, page: Page) => Promise<{ rows: DatasetRow[]; total: number }>;

/**
 * 🔴 19B S5 — each remaining dataset's READ. The VAT lines are the return's own addends for the window
 * (`vatReturnWithLines`), numbered in the order the return adds them; they are few per window, so the page is cut here.
 */
const READERS: Record<string, Reader> = {
  sales_documents: (f, s, p) => documentDatasetsRepository.salesDocuments(f, s, p),
  purchase_documents: (f, s, p) => documentDatasetsRepository.purchaseDocuments(f, s, p),
  cash_movements: (f, s, p) => documentDatasetsRepository.cashMovements(f, s, p),
  vat_lines: async (f, s, p) => {
    const { lines } = await reportsService.vatReturnWithLines(f.dateFrom!, f.dateTo!);
    const all: DatasetRow[] = lines.map((l, i) => ({ lineNo: i + 1, ...l }));
    if (s?.key === "date") all.sort((a, b) => String(a.date ?? "").localeCompare(String(b.date ?? "")) * (s.desc ? -1 : 1));
    return { rows: p ? all.slice(p.offset, p.offset + p.limit) : all, total: all.length };
  },
};

/**
 * 19B S6 — one dataset's rows, whichever dataset: the read a schedule's run uses, so a stored copy is built from the
 * same query the screen and the export are.
 */
export function readDataset(ds: DatasetDef, filter: JournalLinesFilter, sort: Sort, page: Page): Promise<{ rows: DatasetRow[]; total: number }> {
  if (ds.name === "journal_lines") {
    return reportDatasetsRepository.journalLines(filter, sort as { key: JournalLinesSortKey; desc: boolean } | null, page) as unknown as Promise<{ rows: DatasetRow[]; total: number }>;
  }
  return READERS[ds.name]!(filter, sort, page);
}

/** A column as a response lists it, with the level this role reads it at. */
export const datasetColumnOut = (c: DecidedColumn) => columnOut(c);
/** Whether a role sees this cell on this row: read, or a conditional class that does not apply to the row. */
export const cellVisible = (c: DecidedColumn, row: DatasetRow): boolean => visible(c, row);

/** A dataset whose figure is a WINDOW's (the VAT return's) is refused without one — never run on a guessed period. */
export function requireWindow(ds: DatasetDef, filter: { dateFrom?: string; dateTo?: string }) {
  if (WINDOW_REQUIRED.has(ds.name) && !(filter.dateFrom && filter.dateTo)) {
    throw badRequest(`The ${ds.title} report needs a period: date_from and date_to.`, `يحتاج تقرير «${ds.titleAr}» إلى فترة: date_from و date_to.`);
  }
}

const tooLarge = (code: "export_too_large" | "report_too_large", ds: DatasetDef, total: number, limit: number, format: "csv" | "pdf" = "csv") =>
  new BusinessRuleError(422, {
    code,
    error: code === "export_too_large"
      ? `This file would hold ${total} rows; the limit is ${limit}. Narrow the dates${"account_id" in ds.filters ? " or the account" : ""}${format === "pdf" ? ", or export CSV" : ""} — an export is never cut short.`
      : `A grouped report reads every row of its period: this one has ${total}, and the limit is ${limit}. Narrow the dates — a total is never worked out on part of the rows.`,
    errorAr: code === "export_too_large"
      ? `سيحتوي هذا الملف على ${total} سطراً، والحد ${limit}. ضيّق التواريخ${"account_id" in ds.filters ? " أو الحساب" : ""}${format === "pdf" ? "، أو صدّر CSV" : ""} — لا يُقتطع التصدير أبداً.`
      : `التقرير المجمَّع يقرأ كل سطور فترته: في هذا التقرير ${total} سطراً، والحد ${limit}. ضيّق التواريخ — لا يُحسب مجموع على جزء من السطور.`,
  });

/** Every row of the window — counted first, and refused WITH the count above the limit, never cut short. */
async function readAll(ds: DatasetDef, filter: JournalLinesFilter, sort: Sort, code: "export_too_large" | "report_too_large", format: "csv" | "pdf" = "csv"): Promise<DatasetRow[]> {
  const { total } = await readDataset(ds, filter, sort, { limit: 1, offset: 0 });
  const limit = datasetRowLimit(format);
  if (total > limit) throw tooLarge(code, ds, total, limit, format);
  return (await readDataset(ds, filter, sort, null)).rows;
}

/** 19.12 — the rows group by group (a missing key last), in the order they came within a group. */
export function orderByGroup(ds: DatasetDef, groupKey: string, rows: readonly DatasetRow[]): DatasetRow[] {
  const column = ds.columns.find((c) => c.key === groupKey)!;
  return rows
    .map((row, i) => ({ row, i, key: groupKeyOf(column, row) }))
    .sort((a, b) => compareGroupKeys(a.key, b.key) || a.i - b.i)
    .map((x) => x.row);
}

/** 19.12 — a grouped answer's own fields, and the totals this role is not given (listed, never computed). */
export const groupedOut = (g: Grouped) => ({ groupedBy: g.groupedBy, groups: g.groups, grandTotal: g.grandTotal });
export const withheldTotalsOut = (g: Grouped) =>
  g.withheldTotals.map((c) => ({ path: `groups[].totals.${c.column.key}`, class: c.cls, level: c.level === "last4" ? "last4" : "none", rows: null as number | null }));

export const reportDatasetsService = {
  /**
   * RUN a dataset: the decision, the withholding, the page. 19.12 — with a grouping, every row of the window is read
   * (refused with the count above the limit), the subtotals are of ALL of them, and the page is cut from the rows in
   * group order.
   */
  async rows(ds: DatasetDef, has: Has, q: Query) {
    const { use, filter, sort, page } = parseRequest(ds, q, true);
    const d = decide(has, ds, "run", use);
    if (!d.allowed) throw refusalError(d);
    requireWindow(ds, filter);
    const groupKey = use.group[0];
    let rows: DatasetRow[];
    let total: number;
    let grouped: Grouped | null = null;
    if (groupKey) {
      const all = await readAll(ds, filter, sort, "report_too_large");
      grouped = groupRows(ds, groupKey, d.columns, all);
      total = all.length;
      rows = orderByGroup(ds, groupKey, all).slice(page!.offset, page!.offset + page!.limit);
    } else {
      ({ rows, total } = await readDataset(ds, filter, sort, page));
    }
    const out = rows.map((r) => {
      const o: Record<string, unknown> = {};
      for (const c of d.columns) if (visible(c, r)) o[c.column.key] = r[c.column.key];
      return o;
    });
    const withheld: { path: string; class: string; level: string; rows: number | null }[] = d.withheld.map((c) => ({
      path: `rows[].${c.column.key}`,
      class: c.cls,
      level: c.level === "last4" ? "last4" : "none",
      rows: rows.filter((r) => !visible(c, r)).length,
    }));
    if (grouped) withheld.push(...withheldTotalsOut(grouped));
    return { dataset: ds.name, columns: d.columns.map(columnOut), rows: out, total, limit: page!.limit, offset: page!.offset, withheld, ...(grouped ? groupedOut(grouped) : {}) };
  },

  /**
   * EXPORT a dataset as CSV or (19.15) PDF — `format`, CSV when absent: one decision, one document, one withholding for
   * both. Refused exports recorded (D6), too many rows for the format refused with the count. 19.12 — a grouped
   * export carries each group's rows, then its subtotal row, and the grand total where the dataset has one.
   */
  async export(ds: DatasetDef, has: Has, actor: DatasetActor, q: Query, lang: "en" | "ar", readDecider: ReadDecider) {
    const format = q.format == null || q.format === "" ? "csv" : q.format;
    if (format !== "csv" && format !== "pdf") throw badRequest("format must be csv or pdf.", "يجب أن يكون format إما csv أو pdf.");
    const { use, filter, sort } = parseRequest(ds, q, false);
    const d = decide(has, ds, "export", use);
    if (!d.allowed) {
      // 🔴 D6: a refused export is recorded — names and classes only — on its own connection; then answered.
      if (d.status === 403) {
        await refusalEventsService.record({
          action: "export", actorUserId: actor.userId, organizationId: actor.organizationId, companyId: actor.companyId,
          resource: reportDatasetResource(ds.name), refusalCode: d.code,
          fieldNames: d.fields.map((f) => f.field), fieldClasses: d.fields.map((f) => f.class),
        });
      }
      throw refusalError(d);
    }
    requireWindow(ds, filter);
    const doc = buildDatasetDocument(ds, d, use.group[0] ?? null, await readAll(ds, filter, sort, "export_too_large", format), { from: filter.dateFrom, to: filter.dateTo }, lang);
    const params = Object.fromEntries(Object.entries(q).filter(([k]) => k !== "lang" && k !== "format"));
    return exportDataset(doc, format, lang, readDecider, { dataset: ds.name, params });
  },

  /** Every dataset this role may run, with the acts it may take, each column's level and what it may be grouped by. */
  list(has: Has) {
    const items = Object.values(DATASETS).flatMap((ds) => {
      const acts = REPORT_ACTS.filter((a) => decide(has, ds, a, NO_USE).allowed);
      const run = decide(has, ds, "run", NO_USE);
      if (!run.allowed) return [];
      const filters = Object.entries(ds.filters).map(([param, column]) => ({ param, column }));
      // a grouping this role could not read is not offered (decide() would refuse it by name)
      const groupBy = run.columns.filter((c) => c.column.groupable && c.level === "read").map((c) => c.column.key);
      return [{ name: ds.name, title: ds.title, titleAr: ds.titleAr, acts, columns: run.columns.map(columnOut), filters, groupBy, totals: [...ds.totals], grandTotal: ds.grandTotal }];
    });
    return { items };
  },

  journalLinesRows(ds: DatasetDef, has: Has, q: Query) {
    return this.rows(ds, has, q);
  },

  journalLinesExport(ds: DatasetDef, has: Has, actor: DatasetActor, q: Query, lang: "en" | "ar", readDecider: ReadDecider) {
    return this.export(ds, has, actor, q, lang, readDecider);
  },
};

type Allowed = Extract<ReturnType<typeof decide>, { allowed: true }>;

/**
 * A dataset's rows as the one export document (CSV and PDF render the same one). A column the role may not read at all
 * is ABSENT from the file; a conditional one stays, its cells withheld row by row (`subjectTo`). 19.12 — grouped: each
 * group's rows, its subtotal, and the grand total; a total the role is not given is not in the file, and is named.
 */
export function buildDatasetDocument(ds: DatasetDef, d: Allowed, groupKey: string | null, rows: readonly DatasetRow[], window: { from?: string; to?: string }, lang: "en" | "ar"): DatasetDocument {
  const inFile = d.columns.filter((c) => c.level === "read" || c.rowCondition != null);
  const absent = d.columns.filter((c) => !inFile.includes(c));
  const columns: ExportColumn[] = inFile.map((c) => ({
    label: { en: c.column.label, ar: c.column.labelAr },
    kind: c.column.kind,
    class: c.cls === "standard" ? "standard" : { cls: c.cls, resource: c.resource! },
  }));
  const yesNo = lang === "ar" ? ["نعم", "لا"] : ["yes", "no"];
  const cellOf = (v: unknown): string | number | null => (v == null ? null : typeof v === "boolean" ? (v ? yesNo[0]! : yesNo[1]!) : (v as string | number));
  const fileRow = (row: DatasetRow): ExportRow => {
    const subjectTo: Record<number, boolean> = {};
    inFile.forEach((c, i) => { if (c.rowCondition) subjectTo[i] = rowConditionApplies(c.rowCondition, row); });
    return { kind: "row", cells: inFile.map((c) => cellOf(row[c.column.key])), subjectTo };
  };
  const notes: DatasetDocument["notes"] = absent.length
    ? [{
        en: `Withheld for your role, and absent from this file: ${absent.map((c) => `${c.column.label} (${c.cls})`).join(", ")}.`,
        ar: `محجوب لدورك وغير موجود في هذا الملف: ${absent.map((c) => `${c.column.labelAr} (${c.cls})`).join("، ")}.`,
      }]
    : [];

  // an empty report says so: a header over nothing reads as a file that failed
  if (rows.length === 0) notes.unshift({ en: "Nothing in this period.", ar: "لا توجد بيانات في هذه الفترة." });

  let fileRows: ExportRow[];
  if (!groupKey) {
    fileRows = rows.map(fileRow);
  } else {
    const g = groupRows(ds, groupKey, d.columns, rows);
    const column = ds.columns.find((c) => c.key === groupKey)!;
    const ordered = orderByGroup(ds, groupKey, rows);
    // the words go in the first column that is not itself a total
    const labelAt = inFile.findIndex((c) => !ds.totals.includes(c.column.key));
    const totalRow = (kind: "subtotal" | "total", label: string, totals: { column: string; total: number }[]): ExportRow => ({
      kind,
      cells: inFile.map((c, i) => (i === labelAt ? label : (totals.find((t) => t.column === c.column.key)?.total ?? null))),
    });
    const groupName = (key: string | null, label: string | null) => (key === null ? (lang === "ar" ? "بدون قيمة" : "(none)") : label ? `${key} — ${label}` : key);
    fileRows = [];
    for (const grp of g.groups) {
      for (const row of ordered) if (groupKeyOf(column, row) === grp.key) fileRows.push(fileRow(row));
      fileRows.push(totalRow("subtotal", `${lang === "ar" ? "المجموع الفرعي" : "Subtotal"}: ${groupName(grp.key, grp.label)} (${grp.count})`, grp.totals));
    }
    if (g.grandTotal) fileRows.push(totalRow("total", `${lang === "ar" ? "الإجمالي" : "Total"} (${g.grandTotal.count})`, g.grandTotal.totals));
    notes.push({ en: `Grouped by ${column.label}${column.groupAs === "month" ? " (month)" : ""}.`, ar: `مجمَّع حسب ${column.labelAr}${column.groupAs === "month" ? " (الشهر)" : ""}.` });
    if (!g.grandTotal) notes.push({
      en: "This report has no grand total: a total over all its rows would not be a figure of the books.",
      ar: "لا يوجد إجمالي عام لهذا التقرير: مجموع كل سطوره ليس رقماً من أرقام الدفاتر.",
    });
    if (g.withheldTotals.length) notes.push({
      en: `Totals withheld for your role, and not worked out: ${g.withheldTotals.map((c) => `${c.column.label} (${c.cls})`).join(", ")}.`,
      ar: `مجاميع محجوبة لدورك ولم تُحسب: ${g.withheldTotals.map((c) => `${c.column.labelAr} (${c.cls})`).join("، ")}.`,
    });
    if ([...g.groups, ...(g.grandTotal ? [g.grandTotal] : [])].some((x) => x.mixedCurrency)) notes.push({
      en: "A set that mixes currencies has no money total.",
      ar: "المجموعة التي تختلط فيها العملات ليس لها مجموع مالي.",
    });
  }
  const scope = `${window.from ?? "…"} – ${window.to ?? "…"}`;
  return {
    title: { en: ds.title, ar: ds.titleAr },
    scope: { en: scope, ar: scope },
    tables: [{ columns, rows: fileRows }],
    notes,
    filenameStem: `${ds.name.replace(/_/g, "-")}_${window.from ?? "start"}_${window.to ?? "end"}`,
  };
}
