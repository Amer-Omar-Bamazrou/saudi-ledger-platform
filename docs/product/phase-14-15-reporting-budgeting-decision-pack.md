# Phase 14 + Phase 15 — Financial Reporting & Analytics; Budgeting & Planning

**Status (2026-10-01): both phases implemented, reviewed (§6.1) and tested on
the branch below; the PR is open and NOT merged. Written before the code, and
corrected where the build or the reviews proved a decision wrong (D14-03,
D14-15 — marked in place).**
Current state authority: [CLAUDE.md §2](../../CLAUDE.md).
Branch: `feat/phase14-15-reporting-budgeting` (from `main` @ `0b0175da`).

Each decision below gives the rule, its basis, and what tests it. The basis
is marked **AUTHORITY** (a Saudi regulator's or standard-setter's own text)
or **PRECEDENT** (Odoo / ERPNext source, which is never regulatory). A
decision with neither is a **PRODUCT** decision and says so. Open questions
are listed as **OPEN** and are not marked resolved.

---

## 0. Referent check — the phase names (READ FIRST)

The owner's master roadmap (2026-10-01 instruction) names the two phases:

- **Phase 14 — Financial Reporting & Analytics**
- **Phase 15 — Budgeting & Planning**

The repository does not contain that roadmap. `docs/product/roadmap.md` has
no numbered phases. The only earlier repo uses of "Phase 14" name
**inventory** as a deferral target:

- D13B-09 (`phase-13b-vat-claim-ledger-discovery.md` l.874, l.955);
- `phase-13b-vat-claim-ledger-architecture.md` l.36, l.101, l.767 R4, l.830;
- `phase-13b3-opening-payable-credit-note-decision-paper.md` l.482.

This pack follows the owner's names. Those historical documents are **not
edited**. Their "Phase 14 (inventory)" label is stale against the owner's
roadmap; finding **F-00** asks the owner to re-home the inventory deferral.

---

## 1. Research record (sources consulted 2026-10-01)

Full research notes, with extracted primary texts, are kept outside the repo
in the session scratchpad. What follows is the record each decision cites.

### 1.1 Saudi authority

- **SOCPA "Document of endorsement of IFRSs and IFRS for SMEs"**, revised
  04/07/1447H (24/12/2025) — "SOCPA-ED".
  - Listed entities apply IFRS as endorsed from 1/1/2017; other entities from
    1/1/2018 ("Approval and Revisions" ¶1).
  - IFRS for SMEs 3rd edition endorsed 24/12/2025, effective 1/1/2027.
  - KSA modifications:
    - IAS 1.54(n) adds a zakat-payable line; 82(d) reads "tax expense and
      Zakat".
    - IAS 7.14(f) and 7.35 classify zakat paid as **operating** unless
      specifically identified with investing or financing.
    - IFRS 18 as endorsed (endorsed 26/12/2024) adds a "Zakat and income
      taxes" category.
- **IAS 1** (IASB text as reproduced in Reg. (EU) 2023/1803 and 2023/2822):
  - ¶60 — current / non-current classification required unless a liquidity
    presentation is reliable and more relevant.
  - ¶66–76 — the classification criteria.
  - ¶99–105 — expenses by nature or by function. Gross profit is **not** a
    required line; ¶103 requires only cost of sales, and only under the
    function method.
  - ¶106–110 — the statement of changes in equity: profit flows into
    retained earnings. No closing journal is required.
  - ¶38 / 38A — at least one comparative period.
  - ¶51(e), ¶53 — disclose the level of rounding.
- **IFRS for SMEs:** §4 (statement of financial position), §5 (profit or
  loss), 6.5 (statement of income and retained earnings), §7 (cash flows),
  3.14 (comparatives).
- **IAS 7:**
  - ¶6–9 — cash and cash equivalents. ¶9: "movements between items that
    constitute cash or cash equivalents" are not cash flows.
  - ¶13–17 — operating, investing and financing activities. ¶16: only
    expenditure that creates a recognised asset is investing.
  - ¶18–19 — direct method encouraged; indirect permitted.
  - ¶31–34 — interest and dividends: classification is a policy choice in the
    IAS 1 era.
  - ¶35–36 — taxes (and, per SOCPA, zakat) are operating.
  - ¶43–44 — non-cash transactions are excluded.
- **IFRIC agenda decision, August 2005 (VAT in cash flows):** IAS 7 is silent;
  entities should disclose whether gross cash flows are inclusive or
  exclusive of VAT.
- **Commercial Books Law** (M/61, 1409H):
  - Art. 1 — books in Arabic: journal, inventory book, general ledger.
  - Art. 8 — retention of at least 10 years.
- **VAT Implementing Regulations** (ZATCA, 8th ed.):
  - Art. 66 — records kept 6 years (15 for real estate), in Arabic, in the
    Kingdom.
  - Art. 62(2) — the content of the VAT return.
  - Art. 63(3) — corrections under SAR 5,000 go through the next return.
- **ZATCA VAT-return form:** 16 boxes, each with an Amount / Adjustment / VAT
  column (simplified VAT-return guide, 2023; e-services manual 009,
  2026-07-29).
- **Budgets:** no Saudi requirement for private companies. CMA Corporate
  Governance Regulations Art. 21(1)(b) makes approving estimated budgets a
  board function for **Main Market listed** companies only.

### 1.2 Implementation precedent

**ERPNext** — `frappe/erpnext` version-15 @ `4cea6a7f` and develop @
`d607837e`; read, not run.

- `financial_statements.py`: the P&L excludes Period Closing Voucher rows. The
  balance sheet shows "Provisional Profit/Loss" for the unclosed period,
  computed as assets − (liabilities + equity) — a plug that balances by
  construction.
- `trial_balance.py`: opening, debit, credit and closing columns. P&L openings
  reset at fiscal-year start unless `show_unclosed_fy_pl_balances` is set.
- `cash_flow.py`: **indirect only**, sections by account type. It does not
  reconcile to the Cash/Bank accounts.
- `accounts_receivable.py`: `report_date` is the as-of date. It reads the
  payment ledger up to that date; ageing is by due date, falling back to
  posting date.
- `budget.py`:
  - submittable, one fiscal year per budget;
  - a child table of P&L accounts only, with a monthly distribution;
  - actuals from posted GL (`is_cancelled=0`);
  - revision = cancel + amend (`-1`, `-2` …);
  - no workflow ships with it.
- `budget_variance_report.py`: variance = budget − actual. Income accounts get
  no sign handling.

**Odoo** — `odoo/odoo` 17.0 @ `66d9bd64` and 18.0 @ `e8caab06`. The report and
budget engines are **Enterprise**; Community holds only the data model.

- `account_type = equity_unaffected` ("Current Year Earnings"), one per
  company. `include_initial_balance` is False for income and expense, so P&L
  resets at fiscal-year start virtually.
- Docs: current-year earnings are computed in real time; no year-end journal
  is required.
- `account_data.xml`: tags "for cash flow statement **direct** method"
  (operating / financing / investing) on counterpart accounts.
- Aged receivable/payable (13.0, the last public code): the residual as of a
  date is rebuilt from partial reconciliations dated on or before it. Buckets
  use `COALESCE(date_maturity, date)` plus a "not due" bucket.
- Budgets:
  - 11.0: states draft / confirm / validate / done / cancel. Practical =
    analytic lines (posted only). Theoretical = linear proration.
  - 18.0 (docs): Draft → Open → Revise creates a new budget; the original
    becomes "Revised". No native approval group.

---

## 2. What exists — the Phase 14 baseline (inventory 2026-10-01)

The reports live in `routes/reports/*`, `controllers/reports.controller.ts`,
`services/reports.service.ts` and `repositories/reports.repository.ts`.

