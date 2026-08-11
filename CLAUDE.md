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

## 2. Current State

> **This block is the answer to "where are things?". Everything below it in this
> section is the historical record of how we got here — accurate, but long.
> Keep this block current; if it disagrees with reality, fix it first.**

**Last updated: 2026-08-11 (M12 close-out).**

### Where we are

| Phase | Status |
| --- | --- |
| **Phase 0** — Platform Foundation (M1–M10) | ✅ **Complete.** Multi-tenancy + RLS, auth/session hardening, RBAC, layering, CI/CD, audit logging, draft/approval workflow + 4-role model. |
| **Phase 1** — Onboarding & Multi-Company (M11.1–M11.7) | ✅ **Complete.** Self-service signup behind a verification gate, platform operators, document upload, company/ZATCA identity, invitations. Includes the M11.5.1 CRITICAL security hotfix. |
| **Phase 2** — ZATCA Phase 2 / Fatoora (M12) | 🟡 **Closed except M12.7 + M12.9**, which are blocked on a real Saudi taxpayer registration. Everything buildable without ZATCA credentials is done. |
| **Next** | The rest of the platform — no ZATCA work is unblocked. |

### 🔴 What is verified LIVE vs only LOCALLY

Full detail: [`docs/zatca/m12-status.md`](docs/zatca/m12-status.md). The
one-paragraph version:

**Confirmed against the live ZATCA sandbox:** the CSR and `secp256k1` curve, the
XAdES properties and both digest encodings, all nine QR tags, six compliance
documents (standard + simplified × invoice / credit note / debit note, plus
zero-rated), and the ledger→ZATCA path built from real Postgres rows. Divergences
#1–#13 are checked against reality, not against a decompiled binary.

**🔴 NOT verified — we have never submitted an invoice to ZATCA.** The compliance
pass covers document **CONSTRUCTION** (`POST /compliance/invoices`, an onboarding
gate). The production path — `POST /invoices/{clearance,reporting}/single` — has
**never been called in any environment**. Also local-only: the outbox transport
(proven against a mock), the archive (`local-fs` only; the Supabase backend has
never touched a real bucket), renewal reminders (synthetic dates), and M12.8's
enqueue path (a self-signed certificate, not a real PCSID).

### What is blocked, and on what

**M12.7 (simulation) and M12.9 (production pilot)** need a **registered Saudi
company entity with an active ZATCA VAT registration and ERAD credentials.** That
does not exist, is not a technical step, and nothing unblocks it except the owner
registering the entity. No rework is expected when it arrives — sandbox exercises
the same API surface. **Do not** mock simulation to "finish" M12, and **do not**
onboard a real tenant to production before both have actually run.

### Pre-production queue — three groups

Nothing here blocks ordinary platform work; all of it blocks onboarding a real
taxpayer. Full detail in the consolidated queue later in this file.

- **B — BLOCKING for ZATCA (2 items).** Both halves of *a reminder that reaches
  nobody*: **B1** email delivery (`mailer` is still a no-op, so renewal reminders
  are sent to no one — and their whole value is lead time for an action only the
  tenant can take); **B2** real alerting (visibility is not alerting — the
  operator panel only helps someone already looking, and both the outbox age
  alarm and PCSID expiry fail by quiet neglect).
- **A — ONE MIGRATION (4 items).** Grants and config: `REVOKE TRUNCATE` (it
  bypasses RLS) on business tables and the five remaining owner-only tables,
  M-1 RLS on the identity tables, and `checkPeriodOpen`'s missing `company_id`
  scope.
- **C — VERIFICATION GAPS (6 items).** Trusted proxy + Redis rate limiters, the
  CI storage gap, KMS deployment verification, AV scanning, fail-closed
  diagnosability, and the hosting/residency decision.

### Open findings from the retroactive sweep (not yet fixed)

A backwards application of the standing check found **seven** more
schema-or-interface-without-a-consumer cases (S1–S7, detailed later in this
file). None is exploitable; all are documentation claiming a capability that does
not exist. The one that matters: **S1 — the `EInvoiceProvider` seam is only
~1/3 wired** (`buildDocument` only; `onboard`/`renewCertificate`/`submit` still
throw and the real paths bypass the seam), and that seam is one of the two
mandatory hedges behind the build-direct decision. The rest are `Redis` (listed
in the stack, used nowhere), a stale layout section, an empty `packages/auth`,
and `feature_flags`/`branches`/`departments` (tables with no consumer).

### 🔴 THE FOUR HUBS ARE NOT SPECIFIED — do not build against a reading of them

The project is described as an "AI-powered Accounting & Finance Operating
Platform", and the roadmap is spoken of in terms of a **Finance Hub, Automation
Hub, AI Hub, Analytics** and **integrations**. **None of those is defined
anywhere in this repository.** There is no spec, no scope, no acceptance
criteria — `docs/architecture-blueprint.md` covers architecture and tenancy only.

Any list of what those hubs "contain" that a session produces from the current
codebase — including the orientation given at the M12 close-out (treasury,
collections, recurring invoices, bank feeds, OCR, anomaly detection,
natural-language reporting, …) — is **a reading of the gap between what exists
and the stated ambition. It is not a specification and must not be treated as
one.** It was inferred, not recovered.

**Defining them is its own piece of work**, to be done deliberately with the
owner before anything is built against them. A future session that starts
implementing "the Automation Hub" from an inferred list will be building
someone's guess.

The one constraint that IS real and recorded: **AI proposes, it never posts**
(§5.6). That governs the AI Hub whatever it turns out to contain.

### Two standing rules earned the hard way

1. **[Six instances] Correct is not connected.** Before recording a milestone
   done, verify every capability has a production **caller**, every field a
   production **writer**, every client a real **implementation** (not an
   interface plus a mock), and every live external result is recorded with **the
   endpoint that produced it and what that endpoint attests**.
2. **Validate from real ledger rows.** Fixtures test the code you wrote; only
   real rows test the code you forgot to write.

---

### How Phase 0 got here (historical record)

We worked through **Phase 0 (Platform Foundation)** in small milestones to:

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

> **📄 Status summary:** [`docs/zatca/m12-status.md`](docs/zatca/m12-status.md) —
> what is done, **what is verified against the live API versus only locally**,
> what M12.7/M12.9 need, and the full pre-production queue. Read that first; this
> section is the narrative behind it.

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
| **IN SCOPE NOW — ✅ ALL COMPLETE** | **M12.0 → M12.6 _and_ M12.8** | Sandbox only. **Email registration, nothing else.** |
| **BLOCKED, DO NOT START** | **M12.7 and M12.9** | **A registered Saudi company entity with an active ZATCA VAT registration and ERAD credentials.** |

**M12.4 stays IN SCOPE — it is not an external dependency.** The 2026-08-07
outage that stopped it cleared on 2026-08-09, and the sandbox has since **issued a
real CCSID against our CSR without any account, VAT number or OTP validity**. The
gating requirement for M12.7/M12.9 is a *taxpayer registration*; M12.4 never
needed one. Do not move it into the blocked row.

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

### 🔴 OPERATING PRINCIPLE: **LIVE API > SDK > PDF**

**Revised in M12.4.** The original principle — *binaries beat PDFs* — was right
but **incomplete**. There is a third tier above the SDK, and it cost a full
rewrite to find:

| Source | Trust | Why |
| --- | --- | --- |
| **Live compliance API** | 🟢 **authoritative** | it is what actually gates real invoices |
| **SDK / decompiled binaries** | 🟡 useful offline signal | ZATCA's bundled SDK is a **stale 2021-era writer** |
| **PDF specification** | 🔴 unreliable narrator | fourteen documented divergences |

**The proof.** `crypto/qr.ts` was written from the PDF and was wrong in 3 of 4
tags. It was then rewritten from decoded SDK bytes — and was **STILL WRONG**, in
tags 3, 7, 8 and 9. It only became correct when determined from live
`/compliance/invoices` responses.

**The M12.3 SDK differential passed byte-for-byte the entire time.** It proved
only that we matched a stale writer — **necessary but NOT sufficient**. Worse,
its green status was actively misleading: it read as validation.

So: **a green SDK differential is NOT evidence of compliance. Only a live PASS
is.** Keep the SDK differential — it is a genuinely useful fast offline check
that needs no network — but never treat it as the gate. The gate is
`tests/zatca-compliance-live.test.ts`.

The three most counter-intuitive divergences (#10 `SignatureValue` not over
`SignedInfo`, #11 SignedProperties digest over dom4j `asXML()`, #12 `CertDigest`
over the base64 string) were **decompilation-only until M12.4** and are now
confirmed against reality — a standard invoice would not clear if any were wrong.

### The older framing, retained: ZATCA's BINARIES beat the PDFs

**Whenever ZATCA's documentation and ZATCA's shipped software disagree, follow
the software** — and record the divergence in
[`docs/zatca/spec-vs-implementation-divergences.md`](docs/zatca/spec-vs-implementation-divergences.md)
with what the PDF claims, what the binary does, and which we track.

This is not a stylistic preference. **TWELVE divergences have been found so far,
every one of them by running or DECOMPILING ZATCA's SDK rather than reading their
PDF**, and every one would have failed at M12.4 with a rejection and no useful
diagnostic: the elliptic curve, three separate CSR-structure errors, an entirely
undocumented required certificate extension, three XAdES property errors, a
signature that uses *two different digest encodings in the same document*, a
`SignatureValue` that is **not computed over `SignedInfo` at all**, a
SignedProperties digest taken over **dom4j `asXML()` rather than any
canonicalisation**, and a `CertDigest` over the **base64 certificate string
rather than its DER**.

#### ✅ VALIDATION STATUS — #1–#12 confirmed against ZATCA; #13 CORRECTED

**M12.4 ran all six compliance documents against the live API.** Every divergence
is now checked against reality rather than against a decompiled binary.

| Divergence | Area | Status |
| --- | --- | --- |
| **#1–#5** | curve, CSR structure, template extension | ✅ confirmed (CCSID issued, binds our key) |
| **#6–#12** | XAdES properties, digests, `SignatureValue`, `CertDigest` | ✅ **confirmed** — standard invoice + debit note returned `PASS` / `CLEARED` |
| **#13** | QR tags 3, 6–9 | 🔴 **WAS WRONG, now corrected and pinned** |

