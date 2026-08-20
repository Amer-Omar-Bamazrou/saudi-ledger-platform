# Architecture Blueprint

The target technical architecture for the **Saudi Ledger Platform** — the
scalable, multi-tenant SaaS system we are refactoring toward during Phase 0.

This document is the "north star". It describes where we are going, not where we
are today. The current code is a single-tenant bookkeeping app; this blueprint
describes the platform it becomes. The milestone-by-milestone path is in
[`phase-0-implementation-plan.md`](./phase-0-implementation-plan.md).

Guiding constraint (from [`../CLAUDE.md`](../CLAUDE.md)): **evolve, don't
rewrite.** The accounting core is correct. We are building a platform around it,
not replacing it.

---

## 1. Design Goals

| Goal                     | What it means here                                              |
| ------------------------ | -------------------------------------------------------------- |
| **Multi-tenant SaaS**    | Many organizations share one deployment, fully isolated.       |
| **Tenant isolation**     | No query or code path can read/write another tenant's data.    |
| **Correctness preserved**| GL posting, period locks, VAT/Zakat behave exactly as today.   |
| **Clean layering**       | HTTP, coordination, business logic, and data access separated. |
| **Contract-first**       | OpenAPI is the source of truth for the API surface.            |
| **AI-ready, AI-safe**    | AI proposes; humans/existing logic approve and post.           |
| **Observability**        | Structured logs + audit trail for every business mutation.     |

Non-goals for Phase 0: no new accounting features, no billing/subscriptions, no
AI features shipped (only the foundation for them), no Supabase Auth migration.

---

## 2. Target Architecture

### 2.1 Layout — `apps/` + `packages/`

We move from the current `artifacts/*` + `lib/*` naming to a conventional
`apps/` (deployable units) + `packages/` (shared libraries) monorepo. This is a
rename-and-reshape, not a rewrite — the underlying code moves largely intact.

```
saudi-ledger-platform/
├── apps/
│   ├── api/                     # was artifacts/api-server — Express 5 backend
│   │   └── src/
│   │       ├── routes/          # HTTP layer only (thin)
│   │       ├── controllers/     # request/response coordination
│   │       ├── services/        # business logic (tenant-aware)
│   │       ├── repositories/    # data access (tenant-scoped queries)
│   │       ├── middleware/      # auth, tenant-resolver, RBAC, error handler
│   │       ├── accounting/      # preserved core: glPosting, periodLock, zatca
│   │       ├── app.ts
│   │       └── index.ts
│   └── web/                     # was artifacts/bookkeeping — React 19 + Vite
│       └── src/                 # pages, components, contexts, generated client
├── packages/
│   ├── db/                      # was lib/db — Drizzle schema + pg pool + migrations
│   │   └── src/
│   │       ├── schema/          # one file per table (now tenant-scoped)
│   │       └── migrations/      # SQL migrations (drizzle-kit generate)
│   ├── api-spec/                # was lib/api-spec — openapi.yaml + orval config
│   ├── api-zod/                 # was lib/api-zod — generated Zod schemas
│   ├── api-client/             # was lib/api-client-react — generated RQ client
│   ├── core/                    # NEW — shared domain types, tenant context, errors
│   └── config/                  # NEW — shared tsconfig, eslint, env schema
├── docs/
├── scripts/
├── pnpm-workspace.yaml
└── CLAUDE.md
```

New packages introduced by the refactor:

- **`packages/core`** — cross-cutting domain primitives that both `apps/api` and
  (where relevant) `apps/web` depend on: the `TenantContext` type, domain error
  classes, money/decimal helpers, role/permission enums. Keeps tenant and RBAC
  concepts in one place instead of scattered through routes.
- **`packages/config`** — shared `tsconfig` bases, ESLint/Prettier config, and a
  single Zod-validated environment schema (`env.ts`) so every app fails fast on
  missing/invalid config (e.g. a weak `SESSION_SECRET`).

Workspace package names keep the `@workspace/*` scope for continuity (e.g.
`@workspace/db`, `@workspace/core`), so import paths change minimally.

### 2.2 Backend request lifecycle (target)

