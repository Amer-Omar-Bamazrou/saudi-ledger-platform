# R1 — Billing: a proposal, and the questions it cannot answer

**Status (2026-08-27): PROPOSAL. Nothing built, nothing decided.**
**Current state authority: [`CLAUDE.md` §2](../../CLAUDE.md).**

Same shape as the hub and AI-layer interviews: what exists, what I would
propose, and the questions that are the owner's to answer. Proposals are not
decisions — nothing here should be read into a decision record until it comes
back answered.

---

## 1. What already exists — verified by grep, not assumed

Before costing anything, the inputs. (The named lesson: cost an option *after*
verifying its inputs exist.)

| Input | Reality |
|---|---|
| `organizations.plan` | `varchar(50) NOT NULL DEFAULT 'free'`, commented "billing tier placeholder". **No reader. No writer.** |
| `organizations.status` | `varchar(50) NOT NULL DEFAULT 'active'`. **No reader. No writer.** |
| `feature_flags` | Table exists, org-scoped with a global-default row shape. **Zero consumers** — already recorded as an S6/S7 trap. |
| `ai_usage` | **Real and live.** Append-only, per `(organization_id, company_id)`, records operation/provider/model/prompt+completion tokens/latency/ok/createdAt, indexed on `(org, createdAt)`. |
| Currency | **SAR only**, enforced at the write boundary (migration 0062) with a CHECK on nine tables. |
| Provider seams | Established pattern: `mailer`, `alerter`, `ArchiveStore`, `KeyWrapper`, `MalwareScanner`. |
| Payment code | **None anywhere.** No Stripe, Moyasar, HyperPay, or equivalent. |

🔴 **`organizations.plan` is the M20.0 lying-column shape, exactly.** A
`NOT NULL DEFAULT` makes every organization *assert* it is on a free plan — a
commercial fact about a relationship nobody has entered into, written by a
default rather than by anyone's decision. M20.0 removed precisely this pattern
from `fiscal_year_start`, and the corollary applies here too: **a removed
default is an invariant, and every path that can write the column must be
checked, not just the layer that declared it.**

---

## 2. 🔴 The precedent that governs this entire design

**M18.0 — the false paywall.** The Finance Hub shipped, quietly, with:

- padlocks tooltipped *"Upgrade to unlock this report"*,
- a header reading *"13 available · 26 premium · 39 total"*,
- a banner: *"Unlock premium reports — upgrade your plan."*

There was no plan. It was a commercial claim false in both halves: a tier
nobody could buy, gating reports nobody had written. **And one padlocked entry
was already built and shipped free** — the catalogue was charging for something
the tenant already had.

Two things carry directly into R1:

1. **`tests/reports-catalogue.test.ts` actively fails if `locked`/`premium`
   vocabulary returns to the code.** Building tiering means deliberately
   confronting that guard. That is a feature: it forces the paywall to be a
   decision with an owner rather than a UI affordance someone laid out.
2. The general rule, already recorded: *a padlock is a claim about commercial
   terms; when a screen implies a fact about the business, that fact needs a
   decision behind it, exactly as a tax figure does.*

**Proposed hard rule: no gating affordance ships before a plan exists that can
actually be bought.** Not the flag, not the padlock, not the counter.

---

## 3. What is genuinely tier-able — and what would be artificial

This is the question I most want answered, so here is my reasoning rather than
just a list.

### 3a. Proposed principle (Q1)

> **Tier on capacity and consumption. Never on correctness or compliance.**

The tenant is buying books that are *right*. Withholding correctness is selling
a defect and charging to remove it. Withholding compliance is worse: VAT filing
and e-invoicing are legally mandatory in Saudi Arabia, so a tenant who cannot
issue a compliant invoice because they are on a lower tier is **illegal, and we
caused it**. In a market where filing is compulsory, that reads as predatory
and is the kind of thing that ends a B2B relationship permanently.

### 3b. Must always work — my argument for each

