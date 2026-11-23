import { ownerDb } from "./index";
import { permissionsTable } from "./schema";

/**
 * RBAC permission matrix — the seeded role → resource → action mapping the API
 * enforces (via `requirePermission`). This is the **source of truth for policy
 * data**; a future phase can extend/adjust access by changing these rows (and
 * reconciling — `permissions:reconcile`, 19B S0) without touching route code. The API refuses to start while the
 * table differs from this matrix; docs/product/permissions-reconcile-runbook.md.
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

/**
 * 🔴 19B S1 (v4 §4–§6) — FIELD-CLASS GRANTS. Every field a record serves carries a class
 * (apps/api/src/lib/fieldClasses/classTable.ts). Reading a protected class's field needs `field.<class>.read` on the
 * record's resource — `field.bank_account.last4` shows an IBAN's last four digits only — and writing it needs
 * `field.<class>.write`. `standard` needs nothing beyond the record's own grant.
 */
export const PROTECTED_FIELD_CLASSES = ["contact", "identity", "compensation", "bank_account", "bank_narrative", "member_security"] as const;
export type ProtectedFieldClass = (typeof PROTECTED_FIELD_CLASSES)[number];
export type FieldLevel = "read" | "write" | "last4";
/** The levels each class has: only an IBAN has a partial level (v4 §4). */
export const FIELD_CLASS_LEVELS: Record<ProtectedFieldClass, readonly FieldLevel[]> = {
  contact: ["read", "write"],
  identity: ["read", "write"],
  compensation: ["read", "write"],
  bank_account: ["read", "last4", "write"],
  bank_narrative: ["read", "write"],
  member_security: ["read", "write"],
};
export type FieldGrantAction = `field.${ProtectedFieldClass}.${FieldLevel}`;
export const fieldGrantAction = (cls: ProtectedFieldClass, level: FieldLevel): FieldGrantAction => `field.${cls}.${level}`;

/**
 * 🔴 19B S4 (v4 §4, §6.2) — REPORT DATASET ACTS. A report dataset is a resource `report_dataset.<name>`; what a role may
 * do with it is one grant per act. `decide()` (apps/api/src/lib/reports/decide.ts) reads them, and a dataset never
 * widens a role beyond its native resources' read. `schedule` is to oneself; `deliver` is to other members, each
 * recipient checked against their own grants (S6).
 */
export const REPORT_ACTS = ["run", "export", "schedule", "deliver", "save", "share"] as const;
export type ReportAct = (typeof REPORT_ACTS)[number];
export const reportDatasetResource = (dataset: string): string => `report_dataset.${dataset}`;

