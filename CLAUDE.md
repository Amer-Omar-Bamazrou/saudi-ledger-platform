# CLAUDE.md

Guidance for Claude Code (and any AI agent) working in this repository.

## 1. Project Overview

This is the **Saudi Ledger Platform** — an AI-powered Accounting & Finance
Operating Platform for Saudi Arabia, and later the wider GCC.

It began life as a single-tenant bookkeeping app (the "Saudi Ledger Engine") and
is **currently being refactored into a scalable, multi-tenant SaaS platform**.
The accounting core is real and correct — invoices, bills, journal entries, GL
posting, period locks, VAT, and Zakat all work today. The refactoring effort is
about the _platform_ around that core: multi-tenancy, clean layering, security,
and a foundation for future AI features.

When in doubt, favor evolving the existing system over replacing it.

## 2. Current State — Phase 0: Platform Foundation

We are in **Phase 0 (Platform Foundation)**, working through small milestones to:

- Restructure the architecture into clean, testable layers
- Add **multi-tenancy** (organization scoping) across all business data
- Fix security gaps (e.g. session secrets, per-tenant isolation, access control)
- Prepare the groundwork for future AI features

Multi-tenancy is enforced at the database layer (Milestone 3) **and now actively
at runtime (Milestone 4)**. The platform tables (`organizations`, `companies`,
`branches`, `departments`, `organization_memberships`, `audit_logs`,
`permissions`, `feature_flags`) exist; a bootstrap tenant
(`organizations.slug = 'default'` + a "Default Company") is seeded; and every
existing business row was backfilled to it. On all business tables
`organization_id` (and `company_id` on ledger/operational tables) is **NOT NULL**
with FKs to `organizations` / `companies`, backed by composite indexes leading
with `organization_id`. `period_locks` uniqueness is tenant-scoped
(`unique(organization_id, company_id, period)`). **RLS is enabled** on every
business table (+ `audit_logs`, `companies`, `branches`, `departments`) with a
`tenant_isolation` policy keyed off the `app.current_org_id` session GUC; a
cross-tenant isolation test suite (`packages/db/src/__tests__`) proves org A
cannot read or mutate org B's rows.

**Milestone 4 (Auth, Session & Tenant Context Hardening) is done:**

- **RLS is now actively enforced, not dormant.** Each authenticated request runs
  inside a per-request transaction that drops to a **non-owner, non-BYPASSRLS**
  Postgres role via `SET LOCAL ROLE` (config `DB_APP_ROLE`, default Supabase
  `authenticated`) and sets `app.current_org_id` / `app.current_company_id`
  transaction-locally. The pool still logs in as the owner (`postgres`) — used
  only for migrations, seeding, login, the session store, and tenant resolution.
  RLS is granted to the app role via **explicit per-object** GRANTs in
  `0004_m4_rls_enforcement.sql` (never `ON ALL TABLES` — see
  [supabase-local-rls-testing memory / §landmine]). We deliberately do **not**
  `FORCE ROW LEVEL SECURITY` (the owner has BYPASSRLS, so FORCE is moot for it).
- **`resolveTenant` middleware** (`apps/api/src/lib/tenant.ts`) runs after
  `requireAuth`, resolves the active organization from the session +
  `organization_memberships` (defaulting to the primary membership), attaches a
  `TenantContext { userId, organizationId, companyId, role }` to `req`, and opens
  the RLS-scoped transaction. Connection handling: an `AsyncLocalStorage` +
  `db` **Proxy** in `packages/db` routes existing `import { db }` call sites onto
  the request's scoped client with **no route changes**; the transaction commits
  on a successful response and rolls back on error/abort, so tenant context never
  leaks across pooled connections.
- **Tenant role is sourced from `organization_memberships`** (`req.tenant.role`).
  Global user management uses the session role (see M5 boundary note). The 3-role
  model (`admin | accountant | viewer`) is unchanged.
- **M3 bootstrap-tenant DB DEFAULTs are removed.** `app_default_org_id()` /
  `app_default_company_id()` are dropped; `organization_id` / `company_id` now
  default to the **request tenant** via `current_setting('app.current_org_id')` /
  `current_setting('app.current_company_id')`. No tenant context ⇒ default NULL ⇒
  NOT NULL rejects the write (fail-safe), and RLS `WITH CHECK` independently
  guarantees correctness.
- **Security hardening:** validated env config in `@workspace/config` (fail-fast
  at boot, no `SESSION_SECRET` fallback); explicit CORS allow-list
  (`CORS_ALLOWED_ORIGINS`); cookies `httpOnly` + `sameSite=lax` + `secure` in
  production; the localStorage bearer-token workaround is **fully removed** (auth
  is the httpOnly session cookie only); rate limiting on `/auth/login`,
  `/auth/register`, `/auth/change-password`.
- **Org switcher:** `GET /api/orgs` (list memberships) + `POST /api/orgs/switch`
  (set `session.activeOrgId`), mounted **before** `resolveTenant` (cross-org);
  minimal unstyled selector in the web sidebar.

**Milestone 5 (RBAC Foundation) is done — authorization is centralized and
permission-based (still the 3-role model, enforcement consolidated):**

