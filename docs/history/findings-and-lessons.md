# Findings #1–#11, the named failure modes, and the standing check (full record)

> Moved verbatim out of `CLAUDE.md` at the CLAUDE.md restructure
> (2026-08-13, post-M16.2). This is the historical record; the current
> operating summary lives in [`CLAUDE.md`](../../CLAUDE.md).
>
> Short forms of every rule here are in CLAUDE.md §'Standing checks'. This file holds the incidents and evidence.

### 🔴 "CORRECT" IS NOT "CONNECTED" — the Phase-2 pipeline was unreachable from real data

**Read this before reading M12.4's green result as more than it is.**

Until M12.1b, `issueInvoice()` never wrote `icv` or `zatca_uuid`. Every invoice
issued at runtime carried NULLs, and `assembleEInvoiceInput` **rejects** a row
without them (`missing_icv` / `missing_uuid`). So the entire ZATCA Phase-2
pipeline — UBL generation, signing, the QR, the outbox — **could not run on a
single real invoice.**

M12.4 validated six compliance documents against ZATCA's live API and every one
passed. That result is real, but it was obtained from **directly-constructed
inputs**, because nothing else was possible. It proved *the implementation is
correct*; it did **not** prove *the implementation is connected to the product*.
Those are different claims and it would be easy to read the first as the second.

**M12.1b closes the gap:** ICV/UUID are assigned at issuance, `loadEInvoiceInput`
builds the document from database rows, and
`tests/credit-notes-zatca-live.test.ts` submits an invoice, a credit note and a
debit note **read back out of Postgres** to the live compliance API.

Two bugs surfaced the moment real rows were used, both invisible to
hand-built fixtures:

1. **The wrong chain was being fed to ZATCA.** The loader passed
   `invoices.previous_hash` — the HOMEGROWN chain — as the PIH. On the first
   document of a chain that is the literal string `"GENESIS"`, which ZATCA
   rejects with `'GENESIS' is not a valid value for 'base64Binary'`. On every
   *subsequent* document it passed **silently**: a 64-character hex hash is
   accidentally well-formed base64, so ZATCA **accepted a PIH that means
   nothing** — a chain link pointing at a value from a different chain
   altogether, returned as `CLEARED`. The ZATCA PIH now comes from
   `einvoice_documents`, never from `invoices`.

   **🔴 Only the LOUD genesis failure exposed it.** Had the genesis case
   happened to be well-formed, the bug would have shipped: every document
   cleared, every response green, and the chain meaningless. **A stricter
   validator on ZATCA's side would have caught this at document one** — hex
   digits are a subset of the base64 alphabet, so `base64Binary` well-formedness
   is a near-worthless check here; a length or decoded-value check would have
   rejected it immediately. The lesson generalises past ZATCA: **when an
   external validator is the only thing checking a value's meaning, assume it
   checks the weakest property it plausibly could.** Validate our own chain
   linkage locally rather than inferring correctness from an accepted
   submission.
2. **The hash chain forked under out-of-order approvals** — see below. Note that
   this one had *no* loud case at all: nothing rejected it, and the DB constraint
   that looks like it covers the sequence structurally cannot see it.

### 🔴 SIX OCCURRENCES IS A PATTERN — the standing check

The same defect has now been found **six times in M12**, each in a different
component, each invisible until something forced the code onto a real path.
Note the last three especially: they are not "a function nobody calls" but a
**field nobody writes**, a **client that was only ever a mock**, and a **live
green result that covers less than it appears to** — the same disease in forms a
caller-grep alone would miss.

| # | Found | What was correct | What was not connected |
| --- | --- | --- | --- |
| 1 | M12.1b | UBL generation, signing, QR, outbox — all validated | `issueInvoice()` never wrote `icv`/`zatca_uuid`, so the assembler rejected every real row. The whole Phase-2 pipeline was unreachable. |
| 2 | M12.1b | The ZATCA PIH logic | The loader fed it `invoices.previous_hash` — a different chain entirely. |
| 3 | M12.8 | M12.6's outbox transport, proven offline | **Nothing ever enqueued.** No production code inserted an `einvoice_documents` row; `EInvoiceWorker` was never instantiated; `ZATCA_WORKER_ENABLED` was named in two comments and never declared; `listOverdue()` had no callers. |
| 4 | **M12.8** | `invoice_items.tax_category_code` — declared in M12.1a, back-filled by its migration, **validated** by the assembler | **No production writer.** The write path never set it, so every invoice created through the API carried NULL — and the assembler fails closed on NULL. For an onboarded company, **every invoice was unissuable.** Fixed in `invoices.service.create`: positive VAT rate ⇒ `'S'`; 0% stays NULL and must be stated explicitly, exactly as the migration decided. |
| 5 | M12.8 | M12.6's transport logic, claiming, backoff and state machine | **No real client existed.** `unconfiguredZatcaClient` THROWS; the only implementation was the test's mock. So M12.6's "complete" status covered a transport **proven only against a fake**, and an instantiated worker would have failed every send. Fixed by `zatca/liveZatcaClient.ts`. |
| **6** | **M12 close-out** | M12.4's live result: **six compliance documents PASS, zero errors, zero warnings** — real, and obtained against the live API | **🔴 IT COVERS DOCUMENT CONSTRUCTION, NOT SUBMISSION.** That result came from `POST /compliance/invoices` — an *onboarding gate* asking "can this EGS unit produce valid documents?". The production path is `POST /invoices/{clearance,reporting}/single`, which **has never been called, in any environment.** Still open; it is M12.7's first task. See [`docs/zatca/m12-status.md` §0](../zatca/m12-status.md). |

### 🔴 THE NAMED FAILURE MODE: **A SHAPE WITHOUT A CONSUMER**

Every finding above and below is the same thing. It deserves a name, because
naming it is what makes it visible before the fact rather than after.

> **A shape without a consumer.** Declaring the *shape* of a thing — a column, a
> table, an interface, a config flag, a package — is satisfying, reviewable, and
> looks exactly like progress. Nothing in the normal development loop then forces
> the follow-up that makes it real. The declaration passes review, passes
> typecheck, passes tests, and ships. It is indistinguishable from finished work
> until something tries to *use* it.

Why it is endemic here specifically: this project is schema-first and
contract-first by design (OpenAPI-first codegen, declared-in-full provider seams,
migrations before services). Those are good practices and they are **not** the
problem — but they systematically produce shapes ahead of consumers, which means
the gap between "declared" and "connected" is a normal state of the codebase
rather than an anomaly. In a codebase where half-built is normal, half-built does
not look wrong.

**The countermeasure is the standing check below.** Not more care, not more
review — a mechanical check, because the failure survives careful review by
construction. Thirteen instances found so far (six live, seven retroactive), and
the check caught something every single time it was run.

### 🔴 ASSERT THE PROPERTY, NOT THE NUMBER — when the reasoning might be wrong

Learned in M13, and it saved the milestone's most important guard from being
worthless.

The M13 design justified "no tax figure moves" by reasoning that the VAT return,
the Zakat base and cash flow all read `transactions` rather than the ledger.
**That reasoning was wrong about the VAT return, which reads INVOICES and BILLS.**
The conclusion happened to survive (M13 does not touch invoices), but the stated
mechanism did not.

Had the test been written from that reasoning — *"the VAT return should be zero,
because this org has no transactions"* — it would have asserted a fixed figure
derived from a false premise. Worse, it would have **passed**: the fixture had no
transactions, so zero was arrived at for the wrong reason, and a later change
that pointed the VAT return at the ledger would have been caught only by luck.
A vacuous test that looks green is worse than no test, because it is *counted*.

What was written instead asserts the PROPERTY:

> Post a GL-only journal entry — no invoice, no bill, no transaction behind it —
> then assert every VAT box, the Zakat base and cash flow are byte-identical
> before and after. Then assert the income statement **did** move, so the check
> cannot be vacuous.

That isolates the ledger as the only variable. It does not care *why* the tax
reports are independent, survives fixture changes, and fails for exactly one
reason: a tax report started reading the GL.

**The rule:** when you are about to assert a specific number, ask what has to be
true for that number to be right. If the answer is a chain of reasoning you have
not verified, **assert the invariant instead** — change one thing, prove the
figure does not move, and prove something else DID move so the test cannot pass
vacuously. Fixed figures are fine when the number itself is the requirement
(1,000 SAR of revenue); they are a trap when the number is a *consequence* of
reasoning that might not hold.

### 🔴 THE THIRD NAMED FAILURE MODE: **TWO ID SPACES WITH NO FORCING FUNCTION**

Found by running a realistic bank statement through the upload path (M15).
Adjacent to *a shape without a consumer*, and distinct in a way that matters.

**What happened.** `categorizeTransaction` returned `categoryId` from a hardcoded
`SEED_CATEGORIES` list numbered **1–30**. The real `categories` table — seeded by
M13 — numbers its rows **237–269**. The foreign key rejected every row, so
**auto-categorisation, which is ON by default in the Upload UI, imported
nothing.** The entire default path was inert.

**Why it is NOT "a shape without a consumer".** In those findings one side was
missing: a column nobody wrote, an interface nobody implemented, a function
nobody called. Here **both sides existed and both worked.** The categorizer
produced ids; the table held ids; each was correct in isolation. What was missing
was **anything that required them to be the same ids.**

> **Two id spaces that must agree, with nothing forcing them to, will diverge —
> and the divergence is invisible until something joins them.**
>
> It is worse than a missing consumer because both halves look finished, both
> have tests, and each test passes against its own notion of an id.

**How it came about, which is the instructive part.** The categorizer's ids were
correct when written — they described a category set that existed only in that
file. M13 then created a *real* chart of accounts with serial ids. **Neither
change was wrong.** The defect was created by the pair, at a distance, with no
overlap in time or in review.

**The countermeasure is a FORCING FUNCTION, not vigilance.** Fixed in M15 by
removing the second id space: the categorizer returns a **`system_code`**, the
same stable identity M13 already uses, and resolution happens against the
tenant's own chart. A test then asserts **every code the categorizer can emit
exists in the seeded chart** — so the two cannot drift apart without the build
failing.

**THIRD INSTANCE (flaw report, 2026-08-14) — the categorizer has THREE id
spaces, not two.** M15 removed the engine-ids-vs-table-ids divergence by making
`system_code` the single identity. But the matcher still does
`SEED_CATEGORIES.find(c => c.systemCode === rule.systemCode)` and **`continue`s
on a miss** — so a rule can name a code that is real, seeded in the tenant's
chart, and present in `allEngineCodes()`, and still never fire. That is exactly
what a newly-added GOSI rule did: it matched the text, then vanished.

Note how the existing forcing function could not catch it: `allEngineCodes()`
is DERIVED from the rules, so "every emittable code exists in the chart"
passes trivially. The missing link was rules → `SEED_CATEGORIES`, a third list
nobody had named. Now guarded by its own test.

**The sharpened rule: count the lists, not the pairs.** Asking "do these two
sets agree?" found two of three. The question that finds all of them is *how
many independent lists must agree for this to work, and what fails if one is
edited alone?*

**Where to look for the same shape:** any pair of enum/lookup/id sets maintained
in different files — permission resource strings vs mounted routes, ZATCA tag
numbers vs the codec, job names vs the scheduler registry, error codes vs their
UI mapping. Ask: *if someone edited one of these, what would fail?* If the answer
is "nothing until runtime", there is no forcing function.

### 🔴 THE SECOND NAMED FAILURE MODE: **A TEST THAT BECAME A GUARD FOR THE BUG**

Its close relative, and in one way worse — because here the safety mechanism is
the thing that fails.

> **An obsolete assertion.** A test that was *correct when written* can quietly
> invert into a guard certifying the defect, and stay green across the very
> milestones that should have invalidated it. Nothing flags it: it was true, it
> is still passing, and passing tests are not re-read.

**The instance (S1).** `ubl-generation.test.ts` asserted that
`zatcaDirectProvider.onboard` and `.submit` throw `NotImplementedError`. Correct
and useful at M12.2 — "unbuilt methods must fail loudly rather than silently
succeed". Then **M12.4 built onboarding and M12.6 built transport**, each
shipping its logic elsewhere and leaving the seam throwing. The assertion stayed
green through both. For two milestones a passing test was **certifying that the
vendor swap point did not work**, and its green status was one of the reasons
nobody looked.

Note how it compounds: a *shape without a consumer* is invisible, and an
*obsolete assertion* actively defends the invisibility.

**COUNTERMEASURE — add to the milestone checklist:**

> When a milestone **implements or moves** something, grep for tests asserting
> that thing is **absent, unimplemented, or throwing** — `NotImplementedError`,
> `.rejects`, `toThrow`, `toBeNull`, `toBeUndefined`, `not.toContain` — and
> re-read each hit. An assertion of absence is a claim with an expiry date, and
> the milestone that implements the thing is when it expires.

Where an absence assertion is genuinely long-lived, **invert it into a presence
assertion** as S1 did (every provider method must be reachable) — a positive
assertion cannot silently outlive its purpose the same way.

### 📋 RETROACTIVE SWEEP (M12 close-out) — seven more

Six instances was enough to assume more existed, so the standing check was
applied backwards across everything `CLAUDE.md` claims.

**S1 and S2 are FIXED** (see below). **S3–S7 are TRACKED DEBT — recorded, not
fixed.** Nothing in S3–S7 is exploitable or wrong today; they are capabilities
the documentation implies are available and which are not, which matters when a
future session plans work assuming they exist.

| # | Claim | Reality | Severity |
| --- | --- | --- | --- |
| **S1** ✅ **FIXED** | **The `EInvoiceProvider` seam is one of two MANDATORY hedges** for the build-direct decision: "so a certified provider can be slotted in per-tenant later without re-architecting". | Was: **only `buildDocument` wired**; `onboard`/`renewCertificate`/`submit` threw, and the real paths bypassed the seam (onboarding called `zatcaOnboardingClient`, the worker called `ZatcaHttpClient`). **A hedge that covers only the part you do not need is not a hedge** — and it is the stated fallback if building direct fails. **Now all four methods route through the seam**; see the S1 entry below. | **HIGH** |
| **S2** ✅ **FIXED (as a description)** | M12.6: an ambiguous failure "is reconciled by **ASKING ZATCA what happened**". | **Nothing asks ZATCA, and nothing can:** ZATCA's API exposes **no invoice-status or query endpoint** — Compliance CSID, Production CSID, Clearance and Reporting are the entire documented surface. Implementing a query would mean inventing an endpoint, which is exactly the guessing the divergence log exists to prevent. So the **description** was corrected to say what actually happens: an ambiguous document parks in `needs_review` and **a human** resolves it in the Fatoora portal. Sound design; false comment. | **MEDIUM** |
| **S3** | Tech Stack table: **"Cache / queue — Redis"**. | **Redis is not used anywhere.** No dependency, no client, no config. The only mention in code is a comment saying rate limiters *should* move to a Redis store when scaling. Listed as if it were part of the running stack. | **LOW** (doc accuracy) — but it feeds queue item C1, which assumes Redis exists to move to. |
| **S4** | Repository Layout: `apps/api/src/lib/` holds "accounting + infra: **glPosting, periodLock, zatca, categorizer**, auth, logger". | **M6 moved all four** to `services/accounting/` and `services/categorization/`. `lib/` no longer contains any of them. The layout section was never updated. | **LOW** — actively misleading for navigation. |
| **S5** ✅ **RESOLVED (deleted)** | `packages/auth` was listed as a workspace ("auth/RBAC; populated later"). | A 3-line stub. All auth and RBAC live in `apps/api/src/lib/` after six milestones of work; nothing depended on the package. **Deleted** — see below. | **LOW** |
| **S6** | The `feature_flags` table "exists" and is listed among the platform tables. | **Created by a migration and referenced by nothing.** No repository, no service, no route reads or writes it. Same shape as `companies.zatca_onboarding_status`, which was dropped in M12.8 for exactly this. | **LOW** — but it is a trap: the next engineer will reasonably assume flags work. |
| **S7** | `branches` and `departments` tables exist as platform tables (M2/M3). | **No production code references either.** Schema-only, like `feature_flags`. | **LOW** — same trap, same class. |

#### S1 — what "wired through the seam" now means

- **`onboard`** — the ZATCA onboarding controller calls `resolveProvider().onboard(...)`;
  `zatcaDirectProvider` delegates to the existing flow. No behaviour change, but
  onboarding is now a provider concern, which is what a vendor actually sells.
- **`renewCertificate`** — implemented, and it is **the same flow as onboarding**.
  ZATCA has no "extend" operation: a new certificate comes from a fresh CSR
  authorised by a new OTP. And `vaultRepository.activate` already supersedes the
  previous active credential *inside one transaction*, so re-running onboarding
  rotates atomically — never two active credentials, never none. New route
  `POST /zatca-onboarding/renew`.
  🔴 The M12.2 signature was `renewCertificate(companyId)` — **no OTP** — which
  quietly implied the platform could renew unattended. That is the opposite of
  true and it is the single most important operational fact about expiry, so the
  signature now takes `RenewalInput`.
- **`submit`** — the worker takes an `EInvoiceProvider` instead of a
  `ZatcaHttpClient` + credential resolver. The provider resolves its own
  transport credentials, exactly as a vendor would hold its own.
- **The outbox tests now drive the REAL provider over a fake socket**, so the
  seam is covered by the same tests that cover the transport, rather than
  bypassed by them.
- **The inverted regression test.** `ubl-generation.test.ts` used to assert that
  `onboard` and `submit` THROW. That assertion was correct at M12.2 and then
  stayed green through M12.4 (which built onboarding) and M12.6 (which built
  transport), because both shipped their logic elsewhere and left the seam
  throwing. **A passing test was certifying that the vendor swap point did not
  work.** It now asserts the opposite.

#### Two real bugs found while wiring S1

1. **🔴 The worker was sending the WRONG UUID.** It sent
   `uuid: String(row.invoiceId)` — our internal row id — where ZATCA requires the
   document UUID that matches `cbc:UUID` inside the signed XML. It would have
   been rejected. Invisible to every offline check (the XML is valid, the hash is
   right, the signature verifies) and reachable only by a real submission, which
   has never happened. Fixed by carrying `zatca_uuid` on `einvoice_documents`
   (migration `0023`, back-filled) — the worker runs on the base pool where
   joining business tables is forbidden, so the value must be on the row.
2. **ZATCA returns HTTP 303 when clearance is DISABLED** for a taxpayer, meaning
   the document must go to the Reporting API instead. Found in the technical
   guideline while checking whether a status endpoint exists. Previously a 303
   fell into the generic retry branch and would have been retried against the
   clearance endpoint forever, burning every attempt while looking transient. Now
   classified non-retryable with the real remedy in the message.
   🔴 Deliberately **not** auto-re-routed: switching a STANDARD invoice to
   reporting changes its legal treatment (no stamp, no returned QR), and we have
   never observed the behaviour. Auto-routing is an M12.7 task.

#### Test-isolation consequence (worth knowing before adding suites)

Claiming and the archive sweep are **global and cross-tenant by design** — that
is the point of a background worker. So any two suites that both create
`einvoice_documents` interfere: one suite's worker will claim and submit the
other's documents. This broke three tests the moment M12.8 gave more than one
suite real documents. Both now accept an optional `organizationId` scope, omitted
in production and supplied by tests. Weakening the assertions to tolerate
partial counts was the alternative, and it would have hidden the next real bug.
The same scope is the seam a future sharded/per-tenant worker would use.

**Already correctly documented as deferred — checked and NOT findings:**
`companies.fiscalYearStart` (stored, exposed, explicitly recorded as not wired
into report periods, and the Company Settings UI says so to the user); the
`users` permission resource (seeded, explicitly recorded as not wired to
`requirePermission`); `mailer` as a no-op (now queue item B1). These are the
model — a gap stated plainly is not a gap in the record.

#### S3–S7 — TRACKED DEBT (not fixed; decide, do not drift)

None is exploitable. Each is a claim that outruns reality, and each has a
decision attached rather than a task:

- **S3 — Redis.** In the Tech Stack table, used nowhere. **This makes queue item
  C1 unactionable as written** (see the annotation there): C1 says "move the rate
  limiters to Redis", which reads as a migration and is actually a new
  infrastructure dependency. Either introduce Redis deliberately, with its cost
  and operational burden priced in, or delete the row from the stack table and
  re-scope C1 around what we will actually run.
- **S4 — the Repository Layout section** still points at `lib/glPosting`,
  `lib/periodLock`, `lib/zatca`, `lib/categorizer`. M6 moved all four to
  `services/`. Actively misleading for navigation; a doc fix.
- **S5 ✅ RESOLVED — `packages/auth` DELETED.** It was a 3-line stub while six
  milestones of auth and RBAC work (M4, M5, M10.1, M11.1, M11.3, M11.5.1) landed
  in `apps/api/src/lib/`. An empty package named for a concern that lives
  elsewhere is a trap in both directions: the engineer looking for auth code
  finds three lines, and the one adding auth code has two plausible homes with
  nothing to choose between them. Deleted rather than populated — the code has a
  working, tested home, and relocating six milestones of boundaries would be pure
  churn. Nothing depended on it.
- **S6/S7 — `feature_flags`, `branches`, `departments`.** Tables created by
  migrations and referenced by no code. Exactly the shape of
  `companies.zatca_onboarding_status`, which was dropped in M12.8 for this
  reason. They are a trap in the same way: the next engineer will reasonably
  assume feature flags work. Either build a consumer or drop them.

**The pattern across S1–S7:** every one is **a shape without a consumer** — the
named failure mode above. Applying the standing check retroactively found seven
in a single pass, which is the strongest available argument for applying it
prospectively.

---

**#6 is the most consequential, and the only one that did not look unfinished.**
The first five were absences — no caller, no writer, no implementation — visible
to anyone who looked. #6 is a **green live result that reads as end-to-end proof**
and survived three milestones precisely because it looked finished. A green
compliance run says the envelope is well-formed; it says nothing about posting
the letter.

**🔴 THE STANDING CHECK — apply ALL THREE parts before recording any milestone
as done:**

