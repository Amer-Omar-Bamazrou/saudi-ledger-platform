/**
 * 🔴 19B S1 — the contract's structure as named nodes (generated into `contractShapes.generated.ts` from openapi.yaml
 * by packages/api-spec/scripts/contract-shapes.mjs), and the two questions the class table and the seam ask of it:
 * which fields exist (`contractFields`), and whether a value under a shape is walked into or classified as one value
 * (`isContainer`).
 */
export type Shape =
  | { k: "leaf" }
  | { k: "ref"; n: string }
  | { k: "obj"; n: string; p: Record<string, Shape>; ap?: Shape }
  | { k: "arr"; i: Shape }
  | { k: "map"; v: Shape }
  | { k: "union"; o: Shape[] };

export interface ContractOperation {
  method: string;
  /** The contract's path template, e.g. `/employees/{id}` (served under `/api`). */
  path: string;
  operationId: string;
  /** JSON 2xx responses by status. */
  responses: Record<string, Shape>;
  /** Non-JSON 2xx content types by status (files: CSV, PDF, images). */
  other: Record<string, string[]>;
  /** The JSON request body, if any. */
  body: Shape | null;
}

export interface ContractShapes {
  components: Record<string, Shape>;
  operations: ContractOperation[];
}

/** Follows a ref to its component (one level; components never alias each other here, and a cycle would be caught). */
/**
 * A JSON object as a handler builds it. NOT a Date, a Buffer or a class instance: those serialise to ONE value (a Date
 * to its ISO string), so they are classified as one value — walking into a Date finds no keys and would serve it
 * unclassified, and never withhold it.
 */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

export function resolve(shape: Shape, components: Record<string, Shape>): Shape {
  let s = shape;
  for (let i = 0; s.k === "ref"; i++) {
    if (i > 16) throw new Error(`ref cycle at ${shape.k === "ref" ? shape.n : "?"}`);
    const next = components[s.n];
    if (!next) throw new Error(`the contract has no component '${s.n}'`);
    s = next;
  }
  return s;
}

/** True when a value under this shape is walked into (it has named fields), false when it is ONE value with one class. */
export function isContainer(shape: Shape, components: Record<string, Shape>, seen: Set<string> = new Set()): boolean {
  switch (shape.k) {
    case "ref":
      if (seen.has(shape.n)) return true;
      seen.add(shape.n);
      return isContainer(resolve(shape, components), components, seen);
    case "obj":
      return true;
    case "arr":
      return isContainer(shape.i, components, seen);
    case "map":
      return isContainer(shape.v, components, seen);
    case "union":
      return shape.o.some((o) => isContainer(o, components, seen));
    default:
      return false;
  }
}

/** True when some branch of the shape is a plain value (a union of a value and an object is both). */
export function hasLeaf(shape: Shape, components: Record<string, Shape>): boolean {
  const s = resolve(shape, components);
  if (s.k === "union") return s.o.some((o) => hasLeaf(o, components));
  return !isContainer(s, components);
}

export interface ContractField {
  node: string;
  field: string;
}

/**
 * Every classifiable field of the contract: a property holding a plain value (or a list or map of plain values) on a
 * named node, the dynamic key `*` of a map-like node, and `$` for an operation whose whole response or body is one
 * value. Each node is listed once, however many operations reach it.
 */
export function contractFields(contract: ContractShapes): ContractField[] {
  const { components } = contract;
  const out: ContractField[] = [];
  const seen = new Set<string>();
  const visit = (shape: Shape): void => {
    switch (shape.k) {
      case "ref": {
        if (seen.has(`ref:${shape.n}`)) return;
        seen.add(`ref:${shape.n}`);
        visit(resolve(shape, components));
        return;
      }
      case "obj": {
        if (seen.has(shape.n)) return;
        seen.add(shape.n);
        for (const [field, ps] of Object.entries(shape.p)) {
          if (hasLeaf(ps, components)) out.push({ node: shape.n, field });
          if (isContainer(ps, components)) visit(ps);
        }
        if (shape.ap) {
          if (hasLeaf(shape.ap, components)) out.push({ node: shape.n, field: "*" });
          if (isContainer(shape.ap, components)) visit(shape.ap);
        }
        return;
      }
      case "arr":
        return visit(shape.i);
      case "map":
        return visit(shape.v);
      case "union":
        return shape.o.forEach(visit);
      default:
        return;
    }
  };
  for (const name of Object.keys(components)) visit({ k: "ref", n: name });
  for (const op of contract.operations) {
    for (const [status, shape] of Object.entries(op.responses)) {
      if (!isContainer(shape, components)) out.push({ node: `${op.operationId}#${status}`, field: "$" });
      else visit(shape);
    }
    if (op.body) {
      if (!isContainer(op.body, components)) out.push({ node: `${op.operationId}#body`, field: "$" });
      else visit(op.body);
    }
  }
  return out;
}
