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

## Phase 1 — Milestone 11: Onboarding & Multi-Company Foundation (COMPLETE)

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
- **M11.2 (done): verification state + fail-closed access gating (the
  security-critical core).** `organizations` gained `verification_status`
  (`pending_review | needs_info | approved | rejected`, default `pending_review`)
  + `verification_reason` / `verification_reviewed_by` / `_reviewed_at` /
  `_submitted_at` (migration `0011`). The migration **backfills ALL existing orgs
  to `approved`** (two-step default: add column `DEFAULT 'approved'` to grandfather
  existing rows, then `SET DEFAULT 'pending_review'` for future signups) and the
  **seed sets the default org `approved`** — so the seeded tenant and all
  M3-backfilled data keep full access. **The gate lives in `resolveTenant`**: after
  selecting the active org (its status joined into the membership query) it
  short-circuits with **`403 {code:"org_not_verified", status, reason}`** for any
  non-`approved` org **before** `beginTenantConnection` — so the tenant GUCs
  (`app.current_org_id`/`company_id`) are never set and no org-stamped RLS
  connection is opened. That is the DB-level backstop (layer 3): with no GUC, RLS
  matches zero rows and the NOT NULL `organization_id` default (NULL) rejects
  writes — fail-closed by construction for every current AND future business route
  (all mounted after `resolveTenant`). A pending org's only reachable surface is
  the identity layer mounted **before** the gate: `/auth` (incl. logout), `/orgs`,
  and new **`/onboarding/status`** (`services/onboarding.service.ts`, returns the
  active org's `{status, reason}` so the web app can route to the status page).
  Proven by `tests/verification-gating.test.ts` (M3/M4 rigor): the `resolveTenant`
  seam (approved → `next()`; pending/needs_info/rejected → 403, no tenant context;
  the multi-org edge — one user gated purely by which org is active), and an
  end-to-end pass over the real app (a pending org gets 403 on every business write
  + a reports read with an **owner-connection query confirming ZERO rows written**;
  onboarding/logout still work; after approval the same write posts).
- **M11.3 (done): platform-operator concept + review boundary (security-sensitive).**
  A `platform_operators` table (owner-only) marks the few users who may review
  verification applications; **operator status is granted ONLY via the seed/CLI**
  (`seedPlatformOperator`, gated on `SEED_OPERATOR_EMAIL`/`_PASSWORD`) — **no HTTP
  route ever grants it**. An operator is a **global identity with no org
  membership**, so `resolveTenant`'s existing no-membership 403 blocks them from
  **every** business route — operator status grants **zero** access to any
  tenant's financial data (no BYPASSRLS, and the operator surface never returns
  invoices/GL/reports). The **`/operator`** namespace is mounted **before**
  `resolveTenant`, guarded by **`requirePlatformOperator`** (`lib/operator.ts`,
  fail-closed), and exposes only verification metadata: list the review queue, get
  an application's detail (org + the applicant company's CR/VAT + review history),
  and the decisions **approve / reject / request-info** plus the operator-only
  **`reopen` (`rejected → needs_info`)** mistake-correction path — `rejected` is
  terminal-by-default (you cannot approve straight from it). Each decision updates
  the org, appends a `verification_reviews` row (owner-only history table), and
  writes a `security_audit_logs` event (operator id + target org); guards are
  fail-closed (wrong state → 409, missing reason → 400, unknown org → 404).
  Approving flips `verification_status` to `approved`, which un-gates the org on
  its next request. Both new tables get **no RLS and no app-role grants** (DB
  boundary test asserts the app role can't touch them). Proven by
  `tests/operator.test.ts` (state machine + `requirePlatformOperator`/
  `resolveTenant` boundaries + an e2e: an operator gets 403 on every business
  route, a non-operator gets 403 on `/operator`, and an operator approves an
  application end-to-end) and `packages/db/.../operator-tables.test.ts`.
- **M11.4 (done): document upload & storage (Supabase Storage, API-brokered).**
  Applicants upload registration documents (CR/VAT certificates, other) and
  operators review them; the file **bytes live in a private Supabase Storage
  bucket**, the metadata in a new owner-only `verification_documents` table
  (migration `0013`). **All I/O is brokered through the API** — a thin,
  **dependency-free** client (`lib/storage.ts`) over Storage's REST API using the
  service-role key, which **stays server-side only**; the browser never gets it.
  Authorization is **our** model, not Storage RLS: an applicant acts only on their
  active org's docs (membership-resolved in `onboarding.service`), and operators
  read any org's docs through the operator surface. **Validation** (`lib/fileValidation.ts`):
  an allow-list (PDF/JPEG/PNG) enforced by a **magic-byte sniff** (bytes, not the
  spoofable declared mime/extension), a 10 MB cap (multer memory limit +
  re-checked), and filename sanitization (no path traversal). **Downloads are
  forced attachments** (`Content-Disposition: attachment` + `X-Content-Type-Options: nosniff`,
  never inline — `routes/documentHttp.ts`). Endpoints: applicant
  `POST/GET /onboarding/documents` + `GET /onboarding/documents/:id`; operator
  detail now includes documents + `GET /operator/applications/:orgId/documents/:docId`.
  **Audited:** `verification.document_uploaded` (uploader) and, for the operator
  download, `verification.document_viewed` (cross-tenant access). Upload rolls
  back the stored object if the metadata insert fails. New **config** (validated
  in `@workspace/config`, all optional so the app still boots without storage —
  document endpoints then 503): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
  `VERIFICATION_DOCS_BUCKET` (default `verification-documents`). Proven by
  `tests/documents.test.ts` (validation, real bucket round-trip, org-scoping,
  audit, multipart upload + attachment-only download — gated on Storage creds, so
  it skips in CI) and the `verification_documents` owner-only DB boundary test.
- **M11.5 (done): public self-service signup + applicant status/resubmit + minimal
  UIs — the flow is clickable end-to-end for the first time.**
  - **`POST /auth/signup` (PUBLIC)** — the platform's only unauthenticated write.
    One **atomic transaction** creates organization (`pending_review`) + company
    (name, CR, VAT) + admin user + active admin membership
    (`signup.repository.createTenant`, with unique-slug derivation), then logs the
    user in so they land on the status page. Strict dedicated rate limiter
    (**5/hour/IP**, separate from the credential limiter); duplicate email → 409;
    validation in `signup.service` (CR = 10 digits **required**, VAT = 15 digits
    starting/ending with 3 **optional** — not every entity is VAT-registered).
    Audited as `signup.completed`. **`/auth/register` stays admin-only** for an
    approved org to provision its own team.
  - **Applicant resubmit** — `POST /onboarding/resubmit` moves
    `needs_info → pending_review`, clearing the reason and re-stamping
    `verification_submitted_at`. The status guard is **in the UPDATE** (`WHERE
    status='needs_info'`) so a concurrent operator decision can't be clobbered
    (zero rows → 409). Audited (`verification.resubmitted`) and appended to the
    shared `verification_reviews` history with a **null operator** (an applicant
    action). `rejected` is NOT applicant-resubmittable — only an operator `reopen`.
  - **UI (functional, reusing the existing shadcn patterns):** `/signup`
    (public), `/verification` (status + reason + document upload + resubmit +
    sign-out), `/operator` (review queue → detail with CR/VAT + documents +
    history → approve / request-info / reject / reopen). Both `/verification` and
    `/operator` render **inside `AuthGuard` but OUTSIDE `Layout`** — the sidebar
    fires tenant-scoped queries that 403 for a gated org and for a
    membership-less operator.
  - **The gate drives the redirect centrally — across BOTH data paths.** The web
    app fetches two ways: hand-written call sites via `apiFetch` (`lib/api.ts`)
    and — for the dashboard and most business pages — the **generated** React
    Query client via `customFetch`. The single policy
    `handleApiErrorResponse(status, body)` in `lib/api.ts` redirects to
    `/verification` on `403 {code:"org_not_verified"}` and is invoked by **both**:
    directly by `apiFetch`, and by the generated client through the new
    **`setApiErrorHandler`** hook in
    `packages/api-client-react/src/custom-fetch.ts` (registered in `main.tsx`).
    That hook keeps the shared package route-agnostic. **This was a real bug found
    in manual browser testing:** covering only `apiFetch` left a gated org sitting
    on the dashboard shell while every query 403'd (the server-side gate held —
    no data was ever served — but the user was never redirected).
    `apiFetch` also now omits `Content-Type` for `FormData` (the browser must set
    the multipart boundary) and merges headers after `...init` (previously `init`
    could clobber them).
  - **Tests:** `tests/signup.test.ts` — validation + atomicity at the service
    level (kept off HTTP so the many cases don't burn the deliberately strict
    signup limiter), then the full loop over the real app: signup → gated 403 →
    operator request-info → applicant resubmit → operator approve → **the same
    business write now posts**; plus duplicate-email 409 and a rate-limit (429)
    assertion placed last (it poisons the IP for the window).
  - **Verified clickable end-to-end** against the running app through the Vite
    proxy (the exact path the UI uses): signup → status → gated 403 → **multipart
    document upload** → operator queue/detail → audited document download
    (attachment + nosniff) → request-info → resubmit → approve → business write
    201, with the full security-audit trail and review history correct.