**#13 was wrong twice, from two different sources.** Written from the PDF →
wrong; rewritten from decoded SDK bytes → **still wrong**; correct only from live
responses. The verified layout: tag 3 has **no trailing `Z`**, tags 6 and 7 are
base64 **strings**, tags 8 and 9 are **raw bytes**, and tag 9 comes from the
CERTIFICATE (the CA's signature), not from our signature. The M12.3 note flagging
the `r`/`s` split as "intent UNVERIFIED" is what stopped this shipping — it was
an artefact of ZATCA's TLV writer.

**How the fault was isolated:** standard documents passed while both simplified
ones failed with QR-only errors. Standard invoices are cleared by ZATCA, which
generates their QR itself — so that clean split localised the bug to the QR and
exonerated the whole signature chain in a single run.

Full evidence, with the exact error codes per tag:
[`docs/zatca/spec-vs-implementation-divergences.md`](docs/zatca/spec-vs-implementation-divergences.md).

**🔴 Sandbox traps — a green sandbox run is NOT validation:**

- **The sandbox accepts ANY OTP** (`123456`, `123345`, `111222` all issue). It
  says **nothing** about whether the real OTP path works.
- **`requestID` from the compliance endpoint is the constant stub
  `1234567890123`.** Never build reconciliation logic on it.
- **The sandbox PCSID is a SHARED CANNED CERTIFICATE**
  (`CN=TST-886431145-399999999900003`, "Maximum Speed Tech Supply LTD", issued
  Jan 2024, VAT `399999999900003`) — **not bound to our key**. Signing with it
  would sign as another taxpayer. `activateCredential` now verifies the returned
  certificate's public key against the stored private key and **refuses** a
  mismatch (`CertificateMismatchError`); the check is correct in every
  environment and catches this automatically.
- **PCSID issuance is NOT a compliance gate in sandbox** — a PCSID is issued even
  when compliance documents FAIL. So compliance results must be **asserted
  directly** from `/compliance/invoices`, never inferred from "we got a
  certificate".

**Decompile early.** Several were invisible to black-box testing — ~30
canonicalisation variants were tried and failed before decompiling
`SigningServiceImpl` answered it in minutes. CFR (`cfr.jar`) works on the SDK
jar; the packages are `com.zatca.sdk.*` and `com.gazt.einvoicing.*`.

**The natural experiment — the strongest evidence for this principle.** M12.3
produced a clean controlled comparison, entirely by accident:

| Module | Written from | Correct? |
| --- | --- | --- |
| `crypto/invoiceHash.ts` | verified against ZATCA's binaries | ✅ |
| `crypto/csr.ts` | verified against ZATCA's binaries | ✅ |
| `crypto/xades.ts` | verified against ZATCA's binaries | ✅ |
| `crypto/qr.ts` | **the PDF alone** | ❌ **wrong in 3 of 4 Phase 2 tags** |

Same engineer, same session, same care. The only variable was the source. The
three modules checked against binaries were right; the one written from the
specification was wrong — its docstring even confidently explained the PDF's
(incorrect) rule that tag 6 carries raw digest bytes.

**So: anything written from the PDF is SUSPECT until a binary confirms it.** And
note *how* it stayed hidden — M12.2's `[QR] PASSED` was validating ZATCA's *own*
signed output, not ours. **A differential must compare OUR output against
ZATCA's**, or it proves nothing about our code.

The PDFs are not uniformly wrong (the transform chain, QR TLV rules and
algorithm identifiers all check out) — they are **unreliable**, which is worse,
because it means you cannot tell which parts to trust without checking.

**So, concretely:**
- Verify against the SDK **before** building, not after. `fatoora -csr`,
  `-generateHash`, `-sign` and `-validate` are ground truth.
- ZATCA's own XAdES template lives inside their jar at **`xml/ubl.xml`** — it is
  the real XAdES specification.
- Differentials against the SDK are **blocking tests**, not investigative ones.
  A correct hash with a structurally wrong signature passes a hash check and
  still fails at M12.4.
- The SDK is checksum-pinned so a ZATCA-side change is detectable.

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
  sandbox confirmed live and email-only; hosting/residency established as an open
  deployment decision rather than a migration — though the *premise* recorded
  then (in-country storage mandated) was corrected in M12.8: see the residency
  correction. Sandbox account registration is a manual owner step (see
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
  - **Also fixed (pre-existing, unrelated): a genuinely non-deterministic audit
    test.** `audit.test.ts` destructured `const [createLog, updateLog] = rows`
    from an `ORDER BY created_at` query. **Postgres `now()` is the TRANSACTION
    timestamp**, so the create and the update — written in one request
    transaction — carry an *identical* `created_at` and the sort had no tiebreak.
    Latent flakiness the `customers` column addition exposed by shifting physical
    row order. **`audit_logs.id` is a random uuid, not a sequence, so ordering by
    it does not fix this** (a first attempt did exactly that, passed locally by
    luck, and failed in CI). The test now selects rows **by `action`** and
    asserts their content — ordering was never the property under test. The other
    four transition tests use `toContain` and are order-insensitive; their
    `ORDER BY` is incidental and was left alone.
    **If you ever need true audit ordering, `audit_logs` has no monotonic
    sequence column — add one rather than ordering by `id`.**
- **M12.1b (done): credit & debit notes as first-class documents.** Notes are
  `invoices` rows carrying `document_type` — ZATCA requires them in the SAME
  per-EGS hash chain and ICV sequence, so a separate table would be wrong.
  - **🔴 A CREDIT note reverses; a DEBIT note does NOT.** A debit note is an
    ADDITIONAL charge (undercharge, price correction upward), so it posts in the
    same direction as an invoice: Dr AR / Cr Sales + VAT. Only the credit note
    reverses. Treating both as reversals understates AR and output VAT.
  - **🔴 AMOUNTS ARE STORED POSITIVE; the direction lives in `document_type`.**
    Negative storage was evaluated and rejected because it FAILS SILENTLY in two
    of the four invoice reports while working in the other two — which is what
    makes it dangerous:
    - **AR aging** skips them (`if (outstanding < 0.01) continue`), so it drifts
      from balance-sheet AR with nothing to show it;
    - **the VAT return** misroutes them — a negative `vat_amount` fails the
      `> 0` guard, computes a rate of 0, lands in the ZERO-RATED box and **never
      reduces output VAT**. A silent filing error against ZATCA.
    Every consumer applies **`documentSign()`** (`reports.repository.ts`)
    explicitly, so forgetting it is a visible omission. Six consumers: AR aging,
    balance-sheet AR, VAT return, customer ledger, customer balance, and the GL.
  - **The note→original reference is a REAL FK** (`invoices.original_invoice_id`,
    migration `0020`) with a CHECK constraint: an invoice has neither reference
    nor reason; a note must have BOTH. ZATCA's `cac:BillingReference` carries the
    original's NUMBER but it is DERIVED from the referenced row, so it can never
    drift. `note_reason` is in the constraint because **BR-KSA-17** requires it.
  - **Closed periods: the NOTE'S OWN date governs.** Correcting an invoice from a
    closed period is legitimate and is NOT blocked — the correction posts in the
    current open period, which is standard practice. Dating the note *into* the
    closed period is refused by the existing `checkPeriodOpen`. Consequence worth
    knowing: the closed period's VAT return does not change; the adjustment lands
    in the note's period.
  - **Over-crediting is refused (409)** naming the invoice total, what is already
    credited and what remains. Checked at create AND re-checked at approval,
    because a concurrent note can consume the remaining credit while one sits in
    the queue. Debit notes have no equivalent ceiling.
  - **Zero-movement proven** (`tests/credit-notes-zero-movement.test.ts`) to the
    M10 standard: a draft AND submitted note move zero across AR aging,
    balance-sheet AR, the VAT return and the customer balance; approval posts the
    correct direction.
  - **Fixed here (pre-existing, in scope):** `customers.repository` had **no
    status filter at all**, so DRAFT invoices inflated every customer balance — a
    gap M10 left when it added `approvedInvoicesOnly()` to the reports but not to
    that path.
- **M12.2 (done): UBL 2.1 XML generation + the `EInvoiceProvider` seam.**
  - **`EInvoiceProvider`** (`services/einvoice/provider.ts`) is declared in FULL
    now — `onboard` / `renewCertificate` / `buildDocument` / `submit` — with the
    unbuilt methods throwing a typed `NotImplementedError` naming their
    milestone, so a caller can never mistake "not built" for "succeeded with
    nulls". The interface is deliberately **coarse**, matching what a vendor
    actually sells (invoice data in, finished artifacts out); an interface shaped
    around our internal steps could not be implemented by any provider, which
    would defeat the seam. Selection is **per company** (`resolveProvider`), since
    ZATCA identity is per EGS unit. Ours is `zatca-direct`.
  - **The generator is OURS, the crypto is not.** `buildInvoiceXml` is a pure
    function (`EInvoiceInput` → XML string, no DB/context/clock) built on
    `xmlbuilder2`. UBL generation is domain-model→schema mapping; the library
    reservation applies to **C14N, XAdES and the CSR template** in M12.3.
  - **The M12.2/M12.3 boundary is read off the spec, not invented.** The ZATCA
    transform excludes exactly `ext:UBLExtensions`, `cac:Signature` and
    `cac:AdditionalDocumentReference[cbc:ID='QR']` — precisely what M12.3
    injects. Everything M12.2 emits IS signed content, **including the ICV and
    PIH references**. A test asserts those three are absent, so the boundary
    can't silently drift.
  - **VALIDATED AGAINST ZATCA'S OWN SDK** (`tests/ubl-zatca-validator.test.ts`):
    generate → `-sign` → `-validate`. **Standard and simplified invoices both
    pass XSD, EN 16931 and all 55 `BR-KSA-*` rules** (simplified also passes QR).
    The SDK ships no sample invoices, so there is no golden file — this IS the
    authority. Skips **loudly** (a prominent banner) when Java or the SDK is
    absent; **CI now installs Java 17 and caches the SDK by its pinned
    checksum**, with the fetch `continue-on-error` so a SharePoint outage can't
    red-build unrelated work.
  - **🔴 The signature stage is deliberately NOT asserted.** The SDK's bundled
    `cert.pem` **expired 18 Apr 2024** and its subject VAT isn't our fixture's
    seller, so `[SIGNATURE] FAILED` is guaranteed regardless of what we generate
    — it says nothing about our document. Real signature verification is M12.3
    (our keys) and M12.4 (a sandbox CSID). Do not "fix" this by chasing the
    signature result.
  - **🔴 TWO schematron requirements the rule text does not state.** Both found by
    running the validator, not by reading the spec — the reason the CI investment
    was worth it:
    - **BR-KSA-09 (seller)** needs `cbc:PlotIdentification` — the National
      Address **additional number** (KSA-23). Added as `companies.additional_number`.
      (Only a *warning*.)
    - **BR-KSA-10 (buyer)** is a hard **error** and additionally asserts
      **`cbc:CountrySubentity`** and `cbc:CitySubdivisionName`, while its message
      names only "street, city, postal code, country code". Added as
      `customers.province`. **A regression test pins this**, so deleting the
      field fails loudly instead of silently breaking every B2B invoice.
    - Also noted: `cbc:BuildingNumber` is capped at **4 characters** (BR-CL-KSA-17).
    - Migration `0017_m12_2_national_address_fields` (additive, nullable — the
      fields are not required for simplified invoices).
  - **`cac:AccountingCustomerParty` is MANDATORY in UBL even for an anonymous B2C
    sale** — omitting it fails XSD before any KSA rule is reached. BR-KSA-10
    exempts simplified invoices from the buyer *address*, not from the element.
  - **Assembler** (`einvoiceInput.assembler.ts`) is the only DB-aware piece and
    **fails closed** on anything that would mint a legally-invalid document:
    a NULL line tax category (the ambiguous 0%-VAT case M12.1a left unbackfilled),
    a non-standard category with no exemption reason, or a missing company VAT /
    UUID / ICV. Standard-vs-simplified is derived from whether the **buyer** is
    VAT-registered.
  - **Test-infra fix:** the Java subprocesses starved other suites' `beforeAll`
    hooks at the 10s default, failing four unrelated DB-backed suites. Fixed with
    `hookTimeout: 60_000`. **Do NOT "fix" it with `fileParallelism: false`** —
    that is several times slower AND couples suites to each other's leftover
    state (`operator.test.ts` fails under that ordering while passing alone).
- **M12.3: cryptography** — ECDSA **`secp256k1`** keygen, CSR, XAdES signing, QR
  tags 6–9, and **replacing `computeInvoiceHash`** (see the landmine below).
  **Build against [`docs/zatca/security-standards-notes.md`](docs/zatca/security-standards-notes.md)**
  — spec-verified notes with two 🔴 traps that a plain reading of ZATCA's own
  document gets wrong: the curve is **`secp256k1`, NOT P-256** (P-256 appears only
  in an explicitly *illustrative* table; ZATCA's SDK emits
  `ec-secp256k1-priv-key.pem`), and the CSR **invoice type goes in `title`, not
  `businessCategory`** (the spec assigns OID 2.5.4.15 to two different rows).
  Both fail only at M12.4, after the whole crypto layer is built.
- **M12.4 (done): sandbox onboarding + compliance checks — THE CRYPTOGRAPHY IS
  NOW PROVEN AGAINST ZATCA.** CSR → CCSID → the six compliance documents → PCSID.
  - **All six compliance documents PASS** against the live sandbox — standard and
    simplified, invoice / credit note / debit note — with zero errors and zero
    warnings, plus a zero-rated (0% VAT) invoice. This is the milestone that
    validates divergences **#6–#12** and corrected **#13** (see the validation
    status above). The connectivity block that stopped it cleared on 2026-08-09.

    **🔴 SCOPE OF THAT PASS — read before citing it.** It came from
    `POST /compliance/invoices`, which validates **document CONSTRUCTION**: the
    UBL, the XAdES signature, the digests, the QR, the chain. It is an
    *onboarding gate* — "can this EGS unit produce valid documents?"
    **It is NOT submission.** `POST /invoices/clearance/single` and
    `POST /invoices/reporting/single` — the production path — have **never been
    called, in any environment**, and appear only in `liveZatcaClient.ts`.
    So the response shapes `errorMapping.ts` interprets, the `Clearance-Status`
    header, where `clearedXml` actually arrives, and real ZATCA error codes are
    all **unverified**. Do not read this green result as end-to-end proof; it is
    finding **#6** in the standing-check table, and M12.7's first task.
  - **🔴 `tests/zatca-compliance-live.test.ts` is now THE GATE**, replacing the
    SDK differential as the authoritative check. The SDK differential is KEPT as
    a fast offline signal but it is no longer evidence of compliance — it passed
    byte-for-byte while the QR was rejected by the live API. It now asserts the
    **deliberate divergences** from the SDK (tags 3, 7, 8, 9), so a future SDK
    release that changes to match the live API fails loudly instead of silently.
    The live test **skips loudly** when ZATCA is unreachable so an outage cannot
    red-build unrelated work — a green run without it proves much less.
  - **QR corrected** (`crypto/qr.ts`): tag 7 = base64 signature STRING, tag 8 =
    raw SPKI public key, tag 9 = the CA's signature over the CERTIFICATE. Tag 6
    (base64 string) was the one part of the old reading that held.
    `splitEcdsaDer` was **deleted**, not left unused, so the disproven `r`/`s`
    split cannot be reached for again.
  - **A second, independent QR bug found and fixed: the timestamp.** QR tag 3
    carried a trailing `Z` that disagreed with UBL's `cbc:IssueTime` (which has
    no timezone designator), warning `invoiceTimeStamp_QRCODE_INVALID`.
    **Stripping milliseconds was NOT the fix** — that was tested separately and
    still warned. The real bug was that the same fact had **two independent
    formatters**, so `services/einvoice/issuedAt.ts` is now the single source and
    `assembleSignedInvoice` takes `issuedAt: Date` rather than a preformatted
    string. That makes the drift impossible rather than fixing one instance.
  - **Onboarding flow** (`services/einvoice/onboarding/`): prerequisites → CSR →
    CCSID → six documents → PCSID → activate, plugged into M12.5's
    `createCredential`/`activateCredential`. The six documents are signed inside
    ONE scoped `withCredentialKey` callback, so the key is never in memory during
    a network call.
  - **The OTP boundary:** the tenant generates the OTP in their OWN Fatoora
    portal and pastes it in. We never see, store or proxy their ERAD
    credentials; the OTP is trimmed, used once, and never persisted (asserted by
    a test).
  - **Prerequisites checklist** surfaced BEFORE onboarding starts (the M11.6
    fields: VAT, CR, Arabic name, and the full national address including the
    `additionalNumber` that only schematron reveals). Onboarding fails closed
    with `zatca_prerequisites_missing` naming each gap, so a tenant fixes it in
    Company Settings rather than hitting an opaque ZATCA rejection mid-flow.
  - **Compliance failure blocks activation**: if any document is rejected, the
    production CSID is **not requested**, the credential is revoked, and the
    per-document ZATCA errors are returned to the UI. Asserted directly rather
    than inferred from PCSID issuance — because in sandbox a PCSID is issued even
    when documents FAIL.
  - **UI** (`/zatca`): prerequisites checklist, OTP paste, per-document
    compliance results, certificate status and expiry with a T-90 warning banner.
    RBAC: `zatca_onboarding` read = all roles, **create = admin only**.
  - **New finding, pinned in the REJECTING direction:** `VATEX-SA-EDU` /
    `VATEX-SA-HEA` require a buyer **national ID** (BR-KSA-49) and buyer **name**
    (BR-KSA-25), so they cannot appear on an anonymous simplified invoice at all.
    Found by submitting one. The assembler should eventually fail closed on this
    rather than letting ZATCA reject it.
  - **⚠️ COVERAGE GAP (closes with M12.1b):** the compliance credit/debit notes
    are built from **directly-constructed inputs**, not from the database. They
    are test artifacts that never post to the ledger, so M12.1b was NOT a
    prerequisite — the note XML (`InvoiceTypeCode` 381/383 + `cac:BillingReference`)
    has existed since M12.2. But `einvoiceInput.assembler.ts` still hardcodes
    `billingReference: null`, so **a note assembled from real ledger rows has
    never been validated by ZATCA.** Close this when M12.1b lands.