| Capability | Why it cannot be a tier |
|---|---|
| GL, double-entry, period locks | This *is* the product being correct. |
| VAT return | Legally mandatory. Gating it gates the tenant's compliance. |
| ZATCA e-invoicing (issue, sign, clear/report) | Same, and stronger — a blocked invoice is an unrecoverable ICV gap. |
| Audit trail, security events | Gating these gates *our own* correctness story. |
| **Data export** | Gating export makes leaving expensive. That is hostage-taking, and PDPL portability points the same way. |
| Anything already shipped free | The Cashflow Report lesson: never re-gate what a tenant already has. |

### 3c. Plausibly tier-able — capacity, not capability

- **Companies per organization** (real infrastructure, real value; the
  multi-company tenant is a bigger business)
- **Seats / active members**
- **Document or transaction volume** per period
- **Retention beyond the statutory minimum** (never below it)
- **AI consumption above an included allowance** — see §6
- Support responsiveness

### 3d. The genuine grey zone — I do not have a view I would defend

- **Analytics / Finance Hub insight.** Capability, not compliance. Tier-able in
  principle — but M18.0's ghost is exactly here, and several of these are
  already shipped free.
- **The AI advisor (grounded answers).** The most obviously premium capability
  in the product, and the one with real marginal cost. But it is dark until the
  Enterprise agreement exists (§6).
- **Recurring documents / automation.** The stated *wedge* (hub decision Q3).
  Gating the wedge to sell the moat may be backwards.

### 3e. 🔴 `feature_flags` is the wrong mechanism for plan gating

It is tempting because the table exists. It would be a mistake:
`feature_flags` cannot distinguish **"we turned this off for operational
reasons"** from **"you have not paid for this"**. Those are different facts with
different owners, different audiences and different remedies — collapsing them
into one boolean is the one-writer-per-effect violation, and the first
support conversation about it will be unanswerable.

**Proposed: plan entitlement is derived from the subscription, not from a
flag.** `feature_flags` stays what its name says (an ops toggle) or is dropped
(Q12).

---

## 4. The payment-provider seam

### 4a. Shape

Modelled on the existing seams. Provider chosen by env; production refuses to
boot with `none` once billing is live (the `mailer`/`alerter` posture). The B3
rule applies: **a method that cannot do the thing must throw, never return** —
a no-op "charge succeeded" is a false statement the caller builds on.

### 4b. 🔴 The question that determines the seam's whole shape (Q6)

**Who holds the card?** We must never touch a PAN — that is a PCI scope we have
no reason to enter. So the seam is almost certainly:

- **hosted checkout / redirect**, or a **provider-hosted tokenisation widget**,
- we store a provider **customer id** and a **token**, never card data.

Moyasar and HyperPay differ in exactly this area, so **the seam must not
presume either.** What it must express:

| Operation | Notes |
|---|---|
| create/find customer | provider id stored per organization |
| start a checkout / authorise a mandate | returns a redirect URL or client token |
| fetch subscription/charge state | the source of truth is the provider, not us |
| verify an inbound webhook | signature verification, mandatory |
| refund / credit | Q — may be manual in v1 |

### 4c. 🔴 A webhook adds a route to the PUBLIC tier

An inbound webhook is unauthenticated by session and must be mounted **above
`requireAuth`**. Consequences, from work already done this month:

- The **privilege surface map** pins the public surface at exactly four mounts.
  Adding a fifth is a deliberate, reviewed change — which is the point.
- It sits in the tier with **no RLS backstop**, so its authorization is entirely
  the signature check.
- **Idempotency is not optional.** Providers retry; the same event will arrive
  twice. Subscription events must be keyed on the provider's event id with a
  unique constraint, so a replay is a no-op rather than a second month of
  credit.

---

## 5. Subscription state, and the boundaries

### 5a. Where it lives

**Not `organizations.plan`.** Proposed instead:

- `subscriptions` — one current row per organization: provider ids, plan key,
  state, current period start/end, trial end, cancel-at.
- `subscription_events` — **append-only**, one row per provider event, keyed by
  provider event id. The M14 grant posture (SELECT + INSERT, no UPDATE/DELETE):
  the record of what a customer was charged is exactly the row someone would
  want to quietly fix.

