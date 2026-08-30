# Frontend implementation spec — reconciliation

**Status (2026-08-30): the corrected reading of an external specification. No code
written from it yet.** Current state authority: `CLAUDE.md` §2.

**Source document:** `📄 SAUDI LEDGER PLATFORM.pdf` — "Complete Frontend
Implementation Prompt", Version 1.0, dated 2026-08-30, 44 pages, 15 sections.
Authored outside this repository by the owner's team.

**What this doc is for.** The specification is adopted as the design spec for
the frontend rebuild, with corrections. This file records the corrections and
their evidence, so nobody re-derives them and nobody builds from the raw PDF by
mistake. Where the two disagree, **this file wins**.

---

## 1. 🔴 Provenance — which platform the author was describing

**Stated first because it calibrates how to read the other 42 pages.**

The author did not work from the repository. The evidence is not that the
document is out of date — it is that the document is **inconsistent in both
directions at the same time**, which no single snapshot can be:

| The spec's claim | The repository | Landed |
| --- | --- | --- |
| §2.4 — Payroll runs **not built** ("salary categories exist, no payroll runs") | `/payroll` with list, get, create, submit, send-back; `payroll_runs` + `payroll_items`; a Payroll page and a Payroll Report | **2026-07-27** |
| §2.4 — Fixed Asset Depreciation **not built** | `POST /assets/:id/depreciate` | **2026-07-29** |
| §2.1 — "Server-side numbering" listed as working | Migration `0063_document_number_counters` | **2026-08-30** (same day) |
| §2.3 — Customer/Vendor detail pages, sub-accounts, account numbering, cost centres "in progress / design ready" | Correct — those are this session's work | 2026-08-30 |
| §4 — **Debit Notes** as a top-level module | The *capability* is live and correct; only a standalone **page** was deleted | page removed 2026-08-20; capability current |

Payroll and depreciation are among the **oldest features in the repository** —
they predate almost everything else. Anyone who had opened the codebase at any
point in the last month would not list them as missing. Yet the same document
knows about numbering work committed the day it was written.

**Conclusion: the picture was assembled from narrative summaries — conversation
and status prose — not from code.** Two consequences bind everything below:

1. 🔴 **Every "already built" and "not built" claim in §2 is unreliable in both
   directions** and must be checked against the repo before it is planned
   around. §2 is not an input to sequencing.
2. **The other 42 pages are a PROPOSAL, not a description.** Read as design
   intent — which is genuinely valuable — and never as a report of what exists.

This is the *check the referent* rule applied to a document instead of an
instruction: an instruction's referent is an input, and so is a specification's.

---

## 2. How the fifteen corrections are classified

Three verdicts, because they route to different places:

| Verdict | Meaning | Where it goes |
| --- | --- | --- |
| **INVENTED** | The spec proposes something the product does not have and we decided against, or never had | A **spec correction** — this file |
| **OBSERVED** | The spec faithfully described something really in the product — **and the thing is a defect** | A **queue entry against the product**, not a spec correction |
| **STALE** | The spec described something that was real and has since been removed or superseded | Neither — a provenance artefact (§1) |

**Result: of fifteen, two are bug reports.** Twelve invented, one stale, and
**two OBSERVED — items 8 and 15, which are the same defect wearing two values.**

🔴 A note on the classification itself, since it was wrong once: item 1 was
first filed STALE on the belief that debit notes had been deleted. They had not
— only a redundant page had. **A verdict of "the spec is describing something
that no longer exists" is itself a claim about the product and needs the same
evidence as any other**; the corrected entry carries it.

---

## 3. The fifteen

### 🔴 3.1 OBSERVED — real defects, filed against the product

#### 8. `overdue` — a status the UI filters on that nothing writes
#### 15. `cancelled` — the same, one value over

**What the spec says.** §5.3 gives the invoice workflow as
*Draft → Sent → Partial → Paid → Overdue*; §4 lists an **Overdue** nav filter for
invoices and bills; §7.3's `StatusBadge` type includes `'overdue'` and
`'cancelled'`.

**What is true.** The spec described the product accurately. **The product is
wrong.** Both values are read in six places and written in none.

**Consumers (owner-supplied, confirmed):**

- `Invoices.tsx:161` — an **Overdue KPI count**
- `Invoices.tsx:170` — `overdue` + `cancelled` filter chips
- `Bills.tsx:386`, `Bills.tsx:399` — the same two
- `CreditNotes.tsx:80`
- `reports/CustomerLedger.tsx:22`
- `invoices.repository.ts:294` — `NOT IN (…, 'cancelled')`
- `invoices.repository.ts:73` — `COUNT(*) FILTER (WHERE status = 'overdue')`
- `creditNotes.ts:25` — `ISSUED_STATUSES = ["sent","paid","overdue"]`

**Producers — the search shape, so the absence claim is reviewable.** A writer
could take the form of a service literal (`status: 'overdue'`), a repository
`set({ status })`, a scheduled job flipping rows on a due date, a SQL `UPDATE` in
a migration, or a column default. Searched:

| Where | Result |
| --- | --- |
| `apps/api/src/services/**` for `status: 'overdue' \| 'cancelled'` | **none** |
| `apps/api/src/jobs/**` for either word | **none** |
| `packages/db/migrations/*.sql` for either literal | one hit — `0053_m21_3_purchase_orders.sql`, a **different entity** (purchase orders), not invoices or bills |
| `invoices.ts` / `bills.ts` schema | the values appear **only in a trailing `//` comment** enumerating the enum; the column default is `'draft'` |

