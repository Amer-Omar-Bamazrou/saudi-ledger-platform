import { describe, it, expect, beforeAll } from "vitest";
import { PERMISSION_MATRIX } from "@workspace/db";
import { requirePermission, primePermissionCache } from "../lib/rbac";

/**
 * RBAC enforcement tests — verify each role can perform its permitted actions
 * and is denied its forbidden ones, driving the REAL seeded permission matrix
 * (PERMISSION_MATRIX) through the actual requirePermission middleware. No DB is
 * touched: the cache is primed directly from the matrix.
 */

type Role = "admin" | "accountant" | "viewer";

interface RunResult {
  statusCode: number;
  body: unknown;
  nextCalled: boolean;
}

async function run(
  role: Role | undefined,
  method: string,
  resource: string,
): Promise<RunResult> {
  const result: RunResult = { statusCode: 0, body: undefined, nextCalled: false };
  const req = {
    method,
    tenant: role ? { role } : undefined,
    log: { error: () => {} },
  } as unknown as Parameters<ReturnType<typeof requirePermission>>[0];
  const res = {
    status(code: number) {
      result.statusCode = code;
      return this;
    },
    json(body: unknown) {
      result.body = body;
      return this;
    },
  } as unknown as Parameters<ReturnType<typeof requirePermission>>[1];
  const next = () => {
    result.nextCalled = true;
  };
  await requirePermission(resource)(req, res, next);
  return result;
}

beforeAll(() => {
  primePermissionCache(PERMISSION_MATRIX);
});

describe("requirePermission — allow/deny by role", () => {
  // resource, method, allowed roles (everyone else denied)
  const CASES: Array<[string, string, Role[]]> = [
    // Standard business entity: read=all, create/update=write, delete=admin
    ["transactions", "GET", ["admin", "accountant", "viewer"]],
    ["transactions", "POST", ["admin", "accountant"]],
    ["transactions", "PATCH", ["admin", "accountant"]],
    ["transactions", "DELETE", ["admin"]],
    // journal_entries: create=write, delete=admin, NO update route (fail-closed)
    ["journal_entries", "GET", ["admin", "accountant", "viewer"]],
    ["journal_entries", "POST", ["admin", "accountant"]],
    ["journal_entries", "PATCH", []], // no update grant → nobody
    ["journal_entries", "DELETE", ["admin"]],
    // period_locks override: create + delete are admin-only
    ["period_locks", "GET", ["admin", "accountant", "viewer"]],
    ["period_locks", "POST", ["admin"]],
    ["period_locks", "DELETE", ["admin"]],
    // categorize: create only (write)
    ["categorize", "POST", ["admin", "accountant"]],
    // reports: read-only — even admin cannot POST (fail-closed)
    ["reports", "GET", ["admin", "accountant", "viewer"]],
    ["reports", "POST", []],
  ];

  const ALL_ROLES: Role[] = ["admin", "accountant", "viewer"];

  for (const [resource, method, allowed] of CASES) {
    for (const role of ALL_ROLES) {
      const shouldAllow = allowed.includes(role);
      it(`${role} ${shouldAllow ? "CAN" : "cannot"} ${method} ${resource}`, async () => {
        const r = await run(role, method, resource);
        if (shouldAllow) {
          expect(r.nextCalled).toBe(true);
          expect(r.statusCode).toBe(0);
        } else {
          expect(r.nextCalled).toBe(false);
          expect(r.statusCode).toBe(403);
        }
      });
    }
  }

  it("denies (403) when no tenant role is resolved", async () => {
    const r = await run(undefined, "GET", "transactions");
    expect(r.nextCalled).toBe(false);
    expect(r.statusCode).toBe(403);
  });

  it("rejects (405) an unmapped HTTP method", async () => {
    const r = await run("admin", "OPTIONS", "transactions");
    expect(r.nextCalled).toBe(false);
    expect(r.statusCode).toBe(405);
  });
});

describe("PERMISSION_MATRIX — codifies pre-M5 behavior", () => {
  const has = (role: string, resource: string, action: string) =>
    PERMISSION_MATRIX.some((p) => p.role === role && p.resource === resource && p.action === action);

  it("viewers read but never write", () => {
    expect(has("viewer", "transactions", "read")).toBe(true);
    expect(has("viewer", "transactions", "create")).toBe(false);
    expect(has("viewer", "invoices", "update")).toBe(false);
    expect(has("viewer", "transactions", "delete")).toBe(false);
  });

  it("accountants write but cannot delete", () => {
    expect(has("accountant", "transactions", "create")).toBe(true);
    expect(has("accountant", "transactions", "update")).toBe(true);
    expect(has("accountant", "transactions", "delete")).toBe(false);
  });

  it("period_locks create/delete are admin-only (not accountant)", () => {
    expect(has("admin", "period_locks", "create")).toBe(true);
    expect(has("admin", "period_locks", "delete")).toBe(true);
    expect(has("accountant", "period_locks", "create")).toBe(false);
    expect(has("accountant", "period_locks", "delete")).toBe(false);
    expect(has("viewer", "period_locks", "read")).toBe(true);
  });

  it("only admins manage users", () => {
    expect(has("admin", "users", "read")).toBe(true);
    expect(has("admin", "users", "create")).toBe(true);
    expect(has("admin", "users", "update")).toBe(true);
    expect(has("accountant", "users", "read")).toBe(false);
    expect(has("viewer", "users", "read")).toBe(false);
  });
});
