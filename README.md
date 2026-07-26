# Saudi Ledger Platform

An AI-powered **Accounting & Finance Operating Platform** for Saudi Arabia — and,
in time, the wider GCC.

> **Status: active refactoring.** This project started as a single-tenant
> bookkeeping app and is being refactored into a scalable, **multi-tenant SaaS
> platform**. The accounting core (invoices, bills, journal entries, GL posting,
> period locks, VAT/Zakat) is real and correct; the current work is on the
> platform around it — multi-tenancy, clean layering, security, and a foundation
> for future AI features. We are in **Phase 0 (Platform Foundation)**.

## Documentation

- **[`CLAUDE.md`](./CLAUDE.md)** — project overview, principles, and conventions
  (read this first).
- **[`docs/architecture-blueprint.md`](./docs/architecture-blueprint.md)** — target
  technical architecture.
- **[`docs/phase-0-implementation-plan.md`](./docs/phase-0-implementation-plan.md)** —
  Phase 0 milestone plan.

## Tech Stack

| Layer         | Technology                                                       |
| ------------- | ---------------------------------------------------------------- |
| Monorepo      | pnpm workspaces                                                  |
| Backend       | Express 5, TypeScript, Node.js (ESM)                             |
| Frontend      | React 19, Vite, TypeScript, Tailwind CSS v4, shadcn/ui           |
| Routing (FE)  | Wouter                                                           |
| Data fetching | TanStack Query (React Query v5)                                  |
| ORM           | Drizzle ORM                                                      |
| Database      | PostgreSQL (via Supabase)                                        |
| Cache / queue | Redis                                                            |
| Auth          | Express session auth (`express-session` + `connect-pg-simple`)   |
| API contract  | OpenAPI-first (`lib/api-spec/openapi.yaml`) with orval codegen   |
| i18n          | Custom `LanguageContext` (Arabic / English, RTL-aware)          |

## Repository Layout

```
artifacts/
  api-server/     Express 5 + TypeScript backend  (@workspace/api-server)
  bookkeeping/    React 19 + Vite frontend        (@workspace/bookkeeping)
lib/
  db/             Drizzle schema + pg pool         (@workspace/db)
  api-spec/       OpenAPI spec + orval config      (@workspace/api-spec)
  api-zod/        Generated Zod schemas/types      (@workspace/api-zod)
  api-client-react/ Generated React Query client   (@workspace/api-client-react)
docs/             Architecture blueprint & Phase 0 plan
```

## Getting Started

### Prerequisites

- Node.js v20+
- pnpm v9+ (this project uses pnpm exclusively — a preinstall guard rejects
  npm/yarn)
- A PostgreSQL database (Supabase, or any Postgres instance)

### 1. Install

```bash
pnpm install
```

### 2. Configure environment

Create `artifacts/api-server/.env`:

```env
DATABASE_URL=postgresql://user:password@host:5432/dbname
PORT=8080
# Generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
SESSION_SECRET=replace_with_a_long_random_string_at_least_32_chars
```

Create `artifacts/bookkeeping/.env`:

```env
PORT=5173
BASE_PATH=/
VITE_API_BASE_URL=http://localhost:8080
```

Neither `.env` is committed. Never commit real credentials.

### 3. Push the database schema

```bash
pnpm --filter @workspace/db run push
```

This reads `lib/db/src/schema/` and creates the tables. Run it again only when
the schema changes.

### 4. Run

Two servers run at once (use two terminals):

```bash
# API server
pnpm --filter @workspace/api-server run dev

# Frontend
pnpm --filter @workspace/bookkeeping run dev
```

Open http://localhost:5173. On first load, register the first admin user;
subsequent accounts are created from the in-app User Management page.

## Common Commands

```bash
pnpm --filter @workspace/api-spec run codegen   # regenerate API client + Zod from OpenAPI
pnpm --filter @workspace/api-server run test     # backend tests (Vitest)
pnpm run typecheck                               # typecheck the whole repo
```

## Contributing

Read [`CLAUDE.md`](./CLAUDE.md) before making changes. In short: preserve the
working accounting logic, keep every business table and query tenant-scoped, keep
business logic out of route handlers, and change the OpenAPI spec + regenerate
rather than hand-editing generated code. Work in small, tested milestones.

## License

MIT
