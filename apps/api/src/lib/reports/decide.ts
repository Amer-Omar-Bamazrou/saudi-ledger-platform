/**
 * 🔴 19B S4 (v4 §4) — THE ONE QUESTION: `decide(has, dataset, act, use)`.
 *
 * Asked on the server for every dataset request; the screen only displays the answer. Pure over the role's grants
 * (`has(resource, action)` answers from the one matrix, as `requirePermission` does), so the role × act matrix is
 * tested exhaustively without a database. In order:
 *
 *  1. the dataset's `run` grant — without it, `report_dataset_not_granted`; then the act's own grant — without it,
 *     `report_act_not_granted`;
 *  2. `read` on every NATIVE resource — a dataset grant never widens a role beyond the data's own screens;
 *  3. every column a request names must exist (`report_unknown_column`, 400);
 *  4. a FILTER, a GROUPING or a SORT on a column the role may not read is REFUSED by name (`report_field_withheld`):
 *     filtering "salary > 20,000" reveals the value as surely as showing it;
 *  5. a grouping or a sort the dataset does not offer is refused (400);
 *  6. a SHOWN column the role may not read is WITHHELD — listed, and absent from every row (D4) — never blank or zero.
 *     A conditional class (the bank's text) is withheld on the rows it applies to only; the field its condition reads
 *     (the entry's source) is served beside it, so the response seam can apply the same condition to the same row.
 *
 * Every refusal names its rule, in English and Arabic.
 */
import { fieldGrantAction, reportDatasetResource, type ProtectedFieldClass, type ReportAct } from "@workspace/db";
import { columnClass, type DatasetColumn, type DatasetDef } from "./datasets";
import type { RowCondition } from "../fieldClasses/classTable";

export type Has = (resource: string, action: string) => boolean;
export type ColumnLevel = "read" | "last4" | "none";
export type UseKind = "filter" | "group" | "sort";
export interface Use { show: readonly string[]; filter: readonly string[]; group: readonly string[]; sort: readonly string[] }
export const NO_USE: Use = { show: [], filter: [], group: [], sort: [] };

export type RefusalCode =
  | "report_dataset_not_granted"
  | "report_act_not_granted"
  | "report_field_withheld"
  | "report_group_not_supported"
  | "report_unknown_column";

export interface DecidedColumn {
  column: DatasetColumn;
  cls: "standard" | ProtectedFieldClass;
  resource: string | null;
  level: ColumnLevel;
  /** The class applies on these rows only (the class table's rowConditions). */
  rowCondition?: RowCondition;
}

export type Decision =
  | { allowed: true; columns: DecidedColumn[]; withheld: DecidedColumn[] }
  | {
      allowed: false;
      status: 400 | 403;
      code: RefusalCode;
      error: string;
      errorAr: string;
      dataset: string;
      act: ReportAct;
      fields: { field: string; class: string; use: UseKind }[];
    };

const ACT_WORD: Record<ReportAct, [string, string]> = {
  run: ["run", "تشغيل"],
  export: ["export", "تصدير"],
  schedule: ["schedule", "جدولة"],
  deliver: ["deliver to others", "إرسال لآخرين"],
  save: ["save", "حفظ"],
  share: ["share", "مشاركة"],
};

/** The level a role reads a column at. `standard` is read with the dataset; a protected class needs its field grant. */
export function columnLevel(has: Has, ds: DatasetDef, column: DatasetColumn): DecidedColumn {
  const { cls, resource, rowCondition } = columnClass(ds, column.key);
  const cond = rowCondition ? { rowCondition } : {};
  if (cls === "standard") return { column, cls, resource, level: "read" };
  if (has(resource!, fieldGrantAction(cls, "read"))) return { column, cls, resource, level: "read", ...cond };
  if (cls === "bank_account" && has(resource!, fieldGrantAction(cls, "last4"))) return { column, cls, resource, level: "last4", ...cond };
  return { column, cls, resource, level: "none", ...cond };
}