- **One authorization seam: `requirePermission(resource)`** (`apps/api/src/lib/rbac.ts`).
  It reads the active-org role from `req.tenant.role` (never global `users.role`),
  infers the action from the HTTP method (`GET`→read, `POST`→create,
  `PUT/PATCH`→update, `DELETE`→delete), and checks it against the seeded
  role→resource→action mapping. **Fail-closed**: no matching grant ⇒ 403. This
  **replaced** the old blanket method guard in `routes/index.ts` and the ad-hoc
  `requireTenantRole` guards on `period_locks`/`categorize`; every business route
  now mounts as `router.use("/x", requirePermission("x"), x)`.
- **Policy lives in data, not code.** The mapping is the `permissions` table,
  seeded idempotently from `PERMISSION_MATRIX` in `packages/db/src/permissions.ts`
  (via `seedPermissions()`, run by `pnpm --filter @workspace/db run seed`). The API
  loads it once into an in-memory cache (restart to pick up re-seeds). A future
  phase changes access by editing/seeding rows — no route changes.
- **The matrix codifies pre-M5 behavior exactly** (no policy change): read=all;
  create/update=admin+accountant; delete=admin; with `period_locks` create+delete
  admin-only, and `categorize` create=admin+accountant. Accountants retain
  post-to-GL / reverse / pay / approve (industry-standard default).
- **Boundary — user management:** the `/auth` user-admin endpoints (`register`,
  `GET/PATCH /users`, `reset-password`) remain guarded by the **session-role**
  `requireAdmin`. They run *before* `resolveTenant` and manage the **global**
  identity directory (no active org), so they can't read `req.tenant.role`. A
  `users` resource is seeded into the matrix for completeness and the future
  per-org membership-management phase, but is not yet wired to `requirePermission`.

**Milestone 6 (Backend Layering Refactor) is done — the API is now layered:**

- **Route → Controller → Service → Repository** across all 18 business domains.
  `routes/` are thin (validate → call controller); `controllers/` orchestrate and
  shape responses (no DB); `services/` own business logic; `repositories/` own
  **all** Drizzle access, tenant-scoped via RLS. No business route touches the DB
  directly (only `auth`/`orgs` remain thin infra routes with their own access).
- **Accounting core moved UNCHANGED** to `services/accounting/` (glPosting,
  periodLock, zatca) and `services/categorization/` (categorizer, llmCategorizer).
  These are the sanctioned exception that keep direct `db` access — services call
  them; they are not rewritten.
- **Centralized error handling** (`middleware/errorHandler.ts` + typed `AppError`
  in `lib/errors.ts`). Controllers/services `throw`; the middleware maps to HTTP
  (identical bodies/status to before, incl. structured bills-post 400s via
  `BusinessRuleError.payload` and the reports `{error:String(err)}` 500s).
- **`reports.ts` (860 lines) split** into `routes/reports/<report>.ts` (one module
  per report type) over a shared `reports.service` + `reports.repository`; the
  deferred `sql.raw` id-lists are now parameterized `inArray(...)`.
- No API behavior or permission change — a structural refactor, verified live per
  domain group. The draft/approval workflow is NOT built here (post-M6 milestone),
  but the service layer is where it will slot in.

Write new code in this layered shape: HTTP in the route/controller, logic in a
service, and every query in a repository (tenant-scoped).

**Milestone 8 (CI/CD) is done — automated checks on every PR + push to main.**
`.github/workflows/ci.yml` runs three jobs: **typecheck** (`pnpm run typecheck`),
**test** (spins up a `postgres:16` service, bootstraps the non-owner
`authenticated` role, applies migrations, then runs the DB-free API tests **and**
the DB-backed RLS-isolation + rollback tests), and **build** (`pnpm run build`).
Node is pinned via `.nvmrc` (24) and pnpm via the root `packageManager` field.
These three checks should be **required** for merging to `main` (branch
protection). Not yet included (in the plan, future add): OpenAPI codegen drift and
migration-schema drift checks, and a lint job (no ESLint config exists yet).

**Milestone 7 (Audit Logging) is done — every business mutation is recorded,
append-only and tenant-scoped.** A single `auditService` (`services/audit.service.ts`)
writes one `audit_logs` row per logical mutation, called from the **service layer**
inside the request's tenant transaction — so an audit row commits **atomically with
the mutation** (a rolled-back request records nothing; we only log what committed).
Actor/org/IP come from an `auditContext` AsyncLocalStorage set once by
`resolveTenant`, so services only describe *what* changed. `action` is a free string
(create | update | delete + mapped state transitions like post/pay/approve/reverse/
depreciate today; the future draft/approval workflow emits `submit`/`approve`/`reject`
through the same service). Bulk operations (transaction upload, auto-categorize)
record **one summary** record, not one per row. Append-only is enforced in the DB:
migration `0006` **revokes UPDATE/DELETE** on `audit_logs` from the app role (INSERT +
SELECT only). Read via `GET /api/audit-logs` (tenant-scoped, **admin-only** through
`requirePermission("audit_logs")`).

**Milestone 9 (Repository Finalization) is done — Phase 0 is complete.** The repo
is documented so a new engineer can clone it and become productive from the docs
alone: a rewritten `README.md`, `CONTRIBUTING.md` + `.github/PULL_REQUEST_TEMPLATE.md`,
`docs/local-setup.md` (end-to-end local run), and `docs/development-guide.md`
(layering, tenancy/RLS, RBAC, audit, and an "add a new domain" cookbook). Two
small **real-blocker fixes** landed with it (not just docs):

