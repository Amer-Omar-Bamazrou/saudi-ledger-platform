# ERPNext compared against this platform — where WE are wrong (2026-09-03)

**Status (2026-09-03):** a research record. Current state authority: CLAUDE.md
§2. Triage (owner, 2026-09-03): the four ranked changes entered §5 as **N1–N3
+ N4-closed**, ahead of L1; everything else here awaits triage.

**Method.** ERPNext cloned at `4944df8733` (develop, 2026-09-02): 61,080 commits,
~15 years, 192 accounting doctypes, 81 stock doctypes, 523 lines of `patches.txt`
reaching back to v10. Five parallel reads — the accounting model, inventory as
research for our own build, their public scars, their answers to six things we
have found hard, and the assumed-standard category. **Every finding below that
concerns OUR code was then re-verified by hand against our source**; the
`file:line` citations are from that verification pass, not relayed. Two reported
findings did not survive it and are the FIRST section below, because a
comparison that only reports confirmations is an unread instrument.

## 🔴 READ FIRST — the two findings that did NOT survive verification

Owner-directed, 2026-09-03: *"a comparison reporting only its confirmations is
an unread instrument."* These sit at the TOP rather than in an appendix, because
an appendix is where a retraction goes to be skipped. Both were reported by a
sub-read, both looked right, and both were **wrong about our code**:

1. **"The quotation → invoice conversion carries a header discount, making the
   unapprovable-invoice defect reachable through the product."** ❌ **It does
   not.** `quotationConversion.service.ts:174-191` allocates discounts per
   **LINE** via `allocateLineDiscount` and never passes a header discount to
   `invoicesService.create`. The defect is real but **API-only**. Had this gone
   unchecked, the fix would have been aimed at a conversion path that does not
   have the bug — §3's *a wrong reason is ACTIONABLE*, which is the dangerous
   half.
2. **"Our ZATCA QR tag 5 is fed from a document-total tax field — the same
   defect ERPNext fixed in `b37559c535` (2022-03-14)."** ❌ **We do not have the
   bug.** The field is *named* `taxTotal`, which is what prompted the check, but
   `einvoiceInput.assembler.ts:350` sources it from `money(invoice.vatAmount)`,
   a VAT-specific column. 🔴 The NAMING risk is real and is recorded in Part 1
   §14 as a latent item — `taxTotal` is the obvious field to widen the day a
   second tax line exists, and the QR is where it would land.

**What that rate means.** Two of the roughly twenty claims checked did not hold
— both in the direction of reporting a defect we do not have, neither in the
direction of missing one. That is the expected shape when a reader is being
adversarial on instruction, and it is the reason every claim in this document
carries a `file:line` someone else can re-run rather than a summary.

---

**The stack is not the question.** Python/Frappe/DocType versus
TypeScript/Drizzle is irrelevant. What transfers is where their MODEL can express
a case ours gets wrong or cannot say at all.

---

## Part 1 — Live defects, verified in our code

