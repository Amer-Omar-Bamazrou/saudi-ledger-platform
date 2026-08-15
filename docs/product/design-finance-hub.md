# Finance Hub — DECISION RECORD and design

**Decided 2026-08-15 with the owner, by interview (Q1–Q9).** Round 1 of this
interview settled Zakat ([`design-zakat-module.md`](./design-zakat-module.md));
this is round 2 and covers the hub itself.

Supersedes the "placed but not defined" status the hub carried in
[`hub-structure-decision.md`](./hub-structure-decision.md) §5. That file's
placement decisions (two destinations, Automation/AI woven in, SME-first
without designing firms out) still stand.

---

## 1. The decisions

| # | Question | Decision |
| --- | --- | --- |
| **Q1** | What does it do? | **Answers "can I pay what I owe?" from the balance sheet.** Current assets and liabilities broken out from the GL; current ratio, quick ratio and working capital **computed and explained in plain language**; thresholds that matter are **flagged, not left to be noticed**. |
| **Q2** | What is its job? | **A control surface** — "is anything wrong?" is the question nothing currently answers. The landing page shows **state**, not another menu. |
| **Q3** | Replace Reports? | **No — sits beside it for now.** Replacing is a large reorganisation with no user feedback yet. |
| **Q4** | Who is it for? | **Owner-legible throughout.** If something needs accounting vocabulary, it is a report, not the hub. |
| **Q5** | Period close? | **A plain lock control in the hub.** A tenant cannot close a period at all today — a core function missing. A guided month-end close is premature. |
| **Q6** | Tax & Compliance | **The VAT return moves here, and ZATCA status too** — compliance state fits a control surface. |
| **Q7** | Reconciliation | **`/review` stays in Banking; the hub surfaces its COUNT.** Mirror the signal, not the page. |
| **Q8** | vs Analytics | **Hub = "are my books right and current". Analytics = "how is the business doing".** |
| **Q9** | The 26 locked reports | **Delete them.** Greyed-out promises of reports that do not exist are worse than absence. 🔴 **Found while building: they were worse than promises — see §8.** |

---

## 2. What follows — the hub's one sentence

> **The Finance Hub tells you whether your books are right, whether they are
> current, and whether you can pay what you owe — in words, without your having
> to read a report.**

Three consequences that govern every later decision:

- **It states, it does not list.** Q2 rules out a menu. Every element earns its
  place by reporting a *condition*, not by linking somewhere.
- **A signal must be actionable or silent.** Q7's "mirror the signal, not the
  page" generalises: the hub says *what is wrong* and links to *where it is
  fixed*. It never becomes a second place to do the work.
- **Plain language raises the correctness bar, it does not lower it.** "You can
  cover your short-term debts 1.8× over" is *more* dangerous than `1.8` if the
  inputs are wrong, because it removes the reader's ability to sanity-check the
  number. See §5.

---

## 3. 🔴 PREREQUISITE — the chart of accounts CANNOT express current vs non-current

**Owner asked; answer is no.** Checked against the live schema:
`categories` has `type` (`income|expense|asset|liability|equity`),
`system_code`, `is_system`, `vat_applicable`, `default_tax_treatment`,
`treatment_verified`. **There is no current/non-current field, and nothing
equivalent.** The balance sheet groups by `type` alone and lists items flat.

So **Q1 cannot be built until this exists.** It is a prerequisite in the same
sense M17.2's fiscal year was: not a nicety, a precondition for the figure
being meaningful.

### 3.1 The 14 balance-sheet accounts a tenant actually gets

| Code | Type | Proposed class | Certain? |
| --- | --- | --- | --- |
| `CASH` | asset | cash | ✅ |
| `AR` | asset | quick | ✅ |
| `VAT_INPUT` | asset | quick | ✅ |
| `INVENTORY` | asset | current (not quick) | ✅ |
| `FIXED_ASSETS` | asset | non-current | ✅ |
| `SUSPENSE` | asset | **current** (not quick) | ✅ decided — §5.1 |
| `INVESTMENTS` | asset | **non_current** | ✅ decided — §3.2 |
| `AP` | liability | current | ✅ |
| `VAT_OUTPUT` | liability | current | ✅ |
| `VAT_PAYMENT` | liability | current | ✅ |
| `ZAKAT_PAYMENT` | liability | current | ✅ |
| `SALARIES_PAYABLE` | liability | current | ✅ |
| `GOSI_PAYABLE` | liability | current | ✅ |
| `LOANS` | liability | **current** | ✅ decided — deliberately conservative, §3.2 |

