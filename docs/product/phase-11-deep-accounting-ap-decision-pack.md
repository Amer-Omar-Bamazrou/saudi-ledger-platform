# Phase 11 — Deep Accounting & Deep Accounts Payable: audit, research and decisions

**Status (2026-09-22): A1, A2, A3, A4 and half of B6 are BUILT; A5–A8 and B1–B8 are audited, and §8 states what was not built and why.**
Current state authority: [CLAUDE.md §2](../../CLAUDE.md).

Written under [`docs/accounting-escalation-protocol.md`](../accounting-escalation-protocol.md).
Every accounting claim carries its class — `AUTHORITATIVE (Saudi)`,
`STANDARD (IFRS)`, `ODOO`, `ERPNEXT`, `PRODUCT DECISION`, or
`ACCOUNTANT DECISION REQUIRED` — and nothing from Odoo or ERPNext is presented
as a Saudi requirement.

---

## 1. The audit, before anything was changed

🔴 **This section is the frame for everything below.** Both halves of the brief
open with "audit first", and the reason is the standing rule that a reader
cannot detect an absence: without an inventory of what already exists, a
"deep AP" batch rebuilds what is there and misses what is not.

### 1.1 Part A — general accounting

| # | Item | What EXISTS today | Gap |
| --- | --- | --- | --- |
| **A1** | Recurring journal entries | The recurring engine is **built and correct** for `invoice` and `bill`: `recurring_rules` (frequency, dayOfMonth clamped to month end, start/end, `next_run_on` advanced only on success, `auto_issue` false by construction, authority re-checked at generation) and `recurring_runs` with **`unique(rule_id, scheduled_for)`** — the idempotency guarantee — and a loud `period_locked` failure rather than a silent skip. | `entity` admits **no `journal_entry`**. The engine is right; the third entity is missing. |
| **A2** | Accruals | Nothing. | The whole workflow. |
| **A3** | Prepayments / deferrals | Nothing. 🔴 Not to be confused with `invoice_prepayments` (AP-2), which is the **customer advance** adjustment, nor with supplier advances. | The whole workflow. |
| **A4** | Journal reversals | `journalEntries.reverse` exists and is careful: mirror entry, `reversal_of` back-reference, original marked `reversed` (a **marker, not an eraser** — `JE_IN_BOOKS` includes it), the **party travels** with each mirrored line (N3), and D-3 **bank attributions are copied** so per-bank readers see the mirror where they see its original. Audited as two events. | 🔴 **No period-lock check.** `reverse()` writes through `journalEntriesRepository.insertEntry`, not `postJournalEntry`, so `checkPeriodOpen` (glPosting.ts:361) never runs — a reversal can post into a **closed** month. Also: **no reversal reason** is captured, and the date is hard-wired to `businessToday()` with no caller choice. |
| **A5** | Period close | `period_locks` (org, company, `YYYY-MM`, `locked_at`, `locked_by`, `notes`), company-scoped, enforced on the posting path and the routes. | No **close validation** at all: a period can be locked with unposted drafts, unresolved bank rows and outstanding approvals inside it. No checklist, no reopening record beyond a delete. |
| **A6** | Retained earnings | `RETAINED_EARNINGS` is a seeded system account and is the **other side of a Batch 1C migration correction** (pack §16.12) — that treatment is settled and must not be disturbed. | No **year-end profit/loss transfer**. Nothing closes income and expense into retained earnings. |
| **A7** | Foreign currency | 🔴 **Nothing.** `invoices.currency` / `bills.currency` exist, default `'SAR'`, and **no code anywhere reads them**. There is no exchange-rate capture, no functional-currency restatement, no realized or unrealized FX. | See §4 — this is documented, not built. |
| **A8** | Accounting dimensions | `branches` and `departments` tables exist with **no consumer anywhere** (CLAUDE.md §5 records them as S6/S7: "build one or drop them"). Journal-entry lines carry **no** dimension column. Assets carry `location` / `department` as free text. | See §5. |

