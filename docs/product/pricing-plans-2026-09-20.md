# Saudi Ledger — the three plans, derived from the product (2026-09-20)

**Status (2026-09-20): PROPOSAL — packaging and prices derived bottom-up from
the repository on this date. Nothing here is built, decided or sold. This
document SUPERSEDES the four-plan recommendation (§D, §H, §V) of
[`pricing-strategy-2026-09.md`](pricing-strategy-2026-09.md); that document
remains the source for the competitor research (§A–§B), the entitlement
architecture (§S–§U) and the accounting-safety rules (§T), and
[`pricing-unit-economics-2026-09.md`](pricing-unit-economics-2026-09.md)
remains the source for every cost figure. Current state authority:
[CLAUDE.md §2](../../CLAUDE.md); the open R1 row is CLAUDE.md §5.**

**Why this revision exists.** The 2026-09-19 research produced four public
plans and built the Advanced tier on "three companies pooled". Re-reading the
repository for this revision found that **multi-company per subscription does
not exist** (§0.2 below), so that tier was priced on an unbuilt feature — the
exact failure the research warned against. This revision starts again from
the product, presents **three** public plans (Basic / Pro / Advanced) with an
"Advanced — contact us for larger requirements" pathway instead of a fourth
card, and applies the placement vocabulary the owner asked for.

**Source discipline.** Every row below carries one of these tags:
**FACT** (read from this repository on 2026-09-20, with the file or route that
proves it) · **COMPETITOR FACT** (from the 2026-09-19 research, with its
source) · **CALCULATION** (from the unit-economics companion) ·
**STRATEGIC DECISION** (a recommendation, not a fact) · **ASSUMPTION**.
Status labels: **LIVE** (on `main`, reachable from a screen a user can click)
· **IN DEVELOPMENT** (code exists on an unmerged branch, or the backend exists
with no screen, or built but dark pending an owner action) · **PLANNED**
(a coming-soon entry, a roadmap row, or a design document with no code) ·
**NOT A PRODUCT FEATURE** (internal or operator capability; never on the
pricing page).

---

## Contents

