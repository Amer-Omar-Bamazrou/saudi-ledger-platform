# Phase 16 + 17 — manual product QA (2026-10-04)

**Status (2026-10-04): manual QA of PR #190 complete; the code defects it found
are fixed on `feat/phase16-17-tax-treasury` with regression tests; the design
questions are open for the owner and the accountant (§I).** Current state
authority: [CLAUDE.md §2](../../CLAUDE.md). Decision pack:
[`phase-16-17-tax-treasury-decision-pack.md`](../product/phase-16-17-tax-treasury-decision-pack.md)
§13.2 (F-16…F-25) and §13.3 (D-11…D-22).

A walk of the product as an accountant would use it — real clicks in Chrome,
the API the pages call, the database, the GL and the reports compared figure
by figure. Green CI was taken as a claim, not as the answer.

## A. Environment

| | |
|---|---|
| Code | `feat/phase16-17-tax-treasury` @ `e8426331` (fixes on top of it) |
| Database | `saudi_ledger_qa_1004` — created for this pass, migrated from zero (116 migrations), disposable |
| Servers | API :3000 and web :5173 built from the branch, pointed at the QA database |
| Browser | Chrome via Claude-in-Chrome (desktop 1280 px); Playwright sweep (1280 and 390 px × EN/AR) |
| Tenants | **Oasis Trading** (100 % Saudi, FY Jan–Dec, quarterly VAT — the month-end company); **Gulf Bridge** (MIXED, 40 % non-Saudi, monthly VAT — income tax, migration reversal, cross-tenant); **Legacy Cash** (Saudi — simulated pre-D-3 cash history for F-14) |
| Users | admin, accountant, bookkeeper, viewer (Oasis); admin (Gulf Bridge, Legacy Cash); platform operator |

Each company went through the product's own paths: signup → operator approval
→ company settings → banks → migration workspace (opening TB, parties, open
items, fixed asset; validate; commit) → FY2025 and FY2026 activity.

## B. Features exercised

**Phase 16.** Supplier residency / default nature / registration number (create
and edit); WHT in the bill pay dialog (live preview, partial payment) and the
supplier-payment dialog (advance, allocation, back-dated); WHT exceptions
(undeclared, re-declared non-resident, re-declared resident); treaty reliefs
(create, boundaries, pending vs approved, window, other nature, approve, delete);
the monthly return, remittance (double-click), reversal and re-remittance, SADAD
reference; exports (WHT return, computation, forecast); Zakat classification
(suggestions, manual class, header accounts), computation (blocked, approved,
revised into a closed year-end, ledger changed since approval), adjustments
(invalid, duplicate, locked), income tax (pool anchor, adjustments, MIXED with
losses, year not ended, no books), obligations.

**Phase 17.** Position (two banks, unattributed, in transit, reconciliation),
liquidity, funding requirement (with and without a shortfall), the forecast
(buckets, every row sourced, assumptions, the closing chart), payment plans
(create, double-click, boundaries, edit, edit-when-approved, approve, pay with a
treaty relief, future pay date, bill paid elsewhere, cancel), assumptions,
settings, bank transfer.

## C. End-to-end scenario (Oasis Trading)

Opening balances at 2024-12-31 (two banks 330,000; AR 34,500; AP 23,000; truck
120,000 less 24,000; end-of-service provision 15,000; capital 300,000; retained
earnings 122,500) → FY2025: four sales invoices, receipts, rent and office bills,
a non-resident consultant paid with 5 % WHT and remitted, quarterly salaries,
twelve months of depreciation → Zakat FY2025 classified, computed, adjusted,
approved (12,927.08), year-end locked, revised (13,442.62, the 515.54 difference
posted today) → FY2026: sales, partial receipt, overdue receivables, royalty
paid partly at 15 % then at a 10 % treaty rate, air freight paid back-dated,
bank transfer, payment plans, assumptions, buffer, forecast.

## D. Reconciliations (every one agreed)

