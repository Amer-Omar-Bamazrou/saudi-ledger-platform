/**
 * 🔴 19B S4 (v4 §4, §6.2, §14; control 19B-S4) — `decide()`, the report question, without a database.
 *
 *  - THE ROLE × ACT MATRIX, generated from PERMISSION_MATRIX (both directions): for every role, dataset and act, decide
 *    allows exactly when the matrix grants the dataset's run, the act, and read on every native resource — and the
 *    grants are v4 §6.2's, stated here as well (a viewer: run, export, schedule, save; never deliver or share).
 *  - A dataset never widens a role: without read on a native resource, it is refused.
 *  - ONE definition of a column's class: every column is a field of its class-table node, and every field a column.
 *  - USES: a shown column the role may not read is withheld; a sort or a grouping on it is refused BY NAME; a grouping
 *    the dataset does not offer, and an unknown column, are refused. Every refusal speaks Arabic as well.
 */
import { describe, expect, it } from "vitest";
import { PERMISSION_MATRIX, REPORT_ACTS, reportDatasetResource, type PermissionRow } from "@workspace/db";
import { DATASETS, JOURNAL_LINES, type DatasetDef } from "../lib/reports/datasets";
import { decide, NO_USE, type Has } from "../lib/reports/decide";
import { FIELD_CLASS_TABLE } from "../lib/fieldClasses/classTable";

const ROLES = ["admin", "accountant", "bookkeeper", "viewer"] as const;
const hasFrom = (rows: readonly PermissionRow[], role: string): Has => {
  const set = new Set(rows.filter((r) => r.role === role).map((r) => `${r.resource}:${r.action}`));
  return (resource, action) => set.has(`${resource}:${action}`);
};
const without = (pred: (r: PermissionRow) => boolean) => PERMISSION_MATRIX.filter((r) => !pred(r));
const noViewerBankText = without((r) => r.role === "viewer" && r.resource === "journal_entries" && r.action === "field.bank_narrative.read");

describe("19B S4 — decide(): the role × act matrix, generated from the one matrix", () => {
  it("🔴 for every role, dataset and act, decide allows exactly when the matrix grants it (both directions)", () => {
    const cases: string[] = [];
    for (const role of ROLES) {
      const has = hasFrom(PERMISSION_MATRIX, role);
      for (const ds of Object.values(DATASETS)) {
        const res = reportDatasetResource(ds.name);
        for (const act of REPORT_ACTS) {
          const expected = has(res, "run") && has(res, act) && ds.native.every((n) => has(n, "read"));
          const d = decide(has, ds, act, NO_USE);
          if (d.allowed !== expected) cases.push(`${role} ${ds.name} ${act}: decide ${d.allowed}, matrix ${expected}`);
        }
      }
    }
    expect(cases).toEqual([]);
    expect(Object.keys(DATASETS).length * ROLES.length * REPORT_ACTS.length).toBe(24); // the frame: 1 dataset × 4 roles × 6 acts
  });

  it("🔴 the grants are v4 §6.2's: a viewer runs, exports, schedules and saves — never delivers to others or shares", () => {
    const allowed = (role: string) => REPORT_ACTS.filter((a) => decide(hasFrom(PERMISSION_MATRIX, role), JOURNAL_LINES, a, NO_USE).allowed);
    expect(allowed("viewer")).toEqual(["run", "export", "schedule", "save"]);
    for (const role of ["bookkeeper", "accountant", "admin"]) expect([role, allowed(role)]).toEqual([role, [...REPORT_ACTS]]);
    const d = decide(hasFrom(PERMISSION_MATRIX, "viewer"), JOURNAL_LINES, "deliver", NO_USE);
    expect(d.allowed ? null : [d.status, d.code]).toEqual([403, "report_act_not_granted"]);
    expect(d.allowed ? "" : d.errorAr).toMatch(/[؀-ۿ]/);
  });

  it("🔴 no run grant: every act is report_dataset_not_granted; and a dataset never widens a role beyond its native resource", () => {
    const noRun = hasFrom(without((r) => r.resource === reportDatasetResource("journal_lines") && r.action === "run"), "admin");
    for (const act of REPORT_ACTS) {
      const d = decide(noRun, JOURNAL_LINES, act, NO_USE);
      expect([act, d.allowed ? "allowed" : d.code]).toEqual([act, "report_dataset_not_granted"]);
    }
    const noNative = hasFrom(without((r) => r.role === "viewer" && r.resource === "journal_entries" && r.action === "read"), "viewer");
    expect(noNative(reportDatasetResource("journal_lines"), "run")).toBe(true); // the dataset grant is there…
    const d = decide(noNative, JOURNAL_LINES, "run", NO_USE);
    expect(d.allowed ? "allowed" : d.code).toBe("report_dataset_not_granted"); // …and does not widen
  });
});

