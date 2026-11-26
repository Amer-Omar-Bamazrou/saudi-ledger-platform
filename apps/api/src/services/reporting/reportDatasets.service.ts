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
import { DATASET_EXPORT_MAX_ROWS, exportDatasetCsv, type DatasetDocument, type ExportColumn, type ExportRow } from "./reportExport.service";
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

export const reportDatasetsService = {
  /** 19B S5 — RUN one of the remaining datasets: the same decision, withholding and paging as journal lines. */
  async rows(ds: DatasetDef, has: Has, q: Query) {
    const { use, filter, sort, page } = parseRequest(ds, q, true);
    const d = decide(has, ds, "run", use);
    if (!d.allowed) throw refusalError(d);
    requireWindow(ds, filter);
    const { rows, total } = await READERS[ds.name]!(filter, sort, page);
    const out = rows.map((r) => {
      const o: Record<string, unknown> = {};
      for (const c of d.columns) if (visible(c, r)) o[c.column.key] = r[c.column.key];
      return o;
    });
    const withheld = d.withheld.map((c) => ({
      path: `rows[].${c.column.key}`,
      class: c.cls,
      level: c.level === "last4" ? "last4" : "none",
      rows: rows.filter((r) => !visible(c, r)).length,
    }));
    return { dataset: ds.name, columns: d.columns.map(columnOut), rows: out, total, limit: page!.limit, offset: page!.offset, withheld };
  },

  /** 19B S5 — EXPORT one of the remaining datasets: refused exports recorded (D6), too many rows refused with the count. */
  async export(ds: DatasetDef, has: Has, actor: DatasetActor, q: Query, lang: "en" | "ar", readDecider: ReadDecider) {
    const { use, filter, sort } = parseRequest(ds, q, false);
    const d = decide(has, ds, "export", use);
    if (!d.allowed) {
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
    const { total } = await READERS[ds.name]!(filter, sort, { limit: 1, offset: 0 });
    if (total > DATASET_EXPORT_MAX_ROWS) {
      throw new BusinessRuleError(422, {
        code: "export_too_large",
        error: `This CSV would hold ${total} rows; the limit is ${DATASET_EXPORT_MAX_ROWS}. Narrow the dates — an export is never cut short.`,
        errorAr: `سيحتوي هذا الملف على ${total} سطراً، والحد ${DATASET_EXPORT_MAX_ROWS}. ضيّق التواريخ — لا يُقتطع التصدير أبداً.`,
      });
    }
    const { rows } = await READERS[ds.name]!(filter, sort, null);
    const inFile = d.columns.filter((c) => c.level === "read" || c.rowCondition != null);
    const absent = d.columns.filter((c) => !inFile.includes(c));
    const columns: ExportColumn[] = inFile.map((c) => ({
      label: { en: c.column.label, ar: c.column.labelAr },
      kind: c.column.kind,
      class: c.cls === "standard" ? "standard" : { cls: c.cls, resource: c.resource! },
    }));
    const cellOf = (v: unknown): string | number | null => (v == null ? null : typeof v === "boolean" ? (v ? "yes" : "no") : (v as string | number));
    const fileRows: ExportRow[] = rows.map((row) => {
      const subjectTo: Record<number, boolean> = {};
      inFile.forEach((c, i) => { if (c.rowCondition) subjectTo[i] = rowConditionApplies(c.rowCondition, row); });
      return { kind: "row", cells: inFile.map((c) => cellOf(row[c.column.key])), subjectTo };
    });
    const window = `${filter.dateFrom ?? "…"} – ${filter.dateTo ?? "…"}`;
    const doc: DatasetDocument = {
      title: { en: ds.title, ar: ds.titleAr },
      scope: { en: window, ar: window },
      tables: [{ columns, rows: fileRows }],
      notes: absent.length
        ? [{
            en: `Withheld for your role, and absent from this file: ${absent.map((c) => `${c.column.label} (${c.cls})`).join(", ")}.`,
            ar: `محجوب لدورك وغير موجود في هذا الملف: ${absent.map((c) => `${c.column.labelAr} (${c.cls})`).join("، ")}.`,
          }]
        : [],
      filenameStem: `${ds.name.replace(/_/g, "-")}_${filter.dateFrom ?? "start"}_${filter.dateTo ?? "end"}`,
    };
    const params = Object.fromEntries(Object.entries(q).filter(([k]) => k !== "lang"));
    return exportDatasetCsv(doc, lang, readDecider, { dataset: ds.name, params });
  },

  /** Every dataset this role may run, with the acts it may take and each column's level. */
  list(has: Has) {
    const items = Object.values(DATASETS).flatMap((ds) => {
      const acts = REPORT_ACTS.filter((a) => decide(has, ds, a, NO_USE).allowed);
      const run = decide(has, ds, "run", NO_USE);
      if (!run.allowed) return [];
      const filters = Object.entries(ds.filters).map(([param, column]) => ({ param, column }));
      return [{ name: ds.name, title: ds.title, titleAr: ds.titleAr, acts, columns: run.columns.map(columnOut), filters }];
    });
    return { items };
  },

  async journalLinesRows(ds: DatasetDef, has: Has, q: Query) {
    const { use, filter, sort, page } = parseRequest(ds, q, true);
    const d = decide(has, ds, "run", use);
    if (!d.allowed) throw refusalError(d);
    const { rows, total } = await reportDatasetsRepository.journalLines(filter, sort, page);
    const out = rows.map((r) => {
      const o: Record<string, unknown> = {};
      for (const c of d.columns) if (visible(c, r as unknown as DatasetRow)) o[c.column.key] = (r as unknown as DatasetRow)[c.column.key];
      return o;
    });
    const withheld = d.withheld.map((c) => ({
      path: `rows[].${c.column.key}`,
      class: c.cls,
      level: c.level === "last4" ? "last4" : "none",
      rows: rows.filter((r) => !visible(c, r as unknown as DatasetRow)).length,
    }));
    return { dataset: ds.name, columns: d.columns.map(columnOut), rows: out, total, limit: page!.limit, offset: page!.offset, withheld };
  },

  async journalLinesExport(ds: DatasetDef, has: Has, actor: DatasetActor, q: Query, lang: "en" | "ar", readDecider: ReadDecider) {
    const { use, filter, sort } = parseRequest(ds, q, false);
    const d = decide(has, ds, "export", use);
    if (!d.allowed) {
      // 🔴 D6: a refused export is recorded — names and classes only — on its own connection; then answered.
      if (d.status === 403) {
        await refusalEventsService.record({
          action: "export",
          actorUserId: actor.userId,
          organizationId: actor.organizationId,
          companyId: actor.companyId,
          resource: reportDatasetResource(ds.name),
          refusalCode: d.code,
          fieldNames: d.fields.map((f) => f.field),
          fieldClasses: d.fields.map((f) => f.class),
        });
      }
      throw refusalError(d);
    }
    const { total } = await reportDatasetsRepository.journalLines(filter, sort, { limit: 1, offset: 0 });
    if (total > DATASET_EXPORT_MAX_ROWS) {
      throw new BusinessRuleError(422, {
        code: "export_too_large",
        error: `This CSV would hold ${total} rows; the limit is ${DATASET_EXPORT_MAX_ROWS}. Narrow the dates or the account — an export is never cut short.`,
        errorAr: `سيحتوي هذا الملف على ${total} سطراً، والحد ${DATASET_EXPORT_MAX_ROWS}. ضيّق التواريخ أو الحساب — لا يُقتطع التصدير أبداً.`,
      });
    }
    const { rows } = await reportDatasetsRepository.journalLines(filter, sort, null);
    // A column the role may not read at all is ABSENT from the file; a conditional one stays, its cells marked per row.
    const inFile = d.columns.filter((c) => c.level === "read" || c.rowCondition != null);
    const absent = d.columns.filter((c) => !inFile.includes(c));
    const columns: ExportColumn[] = inFile.map((c) => ({
      label: { en: c.column.label, ar: c.column.labelAr },
      kind: c.column.kind,
      class: c.cls === "standard" ? "standard" : { cls: c.cls, resource: c.resource! },
    }));
    const fileRows: ExportRow[] = rows.map((r: JournalLineRow) => {
      const row = r as unknown as DatasetRow;
      const subjectTo: Record<number, boolean> = {};
      inFile.forEach((c, i) => { if (c.rowCondition) subjectTo[i] = rowConditionApplies(c.rowCondition, row); });
      return { kind: "row", cells: inFile.map((c) => (row[c.column.key] ?? null) as string | number | null), subjectTo };
    });
    const window = `${filter.dateFrom ?? "…"} – ${filter.dateTo ?? "…"}`;
    const doc: DatasetDocument = {
      title: { en: ds.title, ar: ds.titleAr },
      scope: { en: window, ar: window },
      tables: [{ columns, rows: fileRows }],
      notes: absent.length
        ? [{
            en: `Withheld for your role, and absent from this file: ${absent.map((c) => `${c.column.label} (${c.cls})`).join(", ")}.`,
            ar: `محجوب لدورك وغير موجود في هذا الملف: ${absent.map((c) => `${c.column.labelAr} (${c.cls})`).join("، ")}.`,
          }]
        : [],
      filenameStem: `journal-lines_${filter.dateFrom ?? "start"}_${filter.dateTo ?? "end"}`,
    };
    const params = Object.fromEntries(Object.entries(q).filter(([k]) => k !== "lang"));
    return exportDatasetCsv(doc, lang, readDecider, { dataset: ds.name, params });
  },
};
