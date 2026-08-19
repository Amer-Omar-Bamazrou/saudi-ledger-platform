# Transaction-path accounting — design (M16, APPROVED)

**Status: DECIDED by the owner, 2026-08-12.** Every question below carries its
decision. Approved build order:

1. ✅ **M16.1 — Q0's source switch** (the live filing risk): `VatReport.tsx` files
   from `reports.vat-return`; the transaction figure becomes the reconciliation
   view beside it, gap itemised. Built as a feature, not hidden — an SME seeing
   undocumented cash activity before filing is the product working. **Merged
   (PR #25).**
2. ✅ *(The holding area is already in — M15 item 8.)*
3. ✅ **M16.2 — S/Z/E/O (reconcile-grade) + `kind` (transfers) + `bank_account_id`**
   with the account picker on statement upload. Took verification-pass finding
   #6 first, as TWO fixes per the owner's instruction: the `kind: transfer`
   exclusion AND the rule itself (fee-words now required — a bank or gateway
   name says who processed a movement, not what it was; the exclusion must not
   paper over a bad match). Treatment notes: BANK_CHARGES defaults **'S'**, not
   the 'E' this doc's illustration guessed — explicit bank fees are
   standard-rated in KSA; INSURANCE likewise 'S' (general insurance is
   standard-rated; life-exempt is a per-row override), correcting 0029's
   `vat_applicable=false`.
4. ✅ **M16.3 — bank reconciliation** (matching suggestions → existing pay
   paths). Built as designed: exact-match only (number-in-description, or
   amount equal to exactly ONE open document's outstanding); Q3a suggestions
   never auto-applied; Q3b description-referenced partials suggested,
   amount-only partials never; acceptance routes through
   `invoicesService.pay` / `billsService.pay` (no parallel posting path);
   `kind: settlement` + `settles_invoice_id`/`settles_bill_id` links.
   Two additions found necessary during the build: (a) the M15 review surface
   had **no UI consumer** (a shape without a consumer — the endpoints existed,
   nothing rendered them), so the `/review` page ships here; (b) the pay paths
   gained real **partial-payment semantics** — payments accumulate, "paid"
   means fully paid, overpay is a 409 — because pre-M16.3 any payment amount
   flipped the document to `paid`, which would have made a partial settlement
   vanish from AR aging while balance-sheet AR kept the residual.
   **Live verification pass (2026-08-14, real HTTP → engine → Postgres,
   observed values):** clean org; invoice INV-LIVE-M163 issued for 3,450
   (3,000 + 450 VAT) → VAT return netVatDue **450**, AR aging **3,450**,
   income **0**, cash flow **0**. Uploaded credit "INCOMING SWIFT ALMARAI REF
   INV-LIVE-M163" 3,450 → review surface suggested invoice 5040
   (matchedBy=number, partial=false) and changed nothing. After one settle
   call: income **0** (the receipt never became revenue — the M15 double-count
   is dead), VAT summary **0**, VAT return netVatDue **450** (unchanged),
   cash flow **3,450**, AR aging **0**, invoice `paid`/3,450, GL entry
   `GL-INV-LIVE-M163-PAY` posted by the existing pay path, row
   `kind=settlement` linked to the invoice.

**Standing step (owner-mandated):** every M16 milestone ends with a re-run of
the LIVE verification pass — same fixture, real HTTP path, observed values.
Tests verified the M15 VAT arithmetic while the live path still produced a
phantom tax figure through a different rule; only observation catches the
composed behaviour.

## Principle recorded at approval: ACCEPTING THE MATCH IS THE REVIEW

One act — the user confirms "this settles INV-0412" — simultaneously accepts the
row out of the holding area and records the payment. **Two confirmations of one
fact is ceremony, and ceremony is what makes people click through review
surfaces without reading.** Wherever a review surface grows a second nested
confirmation of the same fact, that is a design defect, not extra safety.

---

## 0. 🔴 The finding that reframes all three: the product has TWO VAT numbers, and the UI shows the weaker one

Found while preparing this design, and it changes what "S/Z/E/O on transactions"
should even mean.

| Source | Computed from | Treatment-aware? | UI consumer |
| --- | --- | --- | --- |
| `reports.vatReturn` | **invoices + bills** — the legal documents, S/Z/E/O per line (M12.1a), credit-note signs (M12.1b), box-structured (box 1–15) | ✅ | **NONE** — routed at `/reports/vat-return`, consumed by no page |
| `summary.getVat` | **transactions** — a boolean `vatApplicable`, no treatment concept | ❌ | **The page literally named "VAT Report"** (`VatReport.tsx`) |

**The carefully-built correct source is unreachable from the UI; the weak source
is what users see.** The narrower-claim family again — `VatReport.tsx` reads as
"the VAT return" and is actually "VAT guessed from bank lines."

### The decision this forces (Q0, load-bearing for everything below)

**Which source files the VAT return?**

**Recommendation: invoices and bills file; transactions reconcile.** The
invoice/bill side is the set of legal documents — ZATCA-validated, S/Z/E/O-aware,
credit-note-correct. The transaction side is *cash evidence* of those documents
plus cash-only activity. The right relationship is:

- `VatReport.tsx` switches to `reports.vatReturn` — the filing view.
- The transaction-derived figure becomes a **reconciliation view**: "VAT
  according to your bank activity" beside "VAT according to your documents",
  with the gap itemised. A gap is not an error — it is undocumented cash
  activity, which is exactly what an SME needs shown to them before filing.

If you disagree — if the transaction side should be capable of *filing* — the
S/Z/E/O design below gets substantially heavier, because it must then reach the
same standard as invoice lines (exemption reason codes included).

---

## 1. S/Z/E/O on the transaction path

Under the recommendation above, transactions need treatment awareness for
**reconciliation and correctness**, not for filing. That is a materially smaller
design:

- **`tax_treatment` column** on `transactions`: `S | Z | E | O | null`, where
  null means *unknown* — first-class, per M15's "the engine can say I don't
  know".
- **Default flows from the category.** The template gains
  `default_tax_treatment`: `BANK_CHARGES → E`, `GOVT_FEES → O`, `TELECOM → S`,
  `SALARIES → O`, etc. The categorizer emits it; the review surface can override
  per row (the export-sale case: category "Sales Revenue" defaults S, the row is
  overridden Z).
- **VAT extraction only happens for S.** Today `vatApplicable=false` conflates
  "exempt", "zero-rated", "out of scope" and "don't know" — four different
  facts. Z/E/O rows carry zero VAT *and say why*, which is what the
  reconciliation view needs (a zero-rated export belongs in the comparison
  against box 2, not in "no VAT information").
- **What this does NOT include:** exemption reason codes (VATEX-…) on
  transactions. Those are invoice-line facts required by ZATCA on documents;
  a bank line never needs one under the reconcile-only model.

**Q1:** Approve the reconcile-only scope? (The alternative — filing-grade
transactions — needs reason codes, per-row treatment mandatory rather than
defaulted, and a migration of `VatReport` semantics.)

### 🔴 Treatment defaults: verification status (recorded at M16.2)

The defaults sketched above were written as **design illustrations, not
verified tax positions** — and one was wrong: `BANK_CHARGES → E` above is
**incorrect**. It shipped as **'S'** (migration `0031`): explicit bank fees are
standard-rated in KSA per ZATCA's financial-services guideline; only
implicit-margin products are exempt. `INSURANCE` was likewise corrected to
'S' (general insurance is standard-rated; life insurance is exempt and is a
per-row override), which also corrected 0029's `vat_applicable = false`.

Because two illustrations were wrong, the rest must not be read as verified.
Status of the seeded map, category by category:

- **Checked against actual KSA rules** (looked up because they were suspected
  wrong): `BANK_CHARGES → S`, `INSURANCE → S`. Only these two were verified to
  that standard.
- **Reasoned from VAT-law categories, not individually researched:** the 'O'
  group (`SALARIES`, `GOSI_EXPENSE`, `GOVT_FEES`, `ZAKAT_PAYMENT`,
  `VAT_PAYMENT`, `LOANS`, `GOVT_GRANTS`, `CASH`/`AR`/`AP` — not consideration
  for a supply) and the 'E' group (`INVESTMENT_INCOME`, `INVESTMENTS` — exempt
  financial services).
- **Illustrative majority-default, NOT verified per category:** every remaining
  'S'. 'S' is the correct default for most supplies, but known per-row
  divergences exist and are handled as row overrides, e.g. `RENTAL_INCOME`:
  residential rent is **exempt** in KSA (commercial is 'S');
  `FUEL_TRANSPORT`: international transport is zero-rated; `SALES`: exports
  are zero-rated.

Treat any default outside the first bullet as unverified until it has been
checked the way `BANK_CHARGES` was. The blast radius is bounded by design:
these are **reconcile-grade only** — the filing return reads invoices and
bills and never consults this map.

**M16.3.1 (owner decision at the M16.3 close-out): the distinction is now
DATA, not only documentation.** `treatment_verified` on
`system_account_templates`/`categories` (migration 0033) is true ONLY for the
two checked categories; a row whose treatment came from an unverified default
surfaces in the review UI as **"assumed"**, with a per-row override
(`PATCH /transactions/:id { taxTreatment }` — non-'S' clears the VAT, 'S'
extracts it from gross). Flipping `treatment_verified` records an actual rule
lookup, never a side effect.

> ✏️ **C9 SUBSTANTIALLY CLOSED (2026-08-19).** 17 treatments verified against
> the official VAT Implementing Regulations, read page by page — per-article
> citations, the remaining assumed set with what-would-settle-each, and the
> new **`input_vat_blocked` third axis** (Art. 50; the FOOD_MEALS live wrong
> default) are all in
> [`docs/tax/vat-treatment-verification.md`](../tax/vat-treatment-verification.md).

---

## 2. Transfers as a class

The ATM-withdrawal-as-expense error is structural: the model has no concept of
money moving *between the business's own accounts*. Design:

- **`kind` on transactions**: `operating | transfer | settlement` (settlement is
  §3's). A `transfer` row is **excluded from income, expense, VAT, Zakat and
  budget aggregates entirely** — it is an asset movement, invisible to P&L-type
  figures by construction, enforced in the same repositories that carry
  `acceptedOnly()`.
- The categorizer emits `kind: transfer` for ATM withdrawals, own-account
  transfers, credit-card settlements — patterns it already recognises but
  currently books as expenses with invented VAT.

### 🔴 The blocker found while designing this: transactions have no account

**Correction (M16.2, my error — finding #7's shape):** this section originally
called `bank_accounts` "one of the no-consumer S6/S7 family". **Wrong** —
`bank_accounts` is a full domain (routes, service, repository, permission
entry, RLS, a `/bank-accounts` UI page). I asserted absence without covering
the shapes it could take; the standing check's part 5 exists for exactly this.
The REAL gap stands: **nothing linked transactions to it.** Consequences:
transfer *pairing* (out of A, into B = one movement) is impossible; a
multi-account SME cannot reconcile per account; and duplicate detection scoped
to the whole org rather than to the account a statement belongs to.

**Recommendation: add `bank_account_id` now, and make statement import ask
"which account is this statement for?"** One picker on the upload page. This is
also foundation A2 needs regardless — a bank feed is *per account* by nature —
and it gives `bank_accounts` its first consumer.

**Q2:** Approve `kind` + `bank_account_id` + the import-time account picker?
(Transfer *pairing* — auto-matching the two legs — can be v2; v1 is correct
classification and exclusion.)

---

## 3. Bank reconciliation — "this credit settles an existing receivable"

The absent concept, and the deepest of the three. The M15 run booked a
SAR 34,500 customer payment as income; the truth is that the income was already
recognised when the invoice was issued, and this credit *settles* it. Booking it
again double-counts revenue.

### Proposed shape

- **Matching produces SUGGESTIONS in the review surface, never actions.** For a
  pending credit: find open invoices where (a) the invoice number appears in the
  description, or (b) the amount exactly equals one invoice's outstanding
  balance and that match is *unique*. Symmetrically for debits against open
  bills. **v1 is exact-match only** — no fuzzy matching, no ML. Unmatched rows
  stay plain transactions.
- **Accepting a match routes through the EXISTING pay path** —
  `invoicesService.pay` / `billsService.pay`, which already post Dr Cash / Cr AR
  through M13's chart. **No parallel posting path** (the A3/M15 rule: one
  writer per effect). The transaction is marked `kind: settlement`, excluded
  from income/expense aggregates, and linked to the document it settled
  (`settles_invoice_id` / `settles_bill_id`) — so "where did this payment go?"
  is answerable from either side.
- **Accepting the match IS the review.** One act: the user confirms "this
  settles INV-0412", which simultaneously accepts the row out of the holding
  area and records the payment. Two separate confirmations of the same fact
  would be ceremony.
- **"AI proposes, it never posts" applies verbatim.** However good a match
  looks — exact invoice number, exact amount — it is never auto-applied. The
  suggestion is pre-selected in the UI; the human clicks.

**Q3a:** Approve suggestions-never-auto, even for exact invoice-number matches?
(The tempting exception — auto-apply when the invoice number is in the
description — is exactly the consent-to-a-pattern trap from A3.)

**Q3b:** Partial payments in v1? An amount that is *less* than the outstanding
balance with an invoice number in the description is a safe partial-payment
suggestion; amount-only partial matching is guesswork. Recommendation:
description-referenced partials yes, amount-only partials no.

---

## Deliberately out of this design

- **WHT, owner's drawings, EOSB accrual** — real gaps, but they are *category
  and treatment* additions once §1 exists, not design problems. Listed for the
  backlog.
- **Transfer-leg auto-pairing** — v2, needs `bank_account_id` populated first.
- **Anything the real bank export changes.** The owner is obtaining one; the
  unmatched-merchant rate it reveals decides whether rule-based categorisation
  needs the parked AI layer, and its column layout may adjust §2's import
  picker.

## The questions — ALL DECIDED (owner, 2026-08-12)

| # | Question | Decision |
| --- | --- | --- |
| **Q0** | Which source files the VAT return? | ✅ Invoices/bills file; transactions reconcile. `VatReport.tsx` switched to `reports.vatReturn` (M16.1). The transaction figure stays visible as the reconciliation view — not hidden. |
| **Q1** | S/Z/E/O scope on transactions | ✅ Reconcile-grade. No VATEX reason codes on bank lines (document facts). `null` = unknown, first-class. |
| **Q2** | Transfers | ✅ `kind` column + `bank_account_id` + import-time account picker. Duplicate detection scopes to the statement's account. Leg-pairing is v2. |
| **Q3a** | Reconciliation matches | ✅ Suggestions only, never auto-applied — no exceptions, including exact invoice-number matches. Acceptance routes through the EXISTING pay paths; it must never become a second way money reaches the ledger. |
| **Q3b** | Partial payments | ✅ Description-referenced yes; amount-only no. |