```
HTTP request
  │
  ▼
[ pino-http ]            structured request logging (request id)
  │
  ▼
[ session / bearer ]     load session → req.session.userId (existing)
  │
  ▼
[ requireAuth ]          401 if no session
  │
  ▼
[ resolveTenant ]        NEW — derive organization_id (+ company/branch) for the
  │                      request; attach TenantContext to req; 403 if the user
  │                      is not a member of the requested organization
  ▼
[ RBAC guard ]           permission check for this route + tenant role
  │
  ▼
[ controller ]           validate input (Zod from api-zod), call service
  │
  ▼
[ service ]              business logic; owns transactions; calls accounting core
  │
  ▼
[ repository ]           data access — EVERY query filtered by organization_id
  │
  ▼
PostgreSQL (+ RLS as defense-in-depth)
```

`resolveTenant` is the linchpin of the whole platform. It runs after auth and
produces an immutable `TenantContext { organizationId, companyId?, branchId?,
userId, role, permissions }` that is threaded through controller → service →
repository. Repositories never accept a raw query without a `TenantContext`.

---

## 3. SaaS Transformation — Tenancy Model

### 3.1 The hierarchy: Organization → Company → Branch

A single accounting platform in KSA/GCC must model real business structures. We
introduce a three-level tenant hierarchy:

```
Organization  (the tenant / customer account — the billing & isolation boundary)
  └── Company  (a legal entity: its own CR number, VAT registration, Zakat file)
        └── Branch  (a physical/operational location under a company)
```

- **Organization** — the **hard isolation boundary**. `organization_id` is the
  tenant key that appears on every business table and gates every query and RLS
  policy. Users belong to organizations. Two organizations can never see each
  other's data under any circumstance.
- **Company** — a legal entity within the organization. VAT registration, Zakat
  filing, chart of accounts, and financial statements are produced **per
  company**. Most accounting data (invoices, bills, journal entries, period
  locks) is scoped to a company, which is itself within an organization.
- **Branch** — an optional operational subdivision of a company (store, office,
  region) used for segment reporting and cost centers. Nullable on most records.

Scoping rule of thumb: **`organization_id` is mandatory on every business table**
(the isolation key). `company_id` is mandatory on ledger/accounting tables (the
accounting boundary). `branch_id` is optional and used for reporting.

### 3.2 New platform tables

```
organizations       id, name, slug, status, created_at
companies           id, organization_id, name, cr_number, vat_number,
                    zakat_number, base_currency (default SAR), fiscal_year_start,
                    created_at
branches            id, organization_id, company_id, name, code, created_at
memberships         id, organization_id, user_id, role, status, created_at
                    (M:N between users and organizations; carries the tenant role)
audit_log           id, organization_id, actor_user_id, entity, entity_id,
                    action, before, after, request_id, created_at
```

- **`users`** becomes a **global identity** table (email, password hash, name).
  A user's *role within a tenant* moves out of `users.role` and into
  `memberships.role`, because the same person can be an admin in one organization
  and a viewer in another. `users.role` is deprecated during the migration.
- **`memberships`** is the join that makes a user part of an organization and
  defines their role there. `resolveTenant` validates membership.

### 3.3 Multi-tenancy enforcement — two layers

Tenant isolation is enforced in **application code first, database second** —
defense in depth:

1. **Application layer (primary).** Every repository method requires a
   `TenantContext` and injects `WHERE organization_id = $ctx.organizationId`
   (and `company_id` where applicable) into every read and write. This is the
   fast path and the layer developers reason about daily. It is covered by tests
   that attempt cross-tenant access and assert failure.

2. **Row-Level Security / RLS (defense-in-depth).** Postgres RLS policies on
   every tenant-scoped table reject rows outside the current tenant even if
   application code has a bug. The request's `organization_id` is set as a
   per-transaction GUC (e.g. `SET LOCAL app.current_org = $1`), and policies read
   it via `current_setting('app.current_org')`. RLS is a backstop, not a
   substitute for application scoping.

> **Note on Supabase.** We use Supabase for **managed Postgres only**. RLS here
> is plain Postgres RLS driven by our own session GUC — **not** Supabase Auth /
> `auth.uid()`. Authentication remains Express session auth (see §5).

### 3.4 Tenant-aware GL, periods, and tax

The accounting core is preserved but made tenant-aware at its boundaries:

- **`postJournalEntry`** gains a `TenantContext`; the entry and its lines are
  written with `organization_id` + `company_id`. Balancing logic is unchanged.
- **Period locks** move from a global `unique(period)` to
  `unique(organization_id, company_id, period)` — each company closes its own
  months. `checkPeriodOpen` takes the tenant context and scopes its lookup.