| Check | GL | The other side |
|---|---|---|
| Trial balance | Dr 3,901,293.62 = Cr | — |
| Cash | 774,149 | Treasury total = Σ banks = bank-accounts page = balance sheet |
| AR | 193,250 | forecast expected receipts |
| AP | 50,599 | forecast bills + plans (T2 — no double count) |
| WHT payable | 8,150 | WHT ledger (W1) and the WHT page |
| Zakat payable | 13,442.62 | Σ accruals (Z4) = obligations |
| Zakat FY2025 | 12,669.31 → 12,927.08 → 13,442.62 | hand computation, step by step (Arts 21–28, 15(2)) |
| Income tax FY2025 (MIXED 40 %) | 9,510 → 9,910 | hand computation (pool 13,125 under Art. 17(e)) |
| Income statement FY2025 / FY2026 | 126,000 before Zakat / 267,000 | independent recomputation |
| Cash flow 2026 YTD | 455,000 → 774,149 | net change 319,149, reconciles |
| Exports | = the screens | WHT return, frozen computation, forecast |

## E. UX findings

No page scrolled sideways in 64 views (16 pages × EN/AR × 1280/390); every
Arabic view `dir=rtl`; no console errors. Copy explains refusals by name.
Findings: F-24, F-25 and D-15…D-19 below (tables need horizontal scroll at both
widths; plan pay form shows no WHT preview; links that drop their period; codes
shown raw).

## F. Security and permissions

**69 / 69** role attempts behaved as the permission spec says (read all; create
and update for writers; approve, pay, reject, reverse for approvers; delete for
admins only; treasury settings for approvers). **22 / 22** cross-tenant attempts
on another tenant's computations, plans, assumptions, reliefs, remittances,
classifications, bills, banks and exports were refused with the same answer as
a missing record (404 / `vendor_unknown`) — no existence oracle — and the target
tenant's rows were unchanged. The bookkeeper sees the action and an explained
refusal (the platform rule: explain, do not hide). No security finding.

## G/H. Defects found — fixed in this pass

Each fix has a regression test; the API ones were proven RED by reverting the
fix (mutations M15–M18) before going green.

| Id | QA | Severity | Defect | Fix | Test |
|---|---|---|---|---|---|
| F-16 | QA-11 | MEDIUM | None of the 55 Phase 16/17 trigger refusals was mapped: a remittance race, or a treaty rate above the statutory one, answered **500 "Internal server error"** | `lib/dbRefusals.ts` — one translation, by constraint, an exact allow-list (409 state / 422 named) | `phase16-17-qa-fixes` (M15 red) |
| F-17 | QA-11b | MEDIUM | A journal line on WHT_PAYABLE (the DEFERRED W3 trigger) answered **500 `commit_failed`, "please try again"** — no retry can pass — and **paged a critical database-health alert** | the commit path translates a recognised refusal to its 422 and logs it, never pages | `commit-before-response`, `phase16-17-qa-fixes` (M16 red) |
| F-18 | — | MEDIUM | The remittance's entry number carried `Date.now()`: two requests in one millisecond collided on the journal number (500) before the trigger decided | random suffix; `journal_entries_company_number_unq` → 409 (also covers ten pre-existing clock-numbered entry types) | `phase16-17-qa-fixes` (M18 red, clock pinned) |
| F-19 | QA-02 | MEDIUM | Every tax/treasury action was guarded by `isPending` only: a double-click **added a Zakat adjustment twice (the Zakat rose 257.77)**, created two identical plans, fired two remittances | `lib/singleSubmit.ts` `useGuarded` on all 28 mutations; the remittance sends an idempotency key | `singleSubmit.test.ts`; e2e `phase16-17-qa-fixes` (counts the POSTs) |
| F-20 | QA-12 | MEDIUM | The treaty-relief form **pre-filled the reduced rate with "0" — a full exemption** one approval away | empty by default, a typed fraction required, 0 explained | e2e |
| F-21 | QA-07 | MEDIUM | The bill pay dialog had **no date**: a payment entered after the fact was dated today and its **WHT fell into the wrong month's return** (pre-existing dialog; Phase 16 made the date legally significant) | a "Paid on" date (≤ today) feeding the request and the WHT preview | e2e |
| F-22 | QA-13 | LOW | A plan's WHT estimate ignored the supplier's declared default nature ("no estimate") and an approved treaty relief (statutory rate shown) | the pay path's own `decideWithholding` | `phase16-17-qa-fixes` (M17 red) |
| F-23 | QA-03 | LOW | "Start the computation" pre-selected the OLDEST year (2024 — the opening-balance year) | the latest completed fiscal year | `taxYears.test.ts` |
| F-24 | QA-01 | LOW | Company Settings said foreign and mixed ownership were "out of scope" | says which tax applies | e2e |
| F-25 | QA-16 | LOW | The funding recommendation printed raw money ("SAR 149028.08"); the forecast printed assumption category codes | formatted; labelled | `phase16-17-qa-fixes` (format); the label by eye |

