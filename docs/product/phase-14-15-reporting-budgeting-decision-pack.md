# Phase 14 + Phase 15 — Financial Reporting & Analytics; Budgeting & Planning

**Status (2026-10-01): decision pack for implementation, written before code.**
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
- are shown in the **TB opening** column even when dated inside the range
  (ERPNext's `is_opening` treatment, PRECEDENT);
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

**Measured, not assumed.** The local database holds 397 journal lines — any
plan there is a sequential scan and proves nothing about scale (§3 "small
fixtures test differently"). The seam was therefore measured on **synthetic
volume inside one transaction that was rolled back** (nothing persisted; the
line count was 397 before and after): a target company with 60k lines and a
neighbouring tenant with 240k.

| Query | Existing indexes | With migration 0111 |
|---|---|---|
| P&L, one month (`movementOnly`) | Parallel seq scan of **every tenant's** lines; 125k buffers; 104 ms | Bitmap index scan, then a line probe; 3.3k buffers; 12 ms |
| TB / BS, all history to year end | Seq scan of all lines; 196 ms | Seq scan of entries (it reads ~all of the company's rows, correctly) + line probe; 174 ms |

**Why the obvious index would not have worked.** Every tenant predicate —
`companyScoped()` and the RLS company arm — compares `company_id::text =
current_setting(...)`. A plain index on the uuid column `(company_id, date)`
cannot serve a predicate on `company_id::text`. The index that works is the
EXPRESSION the predicate already uses: `((company_id::text), date)`. Plus
`journal_entry_lines (journal_entry_id)` for the join probe (the existing
`(organization_id, journal_entry_id)` cannot serve a probe on the entry id
alone).

**Migration 0111** adds exactly those two indexes (no row, grant or policy
change). Declared in the Drizzle schema so drizzle-kit cannot read them as
drift.

**OPEN (platform-wide, not Phase 14's to change):** the `::text` cast is in
every RLS policy. Each table's hot query needs either an expression index
like this one or a sargable predicate (`company_id = nullif(current_setting(…),
'')::uuid`). Recorded as F-18.

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

## 5. Phase 15

Written at Step 7, after Phase 14 is implemented (§6 of the brief's
execution order).

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
