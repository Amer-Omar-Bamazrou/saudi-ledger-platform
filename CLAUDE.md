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

**Last updated: 2026-08-23 (MED validation pass incl. the FK-outside-RLS security finding, PR #75; AI-2 corpus at measuring size, PR #76; A3 rule health completed, PR #77 pending review.)**

**Pre-AI security pass — CLOSED (2026-08-20, PRs #57 + #58).** In order: **C9**
(VAT treatments verified against the primary source; `FOOD_MEALS` was a live
wrong default), a **five-area read-only audit** whose CRITICAL + HIGH findings
were fixed in the same pass (write-boundary allowlists, the inverse route
guard, RLS coverage as a permanent test, H2/H3), then **C1** (shared
Postgres rate-limit store; `TRUST_PROXY_HOPS` / `SESSION_COOKIE_SECURE` as
explicit env facts), **C2** (the M11.4 document suite now RUNS in CI —
measured: 822 passed | 9 skipped → **835 passed | 0 skipped**), **C4**
(malware-scanner seam wired into both upload paths), **C5** (issuance
diagnosability). Everything MED/LOW is queued below, deliberately unfixed.
🔴 Three DEPLOYMENT-time items remain and cannot be closed from code: the real
proxy count for `TRUST_PROXY_HOPS`, a clamd sidecar for `MALWARE_SCANNER`, and
B1/B2's provider wiring.

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
| **M19.7 → A** — the GL owns cash | ✅ **The C → D → A sequence is complete (A: 2026-08-17, PR #54/#55).** Transfers POST by declared direction (own_account → Transfer clearing; external → External transfers, equity; undeclared → Transfers awaiting declaration, which posts — the bank moved — and **blocks the liquidity claim** like SUSPENSE). The cash card reframed: **the ledger is cash; the reconciliation states where the bank statement differs and why** (settlements / unposted_legacy / ledger_only; `unexplained` still returned, not asserted). Live pass observed: backfill posted 5 transfers, cash −94,194.15 → −122,494.15, transfer suspense +28,300, total assets unchanged, gap −19,550 → +8,750 fully itemised, declaring one transfer moved exactly its 2,000 from suspense to clearing. 🔴 **Found and fixed during the build: posted-only report filters double-negated every REVERSAL** (±8,750 live) — see §4's `JE_IN_BOOKS` rule. | [`docs/product/design-analytics.md`](docs/product/design-analytics.md) §6.1 (as-built + live pass) |
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

**M21 — Quotations & Purchase Orders: DECIDED, building in staged PRs.**
Design approved 2026-08-20; all five load-bearing questions answered, every
safe default accepted. **Quotations → invoice** when the customer agrees;
**PO → bill** when the supplier's bill arrives; **partial conversion by
QUANTITY per line** ("the amount or sub amount"); 🔴 **neither touches the
ledger until converted** — conversion produces a real document through the
EXISTING write path, never a second posting path.

| Stage | State |
| --- | --- |
| **M21.1** — quotations: schema, CRUD, approval, numbering, UI | ✅ **BUILT.** |
| **M21.2** — quotation → invoice conversion (partial, dated) | ✅ **BUILT.** |
| **M21.3** — purchase orders + PO↔bill matching | ✅ **BUILT** (after the owner review that corrected M21.2). |

**M21.1 as built:** two orthogonal axes, deliberately never one column —
`status` is the APPROVAL axis (the M10 engine, `autoApprove` from the RBAC
matrix) and the CONVERSION axis is **DERIVED from line quantities, never
stored** (a single status string cannot say "approved AND partially
converted"). `outcome` (`declined`/`closed`, NULL = live) is the tenant's
terminal act — the platform never infers that a remainder is dead, not from
expiry, not from age. Numbering is `QUO-{YYYY}-{NNNN}`, server-allocated, with
`UNIQUE(company_id, number)` as the real guarantee — 🔴 deliberately NOT the
sibling pattern, which is queue item **C12**. Expiry warns and never blocks.
Approval fires **no** accounting activation and that is the feature, not a
stub. Zero-movement proven through the REAL report services at every status,
against a captured baseline (not a hardcoded 0), plus an **anti-vacuity test**
showing a real invoice moves the same figures — otherwise "nothing moved"
could mean "nothing was measured" (flaw #8's shape). `/quotations` was removed
from the route guard's `KNOWN_UNBACKED`; `/purchase-orders` stays there until
M21.3. Nine tests pin the permission grants, including the negative one (a
bookkeeper may NOT approve — issuing a price is a commitment).
🔴 **Owner review, 2026-08-20 — two corrections:** (1) **conversion is DRAFTS
ONLY for every role.** The build had resolved issuance from `invoices:approve`;
the design's own position was restored ("agreeing a quotation in March is not
authority to issue a legal invoice in November") because issuance consumes an
ICV irreversibly and a conversion cannot be undone. There is now no
`autoApprove` parameter on the convert service at all. **M21.3 inherits this.**
(2) **No-undo is now stated BEFORE the act** — the convert dialog says the
conversion cannot be reversed and a mistake is corrected by credit note, and
the button reads "Create draft invoice". ✅ **The discount question is ANSWERED by
the accountant (2026-08-20): "the invoice should reflect the exact math on the
quotation"** — proportional, recorded as verified rather than reasoned. 🔴 The
rounding half is what would have bitten: independent per-conversion scaling
gives 33.33 × 3 = 99.99 against a quoted 100.00, so `allocateLineDiscount`
allocates on the CUMULATIVE quantity and subtracts what was already allocated,
telescoping to the quoted total exactly. One function
(`services/conversionArithmetic.ts`), used by both conversion directions.

**M21.2 as built:** conversion calls `invoicesService.create` — never a second
posting path — proven behaviourally: a converted invoice and a hand-typed one
of the same value both move AR by exactly 575.00. The record is **dated events**
(migration 0052, append-only grants), and converted quantity is `SUM`ed from
them: **no `converted_quantity` column exists**, because a running total keeps
one date and would destroy the first partial acceptance's — B4's loss, avoided
in advance. Over-conversion 409s; the freeze rule stops a converted line being
re-priced or removed while untouched lines stay editable; a per-line discount is
**scaled to the converted proportion**; expiry warns and never blocks.
🔴 **Found while building:** the edit path replaced lines wholesale, which once
a conversion exists both hits the RESTRICT FK as a raw 500 AND (had it
succeeded) would re-insert the line under a NEW id, orphaning the record of what
was accepted. Edits now reconcile by id; the old behaviour was re-injected and
the guard went red, as were both freeze-rule guards.
**M21.3 as built:** the mirror, plus the matching half. 🔴 **Three differences,
each VERIFIED against what a bill can represent rather than assumed from
symmetry:** a PO carries **no discount** (bill_items has no such column, and
neither does bills — a discount would be silently dropped at conversion, the
"partial data is not lenient data" failure); **no tax_category_code** (same
check); and the terminal act is **`cancelled`, not `declined`** — we withdraw
an order, and saying the supplier refused would assert what we cannot know
(DB CHECK enforced, tested). **This corrected an M21.2 claim** that both
directions need the same discount rule: they do not, so the accountant's
answer governs quotation→invoice only.
**Matching — "the bill is the truth; the PO is the expectation":** a different
supplier price is RECORDED as a variance with both figures and its date (the
billed price is stored per event, so it survives a later bill edit), never
refused and never silently reconciled; over-billing 409s **with an explicit
override**, because refusing outright would refuse to record a real liability;
an unordered line (freight) is allowed and identifiable by having no
conversion row. 🔴 **The two-way limitation is ON THE SCREEN** — no
goods-receipt concept exists, so every progress word is BILLING
(`partially_billed`, `unbilledQuantity`), never "received" or "delivered", and
the dialog says so plainly.
🔴 **`KNOWN_UNBACKED` is now EMPTY** — the last of the six audit façades is
gone, and each entry was deleted by the stage that built it rather than
reworded.
See [`docs/product/design-quotations-purchase-orders.md`](docs/product/design-quotations-purchase-orders.md).

**M23 — Audit Trail (2026-08-21, PR #73).** The second-to-last
claimed-but-unreachable route closed: `/audit-trail` is the first reader UI
for the trail M7 started writing — read-only, filterable, paginated,
before/after states, admin-gated. **Actors are NAMED via the identity layer**
(`membersRepository.memberNamesByIds`, the B1 `activeAdminEmails` precedent),
scoped to the org's own memberships; 🔴 the pinned NEGATIVE test is the one
that matters — a userId with no membership in the org stays unresolved, so
the trail can never borrow a name from another tenant. `/audit-logs` gained
its first OpenAPI entry (the `actorName` response change triggered the
obligation). **`KNOWN_UNREACHABLE` now holds `/llm` alone**, parked with the
AI layer by decision. Ops note for background jobs: never `git checkout`
inside a background waiter — one did, mid-build, and moved a commit onto
local main (caught by branch protection; repaired).

**AI-1 — the Groq free-tier foundation (2026-08-21, PRs #67/#68).** The AI
layer's first BUILT phase, entirely inside the owner's free-tier boundary
(synthetic + dev-org data only). **AI-1a:** the provider seam
(`services/ai/provider.ts` — chat + vision, dependency-free REST, unavailable
THROWS per the B3 rule, fetch injectable); per-tenant metering (`ai_usage`,
migration 0055, append-only, failures are rows too); the categorizer's
below-0.65 second opinion routed through the seam, deterministic engine still
the brain. 🔴 **The data boundary is enforced at BOOT**: production refuses
`AI_PROVIDER=groq` unless `GROQ_DATA_BOUNDARY_ACK="enterprise-dammam-zdr-signed"`
— a typed attestation, tested in both directions incl. a wrong string.
**AI-1b:** the categorizer Arabic benchmark (hand-curated corpus, NOT
regex-inverted; AR/EN scored separately; §2a gate printed as a verdict;
honest-null cases score restraint; **measured deterministic baseline EN 60% /
hard 40%, AR 62% / hard 44%**) and the vision harness, built ready for the
owner's receipt corpus with a LOUD not-run on empty. Outreach list for the one
Groq conversation: design-ai-layer §12c (Enterprise terms + the Dammam-region
Arabic-vision question). As-built: §12d/§12e.

**AI-2 — the corpus at measuring size (2026-08-23).** The binding constraint
(§12g: one hard case moved a verdict ~11 points) closed: **153 cases, 30 hard
per language** (en/ar equal-N; one case ≈ 3.3 points), with the two authoring
disciplines MECHANIZED (`tests/benchmark-corpus.test.ts`: every `hard` flag is
a measured claim the engine cannot solve at ≥0.65 — the first expansion's 28
guessed flags were ALL engine-solved, six of them from the original corpus;
every expected label emittable; ≥30 hard per language). Two instrument
defects fixed during measurement (token starvation, TPM-blind pacing — each
silently substituted deterministic answers into "hybrid" scores). 🔴 **The
AI-1b headline REVERSED at measuring size:** on 84/84 clean calls per model,
gpt-oss-**120b** leads (AR hard 83% vs 20b's 77%; was "20b decisively ahead,
100% vs 78%" on 9 cases); allam-2-7b is barely above baseline on hard cases
(17% vs 13%); both gpt-oss models hold the Arabic gate with Arabic as the
STRONGER side; qwen stays NOT MEASURED. Model selection remains OPEN (single
runs, synthetic corpus, Enterprise/Dammam items unchanged). As-built: §12h.

**M22 — Closed months (2026-08-21).** The period-locks surface, in the owner's
framing: **"close the books for a month so figures stop changing"** — never
"lock period". A dedicated `/closed-months` page (read for every role; actions
admin-only) states what closing MEANS before any control, plus 🔴 **the 423 as
an explanation, once, globally**: `checkPeriodOpen` now throws a structured
`423 {code: "period_closed", period, lockedAt}`, and ONE dialog in the shared
fetch layer renders every closed-month refusal from any of the seven posting
paths — keyed on the **code, never the message text**, so rewording copy
cannot break it, and any future path that can hit a lock inherits the
explanation. The recurring generator records the same plain words a human
sees (it copies `err.message`, and the rewrite lives in the source error).
D4: the UI does not secretly forbid what the API allows — closing the current
or a future month is permitted with a loud consequence-naming confirm.
🔴 **D5 recorded as a CANDIDATE, not a gap:** months may close in any order
because the BACKEND enforces no order and a UI-only rule would lie about what
the system enforces; sequential closing, if wanted, is a backend change and
its own decision.

**The AI layer is INTERVIEWED and SPECCED, not commissioned** — 2026-08-18.
Owner answers: the full generative product is the moat (trips the hosting
trigger by definition); constraint ranking **residency > quality > cost**;
data boundary ABSOLUTE (no hosted model APIs — open-weight, self-hosted
only); AI usage metered per tenant and likely billable; training-on-tenant-
data is **owner-preference-PENDING-LEGAL** (goes to the advisor with
C7/C8/C10). Seven corrections adopted into the revised spec: approver is a
permission not a profession (+ the non-accountant review surface
requirement); the model SELECTS classifications, never AUTHORS tax
positions (C9/C10 stay the single tax gate; **no compliance-asserting AI
findings before C9/C10 close**); Qwen inside A1's pipeline (QR fields never
overwritten); the deterministic categorizer stays the brain with the model
as the below-0.65 second opinion; one writer per effect (no Dr/Cr from the
model); provider-agnostic seam; **"findings", never "audit"**. **Arabic is a
LAUNCH requirement and a HARD GATE on model selection** (2026-08-18): both
layers, benchmarked on Arabic financial text BEFORE any model is pinned,
Arabic and English scored separately — an English-strong/Arabic-poor model
fails regardless of its other scores (the `\b` lesson at model scale). 🔴
**Q2 answered (2026-08-18):** CFO = on-demand consulting before decisions,
never a scheduled report; Auditor = on-demand AND scheduled (quarterly
default, monthly opt-in) — the schedule creates two recorded obligations
(pushed-not-parked findings, the quiet-neglect shape; and C9/C10 bites
HARDEST on scheduled output, which looks authoritative precisely because it
arrived on a schedule). ✅ **Hosting DECIDED-PENDING-ENTERPRISE-TERMS (2026-08-18): Groq, Reading A
— contractual ZDR, no training, Dammam-region processing; the provider seam
keeps it reversible.** 🔴 Recorded honestly with it: Dammam pinning is an
ENTERPRISE arrangement, not a configuration flag (standard tiers route
globally), so the residency half is contingent on a commercial agreement
that does not yet exist — **the signed Enterprise/Dammam+ZDR agreement is a
BLOCKING item before any tenant data reaches Groq**; until then, model
calls carry fixture/dev data only. 🔴 **Free-tier boundary (owner,
2026-08-21): Groq's free tier is IN USE for development.** Recorded
explicitly: free tier = no Enterprise agreement = **no Dammam pinning —
requests route globally**. Usable for: the provider seam, the Arabic
benchmark, model evaluation, pipeline testing against synthetic fixtures,
and measuring real token consumption. **It must not touch any real
tenant's ledger, receipts, or documents** — the blocking rule above stands
unchanged, and "development" is not an exception to it. Still open: the Enterprise terms
themselves, an Arabic-acceptable vision model in the Dammam region, the
Arabic benchmark, and the eval gate's thresholds. See
[`docs/product/design-ai-layer.md`](docs/product/design-ai-layer.md).

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
- **🔴 A RULE SPELLED OUT FOR A SIBLING FIELD AND OMITTED HERE IS EVIDENCE OF
  INTENT, NOT AN OVERSIGHT TO FILL IN** (C12, 2026-08-21). Asking "does ZATCA
  require invoice numbers to be gapless?", the weak answer is *the word
  "unbroken" does not appear* — an absence, which is thin evidence and invites
  filling the silence with the stricter rule "to be safe". The strong answer
  came from the drafting: ZATCA **did** write an explicitly gapless,
  non-resettable requirement — in the same Annex, for the **sibling field**
  (2.5, the tamper-resistant counter), with "counter reset" listed under
  Prohibited Functionalities — and wrote nothing of the kind for 2.1, the
  invoice number. A drafter who spells a constraint out for one field and not
  its neighbour has made a choice.
  **How to use it:** when a spec is silent on the property you care about, do
  not stop at the absence — look for the nearest place the same author DID
  state that property, and read the contrast. It converts "unstated, so I'll
  assume the strict reading" into evidence. It also protects against the
  opposite error: had 2.1 and 2.5 both been silent, the absence would prove
  much less. (Second-order payoff here: the strict reading would have bought a
  materially more complex allocator than the law asks for.)
- **🔴 A DEFINITION IS NOT A RULE — FOLLOW THE DELEGATION** (C12, 2026-08-21).
  The E-Invoicing Resolution DEFINES the invoice-number field (Annex 2, 2.1)
  and then delegates the actual rule: *"as per Article 53(5)(b) of the VAT
  Implementing Regulation"*. Reading only the e-invoicing documents — the
  obvious corpus for an e-invoicing question — yields a field definition with
  no rule in it, **and that is precisely the situation in which someone
  reasons their way to an answer** and records the reasoning as the finding.
  When a spec describes a field without stating its constraint, assume the
  constraint lives somewhere else and go find it.
  **Corollary, on sequencing:** this read was done BEFORE any code, on the
  owner's instruction, and it caught a defect the code review had not — M21.2's
  allocator restarted each January, which nothing in either document
  authorises. Read-first did not merely confirm the plan; it changed it.
- **🔴 THE VACUOUS GREEN IN THE MEASURING INSTRUMENT** (AI-1b, 2026-08-21).
  The Arabic benchmark — the instrument built to enforce the quality gate —
  printed "✅ Arabic gate holds" over a run in which **all 21 model calls had
  failed**: it was comparing the deterministic engine against itself and
  calling the tie a verdict. Worse than an ordinary vacuous test, because an
  instrument's output is TRUSTED downstream — a model could have been pinned
  on it. Three compounding mechanisms, each now guarded: (1) the verdict
  didn't require any successful evidence (now: zero successes ⇒ "NOT JUDGED",
  and every verdict prints the call count it rests on); (2) failure reasons
  were swallowed, so the run looked slow instead of broken (now printed);
  (3) the parser extracted the FIRST `{...}` from replies, which for a
  reasoning model is the format placeholder inside its own `<think>` notes —
  so a model that reasoned to the RIGHT answer scored exactly baseline while
  looking measured (now: strip closed think-blocks, unclosed ⇒ no answer,
  last JSON wins). 🔴 **It was caught by the OWNER running it, not by the
  test suite** — the suite exercised the seam's failure branches but nothing
  asserted the benchmark's verdict logic against an all-failed run. The rule:
  **a verdict line must carry the evidence count it rests on, and an
  instrument needs its own vacuity test — "all inputs failed" is a case the
  instrument must name, not a case it may score.** Corollary adopted from the
  owner: an unmeasured row reads "NOT MEASURED", never "matches baseline" —
  an artifact that looks like a result is worse than a failure.
  🔴 **This shape appeared TWICE in two sessions** — the gate-over-failures
  verdict, then the parser scoring a reasoning model's placeholder — and both
  times the instrument produced a PLAUSIBLE NUMBER rather than an obvious
  failure, and both times a human running it caught what the suite did not.
  The countermeasure is not more tests on the instrument; it is the rule
  already stated — a verdict must carry the evidence count it rests on — so
  that when the instrument fails, its output looks like a failure instead of
  a finding.
- **🔴 A MIRROR IS A HYPOTHESIS ABOUT THE TARGET, NOT A FACT ABOUT IT** (M21.3,
  2026-08-20). Building purchase orders as "the mirror of quotations" carried
  an unexamined assumption: that a BILL can hold what an INVOICE holds. It
  cannot — `bill_items` has no `discount` column and neither does `bills`,
  while invoices have both. A discount on a PO would therefore have been
  silently dropped at conversion (the "partial data is not lenient data"
  failure), and the M21.2 claim that both conversion directions need the same
  discount rule was simply wrong.
  **The countermeasure is cheap and mechanical: before mirroring an entity,
  diff the two tables' columns in `information_schema` rather than reasoning
  from the shape of the source.** One query — the same instinct the org-seed
  trigger test encodes by comparing column SETS instead of naming columns.
  The same check also surfaced that a quotation is DECLINED by the customer
  while a PO is CANCELLED by us, so even the vocabulary does not mirror. Applies
  to any "same as X but for Y" work: X's capabilities are a claim about X.
- **🔴 A RETRY CANNOT FIX AN ORDERING PROBLEM** (C2's storage container,
  2026-08-20). storage-api died at boot with `role "anon" does not exist`, and
  the reflex fix is more health-retries — but the role was created by a *step*,
  and a GitHub `services:` container starts **before the first step runs**, so
  no amount of waiting could ever have reached a state that did not yet exist.
  The tell is that the missing thing has a **creator** rather than a settling
  time: if nothing is scheduled to produce it, waiting is just a slower
  failure. Ask *what creates this, and is it scheduled before me?* before
  reaching for a timeout — the fix was to change the ordering (start it from a
  step), not the patience. Second half of the same incident: the wait now
  **fails loudly and dumps the container log**, because a dead dependency that
  degrades into "suite skipped, CI green" is the exact gap C2 exists to close.
- **A flag's scope drifts past its name** when the thing it gates becomes
  shared infrastructure (ZATCA_WORKER_ENABLED silently disabled every
  non-ZATCA job). Move the gate WITH the thing the flag names.
- **🔴 TWO CORRECT ASSERTIONS WITH A GAP BETWEEN THEM** (the reversal
  double-negation, 2026-08-17). A suite asserted the top-line FIGURE (P&L —
  right) and the bottom-line INVARIANT (debits = credits — held), and every
  reversal still moved 8,750 through the layer neither speaks about: WHICH
  accounts hold the value. A different class from a missing assertion, and
  not caught by adding more of either kind — when an operation moves value
  BETWEEN accounts, assert both accounts' balances, before and after. A
  conservation law can hold while the conserved thing is in the wrong place.
- **🔴 FK CHECKS RUN OUTSIDE RLS — every plain FK between tenant-scoped
  tables is a cross-tenant edge no policy guards** (SECURITY finding,
  2026-08-23). Postgres evaluates FK constraints with the table owner's
  privileges, so `invoices.customer_id → customers(id)` ACCEPTED another
  tenant's id, and 23503-vs-success was an existence oracle across the whole
  platform — the RLS blind spot's sibling, in a place the RLS-policy sweep
  structurally could not see. Fixed with tenant-scoped pre-checks (422
  `reference_not_found`; under RLS, missing and other-tenant are the same
  fact). When auditing isolation, enumerate the FKs, not just the queries.
- **🔴 AN INSTRUCTION'S REFERENT IS AN INPUT — CHECK IT AGAINST THE DATA,
  EVEN WHEN THE INSTRUCTION COMES FROM THE OWNER** (2026-08-24, recorded at
  the owner's instruction about their own message). A work order arrived for
  a milestone that did not exist — plausible, self-consistent, in the
  project's own vocabulary, grounded in nothing (the owner had answered a
  plan nobody proposed). The stop that caught it: the name matched no
  record, so the data was queried before any code, and the mismatch was
  REPORTED instead of built. Two standing policies from the same exchange:
  corrections ship NARROW and scoped (never a general re-run tool — a tenant
  cannot run a script), and a NAMED GAP that stays gapped beats a silent
  default that ages into being trusted.
- **🔴 A CLAIM INSIDE A MEASURING INSTRUMENT IS STILL A CLAIM — CHECK IT**
  (AI-2, 2026-08-23). The benchmark's `hard` flag ("the engine can't solve
  this alone") was authored by judgment; the engine solved 28 of them at
  ≥0.65, six from the ORIGINAL corpus — each padding the baseline the gate
  reads. And "20b decisively ahead" was nine cases talking: at 30 equal-N
  cases the order flipped. Both now enforced by
  `tests/benchmark-corpus.test.ts` (the flag is measured, the corpus cannot
  shrink below verdict-safe size); flags are set by measurement, but cases
  are never reworded until the engine fails them.

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
  repositories) — the bank balance moved even though nothing was earned or
  spent. **Since A (2026-08-17), transfers DO post to the GL** — cash against
  Transfer clearing (own_account) / External transfers, an equity account
  (external — reasoning recorded on the account in `chartOfAccounts.ts`) /
  Transfers awaiting declaration (undeclared, which blocks the liquidity
  claim like SUSPENSE) — with **no P&L, tax or budget line ever**. Settlements
  still never post: their cash effect belongs to the pay paths.
- **🔴 A journal entry with `status = 'reversed'` is IN the books.** The
  status is a marker that a cancelling mirror exists, not an eraser — filter
  aggregations with `JE_IN_BOOKS` (`posted` + `reversed`), never
  `posted`-only, which double-negates every reversal (found live: ±8,750 on
  the dev org; full record in the findings file).
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
| **B4** | ✅ **CLOSED (2026-08-17, PR #54/#55) — every payment keeps its date.** `invoice_payments` / `bill_payments`: one dated row per payment, written by the existing pay paths in the same tenant transaction (a record beside the posting, never a second posting path; settlements route through pay and get rows too). **Append-only at the grants** (SELECT + INSERT — the record of when money arrived is exactly the row someone would want to quietly fix), asserted against `role_table_grants`. Reader: the Record Payment dialogs show the dated history (`GET /invoices/:id/payments` + bills twin). Live pass: two payments (Aug 5, Aug 17) → two rows, both dates preserved.<br><br>🔴 **The backfill is honest about what was NOT recoverable:** pre-B4 documents got ONE row flagged `backfilled = true` — an AGGREGATE carrying only the LAST payment's date; the instalment split is gone forever. **Any consumer that would be wrong on aggregates — DSO, collection-speed, instalment analytics — MUST filter `backfilled = false`** (recorded on the schema, the repository, and design-analytics §6.1). Deployment note: CI caught that the serial ids' SEQUENCES need explicit `USAGE` on plain Postgres (0047) — local Supabase's default privileges had masked it. | Was: the expiring fact — a second partial payment permanently destroyed the first one's date. What it unblocks: the overdue share over time, DSO and collection-speed trends (backfilled-filtered), and "when was this actually paid". |
| **B5** | ✅ **CLOSED (2026-08-16) — a transfer can now say where the money went, and the loss has stopped.** `transfer_direction` (`own_account | external`, **NULL = not declared**, no default — the M17.1 posture in a third place) + optional `counterparty_bank_account_id` (migration 0043, four DB CHECKs at the write boundary, tested by violation). Declared on the Transactions list — the only moment anyone knows. The cash reconciliation now splits transfers **three ways** (own-account = the ledger is right; external = the ledger is understating cash; undeclared = the platform will not guess) and surfaces `undeclaredTransfers` as its own number with an ASK, because an undeclared transfer is a question only the tenant can answer. | Was: the expiring fact. Rows recorded before 0043 stay NULL forever — that loss already happened and is not recoverable; what stopped is the accrual. ✅ **Option A is BUILT (2026-08-17)** on the declared data — see the M19.7 → A row in §2. |

**C. Verification and coverage gaps:**

| # | Item | Where recorded |
| --- | --- | --- |
| C1 | ✅ **CODE HALF CLOSED (2026-08-20); one DEPLOYMENT-TIME check remains.** (a) **Shared store built in Postgres, not Redis** — `lib/rateLimitStore.ts` implements express-rate-limit's `Store` over the existing pool (migration 0050, owner-only table, no `organization_id` because rate limiting runs BEFORE tenant resolution). No new service, no new failure domain; fail-CLOSED if the query errors. All three limiters (auth/signup/user-admin) now share it, namespaced. Tested by building TWO store instances and proving one sees the other's hit — the property MemoryStore could not give, and an assertion that would pass vacuously against a single store. (b) **`trust proxy` is now an explicit `TRUST_PROXY_HOPS` env fact, not inferred from `NODE_ENV`** — the old gate was wrong in BOTH directions (a "staging" deploy ran without it, collapsing every IP-keyed limit onto the proxy's address and shipping the session cookie without `Secure`; a proxy-less production deploy would trust a forgeable header). `SESSION_COOKIE_SECURE` likewise explicit, and `loadEnv` REFUSES a production boot with it false. 🔴 **Still open, and only verifiable in the real deployment: confirm exactly `TRUST_PROXY_HOPS` proxies actually rewrite `X-Forwarded-For`** — a wrong number is a spoofable limiter either way. | M11 audit + finding S3; audit 2026-08-20 |
| C2 | ✅ **CLOSED (2026-08-20).** CI now runs `supabase/storage-api` and sets `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`, so the M11.4 document suite RUNS instead of skipping. 🔴 **Two things the first red run taught, both worth keeping:** (1) it is started by a **STEP, not a `services:` entry** — a service container starts BEFORE the first step, so it hit Postgres before the roles its own migrations `REVOKE ... FROM anon, authenticated` existed and died with `role "anon" does not exist`; **nothing a later step does can be early enough**, so the ordering had to change, not the timing. (2) A **path-rewriting proxy** sits in front, because `lib/storage.ts` addresses `/storage/v1/object/...` — the path **Kong** exposes in a real Supabase stack — while a bare storage-api serves those routes at the root. Rewriting in CI keeps the suite exercising the URLs production uses; changing the lib to suit CI would have made the test prove the wrong thing. The health wait **fails loudly and dumps the container log** rather than letting a dead container degrade into "suite skipped, CI green" — which is the exact gap C2 exists to close — the suite gates on the presence of those vars, so supplying them is what turns it on. Same reasoning the ZATCA-SDK step already carried in this file: a green CI that skips its highest-consequence suite proves nothing. The container speaks the same REST surface `lib/storage.ts` targets, so the code under test is the real client. | Known CI gap |
| C3 | **KMS deployment verification** — IAM/key policy, 30-day deletion window, break-glass-only `kms:ScheduleKeyDeletion`, CloudTrail alarm on deletion attempts, multi-region CMK replica. If the CMK dies, every tenant must re-onboard. | [`docs/history/phase-2-zatca-m12.md`](docs/history/phase-2-zatca-m12.md) |
| C4 | ✅ **CODE HALF CLOSED (2026-08-20); deployment remains.** `lib/malwareScanner.ts` — a provider-agnostic seam (the `KeyWrapper`/`ArchiveStore` hedge) with a dependency-free clamd INSTREAM implementation, wired into BOTH user-file paths right after the magic-byte sniff and before any bytes reach storage: `documents.service.upload` AND `capture.service.capture` (phone captures are the higher-volume untrusted input). 🔴 **The B3 rule is the design**: `scan()` returns `clean`/`infected` or THROWS — an unparseable reply, a timeout and a socket error are all `ScanUnavailable`, never a silent "clean". `SCAN_UNAVAILABLE_POLICY` makes fail-open-vs-closed an explicit config choice (`allow` today, and an unscanned stored file is logged at WARN so it is findable; `refuse` = 503 once untrusted tenants exist). Tests inject a DOWN scanner — the branch nobody writes — and caught a real defect in the gate (configuration was consulted before the injected scanner, which would have made every injection test vacuous). **Remaining: deploy a clamd sidecar and set `MALWARE_SCANNER=clamd`**; M-5's header-only sniff closes with it. | M11.4 follow-up |
| C5 | ✅ **CLOSED (2026-08-20).** Checked first, then fixed the half that was actually broken: **document ASSEMBLY was already diagnosable** (the assembler throws `BusinessRuleError` 400s with codes — `note_reason_missing`, `amount_not_finite`, …). The gap was **SIGNING**: `SigningError` carries a deliberately fixed, non-leaking message ("ZATCA signing is unavailable for this company") — right for secrecy, useless for action, and it reached the user as an opaque 500 naming no invoice. `invoices.approvable` now wraps the enqueue: a **422 `einvoice_issuance_blocked`** carrying the invoiceId, companyId, the underlying reason, and a `likelyCause` of `signing_unavailable` vs `invoice_data_incomplete` — the two families a user acts on differently — plus a server-side ERROR log. 🔴 The fail-closed POSTURE is unchanged (an ICV gap is unrecoverable; a refused issuance is not), and the test proves both halves: the diagnosis AND that nothing was issued (no ICV consumed, no chain position, no GL entry) — a helpful message that left a half-issued invoice would be the worse bug. | M12.8 decision |
| C6 | **Data residency / hosting region — now ALSO the AI hosting decision (2026-08-18).** ZATCA permits cloud (the "must be in KSA" claim was a secondary-source error); NCA / sector rules are **unverified legal questions**. Choose host, KMS region, **and AI hosting together** — AI hosting ✅ **decided-pending-Enterprise-terms (2026-08-18): Groq, Reading A, Dammam** (design-ai-layer §12a; seam keeps it reversible). 🔴 The C6 work this leaves: (1) negotiate + sign the **Groq Enterprise agreement** (Dammam pinning + contractual ZDR) — **BLOCKING before any tenant data reaches Groq**; (2) confirm an Arabic-acceptable vision model in the Dammam region (the §2a Arabic gate decides on measured numbers); (3) the platform-hosting half (region + KMS) unchanged. No hosted Supabase project exists yet — this is a deployment decision, not a migration. | Residency correction, phase-2 history + [`design-ai-layer.md`](docs/product/design-ai-layer.md) |
| C7 | **TAX ADVICE — retention of INBOUND supplier documents.** A1 retains captures to the 6/11-year outbound standard as a conservative default, not a settled reading. **Answer together with C8 AND the Zakat questions — one package: [`docs/product/advisor-questions.md`](docs/product/advisor-questions.md), Block A.**<br><br>**Sharpened 2026-08-14 (audit):** `retain_until` now has a real production writer (set at promotion, `capture.service.ts:166-173`) — and **still no reader: nothing expires, enforces, or refuses deletion based on it** (the purge job selects on `status` + `captured_at` only, `capturedDocuments.repository.ts:109-118`, and never sees promoted rows). So the "conservative default" is a **stored intention, not a retention policy**. Two consequences for the advice: (a) whatever duration comes back, an ENFORCER has to be built — the value is decorative today; (b) 🔴 **an answer SHORTER than the outbound standard is currently not implementable at all**, because promoted captures live in a store with no delete. Ask the advisor for the duration AND whether inbound evidence may be destroyed on schedule; if it may, that is a B3-shaped build, not a config change. | A1 (Q4) |
| C9 | ✅ **SUBSTANTIALLY CLOSED (2026-08-19) — verified against the PRIMARY SOURCE** (the official ZATCA VAT Implementing Regulations PDF, read page by page; per-article citations in [`docs/tax/vat-treatment-verification.md`](docs/tax/vat-treatment-verification.md)). **17 treatments verified** (migration 0048), incl. both owner priorities: (1) `FOOD_MEALS` — the predicted defect CONFIRMED as a live wrong default: Art. 50(1)(a)-(b) blocks meals/entertainment input VAT, and the engine was counting it as recoverable (SAR 94.34 live on the dev org). Fixed via 🔴 **`input_vat_blocked` — a deliberate THIRD axis** (recoverability ≠ treatment ≠ basis; reasoning recorded on the column) — excluded from the recoverable estimate, returned as a named `vatBlocked` figure, never silently dropped. (2) Reverse charge — Art. 47(1) verified verbatim; the `vat_basis` mechanism is the correct implementation. **Still open, each with what-would-settle-it recorded in the doc:** the foreign-supplier list (needs actual invoices — safe error direction), LOANS/INVESTMENT_INCOME mixes (advisor), RENTAL_INCOME/TRAVEL (product granularity, not law), and the GCC-Agreement trio → C11. | [`docs/tax/vat-treatment-verification.md`](docs/tax/vat-treatment-verification.md) |
| **C12** | ✅ **CLOSED (2026-08-21) — verified against the PRIMARY TEXT, then fixed.** Two documents read directly, both from zatca.gov.sa: the **E-Invoicing Implementation Resolution** (19 May 2023) and the **VAT Implementing Regulations** (Eighth Edition). Per-clause citations in [`docs/tax/invoice-numbering-verification.md`](docs/tax/invoice-numbering-verification.md).<br><br>🔴 **The delegation chain is what made the answer findable:** the Resolution does NOT state the rule — Annex (2) field 2.1 defines the IRN and delegates *"as per Article 53(5)(b) of the VAT Implementing Regulation"*. That article is the whole requirement: **"a sequential number which uniquely identifies the Tax Invoice"**.<br><br>**Q1 — are GAPS permitted? YES; sequential + unique is the requirement, unbroken is NOT.** Neither document contains "unbroken", "gapless" or "without gap" for the invoice number (checked, not assumed). 🔴 **The decisive evidence is internal: ZATCA DID write an explicitly gapless, non-resettable rule — for the tamper-resistant COUNTER** (Resolution §7 + Annex 2 field **2.5**, a *different field*, with "counter reset" listed under Prohibited Functionalities). Having spelled it out for 2.5 and not for 2.1, the two differ — exactly as the owner suspected they might. **So a simple counter + unique constraint suffices; the ICV's advisory-lock reservation is NOT required here** and `lockCompanySequence` gains no second caller.<br><br>**Q2 — SCOPE: per COMPANY, one series spanning invoices AND their notes, never reset.** Art. 53(5)(b) scopes uniqueness to the supplier (= the company: it holds the VAT registration and is the EGS unit). Resolution §2 forbids a solution generating more than one sequence of "Electronic Invoices and Electronic Notes" per unit, and multiple concurrent sequences are a **Prohibited Functionality** — so NOT per document type. 🔴 **The year-reset M21.2 introduced is the part that was unsupported**: nothing authorises a per-year restart, and a restart is the one arrangement sitting awkwardly against both "sequential" and the one-sequence rule.<br><br>**Fixed (migration 0054):** `UNIQUE (company_id, invoice_number)`; a monotonic per-company `invoice_number_counters` table that **never resets** (the year is a display prefix — `INV-2026-000045` → `INV-2027-000046`); allocation moved **server-side** into `invoicesService.create` via one atomic UPSERT; the browser's `` INV-${Date.now()...} `` removed; M21.2's second allocator deleted so one counter serves every invoice. A caller-supplied number is still honoured for legacy imports and the constraint judges it. The migration **refuses to run** on pre-existing duplicates and names them rather than auto-renaming — the number may already be a transmitted `cbc:ID` and a note's `BillingReference`. 9 tests, incl. a concurrency property proving a read-then-write allocator collapses 8 allocations into one (verified by re-injection).<br><br>**Still open, carried to the advisor package as Block D** (not stranded in the verification doc): **D1** whether ZATCA's *audit practice* questions gaps — the text cannot answer it, and a "yes" would mean building an explanation for each absent number rather than changing the allocator; **D2** the standing caveat that both English texts are unofficial translations with the **Arabic prevailing**, where the one word our reading rests on is متسلسل / "sequential". | [`docs/tax/invoice-numbering-verification.md`](docs/tax/invoice-numbering-verification.md) |
| C11 | ✅ **CLOSED (2026-08-23) — verified against the PRIMARY TEXTS, and the queue entry's premise was wrong in both halves.** Three documents read: the **GCC Common VAT Agreement in full (all 78 articles)**, the **KSA VAT Law M/113** (Bureau of Experts official translation — never previously read), and the IR + its Nov-2024 amendments via ZATCA's own guideline. 🔴 The Agreement's Art. 9 is REVERSE CHARGE, and **no sovereign-capacity article exists anywhere in the chain** — the delegation runs Agreement (definitions) → Law Art. 8 → IR Art. 17, which covers only TOGC. The O verdicts are VERIFIED from the definitional scope chain (Agr. Arts. 1+2; Law Art. 2; IR Art. 14) — the same plain-text application C9 used for SALARIES — plus **Agr. Art. 26(6)(b)** for grants. Migration 0057 marks all four codes `treatment_verified`. 🔴 **One condition in positive law, cutting the UNSAFE way: IR Art. 39(2)** (Nov 2024) — a "grant" compensating supplies that benefit the government, directly or indirectly, is TAXABLE CONSIDERATION; booked O it would UNDERSTATE output VAT. Per-row fact, handled by the existing treatment override; recorded loudly. **No advisor question created** — the texts answered all three. | [`docs/tax/gcc-framework-verification.md`](docs/tax/gcc-framework-verification.md) |
| C8 | 🔴 **PDPL — higher priority than C7 and answered with it. Questions written up as Block B of [`docs/product/advisor-questions.md`](docs/product/advisor-questions.md).** Phone photographs will eventually contain third-party personal data; PDPL grants erasure rights that may conflict with retention. **PDPL has never been considered anywhere in this project** — scope it to the platform (audit logs hold IPs append-only; the archive holds names/addresses 6–11 years; `users`/`customers`/`employees` have no retention policy), not just document capture.<br><br>**Sharpened 2026-08-14 (audit) — the question stopped being hypothetical.** The product now accepts phone photographs from ordinary users, and **posting a bill promotes that photograph into a store that by interface design can never delete it**. So the irreversible act is performed by ordinary users in the ordinary flow, **before the legal question has been answered**, and an erasure request for a promoted capture is today not "hard" but *impossible by construction*. The advisor question that the wiring surfaces: 🔴 **ZATCA §5.5 immutability covers invoices WE GENERATED — a supplier's invoice photographed by our user is a different class of document, and we currently give both the identical no-delete guarantee.** Ask whether inbound third-party captures may be made erasable-with-audit without touching the outbound guarantee. If yes, the archive needs a class distinction (not a `delete` on `ArchiveStore`); if no, capture needs a consent/data-minimisation story instead. Either way it is a design change, so ask before more tenants photograph more documents. | A1 |
| C10 | 🔴 **ZAKAT TAX ADVICE — the base computation itself. M17.4 IS HELD ON THIS** (owner instruction, 2026-08-15). Q1–Q8 decided the MECHANISM (working paper, GL-derived, Saudi/GCC-only, Hijri+Gregorian); the TAX CONTENT has never been checked against the Zakat Collection Regulations. Written up as **Block C of [`docs/product/advisor-questions.md`](docs/product/advisor-questions.md)**, asked in the SAME conversation as C7/C8. 🔴 **Ask C1 (the minimum-base rule) first — it is the only one that changes architecture rather than arithmetic:** if a rule ties the Zakat base to adjusted net profit, the income statement stops being Q4's cross-check and becomes a computed INPUT, so the worksheet needs an adjusted-net-profit derivation with its own adjustments and audit trail. Also open: exact base composition and which provisions qualify (needed before **M17.3**, not just M17.4), the Gregorian divisor (354 vs 354.367) and rounding convention, whether nisab has any role in corporate Zakat (assumed NO — if so, say so in the UI so its absence reads as a decision), and confirmation that declining mixed/foreign ownership is the right v1 posture. | [`docs/product/design-zakat-module.md`](docs/product/design-zakat-module.md) §4 |

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
| **LOW** | **A CSID secret could reach a log line.** `apiError()` attaches the full ZATCA response body to a loggable Error; a malformed 200 carrying `secret` but no `binarySecurityToken` would be logged by pino's err serializer. Strip/allowlist the body before attaching. | `services/einvoice/onboarding/zatcaOnboardingClient.ts:43` |
| ~~LOW~~ | ✅ **FIXED with C1 (2026-08-20)** — cookie `secure` and `trust proxy` are now explicit env facts (`SESSION_COOKIE_SECURE`, `TRUST_PROXY_HOPS`), not inferred from `NODE_ENV`, and production refuses to boot with Secure off. The stale `sameSite: strict` comment now states the `lax` the code has always set. | `app.ts` |
| **LOW** | `/llm/status` echoes `OLLAMA_URL` (internal infra URL) to any tenant holding the `llm` permission. | `controllers/llm.controller.ts:21` |
| **LOW** | **The production boot-refusal has no test**: `loadEnv` refusing `MAIL_PROVIDER=none` / `ALERT_PROVIDER=none` in production is what B1/B2 lean on, and `packages/config` has no test files. | `packages/config/src/env.ts:291,307` |
| **LOW** | Seven entity CRUD families still take raw `req.body` at the CONTROLLER (the services are now whitelisted, so this is depth-in-defence, not exposure); string length caps absent before `varchar` (M-4 family). | controllers |
| **LOW** | `route-reachability`'s shrink-check uses a narrower parser than the main test (literal paths only), so a route gaining a UI via a generated hook would not be detected as fixed. | `tests/route-reachability.test.ts:205` |
| **LOW** | The ZATCA vault-boundary test is text-matching (raw SQL slips past) — an undocumented second instance of the tracked identity-boundary limitation. | `tests/zatca-credential-vault.test.ts:109` |
| **INFO** | `zatca-crypto`'s canonicalisation test claims "exactly the three excluded elements" and proves one (the QR and Signature exclusions cannot be tested from a fixture that contains neither). | `tests/zatca-crypto.test.ts:117` |

🔴 **What the audit could NOT see** (recorded so it is not mistaken for a clean
bill): RLS *policy* coverage was the biggest gap and is now closed by
`tests/rls-coverage.test.ts`; still unaudited are the **permission-matrix seed
grants** (enforcement was audited, the grants were not), **same-org
cross-company isolation** (`app.current_company_id` at row level), **git
history entropy-scanning** (prefix/pickaxe only, no gitleaks pass), the
**accounting core's own throws** (`glPosting`, `periodLock`, approval
adapters), and **runtime-order test vacuity** (only execution reveals it).

### Other open findings (small, non-blocking)

Full text and history: [`docs/history/known-issues-and-audit-findings.md`](docs/history/known-issues-and-audit-findings.md).

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

**🔴 `| tail` THROWS AWAY THE EXIT CODE, AND "Tests: N passed" IS NOT THE
VERDICT (2026-08-21).** A local full-suite run was reported here as "905
passed" and was not green: the line directly above said **`Test Files 1
failed`**. A teardown (`afterAll`) had thrown, which vitest reports at FILE
level while every individual test still counts as passed — so the metric I
read said 905/905 while the run had failed. CI caught it on the next push.

Two mechanisms, both worth fixing in the habit:
1. **`npx vitest run 2>&1 | tail -6` exits with `tail`'s status, not
   vitest's.** The pipeline reported success regardless of the suite. Use
   `${PIPESTATUS[0]}`, or don't pipe the command whose status you need.
2. **Read `Test Files`, not just `Tests`.** A hook failure, an import error and
   an unhandled rejection all fail the FILE without failing a test.

Same family as the merge-on-completion mistake above: in both, a metric that
looked green was read in place of the one that carried the verdict. The
general form — *when a tool reports several numbers, find out which one is the
verdict before trusting any of them* — is the reusable part.

**🔴 A CI poll that waits for COMPLETION is not a merge gate (2026-08-17).**
PR #54 was merged with a RED test check: the polling loop waited for every
check to reach `status: completed` and the merge step never looked at
`conclusion`. "The checks finished" and "the checks passed" are different
facts, and the loop's author had conflated them for four green PRs in a row —
green outcomes hid the missing predicate (an obsolete-assertion cousin: the
gate was never tested by a failure until one arrived). The failure was real
(B4's sequences lacked `USAGE` on CI's plain Postgres — an environment
difference local Supabase masked; fixed forward as 0047 within minutes).
**Rule: a merge step must assert every check's `conclusion == success`, and a
wait-loop is only a wait-loop.**

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
- **🔴 Docs never state current status in their own words — they DATE their
  claims and point at §2 for "now".** Any doc that carries free-standing
  status prose WILL drift: the README described Phase 0 as the frontier twenty
  milestones after it stopped being one, precisely because it restated status
  instead of pointing at it (found 2026-08-21; six more docs had the same
  disease in milder forms, including a blueprint still recommending Redis for
  a decision C1 had settled the other way). The rule, applied everywhere:
  a status line is **"Status (YYYY-MM-DD): <claim>. Current state authority:
  CLAUDE.md §2."** — the date makes staleness visible instead of silent, and
  the pointer makes §2 the single writer for "now" (the one-writer-per-effect
  rule, applied to prose). A header must also never lag its own body: a doc
  whose §12 says "built" while its title says "building" is the
  narrower-claim shape in miniature.
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
