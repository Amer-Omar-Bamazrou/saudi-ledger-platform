# Phase 1 — Onboarding & Multi-Company (M11.1–M11.7): as-built record

> Moved verbatim out of `CLAUDE.md` at the CLAUDE.md restructure
> (2026-08-13, post-M16.2). This is the historical record; the current
> operating summary lives in [`CLAUDE.md`](../../CLAUDE.md).

## Phase 1 — Milestone 11: Onboarding & Multi-Company Foundation (COMPLETE)

Entry point = **public self-service signup behind a verification gate** (an org
signs up, submits CR/VAT + documents, enters `pending_review`, and gets no
platform access until a platform operator approves). Sequenced M11.1 → M11.7;
each sub-milestone pauses for review. Full plan in the `m11-onboarding-plan`
project memory (design record; a `docs/` spec will follow).

- **M11.1 (done): security-audit log foundation.** A dedicated
  **`security_audit_logs`** table (migration `0010`) + **`securityAuditService`**
  (`services/securityAudit.service.ts`) records the actor-centric identity/security
  trail, kept **separate from the tenant-scoped business `audit_logs`** (the M7
  boundary made concrete): `organization_id` is **NULLABLE** (global events —
  user created, password reset — carry none; membership events set it), the table
  has **no RLS and no app-role grants** (written/read ONLY on the base/owner
  connection by the identity layer, which runs before `resolveTenant`; a DB
  boundary test proves the app role can't even SELECT it), and it is
  **append-only by construction** (the service exposes only insert + read).
  Recording is **best-effort, non-throwing** — unlike the in-transaction
  `auditService`, security events fire on the base connection outside the
  mutation's autocommit, so a failed insert is logged, never thrown (it must not
  turn an already-committed identity change into a reported error); making
  identity mutations transactional is a documented follow-up. The three
  `TODO(security-audit)` markers in `members.service.ts` are now wired
  (`membership.assigned` / `role_changed` / `status_changed`), plus the `/auth`
  routes (`user.created` / `role_changed` / `deactivated` / `reactivated` /
  `password_reset` / `password_changed`). Org admins read their org's events via
  `GET /orgs/:orgId/security-events` (identity layer, explicit admin-of-that-org
  auth; global org-less events are exposed by the operator surface in a later
  sub-milestone). Verification/invite/operator events extend the same log in
  M11.2+.
