# Advisor question package — ONE conversation, not one per question

**Purpose.** Several separate workstreams are blocked on professional advice,
and the questions are cheap to ask together and expensive to ask serially. This
file is the single package. It exists so nobody re-derives the questions from
scattered queue entries, and so the answers land in one place.

**Assembled 2026-08-15** (owner instruction, at the M17.0 close-out).
**Blocks are appended as they arise** — the title is deliberately not a count,
because it was already wrong once (it read "not four" while carrying five).

| Block | Queue item | Blocks |
| --- | --- | --- |
| **A** | C7 | Retention duration for INBOUND supplier documents (A1 capture). **Answered 2026-11-06** |
| **B** | C8 | PDPL — erasure rights vs. our no-delete archive. **Answered 2026-11-06**; two new questions in Block I |
| **C** | Zakat design §4 | The Zakat base computation itself (M17.4) |
| **D** | C12 | Invoice numbering in practice — gaps, and the Arabic reading |
| **E** | CoA design §9.4 | The seeded chart of accounts — and its **shared dependency with M17.3** |
| **F** | Invoice dating (§5) | Closed-period dating — does Saudi practice admit any exception? |
| **G** | C6 | Hosting, offshore AI, and where VAT records live |
| **H** | GOSI | The contributory-wage minimum and who the 2024 law covers |
| **I** | §5 | Still to ask, and to watch |
| **J** | S-1 | Qawaem's XBRL mapping. **Closed** |
| **K** | Owner's regulatory review, 2026-11-19 | 🔴 The accountant FIRST: correcting an approved payroll run. Then the framework per tenant, the `manual` policy for untraceable entries, and (tax adviser) an identified advance's VAT period |
| **L** | VAT Implementing Regulations, Tenth Edition (`docs/zatca/README.md`) | Five amended articles our records still read the old way — the tax adviser |
| **M** | Owner, 2026-11-21: Art. 40(10) is never applied (CLAUDE.md §5) | 🔴 The accountant: how the 40(10) reversal posts, and how the VAT is re-claimed when the bill is later paid |
| **N** | Owner, 2026-11-23: a leaver's final part-month is never paid (CLAUDE.md §5) | 🔴 The accountant: how a final part-month is paid, and its GOSI |

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

## 🔴 Answers received, recorded 2026-11-06

Two adviser answer documents arrived (position as of 2026-11-04), with a
reviewer's official-source research of 2026-11-05. **The first document is the
one used.** The second is not adopted where it contradicts the first or the
official texts ("Not adopted", near the end of this file). The advisers are not
named in this public file; the owner holds the documents. Current state
authority: [CLAUDE.md §2](../../CLAUDE.md).

Every answer carries two labels:

- **Status:** settled, settled in principle, or open.
- **Source status:**
  - **VERIFIED:** opened on 2026-11-06 and the text read. The sources are listed
    at the end of this file.
  - **CITED-NOT-READ:** named by an answer document or a source, not read here.
  - **REPORTED:** press only; the official text is pending.
  - **READING:** a reading, not an official ruling.
  - **NOT ADOPTED:** with the reason.

