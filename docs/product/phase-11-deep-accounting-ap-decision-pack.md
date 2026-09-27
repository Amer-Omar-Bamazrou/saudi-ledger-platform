# Phase 11 — Deep Accounting & Deep Accounts Payable: audit, research and decisions

**Status (2026-09-23): PART 1 — A1, A2, A3, A4 and half of B6 BUILT (§1–§8). PART 2 — B3, B4, B5, B6, B7 and B8’s foundation BUILT (§9–§16), then AUDITED after the build and hardened (§17); §16 and §17.7 state what Part 2 did not build and why.**
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

## 6. B7 — supplier credit notes: the RESEARCH (built in Part 2, §13)

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

## 7. B8 — withholding tax: the integration points, and the boundary (foundation built in Part 2, §15)

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

## 8. What Phase 11 PART 1 did not do, stated as a boundary

> 🔴 **Superseded in part by Part 2.** B3, B4, B5, B6, B7 and B8’s foundation
> were built on 2026-09-22 — §9–§16. The table below is kept as the record of
> what was true at the end of Part 1; §16 is the current boundary.

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

---

# PART 2 — ACCOUNTS PAYABLE AS A SUBSYSTEM (2026-09-22)

## 9. 🔴 Why AP is a PARALLEL model and not the customer one, reused

The brief said not to force AP through the AR architecture if that architecture
is structurally customer-specific. It is, and the evidence is in the columns
rather than in an opinion:

| Fact | AR today | What AP needs |
| --- | --- | --- |
| `payments.customer_id` | the party column | a `vendor_id` |
| `payment_allocations.invoice_id` | **NOT NULL**, FK → `invoices` | a bill |
| `payments.direction` | `'in'` has the writers | money going OUT |
| the on-account account | `CUSTOMER_DEPOSITS` — a **liability** | an **asset** |

The third and fourth rows are the ones that decide it. Reusing
`payment_allocations` would mean making `invoice_id` nullable, and that column
being NOT NULL is what currently prevents a receipt being allocated to nothing
— a constraint worth more than the reuse. And the direction is not cosmetic:

🔴 **A customer advance is a LIABILITY** (we hold their money and owe them
goods). **A supplier advance is an ASSET** (they hold ours and owe us goods).
A mirror-image implementation gets a sign right by accident and an account
wrong on purpose.

`PRODUCT DECISION` — five new tables (`supplier_payments`,
`supplier_payment_allocations`, `supplier_payment_allocation_reversals`,
`supplier_payment_classifications`, `supplier_refunds`), sharing the AR side’s
**shapes** (a superseding correction, a derived balance, an append-only
record) and none of its columns.

## 10. B3/B4 — the accounting, stated once

A supplier payment posts **ONE balanced entry** naming where every riyal went:

```
Dr  Accounts Payable (vendor)      the part allocated to bills
Dr  <on-account asset>             the part that is not yet against anything
    Cr  <the bank's own cash account>              the whole amount
```

A LATER allocation of on-account money is its own entry —
`Dr AP (vendor) / Cr <on-account asset>` — so the subledger can always answer
“which bill did this advance settle, and when”, and **no posted entry is ever
mutated to do it**.

### 10.1 🔴 THREE on-account accounts, because their EXITS differ

| Classification | Account | How the balance LEAVES |
| --- | --- | --- |
| `advance` | `SUPPLIER_ADVANCES` | applied to a bill |
| `security_deposit` | `SECURITY_DEPOSITS_PAID` | returned, or forfeited into expense |
| `erroneous` / `unknown` | `UNIDENTIFIED_PAYMENTS` | **identified** |

`PRODUCT DECISION` — only an **advance** may be allocated to a bill. A
refundable deposit is not consideration for a supply; an erroneous or
unclassified payment has no stated purpose. Both are refused **by name**, and
reclassifying is an act somebody takes and the record shows. An unclassified
payment that quietly became an advance would assert a commercial fact nobody
stated.

`unknown` is the DEFAULT and is first-class. A payment nobody has classified
must read as unclassified rather than as an advance.

### 10.2 🔴 NO INPUT VAT ON ANY PAYMENT PATH

`AUTHORITATIVE (Saudi)` — VAT IR **Art. 49(7)**: Input Tax may be deducted only
where the Taxable Person **holds evidence** of the amount paid or payable. Our
evidence is the **supplier’s tax invoice**, which in this product is a BILL.
Paying money — advance, deposit or settlement — deducts nothing. Nothing on an
AP payment path computes input VAT, and the file that could be tempted to says
so at the top.

### 10.3 What the invariants are, and where they live

