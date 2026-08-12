# A2 — bank aggregation provider outreach

**Purpose: get comparable answers from the three SAMA-licensed providers before
A2 is designed.** Started in parallel with A3 because the lead time is real and
cannot be compressed later — pricing, bank coverage and our obligations under
their licence gate the *design*, not just the build.

**Send to:** Lean Technologies · Malaa · Tamawal.

---

## 🔴 Read first: this conversation may itself be gated

Saudi open banking left SAMA's sandbox in March 2026 and is now a licensing
regime. Consuming a licensed provider almost certainly requires **a Saudi
commercial registration** to contract with — and **that entity does not exist
yet**, which is the same blocker holding M12.7 and M12.9.

So treat this as **exploratory, not contractual**. Pricing, bank coverage and
sandbox access are all answerable without an entity; a signed agreement is not.
If a provider says "we can only proceed with a registered Saudi entity", that is
expected — get the commercial answers anyway and record the requirement.

**This also raises the priority of the entity registration**, which was
previously blocking only M12.7/M12.9. It now blocks a second workstream.

---

## The message

> **Subject: Open banking (AIS) for a Saudi accounting platform — pricing and coverage enquiry**
>
> Hello,
>
> We are building an accounting and e-invoicing platform for Saudi SMEs, with
> ZATCA Phase 2 clearance and reporting implemented directly. We are scoping
> bank connectivity so our customers' transactions arrive automatically instead
> of being uploaded by hand, and we are evaluating SAMA-licensed account
> information providers.
>
> We are at the design stage and comparing providers on equal terms, so
> specific answers to the questions below would help more than a general
> overview. Happy to sign an NDA covering commercial terms if needed.
>
> 1. **Pricing model.** Per connected account per month, per API call, per
>    end-customer, or a platform fee? Indicative figures at, say, 100 and 1,000
>    connected accounts.
> 2. **Bank coverage.** Specifically Al Rajhi, SNB, Riyad Bank, SAB and Alinma —
>    which are live today, and which are in progress with what timeline?
> 3. **Our regulatory position.** As a platform consuming your licence, what are
>    our obligations? Do we need our own SAMA registration, are we a
>    sub-participant, and what do we carry contractually?
> 4. **Consent lifecycle.** How long does a customer's consent last, what does
>    re-consent look like for the end user, and what happens to the connection
>    when it expires?
> 5. **Historical depth on first connect.** How many months of past
>    transactions are available when a customer first links an account?
> 6. **Sandbox.** Can we build and test against a sandbox before a commercial
>    agreement, and what is required to get access?
>
> One practical note: our Saudi entity registration is in progress, so at this
> stage we are gathering information rather than contracting. If any of the
> above requires a registered entity, please say so and we will plan around it.
>
> Thank you,
> [name]

---

## Why these six, and what each answer changes

| Q | What it decides |
| --- | --- |
| **1 Pricing** | The largest recurring line in the product, and the only one scaling directly with customer count. **Per-connected-account-per-month scales with revenue; per-API-call scales against it** — a chatty sync on a quiet customer costs the same as a busy one. |
| **2 Coverage** | **A provider missing Al Rajhi is unusable** for a Saudi SME product regardless of price. This is a pass/fail question, not a scoring one. |
| **3 Our obligations** | Whether A2 is an integration or a **regulatory undertaking**. The alternative — our own AISP licence — is SAR 1M capital and ~6 months, so what we carry under theirs is the whole basis of the decision. |
| **4 Consent** | SAMA consent is time-bounded. An expired consent that silently stops syncing is the **same quiet-neglect failure** as the ZATCA outbox, and it has to be designed as an alarm rather than a status field. Their expiry model determines that design. |
| **5 History** | 12 months makes a new customer's first close possible; 30 days does not. It is the difference between onboarding being a delight and a chore. |
| **6 Sandbox** | Whether A2 can be built before the entity exists. If yes, the entity blocks launch but not development. |

---

## 🔴 What NOT to commit to in a first conversation

- **No volume commitments or minimum spend.** We have no customers yet. A
  minimum is a fixed cost against zero revenue.
- **No exclusivity**, in either direction. We are comparing three providers and
  must stay free to switch — that is the whole point of the `BankFeed` interface.
- **No go-live date.** A2 is gated on the entity and on A3 shipping first. A date
  given casually becomes a date quoted back.
- **Do not accept pricing on the call.** Take it away, compare all three, then
  negotiate. First quotes to a pre-launch platform are rarely the best ones.
- **🔴 Do not sign an NDA that restricts talking to competitors.** Some vendor
  NDAs quietly include non-solicitation or exclusivity-of-discussion clauses.
  An NDA covering *their* commercial terms is normal and fine; one that limits
  who else we may approach defeats the comparison.
- **Do not agree to a technical integration "pilot" that presumes the contract.**
  Sandbox access should not require choosing them.
- **Do not overstate scale.** Say we are pre-launch. It is true, it will emerge
  anyway, and being caught inflating numbers costs more than the discount an
  inflated number might win. "Building now, launching with our first cohort" is
  accurate and adequate.

---

## What to bring back

Three filled-in answer sets, side by side. The decision then follows from the
spec: coverage is pass/fail, obligations decide feasibility, pricing decides
between whoever survives the first two.

Record the answers in this file so the comparison is durable rather than living
in an inbox.
