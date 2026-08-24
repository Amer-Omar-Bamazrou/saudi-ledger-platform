import { db } from "./index";
import { permissionsTable } from "./schema";

/**
 * RBAC permission matrix — the seeded role → resource → action mapping the API
 * enforces (via `requirePermission`). This is the **source of truth for policy
 * data**; a future phase can extend/adjust access by changing these rows (and
 * re-seeding) without touching route code.
 *
 * Roles (4-role model, M10): admin | accountant | bookkeeper | viewer.
 *   - GET/read      → all roles (admin, accountant, bookkeeper, viewer)
 *   - POST/create   → admin + accountant + bookkeeper (bookkeeper enters drafts)
 *   - PATCH/update  → admin + accountant + bookkeeper
 *   - approve       → admin + accountant only (activation authority; a bookkeeper
 *                     may enter work but never approve/post/pay it)
 *   - DELETE/delete → admin only
 * with two overrides that already existed:
 *   - `period_locks` create AND delete → admin only (locking/unlocking periods)
 *   - `categorize` → write (create only)
 *
 * The `approve` action gates the activation endpoints (post / approve / pay /
 * reject / reverse) — see `requirePermission`'s action-route mapping. It is a
 * distinct action precisely because those endpoints are POSTs that would
 * otherwise resolve to `create`, which a bookkeeper holds.
 *
 * `users` (global user administration under `/auth`) is included for
 * completeness and future per-org membership management, but is NOT yet wired to
 * `requirePermission`: those endpoints run before `resolveTenant` and manage the
 * global identity directory, so they remain guarded by the session-role
 * `requireAdmin` guard. See CLAUDE.md (M5 boundary note).
 */

export type PermissionRole = "admin" | "accountant" | "bookkeeper" | "viewer";
export type PermissionAction = "read" | "create" | "update" | "delete" | "approve";

export interface PermissionRow {
  role: PermissionRole;
  resource: string;
  action: PermissionAction;
}

const READ_ALL: readonly PermissionRole[] = ["admin", "accountant", "bookkeeper", "viewer"];
// create/update — a bookkeeper enters records (as drafts, enforced in the service
// layer); the coarse grant here only distinguishes "may write" from "read-only".
const WRITE: readonly PermissionRole[] = ["admin", "accountant", "bookkeeper"];
// activation authority — approve/post/pay/reject/reverse. Bookkeeper excluded.
const APPROVE: readonly PermissionRole[] = ["admin", "accountant"];
const ADMIN_ONLY: readonly PermissionRole[] = ["admin"];

/**
 * Per-resource action → allowed-roles spec. Only actions a resource actually
 * exposes are listed; anything absent is denied by default (fail-closed), so a
 * new route without a seeded permission is blocked until policy is added.
 */