- **D-3**: every supplier payment names the bank the money left. Never a
  default, never inferred; a payment with no bank is refused 422.
- **The period**: checked BEFORE anything is written. A payment into a closed
  month is refused 423 with no row and no journal entry left behind.
- **Immutability at the DATABASE**: `supplier_payments` and
  `supplier_payment_allocations` carry BEFORE UPDATE triggers that refuse a
  change to amount, party, bank, date or journal; no role holds DELETE on any
  of the five tables. A correction is a **superseding record** — an allocation
  reversal, a refund, a reclassification — and one correction only: a second
  reversal of the same allocation is refused 409 by a UNIQUE index.
- **Every figure is DERIVED**: what is still on account, what a bill still
  owes, a bill’s paid status. There is no stored counter this path maintains —
  and in particular `bills.paid_amount` is NOT touched here, because it already
  has one writer (`billsService.pay`) and two writers moving one number is the
  drift the subledger exists to end.
- **One definition of the cap**: `validateAllocations` is the only place
  “more was applied than may be applied” is decided, for both callers, under
  one code. The duplicate in the caller could never fire while advertising a
  different code to the client — found and removed while writing the tests.

## 11. B4 — supplier advances and deposits

Built: the five classifications the brief asked for, as four stored kinds
across three accounts (§10.1), with reclassification posting **one** entry when
the account changes and **nothing** when it does not — the history row then
carries a null journal entry, which is how a reader tells the two apart.

Refunds: `Dr <bank> / Cr <on-account asset>`, capped at what is still on
account, and a reason is required because the supplier’s balance moves.

**B4.6 — migrated supplier advances is NOT built.** See §16.

## 12. B5 — the supplier statement, and the check it performs on itself

A statement answers two questions that are not the same question: **what is the
position**, and **how did it get there**. The position is four non-negative
components and a derived net:

```
payable        Σ (total − paid_amount − Σ live allocations)  over bills + debit notes
creditBalance  Σ approved credit-note totals − Σ live applications
advanceBalance / depositBalance / unidentifiedBalance   per classification
netPosition    payable − every one of the above          (DERIVED, never stored)
```

🔴 **How these map to the GL, including the one place they do not map one to
one.** The three on-account components are exactly `SUPPLIER_ADVANCES`,
`SECURITY_DEPOSITS_PAID` and `UNIDENTIFIED_PAYMENTS`. But `payable` and
`creditBalance` **both** live in AP(vendor), because a purchase credit note
posts its debit straight into AP (§13.2) — so the GL carries their
*difference*. They are shown separately because “what we owe” and “what they
owe us on a note” are different facts to a person reading a statement, and the
test ties `payable − creditBalance` to AP rather than pretending to two
accounts.

🔴 **The event stream and the position are two computations of one fact with no
forcing function between them, so they are COMPARED on every read and the
comparison is REPORTED** — both figures and their difference, agreeing or not.
A statement that silently disagrees with the ledger is a reconciliation tool
hiding the thing it exists to find.

### 12.1 The window, and the tie to the GL (added by the §17 audit)

The first build had neither, and the brief asked for both (“opening balance …
closing balance”, “date filtering must be deterministic”, “supplier subledger
↔ AP control ↔ GL”).

- **The window** — `from`/`to`, business dates, both ends inclusive. The
  running balances are computed over the WHOLE event stream in its one fixed
  order (business date, recorded time, kind rank, id) and only then cut, so
  the `opening` of a window is by construction the `closing` of the window
  before it, and the same request returns the same figures however the rows
  were typed. The self-check against the position is always over the whole
  stream: a window never hides a disagreement.
- **The GL tie** — per component, the subledger against the party-carrying GL
  lines for the supplier: AP carries `payable − creditBalance` (a credit
  note’s debit sits in AP), and each on-account component is its own asset.
  It is REPORTED, agreeing or not, never asserted: a pre-N3 control line with
  no party (RULE-P) cannot be attributed to a supplier, and hiding a real
  difference behind “legacy data” is the one thing a reconciliation must not
  do. The org-wide form of the same tie is in `scripts/ledgerInvariants.ts`
  (`ap_gl_vs_subledger_by_vendor`, now signed and subledger-aware, and the new
  `ap_on_account_gl_vs_subledger`).

Tests: `phase11-ap-hardening.test.ts` (“the statement WINDOW is
deterministic…”, and the invariants test with a planted break it must see);
`e2e/phase11-ap-subledger.spec.ts` (the window and the GL card, by clicking).

## 13. B7 — the purchase-side note, built

The research is §6. What Part 2 built:

### 13.1 One posting path, mirrored — not a second one