- **M11.2 (done): verification state + fail-closed access gating (the
  security-critical core).** `organizations` gained `verification_status`
  (`pending_review | needs_info | approved | rejected`, default `pending_review`)
  + `verification_reason` / `verification_reviewed_by` / `_reviewed_at` /
  `_submitted_at` (migration `0011`). The migration **backfills ALL existing orgs
  to `approved`** (two-step default: add column `DEFAULT 'approved'` to grandfather
  existing rows, then `SET DEFAULT 'pending_review'` for future signups) and the
  **seed sets the default org `approved`** — so the seeded tenant and all
  M3-backfilled data keep full access. **The gate lives in `resolveTenant`**: after
  selecting the active org (its status joined into the membership query) it
  short-circuits with **`403 {code:"org_not_verified", status, reason}`** for any
  non-`approved` org **before** `beginTenantConnection` — so the tenant GUCs
  (`app.current_org_id`/`company_id`) are never set and no org-stamped RLS
  connection is opened. That is the DB-level backstop (layer 3): with no GUC, RLS
  matches zero rows and the NOT NULL `organization_id` default (NULL) rejects
  writes — fail-closed by construction for every current AND future business route
  (all mounted after `resolveTenant`). A pending org's only reachable surface is
  the identity layer mounted **before** the gate: `/auth` (incl. logout), `/orgs`,
  and new **`/onboarding/status`** (`services/onboarding.service.ts`, returns the
  active org's `{status, reason}` so the web app can route to the status page).
  Proven by `tests/verification-gating.test.ts` (M3/M4 rigor): the `resolveTenant`
  seam (approved → `next()`; pending/needs_info/rejected → 403, no tenant context;
  the multi-org edge — one user gated purely by which org is active), and an
  end-to-end pass over the real app (a pending org gets 403 on every business write
  + a reports read with an **owner-connection query confirming ZERO rows written**;
  onboarding/logout still work; after approval the same write posts).
- **M11.3 (done): platform-operator concept + review boundary (security-sensitive).**
  A `platform_operators` table (owner-only) marks the few users who may review
  verification applications; **operator status is granted ONLY via the seed/CLI**
  (`seedPlatformOperator`, gated on `SEED_OPERATOR_EMAIL`/`_PASSWORD`) — **no HTTP
  route ever grants it**. An operator is a **global identity with no org
  membership**, so `resolveTenant`'s existing no-membership 403 blocks them from
  **every** business route — operator status grants **zero** access to any
  tenant's financial data (no BYPASSRLS, and the operator surface never returns
  invoices/GL/reports). The **`/operator`** namespace is mounted **before**
  `resolveTenant`, guarded by **`requirePlatformOperator`** (`lib/operator.ts`,
  fail-closed), and exposes only verification metadata: list the review queue, get
  an application's detail (org + the applicant company's CR/VAT + review history),
  and the decisions **approve / reject / request-info** plus the operator-only
  **`reopen` (`rejected → needs_info`)** mistake-correction path — `rejected` is
  terminal-by-default (you cannot approve straight from it). Each decision updates
  the org, appends a `verification_reviews` row (owner-only history table), and
  writes a `security_audit_logs` event (operator id + target org); guards are
  fail-closed (wrong state → 409, missing reason → 400, unknown org → 404).
  Approving flips `verification_status` to `approved`, which un-gates the org on
  its next request. Both new tables get **no RLS and no app-role grants** (DB
  boundary test asserts the app role can't touch them). Proven by
  `tests/operator.test.ts` (state machine + `requirePlatformOperator`/
  `resolveTenant` boundaries + an e2e: an operator gets 403 on every business
  route, a non-operator gets 403 on `/operator`, and an operator approves an
  application end-to-end) and `packages/db/.../operator-tables.test.ts`.
- **M11.4 (done): document upload & storage (Supabase Storage, API-brokered).**
  Applicants upload registration documents (CR/VAT certificates, other) and
  operators review them; the file **bytes live in a private Supabase Storage
  bucket**, the metadata in a new owner-only `verification_documents` table
  (migration `0013`). **All I/O is brokered through the API** — a thin,
  **dependency-free** client (`lib/storage.ts`) over Storage's REST API using the
  service-role key, which **stays server-side only**; the browser never gets it.
  Authorization is **our** model, not Storage RLS: an applicant acts only on their
  active org's docs (membership-resolved in `onboarding.service`), and operators
  read any org's docs through the operator surface. **Validation** (`lib/fileValidation.ts`):
  an allow-list (PDF/JPEG/PNG) enforced by a **magic-byte sniff** (bytes, not the
  spoofable declared mime/extension), a 10 MB cap (multer memory limit +
  re-checked), and filename sanitization (no path traversal). **Downloads are
  forced attachments** (`Content-Disposition: attachment` + `X-Content-Type-Options: nosniff`,
  never inline — `routes/documentHttp.ts`). Endpoints: applicant
  `POST/GET /onboarding/documents` + `GET /onboarding/documents/:id`; operator
  detail now includes documents + `GET /operator/applications/:orgId/documents/:docId`.
  **Audited:** `verification.document_uploaded` (uploader) and, for the operator
  download, `verification.document_viewed` (cross-tenant access). Upload rolls
  back the stored object if the metadata insert fails. New **config** (validated
  in `@workspace/config`, all optional so the app still boots without storage —
  document endpoints then 503): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
  `VERIFICATION_DOCS_BUCKET` (default `verification-documents`). Proven by
  `tests/documents.test.ts` (validation, real bucket round-trip, org-scoping,
  audit, multipart upload + attachment-only download — gated on Storage creds, so
  it skips in CI) and the `verification_documents` owner-only DB boundary test.
- **M11.5 (done): public self-service signup + applicant status/resubmit + minimal
  UIs — the flow is clickable end-to-end for the first time.**
  - **`POST /auth/signup` (PUBLIC)** — the platform's only unauthenticated write.
    One **atomic transaction** creates organization (`pending_review`) + company
    (name, CR, VAT) + admin user + active admin membership
    (`signup.repository.createTenant`, with unique-slug derivation), then logs the
    user in so they land on the status page. Strict dedicated rate limiter
    (**5/hour/IP**, separate from the credential limiter); duplicate email → 409;
    validation in `signup.service` (CR = 10 digits **required**, VAT = 15 digits
    starting/ending with 3 **optional** — not every entity is VAT-registered).
    Audited as `signup.completed`. **`/auth/register` stays admin-only** for an
    approved org to provision its own team.
  - **Applicant resubmit** — `POST /onboarding/resubmit` moves
    `needs_info → pending_review`, clearing the reason and re-stamping
    `verification_submitted_at`. The status guard is **in the UPDATE** (`WHERE
    status='needs_info'`) so a concurrent operator decision can't be clobbered
    (zero rows → 409). Audited (`verification.resubmitted`) and appended to the
    shared `verification_reviews` history with a **null operator** (an applicant
    action). `rejected` is NOT applicant-resubmittable — only an operator `reopen`.
  - **UI (functional, reusing the existing shadcn patterns):** `/signup`
    (public), `/verification` (status + reason + document upload + resubmit +
    sign-out), `/operator` (review queue → detail with CR/VAT + documents +
    history → approve / request-info / reject / reopen). Both `/verification` and
    `/operator` render **inside `AuthGuard` but OUTSIDE `Layout`** — the sidebar
    fires tenant-scoped queries that 403 for a gated org and for a
    membership-less operator.
  - **The gate drives the redirect centrally — across BOTH data paths.** The web
    app fetches two ways: hand-written call sites via `apiFetch` (`lib/api.ts`)
    and — for the dashboard and most business pages — the **generated** React
    Query client via `customFetch`. The single policy
    `handleApiErrorResponse(status, body)` in `lib/api.ts` redirects to
    `/verification` on `403 {code:"org_not_verified"}` and is invoked by **both**:
    directly by `apiFetch`, and by the generated client through the new
    **`setApiErrorHandler`** hook in
    `packages/api-client-react/src/custom-fetch.ts` (registered in `main.tsx`).
    That hook keeps the shared package route-agnostic. **This was a real bug found
    in manual browser testing:** covering only `apiFetch` left a gated org sitting
    on the dashboard shell while every query 403'd (the server-side gate held —
    no data was ever served — but the user was never redirected).
    `apiFetch` also now omits `Content-Type` for `FormData` (the browser must set
    the multipart boundary) and merges headers after `...init` (previously `init`
    could clobber them).
  - **Tests:** `tests/signup.test.ts` — validation + atomicity at the service
    level (kept off HTTP so the many cases don't burn the deliberately strict
    signup limiter), then the full loop over the real app: signup → gated 403 →
    operator request-info → applicant resubmit → operator approve → **the same
    business write now posts**; plus duplicate-email 409 and a rate-limit (429)
    assertion placed last (it poisons the IP for the window).
  - **Verified clickable end-to-end** against the running app through the Vite
    proxy (the exact path the UI uses): signup → status → gated 403 → **multipart
    document upload** → operator queue/detail → audited document download
    (attachment + nosniff) → request-info → resubmit → approve → business write
    201, with the full security-audit trail and review history correct.
