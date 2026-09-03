# CLAUDE.md

Guidance for Claude Code (and any AI agent) working in this repository.

> **This file is the OPERATING context only**: where things stand, what must not
> be broken, the standing checks, the OPEN pre-production queue, and
> conventions. The narrative history — per-milestone as-built records, the
> findings with their incidents and evidence, the queue items that already
> closed — lives in [`docs/history/`](docs/history/) and is linked from here.
>
> 🔴 **BUDGET: 75k characters, enforced by `apps/api/src/tests/claude-md-budget.test.ts`.**
> It was 207k (truncated in every session that loaded it), restructured to 35k,
> and back to 157k within four weeks. Prose asking for restraint has now failed
> twice, so the limit is a failing test instead. The file sits at ~63k, so the
> headroom is deliberate — **and raising the number is not a fix.** When the test
> goes red, something in here has become history; find it with the three rules
> below.
>
> 🔴 **The three eviction rules — this file grows because writing has a trigger
> and deleting has none.** Each rule names the moment a line LEAVES:
>
> 1. **A queue item leaves §5 in the commit that closes it.** Not "later, in a
>    housekeeping pass" — §5 is what is still open, and a closed item's
>    as-built record belongs in `docs/history/`. 54% of §5 was closed work.
>    🔴 **The reusable form: CLOSED ITEMS DON'T STOP BEING WRITTEN.** Closing
>    something is when it is best understood, so it attracts the longest entry
>    it will ever have — at the exact moment it stops being operating context.
>    The queue does not grow because work is slow; it grows because finishing
>    is when people write.
> 2. **A §3 lesson is ONE line under one of §3's eight headings, and the
>    incident goes to
>    [`findings-and-lessons.md`](docs/history/findings-and-lessons.md) in the
>    same commit.** 🔴 The test is not LENGTH, it is SELF-SUFFICIENCY: a
>    rule a reader cannot act on without going to read its story is written
>    wrong — rewrite the rule; do not import the story. "One line each" on its
>    own failed twice, because the session that finds something is the session
>    with the most to say about it.
> 3. **§2 states STATUS, never as-built.** A few lines and a link. The moment
>    a milestone's entry explains *how* it was built, it is a history record
>    living in the wrong file — every one of them already had a design doc that
>    §2 both linked to and re-summarised at length.

## 1. Project Overview

This is the **Saudi Ledger Platform** — an AI-powered Accounting & Finance
Operating Platform for Saudi Arabia, and later the wider GCC.

It began life as a single-tenant bookkeeping app and has been refactored into a
multi-tenant SaaS platform. The accounting core is real and correct — invoices,
bills, journal entries, GL posting, period locks, VAT, and Zakat all work today.
When in doubt, favor evolving the existing system over replacing it.


## 2. Current State

**Last updated: 2026-08-31.** Full as-built narrative for everything below:
[`docs/history/milestone-as-built-records.md`](docs/history/milestone-as-built-records.md).

**2026-08-28 → 31 — six passes, P5, and the navigation tree** (tree as data,
every entry checked; record: [`nav-tree-reconciliation.md`](docs/product/nav-tree-reconciliation.md)).
All merged; their invariants are in §4 and their lessons in §3.
**2026-09-01 — L1/L2/L3 named** by the first core-path walk (§3 rule 4, §5).
**2026-09-02 — contract milestone CLOSED at a deliberate stop, batches 1–5:**
every money surface in the spec, conformance-tested on real rows (approval
artifact proven, ICV chained; `/approvals/pending` replaces a queue capped at
50). **Ratchet 55 → 20, zero joins. The 20 left are a STOP, not a backlog** —
operator/identity, AI and read-only, no tenant money. Record: findings file.

**Where things stand, in one table.** Status only; the record is the link.

| Area | Status (2026-08-28) | Record |
| --- | --- | --- |
| **Phase 0** — platform foundation (M1–M10) | ✅ Complete | [`phase-0`](docs/history/phase-0-platform-foundation.md) |
| **Phase 1** — onboarding & multi-company (M11) | ✅ Complete | [`phase-1`](docs/history/phase-1-onboarding-m11.md) |
| **Phase 2** — ZATCA / Fatoora (M12) | 🟡 Closed except M12.7 + M12.9 — blocked on a real Saudi taxpayer registration | [`phase-2`](docs/history/phase-2-zatca-m12.md), [`m12-status`](docs/zatca/m12-status.md) |
| **M13–M16** — chart of accounts, ingestion repair, VAT source switch, transfers, bank reconciliation | ✅ Complete | [`design-transaction-accounting`](docs/product/design-transaction-accounting.md) |
| **M17** — Zakat scope + fiscal calendar | 🟡 M17.0–M17.2 built; **M17.3/M17.4 HELD on C10** (the tax content is unverified) | [`design-zakat-module`](docs/product/design-zakat-module.md) |
| **M19.6 / M19.7 → A** — receivables bridge, the GL owns cash | ✅ Complete | [`design-analytics`](docs/product/design-analytics.md) §6.1 |
| **M20** — fiscal periods in reports (F1–F13, F3-dual, F7-cmp) | ✅ Complete | [`design-fiscal-periods`](docs/product/design-fiscal-periods.md) §8 |
| **M21** — quotations & purchase orders (M21.1–M21.3) | ✅ Complete | [`design-quotations-purchase-orders`](docs/product/design-quotations-purchase-orders.md) |
| **M22** — closed months + the global 423 explanation | ✅ Complete | as-built records |
| **M23** — audit-trail reader UI | ✅ Complete | as-built records |
| **AI track** — AI-1 (Groq seam + metering), AI-2 (corpus at measuring size), AI-3a (findings engine), AI-3b (explanations), AI-5 (scheduled findings), AI-6a (grounded answers) | ✅ Built, **dark by construction** (the boot boundary refuses tenant data until Groq Enterprise is signed) | [`design-ai-layer`](docs/product/design-ai-layer.md), [`ai-6-proposal`](docs/product/ai-6-proposal.md) |
| **Automation** | A1 capture ✅, A3 recurring (drafts only) ✅, **A2 bank feeds not started** | [`feature-spec-automation`](docs/product/feature-spec-automation.md) |
| **Demo deployment** | ✅ Codebase demo-ready; **nothing is deployed** | [`demo-deployment-decisions`](docs/product/demo-deployment-decisions.md) |
| **Billing** | 🔴 **Does not exist** (queue R1) | §5 |
| **Security** | F1 + F2 CLOSED; G-1 checked and absent; privilege surface map live; permission grants, cross-company isolation and git history all audited 2026-08-31 | [`hld`](docs/hld.md) §3, findings file |

**Owner-approved audit order, in flight:** operator surface ✅ → accounting-core
services ✅ → **the write paths** (next).

**Live owner actions** (entity → advisor → Groq → receipts):
[`docs/product/owner-actions.md`](docs/product/owner-actions.md) — the single writer for their state; do not restate it here.

🔴 **Three DEPLOYMENT-time items cannot be closed from code:** the real proxy
count for `TRUST_PROXY_HOPS`, a clamd sidecar for `MALWARE_SCANNER`, and B1/B2's
provider wiring (a mail provider, and a webhook pointed somewhere real). An
unwired alarm is the thing B2 exists to prevent.

### 🔴 What is verified LIVE vs only LOCALLY (ZATCA)

Full detail: [`docs/zatca/m12-status.md`](docs/zatca/m12-status.md).

**Confirmed against the live ZATCA sandbox:** the CSR and `secp256k1` curve, the
XAdES properties and both digest encodings, all nine QR tags, six compliance
documents (standard + simplified × invoice / credit note / debit note, plus
zero-rated), and the ledger→ZATCA path built from real Postgres rows.

**🔴 NOT verified — we have never submitted an invoice to ZATCA.** The compliance
pass covers document **CONSTRUCTION** (`POST /compliance/invoices`, an
onboarding gate). The production path —
`POST /invoices/{clearance,reporting}/single` — has **never been called in any
environment**. Also local-only: the outbox transport (proven against a mock),
the archive (`local-fs` only), renewal reminders (synthetic dates), and the
enqueue path (self-signed certificate, not a real PCSID).

### What is blocked, and on what

A **registered Saudi company entity with an active ZATCA VAT registration and
ERAD credentials** does not exist. It is not a technical step; nothing unblocks
it except the owner registering the entity. It gates **two workstreams**:

- **ZATCA M12.7 (simulation) + M12.9 (production pilot).** No rework expected
  when it arrives — sandbox exercises the same API surface. **Do not** mock
  simulation to "finish" M12, and **do not** onboard a real tenant before both
  have run.