| Answer | Recorded under | Status | Phase 18 close-out item |
| --- | --- | --- | --- |
| P1 | A1, A2, B1 | settled | A1, with the periods: G48 (`retain_until` 6 vs 10) |
| P2 | B2 | settled in principle | — |
| P3 | B3 | settled that no fixed PDPL period applies; each period open | — |
| P4 | B3 | settled in principle | The §11.63 note (an account that has signed in can never be deleted) |
| P5 | B4 (new) | duties settled; masking method open | DR-25 (G42's masking half) |
| P6 | B5 (new), CLAUDE.md §5 (operator application access) | settled in principle; no fixed expiry | G46, with the official-documents question (PD-2) |
| P7 | Block G, queue C6 | framework settled; each provider case-specific | — |
| T38 | Block J, S-1 | settled; S-1 closed | — |
| G1, G2 | Block H: GQ-1, GQ-2 | open, a GOSI question | — |
| G3 | Block H: GQ-3 | settled in principle | — |

**The GOSI questions have new ids** because `packages/shared/src/gosi.ts` already
uses "question G1" for a different list.

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

**Answer (recorded 2026-11-06).** Inbound evidence is kept for the **longest
period that applies**. That is not 6 years:

| Record | Period | Source |
| --- | --- | --- |
| Books, correspondence and business documents, issued or received | **10 years** at least | Commercial Books Law (M/61) Art. 8, with Art. 6; in force today |
| VAT records, general | 6 years from the end of the tax period | VAT Implementing Regulations Art. 66(1); ZATCA guideline v3 §8.3.3 |
| Movable capital assets | The adjustment period + 5 years, from acquisition (Art. 52(2) sets that adjustment period at 6 years). Useful life under 6 years: life + 5 | Same |
| Real estate | 15 years in all cases | Guideline v3 §8.3.3 |

The VAT periods apply in addition to the Commercial Books Law (guideline v3
§8.1). P1 adds that keeping every tax document permanently is not justified by
the statutory minimum: when the period ends, reassess.

- **Status:** settled.
- **Source status:** VERIFIED: M/61 Arts. 6 and 8 (status «ساري»), guideline v3
  in Arabic and English, VAT Implementing Regulations Arts. 52(2) and 66(1).
  CITED-NOT-READ: Unified VAT Agreement Art. 59, which the guideline cites for
  the 15 years.
- **Branch taken: *Same as outbound* → build the enforcer.** No architectural
  change. The "6/11" assumption above is replaced by the longest-period rule.
- **Recorded, not changed here:** `ZATCA_ARCHIVE_RETENTION_YEARS` defaults to 6,
  below M/61's 10. M/61 may itself be replaced: see the Commercial Transactions
  Law in Block I.

### A2. May inbound evidence be destroyed on schedule, or only retained *at least* that long?

- **Why it matters:** "must keep for N years" and "must destroy after N years"
  impose opposite mechanisms. PDPL (Block B) tends toward the second, tax law
  toward the first, and the conflict is the whole problem.
- **What changes:** a *must-destroy* answer makes B3 (deletable staging) a
  hard prerequisite rather than a hygiene item, and gives the platform a
  destruction obligation it currently cannot discharge.

**Answer (recorded 2026-11-06).** Must destroy after the period.

- PDPL Art. 18(2)(a): where a legal justification requires retention for a
  specified period, the data is kept, then destroyed after that period or the
  end of the purpose, **whichever is longer**.
- Art. 18(2)(b): data tied to a pending court case stays until the case ends.
- Art. 18(1): once the purpose ends, destroy without delay. Data may be kept after
  that only if everything identifying the person is removed.

- **Status:** settled.
- **Source status:** VERIFIED: PDPL Art. 18, in Arabic, which prevails.
- **Branch taken: *must-destroy* → B3 deletable staging becomes a hard
  prerequisite for inbound captures.**
- **Not covered:** deleting outbound e-invoices after retention. That is TX-1 in
  Block I, and it is open.

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

**Answer (recorded 2026-11-06).** Yes, personal data inside a tax document is
covered, but retention overrides erasure during the period. PDPL Art. 4(5) gives
the right to request destruction without prejudice to Art. 18. Implementing
Regulation Art. 8(3) says the same of the destruction rules. After the period,
A2 applies.

- **Status:** settled.
- **Source status:** VERIFIED: PDPL Arts. 4(5) and 18; Implementing Regulation
  Art. 8(1)–(3).
- **Branch taken: retention overrides erasure during the period → the exposure
  narrows to the non-document data** (B3).

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

**Answer (recorded 2026-11-06).** Yes, through a controlled process that prevents
premature destruction. P2 separates three classes: issued e-invoices, received
tax-supporting documents, and ordinary attachments. The last two may be deleted
only after checking the retention obligations, keeping a proportionate audit
record that does not hold on to the original personal data.

- When data is destroyed, all copies go, including backups (Implementing
  Regulation Art. 8(2)(c)). Anonymisation must make re-identification impossible
  (Art. 9(1)(a)), and anonymised data is no longer personal data (Art. 9(2)).
- During the period, the original supporting documents must be kept (VAT
  Implementing Regulations Art. 66(3)(c); guideline v3 §8.3.1).
- The tax half: the E-Invoicing Resolution's no-delete rules name "generated"
  e-invoices and notes (Clause Second(2); Annex 1). That wording does not reach a
  photograph of a supplier's invoice.

- **Status:** settled in principle. The regulator prescribes no deletion-log
  design.
- **Source status:** VERIFIED: PDPL Arts. 4(5) and 18; Implementing Regulation
  Arts. 8 and 9; the Resolution's text. READING: that the Resolution's scope stops
  at generated documents. No ZATCA text says so in terms.
- **Branch taken: *Yes, they are different classes* → a class distinction in the
  archive, never a `delete` on `ArchiveStore`.** B3 becomes a real design task.

### B3. What retention applies to the non-document personal data?

Audit-log IP addresses (append-only by design), customer and employee records,
inactive user accounts. **What changes:** each needs a policy and an enforcer;
the append-only audit log may need a redaction mechanism that preserves the
chain, which is a build, not a setting.

**Answer (recorded 2026-11-06).** PDPL sets no fixed period for any of these (P3):

| Category | Fixed PDPL period? | Treatment |
| --- | --- | --- |
| IP addresses in audit logs | No | Keep only while a lawful purpose or obligation needs them |
| Customer records | No | Apply the contract, accounting, tax and other retention requirements |
| Employee records | No | Apply the employment and statutory obligations |
| Inactive user accounts | No | Review the continuing need; remove what is not needed |

**What is required instead: a retention register and a processing record.**

- The register states, per category: purpose, legal basis, retention trigger,
  period (the longest that applies, as in A1) and destruction action.
- The processing record is kept during processing and for five years after it
  ends (Implementing Regulation Art. 33(1)). It states retention periods per data
  category, where possible (Art. 33(5)(e)). **That five years is for the record
  only**, not a period for logins, customers or employees.
- People are told the period, or the criteria for it (Art. 4(1)(d)). Collect and
  retain the minimum (Art. 19; PDPL Art. 11(3)).

**Login logs (P4).** A database relationship is not a legal exception: immutable
logs cannot block an account's deletion indefinitely. Keep the integrity of the
event, and make the identity in it removable or anonymised (PDPL Art. 18(1);
Implementing Regulation Arts. 1(7), 1(8), 9(1)(a), 9(2)). Swapping a name for an
id that another table can reverse is pseudonymisation, and it is not enough.

- **Status:** P3: settled that no fixed PDPL period applies; each category's
  period is open until its other obligations are established. P4: settled in
  principle; no article prescribes a database design or a maximum for logs.
- **Source status:** VERIFIED: PDPL Arts. 11(3), 18, 19; Implementing Regulation
  Arts. 1(7), 1(8), 4(1)(d), 8, 9, 19, 33.
- **Branch taken: each needs a policy and an enforcer, and the append-only audit
  log needs a way to remove identity that preserves the chain.** That is a build.
- **Open:** building the register and the processing record, using the longest
  applicable period (CLAUDE.md §5).

### B4. Must read-only users have personal data masked? (new; P5)

**Answer (recorded 2026-11-06).** PDPL requires minimisation and protection, but
no universal masking format. Read-only access does not by itself justify
unrestricted viewing or exporting of salaries, identity numbers and bank details.
A report viewer may need balances but not employee identity numbers; an authorised
payroll user may need salaries.

- **Status:** duties settled; the masking method is open. Role-by-role design is
  an implementation assessment, not a figure SDAIA has issued.
- **Source status:** VERIFIED: PDPL Arts. 11(3) and 19; Implementing Regulation
  Art. 19. **The first document cites Art. 11(1); the minimisation rule is
  Art. 11(3), so 11(3) is recorded.**
- **Branch:** this is a new item, so no "What changes" row was written for it. It
  is left open: field- and export-level permissions for read-only roles.

### B5. Must operator access to verification documents expire after approval? (new; P6)

**Answer (recorded 2026-11-06).** Continued access must have a legitimate and
necessary purpose. PDPL sets no automatic expiry. Ordinary review access ends when
verification is complete, unless a continuing purpose justifies it. Later checks
use restricted access, recording the reason, the time and the staff member. How
long the document is stored and how long staff can open it need not match. An
expiry schedule may be an internal control, but must not be presented as a
statutory deadline.

- **Status:** settled in principle; no fixed expiry period in the text.
- **Source status:** VERIFIED: PDPL Arts. 18 and 19; Implementing Regulation
  Art. 19.
- **Branch:** this is a new item, so no "What changes" row was written for it.
  CLAUDE.md §5's operator-application-access row stays open.
- **Still open:** PD-2 in Block I, which neither answer document raised, decides
  whether the copies are destroyed after approval rather than only access-limited.

---

## Block C — the Zakat base itself (design doc §4) 🔴 M17.4 IS HELD ON THIS

**Status (2026-10-04): the hold was re-checked against its REASON and lifted —
Phase 16 read the 1445H Regulations in Arabic: C1 (Arts 27/28) and C4 (nisab:
absent) are SETTLED BY TEXT; C2 leaves one residue (contra allowances, Z-2), C3
the divisor and rounding (Z-1), C5 the split's mechanics (Z-5). The working
paper is built on fail-closed defaults; the questions to ask now are the
decision pack's §11 list (Z-1…Z-8, W-1…W-12, I-1, S-1):
[`phase-16-17-tax-treasury-decision-pack.md`](phase-16-17-tax-treasury-decision-pack.md)
§11. The text below is kept as the record of what was asked. Current state
authority: [CLAUDE.md §2](../../CLAUDE.md).**

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

---

## Block D — invoice numbering in practice (queue C12, added 2026-08-21)

**Status: the LAW is settled; this block asks only about PRACTICE.** C12 was
closed by a primary-source read — [`docs/tax/invoice-numbering-verification.md`](invoice-numbering-verification.md)
has the per-clause citations — and the code now implements the written rule.
Neither question below gates anything shipped; both would refine it.

### D1 — Does ZATCA question GAPS in an invoice-number series in practice?

**What the text says (verified, not asking about this):** VAT Implementing
Regulations Art. 53(5)(b) requires "a sequential number which uniquely
identifies the Tax Invoice". Nothing in that article, or in the E-Invoicing
Implementation Resolution which delegates to it, requires the series to be
unbroken — and the Resolution *does* impose an explicitly gapless,
non-resettable rule on a **different** field (the tamper-resistant counter,
Annex 2 field 2.5).

**What we cannot answer from the text:** whether ZATCA's **audit practice**
treats a gap in a taxpayer's invoice numbering as a defect to be explained.

**Why it matters, concretely:** our allocator produces a gap when an allocated
number is discarded — a rolled-back transaction, or a deleted draft invoice.
Those are ordinary events. If ZATCA expects gaps to be explainable, the answer
is not to change the allocator but to be able to **show what happened to a
missing number**, which is a reporting feature we have not built.

**What would settle it:** the advisor's experience of ZATCA audits, or a ZATCA
ruling. A "yes, they ask" answer creates a small build (an explanation for each
absent number); a "no" answer closes it permanently.

### D2 — Is our reading of the Arabic text safe?

Both documents we read are **ZATCA's own English translations**, and both carry
the disclaimer that **the Arabic version is official and prevails** on any
discrepancy. Nothing in our verdict turns on a fine shade of wording — the
operative clause is short and the sibling-field contrast is structural — but a
native reading of Art. 53(5)(b) and Annex (2) fields 2.1 / 2.5 would remove the
residual risk.

**Specifically worth a second pair of eyes:** whether the Arabic for
"sequential" (متسلسل) carries a stronger connotation of *unbroken* than the
English does. That is the single word our reading rests on.

---

## Block E — the seeded chart of accounts (added 2026-08-30)

**Context for the advisor.** The platform seeds every new organization with a
minimal 40-account chart — the accounts the automated posting path needs, plus a
handful of ordinary expense categories. It was deliberately minimal: a fuller
chart was recorded at the time as "a product feature needing its own research".
A separate design now adds hierarchy (classes → groups → accounts →
sub-accounts), tenant-defined accounts, and an import path for tenants migrating
from another platform.

**Why we are not answering these ourselves.** They are questions about Saudi
accounting practice and about the Zakat regulations, and this project has a
standing rule against reasoning tax content from general knowledge — the same
rule that holds M17.3/M17.4 pending Block C.

### E1. Is a standard Saudi chart of accounts expected — or do firms build their own?

Some jurisdictions publish or effectively mandate a national chart; in others
every firm builds one and an imposed template is an obstacle rather than a help.

**What each answer changes for us:**

- **A standard is expected** ⇒ we seed a fuller conventional chart, and the
  import path's job becomes *reconciling* the tenant's chart to it.
- **Firms build their own** ⇒ we keep the minimal seed, invest in the import and
  the account-management UI, and treat our numbering as a default the tenant is
  expected to replace.

The structure being built works either way, so this decides **how many accounts
we seed**, not the design. It is not blocking.

### E2. 🔴 Should the seeded chart align with the Zakat worksheet mapping?

**This is the more important question, and it is the reason this block exists.**

M17.3 puts a `zakat_classification` on chart-of-accounts entries — which
worksheet line each GL account feeds (capital, retained earnings, a provision, a
long-term liability, a deductible long-term asset). The Zakat base is built from
**balance-sheet accounts**.

So the seeded chart and the Zakat worksheet are two views of the same accounts.

**The question:** should the seeded chart be *designed against* the Zakat
worksheet — so that every account a Saudi taxpayer needs for the base exists,
named and grouped the way the worksheet expects — or are they independent, with
the classification simply mapped on afterwards?

**A "yes" means the two milestones cannot be designed separately**, and the
seeded chart is partly determined by Zakat requirements we have not yet
confirmed. See the dependency recorded in both design documents.

---

## Block F — invoice dating into closed periods (added 2026-09-15)

**Status: the POLICY is decided and enforced; this block asks whether Saudi
practice admits any exception.** The decision record is
[`known-issues-and-audit-findings.md`](../history/known-issues-and-audit-findings.md)
("INVOICE DATING INTO CLOSED MONTHS — owner-decided 2026-08-23,
REASONED-NOT-VERIFIED"). It is *reasoned, not verified*: the source is the
owner's accounting reasoning, not an accountant.

### F1 — May an invoice ever be dated into a closed period?

**What the platform does today:** an invoice or bill must not be dated into a
closed period at all — on create, and on any later change to `date` (a 423
`period_closed`, explained by the M22 dialog). Work that genuinely happened in
a closed month is issued in the current open period; revenue that belongs to
the closed month is an accrual made *before* closing, never a backdated
document after. The guard reads the accounting date (`document.date`), not
the ZATCA timestamp (`issued_at`), which is a different fact.

**Why the rule was chosen:** closing a month means its figures are final, and
Saudi VAT files per period — a backdated document makes a filed return wrong
or forces an amendment.

**What we cannot answer from our own reasoning:** whether Saudi practice
permits ANY exception — a grace window after period end (common in other
jurisdictions for late supplier bills), or an audited override for a
correction that must carry the original date.

**What would settle it:** the advisor's answer, with the ground (a GAZT/ZATCA
practice, a filing rule, or "none — the strict rule is the safe one"). A "no
exception" answer closes the item permanently; a "grace window" answer is a
small, contained build (a per-company window on `checkPeriodOpen`, audited); an
"audited override" answer is the larger one and should be costed before it is
promised.

---

## Block G — hosting, offshore AI and where VAT records live (queue C6, added 2026-11-06)

### P7(a). Can an overseas AI service process accounting data?

**Answer.** Potentially yes. PDPL does not prohibit it outright, but the offshore
transfer requirements must be met before the service is switched on, and a contract
with the provider is not automatically enough. First document the data transferred,
the lawful basis and the transfer mechanism; assess the risk where required; put
processor controls in place; and check prompts, logs, model training and onward
transfers.

The Regulation on Transferring Personal Data Outside the Kingdom (SDAIA President
Decision 1840 of 27/02/1446H; Umm Al-Qura, 1 September 2024):

- Art. 2: other permitted purposes, including operations needed for central
  processing.
- Art. 3: the published adequacy list.
- Art. 4(1): safeguards (standard contractual clauses, binding common rules,
  certification). Art. 4(2): the exemptions.
- Art. 6: when an exemption stops applying.
- Art. 7(1): a risk assessment first, for (a) transfers under Art. 4, and (b)
  sensitive data transferred continuously or at large scale.
- Implementing Regulation Art. 23(2): apply NCA controls where obliged, otherwise
  recognised best practice.

- **Status:** settled as a framework; each provider is case-specific.
- **Source status:** VERIFIED: PDPL Art. 29; Transfer Regulation Arts. 2, 3, 4, 6,
  7, 9; Implementing Regulation Art. 23. Two wording differences from the review
  notes, recorded as the text has them: the Implementing Regulation numbers the item
  23(2), not 23(b), in both languages; and Art. 7(1)(b) is one limb, not two. That
  Decision 1840 replaces the 1445H text: verified by reviewer 2026-11-05, not
  re-opened (the page itself says only that it applies from publication, Art. 9).
- **Branch:** C6 has no pre-written row. C6(1) stands unchanged: the Groq agreement
  is blocking before any tenant data reaches Groq.

### P7(b). Does PDPL itself require Saudi hosting?

**Answer.** No. PDPL regulates offshore transfers; it is not a Saudi-only hosting
law. ZATCA has its own location rule for tax records (below), and permission to
transfer under PDPL does not authorise moving those records abroad. A hosting design
must satisfy both.

- **Status:** settled as a general distinction; a specific configuration is assessed
  under both.
- **Source status:** VERIFIED: PDPL Arts. 2 and 29; Transfer Regulation Arts. 2–4.

### R-c. 🔴 Where must VAT records be? This corrects the repo

ZATCA, "Guideline for Tax Invoicing and Records under VAT Provisions", Version 3,
May 2026, §8.3.1, in Arabic, which prevails:

> «في الحالات التي يكون فيها الشخص الخاضع للضريبة مقيماً في المملكة، فإنه يتوجب أن
> يكون الحاسوب أو الخادم موجوداً في المملكة»

- **Exception:** a taxable person with a permanent establishment in the Kingdom may
  use a centralised system abroad, with a workstation in the Kingdom that reaches all
  its VAT data.
- **Originals:** the original supporting documents are retained locally.
- **A third party may hold the records** for a resident taxable person, who stays
  directly responsible (§8.3.4).
- **What kind of text this is:** the guideline says it amends no law. It is ZATCA's
  published reading of Implementing Regulations Art. 66(3).
- **The regulation's own words are looser, so this is not assumed away:** our pinned
  English text of Art. 66(3) (Eighth Edition) has records kept "in the Kingdom either
  physically or electronically through access to the relevant server or databases
  ... via a terminal point or access point in the Kingdom". The platform follows the
  guideline, the later and more specific reading.

The repo recorded "ZATCA does NOT mandate in-KSA storage", from the 2023 E-Invoicing
Detailed Guideline §5.5. That reading is superseded for resident taxpayers' VAT
records, and our tenants are resident.

- **Status:** settled, as ZATCA's published reading.
- **Source status:** VERIFIED: guideline v3 in Arabic (read on the page, p. 33) and
  English; VAT Implementing Regulations Art. 66(3).
- **What changes:** the C6 hosting item is an owner decision with an official input,
  not an open legal question. VAT records need a region in the Kingdom. Cloud stays
  permitted, a direct audit link stays mandatory, and the archive backend stays
  swappable. NCA, CSP and sector rules stay unverified.
- **Corrected in:** `docs/zatca/README.md`, `docs/zatca/m12-status.md`, `docs/hld.md`,
  `docs/hld.html`, `packages/config/src/env.ts`, CLAUDE.md §4, and a dated note in
  `docs/history/phase-2-zatca-m12.md`.

---

## Block H — GOSI (added 2026-11-06)

Written enquiry: [`owner-actions.md`](owner-actions.md), action 6.

### GQ-1 (the first document's G1). Do a non-Saudi's occupational-hazards-only periods count as earlier contribution periods?

**Answer.** Not resolved. Royal Decree M/273 item ثانياً(1) excludes from the 2024
law «المشتركون الذين لديهم مدد اشتراك سابقة على نفاذ النظام لم يعوضوا عنها», and
defines those periods as ones calculated under the Civil Pension Law (M/41), the
Social Insurance Law (M/33), or both. GOSI's guide says the law applies to entrants
with no contribution periods under those two laws before 3 July 2024. Neither text
says whether hazards-only periods count. The first document reads the wording as
supporting inclusion, and still asks for GOSI's confirmation.

- **Status:** open, a GOSI question.
- **Source status:** VERIFIED: the decree's item; GOSI's guide, p. 4. READING: the
  first document's "supports including".
- **Product position, unchanged:** the law is not inferred from nationality or dates.
  A non-Saudi line below SAR 400 is warned, never refused (`gosi.ts`, decision 21).

### GQ-2 (G2). What is the contributory-wage minimum under the 2024 law?

**Answer.** Not resolved. Law Art. 8(1) requires contributions on no less than
«الحد الأدنى للأجور أو الرواتب الذي تحدده الجهة المختصة». It gives no figure and
names no authority. Art. 8(2) sets the SAR 45,000 maximum. GOSI's page for the new
law states that maximum and no minimum. GOSI's FAQs give SAR 1,500 and SAR 400 but do
not say which law they describe.

- **Status:** open, a GOSI question. Ask for the amount, the authority, the instrument,
  the effective date, and whether it reaches non-Saudi hazards-only contributors.
- **Source status:** VERIFIED: Law Art. 8; GOSI's new-law page; the FAQs.
- **Product position, unchanged:** no 2024-law floor figure is built.

### GQ-3 (G3). Does the SAR 400 hazards-only minimum still apply under the 1421H rules?

**Answer.** Yes, for eligible contributors under the earlier regime. It is a minimum
contribution base, not a salary that must be paid. GOSI's FAQs, in English: "The
minimum wage under the Annuities Branch is S.R. 1,500, and S.R. 400 for Occupational
Hazard Branch". The Arabic is narrower: «وفي فرع الأخطارالمهنية لغير الخاضعين لفرع
المعاشات (400) ريال», for those outside the pensions branch.

- **Status:** settled in principle, subject to the person qualifying under that
  regime, which is GQ-1.
- **Source status:** VERIFIED: the FAQs in both languages. CITED-NOT-READ here: 1421H
  Regulation Art. 19(1), read for decision 21 (`gosi.ts`).

### G-d. The 2024-law rate steps: settled

GOSI's guide «دليل الزيادة في نسب الاشتراكات» (August 2025), p. 4, pensions branch
only: 9% each side from 3 July 2024, 9.5% from 1 July 2025, 10% from 1 July 2026,
10.5% from 1 July 2027, 11% from 1 July 2028. The Saudi Press Agency, 30 June 2025:
the announced provisions apply from 1 July 2025.

This matches the `law_2024` entries of `GOSI_SCHEDULE` exactly, and settles the item
open there: July 2026 is 20% in total, and each step falls on 1 July. No rate changed.

- **Status:** settled.
- **Source status:** VERIFIED: the guide (read on the page); the agency's headline.

---

## Block I — still to ask, and to watch (added 2026-11-06)

### For the tax adviser, or ZATCA

- **TX-1 (R-d). May outbound e-invoices be destroyed after the retention period?** The
  E-Invoicing Resolution requires the solution to protect generated e-invoices and notes
  from alteration or deletion (Clause Second(2)), and Annex 1 prohibits "Allow alteration
  or deletion of generated e-invoices or their associated notes" and "Allows for log
  modification/deletion". No official text was found that permits or addresses destruction
  after the period; guideline v3 is silent. PDPL Art. 18(2)(a) requires destruction after
  the legal period. **Status:** open; decide before 2032, the earliest anything can expire.
  **Source status:** VERIFIED: the Resolution; PDPL Art. 18. The absence: searched by the
  reviewer on 2026-11-05 and in guideline v3 on 2026-11-06.
- **TX-2 (Q-J). Must the QR's seller name, tag 1, be the Arabic name?** A question only.
- **TX-3 (Q-K). The QR timestamp, tag 3, is the moment of issue, not the invoice date, on
  a back-dated invoice. Is that right?** A question only.

### For the PDPL adviser

- **PD-1 (P-d). Controller or processor?** PDPL Art. 1(18): the controller specifies the
  purpose and manner of processing. Art. 1(19): the processor processes for and on behalf
  of the controller. Art. 21: the controller answers data-subject requests. SDAIA's guides
  (December 2023) have no SaaS example and assign no role to a software or cloud provider;
  the one processor named in an example is a bank's outside KYC provider, given as a fact of
  that example. **READING, not an official ruling:** ORGINOO is the processor for a tenant's customers, suppliers and employees, and
  the tenant is the controller; ORGINOO is the controller for platform accounts, login and
  audit logs, signup verification documents and billing. **If confirmed:** a tenant
  data-processing agreement with the Implementing Regulation Art. 17(1) contents (purpose,
  data categories, duration, breach notice, foreign-law exposure, mandatory disclosures,
  sub-processors), and a sub-processor list (hosting, mail, AI, KMS) with prior notice and
  a window to object (Art. 17(5)(c)). A processor that breaks its instructions is treated
  as a controller (Art. 17(4)). **Status:** open. **Source status:** VERIFIED: the articles;
  both SDAIA guides, searched for SaaS, software and cloud, and every example's role read.
- **PD-2 (P-e). Do the verification uploads fall under the official-documents rule?** PDPL
  Art. 28: official documents that identify a person may not be photographed or copied,
  except to implement a law or at a competent public body's request. Implementing Regulation
  Art. 31: such copies are protected, and destroyed once their purpose ends unless a law
  requires keeping them. The platform stores `cr_certificate`, `vat_certificate` and other
  uploads in `verification_documents`, readable by operators with no expiry (CLAUDE.md §5,
  operator application access). Neither answer document raised this. **The answer decides whether verification
  copies are destroyed after approval, rather than only access-limited.** **Status:** open.
  **Source status:** VERIFIED: both articles.

### To watch: the Commercial Transactions Law

- The Council of Ministers approved it on 27 October 2026. **VERIFIED:** Umm Al-Qura.
- It replaces the Commercial Law, the Commercial Papers Law and the Commercial Books Law,
  and starts 180 days after publication. **REPORTED:** Al-Eqtisadiah, 27 October 2026,
  attributing the replacement to the Ministry of Commerce. Official text pending; not found
  published in Umm Al-Qura as of 2026-11-05, and a search on 2026-11-06 found no text.
- The Ministry's consultation **draft**: Art. 50, records and supporting documents kept at
  least ten years after closing; Art. 51(b), digital entries cannot be deleted or altered
  once saved. **VERIFIED as the draft only;** the approved text may differ.
- **Action:** read the published text when it appears. A1's 10 years rests on M/61 until
  then.

---

## Block J — Qawaem's XBRL mapping (T38; closes S-1)

**Answer.** Filing through Qawaem is the company's duty. No general obligation on an
accounting-software vendor to generate Qawaem XBRL was established from the provisions
reviewed; both documents agree. Do not advertise an export as Qawaem-compatible until it
has been validated against the official filing specifications. A direct-integrator or
formal compatibility claim needs confirming with the Saudi Business Center.

- **Status:** settled. **S-1 is closed with the existing decision: nothing is labelled
  statutory** ([Phase 16/17 pack](phase-16-17-tax-treasury-decision-pack.md)).
- **Source status:** CITED-NOT-READ: Companies Law Arts. 17(2) and 262(1)(e). The absence
  of a mandate is the documents' finding, not a search made here.

---

## Block K — the 2026-11-19 regulatory review: payroll correction, the framework, an identified advance's VAT (added 2026-11-19)

**Why.** A regulatory review of A1, A15, A20 and A23 against ZATCA, SOCPA and IFRS found
none of them mandatory in its exact form (owner, 2026-11-19). From that date A1, A23 and
A20's stated-reason rule are labelled internal controls wherever a screen describes them.
Four questions follow; **K1 is the accountant's first**.

**Source status for this block:** the facts about the platform were read in its code on
2026-11-19 (`main`); no regulatory reading is made here.

### K1. 🔴 For the accountant — HIGHER PRIORITY (owner, 2026-11-19): how is an approved payroll run corrected?

**What exists.**
- **What a run posts.** Approval posts `Dr SALARIES` (gross) and `Dr GOSI_EXPENSE` (the
  employer's GOSI), against `Cr SALARIES_PAYABLE` (net pay) and `Cr GOSI_PAYABLE` (both
  shares of GOSI). Paying net pay posts `Dr SALARIES_PAYABLE / Cr` the bank's cash account;
  paying GOSI posts `Dr GOSI_PAYABLE / Cr` the bank's cash account.
- **What a manual adjusting entry can reach.** An approved manual entry reaches
  `SALARIES`, `GOSI_EXPENSE` and a bank's cash account, provided the line names a bank of
  the entry's own company. A correction found after the month closed posts in the current
  open month.
- 🔴 **What it cannot reach.** It cannot reach `SALARIES_PAYABLE` or `GOSI_PAYABLE`. Both
  are protected accounts (`@workspace/shared` `protectedAccounts.ts`), written only by a
  payroll run and the bank line that pays it. A manual journal on either is refused
  (`protected_account`), even when it states a correction kind; only `RETAINED_EARNINGS`
  admits a classified correction. The database's own writer restriction,
  `wht_payable_line_owned`, is on `WHT_PAYABLE`, which is not a payroll account.
- **So a manual entry corrects the expense side only,** against some account other than the
  payables the run created.
- **At the run level, nothing is corrected after approval:**
  - the status, `approved` and then `paid`, never goes back;
  - send-back and delete apply only before approval;
  - no route edits a run's per-employee lines (its payslips) at any stage — a run is
    created already computed;
  - the generic reverse refuses the run's three entries (A15, 2026-11-16);
  - a second run for the same period recomputes full salaries and cannot carry a
    correction amount.
- **The gap.** An error found in an approved run leaves the run's status, its payslips and
  the two payables wrong. A ledger fix through other accounts leaves the payroll records
  disagreeing with the ledger.

**The question.** Which corrections are permitted for an approved run, and what each must
produce:
- the correction types allowed, for example an adjustment run with signed per-employee
  amounts, a reversal and re-run, or an adjusting entry;
- the ledger entries each produces;
- whether corrected payslips are issued;
- how a correction found after the month closed is dated: IAS 19 / IFRS for SMEs Section 28
  for the accrual's period, IAS 8 / Section 10 for the error.

**What changes.** The dedicated payroll correction workflow, proposed separately and outside
Phase 19, is built only on the answer. Until then the generic reverse keeps refusing payroll
entries, and no run's status is changed to make a reversal look resolved (owner, 2026-11-17).

### K2. For the accountant: which reporting framework does each tenant use?

- **The endorsement.** SOCPA's endorsement document (rev. 24/12/2025; VERIFIED in its
  English column) endorses IFRS and IFRS for SMEs, the third edition of IFRS for SMEs from
  1 January 2027. Which non-listed entities must use which is SA-UNVERIFIED: that page is
  behind a login.