> 1. **Every capability has a production CALLER.** For anything claimed as
>    surfaced to users — an alarm, a queue, a status view, a job — grep for the
>    symbol and discard tests and comments. A function only a test calls is
>    unbuilt.
> 2. **Every field it depends on has a production WRITER.** A column that only a
>    migration back-fills is unbuilt. Declaring it, validating it, and reading it
>    are three things that all look like progress and none of which populate it.
>    Grep for writes, not just references — *(this is finding #4, and note the
>    field was fully validated, which made it look more finished than it was)*.
> 3. **Every client it depends on has a REAL IMPLEMENTATION, not an interface
>    plus a mock.** A seam with one throwing stub and one test double is a
>    design, not a transport. If the only thing that ever satisfied the interface
>    lives in a test file, the milestone that "completed" it did not
>    — *(finding #5)*.
> 4. **Every LIVE EXTERNAL RESULT is recorded with the ENDPOINT that produced it
>    and what that endpoint attests.** "It passed against the real API" is not a
>    scope — the scope is the endpoint. A pass on an onboarding/validation
>    endpoint does not cover the production path, however green and however real
>    — *(finding #6, the one that survived three milestones because it looked
>    finished)*.
> 5. **🔴 RUN THE CHECK ON YOUR OWN CONCLUSIONS, NOT ONLY ON THE CODEBASE.**
>    Before reporting that a capability is missing, ask what implementation
>    shape you searched for and whether it is the only shape that capability
>    could take — *(finding #7, which is one of MINE)*.
>    **Amended at M16.2 close-out, after the SECOND instance:** a claim of
>    absence must carry its **search shape** — state WHAT was searched for
>    (the symbols, paths, and implementation shapes the capability could take)
>    and WHAT WOULD HAVE FALSIFIED the claim, so the reviewer can review the
>    search rather than only the conclusion. An absence claim without a stated
>    search shape is an opinion. *(See THE ABSENCE-CLAIM PATTERN below.)*

### 🔴 NAMED LESSON: AN ACT ABOUT A DOCUMENT IS NOT AN ACT ABOUT A PATTERN

Decided in A3, and it resolves an argument that looked settled by precedent.

M10.4 established **self-approve-on-create**: a user with `approve` authority who
creates an invoice issues it immediately, because the act of creation by an
authorised person *is* the approval. By analogy, a recurring rule written by that
same person should carry the same authority to every invoice it generates.

**The analogy fails, and the reason is worth keeping:**

> **Self-approve works because the approver is LOOKING AT THE SPECIFIC DOCUMENT.**
> Creating an invoice is an act about *that invoice* — its amount, its customer,
> its date, all visible at the moment of consent. Creating a rule is an act about
> a **pattern**, and patterns drift: the customer cancels, the price changes, the
> tax treatment changes, the person who wrote the rule leaves. Consent given to a
> pattern in January is not consent to what that pattern produces in November.

The cost of being wrong decides it here. Approval fires issuance: an ICV
consumed, a position taken in the ZATCA hash chain, a QR minted, AR posted, a
submission queued. **None of it reversible** — correction requires a credit note,
a second legal document in the same chain.

So A3 generates **drafts only**. Auto-issue is deferred, and the asymmetry is the
argument: deferring costs one boolean; a bad unattended issuance costs a credit
note and a permanent chain entry.

**Where else this applies:** any feature where a user authorises a *rule*,
*template*, *policy* or *schedule* rather than an instance — approval routing,
auto-categorisation that posts, bank-feed auto-acceptance (A2). Ask whether the
consent was given to a thing the user could see.

**And the invariant that survives regardless** (borrowed from M11.7's
invitations): **a rule may never grant authority its creator does not hold**, and
that authority is **re-checked at generation, never stored**. A rule is not a
credential. Built in A3 even though nothing uses it yet, so that when auto-issue
ships the check already exists rather than needing to be remembered.

### 🔴 NAMED LESSON: PARTIAL DATA IS NOT LENIENT DATA — it is a wrong answer

Found in A1's TLV decoder, and it generalises far beyond TLV.

The decoder was written to be **lenient**, which was correct: it parses payloads
produced by every other ZATCA vendor's software in the Kingdom, so a truncated or
odd document must yield what it can rather than throwing away a whole capture.

But leniency had been implemented as *"return the bytes that are there"*. A
truncated final field came back as a **shorter value**:

```
   "150.00"   truncated   →   "15"
```

**`15` is a perfectly plausible VAT amount that is wrong by a factor of ten**, on
a document supporting an input-VAT deduction, shown to a user with no way to know
it was clipped. An exception would have been better. **Silence would have been
better.**

> **The rule: leniency means salvaging the fields that WERE readable. It never
> means handing back part of a value as though it were the whole value.**
>
> A partial number, a truncated identifier, a half-decoded string: each is not a
> degraded answer, it is a **confident wrong answer wearing a right answer's
> shape** — and it is worse than an error, because an error gets handled and this
> gets used.

The fix keeps the leniency and drops the fiction: fields before the damage stay
readable, the truncated tag is reported **absent** and listed in `truncated`, and
the caller falls back to OCR rather than presenting a corrupt figure.

**Where to apply it:** any parser reading data this platform did not produce —
supplier QR codes, OCR output, bank feed rows (A2), imported CSVs, third-party
API responses. Ask of every partial-read path: *if this value is half-right, does
the caller find out?* If not, return nothing for that field.

### 🔴 FINDING #7 — the check applied to its own author

Every finding above is about the codebase. This one is about the analysis of it,
and it is recorded because a check applied only outward will keep missing this
class.

**What happened.** Asked what was half-built, a survey grepped for an OCR/scan
**endpoint**, found none, and reported *"there is no OCR at all; someone built
the review UI and never built the extraction that feeds it."* The first clause
was true. The conclusion was false: document capture is **~80% built and runs
today**, entirely client-side — `ReceiptScanner.tsx` runs Tesseract.js in the
browser, feeding `receiptParser.ts` → `ScanReview.tsx` → `POST /bills/:id/post`.

**The error is the same shape as findings #1–#6, inverted.** Those were
*capability present, consumer absent*. This was **capability present, searched
for in the wrong place** — absence of an *endpoint* taken as absence of
*extraction*, because the searcher assumed OCR must be server-side.

**Why it mattered.** It was reported to the owner as fact and used to justify a
recurring cloud-OCR bill. Had it not been caught, the platform would have bought
a provider it may not need, sending customer documents out of the Kingdom against
an open residency question, to replace a free local baseline that already worked.
**A wrong finding is more expensive than a missing one**, because it gets acted
on.

**The habit that catches it:** before writing "X does not exist", name the
implementation shapes X could take — server endpoint, client-side library, build
step, third-party call, database trigger — and confirm the search covered them.
One extra grep (`package.json` dependencies would have shown `tesseract.js`
immediately).

### 🔴 FINDING #11 — the page named "VAT Report" was fed by the WEAKER of two VAT sources

**Found preparing the M16 design (2026-08-12), fixed in M16.1 — and it is the
most consequential instance of the narrower-claim family yet, because unlike
the others, a user would have FILED from it.**

The product computed VAT two ways:

| Source | Computed from | Treatment-aware? | UI consumer (pre-M16.1) |
| --- | --- | --- | --- |
| `reports.vatReturn` | **invoices + bills** — the legal documents: S/Z/E/O per line (M12.1a), credit-note direction (M12.1b), box-structured | ✅ | **NONE** — routed at `/reports/vat-return`, consumed by nothing, absent from the OpenAPI spec |
| `summary.getVat` | **transactions** — a bank-line guess with no treatment concept | ❌ | the page **literally titled "ZATCA VAT Return"** |

The carefully-built correct source was unreachable from the UI; the guessed
figure wore the filing page's name. And note what that means about M12.1a and
M12.1b: **the S/Z/E/O work and the credit-note direction work were built,
tested, protected by `documentSign()` — and then never surfaced.** That is the
shape-without-a-consumer pattern applied to a whole report, and it survived
because the report's *endpoint* existed: every grep for "is the VAT return
built?" answered yes.

**The fix (M16.1, per design Q0 — decided by the owner):** documents FILE,
transactions RECONCILE. `VatReport.tsx` renders the box-structured
`reports.vatReturn` (now in the OpenAPI spec with a generated hook); the
transaction-derived figure stays visible **beside** it as a reconciliation —
"VAT per your documents" vs "VAT per your bank activity", gap itemised. The gap
is a feature: undocumented cash activity shown to an SME *before* filing.
`tests/vat-return-http.test.ts` pins both halves **over real HTTP** (the
finding was about reachability, so the test must reach): the return serves the
box structure, a VAT-carrying bank transaction moves *nothing* on it, and the
same transaction *does* appear on the reconciliation side.

**The habit this adds:** a report is not done when its endpoint returns the
right shape — ask **which page renders it**, and if two sources answer the same
user question, ask **which one the user actually sees**. Full design (all
questions decided): [`docs/product/design-transaction-accounting.md`](../product/design-transaction-accounting.md).

### 🔴 FINDING #10 — "skips a locked period": wrong on mechanism AND on principle

Written into the automation spec, and repeated, before A3's design checked it.

**Wrong on mechanism.** A rule cannot "skip" a locked period, because it cannot
get that far: `invoicesService.create` already calls `checkPeriodOpen`, so
creating even a **draft** dated into a closed period throws. The guard predates
A3. The spec described behaviour the code makes unreachable.

**Wrong on principle, which matters more.** Even if skipping were possible it
would be the wrong choice: a skipped recurring invoice means **a customer was not
billed, and nothing says so.** That is the quiet-neglect shape this project keeps
naming — and it is **worse than the ZATCA outbox case**, because an unsubmitted
invoice eventually draws a complaint from ZATCA, whereas an unsent invoice has
**no external party who will ever notice**. The only person who could catch it is
the one who automated it precisely so they would stop watching.

**How it got written twice:** "skip" sounds tolerant, and tolerant sounds safe.
The check that would have caught it is asking *who finds out?* — the same question
behind the alerting requirements (B2) and the truncation lesson. Silence is not a
neutral outcome; it is a choice about who bears the cost of a failure.

Corrected: the run **fails**, records `period_locked`, and is surfaced in a
per-rule run history. Re-dating into the next open period was also rejected — it
moves revenue between VAT periods, which is a tax decision a job must not make
quietly.

### 🔴 FINDING #9 — the QR decoder has never read a REAL supplier invoice

**Found at A1 close-out, and it is finding #6's shape in a new place.**

The TLV codec is well tested: 10 cases covering Arabic multi-byte names, raw-byte
tags 8/9, truncation, unknown tags, rubbish input. Twelve more cover capture,
verification and promotion. **Every single payload in all of them was encoded by
`tlv()` — our own encoder.**

So what the suite proves is that **our codec round-trips our own output.** It
does not prove it can read a QR produced by **Qoyod, Wafeq, ClearTax, a POS
terminal, or any of the other ZATCA solutions our customers' suppliers actually
use** — which is the entire job of the decode path.

🔴 **This is the SECOND time a test suite has proven a narrower claim than its
name implied**, and the pattern is worth naming on its own:

| | Suite | Name implies | Actually proved |
| --- | --- | --- | --- |
| **#6** | ZATCA compliance tests | our documents are accepted by ZATCA | our documents pass the **onboarding/validation** endpoint. **Submission was never called.** |
| **#9** | TLV codec tests | our decoder reads ZATCA QR codes | our decoder reads **our own encoder's output**. No third party's QR was ever decoded. |
| **#11** | the "ZATCA VAT Return" page | shows the VAT return | showed the **transaction-derived guess**, while the real box-structured return was routed and consumed by nothing. The worst of the family: a user would have **filed** from it. |

Both are green, both are honest about what they run, and both were **read as
covering more than they do** — because the suite's *name* describes the
capability while its *fixtures* describe something narrower.

> **The habit: read a test suite's name as a CLAIM, then ask what would have to
> be true for the claim to hold, and check the fixtures supply it.** "Our decoder
> reads supplier QR codes" requires a supplier's QR code. "Our documents are
> accepted by ZATCA" requires the endpoint that accepts documents. If the
> fixtures are ours, the claim is about us.

Related to the standing check's part 4 (record which endpoint produced a live
result) — this is the same idea applied to fixtures rather than to endpoints.

**Why it is not alarming, and why it still matters.** The TLV format is simple
and settled, and our encoder was itself validated against live ZATCA responses —
so the risk is not that the format is wrong. The risk is in the **edges another
implementation will produce and ours never does**: tag ordering, optional tags,
padding, whitespace, a Phase 1 QR from a POS that pads fields, a vendor writing
tag 3 in a different timestamp shape (divergence #13's territory).

**The cheap fix, and it should happen before OCR work or A2:** photograph half a
dozen real supplier invoices from different Saudi vendors, run them through
`readZatcaQr`, and add the payloads as fixtures. A handful of real documents
converts the wedge from "should work" to "does work" — and if a common vendor's
output does not decode, that changes the roadmap rather than being discovered by
a customer.

### 🔴 FINDING #8 — half a fix that read as a whole one (also mine)

**What happened.** M14 scoped `claimDue` by organization so parallel test suites
would stop claiming each other's outbox rows. `reclaimStale` — the *other* global,
cross-tenant mutation in the same repository, called by the same `runOnce()` one
line earlier — was left unscoped. The outbox suite kept flaking on `main` for two
milestones.

**Why it stopped there: THE TESTS WENT GREEN.** The suite passed twice
consecutively after the `claimDue` change, and that was taken as the signal the
problem was solved. It was the signal that *one instance* was solved. Nothing
asked whether the same class existed elsewhere in the same file.

**It compounded:** the test suite also called `claimDue` **directly**, bypassing
the worker's new scoping entirely — so even the fixed operation was unscoped on
half its call paths.

**The lesson, and it is a specific one:**

> **A green test suite tells you the case you reproduced is fixed. It tells you
> nothing about the class.** When a fix is "add a scope/guard/filter to X",
> immediately grep for X's siblings — the other operations with the same
> signature, the same globality, or the same missing parameter — *before*
> accepting green as done.
>
> Green is where investigation usually ends. That is precisely why it is where
> this class of bug survives.

Related in kind to finding #4 (`tax_category_code` was declared, back-filled and
validated — three things that look like progress — while nothing wrote it).

Each part is cheap — three greps — and every one has caught something the first
time it was applied. The reason it keeps happening is structural rather than
careless: a component built correctly and tested in isolation produces a green
suite, and a green suite reads as "done". Nothing in that loop ever asks whether
anything calls it, writes to it, or implements it for real.

**The mock is the subtlest of the three**, because a good mock makes the test
*more* convincing: M12.6's outbox tests are genuinely excellent and prove exactly
what they claim — the transport's behaviour. What they cannot prove is that a
transport exists. Judge a seam by its non-test implementations; if that count is
zero, say so in the milestone record.

**The general lesson — and the reason "validate from real ledger rows" is an
acceptance criterion, not a nicety:** a green result against fixtures says
nothing about the path from the database. **Both bugs above were invisible to
hand-built fixtures, and neither was a subtle one** — one fed the wrong chain
entirely, the other broke the chain's core invariant. They were invisible because
fixtures supply by hand exactly the values the real path gets wrong: a fixture
author writes a plausible base64 PIH and approves documents in creation order,
so both faults are papered over by construction. Fixtures test the code you
wrote; only real rows test the code you forgot to write. **Every future
integration milestone must have at least one test that submits data read back
out of Postgres**, produced by the product's own write path — that is what
`tests/credit-notes-zatca-live.test.ts` is for, and it earned its keep on the
first run.


### 🔴 NAMED LESSON (M16.2): A NAME SAYS WHO PROCESSED A MOVEMENT, NOT WHAT IT WAS

Found by chasing the M15/M16 live-verification finding (#6 in that pass — the
SAR 260.87 phantom input VAT on an ATM withdrawal) to root cause instead of
patching the symptom row.

The bank-charges rule matched **bare bank names** (`ANB`, `Riyad Bank`, …) at
0.90 confidence, and the fintech rule matched bare gateway names (`Tamara`,
`Tabby`). So *every row that mentioned a bank* was in scope, not just fee rows:
the ATM withdrawal was booked as a bank-charge expense with invented input VAT,
and a Tamara **settlement of customer revenue** classified as a bank-charge
expense — **revenue turned into expense**, which is worse than the ATM case.

> **The generalisation: an entity name in a bank-line description says WHO
> PROCESSED the movement, never WHAT the movement WAS.** The same institution's
> name appears on its fees, on transfers through it, on settlements it forwards,
> on loan disbursements and on salary batches. Any keyword rule keyed on an
> **entity** (a bank, a gateway, a government body, an employer) rather than an
> **action** (fee, charge, commission, رسوم) will confidently misclassify every
> other thing that entity touches.

Fixed in M16.2 as **two separate fixes**, per the owner's instruction: the rule
itself now requires fee-words, AND `kind: transfer` excludes the movement class
— deliberately separate so the exclusion could not paper over the bad match.

**Where to apply it:** every categorisation rule, every A2 bank-feed rule, and
any future auto-matching — ask of each trigger token whether it names an actor
or an action.

### 🔴 THE ABSENCE-CLAIM PATTERN — twice now, so it is a pattern, not an incident

Finding #7 (OCR reported as nonexistent while ~80% built client-side) has a
second instance: the M16 design document called `bank_accounts` "one of the
no-consumer S6/S7 family", when it is a **full working domain** — routes,
service, repository, permission entry, RLS, a `/bank-accounts` UI page. Only
the link from `transactions` was missing. The claim pattern-matched the S6/S7
family instead of searching the shapes a consumer could take.

Both instances share the shape: **absence inferred from one search shape and
stated as fact.** And both were **acted on** — #7 was used to justify a
recurring cloud-OCR bill; the second mislabelled a working domain as dead code
in an approved design document. A wrong absence claim is more expensive than a
missing one, because it reads as diligence and gets built on.

The countermeasure is the amendment to standing-check part 5 above: **state the
search shape with the claim** — what was searched, and what would have
falsified it — so the search is reviewable rather than only the conclusion.

### 🔴 FINDING (M16.3): ANY payment amount marked the document fully paid — a reachable defect nobody had exercised

Recorded as a finding in its own right at the owner's instruction, not merely
as an M16.3 fix — because it predates the reconciliation work entirely and was
reachable from the product the whole time.

**The defect.** `invoicesService.pay` and `billsService.pay` overwrote
`paidAmount` with whatever amount was passed and set `status = 'paid'`
unconditionally. Pay 100 against a 230 invoice and the invoice was "paid" with
130 still owed.

**Why it is the M12.1b two-independent-computations hazard again.** Two
reports computed "what is outstanding" independently: AR/AP aging skips
`status = 'paid'` rows, while balance-sheet AR (GL-based since M13) carries the
un-received residual. A partial payment made them **silently diverge** — aging
under-reported by the residual with nothing to show it, exactly the drift shape
the M12.1b credit-note note warns about ("AR aging would drift from
balance-sheet AR with nothing to show it").

**Why it survived.** Every caller — the Invoices/Bills UI and every test —
paid the full total, so the divergence was never produced. One test
(`chart-of-accounts.test.ts` "agrees after a partial payment") DID pay
partially, but asserted only that balance-sheet AR agreed with the invoice
table — both of which were consistent with each other; neither was aging. The
test proved the half that happened to work. A reachable defect with no
exerciser is the shape-without-a-consumer family seen from the other side:
the CAPABILITY (partial payment) was implied by the API accepting any amount,
and nothing had ever consumed it.

**The fix (M16.3):** payments ACCUMULATE (`paidAmount += amount`), `paid`
means fully paid, and overpaying the outstanding balance is refused (409, the
same posture as the over-crediting guard). Pinned by the M16.3 tests: a
partial settlement keeps the document open and in aging with the residual.

### 🔴 NAMED LESSON (audit close-out): ENFORCE INVARIANTS AT THE WRITE BOUNDARY, NOT IN ONE PATH

The unifying root cause of the audit's Tier-2 findings, now recurring often
enough to name. "Z/E/O means no VAT" was enforced in exactly ONE service path
(update()'s treatment branch) while three other writers violated it — the
Categorize run kept stale VAT beside a Z/E/O treatment, upload kept
CSV-supplied VAT beside a non-'S' resolution, and PATCH could write vatAmount
alone. Each path was individually reviewed and tested; the INVARIANT had no
owner. The same shape produced the settlement-integrity holes (links checked
"not both" but tied to nothing) and, earlier, the two-id-spaces defect (M15)
and the pay-path full-payment defect (M16.3).

> **The rule: an invariant that more than one code path can violate belongs at
> the write boundary — a DB CHECK, a repository-level gate, a single shared
> writer — not in the paths.** Per-path enforcement is per-path review, and a
> new path starts at zero. A CHECK constraint is reviewed once and holds for
> every writer that will ever exist (migration 0034 is the model: clean the
> violating rows, add the CHECK, fix the paths so they don't 500 on it).

Corollary, from Tier 1: **when line-level truth exists, header-level
arithmetic is a second computation of the same fact** — and two computations
of one fact drift (the M12.1b family). The VAT return reconstructed a rate
from rounded header cents while `invoice_items.tax_category_code` held the
actual answer; invoice headers accumulated unrounded VAT while lines stored
rounded. Both were fixed by making the finer-grained truth the only source
(classify per line; header = Σ rounded lines by construction). Before deriving
a fact arithmetically, ask whether the fact is already RECORDED at a finer
grain.

### Scope drift: a flag named for one thing gating another (audit Tier 3)

`ZATCA_WORKER_ENABLED` was introduced in M12.8 to make transmission to a
government API a deliberate act. When the scheduler became shared
infrastructure, the flag's gate stayed at `startBackgroundJobs()` — so a flag
named for ZATCA silently disabled recurring-document generation, capture
promotion/purge and renewal reminders, none of which transmit anything. With
the flag at its documented default (off), A3 generated nothing, ever.

> **The rule: when a gated thing becomes shared infrastructure, the gate must
> move WITH the thing it names, or the flag's scope drifts past its name.** A
> reader trusts the name; nothing in review flags that the flag now covers
> strangers. Fixed by gating per-job (`scheduled: false` on the two transport
> jobs) with the scheduler always running; every job stays operator-runnable.

### 🔴 META-FINDING #9 (flaw report, 2026-08-14): TWO REPORT FAMILIES READING DISJOINT DATA

The M12.1b two-independent-computations hazard at the largest scale in the
platform, and the frame the whole flaw report resolves to.

**The shape.** Two families of reports read two different stores and never
reconcile:

| Family | Reads | Feeds |
| --- | --- | --- |
| Ledger | `journal_entries` / `journal_entry_lines` | income statement, trial balance, balance sheet, GL, journal report |
| Transactions | `transactions` (accepted) | dashboard summary, VAT reconciliation, Zakat base, cash flow, budget actuals |

Nothing posts an accepted transaction to the ledger, and nothing in the product
tells a user which family a figure came from. **Its worst symptom is flaw #1:**
observed live, one SME month produced an income statement showing **0.00 of
expenses** beside a dashboard showing **45,063.25** — and a P&L revenue of
4,200 (one invoice) beside dashboard income of 29,900 (cash sales). Neither
figure is the business's revenue or expenses; each is one half.

Every other flaw in that report is a smaller instance of the same disease:
the VAT return vs the VAT reconciliation (deliberate and documented, but the
reconciliation was 66% phantom), and `paidAmount` vs GL cash before M16.3.

**Why it survived.** Both families are individually correct, individually
tested, and individually reviewed. The M13 chart-of-accounts work made the
LEDGER family right; the M15/M16 work made the TRANSACTION family right. No
milestone owned the relationship between them, and the standing check asks
whether a capability has a consumer — not whether two consumers of the same
question agree.

**The rule this adds:** when a second store answers a question the first store
already answers, that is a design decision requiring an explicit reconciliation
story — which figure is authoritative, how the other is labelled, and what the
user is told. Absent that story, the two drift and both are believed.


### 🔴 MAJOR FINDING (flaw report, 2026-08-14): THE ARABIC HALF OF THE ENGINE HAD NEVER RUN

Not a footnote to the GOSI fix — the largest silent-inertness finding to date,
in a product positioned Arabic-first, and it survived every review because
its failure mode was **a plausible answer**.

**Class 1 — the ASCII word boundary.** `` asserts a transition between
`[A-Za-z0-9_]` and anything else. Arabic letters are not word characters to
the regex engine, so between a space and "ر" there is **no boundary at all**:

```
/راتب/.test("راتب سبتمبر")   →  false
/راتب/.test("راتب سبتمبر")        →  true
```

Sixty patterns were written the first way — salaries, rent, utilities, Zakat,
VAT, insurance, government fees. Every one had never matched. Substring
matching is also the CORRECT semantics here, not a concession: Arabic attaches
the definite article and prepositions to the word ("الرواتب", "للرواتب"), so a
boundary-anchored match would miss the common forms even if `` worked.

**Class 2 — a bidirectional-editing typo that reads as correct.** In the salary
rule, what *looked* like `` was a backslash followed by the Arabic letter
**ب** (U+0628). `\ب` escapes nothing, so the pattern matched the literal
string "براتب" — a string no bank statement contains. **Nobody would ever spot
this reading the source**: in a bidi-rendering editor the glyphs sit exactly
where `` would.

**Why it was invisible.** Nothing errored and nothing was miscategorised — the
rows came back **uncategorised**, which is precisely what a well-behaved engine
returns when it does not know. M15 had *deliberately* taught the engine to say
"I don't know", so the symptom of total Arabic failure was indistinguishable
from the feature working correctly. A silent failure wearing the shape of a
designed behaviour is the hardest kind to see.

**The guard, and why it is source-reading.** Two tests parse
`categorizer.ts` itself and fail on any `` adjacent to Arabic script or any
backslash-escaped Arabic letter. Behavioural tests alone would not do: they
prove the cases you thought of, and this defect is defined by the cases you
did not. Plus five Arabic probes that previously returned NULL.

**Where else to look:** any regex over non-Latin text (``, `\w`, `\d` are
all ASCII-centric under default flags), and any bidirectional string literal —
identifiers, file paths, and test fixtures included.

---

### 🔴 FINDING #8 CLOSED (M17.0, 2026-08-15): A CONSUMER WITH NO PRODUCER — the Zakat page that always answered SAR 0.00

**What was there.** A "Zakat Assessment" page with three stat cards, an included-
transactions table, a nav entry, an OpenAPI schema, a route, a controller, a
service, a repository query, two UI toggles that wrote the input, and four test
files asserting the figure did not move. By every structural measure, a finished
feature.

**What was almost entirely missing.** Anything that set the input. The endpoint
selected `WHERE is_zakat_relevant = true`; of the engine's ~40 categorization
rules, exactly **one** wrote it true — "Saudi investment / Tadawul" →
`INVESTMENT_INCOME`, which is also the only seeded account row carrying
`zakat_relevant = true`. Everything else emitted `false`. The only other writer
was a UI switch a user had to find and flip by hand, on a page whose sole effect
was this report.

**So the page did not fail — it answered.** For almost every tenant:
`totalZakatableAssets: 0`, `zakatDue: 0`, "BELOW NISAB THRESHOLD", rendered in
the same confident typography as a real figure.

🔴 **And the one thing that COULD populate it made the answer worse, not
better.** Investment *income* was the sole automatic input to a total labelled
"Zakatable Assets" — and since the sum added credits and subtracted debits, a
tenant with Tadawul activity got their investment income reported as an asset,
reduced by every unrelated debit in their history. The single producer fed the
consumer a number of the wrong sign, the wrong kind and the wrong grain. A
feature that is merely absent is recoverable; this one was answering.

#### Three defects, not one

1. **The (near-)empty input set, and its one poisonous member** (above).
2. **Nisab is personal-Zakat reasoning applied to a company.** The threshold was
   `const NISAB_SAR = 19550` — "approx. 85g gold at ~230 SAR/g as of 2024",
   hardcoded, and stale the year it was written. Corporate Zakat is assessed on
   a Zakat base, not against a gold-derived nisab.
3. **It summed the wrong quantity anyway.** Credits minus debits over all time —
   a flow — presented as an asset balance.

Any one of the three would have made the number wrong. Having all three meant no
single fix would have surfaced the others.

#### The named lesson: **a consumer with no producer is worse than a shape with no consumer**

The catalogued failure mode is *a shape without a consumer* — a column or
interface declared and never read. This is its mirror, and it is the more
dangerous polarity:

| | Shape without a consumer | Consumer without a producer |
| --- | --- | --- |
| What exists | The declaration | Everything except a meaningful write |
| What the user sees | Nothing | **A confident zero** |
| How it is found | Someone greps for readers | **Nobody reports it — it looks like an answer** |

A dead column is inert. A live report over an empty input is *actively
misleading*, and it is specifically the failure that survives a demo, a code
review and a passing test suite. Standing-check **part 2** ("every field has a
production WRITER — grep for writes, not references") is the countermeasure, and
it is the part most often skipped, because the surface it guards looks complete.

#### The absence claim needed the same check as everything else

The first pass of this fix recorded — in the migration, the schema comments, the
service, the spec and this file — that **nothing** ever wrote the flag. Running
standing-check **part 5** against that conclusion (grep the pre-change file;
state what would falsify it) found the Tadawul rule and forced a rewrite of all
of them.

That correction was not cosmetic. "Nothing writes it, so the report is always
0" describes a **missing feature**. "One rule writes it, and that rule files
income as an asset" describes a **wrong number**. The overstated version was
the more comfortable finding, and it would have been preserved verbatim in six
durable records — including a migration comment written specifically to stop a
future session from reintroducing the column.

**An absence claim is a finding.** It carries the same burden of proof as a
presence claim, and it is more tempting to skip, because nothing fails when it
is wrong.

#### The tests were the loudest part of the failure

Four files asserted "the Zakat figure does not move" across settlement,
transfer, GL-only posting and review-acceptance. Every one compared **0 to 0**.
They were green from the day they were written and would have stayed green
through any defect they claimed to guard — *assert the property, not the number*
in its purest form: the fixtures never supplied a Zakat-relevant row, so the
property was never exercised.

They were removed, not repaired. Two reasons, and the second matters more:

- Repairing them would mean seeding the flag the milestone deletes.
- **The property they asserted is now intentionally false.** Owner decision Q4
  derives the Zakat base *from the general ledger*. A "Zakat must not move when
  the GL moves" assertion would encode the opposite of the spec — an obsolete
  assertion in the making, caught before it was written rather than after it had
  spent a year certifying a defect.

#### What was removed, and the one trap in removing it

`transactions.is_zakat_relevant`, `categories.zakat_relevant`,
`system_account_templates.zakat_relevant`, `GET /summary/zakat`, `ZakatSummary`,
`summaryService.getZakat`, `summaryRepository.zakatRows`, the Categories and
Transactions toggles, the transaction list filter and badge, and 61 field
literals in `categorizer.ts` (scripted, per the §10b tooling hazard).

🔴 **The trap:** `seed_org_chart_of_accounts()` — the trigger that seeds a new
organization's chart of accounts — SELECTed `zakat_relevant` from the templates.
plpgsql resolves column names at **execution** time, so dropping the columns
first would have raised nothing during the migration and then failed **every
future signup**, at a call site nowhere near the change. Migration 0038
redefines the function before it drops anything. Verified after applying: the
columns are absent from `information_schema`, `pg_proc.prosrc` no longer names
them, and the full 620-test suite passes against the real database — every DB
test creates an organization, so the trigger is exercised on every one.

**The general shape:** when dropping a column, grep the **database** for readers
too, not only the application. Trigger bodies, views, RLS policies, generated
columns and CHECK constraints are all consumers that a TypeScript-wide search
cannot see, and the plpgsql ones fail late.

---

### 🔴 NAMED LESSON (M17.2): A DEPENDENCY THAT ACCEPTS YOUR INPUT HAS NOT PROMISED TO HONOUR IT

**The incident.** M17.2 needed Umm al-Qura (Hijri) dates. Node's ICU provides
them: `new Intl.DateTimeFormat('en-u-ca-islamic-umalqura', …)` converts exactly,
and no dependency is required.

But ICU is a property of the **runtime**, not of our code. A Node built with
small-icu **accepts that locale without complaint and silently returns
Gregorian dates.** The constructor does not throw. The formatter does not
return null. Every call produces a well-formed, plausible date — in the wrong
calendar.

**Why that is the dangerous failure and not an inconvenient one.** A Zakat base
is a balance measured **on a date**. A fiscal-year boundary that is wrong by ten
days is a wrong balance, which is a wrong filing figure, and nothing downstream
could detect it: the number is well-formed, in range, and internally consistent.
The platform would have been confidently wrong on the one output the module
exists to produce.

#### This is the second instance, so it is a pattern

| | Arabic `\b` (flaw report) | small-ICU (M17.2) |
| --- | --- | --- |
| What was asked for | word-boundary match on Arabic | the Umm al-Qura calendar |
| What the API did | accepted the regex, matched nothing | accepted the locale, returned Gregorian |
| Error raised | none | none |
| Output missing | no — rows came back "uncategorised" | no — dates came back well-formed |
| Why invisible | uncategorised is a DESIGNED outcome | a plausible date is indistinguishable from a correct one |

Both are the same shape: **the interface accepted the input and quietly did
something else.** Neither produces an error to catch, an exception to log, or an
absence to notice. In both cases the symptom wears the costume of correct
behaviour.

#### The countermeasure, stated generally

> When a dependency can silently substitute different behaviour, **probe an
> externally checkable fact at startup** — not a round-trip through the thing
> you are testing.

Three parts, each load-bearing:

1. **Externally checkable.** The probe must be verifiable against a source
   *outside* the dependency. M17.2 asserts that 2025-06-26 is 1 Muharram 1447
   AH — a published fact anyone can check against a Saudi calendar. A round-trip
   (`fromHijri(toHijri(x)) === x`) would pass *perfectly* on a Gregorian
   fallback, because a consistent wrong answer is still consistent.
2. **At boot, failing closed.** Same posture `loadEnv` takes with the mailer and
   alerter: refuse to start rather than run degraded. A silently-degraded
   calendar is invisible until someone files on it.
3. **Not "it didn't throw".** Absence of an exception is the weakest possible
   evidence and is exactly what both incidents produced.

#### Where else this applies

Any capability supplied by the *environment* rather than by code we ship:
locale and collation behaviour, timezone databases, crypto algorithm
availability, filesystem case-sensitivity, and character-encoding defaults.
Each can be present-but-different rather than present-or-absent — and each is
therefore a candidate for a boot probe against an external fact.

**The generalisation of the generalisation:** whenever the failure mode is
*substitution* rather than *absence*, testing for presence is testing the wrong
thing. Test for the specific behaviour, against a fact the substitute cannot
also satisfy.

---

### 🔴 FINDING (M18.0): THE PRODUCT WAS SELLING A PLAN THAT DOES NOT EXIST

**What was shipping.** `ReportsHub.tsx` listed 39 reports. Thirteen existed. The
other 26 rendered greyed out behind a padlock, each with the tooltip **"Upgrade
to unlock this report"**, under a header reading **"13 available · 26 premium ·
39 total"** and a banner offering to **"upgrade your plan to access all 26
locked reports."**

**There is no plan.** No billing, no subscription model, no paid tier, no
pricing decision anywhere in this product. So the page was not merely promising
reports that did not exist — it was making a **commercial claim false in both
halves**: a tier the tenant cannot buy, gating reports nobody has written.

**And one padlocked entry was already built.** "Cashflow Report" sat behind the
upgrade prompt while `/cash-flow` had been a routed, navigable page the whole
time. The catalogue was charging for something already shipped.

#### Why this is a different failure from the ones already catalogued

The Zakat page (finding #8) asserted a **tax fact** it could not support. This
asserted a **commercial fact** — and nobody had ever decided it. There was no
pricing conversation, no tier design, no owner instruction. A screen layout
invented a business model and shipped it.

That generalises past reports and past pricing:

> **A UI affordance can assert something the business has not decided.**
> A padlock is a claim about *commercial terms*. A greyed-out row is a claim
> about *the roadmap*. A "coming soon" is a claim about *intent*. Each is a
> statement of fact to the reader, and each needs a decision behind it exactly
> as a tax figure does.

#### The fix that makes it stay fixed: remove the MECHANISM, not the entries

Deleting 26 rows would have left `locked?: boolean` on the interface, the
padlock branch in `ReportLink`, the premium counter and the upgrade banner —
i.e. everything needed to list a 27th unbuilt report, and an implicit invitation
to do so. The affordance is what made the claim cheap to make.

So the removal was: the entries, the three categories they emptied completely,
**the `locked` field itself**, its rendering branch, the counter and the banner.
What remains cannot express "a report that does not exist" at all.

**The guard:** `tests/reports-catalogue.test.ts` reads `ReportsHub.tsx` and
`App.tsx` as source and fails if any catalogue entry has no mounted route, or if
the locked/premium vocabulary returns to the **code** (prose in comments is
exempt — the file's header records what was removed and why). A behavioural test
cannot cover this: the defect is defined by entries nobody wired to anything.

**The general form, worth carrying:** when removing a class of defect, ask what
made it *expressible*. Removing the instances leaves the grammar; removing the
grammar ends the class. Same shape as `ArchiveStore` having no `delete` method —
the guarantee holds because the operation cannot be written, not because
everyone remembers not to write it.

---

### 🔴 NAMED LESSON (M17.0 + M18.1): A COLUMN-BY-COLUMN TRIGGER FAILS SILENTLY IN BOTH DIRECTIONS

`seed_org_chart_of_accounts()` copies `system_account_templates` → `categories`
one named column at a time, and runs on every organization INSERT. The same trap
fired **twice, in opposite directions, two milestones apart**:

| | Migration | What changed | What broke | When it would have surfaced |
| --- | --- | --- | --- | --- |
| **Dropped** | 0038 (M17.0) | removed `zakat_relevant` | trigger still NAMED it | the next **signup**, far from the migration |
| **Added** | 0041 (M18.1) | added `liquidity_class` | trigger did NOT name it | never, visibly — the next org just gets NULLs |

**Neither errors at migration time.** plpgsql resolves column names at
EXECUTION time, so `CREATE OR REPLACE FUNCTION` happily accepts a body naming a
column that does not exist. The added-column direction is worse still: nothing
errors *ever*. The organization is simply seeded incomplete, and the symptom
appears as a feature that quietly does not work for one tenant.

Both were caught by hand, by remembering. **Twice is a pattern, and "remember to
check the trigger" is a hope, not a countermeasure.**

#### The standing rule

> Any migration that touches `categories` or `system_account_templates` must
> redefine `seed_org_chart_of_accounts()`, and is covered by a trigger
> round-trip assertion.

`tests/org-seed-trigger.test.ts` enforces it **generically** — it compares the
two tables' live column sets (aliasing `code` → `system_code`, deriving that
`sort_order` is template-only) rather than knowing any column by name. A future
migration is covered without editing the test.

Three assertions, and the third is what makes the first two trustworthy:
1. every column shared by both tables is named in the trigger (added direction);
2. every column the trigger names still exists on both sides (dropped direction);
3. a real organization is inserted and every shared value is compared against
   its template row — source analysis proves the trigger *names* the right
   columns; only running it proves the values *arrive*.

**Verified to fail, not merely to pass.** Both directions were injected against
the live database and the guard failed with an actionable message each time —
the added case reported `probe_col`, the dropped case reported `zakat_relevant`
by name. A guard that has never been seen to fail is an assumption.

---

### 🔴 NAMED LESSON (M18.4.1): COUNT THE CONSUMERS, NOT THE AGREEMENT

The rule "which organization is this request acting in?" was written twice:

    lib/tenant.ts    memberships.find(m => m.organizationId === requested) ?? memberships[0]
    routes/orgs.ts   req.session.activeOrgId ?? organizations[0]?.id

They agree whenever the session's chosen org is still a live membership — which
is every ordinary request. They diverge only after a revoked membership, a
deleted org, or a session outliving its access: `resolveTenant` then puts the
request in the user's FIRST real org while `/orgs` echoes the STALE id back, so
the switcher, the user-admin page and every role check describe a different
organization from the one being acted in.

**Nobody had noticed, and the reason is the lesson.** Two copies that agree in
the common case do not look like a defect. They look like duplication — a
tidiness issue, the kind of thing you leave alone because it works. The
divergence needs an uncommon precondition to appear at all.

What exposed it was **adding a third consumer**. `/auth/me` needed the same
fact, and at three call sites the question stops being "are these two copies in
sync?" and becomes "who owns this rule?" — and the answer was nobody.

> **The signal is the NUMBER of consumers, not whether they currently agree.**
> Agreement is what a latent divergence looks like from the outside. Two
> implementations of one rule are a defect waiting for a precondition; the
> third consumer is just when you find out.

Adjacent to **count the lists, not the pairs**: the cost is combinatorial in
the number of places a rule lives, and each new consumer multiplies it rather
than adding to it. The fix is the same either way — extract one owner
(`lib/activeOrg.ts`) before adding the consumer, not after.

**A shape detail worth copying:** the selector returns the whole membership,
not an id. A caller therefore cannot pair one organization's id with another's
role — the two facts travel together or not at all. Splitting a compound answer
into separate getters is how the next divergence would have started.

---

### 🔴 NAMED LESSON (M18.2): MAKE THE WEAKER REQUIREMENT STRUCTURALLY LOAD-BEARING

Two requirements landed on the balance-sheet breakout:

1. it must keep `balanced` reconciling;
2. unclassified accounts must surface in the totals rather than vanish.

The obvious build asserts each separately: compute the sections, then add a test
that unclassified items appear. That leaves (2) as a **cosmetic** check — one a
future refactor can delete, or quietly satisfy while folding unclassified into
`current`, without (1) noticing.

Instead the buckets were built as a **partition of the existing item list**:

    current.total + nonCurrent.total + unclassified.total === total

Now (2) cannot be violated without breaking (1). Folding unclassified into
`current` double-counts and the partition fails; dropping it under-counts and
the partition fails. Verified by injecting exactly that change — **both** tests
went red, including the arithmetic one.

> **When two requirements are related, prefer a construction where violating
> one BREAKS the other over checking both independently.**

The general move: find the arithmetic or type-level relationship that already
couples them, and express the design in those terms. A separately-asserted
requirement is only as durable as the test that remembers it; a structurally
coupled one is enforced by the thing nobody dares break.

Same family as the ArchiveStore lesson — there, deleting was made
*inexpressible*; here, hiding is made *unbalanced*. Both replace a rule someone
must remember with a shape that cannot express the violation.

---

### 🔴 NAMED LESSON (M19.1): A PER-POINT QUERY THAT RE-READS FROM THE BEGINNING OF TIME IS QUADRATIC IN HISTORY

The Analytics trend needed a liquidity ratio at each month-end. The obvious
build is a loop: call `balanceSheet(as_of)` twelve times.

`balanceSheet(as_of)` is a *cumulative* query — it reads **every posted GL line
from the beginning of time** up to that date, because a balance sheet is a
position, not a period. Loop it over N points and the work is
`O(points × lines)`, and since `lines` itself grows with history the real shape
is **quadratic in how long the tenant has been a customer**.

Measured before building anything (owner instruction — measure, do not
discover it in the UI):

| GL lines | 12 balance sheets | per point (median) |
| --- | --- | --- |
| 61 (a dev org) | 138 ms | 9 ms |
| **6,000 (a busy SME year)** | **4,612 ms** | **578 ms** |

#### Why this class of defect survives review

**It is fine in development and unusable in production, and the variable that
separates them is the one nobody seeds.** A dev database has 61 lines; the
number that makes the feature slow is *history*, and history is the one variable
that **only ever grows** and that a fresh environment never has. So:

- it passes local testing,
- it passes CI,
- it passes a demo,
- it degrades on the tenants who have been paying longest,
- and it degrades **exactly when they first have enough history to want the
  feature at all**.

That last point is the sting: a trend chart is worthless to a two-month-old
tenant and valuable to a two-year-old one, so the feature gets slower precisely
in proportion to how much anyone wants it.

#### The rule

> **Before looping a cumulative query, ask what it re-reads.** If each call
> starts from the beginning of time, N calls are not N× the cost — they are
> `O(N × history)`, and history is the variable that only grows.
>
> The fix is almost always a **single pass with a running fold**: read the lines
> once in date order, accumulate balances, and emit a snapshot whenever a period
> boundary goes by. `O(lines)` instead of `O(points × lines)`.

Rejected alternatives, both worse: a **materialised rollup table** (invalidation
machinery for a problem one query solves) and **caching** (hides the cost rather
than removing it — and the first load is the one a user judges the product by).

**Where else to look:** any report that takes an `as_of` and might be charted
over time. A balance sheet, a trial balance, an aging snapshot, a stock
position, a running customer balance — all cumulative, all tempting to loop.

---

### 🔴 NAMED LESSON (B3, 2026-08-16): A STUB IS THE PART THAT NEEDED TESTING

**The incident.** `stagingStore.remove` was implemented for `local-fs` and was a
**silent no-op for `supabase-storage`**. Every test of the capture purge ran on
`local-fs`, because that is what a test harness naturally configures. So the
suite exercised the one backend where the code worked, and reported green about
a capability that did nothing on the backend a cloud deployment would use.

Downstream, `purgeOnce` trusted the success it was handed and deleted the
metadata row — orphaning the bytes **and destroying the only index to them**.
The tests could not have caught that either: on `local-fs` the bytes really were
gone, so deleting the row was correct.

#### The rule

> **When a capability is implemented for one backend and stubbed for the others,
> the passing tests prove nothing — because the stub is the part that needed
> testing.** Test the branch you did not write.

The cheap countermeasure is the one used here: **inject a backend that fails**
and assert on what survives. It reproduces the cloud case with no cloud, and it
is the only way the "silently does nothing" branch is ever executed.

The second countermeasure is at the interface, not the test: **a method that
cannot do the thing must throw, never return.** A no-op that reports success is
worse than an unimplemented method — the second is a gap someone will notice,
the first is a false statement the caller builds on. `StagingBackend.remove`
now raises `StagingDeleteFailed`, so the same missing implementation becomes a
loud failure instead of a quiet lie.

#### It is the same family as the SDK differential

The M12.3 ZATCA SDK differential passed byte-for-byte while the live API
rejected the QR: it proved only that **we matched a stale writer**. Both are the
same shape —

> **a test whose oracle shares the defect it is meant to detect.**

The SDK differential compared our output against a reference that was itself out
of date; the purge tests compared behaviour against the one backend that already
worked. In both cases the test agreed with the code because they were wrong
together, and in both cases the green result was read as evidence about the
thing that had never been exercised.

The general form, worth checking on any new suite: **ask what the test would
have to be measured against for a failure to show up, and whether that thing is
independent of the code under test.** A reference implementation, a second
backend, a live endpoint, a hand-computed figure — independence is the property
that makes green mean something. (Related: *external validators check the
weakest property they plausibly could* — same reason, one layer out.)

**Where else to look:** every `resolve*Store` / `get*Provider` seam in this
repo. `ArchiveStore` (`local-fs` vs `supabase-storage`), `KeyWrapper`
(`local-dev` vs `aws-kms` — and the AWS SDK is **lazily loaded**, so its branch
has never executed at all), `MailProvider`, the alerter. Each is a place where
the tested path and the deployed path can differ, and only one of them is
watched.

---

### 🔴 NAMED PATTERN (2026-08-16, after the second instance): FACTS ABOUT INTENT EXPIRE AT ENTRY

Two queue items (**B4**, **B5**) turned out to share a shape that no other item
in the pre-production queue has, and it is worth naming because the response to
it is different.

> **A fact about what the user MEANT is knowable only while they are recording
> the transaction. If the schema has no column for it, it is not "missing" — it
> is DESTROYED, and no migration, backfill or later care recovers it.**

**B4 — `invoice_payments`.** A payment writes `invoices.paid_amount` (a running
total) and `invoices.paid_at` (only the LAST payment's date). A second partial
payment overwrites the first one's date and leaves no trace of it. The GL keeps
the movement; nothing ties it to the instalment.

**B5 — a transfer's destination.** `transactions.bank_account_id` records which
account a transfer LEFT. There is no destination field. So "money between two of
my own accounts" (total cash unchanged) and "money that left the tracked estate"
(total cash fell) are the same row, and only the person who entered it knows
which.

#### Why this is a different KIND of queue item

Every other entry in the pre-production queue describes a **state**: a missing
guard, an unverified assumption, an unwired alarm. States wait. You can fix
them in any order, and the cost of waiting is risk, not loss.

These describe **information**, and it is being destroyed at a rate proportional
to use. Waiting does not preserve the option to fix it later — it removes the
option, one transaction at a time. The distinction matters because the queue's
own framing ("nothing here blocks ordinary platform work") is true of every
other item and **false of these two**.

#### The rule

> **When a column stores a RESULT where the user knew a REASON, ask what the
> reason was and whether it is recoverable. If it is not, the schema change is
> urgent in a way that has nothing to do with how important the feature is.**

Search shape for a third instance — a running total that replaced its own
history, a status that replaced the event that set it, a classification that
replaced the choice behind it, a "kind" that names a category but not the
distinction WITHIN it that changes the accounting.

**Why it is cheap right now, and only right now:** §2's standing note — there
are no customers, so schema changes carry no migration burden and no one to
notify. That note was written to justify *renames and reversals*. It applies
with far more force here, because the alternative is not a harder migration
later; it is no migration at all.

---

### 🔴 NAMED LESSON (2026-08-16): COST AN OPTION AFTER VERIFYING ITS INPUTS EXIST

While presenting cash-ownership options I offered a lean — *"the GL owns cash,
with transfers posting through a contra account"* — and costed it as moderate:
a migration, a change to the posting path, a rewrite of one report.

Costing it properly meant reading the posting service, which says plainly why
transfers do not post: *"a transfer between own accounts is Dr Cash / Cr Cash
under a single cash account — a no-op that would only add noise."* Correct — for
an own-account transfer. And then the question that had not been asked: **how
does the platform know it is an own-account transfer?** It does not. There is no
destination field (B5).

So the recommended option, built on the data that exists, would have created a
clearing balance for **every** transfer — including the genuinely internal ones
it was specifically designed to leave alone. The estimate was not slightly low.
It was **an estimate of a different feature**.

#### The rule

> **Before recommending an approach, name the inputs it consumes and grep for
> each one.** Standing-check part 2 asks whether every field a MILESTONE depends
> on has a real writer. The same question belongs on a PROPOSAL, before the
> number attached to it becomes the thing being compared.

An option's cost is only meaningful relative to inputs that exist. A lean stated
before that check is a preference, not a recommendation — and it will be read as
a recommendation.

---

### 🔴 M20.0 (2026-08-16): A REMOVED DEFAULT IS AN INVARIANT — CHECK EVERY WRITER, NOT THE LAYER THAT DEFINED IT

Migration 0044 dropped `fiscal_year_start`'s `NOT NULL DEFAULT 1` and NULLed
every row, so "undeclared" became a first-class state. Complete at the schema —
and one layer up, Company Settings' submit still read:

```ts
fiscalYearStart: Number(form.fiscalYearStart ?? 1),
```

So an undeclared tenant saving their **address** would have silently declared a
January fiscal year. The migration fixed one layer; another kept re-creating
the fiction on the next save, and everything downstream (the resolver, M20.1's
report defaults) would have read the re-created value as a tenant's deliberate
choice.

This is the write-boundary lesson wearing a new costume: the invariant ("no
January unless declared") lived in the schema while a second path could still
set the value. A default is not only a DDL clause — **a default lives wherever
any writer supplies a fallback**, and each `?? 1`, `|| 1`, `.default(1)` or
form-initialiser is a write path for it.

#### The rule

> **After removing a default, grep for the VALUE, not just the column.** The
> DDL default is one writer among several; UI coercions, Zod `.default()`s,
> service fallbacks and seed values are the others, and any one of them
> re-asserts what the migration removed. The search shape: the column name AND
> the old default value, across every layer that can reach the write path.

#### And the countermeasure that DID fire, recorded because they mostly get recorded when they fail

Standing-check part 6 ("grep for tests asserting the old behaviour") caught the
suite's first test pinning *"a fresh company defaults to a Gregorian January
year — the behaviour every existing tenant already had"* — a correct-when-
written assertion that had become a guard for the defect. It was rewritten to
pin the opposite **before** it could fail confusingly in CI or, worse, pressure
the new behaviour back toward the old one. The checks earn their keep on the
runs where nothing goes wrong BECAUSE they ran; noting only their misses would
be survivorship in reverse.

---

### 🔴 THE FLAKE INVESTIGATION (2026-08-17): AN UNSCOPED WRITE IN A TEST IS A WRITE INTO EVERY PARALLEL SUITE — CAUGHT IN THE ACT, NOT INFERRED

The M20.1 commit noted two intermittent test failures "creeping up" and named
two tests. Three full runs reproduced three DIFFERENT flakes — none of them
the named two — which was the finding: the class is *any suite driving a
platform-global path against the shared test database*, and its frequency
crept because every added suite raises both collision probability and load.
Full mechanics: `docs/test-suite-notes.md` fragilities #4/#5; fixed in PR #49
by applying the outbox worker's `organizationId` escape hatch uniformly.

#### The loudest instance (owner-flagged): the only unscoped write in the tree

`alerting.test.ts`'s "quiet platform" test made the whole DATABASE quiet:

```ts
await pool.query(`UPDATE einvoice_documents SET status = 'accepted'
                   WHERE status IN ('pending','failed','submitting')`);
```

No `organization_id` filter — the **only** unscoped write in the entire test
directory (every other test write is org- or id-scoped), and it flipped
parallel suites' freshly-approved `pending` documents mid-assertion. That IS
the einvoice-enqueue flake the M20.1 commit named, established by catching
the actor in the act rather than by inference. Two lessons carried forward:

> **A test may not run an unscoped read OR write against a shared table.**
> A count-sensitive assertion (`toHaveLength`, `toBe(1)`) against a global
> listing is a claim about the whole database, which no suite controls.

> **One unscoped write took three full runs to catch in the act** — and it
> had sat in the tree since B2. The countermeasure is the grep, not the
> reproduction: `UPDATE|DELETE` in `src/tests/**` without an
> `organization_id` predicate is reviewable in seconds.

#### And flake #1: B3's exact disease, reachable by a SECOND ROUTE (owner-flagged — remember this when trusting B3's fix)

The capture-purge flake was not a new failure mode. A parallel suite's
promotion pass swept the staged-leftover backlog **globally**, resolved the
relative `staging_path` under ITS OWN storage root (each fork mounts its own
`ZATCA_ARCHIVE_DIR`), found nothing there, and `rm(path, { force: true })`
reported success — so it **nulled the pointer while the bytes survived**
under the owning suite's root. That is byte-for-byte the B3 defect: a delete
that reports success without the bytes being gone, followed by destruction of
the only index to them.

B3's fix hardened one route to that state (a backend that cannot delete now
throws). The test topology built a SECOND route: a deleter whose root simply
does not contain the file, to whom "missing" is honestly "already gone".
`force: true` is CORRECT for a single-rooted deployment — but any future
topology where two processes with different storage roots share the
`captured_documents` table (horizontal scaling on `local-fs`, a
staging/production split against one database) re-creates the orphaning
without any code being wrong in isolation. The invariant "a nulled
staging_path means the bytes are gone" is only as strong as the assumption
that every sweeper sees the same filesystem — that assumption is now stated
here rather than being silent, and the org-scoping fix removes the only
in-repo violator (the test fleet).

---

### 🔴 F7-CMP (2026-08-17): A #9 INSTANCE PREVENTED AT DESIGN TIME — THE COMPARISON CREATED A NEW PLACE FOR TWO SOURCES TO ANSWER ONE QUESTION

Meta-finding #9's shape: two stores answering the same question with
different figures, side by side, with nothing saying so (the 0.00-expenses
income statement beside the 45,063.25 dashboard). Flaw #1 closed the
original by making acceptance POST to the ledger — but the income statement
kept its transactions FALLBACK for windows with zero journal lines, and that
fallback reports **gross incl. VAT** where the journal path reports net.

Prior-period comparison (F7) put those two sources one table apart: the
CURRENT window answering from journal entries while the PRIOR window — old
enough to predate posting, or simply empty of entries — answers from the
fallback. Two incommensurable figures in one comparison row, invisibly. The
fourth costume, had it shipped.

**The countermeasure is a refusal, not a reconciliation:** the response
already carries `source`, and the comparison REFUSES with a stated reason
("the two periods answered from different sources") whenever the windows'
sources differ. Owner-flagged for the record: when a feature juxtaposes two
figures, ask what SOURCE each answers from — a comparison is a new
consumer of the old two-sources problem, and every new juxtaposition
re-opens it. Corollary applied in the same milestone: the two windows'
line-merge joins on a response-carried KEY (account id), never the display
name — a name join breaks silently on a rename, and the two id spaces
(journal path keys by account, fallback keys by category) never meet
precisely BECAUSE mismatched sources refuse before merging.

---

### 🔴 A (2026-08-17): EVERY REVERSAL DOUBLE-NEGATED IN EVERY REPORT — TWO CANCELLATION MECHANISMS, EACH ASSUMING IT WAS THE ONLY ONE

Found while building A (GL owns cash), live on the dev org: `reverse()` does
TWO things — it posts a mirror entry (debits and credits swapped) AND flips
the original's status to `reversed`. Every report filtered journal entries to
`status = 'posted'`. So a reversed entry's effect VANISHED (original
excluded) while its mirror's opposite effect REMAINED (mirror included):
each reversal moved every aggregate by −2× the original, net −1× after the
re-post that usually follows. Observed: the one M16.2-era Tamara repost left
the dev org's books off by **CASH −8,750 / SUSPENSE +8,750** — sitting
inside M19.7's measured 10,800 "gap" and misattributed to the
transfers-never-post story.

The shape is two id-spaces wearing a new costume: **two cancellation
mechanisms, each sufficient alone, each built assuming it was the only
one.** The mirror entry cancels by ARITHMETIC (both sides in the books sum
to zero); the status flip cancels by EXCLUSION. Either alone is correct.
Both together double-cancel — and nothing forced them to agree, because the
writer (`reverse()`) and the readers (nine report filters across two
repositories) were changed at different times by different milestones.

**The fix:** `'reversed'` is a MARKER that a cancelling twin exists, not an
eraser — the original entry HAPPENED. Reports now read
`status IN ('posted','reversed')` (`JE_IN_BOOKS`, exported from
reports.repository with the incident recorded beside it); only drafts are
not the books. Nine filter sites swept across reports and analytics
repositories.

**Why no test caught it:** the flaw-#1 suite asserted the P&L after a
reverse-and-repost — and the P&L was RIGHT, because the double-negation
landed in the two balance-sheet accounts (cash and suspense) the edit moved
between, which no assertion covered. The `balanced()` check passed too:
double-entry stays balanced when you delete a balanced entry. A defect can
sit exactly in the blind spot between "the figure we asserted" and "the
invariant we asserted" — the new transfer tests assert the ACCOUNT BALANCES
on both sides of a reversal, which is the assertion that would have caught
this.

#### 🔴 THE NAMED SHAPE (owner-flagged, 2026-08-17): TWO CORRECT ASSERTIONS WITH A GAP BETWEEN THEM

This is a different failure class from a missing assertion, and it is **not
caught by adding more of either kind.** The suite asserted a FIGURE (the
P&L, at the top of the aggregation) and an INVARIANT (debits = credits, at
the bottom). Both were correct; both stayed green for months. The defect
lived in the middle layer neither speaks about — WHICH accounts hold the
value — and every reversal moved 8,750 through that blind spot in every
report.

More figure-assertions would not have helped (the figures asserted were the
ones that stayed right); more invariant-assertions would not have helped
(the invariant genuinely held). What catches this class is an assertion at
the INTERMEDIATE grain: when an operation moves value BETWEEN accounts,
assert the balance of BOTH accounts, before and after. The gap between a
top-line figure and a bottom-line invariant is exactly the space where a
conservation law can hold while the conserved thing is in the wrong place.

### 🔴 SECURITY FINDING (MED validation pass, 2026-08-23): FK CHECKS RUN OUTSIDE RLS — A CROSS-TENANT REFERENCE PLUS AN EXISTENCE ORACLE

Queued as a validation MED ("nonexistent customerId → raw FK 500"), it grew
into a security finding while being fixed, and the owner directed it be
recorded as one: **Postgres evaluates foreign-key constraints with the
referenced table owner's privileges, so RLS policies do not apply to the
check.** `invoices.customer_id → customers(id)` is a plain FK with no
organization component, which meant two things at once:

1. **A tenant could CREATE an invoice referencing ANOTHER tenant's customer
   row, and the database accepted it.** Reads stayed org-scoped, so the
   foreign name never rendered — but the reference existed, and a business
   row in tenant A pointing at identity data in tenant B is a tenant-isolation
   violation regardless of what the UI shows.
2. **The 23503-vs-success difference was an existence oracle**: probing
   sequential ids revealed which ids exist anywhere on the platform.

The same shape held for `bills.vendor_id`, quotations, purchase orders,
`transactions.category_id`, and the bank-account references. **This is the
RLS blind spot's sibling, in a place nobody was looking** (the owner's
framing): the 2026-08-20 audit swept RLS *policy* coverage and found it
whole, but an FK is not a query — it is a constraint check that RLS never
sees, so policy coverage cannot catch it.

**The fix** (PR #75): tenant-scoped existence pre-checks through the RLS
repositories before every insert/update that takes a reference id — under
RLS, "missing" and "another tenant's" are the same fact, so both refuse with
the identical 422 `reference_not_found` and the oracle closes with the
reference hole. The cross-tenant case is pinned by a test that first proves
the foreign row exists (so the refusal is demonstrably tenant scoping, not
absence).

**The reusable rule: every plain FK from a tenant-scoped table is a
cross-tenant edge the moment the referenced table is also tenant-scoped —
RLS does not guard it; only a scoped lookup (or a composite
`(organization_id, id)` FK) does.** When auditing isolation, enumerate the
FKs, not just the queries.

### 🔴 AI-2 (2026-08-23): THE CORPUS RULE EARNING ITS KEEP — NINE CASES TALKING, AND 28 "HARD" FLAGS THAT WERE NOT

Two findings from expanding the benchmark corpus to measuring size, recorded
plainly (owner's framing):

1. **"gpt-oss-20b decisively ahead on Arabic" was nine cases talking.** At
   9 hard AR cases, 20b scored 100% vs 120b's 78%; at 30 equal-N cases per
   language the order flipped (120b 83%, 20b 77%). The §12g constraint —
   no model-selection decision may cite numbers a single case can reorder —
   predicted exactly this, and the reversal is the evidence it was right,
   not a new leaderboard fact (both models are strong; the margin is two
   cases).
2. **28 authored-hard cases were not hard.** The `hard` flag ("the engine is
   not expected to solve this alone") was authored by judgment, and the
   engine solved 28 of them at ≥0.65 confidence — six from the ORIGINAL
   AI-1b corpus. Each one padded the hard-only baseline the §2a gate reads,
   and a high-confidence engine hit never reaches the LLM, so it measured
   nothing at all.

Both are the same lesson: **a claim inside a measuring instrument is still a
claim, and if it is checkable it must be checked.** Both are now enforced by
`tests/benchmark-corpus.test.ts` (no engine-solved hard flag, no
non-emittable expected label, ≥30 hard per language, en/ar equal-N) — the
flag became a measured fact, and the corpus cannot quietly shrink back to
where single cases decide verdicts. Corollary kept from the same pass: flags
are set by measurement, but cases are never REWORDED until the engine fails
them — that would be authoring from the engine, the inversion the corpus
header forbids.

### 🔴 NAMED LESSON (2026-08-24, recorded at the owner's instruction, about the owner's own message): AN INSTRUCTION CAN BE CONFIDENTLY WRONG IN EXACTLY THE SHAPE THE CODEBASE KEEPS PRODUCING

The owner sent a work order for "Milestone 1 — GOSI, with the recovery path,"
answering an unmapped-code (a)/(b) question — decisions plausible,
self-consistent, phrased in the project's own vocabulary, and **grounded in
nothing**: no such milestone had been proposed, no such question asked, and
the data held no wrong GOSI rows (checked: 2 rows, both `O`, no VAT, already
the C11-verified state). The owner had answered a plan that did not exist.

What made it dangerous is what makes every instance of this family
dangerous: it did not look wrong. It looked like the next task. Building it
would have manufactured a "correction" for a defect that was never there —
the COST-AN-OPTION-BEFORE-VERIFYING-ITS-INPUTS failure, arriving as an
instruction instead of a proposal.

**The rule, set by the owner about their own messages: check the referent
against the data before building, and keep that response even when the
instruction comes from the owner.** An instruction's referent is an input
like any other — grep for it. The stop that caught this one was nothing
clever: the milestone name matched no record, so the data was queried before
any code was written, and the mismatch was reported instead of papered over.

Two standing policies from the same exchange, kept because they are right
regardless of the phantom that carried them:

1. **A correction ships narrow and scoped, never as a general re-run tool** —
   a tenant discovering wrong VAT cannot run a script, and a correction with
   no recovery path for the rows it obsoletes is correct-but-not-connected.
2. **A named gap that stays gapped beats a silent default** — recording a
   wrong-but-flagged value ("assumed E") places a wrong treatment in the
   ledger under a label that ages into being trusted; reporting the gap
   keeps it a question until something real answers it.

### 🔴 NAMED LESSON (AI-3b, 2026-08-24, owner-named): A VERIFICATION IS A CLAIM ABOUT A MOMENT, NOT A PROPERTY OF THE TEXT

AI-3b verifies that a model-written explanation introduces no fact the
finding does not carry. The verification is real — and it is dated the
instant it passes: findings REFRESH their facts on every run, so an
explanation verified against yesterday's facts can state a number that is
no longer true. **Nothing about the text changed. The text became a lie
anyway.**

The mechanism that catches it: the explanation stores a hash of the facts
it was verified against, and the API returns it ONLY while the hash matches
the current facts. A facts refresh silently withholds the explanation until
regeneration — no stale prose ever renders as current.

**The general form, worth carrying beyond AI-3b:** any cached artifact that
was VALIDATED against state — an explanation against facts, a benchmark
verdict against a corpus, a compliance check against a configuration — is
valid only while that state holds. Store the identity of what it was
checked against, and gate rendering on the match; a validation without a
binding to its inputs ages into a false credential. (Family resemblance:
the obsolete-assertion lesson — a test correct when written certifying a
defect later — is the same decay, in the test suite instead of the cache.)

### 🔴 NAMED PATTERN (AI-6a, 2026-08-24, owner-named): MAKE THE WRONG THING INEXPRESSIBLE, NOT FORBIDDEN

The owner asked for a projection's assumption to appear in the sentence
rather than a footnote. What shipped is stronger: the assumption sentences
are part of the TOOL'S OUTPUT, and the verifier REJECTS any answer that
uses the tool's numbers without both of them verbatim — with a test proving
the refusal on the same correct numbers minus the sentence. A skippable
assumption is not discouraged; it is UNREPRESENTABLE as a delivered answer.

The owner named the pattern: **make-it-inexpressible beats a rule someone
must remember.** The codebase already carries instances that predate the
name — the conversion axis DERIVED from line quantities so "approved AND
partially converted" needs no status string that could lie (M21.1); the
liquidity severity TYPE with no "fail" level so no UI can render a verdict
(M18.3); `ArchiveStore` without a `delete` method (M12.8); the receivables
bridge as an identity that is structural, not checked (M19.6). The
generalisation: when a rule matters, look for the representation in which
violating it is not a caught mistake but a THING THAT CANNOT BE SAID —
enforcement by construction outlives enforcement by review, and it is the
only kind that binds code not yet written.

---

## 2026-08-28 — THE SCALE-AND-COLLISION SWEEP (S-1 … S-4), and the class it indicts

**The one-line rule is in `CLAUDE.md` §3.** This is the incident.

### The premise, which is the reusable part

Every fixture, dev org and sample seed in this repository is **small** and
carries **unique** values. That is not a gap in any one test; it is a property
of the whole verification approach, and it makes two entire families of defect
unobservable no matter how carefully anyone reads the code:

- **(a) VOLUME.** At fixture scale a capped answer and the true answer are the
  same number. B6 named this in 2026-08-27 and fixed two instances; the class
  was larger than the two.
- **(b) COLLISION.** Every fixture gives its rows distinct amounts, so an
  identity built from `(date, amount, description)` or `(customer, amount,
  date)` looks unique forever. In a real month it is not: two invoices to the
  same customer for the same amount on the same day is ordinary, and so is a
  bank statement listing the same SAR 45.00 charge twice.

Both appear the month a tenant gets busy — the worst possible moment.

🔴 **A suspiciously ROUND count is a diagnosis, not a coincidence.** A figure of
exactly 500, exactly 200, exactly 100 is the shape of a cap, not the shape of
data. Two of the four findings below were located by that single question, and
the re-injection runs print it back: `expected 500 to be 537`.

### S-1 — statement ingest dropped genuinely repeated lines (COLLISION, money path)

`transactionsRepository.existsIdentical` asked *does an identical row exist?* on
`(date, description, amount, type, bankAccountId)`. Existence is the wrong
question: that tuple is not an identity. The check could not distinguish

  1. "you re-uploaded the same statement" (skip is right), from
  2. "your business genuinely paid that twice today" (skip loses money),

and it answered both with skip. The second real charge never reached the books:
**the expense and its input VAT were understated by exactly that amount**, and
the transaction never appeared for review, categorisation or VAT treatment.

🔴 **This was known and mitigated with something that had no consumer.** The
comment above `duplicates` in `transactions.service` already named the
conflation, and the mitigation shipped at the time was to RETURN the skipped
rows "so the user can see WHAT was dropped and re-enter a genuine second
payment". Checked: `duplicates` has **zero references in `apps/web`**. So the
mitigation was a shape without a consumer, and the loss stayed silent — a fix
that reads as thorough in the diff and does nothing in the product. Worse, its
existence is presumably why the real fix was never made.

🔴 **A test asserted the defect.** `ingest-correctness.test.ts` had a case whose
own words were "two real parking fees on one day" and which then asserted that
only ONE was inserted. Not the ordinary obsolete-assertion shape (correct when
written, overtaken later) — it pinned a known loss from the day it was written,
because the returned-rows mitigation was accepted as the fix.

**Fixed by MULTIPLICITY, not existence:** `countIdentical` returns how many
identical rows the account already holds; the upload reads that once per
distinct key (before it inserts anything), counts occurrences within the file,
and imports the difference. A re-upload imports nothing; a genuinely repeated
line imports every copy.

🔴 **The trade, chosen on which error is RECOVERABLE rather than which is
rarer.** Multiplicity trusts the file's own count, so a sloppy re-export that
lists one line twice (in two spellings that normalise to the same row) now
imports a spurious second copy. That direction is caught twice over: the rows
land in `pending_review` where a human sees them before anything posts, and the
existing `duplicate_transaction` finding keys on exactly `(date, amount,
description)`. The old direction — dropping a real charge — was caught by
nothing. One error is visible to two mechanisms we already own; the other is
visible to none.

### S-2 — bulk accept understated its own blast radius (VOLUME, money path)

The review page's button read ``Accept ready (${ready.length})`` where `ready`
was filtered from the rows on screen — and `pendingReview` is capped at 200
because it feeds a screen. The click then called `POST /transactions/review/accept`
with **no ids**, which is bulk mode: the server accepts every safe pending row
in the tenant, and acceptance **POSTS TO THE LEDGER** (flaw #1, Option A).

So a tenant with 5,000 pending rows read "183" on the button and one click
posted all of them. The label was not merely inaccurate; it understated the
reach of an accounting act by an unbounded factor, and it did so precisely when
the tenant was busiest.

**Fixed** with `GET /transactions/review/counts` (spec-first, then codegen) —
`total` / `needsAttention` / `ready`, all counted in SQL — which the button now
reads. When the click reaches past the visible page a confirm names the number,
says the rows are not on screen, and says that accepting posts to the ledger.
🔴 That confirm does not violate the M16 principle that *accepting the match IS
the review*: a second confirmation of what the user just reviewed is a design
defect, but rows beyond the page were never reviewed, so naming them is not a
second confirmation — it is the first mention. The disabled state also moved to
the true count: every visible row needing attention does not mean nothing is
ready beyond the page.

### S-3 — the outbox alarm paged "500 document(s)" forever (VOLUME)

`alarms.service` outbox-overdue took its count from
`listOverdue(…, 500).length`, so any backlog past 500 paged the words "500
document(s) unsubmitted" — however bad it got, and in the `context` payload too.
This is the alarm that watches ZATCA's 24-hour reporting deadline, where
under-reporting is the exact failure it exists to prevent: **quiet neglect
(queue B2) wearing the costume of a working alarm.**

**Fixed** with `countOverdue` (which already existed — B6 added it for the
operator dashboard); the capped page is still fetched, but only for the oldest
row's age.

### S-4 — the operator dashboard's needsReview saturated at 500 (VOLUME)

`operatorZatca.health()` reported `listNeedingReview(500).length` — sitting two
lines below the `overdue.total` that B6 had just fixed for exactly this reason,
inside the same `Promise.all`. **"Green fixes the case, not the class",
demonstrated within a single function.** Fixed with a new `countNeedingReview`.

### CHECKED AND ABSENT — AR aging does not double or collapse on colliding documents

The sweep's opening hypothesis was that two invoices to the same customer, same
amount, same day would double the AR aging total. **It does not**, and the claim
carries its search shape:

- `arAging` is the only AR aging path (`grep arAging|ar-aging` across the API;
  one service, one controller, one route, one page — the page renders the
  server's total and computes none of its own).
- Its input is `invoicesWithCustomer`, a LEFT JOIN on `customers.id` — a join
  on a unique key cannot multiply rows.
- Its internal `creditedByOriginal` map is keyed on `originalInvoiceId`, also
  unique.
- The bucket totals accumulate once per row, and `total` is their sum.

What would have falsified it: a join on a non-unique column, a `Map`/`Set` keyed
on a value tuple, or a client-side re-aggregation. None exists. It is now a
standing measurement rather than a reading — `tests/scale-and-collision.test.ts`
builds three identical approved invoices, asserts the total is 3× (neither 1×
nor 6×), asserts three individually-reachable items, and does the same for AP.

🔴 Recorded because the absence is the finding: this went into the sweep as a
premise stated with specifics, and it was checked against the data before any
code was written (§3, *an instruction's referent is an input*). The two defects
that WERE real — S-1 and S-2 — were found by looking for the SHAPE the premise
described, not the location it named.

### The countermeasure — `tests/scale-and-collision.test.ts`

A fixture large enough to exceed every cap it touches **and** deliberately
degenerate in its values: 237 pending transactions against a 200 cap, 537 outbox
documents against a 500 cap, three identical invoices, three identical bills, a
statement line repeated three times. Every cap is a named constant so an
assertion can say *not the cap*, and every group has an anti-vacuity test
proving the fixture really is oversized or really does collide.

**A test that cannot fail on small data is not testing the property**, and until
this file every test we had was small.

Two disciplines the file records in place, because both were nearly got wrong
while writing it:

1. **Assert the thing that was broken, not the thing beneath it.** The first
   draft asserted `countOverdue` and `countNeedingReview` — both of which were
   already correct, so both tests would have passed against the broken alarm and
   the broken dashboard. What was broken is *which of two numbers the caller
   chose*, so the assertions now run through `alarmsService.runOnce` (capturing
   the paged payload via `__setAlerterForTests`) and `operatorZatcaService.health()`.
2. **State the limit rather than implying coverage.** Nothing here proves the
   BUTTON renders the count it now fetches — no test in this suite renders a
   page. The endpoint is pinned; the binding from endpoint to label is verified
   by reading only, and the test says so.

**Verified by re-injection**, each defect restored one at a time: the ingest
existence check (`expected 2 to be 3` on the ledger), the alarm's page count
(`expected 500 to be 537`), the dashboard's page count (`expected 500 to be
greater than or equal to 537`). Full suite after the fixes: **102 files passed,
1 skipped, exit 0.**

### One process note

`single-currency-migration-refusal.test.ts` resolves its migration file from
`process.cwd()`, so it fails when vitest is invoked from the repo root with
`--root apps/api` (it looks for `C:\Users\packages\db\…`). It passes from the
package directory. Not a defect in the code under test — but it is one more
place where a test's verdict depends on how it was launched, and the §10b rule
applies: find out which number carries the verdict before trusting any of them.

---

## 2026-08-28 — THE FLOW AUDIT (capture, findings, quotations, POs, closed months, permissions, Arabic)

The nine findings and their severities are in `CLAUDE.md` §5. This is the method,
the evidence, and the three things the audit says about the process.

### Method

For each flow: (1) every hand-written `apiFetch<T>` in the page compared field by
field against the service that answers it; (2) every mounted route in the domain
grepped for a caller **by verb, not by prefix**; (3) every derived field traced
back to whether the endpoint that serves it loads the data it derives from.

Step (3) is the one that found the most, and it is new. It exists because of the
QA audit's GL-list defect — `(lines ?? [])` making absence look like zero — which
is not a shape mismatch and not an unreachable route. It is a **third** way for a
correct backend to lie: a presenter given less than it thinks it has.

### AUD-1 and AUD-2 — the same escape hatch, twice

Both HIGH findings run through one line in `invoicesService.create`:

```
if (!String(invData.invoiceNumber ?? "").trim()) invData.invoiceNumber = await allocate(...)
```

C12 established from the primary text that a company must run **one** sequence
covering invoices AND notes, that multiple concurrent sequences are a Prohibited
Functionality, and that the browser must not mint numbers. It then fixed the
allocator, removed the mint from `Invoices.tsx`, and kept a caller-supplied number
"for legacy imports". That escape hatch is now used by two ordinary product paths:

- **`CreditNotes.tsx`** always sends `CN-{Date.now().slice(-6)}` (or `DN-`), so
  every credit and debit note is outside the company sequence. That is the second
  series the Resolution prohibits, created by the product's own UI. The suffix is
  the last six digits of a millisecond clock, so it wraps every ~16.7 minutes and
  two notes at an exact multiple collide on `UNIQUE(company_id, invoice_number)`.
- **`Invoices.tsx`'s "make recurring"** writes `invoiceNumber: "REC-<number>"`
  into the rule template, and `generation.service` spreads the template into
  `create`. Run 1 succeeds. Run 2 reuses the same literal number and violates the
  unique index, so the rule fails every month thereafter.

🔴 **What this says about how C12 was verified.** C12 was an exemplary piece of
work — primary texts read, the delegation chain followed, a defect found that the
code review had missed. And it checked the **allocator**, not the **callers**. The
standing check's part 2 asks "does every field have a production writer"; nobody
asked the inverse question, *which writers can bypass the one I just built*. For a
rule enforced by "we always call the allocator", the callers ARE the enforcement,
and there were three of them.

The general form is already in §3 — *enforce invariants at the write boundary, not
in one path* — and this is what ignoring it costs: the boundary here is
`create`, which HAS the rule and also has an escape hatch, so the invariant is
enforced only for callers who opt in. An invariant with an opt-out is a
convention.

### AUD-3 — a presenter reasoning about the wrong empty

`conversionState(items)` carries a careful comment: *"A quotation with no lines is
`open` — there is nothing to convert, and calling that 'converted' would be a
confident wrong answer."* Correct, and about a quotation that genuinely has no
lines. The LIST endpoint passes no lines because it **does not load them**, and
those two emptinesses mean opposite things.

Measured directly (`[AUDIT] detail=converted list=open`): a fully converted
quotation reads "Open" in the list, and the list offers **Convert to invoice** on
it. The server refuses the conversion with a 409, so no wrong document is
produced — the damage is that the list states a commitment's status wrongly, and
invites an act it will then refuse.

🔴 The existing test asserts `conversionState` through `getById`, where items are
loaded — **the derivation is proven in exactly the place the defect cannot
occur.** The narrower-claim family, one level down: not a suite whose fixtures are
too narrow, but a suite that measures a function through the caller that feeds it
properly while a second caller starves it.

### AUD-4, AUD-5, AUD-6 — three unreachable capabilities, one blind guard

`PATCH /quotations/:id`, `PATCH /purchase-orders/:id`, `POST /capture/:id/discard`,
and both entities' `send-back` / `reject` have no caller in `apps/web`. Each was
built deliberately and tested: M21.2's edit path reconciles line ids specifically
so a converted line survives an edit, and both freeze-rule guards were verified by
re-injection; B3's discard deletes the image immediately *because* reporting a
deletion that did not happen was half of that defect.

All of it is unreachable, and `tests/route-reachability.test.ts` is green, because
it matches the **prefix**: `/quotations` and `/capture` are referenced many times.
This is the fourth defect of exactly this shape (the QA audit's bill edit was the
third), and the guard has now missed all four for the same reason. The guard's own
documented blind spot is generated hooks; the verb is a second one, and it is the
one that keeps costing.

🔴 AUD-5 is also the sharp end of C8: the erasure path we built for photographed
third-party documents is the one nobody can reach.

### AUD-7 and AUD-8 — the surfaces nobody demos

The UI offering what the API refuses (Acknowledge to a bookkeeper, Approve to a
non-approver) is the converse of D4's rule, which was written one way round only.
Since B2 the refusal at least appears as a toast; before it, the button did
nothing at all.

`ScanReview` and `Approvals` are substantially English-only while Arabic is a
stated LAUNCH requirement — including account names inside `ScanReview`'s journal
preview, which is the moment a user is asked to confirm a posting. Both pages were
shipped as deliberately minimal and never revisited. Nothing counts translation
coverage, and nothing renders a page.

### The three process observations

1. **A verification's scope is the thing to record, not its verdict.** C12
   verified the law and the allocator. Both verdicts still hold. What was never
   written down is that the verification did not extend to the callers — so a
   later reader (and a later session) inherits "invoice numbering: verified" with
   no way to see the edge of it.
2. **The route guard's prefix matching has now missed four defects of one shape.**
   It should compare method+path against what the client actually calls, or it
   should say plainly in its own output that it cannot see verbs. Today it reports
   coverage it does not have.
3. **Every finding above was invisible to code reading and visible in seconds of
   use** — except AUD-2, which needs a *month* of use, and is therefore the one a
   browser pass would also have missed. Volume, collision, and now *time* are the
   three axes our fixtures collapse.

---

## 2026-08-28 — TWO LESSONS THE OWNER NAMED, recorded at their instruction

### 1. A destructive act's scope must match what the user can see

Named while triaging S-2: *"a user accepts what looks like one transaction and
posts two — that's not a display bug, it's a destructive action whose scope
doesn't match what the user sees, same family as 'delete all' deleting fifty."*

The framing is the useful part. Read as a labelling bug, the fix is "make the
number accurate" and you are done. Read as an **authority** bug, the fix is
different and larger: the user consented to the set in front of them, so the
system may not act on a set they were never shown, and any gap between the two
is a defect **in the act**, not in the label. That is why S-2's fix is not only
the true count in the button but a confirm that appears exactly when the click
reaches past the visible page, naming the number, saying the rows are not on
screen, and saying that accepting posts to the ledger.

🔴 It also reconciles with the M16 principle that *accepting the match IS the
review* — a second confirmation of what the user just reviewed is a design
defect, but rows beyond the page were never reviewed, so naming them is not a
second confirmation, it is the first mention.

The display half of the same family is a surface that collapses two real rows
into one: consent to the one silently becomes consent to both. That is what
made S-1 and S-2 one finding in the owner's reading, even though in this
codebase they turned out to be two mechanisms in two files.

### 2. An owner's MECHANISM for a bug is an input, and can be confidently wrong

S-3 was reported twice, each time with specifics:

- first as **"two invoices to the same customer for the same amount on the same
  day doubles the AR aging total"**;
- then, after that was checked and reported absent, as **"the actual bug is
  `Map.set` overwriting, so AR aging silently drops an invoice — under-reporting,
  not over-reporting."**

Neither exists. Checked behaviourally, not by reading: three identical approved
invoices produce three aging items and exactly 3× the amount
(`tests/scale-and-collision.test.ts`), so nothing doubles and nothing is dropped.
Checked structurally for the second mechanism specifically: the only `Map` in
that path (`creditedByOriginal`) is keyed on `originalInvoiceId` and accumulates
with `+`, and a sweep of every `.set(` in the money-path services found none that
overwrites on collision — each one accumulates, pushes into an array, or is keyed
on a row id.

🔴 **Why this belongs in the record.** Building to either version would have
replaced a correct answer with a differently-wrong one — and unlike an ordinary
bug, it would have shipped wearing a fix's credibility, with a test written to
lock it in. The owner's own note on the first correction is the sharpest
statement of it: *"the wrong version would have been fixed to produce a different
wrong number."*

🔴 **And why the instinct was still worth following.** The SHAPE the report
described — a value collision in a money path, invisible to unique-valued
fixtures — was real, twice, two files away (S-1's ingest dedupe, and the
`duplicate_transaction` finding that keys on the same tuple). Take the shape,
check the mechanism, report the mismatch. An owner pointing at the wrong file is
still pointing at something.

**Prior instances of the same class** (an instruction confidently wrong in its
referent, corrected rather than built to):

| Date | The instruction | What was true |
| --- | --- | --- |
| 2026-08-24 | A work order for a milestone, in the project's own vocabulary | The milestone did not exist; the owner had answered a plan nobody proposed. Caught because the name matched no record, so the data was queried before any code. |
| 2026-08-28 | S-3 as double-counting in AR aging | One aging path, joined on customer id; totals correct. Nothing doubles. |
| 2026-08-28 | S-3 as a `Map.set` overwrite dropping an invoice | No overwriting `.set` in any money path; three colliding invoices produce three rows. |
| 2026-08-30 | A description of "our" ADR practice and architecture, pasted in as ours | **A different system entirely.** The give-away was not the missing `docs/adr/` — absence is weak evidence, since a directory we never created and one we deleted look identical. It was **`resolveTenant`**: the description assumed subdomain-per-tenant routing, and this platform resolves the tenant from the SESSION and offers an org switcher. Those are architecturally incompatible, so it could not be a decision we made and forgot. The source turned out to be someone else's prompt, pasted by mistake. |

The countermeasure is unchanged and is already §3's rule — *an instruction's
referent is an input, check it against the data* — extended by this session to
cover the instruction's **mechanism**, not only its subject.

🔴 **What the 2026-08-30 row adds: prefer POSITIVE contradicting evidence to
absence.** The instinct on a mismatched referent is to report what is missing,
and missing things are the weakest evidence available — a file we never wrote
and a file we deleted look the same. What actually settled this one was a fact
PRESENT in the code that could not coexist with the claim: session-scoped
tenancy with an org switcher cannot be reconciled with subdomain-per-tenant.
Owner, on being shown both: *"the `resolveTenant` evidence settles it better
than the missing files do."*

**And the value survived the referent being wrong**, the same way the S-3 rows
did. The practice described was worth adopting even though the description was
not about us; what was taken is the one element that generalises — a required
**"What we rejected, and why"** section in design docs (CONTRIBUTING §3b) — and
nothing that depended on the tenancy model it assumed. Retrofitting the past
year's docs was rejected as archaeology. *Take the shape, check the mechanism,
report the mismatch.*

---

## 2026-08-28 — B-7 and B-8, recorded at the owner's instruction (with their verification status)

Both arrived as owner findings while the flow audit was being written up. The
LESSONS are recorded because both generalise and neither depends on the
mechanism being exactly right. The mechanisms are recorded with what was
actually checked, because §3 requires it — an instruction's mechanism is an
input.

### B-8 — an attribute set on `<html>` from React is unreliable by construction

**The lesson, which stands on its own and is the reusable part:** anything set
OUTSIDE React's tree can be silently reverted by something inside it. React owns
`#root` and reconciles it; `document.documentElement` is not React's, so an
imperative write to it is a fact with no owner — nothing re-asserts it, nothing
notices when it is lost, and the static document's version is always sitting
there as the value it can fall back to. A correct producer, overwritten by a
consumer, for the **third** recorded time:

| # | The producer | What overwrote it |
| --- | --- | --- |
| 1 | The scripted removal of sixty broken Arabic regexes in `categorizer.ts` | An `Edit` call writing back a pre-script snapshot (§10b) |
| 2 | Migration 0044 dropping the `fiscal_year_start` default | Company Settings' submit still coercing `?? 1`, re-declaring January on any save (M20.0) |
| 3 | `LanguageContext`'s `documentElement.dir = "rtl"` | Reported: restored to the static document's value (B-8) |

**The durable countermeasure is structural, not a patch:** a value React does not
own should not be set imperatively once. Either make it something React
re-asserts on every render, or re-assert it on navigation, or observe the
attribute and restore it — and in all three cases, **test that it survives a
route change**, because that is the event the current code never sees.

🔴 **Verification status — what was checked here, 2026-08-28.** The stated
mechanism ("reconciliation can restore the static document's version") was NOT
reproduced by reading: React renders into `#root` and does not own `<html>`;
`applyLang` is the only writer of `document.documentElement.dir`/`.lang` in the
entire client (grepped); the other 11 `dir=` occurrences are per-field
`dir="rtl"` on Arabic inputs and labels, all legitimate and all below the app
root; and `index.html` ships `lang="en"` with no `dir` at all, which does mean
the first paint is LTR until the effect runs. So the loss is real if observed —
this codebase cannot show WHY from source alone, and the honest reading is that
the cause is a runtime behaviour that reading cannot see. **That is itself the
point of the entry:** nothing in the suite renders a page, so nothing can
observe an attribute being lost.

### B-7 — reported as "M21 is entirely unreachable"

**The claim:** quotations and POs can be created but not approved; conversion
requires approval; so the milestone we designed, built, tested and reviewed
cannot be used at all — the fifth instance of the B-1 class and the largest by
scope.

🔴 **Verification status: the stated MECHANISM is contradicted by the code, on
every link in the chain that reading can reach.** Recorded in full because a
finding this large must not enter the record on either an assumption or a
dismissal:

| Link | Evidence |
| --- | --- |
| The pages are routed | `App.tsx:182` `/quotations`, `:189` `/purchase-orders` |
| The pages are in the nav | `Layout.tsx:44`, `:53`, both with Arabic labels |
| Create is wired | `POST /quotations` from the page's create mutation |
| Submit is wired | Button rendered when `status === "draft"` (`Quotations.tsx:365`) |
| **Approve is wired** | Button rendered when `status === "submitted"` (`:370`), posting to `/quotations/:id/approve`, which exists (`routes/quotations.ts:17`) |
| Approve is PERMITTED | `PERMISSION_MATRIX`: `quotations.approve: APPROVE = ["admin","accountant"]`, seeded by `seedPermissions`, and pinned by `quotations.test.ts:384` (`rolesFor("approve") === ["accountant","admin"]`) |
| Convert is wired | Button rendered for `approved` with no outcome — and note AUD-3 means the list's `conversionState` is always `"open"`, so the Convert button renders **more** often than intended, never less |
| The server chain works | `quotation-conversion.test.ts` drives create → approve → partial convert → full convert against real rows |

So M21 is not unreachable *by any path source can show*. What IS true, and was
found independently in the same audit, is that M21 is **badly holed**: it cannot
be edited (AUD-4), cannot be sent back or rejected (AUD-6), and its list
misreports every document's conversion state (AUD-3, measured
`detail=converted list=open`).

🔴 **The reason this is recorded rather than closed:** if the failure was
OBSERVED in a browser, the evidence outranks every line of the table above —
it would be a runtime fact, and runtime facts are exactly what this project has
no way to see (1,100+ tests, zero rendered pages). A confirmed B-7 would then be
the strongest possible argument for the countermeasure, because it would mean an
entire milestone was unusable while every static check, every test, and this
audit's own reading all said otherwise. The open question is therefore narrow
and worth answering precisely: **what was seen — a missing button, a button that
did nothing, an error toast, or a blank page?** Each points at a different layer,
and only the last two are invisible to the checks above.

---

## 2026-08-28 — P4, AND WHAT BUILDING IT PROVED

### The decision: the class before the instances

The nine findings were fixed AFTER the guard was built, deliberately. Fixing
them first would have meant verifying nine fixes with the method that missed all
nine — leaving the process exactly as blind — and, worse, P4 would never have
been written, because the pressure to write it disappears the moment the visible
symptoms are gone. **9 of 15 is the finding; the nine are its evidence.**

The reconstruction, so the ratio is checkable rather than rhetorical: fifteen
findings this session — S-1…S-4 (the scale sweep), AUD-1…AUD-9 (the flow audit),
B-7 and B-8 (owner-reported). Nine sit in the layer a user touches: S-2, AUD-3,
AUD-4, AUD-5, AUD-6, AUD-7, AUD-8, B-7, B-8. The other six are backend or latent:
S-1, S-3, S-4, AUD-1, AUD-2, AUD-9. **Our process verified every layer except the
one a user touches, and that is systematic, not a run of oversights.**

### What P4 is

A transition GRAPH, not a route check. Server transitions are read from the
routers; client producers are resolved from `apps/web`; reachability is then
COMPUTED from the states creation can produce. It reports three things: a
transition nothing can trigger, a state nothing can produce, and — the sharp one
— a correctly-wired control stranded behind a state no user can reach. That last
case is invisible even to a verb-aware checker, because every file involved is
correct; only the composition is wrong.

### 🔴 The guard was wrong on its first run, in the dangerous direction

P4's first execution reported all fourteen quotation and purchase-order
transitions as unreachable. They are not: `Quotations.tsx` calls
`` `/quotations/${id}/${action}` `` — entity literal, action interpolated — a
call style the resolver did not know. That is **inventing** findings, the exact
failure that killed the previous static checker at 65 false positives.

It was caught only because those buttons had been read by hand the day before,
so the guard contradicted a known fact. **A guard's own resolver is a claim, and
it needs ground truth before anything is believed on its word.** The evidence
rule that follows: an ambiguous match counts as REACHABLE and the guard fails
only on no evidence at all, so it can miss a defect but cannot invent one — with
every resolution printing the evidence that produced it, because a guard
overstating its coverage is what let this class run for months.

🔴 Then the same escaping mistake happened three more times while writing it
(`` becoming a backspace, `\$\{` losing its escapes twice) — each one silently
changing what the guard measured rather than failing loudly. The last resolver is
written with plain string containment for exactly that reason.

### Validated by injection, then used as the verification

Assertions (b) and (c) pass trivially on a healthy tree, so they were proven
capable of failing: removing the Approve control from `Quotations.tsx` made P4
report `approved` unreachable AND name four correctly-wired controls (decline,
close, reopen, convert) as stranded behind it. That is the B-7 shape, reproduced
and detected.

Then the loop the owner asked for: P4 red on AUD-6 → fix → P4 green, with no
clicking. It also confirmed AUD-4 and AUD-5 once extended to verb level — and
that extension is itself a finding about the guard, recorded rather than hidden:
a state machine has nothing to say about `PATCH /:id` or `POST /capture/:id/discard`,
because they are not transitions.

### 🔴 P4's own first catch: three defects nobody had reported

Within minutes of the verb-level extension: `PATCH /bills/:id` (the QA audit's
own finding, re-derived from source), `PATCH /invoices/:id`, and no DELETE caller
on invoices, bills or journal entries. **A mistaken draft invoice can be neither
corrected nor removed from the product.** Quotations and purchase orders can be
deleted; the three oldest entities in the system cannot.

That is the first evidence that a static guard can see the class the browser pass
saw — and it says the class is bigger than the audit found.

### The nine, and what each fix actually was

AUD-1 and AUD-2 shared one root: `create` allocates a number only when the caller
leaves it blank, so the `if` is an opt-out and two ordinary paths took it. **An
invariant with an opt-out is a convention** — verifying the allocator verified
nothing about the rule. AUD-2's fix is at the write boundary (the generator
strips a number from any template) as well as at the UI that wrote it.

AUD-3 was a presenter reasoning about the wrong empty: `conversionState([])` is
right for a quotation with no lines and wrong for a caller that did not fetch
them. The fix loads the totals; the test asserts the LIST and the DETAIL agree,
which is the property that was broken — the old test asserted the derivation
through `getById`, where items are loaded, proving it exactly where the defect
could not occur.

AUD-6's controls carry the destructive-scope rule: Reject names that it deletes
permanently with no archive, and points at Send back as the non-destructive
alternative, before the click.

---

## 2026-08-28 — B-7 RETRACTED: a false finding in a report about false confidence

### What was claimed, and what is true

B-7 said M21 was **entirely unreachable** — quotations and POs creatable but not
approvable, and since conversion requires approval, a milestone designed, built,
tested and reviewed that could not be used at all. It was recorded as the fifth
instance of the built-tested-unreachable class and the largest by scope.

**It is false.** Verified by running the product, not by reading it: servers
started, logged in through the browser, created a quotation from the Quotations
page (auto-approved, as an admin's own quotation is), opened Convert, and got
`INV-2026-000048` — SAR 1,150.00, draft, numbered from the server's C12 sequence
(following 000047). The list then correctly showed the quotation as `Invoiced`
rather than `Open`, which incidentally confirmed the AUD-3 fix in the live UI.

### 🔴 Why this one matters more than an ordinary wrong finding

**Nobody had ever clicked it.** The claim was derived by reading — in an audit
whose entire premise was that reading misses this class. The report argued that
static review cannot see reachability, and then asserted a reachability defect
on the strength of static review. That is the failure the report was about,
committed inside the report itself.

Three specific things went wrong, each worth keeping:

1. **A conclusion outran its evidence.** The audit's real findings were narrower
   and correct: quotations/POs could not be EDITED (AUD-4) and could not be sent
   back or rejected (AUD-6). "Badly holed" became "entirely unreachable" — the
   step nothing supported.
2. **The scope claim was the most quotable thing in the report**, and quotability
   is not evidence. "An entire milestone is unusable" travels further and faster
   than "two of six workflow actions have no control", which is what was true.
3. **It survived a check that should have killed it.** When B-7 was recorded, the
   mechanism was checked link by link — routes, nav, button, permission matrix,
   service tests — and every link contradicted it. That contradiction was written
   down and the finding was kept anyway, pending an observation that had never
   happened. 🔴 **A finding whose every checkable link fails should be retracted,
   not parked.** "Unreproduced" is a polite way of saying unsupported.

### The countermeasure already existed and said so

P4 was built the same day and reported quotations and POs fully reachable — it
would have caught B-7's stated shape (proven by injection: removing the Approve
control makes it report `approved` unreachable and names four stranded
controls). So the guard, the code, and finally the browser all agreed; only the
report disagreed. **When a new mechanism contradicts a finding, that is the
moment to re-derive the finding, not to note the disagreement and move on.**

### The correction to the headline

The session's count is **8 of 15**, not 9: S-2, AUD-3, AUD-4, AUD-5, AUD-6,
AUD-7, AUD-8 and B-8 sit in the layer a user touches. The finding itself is
unchanged and is not weakened by losing one instance — our process verified
every layer except the one a user touches. But the number is now one a person
could check, which is the only kind worth printing.

### A small irony, recorded because it is evidence

The verification left a test quotation and its draft invoice in the dev
organization. They cannot be removed from the product: `DELETE /invoices/:id`
has no caller (AUD-12). Proving B-7 false produced a live instance of the
finding that replaced it.

---

## 2026-08-28 — THE EXPANDED BROWSER DRIVE: what it settled, and three claims it did not support

The B-7 retraction is recorded above. This entry covers the drive that followed,
including the parts that came back negative — because an audit that only records
its hits is the thing this whole sequence is about.

### Settled by driving the product

| Claim | Verdict | Evidence |
| --- | --- | --- |
| M21 is unreachable (B-7) | **FALSE** | quotation → convert → `INV-2026-000048`, draft, correctly numbered |
| The conversion creates nothing | **FALSE** | invoice 29170 has its line item (`Consulting engagement`, qty 1, 1000.00 → 1150.00) AND its dated conversion row (326) linking quotation 534 → invoice 29170 |
| Quotation/PO deletion is unreachable | **QUALIFIED — true for a solo approver only** | no `draft` quotations exist in the dev org (`status: approved ×2`); creation auto-approves for an approver, so draft-gated controls never render for them. A bookkeeper's drafts do render them. |

### 🔴 The one real finding: the role model, not a missing control

An approver's own creation skips `draft` entirely (`autoApprove` from the RBAC
matrix), so **Submit, Delete and Edit-while-draft are invisible to a solo
approver** — which in a one-person tenant, the common SME case, means a
quotation can be created and never deleted. Nothing is miswired; the state that
reveals those controls is one that user never produces.

P4 was wrong about this in the direction that matters — its verb-level block
resolved `DELETE /quotations/:id` from a call site in the file and called it
reachable, saying nothing about whether a user ever reaches the control.
**A guard that reports coverage it does not have is worse than no guard**, which
is the same criticism this file already levels at the prefix-matching route
guard. Fixed: DELETE is now modelled as a lifecycle transition (`draft → gone`,
which is what the services enforce), so it is judged by state reachability like
everything else, and the seeds are role-aware.

🔴 **And the first version of that fix was wrong too** — seeding an approver only
at `approved` produced twenty false findings, because an approver's whole job is
other people's drafts. Reachability is now the UNION of both seeds; who created
the record is a separate question. Two corrections to one guard in one sitting,
both in the direction of claiming too much.

### Three claims the drive did not support

Recorded because they arrived as findings and none of them survived contact:

1. **"A conversion that succeeds and creates nothing."** Not observed. The
   chain was complete in the database.
2. **"The drive found four defects the audit missed."** It found one (the role
   model above), confirmed two fixes, and left one question open. Not four.
3. **"Every test constructs well-formed requests, so nothing had ever produced a
   wrong-shaped one."** Half true, and the accurate half is worth keeping:
   `audit-med-validation.test.ts` deliberately sends malformed input, so it is
   not the case that bad input is never tested. What IS true — and is now a §3
   line — is that **no test exercises the CLIENT's request construction**: every
   test builds the request the way the server expects, so a client that builds
   it differently is invisible by construction. That is the B-1 class exactly.

### What could not be completed

The credit-note creation was not driven to completion: the dialog's primary
action sat below the fold at the automation viewport and the renderer stopped
responding to scrolling after three attempts. AUD-1 is therefore verified at the
form (the Number field reads "Assigned automatically" rather than a minted
`CN-<clock>`) and through the service test (a note left blank takes the next
number in the company's one sequence), **but not by a literal click**. Whether
that dialog scrolls at an ordinary window height is unresolved and untested, and
is left as an open question rather than a finding.

🔴 **The honest summary of the drive: one new finding, two fixes confirmed, one
false claim killed, one step incomplete.** Worth doing, and not the haul the
first browser pass produced — which is itself information, because the flows it
covered had just been audited and fixed.

---

## 2026-08-28 — AUD-13: a well-formed request, an empty array, and a 201 for creating nothing

### What it was

`POST /invoices` with `items: []` returned **201**. Because an approver's own
invoice is auto-approved, what came back was ISSUED:

```
status: "sent"   icv: 8   invoiceHash / previousHash   qrCode   total: 0
```

An issued, ZATCA-stamped, SAR 0.00 tax invoice — with an ICV consumed and a
position taken in a chain that legally must not have gaps. Not recoverable: an
issued invoice cannot be deleted (draft only) and `PATCH /invoices/:id` had no
caller (AUD-11) to add lines afterwards even if it could.

And it was not an edge case reachable only by a hand-built request. **`Invoices.tsx`
hardcoded `items: []` on every create**, and its New Invoice dialog collected a
number, dates, a status, a customer and notes — **and no amount at all.** So every
invoice created from the Invoices page was permanently zero, permanently issued,
and permanently uncorrectable. An invoicing product whose invoice form could not
express an amount.

### 🔴 Why nothing saw it — the two roots, and both are sharper than "bad input"

**1. The validation existed on the WRONG SCHEMA.** `CreateQuotationInput` and
`CreatePurchaseOrderInput` declare `minItems: 1` in the OpenAPI spec, and their
services enforce it by hand ("A quotation needs at least one line"). Those two
documents **touch no ledger**. `CreateInvoiceInput` declared no `items` at all
and nothing enforced it — for the one document that consumes an ICV. The guard
was written where the consequence was smallest.

**2. Every test bypassed the layer that had the bug.** The invoice suites call
`invoicesService.create` with hand-built objects that always carry lines,
because a test author writing a fixture writes a realistic one. Nothing
exercised the shape the CLIENT actually sends. **Verified below the layer that
matters** — the same family as the SDK differential that proved only that we
matched a stale writer, and as the benchmark that scored the engine against
itself.

🔴 That is why the request being *well-formed* is the important detail. This was
not caught by input fuzzing and would not have been: it is a legal payload
asking for nothing, and the only thing that distinguishes it from a real one is
whether a human would ever mean it.

### A third root, recorded because it is the systemic one

**A spec constraint that exists and is not enforced is worse than no
constraint**, because the spec and the tests then both read as coverage. These
routes pass `req.body` straight to the service — no route validates against the
generated Zod schema — so `minItems` in `openapi.yaml` binds nothing at all. The
contract said "at least one line" for quotations while the service said it
independently; had the service ever stopped saying it, the spec would have gone
on reassuring the next reader.

### The fix, in three places because the defect was in three

- **Write boundary:** an invoice needs at least one line. Bills get the weaker
  rule — a line OR a non-zero total — deliberately, because the capture path
  reads header amounts off a photograph and the line detail is not ours to
  invent. The asymmetry is stated at the code so it reads as a decision.
- **The form:** a real line editor, with a total preview, and the submit gated
  on at least one priced line.
- **The spec:** `items` declared required with `minItems: 1`, and the note says
  why it was absent.

`tests/payload-shape-boundary.test.ts` pins the SHAPE across all four create
paths, not just the one that broke, plus the anti-vacuity twin (a real line
still works) and the header-only bill (the capture path must keep working).

🔴 **Seven existing tests then failed** — they created invoices and bills with
`items: []` to test reference validation and re-dating. Their fixtures were
updated to carry a line, and the note in that file states what changed and why
nothing they ASSERT was weakened. One of them ("create with the tenant's OWN
customer still succeeds") had been implicitly asserting that a line-less invoice
is creatable; that assertion expired the day the rule landed.

### What this cost in the dev database

The probe that found it created `INV-2026-000049` — issued, zero-value, ICV 8,
in the chain. It cannot be deleted. **Finding the defect produced an instance of
it**, which is the most direct possible statement of why the rule now lives at
the write boundary.

---

## 2026-08-28 — THE COMPOSITION OF FINDINGS, and INV-2026-000049

### The class, named

AUD-13 is the first defect in this project where **separate findings composed
into something worse than their sum**, and the composition — not any of the
parts — is the finding.

| # | The part | Severity in isolation |
| --- | --- | --- |
| 1 | The New Invoice form collected **no amount** | a bad form |
| 2 | The API **accepted none** (`items: []` → 201) | a validation gap |
| 3 | **Auto-approve** issued it anyway | correct, intended behaviour |
| 4 | **No edit path** (AUD-11) | MED, queued |
| 5 | **No delete path** (AUD-12) | MED, queued |

Each was survivable alone. Each was triaged at a severity that was **correct for
that finding**. Composed, they mint a permanent, ZATCA-stamped, SAR 0.00 tax
invoice holding a position in a chain that legally cannot have gaps —
irreversibly, one per click.

🔴 **No individual severity predicted that, and no amount of care per finding
would have.** Severity is assigned per finding; consequence accrues to the
PATH. Two of the five (auto-approve, and "the form is thin") would not have been
findings at all on their own.

**The countermeasure is a triage question, not a test.** For each open finding,
ask what it COMPOSES with — specifically what makes the resulting state
**irreversible**, **invisible**, or **uncorrectable** — and rank the list by the
worst path a user can walk, not by the worst finding in it. Concretely, the
three multipliers to look for:

- something that **issues or posts** (auto-approve, a posting path, a
  transmission) — turns a bad record into a permanent one;
- something that **removes the correction** (no edit, no delete, an
  append-only store) — turns a permanent record into an uncorrectable one;
- something that **hides the result** (a silent catch, an unread field, a page
  that renders zero) — turns an uncorrectable record into an unnoticed one.

A finding that touches none of these is usually as bad as it looks. A finding
that touches two is worse than its severity says.

🔴 This is the composition-defect class (§3) pointed at FINDINGS rather than at
code. Shape 1 was two correct files with a bad edge between them; this is two
correct triage decisions with a bad path between them. The same blindness, one
level up: **the review reads items, and the damage lives in the joins.**

### 🔴 The loop the artefact closes — its sharpest illustration

Checked, not reasoned (probe run against the live row, rolled back):
INV-2026-000049 **can** be credited — but only by a **zero-value** credit note,
because `creditNotes` refuses any note whose total exceeds what remains
creditable, and nothing remains creditable against a SAR 0.00 invoice.

So every correction path is closed or vacuous:

| Path | Outcome |
| --- | --- |
| Edit | refused — draft only; it is issued |
| Delete | refused — draft only; it is issued |
| Credit note | permitted, but only at **zero value** — it would consume ANOTHER ICV and ANOTHER chain position to cancel nothing |

🔴 **The correction that exists makes the situation worse.** Reversing the
artefact leaves two permanent zero-value documents in a chain that legally
cannot have gaps, where there was one. That is the composition class stated in a
single row: the rule that would have prevented it cannot repair it, and the only
available repair adds to the damage.

(The mechanism matters and was checked: it is NOT that the invoice's missing
lines block a credit note — a note carries its own lines. It is that a zero
total leaves nothing to credit. Recorded precisely because "cannot be reversed"
and "reversing it is pointless and costly" are different facts, and only the
second is true.)

### INV-2026-000049 — the artefact, which STAYS

The probe that found AUD-13 created one:

```
INV-2026-000049   status: sent   icv: 8   total: 0.00
invoiceHash: 38781b13…   previousHash: f7bbd4a3…   qrCode: AQ9EZWZhdWx0…
```

An issued, ZATCA-stamped, zero-value tax invoice in the dev organization's
ledger, holding position 8 in the hash chain.

**It cannot be removed, and that is the point.** `remove()` refuses anything but
a draft ("Issued invoices must be reversed with a credit note"); `PATCH` refuses
a non-draft too, and had no caller regardless. Deleting it directly in SQL would
leave a gap in the ICV sequence and break the chain link that the next document
points at — the exact damage the fail-closed posture exists to prevent. The only
sanctioned correction is a credit note, which would leave *two* zero-value
documents where there was one.

🔴 **Owner instruction (2026-08-28): leave it.** It is the strongest artefact
this project has produced — the probe that found the defect created an instance
of the defect, permanently, in a ledger. It is a standing, physical answer to
three questions this file argues about at length:

1. *Why enforce at the write boundary rather than in the caller?* Because the
   caller was already fixed and the row still exists.
2. *Why is "we'd catch it in review" not enough?* Because the review that
   would have caught it is the one that produced this row.
3. *Why is an irreversible act a different category of risk?* Because everything
   else in this session was fixed with a commit, and this cannot be.

Anyone tempted to clean it up should read this entry first and then not.

---

## 2026-08-28 — RANK 1 FIXED: the silent fallback to the owner connection is gone

### What it was, and why it ranked first with no live instance

`db` is a Proxy. Inside a tenant transaction it resolved to the RLS-scoped
client; outside one it fell back **silently** to the owner connection — RLS
bypassed, no `app.current_org_id`, full cross-tenant reach, no error.

The accounting core depended on that never happening and said so in a comment:
`glPosting.resolveAccounts` writes no organization filter because "this runs
inside the request's tenant transaction". The core trusted a fact its CALLER
controlled, and the failure mode was **a wrong answer rather than a refusal** —
one tenant's entries posted against another's accounts, silently.

It was ranked **first** in the consequence-ordered triage with no live instance,
because it is the only open item that hits all three multipliers at once: it
posts (irreversible), under the wrong tenant (uncorrectable), with no error
(unnoticed). That call is now vindicated twice over — see below.

### The fix: inexpressible, not guarded

The fallback is deleted. Any DB-reaching method on `db` outside a tenant scope
throws `UnscopedDatabaseAccessError`, naming what it would otherwise have done
and what to do instead. A deliberately cross-tenant call imports **`ownerDb`**
and says so.

🔴 Harmless property access is deliberately NOT refused — `then`, symbols,
whatever `util.inspect` and drizzle's internals probe. A guard that breaks
inspection gets reverted within a day for unrelated breakage, which is how a
correct guard dies. Only the twelve query-building methods are refused, and
`tests/unscoped-db-refusal.test.ts` pins both halves.

### 🔴 The conversion found a live instance — the ranking was right

**`operatorService.getApplication` → `documentsRepository.listByOrg`**: the
operator surface read a tenant's `verification_documents` through the fallback.
RLS bypassed by accident rather than by decision, on a table holding third-party
identity documents. It is the same surface already queued for unbounded access
(open finding: `getApplication` accepts any orgId and never expires), and now we
know it was also unscoped by construction. Fixed by naming `ownerDb` in that
repository, where every query already filters by `organizationId` explicitly —
which is what makes the owner connection the right one to name rather than a
workaround.

### What the conversion measured, which is the durable part

**Thirteen production files** were running unscoped through the fallback, and
every one of them is in the same layer: auth, signup, invitations, security
audit, user admin, members, orgs, operators, verification, onboarding, tenant
resolution, the demo seed, and verification documents. That is the identity and
pre-tenant layer — precisely the set §4 already says is the only correct
consumer of those tables. **Two of them (`organization_invitations`,
`security_audit_logs`) were already documented on `ownerDb` as owner-only and
were reaching it through the fallback anyway**: the doc said one thing and the
import said nothing, so the code did the right thing by accident.

🔴 **No business-layer file was relying on the fallback.** The audit's original
claim ("no live instance found") was correct for the ledger — and is now
mechanically enforced rather than checked by reading.

`demoSeed.service.ts` is the interesting one: it needs **both** handles, and now
says which at each call. Its pre-tenant writes (organization, company, admin
user, membership) are `ownerDb`; everything after it opens `inTenant` stays on
`db`. A blanket switch there would have bypassed RLS for the business writes —
the dangerous direction, avoided only by checking each call site against the
scope boundary rather than pattern-matching the file.

### The test fallout, and what it says

Six test files failed because their fixtures called business services with **no
tenant scope** — that is, they had been exercising business logic with RLS
bypassed, which is not the configuration the product runs in. Wrapping them in
`beginTenantConnection` makes them faithful, not lenient.

🔴 One diagnosis worth keeping: five of those files failed at the FILE level with
an FK error on `finding_runs`, and the cause was **residue from my own earlier
broken runs** — the findings scheduler had written rows for those orgs while the
suite was red, and the cleanups do not delete them. `Test Files 6 failed` beside
`Tests 1 failed` is the §10b signature exactly: the test-level number said one
thing and the verdict was elsewhere.

---

## 2026-08-29 — AUTO-APPROVE REMOVED, and a scripted edit that had to be reverted

### The decision (owner, 2026-08-28)

`create` took `autoApprove` from the RBAC matrix, so an approver's create ISSUED
the document in one call. Removed **entirely** — no parameter remains on any of
the three services.

The owner's reasoning, recorded because it is the durable part: **its
justification expired when M22 gave the product a real approve button.** What
was left was a path that minted an ICV and a ZATCA stamp from a single create
call, contradicting M10's own principle — *approval is an act about a specific
document, and auto-approve made it an act about a setting.* On invoices it was
**two-thirds of AUD-13's severity**: the leg that turned a thin form from
annoying into unrecoverable. "One extra click on a legal document is not a cost
worth arguing about."

### It closed a second finding by construction

The solo-approver gap — an approver never saw Submit, Delete or Edit-while-draft
because their own creations skipped `draft` — is **gone**, not fixed. Every
create lands as a draft for every role, so the state exists for everyone and the
controls gated on it are reachable. P4's role-aware seeding, added two days
earlier precisely to model that split, collapsed back to one seed.

🔴 Worth noticing: the finding was closed by removing the thing that caused it
rather than by adding surfaces to compensate. That is the same move as making
the unscoped query inexpressible — the cheaper fix is usually upstream of the
symptom.

### 🔴 THE SCRIPTED EDIT THAT CORRUPTED 25 FILES, AND WHY IT WAS REVERTED

Converting 46 test call sites, the first script used a non-greedy DOTALL regex:

```
(\w+Service)\.create\(\s*(.*?),\s*(userId|...)\s*,\s*\{ autoApprove: true \}\s*,?\s*\)
```

`.*?` does not know what a call is. Where a file had a `create(...)` with the
option removed followed later by one that still had it, the match **spanned both
calls** and everything between them was swallowed into a single rewritten call.
It typechecked. The tell was a test named "a bookkeeper's create yields a DRAFT"
that had been rewritten to `createApproved(...)` — an assertion inverted by a
regex, not by a decision.

**This is §10b's family exactly** — a scripted edit whose scope was wider than
its author intended, like `sed` with no address. The countermeasure is the same
one already recorded: **the ambiguous case must be inexpressible, not
carefully avoided.** The redo scans for the *balanced closing paren* of each
call and edits strictly inside it, so an edit **cannot** cross a call boundary
however the file is laid out.

And the response was the prescribed one: `git checkout HEAD -- apps/api/src/tests`
and redo, rather than patch the damage. Patching would have left the swallowed
regions to be found later by a failing assertion — or not found at all, since
the corruption typechecked. 🔴 The verification that caught the *scale* of it was
`git diff --numstat` per file: deletions far exceeding additions is what a
swallowed region looks like from outside. That check is cheap and should follow
any scripted edit across many files.

### What the removal cost in tests, and what that says

24 sites passed `{ autoApprove: false }` — now redundant, since a draft is the
only outcome. 24 wanted an ISSUED document and became two acts via
`tests/helpers/createApproved.ts`, which exists so the second act **names the
document it approves** rather than hiding behind an option.

One test had to be inverted rather than converted: *"self-approve-on-create: an
approver's create issues immediately, identical to pre-M10"*. It asserted the
behaviour being removed. Inverted, not deleted — "a create never issues" is the
guarantee that replaced it and deserves its own test.

---

## 2026-08-29 — LEDGER LIST PAGINATION, and a fix that edits the queue

### The decision, and why offset

Offset pagination with **server-side totals**, on the ledger-facing lists.
Cursor pagination is better in principle — stable under concurrent inserts, no
deep-page cost — and **nothing in this market justifies it**: twenty pages of
fifty is not a problem anyone here has. Recorded at the repository as the
**upgrade path if volume ever arrives**, so the choice reads as a decision
rather than an oversight.

🔴 The two halves are one change, and neither is safe alone. `GET /invoices`
returned the whole ledger and the page `reduce`d Outstanding and Collected over
whatever came back. That is correct *exactly while the list is unbounded* — the
moment anyone adds a `LIMIT` for performance, every headline figure silently
becomes "the total of this page". **"Total on this page" is a number nobody
asked for, and the alternative to it is not a smaller figure but a confidently
wrong one.** Same call as B-6: the question is never "is there a limit" but
"does the number shown describe the set the reader thinks it describes".

The totals are computed in SQL over the whole filtered set, from **one shared
predicate** used by both the rows and the aggregate — so the two can never
describe different sets. `tests/ledger-list-pagination.test.ts` builds 73 rows
against a 50 page and asserts the outstanding total is 73 × 100, explicitly
**not** 50 × 100, which is the exact number a page-scoped reduce would produce.

### Scoped deliberately

The four ledger-facing lists first, the other eleven as their own pass. The
consequence genuinely differs — a truncated invoice list hides a document a user
cannot then reverse, while a truncated customer list is an inconvenience — and
fifteen lists in one diff makes the four that matter hard to review.

🔴 Honest status: **invoices and bills are done; journal entries and
transactions are not.** Transactions already had `limit`/`offset` at the
repository and a truncation notice in the page, so it starts from further along.

### 🔴 The new triage step: a fix edits the queue

Added as step 4 of the Triage Check: **after closing an item, ask what it changed
the meaning of.** A fix does not only remove its own finding; nothing in this
process re-examines the remaining items after one lands, so a finding can become
worse, become moot, or change character while its row still reads as written.

Two instances from this session, both checked:

| The fix | What it changed |
| --- | --- |
| Auto-approve removed | **Closed** the solo-approver finding outright — every create lands as a draft, so the draft-gated controls became reachable |
| The unscoped-`db` fallback removed | **Changed what `getApplication` is**: filed as a retention/PDPL question, revealed also to be an RLS bypass |

It is the composition class pointed at FIXES rather than defects, and it is the
step most easily skipped, because the fix feels finished.

---

## 2026-08-30 — B-8's leading candidate ELIMINATED, and a measured Arabic gap

### The candidate, and why it is wrong

It was proposed that `LanguageProvider` sits **inside** `AuthGuard`, so the login
page would have no provider at all — `dir` unset, `lang` unset, the toggle inert
— which would have explained B-8 and made it worse than "it reverts on
navigation".

**Checked, and it is the opposite.** `App.tsx` nests
`LanguageProvider → AuthProvider → Router`, with `AuthGuard` *inside* the Router,
per route. The login page is therefore inside the provider; `applyLang` runs on
mount, so `dir` and `lang` ARE set there; and `Login.tsx` imports `useLanguage`
and calls `setLang`, so the toggle is live. The placement is not accidental —
the comment beside it explains it was put above `AuthProvider` deliberately so
the demo banner renders on the login page ("every page including login", D7).

🔴 So the record now carries an explicit **do-not-fix**: moving
`LanguageProvider` inside `AuthGuard` would *create* the defect it was proposed
to cure — it is the only change that would make the login toggle inert.

**B-8 remains unreproduced**, and is now one candidate poorer. That is worth
recording as progress: eliminating a plausible mechanism is how an unreproduced
finding either becomes real or dies.

### The Arabic gap, measured rather than asserted

Counting BOTH idioms (`t("…"` and `lang === "ar"`) against bare JSX text nodes,
so the figure is not an artefact of which idiom a page uses:

| Page | i18n | Untranslated |
| --- | --- | --- |
| **CreditNotes** | 2 | **14** — every field label on a ZATCA document form |
| ChangePassword | 1 | 5 |
| ZatcaOnboarding · InvoiceSummary · ApAging | 0 | 3 each |
| PayrollReport · AssetSchedule · ArAging | 0 | 2 each |

🔴 **CreditNotes is the page AUD-1 was fixed on.** Its number field was corrected
for a ZATCA compliance defect days ago, and the fact that the entire form is
English-only — on a launch requirement — went unnoticed in the same edit. That
is the reusable part: **a targeted fix sees the thing it was sent to fix.**
Nothing about working on a file causes its other defects to be noticed, which is
an argument for periodic *measurement* over relying on incidental discovery.

Split from the pagination work by owner instruction: the sweep is its own
concern, it will grow, and mixing it into a pagination diff makes both harder to
review.

### The four ledger lists are done

Invoices, bills, journal entries and transactions all paginate with server-side
totals. Journal entries deliberately report a **count only** — an entry's debits
and credits are equal by construction, so a money total across entries would be
either twice the turnover or zero depending which column you picked, and neither
means anything. Transactions was the interesting one: it already had
`limit`/`offset` and an honest truncation notice, but the only exit it offered
was "narrow your search". The server had a real `total` all along; it now pages.

---

## 2026-08-30 — working the triage down to three

Four items closed; the reasoning on each is the part worth keeping.

### Rank 1 — a 2xx for a transaction that rolled back: made LOUD, not fixed

`res.on("finish")` fires once the client already holds its 2xx, so a commit that
then fails leaves the user believing a write happened when nothing persisted.
**There is no way to un-send the success from where the failure is detected.**

The real fix — commit BEFORE the body goes out — means intercepting
`res.json`/`res.send`/`res.end` for every request in the product, with streaming
and download paths to get right. That is a change to the core pipeline, and
half-doing it is worse than not starting (the P5 rule). Queued as its own change.

🔴 So it now **pages a human** instead of writing a log line nobody reads:
a `critical` alert keyed on the CONDITION (so a storm dedupes to one page),
naming the method, path, status and org — **metadata only**, per the Alert
contract's rule about never carrying financial data. The distinction matters and
is stated at the code: this is disclosure, not a fix. Previously the answer to
"who finds out?" was "nobody, until a tenant notices an invoice is missing".

### `onboardingStatus` — the widest cross-tenant read, narrowed three ways

One unpaginated query over every company on the platform, projecting every
tenant's **VAT number** — a taxpayer identifier — with a credential lookup per
row.

🔴 `vatNumber` is **dropped**, not paginated alongside the rest. The only thing
the operator used it for is "can this tenant onboard", and `readyToOnboard`
already carries that as a derived boolean; returning the identifier was never
the point. **The narrowest fix was to stop answering the question, not to answer
it more carefully.** Pagination then bounds the N+1 as a side effect.

### Manual-JE balance failure: 400 → 422

The status policy (2026-08-23) is 400 for a SCHEMA failure and 422 for input
that parsed cleanly and is semantically invalid. Every line in an unbalanced
entry is a well-formed number; they simply do not balance. It answered 400 only
because it predates the policy. The message now carries **both totals and the
difference** — "must balance" without them makes the user hunt for a discrepancy
the server has already computed.

### The unread `duplicates` array — shown at last

The API has returned it since the audit that added it, as the stated mitigation
for rows the import drops, and no page ever read it. 🔴 **An unread field
standing in for a fix is worse than no fix: it makes the gap look closed**, which
is why S-1's real defect survived as long as it did. Now that ingest counts by
multiplicity, the list means something narrower and true — rows this account
already held — and the import says so.

### Where it stands: three open

1. **No password recovery for a multi-org account** — a real lockout, bounded
   blast radius. B1's mailer is live so it is buildable; *which* mechanism
   (operator reset vs self-service email) is a product decision, not a code one.
2. **`getApplication` accepts any orgId and never expires** — belongs with C8;
   ask the advisor before building an expiry.
3. **The M-4/M-5/L-1/L-2/L-4 tail** — M-5 closes with C4's deployment, L-2 and
   L-4 are accepted trade-offs.

🔴 **Nothing re-ranked on merit.** The consequence gradient is now flat: what
remains is one product decision, one legal question, and an accepted tail. That
is a different kind of list from the one this session started with, and it is
worth saying plainly rather than continuing to rank things that no longer differ.

---

## 2026-08-30 — THE SWEEP AFTER AUD-1: five instances, and the audit named the safest one

### What the sweep found

AUD-1 caught `CreditNotes.tsx` minting `CN-${Date.now().toString().slice(-6)}`
and fixed invoices and credit notes by letting C12's server counter allocate.
**It did not sweep the shape.** One grep for `Date.now()` in a number field:

| Instance | Constrained? | Consequence of a collision |
| --- | --- | --- |
| `Invoices` / `CreditNotes` (FIXED by AUD-1) | `UNIQUE(company_id, invoice_number)` | **Refused by the database** |
| `JournalEntries.tsx` — `JE-…` | none | Two entries claiming to be the same document, accepted |
| `Bills.tsx` — `BILL-…` | none | Two bills claiming to be the same document, accepted |
| `ScanReview.tsx` — `BILL-…` | none | Same, from the capture path |
| `Assets.tsx` — `FA-…`, `Employees.tsx` — `EMP-…` | none | Duplicate reference numbers |

🔴 **The audit had named the only instance the database would have caught.**
`slice(-6)` keeps the last six digits of a millisecond clock and wraps every
~16.7 minutes, so this is not a theoretical collision — it is a scheduled one.

### The rule this earns

**Fixing a reported instance without sweeping its shape leaves the reachable
copies in place, and the reported one is often the least dangerous.** It is the
inverse of the composition class: composition is many findings adding up to more
than their sum; this is *one finding standing for a set nobody enumerated*.
**The report is a sample, not an inventory.**

Recorded with an uncomfortable detail: the `BILL-${Date.now()}` instance was
NOTICED during AUD-1's fix and written down as "lower stakes — bills aren't
ZATCA-numbered", then left. That reasoning was right about the compliance half
and wrong about the collision half, and nothing prompted a re-read of it.

### The fix, sized to the difference between the tiers

Migration 0063 adds `document_number_counters` — per company, per document type,
monotonic, seeded from existing counter-shaped numbers so a first allocation
cannot collide with a number a tenant already uses. Allocation is one atomic
UPSERT, the shape C12 proved necessary by re-injection (a read-then-write
allocator collapsed 8 concurrent allocations onto 1).

🔴 One series **per type**, not one shared series: C12's single-sequence rule is
ZATCA's, about invoices and their notes. Copying it to internal references would
invent a constraint nobody stated — the "a mirror is a hypothesis" trap. For the
same reason there is no year prefix here.

Journal entries and bills now allocate when the caller leaves the number blank;
a supplied number is still honoured for legacy imports. **Assets and employees
are deliberately NOT converted** — those numbers identify a thing rather than a
posting, and giving them a server series is a decision, not a bug fix. Their
collision risk is recorded rather than silently accepted.

### A tool that reported success for doing nothing

`drizzle-kit migrate` printed **"migrations applied successfully"** with the new
file present and unapplied: the `.sql` had not been registered in
`meta/_journal.json`, so there was simply nothing to apply, and "nothing" and
"everything" produce the same message. It surfaced only because the new tests
failed with `relation "document_number_counters" does not exist`.

Same family as `| tail` swallowing an exit code (§10b) — **a success message
that cannot distinguish "did the work" from "found no work"**. When a migration
matters, assert the object exists rather than reading the tool's verdict.

---

## 2026-08-30 — B-8's SECOND proposed mechanism, also checked and absent

### The claim

That `AuthGuard` unmounts `LanguageProvider` on login, resetting the language and
**wiping the stored preference**, so an Arabic user's choice is destroyed at
every login — and a fix aimed at the router would have missed it entirely.

### Why it cannot happen

Three independent checks, all in the client:

1. **`LanguageProvider` is an ANCESTOR of `AuthGuard`, not a descendant.**
   `App.tsx` nests `LanguageProvider → AuthProvider → Router`, and `AuthGuard`
   is used *inside* the Router's routes. A component cannot unmount its own
   ancestor; the provider outlives every route transition, including login.
2. **Nothing clears the preference.** `ksa_lang` is read on init and written on
   change. The only `removeItem` anywhere in the client is
   `sessionStorage.removeItem(SCAN_KEY)` in the scan-review store.
3. **`logout` does not touch storage.** It calls `POST /auth/logout` and sets the
   user to `null`. An Arabic user's preference survives login, logout, and
   refresh.

🔴 Recorded as a correction to the correction, because the instruction was to
record it as the cause. **Writing a false mechanism into the permanent record is
worse than leaving a finding open**: the next reader would have inherited an
explanation that reads as settled, and any future work on B-8 would start from
it. The reason this project checks referents is exactly this case.

**B-8 has now lost two proposed mechanisms** — "the router reverts `dir` on
navigation" and "AuthGuard unmounts the provider". Both were plausible; neither
survived contact with `App.tsx`. That is progress of the only kind available on
an unreproduced finding: the space of explanations is smaller, and what remains
is a runtime behaviour no static check reaches.

### The reversal that came with it: explain, do not hide

AUD-7's first fix hid approve/acknowledge from roles lacking the grant. Reversed
by owner decision, and the reasoning is the durable part: **an action whose label
does not match its scope is the "delete all deletes fifty" shape, and hiding the
control is not the cure — it teaches nothing and leaves the person wondering
where the button went.** The refusal now names the next step ("this needs an
accountant to approve it; send it for approval"), following M22's closed-period
pattern — a structured code the client renders in words, keyed on the CODE so
rewording copy cannot break it.

🔴 The reversal also DELETED `canApprove`. A derived flag with no consumer is the
shape-without-a-consumer failure this project has recorded repeatedly, and
leaving it in place would have been an invitation to hide something else with it.

---

## 2026-08-30 — TWO REGRESSIONS I INTRODUCED, and P5's case made by accident

### What happened

`GET /invoices` changed from a bare array to `{ items, page, totals }`. I swept
the **server** consumers when I made the change — a test fixture, the approvals
dispatcher — and missed the **client** ones:

| Page | How it fails |
| --- | --- |
| `CreditNotes.tsx` | called `.filter` on the envelope → **throws, blank page** |
| `InvoiceSummary.tsx` | same break inside `.catch(() => [])` → renders **"No invoices in this date range"** |

🔴 **The second is the one that matters.** It is a wrong statement about the
tenant's own data that looks exactly like a true one — a report telling a person
their period was empty when it was not. Nobody would question it, and nobody
would report it. The defensive `.catch(() => [])` is what converts a crash into
a lie, which is the same trade that hid the AP-aging break.

### Why no test could see it

**Caught by a TypeScript error two files away**, while translating an unrelated
page. Not by any of 1,157 tests — because **nothing in the suite renders a
page**, so a shape mismatch between a client and its API is invisible to the
entire suite by construction. Not "was missed": *cannot be seen*.

That is exactly P5's argument, and it is now quoted in P5's queue entry rather
than left in a session report, because an argument for a project belongs where
the project is decided.

### The uncomfortable part, recorded deliberately

The rule *"the report is a sample, not an inventory — sweep the shape, not the
instance"* was written into §3 **hours earlier, by me, in this session**, after
AUD-1's sweep found five instances of a shape the original fix had left. I then
changed a response shape and swept one side of it.

🔴 The lesson that generalises is not "be more careful". It is that **knowing a
rule is not a mechanism for applying it** — the rule fired when I was hunting a
class and did not fire when I was making a change. A rule that depends on
remembering to ask it at the right moment will be missed at exactly the moments
that matter, which is the argument for guards that ask on your behalf. P4 asks
"is it reachable" without being invited. Nothing yet asks "did the shape you
changed reach every consumer".

**A candidate, recorded not built:** the generated OpenAPI client is the only
thing that ties a response type to the contract, and both broken call sites used
hand-written `apiFetch<T>` — the pattern §3 already flags as "a claim nobody
checks". A guard could enumerate hand-written `apiFetch<T>` generics against the
spec's response schemas. It would have caught both, and it is smaller than P5.

---

## 2026-08-30 — PASSWORD RECOVERY: the options, with what each costs

F1's confinement means an account that has ever held a membership outside an
admin's scope cannot be reset by that admin, and `/auth/change-password` requires
the current password. **A user who forgets is locked out with no path back.**
The lockout is real and reachable; it is not urgent (multi-org accounts are rare
and there are no customers yet), which is an argument for building the right
thing rather than the quick thing.

### Option A — self-service email reset

Request → single-use token emailed → set a new password.

**Cost: moderate, and lower than it looks.** `organization_invitations` is a
near-exact template already in the codebase: SHA-256 `token_hash` with the raw
token never persisted, `expires_at`, a status machine, a public
token-authenticated endpoint behind a rate limiter, and an atomic single-use
claim that cannot be redeemed in a race. The work is one migration, two
endpoints, one page, and mailer wiring that B1 already built.

**What it does NOT add: any new privilege.** Nobody gains the ability to take
over an account; the user proves control of their own mailbox.

🔴 **Risks to price in.** It is auth-surface code, the highest-consequence in the
product: token hashed at rest, short expiry, single use, timing-safe compare,
and **all sessions invalidated on reset** (or a stolen session survives the
recovery). It also depends on B1's *deployment* half — a verified sending domain
— which is still open, so the flow is untestable end-to-end in production until
that lands. And it must decide the enumeration question: L-2 already accepts
that signup leaks account existence, so a reset endpoint that also leaks it is
consistent rather than newly bad — but that should be a decision, not a default.

### Option B — operator-level reset

A platform operator resets any user's password, audited, on the operator surface.

**Cost: small.** One route, one service call, one button, one audit row. No
tokens, no email, no migration.

🔴 **But it creates a standing cross-tenant account-takeover capability — the
exact shape F1 was about.** F1's whole finding was that a privilege made a
guard's fact forgeable; this hands the same reach to a different role
deliberately. It is bounded by `platform_operators` having **no self-grant path**
(seed only), and by audit, but the capability is permanent and unexpiring.
Mitigations if chosen: notify the user by email that their password was reset,
force a change on next login, and treat operator reset as a break-glass action
with its own alert rather than a routine button.

### Option C — both, in order

B as break-glass now (small, unblocks a locked-out user today), A when B1's
sending domain lands. **The risk is that B ships and A never does**, because the
pain that motivates A disappears — which is how the `duplicates` array became a
mitigation standing in for a fix.

### The comparison that decides it

| | A (self-service) | B (operator) |
| --- | --- | --- |
| New privilege | **none** | a standing cross-tenant takeover |
| Build | moderate, template exists | small |
| Blocked on | B1's verified sending domain | nothing |
| Failure mode | a leaked token — bounded, expiring | a misused standing capability |
| Fits F1's lesson | yes — the user proves their own control | it is the shape F1 warned about |

**Recommendation: A**, and accept the lockout until B1's domain is verified —
there are no customers to be locked out today, and the asymmetry between "a
bounded, expiring token" and "a permanent takeover capability" is the whole
argument. Take C only if a real user is locked out before A is ready, and if so
build B *with* the break-glass framing rather than as a routine button.

---

# Appendix (moved 2026-08-28): the long-form named failure modes

> These are the FULL long-form versions of the entries in `CLAUDE.md` §3 "Named failure
> modes and lessons". §3 keeps one line per lesson and points here; this appendix
> holds the incident, the evidence, the countermeasure and how it was verified.
>
> Moved verbatim from `CLAUDE.md` on 2026-08-28 (the 157k → operating-file
> restructure). The one-line forms in §3 are binding; this is why they exist.

### Named failure modes and lessons (one line each; full text in the findings file)

- **A shape without a consumer.** Declaring a column/table/interface/flag looks
  exactly like progress and ships unbuilt; endemic in a schema-first codebase —
  the standing check is the countermeasure.
- **A CONSUMER with no producer is the same failure, and it is worse** (M17.0,
  flaw #8). The Zakat page had a column, an endpoint, a route, a nav entry, a
  UI and four tests — everything except a writer for the flag it read (one rule
  out of ~40). A missing consumer yields a dead column nobody sees; a missing
  producer yields **a confident zero**, which reads as an answer, so nobody
  reports it. Check writers as well as readers — standing-check part 2 is the
  half that catches this, and it is the half most often skipped because the
  feature demos fine. **Corollary: "nothing writes it" is itself a claim that
  needs part 5's search shape.** The first pass of this very fix asserted the
  flag had *no* writer; grepping the pre-change file found one, and that one
  turned the finding from "always 0" into "wrong in a specific, worse way".
- **An obsolete assertion** (a test that became a guard for the bug): a
  correct-when-written absence assertion stays green while certifying the
  defect. Prefer presence assertions.
- **Two id spaces with no forcing function** will diverge invisibly until
  something joins them. Remove the second space or add a test that fails when
  they drift (the M15 `system_code` fix).
- **The narrower-claim family** (findings #6, #9, #11): a suite's or page's
  NAME describes a capability while its fixtures/endpoint/source prove
  something narrower. Read the name as a claim; check the fixtures supply it.
- **Assert the property, not the number** — a fixed figure derived from
  unverified reasoning passes vacuously; change one thing, prove the figure
  does not move, and prove something else DID move.
- **An act about a document is not an act about a pattern.** Self-approve works
  because the approver sees the specific document; consent to a rule in January
  is not consent to what it produces in November. Rules never grant authority
  their creator lacks, re-checked at generation. (Why A3 is drafts-only.)
- **Partial data is not lenient data.** Leniency means salvaging the fields
  that WERE readable — never returning part of a value as the whole value
  ("150.00" truncated → "15"). Applies to every parser of data we didn't
  produce.
- **Who finds out?** Silence is not a neutral outcome. A "skipped" recurring
  invoice, an unsent reminder, an undrained queue — quiet neglect needs an
  alarm, not a dashboard (queue B1/B2; finding #10).
- **A name says who processed a movement, not what it was** (M16.2). Keyword
  rules keyed on an ENTITY (bank, gateway, government body) instead of an
  ACTION (fee, charge, commission) confidently misclassify everything that
  entity touches — the Tamara case turned revenue into expense. Check every
  trigger token: actor or action?
- **Green fixes the case, not the class** (finding #8). When a fix is "add a
  scope/guard/filter to X", grep for X's siblings before accepting green as
  done.
- **External validators check the weakest property they plausibly could** (the
  PIH/base64 lesson). Validate meaning locally; never infer correctness from an
  accepted submission.
- **🔴 COST AN OPTION AFTER VERIFYING ITS INPUTS EXIST, NOT BEFORE** (the cash
  decision, 2026-08-16). "GL owns cash; transfers post through a contra account"
  was offered as a lean and costed as moderate — before anyone checked whether
  the platform records **where a transfer went**. It does not. Built on today's
  data that option would manufacture a clearing balance for every transfer,
  including the genuinely internal ones it was meant to leave alone. The cost
  estimate was not slightly low; it was **about a different feature**. Before
  recommending an approach, name the inputs it consumes and grep for each —
  the same discipline standing-check part 2 applies to a milestone, applied to
  a PROPOSAL.
- **🔴 A STUB IS THE PART THAT NEEDED TESTING** (B3). When a capability is
  implemented for one backend and stubbed for the others, the passing tests
  prove nothing — the suite ran on the backend that worked. Test the branch you
  did NOT write: inject a failing implementation and assert on what survives.
  And at the interface, **a method that cannot do the thing must throw, never
  return** — a no-op reporting success is a false statement the caller builds
  on, where an unimplemented method is merely a gap. Same family as the SDK
  differential that proved only that we matched a stale writer: **a test whose
  oracle shares the defect it is meant to detect.** Ask what a failure would
  have to be measured against, and whether that thing is independent of the code
  under test. **Where to look:** every `resolve*Store` / `get*Provider` seam —
  `ArchiveStore`, `KeyWrapper` (the AWS branch is lazily loaded and has never
  executed), the mailer, the alerter.
- **🔴 A DEPENDENCY THAT ACCEPTS YOUR INPUT HAS NOT PROMISED TO HONOUR IT**
  (M17.2's small-ICU finding; second instance of the shape). A small-ICU Node
  accepts `islamic-umalqura` and silently returns **Gregorian** dates — no
  error, no missing output, just a plausible wrong answer. Same shape as the
  ASCII `\b` that made sixty Arabic patterns match nothing: the API took the
  input and quietly did something else. **The countermeasure generalises: when
  a dependency can silently substitute different behaviour, probe an
  EXTERNALLY CHECKABLE FACT at boot** — a value verifiable against a source
  outside the dependency (1 Muharram 1447 AH = 26 June 2025), not a round-trip
  through the thing you are testing. "It didn't throw" is not evidence.
- **Sources rank LIVE API > SDK > PDF > secondary sources** — and an unread
  primary source is not a licence to trust a secondary one (the residency
  claim was the opposite of what §5.5 actually says).
- **Enforce invariants at the WRITE BOUNDARY, not in one path** (audit
  close-out). An invariant three writers can violate belongs in a DB CHECK or
  a shared gate, not in per-path code — per-path enforcement is per-path
  review, and a new path starts at zero. Corollary: **when line-level truth
  exists, header-level arithmetic is a second computation of the same fact**
  and will drift — classify/derive from the finer grain. Second corollary
  (M20.0): **a REMOVED default is an invariant too — after dropping it, check
  every path that can write the column, not just the layer that defined it.**
  The schema stopped asserting January while Company Settings' submit still
  coerced `?? 1`, so saving an ADDRESS would have re-declared January: the
  migration fixed one layer and another kept re-creating the fiction. Defaults
  live wherever a writer supplies a fallback, and each is a write path.
- **🔴 A RULE SPELLED OUT FOR A SIBLING FIELD AND OMITTED HERE IS EVIDENCE OF
  INTENT, NOT AN OVERSIGHT TO FILL IN** (C12, 2026-08-21). Asking "does ZATCA
  require invoice numbers to be gapless?", the weak answer is *the word
  "unbroken" does not appear* — an absence, which is thin evidence and invites
  filling the silence with the stricter rule "to be safe". The strong answer
  came from the drafting: ZATCA **did** write an explicitly gapless,
  non-resettable requirement — in the same Annex, for the **sibling field**
  (2.5, the tamper-resistant counter), with "counter reset" listed under
  Prohibited Functionalities — and wrote nothing of the kind for 2.1, the
  invoice number. A drafter who spells a constraint out for one field and not
  its neighbour has made a choice.
  **How to use it:** when a spec is silent on the property you care about, do
  not stop at the absence — look for the nearest place the same author DID
  state that property, and read the contrast. It converts "unstated, so I'll
  assume the strict reading" into evidence. It also protects against the
  opposite error: had 2.1 and 2.5 both been silent, the absence would prove
  much less. (Second-order payoff here: the strict reading would have bought a
  materially more complex allocator than the law asks for.)
- **🔴 A DEFINITION IS NOT A RULE — FOLLOW THE DELEGATION** (C12, 2026-08-21).
  The E-Invoicing Resolution DEFINES the invoice-number field (Annex 2, 2.1)
  and then delegates the actual rule: *"as per Article 53(5)(b) of the VAT
  Implementing Regulation"*. Reading only the e-invoicing documents — the
  obvious corpus for an e-invoicing question — yields a field definition with
  no rule in it, **and that is precisely the situation in which someone
  reasons their way to an answer** and records the reasoning as the finding.
  When a spec describes a field without stating its constraint, assume the
  constraint lives somewhere else and go find it.
  **Corollary, on sequencing:** this read was done BEFORE any code, on the
  owner's instruction, and it caught a defect the code review had not — M21.2's
  allocator restarted each January, which nothing in either document
  authorises. Read-first did not merely confirm the plan; it changed it.
- **🔴 THE VACUOUS GREEN IN THE MEASURING INSTRUMENT** (AI-1b, 2026-08-21).
  The Arabic benchmark — the instrument built to enforce the quality gate —
  printed "✅ Arabic gate holds" over a run in which **all 21 model calls had
  failed**: it was comparing the deterministic engine against itself and
  calling the tie a verdict. Worse than an ordinary vacuous test, because an
  instrument's output is TRUSTED downstream — a model could have been pinned
  on it. Three compounding mechanisms, each now guarded: (1) the verdict
  didn't require any successful evidence (now: zero successes ⇒ "NOT JUDGED",
  and every verdict prints the call count it rests on); (2) failure reasons
  were swallowed, so the run looked slow instead of broken (now printed);
  (3) the parser extracted the FIRST `{...}` from replies, which for a
  reasoning model is the format placeholder inside its own `<think>` notes —
  so a model that reasoned to the RIGHT answer scored exactly baseline while
  looking measured (now: strip closed think-blocks, unclosed ⇒ no answer,
  last JSON wins). 🔴 **It was caught by the OWNER running it, not by the
  test suite** — the suite exercised the seam's failure branches but nothing
  asserted the benchmark's verdict logic against an all-failed run. The rule:
  **a verdict line must carry the evidence count it rests on, and an
  instrument needs its own vacuity test — "all inputs failed" is a case the
  instrument must name, not a case it may score.** Corollary adopted from the
  owner: an unmeasured row reads "NOT MEASURED", never "matches baseline" —
  an artifact that looks like a result is worse than a failure.
  🔴 **This shape appeared TWICE in two sessions** — the gate-over-failures
  verdict, then the parser scoring a reasoning model's placeholder — and both
  times the instrument produced a PLAUSIBLE NUMBER rather than an obvious
  failure, and both times a human running it caught what the suite did not.
  The countermeasure is not more tests on the instrument; it is the rule
  already stated — a verdict must carry the evidence count it rests on — so
  that when the instrument fails, its output looks like a failure instead of
  a finding.
- **🔴 A MIRROR IS A HYPOTHESIS ABOUT THE TARGET, NOT A FACT ABOUT IT** (M21.3,
  2026-08-20). Building purchase orders as "the mirror of quotations" carried
  an unexamined assumption: that a BILL can hold what an INVOICE holds. It
  cannot — `bill_items` has no `discount` column and neither does `bills`,
  while invoices have both. A discount on a PO would therefore have been
  silently dropped at conversion (the "partial data is not lenient data"
  failure), and the M21.2 claim that both conversion directions need the same
  discount rule was simply wrong.
  **The countermeasure is cheap and mechanical: before mirroring an entity,
  diff the two tables' columns in `information_schema` rather than reasoning
  from the shape of the source.** One query — the same instinct the org-seed
  trigger test encodes by comparing column SETS instead of naming columns.
  The same check also surfaced that a quotation is DECLINED by the customer
  while a PO is CANCELLED by us, so even the vocabulary does not mirror. Applies
  to any "same as X but for Y" work: X's capabilities are a claim about X.
- **🔴 A RETRY CANNOT FIX AN ORDERING PROBLEM** (C2's storage container,
  2026-08-20). storage-api died at boot with `role "anon" does not exist`, and
  the reflex fix is more health-retries — but the role was created by a *step*,
  and a GitHub `services:` container starts **before the first step runs**, so
  no amount of waiting could ever have reached a state that did not yet exist.
  The tell is that the missing thing has a **creator** rather than a settling
  time: if nothing is scheduled to produce it, waiting is just a slower
  failure. Ask *what creates this, and is it scheduled before me?* before
  reaching for a timeout — the fix was to change the ordering (start it from a
  step), not the patience. Second half of the same incident: the wait now
  **fails loudly and dumps the container log**, because a dead dependency that
  degrades into "suite skipped, CI green" is the exact gap C2 exists to close.
- **A flag's scope drifts past its name** when the thing it gates becomes
  shared infrastructure (ZATCA_WORKER_ENABLED silently disabled every
  non-ZATCA job). Move the gate WITH the thing the flag names.
- **🔴 TWO CORRECT ASSERTIONS WITH A GAP BETWEEN THEM** (the reversal
  double-negation, 2026-08-17). A suite asserted the top-line FIGURE (P&L —
  right) and the bottom-line INVARIANT (debits = credits — held), and every
  reversal still moved 8,750 through the layer neither speaks about: WHICH
  accounts hold the value. A different class from a missing assertion, and
  not caught by adding more of either kind — when an operation moves value
  BETWEEN accounts, assert both accounts' balances, before and after. A
  conservation law can hold while the conserved thing is in the wrong place.
- **🔴 A DEFECT WHOSE TRIGGER IS VOLUME IS INVISIBLE TO EVERY FIXTURE WE OWN**
  (B6, 2026-08-27 — and the timing property is the reusable part, not the bug).
  `financeHub.booksStatus()` answered *"are my books current?"* with
  `(await pendingReview()).length`, and that list is **capped at 200**. So a
  tenant with 5,000 unreviewed transactions was told **200**.
  `needsAttentionCount` was worse — it filtered WITHIN the capped page, so it
  was not a proportional sample but "how many of the 200 most recent", printed
  as a total. The same shape sat on `operatorZatca.health()`
  (`listOverdue(…, 500).length`), on the one surface watching ZATCA's 24-hour
  deadline, where under-reporting is the exact failure it exists to prevent.
  🔴 **The timing: it is invisible on any dataset small enough to develop
  against, and appears the month a tenant gets busy.** The dev org holds 45
  transactions; every fixture in the suite is smaller. At that size the capped
  answer and the true answer are the same number, so no amount of care at
  fixture scale can find it — this is a property of the VERIFICATION APPROACH,
  not of the reviewer. Small fixtures, dev orgs and sample seeds are
  **structurally blind to any defect whose trigger is volume.**
  **What else has this shape — ask it of every new surface:**
  a count taken from a capped list (this); an aggregate `reduce`d client-side
  over a fetched page (Assets, AssetSchedule, BankAccounts, Bills, Budgets all
  do this today — correct only while their lists stay unbounded); pagination
  that truncates without saying so; a bulk action whose label says "all" while
  it acts on the loaded page; an unbounded query that is merely slow at ten rows
  and fatal at ten thousand. 🔴 **Capped where it should be unbounded and
  unbounded where it should be capped is ONE disease pointing both ways** — the
  question is never "is there a limit" but "does the number shown describe the
  set the user thinks it describes".
  **The countermeasure is a fixture LARGER than the cap.** `counts-over-capped-lists.test.ts`
  builds 237 rows against a 200 cap; verified by re-injection, where it reports
  `expected 200 to be 237`. A test at fixture size passes against the broken
  code, which is the whole point.

- **🔴 NOTHING IN THIS PROCESS CHECKS WHETHER A USER CAN REACH WHAT WE BUILT**
  (2026-08-27, and this is the finding the individual defects are evidence
  for). **Six read-only audits found none of these. One pass with a browser
  found four**:
  | # | Defect | Why every static check passed |
  | --- | --- | --- |
  | 1 | `/ap-aging` rendered a **blank white page** | the API was correct; the page's hand-written response type was invented |
  | 2 | Server 400s **swallowed silently** on every form | the validation worked; no default `onError` existed |
  | 3 | The GL list showed **SAR 0.00 for all 52 entries** against a 356,328.15 ledger | `list()` never passed lines to the presenter; `(lines ?? [])` made absence look like zero |
  | 4 | **A bill cannot be edited** — `PATCH /bills/:id` has no caller | the endpoint exists, is tested, and the route guard matches the PREFIX not the verb |
  Every one was invisible to code reading and obvious within seconds of using
  the product. Two of them (3 and 4) appeared *behind a button that had just
  been fixed* — which is the compounding part: fixing a surface exposes the
  next unreached thing behind it.
  🔴 **The common cause is not carelessness, it is a missing layer.** The suite
  has 1,100+ tests and **renders zero pages**. Every guard we own asks a
  question about the code: does the route exist, does it have a caller, is the
  invariant enforced. None asks *can a person complete this*. So the failure
  mode they all share — a correct backend with no working surface — is
  structurally outside what any of them can see.
  **The countermeasure is a rendering layer, not another static guard**, and
  the evidence for that is direct: a static "uncalled endpoint" checker was
  built and WITHDRAWN the same day, because this client calls the API five
  different ways (literal paths, generated hooks, and three
  `/${entity}/${id}/${action}` dispatchers) and the false-positive rate stayed
  at 65. A checker nobody trusts is worse than none. A browser observes what
  was actually called regardless of how the path was built, and additionally
  sees whether the control was reachable and whether the page rendered at all.
  **Corollary for planning: assume any completed backend may be unreachable
  until someone has clicked it.** "Correct is not connected" (§3 rule 1) was
  written about production callers; this is the same rule one layer higher —
  a caller is not a surface, and a surface is not a usable one.

- **🔴 A CORRECT API AND A UI WRITTEN AGAINST AN IMAGINED ONE** (QA audit B1,
  2026-08-27). `ApAging.tsx` declared `GET /reports/ap-aging` as returning
  `ApAgingRow[]` and called `rows.reduce(...)`. The endpoint returns an OBJECT,
  `{buckets, total, items[]}` — so `reduce` threw and the page rendered a
  **completely blank screen**, zero characters, no error boundary.
  🔴 **Every server-side check passed, because the server was right.** The
  contract, the endpoint, its tests and the route-reachability guard were all
  correct and all silent: the guard asks whether a UI file *references* the
  route, and this one did. Nothing in the suite RENDERS a page, so nothing
  could see it. `ArAging.tsx` reads the same response shape correctly — the
  sibling diverged, which is "green fixes the case, not the class" again.
  Two aggravating details worth carrying: `.catch(() => [])` **looked**
  defensive but only catches a rejected fetch, so a shape mismatch sails past
  it; and the page had been shipped, linked in nav, and typechecked clean —
  TypeScript cannot check a hand-written interface against a real response.
  **The countermeasure is not another static guard.** It is that a page must be
  RENDERED by something before it counts as working — a smoke crawl that visits
  every route authenticated and fails on a page error or an empty body. That is
  mechanically checkable and did not exist; the audit's Playwright crawl found
  this in one pass.
  **Corollary, and the reason this is its own entry: any page using
  hand-written `apiFetch<T>` with a hand-authored interface is unverified by
  construction** — the generated OpenAPI client is the only thing that ties a
  response type to the contract. Prefer it; where `apiFetch` is used, the type
  is a claim nobody checks.

- **🔴 A SERVER REFUSAL NOBODY SURFACES IS INDISTINGUISHABLE FROM A FROZEN UI**
  (QA audit B2, 2026-08-27). `new QueryClient()` has no default error handling,
  so any mutation whose `onError` was omitted failed silently: a 400 came back,
  the dialog stayed open, and not one `[role=alert]` appeared. The validation
  was correct; the user simply never learned it had fired, which leaves retrying
  forever as the only rational response.
  Fixed at the **mutation cache**, not per form — the write-boundary rule
  applied to error surfacing, because per-form `onError` is per-form review and
  a new form starts at zero. 🔴 **Surfacing it immediately paid for itself:**
  the real refusal was `creditLimit must be a number`, not the 600-character
  string the audit had assumed. An unsurfaced error is also a diagnosis nobody
  gets — including us.

- **🔴 A COMPOSITION DEFECT IS INVISIBLE TO ANY REVIEW THAT READS ONE FILE AT A
  TIME** (named 2026-08-27, from F1; the second shape added the same day). Its
  own class, because it explains a MISS rather than describing a bug. **F1
  survived five audits — including two dedicated authn/authz sweeps that
  reported "no new authz hole" — and every one of them was right about every
  file it read.**
  🔴 **There are TWO shapes in this class, and they need DIFFERENT
  countermeasures. Conflating them is how one gets treated as covered by the
  other's fix.**

  **Shape 1 — the fact one file writes and another trusts.** Needs two files
  read TOGETHER. `membersService.assign` is correct: an admin may manage their
  org's members. `userAdminService` is correct: it refuses users outside the
  actor's orgs. Neither file is wrong; the vulnerability is the EDGE — one
  writes the fact the other trusts — and an edge is in neither file, so no
  file-at-a-time review can see it, however careful. Adding reviewers does not
  help; they each read one file too. (F1, and F2's registry-as-allowlist.)
  **Countermeasure — a different question, asked of privileges rather than of
  code: enumerate what a privilege can DO, not who is granted it.** "Who may
  call `assign`?" has a correct, reassuring answer. "What can `assign`'s holder
  cause to become TRUE, and who else trusts that fact?" finds F1 immediately.
  Concretely: for each privilege, list the state it can WRITE; for each written
  fact, grep every guard that READS it; a guard reading a fact the privilege
  writes is a composition edge, and must be justified or closed. **This stays
  human — it is a data-flow question, and no stack introspection reveals it.**

  **Shape 2 — a guard that exempts a class from the thing designed to exclude
  it.** A route on the wrong side of a guard; a business route with no
  `requirePermission`; a privilege tier that widens because a mount moved one
  line. These are POSITIONAL facts about the middleware stack, not data-flow
  ones. **Countermeasure — `tests/privilege-surface-map.test.ts`**, which
  derives what each privilege reaches from the LIVE router stack and
  cross-checks it against the declared mounts, failing when either drifts.
  Verified by injecting both drifts: a business router moved above
  `requireAuth` (it appeared in the public tier) and one mounted with no
  permission guard (it appeared as bare). Both are one-line changes no reviewer
  would notice.

  🔴 **THE MAP WOULD NOT HAVE CAUGHT F1, and must never be cited as if it
  would.** Every route in F1 was mounted in the right tier behind the right
  guard — the map would have rendered both as perfectly placed, because they
  were. Shape 1 is data flow; the map measures position. Two shapes, two
  countermeasures, and only one of them is mechanical.

  🔴 **A hypothesised instance of shape 2 was checked and DOES NOT EXIST
  (2026-08-27):** that `assertOrgAdmin` exempts platform operators, letting an
  operator add themselves to a tenant as admin — the inversion of M11.3.
  Checked before building, per the referent rule below. `isOperator` /
  `platform_operators` appears in exactly FOUR places in the API —
  `lib/operator.ts`, `repositories/operators.repository.ts`, `routes/index.ts`,
  and a TRUNCATE list — and in NO authorization path, so `assertOrgAdmin` has
  no way to know an operator when it sees one. Confirmed behaviourally, not
  only by reading: `tests/operator-tenant-boundary.test.ts` has an operator
  attempt exactly that escalation (403, zero memberships after) across nine
  routes, with an anti-vacuity twin proving the same calls SUCCEED for the
  tenant's own admin. The claim is now a standing measurement rather than a
  doc-comment, which is the durable part of having checked.

- **🔴 A GUARD THAT TESTS A FACT ITS OWN CALLER CAN CREATE IS NOT A BOUNDARY**
  (F1, 2026-08-27 — cross-tenant account takeover, HIGH). M11.5.1 fixed
  "any admin can reset any user's password" by scoping the surface to users who
  **share an organization** with the actor. That predicate reads as a tenant
  boundary and is not one: `POST /orgs/:orgId/members` created a membership for
  any `userId` that EXISTED — no consent, no invitation, no email — and
  `users.id` is a `serial`, so ids are counted, not guessed. Any admin of any
  approved org could graft a stranger's account into their own org, then reset
  its password, then log in as them — **into every tenant that account reached**.
  The privilege that was self-grantable was not a role, it was MEMBERSHIP, and
  the guard that trusted it was the previous cross-tenant hotfix itself.
  **The test: for each fact a guard consults, ask who can WRITE that fact.** If
  the actor can, the guard measures the actor's own behaviour. The fix replaced
  overlap with **confinement** — the target's ENTIRE membership footprint must
  lie inside the actor's administered orgs — because an actor can cause overlap
  with one INSERT and cannot cause confinement at all (it would require deleting
  another tenant's membership). 🔴 A second lesson rides along: **the scoping
  question and the consent question were the same question wearing two hats.**
  `assign` grafting an account without its owner's consent looked like a
  usability wart; it was the exploit's first step. The consented path (M11.7
  invitations) existed the whole time.
  🔴 **And the meta-lesson, which is the expensive one: this was named twice in
  conversation and written down nowhere**, so it survived two sessions while
  lower-severity work shipped past it. A finding that lives only in a transcript
  is not tracked — it is remembered, until it isn't. **A HIGH goes into this file
  the moment it is named, before the session that named it ends** — even as one
  line with no fix attached.

- **🔴 FK CHECKS RUN OUTSIDE RLS — every plain FK between tenant-scoped
  tables is a cross-tenant edge no policy guards** (SECURITY finding,
  2026-08-23). Postgres evaluates FK constraints with the table owner's
  privileges, so `invoices.customer_id → customers(id)` ACCEPTED another
  tenant's id, and 23503-vs-success was an existence oracle across the whole
  platform — the RLS blind spot's sibling, in a place the RLS-policy sweep
  structurally could not see. Fixed with tenant-scoped pre-checks (422
  `reference_not_found`; under RLS, missing and other-tenant are the same
  fact). When auditing isolation, enumerate the FKs, not just the queries.
- **🔴 MAKE THE WRONG THING INEXPRESSIBLE, NOT FORBIDDEN** (AI-6a,
  2026-08-24, owner-named). The projection-assumption rule shipped as
  structure: the assumption sentences are TOOL OUTPUT and the verifier
  rejects an answer using the numbers without them — a skippable assumption
  is unrepresentable, not discouraged. Prior unnamed instances: the derived
  conversion axis (M21.1), the no-"fail" severity type (M18.3), the
  delete-less ArchiveStore, the structural receivables identity. When a
  rule matters, find the representation in which violating it cannot be
  SAID — construction outlives review, and only construction binds code not
  yet written.
- **🔴 A VERIFICATION IS A CLAIM ABOUT A MOMENT, NOT A PROPERTY OF THE
  TEXT** (AI-3b, 2026-08-24, owner-named). An explanation verified against
  yesterday's facts becomes a lie when the row refreshes — the text
  unchanged, the truth gone. Any validated artifact must STORE the identity
  of what it was checked against (AI-3b: a facts hash) and gate rendering on
  the match; a validation without a binding to its inputs ages into a false
  credential. Same decay family as the obsolete assertion, in a cache
  instead of a test.
- **🔴 AN INSTRUCTION'S REFERENT IS AN INPUT — CHECK IT AGAINST THE DATA,
  EVEN WHEN THE INSTRUCTION COMES FROM THE OWNER** (2026-08-24, recorded at
  the owner's instruction about their own message). A work order arrived for
  a milestone that did not exist — plausible, self-consistent, in the
  project's own vocabulary, grounded in nothing (the owner had answered a
  plan nobody proposed). The stop that caught it: the name matched no
  record, so the data was queried before any code, and the mismatch was
  REPORTED instead of built. Two standing policies from the same exchange:
  corrections ship NARROW and scoped (never a general re-run tool — a tenant
  cannot run a script), and a NAMED GAP that stays gapped beats a silent
  default that ages into being trusted.
- **🔴 A CLAIM INSIDE A MEASURING INSTRUMENT IS STILL A CLAIM — CHECK IT**
  (AI-2, 2026-08-23). The benchmark's `hard` flag ("the engine can't solve
  this alone") was authored by judgment; the engine solved 28 of them at
  ≥0.65, six from the ORIGINAL corpus — each padding the baseline the gate
  reads. And "20b decisively ahead" was nine cases talking: at 30 equal-N
  cases the order flipped. Both now enforced by
  `tests/benchmark-corpus.test.ts` (the flag is measured, the corpus cannot
  shrink below verdict-safe size); flags are set by measurement, but cases
  are never reworded until the engine fails them.

- **🔴 RENDERING A VALUE THE SYSTEM CANNOT COMPUTE WITH ADVERTISES SUPPORT
  THAT DOES NOT EXIST** (single-currency boundary, 2026-08-27, owner-named).
  Nine tables stored `currency` and no aggregate read it — zero references in
  `glPosting`, the reports/analytics/summary repositories and the VAT return —
  and no exchange rate existed anywhere in the schema or the services. So a
  USD row's bare number was summed into SAR totals and the filed return. The
  reflex fix is to render it honestly ("USD 1,000.00"), and it is the WRONG
  one: faithful rendering **converts a visible inconsistency into an endorsed
  one**, telling the user the platform handles multi-currency while the ledger
  adds dollars to riyals. When a stored value is displayed but never computed
  with, the honest move is to **refuse the value at the write boundary** —
  which is also what makes a hardcoded formatter correct rather than lucky.
  Sibling of the confident zero: a missing producer yields an answer rather
  than a gap; here a missing *consumer* yielded a label. 🔴 And the invariant
  already existed in exactly ONE path — `transactions.service` refused non-SAR
  statement rows (audit finding #4) while `bankAccounts.service` allowlisted
  `currency` with no validation and a free-text input wrote through it:
  *green fixes the case, not the class*, and the write boundary is where the
  class lives (migration 0062).


---

## 2026-08-30 — 🔴 THE FACADE DIRECTION: what two reachability guards structurally cannot see

**Recorded as a real gap, at the owner's instruction, rather than as a nuance.**

### What actually happened, dated

| When | What |
| --- | --- |
| 2026-07-19 | `CustomerReceipts.tsx` / `VendorReceipts.tsx` created. Each fetched an unmounted top-level path (`/customer-receipts`, `/vendor-receipts`) wrapped in `.catch(() => [])`, so both rendered as permanently empty lists. |
| 2026-08-14 | `route-reachability.test.ts` lands (`d31213d`) — the FORWARD guard: every mounted API route has a UI caller. |
| 2026-08-19/20 | The audit finds both pages **by hand**. |
| 2026-08-20 | `f00fb5f` / PR #57 deletes them **and adds the inverse guard in the same commit**. |

🔴 **The correction to the tempting summary.** It is not true that "a facade shipped
past two guards". The facades shipped past the guard that existed, which pointed
the other way; the guard that catches this class **was written as the
countermeasure for finding them by hand.** It is the scar, not the detector.
That distinction matters, because "our guards failed" invites tightening them,
while "the second guard did not exist yet" invites asking *what direction is
still uncovered* — which is the useful question.

### The direction, stated precisely

- **Forward** (`route-reachability`, first describe): *mounted route → does a UI
  call it?* Catches a backend nobody reaches.
- **Inverse** (same file, second describe): *client call → is the route mounted?*
  Catches a page calling something never written. **This is the facade check.**

Both start from an endpoint that EXISTS. Neither can see a control that renders
but reaches nothing, because there is no endpoint to enumerate from.

### 🔴 Four gaps measured in the inverse guard (2026-08-30)

1. **Prefix-only matching.** `backed()` accepts any path starting with a mounted
   top-level prefix; only `/reports/*` verifies sub-routes. So
   `apiFetch("/customers/123/receipts")` passes because `/customers` is mounted.
   **A facade nested under an existing resource is invisible** — the two that
   shipped were caught only because they claimed *top-level* paths, which is
   luck, not coverage.
2. **Interpolation truncates the check.** The regex captures the static leading
   path and stops at the first `${`, so `` `/customers/${id}/statement` ``
   is read as `/customers/` and prefix-matches. Every templated sub-path is
   effectively unchecked.
3. **No method check.** A page POSTing to a GET-only route passes.
4. **Only `apiFetch` is parsed.** At least ten pages use the generated client,
   invisible to this guard. Safer — a generated client can only name spec paths
   — but `openapi.yaml` binds nothing on its own (the AUD-13 lesson), so a
   spec-declared, never-mounted path slips past both.

### Is it mechanically checkable? — MOSTLY YES, and better than today

**Mechanically checkable (no browser needed):**

- Build the route table by walking the Express routers for **method + full path
  pattern**, not just `router.use` top-level mounts.
- Extract client calls with their **method**, and normalise interpolation to a
  pattern (`/customers/${id}` → `/customers/:param`).
- Match **patterns against patterns** instead of prefix-against-string.

That closes gaps 1–3 outright and turns the guard from "the prefix exists" into
"this exact endpoint, with this verb, is served". Adding the generated client's
call sites (gap 4) is the same exercise against the spec's path table, plus a
spec-vs-router diff to catch a declared-but-unmounted path.

**What still needs the browser (P5):**

- Whether the control that issues the call **renders and is reachable** — a
  correct call from a button nobody can see is still a dead feature.
- Whether the response is **used correctly** once it arrives (the AssetSchedule
  NaN class; `list-response-shape` covers list envelopes only).
- Paths assembled at **runtime** from variables — statically undecidable in
  general.

🔴 **The dividing line, reusable:** *does the call exist* is a static question and
should be answered statically to a much higher standard than it is today; *does
a user ever reach the thing that makes the call* is a rendering question and
nothing but a browser answers it. Today's guard sits at the weakest defensible
point on the first question, which is why it reads as coverage.

### A second finding, from the same session

**`list-response-shape.test.ts` gated its coverage check on a database it does
not use.** `scanDeclarations()` reads the WEB SOURCE — no query — yet the
assertion that detects the scanner going blind sat inside `describeMaybe`, so it
was skipped in every environment without `DATABASE_URL`, and a skipped test
still reports green. CI sets the variable, so the field assertions did run
there; the coverage half simply never ran locally, which is exactly when a
developer is most likely to trust a green suite.

🔴 **The vacuous-green pattern inside the instrument built to prevent it** — the
worst place for it, because the instrument is what everything else is trusted
against. Fixed 2026-08-30: the source-only check moved to its own ungated
`describe` and now runs everywhere; the DB-dependent assertions stay gated,
which is legitimate. Verified in both directions (1 passed / 4 skipped with no
DB; 5 passed with one).

**The reusable rule: a guard's gating must name the dependency each ASSERTION
uses, not the heaviest dependency anywhere in the file.** Gating at file scope
is how a check that needs nothing ends up needing Postgres.

---

## 2026-08-31 — 🔴 A STACK'S TIP IS NOT ITS BODY OF WORK

**Found while merging the 2026-08-28 → 30 work to `main`.** Nothing was lost;
the point is that the measurement which would have lost it looked authoritative.

### What happened

Five PRs had accumulated as a stack, each based on the one below:

```
main ← #101 fix/qa-b1-b2 ← #104 fix/triage-rank-1-and-2
     ← #105 fix/arabic-coverage-sweep ← #106 fix/list-response-shape
     ← #107 docs/rejected-alternatives-section   (checked out locally)
```

`git rev-list --count main..HEAD` from the checked-out tip reported **19
commits**, and that number was carried into the session's first status report as
the size of the body of work.

It was wrong. `fix/triage-rank-1-and-2` is **not an ancestor of the tip**:
`fix/arabic-coverage-sweep` had branched from it BEFORE its last commit landed.
`d2d6917` — 161 lines across `CLAUDE.md` and this file — existed only on that
branch. `git cherry` confirmed it was not upstream by patch-id, and **none of
its 105 substantive lines** appeared anywhere on the tip.

The real figure was **20**.

### Why the measurement could not see it

`main..tip` asks *what is reachable from the tip*. A commit on a lower branch
that never propagated upward is not reachable from the tip, so it is not merely
omitted from the count — **it is outside what the count can express.** No
amount of care in reading the number would have surfaced it, because the
number was answering a different question than the one being asked.

The two questions differ, and only one of them is the one anybody means:

| Question | Command | Answer here |
| --- | --- | --- |
| What is on the tip? | `git rev-list main..tip` | 19 |
| What is in the body of work? | union over every branch in the stack | 20 |

### 🔴 The second half: stack position does not imply chronology

The orphan was not a stale leftover from lower down. `d2d6917` (05:45) was
written BEFORE the tip's doc commits (06:45, 16:54) but was **the later
editorial pass on the sections it touched** — it tightened the AUD-1 lesson,
added P5's incident, gave rank 1 its decision options, and rewrote the Arabic
section to say the sweep had HAPPENED rather than that it was queued. The tip
branch, sitting three branches higher, still carried the older text of those
same sections because the edit had never travelled up.

So the instinct "lower in the stack means earlier, therefore superseded" is
exactly backwards here, and acting on it would have discarded the better text.

### What would have gone wrong

The tempting move — retarget the tip PR to `main` and merge it — drops
`d2d6917` **silently**. It is a documentation commit, so nothing would have
failed: no test, no typecheck, no reviewer. The operating file would simply have
carried the older version of five sections, and the loss would have been
invisible from the merge itself.

### Countermeasures

1. **Verify the chain before merging a stack.** For each adjacent pair,
   `git merge-base --is-ancestor <lower> <upper>` must hold. Where it does not,
   there is work only the lower branch has.
2. **Merge a stack with plain merges, bottom-up — never squash.** Squashing
   `#101` left the merge-base at the old `main`, so `#104` re-applied changes
   `main` already had: conflicts in twelve files. Plain merges preserved the
   ancestry and produced two fast-forwards, one clean merge, and one real
   conflict.
3. **`git cherry <upstream> <branch>` before assuming content is already
   upstream** — patch-id, not commit id, and it distinguishes "already there"
   from "looks similar".
4. 🔴 **`git checkout --theirs <file>` is not a hunk-level resolution.** Used on
   the one conflicted file here, it took the WHOLE file from one side and
   silently discarded every non-conflicting edit the other side had made —
   the merged result came out byte-identical to the tip, and the 26 lines it
   dropped were only noticed because they were counted afterwards. Resolve the
   conflict region; never let a file-level operation stand in for it.

### The reusable form

**When a body of work is distributed across a structure, a measurement taken
from one position in that structure describes that position, not the body.**
The count was not slightly wrong; it was answering a question nobody had asked.
This is the sampling lesson — *the report is a sample, not an inventory* —
pointed at the measuring command rather than at a defect report.

---

## 2026-08-30 — the measured `apiFetch<T>` class (moved here from CLAUDE.md §3)

**Recorded here so the §3 lesson can be one line, per eviction rule 2.** The
rule stays in the operating file; this is the incident behind it.

A hand-written `apiFetch<T>` interface is a claim nobody checks, and TypeScript
cannot check it against a real response. **Measured 2026-08-30: the claim was
wrong on FIVE pages, 18 fields.**

| Page | What it rendered |
| --- | --- |
| `AssetSchedule` | NaN in every money cell |
| `PayrollReport` | filtered on an absent `month`, so "no runs in this period" — always |
| `Customers` / `Vendors` | **Total AR/AP 0.00, forever** |

🔴 **Three of those are a plausible wrong answer rather than an error, which is
why none was ever reported.** A NaN gets noticed; a confident 0.00 does not.

**The countermeasure is mechanical and does not read the services.** The
response shape is built by spreads, so re-deriving it in the test would share
any defect the services have. `tests/list-response-shape.test.ts` seeds one row
per list, calls the REAL service, and compares `Object.keys` against what each
page declares.

It caught its own blind spot on day one: a changed call shape dropped pages out
of the scan, and the shrink-check went **red** rather than green over reduced
coverage. (Its coverage half was later ungated from `DATABASE_URL`, which had
been skipping that very assertion in every environment without a database.)

---

## 2026-08-31 — 🔴 THE LOST SCOPE: a link both ends of which are correct

**Found by clicking a link, in the session that built it.** It is recorded as
its own shape because neither class of guard this project owns can see it, and
the reason is structural rather than a gap in coverage.

### What happened

`CustomerDetail` offers "Open statement", linking to
`/reports/customer-ledger?customer_id=<id>`. Clicking it from Najd Contracting's
page opened the ledger report showing **all four customers** and a Total AR
Balance of SAR 75,330.00 — not Najd's SAR 37,265.00.

`CustomerLedger.tsx` initialised its filter with `useState("all")` and never
read the query string. The page had supported the filter all along; its own
dropdown sets it, and line 101 passes `customer_id` to the API. Only the
DEEP LINK was unwired.

### Why every check we own was green

| Check | What it saw | Why it passed |
| --- | --- | --- |
| Route reachability (forward) | `/reports/customer-ledger` is mounted and has a UI caller | true |
| Route reachability (inverse) | the page calls a route that exists | true |
| List-response shape guard | every field the page declares is sent by the service | true |
| Typecheck | a string passed in a URL | nothing to check |
| Console / network | six requests, all 200 | nothing failed |

**Both ends were correct in isolation.** The source built a well-formed URL
carrying the right id; the destination rendered correct figures for the set it
had. The defect lived in neither file — it lived in the **expectation the link
created and the destination did not honour**.

### 🔴 Why this is not the composition class, and not B-9

It is adjacent to both and identical to neither, which is the reason for a
separate entry:

- **The composition class** (AUD-13) is several findings whose CONSEQUENCES
  compound along one path. Here there is only one finding, and it compounds with
  nothing.
- **B-9** (a create form omitting a required field) produces a RECORD that no
  later step can act on. Here nothing is written at all.

The distinguishing property is that **the output is a true statement about the
wrong set.** The report was not broken; it answered a broader question than the
one the user asked, and presented the answer with the same confidence it would
have given the right one. That places it in the confident-zero family — except
that the number is not zero, it is simply about something else, which is harder
to notice, not easier.

### What would have caught it

Only following the link and checking what the destination shows. Concretely,
for P5's smoke crawl: **for every in-app link carrying a query parameter, assert
the destination reflects it** — the rendered heading, the selected control, or
the row count. That is mechanically checkable in a browser and invisible without
one.

The cheap version, available today and needing no infrastructure: when a link
carries context, click it once and read the destination. That is how this was
found, roughly ninety seconds after the page it links from first rendered.

### The reusable rule

**A link is a claim about what the destination will show.** Verify the claim at
the destination, not at the source — the source cannot be wrong about a
parameter it correctly sends, and the destination cannot be wrong about a
parameter it never reads.

---

## 2026-08-31 — the orphan shape in the DESIGN layer, and an instrument wrong before the code

Two findings from the token-layer pass, kept because each is a known class
appearing somewhere the class had not been looked for.

### 1. Five semantic tokens, defined and consumed by nobody

`index.css` defined `--color-income`, `--color-expense`, `--color-asset`,
`--color-liability` and `--color-equity`. `badge.tsx` turned them into five
`Badge` variants. **No page used any of them.** Measured across all 107 app
files outside `components/ui`: zero consumers.

Meanwhile **604** raw palette classes across **56** files did exactly that job
by hand.

This is *a shape without a consumer* — the first named lesson in CLAUDE.md §3 —
and everything that makes it hard to see applies here with extra force:

- It looks more like progress than most orphans. A design system with named
  semantic tokens reads as maturity, and the tokens were real, correct, and
  wired into a component. Only the last link was missing.
- **No guard could have seen it.** Route reachability watches routes; the shape
  guard watches response fields. Nothing watched CSS custom properties, because
  nobody had thought of the design layer as a place where the orphan shape
  lives.

🔴 **The reusable part: when a class of defect is named, ask which LAYERS have
been swept for it, and treat the unswept ones as unmeasured rather than clean.**
The orphan shape had been swept for in routes, columns, interfaces and flags.
The design layer had never been looked at, so its count was not low — it was
unknown, and it turned out to be five.

The countermeasure is in `design-token-adoption.test.ts`, which asserts each
token has a real consumer as well as ratcheting adoption.

### 2. 🔴 The instrument was wrong before the code was — again

Verifying that the new tokens rendered identically, the first probe created
elements at runtime and compared computed styles:

    text-emerald-400   -> text-positive            IDENTICAL
    text-emerald-500   -> text-positive-surface    *** DIFFERENT ***

The `-surface` result was **an artefact of the probe, not a defect.** Tailwind's
JIT generates utilities only for classes it finds in SOURCE. `text-positive`
existed in a converted file, so it was generated; `text-positive-surface`
existed nowhere, so the class was never emitted and the probe measured an
unstyled element. Re-probed with classes that appear in the source, all ten
pairs were identical.

**Second time this week** that a measuring instrument was wrong before the code
was — after the benchmark whose "hard" flag and headline verdict were both
authored and both wrong.

The rule already in §3 is *a claim inside a measuring instrument is still a
claim*. This adds the sharper corollary: **an instrument that CONSTRUCTS its own
inputs must construct them the way the system under test would.** A probe that
invents a class, a fixture that invents a row, a benchmark that invents a case —
each measures a path production never takes, and reports the difference as a
finding about the code.

The tell is worth naming because it is cheap: **the instrument disagreed with
itself.** Four pairs identical and four different, in a mechanism that treats all
eight the same way, is not a result — it is a reason to doubt the apparatus.

---

## 2026-08-31 — 🔴 A HARDENING STEP IS UNTESTED CODE ADDED AFTER THE TESTS PASSED

**Named at the owner's instruction**, alongside *a targeted fix sees only what it
was sent to fix*. The two are siblings: both are about the blind spot a change
carries with it, but they point in opposite directions in TIME.

### What happened

P5's browser suite ran green: **65 passed, exit 0**. Then, preparing the CI job,
a readiness wait was added to `global-setup.ts` so the login could not race the
API's start — a change made purely for reliability, on a suite that had just
demonstrated it worked.

It pointed at `/api/health`. **That route does not exist.** The health route is
mounted at `/api/healthz`; `/api/health` falls through to the authenticated
catch-all and answers 401 forever, so the wait could never succeed. The suite
went from green to unable to start.

The path was **assumed, not checked** — a referent error inside a change whose
entire purpose was to make the suite more trustworthy.

### Why the shape is worth naming separately

A targeted fix's blind spot is **spatial**: attention narrows to the defect being
hunted, so the file's other problems go unseen. That is why coverage questions
must be asked mechanically against the whole surface.

A hardening step's blind spot is **temporal**: it arrives *after* the evidence,
so the run that would have contradicted it has already happened. And it is
uniquely likely to escape re-running, because:

- it is not a feature, so it does not feel like it needs a test;
- it is small, and framed as risk-reduction;
- **the suite it modifies was green minutes ago**, which reads as licence.

The last is the trap. "It passed" was true of the code *before* the change, and
that truth is what makes re-running feel redundant precisely when it is not.

### The rule

**Re-run the thing you just hardened.** A change made for reliability earns no
exemption from the run that proves it — it needs that run *more* than a feature
does, because nobody will suspect it later. Its failure mode is not a wrong
answer but a suite that cannot start, which looks like infrastructure trouble
rather than a defect someone introduced.

### The corollary that caught it

This was found by CI, three minutes after the push, not by review. Two other
harness faults surfaced in the same run — a job-wide `PORT` that made vite bind
the API's port, and a hand-enumerated wipe that broke when a background job wrote
a `finding_runs` row. **All three were in the harness; none was in the product.**
That is the expected shape for a new test suite's first CI run, and it is an
argument for landing such a suite as a NON-REQUIRED check until it has been green
across real PRs — which is how P5's job was configured, before any of this
happened.

---

## 2026-08-31 — 🔴 RECONCILING A SPEC ENTRY BY ENTRY ANSWERS ONE DIRECTION ONLY

**Found by a mechanical assertion during the navigation build, not by reading** —
and the reading had been careful. `nav-tree-reconciliation.md` walked ~250 spec
entries one at a time, marked each BUILT / FILTER-OF / COMING SOON / DROPPED,
argued all thirteen drops, and was reviewed and approved. It was also, by
construction, incapable of finding this.

### What happened

The reconciliation asked, of every entry in the §4 specification: *does this
point at something real?* The new navigation tree was then built from the
answers. The first run of `e2e/nav-tree.spec.ts` failed on a check that asks the
opposite question — *is every real page still pointed at?* — and named five:

    /reports/account-statement
    /reports/account-summary
    /reports/owner-equity
    /reports/tax-journal-entries
    /reports/activity

Five real, working, tested report pages. The smoke crawl renders all five and
always had. They were absent from the §4 spec, so no amount of care spent
reconciling the spec could surface them — **there was nothing in the input to
reconcile them against.** Replacing the old navigation with the new tree would
have made all five unreachable in the same commit that made the navigation
"complete", and the pages would have kept passing every test in the repository
while no user could get to them.

### Why it is its own lesson and not an instance of an existing one

It is adjacent to *nothing in this process checks whether a USER can reach what
we built*, but it is sharper and more general: this was not an absent check, it
was a check pointed one way. The reconciliation's method was sound and its
output was correct. **A map-to-map reconciliation has two directions, and doing
one thoroughly gives no information at all about the other.**

The general form, which applies well beyond navigation:

> **Whenever one map replaces another — a route table, a permission matrix, a
> chart of accounts, a status vocabulary, a config schema — assert BOTH
> directions: every entry points at something, and everything is pointed at.**

The forward direction is the one people check, because it is the one the new map
is *for*. The reverse direction is where the losses are, because a thing that
falls out of a map leaves no trace in the map. It is the same asymmetry as
`tests/route-reachability.test.ts`'s two halves (every mounted route has a
terminus; every URL the web calls is mounted), which exists for exactly this
reason and had already earned itself once.

### The countermeasure

`e2e/nav-tree.spec.ts`, *every crawlable route is reachable from the
navigation*: the declared routes minus an EXEMPT list, each exemption carrying a
reason. It is deliberately the inverse of the check beside it, and the two are
named as a pair so neither reads as sufficient alone.

---

## 2026-08-31 — copying a check's SHAPE without its TIMING reproduces the check, not its meaning

A smaller one from the same build, kept because it cost fourteen red tests and
three minutes of believing the product was broken.

`nav-tree.spec.ts` needed "the page rendered something", a check `smoke-crawl`
already had. The shape was copied — `goto`, read `<main>`, assert the text is
longer than 20 characters — but with `waitUntil: "domcontentloaded"` instead of
`"networkidle"`. Fourteen data-driven pages were still showing **"Loading…"**
— eight characters — at that moment. Fourteen failures, not one a defect.

The original had `networkidle` for a reason nobody had written down, because to
its author it was not a decision. **A check is its assertion AND the moment it
is taken; copying only the assertion produces something that looks identical and
measures a different instant.** Same family as the vacuous-green lesson: the
instrument disagreed with the code, and the instrument was wrong.

🔴 The second half is the more useful one. Once the timing was fixed, the check
**bought nothing** — every destination it crawled was already crawled harder by
`smoke-crawl`, with console-error and 5xx assertions on top. Sixty duplicate
page loads had tripled the suite's runtime for a second opinion on covered
pages, and a slow suite is one people learn to skip. It was replaced by an
assertion on the EDGE between the two existing checks (*every navigation
destination is a route the smoke crawl renders*), which is the composition
stated in code rather than assumed — the deliberate opposite of the
*two correct assertions with a gap between them* shape.

---

## 2026-08-31 — 🔴 P5 JUSTIFIED ITSELF ON ITS FIRST REAL RUN: THE UNKEYED FRAGMENT

**Owner-named**, and worth recording precisely because it is unspectacular. The
browser suite's first red on a real PR was not an exotic integration failure. It
was this, in `AuditTrail.tsx`:

```tsx
{logs.map((l) => (
  <>                              {/* ← the array element. No key. */}
    <tr key={l.id}> … </tr>       {/* ← keys, on the wrong nodes */}
    {expanded === l.id && <tr key={`${l.id}-detail`}> … </tr>}
  </>
))}
```

Every key present, every key on a child *inside* the fragment, and the element
React actually keys — the fragment itself — carrying none. TypeScript is content:
a fragment takes no required props. ESLint's `react/jsx-key` does not fire on a
shorthand `<>` in this position. The page renders, the rows are correct, the
data is right. **The only artefact is a console error, and the only thing in
this repository that reads a console is a browser.**

That is the whole argument for P5 in one defect. 1,100+ tests call services with
hand-built objects; not one of them mounts a component. The scoreboard in §5 —
*found by a browser: six real defects; found by 1,179 tests: none of them* —
gained an entry on the suite's first genuine run, in a file that had been
reviewed and shipped.

### 🔴 AND THE SECOND HALF, WHICH IS THE LARGER FINDING

Sweeping the shape rather than the instance (§3) turned up **two more identical
maps**: `TrialBalance.tsx` and `reports/AccountSummary.tsx`, both
`typeOrder.filter(t => byType[t]?.length > 0).map(type => <>`.

**Both pages passed the crawl.** Not because they were correct — they had the
same defect — but because the seeded organisation has no account rows of those
types, so `filter(length > 0)` yields an empty array, the map never executes,
and React is never asked to key anything.

**A test that passes because the code under it never ran is not a passing test.**
It is a vacuous green wearing a passing test's clothes, and it is indistinguishable
from a real pass in every report we produce. This is the fixture-scale blindness
already recorded — *our verification is structurally blind to volume and
collision* — arriving in a THIRD place: not a count off a capped list, not an
identity built from colliding values, but **a rendering branch no fixture is
large enough to enter.**

The generalisation is worth stating on its own, because it is the one that keeps
catching us:

> **Our fixtures are small, and small fixtures do not merely test less — they
> test differently.** A guard whose subject is reached only under data we never
> seed reports on nothing while reporting success. Ask of any new check: *what
> data does this need in order to execute at all, and does our fixture supply
> it?*

The reported instance was, once again, the least dangerous of the three: the one
that happened to sit on a page the fixture populates.

---

## 2026-08-31 — B-8: NOT REPRODUCED, AND THE NEGATIVE IS THE RESULT

`e2e/rtl-direction.spec.ts` runs the mechanism B-8's own lesson named — *test
that it survives a route change* — and `<html dir>` holds. Five tests: toggle to
Arabic then walk five routes across sections **by clicking**; a full reload; a
route change *after* a reload (the composition most likely to catch a provider
that only re-applies `dir` in its own click handler); and a switch back to
English, asserting the value MOVES rather than merely equalling "rtl".

🔴 **The search shape, so the negative is reviewable rather than merely
asserted:** exactly one writer of `document.documentElement.dir` in application
code (`LanguageContext.tsx:52`); no package under `@radix-ui`, `vaul` or `cmdk`
writes `documentElement.dir` or `documentElement.setAttribute`; navigation is
performed by clicking because a `goto` is a document load that remounts the
provider and would repair the loss before it could be observed. **What would
falsify the negative:** a loss on a surface not on that walk, one triggered by a
portal or dialog, or a path that unmounts the provider.

**B-8 is not closed — it is tested.** That is a better state than
"unreproduced", and the distinction matters: the guard earns its place whether
or not the original report was real, because the CLASS is real. A value the
framework does not own, written once and never re-asserted, is a hope. The
observation half now exists.

### Found on the way

`apps/web/index.html` carries `lang="en"` and **no `dir` attribute at all**.
Nothing is *lost* — it was never set — so this is not B-8; but every load paints
left-to-right until the provider's effect runs, which is a real RTL defect
against a launch requirement. The fix is an inline script reading `ksa_lang`
before first paint, and that is a decision about render-blocking scripts, so it
is flagged rather than taken.

---

## 2026-08-31 — RTL BEFORE FIRST PAINT, and the decision recorded so it survives

`index.html` shipped `lang="en"` and no `dir`. Direction was applied by
`LanguageContext`'s mount effect — after the bundle is fetched, parsed and
executed — so **every load painted left-to-right and flipped once React woke
up.** For an Arabic user that is a visible flash on every page load, against a
stated launch requirement, and it cannot be fixed from inside React: by the time
any component runs, the first paint has happened.

**Owner decision, 2026-08-31: take the render-blocking script.** Read one
localStorage key, set `dir` and `lang`, nothing else. Blocking is the entire
point — a script that does not block cannot beat the paint it exists to correct
— and the cost is one synchronous read of one key.

🔴 **Why it is recorded rather than merely written.** A tiny inline script in
`index.html` is exactly the thing a future contributor deletes as an oddity
during a cleanup: it looks like a stray, it duplicates something React appears
to do already, and removing it breaks nothing any test would notice — the app
still ends up in the right direction a few hundred milliseconds later. So it
carries its own comment block AND a test that fails on its removal.

**The test only works because of when it looks.** `waitUntil: "commit"` — the
moment the HTML starts arriving, after head scripts and before the module
bundle. Any later wait (`load`, `domcontentloaded`, `networkidle`) gives React
time to mount, the provider's effect sets `dir` correctly, and the test passes
whether or not the inline script exists. Same shape as clicking-versus-`goto`
in the B-8 tests one file over: **a check taken at the wrong moment reproduces
the assertion and not its meaning, and reports the identical green either way.**
Verified by disabling the script and watching the test go red.

---

## 2026-08-31 — 🔴 HOW MUCH OF THE PRODUCT DOES THE FIXTURE ACTUALLY REACH? MEASURED.

Asked as a direct question by the owner after the unkeyed-fragment sweep, whose
second and larger half was that **two pages passed the crawl because the seeded
org has no rows of those types** — the map never executed, so React was never
asked to key anything.

### The measurement

Three numbers, all taken rather than estimated.

**1. Tables.** Of the tenant-scoped business tables, the browser fixture
populates **11** and leaves **40** empty:

    populated  ai_usage, audit_logs, bills, categories, companies, customers,
               finding_runs, findings, invoices, organization_memberships,
               vendors
    empty      bank_accounts, bill_items, bill_payments, branches, budgets,
               captured_documents, departments, depreciation_entries,
               document_number_counters, einvoice_archive, einvoice_documents,
               employees, feature_flags, finding_schedules, fixed_assets,
               grounded_answers, invoice_items, invoice_number_counters,
               invoice_payments, journal_entries, journal_entry_lines,
               organization_invitations, payroll_items, payroll_runs,
               period_locks, products, purchase_order_conversion_items,
               purchase_order_conversions, purchase_order_items,
               purchase_orders, quotation_conversion_items,
               quotation_conversions, quotation_items, quotations,
               recurring_rules, recurring_runs, security_audit_logs,
               transactions, verification_documents, verification_reviews

🔴 **`invoice_items` and `bill_items` are among the empty ones.** The four
seeded invoices have NO LINES, so every render path that maps over a document's
lines is unexecuted — on the document type that carries the ZATCA chain.

**2. Render sites.** 123 data-driven `.map(` render sites across 58 files in
`apps/web/src` (excluding the vendored `components/ui`).

**3. Reach.** Visiting every crawled app route and counting rendered rows:
**17 of 54 render at least one row; 37 render none.** Those 37 satisfy the
crawl's "the body has more than 20 characters" assertion with an empty-state
message and a heading. They are covered by the smoke crawl and have none of
their row-rendering code executed.

### 🔴 The honest limit, which is the part that matters

**This bounds the problem; it does not enumerate it, and it cannot.** A vacuous
pass is indistinguishable from a real pass in every report the suite produces —
that is the defining property of the defect, not an accident of our tooling. No
measurement taken *from inside* the suite can list the branches that were never
entered, because the suite has no way to distinguish "this assertion held" from
"this assertion was never reached". Coverage instrumentation would narrow it
further and still not close it: a line can execute with data too uniform to
expose a collision, which is the other half of the same disease.

So the answer to *what else is only reached under data we never seed* is:
**most of the product's list-rendering code, and we can bound that but not
enumerate it.** The measurable proxy is the reach number above.

### What it argues for

The queued **scale-and-collision fixture** — larger than every cap and
deliberately degenerate — with one addition this measurement makes obvious:
it must also be *broad*. The existing scale work targets volume and collision
on the entities we already seed. What this shows is a third axis: **40 tables
with nothing in them at all.** Volume on four entities does not enter the render
paths of the thirty-seven routes that currently show an empty state.

Re-deriving these numbers takes one probe run against the e2e org; the method is
recorded here rather than left as a standing always-passing test, because a test
that cannot fail is noise in a suite whose whole value is its verdict.

---

## 2026-08-31 — 🔴 A DESIGN RATIONALE AGES FASTER THAN A CAVEAT

**Owner-named**, from measuring the HLD rewrite rather than assuming it. The old
`docs/hld.md` was **four days old** when it was replaced, and the drift split
cleanly along one line.

### What had NOT rotted

Every passage stating a LIMIT was still exactly right. §7's "what is proven and
what is not" against ZATCA — the sandbox verifications, the never-submitted
production path, the local-only archive and transport — held perfectly. So did
the deployment posture, the blocked-on-a-registration framing, and the sandbox
traps.

That is not luck. **A caveat describes a fact about the world that only changes
when the world changes**, and these facts were gated on a company registration
that had not happened.

### What HAD rotted

Every passage explaining **why the design is right**.

The clearest case is also the document's most confidently argued section. §3.2
presented the information architecture with a diagram of eight sidebar
destinations and stated:

> Automation and AI have **no navigation entry of their own**, and that is the
> design rather than an omission

followed by three bullets defending it — a recurring rule is a property *of an
invoice*; an AI suggestion is useful only at the moment of the decision it
informs; every additional entry is something a small-business owner must learn.
It closed: *"The measure of success is that the user does not think about them."*

The owner reversed that decision on 2026-08-31. The shipped navigation has an
**AI & Automation section**. So the most rhetorically committed passage in the
document described **the opposite of what ships**, four days after being
written — and a reader had no way to tell, because the argument reads as
settled reasoning rather than as a claim with a date on it.

Also rotted, and all in the same category: a hardcoded test count, an RTL
occurrence count, and a measurement quoted without a re-measurement trigger.

### 🔴 Why this happens, and the countermeasure that follows from it

A rationale is a *re-statement of a decision taken elsewhere*. The moment a
document explains why a decision is right, it has become a **second writer for
that decision** — and the one-writer rule says the copies drift. The copy that
drifts is always the one nobody is watching, which is the document, because the
decision record is what people edit when they change their minds.

> **A rationale POINTS AT the decision record instead of restating the
> argument.** Revisiting the decision then updates one place, not two.

Applied in the rewrite: where the new HLD needs to convey *why*, it states the
constraint in one line and names the record — and where it states a design
property, it states it as a property rather than as an argument for it.

---

## 2026-08-31 — 🔴 A READER CANNOT DETECT AN ABSENCE

**Owner-named**, and the sharper half of the same finding — sharper because it
defeats the reader's own care.

The old HLD's *wrong* statements were at least findable. Someone who knew the
system could read the AI-navigation section and say "that changed". Its
**omissions** were invisible by construction: nothing in a document hints at the
section that was never written, and no amount of careful reading recovers it.

### The example that makes the case

**G-1.** A hypothesised privilege escalation — that `assertOrgAdmin` might exempt
platform operators, letting an operator add themselves to a tenant as an admin —
was investigated and found **not to exist**. Operator status is consulted in four
places, none of them an authorization path, and the boundary is now pinned
*behaviourally* by `tests/operator-tenant-boundary.test.ts`.

That is precisely what someone performing technical diligence wants to see: not
just "we have a boundary" but "we hypothesised its most plausible failure,
checked, and pinned the answer". **The document simply did not have it.** Nor
did it have the derived-status decisions, the single-currency write boundary,
the unscoped-`db` refusal, or the guard set as a set.

A reader would have finished the old HLD with an accurate impression of
everything it mentioned and no signal at all about what it left out.

### The countermeasure

> **A document whose job is COMPLETENESS is generated from, or checked against,
> a list of what it must cover — never written from memory of what matters.**

Memory produces the sections the author was thinking about that week, which is
exactly the selection bias that omitted a security result from a security
section. The coverage list is the artifact to maintain; the prose is checked
against it. The list for the HLD is the brief it was rewritten to: product,
architecture, tenancy and security including the operator boundary, the data
model, ZATCA, the AI layer with its constraints and dark status, the guard set,
external dependencies and provider seams, and deployment posture.

**The general form:** for anything meant to be complete — a design document, a
migration checklist, an audit scope, a release note — the enumeration is the
work, and the prose is the rendering of it. Writing prose first and hoping the
enumeration falls out reverses the dependency, and the failure mode is silent.

---

## 2026-08-31 — 🔴 A GUARDRAIL DESIGNED TO KILL A TRANSACTION WAS KILLING THE SERVER

**Owner-named as the widest-reach finding of the breadth pass**, and it is,
because the amplifier is not specific to the bug that revealed it.

### The chain

Breadth gave the scheduled findings run real work for the first time. It calls
the AI provider once per open finding — **inside an open tenant transaction**.
The deliberate `idle_in_transaction_session_timeout = '15s'` guardrail fired,
exactly as designed, and terminated the connection.

`node-postgres` then emitted `error` on the client. **An `error` event with no
listener is fatal in Node** (`throw er; // Unhandled 'error' event`). The API
process exited, and every request after it was ECONNREFUSED. 62 of 153 browser
tests failed, not one of them for the reason it named.

> **A defence designed to kill a TRANSACTION was killing the SERVER.**

### 🔴 Why the reach is wide

The amplifier sits behind *every* mechanism that works by severing something —
a timeout, an abort, a socket destroy, a backend termination, a failover, a
restart, an operator running `pg_terminate_backend`. None of those is exotic.
The guardrail here was one of the good ones: deliberate, documented, and the
reason the e-invoice outbox exists. **The better the defence, the more often it
fires, and the more often the amplifier gets its chance.**

The question to ask of any severance:

> **When this deliberately terminates something, does an unhandled event on the
> severed thing take down more than was intended?**

### 🔴 THE SECOND TRAP: STANDARD ADVICE APPLIED WITHOUT CHECKING WHICH CASE YOU HAVE

The recommended fix for this in `pg` is `pool.on("error", …)`. It was applied,
with a considered comment, and believed correct.

**The next full browser run crashed identically.**

`pool.on("error")` covers clients sitting **idle** in the pool. A client that is
**checked out** emits `error` on itself, the pool does not forward it, and the
process still dies. The tenant connection is checked out for the whole
transaction — the exact window in which the guardrail fires.

Two lessons, and the second is the general one:

1. *Re-run the thing you just hardened* — already a standing rule, here earning
   itself against a fix written **for** that rule's own class.
2. 🔴 **Standard advice applied without checking which case you have is its own
   trap.** The advice was not wrong; it addressed the other half. It looked
   right, it is what every guide says, and it left the defect fully intact —
   which is worse than not fixing it, because the comment beside it now asserted
   the problem was handled.

### The sweep, and its result

Swept the shape rather than the instance (§3). Every deliberate severance in
`apps/api/src` and `packages/db/src`:

| Severance point | Verdict |
| --- | --- |
| tenant connection (`LazyTenantClient`) vs the idle-in-transaction guardrail | 🔴 **was the bug** — listener now on the checked-out client |
| `demoReset.service.ts` — a long TRUNCATE transaction on a scheduled job | 🔴 **second instance, found by the sweep** — same shape, no listener; fixed |
| `pool` / `sessionPool` idle clients | guarded |
| `ClamdScanner` socket destroy | **correct** — `socket.on("error")` is registered before any destroy path |
| AI provider request timeout (`AbortController`) | **needs no guard** — aborting a `fetch` rejects a promise, and a rejection has a caller; there is no emitter to leave unlistened |
| `SIGTERM`/`SIGINT` → `server.close()` | shutdown, not a severance of a subordinate |

The reported instance was, again, not the only one. **Countermeasure:**
`tests/severance-amplifier.test.ts` asserts the property structurally — every
`pool.connect()` attaches a client error listener, every Pool has an idle
handler, every deliberately destroyed socket has an error listener — and
records the points that need no guard, so *"we checked and there was nothing to
guard"* stays distinguishable from *"we did not look"*. Fault-injected: removing
the demo-reset listener turns it red and names the file.

### The pipeline change this leaves open

🔴 **The AI call inside the tenant transaction is BLOCKING before the AI layer
is enabled — not merely latent.** The e-invoice outbox exists precisely because
*a synchronous call to an external API cannot live inside the request
transaction*; the findings run repeats that solved problem with a different
external API. It is invisible today only because the layer is dark. Enabling
Groq without moving the call out re-lights a defect the project already knows
how to fix. Tracked in `CLAUDE.md` §5.

---

## 2026-08-31 — 🔴 A HAND-WRITTEN INTERFACE TYPESCRIPT CANNOT CHECK, AND WHY THIS ONE WAS HAND-WRITTEN

`TrialBalance.tsx` declared:

```ts
interface TrialBalanceRow { id: number | null; name: string; … }
```

and the API has never sent `id`. `reports.service.ts` returns **`accountId`**.
So `row.id` was `undefined` on every row, and `<tr key={row.id}>` gave every row
in the table the same key.

**The React warning is the visible part. The wrong number is the real one.**
Rows sharing a key can be mis-reconciled on re-render: change the date range and
a figure computed for the previous range can be left sitting in a row that now
belongs to a different account. In the one report whose entire purpose is that
it adds up, presented with no error at all.

### 🔴 Would generated types have caught it? Yes — and the reason they did not is measurable

Unambiguously yes. The defect is a declared field name that the response does
not contain, which is precisely what codegen eliminates by construction: there
is no second declaration to drift.

**Why this interface was hand-written: there was nothing to generate from.**

    report endpoints mounted:            15
    report endpoints in openapi.yaml:     1   (/reports/vat-return)

`/reports/trial-balance` is not in the contract. Neither are the general ledger,
the balance sheet, the income statement, the cash flow statement, AR/AP aging,
the customer ledger, owner's equity, the journal report, the account statement,
the account summary, activity, or tax journal entries. Every page consuming them
*must* hand-write its interface, because the generated client has no type for a
path the spec never declared.

The wider measurement, for scope:

    page files using hand-written apiFetch:      53
    page files using the generated client:        8

🔴 **So "OpenAPI-first with codegen" is real for the CRUD surface and largely
absent for reports — and reports are where the money figures live.** That is not
a rule being violated; it is a rule whose coverage nobody had measured. The
`list-response-shape` guard exists for exactly this class and covers four
envelope endpoints, none of them a report.

**Both defects in this report were unreachable before this week**, and the
sentence is the argument for breadth in one line: *with no journal lines, the
table and the total were both empty and agreed perfectly.*

---

## 2026-08-31 — CONTRACT COVERAGE: "OpenAPI-first" DESCRIBES THE CONTRACT, NOT THE FRONTEND

Scoped at the owner's request after the trial-balance defect, and **measured
rather than estimated** — the answer is broader than the reports framing that
prompted it.

### The measurement

Every endpoint the web calls through the hand-written `apiFetch`, normalised to
the spec's `{param}` shape, compared against every path `openapi.yaml` declares:

    paths declared in openapi.yaml            81

    distinct endpoints called via apiFetch   104
      of which IN the spec                    35
      of which NOT in the spec                69
        …report-shaped                        14
        …ORDINARY CRUD                        55

    web files importing the generated client  12
    web files calling apiFetch                53

*(A handful of the 104 are normalisation artifacts of template literals that
begin with an interpolation. The magnitude is the finding, not the exact count.)*

### 🔴 What it means, plainly

The gap is **not** a reports problem. Reports are 14 of 69. The other 55 are the
core of the product:

    /invoices/{id}/pay      /bills/{id}/post        /journal-entries/{id}/reverse
    /journal-entries/{id}   /customers              /vendors
    /products               /employees              /payroll
    /assets/{id}/depreciate /bank-accounts          /budgets/{id}
    /orgs/*                 /auth/*                 /operator/*
    /onboarding/*           /invitations/*

And the second number matters as much as the first: **even for the 35 endpoints
the spec DOES declare, the web mostly hand-writes the type anyway** — 12 files
use the generated client against 53 that call `apiFetch`.

> **"OpenAPI-first with codegen" is an accurate description of the contract and
> an inaccurate description of how the frontend consumes it.**

That is worth stating in exactly those words because the rule is written in the
operating file as though it governs both, and a reader — including a future
contributor deciding how to add a page — would reasonably conclude the generated
client is the norm. It is the exception.

### Why it is the largest of the four coverage gaps

The other three are audits: they establish whether something already true is
true. This one is a **standing defect generator**. Every hand-written interface
is an independent claim about a response that nothing checks, and TypeScript
cannot help — it checks the declaration against the *component*, never against
the API. `tests/list-response-shape.test.ts` exists for this class and covers
four envelope endpoints.

The trial balance is the worked example and it produced a wrong figure: a
declared `id` the response never contained, on a money report, mis-keying rows
so a re-render could leave a figure from one date range sitting in a row that
belongs to a different account.

### Scope of the work (owner-sequenced AFTER the three bounded gaps)

1. **Bring the endpoints into `openapi.yaml`.** The mechanical part, and the
   bulk of the effort. Response schemas must be written from what the services
   actually return, not from the hand-written interfaces — those are the thing
   under suspicion, and copying them forward would launder the defect into the
   contract.
2. **Regenerate** the client and Zod schemas.
3. **Replace the hand-written interfaces**, page by page, with generated types.
   Each replacement is where a mismatch surfaces; expect more `id`/`accountId`
   discoveries, and treat each as a finding rather than a merge conflict.
4. **Then the constraint question.** 🔴 A declared constraint still binds
   nothing — these routes pass `req.body` to services directly. Bringing paths
   into the contract makes the TYPES real; it does not make `minItems` real.
   Deciding whether to generate request validation from the contract is a
   separate decision, and leaving it undecided would recreate the
   spec-constraint-that-is-not-enforced trap at a larger scale.

**Cost:** a milestone, not a pass — call it comparable to a mid-sized feature
milestone. The endpoint count is the visible part; step 3 is where the time
goes, because every mismatch found is a real defect to understand rather than a
mechanical substitution. Step 1 alone is bounded and could land first, but on
its own it buys documentation, not safety: **the safety arrives only when the
frontend consumes the generated types.**

---

## 2026-08-31 — THE THREE COVERAGE GAPS, AUDITED

`CLAUDE.md` §5 had listed four things the audits could not see. Three were
bounded and are now closed. One of the three found something real.

### 1. Permission-matrix seed grants — clean

**The gap:** enforcement was audited (`requirePermission` is the single seam,
the privilege surface map checks routes sit on the right side of it); the
GRANTS never were. **A guard that correctly consults a matrix is worth nothing
if the matrix says the wrong thing** — and those are different questions, so
passing the first says nothing about the second.

Three failure directions, none visible to enforcement testing: OVER-GRANT (a
role holds an action it must not — silent, the wrong person simply succeeds),
UNDER-GRANT (a guarded route with no grant — a permanent 403 on a working
feature, loud for the user and invisible to us), and DEAD POLICY (a grant for a
resource nothing guards — harmless today, and it reads as deliberate policy to
whoever adds the route later).

**Result: clean.** Viewer holds `read` and nothing else. Bookkeeper never holds
`approve` or `delete` — the separation the four-role model exists for, given
that `approve` gates posting to the ledger, paying a bill, and issuing a ZATCA
tax document. `delete` is admin-only everywhere. Period locks are admin-only in
both directions. And the DATABASE rows are asserted to match the code that
defines them, because `requirePermission` reads the table, not the file.

🔴 **The check improved by failing first.** Its first draft asserted "every
guarded resource is readable by every role" and went red on two: `audit_logs`
(admin-only by design) and `categorize` (an action endpoint with no read route).
Both are deliberate and both are now NAMED with their reasons, which is the
distinction the matrix stated in prose and nothing verified. An unexplained
exemption is indistinguishable from a suppressed finding.

### 2. 🔴 Same-org cross-company isolation — AUDITED, AND THE ANSWER IS NO

**The question nobody had asked:** an organization is the tenant and the unit of
RLS; a company is the reporting entity inside it, with its own document
sequences, fiscal calendar and period locks. Two companies in one organization
are **separate sets of books**. Does anything stop a request scoped to company A
from reading company B's rows?

**No — not at the database level.** `app.current_company_id` is used only as a
column DEFAULT. It appears in **no policy's `USING` or `WITH CHECK` clause**;
every `tenant_isolation` policy tests `organization_id` alone. Verified from
`pg_policies` rather than from a migration file, and demonstrated: a connection
scoped to company A returns both companies' invoices.

So separation is enforced **per query, in the repositories** — exactly the shape
§4 warns about: *per-path enforcement is per-path review, and a new path starts
at zero.*

🔴 **And the exposure is not theoretical. Fifteen repositories query
company-scoped tables and never mention company at all:**

    reports      transactions, invoices, invoice_items, bills, bill_items,
                 journal_entries, journal_entry_lines
    analytics    journal_entries, journal_entry_lines, transactions,
                 invoices, bills
    journalEntries · bills · transactions · payments · payroll · assets ·
    budgets · bankAccounts · employees · categorize · summary · customers ·
    vendors

**For an organization with two companies, the trial balance, the general
ledger, the income statement, the balance sheet, the VAT return and analytics
add both companies' books together and present the result as one entity's
figures.** Not a leak between tenants — for an accounting product, arguably
worse: a confident, wrong, auditable number, with nothing on the page saying it
spans two sets of books.

**Multi-company is a shipped feature (M11).** This is the narrower-claim shape
at the level of a whole capability: the model supports two companies and the
reporting does not separate them.

🔴 **Recorded, not "fixed", and deliberately.** Company-scoping every policy is
a schema-wide change whose failure mode is an empty report rather than an error,
and it would break the org-level reads that legitimately span companies (the
operator surface, org settings, anything aggregating across the tenant). That is
a design decision with an owner. What the test does is make the situation
**impossible to be wrong about** — the list is pinned so it can only shrink, and
nobody can read "RLS is enforced" and conclude companies are isolated by the
database.

### 3. Git-history secret scanning — clean

**The gap:** the repository had only ever been checked with prefix and pickaxe
searches, which find a string you already suspect and nothing you do not.

First full gitleaks pass: **380 commits, ~21.5 MB, 4 findings, all four false
positives.**

- Three `jwt` matches in the CI workflow. Verified by **decoding the claims
  rather than assuming**: `iss: "supabase-demo"`, the keys Supabase publishes
  for every local `supabase start` stack — identical on every machine and valid
  against nothing but a local container. Also already removed from the current
  workflow; the findings are historical.
- One `generic-api-key`: a literal `X-API-Key:` header in a REST-design
  documentation example.

**No real credential has ever been committed.** The reasons live in
`.gitleaks.toml` so a future scan does not re-report a resolved judgement as a
new finding, and it is now a standing CI job.

🔴 **`fetch-depth: 0` is the whole point of that job.** The default shallow
checkout scans one commit, which would make it a diff check wearing a history
check's name — and the finding it exists for is a credential committed once and
removed later, which a shallow scan cannot see by construction.

---

## 2026-08-31 — THE RTL DECISION: THE THIRD OPTION, AND THE EXCLUSION LIST THAT DECIDES IT

The RTL question had been open in PR #112 with two costed options, neither of
which was the answer:

| Option | Cost | Why it was not taken |
| --- | --- | --- |
| Own the vendored components | 127 occurrences across 26 files | Converting code we deliberately do not own, then re-doing it when the redesign lands |
| Defer to the redesign | none now | RTL is a LAUNCH requirement and the redesign has no date |

**The third option, proposed by an external report and taken by the owner:** an
override CSS layer keyed on the UTILITY rather than the component. The unit of
work becomes the utility class, so the cost is **39 distinct utilities** rather
than 127 occurrences or 26 files. It touches no vendored file and is deleted
whole when the redesign owns those components.

### 🔴 The exclusion list is what makes it safe, and it is not optional

The obvious version — flip every `left`/`right` utility — is wrong, visibly, in
the language the change exists for. Only **24 of the 39 are unambiguously
directional**. Two ways the blunt version breaks:

1. **Centring is not direction.** `left-[50%]` / `left-1/2` is always paired
   with `-translate-x-1/2` — in `dialog`, `alert-dialog`, `carousel`,
   `resizable` and `sidebar`. Centred is centred in both directions; flipping it
   moves every modal off-centre in Arabic and nowhere else.
2. **The same utility is directional in one component and geometric in
   another.** `left-0` is directional in `navigation-menu` and `sidebar`, and
   geometric in `resizable`, where it resets the handle for a *vertical* panel
   group. A global rule cannot tell them apart, because CSS sees the class and
   not the intent.

So the layer flips 24 (padding, margin, radius, border — where most of the
visual wrongness lives) and leaves 15 positioning utilities to a hand audit.
🔴 **An unflipped padding looks slightly wrong; a wrongly flipped dialog looks
broken.** That asymmetry is the whole argument for stopping short.

Animation utilities (`slide-in-from-left-*`) are out of scope *by construction*:
they compile to translate transforms, not `left`/`right` properties, so nothing
in this layer can reach them.

Verified in a real browser: with `dir="rtl"`, `pl-8` computes to
`padding-left: 0; padding-right: 32px`.

### 🔴 AND THE GUARD WAS VACUOUS TWICE — CAUGHT ONLY BY FAULT-INJECTING IT

The test pinning the exclusions passed green while failing to check anything, in
two different ways, one after the other:

**First:** its patterns were built with `new RegExp` from template literals, and
the heredoc that wrote the file collapsed the escapes — `\b` became `\b`, which
in a JS template literal is a **backspace character**, not a word boundary.
Every pattern matched nothing, so both exclusion assertions passed *and would
have passed with every excluded utility present*. Only the **paired presence
assertion** — "the layer does flip the safe ones" — went red and exposed it.

**Second, after that fix:** the matcher used a literal string search, and a CSS
class containing `/`, `.`, `[`, `]` or `%` **must be escaped in a selector** —
`left-1/2` is written `.left-1\/2`. Searching for `.left-1/2` matched nothing.
The exclusion assertions passed again *while a flip for an excluded utility sat
three lines above them in the same file*. Caught by adding that forbidden rule
deliberately and watching the suite stay green.

Two lessons, both already in §3 and both earning themselves here:

> **Assert presence AND absence.** The absence half was broken twice; the
> presence half caught it both times.
>
> **A guard that has never been shown to fail is a guard nobody has tested.**
> Fault injection is not a nicety for important tests — it is the only thing
> that distinguishes a passing check from a check that cannot fail.

The matcher is now tested before it is trusted: the first assertion in the file
checks that `flips("pl-8")` is true and `flips("definitely-not-a-utility")` is
false, which is the assertion the original version needed and did not have.

---

## 2026-08-31 — SEQUENCING DECISION: NO TABLE MIGRATION BEFORE THE CONTRACT WORK

An external report proposed migrating the app's tables to TanStack Table,
presented as cheap. Measured: **49 hand-rolled `<table>` elements across 39
files, zero using the vendored table component, and `@tanstack/react-table` is
not even a dependency.** Not cheap — but the owner's ruling turned on the
sequencing objection, which is stronger than the count:

> **Do not migrate 49 money surfaces onto interfaces nobody has verified.**

Tables are where this project's money defects have lived — the `accountId` key
bug, the unkeyed fragments, the counts taken off capped lists. Every one of the
49 renders figures through a hand-written interface, and the contract-coverage
gap (above) is precisely that those interfaces are unchecked claims. A migration
now would re-encode unverified types into new code and stamp them "modernised".

**The order is: contract work first (the fourth coverage gap), then any table
migration consumes GENERATED types rather than hand-written ones.** The
migration's real value arrives only in that order; in the reverse order it
launders the defect class it should have eliminated.

---

## 2026-09-01 — THE FIRST CORE-PATH WALK: TWO LAUNCH BLOCKERS NOTHING ELSE COULD SEE

An external report proposed a launch-readiness metric: *a Saudi business owner
can sign up, create an invoice, send it to a customer, record payment, view
cash position, and file a VAT return — in Arabic, on mobile, without
documentation.* The owner asked for the path to be walked honestly rather than
the metric adopted. The walk found more than the report's item list did, and it
is now **standing rule 4** (§3): a path finds what a list cannot.

### The walk, leg by leg

| Leg | Verdict |
| --- | --- |
| Sign up | Breaks earlier than expected: signup lands in `pending_review` and the verification gate 403s every business route until a platform operator approves. Deliberate KYC — but "sign up and start" is "sign up and wait for us", and the wait is undefined. → **L3** |
| Create an invoice | Works. |
| **Send it to a customer** | 🔴 **Fails on three independent legs**: no PDF or print rendering anywhere (checked for jspdf/pdfkit/puppeteer/`window.print` — nothing), the mailer unwired (B1), no share link. The signed XML and QR are minted at approval **and reach nobody**. Found on the way: `InvoiceSummary.tsx`'s Export button has no `onClick` — a dead control. → **L1** |
| Record payment | Works. |
| View cash position | Works. |
| File a VAT return | A metric-wording issue, not a gap: `/vat` produces the box-structured bilingual return; the platform deliberately does not *file* (a reasoned drop — ZATCA e-invoicing is not VAT-return filing). |
| In Arabic | Substantially yes; the mechanical re-measurement stays queued before it is claimed. |
| **On mobile** | 🔴 **Fails**: `Layout.tsx` has zero responsive breakpoints — a fixed 240px sidebar, no collapse, no drawer. `useIsMobile` exists and is consumed only by the unused vendored sidebar. On a phone the app is a horizontal-scroll desktop page, for a mobile-first customer. → **L2** |

### 🔴 Why nothing else found L1 and L2

Six audits, ~1,200 tests, the browser suite, the reachability guards, the shape
guards — none of them could have, **because nothing was broken. Things were
missing.** Every existing instrument answers "does what exists behave?"; a
missing capability produces no wrong number, no console error, no unreachable
route, no failing assertion. This is *a reader cannot detect an absence*,
pointed at the QUEUE itself: §5 tracks defects and decisions, which are lists,
and an absence leaves no row in a list.

The regulatory sharpening makes L1 the higher of the two (owner): **a
simplified invoice's QR exists to be presented to the customer, and the product
produces no artifact that can present it.** The core compliance feature is
built, verified against the live sandbox — and undeliverable.

### The rule

> **Periodically walk the core user path end to end, as the user, and before
> any launch conversation.** The queue review and the walk are different
> instruments: the queue finds what went wrong; the walk finds what was never
> there.

### Also settled in the same assessment

- **bcryptjs DoS framing (external report): overstated.** All hot-path calls
  are async (bcryptjs interleaves CPU across ticks; degradation, not a stall);
  signup is 5/hour/IP and login 10/15min/IP on a **Postgres-backed,
  cross-process store** (C1's code half — the tech table had gone stale and was
  corrected). The real caveat is the known one: limits are IP-keyed and
  `TRUST_PROXY_HOPS` is unverified until deployment. M-4 stays in the tail.
- **AssetSchedule NaN and PayrollReport's `month` filter (external report):
  both real, both already fixed in #106** — each file's own comment records
  exactly the reported defect. With CreditNotes and TrialBalance, that is four
  hand-written-interface money defects: **#106 fixed the instances and the
  class regrew within weeks, because the generator is still there.** That
  sentence is the contract milestone's argument, and is now stated on the
  milestone itself.