- **M12.5 (done): credential vault.** Per-company ZATCA signing keys, stored
  encrypted and reachable only through one narrow service. Full design:
  [`docs/zatca/m12-5-credential-vault-design.md`](docs/zatca/m12-5-credential-vault-design.md).
  - **`zatca_credentials` (migration `0019`) — owner-only, no RLS, no app-role
    grants.** The sixth table on that pattern, but for a different reason than
    the first five: not "keep identity data out of tenant scope" but **blast
    radius under app-role compromise**. RLS answers "can org A read org B's row";
    it does NOT stop a SQL-injection flaw in any of the ~18 business domains from
    reading the *current* tenant's signing key, because the app role is acting as
    that tenant. With no grants at all, no business route is on the attack path.
  - **🔴 The migration REVOKEs explicitly — do not delete that block.** Creating a
    table is not sufficient: Supabase's base `ALTER DEFAULT PRIVILEGES` silently
    grants `REFERENCES, TRIGGER, TRUNCATE` on every new table to
    `anon`/`authenticated`/`service_role` (verified locally — all five existing
    owner-only tables carry exactly those three). **`TRUNCATE` needs no DELETE
    privilege and bypasses RLS**, so without the REVOKE the app role could wipe
    every tenant's signing keys in one statement — unrecoverable, since each
    tenant would have to re-onboard. The REVOKE is guarded per role (CI
    bootstraps only `authenticated`). This is the platform-wide MEDIUM finding,
    fixed for the one table where destruction is catastrophic.
  - **Envelope encryption: ONE platform CMK + per-company DEKs.** AES-256-GCM
    under a per-company data key; the DEK is wrapped by the master key. The
    plaintext DEK is never stored. **`KeyWrapper`** (`signing/keyWrapper.ts`) is
    the seam — `LocalDevKeyWrapper` for dev/CI, `AwsKmsKeyWrapper` for
    deployment. `@aws-sdk/client-kms` is **deliberately not a dependency**: the
    specifier is a runtime variable so neither tsc nor esbuild pulls it into the
    build graph, and installing it is a deployment step.
  - **`local-dev` cannot reach production, checked twice independently:**
    `loadEnv` refuses the provider at boot, and the signing service refuses any
    row whose stored `kms_provider` is `local-dev` when `NODE_ENV=production`.
    Shipping fake cryptography is the failure that would stay invisible until
    ZATCA rejected everything.
  - **The narrow signing service** (`signing/signing.service.ts`) is the only code
    that decrypts. There is **no `getPrivateKey()`** — callers pass a callback
    (`withSigningKey`, `withTransportCredentials`) and only its return value
    escapes; plaintext lives in Buffers zeroed in a `finally`, never a PEM string.
    Seven enforcement layers: no key field on any exported type; the vault
    repository is outside `repositories/` with a **test that fails the build** on
    outside imports; `toJSON()` **throws**; nothing key-bearing reaches a logger;
    every error is re-thrown as `SigningError` with a **fixed** message (because
    `errorHandler` puts `err.message` on the wire and an OpenSSL/KMS error can
    quote key bytes); and no HTTP route returns key material.
  - **`ownerDb` is now exported from `@workspace/db`** — owner-only tables must
    state the connection they mean rather than relying on the tenant proxy
    failing.
  - **The CSID `secret` is encrypted like the private key.** ZATCA returns it in
    the same JSON body as the certificate so it reads like metadata; it is the
    password half of the transport's Basic auth.
  - **Both M12.3 prerequisites landed first** (before anything persisted a key):
    `privateKeyPem` is **removed** from `generateZatcaKeyPair`'s return type — not
    made lazy, since a getter still yields an unzeroable string — and
    `assertZatcaCurve` now runs its DER check on the **derived public key**, same
    OID assurance with no private-key copy.
  - **Lifecycle:** `pending_csr → active → superseded | revoked`, with rotation
    superseding the old credential in one transaction and a **partial unique
    index** making the DB the guarantee of one active credential per (company,
    environment). Superseded rows are retained (past invoices were signed under
    them; the archive must stay verifiable for 6–11 years); revocation
    **crypto-shreds** the key while keeping metadata and the public certificate.
  - **Tests** (`tests/zatca-credential-vault.test.ts`, 19 + 7 DB-boundary in
    `packages/db`): the valuable ones are negative — the app role cannot
    SELECT/INSERT/UPDATE/DELETE/**TRUNCATE** the table, serialisation throws,
    errors leak nothing (including when decryption itself fails), one company
    cannot sign as another, and revocation makes signing impossible. All run with
    **no KMS**. **They do NOT prove the AWS IAM/key policy is correct** — that is
    deployment verification, the same shape as the known M11.4 storage gap.
  - **NOT built here — the per-tenant onboarding FLOW** (the OTP paste UI and the
    route that drives CSR → CCSID → PCSID). The vault deliberately ships first
    and standalone: it is the storage and access boundary, and it is complete and
    tested on its own. The flow that *fills* it calls ZATCA's compliance
    endpoints, so it belongs with **M12.4**, which now has a live sandbox to
    build against. `createCredential` / `activateCredential` are the seam it
    plugs into.
- **M12.6: clearance & reporting transport** — outbox + worker (see the M12.6 bug
  above), retry, idempotency, status model, ZATCA error-code surfacing.
- **M12.8 (done): archival, residency, renewal, operator visibility — AND the
  milestone that finally CONNECTED the ZATCA pipeline to the product.**
  - **🔴 The outbox had no producer.** Closing that was agreed into M12.8 scope
    because the two halves are inseparable: fixing the chain ordering alone
    corrects a chain nothing writes to, and wiring the enqueue alone activates a
    fork in the chain ZATCA legally validates, on real customer invoices. The
    disconnection was *masking a live compliance defect*. See the
    three-occurrences table below.
  - **BUG FIXED — the fork was still live in the ZATCA chain.**
    `zatcaPreviousInvoiceHash` ordered by `einvoice_documents.invoice_id DESC`:
    the same row-id defect M12.1b fixed for the homegrown chain, in the same
    file, left on the chain that legally matters. It had **neither** mechanism —
    wrong ordering AND read outside `lockCompanySequence` (the loader resolved it
    at assembly time). Now ordered `icv DESC NULLS LAST, id DESC` and read inside
    the lock. `loadEInvoiceInput` takes `previousInvoiceHash` as a **required
    parameter** so the read cannot drift back outside the critical section.
    Proven by `tests/einvoice-enqueue.test.ts`, whose headline case is
    **strictly sequential** (approve 3 → 1 → 2, no concurrency) because that is
    the ordinary approver behaviour a race-shaped fix would have missed.
  - **Enqueue-on-issuance** (`services/einvoice/outbox/enqueue.ts`), called from
    `issueInvoice` inside the sequence lock and the tenant transaction, so the
    queued row commits atomically with the ledger effect. It **builds and signs
    there**, because the worker's contract is that it never mints a hash or
    signature — that is what makes a retry byte-identical. Two failure policies,
    deliberately different: **not onboarded ⇒ skip silently** (every existing
    tenant must still be able to invoice), **onboarded but unbuildable ⇒ throw**
    and roll the approval back (an invoice ZATCA never learns about would consume
    an ICV and leave a permanent gap in a legally-required sequence — refusing to
    issue is recoverable, a gap is not). An onboarded company's invoice also gets
    the **Phase-2 (9-tag) QR** written over the Phase-1 one.
  - **`ZATCA_WORKER_ENABLED` finally declared** in `@workspace/config` (it was
    referenced in two comments and existed nowhere), plus the **live
    clearance/reporting client** (`zatca/liveZatcaClient.ts`) — without it an
    instantiated worker would have thrown on every send.
    🔴 The flag uses a strict `booleanFlag`, **not `z.coerce.boolean()`**:
    `Boolean("false")` is `true`, so coercion would turn an explicit
    `=false` into ON for a flag that starts transmissions to a government API.
  - **First background-job infrastructure in the repo** (`jobs/scheduler.ts`).
    One loop, three jobs (outbox, archive sweep, renewal check) sharing it rather
    than each inventing a timer. Each exposes `runOnce()` separately from the
    schedule, so tests drive them deterministically and an operator can run any
    of them on demand **with the worker off**. Self-rescheduling `setTimeout`
    (not `setInterval`) so a slow ZATCA response cannot stack up submissions.
  - **Archive** — `ArchiveStore` is a swappable interface (`local-fs` for
    dev/CI/on-prem, `supabase-storage` for cloud), chosen at deployment like
    M12.5's `KeyWrapper`. 🔴 **It has no `delete` method, by design**: ZATCA §5.5
    forbids deletion or alteration of generated invoices, so the interface cannot
    express it. `einvoice_archive` (migration `0022`) is tenant-scoped with RLS
    and **GRANT SELECT, INSERT only** — with UPDATE/DELETE/**TRUNCATE**/
    REFERENCES/TRIGGER revoked, because TRUNCATE bypasses RLS and would erase
    every tenant's index in one statement. Pinned by a DB boundary test.
    Filenames follow §5.5 exactly: **VAT + GENERATION timestamp + invoice
    reference** — 🔴 generation (`invoices.issued_at`), never clearance.
    The sweep is a **separate pass from submission** so a storage outage cannot
    turn a document ZATCA already accepted into a failed submission.
  - **Renewal reminders** at T-90/30/7, driven off real `not_after` data,
    idempotent via a **unique index** on (credential, threshold) rather than a
    scheduling assumption. An already-expired certificate still reports —
    silence after expiry is the worst case. 🔴 A bug caught by its own test:
    searching the descending `[90,30,7]` returns the WIDEST crossed window, so a
    certificate with 5 days left would have been announced as a T-90 notice;
    the search is now explicitly ascending.
  - **Operator visibility** — `GET /operator/zatca/{health,overdue,needs-review,
    certificates,onboarding}` + `POST /operator/zatca/jobs/:name/run`, rendered
    in `OperatorZatcaPanel.tsx`. Metadata only: queue depth, ages, expiry dates,
    onboarding state. Never a tenant's financial data, never XML, never key
    material — the M11.3 rule is unchanged. Onboarding status is derived from
    `zatca_credentials.status`; **`companies.zatca_onboarding_status` was DROPPED**
    (migration `0022`) because nothing ever wrote it, so every row read
    `not_started` forever.
  - **Residency: the recorded requirement was wrong.** See the correction below —
    ZATCA §5.5 explicitly permits cloud storage; the binding constraint is
    ACCESSIBILITY (a direct link for the Authority), which is why
    `ArchiveStore.directLink` is part of the interface. The backend stays
    swappable regardless.
  - **Flagged, not taken on: email delivery.** `lib/mailer.ts` is still
    `noopMailer` (`delivered: false`), so reminders reach a human only in-app and
    through the operator panel. The row records whether email actually went, and
    an absent reminder is worse than a late one here because renewal needs the
    tenant's own OTP. Integrating SES/Resend/Postmark (~$0–20/month) is the
    dependency to close before go-live.
