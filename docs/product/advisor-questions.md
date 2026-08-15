# Advisor question package — ONE conversation, not three

**Purpose.** Three separate workstreams are blocked on professional advice, and
all three questions are cheap to ask together and expensive to ask serially.
This file is the single package. It exists so nobody re-derives the questions
from scattered queue entries, and so the answers land in one place.

**Assembled 2026-08-15** (owner instruction, at the M17.0 close-out).

| Block | Queue item | Blocks |
| --- | --- | --- |
| **A** | C7 | Retention duration for INBOUND supplier documents (A1 capture) |
| **B** | C8 | PDPL — erasure rights vs. our no-delete archive |
| **C** | Zakat design §4 | The Zakat base computation itself (M17.4) |

## 🔴 If one firm cannot cover both specialisms — SEQUENCE, do not split

A and C are Saudi tax/Zakat questions. B is data-protection law. Many Saudi
firms cover both in a regulatory practice; if yours does not, the instinct is to
send B to a separate data-protection advisor. **Mostly wrong — and wrong on the
most valuable question in the package.**

**B2 is not a PDPL question. It is a CONFLICT question, and it has a tax half:**

> *"May inbound third-party captures be made erasable-with-audit without
> touching the outbound immutability guarantee?"*

Answering it requires knowing **whether ZATCA §5.5 immutability is actually
scoped to documents we generated** — which is a tax/e-invoicing question no
data-protection lawyer can answer — *and* whether PDPL compels erasure for the
inbound class, which no tax advisor can answer. Split it, and each side answers
half while **nobody owns the interaction**. The interaction is the entire
question.

**B1 has the same dependency in a simpler form:** "does PDPL erasure reach
documents we hold for tax purposes?" cannot be answered without knowing what the
tax retention obligation *is* — which is **A1**.

**So the separability is not block-shaped:**

| | Separable? | Why |
| --- | --- | --- |
| **A1, A2** | Tax only | Ask the tax advisor. |
| **C1–C5** | Tax only | Ask the tax advisor. |
| **B1** | ❌ Needs A1's answer as an input | It is a conflict between two obligations. |
| **B2** | ❌ Spans both — do not split | Half is ZATCA scope, half is PDPL. |
| **B3** | ✅ Mostly | Audit-log IPs, customer/employee records are pure PDPL — *except* the archive sub-part, which is another retention conflict. |

**The right shape when the firm covers only tax: run it in two passes, not two
tracks.**

1. **Pass one (tax):** A, C, and the ZATCA-scope half of B2 — "is §5.5
   immutability scoped to documents we issued, or to all documents we hold?"
   That is a tax question and it is the more determinate side.
2. **Pass two (data protection):** B, **carrying pass one's answers as inputs.**
   The data-protection advisor is then answering "given that retention
   obligation, what does PDPL require?" — a question they can actually answer.

Ordering matters because tax retention is the *constraint* and PDPL erasure is
what has to fit around it (or override it). Asking in the other order produces a
PDPL answer that the tax answer may simply invalidate.

---

## 🔴 How to read the answers back into the product

For each question below, the **"What changes"** row is the important one. It is
written *before* the answer so we cannot rationalise whatever comes back. If an
answer arrives that is not in the list, that is a signal the question was
mis-scoped — reopen it rather than picking the nearest listed branch.

---

## Block A — retention of INBOUND supplier documents (queue C7)

**Context.** The platform lets a user photograph a supplier's invoice or receipt
with their phone (A1 document capture). When that capture is posted to a bill,
it is promoted into the ZATCA archive.

**What we assumed, and it is only an assumption.** We retain inbound captures to
the same 6/11-year standard as outbound invoices we issued, as a conservative
default. Nobody has confirmed that inbound third-party evidence carries the same
obligation as documents we generated.

### A1. How long must an inbound supplier invoice/receipt be retained?

- **Assumed:** the outbound standard (6 years, 11 for certain cases).
- **Why it matters:** `retain_until` is written at promotion today but **nothing
  reads it** — nothing expires, enforces, or refuses deletion based on it. It is
  a stored intention, not a policy. Whatever duration comes back, an *enforcer*
  has to be built.
- **What changes:**
  - *Same as outbound* → build the enforcer; no architectural change.
  - *Shorter than outbound* → 🔴 **not implementable today at all.** Promoted
    captures live in `ArchiveStore`, which by design has no `delete`. A shorter
    retention means a deletable class of archived document, which is a design
    change (see B2), not a config value.

### A2. May inbound evidence be destroyed on schedule, or only retained *at least* that long?

- **Why it matters:** "must keep for N years" and "must destroy after N years"
  impose opposite mechanisms. PDPL (Block B) tends toward the second, tax law
  toward the first, and the conflict is the whole problem.
- **What changes:** a *must-destroy* answer makes B3 (deletable staging) a
  hard prerequisite rather than a hygiene item, and gives the platform a
  destruction obligation it currently cannot discharge.

---

## Block B — PDPL (queue C8)

**Context, stated plainly:** PDPL has never been considered anywhere in this
project. This is not only about document capture — audit logs hold IP addresses
append-only, the archive holds names and addresses for 6–11 years, and
`users` / `customers` / `employees` have no retention policy at all.

