# Milestone as-built records (M13 → M23, the AI track, and the 2026-08 audits)

> **What this is.** The per-milestone narrative that used to live in `CLAUDE.md`
> §2 "Current State". It is HISTORY: each entry describes what was built, what
> was found while building it, and what was decided — as of the date it was
> written.
>
> **Status (2026-08-28): this file never states "now".** Current state authority:
> `CLAUDE.md` §2. If this file and §2 disagree about what is true today, §2 wins;
> this file is only the record of how it got that way.
>
> Extracted verbatim from `CLAUDE.md` on 2026-08-28 (the 157k → operating-file
> restructure). Nothing here was rewritten; it was moved.

---

**Last updated: 2026-08-27.** 🔴 **F1 CLOSED — a cross-tenant ACCOUNT TAKEOVER (HIGH)**, and 🔴 **F2 CLOSED — the operator job runner's reach was inherited from the scheduler registry rather than decided** (three offered, nine permitted; `capture-promotion` genuinely ran, unaudited). Both are the same class, now named in §3: **a composition defect is invisible to any review that reads one file at a time.** F1: any admin of any approved organization could graft a stranger's account into their own org (`POST /orgs/:orgId/members` required no consent, and `users.id` is a `serial`), making it "in scope", then reset its password and log in — into every tenant that account reached. Fixed by CONFINEMENT ([`lib/accountScope.ts`](../../apps/api/src/lib/accountScope.ts)). F2 fixed by the operator surface declaring its own reach ([`lib/operatorJobs.ts`](../../apps/api/src/lib/operatorJobs.ts)), refused at route and service, and audited. Both takeovers/reaches are executable regression tests, verified by re-injection. Also this session: the **accounting-core throws AUDITED and closed** (the last 2026-08-20 blind spot), single currency at the write boundary (#92), the owner-action checklist (#93), RTL logical properties across app code (#94), and the design pass's inherited decisions in [`docs/product/design-pass-inherited-decisions.md`](../product/design-pass-inherited-decisions.md) — including that **RTL is incomplete** while the vendored primitives stay unowned. **Audit order in flight (owner): operator surface ✅ → accounting-core services → the write paths. 🔴 **A hypothesised G-1 (that `assertOrgAdmin` exempts platform operators, letting an operator add themselves to a tenant as admin) was CHECKED AND DOES NOT EXIST** — operator status is consulted in four places, none an authz path; now pinned behaviourally by [`tests/operator-tenant-boundary.test.ts`](../../apps/api/src/tests/operator-tenant-boundary.test.ts). The **privilege surface map** ([`tests/privilege-surface-map.test.ts`](../../apps/api/src/tests/privilege-surface-map.test.ts)) now derives what each privilege reaches from the LIVE router stack and fails when it drifts — 🔴 it covers the positional shape only, and would NOT have caught F1 (§3).**

**Previously (2026-08-24): AI track complete — 3a findings, 5 scheduler+escalation, 3b explanations dark, 6a grounded answers dark; audit MED+LOW tables fully closed; R1 billing gap queued; state snapshot: [`docs/product/state-of-the-platform-2026-08-24.md`](../product/state-of-the-platform-2026-08-24.md). Owner actions (live, tickable): [`docs/product/owner-actions.md`](../product/owner-actions.md) — the writer for their state; the snapshot is frozen history.)**

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
Full findings: [`docs/history/findings-and-lessons.md`](../history/findings-and-lessons.md);
unfixed leftovers tracked under "Other open findings".
If this block disagrees with reality, fix it first.

### Where we are