- **M12.7 and M12.9: BLOCKED** on the Saudi entity — simulation end-to-end, and
  the production pilot. Nothing else in M12 is blocked.

### 🔴 RESIDENCY CORRECTION — "must be stored inside Saudi Arabia" was NEVER in the specification

**A recorded requirement that shaped hosting thinking for three milestones turns
out not to be a ZATCA requirement at all.** It was believed until M12.8, when the
primary source was actually read.

**What the primary source says.** §5.5 (*Data Storage and Archival*) of the
E-Invoicing Detailed Guideline — the pinned PDF in `docs/zatca/specs/` — states
that taxpayers *"may store their electronic invoices in a server **on-premises in
the KSA or in the cloud** as per their solution requirements."* The same section
adds that *"Taxpayer's E-Invoice Solutions **may reside on the cloud** in
accordance with VAT Implementing Regulation."* Cloud storage is **explicitly
permitted**, not tolerated.

**The binding constraint is ACCESSIBILITY, not location:** *"if the data is
hosted on the cloud, it must be **accessible through a direct link that can be
made available to the Authority**. This requirement is mandatory for audit
purposes."* That is a capability we must build — see the M12.8 design — and it is
a materially different obligation from a geography.

**Where the wrong claim came from, and why it survived.** A secondary source
(vendor/blog material of the kind that summarises this area) asserted in-country
storage; it was recorded here as fact and never checked against the PDF. Note the
irony: this repository's own operating principle is that **ZATCA's PDFs are an
unreliable narrator** — but that principle was formulated about the PDFs being
*wrong where a binary disagrees*. It was never a licence to skip reading them. A
secondary source is strictly worse than an unreliable primary one, and here the
primary source was not merely more reliable, it was **the opposite of what we
believed**. Add the tier explicitly: **LIVE API > SDK > PDF > anything else.**

**What is NOT settled, and must not be treated as settled.** §5.5 defers outward:
*"additional non-tax-related regulations may apply to the taxpayer entity, such
as **National Cybersecurity Authority** published laws and any other applicable
regulations or controls."* So residency pressure may still exist — from NCA / CSP
cloud controls or sector regulation (e.g. financial-sector rules), **not from
ZATCA**. That is a **LEGAL question we have not verified**, and it must not be
acted on as though we had. We have neither established that KSA hosting is
required nor that it is unnecessary.

**Therefore the engineering position is unchanged, for a better reason.** The
storage backend stays **swappable behind an interface**, exactly as planned — not
because a KSA host is required, but because **an unverified claim is not a basis
for committing hosting, and neither is the absence of one.** The interface is
what lets the legal answer arrive late without costing a rewrite. Do not "simplify"
it away on the strength of this correction.

**Verified in the same reading, and safe to build to:**
- **Naming convention** — *"VAT Registration (tax registration number) +
  Timestamp (date and time **at the point of invoice generation**) + Invoice
  Reference Number."* 🔴 **GENERATION, not clearance.** These differ (clearance
  is later, and for simplified invoices reporting can be up to 24h later), and
  the inversion is easy to make and invisible once made.
- **Immutability** — *"Once invoices are generated, they should not be deleted or
  altered by any user"*, and the solution must *"protect the generated Electronic
  Invoices ... from any alteration or undetected deletion."* This is a **property
  of the archive, not a retention duration** — enforce it the way `audit_logs`
  and `security_audit_logs` already do (DB-level REVOKE + a boundary test), not
  by convention.
- **Retention** — 6 years, 11 for certain cases. The e-invoicing guideline itself
  only says *"archived as per VAT regulations"*; the durations come from the VAT
  Implementing Regulation, not from this document.

### 🔴 "CORRECT" IS NOT "CONNECTED" — the Phase-2 pipeline was unreachable from real data

**Read this before reading M12.4's green result as more than it is.**

Until M12.1b, `issueInvoice()` never wrote `icv` or `zatca_uuid`. Every invoice
issued at runtime carried NULLs, and `assembleEInvoiceInput` **rejects** a row
without them (`missing_icv` / `missing_uuid`). So the entire ZATCA Phase-2
pipeline — UBL generation, signing, the QR, the outbox — **could not run on a
single real invoice.**

M12.4 validated six compliance documents against ZATCA's live API and every one
passed. That result is real, but it was obtained from **directly-constructed
inputs**, because nothing else was possible. It proved *the implementation is
correct*; it did **not** prove *the implementation is connected to the product*.
Those are different claims and it would be easy to read the first as the second.

**M12.1b closes the gap:** ICV/UUID are assigned at issuance, `loadEInvoiceInput`
builds the document from database rows, and
`tests/credit-notes-zatca-live.test.ts` submits an invoice, a credit note and a
debit note **read back out of Postgres** to the live compliance API.

Two bugs surfaced the moment real rows were used, both invisible to
hand-built fixtures:

1. **The wrong chain was being fed to ZATCA.** The loader passed
   `invoices.previous_hash` — the HOMEGROWN chain — as the PIH. On the first
   document of a chain that is the literal string `"GENESIS"`, which ZATCA
   rejects with `'GENESIS' is not a valid value for 'base64Binary'`. On every
   *subsequent* document it passed **silently**: a 64-character hex hash is
   accidentally well-formed base64, so ZATCA **accepted a PIH that means
   nothing** — a chain link pointing at a value from a different chain
   altogether, returned as `CLEARED`. The ZATCA PIH now comes from
   `einvoice_documents`, never from `invoices`.

   **🔴 Only the LOUD genesis failure exposed it.** Had the genesis case
   happened to be well-formed, the bug would have shipped: every document
   cleared, every response green, and the chain meaningless. **A stricter
   validator on ZATCA's side would have caught this at document one** — hex
   digits are a subset of the base64 alphabet, so `base64Binary` well-formedness
   is a near-worthless check here; a length or decoded-value check would have
   rejected it immediately. The lesson generalises past ZATCA: **when an
   external validator is the only thing checking a value's meaning, assume it
   checks the weakest property it plausibly could.** Validate our own chain
   linkage locally rather than inferring correctness from an accepted
   submission.
2. **The hash chain forked under out-of-order approvals** — see below. Note that
   this one had *no* loud case at all: nothing rejected it, and the DB constraint
   that looks like it covers the sequence structurally cannot see it.

### 🔴 SIX OCCURRENCES IS A PATTERN — the standing check

The same defect has now been found **six times in M12**, each in a different
component, each invisible until something forced the code onto a real path.
Note the last three especially: they are not "a function nobody calls" but a
**field nobody writes**, a **client that was only ever a mock**, and a **live
green result that covers less than it appears to** — the same disease in forms a
caller-grep alone would miss.

| # | Found | What was correct | What was not connected |
| --- | --- | --- | --- |
| 1 | M12.1b | UBL generation, signing, QR, outbox — all validated | `issueInvoice()` never wrote `icv`/`zatca_uuid`, so the assembler rejected every real row. The whole Phase-2 pipeline was unreachable. |
| 2 | M12.1b | The ZATCA PIH logic | The loader fed it `invoices.previous_hash` — a different chain entirely. |
| 3 | M12.8 | M12.6's outbox transport, proven offline | **Nothing ever enqueued.** No production code inserted an `einvoice_documents` row; `EInvoiceWorker` was never instantiated; `ZATCA_WORKER_ENABLED` was named in two comments and never declared; `listOverdue()` had no callers. |
| 4 | **M12.8** | `invoice_items.tax_category_code` — declared in M12.1a, back-filled by its migration, **validated** by the assembler | **No production writer.** The write path never set it, so every invoice created through the API carried NULL — and the assembler fails closed on NULL. For an onboarded company, **every invoice was unissuable.** Fixed in `invoices.service.create`: positive VAT rate ⇒ `'S'`; 0% stays NULL and must be stated explicitly, exactly as the migration decided. |
| 5 | M12.8 | M12.6's transport logic, claiming, backoff and state machine | **No real client existed.** `unconfiguredZatcaClient` THROWS; the only implementation was the test's mock. So M12.6's "complete" status covered a transport **proven only against a fake**, and an instantiated worker would have failed every send. Fixed by `zatca/liveZatcaClient.ts`. |
| **6** | **M12 close-out** | M12.4's live result: **six compliance documents PASS, zero errors, zero warnings** — real, and obtained against the live API | **🔴 IT COVERS DOCUMENT CONSTRUCTION, NOT SUBMISSION.** That result came from `POST /compliance/invoices` — an *onboarding gate* asking "can this EGS unit produce valid documents?". The production path is `POST /invoices/{clearance,reporting}/single`, which **has never been called, in any environment.** Still open; it is M12.7's first task. See [`docs/zatca/m12-status.md` §0](docs/zatca/m12-status.md). |

### 🔴 THE NAMED FAILURE MODE: **A SHAPE WITHOUT A CONSUMER**

Every finding above and below is the same thing. It deserves a name, because
naming it is what makes it visible before the fact rather than after.

> **A shape without a consumer.** Declaring the *shape* of a thing — a column, a
> table, an interface, a config flag, a package — is satisfying, reviewable, and
> looks exactly like progress. Nothing in the normal development loop then forces
> the follow-up that makes it real. The declaration passes review, passes
> typecheck, passes tests, and ships. It is indistinguishable from finished work
> until something tries to *use* it.

Why it is endemic here specifically: this project is schema-first and
contract-first by design (OpenAPI-first codegen, declared-in-full provider seams,
migrations before services). Those are good practices and they are **not** the
problem — but they systematically produce shapes ahead of consumers, which means
the gap between "declared" and "connected" is a normal state of the codebase
rather than an anomaly. In a codebase where half-built is normal, half-built does
not look wrong.

**The countermeasure is the standing check below.** Not more care, not more
review — a mechanical check, because the failure survives careful review by
construction. Thirteen instances found so far (six live, seven retroactive), and
the check caught something every single time it was run.

### 🔴 ASSERT THE PROPERTY, NOT THE NUMBER — when the reasoning might be wrong

Learned in M13, and it saved the milestone's most important guard from being
worthless.

The M13 design justified "no tax figure moves" by reasoning that the VAT return,
the Zakat base and cash flow all read `transactions` rather than the ledger.
**That reasoning was wrong about the VAT return, which reads INVOICES and BILLS.**
The conclusion happened to survive (M13 does not touch invoices), but the stated
mechanism did not.

Had the test been written from that reasoning — *"the VAT return should be zero,
because this org has no transactions"* — it would have asserted a fixed figure
derived from a false premise. Worse, it would have **passed**: the fixture had no
transactions, so zero was arrived at for the wrong reason, and a later change
that pointed the VAT return at the ledger would have been caught only by luck.
A vacuous test that looks green is worse than no test, because it is *counted*.

What was written instead asserts the PROPERTY:

> Post a GL-only journal entry — no invoice, no bill, no transaction behind it —
> then assert every VAT box, the Zakat base and cash flow are byte-identical
> before and after. Then assert the income statement **did** move, so the check
> cannot be vacuous.

That isolates the ledger as the only variable. It does not care *why* the tax
reports are independent, survives fixture changes, and fails for exactly one
reason: a tax report started reading the GL.

**The rule:** when you are about to assert a specific number, ask what has to be
true for that number to be right. If the answer is a chain of reasoning you have
not verified, **assert the invariant instead** — change one thing, prove the
figure does not move, and prove something else DID move so the test cannot pass
vacuously. Fixed figures are fine when the number itself is the requirement
(1,000 SAR of revenue); they are a trap when the number is a *consequence* of
reasoning that might not hold.

### 🔴 THE SECOND NAMED FAILURE MODE: **A TEST THAT BECAME A GUARD FOR THE BUG**

Its close relative, and in one way worse — because here the safety mechanism is
the thing that fails.

> **An obsolete assertion.** A test that was *correct when written* can quietly
> invert into a guard certifying the defect, and stay green across the very
> milestones that should have invalidated it. Nothing flags it: it was true, it
> is still passing, and passing tests are not re-read.

**The instance (S1).** `ubl-generation.test.ts` asserted that
`zatcaDirectProvider.onboard` and `.submit` throw `NotImplementedError`. Correct
and useful at M12.2 — "unbuilt methods must fail loudly rather than silently
succeed". Then **M12.4 built onboarding and M12.6 built transport**, each
shipping its logic elsewhere and leaving the seam throwing. The assertion stayed
green through both. For two milestones a passing test was **certifying that the
vendor swap point did not work**, and its green status was one of the reasons
nobody looked.

Note how it compounds: a *shape without a consumer* is invisible, and an
*obsolete assertion* actively defends the invisibility.

**COUNTERMEASURE — add to the milestone checklist:**

> When a milestone **implements or moves** something, grep for tests asserting
> that thing is **absent, unimplemented, or throwing** — `NotImplementedError`,
> `.rejects`, `toThrow`, `toBeNull`, `toBeUndefined`, `not.toContain` — and
> re-read each hit. An assertion of absence is a claim with an expiry date, and
> the milestone that implements the thing is when it expires.

Where an absence assertion is genuinely long-lived, **invert it into a presence
assertion** as S1 did (every provider method must be reachable) — a positive
assertion cannot silently outlive its purpose the same way.

### 📋 RETROACTIVE SWEEP (M12 close-out) — seven more

Six instances was enough to assume more existed, so the standing check was
applied backwards across everything `CLAUDE.md` claims.

**S1 and S2 are FIXED** (see below). **S3–S7 are TRACKED DEBT — recorded, not
fixed.** Nothing in S3–S7 is exploitable or wrong today; they are capabilities
the documentation implies are available and which are not, which matters when a
future session plans work assuming they exist.

| # | Claim | Reality | Severity |
| --- | --- | --- | --- |
| **S1** ✅ **FIXED** | **The `EInvoiceProvider` seam is one of two MANDATORY hedges** for the build-direct decision: "so a certified provider can be slotted in per-tenant later without re-architecting". | Was: **only `buildDocument` wired**; `onboard`/`renewCertificate`/`submit` threw, and the real paths bypassed the seam (onboarding called `zatcaOnboardingClient`, the worker called `ZatcaHttpClient`). **A hedge that covers only the part you do not need is not a hedge** — and it is the stated fallback if building direct fails. **Now all four methods route through the seam**; see the S1 entry below. | **HIGH** |
| **S2** ✅ **FIXED (as a description)** | M12.6: an ambiguous failure "is reconciled by **ASKING ZATCA what happened**". | **Nothing asks ZATCA, and nothing can:** ZATCA's API exposes **no invoice-status or query endpoint** — Compliance CSID, Production CSID, Clearance and Reporting are the entire documented surface. Implementing a query would mean inventing an endpoint, which is exactly the guessing the divergence log exists to prevent. So the **description** was corrected to say what actually happens: an ambiguous document parks in `needs_review` and **a human** resolves it in the Fatoora portal. Sound design; false comment. | **MEDIUM** |
| **S3** | Tech Stack table: **"Cache / queue — Redis"**. | **Redis is not used anywhere.** No dependency, no client, no config. The only mention in code is a comment saying rate limiters *should* move to a Redis store when scaling. Listed as if it were part of the running stack. | **LOW** (doc accuracy) — but it feeds queue item C1, which assumes Redis exists to move to. |
| **S4** | Repository Layout: `apps/api/src/lib/` holds "accounting + infra: **glPosting, periodLock, zatca, categorizer**, auth, logger". | **M6 moved all four** to `services/accounting/` and `services/categorization/`. `lib/` no longer contains any of them. The layout section was never updated. | **LOW** — actively misleading for navigation. |
| **S5** ✅ **RESOLVED (deleted)** | `packages/auth` was listed as a workspace ("auth/RBAC; populated later"). | A 3-line stub. All auth and RBAC live in `apps/api/src/lib/` after six milestones of work; nothing depended on the package. **Deleted** — see below. | **LOW** |
| **S6** | The `feature_flags` table "exists" and is listed among the platform tables. | **Created by a migration and referenced by nothing.** No repository, no service, no route reads or writes it. Same shape as `companies.zatca_onboarding_status`, which was dropped in M12.8 for exactly this. | **LOW** — but it is a trap: the next engineer will reasonably assume flags work. |
| **S7** | `branches` and `departments` tables exist as platform tables (M2/M3). | **No production code references either.** Schema-only, like `feature_flags`. | **LOW** — same trap, same class. |

