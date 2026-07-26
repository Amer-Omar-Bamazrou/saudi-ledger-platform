# CLAUDE.md

Guidance for Claude Code (and any AI agent) working in this repository.

## 1. Project Overview

This is the **Saudi Ledger Platform** — an AI-powered Accounting & Finance
Operating Platform for Saudi Arabia, and later the wider GCC.

It began life as a single-tenant bookkeeping app (the "Saudi Ledger Engine") and
is **currently being refactored into a scalable, multi-tenant SaaS platform**.
The accounting core is real and correct — invoices, bills, journal entries, GL
posting, period locks, VAT, and Zakat all work today. The refactoring effort is
about the *platform* around that core: multi-tenancy, clean layering, security,
and a foundation for future AI features.

When in doubt, favor evolving the existing system over replacing it.

## 2. Current State — Phase 0: Platform Foundation

We are in **Phase 0 (Platform Foundation)**, working through small milestones to:

- Restructure the architecture into clean, testable layers
- Add **multi-tenancy** (organization scoping) across all business data
- Fix security gaps (e.g. session secrets, per-tenant isolation, access control)
- Prepare the groundwork for future AI features

Multi-tenancy does **not** exist yet — no business table currently has an
`organization_id`. Adding it correctly and safely is a core Phase 0 goal, not an
afterthought. See `docs/phase-0-implementation-plan.md`.

## 3. Tech Stack

| Layer            | Technology                                                    |
| ---------------- | ------------------------------------------------------------- |
| Monorepo         | pnpm workspaces (`apps/*`, `packages/*`, `scripts`)           |
| Backend          | Express 5, TypeScript, Node.js (ESM), esbuild bundle          |
| Frontend         | React 19, Vite, TypeScript, Tailwind CSS v4, shadcn/ui        |
| Routing (FE)     | Wouter                                                        |
| Data fetching    | TanStack Query (React Query v5)                               |
| ORM              | Drizzle ORM                                                   |
| Database         | PostgreSQL (via Supabase)                                     |
| Cache / queue    | Redis                                                         |
| Auth             | Express session auth (`express-session` + `connect-pg-simple`, bcryptjs) |
| API contract     | OpenAPI-first (`packages/api-spec/openapi.yaml`) with orval codegen |
| Validation       | Zod (generated into `@workspace/api-zod`)                     |
| i18n             | Custom `LanguageContext` (Arabic / English, RTL-aware)        |
| Logging          | pino / pino-http                                              |

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
    src/schema/      one file per table
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
   AI features must never write directly to the ledger. They *propose* entries,
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
pnpm --filter @workspace/db run push                 # push Drizzle schema to Postgres
pnpm --filter @workspace/api-spec run codegen        # regenerate API client + Zod
pnpm --filter @workspace/api-server run test         # backend tests (Vitest)
pnpm run typecheck                                   # typecheck the whole repo
```