| Area | As found | Gap / defect |
|---|---|---|
| Trial balance | GL movement in a range; one row per account | No opening/closing columns. Loads every line into JS and sums floats |
| General ledger | Per account; opening only when an account is given; rows carry `jeId` | The page does not read URL parameters, so a drill-down loses its scope |
| P&L | GL by category type; a TRANSACTIONS fallback when the window has no GL lines | A second truth, gross of VAT (known issue). `grossProfit = totalRevenue`, which is not gross profit |
| Balance sheet | As-of; current / non-current / unclassified buckets in the API | Equity is one computed "Retained earnings" line since inception, next to the migrated `RETAINED_EARNINGS` account (same label twice). Buckets not rendered. `< 0.05` literal tolerance |
| Cash flow | Direct, but from the **bank-feed `transactions` table** | Misses document payments (comment `analytics.repository.ts:287`). Not ledger-derived. Does not reconcile to GL cash |
| AR / AP ageing | Documents as of **today** only | No as-of date |
| Comparison | Client-side prior window on P&L, BS and CF | No server comparison; nothing in exports |
| Drill-down | `/journal-entries?entry=` exists | No statement → GL → entry path |
| Exports | **None** (seven dead buttons removed 2026-09-01) | Arabic books are required (Commercial Books Law Art. 1) |
| Dimensions | Party only (customer/vendor on `journal_entry_lines`) | Cost centres absent by design; `branches` and `departments` have no consumer |
| VAT return | Invoices and bills, claim-date input VAT | Boxes ≠ ZATCA's (P13-N1, held). `badDebtReliefsInRange` lacks the company and status predicates (RLS covers the company) |
| Finance Hub | `tax-compliance` quarter uses `new Date()` (UTC) | Breaks the business-date seam near midnight |

---

## 3. Phase 14 decisions

### D14-01 — One ledger aggregation seam, in SQL, exact

**Decision.** Every GL-derived figure in TB, P&L, BS, GL opening, account
summary, cash flow and budget actuals is computed by **one** repository seam,
`ledgerBalances`.

- It is a SQL `GROUP BY` over `journal_entry_lines ⋈ journal_entries`, with:
  - `status ∈ JE_IN_BOOKS` (posted + reversed — the reversal mirror is in the
    books);
  - `companyScoped(journal_entries.company_id)` (N1; RLS as the second layer);
  - the accounting date = `journal_entries.date`.
- Sums are PostgreSQL `numeric`, returned as strings.
- Totals are summed as **integer halalas** (`lib/money.ts`). No JS float ever
  sums money.

**Why.** Brief §21 (no loading the GL into memory) and §22 (no float money).
The report files already state "one definition" (§3 two-definitions rule).

**Basis.** PRODUCT. Both precedents aggregate in SQL.

**Test.**
- Equivalence: the 31 pre-existing report suites (TB, P&L, BS, GL, ageing,
  statements, conformance) pass unchanged on the seam, apart from the
  deliberate changes recorded in D14-04, D14-06 and D14-07.
- Exactness: `phase14-cash-flow-classification.test.ts` — ten "0.10" sum to
  exactly 1 in halalas where the float sum drifts; malformed or 3-decimal
  amounts are refused, never rounded.
- Company isolation with presence, absence and movement (L).

### D14-02 — Report date semantics (one table, enforced)

| Report | Parameter(s) | Semantics |
|---|---|---|
| Balance sheet | `as_of` | lines with `date ≤ as_of` |
| Trial balance | `date_from`, `date_to` | opening = `date < date_from`; period = `date_from ≤ date ≤ date_to`; closing = `date ≤ date_to` |
| P&L | `date_from`, `date_to` | inclusive range |
| Cash flow | `date_from`, `date_to` | inclusive range; opening cash = `date < date_from` |
| GL / account statement | `date_from`, `date_to` | opening + rows + closing |
| AR / AP ageing | `as_of` (new) | documents dated `≤ as_of`; settlements effective `≤ as_of` (D14-08) |
| Budget vs actual | fiscal year + period | actual = in-books GL lines in the period (D15) |

- The date is always the **accounting date** (`journal_entries.date`), never
  `posted_at` or `created_at`.
- When an as-of date is omitted it defaults to `businessToday()` (Asia/Riyadh,
  the one seam) and is **echoed** in the response, so the reader sees which
  date was used.
- Dates must match `YYYY-MM-DD`. A malformed date is a 400, never silently
  "all time".
- A future-dated entry is in a range only if the range includes its date.

**Test:** boundary tests (the day before, the day of and the day after a
boundary, for every report), plus malformed-date refusals.

### D14-03 — Migration opening journals are opening balances, not movement

Entries with `source ∈ {opening, opening_reversal}` (Batch 1C — the cut-over
position, dated cut-over − 1, and its whole-batch reversal):

- **are** in every as-of balance (BS, TB closing, GL running balance);
- **are** in a P&L range that contains them. They carry the previous system's
  YTD income and expense, which belongs to the fiscal year (Batch 1C R5);
- their **balance-sheet lines** are shown in the **TB opening** column even when
  dated inside the range (ERPNext's `is_opening` treatment, PRECEDENT);
- 🔴 **refined 2026-10-01 (accounting review M1):** their **income and expense
  lines** are period MOVEMENT in every report — the P&L, the TB's debit/credit
  columns, the GL, the statement of changes in equity — because they are the
  previous system's year-to-date P&L, which belongs to the fiscal year (Batch 1C
  R5). The first version put them in the TB opening while the P&L counted them,
  so the TB, the equity statement and the P&L disagreed for the same dates.
  ERPNext forbids P&L accounts in an opening entry, so its precedent never
  covered these lines. One balanced entry split across two TB columns leaves
  each column off by the migrated result X; a computed row, "year-to-date result
  brought in by migration (opening → period)", carries X in the opening column
  and −X in the period, and closes at zero — Σ opening = Σ closing = 0 and
  debits = credits hold;