`documentType` on `bills` is `bill` | `credit_note` | `debit_note`, and a note
posts through **the same bill approval path**, with the sign taken from
`documentSign()` — the one definition the AR side, the VAT return and both
ageings already use:

```
bill / debit note    Dr expense   Dr input VAT      Cr AP
credit note          Cr expense   Cr input VAT      Dr AP
```

A DEBIT note is `+1`: an additional charge, not a reversal. Amounts stay
**positive** in storage and the direction lives in the type.

### 13.2 🔴 Applying an approved note posts NOTHING

An approved note has already moved the GL, and its unapplied balance is a
**debit already sitting in AP** for that supplier — which is exactly what it
is. Applying it to a bill records **which payable it answers**; a second entry
would move AP twice for one economic event.

This is deliberately **not** symmetrical with an advance, which sits on its own
asset account and must be MOVED INTO AP when applied. Where each balance
already sits is what decides whether applying it posts.

`ERPNEXT` — a return (`is_return = 1`) Purchase Invoice debits the Creditors
account; `reconcile_against_document` links it to the original through the
reconciliation tooling and writes no GL Entry for the link.
`ODOO` — an `in_refund` move posts to Account Payable, and reconciling it
against a vendor bill is a reconciliation over existing move lines; it creates
no new `account.move`.
`PRODUCT DECISION` — the GL placement carries no Saudi/VAT consequence (the tax
consequence is the PERIOD, §13.3), so it is decided here rather than escalated.

### 13.3 🔴 The VAT return’s purchase side now carries a SIGN — and did not before

`AUTHORITATIVE (Saudi)` — Art. 40(6): the CUSTOMER corrects its Input Tax **in
the Tax Period in which the note was issued**. So the note carries its own
date — the supplier’s issue date, asked for rather than defaulted from the
original bill — and the return filters on it.

The purchase loop in `reports.service.ts` summed every bill positively. Filing
a credit note positive would claim a deduction **twice**, in the one direction
the taxpayer benefits from and an auditor looks for. It is
`sign * value` now, and the test asserts all three periods: the bill’s month
(+10,000 / +1,500), the note’s month (−2,000 / −300), and both together
(8,000 / 1,200).

### 13.4 The guards at the write boundary

`assertPurchaseNote` runs inside `billsService.create`, where the row is
written, not in a service beside it:

- a note must name an **approved** bill; a plain bill may **not** name one
  (both halves, so neither an orphan note nor a bill pretending to be one can
  be stored — and the DB CHECK says the same thing);
- a note **inherits** the original’s supplier: a note pointing at one
  supplier’s bill while naming another is not a thing that can be true, so it
  is made inexpressible rather than refused;
- a CREDIT note may not exceed what the bill was **charged**, less what other
  notes have already credited. The ceiling is the charge, not the outstanding:
  a bill already PAID can be credited in full (the supplier owes the money
  back). A DEBIT note has no ceiling — it is an additional charge;
- `documentType` and `creditNoteAgainstBillId` are **not editable**: what a
  document IS is decided when it is entered, and letting an approved bill
  become a credit note by PATCH would flip the sign of an entry that has
  already posted;
- 🔴 a note against a **capitalised** bill is refused. Reversing part of an
  asset’s cost changes a depreciation schedule whose posted rows are frozen,
  and the register owns that correction — posting here would put the register
  and the GL out of agreement in the exact place `/assets/report` exists to
  surface.

### 13.5 🔴 Two holes a posted note opened, closed in the same batch

A posted credit note is a `bills` row in `received` status — **exactly like a
bill** — so every path that keys on STATUS alone treated it as payable:

1. `POST /bills/{id}/pay` would have posted `Dr AP / Cr cash` against a note:
   paying a document that reduces what we owe.
2. `validateAllocations` would have accepted a note as the TARGET of an
   advance: settling something that is already a reduction.

Both are refused now, both are asserted, and a DEBIT note is deliberately
allowed in both places — it is an additional charge. Found by reading the paths
a new document type reaches, which is the question worth asking whenever a type
column gains a value: *what else keys on the column this value does not change?*

## 14. B6 — the AP ageing, complete

It read `total − paid_amount`, the legacy per-bill counter alone: an advance
applied to a bill, a payment recorded through the subledger and a supplier
credit note all left the bill looking fully unpaid. It is the AR ageing’s twin
now:

- outstanding nets **live** allocations (payments and applied credit notes), so
  a reversed allocation puts the exposure straight back;
- a **credit note is not aged as a row** — it is applied to bills, and ageing
  it would double-count the reduction it already made;
