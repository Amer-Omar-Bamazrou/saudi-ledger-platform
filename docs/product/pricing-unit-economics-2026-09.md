# Saudi Ledger — pricing unit economics (research, 2026-09)

**Status (2026-09-19): RESEARCH — a model, not a measurement. Every figure is
either a verified price read from a provider's official page on this date, a
repository fact, or an explicitly labelled assumption or calculation. Nothing
here is a decision. Current state authority: [CLAUDE.md §2](../../CLAUDE.md).**

Companion to [`pricing-strategy-2026-09.md`](pricing-strategy-2026-09.md),
which holds the packaging and entitlement design and quotes the numbers below.
**2026-09-20:** the packaging moved to
[`pricing-plans-2026-09-20.md`](pricing-plans-2026-09-20.md) (three plans,
Advanced re-priced from SAR 449 to **349**). §5 below still tabulates the
449 case; the 349 case (ARPU $83.76 at 60 % annual; GM 89.2 % ex-serve,
71.3 % incl. serve at P50 AI, 64.7 % at P95) and the blended consequences
(ARPU SAR 154, ARR/1,000 ≈ SAR 1.85M, blended GM incl. serve ≈ 74 % at P75
AI) are in that document's §G.4. Every other table here is unchanged by the
re-pricing — the sensitivity conclusions in §6 and the provider-contract
rules in §7 hold.
The model that produced every table is a ~150-line script (per-operation cost ×
usage counts × price card; COGS per org; margin = 1 − COGS/ARPU); re-running it
with measured `ai_usage` rows is the first thing to do after the AI boundary
flips.

Three kinds of number appear here and are kept apart:

| Label | Meaning |
| --- | --- |
| **VERIFIED CURRENT PRICING** | read on 2026-09-19 from `console.groq.com/docs/models`, `/docs/deprecations`, `/docs/rate-limits`, `/docs/vision`, `/docs/batch`, the Groq changelog; or a repository fact |
| **UNKNOWN FUTURE PROVIDER PRICING** | SITE / ELM / other Saudi providers: **no public price list was found** (search on 2026-09-19 returned announcements — stc's SambaNova-based inferencing platform, HUMAIN's GPU build-out — and no tariffs). Nothing is invented; §6 models *commercial structures*, not vendors' terms |
| **SCENARIO ASSUMPTION** | usage counts, infrastructure costs, cost-to-serve, plan mix, annual share — every one is named where used |

USD/SAR = 3.75 (FACT — the peg). All provider costs are USD; all prices are SAR.

---

## 1. The Groq price card — VERIFIED CURRENT PRICING (2026-09-19)

| Model ID | Tier | Input $/1M | Output $/1M | Notes |
| --- | --- | ---: | ---: | --- |
| `openai/gpt-oss-20b` | production | **0.075** | **0.30** | the repo's `GROQ_MODEL` default (FACT, `packages/config/src/env.ts`) |
| `openai/gpt-oss-120b` | production | **0.15** | **0.60** | cached input **0.075** (prompt caching "now live for gpt-oss-120b — 50% on cached input", Groq changelog) |
| `qwen/qwen3.8-27b` | preview | **0.80** | **4.00** | vision-capable: **2,048 input tokens per image**, max 3 images/request, 20 MB/request (`/docs/vision`) |
| `qwen/qwen3.6-27b` | listed under vision docs, **absent from the models page** | `UNVERIFIED` | `UNVERIFIED` | 5 images/request; named as a migration target on the deprecations page |
| `llama-3.1-8b-instant`, `llama-3.3-70b-versatile` | production | "Enterprise (Contact Sales)" | — | shut down for self-serve 2026-08-16 |
| `meta-llama/llama-4-scout-17b-16e-instruct` | **SHUT DOWN 2026-07-17** | — | — | 🔴 the repo's `GROQ_VISION_MODEL` default; migration targets named: `openai/gpt-oss-120b` or `qwen/qwen3.6-27b` |
| `allam-2-7b` | **not on the catalog** | — | — | the design doc's SDAIA Arabic model; its v3 benchmark row (17% AR-hard) had already removed it from contention |
| `qwen/qwen3-32b` | shut down 2026-07-17 | — | — | replacement `gpt-oss-120b` |
| `whisper-large-v3-turbo` / `whisper-large-v3` | production | $0.04 / hr · $0.111 / hr | — | speech; no current workflow uses it |
| `canopylabs/orpheus-arabic-saudi` | preview | $40 / 1M characters | — | TTS; no workflow |
| `groq/compound`, `groq/compound-mini` | production systems | not priced on the page | — | agentic systems; not used |

