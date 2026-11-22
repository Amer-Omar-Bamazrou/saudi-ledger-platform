/**
 * 🔴 19B S1 (v4 §4) — THE RESPONSE SEAM: every 2xx JSON response passes through `withhold`, which classifies each served
 * key by the class table and removes what the reader's role may not read (D4: the key is absent, never null or zero,
 * and the response says what was withheld in the `X-Withheld` header: `[{ path, class, level }]`).
 *
 * Mounted once, before every router, by wrapping `res.json` (app.ts) — so no route can answer around it, and a route
 * added tomorrow is covered the day it is added.
 *
 *  - The reader is the request's organization role (`req.tenant.role`). A request with no organization role (identity,
 *    onboarding, the operator surface) is decided as fully granted in S1; S2c narrows `member_security` there.
 *  - A response outside the contract is classified through its route's own entry (outsideContract.ts).
 *  - 🔴 UNCLASSIFIED: in the test lane (NODE_ENV=test) a response that serves a key the tables cannot classify — or a
 *    route that is in neither table — is answered 500 `field_unclassified`, naming each key, so the test that served it
 *    fails. In production S1 serves it as before and logs it once; withholding an unclassified field from non-admins
 *    (v4 §5.3's default deny) is switched on with S2a, with the owner's approval.
 *
 * 🔴 S1: every role holds every class's grants (PERMISSION_MATRIX), so nothing is withheld: the seam's output is its
 * input, the same object, unchanged. Each S2 step switches its records on by removing grants, with the owner's
 * approval per environment (D10).
 *
 * The grants are read from the permission cache `requirePermission` has already loaded for the request. A reader with
 * a role and no loaded cache is decided as holding nothing (fail closed) — it cannot happen on a tenant route, whose
 * guard loads the cache before the handler runs.
 */
import type { NextFunction, Request, Response } from "express";
import type { ProtectedFieldClass } from "@workspace/db";
import { fieldGrantAction } from "@workspace/db";
import { peekPermissions } from "../rbac";
import { logger } from "../logger";
import { CONTRACT } from "./contractShapes.generated";
import { fieldSpec, indexTable, type FieldSpec } from "./classTable";
import { apiPath, findOperation, findOutsideRoute } from "./operations";
import { OUTSIDE_CONTRACT_ROUTES, keyPathsOf, walkStructural } from "./outsideContract";
import { appendFileSync } from "node:fs";
import { walkValue, type ReadDecider, type ReadLevel, type WalkResult } from "./walk";

export const WITHHELD_HEADER = "X-Withheld";

const permKey = (role: string, resource: string, action: string): string => `${role}:${resource}:${action}`;

/** What a role may see of a class on a resource, from a grant set. */
export function deciderFor(role: string | undefined, grants: ReadonlySet<string> | null): ReadDecider {
  if (!role) return () => "read"; // no organization role: decided in S2c (member_security); S1 withholds nothing here
  return (cls: ProtectedFieldClass, resource: string): ReadLevel => {
    if (!grants) return "none";
    if (grants.has(permKey(role, resource, fieldGrantAction(cls, "read")))) return "read";
    if (cls === "bank_account" && grants.has(permKey(role, resource, fieldGrantAction(cls, "last4")))) return "last4";
    return "none";
  };
}

let outsideIndex: Map<string, Map<string, FieldSpec>> | null = null;
const outsideSpec = (route: string, keyPath: string): FieldSpec | undefined => {
  outsideIndex ??= indexTable(OUTSIDE_CONTRACT_ROUTES);
  return outsideIndex.get(route)?.get(keyPath);
};

/** The served value after withholding, for one 2xx JSON response. */
export function classifyResponse(method: string, originalUrl: string, status: number, body: unknown, decide: ReadDecider): WalkResult & { route: string } {
  const path = apiPath(originalUrl);
  const op = findOperation(method, path);
  // The contract's shape for this status; a route answering 200 where the contract says 201 (or the reverse) is walked
  // with the operation's one JSON response — its node names carry that status.
  const statusKey = op ? (String(status) in op.responses ? String(status) : Object.keys(op.responses)[0]) : undefined;
  if (op && statusKey) {
    const result = walkValue(op.responses[statusKey]!, body, `${op.operationId}#${statusKey}`, fieldSpec, decide, CONTRACT.components);
    return { ...result, route: `${method} ${op.path}` };
  }
  const outside = findOutsideRoute(method, path);
  if (outside) return { ...walkStructural(body, outside, outsideSpec, decide), route: outside };
  return { value: body, withheld: [], unclassified: [`${method} ${path} (a route in neither the contract nor the outside-contract table)`], route: `${method} ${path}` };
}

const warned = new Set<string>();

export function fieldClassSeam(req: Request, res: Response, next: NextFunction): void {
  const json = res.json.bind(res);
  res.json = ((body?: unknown) => {
    if (res.statusCode < 200 || res.statusCode >= 300 || !req.originalUrl.startsWith("/api")) return json(body);
    const served = classifyResponse(req.method, req.originalUrl, res.statusCode, body, deciderFor(req.tenant?.role, peekPermissions()));
    if (served.unclassified.length) {
      // A REPORT, never a switch: with FIELD_CLASS_CAPTURE_FILE set, each unclassified answer is also appended there —
      // the route, the keys, and every key path the response served — to build the table from what is really served.
      const capture = process.env.FIELD_CLASS_CAPTURE_FILE;
      if (capture) appendFileSync(capture, `${JSON.stringify({ route: served.route, status: res.statusCode, fields: served.unclassified, keyPaths: keyPathsOf(body) })}\n`);
      if (process.env.NODE_ENV === "test") {
        res.status(500);
        return json({
          code: "field_unclassified",
          error: `This response serves fields the class table cannot classify (${served.route}): ${served.unclassified.join(", ")}. Give each a class (lib/fieldClasses/classTable.ts or outsideContract.ts).`,
          fields: served.unclassified,
          route: served.route,
        });
      }
      const key = `${served.route} ${served.unclassified.join(",")}`;
      if (!warned.has(key)) {
        warned.add(key);
        logger.warn({ route: served.route, fields: served.unclassified }, "served fields the class table cannot classify (19B S1: served unchanged; withheld from non-admins once S2a switches default deny on)");
      }
    }
    if (served.withheld.length) res.setHeader(WITHHELD_HEADER, JSON.stringify(served.withheld));
    return json(served.value);
  }) as Response["json"];
  next();
}
