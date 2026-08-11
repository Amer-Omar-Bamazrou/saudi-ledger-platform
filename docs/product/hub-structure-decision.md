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
| 2 | Who is the paying customer? | **The SME keeping its own books.** Not accounting firms. |
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

## 3. The customer: an SME keeping its own books

Not accounting firms. This was asked explicitly and answered explicitly.

**What follows from it:**

- **One company in practice.** The `organization → company → branch → department`
  hierarchy stays (it is built and ZATCA needs per-company identity), but no
  product surface is designed around a user switching between many companies.
- **No client switcher, no cross-client triage, no client portal, no staff
  assignment.** These are the firm-shaped features and they are **out of scope**.
- **The reader is not an accountant.** Terms like "journal entry", "trial
  balance" and "input VAT" may appear in reports, but no primary workflow may
  *require* understanding them.
- **Onboarding is disproportionately important**, because the buyer is also the
  implementer. There is nobody to configure it for them.

**If this ever changes**, it is a strategy change, not a feature request — the
navigation, permissions and data model implications are large. Firms remain a
plausible later market (the schema would support them); nothing here forecloses
it, and nothing here is built for it.

---

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
