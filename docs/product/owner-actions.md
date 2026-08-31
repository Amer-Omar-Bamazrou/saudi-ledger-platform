# Owner actions — the standing checklist

**This file is LIVE, and it is the single writer for where the owner actions
stand.** Tick an item here when it moves; do not restate an action's state
anywhere else. It has no "as of" date because it is never history — a dated
status line here would be the drift it exists to prevent.

🔴 **The list is deliberately NOT a count** (2026-08-31). It was "the four owner
actions" until a fifth arrived, and a count in a title ages the moment the list
does — the same reason `advisor-questions.md` says its title is not a count.
Actions are appended as they arise.

Two boundaries, so nothing is authored twice:

- **Platform state** is [CLAUDE.md §2](../../CLAUDE.md)'s to write. This file
  points at it and never restates it.
- **Owner-action state** is this file's to write. §2 points here.
- [`state-of-the-platform-2026-08-24.md`](state-of-the-platform-2026-08-24.md)
  is a **frozen snapshot** — history, deliberately not updated. Where it and
  this file disagree about an action, **this file is right**.

Each action carries a **Done when** that someone else could check. Ticking is
an observation, not a feeling.

🔴 **They are NOT known to be independent, and this file used to imply they
were** (noted 2026-08-31). A flat checklist reads as parallel work, so a
dependency between two items is invisible unless it is written down. One is
suspected today: **action 3 (Groq Enterprise) is likely gated by action 1 (the
entity)**, because an enterprise contract needs a legal counterparty — see the
entry under action 3. When an action's earliest start depends on another, say so
**in that action**, and never let the ordering live only in the reader's head.

---

## 1. ▢ The entity — CR + VAT registration + ERAD

**The long pole. Everything below fits inside its shadow**, and no code
shortens it; only the owner can start it.

- **Gates:** ZATCA M12.7 (simulation) and M12.9 (production pilot) — the one
  unproven leg of the core product; A2 open-banking signatures (a SAMA-licensed
  provider will almost certainly require a Saudi CR); therefore customer #1.
- **Done when:** an active ZATCA VAT registration exists and ERAD credentials
  have obtained a **production PCSID bound to our own key** — not the sandbox's
  shared canned certificate.
- **Hold:** do not mock simulation to "finish" M12, and do not onboard a real
  tenant before both M12.7 and M12.9 have run.

## 2. ▢ The advisor conversation — one conversation, four blocks

[`advisor-questions.md`](advisor-questions.md) Blocks A–D, plus the
closed-month exception question (whether Saudi practice permits any grace
window or audited override on backdating into a closed period).

- **Gates:** C10 — the Zakat tax content, on which **M17.3 and M17.4 are
  held**; C7/C8 — inbound-capture retention and PDPL; the training-on-tenant-
  data question; downstream, the AI (b)-citation widening and the opinion
  register.
- **Ask C10's minimum-base question first** — it is the only one that changes
  architecture rather than arithmetic.
- **Done when:** every block has a written answer, attributed and dated, and
  each answer is transcribed into the document it gates — not left in the
  advisor's reply.
- 🔴 **Why this one has a clock:** ordinary users already promote phone
  photographs into a store that by interface design cannot delete. Every day
  this stays unanswered, more third-party personal data becomes undeletable by
  construction. **This is the risk not to carry past customer #1.**

## 3. ▢ The Groq Enterprise agreement — Dammam + contractual ZDR

- **Gates:** flipping AI-3b (verified explanations) and AI-6a (grounded
  answers) from dark to tenant-facing, and the categorizer's below-0.65 second
  opinion. All three are built and tested today.
- **Done when:** the agreement is signed **and** `GROQ_DATA_BOUNDARY_ACK` is
  set in production. The flip is config, not code, by design.
- **Standing rule until then:** the free tier routes globally with no Dammam
  pinning. It may carry synthetic and dev-org data only. **No real tenant's
  ledger, receipts, or documents** — "development" is not an exception.
