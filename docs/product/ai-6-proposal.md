# AI-6 — the CFO surface: DECIDED (owner answers, 2026-08-24)

**Status (2026-08-24): §4's questions ANSWERED; option A is COMMISSIONED as
AI-6a. §0 is the decision record; the proposal below is preserved as what
the answers were given against. Current state authority: CLAUDE.md §2.**

## 0. The answers (owner, 2026-08-24 — reasoning preserved)

| Q | Answer | The owner's reasoning |
| --- | --- | --- |
| 1. Register | **A — FACT + PROJECTION only. 🔴 B is QUEUED for post-C10, not rejected.** | "Opinion would be the platform's first unverifiable voice, and introducing it before the tax content is verified and before we have a single customer means shipping something we can't stand behind with no evidence anyone wanted it. Projection answers the hiring question without advising — the owner draws the conclusion, which is what an accountant leaves them to do anyway." **The honest cost, chosen deliberately: FACT+PROJECTION is a CFO that shows its work and never advises.** (Q2 — the fence — travels with B into the queue.) |
| 3. Tool scope | **Analytics + Finance Hub computations.** | "Those are already the questions tenants ask; a tool surface wider than the reports is scope with no demand behind it." |
| 4. Persistence | **Stored and auditable.** | "'What did the AI tell the tenant' must be answerable — and given B may arrive later, the record needs to exist BEFORE the unverifiable register does, not after." |
| 5. Placement | **Inside Analytics and the Finance Hub**, per the hub decision. No new destination. | — |
| + | 🔴 **A projection's assumption is stated IN the answer — never a footnote or tooltip.** | "'Holding the last six months constant' is the load-bearing part of the sentence, and an assumption a reader can skip is an assumption they'll skip." Mechanically enforced: the assumption sentence is part of the tool's output, and the verifier REJECTS an answer that uses the tool's numbers without it. |