export type PermissionAction = "read" | "create" | "update" | "delete" | "approve" | FieldGrantAction | ReportAct;

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
  // Phase 15 (D15-12): a budget version is approved / sent back / rejected by an
  // approver — the invoices/bills split: a bookkeeper drafts and submits.
  budgets: { read: READ_ALL, create: WRITE, update: WRITE, approve: APPROVE, delete: ADMIN_ONLY },

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
  // D-4 (2026-09-17): a payment is a posting (Dr bank / Cr AR or deposits), so
  // CREATE is approver-level, the same authority as `pay` and `settle`;
  // `allocate` / `apply` resolve to `approve` (rbac.ts).
  payments: { read: READ_ALL, create: APPROVE, approve: APPROVE },
  // Batch 1C (2026-09-18): a migration is run by an ADMIN only (pack §D-1 §11);
  // an accountant may read its record and reconciliation.
  migration: { read: APPROVE, create: ADMIN_ONLY, update: ADMIN_ONLY, approve: ADMIN_ONLY, delete: ADMIN_ONLY },
  // Phase 13B S1 (2026-09-30, owner decision D4): an opening payable's
  // historical input-VAT position is declared by an ADMIN or an ACCOUNTANT —
  // a dedicated resource, so the accountant gains this act without gaining
  // migration write. Append-only: no update or delete exists (0110).
  opening_vat_declaration: { read: APPROVE, create: APPROVE },

  /**
   * Phase 16 (migration 0113) — Saudi tax. Everyone reads (the obligations are
   * the business's own); a bookkeeper DRAFTS a Zakat or income-tax computation,
   * its adjustments, the Zakat classification and a treaty relief; an APPROVER
   * approves a computation (which posts its accrual), approves a treaty relief
   * (which lowers a rate), remits WHT to ZATCA (`/pay`) and reverses a
   * remittance. Deleting a never-approved computation is an admin's.
   */
  tax: { read: READ_ALL, create: WRITE, update: WRITE, approve: APPROVE, delete: ADMIN_ONLY },
  /**
   * Phase 17 (migrations 0114, 0115) — Treasury. A bookkeeper plans payments
   * and records forecast assumptions, and edits a plan while it is still only
   * planned; an APPROVER approves a plan, pays it through the bill pay path
   * (`/pay`) and cancels one with its reason (`/reject`). DELETE — a plan never
   * approved, a forecast assumption — is admin-only like every delete in this
   * matrix (0114 had granted it to WRITE; 0115 corrected it). The minimum cash
   * buffer is an approver's policy (`treasury_settings`).
   */
  treasury: { read: READ_ALL, create: WRITE, update: WRITE, approve: APPROVE, delete: ADMIN_ONLY },
  treasury_settings: { read: READ_ALL, update: APPROVE },

  // Read + create only (no update/delete routes today).
  categories: { read: READ_ALL, create: WRITE },
  // payroll: the /:id/approve activation needs approver authority. 🔴 19B S2a (D8 O2): an accountant or admin PREPARES
  // a run too — create (generate and submit: `submit` resolves to create) is no longer a bookkeeper's (S2A_REMOVALS).
  payroll: { read: READ_ALL, create: APPROVE, approve: APPROVE },
  llm: { read: READ_ALL, create: WRITE },

  // Company settings (M11.6): everyone may READ the company profile (it is
  // displayed on invoices and reports), but only an admin may change the legal
  // identity — the VAT/CR numbers feed the ZATCA QR and invoice hash chain.
  // `delete` (L1, 2026-09-14) covers exactly one route today — removing the
  // company LOGO — and is admin-only for the same reason update is.
  companies: { read: READ_ALL, update: ADMIN_ONLY, delete: ADMIN_ONLY },
  /**
   * 🔴 19B S3 (v4 §6.3, D2): held bank-detail changes. READ: every role sees the list (as under `companies` before; each
   * IBAN in it is withheld by its own record's grants). APPROVE: deciding a held change — an accountant or an admin who
   * is not the requester approves a supplier's or an employee's IBAN; the database reads this grant LIVE
   * (org_bank_detail_approver_ids, 0170), and the company's own bank accounts stay an admin's (DR-23, enforced there).
   */
  bank_detail: { read: READ_ALL, approve: APPROVE },

  /**
   * ZATCA onboarding (M12.4). Read is open so any role can see the prerequisite
   * checklist and the certificate expiry; CREATE is admin-only because it mints
   * the credential that signs the tenant's legally-valid tax invoices.
   */
  zatca_onboarding: { read: READ_ALL, create: ADMIN_ONLY },

  // Read-only resources.
  reports: { read: READ_ALL },
  summary: { read: READ_ALL },

  /**
   * 🔴 19B S4 — the first report dataset: journal lines in the books (v4 §14). A VIEWER dataset (D3): a viewer runs it,
   * exports what it may run, schedules to itself and saves; delivering to others and sharing a definition are not a
   * viewer's (§6.2). Its native resource is `journal_entries` (read, every role today).
   */
  "report_dataset.journal_lines": { run: READ_ALL, export: READ_ALL, schedule: READ_ALL, save: READ_ALL, deliver: WRITE, share: WRITE },

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

  /**
   * 🔴 Phase 18 R-11a — DR-14's control flags (register §11.111): where one person did both halves of something a
   * second person usually does. READ by the approvers only — the people a flag is for; nobody writes them through a
   * route (the act a flag describes writes it, migration 0154), so no other action exists.
   */
  control_flags: { read: APPROVE },

  /**
   * 🔴 Phase 18 R-11b — DR-13's ACTION-LEVEL GRANTS for the acts DR-20 classifies (register §11.111): posting to a
   * cash, a tax or an equity account. Held by the approvers. They gate no route: the DATABASE reads them at the
   * draft → posted flip (migration 0155), and a posting by an actor without the grant for a class its lines touch is
   * refused where the organisation has two or more usable approvers, and flagged where it has one. SEEDED, never
   * editable at runtime — G44 becomes a dependency the day they are.
   */
  gl_cash_posting: { approve: APPROVE },
  gl_tax_posting: { approve: APPROVE },
  gl_equity_posting: { approve: APPROVE },

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

  /**
   * Grounded answers (AI-6a). READ open — the stored record of what the AI
   * said is review material like reports. CREATE (asking) at write level: a
   * question costs metered tokens and writes an auditable row, the same
   * class as `categorize`; a viewer reads the record and does not spend.
   */
  ask: { read: READ_ALL, create: WRITE },
};

