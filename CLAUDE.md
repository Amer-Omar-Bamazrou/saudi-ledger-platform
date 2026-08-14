# CLAUDE.md

Guidance for Claude Code (and any AI agent) working in this repository.

> **This file is the OPERATING context only**: where things stand, what must not
> be broken, the standing checks, the pre-production queue, and conventions.
> The narrative history — per-milestone as-built records, the findings with
> their incidents and evidence — lives in [`docs/history/`](docs/history/) and
> is linked from here. **Keep it that way:** when a milestone closes, update
> §2 Current State here (a few lines + a link) and put the full record in
> `docs/history/`. This file must stay well under 100k characters; it was once
> 207k and truncated in every session that loaded it.

## 1. Project Overview

This is the **Saudi Ledger Platform** — an AI-powered Accounting & Finance
Operating Platform for Saudi Arabia, and later the wider GCC.

It began life as a single-tenant bookkeeping app and has been refactored into a
multi-tenant SaaS platform. The accounting core is real and correct — invoices,
bills, journal entries, GL posting, period locks, VAT, and Zakat all work today.
When in doubt, favor evolving the existing system over replacing it.

## 2. Current State

**Last updated: 2026-08-14 (post-audit fixes, Tiers 1–3 merged).**

**Audit close-out (2026-08-14):** two owner-approved read-only audits
(accounting correctness under adversarial input; disconnection sweep M13→A3)
found and fixed, in order: the VAT return's header-rate reconstruction
(mixed-rate/small/exempt documents vanished from the filing figure — now
line-level from `tax_category_code`), header≠Σlines rounding (BR-CO-14-invalid
UBL + GL imbalance — headers are now sums of rounded lines), the Categorize
run rewriting ACCEPTED rows (now gated to pending+operating at the repository),
"Z/E/O ⇒ no VAT" as DB CHECK 0034, settlement rows undeletable/uneditable,
A1's capture pipeline wired to its first caller (ScanReview → staged evidence),
A3's first frontend (+ the `ZATCA_WORKER_ENABLED` scope-drift fix — platform
jobs now always schedule), credit-aware outstanding everywhere on the
receivable side (aging nets notes and always agrees with GL AR), cash-flow
internal-movements bucketing, and honest kind badges in the transactions list.
Full findings: [`docs/history/findings-and-lessons.md`](docs/history/findings-and-lessons.md);
unfixed leftovers tracked under "Other open findings".
If this block disagrees with reality, fix it first.

### Where we are

