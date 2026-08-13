# Known issues, security-audit findings, and resolved-issue history

> Moved verbatim out of `CLAUDE.md` at the CLAUDE.md restructure
> (2026-08-13, post-M16.2). This is the historical record; the current
> operating summary lives in [`CLAUDE.md`](../../CLAUDE.md).

### Known Issues / Deferred (from the M4 security re-audit)

These were identified in the post-M4 security review and **intentionally deferred**
(not bugs to fix ad hoc — address them in the milestone noted):

- **[✅ RESOLVED in M11.6 — was a PRODUCTION BLOCKER] Invoices carried the ZATCA
  sandbox VAT number.** Issuance hardcoded `DEFAULT_SELLER_VAT = "300000000000003"`
  (the ZATCA sandbox placeholder) and `DEFAULT_SELLER_NAME = "KSA Ledger Company"`,
  **duplicated** across `invoices.service.ts` and `invoices.approvable.ts`, and
  never consulted the company — so every issued invoice carried a fake VAT number
  in its QR (tag 2) and hash. **Fixed:** seller identity now resolves from the
  active company through the single `services/sellerIdentity.ts` seam, with **no
  placeholder fallback** — issuance **fails closed** (400 `company_vat_missing`)
  if the tenant has no VAT number, so the blocker cannot be reintroduced.
  Proven by `tests/company-zatca-identity.test.ts`, which decodes the real QR and
  recomputes the real hash.
### Open findings from the M11 security audit (M11.5.1)

The CRITICAL and HIGH-1/M-2 were fixed in M11.5.1 (see above). These remain open,
with severity and location — address in the milestone noted, not ad hoc:

- **[HIGH-2 — verify at deployment] Signup/auth rate limiting may be bypassable.**
  `app.ts:21-23` sets `trust proxy` **only in production**; if any deployment lets
  a client-supplied `X-Forwarded-For` reach Express, the IP-keyed limiters become a
  no-op via header rotation. The stores are also **in-memory / single-instance**
  (`routes/auth.ts`, `routes/onboarding.ts`), so horizontal scaling silently
  multiplies every limit. **Before deploying:** confirm exactly one trusted proxy
  that overwrites `X-Forwarded-For`; **before scaling out:** move the limiters to
  a Redis store.
- **[MEDIUM — REVIEW BEFORE PRODUCTION, found in M12.1a] The app role holds
  `TRUNCATE` on every business table, and TRUNCATE BYPASSES RLS.** The
  `authenticated` role has `SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER,
  TRUNCATE` on `invoices`, `bills`, `customers` and every other business table —
  more than migration `0004` explicitly granted. The extras come from the
  **Supabase base setup's `ALTER DEFAULT PRIVILEGES`**, not from our migrations.
  This matters because **`TRUNCATE` is not subject to row-level security**: unlike
  `DELETE`, it is not filtered by the `tenant_isolation` policy, so a SQL-injection
  or compromised-app-role scenario could wipe **all tenants'** rows in a table,
  not just the active org's. **Pre-existing and platform-wide — NOT introduced by
  M12.1a** (`einvoice_documents` matches the existing tables exactly, so the new
  table added no exposure). **Fix before deployment:** `REVOKE TRUNCATE (and
  REFERENCES/TRIGGER) ON <each business table> FROM authenticated` in a migration,
  and re-check the hosted project's default privileges — they may differ from the
  local Supabase CLI stack where this was observed.
  **UPDATE (M12.5) — scope confirmed and PARTIALLY closed.** Measured against the
  live local stack: every newly created table receives **`REFERENCES, TRIGGER,
  TRUNCATE`** from the Supabase default privileges — including the *owner-only*
  identity tables, which were assumed to be granted nothing. `zatca_credentials`
  now **REVOKEs explicitly** (migration `0019`, guarded per role) and a test pins
  it, because destroying signing keys is unrecoverable. **The other five
  owner-only tables still hold `TRUNCATE`** and belong in the same pre-deployment
  migration as the business tables:
  `security_audit_logs`, `platform_operators`, `verification_reviews`,
  `verification_documents`, `organization_invitations`.
  Destructive-but-recoverable rather than catastrophic (they hold audit history,
  operator flags and invitations, not key material), but there is no reason to
  leave it. **Do not assume "owner-only" means "no grants" — verify with
  `information_schema.role_table_grants`.**