**Why it stopped being hypothetical:** ordinary users now photograph documents
in the ordinary flow, and posting a bill promotes that photograph into a store
that by interface design can never delete it. A third party's personal data can
be in frame. An erasure request for a promoted capture is today not "hard" —
it is **impossible by construction**, and that is true before we have answered
whether it is lawful.

### B1. Does PDPL grant an erasure right that reaches documents we hold for tax purposes?

- **What changes:** if tax retention is a lawful basis that overrides erasure for
  the *document*, the exposure narrows to everything else (audit-log IPs,
  customer records, inactive users) — which still needs a retention policy, but
  not an archive redesign.

### B2. 🔴 May inbound third-party captures be made erasable-with-audit without touching the outbound immutability guarantee?

**This is the highest-value question in the package.**

- **The distinction we are drawing:** ZATCA §5.5 immutability covers invoices
  **we generated**. A supplier's invoice **photographed by our user** is a
  different class of document. We currently give both the identical no-delete
  guarantee, which may be over-applying a rule meant for one of them.
- **What changes:**
  - *Yes, they are different classes* → the archive needs a class distinction
    (**never** a `delete` on `ArchiveStore`), and B3 becomes a real design task.
  - *No, treat them alike* → capture needs a **consent and data-minimisation**
    story instead: what we tell the user before they photograph, what we refuse
    to store, and how we justify indefinite retention of a third party's data.
- **Ask before more tenants photograph more documents.** Either branch is a
  design change, and the irreversible act is already reachable in the product.

### B3. What retention applies to the non-document personal data?

Audit-log IP addresses (append-only by design), customer and employee records,
inactive user accounts. **What changes:** each needs a policy and an enforcer;
the append-only audit log may need a redaction mechanism that preserves the
chain, which is a build, not a setting.

---

## Block C — the Zakat base itself (design doc §4) 🔴 M17.4 IS HELD ON THIS

**Context.** The owner has decided (Q1–Q8) that the platform produces an
auditable **Zakat Base Working Paper** — not a ZATCA submission — for
**100%-Saudi/GCC-owned** entities, derived **from the general ledger**. The
mechanism is decided. The *tax content* has never been checked against a primary
source, and the primary source is the **Zakat Collection Regulations issued by
ZATCA** and its implementing resolutions — not a summary, and not our own docs.

**M17.4 (the worksheet engine) is deliberately not being built until these are
answered.** A worksheet that computes confidently from unverified rules is the
same failure the old Zakat page already committed once, with better arithmetic.

### C1. 🔴 Is there a minimum-base rule tying the Zakat base to adjusted net profit?

**Ask this one first — it is the only question here that changes the
architecture rather than the arithmetic.**

- **Assumed:** none implemented.
- **Why it matters:** Q4 currently treats the income statement as a
  **cross-check** on the GL-derived base. If a floor exists (base may not be
  less than adjusted net profit, or similar), net profit becomes a **computed
  input** to the base, not a reconciliation of it.
- **What changes:**
  - *No such rule* → Q4 stands as written; build the derivation as specced.
  - *Such a rule exists* → Q4's shape changes: the worksheet needs an
    adjusted-net-profit computation as a first-class input, with its own
    adjustments and its own audit trail, and the two figures interact. Better to
    know before the derivation is built than to retrofit it.
- Also ask: are there **caps** on any deduction (commonly on deductible
  long-term assets)?

### C2. What exactly composes the base?

- **Assumed** (from Q4): additions — capital, retained earnings, provisions,
  long-term liabilities. Deductions — deductible long-term assets.
- **What we need:** the account-level list, and specifically **which provisions
  qualify** (all? only those added back? unapproved ones?). This drives M17.3's
  chart-of-accounts classification, so it is needed *before* M17.3, not only
  M17.4.

### C3. Confirm the Gregorian rate adjustment.

- **Assumed** (owner-supplied): `2.5% × Gregorian days ÷ 354`, ≈2.578% for a
  365-day year.
- **What we need:** the divisor (354 vs 354.367 vs a prescribed constant), and
  whether ZATCA prescribes a **rounding convention** for the resulting rate or
  only for the final amount.

### C4. Does nisab have any role in corporate Zakat?

- **Assumed: no.** The page we deleted applied a personal-Zakat nisab from a
  gold price to a company, which we believe is a category error.
- **What changes:** if nisab genuinely has no role, we will **say so explicitly
  in the UI**, so its absence reads as a decision rather than an omission. If it
  does have a role, we need the threshold's source and update cadence — a
  hardcoded constant is exactly what we just removed.

### C5. Mixed and foreign ownership — confirm v1 is right to decline.

- **Assumed:** out of scope (Q2). The real treatment apportions between Zakat
  (Saudi/GCC share) and income tax (foreign share); v1 hides the surface with a
  notice rather than approximating.
- **What we need:** confirmation that declining is the right posture, and
  roughly what the apportionment would require, so v2 can be scoped rather than
  guessed.

---

## What to do with the answers

1. Record them **here**, with the date and who gave them — not only in code
   comments.
2. Flip the affected queue items (C7, C8) and the design doc's §4 table from
   assumed to verified, citing the source.
3. **Only then** start M17.4. C2 is needed earlier still — before M17.3's
   chart-of-accounts classification.
4. If an answer contradicts something already built, treat it as a finding and
   record it in [`docs/history/findings-and-lessons.md`](../history/findings-and-lessons.md).
