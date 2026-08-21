# The AI Layer — REVISED SPEC + DECISION RECORD

**Status (2026-08-18):** interviewed, spec revised, **not commissioned to
build.** The team's draft ("AI Architecture & Token Consumption
Specification") is superseded by this document, which adopts seven
corrections the owner approved verbatim. Open questions in §10 stay open —
notably hosting (now inseparable from queue C6), Arabic, and the re-ask of
the Auditor/CFO moments. No build order exists; one will go to the owner as
a proposal when the open questions close.

---

## 1. The interview record (owner answers, relayed 2026-08-18)

| Q | Answer | Standing |
| --- | --- | --- |
| What makes a tenant unable to leave? | **The full generative product**: "does my bookkeeping automatically, gives me detailed answers about my business, helps me find answers to make business decisions, and provides a specialist AI accountant to do my books, fix my problems, do my audit — cheaper than an internal auditor." | ✅ Decided. Trips the hosting trigger by definition (hub-structure §4). See §9 for the honest rename of "audit". |
| Constraint ranking | **(a) data residency FIRST, (b) quality second, (c) cost last.** | ✅ Decided. |
| Data boundary | **Absolute**: "everything is fair game as long as all information stays in our platform and the AI does not send information to a mother company." | ✅ Decided. **Rules out hosted model APIs entirely.** Open-weight, self-hosted models only. |
| Training on tenant data | Owner said OK. | 🔴 **Owner-preference-PENDING-LEGAL** — a PDPL question; goes to the advisor with C7/C8/C10. Not a decision. Until answered, correction pairs are collected (they already are, as ScanReview provenance) but nothing trains on them. |
| The three vision names as concrete moments | **Accountant**: document → extraction → proposed entry → human review (§2–§6). **CFO**: ON DEMAND — the user asks before making a decision; consulting, never a scheduled report. **Auditor**: BOTH — on demand ("check this for me") AND scheduled, quarterly by default, monthly if the customer opts in. (Answered 2026-08-18.) | ✅ Decided. See §2b for the two consequences the schedule creates. |
| Arabic | **A LAUNCH requirement, not a fast-follow** (owner, 2026-08-18). Both layers: reading Arabic documents, and answering in Arabic. | ✅ Decided. **A HARD GATE on model selection, not a preference** — see §2a. |
| Is AI usage metered per tenant and billable? | **Yes — confirmed.** That is why token tracking is in the spec. | ✅ Decided. |

**Settled elsewhere and not reopenable here:** AI proposes and never posts;
state WHERE a change came from, never WHY it happened (business causation —
distinct from a model explaining its own proposal to its reviewer, which is
allowed and wanted); AI is the moat, not the wedge; no navigation entry —
AI appears inside the pages where the work happens.

---

## 2. The two-model scheme (kept, with corrected boundaries)