**Falsifier:** a single service, job or migration setting either value on
`invoices` or `bills`. None found.

The invoice service writes `draft`, `submitted`, `sent`, `paid`. Aging derives
overdue from **dates**, never from the status column.

🔴 **This is the consumer-with-no-producer shape, shipped and demoing fine.**
The Overdue KPI is not an error — it renders a confident **0**, permanently, and
the filter chips return empty sets that look like clean books. It is the
"confident zero" failure: a missing consumer leaves a dead column nobody sees; a
missing producer produces *an answer*.

**Disposition — queue, not spec.** Two options, and they are a product decision:

- **Derive `overdue`** at read time from `dueDate < today AND balance > 0`, and
  delete the status value — the dates already carry the truth, and a second
  representation of one fact is the drift shape.
- **Or write it** from a scheduled job, and accept a status that is stale
  between runs.

**Recommendation: derive.**

### 🔴 The queue entry is ONE change spanning the schema AND every reader

**Deleting the status value alone fixes nothing a user can see.** The KPI at
`Invoices.tsx:161` and `Bills.tsx:386` would still render a count, and the chips
at `:170` and `:399` would still render filters — now for a value the column
cannot even hold. **A confident zero before, a confident zero after**, with the
only difference being that the reason moved.

That is this project's own lesson pointed at a fix: *fixing a reported instance
without sweeping its shape leaves the reachable copies in place*, and the
reachable copies here are the five call sites, not the column.

**The change, as one unit:**

| # | Site | Today | After |
| --- | --- | --- | --- |
| 1 | `invoices.ts` / `bills.ts` schema comment | enum comment lists `overdue`, `cancelled` | comment lists only what is written: `draft \| submitted \| sent \| paid` (bills: `… received \| approved \| paid`) |
| 2 | `invoices.repository.ts:73` | `COUNT(*) FILTER (WHERE status = 'overdue')` | count derived from `dueDate < today AND total > paidAmount` |
| 3 | `invoices.repository.ts:294` | `NOT IN (…, 'cancelled')` | drop the dead term (it excludes nothing) |
| 4 | `Invoices.tsx:161` · `Bills.tsx:386` | Overdue KPI off the status count | reads the derived figure |
| 5 | `Invoices.tsx:170` · `Bills.tsx:399` | `overdue` + `cancelled` filter chips | `overdue` chip filters on the derived condition; **`cancelled` chip removed** |
| 6 | `CreditNotes.tsx:80`, `reports/CustomerLedger.tsx:22`, `creditNotes.ts:25` | `ISSUED_STATUSES` includes `"overdue"` | harmless but dead — drop the term so the list states only reachable values |
| 7 | `StatusBadge` type (when built) | includes both | includes neither |

**`cancelled` gets no replacement.** It has no meaning on an invoice: a document
that must not stand is reversed by a **credit note**, which is the ZATCA-correct
mechanism and already works. Removing the chip removes a control that could never
return a row.

**Test that closes it:** assert the derived overdue count moves when a due date
passes, **and** that no row in `invoices`/`bills` ever holds either value —
a presence assertion plus an absence assertion, so the guard fails if a writer is
ever added rather than silently blessing it.

---

### 3.2 STALE — provenance artefacts, not corrections

#### 13. §2.4 understating payroll and fixed-asset depreciation

Covered in §1. Consequence for planning: **the spec's Phase 3 schedules work
that already exists** (Payroll/GOSI at priority 13, Depreciation at 14).

---

### 3.3 INVENTED — the spec corrections

#### 1. Debit Notes as a top-level module (§4) — the error is PLACEMENT, not existence

🔴 **Corrected 2026-08-30 after an owner challenge. The first version of this
entry said debit notes were "deleted as a facade", which was wrong** — it
conflated a deleted *page* with the *capability*, and an argument that the spec
contains unverified claims must not itself contain one.

**Debit notes are live and correct.** Verified:

| Evidence | Where |
| --- | --- |
| The list filters both note types | `CreditNotes.tsx:96` — `documentType === "credit_note" \|\| "debit_note"` |
| The create picker offers it | `CreditNotes.tsx:184` — *"Debit note — charge more" / "إشعار مدين — زيادة المبلغ"* |
| A debit-note-only view exists | `CreditNotes.tsx:142` |
| ZATCA UBL type code | `ubl/buildInvoiceXml.ts:47` — `{ invoice: "388", debit_note: "383", credit_note: "381" }` |
| The e-invoice assembler branches on it | `einvoiceInput.assembler.ts:219` and `:328` |

What was removed on 2026-08-20 (`f00fb5f`) was a standalone **`DebitNotes.tsx`
page**, and that commit's own message gives the reason: *"real debit notes
already exist as `documentType` on invoices"*. The page was redundant, not the
feature.

**So the correction is narrow.** A debit note is a `documentType` on the
`invoices` table, sharing the credit-notes page, and it **posts like an invoice**
— it does not reverse, unlike a credit note. The spec's error is proposing it as
a **top-level module**, which would rebuild the page that was deleted for being
redundant. Keep the capability exactly where it is.