Other verified facts: **Batch API = 50% lower cost**, 24h–7d window, no impact
on standard rate limits (`/docs/batch`). **Free-tier limits** per model:
30 RPM, 1,000 RPD, 8K TPM, 200K TPD (`/docs/rate-limits`); the Developer plan
has higher base limits, and "higher limits are available for select workloads
and enterprise use cases" (exact paid-tier limits are behind the console —
`UNVERIFIED`). Groq's marketing pricing page could not be fetched (it served a
landing page); the models page carries the per-token figures.

**What this means for the model choice (SOURCE-DERIVED OBSERVATION + repo
fact):** the two text models the design already benchmarked (design-ai-layer
§12h: both clear the Arabic gate, 120b ahead by two cases on 30-case corpora)
are the two cheapest production models on the card. The vision path has **no
production-tier model on Groq today**: `qwen3.8-27b` is preview and priced
5–10× the text models. This is the one place where the AI economics are
genuinely exposed, and it coincides with the design's own open item (an
Arabic-capable vision model in Dammam, C6).

---

## 2. Per-operation cost — CALCULATION on the verified card

Token profiles are **SCENARIO ASSUMPTIONS derived from the prompt shapes in the
repository**; the `maxTokens` caps are code facts (`categorize_second_opinion`
200, `finding_explanation` 300, `grounded_answer` 400). The judge calls are
code facts (`ask.service.ts` and `findings.explain.service.ts` each run a
second call that checks the first for invented claims).

| Operation | Status | Model routed | Input tok | Output tok | Judge (in/out) | Tokens/op | **USD/op** | SAR/op | Ops per $1 |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `categorize_second_opinion` | LIVE, dark | gpt-oss-20b | 800 | 60 | — | 860 | **0.000078** | 0.00029 | 12,821 |
| reconciliation suggestion | PLANNED | gpt-oss-20b | 1,000 | 80 | — | 1,080 | 0.000099 | 0.00037 | 10,101 |
| `finding_explanation` | LIVE, dark | gpt-oss-120b | 1,500 | 200 | 800 / 50 | 2,550 | **0.000495** | 0.00186 | 2,020 |
| `grounded_answer` | LIVE, dark | gpt-oss-120b | 2,500 | 300 | 1,200 / 60 | 4,060 | **0.000771** | 0.00289 | 1,297 |
| monthly insight brief | PLANNED | gpt-oss-120b | 6,000 | 800 | — | 6,800 | 0.001380 | 0.00517 | 725 |
| document read (vision) | harness only | qwen3.8-27b | 2,348 (2,048 image + 300) | 400 | — | 2,748 | **0.003478** | 0.01304 | 287 |

Observations:

- **Output tokens cost 4–5× input on every model**, and the vision model's
  output is $4/1M — the 400-token JSON extraction is half the cost of a
  document read. Tightening extraction output (field list, no prose) is the
  single cheapest AI-cost lever in the product.
- Routing the judge to gpt-oss-20b instead of 120b would cut a question from
  $0.00077 to ~$0.00066 (−14%) — worth doing only if the judge's own
  accuracy is measured first (a judge is an instrument; the instrument rule
  applies).
- Prompt caching (50% on cached input, 120b only) helps the grounded-answer
  system prefix; at 2,500 input tokens with ~1,000 cacheable it is −$0.00008
  per question (−10%). Real but small.
- Batch (−50%) applies to the scheduled findings explanations (a daily job
  with a 24h window is exactly batch-shaped) — halves the cheapest workflow.
- **OCR is Tesseract.js in-process (FACT): $0 provider cost**, CPU only. The
  QR path sends nothing anywhere. The vision model sees only the residue.

