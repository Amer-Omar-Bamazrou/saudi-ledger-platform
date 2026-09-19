# Saudi Ledger — pricing, packaging and entitlement strategy (research, 2026-09)

**Status (2026-09-19): RESEARCH AND PROPOSAL — nothing here is decided, priced,
or built. R1 (billing) stays undesigned until the owner chooses; the billing
entity and the commercial model are not final. Current state authority:
[CLAUDE.md §2](../../CLAUDE.md); the open R1 row is CLAUDE.md §5.**

Companion: [`pricing-unit-economics-2026-09.md`](pricing-unit-economics-2026-09.md)
holds every number this document cites — the Groq price card, the per-operation
costs, the usage distributions, the COGS model, the margin scenarios, the
sensitivity grid and the future-provider scenarios. This document holds the
strategy, the packaging, the entitlement matrices and the entitlement
architecture. Where a figure appears here it is quoted from there.

**Research date: 2026-09-19.** Competitor prices were read from official
pricing pages on that date unless marked otherwise. Every claim is tagged with
one of: **FACT** (read from an official page or from this repository),
**SOURCE-DERIVED OBSERVATION**, **CUSTOMER-REVIEW EVIDENCE**, **ASSUMPTION**,
**CALCULATION**, or **STRATEGIC RECOMMENDATION**. Where a fact could not be
verified it is marked `UNVERIFIED`.

