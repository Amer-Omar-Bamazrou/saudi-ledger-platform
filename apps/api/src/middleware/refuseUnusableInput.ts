/**
 * 🔴 The request boundary: refuse what the database cannot hold, before it is asked (Phase 18 final round; register
 * §11.150).
 *
 * Postgres refuses a NUL in text and an integer column refuses a value outside its range. Input like that is the
 * caller's mistake, and it used to surface as our 500, one route at a time. This is the one place every request passes
 * once its body is parsed, so a route written tomorrow is covered without remembering to be. The list of routes it covers
 * is read from the router by `tests/phase18-z9-request-boundary.test.ts`.
 *
 * It runs before the session and every limiter. A request refused here has checked no credential and executed nothing,
 * so there is nothing to count. Sign-in alone is left to its limiter (below).
 */
import type { NextFunction, Request, Response } from "express";
import { fitsIntegerColumn, hasNul } from "../lib/inputGuards";

type Refusal = { error: string; code: string; field?: string; errorAr?: string };

const NUL_IN_TEXT: Refusal = { error: "A text field contains a NUL character.", code: "nul_in_text" };
const NUL_IN_URL: Refusal = { error: "The address contains a NUL character.", code: "nul_in_url" };
const INVALID_ID: Refusal = { error: "The address names an id that cannot exist.", code: "invalid_id_in_path" };
const MALFORMED_PATH: Refusal = { error: "The address is malformed.", code: "malformed_path" };

/**
 * 🔴 Phase 18 audit A3 (2026-11-09): a BODY id no integer column could hold. Sweep 3b found three routes answering 500 to
 * `bankAccountId` / `vendorId` = 2147483648 — the class #306 closed for path ids, one route at a time for bodies. An id
 * field is named `id`, `…Id` or `…Ids` (camelCase, as every generated body names them); its value is refused when it is
 * a number, or numeric text, that is not a whole number inside an integer column's range. Text that is not a number
 * (a UUID, a code) and every other field are the route's to judge.
 */
const INVALID_BODY_ID = (field: string): Refusal => ({
  error: `${field} names an id that cannot exist.`,
  errorAr: `الحقل ${field} يذكر معرّفًا لا يمكن أن يوجد.`,
  code: "invalid_id_in_body",
  field,
});
const ID_KEY = /^(id|ids|[a-z][A-Za-z0-9]*Ids?)$/;
const impossibleIdValue = (v: unknown): boolean => {
  if (typeof v === "number") return !fitsIntegerColumn(v);
  if (typeof v === "string" && v.trim() !== "" && /^[-+]?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(v.trim())) return !fitsIntegerColumn(Number(v));
  return false;
};

/** The dotted path of the first id field holding an impossible id (or the index inside an id list), or null. A loop, like firstNulField. */
export function firstImpossibleIdField(value: unknown): string | null {
  const stack: Array<{ value: unknown; path: string }> = [{ value, path: "" }];
  while (stack.length > 0) {
    const item = stack.pop()!;
    if (item.value === null || typeof item.value !== "object") continue;
    const entries = Object.entries(item.value as Record<string, unknown>);
    const pathOf = (key: string) => (item.path ? `${item.path}.${key}` : key);
    // This level's id fields first, in body order …
    for (const [key, child] of entries) {
      if (!ID_KEY.test(key)) continue;
      if (Array.isArray(child)) {
        const bad = child.findIndex((c) => impossibleIdValue(c));
        if (bad >= 0) return `${pathOf(key)}.${bad}`;
      } else if (impossibleIdValue(child)) {
        return pathOf(key);
      }
    }
    // … then the nested values, pushed in reverse so the first is visited first.
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const [key, child] = entries[i]!;
      stack.push({ value: child, path: pathOf(key) });
    }
  }
  return null;
}

/** The dotted path of the first string or key holding a NUL, or null. A loop, not recursion: a deep body must not overflow the stack. */
export function firstNulField(value: unknown): string | null {
  const stack: Array<{ value: unknown; path: string }> = [{ value, path: "" }];
  while (stack.length > 0) {
    const item = stack.pop()!;
    if (typeof item.value === "string") {
      if (hasNul(item.value)) return item.path;
      continue;
    }
    if (item.value === null || typeof item.value !== "object") continue;
    const entries = Object.entries(item.value as Record<string, unknown>);
    // Pushed in reverse so the first field in the body is the first one named.
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const [key, child] = entries[i]!;
      const path = item.path ? `${item.path}.${key}` : key;
      if (hasNul(key)) return path.replaceAll("\0", "");
      stack.push({ value: child, path });
    }
  }
  return null;
}

/** The refusal for a body holding a NUL, for the multipart seam, which parses later than this middleware runs. */
export function nulInTextRefusal(field: string): Refusal {
  return { ...NUL_IN_TEXT, field };
}

/** True when a decoded path segment reads as a number and no integer column could hold it. Anything that is not a number is the route's to judge. */
function isImpossibleId(segment: string): boolean {
  if (segment.trim() === "") return false;
  const n = Number(segment);
  return !Number.isNaN(n) && !fitsIntegerColumn(n);
}

/** What is wrong with the path, if anything. A malformed escape is refused here: the router's own decode error reaches the error handler as a 500. */
function pathRefusal(path: string): Refusal | null {
  for (const raw of path.split("/")) {
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      return MALFORMED_PATH;
    }
    if (isImpossibleId(segment)) return INVALID_ID;
  }
  return null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `router.param` handler for a path whose id is a UUID column: there, `1` is as impossible as `1e20` is for an integer one,
 * and the boundary above cannot tell from the path alone. Each UUID-keyed router declares its params with this; the sweep
 * in `tests/phase18-z9-request-boundary.test.ts` sends a non-id to every route and fails on a router that forgot.
 */
export function refuseNonUuidParam(_req: Request, res: Response, next: NextFunction, value: string): void {
  if (UUID.test(value)) {
    next();
    return;
  }
  res.status(400).json(INVALID_ID);
}

/**
 * Sign-in's limiter counts every attempt, whatever it carries (`tests/rate-limit-login.test.ts`), and #297's guard answers
 * after it. Exempt from the body check only: the path and the query are the same for everyone.
 */
function isSignIn(req: Request): boolean {
  return req.method === "POST" && req.path.replace(/\/+$/, "") === "/auth/login";
}

export function refuseUnusableInput(req: Request, res: Response, next: NextFunction): void {
  if (req.originalUrl.toLowerCase().includes("%00")) {
    res.status(400).json(NUL_IN_URL);
    return;
  }
  const refused = pathRefusal(req.path);
  if (refused) {
    res.status(400).json(refused);
    return;
  }
  if (!isSignIn(req)) {
    const field = firstNulField(req.body);
    if (field !== null) {
      res.status(400).json(nulInTextRefusal(field));
      return;
    }
    const idField = firstImpossibleIdField(req.body);
    if (idField !== null) {
      res.status(400).json(INVALID_BODY_ID(idField));
      return;
    }
  }
  next();
}