- in the **P&L trend and budget vs actual** the migrated year-to-date is ONE
  amount on its date, never placed in the month it was booked (it would read as
  that month's) and never spread across the months it covers — the "do not
  apportion" rule applied to actuals (accounting review M2). It is in the
  totals, so they still equal the income statement;
- are **never** a cash flow. They appear as a separate reconciling line,
  "opening balances brought in by migration", between opening and closing
  cash.

`opening_correction` is a dated event of the correction day and is treated as
ordinary movement.

**Basis.** PRODUCT plus `journal_entries.source`'s own contract: "readers that
must exclude the opening from period MOVEMENT key on this, never on the date".

### D14-04 — Trial balance: opening / period / closing; P&L reset at fiscal-year start

**Columns.** Opening (debit-positive), period debit, period credit, closing.
The existing `debit`, `credit` and `balance` fields keep their meaning (period
movement); opening and closing are new.

🔴 **One deliberate change in meaning (D14-03).** A migration opening entry
dated inside the window is now in `openingBalance`, not in `debit`/`credit`/
`balance`. Before Phase 14 it was period movement. On a TB with no
`date_from` (all history), `balance` therefore excludes the cut-over position
and `closingBalance` is the account's balance. Consumers checked: the TB page
(reads closing), the export (same service), and one e2e helper
(`phase13-evidence-expenses.spec.ts` `gl()`, which sums `balance` on an org
with no migration — unaffected).

**P&L reset.** When `date_from` is given and the company has declared its
fiscal year:

- income and expense accounts' opening = their balance from the start of the
  fiscal year containing `date_from`;
- all earlier P&L is shown as one computed equity row, "Profit / loss of prior
  fiscal years — not yet allocated" (debit-positive like every row).

This keeps Σ opening = 0 and Σ closing = 0.

If the fiscal year is **not declared**, there is no reset, and the response
says why (`fiscalYearDeclared: false`).

**Basis.**
- PRECEDENT: ERPNext `trial_balance.py` P&L opening from year start; Odoo
  `include_initial_balance` False for income/expense.
- AUTHORITY: IAS 1.106 — no closing journal is required, so the reset is a
  presentation of the same ledger.

**Invariants (A):**
- Σ period debit = Σ period credit;
- Σ opening = 0;
- Σ closing = 0;
- for every account, closing = opening + debit − credit.

### D14-05 — Balance sheet equity: profit to date split by fiscal year

Equity shows:

- the equity accounts (including the migrated `RETAINED_EARNINGS` account);
- **"Profit / loss — prior fiscal years (not allocated)"** = Σ income − expense
  dated before the start of the fiscal year containing `as_of`;
- **"Profit / loss — current fiscal year to date"** = Σ income − expense from
  that fiscal-year start to `as_of`.

If the fiscal year is undeclared, there is one line, "Profit / loss to date
(not allocated)", with the reason. The field `retainedEarnings` stays
(the sum of both lines) for compatibility.

The computed lines **never** use the label "Retained earnings", which belongs
to the account. This fixes the duplicate-label defect seen on the CI page
snapshot of 2026-10-01.

- The balance check uses exact halala sums and `GL_BALANCE_TOLERANCE` — not the
  `0.05` literal.
- The page renders the current / non-current / unclassified sections the API
  already computes. "Unclassified" is shown, never folded (M18.2).

**Basis.**
- AUTHORITY: IAS 1.106(d), 1.108; IFRS for SMEs 6.5; IAS 1.60 (classified
  presentation).
- PRECEDENT: Odoo current-year earnings in real time; ERPNext provisional
  P&L.
- We do **not** use ERPNext's plug: the line is computed from income and
  expense, and the balance is then checked (B).

**Invariants:**
- (B) assets = liabilities + equity, exactly;
- (D) the current-FY line = `incomeStatement(fyStart, as_of).netIncome`;
  prior + current = all P&L to date.

### D14-06 — P&L: ledger only; expenses by nature; no fake gross profit

- The **transactions fallback is removed.** A window with no GL lines reports
  zero, from the ledger.
  - It was a second truth, gross of VAT (known issue).
  - Since A (2026-08-17) every accepted transaction posts to the GL.
  - `source` stays in the response and always reads `journal_entries`.
- **`grossProfit` becomes `null`**, with `expenseAnalysis: "nature"`.
  - There is no cost-of-sales account (no inventory).
  - Expenses are presented by nature, and IAS 1.99–103 then requires no gross
    profit line.
  - The old value was simply revenue. Nothing in the web read it.
- **Zakat:** no zakat expense is posted anywhere (M17.3/M17.4 held on C10), so
  there is no zakat line to present. It is recorded as a known limitation, not
  invented.

**Basis.** AUTHORITY IAS 1.99–105; SOCPA-ED 82(d). PRODUCT for the fallback
removal (principle: reports derive from the ledger).

**Invariant (C):** P&L totals = Σ in-books income/expense lines in the range
(the TB P&L rows for the same window).

### D14-07 — Cash flow: direct method, rebuilt on the GL

**Scope.**
- Cash = posting accounts with `liquidity_class = 'cash'` (the per-bank D-3
  leaves; `CASH` itself is a non-posting header). Cash equivalents: none are
  modelled.
- The report reads every in-books entry in the range that touches a cash
  account, excluding opening-source entries (D14-03).

**Rule.** In each such entry, every **non-cash line** contributes `−(its
debit − credit)` to the activity of its account. Because an entry balances,
Σ contributions = the entry's net cash movement exactly. No pro-rata
estimation is involved.

**Classification** (deterministic: account type, liquidity class and system
code — no AI, no name matching):

| Account | Activity | Direct-method line |
|---|---|---|
| Another cash account | **Not a cash flow** (IAS 7.9) — the cash lines are excluded, so a cash-to-cash entry contributes nothing | — |
| `TRANSFER_CLEARING` | **Internal**, never an activity (IAS 7.9) | "Transfers between own accounts still in transit" — non-zero only when the two legs straddle a window edge; activities + internal = the change in cash |
| `TRANSFER_SUSPENSE` (an UNDECLARED transfer) | **Internal**, held apart | "Transfers awaiting declaration" — until declared it may be cash-to-cash (no flow) or money to the owner (financing); never guessed operating (the Audit Tier 3 finding-8 rule, held by `credit-settlement-compose.test.ts`) |
| AR, `CUSTOMER_DEPOSITS`, `CUSTOMER_CREDITS`, `UNIDENTIFIED_RECEIPTS`, income accounts | Operating | Receipts from customers |
| AP, `SUPPLIER_ADVANCES`, `PREPAID_EXPENSES`, `ACCRUED_LIABILITIES`, `UNIDENTIFIED_PAYMENTS`, expense accounts | Operating | Payments to suppliers |
| `SUSPENSE` | Operating | "Unidentified" — an accepted bank line not yet categorised, NAMED rather than folded into another line |
| `SECURITY_DEPOSITS_PAID`, `SECURITY_DEPOSITS_HELD` | Operating | Other operating — a refundable deposit is neither a sale nor a purchase |
| `SALARIES_PAYABLE`, `GOSI_PAYABLE`, `SALARIES`, `GOSI_EXPENSE` | Operating | Payments to employees |
| `VAT_OUTPUT`, `VAT_INPUT`, `VAT_AWAITING_EVIDENCE`, `VAT_ADJ_*`, `WHT_PAYABLE` | Operating | Taxes paid / refunded (VAT, WHT) — IAS 7.35, SOCPA |
| Non-current asset accounts (fixed assets, `ACCUMULATED_DEPRECIATION`), `ASSET_DISPOSAL_GAIN_LOSS` | Investing | Purchase / disposal of non-current assets (IAS 7.16) |
| Non-current liability accounts; equity accounts (`EXTERNAL_TRANSFERS`, capital, `RETAINED_EARNINGS`) | Financing | Borrowings / owner contributions and withdrawals (IAS 7.17) |
| Other current assets or liabilities, and unclassified accounts | Operating | Other operating — listed so the classification is visible |

The disposal-gain row is investing so that disposal proceeds land wholly in
investing. Line contributions then sum to the cash received: cost credit −
accumulated-depreciation debit + gain credit = proceeds.

**Reconciliation (H).** Opening cash + operating + investing + financing +
internal (in transit, awaiting declaration) + opening balances brought in by
migration = closing cash. Every figure comes
from the GL, so the statement **must** reconcile, and the response carries
`reconciles: true|false`.

**Disclosed policies:**
- **VAT:** receipts and payments are shown **inclusive of VAT** (gross). VAT
  settled with ZATCA is its own line (IFRIC 2005: disclose the basis).
- **Interest paid:** classified by the account it hits — an expense account is
  operating. This is the IAS 7.33 choice in the IAS 1 era; revisit under
  IFRS 18 (financing).

**Known limitations (OPEN):**
- **L-CF1.** A supplier payment against a bill that **capitalised a fixed
  asset** settles AP, so it classifies as operating. IAS 7.16 would put it in
  investing. Classifying correctly needs a trace from the payment through the
  bill to its asset lines. Not built in this phase. 🔴 **Disclosed by NAME,
  not by amount**: the response's `limitations` lists `L-CF1` and the page
  prints it; the AP-settling cash for capitalising bills is **not computed**
  (an earlier draft of this pack said it would be — corrected 2026-10-01).
  Computing it honestly needs the per-bill capitalised share, which is the
  same trace. OPEN.
- **L-CF2.** A short-term loan created by a tenant as a *current* liability
  classifies as operating, not financing. A per-account classification
  override is the remedy — an owner decision, since it changes
  `categories`.

**Classification is pinned both ways.** `phase14-cash-flow-classification.test.ts`
holds a DECIDED line for every system code and asserts both directions: every
code in `SYSTEM_ACCOUNTS` has a decision, and every decision names a code that
exists. A new system account fails that file until someone decides its line.

**Basis.**
- AUTHORITY: IAS 7.6–9, 13–19, 31–36, 43–44; SOCPA-ED 7.35; IFRIC 2005.
- PRECEDENT: Odoo `account_tag_operating/investing/financing` "direct
  method" tags on counterpart accounts; ERPNext's indirect report does not
  reconcile — avoided.

The indirect method stays a roadmap item (owner, 2026-08-31).

### D14-08 — AR / AP ageing as of a date

- `as_of` is accepted (default today, echoed).
- A document is included if it is dated on or before `as_of`.
- Its outstanding as of the date = total − Σ settlements **effective on or
  before `as_of`**:
  - a settlement with a journal entry is effective on that **entry's
    accounting date**;
  - a legacy `invoice_payments` row is effective on its `paid_at`;
  - a supplier credit-note application (which posts nothing) is effective on
    the business date of its record;
  - a reversal of an allocation is effective on its own entry's date.
- Buckets age from the due date (falling back to the document date) **at
  `as_of`**.

**Basis.** PRECEDENT: Odoo 13 aged partner balance (residual rebuilt from
reconciliations dated ≤ as-of; `COALESCE(date_maturity, date)`); ERPNext
`report_date` (payments after the date excluded).

**Invariants (F/G):**
- at `as_of = today` the figures equal the existing ageing exactly;
- at any `as_of`, Σ outstanding of in-books documents reconciles to the GL
  AR/AP control balance at `as_of`, with the credits and advances shown
  beside the buckets (as the current reports do);
- a deliberate effective-date mutation must break it.

### D14-09 — Drill-down

- Trial balance, P&L and balance-sheet rows link to the general ledger for
  **that account and that window**. For the balance sheet the window is
  inception → `as_of`; for P&L and TB it is the report window.
- GL rows link to the journal entry (`/journal-entries?entry=<id>`, the
  existing deep link the migration workspace already uses).
- The GL page **reads** `account_id`, `date_from` and `date_to` from the URL.

**Basis.** PRECEDENT: ERPNext `open_general_ledger`. CLAUDE.md §3: "a
navigation can lose the scope … only FOLLOWING the link catches it". The
e2e test follows the link and reads the figure.

### D14-10 — Exports: CSV and PDF from the same service output

- `GET /reports/export/:report?format=csv|pdf&lang=en|ar&<the report's own
  params>` (one route, `:report` ∈ trial-balance, income-statement,
  balance-sheet, cash-flow, general-ledger, ar-aging, ap-aging; anything else
  is a 400 that lists the exportable reports).
- Size: a CSV over 50,000 rows or a PDF over 3,000 rows is refused with 422
  `export_too_large` — never cut short.
- It runs the **same service function** with the same parameters, under the
  same `reports` permission and the same tenant/company transaction. An
  export therefore cannot show other data than the screen.
- **CSV:** UTF-8 with a BOM (Excel shows Arabic correctly). Arabic account
  names when `lang=ar`. Amounts with 2 decimals; a header block (company,
  report, window, generated-at).
- **PDF:** HTML rendered by the existing invoice Chromium renderer, extracted
  into one shared `htmlToPdf` (no second browser). `dir="rtl"` and Arabic
  labels for `lang=ar`; "Amounts in SAR, rounded to halalas" (IAS 1.51(e)).
  An optional comparative column matches the on-screen comparison
  (IAS 1.38).
- **XLSX: not built.** The API has no XLSX dependency, and CSV opens in Excel.
  Adding one is a dependency decision (OPEN, low).

**Basis.** AUTHORITY: Commercial Books Law Art. 1 (Arabic books), IAS 1.38,
1.51(e). PRODUCT for formats.

### D14-11 — Dimensions: the party dimension only (no invention)

- The GL report accepts a party filter: `party_type` with `customer_id` /
  `vendor_id` (the N3 line-level dimension that exists).
- Cost centres, projects, branches and departments are **not invented**
  (brief §16).
  - The cost-centre design (`design-chart-of-accounts-structure.md` §7) puts
    it on the journal-entry header, and nothing is built.
  - `branches` and `departments` have no consumer.
  - Dimension budgeting and reporting therefore wait for that feature (OPEN).

**Invariant (K):** for AR and AP, Σ lines by party = the account total
(N3 lines carry a party; lines without one are listed).

### D14-12 — Analytics: a monthly P&L trend from the seam

- `GET /analytics/pnl-trend?from=YYYY-MM&to=YYYY-MM` returns revenue, expenses
  and net per month (in-books, company-scoped) and reconciles to the P&L for
  the same window.
- Rendered as separate charts — no dual axes.
- Existing analytics (ratios trend, receivables bridge, cash, decomposition)
  stay. Budget vs actual joins the analytics in Phase 15.

### D14-13 — VAT reporting (only where already supported)

- `badDebtReliefsInRange` gets the company predicate, as every other query in
  the file has (defence in depth; RLS already holds the company).
- **Invariant (J):** VAT held for evidence, Art. 50-blocked VAT and reversed
  VAT never reach box 13; input VAT on the return equals the claimed
  documents.
- The box structure is **not** redesigned. It is not ZATCA's 16 boxes
  (P13-N1); 13D waits on that decision.

### D14-14 — Business-date seam in the Finance Hub

`tax-compliance` quarter boundaries come from `businessToday()`, not
`new Date()` (UTC). One-line fix with a boundary test at 23:30 UTC.

### D14-15 — Performance

**Measured, not assumed — and re-measured when the first measurement was
wrong.** The local database holds 397 journal lines, so any plan there is a
sequential scan (§3 "small fixtures test differently"). The seam is measured on
**synthetic volume inside one transaction that is rolled back** (397 lines
before and after): a target company with 60k lines and a neighbouring tenant
with 240k, **run as the tenant role `authenticated` with RLS on and both GUCs
set**, reading each scan's Index Cond off the plan.

🔴 **Correction (database review, 2026-10-01).** The first version of this
section claimed an expression index `((company_id::text), date)` took a
one-month P&L from 104 ms to 12 ms. The plan said otherwise: the Index Cond was
on the DATE alone — 4,218 rows, both tenants' entries for the month — because
under RLS a predicate whose functions touch the row and are not leakproof
(`uuid_out` behind `::text`) cannot be an index condition. The speed-up came
from the date column; the company part of the index did nothing. Reading the
timing instead of the plan is the §3 unvalidated-probe failure, aimed at our own
instrument.

**The fix.** `companyScoped()` compares the column AS A UUID —
`company_id = nullif(current_setting('app.current_company_id', true), '')::uuid`
— the same semantics (an empty or unset GUC matches nothing), with the leakproof
`uuid = uuid` applied to the column and a value computed once. Migration 0111
creates a plain `(company_id, date)` index (and `journal_entry_lines
(journal_entry_id)` for the join probe).

| Query (as `authenticated`) | Old `::text` predicate | Typed predicate + 0111 |
|---|---|---|
| P&L, one month | Index Cond on date only: 4,218 entries (both tenants), filtered after; 7.4 ms | **Index Cond: company_id AND date** — 790 entries, this tenant only; 3.9 ms |
| TB / BS, all history | Parallel seq scan of every tenant's entries; 136 ms | Index Cond: company_id AND date — 30,000 entries (this tenant's); 122 ms (it reads all of them, correctly) |

