# Zakat module — DECISION RECORD and build order

**Decided 2026-08-15 with the owner, by interview (Q1–Q8).** This file records
**what was decided, what follows from it, and what is still unverified.** It is
the spec-level source of truth for the Zakat module; per-milestone as-built
records go in [`docs/history/`](../history/).

It supersedes every earlier treatment of Zakat in this codebase — all of which
was inherited from the pre-platform bookkeeping app and none of which was ever
designed. See §6 for what was demolished and why.

---

## 1. The decisions

| # | Question | Decision |
| --- | --- | --- |
| **Q1** | What does the platform produce? | **A Zakat Base Working Paper.** The platform does **not** submit to ZATCA. It produces an auditable worksheet the tenant or their external accountant uses to complete their own filing. |
| **Q2** | Which taxpayers? | **100% Saudi/GCC-owned entities only, v1.** `companies.ownership_type ∈ (SAUDI_GCC, FOREIGN, MIXED)`. Foreign and mixed entities are **out of scope** — the surface is hidden with a notice directing them to a tax advisor. |
| **Q3** | Which calendar? | **Both Hijri and Gregorian fiscal years.** Robust fiscal-year support is a **prerequisite**, not a follow-up. Gregorian filers get the rate adjustment `2.5% × Gregorian days ÷ 354`. |
| **Q4** | Source of truth? | **The General Ledger.** The base is built from balance-sheet accounts (capital, retained earnings, provisions, long-term liabilities, less deductible long-term assets). The income statement is integrated to cross-verify provision movements and confirm net profit flowing into equity. |
| **Q5** | Is it an input surface? | **Yes — an interactive working paper.** The GL auto-populates the baseline; the tenant or accountant adjusts non-ledger items (unapproved provisions, tax-exempt investments, related-party balances) on a reviewable, **period-locked** worksheet before locking the annual report. |
| **Q6** | `is_zakat_relevant`? | **Deleted entirely** — column, migrations, seed flags, UI toggles, write paths. Classification moves to the **chart-of-accounts / GL account mapping** level. |
| **Q7** | The current page? | **"Under construction" immediately.** The computed SAR 0.00 and the 2024 gold-price nisab are removed now, before anything else is built. |
| **Q8** | Where does it live? | **An annual report generator under Tax & Compliance** in the Finance Hub. No dedicated Hub dashboard workspace. |

---

## 2. What follows from Q1 — the working-paper posture

**Q1 is the decision that governs the others.** "Working paper, not filing" is
not a scope reduction; it changes what correctness means.

- **The deliverable is a defensible derivation, not a number.** Every figure on
  the worksheet must show where it came from: which GL account, which balance,
  which adjustment, who made it and when. A correct total with an unexplained
  composition is a failed deliverable, because the person filing has to defend
  it to ZATCA and we are not in the room.
- **We are not the filer, so we must not look like one.** No "submit", no
  "Zakat due to ZATCA", no implication that producing the worksheet discharges
  an obligation. The output is an input to someone else's filing.
- **This is deliberately the opposite posture from VAT/e-invoicing.** There we
  build documents that go to ZATCA and must be exactly right by construction.
  Here we build evidence a human signs off on. The ZATCA rules that make
  issuance fail closed do not apply; the audit-trail rules apply harder.

**Consequence for the standing rules:** the working paper is a *reader* of the
ledger, and — unlike the VAT return — it has a **write** side (adjustments).
Those adjustments are the one place a human can move a Zakat figure without a
journal entry, so they get the full audit treatment: attributed, timestamped,
reasoned, and frozen at lock.

---

## 3. Build order

Each row is a separate PR with one concern, per §11 of CLAUDE.md.

| # | Milestone | Content | Status |
| --- | --- | --- | --- |
| **M17.0** | **Retire the fake surface** | Q7 + Q6: under-construction page; delete `transactions.is_zakat_relevant`, `categories.zakat_relevant`, `GET /summary/zakat` and everything downstream. | ✅ this PR |
| **M17.1** | **Ownership scope** | Q2: `companies.ownership_type`, Company Settings field, the out-of-scope notice for FOREIGN/MIXED. | Next |
| **M17.2** | **Fiscal year + calendar** | Q3: the stated prerequisite. `fiscal_calendar` on companies, the pure resolver, Umm al-Qura conversion, boot assertion, `GET /companies/current/fiscal-years`, Company Settings shows real boundaries. | ✅ done — see §5a |
| **M17.3** | **COA Zakat classification** | Q4 + Q6: `zakat_classification` on chart-of-accounts entries — the replacement for the deleted flag, at the grain Q6 chose. Seeded for system accounts, editable per tenant. | After M17.2 — **needs advisor answer C2** (what composes the base defines what this must express) |
| **M17.4** | **Worksheet engine + adjustments** | Q4 + Q5: the base computation, the income-statement cross-check, `zakat_worksheets` + lines + adjustments, lock semantics. | 🔴 **HELD** on §4 / advisor Block C — especially C1, the minimum-base rule |
| **M17.5** | **Finance Hub surface** | Q8: the annual report generator under Tax & Compliance, plus export. | After M17.4 |