- **VAT/Zakat** calculations are unchanged, but VAT registration and Zakat files
  are attributes of a **company**, so reports read tax identifiers per company.

---

## 4. Migration Strategy — per existing module

Each existing module is migrated with the same discipline: it keeps working at
every step, gains `organization_id`, and moves into the layered structure.

| Module (current)                | Target home                          | Migration notes |
| ------------------------------- | ------------------------------------ | --------------- |
| `lib/db/src/schema/*`           | `packages/db/src/schema/*`           | Add `organization_id` (+ `company_id` on ledger tables) additively; introduce SQL migrations via `drizzle-kit generate` instead of `push`. |
| `glPosting.ts`                  | `apps/api/src/accounting/glPosting`  | Preserve balancing logic verbatim; thread `TenantContext`; stamp org/company on entries + lines. |
| `periodLock.ts`                 | `apps/api/src/accounting/periodLock` | Change uniqueness to `(org, company, period)`; scope lookups by tenant. |
| `zatca.ts`                      | `apps/api/src/accounting/zatca`      | Logic unchanged; source VAT/Zakat identifiers from `companies`. |
| `categorizer.ts` / `llmCategorizer.ts` | `apps/api/src/services/categorization` | Categorization *proposes*; never posts. AI path stays behind the propose/approve boundary. |
| `routes/*.ts` (per entity)      | `routes` → `controllers` → `services` → `repositories` | Split each fat route file into the four layers; behavior identical, tenant-scoped. |
| `auth.ts` (guards)              | `apps/api/src/middleware/auth,rbac`  | `requireAuth` kept; role check moves to membership-based RBAC. |
| `app.ts`                        | `apps/api/src/app.ts`                | Insert `resolveTenant` + RBAC into the middleware chain; harden session config. |
| `artifacts/bookkeeping/*`       | `apps/web/*`                         | Move as-is; add org/company switcher UI; regenerate API client. |
| `lib/api-spec` / `api-zod` / `api-client-react` | `packages/api-spec` / `api-zod` / `api-client` | Move; keep orval codegen; add org/company params to relevant operations. |

Ordering principle: **schema additive changes land before code depends on them**,
and **each module is cut over independently** so the app is never broken between
milestones.

---

## 5. Authentication & Security (target)

Authentication stays **Express session auth** — `express-session` +
`connect-pg-simple` (Postgres-backed sessions) + bcryptjs. We do **not** adopt
Supabase Auth. The hardening work is:

- **Fail-fast config.** `SESSION_SECRET` (and all secrets) validated at boot via
  the shared env schema in `packages/config`; no insecure fallback default. The
  current `"change-me-in-production"` fallback in `app.ts` is removed.
- **Cookie hardening.** `secure: true` in production, `httpOnly`, `sameSite`,
  rolling expiry, short-lived sessions. The Replit bearer-token workaround is
  gated to non-production only (or removed once off Replit preview).
- **Session ↔ tenant binding.** A session carries `userId`; `resolveTenant`
  resolves the active `organization_id` per request and verifies membership.
- **RBAC** (see §6) replaces the current coarse method-based role check.
- **Audit logging** (see §7) records who did what, in which tenant.
- **RLS** as a database-level backstop (see §3.3).

---

## 6. RBAC (target)

The current model is coarse: a single `users.role` (`admin | accountant |
viewer`) checked by HTTP method (DELETE → admin, POST/PATCH → accountant+). The
target is **membership-based, permission-oriented RBAC**:

- **Role lives on the membership**, per organization — a user can be `admin` in
  org A and `viewer` in org B.
- **Roles map to permissions** (e.g. `ledger:post`, `period:lock`,
  `invoice:write`, `user:manage`). Route guards check *permissions*, not raw
  roles, so roles can evolve without touching every route.
- Preserve the existing three roles as the initial role set; add finer roles
  later without breaking the model.

---

## 7. Database Migration Strategy

We move off `drizzle-kit push` (which mutates the DB directly and is unsafe for
production tenant data) to **versioned SQL migrations** via
`drizzle-kit generate` + a migration runner. Adding `organization_id` to live
tables follows a four-phase, zero-downtime pattern:

### Phase A — Additive
- Create platform tables (`organizations`, `companies`, `branches`,
  `memberships`, `audit_log`).
- Add `organization_id` (+ `company_id` where needed) to every business table as
  **nullable**, with **no** NOT NULL / FK-required constraints yet.