Ranked on the worst path a user can walk (§3's triage check), not on how bad each
looks alone.

### 1. The reports carry no company predicate — a 10× VAT return under `balanced: true`

`reports.repository.ts` and `analytics.repository.ts` contain **zero** references
to `companyId`/`company_id` across ~30 queries. `/reports/trial-balance` has no
`company` parameter in `openapi.yaml:1798-1811` that a caller could pass, and
`lib/tenant.ts:129-135` pins the request to the org's first-created company with
no switcher. 27 tables carry `company_id`; **no RLS policy reads
`app.current_company_id`** — the GUC is a column DEFAULT, not a read predicate.

Our own fixture states the damage: `tests/cross-company-isolation.test.ts:108-116`
seeds one org, two companies, one `sent` invoice each (A: 1,000/150/1,150 —
B: 9,000/1,350/10,350). Opening Company A's reports — the only ones anyone can
open — returns revenue 10,000, output VAT 1,500, AR 11,500, and
`balanced: true`.

🔴 **`balanced` is the finding.** `reports.service.ts:36` computes
`Math.abs(dr − cr) < 0.01` over the same rows, and two balanced books sum to a
balanced book. **The only self-check on the flagship report returns the identical
answer for the correct books and the corrupted ones** — §3's "when the correct
answer equals the broken one" rule, live, in the trial balance.

Triage: the VAT return **posts** (a statutory filing at 10× the base); the
correction is **removed** (period locks *are* company-scoped, so locking A's
December does not evict B's rows); the result is **hidden**. Three of three.

**What ERPNext does, in four layers, and the order is the lesson.** The filter is
*inherited*, not re-declared (`public/js/financial_statements.js:414-423`, which
Balance Sheet and P&L `$.extend`); Python re-validates
(`report/general_ledger/general_ledger.py:57-59`); **the SQL is scoped inside one
builder the caller never sees** — `report/financial_statements.py:702-722`,
`get_accounting_entries()` opens with `.where(gl_entry.company ==
filters.company)` before returning the query object, and Trial Balance, Balance
Sheet, P&L and Cash Flow all funnel through it; and the write boundary refuses
the row (`gl_entry.py:250-255`). `Account.autoname` puts the company
abbreviation in the account's primary key (`account.py:103-106`), so **two
companies cannot share an Account row** — a cross-company trial balance is not a
forgotten filter, it is a sentence the schema cannot express.

**Ours cannot express the separation at all**, because `categories.ts:13` keys
the chart of accounts on `organizationId` only — line 12 is the standing
admission, *"may gain company_id later"*. Only `journal_entries.company_id` can
separate the books, and nothing reads it.

**Take their position, not just their predicate:** put the company filter inside
`jeConditions()`/`lineJoin()` (`reports.repository.ts:39-45, 86-95`) so callers
inherit it — the per-repository form has already lost fifteen times — then make it
structural with an RLS `USING`, which is the change
`cross-company-isolation.test.ts:144-152` is written to detect.

CLAUDE.md §5 already records the symptom as an open DECISION. What this
comparison adds is the remedy and where it belongs.

### 2. The invoice list's "Outstanding" KPI counts credit notes as money owed

`invoices.repository.ts:104-106`:

```sql
COALESCE(SUM(CASE WHEN status <> 'paid'
                  THEN total - paid_amount ELSE 0 END), 0)::float8
```

`invoiceListConditions` (`:53-63`) adds a status condition **only if the caller
passes one**, and never filters `document_type`. On the default list view the
predicate is empty, so the figure sums:

- **credit notes** — an `invoices` row with `document_type = 'credit_note'`, a
  **positive** total (§4's house rule) and status `sent`. `documentSign()` is
  never applied, so a 1,000 credit note against a 1,000 invoice makes the KPI
  read **2,000 outstanding instead of 0**;
- **drafts and submitted** — status ≠ `'paid'`, so counted, violating the
  zero-movement standard;
- **rejected** — same.

🔴 The refutation is eighteen lines above it in the same file: the `OVERDUE`
predicate (`:47-50`) gets the status question right and says why — *"Not-yet-issued
documents cannot be overdue (the zero-movement standard)"*. Two predicates in one
file, one correct. And `reports.repository.ts:65-81` carries a red-flagged comment
titled **"READ THIS BEFORE WRITING A REPORT THAT SUMS INVOICE ROWS"** describing
exactly this trap; `listMeta` walked into it anyway.

Rendered at `Invoices.tsx:415` as `Outstanding / المستحق`.

### 3. Payroll cannot be approved for 10.3% of salary values, and fails as a 500

`payroll.service.ts:57-105` accumulates the run totals **unrounded**
(`totalGosiEmp += basic * 0.0975`) while each payslip stores
`gosiEmp.toFixed(2)`. `payroll.approvable.ts:26-41` then builds the GL from the
independently-rounded **headers**, so the residual is
`round(Σbasic) − round(Σnet) − round(ΣgosiEmp)` and need not be zero.

Measured directly (three identical Saudi employees, no allowances, basic swept
3,000–12,000 in 5-halala steps): **185 of 1,801 values exceed
`GL_BALANCE_TOLERANCE = 0.005`.** Worked example at basic 3,010:

```
Dr 9,030.00 + 1,061.02 = 10,091.02
Cr 8,149.58 +   880.43 + 1,061.02 = 10,091.03      diff −0.0100
```

→ `UnbalancedEntryError`, which carries `statusCode = 500` (`glPosting.ts:80`).
**The payroll run cannot be approved at all**, with an opaque server error.

🔴 `invoices.service.ts:160-171` already fixed exactly this shape — *"HEADER = Σ
ROUNDED LINES, exactly"* — and payroll never got the sweep. §3: *the report is a
sample, not an inventory.*

### 4. The trial balance has no opening balance, and certifies itself regardless

`reports.service.ts:14` reads `jeLines(date_from, date_to)` — window-filtered,
with no pre-window query — and `TrialBalance.tsx:53` always sends a range
defaulted to the current fiscal year. In year two, Cash, AR, AP and VAT Payable
all show period movement only. `balanced` is computed from the same window, so it
is true either way.

The two sibling reports over the same rows **do** carry openings —
`reports.repository.ts:162-171` (`glPreLines`) and `:197-206` (`acctStmtPre`)
both query `date < date_from` — so the General Ledger and the Trial Balance
disagree about the same account and neither says why.

ERPNext declares `opening_debit`/`opening_credit`/`closing_*` as report fields
and passes `ignore_opening_entries=True` to the period query so movement and
opening are never double-counted (`report/trial_balance/trial_balance.py:24-30,
112, 123`).

**Note what is *not* the finding.** Our computed retained earnings
(`reports.service.ts:143-147`) is a legitimate alternative to their Period
Closing Voucher, and the balance sheet is unaffected — `bsLines(as_of)` has no
lower bound. The gap is the trial balance's missing openings, not a missing
closing voucher.

### 5. Every invoice line stores `"(not yet translated)"` — and L1 is designed to refuse on it

`schema/invoices.ts:137` — `descriptionAr: text("description_ar").notNull()
.default("(not yet translated)")`. `invoices.service.ts:182` persists it via
`...it` if sent. **No invoice-line form in `apps/web` sends it** — the only
`descriptionAr` hits in the web app are bank-transaction display
(`Transactions.tsx:185`) and `Upload.tsx`.

So every invoice line created through the product carries the sentinel, and
`design-invoice-document.md:70-74` requires that a placeholder **BLOCK the
document**: *"the builder REFUSES… would put the literal string '(not yet
translated)' into a legal artifact."* **L1, built exactly as designed against
today's data, refuses on every invoice the product has ever created** — and the
cause is a missing form field, discovered at the moment the launch blocker is
meant to close.

🔴 This is the same defect the codebase already survived one column over, and the
incident is written down twenty lines away. `invoices.service.ts:188-196`, on
`tax_category_code`: *"the column existed, the migration back-filled history, and
the write path never set it… For an onboarded company that meant EVERY invoice
was unissuable. Invisible until issuance was actually connected to real ledger
rows, because fixtures supply the category by hand."* Entity-level Arabic fields
all have writers; the **line-level** ones on the three documents that print were
missed. **This is a prerequisite of L1, not a follow-up.**

### 6. Fixed assets never reach the GL, `/assets` is marked `built`, and depreciation is not idempotent

- `nav/tree.ts:456` — `built("/assets", "Fixed Assets", "الأصول الثابتة", Package)`.
  Not a coming-soon stub.
- `assets.service.ts` contains **no** `postJournalEntry` and **no**
  `checkPeriodOpen` (grep returns nothing). `depreciate()` (`:95-124`) mutates
  `current_book_value` and `accumulated_depreciation` and inserts a
  `depreciation_entries` row. That is all it does.
- `chartOfAccounts.ts` has **no** fixed-asset, accumulated-depreciation or
  depreciation-expense account.
- 🔴 `depreciation_entries.period` is free text with **no unique constraint on
  `(asset_id, period)`** (verified against every migration), and `routes/assets.ts`
  has no undo — `DELETE /:id` removes the asset, not a run. **Clicking Depreciate
  twice for July books July twice, permanently.**

A SAR 180,000 van is expensed in full through the bill (`bills.approvable.ts`
debits `PURCHASES`, an expense account) and then "depreciated" monthly into a
book value the GL has never heard of. Two *value* spaces with no forcing
function — §3's two-id-spaces rule, where nothing can diverge loudly because
nothing joins them. It also feeds the Zakat base, where net book value is a
deduction, and M17.3/M17.4 are already held on C10.

ERPNext maps every asset category to three accounts
(`asset_category_account`), generates an `asset_depreciation_schedule`, and posts
a JE per run.

### 7. A payment cannot be undone. By any route, in any state.

`routes/invoices.ts:6-19` is the complete route table: no unpay, no void, no
payment delete, no amend. `invoices.service.ts:414` refuses `paid <= 0`, so there
is no negative correction either. `invoice_payments` is SELECT+INSERT only by
grant (migration `0046:76-77` revokes UPDATE/DELETE). `paid_amount` has exactly
one writer and it only adds. Bills are identical (`bills.service.ts:253-268`).

Type `10000` for `1000`: the invoice flips to `paid`, leaves AR aging
permanently, and SAR 10,000 that never arrived sits in Cash. The only tool that
touches the ledger afterwards is `POST /journal-entries/:id/reverse`, which fixes
the GL and leaves `paid_amount`, `status` and `invoice_payments` untouched.
Balance-sheet AR and AR aging are then 10,000 apart with nothing reporting it.

Two further properties of the same code:

- **Read-modify-write across an HTTP boundary** (`:426`, `:441`). Two concurrent
  payments both read `alreadyPaid`; the second overwrites the first; one payment
  is lost from the column while both post GL entries. The over-payment guard
  (`:437`) reads the same stale value, so the ceiling is breachable.
- **The authoritative record exists and is not read.** `schema/payments.ts:5-16`
  says the running total was the defect this table replaced — the column was
  never removed, and nothing computes outstanding from
  `SUM(invoice_payments.amount)`. No job, no invariant, no constraint. The only
  `sum(payments) == paid_amount` assertion anywhere is
  `tests/payment-history.test.ts:120-123`, over rows the test just created.

**ERPNext never increments.** `gl_entry.py:351-380` re-sums the ledger every
time; `update_voucher_outstanding` (`accounts/utils.py:2175-2222`) re-derives
`outstanding_amount` from a CTE over Payment Ledger Entry and calls
`ref_doc.set_status(update=True)`, so cancelling a payment moves both views
together. Their paid state is a **projection**; ours is a counter plus a
disconnected history.

And they still needed repair patches — `v13_0.fix_invoice_statuses` (with the
honest comment *"an assumption is being made that only invoices modified after
2021 got affected"*), `v13_0.update_payment_terms_outstanding`, and
`february_2013/fix_outstanding.py` — before giving up and building a dedicated
ledger (`163085f201`, 2022-05-09 → `v14_0.migrate_gl_to_payment_ledger`).
Recomputation was not enough on its own; that is the warning.

### 8. `reverse()` is a second posting path with none of the posting invariants

`journalEntries.service.ts:181-216` writes through
`journalEntriesRepository.insertEntry`/`insertLines` directly — **never**
`postJournalEntry`. So: no `checkPeriodOpen`, no balance check, no account
resolution (the `account_id` column is still nullable,
`schema/journalEntries.ts:52`), and **no guard on what is being reversed**. The
id can be `GL-INV-0007` or `GL-INV-0007-PAY`; reversing an invoice's entry
removes revenue, output VAT and AR from the ledger while `invoices.status`, the
ICV, the hash and the ZATCA document all stand. The date is always `today`
(`:187`), so reversing a January error in November moves January's P&L into
November.

Every other posting path is gated, because `glPosting.ts:161` calls
`checkPeriodOpen`. Reachable from an ordinary `PATCH /transactions/:id`:
`transactionPosting.service.ts:172-187` calls the **unchecked** `reverse` at
`:181` and the **checked** `post` at `:186`.

**ERPNext fixed this same guard three times.** `069a54e5c3` (2020-08-10) moved
`validate_accounting_period` and `check_freezing_date` *above* `set_as_cancel`
and reworded the error to "You cannot create **or cancel** any accounting entries
within the closed Accounting Period". `3ec6387425` (2026-05-27) —
`check_freezing_date(posting_date, adv_adj)` had passed a **boolean into the
company slot**, so no company matched and the guard **silently no-op'd** for
thirteen years. `cab1b129c0` (2026-07-02) then had to decide which date the
reversal validates against.

🔴 **Our `checkPeriodOpen` has the same shape as their 2026 bug.**
`periodLock.ts:42` matches `company_id` against the session GUC:
`(nullif(current_setting('app.current_company_id', true), ''))::uuid`. If the GUC
is empty the predicate is `company_id = NULL`, matches nothing, and **the gate
returns "open" for every date.** Today that is masked by a `NOT NULL` insert
failing afterwards — a 500 rather than a 423 — but the guard has already said
yes. A check that returns clean because its identity argument resolved to nothing
is exactly what they shipped for thirteen years.

### 9. Period locks are a set of month rows, not a watermark

`periodLock.ts:11-14` slices `YYYY-MM` off the date and looks for that exact
string. Lock `2026-06` and a bill dated `2026-05-20` posts without complaint —
into a month whose VAT return is filed. There is no way to express "the books are
closed through 30 June", nothing enforces contiguity, and
`periodLocksService.unlock` (`periodLocks.service.ts:29-33`) deletes the row
outright, leaving no trace of what was posted while it was off.

ERPNext has two independent **monotonic watermarks** —
`Company.accounts_frozen_till_date`, blocking every GL entry at or before it and
explicitly not bypassable by Administrator (`services/gl_validator.py:96-117`),
and `MAX(period_end_date)` over submitted Period Closing Vouchers (`:134-146`) —
plus contiguity enforced at close time: the period start must be **exactly** the
day after the previous close (`period_closing_voucher.py:62-80`), the prior year
must be closed (`:83-113`), and you cannot close behind an existing later close
(`:117-125`). A gap in the closed sequence is inexpressible.

They also kept an audited override *role*
(`role_allowed_for_frozen_entries`); ours is a `DELETE` that removes the lock.

### 10. No party on the GL line — so GL AR and AR aging cannot agree

`schema/journalEntries.ts:41-59` — the complete journal line is `account_id`,
`account_name`, `description`, `debit`, `credit`. No `party_type`, no
`customer_id`, no `against_voucher`, no dimension of any kind.
`reports.service.ts:163-168` states the consequence as a decision: *"Deliberately
NOT moved to the GL: AR/AP aging, customer statements and customer balances.
Those need a per-customer dimension that journal entry lines do not carry."*

A bookkeeper entering opening AR as a manual JE — the first thing a migrating
tenant does — produces a balance sheet saying AR 250,000 and an aging report
saying 0, both computed correctly, 250,000 apart. The reverse writes off a
receivable in the GL that aging still shows as owed and still dunnable.

**ERPNext refuses the row** (`gl_entry.py:139-154`): *"{0} {1}: Customer is
required against Receivable account {2}"*. Their aging **is** the ledger
(`report/accounts_receivable/accounts_receivable.py:187-189, 256-295`), so the
two views cannot disagree. They retrofitted this in 2014 — `be8ec39678`
(2014-08-27) deleted `master_type`/`master_name` and added `party_type`/`party`
to GL Entry with the data migration `patches/v4_2/party_model.py`; `3225102eb9`
two days later made it mandatory and rewrote reconciliation, advances and the
AR/AP reports around it.

🔴 **This is the largest cheap-now/expensive-later item in the comparison.**
Adding `customer_id`/`vendor_id`/`party_type` to `journal_entry_lines` today is
one migration and four posting call sites, with **zero rows to backfill**.

### 11. Document numbers are constructed strings with no unique index, and two provably collide

- `journal_entries.entry_number` (`schema/journalEntries.ts:24`) and
  `bills.bill_number` (`schema/bills.ts:23`) are plain `text().notNull()` with
  **no unique index, in Drizzle or in SQL** (verified across every migration).
  Migration `0063_document_number_counters.sql:15-21` states the risk verbatim —
  *"two financial records that claim to be the same document, silently, in the
  ledger"* — and then fixes the **allocator only**.
- Every automated posting bypasses the allocator and mints a literal:
  `invoices.service.ts:454` → `GL-${invoiceNumber}-PAY`, so **two partial
  payments on one invoice produce two journal entries with the identical
  number**, and partial payment is a supported flow;
  `payroll.approvable.ts:33` → `PAY-${run.period}`, colliding on a re-run;
  `journalEntries.service.ts:190` → `${entryNumber}-REV`.
- 🔴 **`invoices_company_number_unq` exists only in raw SQL**
  (`0054_c12_invoice_number_uniqueness.sql:63-64`) and is **absent from the
  Drizzle schema's index list** (`schema/invoices.ts:110-118`, which *does*
  declare `invoices_company_icv_unq`). Verified: the string appears in exactly one
  file in the repo, and no test asserts the index exists. Since `drizzle-kit`
  diffs the schema as desired state, the next `generate` can emit a **`DROP
  INDEX`** on the only enforcement of ZATCA's "uniquely identifies the Tax
  Invoice" — and the generated SQL would look ordinary.
- Two incompatible bill series in one company:
  `purchaseOrders.repository.ts:113-127` mints `BILL-{YYYY}-{NNNN}` with a racy
  `MAX+1` whose stated guarantee is *"the unique index is the guarantee"* — on a
  table that has none — while `documentNumbers.repository.ts:45-55` mints
  `BILL-{NNNNNN}`. Neither can see the other's rows.
- `lockCompanySequence` is a **convention, not a boundary**
  (`invoices.repository.ts:252-254`): `nextIcv` and `zatcaPreviousInvoiceHash`
  are callable without it and "CALL ONLY WHILE HOLDING" is prose. §3's *invariant
  enforced only when the caller declines to override it*, in the accounting core.
  A `withCompanySequence(companyId, fn)` owning all three reads would close it.

**Where ours is better, and it is worth keeping:** the IRN and the ICV are
separate fields with separate guarantees allocated at separate moments (create vs
approve) where ERPNext has one identifier doing both jobs; our allocation is
transactional so a rolled-back approval burns no number
(`0054:80-84`); and we ship a numbering-gap detector with a caller and a UI
(`findings.repository.ts:81-110` → `Findings.tsx`), against which ERPNext has
nothing.

### 12. The GL balance check runs before rounding, and nothing re-checks after

`glPosting.ts:148-152` sums **unrounded** IEEE-754 floats and compares against
`GL_BALANCE_TOLERANCE = 0.005`. `:185-186` then writes each line with an
**independent** `.toFixed(2)`. There is no post-rounding re-check and no round-off
account (`chartOfAccounts.ts` has no `ROUND_OFF` code). The check and the
persisted values are computed from different numbers, and an entry admitted at
0.004 persists as rows whose stored sum differs from what was checked.

The tolerance is two numbers again — the disease `glPosting.ts:45-59` already
diagnoses for itself: write side `0.005`, read side a hardcoded `0.01` literal in
three places (`reports.service.ts:36, 353, 359`), applied after a
`parseFloat(toFixed(2))` round trip. The read side is exactly 2× the write side
and does not import the constant.

**ERPNext's order is the whole point** (`general_ledger.py:397-427`): round each
entry to precision *first*, sum the **rounded** values, throw above an allowance
**derived from precision** (`5.0 / 10**precision`), post the sub-allowance
residual to an explicit **Round Off account** (`:475-541`), then **re-check**
(`:420-421`). They landed rounding at the write boundary in `362455e749`
(2013-02-13), the round-off account in 2015, and were still correcting the
tolerance in `bfc34e1084` (2022-04-01).

**Related, unmeasured but structural:** 12 separate definitions of
`round2 = n => Math.round(n*100)/100` and 12 of `toNum`, against ~90
`.toFixed(2)` call sites. They are **different rounding functions** — 1.045 → 1.05
vs 1.04; 2.675 → 2.68 vs 2.67 — and both are used in the same path
(`invoices.service.ts` computes with one and stores with the other).

### 13. A header discount makes an invoice creatable and never approvable

`invoices.service.ts:140` allowlists `discount` on create; item discounts get
`assertAmount` (`:150`) and **the header discount gets no validation anywhere in
the file**. `:211` computes `total = subtotal + vat − discount` and touches
neither stored component. `invoices.approvable.ts:235-237` then posts
`Dr AR = total`, `Cr SALES = subtotal`, `Cr VAT = vatAmount`, unbalanced by
exactly the discount → `UnbalancedEntryError` → **500**.

It breaks the ZATCA document one step earlier too:
`einvoiceInput.assembler.ts:344-350` emits `allowanceTotal = discount` while
`taxExclusiveTotal = subtotal` is unreduced, violating EN 16931 BR-CO-13/15.

I checked the one path that would make this reachable through the product —
quotation → invoice conversion — and **it is not**:
`quotationConversion.service.ts:174-191` allocates discounts per **line** and
never passes a header discount to `invoicesService.create`. So this is API-only,
but `discount` is in the OpenAPI contract and in the generated client types.

ERPNext's `apply_discount_amount` (`taxes_and_totals.py:901-957`) distributes a
header discount into the item net amounts with a running rounding correction, so
the lines always re-sum to the header and this cannot happen to them.

### 14. Every simplified invoice tells ZATCA it was settled by credit transfer

`einvoiceInput.assembler.ts:352` — `paymentMeansCode: "30", // credit transfer —
the safe default (BR-KSA-16)`, and the same at
`onboarding/complianceDocuments.ts:114`. There is no mode-of-payment concept
anywhere in the schema or the services (grep returns nothing).

The B2C cash-and-mada case **is** the simplified invoice's reason to exist. The
document is signed, chained and archived for 6–11 years carrying a false fact,
and no validator will object — §3's *external validators check the weakest
property they plausibly could*, aimed at us.

**ERPNext shipped the neighbouring bug and had to fix it:** `b37559c535`
(2022-03-14) — the ZATCA QR's VAT tag was populated from
`total_taxes_and_charges`, the document's *total* tax rather than its VAT.
Checked against ours: `qr.ts:98` tag 5 ← `input.taxTotal` ←
`einvoiceInput.assembler.ts:350`, which is `money(invoice.vatAmount)`, a
VAT-specific column. **We do not have the bug, but we have the name** — a field
called `taxTotal` is the obvious thing to widen the day a second tax line exists
(Saudi has excise on tobacco and sweetened drinks, and withholding on
non-resident payments), and the QR is where it would land. §3's *a flag's scope
drifts past its name*, pre-armed. Cheap to rename now.

### 15. Withholding tax is a nav placeholder, and it is a monthly legal obligation

`nav/tree.ts:305` is `soon("withholding-tax", …)`, `comingSoon.ts:416-420` is the
page, and grep for `withhold` across the backend returns **only** liquidity-claim
prose. `nav-tree-reconciliation.md:236` says it plainly: *"Withholding Tax
(Coming Soon) — Zero code. Honest in the spec."*

Under the Income Tax Law a resident payer must withhold on payments to
**non-residents** with no Saudi PE — commonly 5% (rent, technical/consulting
services, air freight, insurance premiums, dividends, loan charges), 15%
(royalties, related-party service payments), 20% (management fees) — and remit
within the first 10 days of the following month, with the **payer** liable and
the deduction disallowed if not withheld. Administered by ZATCA alongside VAT.
*(Rates and deadlines stated from knowledge, not from a primary text in this
repo — advisor-verifiable, the same posture as C10.)*

Any SME paying an overseas SaaS vendor, consultant, agency or non-resident
landlord hits this monthly. **The finding is the classification, not the
absence:** §5 is defined as everything that must close before a real taxpayer is
onboarded, and this is a tax the tenant is legally obliged to compute and remit.
Minimum shape: a non-resident flag on `vendors`, a `WHT_PAYABLE` system account,
withholding at the pay path, and the monthly figure.

ERPNext has `tax_withholding_category` with threshold bands (cumulative and
per-transaction), `tax_withholding_account`, `tax_withholding_entry`, and
`lower_deduction_certificate`.

### 16. `products.stockQty` is a number someone typed once, rendered as a live stock level

`schema/products.ts:28` — `stockQty: numeric(15,3).default("0")`, written only by
the create/update form (labelled "Opening Stock Qty") and read back verbatim
(`products.service.ts:21`). **Nothing decrements it**: an invoice for 10 units
leaves it unchanged. `Products.tsx:119` then colours it `text-negative` when
`stockQty <= reorderPoint` — a reorder alert computed from a stale constant.

§3's *a consumer with no producer yields a confident zero, which reads as an
answer*, with the aggravation that here it reads as a **reorder signal**.

`grep -rniE "cogs|cost.of.goods|goods.sold"` across `apps` and `packages` returns
**zero hits**. An `INVENTORY` asset account exists in the seeded chart
(`0029_m15_default_categories.sql:46`) and **nothing posts to it**.

### 17. Three smaller ones, verified

- **`grossProfit` is set to revenue.** `reports.service.ts:95` —
  `grossProfit: totalRevenue`. There is no COGS concept because `categories.type`
  has no value for it and the chart has no hierarchy to subtotal on. Every income
  statement answers "what is my gross margin?" with the revenue figure.
- **The chart of accounts is flat and create-only.** `schema/categories.ts` has no
  `parent_id`, no `is_group`, no `disabled`; `categories.service.ts` has no update
  and no delete. An account created with the wrong `type` is permanent and will be
  offered in every dropdown forever. ERPNext refuses to post to a disabled account
  (`gl_validator.py:20-36`) and refuses type/currency changes once entries exist
  (`account.py:302-314, 368-381`).
- **`creditLimit` has no enforcement reader.** `grep -rn "creditLimit"
  apps/api/src` excluding `customers.service.ts` and `tests/` returns **nothing**.
  It is collected, validated, typed in the spec and conformance-tested. A customer
  who sets a SAR 50,000 limit reasonably believes something enforces it; nothing
  does, and the field's existence is the promise. ERPNext has a
  `customer_credit_limit` doctype that blocks or warns at submission.

---

## Part 2 — What correct inventory actually requires

We have no stock ledger. Building one from first principles gets these wrong, in
this order.

### The one that decides the design: a backdated entry is a REWRITE, not an insert

Record a receipt dated 1 Sept on 15 Sept, and every issue in between consumed
stock at a cost computed without it. Every one of those COGS postings is now
wrong.

ERPNext's `update_entries_after.repost_stock_ledgers`
(`stock/stock_ledger.py:789-823`) walks every SLE at or after the backdated
timestamp `FOR UPDATE` and **overwrites five fields on each**
(`qty_after_transaction`, `valuation_rate`, `stock_value`, `stock_queue`,
`stock_value_difference` — `:1166-1177`), feeding each recomputed row forward as
the next row's previous state, then follows *dependent* item/warehouse pairs
because a transfer's outgoing leg feeds another warehouse's incoming rate
(`:834-856`).

**The evidence this is not obvious:** `stock_ledger.py` dates to 2013-01-08. The
`Repost Item Valuation` doctype — queued, resumable, deduplicated, retryable —
arrived **2020-12-21** (`a77b8c9fcc`), *seven years later*, needed correctness
fixes within four days and again within two months, has 148 commits, and
`patches/v13_0/item_reposting_for_incorrect_sl_and_gl.py` reposts **every SLE in
every production database** because the stored values were wrong.

🔴 **We cannot host that engine.** It sets `MAX_WRITES_PER_TRANSACTION *= 4`,
checkpoints every 2,000 SLEs to survive a 1,800-second job timeout, persists
resume state to a gzipped JSON file with a cursor, chunks GL reposting at 100
vouchers per commit, runs up to 4 parallel workers with per-item advisory locks,
and forces a permitted timeslot of **at least 10 hours**. A comment says a deep
repost *"can match millions of rows."* CLAUDE.md §6: **no Redis, no queue**;
background work is the in-process scheduler, and we already killed the API process
once with a 15-second idle-in-transaction guardrail (C6a). This is a constraint on
which valuation method we may choose, not a preference.

It also collides head-on with our period lock: the repost must rewrite closed-month
GL, `checkPeriodOpen` throws 423, and the repost dies half-done — some SLE rows
rewritten, no GL correction, silent split-brain. ERPNext orders three gates —
repost failure rolls back the whole transaction and emails Stock Managers; **you
cannot close while reposts are pending** (`stock/utils.py:568-593`); and once
closed, backdating is inexpressible (`stock_ledger.py:103-126`).

### The three viable designs, in the order I would consider them

**A — quantity-only ledger, periodic valuation (recommended first milestone).**
Build the SLE table with `actual_qty`, `qty_after_transaction` and the
ordering/locking discipline, but **no valuation fields and no GL effect**. Bills
keep debiting `PURCHASES`. This delivers real stock levels, reorder points and
physical counts — and an honest quantity in place of today's fictional
`stockQty` — with **zero** repost machinery. Value moves to the balance sheet once
per period via a closing entry. ERPNext supports exactly this mode and makes the
two mutually exclusive by construction (`journal_entry.py:244-289`), which is the
right pattern.

**B — perpetual with Standard Cost.** Real-time COGS and inventory value;
backdating becomes a hard refusal at the write boundary. Costs a purchase-price-
variance account and a revaluation workflow. 🔴 ERPNext reached this conclusion
**thirteen years in** and says so out loud (`stock_ledger.py:57-61`): a Standard
Cost item's transaction cannot be dated before the latest standard-rate effective
date, because that *"would force a repost — which Standard Cost deliberately
avoids."* Shipped 2026-06-28. That is §3's *make the wrong thing inexpressible*
applied to the hardest part of inventory, by the people who spent thirteen years
handling it instead.

**C — perpetual with FIFO or Moving Average.** Requires the repost engine. Not a
milestone; a subsystem with a five-year hardening tail.

### The other mistakes, each with its failing case

1. **One `valuation_rate` per product.** We already have `products.unitCost`, a
   single scalar. Receive 10 @ 100 then 10 @ 120: any single number is wrong for
   at least one of {balance-sheet value, COGS on this sale, margin on the next
   quote}. ERPNext stores valuation state **per (item, warehouse), on every ledger
   row** — a JSON `stock_queue` of `[qty, rate]` bins for FIFO, a recomputed
   running average for Moving Average — and keeps three distinct rates that mean
   different things: `incoming_rate`, `outgoing_rate`, `valuation_rate`.
   Conflating any two is its own bug.
2. **`SUM(qty)` over the ledger.** Too slow at 200k movements, and racy — two
   concurrent invoices for the last unit both read 1. ERPNext denormalises twice:
   `qty_after_transaction` on the row (so "as of any datetime" is a single
   indexed read, not an aggregate) and a `Bin` table per (item, warehouse) with a
   DB unique constraint, holding facts the ledger has no concept of
   (`reserved_qty`, `ordered_qty`, `projected_qty`). 🔴 Their concurrency gate is
   **Postgres-specific and their comment explains why it exists**: MariaDB gets
   it from gap locks, *"postgres locking reads never see rows another transaction
   is inserting, so without this gate two concurrent writers compute from the
   same stale previous SLE and the loser's Bin write is lost."* We are on
   Postgres. Locks are taken in sorted pair order to avoid deadlock — the same
   discipline as our `lockCompanySequence`, and the same lesson: the lock must
   cover the read.
3. **Posting COGS at invoice time.** Ship 28 Sept, invoice 3 Oct, and September
   shows revenue-free stock on the balance sheet while October carries cost with
   no revenue. ERPNext relieves stock at the **stock event** into a clearing
   account (`stock_delivered_but_not_billed` / `stock_received_but_not_billed`)
   and the invoice moves it to COGS later, re-deriving the amount from the
   original delivery's SLE. Double-posting is prevented by **mutual exclusion**
   (`update_stock` on the invoice), not by netting. 🔴 For us this is a product
   decision first: `purchaseOrders.ts:125-140` is a standing owner instruction —
   *"THE VOCABULARY IS BILLING, NEVER DELIVERY"* — so we have no receipt or
   delivery document to hang this on.
4. **Valuing a return at today's rate, or at the sales price.** Both mint money:
   the first books a phantom gain, the second capitalises your own margin into
   inventory. ERPNext looks the rate up from **the original outward SLE of the
   original line**, pinned by `voucher_no` *and* `voucher_detail_no`
   (`controllers/sales_and_purchase_return.py:784-814, 857-886`). The sales price
   is a last resort only for a standalone credit note with no `return_against` —
   precisely the case with no SLE to anchor to. Not obvious, because "current
   valuation rate" passes every test you would think to write.
5. **Making quantity a delta everywhere.** A physical count is an **absolute**
   state, not a movement: ERPNext sets `qty_after_transaction` directly, leaves
   `actual_qty` at 0, **discards the entire FIFO queue** and replaces it with one
   synthetic layer, and sends the money difference to a stock-adjustment account.
   🔴 One trap worth stealing outright: an *opening* reconciliation's difference
   account **must be a balance-sheet account**, never P&L
   (`stock_reconciliation.py:1098-1111`) — otherwise the first stock load a tenant
   ever does appears as an enormous gain in their income statement.
6. **Not building the stock↔GL invariant check.** They diverge often enough that
   ERPNext ships two reports and a weekly self-healing sweep. **Invariant A**, per
   voucher: `Σ stock_value_difference` over its SLEs == the net movement on
   stock-type accounts in its GL entries. **Invariant B**, per (item, warehouse):
   running `Σ actual_qty` == stored `qty_after_transaction`, running
   `Σ stock_value_difference` == stored `stock_value`, `stock_value / qty` ==
   stored `valuation_rate`, and the reconstructed queue matches both. **Build
   these as tests before building the feature**, so they cannot be retrofitted
   around a bug that already exists. Our specific exposure: nothing stops a manual
   JE debiting `INVENTORY` today, and ERPNext's own guard there is weak — we can
   refuse it at the write boundary instead.
7. **Letting a cost be corrected by editing the receipt.** ERPNext's Landed Cost
   Voucher literally un-posts and re-posts the original in place
   (`landed_cost_voucher.py:438-450`). 🔴 **Structurally forbidden for us** —
   approval mints an ICV and a hash chain, issuance fails closed, `ArchiveStore`
   has no delete. A cost correction must be a **new adjustment document with its
   own SLE + GL pair**, which means the valuation model must tolerate a
   value-only movement that changes no quantity. Design it in; retrofitting one
   into a qty-driven ledger is painful.
8. **Ordering by timestamp.** ERPNext has a whole regression family for ties
   (`test_tie_breaking`, `test_timestamp_clash`, `test_backdated_sle_with_same_timestamp`,
   …); the ordering key is **always** `(posting_datetime, creation)`, never a row
   id. We learned this in the ZATCA chain (§4: `icv DESC NULLS LAST, id DESC` —
   *"never row id"*). Same lesson, second domain. 🔴 And we have the live version
   of it already: `reports.repository.ts:224` (account statement) and `:314` (tax
   journal) order by `date` **alone**, and the account statement computes a
   **running balance** over that order — so same-day orderings can change between
   requests. The general ledger (`:193`) does tie-break on `id`.
9. **Allowing negative stock.** FIFO will invent a cost to satisfy you — ERPNext
   pushes a negative bin and falls back down a chain ending at a **buying price
   list**, turning a price into a cost. §3's *a value that satisfies every check
   while meaning nothing*, in inventory. Refuse it at the write boundary; do not
   offer the toggle. Note their reposts default to `allow_negative_stock=1`
   because a repost must pass through negative intermediate states — two
   different policies for the same condition.
10. **Letting items and accounts change after they have a ledger.** ERPNext
    freezes `is_stock_item`, `has_batch_no` and `valuation_method` once any
    submitted document references the item (with one asymmetric carve-out: FIFO →
    Moving Average is allowed, the reverse is not), refuses to delete a warehouse
    with any SLE, and refuses to move an account away from `account_type =
    "Stock"`. Ours: `productsRepository.remove()` hard-deletes and every line FK
    is `onDelete: "set null"` — the ledger's identity axis would evaporate while
    the money stayed.
11. **Scoping stock to the org.** A stock table added today inherits Part 1 §1: a
    two-company org's stock value adds both warehouses. ERPNext scopes by
    **warehouse**, and a warehouse belongs to a company; `Item Default` is a child
    table with one row per company carrying every money-relevant default. A
    warehouse table must carry `company_id` and its repository must filter
    explicitly, because RLS will not. 🔴 **Do not repurpose the dead `branches`
    table** — S6/S7 says build a consumer or drop it, not quietly redefine it.
12. **Capitalising VAT into inventory cost.** ERPNext splits every purchase
    charge into `Valuation` / `Total` / `Valuation and Total` and capitalises only
    the valuation categories. Saudi mapping: standard-rated input VAT is
    *recoverable* → `Total`, never valuation; customs, clearance and freight →
    `Valuation`. 🔴 We have a **third** case they do not:
    `categories.inputVatBlocked` (`schema/categories.ts:87`) — VAT charged, paid,
    and not deductible. Whether blocked input VAT belongs in inventory cost is a
    real accounting question and an **advisor item**, beside C7/C8/C10.
13. **Building serial/batch tracking because a retailer asked for expiry dates.**
    Identity-tracked stock **forks the valuation engine** — a mini-ledger per
    serial or batch, with its own queue and rates, bypassing the item-level FIFO
    queue while the item-level rate is maintained in parallel. A non-valuation
    batch attribute (an expiry date on a movement, reported on) is a
    fundamentally different and far smaller feature. Decide which one is being
    asked for.
14. **Assuming UOM is cosmetic.** `products.unit` is free text with no
    conversion. Buy by the carton, sell by the unit, and the ledger nets carton
    receipts against unit issues — every number downstream off by the factor.

### Saudi-specific things that change the answer

- 🔴 **Adding stock relief to `issueInvoice` puts inventory inside a fail-closed
  legal path.** `invoices.approvable.ts` mints the ICV, signs the ZATCA document,
  and rolls the whole approval back on any failure. If stock relief joins that
  transaction, **a missing valuation rate or a negative-stock refusal becomes a
  reason a tenant cannot issue a legal invoice.** Either stock is inside (stock
  data quality gates invoicing) or outside (invoicing never blocks, and Invariant
  A must be a monitored alarm, not a report nobody opens). There is no third
  option.
- **A credit note reverses; a debit note does not** (§4). Stock must follow: a
  credit note for *returned goods* reinstates quantity at the original outward
  cost; a credit note for a *price adjustment* moves money and no quantity; a
  debit note must not double-relieve. A naive "credit note = reverse everything"
  moves stock on a pure price correction.
- 🔴 **Sign convention conflicts with our house rule.** §4 stores amounts
  **positive** with direction in `document_type`; a stock ledger's `actual_qty` is
  inherently **signed**. Either the SLE is a sanctioned exception — written down —
  or it carries a direction column and signs at read. Pick one before the first
  migration; a mixed convention here is the two-id-spaces shape.
- **A warehouse transfer must be tax-invisible** — the same shape as
  `kind: transfer` / `taxVisible()`.
- **Inventory feeds the Zakat base**, which C10 records as unverified against the
  Zakat Collection Regulations. A new stock valuation must not quietly change what
  the Zakat surfaces claim while M17.3/M17.4 are held.

### The testing standard to adopt

ERPNext's stock tests assert the **queue and the money movement**, not the closing
quantity (`stock/tests/test_utils.py:18-55`). For us:

- Assert **both accounts before and after** every movement (§3's *two correct
  assertions with a gap between them*) — inventory down and COGS up, not "the
  balance sheet balances".
- Assert the **FIFO layer state**, not only the rate: the correct answer and the
  broken one coincide whenever all receipts are at the same price, so **seed two
  receipts at different prices in every fixture**. §3's *small fixtures do not
  test less — they test differently*; breadth must be seeded.
- Replicate the zero-movement standard: a **draft** stock document moves zero in
  every report.
- Build Invariants A and B before the feature.

---

## Part 3 — Assumed-standard things nobody has mentioned to us

Only items genuinely absent AND unmentioned in CLAUDE.md, §5, or the coming-soon
inventory. Items already queued (billing R1, bank feeds A2, PDPL C8, CoA import)
are excluded.

1. **There is no way to bring an existing business onto the platform.**
   `openingBalance` exists on exactly one table (`bankAccounts.ts:27`) and posts
   nothing; `grep -rin "isOpening|is_opening"` returns **zero**; `invoices.status`
   has no historical/migrated state. A five-year-old company with SAR 400,000 of
   open AR must create 40 invoices — each of which, on approval, mints an ICV,
   extends the legally meaningful chain and submits documents ZATCA has already
   seen from their old system. The alternative, a lump-sum opening JE, gives a
   correct trial balance and a **useless AR/AP subledger** (Part 1 §10), and there
   is nowhere to land the opening difference: the only equity account in the
   system is `EXTERNAL_TRANSFERS` and retained earnings is computed, not stored.
   🔴 **The only customers who can correctly start on this platform are businesses
   with no history** — the smallest and least valuable segment. `coa-import` is
   already a coming-soon slug, so the *chart* half is known; the *balances* half
   is not mentioned anywhere, and a CoA importer without opening balances solves
   nothing. **One §5 item.**
2. **Advance payments — a VAT tax point we cannot represent.** Overpayment is
   explicitly refused (`invoices.service.ts:437`; bills twin) and there is no
   unapplied-receipt concept. A 30% deposit on a SAR 300,000 contract arrives as
   an uncategorised bank line that posts to `SUSPENSE` — which then **blocks the
   Finance Hub liquidity claim by design** — or the user fabricates an invoice.
   🔴 The KSA VAT Implementing Regulations put the tax due date at the **earlier
   of invoice issuance or receipt of consideration**, so VAT on that deposit was
   due in January; our VAT return reads invoices and bills, so the tenant
   under-declares. ZATCA's Implementation Resolution carries dedicated
   **prepayment fields (7.13 subtotal, 7.14 VAT amount, 7.15 VAT rate)**, "required
   if prepayment is used" — three conditional-mandatory fields in a spec we ship
   and the builder cannot populate. Composes with §5's invoice-dating item: the
   user's instinct is to back-date the April invoice into January, which the
   period guard refuses, leaving them no correct move at all.
3. **One payment cannot settle several invoices.** `invoice_id` is `NOT NULL` with
   no allocation table and append-only grants, so a misallocation can only be
   offset, never corrected. A customer wires SAR 47,300 covering six invoices and
   the bookkeeper splits it by hand; the reconciliation service matches on
   date+amount, so the lump line matches nothing. Not a wrong number — wrong
   *effort*, on the single most frequent daily task in AR.
4. **Bad debt / write-off.** `grep -rin "bad.debt|write.off|uncollect|doubtful"`
   returns **zero**. A SAR 60,000 invoice that will never be paid can only sit in
   AR forever or be killed with a **credit note** — the ZATCA instrument for a
   *cancelled or corrected supply*, factually wrong for a supply that happened and
   was not paid, and it reduces reported sales as well as VAT. §3's *make the
   wrong thing inexpressible*, inverted: the only expressible act is the wrong
   one.
5. **Deferred revenue.** No account, no schedule, no service. An annual
   maintenance contract sold in January is recognised in full in January. 🔴 Worth
   re-reading `design-analytics.md:18`, which records *"ACCRUAL — settled, the
   accountant's model turned out to be what the ledger already does"* — true for
   the *timing of the invoice*, not for the *period the revenue belongs to*. §3:
   verify the reason, not only the entry.
6. **Payment schedules / instalments.** `customers.paymentTermsDays` is one
   integer displayed as a badge, with no consumer turning it into `dueDate`. Saudi
   contracts routinely run "30% advance, 40% on delivery, 30% at 60 days". AR
   aging buckets a whole invoice at one date, so a SAR 300,000 contract with SAR
   90,000 genuinely overdue shows as 0 or 300,000, never 90,000. This also
   explains the known instalment-history gap: we record payment dates and never
   scheduled ones, so "was this on time" is unanswerable from either side.
7. **Approval has no monetary thresholds.** `grep -rn
   "threshold|amountLimit|approvalLimit"` in `services/approval/` and `lib/rbac.ts`
   returns **zero**. The only expressible policy is "can approve" / "cannot", so
   the owner either approves every SAR 200 invoice personally or delegates
   unlimited authority. §5 flags *action*-level permissions as deferred;
   **amount-level is a different axis and is not mentioned** — and it is the
   natural mitigation for the removed auto-approve, since it gates the composition
   that mints a permanent ZATCA document.
8. **No shareholder / ownership register.** Saudi entities are subject to **Zakat
   on the Saudi/GCC-owned share and income tax on the non-Saudi share**,
   apportioned by ownership percentage — and C10 already lists "the
   mixed/foreign-ownership posture" as an open advisor question. The question
   cannot be *answered* by the platform in any case, because there is nowhere to
   record who owns what. A prerequisite of M17.3/M17.4 that C10 does not name.
   Owner capital and drawings have the same gap.
9. **The shorter tail.** Budget enforcement (ours reports variance and never
   blocks; theirs stops or warns at submission, and their `monthly_distribution`
   spreads an annual budget seasonally — Ramadan/Eid seasonality is real for Saudi
   retail and a flat twelfth is wrong) · **dunning/collections** (`grep -rin
   "dunning"` → zero; for an SME, chasing *is* the finance function) · **data
   import beyond bank CSV** (`data-export` is a coming-soon slug; **import is not
   mentioned at all**, and import is the one that blocks signup while export
   blocks only departure) · **year-end close** (no closed prior year, no
   prior-period-adjustment concept, and no snapshot of the balance a Zakat return
   was filed against — so last year's filed number cannot be reproduced, which is
   §3's *a verification is a claim about a moment* applied to a tax filing) ·
   **deterministic ledger-health checks** (ERPNext runs `ledger_health` on a
   schedule; our `findings` engine is business-level and **dark by construction**
   until Groq Enterprise is signed — a ledger-integrity check needs no AI and
   would have caught the ±8,750 reversal bug as a standing guard) · **holiday
   calendar** (due dates landing on Eid).
10. **One boundary case, flagged rather than classified.** A **payment gateway for
    the tenant's own customers** — a "pay this invoice" mada/SADAD link.
    `comingSoon.ts` names MyFatoorah and SIFI, so it is known in the UI, but §5's
    R1 is about *us* taking money from tenants and does not cover this. Arguably
    the highest-value thing that could sit next to L1: the invoice leaves the
    product **and** gets paid.

---

## Part 4 — Where the comparison does not transfer

Stated so the absences are deliberate rather than overlooked.

- **Multi-currency.** Their four amount axes per GL line, Exchange Rate
  Revaluation and realised gain/loss journals are irrelevant, and **we closed this
  better than they did**: `writeGuards.ts:119` refuses non-SAR at the write
  boundary and migration `0062` puts a CHECK on all nine tables carrying
  `currency`, refusing to run rather than coercing existing rows. ERPNext shipped
  the wrong-currency-in-the-KSA-VAT-report bug for years (`b96526eefd`, 2022-09-01
  — `net_amount` where `base_net_amount` was required). Residual: our
  `assertSupportedCurrency` is called only from `bankAccounts.service.ts`, so a
  `currency: "USD"` invoice fails as a raw 23514 → 500 rather than the written
  400.
- **Manufacturing, subcontracting, BOM, work orders**; the whole POS cluster;
  `supplier_scorecard`; RFQ/supplier quotation; shipping rules, incoterms, product
  bundles; asset maintenance/repair/movement/vehicle/driver; `finance_book`
  (parallel IFRS/tax books); inventory dimensions; nested-set warehouse trees;
  LIFO (not permitted under IFRS, which Saudi requires).
- **The ~40 `create_accounting_dimensions_in_*` patches** — a consequence of
  DocType metadata plus cost centres/projects/finance books. Worth knowing only as
  a warning: if `branches`/`departments` (currently consumerless, S6/S7) ever
  become GL dimensions, their evidence is that **every posting path becomes a
  separate migration**. Decide now, while there is nothing to migrate.
- **Their repost/queue infrastructure** presupposes Redis/RQ and multi-worker
  deployment (see Part 2).
- **Their naming-series refactors** are Property Setter / metadata machinery with
  no analogue.
- **Group and disabled accounts** — our chart is flat and `categories.repository.ts`
  exposes no update or delete, so neither of their failure modes is reachable. The
  inverse gap (an account can never be retired) is a missing feature, not a
  repeated mistake.
- **`v16_0.migrate_account_freezing_settings_to_company`** — their freeze date was
  a *global* setting until 2025 and had to be moved per-company. Ours already is.
- **Site-per-tenant.** Frappe binds the DB connection to the site at request boot,
  so cross-*tenant* reach is not a query anyone can write. Our RLS buys back
  operational density and a single migration path, and `db` refusing an unscoped
  query is real hardening they have no need for. **That trade is defensible. The
  company trade in Part 1 §1 is not** — they have both layers and we have neither.
- 🔴 **ERPNext deleted its Saudi module in v15** (`patches/v15_0/delete_saudi_doctypes.py`)
  and pushed KSA compliance to a third-party app. After fifteen years the mature
  ERP concluded country tax compliance does not belong in core. Context for what
  we are, not a defect in us.
- 🔴 **Zakat has never been implemented in ERPNext** — 61,080 commits and the word
  appears only as an account name in the UAE chart template. There is **no
  open-source prior art** to check M17's tax content against, which makes holding
  M17.3/M17.4 on C10's advisor conversation the only available path rather than a
  conservative one.

### One of their defects that validates our approach

`erpnext/locale/ar.po:4876` — `msgid "Amount"` → `msgstr "كمية"`; `:43501` —
`msgid "Quantity"` → `msgstr "كمية"`. Identical, and كمية means *quantity*. Every
Arabic-printed ERPNext invoice labels its **money column "quantity"**, because the
print template renders the header through `_()`. That is precisely the defect our
inline `t("Amount", "المبلغ")` form **structurally cannot have** — the pair sits in
the diff, next to the number it labels. It cuts against the otherwise-real point
that their central catalog is auditable and our ~1,656 inline pairs are not
(theirs: 10,518 msgids, ~2,450 empty — 23% of Arabic silently falls back to
English).

### What they have that we should take on language

**Print language is a property of the DOCUMENT, seeded from the RECIPIENT, and
frozen** — on the party (`customer.json:276-280`, labelled "Print Language"),
copied to the transaction (`accounts/party.py:378-389`), stored `read_only` on the
invoice. Re-printing an invoice a year later gives the same artifact. **We have no
such field anywhere** — no `language`/`locale` column in any of the 39 schema
files. `design-invoice-document.md:68` permits a second language side-by-side and
never gives that permission a column, a control or a default. Take the three
properties, not the doctype: on the party, snapshotted at approval, read-only
after — exactly what `schema/invoices.ts:58-59` already does for the **seller** and
does not do for the **buyer**. Today a customer rename mutates the printed name of
an already-stamped invoice.

---

## Part 5 — What did NOT survive verification

Moved to the TOP of this document at the owner's direction (§READ FIRST) — an
appendix is where a retraction goes to be skipped.

---

## The four changes I would rank first

1. **The company predicate inside `jeConditions()`/`lineJoin()`, then an RLS
   `USING` on `app.current_company_id`.** Nothing else here produces a 10×-wrong
   figure in a filed VAT return under a green `balanced: true`.
2. **`descriptionAr` on the invoice-line form.** It is a prerequisite of L1, not a
   follow-up — L1 as designed refuses on every invoice the product has created.
3. **One money seam, and move the GL balance check after rounding** — a round-off
   line or a loud throw, on the rows actually persisted. Closes the 10.3% payroll
   block and the header-discount invoice together, and retires 12 `round2`s.
4. **Party on the journal line, and unique indexes on `(company_id,
   entry_number)` / `(company_id, bill_number)`** — plus declaring
   `invoices_company_number_unq` in Drizzle so codegen cannot drop it. All three
   are schema decisions with **zero rows to backfill today**, and ERPNext paid for
   the party one with a data patch that rewrote live tenants' balances.

---

## TRIAGE ADDENDUM (2026-09-04) — the four findings costed, FOR THE OWNER TO RANK

Owner-requested: these are recorded findings, invisible to milestone planning
until placed in §5, and the placement is the owner's. Costs are build
estimates against today's codebase (the money seam, party columns and unique
indexes all exist now and reduce them). 🔴 A PROPOSAL, NOT A DECISION.

| Finding | Exposure | Build cost | The catch |
| --- | --- | --- | --- |
| **Withholding tax** | 🔴 LEGAL — the payer is liable; monthly remittance; any SME paying a non-resident hits it | **~1 week**: non-resident flag on vendors, WHT category/rates, the split at `billsService.pay` (Cr cash net / Cr WHT_PAYABLE), a WHT_PAYABLE system account (⚠ `categories` migration → the org-seed-trigger rule), the monthly figure surfaced | The RATES/bands are statutory content — buildable now as configurable values marked reasoned-not-verified, confirmed at the advisor meeting (same posture as C10) |
| **Advance payments** | 🔴 LEGAL — VAT due at the earlier of payment/invoice; ZATCA's prepayment fields (7.13–7.15) exist in the spec we ship and the builder cannot populate them | **~2–3 weeks** — the largest: an advance-receipt document (posts Cr advances-liability + party, VAT at receipt), its entry into the VAT return (the documents-file model needs a third reader or an advance-invoice subtype), application/allocation against later invoices, the UBL prepayment fields | Design-heavy, and the tax mechanics (prepayment tax invoices vs receipt-only) are an ADVISOR question embedded in a build — costing assumes the advisor answers land first |
| **Fixed-assets GL** | Wrong statements TODAY for anyone who clicks the built `/assets` page; feeds the Zakat base | **~1 week** for depreciation-posts-to-GL (3 system accounts → seed-trigger rule, period lock, unique(asset, period), a disposal posting); capitalisation-from-bill adds ~3 days | Cheapest honest interim exists: gate `/assets` behind coming-soon in an HOUR, converting a silent wrong number into a named absence, if the owner prefers deferral |
| **Migration onboarding** | Blocks every customer WITH HISTORY — the difference between a product for new businesses and a product for businesses | **~2 weeks**: opening-balance journal + an equity landing account, historical AR/AP as NON-ZATCA documents (an `is_opening` flag that skips ICV/issuance), CoA import (already a coming-soon slug), bank opening balances into the GL | The delicate part is historical invoices bypassing the ZATCA chain WITHOUT creating a second issuance path — a design decision inside the build, wants a short design doc first |