#### 4. 🔴 §14.4 — "Mock the integrations UI even if backend isn't ready"

**The single most important line to overrule**, because it is a general licence
rather than one screen. This is the practice that produced `CustomerReceipts.tsx`
and `VendorReceipts.tsx` — pages calling unmounted endpoints behind
`.catch(() => [])`, rendering as permanently empty lists, live from 2026-07-19
to 2026-08-20.

**Correction: no screen ships that calls an endpoint which does not exist.** Not
with a disclaimer, not marked "Coming Soon", not as a mock. The inverse
reachability guard (`route-reachability.test.ts`) enforces this for `apiFetch`
call sites and will fail the build.

The honest way to show an unbuilt capability is a **page that states the
capability does not exist yet** — which is what `/zakat` does today — never a
working-looking screen wired to nothing.

#### 5. 🔴 §8.2 — MyFatoorah automation that posts to the ledger unattended

Three checkboxes, **pre-ticked in the mockup**: "Auto-reconcile payment to
invoice", "Mark invoice as 'Paid' instantly", "Auto-create customer if not
exists".

Breaks three standing rules at once: *AI/automation proposes, it never posts*;
*do not auto-apply matches, however exact — suggestions are pre-selected, the
human clicks*; and *one writer per effect*, since payment already has
`invoicesService.pay`.

**Correction:** a gateway confirmation produces a **proposed** payment a human
accepts, and it routes through the existing pay path. See the decision in §4.3 —
this one is genuinely arguable and is recorded as a decision rather than settled
here.

#### 6. Currency dropdown (§5.3) and Phase 3 Multi-Currency (§10)

**Verified: no currency selector exists in `Invoices.tsx` today.** Invented.

Migration `0062` made single currency a **write-boundary invariant across nine
tables**, deliberately: `currency` is consulted by **no aggregate** — verified by
grep across `glPosting`, `reports`, `analytics`, `summary` and the VAT return —
there is no exchange-rate column in any of 56 tables and no conversion function
in any service. A row stored as USD therefore adds its **bare number** into SAR
totals, the trial balance, and the filed VAT return.

**Correction: no currency selector.** Multi-currency is a real future feature and
a large one; it begins with an exchange-rate model and a conversion boundary, not
with a dropdown. A selector shipped ahead of that is a way to corrupt a tax
filing.

#### 7. §8.4 — ZATCA dashboard showing cleared submissions

**Verified: no submission-log UI exists.** Invented.

The mockup shows `INV-001 | Cleared`, `INV-002 | Rejected`, and a **Resubmit**
action. 🔴 **We have never submitted an invoice to ZATCA in any environment.**
The compliance pass covers document *construction* against the sandbox; the
production path (`/invoices/{clearance,reporting}/single`) has never been called.

**Correction:** the ZATCA screen may show onboarding state (which is real) and
must not show a submission log until submissions exist. A screen that renders
"Cleared" is the same false claim as item 5 in a different medium.

#### 9. Entities and reports that do not exist (§4)

Customer Groups · Sales by Region · Sales by Product · Purchase Trends ·
Invoice / Quotation / PO **Templates** · Import Journal Entries · Import
Accounts · Account Types Management · Withholding Tax · Report Builder / Saved
Reports / Scheduled Reports.

Notes: recurring **rules** exist and are a different concept from templates;
`categories.type` is a fixed five-value enum, not a managed entity; chart-of-
accounts import is designed (`design-chart-of-accounts-structure.md`) and
unbuilt. Items the spec marks "(Coming Soon)" are honest and may stay as
labelled placeholders **only if they render as a statement, not a control**.

#### 10. Organisation Verification → Operator Review in the tenant sidebar (§4)

That is the **platform-operator** surface, outside the tenant boundary. Every
tenant role would meet a 403. It belongs on the operator surface only.

#### 11. "Send Email" (§5.3) and "Send Reminder" (§9.2)

**Verified: neither button exists today.** Invented. `MAIL_PROVIDER` /
`MAIL_API_KEY` / `MAIL_FROM` are unwired — a deployment-time item (B1/B2). These
ship **when the provider is wired**, not before; an unwired alarm is exactly what
B2 exists to prevent.

#### 12. 🔴 §11.2 — the API integration pattern does not match this API

The spec's example hook reads `response.success`, returns `response.data`, and
throws `new ApiError(response.error)`.

**No controller in this codebase returns that envelope.** Every hook written to
§11.2 would throw on its first call.

🔴 **And the correction I first offered was also wrong.** I wrote that "lists
return `{items, page, totals}`" as though it were the house pattern. It is not
uniform: measured against the running server on 2026-08-30, `/invoices`,
`/bills`, `/customers`, `/quotations` and `/purchase-orders` return
`{items, page:{limit,offset,total}, totals:{…}}`, while `/transactions` returns
`{transactions, total, offset, limit}` — a different shape with a different key.
(A reading that these services return **bare arrays** describes the state before
the pagination commits of 2026-08-29/30; all six now compose rows with a
meta/totals query.)

**So the spec's contract is wrong, my correction was wrong, and the earlier
reading was wrong — three different wrong answers to one question.** That is the
argument for the fix, not against it:

🔴 **Correction: this document does not state the response shapes at all.**
`packages/api-spec/openapi.yaml` and the generated `@workspace/api-zod` are the
**single writer** for that fact; the frontend consumes the generated client.
Restating shapes in prose creates a second representation that drifts — the same
disease as items 6 and 8, pointed at a contract. Any hand-written `apiFetch<T>`
interface is a claim nobody checks, and that claim was already measured wrong on
**five pages across 18 fields**.

*(Caveat, stated rather than hidden: the per-endpoint enumeration above was
verified for six list endpoints. It is not a complete inventory — which is
precisely why the pointer, not the list, is the deliverable.)*

#### 14. §5.1 — "Monthly P&L with profit margin overlay"

**Verified: no dual-axis chart exists today** (no `yAxisId` anywhere in
`Analytics.tsx`; every chart has a single `YAxis`). Invented.

Money and a ratio on one canvas is the dual-axis mistake we banned outright: two
y-scales can be slid until any two series appear to track, inventing a
relationship the reader will believe. **Correction: separate charts, small
multiples, or index both to a common base.**

#### 2. "Invoice numbering: Sequential, no gaps" (§5.3)

We established from the VAT Implementing Regulations that **gaps are lawful**;
only the **ICV counter** must be gapless, and it is allocated under
`lockCompanySequence`. A UI promising a gapless invoice series would either be a
false statement or a reason to refuse legitimate voids.

#### 3. AI Assistant — the opinion register (§9.1)

The mockup answers "What were our top expenses Q3?" with figures and an
assumption footer. Two corrections:

- **Register:** we chose **FACT + PROJECTION only**; opinion is queued behind the
  advisor conversation. The mockup's framing reintroduces it.
- 🔴 **Posture:** the AI layer is **dark by construction** — the boot boundary
  refuses tenant data until the Groq Enterprise agreement is signed (queue C6,
  blocking). A chat screen answering from live ledger data cannot be built now,
  whatever its register.

---

## 4. Decisions this document records

### 4.1 The API contract has one writer

`packages/api-spec` + `@workspace/api-zod`. Pages consume the generated client;
no page declares its own response interface. Enforced already by
`tests/list-response-shape.test.ts`.

### 4.2 🔴 What a PDF asserts about its own status

**"No blockers" was wrong** — an invoice PDF is a compliance artefact, not a
print stylesheet. It carries bilingual mandated fields and the ZATCA QR
(`packages/zatca-tlv` exists). By the reasoning of item 7, **a PDF that looks
like a cleared tax invoice when nothing has ever been cleared is the same false
claim on paper**, and paper leaves the building.

**Decision required before the task is scoped:**

1. What does the PDF **assert about its own status**? A document with a QR and a
   hash reads as a cleared tax invoice to a recipient who cannot tell the
   difference.
2. What does it show for an **uncleared** document — a draft watermark, an
   explicit "not submitted to ZATCA" line, or no QR at all until clearance?
3. Does a **draft** invoice get a PDF? (It consumes no ICV and has no hash.)