---

## 3. Usage distributions — SCENARIO ASSUMPTIONS, and the cost they imply

Counts per organisation per month. Columns: categorize (LLM calls, i.e. rows
under the 0.65 confidence threshold — roughly 30–40% of imported lines,
ASSUMPTION), explanations, questions, document reads, reconciliation
suggestions (PLANNED), briefs (PLANNED; per company).

| Plan | Percentile | categorize | explain | question | document | reconcile | brief |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Basic | P50 | 40 | 20 | 5 | 10 | 20 | 1 |
| Basic | P75 | 80 | 40 | 15 | 25 | 40 | 1 |
| Basic | P90 | 150 | 60 | 40 | 60 | 80 | 1 |
| Basic | P95 | 250 | 90 | 80 | 120 | 150 | 1 |
| Basic | Heavy | 600 | 250 | 400 | 400 | 400 | 1 |
| Pro | P50 | 120 | 40 | 20 | 40 | 60 | 1 |
| Pro | P75 | 250 | 60 | 50 | 100 | 120 | 1 |
| Pro | P90 | 500 | 90 | 120 | 250 | 250 | 1 |
| Pro | P95 | 800 | 150 | 250 | 400 | 400 | 1 |
| Pro | Heavy | 2,000 | 400 | 1,500 | 1,500 | 1,500 | 1 |
| Advanced | P50 | 400 | 80 | 50 | 150 | 200 | 3 |
| Advanced | P75 | 800 | 120 | 120 | 400 | 400 | 3 |
| Advanced | P90 | 1,500 | 200 | 300 | 900 | 800 | 3 |
| Advanced | P95 | 2,500 | 300 | 600 | 1,500 | 1,500 | 3 |
| Advanced | Heavy | 6,000 | 750 | 4,000 | 5,000 | 5,000 | 3 |

Explanations are bounded by code (≤ 25 per run, daily run → ≤ 750/month) and
by content-hash de-duplication (a finding that has not changed is not
re-explained), so the "Heavy" explanation counts are already near the ceiling.

**Monthly AI cost per organisation — CALCULATION (Groq card, §2 profiles):**

| Plan | Percentile | Tokens/month | USD/month | SAR/month | % of blended ARPU |
| --- | --- | ---: | ---: | ---: | ---: |
| Basic | P50 | 0.16M | 0.055 | 0.21 | 0.2% |
| Basic | P75 | 0.35M | 0.130 | 0.49 | 0.5% |
| Basic | P90 | 0.70M | 0.290 | 1.09 | 1.2% |
| Basic | P95 | 1.27M | 0.559 | 2.10 | 2.4% |
| Basic | Heavy | 4.32M | 1.911 | 7.17 | 8.0% |
| Pro | P50 | 0.47M | 0.191 | 0.72 | 0.4% |
| Pro | P75 | 0.98M | 0.449 | 1.68 | 0.9% |
| Pro | P90 | 2.11M | 1.072 | 4.02 | 2.2% |
| Pro | P95 | 3.62M | 1.762 | 6.61 | 3.7% |
| Pro | Heavy | 14.58M | 6.878 | 25.79 | 14.4% |
| Advanced | P50 | 1.40M | 0.655 | 2.46 | 0.6% |
| Advanced | P75 | 3.03M | 1.649 | 6.19 | 1.5% |
| Advanced | P90 | 6.38M | 3.661 | 13.73 | 3.4% |
| Advanced | P95 | 11.11M | 6.176 | 23.16 | 5.7% |
| Advanced | Heavy | 42.47M | 21.814 | 81.80 | 20.2% |

**The economically safe usage boundary on the current card:** the allowance
in the strategy document (≈ P90 per plan) caps requested AI at ≈ $0.30 /
$1.16 / $3.79 per org-month at full consumption (≈ $0.4 / $1.3 / $4.3 with
background AI at P95) — under 4% of ARPU on every plan. The "Heavy" column
(10× P50, uncapped) reaches 8–20% of ARPU, which is why a hard cap on
requested AI exists at all; background AI even at Heavy is < 1.5% of ARPU.