- **M11.5.1 (done): SECURITY HOTFIX — CRITICAL-1 + audit follow-ups.** A read-only
  security audit of M11.1–M11.5 (four parallel reviews) found one CRITICAL, and it
  was fixed before any further feature work.
  - **CRITICAL-1 — public signup granted platform-wide admin.** Signup wrote
    `users.role = "admin"` and stamped `session.userRole = "admin"`; `/auth/*` is
    mounted **before** `resolveTenant` (so the verification gate never covered it)
    and its user-administration endpoints were guarded only by that ambient global
    role **with no organization filter**. Anyone could sign up and then
    `GET /auth/users` (every user on the platform) and
    `POST /auth/users/:id/reset-password` (take over **any** account — other
    tenants' admins, or the platform operator, then self-approve). Fixed on four
    fronts: (a) signup now creates a global **`viewer`** (authority comes from the
    `organization_memberships` admin row, as it always should have);
    (b) the session no longer receives a global admin role; (c) `/auth/register`
    and `/auth/users*` moved onto a new **org-scoped** `userAdmin.service` —
    the caller must be an active admin of an **approved** organization and may
    only see/modify users who are members of an org **they** administer (this also
    closes the *pre-existing* cross-tenant half: previously any admin could read
    and reset any user platform-wide); (d) role-enum validation on
    `PATCH /auth/users/:id` plus a dedicated rate limiter on the whole
    user-administration surface (it was entirely unthrottled, and `users.id` is a
    serial integer). **`requireRole`/`requireAdmin`/`requireAccountantOrAbove`
    were DELETED** from `lib/auth.ts` so the ambient-global-role pattern cannot be
    reintroduced. Locked in by `tests/user-admin-authz.test.ts` (13 tests, both
    directions: a self-signup user is denied every user-admin endpoint — including
    for its *own* org while unverified, preventing email-squatting — and a
    legitimate admin is confined to their own organization).
  - **HIGH-1 — document upload abuse.** Added a per-IP upload rate limiter and a
    **per-org quota** (`MAX_DOCUMENTS_PER_ORG` = 25, `MAX_TOTAL_BYTES_PER_ORG` =
    100 MB) checked in `documentsService.upload` **before** any bytes reach
    storage. Uploads are reachable pre-approval by design, so this was otherwise
    an open memory/storage-cost abuse surface.
  - **M-2 — operator decision TOCTOU.** `operator.service._transition` now applies
    the state change with a **conditional UPDATE**
    (`updateVerificationIfInState(... WHERE verification_status IN allowedFrom)`);
    zero rows ⇒ 409. Consistent with the pattern already used in
    `onboardingService.resubmit`.
  - **UI consequence handled:** `UserManagement` gated on the global `users.role`;
    it now gates on the caller's **membership** role in the active org (the server
    authorizes the same way), so a self-signup org owner isn't locked out.
