/**
 * 🔴 19B S1 (v4 §4) — THE FIELD-LEVEL WRITE CHECK, at the write boundary: a request body that sets a protected field
 * needs `field.<class>.write` on the field's resource (and on every class its row's `writeAlsoNeeds` names). Writing a
 * field the role may not write is REFUSED BY NAME — 403 `field_write_not_granted`, naming each field and class —
 * never silently dropped, so a form can never appear to save what it did not.
 *
 * Runs inside `requirePermission`, after the route's own grant passed (lib/rbac.ts) — every business route carries that
 * guard (tests/privilege-surface-map.test.ts), so no route writes around it. Only fields the CONTRACT declares for the
 * operation's body are checked: a key the contract does not declare is the route's own validation's to refuse.
 *
 * 🔴 S1: every role holds every class's write grant, so nothing is refused. (D6's refusal event for a refused field
 * write arrives with the refusal-event table, S4; until a removal switches a class on, no write can be refused.)
 */
import type { ProtectedFieldClass } from "@workspace/db";
import { fieldGrantAction } from "@workspace/db";
import { CONTRACT } from "./contractShapes.generated";
import { fieldSpec } from "./classTable";
import { apiPath, findOperation } from "./operations";
import { resolve, isContainer, isPlainObject, type Shape } from "./shapes";

export interface FieldWriteRefusal {
  code: "field_write_not_granted";
  error: string;
  errorAr: string;
  fields: { field: string; class: ProtectedFieldClass; resource: string }[];
}

// isPlainObject: one definition (shapes.ts) — a Date is one value, never an object to walk into.

/** Every declared field a body sets: `{ node, field, path }`, walking its contract shape. */
export function fieldsWritten(shape: Shape, body: unknown, components: Record<string, Shape>): { node: string; field: string; path: string }[] {
  const out: { node: string; field: string; path: string }[] = [];
  const visit = (sh: Shape, v: unknown, path: string): void => {
    const s = resolve(sh, components);
    if (Array.isArray(v)) {
      const items = s.k === "arr" ? [s.i] : s.k === "union" ? s.o.map((o) => resolve(o, components)).filter((o) => o.k === "arr").map((o) => (o as { i: Shape }).i) : [];
      const item = items.find((i) => isContainer(i, components));
      if (item) for (const x of v) visit(item, x, `${path}[]`);
      return;
    }
    if (!isPlainObject(v)) return;
    const nodes = s.k === "obj" ? [s] : s.k === "union" ? s.o.map((o) => resolve(o, components)).filter((o): o is Extract<Shape, { k: "obj" }> => o.k === "obj") : [];
    for (const [key, child] of Object.entries(v)) {
      const owner = nodes.find((n) => Object.prototype.hasOwnProperty.call(n.p, key));
      if (!owner) continue; // undeclared: the route's own validation decides
      const ps = owner.p[key]!;
      const childPath = path ? `${path}.${key}` : key;
      if ((isPlainObject(child) || Array.isArray(child)) && isContainer(ps, components)) visit(ps, child, childPath);
      else out.push({ node: owner.n, field: key, path: childPath });
    }
  };
  visit(shape, body, "");
  return out;
}

/** The refusal for a body the role may not write, or null. `has(resource, action)` answers from the role's grants. */
export function fieldWriteRefusal(method: string, originalUrl: string, body: unknown, has: (resource: string, action: string) => boolean): FieldWriteRefusal | null {
  if (method === "GET" || method === "HEAD" || body === undefined || body === null) return null;
  const op = findOperation(method, apiPath(originalUrl));
  if (!op?.body) return null;
  const missing: FieldWriteRefusal["fields"] = [];
  for (const { node, field, path } of fieldsWritten(op.body, body, CONTRACT.components)) {
    const spec = fieldSpec(node, field);
    if (!spec || !spec.resource) continue; // standard (or by_entity, which no body writes)
    const needs = new Set<ProtectedFieldClass>(spec.writeAlsoNeeds);
    if (spec.cls !== "standard" && spec.cls !== "by_entity") needs.add(spec.cls);
    for (const cls of needs) if (!has(spec.resource, fieldGrantAction(cls, "write"))) missing.push({ field: path, class: cls, resource: spec.resource });
  }
  if (!missing.length) return null;
  const names = [...new Set(missing.map((m) => m.field))].join(", ");
  const classes = [...new Set(missing.map((m) => m.class))].join(", ");
  return {
    code: "field_write_not_granted",
    error: `Your role cannot change ${names} (it needs the ${classes} permission). Nothing was saved. An admin can change your role in User Management.`,
    errorAr: `دورك لا يسمح بتغيير هذه الحقول: ${names}. لم يُحفظ شيء. يمكن لمسؤول النظام تغيير دورك من إدارة المستخدمين.`,
    fields: missing,
  };
}
