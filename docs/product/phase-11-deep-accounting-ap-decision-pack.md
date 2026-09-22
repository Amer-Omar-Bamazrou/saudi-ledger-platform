# Phase 11 — Deep Accounting & Deep Accounts Payable: audit, research and decisions

**Status (2026-09-22): THE AUDIT IS COMPLETE; implementation in progress.**
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

*(As-built records for each batch are appended below as they land.)*