- **Not on the path to first revenue.** AI is the moat, not the wedge.
- 🔴 **LIKELY GATED BY ACTION 1 — this action is probably NOT independent
  (raised 2026-08-31).** An *Enterprise* agreement is a commercial contract, and
  a contract needs a legal counterparty. If Groq requires a registered entity to
  sign, then **action 3 cannot start until action 1 lands**, and this checklist
  has been presenting the two as parallel.
  - **Why it matters more than it reads:** "not on the path to first revenue"
    invites deferring this indefinitely, on the assumption it can be picked up
    any time. If it is entity-gated, its true earliest start is action 1's
    completion — so the AI track's real lead time is *longer* than this file
    implies, not shorter, and the deferral is not free.
  - 🔴 **Not yet confirmed — this is a stated risk, not a finding.** Falsifier:
    Groq accepting an individual or a non-Saudi entity as counterparty.
  - **Recommended action, cheap and now: ask Groq sales what counterparty they
    require, before action 1 completes.** The answer costs one email and changes
    the sequencing of an entire track. Ask it early precisely *because* the
    dependency is unconfirmed — discovering it at signature time is the
    expensive version.
  - Tick the confirmation here when the answer arrives, and correct this entry
    to a dependency or delete it.

## 4. ▢ The receipt corpus

- **Gates:** AI-4 — vision inside the A1 capture pipeline.
- **Done when:** real receipt images are in the vision harness and the §2a
  Arabic gate prints a **verdict carrying the evidence count it rests on** —
  never "NOT RUN", and never a verdict over failed calls.

---

## 5. ▢ 🔴 RTL — DECIDE, do not inherit (opened 2026-08-31)

**This is a decision, not an errand, and it is currently making itself.**

**The situation.** Arabic is a launch requirement (CLAUDE.md §2). RTL is
incomplete: **120 un-converted physical properties across 25 vendored
`components/ui` files**, 53 of them in four files — the sidebar, dropdowns,
context menus and menubar align and open the wrong way in Arabic, `sheet.tsx`
slides in from the physical side, and input icons can overlap text.

Own-or-track (2026-08-27) decided **not to own** those files, which was correct
*as a decision about vendored code* — and it left RTL waiting on the design
pass. So a launch requirement now depends on a discretionary redesign, and if
the redesign slips, Arabic ships broken. **Nothing currently forces that to be
noticed before launch**, which is the shape this project removes everywhere
else: a consequence inherited rather than a decision taken.

**The two options, and what each costs.** Full reasoning:
[`design-pass-inherited-decisions.md`](design-pass-inherited-decisions.md) D-4.

| | **A — the design pass lands before launch** | **B — own RTL separately from the design pass** |
| --- | --- | --- |
| Work now | None | The 120 properties, or an override layer |
| What it costs | A schedule dependency between a launch requirement and discretionary work. The failure is **silent and late** — discovered when Arabic is looked at seriously, which is near launch | Work the redesign may supersede, plus (if owned by forking) a merge conflict against every future `shadcn` upgrade — the exact cost own-or-track declined to pay |
| Fails if | The design pass slips | Nothing. It is bounded work with a known size |
| Reversible? | Yes until launch | Yes — an override layer can be deleted when the redesign lands |

🔴 **B has two shapes with very different costs, and the cheaper one was never
priced.** Forking the components pays the upgrade-conflict cost forever.
An **override layer** — logical-property rules that win over the vendored
physical ones, living in one file — does not touch the vendored files at all, so
`shadcn add` stays cheap and the layer is deleted when the redesign arrives.
That shape was not costed when own-or-track was taken, and it may make B
substantially cheaper than the decision assumed.

- **Gates:** launch, if Arabic is a launch requirement and the design pass slips.
- **Depends on:** nothing. Neither option needs the entity, the advisor, or a
  provider. This is decidable today.
- **Done when:** either (A) the design pass has a date that precedes launch and
  RTL is explicitly in its scope, or (B) an approach for owning RTL separately
  is chosen and queued — and in both cases the choice is written down here, so
  the next session inherits a decision rather than a default.

---

**Proceeding in parallel, needing nobody's permission:** the deployment-time
items in [CLAUDE.md §5](../../CLAUDE.md). They are engineering, not decisions,
and they fit entirely inside action 1's shadow.
