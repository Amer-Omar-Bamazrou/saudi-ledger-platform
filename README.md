# Saudi Ledger Platform

A multi-tenant, AI-ready **Accounting & Finance Operating Platform** for Saudi
Arabia — and, in time, the wider GCC.

The platform pairs a correct, tested accounting core (invoices, bills, journal
entries, GL posting, period locks, VAT, and Zakat) with a modern multi-tenant
SaaS foundation: organization scoping enforced end-to-end, database-level
tenant isolation, permission-based access control, an immutable audit trail, and
CI on every change.

> **Status (2026-08): the accounting product is built and locally verified;
> nothing is deployed and there are no customers yet.** Invoicing, bills,
> journal entries, GL posting, period locks, the VAT return, bank-statement
> ingestion with review, quotations → invoices and purchase orders → bills
> (with partial conversion), document capture (OCR + ZATCA QR), recurring
> documents, fiscal calendars (Gregorian + Umm al-Qura Hijri), and the
> reporting/analytics surface all work today. **ZATCA Phase 2 e-invoicing is
> built and sandbox-verified but has never submitted a production invoice** —
> that waits on a real Saudi VAT registration. Zakat is decided but not built.
> The AI layer is specced, not commissioned. The authoritative, always-current
> state lives in [`CLAUDE.md`](./CLAUDE.md) §2; the narrative history is in
> [`docs/history/`](./docs/history/).

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

## What's built

The platform foundation (Phase 0), and the accounting product on top of it.
Highlights of the product layer — each verified by tests that post through the
real write paths, most with a live verification pass recorded:

- **Documents**: invoices (with credit/debit notes), bills, journal entries,
  payroll — all through a uniform draft → submit → approve workflow where
  nothing touches the books before approval.
- **Commitments**: quotations that convert to invoices and purchase orders that
  convert to bills, partially and by quantity, with dated conversion history —
  and no ledger effect until converted.
- **Banking**: statement upload with a review surface, a deterministic
  categorizer (uncategorised rows post to a visible SUSPENSE, never guessed),
  transfers posting by declared direction, reconciliation against the GL.
- **Tax**: a document-derived VAT return (box-structured, line-level), VAT
  treatments verified against the primary regulations, reverse-charge handling,
  input-VAT blocking (Art. 50). Zakat deliberately shows "not implemented"
  rather than a wrong number.
- **ZATCA Phase 2**: UBL 2.1 + XAdES signing (secp256k1), ICV/PIH chain, QR,
  onboarding, outbox — sandbox-verified; production submission awaits a real
  taxpayer registration.
- **Fiscal periods**: Gregorian and Umm al-Qura Hijri fiscal years, resolver-
  driven report windows, dual-calendar dates, prior-period comparison.
- **Automation**: phone document capture (client-side OCR + ZATCA QR decode)
  and recurring documents (drafts only, by design).

### The foundation (Phase 0)

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

> **There is no Redis, by decision.** Sessions are Postgres-backed, rate
> limiting uses a **shared Postgres-backed store** (so limits hold across
> instances), and background work runs on an in-process scheduler
> (`apps/api/src/jobs/`). Where the architecture blueprint mentions Redis,
> read it as superseded.

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
  zatca-tlv/          ZATCA QR TLV codec (server + browser) (@workspace/zatca-tlv)
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
pnpm --filter @workspace/api-server run seed:sample  # sample data — reports are empty without it

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