- **What the platform cites.** Its controls cite full IFRS: IAS 8 for corrections, IAS 19 for
  the payroll accrual, IFRS 15 for an advance as a contract liability. From 2026-11-19 the
  matching IFRS for SMEs section stands beside each: Section 10, Section 28 and Section 23.
- **The question.** Confirm the framework each tenant reports under, and whether any
  treatment the platform applies differs under IFRS for SMEs.
- **What changes.** If tenants differ, a per-company framework record, with the references a
  screen shows read from it. If no treatment differs, the references only.

### K3. For the accountant (open since 2026-11-17): may an untraceable historical entry be classified `manual`?

- **Where things stand.** A15 (migration 0163) tags an entry whose source nothing establishes
  `legacy_unclassified`. The generic reverse refuses it, and a `legacy_unclassified` draft is
  never posted (2026-11-19).
- **Why it matters.** Classifying such an entry `manual` would unlock the generic reverse
  for it.
- **The owner's position (2026-11-17).** Never on an administrator's stated reason alone. The
  review screen shows the evidence and the review status; classification as `manual` waits
  for an accountant-approved policy.

### K4. For the tax adviser: an unidentified receipt later identified as an advance for a taxable supply — does its VAT belong to the receipt's period (possibly a return already filed) or the identification's?