- **M11.5.1 (done): SECURITY HOTFIX — CRITICAL-1 + audit follow-ups.** A read-only
  security audit of M11.1–M11.5 (four parallel reviews) found one CRITICAL, and it
  was fixed before any further feature work.
  - **CRITICAL-1 — public signup granted platform-wide admin.** Signup wrote
    `users.role = "admin"` and stamped `session.userRole = "admin"`; `/auth/*` is
    mounted **before** `resolveTenant` (so the verification gate never covered it)
    and its user-administration endpoints were guarded only by that ambient global
    role **with no organization filter**. Anyone could sign up and then
    `GET /auth/users` (every user on the platform) and
    `POST /auth/users/:id/reset-password` (take over **any** account — other
    tenants' admins, or the platform operator, then self-approve). Fixed on four
    fronts: (a) signup now creates a global **`viewer`** (authority comes from the
    `organization_memberships` admin row, as it always should have);
    (b) the session no longer receives a global admin role; (c) `/auth/register`
    and `/auth/users*` moved onto a new **org-scoped** `userAdmin.service` —
    the caller must be an active admin of an **approved** organization and may
    only see/modify users who are members of an org **they** administer (this also
    closes the *pre-existing* cross-tenant half: previously any admin could read
    and reset any user platform-wide); (d) role-enum validation on
    `PATCH /auth/users/:id` plus a dedicated rate limiter on the whole
    user-administration surface (it was entirely unthrottled, and `users.id` is a
    serial integer). **`requireRole`/`requireAdmin`/`requireAccountantOrAbove`
    were DELETED** from `lib/auth.ts` so the ambient-global-role pattern cannot be
    reintroduced. Locked in by `tests/user-admin-authz.test.ts` (13 tests, both
    directions: a self-signup user is denied every user-admin endpoint — including
    for its *own* org while unverified, preventing email-squatting — and a
    legitimate admin is confined to their own organization).
  - **HIGH-1 — document upload abuse.** Added a per-IP upload rate limiter and a
    **per-org quota** (`MAX_DOCUMENTS_PER_ORG` = 25, `MAX_TOTAL_BYTES_PER_ORG` =
    100 MB) checked in `documentsService.upload` **before** any bytes reach
    storage. Uploads are reachable pre-approval by design, so this was otherwise
    an open memory/storage-cost abuse surface.
  - **M-2 — operator decision TOCTOU.** `operator.service._transition` now applies
    the state change with a **conditional UPDATE**
    (`updateVerificationIfInState(... WHERE verification_status IN allowedFrom)`);
    zero rows ⇒ 409. Consistent with the pattern already used in
    `onboardingService.resubmit`.
  - **UI consequence handled:** `UserManagement` gated on the global `users.role`;
    it now gates on the caller's **membership** role in the active org (the server
    authorizes the same way), so a self-signup org owner isn't locked out.