🔴 **Nullable, no default, "not subscribed" as a first-class state** — the
M17.1/M20.0 posture in a third place. An organization with no subscription row
has *not been asked* and has not agreed; that is different from being on a free
plan, and the schema should not conflate them.

### 5b. The boundaries — the hard part

**Trial ending (Q3).** Proposed: **degrade to read-only + export, never lock the
books.** Their ledger is their legal record; they may need to file a VAT return
for a period they have already paid for, or produce records for ZATCA years
later. A product that holds statutory records hostage for a missed payment is
one regulator complaint from a serious problem.

**Payment failing (Q5).** A dunning ladder, and the shape is already settled by
AI-5's escalation: notify **active admins only** (B1's mailer is live), a
bounded number of retries, then degrade — never delete. Open: how many retries,
over how long, and whether an in-app marker precedes the email.

**🔴 Downgrading with data that exceeds the lower tier (Q4).** The genuinely
hard one, and the one most likely to be got wrong. If the tier is "3 companies"
and they have 5:

| Option | Verdict |
|---|---|
| (a) Block the downgrade | Honest but traps them on a price they have said they do not want to pay |
| (b) Allow it; freeze *creation* of new companies; leave existing ones working | **Recommended** — never destroys, never surprises |
| (c) Allow it and bill overage | A surprise charge is worse than a refused button |
| (d) Delete/archive the excess | **Never.** See below |

**🔴 The one-way door: never delete tenant data for non-payment.** ZATCA
requires 6–11 year retention; the `ArchiveStore` has no `delete` method by
design; PDPL erasure is a *separate*, rights-based question. Non-payment is not
a lawful reason to destroy a taxpayer's records, and our own architecture
already refuses to.

---

## 6. What `ai_usage` implies for usage-based billing

The machinery exists and was built with billing in mind. What it does **not**
yet support:

1. **It records tokens, not money.** There is no cost column and no price
   table. Converting requires a rate — and rates change, so the rate must be
   **snapshotted per billing period** (or the cost stored at write time),
   otherwise re-running last month's bill silently produces a different number.
2. 🔴 **The existing "estimated cost" definition is now stale.**
   `design-ai-layer.md` §11 defines cost as an *internal amortized rate*
   (GPU + hosting ÷ throughput), "never presented as a market price". That was
   written for **self-hosting**. The hosting decision then changed to **Groq**,
   which has a real published per-token price. So §11's definition no longer
   matches the chosen architecture. **This inconsistency should be resolved
   before any AI line appears on an invoice** (Q9).
3. **It is per `(org, company)`; billing is per org.** Aggregation is
   straightforward, but the grain difference should be deliberate.
4. **Failures are rows (`ok = false`), by design.** Some failed calls still cost
   us (tokens generated before a timeout); some cost nothing. **Do we bill
   them?** (Q8). Billing a failure the tenant experienced as an outage is
   indefensible; silently absorbing all of them may be fine at SME volumes.
5. **The meter is append-only and cannot be corrected** — correct. If a bill
   computed from it is wrong, the remedy is a credit note, not an edit.
6. 🔴 **Never bill from a live query.** A bill must be a **snapshot**: computed
   once, stored as invoice lines, and never recomputed on read. This is the
   AI-3b lesson generalised — *a validated artefact must bind to the inputs it
   was computed from*, or it ages into a false claim. An invoice that changes
   when you reopen it is not an invoice.

**Proposed for v1 (Q7): bundle an AI allowance into the plan, meter it, show
consumption, and bill nothing usage-based yet.** Reasons: AI is dark for tenant
data until the Enterprise agreement exists, the per-tenant cost estimate is
~$0.50–1/month at SME volumes, and metered billing's complexity is unjustified
before there is a second customer to compare.

---

## 7. 🔴 Billing must not touch the tenant's ledger — in both directions

### 7a. Our revenue is not their revenue

A subscription payment is **income to us** and **an expense to them**. If it
ever posted to a tenant's general ledger as income, their books would be wrong
in the most embarrassing possible way.

**Proposed structural enforcement, not a convention:**

