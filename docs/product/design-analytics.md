# Analytics — DECISION RECORD and design

**Decided 2026-08-15 with the owner, by interview.** Round 3, after Zakat
([`design-zakat-module.md`](./design-zakat-module.md)) and the Finance Hub
([`design-finance-hub.md`](./design-finance-hub.md)).

This closes the second of the two destinations
[`hub-structure-decision.md`](./hub-structure-decision.md) §5 left "placed but
not defined".

---

## 1. The decisions

| # | Question | Decision |
| --- | --- | --- |
| **A1** | What decision does it lead to? | **Cash flow, and the ability to pay short-term AND long-term debts.** |
| **A2** | Cash or accrual? | **Cash-basis presentation** — but it is called **"Cash collected" / "Collections"**, 🔴 **never "revenue"**. The ledger stays accrual and is not touched. |
| **A3** | Periods | **Monthly, quarterly, yearly.** |
| **A4** | Budgets | **In scope.** The actuals defect must be fixed first. 🔴 **Do not apportion** an annual budget across months. |
| **A5** | Dimensions | **Category, customer and vendor.** None ignored. |
| **A6** | Explain or show? | **Explain** — bounded by the rule in §5: *where*, never *why*. |
| **A7** | Data quality | **Review first, then show.** Inherits the hub's withholding. |
| **A8** | Presentation | **Charts.** |
| **A9** | Cold start | **Chart two points anyway.** |
| **A10** | vs the Finance Hub | **Hub owns the point-in-time claim; Analytics owns the trend.** |
| **A11** | The Dashboard | **Absorb the Cockpit into Analytics**; `/` becomes a landing that routes. |
| **A12** | Solvency | **Added** — the hub is short-term only. Rules of thumb as judgment, never pass/fail. |

---

## 2. The one sentence

> **Analytics answers "how is the business doing" — is cash going up or down,
> can you pay what you owe, and where did the change come from.**

The Finance Hub answers *"are my books right and current"*. That split is the
whole reason there are two destinations, and §3 is what keeps it from collapsing.

---

## 3. 🔴 The boundary with the Finance Hub

The overlap is deliberate (A1 asks for debt-paying ability, which the hub also
reports). It survives only because the two answer **different questions from the
same figures**:

| | Finance Hub | Analytics |
| --- | --- | --- |
| Question | Can you pay what you owe **now**? | Has that been getting **better or worse**? |
| Shape | A point-in-time **claim**, in words | A **trend**, in charts |
| Horizon | Short-term (current/quick) | Short-term **and long-term** (§6.3) |

### 🔴 The withholding propagates — per point, not per page

M18.3 withholds the liquidity claim when it cannot be stood behind (non-zero
suspense, unclassified accounts). **Analytics must not chart over time what the
hub refuses to state today.** Otherwise the discipline is defeated by drawing it
instead of saying it — the same failure as caveating a claim rather than
withholding it, in chart form.

The naive reading — "if the hub is blocked, hide the chart" — is wrong in the
other direction, because a blocker is a fact about *now* and last March may have
been perfectly clean. So:

- **Every point carries its own `claimable`**, evaluated as of that point's date.
- **Unclaimable points break the line.** They are not drawn as ordinary
  segments, and not silently omitted either — a gap with a marker, so the reader
  sees that the series has a hole rather than a shape.
- **The summary sentence is withheld** whenever the latest point is unclaimable,
  exactly as the hub does.

A chart with an honest gap is the goal. A continuous line through unreliable
months is a plain-language claim wearing a different costume.

---

## 4. 🔴 "Cash collected" is not revenue — the naming IS the countermeasure

The owner's accountant described: *invoice issued and unpaid → trade
receivables; when paid → receivables down, revenue up.* That is **cash-basis
revenue recognition**. Our general ledger is **accrual** — revenue is recognised
at issuance (Dr AR / Cr Sales), and payment moves cash against AR without
touching revenue.

**The ledger does not change.** This is a presentation, and it is confined to
this page.

**Why the name is load-bearing.** A cash figure and an accrual figure both
called *revenue* will disagree for as long as any invoice is unpaid, and a
second number with the same name in a different place is **meta-finding #9**
restated — two report families answering one question from disjoint stores, the
defect flaw #1 was spent closing. So:

- The series is **"Cash collected"** (or "Collections"). Never "revenue",
  "income", "sales" or "turnover".
- The income statement keeps sole ownership of the word **revenue**.
- Where both appear, the chart shows **"Invoiced"** and **"Collected"** as two
  series — same unit, one axis — and the gap between them is a *feature*: it is
  money earned but not yet received.

**It also sits near a VAT figure computed on accrual.** VAT is due on the tax
invoice, not the payment (M16 Q0 — documents file, transactions reconcile). So a
cash-basis series near a VAT number invites a reconciliation that *should* fail.
It must read unmistakably as a management view, never a tax view.

### ✅ RESOLVED 2026-08-15 — it was accrual all along, and the risk is gone

The accountant clarified: *"when not paid the revenue increases and trade
receivable increases; when paid, receivable decreases and bank increases"* —
and then, unambiguously: *"when paid, it's a balance sheet **asset swap** —
Accounts Receivable converts into Cash/Bank."*

That is **exactly what the ledger already does**: Dr AR / Cr Sales at issuance,
then Dr Bank / Cr AR at payment — revenue recognised once, at issuance, and
payment moving nothing but the composition of assets. He was describing the
**balance-sheet movement**; his first phrasing ("revenue up when paid") was
loose, not a different model.

**The lesson worth keeping from the detour:** the ambiguity was not in the
ledger, it was in a sentence. "Revenue increases when paid" and "receivables
convert to cash" describe the same postings under two readings, one of which
would have had us build a second revenue figure. Asking rather than inferring
cost one round trip and avoided a meta-finding #9 of our own making.

**Consequences, all of them simplifying:**

- There is **no second revenue figure** to build. The meta-finding #9 risk this
  section was written to contain does not exist.
- The naming rule above is now **precautionary rather than load-bearing** — but
  it stays, because the next person to want a "cash revenue" chart will meet the
  same trap.
- Everything in §4 about a cash-basis series near an accrual VAT figure is
  **moot**. Kept as the record of a question asked and answered, not as a
  constraint in force.

### Does the invoiced-vs-collected bridge survive on its own merits?

**Yes, but reframed — and it is no longer about revenue.**

It dies as an *alternative revenue recognition*. It survives as a **receivables
bridge**, which answers a question nothing else does:

> Opening receivables **+ invoiced − collected − credited = closing
> receivables.**

The "receivables outstanding over time" series (§6.1) already shows the gap as a
**stock**. The bridge shows it as a **flow**, and that difference is the whole
value: a rising AR balance does not say whether you invoiced more or collected
less, and those call for opposite responses. "Receivables rose SAR 40,000: you
invoiced 100,000 and collected 60,000" is the WHERE-not-WHY rule applied to
cash timing.

It also has the property this codebase keeps reaching for: **it is an identity,
so it can be asserted.** The five terms must reconcile exactly, the same way the
trend is pinned to agree with the balance sheet.

**Recommendation: keep it, build it with the cash section (§6.1), not before.**
It is genuinely useful and cheap once the trend read model exists — but it was
never the urgent thing, and the question that made it urgent has now been
answered in the other direction.

---

## 5. Explanation: WHERE, never WHY

**The rule, now also recorded in
[`hub-structure-decision.md`](./hub-structure-decision.md) §4 so the AI trigger
reads correctly:**

> **State where a change came from, never why it happened.**
> Decomposition is arithmetic; causation is inference.

### Achievable deterministically — no model, AI stays parked

- **Variance decomposition.** "Cash collected fell SAR 45,000; three customers
  account for 80%: A −20k, B −15k, C −10k." Ranked subtraction over rows we
  already store.
- **Largest movers** versus the prior period, by category / customer / vendor.
- **Mix versus volume.** Fewer customers, or the same customers paying less —
  computable from counts and averages.
- **The invoiced-vs-collected bridge.** "SAR X invoiced this period was
  collected after it." This is what explains §4's gap, deterministically.
