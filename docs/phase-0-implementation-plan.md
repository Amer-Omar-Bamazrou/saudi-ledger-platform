# Phase 0 — Platform Foundation: Implementation Plan

The milestone-by-milestone plan for **Phase 0 (Platform Foundation)** of the
Saudi Ledger Platform. Phase 0 turns the single-tenant bookkeeping app into the
foundation of a multi-tenant SaaS platform — without breaking the accounting core
and without shipping any new accounting or AI features.

Read alongside the [Architecture Blueprint](./architecture-blueprint.md) (the
destination) and [`../CLAUDE.md`](../CLAUDE.md) (the rules). This document is the
sequence.

---

## Phase 0 Goals

1. Restructure the repo into a clean `apps/` + `packages/` layout with layered
   backend code.
2. Introduce true multi-tenancy: `organization_id` on every business table,
   enforced in application code and with Postgres RLS as a backstop.
3. Harden authentication and security (keep Express session auth).
4. Replace coarse role checks with membership-based RBAC.
5. Add an audit trail and CI/CD so the platform is operable and safe to change.

### Definition of Done (Phase 0)

- Every business table has a non-null `organization_id`; every query is
  tenant-scoped; cross-tenant access is impossible and there are tests proving it.
- The accounting core (GL posting, period locks, VAT/Zakat) behaves identically
  to today, now tenant-aware.
- No insecure config defaults; sessions hardened; RBAC enforced by permission.
- CI runs lint + typecheck + tests + migration checks on every PR.
- The repo is in its final `apps/` + `packages/` shape with versioned migrations.

### How to read a milestone

Each milestone lists **Objectives**, **Deliverables**, **Dependencies**, and
**Acceptance Criteria**. Milestones are intentionally small and sequential;
schema changes are always additive-before-enforcing so the app never breaks
between milestones.

### Milestone map

| ID  | Title                          | Depends on |
| --- | ------------------------------ | ---------- |
| M0  | Tooling & Environment          | —          |
| M1  | Repository Restructure         | M0         |
| M2  | Tenancy Schema (Additive)      | M1         |
| M3  | Backfill + Enforce Tenancy     | M2         |
| M4  | Auth & Security Hardening      | M0, M3     |
| M5  | RBAC                           | M3, M4     |
| M6  | Backend Layering               | M1, M3     |
| M7  | Audit Logging                  | M5, M6     |
| M8  | CI/CD                          | M0         |
| M9  | Repository Finalization        | M1–M8      |

---

## M0 — Tooling & Environment

**Objectives**
Establish a safe, reproducible foundation before touching any code or data:
validated environment config, a real migration workflow, and baseline quality
gates that later milestones build on.

**Deliverables**
- `packages/config` with a **Zod-validated environment schema** (`env.ts`)
  covering `DATABASE_URL`, `PORT`, `SESSION_SECRET` (min length enforced), Redis
  URL, etc. App boot fails fast on missing/invalid values.
- Migration workflow: switch from `drizzle-kit push` to `drizzle-kit generate`
  + a migration runner script; commit the initial baseline migration
  representing the current schema.
- Shared `tsconfig` bases, ESLint, and Prettier config in `packages/config`.
- A documented `.env.example` for the API and web apps.
- Local dev: Postgres + Redis via a documented setup (compose file or scripts).

**Dependencies**
- None. This is the entry point.

**Acceptance Criteria**
- `pnpm run typecheck` passes repo-wide with the shared config.
- Starting the API with a missing/short `SESSION_SECRET` **fails at boot** with a
  clear error (no insecure fallback).
- `drizzle-kit generate` produces a migration; the runner applies it to a clean
  database and reproduces the current schema exactly.
- Existing tests (`vitest`) still pass unchanged.

---

## M1 — Repository Restructure

**Objectives**
Move to the target `apps/` + `packages/` layout and introduce the new shared
packages, as a mechanical move with **no behavior change**.

