# Saudi Ledger Platform

A multi-tenant, AI-ready **Accounting & Finance Operating Platform** for Saudi
Arabia — and, in time, the wider GCC.

The platform pairs a correct, tested accounting core (invoices, bills, journal
entries, GL posting, period locks, VAT, and Zakat) with a modern multi-tenant
SaaS foundation: organization scoping enforced end-to-end, database-level
tenant isolation, permission-based access control, an immutable audit trail, and
CI on every change.

> **Status — Phase 0 (Platform Foundation): complete.** The project began as a
> single-tenant bookkeeping app and has been refactored into the foundation of a
> multi-tenant SaaS platform. The system today is **multi-tenant, RLS-enforced,
> RBAC-governed, audited, and CI-protected**. New accounting features, billing,
> and AI features are future phases — the groundwork for them is in place, but
> they are **not** built yet. See
> [`docs/phase-0-implementation-plan.md`](./docs/phase-0-implementation-plan.md).

## Documentation

Start here — the docs are written so a new engineer can clone the repo and become
productive from them alone:

- **[`docs/local-setup.md`](./docs/local-setup.md)** — get the platform running
  locally (Supabase Postgres, migrations, seed, API + web). **Start here.**
- **[`docs/development-guide.md`](./docs/development-guide.md)** — how the code is
  organized and how to add a feature without breaking tenant isolation, RBAC, or
  the audit trail.
- **[`CONTRIBUTING.md`](./CONTRIBUTING.md)** — branch strategy, commit
  conventions, and what must pass before you push.