#### S1 — what "wired through the seam" now means

- **`onboard`** — the ZATCA onboarding controller calls `resolveProvider().onboard(...)`;
  `zatcaDirectProvider` delegates to the existing flow. No behaviour change, but
  onboarding is now a provider concern, which is what a vendor actually sells.
- **`renewCertificate`** — implemented, and it is **the same flow as onboarding**.
  ZATCA has no "extend" operation: a new certificate comes from a fresh CSR
  authorised by a new OTP. And `vaultRepository.activate` already supersedes the
  previous active credential *inside one transaction*, so re-running onboarding
  rotates atomically — never two active credentials, never none. New route
  `POST /zatca-onboarding/renew`.
  🔴 The M12.2 signature was `renewCertificate(companyId)` — **no OTP** — which
  quietly implied the platform could renew unattended. That is the opposite of
  true and it is the single most important operational fact about expiry, so the
  signature now takes `RenewalInput`.
- **`submit`** — the worker takes an `EInvoiceProvider` instead of a
  `ZatcaHttpClient` + credential resolver. The provider resolves its own
  transport credentials, exactly as a vendor would hold its own.
- **The outbox tests now drive the REAL provider over a fake socket**, so the
  seam is covered by the same tests that cover the transport, rather than
  bypassed by them.
- **The inverted regression test.** `ubl-generation.test.ts` used to assert that
  `onboard` and `submit` THROW. That assertion was correct at M12.2 and then
  stayed green through M12.4 (which built onboarding) and M12.6 (which built
  transport), because both shipped their logic elsewhere and left the seam
  throwing. **A passing test was certifying that the vendor swap point did not
  work.** It now asserts the opposite.

#### Two real bugs found while wiring S1

1. **🔴 The worker was sending the WRONG UUID.** It sent
   `uuid: String(row.invoiceId)` — our internal row id — where ZATCA requires the
   document UUID that matches `cbc:UUID` inside the signed XML. It would have
   been rejected. Invisible to every offline check (the XML is valid, the hash is
   right, the signature verifies) and reachable only by a real submission, which
   has never happened. Fixed by carrying `zatca_uuid` on `einvoice_documents`
   (migration `0023`, back-filled) — the worker runs on the base pool where
   joining business tables is forbidden, so the value must be on the row.
2. **ZATCA returns HTTP 303 when clearance is DISABLED** for a taxpayer, meaning
   the document must go to the Reporting API instead. Found in the technical
   guideline while checking whether a status endpoint exists. Previously a 303
   fell into the generic retry branch and would have been retried against the
   clearance endpoint forever, burning every attempt while looking transient. Now
   classified non-retryable with the real remedy in the message.
   🔴 Deliberately **not** auto-re-routed: switching a STANDARD invoice to
   reporting changes its legal treatment (no stamp, no returned QR), and we have
   never observed the behaviour. Auto-routing is an M12.7 task.

#### Test-isolation consequence (worth knowing before adding suites)

Claiming and the archive sweep are **global and cross-tenant by design** — that
is the point of a background worker. So any two suites that both create
`einvoice_documents` interfere: one suite's worker will claim and submit the
other's documents. This broke three tests the moment M12.8 gave more than one
suite real documents. Both now accept an optional `organizationId` scope, omitted
in production and supplied by tests. Weakening the assertions to tolerate
partial counts was the alternative, and it would have hidden the next real bug.
The same scope is the seam a future sharded/per-tenant worker would use.

**Already correctly documented as deferred — checked and NOT findings:**
`companies.fiscalYearStart` (stored, exposed, explicitly recorded as not wired
into report periods, and the Company Settings UI says so to the user); the
`users` permission resource (seeded, explicitly recorded as not wired to
`requirePermission`); `mailer` as a no-op (now queue item B1). These are the
model — a gap stated plainly is not a gap in the record.

#### S3–S7 — TRACKED DEBT (not fixed; decide, do not drift)

None is exploitable. Each is a claim that outruns reality, and each has a
decision attached rather than a task:

- **S3 — Redis.** In the Tech Stack table, used nowhere. **This makes queue item
  C1 unactionable as written** (see the annotation there): C1 says "move the rate
  limiters to Redis", which reads as a migration and is actually a new
  infrastructure dependency. Either introduce Redis deliberately, with its cost
  and operational burden priced in, or delete the row from the stack table and
  re-scope C1 around what we will actually run.
- **S4 — the Repository Layout section** still points at `lib/glPosting`,
  `lib/periodLock`, `lib/zatca`, `lib/categorizer`. M6 moved all four to
  `services/`. Actively misleading for navigation; a doc fix.
- **S5 ✅ RESOLVED — `packages/auth` DELETED.** It was a 3-line stub while six
  milestones of auth and RBAC work (M4, M5, M10.1, M11.1, M11.3, M11.5.1) landed
  in `apps/api/src/lib/`. An empty package named for a concern that lives
  elsewhere is a trap in both directions: the engineer looking for auth code
  finds three lines, and the one adding auth code has two plausible homes with
  nothing to choose between them. Deleted rather than populated — the code has a
  working, tested home, and relocating six milestones of boundaries would be pure
  churn. Nothing depended on it.
- **S6/S7 — `feature_flags`, `branches`, `departments`.** Tables created by
  migrations and referenced by no code. Exactly the shape of
  `companies.zatca_onboarding_status`, which was dropped in M12.8 for this
  reason. They are a trap in the same way: the next engineer will reasonably
  assume feature flags work. Either build a consumer or drop them.

**The pattern across S1–S7:** every one is **a shape without a consumer** — the
named failure mode above. Applying the standing check retroactively found seven
in a single pass, which is the strongest available argument for applying it
prospectively.

---

**#6 is the most consequential, and the only one that did not look unfinished.**
The first five were absences — no caller, no writer, no implementation — visible
to anyone who looked. #6 is a **green live result that reads as end-to-end proof**
and survived three milestones precisely because it looked finished. A green
compliance run says the envelope is well-formed; it says nothing about posting
the letter.

**🔴 THE STANDING CHECK — apply ALL THREE parts before recording any milestone
as done:**