**Deliverables**
- `artifacts/api-server → apps/api`, `artifacts/bookkeeping → apps/web`.
- `lib/db → packages/db`, `lib/api-spec → packages/api-spec`,
  `lib/api-zod → packages/api-zod`, `lib/api-client-react → packages/api-client`.
- New empty-but-wired `packages/core` (tenant context, domain errors, money
  helpers, role/permission enums — stubs to be filled in later milestones).
- Updated `pnpm-workspace.yaml`, workspace references, import paths, and build
  scripts. `@workspace/*` package names preserved where possible.

**Dependencies**
- M0 (shared config + migration workflow in place before the move).

**Acceptance Criteria**
- `pnpm install`, `pnpm run typecheck`, `pnpm run build`, and `vitest` all pass
  after the move.
- Both apps run (`apps/api` dev, `apps/web` dev) and the app behaves exactly as
  before — this milestone changes structure only.
- OpenAPI codegen (`packages/api-spec run codegen`) still regenerates cleanly.
- Git history preserved via `git mv` (no mass delete/re-add).

---

## M2 — Tenancy Schema (Additive)

**Objectives**
Introduce the tenant model and tenant keys **additively** — new tables and new
**nullable** columns — so nothing breaks and existing rows keep working.

**Deliverables**
- New platform tables: `organizations`, `companies`, `branches`, `memberships`.
- `organization_id` added as **nullable** to every business table; `company_id`
  added (nullable) to ledger/accounting tables (journal entries + lines,
  invoices, bills, payroll, period locks, etc.).
- Drizzle schema updated; a generated additive migration (no NOT NULL, no new
  required FKs, no unique-constraint changes yet).
- Write-path code updated to **populate** the new columns for newly created rows
  (behind the current single default tenant), while reads do not yet require them.

**Dependencies**
- M1 (schema now lives in `packages/db`).

**Acceptance Criteria**
- Migration applies cleanly forward and reverses cleanly on a copy of production-
  shaped data.
- All existing endpoints continue to work; existing rows (with NULL tenant keys)
  are still readable.
- New rows created after deploy carry a non-null `organization_id`.
- No unique constraints changed yet; no column is NOT NULL yet.

---

## M3 — Backfill + Enforce Tenancy

**Objectives**
Assign all existing data to a tenant, then flip tenancy from optional to
**mandatory** — in the database (NOT NULL, FKs, tenant-scoped uniqueness, RLS)
and in application code (repositories require a `TenantContext`).

**Deliverables**
- Bootstrap migration: create a default organization + company, create
  memberships for all existing users, and **backfill** `organization_id` /
  `company_id` on every business row (idempotent, batched, re-runnable).
- Enforce migration: `organization_id` → `NOT NULL` + FK to `organizations`;
  ledger `company_id` → `NOT NULL` + FK; replace global unique constraints with
  tenant-scoped ones (e.g. `period_locks`: drop `unique(period)`, add
  `unique(organization_id, company_id, period)`).
- Composite indexes leading with `organization_id` on hot tables.
- **RLS enabled** on all tenant-scoped tables, driven by a per-transaction GUC
  (`SET LOCAL app.current_org`) — not Supabase Auth.
- `TenantContext` in `packages/core`; repositories updated so every query is
  scoped by `organization_id` (and `company_id` where applicable). Accounting
  core (`postJournalEntry`, `checkPeriodOpen`) made tenant-aware at its edges.

**Dependencies**
- M2 (columns exist and are populated for new rows).

**Acceptance Criteria**
- Post-backfill assertion: **zero NULL** `organization_id` (and required
  `company_id`) across every business table.
- A **cross-tenant access test suite** proves a user in org A cannot read or
  mutate org B's transactions, invoices, journal entries, or period locks —
  blocked at both the application layer and by RLS (verified independently).
- GL posting still balances and still enforces period locks — now per company;
  the existing accounting tests pass, plus new per-tenant period-lock tests.
