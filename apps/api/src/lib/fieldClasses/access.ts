/**
 * 🔴 19B S2a (v4 §4) — WHAT A ROLE MAY DO WITH EACH FIELD OF ONE KIND OF RECORD, from the one class table and the one
 * matrix: the read level the seam would apply, and whether the write check would admit a write. A page asks this
 * (`GET /employees/field-access`, `GET /payroll/field-access`) to offer only the fields the role may write and to mark
 * the ones it may not read — it never re-derives the rules. It never returns a field's value.
 */
import { fieldGrantAction, type ProtectedFieldClass } from "@workspace/db";
import { fieldSpec, FIELD_CLASS_TABLE, indexTable, type FieldClass } from "./classTable";
import { deciderFor } from "./seam";
import type { ReadLevel } from "./walk";

export type FieldAccessRecord = "employees" | "payroll";

/**
 * Each record's node that is READ (the response), the node that is WRITTEN (the body), and the resource whose
 * `update` grant writing it needs at all — a field is writable only by a role that may change the record.
 */
const RECORD_NODES: Record<FieldAccessRecord, { read: string; write: string | null; resource: string }> = {
  employees: { read: "Employee", write: "EmployeeInputFields", resource: "employees" },
  payroll: { read: "PayrollItem", write: null, resource: "payroll" },
};

export interface FieldAccessEntry {
  class: FieldClass;
  read: ReadLevel;
  write: boolean;
}

const permKey = (role: string, resource: string, action: string) => `${role}:${resource}:${action}`;

export function fieldAccess(record: FieldAccessRecord, role: string, grants: ReadonlySet<string> | null): { record: FieldAccessRecord; fields: Record<string, FieldAccessEntry> } {
  const nodes = RECORD_NODES[record];
  const index = indexTable(FIELD_CLASS_TABLE);
  const readFields = index.get(nodes.read) ?? new Map();
  const writeFields = nodes.write ? (index.get(nodes.write) ?? new Map()) : new Map();
  const decide = deciderFor(role, grants);
  const has = (resource: string, cls: ProtectedFieldClass) => !!grants?.has(permKey(role, resource, fieldGrantAction(cls, "write")));
  const fields: Record<string, FieldAccessEntry> = {};
  const recordWritable = !!grants?.has(permKey(role, nodes.resource, "update"));
  for (const field of new Set([...readFields.keys(), ...writeFields.keys()])) {
    const r = fieldSpec(nodes.read, field);
    const w = nodes.write ? fieldSpec(nodes.write, field) : undefined;
    const cls = (r ?? w)!.cls;
    const read: ReadLevel = !r ? "none" : r.cls === "standard" || r.cls === "by_entity" ? "read" : decide(r.cls, r.resource!);
    let write = false;
    if (w && recordWritable) {
      const needs = new Set<ProtectedFieldClass>(w.writeAlsoNeeds);
      if (w.cls !== "standard" && w.cls !== "by_entity") needs.add(w.cls);
      write = [...needs].every((c) => has(w.resource!, c));
    }
    fields[field] = { class: cls, read, write };
  }
  return { record, fields };
}