**Against the placeholder allowances (30M / 100M / 300M tokens):** at a
blended ~$0.25/1M (the 120b mix), those would cost at most **$7.5 / $25 /
$75** per org-month if fully consumed — 32% / 52% / 70% of ARPU — but no
modelled organisation, including "Heavy", consumes more than 15% of them. As
a limit they are inert; as a headline they are unpicturable. The strategy
document derives allowances in actions instead (§K there).

---

## 4. Full SaaS COGS per organisation — SCENARIO ASSUMPTIONS

Per org-month, USD, at **~300 paying organisations** (the scale at which the
fixed platform costs below amortise to these figures). Separated from OpEx
(engineering, sales, G&A are NOT here).

| Line | Basic | Pro | Advanced | What it is |
| --- | ---: | ---: | ---: | --- |
| **AI** — LLM inference | §3 | §3 | §3 | Groq card; OCR $0 (Tesseract in-process); no embeddings, reranking or tool-call fees exist in the current design (the "tools" in `/ask` are internal functions) |
| **Infrastructure** — Postgres (hosted Supabase-class), API compute, KMS, object storage, backups, monitoring/logging, bandwidth, the Chromium PDF renderer's memory | 3.00 | 3.50 | 5.00 | ASSUMPTION: ~$900/month platform floor ÷ 300 orgs, weighted by plan (more companies, documents, storage). No Redis, no queue — in-process scheduler (FACT) |
| **Communications** — email (invoices, notices, alerts) | 0.20 | 0.30 | 0.50 | ASSUMPTION at ~$1/1,000 emails; SMS not in the product |
| **Documents** — PDF generation compute, capture storage, archive | 0.10 | 0.20 | 0.40 | ASSUMPTION |
| **Integrations** — ZATCA (no fee), bank feeds (A2 — none yet; when signed, a per-connection fee enters here, `UNVERIFIED`), payment gateways (none yet) | 0 | 0 | 0 | |
| **Payment processing** (when billing exists) | 3% of revenue | 3% | 3% | ASSUMPTION for a Saudi PSP on mada/cards; annual bank transfers cost less |
| **Cost-to-serve** — support and onboarding time | 2.00 | 5.00 | 15.00 | ASSUMPTION: 10 / 25 / 60 minutes per org-month at a blended SAR 45/hour ($12/hour) support cost. Shown separately because many SaaS reports exclude it from gross margin |

Malware scanning (clamd sidecar, C4) and the alerter are inside the compute
line. **The ZATCA archive is a legal obligation with a storage cost that grows
forever** (no delete); at ~100 KB per invoice XML+PDF it is ~$0.002 per
invoice-year at object-storage prices — immaterial, listed so it is not
forgotten.

---

## 5. Gross margin — CALCULATION

Prices from the strategy document (Balanced: 99 / 199 / 449; annual = 10
months), **60% annual adoption (ASSUMPTION)** → blended ARPU.

| Plan | ARPU SAR | ARPU USD | Infra | Comms + docs | PSP | AI P50 | AI P95 | COGS ex-serve (P50 AI) | **GM ex-serve** | COGS incl. serve | **GM incl. serve** | GM incl. serve at P95 AI |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Basic | 89 | 23.76 | 3.00 | 0.30 | 0.71 | 0.055 | 0.559 | 4.07 | **82.9%** | 6.07 | **74.5%** | 72.3% |
| Pro | 179 | 47.76 | 3.50 | 0.50 | 1.43 | 0.191 | 1.762 | 5.62 | **88.2%** | 10.62 | **77.8%** | 74.5% |
| Advanced | 404 | 107.76 | 5.00 | 0.90 | 3.23 | 0.655 | 6.176 | 9.79 | **90.9%** | 24.79 | **77.0%** | 71.9% |

**What each margin target permits as total COGS per org-month (USD):**

| Plan | ARPU | 70% | 75% | 80% | 85% | 90% |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Basic | 23.76 | 7.13 | 5.94 | 4.75 | 3.56 | 2.38 |
| Pro | 47.76 | 14.33 | 11.94 | 9.55 | 7.16 | 4.78 |
| Advanced | 107.76 | 32.33 | 26.94 | 21.55 | 16.16 | 10.78 |

