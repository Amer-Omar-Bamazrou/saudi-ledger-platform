# Owner actions — the standing checklist

**This file is LIVE, and it is the single writer for where the four owner
actions stand.** Tick an item here when it moves; do not restate an action's
state anywhere else. It has no "as of" date because it is never history — a
dated status line here would be the drift it exists to prevent.

Two boundaries, so nothing is authored twice:

- **Platform state** is [CLAUDE.md §2](../../CLAUDE.md)'s to write. This file
  points at it and never restates it.
- **Owner-action state** is this file's to write. §2 points here.
- [`state-of-the-platform-2026-08-24.md`](state-of-the-platform-2026-08-24.md)
  is a **frozen snapshot** — history, deliberately not updated. Where it and
  this file disagree about an action, **this file is right**.

Each action carries a **Done when** that someone else could check. Ticking is
an observation, not a feeling.

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

## 4. ▢ The receipt corpus

- **Gates:** AI-4 — vision inside the A1 capture pipeline.
- **Done when:** real receipt images are in the vision harness and the §2a
  Arabic gate prints a **verdict carrying the evidence count it rests on** —
  never "NOT RUN", and never a verdict over failed calls.

---

**Proceeding in parallel, needing nobody's permission:** the deployment-time
items in [CLAUDE.md §5](../../CLAUDE.md). They are engineering, not decisions,
and they fit entirely inside action 1's shadow.
