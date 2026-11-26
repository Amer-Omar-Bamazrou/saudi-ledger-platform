/**
 * 🔴 19B 19.12 — GROUPING AND SUBTOTALS, pure (no database, no request).
 *
 * One grouping column, which the dataset declares (`groupable`) and `decide()` has already allowed for this role. The
 * totals are of the dataset's own `totals` columns, and only of those the request SHOWS.
 *
 *  - 🔴 WITHHOLDING COMES BEFORE ANY TOTAL (owner, 2026-11-26). A total is computed only for a column this role reads on
 *    every row (`level === "read"`, no row condition). Any other is listed in `withheldTotals` and its cells are never
 *    read — not summed and dropped, not summed and masked.
 *  - Sums are exact: integer halalas through the one money seam (`toHalalas`), never a float accumulation.
 *  - A row with no key is its own group, listed last. No rows gives no groups.
 *  - A set mixing currencies has no money total: the number would mean nothing.
 *  - A dataset with `grandTotal: false` (journal lines) has no grand total: across whole entries debits equal credits,
 *    so the total is twice the turnover or zero depending on the column (CLAUDE.md §3, "withhold a number that would
 *    mean nothing").
 */
import { fromHalalas, toHalalas } from "../money";
import type { DatasetColumn, DatasetDef, DatasetRow } from "./datasets";
import type { DecidedColumn } from "./decide";

export interface ColumnTotal { column: string; total: number }
export interface GroupTotals { count: number; totals: ColumnTotal[]; mixedCurrency: boolean }
export interface Group extends GroupTotals { key: string | null; label: string | null }
export interface Grouped {
  groupedBy: string;
  groups: Group[];
  /** null where the dataset has no meaningful grand total. */
  grandTotal: GroupTotals | null;
  /** The totals this role is not given: the column is shown but not read on every row. */
  withheldTotals: DecidedColumn[];
}

/** The group a row falls in: its value as text, a date's month, or null when the row has none. */
export function groupKeyOf(column: DatasetColumn, row: DatasetRow): string | null {
  const v = row[column.key];
  if (v == null || v === "") return null;
  return column.groupAs === "month" ? String(v).slice(0, 7) : String(v);
}

/** Orders group keys: numbers by value, text by code point, a missing key last. */
export function compareGroupKeys(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const na = Number(a), nb = Number(b);
  if (a.trim() !== "" && b.trim() !== "" && Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return a < b ? -1 : 1;
}

export function groupRows(ds: DatasetDef, groupKey: string, shown: readonly DecidedColumn[], rows: readonly DatasetRow[]): Grouped {
  const column = ds.columns.find((c) => c.key === groupKey);
  if (!column?.groupable) throw new Error(`dataset ${ds.name}: '${groupKey}' is not a grouping it offers`);
  const candidates = shown.filter((c) => ds.totals.includes(c.column.key));
  const totalled = candidates.filter((c) => c.level === "read" && c.rowCondition == null).map((c) => c.column.key);
  const withheldTotals = candidates.filter((c) => !totalled.includes(c.column.key));
  const hasCurrency = ds.columns.some((c) => c.key === "currency");

  type Acc = { count: number; halalas: number[]; currencies: Set<string>; label: string | null };
  const fresh = (): Acc => ({ count: 0, halalas: totalled.map(() => 0), currencies: new Set(), label: null });
  const add = (acc: Acc, row: DatasetRow) => {
    acc.count += 1;
    // 🔴 only the totalled columns are read; a withheld column's cell is never touched
    totalled.forEach((k, i) => { acc.halalas[i]! += toHalalas(row[k] as string | number | null | undefined); });
    if (hasCurrency && row.currency != null && row.currency !== "") acc.currencies.add(String(row.currency));
  };
  const out = (acc: Acc): GroupTotals => {
    const mixedCurrency = acc.currencies.size > 1;
    return { count: acc.count, totals: mixedCurrency ? [] : totalled.map((k, i) => ({ column: k, total: fromHalalas(acc.halalas[i]!) })), mixedCurrency };
  };

  const byKey = new Map<string | null, Acc>();
  const grand = fresh();
  for (const row of rows) {
    const key = groupKeyOf(column, row);
    let acc = byKey.get(key);
    if (!acc) {
      acc = fresh();
      const label = column.groupLabel ? row[column.groupLabel] : null;
      acc.label = label == null || label === "" ? null : String(label);
      byKey.set(key, acc);
    }
    add(acc, row);
    add(grand, row);
  }
  const groups = [...byKey.entries()].sort(([a], [b]) => compareGroupKeys(a, b)).map(([key, acc]) => ({ key, label: acc.label, ...out(acc) }));
  return { groupedBy: groupKey, groups, grandTotal: ds.grandTotal ? out(grand) : null, withheldTotals };
}
