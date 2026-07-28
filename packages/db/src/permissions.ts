import { db } from "./index";
import { permissionsTable } from "./schema";

/**
 * RBAC permission matrix — the seeded role → resource → action mapping the API
 * enforces (via `requirePermission`). This is the **source of truth for policy
 * data**; a future phase can extend/adjust access by changing these rows (and
 * re-seeding) without touching route code.
 *
 * The matrix here **codifies the pre-M5 behavior exactly** (no policy change):
 *   - GET/read      → all roles (admin, accountant, viewer)
 *   - POST/create   → admin + accountant
 *   - PATCH/update  → admin + accountant
 *   - DELETE/delete → admin only
 * with two overrides that already existed:
 *   - `period_locks` create AND delete → admin only (locking/unlocking periods)
 *   - `categorize` → admin + accountant (create only)
 *
 * `users` (global user administration under `/auth`) is included for
 * completeness and future per-org membership management, but is NOT yet wired to
 * `requirePermission`: those endpoints run before `resolveTenant` and manage the
 * global identity directory, so they remain guarded by the session-role
 * `requireAdmin` guard. See CLAUDE.md (M5 boundary note).
 */

export type PermissionRole = "admin" | "accountant" | "viewer";
export type PermissionAction = "read" | "create" | "update" | "delete";

export interface PermissionRow {
  role: PermissionRole;
  resource: string;
  action: PermissionAction;
}

const READ_ALL: readonly PermissionRole[] = ["admin", "accountant", "viewer"];
const WRITE: readonly PermissionRole[] = ["admin", "accountant"];
const ADMIN_ONLY: readonly PermissionRole[] = ["admin"];

/**
 * Per-resource action → allowed-roles spec. Only actions a resource actually
 * exposes are listed; anything absent is denied by default (fail-closed), so a
 * new route without a seeded permission is blocked until policy is added.
 */
const SPEC: Record<string, Partial<Record<PermissionAction, readonly PermissionRole[]>>> = {
  // Standard business entities: read=all, create/update=write, delete=admin.
  transactions: { read: READ_ALL, create: WRITE, update: WRITE, delete: ADMIN_ONLY },
  customers: { read: READ_ALL, create: WRITE, update: WRITE, delete: ADMIN_ONLY },
  vendors: { read: READ_ALL, create: WRITE, update: WRITE, delete: ADMIN_ONLY },
  products: { read: READ_ALL, create: WRITE, update: WRITE, delete: ADMIN_ONLY },
  invoices: { read: READ_ALL, create: WRITE, update: WRITE, delete: ADMIN_ONLY },
  bills: { read: READ_ALL, create: WRITE, update: WRITE, delete: ADMIN_ONLY },
  employees: { read: READ_ALL, create: WRITE, update: WRITE, delete: ADMIN_ONLY },
  assets: { read: READ_ALL, create: WRITE, update: WRITE, delete: ADMIN_ONLY },
  bank_accounts: { read: READ_ALL, create: WRITE, update: WRITE, delete: ADMIN_ONLY },
  budgets: { read: READ_ALL, create: WRITE, update: WRITE, delete: ADMIN_ONLY },

  // journal_entries: no PATCH route; delete (reversal/removal) is admin-only.
  journal_entries: { read: READ_ALL, create: WRITE, delete: ADMIN_ONLY },

  // Read + create only (no update/delete routes today).
  categories: { read: READ_ALL, create: WRITE },
  payroll: { read: READ_ALL, create: WRITE },
  llm: { read: READ_ALL, create: WRITE },

  // Read-only resources.
  reports: { read: READ_ALL },
  summary: { read: READ_ALL },

  // Categorization proposal (POST only).
  categorize: { create: WRITE },

  // Period locks: viewing is open; locking (create) and unlocking (delete) are
  // admin-only — stricter than generic writes, preserved from pre-M5.
  period_locks: { read: READ_ALL, create: ADMIN_ONLY, delete: ADMIN_ONLY },

  // Global user administration (documentation/future use — see header note).
  users: { read: ADMIN_ONLY, create: ADMIN_ONLY, update: ADMIN_ONLY },
};

/** The flattened matrix: one row per (role, resource, action) grant. */
export const PERMISSION_MATRIX: PermissionRow[] = Object.entries(SPEC).flatMap(
  ([resource, actions]) =>
    Object.entries(actions).flatMap(([action, roles]) =>
      (roles ?? []).map((role) => ({ role, resource, action: action as PermissionAction })),
    ),
);

export interface SeededPermissions {
  inserted: number;
  total: number;
}

/**
 * Idempotently seed the permission matrix. New (role, resource, action) grants
 * are inserted; existing ones are left untouched (unique constraint on the
 * triple). Safe to re-run. Rows removed from the matrix are NOT deleted here —
 * pruning stale grants is a deliberate, separate operation.
 */
export async function seedPermissions(): Promise<SeededPermissions> {
  const inserted = await db
    .insert(permissionsTable)
    .values(PERMISSION_MATRIX)
    .onConflictDoNothing()
    .returning({ id: permissionsTable.id });

  const all = await db.select({ id: permissionsTable.id }).from(permissionsTable);
  return { inserted: inserted.length, total: all.length };
}
