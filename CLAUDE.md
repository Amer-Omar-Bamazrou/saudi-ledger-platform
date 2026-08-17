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

**Last updated: 2026-08-17 (M20.1 — reports open on the tenant's fiscal year; M20.2 shortcuts next).**

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
| **Demo deployment** | ✅ **Codebase demo-ready; nothing deployed.** `DEMO_MODE` REMOVES capabilities and weakens no guard: capture, signup and ZATCA onboarding are refused **at the route**, ZATCA transmission is refused **at boot**, a server-driven bilingual banner runs on every page incl. login, and a weekly reset wipes + re-seeds in one transaction. 🔴 The reset's safety is **structural, not the flag**: it refuses unless the database holds exactly one organization and it is the demo. Seed data is posted through the product's own write paths and starts **claimable**, so uploading a statement demonstrates the liquidity claim being withheld. Also new: `SERVE_WEB_DIST` (default unset) lets the API serve the SPA same-origin — a cookie decision, not a cost one. | [`docs/product/demo-deployment-decisions.md`](docs/product/demo-deployment-decisions.md) + [runbook](docs/product/demo-deployment-runbook.md) |
| **M19.6** — receivables bridge | ✅ Analytics now shows **Invoiced vs Collected** (flows) and **receivables outstanding** (stock) on separate canvases, plus the bridge as numbers: `opening + invoiced − collected − credited − other = closing`. 🔴 The identity is **structural, not checked** — every term is a debit or credit on ONE GL account, so `closing` IS the balance-sheet AR figure rather than agreeing with it. **Two items of §6.1 are deliberately NOT built:** net cash per period is HELD on a source question (`reports.cashFlow` is transaction-derived and disagrees with GL cash by a measured 10,800 on the dev org — transfers never post, and document payments create no transaction), and the historical overdue share is **not derivable** at all (no dated payment history). | [`docs/product/design-analytics.md`](docs/product/design-analytics.md) §6.1 |
| **M19.7** — cash, as two named figures | ✅ **Bank movement** (accepted transactions, all kinds — what the statement shows) beside **Ledger cash** (movement on cash-classified GL accounts), with the gap **itemised to a remainder of zero**. The M16 Q0 discipline applied to cash: two numbers are tolerable only when each states its question and the difference is accounted for line by line — `unexplained` is returned, not asserted, so the page can say a reconciliation failed rather than present a tidy list that does not add up. 🔴 **An INTERIM, and the card says so:** it makes the disagreement legible, not resolved — neither figure can be right about transfers until B5 records where the money went. Owner's sequence: **C (done) → D (B5) → A (GL owns cash)**. | [`docs/product/design-analytics.md`](docs/product/design-analytics.md) §6.1 |
| **Automation** | **A1** ✅ document capture (client-side Tesseract OCR + ZATCA QR TLV decode, staged captures). **A3** ✅ recurring documents, **drafts only**. **A2** (bank feeds) not started — exploratory outreach only ([`docs/product/a2-provider-outreach.md`](docs/product/a2-provider-outreach.md)). | [`docs/product/feature-spec-automation.md`](docs/product/feature-spec-automation.md) |
| **M17.0** — Zakat: retire the fake surface | ✅ The Zakat page **states it is not implemented**; `is_zakat_relevant` / `zakat_relevant` deleted everywhere (migration 0038) and `GET /summary/zakat` removed. | [`docs/product/design-zakat-module.md`](docs/product/design-zakat-module.md) |
| **M17.1** — Zakat ownership scope | ✅ Q2: `companies.ownership_type` (`SAUDI_GCC\|FOREIGN\|MIXED`, migration 0040), **nullable with NO default** — NULL = not declared is a first-class state, because a default would have the platform assert the tenant's ownership and that assertion gates the Zakat surface. The page branches **three** ways (ask / module / out-of-scope-see-your-advisor); a declaration can be withdrawn. Rule lives in `lib/zakatScope.ts` — 🔴 **M17.4's endpoint must call it and refuse non-`eligible`.** | same design doc §5b |
| **M17.2** — Fiscal year + calendar | ✅ Q3's stated prerequisite, and it closes a five-milestone gap: `fiscalYearStart` is finally resolved. `fiscal_calendar` (gregorian \| **Umm al-Qura** hijri, migration 0039 + two CHECKs), a pure resolver (`lib/fiscalYear.ts`), Hijri conversion by **binary search over the ICU tables** (`lib/hijriCalendar.ts` — an arithmetic estimate was tried and is wrong, months are tabulated), a **boot assertion** that refuses to start on a small-ICU runtime, `GET /companies/current/fiscal-years`, and Company Settings showing real boundaries. **Reports still take explicit dates** — see the known-issue note. | same design doc §3 |
| **M20.0** — the lying column | ✅ Migration 0044: `fiscal_year_start` nullable, NO default, **existing rows NULLed** (the 1s were the old default, not data). `GET /companies/current/fiscal-years` returns `declared: false` when undeclared; `null` on update WITHDRAWS. 🔴 Also fixed: Company Settings' submit coerced `?? 1`, so saving an ADDRESS would have re-declared January — the write-boundary corollary (§3). Part 6 fired: the suite's first test guarded the defect; rewritten. (PR #47) | [`docs/product/design-fiscal-periods.md`](docs/product/design-fiscal-periods.md) §8 |
| **M20.1** — report default windows | ✅ Sixteen report pages open on the tenant's **current fiscal year** (resolver boundaries, Gregorian or Hijri) or a **rolling last 12 months** when undeclared, with the F13 inline notice on the report itself. One data hook (`useReportDefaultRange`) owns the decision; the bespoke date controls stay (F5). A failed settings fetch falls back with NO notice — the page won't assert what it doesn't know. Release note shipped (reports change on open with no user action). `VatReport` verified OUT of the class (opens empty, asserts nothing). (PR #48) | same design doc §8 + [release note](docs/release-notes/m20-1-report-default-windows.md) |
| **M20.2** — period shortcuts | ✅ Six shortcuts on all **twenty** report pages (F12), F6 as stated: a shortcut SETS the dates and applies them, inputs stay editable, the lit chip is **derived by equality** so "Custom when touched" needs no state. Month/quarter = **CALENDAR** periods (the filing rhythm; the only definition an undeclared tenant has); the fiscal pair uses API boundaries and is absent while undeclared; Balance Sheet gets both FY-ends. Beyond M20.1's sixteen: ActivityReport, GlReport, BalanceSheet, VatReport (month granularity). (PR #50) | same design doc §8 |
| **M20.3** — fiscal-year labels | ✅ `FY 1447 (Jun 2025 – Jun 2026)` wherever a period is named — one pure formatter (`lib/fiscalLabel.ts`, tested against the design's example verbatim), NO client-side calendar math (the API payload already carries everything; client Hijri arithmetic would reintroduce M17.2's silent-substitution hazard). Applied at Company Settings' fiscal-year card + as tooltips on M20.2's fiscal chips. **M20 complete.** (PR #51) | same design doc §8 |

**Zakat is DECIDED but NOT BUILT** — 2026-08-15, by owner interview (Q1–Q8). The
platform produces an **auditable working paper**, never a ZATCA submission;
**100% Saudi/GCC-owned entities only** in v1; **Hijri and Gregorian** fiscal
years (fiscal-year support is a stated **prerequisite** — `fiscalYearStart` is
stored today and applied by no report); the base is derived **from the GL**;
the worksheet is an **interactive, period-locked input surface**; it lands as an
annual report generator under **Tax & Compliance**. 🔴 **The tax content itself
is UNVERIFIED against a primary source** — base composition, the Gregorian rate
divisor, minimum-base rules, and whether nisab applies to corporate Zakat at
all. M17.4 must not show a tenant a figure before that is closed (design doc §4;
ask with the C7/C8 advisor).

**Fiscal periods in reports — DECIDED (F1–F13), M20 COMPLETE + F3-dual BUILT
(2026-08-17).** Both defects F1–F9 surfaced are FIXED (the lying
`NOT NULL DEFAULT 1` column, M20.0; the hardcoded Jan–Dec default window,
M20.1); six period shortcuts are on every report (M20.2); fiscal years are
named by their span (M20.3); and a Hijri tenant reads BOTH calendars on
every ledger date (**F3-dual**, PR #52 — one shared `DualDate` component
over 42 render sites, with a client-side probe of the M17.2 fact that
REFUSES to render Hijri on a runtime that would silently substitute
Gregorian; fallback in every failure direction is Gregorian-only). **F7-cmp
BUILT** (PR #53): prior-period comparison on the three statements — the
prior window DERIVED from what the dates are (fiscal → the resolver's
preceding period, never calendar-minus-one, which is ~11 days off a Hijri
year; month/quarter → exact shift; custom → labelled calendar shift); an
empty prior is a NAMED fact, never zero columns; Δ% is "—" on a zero base;
🔴 mismatched sources (journal vs transactions-fallback) REFUSE with a
stated reason — a prevented #9 instance, recorded in the findings file;
line merge by response-carried KEY, never display name. Next in the
owner-approved order (§7): A (GL owns cash), then B4. Standing decisions: free dates plus shortcuts
(nothing period-only); NO in-table Hijri date conversion (dual display is
alongside, never instead); Analytics out of scope; the twenty bespoke date
controls stay duplicated until a third pattern appears.
See [`docs/product/design-fiscal-periods.md`](docs/product/design-fiscal-periods.md)
(§7 build order, §8 as built).

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

1. Every capability has a production **caller**, and the caller chain
   **terminates at a real entry point** — grep the symbol, discard tests and
   comments, then keep following it up. 🔴 **Name the terminus:** a UI surface
   in `apps/web`, an operator surface, or a job `start()` actually schedules.
   Stopping at the HTTP boundary is why this check said *yes* for A1's capture
   pipeline and A3's recurring rules while neither was reachable from the
   product — a route file is a caller, and an endpoint nobody calls is the
   same disease one layer up. Mechanized for routes by
   `tests/route-reachability.test.ts` (which also carries the known-gap list);
   the guard covers only that one class, so parts 2–6 stay human.
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
- **A CONSUMER with no producer is the same failure, and it is worse** (M17.0,
  flaw #8). The Zakat page had a column, an endpoint, a route, a nav entry, a
  UI and four tests — everything except a writer for the flag it read (one rule
  out of ~40). A missing consumer yields a dead column nobody sees; a missing
  producer yields **a confident zero**, which reads as an answer, so nobody
  reports it. Check writers as well as readers — standing-check part 2 is the
  half that catches this, and it is the half most often skipped because the
  feature demos fine. **Corollary: "nothing writes it" is itself a claim that
  needs part 5's search shape.** The first pass of this very fix asserted the
  flag had *no* writer; grepping the pre-change file found one, and that one
  turned the finding from "always 0" into "wrong in a specific, worse way".
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
- **🔴 COST AN OPTION AFTER VERIFYING ITS INPUTS EXIST, NOT BEFORE** (the cash
  decision, 2026-08-16). "GL owns cash; transfers post through a contra account"
  was offered as a lean and costed as moderate — before anyone checked whether
  the platform records **where a transfer went**. It does not. Built on today's
  data that option would manufacture a clearing balance for every transfer,
  including the genuinely internal ones it was meant to leave alone. The cost
  estimate was not slightly low; it was **about a different feature**. Before
  recommending an approach, name the inputs it consumes and grep for each —
  the same discipline standing-check part 2 applies to a milestone, applied to
  a PROPOSAL.
- **🔴 A STUB IS THE PART THAT NEEDED TESTING** (B3). When a capability is
  implemented for one backend and stubbed for the others, the passing tests
  prove nothing — the suite ran on the backend that worked. Test the branch you
  did NOT write: inject a failing implementation and assert on what survives.
  And at the interface, **a method that cannot do the thing must throw, never
  return** — a no-op reporting success is a false statement the caller builds
  on, where an unimplemented method is merely a gap. Same family as the SDK
  differential that proved only that we matched a stale writer: **a test whose
  oracle shares the defect it is meant to detect.** Ask what a failure would
  have to be measured against, and whether that thing is independent of the code
  under test. **Where to look:** every `resolve*Store` / `get*Provider` seam —
  `ArchiveStore`, `KeyWrapper` (the AWS branch is lazily loaded and has never
  executed), the mailer, the alerter.
- **🔴 A DEPENDENCY THAT ACCEPTS YOUR INPUT HAS NOT PROMISED TO HONOUR IT**
  (M17.2's small-ICU finding; second instance of the shape). A small-ICU Node
  accepts `islamic-umalqura` and silently returns **Gregorian** dates — no
  error, no missing output, just a plausible wrong answer. Same shape as the
  ASCII `\b` that made sixty Arabic patterns match nothing: the API took the
  input and quietly did something else. **The countermeasure generalises: when
  a dependency can silently substitute different behaviour, probe an
  EXTERNALLY CHECKABLE FACT at boot** — a value verifiable against a source
  outside the dependency (1 Muharram 1447 AH = 26 June 2025), not a round-trip
  through the thing you are testing. "It didn't throw" is not evidence.
- **Sources rank LIVE API > SDK > PDF > secondary sources** — and an unread
  primary source is not a licence to trust a secondary one (the residency
  claim was the opposite of what §5.5 actually says).
- **Enforce invariants at the WRITE BOUNDARY, not in one path** (audit
  close-out). An invariant three writers can violate belongs in a DB CHECK or
  a shared gate, not in per-path code — per-path enforcement is per-path
  review, and a new path starts at zero. Corollary: **when line-level truth
  exists, header-level arithmetic is a second computation of the same fact**
  and will drift — classify/derive from the finer grain. Second corollary
  (M20.0): **a REMOVED default is an invariant too — after dropping it, check
  every path that can write the column, not just the layer that defined it.**
  The schema stopped asserting January while Company Settings' submit still
  coerced `?? 1`, so saving an ADDRESS would have re-declared January: the
  migration fixed one layer and another kept re-creating the fiction. Defaults
  live wherever a writer supplies a fallback, and each is a write path.
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
- **🔴 The status palette is reserved for real STATES — never for a rule of
  thumb.** good/warning/serious/critical describe something that IS the case
  (an outbox is stuck, a certificate expired). A heuristic threshold — "quick
  ratio below 1", a solvency ratio, a budget variance — is a **judgment**, and
  colouring it with a status renders it as a verdict the platform cannot
  support. Those get a neutral treatment plus words. Corollary already in force:
  the liquidity observations are typed `"watch"` and nothing else, so no UI
  *can* render a compliance failure from a number no standard sets.
- **🔴 No dual-axis charts where the two series have different units.** Money and
  a ratio on one canvas invents a relationship the reader will believe — two
  y-scales can be slid until any two lines appear to track. Different units ⇒
  **separate charts**, small multiples, or index both to a common base. (The
  single most common charting mistake, and the Analytics design walked at it.)
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
- **🔴 A MIGRATION THAT TOUCHES `categories` OR `system_account_templates` MUST
  REDEFINE `seed_org_chart_of_accounts()` — and be covered by a trigger
  round-trip assertion.** The org-seed trigger copies template→category
  **column by column**, and plpgsql resolves names at EXECUTION time, so both
  failure directions are silent at deploy: a **dropped** column the trigger
  still names breaks the next *signup* (M17.0/0038), and an **added** column the
  trigger omits seeds the next org with NULLs nobody asked for (M18.1/0041).
  Both happened; both were caught by hand. `tests/org-seed-trigger.test.ts` is
  the standing countermeasure — it compares the two tables' column sets rather
  than knowing any column's name, so it covers future migrations without being
  edited, and it has been verified to fail in **both** directions. Do not
  weaken it to a list of known columns.
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
| **B4** | 🔴 **`invoice_payments` — payment history is being LOST PERMANENTLY, right now.** A payment writes `invoices.paid_amount` (a running total) and `invoices.paid_at` (only the LAST payment's date). A second partial payment overwrites the first one's date and leaves no trace of it. The GL keeps the movement, but nothing ties it to the instalment. **Add a `invoice_payments` table (and the AP twin) that records each payment as its own dated row**, written by `invoicesService.pay` / `billsService.pay` on the existing path — not a second posting path. | 🔴 **This is not "important", it is EXPIRING.** Every other queue item describes a state that can be fixed whenever it is reached; this one describes information that stops existing the moment a second payment lands. A running total with one date is **not reconstructible** — no migration, no backfill, no amount of later care recovers which instalment arrived when. It is cheap today (no customers, no migration burden, §2's "reversals are cheap right now") and **impossible after the first tenant onboards**. Every day of delay is a permanent, silent loss.<br><br>**What it unblocks once it exists:** the overdue share over time (M19.6 could not build it — see design-analytics §6.1), collection-speed and days-sales-outstanding trends, and any audit question of the form "when was this actually paid".<br><br>**Sequencing (owner, 2026-08-17): B4 does NOT jump the F3-dual → F7-cmp → A queue.** Cheap-now/impossible-later is not the same as actively accruing loss the way B5 was — B4 only degrades when a SECOND payment lands on an already-part-paid invoice, which is near-zero with no customers. The urgency framing above stands for the pre-onboarding deadline, not for jumping milestones. |
| **B5** | ✅ **CLOSED (2026-08-16) — a transfer can now say where the money went, and the loss has stopped.** `transfer_direction` (`own_account | external`, **NULL = not declared**, no default — the M17.1 posture in a third place) + optional `counterparty_bank_account_id` (migration 0043, four DB CHECKs at the write boundary, tested by violation). Declared on the Transactions list — the only moment anyone knows. The cash reconciliation now splits transfers **three ways** (own-account = the ledger is right; external = the ledger is understating cash; undeclared = the platform will not guess) and surfaces `undeclaredTransfers` as its own number with an ASK, because an undeclared transfer is a question only the tenant can answer. | Was: the expiring fact. Rows recorded before 0043 stay NULL forever — that loss already happened and is not recoverable; what stopped is the accrual. 🔴 **Still open: option A** (GL owns cash) now has its input and can be built on declared data. |

**C. Verification and coverage gaps:**

| # | Item | Where recorded |
| --- | --- | --- |
| C1 | **Trusted proxy + shared rate-limit store — an INTRODUCTION, not a migration.** (a) Confirm exactly one trusted proxy overwrites `X-Forwarded-For` (`trust proxy` is production-only; a spoofable header makes every IP-keyed limiter a no-op). (b) Limiters are in-memory per-process, so horizontal scaling silently multiplies every limit. **Redis does not exist in this project** — introducing a shared store is new infrastructure with a new failure domain, or pick a Postgres-backed limiter instead. | M11 audit + finding S3 |
| C2 | **CI storage gap** — the M11.4 document tests skip in CI (no Supabase Storage service); a green CI does not prove the storage path. | Known CI gap |
| C3 | **KMS deployment verification** — IAM/key policy, 30-day deletion window, break-glass-only `kms:ScheduleKeyDeletion`, CloudTrail alarm on deletion attempts, multi-region CMK replica. If the CMK dies, every tenant must re-onboard. | [`docs/history/phase-2-zatca-m12.md`](docs/history/phase-2-zatca-m12.md) |
| C4 | **AV scanning** on uploaded verification documents before untrusted-tenant growth (magic-byte sniff is header-only — M-5). Seam: `documents.service.upload`. | M11.4 follow-up |
| C5 | **Fail-closed diagnosability** — confirm a blocked issuance surfaces an actionable message (which field, which company, what to fix), not an opaque 500. | M12.8 decision |
| C6 | **Data residency / hosting region** — ZATCA permits cloud (the "must be in KSA" claim was a secondary-source error); NCA / sector rules are **unverified legal questions**. Choose host and KMS region together. No hosted Supabase project exists yet — this is a deployment decision, not a migration. | Residency correction, phase-2 history |
| C7 | **TAX ADVICE — retention of INBOUND supplier documents.** A1 retains captures to the 6/11-year outbound standard as a conservative default, not a settled reading. **Answer together with C8 AND the Zakat questions — one package: [`docs/product/advisor-questions.md`](docs/product/advisor-questions.md), Block A.**<br><br>**Sharpened 2026-08-14 (audit):** `retain_until` now has a real production writer (set at promotion, `capture.service.ts:166-173`) — and **still no reader: nothing expires, enforces, or refuses deletion based on it** (the purge job selects on `status` + `captured_at` only, `capturedDocuments.repository.ts:109-118`, and never sees promoted rows). So the "conservative default" is a **stored intention, not a retention policy**. Two consequences for the advice: (a) whatever duration comes back, an ENFORCER has to be built — the value is decorative today; (b) 🔴 **an answer SHORTER than the outbound standard is currently not implementable at all**, because promoted captures live in a store with no delete. Ask the advisor for the duration AND whether inbound evidence may be destroyed on schedule; if it may, that is a B3-shaped build, not a config change. | A1 (Q4) |
| C9 | **Verify the remaining tax-treatment defaults against KSA VAT rules.** Only `BANK_CHARGES` and `INSURANCE` have been checked (M16.2); every other seeded default is an assumed majority-'S' or a reasoned-but-unresearched O/E. The distinction is DATA (`treatment_verified`, M16.3.1) and assumed treatments surface as overridable-with-a-hint — but the flags only flip on an actual rule lookup. **Check FIRST (owner-prioritised — these hit most tenants):** (1) `FOOD_MEALS` — KSA blocks input-VAT recovery on meals/entertainment, so 'S' extraction overstates recoverable input VAT for nearly every SME; (2) **reverse-charge foreign digital services** (Google/Meta ads under `MARKETING`/`IT_SOFTWARE`) — the bank debit contains no VAT, so extraction invents input VAT never paid. Then: residential rent E (`RENTAL_INCOME`, `RENT_UTILITIES`), international transport Z (`FUEL_TRANSPORT`), exports Z (`SALES`), loan interest E vs principal O. 🔴 **Also unverified: the foreign-digital-supplier list** behind `vat_basis = reverse_charge` (flaw #6). Several of those platforms have registered for KSA VAT on some product lines, so the flag is a likelihood, not a fact — verify per supplier against an actual invoice, and note that being wrong in this direction UNDER-claims recoverable input VAT rather than inventing it. Reconcile-grade only — but a user-visible guess until closed. | Design doc §1 verification-status flag |
| C8 | 🔴 **PDPL — higher priority than C7 and answered with it. Questions written up as Block B of [`docs/product/advisor-questions.md`](docs/product/advisor-questions.md).** Phone photographs will eventually contain third-party personal data; PDPL grants erasure rights that may conflict with retention. **PDPL has never been considered anywhere in this project** — scope it to the platform (audit logs hold IPs append-only; the archive holds names/addresses 6–11 years; `users`/`customers`/`employees` have no retention policy), not just document capture.<br><br>**Sharpened 2026-08-14 (audit) — the question stopped being hypothetical.** The product now accepts phone photographs from ordinary users, and **posting a bill promotes that photograph into a store that by interface design can never delete it**. So the irreversible act is performed by ordinary users in the ordinary flow, **before the legal question has been answered**, and an erasure request for a promoted capture is today not "hard" but *impossible by construction*. The advisor question that the wiring surfaces: 🔴 **ZATCA §5.5 immutability covers invoices WE GENERATED — a supplier's invoice photographed by our user is a different class of document, and we currently give both the identical no-delete guarantee.** Ask whether inbound third-party captures may be made erasable-with-audit without touching the outbound guarantee. If yes, the archive needs a class distinction (not a `delete` on `ArchiveStore`); if no, capture needs a consent/data-minimisation story instead. Either way it is a design change, so ask before more tenants photograph more documents. | A1 |
| C10 | 🔴 **ZAKAT TAX ADVICE — the base computation itself. M17.4 IS HELD ON THIS** (owner instruction, 2026-08-15). Q1–Q8 decided the MECHANISM (working paper, GL-derived, Saudi/GCC-only, Hijri+Gregorian); the TAX CONTENT has never been checked against the Zakat Collection Regulations. Written up as **Block C of [`docs/product/advisor-questions.md`](docs/product/advisor-questions.md)**, asked in the SAME conversation as C7/C8. 🔴 **Ask C1 (the minimum-base rule) first — it is the only one that changes architecture rather than arithmetic:** if a rule ties the Zakat base to adjusted net profit, the income statement stops being Q4's cross-check and becomes a computed INPUT, so the worksheet needs an adjusted-net-profit derivation with its own adjustments and audit trail. Also open: exact base composition and which provisions qualify (needed before **M17.3**, not just M17.4), the Gregorian divisor (354 vs 354.367) and rounding convention, whether nisab has any role in corporate Zakat (assumed NO — if so, say so in the UI so its absence reads as a decision), and confirmation that declining mixed/foreign ownership is the right v1 posture. | [`docs/product/design-zakat-module.md`](docs/product/design-zakat-module.md) §4 |

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
- **✅ `companies.fiscalYearStart` — fully closed by M20.0 + M20.1** (was: stored
  from M11.6, applied by nothing for five milestones). Resolver (`lib/fiscalYear.ts`),
  calendar basis, endpoint, Company Settings display (M17.2); NULL = not declared
  as a first-class state (M20.0); every report page opens on the resolved fiscal
  year or a labelled rolling 12 months (M20.1). Remaining fiscal-period work is
  feature work, not a gap — tracked in §2 (M20.2/M20.3).
- **S6/S7 traps**: `feature_flags`, `branches`, `departments` are tables with **no consumer** — do not assume they work; build a consumer or drop them.
- **Feature (deferred)**: action-level permissions for separation-of-duties (post-to-GL / pay / approve individually gateable).
- **🔴 Mounted routes with NO UI (found by `tests/route-reachability.test.ts`,
  2026-08-14 — the same class as A1/A3, three more instances):**
  `/period-locks` (a tenant cannot close an accounting period from the
  product), `/audit-logs` (the admin audit trail has no reader UI, though it is
  claimed as available to org admins), `/llm` (proposal-only, inert, parked
  with the AI layer). They are listed in the guard's `KNOWN_UNREACHABLE` with
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
  reduces profit. Full record: [`docs/history/findings-and-lessons.md`](docs/history/findings-and-lessons.md).
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
  [`docs/product/design-zakat-module.md`](docs/product/design-zakat-module.md).
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
- [`docs/product/design-analytics.md`](docs/product/design-analytics.md) — Analytics
  (round 3): cash + solvency trends, "cash collected" never "revenue", and the
  rule that keeps AI parked (state WHERE a change came from, never WHY).
- [`docs/product/hub-structure-decision.md`](docs/product/hub-structure-decision.md),
  [`docs/product/design-transaction-accounting.md`](docs/product/design-transaction-accounting.md),
  [`docs/product/feature-spec-automation.md`](docs/product/feature-spec-automation.md),
  [`docs/product/design-zakat-module.md`](docs/product/design-zakat-module.md)
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

## 10b. 🔴 Tooling hazards (learned the hard way)

**The Edit tool can silently write back STALE file content.** During the
flaw-report work, a scripted fix to `categorizer.ts` (removing sixty broken
Arabic regex patterns) was **reverted** by a subsequent `Edit` call on the same
file: the edit applied cleanly against a snapshot taken *before* the script
ran, and writing that snapshot back undid the change. Nothing warned; the tool
reported success. It was caught only because a test that had just passed
started failing again.

**Why it matters more than it sounds:** the reverted change was invisible in
review (Arabic regex literals), and the failing test was the only signal. Had
the test not existed, the fix would have been "applied", reported, committed
and absent.

**Mitigations:**
1. When a file has been modified by a SCRIPT (python/sed/node) in this session,
   keep editing it the same way — do not mix scripted edits and `Edit` calls on
   one file. `categorizer.ts` is on the scripted path for this reason.
2. After any tool reports "the file had been modified on disk since you last
   read it", re-verify the earlier change is still present — the warning means
   the tool's snapshot was stale, and "applied cleanly" only describes the
   patch, not the rest of the file.
3. Prefer a test that fails loudly over an inspection: this class of loss is
   invisible to reading.

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