**Why fiscal year comes before the worksheet, not with it:** a Zakat base is a
balance *as of a fiscal year end*, and a Gregorian rate adjustment is a
*day count between two fiscal year boundaries*. Both are undefined until the
platform can say what a fiscal year is for a given company. Today it cannot —
`companies.fiscalYearStart` has been stored and exposed since M11.6 and is
applied by no report. Building the worksheet first would mean hardcoding
calendar years and retrofitting, which is how the same column got stranded the
first time.

---

## 4. 🔴 UNVERIFIED — the tax content itself

**Nothing in this section has been checked against a primary source.** Per the
standing sourcing rule (LIVE API > SDK > PDF > secondary sources), the primary
source here is the **Zakat Collection Regulations issued by ZATCA** and its
implementing resolutions — not a blog, not a Big-Four summary, and not this
document. Every item below must be verified before M17.4 computes anything a
tenant sees.

| Item | What is assumed | Why it matters |
| --- | --- | --- |
| **Base composition** | Additions: capital, retained earnings, provisions, long-term liabilities. Deductions: deductible long-term assets. | This is the whole computation. Q4 states the shape; the *exact* account list, and which provisions qualify, is a rules question. |
| **The rate formula** | `2.5% × Gregorian days ÷ 354` (≈2.578% for a 365-day year), per Q3. | Owner-supplied. Verify the divisor (354 vs 354.367) and whether ZATCA prescribes a rounding convention. |
| **Minimum-base rules** | None implemented. | There is commonly a floor tying the Zakat base to adjusted net profit, and caps on some deductions. If such a rule exists and is missing, the worksheet under-states the base — the direction that gets a taxpayer assessed. |
| **Nisab** | **Assumed NOT to apply to corporate Zakat.** | The demolished page applied a personal-Zakat nisab threshold from gold prices (§6). Corporate Zakat on a Zakat base is a different regime. If nisab genuinely has no role here, say so explicitly in the UI so its absence does not read as an omission. |
| **Adjusted net profit** | The income statement is a *cross-check* (Q4), not an input to the base. | If the minimum-base rule above exists, net profit becomes a computational input and Q4's "cross-verify" understates the integration. |
| **Mixed ownership** | Out of scope (Q2). | The real rule apportions between Zakat (Saudi/GCC share) and income tax (foreign share). v1 declines rather than approximates — correct, and the reason the notice must name the limitation rather than hide the page. |

**How to close this.** 🔴 **M17.4 IS HELD until it is closed** (owner
instruction, 2026-08-15) — not "should be careful", held. A worksheet that
computes confidently from unverified rules is exactly the failure the Zakat page
already committed once (§6), with better arithmetic and the same epistemic
problem.

The questions are written up as **Block C of
[`advisor-questions.md`](./advisor-questions.md)** and go in the **same
conversation** as the C7/C8 retention and PDPL questions — one engagement, not
three. Two sequencing notes:

- **Ask the minimum-base question (C1) first.** It is the only one that changes
  the architecture rather than the arithmetic: if a rule ties the base to
  adjusted net profit, the income statement stops being Q4's *cross-check* and
  becomes a computed *input*, with its own adjustments and audit trail. Knowing
  that before the derivation is built is the difference between designing it and
  retrofitting it.
- **The base-composition answer (C2) is needed before M17.3, not M17.4.** It
  defines what the chart-of-accounts classification has to be able to express,
  and M17.3 builds that classification.

---

## 5. Technical notes for the milestones ahead

**Hijri conversion needs no dependency.** Node 24 in this environment ships full
ICU: `Intl.DateTimeFormat('en-u-ca-islamic-umalqura')` resolves, and
`Intl.supportedValuesOf('calendar')` lists `islamic-umalqura` alongside
`islamic-civil`, `islamic-rgsa` and `islamic-tbla`. Umm al-Qura is the Saudi
civil calendar and the correct choice; the variants differ by days and are not
interchangeable.

🔴 **But ICU is a property of the runtime, not of our code.** A small-ICU Node
build silently falls back to the Gregorian calendar and would produce Hijri
dates that are wrong rather than absent. M17.2 must assert Umm al-Qura
availability **at boot** (the `loadEnv` fail-fast posture), not discover it when
a tenant's year-end is off by ten days.

**`categorizer.ts` is on the scripted-edit path** (CLAUDE.md §10b). It holds
~60 `zakatRelevant` / `isZakatRelevant` literals; they were removed by script in
M17.0, and any future edit to that file must also be scripted.

---

## 5a. M17.2 as built — and the two decisions inside it