**What exists.**
- **At receipt: no VAT.** An identified customer's receipt of unknown purpose is classified
  `unknown`, on `UNIDENTIFIED_RECEIPTS`. An unknown payer's money reaches the same account
  only through a manual line that states why there is no customer (A20). *(Corrected
  2026-11-23: it does not arrive through a bank line — a bank line categorised to that
  account is refused `category_needs_party`, and it stays in Suspense until a document
  exists.)*
- **When it is identified as an advance** (classification `advance`, VAT category S), one
  reclassification entry moves the balance to `CUSTOMER_DEPOSITS`, dated the
  classification's effective date. It still posts no VAT.
- **VAT is declared only by the advance tax invoice (386)** issued from the receipt. It is
  dated at the RECEIPT date, the tax point, and any other date is refused.
- **If the receipt's month is closed,** issuing the 386 is refused
  (`423 advance_tax_point_period_locked`), naming the remedy: reopen the month, issue,
  close it again, and correct under IR Art. 63: an understatement of SAR 15,000 or more by
  correcting the filed return within 20 days (63(1)); below that, in the return for the period
  in which it was discovered (63(3), as amended by Res. 01-06-24).
- **This follows the accountant's answer 1(b) of 2026-09-22**
  ([advance-payments pack](advance-payments-decision-pack.md) §17.1): the VAT belongs to
  the receipt's month, corrected through the return. This question asks the tax adviser to
  confirm or correct that.

