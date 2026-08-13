import { describe, it, expect, beforeAll } from "vitest";
import { PERMISSION_MATRIX } from "@workspace/db";
import { requirePermission, primePermissionCache } from "../lib/rbac";

/**
 * RBAC enforcement tests — verify each role can perform its permitted actions
 * and is denied its forbidden ones, driving the REAL seeded permission matrix
 * (PERMISSION_MATRIX) through the actual requirePermission middleware. No DB is
 * touched: the cache is primed directly from the matrix.
 *
 * M10: the 4-role model (admin | accountant | bookkeeper | viewer) and the
 * `approve` action-route override — a POST to an activation sub-route
 * (/:id/post|approve|pay|reject|reverse) requires `approve`, not `create`, so a
 * bookkeeper can enter drafts (POST /) but cannot activate them.
 */

type Role = "admin" | "accountant" | "bookkeeper" | "viewer";
const ALL_ROLES: Role[] = ["admin", "accountant", "bookkeeper", "viewer"];

interface RunResult {
  statusCode: number;
  body: unknown;
  nextCalled: boolean;
}

async function run(
  role: Role | undefined,
  method: string,
  resource: string,
  path = "/",
): Promise<RunResult> {
  const result: RunResult = { statusCode: 0, body: undefined, nextCalled: false };
  const req = {
    method,
    path,
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

describe("requirePermission — CRUD actions by role (method-inferred)", () => {
  // resource, method, path, allowed roles (everyone else denied)
  const CASES: Array<[string, string, string, Role[]]> = [
    // Standard business entity: read=all, create/update=write (now incl. bookkeeper), delete=admin
    ["transactions", "GET", "/", ["admin", "accountant", "bookkeeper", "viewer"]],
    ["transactions", "POST", "/", ["admin", "accountant", "bookkeeper"]],
    ["transactions", "PATCH", "/5", ["admin", "accountant", "bookkeeper"]],
    ["transactions", "DELETE", "/5", ["admin"]],
    // journal_entries: create=write, delete=admin, NO update route (fail-closed)
    ["journal_entries", "GET", "/", ["admin", "accountant", "bookkeeper", "viewer"]],
    ["journal_entries", "POST", "/", ["admin", "accountant", "bookkeeper"]],
    ["journal_entries", "PATCH", "/5", []], // no update grant → nobody
    ["journal_entries", "DELETE", "/5", ["admin"]],
    // period_locks override: create + delete are admin-only
    ["period_locks", "GET", "/", ["admin", "accountant", "bookkeeper", "viewer"]],
    ["period_locks", "POST", "/", ["admin"]],
    ["period_locks", "DELETE", "/5", ["admin"]],
    // categorize: create only (write)
    ["categorize", "POST", "/", ["admin", "accountant", "bookkeeper"]],
    // reports: read-only — even admin cannot POST (fail-closed)
    ["reports", "GET", "/", ["admin", "accountant", "bookkeeper", "viewer"]],
    ["reports", "POST", "/", []],
  ];

  for (const [resource, method, path, allowed] of CASES) {
    for (const role of ALL_ROLES) {
      const shouldAllow = allowed.includes(role);
      it(`${role} ${shouldAllow ? "CAN" : "cannot"} ${method} ${resource}${path}`, async () => {
        const r = await run(role, method, resource, path);
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
});

describe("requirePermission — activation routes require `approve` (not create)", () => {
  // Every activation sub-route is admin+accountant only; bookkeeper & viewer denied.
  const APPROVERS: Role[] = ["admin", "accountant"];
  const ACTIVATION: Array<[string, string]> = [
    ["journal_entries", "/5/approve"],
    ["journal_entries", "/5/reject"],
    ["journal_entries", "/5/post"],
    ["journal_entries", "/5/reverse"],
    ["bills", "/5/post"],
    ["bills", "/5/pay"],
    ["bills", "/5/approve"],
    ["bills", "/5/reject"],
    ["bills", "/5/send-back"],
    ["invoices", "/5/pay"],
    ["invoices", "/5/approve"],
    ["invoices", "/5/reject"],
    ["invoices", "/5/send-back"],
    ["payroll", "/5/approve"],
    ["payroll", "/5/reject"],
    ["payroll", "/5/send-back"],
    // M16.3: settling a transaction records a payment through the pay path.
    ["transactions", "/5/settle"],
  ];

  for (const [resource, path] of ACTIVATION) {
    for (const role of ALL_ROLES) {
      const shouldAllow = APPROVERS.includes(role);
      it(`${role} ${shouldAllow ? "CAN" : "cannot"} POST ${resource}${path}`, async () => {
        const r = await run(role, "POST", resource, path);
        expect(r.nextCalled).toBe(shouldAllow);
        expect(r.statusCode).toBe(shouldAllow ? 0 : 403);
      });
    }
  }

  it("separates create from approve: a bookkeeper CAN create a JE draft but cannot post it", async () => {
    const create = await run("bookkeeper", "POST", "journal_entries", "/");
    expect(create.nextCalled).toBe(true);
    const post = await run("bookkeeper", "POST", "journal_entries", "/5/post");
    expect(post.nextCalled).toBe(false);
    expect(post.statusCode).toBe(403);
  });

  it("submit is a bookkeeper action, approve/send-back are not: a bookkeeper CAN submit a bill but cannot approve or send it back", async () => {
    // submit resolves to `create` (bookkeeper holds it) — enters their own draft into the queue.
    const submit = await run("bookkeeper", "POST", "bills", "/5/submit");
    expect(submit.nextCalled).toBe(true);
    // approve + send-back resolve to `approve` (approver-only) — bookkeeper denied.
    const approve = await run("bookkeeper", "POST", "bills", "/5/approve");
    expect(approve.nextCalled).toBe(false);
    expect(approve.statusCode).toBe(403);
    const sendBack = await run("bookkeeper", "POST", "bills", "/5/send-back");
    expect(sendBack.nextCalled).toBe(false);
    expect(sendBack.statusCode).toBe(403);
  });

  it("invoices: a bookkeeper CAN create + submit a draft but cannot approve it", async () => {
    expect((await run("bookkeeper", "POST", "invoices", "/")).nextCalled).toBe(true);
    expect((await run("bookkeeper", "POST", "invoices", "/5/submit")).nextCalled).toBe(true);
    const approve = await run("bookkeeper", "POST", "invoices", "/5/approve");
    expect(approve.nextCalled).toBe(false);
    expect(approve.statusCode).toBe(403);
  });

  it("payroll: a bookkeeper CAN create + submit a run but cannot approve it", async () => {
    expect((await run("bookkeeper", "POST", "payroll", "/")).nextCalled).toBe(true);
    expect((await run("bookkeeper", "POST", "payroll", "/5/submit")).nextCalled).toBe(true);
    const approve = await run("bookkeeper", "POST", "payroll", "/5/approve");
    expect(approve.nextCalled).toBe(false);
    expect(approve.statusCode).toBe(403);
  });
});

describe("requirePermission — edge cases", () => {
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

describe("PERMISSION_MATRIX — 4-role model + approve action", () => {
  const has = (role: string, resource: string, action: string) =>
    PERMISSION_MATRIX.some((p) => p.role === role && p.resource === resource && p.action === action);

  it("viewers read but never write or approve", () => {
    expect(has("viewer", "transactions", "read")).toBe(true);
    expect(has("viewer", "transactions", "create")).toBe(false);
    expect(has("viewer", "invoices", "update")).toBe(false);
    expect(has("viewer", "invoices", "approve")).toBe(false);
    expect(has("viewer", "transactions", "delete")).toBe(false);
  });

  it("bookkeepers read + create/update but never approve or delete", () => {
    expect(has("bookkeeper", "transactions", "read")).toBe(true);
    expect(has("bookkeeper", "journal_entries", "create")).toBe(true);
    expect(has("bookkeeper", "invoices", "create")).toBe(true);
    expect(has("bookkeeper", "invoices", "update")).toBe(true);
    // the whole point: no approval authority
    expect(has("bookkeeper", "journal_entries", "approve")).toBe(false);
    expect(has("bookkeeper", "bills", "approve")).toBe(false);
    expect(has("bookkeeper", "payroll", "approve")).toBe(false);
    expect(has("bookkeeper", "invoices", "approve")).toBe(false);
    expect(has("bookkeeper", "transactions", "delete")).toBe(false);
  });

  it("accountants write and approve but cannot delete or manage users", () => {
    expect(has("accountant", "transactions", "create")).toBe(true);
    expect(has("accountant", "journal_entries", "approve")).toBe(true);
    expect(has("accountant", "bills", "approve")).toBe(true);
    expect(has("accountant", "transactions", "delete")).toBe(false);
    expect(has("accountant", "users", "read")).toBe(false);
  });

  it("approve grants exist for admin+accountant on all four activation resources", () => {
    for (const resource of ["journal_entries", "bills", "payroll", "invoices"]) {
      expect(has("admin", resource, "approve")).toBe(true);
      expect(has("accountant", resource, "approve")).toBe(true);
      expect(has("bookkeeper", resource, "approve")).toBe(false);
      expect(has("viewer", resource, "approve")).toBe(false);
    }
  });

  it("period_locks create/delete remain admin-only", () => {
    expect(has("admin", "period_locks", "create")).toBe(true);
    expect(has("admin", "period_locks", "delete")).toBe(true);
    expect(has("accountant", "period_locks", "create")).toBe(false);
    expect(has("bookkeeper", "period_locks", "create")).toBe(false);
    expect(has("viewer", "period_locks", "read")).toBe(true);
  });

  it("only admins manage users", () => {
    expect(has("admin", "users", "read")).toBe(true);
    expect(has("admin", "users", "create")).toBe(true);
    expect(has("accountant", "users", "read")).toBe(false);
    expect(has("bookkeeper", "users", "read")).toBe(false);
    expect(has("viewer", "users", "read")).toBe(false);
  });
});
