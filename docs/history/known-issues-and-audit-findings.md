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


---

# Appendix (moved 2026-08-28): the flow audit's nine findings, all closed

> Moved out of `CLAUDE.md` §5 in the commit that closed them (eviction rule 1).
> Every finding below is FIXED and verified; the guard that now covers the class
> is `apps/api/src/tests/state-machine-reachability.test.ts` (P4).
>
> **Status (2026-08-28): closed.** Current state authority: `CLAUDE.md` §2.

### 🔴 AUDIT 2026-08-28 — the remaining flows (capture, findings, quotations, POs, closed months, permissions, Arabic)

Read as a B-1 sweep: for every flow, does a real user reach a working surface,
and does the surface say something true? Method — each page's hand-written
`apiFetch<T>` compared against the service that answers it; every mounted route
in the flow grepped for a caller **by verb, not prefix**; derived fields traced
back to whether the endpoint loads what derives them. Nothing here is fixed;
these are for triage.

| # | Sev | Finding | Why nothing caught it |
| --- | --- | --- | --- |
| **AUD-1** | **HIGH** | **Credit and debit notes bypass the C12 invoice-number allocator.** `CreditNotes.tsx` mints `CN-{last 6 digits of Date.now()}` in the browser and always sends it; `invoicesService.create` allocates from the per-company counter **only when the number is blank**. So the platform runs a SECOND number series alongside `INV-YYYY-NNNNNN` — which is what Resolution §2 lists as a Prohibited Functionality (one sequence per unit, spanning invoices AND notes), and the exact thing C12 verified against the primary text. The suffix wraps every ~16.7 minutes, so two notes an exact multiple apart collide on `UNIQUE(company_id, invoice_number)`. (`Bills.tsx` mints `BILL-######` the same way — no ZATCA rule, same collision shape.) | C12 fixed the ALLOCATOR and removed the browser mint **from `Invoices.tsx`**. Nothing checked the sibling page that creates the sibling document — "green fixes the case, not the class", at the scale of a compliance ruling. The caller-supplied-number escape hatch (kept for legacy imports) is what lets it through. |
| **AUD-2** | **HIGH** | **Recurring INVOICE rules are broken from the second generation.** "Make recurring" on `Invoices.tsx` stores `invoiceNumber: "REC-<original number>"` in the rule template; `generation.service` spreads the template into `invoicesService.create`, so every run reuses one literal number. Run 1 succeeds; run 2 violates `UNIQUE(company_id, invoice_number)` and the rule fails — permanently, every month, for a feature whose entire point is running unattended. | Every rule in `recurring.test.ts` generates **exactly once**, with a fixture-unique number, and is retired afterwards. The suite proves "generation works", never "a monthly rule works monthly" — the narrower-claim family. |
| **AUD-3** | **MED** | **The quotation and PO LISTS report a conversion state derived from data the list never loads.** `buildQuotationOut` computes `conversionState(itemsOut ?? [])`, and the list passes no items — so `conversionState([])` returns `"open"` for every row, including fully converted ones. The list then offers **Convert to invoice** on them (`conversionState !== "converted"`). Same for `billingState` on purchase orders. Measured: `detail=converted list=open`. | The presenter's comment reasons carefully about a quotation *with no lines* and never about a *caller that passes no lines* — a composition edge. And the existing test asserts the state through `getById`, where items ARE loaded: the derivation is proven exactly where the defect isn't. Absence rendered as a definite state — the `(lines ?? [])` shape that made the GL list show SAR 0.00. |
| **AUD-4** | **MED** | **Quotations and purchase orders cannot be edited from the product.** `PATCH /quotations/:id` and `PATCH /purchase-orders/:id` have no caller anywhere in `apps/web` (no `apiFetch` PATCH, no generated hook). All of M21.2's edit machinery — reconcile-by-id so a converted line keeps its identity, both freeze-rule guards — is unreachable. A typo is fixable only by delete-and-retype, and only while the document is deletable. | The route-reachability guard matches the **prefix**, and `/quotations` is referenced many times. Identical to the bill-edit defect found in the QA audit; the guard still cannot see a verb. |
| **AUD-5** | **MED** | **`POST /capture/:id/discard` has no caller.** B3 built immediate image deletion specifically so a discard would not leave bytes staged for 30 days, and returns `imageDeleted` to prove it happened. Nothing calls it: a user who photographs the wrong document — a personal ID, someone else's invoice — cannot remove it. | Prefix again (`/capture` is referenced). Carries a PDPL edge, so it belongs beside **C8**: the erasure path we built is the one nobody can reach. |
| **AUD-6** | **MED** | **A submitted quotation or PO can be approved but never refused.** `send-back` and `reject` have no callers for either entity, and `Approvals.tsx` handles only journal entries, bills, invoices and payroll — quotations and POs are not in its `EntityKey`. So a bookkeeper's submitted quotation can only go forward. | The worklist was built at M10.6 and the entity list was never revisited when M21 added two approvable entities. A shape without a consumer, on the half of the workflow nobody demos. |
| **AUD-7** | **LOW** | **The UI offers what the API refuses.** Findings' Acknowledge is approver-only at the API and shown to every role; the same for Approve on quotations and POs. Since B2 the refusal is at least visible as a toast — before it was silent. | D4's rule was written one way round ("the UI must not secretly forbid what the API allows"). The converse was never stated, so nothing checks it. `ClosedMonths` is the only audited page that gates on role. |
| **AUD-8** | **LOW** | **Two surfaces are English-only.** `ScanReview` has 15 i18n calls against 65 on comparable pages, with bare literals including the JE preview's account names ("Input VAT Receivable", "Accounts Payable"); `Approvals.tsx` has no i18n at all and uses `window.prompt` for the send-back reason. Arabic is a stated LAUNCH requirement. | No test renders a page, and no check counts translation coverage. Both pages were shipped as "deliberately minimal" and never revisited. |
| **AUD-9** | **LOW** | **`Array.isArray(data) ? data : []` in `Approvals.tsx`** — a defensive fallback that would render "Nothing pending" rather than fail if any of the four list shapes changed. All four return arrays today, so it is latent. | The `.catch(() => [])` family from B-1: defensive-looking code that converts a contract break into a confident empty answer. |

**🔴 OWNER-REPORTED, mechanism NOT reproducible from source — needs the
observation before it can be triaged** (full record and evidence tables in the
findings file):

| # | Reported | What was checked |
| --- | --- | --- |
| **B-7** | **M21 is entirely unreachable** — quotations and POs can be created but not approved, and conversion requires approval, so the milestone cannot be used at all. | Every link reading can reach says otherwise: both pages are routed (`App.tsx:182/189`) and in the nav (`Layout.tsx:44/53`); the Approve button renders on `status === "submitted"` and posts to a route that exists; `quotations.approve` is granted to `["admin","accountant"]` in `PERMISSION_MATRIX`, seeded, and pinned by `quotations.test.ts:384`; and `quotation-conversion.test.ts` drives create → approve → convert against real rows. 🔴 If it was seen in a BROWSER that evidence outranks all of it — and would be the strongest case yet for the countermeasure. **The question that resolves it: a missing button, a button that did nothing, an error toast, or a blank page?** |
| **B-8** | **The RTL work is defeated by the router** — `<html dir>` reverts to the static document's value. | `applyLang` is the ONLY writer of `documentElement.dir`/`.lang` in the client; the other 11 `dir=` uses are per-field Arabic inputs below the app root; React does not own `<html>`. `index.html` ships `lang="en"` and no `dir`, so first paint IS LTR until the effect runs. The lesson is recorded in §3 regardless — it generalises past this fix. |

**Verified CLEAN in this pass, worth knowing:** capture's POST/GET response shapes
match what `Bills.tsx` and `ScanReview.tsx` declare (including `captureId`, and a
storage failure is reported honestly rather than silently losing the photograph);
findings' page/status shapes match the server exactly; period-locks' three routes
all have callers and the page's type matches; the four approval list endpoints all
return arrays as the dispatcher assumes; F1's confinement is enforced inside
`membersService.assign`, so the member-add UI cannot graft a stranger's account;
and no `Map.set` in any money path overwrites on collision — every one either
accumulates, pushes into an array, or is keyed on a row id.


---

