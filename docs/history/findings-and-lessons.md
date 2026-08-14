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