🔴 **Two findings from reading it:**
- **A receipt recorded by a manual journal has no path to its VAT.** An A20 line with a
  reason creates no receipt record, so no 386 can be issued from it. Once the payer is
  identified, the manual journal that moves the balance to `CUSTOMER_DEPOSITS` posts no
  VAT, so that advance's VAT would reach no return through the platform.
- **Art. 63(3)'s threshold: RESOLVED 2026-11-19, not a question for the adviser.** The
  pack (§17.1, 1(b)) read "below SAR 5,000" from the superseded English Eighth Edition;
  the refusal reads SAR 15,000. The current Arabic text (Tenth Edition, April 2025,
  pinned in `docs/zatca/specs/`) reads SAR 15,000, corrected in the return for the period
  of discovery (Res. 01-06-24). The refusal was right; the pack is corrected.

**What changes.**
- **If the receipt's period** (as today): the manual-journal path needs a way to declare the
  VAT.
- **If the identification's period:** the 386's tax point for an identified unknown receipt
  becomes the identification date, and the 423 refusal no longer applies to it.

**🔴 Answered 2026-11-23 — the receipt's period, as today.** Who: **to be stated by the owner**
(the two answer documents are the owner's; this public file names no adviser). Status:
**settled in principle**. Source status: **READING** — two research answers, not a ruling
(the second says so); the tax-point rule and Art. 63 they rest on are the texts already
pinned and read (Art. 63(3) in the Tenth Edition, 2026-11-19).
- The VAT belongs to the month the money was received, when the receipt was already
  consideration for a taxable supply; identifying it later does not move the tax point. A
  filed return is corrected under Art. 63: SAR 15,000 or more by correcting the original
  return, less in the return for the period of discovery. The threshold decides the
  correction route, not the tax point.
- **This confirms what the platform does** (the 386 dated at the receipt; the 423 naming
  Art. 63).
- **Still open: K4's own finding** — a receipt recorded by a manual journal has no path to
  its VAT. A design (the journal line identified as a receipt, then the existing 386 path)
  went to the owner on 2026-11-23; nothing is built.
- Evidence the answers say to keep: the bank receipt date, the contract or purchase order
  linking the payment to the supply, and the record of when it was identified.

---

## Block L — five amended VAT articles our records still read the old way (added 2026-11-20)

**Why.** The VAT Implementing Regulations were pinned in their current Arabic edition (Tenth Edition, April 2025; the Arabic prevails) and every citation in the repo was reviewed against it on 2026-11-19. Art. 63(3) was corrected that day; these five stay open (owner, 2026-11-20). The amended text, the resolution and every local line that cites the old text are in [`docs/zatca/README.md`](../zatca/README.md). All five are for the tax adviser.

- **L1 — Art. 50(1)(c), new (Res. 01-06-24):** input VAT on insurance or healthcare provided to employees and their dependants is now blocked unless a law in force obliges the employer to provide it — which of an employer's usual premiums (employees' and dependants' medical cover under the Cooperative Health Insurance Law, and any other) does a law oblige, so that their VAT stays deductible?
- **L2 — Art. 50(1)(b), amended (Res. 01-06-24):** catering and food and drink become deductible where a law in force obliges the employer to provide them to employees at the workplace — which obligations qualify in practice?
- **L3 — Art. 40(10)–(11), amended (Res. 01-06-24):** a buyer's input VAT on a purchase still not paid in full twelve months after the month following the supply's month is reversed in the return for the month in which those twelve months end, except goods under financing contracts (finance lease, murabaha, lease ending in ownership) paid in periodic instalments under the stated conditions — is that the reading, and what must a buyer hold to use the exception?
- **L4 — Art. 9(5), amended (Res. 1-4-23):** a government body is outside economic activity only when all three conditions hold (a legal instrument authorises the activity, it is not run on economic or commercial criteria, and it is exclusive to government) — do the statutory fees a business pays to government still carry no VAT under that test?
- **L5 — Art. 40(7)(d), amended (Res. 1-4-23):** for bad-debt relief ZATCA may accept other supporting documents in place of the certified accountant's certificate from a supplier not obliged to appoint an auditor — what evidence is accepted in practice?

**🔴 Answered 2026-11-23.** Who: **to be stated by the owner** (the documents are the
owner's; this file names no adviser). Source status:
- **VERIFIED** — Art. 40(7)(a)–(e) and 40(8) (by the owner against the primary text, and
  read here in the Arabic Tenth Edition pinned in `docs/zatca/specs/`), and Labor Law
  Art. 147 (by the owner).
- **CITED-NOT-READ** — ZATCA's worked examples (Examples 10, 18 and 20), the Input Tax
  Guideline and Dariba, as the answers cite them.
- **READING** — the answers themselves: research, not a ruling.

| # | The answer | Status | What the platform does today |
| --- | --- | --- | --- |
| **L1** | Only cover a law obliges the employer to provide is deductible — chiefly the Cooperative Health Insurance Law's mandatory medical cover for employees and the dependants it covers. Voluntary enhancements, benefits beyond the statutory minimum and life insurance are blocked. | settled in principle | Employees' medical insurance has no category of its own: it is booked to `INSURANCE` (standard, not blocked), so its VAT is claimed in full. |
| **L2** | Meals stay blocked except where a law obliges them at the workplace — chiefly Labor Law Art. 147 (work remote from towns, mines, quarries, oil exploration). Voluntary meals, team dinners and office catering stay blocked. | settled in principle | `FOOD_MEALS` is blocked always; there is no exception. |
| **L3** | The reading is confirmed. The reversal is the VAT on the UNPAID portion only, in the return for the month the twelve months end; a later payment restores it. The financing exception needs ALL its conditions and the supplier's written certificate. | settled | Nothing detects or reverses it; the posting waits on Block M. |
| **L4** | A government body's statutory fee is outside the scope of VAT when all three conditions hold: no VAT, so no input VAT. A government body's commercial supply can be taxable and is analysed on its own. | settled in principle | `GOVT_FEES` and `GOSI_EXPENSE` are seeded outside scope (`O`), but that treatment is read only on the bank-line path. |
| **L5** | Where the supplier is not obliged to appoint an auditor, ZATCA **may** accept other evidence, at its discretion; there is no official list; the other conditions still apply. | settled in principle | The write-off takes the certificate as a text reference only; there is no alternative-evidence route. |

**Designs only** (the category split and what the user states, the meals exception, the
40(10) detection, the government-fee treatment on bills, and an alternative-evidence route
reviewed by the accountant and never shown as accepted) went to the owner on 2026-11-23.
Nothing is built.

---

## Block M — posting the Art. 40(10) reversal and the 40(11) re-claim (added 2026-11-21)

**Why.** The platform never reverses input VAT on a purchase still unpaid twelve months after the month following its supply, so a company with old unpaid bills keeps VAT it must give back (CLAUDE.md §5, owner 2026-11-21). The regulation sets the duty and the periods: the reversal goes in the return for the month the twelve months end (40(10)); after a later payment the VAT may be deducted again, in that payment's period or a later one (40(11)). It is silent on the booking. The design recorded in 2026-09 ([`phase-13b-vat-claim-ledger-architecture.md`](phase-13b-vat-claim-ledger-architecture.md) §5 and §11, not built) posts the reversal Dr the purchase's cost / Cr `VAT Adjustment – Non-Payment (Art. 40(10))`, and the re-claim as the mirror, proportional to the amount paid; it covers expense purchases only. Nothing is built until the accountant answers.

- **M1 — for the accountant:** how should the 40(10) reversal post, and how is the VAT re-claimed when the bill is later paid in full or in part — is the recorded design right (Dr the purchase's cost / Cr the separate adjustment account, and its proportional mirror on payment), and what changes when the purchase was capitalised as a fixed asset or is held in inventory, or when the purchase's own period is already closed?

---

## Block N — a leaver's final part-month (added 2026-11-23)

**Why.** Until 2026-11-23 a payroll run ignored the end date: an employee still `active` after leaving was paid a full month and GOSI every month, and one marked `inactive` lost their final part-month without a word (CLAUDE.md §5). The owner's rule since then (2026-11-23): a run never pays an employee whose end date is before its month, whatever their status; an employee whose end date falls inside the month (the first and the last day included) is **named in the run and not paid automatically** until the accountant answers how a final part-month is paid. Nothing else about the run changed. GOSI's own leaving-month rule is already written (GO-12: contributions by days of service over the month's actual days, both laws) and is kept in code, unused by a run until this answer.

- **N1 — for the accountant:** how is a leaver's final part-month paid? (a) Is the pay for the days served pro-rated over the month's calendar days, over 30, or over working days, and is an employee whose service ends on the month's last day paid the full month? (b) Does the final month's GOSI follow GO-12's days of service (the 1421H law's Art. 21(3) and the 2024 Regulation's Art. 20(2)), or GOSI's Employer FAQ #11 as our test records it (the leaving month charged only when service ends on its last day)? (c) Is the final part-month paid in the month's ordinary run, or in a separate final settlement?

---

## Not adopted, from the second document

| What it says | Why not adopted |
| --- | --- |
| "No official page" states SAR 400 | GOSI's FAQs state it, in both languages |
| SAR 1,500 appears only for re-employment | GOSI's FAQs state it as the minimum |
| The 2024 law applies to new entrants from 1 July 2025 | It has applied since 3 July 2024 (GOSI's guide, p. 4; Decision 230/تأمينات applies the Implementing Regulation from the same date). 1 July 2025 was the first rate step |
| No ZATCA provision on storing data in the Kingdom was found | Guideline v3 §8.3.1 states it for resident taxpayers (R-c) |
| The Implementing Regulation's and Transfer Regulation's articles could not be verified | They were read on 2026-11-06. This is overtaken, not contradicted |

Where it agrees with the first document (field- and export-level access, documented
retention and destruction, removable identity in logs, assessing overseas AI first, and
Qawaem being the company's duty), nothing further turns on it.

---

## Sources opened on 2026-11-06

| Source | Where | Read |
| --- | --- | --- |
| GOSI Employer and Contributor FAQs | gosi.gov.sa/ss/GOSIOnline/FAQ_Employer, /FAQ_Contributor (`?locale=en_US`) | Minimum-wage line, in both languages |
| Social Insurance Law | uqn.gov.sa/details?p=25239 | Art. 8 |
| Royal Decree M/273 | uqn.gov.sa/details?p=25238 | Items ثانياً, ثالثاً |
| Decision 230/تأمينات | uqn.gov.sa/details?p=25236 | Whole |
| GOSI's page for the new law | awareness.gosi.gov.sa/businessJourney.html | Maximum stated; no minimum |
| GOSI's guide, August 2025 (47 MB, not pinned) | awareness.gosi.gov.sa/pdf/Contributions.pdf, sha256 `e560f1d664f438346894bd488f7cb8fa3cda2f2e36fcc78203a1af8550142255` | p. 4, on the page |
| Saudi Press Agency, 30 June 2025 | spa.gov.sa/N2349640 | Headline |
| PDPL, Arabic (prevails) | SDAIA knowledge centre, dgp.sdaia.gov.sa, sha256 `cf09d6fcbd88d4322ba68ac7a99fe521044c681e3e8d7655bdcbd6d9e247badf` | Arts. 1, 2, 4, 11, 18, 19, 21, 28, 29 |
| PDPL Implementing Regulation, English | sdaia.gov.sa/en/SDAIA/about/Documents/ImplementingRegulation.pdf, sha256 `74bc1e0e3075d5789c6dcf82bdedad7eee241111a4c5e8241a5eeb0b2853e606` | Arts. 1, 4, 8, 9, 17, 19, 23, 31, 33 |
| PDPL Implementing Regulation, Arabic | dgp.sdaia.gov.sa, sha256 `ee944f669159b0ff3c11623f8699f4f0c26b104562d5d480429cfe99d4fc2700` | Art. 23 |
| SDAIA's guides, December 2023 | dgp.sdaia.gov.sa (the handbook; the controllers and processors guide) | Searched; examples listed |
| Transfer Regulation | uqn.gov.sa/details?p=25412 | Arts. 1–4, 6–9 |
| ZATCA VAT records guideline v3 | See the pin table in [`docs/zatca/README.md`](../zatca/README.md) | §§8.1, 8.3, both languages |
| VAT Implementing Regulations; E-Invoicing Resolution | The committed text extracts in `docs/zatca/specs/` | Arts. 52(2), 66; Clause Second(2), Annex 1 |
| Commercial Books Law (M/61) | laws.boe.gov.sa/BoeLaws/Laws/LawDetails/05690bd6-2c75-4b65-a148-a9a700f1bccf/1 | Arts. 6, 8; status «ساري» |
| Council of Ministers, 27 October 2026 | uqn.gov.sa/news/council-of-ministers/4002224 | The approval item |
| Consultation draft | istitlaa.scbc.gov.sa/ar/Trade/mci/CTL | Arts. 50, 51 |
| Al-Eqtisadiah, 27 October 2026 (press) | aleqt.com | The replacement and start sentences |