- Deploy code that *writes* the new columns for all new rows but does not yet
  *require* them for reads. Old rows have NULL tenant keys temporarily.

### Phase B — Backfill
- Create a default/bootstrap organization + company and assign existing users to
  it via memberships.
- Backfill `organization_id` / `company_id` on all existing rows in an
  idempotent, batched migration script (safe to re-run).
- Verify: assert zero NULL tenant keys remain on every business table.

### Phase C — Enforce
- Alter columns to `NOT NULL`; add FKs to `organizations` / `companies`.
- Replace global unique constraints with tenant-scoped ones (e.g.
  `period_locks`: drop `unique(period)`, add `unique(org, company, period)`;
  similarly any other globally-unique business key).
- Add composite indexes leading with `organization_id` for query performance.
- Enable **RLS** policies on all tenant-scoped tables.
- Flip repositories to require `TenantContext` (compile-time enforced).

### Phase D — Cutover
- Remove deprecated columns/paths (`users.role` once RBAC via memberships is
  live; any pre-tenant code branches).
- Make `resolveTenant` mandatory for all business routes.
- Remove the "no owner / pre-auth" nullable escape hatches
  (e.g. `journal_entries.created_by` semantics) now that every row has an owner.

Each phase is a separate, reversible migration with its own tests. The
application remains functional after every phase.

---

## 8. Technology Review

An assessment of the current stack against the SaaS target. Default posture:
**keep what works**, change only where multi-tenancy or safety demands it.

| Area            | Current            | Decision  | Rationale |
| --------------- | ------------------ | --------- | --------- |
| Monorepo        | pnpm workspaces    | **Keep**  | Fine at this scale; only rename `artifacts→apps`, `lib→packages`. |
| Backend         | Express 5 + TS     | **Keep**  | Mature; layering is the change, not the framework. |
| Frontend        | React 19 + Vite    | **Keep**  | Current; add org/company switcher only. |
| ORM             | Drizzle            | **Keep**  | Good TS ergonomics; supports the migration path. |
| Migrations      | `drizzle-kit push` | **Change**| Move to `drizzle-kit generate` + versioned SQL + runner. `push` is unsafe for tenant data. |
| Database        | Postgres/Supabase  | **Keep**  | Add RLS. Supabase = managed Postgres only, **not** its Auth. |
| Auth            | Express sessions   | **Keep + harden** | Explicitly not Supabase Auth. Fix secrets, cookies, tenant binding. |
| Cache/queue     | Redis              | **SUPERSEDED — decided against (C1, 2026-08-20)** | Rate limiting is a shared **Postgres** store (`lib/rateLimitStore.ts`); background work is the in-process scheduler. No new failure domain was the point. Revisit only with a measured need. |
| API contract    | OpenAPI + orval    | **Keep**  | Contract-first is a core principle; extend spec with tenant params. |
| Validation      | Zod (generated)    | **Keep**  | Already wired through codegen. |
| Logging         | pino / pino-http   | **Keep + extend** | Add request-id propagation and the audit log. |
| Tests           | Vitest             | **Keep + expand** | Add cross-tenant isolation tests as first-class citizens. |
| CI/CD           | (none yet)         | **Add**   | Lint + typecheck + test + migration check on every PR (see plan M8). |

### Open questions to resolve during Phase 0
- ~~Session store: keep Postgres-backed (`connect-pg-simple`) or move to Redis
  for horizontal scale? (Leaning Redis once multi-instance.)~~ **Answered (C1,
  2026-08-20): Postgres for both sessions and rate limiting.** The C1 record in
  CLAUDE.md §5 has the reasoning; multi-instance correctness is tested (two
  store instances share one counter).
- Company vs. organization scoping granularity for shared reference data
  (categories/chart of accounts): per-company, or org-level templates?
- RLS GUC propagation with a pooled `pg` connection — ensure `SET LOCAL` runs
  inside every request transaction and never leaks across pooled connections.

---

## 9. Relationship to the Implementation Plan

This blueprint defines the destination. The
[Phase 0 Implementation Plan](./phase-0-implementation-plan.md) sequences the
journey across ten milestones (M0–M9): tooling, repo restructure, additive
tenancy schema, backfill/enforce, auth hardening, RBAC, backend layering, audit
logging, CI/CD, and repo finalization. Keep both documents in sync as decisions
land.