### 1.2 Part B — accounts payable

| # | Item | What EXISTS today | Gap |
| --- | --- | --- | --- |
| **B1** | Supplier invoice lifecycle | `draft → submitted → received(approved, posted) → paid`, with send-back-to-edit (`review_note`), the expense account chosen at entry and **carried on the bill** so it survives submit→approve, VAT on lines, AP posted with the **vendor on the control line** (N3), period lock through `postJournalEntry`, audit, and FA-B capitalisation when the bill buys an asset. | Largely complete. Reconciliation/settlement legs are where AP is thin (see B3). |
| **B2** | Supplier invoice approval | The generic approval engine (`services/approval/`) drives it; `bills.review_note` carries a rejection reason. | No **approver identity or timestamp on the bill itself**, no approval limits. |
| **B3** | Supplier payments | `billsService.pay`: per-bill, partial payments accumulate, **overpay refused**, bank account **required** (D-3, 422 `bank_account_required`), `Dr AP / Cr <the bank's own cash account>` with the vendor party, a dated `bill_payments` record, audit. | 🔴 **The whole allocation architecture is AR-only.** `payments` has `customer_id` and **no `vendor_id`**; `party_type` admits `customer \| none`; `direction = 'out'` has **no writer**. So AP has: no payment that covers **several** bills, no unapplied supplier credit, no refund, no `payment_allocations`, no statement-match link. |
| **B4** | Supplier advances / deposits | Nothing on the AP side. (The four **customer**-money liabilities from AP-1/AP-3 are a different direction and must not be reused blindly.) | The whole workflow, and its VAT treatment researched separately. |
| **B5** | Supplier reconciliation | Nothing. There is a **customer** statement (`customerStatement.service.ts`) with no vendor counterpart. | The whole workflow. |
| **B6** | AP ageing | `reports.apAging()` exists: approved, non-reversed bills only; outstanding = total − paid; five buckets. | 🔴 Two defects. (a) It buckets on **`new Date()`** — the server's midnight, not the business day; the **night-window** class the platform already fixed elsewhere (`businessToday()`, `Asia/Riyadh`). (b) It knows nothing of supplier **credit notes**, **advances** or **unapplied balances**, because none exist. |
| **B7** | Supplier credit notes | 🔴 **Nothing.** `bills` has **no `document_type`** at all — the invoice side has `invoice \| credit_note \| debit_note` and the purchase side has no equivalent. | The whole workflow. |
| **B8** | WHT | Nothing. | Research and integration points only — see §6. |

### 1.3 What the audit means for the order of work

The gaps are not evenly sized, and two of them are **defects in shipped code**
rather than missing features — A4's unchecked period on a reversal and B6's
server-midnight ageing. Those go first: they are small, they are wrong today,
and they need no new architecture.

---

---

## 2. Research — accruals and prepayments (A2, A3)

Conducted under the escalation protocol: Saudi Ledger first, then the
open-source implementations **from their source with citations**, then the
standards, and every conclusion classified.

### 2.1 What governs this in Saudi Arabia

`AUTHORITATIVE (Saudi)` — **SOCPA adopts IFRS as issued by the IASB**, plus
requirements and disclosures SOCPA adds, through an endorsement process that
includes technical, Sharia and legal review. Full IFRS applies to publicly
accountable entities (since 2017); **IFRS for SMEs was adopted in 2018** for
smaller private companies, which is this platform's scope. So the governing
text for accruals and prepayments is the SOCPA-endorsed IFRS / IFRS for SMEs
accrual basis — not a Saudi-specific rule. *(IFRS Foundation jurisdiction
profile for Saudi Arabia; SOCPA.)*

🔴 There is **no Saudi tax or ZATCA consequence in the recognition itself**. An
accrual and a prepayment are book entries: no tax invoice is issued, no input
or output VAT arises, nothing enters the ZATCA chain. VAT arises on the
underlying **supply** and its tax invoice, which is the bill's business and
already built. This is why A2/A3 need no VAT treatment of their own, and it is
stated here so a later reader does not go looking for one.

