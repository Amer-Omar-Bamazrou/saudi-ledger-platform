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
> 2. **A §3 lesson is ONE line, and the incident goes to
>    [`findings-and-lessons.md`](docs/history/findings-and-lessons.md) in the
>    same commit.** §3 has said "one line each" since the last restructure and
>    grew to 35k anyway, because the session that finds something is the
>    session with the most to say about it. If your entry needs a paragraph to
>    be understood, the paragraph is history and the line is the rule.
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

**Last updated: 2026-08-28.** Full as-built narrative for everything below:
[`docs/history/milestone-as-built-records.md`](docs/history/milestone-as-built-records.md).

**2026-08-28 — the scale/collision sweep, the flow audit, P4, and AUD-13
(merged, PR #102).** Nineteen findings; the full record, every lesson and the
retraction of one false finding are in
[`findings-and-lessons.md`](docs/history/findings-and-lessons.md).

What a future session needs to know in four lines:

- 🔴 **8 of 15 findings sat in the layer a user touches.** Our automated tests
  all run a layer below it. That is the standing gap, and **P5** (§5) is the
  project that closes it.
- **P4** (`tests/state-machine-reachability.test.ts`) now computes what a user
  can REACH from the transition graph; it found three defects on its first run.
- **AUD-13** is the worked example of §3's newest lesson: five separately-minor
  findings composed into a permanent zero-value ZATCA invoice.
- **CLAUDE.md is budget-enforced** (`tests/claude-md-budget.test.ts`). If it
  fails, evict — see the three rules at the top.

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
| **Security** | F1 (cross-tenant account takeover) and F2 (operator job reach) CLOSED; G-1 checked and absent; privilege surface map live | [`hld`](docs/hld.md) §security, findings file |

**Owner-approved audit order, in flight:** operator surface ✅ → accounting-core
services ✅ → **the write paths** (next).

**Live, tickable owner actions** (entity → advisor → Groq → receipts):
[`docs/product/owner-actions.md`](docs/product/owner-actions.md) — that file is
the single writer for their state; do not restate it here.

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
   not test results. The M15 pass proved why: a test-verified fix coexisted
   with a live path still recording SAR 260.87 of phantom VAT through a rule
   no test asserted.

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

### Named failure modes and lessons

🔴 **ONE LINE EACH. The incident, the evidence and the countermeasure go to
[`findings-and-lessons.md`](docs/history/findings-and-lessons.md) in the same
commit** — that file holds the long form of every entry below. A lesson that
needs a paragraph here is a history record in the wrong file (the eviction
rules at the top of this file, rule 2).

- **A shape without a consumer** — a column/table/interface/flag looks exactly like progress and ships unbuilt; the standing check is the countermeasure.
- **A CONSUMER with no producer is worse** — a missing consumer yields a dead column nobody sees; a missing producer yields **a confident zero**, which reads as an answer. Check writers as well as readers. "Nothing writes it" is itself a claim needing part 5's search shape.
- **An obsolete assertion** — a correct-when-written absence assertion stays green while certifying the defect it now guards. Prefer presence assertions.
- **Two id spaces with no forcing function** diverge invisibly until something joins them. Remove the second, or add a test that fails when they drift.
- **The narrower-claim family** — a suite's or page's NAME describes a capability while its fixtures prove something narrower. Read the name as a claim; check the fixtures supply it.
- **Assert the property, not the number** — change one thing, prove the figure does not move, and prove something else DID.
- **An act about a document is not an act about a pattern** — consent to a rule in January is not consent to what it produces in November. (Why A3 is drafts-only.)
- **Partial data is not lenient data** — salvage the fields that WERE readable; never return part of a value as the whole value ("150.00" truncated to "15").
- **Who finds out?** Silence is not a neutral outcome. Quiet neglect needs an alarm, not a dashboard.
- **A name says who processed a movement, not what it was** — a keyword rule keyed on an ENTITY instead of an ACTION misclassifies everything that entity touches. Actor or action?
- **Green fixes the case, not the class** — when a fix is "add a guard to X", grep for X's siblings before accepting green as done.
- **External validators check the weakest property they plausibly could** — validate meaning locally; never infer correctness from an accepted submission.
- **Cost an option AFTER verifying its inputs exist** — name the inputs an approach consumes and grep for each, before recommending it. The cash estimate was not slightly low; it was about a different feature.
- **🔴 A stub is the part that needed testing** — test the branch you did NOT write (inject a failing implementation). At an interface, a method that cannot do the thing must THROW, never return: a no-op reporting success is a false statement the caller builds on. Look at every `resolve*Store` / `get*Provider` seam.
- **🔴 A dependency that accepts your input has not promised to honour it** — small-ICU Node accepts `islamic-umalqura` and returns Gregorian. When a dependency can silently substitute behaviour, probe an EXTERNALLY CHECKABLE FACT at boot. "It didn't throw" is not evidence.
- **Sources rank LIVE API > SDK > PDF > secondary** — and an unread primary source is not a licence to trust a secondary one.
- **Enforce invariants at the WRITE BOUNDARY, not in one path** — per-path enforcement is per-path review, and a new path starts at zero. Corollary: when line-level truth exists, header-level arithmetic is a second computation of the same fact and will drift. Corollary: **a REMOVED default is an invariant too** — defaults live wherever a writer supplies a fallback, and each is a write path.
- **🔴 AN INVARIANT ENFORCED ONLY WHEN THE CALLER DECLINES TO OVERRIDE IT IS A CONVENTION WEARING AN INVARIANT'S CLOTHES** (AUD-1/AUD-2, 2026-08-28). `invoicesService.create` allocates the C12 number only `if (!invoiceNumber)` — so the rule holds for callers who opt in, and two ordinary product paths opted out (the credit-note form minted `CN-<clock>`; the recurring template carried a fixed number). **The allocator's tests passing proved nothing about the rule**, because when enforcement is "we always call the allocator", the CALLERS are the enforcement. Same family as the write-boundary rule, one level up: ask not "is the invariant implemented" but "what can reach the same effect without going through it", and prefer a boundary with no override to one with a documented escape hatch.
- **🔴 A rule spelled out for a SIBLING field and omitted here is evidence of intent, not an oversight to fill in** — when a spec is silent on the property you care about, find the nearest place the same author DID state it and read the contrast. (Had both fields been silent, the absence would prove much less.)
- **🔴 A definition is not a rule — follow the delegation** — when a spec describes a field without stating its constraint, the constraint lives elsewhere; go find it. Reading first changed the plan, it did not merely confirm it.
- **🔴 The vacuous green in the measuring instrument** — a verdict line must carry the evidence count it rests on, and an instrument needs its own vacuity test: "all inputs failed" is a case it must NAME, not score. An unmeasured row reads "NOT MEASURED", never "matches baseline".
- **🔴 A mirror is a hypothesis about the target, not a fact about it** — before mirroring an entity, diff the two tables' columns in `information_schema` rather than reasoning from the shape of the source.
- **🔴 A retry cannot fix an ordering problem** — if the missing thing has a CREATOR rather than a settling time, waiting is just a slower failure. Ask *what creates this, and is it scheduled before me?*
- **A flag's scope drifts past its name** when the thing it gates becomes shared infrastructure. Move the gate WITH the thing the flag names.
- **🔴 Two correct assertions with a gap between them** — a top-line figure and a bottom-line invariant can both hold while the value sits in the wrong accounts. When an operation moves value BETWEEN accounts, assert both accounts, before and after. A conservation law can hold while the conserved thing is in the wrong place.
- **🔴 A defect whose trigger is VOLUME is invisible to every fixture we own** — a count taken from a capped list, an aggregate reduced client-side over a fetched page, a bulk action whose label counts one page. Capped-where-it-should-be-unbounded and unbounded-where-it-should-be-capped is ONE disease pointing both ways: the question is never "is there a limit" but "does the number shown describe the set the user thinks it describes".
- **🔴 A VALUE REACT DOES NOT OWN CAN BE SILENTLY REVERTED BY SOMETHING INSIDE ITS TREE** (B-8, owner-named 2026-08-28). Setting an attribute on `<html>` imperatively — `documentElement.dir` for RTL — is unreliable **by construction**: React reconciles `#root`, nothing re-asserts what lives above it, nothing notices when it is lost, and the static document's value is always there to fall back to. Generalises past the DOM: any fact produced outside a system's ownership and consumed inside it needs re-assertion or observation, never a single write. Third instance of a correct producer overwritten by a consumer (the scripted regex fix reverted by a stale `Edit`; migration 0044's dropped default re-created by a `?? 1` in a form). **Test that it survives a route change** — that is the event the current code never sees.
- **🔴 NO TEST EXERCISES THE CLIENT'S REQUEST CONSTRUCTION** (2026-08-28, from the browser drive). Every test in the suite builds its request the way the SERVER expects — calling a service or controller with a hand-made object — so a client that builds one differently is invisible by construction. That is the whole B-1 class in one sentence: `ApAging.tsx` declared a response shape nobody checked, `CreditNotes.tsx` minted a number the allocator was meant to own, and no amount of server-side testing could see either, because the request never came from the client. 🔴 The suite DOES send malformed input deliberately (`audit-med-validation.test.ts`) — the gap is not "we never test bad input", it is that **the client is never the thing under test**. Only something that drives the real client closes it.
- **🔴 SEPARATE FINDINGS COMPOSE INTO SOMETHING WORSE THAN THEIR SUM — AND THE COMPOSITION IS THE FINDING** (AUD-13, 2026-08-28). Five items, each survivable alone and each triaged at a severity correct in isolation, together minted a permanent ZATCA-stamped SAR 0.00 invoice. **Severity is per finding; consequence is per path** — run the TRIAGE CHECK above on every finding, and rank on the worst path rather than the worst item. This is the composition-defect class pointed at FINDINGS instead of code: two correct triage decisions with a bad path between them.
- **🔴 VERIFIED BELOW THE LAYER THAT HAD THE BUG** (AUD-13, 2026-08-28 — the sharpest form of the class). `POST /invoices` with `items: []` returned **201** and, under auto-approve, an ISSUED zero-value tax invoice: an ICV consumed, a ZATCA chain position taken, a QR minted, none of it recoverable. It was **not a malformed request** — it was well-formed with an empty array. Two things made it invisible: **the validation existed on the wrong schema** (`minItems: 1` is declared and enforced for quotations and purchase orders, which touch NO ledger, and was absent for invoices, which consume an ICV — the guard written where the consequence was smallest), and **every test bypassed the layer that had the bug** (service-level fixtures always carry realistic lines, while the CLIENT hardcoded `items: []`). Same family as the SDK differential that proved only that we matched a stale writer: ask what layer the defect lives in, and whether anything tests THAT layer rather than the one below it.
- **🔴 A SPEC CONSTRAINT THAT EXISTS AND IS NOT ENFORCED IS WORSE THAN NO CONSTRAINT**, because the spec AND the tests then both read as coverage. `minItems` in `openapi.yaml` binds nothing on its own: these routes pass `req.body` straight to the service, so every constraint in the contract is decorative unless a service re-states it by hand. Either generate the check from the contract or treat the contract as documentation — but never let a reader believe a declared constraint is an enforced one.
- **🔴 A CREATE FORM THAT OMITS A REQUIRED FIELD PRODUCES INERT RECORDS** (B-9, owner-named 2026-08-28). The same class as unreachable navigation, pointed at DATA instead: every control works, every request succeeds, and what lands is a row that no later step can act on — a record born unusable. **No reachability guard can see it**, because nothing is unreachable; the form reached the endpoint and the endpoint said 200. P4 asks whether a user can get somewhere; this asks whether what they created can go anywhere, and the two are independent. The tell is a field the WRITE path treats as optional and a READ path treats as required — check what every consumer of a new record needs BEFORE checking that the form submits.
- **🔴 A DESTRUCTIVE ACT'S SCOPE MUST MATCH WHAT THE USER CAN SEE** (owner-named, 2026-08-28). "Accept ready (183)" that accepts 5,000 and posts them is not a display bug — it is an authority bug, the same family as *delete all* deleting fifty: the user consented to what was in front of them and the system acted on a set they were never shown. The rule is not "label it accurately" but **name the true scope BEFORE the act**, and treat any gap between the visible set and the acted-on set as a defect in the act, not in the label. The display half of the same family is a surface that collapses two real rows into one — consent to the one becomes consent to both.
- **🔴 Nothing in this process checks whether a USER can reach what we built** — six read-only audits found none of four defects that one pass with a browser found in seconds. The suite has 1,100+ tests and renders zero pages, so a correct backend with no working surface is structurally outside what any of them can see. The countermeasure is a rendering layer, not another static guard. Assume any completed backend may be unreachable until someone has clicked it.
- **🔴 A correct API and a UI written against an imagined one** — a hand-written `apiFetch<T>` interface is a claim nobody checks, and TypeScript cannot check it against a real response. Prefer the generated OpenAPI client; a page must be RENDERED by something before it counts as working.
- **🔴 A server refusal nobody surfaces is indistinguishable from a frozen UI** — surface errors at the mutation cache, not per form (the write-boundary rule applied to error surfacing). An unsurfaced error is also a diagnosis nobody gets, including us.
- **🔴 A composition defect is invisible to any review that reads one file at a time — TWO shapes, TWO countermeasures, never conflated.** *Shape 1 (data flow):* one file writes the fact another trusts; both files are correct and the EDGE is the hole. The countermeasure is human — enumerate what a privilege can WRITE, then grep every guard that READS that fact. *Shape 2 (position):* a route on the wrong side of a guard. The countermeasure is mechanical — `tests/privilege-surface-map.test.ts`. 🔴 **The map would NOT have caught F1** and must never be cited as if it would.
- **🔴 A guard that tests a fact its own caller can create is not a boundary** — for each fact a guard consults, ask who can WRITE it. F1's fix replaced overlap with CONFINEMENT, because an actor can cause overlap with one INSERT and cannot cause confinement at all. Corollary: **a HIGH goes into this file the moment it is named**, before the session that named it ends — a finding that lives only in a transcript is remembered, until it isn't.
- **🔴 FK checks run OUTSIDE RLS** — every plain FK between tenant-scoped tables is a cross-tenant edge no policy guards, and 23503-vs-success is an existence oracle. When auditing isolation, enumerate the FKs, not just the queries.
- **🔴 Make the wrong thing INEXPRESSIBLE, not forbidden** — find the representation in which violating the rule cannot be SAID. Construction outlives review, and only construction binds code not yet written.
- **🔴 A verification is a claim about a moment, not a property of the text** — a validated artifact must STORE the identity of what it was checked against and gate on the match, or it ages into a false credential.
- **🔴 An instruction's referent is an INPUT — check it against the data, even when the instruction comes from the owner.** A work order once arrived for a milestone that did not exist. 🔴 **And an owner's MECHANISM for a bug they are reporting is an input too**: S-3 arrived twice with a confident mechanism (first "it double-counts AR aging", then "a `Map.set` overwrite silently drops an invoice") and NEITHER exists — building to either would have replaced a right answer with a differently-wrong one, which is worse than the bug, because it ships with a fix's credibility. The instinct was still worth following: the SHAPE it described (a value collision in a money path) was real two files away. Take the shape, check the mechanism, report the mismatch. Corrections ship narrow and scoped; a NAMED GAP beats a silent default that ages into being trusted.
- **🔴 A claim inside a measuring instrument is still a claim** — a benchmark's "hard" flag and its headline verdict were both authored, and both were wrong until measured.
- **🔴 Rendering a value the system cannot compute with advertises support that does not exist** — faithful rendering converts a visible inconsistency into an endorsed one. When a stored value is displayed but never computed with, refuse it at the WRITE boundary.
- **🔴 OUR VERIFICATION APPROACH IS STRUCTURALLY BLIND TO TWO CLASSES AT ONCE: VOLUME AND COLLISION.** Every fixture, dev org and seed we own is *small* and carries *unique* values, so nothing that only breaks at volume (a count off a capped list, a bulk act sized by a page) or only when values collide (an identity built from date+amount+description, or customer+amount+date) can be observed at fixture scale. Both appear the month a tenant gets busy. 🔴 **A suspiciously ROUND count is a diagnosis, not a coincidence** — exactly 500 is the shape of a cap, not of data. The countermeasure is a fixture LARGER than every cap AND deliberately degenerate in its values: `tests/scale-and-collision.test.ts`. A test that cannot fail on small data is not testing the property.

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
- **🔴 `db` REFUSES a query outside a tenant transaction.** The proxy used to fall back SILENTLY to the owner connection — RLS bypassed, no `app.current_org_id`, full cross-tenant reach, no error. It now throws `UnscopedDatabaseAccessError` for any DB-reaching method. A deliberately cross-tenant call (a platform job, migration, seeding, auth, tenant resolution, or an owner-only table) imports **`ownerDb`** and says so; thirteen production files now name their connection instead of inheriting one. 🔴 The conversion found a live instance: the operator surface read a tenant's `verification_documents` through the fallback. **Never re-add a fallback here** — making the unscoped query inexpressible is the whole point (§3).
- **🔴 NO AUTO-APPROVE. A create makes a DRAFT, for every role** (owner decision, 2026-08-28). `invoicesService.create` / `quotationsService.create` / `purchaseOrdersService.create` took `autoApprove` from the RBAC matrix, so an approver's create ISSUED the document in one call. Removed **entirely** — no parameter remains to pass. Its justification expired when M22 gave the product a real approve button, and what was left contradicted M10's own principle: **approval is an act about a specific document, and auto-approve made it an act about a setting.** On invoices it was also two-thirds of AUD-13's severity — the leg that turned a thin form from annoying into unrecoverable by minting an ICV and a ZATCA stamp from one call. Seeds and fixtures that want an issued document now create then approve (`tests/helpers/createApproved.ts`). 🔴 It also CLOSED the solo-approver finding by construction: with every create landing as a draft, the draft-gated controls (Submit, Delete, Edit) are reachable by whoever may create.
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
- **Sandbox traps:** it accepts ANY OTP; `requestID` is a constant stub; the
  sandbox PCSID is a shared canned certificate not bound to our key
  (`activateCredential` verifies the key and refuses a mismatch); a PCSID is
  issued even when compliance documents FAIL — assert compliance results
  directly, never infer from certificate issuance.
- **Issuance FAILS CLOSED for onboarded companies** (deliberate, owner-approved):
  if the document cannot be built/signed, the approval rolls back — a KMS
  outage stops invoicing rather than minting an unreachable invoice and a
  permanent ICV gap. Companies with no active credential are skipped silently
  and issue as before. Revisit diagnosability before a real taxpayer (queue C5).
- **The chain needs two mechanisms:** allocation serialised by
  `lockCompanySequence` (advisory lock covering the ICV read AND chain-head
  read), and ordering by **`icv DESC NULLS LAST, id DESC`** — never row id.
  `unique(company_id, icv)` is a backstop that structurally cannot see a fork.
  Out-of-order approvals fork the chain **sequentially** — this is not purely a
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
  REDEFINE `seed_org_chart_of_accounts()` — and be covered by a trigger
  round-trip assertion.** The org-seed trigger copies template→category
  **column by column**, and plpgsql resolves names at EXECUTION time, so both
  failure directions are silent at deploy: a **dropped** column the trigger
  still names breaks the next *signup* (M17.0/0038), and an **added** column the
  trigger omits seeds the next org with NULLs nobody asked for (M18.1/0041).
  Both happened; both were caught by hand. `tests/org-seed-trigger.test.ts` is
  the standing countermeasure — it compares the two tables' column sets rather
  than knowing any column's name, so it covers future migrations without being
  edited, and it has been verified to fail in **both** directions. Do not
  weaken it to a list of known columns.
- **Owner-only tables must REVOKE explicitly.** Supabase's base
  `ALTER DEFAULT PRIVILEGES` re-grants `TRUNCATE`/`REFERENCES`/`TRIGGER` on
  every `CREATE TABLE`, and **TRUNCATE bypasses RLS**. The defaults are
  narrowed (M14) and a throwaway-table guard test pins it; keep the pattern
  for any new table, and verify with `information_schema.role_table_grants`,
  never estimate from the schema.
- **Certificate renewal requires the TENANT's own OTP** — the platform cannot
  renew unattended; lead time is the entire value of the reminders (queue B1).
- **All four `EInvoiceProvider` methods route through the seam**
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

### Blocking, by their own nature

| # | Item | What would close it |
| --- | --- | --- |
| **R1** | 🔴 **REVENUE — the platform cannot take money.** No subscription, no billing, no plan gating exists anywhere; AI usage is metered (`ai_usage`) but nothing turns a tenant into a PAYING tenant. **No billing means no revenue, whatever else works** — the last MECHANICAL requirement between a working product and income. | Undesigned: provider (Stripe-class vs Saudi PSP), plan shape, what gating a plan implies. For customer #1 an off-platform invoice suffices; it stops sufficing quickly. |
| **ZATCA M12.7 + M12.9** | Blocked on a **registered Saudi company entity with an active ZATCA VAT registration and ERAD credentials**, which does not exist. Not a technical step. | The owner registering the entity. No rework expected — sandbox exercises the same API surface. **Do not** mock simulation to "finish" M12, and **do not** onboard a real tenant before both have run. |
| **A2 bank feeds** | Same blocker: signing with a SAMA-licensed open-banking provider almost certainly requires a Saudi CR. | Conversations stay useful without the entity; **signatures do not.** |

### 🔴 P5 — BROWSER TESTS IN CI, as its own project (queued 2026-08-28, NOT started)

**Why it is queued rather than started: half-building it inside a bug-fix pass
is worse than not starting.** It needs a browser in CI, seeded tenant data per
run, flake management, and ongoing maintenance — and a flaky E2E suite that
people learn to re-run is a guard that reports coverage it does not have, which
is the failure this whole sequence has been about.

**Why it is not a nice-to-have.** It is the ONLY method that has reached this
class. Every automated test we own runs a layer below the one that broke:

| Found by | Defects |
| --- | --- |
| A browser | the blank AP-aging page, swallowed server refusals, the GL showing SAR 0.00, an uneditable bill — and AUD-13, an issued zero-value tax invoice |
| 1,100+ tests | none of them |

The two 2026-08-28 lessons in §3 say why in one line each: **no test exercises
the client's request construction**, and AUD-13 was **verified below the layer
that had the bug**. A suite that calls services with hand-built objects cannot
see a client that builds them differently, however many assertions it carries.

**Scope when it is taken:** a smoke crawl over every route (authenticated,
failing on a page error or empty body) that also RECORDS every request the app
makes, so the recorded call set can be asserted against the mounted route table
— which closes P4's remaining blind spot (P4 proves a call site exists, not that
a control renders). Deferred deliberately; not deferred quietly.

### Deployment-time — cannot be closed from code

| # | Item |
| --- | --- |
| **B1/B2 wiring** | Pick a mail provider + verify a sending domain (`MAIL_PROVIDER`/`MAIL_API_KEY`/`MAIL_FROM`); point `ALERT_WEBHOOK_URL` at a real destination and confirm one test page arrives. The code is done; an unwired alarm is the thing B2 exists to prevent. |
| **C1 (remaining half)** | Confirm exactly `TRUST_PROXY_HOPS` proxies actually rewrite `X-Forwarded-For` in the real deployment. A wrong number is a spoofable limiter in either direction. |
| **C3** | **KMS deployment verification** — IAM/key policy, 30-day deletion window, break-glass-only `kms:ScheduleKeyDeletion`, CloudTrail alarm on deletion attempts, multi-region CMK replica. If the CMK dies, every tenant must re-onboard. |
| **C4 (remaining half)** | Deploy a clamd sidecar and set `MALWARE_SCANNER=clamd`. M-5's header-only magic-byte sniff closes with it. |
| **C6** | **Residency / hosting, now also the AI hosting decision.** (1) 🔴 Negotiate + sign the **Groq Enterprise agreement** (Dammam pinning + contractual ZDR) — **BLOCKING before any tenant data reaches Groq**; the free tier is in use for development and routes globally, and "development" is not an exception. (2) Confirm an Arabic-acceptable vision model in the Dammam region. (3) The platform-hosting half (region + KMS) is unchanged. No hosted Supabase project exists yet. |

### Advisor package — one conversation, four blocks

Written up in [`docs/product/advisor-questions.md`](docs/product/advisor-questions.md).

| # | Item |
| --- | --- |
| **C7** (Block A) | Retention of INBOUND supplier documents. A1 retains captures to the 6/11-year outbound standard as a conservative default, not a settled reading. 🔴 `retain_until` has a writer and **no reader** — nothing expires or refuses deletion on it, so it is a stored intention, not a policy; whatever duration comes back, an ENFORCER must be built. An answer SHORTER than the outbound standard is **not implementable today** (promoted captures live in a store with no delete) and would be a B3-shaped build. |
| **C8** (Block B) | 🔴 **PDPL — higher priority than C7.** Never considered anywhere in this project; scope it to the platform (audit logs hold IPs append-only, the archive holds names/addresses 6–11 years, `users`/`customers`/`employees` have no retention policy), not just capture. The irreversible act is already performed by ordinary users: posting a bill promotes a phone photograph into a store that by interface design can never delete it. 🔴 Ask whether inbound third-party captures may be made **erasable-with-audit** without touching the outbound ZATCA §5.5 guarantee — those cover invoices WE generated, and we currently give both classes the identical no-delete promise. **Also in this block:** whether an operator's readability of a verified tenant's identity documents should EXPIRE (see the operator surface note below). |
| **C10** (Block C) | 🔴 **ZAKAT base computation — M17.3 and M17.4 are HELD on this.** Q1–Q8 decided the MECHANISM; the TAX CONTENT has never been checked against the Zakat Collection Regulations. 🔴 **Ask C1 (the minimum-base rule) first — it is the only one that changes architecture rather than arithmetic**: if a rule ties the base to adjusted net profit, the income statement becomes a computed INPUT with its own adjustments and audit trail. Also open: exact base composition and qualifying provisions, the Gregorian divisor (354 vs 354.367) and rounding, whether nisab has any role in corporate Zakat (assumed NO — if so, say so in the UI so its absence reads as a decision), and whether declining mixed/foreign ownership is the right v1 posture. |
| **C12 leftovers** (Block D) | **D1:** whether ZATCA's *audit practice* questions gaps — the text cannot answer it, and a "yes" means building an explanation for each absent number, not changing the allocator. **D2:** both English texts are unofficial translations with the **Arabic prevailing**, and our reading rests on متسلسل / "sequential". |
| **Invoice dating** | 🔴 The closed-period policy is **REASONED-NOT-VERIFIED** (source: the owner, not an accountant): an invoice must not be dated into a closed period at all; work done in a closed month is issued in the current open period, and revenue belonging to the closed month is an accrual made BEFORE closing. Enforced today on create and on a changed `date` (423 `period_closed`). **The open question:** whether Saudi practice permits ANY exception — a grace window, or an audited override. |
| **AI tax gate** | 🔴 **No compliance-asserting AI findings before C9/C10 close.** The findings gate stays at (a) internal-consistency only; the (b) citation-carrying widening is QUEUED post-C10, with Art. 50 meal-VAT as first candidate. Likewise the OPINION register for AI-6 (queued post-C10, not rejected — it would be the platform's first unverifiable voice, and the fence question travels with it). |

### Code-level open findings — RANKED BY CONSEQUENCE, not by discovery

🔴 **Re-ranked 2026-08-28 using the composition question** (§3's newest lesson):
not "how bad is this finding" but "what does it compose with, and does the
result become **irreversible**, **uncorrectable**, or **unnoticed**". AUD-13 is
why: five items, each correctly triaged in isolation, that together minted a
permanent zero-value ZATCA invoice. **Composition risk is stated per row, and it
is the reason the order is not the severity order.**

| Rank | Item | Composes with | Why here |
| --- | --- | --- | --- |
| **1** | 🔴 **AUD-11 + AUD-12 + auto-approve — the AUD-13 path, minus the zero-value bug.** `PATCH /invoices/:id` and `DELETE /invoices/:id` have no caller. For an approver, creation auto-issues. | Each other, and auto-approve. This is **the same composition AUD-13 rode**; only the "no amount" leg was removed. | A mistyped amount on an issued invoice is now correctable only by credit note, and a mistaken draft cannot be deleted at all. Ranked as ONE item because fixing either alone leaves the path open. **Fix: draft-only Edit and Delete on invoices, bills and journal entries — all five routes already refuse the dangerous case server-side.** |
| **2** | **A 2xx for a transaction that rolled back** (`lib/tenant.ts:144`). Commit failure after `res.on("finish")` is logged only; the client already has its success. | The **unnoticed** multiplier, applied to every write path at once. Compose it with any create the user will not re-check and the record is simply absent. | Structurally hard to fix at that point, and nothing alarms on the pattern (L-1 family). An alarm is the minimum. |
| **3** | **AUD-10 — `PATCH /bills/:id` has no caller; a bill cannot be edited.** | AUD-12's missing bill delete. | A stuck draft, not a stuck legal document: bills consume no ICV and take no chain position. Same fix as rank 2, lower stakes. |
| **4** | **No password recovery for a multi-org account.** F1's confinement means such an account cannot be reset by a tenant admin, and there is no self-service flow. | Nothing that writes; it composes only with the absence of an operator reset. | A real lockout with a bounded blast radius and an obvious fix. B1's mailer is live, so a self-service flow is buildable. |
| **5** | **`operatorService.getApplication` accepts ANY orgId**, including an approved LIVE tenant, returning CR/VAT and verification documents; the access **never expires**. | **C8 (PDPL)** — a legal question, not a code one. | Audited and operator-only, so not a hole; an unbounded retention surface. Ask the advisor before building an expiry. |
| **6** | **`operatorZatcaService.onboardingStatus()` returns every company's VAT number across every tenant**, unfiltered and unpaginated. | Nothing. | The widest single cross-tenant read on the operator surface. Paginate; drop `vatNumber` unless a workflow needs it. |
| **7** | **The upload response's `duplicates` array has no UI consumer.** | 🔴 Flagged deliberately: this field was the *mitigation* that stood in for fixing S-1, and an unread field standing in for a fix is a composition risk in itself — it makes a gap look closed. | Show the skipped rows after an import. Cheap. |
| **8** | **Manual-JE balance failure returns 400 where the status policy says 422.** | Nothing. | Pre-existing and tested; align in a pass that owns the path. |
| **9** | **M-4** `bcryptjs` blocks the event loop on public endpoints, and no max-length validation before `varchar(255)` · **M-5** magic-byte sniff is header-only (closes with C4) · **L-1** security-audit write failures only `console.error` · **L-2** signup 409 leaks account existence (accepted) · **L-4** the operator queue list is unaudited (accepted). | L-1 carries the **unnoticed** multiplier and belongs with rank 3 when that is taken. | The genuine long tail. |

**Open DECISIONS** (not defects — flagged so they are decided rather than
defaulted): `platform-alarms` is classified NOT operator-runnable, so no surface
offers it (one-line flip if manual paging tests are wanted); and
`normalizeDigits` exists twice, pinned by a behavioural-equivalence test, pending
a shared workspace package.

**Open and unreproduced:** **B-8** — the RTL `<html dir>` loss. `applyLang` is
the only writer in the client and React does not own `<html>`, so if the
attribute is lost it is a runtime fact no static check reaches. Its lesson is in
§3 regardless.

🔴 **Three findings from P4 remain listed in its `KNOWN_GAPS` / `KNOWN_GAP_TRANSITIONS`**
(AUD-10, AUD-11, AUD-12), each with a companion test that FAILS if a listed
route gains a caller and stays listed — so closing them cannot leave the list
stale.

### Traps and known-dead surfaces

- **S6/S7:** `feature_flags`, `branches`, `departments` are tables with **no consumer** — do not assume they work; build a consumer or drop them.
- `status: 'overdue'` has **no writer** on invoices or bills (dead enum value; UIs style it, aging derives overdue from dates).
- VAT-return **box 4 (exports) is always 0** — an export today is a 'Z' line in box 2.
- Manual transaction create has no `kind`/`taxTreatment` fields, so every manual VAT-bearing entry is a null-treatment row with user-asserted VAT.
- Sub-cent amounts via the raw API can mark a document paid with a 1-halala GL residual (unreachable from the UI; round `paid` at the validation gate).
- Settlement links are readable from the transaction side only — the design said "either side".
- The income-statement **transactions-fallback** (zero journal lines only) reports gross incl. VAT.
- The Categories UI cannot mark system accounts (`isSystem` not in the API — latent; no edit routes exist).
- **Deferred feature:** action-level permissions for separation of duties (post-to-GL / pay / approve individually gateable).
- 🔴 **Re-check the hosted project's default privileges when it exists** — they may differ from the local Supabase CLI stack where the grant work was measured.

### What the audits could NOT see (so it is not mistaken for a clean bill)

RLS *policy* coverage was the biggest gap and is closed (`tests/rls-coverage.test.ts`).
Still unaudited: the **permission-matrix seed grants** (enforcement was audited,
the grants were not), **same-org cross-company isolation**
(`app.current_company_id` at row level), **git-history entropy scanning**
(prefix/pickaxe only, no gitleaks pass), and **runtime-order test vacuity**
(only execution reveals it). 🔴 And the standing one: **nothing in the suite
renders a page or runs at volume** — see §3's last two lessons.

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
| Cache / queue | **None.** No Redis — rate limiting is in-memory per-process (queue C1); background work runs on the in-process scheduler in `apps/api/src/jobs/`. Add an entry here **when it runs**, not when it is decided. |
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
  `components/ui/**` deliberately not owned (**120 tokens / 25 files** of
  physical properties still un-converted, so **RTL is incomplete** and becomes a
  launch blocker if the design pass slips past launch), the dead `.dark` block,
  and numeric alignment in RTL.
- [`docs/product/hub-structure-decision.md`](docs/product/hub-structure-decision.md),
  [`docs/product/design-transaction-accounting.md`](docs/product/design-transaction-accounting.md),
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

**The Edit tool can silently write back STALE file content.** During the
flaw-report work, a scripted fix to `categorizer.ts` (removing sixty broken
Arabic regex patterns) was **reverted** by a subsequent `Edit` call on the same
file: the edit applied cleanly against a snapshot taken *before* the script
ran, and writing that snapshot back undid the change. Nothing warned; the tool
reported success. It was caught only because a test that had just passed
started failing again.

**Why it matters more than it sounds:** the reverted change was invisible in
review (Arabic regex literals), and the failing test was the only signal. Had
the test not existed, the fix would have been "applied", reported, committed
and absent.

**Mitigations:**
1. When a file has been modified by a SCRIPT (python/sed/node) in this session,
   keep editing it the same way — do not mix scripted edits and `Edit` calls on
   one file. `categorizer.ts` is on the scripted path for this reason.
2. After any tool reports "the file had been modified on disk since you last
   read it", re-verify the earlier change is still present — the warning means
   the tool's snapshot was stale, and "applied cleanly" only describes the
   patch, not the rest of the file.
3. Prefer a test that fails loudly over an inspection: this class of loss is
   invisible to reading.

**🔴 `| tail` THROWS AWAY THE EXIT CODE, AND "Tests: N passed" IS NOT THE
VERDICT (2026-08-21).** A local full-suite run was reported here as "905
passed" and was not green: the line directly above said **`Test Files 1
failed`**. A teardown (`afterAll`) had thrown, which vitest reports at FILE
level while every individual test still counts as passed — so the metric I
read said 905/905 while the run had failed. CI caught it on the next push.

Two mechanisms, both worth fixing in the habit:
1. **`npx vitest run 2>&1 | tail -6` exits with `tail`'s status, not
   vitest's.** The pipeline reported success regardless of the suite. Use
   `${PIPESTATUS[0]}`, or don't pipe the command whose status you need.
2. **Read `Test Files`, not just `Tests`.** A hook failure, an import error and
   an unhandled rejection all fail the FILE without failing a test.

Same family as the merge-on-completion mistake above: in both, a metric that
looked green was read in place of the one that carried the verdict. The
general form — *when a tool reports several numbers, find out which one is the
verdict before trusting any of them* — is the reusable part.

**🔴 A CI poll that waits for COMPLETION is not a merge gate (2026-08-17).**
PR #54 was merged with a RED test check: the polling loop waited for every
check to reach `status: completed` and the merge step never looked at
`conclusion`. "The checks finished" and "the checks passed" are different
facts, and the loop's author had conflated them for four green PRs in a row —
green outcomes hid the missing predicate (an obsolete-assertion cousin: the
gate was never tested by a failure until one arrived). The failure was real
(B4's sequences lacked `USAGE` on CI's plain Postgres — an environment
difference local Supabase masked; fixed forward as 0047 within minutes).
**Rule: a merge step must assert every check's `conclusion == success`, and a
wait-loop is only a wait-loop.**

**🔴 AN EMPTY VARIABLE TURNS A TARGETED EDIT INTO AN EDIT OF EVERY LINE — THE
`rm -rf` SHAPE (2026-08-27).** A scripted edit to a tracked file was built from
a shell variable that was empty. The command did not fail, and it did not match
nothing: with no address to match on, `sed` applied the append to **every line
in the file**. The tool reported success. A one-line change became a change to
every line.

That is the same shape as `rm -rf "$DIR"/` with `DIR` unset: **a command that
cannot distinguish "no target" from "all targets", and whose default on that
ambiguity is maximal action.** The family is worth naming because the members
look nothing alike — `sed` without an address, `rm` with an empty path, a
`DELETE` whose `WHERE` built to nothing, a filter with an empty allowlist. The
tell is always the same: *what does this do when its input is empty?* If the
answer is "everything", quoting discipline is not the fix.

**The countermeasure — now the STANDING PATTERN for scripted edits to tracked
files: `scripts/anchored-edit.mjs`.** Every edit names an anchor; the anchor must
match **exactly once**; zero matches, two matches, or an empty anchor all abort
having written nothing. It refuses untracked files unless told. The ambiguous
case becomes *inexpressible* rather than merely discouraged — the §3 rule
applied to our own tooling — and "no target" and "all targets" now have
different, loud outcomes, which is the property `sed` lacks.

🔴 **It earned itself immediately, twice in the session that introduced it.**
Asked to rewrite `assertTargetInScope`, the anchor matched **two** call sites
and it refused rather than silently editing the first — the exact ambiguity that
had just cost a file. It also refused an empty anchor on a real source file when
that case was tested deliberately. Use it (`--dry-run` first when unsure) for
any scripted edit to a tracked file; a heredoc writing a WHOLE new file is fine,
and reach for the editing tools for one-off changes.

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
  claims and point at §2 for "now".** Any doc that carries free-standing
  status prose WILL drift: the README described Phase 0 as the frontier twenty
  milestones after it stopped being one, precisely because it restated status
  instead of pointing at it (found 2026-08-21; six more docs had the same
  disease in milder forms, including a blueprint still recommending Redis for
  a decision C1 had settled the other way). The rule, applied everywhere:
  a status line is **"Status (YYYY-MM-DD): <claim>. Current state authority:
  CLAUDE.md §2."** — the date makes staleness visible instead of silent, and
  the pointer makes §2 the single writer for "now" (the one-writer-per-effect
  rule, applied to prose). A header must also never lag its own body: a doc
  whose §12 says "built" while its title says "building" is the
  narrower-claim shape in miniature.
  🔴 **Corollary — a DATED artifact and a LIVE one are different documents,
  and the live one must never defer to the dated one** (owner, 2026-08-26).
  A snapshot is frozen by design; a checklist is ticked. Folding the second
  into the first produces the README disease one level up: the checklist
  inherits an "as of" date it does not deserve, and its state ages silently
  because the file it points at is not allowed to change. Split them, and
  make each the single writer for its own fact. (Applied 2026-08-26:
  `owner-actions.md` split out of `state-of-the-platform-2026-08-24.md`.)
- **pnpm only** (a preinstall guard rejects npm/yarn).
- **Typecheck** with `pnpm run typecheck` before considering work done.

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
```