- **A2 bank connectivity** — signing with a SAMA-licensed open-banking provider
  almost certainly requires a Saudi CR. Conversations stay useful without the
  entity; **signatures do not**.

### THERE ARE NO CUSTOMERS YET (owner-confirmed 2026-08-12)

Schema changes, breaking API changes, renames and reversals are **cheap right
now** — no migration burden, no one to notify. That does **not** excuse
correctness in what is hard to retrofit (tenant isolation, the ZATCA chain,
audit trails, append-only guarantees, fail-closed posture) — those are cheap
now precisely because nobody depends on them, which is the argument for getting
them right now. **Revisit when the first tenant onboards.**


## 3. Standing rules, the standing check, and the named lessons

Full incidents and evidence: [`docs/history/findings-and-lessons.md`](docs/history/findings-and-lessons.md).
These are short forms; the rules are binding, the history explains why.

### The standing rules

1. **Correct is not connected.** Before recording a milestone done, verify
   every capability has a production **caller**, every field a production
   **writer**, every client a real **implementation** (not an interface plus a
   mock), and every live external result is recorded with **the endpoint that
   produced it and what that endpoint attests**. (Six live instances + seven
   retroactive.)
2. **Validate from real ledger rows.** Fixtures test the code you wrote; only
   real rows test the code you forgot to write. Every integration milestone
   needs at least one test that submits data read back out of Postgres,
   produced by the product's own write path.
3. **Re-run the LIVE VERIFICATION PASS at the end of every milestone touching
   the ingestion/tax path** (owner-mandated for all of M16; keep it beyond).
   Same fixture, live path (real HTTP → engine → Postgres), OBSERVED values —
   not test results. (M15 proved why; the incident is in the findings file.)
4. **🔴 PERIODICALLY WALK THE CORE USER PATH END TO END — a path finds what a
   list cannot** (owner-mandated 2026-09-01). Sign up → invoice → send →
   payment → cash position → VAT return, in Arabic, on mobile. The queue is a
   LIST, and a reader cannot detect an absence in one: the first walk found
   L1, L2 and L3 — nothing broken, things MISSING — which no audit or suite
   could see. Walk after any milestone touching the path, and before any
   launch conversation. Record: findings file.

### 🔴 THE TRIAGE CHECK (apply to every finding, before ranking it)

**Severity is per FINDING; consequence is per PATH.** Ask these three of every
finding, and rank on the worst path a user can walk rather than the worst
finding in the list:

1. **What ISSUES or POSTS on this path?** (auto-approve, a posting path, a
   transmission) — it turns a bad record into a **permanent** one.
2. **What removes the CORRECTION?** (no edit, no delete, an append-only store,
   a closed period) — it turns a permanent record into an **uncorrectable** one.
3. **What hides the RESULT?** (a silent catch, an unread field, a page that
   renders zero, a 2xx after a rollback) — it turns an uncorrectable record
   into an **unnoticed** one.

🔴 **4. AFTER CLOSING AN ITEM, ASK WHAT IT CHANGED THE MEANING OF.** A fix does
not only remove its own finding — it edits the queue. Nothing in this process
re-examines the remaining items after one lands, so a finding can quietly become
worse, become moot, or change character while its row still reads as it did when
written. Observed twice in one session: removing auto-approve **closed** the
solo-approver finding outright, and the unscoped-`db` fix **changed what
`getApplication` was** — filed as a retention/PDPL question, revealed also to be
an RLS bypass. This is the composition class pointed at FIXES rather than
defects, and it is the step most easily skipped because the fix feels finished.

A finding touching none of these is about as bad as it looks. **One touching two
is worse than its severity says, and the difference is not visible from the
finding alone** — which is the whole reason this check exists separately from
severity. AUD-13 is the worked example: five items, each correctly triaged
alone, that together minted a permanent zero-value ZATCA invoice.

### The standing check (apply before recording any milestone as done)

1. Every capability has a production **caller**, and the caller chain
   **terminates at a real entry point** — grep the symbol, discard tests and
   comments, then keep following it up. 🔴 **Name the terminus:** a UI surface
   in `apps/web`, an operator surface, or a job `start()` actually schedules.
   Stopping at the HTTP boundary is why this check said *yes* for A1's capture
   pipeline and A3's recurring rules while neither was reachable from the
   product — a route file is a caller, and an endpoint nobody calls is the
   same disease one layer up. Mechanized for routes by
   `tests/route-reachability.test.ts` (which also carries the known-gap list);
   the guard covers only that one class, so parts 2–6 stay human.
2. Every field it depends on has a production **writer** (grep for writes, not
   references — a column only a migration back-fills is unbuilt).
3. Every client it depends on has a **real implementation** — if the only thing
   satisfying an interface lives in a test file, say so in the record.
4. Every **live external result** is recorded with the endpoint that produced
   it and what that endpoint attests — a pass on a validation endpoint does not
   cover the production path.
5. **Run the check on your own conclusions.** A claim of absence must carry its
   **search shape**: state what you searched for (the implementation shapes the
   capability could take) and what would have falsified the claim, so the
   search is reviewable, not only the conclusion. *(Two instances of getting
   this wrong: finding #7's OCR, M16.2's `bank_accounts` — both confidently
   reported, both acted on.)*
6. When a milestone **implements or moves** something, grep for tests asserting
   it is absent/unimplemented/throwing (`NotImplementedError`, `.rejects`,
   `toThrow`, `toBeNull`, `not.toContain`) and re-read each hit — an assertion
   of absence expires the day the thing is built.

### Named failure modes — the INDEX

🔴 **ONE LINE EACH, AND THE LINE MUST BE USABLE WITHOUT ITS INCIDENT.** The
incident, the evidence and the countermeasure live in
[`findings-and-lessons.md`](docs/history/findings-and-lessons.md), which holds
the long form of every rule below. **A rule you cannot act on without going to
read the story is written WRONG** — rewrite the rule; do not import the story.
The headings say *when* a rule applies, so a rule is findable while you are
doing the thing it governs rather than only once you know its name.

#### Built, or only shaped like it

- **A shape without a consumer** — a column/table/interface/flag looks exactly like progress and ships unbuilt. Grep for the consumer; the standing check above is the countermeasure.
- **A CONSUMER with no producer is worse** — a missing consumer yields a dead column nobody sees; a missing producer yields **a confident zero, which reads as an answer**. Check writers as well as readers, and treat "nothing writes it" as a claim needing part 5's search shape.
- **A stub is the part that needed testing** — test the branch you did NOT write, by injecting a failing implementation. A method that cannot do the thing must THROW: a no-op reporting success is a false statement the caller builds on. Audit every `resolve*Store` / `get*Provider` seam.
- **A flag's scope drifts past its name** when the thing it gates becomes shared infrastructure — move the gate WITH the thing the flag names.
- **🔴 ASSUME ANY COMPLETED BACKEND IS UNREACHABLE UNTIL SOMEONE HAS CLICKED IT** — a correct backend with no working surface is outside what any service test can see, and six read-only audits missed four defects one browser pass found in seconds. P5 (`apps/web/e2e`) is the countermeasure.
- **A hand-written `apiFetch<T>` interface is a claim nobody checks** — TypeScript checks it against the COMPONENT, never the response. Prefer the generated client, and treat a page as working only once it has been RENDERED.
- **GENERATED TYPES CANNOT CATCH WHAT WAS NEVER GENERATED** — `tests/hand-written-interface-ratchet.test.ts` stops new pairings; §5's contract entry burns the pinned ones down.
- **NO TEST EXERCISES THE CLIENT'S REQUEST CONSTRUCTION** — every test builds its request the way the SERVER expects, so a client that builds one differently is invisible by construction. Only something driving the real client can see it.

#### The check that does not check