### 2.2 The distinction that decides the accounts — `STANDARD (IFRS)`

**IAS 37.11** is the authority, and it is explicit:

> "Accruals are liabilities to pay for goods or services that have been
> **received or supplied but have not been paid, invoiced or formally agreed
> with the supplier** … Although it is sometimes necessary to estimate the
> amount or timing of accruals, **the uncertainty is generally much less than
> for provisions**."

and, in the same paragraph, that **trade payables** are liabilities for goods
or services "that have been received or supplied **and have been invoiced** or
formally agreed with the supplier".

Three things follow, and the first is the most important decision in this batch:

1. 🔴 **AN ACCRUAL MUST NOT POST TO ACCOUNTS PAYABLE.** AP is the trade-payable
   control account — the invoiced liability, reconciled to supplier statements,
   aged in AP ageing, and settled by supplier payments. An accrual has **no
   invoice and no vendor document**; posting it to AP would put a payable in
   the supplier's balance that no statement can match and no payment can
   settle. It posts to a separate **accrued liabilities** account.
2. **A provision is not in scope.** IAS 37's uncertainty test separates them,
   and the brief asks for accruals. Provisions are named as out of scope
   rather than quietly folded in.
3. **A prepayment is an asset**, recognised because payment precedes the
   benefit, and released to expense over the period the benefit is received.

### 2.3 ERPNext — `ERPNEXT IMPLEMENTATION` (source, cited)

`erpnext/accounts/deferred_revenue.py` (sparse clone of `frappe/erpnext`):

| Fact | Citation |
| --- | --- |
| Deferral is an attribute of an invoice **line**, driven by `service_start_date` / `service_end_date` on the item | `:92–93`, `:399` |
| Purchase side recognition is `credit_account, debit_account = item.deferred_expense_account, item.expense_account` — i.e. **Dr expense / Cr deferred expense** | `:397` |
| Sales side is the mirror: Dr deferred revenue / Cr income | `:394` |
| Monthly amount with a **prorate factor** for partial first/last months | `:225–238` |
| The booked total is **capped** so it can never exceed the line's net amount | `:248–250` |
| Recognition runs as a scheduled process (`Process Deferred Accounting`) | `:487` |

ERPNext has **no separate "accrual" document**: an accrual there is an ordinary
Journal Entry, and the deferral machinery is for *deferred* revenue/expense.

### 2.4 Odoo — 🔴 **could not be located**

`addons/account` of `odoo/odoo` (sparse clone, current `main`) contains **no
deferred-expense or accrual implementation**: `grep -rn "deferred"` over
`addons/account/models` returns nothing, and the only hits in the module are
translation catalogues and a generic chart-of-accounts CSV. Odoo's deferred
revenue/expense management ships in **Enterprise** (`account_accountant`),
which is not open source and is not in this repository.

Per the protocol, a claim that cannot be cited is **not reported**: nothing is
asserted here about how Odoo implements deferrals. What Odoo's community
edition *does* have, and what is cited below, is its lock-date model (§5).

### 2.5 The comparison, and the decision

| Question | Saudi Ledger today | ERPNext (cited) | Odoo | Source | Decision |
| --- | --- | --- | --- | --- | --- |
| Where does a deferral live? | nowhere | on the invoice **line** (`:92`, `:399`) | not locatable | — | `SAUDI LEDGER PRODUCT DECISION`: a **standalone schedule document**, not a bill-line attribute |
| Recognition direction (prepayment) | — | Dr expense / Cr deferred expense (`:397`) | — | IAS 1 accrual basis | the same |
| Recognition direction (accrual) | — | (no accrual doctype) | — | IAS 37.11 | Dr expense / Cr **accrued liabilities**, never AP |
| Partial first/last period | — | prorate factor (`:238`) | — | — | 🔴 **not** prorated — see below |
| Over-recognition | — | capped at the line's net (`:249`) | — | — | the same guarantee, by construction |