🔴 **Two repository findings surfaced by this research that the owner must see
(not fixed here — out of this task's scope):**

1. **The default vision model no longer exists on Groq.** `packages/config/src/env.ts`
   defaults `GROQ_VISION_MODEL` to `meta-llama/llama-4-scout-17b-16e-instruct`;
   Groq's deprecation page lists that model as shut down 2026-07-17, with
   `openai/gpt-oss-120b` or `qwen/qwen3.6-27b` as the migration targets
   (FACT, console.groq.com/docs/deprecations, read 2026-09-19). The vision
   benchmark harness (`benchmarkVision.ts`) will 404 on every call until the
   default is re-pinned — the same failure shape as the 2026-08-21 text-model
   default (design-ai-layer §12d). `allam-2-7b` is also absent from the current
   catalog, and `llama-3.1-8b` / `llama-3.3-70b` are now enterprise-only
   ("Contact Sales"). The models this research costs are the ones on the
   catalog today: `openai/gpt-oss-20b`, `openai/gpt-oss-120b` and (vision,
   preview) `qwen/qwen3.8-27b`.
2. **`feature_flags` has no consumer (CLAUDE.md §5, S6).** The entitlement
   model in §P below is the natural consumer, or the reason to drop it. Decide
   with R1, not before.

---

## Contents

- [0. What the product IS today — LIVE / IN DEVELOPMENT / PLANNED](#0-what-the-product-is-today)
- [A. Competitor pricing research](#a-competitor-pricing-research)
- [B. The Saudi market, analysed separately](#b-the-saudi-market-analysed-separately)
- [C. The pricing wedge — three strategies tested](#c-the-pricing-wedge--three-strategies-tested)
- [D. The four plans and their prices](#d-the-four-plans-and-their-prices)
- [E. Feature entitlement matrix](#e-feature-entitlement-matrix)
- [F. Usage limits matrix — with the reason for every limit](#f-usage-limits-matrix)
- [G. Add-on matrix](#g-add-on-matrix)
- [H. Enterprise matrix](#h-enterprise-matrix)
- [I. Upgrade triggers](#i-upgrade-triggers)
- [J. Downgrade behaviour](#j-downgrade-behaviour)
- [K. Saudi Ledger AI Packaging](#k-saudi-ledger-ai-packaging)
- [L. Migration pricing](#l-migration-pricing)
- [M. Accounting-firm pricing](#m-accounting-firm-pricing)
- [N. Multi-company pricing](#n-multi-company-pricing)
- [O. Free trial](#o-free-trial)
- [P. Annual billing](#p-annual-billing)
- [Q. Value propositions](#q-value-propositions)
- [R. Pricing page architecture](#r-pricing-page-architecture)
- [S. Entitlement vs permission vs accounting control — four separate questions](#s-four-separate-questions)
- [T. Accounting safety under enforcement](#t-accounting-safety-under-enforcement)
- [U. Implementation-ready entitlement architecture (conceptual — DO NOT BUILD YET)](#u-entitlement-architecture)
- [V. Recommended Saudi Ledger pricing — the summary](#v-recommended-saudi-ledger-pricing)
- [W. Assumptions, risks, review triggers, unresolved questions](#w-assumptions-risks-review-triggers-unresolved-questions)

---

## 0. What the product IS today

**Frame (FACT, this repository, 2026-09-19):** 62 UI routes and 123 API paths
on `main` (feature inventory 2026-09-15); 45 registered coming-soon promises,
each naming its blocker (`apps/web/src/lib/comingSoon.ts`). The branch
`feat/batch-1c-migration-opening-balances` carries Batch 1B (D-3 per-bank
cash, D-4 payments) and Batch 1C (migration) **which are NOT on `main`** —
they are classified IN DEVELOPMENT below regardless of what the branch's
own CLAUDE.md says, because a customer cannot use an unmerged branch.

Classification rule used throughout: **LIVE** = on `main`, reachable from a UI
surface, walked or covered by the browser suite. **IN DEVELOPMENT** = code
exists on an unmerged branch, or the backend exists with no screen, or the
capability is built but *dark by construction* pending an owner action.
**PLANNED** = a coming-soon entry, a roadmap row, or a design document with
no code. The customer-facing copy in §Q sells only LIVE.

### 0.1 Core accounting — LIVE

| Capability | Status | Evidence |
| --- | --- | --- |
| Double-entry GL, journal entries (draft → approve → post → reverse) | LIVE | `/journal-entries`, `services/accounting/glPosting` |
| Chart of accounts (flat list; create; system accounts protected) | LIVE, **no edit/delete routes, no tree, no import** | `/categories`; coming-soon `coa-tree-view`, `coa-import`, `coa-settings` (advisor Block E) |
| Trial balance, income statement, balance sheet, cash flow (**direct method only**), owner's equity | LIVE | `/reports/*`; indirect cash flow is a roadmap row |
| Closed months (period locks, company-scoped), the global 423 explanation | LIVE | M22 |
| Audit trail reader | LIVE | M23, `/audit-trail` |
| Fiscal years, Hijri + Gregorian dating on documents, business day = `Asia/Riyadh` | LIVE | M17.0–17.2, M20 |
| Budgets (per category, variance) | LIVE | `/budgets` |
| Cost centres / projects | PLANNED | coming-soon `cost-centers` (designed, zero code) |
| Multi-currency | PLANNED — **single currency enforced at the write boundary** | coming-soon `multi-currency` |

### 0.2 Sales / AR

| Capability | Status |
| --- | --- |
| Customers, quotations (submit/approve/convert), invoices (draft → submit → approve → sent → paid), credit notes | LIVE |
| Debit notes | LIVE capability, **page removed 2026-08-20** — coming-soon `debit-notes` says so |
| Invoice PDF, Arabic and English, logo, QR, Hijri dates (L1) | LIVE; **"send by email" waits on the mail provider** (B1) |
| Customer ledger report, AR ageing | LIVE |
| Customer payments with allocation, unallocation, deposits/advances, credit-note application, refunds, customer statement page (D-4 / Batch 1B) | **IN DEVELOPMENT** — built and browser-validated on the unmerged branch |
| Invoice/quotation templates, customer groups | PLANNED |

### 0.3 Purchasing / AP

| Capability | Status |
| --- | --- |
| Vendors, purchase orders (submit/approve/convert), bills (submit/approve/post/pay), AP ageing | LIVE |
| Document capture (A1): phone/upload → ZATCA QR decode (majority path) → Tesseract.js OCR fallback → scan-review → bill | LIVE (QR + Tesseract; **no paid OCR, by decision**) |
| Vendor statements, purchases by vendor/product | PLANNED |
| Supplier payment allocation object (AP twin of D-4) | PLANNED (bills pay path works today) |

### 0.4 Banking

| Capability | Status |
| --- | --- |
| Bank accounts, statement CSV upload, review queue (accept / settle against invoice or bill), transactions list | LIVE |
| Transfers (own-account / external / undeclared) posting to the GL | LIVE capability; **page missing** (coming-soon `transfers`) |
| Per-bank cash GL (D-3): one cash account per bank, `CASH` a non-posting header, every cash path fails closed without a bank | **IN DEVELOPMENT** (branch); **the historical cut-over is NOT run on any company** |
| Deterministic bank matching seam (statement ↔ payment), override / unmatch | **IN DEVELOPMENT** (branch, Batch 1B Phase D) |
| Live bank feeds (A2) | PLANNED — **blocked on a Saudi CR** for the SAMA-licensed provider signature |
| Bank account detail page, statement register | PLANNED |

### 0.5 Tax / compliance

| Capability | Status |
| --- | --- |
| VAT return (box-structured, S/Z/E/O per line, credit-note-correct), VAT summary, tax journal entries report | LIVE |
| ZATCA Phase 2 document construction: CSR, `secp256k1`, XAdES, nine QR tags, six compliance documents — **verified against the live sandbox** | LIVE (construction) |
| ZATCA onboarding UI, credential vault (KMS-wrapped), outbox worker, archive, renewal reminders | LIVE locally; transport proven against a mock; archive `local-fs` only |
| **ZATCA production clearance/reporting** (`/invoices/{clearance,reporting}/single`) | 🔴 **NEVER CALLED IN ANY ENVIRONMENT** — blocked on a registered Saudi entity (M12.7 + M12.9) |
| Zakat: scope + fiscal calendar (M17.0–17.2) | LIVE |
| Zakat base / calculation / reports / settings | PLANNED — **held on advisor Block C** (tax content unverified) |
| Withholding tax | PLANNED (zero code; advisor first) |

### 0.6 Reporting and analytics

| Capability | Status |
| --- | --- |
| 15+ standard reports (`/reports/*`), journal report, GL, account statement/summary, activity | LIVE |
| Analytics: trend, receivables bridge, cash reconciliation, decomposition; Finance Hub: liquidity (neutral "watch" observations), tax compliance, books status | LIVE |
| Export | PDF for invoices (L1); **no data export surface** — coming-soon `data-export` is **held on PDPL** (advisor C8) |
| Custom reports, aging trends, scheduled reports | PLANNED (`aging-trends` is `notDerivable` — the fact is not stored) |
| Forecasting | **NOT IN ANY DESIGN DOCUMENT.** No code, no spec. Listed only because the brief asked. |

### 0.7 Automation

| Capability | Status |
| --- | --- |
| Approval engine (draft / submit / approve / send-back / reject) on invoices, bills, JEs, quotations, POs, payroll; approvals worklist | LIVE (the worklist is the one unstyled page) |
| Recurring documents (A3) — **drafts only, by consent principle** | LIVE |
| Recurring journal entries | PLANNED |
| Deterministic categorization engine (rules, Arabic + English) | LIVE |
| Findings engine (AI-3a: deterministic rule findings, e.g. suspense balances, stale drafts), scheduled daily (AI-5), acknowledge | LIVE — **the engine is deterministic; only the EXPLANATION is a model call** |
| Notifications / alerts | Alerter code done; **`ALERT_WEBHOOK_URL` unwired**; email unwired (B1/B2) |

### 0.8 Assets, payroll, inventory

| Capability | Status |
| --- | --- |
| Fixed assets: register, straight-line depreciation posting, asset schedule report | LIVE |
| Employees, payroll runs (approval flow, GL posting), payroll report | LIVE — **not WPS/GOSI/Mudad; a payroll journal, not a payroll service** |
| Products (service/unit, no cost) | LIVE |
| Inventory, stock movements, COGS, valuation, sales/purchases by product margin | PLANNED — waits on advisor Block E (COGS account decision) |

### 0.9 Integrations and platform

| Capability | Status |
| --- | --- |
| Session auth, invitations, four roles (`admin`, `accountant`, `bookkeeper`, `viewer`) with a seeded permission matrix, activation actions separately grantable | LIVE |
| Verification gate: signup → `pending_review` → operator approves (KYC) | LIVE — **the wait is undefined (L3)** |
| Public API / API keys / webhooks | **PLANNED — there is no API-key auth; only session cookies.** The OpenAPI spec exists (123 paths) and the generated client is used internally, so "API access" is a packaging decision over a small build. |
| Payment gateways (MyFatoorah, SiFi) | PLANNED — CR-gated |
| SSO, 2FA, session management, IP restrictions | PLANNED (`build`) |
| Password reset (self-service email) | IN DEVELOPMENT — break-glass shipped; email flow waits on the mail provider |
| Malware scanning of uploads | header sniff LIVE; clamd sidecar is a deployment item (C4) |
| Billing / subscription | **DOES NOT EXIST** (R1) |

### 0.10 Migration (Batch 1C)

| Capability | Status |
| --- | --- |
| Migration batches: chart-of-accounts mapping, parties, historical AR/AP open items, advances, opening position, validate → commit (one transaction, R1–R10 gates) → OBE clearing → reversal and corrected re-run | **IN DEVELOPMENT** — API on the unmerged branch, **no UI yet** |
| Spreadsheet CoA import | PLANNED (advisor Block E) |
| Assisted / white-glove migration | a SERVICE, not code — priced in §L |

### 0.11 AI

| Capability | Status | Metered operation |
| --- | --- | --- |
| Provider seam (AI-1a): `AiProvider` with Groq REST implementation, `AiUnavailableError` fail-closed, per-call `maxTokens`, reasoning-effort control | LIVE | — |
| Metering (`ai_usage`: org, company-or-NULL, operation, model, prompt/completion tokens, ok/failed, append-only) | LIVE | the table every allowance below is enforced from |
| Categorization second opinion — only for rows the deterministic engine scores **below 0.65 confidence**; `maxTokens 200`; degrades to deterministic on any failure | LIVE, **dark** | `categorize_second_opinion` |
| Findings explanations (AI-3b) — `maxTokens 300`, **≤ 25 per run**, content-hash de-duplicated, judged by a second call for invented claims | LIVE, **dark** | `finding_explanation` |
| Grounded answers (AI-6a, `/ask`) — tool-selected ledger figures, `maxTokens 400`, bilingual answer, judge call, refusal path | LIVE, **dark** | `grounded_answer` |
| Vision receipt extraction (the tail after QR + Tesseract) | **benchmark harness only**; production use waits on the Groq Enterprise agreement AND an Arabic-capable vision model in Dammam | `benchmark_vision` |
| AI reconciliation assistance | PLANNED, **unspecced** — matching is deterministic (Batch 1B) |
| AI anomaly detection | = the findings engine (deterministic, LIVE) + explanations (dark). Do not sell it as a model "detecting" anything. |
| AI financial analysis / insights | = grounded answers over the analytics endpoints. A monthly narrative brief is PLANNED, unspecced. |
| AI forecasting | **NOT SPECCED ANYWHERE.** |

**"Dark by construction" (FACT):** `loadEnv` refuses `AI_PROVIDER=groq` in
production unless `GROQ_DATA_BOUNDARY_ACK` carries the exact attestation
string; the coming-soon entries `ai-assistant` and `vision-model` name the
Groq Enterprise agreement (Dammam pinning + contractual ZDR) as the blocker.
**Every AI line in every matrix below is therefore sold as "included when
enabled", and the pricing page must not show AI as live until the boundary
flips.**

---

## A. Competitor pricing research

Research date **2026-09-19**. Currency as printed on the official page. Saudi
pages quote SAR; global pages quote USD. `n/s` = not stated on the page.

### A.1 Saudi / GCC

| Product | Source (official) | Entry | Mid | High | Annual | Users | Extra user | Companies | Key packaging facts |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **Wafeq** | wafeq.com/en-sa/pricing (FACT) | Starter SAR 119/mo | Plus SAR 149/mo | Premium SAR 249/mo; Enterprise "request pricing", yearly only | 1,190 / 1,430 / 2,390 SAR/yr = "12 months for the price of 10" (effective 99 / 119 / 199) | n/s on the page | n/s | branch add-on SAR 24/mo (290/yr) | Starter "invoicing only"; Premium "complete accounting"; add-ons: advanced customization SAR 82/mo, revenue recognition SAR 124/mo; 14-day trial, no card; "ZATCA-compliant e-invoicing, inventory, payroll, 40+ reports" (plan split n/s). OCR: "reads, extracts and records key accounting data … into draft accounting entries" (product update, 2026-04-13), plan/quota n/s. The en/ar pages showed USD 26/32/55 promotional (USD 32/39/67 regular) — the same tiers in a second currency. |
| **Qoyod** | qoyod.com knowledge base "plans and pricing" (FACT; page dated 2025 — treat 2026 prices as `UNVERIFIED` until the app's plan page is read) | Basic SAR 1,380/yr (138/mo) **incl. VAT**, 1 user, 1 location | Pro SAR 2,070/yr (207/mo) incl. VAT, 3 users, 3 locations | Advanced SAR 3,795/yr (379.50/mo) incl. VAT, 5 users, 5 locations | annual is the base; monthly = annual/10 | 1 / 3 / 5 | SAR 240/yr (20/mo) ex-VAT | **"Each business requires a separate subscription"**; extra location SAR 480/yr | Basic EXCLUDES purchases, suppliers, fixed assets, projects, **Phase 2 e-invoicing**, API. Pro adds purchases, inventory, projects, Phase 2, API/Zapier. Advanced adds fixed assets, budgets, dimensions, manufacturing, recurring. Add-ons: payroll SAR 120/employee/yr, POS SAR 600/user/yr. No trial on the page. |
| **Daftra** | daftra.com hub article "accounting software prices" (dated 2025-10-21; the pricing page itself 404s on the en/sa paths — 2026 prices `UNVERIFIED`) | Basic SAR 99/mo (75/mo annual) | Advanced SAR 159/mo (119 annual) | Comprehensive SAR 199/mo (159 annual) | ~25% off | n/s | n/s | n/s | "All plans include most programs" — sales, CRM, inventory, accounting, HR/payroll, POS; ZATCA Phase 2 direct Fatoora. A search snippet quoted SAR 270/350 tiers — conflicting, `UNVERIFIED`. |
| **Snad** | snad.io/en/pricing (FACT) | Starter free (3 apps, 1 user; 7-day trial) | Basic SAR 149/mo / 1,490/yr, 3 users | Pro SAR 399/mo / 3,990/yr, 5 users | 2 months free | 1 / 3 / 5 | SAR 20/mo | n/s | **Prices include 15% VAT.** "Every app on every plan; the difference is users, apps running at once, and ZATCA integration" (ZATCA optional on Basic, included on Pro). Nine apps incl. POS, HR, assets. |
| **Zoho Books (KSA edition)** | zoho.com/sa/books/pricing (FACT) | Free SAR 0 (1 user + 1 accountant, 1,000 invoices/yr, **no ZATCA, no VAT tracking**) → Standard SAR 69/mo (60 annual), 3 users | Professional SAR 129/mo (90 annual), 5 users; Premium SAR 159/mo (120 annual), 10 users | Elite SAR 349/mo (280 annual), 10 users; Ultimate SAR 799/mo (660 annual), 15 users | 13–20% off | 1+1 / 3 / 5 / 10 / 10 / 15 | SAR 10/mo (8 annual) | organisation = one subscription | Invoice caps 1,000 / 5,000 / 10,000 / 25,000 / 100,000 per year (same for bills). Bank feeds from Standard; ZATCA from Standard; inventory from Professional; fixed assets from Premium; custom reports and API from Standard; workflow rules from Professional. "Prices are exclusive of local taxes." 14-day trial. |
| **Odoo** | odoo.com/pricing-plan (FACT, USD) | One App Free $0 | Standard $13.50/user/mo annual ($16.90 monthly, discount "valid 12 months") | Custom $20.40/user/mo annual ($25.50) | ~20% | per user | per user | multi-company on Custom | Per-user pricing; API and Studio on Custom only. Reference point for "ERP-shaped" buyers. |

### A.2 Global

| Product | Source | Entry | Mid | High | Users | Extra user | Annual | AI / capture | Key packaging facts |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **QuickBooks Online (US)** | quickbooks.intuit.com/pricing (FACT, USD) | Simple Start $38/mo (promo $19 for 3 months), 1 user + 2 accountants | Essentials $85 (3 users), Plus $140 (5 users, inventory, budgeting) | Advanced $340 (25 users, forecasting, batch invoicing, priority support) | 1 / 3 / 5 / 25 | tiered by plan, not per seat | "No annual contract" — no annual discount shown | "Automated bookkeeping"; 300+ apps | Accountant access free on every plan; 30-day trial OR the promo, not both. |
| **Xero (US)** | xero.com/us/pricing-plans (FACT, USD) | Early $25/mo (20 invoices, 5 bills; promo $2.50 × 6 months) | Growing $55 (unlimited; "auto-reconcile bank transactions") | Established $90 (multi-currency, projects, expenses, analytics) | **unlimited users on every plan** | — | none shown | "Smart Document Capture" on every plan; auto-reconciliation | Payroll add-on $36/mo + $6/employee. Volume caps only on Early. |
| **FreshBooks (US)** | freshbooks.com/pricing (FACT, USD) | Lite $23/mo (5 billable clients; promo $1 × 12 months) | Plus $43 (50 clients; bank reconciliation, accountant access, double-entry reports) | Premium $70 (unlimited); Select custom (2 team members) | 1 (+$11/user/mo) | $11/mo | annual toggle (discount not captured) | — | Caps by **billable clients**, not documents; 30-day trial, no card. |

### A.3 What the research supports — observations, not facts

- **SOURCE-DERIVED OBSERVATION:** the Saudi price ladder for a *complete*
  accounting plan clusters at **SAR 199–249/month list, ~160–200 effective
  annual** (Wafeq Premium 249 → 199; Daftra Comprehensive 199 → 159; Qoyod Pro
  207 incl. VAT ≈ 180 ex-VAT; Zoho Professional 129 → 90 is the outlier below;
  Snad Pro 399 incl. VAT ≈ 347 the outlier above).
- **SOURCE-DERIVED OBSERVATION:** the Saudi entry tier clusters at **SAR
  99–149/month list** and is *functionally* crippled in three of four cases
  (Wafeq "invoicing only"; Qoyod Basic excludes purchases and Phase 2; Snad Basic
  makes ZATCA optional). Zoho is the only vendor whose entry tier is a full
  ledger with ZATCA.
- **SOURCE-DERIVED OBSERVATION:** "12 months for the price of 10" (16.7%) is the
  Saudi annual norm (Wafeq, Snad, Qoyod monthly = annual/10). Zoho KSA discounts
  13–20%. US vendors show no annual discount at all on the page; they discount
  the first months instead.
- **SOURCE-DERIVED OBSERVATION:** no Saudi competitor caps invoice volume on the
  page; Zoho caps per year at generous levels; Xero caps only on its entry tier;
  FreshBooks caps by clients.
- **SOURCE-DERIVED OBSERVATION:** AI is **not a priced line item** anywhere in
  the set. Wafeq sells OCR as a product update; Xero folds "Smart Document
  Capture" and AI reconciliation into every plan; QuickBooks sells "automated
  bookkeeping". Nobody publishes an AI allowance, a token figure or an AI add-on.
- **SOURCE-DERIVED OBSERVATION:** Qoyod's "each business requires a separate
  subscription" and Wafeq's branch add-on (SAR 24/mo) are the two Saudi answers
  to multi-entity; neither offers a pooled multi-company plan below Enterprise.
- **CUSTOMER-REVIEW EVIDENCE:** none was gathered for this document. No
  competitor "pain point" is asserted here. (The brief's example — price-increase
  complaints — is deliberately not claimed.)

---

## B. The Saudi market, analysed separately

**Do not convert global USD to SAR and call it a benchmark.** The relevant
comparison for a Saudi SME is the Saudi ladder in §A.1, for these reasons
(each is a FACT about the product or a SOURCE-DERIVED OBSERVATION about the
market unless marked):

1. **ZATCA Phase 2 is a licence to operate, not a feature.** Every Saudi
   vendor in the set includes Phase 2 on its mid tier and most exclude or
   "option" it on the entry tier. A Saudi buyer's first filter is "is it
   ZATCA-integrated"; price comes second. Saudi Ledger's construction is
   sandbox-verified but **production submission has never run** — until M12.7
   and M12.9 run, the product cannot claim what the mid tiers of every
   competitor claim. **This is the single largest pricing-power constraint,
   and it is not a pricing decision.**
2. **VAT is mandatory above the SAR 375k threshold and the return is
   box-structured** — the VAT return being *document-derived* (documents FILE,
   transactions RECONCILE) is a correctness differentiator accountants notice
   and business owners do not. It supports the Pro tier's story to the
   accountant persona, not a price premium on Basic.
3. **Arabic-first, RTL, Hijri.** A launch requirement, not a differentiator —
   every Saudi competitor is Arabic-first. Global competitors are not
   (Zoho's KSA edition is; QBO/Xero/FreshBooks are not localised for Saudi
   tax at all). The comparison set for pricing is therefore the Saudi set plus
   Zoho.
4. **Saudi accountants are the channel.** Qoyod's 25,000+ businesses
   (`UNVERIFIED`, secondary) and Wafeq's accountant programme point at the
   same thing: the practising accountant recommends the tool. §M prices for
   that.
5. **Multi-company is common at small scale** — a family group with two or
   three CRs is an ordinary Saudi SME shape; Qoyod's "separate subscription per
   business" is a known friction (ASSUMPTION — supported by its being called
   out on Qoyod's own pricing page as a rule). Pooled companies on Advanced is
   a real wedge.
6. **Migration from Qoyod/Wafeq/Daftra/Excel is the acquisition path** —
   nobody starts on day one of their CR. Batch 1C is the product's most
   strategically-timed build and it is IN DEVELOPMENT with no UI. Migration
   pricing (§L) treats it as acquisition first.
7. **Prices are shown ex-VAT in this document**, following Wafeq and Zoho; Qoyod
   and Snad show VAT-inclusive prices. The pricing page must state the basis
   (STRATEGIC RECOMMENDATION: ex-VAT with "+15% VAT" stated on every card —
   the buyer is VAT-registered and recovers it).

**Does the Saudi-specific functionality create pricing power?** Partially.
It creates **parity** (ZATCA, VAT, Arabic — table stakes) and it creates
**accountant trust** (document-derived VAT, period locks with a 423
explanation, an audit trail, fail-closed issuance, per-bank cash). Neither
justifies a *higher* entry price than the Saudi ladder today; both justify a
mid tier at the top of the ladder once ZATCA production is proven, and they
justify the accountant channel. **AI creates the only genuine upward pricing
power in the set, and only once it is enabled** — nobody else prices it, and
nobody else has grounded answers over a Saudi ledger.

---

## C. The pricing wedge — three strategies tested

Numbers from the economics companion (§4–§6 there). Mix assumption 50% Basic /
35% Pro / 15% Advanced, 60% annual (ASSUMPTION).

| | **A — Value Leader** | **B — Premium AI Accounting** | **C — Saudi AI Value Platform** |
| --- | --- | --- | --- |
| Prices (SAR/mo list; annual = 10 months) | 79 / 159 / 349 | 129 / 279 / 599 | **99 / 199 / 449** |
| Position vs Saudi ladder | below every complete-accounting plan | above Wafeq Premium and Qoyod Advanced; near Zoho Elite | entry at the Saudi entry norm; mid at the ladder's top; Advanced between Qoyod Advanced and Zoho Elite |
| Blended ARPU (SAR/mo) | 133 | 227 | 168 |
| ARR per 1,000 customers | SAR 1.59M ($425k) | SAR 2.72M ($726k) | SAR 2.01M ($537k) |
| Blended gross margin incl. cost-to-serve, P75 AI (CALCULATION) | 70.4% | 81.5% | 76.0% |
| … if AI usage ×5 | 65.1% | 78.3% | 71.8% |
| Customer value story | "the same for less" — but the product cannot yet say "the same" (ZATCA production unproven) | "AI does your bookkeeping" — the AI is DARK today; selling it is selling PLANNED | "Saudi-correct accounting with AI when enabled, at the price you already pay" |
| Competitive differentiation | none durable — Zoho Standard is SAR 69 with 3 users and bank feeds | real IF the AI is live and measurably better in Arabic (design-ai-layer §12h: both gpt-oss models clear the Arabic gate on a synthetic corpus; single runs) | parity now, differentiation on enablement |
| Adoption | highest, but attracts the most price-sensitive, highest-support-per-riyal segment | lowest; needs proof the product cannot show before M12.9 and the Groq agreement | middle |
| Scalability / complexity | simple | requires AI metering to be customer-visible from day one | simple; AI packaging can be added when enabled without repricing |
| Churn risk | high on price shopping; low switching cost either way | high if AI under-delivers vs the price | moderate |
| Upgrade potential | weak — small gaps between tiers | strong ARPU, weak volume | strong: Pro carries the accounting differentiators, Advanced carries multi-company + AI capacity |

**STRATEGIC RECOMMENDATION: Strategy C**, with two conditions the analysis
imposes rather than assumes:

- **Price parity now, premium later.** A is rejected not because margin is
  poor (70% is acceptable at this stage) but because "cheaper than a product
  that already does what we cannot yet prove" is a story about the competitor.
  B is rejected because it prices a capability that is dark by construction —
  it would violate the rule this document opens with (never sell PLANNED as
  LIVE). C prices what is LIVE at the Saudi norm and leaves the AI premium as an
  Advanced-tier and add-on lever to pull **after** the Groq Enterprise agreement
  (or a Saudi provider) flips the boundary.
- **Set a review trigger, not a price increase.** §W names the conditions
  (ZATCA production verified; AI enabled; 100 paying orgs) under which the
  premium question is re-asked with data instead of assumptions.

---

## D. The four plans and their prices

All SAR, **ex-VAT**, per organisation. Annual = "12 months for the price of
10" (§P). STRATEGIC RECOMMENDATION throughout.

| | **Basic** | **Pro** | **Advanced** | **Enterprise** |
| --- | --- | --- | --- | --- |
| Who | solo / freelancer / micro business with one CR | growing SME, startup, the accountant-run business | established SME, group of companies, mid-market, firm-served clients | large organisations, accounting firms at scale, bespoke |
| **Monthly** | **SAR 99** | **SAR 199** | **SAR 449** | from **SAR 1,999/mo, billed annually** (custom) |
| **Annual** | **SAR 990** (= 82.50/mo, −16.7%) | **SAR 1,990** (= 165.83/mo) | **SAR 4,490** (= 374.17/mo) | from **SAR 23,988/yr** |
| Included users | **2** | **5** | **15** | custom (≥ 25) |
| Free external accountant seat (`accountant` role, one per company) | 1 | 1 | 1 | custom |
| Additional user | SAR 20/mo (200/yr) | SAR 20/mo (200/yr) | SAR 20/mo (200/yr) | custom |
| Included companies (legal entities) | 1 | 1 | **3** | custom |
| Additional company | not available | SAR 99/mo (990/yr) each, max 2 | SAR 99/mo (990/yr) each | custom |
| AI (when enabled; §K) | Essentials: background AI + 50 questions + 75 documents/mo | Assistant: background AI + 150 questions + 300 documents/mo | Assistant Plus: background AI + 400 questions + 1,000 documents/mo | pooled, custom |

**Why these numbers (CALCULATION + SOURCE-DERIVED OBSERVATION):**
Basic 99 equals Wafeq Starter's effective annual price and Daftra Basic's
list price — but unlike both, Basic is a **full ledger with bills, VAT return
and bank import** (§E), which is Zoho Standard's proposition at SAR 69 with one
fewer differentiator (Zoho has bank feeds; we cannot until A2). Pro 199 sits
at Wafeq Premium's effective price and Daftra Comprehensive's list — the
"complete accounting" price point — and carries the accountant-facing
differentiators. Advanced 449 sits between Qoyod Advanced (≈330 ex-VAT, 5
users, 1 business) and Zoho Elite (349, 10 users, 1 org) **with three
companies pooled**, which neither offers; per company it is cheaper than
Qoyod's "separate subscription per business" from the second company on. The
extra-user price (20) matches Qoyod and Snad; Zoho is 10. Gross margin at these
prices is 74–78% including cost-to-serve, 83–91% excluding it (companion §5).

---

## E. Feature entitlement matrix

Legend: **INCLUDED** · **LIMITED** (quantity in §F) · **ADD-ON** (§G) ·
**ENTERPRISE** · **NOT AVAILABLE** (disabled on that plan). Status column:
LIVE / IN DEV / PLANNED from §0 — **a PLANNED row is a packaging decision for
when it ships, never a promise on the pricing page.**

### E.1 Core accounting — universal by design (§"do not over-gate")

| Feature | Status | Basic | Pro | Advanced | Enterprise |
| --- | --- | --- | --- | --- | --- |
| Dashboard / launcher | LIVE | INCLUDED | INCLUDED | INCLUDED | INCLUDED |
| General ledger, double entry | LIVE | INCLUDED | INCLUDED | INCLUDED | INCLUDED |
| Chart of accounts (flat) | LIVE | INCLUDED | INCLUDED | INCLUDED | INCLUDED |
| Chart of accounts tree / import / settings | PLANNED | INCLUDED | INCLUDED | INCLUDED | INCLUDED |
| Manual journal entries with approval | LIVE | INCLUDED | INCLUDED | INCLUDED | INCLUDED |
| Trial balance, P&L, balance sheet, cash flow (direct), owner's equity | LIVE | INCLUDED | INCLUDED | INCLUDED | INCLUDED |
| Closed months (period locks) | LIVE | INCLUDED | INCLUDED | INCLUDED | INCLUDED |
| Audit trail | LIVE | INCLUDED | INCLUDED | INCLUDED | INCLUDED |
| Fiscal years, Hijri/Gregorian | LIVE | INCLUDED | INCLUDED | INCLUDED | INCLUDED |
| Budgets | LIVE | NOT AVAILABLE | INCLUDED | INCLUDED | INCLUDED |
| Cost centres / projects | PLANNED | NOT AVAILABLE | INCLUDED | INCLUDED | INCLUDED |
| Multi-currency | PLANNED | NOT AVAILABLE | NOT AVAILABLE | INCLUDED | INCLUDED |

Rationale: everything that makes the books *correct* is on every plan. A
Basic customer's ledger, statements, period locks and audit trail are the same
code as Enterprise's — gating them would make Basic's books less trustworthy,
which is the definition of hostile pricing. Budgets, cost centres and
multi-currency are management-accounting layers, not correctness.

### E.2 Sales / AR

| Feature | Status | Basic | Pro | Advanced | Enterprise |
| --- | --- | --- | --- | --- | --- |
| Customers | LIVE | INCLUDED | INCLUDED | INCLUDED | INCLUDED |
| Quotations (with conversion) | LIVE | LIMITED (counts with sales documents) | INCLUDED | INCLUDED | INCLUDED |
| Invoices, credit notes, debit notes | LIVE | LIMITED (sales-document volume, §F) | LIMITED | LIMITED | INCLUDED |
| Invoice PDF (AR/EN, logo, QR) | LIVE | INCLUDED | INCLUDED | INCLUDED | INCLUDED |
| Send invoice by email | waits on B1 | INCLUDED when wired | INCLUDED | INCLUDED | INCLUDED |
| Customer payments, allocations, unallocation | IN DEV | INCLUDED | INCLUDED | INCLUDED | INCLUDED |
| Customer deposits / advances, credit-note application, refunds | IN DEV | INCLUDED | INCLUDED | INCLUDED | INCLUDED |
| Customer statement, customer ledger, AR ageing | LIVE / IN DEV | INCLUDED | INCLUDED | INCLUDED | INCLUDED |
| Recurring invoices (drafts) | LIVE | LIMITED (5 schedules) | INCLUDED | INCLUDED | INCLUDED |
| Invoice / quotation templates, customer groups | PLANNED | NOT AVAILABLE | INCLUDED | INCLUDED | INCLUDED |

Rationale: **payments, allocations, refunds and statements are correctness**
(a receivable that cannot be settled correctly is a wrong balance sheet) — on
every plan. Volume is the Basic limiter, not capability.

### E.3 Purchasing / AP

| Feature | Status | Basic | Pro | Advanced | Enterprise |
| --- | --- | --- | --- | --- | --- |
| Suppliers | LIVE | INCLUDED | INCLUDED | INCLUDED | INCLUDED |
| Bills, supplier payments | LIVE | LIMITED (purchase-document volume) | LIMITED | LIMITED | INCLUDED |
| Purchase orders (with conversion) | LIVE | NOT AVAILABLE | INCLUDED | INCLUDED | INCLUDED |
| Document capture: QR decode + OCR → bill | LIVE | LIMITED (captures/mo, §F) | LIMITED | LIMITED | INCLUDED |
| Supplier statements, purchases by vendor | PLANNED | INCLUDED | INCLUDED | INCLUDED | INCLUDED |
| AP ageing | LIVE | INCLUDED | INCLUDED | INCLUDED | INCLUDED |
| Supplier payment allocation object | PLANNED | INCLUDED | INCLUDED | INCLUDED | INCLUDED |

Rationale: bills are correctness (input VAT, AP). POs are a procurement
workflow — the Qoyod/Wafeq line (both put purchasing on the mid tier) is the
market's line too.

### E.4 Banking

| Feature | Status | Basic | Pro | Advanced | Enterprise |
| --- | --- | --- | --- | --- | --- |
| Bank accounts | LIVE | LIMITED (2) | LIMITED (6) | INCLUDED | INCLUDED |
| Statement upload (CSV), review queue, accept/settle | LIVE | INCLUDED | INCLUDED | INCLUDED | INCLUDED |
| Bank matching (deterministic), override/unmatch | IN DEV | INCLUDED | INCLUDED | INCLUDED | INCLUDED |
| Transfers (own / external / undeclared) | LIVE (page PLANNED) | INCLUDED | INCLUDED | INCLUDED | INCLUDED |
| Per-bank cash GL (D-3) | IN DEV | INCLUDED (it is the ledger) | INCLUDED | INCLUDED | INCLUDED |
| Live bank feeds (A2) | PLANNED, CR-gated | NOT AVAILABLE | INCLUDED (fair use) | INCLUDED | INCLUDED |
| Cash management (Finance Hub liquidity) | LIVE | INCLUDED | INCLUDED | INCLUDED | INCLUDED |

Rationale: reconciliation is correctness and is on Basic — unlike FreshBooks
Lite and Wafeq Starter. Live feeds carry a per-connection provider cost
(ASSUMPTION: SAMA-licensed aggregators charge per linked account per month —
terms unknown until the CR exists) and are therefore the Pro line.

### E.5 Tax / compliance — universal

| Feature | Status | Basic | Pro | Advanced | Enterprise |
| --- | --- | --- | --- | --- | --- |
| VAT on every line, VAT return (boxes), VAT summary | LIVE | INCLUDED | INCLUDED | INCLUDED | INCLUDED |
| ZATCA Phase 2 onboarding, document build/sign, QR | LIVE (construction) | INCLUDED | INCLUDED | INCLUDED | INCLUDED |
| ZATCA clearance/reporting submission | 🔴 unverified | INCLUDED when verified | INCLUDED | INCLUDED | INCLUDED |
| ZATCA archive with direct audit link | LIVE (local-fs) | INCLUDED | INCLUDED | INCLUDED | INCLUDED |
| Tax journal entries report | LIVE | INCLUDED | INCLUDED | INCLUDED | INCLUDED |
| Zakat (scope/calendar today; base/computation PLANNED) | LIVE / PLANNED | INCLUDED | INCLUDED | INCLUDED | INCLUDED |
| Withholding tax | PLANNED | NOT AVAILABLE | INCLUDED | INCLUDED | INCLUDED |

Rationale: **never gate compliance.** A Basic customer who cannot submit to
ZATCA is a customer whose product is illegal to use for invoicing — Qoyod's
"Phase 2 excluded on Basic" is exactly the design this document refuses.
WHT is a specific obligation (payments to non-residents) — a Pro feature by
audience, not by compliance.

### E.6 Reporting

| Feature | Status | Basic | Pro | Advanced | Enterprise |
| --- | --- | --- | --- | --- | --- |
| Standard reports (all `/reports/*`) | LIVE | INCLUDED | INCLUDED | INCLUDED | INCLUDED |
| Analytics (trend, receivables bridge, cash reconciliation, decomposition) | LIVE | NOT AVAILABLE | INCLUDED | INCLUDED | INCLUDED |
| Finance Hub (liquidity, tax compliance, books status) | LIVE | INCLUDED | INCLUDED | INCLUDED | INCLUDED |
| Custom reports | PLANNED | NOT AVAILABLE | NOT AVAILABLE | INCLUDED | INCLUDED |
| Scheduled reports | PLANNED | NOT AVAILABLE | INCLUDED | INCLUDED | INCLUDED |
| Consolidated multi-company reporting | PLANNED | NOT AVAILABLE | NOT AVAILABLE | INCLUDED | INCLUDED |
| Export (PDF today; data export PDPL-held) | LIVE / PLANNED | INCLUDED | INCLUDED | INCLUDED | INCLUDED |

Rationale: **export is never gated** — a customer's right to leave with their
books is the downgrade-safety principle (§J) and, once the PDPL answer lands,
probably a legal one.

### E.7 Automation

| Feature | Status | Basic | Pro | Advanced | Enterprise |
| --- | --- | --- | --- | --- | --- |
| Approval workflow (draft / submit / approve / send-back / reject) | LIVE | INCLUDED | INCLUDED | INCLUDED | INCLUDED |
| Approvals worklist | LIVE | INCLUDED | INCLUDED | INCLUDED | INCLUDED |
| Recurring documents (drafts) | LIVE | LIMITED | INCLUDED | INCLUDED | INCLUDED |
| Recurring journal entries | PLANNED | NOT AVAILABLE | INCLUDED | INCLUDED | INCLUDED |
| Deterministic categorization rules | LIVE | INCLUDED | INCLUDED | INCLUDED | INCLUDED |
| Findings engine (scheduled) + acknowledge | LIVE | INCLUDED | INCLUDED | INCLUDED | INCLUDED |
| Alerts / notifications (webhook, email) | code done, unwired | INCLUDED when wired | INCLUDED | INCLUDED | INCLUDED |
| Multi-step / role-routed approval rules | PLANNED | NOT AVAILABLE | NOT AVAILABLE | INCLUDED | INCLUDED |

Rationale: the approval engine is how the platform keeps drafts out of the
books — on every plan (a Basic user with two seats still needs "enter" and
"approve" to be separable). Custom routing is the Advanced layer.

### E.8 Assets / payroll / inventory

| Feature | Status | Basic | Pro | Advanced | Enterprise |
| --- | --- | --- | --- | --- | --- |
| Fixed assets, straight-line depreciation, asset schedule | LIVE | LIMITED (10 assets) | INCLUDED | INCLUDED | INCLUDED |
| Asset disposal | not found in routes — treat as PLANNED | — | INCLUDED | INCLUDED | INCLUDED |
| Employees, payroll runs (journal, approval) | LIVE | NOT AVAILABLE | LIMITED (10 employees) | INCLUDED | INCLUDED |
| Products (no cost) | LIVE | INCLUDED | INCLUDED | INCLUDED | INCLUDED |
| Inventory, stock movements, COGS, valuation | PLANNED (Block E) | NOT AVAILABLE | ADD-ON | INCLUDED | INCLUDED |

Rationale: Qoyod gates fixed assets to Advanced and Zoho to Premium; a
10-asset allowance on Basic (a laptop, a car, a fit-out) keeps the balance
sheet honest for a micro business without giving away the register. Payroll
is a Pro audience (a solo business has no payroll). Inventory is PLANNED and
priced as a Pro add-on / Advanced inclusion **when it exists**.

### E.9 Integrations

| Feature | Status | Basic | Pro | Advanced | Enterprise |
| --- | --- | --- | --- | --- | --- |
| Public API (keys, scoped, rate-limited) | PLANNED (no API-key auth exists) | NOT AVAILABLE | LIMITED (read-only) | INCLUDED (read + write, rate-limited) | INCLUDED (higher limits) |
| Webhooks | PLANNED | NOT AVAILABLE | NOT AVAILABLE | INCLUDED | INCLUDED |
| Payment gateways (MyFatoorah, SiFi) | PLANNED, CR-gated | INCLUDED | INCLUDED | INCLUDED | INCLUDED |
| Bank connectivity (A2) | PLANNED, CR-gated | NOT AVAILABLE | INCLUDED | INCLUDED | INCLUDED |
| Email delivery | waits on B1 | INCLUDED | INCLUDED | INCLUDED | INCLUDED |
| Custom integrations / dedicated connectors | — | — | — | — | ENTERPRISE |

### E.10 Migration

| Feature | Status | Basic | Pro | Advanced | Enterprise |
| --- | --- | --- | --- | --- | --- |
| Self-service migration workspace (CoA mapping, parties, open items, advances, opening position, validate/commit/reverse) | IN DEV (API; no UI) | INCLUDED | INCLUDED | INCLUDED | INCLUDED |
| Spreadsheet CoA import | PLANNED | INCLUDED | INCLUDED | INCLUDED | INCLUDED |
| Assisted migration (a person does it with you) | service | ADD-ON | ADD-ON (one included on annual) | INCLUDED (one company) | INCLUDED |
| White-glove migration (multi-company, history, reconciliation sign-off) | service | not offered | ADD-ON | ADD-ON | INCLUDED |

Rationale (§L): migration is acquisition. The workspace is never gated.

### E.11 AI (every row: INCLUDED-WHEN-ENABLED; see §K)

| Feature | Status | Basic | Pro | Advanced | Enterprise |
| --- | --- | --- | --- | --- | --- |
| Categorization second opinion (background) | LIVE, dark | INCLUDED (fair use) | INCLUDED | INCLUDED | INCLUDED |
| Findings explanations (background) | LIVE, dark | INCLUDED (fair use) | INCLUDED | INCLUDED | INCLUDED |
| AI assistant — grounded questions over your books | LIVE, dark | LIMITED (50/mo) | LIMITED (150/mo) | LIMITED (400/mo) | custom pool |
| AI document reading (vision, beyond QR + OCR) | harness only | LIMITED (75/mo) | LIMITED (300/mo) | LIMITED (1,000/mo) | custom pool |
| AI reconciliation suggestions | PLANNED | INCLUDED (fair use) | INCLUDED | INCLUDED | INCLUDED |
| Monthly AI insight brief | PLANNED | NOT AVAILABLE | INCLUDED | INCLUDED | INCLUDED |
| AI forecasting | NOT SPECCED | — | — | — | — |
| Additional AI capacity | — | ADD-ON | ADD-ON | ADD-ON | custom |

### E.12 Platform, security, support

| Feature | Status | Basic | Pro | Advanced | Enterprise |
| --- | --- | --- | --- | --- | --- |
| Roles (admin / accountant / bookkeeper / viewer) | LIVE | INCLUDED | INCLUDED | INCLUDED | INCLUDED |
| Invitations | LIVE | INCLUDED | INCLUDED | INCLUDED | INCLUDED |
| 2FA | PLANNED | INCLUDED | INCLUDED | INCLUDED | INCLUDED |
| SSO (SAML/OIDC) | PLANNED | NOT AVAILABLE | NOT AVAILABLE | ADD-ON | INCLUDED |
| Session management, IP restrictions | PLANNED | NOT AVAILABLE | NOT AVAILABLE | INCLUDED | INCLUDED |
| Accountant-firm practice tools (§M) | PLANNED | — | — | via Partner programme | INCLUDED |
| Support | — | email, next business day | email + chat, same business day | priority, named onboarding | dedicated, SLA |
| SLA | — | none | none | 99.5% (target, not contractual) | contractual, custom |
| Data residency attestations, security questionnaire, DPA | — | standard | standard | standard | ENTERPRISE (custom paper) |

2FA is security, not a tier — on every plan when built.

---

## F. Usage limits matrix

Every limit answers five questions: **why it exists · what value it
represents · what cost it represents · why at that plan · what happens at
the limit.** Enforcement mechanics are in §T and §U; the principle is
**limits apply to CREATION, never to EXISTENCE** — nothing already in the
books is ever restricted by a limit.

| Limit | Basic | Pro | Advanced | Enterprise | Why it exists / value / cost / plan fit / at the limit |
| --- | ---: | ---: | ---: | ---: | --- |
| **Users** (active seats; `viewer` seats count; the one free `accountant` seat per company does not) | 2 | 5 | 15 | custom | *Why:* the market's primary segmentation axis (every competitor). *Value:* who can work in the books. *Cost:* negligible directly; support load scales with seats. *Fit:* solo+accountant / a small team / a finance function. *At limit:* inviting a new member is refused with `plan_limit_users` naming the add-on price; existing members untouched. |
| **Companies** (legal entities per organisation) | 1 | 1 (+2 add-on) | 3 (+ add-on) | custom | *Why:* a second CR is a second set of statutory books. *Value:* pooled group accounting. *Cost:* per-company data, ZATCA credential, PDF rendering, support. *Fit:* groups are Advanced's audience. *At limit:* creating a company is refused with `plan_limit_companies`; existing companies untouched. |
| **Sales documents issued** (invoices + credit notes + debit notes **approved**, per subscription year) | 1,200 | 12,000 | 60,000 | custom | *Why:* the honest proxy for business size — a business approving 100 invoices a month is not a micro business. *Value:* invoicing capacity. *Cost:* DB rows, PDF rendering (Chromium), archive storage, ZATCA outbox. *Fit:* Basic ≈ 100/mo; Pro ≈ 1,000/mo; Advanced ≈ 5,000/mo — above Zoho's Standard/Professional/Elite caps at each tier. *At limit:* **soft** — a 30-day grace window with in-app notice at 80/100%; after grace, creating a NEW draft invoice is refused with `plan_limit_sales_documents`; **approving an existing draft, issuing a credit note against an existing invoice, recording a payment, and posting a correcting journal are NEVER refused** (§T). Quotations do not count. |
| **Purchase documents** (bills approved, per year) | 1,200 | 12,000 | 60,000 | custom | same shape as sales documents; captures that become bills count once. |
| **Bank accounts** | 2 | 6 | unlimited | unlimited | *Why:* D-3 makes each bank a GL account; a business's bank count tracks its size. *Cost:* none material. *Fit:* Basic: one operating + one savings. *At limit:* creating a bank account is refused; existing accounts remain fully usable **including as the bank a new payment names** (refusing that would break D-3's fail-closed cash rule). |
| **Statement lines imported** | fair use (guide: 5,000/yr) | fair use (25,000/yr) | fair use | custom | *Why:* only as an abuse guard. *Cost:* rows + categorization calls. *At limit:* no enforcement below 3× the guide; above it, an operator conversation, never a refusal mid-import. |
| **Document captures** (uploads through A1; QR/OCR — not AI) | 100/mo | 500/mo | 2,500/mo | custom | *Why:* storage and scanning cost; the vision AI tail is separately limited (§K). *At limit:* new uploads refused with `plan_limit_captures`; existing captures readable; the bill can still be entered by hand. |
| **Storage** (captures + archive + logos) | 2 GB | 10 GB | 50 GB | custom | *Why:* object-storage cost; the ZATCA archive is never counted (it is a legal obligation, not a customer choice). *At limit:* uploads refused; **nothing is ever deleted** (ZATCA §5.5; `ArchiveStore` has no `delete`). |
| **Fixed assets** | 10 | unlimited | unlimited | unlimited | *Why:* a register is a Pro feature; 10 keeps a micro balance sheet honest. *At limit:* creating an asset refused; depreciation on existing assets continues. |
| **Employees on payroll** | n/a | 10 | unlimited | unlimited | *At limit:* adding an employee refused; existing payroll runs continue. |
| **Recurring schedules** | 5 | unlimited | unlimited | unlimited | *At limit:* new schedules refused; existing continue producing drafts. |
| **API requests** (when built) | n/a | 1,000/day read | 20,000/day | custom | *Why:* compute. *At limit:* 429 with reset header, never data loss. |
| **AI questions / documents / background** | §K | §K | §K | §K | see §K.10 for exhaustion behaviour |

**Deliberately NOT limited on any plan:** customers, suppliers, products,
journal entries, transactions accepted, payments, reports run, PDF renders of
existing documents, audit-trail reads, closed-month operations, exports. Each
of these is either correctness or a cost too small to be worth a customer's
confusion (the "avoid nickel-and-diming" rule).

---

## G. Add-on matrix

| Add-on | Price (SAR, ex-VAT) | Available on | Status | Notes |
| --- | --- | --- | --- | --- |
| Additional user | 20/mo · 200/yr | all | — | seat-based; viewer seats count; removing a seat is immediate |
| Additional company | 99/mo · 990/yr | Pro (max +2), Advanced | — | includes its own ZATCA onboarding and the same document allowance as the plan |
| AI Boost pack (+100 questions, +200 documents / mo) | 49/mo | all (when AI enabled) | when enabled | stackable ×3; §K.9 |
| AI overage (pay-as-you-go, opt-in, capped) | 0.10 / question · 0.25 / document | Pro, Advanced | when enabled | off by default; admin sets a monthly cap; §K.9 |
| Inventory module | 79/mo | Pro (included on Advanced) | PLANNED | priced only when Block E lands |
| Live bank feed connection | provider-dependent; placeholder 15/mo per linked account | Pro, Advanced (included allowance: 2 / 6) | PLANNED, CR-gated | `UNVERIFIED` until a SAMA-licensed provider quotes |
| Assisted migration (one company) | 1,500 one-off | Basic, Pro | service | one included on Pro annual and above |
| White-glove migration | from 4,000 one-off | Pro, Advanced | service | multi-company, history, reconciliation sign-off; scoped quote |
| SSO | 199/mo | Advanced | PLANNED | included on Enterprise |
| Priority support | 99/mo | Pro | — | Advanced includes it |
| Extra storage | 19/mo per 10 GB | all | — | never triggers deletion |

---

## H. Enterprise matrix

| Capability | Enterprise only? | Notes |
| --- | --- | --- |
| Custom user / company counts, pooled AI capacity | yes | quoted |
| Contractual SLA, uptime credits | yes | Advanced has a target, not a contract |
| Dedicated support, named CSM, onboarding programme | yes | |
| Security questionnaire, DPA, residency attestations, audit support | yes | needs C3/C6 closed first — **do not sign an Enterprise contract before the KMS and hosting decisions exist** |
| SSO included; SCIM (PLANNED) | yes | SSO is an Advanced add-on |
| Custom integrations / connectors | yes | |
| Custom approval routing, custom roles (PLANNED) | yes | the permission matrix is data (`permissions` table) — custom roles are a re-seed, not a build |
| White-glove migration included | yes | |
| Annual invoicing, PO-based procurement, off-platform invoice for customer #1 | yes | CLAUDE.md §5 R1: "for customer #1 an off-platform invoice suffices" |
| Multi-region archive, dedicated KMS key policy | yes | deployment-time (C3) |
| Minimum contract | 12 months, from SAR 23,988/yr | STRATEGIC RECOMMENDATION — the floor is what a dedicated onboarding costs to deliver |

---

## I. Upgrade triggers

Derived from the matrices, not assumed. Each trigger names the moment and the
in-product signal.

| From → to | Trigger | Signal the product can show |
| --- | --- | --- |
| **Trial → Basic** | verification approved; first invoice approved | "Your first invoice is issued — choose a plan to keep issuing after day 14" |
| **Basic → Pro** | third user needed (accountant + owner + bookkeeper); >100 invoices/month; a third bank account; purchase orders; budgets / analytics; payroll; >5 recurring schedules; the first AI question after 50; the accountant asks for analytics | at 80% of any limit, the notice names the plan that removes it |
| **Pro → Advanced** | second/third company (cheaper pooled than 2× add-on at the third company); >5 users (at 10 seats Pro + seats is 299 vs Advanced 449; at 15 seats 399 vs 449; only at 18 seats does Pro + seats cost more — **the company count, not the seat count, is the economic trigger**); write API; custom reports; multi-currency; >1,000 invoices/month; SSO; AI beyond 150 questions or 300 documents/month | company creation refused on Pro at +2; API write requested |
| **Advanced → Enterprise** | contractual SLA; DPA / security paper; >15 users AND >5 companies; SSO/SCIM at scale; custom integrations; pooled AI beyond 3 boost packs; procurement requires an annual PO | sales conversation, not an in-app wall |

The seat arithmetic above is a CALCULATION and it is honest: Pro + seats
stays cheaper than Advanced until ~17 seats, so seats alone will not push a
customer up — **companies, API and AI capacity are Advanced's real triggers**,
and that is by design (a bigger team is not a bigger cost to serve; a second
legal entity is).

---

## J. Downgrade behaviour

**Principle: never delete, never corrupt, never lock the customer out of
what they already recorded.** A downgrade is a change of what can be CREATED
from its effective date, plus a customer-chosen reduction of ACTIVE seats and
companies with a grace period. Existing accounting data is always readable,
always exportable, always correctable.

| Situation | Behaviour |
| --- | --- |
| Effective date | at the end of the current billing period (annual: at renewal; monthly: next cycle). Immediate downgrade on request is allowed with no refund of the unused period (STRATEGIC RECOMMENDATION — keep it simple). |
| Users above the new limit | the admin chooses which seats stay active before the effective date; if they do not, the platform deactivates the **most recently added** non-admin seats (never the last `admin`, never the free accountant seat) and says so. Deactivated users keep their audit-trail identity; reactivation is one click if a seat is bought. **30-day grace** after the effective date before any deactivation. |
| Companies above the new limit | the admin chooses which stay active; the others become **read-only** (`company_readonly_plan`): every report, statement, PDF, export and the audit trail work; creating or approving any document, posting, paying or importing is refused with the structured code naming the plan. Nothing is archived away. **30-day grace.** The ZATCA outbox for a read-only company **still drains** (a document already approved must still be reported — compliance is not a plan feature). |
| Bank accounts above the new limit | **nothing happens.** Limits apply to creation; the existing accounts remain usable for payments and imports (refusing a bank that cash lines must name would violate D-3's fail-closed rule). |
| Sales/purchase documents above the new annual allowance | the counter is re-based to the new plan; if already above it, the customer is in the soft-cap state (§F) with its grace and its never-refused corrections. |
| Fixed assets / employees / recurring schedules above the limit | nothing is deleted; depreciation, payroll and recurring continue for what exists; adding more is refused. |
| Storage above the limit | uploads refused; nothing deleted; the notice names the storage add-on. |
| Features not on the new plan (analytics, budgets, POs, API, custom reports) | the pages show the plan-gate state with the data preserved; a PO already approved is still readable and still convertible to a bill (the conversion is a purchasing act on an existing document — allowed); budgets are readable, not editable. |
| AI | the allowance re-bases at the next period; nothing about past AI output changes; background AI continues within the new plan's fair use. |
| Add-ons | seat and company add-ons can be reduced at any time; reductions apply the same rule as above (customer chooses, grace, then most-recent-first). |
| Cancellation | the organisation enters `read_only_cancelled` for **90 days** (readable, exportable, ZATCA outbox drains, no creation) then `dormant` — data retained per the retention policy the PDPL answer (C8) sets; **never deleted by a billing event**. |
| Grandfathered price | a downgrade from a grandfathered plan version leaves the grandfathered version (§U.6); re-upgrading returns to the CURRENT version and price, and the UI says so before the customer confirms. |

---

## K. Saudi Ledger AI Packaging

**Commercial model (owner-stated, adopted):**
`Subscription plan → included AI allowance (organisation-level) → organisation usage → AI consumption`.
Customers buy **Saudi Ledger AI capability**; they never bring a key, never see
a provider name on an invoice, and their entitlement does not change when the
provider does.

### K.1 Recommended AI allowance per plan

Derived from the workflows' measured token shapes and the usage distributions
in the companion (§2–§3 there). Two classes:

- **Background AI** — runs without a user asking: categorization second
  opinion (only on rows the deterministic engine scores < 0.65), findings
  explanations (≤ 25/run, content-hash de-duplicated), reconciliation
  suggestions (PLANNED). Cost per organisation-month at P95 on Groq: **under
  SAR 1 on Basic, under SAR 2 on Pro, under SAR 5 on Advanced** (CALCULATION).
  **Included under fair use on every plan and NOT shown as a counter** — a
  meter on something that costs halalas and that the user did not click makes
  the product feel taxed for no revenue.
- **Requested AI** — the user clicks: **questions** (`/ask`, grounded answers)
  and **documents** (vision reading of a receipt the QR/OCR path could not
  read). These are the two visible allowances.

| Plan | Questions / month | Documents / month | Internal AI Units (§K.12) the allowance represents | Provider cost of the FULL allowance on Groq today (CALCULATION) | Token-equivalent of the full allowance (for the owner's reference only) |
| --- | ---: | ---: | ---: | ---: | ---: |
| Basic — "AI Essentials" | 50 | 75 | ≈ 3,900 | ≈ $0.30 / SAR 1.1 | ≈ 0.4M tokens |
| Pro — "AI Assistant" | 150 | 300 | ≈ 15,000 | ≈ $1.16 / SAR 4.4 | ≈ 1.4M tokens |
| Advanced — "AI Assistant Plus" | 400 | 1,000 | ≈ 49,000 | ≈ $3.79 / SAR 14.2 | ≈ 4.4M tokens |
| Enterprise | pooled, custom | pooled, custom | — | — | — |

**Why not the placeholder 30M / 100M / 300M tokens:** the actual workflows
consume **0.16M tokens/month at a Basic P50 and 1.3M at its P95; 3.6M at a Pro
P95; 11M at an Advanced P95** (CALCULATION, companion §3). The placeholders are
20–60× above any real consumption, so as a *limit* they would never be reached
and as a *number shown to a customer* they would describe nothing the customer
can picture — the "does the number shown describe the set the user thinks it
describes" rule. The allowances above are set at roughly **P90 of each plan's
expected population**, so ~10% of organisations see the notice and ~5% buy a
boost or upgrade — which is what an allowance is for.

If the owner wants a *headline* token figure on the pricing page anyway, the
honest conversions are **≈1M / 3M / 10M "AI tokens" per month** (allowance
plus background fair use, rounded up) — and §K.13 explains why this document
recommends against showing tokens at all.

### K.2 Organisation-level, not per user

The allowance attaches to the **organisation subscription** (one pool per
organisation, shared by all companies and users). Adding a seat does not add
AI. Per-user limits exist only as abuse controls (§K.11). Rationale: AI
consumption is driven by the *books* (documents, transactions, findings), not
by head-count; a 5-user Pro org and a 2-user Pro org with the same ledger
consume the same. Multi-company organisations on Advanced share one pool
(`ai_usage.company_id` already records attribution per company, and is NULL
for org-wide scheduled work — the pool is the org, the attribution is the
company).

### K.3 AI features per plan

| Feature | Basic | Pro | Advanced | Enterprise |
| --- | --- | --- | --- | --- |
| Categorization second opinion (background) | included | included | included | included |
| Findings explanations (background) | included | included | included | included |
| Reconciliation suggestions (PLANNED, background) | included | included | included | included |
| Grounded questions | 50/mo | 150/mo | 400/mo | pooled |
| Document reading (vision) | 75/mo | 300/mo | 1,000/mo | pooled |
| Monthly insight brief (PLANNED) | — | included | included | included |
| Model tier for questions | standard | standard | standard | standard (the same model — a "smarter model on a higher plan" is a promise the Arabic gate does not yet let us make) |
| Boost packs / overage | boost only | boost + overage | boost + overage | custom |

### K.4 Expected consumption by workflow (which is expensive, which is not)

From the companion §1 (per-operation cost on Groq's verified price card):

| Workflow | Model | Tokens/op | USD/op | Class |
| --- | --- | ---: | ---: | --- |
| Categorization second opinion | gpt-oss-20b | ~860 | $0.00008 | **cheap** — 12,800 per dollar |
| Reconciliation suggestion (PLANNED) | gpt-oss-20b | ~1,080 | $0.0001 | cheap |
| Findings explanation (+ judge) | gpt-oss-120b | ~2,550 | $0.0005 | cheap |
| Grounded question (+ judge) | gpt-oss-120b | ~4,060 | $0.0008 | **moderate** — the judge call is a third of it |
| Monthly insight brief (PLANNED) | gpt-oss-120b | ~6,800 | $0.0014 | moderate |
| Document reading (vision) | qwen3.8-27b (preview) | ~2,750 (2,048 per image) | **$0.0035** | **expensive** — 45× a categorization; the only workflow whose price card is 5–10× the text models' |

**The finding:** document vision is the entire AI cost story. Everything else
is background noise at these prices. That is why documents are the second
visible allowance, why the QR path (which sends nothing to any model) and
Tesseract (free, in-process) stay in front of it, and why the vision model
decision (Groq Enterprise + Dammam, or a Saudi provider) is where the AI
economics will actually be decided.

### K.5 P50 / P75 / P90 / P95 usage

Monthly AI cost per organisation (CALCULATION, Groq price card, companion §3):

| Plan | P50 | P75 | P90 | P95 | Heavy / abusive |
| --- | ---: | ---: | ---: | ---: | ---: |
| Basic | $0.06 (SAR 0.21) | $0.13 | $0.29 | $0.56 | $1.91 (SAR 7.2) |
| Pro | $0.19 (SAR 0.72) | $0.45 | $1.07 | $1.76 | $6.88 (SAR 25.8) |
| Advanced | $0.66 (SAR 2.46) | $1.65 | $3.66 | $6.18 | $21.81 (SAR 81.8) |

The usage counts behind each percentile are ASSUMPTIONS (companion §3, table
"usage distributions") and are the first thing to replace with `ai_usage`
data once the boundary flips.

### K.6 Heavy-user economics

A "heavy" organisation (the last column) is defined as ~10× the P50 counts:
400–4,000 questions and 400–5,000 documents a month. Even that consumes
**2–5% of the plan's ARPU** on Groq's price card. The allowance is therefore
not a margin defence at today's prices — it is (a) a defence against the
*future* provider price (a ×10 per-token sovereign premium turns the heavy
Advanced org into SAR 800/month of cost, which is 2× its ARPU — companion
§6), and (b) the segmentation lever that makes Advanced worth more than Pro.
Both reasons hold regardless of which provider is in place — which is the
provider-independence requirement.

### K.7 AI COGS per organisation

At the recommended allowances, the **maximum** AI cost a plan can incur
without a boost pack is the allowance fully consumed plus background fair use
at P95: **Basic ≈ $0.4, Pro ≈ $1.3, Advanced ≈ $4.3** per month
(CALCULATION: $0.30 + $0.08, $1.16 + $0.18, $3.79 + $0.50) — under 4% of ARPU
on every plan. Expected (P75) is $0.13 / $0.45 / $1.65.

### K.8 Gross margin impact

From the companion §5: AI at P50 is **0.2–0.6% of ARPU**; at P95 it is
2.4–5.7%. The margin model is dominated by infrastructure (5–13% of ARPU at
300 organisations, highest on Basic) and cost-to-serve (8–14%). **Under a fixed-commitment or
dedicated-replica provider contract the picture inverts** (companion §6):
the AI line becomes a fixed cost divided by customer count, and at fewer than
~500 organisations it is the largest COGS line by far.

### K.9 AI add-on strategy

- **AI Boost pack — SAR 49/month, +100 questions and +200 documents**,
  stackable up to three. Provider cost of a fully consumed pack ≈ $0.77
  (SAR 2.9) → ~94% margin; priced at what a customer will pay for "more AI",
  not at cost-plus.
- **Overage, opt-in, capped — SAR 0.10/question, SAR 0.25/document**, only
  on Pro and Advanced, off by default, with an admin-set monthly cap and an
  80% notice. Cost per document is SAR 0.013 → the price is ~95% margin and
  still far below paid OCR vendors' per-page prices (SOURCE-DERIVED
  OBSERVATION: paid document-AI providers price per page in the
  $0.01–0.10 range; not verified for this document).
- **Enterprise pooled capacity** — a negotiated pool sized from the customer's
  `ai_usage` history, with a fixed price; the only place where a token figure
  may reasonably appear, and then internally.
- **No AI-only plan** and **no per-seat AI** — both would contradict the
  organisation-level model.

### K.10 AI exhaustion behaviour

| Threshold | Behaviour | Where it is enforced |
| --- | --- | --- |
| 80% of questions or documents | in-app notice to admins; email when B1 exists | entitlement resolver (§U) |
| 100% of questions | `/ask` refuses with `ai_allowance_exhausted` naming the reset date, the boost pack and the upgrade; **the deterministic answer path (analytics, reports) is unchanged** | `metered.ts` seam, BEFORE the provider call |
| 100% of documents | the vision tail is skipped; the capture still goes through QR + Tesseract and lands in scan-review with a notice "AI reading is paused until <date>"; the bill can be completed by hand | the A1 pipeline's vision step, BEFORE the call |
| Background fair use exceeded (3× the plan's guide) | categorization falls back to deterministic (its declared degradation); explanations are skipped for the rest of the day (findings still run); an operator alert fires — this is an abuse signal, not a sales one | `metered.ts` + the findings run's existing cap |
| Grace | one **temporary grace allowance** per subscription year: +25% of the monthly allowance, automatically applied the first time a limit is hit, with a notice. Second time: no grace. | resolver |
| Hard stop | requested AI only. **Never** the ledger, never a posting, never a compliance transmission, never an export. | by construction: AI calls are made *before* any write in every current caller, and every caller already handles `AiUnavailableError` |

**The accounting-safety proof (FACT about the code):** every metered call
today is wrapped so that failure is a first-class outcome — the categorizer
returns the deterministic result, `/ask` returns a refusal, explanations are
skipped and the finding stands. Exhaustion is implemented as *one more reason
the seam throws*, so it cannot introduce a partial state that provider outage
could not already introduce — and outage was designed for (design-ai-layer
§8). **The entitlement check must live in `services/ai/metered.ts`, the one
seam every call already passes through, and nowhere else.**

### K.11 Abuse and rate-limit strategy

| Control | Setting (STRATEGIC RECOMMENDATION) | Purpose |
| --- | --- | --- |
| Per-user rate limit | 10 questions/min, 60/hour; 30 document reads/hour | stops a script on one seat |
| Per-organisation daily cap | 3 × (monthly allowance ÷ 30) for each requested class | bounds a bad month to ~3× |
| Concurrency | 2 in-flight model calls per user, 5 per organisation | protects the provider TPM limit (Groq free tier is 8K TPM per model; paid tiers higher, `UNVERIFIED` exact) |
| Model routing | categorizer + reconciliation + judge on gpt-oss-20b; questions, explanations, brief on gpt-oss-120b; vision on the pinned vision model; **routing is configuration behind the seam, never a plan feature** | cost and the reversibility hedge (design-ai-layer §7) |
| Cheap-model fallback | if the 120b call times out, retry ONCE on 20b with the same prompt and record `model` in `ai_usage` (it already records it) | availability |
| Expensive-model escalation | none for now — the Arabic gate (§2a) does not yet distinguish the two models enough to justify it | |
| Caching | findings explanations are already content-hash de-duplicated (FACT, `findings.explain.service.ts`); grounded answers cache by (company, question-normalised, books-status version) for 24h; Groq prompt caching halves cached input on 120b (FACT, changelog) — system-prompt prefixes should be stable to benefit | cost |
| Context limits | `maxTokens` per operation is already a code fact (200 / 300 / 400); prompt size bounded by the tool-selected data, never raw documents (design §2) | cost + safety |
| Document-size limits | 20 MB per request (Groq vision limit, FACT), 1 image per read, 5 pages → 5 reads | cost |
| Alerts | operator alert on any org at 3× fair use, on provider error rate > 5%, on `ai_usage` daily spend > a configured SAR figure | who finds out |
| Soft cap / hard cap | soft at 80% (notice), grace once, hard at 100% for requested AI only | §K.10 |
| Retries | at most one, never on a 4xx, recorded as a row (`ok=false` rows are already written — the meter must not lie) | cost + honesty |

### K.12 Provider-independent entitlement model

**The customer entitlement is expressed in ACTIONS (questions, documents) and
a fair-use class (background).** Internally, every action maps to **AI Units**
through a *weight table that is configuration*:

```
1 AI Unit    = the reference cost of one categorization second opinion
               (today: ~860 tokens on the cheapest text model ≈ $0.00008)
weights      = { categorize: 1, reconcile: 1, explanation: 6, question: 10, brief: 18, document: 45 }
plan pools   = { Basic: ~3,900 units + fair use, Pro: ~15,000, Advanced: ~49,000 }
```

When the provider changes, **the weight table and the unit's reference cost
change; the customer's "150 questions and 300 documents" does not.** The
entitlement is recorded on the plan as actions; `ai_usage` keeps recording
provider, model and raw tokens per call (it already does); the resolver
converts tokens → units with the weight table in force at the time of the
call. A move from Groq per-token to a fixed Saudi commitment changes the
*cost side* of the unit (the amortised rate design-ai-layer §11 already
defines: (contract cost per month) ÷ (measured monthly units)) — the customer
side is untouched. **This is the property the owner asked for: Groq → SITE →
ELM → another provider is a configuration change to the weight table and the
seam, not a re-pricing.**

### K.13 Recommended customer-facing terminology

| Show | Do not show |
| --- | --- |
| **"AI questions"** — "Ask about your books: 150 questions a month" | tokens, units, credits |
| **"AI document reads"** — "AI reads receipts and invoices the QR code and scanner cannot: 300 a month" | model names, providers |
| **"Included AI"** — "Automatic categorization, reconciliation help and plain-language explanations of findings are included in every plan" (once enabled) | "unlimited" (it is fair use) |
| A usage bar per class in Settings → Plan, with the reset date | a running cost figure |
| **"AI Boost"** for the pack | "overage" as a word on the pricing page (use "pay as you go, capped, off by default" in Settings) |

Arabic terms to fix with the same care as the UI's: أسئلة الذكاء الاصطناعي ·
قراءة المستندات بالذكاء الاصطناعي · الذكاء الاصطناعي المضمَّن. (The
`arabic-sweep` discipline applies to the pricing page.)

**Why actions and not tokens:** a token is a unit of the provider's
economics, and the owner has said the provider will change; the number would
also be meaningless to the buyer (companion §2 shows a question is ~4,000
tokens and a document ~2,750 — the buyer cannot picture either). Why not a
single "credits" pool: it hides that documents are 4–5× a question and forces
the buyer to do arithmetic on the pricing page. Two named actions, plus
"included", is what the buyer can picture and what §K.12 can enforce.

---

## L. Migration pricing

| Option | Recommendation | Reason |
| --- | --- | --- |
| Self-service migration workspace (Batch 1C) | **free on every plan, forever** | it is the acquisition path from Qoyod/Wafeq/Daftra/Excel; it is also the correctness path (opening balances through `postJournalEntry`, R1–R10 gates, reversal) — gating it would make a Basic customer's opening balance sheet worse |
| Limited free assisted migration | one assisted migration (one company, opening trial balance + open items) **included on Pro annual and above**; Basic and Pro monthly buy it | converts the annual commitment; the marginal cost is an accountant-hour, which the annual prepayment funds |
| Paid assisted migration | **SAR 1,500** one-off per company | priced at ~3–4 accountant-hours (ASSUMPTION: SAR 350–500/hour for a qualified Saudi accountant) with margin; low enough not to be a barrier |
| White-glove | **from SAR 4,000**, scoped | multi-company, history, reconciliation sign-off; included on Enterprise |
| Migration as revenue vs acquisition | **acquisition first, revenue second** | migration revenue is bounded (one-off, small); the customer it wins is worth SAR 2,000–5,000 a year for years |

Non-negotiables inherited from the Batch 1C research: historical open items
are *opening accounting items*, never new tax invoices (§14.1 there);
mid-year P&L is carried through opening equity (§14.2); the PIH question with
ZATCA is unresolved — **a migration service must not promise anything about
ZATCA history until it is.**

---

## M. Accounting-firm pricing

**Question:** does a firm need a fifth plan? **Answer: no — it needs a
programme and, later, a workspace.**

| Model | Fit | Notes |
| --- | --- | --- |
| A firm buys Advanced and adds companies | poor | tenant isolation is by ORGANISATION; a firm-owned org holding client companies makes the firm the data owner and breaks the "client can leave with its books" principle (A1 spec §6: what A1 must not foreclose for firms) |
| A dedicated "Accountant" plan | unnecessary | the four roles and invitations already let a firm's staff join a client org as `accountant` (free seat) |
| **Partner programme (recommended)** | good | each client is its own organisation on its own plan; the firm's staff hold the free `accountant` seat (one per company) and buy more seats at the seat price; billing is **either** client-pays at list **or** firm-pays consolidated at a **25% partner discount** (STRATEGIC RECOMMENDATION — QuickBooks and Xero both run wholesale/partner discounts; the exact percentages are not captured here, `UNVERIFIED`); the firm's own organisation (its own books) is a normal subscription |
| Practice workspace (client switcher, consolidated dashboard, bulk operations, cross-client findings) | PLANNED — no code; the org-switching mechanism exists in `resolveTenant`, the dashboard does not | build after 10 partner firms exist, from their asks, not before |

**Where it belongs:** a "For accountants" page beside the pricing page (§R),
not a column in the plan table. **Practice-level billing** is the consolidated
invoice above. **Migration** is the partner's biggest ask and is free
self-service; the partner is the one doing the assisted migration, so the
programme should let a partner *resell* the assisted service.

---

## N. Multi-company pricing

| Model | Complexity | Economics | Verdict |
| --- | --- | --- | --- |
| A — one company per subscription (Qoyod) | lowest | full price per entity; punishes the ordinary Saudi family group | rejected for the second entity on |
| B — companies included by tier | low | Advanced 3 included | **adopted for Advanced** |
| C — base + company add-on (Wafeq's branch add-on shape) | low | SAR 99/company/mo on Pro (max +2) and Advanced | **adopted as the add-on** — Pro + 2 companies = 397 vs Advanced 449 with 3 included, 15 users and the Advanced features: the third company is the natural Advanced trigger (§I) |
| D — firm organisation subscription | medium | see §M | rejected as a plan; adopted as a programme |

Basic has no company add-on: a second CR is, by definition, not a micro
business.

---

## O. Free trial

| Question | Recommendation | Evidence |
| --- | --- | --- |
| Trial or free tier? | **14-day trial of Pro, no card; no permanent free tier** | Wafeq 14 days no card; Zoho 14; QBO 30; FreshBooks 30; Snad 7 + a free tier. A free tier is rejected because (a) Zoho already owns "free with ZATCA excluded", (b) every free organisation is a verification-gate review (L3 — a human cost), (c) a free ledger that cannot submit to ZATCA is a liability magnet, (d) the AI boundary makes any free AI a cost with no revenue path. |
| What the trial includes | all of Pro, AI at the Pro allowance when enabled | let the trial show the tier most people should buy |
| The verification gate | 🔴 **the trial clock must start at verification APPROVAL, not at signup** — today signup lands in `pending_review` and the gate 403s business routes; a 14-day clock that runs during an undefined wait (L3) is a trial that can expire unused | FACT about the gate; the SLA is the owner's open L3 decision |
| Payment requirement | none to start; card or annual invoice to continue | Saudi norm |
| Conversion mechanism | in-product: "your first invoice is issued — choose a plan"; email once B1 exists; the pricing page reachable from the plan banner | |
| Trial end | organisation enters `trial_expired`: **read-only, exportable, ZATCA outbox drains**, 30 days, then `dormant`; nothing deleted | §J |
| Sandbox company | a demo company with seeded data, separate from the customer's real company, removed on conversion | the pilot package's approach |

---

## P. Annual billing

| | Basic | Pro | Advanced |
| --- | ---: | ---: | ---: |
| Monthly | 99 | 199 | 449 |
| Annual | 990 | 1,990 | 4,490 |
| Effective monthly | 82.50 | 165.83 | 374.17 |
| Discount | 16.7% ("12 for 10") | 16.7% | 16.7% |

**Why 16.7%:** it is the Saudi norm (Wafeq, Snad, Qoyod's monthly = annual/10);
Zoho KSA is 13–25% by tier; global vendors discount the first months instead.
A larger discount buys little (annual adoption is driven by the accountant's
habit of paying once a year — ASSUMPTION), a smaller one reads as stingy
against the norm.

**Cash flow (CALCULATION):** at 60% annual adoption, 100 customers on the
Balanced mix (50/35/15) prepay ≈ SAR 112k in month one (30 × 990 + 21 × 1,990
+ 9 × 4,490) while the other 40 bill ≈ SAR 7.5k/month — the prepayment
alone covers the modelled platform floor (~$900/month ≈ SAR 3.4k, companion
§4) for over two years.

**Churn (SOURCE-DERIVED OBSERVATION, not measured here):** annual plans defer
the churn decision to renewal; the risk is that the renewal moment is also
where a price change or a grandfathering rule bites (§U.6). The sensitivity
grid (companion §6) shows annual adoption between 20% and 90% moves gross
margin by ±1.5 points — it is a cash-flow lever, not a margin lever.

---

## Q. Value propositions

**Every sentence here is about LIVE functionality**, with AI phrased as "when
enabled". Copy is a starting point, not final.

- **Basic — "Your books, done right, in Arabic."** A complete double-entry
  ledger with VAT built into every line, invoices with the ZATCA QR and Hijri
  dates, bills, a bank statement import with a review queue, and the financial
  statements your accountant expects — all with an audit trail and closed
  months. One free seat for your accountant.
- **Pro — "The accountant's plan."** Everything in Basic, plus quotations and
  purchase orders with approvals, payroll journals, fixed assets, budgets,
  analytics that show *where* cash went, five users, six bank accounts, and
  the migration workspace to bring your history from your previous system.
  With AI enabled: ask questions about your own books and get answers
  grounded in your ledger, with the figures shown.
- **Advanced — "One platform for the group."** Three companies pooled under
  one subscription, fifteen users, unlimited bank accounts, API access, custom
  reports, priority support, and the largest AI allowance.
- **Enterprise — "Your terms."** Contractual SLA, dedicated support, security
  paper, SSO, custom integrations, white-glove migration.

Not claimed anywhere: live bank feeds, inventory, Zakat computation,
forecasting, multi-currency, production ZATCA submission (until M12.9), any AI
capability while the boundary is closed.

---

## R. Pricing page architecture

1. **Header:** "Simple pricing, in riyals, ex-VAT." Monthly / annual toggle
   (annual default; shows "save 2 months").
2. **Three plan cards** (Basic / Pro / Advanced) + an **Enterprise card**
   ("Talk to us"). Each card: price, "for whom", users included, companies
   included, five headline features, the AI line **only when enabled** ("AI
   questions 150/mo · AI document reads 300/mo"), the CTA ("Start 14-day trial"
   / "Contact sales").
3. **"Included in every plan"** strip: double-entry ledger, VAT return, ZATCA
   e-invoicing, Arabic & English, audit trail, closed months, bank
   reconciliation, migration workspace, free accountant seat, export.
4. **Compare plans** (collapsible full matrix — §E condensed to ~30 rows).
5. **Add-ons** (seats, companies, AI Boost, storage, assisted migration).
6. **"How usage works"** — three sentences: limits apply to what you create,
   never to what you already recorded; you get a notice at 80% and a month's
   grace; corrections, payments and compliance are never blocked.
7. **Migration** — "Moving from Qoyod, Wafeq, Daftra or Excel? The workspace
   is free; assisted migration from SAR 1,500; included on Pro annual."
8. **For accountants** — link to the partner programme page (§M).
9. **FAQ** — VAT on the price; what happens when I downgrade; can I export; is
   my data in Saudi Arabia (answer honestly per C6); what counts as a user; do
   AI reads cost extra; what happens to AI when I hit the limit.
10. **Enterprise contact** form.

Keep the page to one screen of cards and one collapsible matrix. No token
figures, no provider names, no PLANNED features.

---

## S. Four separate questions

Pricing must never override an accounting control, and the four questions
must stay in four places:

| Question | Owner | Where it lives today | Where it will live |
| --- | --- | --- | --- |
| **Subscription entitlement** — may this ORGANISATION use this feature? | the plan | nowhere (R1) | the entitlement resolver (§U), checked in a middleware **after** `resolveTenant` and **before** `requirePermission` |
| **Usage entitlement** — has the organisation exceeded its allowance? | the plan + `usage` | nowhere; `ai_usage` records but nothing reads it for enforcement | the same resolver, evaluated at the CREATION boundary in the service layer (not the route — the route cannot see whether this create is a correction) and in `metered.ts` for AI |
| **User permission** — may this USER do this action? | the org membership role | `requirePermission` + the `permissions` table (FACT) | unchanged |
| **Accounting / business control** — is the accounting state valid for this act? | the accounting core | period locks, approval states, balance checks, D-3 bank requirement, the migration gates (FACT) | unchanged, and **always evaluated last and never bypassed** |

Order of evaluation for a write: authenticated → verification gate → tenant
resolved → **plan says the feature exists for this org** → **plan says the
allowance permits a creation (or this is an exempt correction)** → **the
user's role permits the action** → **the accounting core permits the state
change**. An Enterprise customer with every feature enabled still cannot have
a `bookkeeper` approve an invoice, and nobody on any plan can post into a
closed month. Conversely, a plan limit can never *force* a state change —
there is no "auto-archive on downgrade" of anything with a balance.

---

## T. Accounting safety under enforcement

Rules the entitlement layer must obey, each mapped to the code invariant it
protects:

1. **Enforce at the creation boundary in the service, before any write.** A
   quota check inside `postJournalEntry` or inside a transaction that has
   already inserted rows would create the partial-journal case the brief
   forbids. The check is the first statement of `create*` in the service —
   the same place the D-3 `bank_account_required` refusal lives.
2. **Corrections are exempt by construction, not by exception list:** credit
   notes against existing invoices, payments, allocations/unallocations,
   refunds, reversals, correcting journals, period-lock operations, migration
   reversals. The exemption is expressed as *which service methods carry the
   quota check* (only `create` of a new primary document), so a future path
   cannot forget to exempt itself — there is nothing to forget.
3. **Compliance is never gated:** the ZATCA outbox drains for read-only and
   cancelled organisations; certificate renewal reminders keep firing; the
   archive keeps its direct link.
4. **Reads are never gated** (reports, statements, PDFs, audit trail, export).
5. **Nothing is deleted by a billing state**, ever. Dormancy is a state, not a
   purge; purge is a PDPL decision (C8).
6. **A refusal explains itself** with a structured code the UI keys on
   (`plan_feature_unavailable`, `plan_limit_<metric>`, `ai_allowance_exhausted`,
   `company_readonly_plan`) and names the next step — the "explain a refusal,
   do not hide the control" rule. Status code: **402** for plan refusals is
   the honest choice (the status-code policy memory says to flag ambiguous
   choices rather than default — flagged: 402 vs 403; 402 is recommended
   because 403 is already "your ROLE cannot" and the two must be
   distinguishable in the UI and in logs).
7. **AI exhaustion is one more `AiUnavailableError`** thrown in the seam
   before the provider call; every caller already degrades correctly (§K.10).
8. **Grace is automatic and recorded** — a grace event is an audit-log row so
   an operator can see who is in grace and since when.
9. **Enforcement is testable by the zero-movement standard:** a limit hit
   moves zero in every report; the test seeds an org at its limit, attempts
   the refused act, asserts the 402 and asserts every figure unchanged; then
   performs an exempt correction and asserts the figure MOVES (presence,
   absence, movement).

---

## U. Entitlement architecture

**Conceptual model for engineering — DO NOT BUILD YET.** It is written so that
the eventual build does not scatter plan checks through the application.

### U.1 Entities

```
plans                 plan_versions            subscriptions                  subscription_addons
─────                 ─────────────            ─────────────                  ───────────────────
key (basic|pro|…)     plan_key                 organization_id (1 active)     subscription_id
name (en/ar)          version (int)            plan_version_id   ← pinned     addon_key (seat|company|ai_boost|storage|…)
sort                  effective_from           status (trialing|active|       quantity
                      price_monthly_sar          past_due|read_only_*|        effective_from / effective_to
                      price_annual_sar           cancelled|dormant)
                      entitlements (jsonb:     billing_period (monthly|annual)
                        feature → {kind,limit}) current_period_start/end
                      ai_allowances (jsonb:    trial_ends_at
                        questions, documents, grace_used_in_year (jsonb)
                        fairuse_guide)         grandfathered (bool)
                      addon_prices (jsonb)     external_billing_ref (nullable — provider undecided)

usage_counters                                  entitlement_overrides
──────────────                                  ─────────────────────
organization_id                                 organization_id
metric (sales_documents|purchase_documents|     feature_key
  captures|storage_bytes|ai_questions|          kind/limit (operator-granted exception,
  ai_documents|ai_units_background|api_calls)     dated, reasoned — audited)
period_key (YYYY or YYYY-MM per metric)          effective_from / effective_to
value (bigint) — INCREMENTED IN THE SAME
  TRANSACTION AS THE ACT IT COUNTS
```

Notes:

- **Counters are derived where derivation is cheap and exact** (users =
  active memberships; companies = active companies; bank accounts; assets;
  employees) and **materialised where it is not** (documents per year, AI per
  month, storage). A materialised counter is incremented *in the transaction
  that performs the act*, so a rolled-back approval never counts.
- **`ai_usage` stays the append-only source of truth for AI**; `usage_counters`
  for AI is a per-period cache of the resolver's units conversion, rebuilt from
  `ai_usage` if they disagree (the meter wins).
- **Plan versions are immutable.** A price or entitlement change is a new
  version; existing subscriptions keep their pinned version until a migration
  event moves them (§U.6).
- **`feature_flags` (S6):** either becomes `entitlement_overrides` or is
  dropped. Not both.
- **Everything is tenant-scoped** (`organization_id`, RLS) except `plans` and
  `plan_versions`, which are platform reference data like `permissions`;
  `subscriptions` are read by the identity layer (pre-`resolveTenant`) the way
  memberships are — **the business layer never reads `subscriptions`
  directly**; it reads the resolved entitlement snapshot on `req.tenant`.

### U.2 Resolution

```
resolveEntitlements(organizationId, at = now)
  → EffectiveEntitlements {
      planKey, planVersion, status,
      features: Map<featureKey, { kind: included|limited|addon|enterprise|unavailable, limit?, used?, remaining?, graceUntil? }>,
      ai: { questions: {limit, used, remaining}, documents: {…}, backgroundGuide, exhaustedUntil? },
      readOnly: boolean, readOnlyReason?,
      companies: { active: Set<companyId>, readOnly: Set<companyId> },
    }
```

- Computed once per request in `resolveTenant`'s successor step, cached on
  `req.tenant.entitlements`; a per-org 60-second cache is acceptable for
  feature kinds, **never for counters near their limit** (a counter within 5%
  of its limit is read fresh).
- Evaluation is pure: plan version + add-ons + overrides + counters + clock →
  snapshot. No I/O inside the evaluator; all inputs loaded first. That makes
  the resolver testable with a fixed clock (the business-date seam applies:
  periods are Riyadh days).

### U.3 Enforcement points — exactly three

| Point | Mechanism | Covers |
| --- | --- | --- |
| **Route middleware** `requireEntitlement(featureKey)` | after `resolveTenant`, before `requirePermission`; 402 + structured code | feature presence (analytics, POs, API, custom reports…) and read-only states |
| **Service creation boundary** `assertQuota(metric)` | first statement of the `create` method of a primary document; increments the counter in the same transaction | volume limits |
| **AI seam** `services/ai/metered.ts` | before the provider call; throws `AiUnavailableError("ai_allowance_exhausted")` | AI allowances, fair use, rate limits, concurrency |

No fourth place. A `grep` for `entitlements.` outside these three is a review
finding — the same shape as the identity-table boundary test.

### U.4 Feature keys

A closed enum in `@workspace/shared` (one definition — the two-definitions
lesson): `analytics`, `budgets`, `purchase_orders`, `payroll`, `fixed_assets`,
`multi_company`, `api_read`, `api_write`, `webhooks`, `custom_reports`,
`multi_currency`, `cost_centers`, `bank_feeds`, `inventory`, `sso`,
`ai_questions`, `ai_documents`, `ai_background`, … Each key is either a
**feature** (kind only) or a **metric** (kind + limit + period). The plan
version's `entitlements` JSON is validated against the enum at load — an
unknown key fails boot.

### U.5 Plan changes

| Event | Effect |
| --- | --- |
| Upgrade | immediate; new pinned version = current version of the target plan; counters carry over (never reset upward in the customer's disfavour); proration is the billing provider's concern (undecided) |
| Downgrade | scheduled for period end (or immediate on request); the resolver applies §J: creation limits from the effective date, read-only companies/seats per the customer's choice, grace 30 days |
| Add-on change | immediate for increases; period-end for decreases (or immediate on request) |
| Trial → paid | `trialing` → `active`; the pinned version is the current one at conversion |
| Non-payment | `past_due` (full function, notices) → after 14 days `read_only_past_due` (§J read-only semantics) → 90 days → `dormant` |
| Cancellation | `read_only_cancelled` 90 days → `dormant` |

Every transition is an audit-log row and a `subscriptions` row change with
`effective_from`; the history of a subscription is reconstructible.

### U.6 Grandfathering

- A subscription pins a `plan_version`. Publishing a new version (a price rise,
  a limit change) does not touch existing subscriptions.
- A **migration policy** per version pair states what happens at renewal:
  `keep` (grandfathered indefinitely), `migrate_at_renewal` (with N days'
  notice, the customer sees old vs new before renewing), or
  `migrate_now_better` (only when every entitlement is ≥ the old one and the
  price is ≤ — an upgrade nobody can object to, applied automatically).
- The UI always shows the customer their pinned version's terms, and, when a
  migration is scheduled, both.

### U.7 What is NOT in this model

- The billing provider (Stripe-class vs Saudi PSP) — `external_billing_ref` is
  the only touch-point, deliberately opaque.
- Invoicing the customer (Saudi Ledger's own invoices to its customers must be
  ZATCA-compliant — they should be issued *by a Saudi Ledger company on the
  platform itself*, which is the strongest dog-food available; noted, not
  decided).
- Tax on the subscription (15% VAT) — the provider's concern.

---

## V. Recommended Saudi Ledger pricing

All SAR, ex-VAT. STRATEGIC RECOMMENDATION; every number is subject to the
review triggers in §W.

### Basic
- SAR/month: **99**
- SAR/year: **990** (82.50/mo effective)
- users: **2** (+ 1 free accountant seat per company; extra seat SAR 20/mo)
- companies: **1**
- AI (when enabled): included background AI; **50 questions, 75 document reads / month**
- transaction/document allowance: **1,200 sales documents + 1,200 purchase documents / year; 100 captures / month; 2 bank accounts; 10 fixed assets; 5 recurring schedules; 2 GB**
- features: full double-entry GL, chart of accounts, journal entries with approval, all financial statements, closed months, audit trail, customers, quotations, invoices, credit/debit notes, invoice PDF (AR/EN), customer payments/allocations/refunds/statements (when merged), AR/AP ageing, suppliers, bills, document capture (QR + OCR), bank import + review + reconciliation, transfers, VAT return, ZATCA e-invoicing, Zakat calendar, all standard reports, Finance Hub, recurring drafts, findings, migration workspace, export
- disabled features: budgets, cost centres, multi-currency, purchase orders, analytics, custom/scheduled reports, payroll, inventory, API, webhooks, bank feeds, WHT, SSO, second company, AI insight brief, AI overage

### Pro
- SAR/month: **199**
- SAR/year: **1,990** (165.83/mo)
- users: **5** (+ free accountant seat; extra SAR 20/mo)
- companies: **1** (+ up to 2 at SAR 99/mo each)
- AI: included background AI; **150 questions, 300 document reads / month**; AI Boost and capped pay-as-you-go available
- transaction/document allowance: **12,000 + 12,000 documents / year; 500 captures / month; 6 bank accounts; unlimited assets; 10 payroll employees; unlimited recurring; 10 GB**
- features: everything in Basic + purchase orders, budgets, analytics, payroll, fixed assets unlimited, scheduled reports (planned), cost centres (planned), WHT (planned), bank feeds (planned, CR-gated), read-only API (planned), inventory as add-on (planned), one assisted migration on annual, AI insight brief (planned), same-business-day support
- disabled features: multi-currency, write API, webhooks, custom reports, consolidated reporting, custom approval routing, SSO, session/IP controls

### Advanced
- SAR/month: **449**
- SAR/year: **4,490** (374.17/mo)
- users: **15** (+ free accountant seats; extra SAR 20/mo)
- companies: **3** (+ SAR 99/mo each)
- AI: included background AI; **400 questions, 1,000 document reads / month**, pooled across companies; Boost and capped overage
- transaction/document allowance: **60,000 + 60,000 documents / year; 2,500 captures / month; unlimited bank accounts, assets, employees, recurring; 50 GB**
- features: everything in Pro + multi-company pooled, consolidated reporting (planned), custom reports (planned), multi-currency (planned), read+write API and webhooks (planned), custom approval routing (planned), session/IP controls (planned), inventory included (planned), SSO as add-on, priority support with named onboarding, one assisted migration included
- disabled features: contractual SLA, dedicated support, custom integrations, SCIM, security paper/DPA

### Enterprise
- pricing model: **annual contract, quoted; floor SAR 23,988/year (1,999/mo)**
- minimum contract: **12 months**
- users/entities: custom (≥ 25 users, ≥ 5 companies as the shape that justifies the floor)
- AI: **pooled custom capacity** sized from the customer's own `ai_usage` history; the only place an internal token or unit figure may appear
- support/SLA: dedicated support, named CSM, contractual SLA with credits, onboarding programme
- integrations: SSO/SCIM included, custom connectors, higher API limits
- migration: white-glove included

### Then:
- **AI monetisation:** organisation-level allowances in named actions
  (questions, document reads) with background AI included under fair use;
  AI Boost SAR 49/mo (+100 questions, +200 reads); capped opt-in pay-as-you-go
  SAR 0.10/question, SAR 0.25/read on Pro and Advanced; Enterprise pooled.
  Provider-independent by the AI Unit weight table (§K.12). **Nothing AI is
  shown on the pricing page until the data boundary flips.**
- **Migration pricing:** workspace free on every plan; assisted SAR 1,500
  (included on Pro annual and above); white-glove from SAR 4,000; included on
  Enterprise.
- **Accountant-firm pricing:** no fifth plan — a partner programme: clients
  are their own organisations, the firm holds the free accountant seat per
  client company, firm-paid consolidated billing at a 25% partner discount,
  practice workspace built later from partner asks.
- **Annual discount:** 16.7% ("12 months for the price of 10").
- **Free trial:** 14 days of Pro, no card, no permanent free tier; the clock
  starts at verification approval; trial end = read-only, exportable, nothing
  deleted.
- **Expected gross-margin range:** **83–91% excluding cost-to-serve, 74–78%
  including it**, at 300 organisations on Groq's price card (companion §5);
  **70–72% if AI usage is 5× the model; 62–69% under a ×10 per-token
  sovereign premium; and NOT VIABLE below ~250–500 organisations under a
  fixed-commitment or dedicated-replica AI contract sized above ~SAR 150k/yr
  (companion §6).**
- **Main pricing risks:** (1) ZATCA production submission unverified — the
  product cannot claim what every competitor's mid tier claims until M12.9
  runs; (2) AI dark by construction — Strategy C's upside is unavailable
  until the Groq Enterprise agreement or a Saudi provider; (3) the vision
  model default is dead on Groq and the vision cost card (qwen3.8-27b preview at
  $0.80/$4.00) is 5–10× the text models' — the document-read allowance is the
  one whose economics can move; (4) infrastructure cost per org at low
  customer counts is the real margin driver, not AI; (5) a fixed AI commitment
  signed before ~500 organisations is a margin-destroying decision; (6) the
  verification-gate wait (L3) can burn the trial; (7) the entry tier competes
  with Zoho Standard at SAR 69 with bank feeds we cannot offer until A2.
- **Conditions that trigger a pricing review:** M12.9 production pilot passes;
  the AI boundary flips (re-derive the AI allowances from 90 days of real
  `ai_usage`); the first 100 paying organisations (measure the real usage
  distributions and the real infra cost per org); any provider contract that
  is not per-token; the first accounting-firm partner with > 10 clients; A2
  bank feeds signed (a per-connection cost enters COGS); inventory ships
  (re-price Pro/Advanced); Zoho or Wafeq change their KSA ladder by > 15%;
  the SAR/USD peg changes (all infra and AI costs are USD).

---

## W. Assumptions, risks, review triggers, unresolved questions

**Major assumptions (each marked ASSUMPTION in the companion):**
plan mix 50/35/15; 60% annual adoption; infrastructure $3.0/3.5/5.0 per
org-month at ~300 orgs; cost-to-serve $2/$5/$15; PSP fee 3% of revenue;
token profiles per operation (from prompt shapes, not measured on tenant
data); the usage-distribution tables; accountant hourly cost SAR 350–500;
SAR/USD 3.75.

**Unresolved questions (owner or advisor):**
1. Ex-VAT or VAT-inclusive display on the pricing page (recommended ex-VAT).
2. 402 vs 403 for plan refusals (recommended 402).
3. Whether Saudi Ledger's own subscription invoices are issued through the
   platform itself (recommended yes, once M12.9 is proven).
4. The billing provider (R1's first decision) — this document is neutral.
5. The partner discount percentage (25% is a placeholder from the global
   norm, `UNVERIFIED`).
6. Whether the trial should require verification to *start* or only to
   *issue* — depends on the L3 SLA decision.
7. Whether to publish any AI line on the pricing page before the boundary
   flips (recommended no).
8. The retention period for dormant organisations — a PDPL question (C8),
   not a pricing one.
9. Whether `feature_flags` becomes `entitlement_overrides` or is dropped.
10. Re-pinning `GROQ_VISION_MODEL` — a code change outside this task's scope,
    needed before the vision harness can be run again.