- **An obsolete assertion** — a correct-when-written absence assertion stays green while certifying the defect it now guards. Prefer presence assertions; when you build something, grep for tests asserting it is absent.
- **The narrower-claim family** — a suite's or page's NAME describes a capability while its fixtures prove something narrower. Read the name as a claim and check the fixtures supply it.
- **🔴 A NARROWER VERIFICATION REPORTED AS A BROADER ONE** — the vacuous-green family aimed at the REPORTER rather than the guard ("the tests pass" does not cover "the typecheck passes"). 🔴 **`pnpm run verify` IS the verification step**; a filtered command never stands in for it.
- **Assert the property, not the number** — change one thing, prove the figure does not move, and prove something else DID.
- **🔴 When the CORRECT answer equals the BROKEN one, the test proves nothing** — assert presence AND absence, and that the figure MOVES.
- **A verdict line must carry its evidence count** — "all inputs failed" is a case an instrument must NAME, not score; an unmeasured row reads NOT MEASURED, never zero.
- **A claim inside a measuring instrument is still a claim** — a benchmark's "hard" flags and its headline verdict were both authored, and both were wrong until measured.
- **🔴 A NEGATIVE RESULT FROM AN UNVALIDATED PROBE IS NOT EVIDENCE — IT IS AN UNREAD INSTRUMENT.** When a probe reports an ABSENCE, first prove it can see a known-present case; where it is cheap, **build that case INTO the probe** so the comparison cannot be skipped — *make the wrong thing inexpressible* (below), pointed at investigation. The tell: the instrument disagreed with something already known true.
- **🔴 SMALL FIXTURES DO NOT TEST LESS — THEY TEST DIFFERENTLY.** Invisible at fixture scale: VOLUME (a count off a capped list), COLLISION (an identity of date+amount+description), BREADTH (a branch no seeded row reaches). Breadth is SEEDED and asserted, never hoped for; a suspiciously ROUND count is a diagnosis.
- **🔴 VERIFIED BELOW THE LAYER THAT HAD THE BUG** — ask which layer the defect lives in, and whether anything tests THAT one. A well-formed request passes a valid schema attached to the wrong thing, and every test builds its request the way the server expects.
- **A value that satisfies every check while meaning nothing** — `Number("")` is 0, so `creditLimit: ""` passed the guard, stored, and read back as a limit of 0.00. Check the MEANING, not only the type.
- **A SPEC CONSTRAINT THAT EXISTS AND IS NOT ENFORCED IS WORSE THAN NO CONSTRAINT** — spec and tests then both read as coverage; a declared `minItems` is decorative unless the controller parses the body.
- **🔴 A SPEC ENTRY NOBODY HAS PARSED A RESPONSE AGAINST IS A CLAIM, NOT A CONTRACT — CONFORMANCE CONVERTS IT.** Batch 1 found the PAGES wrong, batch 2 the SPEC — both inside endpoints already counted as covered.
- **A WRONG CONTRACT IS WORSE THAN NO CONTRACT** — it generates CONFIDENT types that are wrong, out of the mechanism meant to prevent exactly that.
- **🔴 A HARDENING STEP IS UNTESTED CODE ADDED AFTER THE TESTS PASSED — RE-RUN THE THING YOU JUST HARDENED.** Twice: the readiness wait meant to stabilise P5 broke it, and a believed-correct `pool.on("error")` fix crashed the next run identically.
- **A STACK'S TIP IS NOT ITS BODY OF WORK** — measure the union of the stack, never `main..tip`, and do not read stack position as chronology.

#### The fix that does not finish

- **🔴 THE REPORT IS A SAMPLE, NOT AN INVENTORY** — fixing a reported instance without sweeping its shape leaves the reachable copies in place, and the reported one is often the least dangerous. Three instances.
- **Green fixes the case, not the class** — when a fix is "add a guard to X", grep for X's siblings before accepting green as done.
- **🔴 A TARGETED FIX SEES ONLY WHAT IT WAS SENT TO FIX — MEASURE.** Working on a file causes none of its other defects to be noticed, so coverage questions are asked PERIODICALLY and MECHANICALLY against the whole surface.
- **🔴 THE FRAME IS PART OF THE COUNT** — a walk produces a SAMPLE; only an inventory produces a COUNT. The same absence counted 1, then 7, then 12 as the frame widened, and **7 was correct inside its frame**, which is subtler than under-counting. State the frame beside the number.
- **🔴 SEPARATE FINDINGS COMPOSE INTO SOMETHING WORSE THAN THEIR SUM — AND THE COMPOSITION IS THE FINDING.** Severity is per finding; consequence is per PATH. Run the triage check above on every finding and rank on the worst path a user can walk.
- **A composition defect is invisible to any review that reads one file at a time — TWO shapes, TWO countermeasures.** *Data flow* (one file writes the fact another trusts; the EDGE is the hole): human — enumerate what a privilege can WRITE, grep every guard that READS it. *Position* (a route on the wrong side of a guard): mechanical — `tests/privilege-surface-map.test.ts`, which 🔴 would NOT have caught F1.
- **🔴 WHEN A MAP REPLACES A MAP, ASSERT BOTH DIRECTIONS** — every entry points at something, and everything is pointed at. Reconciling entry by entry answers one direction only, and cannot see what the new map never listed.

#### Where the rule lives — construction over convention

- **Enforce invariants at the WRITE BOUNDARY, not in one path** — per-path enforcement is per-path review, and a new path starts at zero. Corollaries: header-level arithmetic over line-level truth WILL drift; and a REMOVED default is an invariant too, so every writer supplying a fallback is a write path.
- **🔴 AN INVARIANT ENFORCED ONLY WHEN THE CALLER DECLINES TO OVERRIDE IT IS A CONVENTION WEARING AN INVARIANT'S CLOTHES** — when the rule is "we always call the allocator", the CALLERS are the enforcement. Ask what can reach the same effect without going through it, and prefer a boundary with no override.
- **A guard that tests a fact its own caller can create is not a boundary** — for each fact a guard consults, ask who can WRITE it, and prefer a property an actor cannot cause at all (confinement) over one they can cause with a single INSERT (overlap).
- **🔴 MAKE THE WRONG THING INEXPRESSIBLE, NOT FORBIDDEN** — find the representation in which violating the rule cannot be SAID. Construction outlives review, and only construction binds code not yet written. Aimed at our own habits: the probe rule above, `scripts/anchored-edit.mjs`, this file's budget test.
- **Two id spaces with no forcing function diverge invisibly** until something joins them. Remove the second, or add a test that fails when they drift.
- **🔴 FK checks run OUTSIDE RLS** — every plain FK between tenant-scoped tables is a cross-tenant edge no policy guards, and 23503-vs-success is an existence oracle. Auditing isolation means enumerating the FKs, not only the queries.
- **A verification is a claim about a moment, not a property of the text** — a validated artifact must STORE the identity of what it was checked against and gate on the match, or it ages into a false credential.
- **🔴 ASK OF EVERY SEVERANCE WHAT AN UNHANDLED EVENT ON THE SEVERED THING TAKES WITH IT** — an idle-in-transaction timeout killed the API PROCESS. 🔴 And standard advice applied without checking which case you have is its own trap: `pool.on("error")` covers IDLE clients only. Guard: `tests/severance-amplifier.test.ts`.
- **A retry cannot fix an ordering problem** — if the missing thing has a CREATOR rather than a settling time, waiting is a slower failure. Ask *what creates this, and is it scheduled before me?*
- **A mirror is a hypothesis about the target, not a fact about it** — diff the two tables' columns in `information_schema` before mirroring an entity, rather than reasoning from the shape of the source.

#### Numbers, and what they describe

- **🔴 THE QUESTION IS NEVER "IS THERE A LIMIT" BUT "DOES THE NUMBER SHOWN DESCRIBE THE SET THE USER THINKS IT DESCRIBES"** — capped-where-it-should-be-unbounded and unbounded-where-it-should-be-capped are one disease pointing both ways.
- **🔴 Two correct assertions with a gap between them** — a top-line figure and a bottom-line invariant can both hold while the value sits in the wrong accounts. When an operation moves value BETWEEN accounts, assert both accounts, before and after.
- **🔴 WITHHOLD A NUMBER THAT WOULD MEAN NOTHING** — an entry's debits equal its credits, so a cross-entry money total is twice the turnover or zero depending on the column; journal-entry lists get a COUNT instead. The discipline is hardest exactly where the wrong number would pass unnoticed.
- **Partial data is not lenient data** — salvage the fields that WERE readable; never return part of a value as the whole value ("150.00" truncated to "15").
- **Rendering a value the system cannot compute with advertises support that does not exist** — faithful rendering converts a visible inconsistency into an endorsed one. Refuse it at the WRITE boundary instead.

#### Reading a source, a spec, an instruction