| Phase | Status | Record |
| --- | --- | --- |
| **Phase 0** — Platform Foundation (M1–M10) | ✅ Complete. Multi-tenancy + RLS, auth/session hardening, RBAC, layering, CI/CD, audit logging, draft/approval workflow + 4-role model. | [`docs/history/phase-0-platform-foundation.md`](../history/phase-0-platform-foundation.md) |
| **Phase 1** — Onboarding & Multi-Company (M11.1–M11.7) | ✅ Complete. Self-service signup behind a verification gate, platform operators, document upload, company/ZATCA identity, invitations. Includes the M11.5.1 CRITICAL security hotfix. | [`docs/history/phase-1-onboarding-m11.md`](../history/phase-1-onboarding-m11.md) |
| **Phase 2** — ZATCA Phase 2 / Fatoora (M12) | 🟡 **Closed except M12.7 + M12.9**, blocked on a real Saudi taxpayer registration. Everything buildable without ZATCA credentials is done. | [`docs/history/phase-2-zatca-m12.md`](../history/phase-2-zatca-m12.md) + [`docs/zatca/m12-status.md`](../zatca/m12-status.md) |
| **M13** — Chart of accounts | ✅ Seeded system chart + `system_code` resolution in the posting path; income-statement classification fixed; balance-sheet AR/AP moved to the GL. | [`docs/feature-spec-chart-of-accounts.md`](../feature-spec-chart-of-accounts.md) |
| **M14** — Pre-production queue group A | ✅ 35-table `TRUNCATE`/`REFERENCES`/`TRIGGER` revokes + `ALTER DEFAULT PRIVILEGES` narrowed (with a throwaway-table guard test); identity-table build guard; company-scoped period-lock routes. | Queue §5 below |
| **M15** — Statement ingestion repair | ✅ Categorizer emits `system_code` (forcing-function test: every emittable code exists in the seeded chart); holding area / review surface for uploaded transactions. | [`docs/product/design-transaction-accounting.md`](../product/design-transaction-accounting.md) |
| **M16.1** — VAT page source switch | ✅ `VatReport.tsx` **files from documents** (`reports.vatReturn`, box-structured); the transaction figure is the **reconciliation view** beside it, gap itemised. (PR #25) | same design doc |
| **M16.2** — Transfers, treatment, accounts | ✅ `kind: operating\|transfer\|settlement` (transfers excluded from all P&L/tax aggregates, kept in cash flow); reconcile-grade S/Z/E/O `tax_treatment` defaulted from the category; `bank_account_id` + upload-page account picker. (PR #26) | same design doc — incl. the **treatment-verification-status flag** (most defaults are illustrative, not verified) |
| **M16.3** — Bank reconciliation | ✅ Exact-match suggestions (never actions) on the review surface; settling routes through the existing pay paths (`kind: settlement` + document links); real partial-payment semantics in pay (accumulate; overpay 409); the M15 review surface got its first UI consumer (`/review`). Live pass observed: settling a 3,450 receipt moved no income/VAT figure, cash flow +3,450, AR aging → 0. | design doc §3 (as-built + live-pass record) |
| **Demo deployment** | ✅ **Codebase demo-ready; nothing deployed.** `DEMO_MODE` REMOVES capabilities and weakens no guard: capture, signup and ZATCA onboarding are refused **at the route**, ZATCA transmission is refused **at boot**, a server-driven bilingual banner runs on every page incl. login, and a weekly reset wipes + re-seeds in one transaction. 🔴 The reset's safety is **structural, not the flag**: it refuses unless the database holds exactly one organization and it is the demo. Seed data is posted through the product's own write paths and starts **claimable**, so uploading a statement demonstrates the liquidity claim being withheld. Also new: `SERVE_WEB_DIST` (default unset) lets the API serve the SPA same-origin — a cookie decision, not a cost one. | [`docs/product/demo-deployment-decisions.md`](../product/demo-deployment-decisions.md) + [runbook](../product/demo-deployment-runbook.md) |
| **M19.6** — receivables bridge | ✅ Analytics now shows **Invoiced vs Collected** (flows) and **receivables outstanding** (stock) on separate canvases, plus the bridge as numbers: `opening + invoiced − collected − credited − other = closing`. 🔴 The identity is **structural, not checked** — every term is a debit or credit on ONE GL account, so `closing` IS the balance-sheet AR figure rather than agreeing with it. **Two items of §6.1 are deliberately NOT built:** net cash per period is HELD on a source question (`reports.cashFlow` is transaction-derived and disagrees with GL cash by a measured 10,800 on the dev org — transfers never post, and document payments create no transaction), and the historical overdue share is **not derivable** at all (no dated payment history). | [`docs/product/design-analytics.md`](../product/design-analytics.md) §6.1 |
| **M19.7 → A** — the GL owns cash | ✅ **The C → D → A sequence is complete (A: 2026-08-17, PR #54/#55).** Transfers POST by declared direction (own_account → Transfer clearing; external → External transfers, equity; undeclared → Transfers awaiting declaration, which posts — the bank moved — and **blocks the liquidity claim** like SUSPENSE). The cash card reframed: **the ledger is cash; the reconciliation states where the bank statement differs and why** (settlements / unposted_legacy / ledger_only; `unexplained` still returned, not asserted). Live pass observed: backfill posted 5 transfers, cash −94,194.15 → −122,494.15, transfer suspense +28,300, total assets unchanged, gap −19,550 → +8,750 fully itemised, declaring one transfer moved exactly its 2,000 from suspense to clearing. 🔴 **Found and fixed during the build: posted-only report filters double-negated every REVERSAL** (±8,750 live) — see §4's `JE_IN_BOOKS` rule. | [`docs/product/design-analytics.md`](../product/design-analytics.md) §6.1 (as-built + live pass) |
| **Automation** | **A1** ✅ document capture (client-side Tesseract OCR + ZATCA QR TLV decode, staged captures). **A3** ✅ recurring documents, **drafts only**. **A2** (bank feeds) not started — exploratory outreach only ([`docs/product/a2-provider-outreach.md`](../product/a2-provider-outreach.md)). | [`docs/product/feature-spec-automation.md`](../product/feature-spec-automation.md) |
| **M17.0** — Zakat: retire the fake surface | ✅ The Zakat page **states it is not implemented**; `is_zakat_relevant` / `zakat_relevant` deleted everywhere (migration 0038) and `GET /summary/zakat` removed. | [`docs/product/design-zakat-module.md`](../product/design-zakat-module.md) |
| **M17.1** — Zakat ownership scope | ✅ Q2: `companies.ownership_type` (`SAUDI_GCC\|FOREIGN\|MIXED`, migration 0040), **nullable with NO default** — NULL = not declared is a first-class state, because a default would have the platform assert the tenant's ownership and that assertion gates the Zakat surface. The page branches **three** ways (ask / module / out-of-scope-see-your-advisor); a declaration can be withdrawn. Rule lives in `lib/zakatScope.ts` — 🔴 **M17.4's endpoint must call it and refuse non-`eligible`.** | same design doc §5b |
| **M17.2** — Fiscal year + calendar | ✅ Q3's stated prerequisite, and it closes a five-milestone gap: `fiscalYearStart` is finally resolved. `fiscal_calendar` (gregorian \| **Umm al-Qura** hijri, migration 0039 + two CHECKs), a pure resolver (`lib/fiscalYear.ts`), Hijri conversion by **binary search over the ICU tables** (`lib/hijriCalendar.ts` — an arithmetic estimate was tried and is wrong, months are tabulated), a **boot assertion** that refuses to start on a small-ICU runtime, `GET /companies/current/fiscal-years`, and Company Settings showing real boundaries. **Reports still take explicit dates** — see the known-issue note. | same design doc §3 |
| **M20.0** — the lying column | ✅ Migration 0044: `fiscal_year_start` nullable, NO default, **existing rows NULLed** (the 1s were the old default, not data). `GET /companies/current/fiscal-years` returns `declared: false` when undeclared; `null` on update WITHDRAWS. 🔴 Also fixed: Company Settings' submit coerced `?? 1`, so saving an ADDRESS would have re-declared January — the write-boundary corollary (§3). Part 6 fired: the suite's first test guarded the defect; rewritten. (PR #47) | [`docs/product/design-fiscal-periods.md`](../product/design-fiscal-periods.md) §8 |
| **M20.1** — report default windows | ✅ Sixteen report pages open on the tenant's **current fiscal year** (resolver boundaries, Gregorian or Hijri) or a **rolling last 12 months** when undeclared, with the F13 inline notice on the report itself. One data hook (`useReportDefaultRange`) owns the decision; the bespoke date controls stay (F5). A failed settings fetch falls back with NO notice — the page won't assert what it doesn't know. Release note shipped (reports change on open with no user action). `VatReport` verified OUT of the class (opens empty, asserts nothing). (PR #48) | same design doc §8 + [release note](../release-notes/m20-1-report-default-windows.md) |
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
See [`docs/product/design-fiscal-periods.md`](../product/design-fiscal-periods.md)
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
See [`docs/product/design-quotations-purchase-orders.md`](../product/design-quotations-purchase-orders.md).

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

**AI-6a — grounded answers (2026-08-24, dark by construction).** The CFO
surface, register A ONLY (owner: FACT + PROJECTION — "the CFO that shows
its work and never advises," chosen deliberately; 🔴 **the OPINION register
is QUEUED post-C10, not rejected** — it would be the platform's first
unverifiable voice, and the fence question travels with it). Six tools from
Analytics + the Finance Hub (the model SELECTS one or refuses, never
authors a number); `runway_projection` on GL cash, and 🔴 **its assumption
is machine-enforced IN the answer** — the sentences are tool output and an
answer without both verbatim is rejected ("an assumption a reader can skip
is an assumption they'll skip"). The liquidity-claim withholding carries
over (blocked cash ⇒ no projection, blockers named). Every exchange is an
append-only `grounded_answers` row (0061) — refusals included; rejected
model text is NEVER stored. Unavailability is an honest 503; the ask box
hides via /ask/status; dark until Enterprise by the boot boundary. Surface
woven into Analytics + Finance Hub, no destination. As-built:
[`ai-6-proposal.md`](../product/ai-6-proposal.md) §0/§5.

**AI-3b — model explanations on findings (2026-08-24, dark-launched).** The
first model output in real product code: 1–2 sentences rendering a
finding's FACTS, both languages, generate-then-verify. 🔴 The verifier's
honest contract: the numeric/entity class is PROVEN mechanically
(cross-script canonical matching; `normalizeDigits` copied from
receiptParser with an equivalence pin — single-sourcing needs a shared
package, flagged not restructured); the qualitative class is only ARGUED (a
judge pass must return empty) — which is why the UI renders the
deterministic facts BESIDE the explanation, never instead. Owner conditions
held: rejection telemetry distinguishes invented-number from
couldn't-match-a-real-number (token + script + normalized form);
discard-and-log, never retry; low-context findings (<3 facts) get NO
attempt; staleness = invention by aging (factsHash gate at the API);
deterministic is the FLOOR (throwing provider pinned harmless). Dark via
the existing AI-1a boot boundary — no new flag. As-built: proposal §0d.

**AI-5 — scheduled findings (2026-08-24, taken before AI-3b by owner
instruction — deterministic reaches tenants now; the delivery mechanism
proves itself on trusted content before model output rides on it).** Hourly
platform job; calendar cadence (quarterly default / monthly opt-in,
approver-set); `(org, period)` run row as the CLAIM. The push ladder as the
owner amended it: **one** email to ACTIVE ADMINS only (counts + pointer,
never contents; no-recipient orgs logged loudly), then — never a second
email — after 7 unviewed days a **persistent Dashboard marker** (derived
"unviewed + old", never stored) that stands until an approver-level role
opens the Findings page: **opening is the dismissal**, viewing is stamped
`viewed_at`/`viewed_by`, a viewer's visit does not clear it, and nothing
auto-acknowledges at any age. 🔴 **The honest limit, recorded plainly: the
chain ends where the tenant's attention ends** — the product records that a
run was never opened; it cannot make someone read. As-built: proposal §0c.

**AI-3a — the findings engine, deterministic core (2026-08-24).** The
build-order proposal's five questions are ANSWERED (owner, 2026-08-24 —
recorded verbatim in [`ai-build-order-proposal.md`](../product/ai-build-order-proposal.md) §0:
findings-first; 🔴 tax gate stays at **(a) internal-consistency only until
C10 closes** — the (b) citation-carrying widening is QUEUED post-C10 with
Art. 50 meal-VAT as first candidate; push = in-app + unread-escalation +
admin email, never the B2 webhook, and **a finding records where it was
sent**; dark-launch confirmed with the boot boundary untouched; model pin
deferred to Enterprise negotiation). **AI-3a BUILT:** eight
internal-consistency checks as ROWS (`findings`, 0058 — no DELETE for the
app role; a resolved finding is the record it was found), upsert identity
`(org, kind, ref_key)`, lifecycle open → acknowledged (survives
re-detection; the machine never un-acknowledges a human) → machine-resolved;
acknowledge is APPROVER-only (dismissing a money warning is a review
decision; bookkeeper negative pinned); no severity anywhere (the status
palette rule); gaps reported as lawful observations (C12); credit-aware
overdue (Tier 3); zero-movement pinned through the real report services.
`/findings` under Reports. Next per the answered order: AI-3b (model
explanations, dark-launched) and AI-5's scheduler carries the push channels.
As-built: proposal §0b.

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
[`docs/product/design-ai-layer.md`](../product/design-ai-layer.md).

**Product structure (the hubs) is DECIDED** — 2026-08-12, by owner interview:
two destinations (Finance Hub, Analytics), Automation and AI woven into existing
pages, Automation is the wedge. See
[`docs/product/hub-structure-decision.md`](../product/hub-structure-decision.md).
That decision record supersedes any earlier inferred hub description; only
Automation is specced to build-depth.

### 🔴 What is verified LIVE vs only LOCALLY (ZATCA)

Full detail: [`docs/zatca/m12-status.md`](../zatca/m12-status.md).

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