- **Seed now produces a working admin.** `seedAdminUser` (`packages/db/src/seed.ts`)
  additionally creates an **active `admin` membership** in `organization_memberships`
  linking the seeded admin to the default org — idempotent on the unique
  `(user_id, organization_id)` constraint. Without it a freshly seeded admin could
  log in but got 403 on every business route (no membership ⇒ `resolveTenant`
  denies). Verified: fresh `migrate` + `seed` → admin logs in and hits business
  routes (200, not 403).
- **Local two-port dev now connects.** `apps/web/vite.config.ts` adds a **dev-only**
  `server.proxy` forwarding `/api` → `http://localhost:3000` (override via
  `API_PROXY_TARGET`). The frontend still calls the API same-origin at `/api`
  (unchanged); the proxy only makes local dev mirror single-origin production and
  has **no effect on the production build**.

Licensing: the project is **proprietary / all rights reserved** (private,
commercial); `package.json` is `"UNLICENSED"` and **no `LICENSE` file** is
included by design.

**Milestone 10 (Draft/Approval Workflow + 4-Role Model) — COMPLETE.** A
universal draft→approval workflow across the five financial records (journal
entries, invoices, bills, payroll runs, and invoice/bill payments) backed by a
4-role model that adds **Bookkeeper** (enters drafts, cannot approve). Every
financial record is created as a draft that does **not** affect the books (GL,
balances, reports, VAT/Zakat) until approved; approval fires each entity's
existing activation path (JE post, bill/payroll GL posting, invoice AR + ZATCA
hashing) through the unchanged accounting core. Built in sub-milestones M10.1–M10.6.
Full design: [`docs/feature-spec-draft-approval-workflow.md`](docs/feature-spec-draft-approval-workflow.md)
(now marked implemented).

The five entities all flow through ONE generic engine (`services/approval/`) via
an `Approvable` adapter each — the engine was never forked. State machine:
`draft → submitted → approved` with `submit` (bookkeeper), `send-back` (approver,
returns to an editable draft with a `review_note`), `approve` (approver, fires
the on-approve activation), and `reject` (hard-delete, no archive). Approvers
self-approve-on-create where that preserves prior one-call behavior (invoices);
JE and payroll keep their native flows (JE approves straight from draft; payroll
stays two-step). Every transition is audited in `audit_logs`
(`submit`/`send_back`/`approve`/`reject`/`pay`).

- **Known, intentional limitation (decided, DOCUMENTED — not a bug):** the
  `transactions` table is the **raw operational feed** and is **NOT**
  approval-gated in M10. It has no status/approval column, and it feeds the
  **dashboard summary, VAT summary, Zakat base, cash flow, and budget actuals** —
  so **those figures reflect ALL transactions regardless of approval status**.
  This boundary is deliberate: pulling the highest-traffic operational path into
  the approval workflow was explicitly kept out of M10 to avoid scope-creep at the
  finish line. Gating transactions is a **deferred future feature**, not part of
  M10. Visible and intentional, not an oversight. (Also recorded in the feature
  spec.)
- **M10.1 (done): Role + RBAC `approve` action.** Added `bookkeeper` to the role
  model and a distinct `approve` action to the permission matrix
  (`packages/db/permissions.ts`): create/update → admin+accountant+**bookkeeper**;
  `approve` → admin+accountant only; delete/user-admin → admin. `requirePermission`
  gained an **action-route override** (`lib/rbac.ts`): a POST to an activation
  sub-route (`/:id/{post,approve,pay,reject,reverse}`) resolves to `approve`, not
  the method-inferred `create` — so a bookkeeper who can enter a draft (`POST /`)
  is fail-closed out of activating it. Re-seed permissions + restart to apply. No
  record lifecycle change yet (that starts M10.2).