**Guarded, not just measured.** `phase14-reporting-invariants` EXPLAINs the real
seam query as the tenant role and asserts `Index Cond: ((company_id = …` on
`journal_entries_company_date_idx`; reverting `companyScoped` to the text form
FAILS it (mutation R14 — the only mutation no correctness test could see).

**OPEN (platform-wide):** every RLS policy, and fifteen hand-written predicates
outside this branch's files (bank reconciliation, bills, payments, captured
documents, analytics' own queries…), still compare `company_id::text`. Same
answer, no index. Recorded as F-18.

---

## 4. Invariant matrix (Phase 14)

| Id | Invariant | Where |
|---|---|---|
| A | TB: Σ debit = Σ credit; Σ opening = Σ closing = 0; per-account roll | `reporting-invariants.test.ts` |
| B | BS: assets = liabilities + equity (exact) | same |
| C | P&L totals = Σ in-books P&L lines in range | same |
| D | BS current-FY profit = P&L(fyStart, as_of).netIncome | same |
| E | GL: rows + opening = account closing; Σ = journal lines | same |
| F | AR ageing(as_of) ⇄ GL AR(as_of) | same |
| G | AP ageing(as_of) ⇄ GL AP(as_of) | same |
| H | Cash flow: opening + activities + migration = closing cash | same |
| I | Fixed assets: register carrying value = GL cost − accumulated depreciation | same (reuses FA services) |
| J | VAT: held / blocked / reversed never in box 13 | same |
| K | Party dimension: Σ by party = account total (AR/AP) | same |
| L | Company isolation: presence, absence and movement for every report and export; with NO company scope every statement is EMPTY (the query layer refuses, RLS alone would read org-wide) | `phase14-reporting-invariants.test.ts`, `phase14-reporting-http.test.ts` (session-bound tenant, over HTTP) |

"Same" above = `apps/api/src/tests/phase14-reporting-invariants.test.ts`
(fixture: companies A, B, D, E in one org, company C in another; every row
written by the product's own posting services — `invoicesService`,
`billsService`, `journalEntriesService`, `postJournalEntry({source:"opening"})`).
I is held by `fixed-assets-report.test.ts` (the register ⇄ GL control passes on
product-written books and FAILS when the cost account is posted from outside the
register); J by `phase13-vat-evidence.test.ts` (box 13).

**Mutation proofs (2026-10-01) — 13 mutations, all KILLED.** Each was applied
to a copy-aside file, the suite run, the file restored and checked
byte-for-byte (sha256):