/**
 * 🔴 19B S1 — the field-class grants, PER RESOURCE, so each S2 step switches withholding on for its own records only
 * (2a: employees and payroll) and never for a record whose screens have not been adapted yet.
 *
 * 🔴 S1: EVERY ROLE READS EVERY CLASS, AND EVERY ROLE THAT WRITES WRITES EVERY CLASS — except where an S2 step has
 * narrowed it. 🔴 S2a (v4 §6.1 D2, §10 D8 O2): on employees and payroll, only an accountant or admin reads identity and
 * pay or writes pay; a bookkeeper writes the national ID without reading it back and sees an IBAN's last four digits
 * (S2A_REMOVALS). A viewer holds no `write` level: it holds no write grant on any record either, so the level could
 * never be used, and "a viewer holds read and nothing else" stays true (tests/permission-seed-grants.test.ts).
 * Narrowing a role is a REMOVAL: the reconcile applies it per environment only with the owner's approval of the exact
 * set (D10, docs/product/permissions-reconcile-runbook.md). The (resource, class) pairs here are exactly the ones the
 * class tables use (apps/api/src/tests/field-class-grants.test.ts, both directions).
 */
const FIELD_SPEC: Record<string, Partial<Record<ProtectedFieldClass, Partial<Record<FieldLevel, readonly PermissionRole[]>>>>> = {
  employees: {
    identity: { read: APPROVE, write: WRITE },
    compensation: { read: APPROVE, write: APPROVE },
    bank_account: { read: APPROVE, last4: WRITE, write: WRITE },
  },
  payroll: {
    compensation: { read: APPROVE, write: APPROVE },
  },
  customers: {
    contact: { read: READ_ALL, write: WRITE },
    identity: { read: READ_ALL, write: WRITE },
  },
  vendors: {
    contact: { read: READ_ALL, write: WRITE },
    bank_account: { read: READ_ALL, last4: READ_ALL, write: WRITE },
  },
  migration: {
    contact: { read: READ_ALL, write: WRITE },
  },
  transactions: {
    bank_narrative: { read: READ_ALL, write: WRITE },
  },
  journal_entries: {
    bank_narrative: { read: READ_ALL, write: WRITE },
  },
  audit_logs: {
    member_security: { read: READ_ALL, write: WRITE },
  },
  users: {
    member_security: { read: READ_ALL, write: WRITE },
  },
};

/**
 * 🔴 19B S2a — THE REMOVALS THAT SWITCH WITHHOLDING ON FOR EMPLOYEES AND PAYROLL (v4 §6.1 D2, §10 D8 O2).
 *
 * 🔴 REMOVED FROM PERMISSION_MATRIX (SPEC's payroll create, FIELD_SPEC's employees and payroll). A database's table
 * loses them only through the reconcile with the owner's approval string for THAT environment and this exact set
 * (sha256 b92b750c…63d7, D10); until then main's API refuses to start against it (the startup check names the twelve).
 * Declared ONCE, here, so the per-environment dry run, the approval string and the tests name the same set
 * (field-class-grants.test.ts pins that none is granted any more, and the set's hash).
 *
 * The bookkeeper KEEPS `field.bank_account.write` and `field.bank_account.last4` on employees: IBAN entry stays as it is
 * until S3 holds it for an approver (owner, 2026-11-22), and reads show the last four digits.
 */