**One column, two meanings.** `fiscal_year_start` is a month number *in*
`fiscal_calendar`: 1 = January under `gregorian`, 1 = Muharram under `hijri`.
A second column (separate Gregorian and Hijri start months) was rejected: a
company that switched calendars would leave a stale value behind, and a stale
start month is a wrong year boundary that nothing would flag. The cost is that
the two fields must always be read together, which the schema, the API
description and the settings UI all say explicitly.

**🔴 The year LABEL is a display convention, not a fact.** A fiscal year that
spans two calendar years has no universal name — some jurisdictions label it by
the starting year, others by the ending one. Rather than pick one and bury the
ambiguity, `FiscalPeriod` returns `label` (start year), `endYear`, `startDate`
and `endDate`, and the UI shows the range beside the label. **If the owner or
the advisor prefers end-year labels, that is a display change with no data
migration** — which is the point of not baking it in.

**Conversion is a binary search, not arithmetic.** The first implementation
estimated from the mean Hijri year (354.367 days) and iterated to the answer. It
was wrong, and wrong in the worst place: Umm al-Qura month lengths are
*tabulated*, not formulaic, so the error is not smooth and a "close enough"
break lands a day or two off at **month boundaries** — which is all a fiscal
year is made of. The Hijri date is monotonic in the day number, so a binary
search over ICU's own table is exact by construction. A 1,461-day round-trip
test pins it.

**The runtime is part of the implementation.** A small-ICU Node accepts the
`islamic-umalqura` locale and silently returns Gregorian dates, so every Hijri
boundary would be confidently wrong rather than missing. `index.ts` calls
`assertHijriCalendarAvailable()` at boot and refuses to start — the same
fail-closed posture `loadEnv` takes with the mailer and the alerter. The probe
is an externally checkable fact (1 Muharram 1447 AH = 26 June 2025).

**🔴 What M17.2 did NOT do.** The twelve report pages still take explicit
`date_from` / `date_to` and know nothing about fiscal years. There is no shared
date-range component to extend, so a fiscal-period picker across the reports is
its own UI change. The resolver's consumers today are Company Settings and,
next, M17.3/M17.4. Recorded here so "fiscal-year support" is not read as more
than it is.

---

## 6. What M17.0 demolished, and the lesson in it

The pre-existing Zakat surface was inherited from the single-tenant bookkeeping
app. It was not a partial implementation of this design — it was a different,
incorrect idea, presented with total confidence:

- **`GET /summary/zakat` summed transactions flagged `is_zakat_relevant`.**
  Almost nothing set that flag: of ~40 categorization rules exactly **one** wrote
  it true — "Saudi investment / Tadawul" → `INVESTMENT_INCOME`, which is also the
  only seeded account carrying `zakat_relevant = true`. So the input set was
  empty for almost every tenant and the endpoint returned a computed-looking
  **SAR 0.00**. (Recorded as flaw-report item #8; closed by this milestone.)
- **And for a tenant who DID trade, it was worse than zero.** The one thing that
  could populate the report was investment **income** — reported as a zakatable
  **asset**, with every unrelated debit subtracted from it. The single writer
  fed the reader a number of the wrong sign, the wrong kind, and the wrong
  grain.
- **It applied a personal-Zakat nisab** — "85g gold at ~230 SAR/g as of 2024",
  hardcoded as `NISAB_SAR = 19550` — to a company. Corporate Zakat is assessed
  on a Zakat base, not against a nisab threshold from a gold price that was
  stale the year it was written.
- **It summed the wrong things anyway**: transaction credits minus debits, i.e.
  a flow over all time, presented as an asset balance.
- **Four test files asserted the Zakat figure did not move** across settlement,
  transfer, GL-only and review-acceptance scenarios. Every one of those
  assertions compared **0 to 0** and would have stayed green through any
  defect. They are the *assert the property, not the number* lesson in its
  purest form: the fixture never supplied a Zakat-relevant row, so the property
  was never exercised. Removed in M17.0 rather than left as green cover.

**The lesson, which is not a new one:** this is the **shape-without-a-consumer**
failure mode with the polarity reversed — a *consumer* with (almost) no
producer. The column, the endpoint, the page, the nav entry and the tests all
existed; the missing piece was anything that meaningfully wrote the flag. The
result was not an empty page a user would report, but a confident zero, which
nobody reports because it looks like an answer.

🔴 **A second-order note, recorded because it happened during this very fix:**
the first pass of M17.0 asserted that *nothing* wrote the flag. Running
standing-check part 5 against that claim — grepping the pre-change file rather
than trusting the conclusion — turned up the Tadawul rule. The claim was not
merely imprecise: it was hiding the more serious defect, because "always 0" is a
missing feature while "investment income counted as an asset" is a wrong number.
An absence claim is a finding, and it needs the same verification as a presence
claim.

Q6's instruction to classify at the **COA/GL account** level rather than
per-transaction is the structural fix: a GL account's Zakat classification is a
property of the chart of accounts, set once, visible in one place, and used by
the one reader that needs it — rather than a boolean on every row that every
write path has to remember to populate and none did.