### Reproduction (before the fixes)

- **F-16** — POST `/api/tax/wht/reliefs` with `reducedRate: 0.2` for a royalty (15 %) → 500. Or double-click "Record remittance" → second request 500. Expected 422 / 409 with a code.
- **F-17** — POST `/api/journal-entries` with a line on "Withholding tax payable" → 500 `commit_failed` and a critical alert. Expected 422 `wht_payable_unowned` with the trigger's sentence.
- **F-18** — two remittances of one month in the same millisecond → one 500 on `journal_entries_company_number_unq`. Expected the trigger's 409.
- **F-19** — `/tax/computations/:id`, fill an adjustment, double-click "Add adjustment" → two rows, Zakat 13,184.85 instead of 12,927.08. Same on "Create plan" (two plans) and "Record remittance" (one 200, one 500).
- **F-20** — `/tax/withholding?tab=reliefs` → the rate field reads 0; recording without touching it stores 0.0000.
- **F-21** — `/bills` → Pay a non-resident bill on 4 Oct for a payment made 30 Sep → the withholding is in October's return, due 10 Nov instead of 10 Oct.
- **F-22** — plan a non-resident bill whose supplier declares a default nature → "No nature stated — no estimate".
- **F-23** — `/zakat` on a company live from 2025-01-01 → the picker shows 2024.

**Accounting impact.** F-19 overstated a Zakat accrual if unnoticed before
approval; F-21 misdates WHT on the monthly return (late-remittance exposure);
F-20 risks 0 % withholding (Art. 68(C) personal liability). F-16–F-18 never
corrupted data (the database held) — they mis-told the user. **Security
impact:** none; F-17 also paged ops falsely.

## I. Questions for the owner and the accountant (not fixed — a decision, not a guess)