- **Budget variance**, ranked by size (once §7's defect is fixed).
- **Outliers** — a transaction far above that category's own median, labelled
  *unusually large*. Descriptive, never causal.

### Needs a model — stays parked

Causal claims, free-text narrative, statistical anomaly detection over sparse
half-categorised data, and recommendations. All of these trip the trigger and
wait for the hosting decision.

---

## 6. What it shows

### 6.1 Cash

- **Net cash movement per period**, from the existing cash-flow computation
  (operating / investing / financing / internal already exist).
- **Invoiced vs Collected**, two series, one axis (§4).
- **Receivables outstanding** over time, with the overdue share.

### 6.2 Short-term: can you pay what you owe — over time

Current ratio and quick ratio per period end, over the M18.1 liquidity classes.

🔴 **Not** by calling `reports.balanceSheet(as_of)` per point — that was the
obvious build and it is the one this section exists to reject. `analyticsService.trend`
folds a single pre-aggregated query instead, and a test pins that its points
**agree with `balanceSheet(as_of)`** for the same dates: two computations of one
fact, held together deliberately (the M13 AR-agreement pattern), because a trend
that disagreed with the balance sheet it charts would be meta-finding #9 again.

### 🔴 MEASURED, and the naive implementation is too slow

Owner instruction was to measure before charting rather than discover it in the
UI. Measured 2026-08-15 against a synthetic year:

| GL lines | 12 balance sheets | per point (min / median / max) |
| --- | --- | --- |
| 61 (dev org) | 138 ms | 8 / 9 / 37 ms |
| **6,000 (a busy SME year)** | **4,612 ms** | **87 / 578 / 694 ms** |

**4.6 seconds is not chartable**, and it gets worse in the obvious direction:
`balanceSheet(as_of)` re-reads **every GL line from the beginning of time** up
to that date, so twelve points read roughly 6.5× the year, plus twelve redundant
category fetches. Year two doubles the lines *and* the per-point cost — the
growth is quadratic in history, not linear.

**Consequence for M19.1: the trend read model must NOT call `balanceSheet` per
point.** It needs a single pass — fetch the period's lines once, ordered by
date, and fold forward accumulating month-end snapshots in one sweep: O(lines)
instead of O(points × lines). That is a different query, not a loop around the
existing one.

Rejected alternatives: a materialised monthly-balance table (invalidation
machinery for a problem one query solves), and caching (hides the cost rather
than removing it, and the first load is the one a user judges).

### ✅ BUILT AND RE-MEASURED (M19.1)

Three alternating runs of each implementation, same tenant, 6,000 GL lines,
12 points:

| | run 1 | run 2 | run 3 | median |
| --- | --- | --- | --- | --- |
| Loop over `balanceSheet` ×12 | 22,846 | 22,202 | 23,054 | **22,846 ms** |
| **Single-pass fold** | 1,080 | 1,032 | 1,041 | **1,041 ms** |

**≈22× faster**, and — the part that matters more than the ratio — the growth
curve changed. The fold still reads from the beginning of time (a balance is
cumulative; it must), but it reads **once**, pre-aggregated by (month, account)
in Postgres. Cost is now **linear in history** instead of quadratic.

⚠️ **Two honest caveats.**

1. **~1 second is better, not good.** It is acceptable for v1 and it is what a
   user will feel on first load. If it grows, the next lever is a narrower
   default window (12 months, not all history), not a cache.
2. **The absolute numbers move with TOTAL table size, not just this tenant's.**
   An earlier measurement of the same tenant shape gave 4,612 ms for the loop;
   after more test data accumulated across other tenants it gave 22,846 ms. The
   comparison above is trustworthy because both implementations ran
   back-to-back against identical data — but a single absolute figure from a
   shared table is not a stable benchmark, and in a multi-tenant database one
   tenant's growth is felt by everyone.

### 6.3 Long-term: solvency (A12 — new, the hub does not do this)

The hub is short-term only. M18.2's `nonCurrent` buckets already carry what is
needed:

- **Debt to equity** — total liabilities ÷ total equity.
- **Non-current liabilities as a share of total assets.**
- **Net worth** — total assets less total liabilities.

🔴 **Same discipline as the liquidity thresholds** (design-finance-hub §5.2):
these are **rules of thumb**, rendered as judgment. No pass/fail, no red
"FAIL", no language implying a rule was broken. Concretely, that means they must
**not** use the design system's *status* palette (good/warning/serious/critical)
— status colors are reserved for actual states, and borrowing one here would
render a rule of thumb as a verdict.

**Null, not zero or Infinity**, when equity is zero or negative — the same rule
M18.3 applies to a debt-free company. Negative equity is real and the ratio is
undefined, not catastrophic.

---

## 7. Budgets — one fork left open

Budget comparison is **in scope** (A4), with two prerequisites:

**🔴 Prerequisite 1 — the actuals defect.** `budgets.repository` computes
actuals as `sum(amount)` with **no debit/credit sign**, so a refund *increases*
"spent". Tracked as an audit leftover; it stops being tolerable the moment a
variance is charted, because the error becomes a visible claim.

**🔴 Prerequisite 2 — periodisation, UNDECIDED.** `budgets.period` is a `YYYY`
string: **annual only**, one row per category per year. A3 asks for monthly and
quarterly views. The owner has ruled out the easy path:

> **Do not apportion.** Annual ÷ 12 is wrong for a business with a Ramadan peak,
> and it would render as a variance — a guess about seasonality presented as a
> fact about performance.

So one of:

- **(a) Periodise budgets properly** — a schema change, plus a UI to enter them.
- **(b) Restrict budget comparison to ANNUAL and say so** — monthly and
  quarterly views simply carry no budget line.

**To be decided when Analytics is specced to build-depth, not after.** (b) is
cheap and honest; (a) is what a user with seasonal budgets will eventually want.

Also open, and tied to §4: **are budget actuals cash or accrual?** Pick the one
that matches whatever series shares the screen, or the two will disagree in
front of the user.

---

## 8. The Dashboard is absorbed (A11)

`/` is currently a "Financial Cockpit": four stat cards (Net Position, Total
Income, Total Expenses, Net VAT) with **no time dimension at all**. It is a
worse Analytics.

- **The Cockpit's content moves into Analytics.**
- **`/` becomes a landing that routes** — where you go, not another set of
  figures.
- Three surfaces answering adjacent questions is how the hub/Analytics split
  fails; this removes the third.

---

## 9. Charts (A8, A9)

`recharts` is already a dependency. Build-time work must follow the project's
visualization guidance; the decisions that belong in *this* document:

- **Never a dual-axis chart.** Money and ratios are different scales — they get
  **separate charts**, never two y-axes. (The single most common charting
  mistake, and it would put "cash balance" and "current ratio" on one canvas.)
- **A table view exists** for every chart. An accountant wants the numbers, and
  it is also the accessibility fallback.
- **Two points get charted** (A9). A new tenant sees a short line, not a refusal
   — but the sparsity is labelled, because two points are not a trend.
- **Gaps are honest** — see §3's per-point withholding.
- The categorical palette must be **run through the validator** before shipping,
  not eyeballed.

---

## 10. Build order (not started)

| # | Milestone | Content | Gate |
| --- | --- | --- | --- |
| **M19.0** | Budget actuals fix | ✅ **done** — sign-aware actuals by account type (§7 prerequisite 1). | — |
| **M19.1** | Trend read model | ✅ **done** — single-pass fold with per-point `claimable`; agrees with `balanceSheet(as_of)` by test, ≈22× faster and now linear in history (§6.2). | — |
| **M19.2** | Decomposition | ✅ **done** — ranked contributors by category / customer / vendor, with share NULL on offsetting movements and arrivals/departures kept (§5). Budget variance and the invoiced-vs-collected bridge remain held. | — |
| **M19.3** | The Analytics page | ✅ **done** — two separate charts (ratios / money, never dual-axis), decomposition bars, a table view, gaps at unclaimable points and the withheld summary. Palette validated in both modes. | — |
| **M19.4** | Absorb the Cockpit | Move the four cards in; `/` becomes a router (§8). | M19.3 |
| **M19.5** | Budgets | Blocked on §7's periodisation fork. | Owner decision |

⏳ **§4's "Collected" series is specified but not started** until the accountant
answers the cash-basis-vs-AR question.
