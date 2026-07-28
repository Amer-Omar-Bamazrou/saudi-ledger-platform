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

See `docs/phase-0-implementation-plan.md`.

### Known Issues / Deferred (from the M4 security re-audit)

These were identified in the post-M4 security review and **intentionally deferred**
(not bugs to fix ad hoc — address them in the milestone noted):

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
- **[MEDIUM] `audit_logs` grants UPDATE/DELETE to the app role.**
  `0004_m4_rls_enforcement.sql` grants full DML on `audit_logs` to the
  application role; audit trails should be append-only. Latent (no route writes
  audit logs yet). **Fix (M7):** when audit writing lands, grant only
  `SELECT, INSERT` on `audit_logs` to the app role.
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

- `docs/architecture-blueprint.md` — target technical architecture.
- `docs/phase-0-implementation-plan.md` — Phase 0 milestone plan.

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