export const S2A_REMOVALS: readonly (PermissionRow & { fieldClass: ProtectedFieldClass | null; why: string })[] = [
  { role: "viewer", resource: "employees", action: "field.identity.read", fieldClass: "identity", why: "viewer: identity none (D2)" },
  { role: "viewer", resource: "employees", action: "field.compensation.read", fieldClass: "compensation", why: "viewer: compensation none (D2)" },
  { role: "viewer", resource: "employees", action: "field.bank_account.read", fieldClass: "bank_account", why: "viewer: bank_account none (D2)" },
  { role: "viewer", resource: "employees", action: "field.bank_account.last4", fieldClass: "bank_account", why: "viewer: bank_account none — not even the last four (D2)" },
  { role: "bookkeeper", resource: "employees", action: "field.identity.read", fieldClass: "identity", why: "bookkeeper: writes the national ID, never reads it back (D2)" },
  { role: "bookkeeper", resource: "employees", action: "field.compensation.read", fieldClass: "compensation", why: "bookkeeper: compensation none (D2, O2)" },
  { role: "bookkeeper", resource: "employees", action: "field.compensation.write", fieldClass: "compensation", why: "bookkeeper: compensation none — so no pay, GOSI, status, dates, nationality or GOSI number (D1, D2, O2)" },
  { role: "bookkeeper", resource: "employees", action: "field.bank_account.read", fieldClass: "bank_account", why: "bookkeeper: the last four digits only (D2)" },
  { role: "viewer", resource: "payroll", action: "field.compensation.read", fieldClass: "compensation", why: "viewer: no pay lines (D2)" },
  { role: "bookkeeper", resource: "payroll", action: "field.compensation.read", fieldClass: "compensation", why: "bookkeeper: no pay lines (D2, O2)" },
  { role: "bookkeeper", resource: "payroll", action: "field.compensation.write", fieldClass: "compensation", why: "bookkeeper: no pay lines (D2, O2)" },
  { role: "bookkeeper", resource: "payroll", action: "create", fieldClass: null, why: "bookkeeper: no longer prepares payroll runs (D8 O2)" },
];

/** The flattened matrix: one row per (role, resource, action) grant — the route grants, then the field grants. */
export const PERMISSION_MATRIX: PermissionRow[] = [
  ...Object.entries(SPEC).flatMap(([resource, actions]) =>
    Object.entries(actions).flatMap(([action, roles]) =>
      (roles ?? []).map((role) => ({ role, resource, action: action as PermissionAction })),
    ),
  ),
  ...Object.entries(FIELD_SPEC).flatMap(([resource, classes]) =>
    Object.entries(classes).flatMap(([cls, levels]) =>
      Object.entries(levels ?? {}).flatMap(([level, roles]) =>
        (roles ?? []).map((role) => ({ role, resource, action: fieldGrantAction(cls as ProtectedFieldClass, level as FieldLevel) })),
      ),
    ),
  ),
];

export interface SeededPermissions {
  inserted: number;
  total: number;
}

/**
 * Idempotently seed the permission matrix. New (role, resource, action) grants
 * are inserted; existing ones are left untouched (unique constraint on the
 * triple). Safe to re-run. Rows removed from the matrix are NOT deleted here —
 * pruning stale grants is the reconcile command's, with the owner's approval (./permissionReconcile.ts).
 */
export async function seedPermissions(): Promise<SeededPermissions> {
  const inserted = await ownerDb
    .insert(permissionsTable)
    .values(PERMISSION_MATRIX)
    .onConflictDoNothing()
    .returning({ id: permissionsTable.id });

  const all = await ownerDb.select({ id: permissionsTable.id }).from(permissionsTable);
  return { inserted: inserted.length, total: all.length };
}
