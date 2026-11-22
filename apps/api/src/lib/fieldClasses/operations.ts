/**
 * 🔴 19B S1 — which contract operation (or which route outside the contract) a request is.
 *
 * Matched on the method and the URL's path below `/api`, against the contract's path templates: `{param}` matches one
 * segment, and the template with the most literal segments wins (`/invoices/summary` before `/invoices/{id}`), so
 * the answer never depends on the order routes were declared in. Independent of Express internals by design.
 */
import { CONTRACT } from "./contractShapes.generated";
import type { ContractOperation } from "./shapes";
import { OUTSIDE_CONTRACT_ROUTES } from "./outsideContract";

interface Matcher<T> {
  re: RegExp;
  literals: number;
  value: T;
}

function compile<T>(template: string, value: T): Matcher<T> {
  const segments = template.split("/").filter(Boolean);
  const re = new RegExp(
    "^/" + segments.map((s) => (/^\{[^}]+\}$/.test(s) ? "[^/]+" : s.replace(/[.*+?^$()|[\]\\]/g, "\\$&"))).join("/") + "$",
  );
  return { re, literals: segments.filter((s) => !/^\{[^}]+\}$/.test(s)).length, value };
}

function index<T>(entries: [method: string, template: string, value: T][]): Map<string, Matcher<T>[]> {
  const byMethod = new Map<string, Matcher<T>[]>();
  for (const [method, template, value] of entries) {
    const list = byMethod.get(method) ?? [];
    list.push(compile(template, value));
    byMethod.set(method, list);
  }
  for (const list of byMethod.values()) list.sort((a, b) => b.literals - a.literals);
  return byMethod;
}

let contractIndex: Map<string, Matcher<ContractOperation>[]> | null = null;
let outsideIndex: Map<string, Matcher<string>[]> | null = null;

/** The path below `/api`, without the query string or a trailing slash. */
export function apiPath(originalUrl: string): string {
  const path = originalUrl.split("?")[0]!.replace(/^\/api(?=\/|$)/, "");
  return path.length > 1 ? path.replace(/\/+$/, "") : path || "/";
}

export function findOperation(method: string, path: string): ContractOperation | undefined {
  contractIndex ??= index(CONTRACT.operations.map((op) => [op.method, op.path, op] as [string, string, ContractOperation]));
  return contractIndex.get(method.toUpperCase())?.find((m) => m.re.test(path))?.value;
}

/** The outside-contract table's key (`GET /orgs/{orgId}/members`) for a request, or undefined. */
export function findOutsideRoute(method: string, path: string): string | undefined {
  outsideIndex ??= index(
    Object.keys(OUTSIDE_CONTRACT_ROUTES).map((key) => {
      const [m, template] = key.split(" ") as [string, string];
      return [m, template, key] as [string, string, string];
    }),
  );
  return outsideIndex.get(method.toUpperCase())?.find((m) => m.re.test(path))?.value;
}
