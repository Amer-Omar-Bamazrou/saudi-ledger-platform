# Contributing

How we work on the Saudi Ledger Platform. Read this alongside
[`CLAUDE.md`](./CLAUDE.md) (the rules and current state) and
[`docs/development-guide.md`](./docs/development-guide.md) (how the code is
organized). If you haven't run the project yet, start with
[`docs/local-setup.md`](./docs/local-setup.md).

The guiding principle: **evolve the system, don't rewrite it.** The accounting
core is correct and tested — build around it. Every change keeps the platform
tenant-isolated, permission-gated, and audited.

---

## 1. Branch strategy

### The intended workflow (target)

This is how we work once there is more than one contributor and the repo is on a
plan that supports branch protection:

- **`main` is always green and releasable.** No direct commits to `main`.
- **Short-lived feature branches off `main`**, named `type/short-description`
  (e.g. `feat/draft-approval`, `fix/period-lock-scope`).
- **Open a Pull Request** into `main`. CI (typecheck · test · build) **must
  pass** before merge.
- **At least one review** approval once there is a second contributor.
- **Squash or rebase** to keep history linear and each commit meaningful; delete
  the branch after merge.

### Where we are today (interim)

GitHub **ruleset / branch-protection enforcement isn't available on the current
plan**, so it can't be *enforced* server-side yet. Until we move to a Team plan
and turn on required checks:

- **Direct-to-`main` is used** for now, by a single maintainer.
- **CI-green is still required discipline** — do not push work to `main` that
  hasn't passed `typecheck`, `test`, and `build` locally, and watch the CI run
  after pushing. A red `main` is treated as a break to fix immediately.
- Write changes as if they were going through a PR (small, focused, described),
  so the switch to the enforced workflow is a formality.

When the plan allows it: make CI's three jobs **required status checks** on
`main` and require a PR + 1 approval. Nothing else about the workflow changes.

---

## 2. Commit messages

Format: **`type(scope): description`**, with an optional milestone tag.

```
feat: audit logging for all mutations, append-only, tenant-scoped (M7)
fix(seed): create admin org membership so seeded admin can access routes
ci: add GitHub Actions pipeline — typecheck, lint, test, build (M8)
docs: finalize repository — README, CONTRIBUTING, development guide (M9)
test(db): per-request transaction rollback integration tests (M6 / MEDIUM-1)
```

- **Types**: `feat`, `fix`, `chore`, `docs`, `ci`, `test`, `refactor`, `perf`,
  `build`.
- **Scope** (optional): the area touched, e.g. `db`, `seed`, `api`, `web`.
- **Description**: imperative, lower-case, no trailing period; say *what* and
  *why*, not *how*.
- **Milestone tag** (optional): append `(M7)`, `(M9)`, etc. when the change
  belongs to a Phase 0 milestone or resolves a tracked issue (`(M6 / MEDIUM-1)`).
- Keep commits **focused** — don't bundle unrelated changes. Prefer several
  small commits over one large mixed one.

---

## 3. Before you push

Run the same gates CI runs. All must be green:

```bash
pnpm run typecheck                            # whole-repo type safety
pnpm --filter @workspace/api-server run test  # backend tests (no DB needed)
pnpm --filter @workspace/db run test          # DB tests: cross-tenant RLS isolation + rollback
pnpm run build                                # typecheck + build every workspace
```

The DB tests need a running Postgres with the non-owner `authenticated` role and
migrations applied — see [`docs/local-setup.md`](./docs/local-setup.md).

Additionally, when relevant:

- **Changed the API surface?** Edit `packages/api-spec/openapi.yaml` first, then
  `pnpm --filter @workspace/api-spec run codegen`, then implement. **Never**
  hand-edit generated files under `packages/api-zod` or `packages/api-client-react`.
- **Changed the schema?** Generate a **versioned migration**
  (`pnpm --filter @workspace/db run generate`) and commit it. Never use
  `drizzle-kit push` against tenant data.
- **Added a mutating endpoint?** It must be tenant-scoped (repository-only DB
  access), permission-gated (`requirePermission`), and audited
  (`auditService`). See the cookbook in the development guide.
- **Touched money, the GL, tax, or tenant isolation?** Add tests. These are
  non-negotiable areas.

---

## 4. Continuous Integration

`.github/workflows/ci.yml` runs on every pull request and every push to `main`,
in three jobs:

| Job         | What it does                                                                 |
| ----------- | --------------------------------------------------------------------------- |
| `typecheck` | `pnpm run typecheck` across the monorepo.                                    |
| `test`      | Spins up `postgres:16`, bootstraps the `authenticated` role, applies migrations, then runs the DB-free API tests **and** the DB-backed RLS-isolation + rollback tests. |
| `build`     | `pnpm run build` — production build of every app/package.                   |

These three are the checks intended to be **required** for merging into `main`
once branch protection is enabled.

---

## 5. Pull Requests

Use the template in
[`.github/PULL_REQUEST_TEMPLATE.md`](./.github/PULL_REQUEST_TEMPLATE.md) (GitHub
fills it in automatically when you open a PR). A good PR:

- has a clear title in the commit-message format above,
- describes **what** changed and **why**, and how you verified it,
- is small and focused on one concern,
- keeps docs (`CLAUDE.md`, `docs/`) in sync when behavior or architecture changes,
- has all CI checks green.

---

## 6. Reference

- [`CLAUDE.md`](./CLAUDE.md) — project overview, current state, and the rules
  (tenant scoping, layering, OpenAPI-first, "AI proposes, never posts").
- [`docs/development-guide.md`](./docs/development-guide.md) — layering, tenancy,
  RBAC, audit, and the "add a new domain" cookbook.
- [`docs/architecture-blueprint.md`](./docs/architecture-blueprint.md) — the
  target architecture.
- [`docs/phase-0-implementation-plan.md`](./docs/phase-0-implementation-plan.md)
  — the milestone plan.