- **M11.6 (done): company setup + ZATCA correctness — THE PRODUCTION BLOCKER IS
  CLOSED.** Invoice issuance now stamps the tenant's REAL ZATCA identity.
  - **`services/sellerIdentity.ts` is the single seam.** It replaces the
    `DEFAULT_SELLER_VAT` / `DEFAULT_SELLER_NAME` constants that were **duplicated**
    in `invoices.service.ts` and `invoices.approvable.ts` (a ZATCA *sandbox*
    placeholder that was fed into every QR and hash). Seller identity resolves
    from the **active company**, honoring an explicit per-invoice override.
    **There is deliberately NO fallback value:** `requireIssuanceSeller` **fails
    closed** with 400 `company_vat_missing` when no VAT number is configured, so
    the platform can never again mint a legally-invalid invoice. Draft creation
    stays lenient (`resolveDraftSeller`) — a draft is not a legal document.
  - **Tenant-scoped `companies` resource** — `GET/PATCH /companies/current`
    through route→controller→service→repository, behind
    `requirePermission("companies")` (matrix: **read = all roles, update = admin
    only**, since VAT/CR feed the QR and hash chain). The "active company" is the
    org's first-created company — the same rule `resolveTenant` uses, so the two
    never disagree. OpenAPI-first (`Company` + `UpdateCompanyInput`), client
    regenerated.
  - **Statutory validation lives in one place** — `lib/saudiIdentifiers.ts`
    (VAT = 15 digits starting/ending with 3; CR = 10 digits; postal = 5; building
    = 4), shared with signup. Duplicated constants are precisely what caused this
    blocker, so the rules are imported, never re-inlined.
  - **Schema (migration `0014`, additive/nullable):** `name_ar` plus the national
    short-address block (`building_number`, `street`, `district`, `city`,
    `postal_code`) — not needed by the Phase-1 QR or hash (so they don't gate
    issuance) but required for **ZATCA Phase 2**, added now to avoid a second
    migration.
  - **`fiscalYearStart` is stored and exposed but NOT yet wired into report
    periods** — reports still use calendar periods. That is a reporting change,
    deliberately out of scope here; the Company Settings UI says so explicitly.
    Tracked in the deferred list below.
  - **Company Settings UI** (`/company`, in the Settings nav) with a prominent
    warning when no VAT number is set ("invoices cannot be issued").
  - **Acceptance test** (`tests/company-zatca-identity.test.ts`): decodes the real
    base64 TLV QR (tag 1 = name, tag 2 = VAT) and **recomputes the invoice hash**,
    asserting it matches only when the COMPANY's VAT was the input and does NOT
    match the sandbox value; plus fail-closed-without-VAT, format validation, and
    a company VAT change flowing into the next issued invoice. Existing company
    fixtures across the approval suites now carry a real CR/VAT, and the invoice
    zero-movement + hash-chain suites still pass unchanged (M10 behavior intact).