- a **debit note ages like a bill**, with its own date and due date;
- 🔴 what the supplier **holds** — advances, deposits, unidentified payments,
  unapplied credit notes — is shown **beside** the buckets and never inside
  one. Netting an advance into a bucket would make an overdue bill read as less
  overdue because unrelated money sits with the same supplier. The net supplier
  position is derived and labelled so.

## 15. B8 — withholding tax: the FOUNDATION only, and the boundary restated

Built: the `WHT_PAYABLE` liability account, and `vendors.residency`
(`resident` | `non_resident` | `unknown`, defaulting to `unknown`), writable
through the vendor form and the API.

🔴 **This is a FACT ABOUT THE SUPPLIER, NOT A TAX RULE**, and that boundary is
the whole of what this batch built. `AUTHORITATIVE (Saudi)` — Income Tax Law
Art. 68 makes a resident payer withhold on amounts paid to a **non-resident**
from a source in the Kingdom, so residency is the input every WHT question
starts from; recording it costs nothing and is not a judgment.

🔴 **What is deliberately NOT built**: no rate, no automatic withholding, no
deduction at payment, no Form-Q filing. The By-Laws set **different rates by
the NATURE of the payment**, and classifying a payment’s nature is an
accounting judgment this platform must not guess. `ACCOUNTANT DECISION
REQUIRED`, and the board already has withholding tax **awaiting the owner’s
ranking**. `unknown` being the default matters for the same reason: “resident”
is the answer that withholds nothing, and must never be assumed.

## 16. 🔴 What PART 2 did not build, and why

| # | Why |
| --- | --- |
| **B4.6 — migrated supplier advances** | The migration subsystem is a batch of its own (staging table, importer, validator, commit path, reversal), and the brief said not to redo migration. An opening supplier advance would need the Policy-C reversal machinery the customer side has (`migration_deposit_reversals`), which is not a column — it is a lane. |
| **Statement-line MATCHING for supplier payments** | Bank *integration* is done at the ledger level: every supplier payment names its bank (D-3) and posts to that bank’s own GL cash account, so it is in bank reconciliation already. What is not built is deterministic matching of a supplier payment to a bank statement ROW — the Phase D engine (`statement_matches`) joins `payments` and is receipt-shaped throughout. Extending it to a second payment table is its own batch. |
| **A5 period close, A6 retained earnings, A7 FX, A8 dimensions** | Out of scope for Part 2 by the brief. §4, §5 and §8 stand. |
| **Approval limits (B2)** | Supplier payments carry the `payments` permission and the `approve` action on allocation and reversal, the same authority the customer side uses. A per-amount approval limit is a product decision nobody has taken. |

🔴 **Three columns were REMOVED before this schema was ever committed**:
`supplier_payments.source_transaction_id`, `.migration_batch_id` and
`.source_reference`. Each was written for work in the table above, and each had
no writer and no reader. A column that looks exactly like progress and holds
nothing is the shape this codebase has already named three times
(`feature_flags`, `branches`, `departments`): build the consumer, or do not add
the column. When either piece of work lands it adds its own column, in its own
migration, and the column will mean something on the day it appears.

🔴 **No accountant decision is outstanding from what Part 2 built.** Every
accounting claim above rests on a cited authoritative Saudi text (Art. 40(6),
Art. 49(7), Art. 68), on a product decision with no Saudi/VAT/ZATCA
consequence, or on both reference implementations agreeing and the placement
being a presentation choice. The questions that *would* need the accountant —
the WHT rate by payment nature (§15) and whether the VAT treatment of a
supplier advance ever differs from “nothing until the bill” (§10.2 answers it
from Art. 49(7), but the accountant should confirm the reading) — attach to
work that is not started or to a reading the text states plainly.

---

## 17. 🔴 The post-build audit (2026-09-23): correct inside its files, wrong at its edges

Part 2 was built, documented and **uncommitted** when the working session
ended (a machine shutdown). The resumed session did not assume it finished or
failed: it recovered the state (§17.1), ran it (17/17 API tests green on real
rows), and then **audited it the way this codebase audits** — by asking, of
every path a new fact reaches, *what else reads the thing this changed?*

The build was right inside the files it touched. Every defect below lives at
an EDGE: a place an older path reads what Part 2 wrote, or a place Part 2
reads what an older path wrote. None was visible to the suites it shipped
with, because each suite built its request the way its own code expected.

### 17.1 The recovered state

