# Phase 13 — Expenses: questions for the accountant

**Status (2026-09-27): ANSWERED and APPLIED (see "Answers" at the end, and
the decision pack §9). Still open: the capitalised-VAT recovery details and
the SAR 1,000 threshold's VAT basis — neither is built on. Current state
authority: [CLAUDE.md §2](../../CLAUDE.md).**

Asked under the [accounting escalation protocol](../accounting-escalation-protocol.md):
each question below is one the Phase 13 research could NOT settle from primary
Saudi sources, IFRS as endorsed by SOCPA, or Odoo and ERPNext source. What the
research DID settle is stated beside each question so it is not re-asked; it is
not a proposed answer. Findings the same research produced that are not
accountant questions are in
[`known-issues-and-audit-findings.md`](../history/known-issues-and-audit-findings.md)
(P13-D1–D3, P13-N1–N3).

**Context.** Phase 13 adds EXPENSES: a purchase already paid when it is
recorded, with no payable left (a BILL is the supplier's document creating a
payable). A receipt may or may not be enough evidence to claim its input VAT.
Settled by the sources, and therefore not asked:

- Input tax may be deducted only while holding the evidence — the Agreement
  Art. 48 documents, or a correctly issued simplified tax invoice (VAT IR
  Art. 49(7)(a), 53(8), 53(11)).
- A deduction may be taken in a later period, but not in a period more than
  five calendar years after the calendar year of the supply (IR Art. 49(8)).
  ZATCA's Input Tax Deduction guideline (2020), Example 26, shows a late
  invoice claimed in the next quarter's return rather than by amending the
  earlier one.
- A simplified tax invoice may be issued to a business only for supplies
  under SAR 1,000 (IR Art. 53(1)(c), Arabic text). Since 4 Dec 2021 a
  deduction needs an e-invoice from a supplier subject to e-invoicing
  (E-Invoicing Detailed Guideline §7.1).
- A credit note on VAT already deducted corrects the input tax in the period
  the note is issued (IR Art. 40(6)).
- Cost includes non-refundable purchase taxes (IAS 16.16(a), IAS 38.27(a))
  and excludes taxes "subsequently recoverable" (IAS 2.11); SOCPA endorses
  these standards without modification.
- Saudi law says nothing about how unclaimed, pending or blocked input VAT is
  BOOKED — only whether it may be deducted.

Until each answer arrives, the running behaviour is the one that makes no
policy choice: **VAT without sufficient evidence is not claimed on the
return**, which IR Art. 49(8) permits. How that VAT sits in the books is
exactly question X1.

---

## X1 — VAT awaiting evidence

- **Why it matters.** It decides the journal entry for every expense or bill
  whose VAT cannot yet be claimed, and the entry when the evidence arrives.
- **Saudi Ledger today.** No such state exists. A posted bill claims its VAT
  in full; the only alternative is to leave the VAT out entirely, and nothing
  then tracks it. A bank line posts gross with no input VAT.
- **Odoo** (18.0 @ `2802e2b`). No pending or awaiting-evidence concept was
  found in `account`, `hr_expense` or `l10n_sa`. An expense posts its taxes
  when its entry is created (`hr_expense/models/hr_expense.py`
  `_prepare_payments_vals`).
- **ERPNext** (version-15 @ `4aee12e`). No pending, unclaimed or
  non-deductible VAT concept anywhere in `erpnext/accounts`.
- **Sources.**
  - The right to deduct "arises when a Deductible Tax is due" (GCC Agreement
    Art. 44(2)), but "cannot be exercised" until the evidence is held (ZATCA
    Input Tax Deduction guideline §9.1, 2020).
  - IFRS does not define "recoverable" (IAS 2.11, 16.16) and does not address
    VAT whose evidence is outstanding, so the treatment is an accounting
    policy (IAS 8.10–11).
  - The nearest official ruling is the IFRIC agenda decision of January 2019:
    a deposit paid on a disputed non-income tax is "an asset, and not a
    possible asset".
  - IAS 37.31–33: a contingent asset is not recognised.
- **Legitimate options.**
  - (a) Hold it in a separate asset account, e.g. "Input VAT awaiting
    evidence", moved to Input VAT when the evidence is held and written off
    to cost if it never is.
  - (b) Include it in the expense, inventory or asset cost until it becomes
    claimable.
- **Engineering default.** None for the books — ACCOUNTANT DECISION REQUIRED.
- **Question.** *If input VAT cannot yet be claimed because the supporting
  evidence is unavailable, should it be held in a separate VAT asset (holding)
  account, or included in the expense, inventory or fixed-asset cost until it
  becomes recoverable? And when it is later recovered, what entry should be
  used — in particular, where the VAT was included in the cost of inventory or
  a fixed asset, does the recovery reduce that cost, or go to profit or loss?*
- **Blocks.** The book entry for VAT awaiting evidence, and its later
  recovery. Evidence capture, the evidence status, and not claiming such VAT
  on the return do not depend on it.

## X2 — A supplier credit note before the VAT was ever claimed

- **Why it matters.** A credit note can arrive while the purchase's VAT is
  still awaiting evidence, and so was never deducted.
- **Saudi Ledger today.** A supplier credit note (B7) reverses input VAT in
  the note's period (Art. 40(6)). It assumes the original VAT was claimed; no
  unclaimed case exists yet.
- **ERPNext.** A purchase debit note reverses the tax on the note's own
  posting date and never edits the original
  (`controllers/sales_and_purchase_return.py`). ERPNext has no unclaimed-VAT
  state for it to meet.
