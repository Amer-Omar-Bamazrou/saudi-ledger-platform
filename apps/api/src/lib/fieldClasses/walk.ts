/**
 * 🔴 19B S1 (v4 §4) — the walk: one served JSON value against its contract shape, each key classified by the class
 * table, each protected field decided by the reader's grants.
 *
 *  - A key whose class the reader may `read` is served as it is; `last4` (an IBAN) is served as `•••• 1234`; `none`
 *    REMOVES the key — never a null, never a zero (D4) — and records `{ path, class, level }` in `withheld`.
 *  - A key the table cannot classify (an undeclared key, a field with no row) is listed in `unclassified`. The seam
 *    decides what that means (seam.ts): the test lane fails; production serves it and logs it in S1.
 *  - Nothing is copied unless something is withheld: an object or list is copied only on the path to a change, so the
 *    walk is one linear read of the value when every class is granted (S1's state) — the performance budget's basis.
 */
import type { ProtectedFieldClass } from "@workspace/db";
import type { FieldClass } from "./classTable";
import { hasLeaf, isContainer, isPlainObject, resolve, type Shape } from "./shapes";

export type ReadLevel = "read" | "last4" | "none";

/** What the reader may see of a protected class on a resource. */
export type ReadDecider = (cls: ProtectedFieldClass, resource: string) => ReadLevel;

/**
 * The class table's answer for one field: its class and the resource whose grants govern it — and, 19B S3, the rule that
 * picks the resource per row from one of the row's own fields (classTable.ts, NodeClasses.rowResource).
 */
export type FieldLookup = (node: string, field: string) => { cls: FieldClass; resource: string | null; rowResource?: { by: string; resources: Record<string, string> } } | undefined;

export interface Withheld {
  /** Where in the value: `items[].iban`, `customer.nationalId`, `$` for the whole value. */
  path: string;
  class: ProtectedFieldClass;
  level: "none" | "last4";
}

export interface WalkResult {
  value: unknown;
  withheld: Withheld[];
  /** `node.field` keys the table cannot classify, each once. */
  unclassified: string[];
}

type ObjNode = Extract<Shape, { k: "obj" }>;

// isPlainObject: one definition (shapes.ts) — a Date is one value, never an object to walk into.
const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/**
 * What a shape offers a value of each kind, computed once per shape: the shapes are the contract's constants, so the
 * walk asks each question once per shape, not once per served key.
 */
interface Offer {
  nodes: ObjNode[];
  maps: Shape[];
  /** The item shape a list is walked with, or null when its items are plain values. */
  item: Shape | null;
  container: boolean;
  leaf: boolean;
}
const offers = new WeakMap<Record<string, Shape>, WeakMap<Shape, Offer>>();

function collectObjects(shape: Shape, components: Record<string, Shape>, nodes: ObjNode[], maps: Shape[]): void {
  const s = resolve(shape, components);
  if (s.k === "obj") nodes.push(s);
  else if (s.k === "map") maps.push(s.v);
  else if (s.k === "union") for (const o of s.o) collectObjects(o, components, nodes, maps);
}
function collectItems(shape: Shape, components: Record<string, Shape>): Shape[] {
  const s = resolve(shape, components);
  if (s.k === "arr") return [s.i];
  if (s.k === "union") return s.o.flatMap((o) => collectItems(o, components));
  return [];
}
function offerOf(shape: Shape, components: Record<string, Shape>): Offer {
  let byShape = offers.get(components);
  if (!byShape) offers.set(components, (byShape = new WeakMap()));
  let o = byShape.get(shape);
  if (!o) {
    const nodes: ObjNode[] = [];
    const maps: Shape[] = [];
    collectObjects(shape, components, nodes, maps);
    const item = collectItems(shape, components).find((i) => isContainer(i, components)) ?? null;
    o = { nodes, maps, item, container: isContainer(shape, components), leaf: hasLeaf(shape, components) };
    byShape.set(shape, o);
  }
  return o;
}

/** `•••• 1234` — the last four characters of the value without spaces. The response marks it partial (`withheld`). */
export function lastFour(value: string): string {
  return `•••• ${value.replace(/\s+/g, "").slice(-4)}`;
}

const REMOVE = Symbol("withheld");