# Appendix (moved 2026-08-28): the CLOSED pre-production queue items

> `CLAUDE.md` §5 is the list of what must close before a real taxpayer is
> onboarded. It should hold OPEN items only. These closed with their full
> as-built record; they are kept here so the reasoning survives eviction.
>
> Moved verbatim from `CLAUDE.md` on 2026-08-28.

## 5. Pre-production queue (the single list)

Everything that must close before a real taxpayer is onboarded. Nothing here
blocks ordinary platform work.

**A. ✅ CLOSED IN M14 — grants and configuration:**

| # | Item | Outcome |
| --- | --- | --- |
| A1/A2 | `REVOKE TRUNCATE/REFERENCES/TRIGGER` from the app roles | ✅ Done — **35 tables**, plus `ALTER DEFAULT PRIVILEGES` narrowed so the next `CREATE TABLE` cannot silently re-grant; guarded by a throwaway-table test. |
| A3 | Guard on `organizations`/`users`/`organization_memberships` | ✅ **Build guard** (`tests/identity-table-boundary.test.ts`); RLS rejected — policies there would be exercised by no traffic (all legitimate consumers bypass RLS on the owner connection). |
| A4 | Period locks ignored `company_id` | ✅ Posting path (M13) + routes (M14). The route bug was the serious one: one company's unlock **deleted every other company's lock**, silently reopening closed books. |

**B. ✅ ALL CLOSED (2026-08-14 / 2026-08-16) — the three failures that were SILENT.**
Each failed by quiet neglect rather than loud rejection: a reminder delivered to
nobody, an outbox nobody was watching, and a deletion that reported success
without happening. 🔴 **Deployment steps remain** for B1 and B2 (pick a mail
provider, point the webhook somewhere real) — the code is done, the wiring is
not, and an unwired alarm is the thing B2 exists to prevent.

| # | Item | Outcome |
| --- | --- | --- |
| **B1** | ✅ **CLOSED (2026-08-14) — email delivery is real.** `lib/mailer.ts` ships dependency-free REST implementations for **Resend** and **Postmark**, chosen by `MAIL_PROVIDER` + `MAIL_API_KEY` + `MAIL_FROM`; a send never throws (callers have already committed state) and reports `delivered` truthfully. **`loadEnv` refuses to boot production with `MAIL_PROVIDER=none`** — the `local-dev` key-wrapper posture, because a silently-inert alarm is invisible until the thing it guarded has happened. **AWS SES deliberately not implemented** (SigV4 or the SDK — a deployment-time addition like `@aws-sdk/client-kms`); add it there if the per-email cost matters at volume.<br><br>🔴 **The entry was wrong about the work:** "implement `send`; nothing else changes" missed that the renewal reminder had **no recipient** — it addressed `zatca-admin+<companyId>@invalid.local`, a placeholder that can never receive mail. A working provider behind that would have reached nobody. Recipients are now the organization's **active admins**, resolved via `membersRepository.activeAdminEmails` (identity layer — those tables are outside RLS), excluding removed admins and non-admins; a company with no resolvable admin is **logged as in-app only**, not silently skipped. | Was: the renewal reminder's entire value is lead time for an action only the tenant can take (fresh CSR + an OTP from THEIR Fatoora portal). Invitations also stop depending on an admin copying a link out of band. **Remaining deployment step:** pick a provider, verify a sending domain, set the three env vars. |
| **B2** | ✅ **CLOSED (2026-08-14) — something pages a human.** `lib/alerter.ts` (generic JSON webhook — one implementation reaches PagerDuty, Opsgenie and Slack, so the vendor stays a deployment choice) + `services/alerting/alarms.service.ts`, registered as the **platform** job `platform-alarms` (5-minute evaluation, always scheduled — it transmits nothing to ZATCA, it watches whether we are failing to). Two alarms: **outbox-overdue**, keyed off the OLDEST document's age and escalating to `critical` at 12h against the 24-hour deadline; **pcsid-expiring**, firing inside the final (T-7) window and staying `critical` after expiry. `ALERT_PROVIDER` + `ALERT_WEBHOOK_URL` + `ALERT_REPEAT_HOURS`; **`none` refused in production** like B1's mailer.<br><br>Dedupe is a **row, not a timer** (`alert_state`, migration 0035, owner-only with the grants revoked): one row per CONDITION, re-pages at most every `ALERT_REPEAT_HOURS`, survives restarts and concurrent instances (a single conditional UPSERT decides fire-vs-suppress), and a cleared condition **deletes the row and sends a RESOLVE** — a channel that never says "clear" gets muted, which ends where not alerting began. A webhook outage is logged and never breaks the job that detected the problem. | Was: both failures are quiet neglect, not loud rejection, and a panel only helps someone already looking. **Remaining deployment step:** point `ALERT_WEBHOOK_URL` at a real destination and confirm one test page arrives. |
| **B3** | ✅ **CLOSED (2026-08-16) — the bug half. The legal half was never B3's; it is C8.** The finding was two questions wearing one label, and the label said BLOCKING-on-an-advisor for a plain bug in a live path.<br><br>**What was wrong:** `stagingStore.remove` deleted files on `local-fs` and **returned silently on every other backend** — so `purgeOnce` deleted the metadata row regardless, and on cloud the bytes were orphaned **and the only index to them destroyed**. The same shape ran through promotion, where `markPromoted` nulled `staging_path` in the statement that recorded the archive copy. 🔴 All of it was invisible in a local-fs test run, because local-fs was the one backend that worked.<br><br>**Fixed as the entry itself prescribed:** a **separate `StagingBackend` contract** (`stagingBackend.ts`) with a real `supabase-storage` delete — `ArchiveStore` still has no `delete` and a test asserts it never gains one. Purge now deletes **bytes before row** and **keeps the row when the bytes survive** (`retained` count, logged at error). `markPromoted` leaves `staging_path` set until the staged copy is confirmed gone, so *a promoted row carrying a staging path IS the backlog* — enumerable, retryable, drained by `sweepStagedLeftovers` on every promotion pass. `POST /capture/:id/discard` now **deletes the image immediately** (not up to 30 days later) and returns `imageDeleted`, because reporting a deletion that did not happen was half the defect.<br><br>🔴 **The regression tests were verified to FAIL against the old code** — the previous ordering was re-injected and 6 of 10 went red. A no-op that reports success is worse than an unimplemented method that throws: the second is a gap, the first is a false statement the caller builds on. | **The remaining question is C8's, not this one.** Whether a PROMOTED inbound capture may ever be erased is a legal question about a store that by design cannot delete — it does not gate the staging mechanism, which now does what it was built for. C7/C8 keep the cross-reference; B3 no longer blocks on an advisor. |

**B-NEW. 🔴 TIME-SENSITIVE — data is being destroyed as it accrues:**