🔴 **Why a standalone document rather than ERPNext's line attribute.** Our bill
lines carry no service dates, and adding them would put a recognition schedule
on every purchase line in the product. More importantly a prepayment does not
always come from a bill — rent paid by bank transfer with no vendor invoice is
the ordinary case. The shape this codebase has already proven for exactly this
problem is the **fixed-asset register**: a document holding the facts, a
**stored schedule** with one row per period, posted rows frozen, figures
DERIVED from the posted rows, and every effect through `postJournalEntry` after
`checkPeriodOpen`. A2/A3 reuse that shape rather than inventing a second one.

🔴 **Why whole periods rather than ERPNext's prorate factor.** ERPNext spreads a
partial first month by day count. Saudi Ledger recognises in **whole periods**,
because the schedule is generated once and frozen, and a day-count proration
makes the first and last rows depend on a convention the user cannot see. The
user chooses the number of periods and the start period; the last row absorbs
the rounding residue, exactly as `generateStraightLineSchedule` already does
for depreciation (FA-A), so there is **one** rounding convention in the
product rather than two. This is a `SAUDI LEDGER PRODUCT DECISION` with no
Saudi, VAT or ZATCA consequence — and by the protocol's own rule it is adopted
rather than escalated.

### 2.6 What was NOT decided here

`ACCOUNTANT DECISION REQUIRED` — none for A2/A3. The recognition pattern is
IFRS accrual basis, the account classification follows IAS 37.11 directly, and
no Saudi/VAT/ZATCA consequence attaches. Provisions (IAS 37 proper) are **out
of scope** and are not approximated.

---

---

## 3. A2/A3 as built — accruals and prepayments

One engine, two directions (`services/accounting/recognitionSchedules.service.ts`),
shaped like the fixed-asset register: a document of facts, a **stored** schedule
frozen as it posts, figures **derived** from the posted rows, every effect
through `postJournalEntry` after `checkPeriodOpen`.

| | Accrual | Prepayment |
| --- | --- | --- |
| What happened | received, **not yet invoiced** (IAS 37.11) | paid **before** the benefit |
| Balance account | `ACCRUED_LIABILITIES` (liability) | `PREPAID_EXPENSES` (current asset) |
| Who raises the balance | each recognition does | cash or the bill already did |
| Recognition | `Dr expense / Cr accrued liabilities` | `Dr expense / Cr prepaid expenses` |
| Activation posts | nothing | nothing |

🔴 **Recognition is dated the LAST DAY of the period being recognised**, not the
day the run happened — so a closed month fails closed through
`checkPeriodOpen`, loudly, instead of silently landing in today.

🔴 **Cancelling stops the future and keeps the past.** Unposted rows go; posted
ones stay in the books. It reverses nothing: reversing a posted recognition is
`journalEntries.reverse`, a separate act with its own reason and its own period
check. Folding the two together would let "stop this schedule" quietly rewrite
closed months.

🔴 **`spreadOverPeriods` moved to `lib/money.ts`** and the fixed-asset
depreciation engine now calls it. Equal rounded addends, the last absorbing the
residue, so Σ rows = the total exactly. Two copies of one formula diverge
invisibly; the 17 existing depreciation tests prove the move changed nothing.

**Not built:** provisions (IAS 37 proper — an uncertainty judgement, named as
out of scope rather than approximated); a prepayment raised automatically by a
bill (`source_bill_id` exists with no writer — the column is there because the
link is obvious, and it is **stated here as unbuilt** rather than left to look
finished).

---

## 4. A7 — foreign currency: DOCUMENTED, NOT BUILT

`SAUDI LEDGER PRODUCT DECISION`, and the brief's own instruction: *"Do NOT
implement a superficial FX field without correct accounting behaviour. If this
requires a larger architectural change, document it instead of creating fragile
partial functionality."*