- **[✅ RESOLVED in M13] Invoice revenue was MISCLASSIFIED in the income
  statement.** Fixed by real chart-of-accounts resolution in the posting path:
  a seeded system chart, `system_code` resolution, fail-closed on unresolvable,
  a deterministic backfill, and balance-sheet AR/AP moved to the GL. Design and
  as-built notes: [`docs/feature-spec-chart-of-accounts.md`](../feature-spec-chart-of-accounts.md).
  User-facing note: [`docs/release-notes/m13-income-statement-classification.md`](../release-notes/m13-income-statement-classification.md).
  **Historical income statements changed** (revenue up, expenses up by the same,
  net profit identical) — a display defect corrected, not a restatement.
  **UX FOLLOW-UP (not a bug):** a bill's expense account is still free text
  (`debitAccount`), resolved by NAME against the tenant's chart with a
  `PURCHASES` fallback. Resolving by name is correct there — the user is naming
  their OWN account, unlike our hardcoded literals — but a **per-bill account
  picker over the real chart** would be better. That is a UX change, not a
  classification one.
  The ORIGINAL note, kept because it explains why the bug survived:
  🔴 The design found the problem is LARGER than recorded here: **`categories`
  contains zero rows and nothing ever creates any**, so there is no chart of
  accounts to resolve against; and naively setting `account_id` would
  **double-count AR on the balance sheet**, because AR is currently bolted on
  from the `invoices` table *and* the GL lines contribute nothing only because
  their type is unresolvable. Read the spec before touching the posting path. `postJournalEntry` writes
  `accountId: l.accountId ?? null` and the invoice path never supplies one, so
  **every invoice GL line has `account_id = NULL`**. The income statement then
  classifies by `const type = cat?.type ?? "expense"` (`reports.service.ts`), so
  the *Sales Revenue* credit line lands in **expenses** — as a negative expense —
  rather than in revenue.
  **Net profit is right; the statement's composition is not.** Revenue reads as
  zero and expenses are understated by the same amount. This affects **every
  invoice today**, predates M12.1b, and **credit notes inherit it**.
  Deliberately NOT fixed in M12.1b: the fix is real chart-of-accounts resolution
  in the posting path (mapping "Accounts Receivable"/"Sales Revenue"/"VAT
  Payable" to `categories` rows), which is money-touching work deserving its own
  milestone and its own tests — not a rider on a notes change. The same NULL
  `account_id` also makes these lines invisible to the balance sheet, which is
  why AR is computed from the `invoices` table instead of from the GL.
- **[LOW — CONFIRMED in M12.1b] `checkPeriodOpen` ignores `company_id`.** The
  query filters on `period` alone (`periodLock.ts`), though the uniqueness key is
  `(organization_id, company_id, period)` and RLS scopes only to the
  organization. **In a multi-company org, company A closing a period blocks
  company B's postings** — including credit notes correcting company B's
  invoices. Not a cross-tenant breach; scope the query by `company_id` when
  multi-company support is built out. Belongs in the pre-deployment queue.
- **[✅ CLOSED in M14 — M-1. STILL A LANDMINE, now with a build guard]
  `organizations`, `users` and `organization_memberships` are deliberately
  OUTSIDE RLS** (`0003_rls_policies.sql:20-22`) and granted plain `SELECT` to the
  app role (`0004_m4_rls_enforcement.sql:95-98`).

  **Read this before writing any business-layer query.** For every other business
  table, forgetting a tenant filter is survivable — RLS catches it. **On these
  three, nothing catches it.** A service that joins `organizationsTable` to put
  the org name on an invoice PDF returns EVERY organization's row: no error, no
  failing test, a silent cross-tenant leak written by ordinary-looking code.

  **The rule:** business-layer code (`services/`, `repositories/`) must not read
  these tables. The **identity layer is the only correct consumer** — it runs
  before `resolveTenant` on the owner connection and does its own explicit
  authorization (admin-of-THIS-org, platform operator, or the session user).
  Enforced by `tests/identity-table-boundary.test.ts`, which fails the build on
  the import and prints what to do instead.
  **If the business layer ever genuinely needs them, that is a DESIGN DECISION,
  not a lint exception** — do not add an allowlist entry to make the build green.

  **Why a guard and not RLS** (decided in M14; the queue listed both):
  1. **Policies there would be exercised by no traffic.** Every legitimate
     consumer runs on the owner/base connection, which BYPASSES RLS. An untested
     security control is its own risk, and this one would first be exercised by
     the exact mistake it exists to prevent — under production conditions rather
     than in CI.
  2. **`users` cannot take the standard policy.** No `organization_id`, so
     `tenant_isolation` does not apply; it would need a membership subquery,
     which is real design work on the login and user-administration paths,
     against a hypothetical.

  **Its limit, stated plainly:** the guard matches IMPORTS. A raw
  `pool.query("SELECT ... FROM users")` inside a service slips past — the same
  limitation `vault-boundary` has. It raises the cost of the mistake; it does not
  make it impossible.
- **[MEDIUM M-3] Signup email/slug check-then-insert race surfaces as a raw 500.**
  `signup.service.ts` checks `emailExists` before the transaction; the DB unique
  constraint correctly prevents duplicates (no half-provisioned tenant), but the
  Postgres `23505` carries no `statusCode`, so `errorHandler` returns 500 instead
  of the intended 409. Map `23505` → `ConflictError`.
- **[MEDIUM M-4] `bcryptjs` (pure-JS, cost 12) blocks the event loop on public
  endpoints** — a multi-tenant noisy-neighbour DoS vector; consider native
  `bcrypt` (thread-pool offload). Also **no max-length validation** on
  `name`/`organizationName`/`companyName` before `varchar(255)`, so oversized
  input is another raw 500 instead of a 400.
- **[MEDIUM M-5] Magic-byte sniffing is header-only** (`lib/fileValidation.ts`) —
  a valid-header PDF carrying `/JavaScript` or `/OpenAction` passes. Browser-side
  risk is closed (forced attachment + `nosniff`); residual risk is a human opening
  the file locally. Closes with the AV follow-up below — `documents.service.upload`
  is the seam.
- **[LOW L-1] Security-audit write failures are invisible.**
  `securityAudit.service.ts` records best-effort and, on failure, only
  `console.error`s — not the structured `pino` logger, and with no alerting. The
  best-effort design is correct (the mutation already committed), but an attacker
  who can reliably fail those inserts acts untraced. Route it through `logger` and
  alert on the pattern.
- **[LOW L-2] Signup's 409 leaks account existence** — asymmetric with
  `/auth/login`'s deliberate constant-time defense in the same file. Acceptable
  (common for signup) but should be documented inline as a conscious trade-off.
- **[LOW L-3] Non-deterministic "primary membership" tie-break** — `tenant.ts`
  and `onboarding.service.ts` order by `createdAt` only; add a secondary key
  (`id`) for determinism.
- **[DEFERRED — M11.6] `companies.fiscalYearStart` is stored but not applied.**
  Reports still assume calendar periods: the VAT return uses `period_from`/
  `period_to` params (with `1900-01-01`…`2099-12-31` fallbacks) and the Zakat base
  takes no date range at all, so a company with a non-January fiscal year gets
  calendar-year figures. Wiring it in is a **reporting** change (report period
  derivation + defaults), deliberately out of M11.6's onboarding scope. The
  Company Settings UI states the limitation to the user.
- **[LOW L-4] The operator queue list is unaudited** (detail views and document
  views ARE audited). Accepted trade-off — revisit if operator-activity forensics
  become a requirement.

- **[KNOWN CI GAP — M11.4] The storage path is NOT covered by CI.** The 9
  document tests (`apps/api/src/tests/documents.test.ts`) are gated on
  `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` and **skip in CI**, which runs a
  Postgres service but **no Supabase Storage service**. This is unlike the
  DB-backed tests, which DO run against CI's Postgres container. So **a green CI
  does not prove the storage path works** — upload/download/validation is proven
  **locally only**, and a future change breaking storage would not be caught by
  CI. Do not assume CI covers it. **Follow-up before deployment:** add a Storage
  service (or a stub/emulator) to `.github/workflows/ci.yml` and set those two env
  vars so the suite runs there.
- **[FOLLOW-UP before scaling — M11.4] No antivirus/malware scanning on uploaded
  documents.** Verification document upload (M11.4) validates type (magic-byte
  sniff), size, and filename, stores to a **private** bucket, and serves downloads
  as forced attachments (never inline) — but does **not** scan file contents for
  malware. Blast radius is bounded (only that org's members + platform operators
  can ever download, and nothing is executed or rendered), so it is acceptable for
  now, but **AV scanning (e.g. ClamAV or a scanning SaaS) must be added before
  scaling** / before untrusted-tenant growth. Wire it into `documents.service`
  upload (scan the buffer before `putObject`, reject on hit).
- **[HIGH — RESOLVED in M6] Per-request transaction held open for DB-less routes.**
  The tenant DB client is now acquired **lazily** on first query (`LazyTenantClient`
  in `packages/db/src/index.ts`), so DB-less routes (e.g. `/llm/*`) never check out
  a pooled connection. The session store runs on its own `sessionPool`, and each
  tenant transaction sets `idle_in_transaction_session_timeout='15s'`. Leak-safety
  preserved (SET LOCAL role + GUCs stay transaction-local).
- **[MEDIUM — RESOLVED in M6] Whole-request transaction rollback semantics.**
  Integration tests (`packages/db/src/__tests__/tx-rollback.test.ts`) prove a
  mid-request DB error (duplicate period lock) rolls the whole request back, the
  earlier write does not persist, the original constraint error surfaces (not a
  secondary "transaction aborted"), and the pooled connection is reusable.
- **[RESOLVED in M6] `sql.raw` id-lists + session-table bootstrap.** The reports
  `sql.raw(ids.join(","))` id-lists are now `inArray(...)`; the `user_sessions`
  table is provisioned by migration `0005` (`createTableIfMissing:false`), fixing
  the esbuild-bundle login-500 gap.
- **[MEDIUM — RESOLVED in M7] `audit_logs` grants UPDATE/DELETE to the app role.**
  Migration `0006_audit_append_only.sql` **revokes UPDATE/DELETE** on `audit_logs`
  from the `authenticated` role (INSERT + SELECT only), making the audit trail
  tamper-resistant. Proven by `packages/db/src/__tests__/audit-logs.test.ts`
  (the app role's UPDATE/DELETE are denied; INSERT/SELECT still work).
- **[DEFERRED] Separate security-audit log for identity/session events.** The M7
  business-audit trail is tenant-scoped (`audit_logs.organization_id` is NOT NULL),
  so **global identity/session events are intentionally NOT captured**: user
  register / password reset / role & membership change (`/auth/*`) and org switch
  (`/orgs`). These security events need a **separate security-audit log** (not
  org-scoped, actor-centric) in a later phase — do not shoehorn them into
  `audit_logs`.
- **[LOW] `period_locks` routes scope by `period` alone, not `company_id`.**
  RLS confines results to the active organization, but the uniqueness key is
  `(organization_id, company_id, period)`, so a multi-company org has
  cross-company visibility within the tenant (not a cross-tenant breach).
  **Fix:** scope period-lock queries by `company_id` when multi-company support
  is built out.
- **[FEATURE] Fine-grained, action-level permissions for separation-of-duties.**
  M5 authorization is method-based (one action per HTTP verb per resource), so it
  cannot distinguish sensitive state transitions from ordinary writes — e.g.
  posting a journal entry to the GL (`POST /journal-entries/:id/post`), reversing
  an entry, approving payroll (`POST /payroll/:id/approve`), and paying a bill
  (`POST /bills/:id/pay`) all resolve to `create` and are allowed to accountants
  (the industry-standard default). A later **advanced-tier** phase should add
  optional separation-of-duties controls: make post-to-GL, payroll approval, and
  bill payment **individually gateable to admin**, and support a "clerk enters /
  approver pays" split for AP. This needs **action-level** (per-endpoint)
  permissions rather than method-level, and is out of the M5 3-role scope.
- **[FEATURE] Draft/approval workflow + 4-role model — `do not implement before M6`.**
  Approved-but-deferred feature: a universal draft/approval workflow across all
  financial records (journal entries, invoices, bills, payments, payroll), backed
  by a 4-role model that adds a **Bookkeeper** (creates drafts only, cannot
  approve). Every financial record is created as a draft that does **not** affect
  the accounts (GL, balances, reports, VAT/Zakat) until approved; reports/GL must
  filter to APPROVED only. Generalizes the existing journal-entry draft→posted
  pattern. Must be built in the **M6 service layer**, not current route handlers —
  so it is gated on M6 and targets a **new milestone after M6**. Full design:
  [`docs/feature-spec-draft-approval-workflow.md`](../feature-spec-draft-approval-workflow.md).

