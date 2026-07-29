<!--
Title format: type(scope): description   e.g. "feat(invoices): add credit notes (M10)"
See CONTRIBUTING.md for conventions.
-->

## What & why

<!-- What does this change do, and why is it needed? Link any issue/milestone. -->

## How verified

<!-- How did you test this? Commands run, scenarios covered, screenshots if UI. -->

## Checklist

- [ ] `pnpm run typecheck` passes
- [ ] `pnpm --filter @workspace/api-server run test` passes
- [ ] `pnpm --filter @workspace/db run test` passes (cross-tenant RLS isolation + rollback)
- [ ] `pnpm run build` passes
- [ ] Change is **tenant-scoped** — all DB access is in repositories; no query bypasses the active org
- [ ] New/changed mutating endpoints are **permission-gated** (`requirePermission`) and **audited** (`auditService`)
- [ ] API surface changes went through `openapi.yaml` + `codegen` (no hand-edited generated files)
- [ ] Schema changes ship as a **versioned migration** (no `drizzle-kit push`)
- [ ] Tests added/updated for anything touching money, the GL, tax, or tenant isolation
- [ ] Docs (`CLAUDE.md`, `docs/`) updated if behavior or architecture changed
- [ ] Commits are focused and follow the `type(scope): description` convention

## Notes for reviewers

<!-- Anything reviewers should focus on, known limitations, follow-ups. -->