- **Odoo.** Its vendor refund was not read for this question. Odoo has no
  unclaimed-VAT state in the modules that were read.
- **Sources.**
  - IR Art. 40(6) requires the customer to "correct its Input Tax … in the
    Tax Period in which the Credit Note or Debit Note is issued". It is
    silent where nothing was deducted.
  - ZATCA's guidance attaches the duty to a prior deduction: "and has
    previously deducted input tax on that supply, it must correct its Input
    Tax" (Invoicing and Records guideline §7.1.1, 2020; also Input Tax
    Deduction guideline §10.1). That implies — but does not state — that no
    return correction is due.
  - No text addresses a later claim after the note.
- **Engineering default.** None — ACCOUNTANT DECISION REQUIRED.
- **Question.** *If a supplier issues a credit note before the input VAT on
  that purchase was ever claimed, how should the credit note be accounted
  for? Should any VAT-return entry be made for it, and should a later VAT
  claim on that purchase be based on the net VAT after the credit note?*
- **Blocks.** The credit-note path for a purchase whose VAT is awaiting
  evidence. Credit notes on claimed VAT (B7) are unaffected.

## X3 — Non-deductible VAT under Article 50

- **Why it matters.** Expenses are where blocked VAT actually occurs
  (entertainment, hospitality, employee insurance and healthcare, restricted
  vehicles and their fuel and upkeep, personal use — IR Art. 50 as amended
  19/11/2024). Today a bill claims such VAT as if it were deductible.
- **Saudi Ledger today.**
  - A fixed asset with 0 % initial recovery capitalises its VAT into cost
    (`services/assets/capitalisation.service.ts`, `capitaliseVat`).
  - `categories.input_vat_blocked` affects only the bank-line estimate; no
    bill path reads it (known-issues P13-D2).
- **Odoo.** A tax share with no account posts onto the purchase line's own
  account and is excluded from the VAT closing (`account/models/account_tax.py`).
- **ERPNext.** A "Valuation" tax is added to stock or asset value. On an
  invoice with no stock or asset items it is forced back to an ordinary tax
  (`controllers/buying_controller.py` L207–221), so it has no treatment for an
  ordinary expense.
- **Sources.**
  - Art. 50 makes the tax non-deductible; Saudi law does not say how it is
    booked.
  - IAS 2.11, IAS 16.16(a) and IAS 38.27(a) include non-refundable purchase
    taxes in the cost of inventory, fixed assets and intangibles. No standard
    paragraph covers an ordinary expense — the ambiguity this question
    resolves.
- **Engineering default.** None — ACCOUNTANT DECISION REQUIRED.
- **Question.** *For VAT that is non-deductible under Article 50, please
  confirm the accounting treatment for (a) ordinary expenses, (b) inventory
  and (c) fixed assets — in particular, should the non-deductible VAT be
  included in the relevant cost (the expense account, the inventory cost, the
  asset cost)?*
- **Blocks.** Applying the Art. 50 list to bills and expenses. The existing
  fixed-asset capitalisation is not changed by asking.

---

**Not asked here, deliberately** (so their absence is not read as settled):

- Which return box carries a late-claimed input VAT.
- How Art. 50 blocked VAT is reported on the return.

Both presuppose the official ZATCA return layout, which our return does not
yet use (known-issues P13-N1). They are asked once that layout is adopted.

---

## Answers (received 2026-09-26, verified, applied 2026-09-27)

🔴 **The accountant numbered FIVE items; this file asked THREE.** The map, so
an "X3" is never read against the wrong question:

| Accountant | This file | Answer, as applied |
| --- | --- | --- |
| X1 VAT awaiting evidence | X1 | A separate VAT asset while recoverable; cost if not. On evidence: the accountant wrote "debit VAT payable, credit the VAT asset" — in our chart "VAT Payable" is `VAT_OUTPUT` (a liability), so the owner settled it as **Dr `VAT_INPUT` / Cr `VAT_AWAITING_EVIDENCE`**. |
| X2 late claim | not asked (recorded above as settled) | The later return, no prior-period correction, five years from the year of supply — as IR Art. 49(8) says. |
| X3 credit note before the claim | **X2** | Account for the net; claim only the net VAT. |
| X4 simplified invoice | not asked (recorded above as settled) | Valid evidence if correctly issued. The SAR 1,000 figure was not confirmed by the accountant; ZATCA's Tax Invoicing guideline (v3, May 2026) confirms the threshold but not whether it is before or after VAT — the conservative VAT-inclusive reading stays. |
| X5 non-deductible VAT | **X3** | Excluded from input VAT; capitalised into cost — expenses, inventory and fixed assets alike. |

**Still open (not built on):**

- Capitalised-VAT RECOVERY — the accountant's proposal (`Dr VAT_INPUT / Cr
  inventory or asset`; profit or loss once sold or fully depreciated) is
  consistent with IAS 8.37 and IFRIC 1 by analogy, but prospective vs
  catch-up depreciation, the cap at carrying amount and the partly-sold
  inventory split are unconfirmed (decision pack §9.6).
- "Not recoverable" at recording (X1's second arm) is not a separate user
  choice today: a document is held while its evidence is insufficient, and
  blocked only under Art. 50. Writing held VAT off when evidence never
  arrives (after the five-year window) has no entry yet.
- The SAR 1,000 threshold's VAT basis — an advisor or ZATCA question.
- The two return-placement questions below stay with P13-N1.