Parent records: [`design-ai-layer.md`](design-ai-layer.md) (the interview:
CFO = on-demand consulting before decisions, never a scheduled report) and
[`ai-build-order-proposal.md`](ai-build-order-proposal.md) (AI-6 listed as
"needs its own design pass — grounding, refusal behavior, 'state WHERE never
WHY' applied to generated prose").

## 1. The verdict the owner asked for, stated before any design

**AI-6 as the interview envisioned it is NOT fully deliverable inside the
where-never-why constraint.** The question "can I afford to hire someone?"
decomposes into three registers, and they have different verdicts:

| Register | Example content | Verdict against the constraint |
| --- | --- | --- |
| **FACT** | "Your cash balance is X. Your trailing-6-month average net cash flow is Y. Your open payables total Z." | ✅ **Fully inside.** These are the platform's own computations, rendered — AI-3b's generate-then-verify generalizes directly (every number must trace to a computation the platform ran). |
| **PROJECTION** | "At that average, an added cost of 8,000/month reaches zero cash in N months — **holding the last six months constant**." | ✅ **Inside the constraint's spirit, with conditions.** No causal claim, no judgment — IF-THEN arithmetic whose inputs trace to platform computations, whose formula is deterministic and named, and whose assumption is **stated in the answer, never implied**. This is new machinery (a projection is not a report) and needs its own verification design (§3), but it does not infer WHY anything happened or SHOULD happen. |
| **OPINION** | "Yes, you can afford it." "You should wait a quarter." "Expenses rose because of fuel prices." | 🔴 **Outside, irreducibly.** This is exactly the inference the rule forbids everywhere else — unverifiable by construction; a verifier can fence it, never prove it. **Deliverable only by relaxing the rule**, and per your instruction that is said here plainly rather than designed around. |

**The honest cost of staying inside:** the interview's "consulting" value —
"helps me find answers to make business decisions… a specialist AI
accountant" — lives substantially in the OPINION register. Registers 1+2
alone produce a CFO that **shows its work but never advises**: it answers
"what do my books say, and what does the arithmetic look like under stated
assumptions," and then says *"the decision is yours."* That is a genuinely
useful product — and it is a smarter report, not a consultant. Choosing it
should be done knowingly, not by drift.

## 2. The three options (a decision, not a recommendation in disguise)

**A — Registers FACT + PROJECTION only.** The constraint intact. The
product: ask your books a question; get figures, derivations, projections
with stated assumptions, and honest refusals when the books cannot answer.
Revisit OPINION later with usage evidence.

**B — Additionally license OPINION as a FENCED register.** Model judgment,
explicitly marked as the model's opinion and never the platform's voice;
always accompanied by the FACT/PROJECTION evidence it rests on; hard
exclusions regardless of the fence — **no tax or compliance opinions before
C10 closes** (the §2b gate at its maximum: an opinion is the most
authoritative-looking output there is), no legal positions, no claims about
the world outside the tenant's books. Honest cost, stated: this would be
the platform's **first unverifiable voice** — the exact class this codebase
has spent its whole history removing. A fence is a promise kept by review,
not by construction.

**C — Defer AI-6 entirely** until C10 and the Enterprise agreement close,
then decide with real usage data from findings and explanations in hand.

## 3. Mechanics common to A and B (sketch, not commitment)

- **Grounding is tool-use over the EXISTING report services.** The model
  SELECTS named deterministic computations — income statement, cash flow,
  aging, VAT position, budget variance, a runway-projection function — and
  never writes SQL, never receives raw tables, never authors a number. "The
  model selects, never authors" (§5), extended from classifications to
  computations.
- **Verification generalizes AI-3b:** the allowed-number set for the
  answer's text is the union of tool outputs plus the stated assumption
  constants; the same cross-script canonical matching; the same
  discard-and-log posture; the same telemetry distinguishability.
- **Refusal is a feature.** A question the tools cannot answer gets "your
  books cannot answer that," not an improvisation — the honest-null
  discipline, conversational.
- **Answers are STORED and auditable** (proposed — Q4): "what did the AI
  tell the tenant" must be answerable, the same reason findings are rows.
- **Arabic both directions**; metered per tenant; **dark until Enterprise**
  by the existing boot boundary — this surface sends ledger data to the
  model by construction, so there is no free-tier tenant-facing mode at all.
- **Zakat is excluded in every register** (M17.4 held on C10), and
  tax-adjacent content follows the findings gate: figures yes, positions no.

## 4. The questions

1. **The register decision — A, B, or C.** The load-bearing one; everything
   else is downstream.
2. **If B: the fence.** What marks an opinion (wording, visual register)?
   Must every opinion carry its FACT/PROJECTION evidence inline? Which
   exclusions beyond tax/legal?
3. **v1 tool scope.** Which computations may the model call first? (My
   instinct: the ones already on Analytics/Finance Hub — they are the
   questions tenants already ask.)
4. **Persistence.** Stored Q&A rows (auditable, findings-style) versus
   ephemeral chat. I'd argue stored.
5. **Placement.** The hub decision weaves AI into pages with no nav
   destination — where does "ask" live? (Inside Analytics and the Finance
   Hub beside the figures it grounds on, is my instinct.)

## 5. AI-6a as built (2026-08-24)

**Six tools, all existing deterministic computations** (Analytics + Finance
Hub scope — Q3): liquidity, books status, tax-compliance figures, the
trend, the receivables bridge, and `runway_projection` — the one new pure
function, built on GL cash (the balance sheet's `cash`-class items, single
source, post-A) over a trailing six-month average. `decompose` deferred
(enum-argument complexity; an easy later add — recorded so the omission is
a decision). The model's only powers: pick ONE tool or refuse; render the
tool's output in both languages. Two model calls per answer (compose +
judge), metered.

**The pipeline:** select → compute → compose → verify (the AI-3b verifier
over the tool result, telemetry distinguishability intact) → 🔴 **the
assumption gate** — the projection's assumption sentences are part of the
TOOL output, and an answer using the tool without both of them verbatim is
REJECTED (`answer_rejected:assumption_missing`): "an assumption a reader
can skip is an assumption they'll skip," enforced by the machine → judge
(advice/causation = the opinion register, which does not exist → reject).

**Storage (Q4):** `grounded_answers` (0061), append-only at the grants —
every exchange a row, refusals included; **a rejected model output is
stored as a refusal WITHOUT the rejected text** (unverified prose is never
persisted). The record exists before any unverifiable register ever does,
as decided.

**The liquidity-claim rule carries over:** a runway projection on blocked
cash (suspense / undeclared transfers) is WITHHELD with the blockers named
— the tool returns no `monthsToZero` at all, so an answer asserting one
would fail verification. Pinned by a test that posts a real undeclared
transfer.

**Availability:** no deterministic floor exists for an answer, so
unavailability is an honest 503 and the UI hides the ask box via
`/ask/status` — dark for real tenants until the Enterprise agreement, by
the AI-1a boot boundary (ledger data reaches the model by construction).
Surface: one component inside Analytics and the Finance Hub (Q5), no
destination. 7 tests; grants: read all roles, ask = write-level.
