# Rate limiting — audit, threat model, policy and design

**Status (2026-10-05): built on branch `feat/rate-limiting`, not merged. Current
state authority: CLAUDE.md §2.** This is a standalone security hardening task,
not a roadmap phase.

Code: `apps/api/src/lib/rateLimit.ts` (the 429 contract, client identities,
pre-session limiters), `apps/api/src/lib/requestBudget.ts` (the authenticated
budget), `apps/api/src/lib/rateLimitStore.ts` (the shared Postgres counter,
C1), migration `0120`. Tests: `rate-limit-policy`, `rate-limit-budget`,
`rate-limit-login` (API), `src/lib/rateLimit.test.ts` (web),
`e2e/rate-limit.spec.ts` (browser).

---

## 1. What existed (the audit, 2026-10-05)

| Fact | Where |
| --- | --- |
| `express-rate-limit` 7.5.1 over a **shared Postgres store** (`rate_limit_hits`, one atomic upsert, fail-closed). No Redis, by decision (C1, 2026-08-20). | `lib/rateLimitStore.ts`, migration 0050 |
| `trust proxy` = `TRUST_PROXY_HOPS` (default 0: the socket address; `X-Forwarded-For` ignored). | `app.ts` |
| Five limiters, all **IP-keyed**: login + change-password 10/15 min; signup 5/h; user admin 60/15 min; invitations 20/15 min; onboarding upload 20/h. | `routes/auth.ts`, `invitations.ts`, `onboarding.ts` |
| 🔴 **Two of the five were still per-process** (`MemoryStore`): invitations and onboarding upload. C1 moved the three in `auth.ts` and recorded "all three limiters" — the sweep's frame was one file. | the same |
| 🔴 **IPv6 keyed by full address** — one subscriber holds a /64 or more, so every IPv6 client had an unlimited supply of buckets. | default `keyGenerator` |
| 🔴 **Nothing limited the authenticated surface** — ~50 business mounts, the PDF renderer, uploads, AI calls, the ZATCA OTP exchange, operator break-glass. | `routes/index.ts` |
| No per-account login limit: N addresses got 10·N guesses per quarter hour at one account. | `routes/auth.ts` |
| 429 bodies carried no code; the web app had no 429 handling (the server's English text was shown verbatim, also in Arabic). | `apps/web/src` |
| No sweep: expired counters were never deleted (0050 built the expiry index "for the periodic sweep"; none existed). Keys chosen by anonymous callers (IPs, typed emails) grow without bound. | migration 0050 |
| The counter table was LOGGED: every counted request would wait on a WAL fsync. | measured below |
| **No inbound webhooks** exist (no route receives a callback; `ALERT_WEBHOOK_URL` and ZATCA are outbound). | grep of `routes/` |
| **No self-service password reset** exists (the Login "forgot" tab is static text); break-glass is an operator HTTP route. | `Login.tsx`, `routes/operator.ts` |
| The tenant transaction is **lazy**: no connection is checked out, and no `BEGIN` runs, until a handler's first query. | `packages/db` `LazyTenantClient` |
| Idempotency is per service (a body `idempotencyKey`, a partial unique index per company), checked INSIDE the request's tenant transaction. | `payments.service.ts` and peers |
| Background jobs are an in-process scheduler; only three are reachable over HTTP, operator-only (F2). | `jobs/`, `lib/operatorJobs.ts` |

**Conclusion of the audit:** the existing architecture already provides the
right mechanism. A shared, atomic, fail-closed counter in the database every
request already depends on is exactly what distributed limiting needs. Nothing
here required Redis or another service.

## 2. Threat model

| Threat | Before | Now |
| --- | --- | --- |
| Brute force on one account from one machine | IP limit 10/15 min | unchanged |
| **Distributed brute force / credential stuffing on one account** | unbounded (10 per address) | **≤ 60 failed attempts per hour per account**, all addresses together |
| Credential stuffing across many accounts | IP limit | IP limit; IPv6 now keyed per /56 |
| **IPv6 address rotation** | a fresh bucket per address | one bucket per /56 |
| `X-Forwarded-For` spoofing | ignored at 0 hops | unchanged (C1's deployment check remains) |
| Account enumeration | login is timing-safe (decoy hash) | the account limit counts an email whether or not it exists; one 429 body for every limiter |
| Password-reset abuse | no self-service reset exists | break-glass (operator) limited to 10/hour per operator |
| Invitation-token guessing | 20/15 min per process | 20/15 min, **shared** |
| API scraping / flooding by a session | **unbounded** | per-user 300/10 s and 1,200/60 s |
| One tenant flooding (many accounts) | **unbounded** | per-organization 3,600/60 s (and per class) |
| Expensive reports / analytics | **unbounded** | 400/60 s per user, 1,200 per organization |
| PDF / export rendering (shared Chromium) | **unbounded** | 30/10 min per user, 90 per organization |
| Upload abuse (10 MB buffered in memory) | onboarding only, per process | 75/10 min per user, 225 per organization, all three upload routes |
| AI cost abuse (`/llm/compare` = up to 50 model calls) | **unbounded** | 20/10 min per user, 60 per organization |
| ZATCA OTP exchange (CSR + ~8 ZATCA calls per attempt) | **unbounded** | 10/hour per user and per organization |
| Bulk imports, categorize, recognition runs | **unbounded** | 120/10 min per user, 360 per organization |
| A privileged session (admin, operator) | — | **counted like any other**; no role is exempt |
| Webhook flooding | — | no inbound webhooks exist |
| Volumetric (L3/L4/L7) floods of cheap anonymous endpoints | none | **edge responsibility** (§9): a database counter on a request that costs nothing amplifies the flood |

## 3. Endpoint classification

| Class | Endpoints | Abuse risk |
| --- | --- | --- |
| A. Authentication | `POST /auth/login`, `/auth/change-password`, `/auth/signup`; `/invitations/:token` (+ `/accept`); user admin under `/auth` | guessing, stuffing, enumeration, unauthenticated writes |
| B. Authenticated API | every mount after `requireAuth` (~50) | scraping, flooding, noisy neighbour |
| C. Expensive reads | `/reports/*`, `/analytics/*`, `/finance-hub/*`, `/cash-position` (no date-range caps) | database load |
| C′. Exports | `/reports/export/*`, `/invoices/:id/document` (Chromium) | CPU, memory |
| D. Uploads | `POST /capture`, `PUT /companies/current/logo`, `POST /onboarding/documents` (multer, memory) | memory, storage |
| D′. AI | `POST /llm/categorize`, `/llm/compare`, `GET /llm/status`, `/llm/demo`, `POST /ask`, `POST /findings/run` | provider cost |
| E. Mutations | every POST/PUT/PATCH/DELETE; bulk: `/transactions/upload`, `/categorize`, `/recognition-schedules/runs`, migration imports/validate/commit/reverse; ZATCA onboarding/renew | write load, external calls |
| F. Webhooks | none exist | — |
| G. Internal | `/healthz` (static), `/deployment`; `/operator/*` (platform operators; three job runs, break-glass) | probe floods; privileged misuse |

## 4. The policy

### Measurement behind the numbers

Three CI runs of the full browser suite (2026-10-05; ~7,500 API requests each,
a robot driving the real UI faster than any person) were parsed from the API's
request log. Sliding-window peaks, **all users combined** (so an upper bound on
any one user):

| Class | peak / 1 s | / 10 s | / 60 s | / 10 min |
| --- | --- | --- | --- | --- |
| all authenticated | 53 | 99 | 389 | 2,538 |
| writes | 51 | 60 | 83 | 265 |
| report reads | 10 | 48 | 131 | 214 |
| exports | 4 | 4 | 6 | 6 |
| uploads | 8 | 15 | 23 | 25 |
| bulk | 4 | 8 | 13 | 24 |
| AI, ZATCA OTP | 0 | 0 | 0 | 0 |

**Rule:** each user limit is about **three times** that combined peak, more where
the peak was tiny, so no person using the product can meet it, while a script
is stopped within one window. Each organization limit is **three users' worth**.
AI and the OTP have no traffic to measure (the AI layer is dark), so theirs are
set by cost.

### The matrix

| Bucket | Key | Limit / window | Burst | Why this number |
| --- | --- | --- | --- | --- |
| login, change-password | IP (v4, or v6 /56) | 10 / 15 min | the window | unchanged (C1) |
| **login, change-password** | **account** (SHA-256 of the email, trimmed + case-folded) | **60 failed / 60 min**; a success is refunded | the window | one IP under 10/15 min can send at most 50 in any 60 minutes, so a single address can never lock an account out; caps distributed guessing at ~1,440/day |
| signup | IP | 5 / 60 min | — | unchanged |
| user admin | IP | 60 / 15 min | — | unchanged |
| invitations | IP | 20 / 15 min | — | unchanged number, now shared |
| onboarding upload | IP | 20 / 60 min | — | unchanged number, now shared |
| burst | user | 300 / 10 s | — | 3.0 × 99 |
| general | user · org | 1,200 / 60 s · 3,600 | 300 / 10 s | 3.1 × 389 |
| write | user · org | 300 / 60 s · 900 | general burst | 3.6 × 83 |
| report | user · org | 400 / 60 s · 1,200 | general burst | 3.1 × 131 |
| export | user · org | 30 / 10 min · 90 | the window | 5 × 6; one Chromium page each |
| upload | user · org | 75 / 10 min · 225 | the window | 3 × 25 |
| bulk | user · org | 120 / 10 min · 360 | the window | 5 × 24 |
| ai | user · org | 20 / 10 min · 60 | the window | cost: `/ask` = 3 calls, `/llm/compare` ≤ 50 |
| zatca_otp | user · org | 10 / 60 min | the window | ~9 ZATCA calls per attempt; a typo needs a retry, not dozens |
| break_glass | operator | 10 / 60 min | the window | issues a temporary password |

Fixed windows: a client may spend a whole window's budget at once, and up to
twice it across a window boundary — which is why the general budget has a
separate 10-second burst bucket.

**Response:** every limiter answers `429 { error, code: "rate_limited",
retryAfterSeconds }` with `Retry-After` equal to `retryAfterSeconds` (whole
seconds, rounded up, never 0) and the `RateLimit-Limit / -Remaining / -Reset /
-Policy` headers. When several buckets refuse, the wait is the **longest**.

**Failure:** **fail-closed** everywhere — `503 { code: "rate_limit_unavailable" }`.
The counter shares the database's fate; with the database down every route
fails anyway, and failing open would remove brute-force protection exactly when
nothing else is checking. `/healthz` is not limited, so a load balancer still
sees process health.

## 5. Architecture

- **Store:** the existing `rate_limit_hits` table. Now **UNLOGGED** (0120) —
  measured on the local stack, 500 iterations: logged ~3.0 ms per upsert,
  unlogged ~1.2 ms (round-trip floor ~0.9 ms), and no WAL. The cost: after a
  database crash or failover the counters restart from zero — acceptable for a
  value whose longest window is an hour.
- **One statement per request:** the budget counts all of a request's buckets
  (2 to 7) in one `INSERT … SELECT unnest … ON CONFLICT` — measured: three keys
  in one statement ~3.2 ms, three statements ~9.3 ms. Rows are written in key
  order, so concurrent statements cannot deadlock; each row's lock serialises
  concurrent hits, so N concurrent requests get N distinct counts.
- **Clock:** the time left in a window is computed on the database's clock, so
  skew between the app and the database cannot distort `Retry-After`.
- **Sweep:** job `rate-limit-sweep`, every 10 minutes, deletes expired rows in
  bounded batches (not operator-runnable).
- **Classification** is by normalized path (lower-cased, doubled and trailing
  slashes removed — the way Express routes), so `/API/Reports/x/` cannot reach a
  report on the general budget. `HEAD` is a `GET`.

### Where it runs — and accounting safety

```
requireAuth → [budget at /orgs, /onboarding, /operator]
            → resolveTenant (owner-pool reads; 403 for an unverified org)
            → requestBudget        ← one counter statement, owner pool
            → requirePermission → handler: validation → idempotency → tenant
              transaction (lazy BEGIN) → posting → COMMIT before the response
```

- A 429 is decided **before** validation, the idempotency lookup, the tenant
  transaction and any posting. Because the tenant connection is lazy, no
  `BEGIN` has run: **a refused request executed nothing** — no partial
  posting, no consumed ICV, no recorded idempotency key, no period-lock check.
  The client may retry with the same idempotency key and it runs exactly once
  (`rate-limit-budget.test.ts` proves it with a real payment and its journal).
- A request that **passes** is never interrupted: the limiter decides once,
  before the handler.
- The counter is written on the owner pool, outside the tenant transaction, so
  a request's rollback never un-counts it, and the limiter never holds a second
  connection while a tenant connection is checked out.
- Pre-session limiters run before their handlers the same way.

## 6. Distributed deployment

Every counter is in Postgres, so N instances enforce one limit (C1's
property, now true of all six pre-session limiters and the budget). Nothing
per-process remains. The test-only per-PID key namespace (C1) is unchanged.

## 7. Account enumeration

The account limit is keyed on the email **as typed** (trimmed, case-folded,
then SHA-256 — the counter table holds no email addresses, and no typed value
can make the counter write fail), whether or not an account exists, and refuses
with the same body as the IP limit. A refusal says nothing
about existence (`rate-limit-login.test.ts` compares the two refusals). Login's
existing timing defence (the decoy hash) is untouched: a limited request is
refused before any hashing.

## 8. The client

`apps/web/src/lib/rateLimit.ts` reads the 429 by its **code** from either client
and renders one sentence in the reader's language, with Arabic number agreement
("بعد ثانيتين", "بعد 5 ثوانٍ", "بعد 30 ثانية"). The login form, every form's
error, exports and uploads show it; refused page reads raise one toast per
burst; a 429 is never retried by React Query.

## 9. Observability

- `rate_limit.exceeded` (warn) — **once per key per window**, at the first
  refusal; `rate_limit.sustained` (error) — once more at ten times the limit.
  Fields: policy, dimension, limit, used, retryAfterSeconds, method, area
  (`/api/<mount>` only — never a token or an id); `userId`/`organizationId` for
  the budget; the IP key for IP limits; a 12-hex SHA-256 digest of the account
  key (never the email) for the account limit. No passwords, tokens or
  financial data.
- Every refusal is also a `429` in the access log.
- `rate_limit.store_failed` (error) on every store failure, and a critical
  page (`rate-limit-store-failed`) at most once per five minutes per process.
- `rate_limit.refund_failed` (warn): a refund that could not be written.

## 10. Remaining limitations and decisions

1. **Targeted lockout (decision for the owner).** A distributed attacker can
   keep one known account's logins refused while they keep failing at it (60
   failures/hour from ≥2 addresses). The standard remedy is a device cookie that
   exempts a browser which has logged in before — a change to authentication,
   out of scope here.
2. **Edge protection is a deployment item.** Volumetric floods of cheap,
   anonymous endpoints belong at the proxy/CDN/WAF; a database counter there
   would amplify the flood. Nothing is deployed yet (CLAUDE.md §5, deployment-time).
3. **`TRUST_PROXY_HOPS`** must still be confirmed in the real deployment (C1).
4. **Fixed windows** allow up to twice a budget across a boundary; the general
   budget's 10-second burst bucket bounds the worst case.
5. **No concurrency cap.** A rate limit bounds requests per window, not
   requests in flight; heavy reports still queue on the per-process pool (10).
6. **AI and OTP numbers are cost-set, not measured** — revisit when the AI
   layer is lit (Groq Enterprise, C6) and with R1's plan gating.
7. **The pending-organization 403 path** (inside `resolveTenant`, before the
   budget) is not counted; it costs one owner query, the same as a counter.
8. **Unclassified new endpoints** get the general and write budgets only; a new
   expensive endpoint must add a `CLASS_RULES` entry (the budget test requires
   an example for every rule).
9. **A request that falls through a pre-tenant mount** into the business chain
   is counted once, in its user buckets only (no organization bucket).

### Independent review (2026-10-05), and what it changed

A read-only security review of the change found no bypass, no partial-effect
path and no enumeration signal, and four smaller defects, all fixed before the
first commit: (1) a NUL byte in a typed email made the counter write fail —
read as a store outage, a 503 and a critical page that spent the alert
cooldown; the account key is now a SHA-256 digest; (2) the sweep's outer
DELETE did not re-check expiry and could deadlock against the counter — it now
re-checks and uses `SKIP LOCKED`; (3) the 503 `rate_limit_unavailable` showed
English text to Arabic readers — now localized by code; (4) a full-form
IPv4-mapped IPv6 address fell into the `::/56` bucket — now keyed as its IPv4
client.

## 11. Verification record (2026-10-05, local; CI is the authority)

- `pnpm run verify` — typecheck, API 228 files passed / 1 skipped (the storage-
  credentialed `documents` suite, skipped locally as before), DB 10/10, the
  live-ZATCA file, web 15/15, build: green. No pre-existing suite meets a
  production budget.
- New tests: `rate-limit-policy` (15), `rate-limit-budget` (15),
  `rate-limit-login` (10), web `lib/rateLimit` (6), browser
  `e2e/rate-limit.spec.ts` (5); with the route smoke crawl, RTL and banking
  specs, 118 browser tests green, and every 429 in that run was a planted one.
- **28 mutations, all killed** — 23 API (mount removed, keys collapsed, the
  organization bucket dropped, case/slash bypass, off-by-one, Retry-After from
  the window, the shorter of two waits, an admin exemption, fail-open, IPv6 by
  full address, a trusted `X-Forwarded-For`, unfolded and unhashed account
  keys, the login and change-password account limiters removed, no refund, a
  rejecting refund, limiters back in memory, no window reset, a sweep of live
  rows, a bare 500 on store failure, the operator mount unbudgeted), 2 web, 1
  database (`SET LOGGED`), 2 browser (login text unlocalized, no toast for
  refused reads). Each restored and verified by hash or definition.
- A fresh database migrated 0000→0120 holds `rate_limit_hits` identical to the
  tested one (UNLOGGED, columns, indexes, grants).
- Observed, not changed (outside rate limiting): the login handler answers 500
  for an email containing a NUL byte — its own lookup is refused by Postgres.
  The limiter counts the attempt either way.
