# Product structure — the four hubs (DECISION RECORD)

**Decided 2026-08-12 with the owner, by interview.** This supersedes any earlier
inferred description of the hubs — in particular the M12 close-out orientation,
which CLAUDE.md correctly flags as a reading of the gap rather than a spec.

This file records **what was decided and why**. It is deliberately not a feature
list: only Automation has been interviewed to the depth a spec needs, and that
spec lives in [`feature-spec-automation.md`](./feature-spec-automation.md).

---

## 1. The decisions

| # | Question | Decision |
| --- | --- | --- |
| 1 | Are the hubs destinations or capabilities? | **Two destinations, two woven in.** |
| 2 | Who is the paying customer? | **Both — the SME keeping its own books FIRST, accounting firms later.** |
| 3 | What is the wedge? | **Automation.** AI is the moat, not the wedge. |
| 4 | Where does AI run? | **Parked**, with an explicit expiry trigger (§4). |

---

## 2. Structure: two destinations, two woven in

**Finance Hub** and **Analytics** get navigation entries and landing pages.
**Automation** and **AI** get **no navigation entry at all** — they appear inside
the pages where the work already happens.

```
SIDEBAR                     WHERE AUTOMATION + AI LIVE
  Dashboard
  Sales      → Invoices  ····  [↻ Make recurring]  [✨ suggest]
  Purchases  → Bills     ····  [📷 Scan document]  [✨ match supplier]
  Banking    → Transactions ·· [🔗 Connect bank]   [✨ categorise]
  Finance Hub    ← destination
  Analytics      ← destination
  Reports
  Settings                ···· [⚙ Automation rules — settings, not a hub]
```

**The reasoning, so a future session does not "tidy" it into four sections:**

- A recurring-invoice rule is a property **of an invoice**. Putting it in a
  separate Automation section means leaving the invoice you are looking at to
  configure something about it, then coming back.
- An AI suggestion is only useful **at the moment of the decision it informs** —
  next to the category field, not in a gallery of suggestions elsewhere.
- The customer is an SME owner, not an accountant (§3). Every additional nav
  entry is a thing they must learn before the product is useful. Two new
  destinations is already a lot.
- Automation and AI having no home of their own is the point: **the measure of
  success is that the user does not think about them.**

**Consequence for building:** there is no "Automation Hub" epic. Automation
features attach to existing pages, and each is specced as a change to that page.
The only shared surface is a settings screen listing rules the user has created,
reachable from Settings — a list, not a hub.

---

## 3. The customer: SME first, firms later — and the difference matters

**Both markets, SME first.** The product being built now is the SME product. What
this decision buys is not a feature list; it is a **constraint on what may be
foreclosed.**

### Build for this user

- **The reader is not an accountant.** Terms like "journal entry", "trial
  balance" and "input VAT" may appear in reports, but no primary workflow may
  *require* understanding them.
- **Onboarding is disproportionately important**, because the buyer is also the
  implementer. There is nobody to configure it for them.
- **One company is the normal case.** Design every screen as though the user has
  exactly one, because they do.

### 🔴 But do not design firms OUT

This is the operative half of the decision, and the reason it is not "SME only".
A firm keeps books for many client businesses. The `organization → company`
hierarchy already supports that shape — the cost of keeping the door open is low
now and high later.

**Concretely, when building SME features:**