| # | Question | Why it matters | Severity |
|---|---|---|---|
| QA-08 | **How is a WHT-bearing payment corrected?** The generic reverse refuses an entry a withholding owns (right, for W1) and neither bill payments nor supplier payments have a reversal: a wrong nature, rate, amount, bank, date or supplier on a non-resident payment is **permanent** and the monthly return carries it. Same-month correction vs next month; before vs after remittance/filing? | posts + removes the correction | **HIGH** |
| QA-09 | **Is a refundable security deposit, an erroneous payment or an unidentified payment to a non-resident subject to WHT at payment?** Today every classification withholds at the supplier's default nature (reported on Form 06 as that nature), and the refund is then refused for any amount (`wht_refund_unsupported`, W-12) — the deposit or error cannot be recovered in the product. The pack's own reading (IR 63(7) "other payments" are services) points against withholding; the regulation must decide. | posts + removes the correction | **HIGH** |
| QA-14 | **On a migration batch reversal, what happens to the migrated fixed assets?** (pre-existing, Batch 1C × FA-D) They stay in service; a replacement batch adds a second copy and every depreciation run depreciates both (QA tenant: 24,000/yr instead of 12,000; register 120,000 vs GL 60,000). Mark reversed and exclude, or refuse the reversal while they are in service? The asset report's FA_COST/FA_ACCUMULATED controls do fail, with a hint pointing elsewhere. | posts every month; register ≠ GL; feeds Zakat and income tax | **HIGH** |
| Q-a | Should the forecast's "overdue and undated" bucket count overdue receivables as cash coming in (it does — the lowest projected closing assumes they are collected)? | treasury judgment | LOW |
| Q-b | W-8 default "nil months listed": from which month — the first withholding, the go-live date, the fiscal year? | the build lists only months with records | LOW |
| Q-c | Residency is undated: re-declaring a supplier resident clears the "possibly missed" view of payments made while it may have been non-resident. Effective-dated residency? | Art. 68(C) exposure visibility | LOW |
| Q-d | Refuse a treaty "relief" at exactly the statutory rate (accepted today — it relieves nothing)? | hygiene | LOW |
| Q-e | Refuse creating an inapplicable computation (income tax for a Saudi company; Zakat for a mixed one) rather than show a blocked paper? The Saudi company's income-tax record is then invisible in the UI. | hygiene | LOW |

## J. Implemented but incomplete from the user's side (documented, not fixed)

- **QA-15 (MEDIUM)** — the approvals inbox covers invoices, bills, journal entries and payroll only: a submitted computation version, a pending relief and a planned payment never reach it (budgets share the gap). A bookkeeper "submits"; the approver is never told.
- **QA-06 (LOW)** — D-01's own mitigation ("periods before it are not projected") lives on the VAT row, and there is no VAT row when the last completed period nets ≤ 0.
- **QA-04 (LOW)** — the classification page shows no balances; "Classify these accounts" lands on all 33 accounts, the 8 blockers unmarked.
- **QA-16 rest (LOW)** — the plans table needs horizontal scroll at 1280 and 390 px and clips its inline pay/edit form; the plan pay form shows no WHT preview (the other two pay dialogs do); obligations rows link to `/zakat`, `/vat`, `/tax/withholding` without the period; legal-reference strings stay English in Arabic (D-04 family); toasts prefix "HTTP 4xx" (platform-wide).
- Pre-existing, outside Phase 16/17: the invoice pay dialog also hard-codes today (no WHT effect; the Receive dialog has a date); the sidebar badge shows "VIEWER" for an org admin; an operator can approve an application with no documents; the income-statement API without dates covers all time.

## K. Passed with no issues

W1–W5 on real rows (including the treaty and the plan path); Z1–Z5 (hand-checked
to the halala, own accrual excluded, change in estimate into a locked year-end,
"inputs changed since approval"); income tax (pool, adjustments, I-1 refusal,
year-not-ended, no-books); F-01 end to end on a reversed opening bill (plan
blocks the reversal, refusals by name, forecast and position exclude it,
replacement `OPEN-3-1`); F-14 on simulated pre-D-3 cash history (listed,
classifiable, blocker clears, 1,288.84) and a true header still refused; T1–T4
(position = GL, no double count, exact chaining, one payment per plan); funding
with and without a shortfall; transfers move cash without P&L; plan lifecycle
(approved immutable, future pay date refused, a bill paid elsewhere refused by
name); exports = screens; permissions; isolation; RTL / 390 px.

## L. Recommended before merge

All code defects above are fixed in this pass (F-16…F-25). QA-08, QA-09 and
QA-14 need a decision, not code, and touch data only in mistake or edge cases;
with no customers and nothing deployed they are pre-production items — they must
close before a real taxpayer uses WHT or a migration reversal. QA-15 is the next
most useful build.

## M. Merge recommendation

**READY TO MERGE** once CI is green on the QA-fix commit — with QA-08, QA-09 and
QA-14 recorded as pre-production items for the owner and the accountant, not as
merge blockers. Merging is the owner's call.