export function decide(has: Has, ds: DatasetDef, act: ReportAct, use: Use): Decision {
  const refuse = (status: 400 | 403, code: RefusalCode, error: string, errorAr: string, fields: { field: string; class: string; use: UseKind }[] = []): Decision =>
    ({ allowed: false, status, code, error, errorAr, dataset: ds.name, act, fields });
  const resource = reportDatasetResource(ds.name);
  const [en, ar] = ACT_WORD[act];

  // 1–2. the dataset, the act, the native resources
  if (!has(resource, "run") || !ds.native.every((n) => has(n, "read"))) {
    return refuse(403, "report_dataset_not_granted",
      `Your role cannot use the ${ds.title} report data. An admin can change your role in User Management.`,
      `دورك لا يسمح باستخدام بيانات تقرير «${ds.titleAr}». يمكن لمسؤول النظام تغيير دورك من إدارة المستخدمين.`);
  }
  if (act !== "run" && !has(resource, act)) {
    return refuse(403, "report_act_not_granted",
      `Your role can run the ${ds.title} report but cannot ${en} it. An admin can change your role in User Management.`,
      `دورك يسمح بتشغيل تقرير «${ds.titleAr}» ولا يسمح بـ${ar}. يمكن لمسؤول النظام تغيير دورك من إدارة المستخدمين.`);
  }

  // 3. every named column exists
  const byKey = new Map(ds.columns.map((c) => [c.key, c]));
  const named = [...use.show, ...use.filter, ...use.group, ...use.sort];
  const unknown = [...new Set(named.filter((k) => !byKey.has(k)))];
  if (unknown.length) {
    return refuse(400, "report_unknown_column",
      `The ${ds.title} report has no column ${unknown.join(", ")}.`,
      `لا يحتوي تقرير «${ds.titleAr}» على العمود: ${unknown.join("، ")}.`);
  }

  // 4. a use of a column the role may not read is refused by name
  const levels = new Map(ds.columns.map((c) => [c.key, columnLevel(has, ds, c)]));
  const withheldUses: { field: string; class: string; use: UseKind }[] = [];
  for (const kind of ["filter", "group", "sort"] as const) {
    for (const k of new Set(use[kind])) {
      const d = levels.get(k)!;
      if (d.level !== "read") withheldUses.push({ field: k, class: d.cls, use: kind });
    }
  }
  if (withheldUses.length) {
    const names = withheldUses.map((w) => w.field).join(", ");
    const classes = [...new Set(withheldUses.map((w) => w.class))].join(", ");
    return refuse(403, "report_field_withheld",
      `Your role cannot read ${names} (it needs the ${classes} permission), so it cannot filter, group or sort by it either. Nothing was run.`,
      `دورك لا يسمح بقراءة ${names}، لذا لا يمكنه التصفية أو التجميع أو الترتيب بها. لم يُشغَّل شيء.`,
      withheldUses);
  }

  // 5. a grouping or sort the dataset does not offer
  const notGroupable = [...new Set(use.group)].filter((k) => !byKey.get(k)!.groupable);
  if (notGroupable.length) {
    return refuse(400, "report_group_not_supported",
      `The ${ds.title} report cannot be grouped by ${notGroupable.join(", ")}.`,
      `لا يمكن تجميع تقرير «${ds.titleAr}» حسب: ${notGroupable.join("، ")}.`);
  }
  // 19.12: ONE grouping. Two would need totals at two levels, which no screen or file shows.
  if (new Set(use.group).size > 1) {
    return refuse(400, "report_group_not_supported",
      `The ${ds.title} report can be grouped by one column at a time.`,
      `يمكن تجميع تقرير «${ds.titleAr}» حسب عمود واحد في كل مرة.`);
  }
  const notSortable = [...new Set(use.sort)].filter((k) => !byKey.get(k)!.sortable);
  if (notSortable.length) {
    return refuse(400, "report_unknown_column",
      `The ${ds.title} report cannot be sorted by ${notSortable.join(", ")}.`,
      `لا يمكن ترتيب تقرير «${ds.titleAr}» حسب: ${notSortable.join("، ")}.`);
  }

  // 6. the shown columns, each at its level
  const keys = use.show.length ? [...new Set(use.show)] : ds.columns.map((c) => c.key);
  // a conditional column withheld on some rows brings the field its condition reads (standard), so every reader of the
  // response — the seam included — can tell which rows it applies to
  for (const k of [...keys]) {
    const by = levels.get(k)!.rowCondition?.by;
    if (by && levels.get(k)!.level !== "read" && !keys.includes(by)) keys.push(by);
  }
  const shown = keys.map((k) => levels.get(k)!);
  return { allowed: true, columns: shown, withheld: shown.filter((c) => c.level !== "read") };
}