- the billing service **must not import `glPosting`**, and the subscription
  tables carry **no `journal_entry_id`**;
- pinned by a boundary test in the style of `identity-table-boundary.test.ts` —
  the billing module's import graph must not reach the accounting core.

That makes the wrong thing hard to express rather than merely discouraged.

### 7b. But the tenant legitimately *wants* it in their books

It is a deductible business expense with recoverable input VAT. So the correct
outcome is not "keep it out of their ledger" — it is:

> **We issue them a tax invoice. They record it like any other supplier bill,
> through the normal path, by their own action. We never auto-post it.**

That is consistent with the standing rule that automation proposes and a human
approves, and it avoids inventing a second posting path into a tenant's books.

### 7c. 🔴 The consequence nobody usually notices, and it couples R1 to the entity

If we are a **KSA VAT-registered supplier selling to Saudi businesses**, then
our own invoices to tenants are **subject to ZATCA e-invoicing** — our own
certificate, our own ICV chain, our own clearance. The platform becomes a
taxpayer using its own product.

Two consequences:

- **R1 is only partly independent of the entity blocker.** Taking money for
  customer #1 with an off-platform invoice works. Doing it *compliantly at
  scale* needs the same registration everything else waits on.
- There is an upside worth naming: it is the most honest dogfooding available —
  our first e-invoicing taxpayer would be us.

**(Q10.)** Also out of scope, explicitly: **our own books.** We are not
building an ERP for ourselves. The provider's reporting plus an accountant.

---

## 8. What I would deliberately NOT build in v1

Stated so their absence reads as a decision:

- **No proration engine.** Complex, and worth nothing at one customer.
- **No self-serve plan switching.** An email and a manual change is fine at this
  scale, and it keeps the downgrade rule (Q4) a human decision while it is still
  being learned.
- **No usage-based AI billing** (§6).
- **No automated dunning** until there is a second customer.
- **No invoicing of tenants through our own ZATCA chain** until the entity
  exists (§7c).

---

## 9. The questions

| # | Question |
|---|---|
| **Q1** | Tier on **capacity and consumption only**, or is capability (Analytics, the AI advisor, automation) tier-able too? |
| **Q2** | Is there a **free tier at all**, or is it trial → paid? |
| **Q3** | Trial length, and what happens at its end — read-only + export, or something else? |
| **Q4** | The downgrade-with-excess-data rule: block, freeze-creation *(recommended)*, or bill overage? |
| **Q5** | The payment-failure ladder: how many retries, over how long, who is told, what degrades? |
| **Q6** | Hosted checkout / redirect, or provider-hosted tokenisation? This determines the seam's shape more than the vendor choice does. |
| **Q7** | Bill AI usage in v1, or bundle an allowance and meter only? |
| **Q8** | Do we bill **failed** AI calls (`ok = false`)? |
| **Q9** | §11's "internal amortized rate" is stale now that hosting is Groq. Replace with the real per-token price? |
| **Q10** | Do we issue tenants **ZATCA-compliant tax invoices** — and does that wait for the entity? |
| **Q11** | Pricing itself: per seat, per company, flat, or hybrid? What is the actual number? |
| **Q12** | `organizations.plan`, `organizations.status`, `feature_flags` — **drop or adopt?** My recommendation: drop `plan` (a lying column), leave `status` alone or drop it, and keep `feature_flags` as an ops toggle only. |

---

## 10. Build order, if the answers permit

Proposed, not decided. Each stage is independently shippable and none of them
displays a commercial claim until stage 4.

1. **Schema + state machine.** `subscriptions` + append-only
   `subscription_events`; drop `organizations.plan`. No UI, no gating.
2. **The seam + webhook.** Provider-agnostic interface, signature verification,
   idempotency by provider event id, the public-tier mount reviewed against the
   surface map.
3. **Entitlement resolution.** One function answering "what is this org
   entitled to", derived from the subscription — no flags, no padlocks yet.
4. **Gating, once a plan can actually be bought.** This is the stage that
   confronts `reports-catalogue.test.ts`, and it should.
5. **Metering surface.** Show AI consumption against allowance. Bill nothing.