const SPEC: Record<string, Partial<Record<PermissionAction, readonly PermissionRole[]>>> = {
  // Standard business entities: read=all, create/update=write, delete=admin.
  // transactions carry `approve` (M16.3): POST /:id/settle records a PAYMENT
  // against an invoice/bill through the pay path — approver authority, same as
  // invoice/bill pay. Plain accept stays create-level (it moves no money).
  transactions: { read: READ_ALL, create: WRITE, update: WRITE, approve: APPROVE, delete: ADMIN_ONLY },
  customers: { read: READ_ALL, create: WRITE, update: WRITE, delete: ADMIN_ONLY },
  vendors: { read: READ_ALL, create: WRITE, update: WRITE, delete: ADMIN_ONLY },
  products: { read: READ_ALL, create: WRITE, update: WRITE, delete: ADMIN_ONLY },
  // invoices/bills carry an `approve` grant: activation endpoints (invoice pay;
  // bill post/pay) require approver authority, not mere create.
  invoices: { read: READ_ALL, create: WRITE, update: WRITE, approve: APPROVE, delete: ADMIN_ONLY },
  bills: { read: READ_ALL, create: WRITE, update: WRITE, approve: APPROVE, delete: ADMIN_ONLY },
  employees: { read: READ_ALL, create: WRITE, update: WRITE, delete: ADMIN_ONLY },
  assets: { read: READ_ALL, create: WRITE, update: WRITE, delete: ADMIN_ONLY },
  bank_accounts: { read: READ_ALL, create: WRITE, update: WRITE, delete: ADMIN_ONLY },
  budgets: { read: READ_ALL, create: WRITE, update: WRITE, delete: ADMIN_ONLY },

  /**
   * Quotations (M21.1) — an offer to a customer, with NO ledger effect at any
   * status. The grants nonetheless mirror `invoices` rather than something
   * looser, and the reason is authority rather than accounting:
   *
   * `approve` is what releases a quotation to a customer, and a quotation is a
   * PRICE COMMITMENT the business will be held to. So a bookkeeper may draft
   * one and may not issue it — the same split as invoices, for a different
   * reason (there, approve mints a legal tax document; here, it commits a
   * price). Delete stays admin-only: an issued quotation is the record of what
   * was offered.
   *
   * 🔴 `create` also covers CONVERSION (M21.2). Converting produces a DRAFT
   * invoice, which is a bookkeeper's ordinary work; the resulting invoice
   * still needs an approver before anything reaches the ledger. This is why
   * `/convert` is deliberately absent from rbac.ts's APPROVE_ROUTE regex.
   */
  quotations: { read: READ_ALL, create: WRITE, update: WRITE, approve: APPROVE, delete: ADMIN_ONLY },

  /**
   * Purchase orders (M21.3) — the mirror of `quotations`, and the same
   * authority split for the mirrored reason: `approve` is what releases the
   * order to a SUPPLIER, which commits the business to buy. A bookkeeper may
   * draft one and may not issue it.
   *
   * 🔴 `create` also covers CONVERSION to a bill, which produces a DRAFT the
   * approver still has to post — so `/convert` stays create-level and is
   * deliberately absent from rbac.ts's APPROVE_ROUTE.
   */
  purchase_orders: { read: READ_ALL, create: WRITE, update: WRITE, approve: APPROVE, delete: ADMIN_ONLY },

  // journal_entries: no PATCH route; post/reverse need approve; delete admin-only.
  journal_entries: { read: READ_ALL, create: WRITE, approve: APPROVE, delete: ADMIN_ONLY },

  // Read + create only (no update/delete routes today).
  categories: { read: READ_ALL, create: WRITE },
  // payroll: the /:id/approve activation needs approver authority.
  payroll: { read: READ_ALL, create: WRITE, approve: APPROVE },
  llm: { read: READ_ALL, create: WRITE },

  // Company settings (M11.6): everyone may READ the company profile (it is
  // displayed on invoices and reports), but only an admin may change the legal
  // identity — the VAT/CR numbers feed the ZATCA QR and invoice hash chain.
  companies: { read: READ_ALL, update: ADMIN_ONLY },

  /**
   * ZATCA onboarding (M12.4). Read is open so any role can see the prerequisite
   * checklist and the certificate expiry; CREATE is admin-only because it mints
   * the credential that signs the tenant's legally-valid tax invoices.
   */
  zatca_onboarding: { read: READ_ALL, create: ADMIN_ONLY },

  // Read-only resources.
  reports: { read: READ_ALL },
  summary: { read: READ_ALL },

  // Categorization proposal (POST only).
  categorize: { create: WRITE },

  /**
   * Recurring rules (A3). Create/update at WRITE level — a rule produces
   * DRAFTS, so setting one up is the same authority as typing the invoice by
   * hand, and a bookkeeper may do it. The draft still needs an approver.
   *
   * DELETE is admin-only: removing a rule silently stops a customer being
   * billed, and that is a quieter failure than creating one.
   */
  recurring: { read: READ_ALL, create: WRITE, update: WRITE, delete: ADMIN_ONLY },

  // Period locks: viewing is open; locking (create) and unlocking (delete) are
  // admin-only — stricter than generic writes, preserved from pre-M5.
  period_locks: { read: READ_ALL, create: ADMIN_ONLY, delete: ADMIN_ONLY },

  // Global user administration (documentation/future use — see header note).
  users: { read: ADMIN_ONLY, create: ADMIN_ONLY, update: ADMIN_ONLY },

  // Audit trail — admin-only read (M7). Writes are done by the audit service on
  // every mutation, not via a route, so only `read` is enforced here.
  audit_logs: { read: ADMIN_ONLY },

  /**
   * Findings (AI-3a) — deterministic internal-consistency checks. READ is
   * open (review assistance, like reports); CREATE covers POST /run — running
   * the checks writes finding rows but moves nothing, the same authority
   * class as `categorize`. `approve` gates POST /:id/acknowledge: an
   * acknowledgement is a REVIEW DECISION ("this duplicate is intentional")
   * that dismisses a warning about money, so it carries approver authority —
   * the M16 "accepting the match IS the review" principle, applied to the
   * dismissal direction.
   */
  // `update` (AI-5) gates PUT /findings/schedule — the review cadence is a
  // review decision, so it sits with acknowledge at approver level.
  findings: { read: READ_ALL, create: WRITE, update: APPROVE, approve: APPROVE },
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