| # | Mutation | Killed by |
|---|---|---|
| M1 | seam `date ≤ to` → `date < to` | D-boundary, F, G |
| M2 | company predicate removed from `inBooks()` | L (query layer) — 🔴 the A/B isolation test alone does NOT catch it: RLS's company arm still isolates when the GUC is set; only the org-wide-empty test sees the predicate |
| M3 | opening-source entries not treated as opening in the TB | D14-03 |
| M4 | opening-source entries counted as cash flows | D14-03 |
| M5 | expense accounts classified as revenue | C, L, P&L trend |
| M6 | BS prior-years profit dropped | B + D, F-11 |
| M7 | BS liability classified as a (negative) asset | B (after the totals were pinned — see below), G |
| M8 | cash flow: non-current asset as operating | H |
| M9 | TB: no P&L reset at the fiscal-year start | A |
| M10 | AR as-of: `≤ as_of` → `< as_of` | F |
| M11 | AP as-of: `≤ as_of` → `< as_of` | G |
| M12 | owner-equity opening omits prior P&L (F-11) | F-11 |
| M13 | transfers in transit classified as financing | H-internal |

🔴 **Two weak spots on the first run, both fixed in the tests, not the code:**
M13 survived because no fixture had a transfer straddling the window edge
(the in-transit line was always zero, so re-labelling it moved nothing) —
`H-internal` now posts one. M7 was caught only incidentally (by G): a
liability counted as a negative asset still "balances" (A − L = E), so test B
now pins the asset, liability and equity totals themselves.

---

## 5. Phase 15 — Budgeting & Planning

### 5.0 Baseline (inventory 2026-10-01) and the authority position

**What existed (M19).** One table, `budgets`: one row per account per calendar
year (`period` = `"YYYY"`), an amount, no lifecycle, no approval, no versions.
Actuals were read from `transactions` (accepted, operating) — not the GL (F-10).
The repository was company-blind (listed in `NO_COMPANY_FILTER`). The owner
decided on 2026-08-15 (design-analytics §7): **annual only, and do not
apportion** ("annual ÷ 12 is wrong for a business with a Ramadan peak"), with
"a real user asking for monthly budgets" as the revisit trigger.

**Authority.** None governs a private company's budget: no Saudi statute or
ZATCA rule, no SOCPA/IFRS standard (IPSAS 24 is public-sector only), and the
CMA governance requirement binds Main Market boards only (§1.1). **Every Phase
15 decision is therefore PRODUCT, informed by PRECEDENT** (ERPNext v15
`budget.py` / `budget_variance_report.py`; Odoo 11 `crossovered.budget`, Odoo
18 `budget.analytic`; §1.2). No authoritative source conflicts — there is none
to conflict.

### D15-01 — The model: budget → versions → lines (normalised)

| Table | Holds | Key rules |
|---|---|---|
| `budgets` | One budget: company, name, scenario, and its **frozen fiscal year** (calendar, start month, label, start and end dates) | fiscal fields immutable; one budget per (company, fiscal-year start, scenario, name) |
| `budget_versions` | Its revisions: `version_no` 1, 2, …, status, who/when for each transition, the send-back note, the version it was revised from | one APPROVED and one OPEN (draft or submitted) per budget — partial unique indexes |
| `budget_lines` | Version × account × period: `period_no` 1–12, or NULL for an **annual-only** amount | an account is periodised OR annual in a version, never both; amount ≥ 0 in the account's natural direction |

The fiscal year is **frozen on the budget** because `companies.fiscal_year_start`
and `fiscal_calendar` are editable (M17.2): a budget keeps the periods it was
set against, and its period boundaries are recomputed deterministically from
the frozen fields (`fiscalMonths`, pure, beside `resolveFiscalYear`).

**Precedent.** ERPNext: one fiscal year per budget, amend = a new revision;
Odoo 18: "Revise" creates a new budget and marks the original revised.

### D15-02 — Which accounts: income and expense posting accounts only

ERPNext refuses a budget on a non-P&L account; we do the same, at the WRITE
BOUNDARY (an admit trigger), not in one path. A capital-expenditure budget on
balance-sheet accounts is **OPEN** (not in the brief; it needs its own actual
definition — additions, not balances).

### D15-03 — Periods: the 12 fiscal months; annual-only lines are kept; NOTHING is apportioned

- Periods are the twelve months of the frozen fiscal year — Gregorian months,
  or Umm al-Qura Hijri months for a Hijri company (the platform's one Hijri
  source, `hijriCalendar.ts`).
- A line may hold twelve period amounts **or** one annual amount.
- 🔴 **An annual-only amount is never divided.** Its period budgets and its
  year-to-date budget are `null` — not a twelfth — and the response says why
  (`mode: "annual"`). This is the owner's 2026-08-15 rule, kept verbatim; it
  also rejects ERPNext's monthly-distribution percentages and Odoo's linear
  "theoretical amount", both of which are apportioning.