- **M10.2 (done): generic approval engine + Journal Entries proven end-to-end.**
  The reusable seam every later entity plugs into:
  - **`Approvable<E,S>` contract** (`services/approval/approvable.ts`) +
    **`approvalService`** (`services/approval/approval.service.ts`). The service
    is entity-agnostic: it owns the state machine (`approve`: pending→approved
    fires the entity's on-approve action; `reject`: hard-deletes a pending draft,
    no archive per spec §4) and writes the audit entry (`approve`/`reject`) inside
    the request tenant tx — so the audit row commits atomically with the effect.
    M10.3–M10.5 add an entity by writing an adapter, **never** by editing the
    engine. Guards are fail-closed (re-approve → 409; reject non-pending → 409;
    missing → 404).
  - **JE adapter** (`services/journalEntries.approvable.ts`): maps the JE's native
    `draft|posted|reversed` onto the abstract `pending|approved`
    (`draft→pending`, `posted`/`reversed`→`approved`); `onApprove` runs the
    **existing** post-to-GL path **unchanged** — period-lock check **at approval
    time** (spec Q#5), then `status→posted` + `postedAt`. **No accounting-core
    change and no schema/migration**: reports already gate on `status='posted'`,
    and approver identity is captured in `audit_logs` (JE keeps `postedAt`; no new
    `approved_by` column). `buildJEOut` extracted to `journalEntries.presenter.ts`
    to break the service↔adapter import cycle.
  - **Endpoints (OpenAPI-first):** added `POST /journal-entries/:id/approve` and
    `/:id/reject` to the spec (+ `JournalEntry`/`JournalEntryLine` schemas) and
    regenerated the zod + react-query client. Both resolve to the `approve` action
    via the existing suffix override (bookkeeper 403). `/:id/post` is kept as the
    JE-native alias for `approve` (the web app calls it) and now flows through the
    same seam; `/:id/reverse` is unchanged (a post-approval action, not part of
    the workflow).
  - **The non-negotiable test — the M10 template:**
    `tests/je-approval-zero-movement.test.ts` proves through the **real report
    services** that a PENDING draft moves **zero** in trial balance, income
    statement, general ledger, journal report, and balance sheet — and that
    **approval** is what posts it (movement then appears) — plus that create +
    approve are audited. It also asserts the draft **is** visible in the
    operational `activity` worklist (spec §7/§8: listed operationally, excluded
    from financial aggregates). M10.3–M10.5 each replicate this shape per entity.
    A DB-free unit test (`tests/approval.test.ts`) drives the engine through a
    fake adapter to prove it is entity-agnostic.
- **M10.3 (done): Bills + the full state machine generalized into the engine.**
  Bills exercise the complete workflow and become the template for invoices/payroll:
  - **Engine generalized** (`services/approval/`): abstract state is now
    `draft | submitted | approved` (was pending|approved), and the engine gained
    two transitions alongside `approve`/`reject`: **`submit`** (draft→submitted,
    enter the approval queue) and **`sendBack`** (submitted→draft, with a reviewer
    note — spec §4's return-for-edit loop). All four transitions stay
    entity-agnostic and audited (`submit`/`send_back`/`approve`/`reject`). The JE
    adapter maps `draft→draft` and omits `onSubmit`/`onSendBack` (JE has no
    editable-draft stage; it is approved straight from draft) — M10.2 behavior
    unchanged.
  - **State model (owner decision):** `draft` = editable, not in the approver's
    queue, not in the books; `submitted` = **locked** (edit → 409), in the queue;
    `received`/`paid`/`overdue` → `approved`. "Whose queue is this in" is a
    definite state, not an inferred flag. A bill's **`submit`** is a bookkeeper
    (create-level) action; **`approve`/`send-back`/`reject`/`pay`** are
    approver-only (`send-back` added to the `requirePermission` activation-route
    override). One new column: `bills.review_note` (migration
    `0007_m10_3_bill_review_note`) — the correction shown to the enterer, cleared
    on resubmit/approve. `create` now always yields a `draft` (caller status
    ignored).
  - **Bill adapter** (`services/bills.approvable.ts`, a per-request factory
    carrying `debitAccount`/`force`): `onApprove` is the **existing** bill
    post-to-GL path moved in unchanged (totals reconcile, ZATCA vendor-VAT, Dr
    Purchases/Input VAT / Cr AP). `buildBillOut` extracted to
    `bills.presenter.ts`.
  - **Approved-only report filters:** AP aging, balance-sheet Accounts Payable,
    and the VAT-return input-VAT/bill side now exclude `draft`+`submitted`
    (`approvedBillsOnly()` in `reports.repository.ts`) — a pre-approval bill has
    zero AP/expense/VAT impact. (Invoice-side report filters land in M10.4.)
  - **Pre-existing bill-pay 500 fixed:** paying with a missing/invalid `amount`
    reached the numeric column and surfaced as an unhandled **500**; `pay` now
    validates the amount (**400**) and requires the bill to be approved first
    (draft/submitted → 409, already-paid → 409) before posting Dr AP / Cr Cash.
  - **Endpoints (OpenAPI-first):** `POST /bills/:id/{submit,send-back,approve,reject}`
    added to the spec (+ `Bill`/`BillItem`/`BillApproveInput`/`SendBackInput`
    schemas), client regenerated. `/:id/post` kept as the approve alias; `/:id/pay`
    unchanged surface (hardened logic).
  - **Bill zero-movement test** (`tests/bills-approval-zero-movement.test.ts`) —
    the JE template applied to AP: draft AND submitted move zero in AP aging /
    balance-sheet AP / VAT input; submit→send-back→resubmit→approve posts it;
    submitted is edit-locked; draft is not payable; pay-500 is now 400; every
    transition audited.
- **M10.4 (done): Invoices — ZATCA hash chain + AR posting deferred to approval.**
  The highest-risk sub-milestone; engine reused unchanged.
  - **Hash chain built ONLY at approval (the single most important M10 property).**
    Pre-M10, invoice `create` eagerly minted the ZATCA hash-chain link + QR **and**
    posted AR. Now `create` persists a **draft** with `invoice_hash = NULL` and no
    GL; the chain link, QR, and Dr AR / Cr Sales+VAT posting are all minted in the
    invoice adapter's `onApprove` (`services/invoices.approvable.ts`), atomically
    within the request tenant tx. Because `getPreviousInvoiceHash` only reads
    non-null-hash (approved) invoices, a draft is invisible to the chain and
    **consumes no sequence number** — a rejected/deleted draft never leaves a gap
    in the legally-required sequence. Proven by
    `tests/invoices-hash-chain-continuity.test.ts` (drafts carry no hash; an
    approval created after an intervening draft chains to the last *approved*
    invoice; a deleted draft leaves no gap; exactly one GENESIS root; every link
    points at a real prior hash).
  - **Self-approve-on-create keeps approver behavior identical to pre-M10.** The
    controller asks the RBAC matrix (`can(role,"invoices","approve")`, new export
    in `lib/rbac.ts`) and passes `autoApprove`; an admin/accountant `create` issues
    the invoice immediately (hash + QR + AR) in one call, while a bookkeeper's
    `create` stays a `draft` awaiting approval.
  - **State model** mirrors bills: `draft` (editable, unhashed, not in AR/VAT) →
    `submitted` (locked, queued) → `sent` (approved/issued). Migration
    `0008_m10_4_invoice_review_note` adds `invoices.review_note`. `submit` is a
    bookkeeper action; `approve`/`send-back`/`reject`/`pay` are approver-only.
    Invoice `pay` hardened like bills (approved-only + amount validation → 400).
  - **Approved-only AR filters:** AR aging, balance-sheet AR, VAT-return
    sales/output-VAT side, **and** customer ledger now exclude `draft`+`submitted`
    (`approvedInvoicesOnly()`).
  - **Endpoints (OpenAPI-first):** `POST /invoices/:id/{submit,send-back,approve,reject}`
    + `Invoice`/`InvoiceItem` schemas; client regenerated. `buildInvoiceOut` →
    `invoices.presenter.ts`.
  - **Zero-movement test** (`tests/invoices-approval-zero-movement.test.ts`):
    draft AND submitted move zero in AR aging / balance-sheet AR / VAT output;
    approval issues it (AR + hash/QR); submitted edit-locked; draft not payable;
    self-approve-on-create issues immediately; all transitions audited.
- **M10.5 (done): Payroll runs — engine reused, adapter only.**
  - **Payroll's only ledger effect is the GL entry posted at approval** — no
    report reads `payroll_runs` directly, so a draft/submitted run posts nothing
    (zero movement) and needs no approved-only report filter. The adapter
    (`services/payroll.approvable.ts`) `onApprove` runs the **existing** payroll
    GL posting unchanged (Dr Salaries + Employer GOSI / Cr Net Pay + GOSI
    Payable); `onSubmit`/`onSendBack` manage the queue + review note; GOSI
    arithmetic untouched. `runToOut`/`itemToOut` → `payroll.presenter.ts`.
  - **No self-approve-on-create:** payroll has always been a two-step
    create→approve flow (unlike invoices), so `create` yields a `draft` for
    everyone; an approver approves as a second step, exactly as before.
  - **State model:** `draft → submitted → approved` (+ post-approval `paid`).
    Migration `0009_m10_5_payroll_review_note` adds `payroll_runs.review_note`.
    `submit` is a bookkeeper action; `approve`/`send-back`/`reject` are
    approver-only. `reject` hard-deletes (payroll_items cascade). New repo
    `deleteRun`.
  - **Endpoints (OpenAPI-first):** `POST /payroll/:id/{submit,send-back,reject}`
    added; `/:id/approve` now flows through the engine. `PayrollRun` schema added;
    client regenerated.
  - **Zero-movement test** (`tests/payroll-approval-zero-movement.test.ts`):
    draft AND submitted post nothing (trial balance + salaries-expense GL are
    zero); submit→send-back→resubmit→approve posts the payroll GL (trial balance
    balances at the expected total); reject hard-deletes; all transitions audited.
  - **Payments NOT a separate approvable entity (decided):** customer receipts /
    vendor payments remain the approver-authority `pay` action on invoices/bills
    (already gated + hardened in M10.3/M10.4), per the M10 plan — a draftable
    payment entity is a deferred future feature, not built in M10.
- **M10.6 (done): the closer — cross-entity sweep, worklist UI, provisioning, docs.**
  - **Cross-entity correctness sweep** (`tests/cross-entity-approval-sweep.test.ts`):
    proves the core invariant with all five records present in ONE tenant at once
    — an unapproved draft of a JE + bill + invoice + payroll run coexisting leaves
    EVERY money report at zero (trial balance, income statement, balance-sheet
    AR+AP, AR/AP aging, VAT), then approving them all makes the expected movement
    appear; plus the full `create → submit → send-back → resubmit → approve`
    lifecycle end-to-end per editable-draft entity.
  - **Membership management / bookkeeper provisioning (fixes the M10.1 gap):**
    `GET/POST/PATCH /orgs/:orgId/members` (`services/members.service.ts` +
    `repositories/members.repository.ts`), mounted in the **identity/infrastructure
    layer with the org switcher — base (owner) connection, BEFORE `resolveTenant`**
    (because `organization_memberships` is global-reference data: not RLS-scoped,
    app role SELECT-only). Authorization is **explicit**: the caller must be an
    active `admin` of the *specific path org* (never ambient context) — an admin
    of org A cannot touch org B (proven in `tests/members.test.ts`). Refuses to
    orphan the last admin. **Audit:** per the M7 boundary these membership/security
    events are **NOT** written to the business `audit_logs`; a `TODO(security-audit)`
    marks where to record them once the dedicated security-audit log exists.
  - **UserManagement conflation fixed:** creating a user now also assigns an
    active-org membership (via the members endpoint), and the role editor manages
    the **membership** role (the one that governs access), not the vestigial global
    `users.role`; the bookkeeper role is now selectable. A created/edited user is
    a working member, not a stranded global account.
  - **Minimal worklist UI** (`apps/web/src/pages/Approvals.tsx`, route `/approvals`):
    unstyled, functional pending-approvals view across all entities with
    submit/approve/send-back/reject wired to the API — the feature is clickable
    end-to-end for the first time. Role enforcement is server-side (a bookkeeper
    clicking Approve gets a 403). Real worklist UX is a later design phase.
  - **Deferred to Phase 1 (onboarding):** fuller member management — multi-org
    administration, cross-org role editing, and invitations — plus the dedicated
    security-audit log for identity/membership events. M10.6 scope was
    deliberately limited to active-org role assignment (enough to provision a
    bookkeeper and make the feature usable end-to-end).

See `docs/phase-0-implementation-plan.md`.

## Phase 1 — Milestone 11: Onboarding & Multi-Company Foundation (IN PROGRESS)

Entry point = **public self-service signup behind a verification gate** (an org
signs up, submits CR/VAT + documents, enters `pending_review`, and gets no
platform access until a platform operator approves). Sequenced M11.1 → M11.7;
each sub-milestone pauses for review. Full plan in the `m11-onboarding-plan`
project memory (design record; a `docs/` spec will follow).

- **M11.1 (done): security-audit log foundation.** A dedicated
  **`security_audit_logs`** table (migration `0010`) + **`securityAuditService`**
  (`services/securityAudit.service.ts`) records the actor-centric identity/security
  trail, kept **separate from the tenant-scoped business `audit_logs`** (the M7
  boundary made concrete): `organization_id` is **NULLABLE** (global events —
  user created, password reset — carry none; membership events set it), the table
  has **no RLS and no app-role grants** (written/read ONLY on the base/owner
  connection by the identity layer, which runs before `resolveTenant`; a DB
  boundary test proves the app role can't even SELECT it), and it is
  **append-only by construction** (the service exposes only insert + read).
  Recording is **best-effort, non-throwing** — unlike the in-transaction
  `auditService`, security events fire on the base connection outside the
  mutation's autocommit, so a failed insert is logged, never thrown (it must not
  turn an already-committed identity change into a reported error); making
  identity mutations transactional is a documented follow-up. The three
  `TODO(security-audit)` markers in `members.service.ts` are now wired
  (`membership.assigned` / `role_changed` / `status_changed`), plus the `/auth`
  routes (`user.created` / `role_changed` / `deactivated` / `reactivated` /
  `password_reset` / `password_changed`). Org admins read their org's events via
  `GET /orgs/:orgId/security-events` (identity layer, explicit admin-of-that-org
  auth; global org-less events are exposed by the operator surface in a later
  sub-milestone). Verification/invite/operator events extend the same log in
  M11.2+.
- **M11.2–M11.7 (planned):** verification state + fail-closed access gating (the
  security-critical core — the gate lives in `resolveTenant`, the sole setter of
  the tenant GUCs, so a non-`approved` org structurally cannot obtain an
  org-stamped RLS connection; the migration backfills all existing orgs to
  `approved`); platform-operator concept + review boundary; document upload
  (Supabase Storage); public signup + status/resubmit UIs; **company setup +
  ZATCA correctness (M11.6 — see the production blocker below)**; invitations +
  multi-org member administration.

### Known Issues / Deferred (from the M4 security re-audit)

These were identified in the post-M4 security review and **intentionally deferred**
(not bugs to fix ad hoc — address them in the milestone noted):

- **[🚫 PRODUCTION BLOCKER — fixed in M11.6] Invoices carry the ZATCA sandbox VAT
  number.** Invoice issuance (`services/invoices.approvable.ts` +
  `invoices.service.ts`) hardcodes `DEFAULT_SELLER_VAT = "300000000000003"` (the
  ZATCA sandbox placeholder) and `DEFAULT_SELLER_NAME = "KSA Ledger Company"`,
  denormalized onto each invoice and fed into the ZATCA QR (TLV tags 1–2) and the
  invoice hash — the company's real `vatNumber`/`name` are **never consulted**, and
  the constants are **duplicated across the two files**. So **every invoice issued
  today carries a fake VAT number.** **Must NOT deploy to production or issue real
  invoices until fixed.** Correctly sequenced at **M11.6** (wire
  `company.vatNumber`/`name` into issuance, replace + de-duplicate the constants),
  since nothing is deployed yet — noted here so it cannot be forgotten.
- **[HIGH — RESOLVED in M6] Per-request transaction held open for DB-less routes.**
  The tenant DB client is now acquired **lazily** on first query (`LazyTenantClient`
  in `packages/db/src/index.ts`), so DB-less routes (e.g. `/llm/*`) never check out
  a pooled connection. The session store runs on its own `sessionPool`, and each
  tenant transaction sets `idle_in_transaction_session_timeout='15s'`. Leak-safety
  preserved (SET LOCAL role + GUCs stay transaction-local).
- **[MEDIUM — RESOLVED in M6] Whole-request transaction rollback semantics.**
  Integration tests (`packages/db/src/__tests__/tx-rollback.test.ts`) prove a
  mid-request DB error (duplicate period lock) rolls the whole request back, the
  earlier write does not persist, the original constraint error surfaces (not a
  secondary "transaction aborted"), and the pooled connection is reusable.
- **[RESOLVED in M6] `sql.raw` id-lists + session-table bootstrap.** The reports
  `sql.raw(ids.join(","))` id-lists are now `inArray(...)`; the `user_sessions`
  table is provisioned by migration `0005` (`createTableIfMissing:false`), fixing
  the esbuild-bundle login-500 gap.
- **[MEDIUM — RESOLVED in M7] `audit_logs` grants UPDATE/DELETE to the app role.**
  Migration `0006_audit_append_only.sql` **revokes UPDATE/DELETE** on `audit_logs`
  from the `authenticated` role (INSERT + SELECT only), making the audit trail
  tamper-resistant. Proven by `packages/db/src/__tests__/audit-logs.test.ts`
  (the app role's UPDATE/DELETE are denied; INSERT/SELECT still work).
- **[DEFERRED] Separate security-audit log for identity/session events.** The M7
  business-audit trail is tenant-scoped (`audit_logs.organization_id` is NOT NULL),
  so **global identity/session events are intentionally NOT captured**: user
  register / password reset / role & membership change (`/auth/*`) and org switch
  (`/orgs`). These security events need a **separate security-audit log** (not
  org-scoped, actor-centric) in a later phase — do not shoehorn them into
  `audit_logs`.
- **[LOW] `period_locks` routes scope by `period` alone, not `company_id`.**
  RLS confines results to the active organization, but the uniqueness key is
  `(organization_id, company_id, period)`, so a multi-company org has
  cross-company visibility within the tenant (not a cross-tenant breach).
  **Fix:** scope period-lock queries by `company_id` when multi-company support
  is built out.
- **[FEATURE] Fine-grained, action-level permissions for separation-of-duties.**
  M5 authorization is method-based (one action per HTTP verb per resource), so it
  cannot distinguish sensitive state transitions from ordinary writes — e.g.
  posting a journal entry to the GL (`POST /journal-entries/:id/post`), reversing
  an entry, approving payroll (`POST /payroll/:id/approve`), and paying a bill
  (`POST /bills/:id/pay`) all resolve to `create` and are allowed to accountants
  (the industry-standard default). A later **advanced-tier** phase should add
  optional separation-of-duties controls: make post-to-GL, payroll approval, and
  bill payment **individually gateable to admin**, and support a "clerk enters /
  approver pays" split for AP. This needs **action-level** (per-endpoint)
  permissions rather than method-level, and is out of the M5 3-role scope.
- **[FEATURE] Draft/approval workflow + 4-role model — `do not implement before M6`.**
  Approved-but-deferred feature: a universal draft/approval workflow across all
  financial records (journal entries, invoices, bills, payments, payroll), backed
  by a 4-role model that adds a **Bookkeeper** (creates drafts only, cannot
  approve). Every financial record is created as a draft that does **not** affect
  the accounts (GL, balances, reports, VAT/Zakat) until approved; reports/GL must
  filter to APPROVED only. Generalizes the existing journal-entry draft→posted
  pattern. Must be built in the **M6 service layer**, not current route handlers —
  so it is gated on M6 and targets a **new milestone after M6**. Full design:
  [`docs/feature-spec-draft-approval-workflow.md`](docs/feature-spec-draft-approval-workflow.md).

## 3. Tech Stack

| Layer         | Technology                                                               |
| ------------- | ------------------------------------------------------------------------ |
| Monorepo      | pnpm workspaces (`apps/*`, `packages/*`, `scripts`)                      |
| Backend       | Express 5, TypeScript, Node.js (ESM), esbuild bundle                     |
| Frontend      | React 19, Vite, TypeScript, Tailwind CSS v4, shadcn/ui                   |
| Routing (FE)  | Wouter                                                                   |
| Data fetching | TanStack Query (React Query v5)                                          |
| ORM           | Drizzle ORM                                                              |
| Database      | PostgreSQL (via Supabase)                                                |
| Cache / queue | Redis                                                                    |
| Auth          | Express session auth (`express-session` + `connect-pg-simple`, bcryptjs) |
| API contract  | OpenAPI-first (`packages/api-spec/openapi.yaml`) with orval codegen      |
| Validation    | Zod (generated into `@workspace/api-zod`)                                |
| i18n          | Custom `LanguageContext` (Arabic / English, RTL-aware)                   |
| Logging       | pino / pino-http                                                         |

## 4. Repository Layout

```
apps/
  api/               @workspace/api-server — Express 5 backend
    src/
      routes/        one file per entity (transactions, invoices, bills, …)
      lib/           accounting + infra: glPosting, periodLock, zatca,
                     categorizer, auth, logger
      app.ts         Express app wiring (session, middleware, router)
      index.ts       server entrypoint
  web/               @workspace/bookkeeping — React 19 + Vite frontend
packages/
  db/                @workspace/db — Drizzle schema + pg pool (source of truth)
    src/schema/      one file per table (business + tenancy/platform tables)
    migrations/      versioned SQL migrations (drizzle-kit generate)
  api-spec/          @workspace/api-spec — OpenAPI spec + orval config (codegen)
  api-zod/           @workspace/api-zod — generated Zod schemas/types
  api-client-react/  @workspace/api-client-react — generated React Query client
  auth/              @workspace/auth — scaffold (auth/RBAC; populated later)
  config/            @workspace/config — scaffold (shared config/env; populated later)
scripts/
docs/                architecture-blueprint.md, phase-0-implementation-plan.md
```

> **Note:** workspace **package names are unchanged** (`@workspace/api-server`,
> `@workspace/bookkeeping`, etc.) — only their directories moved. `pnpm --filter`
> commands still use the package names, not the folder paths.

## 5. Key Architectural Principles

1. **Preserve existing accounting business logic — it is correct.**
   GL posting (`apps/api/src/lib/glPosting.ts`), period locks
   (`apps/api/src/lib/periodLock.ts`), and VAT/Zakat/ZATCA
   (`apps/api/src/lib/zatca.ts`) are the source of truth for how the ledger
   behaves. Balanced double-entry, closed-period enforcement, and tax rules are
   already implemented correctly. Extend and wrap them; do not reinvent them.

2. **Everything is tenant-scoped.**
   Every business table must carry an `organization_id`, and **every query** must
   filter by the current tenant. No cross-tenant reads or writes, ever.

3. **Route → Controller → Service → Repository layering.**
   The target layering: routes handle HTTP only; controllers coordinate;
   services own business logic; repositories own data access. Today much logic
   still lives inside route files — moving it into this shape is Phase 0 work.
   Write new code in this layered style.

4. **OpenAPI-first with codegen.**
   `packages/api-spec/openapi.yaml` is the contract. `pnpm --filter @workspace/api-spec run codegen`
   regenerates the Zod schemas (`@workspace/api-zod`) and the React Query client
   (`@workspace/api-client-react`). Change the spec first, regenerate, then
   implement. Keep this pipeline — do not hand-write client types or hand-edit
   generated files.

5. **AI proposes; it never posts.**
   AI features must never write directly to the ledger. They _propose_ entries,
   categorizations, or actions; a human — or the existing, trusted accounting
   logic — approves and commits them. The GL is only ever written through the
   established posting path.

## 6. What NOT to Do

- **Do not** rewrite working accounting logic unnecessarily (GL posting, period
  locks, VAT/Zakat). If it works and is tested, leave it — build on it.
- **Do not** use Supabase Auth. We use Supabase for Postgres only. Authentication
  stays **Express session auth**.
- **Do not** skip tenant scoping. No business table without `organization_id`; no
  query without an organization filter.
- **Do not** put business logic directly in route handlers. Push it into
  services/repositories following the layering above.
- **Do not** bypass the OpenAPI → codegen flow or hand-edit generated files under
  `packages/api-zod/src/generated` or `packages/api-client-react/src/generated`.
- **Do not** let AI features write to the ledger directly.

## 7. Reference Docs

- `README.md` — project overview, status, tech stack, and quick start.
- `docs/local-setup.md` — run the platform locally (Supabase, migrate, seed, API + web).
- `docs/development-guide.md` — layering, tenancy/RLS, RBAC, audit, and the
  "add a new domain" cookbook. Read before writing backend code.
- `CONTRIBUTING.md` — branch strategy, commit conventions, PR checklist, CI gates.
- `docs/architecture-blueprint.md` — target technical architecture.
- `docs/phase-0-implementation-plan.md` — Phase 0 milestone plan.
- `docs/feature-spec-draft-approval-workflow.md` — approved, deferred feature spec.

These are the source of truth for architecture and sequencing. Consult them
before starting non-trivial work; keep them in sync as decisions land.

## 8. Development Conventions

- **Small milestones.** Work in small, reviewable increments. Don't bundle
  unrelated changes.
- **Explain before implementing.** For any non-trivial change, describe the plan
  and the reasoning first, then implement once it's agreed.
- **Test everything.** Preserve and extend existing tests
  (`apps/api/src/tests`, Vitest). Add tests for new logic —
  especially anything touching money, the GL, tax, or tenant isolation.
- **pnpm only.** A preinstall guard rejects npm/yarn. Use
  `pnpm --filter <workspace> run <script>`.
- **Typecheck** with `pnpm run typecheck` at the root before considering work done.

### Common commands

```bash
pnpm install                                         # install all workspaces
pnpm --filter @workspace/api-server run dev          # run the API server
pnpm --filter @workspace/bookkeeping run dev         # run the frontend
pnpm --filter @workspace/db run generate             # generate a versioned SQL migration (preferred)
pnpm --filter @workspace/db run migrate              # apply pending migrations
pnpm --filter @workspace/db run seed                 # idempotently seed the default org + company
pnpm --filter @workspace/db run test                 # DB tests incl. cross-tenant RLS isolation (needs DATABASE_URL)
pnpm --filter @workspace/db run push                 # (legacy) push schema directly — avoid for tenant data
pnpm --filter @workspace/api-spec run codegen        # regenerate API client + Zod
pnpm --filter @workspace/api-server run test         # backend tests (Vitest)
pnpm run typecheck                                   # typecheck the whole repo
```