| | Document intelligence | Accounting intelligence |
| --- | --- | --- |
| Model (today's choice — see §8) | Qwen vision-language class. 🔴 **The draft's "Qwen 3.6-27B" is not a verifiable model identifier — pin the exact ID before anything else**; the layer requires vision, and Arabic strength differs sharply within the family. | `gpt-oss-120b` (117B MoE, ~5.1B active, MXFP4 — fits one 80 GB GPU; open-weight, Apache-2.0). |
| Input | Image + text — **inside A1's pipeline** (§3). | Text + structured data ONLY. Never raw documents. |
| Output | Structured extraction (JSON), field-level, with provenance. | Proposed **classifications and document fields** (§5) + plain-language explanation of its own proposal; findings (§9); grounded answers (unspecced — awaits §10). |

## 2a. 🔴 ARABIC IS A HARD GATE ON MODEL SELECTION (owner, 2026-08-18)

We sell to Saudi SMEs: their receipts and bank statements are in Arabic.
**Whatever models are chosen must be benchmarked on Arabic financial text
BEFORE selection, using our own correction pairs where they exist** —
Arabic receipt extraction for the document layer, Arabic answers and
explanations for the reasoning layer. **A model that reads English receipts
well and Arabic receipts poorly FAILS the requirement regardless of its
other scores.** No model is pinned (§2's ID question included) until its
Arabic numbers are measured.

Why this is a gate and not a preference: the `\b` incident — sixty Arabic
patterns silently dead for months because an ASCII word-boundary matches
nothing in Arabic script, found only by accident. That is precisely the
failure shape a model reintroduces at higher stakes: an English-strong
model DEGRADES on Arabic rather than erroring, which is the
silent-substitution class (the small-ICU lesson) applied to language.
"It produced output" is not evidence it read the document.

## 2b. 🔴 The Auditor's SCHEDULE creates two obligations (owner, 2026-08-18)

**1. Scheduled findings arrive UNASKED — the quiet-neglect shape.** A
quarterly finding nobody opens is worse than no finding, because the system
believes it told them. The scheduled run uses the existing job
infrastructure (the M12.8/M18 scheduler) and gets the same treatment as the
outbox-age alarm: findings are **visible and ideally pushed** (the B1/B2
posture — a channel, not a panel), never a page waiting to be found. A run
that produces findings nobody has seen after a stated interval is itself a
condition worth surfacing.

**2. C9/C10 bites HARDEST here.** A scheduled "audit" arriving quarterly
with compliance findings, against tax rules we have not verified, is the
worst version of that risk — **it looks authoritative precisely because it
arrived on a schedule.** The §5 sequencing rule therefore applies with
extra force to the scheduled path: internal-consistency findings
(duplicates, gaps, unreconciled items, violations of the tenant's own
rules) may ship before C9/C10 close; anything asserting a tax or compliance
position may not. And the §9 naming correction matters MORE given the
schedule, not less: findings and review assistance, never "audit".

## 3. 🔴 Correction 3 — Qwen lives INSIDE A1, not beside it

The draft's `Upload → Document Service → Qwen` re-invented the existing
capture pipeline. The revised flow: Qwen **replaces the extraction engine
within A1** — phone/upload capture → staged capture → extraction →
ScanReview → promotion through the approval engine — inheriting staging,
field-source provenance, retention posture, and the review surface that
already exist.

🔴 **QR-derived fields are never overwritten by model output.** The ZATCA QR
TLV is the authoritative, deterministic reading of seller, VAT number,
totals, and timestamp; the model reads only what the QR does not carry. (The
partial-data lesson: a model "improving" ground truth is corruption wearing
a quality costume.)

## 4. 🔴 Correction 4 — the categorizer stays the production brain

The 1,191-line deterministic engine remains first; the model is the
**escalation second opinion below the existing 0.65-confidence seam**
(`llmCategorizer`'s architecture, which was right all along — only the
backend behind it changes). Routing everything through a 120B would reverse
a working cost/quality architecture and multiply per-transaction cost for
rows the rules already classify well.

## 5. 🔴 Corrections 2 + 5 — the model SELECTS, it never AUTHORS

- The model proposes a **classification from the tenant's chart** and
  document fields. It does not propose debit/credit lines. **Ledger lines
  follow deterministically through the existing posting paths**
  (`transactionPosting`, the bill/invoice services) — one writer per
  effect; no second posting vocabulary. This is what the draft's own §9
  ("the ledger is the source of truth") requires; the Dr/Cr phrasing
  undermined it.
- **Tax consequences attach deterministically** from the platform's
  treatment rules, `verified/assumed` flags intact, DB CHECKs unarguable.
  The model never generates a tax position from training data. **C9/C10
  remain the single gate for tax content.**
- 🔴 **Sequencing consequence, recorded:** no AI findings that assert
  compliance ("this VAT treatment is wrong") ship before C9/C10 close —
  that would be auditing against unverified rules. Findings that assert
  *internal consistency* (duplicates, gaps, unreconciled items, policy
  violations against the tenant's own explicit rules) do not wait.

## 6. 🔴 Correction 1 — the approver is a PERMISSION, not a profession

Review/approval uses the existing M10 role model: **a human holding the
approve permission**, which in most tenants is the owner. Design
requirement recorded with it: **the proposal must be reviewable by a
non-accountant, with the document beside it** — "this receipt becomes a
SAR 850 telecom expense", never a bare Dr/Cr pair. A review surface only an
accountant can read turns SME-first into firm-first by accident.

## 7. 🔴 Correction 6 — the provider-agnostic seam

All model calls route through one interface (the `KeyWrapper` /
`ArchiveStore` hedge, required by hub-structure §4): today's models are a
configuration, not an architecture. Two implementations at launch (the two
models above), each behind the same seam; the deterministic engines are not
behind it — they are the floor the seam degrades to.

## 8. Failure posture (folded in)

Capture works **client-side today** (Tesseract OCR + QR TLV) and keeps
working with every model down: client extraction is the always-available
first pass, Qwen is enrichment. A model outage degrades quality, never
availability, and is **visible** (the B1/B2 posture: a silently-inert AI
layer is the alarm-shaped failure) — surfaces show "AI unavailable — rules
only", and the escalation seam simply returns the deterministic result, as
`llmCategorizer` already does.

## 9. 🔴 Correction 7 — findings, not "audit"

The product word is **findings / checks / review assistance** — never
"audit", at any hosting choice. An audit is a professional act with a
liability posture no model carries; the honest distance between
"audit-flavoured findings" and "an audit" is not closable by model size.
The vision sentence's "do my audit" is served by: continuous findings over
the ledger (most of them deterministic, model-triaged and model-explained),
named as what they are. Same family as the Zakat "working paper, never a
submission" decision.

## 10. 🔴 What is OPEN, and what the openness blocks

| Open | Blocks |
| --- | --- |
| ~~Hosting~~ → ✅ **DECIDED-PENDING-ENTERPRISE-TERMS** (§12a): Groq, Reading A, Dammam. What remains open is the COMMERCIAL half — Enterprise terms/pricing for Dammam pinning + ZDR, and an Arabic-acceptable vision model in that region. | 🔴 **Tenant data reaching Groq is BLOCKED until the Enterprise agreement is signed.** Model development proceeds on fixture/dev data behind the seam. |
| ~~Arabic~~ → ✅ DECIDED (launch requirement, hard gate — §2a). What remains open is the **measurement**: the Arabic benchmark itself, built from correction pairs plus a curated Arabic receipt/statement set. | Model pinning stays blocked until the Arabic numbers exist. |
| **Q2 re-ask** — the Auditor and CFO *moments*. | The findings surface's shape; the entire ask-your-books/conversational surface, which Q1 promises and this spec deliberately does NOT spec yet. When it is specced: grounded tool-use only — the model queries our deterministic endpoints and narrates THEIR numbers, never its own. |
| **Exact Qwen model ID** (draft's identifier unverifiable). | The document layer. |
| **Training-on-tenant-data** (owner-pref-pending-legal, §1). | Any learning loop; v1 learns nothing from rejections. |

## 11. Metering and billing (confirmed)

AI usage is **metered per tenant and likely billable**. Every model call
writes an append-only, org-scoped usage record (customer, user, model,
operation, input/output tokens, linked document/transaction, timestamp,
status) — the M14 table posture applies (RLS + grant revokes; SELECT +
INSERT only). Dashboards and the PDF report follow the draft.

🔴 **"Estimated cost" defined** (folded in): self-hosted models have no
per-token market price. Cost = an **internal amortized rate** — (GPU +
hosting cost per month) ÷ measured monthly token throughput — recomputed
from observed load, labelled "estimated" in every surface, and never
presented as a market price. The rate's inputs are configuration; the
arithmetic is not.

## 12. 🔴 THE COST OF RESIDENCY-FIRST — read before committing

Two GPUs minimum (1×80 GB for gpt-oss-120b + 1×48 GB for the vision model):
**~$3,000–4,500/month for ONE always-on replica with NO redundancy** at
cloud rates (~$4–6/hr), or roughly $35–55k capex plus hosting. The shape is
worse than the number: SME workload is bursty and low-volume, so a
dedicated replica idles most of the day — **cost per document is very high
until tenant count grows** — and scale-to-zero means multi-minute cold
starts for a 120B model. This is the real price of residency-first ranking
(vs near-zero marginal cost on hosted APIs), and it is a floor, not an
estimate of scale. In-Kingdom GPU availability (STC, Ezditek/DataVolt,
HUMAIN-era sovereign offerings, the AWS KSA region) was
announced-in-various-states as of the spec date — 🔴 **verify against
providers during C6, not from memory.**

## 12a. HOSTING OPTIONS ANNEX — ✅ DECIDED 2026-08-18 (owner): GROQ, READING A — **PENDING-ENTERPRISE-TERMS**

**The decision:** Groq under Reading A — contractual Zero Data Retention,
no training on our data, **Dammam-region processing**. The provider seam
(§7) keeps it reversible.

🔴 **Recorded honestly alongside it (owner instruction):** Dammam pinning
is an **Enterprise arrangement, not a configuration flag** — standard tiers
route globally. The residency half of this decision is therefore contingent
on a commercial agreement that does not yet exist. Status:
**decided-pending-Enterprise-terms**, and 🔴 **the signed
Enterprise/Dammam+ZDR agreement is a BLOCKING item before any tenant data
reaches Groq** — until it exists, model calls carry fixture/dev data only.

The analysis that produced the decision is kept below, per the
§6b-of-fiscal-periods precedent: the numbers must survive the conversation.
Facts verified against Groq's published docs and press on 2026-08-18.

### The three readings of the Q5 data-boundary answer

The owner's words support more than one reading, and the options split on
which was meant:

- **Reading A — "no one keeps or learns from our data."** Satisfied by
  Groq with Zero Data Retention: no training on inputs/outputs by default,
  no retention with ZDR enabled (self-serve, org-wide or per-feature).
- **Reading B — "our data is never processed on infrastructure we don't
  control."** During inference the ledger context exists in plaintext in
  the provider's memory, ZDR or not — ZDR governs what is KEPT, not what is
  SEEN. No hosted API satisfies B; only self-hosting does.
- **Reading B′ — "our data never leaves the Kingdom."** Groq operates a
  production region in **Dammam** (built with Aramco Digital, operational
  since Feb 2025, ~19,000 LPUs, HUMAIN's inference backbone).
  Region-pinned inference satisfies B′ while failing B. 🔴 Pinning is an
  **Enterprise-tier arrangement negotiated with Groq** — standard tiers
  route globally (in practice, the US; Groq's retained-data buckets are US
  GCP).

### The options and their real costs

| # | Option | Satisfies | Cost shape |
| --- | --- | --- | --- |
| 1 | **The hybrid we already have** — deterministic engines local (zero cost, always available); a model only for escalations + reasoning. True under every option below. | — (shrinks the exposed surface; the surface is still ledger content) | $0 for the floor |
| 2 | **Groq Dammam Enterprise + ZDR + minimization-redaction** (strip VAT numbers / IBANs / person names before any call — worth doing regardless; see the redaction verdict below) | A + B′, not B | gpt-oss-120b at **$0.15 / $0.60 per 1M tokens** (halved by caching and batch; ~500 tok/s). At generous SME volumes (~2M tokens/tenant/month): **~$0.50–1 per tenant per month**. No idle cost, no cold starts, no GPU ops. Enterprise premium for pinning: UNKNOWN — C6 verify item. |
| 3 | **Small local GPU for document IMAGES + hosted (ZDR) for structured text** — a ~30B vision model on one 48 GB card keeps raw receipts fully in-platform; only extracted, minimized text leaves. | A + "nobody else ever sees our customers' actual receipts" | **~$1–1.5k/month** for the vision card + option 2's per-token costs for reasoning. The middle ground if the emotional core of the constraint is the images. |
| 4 | **Full self-hosting** (§12) | A + B + B′ | **~$3,000–4,500/month floor**, one replica, no redundancy, bursty-idle shape; ~$0.50/tenant on Groq vs this floor puts API/self-host parity somewhere past **1,000–6,000 tenants**. |

### Redaction verdict (asked 2026-08-18)

Redaction meaningful enough to matter destroys the signal: the document
layer's input IS the raw image; classification depends on the identifying
token ("SADAD PAYMENT — STC" classifies *because* it says STC); and the
sensitive thing is not the PII but the ledger itself — amounts, dates and
counterparty patterns are both what Q5 protects and what the reasoning
layer exists to reason over. Redaction is a useful MINIMIZATION layer,
never a mechanism that turns a hosted API into "data stayed within our
organisation."

### Advisor questions this adds (joins the C7/C8/C10 package)

PDPL Art. 29 + SDAIA Transfer Regulations make cross-border transfer a
regulated path, not a prohibition. For the advisor: (a) is ZDR-transient
processing abroad a "transfer" in the regulation's sense? (b) does
Dammam-pinned processing by a US company's KSA region raise a transfer
question at all, plus NCA/sector overlays? (c) note the tension already on
file: "training on tenant data is OK" (owner-pref-pending-legal) and ZDR
are mutually exclusive — ZDR leaves nothing retained to train on.

### 🔴 Two things to VERIFY inside C6 (owner-directed)

1. **Groq Enterprise terms and pricing for Dammam region pinning.**
2. **Whether a vision model with acceptable ARABIC is available in that
   region** — the Groq path likely means Llama 4 vision rather than Qwen,
   and §2a's Arabic gate decides either way, on measured numbers.

## 13. The eval harness gates shipping (folded in)

The platform already accumulates labelled pairs: ScanReview's
extraction-vs-human-correction, and the review queue's proposal-vs-override.
**These are the acceptance test set.** Before either model ships behind its
seam: measure it against the accumulated pairs (extraction field accuracy;
classification agreement with human-accepted outcomes), record the measured
floor, and let the number gate the release — the standing live-verification
rule applied to a model. A model feature shipped without a measured floor
is a confident zero wearing a demo.

🔴 **The harness reports Arabic and English SEPARATELY, always** (§2a). A
blended score is how an English-strong model passes while failing the
customer — the aggregate hiding the segment is the same arithmetic that hid
sixty dead patterns behind a suite that was mostly green. The Arabic floor
gates selection; the blended number is not a gate at all.

## 12b. Free-tier boundary (owner decision, 2026-08-21)

Groq's **free tier is in use for development now**, ahead of the Enterprise
agreement. The boundary, stated so it cannot be blurred later:

**Free tier = no Enterprise agreement = no Dammam pinning. Requests route
globally.** Therefore:

| ✅ Allowed on the free tier | 🔴 Never on the free tier |
| --- | --- |
| The provider seam (build + exercise it) | Any real tenant's ledger rows |
| The Arabic benchmark (§2a) | Any tenant's receipts or captured documents |
| Model evaluation / comparison | Anything derived from tenant data (names, amounts, patterns) |
| Pipeline testing on **synthetic fixtures** | — |
| Measuring real token consumption per operation | — |

The §12a blocking rule stands unchanged: **the signed Enterprise/Dammam+ZDR
agreement remains a blocking item before any tenant data reaches Groq.**
"Development" is not an exception to that rule — it is the reason the fixtures
must be synthetic. When the team gets Enterprise access, the seam's provider
config changes; nothing else should have to.


## 12c. Groq outreach list (ask together, owner 2026-08-21; reordered 2026-08-21)

Questions for the ONE Enterprise conversation, so nothing needs a second ask.

1. 🔴 **FIRST, because it may reopen a closed decision: is ANY vision model
   available to us, on any tier?** Measured fact (2026-08-21): our account's
   `/models` catalog exposes **no vision model at all** — so the question is
   no longer "which vision model in Dammam?" but "does Groq serve us one
   anywhere?", and only then "is it Arabic-acceptable, and is it in Dammam?".
   **If the answer is no, the document layer (A1's extraction) needs a
   different provider or a local GPU — which reopens the §12a hosting
   decision for that layer.** Get the answer in writing before the receipt
   corpus is spent benchmarking anything.
2. **Enterprise terms**: Dammam-region pinning + contractual zero-data-
   retention + no-training — the Reading-A package §12a records as
   decided-pending-terms.
3. **Practical riders, one sentence each**: Enterprise TPM limits per model
   (free tier measured at **6,000 tokens/min** — a real 429, org-tier
   `on_demand`); token pricing at Enterprise tier (the metering table prices
   against it); whether region pinning is per-request or per-account; and
   whether the text catalog differs by region (gpt-oss-20b is our measured
   Arabic leader — confirm it exists in Dammam).

## 12d. AI-1a as built (2026-08-21)

- **The seam**: `services/ai/provider.ts` — `AiProvider` (chat + vision),
  `GroqProvider` as dependency-free REST against the OpenAI-compatible
  surface, injectable fetch for tests. 🔴 The B3 rule is the contract:
  unavailable THROWS (`AiUnavailableError`) — HTTP error, timeout, empty 200
  are all one honest category, never a silent "". Callers own degradation.
- **The boundary, enforced at BOOT**: `loadEnv` refuses `AI_PROVIDER=groq` in
  production unless `GROQ_DATA_BOUNDARY_ACK="enterprise-dammam-zdr-signed"` —
  a typed attestation, not a boolean a deploy template flips. Dev/test boot
  with just the key, which is the fixture-data case the owner's boundary
  allows. Tested in both directions, incl. a wrong attestation string.
- **Metering**: `ai_usage` (migration 0055) — per-tenant, RLS'd, append-only
  at the grants; one row per call via `meteredChat`/`meteredVision`;
  🔴 failures are rows too (`ok=false`) — rate-limit failures are half of what
  free-tier measurement is for. Known limit, recorded not hidden: metering
  shares the caller's tenant transaction, so a request that rolls back
  entirely takes its usage row with it; the categorizer's degrade path
  commits, so its failure rows survive (pinned by test).
- **First consumer**: the categorizer's below-0.65 second opinion routes
  through the seam when `AI_PROVIDER=groq` (metered as
  `categorize_second_opinion`), with the legacy local Ollama path intact.
  The deterministic engine stays the brain in every case.

## 12e. AI-1b as built (2026-08-21) — the benchmarks

- **Categorizer benchmark** (`pnpm benchmark:categorizer`): a hand-curated,
  labeled corpus of realistic Saudi statement lines (`categorizerCases.ts`) —
  🔴 NOT generated by inverting the engine's regexes, which would test whether
  the model matches our matcher (an oracle sharing the defect it should
  detect). Arabic / English / mixed scored SEPARATELY with hard-case subsets;
  the §2a gate is printed as a VERDICT (>15-point EN-vs-AR hard-case gap =
  FAIL), and three "honest-null" cases score RESTRAINT — inventing a category
  for an unclear line is wrong even when plausible. Measured baseline without
  any model: EN 60% (hard 40%), AR 62% (hard 44%) — the hard-case headroom is
  what the second opinion exists to close, and now it is a number.
- **Vision harness** (`pnpm benchmark:vision`): built BEFORE the corpus so the
  owner's receipt photography feeds it incrementally.
  `docs/ai/receipt-benchmark/README.md` states what to photograph (50–150 of
  the owner's OWN receipts — thermal/tax-invoice/handwritten/bad-photos,
  ar/en/mixed) and the labels.csv contract; images are gitignored, labels
  committed. 🔴 An empty corpus is a LOUD "NOT RUN — nothing was measured;
  this is not a pass". Scores per field (vendor/date/total/vat) per language;
  VAT scoring includes restraint (inventing a VAT the paper doesn't print is
  wrong); Arabic gate as a verdict.
- Both run as the DEV org through the metered wrapper, so every run also
  reports MEASURED token consumption and failure counts from `ai_usage` — the
  benchmark is a consumer of the meter, and free-tier rate-limit behaviour is
  part of what gets measured.

## 12f. Free-tier numbers, v2 (2026-08-21) — after the harness itself was debugged

Corpus: the 49-case synthetic benchmark (§12e); baseline (deterministic only)
EN 60% / hard 40%, AR 62% / hard 44%. All rows below are **no-hint mode**
(the anchoring control) with reasoning-effort control in the seam.

| Model | Calls ok | AR overall | **AR hard** | EN hard | Reading |
| --- | --- | --- | --- | --- | --- |
| **openai/gpt-oss-20b** (effort=low) | 19/21 | **95%** | **100% (9/9)** | 50% | **The Arabic leader once measurable.** |
| openai/gpt-oss-120b (effort=low) | 15/21 | 86% | 78% | 60% | Strong; 6 calls still empty at low effort — dropped calls fall back to deterministic and drag the score. |
| allam-2-7b (SDAIA) | 16/21 | 71% | 56% | 50% | Solid, cheapest/fastest; TPM-throttled (6,000/min measured). |
| qwen/qwen3.6-27b | 21/21 | — | — | — | 🔴 **NOT MEASURED.** See below — a row that says "baseline" here would be an artifact wearing a result's clothes. |

**Why qwen is NOT MEASURED, after two discriminating experiments:** it reasons
to the CORRECT answer inside `<think>` (observed verbatim) and then truncates
before emitting it — at every budget tried, with the `/no_think` soft switch
ignored by this deployment. The earlier "exactly baseline, 21/21 ok" row was
the parser extracting the format placeholder from the model's own thinking:
an artifact that looked like a result, which is worse than a failure (owner's
framing, adopted as the rule: **an unmeasured model's row says NOT MEASURED,
never "matches baseline"**). Next lever if wanted: Groq's qwen-specific
reasoning parameters.

**Standing caveats:** n = 9–10 hard cases per language (one case ≈ 10
points); dropped calls fall back to the deterministic answer and are mixed
into hybrid scores; single-digit run counts. Directional, not a ranking —
but the direction is now real model output end to end.


## 12g. 🔴 A finding AGAINST this spec, and the next milestone (owner, 2026-08-21)

### The spec's model-class assumption may be wrong — in the cheap direction

This document assumed the LARGER reasoning model (gpt-oss-120b-class) for the
generative layer. The first measured evidence points the other way:
**gpt-oss-20b beat 120b decisively on Arabic** (AR-hard 100% vs 78% on this
corpus), while being cheaper, faster, and completing more calls at low
reasoning effort. Recorded as a finding against the spec, not a leaderboard
row: **our own design's assumption about required model size is now the thing
under test**, and the error — if it is one — is in the direction that REDUCES
cost. Do not re-pin the spec on this yet; see the constraint below.

### 🔴 The binding constraint moved: it is now CORPUS SIZE, not model availability

9–10 hard cases per language means **one case is worth ~11 points** — enough
to reorder the table. Until the corpus is large enough that a single result
cannot move a verdict, no model-selection decision may cite these numbers as
settled. (Concretely: ~30+ hard cases per language puts one case at ~3
points; that is the working bar.)

### AI-2 — corpus expansion (the next AI milestone)

Grow the benchmark corpus until single results stop moving verdicts:

- **Target:** ≥30 hard cases per language (en / ar / mixed), plus
  proportionate easy and honest-null cases.
- **Discipline:** the same rule as the receipt labels — cases record **what
  the paper says** (realistic statement lines as banks print them), never
  regex-inversions of the engine and never lines written to flatter a model.
- **Density where the models disagree:** the existing per-case results tell
  us which categories confuse which models — expand THERE, not uniformly.
- **Sequenced after the owner's receipt labels begin arriving**, so real-paper
  edge cases inform the synthetic author (decision 2026-08-21: audit-logs UI
  ships first; AI-2 follows).
