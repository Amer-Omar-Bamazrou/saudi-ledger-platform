# API test-suite order/timing sensitivities

> Moved out of `CLAUDE.md` at the restructure (2026-08-13). Read this
> before adding or debugging test suites — these fragilities only appear
> under full parallel load.

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
| 4 | **Platform-GLOBAL job paths driven from per-org suites cross fork boundaries.** Forks share ONE database but not one process (or one filesystem root), so any test driving a deliberately cross-tenant path — alarm evaluation, renewal reminders, the staged-leftover sweep — reads and writes OTHER suites' rows. Three faces observed in three consecutive full runs (2026-08-17): the alerting suite's `fired` counted a `pcsid-expiring` alarm raised by the renewal suite's synthetic expiry dates; a parallel promotion pass swept `capture-purge-integrity`'s backlog rows, "deleting" staged files under the WRONG storage root (missing = success) and nulling pointers whose bytes still existed — B3's exact disease, re-created by the test topology; and the alerting suite's "quiet platform" test made the whole DATABASE quiet with an unscoped `UPDATE einvoice_documents SET status='accepted'`, flipping parallel suites' freshly-approved `pending` rows mid-assertion (the einvoice-enqueue flake). | Suite growth — every added DB suite raises the collision probability, which is why the flake rate crept up milestone over milestone | The outbox worker's existing escape hatch, applied uniformly: every global job path takes an optional `organizationId` (global in production, scoped in tests) — `alarmsService.runOnce`, `renewalService.runOnce`/`listExpiring`, `sweepStagedLeftovers`/`listPromotedWithStagedCopy`, `listOverdue`. **Rule: a test may not run an unscoped read OR write against a shared table** — `alerting.test.ts:152` was the only unscoped write in the tree and it took three runs to catch it in the act. Count-sensitive assertions (`toHaveLength`, `toBe(1)`) against global listings are claims about the whole database, which no suite controls. |
| 5 | **The 5s default async test timeout sits inside the loaded-suite latency band.** A band of DB-backed async tests measures 1–3.6s under full parallel load (16 forks + JVM launches); the slowest — the invoice-approval suites, which sign and canonicalize XML between queries — intermittently crossed 5s and died. Deceptive twin: the 12–16s Java-shelling tests never failed because a SYNC-blocked event loop cannot be interrupted, so "the slow tests pass, the fast ones flake" — the flake selects for ASYNC tests near the ceiling, not slow tests. | Same suite growth; measured at 3.3s PASSING for the einvoice-enqueue fork test, i.e. one 1.5× load spike from death | `testTimeout: 30_000` in `vitest.config.ts`, mirroring the `hookTimeout` fix. A timeout is a harness bound, not an assertion — raising it weakens no property (unlike raising a rate limit, which deletes the thing under test). |

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

## Running the API suite and the browser suite at the same time (2026-09-01)

**Do not run both against one local database concurrently.** Playwright's
`webServer` starts the real API in dev mode, and that process runs the
in-process scheduler. On its tick the findings job wrote a `finding_runs` row
into EVERY organization present at that moment — including the API suite's
fixture orgs (`po-test`, `txn-to-ledger`) — so their `afterAll` cleanup failed on
the FK (`23503 … still referenced from table "finding_runs"`) and the files went
red for a reason unrelated to their subject. The rows survive the run, so the
NEXT solo run of those files fails too until they are deleted.

It is not a defect in either suite: CI runs them in separate jobs against
separate databases and never co-schedules them. It will bite whoever runs both
locally next. Symptoms: FK errors naming `finding_runs` in a test that never
mentions findings; a `/audit-trail` browser check rendering zero rows. Fix: run
them one after the other; if it already happened,
`DELETE FROM finding_runs WHERE organization_id IN (SELECT id FROM organizations WHERE slug IN ('po-test','txn-to-ledger'))`.
Same class as the global job paths above, one layer out — the job is scoped per
org, but it enumerates every org it can see.

## 🔴 `verify` fails at "api-server tests" when `DATABASE_URL` is UNSET — and it does not say so (2026-09-03)

With no `DATABASE_URL` exported, 73 of the 127 API test files SKIP and the run
still exits 1: `ai-provider.test.ts` dynamically imports
`src/scripts/benchmark/benchmarkCategorizer.ts` to reach its exported `parse`,
that module runs `main()` on import, `main()` cannot reach a database, and its
top-level `.catch` calls `process.exit(1)`. Vitest reports it as
**`Errors 1 error` with zero failing tests** — the exact shape §10b warns about:
`Tests 543 passed` while the run is red.

**It is an environment precondition, not a regression.** CI always sets
`DATABASE_URL`, which is why this is invisible there. Locally:

```bash
export DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:54322/postgres"
```

Two things worth fixing when someone is in the area, recorded so the diagnosis
is not re-derived: a script imported for one exported function should not run
its `main()` on import (guard it), and `verify` should CHECK its preconditions
and name a missing one rather than reporting the first step that trips over it.