- **M11.7 (done): invitations + multi-org member administration — Phase 1
  onboarding is COMPLETE.** An approved organization can now add its own team.
  - **`organization_invitations`** (migration `0015`, owner-only identity table).
    Only the **SHA-256 of the token** is stored — the raw 32-byte token
    (`lib/tokens.ts`) exists solely in the invite link, so a DB leak yields no
    usable invites. A **partial unique index** (`WHERE status='pending'`,
    hand-written — Drizzle can't express it) allows at most one live invite per
    (org, email) while retaining revoked/accepted rows as history. 7-day expiry
    (`INVITATION_EXPIRY_DAYS`).
  - **Admin surface** under `/orgs/:orgId/invitations` (send / list / resend /
    revoke) + `DELETE /orgs/:orgId/members/:userId` — identity layer, base
    connection, pre-`resolveTenant`, same explicit admin-of-THIS-org check. Member
    removal deactivates (preserving history) and respects the **last-admin
    guard**. `GET /orgs` now also returns each org's `verificationStatus`.
  - **PUBLIC accept** (`GET /invitations/:token`, `POST /invitations/:token/accept`),
    rate-limited, with both paths: an existing user accepts **while signed in**,
    and a new invitee sets name + password to create the user **atomically with**
    the membership.
  - **SECURITY — this is a public endpoint that mints a membership**, i.e. the
    same "self-grantable capability" shape as the M11.5.1 CRITICAL, so it was
    threat-modelled BEFORE implementation and each invariant has a test:
    (1) accepting writes a **non-privileged global `users.role`** — the invited
    role goes **only** to the membership; (2) the role is validated against
    `VALID_MEMBERSHIP_ROLES`, and since only an org admin (the highest org role)
    can invite, **no invite can grant more than the inviter holds**;
    (3) the org must be **`approved` to invite AND to be joined** — re-checked at
    accept time, blocking both email-squatting by an unvetted org and joining an
    org rejected after the invite was sent; (4) acceptance **claims the invitation
    with a conditional UPDATE** (`status='pending' AND expires_at > now()`), so a
    token can never be redeemed twice; (5) a signed-in acceptor's **email must
    match** the invited email; (6) unknown/valid tokens both return the same 404
    so guesses aren't confirmed.
  - **Provider-agnostic email** — `lib/mailer.ts` defines the `Mailer` seam with a
    **no-op** implementation that reports `delivered: false`; the API returns the
    invite **link** for the admin to share out of band. Integrating SES/Resend/
    Postmark later means implementing `send` and swapping the export — no change
    to the invitation service.
  - **UI:** invitations panel (invite / copy link / resend / revoke) and member
    removal in User Management, plus the public `/accept-invite` page.
  - **Tests:** `tests/invitations.test.ts` (20) covers the full lifecycle both
    over HTTP and at the service layer, and asserts every invariant above.