export function walkValue(
  shape: Shape,
  value: unknown,
  rootNode: string,
  lookup: FieldLookup,
  decide: ReadDecider,
  components: Record<string, Shape>,
): WalkResult {
  const withheld: Withheld[] = [];
  const unclassified = new Set<string>();

  const decideLeaf = (node: string, field: string, v: unknown, path: string, row?: Record<string, unknown>): unknown => {
    const spec = lookup(node, field);
    if (!spec) {
      unclassified.add(`${node}.${field}`);
      return v;
    }
    const { cls } = spec;
    // 🔴 19B S3: a per-row resource — the row's own field picks whose grants decide (an employee's held IBAN: employees).
    const resource = spec.rowResource && row ? (spec.rowResource.resources[String(row[spec.rowResource.by])] ?? spec.resource) : spec.resource;
    if (cls === "standard" || cls === "by_entity") return v; // by_entity: each key by the audited entity's node (S2c)
    if (!resource) throw new Error(`class table: ${node}.${field} is ${cls} but its node names no resource`);
    const level = decide(cls, resource);
    if (level === "read") return v;
    if (level === "last4" && cls === "bank_account") {
      if (v === null) return v; // no IBAN: there is nothing to mask
      if (typeof v === "string") {
        withheld.push({ path, class: cls, level: "last4" });
        return lastFour(v);
      }
    }
    withheld.push({ path, class: cls, level: "none" });
    return REMOVE;
  };

  /** A field's value: walked into when the contract gives it structure of the value's own kind, else ONE value. */
  const visitField = (node: string, field: string, ps: Shape, v: unknown, path: string, row?: Record<string, unknown>): unknown => {
    const offer = offerOf(ps, components);
    // A null where the contract allows a plain value is that value's answer (classified); a null object serves nothing.
    if (v === null || v === undefined) return offer.leaf ? decideLeaf(node, field, v, path, row) : v;
    if (Array.isArray(v) ? offer.item !== null : isPlainObject(v) && (offer.nodes.length > 0 || offer.maps.length > 0)) return visit(ps, v, path, node, field);
    return decideLeaf(node, field, v, path, row);
  };

  const visit = (sh: Shape, v: unknown, path: string, node: string, field: string): unknown => {
    const offer = offerOf(sh, components);
    if (Array.isArray(v)) {
      const item = offer.item;
      if (!item) return decideLeaf(node, field, v, path);
      let out: unknown[] | null = null;
      for (let i = 0; i < v.length; i++) {
        const next = visitField(node, field, item, v[i], `${path}[]`);
        if (next === REMOVE) throw new Error(`walk: a list item at ${path}[] cannot be withheld alone`);
        if (next !== v[i]) (out ??= v.slice())[i] = next;
      }
      return out ?? v;
    }
    if (!isPlainObject(v)) return decideLeaf(node, field, v, path);
    const { nodes, maps } = offer;
    if (!nodes.length && !maps.length) return decideLeaf(node, field, v, path);
    const dynamic = nodes.find((n) => n.ap);
    let out: Record<string, unknown> | null = null;
    for (const key of Object.keys(v)) {
      const child = v[key];
      const childPath = path ? `${path}.${key}` : key;
      const owner = nodes.find((n) => own(n.p, key));
      let next: unknown;
      if (owner) next = visitField(owner.n, key, owner.p[key]!, child, childPath, v);
      else if (dynamic) next = visitField(dynamic.n, "*", dynamic.ap!, child, childPath, v);
      else if (maps.length) next = visitField(node, field, maps[0]!, child, childPath);
      // A key the contract does not declare: classified only by an explicit row (SERVED_BEYOND_CONTRACT), else unclassified.
      else next = decideLeaf(nodes[0]!.n, key, child, childPath, v);
      if (next === REMOVE) {
        out ??= { ...v };
        delete out[key];
      } else if (next !== child) (out ??= { ...v })[key] = next;
    }
    return out ?? v;
  };

  let out: unknown;
  if (value === null || value === undefined) out = value;
  else out = visit(shape, value, "", rootNode, "$");
  if (out === REMOVE) out = null; // the whole value withheld: recorded at `$`
  return { value: out, withheld, unclassified: [...unclassified] };
}