- **[`CLAUDE.md`](./CLAUDE.md)** — the working context and conventions (what the
  system is, what's done, and the rules to follow). Read this before non-trivial
  work.
- **[`docs/architecture-blueprint.md`](./docs/architecture-blueprint.md)** — the
  target technical architecture (the "north star").

## What's built (Phase 0)

- **Multi-tenancy.** An `Organization → Company → Branch` model. Every business
  table carries a non-null `organization_id` (and `company_id` on ledger tables),
  with tenant-scoped uniqueness and composite indexes.
- **Tenant isolation, enforced two ways.** Application code is tenant-scoped, and
  **PostgreSQL Row-Level Security** is actively enforced as a backstop: each
  request runs in a per-request transaction under a non-owner DB role with the
  active org bound to a session GUC. A cross-tenant isolation test suite proves
  org A cannot read or write org B's data.
- **Hardened auth.** Express session auth (`express-session` +
  `connect-pg-simple` + bcryptjs), fail-fast validated config (no insecure
  secret fallback), an explicit CORS allow-list, hardened cookies, and rate
  limiting on auth endpoints.
- **RBAC.** Centralized, data-driven, permission-based authorization
  (`requirePermission`) keyed off the caller's role in the active organization.
- **Layered backend.** Route → Controller → Service → Repository across all
  business domains; no DB access outside repositories.
- **Audit logging.** Every business mutation writes one append-only, tenant-scoped
  `audit_logs` row, atomically with the mutation.
- **CI/CD.** GitHub Actions runs typecheck, tests (including DB-backed RLS
  isolation + rollback), and build on every PR and push to `main`.

## Tech Stack

| Layer          | Technology                                                              |
| -------------- | ---------------------------------------------------------------------- |
| Monorepo       | pnpm workspaces (Node 24, pnpm 11)                                      |
| Backend        | Express 5, TypeScript, Node.js (ESM), esbuild bundle                    |
| Frontend       | React 19, Vite, TypeScript, Tailwind CSS v4, shadcn/ui                  |
| Routing (FE)   | Wouter                                                                  |
| Data fetching  | TanStack Query (React Query v5)                                         |
| ORM            | Drizzle ORM                                                             |
| Database       | PostgreSQL — Supabase (local via the Supabase CLI); managed Postgres, **not** Supabase Auth |
| Auth           | Express session auth (`express-session` + `connect-pg-simple`, bcryptjs) |
| API contract   | OpenAPI-first (`packages/api-spec/openapi.yaml`) with orval codegen     |
| Validation     | Zod (generated into `@workspace/api-zod`)                              |
| i18n           | Custom `LanguageContext` (Arabic / English, RTL-aware)                 |
| Logging        | pino / pino-http                                                        |
| CI             | GitHub Actions (typecheck · test · build)                              |

> **Redis** appears in the architecture blueprint as a future session store / job
> queue. It is **not wired in yet** — sessions are Postgres-backed and rate
> limiting is in-process. Treat Redis as planned, not present.

## Repository Layout

```
apps/
  api/                Express 5 + TypeScript backend        (@workspace/api-server)
  web/                React 19 + Vite frontend              (@workspace/bookkeeping)
packages/
  db/                 Drizzle schema + pg pool + migrations (@workspace/db)
  api-spec/           OpenAPI spec + orval config           (@workspace/api-spec)
  api-zod/            Generated Zod schemas/types           (@workspace/api-zod)
  api-client-react/   Generated React Query client          (@workspace/api-client-react)
  config/             Zod-validated env schema              (@workspace/config)
  auth/               Auth/RBAC scaffold (reserved)         (@workspace/auth)
scripts/              Workspace scripts
docs/                 Setup, development, architecture, and feature specs
```

Workspace **package names** (`@workspace/*`) are the stable handles — `pnpm --filter`
uses the package name, not the folder path (e.g.
`pnpm --filter @workspace/api-server run dev`).

## Quick Start

Full instructions — including local Supabase, migrations, and seeding a working
admin — are in **[`docs/local-setup.md`](./docs/local-setup.md)**. The short
version:

```bash
pnpm install                                   # install all workspaces
supabase start                                 # local Postgres (Supabase CLI)
cp apps/api/.env.example apps/api/.env         # then fill in SESSION_SECRET
cp apps/web/.env.example apps/web/.env
pnpm --filter @workspace/db run migrate        # apply versioned SQL migrations
SEED_ADMIN_EMAIL=you@example.com \
SEED_ADMIN_PASSWORD=change-me-8+chars \
  pnpm --filter @workspace/db run seed         # default org + company + admin

pnpm --filter @workspace/api-server run dev    # API  (terminal 1)
pnpm --filter @workspace/bookkeeping run dev   # web  (terminal 2)
```

Then open the web app and log in with the seeded admin credentials.

> Schema changes go through **versioned migrations** (`drizzle-kit generate` →
> `migrate`). Do **not** use `drizzle-kit push` against tenant data — it is
> unsafe and bypasses the migration history.

## Architecture at a glance

Every authenticated request flows through the same pipeline:

```
requireAuth → resolveTenant → requirePermission → controller → service → repository → Postgres (+ RLS)
```

`resolveTenant` resolves the active organization from the session + memberships,
opens a per-request transaction under a non-owner Postgres role, and binds
`app.current_org_id` so RLS scopes every query. Business logic lives in services;
**all** data access lives in tenant-scoped repositories; the accounting core (GL
posting, period locks, VAT/Zakat) is the sanctioned exception that services call
directly. See [`docs/development-guide.md`](./docs/development-guide.md) for the
full picture and [`docs/architecture-blueprint.md`](./docs/architecture-blueprint.md)
for the target design.

## Common Commands

```bash
pnpm run typecheck                               # typecheck the whole repo
pnpm run build                                   # typecheck + build every workspace
pnpm --filter @workspace/api-server run test     # backend tests (Vitest)
pnpm --filter @workspace/db run test             # DB tests incl. cross-tenant RLS isolation
pnpm --filter @workspace/db run generate         # generate a versioned SQL migration
pnpm --filter @workspace/db run migrate          # apply pending migrations
pnpm --filter @workspace/db run seed             # idempotent seed (default org + company + admin)
pnpm --filter @workspace/api-spec run codegen    # regenerate API client + Zod from OpenAPI
```

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md). In short: preserve the working
accounting logic, keep every table and query tenant-scoped, keep business logic
out of route handlers, change the OpenAPI spec and regenerate rather than
hand-editing generated code, and make sure typecheck, tests, and build are green
before you push.

## License

**Proprietary — all rights reserved.** This is a private, commercial project;
license terms are to be determined. No open-source license is granted. (No
`LICENSE` file is included by design.)
