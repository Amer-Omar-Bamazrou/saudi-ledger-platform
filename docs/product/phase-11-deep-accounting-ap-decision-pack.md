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

*(As-built records for each batch are appended below as they land.)*