### 4.1 What exists

`invoices.currency` and `bills.currency` exist, default `'SAR'`, and **no code
anywhere reads them**. There is no rate table, no rate capture, no functional-
currency restatement, no realized or unrealized FX. A grep for
`exchangeRate|exchange_rate|fxRate` across `packages/db/src` and `apps/api/src`
returns nothing.

### 4.2 Why a field would be worse than nothing

FX is not a column; it is a property of **every monetary line in the system**.
Doing it correctly (IAS 21) requires, at minimum:

1. a **rate source and a rate table** with a date and a provenance for each rate — a rate is a fact about a moment, and one stored without its source ages into a false credential;
2. **two amounts on every journal line** — transaction currency and functional currency — because a GL that stores only one cannot produce both the statutory statements and the subledger a supplier recognises;
3. **realized FX at settlement**, which means the payment path must know the rate at invoice date *and* at payment date, and post the difference to its own account;
4. **unrealized FX at period end**, a revaluation of every open monetary balance, reversed or not depending on policy;
5. **every report** re-reading balances in the functional currency, and every existing invariant (`ledgerInvariants.ts`, the balance checks in `postJournalEntry`, the D-3 per-bank cash identity) re-stated in two currencies.

🔴 Adding `exchange_rate` to a document without (2) and (3) produces a system
that **looks** multi-currency and silently reports a wrong functional-currency
balance the first time a rate moves. That is the "rendering a value the system
cannot compute with" failure: it converts a visible absence into an endorsed
inconsistency.

### 4.3 The boundary

FX is **its own phase**. It touches every posting path, and the correct order is
the rate table and the two-amount journal line *first*, before any document
gains a currency selector. Nothing in Phase 11 adds a currency field, and the
two existing `currency` columns are left exactly as they are — inert, and now
documented as inert.

---

## 5. A8 — accounting dimensions: AUDITED, and the answer is not a new axis

### 5.1 What exists

- `branches` and `departments` tables exist with **no consumer anywhere** in `apps/api/src` — CLAUDE.md §5 already records them as S6/S7, "build one or drop them".
- Journal-entry **lines carry no dimension column**.
- Fixed assets carry `location` and `department` as **free text**, used for the register and nothing else.
- The nav has a `Cost Centres & Projects` entry marked **Coming Soon**.

`ERPNEXT IMPLEMENTATION` (cited): ERPNext has a first-class
`Accounting Dimension` doctype (`erpnext/accounts/doctype/accounting_dimension/`)
plus `accounting_dimension_filter` and `allowed_dimension`, which inject a
column into GL Entry per dimension.

### 5.2 The decision

🔴 **Phase 11 adds no dimensional architecture**, and the reason is the brief's
own: *"Do not introduce unnecessary dimensional architecture if the current
design already has a correct equivalent."* The current design does **not** have
an equivalent — but neither does it have a consumer, and adding a dimension
column to `journal_entry_lines` without a reporting surface that groups by it
would create exactly the shape this codebase has named twice: a column that
looks like progress and is not written, beside two tables (`branches`,
`departments`) that have been unbuilt for long enough to be on the queue.

The honest sequence is: **decide whether the product wants dimensions at all**
(the nav says "coming soon", which is a promise nobody has costed), then build
one dimension end to end — column, write path, validation, and a report that
groups by it — rather than three half-axes. Until then S6/S7 stands: build one
or drop them.

---

## 6. B7 — supplier credit notes: RESEARCHED AND DESIGNED, not built

### 6.1 🔴 The purchase side is NOT a mirror of the sales side

This is the finding that matters, and it is the one a mirror-image
implementation would get wrong.