- **Sources rank LIVE API > SDK > PDF > secondary** — and an unread primary source is not a licence to trust a secondary one.
- **🔴 AN OFFICIAL TRANSLATION IS A SECONDARY SOURCE** — where the publisher states the original prevails, they say so because the texts DIFFER. Read the original, or mark the reading reasoned-not-verified in the design rather than letting it read as settled.
- **External validators check the weakest property they plausibly could** — validate meaning locally; never infer correctness from an accepted submission.
- **A definition is not a rule — follow the delegation** — when a spec describes a field without stating its constraint, the constraint lives elsewhere. Go and find it before designing against the definition.
- **A rule spelled out for a SIBLING field and omitted here is evidence of intent, not an oversight to fill in** — find the nearest place the same author DID state it and read the contrast. (Had both fields been silent, the absence would prove much less.)
- **🔴 A QUEUE ENTRY RECORDS WHAT SOMEONE BELIEVED THEN, NOT WHAT IS TRUE NOW — VERIFY THE REASON, NOT ONLY THE ENTRY.** The danger is not that a stated reason is wrong; it is that a wrong reason is ACTIONABLE, so the plausible remedy it suggests gets built and the defect survives it. Measure a performance claim, reproduce a behaviour claim, read the primary text of a regulatory one.
- **🔴 An instruction's referent — and its MECHANISM — is an INPUT; check both against the data, even from the owner.** Take the shape it describes, check the mechanism, and REPORT a mismatch rather than building the plausible thing. Corrections ship narrow; a named gap beats a silent default. 🔴 **A LABEL IS A REFERENT TOO** — when a name comes from a document you cannot read, ask rather than guess.
- **A dependency that accepts your input has not promised to honour it** — small-ICU Node accepts `islamic-umalqura` and returns Gregorian. Probe an EXTERNALLY CHECKABLE FACT at boot; "it didn't throw" is not evidence.
- **Cost an option AFTER verifying its inputs exist** — name the inputs an approach consumes and grep for each before recommending it.
- **🔴 A SPIKE MUST NAME EVERY STAND-IN IT USED, BESIDE ITS VERDICT** — substituting what is nearest to hand for what is not under test is what makes a spike fast and is correct practice. The defect is not the substitution but letting it disappear into a green result, where the answer then looks FINISHED.

#### What the user is shown, and what they consent to

- **Who finds out?** Silence is not a neutral outcome — quiet neglect needs an alarm, not a dashboard.
- **🔴 EXPLAIN A REFUSAL; DO NOT HIDE THE CONTROL** — a hidden control teaches nothing; a refusal naming the next step teaches the workflow. Key the UI on the structured CODE, so rewording copy cannot break it.
- **A server refusal nobody surfaces is indistinguishable from a frozen UI** — surface errors at the mutation cache, not per form (the write-boundary rule applied to error surfacing). An unsurfaced error is also a diagnosis nobody gets, including us.
- **🔴 AN HONEST MESSAGE CAN STILL HIDE A CAPABILITY** — a page disclosed its cap plainly while the server had been returning a real `total` and accepting `offset` all along. Ask not only *is this true* but **does it leave the reader with the best action available to them.**
- **🔴 A DESTRUCTIVE ACT'S SCOPE MUST MATCH WHAT THE USER CAN SEE** — "Accept ready (183)" that accepts 5,000 is an AUTHORITY bug, not a display one. Name the true scope BEFORE the act; a gap between the visible set and the acted-on set is a defect in the ACT.
- **🔴 A CREATE FORM THAT OMITS A REQUIRED FIELD PRODUCES INERT RECORDS** — every control works, every request succeeds, and **no reachability guard can see it** because nothing is unreachable. The tell: a field the WRITE path treats as optional and a READ path treats as required.
- **🔴 AN EMPTY BLOCK PRINTS ITS EMPTINESS** — an optional block defaults OFF and turns itself on when it has content. A stand-in that looks designed is worse than an absence that looks like an absence.
- **🔴 A NAVIGATION CAN LOSE THE SCOPE THE USER CHOSE, AND EVERY STATIC CHECK STAYS GREEN** — source and destination are each correct alone, so nothing errors and no figure is wrong; the destination just never reads the parameter and answers a broader question. Only FOLLOWING the link and reading what it shows catches it.
- **An act about a document is not an act about a pattern** — consent to a rule in January is not consent to what it produces in November. (Why A3 is drafts-only.)
- **A name says who processed a movement, not what it was** — a keyword rule keyed on an ENTITY instead of an ACTION misclassifies everything that entity touches. Actor or action?

#### Two standing don'ts, each checked twice

- **🔴 Do NOT move `LanguageProvider` inside `AuthGuard`** — it wraps `AuthProvider` by design, `AuthGuard` cannot unmount its own ancestor, and `ksa_lang` survives logout. Two proposed B-8 mechanisms died here.
- **🔴 A VALUE REACT DOES NOT OWN CAN BE SILENTLY REVERTED BY SOMETHING INSIDE ITS TREE** (B-8) — a fact produced outside a system's ownership needs re-assertion or observation, never a single write. Guarded by `e2e/rtl-direction.spec.ts`, which CLICKS: a `goto` repairs the loss before it can be seen.

## 4. Active constraints — do not break these

### Architecture

- **Route → Controller → Service → Repository.** HTTP in routes/controllers,
  logic in services, every query in a tenant-scoped repository. The accounting
  core (`services/accounting/` — glPosting, periodLock, zatca — and
  `services/categorization/`) is the sanctioned exception with direct `db`
  access. See [`docs/development-guide.md`](docs/development-guide.md).
- **Everything is tenant-scoped.** Every business table carries
  `organization_id` (NOT NULL, RLS `tenant_isolation` policy off the
  `app.current_org_id` GUC); every query filters by tenant. RLS is enforced at
  runtime via per-request transactions on a non-owner role.
- **🔴 `organizations`, `users`, `organization_memberships` are OUTSIDE RLS.**
  Business-layer code (`services/`, `repositories/`) must not read them — a
  forgotten filter there is a silent cross-tenant leak nothing catches. The
  identity layer (pre-`resolveTenant`, owner connection, explicit authz) is the
  only correct consumer. Enforced by `tests/identity-table-boundary.test.ts`
  (import-matching only — raw SQL slips past). If the business layer genuinely
  needs them, that is a design decision, not a lint exception.
- **OpenAPI-first with codegen.** `packages/api-spec/openapi.yaml` is the
  contract: change the spec, run
  `pnpm --filter @workspace/api-spec run codegen`, then implement. Never
  hand-edit `src/generated/**`. **Exception:**
  `packages/api-client-react/src/custom-fetch.ts` is HAND-MAINTAINED (orval's
  mutator — cookie credentials + the `setApiErrorHandler` verification-gate
  hook); commit changes to it deliberately.
- **A privilege that becomes self-grantable invalidates every guard that trusts
  it** (the M11.5.1 CRITICAL). When a change makes a role/flag/capability
  obtainable by a less-trusted party, re-audit every guard that trusts it.
  `users.role` is vestigial and must never gate access — the
  `organization_memberships` role governs. Prefer explicit, scoped authz
  (`requirePermission`, admin-of-THIS-org, `requirePlatformOperator`) over any
  ambient global role.
- **🔴 `db` REFUSES a query outside a tenant transaction** — it used to fall back SILENTLY to the owner connection (RLS bypassed, no error). A deliberately cross-tenant caller imports **`ownerDb`** and says so. 🔴 **Never re-add a fallback here.** (The conversion found a live unscoped read; incident: findings file.)
- **🔴 APPROVAL IS AN ACT ABOUT A DOCUMENT, NEVER A PROPERTY OF THE CALLER** — auto-approve made issuing a legal document a consequence of *who created it*, and was removed entirely (§4). A one-call path that mints an ICV is not a convenience; it is the leg that made AUD-13 unrecoverable.
- **🔴 PASSWORDS GO THROUGH `lib/password.ts` — ONE SEAM.** `crypto.scrypt` (N=2^17, off the event loop) for new hashes; bcrypt kept ONLY to verify pre-2026-09-02 hashes, with transparent rehash on the next correct login. Never call a KDF directly, and never store a hash another way: the seam is where the length bound, the parameters and the migration live.
- **AI proposes; it never posts.** The GL is only written through the
  established posting path; AI/automation output is drafts and suggestions a
  human approves.