Reading the two tables together:

- **90%** is reachable only excluding cost-to-serve and only on Pro/Advanced
  at ≥ 300 orgs — on Basic it requires total COGS ≤ $2.38, less than the
  modelled infra line alone, which is not credible below ~1,000
  organisations. **Do not plan on 90%.**
- **85%** ex-serve is the natural Pro/Advanced figure at 300+ orgs; Basic
  reaches it only when its infra share falls to ≈ $2.5 (total ≤ $3.56 with
  PSP, comms and AI) — roughly above ~400–500 orgs on the amortisation
  assumed here.
- **80%** incl. cost-to-serve needs Basic support ≤ $0.7/month — i.e. a
  self-serve Basic with no human onboarding. That is a product decision
  (self-serve migration, in-app help) more than a pricing one.
- **75%** incl. cost-to-serve is where the Balanced prices land at 300 orgs
  with realistic support. **This is the honest planning figure.**
- **70%** is the floor under any two of: AI usage ×5, infra +50%, a
  sovereign per-token premium ×10. Below 70% only under a fixed AI commitment
  at low volume (§6).

### 5.1 The three pricing scenarios — CALCULATION

Plan mix 50% Basic / 35% Pro / 15% Advanced; 60% annual; COGS as §4; AI at P75.

| Scenario | Prices (SAR/mo) | Blended ARPU SAR | MRR / 100 | ARR / 100 | ARR / 1,000 | ARR / 1,000 USD | GM incl. serve | GM if AI usage ×5 | Sensitivity to heavy AI users |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| **Conservative** | 79 / 159 / 349 | 133 | 13,275 | 159,298 | 1,592,984 | 424,796 | 70.4% | 65.1% | a Basic "Heavy" org costs 10% of its ARPU in AI — tolerable, but the tier has no room for a support call |
| **Balanced** | 99 / 199 / 449 | 168 | 16,785 | 201,420 | 2,014,195 | 537,119 | 76.0% | 71.8% | Heavy Basic 8%, Heavy Pro 14%, Heavy Advanced 20% of ARPU — the allowance caps all three below these |
| **Premium AI** | 129 / 279 / 599 | 227 | 22,680 | 272,160 | 2,721,604 | 725,761 | 81.5% | 78.3% | immaterial — but the tier sells an AI that is dark by construction |

No market-share claim is made; ARR figures are per fixed customer count.

---

## 6. Sensitivity — CALCULATION (GM incl. cost-to-serve, P75 AI, Balanced prices)

| Scenario | Basic | Pro | Advanced | Reading |
| --- | ---: | ---: | ---: | --- |
| Base case | 74.1% | 77.2% | 76.1% | |
| AI price ×2 | 73.6% | 76.3% | 74.5% | a preview→production repricing on Groq, or a modest sovereign premium: < 2 points |
| AI price ÷2 (batch + caching) | 74.4% | 77.7% | 76.8% | not worth engineering effort for margin; worth it for rate-limit headroom |
| AI usage ×2 | 73.6% | 76.3% | 74.5% | |
| AI usage ×5 | 72.0% | 73.5% | 70.0% | the allowance exists for this row |
| **AI price ×10** (a sovereign per-token premium) | 69.2% | 68.8% | 62.3% | still viable; Advanced feels it most because its AI is largest |
| **AI price ×10 AND usage ×5** | 47.4% | 31.2% | 1.1% | the only combination that breaks the model — and both halves are controllable (the allowance caps usage; the provider choice caps price) |
| Infra +50% | 67.8% | 73.6% | 73.8% | **infra is the real lever** — +50% costs Basic 6 points, more than AI ×5 |
| Infra ×2 | 61.5% | 69.9% | 71.4% | e.g. a dedicated KSA hosting region with no reserved pricing |
| Annual adoption 90% | 72.8% | 76.1% | 74.8% | annual costs 1.3 points of margin and buys a year of cash |
| Annual adoption 20% | 75.7% | 78.6% | 77.5% | |