`AUTHORITATIVE (Saudi)` — VAT IR, **Credit and Debit Notes**, ¶1–2: when the
circumstances of Art. 40(1) occur, *"the Taxable Person **who has made the
Supply** shall provide the Customer with a credit note."* The note is the
**supplier's** document. When our tenant is the customer, our tenant **does not
issue it, does not sign it, does not report it to ZATCA, consumes no ICV and
takes no position in the hash chain.** It is a document we *receive*.

`AUTHORITATIVE (Saudi)` — **Art. 40(6)** states our side exactly:

> "the **Customer must correct its Input Tax** to reflect the Tax amount
> calculated on the change in Consideration **in the Tax Period in which the
> Credit Note or Debit Note is issued**."

Two consequences the design must carry:

1. we adjust **input** tax, never output tax;
2. the period is the one in which the **supplier issued** the note — not when we received it, and not the original bill's period. So the received note needs its **own issue date**, and that date drives the VAT return.

### 6.2 The implementations converge on the shape

| | Model | Citation |
| --- | --- | --- |
| ERPNext | the SAME doctype, `Purchase Invoice` with `is_return = 1` and `return_against` → the original; the original's status becomes `Debit Note Issued` | `erpnext/accounts/doctype/purchase_invoice/purchase_invoice.py:131, :161, :932` |
| Odoo | the same model, `account.move` with `move_type = 'in_refund'`, the declared mirror of `in_invoice` | `addons/account/models/account_move.py:63` |

They converge, and they converge with what **our own sales side already does**
(`invoices.document_type` = `invoice | credit_note | debit_note`). Per the
escalation protocol, convergence between two products is evidence about
software and not an accounting requirement — but here it also matches the
platform's own established pattern, which is the stronger argument.

### 6.3 The design

`SAUDI LEDGER PRODUCT DECISION`:

- **`bills.document_type`** — `bill | credit_note | debit_note`, mirroring `invoices.document_type`, with `bills.credit_note_against_bill_id` as the back-reference. One table, one lifecycle, one posting path; `documentSign()` extended to the purchase side so every consumer applies the direction explicitly rather than each report inventing it.
- **Accounting**: a received credit note reverses the original's direction — `Dr AP (vendor) / Cr expense (or the asset it capitalised) / Cr VAT_INPUT` — the exact mirror of the bill's own entry, through the same posting path.
- **VAT**: the input-tax adjustment is filed in the period of the note's **issue date** (Art. 40(6)), which is why the note carries its own date rather than inheriting the bill's.
- **Nothing ZATCA**: no ICV, no QR, no hash-chain position, no outbox. 🔴 This must be explicit in the code, because every other document-creating path in this product *does* touch the chain, and a reader who pattern-matches would wire it in.
- **Ageing and statements**: `apAging` and the (unbuilt) supplier statement net credit notes against the vendor's balance — which is precisely why B6's ageing is still incomplete, and is recorded as such rather than claimed.

### 6.4 Why it is not built in this batch

It is a schema change to `bills` plus the posting path, the VAT return's
purchase side, AP ageing, and a UI — a vertical slice the size of A2/A3, and the
batch ran out of room before it could be done to the standard the rest of Phase
11 was held to. **A half-built credit note is worse than none**: a `document_type`
column that some readers honour and others do not would make every AP figure in
the product depend on which query answered it. The research above is the
deliverable; the build is the next batch's first item.

---

## 7. B8 — withholding tax: the integration points, and the boundary

The brief says explicitly: *"DO NOT build a speculative full WHT engine yet."*

### 7.1 What Saudi WHT is — `AUTHORITATIVE (Saudi)`

Income Tax Law **Art. 68** with Executive Regulations **Art. 63**: tax withheld
from payments made **from a source in the Kingdom to NON-RESIDENTS without a
permanent establishment**, by payment type:

| Payment | Rate |
| --- | --- |
| Management fees | **20 %** |
| Royalties | **15 %** |
| Rent · technical and consulting services · air tickets · air/sea freight · international telecommunications · dividends · loan charges · insurance and reinsurance premiums | **5 %** |
| Any other payment | **15 %** |

