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