- **One writer per effect — no parallel posting paths.** New features route
  money through the existing paths (`invoicesService.pay`, `billsService.pay`,
  the approval engine's `onApprove`), never a second path to the same ledger
  effect.

### Accounting and tax invariants

- **Documents FILE; transactions RECONCILE** (M16 Q0). The VAT return reads
  invoices + bills (S/Z/E/O per line, credit-note-correct, box-structured);
  the transaction-derived figure is a reconciliation view only. Transaction
  `tax_treatment` is reconcile-grade: no VATEX codes, `null` = unknown is
  first-class, VAT extracted only for 'S'. **Most seeded treatment defaults
  are illustrative, not verified** — see the verification-status flag in
  [`docs/product/design-transaction-accounting.md`](docs/product/design-transaction-accounting.md).
- **Amounts are stored POSITIVE; direction lives in `document_type`.** Every
  consumer applies `documentSign()` explicitly. A credit note reverses; a
  **debit note does NOT** (it posts like an invoice).
- **`kind: transfer` / `kind: settlement` rows are excluded from income,
  expense, VAT, Zakat and budget aggregates** (`taxVisible()` in the
  repositories) — the bank balance moved even though nothing was earned or
  spent. **Since A (2026-08-17), transfers DO post to the GL** — cash against
  Transfer clearing (own_account) / External transfers, an equity account
  (external — reasoning recorded on the account in `chartOfAccounts.ts`) /
  Transfers awaiting declaration (undeclared, which blocks the liquidity
  claim like SUSPENSE) — with **no P&L, tax or budget line ever**. Settlements
  still never post: their cash effect belongs to the pay paths.
- **🔴 A journal entry with `status = 'reversed'` is IN the books.** The
  status is a marker that a cancelling mirror exists, not an eraser — filter
  aggregations with `JE_IN_BOOKS` (`posted` + `reversed`), never
  `posted`-only, which double-negates every reversal (found live: ±8,750 on
  the dev org; full record in the findings file).
- **Nothing affects the books before approval.** Drafts/submitted records move
  zero in every report (the zero-movement test standard — replicate it for any
  new approvable entity). Invoice hash/QR/AR are minted only at approval;
  drafts consume no ICV.
- **Period locks are company-scoped** (posting path AND routes). A correction
  to a closed period posts in the current open period — never re-date into a
  closed period, and never silently skip (a blocked run must fail loudly and
  be recorded).
- **🔴 The status palette is reserved for real STATES — never for a rule of
  thumb.** good/warning/serious/critical describe something that IS the case
  (an outbox is stuck, a certificate expired). A heuristic threshold — "quick
  ratio below 1", a solvency ratio, a budget variance — is a **judgment**, and
  colouring it with a status renders it as a verdict the platform cannot
  support. Those get a neutral treatment plus words. Corollary already in force:
  the liquidity observations are typed `"watch"` and nothing else, so no UI
  *can* render a compliance failure from a number no standard sets.
- **🔴 No dual-axis charts where the two series have different units.** Money and
  a ratio on one canvas invents a relationship the reader will believe — two
  y-scales can be slid until any two lines appear to track. Different units ⇒
  **separate charts**, small multiples, or index both to a common base. (The
  single most common charting mistake, and the Analytics design walked at it.)
- **Accepting the match IS the review** (M16 principle): one user act both
  accepts a held row and records its effect. A second nested confirmation of
  the same fact is a design defect, not extra safety.

### ZATCA operating rules

- **Trust order: LIVE API > SDK > PDF.** The gate is
  `tests/zatca-compliance-live.test.ts`; a green SDK differential is NOT
  evidence of compliance (it passed byte-for-byte while the live API rejected
  the QR). Divergence log:
  [`docs/zatca/spec-vs-implementation-divergences.md`](docs/zatca/spec-vs-implementation-divergences.md).
- **Sandbox traps:** any OTP is accepted; `requestID` is a constant stub; the
  sandbox PCSID is a shared canned certificate not bound to our key; and **a
  PCSID is issued even when compliance documents FAIL** — assert compliance
  results directly, never infer them from certificate issuance.
- **Issuance FAILS CLOSED for onboarded companies** (deliberate, owner-approved):
  if the document cannot be built/signed, the approval rolls back — a KMS
  outage stops invoicing rather than minting an unreachable invoice and a
  permanent ICV gap. Companies with no active credential are skipped silently
  and issue as before. Revisit diagnosability before a real taxpayer (queue C5).
- **The chain needs two mechanisms:** allocation serialised by
  `lockCompanySequence` (the lock covers the ICV read AND the chain-head read),
  and ordering by **`icv DESC NULLS LAST, id DESC`** — never row id.
  `unique(company_id, icv)` is a backstop that structurally cannot see a fork.
  Out-of-order approvals fork the chain **sequentially** — not purely a
  concurrency bug.
- **Our homegrown hash chain is NOT ZATCA's chain.** `invoices.invoice_hash` /
  `previous_hash` are the homegrown tamper-evidence mechanism; the legally
  meaningful chain lives on `einvoice_documents`. The ZATCA PIH comes from
  `einvoice_documents` only, read inside the sequence lock.
- **`ArchiveStore` has no `delete`, by design** (ZATCA §5.5 forbids deletion) —
  never add one; deletable staging is a separate interface (queue B3). Archive
  filenames use the **GENERATION** timestamp (`invoices.issued_at`), never
  clearance. Cloud storage is permitted; the binding constraint is a direct
  audit link (`ArchiveStore.directLink`).
- **🔴 A MIGRATION THAT TOUCHES `categories` OR `system_account_templates` MUST
  REDEFINE `seed_org_chart_of_accounts()`.** The org-seed trigger copies
  template→category column by column and plpgsql resolves names at EXECUTION
  time, so a dropped column breaks the next signup and an added one seeds NULLs
  — both silent at deploy, both happened. `tests/org-seed-trigger.test.ts`
  compares the two tables' COLUMN SETS; do not weaken it to a list of names.
- **Owner-only tables must REVOKE explicitly.** Supabase's base
  `ALTER DEFAULT PRIVILEGES` re-grants `TRUNCATE`/`REFERENCES`/`TRIGGER` on
  every `CREATE TABLE`, and **TRUNCATE bypasses RLS**. The defaults are
  narrowed (M14) and a throwaway-table guard test pins it; keep the pattern
  for any new table, and verify with `information_schema.role_table_grants`,
  never estimate from the schema.
- **Certificate renewal requires the TENANT's own OTP** — the platform cannot
  renew unattended; lead time is the entire value of the reminders (queue B1).
  (onboard / renewCertificate / buildDocument / submit) — it is one of the two
  mandatory hedges behind the build-direct decision. Do not bypass it.

## 5. Pre-production queue (the single list)

Everything that must close before a real taxpayer is onboarded. Nothing here
blocks ordinary platform work.

🔴 **OPEN ITEMS ONLY.** An item leaves this list in the commit that closes it;
its as-built record goes to
[`known-issues-and-audit-findings.md`](docs/history/known-issues-and-audit-findings.md),
which holds every closed item (A1–A4, B1–B5, C1's code half, C2, C5, C9, C11,
C12, and the 2026-08-20 audit's MED/LOW tables) with its full reasoning.

🔴 **The owner's external plan labels map onto THIS queue** (recorded
2026-09-02 so it is not re-asked; **use the queue's own IDs from here**):
P0-1 = C13 ✅ · P0-2 = M-4 ✅ · P1-1 = L1 · P1-2 = L2 · P1-4 = password
recovery (rank 1 below). Working order is that sequence.

### Blocking, by their own nature

| # | Item | What would close it |
| --- | --- | --- |
| **R1** | 🔴 **REVENUE — the platform cannot take money.** No subscription, no billing, no plan gating exists anywhere; AI usage is metered (`ai_usage`) but nothing turns a tenant into a PAYING tenant. **No billing means no revenue, whatever else works** — the last MECHANICAL requirement between a working product and income. | Undesigned: provider (Stripe-class vs Saudi PSP), plan shape, what gating a plan implies. For customer #1 an off-platform invoice suffices; it stops sufficing quickly. |
| **ZATCA M12.7 + M12.9** | Blocked on a **registered Saudi company entity with an active ZATCA VAT registration and ERAD credentials**, which does not exist. Not a technical step. | The owner registering the entity. No rework expected — sandbox exercises the same API surface. **Do not** mock simulation to "finish" M12, and **do not** onboard a real tenant before both have run. |
| **A2 bank feeds** | Same blocker: signing with a SAMA-licensed open-banking provider almost certainly requires a Saudi CR. | Conversations stay useful without the entity; **signatures do not.** |
| **L1** | 🔴 **THE INVOICE CANNOT LEAVE THE PRODUCT** — no PDF, no print view, no share artifact (launch blocker, 2026-09-01, found by WALKING the core path). **A simplified invoice's QR exists to be PRESENTED to the customer, and no artifact can present it.** 🔴 **Design AGREED 2026-09-02, not built** — [`design-invoice-document.md`](docs/product/design-invoice-document.md) is its single writer; do not restate its decisions here. | Build to that design; "send" follows once B1 is wired. |
| **L2** | 🔴 **NO RESPONSIVE LAYOUT** (launch blocker, same walk). `Layout.tsx` has zero breakpoints; `useIsMobile` is consumed only by the unused vendored sidebar. On a phone the app is a horizontal-scroll desktop page, for a mobile-first customer. | A responsive shell. The nav being data makes the shell swap cheaper. |
| **L3** | **VERIFICATION-GATE SLA — an owner-process question no code closes.** Signup lands in `pending_review`; the gate 403s business routes until an operator approves, so "sign up and start" is "sign up and wait for us". Deliberate KYC — but the WAIT is undefined. | Owner decides the target turnaround, who staffs it, and what the pending screen promises. |


### Deployment-time — cannot be closed from code

| # | Item |
| --- | --- |
| **B1/B2 wiring** | Pick a mail provider + verify a sending domain (`MAIL_PROVIDER`/`MAIL_API_KEY`/`MAIL_FROM`); point `ALERT_WEBHOOK_URL` at a real destination and confirm one test page arrives. The code is done; an unwired alarm is the thing B2 exists to prevent. |
| **C1 (remaining half)** | Confirm exactly `TRUST_PROXY_HOPS` proxies actually rewrite `X-Forwarded-For` in the real deployment. A wrong number is a spoofable limiter in either direction. |
| **C3** | **KMS deployment verification** — IAM/key policy, 30-day deletion window, break-glass-only `kms:ScheduleKeyDeletion`, CloudTrail alarm on deletion attempts, multi-region CMK replica. If the CMK dies, every tenant must re-onboard. |
| **C4 (remaining half)** | Deploy a clamd sidecar and set `MALWARE_SCANNER=clamd`. M-5's header-only magic-byte sniff closes with it. |
| **C6** | **Residency / hosting, the AI hosting decision — and now a real deployment WEIGHT.** 🔴 L1's renderer is Chromium — the only engine that shapes Arabic correctly — adding **~150 MB** to whatever we deploy: a hosting line, not a footnote. (1) 🔴 Sign the **Groq Enterprise agreement** (Dammam pinning + contractual ZDR) — **BLOCKING before any tenant data reaches Groq**; the free tier routes globally and "development" is not an exception. (2) Confirm an Arabic-capable vision model in Dammam. (3) Platform hosting (region + KMS) unchanged; no hosted Supabase project exists yet. |
| **C6a** | 🔴 **BLOCKING BEFORE THE AI LAYER IS ENABLED — a code change, not a contract.** `findings.schedule.service.ts` calls the AI provider **inside an open tenant transaction**; the 15s idle-in-transaction guardrail fires and kills the connection (and killed the whole process until 2026-08-31). The **e-invoice outbox already solved this**: a synchronous external call cannot live inside the request transaction. Read inside, call outside, write back in a short second transaction. Invisible only because the layer is dark. |

### Advisor package — one conversation, four blocks

Written up in [`docs/product/advisor-questions.md`](docs/product/advisor-questions.md).

| # | Item |
| --- | --- |
| **C7** (Block A) | Retention of INBOUND supplier documents. A1 retains captures to the 6/11-year outbound standard — a conservative default, not a settled reading. 🔴 `retain_until` has a writer and **no reader** — a stored intention, not a policy; whatever duration comes back, an ENFORCER must be built. An answer SHORTER than the outbound standard is **not implementable today** (promoted captures live in a store with no delete): a B3-shaped build. |
| **C8** (Block B) | 🔴 **PDPL — higher priority than C7.** 🔴 **Self-instance 2026-09-02** (a client invoice committed as a layout reference, reversed pre-push). Never scoped; it covers the PLATFORM, not just capture (append-only IPs, archived names/addresses for 6–11 years, no retention policy on `users`/`customers`/`employees`). The irreversible act is already performed by ordinary users: posting a bill promotes a photograph into a store that can never delete it. 🔴 Ask whether inbound third-party captures may be made **erasable-with-audit** without touching the outbound ZATCA §5.5 guarantee — we give both classes the identical no-delete promise today. **Also here:** whether operator readability of a verified tenant's identity documents should EXPIRE. |
| **C10** (Block C) | 🔴 **ZAKAT base computation — M17.3 and M17.4 are HELD on this.** Q1–Q8 decided the MECHANISM; the TAX CONTENT has never been checked against the Zakat Collection Regulations. 🔴 **Ask C1 (the minimum-base rule) FIRST — the only one that changes architecture, not arithmetic:** if the base ties to adjusted net profit, the income statement becomes a computed INPUT with its own adjustments and audit trail. The rest (base composition, the Gregorian divisor and rounding, nisab's corporate role — assumed NO, say so in the UI, and the mixed/foreign-ownership posture) is in `advisor-questions.md`. |
| **C12 leftovers** (Block D) | **D1:** whether ZATCA's *audit practice* questions gaps — the text cannot answer it, and a "yes" means building an explanation for each absent number, not changing the allocator. **D2:** both English texts are unofficial translations with the **Arabic prevailing**, and our reading rests on متسلسل / "sequential". |
| **Invoice dating** | 🔴 The closed-period policy is **REASONED-NOT-VERIFIED** (source: the owner, not an accountant): an invoice must not be dated into a closed period at all; work done in a closed month is issued in the current open period, and revenue belonging to the closed month is an accrual made BEFORE closing. Enforced today on create and on a changed `date` (423 `period_closed`). **The open question:** whether Saudi practice permits ANY exception — a grace window, or an audited override. |

### Code-level open findings — RANKED BY CONSEQUENCE, not by discovery

🔴 **Re-ranked 2026-08-28 using the composition question** (§3's newest lesson):
not "how bad is this finding" but "what does it compose with, and does the
result become **irreversible**, **uncorrectable**, or **unnoticed**". AUD-13 is
why: five items, each correctly triaged in isolation, that together minted a
permanent zero-value ZATCA invoice. **Composition risk is stated per row, and it
is the reason the order is not the severity order.**

| Rank | Item | Composes with | Why here |
| --- | --- | --- | --- |
| **1** | **No password recovery for a multi-org account** — DECISION PENDING. F1's confinement means such an account cannot be reset by a tenant admin, and there is no self-service flow. | Nothing that writes. | Not a code question. Three options with costs: [`findings-and-lessons.md`](docs/history/findings-and-lessons.md) (2026-08-30), and on `/coming-soon/password-reset`. Owner decides; the build is days either way. |
| **2** | **`operatorService.getApplication` accepts ANY orgId**, including an approved LIVE tenant, returning CR/VAT and verification documents; the access **never expires**. | **C8 (PDPL)** — a legal question, not a code one. | Audited and operator-only, so not a hole; an unbounded retention surface. Ask the advisor before building an expiry. |
| **3** | **M-5** magic-byte sniff is header-only (closes with C4) · **L-1** security-audit write failures only `console.error` · **L-2** signup 409 leaks account existence (accepted) · **L-4** operator queue list unaudited (accepted). *(M-4 closed.)* | L-1 carries the **unnoticed** multiplier and belongs with rank 3 when that is taken. | The genuine long tail. |

**Open DECISIONS** (flagged so they are decided, not defaulted):
`platform-alarms` is NOT operator-runnable (a one-line flip); `normalizeDigits`
exists twice, pinned by an equivalence test, pending a shared package.

**B-8 — NOT REPRODUCED, under a standing guard** (`e2e/rtl-direction.spec.ts`):
routes walked **by clicking** (a `goto` repairs the loss before it is seen);
`dir`/`lang` hold. *Tested* rather than unreproduced. Detail: findings file.

🔴 **Direction is set BEFORE FIRST PAINT** (owner, 2026-08-31): a
render-blocking script in `index.html` sets `dir`/`lang` — React runs after the
paint. **Do not delete it as an oddity**; a test fails on its removal.

🔴 **P4's `KNOWN_GAPS` and `KNOWN_GAP_TRANSITIONS` are both EMPTY.** A new entry
needs a checkable reason and leaves the day it is fixed.

### Arabic coverage

Arabic is a **launch requirement**, and coverage is MEASURED, never noticed
(the idiom-count sweep). Last measured 2026-09-01: suspect count 0. Re-run
before launch. Record: findings file.
### Traps and known-dead surfaces

- **S6/S7:** `feature_flags`, `branches`, `departments` have **no consumer** — build one or drop them.

- VAT-return **box 4 (exports) is always 0** — an export is a 'Z' line in box 2.
- Manual transaction create has no `kind`/`taxTreatment`, so every manual VAT-bearing entry is a null-treatment row with user-asserted VAT.
- Sub-cent amounts via the raw API can mark a document paid with a 1-halala GL residual (UI-unreachable; round `paid` at the validation gate).
- Settlement links are readable from the transaction side only (the design said "either side").
- The income-statement **transactions-fallback** (zero journal lines) reports gross incl. VAT.
- The Categories UI cannot mark system accounts (`isSystem` not in the API; no edit routes exist).
- **Deferred:** action-level permissions (post-to-GL / pay / approve gateable separately).
- 🔴 **Re-check the hosted project's default privileges when it exists** — they may differ from the local Supabase CLI stack where the grants were measured.

### What the audits could NOT see (so it is not mistaken for a clean bill)

Closed, each under a standing guard: RLS policy coverage, permission-matrix
seed grants, git-history secret scanning. Records: findings file.

🔴 **SAME-ORG CROSS-COMPANY ISOLATION — audited: NOT enforced; OPEN as a
decision** (`tests/cross-company-isolation.test.ts`). No RLS policy reads
`app.current_company_id`, and 15 company-scoped repositories never mention
company (`reports`, `analytics` among them): a two-company org's trial balance,
GL and VAT return ADD BOTH SETS OF BOOKS. Scoping every policy would break
legitimate org-level reads, so it is a DECISION with an owner; the
company-blind list is pinned and can only shrink. Detail: findings file.

Still unaudited: **runtime-order test vacuity** (only execution reveals it).
🔴 **CONTRACT COVERAGE — CLOSED 2026-09-02 AT A DELIBERATE STOP (55 → 20).**
Every MONEY surface is in `openapi.yaml` under a conformance test that parses
real responses; `tests/hand-written-interface-ratchet.test.ts` keeps the
generator closed. Standing rules:
- 🔴 **A leave and a join in one milestone is the generator running — stop, do
  not net**, and **a `type` alias that satisfies the detector is the ratchet
  GAMED**: a file leaves by consuming the generated type, never by rephrasing.
- 🔴 **The 20 pinned files are a STOP, not a backlog** (owner, 2026-09-02):
  operator/identity, AI and read-only surfaces carrying no tenant money.
  Burning them down would make the COUNT the goal. **Do not read 20 as
  unfinished.** Inventory and the batch records: findings file.
- TanStack is unblocked now the money surfaces are typed.
## 6. Tech Stack

| Layer         | Technology                                                               |
| ------------- | ------------------------------------------------------------------------ |
| Monorepo      | pnpm workspaces (`apps/*`, `packages/*`, `scripts`)                      |
| Backend       | Express 5, TypeScript, Node.js (ESM), esbuild bundle                     |
| Frontend      | React 19, Vite, TypeScript, Tailwind CSS v4, shadcn/ui                   |
| Routing (FE)  | Wouter                                                                   |
| Data fetching | TanStack Query (React Query v5)                                          |
| ORM           | Drizzle ORM                                                              |
| Database      | PostgreSQL (via Supabase — Postgres only, NOT Supabase Auth)             |
| Cache / queue | **None.** No Redis — rate limiting shares a Postgres store across processes (C1, code half landed); background work runs on the in-process scheduler in `apps/api/src/jobs/`. Add an entry here **when it runs**, not when it is decided. |
| Auth          | Express session auth (`express-session` + `connect-pg-simple`, bcryptjs) |
| API contract  | OpenAPI-first (`packages/api-spec/openapi.yaml`) with orval codegen      |
| Validation    | Zod (generated into `@workspace/api-zod`)                                |
| i18n          | Custom `LanguageContext` (Arabic / English, RTL-aware)                   |
| Logging       | pino / pino-http                                                         |

## 7. Repository Layout

```
apps/
  api/               @workspace/api-server — Express 5 backend
    src/
      routes/        thin HTTP (validate → controller); one file per entity
      controllers/   orchestrate + shape responses (no DB)
      services/      business logic; services/accounting/ (glPosting,
                     periodLock, zatca) + services/categorization/ are the
                     accounting core (sanctioned direct-db exception);
                     services/einvoice/ is the ZATCA pipeline;
                     services/approval/ is the generic draft/approval engine
      repositories/  ALL Drizzle access, tenant-scoped via RLS
      jobs/          in-process scheduler (outbox worker, archive sweep,
                     renewal check)
      lib/           infra + auth (auth.ts, rbac.ts, tenant.ts, operator.ts,
                     errors.ts, mailer.ts, storage.ts, saudiIdentifiers.ts)
      app.ts         Express wiring (session, middleware, router)
  web/               @workspace/bookkeeping — React 19 + Vite frontend
packages/
  db/                @workspace/db — Drizzle schema + pg pool (source of truth)
    src/schema/      one file per table
    migrations/      versioned SQL migrations (drizzle-kit generate)
  api-spec/          OpenAPI spec + orval config (codegen)
  api-zod/           generated Zod schemas/types
  api-client-react/  generated React Query client (+ hand-maintained
                     src/custom-fetch.ts — see §4)
  config/            @workspace/config — validated env (loadEnv, fail-fast)
scripts/
docs/                specs, product design docs, docs/zatca/, docs/history/
```

There is deliberately **no `packages/auth`** — auth/RBAC live in
`apps/api/src/lib/` after six milestones of work there; the empty scaffold was
deleted at the M12 close-out. Workspace package names are unchanged; `pnpm
--filter` uses package names, not folder paths.

## 8. Key Architectural Principles

1. **Preserve the accounting core** (`services/accounting/`): balanced
   double-entry, closed-period enforcement, and tax rules are correct and
   tested. Extend and wrap; do not reinvent.
2. **Everything is tenant-scoped** (§4).
3. **Route → Controller → Service → Repository** for all new code (§4).
4. **OpenAPI-first with codegen** (§4).
5. **A self-grantable privilege invalidates every guard that trusts it** (§4).
6. **AI proposes; it never posts** (§4).

## 9. What NOT to Do

- **Do not** rewrite working accounting logic (GL posting, period locks,
  VAT/Zakat). Build on it.
- **Do not** use Supabase Auth. Supabase is Postgres only; auth stays Express
  sessions.
- **Do not** skip tenant scoping — no business table without `organization_id`,
  no query without an organization filter.
- **Do not** put business logic in route handlers.
- **Do not** bypass the OpenAPI → codegen flow or hand-edit
  `packages/*/src/generated/**`.
- **Do not** let AI or automation write to the ledger directly — and never add
  a second posting path for an effect that already has one.
- **Do not** auto-apply matches or auto-issue from rules, however exact the
  match — suggestions are pre-selected, the human clicks.
- **Do not** read `organizations`/`users`/`organization_memberships` from the
  business layer (§4).
- **Do not** add a `delete` to `ArchiveStore`, and do not weaken the owner-only
  table REVOKE pattern.

## 10. Reference Docs

Operating references:

- 🔴 [`docs/hld.md`](docs/hld.md) — **the High-Level Design: the one document
  that presents this system to someone who has never seen it** (technical
  diligence, a prospective partner, a joining developer). Product, architecture,
  the tenancy/security model incl. the operator boundary and the two composition
  shapes, the data model, ZATCA, the AI layer, provider seams, and the
  deployment posture stated honestly (nothing is deployed). It describes what
  EXISTS and marks planned things as planned; it dates its claims and points
  here for "now" rather than restating status.

- `README.md` — overview and quick start; `docs/local-setup.md` — run locally.
- [`docs/development-guide.md`](docs/development-guide.md) — layering,
  tenancy/RLS, RBAC, audit, "add a new domain" cookbook. Read before backend
  work.
- [`docs/product/owner-actions.md`](docs/product/owner-actions.md) — the four
  owner actions as a LIVE, tickable checklist (entity → advisor → Groq →
  receipts). It is the writer for their state; the dated state-of-the-platform
  snapshot is frozen history and defers to it.
- `CONTRIBUTING.md` — branch strategy, commit conventions, PR checklist.
- [`docs/architecture-blueprint.md`](docs/architecture-blueprint.md) — target
  architecture.
- [`docs/test-suite-notes.md`](docs/test-suite-notes.md) — 🔴 test-suite
  order/timing fragilities. The diagnostic: *passes alone, fails in the full
  run* = shared state, not a regression. Do NOT fix with
  `fileParallelism: false` or by raising rate limits.
- [`docs/product/design-analytics.md`](docs/product/design-analytics.md) — Analytics
  (round 3): cash + solvency trends, "cash collected" never "revenue", and the
  rule that keeps AI parked (state WHERE a change came from, never WHY).
- [`docs/product/design-pass-inherited-decisions.md`](docs/product/design-pass-inherited-decisions.md)
  — 🔴 what the UI redesign INHERITS, with measured costs: the vendored
  `components/ui/**` deliberately not owned, the dead `.dark` block, and numeric
  alignment in RTL. 🔴 **RTL CLOSED 2026-08-31 by a THIRD option** (owner):
  neither owning the components nor deferring, but an override layer keyed on
  the UTILITY (`src/rtl-overrides.css`) — 24 of 39 utilities flipped globally,
  15 positioning ones left to a hand audit because centring is not direction.
  Deleted whole when the redesign lands. Guard: `tests/rtl-override-layer.test.ts`.
  [`docs/product/feature-spec-automation.md`](docs/product/feature-spec-automation.md),
  [`docs/product/design-zakat-module.md`](docs/product/design-zakat-module.md)
  — product decisions in force.
- `docs/zatca/` — README (environments), `m12-status.md` (what is proven,
  where), `spec-vs-implementation-divergences.md` (all 13, with evidence),
  `security-standards-notes.md`, `m12-5-credential-vault-design.md`.

History (the full narrative this file used to carry):

- [`docs/history/milestone-as-built-records.md`](docs/history/milestone-as-built-records.md) — M13–M23, the AI track, and the 2026-08 audits, as built. **This is where §2's narrative went.**
- [`docs/history/phase-0-platform-foundation.md`](docs/history/phase-0-platform-foundation.md) — M1–M10 as built.
- [`docs/history/phase-1-onboarding-m11.md`](docs/history/phase-1-onboarding-m11.md) — M11.1–M11.7 + the M11.5.1 hotfix.
- [`docs/history/phase-2-zatca-m12.md`](docs/history/phase-2-zatca-m12.md) — M12 sub-milestones, decisions, landmines, residency correction, KMS requirements.
- [`docs/history/findings-and-lessons.md`](docs/history/findings-and-lessons.md) — findings #1–#11, S1–S7, and the **long form of every §3 lesson** (the incident, the evidence, the countermeasure, how it was verified).
- [`docs/history/known-issues-and-audit-findings.md`](docs/history/known-issues-and-audit-findings.md) — audit findings, resolved-issue history, and **every CLOSED pre-production queue item** with its as-built record.

## 10b. 🔴 Tooling hazards (learned the hard way)

**The Edit tool can silently write back STALE file content** — an `Edit`
applied against a snapshot taken before a script changed the file REVERTED the
script's change, reported success, and was caught only by a test going red
again (incident: findings file). Mitigations: (1) a file modified by a SCRIPT
this session stays on the scripted path (`categorizer.ts` is); (2) after any
"modified on disk since you last read it" warning, re-verify the earlier change
is still present; (3) prefer a test that fails loudly — this loss is invisible
to reading.

**🔴 `| tail` THROWS AWAY THE EXIT CODE, AND "Tests: N passed" IS NOT THE
VERDICT (2026-08-21).** A run reported here as "905 passed" was not green — the
line directly above said **`Test Files 1 failed`**: a teardown (`afterAll`) had
thrown, which vitest reports at FILE level while every individual test still
counts as passed. Two mechanisms, both worth fixing in the habit:
1. **`npx vitest run 2>&1 | tail -6` exits with `tail`'s status, not vitest's.**
   Use `${PIPESTATUS[0]}`, or don't pipe the command whose status you need.
2. **Read `Test Files` and the EXIT CODE, never `Tests`.** A hook failure, an
   import error and an unhandled rejection all fail the FILE without failing a
   test.
🔴 Earned again 2026-08-31: an injected fault reported "Tests 2 passed" with
exit 1. **When a tool reports several numbers, find out which one is the verdict
before trusting any of them.**
append to **every line in the file**, and reported success. Same shape as
`rm -rf "$DIR"/` with `DIR` unset: **a command that cannot distinguish "no
target" from "all targets", and whose default on that ambiguity is maximal
action** — `sed` without an address, a `DELETE` whose `WHERE` built to nothing,
a filter with an empty allowlist. The tell: *what does this do when its input is
empty?* If the answer is "everything", quoting discipline is not the fix.
Incident: findings file.

**The countermeasure — now the STANDING PATTERN for scripted edits to tracked
files: `scripts/anchored-edit.mjs`.** Every edit names an anchor; the anchor must
match **exactly once**; zero matches, two matches, or an empty anchor all abort
having written nothing. It refuses untracked files unless told. The ambiguous
case becomes *inexpressible* rather than merely discouraged — the §3 rule
applied to our own tooling — and "no target" and "all targets" now have
different, loud outcomes, which is the property `sed` lacks.

🔴 **It has earned itself repeatedly** — refusing anchors that matched twice
rather than silently editing the first, and refusing empty anchors. Use it
(`--dry-run` when unsure) for any scripted edit to a tracked file; a heredoc
writing a WHOLE new file is fine, and the editing tools suit one-off changes.

Related, and the reason the pattern is not optional: **§10b's stale-write hazard
means a mixed diet of scripted and tool edits on one file can silently revert
work.** One incident in this session: `git checkout -- <file>` after a
re-injection test reverted to the last COMMIT and took an uncommitted fix with
it. Nothing warned. It was caught only by re-grepping for the symbol that was
supposed to be there. **After any revert, re-verify the changes you meant to
keep are still present** — the same discipline as after a stale-snapshot warning.

## 11. Development Conventions

- **Small milestones**, one concern per PR; squash-merge with
  `type(scope): Mxx — summary` commit style (see git log).
- **Explain before implementing** for non-trivial changes.
- **Test everything** — especially money, GL, tax, tenant isolation. New
  approvable entities replicate the zero-movement test; ingestion/tax
  milestones end with the live verification pass (standing rule 3).
- **Milestone close-out:** run the standing check (§3, all six parts), update
  §2 Current State here (a STATUS line and a link — never the as-built story),
  and put the narrative record in `docs/history/` — not in this file.
- **🔴 The same commit that CLOSES a thing REMOVES it from here.** A closed queue
  item leaves §5; a lesson's incident narrative leaves §3; a milestone's
  as-built account never enters §2. This file grew 35k → 157k in four weeks
  because writing is triggered by an event and deleting is triggered by nothing
  — so deletion now has a trigger too, and
  `tests/claude-md-budget.test.ts` fails when it is ignored. Raising the budget
  is not a way to pass it.
- **🔴 Docs never state current status in their own words — they DATE their
  claims and point at §2 for "now".** Any doc carrying free-standing status
  prose WILL drift (found 2026-08-21 across seven docs; incident in the
  findings file). The rule, applied everywhere:
  a status line is **"Status (YYYY-MM-DD): <claim>. Current state authority:
  CLAUDE.md §2."** — the date makes staleness visible instead of silent, and
  the pointer makes §2 the single writer for "now" (the one-writer-per-effect
  rule, applied to prose). A header must also never lag its own body: a doc
  whose §12 says "built" while its title says "building" is the
  narrower-claim shape in miniature.
  🔴 **Corollary — a DATED artifact and a LIVE one are different documents,
  and the live one must never defer to the dated one** (owner, 2026-08-26).
  A snapshot is frozen by design; a checklist is ticked. Folding the second
  into the first makes the checklist inherit an "as of" date it does not
  deserve. Split them; each is the single writer for its own fact.
- **🔴 A DESIGN RATIONALE AGES FASTER THAN A CAVEAT** (owner-named, 2026-08-31).
  On the HLD rewrite, every "this is unproven" line had held; what had rotted
  was every passage arguing **why the design is right** — the HLD's most
  confidently argued section described the opposite of what ships, four days
  after it was written. **A rationale POINTS AT the decision record instead of
  restating the argument**, so revisiting the decision updates one place, not
  two. Incident: findings file.
- **🔴 A READER CANNOT DETECT AN ABSENCE** (owner-named, 2026-08-31) — so a
  document whose job is completeness is CHECKED AGAINST A COVERAGE LIST, never
  written from memory. The old HLD's wrong statements were findable; its
  omissions were not, and G-1's negative result — exactly what a diligence
  reader wants — simply was not there. Maintain the list; generate or check the
  prose against it. Incident: findings file.
- **pnpm only** (a preinstall guard rejects npm/yarn).
- 🔴 **Run `pnpm run verify` before reporting work done** — typecheck, every suite, build, in CI's order. A filtered command answers a NARROWER question; never report it as the broader one.

### Common commands

```bash
pnpm install                                         # install all workspaces
pnpm --filter @workspace/api-server run dev          # run the API server
pnpm --filter @workspace/bookkeeping run dev         # run the frontend
pnpm --filter @workspace/db run generate             # generate a versioned SQL migration
pnpm --filter @workspace/db run migrate              # apply pending migrations
pnpm --filter @workspace/db run seed                 # idempotently seed the default org + company
pnpm --filter @workspace/db run test                 # DB tests incl. RLS isolation (needs DATABASE_URL)
pnpm --filter @workspace/api-spec run codegen        # regenerate API client + Zod
pnpm --filter @workspace/api-server run test         # backend tests (Vitest)
pnpm run typecheck                                   # typecheck the whole repo
pnpm run verify                                      # 🔴 THE GATE — typecheck + every suite + build, CI's order
pnpm --filter @workspace/bookkeeping run test:e2e     # the browser suite (separate: needs servers + a DB)
```