- Query plans on hot paths use the new composite indexes (no full scans introduced).

---

## M4 — Auth & Security Hardening

**Objectives**
Harden the existing Express session auth (do **not** switch to Supabase Auth) and
bind sessions to tenants safely.

**Deliverables**
- Remove the insecure `SESSION_SECRET` fallback; secret now comes from the
  validated env schema (M0) and is required.
- Cookie hardening: `secure: true` in production, `httpOnly`, `sameSite`, rolling
  expiry; the Replit bearer-token workaround gated to non-production only.
- A `resolveTenant` middleware that runs after `requireAuth`, resolves the active
  `organization_id` (and optional company/branch) for the request, verifies the
  user's **membership**, and attaches `TenantContext` to the request. Wires the
  request's org into the RLS GUC for the transaction.
- Basic abuse protections: rate limiting on auth endpoints (Redis-backed),
  password hashing parameters reviewed, generic auth error messages.

**Dependencies**
- M0 (env schema), M3 (memberships + tenant scoping exist to bind to).

**Acceptance Criteria**
- App refuses to start without a valid `SESSION_SECRET`; production cookies are
  `secure`/`httpOnly`.
- A request for an organization the user is **not** a member of returns 403 and
  touches no data.
- Every authenticated business request carries a resolved `TenantContext`, and
  the RLS GUC matches it for the duration of the transaction.
- Auth endpoints are rate-limited; tests cover unauthorized and wrong-tenant paths.

---

## M5 — RBAC

**Objectives**
Replace the coarse HTTP-method role check with **membership-based, permission-
oriented RBAC**.

**Deliverables**
- Role stored on `memberships` (per organization), not `users`; `users.role`
  marked deprecated.
- A permission model in `packages/core`: named permissions (e.g. `ledger:post`,
  `period:lock`, `invoice:write`, `user:manage`) mapped from roles
  (`admin | accountant | viewer` preserved as the initial set).
- Route guards check **permissions** via middleware, replacing the method-based
  role block in the current router.
- Admin UI/endpoints to manage memberships and roles within an organization.

**Dependencies**
- M3 (memberships exist), M4 (tenant + auth resolved before RBAC runs).

**Acceptance Criteria**
- The same user can hold different roles in different organizations, and the
  effective permissions follow the active tenant.
- Each protected route enforces a specific permission; a viewer cannot mutate, a
  non-admin cannot manage users, etc., with tests per permission.
- Removing/adding a role changes access without editing individual route files
  (permissions are the seam).

---

## M6 — Backend Layering

**Objectives**
Refactor fat route files into the **Route → Controller → Service → Repository**
layering, with business logic out of HTTP handlers — behavior unchanged.

**Deliverables**
- For each entity: a thin `route` (HTTP + validation wiring), a `controller`
  (request/response coordination), a `service` (business logic, owns
  transactions, calls the accounting core), and a `repository` (tenant-scoped
  data access). No raw DB access outside repositories.
- Accounting core relocated under `apps/api/src/accounting/*`, called only from
  services, always with a `TenantContext`.
- A consistent error-handling middleware and typed domain errors from
  `packages/core`.

**Dependencies**
- M1 (target layout), M3 (repositories are the tenant-scoping seam).

**Acceptance Criteria**
- No business logic remains in route handlers; no SQL/Drizzle calls outside
  repositories (enforced by review + a lint rule/grep check).
- All endpoints behave identically (contract tests against the OpenAPI spec pass;
  existing + new unit tests pass).
- Services are unit-testable without HTTP; repositories reject any call lacking a
  `TenantContext` (compile-time where possible).

---

## M7 — Audit Logging

**Objectives**
Record who did what, in which tenant — an immutable trail for every business
mutation, essential for an accounting platform.

**Deliverables**
- `audit_log` table (org, actor, entity, entity_id, action, before/after,
  request_id, timestamp) — append-only.