**Also found: no `equity` accounts are seeded at all.** Equity on the balance
sheet is retained earnings (computed) plus whatever the tenant creates. It does
not affect liquidity ratios, but it means "from the balance sheet" is thinner
than it sounds.

### 3.2 The two ambiguous accounts — DECIDED (owner, 2026-08-15)

**`INVESTMENTS` → `non_current`.** IAS 1 classifies by intent and maturity:
marketable securities held for trading are current (and quick); a strategic
holding is non-current. One account cannot know which. Non-current *understates*
liquidity, and for a ratio whose whole purpose is "can I pay what I owe", erring
toward "less liquid than you think" is the safe direction. Tenant-overridable.

**`LOANS` → `current`. Deliberately conservative, and knowingly crude.**

Under IAS 1 a loan splits: the portion due within 12 months is a *current*
liability, the remainder *non-current*. A single account holds one balance and
cannot carry a split — this is structural, not an oversight. Three options were
costed:

- **(a) All non-current** — understates current liabilities, **overstates the
  ratio**. Rejected: wrong in the dangerous direction, on the one figure whose
  purpose is to warn.
- **(b) All current** ✅ **CHOSEN** — overstates current liabilities, so
  understates the ratio. Crude for a long mortgage: a tenant with a ten-year
  loan will see a worse liquidity position than they have. Accepted because the
  error runs toward caution, and because a hub that says "you look tighter than
  you are" fails safely where the reverse does not.
- **(c) Split accounts** (`LOANS_CURRENT` / `LOANS_NON_CURRENT`) — correct, and
  **recorded as the upgrade path** for when a real user needs it. Not now: it
  asks an SME owner to do amortisation splitting, which Q4 (owner-legible)
  rules out. Revisit at the first tenant with material long-term debt.

### 3.3 Proposed mechanism

A `liquidity_class` column on `categories`, meaningful for `asset` and
`liability` accounts only:

| Value | Meaning |
| --- | --- |
| `cash` | Cash and equivalents |
| `quick` | Other quick assets — receivables, short-term investments |
| `current` | Current but not quick — inventory, prepayments; and all current liabilities |
| `non_current` | Non-current assets and liabilities |

One column carries both facts the ratios need: *current vs not* (everything but
`non_current`) and *quick vs not* (`cash` + `quick`). A two-value
`current|non_current` column would force a second column or a hardcoded
"exclude inventory" rule the moment a tenant adds a prepayments account.

**🔴 NULL on a balance-sheet account must be VISIBLE, never silently defaulted.**
This is the M17.0 lesson applied before the fact: an unclassified account that
quietly counts as current would make the ratio wrong in a way nothing surfaces.
Since the hub is a control surface (Q2), an unclassified account **is itself a
signal**: *"3 accounts aren't classified — these ratios exclude SAR X."*

**Second consumer, and a live bug it fixes.** `reports.service.ts:204` currently
classifies cash-flow investing activity by **sniffing the account NAME**:

```ts
if (catType === "asset" && (cat?.name ?? "").toLowerCase().includes("fixed"))
```

That is the bug class M13 removed from the posting path — resolve by CODE, never
by name. A tenant who renames "Fixed Assets" to "Equipment" silently moves
fixed-asset purchases into operating cash flow, and nothing reports it. The new
column replaces the sniff, so the classification has two readers, not one.

---

## 4. The hub's blocks

Ordered by the question each answers. Every one states a condition.

### 4.1 Can I pay what I owe? (Q1 — the headline)

Current assets, current liabilities, working capital, and the two ratios — each
with a plain-language sentence, not a bare number. Flags when a threshold is
crossed (§5.2).

### 4.2 Are my books current?

- Unreviewed transactions — **count only**, linking to `/review` (Q7).
- Suspense balance ≠ 0 — money the platform could not classify (§5.1).
- Unclassified balance-sheet accounts (§3.3).
- Open period / last closed period (Q5).

### 4.3 Period close (Q5)

A plain lock control. Period locks work server-side and are company-scoped;
**they have had no UI since they were built**, so a tenant cannot close a period
at all. Not a guided flow — a control, with the current state visible.

### 4.4 Tax & Compliance (Q6, and Zakat's Q8)