| Do | Do not |
| --- | --- |
| Keep "the active company" a real, resolved concept (it already is — `app.current_company_id`, per-company ZATCA identity, M13's per-company period locks) | Collapse "the active company" into "the only company", or hardcode a single-company assumption into a query, a route or a screen |
| Let services take a company as input | Reach for "the org's first company" — the M12.1a bug, twice |
| Leave room in the navigation for a client switcher (the org switcher already exists) | Redesign the shell around the assumption that there is nothing to switch |
| Treat batch/bulk capability as **deferred** | Treat it as **impossible** — see the automation spec, where bulk intake is deferred rather than excluded |
| Keep membership roles per-organization | Assume one user ⇒ one company |

### Still out of scope NOW

Client switcher UI, cross-client dashboards and triage, staff assignment,
per-client billing, client portals. These are the firm *product* and none is
built. They are **deferred, not rejected** — the distinction that separates this
answer from "SME only".

**Trigger to revisit:** the first paying accounting firm, or any SME customer
managing more than about three companies. At that point firms stop being
hypothetical and get their own interview.

## 4. AI is the moat, not the wedge — and hosting is parked

The wedge is **"I stopped doing data entry"** — the thing an SME feels daily and
will pay to remove. AI is what keeps them once the platform holds their data.

Sequencing follows from a technical fact, not a preference: **automation produces
the substrate AI needs.** Anomaly detection and variance explanation over
hand-typed, sparse, half-categorised data disappoint — and disappointing on a
differentiator is expensive. Clean structured transaction data has to exist
first.

### 🔴 When parking AI hosting stops being safe

Today's code assumes a local Ollama model (`LLM_MODEL=none` by default) at
`/llm/{status,categorize,compare,demo}` — an evaluation harness, not a shipped
feature. That is fine to leave alone. Parking the hosting decision **stops being
safe at the first of these**, and the decision must be made before the feature is
**specced**, not before it is built:

1. **Any feature that reasons over a tenant's whole ledger** — anomaly detection,
   variance explanation, ask-your-books. The quality ceiling determines whether
   the feature is deliverable at all, so speccing against an undecided model
   risks speccing something impossible.

   🔴 **CLARIFIED 2026-08-15 (Analytics interview), because "variance
   explanation" read as a trigger when half of it is not one.** The line is:

   > **State WHERE a change came from, never WHY it happened.**
   > Decomposition is arithmetic; causation is inference.

   *Decomposition* — "income fell SAR 45,000; three customers account for 80% of
   it" — is ranked subtraction over rows we already store. It computes; it does
   not reason, it cannot be wrong in a way a better model would fix, and it
   **does not trip this trigger.** Analytics may build it with AI still parked.

   *Causation* — "because you lost a customer", "because the market slowed" —
   and free-text narrative, statistical anomaly detection over sparse data, and
   recommendations, all **do** trip it. Those stay parked until hosting is
   decided.

   Without this distinction the trigger reads as blocking a deterministic
   arithmetic feature, which was never its intent — the intent is that the
   MODEL's quality ceiling must be known before it is depended on, and nothing
   here depends on a model.
2. **Pricing any per-transaction AI feature.** Cost per token becomes cost per
   invoice; you need the number before committing to it.
3. **Settling KSA data residency.** AI hosted abroad with data resident
   in-country is a contradiction that has to be unpicked, not discovered.

Until then, any AI surface is specced against a **provider-agnostic interface** —
the same hedge as `KeyWrapper` (M12.5) and `ArchiveStore` (M12.8).

### The constraint that governs all of it

**"AI proposes, it never posts"** (CLAUDE.md §5.6) is now a *central product
constraint* rather than a side rule. If AI is the retention mechanism, the
**proposal-and-review surface is the product**.

The pattern already exists and should be generalised rather than reinvented:
`ScanReview.tsx` shows raw extraction beside validated output, flags fields that
need attention, makes everything editable before anything touches the database,
proposes a journal entry, and posts through the **same** path a human-entered
bill uses. Every future AI proposal should look like that.

---

## 5. Not yet specced — and deliberately not inferred

**Finance Hub** and **Analytics** have been *placed* (they are destinations) but
not *defined*. No interview has established what they contain, who opens them, or
what problem they solve.

They are **not** specced here on purpose. Writing a plausible feature list for
them is precisely the failure this exercise exists to avoid, and CLAUDE.md
already warns that any such list produced from the codebase is a reading of the
gap, not a specification.

**Next step for both: interview, then spec.** The open questions are about the
business, not the implementation — what does the SME owner do today that these
would replace, and what do they look at when they want to know whether the
business is alright.