| # | Item | Why it cannot wait |
| --- | --- | --- |
| **B4** | ✅ **CLOSED (2026-08-17, PR #54/#55) — every payment keeps its date.** `invoice_payments` / `bill_payments`: one dated row per payment, written by the existing pay paths in the same tenant transaction (a record beside the posting, never a second posting path; settlements route through pay and get rows too). **Append-only at the grants** (SELECT + INSERT — the record of when money arrived is exactly the row someone would want to quietly fix), asserted against `role_table_grants`. Reader: the Record Payment dialogs show the dated history (`GET /invoices/:id/payments` + bills twin). Live pass: two payments (Aug 5, Aug 17) → two rows, both dates preserved.<br><br>🔴 **The backfill is honest about what was NOT recoverable:** pre-B4 documents got ONE row flagged `backfilled = true` — an AGGREGATE carrying only the LAST payment's date; the instalment split is gone forever. **Any consumer that would be wrong on aggregates — DSO, collection-speed, instalment analytics — MUST filter `backfilled = false`** (recorded on the schema, the repository, and design-analytics §6.1). Deployment note: CI caught that the serial ids' SEQUENCES need explicit `USAGE` on plain Postgres (0047) — local Supabase's default privileges had masked it. | Was: the expiring fact — a second partial payment permanently destroyed the first one's date. What it unblocks: the overdue share over time, DSO and collection-speed trends (backfilled-filtered), and "when was this actually paid". |
| **B5** | ✅ **CLOSED (2026-08-16) — a transfer can now say where the money went, and the loss has stopped.** `transfer_direction` (`own_account | external`, **NULL = not declared**, no default — the M17.1 posture in a third place) + optional `counterparty_bank_account_id` (migration 0043, four DB CHECKs at the write boundary, tested by violation). Declared on the Transactions list — the only moment anyone knows. The cash reconciliation now splits transfers **three ways** (own-account = the ledger is right; external = the ledger is understating cash; undeclared = the platform will not guess) and surfaces `undeclaredTransfers` as its own number with an ASK, because an undeclared transfer is a question only the tenant can answer. | Was: the expiring fact. Rows recorded before 0043 stay NULL forever — that loss already happened and is not recoverable; what stopped is the accrual. ✅ **Option A is BUILT (2026-08-17)** on the declared data — see the M19.7 → A row in §2. |

**R. 🔴 REVENUE — the billing gap (owner-queued 2026-08-24, its own item by
instruction):**

| # | Item | The consequence, stated plainly |
| --- | --- | --- |
| **R1** | **The platform cannot take money.** No subscription, no billing, no plan gating exists anywhere — AI usage is metered per tenant (`ai_usage`), but no mechanism turns a tenant into a PAYING tenant. | **No billing means no revenue, whatever else works.** This is the last MECHANICAL requirement between a working product and income — not a feature gap. Undesigned: provider (Stripe-class vs Saudi PSP), plan shape, what gating (if any) a plan implies. For customer #1 an off-platform invoice suffices; it stops sufficing quickly. |

**C. Verification and coverage gaps:**

| # | Item | Where recorded |
| --- | --- | --- |
| C1 | ✅ **CODE HALF CLOSED (2026-08-20); one DEPLOYMENT-TIME check remains.** (a) **Shared store built in Postgres, not Redis** — `lib/rateLimitStore.ts` implements express-rate-limit's `Store` over the existing pool (migration 0050, owner-only table, no `organization_id` because rate limiting runs BEFORE tenant resolution). No new service, no new failure domain; fail-CLOSED if the query errors. All three limiters (auth/signup/user-admin) now share it, namespaced. Tested by building TWO store instances and proving one sees the other's hit — the property MemoryStore could not give, and an assertion that would pass vacuously against a single store. (b) **`trust proxy` is now an explicit `TRUST_PROXY_HOPS` env fact, not inferred from `NODE_ENV`** — the old gate was wrong in BOTH directions (a "staging" deploy ran without it, collapsing every IP-keyed limit onto the proxy's address and shipping the session cookie without `Secure`; a proxy-less production deploy would trust a forgeable header). `SESSION_COOKIE_SECURE` likewise explicit, and `loadEnv` REFUSES a production boot with it false. 🔴 **Still open, and only verifiable in the real deployment: confirm exactly `TRUST_PROXY_HOPS` proxies actually rewrite `X-Forwarded-For`** — a wrong number is a spoofable limiter either way. | M11 audit + finding S3; audit 2026-08-20 |
| C2 | ✅ **CLOSED (2026-08-20).** CI now runs `supabase/storage-api` and sets `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`, so the M11.4 document suite RUNS instead of skipping. 🔴 **Two things the first red run taught, both worth keeping:** (1) it is started by a **STEP, not a `services:` entry** — a service container starts BEFORE the first step, so it hit Postgres before the roles its own migrations `REVOKE ... FROM anon, authenticated` existed and died with `role "anon" does not exist`; **nothing a later step does can be early enough**, so the ordering had to change, not the timing. (2) A **path-rewriting proxy** sits in front, because `lib/storage.ts` addresses `/storage/v1/object/...` — the path **Kong** exposes in a real Supabase stack — while a bare storage-api serves those routes at the root. Rewriting in CI keeps the suite exercising the URLs production uses; changing the lib to suit CI would have made the test prove the wrong thing. The health wait **fails loudly and dumps the container log** rather than letting a dead container degrade into "suite skipped, CI green" — which is the exact gap C2 exists to close — the suite gates on the presence of those vars, so supplying them is what turns it on. Same reasoning the ZATCA-SDK step already carried in this file: a green CI that skips its highest-consequence suite proves nothing. The container speaks the same REST surface `lib/storage.ts` targets, so the code under test is the real client. | Known CI gap |
| C3 | **KMS deployment verification** — IAM/key policy, 30-day deletion window, break-glass-only `kms:ScheduleKeyDeletion`, CloudTrail alarm on deletion attempts, multi-region CMK replica. If the CMK dies, every tenant must re-onboard. | [`docs/history/phase-2-zatca-m12.md`](../history/phase-2-zatca-m12.md) |
| C4 | ✅ **CODE HALF CLOSED (2026-08-20); deployment remains.** `lib/malwareScanner.ts` — a provider-agnostic seam (the `KeyWrapper`/`ArchiveStore` hedge) with a dependency-free clamd INSTREAM implementation, wired into BOTH user-file paths right after the magic-byte sniff and before any bytes reach storage: `documents.service.upload` AND `capture.service.capture` (phone captures are the higher-volume untrusted input). 🔴 **The B3 rule is the design**: `scan()` returns `clean`/`infected` or THROWS — an unparseable reply, a timeout and a socket error are all `ScanUnavailable`, never a silent "clean". `SCAN_UNAVAILABLE_POLICY` makes fail-open-vs-closed an explicit config choice (`allow` today, and an unscanned stored file is logged at WARN so it is findable; `refuse` = 503 once untrusted tenants exist). Tests inject a DOWN scanner — the branch nobody writes — and caught a real defect in the gate (configuration was consulted before the injected scanner, which would have made every injection test vacuous). **Remaining: deploy a clamd sidecar and set `MALWARE_SCANNER=clamd`**; M-5's header-only sniff closes with it. | M11.4 follow-up |
| C5 | ✅ **CLOSED (2026-08-20).** Checked first, then fixed the half that was actually broken: **document ASSEMBLY was already diagnosable** (the assembler throws `BusinessRuleError` 400s with codes — `note_reason_missing`, `amount_not_finite`, …). The gap was **SIGNING**: `SigningError` carries a deliberately fixed, non-leaking message ("ZATCA signing is unavailable for this company") — right for secrecy, useless for action, and it reached the user as an opaque 500 naming no invoice. `invoices.approvable` now wraps the enqueue: a **422 `einvoice_issuance_blocked`** carrying the invoiceId, companyId, the underlying reason, and a `likelyCause` of `signing_unavailable` vs `invoice_data_incomplete` — the two families a user acts on differently — plus a server-side ERROR log. 🔴 The fail-closed POSTURE is unchanged (an ICV gap is unrecoverable; a refused issuance is not), and the test proves both halves: the diagnosis AND that nothing was issued (no ICV consumed, no chain position, no GL entry) — a helpful message that left a half-issued invoice would be the worse bug. | M12.8 decision |
| C6 | **Data residency / hosting region — now ALSO the AI hosting decision (2026-08-18).** ZATCA permits cloud (the "must be in KSA" claim was a secondary-source error); NCA / sector rules are **unverified legal questions**. Choose host, KMS region, **and AI hosting together** — AI hosting ✅ **decided-pending-Enterprise-terms (2026-08-18): Groq, Reading A, Dammam** (design-ai-layer §12a; seam keeps it reversible). 🔴 The C6 work this leaves: (1) negotiate + sign the **Groq Enterprise agreement** (Dammam pinning + contractual ZDR) — **BLOCKING before any tenant data reaches Groq**; (2) confirm an Arabic-acceptable vision model in the Dammam region (the §2a Arabic gate decides on measured numbers); (3) the platform-hosting half (region + KMS) unchanged. No hosted Supabase project exists yet — this is a deployment decision, not a migration. | Residency correction, phase-2 history + [`design-ai-layer.md`](../product/design-ai-layer.md) |
| C7 | **TAX ADVICE — retention of INBOUND supplier documents.** A1 retains captures to the 6/11-year outbound standard as a conservative default, not a settled reading. **Answer together with C8 AND the Zakat questions — one package: [`docs/product/advisor-questions.md`](../product/advisor-questions.md), Block A.**<br><br>**Sharpened 2026-08-14 (audit):** `retain_until` now has a real production writer (set at promotion, `capture.service.ts:166-173`) — and **still no reader: nothing expires, enforces, or refuses deletion based on it** (the purge job selects on `status` + `captured_at` only, `capturedDocuments.repository.ts:109-118`, and never sees promoted rows). So the "conservative default" is a **stored intention, not a retention policy**. Two consequences for the advice: (a) whatever duration comes back, an ENFORCER has to be built — the value is decorative today; (b) 🔴 **an answer SHORTER than the outbound standard is currently not implementable at all**, because promoted captures live in a store with no delete. Ask the advisor for the duration AND whether inbound evidence may be destroyed on schedule; if it may, that is a B3-shaped build, not a config change. | A1 (Q4) |
| C9 | ✅ **SUBSTANTIALLY CLOSED (2026-08-19) — verified against the PRIMARY SOURCE** (the official ZATCA VAT Implementing Regulations PDF, read page by page; per-article citations in [`docs/tax/vat-treatment-verification.md`](../tax/vat-treatment-verification.md)). **17 treatments verified** (migration 0048), incl. both owner priorities: (1) `FOOD_MEALS` — the predicted defect CONFIRMED as a live wrong default: Art. 50(1)(a)-(b) blocks meals/entertainment input VAT, and the engine was counting it as recoverable (SAR 94.34 live on the dev org). Fixed via 🔴 **`input_vat_blocked` — a deliberate THIRD axis** (recoverability ≠ treatment ≠ basis; reasoning recorded on the column) — excluded from the recoverable estimate, returned as a named `vatBlocked` figure, never silently dropped. (2) Reverse charge — Art. 47(1) verified verbatim; the `vat_basis` mechanism is the correct implementation. **Still open, each with what-would-settle-it recorded in the doc:** the foreign-supplier list (needs actual invoices — safe error direction), LOANS/INVESTMENT_INCOME mixes (advisor), RENTAL_INCOME/TRAVEL (product granularity, not law), and the GCC-Agreement trio → C11. | [`docs/tax/vat-treatment-verification.md`](../tax/vat-treatment-verification.md) |
| **C12** | ✅ **CLOSED (2026-08-21) — verified against the PRIMARY TEXT, then fixed.** Two documents read directly, both from zatca.gov.sa: the **E-Invoicing Implementation Resolution** (19 May 2023) and the **VAT Implementing Regulations** (Eighth Edition). Per-clause citations in [`docs/tax/invoice-numbering-verification.md`](../tax/invoice-numbering-verification.md).<br><br>🔴 **The delegation chain is what made the answer findable:** the Resolution does NOT state the rule — Annex (2) field 2.1 defines the IRN and delegates *"as per Article 53(5)(b) of the VAT Implementing Regulation"*. That article is the whole requirement: **"a sequential number which uniquely identifies the Tax Invoice"**.<br><br>**Q1 — are GAPS permitted? YES; sequential + unique is the requirement, unbroken is NOT.** Neither document contains "unbroken", "gapless" or "without gap" for the invoice number (checked, not assumed). 🔴 **The decisive evidence is internal: ZATCA DID write an explicitly gapless, non-resettable rule — for the tamper-resistant COUNTER** (Resolution §7 + Annex 2 field **2.5**, a *different field*, with "counter reset" listed under Prohibited Functionalities). Having spelled it out for 2.5 and not for 2.1, the two differ — exactly as the owner suspected they might. **So a simple counter + unique constraint suffices; the ICV's advisory-lock reservation is NOT required here** and `lockCompanySequence` gains no second caller.<br><br>**Q2 — SCOPE: per COMPANY, one series spanning invoices AND their notes, never reset.** Art. 53(5)(b) scopes uniqueness to the supplier (= the company: it holds the VAT registration and is the EGS unit). Resolution §2 forbids a solution generating more than one sequence of "Electronic Invoices and Electronic Notes" per unit, and multiple concurrent sequences are a **Prohibited Functionality** — so NOT per document type. 🔴 **The year-reset M21.2 introduced is the part that was unsupported**: nothing authorises a per-year restart, and a restart is the one arrangement sitting awkwardly against both "sequential" and the one-sequence rule.<br><br>**Fixed (migration 0054):** `UNIQUE (company_id, invoice_number)`; a monotonic per-company `invoice_number_counters` table that **never resets** (the year is a display prefix — `INV-2026-000045` → `INV-2027-000046`); allocation moved **server-side** into `invoicesService.create` via one atomic UPSERT; the browser's `` INV-${Date.now()...} `` removed; M21.2's second allocator deleted so one counter serves every invoice. A caller-supplied number is still honoured for legacy imports and the constraint judges it. The migration **refuses to run** on pre-existing duplicates and names them rather than auto-renaming — the number may already be a transmitted `cbc:ID` and a note's `BillingReference`. 9 tests, incl. a concurrency property proving a read-then-write allocator collapses 8 allocations into one (verified by re-injection).<br><br>**Still open, carried to the advisor package as Block D** (not stranded in the verification doc): **D1** whether ZATCA's *audit practice* questions gaps — the text cannot answer it, and a "yes" would mean building an explanation for each absent number rather than changing the allocator; **D2** the standing caveat that both English texts are unofficial translations with the **Arabic prevailing**, where the one word our reading rests on is متسلسل / "sequential". | [`docs/tax/invoice-numbering-verification.md`](../tax/invoice-numbering-verification.md) |
| C11 | ✅ **CLOSED (2026-08-23) — verified against the PRIMARY TEXTS, and the queue entry's premise was wrong in both halves.** Three documents read: the **GCC Common VAT Agreement in full (all 78 articles)**, the **KSA VAT Law M/113** (Bureau of Experts official translation — never previously read), and the IR + its Nov-2024 amendments via ZATCA's own guideline. 🔴 The Agreement's Art. 9 is REVERSE CHARGE, and **no sovereign-capacity article exists anywhere in the chain** — the delegation runs Agreement (definitions) → Law Art. 8 → IR Art. 17, which covers only TOGC. The O verdicts are VERIFIED from the definitional scope chain (Agr. Arts. 1+2; Law Art. 2; IR Art. 14) — the same plain-text application C9 used for SALARIES — plus **Agr. Art. 26(6)(b)** for grants. Migration 0057 marks all four codes `treatment_verified`. 🔴 **One condition in positive law, cutting the UNSAFE way: IR Art. 39(2)** (Nov 2024) — a "grant" compensating supplies that benefit the government, directly or indirectly, is TAXABLE CONSIDERATION; booked O it would UNDERSTATE output VAT. Per-row fact, handled by the existing treatment override; recorded loudly. **No advisor question created** — the texts answered all three. | [`docs/tax/gcc-framework-verification.md`](../tax/gcc-framework-verification.md) |
| C8 | 🔴 **PDPL — higher priority than C7 and answered with it. Questions written up as Block B of [`docs/product/advisor-questions.md`](../product/advisor-questions.md).** Phone photographs will eventually contain third-party personal data; PDPL grants erasure rights that may conflict with retention. **PDPL has never been considered anywhere in this project** — scope it to the platform (audit logs hold IPs append-only; the archive holds names/addresses 6–11 years; `users`/`customers`/`employees` have no retention policy), not just document capture.<br><br>**Sharpened 2026-08-14 (audit) — the question stopped being hypothetical.** The product now accepts phone photographs from ordinary users, and **posting a bill promotes that photograph into a store that by interface design can never delete it**. So the irreversible act is performed by ordinary users in the ordinary flow, **before the legal question has been answered**, and an erasure request for a promoted capture is today not "hard" but *impossible by construction*. The advisor question that the wiring surfaces: 🔴 **ZATCA §5.5 immutability covers invoices WE GENERATED — a supplier's invoice photographed by our user is a different class of document, and we currently give both the identical no-delete guarantee.** Ask whether inbound third-party captures may be made erasable-with-audit without touching the outbound guarantee. If yes, the archive needs a class distinction (not a `delete` on `ArchiveStore`); if no, capture needs a consent/data-minimisation story instead. Either way it is a design change, so ask before more tenants photograph more documents. | A1 |
| C10 | 🔴 **ZAKAT TAX ADVICE — the base computation itself. M17.4 IS HELD ON THIS** (owner instruction, 2026-08-15). Q1–Q8 decided the MECHANISM (working paper, GL-derived, Saudi/GCC-only, Hijri+Gregorian); the TAX CONTENT has never been checked against the Zakat Collection Regulations. Written up as **Block C of [`docs/product/advisor-questions.md`](../product/advisor-questions.md)**, asked in the SAME conversation as C7/C8. 🔴 **Ask C1 (the minimum-base rule) first — it is the only one that changes architecture rather than arithmetic:** if a rule ties the Zakat base to adjusted net profit, the income statement stops being Q4's cross-check and becomes a computed INPUT, so the worksheet needs an adjusted-net-profit derivation with its own adjustments and audit trail. Also open: exact base composition and which provisions qualify (needed before **M17.3**, not just M17.4), the Gregorian divisor (354 vs 354.367) and rounding convention, whether nisab has any role in corporate Zakat (assumed NO — if so, say so in the UI so its absence reads as a decision), and confirmation that declining mixed/foreign ownership is the right v1 posture. | [`docs/product/design-zakat-module.md`](../product/design-zakat-module.md) §4 |

Re-check the hosted project's default privileges when it exists — they may
differ from the local Supabase CLI stack where all of this was measured.

### 🔴 AUDIT 2026-08-20 — the remaining findings, by severity (NOT yet fixed)

Five parallel read-only auditors (authn/authz, secrets, error handling, input
validation, test meaningfulness). **CRITICAL + HIGH are CLOSED** — see §2's
audit row. What follows is everything else, queued deliberately rather than
fixed in the same pass. Full method and each auditor's stated blind spots are
in the PR for `fix/audit-critical-high`.

**Verified CLEAN (worth knowing):** no new authz hole (guard order, identity-route
IDOR checks, operator isolation, session-fixation regeneration, and an
RLS-bypass sweep all held); no real secret committed, logged or returned (the
ZATCA vault verified strongly — callback-scoped key access, buffers zeroed,
throwing `toJSON`, fixed error messages); the generic-500 wall means no SQL,
stack or path leaks to clients; the job scheduler survives a failing job.

| Sev | Finding | Where |
| --- | --- | --- |
| ~~MED~~ | ✅ **FIXED (2026-08-24, test-vacuity cluster)** — only the two DURABLE not-ready stages (`no-active-credential`, `credential-not-activated`) map to null/"not onboarded"; a KMS outage or DB error now PROPAGATES, so the outbox records the true reason and retries instead of burning an attempt on a wrong diagnosis. | `zatcaDirectProvider.ts` |
| **MED** | **A 2xx for a transaction that rolled back.** Commit failure after `res.on("finish")` is logged only — the client already has its success. Structurally hard to fix at that point; nothing alarms on the pattern (L-1 family). | `lib/tenant.ts:144` |
| ~~MED~~ | ✅ **FIXED (2026-08-23, MED validation pass)** — malformed `extraction`/`fieldSources` JSON now REFUSES with a named 400 (`parseJsonField`, lib/httpParams) instead of staging the capture with the user's OCR silently lost. | `routes/capture.ts` |
| ~~MED~~ | ✅ **FIXED (2026-08-23) — reclassified a SECURITY finding by the owner, not a validation fix** (full record: findings file, 2026-08-23). Was queued as the 500-where-4xx cluster; 🔴 **the finding grew during the fix:** Postgres FK checks run OUTSIDE RLS, so a nonexistent customerId and ANOTHER TENANT's customerId were both accepted-or-500 — a cross-tenant reference + existence oracle, not just a bad status. Fixed by tenant-scoped pre-checks → **422 `reference_not_found`** (status policy: 422 = semantically invalid input that passed schema validation) on customerId/vendorId/categoryId/bankAccountId across invoices, bills, quotations, POs and transactions (both prior bankAccountId 400s aligned to 422). Capture's >10 MB photo now maps through `uploadSingle` → 400. | `audit-med-validation.test.ts` |
| ~~MED~~ | ✅ **FIXED (2026-08-23, MED validation pass)** — `taxCategoryCode` constrained to S/Z/E/O-or-null: named 400 at the services (`assertTaxCategoryCode`), **DB CHECK 0056** on `invoice_items` AND `quotation_items` as the write-boundary backstop (bill/PO items have no such column — verified, the M21.3 lesson). | migration 0056 |
| ~~MED~~ | ✅ **FIXED (2026-08-23, MED validation pass)** — PATCH `/transactions/:id` now carries the create path's vatAmount/vatRate bounds in the spec, and the invariant itself moved to **DB CHECK 0056** (owner instruction: fix the write boundary, not the looser path). | migration 0056 |
| ~~MED~~ | ✅ **FIXED (2026-08-23, MED validation pass)** — `requireIdParam` (lib/httpParams, the quotations-controller helper generalized) on all ~13 controllers + orgs/auth routes; NaN ids are 400s, never 22P02 500s. | `lib/httpParams.ts` |
| ~~MED~~ | ✅ **FIXED (2026-08-24)** — the certificate alarm is exercised FIRING with a BUILT condition (the `stuckDocument` discipline): T-3 fires as a warning naming the days and the tenant-OTP fact; expired fires CRITICAL, stays firing through the cooldown, and a renewal RESOLVES. | `tests/alerting.test.ts` |
| ~~MED~~ | ✅ **FIXED (2026-08-24)** — the verifier can now say YES: a genuinely-signed secp256k1 fixture (DER sig over the hash-as-message, SPKI in tag 8 raw, tags 6/7 as base64 strings — divergence #13 preserved) is VERIFIED, and its anti-vacuity twin (same key/signature, different hash) FAILS — the pair proves discrimination, not politeness. | `tests/document-capture.test.ts` |
| ~~MED~~ | ✅ **FIXED (2026-08-24)** — a THIRD, ONBOARDED company in the concurrency suite: 8 parallel approvals produce 8 `einvoice_documents` rows chained contiguously from ZATCA's `GENESIS_PIH` (never the homegrown literal), all predecessors distinct — the fork artifact `unique(company_id, icv)` structurally cannot see, asserted on the table ZATCA actually reads. 🔴 Honest note: this test was NOT verified-by-reinjection (that would mean patching `lockCompanySequence` out); its assertions are presence-shaped over real concurrent rows, and the sequential fork case is pinned in the enqueue suite. | `tests/invoice-icv-concurrency.test.ts` |
| ~~MED~~ | ✅ **FIXED (2026-08-24)** — `DemoResetRefused` now SETS its name and prototype (it was runtime-indistinguishable from a bare Error, and the old test asserted exactly that defect: `.name === "Error"`); the test now fails against `new Error()` by construction. | `tests/demo-reset-guard.test.ts` |
| ~~LOW~~ | ✅ **FIXED (2026-08-24, LOW close-out)** — `sanitizeBody` redacts secret-shaped keys (secret/token/password/credential/authorization, any depth) before the body attaches to a loggable error; the diagnosis fields survive. Pinned with a fixture carrying a real-shaped secret. | `zatcaOnboardingClient.ts` |
| ~~LOW~~ | ✅ **FIXED with C1 (2026-08-20)** — cookie `secure` and `trust proxy` are now explicit env facts (`SESSION_COOKIE_SECURE`, `TRUST_PROXY_HOPS`), not inferred from `NODE_ENV`, and production refuses to boot with Secure off. The stale `sameSite: strict` comment now states the `lax` the code has always set. | `app.ts` |
| ~~LOW~~ | ✅ **FIXED (2026-08-24)** — `/llm/status` no longer echoes `OLLAMA_URL`; it reports `llmBackendConfigured`, the tenant-relevant fact, and keeps the topology. | `controllers/llm.controller.ts` |
| ~~LOW~~ | ✅ **FIXED (2026-08-24)** — `tests/env-boot-refusal.test.ts`: from a proven-good production baseline, each refusal is one flipped variable — B1 mail, B2 alert, the local-dev key wrapper, `SESSION_COOKIE_SECURE=false`, and the AI-1a attestation in both directions (a near-miss string refuses). Lives in the api suite because the PACKAGE lacks test infra and the BEHAVIOR was the gap. Bonus surfaced by the baseline: the `ZATCA_ARCHIVE_DIR` absolute-path refusal, now exercised too. | `tests/env-boot-refusal.test.ts` |
| ~~LOW~~ | ✅ **HALF FIXED, HALF ACCEPTED (2026-08-24)** — the varchar half is a CLASS fix: Postgres `22001` maps to a named 400 in the central errorHandler, so every varchar column present and future inherits it. The controller-raw-body half stays ACCEPTED as depth-in-defence (the services are allowlisted — H1); revisit only if a service allowlist regresses. | `middleware/errorHandler.ts` |
| ~~LOW~~ | ✅ **DOCUMENTED (2026-08-24)** — the shrink-check's generated-hook blind spot is now stated at the check itself, with WHY scanning the generated client would be vacuous (it contains every spec path regardless of use) and the manual rule for hook-fixed entries. Acceptable while `KNOWN_UNREACHABLE` holds one entry. | `tests/route-reachability.test.ts` |
| ~~LOW~~ | ✅ **DOCUMENTED (2026-08-24)** — the vault-boundary test now states its text-matching limitation in place (the identity-boundary twin) and names the grants layer as the enforcement that doesn't depend on reading source. | `tests/zatca-credential-vault.test.ts` |
| ~~INFO~~ | ✅ **FIXED (2026-08-24)** — the canonicalisation test now claims what it proves (UBLExtensions stripped) and names where the QR/Signature exclusions ARE proven (the live compliance pass). The narrower-claim shape, corrected at the name. | `tests/zatca-crypto.test.ts` |

🔴 **What the audit could NOT see** (recorded so it is not mistaken for a clean
bill): RLS *policy* coverage was the biggest gap and is now closed by
`tests/rls-coverage.test.ts`; still unaudited are the **permission-matrix seed
grants** (enforcement was audited, the grants were not), **same-org
cross-company isolation** (`app.current_company_id` at row level), **git
history entropy-scanning** (prefix/pickaxe only, no gitleaks pass), and
**runtime-order test vacuity** (only execution reveals it).
✅ **The accounting core's own throws are now AUDITED (2026-08-27)** — the last
of this list to close; findings below.

**🔴 OPERATOR SURFACE — AUDITED (2026-08-27), by REACH rather than by routes.**
Taken next after F1 because it is the platform's only cross-tenant privileged
path, and audited with the question the composition class demands: *what does
operator status actually permit, including through paths nobody wrote with
operators in mind?*

**Verified CLEAN, and worth knowing:** operator status is **not
self-grantable** — there is NO write path to `platform_operators` anywhere in
the API (only `packages/db/seed.ts`); `isOperator` is consulted in exactly one
place (`lib/operator.ts`), so operator status adds nothing inside a tenant
context; the review state machine never allows `approved` in `allowedFrom`, so
an operator **cannot** reject a live tenant out of the platform; the
transition re-asserts its guard atomically; `verification_documents` is its own
table (not shared with tenant business documents) and `findInOrg` scopes by
docId AND orgId, so there is no operator IDOR into tenant files.

🔴 **F2 — the job runner's reach was inherited, not decided. FIXED.**
`POST /operator/zatca/jobs/:name/run` validated against
`getScheduler().names()` — the whole registry — so the surface gained reach
every time any milestone registered a job. **The UI offers three buttons and
the route's comment names three; the API permitted nine.** Re-injection shows
what that meant: pre-fix, `demo-reset` returned **200** (the route accepted it;
only the job's own `DEMO_MODE` precondition, in another service, prevented a
wipe) and `capture-promotion` **actually ran** — irreversibly promoting
tenants' captures into a store that by design cannot delete, with **no audit
record at all**. The runner was the ONLY operator route that recorded nothing,
while being the most consequential one available (draining the outbox transmits
tenants' invoices to a tax authority). Neither file was wrong: registering
every job is deliberate and load-bearing (`runNow` is how a job stays operable
with its timer off), and the route did validate against a list — **a
registration decision silently doubled as an authorization decision.**
Fixed by `lib/operatorJobs.ts`: the operator surface declares its OWN reach,
every job classified with a reason, refused at the route AND the service, the
run audited as `operator.job_run` (org-less — a job run is platform-wide).
`tests/operator-job-reach.test.ts` fails in BOTH directions when the registry
and the classification disagree, so a new job cannot default to runnable and a
stale rule cannot rot. Verified by re-injection (4 red).

**Recorded, NOT fixed — scope observations, not vulnerabilities:**
`getApplication` accepts ANY orgId, including an **approved, live** tenant, and
returns its CR/VAT plus its verification documents — it is audited, and
re-review is legitimate, but the access **never expires** and those documents
carry third-party personal data, so it belongs with **C8 (PDPL)** rather than
being silently fine. `onboardingStatus()` returns every company's VAT number
across every tenant, unfiltered and unpaginated.

### 🔴 OPEN QUEUE from the 2026-08-27 audits, by severity

Nothing here is a known-exploitable hole; each is a decision or a gap that was
found, understood and deliberately not closed in the same pass.

| Sev | Item | What would close it |
| --- | --- | --- |
| **MED** | **🔴 The accounting core's central precondition has no forcing function** (accounting-core services audit, first pass). `db` is a Proxy: inside a tenant transaction it resolves to the RLS-scoped client; **outside one it falls back SILENTLY to `baseDb` — the same owner connection `ownerDb` exports**, with RLS bypassed and no `app.current_org_id`. No error, no empty result: a full-privilege cross-tenant handle. The accounting core explicitly depends on this not happening — `glPosting.resolveAccounts` writes NO organization filter, justified in a comment by "this runs inside the request's tenant transaction". So the core trusts a fact its CALLER controls, and the failure mode is a wrong answer rather than a refusal — shape 1 of the composition class, in the layer with the least tolerance for it. **No live instance found in this pass** (checked, not assumed): the two jobs that touch per-tenant business data through shared services — `recurringGenerationService` and `findingsScheduleService` — both open `beginTenantConnection` per tenant; the unscoped jobs (outbox, archive, renewal, capture, alarms) are cross-tenant sweeps BY DESIGN and use raw SQL with an explicit `organization_id` parameter rather than relying on RLS. The gap is that nothing STOPS the next caller. | Export a scope predicate from `@workspace/db` and assert it at the top of `postJournalEntry` / `checkPeriodOpen` — throw when called outside a tenant transaction. Make the unscoped call inexpressible rather than merely unwise. Ships narrow and scoped, as its own change. |
| **MED** | **No password recovery for a multi-org account.** F1's fix means an account that has EVER held a membership outside an admin's scope cannot have its password reset by that admin — and the platform has no self-service recovery at all (`/auth/change-password` requires the current password). Such a user who forgets is locked out. The strict reading is deliberate; the gap is real and now REACHABLE rather than theoretical. | An operator-level reset (audited, on the operator surface) or a self-service email flow. B1's mailer is already live, so the second is now buildable. |
| **MED** | **`operatorService.getApplication` accepts ANY orgId, including an approved LIVE tenant** — returning its CR/VAT and its verification documents. Audited, and re-review is legitimate, but the access **never expires**, and those documents carry third-party personal data. Not a hole; an unbounded retention/access surface. | Belongs with **C8 (PDPL)** — ask whether operator readability of a verified tenant's identity documents should expire, and if so build the expiry. Not a code fix ahead of the answer. |
| **LOW** | **`operatorZatcaService.onboardingStatus()` returns every company's VAT number across every tenant**, unfiltered and unpaginated. Operational metadata by design and operator-only, but it is the widest single cross-tenant read on the surface. | Paginate, and drop `vatNumber` unless a stated operator workflow needs it (`readyToOnboard` already carries the derived fact). |
| **LOW** | **Manual-JE balance failure returns 400 where the status policy says 422** (semantically invalid input that passed schema validation). Pre-existing and tested; changing it is a behaviour change to a path this audit did not otherwise touch. | Align with the status policy in a pass that owns that path, updating its tests. |
| **DECISION** | **`platform-alarms` classified NOT operator-runnable** (F2). Harmless in itself — it pages our webhook, not a tenant — but no surface offers it. Flagged for veto rather than decided silently. | One-line flip in `lib/operatorJobs.ts` plus a button, if manually testing paging is wanted. |
| **HOUSEKEEPING** | **`CLAUDE.md` is ~142k characters** against its own stated budget of "well under 100k". This session added to it. | A pass moving narrative into `docs/history/`, which §1 already prescribes. |

**🔴 ACCOUNTING-CORE THROWS — AUDITED AND CLOSED (2026-08-27).** All 14 throws
in `services/accounting/` + `services/approval/` enumerated and classified.
**Thirteen were already correct** (typed `AppError`s in the approval engine;
`PeriodLockedError` structured at 423; `AccountResolutionError` a deliberate
diagnostic-500). `onApprove` failures propagate rather than being swallowed —
the fail-closed posture holds. Two findings, both fixed:

1. **The balance guard was the one untyped throw in the core** — a bare
   `throw new Error(...)` guarding *debits equal credits*, the single most
   important invariant in the system. The central handler duck-types on
   `statusCode`, so it became the generic 500 wall with the two totals surviving
   only in the log — the C5 shape (fail-closed right, diagnosis absent) on the
   core's most consequential guard, while its two immediate neighbours in the
   same function were both typed. Now `UnbalancedEntryError` (500, naming both
   totals, the difference, the tolerance, and that nothing was posted).
   🔴 **And nothing proved it fired**: the suite mentioned it twice, both in a
   test asserting it does NOT fire. A guard whose only coverage asserts its
   silence is the obsolete-assertion family — widen the tolerance or invert the
   comparison and CI stays green. `tests/gl-balance-guard.test.ts` is the
   presence assertion, with the anti-vacuity twin.
2. **One invariant, two tolerances** — `journalEntries.service` refused a manual
   entry at `> 0.01` while the GL refused at `> 0.005`, the user-facing gate
   LOOSER than the ledger's. 🔴 **Not currently reachable** (checked, not
   assumed: a manual entry posts through its own approvable and never calls
   `postJournalEntry`), so it was latent — but it is the two-id-spaces shape,
   and had a JE path ever reached the GL helper, an imbalance in (0.005, 0.01]
   would have passed the 400 and died as an opaque 500 on approval. Now one
   exported `GL_BALANCE_TOLERANCE`, imported rather than restated, with a test
   that fails when the literal comes back (verified by re-injection).

### Other open findings (small, non-blocking)

Full text and history: [`docs/history/known-issues-and-audit-findings.md`](../history/known-issues-and-audit-findings.md).

- **🔴 INVOICE DATING INTO CLOSED MONTHS — owner-decided 2026-08-23,
  REASONED-NOT-VERIFIED (source: the owner, not an accountant).** Its own
  item by owner instruction, not a leftover of the MED validation pass. The
  policy: **an invoice must not be dated into a closed period at all** —
  closing a month means its figures are final, and Saudi VAT files per
  period, so a backdated document makes a filed return wrong or forces an
  amendment. Work that genuinely happened in a closed month is **issued in
  the current open period**; revenue that truly belongs to the closed month
  is **an accrual made before closing**, never a backdated document after.
  **The guard honours `document.date`** — the accounting date every report
  and the VAT return read; `issued_at` is the ZATCA timestamp, a different
  fact. Under that reading the existing create-path guard was RIGHT, and the
  real gap was that nothing stopped `date` being backdated after creation —
  **closed in the same pass**: `invoices.update` / `bills.update` now call
  `checkPeriodOpen` on a changed date (423 `period_closed`, the M22 dialog
  explains it for free). 🔴 **One question remains for the accountant:**
  whether Saudi practice permits ANY exception — a grace window, or an
  audited override. A detail; the principle stands either way.
- **🔴 QUEUED DECISION (owner, 2026-08-24): `normalizeDigits` exists twice —
  single-source it or accept the pin.** The canonical Arabic-Indic digit
  normalisation lives in `apps/web/src/lib/receiptParser.ts`; AI-3b's
  explanation verifier carries a copy in
  `apps/api/src/services/findings.explanationVerifier.ts` because the
  web↔api workspace boundary blocks a direct import. A
  behavioral-equivalence test pins the copy today, but "four lines is fine;
  a second copy that drifts isn't" (owner). The decision when taken: a small
  shared workspace package (probable home for future shared text/number
  utilities — the TLV-codec precedent) vs. keeping the pin. Not urgent;
  recorded so it is a decision, not a flag decaying in a PR description.
- ~~M-3~~ ✅ **FIXED (2026-08-24, LOW close-out)** — the signup race maps the unique-index verdict to the pre-check's own 409, keyed on the CONSTRAINT (drizzle-unwrapped) so an org-slug collision is not mislabeled as a duplicate email; pinned by a genuinely concurrent two-signup test. (The bcryptjs half of M-4 stays open.)
- **M-4**: `bcryptjs` blocks the event loop on public endpoints; no max-length validation before `varchar(255)` (raw 500s).
- **M-5**: magic-byte sniff is header-only (closes with C4's AV work).
- **L-1**: security-audit write failures only `console.error` — route through `pino` and alert on the pattern.
- **L-2**: signup 409 leaks account existence (accepted; document inline).
- ~~L-3~~ ✅ **FIXED (2026-08-24)** — the primary-membership order is total: `createdAt, id`.
- **L-4**: the operator queue list is unaudited (accepted trade-off).
- **✅ `companies.fiscalYearStart` — fully closed by M20.0 + M20.1** (was: stored
  from M11.6, applied by nothing for five milestones). Resolver (`lib/fiscalYear.ts`),
  calendar basis, endpoint, Company Settings display (M17.2); NULL = not declared
  as a first-class state (M20.0); every report page opens on the resolved fiscal
  year or a labelled rolling 12 months (M20.1). Remaining fiscal-period work is
  feature work, not a gap — tracked in §2 (M20.2/M20.3).
- **S6/S7 traps**: `feature_flags`, `branches`, `departments` are tables with **no consumer** — do not assume they work; build a consumer or drop them.
- **Feature (deferred)**: action-level permissions for separation-of-duties (post-to-GL / pay / approve individually gateable).
- **🔴 Mounted routes with NO UI (found by `tests/route-reachability.test.ts`,
  2026-08-14 — the same class as A1/A3):** ~~`/period-locks`~~ (✅ CLOSED —
  M18.4 gave it its first UI in the Finance Hub; **M22 (2026-08-21) added the
  dedicated `/closed-months` page + the global 423 explanation.** 🔴 This
  bullet itself claimed "a tenant cannot close an accounting period from the
  product" for a WEEK after M18.4 fixed that — the guard's comment was updated
  and this file was not, the exact §11 staleness disease, in the operating
  file), `/audit-logs` (the admin audit trail has no reader UI, though it is
  claimed as available to org admins), `/llm` (proposal-only, inert, parked
  with the AI layer).
  They are listed in the guard's `KNOWN_UNREACHABLE` with
  reasons; the guard blocks NEW ones and fails if a listed route gains a UI
  without leaving the list. **Also fixed in the same pass:** `ZatcaOnboarding`
  and `CreditNotes` passed `/api/...` into `apiFetch`, which prepends `/api`
  itself — both pages requested `/api/api/...` and 404'd on every call.
- **✅ META-FINDING #9 — CLOSED by flaw #1 (Option A, 2026-08-14).** The ledger
  and transaction report families used to answer the same questions from
  disjoint stores: an income statement showing **0.00 expenses** beside a
  dashboard showing **45,063.25**, same tenant, same month. **Accepted
  transactions now POST to the ledger** (`transactionPosting.service.ts`), and
  `summary.getSummary` derives income/expenses from `incomeStatement` — so the
  dashboard and the P&L cannot drift *by construction* rather than by
  agreement. Posting rules: gross with **no input-VAT line** (input VAT needs a
  valid tax invoice; a bank line is not one), uncategorised → **SUSPENSE** (a
  visible balance, never a silent expense), transfers and settlements never
  post (one writer per effect), category TYPE decides the statement, period
  locks apply, and editing a posted row **reverses and re-posts**. VAT/Zakat
  payments re-typed to `liability` (migration 0036), so settling them no longer
  reduces profit. Full record: [`docs/history/findings-and-lessons.md`](../history/findings-and-lessons.md).
- **✅ Flaw #6 CLOSED (2026-08-14) — reverse charge is representable.**
  `tax_treatment` stays the ZATCA supply taxonomy; a new **`vat_basis`**
  (`charged | reverse_charge | supplier_unregistered`, migration 0037) says
  whether VAT was actually charged on the payment. **VAT is extracted only when
  treatment='S' AND basis='charged'**, enforced by DB CHECKs. The engine flags
  known foreign digital suppliers (Google, AWS, Meta, Microsoft, Adobe…) as
  reverse-charge — independently of whether it can categorise the row, so a
  hand-categorised foreign payment does not silently revert to "charged" — and
  the review UI makes it overridable in both directions. 🔴 **The supplier list
  is itself an ASSUMPTION** (several platforms have since registered for KSA
  VAT on some product lines) — see C9.
- **✅ Flaw-report item #8 — CLOSED by M17.0 (2026-08-15).** The Zakat base read
  `is_zakat_relevant`, which **one rule out of ~40** set (Tadawul/investment),
  so it rendered a computed-looking **0** for almost every tenant beside a nisab
  threshold hardcoded from a 2024 gold price — and for a tenant who *did* trade,
  something worse: investment **income** reported as a zakatable **asset**, less
  every debit. The owner interview (Q1–Q8) defined the capability, and M17.0 removed
  the fake one: `transactions.is_zakat_relevant`, `categories.zakat_relevant`,
  `system_account_templates.zakat_relevant` (migration 0038, org-seed trigger
  redefined FIRST), `GET /summary/zakat` and its schema, both UI toggles, and
  four **vacuous** test probes that compared 0 to 0. The page now states it is
  not implemented. Decisions + build order:
  [`docs/product/design-zakat-module.md`](../product/design-zakat-module.md).
- **Audit leftovers (2026-08-14, deliberately not fixed — tracked):** manual
  transaction create has no `kind`/`taxTreatment` fields, so every manual
  VAT-bearing entry is a null-treatment row with user-asserted VAT (by-design-
  adjacent; fields worth adding); sub-cent amounts via raw API can mark a
  document paid with a 1-halala GL residual (round `paid` at the validation
  gate — unreachable from UI/settlement); ~~budget actuals `sum(amount)` ignores
  debit/credit so a refund increases "spent"~~ **✅ FIXED in M19.0** — actuals
  are now signed by account type (expense/asset debit-natural, income/liability/
  equity credit-natural), and a negative actual is reported rather than clamped;
  the income-statement
  transactions-FALLBACK (zero journal lines only) reports gross incl. VAT;
  settlement links are readable from the transaction side only (no invoice/
  bill-side surface, design said "either side"); the Categories UI cannot mark
  system accounts (`isSystem` not in the API — latent, no edit routes exist);
  `status: 'overdue'` has NO writer on invoices or bills (dead enum value; UIs
  style it, aging derives overdue from dates); VAT-return box 4 (exports) is
  always 0 — an export today is a 'Z' line in box 2.


---

## P5 — BROWSER TESTS IN CI — CLOSED 2026-08-31

Queued 2026-08-28 as its own project, deliberately not half-built inside a
bug-fix pass. Built as `apps/web/e2e` with a non-blocking `e2e` job in CI.

### Why it was the only unblocked work worth doing

Every other test in the repo runs a layer below the one that breaks:

| Found by | Defects |
| --- | --- |
| a browser | the blank AP-aging page, swallowed server refusals, the GL showing SAR 0.00, an uneditable bill, AUD-13's issued zero-value tax invoice, and the statement link that dropped its customer |
| 1,179 tests | none of them |

### What it does

- **Smoke crawl over every route**, authenticated, failing on an uncaught
  exception, a 5xx the page swallowed, a console error, or an empty body. Not
  "did it 200" — every browser-found defect in this project returned 200.
- **The route list is DERIVED from `App.tsx`, never typed.** A hand-maintained
  list would be a second representation of the route table. The forcing function
  is a `EXPECTATIONS` map: every derived route must be classified, an
  unclassified one fails the suite, and a classification for a route that no
  longer exists also fails. P4's known-gap pattern, pointed at pages.
- **404 recording closes P4's blind spot from the other side.** P4 proves a call
  SITE exists; this proves the call the running app actually makes resolves to a
  mounted route.
- **The lost-scope check** — for a link carrying a query parameter, assert the
  DESTINATION reflects it. Written from the 2026-08-31 incident.

### 🔴 Flake management, which is the part that decides whether it is worth having

`retries: 0`, deliberately. A suite people learn to re-run is a guard reporting
coverage it does not have — the failure P5 exists to prevent, imported into the
tool built to prevent it. `retries: 2` would hide exactly that: the second pass
goes green, nobody reads the first, and the real signal quietly becomes "it
passed at least once in three".

What pays for that strictness: one worker (the app has one database and one
tenant; `test-suite-notes.md` already records cross-fork collisions), data
seeded once under a slug the suite owns, no `waitForTimeout` anywhere, and both
servers started by Playwright so "the page failed" can never mean "the server
was not up yet".

**The job is NOT a required check on day one**, also deliberately. A new browser
suite's first weeks are when its flakes surface, and a flaky *required* check
teaches people to re-run rather than to read. Promote it in branch protection
once it has been green across a stretch of real PRs.

### What the first run found

Two failures, and neither was a product defect — which is itself the useful
result, because both were discovered rather than assumed:

1. **`/verification` has no `<main>`.** It is
   `<AuthGuard><VerificationStatus /></AuthGuard>` with no `Layout` — the M11.2
   gate for an org whose verification is pending, which must not reach business
   routes. The missing shell is the design. Recorded as its own route kind
   (`authenticated-no-shell`) rather than by relaxing the assertion for
   everything, which is how a guard quietly stops guarding.
2. **A race in the test, not the app.** The deep-link check read the DOM once
   and caught `"Loading…"`; the report resolves its fiscal-year range before it
   fetches, so content arrives after `networkidle`. Fixed with web-first
   assertions that poll the condition. With `retries: 0` the only honest fixes
   are to assert on the condition or delete the test.

### Verified to fail for the right reason

The deep-link guard was checked against the real bug: reverting
`CustomerLedger`'s `initialCustomerId()` to `"all"` turns it red with the
intended message, and restoring it turns it green. A guard never seen to fail is
the CI-merge-gate mistake in another costume.

**Result: 65 tests, 3.1 minutes, exit 0.**

### P5's first CI run went red — three causes, all in the harness

Recorded because the suite's own config comment claimed local and CI were "the
same run", and the first CI run disproved it within three minutes.

1. **`Port 3000 is already in use`.** The CI job set `PORT` once for the whole
   job; both `vite.config.ts` and the API read `PORT` at load, so vite tried to
   bind the API's port. **Green locally, red in CI — exactly what starting both
   servers from `playwright.config.ts` was supposed to make impossible.** The
   claim was right and the ambient environment made the runs different anyway.
   Fixed by naming each port per server in the config, so the suite no longer
   depends on what surrounds it.
2. **`/api/health` does not exist.** The health route is mounted at
   **`/api/healthz`**; `/api/health` falls through to the authenticated
   catch-all and answers 401 forever. The readiness wait therefore never
   succeeded. A path assumed rather than checked — and it was introduced *after*
   the run that passed 65 tests, so it was a regression added by a hardening
   step.
3. **The wipe enumerated its tables by hand** and broke the moment the
   scheduled-findings job wrote a `finding_runs` row for the seeded org. A
   hand-kept list of org-scoped tables is a second representation of the schema
   and rots as tables are added. Now derived from `information_schema` — every
   table carrying an `organization_id` — with FK triggers disabled for the wipe
   so the dependency ORDER need not be known either.

🔴 **And a fourth, in the instrument again.** Reproducing the CI condition
locally, `export BASE_PATH=/` in Git Bash was rewritten by MSYS path conversion
into `C:/Program Files/Git/`, so vite served the app under that base and 59 of
65 tests failed on 404s. Nothing was wrong with the code; the harness was.
**Third time this week** an instrument was wrong before the code was, after the
Tailwind probe inventing classes and the benchmark's authored verdict. The tell
was the same each time — the instrument disagreed with itself, 6 passing beside
59 failing in a mechanism that treats them identically.

Verified after the fixes by reproducing the exact CI condition (`PORT=3000` set
globally): **65 passed, exit 0.**