Branch `feat/phase11-deep-accounting-ap` at `97607b27` = PR #177 (Part 1,
open, unmerged). Part 2 entirely in the working tree: migrations 0096/0097
(applied to the dev database; **0096's file had been edited after it was
applied** — a fresh database migrated from the files was diffed against the
dev database: tables, columns, constraints, indexes, triggers and RLS
policies identical, the 15 function bodies differing only in line endings),
the services, routes, three pages, two API suites, one browser spec, this
pack's §9–§16 and a trimmed CLAUDE.md. Pricing branch and `stash@{0}`
untouched.

### 17.2 The findings, ranked by the path they sit on (CLAUDE.md §3 triage)

| # | Defect | Path consequence | Fix | Test |
| --- | --- | --- | --- | --- |
| **H1** | The legacy `POST /bills/{id}/pay` computed `total − paid_amount`. A bill an advance had settled read as fully unpaid, so paying it again was **accepted**. | POSTS: Dr AP twice for one debt; the supplier over-paid; nothing flags it (the ageing read the same wrong figure). | Reads `billsRepository.outstandingOf(id, { lock: true })` — billPosition, under a row lock. | hardening #1 (red on its mutant) |
| **H2** | Reversing a **credit-note application** went through the payment branch, found no payment, defaulted the classification to `advance`, and posted **Dr SUPPLIER_ADVANCES / Cr AP**. | POSTS to the wrong account: an advance no payment explains, AP raised by a note that did not change. Unnoticed: nothing tied the on-account assets to the GL. | A note application is undone with **no entry** (its application posted none); the reversal row carries a NULL entry. A **DB trigger** (0098) now refuses a reversal whose journal entry does not follow what it reverses — both directions. | hardening #2, #2b; e2e undo (red on its mutant) |
| **H3** | One request naming the same bill twice passed both checks — each line was compared to the stored balance, not to its siblings. | POSTS an over-settlement. | A bill is named once per request (`allocation_duplicate_bill`, 422, nothing written). A LATER request applying more from the same source is a legitimate second application. | hardening #3 (red on its mutant) |
| **H4** | **Eight readers** kept `total − paid_amount` or summed a credit note positively: vendor `totalBilled`/`balance` (whose comment still said *"bills has no `document_type` column"* — an obsolete assertion), the Bills headline and overdue count, **bank-match candidates** (which offered credit notes and settled bills), the overdue-payables finding, supplier-spend analytics, the migration-reversal guard, and the AP subledger invariant. | HIDES, and COMPOSES with H1: a bank debit matched to a settled bill was paid through H1's path. | **One definition** — `repositories/billPosition.ts` (sign, payable-ness, live applied, outstanding, AP contribution; three dialects like `openingReversal.ts`). Every reader imports it. | `bill-position-reader-sweep.test.ts` (written RED first: it listed the 12 files; planted positive; a second check that no exempt file restates the expression — which caught one, allowed with its reason); hardening #4 |
| **H5** | The migration-reversal guard checked `paid_amount` only for bills. | REMOVES THE CORRECTION's safety: a batch could be reversed from under an opening bill a supplier payment had settled or a note had corrected, leaving live allocations against a reversed row. | Mirrors the invoice half: any allocation (live or reversed), any note, plus the counter. | hardening "migration-reversal guard" (with a planted negative) |
| **H6** | `UPDATE` was granted on all five subledger tables; the allocation trigger guarded only rows WITH a journal entry, so a credit-note application (entry NULL) was **editable** by the app role. | REMOVES THE AUDIT: a fact of record could be rewritten. | 0098 revokes UPDATE on the four append-only tables; `supplier_payments` keeps it for `classification` only, under its trigger. | the immutability test, strengthened (all four tables, plus a positive control) |
| **H7** | `source` was client-writable (a manual payment could be stamped `opening` — migration provenance for a lane that does not exist); `idempotency_key` was stored but never honoured (a retry was a second payment); `supplier_payment_allocations.idempotency_key` had **no writer and no reader**. | POSTS twice on a retry; forged provenance. | `source` is always `manual` on this path; a replayed key returns the original payment; the dead column is dropped in 0098 (one request writes several allocation rows, so a per-row key could never have represented a replay). | hardening #5 |
| **H8** | No row locks anywhere on AP settlement. | Two concurrent settlements could each read the same balance. | The bill row (`FOR UPDATE`, ascending id order) on every path that applies money, and the source payment/note row on every act that spends what is on account. Identity checks run on an unlocked read first, so a request about to be refused never waits on a lock. | reasoned, not raced in a test (see §17.7) |
| **H9** | The statement had no window, no opening/closing balance, no GL tie. | — (a brief requirement unmet) | §12.1. | hardening #6; e2e |
| **H10** | The UI: the refund posted to **`banks[0]`** — the first bank in the list, invisibly (a D-3 violation: *"never a default … server OR UI"*); "Undo" **invented a reason** when the box was empty; the bill pickers showed the TOTAL and offered fully-paid bills; the Bills page offered **Pay on a credit note** and prefilled Pay with `total − paid`; the new pages declared their response shapes as local `type` aliases (the ratchet's named anti-pattern) over endpoints that ARE in the contract; statuses rendered raw English in Arabic. | POSTS to an account nobody chose; a reason nobody gave in the audit trail. | A visible, required refund-bank picker (the one allowed pre-selection is a bank the user marked default, as on the Bills pay dialog); the reason is sent as typed and an empty one is refused, shown; pickers list what each bill OWES; the Bills page labels notes and offers Apply instead of Pay; every page consumes the GENERATED client. | e2e (refund, empty-reason refusal, Bills page), four modes |

🔴 **Found by the new e2e before it shipped**: the per-supplier bill picker was
first written as `useListBills({ vendorId })`. The list's filter is
`vendor_id`; the untyped object escaped TypeScript's excess-property check,
the server ignored the key, and the picker would have offered **every
supplier's bills**. It is typed as the generated `ListBillsParams` now, and
the page also filters by `vendorId` itself. This is CLAUDE.md's *"a server
test cannot see the client's request construction"* — again.

### 17.3 The one definition, and why it is a module and not a helper

What a purchase document owes is read in eleven places. Part 2 changed both
halves of the old expression (a document can now be a credit note; money now
arrives through two writers), and the first build updated the three readers
it was working on. That is the shape `openingReversal.ts` was built against —
*"a reader fixed one at a time is a reader missed one at a time"* — so the
same countermeasure: one module, imported by every reader, and a sweep that
fails when a new file reads bill amounts without it. Two facts, each with ONE
writer, are read together and neither is folded into the other:
`bills.paid_amount` (only `billsService.pay`) and live
`supplier_payment_allocations` (only the AP subledger services).

### 17.4 Where each invariant now lives

| Invariant | Enforced by |
| --- | --- |
| Balanced supplier payments, notes, allocations, reversals, refunds | `postJournalEntry` (every AP entry goes through it) |
| No allocation above what the source has, or what the bill owes | `validateAllocations` (the ONE cap), under row locks |
| No duplicate bill in one request; one correction per allocation | the validator; the UNIQUE index on `allocation_id` |
| A reversal's entry follows its source | the 0098 trigger (and the service) |
| Posted records immutable | no UPDATE/DELETE grant on the append-only tables; the payment trigger |
| Subledger ↔ AP control ↔ GL, per vendor | `ledgerInvariants.ts` (two AP invariants) and the statement's GL tie |
| Period locks | `checkPeriodOpen` before anything is written, on every AP act that posts |
| What a bill owes | `repositories/billPosition` + its sweep |
| No input VAT on a payment path | nothing on the path computes VAT (§10.2) |
| Migration provenance cannot be forged | `source` is not an input |

### 17.5 ERPNext and Odoo, for the B3/B4 decisions (§9–§11) — read from source

The first build recorded ERPNext/Odoo for B7 and B8 but not for the B3/B4
decisions it rests most on. Read on 2026-09-23 from the source (ERPNext
`version-15`, Odoo `17.0`; paths relative to `erpnext/` and `addons/`), per
the escalation protocol — implementation evidence, never a Saudi requirement.

| Decision | `ERPNEXT` | `ODOO` | `SAUDI LEDGER` |
| --- | --- | --- | --- |
| **Where an unallocated supplier payment sits** | By DEFAULT a **debit on the Creditors (payable) account**: `add_party_gl_entries` books the unallocated amount to `self.party_account` (`accounts/doctype/payment_entry/payment_entry.py` L1428–1458). An **opt-in** company setting, `book_advance_payments_in_separate_party_account`, is described in the product itself as recording *"Advances Paid in an **Asset Account** instead of the **Liability Account**"* (`setup/doctype/company/company.json` L787–791; account `default_advance_paid_account`, L769–779; switch in `set_liability_account`, payment_entry.py L151–209). | A **debit on the vendor's payable** (`property_account_payable_id`), against an outstanding-payments account — two lines and no advance account (`account/models/account_payment.py` L527–552, L287–351). The Saudi chart (`l10n_sa/data/template/account.account-sa.csv`) has no "advance to supplier" account. | An **asset**, always — ERPNext's opt-in mode as the only mode. |
| **Applying the advance to a later bill** | Default mode: no new GL voucher — the payment-ledger rows are rebuilt against the invoice (`accounts/utils.py` `reconcile_against_document` L460–530, L512–518). Separate-account mode: **two new GL rows** — Dr the invoice's Creditors account, Cr the advance account, on the reconciliation date (`add_advance_gl_for_reference`, payment_entry.py L1511–1580). | A reconciliation LINK only — `account.partial.reconcile` rows, no new move (`account/models/account_move.py` L4290–4299; `account_move_line.py` L2600–2623). | **Its own entry**, Dr AP / Cr the asset — ERPNext's separate-account behaviour. |
| **Undoing an allocation** | A submitted `Unreconcile Payment` document records the act, but the links beneath are **edited in place** (GL `against_voucher` nulled, payment-ledger rows re-pointed, advance rows hard-deleted — `accounts/utils.py` L895–964, L1016–1063); in separate-account mode the GL rows are reversed with **mirror entries** (`accounts/general_ledger.py` L664–785). | The partial-reconcile rows are **deleted** (`account_move_line.py` L3149–3151; `account_partial_reconcile.py` L100–133); only derived exchange/cash-basis moves are reversed. | A **superseding record**: the allocation row is never touched (no UPDATE or DELETE grant), a reversal row answers it, and the mirror entry is posted when — and only when — the allocation posted one. |
| **Refund from a supplier** | Permitted: a Payment Entry `Receive` with a Supplier party credits the party account (payment_entry.py L78–81, L1429; L3294–3303). An end-to-end refund flow was NOT verified. | Named: `('inbound', 'supplier')` is *"Vendor Reimbursement"* (`account_payment.py` L220–225). | Dr the bank / Cr the asset it was held on, capped at what is still on account, reason required. |
| **Refundable deposits paid** | No concept in the payment code; chart accounts only ("Securities and Deposits"/"Earnest Money", `verified/standard_chart_of_accounts_with_account_number.py` L26–29). | No concept in the payment code; chart accounts only (`l10n_sa` "Deposit – Office Rent", "Deposits – Customs", L39–42). Search bounded to the payment and chart files named. | A classification with its own account, **refused as a settlement of a bill**. |
| **Input VAT on an advance** | `advance_tax` on a Purchase Invoice is withholding tax (TDS), not VAT (`purchase_invoice.py` L1972–2067). No VAT-specific advance logic found. | 17.0 has no purchase down payment; 18.0 adds one as a **vendor-bill line carrying its own taxes** (`purchase/wizard/bill_to_po_wizard.py` L43–70). How the final bill nets it was NOT verified. | Nothing on any payment path (§10.2); the supplier's advance TAX INVOICE is open question **Z-AP1** (§17.7). |

**What the comparison decides, and what it does not.** Neither product treats
an unallocated supplier payment as an asset by default — so "both products do
it" is NOT the argument for §10.1, and the pack does not claim it. The argument
is the standard, below; ERPNext's opt-in mode is evidence that the model is a
recognised one, and its allocation entry (a new GL row, not a link) is the same
shape this build uses.

### 17.6 Why the advance, the deposit and the unidentified payment are three accounts — `STANDARD (IFRS)`

IAS 32 **AG11** (read from the IFRS Foundation text, 2024 issued standards):

> "Assets (such as prepaid expenses) for which the future economic benefit is
> the receipt of goods or services, rather than the right to receive cash or
> another financial asset, are not financial assets."

A supplier **advance** is exactly that — its benefit is the goods — so it is a
**non-financial** asset that leaves by being applied to the supplier's
invoice. A **refundable security deposit** is the opposite case: its benefit is
the **cash coming back**, a contractual right to receive cash, i.e. a
**financial** asset (a receivable). Holding the two on one account would mix a
financial and a non-financial asset in one balance — so the separation §10.1
made because their EXITS differ is also the separation the standard's own
classification draws. An **unidentified or erroneous** payment is money whose
nature is not yet known; it waits on its own account until somebody states
which of the two it is, which is why only a classification act — recorded,
with its own entry when the account changes — can move it.

`PRODUCT DECISION` on top of the standard: an advance is the only one of the
three that may settle a bill; the other two are refused by name.

### 17.7 What is still NOT built, or not proven, after the audit

| # | What | Why |
| --- | --- | --- |
| **Concurrency, proven by a race** | The locks (H8) are reasoned from Postgres semantics and exercised by every test, but no test RACES two settlements. | A deterministic race test needs two tenant transactions interleaved on purpose; worth building with the next AP batch rather than faked with timing. |
| **Z-AP1 — the supplier's ADVANCE tax invoice** | When a supplier issues a tax invoice for an advance we paid (their tax point is the receipt), Art. 49(7) lets us deduct its input VAT once we HOLD that invoice. There is no document path for it: recorded as a bill it posts AP, not against the advance asset, and the supplier's later final invoice deducts the prepayment. | 🔴 **ACCOUNTANT DECISION REQUIRED** — the question, as sent: *"When a supplier gives us a tax invoice for an advance we paid, should the input VAT be claimed in the period of that advance invoice (and reversed through the final invoice's prepayment deduction), and how should the advance invoice be recorded against the advance already paid?"* Until answered the platform claims nothing on an advance — conservative (it never double-claims), but it defers a deduction the taxpayer may be entitled to. |
| **Statement line descriptions in Arabic** | The event descriptions the server writes ("Bill received", "Payment to the supplier …") are English; the page shows a translated KIND badge beside them. | An Arabic-coverage gap the sweep cannot count (it reads the web source, not server strings). Recorded, not fixed here. |
| **Migrated supplier advances; statement-line matching for supplier payments; approval limits** | As §16. | Unchanged by the audit. |

`AR` was not touched by any fix above except where it shares a reader, and
there the change is additive: `computeAging` in the web app ages on the
server's `outstanding` only when a document carries one (bills do; invoices do
not), and the AR ageing, AR payment and customer-advance suites run unchanged
in the gate.