- **M11.6 (done): company setup + ZATCA correctness — THE PRODUCTION BLOCKER IS
  CLOSED.** Invoice issuance now stamps the tenant's REAL ZATCA identity.
  - **`services/sellerIdentity.ts` is the single seam.** It replaces the
    `DEFAULT_SELLER_VAT` / `DEFAULT_SELLER_NAME` constants that were **duplicated**
    in `invoices.service.ts` and `invoices.approvable.ts` (a ZATCA *sandbox*
    placeholder that was fed into every QR and hash). Seller identity resolves
    from the **active company**, honoring an explicit per-invoice override.
    **There is deliberately NO fallback value:** `requireIssuanceSeller` **fails
    closed** with 400 `company_vat_missing` when no VAT number is configured, so
    the platform can never again mint a legally-invalid invoice. Draft creation
    stays lenient (`resolveDraftSeller`) — a draft is not a legal document.
  - **Tenant-scoped `companies` resource** — `GET/PATCH /companies/current`
    through route→controller→service→repository, behind
    `requirePermission("companies")` (matrix: **read = all roles, update = admin
    only**, since VAT/CR feed the QR and hash chain). The "active company" is the
    org's first-created company — the same rule `resolveTenant` uses, so the two
    never disagree. OpenAPI-first (`Company` + `UpdateCompanyInput`), client
    regenerated.
  - **Statutory validation lives in one place** — `lib/saudiIdentifiers.ts`
    (VAT = 15 digits starting/ending with 3; CR = 10 digits; postal = 5; building
    = 4), shared with signup. Duplicated constants are precisely what caused this
    blocker, so the rules are imported, never re-inlined.
  - **Schema (migration `0014`, additive/nullable):** `name_ar` plus the national
    short-address block (`building_number`, `street`, `district`, `city`,
    `postal_code`) — not needed by the Phase-1 QR or hash (so they don't gate
    issuance) but required for **ZATCA Phase 2**, added now to avoid a second
    migration.
  - **`fiscalYearStart` is stored and exposed but NOT yet wired into report
    periods** — reports still use calendar periods. That is a reporting change,
    deliberately out of scope here; the Company Settings UI says so explicitly.
    Tracked in the deferred list below.
  - **Company Settings UI** (`/company`, in the Settings nav) with a prominent
    warning when no VAT number is set ("invoices cannot be issued").
  - **Acceptance test** (`tests/company-zatca-identity.test.ts`): decodes the real
    base64 TLV QR (tag 1 = name, tag 2 = VAT) and **recomputes the invoice hash**,
    asserting it matches only when the COMPANY's VAT was the input and does NOT
    match the sandbox value; plus fail-closed-without-VAT, format validation, and
    a company VAT change flowing into the next issued invoice. Existing company
    fixtures across the approval suites now carry a real CR/VAT, and the invoice
    zero-movement + hash-chain suites still pass unchanged (M10 behavior intact).