describe("19B S4 — a column's class is the class table's (one definition)", () => {
  it("🔴 every dataset column is a field of its node, every field of the node is a column, and every filter reads a filterable column", () => {
    for (const ds of Object.values(DATASETS)) {
      const entry = (FIELD_CLASS_TABLE as Record<string, Record<string, unknown>>)[ds.node];
      expect(entry, `${ds.node} is in the class table`).toBeTruthy();
      const fields = Object.entries(entry!)
        .filter(([k, v]) => typeof v === "string" && !["resource"].includes(k))
        .flatMap(([, v]) => (v as string).split(/\s+/).filter(Boolean))
        .sort();
      expect([ds.name, ds.columns.map((c) => c.key).sort()]).toEqual([ds.name, fields]);
      for (const [param, col] of Object.entries(ds.filters)) expect([param, ds.columns.find((c) => c.key === col)?.filterable]).toEqual([param, true]);
    }
  });
});

describe("19B S4 — decide(): uses", () => {
  const viewer = hasFrom(noViewerBankText, "viewer");

  it("control: with the grant, every column is read and nothing is withheld", () => {
    const d = decide(hasFrom(PERMISSION_MATRIX, "viewer"), JOURNAL_LINES, "run", { ...NO_USE, sort: ["date"] });
    expect(d.allowed && d.withheld.map((c) => c.column.key)).toEqual([]);
  });

  it("🔴 a SHOWN column the role may not read comes back withheld, listed — not refused, not blank", () => {
    const d = decide(viewer, JOURNAL_LINES, "run", { ...NO_USE, show: ["date", "description", "debit"] });
    expect(d.allowed).toBe(true);
    if (!d.allowed) return;
    // the source, which decides on which rows the line text is bank text, is served beside it (the seam applies the same row condition)
    expect(d.columns.map((c) => [c.column.key, c.level])).toEqual([["date", "read"], ["description", "none"], ["debit", "read"], ["sourceType", "read"]]);
    expect(d.withheld.map((c) => [c.column.key, c.cls])).toEqual([["description", "bank_narrative"]]);
  });

  it("🔴 a SORT on a column the role may not read is refused by name, with its class and use", () => {
    const d = decide(viewer, JOURNAL_LINES, "run", { ...NO_USE, sort: ["description"] });
    expect(d.allowed ? null : [d.status, d.code, d.fields]).toEqual([403, "report_field_withheld", [{ field: "description", class: "bank_narrative", use: "sort" }]]);
    expect(d.allowed ? "" : d.errorAr).toMatch(/[؀-ۿ]/);
  });

  it("🔴 a GROUPING on a withheld column is refused by name; a grouping the dataset does not offer is refused 400", () => {
    // a synthetic dataset that offers grouping, over the same node — the group branch, which journal_lines does not offer
    const grouped: DatasetDef = { ...JOURNAL_LINES, name: "journal_lines", columns: JOURNAL_LINES.columns.map((c) => ({ ...c, groupable: c.key === "description" || c.key === "accountName" })) };
    const refused = decide(viewer, grouped, "run", { ...NO_USE, group: ["description"] });
    expect(refused.allowed ? null : [refused.code, refused.fields]).toEqual(["report_field_withheld", [{ field: "description", class: "bank_narrative", use: "group" }]]);
    expect(decide(viewer, grouped, "run", { ...NO_USE, group: ["accountName"] }).allowed).toBe(true);
    const real = decide(viewer, JOURNAL_LINES, "run", { ...NO_USE, group: ["accountName"] });
    expect(real.allowed ? null : [real.status, real.code]).toEqual([400, "report_group_not_supported"]);
  });

  it("an unknown column, and a sort the dataset does not offer, are refused 400", () => {
    const unknown = decide(viewer, JOURNAL_LINES, "run", { ...NO_USE, show: ["salary"] });
    expect(unknown.allowed ? null : [unknown.status, unknown.code]).toEqual([400, "report_unknown_column"]);
    const unsortable = decide(viewer, JOURNAL_LINES, "run", { ...NO_USE, sort: ["status"] });
    expect(unsortable.allowed ? null : [unsortable.status, unsortable.code]).toEqual([400, "report_unknown_column"]);
  });
});