### 17.8 Z-AP1, in the protocol's blocker format

> **ANSWERED 2026-09-24 — A** (claim input VAT in the supplier advance tax invoice's period, with controls preventing a duplicate claim at the final invoice). Built: [Phase 12 pack §8](phase-12-banking-reconciliation-decision-pack.md). The blocker below is the question as it stood.

```
ACCOUNTING BLOCKER — Z-AP1 (does NOT block anything built; blocks the purchase-side advance-invoice path, which is not built)
- Question — When a supplier issues us a TAX INVOICE for an advance we paid, how is its
  input VAT claimed, and how is that invoice recorded against the advance already paid?
- Why it matters — the supplier's tax point is the receipt of our money (GCC Agreement
  Art. 23(1); IR Art. 53(1)(a)(2) — both read as primary texts in the advance-payments
  pack §8), so a VAT-registered supplier must issue us a tax invoice for the advance.
  Holding it entitles us to deduct its input VAT; the supplier's final invoice then
  deducts the prepayment.
- Saudi Ledger current behaviour — no AP payment path computes VAT (§10.2). An advance
  sits on SUPPLIER_ADVANCES with no VAT; input VAT enters only with a BILL. A supplier's
  advance tax invoice has no path of its own: entered as a bill it would post AP and
  a second input-VAT line, not settle against the advance.
- Odoo — 17.0 has no purchase down payment; 18.0 adds one as a vendor-bill line carrying
  its own taxes (purchase/wizard/bill_to_po_wizard.py L43–70). How the final bill nets
  it: NOT verified (§17.5).
- ERPNext — no VAT-specific advance logic found; a Purchase Invoice's `advance_tax` is
  withholding tax (purchase_invoice.py L1972–2067) (§17.5).
- Accounting and regulatory sources —
  · IR Art. 49(7) (repo text, docs/zatca/specs/KSA_VAT_Implementing_Regulations_EN.txt
    L1507–1509): "Input Tax may only be deducted where the Taxable Person holds evidence
    of the amount of Input Tax paid or payable in a form specified in Article forty-eight
    of the Agreement" — the deduction follows the DOCUMENT, not the payment.
  · IR Art. 49(8) (same, L1521–1525): a deduction "may be made … in a Tax Period
    subsequent to that Tax Period including the date of Supply", but not "more than five
    calendar years after the calendar year in which the Supply takes place".
- Where they agree — no source makes the PAYMENT the trigger for our input VAT.
- Where they differ — nothing contradicts; the gap is our document path, not the rule.
- Proposed options — (a) record the supplier's advance tax invoice as a purchase document
  that carries input VAT and is SETTLED by the advance (a purchase-side 386), with the
  final invoice's prepayment deduction reversing it; (b) keep deferring the whole
  deduction to the final bill, as now.
- Recommended engineering default — (b), which is what runs today: it never claims a
  deduction twice and never claims one without the document; by Art. 49(8) the
  entitlement is DEFERRED, not lost, inside five calendar years. It does cost the
  taxpayer the timing of the deduction.
- Exact question for the accountant — "When a supplier gives us a tax invoice for an
  advance we paid, should we claim its input VAT in that invoice's period and reverse it
  through the final invoice's prepayment deduction — or is deferring the whole claim to
  the final invoice acceptable practice for our tenants?"
- Implementation impact — only the purchase-side advance-invoice path. Supplier payments,
  advances, allocations, notes, ageing and statements are unaffected.
```