The VAT return moves here from Reports; ZATCA credential/outbox status appears
as compliance *state*; Zakat lands here when M17.4 unblocks.

---

## 5. 🔴 Correctness risks specific to this feature

### 5.1 Suspense inflates liquidity, and plain language hides it

Since flaw #1, an accepted-but-uncategorised bank line posts to `SUSPENSE`,
typed `asset`. If that counts as a current asset, **"money we could not
identify" counts toward "money you can pay with"** — and a tenant with a messy
import gets a *better*-looking ratio than one who classified everything.

Worse, a suspense debit that is really an expense means assets *and* equity are
overstated, so the ratio is wrong in the optimistic direction — the one that
matters when the question is "can I pay what I owe?".

**Proposed:** suspense is included in the balance-sheet totals (the bank money
genuinely moved) but a material suspense balance **blocks the plain-language
claim** and shows as a control signal instead: *"SAR X is unclassified — clear
it before relying on these ratios."* That is the control surface doing its job
rather than a footnote nobody reads.

### 5.2 Thresholds are heuristics wearing the costume of computed facts

This is the Zakat failure in a milder form, and it is the main risk in Q1.

- The **formulas** — current ratio = CA/CL, quick ratio = (CA − inventory)/CL,
  working capital = CA − CL — are standard accounting definitions. No authority
  defines them differently in KSA. **No advisor verification needed.**
- The **current/non-current boundary** is an accounting-standards question, not
  a matter of taste: IAS 1's twelve-month / operating-cycle test, under IFRS as
  adopted in Saudi Arabia. It should be **followed and cited**, not invented —
  but it is determinate, so it does not need a paid opinion either.
- The **thresholds** ("quick ratio below 1 is a problem") are **rules of thumb**.
  No standard sets them; they vary by industry and business model. They must be
  rendered as judgment, never as compliance — no red "FAIL", no language
  implying a rule has been broken.

So the answer to the owner's second question is **differentiated, not blanket**:
nothing here needs the advisor the way Zakat's base composition did, but the
*framing* needs discipline the raw numbers do not. A wrong Zakat figure gets
filed; a wrong liquidity sentence gets believed.

### 5.3 Pending rows are excluded, correctly, and that must be said

The GL includes bank transactions only once **accepted** (flaw #1 posts at
acceptance). A tenant with 200 unreviewed rows has a balance sheet that is
correct-as-of-what-was-reviewed and stale as a picture of the bank. §4.2's
unreviewed count is what keeps that honest — which is why Q7's "surface the
count" is load-bearing rather than decorative.

---

## 6. Scope

**In:** the liquidity block, the books-current signals, the period-lock control,
Tax & Compliance placement, deleting the 26 locked reports.

**Out:** replacing the Reports section (Q3); a guided month-end close (Q5);
anything answering "how is the business doing" (Q8 — that is Analytics);
trend/history of ratios (needs a decision on whether the hub keeps time series
at all).

---

## 7. Build order

| # | Milestone | Content | Gate |
| --- | --- | --- | --- |
| **M18.0** | Delete the locked reports | Q9 — 26 placeholder entries removed, plus the paywall vocabulary and the flag that made them possible (§8). Guarded by `tests/reports-catalogue.test.ts`. | ✅ done |
| **M18.1** | **Liquidity classification** | §3 — `liquidity_class` on the chart of accounts, seeded for the 14 system accounts, tenant-overridable in the COA UI; the cash-flow name-sniff replaced. | ✅ decided (§3.2) |
| **M18.2** | Balance-sheet breakout | Current / non-current / **unclassified** sections in `reports.balanceSheet`, as a PARTITION of the existing totals so `balanced` keeps reconciling. Plus `quickTotal` (the acid-test numerator M18.3 consumes). | ✅ done |
| **M18.3** | The hub, blocks 4.1 + 4.2 | ✅ done — liquidity in plain language with the claim WITHHELD when it cannot be stood behind; the unreviewed-count signal mirrored from /review. | ✅ done |
| **M18.4** | Period lock control | Q5 — the first UI for a capability built long ago. Creates the `/finance-hub` page (its first block) and closes the `/period-locks` known-gap entry. | ✅ done — §9 |
| **M18.5** | Tax & Compliance | Q6 — the VAT return moved out of Reports into the hub block; ZATCA connection state surfaces beside it. 🔴 The VAT PERIOD is the calendar quarter and is stated as such: KSA filing frequency is not modelled anywhere, so the block must never read as "your VAT return". | ✅ done |

