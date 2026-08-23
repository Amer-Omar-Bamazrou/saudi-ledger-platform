# The AI layer — build order: DECIDED (owner answers, 2026-08-24)

**Status (2026-08-24): all five §5 questions ANSWERED by the owner; AI-3a is
COMMISSIONED. §0 below is the decision record; §§1–5 are preserved as the
proposal the answers were given against. Current state authority:
CLAUDE.md §2.**

## 0. The answers (owner, 2026-08-24 — verbatim reasoning preserved)

| Q | Answer | The owner's reasoning, kept because it is load-bearing |
| --- | --- | --- |
| 1. Order | **Findings-first** (AI-3a → 3b → 4 → 5 → 6). | AI-3a reaches real tenants immediately (no model call, no tax position); vision is double-gated on the owner's receipt corpus AND the Enterprise agreement — "building the gated thing first means waiting on me twice." And findings-first **tests the surface with deterministic content** — how a finding is presented, whether anyone acts on it — before model output is riding on it. |
| 2. Tax gate | **(a) — internal-consistency only, until C10 closes.** | 🔴 "The line 'we cite an article' is exactly the line that erodes. Today it's Art. 50(1)(b), verbatim, verified. Tomorrow it's a treatment that's cited-but-assumed, then one where the citation supports the general rule and not the specific case." (a) is a clean boundary; (b) requires judgment every time, "and the whole reason C10 exists is that our judgment on tax content has been wrong twice." **Recorded as QUEUED, not lost: (b) is the intended widening once C10 closes, with the Art. 50 meal-VAT check as its first candidate.** |
| 3. Push channel | **In-app with unread-escalation, PLUS email to active admins. NOT the B2 webhook** (operator-facing; these are tenant findings). | The unread escalation is the load-bearing part: "a run whose findings nobody opened is itself a condition — the only answer to 'pushed, never parked' that survives a tenant who ignores email." And **a finding records where it was sent — otherwise 'we told them' is unfalsifiable.** |
| 4. Dark-launch | **Confirmed** — build and benchmark model-touching features on synthetic data now; enable for tenants by flipping provider config after the Enterprise agreement. | "Strictly better than idle waiting, **provided the boot-enforced boundary stays exactly as it is.**" |
| 5. Model pin | **Deferred** to Enterprise-negotiation time. | "Two cases of margin is not a capability difference"; cost, latency and Dammam-availability are the real discriminators, none known yet. "Pinning now would be choosing on the one axis that doesn't separate them." The seam keeps it reversible. |

**Commissioned by Q1+Q3: AI-3a** — the deterministic findings engine, with a
schema that records delivery from day one.

## 0b. AI-3a as built (2026-08-24)

**Eight checks, all internal-consistency, no model call, no tax position:**
duplicate bills (vendor+date+total), duplicate accepted transactions,
invoice-number gaps **as observations** (the finding's own copy states gaps
are lawful — C12; its value is having an ANSWER, advisor Block D1),
credit-aware overdue receivables (Tier 3's lesson: outstanding nets credit
notes, pinned by test), overdue payables, stale drafts
(invoices/bills/JEs > 14 days undecided), undeclared transfers, and
accepted-but-unposted rows.

**Findings are rows** (`findings`, migration 0058; RLS + the owner-table
revoke pattern; **no DELETE for the app role** — a resolved finding is the
record that it was found). Identity `(org, kind, ref_key)` makes re-runs
UPSERT; lifecycle: `open` → `acknowledged` (a human's review decision,
**survives re-detection — the machine never un-acknowledges a human**) →
`resolved` (machine-set when the condition vanishes; reopens if it returns).
`delivered` records where each finding was sent (Q3) — `in_app` stamped on
on-demand runs; AI-5's email/escalation writes the same column.

**Authority:** read = every role; run = write roles (it moves nothing);
**acknowledge = approver only** — dismissing a warning about money is a
review decision (`acknowledge` joined rbac's APPROVE_ROUTE; the bookkeeper
negative is pinned). Acknowledger names resolve via the identity layer with
M23's negative property.

**No severity anywhere, deliberately** — the status palette is reserved for
real states; a finding is a kind plus facts, rendered in words, bilingual.
Surface: `/findings` under Reports, beside the Finance Hub. Zero-movement
pinned through the real report services. 9 tests + the four guard suites.

Parent spec: [`design-ai-layer.md`](design-ai-layer.md) (the decision record
this proposes an order FOR — nothing there is reopened here).

## 1. What changed to make a proposal possible

Three prerequisites the spec was waiting on are now facts:

- **The measuring instrument is verdict-safe** (AI-2, §12h): 153 cases, 30
  hard per language, both authoring disciplines mechanized. One case moves a
  verdict ~3 points, not 11.
- **Two viable models exist, Arabic-strong** (84/84 clean calls each,
  no-hint): gpt-oss-120b AR-hard 83%, gpt-oss-20b 77%, both holding the §2a
  gate with Arabic as the STRONGER side. allam-2-7b is ruled out for hard
  cases (17% vs 13% baseline); qwen stays NOT MEASURED.
- **The categorizer second opinion is BUILT and wired** (AI-1a) — the seam,
  metering, and boot-enforced data boundary already run in the product.

## 2. The two boundaries every feature must be placed against

**Boundary A — the data boundary (commercial, blocking):** the free tier has
no Enterprise agreement, so no Dammam pinning and no ZDR — **synthetic and
dev-org data only; no real tenant's ledger, receipts, or documents**, no
exceptions for "development". The signed Groq Enterprise/Dammam+ZDR agreement
is the single switch that changes this. Consequence for sequencing: every
model-touching feature can be **built, benchmarked, and demo-run NOW** on
synthetic/dev data, and **dark-launched** (built but not enabled for
tenants) until the agreement signs. The owner's receipt corpus is the one
sanctioned real-paper input (his own documents, photographed for the
benchmark by decision).