- [0. What changed since the 2026-09-19 research — four corrections](#0-what-changed)
- [A. The actual Saudi Ledger feature inventory](#a-feature-inventory)
- [B. The three customer segments](#b-the-three-customer-segments)
- [C. How every feature was placed — the nine questions](#c-how-every-feature-was-placed)
- [D. Master entitlement matrix (Basic / Pro / Advanced)](#d-master-entitlement-matrix)
- [E. Usage limits](#e-usage-limits)
- [F. AI packaging and the derived allowance](#f-ai-packaging)
- [G. Pricing — recalculated](#g-pricing)
- [H. Upgrade triggers](#h-upgrade-triggers)
- [I. Downgrade rules](#i-downgrade-rules)
- [J. Add-ons](#j-add-ons)
- [K. ORGINOO website package — for the freelancer](#k-orginoo-website-package)
- [L. Internal pricing rationale](#l-internal-pricing-rationale)
- [M. Unresolved decisions](#m-unresolved-decisions)

---

## 0. What changed

Four repository facts (all FACT, 2026-09-20) that the 2026-09-19 research
either missed or that have not moved:

### 0.1 Batch 1B and 1C are still not on `main`

`feat/batch-1b-d4-payments` (8 commits ahead) and
`feat/batch-1c-migration-opening-balances` (14 commits ahead; last commit
2026-09-19) are unmerged (`git merge-base --is-ancestor` → false for both).
They carry: `routes/payments.ts` (payments, allocations, unallocation,
refunds, credit-note application, deterministic bank matching with
override/unmatch), `routes/migration.ts` (batches → chart mapping → parties
→ open items → advances → opening position → validate → commit → clear-OBE →
reverse), and the pages `/payments`, `/customers/:id/statement`,
`/bank-matching`. **A customer cannot use an unmerged branch**, so every one
of these is IN DEVELOPMENT, and the public page cannot list them.

### 0.2 🔴 Multi-company per subscription is NOT built

`lib/tenant.ts` resolves the tenant's company as **the first-created company
of the active organisation** (`orderBy(asc(companiesTable.createdAt)).limit(1)`).
`routes/companies.ts` exposes only `/current` (get, patch, logo, fiscal
years) — **there is no route that creates a second company and no company
switcher**. What does exist is **organisation switching** (`POST /orgs/switch`):
one user can belong to several organisations and move between them. So the
honest shape today is *one subscription = one organisation = one company*;
a group with two CRs is two organisations, and a user can switch between
them. The previous Advanced tier ("3 companies pooled, SAR 449") sold a
feature with no writer. **Multi-company is PLANNED** (no coming-soon slug
either — it is not even promised) and is placed as FUTURE / NOT YET MARKETED
below.

### 0.3 🔴 Fixed-asset depreciation does not reach the ledger

`services/assets.service.ts` contains no `postJournalEntry` and no period
check (grep: 0 hits). `POST /assets/:id/depreciate` mutates the register's
book value and inserts a `depreciation_entries` row; **the balance sheet and
income statement do not move**. The routes are `list`, `get`, `create`,
`depreciate` only (PATCH/DELETE were removed 2026-09-15, #158). This is ERPNext
finding 6 in the comparison's triage addendum ("wrong statements TODAY for
anyone who clicks the built `/assets` page"), awaiting the owner's ranking.
The 2026-09-19 research described "straight-line depreciation posting" — that
was wrong. The register is LIVE; **depreciation accounting is PLANNED**.

### 0.4 ZATCA onboarding is unreachable from the UI

The `/zatca` checklist requires the national-address *additional number*
(KSA-23); Company Settings has no field for it, so the **Onboard** button
never enables (known-issues file, "ZATCA ONBOARDING UNREACHABLE FROM THE UI",
2026-09-16; pilot decision: run deliberately not onboarded). Combined with
the standing fact that production clearance/reporting has **never been called
in any environment** (M12.7/M12.9, entity-blocked), the customer-facing claim
has to be: invoices carry the ZATCA counter, hash and QR today (LIVE);
**signed e-invoice submission is IN DEVELOPMENT** until the entity exists and
the field is added.

Also re-confirmed unchanged: 62 routed paths in `apps/web/src/App.tsx`
(63 `<Route>` elements, one the catch-all `NotFound`), 123 API paths in `openapi.yaml`, 45 coming-soon
promises in `comingSoon.ts` (blockers: `build` ×24, `advisorBlockC` ×4,
`advisorBlockE` ×3, `cr` ×3, `groq` ×2, `inventory` ×2, `mailProvider` ×2,
`entity`, `notDerivable`, `pdpl`, `productDecision`, `r1Billing`); AI dark
by construction (`loadEnv` refuses `AI_PROVIDER=groq` in production without
the data-boundary attestation); no API-key auth anywhere (session cookies
only); billing does not exist.

---

## A. Feature inventory

The brief's module list, answered from the repository. "Evidence" is what
proves the status; a reader can re-run every grep.

### A.1 Core accounting

| Capability | Status | Evidence (FACT) |
| --- | --- | --- |
| Chart of accounts — flat list, create, Arabic + English names, system accounts protected, org-seeded on signup | LIVE | `/categories`; `seed_org_chart_of_accounts()` trigger; no edit/delete routes |
| Chart tree view, spreadsheet import, CoA settings | PLANNED | coming-soon `coa-tree-view`, `coa-import`, `coa-settings` (advisor Block E) |
| General ledger, double entry, balanced posting through one seam | LIVE | `services/accounting/glPosting.ts`; `/reports/general-ledger` |
| Manual journal entries: draft → submit → approve → post → reverse | LIVE | `/journal-entries`; approval engine |
| Posting (every document posts through `postJournalEntry`; rounded lines, balance checked on what is stored) | LIVE | N2 money seam, `lib/money.ts` |
| Trial balance, income statement, balance sheet, owner's equity | LIVE | `/trial-balance`, `/income-statement`, `/balance-sheet`, `/reports/owner-equity` |
| Cash flow — **direct method only** | LIVE | `/cash-flow`; indirect method is a roadmap row |
| Period controls — closed months, company-scoped, the 423 explanation | LIVE | `/closed-months`, `/period-locks` (M22) |
| Audit trail reader | LIVE | `/audit-trail`, `/audit-logs` (M23) |
| Accounting approvals — one engine on invoices, bills, JEs, quotations, POs, payroll; worklist | LIVE | `/approvals`, `services/approval/` |
| Fiscal years, Hijri + Gregorian dating, business day = `Asia/Riyadh` | LIVE | M17.0–17.2, M20, `@workspace/shared` `businessDate.ts` |
| Budgets per category with variance | LIVE | `/budgets` |
| Cost centres / projects | PLANNED | coming-soon `cost-centers` |
| Multi-currency | PLANNED — **SAR enforced at the write boundary** (CHECK on nine tables) | coming-soon `multi-currency`; migration 0062 |
| Multi-company under one subscription | PLANNED (no slug) | §0.2 |

### A.2 Customers / sales

| Capability | Status | Evidence |
| --- | --- | --- |
| Customer management (list, create, detail, party picker) | LIVE | `/customers`, `/customers/:id` |
| Quotations — draft/submit/approve, convert to invoice | LIVE | `/quotations`, `/quotations/:id/convert` |
| Invoice creation, line VAT (S/Z/E/O), product picker optional | LIVE | `POST /invoices` |
| Invoice approval — submit/approve/send-back/reject; approval mints ICV, hash, QR; fail-closed on missing company VAT/CR | LIVE | `/invoices/:id/{submit,approve,send-back,reject}` |
| Invoice PDF, Arabic and English, logo, QR, Hijri dates | LIVE | `GET /invoices/:id/document?lang=` (L1) |
| Send invoice by email | PLANNED — no send route exists; waits on the mail provider (B1) | coming-soon `email-providers` |
| Credit notes (reverse an invoice, credit-correct in the VAT return) | LIVE | `/credit-notes` |
| Debit notes | LIVE capability, **page removed** | coming-soon `debit-notes` — not marketed |
| Customer payments — "mark paid" / record payment against one invoice | LIVE | `POST /invoices/:id/pay`, `GET /invoices/:id/payments` |
| Payment **allocation** across invoices, unallocation, unapplied receipts / deposits / advances, refunds, credit-note application | IN DEVELOPMENT | branch `routes/payments.ts` (§0.1) |
| Customer statement page | IN DEVELOPMENT | branch `/customers/:id/statement` |
| Customer ledger report | LIVE | `/reports/customer-ledger` |
| AR ageing | LIVE | `/ar-aging`, `/reports/aging` |
| Receivables analytics (receivables bridge) | LIVE | `/analytics` `useGetReceivablesBridge` |
| Invoice/quotation templates, customer groups | PLANNED | coming-soon `invoice-templates`, `quotation-templates`, `customer-groups` |
| Recurring invoices (drafts only, by consent principle) | LIVE | `/recurring` (A3) |

### A.3 Suppliers / purchases

| Capability | Status | Evidence |
| --- | --- | --- |
| Supplier management | LIVE | `/vendors`, `/vendors/:id`, `/vendors/match` |
| Purchase orders — submit/approve, convert to bill | LIVE | `/purchase-orders` |
| Bills — draft/submit/approve/post/pay | LIVE | `/bills`, `/bills/:id/{post,pay}` |
| Document capture: phone/upload → ZATCA QR decode → Tesseract OCR fallback → scan-review → bill | LIVE | `/capture`, `/scan-review` (A1); OCR is in-process, no paid provider |
| Supplier payments (pay a bill) | LIVE | `POST /bills/:id/pay` |
| Supplier payment allocation object (AP twin of the customer one) | PLANNED | not on either branch |
| Supplier statements, purchases by vendor | PLANNED | coming-soon `vendor-statements`, `purchases-by-vendor` |
| AP ageing | LIVE | `/ap-aging` |

### A.4 Banking

| Capability | Status | Evidence |
| --- | --- | --- |
| Bank accounts (CRUD) | LIVE | `/bank-accounts` |
| Bank statement import (CSV), transactions list, manual transaction create/edit | LIVE | `/upload`, `/transactions` |
| Transaction review queue — accept a held row, settle against an invoice or bill, bulk accept (refuses a closed month truthfully) | LIVE | `/review`, `/transactions/review/accept`, `/transactions/:id/settle` |
| Deterministic bank matching (statement ↔ payment), override, unmatch | IN DEVELOPMENT | branch `/bank-matching`, `routes/payments.ts` `matching/*` |
| Bank reconciliation **statement** (opening balance + items = closing) | PLANNED | not designed; the review queue is the reconciliation surface today |
| Bank transfers (own / external / undeclared) posting to the GL | LIVE capability, **no page** | coming-soon `transfers`, `transfer-reports` |
| Per-bank cash GL (one cash account per bank) | IN DEVELOPMENT | branch D-3; the historical cut-over has not run on any company |
| Live bank feeds | PLANNED — **blocked on a Saudi CR** for the SAMA-licensed provider | coming-soon `live-bank-feeds` (`cr`) |
| Cash management — Finance Hub liquidity (neutral "watch" observations) | LIVE | `/finance-hub` |
| Bank account detail page, statement register | PLANNED | coming-soon `bank-account-detail`, `bank-statement-register` |

### A.5 Tax / Saudi compliance

| Capability | Status | Evidence |
| --- | --- | --- |
| VAT on every line (S/Z/E/O), documents FILE and transactions RECONCILE | LIVE | design-transaction-accounting Q0 |
| VAT return (box-structured, credit-note-correct), VAT summary | LIVE | `/vat` |
| Tax journal entries report (keyed on `system_code` since #158) | LIVE | `/reports/tax-journal-entries` |
| Saudi invoice requirements — seller VAT/CR, buyer VAT, Hijri + Gregorian dates, nine-tag QR, ICV, hash chain | LIVE | approval path; live-sandbox-verified construction |
| ZATCA Phase 2 document construction (CSR, `secp256k1`, XAdES, six compliance documents) — verified against the live sandbox | LIVE (construction) | `tests/zatca-compliance-live.test.ts`, `docs/zatca/m12-status.md` |
| ZATCA onboarding UI, credential vault, outbox worker, archive, renewal reminders | IN DEVELOPMENT — onboarding unreachable from the UI (§0.4); transport proven against a mock; archive `local-fs` | known-issues file |
| ZATCA production clearance / reporting submission | IN DEVELOPMENT — **never called in any environment**; entity-blocked | coming-soon `zatca-production-submission` (`entity`) |
| ZATCA-related controls: fail-closed issuance for onboarded companies, serialised ICV, append-only archive with direct audit link | LIVE (code) | CLAUDE.md §4 |
| Tax audit trail — every approval, posting and settlement is an audit row | LIVE | `/audit-trail` |
| Zakat — scope and fiscal calendar | LIVE | `/zakat` shows the explained not-implemented state |
| Zakat base, calculation, reports, settings | PLANNED — held on advisor Block C | coming-soon `zakat-*` ×4 |
| Withholding tax | PLANNED — zero code; one of the four ERPNext findings awaiting the owner's ranking | coming-soon `withholding-tax` |

### A.6 Reporting

| Capability | Status | Evidence |
| --- | --- | --- |
| Standard reports catalogue | LIVE | `/reports` |
| Financial statements (TB, P&L, BS, cash flow direct, owner's equity) | LIVE | §A.1 |
| Account statement, account summary, general ledger report, journal report, activity | LIVE | `/reports/*` |
| Customer ledger, AR ageing, AP ageing, aging (combined) | LIVE | `/reports/customer-ledger`, `/reports/aging` |
| Tax journal, invoice summary, payroll report, asset schedule | LIVE | `/reports/tax-journal-entries`, `/invoice-summary`, `/payroll-report`, `/asset-schedule` |
| Analytics — trend, receivables bridge, cash reconciliation, decomposition (WHERE, never WHY) | LIVE | `/analytics` |
| Finance Hub — liquidity, tax compliance, books status | LIVE | `/finance-hub` |
| Budgets and variance | LIVE | `/budgets` |
| Management reporting (custom reports, scheduled reports, dashboard layout) | PLANNED | coming-soon `custom-reports`, `dashboard-layout` |
| Aging trends | PLANNED — the fact is not stored | coming-soon `aging-trends` (`notDerivable`) |
| Data export (CSV/Excel of the books) | PLANNED — held on PDPL (advisor C8) | coming-soon `data-export` (`pdpl`) |
| Consolidated multi-company reporting | PLANNED | depends on §0.2 |

### A.7 Automation

| Capability | Status | Evidence |
| --- | --- | --- |
| Recurring documents (invoices, bills) — produce **drafts** on schedule; a human approves | LIVE | `/recurring`, job `recurring-documents` |
| Recurring journal entries | PLANNED | coming-soon `recurring-journal-entries` |
| Transaction review (held rows, accept/settle) | LIVE | `/review` |
| Deterministic categorisation rules (Arabic + English keywords), run on demand | LIVE | `/categorize`, `services/categorization/` |
| Automated findings — deterministic rules (suspense balances, stale drafts…), scheduled daily, acknowledge | LIVE | `/findings`, job `scheduled-findings` (AI-3a/AI-5) |
| Approval workflows — single-step draft/submit/approve/send-back/reject | LIVE | `services/approval/` |
| Multi-step or role-routed approval rules | PLANNED | not designed |
| Notifications to users (email / in-app preferences) | PLANNED — waits on the mail provider | coming-soon `notification-preferences` (`mailProvider`) |
| Scheduled jobs actually running: `zatca-renewal-reminders`, `capture-promotion`, `recurring-documents`, `capture-purge`, `platform-alarms`, `scheduled-findings` | LIVE | API boot log, 2026-09-20 |
| Operator alarms (webhook) | NOT A PRODUCT FEATURE — and `ALERT_WEBHOOK_URL` is unwired (B2) | `lib/alerter.ts` |

### A.8 Assets

| Capability | Status | Evidence |
| --- | --- | --- |
| Fixed-asset register (create, list, detail; cost, salvage, useful life, location, serial) | LIVE | `/assets`; routes list/get/create only |
| Depreciation schedule (monthly straight-line, per-asset history) | LIVE (register arithmetic) | `POST /assets/:id/depreciate`; `depreciation_entries` |
| **Depreciation posting to the GL** (expense / accumulated depreciation) | PLANNED — §0.3 | no `postJournalEntry` in the service |
| Declining-balance method | PLANNED — the column accepts the value; no arithmetic exists | grep `declining` in the service: 0 |
| Asset disposal / sale with GL effect | PLANNED — status/disposal columns exist, no route can set them after creation | #158 removed PATCH |
| Asset reporting (schedule) | LIVE | `/asset-schedule` |

**Marketing consequence (STRATEGIC DECISION):** until depreciation posts to
the GL, the register is a memorandum list whose figures never reach the
statements. It is not marketed as "fixed-asset accounting". It stays
reachable for the pilot, and the public page says nothing about it until
the owner ranks ERPNext finding 6.

### A.9 Payroll / employees

| Capability | Status | Evidence |
| --- | --- | --- |
| Employees — Saudi ID/Iqama, nationality, salary + housing/transport/other allowances, GOSI number, IBAN, joining/end dates | LIVE | `/employees`; CRUD routes |
| Payroll runs — per-period generation with **GOSI computed per employee** (Saudi 9.75 % / 11.75 %, non-Saudi employer 2 % — `GOSI_RATES` in `@workspace/shared`), additions/deductions, net pay | LIVE | `services/payroll.service.ts` |
| Payroll approval (submit / send-back / reject / approve) | LIVE | `/payroll/:id/*` |
| Payroll GL posting on approval (Dr Salaries + Employer GOSI / Cr Net Pay + GOSI Payable) | LIVE | `payroll.approvable.ts` → `postJournalEntry` |
| Payroll report | LIVE | `/payroll-report` |
| WPS file, Mudad, GOSI portal submission, payslips, end-of-service, leave | PLANNED — none exists | — |

**Marketing consequence:** this is a **payroll journal** — it computes GOSI
and posts salaries to the ledger correctly. It is not a payroll *service*
and is never marketed as one ("payroll journal with GOSI" is the honest
label; "payroll" alone over-promises WPS).

### A.10 Products / inventory

| Capability | Status | Evidence |
| --- | --- | --- |
| Product & service catalogue — code, name (AR/EN), type product/service, unit price, unit cost, unit, VAT flag, category; optional picker on invoice/bill lines | LIVE | `/products`; `products.service.ts` |
| Stock quantity / reorder point | **a column with no consumer** — nothing decrements `stock_qty` on an invoice or increments it on a bill (grep: only the CRUD allow-list) | NOT A PRODUCT FEATURE today |
| Inventory — stock movements, COGS posting, valuation, sales/purchases by product | PLANNED — waits on advisor Block E (the COGS account decision); the owner's stated #1 | roadmap; coming-soon `sales-by-product`, `purchases-by-product` (`inventory`) |

**Determination:** the Products module is a **product master for pricing
and line entry** — neither true inventory nor stock accounting. It is
marketed as "product & service catalogue" and never as inventory.

### A.11 Migration (Batch 1C)

| Capability | Status | Evidence |
| --- | --- | --- |
| Migration batches with staging schema and DB-level immutability | IN DEVELOPMENT | branch `routes/migration.ts` |
| Chart-of-accounts mapping (source → Saudi Ledger accounts) | IN DEVELOPMENT | `PUT /migration/batches/:id/chart` |
| Party migration (customers, vendors, with source identity) | IN DEVELOPMENT | `/parties` |
| Historical AR/AP open items — **opening accounting items, never new tax invoices** (no ICV, no ZATCA) | IN DEVELOPMENT | `/open-items` |
| Customer advances | IN DEVELOPMENT | `/advances` |
| Opening balances / opening position through the opening-balance-equity seam | IN DEVELOPMENT | `/opening-position` |
| Migration validation (R1–R10 gates, pre-commit) | IN DEVELOPMENT | `/validate` |
| Reconciliation (OBE clearing after commit) | IN DEVELOPMENT | `/clear-obe` |
| Correction controls (reversal preview, reversal, corrected re-run; correction policy researched against SOCPA/ZATCA primary sources) | IN DEVELOPMENT | `/reversal-preview`, `/reverse`; commit 5a345ae |
| Migration **UI** | PLANNED — the branch has no migration page | branch `App.tsx` adds no `/migration` route |
| Spreadsheet CoA import | PLANNED | coming-soon `coa-import` |
| **Assisted migration as a service** (a person does it with you) | Available **today** at the level the product supports: opening trial balance and aggregate AR/AP through manual journal entries, customers/vendors by hand; per-invoice open items and advances only after 1C ships | a service, not code |

### A.12 AI

| Capability | Status | Evidence |
| --- | --- | --- |
| Provider seam (`AiProvider`, Groq REST implementation, `AiUnavailableError` fail-closed, per-call `maxTokens`) | LIVE, **dark by construction** | `services/ai/provider.ts`; `loadEnv` refuses Groq in production without `GROQ_DATA_BOUNDARY_ACK` |
| Metering — `ai_usage` (org, company-or-NULL, operation, provider, model, prompt/completion tokens, latency, ok/failed; append-only) | LIVE | `packages/db/src/schema/aiUsage.ts` — the table every allowance is enforced from |
| AI assistant — grounded answers over the ledger (`/ask`): tool-selected figures, bilingual, judged, refuses when ungrounded, `maxTokens 400` | LIVE, dark | `ask.service.ts`; entry from `/finance-hub` and `/analytics` |
| Categorisation second opinion — only for rows the deterministic engine scores < 0.65; `maxTokens 200`; degrades to deterministic | LIVE, dark | `categorization/llmCategorizer.ts` |
| Findings explanations — plain-language explanation of a deterministic finding; ≤ 25/run; content-hash de-duplicated; judged | LIVE, dark | `findings.explain.service.ts` |
| Document intelligence — QR decode + Tesseract OCR (no model call) | LIVE | A1 |
| OCR/extraction by a vision model (the tail after QR + Tesseract) | IN DEVELOPMENT — benchmark harness only; **the default `GROQ_VISION_MODEL` was shut down on Groq 2026-07-17**; needs the Groq Enterprise agreement AND an Arabic-capable vision model in Dammam | coming-soon `vision-model` (`groq`) |
| Reconciliation assistance | PLANNED — matching is deterministic (Batch 1B); no AI spec | — |
| Financial analysis / analytics | Deterministic analytics are LIVE (§A.6); AI narrative on top = grounded answers (dark); a monthly brief is PLANNED, unspecced | — |
| Anomaly / finding workflows | The findings engine is **deterministic and LIVE**; only the explanation is a model call | AI-3a vs AI-3b |
| Forecasting | **NOT IN ANY DESIGN DOCUMENT** | — |

"Dark by construction" means: the code is on `main`, walked, and metered, but
the boot boundary refuses tenant data until the Groq Enterprise agreement
(Dammam pinning + contractual ZDR) or a Saudi provider is signed (C6). **AI
is therefore sold as "included in your plan — activating soon", never as
available today.** §K carries two versions of every AI line for that reason.

### A.13 Platform, security, integrations

| Capability | Status | Evidence |
| --- | --- | --- |
| Session auth, invitations, four roles (admin / accountant / bookkeeper / viewer) with a seeded permission matrix, activation actions separately grantable | LIVE | `/users`, `permissions` table |
| Organisation switching (one user, several organisations) | LIVE | `POST /orgs/switch` |
| Security events per organisation | LIVE | `GET /orgs/:orgId/security-events` |
| Verification gate — signup → `pending_review` → operator approves (KYC); the wait is undefined (L3) | LIVE | `lib/tenant.ts` |
| Password change; break-glass reset by an operator | LIVE | `/change-password`; #141 |
| Self-service email password reset | IN DEVELOPMENT — waits on the mail provider | coming-soon `password-reset` |
| 2FA, session management, IP restrictions | PLANNED | coming-soon `two-factor`, `session-management`, `ip-restrictions` |
| Public API / API keys / webhooks | PLANNED — **no API-key auth exists**; the OpenAPI contract (123 paths) and generated client exist and are used by the web app only | — |
| Payment gateways (MyFatoorah, SiFi) | PLANNED — CR-gated | coming-soon `myfatoorah`, `sifi` (`cr`) |
| Email delivery of documents and notices | PLANNED — `MAIL_PROVIDER=none`; `resend`/`postmark` seams exist | `packages/config/src/env.ts` |
| Malware scanning of uploads | header sniff LIVE; clamd sidecar is deployment-time (C4) | — |
| Billing / subscription | **DOES NOT EXIST** (R1). `organizations.plan` defaults to `'free'` with no reader and no writer | r1-billing-proposal §1 |

### A.14 NOT A PRODUCT FEATURE (never on the pricing page)

Platform-operator surface (`/operator`, application review, break-glass
reset), platform alarms and the alerter, `feature_flags` / `branches` /
`departments` (no consumer — S6/S7), the demo-reset job, the deployment
banner, the ZATCA outbox and archive workers (a customer sees only "your
invoice was reported"), the KMS wrapping, RLS, the identity-table boundary,
the audit-log writer, `ai_usage` metering, the generated API client, the
e2e/browser suite, the categorisation corpus and benchmarks.

---

## B. The three customer segments

Defined by the business's **stage**, not by a feature list. Each carries the
question the brief asked and the answer the product supports today.

| | **Basic** | **Pro** | **Advanced** |
| --- | --- | --- | --- |
| Who | freelancer, micro-business, owner-managed company with one CR; the owner does the books with an external accountant looking over their shoulder | growing SME with employees; an accountant or bookkeeper on staff or engaged; a purchasing side; someone who wants to see *where* the cash went | established SME where accounting is a **department**: a finance team, high document volume, a controller who wants priority support, onboarding help and room to grow into groups, integrations and automation as they ship |
| The question | *What does a small Saudi business genuinely need to run its accounting?* | *What becomes necessary once there is an accountant/team and operational complexity?* | *What becomes necessary when accounting is an operational function, not an owner task?* |
| The answer the product gives today | a correct double-entry ledger; VAT on every line and the VAT return; invoices with the ZATCA QR and counter, credit notes, quotations; bills and document capture; bank import and the review queue; the statements; closed months and the audit trail; two seats plus the accountant's | more seats; purchase orders; budgets and analytics; the payroll journal; the product catalogue in earnest; recurring documents without a cap; more bank accounts and document volume; the customer-payments workflow and bank matching when 1B ships | many seats; unlimited volume; priority support with a named onboarding; assisted migration included; the largest AI allowance when enabled; and the first plan to receive multi-company, API, custom reports and role-routed approvals **when they ship** (never marketed before) |
| Upgrade story | "I start here because my business is small." | "I upgrade because my business became more complex." | "I move to Advanced because finance is now an operation." |

---

## C. How every feature was placed

The nine questions from the brief, applied to every feature family. A "yes"
to Q1 (fundamental accounting) or a compliance obligation places the feature
on **Basic** regardless of the other answers; that is the rule against
artificial paywalls, and it is also the R1 proposal's principle ("tier on
capacity and consumption, never on correctness or compliance") and the
lesson of M18.0's false paywall (`tests/reports-catalogue.test.ts` fails on
`locked`/`premium` vocabulary — building tiering means confronting that guard
deliberately).

| Feature family | Q1 fundamental? | Q2 scale? | Q3 automation? | Q4 advanced reporting? | Q5 multi-company? | Q6 integration/API? | Q7 AI-heavy? | Q8 expensive to run? | Q9 upgrade-worthy? | Placement |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| GL, CoA, JEs, posting, statements, closed months, audit trail | **yes** | — | — | — | — | — | — | no | — | Basic |
| VAT, VAT return, ZATCA QR/ICV, tax journal | **yes** (legal) | — | — | — | — | — | — | no | — | Basic |
| Customers, invoices, credit notes, quotations, payments | **yes** | volume | — | — | — | — | — | PDF render, archive | — | Basic, volume-limited |
| Suppliers, bills, capture, supplier payments | **yes** (input VAT, AP) | volume | — | — | — | — | — | storage, OCR CPU | — | Basic, volume-limited |
| Purchase orders | no — procurement workflow | — | yes | — | — | — | — | no | yes | Pro |
| Bank accounts, import, review queue, settle | **yes** (reconciliation is correctness) | count | — | — | — | — | — | no | — | Basic, account-count-limited |
| Budgets | no — management accounting | — | — | yes | — | — | — | no | yes | Pro |
| Analytics (trend, bridge, decomposition) | no — insight, not correctness | — | — | yes | — | — | — | compute, small | yes | Pro |
| Finance Hub (liquidity, tax compliance, books status) | borderline — it is where the VAT liability and cash position are read | — | — | — | — | — | — | no | — | Basic (a Basic owner needs "what do I owe ZATCA and what is in the bank") |
| Approval engine, worklist | **yes** (it keeps drafts out of the books) | — | yes | — | — | — | — | no | — | Basic |
| Recurring documents | no | — | yes | — | — | — | — | no | yes | Basic limited (5), Pro unlimited |
| Categorisation rules, findings (deterministic) | borderline — a suspense balance IS a books problem | — | yes | — | — | — | no | no | — | Basic |
| Payroll journal, employees | no — a solo business has no payroll | headcount | — | — | — | — | — | no | yes | Pro (10 employees), Advanced unlimited |
| Product catalogue | no | count | — | — | — | — | — | no | weak | Basic (it is line entry) |
| Fixed-asset register | not until it posts | — | — | — | — | — | — | no | — | **not marketed** (§A.8) |
| Users / seats | — | **yes** | — | — | — | — | — | support load | **yes** | 2 / 5 / 15 |
| Document volume | — | **yes** | — | — | — | — | — | rows, PDF, archive | yes | 1,200 / 12,000 / unlimited per year |
| Priority support, named onboarding | — | — | — | — | — | — | — | **yes** (people) | yes | Advanced |
| Assisted migration | — | — | — | — | — | — | — | **yes** (people) | yes | add-on; included on Advanced |
| AI questions / document reads | no | — | — | — | — | — | **yes** | **yes** (the only variable COGS) | yes | allowance per plan (§F) |
| Background AI (categorisation, explanations) | no | — | yes | — | — | — | light | halalas | no | fair use on every plan |
| Multi-company, API, webhooks, custom reports, role-routed approvals, SSO | — | — | — | yes | yes | yes | — | — | yes | **FUTURE / NOT YET MARKETED**, Advanced first when built |
| Data export | **yes** (leaving with your books) | — | — | — | — | — | — | no | — | Basic when it ships (PDPL-held) — never gated |

---

## D. Master entitlement matrix

Labels, exactly as the brief specifies: **INCLUDED** · **LIMITED** (the
quantity is in §E) · **ADD-ON** (§J) · **NOT INCLUDED** · **ADVANCED ONLY** ·
**FUTURE / NOT YET MARKETED** (the placement decision for when it ships;
absent from the public page until then).

### D.1 Core accounting

| Feature / capability | Current status | Basic | Pro | Advanced | Reason for placement |
| --- | --- | --- | --- | --- | --- |
| Double-entry general ledger | LIVE | INCLUDED | INCLUDED | INCLUDED | fundamental (Q1) |
| Chart of accounts (flat, AR/EN, seeded) | LIVE | INCLUDED | INCLUDED | INCLUDED | fundamental |
| Chart tree / import / settings | PLANNED | FUTURE / NOT YET MARKETED | FUTURE / NOT YET MARKETED | FUTURE / NOT YET MARKETED | when built: every plan (it is CoA) |
| Manual journal entries with approval, reversal | LIVE | INCLUDED | INCLUDED | INCLUDED | fundamental |
| Trial balance, P&L, balance sheet, cash flow (direct), owner's equity | LIVE | INCLUDED | INCLUDED | INCLUDED | fundamental; gating statements makes Basic's books less trustworthy |
| Closed months (period locks) | LIVE | INCLUDED | INCLUDED | INCLUDED | fundamental |
| Audit trail | LIVE | INCLUDED | INCLUDED | INCLUDED | fundamental; also our own correctness story |
| Fiscal years, Hijri + Gregorian, Riyadh business day | LIVE | INCLUDED | INCLUDED | INCLUDED | Saudi baseline |
| Budgets with variance | LIVE | NOT INCLUDED | INCLUDED | INCLUDED | management accounting (Q4); the accountant persona |
| Cost centres / projects | PLANNED | FUTURE / NOT YET MARKETED | FUTURE / NOT YET MARKETED | FUTURE / NOT YET MARKETED | when built: Pro and up |
| Multi-currency | PLANNED | FUTURE / NOT YET MARKETED | FUTURE / NOT YET MARKETED | FUTURE / NOT YET MARKETED | when built: Advanced first |
| Multi-company under one subscription | PLANNED (§0.2) | NOT INCLUDED | NOT INCLUDED | FUTURE / NOT YET MARKETED | not built; a second CR is a second subscription today (§J) |

### D.2 Customers / sales

| Feature / capability | Current status | Basic | Pro | Advanced | Reason |
| --- | --- | --- | --- | --- | --- |
| Customer management | LIVE | INCLUDED | INCLUDED | INCLUDED | fundamental; customers are never counted (§E) |
| Quotations with conversion | LIVE | INCLUDED | INCLUDED | INCLUDED | a micro business quotes; quotations do not count against volume |
| Invoice creation with line VAT | LIVE | LIMITED (volume) | LIMITED (volume) | INCLUDED | fundamental; volume is the Basic/Pro limiter (Q2) |
| Invoice approval (ICV, hash, QR minted at approval; fail-closed on VAT/CR) | LIVE | INCLUDED | INCLUDED | INCLUDED | compliance |
| Invoice PDF (AR/EN, logo, QR, Hijri) | LIVE | INCLUDED | INCLUDED | INCLUDED | the invoice must leave the product |
| Send invoice by email | PLANNED (B1) | FUTURE / NOT YET MARKETED | FUTURE / NOT YET MARKETED | FUTURE / NOT YET MARKETED | when wired: every plan |
| Credit notes | LIVE | INCLUDED (counts as a sales document) | INCLUDED | INCLUDED | a correction is never refused (§I) |
| Customer payment against an invoice (record / mark paid) | LIVE | INCLUDED | INCLUDED | INCLUDED | correctness — a receivable must settle |
| Payment allocation, unapplied receipts / advances, refunds, credit-note application | IN DEVELOPMENT (1B) | FUTURE / NOT YET MARKETED | FUTURE / NOT YET MARKETED | FUTURE / NOT YET MARKETED | when merged: **every plan** (it is correctness, not a tier) |
| Customer statement page | IN DEVELOPMENT (1B) | FUTURE / NOT YET MARKETED | FUTURE / NOT YET MARKETED | FUTURE / NOT YET MARKETED | when merged: every plan |
| Customer ledger report, AR ageing | LIVE | INCLUDED | INCLUDED | INCLUDED | fundamental reporting |
| Receivables analytics (bridge) | LIVE | NOT INCLUDED | INCLUDED | INCLUDED | part of Analytics (Q4) |
| Recurring invoices (drafts) | LIVE | LIMITED (5 schedules) | INCLUDED | INCLUDED | automation (Q3) |
| Invoice/quotation templates, customer groups | PLANNED | FUTURE / NOT YET MARKETED | FUTURE / NOT YET MARKETED | FUTURE / NOT YET MARKETED | when built: Pro and up |
| Debit notes | LIVE capability, page removed | NOT INCLUDED | NOT INCLUDED | NOT INCLUDED | not marketed until the page returns |

### D.3 Suppliers / purchases

| Feature / capability | Current status | Basic | Pro | Advanced | Reason |
| --- | --- | --- | --- | --- | --- |
| Supplier management | LIVE | INCLUDED | INCLUDED | INCLUDED | fundamental |
| Bills (draft/approve/post/pay) | LIVE | LIMITED (volume) | LIMITED (volume) | INCLUDED | fundamental (input VAT, AP); volume-limited |
| Purchase orders with conversion | LIVE | NOT INCLUDED | INCLUDED | INCLUDED | procurement workflow (Q3); the market's line too (Qoyod, Wafeq put purchasing on the mid tier — COMPETITOR FACT) |
| Document capture (QR + OCR → bill) | LIVE | LIMITED (captures/mo) | LIMITED | LIMITED | storage + CPU (Q8); the AI vision tail is separate (§F) |
| Supplier payments (pay a bill) | LIVE | INCLUDED | INCLUDED | INCLUDED | correctness |
| Supplier payment allocation object | PLANNED | FUTURE / NOT YET MARKETED | FUTURE / NOT YET MARKETED | FUTURE / NOT YET MARKETED | when built: every plan |
| Supplier statements, purchases by vendor | PLANNED | FUTURE / NOT YET MARKETED | FUTURE / NOT YET MARKETED | FUTURE / NOT YET MARKETED | when built: every plan |
| AP ageing | LIVE | INCLUDED | INCLUDED | INCLUDED | fundamental reporting |

### D.4 Banking

| Feature / capability | Current status | Basic | Pro | Advanced | Reason |
| --- | --- | --- | --- | --- | --- |
| Bank accounts | LIVE | LIMITED (2) | LIMITED (6) | INCLUDED | count tracks business size (Q2) |
| Statement import (CSV), transactions, manual entries | LIVE | INCLUDED | INCLUDED | INCLUDED | fundamental |
| Review queue — accept, settle against invoice/bill, bulk accept | LIVE | INCLUDED | INCLUDED | INCLUDED | reconciliation is correctness — unlike Wafeq Starter / FreshBooks Lite (COMPETITOR FACT) |
| Bank matching (deterministic), override, unmatch | IN DEVELOPMENT (1B) | FUTURE / NOT YET MARKETED | FUTURE / NOT YET MARKETED | FUTURE / NOT YET MARKETED | when merged: every plan |
| Per-bank cash GL | IN DEVELOPMENT | FUTURE / NOT YET MARKETED | FUTURE / NOT YET MARKETED | FUTURE / NOT YET MARKETED | it is the ledger — every plan |
| Transfers (own / external / undeclared) | LIVE, no page | NOT INCLUDED | NOT INCLUDED | NOT INCLUDED | not marketed until the page exists; when it does, every plan |
| Cash management (Finance Hub liquidity) | LIVE | INCLUDED | INCLUDED | INCLUDED | "what is in the bank" is a Basic need |
| Live bank feeds | PLANNED (CR-gated) | FUTURE / NOT YET MARKETED | FUTURE / NOT YET MARKETED | FUTURE / NOT YET MARKETED | when signed: Pro and up (a per-connection provider cost, ASSUMPTION) |

### D.5 Tax / Saudi compliance — universal, never gated

| Feature / capability | Current status | Basic | Pro | Advanced | Reason |
| --- | --- | --- | --- | --- | --- |
| VAT on every line, VAT return, VAT summary | LIVE | INCLUDED | INCLUDED | INCLUDED | legal obligation; a plan that cannot file VAT is a plan that makes the customer non-compliant |
| ZATCA counter (ICV), hash chain, nine-tag QR on every approved invoice | LIVE | INCLUDED | INCLUDED | INCLUDED | compliance |
| ZATCA Phase 2 signed e-invoicing and submission | IN DEVELOPMENT (§0.4) | INCLUDED when live | INCLUDED when live | INCLUDED when live | compliance is never a tier — the design this document refuses is Qoyod Basic's "Phase 2 excluded" (COMPETITOR FACT) |
| ZATCA archive with direct audit link | LIVE (local-fs) | INCLUDED | INCLUDED | INCLUDED | legal (§5.5) |
| Tax journal entries report | LIVE | INCLUDED | INCLUDED | INCLUDED | compliance reporting |
| Tax audit trail | LIVE | INCLUDED | INCLUDED | INCLUDED | compliance |
| Zakat scope + fiscal calendar | LIVE | INCLUDED | INCLUDED | INCLUDED | — |
| Zakat base / calculation / reports | PLANNED (Block C) | FUTURE / NOT YET MARKETED | FUTURE / NOT YET MARKETED | FUTURE / NOT YET MARKETED | when verified: every plan (compliance) |
| Withholding tax | PLANNED | FUTURE / NOT YET MARKETED | FUTURE / NOT YET MARKETED | FUTURE / NOT YET MARKETED | when built: every plan (a legal exposure is not a tier) |

### D.6 Reporting

| Feature / capability | Current status | Basic | Pro | Advanced | Reason |
| --- | --- | --- | --- | --- | --- |
| Standard reports — statements, account statement/summary, GL, journal, activity, customer ledger, AR/AP ageing, tax journal, invoice summary | LIVE | INCLUDED | INCLUDED | INCLUDED | fundamental |
| Finance Hub | LIVE | INCLUDED | INCLUDED | INCLUDED | §C |
| Analytics (trend, receivables bridge, cash reconciliation, decomposition) | LIVE | NOT INCLUDED | INCLUDED | INCLUDED | insight, not correctness (Q4); the visible Pro reason. 🔴 This is a re-gate of a screen that ships free today — legitimate only because there are no customers yet (CLAUDE.md §2); decide before the first tenant (§M) |
| Budgets | LIVE | NOT INCLUDED | INCLUDED | INCLUDED | §D.1 |
| Payroll report, asset schedule | LIVE | follows the module | follows the module | follows the module | — |
| Custom reports, scheduled reports, dashboard layout | PLANNED | FUTURE / NOT YET MARKETED | FUTURE / NOT YET MARKETED | FUTURE / NOT YET MARKETED | when built: ADVANCED ONLY (custom), Pro (scheduled) |
| Consolidated multi-company reporting | PLANNED | FUTURE / NOT YET MARKETED | FUTURE / NOT YET MARKETED | FUTURE / NOT YET MARKETED | follows multi-company |
| Data export | PLANNED (PDPL) | FUTURE / NOT YET MARKETED | FUTURE / NOT YET MARKETED | FUTURE / NOT YET MARKETED | when the PDPL answer lands: **every plan, never gated** |

### D.7 Automation

| Feature / capability | Current status | Basic | Pro | Advanced | Reason |
| --- | --- | --- | --- | --- | --- |
| Approval workflow + worklist | LIVE | INCLUDED | INCLUDED | INCLUDED | keeps drafts out of the books |
| Recurring documents (drafts) | LIVE | LIMITED (5) | INCLUDED | INCLUDED | automation (Q3) |
| Recurring journal entries | PLANNED | FUTURE / NOT YET MARKETED | FUTURE / NOT YET MARKETED | FUTURE / NOT YET MARKETED | when built: Pro and up |
| Transaction review + deterministic categorisation rules | LIVE | INCLUDED | INCLUDED | INCLUDED | a suspense balance is a books problem |
| Automated findings (deterministic, scheduled daily) + acknowledge | LIVE | INCLUDED | INCLUDED | INCLUDED | "who finds out" — every plan |
| Notifications / email preferences | PLANNED (B1) | FUTURE / NOT YET MARKETED | FUTURE / NOT YET MARKETED | FUTURE / NOT YET MARKETED | when wired: every plan |
| Multi-step / role-routed approval rules | PLANNED | FUTURE / NOT YET MARKETED | FUTURE / NOT YET MARKETED | FUTURE / NOT YET MARKETED | when built: ADVANCED ONLY |

### D.8 Assets, payroll, products

| Feature / capability | Current status | Basic | Pro | Advanced | Reason |
| --- | --- | --- | --- | --- | --- |
| Fixed-asset register + schedule | LIVE (register only, §A.8) | NOT INCLUDED on the page | NOT INCLUDED on the page | NOT INCLUDED on the page | **not marketed** until depreciation posts to the GL; reachable in-product for the pilot |
| Depreciation posting, disposal | PLANNED | FUTURE / NOT YET MARKETED | FUTURE / NOT YET MARKETED | FUTURE / NOT YET MARKETED | when built: Pro and up (Qoyod gates to Advanced, Zoho to Premium — COMPETITOR FACT) |
| Employees + payroll journal with GOSI, approval, GL posting, payroll report | LIVE | NOT INCLUDED | LIMITED (10 employees) | INCLUDED | a solo business has no payroll; headcount tracks size |
| WPS / Mudad / payslips | PLANNED | FUTURE / NOT YET MARKETED | FUTURE / NOT YET MARKETED | FUTURE / NOT YET MARKETED | when built: follows payroll |
| Product & service catalogue | LIVE | INCLUDED | INCLUDED | INCLUDED | it is line entry; never counted |
| Inventory (stock, COGS, valuation, product margin) | PLANNED (Block E) | FUTURE / NOT YET MARKETED | FUTURE / NOT YET MARKETED | FUTURE / NOT YET MARKETED | when built: ADD-ON on Pro, INCLUDED on Advanced |

### D.9 Migration

| Feature / capability | Current status | Basic | Pro | Advanced | Reason |
| --- | --- | --- | --- | --- | --- |
| Self-service migration workspace (CoA mapping, parties, open items, advances, opening position, validate, commit, clear OBE, reverse) | IN DEVELOPMENT (API), UI PLANNED | FUTURE / NOT YET MARKETED | FUTURE / NOT YET MARKETED | FUTURE / NOT YET MARKETED | when shipped: **INCLUDED on every plan** — it is the acquisition path and the correctness path |
| Spreadsheet CoA import | PLANNED | FUTURE / NOT YET MARKETED | FUTURE / NOT YET MARKETED | FUTURE / NOT YET MARKETED | every plan |
| Assisted migration (a person) — opening TB + aggregate AR/AP today; per-invoice open items after 1C | available as a service | ADD-ON | ADD-ON (one included on annual) | INCLUDED (one company) | people cost (Q8); Advanced's onboarding is the point of Advanced |
| White-glove migration (history, reconciliation sign-off) | service | NOT INCLUDED | ADD-ON | ADD-ON | scoped quote; part of the "contact us" pathway |

### D.10 AI — every row INCLUDED-WHEN-ENABLED (§F)

| Feature / capability | Current status | Basic | Pro | Advanced | Reason |
| --- | --- | --- | --- | --- | --- |
| Categorisation second opinion (background) | LIVE, dark | INCLUDED (fair use) | INCLUDED (fair use) | INCLUDED (fair use) | costs halalas; not metered to the customer |
| Findings explanations (background) | LIVE, dark | INCLUDED (fair use) | INCLUDED (fair use) | INCLUDED (fair use) | same |
| AI assistant — questions over your books | LIVE, dark | LIMITED (50/mo) | LIMITED (150/mo) | LIMITED (400/mo) | the only AI with real marginal cost (Q7/Q8); allowance per §F |
| AI document reading (vision) | IN DEVELOPMENT | LIMITED (75/mo) | LIMITED (300/mo) | LIMITED (1,000/mo) | the expensive op (45× a categorisation) |
| Reconciliation suggestions, monthly brief | PLANNED | FUTURE / NOT YET MARKETED | FUTURE / NOT YET MARKETED | FUTURE / NOT YET MARKETED | when built: background (all) / brief (Pro and up) |
| Forecasting | not specced | — | — | — | not in any design document |
| Additional AI capacity | — | ADD-ON (AI Boost) | ADD-ON | ADD-ON | §J |

### D.11 Platform, security, support, integrations

| Feature / capability | Current status | Basic | Pro | Advanced | Reason |
| --- | --- | --- | --- | --- | --- |
| Users (seats) | LIVE | LIMITED (2) | LIMITED (5) | LIMITED (15) | the primary segmentation axis in every competitor (COMPETITOR FACT) |
| Free external accountant seat (`accountant` role) | LIVE role | INCLUDED (1) | INCLUDED (1) | INCLUDED (1) | the accountant is the channel |
| Roles, invitations, security events | LIVE | INCLUDED | INCLUDED | INCLUDED | security is not a tier |
| Organisation switching | LIVE | INCLUDED | INCLUDED | INCLUDED | — |
| 2FA, session management, IP restrictions | PLANNED | FUTURE / NOT YET MARKETED | FUTURE / NOT YET MARKETED | FUTURE / NOT YET MARKETED | when built: 2FA every plan; session/IP controls ADVANCED ONLY |
| Public API, webhooks | PLANNED | FUTURE / NOT YET MARKETED | FUTURE / NOT YET MARKETED | FUTURE / NOT YET MARKETED | when built: ADVANCED ONLY (write), Pro read-only |
| Payment gateways | PLANNED (CR) | FUTURE / NOT YET MARKETED | FUTURE / NOT YET MARKETED | FUTURE / NOT YET MARKETED | when signed: every plan |
| SSO / SCIM | PLANNED | NOT INCLUDED | NOT INCLUDED | FUTURE / NOT YET MARKETED | the "contact us" pathway |
| Support | — | email, next business day | email, same business day | priority + named onboarding | people cost |
| Contractual SLA, DPA, security questionnaire, custom paper | — | NOT INCLUDED | NOT INCLUDED | via "contact us" | needs C3/C6 closed first; never sign before the hosting and KMS decisions exist |

---

## E. Usage limits

Principle (from the strategy document §F/§T, unchanged): **limits apply to
CREATION, never to EXISTENCE.** Nothing already in the books is restricted;
a correction, a payment, a credit note against an existing invoice, a
reversal and a compliance transmission are never refused by a limit.

| Limit | Basic | Pro | Advanced | Why this number (segment · cost · trigger) |
| --- | ---: | ---: | ---: | --- |
| **Users** (active seats; viewers count; the one free accountant seat does not) | 2 | 5 | 15 | owner + one helper; a team; a finance function. Cost: support load. Trigger: the third person. Above 15 → seat add-on or "contact us" |
| **Companies** (legal entities) | 1 | 1 | 1 (multi-company FUTURE) | §0.2 — one subscription is one company today. A group buys one subscription per CR and switches organisations |
| **Sales documents approved** (invoices + credit notes, per subscription year) | 1,200 | 12,000 | unlimited (fair use) | ≈ 100/month is above what a micro business issues; ≈ 1,000/month is a real SME; Advanced is uncapped because a cap there only invites a "contact us" conversation the plan already offers. Quotations never count. Cost: rows, Chromium PDF, archive. Above Zoho's KSA caps at each tier (COMPETITOR FACT: 1,000 / 5,000 / 10,000 / 25,000) |
| **Purchase documents** (bills approved, per year) | 1,200 | 12,000 | unlimited (fair use) | same shape; a capture that becomes a bill counts once |
| **Bank accounts** | 2 | 6 | unlimited | one operating + one savings; a growing business adds a card and a second bank. Cost: none material. Existing accounts stay usable for payments and imports at any plan (D-3 rule) |
| **Statement lines imported** | fair use (guide 5,000/yr) | fair use (25,000/yr) | fair use | an abuse guard only; no refusal mid-import below 3× the guide |
| **Document captures** (uploads through A1) | 100/mo | 500/mo | 2,500/mo | storage + OCR CPU; the AI vision tail is limited separately (§F) |
| **Storage** (captures + logos; the ZATCA archive is never counted) | 2 GB | 10 GB | 50 GB | object-storage cost; nothing is ever deleted at the limit |
| **Employees on payroll** | n/a | 10 | unlimited | Pro's audience; headcount tracks size |
| **Recurring schedules** | 5 | unlimited | unlimited | a micro business has a handful of monthly invoices |
| **Fixed assets** | not marketed | not marketed | not marketed | §A.8 |
| **API requests** | — | — | — | no API exists; FUTURE |
| **AI questions / document reads** | 50 / 75 per month | 150 / 300 | 400 / 1,000 | §F |

**Deliberately unlimited on every plan:** customers, suppliers, products,
journal entries, transactions accepted, payments, reports run, PDF renders,
audit-trail reads, closed-month operations, quotations, exports (when they
exist). Each is correctness or costs too little to be worth a customer's
confusion.

**Are these arbitrary?** No — each is set at roughly the P90 of its segment's
plausible population (ASSUMPTION for volumes; the `ai_usage`-modelled
distributions for AI), so ~10 % of a plan's customers see the notice and the
notice names the plan that removes it. Re-derive from measured data at the
first 100 paying organisations (§M).

---

## F. AI packaging

**Commercial model (owner-stated, adopted):** the customer buys *Saudi Ledger
AI capability*; the subscription includes it; the allowance is
**organisation-level, shared by all users**, never multiplied by seat; the
customer never brings a key or sees a provider. Internally, `ai_usage`
records provider, model, prompt and completion tokens, operation, latency,
and ok/failed per call (FACT) — tool calls in `/ask` are internal functions
with no provider fee (FACT), and OCR is Tesseract in-process at $0 (FACT).

### F.1 What the AI actually does, and what each operation costs

CALCULATION on Groq's verified price card (companion §1–§2):

| Workflow | Status | Tokens / op | USD / op | Class |
| --- | --- | ---: | ---: | --- |
| Categorisation second opinion (background; only rows scored < 0.65) | LIVE, dark | ~860 | 0.00008 | cheap — 12,800 per dollar |
| Findings explanation + judge (background; ≤ 25/run, de-duplicated) | LIVE, dark | ~2,550 | 0.0005 | cheap |
| **Question** — grounded answer + judge | LIVE, dark | ~4,060 | 0.0008 | moderate |
| **Document read** — vision on the residue after QR + OCR | IN DEVELOPMENT | ~2,750 | **0.0035** | **expensive — 45× a categorisation; the entire AI cost story** |
| Reconciliation suggestion, monthly brief | PLANNED | ~1,080 / ~6,800 | 0.0001 / 0.0014 | cheap / moderate |

### F.2 Expected consumption per organisation — P50 / P75 / P90 / P95 / heavy

Counts per month for the two **requested** classes (the customer clicks);
background classes are in the companion §3. SCENARIO ASSUMPTIONS, to be
replaced by 90 days of `ai_usage` rows once the boundary flips.

| Plan | | P50 | P75 | P90 | P95 | Heavy (≈ 10× P50) |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Basic | questions | 5 | 15 | 40 | 80 | 400 |
| Basic | document reads | 10 | 25 | 60 | 120 | 400 |
| Pro | questions | 20 | 50 | 120 | 250 | 1,500 |
| Pro | document reads | 40 | 100 | 250 | 400 | 1,500 |
| Advanced | questions | 50 | 120 | 300 | 600 | 4,000 |
| Advanced | document reads | 150 | 400 | 900 | 1,500 | 5,000 |

Total monthly AI cost per organisation, background included (CALCULATION,
companion §3): Basic $0.06 / 0.13 / 0.29 / 0.56 / 1.91; Pro $0.19 / 0.45 /
1.07 / 1.76 / 6.88; Advanced $0.66 / 1.65 / 3.66 / 6.18 / 21.81 at P50 / P75
/ P90 / P95 / heavy. Tokens at P50 → P95: Basic 0.16M → 1.27M; Pro 0.47M →
3.62M; Advanced 1.40M → 11.1M. (The Advanced distribution was modelled with
three companies; a single-company Advanced organisation sits nearer the Pro
P95 — the allowance below is therefore generous for Advanced as it exists
today, and correct for Advanced as it will be.)

### F.3 The derived allowance

Set at roughly **P90–P95 of each plan's population**, so normal use never
meets the limit, ~10 % see a notice, and the heavy tail is bounded:

| Plan | Questions / month | Document reads / month | Background AI | Provider cost of the FULL allowance (CALCULATION) | % of the plan's blended ARPU | Token-equivalent (owner's reference only) |
| --- | ---: | ---: | --- | ---: | ---: | ---: |
| **Basic** | **50** | **75** | fair use | ≈ $0.30 / SAR 1.1 | 1.2 % | ≈ 0.4M requested; ≈ 1M with background |
| **Pro** | **150** | **300** | fair use | ≈ $1.16 / SAR 4.4 | 2.5 % | ≈ 1.4M; ≈ 3M |
| **Advanced** | **400** | **1,000** | fair use | ≈ $3.79 / SAR 14.2 | 4.5 % | ≈ 4.4M; ≈ 10M |

**Why not the placeholder 30M / 100M / 300M tokens:** no modelled
organisation — including the heavy tail — consumes more than 15 % of those;
as a limit they are inert, as a headline they describe nothing a buyer can
picture, and fully consumed they would cost 32 % / 52 % / 70 % of ARPU
(companion §3). The allowance above is the number that is both reachable by
a real heavy user and affordable if every customer hit it.

**Why two named actions and not a credit pool:** a document read is ~4.5×
a question; one pool forces the buyer to do that arithmetic on the pricing
page. "Questions" and "document reads" are the two things a user clicks.

**Tokens as a secondary transparency measure:** recommended **not** on the
pricing page. Permitted in the FAQ as one sentence ("roughly one / three /
ten million AI tokens a month, including the automatic work") if the owner
wants it — the number is honest and it is the only place a token should
appear.

### F.4 Exhaustion, grace, abuse — unchanged from the strategy document §K.10–K.11

80 % notice → 100 % refuses **requested AI only** with a structured code
naming the reset date, the AI Boost and the upgrade; the deterministic paths
(reports, analytics, QR + OCR capture, categorisation rules) are untouched;
one automatic +25 % grace per subscription year; background fair use at 3×
the guide falls back to deterministic and raises an operator alert. The
check lives in `services/ai/metered.ts`, the one seam every call passes
through, thrown as one more `AiUnavailableError` — every caller already
degrades correctly (FACT). Never the ledger, never a posting, never a
compliance transmission.

### F.5 Provider-independent by construction

Customer entitlement = **actions** (questions, document reads) + a fair-use
class. Internally, each action maps to **AI Units** through a weight table
that is configuration (companion §8): 1 unit = one categorisation
(≈ 860 tokens on the cheapest text model); weights today `categorize 1 ·
explanation 6 · question 10 · brief 18 · document 45`. **Groq → SITE → ELM →
another provider changes the unit's reference cost and the weights; the
customer's "150 questions and 300 document reads" does not change.**
`ai_usage` already records everything the conversion needs, retroactively
(FACT). Rule from the companion §7: **no non-linear AI contract before ~500
paying organisations and 90 days of measured `ai_usage`**; a fixed
commitment or dedicated replica below that is margin-fatal.

---

## G. Pricing

### G.1 Inputs

- **Saudi ladder (COMPETITOR FACT, read 2026-09-19):** entry tiers SAR
  99–149/month list and functionally crippled in three of four cases (Wafeq
  Starter "invoicing only" 119; Qoyod Basic 138 incl. VAT without purchases or
  Phase 2; Snad Basic 149 incl. VAT with ZATCA optional; Daftra Basic 99);
  "complete accounting" clusters at 199–249 list / 160–200 effective annual
  (Wafeq Premium 249 → 199; Daftra Comprehensive 199 → 159; Qoyod Pro 207
  incl. VAT ≈ 180 ex-VAT); the top self-serve tiers are Qoyod Advanced 379.50
  incl. VAT (≈ 330 ex-VAT, 5 users), Snad Pro 399 incl. VAT (≈ 347, 5 users),
  Zoho Elite 349 (10 users). Annual = "12 for 10" is the Saudi norm. Extra
  user SAR 20/month (Qoyod, Snad). Nobody prices AI.
- **What the product can claim (§A):** a full ledger with VAT return, bank
  import + review, statements, closed months and audit trail on the entry
  tier — more than any Saudi entry tier except Zoho Standard (SAR 69, 3
  users, bank feeds, ZATCA). What it **cannot** claim yet: ZATCA production
  submission, bank feeds, multi-company, inventory, API, AI (dark).
- **Costs (CALCULATION, companion §4–§5):** infra ≈ $3.0 / 3.5 / 5.0 per
  org-month at ~300 organisations; cost-to-serve $2 / 5 / 15; PSP 3 %; AI at
  P75 $0.13 / 0.45 / 1.65. Infrastructure, not AI, is the margin driver.
- **Segment willingness (ASSUMPTION):** a micro business pays the entry
  norm; an accountant-run SME pays the "complete accounting" norm; a finance
  team pays for seats, volume and support — and it has just been shown
  that nothing else in Advanced is LIVE that Pro lacks (§B).

### G.2 The recalculation

| | Basic | Pro | Advanced |
| --- | --- | --- | --- |
| 2026-09-19 recommendation | 99 | 199 | 449 (with 3 companies pooled) |
| What justified it | Saudi entry norm with a full ledger | the "complete accounting" price point | pooled companies — **not built** |
| Live differentiation vs the tier below, today | — | +3 seats, POs, budgets, analytics, payroll journal, 10× volume, 6 banks, unlimited recurring | +10 seats, unlimited volume and banks, priority support + named onboarding, assisted migration included, 2.7× the AI allowance |
| Seat arithmetic (CALCULATION) | — | Basic + 1 seat = 119, Basic + 4 seats = 179 < 199: seats alone never force Pro; POs/analytics/payroll do | Pro + 8 seats = 359 > 349: **the 13th seat is where Advanced pays for itself**; at 15 seats Pro costs 399 |
| **Revised price (STRATEGIC DECISION)** | **SAR 99** | **SAR 199** | **SAR 349** |
| Position | Daftra Basic's list, Wafeq Starter's effective — with a complete ledger | Daftra Comprehensive's list, Wafeq Premium's effective | Zoho Elite's list; between Qoyod Advanced (≈ 330 ex-VAT, 5 users, 1 business) and Snad Pro (≈ 347, 5 users) — with 15 users |

**Why Basic stays at 99:** it is the Saudi entry norm, the product delivers
a complete ledger there (the differentiator against three of four Saudi
entry tiers), and the economics companion shows Basic is the tier with the
least infrastructure headroom — 79 would cost 4 margin points for a story
about the competitor.

**Why Pro stays at 199:** every LIVE Pro differentiator (purchase orders,
budgets, analytics, payroll journal, 5 seats, 12,000 documents) is what the
Saudi market sells at 199–249 as "complete accounting"; 199 list / 165.83
effective sits at the bottom of that band, which is where a product whose
ZATCA production path is unproven should sit.

**Why Advanced drops from 449 to 349:** 449 was priced on three pooled
companies and an API, neither of which exists. What Advanced genuinely
offers today is seats, volume, people (support, onboarding, migration) and
AI capacity. 349 is the price the Saudi market already pays for the top
self-serve tier with **five** users; Advanced offers fifteen. When
multi-company and the API ship, Advanced receives them first **without a
price change** — the review trigger in §M asks whether a higher Advanced
price is then justified, with data.

### G.3 Final prices

All SAR, **ex-VAT** (15 % VAT added at checkout; the buyer is VAT-registered
and recovers it — Wafeq and Zoho show ex-VAT; Qoyod and Snad show inclusive).
Annual = 12 months for the price of 10.

| | **Basic** | **Pro** | **Advanced** |
| --- | ---: | ---: | ---: |
| Monthly | **99** | **199** | **349** |
| Annual | **990** | **1,990** | **3,490** |
| Effective monthly on annual | 82.50 | 165.83 | 290.83 |
| Annual discount | 16.7 % | 16.7 % | 16.7 % |
| Extra user | 20/mo · 200/yr | 20/mo · 200/yr | 20/mo · 200/yr |
| Larger requirements | — | — | **contact us** (more than 15 users, groups, SLA, custom onboarding, white-glove migration) |

### G.4 What the revised prices do to the economics (CALCULATION)

Blended ARPU at 60 % annual: Basic 89 / Pro 179 / Advanced **314** (was 404).
Mix 50 / 35 / 15 → blended ARPU **SAR 154/month** (was 168); ARR per 1,000
customers **SAR 1.85M ≈ $494k** (was 2.01M).

| Plan | ARPU USD | COGS ex-serve (P50 AI) | GM ex-serve | COGS incl. serve | GM incl. serve | GM incl. serve at P95 AI |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Basic | 23.76 | 4.07 | 82.9 % | 6.07 | 74.5 % | 72.3 % |
| Pro | 47.76 | 5.62 | 88.2 % | 10.62 | 77.8 % | 74.5 % |
| Advanced @ 349 | 83.76 | 9.07 | 89.2 % | 24.07 | **71.3 %** | 64.7 % |

Advanced's cost-to-serve assumption ($15/org-month = 60 minutes of support)
is the line that moves its margin; it is also the line Advanced sells.
Blended GM incl. serve at P75 AI ≈ **74 %** (was 76 %) — still the "honest
planning figure" band the companion names, and the sensitivity grid's
conclusions (infra is the lever; AI ×10 and usage ×5 together is the only
fatal cell, both halves controllable) are unchanged.

---

## H. Upgrade triggers

| From → to | The moment | The in-product signal |
| --- | --- | --- |
| Trial → Basic | verification approved, first invoice approved | "Your first invoice is issued — choose a plan to keep issuing after day 14" |
| **Basic → Pro** | a third seat; purchase orders needed; the accountant asks for budgets or analytics; the first payroll run; a sixth recurring schedule; a third bank account; > 100 invoices or bills in a month; the 51st AI question | at 80 % of any limit the notice names the plan that removes it; a Pro-only page shows its plan-gate state with the data preserved |
| **Pro → Advanced** | the 13th seat (Pro + seats overtakes Advanced there); > 1,000 documents a month; an 11th payroll employee; the need for a named onboarding or same-day priority support; migration help wanted; AI beyond 150 questions or 300 reads a month | seat invitation refused at 5 + add-ons; volume notice; the AI notice |
| **Advanced → contact us** | > 15 seats; a second legal entity that wants one bill; contractual SLA / DPA / security paper; white-glove migration; procurement on an annual PO | a sales conversation, never an in-app wall |

The upgrade path reads as stages, not bundles: *small → complex → an
operation*. Nothing on a lower plan is taken away by the upgrade; counters
carry over (never reset in the customer's disfavour).

---

## I. Downgrade rules

**Never** delete accounting records, customers, invoices, financial history
or audit history; **never** corrupt the books; existing data stays readable,
exportable and correctable. A downgrade changes what can be **created** from
its effective date.

| Situation | Behaviour |
| --- | --- |
| Effective date | end of the current billing period (annual: at renewal). Immediate on request, no refund of the unused period |
| Seats above the new limit | the admin chooses which stay active before the effective date; otherwise the platform deactivates the most recently added non-admin seats (never the last admin, never the free accountant seat) after a **30-day grace**, and says so. Deactivated users keep their audit-trail identity; reactivation is one click with a seat |
| Documents above the new annual allowance | the counter re-bases to the new plan; if already above it, the customer is in the soft-cap state: notice, 30-day grace, then **new primary documents** are refused — approving an existing draft, issuing a credit note, recording a payment, posting a correcting journal and every compliance transmission are **never refused** |
| Bank accounts above the limit | nothing happens — existing accounts stay usable for payments and imports (refusing a bank that cash lines must name would break the fail-closed cash rule) |
| Employees / recurring schedules above the limit | nothing deleted; payroll and recurring continue for what exists; adding more is refused |
| Storage above the limit | uploads refused; nothing deleted; the notice names the storage add-on |
| Features not on the new plan (analytics, budgets, POs, payroll) | the page shows the plan-gate state with the data preserved and readable; an approved PO is still convertible to a bill (an act on an existing document); budgets are readable, not editable |
| AI | the allowance re-bases at the next period; past AI output is untouched; background AI continues within the new plan's fair use |
| Add-ons | reductions at period end (or immediately on request), same rules as above |
| Cancellation | `read_only_cancelled` for **90 days** (readable, exportable when export exists, the ZATCA outbox still drains — compliance is not a plan feature), then `dormant`; data retained per the PDPL answer (C8); **never deleted by a billing event** |
| Grandfathered price | a downgrade keeps the pinned plan version; re-upgrading returns to the current version and price, and the UI says so first |

Enforcement mechanics, the three enforcement points and the accounting-safety
rules are the strategy document's §S–§U and §T, unchanged: entitlement is
checked after the tenant is resolved and before the role; the accounting core
is always evaluated last and never bypassed; a plan refusal is a **402** with
a structured code (flagged as a decision, §M).

---

## J. Add-ons

Only where a real cost or a real customer choice justifies one. Everything
else is in the plan.

| Add-on | Price (SAR, ex-VAT) | Available on | Status | Justification |
| --- | --- | --- | --- | --- |
| Additional user | 20/mo · 200/yr | all | — | the market rate (Qoyod, Snad — COMPETITOR FACT); seats are the customer's choice, not a tier |
| AI Boost (+100 questions, +200 document reads / month) | 49/mo | all, when AI is enabled | when enabled | a fully consumed pack costs ≈ SAR 2.9 in provider cost; priced at what "more AI" is worth, stackable ×3 |
| Extra storage | 19/mo per 10 GB | all | — | object-storage cost; never triggers deletion |
| Assisted migration (one company) | 1,500 one-off | Basic, Pro (one included on Pro annual; included on Advanced) | service, available now at the level §A.11 states | ~3–4 accountant hours (ASSUMPTION SAR 350–500/h) |
| White-glove migration | from 4,000, scoped | Pro, Advanced, contact us | service | multi-company, history, reconciliation sign-off; **promises nothing about ZATCA history** until the PIH question is resolved |
| Priority support | 99/mo | Pro | — | Advanced includes it |
| Second legal entity | a second subscription at list (any plan) | all | today's honest shape (§0.2) | a company add-on is created **only when multi-company ships**; the 2026-09-19 "SAR 99/company" add-on is withdrawn until then |

**Not add-ons (deliberately):** API/integrations (nothing to sell), inventory
(PLANNED), bank feeds (CR-gated; priced when a provider quotes), SSO
(contact us), AI overage on Basic (boost only).

---

## K. ORGINOO website package

Everything in this section is what the freelancer needs and nothing else.
**Publishing gates are stated explicitly** — the page must never show
IN DEVELOPMENT or PLANNED functionality as available today.

### K.1 Publishing gates — read first

| Line on the page | Publish when | Until then |
| --- | --- | --- |
| AI allowance row, AI copy, AI FAQ | the owner confirms the AI data boundary has flipped (Groq Enterprise agreement or a Saudi provider signed, C6) | show **Version A** of the AI lines below ("included in your plan — activating soon"), or omit the row entirely |
| "ZATCA e-invoicing" as *submission* | M12.7 + M12.9 have run on a registered entity and the additional-number field exists | say "ZATCA-ready invoices: QR code, invoice counter, Hijri and Gregorian dates" — never "reports to ZATCA" |
| Migration row and FAQ ("bring your history") | Batch 1C is merged with a UI | show "Assisted migration available" (a service) only; do not describe a self-service workspace |
| Customer payments allocation, customer statements, bank matching | Batch 1B is merged | do not mention; "record customer and supplier payments" is what is live |
| Fixed assets | depreciation posts to the GL (owner ranking of ERPNext finding 6) | do not mention |
| Email sending of invoices, notifications | the mail provider is wired (B1) | "download and share the PDF" |
| Live bank feeds, inventory, API, multi-company, custom reports, Zakat calculation, withholding tax, 2FA, SSO | each ships | do not mention; a "Roadmap" page is acceptable if every item is labelled "planned" |

### K.2 Public pricing table

Prices in SAR, ex-VAT, per organisation. Annual = 12 months for the price
of 10.

| | **Basic** | **Pro** | **Advanced** |
| --- | ---: | ---: | ---: |
| Monthly | SAR 99 | SAR 199 | SAR 349 |
| Annual | SAR 990 (= 82.50/mo) | SAR 1,990 (= 165.83/mo) | SAR 3,490 (= 290.83/mo) |
| Users | 2 + your accountant | 5 + your accountant | 15 + your accountant |
| Companies | 1 | 1 | 1 (groups: contact us) |
| AI allowance | *Version A:* included — activating soon · *Version B:* 50 questions + 75 document reads / month | *A:* included — activating soon · *B:* 150 questions + 300 reads / month | *A:* included — activating soon · *B:* 400 questions + 1,000 reads / month |
| Core accounting | Full double-entry ledger, chart of accounts, journal entries, financial statements, closed months, audit trail | Everything in Basic + budgets | Everything in Pro |
| Sales | Customers, quotations, invoices with ZATCA QR, credit notes, payments, PDF in Arabic & English — up to 1,200 invoices/year | Up to 12,000 invoices/year; recurring invoices unlimited | Unlimited |
| Purchases | Suppliers, bills, receipt capture (scan the ZATCA QR), payments — up to 1,200 bills/year, 100 captures/month | Purchase orders; up to 12,000 bills/year, 500 captures/month | Unlimited bills; 2,500 captures/month |
| Banking | 2 bank accounts, statement import, review & reconciliation queue | 6 bank accounts | Unlimited bank accounts |
| VAT / ZATCA | VAT on every line, VAT return, ZATCA-ready invoices (QR, counter, Hijri dates) | Same — compliance is on every plan | Same |
| Reporting | All standard reports and statements, Finance Hub | + Analytics: trends, receivables bridge, cash reconciliation, decomposition | Same as Pro |
| Automation | Approvals, recurring documents (5 schedules), findings, categorisation rules | Recurring unlimited; payroll journal with GOSI (up to 10 employees) | Payroll unlimited |
| Analytics | — | Included | Included |
| Migration | Assisted migration available (SAR 1,500) | Assisted migration included with annual | Assisted migration included |
| API / integrations | — | — | — (roadmap) |
| Support | Email, next business day | Email, same business day | Priority support + named onboarding |

### K.3 Plan copy

**Basic** — *Your books, done right, in Arabic.*
- **Ideal customer:** a freelancer, a micro-business, an owner-managed
  company with one CR.
- **Price:** SAR 99/month, or SAR 990/year (two months free). Prices exclude
  VAT.
- **Key included capabilities:** a complete double-entry ledger; invoices
  with the ZATCA QR code and invoice counter, in Arabic and English with Hijri
  and Gregorian dates; quotations and credit notes; bills and receipt
  capture; bank statement import with a review queue; VAT on every line and
  your VAT return; trial balance, profit & loss, balance sheet, cash flow;
  closed months and a full audit trail; approvals so nothing reaches the
  books before you say so.
- **AI:** *A:* included in your plan — activating soon. *B:* 50 AI
  questions and 75 AI document reads a month, plus automatic categorisation
  help.
- **Users / companies:** 2 users plus a free seat for your accountant; 1
  company.
- **Upgrade when:** you need a third person in the books, purchase orders, a
  payroll run, budgets, or you pass 100 invoices a month.

**Pro** — *The accountant's plan.*
- **Ideal customer:** a growing SME with employees and an accountant or
  bookkeeper involved.
- **Price:** SAR 199/month, or SAR 1,990/year (two months free), excluding
  VAT.
- **Key included capabilities:** everything in Basic, plus purchase orders
  with approval and conversion to bills; budgets with variance; analytics
  that show *where* the cash went — trends, the receivables bridge, cash
  reconciliation; a payroll journal that computes GOSI and posts salaries to
  the ledger (up to 10 employees); unlimited recurring invoices and bills;
  six bank accounts; 12,000 invoices and 12,000 bills a year; one assisted
  migration included with an annual plan.
- **AI:** *A:* included — activating soon. *B:* 150 AI questions and 300 AI
  document reads a month.
- **Users / companies:** 5 users plus your accountant; 1 company.
- **Upgrade when:** your team passes twelve people, you run payroll for more
  than ten, you issue more than 1,000 documents a month, or you want a
  named person to onboard you.

**Advanced** — *For finance teams.*
- **Ideal customer:** an established SME where accounting is a department:
  a finance team, high volume, a controller who wants priority support and
  an onboarding they do not have to run themselves.
- **Price:** SAR 349/month, or SAR 3,490/year (two months free), excluding
  VAT. Larger requirements — more than fifteen users, a group of companies,
  a contractual SLA, white-glove migration — **contact us**.
- **Key included capabilities:** everything in Pro, without limits on
  invoices, bills, bank accounts or payroll employees; 2,500 receipt captures
  a month; priority support with a named onboarding; assisted migration
  included; first access to what ships next for finance teams.
- **AI:** *A:* included — activating soon. *B:* 400 AI questions and 1,000
  AI document reads a month, shared across your team.
- **Users / companies:** 15 users plus your accountant; 1 company (groups:
  contact us).
- **Upgrade when:** you need more than fifteen seats, one subscription for
  several companies, or contractual terms — talk to us.

**Included in every plan** (a strip under the cards): double-entry ledger ·
VAT return · ZATCA-ready invoices · Arabic and English · Hijri and Gregorian
dates · audit trail · closed months · bank import and review · a free seat
for your accountant · approvals.

### K.4 Feature comparison — public, complete but understandable

| | Basic | Pro | Advanced |
| --- | :---: | :---: | :---: |
| **Accounting** | | | |
| Double-entry ledger, chart of accounts | ✓ | ✓ | ✓ |
| Journal entries with approval | ✓ | ✓ | ✓ |
| Financial statements (TB, P&L, balance sheet, cash flow, equity) | ✓ | ✓ | ✓ |
| Closed months, audit trail | ✓ | ✓ | ✓ |
| Hijri & Gregorian dates, fiscal years | ✓ | ✓ | ✓ |
| Budgets & variance | — | ✓ | ✓ |
| **Sales** | | | |
| Customers, quotations | ✓ | ✓ | ✓ |
| Invoices with ZATCA QR & counter, credit notes | 1,200 / yr | 12,000 / yr | unlimited |
| Invoice PDF in Arabic & English with your logo | ✓ | ✓ | ✓ |
| Record customer payments | ✓ | ✓ | ✓ |
| Customer ledger, receivables ageing | ✓ | ✓ | ✓ |
| Recurring invoices (drafts you approve) | 5 schedules | unlimited | unlimited |
| **Purchases** | | | |
| Suppliers, bills, supplier payments | 1,200 bills / yr | 12,000 / yr | unlimited |
| Receipt capture (QR scan + OCR) | 100 / mo | 500 / mo | 2,500 / mo |
| Purchase orders | — | ✓ | ✓ |
| Payables ageing | ✓ | ✓ | ✓ |
| **Banking** | | | |
| Bank accounts | 2 | 6 | unlimited |
| Statement import, review & reconciliation queue | ✓ | ✓ | ✓ |
| Cash position (Finance Hub) | ✓ | ✓ | ✓ |
| **VAT & compliance** | | | |
| VAT on every line, VAT return | ✓ | ✓ | ✓ |
| ZATCA-ready invoices (QR, counter, Hijri dates) | ✓ | ✓ | ✓ |
| Tax journal report | ✓ | ✓ | ✓ |
| **Reporting & analytics** | | | |
| All standard reports | ✓ | ✓ | ✓ |
| Analytics (trends, receivables bridge, cash reconciliation) | — | ✓ | ✓ |
| **Automation** | | | |
| Approvals workflow | ✓ | ✓ | ✓ |
| Automatic findings & categorisation rules | ✓ | ✓ | ✓ |
| Payroll journal with GOSI | — | 10 employees | unlimited |
| Product & service catalogue | ✓ | ✓ | ✓ |
| **AI** (Version B only) | | | |
| AI questions about your books | 50 / mo | 150 / mo | 400 / mo |
| AI document reads | 75 / mo | 300 / mo | 1,000 / mo |
| Automatic categorisation & explanations | ✓ | ✓ | ✓ |
| **Team** | | | |
| Users (+ a free accountant seat) | 2 | 5 | 15 |
| Extra user | SAR 20/mo | SAR 20/mo | SAR 20/mo |
| Companies | 1 | 1 | 1 (groups: contact us) |
| **Migration & support** | | | |
| Assisted migration | SAR 1,500 | included with annual | included |
| Support | email, next business day | email, same business day | priority + named onboarding |
| Storage | 2 GB | 10 GB | 50 GB |

### K.5 FAQ

**What is included?** Every plan is a complete accounting system: the
ledger, invoices and bills, VAT and your VAT return, bank import and
reconciliation, the financial statements, closed months and the audit trail.
Plans differ in how many people can work in the books, how much you issue,
and the depth of reporting, automation and support.

**How does AI usage work?** *(Version B)* Your plan includes a monthly
allowance of AI questions — ask about your own books and get answers with
the figures shown — and AI document reads for receipts the QR scanner cannot
read. The allowance is shared by everyone in your organisation, not per
user. Automatic help such as categorisation suggestions is included and not
counted. *(Version A: "AI features are included in every plan and will be
activated for all customers soon; nothing changes in your price.")*

**What happens when I reach my AI allowance?** You get a notice at 80 %.
At 100 % the AI assistant pauses until your next month; everything else —
reports, invoicing, capture by QR and scanner — keeps working. You can add an
AI Boost or upgrade at any time. The first time you hit a limit in a year we
add 25 % automatically.

**Can I upgrade?** Yes, at any time; the upgrade applies immediately and
you pay the difference for the rest of your period. Nothing is reset.

**Can I downgrade?** Yes, at the end of your billing period. Nothing is ever
deleted: your records, customers, invoices and history stay readable. If you
have more users or bank accounts than the lower plan includes, you choose
which stay active; corrections, payments and credit notes are never blocked.

**Is VAT included in the price?** Prices are shown excluding VAT; 15 % VAT
is added to your invoice. As a VAT-registered business you recover it.

**How does migration work?** *(until Batch 1C ships)* We can bring your
opening balances and your customer and supplier lists across for you —
assisted migration is SAR 1,500 per company, included with Pro annual and
Advanced. *(after)* Add: use the migration workspace yourself, free on every
plan: map your chart of accounts, load customers, suppliers, open invoices
and bills, and your opening balances; validate, then commit in one step.

**Can I add users?** Yes — SAR 20 per user per month on any plan. Your
external accountant always has a free seat.

**Can I add companies?** Each company is its own subscription today, and
one login can switch between them. Groups that want one subscription for
several companies: contact us.

**Is there a free trial?** 14 days of Pro, no card required, from the day
your account is verified. At the end of the trial your data stays readable
for 30 days while you choose a plan.

**Where is my data hosted?** *(answer only once C6 is decided — the owner
supplies the sentence; do not write one.)*

### K.6 Page architecture

Header ("Simple pricing in riyals, excluding VAT") with a monthly/annual
toggle (annual default, "2 months free"); **three cards**; the "included in
every plan" strip; a line under Advanced — "Larger requirements? Contact
us"; the comparison table (collapsible); add-ons; "How usage works" (three
sentences: limits apply to what you create, never to what you recorded; a
notice at 80 % and a month's grace; corrections, payments and compliance are
never blocked); Migration; FAQ; contact form. No tokens, no provider names,
no planned features, no fourth card.

---

## L. Internal pricing rationale

**Basic at 99, a full ledger.** Withholding correctness (statements, closed
months, audit trail, reconciliation) or compliance (VAT, ZATCA QR) would make
the cheapest customer's books less trustworthy — the R1 proposal's principle
and M18.0's lesson. Differentiation comes from seats (2), volume (1,200 +
1,200), bank accounts (2), recurring (5) and the absence of the management
layer (budgets, analytics, POs, payroll). Zoho Standard at 69 with bank feeds
is the competitor Basic cannot beat on price; it beats it on Arabic-first
correctness and the accountant seat. 79 (the "value leader" option) was
rejected because Basic has the least infra headroom (companion §6: infra
+50 % costs Basic six points).

**Pro at 199, the accountant's plan.** Everything that is LIVE and that an
accountant asks for (POs, budgets, analytics, payroll journal, more seats,
more banks, 10× volume) sits here, at the bottom of the Saudi "complete
accounting" band. Analytics is the one re-gate of a screen that ships free
today; it is legitimate only because no customer exists yet, and it is
flagged for the owner (§M). The customer-payments workflow and bank matching
will land on **every** plan when 1B merges — they are correctness, and they
are not a reason to price Pro higher.

**Advanced at 349, for finance teams.** Re-derived from what is LIVE: 15
seats (the 13th seat is the arithmetic trigger), unlimited volume, people
(priority support, named onboarding, assisted migration) and the largest AI
allowance. 449 depended on pooled companies that do not exist. Advanced is
also the door to "contact us" — the owner's Enterprise pathway without a
fourth card. When multi-company, API, custom reports and role-routed
approvals ship, Advanced receives them first at the same price until the
review in §M.

**AI allowances 50/75 · 150/300 · 400/1,000.** Derived at ≈ P90–P95 of the
modelled distributions; full consumption costs 1.2 / 2.5 / 4.5 % of ARPU on
Groq's card; organisation-level because consumption follows the books, not
head-count; provider-independent through the AI Unit weight table. Shown on
the page only when the boundary flips.

**Volume limits 1,200 / 12,000 / unlimited.** ≈ 100/month and ≈ 1,000/month
are honest proxies for the segments; Advanced is uncapped because a cap
there would only trigger the conversation Advanced already offers.

**Annual = 12 for 10.** The Saudi norm; a larger discount buys little, a
smaller one reads as stingy. Cash flow: 100 customers at 60 % annual prepay
≈ SAR 103k in month one at the revised prices (30 × 990 + 21 × 1,990 + 9 ×
3,490 = 102,900), which funds the modelled platform floor (~SAR 3.4k/month) for over
two years.

**Trial: 14 days of Pro, no card, no permanent free tier.** The verification
gate must approve before the clock starts (L3).

**Add-ons only where a cost or a choice exists.** Seats, AI Boost, storage,
assisted migration, priority support on Pro. The company add-on is withdrawn
until multi-company is built.

---

## M. Unresolved decisions

1. **Analytics on Pro rather than Basic** re-gates a screen that ships free
   today. Legitimate only before the first tenant; the owner must confirm
   before launch, and `tests/reports-catalogue.test.ts` will need a
   deliberate change when tiering is built.
2. **Fixed assets:** rank ERPNext finding 6 (depreciation-to-GL, ~1 week, or
   gate `/assets` behind coming-soon in an hour). Until then the register is
   reachable but unmarketed.
3. **Multi-company:** not built, not promised. Decide whether it is designed
   before or after R1; the Advanced price review depends on it.
4. **AI on the page:** Version A or omit entirely until the boundary flips
   (recommended: omit the row, keep one sentence in the FAQ).
5. **Ex-VAT display** (recommended) vs VAT-inclusive.
6. **402 vs 403** for plan refusals (recommended 402).
7. **Whether Saudi Ledger's own subscription invoices are issued through the
   platform** (recommended yes, once M12.9 is proven).
8. **The billing provider** — R1's first decision; this document is neutral.
9. **A second-organisation discount** for groups before multi-company ships
   (none recommended; keep it simple).
10. **Support tiers** name response times the owner has not staffed (L3's
    sibling): confirm "next business day" and "same business day" before
    they are printed.
11. **Review triggers for the prices:** M12.9 passes; the AI boundary flips
    (re-derive allowances from 90 days of `ai_usage`); the first 100 paying
    organisations (re-derive volume limits and infra cost per org); Batch 1B
    and 1C merge (update §K.1's gates); multi-company or the API ships
    (re-ask the Advanced price with data); any non-per-token AI contract; a
    Saudi competitor moves its ladder by > 15 %.