**The resilient model:** organisation-level AI allowances in actions (caps the
"usage" half of the only fatal row) + Basic priced ≥ SAR 99 (the tier with the
least infra headroom) + infrastructure reserved/committed before AI is
committed. The pricing survives every single-variable shock in the grid and
every two-variable shock except the one whose both halves are ours to control.

---

## 7. Future provider scenarios — commercial STRUCTURES, not vendor terms

**UNKNOWN FUTURE PROVIDER PRICING.** No public tariff exists for SITE, ELM or
any Saudi sovereign inference offering as of 2026-09-19 (search evidence:
announcements only). The structures below are the ones enterprise AI
contracts commonly take; **the numbers in the grids are scenario inputs
chosen to span the plausible range, not quotes.** The design doc's own
in-Kingdom dedicated-GPU estimate ($3,000–4,500/month for one replica,
design-ai-layer §12) is the one repository-sourced figure.

Definitions used in every scenario:
- `N` = paying organisations; `u` = AI cost per org-month at Groq prices
  (§3, P75 blended across the mix ≈ **$0.50**); `C` = annual commitment in SAR;
  `R` = monthly dedicated-replica cost in USD.
- **AI budget** = the AI line the margin model can absorb at the planning
  figure (75% incl. serve): ≈ **SAR 5 / 10 / 20 per org-month** for Basic /
  Pro / Advanced (from §5's "what each target permits" less the non-AI COGS).

### 7.1 Scenario A — usage-based / per-token at a premium multiple `k`

- **Effective cost per customer:** `k × u` → at k = 2: $1.0; k = 5: $2.5;
  k = 10: $5.0 (SAR 18.8) per org-month at P75.
- **Break-even:** none needed — cost scales with revenue from the first
  customer.
- **Minimum viable volume:** 1.
- **Gross-margin impact:** §6 rows "AI price ×2 / ×10": −0.5 to −14 points.
  Basic is at its AI budget at k ≈ 10; Advanced at k ≈ 3 for P75 and already
  at k ≈ 0.9 for P95 — **Advanced's document allowance (1,000 reads) is the
  first thing to revisit under any per-token premium.**
- **Unused-capacity risk:** zero.
- **If usage grows faster than expected:** cost grows linearly; the allowance
  and boost/overage prices are the governor; overage at SAR 0.25/read stays
  profitable up to k ≈ 19 on the vision op (0.25 / (0.0035 × 3.75)).
- **If volume is below expectations:** nothing — the cost simply does not
  occur. **This is the structure the pricing model is safest under, and the
  one Groq offers today.**

### 7.2 Scenario B — fixed annual enterprise commitment `C`

Cost per org-month (SAR) = `C / 12 / N`:

| C (SAR/yr) | N=50 | N=100 | N=250 | N=500 | N=1,000 | N=2,500 | N=5,000 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 60,000 | 100.0 | 50.0 | 20.0 | 10.0 | 5.0 | 2.0 | 1.0 |
| 150,000 | 250.0 | 125.0 | 50.0 | 25.0 | 12.5 | 5.0 | 2.5 |
| 300,000 | 500.0 | 250.0 | 100.0 | 50.0 | 25.0 | 10.0 | 5.0 |
| 600,000 | 1,000.0 | 500.0 | 200.0 | 100.0 | 50.0 | 20.0 | 10.0 |
| 1,200,000 | 2,000.0 | 1,000.0 | 400.0 | 200.0 | 100.0 | 40.0 | 20.0 |

Minimum `N` at which the commitment fits the AI budget:

| C (SAR/yr) | N at SAR 5/org-mo | N at SAR 10 | N at SAR 20 |
| --- | ---: | ---: | ---: |
| 60,000 | 1,000 | 500 | 250 |
| 150,000 | 2,500 | 1,250 | 625 |
| 300,000 | 5,000 | 2,500 | 1,250 |
| 600,000 | 10,000 | 5,000 | 2,500 |
| 1,200,000 | 20,000 | 10,000 | 5,000 |

- **Effective cost per customer:** the grid; at N = 100 and C = 150k it is
  SAR 125/org-month — **more than Basic's entire price.**
- **Break-even vs Groq usage pricing:** `N × 12 × u × 3.75 = C` → for
  C = 150k, N ≈ 6,700 orgs at u = $0.50. Below that, the commitment costs more
  than per-token would have.
- **Minimum viable volume:** the second grid — **no commitment above ~SAR 60k
  is viable below 500 organisations at the Pro AI budget.**
- **Gross-margin impact:** at N = 250 and C = 300k, AI = SAR 100/org-month:
  Basic GM −112 points (100 / 89 — the plan runs at a loss), Pro −56,
  Advanced −25. Fatal at low N.
- **Unused-capacity risk:** the entire gap between committed capacity and
  actual consumption — at N = 100 and any C above 60k, > 90% of the
  commitment is unused.
- **If usage grows faster:** good, up to the committed ceiling; beyond it,
  whatever the contract's overage says (unknown).
- **If volume is below expectations:** the whole shortfall lands on gross
  margin. **Do not sign a fixed commitment before ~500 paying organisations
  and 90 days of measured `ai_usage`.**

### 7.3 Scenario C — minimum commitment `C_min` + usage

- **Effective cost per customer:** `max(C_min / 12 / N, k × u)` — the floor
  from §7.2's grid until usage exceeds it, then §7.1.
- **Break-even:** `N_be = C_min / (12 × k × u × 3.75)` — the N at which
  usage naturally covers the minimum; for C_min = 60k and k = 3: ≈ 890 orgs.
- **Minimum viable volume:** as §7.2 for `C_min`; a minimum ≤ SAR 60k/yr is
  survivable from ~250 orgs at the Pro budget.
- **Gross-margin impact:** bounded below by §7.1 at scale, above by §7.2's
  row for `C_min` at low N.
- **Unused-capacity risk:** `C_min − actual` until break-even; zero after.
- **Faster usage:** converts to §7.1 sooner — benign.
- **Lower volume:** the minimum is the exposure; negotiate it as low as the
  provider will accept and **ramp it** (a first-year minimum sized to the
  N the pipeline actually supports).

### 7.4 Scenario D — hybrid: reserved capacity (tokens or TPS) + overage

- **Effective cost per customer:** reserved block `B` (SAR/yr) covering `T`
  tokens/month, plus overage `o` per token above `T`:
  `B / 12 / N + o × max(0, tokens(N) − T)`.
- **Break-even:** the block pays for itself when `N × tokens_per_org ≥ T`
  at a per-token rate below `o`; size `T` to the P75 of the measured
  distribution × N, never to a forecast.
- **Minimum viable volume:** as §7.2 for `B`.
- **Gross-margin impact:** the reserved block behaves like §7.2 at low N;
  the overage like §7.1.
- **Unused-capacity risk:** `T − actual` monthly; **capacity reservations
  expire — unused months are lost**, so a monthly-rollover clause is worth
  more than a lower rate.
- **Faster usage:** overage at `o` — fine if `o` ≤ SAR 0.25/document-
  equivalent; the boost/overage prices are the customer-side hedge.
- **Lower volume:** the block is stranded. Same rule as §7.2: not before ~500
  orgs, and ramped.

### 7.5 Scenario E — dedicated in-Kingdom replica (self-managed or provider-hosted)

Repository-sourced (design-ai-layer §12): **$3,000–4,500/month for ONE
always-on replica, no redundancy**; a redundant pair ≈ $9,000. Cost per
org-month (USD):

| R (USD/mo) | N=50 | N=100 | N=250 | N=500 | N=1,000 | N=2,500 | N=5,000 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 3,000 | 60.00 | 30.00 | 12.00 | 6.00 | 3.00 | 1.20 | 0.60 |
| 4,500 | 90.00 | 45.00 | 18.00 | 9.00 | 4.50 | 1.80 | 0.90 |
| 9,000 (redundant) | 180.00 | 90.00 | 36.00 | 18.00 | 9.00 | 3.60 | 1.80 |

- **Effective cost per customer:** the grid; the design doc's own reading
  ("cost per document is very high until tenant count grows") holds — at
  N = 250 a single replica is 4× Basic's whole AI budget, and a bursty SME
  workload idles it most of the day.
- **Break-even vs Groq usage pricing:** `N ≥ R / u` → **6,000 orgs** for a
  $3,000 replica at u = $0.50; **18,000** for the redundant pair.
- **Minimum viable volume:** ~1,000 orgs for one replica at the Pro AI budget;
  ~2,500 for a redundant pair.
- **Gross-margin impact:** fatal below ~500 orgs (Basic negative), −10 to −20
  points at 500–1,000.
- **Unused-capacity risk:** the replica's idle hours — the majority.
- **Faster usage:** free up to the replica's throughput ceiling, then a second
  replica (a step function, not a slope).
- **Lower volume:** the full replica cost stays. **This is the structure the
  design doc already warned about; the numbers here confirm the warning at
  every N below ~1,000.**

### 7.6 Summary — what the pricing model needs from any future contract

| Structure | Viable from (orgs) | Margin behaviour | Pricing-model change needed |
| --- | ---: | --- | --- |
| A — per-token (Groq today) | 1 | linear, small | none |
| B — fixed annual | ~500 at SAR 60k; ~2,500 at SAR 300k | fixed ÷ N — fatal at low N | none on the customer side; the AI Unit's reference cost becomes `C / 12 / measured units` (the amortised rate design-ai-layer §11 already defines) |
| C — minimum + usage | ~250 at a SAR 60k minimum | floor then linear | none |
| D — reserved + overage | ~500 | block then linear | none; size the block to measured P75 × N |
| E — dedicated replica | ~1,000 (one), ~2,500 (pair) | step function | none |

**The entitlement design's promise holds under all five:** the customer's
allowance is in actions; the provider's cost enters only through the AI Unit's
reference cost and the weight table. What changes between structures is
*whether the business can afford the contract at its customer count*, and the
grids above are the answer to that question for any `C`, `R` or `k` the owner
is eventually quoted. **Rule derived from the grids: no non-linear AI
contract before ~500 paying organisations and 90 days of `ai_usage` history;
until then, per-token.**

---

## 8. The AI Unit — the provider-independent internal measure

```
1 AI Unit = the reference cost of one categorization second opinion
            ≈ 860 tokens on the cheapest production text model
            = $0.000078 on the Groq card today (SAR 0.00029)

Weights (units per action), CALCULATION from §2:
  categorize 1 · reconcile 1 · explanation 6 · question 10 · brief 18 · document 45

Plan pools implied by the strategy's allowances (questions × 10 + documents × 45):
  Basic  50 q + 75 d  ≈ 3,875 units  ≈ $0.30
  Pro   150 q + 300 d ≈ 15,000 units ≈ $1.16
  Adv   400 q + 1,000 d ≈ 49,000 units ≈ $3.79

Modelled consumption in units (background + requested):
  Basic    P50 698    P75 1,653   P90 3,708   P95 7,158   Heavy 24,518
  Pro      P50 2,438  P75 5,748   P90 13,758  P95 22,618  Heavy 88,418
  Advanced P50 8,384  P75 21,174  P90 47,054  P95 79,354  Heavy 280,554
```

When the provider changes: re-measure the reference cost, re-derive the
weights from the new card (a provider that prices vision at 2× text instead
of 10× makes `document` ≈ 9 units instead of 45), leave the customer's
"150 questions and 300 document reads" untouched. `ai_usage` already records
`provider`, `model`, `prompt_tokens` and `completion_tokens` per call (FACT),
which is everything the conversion needs, retroactively.

---

## 9. What to measure first, once the boundary flips

1. The real per-operation token profile (replace §2's assumptions with the
   `ai_usage` medians per `operation`).
2. The real usage distribution per plan (replace §3 with P50/P75/P90/P95 from
   90 days of rows) — and re-derive the allowances at the measured P90.
3. The real share of imported lines that fall below the 0.65 confidence
   threshold (the background categorization cost driver).
4. The real share of captures that reach the vision tail after QR + Tesseract
   (the entire document-read economics).
5. The vision model actually available (Groq Enterprise / Dammam, or the Saudi
   provider) and its card — §2's document row is the one most likely to change.
6. Infrastructure cost per org at the first 100 organisations (the largest
   COGS line, and the one this document knows least about).