> 1. **Every capability has a production CALLER.** For anything claimed as
>    surfaced to users — an alarm, a queue, a status view, a job — grep for the
>    symbol and discard tests and comments. A function only a test calls is
>    unbuilt.
> 2. **Every field it depends on has a production WRITER.** A column that only a
>    migration back-fills is unbuilt. Declaring it, validating it, and reading it
>    are three things that all look like progress and none of which populate it.
>    Grep for writes, not just references — *(this is finding #4, and note the
>    field was fully validated, which made it look more finished than it was)*.
> 3. **Every client it depends on has a REAL IMPLEMENTATION, not an interface
>    plus a mock.** A seam with one throwing stub and one test double is a
>    design, not a transport. If the only thing that ever satisfied the interface
>    lives in a test file, the milestone that "completed" it did not
>    — *(finding #5)*.
> 4. **Every LIVE EXTERNAL RESULT is recorded with the ENDPOINT that produced it
>    and what that endpoint attests.** "It passed against the real API" is not a
>    scope — the scope is the endpoint. A pass on an onboarding/validation
>    endpoint does not cover the production path, however green and however real
>    — *(finding #6, the one that survived three milestones because it looked
>    finished)*.

Each part is cheap — three greps — and every one has caught something the first
time it was applied. The reason it keeps happening is structural rather than
careless: a component built correctly and tested in isolation produces a green
suite, and a green suite reads as "done". Nothing in that loop ever asks whether
anything calls it, writes to it, or implements it for real.

**The mock is the subtlest of the three**, because a good mock makes the test
*more* convincing: M12.6's outbox tests are genuinely excellent and prove exactly
what they claim — the transport's behaviour. What they cannot prove is that a
transport exists. Judge a seam by its non-test implementations; if that count is
zero, say so in the milestone record.

**The general lesson — and the reason "validate from real ledger rows" is an
acceptance criterion, not a nicety:** a green result against fixtures says
nothing about the path from the database. **Both bugs above were invisible to
hand-built fixtures, and neither was a subtle one** — one fed the wrong chain
entirely, the other broke the chain's core invariant. They were invisible because
fixtures supply by hand exactly the values the real path gets wrong: a fixture
author writes a plausible base64 PIH and approves documents in creation order,
so both faults are papered over by construction. Fixtures test the code you
wrote; only real rows test the code you forgot to write. **Every future
integration milestone must have at least one test that submits data read back
out of Postgres**, produced by the product's own write path — that is what
`tests/credit-notes-zatca-live.test.ts` is for, and it earned its keep on the
first run.

### 🔴 The chain forked because `previousInvoiceHash` ordered by ROW ID

`invoices.id` is assigned at CREATE; the chain position is assigned at APPROVAL.
Those orders differ whenever documents are approved out of the order they were
created. Ordering by `id` selected "the highest-numbered row that happens to be
hashed", so several approvals read the SAME head. Reproduced with 8 parallel
approvals: **three documents shared one predecessor.** A forked chain is not
repairable after the fact and is exactly what ZATCA's chain exists to detect.

**🔴 THIS IS NOT PURELY A CONCURRENCY BUG. Do not file it as one.** An approver
working a queue out of creation order forks the chain **sequentially, one request
at a time, with no parallelism anywhere**: approve invoice #7 before invoice #5,
and #5 chains to #7's predecessor instead of to #7. That is ordinary,
correct-by-any-other-measure approver behaviour — an approver is free to work
their queue in any order, and nothing about the product suggests otherwise.
Concurrency is how it was *reproduced*, not the condition it requires. A fix
reasoned about purely as a race (isolation levels, a serialisable transaction)
would leave the common case broken.

**🔴 `unique(company_id, icv)` COULD NEVER HAVE CAUGHT THIS.** Anyone reading
"we have a unique constraint on ICV" will assume the sequence is protected. It
is not, and the shape of the failure is the reason: **a fork produces no
duplicate value and therefore no error.** Two documents pointing at the same
predecessor still get distinct, dense, gapless ICVs — the constraint sees nothing
wrong because nothing it checks *is* wrong. Precisely that was observed: **ICVs
were dense and unique for the entire time the chain was forking.** A constraint
on the counter says nothing about the *link*, and the link is where the chain
lives. Uniqueness and chain integrity are different properties; only one of them
was enforced.

Two separate mechanisms are needed, and only one of them existed:

- **Allocation** is serialised by a per-company **transaction-scoped advisory
  lock** (`lockCompanySequence`), covering the ICV read AND the chain-head read
  in one critical section. `unique(company_id, icv)` remains the **backstop**,
  not the mechanism — it can turn a duplicate ICV into an error, but per the
  above it cannot see a fork at all, let alone unfork one. The lock was working
  the whole time.
- **Ordering** must follow the SEQUENCE, not the row id:
  `ORDER BY icv DESC NULLS LAST, id DESC`. This is the half that fixes the
  sequential out-of-order case, which no amount of locking would have.
  `NULLS LAST` keeps pre-M12.1b rows (hashed, no ICV) behind ICV-bearing ones so
  a company with legacy invoices continues its chain rather than starting a
  second genesis root.

Proven in `tests/invoice-icv-concurrency.test.ts` under real parallel
transactions — the way the M12.6 outbox claiming was proven, rather than by
reasoning about isolation levels.

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
- **Data residency — 🔴 THE EARLIER CLAIM HERE WAS WRONG. See the correction
  below before making any hosting decision.** This entry previously read *"ZATCA
  requires e-invoices archived on servers inside Saudi Arabia."* That came from a
  **secondary source and is NOT supported by the primary specification.** What
  remains true and verified: retention **6 years (11 for certain services)** and
  the file naming convention (see the corrected section below). What is open: the
  hosting location. There is still *no hosted Supabase project* — the database is
  local Supabase CLI (`127.0.0.1:54322`) and `SUPABASE_URL` is unset — so this
  stays an **open deployment decision, not a migration**, and the archive backend
  is built swappable regardless.
- **Possible ZATCA IP whitelisting.** Secondary sources indicate server IPs may
  need whitelisting. **Unverified against official docs** — confirm in M12.4. If
  true it means static egress IPs (NAT gateway) and constrains serverless hosting.
- **KMS** for envelope-encrypting tenant private keys (M12.5). **ONE platform CMK
  (~$1/month) + a per-company data key — NOT a CMK per tenant.** An earlier note
  here read "~$1/key/month", which if applied per tenant implies **$1,000/month at
  1,000 tenants for identical isolation**. Per-company DEKs give the same blast
  radius (one DEK compromised ⇒ one company) at flat cost; requests are
  $0.03/10,000, i.e. cents. Self-hosted Vault avoids per-key cost but adds a
  service to operate.
  **The provider is chosen at DEPLOYMENT, behind the `KeyWrapper` interface** —
  the same hedge as M12.8's storage backend, because the hosting-region question
  is still open (see the residency correction — the constraint is not what we
  thought, but it is not resolved either) and picking a KMS partially pre-decides
  the hosting provider.
- **ZATCA itself charges nothing** — CSIDs, sandbox, simulation and API access are
  all free. The cost of the build-direct path is engineering time only.

### ⚠️ The API test suite has order/timing sensitivities that only appear under full parallel load

**Three latent fragilities have now been exposed by M12 work — none caused by
it, all invisible until something perturbed timing or coupling.** Expect more,
and suspect this class first when a suite fails in a full run but passes in
isolation.

| # | Fragility | Surfaced by | Fix |
| --- | --- | --- | --- |
| 1 | `audit.test.ts` ordered audit rows by `created_at` alone. Postgres `now()` is the **transaction** timestamp, so rows written in one request are identical and the sort had no tiebreak. | M12.1a adding `customers` columns, which shifted physical row order | Select by `action`, never by row position. `audit_logs.id` is a random uuid and does **not** break the tie. |
| 2 | Rate limiters are **process-global and IP-keyed**, and every test request comes from the same loopback address — so parallel suites share one budget. Signup's is deliberately strict (5/hour). | M12.3 adding ~20s of CPU-heavy Java, which shifted interleaving | `__resetRateLimitsForTests()` in `routes/auth.ts`; suites that sign up call it in `beforeAll`. |
| 3 | `vitest.config.ts` supplied only `DATABASE_URL`. Tests drive services directly and skip boot, so nothing had ever called `loadEnv()` on a service path — and it validates the WHOLE schema. | M12.8 making issuance consult `ZATCA_ENVIRONMENT`, which turned a missing `PORT` into **21 failing invoice tests** | Supply `PORT`/`SESSION_SECRET`/`CORS_ALLOWED_ORIGINS` in `vitest.config.ts`, mirroring boot. It cannot happen in production: `loadEnv` is memoized and runs at startup, so the process would never have started. |

**The diagnostic:** *passes alone, passes in pairs, fails in the full run* means
shared mutable state or an unstable ordering — not a real regression. Reproduce
by running the suite whole, not by re-running the failing file.

**Do NOT "fix" #2 by raising `max` in the test environment.** `signup.test.ts`
asserts a flood IS rejected and loops only 8 times, so it needs `max < 8` to
observe one. Raising the limit silently deletes the abuse protection that test
exists to prove. Isolate the buckets instead.

**Do NOT "fix" ordering problems with `fileParallelism: false`.** It is several
times slower AND couples suites to each other's leftover state — `operator.test.ts`
fails under that ordering while passing alone. See `vitest.config.ts`.

### 🔴 DELIBERATE BEHAVIOURAL DECISION (M12.8): issuance FAILS CLOSED for onboarded companies

**Decided and approved, not incidental — and flagged for revisit before a real
taxpayer is onboarded.**

For a company with an active ZATCA credential, if the document cannot be built
or signed, `enqueueEInvoice` **throws and the whole approval rolls back**. No
invoice is issued. Causes include a KMS outage, a revoked credential, or invoice
data too incomplete to assemble (a NULL tax category, a missing buyer address on
a B2B sale).

**Why blocking is the correct choice for a compliance platform.** The alternative
is issuing invoices that cannot reach ZATCA — and the tenant then discovers the
problem **from the tax authority rather than from us**, after the fact, with
penalties attached and no way to repair the record. Worse, a silently-issued
invoice would consume an ICV and a chain position that can never be filled,
leaving a permanent gap in a legally-required sequence. Refusing to issue is
recoverable in minutes; a gap is not recoverable at all.

It is also consistent with the posture chosen everywhere else that touches
statutory identity: `requireIssuanceSeller` (M11.6) fails closed rather than
stamping a placeholder VAT number, and the assembler fails closed on an ambiguous
tax category rather than guessing a tax fact.

**What it costs, stated plainly:** a KMS or vault outage stops invoicing for
onboarded tenants. That is a real availability trade, accepted knowingly.

**Not affected:** a company with **no** active credential is skipped silently and
issues exactly as before. Every existing tenant and every pre-M12.8 test depends
on that, and it is what keeps the platform usable for non-Phase-2 businesses.

**🔴 REVISIT BEFORE ONBOARDING A REAL TAXPAYER.** The decision is right in
principle; what has not been tested is how it *feels* under a real outage. Before
go-live, confirm the failure surfaces to the user as an actionable message
(which field, which company, what to fix) rather than an opaque 500 — a
fail-closed guard that cannot be diagnosed is a fail-closed guard people work
around.

### 🔴 PRE-PRODUCTION REQUIREMENT: real alerting on the e-invoice outbox

**🔴 CORRECTED IN M12.8.** This section previously read *"M12.6 surfaces overdue
documents via `listOverdue()` and the operator UI"*. **That was false in both
halves.** `listOverdue()` had **zero production callers** — only a test — and
there was **no operator UI for it at all**. A capability was recorded as
delivered on the strength of the function existing. See the standing check
below.

**As of M12.8 the claim is now true:** `listOverdue()` is surfaced by
`operatorZatca.service.health()` at `GET /operator/zatca/health` and rendered in
`OperatorZatcaPanel.tsx`, which reports the OLDEST waiting document rather than
just a count (age is what matters against a 24-hour deadline).

**But there is still NO ACTUAL ALERTING**, and that remains the pre-production
requirement. Visibility is not alerting: the operator panel only helps a human
who is already looking at it.

Why it matters more than it looks: **the dangerous failure is not a loud
rejection, it is quiet neglect.** A rejected document is visible and someone acts
on it. A simplified invoice that silently misses ZATCA's **24-hour reporting
deadline** looks like nothing is wrong — and it is legal exposure for the tenant,
with fines from SAR 5,000. Nothing in the current design pages a human when the
queue stops draining.

Wire `listOverdue()` to real alerting before go-live — queue item **B2**, which
covers this and PCSID expiry together, because they are the same failure shape.

### 🔴 PRE-PRODUCTION REQUIREMENT: PCSID expiry — 5 years, NO grace period

**The same failure shape as the outbox gap above, and it must be treated with the
same seriousness.** Confirmed empirically on 2026-08-09: ZATCA's sandbox CA issued
a certificate valid **2026-08-09 → 2031-08-08**, exactly 5 years, with no grace
period.

At expiry, signing **stops dead**: the tenant cannot clear or report invoices, and
therefore cannot legally invoice at all. Nothing looks wrong beforehand — this is
**quiet neglect**, not a loud rejection, which is precisely why it needs an alarm
rather than a dashboard.

It is worse than the outbox case in one respect: **renewal requires the TENANT's
own action** (a fresh CSR plus an OTP they obtain from Fatoora), so a reminder
that fires late cannot be fixed by us alone. Lead time is the whole point.

**✅ BUILT IN M12.8, with one gap that is still a go-live blocker.**
Reminders at **T-90 / T-30 / T-7** run off `zatca_credentials.not_after`
(`services/einvoice/renewal/renewal.service.ts`), are idempotent through a unique
index on (credential, threshold), still fire for an already-expired certificate,
and are surfaced to the operator alongside the windows that passed *unannounced*.

**🔴 THE REMAINING GAP: the reminder cannot actually reach the tenant.**
`lib/mailer.ts` is still `noopMailer` — it logs and returns `delivered: false`.
So a reminder exists as a row and appears in-app and in the operator panel, but
**no message is sent to anyone**. For this alarm specifically that is close to
useless on its own: the whole point is lead time for an action *only the tenant
can take*, and a tenant who does not open the app does not learn anything.

Integrating an email provider (SES / Resend / Postmark, ~$0–20/month) is
therefore a **hard prerequisite for onboarding a real taxpayer**, not a polish
item. `Mailer` is the seam — implement `send` and swap the export; nothing else
changes.

### 🔴 DEPLOYMENT REQUIREMENTS: protecting the KMS master key (M12.5)

**If the CMK is deleted, every wrapped data key becomes undecryptable and every
tenant's private key is permanently lost.** Already-issued invoices and their
archived signed XML survive (they are already signed and stored) — what is lost is
the ability to sign NEW ones, and recovery means re-onboarding every tenant with a
fresh key, CSR and OTP. That needs action from each tenant, so it is a business
event, not merely an outage.

These are **deployment configuration requirements**, not code:

- **30-day deletion window** — set KMS's mandatory waiting period to the maximum.
- **`kms:ScheduleKeyDeletion` restricted to a break-glass role** via key policy;
  no routine role may hold it.
- **CloudTrail alarm on any deletion attempt** — it must page a human.
- **Multi-region CMK replica.**

Note what is safe and needs no action: **automatic annual key rotation.** KMS
retains prior key versions and the ciphertext blob names its own version, so
wrapped DEKs stay decryptable. That holds only while the CMK is never deleted.
Migrating to a *different* CMK is a re-wrap job (unwrap with old, re-wrap with
new, update `wrapped_data_key` + `kms_key_id`); the invoice keys are untouched.

### M12.3 review — carried forward

**Key-handling items to address WHEN THE M12.5 VAULT IS BUILT** (not exploitable
now — nothing persists or transmits keys — but M12.5 is when the blast radius
changes):

- `crypto/keys.ts` `generateZatcaKeyPair()` eagerly exports `privateKeyPem` on
  every call, materialising the key as an immutable, unzeroable JS string even
  when only the `KeyObject` is needed. Make it a lazy accessor at the vault
  boundary.
- `crypto/keys.ts` `assertZatcaCurve()` exports the private key to DER purely to
  check the curve OID, creating a second in-memory copy per validation. The
  `namedCurve` check on the same line already covers the normal case; decide
  whether the DER round-trip earns its keep or should be restricted to public
  keys.

Verified clean in the same review: no logging anywhere in `services/einvoice/`,
no serialisation of credentials, nothing key-related on any returned type, and
`errorHandler` emits only `err.message` / a generic 500 — never a stack or
object dump.

**Surface the M12.3 differentials DO NOT reach** — they exercise one invoice, one
key, one certificate, one signing time. M12.1b and M12.4 should extend coverage
to:

- **credit and debit notes** (`documentType` other than `invoice`) — untested
  end-to-end through signing
- **zero-value lines and zero-VAT invoices**
- **certificates with unusual issuer DNs** — `issuerName` comes from ZATCA's CA,
  and only one CA's format has ever been seen
- **invoices with no PIH** — now guarded with a throw rather than silent QR
  misplacement, but never exercised against ZATCA
- **multi-byte item descriptions** in the XML body (lower risk — M12.2's
  generator escapes via `xmlbuilder2`)
- **the tag 8/9 `r`/`s` split**, whose *intent* is still unverified (divergence
  #13) — re-confirm against the sandbox

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
  **UPDATE (M12.5) — scope confirmed and PARTIALLY closed.** Measured against the
  live local stack: every newly created table receives **`REFERENCES, TRIGGER,
  TRUNCATE`** from the Supabase default privileges — including the *owner-only*
  identity tables, which were assumed to be granted nothing. `zatca_credentials`
  now **REVOKEs explicitly** (migration `0019`, guarded per role) and a test pins
  it, because destroying signing keys is unrecoverable. **The other five
  owner-only tables still hold `TRUNCATE`** and belong in the same pre-deployment
  migration as the business tables:
  `security_audit_logs`, `platform_operators`, `verification_reviews`,
  `verification_documents`, `organization_invitations`.
  Destructive-but-recoverable rather than catastrophic (they hold audit history,
  operator flags and invitations, not key material), but there is no reason to
  leave it. **Do not assume "owner-only" means "no grants" — verify with
  `information_schema.role_table_grants`.**

### 🔴 PRE-PRODUCTION QUEUE (consolidated — the single list)

Everything that must close before a real taxpayer is onboarded. Split by kind,
because these do not all land in one change.

**A. One migration closes these — grants and configuration, not code:**

| # | Item | Where recorded |
| --- | --- | --- |
| A1 | `REVOKE TRUNCATE/REFERENCES/TRIGGER` on **every business table** from the app role | MEDIUM finding above |
| A2 | Same REVOKE on the **five remaining owner-only tables** (`einvoice_archive` and `zatca_credentials` already do it) | MEDIUM finding (M12.5/M12.8 updates) |
| A3 | **M-1** — add RLS to `organizations`/`users`/`organization_memberships`, or a CI guard failing on business-layer imports | M11 audit findings |
| A4 | **`checkPeriodOpen` ignores `company_id`** — company A's closed period blocks company B in a multi-company org | LOW finding, confirmed M12.1b |

**B. 🔴 BLOCKING for ZATCA — a reminder that reaches nobody:**

| # | Item | Why it blocks |
| --- | --- | --- |
| **B1** | **EMAIL DELIVERY — a hard prerequisite, not polish.** `lib/mailer.ts` is still `noopMailer` (logs, returns `delivered: false`). Implement `send` and swap the export; nothing else changes. Options: **AWS SES** (~$0.10/1,000 emails, cheapest, most setup), **Resend** (free to 3,000/mo, then ~$20/mo), **Postmark** (~$15/mo, best deliverability). | The renewal reminder's **entire value is lead time for an action only the tenant can take** — a fresh CSR plus an OTP from THEIR Fatoora portal. Today the reminder exists as a row and in the UI, and **no message is sent to anyone**. A tenant who does not happen to open the app learns nothing, and at expiry signing stops dead: they cannot legally invoice. We cannot fix that for them after the fact. |
| **B2** | **VISIBILITY IS NOT ALERTING.** M12.8 surfaces both alarms in the operator panel; **nothing pages a human.** Wire `listOverdue()` **and** `renewalService` to real alerting (PagerDuty/Opsgenie/webhook). | Both failures are **quiet neglect, not loud rejection** — the shared property that makes a dashboard the wrong instrument. A simplified invoice silently missing ZATCA's 24-hour reporting deadline looks like nothing is wrong (tenant fines from SAR 5,000); an expiring PCSID looks like nothing is wrong until it stops signing. A panel only helps someone already looking at it, and nobody looks at a panel that is usually green. |

**C. Verification and coverage gaps:**

| # | Item | Where recorded |
| --- | --- | --- |
| C1 | **HIGH-2 + Redis INTRODUCTION (not a migration).** Two parts. (a) Confirm exactly one trusted proxy overwrites `X-Forwarded-For` — `trust proxy` is set only in production, so a client-supplied header would make every IP-keyed limiter a no-op via rotation. (b) The rate-limit stores are in-memory and per-process, so **horizontal scaling silently multiplies every limit** — including signup's deliberate 5/hour. 🔴 This item used to read "move the limiters to Redis", which is wrong in a way that hides work: **Redis does not exist in this project** — no dependency, no client, no config, no container (finding S3). Closing (b) means *introducing* a shared store: provisioning it, securing it, operating it, and accepting it as a new failure domain. Scope it as an introduction, or pick a different mechanism (e.g. a Postgres-backed limiter, since Postgres is already a hard dependency). | M11 audit findings + S3 |
| C2 | **CI storage gap** — add a Storage service/stub so the M11.4 document tests actually run in CI | Known CI gap |
| C3 | **KMS deployment verification** — the IAM/key policy, 30-day deletion window, break-glass restriction on `kms:ScheduleKeyDeletion`, CloudTrail alarm, multi-region replica | M12.5 deployment requirements |
| C4 | **AV scanning** on uploaded verification documents before untrusted-tenant growth | M11.4 follow-up |
| C5 | **Fail-closed diagnosability** — confirm a blocked issuance surfaces an actionable message, not an opaque 500 | M12.8 behavioural decision above |
| C6 | **Data residency / hosting region** — still open, now for the right reason (see the residency correction: ZATCA permits cloud; NCA/sector rules unverified). Choose the host and the KMS region together. | M12.0 / M12.8 |

Re-check the hosted project's default privileges when it exists: they may differ
from the local Supabase CLI stack where all of this was measured.
- **[✅ RESOLVED in M13] Invoice revenue was MISCLASSIFIED in the income
  statement.** Fixed by real chart-of-accounts resolution in the posting path:
  a seeded system chart, `system_code` resolution, fail-closed on unresolvable,
  a deterministic backfill, and balance-sheet AR/AP moved to the GL. Design and
  as-built notes: [`docs/feature-spec-chart-of-accounts.md`](docs/feature-spec-chart-of-accounts.md).
  User-facing note: [`docs/release-notes/m13-income-statement-classification.md`](docs/release-notes/m13-income-statement-classification.md).
  **Historical income statements changed** (revenue up, expenses up by the same,
  net profit identical) — a display defect corrected, not a restatement.
  **UX FOLLOW-UP (not a bug):** a bill's expense account is still free text
  (`debitAccount`), resolved by NAME against the tenant's chart with a
  `PURCHASES` fallback. Resolving by name is correct there — the user is naming
  their OWN account, unlike our hardcoded literals — but a **per-bill account
  picker over the real chart** would be better. That is a UX change, not a
  classification one.
  The ORIGINAL note, kept because it explains why the bug survived:
  🔴 The design found the problem is LARGER than recorded here: **`categories`
  contains zero rows and nothing ever creates any**, so there is no chart of
  accounts to resolve against; and naively setting `account_id` would
  **double-count AR on the balance sheet**, because AR is currently bolted on
  from the `invoices` table *and* the GL lines contribute nothing only because
  their type is unresolvable. Read the spec before touching the posting path. `postJournalEntry` writes
  `accountId: l.accountId ?? null` and the invoice path never supplies one, so
  **every invoice GL line has `account_id = NULL`**. The income statement then
  classifies by `const type = cat?.type ?? "expense"` (`reports.service.ts`), so
  the *Sales Revenue* credit line lands in **expenses** — as a negative expense —
  rather than in revenue.
  **Net profit is right; the statement's composition is not.** Revenue reads as
  zero and expenses are understated by the same amount. This affects **every
  invoice today**, predates M12.1b, and **credit notes inherit it**.
  Deliberately NOT fixed in M12.1b: the fix is real chart-of-accounts resolution
  in the posting path (mapping "Accounts Receivable"/"Sales Revenue"/"VAT
  Payable" to `categories` rows), which is money-touching work deserving its own
  milestone and its own tests — not a rider on a notes change. The same NULL
  `account_id` also makes these lines invisible to the balance sheet, which is
  why AR is computed from the `invoices` table instead of from the GL.
- **[LOW — CONFIRMED in M12.1b] `checkPeriodOpen` ignores `company_id`.** The
  query filters on `period` alone (`periodLock.ts`), though the uniqueness key is
  `(organization_id, company_id, period)` and RLS scopes only to the
  organization. **In a multi-company org, company A closing a period blocks
  company B's postings** — including credit notes correcting company B's
  invoices. Not a cross-tenant breach; scope the query by `company_id` when
  multi-company support is built out. Belongs in the pre-deployment queue.
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
| Cache / queue | **None.** See the note below — Redis is NOT part of this stack.          |
| Auth          | Express session auth (`express-session` + `connect-pg-simple`, bcryptjs) |
| API contract  | OpenAPI-first (`packages/api-spec/openapi.yaml`) with orval codegen      |
| Validation    | Zod (generated into `@workspace/api-zod`)                                |
| i18n          | Custom `LanguageContext` (Arabic / English, RTL-aware)                   |
| Logging       | pino / pino-http                                                         |

> 🔴 **This table previously listed "Cache / queue — Redis". Redis is not, and
> has never been, part of this project** — no dependency, no client, no config,
> no container. It was aspiration recorded as fact, which is the same disease as
> a schema with no consumer: a future session reads the stack table to learn what
> it can rely on. Rate limiting is **in-memory and per-process** today (which is
> why horizontal scaling is a pre-production item — see queue C1), and background
> work runs on the in-process scheduler in `apps/api/src/jobs/`, not a queue.
> If a cache or queue is introduced, add it here **when it runs**, not when it is
> decided.

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
  # NOTE: there is deliberately NO `packages/auth`. It existed as an empty
  # scaffold from M2 until the M12 close-out and was DELETED: six milestones of
  # auth and RBAC work (M4, M5, M10.1, M11.1, M11.3, M11.5.1) landed in
  # `apps/api/src/lib/` instead, and an empty package named for a concern that
  # lives elsewhere is a trap — the next engineer looks there first and finds
  # three lines, and the next one adding auth code has two plausible homes with
  # nothing to choose between them. Auth lives in `apps/api/src/lib/`
  # (auth.ts, rbac.ts, tenant.ts, operator.ts, tokens.ts).
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