**Boundary B — the tax gate (C9/C10, §2b):** no compliance-asserting AI
findings before the tax content is verified. The gate bites HARDEST on
scheduled output ("it looks authoritative precisely because it arrived on a
schedule"). What the gate does NOT block, per the spec's own carve-out:
**internal-consistency findings** — duplicates, numbering gaps, unreconciled
items, violations of the tenant's own rules. Where the line now sits after
C9 + C11: 21 of the treatment defaults are text-verified, four remain
assumed (RENTAL_INCOME, TRAVEL, LOANS, INVESTMENT_INCOME), and Zakat content
(C10) is entirely advisor-gated. **Question 2 below asks where you want the
line drawn.**

## 3. The proposed order (each phase: what it is, which boundary holds it)

| Phase | What ships | Boundary A (Groq) | Boundary B (tax gate) |
| --- | --- | --- | --- |
| **AI-3a — the findings engine, deterministic core** | The "Auditor's" internal-consistency checks as a real feature: duplicate documents/lines, invoice-number gaps *as observations* (C12: gaps are lawful; the finding is "here are your gaps", never "this is a violation"), unreconciled aging, drafts sitting unapproved past a threshold, undeclared transfers, unposted rows. Surfaced on-demand first; findings are rows with state (open/acknowledged), never a report file. | **NOT model-gated at all** — deterministic checks over the tenant's own ledger, no Groq call. Shippable to real tenants immediately. | Internal-consistency only — inside the carve-out by construction. |
| **AI-3b — model explanations on findings** | The §5 rule applied to findings: the model EXPLAINS a deterministic finding in plain Arabic/English (why this matters, what to look at), never authors one. Behind the seam, metered. | Buildable + benchmarkable now (synthetic); **tenant-facing only post-Enterprise**. Dark-launch. | Inherits AI-3a's class; explanation text carries the finding's own scope. |
| **AI-4 — vision inside A1** | Qwen-class (or measured alternative) replacing Tesseract as A1's extraction engine, QR fields never overwritten. **Sequenced on the owner's receipt corpus** — the vision harness is built and LOUDLY not-run; no model is pinned unmeasured (§2a). | Benchmark = owner's own receipts (sanctioned). Tenant receipts post-Enterprise only. | Extraction proposes fields into ScanReview — no tax position asserted; the existing gates hold. |
| **AI-5 — scheduled Auditor runs** | The quarterly-default/monthly-opt-in schedule over AI-3a's checks, with the two §2b obligations built in: findings are PUSHED (B1 mail / B2-style channel — question 3), and a run whose findings nobody opened after a stated interval is itself a surfaced condition. | Schedule itself is deterministic; explanations as AI-3b. | 🔴 The gate's hardest point. Ships with internal-consistency class ONLY until you widen the line (question 2). |
| **AI-6 — CFO on-demand / grounded answers** | The §10 unspecced surface. NOT proposed for building yet — it needs its own design pass (grounding, refusal behavior, "state WHERE never WHY" applied to generated prose). Listed so its place in line is explicit. | Post-Enterprise for tenant data. | Needs its own gate analysis in the design pass. |

**Why findings-first:** AI-3a is the only phase that reaches real tenants
without waiting on either boundary — it is pure product value from data we
already hold, it builds the surface the scheduled Auditor needs anyway, and
it exercises the §2b push-channel decision early, while the stakes are
lowest. Vision (AI-4) is the higher-value AI capability but is owner-gated
(receipts) and Enterprise-gated (tenant paper) — building it second means
its gates can clear in parallel while AI-3a ships.

**Model pinning: deliberately deferred.** Both gpt-oss models clear the
Arabic gate; the difference is two cases on a synthetic corpus. The pin
should happen when Enterprise pricing is on the table (capability evidence
is no longer the constraint — cost and the Dammam-region availability of the
chosen model are), and the seam makes the choice reversible until then.

## 4. What this proposal deliberately does NOT include

- Any training on tenant data (owner-preference-PENDING-LEGAL; advisor).
- Zakat-touching findings of any kind (C10 wholly open; M17.4 held).
- A second posting path, model-authored Dr/Cr, or auto-issuance — settled
  in the spec and not reopened.

## 5. The open questions (the proposal is not a plan until these are answered)

1. **Order.** Findings-first (AI-3a → 3b → 4 → 5 → 6) as argued above — or
   vision-first because receipts are the wedge's core promise and your
   corpus could start arriving now?
2. **Where exactly does the tax gate sit after C9 + C11?** Options, narrow
   to wide: (a) internal-consistency only until C10 closes (the spec's
   letter); (b) additionally allow findings derived ONLY from
   text-verified treatments (e.g. "meal VAT counted as recoverable —
   Art. 50 blocks it": C9-verified, deterministic, citable); (c) wider.
   (b) is attractive precisely because every such finding carries its
   citation — but it is a WIDENING of the spec's line, so it is yours to
   make, not mine.
3. **The findings push channel** (the §2b pushed-not-parked obligation):
   email via the B1 mailer to active admins, the B2 webhook family, in-app
   with an unread-escalation alarm — or some combination? This decision
   shapes AI-3a's schema (a finding must know where it was sent).
4. **Dark-launch pattern confirmed?** Model-touching features built and
   benchmarked on synthetic data now, enabled for tenants by flipping the
   provider config after the Enterprise agreement — versus not building
   model-touching code until the agreement signs.
5. **Model pin timing confirmed?** Defer to Enterprise-negotiation time with
   AI-2's numbers as the capability evidence — versus pinning now for
   development stability.