Remittance: within **ten days of the end of the month in which the payment was
made**, with a monthly return naming the non-resident beneficiary, the payment
type, the amount and the tax withheld; an annual return within 120 days of the
fiscal year end (60 for partnerships). Late payment attracts **1 % per 30 days**.

### 7.2 Where it touches this product

1. **The vendor** — WHT applies to a *non-resident without a PE*. `vendors` has no residency or PE field, and that is the first required datum. It is a fact about the supplier, not about the invoice.
2. **The bill line** — the rate depends on the **payment type**, which is a property of what was supplied, so it belongs on the line or on the bill, not on the vendor.
3. 🔴 **The PAYMENT, not the invoice, is the trigger.** The Law withholds on payments made; the ten-day clock runs from the month of *payment*. So the accounting event is in the supplier-payment path: the vendor is paid **net**, and the withheld amount moves to a liability owed to ZATCA — `Dr AP (gross) / Cr bank (net) / Cr WHT payable`. An implementation that withheld at invoice approval would be wrong about both the amount and the deadline.
4. **A liability account** (`WHT_PAYABLE`) and its settlement when the monthly remittance is paid.
5. **A monthly report** in the shape of the return: beneficiary, payment type, amount, tax withheld.

### 7.3 The boundary

🔴 **WHT is its own phase, and it is blocked on B3 before it is blocked on
anything else.** Its accounting event lives in the supplier-payment path — and
that path does not yet exist in the form WHT needs: today `billsService.pay`
pays one bill at a time with no allocation architecture, no unapplied credit and
no vendor-side `payments` row (`payments.vendor_id` does not exist). Building
WHT onto that would mean building it twice.

Sequence: **B3 (supplier payments with allocation) → B4 (supplier advances) →
WHT**. Nothing speculative is added to the schema in this batch.

---

## 8. What Phase 11 did NOT do, stated as a boundary

Built and shipped: **A1** (recurring journal entries), **A2/A3** (accruals and
prepayments, with their surface), **A4** (reversal reason, date and the missing
period check), and half of **B6** (the business-day ageing defect).

Not built, each with its reason:

| # | Why |
| --- | --- |
| **A5** period close validation, **A6** year-end retained-earnings transfer | Researched (ERPNext's `Period Closing Voucher` refuses to close a year while an earlier one has entries and no voucher — `period_closing_voucher.py:94–125`; the closing account must be Liability or Equity — `:145–150`; Odoo carries **five** lock dates including an irreversible `hard_lock_date` — `addons/account/models/company.py:76–101`). Not built: the batch ran out of room, and a close that validates nothing is worse than an honest lock. |
| **A7** FX | §4 — architecture, not a field. |
| **A8** dimensions | §5 — the product has not decided it wants them. |
| **B1** | Audited as largely complete; nothing needed. |
| **B2** approver identity/timestamp on the bill, approval limits | Small, and it belongs with B3's payment authority rather than on its own. |
| **B3** supplier payments with allocation, **B4** supplier advances, **B5** supplier statement | The single largest remaining gap: `payments` is AR-only (`customer_id`, no `vendor_id`; `direction = 'out'` has no writer). This is a full architecture, not a feature, and it is the correct next batch. |
| **B6** credit notes/advances in ageing | Blocked on B7 and B4 — the things it would age do not exist yet. |
| **B7** supplier credit notes | §6 — researched and designed; a half-built `document_type` would make every AP figure depend on which query answered it. |
| **B8** WHT | §7 — blocked on B3 by its own accounting. |

🔴 **No accountant decision is outstanding from what was built.** Everything
delivered rests on IAS 37.11, the IFRS accrual basis as SOCPA endorses it, or a
product decision with no Saudi, VAT or ZATCA consequence. The questions that
*would* need him — the VAT treatment of a supplier advance (B4), and whether a
period close should refuse or merely warn on unposted drafts (A5) — attach to
work that was **not** started, so nothing is blocked waiting on him.