| Phase | Status | Record |
| --- | --- | --- |
| **Phase 0** — Platform Foundation (M1–M10) | ✅ Complete. Multi-tenancy + RLS, auth/session hardening, RBAC, layering, CI/CD, audit logging, draft/approval workflow + 4-role model. | [`docs/history/phase-0-platform-foundation.md`](docs/history/phase-0-platform-foundation.md) |
| **Phase 1** — Onboarding & Multi-Company (M11.1–M11.7) | ✅ Complete. Self-service signup behind a verification gate, platform operators, document upload, company/ZATCA identity, invitations. Includes the M11.5.1 CRITICAL security hotfix. | [`docs/history/phase-1-onboarding-m11.md`](docs/history/phase-1-onboarding-m11.md) |
| **Phase 2** — ZATCA Phase 2 / Fatoora (M12) | 🟡 **Closed except M12.7 + M12.9**, blocked on a real Saudi taxpayer registration. Everything buildable without ZATCA credentials is done. | [`docs/history/phase-2-zatca-m12.md`](docs/history/phase-2-zatca-m12.md) + [`docs/zatca/m12-status.md`](docs/zatca/m12-status.md) |
| **M13** — Chart of accounts | ✅ Seeded system chart + `system_code` resolution in the posting path; income-statement classification fixed; balance-sheet AR/AP moved to the GL. | [`docs/feature-spec-chart-of-accounts.md`](docs/feature-spec-chart-of-accounts.md) |
| **M14** — Pre-production queue group A | ✅ 35-table `TRUNCATE`/`REFERENCES`/`TRIGGER` revokes + `ALTER DEFAULT PRIVILEGES` narrowed (with a throwaway-table guard test); identity-table build guard; company-scoped period-lock routes. | Queue §5 below |
| **M15** — Statement ingestion repair | ✅ Categorizer emits `system_code` (forcing-function test: every emittable code exists in the seeded chart); holding area / review surface for uploaded transactions. | [`docs/product/design-transaction-accounting.md`](docs/product/design-transaction-accounting.md) |
| **M16.1** — VAT page source switch | ✅ `VatReport.tsx` **files from documents** (`reports.vatReturn`, box-structured); the transaction figure is the **reconciliation view** beside it, gap itemised. (PR #25) | same design doc |
| **M16.2** — Transfers, treatment, accounts | ✅ `kind: operating\|transfer\|settlement` (transfers excluded from all P&L/tax aggregates, kept in cash flow); reconcile-grade S/Z/E/O `tax_treatment` defaulted from the category; `bank_account_id` + upload-page account picker. (PR #26) | same design doc — incl. the **treatment-verification-status flag** (most defaults are illustrative, not verified) |
| **M16.3** — Bank reconciliation | ✅ Exact-match suggestions (never actions) on the review surface; settling routes through the existing pay paths (`kind: settlement` + document links); real partial-payment semantics in pay (accumulate; overpay 409); the M15 review surface got its first UI consumer (`/review`). Live pass observed: settling a 3,450 receipt moved no income/VAT figure, cash flow +3,450, AR aging → 0. | design doc §3 (as-built + live-pass record) |
| **Automation** | **A1** ✅ document capture (client-side Tesseract OCR + ZATCA QR TLV decode, staged captures). **A3** ✅ recurring documents, **drafts only**. **A2** (bank feeds) not started — exploratory outreach only ([`docs/product/a2-provider-outreach.md`](docs/product/a2-provider-outreach.md)). | [`docs/product/feature-spec-automation.md`](docs/product/feature-spec-automation.md) |

**Product structure (the hubs) is DECIDED** — 2026-08-12, by owner interview:
two destinations (Finance Hub, Analytics), Automation and AI woven into existing
pages, Automation is the wedge. See
[`docs/product/hub-structure-decision.md`](docs/product/hub-structure-decision.md).
That decision record supersedes any earlier inferred hub description; only
Automation is specced to build-depth.

### 🔴 What is verified LIVE vs only LOCALLY (ZATCA)

Full detail: [`docs/zatca/m12-status.md`](docs/zatca/m12-status.md).

**Confirmed against the live ZATCA sandbox:** the CSR and `secp256k1` curve, the
XAdES properties and both digest encodings, all nine QR tags, six compliance
documents (standard + simplified × invoice / credit note / debit note, plus
zero-rated), and the ledger→ZATCA path built from real Postgres rows.

**🔴 NOT verified — we have never submitted an invoice to ZATCA.** The compliance
pass covers document **CONSTRUCTION** (`POST /compliance/invoices`, an
onboarding gate). The production path —
`POST /invoices/{clearance,reporting}/single` — has **never been called in any
environment**. Also local-only: the outbox transport (proven against a mock),
the archive (`local-fs` only), renewal reminders (synthetic dates), and the
enqueue path (self-signed certificate, not a real PCSID).

### What is blocked, and on what

A **registered Saudi company entity with an active ZATCA VAT registration and
ERAD credentials** does not exist. It is not a technical step; nothing unblocks
it except the owner registering the entity. It gates **two workstreams**:

- **ZATCA M12.7 (simulation) + M12.9 (production pilot).** No rework expected
  when it arrives — sandbox exercises the same API surface. **Do not** mock
  simulation to "finish" M12, and **do not** onboard a real tenant before both
  have run.
- **A2 bank connectivity** — signing with a SAMA-licensed open-banking provider
  almost certainly requires a Saudi CR. Conversations stay useful without the
  entity; **signatures do not**.

### THERE ARE NO CUSTOMERS YET (owner-confirmed 2026-08-12)

Schema changes, breaking API changes, renames and reversals are **cheap right
now** — no migration burden, no one to notify. That does **not** excuse
correctness in what is hard to retrofit (tenant isolation, the ZATCA chain,
audit trails, append-only guarantees, fail-closed posture) — those are cheap
now precisely because nobody depends on them, which is the argument for getting
them right now. **Revisit when the first tenant onboards.**

## 3. Standing rules, the standing check, and the named lessons

Full incidents and evidence: [`docs/history/findings-and-lessons.md`](docs/history/findings-and-lessons.md).
These are short forms; the rules are binding, the history explains why.

### The standing rules

1. **Correct is not connected.** Before recording a milestone done, verify
   every capability has a production **caller**, every field a production
   **writer**, every client a real **implementation** (not an interface plus a
   mock), and every live external result is recorded with **the endpoint that
   produced it and what that endpoint attests**. (Six live instances + seven
   retroactive.)
2. **Validate from real ledger rows.** Fixtures test the code you wrote; only
   real rows test the code you forgot to write. Every integration milestone
   needs at least one test that submits data read back out of Postgres,
   produced by the product's own write path.
3. **Re-run the LIVE VERIFICATION PASS at the end of every milestone touching
   the ingestion/tax path** (owner-mandated for all of M16; keep it beyond).
   Same fixture, live path (real HTTP → engine → Postgres), OBSERVED values —
   not test results. The M15 pass proved why: a test-verified fix coexisted
   with a live path still recording SAR 260.87 of phantom VAT through a rule
   no test asserted.

### The standing check (apply before recording any milestone as done)

1. Every capability has a production **caller** (grep the symbol; discard tests
   and comments).
2. Every field it depends on has a production **writer** (grep for writes, not
   references — a column only a migration back-fills is unbuilt).
3. Every client it depends on has a **real implementation** — if the only thing
   satisfying an interface lives in a test file, say so in the record.
4. Every **live external result** is recorded with the endpoint that produced
   it and what that endpoint attests — a pass on a validation endpoint does not
   cover the production path.
5. **Run the check on your own conclusions.** A claim of absence must carry its
   **search shape**: state what you searched for (the implementation shapes the
   capability could take) and what would have falsified the claim, so the
   search is reviewable, not only the conclusion. *(Two instances of getting
   this wrong: finding #7's OCR, M16.2's `bank_accounts` — both confidently
   reported, both acted on.)*
6. When a milestone **implements or moves** something, grep for tests asserting
   it is absent/unimplemented/throwing (`NotImplementedError`, `.rejects`,
   `toThrow`, `toBeNull`, `not.toContain`) and re-read each hit — an assertion
   of absence expires the day the thing is built.

### Named failure modes and lessons (one line each; full text in the findings file)

- **A shape without a consumer.** Declaring a column/table/interface/flag looks
  exactly like progress and ships unbuilt; endemic in a schema-first codebase —
  the standing check is the countermeasure.
- **An obsolete assertion** (a test that became a guard for the bug): a
  correct-when-written absence assertion stays green while certifying the
  defect. Prefer presence assertions.
- **Two id spaces with no forcing function** will diverge invisibly until
  something joins them. Remove the second space or add a test that fails when
  they drift (the M15 `system_code` fix).
- **The narrower-claim family** (findings #6, #9, #11): a suite's or page's
  NAME describes a capability while its fixtures/endpoint/source prove
  something narrower. Read the name as a claim; check the fixtures supply it.
- **Assert the property, not the number** — a fixed figure derived from
  unverified reasoning passes vacuously; change one thing, prove the figure
  does not move, and prove something else DID move.
- **An act about a document is not an act about a pattern.** Self-approve works
  because the approver sees the specific document; consent to a rule in January
  is not consent to what it produces in November. Rules never grant authority
  their creator lacks, re-checked at generation. (Why A3 is drafts-only.)
- **Partial data is not lenient data.** Leniency means salvaging the fields
  that WERE readable — never returning part of a value as the whole value
  ("150.00" truncated → "15"). Applies to every parser of data we didn't
  produce.
- **Who finds out?** Silence is not a neutral outcome. A "skipped" recurring
  invoice, an unsent reminder, an undrained queue — quiet neglect needs an
  alarm, not a dashboard (queue B1/B2; finding #10).
- **A name says who processed a movement, not what it was** (M16.2). Keyword
  rules keyed on an ENTITY (bank, gateway, government body) instead of an
  ACTION (fee, charge, commission) confidently misclassify everything that
  entity touches — the Tamara case turned revenue into expense. Check every
  trigger token: actor or action?
- **Green fixes the case, not the class** (finding #8). When a fix is "add a
  scope/guard/filter to X", grep for X's siblings before accepting green as
  done.
- **External validators check the weakest property they plausibly could** (the
  PIH/base64 lesson). Validate meaning locally; never infer correctness from an
  accepted submission.
- **Sources rank LIVE API > SDK > PDF > secondary sources** — and an unread
  primary source is not a licence to trust a secondary one (the residency
  claim was the opposite of what §5.5 actually says).
- **Enforce invariants at the WRITE BOUNDARY, not in one path** (audit
  close-out). An invariant three writers can violate belongs in a DB CHECK or
  a shared gate, not in per-path code — per-path enforcement is per-path
  review, and a new path starts at zero. Corollary: **when line-level truth
  exists, header-level arithmetic is a second computation of the same fact**
  and will drift — classify/derive from the finer grain.
- **A flag's scope drifts past its name** when the thing it gates becomes
  shared infrastructure (ZATCA_WORKER_ENABLED silently disabled every
  non-ZATCA job). Move the gate WITH the thing the flag names.

## 4. Active constraints — do not break these

### Architecture

- **Route → Controller → Service → Repository.** HTTP in routes/controllers,
  logic in services, every query in a tenant-scoped repository. The accounting
  core (`services/accounting/` — glPosting, periodLock, zatca — and
  `services/categorization/`) is the sanctioned exception with direct `db`
  access. See [`docs/development-guide.md`](docs/development-guide.md).
- **Everything is tenant-scoped.** Every business table carries
  `organization_id` (NOT NULL, RLS `tenant_isolation` policy off the
  `app.current_org_id` GUC); every query filters by tenant. RLS is enforced at
  runtime via per-request transactions on a non-owner role.
- **🔴 `organizations`, `users`, `organization_memberships` are OUTSIDE RLS.**
  Business-layer code (`services/`, `repositories/`) must not read them — a
  forgotten filter there is a silent cross-tenant leak nothing catches. The
  identity layer (pre-`resolveTenant`, owner connection, explicit authz) is the
  only correct consumer. Enforced by `tests/identity-table-boundary.test.ts`
  (import-matching only — raw SQL slips past). If the business layer genuinely
  needs them, that is a design decision, not a lint exception.
- **OpenAPI-first with codegen.** `packages/api-spec/openapi.yaml` is the
  contract: change the spec, run
  `pnpm --filter @workspace/api-spec run codegen`, then implement. Never
  hand-edit `src/generated/**`. **Exception:**
  `packages/api-client-react/src/custom-fetch.ts` is HAND-MAINTAINED (orval's
  mutator — cookie credentials + the `setApiErrorHandler` verification-gate
  hook); commit changes to it deliberately.
- **A privilege that becomes self-grantable invalidates every guard that trusts
  it** (the M11.5.1 CRITICAL). When a change makes a role/flag/capability
  obtainable by a less-trusted party, re-audit every guard that trusts it.
  `users.role` is vestigial and must never gate access — the
  `organization_memberships` role governs. Prefer explicit, scoped authz
  (`requirePermission`, admin-of-THIS-org, `requirePlatformOperator`) over any
  ambient global role.
- **AI proposes; it never posts.** The GL is only written through the
  established posting path; AI/automation output is drafts and suggestions a
  human approves.
- **One writer per effect — no parallel posting paths.** New features route
  money through the existing paths (`invoicesService.pay`, `billsService.pay`,
  the approval engine's `onApprove`), never a second path to the same ledger
  effect.

### Accounting and tax invariants

- **Documents FILE; transactions RECONCILE** (M16 Q0). The VAT return reads
  invoices + bills (S/Z/E/O per line, credit-note-correct, box-structured);
  the transaction-derived figure is a reconciliation view only. Transaction
  `tax_treatment` is reconcile-grade: no VATEX codes, `null` = unknown is
  first-class, VAT extracted only for 'S'. **Most seeded treatment defaults
  are illustrative, not verified** — see the verification-status flag in
  [`docs/product/design-transaction-accounting.md`](docs/product/design-transaction-accounting.md).
- **Amounts are stored POSITIVE; direction lives in `document_type`.** Every
  consumer applies `documentSign()` explicitly. A credit note reverses; a
  **debit note does NOT** (it posts like an invoice).
- **`kind: transfer` / `kind: settlement` rows are excluded from income,
  expense, VAT, Zakat and budget aggregates** (`taxVisible()` in the
  repositories); cash flow alone keeps them — the bank balance moved even
  though nothing was earned or spent.
- **Nothing affects the books before approval.** Drafts/submitted records move
  zero in every report (the zero-movement test standard — replicate it for any
  new approvable entity). Invoice hash/QR/AR are minted only at approval;
  drafts consume no ICV.
- **Period locks are company-scoped** (posting path AND routes). A correction
  to a closed period posts in the current open period — never re-date into a
  closed period, and never silently skip (a blocked run must fail loudly and
  be recorded).
- **Accepting the match IS the review** (M16 principle): one user act both
  accepts a held row and records its effect. A second nested confirmation of
  the same fact is a design defect, not extra safety.

### ZATCA operating rules

- **Trust order: LIVE API > SDK > PDF.** The gate is
  `tests/zatca-compliance-live.test.ts`; a green SDK differential is NOT
  evidence of compliance (it passed byte-for-byte while the live API rejected
  the QR). Divergence log:
  [`docs/zatca/spec-vs-implementation-divergences.md`](docs/zatca/spec-vs-implementation-divergences.md).
- **Sandbox traps:** it accepts ANY OTP; `requestID` is a constant stub; the
  sandbox PCSID is a shared canned certificate not bound to our key
  (`activateCredential` verifies the key and refuses a mismatch); a PCSID is
  issued even when compliance documents FAIL — assert compliance results
  directly, never infer from certificate issuance.
- **Issuance FAILS CLOSED for onboarded companies** (deliberate, owner-approved):
  if the document cannot be built/signed, the approval rolls back — a KMS
  outage stops invoicing rather than minting an unreachable invoice and a
  permanent ICV gap. Companies with no active credential are skipped silently
  and issue as before. Revisit diagnosability before a real taxpayer (queue C5).
- **The chain needs two mechanisms:** allocation serialised by
  `lockCompanySequence` (advisory lock covering the ICV read AND chain-head
  read), and ordering by **`icv DESC NULLS LAST, id DESC`** — never row id.
  `unique(company_id, icv)` is a backstop that structurally cannot see a fork.
  Out-of-order approvals fork the chain **sequentially** — this is not purely a
  concurrency bug.
- **Our homegrown hash chain is NOT ZATCA's chain.** `invoices.invoice_hash` /
  `previous_hash` are the homegrown tamper-evidence mechanism; the legally
  meaningful chain lives on `einvoice_documents`. The ZATCA PIH comes from
  `einvoice_documents` only, read inside the sequence lock.
- **`ArchiveStore` has no `delete`, by design** (ZATCA §5.5 forbids deletion) —
  never add one; deletable staging is a separate interface (queue B3). Archive
  filenames use the **GENERATION** timestamp (`invoices.issued_at`), never
  clearance. Cloud storage is permitted; the binding constraint is a direct
  audit link (`ArchiveStore.directLink`).
- **Owner-only tables must REVOKE explicitly.** Supabase's base
  `ALTER DEFAULT PRIVILEGES` re-grants `TRUNCATE`/`REFERENCES`/`TRIGGER` on
  every `CREATE TABLE`, and **TRUNCATE bypasses RLS**. The defaults are
  narrowed (M14) and a throwaway-table guard test pins it; keep the pattern
  for any new table, and verify with `information_schema.role_table_grants`,
  never estimate from the schema.
- **Certificate renewal requires the TENANT's own OTP** — the platform cannot
  renew unattended; lead time is the entire value of the reminders (queue B1).
- **All four `EInvoiceProvider` methods route through the seam**
  (onboard / renewCertificate / buildDocument / submit) — it is one of the two
  mandatory hedges behind the build-direct decision. Do not bypass it.

## 5. Pre-production queue (the single list)

Everything that must close before a real taxpayer is onboarded. Nothing here
blocks ordinary platform work.

**A. ✅ CLOSED IN M14 — grants and configuration:**

| # | Item | Outcome |
| --- | --- | --- |
| A1/A2 | `REVOKE TRUNCATE/REFERENCES/TRIGGER` from the app roles | ✅ Done — **35 tables**, plus `ALTER DEFAULT PRIVILEGES` narrowed so the next `CREATE TABLE` cannot silently re-grant; guarded by a throwaway-table test. |
| A3 | Guard on `organizations`/`users`/`organization_memberships` | ✅ **Build guard** (`tests/identity-table-boundary.test.ts`); RLS rejected — policies there would be exercised by no traffic (all legitimate consumers bypass RLS on the owner connection). |
| A4 | Period locks ignored `company_id` | ✅ Posting path (M13) + routes (M14). The route bug was the serious one: one company's unlock **deleted every other company's lock**, silently reopening closed books. |

**B. 🔴 BLOCKING — a reminder that reaches nobody, and the PDPL problem in concrete form:**

| # | Item | Why it blocks |
| --- | --- | --- |
| **B1** | **EMAIL DELIVERY.** `lib/mailer.ts` is still `noopMailer` (logs, returns `delivered: false`). Implement `send` and swap the export; nothing else changes. Options: AWS SES (~$0.10/1,000, most setup), Resend (free to 3,000/mo), Postmark (~$15/mo). | The renewal reminder's entire value is **lead time for an action only the tenant can take** (fresh CSR + an OTP from THEIR Fatoora portal). Today no message reaches anyone; at expiry signing stops dead and the tenant cannot legally invoice. |
| **B2** | **VISIBILITY IS NOT ALERTING.** The operator panel surfaces the outbox age and PCSID expiry; **nothing pages a human**. Wire `listOverdue()` and `renewalService` to real alerting (PagerDuty/Opsgenie/webhook). | Both failures are **quiet neglect, not loud rejection**. A simplified invoice silently missing ZATCA's 24-hour reporting deadline looks like nothing is wrong (tenant fines from SAR 5,000); an expiring PCSID looks fine until it stops signing. Nobody looks at a panel that is usually green. |
| **B3** | **STAGED CAPTURES CANNOT BE DELETED ON CLOUD.** `ArchiveStore` has no `delete` by design and must stay that way; so `stagingStore.remove` is `local-fs` only — on `supabase-storage` an abandoned capture's bytes remain forever. Fix with a **separate deletable-staging interface**, never by weakening `ArchiveStore`. **Audit note (2026-08-14): until the audit fixes, the capture pipeline had NO production caller — nothing staged any bytes, so this item was reasoning about a pipeline nothing fed (and bills posted from scans stored no evidence at all, undercutting C7). The pipeline is wired now; B3 is live in practice.** | This is the **PDPL problem in concrete form**: staging exists precisely so an abandoned photograph (possibly a third party's personal data) does not become permanent. **B3, C7 and C8 are one question in three parts** — B3 is the technical half of whatever C8 answers. |

**C. Verification and coverage gaps:**

| # | Item | Where recorded |
| --- | --- | --- |
| C1 | **Trusted proxy + shared rate-limit store — an INTRODUCTION, not a migration.** (a) Confirm exactly one trusted proxy overwrites `X-Forwarded-For` (`trust proxy` is production-only; a spoofable header makes every IP-keyed limiter a no-op). (b) Limiters are in-memory per-process, so horizontal scaling silently multiplies every limit. **Redis does not exist in this project** — introducing a shared store is new infrastructure with a new failure domain, or pick a Postgres-backed limiter instead. | M11 audit + finding S3 |
| C2 | **CI storage gap** — the M11.4 document tests skip in CI (no Supabase Storage service); a green CI does not prove the storage path. | Known CI gap |
| C3 | **KMS deployment verification** — IAM/key policy, 30-day deletion window, break-glass-only `kms:ScheduleKeyDeletion`, CloudTrail alarm on deletion attempts, multi-region CMK replica. If the CMK dies, every tenant must re-onboard. | [`docs/history/phase-2-zatca-m12.md`](docs/history/phase-2-zatca-m12.md) |
| C4 | **AV scanning** on uploaded verification documents before untrusted-tenant growth (magic-byte sniff is header-only — M-5). Seam: `documents.service.upload`. | M11.4 follow-up |
| C5 | **Fail-closed diagnosability** — confirm a blocked issuance surfaces an actionable message (which field, which company, what to fix), not an opaque 500. | M12.8 decision |
| C6 | **Data residency / hosting region** — ZATCA permits cloud (the "must be in KSA" claim was a secondary-source error); NCA / sector rules are **unverified legal questions**. Choose host and KMS region together. No hosted Supabase project exists yet — this is a deployment decision, not a migration. | Residency correction, phase-2 history |
| C7 | **TAX ADVICE — retention of INBOUND supplier documents.** A1 retains captures to the 6/11-year outbound standard as a conservative default, not a settled reading. **Answer together with C8, same advisor.** | A1 (Q4) |
| C9 | **Verify the remaining tax-treatment defaults against KSA VAT rules.** Only `BANK_CHARGES` and `INSURANCE` have been checked (M16.2); every other seeded default is an assumed majority-'S' or a reasoned-but-unresearched O/E. The distinction is DATA (`treatment_verified`, M16.3.1) and assumed treatments surface as overridable-with-a-hint — but the flags only flip on an actual rule lookup. **Check FIRST (owner-prioritised — these hit most tenants):** (1) `FOOD_MEALS` — KSA blocks input-VAT recovery on meals/entertainment, so 'S' extraction overstates recoverable input VAT for nearly every SME; (2) **reverse-charge foreign digital services** (Google/Meta ads under `MARKETING`/`IT_SOFTWARE`) — the bank debit contains no VAT, so extraction invents input VAT never paid. Then: residential rent E (`RENTAL_INCOME`, `RENT_UTILITIES`), international transport Z (`FUEL_TRANSPORT`), exports Z (`SALES`), loan interest E vs principal O. Reconcile-grade only — but a user-visible guess until closed. | Design doc §1 verification-status flag |
| C8 | **PDPL — higher priority than C7 and answered with it.** Phone photographs will eventually contain third-party personal data; PDPL grants erasure rights that may conflict with retention. **PDPL has never been considered anywhere in this project** — scope it to the platform (audit logs hold IPs append-only; the archive holds names/addresses 6–11 years; `users`/`customers`/`employees` have no retention policy), not just document capture. | A1 |

Re-check the hosted project's default privileges when it exists — they may
differ from the local Supabase CLI stack where all of this was measured.

### Other open findings (small, non-blocking)

Full text and history: [`docs/history/known-issues-and-audit-findings.md`](docs/history/known-issues-and-audit-findings.md).

- **M-3**: signup duplicate-email race surfaces as 500 (map Postgres `23505` → `ConflictError`).
- **M-4**: `bcryptjs` blocks the event loop on public endpoints; no max-length validation before `varchar(255)` (raw 500s).
- **M-5**: magic-byte sniff is header-only (closes with C4's AV work).
- **L-1**: security-audit write failures only `console.error` — route through `pino` and alert on the pattern.
- **L-2**: signup 409 leaks account existence (accepted; document inline).
- **L-3**: primary-membership tie-break is non-deterministic (`createdAt` only; add `id`).
- **L-4**: the operator queue list is unaudited (accepted trade-off).
- **`companies.fiscalYearStart` is stored but not applied** — reports use calendar periods; the Company Settings UI says so.
- **S6/S7 traps**: `feature_flags`, `branches`, `departments` are tables with **no consumer** — do not assume they work; build a consumer or drop them.
- **Feature (deferred)**: action-level permissions for separation-of-duties (post-to-GL / pay / approve individually gateable).
- **Audit leftovers (2026-08-14, deliberately not fixed — tracked):** manual
  transaction create has no `kind`/`taxTreatment` fields, so every manual
  VAT-bearing entry is a null-treatment row with user-asserted VAT (by-design-
  adjacent; fields worth adding); sub-cent amounts via raw API can mark a
  document paid with a 1-halala GL residual (round `paid` at the validation
  gate — unreachable from UI/settlement); budget actuals `sum(amount)` ignores
  debit/credit so a refund increases "spent"; the income-statement
  transactions-FALLBACK (zero journal lines only) reports gross incl. VAT;
  settlement links are readable from the transaction side only (no invoice/
  bill-side surface, design said "either side"); the Categories UI cannot mark
  system accounts (`isSystem` not in the API — latent, no edit routes exist);
  `status: 'overdue'` has NO writer on invoices or bills (dead enum value; UIs
  style it, aging derives overdue from dates); VAT-return box 4 (exports) is
  always 0 — an export today is a 'Z' line in box 2.

## 6. Tech Stack

| Layer         | Technology                                                               |
| ------------- | ------------------------------------------------------------------------ |
| Monorepo      | pnpm workspaces (`apps/*`, `packages/*`, `scripts`)                      |
| Backend       | Express 5, TypeScript, Node.js (ESM), esbuild bundle                     |
| Frontend      | React 19, Vite, TypeScript, Tailwind CSS v4, shadcn/ui                   |
| Routing (FE)  | Wouter                                                                   |
| Data fetching | TanStack Query (React Query v5)                                          |
| ORM           | Drizzle ORM                                                              |
| Database      | PostgreSQL (via Supabase — Postgres only, NOT Supabase Auth)             |
| Cache / queue | **None.** No Redis — rate limiting is in-memory per-process (queue C1); background work runs on the in-process scheduler in `apps/api/src/jobs/`. Add an entry here **when it runs**, not when it is decided. |
| Auth          | Express session auth (`express-session` + `connect-pg-simple`, bcryptjs) |
| API contract  | OpenAPI-first (`packages/api-spec/openapi.yaml`) with orval codegen      |
| Validation    | Zod (generated into `@workspace/api-zod`)                                |
| i18n          | Custom `LanguageContext` (Arabic / English, RTL-aware)                   |
| Logging       | pino / pino-http                                                         |

## 7. Repository Layout

```
apps/
  api/               @workspace/api-server — Express 5 backend
    src/
      routes/        thin HTTP (validate → controller); one file per entity
      controllers/   orchestrate + shape responses (no DB)
      services/      business logic; services/accounting/ (glPosting,
                     periodLock, zatca) + services/categorization/ are the
                     accounting core (sanctioned direct-db exception);
                     services/einvoice/ is the ZATCA pipeline;
                     services/approval/ is the generic draft/approval engine
      repositories/  ALL Drizzle access, tenant-scoped via RLS
      jobs/          in-process scheduler (outbox worker, archive sweep,
                     renewal check)
      lib/           infra + auth (auth.ts, rbac.ts, tenant.ts, operator.ts,
                     errors.ts, mailer.ts, storage.ts, saudiIdentifiers.ts)
      app.ts         Express wiring (session, middleware, router)
  web/               @workspace/bookkeeping — React 19 + Vite frontend
packages/
  db/                @workspace/db — Drizzle schema + pg pool (source of truth)
    src/schema/      one file per table
    migrations/      versioned SQL migrations (drizzle-kit generate)
  api-spec/          OpenAPI spec + orval config (codegen)
  api-zod/           generated Zod schemas/types
  api-client-react/  generated React Query client (+ hand-maintained
                     src/custom-fetch.ts — see §4)
  config/            @workspace/config — validated env (loadEnv, fail-fast)
scripts/
docs/                specs, product design docs, docs/zatca/, docs/history/
```

There is deliberately **no `packages/auth`** — auth/RBAC live in
`apps/api/src/lib/` after six milestones of work there; the empty scaffold was
deleted at the M12 close-out. Workspace package names are unchanged; `pnpm
--filter` uses package names, not folder paths.

## 8. Key Architectural Principles

1. **Preserve the accounting core** (`services/accounting/`): balanced
   double-entry, closed-period enforcement, and tax rules are correct and
   tested. Extend and wrap; do not reinvent.
2. **Everything is tenant-scoped** (§4).
3. **Route → Controller → Service → Repository** for all new code (§4).
4. **OpenAPI-first with codegen** (§4).
5. **A self-grantable privilege invalidates every guard that trusts it** (§4).
6. **AI proposes; it never posts** (§4).

## 9. What NOT to Do

- **Do not** rewrite working accounting logic (GL posting, period locks,
  VAT/Zakat). Build on it.
- **Do not** use Supabase Auth. Supabase is Postgres only; auth stays Express
  sessions.
- **Do not** skip tenant scoping — no business table without `organization_id`,
  no query without an organization filter.
- **Do not** put business logic in route handlers.
- **Do not** bypass the OpenAPI → codegen flow or hand-edit
  `packages/*/src/generated/**`.
- **Do not** let AI or automation write to the ledger directly — and never add
  a second posting path for an effect that already has one.
- **Do not** auto-apply matches or auto-issue from rules, however exact the
  match — suggestions are pre-selected, the human clicks.
- **Do not** read `organizations`/`users`/`organization_memberships` from the
  business layer (§4).
- **Do not** add a `delete` to `ArchiveStore`, and do not weaken the owner-only
  table REVOKE pattern.

## 10. Reference Docs

Operating references:

- `README.md` — overview and quick start; `docs/local-setup.md` — run locally.
- [`docs/development-guide.md`](docs/development-guide.md) — layering,
  tenancy/RLS, RBAC, audit, "add a new domain" cookbook. Read before backend
  work.
- `CONTRIBUTING.md` — branch strategy, commit conventions, PR checklist.
- [`docs/architecture-blueprint.md`](docs/architecture-blueprint.md) — target
  architecture.
- [`docs/test-suite-notes.md`](docs/test-suite-notes.md) — 🔴 test-suite
  order/timing fragilities. The diagnostic: *passes alone, fails in the full
  run* = shared state, not a regression. Do NOT fix with
  `fileParallelism: false` or by raising rate limits.
- [`docs/product/hub-structure-decision.md`](docs/product/hub-structure-decision.md),
  [`docs/product/design-transaction-accounting.md`](docs/product/design-transaction-accounting.md),
  [`docs/product/feature-spec-automation.md`](docs/product/feature-spec-automation.md)
  — product decisions in force.
- `docs/zatca/` — README (environments), `m12-status.md` (what is proven,
  where), `spec-vs-implementation-divergences.md` (all 13, with evidence),
  `security-standards-notes.md`, `m12-5-credential-vault-design.md`.

History (the full narrative this file used to carry):

- [`docs/history/phase-0-platform-foundation.md`](docs/history/phase-0-platform-foundation.md) — M1–M10 as built.
- [`docs/history/phase-1-onboarding-m11.md`](docs/history/phase-1-onboarding-m11.md) — M11.1–M11.7 + the M11.5.1 hotfix.
- [`docs/history/phase-2-zatca-m12.md`](docs/history/phase-2-zatca-m12.md) — M12 sub-milestones, decisions, landmines, residency correction, KMS requirements.
- [`docs/history/findings-and-lessons.md`](docs/history/findings-and-lessons.md) — findings #1–#11, S1–S7, the named failure modes with incidents.
- [`docs/history/known-issues-and-audit-findings.md`](docs/history/known-issues-and-audit-findings.md) — audit findings, resolved-issue history.

## 11. Development Conventions

- **Small milestones**, one concern per PR; squash-merge with
  `type(scope): Mxx — summary` commit style (see git log).
- **Explain before implementing** for non-trivial changes.
- **Test everything** — especially money, GL, tax, tenant isolation. New
  approvable entities replicate the zero-movement test; ingestion/tax
  milestones end with the live verification pass (standing rule 3).
- **Milestone close-out:** run the standing check (§3, all six parts), update
  §2 Current State here, and put the narrative record in `docs/history/` — not
  in this file.
- **pnpm only** (a preinstall guard rejects npm/yarn).
- **Typecheck** with `pnpm run typecheck` before considering work done.

### Common commands

```bash
pnpm install                                         # install all workspaces
pnpm --filter @workspace/api-server run dev          # run the API server
pnpm --filter @workspace/bookkeeping run dev         # run the frontend
pnpm --filter @workspace/db run generate             # generate a versioned SQL migration
pnpm --filter @workspace/db run migrate              # apply pending migrations
pnpm --filter @workspace/db run seed                 # idempotently seed the default org + company
pnpm --filter @workspace/db run test                 # DB tests incl. RLS isolation (needs DATABASE_URL)
pnpm --filter @workspace/api-spec run codegen        # regenerate API client + Zod
pnpm --filter @workspace/api-server run test         # backend tests (Vitest)
pnpm run typecheck                                   # typecheck the whole repo
```