- A service/repository hook that writes an audit entry on every create/update/
  delete of business data, capturing the tenant, actor, and request id (from
  pino-http).
- Special attention to ledger-sensitive actions: journal posting, period lock/
  unlock, reversals, membership/role changes.
- Read endpoints (admin-only, tenant-scoped) to view the audit trail.

**Dependencies**
- M5 (actor + role known), M6 (single mutation seam in services/repositories to
  hook).

**Acceptance Criteria**
- Every business mutation produces exactly one audit record with correct tenant,
  actor, and request id; verified by tests.
- Audit records are immutable (no update/delete path) and tenant-scoped.
- Posting a journal entry, locking a period, and changing a role each appear in
  the audit trail with before/after detail.

---

## M8 — CI/CD

**Objectives**
Make the platform safe to change: automated quality gates on every PR and a
repeatable path to deploy.

**Deliverables**
- CI pipeline running on every PR: `pnpm install`, lint, `typecheck`, `build`,
  `vitest`, and OpenAPI codegen **drift check** (fail if generated client/Zod is
  stale).
- **Migration check**: apply all migrations to a clean throwaway Postgres in CI
  and assert the resulting schema matches the Drizzle schema (no un-generated
  drift); run the cross-tenant isolation test suite against it.
- Build artifacts for `apps/api` and `apps/web`; documented deploy/runbook and
  environment matrix.
- Branch protection: green CI required to merge to `main`.

**Dependencies**
- M0 (migration workflow + config exist to check against). Can proceed largely in
  parallel; most valuable once M2–M3 migrations exist.

**Acceptance Criteria**
- A PR with a type error, failing test, stale generated client, or un-generated
  migration is **blocked** by CI.
- CI provisions Postgres, applies migrations, and runs the isolation suite green.
- `main` cannot be merged to without passing CI.

---

## M9 — Repository Finalization

**Objectives**
Complete the cutover: remove deprecated paths and legacy escape hatches, finalize
docs, and confirm the repo fully embodies the blueprint.

**Deliverables**
- Remove deprecated `users.role` and any pre-tenant/`NULL`-owner code branches
  and nullable escape hatches (e.g. pre-auth `created_by` semantics) now that
  every row is owned and tenant-scoped (migration Phase D / cutover).
- Retire the Replit-specific workarounds if the platform is off Replit preview;
  otherwise gate them cleanly.
- Final pass on `CLAUDE.md`, this plan, and the blueprint so they match reality;
  ensure `apps/` + `packages/` layout and versioned migrations are the only story.
- Tag the Phase 0 completion; write the Phase 1 kickoff notes (AI feature
  foundation, billing, etc. — out of scope here).

**Dependencies**
- M1–M8 (everything above must be in place before removing legacy paths).

**Acceptance Criteria**
- No references to deprecated columns, the old `artifacts/`/`lib/` layout, or
  `drizzle-kit push` remain in code or docs.
- Full green: typecheck, build, all tests (including cross-tenant isolation and
  accounting-core tests), and CI migration check.
- The Definition of Done for Phase 0 (top of this document) is fully satisfied.

---

## Sequencing Summary

```
M0 ─┬─ M1 ─ M2 ─ M3 ─┬─ M4 ─ M5 ─┐
    │                 │           ├─ M7 ─┐
    │                 └─── M6 ────┘      ├─ M9
    └───────── M8 ───────────────────────┘
```

- **Critical path:** M0 → M1 → M2 → M3 → M4 → M5 → M7 → M9 (tenancy + security +
  audit).
- **M6 (layering)** depends on M1 + M3 and feeds M7; can overlap M4/M5.
- **M8 (CI/CD)** depends only on M0 and should be stood up early, then extended
  with the migration + isolation checks once M2–M3 land.
- Golden rule throughout: **the app works and the accounting core is correct
  after every milestone.** Schema changes are additive before they are enforced.