**Ordering consequence — the spec has this in the wrong sequence.** PDF at
Phase 1 #1 answers questions the design pass owns at #2: Arabic **shaping and
font embedding** (a PDF engine does not inherit the browser's text stack), and
**D-3's unresolved numeric alignment in RTL**. Building PDF first means deciding
those inside a PDF renderer and then deciding them again, differently, in CSS.

**Recommendation: PDF moves after the design system**, or — if PDF must lead for
demo reasons — a narrow decision on *document typography, Arabic shaping and
numeric alignment* is taken first and binds both. Stated as a recommendation;
the owner is open to the move.

### 4.3 🔴 Does a gateway-confirmed payment post automatically?

**Genuinely arguable, and recorded as a decision rather than settled.**

The "AI proposes, never posts" rule exists because a *suggestion* is a guess. **A
webhook from a payment processor is not a guess — it is a fact**: the money
arrived. Requiring a human to click "yes, the payment that already happened
happened" is the nested-confirmation defect M16 named, not extra safety.

The counter-argument is equally real: a webhook is an **unauthenticated inbound
claim** until its signature is verified, it can be replayed, and it can arrive
for an invoice in a closed period.

**Both readings agree on the mechanism, and that part is not open:**

🔴 **Whatever is decided, the payment routes through `invoicesService.pay`.**
Never a second writer to the same ledger effect. A gateway integration that
writes its own payment row is a parallel posting path, which §4 forbids outright.

**What still needs deciding:** whether a *verified* webhook posts on arrival, or
lands in a review queue like a bank line.

### 🔴 Owner and trigger — because an open decision defaults to "post it"

**Owner:** the platform owner, with the accountant on the control question
(a payment recorded without review is a separation-of-duties question before it
is an engineering one).

**Trigger: the day the Saudi CR entity is registered** — the same event that
unblocks ZATCA M12.7, A2, and gateway merchant onboarding. It is answered
*before* any gateway code is written, not during.

**Why it is pinned to an event rather than left open.** An undated decision gets
answered by default at implementation time, and **the default here is "post it"**
— because by the moment someone is writing the webhook handler, the payment is
already a fact sitting in a payload, the invoice is already open, and posting is
the path of least resistance. The decision would be made by whoever writes that
handler, silently, and would look like an implementation detail rather than the
control decision it is.

That is the composition shape aimed at a *decision* instead of a defect: an open
question plus a deadline that never arrives resolves itself in the direction of
whatever is easiest to build.

---

## 5. Integrations — corrected

### 5.1 🔴 SiFi is not a payment gateway (owner correction, 2026-08-30)

**SiFi** (Simplified Financial Solutions / الحلول المبسطة) is a **SAMA-licensed
EMI doing spend management** — corporate cards, expense management, vendor
payments. It does not accept a customer payment against an invoice, and it does
not belong beside MyFatoorah.

The integration would be **outbound**: card and expense feeds, and AP. That puts
it **adjacent to A2 (bank connectivity)**, not to payment acceptance.

**Recorded as: an unscoped A2-adjacent candidate with no design and no
estimate.** Deliberately not costed.

### 5.2 MyFatoorah — UNCOSTED

The earlier "~2–3 weeks" estimate is **withdrawn**. It was inconsistent: SiFi was
refused an estimate on the grounds that an option must be costed *after*
verifying its inputs exist, and MyFatoorah was then costed because its API is
"documented" — which is an assumption about the inputs, not a verification of
them. I have not read MyFatoorah's API documentation.

**Inputs that must be verified before any estimate:** authentication model and
credential rotation; webhook signature scheme and replay protection; the payment
object's mapping onto our invoice + payment model; refund and partial-payment
semantics; sandbox availability; and whether merchant onboarding requires a
Saudi CR.

**Current state in the repo, measured:** MyFatoorah appears **exactly once** —
as a keyword in `categorizer.ts` for recognising a processor fee on a bank line.
That is not an integration. SiFi appears **nowhere**.

### 5.3 🔴 The integrations hub is cut from the build order

A hub with zero integrations is **a shape with no consumer**, and an empty state
naming MyFatoorah is a facade with a disclaimer — which is what overruling §14.4
(item 4) was for.

**The extensibility requirement is met by a code seam, not a screen** — the
`EInvoiceProvider` shape: one interface, real implementations only, and a method
that cannot do the thing **throws** rather than returning a no-op success.

**Nothing here is built until the entity exists.** Both gateway categories need a
merchant account, which needs a registered Saudi CR — the same blocker as ZATCA
M12.7 and A2.

---

## 6. Build order

**Settled 2026-08-31, across the specification's Phase 1 AND the owner's own
priority list — not by reordering within either.** The spec ranks inventory
eleventh and visual design second; the owner ranks them first and tenth. Neither
list is reordered into the other; the reconciliation is in §6.3.

### 6.1 Track A — deployment. Parallel, starts now.

| Item | What |
| --- | --- |
| **C1** | Confirm the real proxy count for `TRUST_PROXY_HOPS` |
| **C3** | KMS deployment verification — IAM/key policy, 30-day deletion window, CloudTrail alarm, multi-region CMK replica |
| **C4** | clamd sidecar + `MALWARE_SCANNER=clamd` |
| **B1/B2** | Mail provider + verified sending domain; `ALERT_WEBHOOK_URL` pointed somewhere real, with one test page confirmed to arrive |
| **C6 (hosting half)** | Region + KMS. No hosted Supabase project exists yet. |

**Why it is a track and not a step: it is ops, it needs nobody's permission, and
nothing built in Track B is reachable by anyone until it is done.** It also fits
inside the entity's shadow — none of it waits on the CR.

🔴 **What it conflicts with in Track B: nothing.** Checked rather than assumed —
Track A touches deployment configuration and infrastructure; Track B touches
`components/ui`, tokens, the nav, the invoice and bill pages, a new inventory
module and a PDF renderer. **No file is touched by both.**

Two interactions that are not conflicts and are worth naming:

- **B1 is an UNBLOCK, not a blocker.** Wiring the mail provider is what makes
  §3.3 item 11 ("Send Email", "Send Reminder") buildable at all. Those were
  deferred *because* mail is unwired — so Track A finishing hands Track B a
  feature rather than taking one away.
- **Sequencing courtesy:** Track B step 2 removes the permanent confident zeros.
  Worth landing before the deployment is shown to anyone, since a demo is the
  first time those chips get looked at by someone who does not know they are dead.

**The C6 exception, restated because it is easy to lose:** the *hosting* half is
entity-independent and belongs here. The **Groq Enterprise agreement** may not be
— see the dependency recorded in `owner-actions.md` under action 3.

### 6.2 Track B — sequential

| # | Step | Why here |
| --- | --- | --- |
| 1 | **Own-or-track on `components/ui/**`** · **+ the COGS / chart-of-accounts account decision** | Two decisions, no code. Own-or-track gates the first token commit (§6.4). The COGS decision gates inventory, and it is *not* a token dependency — which is why it is hoisted here rather than discovered inside step 4. |
| 2 | ✅ **DONE 2026-08-31** — **Fix items 8 and 15** (`overdue` / `cancelled`) | Small, live, and it **deletes controls** — restyling chips that are about to be removed is waste. Before any page work, not after. |
| 3 | **Token layer + nav settlement**, time-boxed | See §6.4. Not a page-by-page restyle. |
| 4 | **Inventory / COGS** | The owner's #1. Its only technical dependency is the token layer (step 3) and the account decision (step 1) — both satisfied. |
| 5 | **PDF** | Its §4.2 status decision is free and can be taken now; the *renderer* waits on step 3 for Arabic shaping, font embedding and numeric alignment. |
| — | **Billing (R1) design half** | Days, not weeks. No CR, no provider, no code. Overlaps steps 3–4 rather than competing for a slot. |
| — | Restyle · detail-page polish · theme · mobile | The genuine #10s. |
| — | ~~Integrations hub~~ | **Cut** (§5.3). The extensibility need is an `EInvoiceProvider`-shaped code seam, not a screen. |
| — | ~~Billing wiring~~ · ~~gateways~~ | CR-gated. |

### 6.3 🔴 Why inventory is 4 and not 6

An earlier draft of this order put PDF between the token layer and inventory.
**There is no dependency that produces that order** — PDF and inventory need the
same thing from step 3 and nothing else from each other. The ordering had been
inherited from the specification, which ranks PDF first, and re-derived rather
than checked. Inventory is the owner's #1 and sits at 4; PDF follows at 5, where
its only cost is being smaller.

Recorded because it is the second time in this reconciliation that the
specification's internal order leaked into a decision that was supposed to be
taken across both lists.

### 6.4 What step 3 contains — and why the nav is in it

**Tokens:** palette, type scale, spacing, radii, shadows, plus whatever RTL
resolution follows from step 1's own-or-track decision. ⚠️ Carries the measured
cost in `design-pass-inherited-decisions.md`: **120 un-converted physical
properties across 25 vendored `components/ui` files — RTL is incomplete.**

🔴 **The navigation settles here too, and it is not a cosmetic addition.**
Inventory (step 4) is a module of new screens with **no assigned home**. If the
nav is not settled first, it is decided by whoever adds the first inventory
route — the same implicit-decision shape as own-or-track, one layer up. Settling
it while nothing new is landing is cheap; settling it around a half-built module
is not.

**Four things step 3 settles:**

1. **Inventory's home in the sidebar**, before inventory exists.
2. 🔴 **Apply `hub-structure-decision.md`, which the current nav still violates.**
   That decision reads: *"**Finance Hub** and **Analytics** get navigation entries
   and landing pages. **Automation** and **AI** get **no navigation entry at
   all** — they appear inside the flows they serve."* The 2026-08-30 restructure
   dissolved the "AI Tools" *section* but kept its *entries*, moving
   **Categorization Engine** into Banking. A categorization destination is
   precisely what the decision says must not exist — categorising happens in the
   Review flow, and that is where its entry point belongs.

   ⚠️ **This is a two-part change and half of it strands a route.** Verified
   2026-08-31: `/categorize` and `/upload` are reachable **only** from the
   sidebar — no other link exists anywhere in `apps/web`. So the order is
   **add the in-flow entry point first, then remove the sidebar item** — exactly
   the pattern Automation already follows ("the *↻ Make recurring* entry point
   lives on the Invoices page"). Removing the entry alone produces an
   unreachable page, which is the defect class the guards exist for.
3. **§4's four-level tree becomes in-page tabs and filters**, as §3 concluded.
   The sidebar stays at seven sections; the spec's ~200 leaves become controls
   on the pages they belong to.
4. **Is `Findings` a third destination? — argued both ways, for the owner to
   settle.** `hub-structure-decision.md` names exactly two and argues against
   more. But it **predates AI-3a**, so Findings is not covered either way, and it
   currently holds a nav entry **by inheritance rather than by decision**.

   **The case FOR (the owner's instinct, and I think it is right):**

   - 🔴 **The hub decision's actual test is not "how many destinations" — it is
     "does this thing have a flow to live inside".** Automation and AI were
     denied entries because they are *capabilities applied to a document*: an AI
     suggestion is useful at the moment of the decision it informs, and a
     recurring rule belongs on the invoice it repeats. **Findings is not that
     shape.** It is a worklist you go to in order to find out what needs
     attention.
   - **A finding has no host document.** A duplicate invoice spans two invoices;
     an undeclared transfer spans a bank line and a declaration; a stale draft is
     about the absence of an action. There is no single page a
     cross-document observation "appears inside", which is the property that
     makes the flow-embedding answer unavailable.
   - **The product already accepts this shape elsewhere:** `Approvals` is a
     worklist with a nav entry and nobody argues it should live inside invoices.
   - It is the same shape as Finance Hub — a place that **states conditions**
     rather than a document you go and read.

   **The case AGAINST:**

   - The decision's *reasoning* — "every additional nav item is a cost; the
     customer is an SME owner, not an accountant; two destinations is already a
     lot" — is about **count**, and applies to a third destination whatever its
     shape.
   - **Finance Hub already states conditions.** If the Hub's conditions block and
     the Findings list are substantially the same list, then two destinations
     exist for one job, which is precisely the duplication the hub decision was
     written to prevent.
   - Findings' value grows with **AI-3b explanations, which are dark** until the
     Groq agreement is signed. Promoting a destination whose payoff is gated
     could be premature.

   **Recommendation: yes, with a test attached.** Findings earns an entry
   *because it has no host flow* — that is the hub decision's real criterion,
   applied rather than overridden. But the AGAINST case names a genuine risk, so
   the entry is conditional on one check in step 3: **put the Finance Hub
   conditions block and the Findings list side by side.** If they are the same
   list, merge them and keep two destinations. If they are not, Findings is a
   third destination on its merits, and `hub-structure-decision.md` gets a dated
   amendment saying so — rather than this file quietly contradicting it.

### 6.5 🔴 This section was STALE for two rounds — recorded, not just fixed

Between 2026-08-30 and 2026-08-31 the build order changed twice in conversation:
own-or-track was hoisted to step 1, and inventory moved from 6 to 4. **Neither
change reached this file.** §6 continued to hold the superseded order —
design system 1, PDF 2, the `overdue`/`cancelled` fix at 5 — while the settled
order existed only in chat.

**This is the README disease, one document later.** That file described Phase 0
as the frontier twenty milestones after it stopped being one, and the rule
written from it was: *a doc that restates status will drift; date the claim and
point at the single writer.* Here the doc **was** the single writer for the build
order, and drifted anyway — because the decision was taken in a medium the doc
does not read.

**The narrower rule this instance adds:** a decision taken in conversation is not
recorded until it is written where the decision lives. "I said it in the last
message" is the chat equivalent of a status line with no date — it is true, it is
findable by whoever was present, and it is invisible to everyone else and to the
next session. 🔴 **The trigger is the same one this project keeps rediscovering:
writing has an event, updating does not.** An order that changes in chat must be
written back in the same turn, or the artifact silently becomes the older of two
truths while still looking authoritative.

Applies directly to §9's capability inventory: it is the mechanical answer to
exactly this failure for *built/not-built*, and this section is the same failure
for *what to build next* — which nothing mechanises yet.

---

## 7. Adopted from the specification, unchanged

Recorded so the corrections are not mistaken for a rejection of the document.
The design work in it is good, and most of it stands:

- **The design system** — palette (light and dark), typography scale, number
  formatting, shadow system, 4px spacing grid, border radii.
- **The component contracts** — `DataTable`, `FinancialInput`, `StatusBadge`
  (minus `cancelled`), `DualDatePicker`, `KpiCard`, `Button`, `Modal`, `Toast`.
- **The keyboard shortcuts**, in full, including the reference table.
- 🔴 **The journal-entry UX** — real-time debit/credit balance display, account
  autocomplete on code *or* name, Tab navigation without the mouse, quick
  duplicate, and `Ctrl+S` / `Ctrl+Enter` / `Esc`. This is the best part of the
  document and it is exactly right for the users.
- **The module layouts** — dashboard, journal entries, invoices, detail pages,
  reports centre.
- **The Phase 1 ordering** (PDF → design → billing → detail pages → theme →
  mobile), with the two changes in §6.
- **The QA checklist** in §12, in full — particularly "period lock enforcement:
  UI refuses to post in locked periods", which we can already satisfy.
- **§14.1** — "enhance, don't reinvent."

---

## 8. What we rejected, and why

Per CONTRIBUTING §3b.

| Rejected | The property that lost it |
| --- | --- |
| **Treating §2's status claims as the input to sequencing** | Inconsistent in both directions simultaneously (§1) — it schedules built work and omits real gaps. |
| **Mocking integration UIs (§14.4)** | It is the exact practice that produced two facades that shipped for a month; the inverse guard exists because of it. |
| **Auto-posting gateway payments unattended** | A second writer to a ledger effect that already has one, plus an unverified inbound claim treated as settled. |
| **A currency selector ahead of a conversion boundary** | `currency` is read by no aggregate, so a non-SAR row corrupts the trial balance and the filed VAT return silently. |
| **A ZATCA submission log** | Renders "Cleared" for a submission that has never occurred in any environment. |
| **Restating response shapes in this document** | Three different wrong answers were given to that one question in a single session; a second representation of the contract drifts by construction. |
| **Costing MyFatoorah from "the API is documented"** | An assumption about inputs is not a verification of them — the same error the SiFi refusal avoided. |
| **Costing SiFi at all** | It is not a payment gateway; the scope is A2-adjacent and undesigned. |
| **Building the integrations hub as a shell** | A shape with no consumer; the extensibility need is a code seam, not a screen. |
| **A dual-axis P&L and margin chart** | Two y-scales can be slid until any two series appear to track. |
| **Keeping `overdue`/`cancelled` as written statuses** | The dates already carry the truth; a second representation drifts, and today it renders a permanent confident zero. |
| **PDF at Phase 1 #1** | It would decide Arabic shaping and numeric alignment inside a PDF renderer, then decide them again in CSS. |

---

## 9. The capability inventory — §1's countermeasure

**Approved 2026-08-31.** §1 showed that two independent sources made the same
payroll/depreciation error in one week. The countermeasure is a **generated**
built/not-built list, never an authored one.

- `scripts/capability-inventory.mjs` → writes `docs/capability-inventory.md`
- `capability-inventory.test.ts` regenerates and **fails when the committed file
  differs**. That diff test is the whole answer to "why won't this drift too":
  drifting turns the suite red. Same trigger pattern as the CLAUDE.md budget
  guard and the org-seed-trigger guard — updating gets a trigger, because
  writing already has one.

**Sources, all of which are facts rather than prose:** the mounted route table
(`routes/index.ts`), the frontend routes (`App.tsx`), `navGroupsData`
(`Layout.tsx`), `information_schema`, and the existing reachability logic for
which routes have a UI caller.

### 9.1 🔴 Three states, never two

The generator must not repeat the error it exists to catch. Payroll and
depreciation were called missing because **absence is easy to assert and hard to
verify**, so every row carries one of:

| State | Basis |
| --- | --- |
| **PRESENT** | Positive evidence — route mounted, page routed, caller found |
| **ABSENT** | Searched, **with the search shape printed in the row** |
| **NOT MEASURED** | A class the tool cannot see — said outright, never scored as absent |

A mounted `/payroll` and a `POST /assets/:id/depreciate` are positive evidence
the generator reads directly, so neither could have been marked ABSENT. That one
rule is what would have caught both errors.

### 9.2 🔴 The generator must fail when it stops SEEING a class

**Owner requirement, 2026-08-31 — and it closes a hole the diff test does not.**

If the generator silently stops reading `navGroupsData` — a refactor renames the
export, the parse regex drifts, the file moves — then regeneration produces a
file with that class **missing from both sides**, the diff matches the committed
copy, and the test stays **green over reduced coverage**.

That is the vacuous green one level up: the instrument built to detect a blind
spot acquires one, and its own guard reports success. It is the same shape as
`list-response-shape`'s shrink-check, which exists for exactly this reason and
caught its own blind spot on day one.

**Two mechanisms, both required:**

1. **An unreadable source is a HARD ERROR, never an empty result.** If a source
   file is missing, unparseable, or yields zero matches where zero is not a legal
   answer, the generator **throws** rather than emitting a shorter document. A
   parser that returns `[]` on failure is indistinguishable from a codebase that
   genuinely has none — the stub-returning-success shape, in a measuring tool.
2. **A per-class source count, asserted against a floor**, in the manner of
   `DECLARATIONS_AT_WRITING`: nav groups, frontend routes, mounted API routes and
   tables each carry a minimum, and the count may only be **raised** as the
   product grows. A drop means the scanner went blind, not that the product
   shrank — and the failure message must say so, because the two look identical
   in the output and opposite in meaning.

**The counts belong in the committed artifact too**, so a reader can see what the
document rests on rather than trusting that it rests on anything — the
verdict-carries-its-evidence-count rule.

---

## 10. Found during reconciliation — the bill expense-account label

**Not from the specification.** Surfaced by the COGS check in §6's ordering work.
Filed here because this is where it was found; it is a product queue entry, not a
spec correction.

### What is true

`bills.approvable.ts:124` defaults a bill's expense account to the literal
string **`"Purchases and Cost of Sales"`**. No account of that name exists — the
seeded chart has `PURCHASES` / `"Purchases"`. So `findByName` misses and the line
posts as:

```
{ systemCode: "PURCHASES", accountName: "Purchases and Cost of Sales" }
```

`postJournalEntry` then resolves that system code through `resolveAccounts` and
writes a **real `account_id`**. The row is therefore correctly classified and
correctly linked; only its `account_name` names an account that is not in the
tenant's chart. Live in the dev org: **3 GL lines** carry the label.

### 🔴 Severity: display + drift. NOT "lines vanish from reports."

**An earlier version of this entry claimed a user selecting "Purchases" in the
account-statement or general-ledger report would get none of these lines. That
claim was wrong, and the correction matters more than the defect.**

- All four name-keyed branches in `reports.repository.ts` — `glPreLines:165`,
  `glRows:175`, `acctStmtPre:200`, `acctStmtRows:210` — are **`else` branches to
  `account_id`** (`else if (account_name)`, `if (account_name && !account_id)`,
  `else`). They are reached only when no `account_id` is supplied.
- **Both frontends supply `account_id`**: `AccountStatement.tsx:42` and
  `GeneralLedger.tsx:47`. A repository-wide grep finds **no caller in
  `apps/web` that sends `account_name` at all.**

So the name-keyed path is **unreachable from the product**, and no user-facing
report loses a row today.

**What is real:**

1. **Display.** The general ledger and account statement render
   `accountName`, so a user reading them sees an account name absent from their
   own chart of accounts.
2. **Drift.** `account_id` and `account_name` disagree on those rows — two id
   spaces with no forcing function — and the name-keyed branches are live code
   waiting for a first caller. Any future name-keyed consumer inherits a wrong
   answer on day one.

**Fix:** resolve the default through the system code and let `accountName` mirror
the resolved account's real name, so a GL line can never name an account outside
the tenant's chart. Small, and it removes the drift rather than the symptom.

**Related decision, not part of the fix:** whether **Cost of Sales** should exist
as a real seeded account. The literal reads like the place it was meant to live
and never did, and **inventory/COGS needs the account independently** — two
callers for one gap. That decision belongs to the chart-of-accounts work.

### 🔴 The lesson this entry cost, recorded because it is the reusable part

**I verified at the repository layer and stopped there.** Finding
`eq(accountName, …)` in four places, I concluded the reports filter by name — and
filed a severity built on that. The guards were **in my own grep output**:
`else if`, `&& !account_id`, `else`. I read past them, and did not follow the
callers up.

That is standing check part 1 failing on my own analysis: *grep the symbol, then
keep following it up — stopping at the boundary is why the check said "yes" for
A1's capture pipeline.* It is also AUD-13's shape inverted — verified below the
layer that had the answer, where the layer above would have shown there was no
reachable defect at all.

**The countermeasure is not "be careful": a severity claim names the CALLER that
reaches it.** "This report filters by name" is a statement about a repository
function; "a user picking Purchases loses rows" is a statement about a caller,
and only the second one is a severity. Whenever the two get conflated, the
severity is unverified.