- **M11.7 (done): invitations + multi-org member administration — Phase 1
  onboarding is COMPLETE.** An approved organization can now add its own team.
  - **`organization_invitations`** (migration `0015`, owner-only identity table).
    Only the **SHA-256 of the token** is stored — the raw 32-byte token
    (`lib/tokens.ts`) exists solely in the invite link, so a DB leak yields no
    usable invites. A **partial unique index** (`WHERE status='pending'`,
    hand-written — Drizzle can't express it) allows at most one live invite per
    (org, email) while retaining revoked/accepted rows as history. 7-day expiry
    (`INVITATION_EXPIRY_DAYS`).
  - **Admin surface** under `/orgs/:orgId/invitations` (send / list / resend /
    revoke) + `DELETE /orgs/:orgId/members/:userId` — identity layer, base
    connection, pre-`resolveTenant`, same explicit admin-of-THIS-org check. Member
    removal deactivates (preserving history) and respects the **last-admin
    guard**. `GET /orgs` now also returns each org's `verificationStatus`.
  - **PUBLIC accept** (`GET /invitations/:token`, `POST /invitations/:token/accept`),
    rate-limited, with both paths: an existing user accepts **while signed in**,
    and a new invitee sets name + password to create the user **atomically with**
    the membership.
  - **SECURITY — this is a public endpoint that mints a membership**, i.e. the
    same "self-grantable capability" shape as the M11.5.1 CRITICAL, so it was
    threat-modelled BEFORE implementation and each invariant has a test:
    (1) accepting writes a **non-privileged global `users.role`** — the invited
    role goes **only** to the membership; (2) the role is validated against
    `VALID_MEMBERSHIP_ROLES`, and since only an org admin (the highest org role)
    can invite, **no invite can grant more than the inviter holds**;
    (3) the org must be **`approved` to invite AND to be joined** — re-checked at
    accept time, blocking both email-squatting by an unvetted org and joining an
    org rejected after the invite was sent; (4) acceptance **claims the invitation
    with a conditional UPDATE** (`status='pending' AND expires_at > now()`), so a
    token can never be redeemed twice; (5) a signed-in acceptor's **email must
    match** the invited email; (6) unknown/valid tokens both return the same 404
    so guesses aren't confirmed.
  - **Provider-agnostic email** — `lib/mailer.ts` defines the `Mailer` seam with a
    **no-op** implementation that reports `delivered: false`; the API returns the
    invite **link** for the admin to share out of band. Integrating SES/Resend/
    Postmark later means implementing `send` and swapping the export — no change
    to the invitation service.
  - **UI:** invitations panel (invite / copy link / resend / revoke) and member
    removal in User Management, plus the public `/accept-invite` page.
  - **Tests:** `tests/invitations.test.ts` (20) covers the full lifecycle both
    over HTTP and at the service layer, and asserts every invariant above.

## Phase 2 — Milestone 12: ZATCA Phase 2 (Fatoora) Integration (IN PROGRESS)

Transmitting invoices to ZATCA. M11.6 fixed the invoice **data** (each invoice
carries the tenant's real VAT number and company name, verified by decoding the
TLV QR and recomputing the hash); M12 builds the **integration** — UBL 2.1 XML,
XAdES-BES cryptographic stamping, per-tenant certificates, and the clearance /
reporting APIs. Research report and decision: see `docs/zatca/README.md` for the
specifications, environments and enforcement timeline.

**Why now:** ZATCA Wave 24 entered enforcement 1 Jul 2026; Wave 25 (announced
24 Jul 2026) drops the threshold to **SAR 187,500** with a **1 Feb 2027**
deadline — effectively every VAT-registered Saudi business. Phase 2 is no longer
a feature, it is the price of entry for the product.

### ⚠️ THE SCOPE SPLIT — READ THIS BEFORE CONTINUING M12

**M12 is deliberately built in two halves, separated by a real-world business
dependency that does not yet exist.**

| | Sub-milestones | Gating requirement |
| --- | --- | --- |
| **IN SCOPE NOW** | **M12.0 → M12.6 _and_ M12.8** | Sandbox only. **Email registration, nothing else.** |
| **BLOCKED, DO NOT START** | **M12.7 and M12.9** | **A registered Saudi company entity with an active ZATCA VAT registration and ERAD credentials.** |

**The company entity and its Saudi VAT/ERAD registration DO NOT EXIST YET.** That
is a real-world business step the owner will take **after the platform is
complete** — it is not a signup form and cannot be worked around. ZATCA's
**Simulation** environment (`fatoora.zatca.gov.sa`) requires ERAD credentials,
i.e. a real active taxpayer account, and production requires the same. The
**Sandbox** (`sandbox.zatca.gov.sa`) requires only an email.

The split is therefore **by external dependency, not by sequence number**: build
everything that does not need a real taxpayer account, which is *everything
except* the two milestones that literally submit to a live ZATCA environment.
**M12.8 (archival, residency design, PCSID renewal reminders, operator
visibility) is fully buildable today** and is deliberately NOT deferred despite
its number — it needs no ZATCA credentials.

Only **M12.7** (simulation end-to-end) and **M12.9** (production pilot) wait.
When the entity exists they resume with no rework — sandbox exercises the
identical API surface.

**Do not** attempt to "finish" M12 by mocking simulation, and **do not** onboard
any real tenant to production until M12.7 and M12.9 have actually run against a
real VAT registration.

### Decision: BUILD DIRECT (not a certified provider)

ZATCA's own Solution Providers Directory states the list is *"a guiding list
(non-legally binding to taxpayers)"* and that taxpayers *"have the option to get
E-invoicing services from any company, as long as the Solution used ... complies
to E-invoicing requirements."* **There is no certification gate** — compliance
attaches to the solution and is proven by passing ZATCA's own compliance checks.

Building directly was chosen because (a) ZATCA compliance **is** the product for a
Saudi accounting platform, not a side integration; (b) every provider prices
**per taxpayer** (SAR 99–299/month at SME tier) while we are a multi-tenant
platform with N taxpayers — the economics do not close; (c) the credible
providers (Wafeq, ClearTax, Qoyod) sell **competing** accounting software.

Two hedges are **mandatory**, not optional:

1. **Use a maintained open-source library for the cryptographic and XML
   primitives** (`zatca-xml-js` or equivalent). **Do NOT hand-write C14N, XAdES,
   or the CSR template.** Read the source, pin the version, own the orchestration
   / multi-tenancy / state ourselves.
2. **Build behind a swappable `EInvoiceProvider` interface from day one**, so a
   certified provider can be slotted in per-tenant later without re-architecting.

### Three pre-existing platform bugs fixed as part of M12

These are real bugs today, independent of ZATCA; Phase 2 merely escalates them
from latent to compliance-breaking. They are fixed in the milestone where they
belong, not ad hoc:

- **[M12.1] The hash chain is org-scoped, not company-scoped.**
  `getPreviousInvoiceHash` (`services/accounting/zatca.ts`) orders by
  `invoices.id` across the whole organization. ZATCA's chain and ICV are per EGS
  unit / per VAT registration, so a multi-company org **interleaves two chains
  into one** — invalid.
- **[M12.1] `sellerIdentity` resolves the wrong company.**
  `requireIssuanceSeller` uses `companiesRepository.findActive()` (the org's
  *first-created* company) and ignores the invoice's own `companyId`. Under Phase
  2 this signs the invoice **with the wrong company's certificate**.
- **[M12.6] The per-request tenant transaction cannot survive a synchronous
  external API call.** `resolveTenant` holds a Postgres transaction open for the
  whole request with `idle_in_transaction_session_timeout='15s'`; clearance is a
  blocking outbound call to ZATCA inside `issueInvoice()`. This **forces the
  outbox/worker redesign** in M12.6 (which also delivers the retry that reporting
  requires anyway).

### Sub-milestones

- **M12.0 (done): external dependency kickoff.** Specs pulled and pinned
  (`docs/zatca/`, with `fetch-specs.sh` + SHA-256 manifest — PDFs gitignored);
  sandbox confirmed live and email-only; hosting/residency question resolved
  (see below). Sandbox account registration is a manual owner step (see
  `docs/zatca/README.md`). **The Compliance & Enablement Toolbox (SDK) is
  PUBLIC — no account needed** (`fetch-sdk.sh` +
  [`docs/zatca/sdk-manifest.md`](docs/zatca/sdk-manifest.md)): UBL 2.1 XSDs, 55
  `BR-KSA-*` schematron rules, an offline validator/signer CLI, a test cert +
  secp256k1 key, and the genesis PIH. It **proved the `secp256k1` curve three
  ways** (see M12.3). It ships **no sample invoices**, and its ruleset is dated
  2021 — a locally-clean invoice can still fail M12.4.
- **M12.1a (done): Phase 2 data model + the two multi-company bug fixes.**
  Migration `0016_m12_1a_zatca_phase2_fields` — additive and nullable throughout;
  existing invoices are pre-ZATCA legacy and deliberately **not** backfilled with
  `uuid`/`icv` (the ZATCA chain starts fresh at first onboarding, so NULL is the
  correct representation).
  - **`invoices`**: `zatca_uuid`, `icv`, `issued_at`, `document_type`. **`issued_at`
    is NOT `date`** — `date` is the accounting date the ledger and reports use;
    `issued_at` is the real issuance instant ZATCA needs and the 24-hour
    simplified-reporting clock runs off. Issuance previously fed a fabricated
    `${date}T00:00:00Z` into the QR. **Unique index on `(company_id, icv)`** — the
    DB is the real guarantee against a reused counter under concurrent approvals.
  - **`einvoice_documents`** (NEW, tenant-scoped **business** table with RLS +
    app-role grants — *not* owner-only; the tenant is legally required to retain
    their own cleared XML). Holds the Phase 2 artifacts (`invoice_hash` =
    base64 SHA-256 of canonical XML, `previous_invoice_hash`, 9-tag `qr_code`,
    `signed_xml`, `cleared_xml`) **and** the transmission state (`flow`,
    `status`, attempts, `next_attempt_at`, ZATCA warnings/errors). Split from
    `invoices` on identity-vs-transmission lines: M12.6 churns this row hard with
    retries and it carries large XML blobs, neither of which belongs on the row
    the accounting core reads. **This is where M12.6's outbox lives.**
  - **`invoice_items`**: `tax_category_code` (S/Z/E/O), exemption reason
    code+text, `unit_code` (default `PCE`). **The 15% → `'S'` backfill is
    deliberately partial**: a `vat_rate = 0` line is genuinely ambiguous between
    zero-rated (Z) and exempt (E) — different tax treatments the existing data
    cannot distinguish — so those stay NULL and issuance will **fail closed**
    demanding an explicit answer rather than the migration guessing a tax fact
    (same principle as M11.6's seller VAT).
  - **`customers`**: structured buyer national short address (building/street/
    district/postal). Nullable — only STANDARD (B2B) invoices require it.
    Free-text `address` retained for display.
  - **`companies`**: `egs_serial_number` + `zatca_onboarding_status`. Key
    material is NOT here — it lands in M12.5's owner-only encrypted vault.
  - **BUG 1 FIXED — the hash chain was org-scoped.** `getPreviousInvoiceHash(db,
    invoicesTable)` is gone from `services/accounting/zatca.ts`; it is now
    **`invoicesRepository.previousInvoiceHash(companyId)`** — filtered to ONE
    company and moved into the repository layer where Drizzle access belongs
    (that it lived in the accounting layer behind `any` params is exactly why the
    missing filter was invisible).
  - **BUG 2 FIXED — seller identity came from the first-created company.**
    `requireIssuanceSeller` now takes the **invoice's own `companyId`** as a
    required argument. A second layer had to be fixed too: `resolveDraftSeller`
    stamped the draft via `findActive()`, and because issuance honors the stamped
    values as an override, that wrong identity survived approval — it now uses
    the new `companiesRepository.findCurrent()` (the `app.current_company_id`
    GUC, i.e. the company whose id the row actually gets).
  - **Test** `tests/multi-company-invoice-identity.test.ts` — one org, two
    companies. Proves interleaved issuance keeps each chain separate
    (`A1 → B1 → A2` links A2 to **A1**, not B1), one genesis root **per company**,
    a company-B invoice carries B's VAT, drafts still consume no sequence number,
    and the DB rejects a reused ICV within a company while allowing it across
    companies. **Verified failing against the pre-fix code.**
  - **Also fixed (pre-existing, unrelated):** five tests ordered audit rows by
    `created_at` alone. Postgres `now()` is the *transaction* timestamp, so rows
    written in one request share an identical value and the sort had no tiebreak
    — latent flakiness that the `customers` column addition exposed by shifting
    physical row order. All five now order by `created_at, id`.
- **M12.1b: credit/debit notes** as first-class documents — `document_type` is
  already in place; this adds the note→original reference, the **reversed GL
  posting** (Dr Sales+VAT / Cr AR) and negative treatment in AR aging,
  balance-sheet AR and the VAT return. Split out of M12.1 deliberately: it is
  money-touching accounting work, not a schema change.
- **M12.2: UBL 2.1 XML generation** (pure, offline) — validated against the ZATCA
  SDK's XSD + 55 `BR-KSA-*` schematron rules via `Apps/fatoora -validate`.
  **Note: the SDK ships NO sample invoices**, so there is no ZATCA golden file to
  diff against — the loop is *generate → validate → iterate until clean*, using a
  reference implementation's test invoice as an informal (non-normative) shape
  guide. Details in [`docs/zatca/sdk-manifest.md`](docs/zatca/sdk-manifest.md).
- **M12.3: cryptography** — ECDSA **`secp256k1`** keygen, CSR, XAdES signing, QR
  tags 6–9, and **replacing `computeInvoiceHash`** (see the landmine below).
  **Build against [`docs/zatca/security-standards-notes.md`](docs/zatca/security-standards-notes.md)**
  — spec-verified notes with two 🔴 traps that a plain reading of ZATCA's own
  document gets wrong: the curve is **`secp256k1`, NOT P-256** (P-256 appears only
  in an explicitly *illustrative* table; ZATCA's SDK emits
  `ec-secp256k1-priv-key.pem`), and the CSR **invoice type goes in `title`, not
  `businessCategory`** (the spec assigns OID 2.5.4.15 to two different rows).
  Both fail only at M12.4, after the whole crypto layer is built.
- **M12.4: sandbox onboarding + compliance checks** — CSR → CCSID → the six
  compliance documents → PCSID, against sandbox. *This is the milestone that
  proves the cryptography is correct.*
- **M12.5: credential vault + per-tenant onboarding flow** — owner-only
  `zatca_credentials` (no RLS, no app-role grants — the established pattern), KMS
  envelope encryption, tenant OTP paste UI.
- **M12.6: clearance & reporting transport** — outbox + worker (see the M12.6 bug
  above), retry, idempotency, status model, ZATCA error-code surfacing.
- **M12.8: archival, residency, renewal, operator visibility — IN SCOPE
  (buildable without ZATCA credentials).** Cleared-XML archive under ZATCA's
  naming convention (VAT number + timestamp + invoice reference), 6–11 year
  retention, PCSID expiry/renewal reminders, and operator-side onboarding
  visibility.
  **KSA data residency stays an OPEN DEPLOYMENT DECISION** — there is no hosted
  Supabase project yet (see below), so the archival layer must be built with a
  **swappable storage backend** behind an interface, NOT against an assumed
  region or provider. Choosing the KSA-resident host is a deployment step, and
  the code must not have to change when it happens.
- **M12.7 and M12.9: BLOCKED** on the Saudi entity — simulation end-to-end, and
  the production pilot. Nothing else in M12 is blocked.

### 🔴 LANDMINE — our hash chain is NOT ZATCA's hash chain

`services/accounting/zatca.ts` is titled *"Phase 2 hash chaining"*. **It is not.**

```
Ours    computeInvoiceHash()   sha256_HEX( "num|date|vat|total|vatAmount|prevHash" )
ZATCA                          BASE64( sha256( C14N-canonicalised UBL XML ) )
```

These share nothing. Our genesis is the literal string `"GENESIS"`; ZATCA's is a
defined constant. It is a homegrown tamper-evidence mechanism, and it must be
**replaced in M12.3, not extended**. The `invoice_hash` / `previous_hash`
**columns** are reusable as storage, but **every value currently in them is
meaningless to ZATCA** — the real chain starts fresh at first onboarding.
Likewise the QR (`generateZatcaQr`) emits Phase 1 tags **1–5 only**; Phase 2
needs **1–9**.

### Prerequisites tracked for M12.7+ (surface early, do not rediscover)

- **🔴 Saudi company entity + active ZATCA VAT registration + ERAD credentials.**
  The blocking dependency for M12.7–M12.9 and the longest-lead item in the whole
  programme. VAT registration is mandatory above SAR 375,000 revenue and
  **voluntary above SAR 187,500**. Nothing technical unblocks this.
- **Data residency.** ZATCA requires e-invoices archived on **servers inside Saudi
  Arabia**, retained **6 years (11 for certain services)**, under a naming
  convention (VAT number + timestamp + invoice reference). **Good news, resolved
  in M12.0:** there is *no hosted Supabase project yet* — the database is local
  Supabase CLI (`127.0.0.1:54322`) and `SUPABASE_URL` is unset. So residency is
  an **open deployment decision, not a migration** — choose a KSA-resident host
  before production. Do not provision a non-KSA hosted project in the meantime
  without revisiting this.
- **Possible ZATCA IP whitelisting.** Secondary sources indicate server IPs may
  need whitelisting. **Unverified against official docs** — confirm in M12.4. If
  true it means static egress IPs (NAT gateway) and constrains serverless hosting.
- **KMS** for envelope-encrypting tenant private keys (M12.5). ~$1/key/month on
  AWS KMS, or self-hosted Vault.
- **ZATCA itself charges nothing** — CSIDs, sandbox, simulation and API access are
  all free. The cost of the build-direct path is engineering time only.

### Known Issues / Deferred (from the M4 security re-audit)

These were identified in the post-M4 security review and **intentionally deferred**
(not bugs to fix ad hoc — address them in the milestone noted):

- **[✅ RESOLVED in M11.6 — was a PRODUCTION BLOCKER] Invoices carried the ZATCA
  sandbox VAT number.** Issuance hardcoded `DEFAULT_SELLER_VAT = "300000000000003"`
  (the ZATCA sandbox placeholder) and `DEFAULT_SELLER_NAME = "KSA Ledger Company"`,
  **duplicated** across `invoices.service.ts` and `invoices.approvable.ts`, and
  never consulted the company — so every issued invoice carried a fake VAT number
  in its QR (tag 2) and hash. **Fixed:** seller identity now resolves from the
  active company through the single `services/sellerIdentity.ts` seam, with **no
  placeholder fallback** — issuance **fails closed** (400 `company_vat_missing`)
  if the tenant has no VAT number, so the blocker cannot be reintroduced.
  Proven by `tests/company-zatca-identity.test.ts`, which decodes the real QR and
  recomputes the real hash.
### Open findings from the M11 security audit (M11.5.1)

The CRITICAL and HIGH-1/M-2 were fixed in M11.5.1 (see above). These remain open,
with severity and location — address in the milestone noted, not ad hoc:

- **[HIGH-2 — verify at deployment] Signup/auth rate limiting may be bypassable.**
  `app.ts:21-23` sets `trust proxy` **only in production**; if any deployment lets
  a client-supplied `X-Forwarded-For` reach Express, the IP-keyed limiters become a
  no-op via header rotation. The stores are also **in-memory / single-instance**
  (`routes/auth.ts`, `routes/onboarding.ts`), so horizontal scaling silently
  multiplies every limit. **Before deploying:** confirm exactly one trusted proxy
  that overwrites `X-Forwarded-For`; **before scaling out:** move the limiters to
  a Redis store.
- **[MEDIUM — REVIEW BEFORE PRODUCTION, found in M12.1a] The app role holds
  `TRUNCATE` on every business table, and TRUNCATE BYPASSES RLS.** The
  `authenticated` role has `SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER,
  TRUNCATE` on `invoices`, `bills`, `customers` and every other business table —
  more than migration `0004` explicitly granted. The extras come from the
  **Supabase base setup's `ALTER DEFAULT PRIVILEGES`**, not from our migrations.
  This matters because **`TRUNCATE` is not subject to row-level security**: unlike
  `DELETE`, it is not filtered by the `tenant_isolation` policy, so a SQL-injection
  or compromised-app-role scenario could wipe **all tenants'** rows in a table,
  not just the active org's. **Pre-existing and platform-wide — NOT introduced by
  M12.1a** (`einvoice_documents` matches the existing tables exactly, so the new
  table added no exposure). **Fix before deployment:** `REVOKE TRUNCATE (and
  REFERENCES/TRIGGER) ON <each business table> FROM authenticated` in a migration,
  and re-check the hosted project's default privileges — they may differ from the
  local Supabase CLI stack where this was observed.
- **[MEDIUM M-1 — LANDMINE, read before writing business-layer queries]
  `organizations`, `users` and `organization_memberships` are deliberately OUTSIDE
  RLS** (`0003_rls_policies.sql:20-22`) and granted plain `SELECT` to the app role
  (`0004_m4_rls_enforcement.sql:95-98`). Unlike every business table, **RLS will
  not save you here** — only an explicit `WHERE` clause will. Today nothing in the
  business layer queries them, so it is not exploitable; but the next engineer who
  joins `organizationsTable` from a business service (e.g. "show the org name on an
  invoice PDF") creates a **silent cross-tenant leak**. Either add RLS to these
  tables or add a CI guard failing on such imports outside the identity layer.
- **[MEDIUM M-3] Signup email/slug check-then-insert race surfaces as a raw 500.**
  `signup.service.ts` checks `emailExists` before the transaction; the DB unique
  constraint correctly prevents duplicates (no half-provisioned tenant), but the
  Postgres `23505` carries no `statusCode`, so `errorHandler` returns 500 instead
  of the intended 409. Map `23505` → `ConflictError`.
- **[MEDIUM M-4] `bcryptjs` (pure-JS, cost 12) blocks the event loop on public
  endpoints** — a multi-tenant noisy-neighbour DoS vector; consider native
  `bcrypt` (thread-pool offload). Also **no max-length validation** on
  `name`/`organizationName`/`companyName` before `varchar(255)`, so oversized
  input is another raw 500 instead of a 400.
- **[MEDIUM M-5] Magic-byte sniffing is header-only** (`lib/fileValidation.ts`) —
  a valid-header PDF carrying `/JavaScript` or `/OpenAction` passes. Browser-side
  risk is closed (forced attachment + `nosniff`); residual risk is a human opening
  the file locally. Closes with the AV follow-up below — `documents.service.upload`
  is the seam.
- **[LOW L-1] Security-audit write failures are invisible.**
  `securityAudit.service.ts` records best-effort and, on failure, only
  `console.error`s — not the structured `pino` logger, and with no alerting. The
  best-effort design is correct (the mutation already committed), but an attacker
  who can reliably fail those inserts acts untraced. Route it through `logger` and
  alert on the pattern.
- **[LOW L-2] Signup's 409 leaks account existence** — asymmetric with
  `/auth/login`'s deliberate constant-time defense in the same file. Acceptable
  (common for signup) but should be documented inline as a conscious trade-off.
- **[LOW L-3] Non-deterministic "primary membership" tie-break** — `tenant.ts`
  and `onboarding.service.ts` order by `createdAt` only; add a secondary key
  (`id`) for determinism.
- **[DEFERRED — M11.6] `companies.fiscalYearStart` is stored but not applied.**
  Reports still assume calendar periods: the VAT return uses `period_from`/
  `period_to` params (with `1900-01-01`…`2099-12-31` fallbacks) and the Zakat base
  takes no date range at all, so a company with a non-January fiscal year gets
  calendar-year figures. Wiring it in is a **reporting** change (report period
  derivation + defaults), deliberately out of M11.6's onboarding scope. The
  Company Settings UI states the limitation to the user.
- **[LOW L-4] The operator queue list is unaudited** (detail views and document
  views ARE audited). Accepted trade-off — revisit if operator-activity forensics
  become a requirement.

- **[KNOWN CI GAP — M11.4] The storage path is NOT covered by CI.** The 9
  document tests (`apps/api/src/tests/documents.test.ts`) are gated on
  `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` and **skip in CI**, which runs a
  Postgres service but **no Supabase Storage service**. This is unlike the
  DB-backed tests, which DO run against CI's Postgres container. So **a green CI
  does not prove the storage path works** — upload/download/validation is proven
  **locally only**, and a future change breaking storage would not be caught by
  CI. Do not assume CI covers it. **Follow-up before deployment:** add a Storage
  service (or a stub/emulator) to `.github/workflows/ci.yml` and set those two env
  vars so the suite runs there.
- **[FOLLOW-UP before scaling — M11.4] No antivirus/malware scanning on uploaded
  documents.** Verification document upload (M11.4) validates type (magic-byte
  sniff), size, and filename, stores to a **private** bucket, and serves downloads
  as forced attachments (never inline) — but does **not** scan file contents for
  malware. Blast radius is bounded (only that org's members + platform operators
  can ever download, and nothing is executed or rendered), so it is acceptable for
  now, but **AV scanning (e.g. ClamAV or a scanning SaaS) must be added before
  scaling** / before untrusted-tenant growth. Wire it into `documents.service`
  upload (scan the buffer before `putObject`, reject on hit).
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

   > **`packages/api-client-react/src/custom-fetch.ts` is a HAND-MAINTAINED source
   > file, not generated.** It is orval's configured *mutator* (see
   > `packages/api-spec/orval.config.ts` → `override.mutator`), and codegen's
   > `clean: true` only wipes `src/generated/`. Edit it deliberately and commit
   > your changes — do **not** dismiss it as codegen noise when it shows up in
   > `git status`. Only `src/generated/**` is off-limits. It is where
   > cross-cutting client behavior lives (cookie credentials, and the
   > `setApiErrorHandler` hook the web app uses for the M11.2 verification-gate
   > redirect).

5. **A privilege that becomes self-grantable invalidates every guard that trusts it.**
   *(Learned the hard way in M11.5.1 — do not repeat it.)*

   M5 decided the `/auth` user-administration endpoints could authorize off the
   **global** `req.session.userRole`. That was sound **only** because the value was
   un-mintable by untrusted parties: it came from the seed or from an existing
   admin. M11.5 then added public self-service signup which wrote
   `users.role = "admin"` — making that same privilege **self-grantable by any
   anonymous caller**, and instantly converting a documented, accepted boundary
   into a remote platform-wide account-takeover (CRITICAL-1: cross-tenant identity
   dump + arbitrary password reset, including the platform operator's account).
   Neither milestone was wrong in isolation; the vulnerability lived entirely in
   their *interaction*, so no per-milestone test could have caught it.

   **The rule:** whenever a change makes a role, flag, claim, or capability
   obtainable by a less-trusted party than before, you must re-audit **every**
   guard that trusts it — not just the code you touched. Grep for the value and
   read each consumer. Prefer authorization that is **explicit and scoped**
   (`requirePermission` for tenant business routes; explicit admin-of-THAT-org
   checks in the identity layer; `requirePlatformOperator` for cross-tenant
   surfaces) over any ambient global role. `users.role` is **vestigial and must
   never gate access** — the `organization_memberships` role is what governs.

6. **AI proposes; it never posts.**
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
