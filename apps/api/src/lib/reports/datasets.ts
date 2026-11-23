/**
 * 🔴 19B S4 (v4 §4, §14) — THE REPORT DATASETS: vetted code, reviewed and tested, never rows a user writes.
 *
 * Each dataset names its NATIVE resources (the grants that guard the same data's own screens — a dataset never widens a
 * role beyond them), its columns, and the contract node its rows are. 🔴 A column's CLASS is not declared here: it is the
 * class table's, for that node and field (`columnClass`), so there is one definition of what a column is
 * (tests/s4-report-decide.test.ts fails when a column is not a field of its node, or a field is not a column).
 * A conditional class (the bank's text only on a line built from a bank line) is the class table's too (`rowConditions`):
 * the dataset only names it for the reader (`conditionLabel`).
 */
import type { ProtectedFieldClass } from "@workspace/db";
import { fieldSpec, type RowCondition } from "../fieldClasses/classTable";

export type ColumnKind = "text" | "money" | "date" | "int";
export type DatasetRow = Record<string, unknown>;

export interface DatasetColumn {
  key: string;
  label: string;
  labelAr: string;
  kind: ColumnKind;
  filterable: boolean;
  sortable: boolean;
  groupable?: boolean;
  /** When the column's protected class applies to SOME rows only (the class table's rowConditions): which, in words. */
  conditionLabel?: { label: string; labelAr: string };
}

export interface DatasetDef {
  name: string;
  title: string;
  titleAr: string;
  /** The contract node a row is — the class table classifies its fields. */
  node: string;
  native: readonly string[];
  columns: readonly DatasetColumn[];
  /** Query parameter → the column it filters on (a filter is a USE of that column). */
  filters: Readonly<Record<string, string>>;
}

const text = (key: string, label: string, labelAr: string, opts: Partial<DatasetColumn> = {}): DatasetColumn =>
  ({ key, label, labelAr, kind: "text", filterable: false, sortable: false, ...opts });

/** Journal lines in the books (posted and reversed entries), in the request's company. A viewer dataset (D3). */
export const JOURNAL_LINES: DatasetDef = {
  name: "journal_lines",
  title: "Journal lines",
  titleAr: "سطور القيود",
  node: "JournalLinesDatasetRow",
  native: ["journal_entries"],
  columns: [
    text("lineId", "Line", "السطر", { kind: "int" }),
    text("date", "Date", "التاريخ", { kind: "date", filterable: true, sortable: true }),
    text("entryNumber", "Entry", "رقم القيد", { sortable: true }),
    text("status", "Status", "الحالة"),
    text("sourceType", "Source", "المصدر", { filterable: true }),
    text("reference", "Reference", "المرجع"),
    text("accountId", "Account id", "معرّف الحساب", { kind: "int", filterable: true }),
    text("accountCode", "Account code", "رمز الحساب", { sortable: true }),
    text("accountName", "Account", "الحساب"),
    text("accountNameAr", "Account (Arabic)", "الحساب بالعربية"),
    text("description", "Line text", "نص السطر", {
      conditionLabel: { label: "lines built from a bank line, or of unknown origin", labelAr: "السطور المبنية على سطر كشف بنكي، أو مجهولة المصدر" },
    }),
    text("debit", "Debit", "مدين", { kind: "money", sortable: true }),
    text("credit", "Credit", "دائن", { kind: "money", sortable: true }),
  ],
  filters: { date_from: "date", date_to: "date", account_id: "accountId", source_type: "sourceType" },
};

export const DATASETS: Readonly<Record<string, DatasetDef>> = { journal_lines: JOURNAL_LINES };

/** A column's class and the resource whose field grants decide it — from the class table, the one definition. */
export function columnClass(ds: DatasetDef, key: string): { cls: "standard" | ProtectedFieldClass; resource: string | null; rowCondition?: RowCondition } {
  const spec = fieldSpec(ds.node, key);
  if (!spec) throw new Error(`dataset ${ds.name}: column '${key}' is not a field of ${ds.node} in the class table`);
  if (spec.cls === "by_entity") throw new Error(`dataset ${ds.name}: column '${key}' is by_entity — a dataset column has one class`);
  return { cls: spec.cls, resource: spec.cls === "standard" ? null : spec.resource, ...(spec.rowCondition ? { rowCondition: spec.rowCondition } : {}) };
}