---

## 8. 🔴 Found while building M18.0 — the placeholders were a false PAYWALL

Q9 described the 26 entries as "greyed-out promises of reports that don't
exist". They were that, and one thing more, which only showed up on opening the
file:

- Each padlocked entry carried the tooltip **"Upgrade to unlock this report"**.
- The page header read **"13 available · 26 premium · 39 total"**.
- Above the grid sat a banner: **"Unlock premium reports — upgrade your plan to
  access all 26 locked reports."**

**There is no plan.** No billing, no subscription model, no paid tier, and no
pricing decision anywhere in this product. So the page was not merely promising
absent reports — it was making a **commercial claim false in both halves**: a
tier the tenant cannot buy, gating reports nobody has written. For a product
that has not signed its first customer, that is the worst possible thing to have
been shipping quietly.

**One padlocked entry was already built.** "Cashflow Report" was greyed out
behind the upgrade prompt while `/cash-flow` has been a routed page in the main
navigation the whole time. The catalogue was charging for something already
shipped. It is restored with its real link rather than deleted — the entry was
never the problem, the padlock was.

**What was removed:** the 26 entries, the three now-empty categories (Sales,
Employee, Fixed Asset Reports), the `locked` field itself, the tooltip branch,
the premium counter and the upgrade banner. Removing the entries while leaving
the *flag* would simply invite the next 26.

**The guard:** `apps/api/src/tests/reports-catalogue.test.ts` reads
`ReportsHub.tsx` and `App.tsx` as source and fails if any catalogue entry has no
mounted route, or if the locked/premium vocabulary returns to the code. Prose in
comments is exempt by design — the file's header records what was removed and
why, and that record is the point.

**The general shape, worth carrying:** a UI affordance can assert something the
business has not decided. A padlock is a claim about *commercial terms*; a
greyed-out row is a claim about *the roadmap*. Both were invented by whoever
laid out the page, and neither had an owner. When a screen implies a fact about
the business — a price, a tier, a forthcoming feature — that fact needs a
decision behind it, exactly as a tax figure does.

---

## 9. M18.4 as built — and a gate we cannot implement on the client

The Finance Hub page now exists at `/finance-hub`, holding **one** block:
closing the books. M18.3 adds the liquidity block and the books-current signals
above it. The page was created now rather than at M18.3 because the lock control
belongs here (§4.3), and building it standalone would have meant moving it a
milestone later.

**What it closes.** `/period-locks` had sat in the route-reachability guard's
known-gap list since that guard was written: the API, the company-scoped route
fix (M14) and the posting-path guard were all real and tested, but a tenant
could not close a period from the product. It was the most core accounting
function the platform did not expose.

**The route predated the OpenAPI-first rule** and had no spec entry at all —
nothing typed the client, and the controller read `req.body` raw. It is now
specced (`listPeriodLocks` / `lockPeriod` / `unlockPeriod`), generated, and
validated at the edge. The service's own format check stays: it is the
write-boundary guard, and the edge check is for a readable error.

### 🔴 The control is NOT gated on the client's role, deliberately

`AuthContext.user.role` comes from `GET /auth/me`, which returns `users.role` —
the field CLAUDE.md §4 states is **vestigial and must never gate access**,
because the `organization_memberships` role governs. That endpoint does not
return the membership role, so **the frontend cannot know the governing role
today.**

Gating on the field it does have would be wrong in both directions: hiding the
control from a real org admin whose `users.role` says otherwise, or offering it
to someone the server will refuse. So the server stays the authority
(`requirePermission("period_locks")` — read for every role, create/delete
admin-only) and a 403 is surfaced as a plain sentence rather than pre-empted by
a guess.

**Recorded as a gap, not a preference:** any future UI needing to know "is this
user an admin of this org?" hits the same wall. The fix is for `/auth/me` (or a
sibling) to return the *membership* role for the active organization. Worth
doing before the hub grows admin-only blocks.

### The M14 regression finally has a test

The company-scoping fix — where one company's unlock **deleted every other
company's lock for that period**, silently reopening closed books across a
multi-company organization — was fixed in M14 with no permanent test. RLS does
not prevent it (both rows belong to the same organization); only the explicit
`company_id` filter does. M18.4 is the milestone that puts the button in front
of a user, so the regression is now pinned: two companies, same month, one
reopens, and the other's lock must survive — asserted through the service and
again directly against the table.