- 🔴 **OWNER REVIEW — the 2026-08-15 decision is extended, not reversed.** It
  chose "annual only" because a periodised UI was speculative ("nobody has asked
  for it"). The owner's Phase 15 brief now asks for budget vs actual by period;
  periodised entry is therefore built **beside** annual entry, and the "do not
  apportion" rule binds both. If the owner wants annual-only kept as the only
  mode, removing the period editor is a UI change with no data migration.

### D15-04 — Lifecycle: the existing approval engine, locked at the database

```
draft ──submit──▶ submitted ──approve──▶ approved ──(a revision is approved)──▶ superseded
  ▲                   │  │
  └────send-back──────┘  └──reject──▶ (the version is deleted — no archive, the engine's rule)
```

- Transitions go through `approvalService` with a `budget_version` adapter —
  the same state machine and audit trail as journal entries, bills, invoices
  and payroll (one writer per effect).
- Approve may run from `draft` (the engine's self-approve rule, as for journal
  entries).
- **A revision** is a new `draft` version copying the approved version's lines.
  Approving it supersedes the previous approved version **in the same
  transaction**; the partial unique index makes two approved versions
  inexpressible.
- 🔴 **Locked at the database, not in the service:** a trigger refuses any line
  INSERT/UPDATE/DELETE unless its version is `draft`; another refuses every
  version UPDATE except the five transitions above, and any DELETE of an
  approved or superseded version (so a budget that was ever approved cannot be
  deleted, even by cascade).
- A rejected version 1 with no other version takes its budget header with it
  (a budget with no version is a shape with no content).

**Precedent.** ERPNext: submitted documents are immutable; amend = revision.
Odoo 18: Draft → Open → Revise. Neither ships an approval group.

### D15-05 — Segregation of duties: none (the existing model has none)

`approve` is held by admin and accountant, as for invoices, bills and journal
entries, and nothing in the platform forbids the submitter from approving.
The brief adds SoD "only if the existing model requires it" — it does not.

### D15-06 — Actuals: the GL, accrual, through the Phase 14 seam

- Actual = in-books (posted + reversed) GL lines on the account, company-scoped,
  dated inside the period — `reportsRepository.ledgerMovementsByPeriod`, the
  seam the P&L trend already uses. Signed in the account's natural direction
  (income: credit − debit; expense: debit − credit).
- This replaces the `transactions`-based actuals (F-10) and answers
  design-analytics §7's open question — "cash or accrual?" — with **accrual**,
  because the P&L and the P&L trend that share the screen are accrual.

### D15-07 — Variance: signed, judged by account type, never coloured

- `variance = actual − budget` (natural direction).
- `favourable`: income → variance ≥ 0; expense → variance ≤ 0. Words, not the
  status palette (§4: a variance is a judgment, not a state).
- `variancePct = variance ÷ budget × 100`; **`null` when the budget is zero**
  (the M19 service returned 0 — a number that would mean nothing).
- **Year to date runs through a COMPLETED period** (`through_period`, default
  the last fiscal month that ended before today). A whole month's budget is
  never set against half a month's actual.
- **Full year**: the year's budget against the actual of the year so far.

### D15-08 — Forecast: separate, deterministic, never stored

`forecast = actual for periods 1…k + approved budget for periods k+1…12`
(k = `through_period`). No AI, no run-rate (a run-rate is apportioning by
another name), never written to any table. An annual-only line has **no**
forecast (`null`, with the reason). Labelled on screen as an outturn
projection, not a budget.

### D15-09 — Unbudgeted actuals are listed

Income and expense accounts that moved but have no line are returned beside
the lines, so Σ actual (budgeted + unbudgeted) = the income statement for the
same dates — an invariant, not a hope.

### D15-10 — Dimensions: the company only

Cost centres, projects, branches and departments do not exist (D14-11); a
budget is per company. Not invented.

### D15-11 — The M19 table: kept as an archive, its rows copied, nothing deleted

- `budgets` is renamed `budgets_legacy` (rows untouched — the standing
  instruction not to modify local residue; and a migration has no business
  deleting a tenant's records). Write grants are revoked: it is an archive.
- Each legacy row WITH an income/expense account is copied into the new model:
  one budget per (company, year), named after the year, holding ONE **draft**
  version of annual-only lines. 🔴 Draft, not approved: the M19 rows were never
  approved, and a migration that marked them approved would assert an approval
  that never happened.
- A legacy row with no account (or a non-P&L account) cannot be expressed (a
  line needs an income or expense account); it stays in the archive and is
  counted in the migration's notice.
- Dropping the archive is an owner decision (OPEN).

### D15-12 — Permissions

`budgets` gains `approve` (admin + accountant) — the invoices/bills split:
a bookkeeper drafts and submits, an approver approves, sends back or rejects.
`delete` stays admin-only, and only for a budget never approved (D15-04).

### D15-13 — Audit

The engine records `submit`, `approve`, `send_back`, `reject` on
`budget_version`; creation, line replacement (before → after), revision and
deletion are recorded through `auditService` in the same transaction.

### D15-14 — Integration with Phase 14

- `GET /budgets/:id/vs-actual` reads the Phase 14 seam (D15-06).
- The Analytics "Against budget" card reads the approved **base** budget of the
  fiscal year containing the window's end, through the same endpoint.
- `budget-vs-actual` is exportable (CSV/PDF) through `/reports/export`, the
  same service output as the screen.

### D15-15 — An undeclared fiscal year is refused, not defaulted

Creating a budget for a company with no declared fiscal year is a 422
`fiscal_year_undeclared` naming Company Settings — M20's F8 rule ("NULL means
NOT DECLARED … never a January year that looks like an answer").

### D15-16 — Tenancy

All three tables carry `organization_id` + `company_id`, RLS `tenant_isolation`
with the company arm, explicit grants and REVOKE of TRUNCATE/REFERENCES/TRIGGER.
Admit triggers check that the budget, version and account a row names are in
the SAME organisation and company — closing the cross-tenant FK edge (§3
"FK checks run OUTSIDE RLS"), and answering a foreign id exactly as a
non-existent one (no existence oracle). The repository filters by company
(`companyScoped`), so it leaves `NO_COMPANY_FILTER`.

### 5.1 Invariant matrix (Phase 15)

| Id | Invariant |
|---|---|
| P1 | A budget never touches the books: every lifecycle step leaves the GL line count and the trial balance unchanged |
| P2 | An approved version is immutable at the DATABASE (line and version writes refused there, not only in the service) |
| P3 | At most one approved and one open version per budget; approving a revision supersedes the previous one atomically |
| P4 | Σ actual (budgeted + unbudgeted) = the income statement for FY start → the end of the through-period |
| P5 | Each period's actual = that period's movement in the ledger (the P&L trend months) |
| P6 | Variance signed and judged by type; `variancePct` null at a zero budget |
| P7 | No apportioning: an annual-only line has null period budgets, null YTD budget and null forecast |
| P8 | Forecast = actual through k + budget k+1…12 |
| P9 | Isolation: presence, absence, movement; an org-wide connection reads nothing |
| P10 | A line's account is an income/expense account of the same tenant; a foreign id is refused exactly like a missing one |
| P11 | A Hijri budget's periods are Umm al-Qura months, contiguous, covering the fiscal year exactly |

### 5.2 As built (2026-10-01) — where each rule lives, and what tests it

| Piece | Where |
|---|---|
| Tables, triggers, RLS, grants, the archive, the import | migration `0112_phase15_budgets.sql`; Drizzle `packages/db/src/schema/budgets.ts` |
| Periods (Gregorian / Umm al-Qura) | `fiscalMonths()` beside `resolveFiscalYear()` in `apps/api/src/lib/fiscalYear.ts` |
| Lifecycle, lines, revisions, budget vs actual | `apps/api/src/services/budgets.service.ts` (the `budget_version` approval adapter is in the same file) |
| Company-scoped reads | `apps/api/src/repositories/budgets.repository.ts` (left `NO_COMPANY_FILTER`) |
| Routes and the approver split | `routes/budgets.ts` behind `requirePermission("budgets")`; `budgets.approve` in `packages/db/src/permissions.ts` |
| Database refusals → HTTP | `middleware/errorHandler.ts`: a `budget_*` trigger → 409 (state) or 422 (account / mode / tenant), the constraint as the code |
| Export | `budget-vs-actual` in `reporting/reportExport.service.ts` |
| UI | `pages/Budgets.tsx`, `pages/BudgetDetail.tsx`, the Analytics "Against budget" card; words in `lib/budgetLabels.ts` |

**Tests.** `phase15-budgets.test.ts` (P1–P11 on product-written rows; the
database locks attacked directly with owner SQL; isolation; Hijri; the
import), `budget-actuals.test.ts` (the M19.0 sign rules re-pinned on the
ledger), `phase15-budgets-http.test.ts` (each role, the gate, the tenant,
refusals by name, the export, the error-handler translation),
`workflow-contract-conformance.test.ts` (every budget response on its
generated schema), `demo-seed.test.ts` (the demo's approved budget), and the
browser walk `e2e/phase15-budgets.spec.ts`.

**Mutation proofs (2026-10-01) — 13 mutations, all KILLED** (copy-aside,
restored and checked by sha256):

| # | Mutation | Killed by |
|---|---|---|
| B1 | income actual signed debit − credit | budget-actuals, P4…P8, YTD |
| B2 | an annual amount apportioned into YTD (k/12) | P4…P8 (P7) |
| B3 | the default YTD includes the open period | YTD default |
| B4 | variance % = 0 at a zero budget | P4…P8 (P6) |
| B5 | expense judgement inverted | budget-actuals, P4…P8 |
| B6 | the list's company predicate dropped | P9 (org-wide reads nothing) |
| B7 | approve without superseding first | P3, P2, P4…P8 |
| B8 | no account pre-check (the trigger alone) | P10 |
| B9 | forecast from all actuals, not through k | P4…P8 (P8) |
| B10 | unbudgeted actuals left out of the totals | P4…P8 (P4) |
| B11 | budget company = the org's FIRST company | D15-15 |
| B12 | report fiscal year = the org's FIRST company | Phase 14 F-19 |
| B13 | lines editable after submission | P1, P3, P2, P4…P8 |

**Test cleanup.** An approved version is immutable at the database, so a suite
that approves one deletes it with triggers off
(`session_replication_role = replica`, children first) — the pattern the 1C
suites already use for committed migrations.

---

## 6. Findings log (running)

| Id | Severity | Finding | Status |
|---|---|---|---|
| F-00 | INFO | "Phase 14" in the 13B documents means inventory; the owner's roadmap says reporting | owner to re-home the inventory deferral |
| F-01 | MEDIUM | Cash flow reads `transactions`, misses document payments | fixed by D14-07 |
| F-02 | MEDIUM | P&L transactions fallback (second truth, gross of VAT) | fixed by D14-06 |
| F-03 | LOW | `grossProfit = totalRevenue` | fixed by D14-06 |
| F-04 | LOW | Equity labels: two "Retained earnings" lines | fixed by D14-05 |
| F-05 | LOW | `badDebtReliefsInRange` without company / status predicate (RLS covers) | fixed by D14-13 |
| F-06 | LOW | Finance Hub quarter on UTC `new Date()` | fixed by D14-14 |
| F-07 | INFO | `statement-figures.spec.ts` l.37 `asOf` and l.47 `from`/`to` are ignored by the server | owner decision pending (PR #188 note) |
| F-08 | INFO | Intermittent e2e click timeouts (fixed-assets-navigation, phase12-banking) on runs started 2026-10-01 13:49 UTC; both green on rerun / next run | observe |
| F-09 | INFO | No linter configured (no ESLint/Biome/Prettier config, no `lint` script) | reported; not added in this phase |
| F-10 | MEDIUM | Budget actuals read `transactions`, not the GL; budgets repository company-blind (`NO_COMPANY_FILTER`) | Phase 15 |
| F-11 | MEDIUM | Statement of changes in equity: opening equity excluded the P&L of earlier periods, so it did not close on the balance sheet's equity | fixed (`ownerEquity`); test F-11 + mutation M12 |
| F-12 | LOW | Balance-sheet page printed AR and AP twice — the account row and a label-matched "extra" line | fixed: the row is marked by the server's `accountsReceivableKey`/`accountsPayableKey`; `statement-figures.spec.ts` now finds AR by that marker (`bs-ar`) |
| F-13 | LOW | The route-reachability inverse guard parsed `apiFetch(` only, so a new `apiDownload(` URL was invisible to it | fixed: the guard parses both, and asserts it SEES `/reports/export` (a known-present case) |
| F-14 | INFO | `report-contract-conformance`'s cash-flow case asserted the OLD transactions-based sections | fixture now posts a ledger receipt and an in-transit transfer; asserts one line per section + `reconciles` |
| F-15 | LOW | `analytics.repository` computes balance-sheet ratio inputs with its own query — a second definition of BS semantics beside the seam | held by `analytics-trend.test.ts` (ties the two); OPEN: move it onto the seam |
| F-16 | INFO | Report exports are not written to `audit_logs` | DECISION: consistent with the platform rule — `audit_logs` records MUTATIONS, and a tenant's read of its own data is not audited (`documentsService.download` likewise); cross-tenant (operator) reads ARE audited. Owner may ask for export logging |
| F-17 | INFO | TB `balance` no longer includes migration opening entries dated inside the window (D14-04) | documented; consumers checked |
| F-18 | MEDIUM | Every RLS policy and `companyScoped()` compare `company_id::text`, which no plain index can serve — every tenant query at scale seq-scans all tenants unless an expression index matches | Phase 14 adds the expression index for the ledger seam (0111); the platform-wide pattern is OPEN |
| F-19 | MEDIUM | `companiesRepository.findActive()` returns the org's FIRST company, not the company in scope — the Phase 14 fiscal-year reads (TB P&L reset, BS current year, export header) used it, so a second company with a different fiscal year would have been reported on the first one's year. Invisible today only because `resolveTenant` always scopes the first company | fixed for reports, export and budgets (`findCurrent()`), each pinned by a test that FAILS on the old call (mutations B11, B12). 🔴 OPEN: three pre-existing callers outside this brief — `assetReports`, `incomeTaxPool`, `vatCapitalAsset` |
| F-20 | MEDIUM | The GL / account statement opened from a TB row answered a DIFFERENT question: a P&L account's opening included prior fiscal years, and a migration opening entry inside the window was listed as a movement | fixed (D14-09): one aggregate `glOpening` with the TB's rules; the account statement delegates to the GL; pinned by mutations G1–G3 |
| F-21 | LOW | The web's `ExportableReport` was a hand-kept copy of the server's list | derived from the contract (`Parameters<typeof getExportReportUrl>[0]`) |
| F-22 | INFO | An approved budget cannot be deleted, so it blocks deleting its organisation — like every other append-only record (committed migrations, VAT events) | by design (D15-04); tenant erasure is an owner procedure (C8 / PDPL) |
| F-23 | LOW | The M19 Budgets page coloured variance with the status palette (§4: a variance is a judgment) | replaced: neutral ink and words (`judgementLabel`) |
| F-24 | LOW | The demo seed's second budget named a system code that does not exist (`RENT_UTILITIES`), so it was silently never created | the demo budget uses `PURCHASES`, and `demo-seed.test.ts` now asserts the budget exists |
| F-25 | MEDIUM | AR/AP ageing "today" (the subledger cache) includes documents dated AFTER today; a balance sheet as of today (D14-02) does not — so the two disagree whenever a future-dated invoice or bill exists. The UI balance sheet has always been as of a date, so the disagreement pre-dates Phase 14 at the page level | OPEN — the fix (the cache path filtered to `date ≤ as_of`) changes pre-existing ageing behaviour and many fixtures' dates; recommended for the owner's next ruling. Found on the FRESH database (see F-26) |
| F-26 | INFO | A residue FK failure in a suite's cleanup hook SKIPS its tests — `purchase-orders` hid a real Phase 14 regression (a no-date balance sheet on documents dated after today) behind "failed in cleanup", locally; only the fresh database ran it | fixed (the suite reads the balance sheet as of its own window end); the lesson: a residue-failing suite is NOT a passing suite with noise — its assertions never ran |
| F-27 | LOW | Report exports and the PDF renderer are unbounded before the row cap: the GL is loaded in full, then refused; no PDF concurrency cap; no export rate limit (security review 7) | OPEN — bounded by the 50k / 3k caps' refusal, not by memory; a limiter is a platform decision (C1's store exists) |
| F-28 | LOW | The all-accounts general ledger (no account or party filter) lists period movement only: the cut-over position's balance-sheet lines are each account's OPENING, visible in that account's ledger and in the journal report, not in the all-accounts list (accounting review L5) | DECISION, documented — an all-accounts "opening" would sum to zero |
| F-29 | INFO | A rejected highest revision frees its `version_no` for the next revision (database review 9) | accepted — versions are identified by id; the audit log keeps the rejected one |

### 6.1 The three reviews (2026-10-01) — every finding, and what happened to it

Independent read-only reviews ran on the full branch: **security**, **database**
(migrations 0111/0112) and **accounting** (the report and budget logic). None
found a CRITICAL or HIGH issue.

| Review finding | Severity | Disposition |
|---|---|---|
| CSV formula injection (security 1, accounting L4) | MEDIUM | FIXED — a text cell beginning `= + - @ TAB CR` gets a leading apostrophe; numbers the export wrote are untouched; test + mutation R9 |
| `budgets_import_legacy` revoked from PUBLIC only (security 2, database 5) | MEDIUM (latent: hosted defaults) | FIXED — revoked by name from authenticated/anon/service_role; `has_function_privilege` test. Measured locally first: no role could execute it |
| Line guard reads the version unlocked (security 3, database 4) | LOW/MEDIUM | FIXED — `FOR UPDATE` on the version row |
| Transitions pin only their own field (security 4, database 2) | MEDIUM | FIXED — every transition pins every column outside its own set; a deferred constraint trigger refuses a supersede left alone at COMMIT; tests |
| A negative legacy amount aborts the migration (security 5, database 3) | MEDIUM | FIXED — kept in the archive; test |
| Error mapping by prefix (security 6) | LOW | FIXED — exact allow-list; refusals logged; tests that a plain CHECK and a pkey fault stay 500 |
| Unbounded export work (security 7, accounting L7) | LOW | OPEN — F-27 |
| Out-of-range amount/id → 500 (security 8) | LOW | FIXED — 400 naming the bound; ids above int4 refused |
| P&L trend accepts month 13 (security 9, accounting L7) | INFO | FIXED — 400 |
| The company arm of 0111's index unusable under RLS (database 1) | MEDIUM | FIXED — typed predicate + `(company_id, date)`; re-measured; plan test (R14) |
| PG17 MAINTAIN not revoked (database 6) | LOW | FIXED for these tables (version-guarded REVOKE); platform-wide gap noted |
| Header: company ∈ organisation; id frozen; date format (database 8) | LOW | FIXED — `budgets_admit` trigger, frozen id, format CHECK; tests |
| Migration YTD P&L: equity statement ≠ P&L (accounting M1) | MEDIUM | FIXED — D14-03 refined; computed TB row; test + mutations R1, R2 |
| Migration YTD lumped into one month (accounting M2) | MEDIUM | FIXED — one amount on its date in the trend and budgets; tests + R3, R4 |
| Account summary had no fiscal-year reset (accounting M3) | MEDIUM | FIXED — it IS the trial balance's rows; test + R13 |
| "Exact" balance tolerated a halala (accounting M4) | MEDIUM | FIXED — integer halalas compared with zero; test + R6 |
| A fixed asset on an unclassified account was operating (accounting L1) | LOW | FIXED — the asset categories' accounts are investing; test + R5 |
| Variance % sign at a negative budget (accounting L2) | LOW | FIXED — divided by \|budget\|; test + R7 |
| Sub-halala numbers rounded silently (accounting L3) | LOW | FIXED — refused; test + R8 |
| All-accounts GL omits the cut-over (accounting L5) | LOW | DECISION — F-28 |
| Event replay's UTC date fallback (accounting L6) | LOW | FIXED — the Riyadh business date of `created_at` (all five columns verified `timestamptz`) |
| Test gaps: date_from boundary, AP party, cash-flow shapes, P4 at k = 12, P5 expense, forecast totals, Hijri | — | CLOSED — tests added; mutations R11, R12 |
| Reject by an approver deletes a never-approved budget although DELETE is admin-only (security 9) | INFO | DECISION — rejecting the only version of a never-approved budget is the approval engine's rule (reject = delete); no record is lost |
| `budget-vs-actual` export authorised under `reports` (security 9) | INFO | accepted — identical role sets today; noted |
| 0111 builds its indexes non-concurrently (security 9) | INFO | accepted — drizzle runs a migration in one transaction; before the first tenant the lock is moments |

**Mutation proofs of the fixes — 14, all KILLED** (R1–R14, same driver,
restored by sha256): R1 opening-entry P&L back to opening · R2 the TB without
the migrated-result row · R3 the trend keeping a migration in its month · R4
migrated YTD counted before its date · R5 the fixed-asset flag ignored · R6 a
halala's tolerance · R7 variance % by a signed budget · R8 sub-halala rounding ·
R9 CSV neutralisation removed · R10 error mapping by prefix · R11 `date_from`
exclusive · R12 the opening including the `from` day · R13 the summary without
the reset · R14 the text-cast company predicate (killed only once the plan test
existed).

---

## 7. Verification on a FRESH database, and the final joint audit (2026-10-01)

**Authoritative evidence only.** Every database-backed stage ran against
`saudi_ledger_p1415_fresh`, a database created for this purpose, migrated from
zero (all 113 migrations) and seeded the way CI seeds. Nothing here is taken
from the local development database, whose leftover rows make four suites fail
in cleanup (F-26). Stages ran one at a time, because a single `pnpm run verify`
was killed twice by the machine's memory limit — not a code failure.

| Stage | Result |
|---|---|
| 1. Typecheck (all workspaces) | exit 0 — 0 errors |
| 2. API suite | exit 0 — **208 files passed, 1 skipped; 2,031 tests passed, 18 skipped**. The skips are the object-storage tests (`documents` 13, `company-logo` 5): they need Supabase storage credentials, which CI provides. |
| 3. Database suite + migrations | exit 0 — **10 files, 58 tests**; `drizzle-kit generate`: "No schema changes" (schema ⇄ snapshots agree); 113 migrations; tables, triggers, ACLs and function privileges checked on the fresh database |
| 4. Browser suite | **497 / 497 passed on the final code** (490 + the 8-way split of one test), across three valid runs — see below |
| 5. Secrets | gitleaks (CI's exact container invocation), full history: **no leaks**; the security guard suites ran inside stages 2–3 |
| 6. Build | exit 0 |
| Web unit · ZATCA TLV | 11 files / 109 tests · 1 file / 10 tests — passed |
| Mutation proofs | **43 / 43 killed on the fresh database**; every mutated file restored and checked by sha256 |

**The browser runs, honestly.** (a) A first attempt was INVALID — Git Bash
rewrote `BASE_PATH=/` into its own install path, so every page failed to load
(an environment fault of my invocation; class C). (b) Re-run from PowerShell,
killed by the memory limit after 296 of 490 tests: **295 passed, 1 failed** —
`nav-tree` "every crawlable route is reachable": `/budgets/:id` was not
registered as a record page (class A, a Phase 15 omission; fixed in the spec's
own exemption list, with its reason, beside `/assets/:id` and
`/migration/:id`). (c) The 14 remaining files (249 tests, `nav-tree` re-run
whole): **248 passed, 1 failed** — the Phase 14 language/viewport sweep hit the
30 s per-test budget on its fifth page (class A, my test's design: eight pages
in one test; every assertion before the timeout had passed). Split into one test
per page, same assertions: **`phase14-reporting` 15 / 15**. No product
assertion failed in any valid run.

**Two failures the fresh database exposed** (both before stage 4): the local
`purchase-orders` suite had been SKIPPING its tests behind a residue cleanup
failure; on the fresh database it ran and caught a real Phase 14 regression in
the test's reading of a no-date balance sheet (F-26 — fixed by naming the
fixture's window end). And three of the four "residue" suites pass on a clean
database — proof that they were residue.

### 7.1 The final joint audit — each defect found and fixed, re-verified

| # | Area | Evidence (all on the fresh database) | Verdict |
|---|---|---|---|
| 1 | 0111 company filter ⇄ index | the plan test (EXPLAIN as the tenant role: `Index Cond: ((company_id = …` on `journal_entries_company_date_idx`); the rolled-back volume measurement as `authenticated` (790 entries, this tenant, vs 4,218 both tenants before); R14 killed | VERIFIED |
| 2 | Migrated YTD: P&L = TB = equity statement = BS current year = trend total = budget actuals | invariants test "review M1/M2" (350 in every report; the computed TB row closes at 0; June shows nothing of the half-year; `migrated` stands apart); budgets "review M2" (YTD 0 → 900 → 1,050 at k = 3, 6, 8, each = the income statement); R1–R4 killed | VERIFIED |
| 3 | Account summary's fiscal-year reset | "review M3" (Sales opens at 0 in both; row sets equal); R13 killed | VERIFIED |
| 4 | Exact zero difference | "review M4" (a ledger one halala off reads unbalanced — TB and BS); the cash flow's `reconciles` is `===`; R6 killed | VERIFIED |
| 5 | Fixed-asset cash-flow classification | "review L1" (an unclassified vehicle account bound to an asset category → investing −8,000; reconciles) + the unit test; R5 killed | VERIFIED |
| 6 | CSV formula injection | HTTP test (`'=SUM(1+1)*cmd`, `'+cmd\|calc`; a negative number left plain); R9 killed | VERIFIED |
| 7 | Immutable approval history | DB tests: rewriting `approved_by` during a legal supersede → `budget_version_transition`; a supersede left alone → refused at COMMIT (`budget_version_superseded_alone`); P2 (lines, status, deletion, cascade, header, TRUNCATE) | VERIFIED |
| 8 | Legacy import owner-only | `has_function_privilege` false for authenticated / anon / service_role — test, and read directly on the fresh database | VERIFIED |
| 9 | Negative legacy amount | test: a −50 row is not imported and nothing appears; the migration cannot abort on it | VERIFIED |
| 10 | Cross-company / cross-tenant isolation | invariant L + "L (query layer)" (an org-wide connection reads nothing), P9, the HTTP session-tenant tests (presence, absence, movement), `cross-company-isolation` (budgets left `NO_COMPANY_FILTER`), the DB RLS suite, the admit triggers (foreign = missing); M2, B6 killed | VERIFIED |
| 11 | Date / as-of semantics | D-boundary (`to` inclusive), "review — date_from" (inclusive; the opening ends the day before), as-of ageing (F, G), a no-date balance sheet is as of today (F-26), YTD through a COMPLETED period; M1, M10, M11, R11, R12, B3 killed | VERIFIED |
| 12 | Budget vs actual reconciliation | P4 at k = 3 and 12 and through a migration; P5 income AND expense, all twelve periods; the browser walk reads the same equality off the page; B1, B9, B10 killed | VERIFIED |
| 13 | Budget lifecycle and database locking | P1 (the books never move), P2, P3, P10, the review DB tests, the role-by-role HTTP suite, the browser walk (create → fill → submit → approve → revise → send back → reject); B7, B13 killed | VERIFIED |
| 14 | Reporting reconciles to the GL | invariants A–H on product-written rows; the browser's drills read the destination's figures; `statement-figures` (BS AR = AR ageing, non-zero); every report response on its generated schema | VERIFIED |

**Blockers:** none CRITICAL or HIGH. The open items are §6's OPEN rows (F-18,
F-19 partial, F-25, F-27, F-28, L-CF1, L-CF2) and the owner-review decisions
(D15-03, F-00, F-16).
