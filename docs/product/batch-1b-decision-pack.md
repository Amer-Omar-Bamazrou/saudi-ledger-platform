# Batch 1B decision pack — D-4 payments, credits, allocation, matching, migration (2026-09-17)

**Status (2026-09-17): IMPLEMENTED — Batch 1B (Parts 1–2, Phases A–F, UI included) is built and browser-validated; the as-built record is the known-issues file, "BATCH 1B — CLOSED 2026-09-17". The research below is the decision record and is not re-argued. Current state authority: [CLAUDE.md §2](../../CLAUDE.md).**

Reads first: [`d3-cash-policy-research-2026-09-17.md`](d3-cash-policy-research-2026-09-17.md) (settled; not reopened here), [`accounting-architecture-decision-pack.md`](accounting-architecture-decision-pack.md) §D-4, [`design-per-bank-cash.md`](design-per-bank-cash.md).

**Settled by D-3 and referenced, never re-argued:** annotation over rewrite; posted-line immutability; the historical override concept and its evidence model; *bank unidentified* as a first-class state; no reclassification needed for reporting; cut-over date semantics; cash-on-hand as a cash leaf that is not a bank; **bank identity ≠ payment identity**; transfers; `pairOneToOne` as the anti-guessing pairing. Batch 1B proceeds under D-3's four conditions: (1) bank identity is read only through `journal_line_bank_identity`; (2) *bank unidentified* is a first-class state; (3) `pairOneToOne` is reused for statement ↔ payment; (4) D-4 never writes `cash_line_bank_attributions`. Nothing below invalidates them.

**Settled by the accountant and not reopened:** an unapplied customer receipt is a customer-deposit **liability**, not a credit balance inside AR (IFRS 15 contract liability); carrying a credit forward is the norm and a refund is the exception that *settles the existing credit* rather than reversing the original transaction; Opening Balance Equity may be used temporarily and must be cleared, the clearing treatment being accounting policy; the opening migration needs a three-way reconciliation (imported balances = posted opening journal = ledger read-back).

**Classification labels used on every conclusion:** `VERIFIED ACCOUNTING FACT` · `SAUDI / ZATCA REQUIREMENT` · `ACCOUNTING POLICY` · `ENGINEERING JUDGEMENT` · `PRODUCT DESIGN PRACTICE` · `NEEDS ACCOUNTANT CONFIRMATION`. Where nothing authoritative answers: `No authoritative source located.` ERP behaviour is evidence of practice, never of requirement.

---

## 8 → Decision matrix (first, as requested)

| Decision | What it blocks | Research conclusion | Classification | Recommendation | Accountant confirmation |
| --- | --- | --- | --- | --- | --- |
| **Credit-note balance account treatment** | The credit model, customer statements, ageing, the refund operation | A Saudi credit note always references a tax invoice (VAT IR Art. 54(4)); its effect depends on that invoice's state: unpaid → it reduces the receivable for that invoice (contra-AR, applied at issue); paid → the entity now owes the customer (IFRS 15.55 refund liability, or a credit consumed against future supplies). Deposits/unapplied receipts are contract liabilities (settled). Two liability natures exist (contract liability vs refund liability); IFRS governs presentation, not GL accounts. | VERIFIED ACCOUNTING FACT (natures) · ACCOUNTING POLICY (how many GL accounts) | **Model C**: contra-AR when the credit note settles an open invoice; liability otherwise. **Two liability accounts** — *Customer deposits & advances* (contract liability) and *Customer credit balances* (refund liability) — presented under one "Amounts due to customers" caption unless material. | **Yes, narrow:** one liability account or two (default: two). |
| **Refund model** | The refund workflow, VAT documents on refund, bank matching of money-out | Accounting: a refund debits the credit's own liability (or contra-AR) and credits the bank leaf; VAT depends on origin — a deposit that was tax-invoiced needs a credit note before/with the refund (Art. 40(1)(a), 54(1)); a credit-note balance already carries its VAT adjustment; an erroneous overpayment never invoiced has no VAT document. | VERIFIED ACCOUNTING FACT · SAUDI / ZATCA REQUIREMENT (VAT documents) | **One controlled operation, "Refund customer credit"**, taking a credit of any origin; origin-aware preconditions (tax-invoiced deposit → credit note first); approval through the existing engine; bank leaf required; matched to the statement by `pairOneToOne`. | No (form settled); the *approval role* is the entity's control choice. |
| **Payment matching evidence** | Bank reconciliation, the D-4 backfill, D-3's A2 evidence | No product auto-establishes on amount alone; QuickBooks suggests on amount within a date window and the user confirms; Odoo auto-validates only when a rule's conditions (label/reference + partner + amount) are "perfectly met"; Xero suggests and asks for OK. The only evidence that *identifies* is an identifying reference resolving to exactly one document/payment; amount, date and bank partition candidates but never identify. | PRODUCT DESIGN PRACTICE (products) · ENGINEERING JUDGEMENT (our rule) | **DETERMINISTIC** = same bank identity ∧ same direction ∧ exact amount ∧ identifying reference resolving to exactly one payment/document ∧ date within a fixed window ∧ `pairOneToOne` unique. Everything else AMBIGUOUS / UNMATCHABLE / INCONSISTENT (§3). Even DETERMINISTIC is *pre-selected, the human clicks* in the live UI (CLAUDE.md §9); only the historical backfill acts on DETERMINISTIC without a click, as D-3's cut-over does. | No. |
| **Payment identity** | The payment entity, statements, AR/AP | A payment is an economic event: party, direction, date, amount, method, bank identity, reference — independent of which documents it settles. IFRS 15/IAS 32 treat the receivable and the cash separately; every product studied models the payment as its own document. | VERIFIED ACCOUNTING FACT (separate event) · PRODUCT DESIGN PRACTICE | One `payment` entity per cash event, in both directions, carrying bank identity (leaf) and party; never inferred from a statement row's amount or from a document. | No. |
| **Allocation identity** | Ageing, statements, partial/over-payments, credit application | An allocation is a link *payment (or credit) → document, amount*. Partial payments are several allocations to one document; one receipt over several invoices is several allocations from one payment; the unallocated remainder is the credit. | VERIFIED ACCOUNTING FACT · PRODUCT DESIGN PRACTICE | Allocations are explicit, append-only, human-confirmed, never inferred; a payment with no allocation is a deposit/unapplied credit (liability). | No; *allocation order* when several credits exist is policy (default: the user chooses, oldest pre-selected). |
| **Migration workflow** | Onboarding any customer with history (G2) | Every system studied: conversion date; trial balance as at the day before; balance-sheet accounts only; AR/AP entered as individual open items so future allocations and ageing work; bank openings per bank; a balancing equity account; validation that the control account equals the open items; period lock before the conversion date. | PRODUCT DESIGN PRACTICE · VERIFIED ACCOUNTING FACT (BS-only opening; equity balance) | Six-step workflow (§5): conversion date → opening journal (BS accounts, balanced to OBE) → open items (AR/AP, no VAT, **no e-invoice**) → per-bank openings → three-way reconciliation → OBE clearing journal + lock. | Clearing treatment is theirs (settled as policy); **new:** confirm that opening AR/AP items are recorded as *open items without tax invoices* (no ICV, no ZATCA chain). |
| **Opening balance equity** | Migration close-out | Temporary, must clear to zero; cleared by a dated journal to retained earnings / owner's equity — the target is policy. | ACCOUNTING POLICY (settled) | A system account *Opening Balance Equity* (equity, non-posting except by the opening and clearing paths), a "not yet cleared" state visible on the balance sheet, clearing by one dated journal. | Already with the accountant (target account). |

---

## Sources

| # | Source | Read as | Used for |
| --- | --- | --- | --- |
| S1 | **ZATCA VAT Implementing Regulations**, 8th ed. 04/04/1443H (09/11/2021), English (unofficial; Arabic prevails) — Art. 20 (date of supply in specific circumstances), Art. 40 (adjustment to value of a supply), Art. 54 (credit and debit notes), Art. 66 (records) | Primary (translation), articles read in full | Credit notes must reference the original tax invoice (54(4)); a credit note is required when the tax charged exceeds the true value after cancellation/return/price change (40(1), 54(1)); output-tax decrease taken in the later of the event period and the credit-note period (40(5)); records corroborated and tamper-controlled (66) |
| S2 | **GCC Unified VAT Agreement Art. 23 / KSA VAT Law** — tax due date is the earliest of supply, tax invoice, or receipt of consideration in full or part *to the extent received* — via ClearTax "Time of supply under VAT in KSA" (secondary, quoting the Agreement) | Secondary; the Agreement text is well known | An advance received for a taxable supply triggers VAT to the extent received and a tax invoice for that portion |
| S3 | **IFRS 15** *Revenue from Contracts with Customers* — ¶55 (refund liability), ¶105–109 (contract liability / receivable presentation); **IAS 32** ¶42 (offsetting); **IAS 1** ¶29–32, 54, 55 (line items, no offsetting); **IFRS for SMEs** (3rd ed. Feb 2025; Section 23 revenue as revised, Section 4) | Standards as issued; paragraph numbers from the standards (SME section numbering to be checked against the current edition) | Contract liability vs refund liability; receivable and contract liability presented separately; no offsetting of assets and liabilities absent a right of set-off |
| S4 | **ERPNext v15** — Frappe blog "V15 updates for ERPNext" (1 Dec 2023); docs "Advance In Separate Party Account", "Advance Payment Entry", "Banking in ERPNext"; GitHub issue #34282 "Record advance payment as a liability" | Primary product documentation (summaries) | Default: advances sit in the receivable account as negative balances; v15 option books customer advances to a liability account, only through Payment Entry; allocation reclassifies on invoice; Payment Reconciliation tool allocates advances/credit notes; matching on amount, date, party, reference |
| S5 | **Odoo 17** — *Bank and cash accounts*; *Reconciliation models* | Primary product documentation | Outstanding receipts/payments; three model types; "auto-validate" only when conditions are perfectly met; invoice matching on reference (label) + partner |
| S6 | **Xero** — Xero Central "Bank reconciliation in Xero"; "Prepayments vs Overpayments" (Fuel Accountants comparison of Xero's own behaviour); "Manually adjust a bank account balance"; "Enter conversion balances"; "Understand a historical adjustment balance" | Secondary (Xero Central is a JS shell; summaries and a practitioner table of Xero's documented behaviour) | Overpayment always to Accounts Receivable, no tax until applied; prepayment to a chosen account with tax on a cash basis; refunds only via "Make a cash refund" on the credit itself; suggested matches confirmed with OK; conversion balances, per-invoice opening items, historical adjustment, lock date |
| S7 | **QuickBooks Online** — Intuit help "Match online bank transactions"; "Managing your Undeposited Funds account"; community/help on Opening Balance Equity | Secondary (Intuit help summaries) | Matches suggested on amount within −90/+20 days, user confirms; automatic matching only for QuickBooks' own payments/payroll; Undeposited Funds; OBE must end at zero and is closed to retained earnings/owner's equity |
| S8 | **ISA 500** A31 (reliability of evidence), **ISA 240** ¶33 (journal entries and other adjustments) — extant | Secondary confirmation of known text | Evidence hierarchy for matching and refunds |
| S9 | D-3 research pack (this repo), for everything it settled | Primary (internal) | Bank identity, attribution, pairing |

`No authoritative source located.` for: (a) a Saudi rule on whether a *refundable security deposit* (not consideration) triggers VAT on receipt — the KSA Implementing Regulations, unlike the UAE law, contain no deposit article; (b) any SOCPA or ZATCA guidance on the GL structure for customer credits; (c) any authoritative statement of a *date tolerance* for bank matching — every tolerance is a product choice.

---

## 1. Customer credit positions

### 1.1 The three positions, distinguished

| Position | What it is | Origin | Nature | VAT event? |
| --- | --- | --- | --- | --- |
| **A. Unapplied customer receipt** | Cash received from a customer with no document identified | A receipt with zero allocations | Liability (settled: customer deposit; IFRS 15 contract liability *if* it is consideration for a future supply) | **If it is consideration for a taxable supply: yes, on receipt, to the extent received** (S2) — a tax invoice for the advance is due. If it is an error (double payment) or a refundable security deposit: no supply, no VAT — but see the gap in *Sources*. |
| **B. Customer deposit / advance** | Cash received against an agreed future supply | A receipt allocated to an order/quotation/contract, or explicitly recorded as an advance | Contract liability (IFRS 15.106) | Yes — S2; the advance is invoiced (tax invoice), and the final invoice deducts the prepayment |
| **C. Credit-note balance** | The customer's entitlement created by a credit note that has not been consumed | A credit note (Art. 54) referencing a tax invoice | Depends on the referenced invoice: unpaid → reduces that receivable (contra-AR); paid → refund liability (IFRS 15.55) or a credit to be consumed | The VAT was adjusted **by the credit note itself** (Art. 40(3), 40(5)); applying or refunding the balance later is VAT-neutral |

A and B are the same position with different knowledge: B is A once the supply is known. That is why the accountant's ruling ("unapplied receipt = customer deposit liability") holds for both, and why the product must push A toward B or toward an allocation within the tax period (§1.6). `VERIFIED ACCOUNTING FACT` for the natures; `SAUDI / ZATCA REQUIREMENT` for the VAT timing.

### 1.2 The unresolved question: one liability account, separate accounts, liability + contra-AR, or another model

**Research.** IFRS says what the *positions* are and how they are *presented* (contract liabilities and receivables presented separately, IFRS 15.105; no offsetting, IAS 1.32 / IAS 32.42; separate line items when material, IAS 1.29), not how many GL accounts hold them. Practice diverges: ERPNext's default keeps advances *inside* the receivable account as negative balances and offers a separate liability account from v15 (S4); Xero puts overpayments in AR and prepayments in a chosen liability account (S6); QuickBooks keeps unapplied payments and credit memos in AR (S7); Odoo holds unreconciled payments on outstanding accounts and then on the partner's receivable (S5). None of those is authority, and two of them (AR-credit) are exactly what the accountant excluded.

**Conclusion — Model C (liability + contra-AR depending on origin), with two liability accounts.**

- **Credit note referencing an unpaid invoice:** it is an adjustment of *that* supply (Art. 54 requires the reference), so it settles that receivable — contra-AR by construction, applied to the invoice at issue. Not a liability, not a free credit. `VERIFIED ACCOUNTING FACT`.
- **Credit note referencing a paid invoice (or exceeding the unpaid remainder):** the customer has paid for value the entity now acknowledges it did not deliver; the entity owes the customer. That is a **refund liability** (IFRS 15.55) if it will be refunded, and economically a customer credit if it will be consumed. `VERIFIED ACCOUNTING FACT`.
- **Deposit / unapplied receipt:** a **contract liability** (settled).
- **Why two liability accounts rather than one:** the two liabilities have different natures (an obligation to *perform* vs an obligation to *repay*), different VAT states (a deposit is tax-invoiced; a credit-note balance is already tax-adjusted) and different exits (a deposit exits by allocation to the supply's invoice; a credit-note balance exits by application or refund). One account would need the origin recovered from sub-records for every VAT and presentation question. Both can be presented under one caption (*Amounts due to customers*) unless material. `ACCOUNTING POLICY` — recommended, and the one narrow point to confirm.
- **Why not "another model":** Xero's overpayment-in-AR is excluded by the accountant; Odoo's outstanding accounts solve a different problem (the gap between a registered payment and the statement, which D-3 solves with bank identity + matching, not with a transitory account).

### 1.3 Journal examples (SAR; VAT 15%; amounts as the customer paid them)

Accounts: *Bank — Riyad Main* (the bank's leaf, D-3); *AR — Customer X*; *Customer deposits & advances* (liability); *Customer credit balances* (liability); *Output VAT*; *Revenue*.

**(1) Customer pays SAR 5,000; no invoice identified.**
```
Dr Bank — Riyad Main                    5,000.00
    Cr Customer deposits & advances                5,000.00
```
Recorded as a receipt with zero allocations — position A. **VAT:** if the 5,000 is consideration for a taxable supply, tax is due on receipt to the extent received (S2): the platform must obtain a classification before the tax period closes — *advance for supply S* (issue an advance tax invoice: 4,347.83 + 652.17 VAT, and move the VAT: Dr Customer deposits 652.17 / Cr Output VAT 652.17), *erroneous/duplicate payment* (no VAT; refund or hold), or *refundable security deposit* (no supply — but `No authoritative source located.` for KSA; ask). Until classified it sits on the VAT-return exception list (§1.6). `SAUDI / ZATCA REQUIREMENT` (timing) · `NEEDS ACCOUNTANT CONFIRMATION` (the security-deposit case).

**(2) The deposit is later allocated to a SAR 3,000 invoice.**
```
Dr Customer deposits & advances         3,000.00
    Cr AR — Customer X (INV-…)                     3,000.00
```
Remainder 2,000 stays a deposit. **VAT:** if an advance tax invoice was issued for the 5,000, the 3,000 invoice is issued *net of the prepayment* (the final tax invoice shows the prepaid amount deducted — the e-invoicing standard's prepayment fields; verify the current XML Implementation Standard before building), and no VAT moves at allocation. If no advance invoice was issued (because the supply was unknown), the 3,000 invoice carries its own VAT and the advance-invoice question in (1) was answered late — a compliance gap the product must surface, not hide. `SAUDI / ZATCA REQUIREMENT`.

**(3) Customer pays SAR 6,000 against a SAR 5,000 invoice.**
```
Dr Bank — Riyad Main                    6,000.00
    Cr AR — Customer X (INV-…)                     5,000.00
    Cr Customer deposits & advances                1,000.00
```
One receipt of 6,000; one allocation of 5,000; unallocated remainder 1,000 = position A. **VAT:** the 1,000 is not consideration for any supply unless the customer intends a further supply; an overpayment by error is not a taxable event — but the same classification duty as (1) applies. `VERIFIED ACCOUNTING FACT` (split) · `NEEDS ACCOUNTANT CONFIRMATION` (error-overpayment boundary; recommended default: no VAT until applied).

**(4) Credit note SAR 2,000 issued (against INV-A, 2,000 incl. VAT).**
If INV-A is unpaid (≥ 2,000 open):
```
Dr Revenue                              1,739.13
Dr Output VAT                             260.87
    Cr AR — Customer X (INV-A)                     2,000.00
```
If INV-A is fully paid:
```
Dr Revenue                              1,739.13
Dr Output VAT                             260.87
    Cr Customer credit balances                    2,000.00
```
If partly paid, the credit note splits: contra-AR up to the open remainder, the rest to *Customer credit balances*. **VAT:** the output-tax decrease is taken in the later of the event's period and the credit note's period (Art. 40(5)); the credit note references INV-A (Art. 54(4)) and, for an onboarded company, goes through the e-invoicing chain like any credit note. `VERIFIED ACCOUNTING FACT` · `SAUDI / ZATCA REQUIREMENT`.

**(5) The credit-note balance is later applied to INV-B.**
```
Dr Customer credit balances             2,000.00
    Cr AR — Customer X (INV-B)                     2,000.00
```
No VAT — adjusted in (4). An allocation of a *credit* (not a payment) to a document. `VERIFIED ACCOUNTING FACT`.

**(6) The customer has both a deposit (2,000 from (2)) and a credit-note balance (2,000 from (4)).**
Two liability balances, both shown on the statement, neither offset against the other automatically (they have different natures and VAT states). When INV-C for 3,000 arrives, the user allocates — the platform pre-selects, the user clicks. **Allocation order** (deposit first? credit note first? oldest first?) is not decided by any source: `ACCOUNTING POLICY` — default: the user chooses per allocation, the oldest credit pre-selected; never automatic.

### 1.4 Presentation, ageing, statements, VAT, audit trail, allocation — requirement vs design

| Aspect | ACCOUNTING REQUIREMENT | PRODUCT DESIGN |
| --- | --- | --- |
| Balance sheet | Receivables (asset) and amounts due to customers (liability) presented separately; no netting (IAS 1.32, IFRS 15.105); one liability caption acceptable unless material | Two GL accounts under one caption; the customer-level split visible in the statement, not the balance sheet |
| AR ageing | Ageing is of *receivables*; a liability is not in it. A credit note applied to an open invoice reduces that invoice's aged amount from the credit note's date | Show a separate "credits available" column/total per customer beneath the ageing, so the *net exposure* is visible without corrupting the ageing buckets |
| Customer statement | Must show the invoices, the credit notes with their references, the receipts, the allocations, and the closing position in both directions | One statement with running balance; deposits and credit balances shown as distinct lines with their origin; refunds shown as settling the credit |
| VAT | S2 timing for advances; Art. 54 reference and Art. 40(5) period for credit notes; the VAT return reads documents, never allocations (CLAUDE.md: documents FILE, transactions RECONCILE) | An "unclassified receipts" exception list on the VAT return page for position A rows older than the tax period; the advance tax invoice is a document the user issues, never auto-issued |
| Audit trail | Every allocation, application and refund is a dated, attributable record; corrections are new records (Commercial Books IR — D-3 pack S2) | Append-only allocations with reversal-by-new-record; the existing `audit_logs` actions |
| Allocation behaviour | A credit note settles the invoice it references first (Art. 54 makes the reference part of the document) | Everything else is a pre-selected suggestion the human confirms; never auto-apply (CLAUDE.md §9) |

---

## 2. Refunds

### 2.1 Treatment by origin

The accountant settled that a refund *settles the existing credit*. The research adds what document and what VAT effect each origin carries.

| Origin | Journal | Supporting evidence | VAT document | Bank side |
| --- | --- | --- | --- | --- |
| **A. Customer deposit (tax-invoiced advance)** | Dr *Customer deposits & advances* / Cr *Bank leaf* | Customer's refund request or the cancelled order; bank details; approval | **Credit note referencing the advance tax invoice**, because the supply is cancelled and tax was charged (Art. 40(1)(a), 54(1)); output VAT adjusted in the later period (40(5)) — the deposit's VAT portion returns from *Output VAT* | A money-out payment to the customer, matched to the statement debit row by `pairOneToOne` |
| **B. Unapplied receipt (never invoiced)** | same journal | Evidence that it was not consideration (duplicate/erroneous payment) | None — no tax invoice was issued and no supply occurred. If it *was* an advance that should have been invoiced, it is case A and the compliance gap is surfaced | same |
| **C. Credit-note balance** | Dr *Customer credit balances* / Cr *Bank leaf* | The credit note itself (already issued) | None further — the credit note carried the adjustment | same |
| **D. Overpayment** (the unallocated remainder of a receipt) | as B | as B | as B | same |

`VERIFIED ACCOUNTING FACT` (journals) · `SAUDI / ZATCA REQUIREMENT` (the credit note in A). Products agree on the shape: Xero refunds only from the credit ("Make a cash refund" on the overpayment/prepayment itself, S6); ERPNext refunds through a Payment Entry referencing the credit note/advance (S4); Odoo registers an outbound payment against the credit note (S5). `PRODUCT DESIGN PRACTICE`.

### 2.2 Approval, audit, statements, ageing

- **Approval:** a refund is a cash outflow to a third party — the same risk class as a bill payment. No source mandates a second approver for a small entity; the platform's approval engine already exists for drafts. Recommendation: refunds are drafts approved by whoever holds the pay permission, with the approval engine's second-person gate available per company. `PRODUCT DESIGN PRACTICE`; who approves at the pilot is the entity's control choice.
- **Audit:** the refund is a payment record with direction *out*, party = customer, allocation target = the credit; it appears in ISA 240's "other adjustments" population, so its reason and evidence live on the record. `ENGINEERING JUDGEMENT`.
- **Customer statement:** a line "Refund of <credit origin> — <bank>" reducing the credit to zero; the original receipt/credit note stays visible above it. **Ageing:** untouched (the credit was never in it); if the origin was a contra-AR credit note there is nothing to refund — that credit was consumed by its invoice.

### 2.3 One operation or three workflows?

**One controlled operation — `Refund customer credit` — with origin-aware preconditions.** The accounting differs only in *which liability account is debited* (known from the credit's origin) and *which VAT document must exist first* (case A). Three workflows would triplicate the cash-out, approval, bank-identity and matching logic while the only real branch is a precondition check: *"this credit is a tax-invoiced advance — a credit note for the advance invoice is required before the refund can be approved."* The credit's origin is preserved because the refund allocates to the credit, and the credit carries its origin. Partial refunds are allocations of part of the credit; the remainder stays. `ENGINEERING JUDGEMENT` — the cleanest model, and the one the D-4 identity separation (§4) makes natural: a refund is a payment (identity: customer, out, bank) whose allocation target is a credit rather than an invoice.

---

## 3. Payment matching rules

### 3.1 What the products actually do (practice, not authority)

- **QuickBooks Online:** suggests a match on the same amount within a window (−90/+20 days); the user confirms; automatic matching only for transactions QuickBooks itself created (Payments, Payroll) — i.e. where the reference is system-generated and certain (S7).
- **Odoo 17:** three model types; auto-validation only "when the model conditions are perfectly met" — the shipped perfect-match model requires the invoice/payment **reference** in the statement label *and* the **partner** (S5).
- **Xero:** suggests matches (rules, previously reconciled patterns); the user clicks OK; Find & Match for one-to-many (S6).
- **ERPNext:** match "when the amount, date, party, and reference agree" (S4).

Convergent lesson: **amount is never identity**; the products that automate at all do so only on a reference they can trust, and every one of them keeps a human confirmation for anything less. `PRODUCT DESIGN PRACTICE`.

### 3.2 What evidence makes a match deterministic — the rule

Matching is always **statement row ↔ payment record** (never statement row ↔ invoice; an invoice is an allocation target, not a cash event). Direction is part of identity: a credit row matches receipts only; a debit row matches money-out payments (bill payments, refunds) only.

Evidence classes, and what each may do:

| Evidence | May it identify? | Role |
| --- | --- | --- |
| **Bank identity** (the statement's bank = the payment's bank) | No — but disagreement is disqualifying | A hard filter; for a historical payment with no bank, the statement supplies the bank (D-3 A2) |
| **Direction** | No — disqualifying if wrong | Hard filter |
| **Exact amount** | No (collisions are routine) | Hard filter for DETERMINISTIC; partitions candidates |
| **Date within a fixed window** (recommended ±3 calendar days; value-date lag) | No | Filter; outside the window → never DETERMINISTIC |
| **Identifying reference** — a token in the statement narrative that resolves to exactly one platform document or payment (invoice number, credit-note number, the platform's own payment reference, a quotation/order number) | **Yes, if it resolves uniquely** | The only identifying evidence |
| **Party name in the narrative** | No — names are free text, shared, misspelled | Supporting only; can raise an AMBIGUOUS candidate's rank, never make it DETERMINISTIC |
| **Uniqueness under `pairOneToOne`** | Required | n ↔ n with n > 1 is ambiguous regardless of the above |

**DETERMINISTIC** (the platform may establish `statement row ↔ payment`; in the live UI as a single pre-selected match the human confirms in one click; in the historical backfill automatically, as D-3's cut-over does):
same bank identity ∧ same direction ∧ exact amount ∧ an identifying reference in the narrative resolving to exactly one payment record (or to exactly one document that has exactly one payment record of that amount) ∧ date within the window ∧ the (row, payment) pair is unique in its `pairOneToOne` group.

**AMBIGUOUS** (candidates shown; the human chooses; nothing established):
- the filters leave ≥ 2 candidates (two customers, 5,000, same day, no reference);
- exactly one candidate but **no identifying reference** — amount+date+bank alone (shown as *the* suggestion, still a human click);
- an identifying reference that resolves to a document with **several** payment records of that amount, or to several documents;
- the date is outside the window while everything else agrees;
- the amount differs by a **small, explainable** difference (bank charges, FX) while the reference agrees — shown with the difference; the human records the charge; the platform never creates it.

**UNMATCHABLE** (no reasonable candidate; the platform offers to *create*, never to invent):
- no payment record of that direction/bank within the window at any amount related to the row;
- the only candidate is already matched to another statement row (a possible duplicate row — flagged as such);
- an identifying reference resolving to an invoice with **no payment record** and an amount ≤ the invoice's open balance: a receipt not yet recorded — propose "create receipt <amount> allocated to <invoice>", human confirms.

**INCONSISTENT** (evidence conflicts; blocked until a human resolves the conflict, and the conflict is named):
- reference resolves to a document/payment whose **bank differs** from the statement's bank;
- reference resolves to a payment of a **different amount** beyond any small-difference tolerance (e.g. INV-1042 for 3,000 vs a payment record of 5,000 — one of them is wrong);
- reference resolves to a document of the **wrong direction** (a supplier bill on a credit row);
- reference resolves to a document/payment of **another company** or another tenant (reported as not found — RLS; never as a hint);
- amount **exceeds** the referenced invoice's total with no payment record (overpayment or wrong reference — a human decides, never an auto-split).

`ENGINEERING JUDGEMENT` for the classes; the window and the small-difference tolerance are `PRODUCT DESIGN PRACTICE` values to be stated in the design doc, not discovered in code.

### 3.3 Worked examples

**The given example.** Bank: SAR 5,000, 17 Sep, reference `INV-1042`. Payment: SAR 5,000, 17 Sep, Customer X, INV-1042. **DETERMINISTIC** *if* the statement's bank is the payment's bank (or the payment is bank-less history — then the statement supplies the bank, D-3 A2), the direction is credit, and there is exactly one payment record of 5,000 on INV-1042. It is deterministic because the reference *identifies* and every other fact *agrees*; it would not be deterministic on amount and date alone even though they match, because they cannot distinguish this payment from another 5,000 the same day.

| Case | Classification | Why |
| --- | --- | --- |
| Two customers pay 5,000 the same day, no references | AMBIGUOUS for both rows | 2 ↔ 2 on amount/date/bank; an ordering is not evidence (D-3). Party names in narratives may rank, never decide |
| Same customer pays two invoices of the same amount, one row each, no references | AMBIGUOUS | Financially symmetric, but allocation identity (which invoice) drives ageing and the statement; a human picks. With `INV-…` references: each DETERMINISTIC |
| One payment covers two invoices (row 8,000; invoices 5,000 + 3,000) | DETERMINISTIC if a payment record of 8,000 with two allocations exists; else UNMATCHABLE → propose "create receipt 8,000; allocate 5,000 + 3,000", human confirms | Matching is to the *payment*, never to invoices; never auto-split |
| One invoice receives two partial payments (rows 2,000 and 3,000) | Each DETERMINISTIC against its own payment record (with reference); if both rows were 2,500 the same day → AMBIGUOUS 2 ↔ 2 | Partial payments are allocations; matching is per payment |
| Reference missing, single candidate on bank+amount+date | AMBIGUOUS (single suggestion) | Amount+date+bank never identify |
| Date differs by one day | Inside the window → DETERMINISTIC (with reference); outside → AMBIGUOUS | Value-date lag is normal; the window is a stated tolerance |
| Amount differs by bank charges (4,985 vs 5,000, reference agrees) | AMBIGUOUS with the difference shown | The human records 15.00 as bank charges; the platform never creates the charge |
| Refund (debit row 1,000, customer name) | Candidates are money-out payments to customers (refunds) only; DETERMINISTIC with the platform's refund reference; a receipt is never a candidate | Direction is identity |
| Duplicate bank statement row | The upload dedup catches identical rows; if a near-duplicate slips through, its only candidate is already matched → UNMATCHABLE, flagged "possible duplicate of row #N" | `pairOneToOne` never reuses; no second receipt is ever created |

The resulting rule never guesses: only an identifying reference plus full agreement plus uniqueness establishes a match, and even that is a click in the live UI.

---

## 4. Payment entity architecture (domain model, no SQL)

### 4.1 Three identities

| Identity | Answers | Carried by | Never derived from |
| --- | --- | --- | --- |
| **Bank identity** | Which of *our* accounts the cash moved through | The bank leaf the cash line posts to (D-3); for statement rows, the row's bank | The party, the document, the amount |
| **Payment identity** | Who paid or was paid, when, how much, in which direction, by what method, under what reference — the economic event | The `payment` record | The statement row's amount, the invoice |
| **Allocation identity** | Which document(s) (or which credit) this payment settles, and how much of it | Allocation records: one link *payment → target, amount* | The party's open items, "oldest first", equal amounts |

A payment can exist with zero allocations (a deposit/unapplied receipt); an allocation cannot exist without a payment or a credit; a bank identity exists on every cash line whether or not a payment record exists (a bank fee has bank identity and no payment identity in the AR/AP sense). D-3's rule stands: bank identity ≠ payment identity; D-4 adds: payment identity ≠ allocation identity.

### 4.2 Lifecycles

**Bank transaction → Payment → Allocation → Invoice(s).** A statement row (bank identity, direction, amount, date, narrative) is matched (§3) to a payment record — or a payment is created from it with the human naming the party. The payment posts cash (Dr bank leaf / Cr *Customer deposits & advances* until allocated, or Cr AR when allocated at creation — the accountant's liability treatment applied as *the unallocated remainder is a deposit*). Allocations link the payment to invoices for amounts; each allocation moves value from the deposit liability to the receivable (§1.3 (2)). The invoice's paid status is the sum of its allocations. `VERIFIED ACCOUNTING FACT` (postings) · `PRODUCT DESIGN PRACTICE` (lifecycle).

**Customer receipt → Unapplied / Deposit → Later allocation.** A receipt with no target is a deposit from the moment it is recorded (liability, not AR credit — settled). It carries a *classification* (advance for supply S / erroneous / security deposit) that the VAT timing rule needs (§1.1); until classified it is on the VAT-return exception list. Later allocation is §1.3 (2).

**Credit note → Customer credit → Later application.** A credit note is issued against a tax invoice (Art. 54); its issue *applies* it to that invoice's open remainder (contra-AR) and turns any excess into a *customer credit* (refund liability). A customer credit is an allocation *source* like a payment: applying it to another invoice is an allocation from the credit (§1.3 (5)). The credit keeps its origin (which credit note, which original invoice).

**Credit → Refund.** A refund is a money-out payment (payment identity: customer, out, bank leaf, date, amount) whose allocation target is the credit (§2.3). Its preconditions depend on the credit's origin (tax-invoiced advance → credit note first). Partial refunds allocate part of the credit.

### 4.3 What the model refuses by construction

- A cash line without bank identity (D-3).
- An allocation exceeding its payment's or credit's unallocated remainder, or the target's open balance (one-sided over-allocation is how AR credits appear by accident — excluded).
- An allocation created by the platform without a human act, except the historical backfill's DETERMINISTIC matches (§3) which mirror D-3's cut-over discipline and are recorded as such.
- A credit note without its referenced invoice (Art. 54(4)).
- A refund of a credit that does not exist or is already consumed.

---

## 5. Migration / opening-balance workflow (the workflow to support eventually; not an implementation)

**Established practice (S4, S6, S7):** choose a conversion date (the first day of a period); take the old system's trial balance as at the day before; enter balance-sheet balances only (P&L is closed into equity before conversion); the difference lands in a temporary equity account (Xero "Historical adjustment"/conversion balances, QuickBooks "Opening Balance Equity", ERPNext "Temporary Opening"); enter each outstanding invoice and bill **individually** so future receipts and payments can be allocated and ageing works (Xero requires it; ERPNext's Opening Invoice Creation Tool does it); enter bank balances per bank account as at the conversion date and reconcile them to the statements; lock the period before the conversion date. `PRODUCT DESIGN PRACTICE`, resting on `VERIFIED ACCOUNTING FACT` (opening entries are balance-sheet only; the balancing figure is equity).

**The workflow Saudi Ledger should support:**

1. **Conversion date** — one per company, the first day of an open fiscal period; every historical period before it is locked once step 6 completes. The conversion date is not the D-3 activation date and not a reclassification date (D-3 pack Decision 4 keeps those separate).
2. **Opening journal** — one posted entry, `source = opening`, dated the conversion date, balance-sheet accounts only, balanced to **Opening Balance Equity** (a system equity account that only the opening and clearing paths may post to). Cash lines name their bank leaf (D-3: no cash without a bank). AR and AP control accounts receive the *totals* here only if step 3 will replace them with items — see the validation in step 5.
3. **Open items** — every outstanding customer invoice and supplier bill as at the conversion date entered as an **opening item**: party, original date, due date, open amount, reference to the old system's number. **They are not tax invoices**: no ICV, no hash chain, no e-invoice, no VAT (the VAT was reported in the old system), and they never enter the ZATCA pipeline. Their sum per control account must equal the opening journal's AR/AP lines. Customer credits and supplier credits outstanding at conversion are entered as opening *credits* with their origin (deposit vs credit-note balance) so §1's model holds from day one. `SAUDI / ZATCA REQUIREMENT` in substance (an opening item is not an issuance) — flagged for confirmation because it is the kind of thing that must be stated, not assumed.
4. **Bank openings** — per bank leaf, the balance as at the conversion date and the statement it was read from; the difference between the ledger opening and the statement is reconciled by listing uncleared items (the classic bank reconciliation), never by plugging.
5. **Validation and the three-way reconciliation** (settled): the imported trial balance = the posted opening journal = the ledger read back, account by account; AR/AP control = Σ open items; each bank leaf = statement ± uncleared items; OBE = the old system's closing equity (retained earnings + capital) exactly. Any difference blocks completion with the account named — no "historical adjustment" is written silently (Xero writes one when totals differ; Saudi Ledger refuses instead — `ENGINEERING JUDGEMENT`, consistent with the fail-closed posture).
6. **Clearing Opening Balance Equity** — one dated journal, `source = opening`, moving OBE to the accounts the accountant names (retained earnings / owner's equity / capital) — the target is `ACCOUNTING POLICY` (settled as theirs). Until it is posted, the balance sheet shows OBE with a visible "migration not closed" marker. Then the pre-conversion lock is set.

**Corrections after completion** follow the general rule: a new dated entry, never an edit of the opening journal (Commercial Books IR).

---

## 6. ERP comparison — behaviour relevant to D-4 (extracted, not copied)

| Behaviour | ERPNext (S4) | Odoo 17 (S5) | Xero (S6) | QuickBooks Online (S7) |
| --- | --- | --- | --- | --- |
| Customer deposits | Default: negative balance in the receivable account; v15 option: a liability advance account, only via Payment Entry, reclassified on invoice | Payment registered to outstanding receipts, then to the partner's receivable (credit) on reconciliation; no separate deposit account by default | *Prepayment*: posted to an account you choose (typically a liability), tax coded on a cash basis; listed on the statement as invoice+payment on one line | Deposits via a liability item on a sales receipt (retainer method); otherwise a credit in AR |
| Unapplied receipts | Advance in the receivable account (or the v15 liability) | Credit on the partner receivable | *Overpayment*: always Accounts Receivable, no tax until applied, shown as a payment received | Unapplied payment: credit in AR; "Undeposited Funds" for cash not yet banked |
| Credit notes | A return Sales Invoice (negative) in the receivable account; allocated via Payment Reconciliation | A reversed invoice on the receivable; applied to invoices or refunded | Credit note in AR, allocated to invoices or refunded via "cash refund" | Credit memo in AR; applied or refunded (refund receipt) |
| Payment allocation | Explicit references on the Payment Entry; Payment Reconciliation tool for advances/credits ↔ invoices | Reconciliation of the payment's receivable line with invoice lines | Allocation of overpayments/prepayments/credit notes to invoices by the user | "Receive payment" applies to open invoices; unapplied remainder stays as credit |
| Refunds | Payment Entry (pay) against the customer referencing the credit note/advance | Outbound payment registered against the credit note | Only through "Make a cash refund" on the overpayment/prepayment/credit note itself | Refund receipt / cheque against the credit |
| Bank matching | Match when amount, date, party, reference agree; otherwise create | Rules; auto-validate only when perfectly met (reference + partner); otherwise suggest | Suggested match, user clicks OK; bank rules; Find & Match for one-to-many | Suggests on amount within −90/+20 days; user confirms; auto-match only for QuickBooks' own transactions |
| Partial payments | Allocation less than invoice; invoice stays partly paid | Partial reconciliation; invoice "partially paid" | Part payment on the invoice | Partial application |
| Overpayments | Excess becomes an advance (receivable credit or liability) | Excess stays as a partner credit | *Overpayment* transaction type in AR | Excess stays as unapplied credit in AR |

What this comparison supports: the payment as its own document; allocations as explicit links; credits as allocation sources; refunds only from a credit; matching that suggests and asks. What it does **not** support and Saudi Ledger does not adopt: credits inside AR (excluded by the accountant), transitory outstanding accounts (D-3 solves the gap with bank identity), automatic matching on amount and date, and silent balancing adjustments at migration.

---

## 7. Classification conventions

Every conclusion above carries one label. In summary: the *natures* of the three credit positions, the *journals*, and the *separation of the three identities* are `VERIFIED ACCOUNTING FACT`; the *timing of VAT on advances*, the *credit-note reference and period rules*, and *records/tamper controls* are `SAUDI / ZATCA REQUIREMENT`; *how many liability accounts*, *allocation order*, *OBE clearing target* are `ACCOUNTING POLICY`; the *matching classes, window and tolerance*, *one refund operation*, *refusal instead of a historical adjustment* are `ENGINEERING JUDGEMENT`; everything drawn from ERPNext/Odoo/Xero/QuickBooks is `PRODUCT DESIGN PRACTICE`. Items marked `NEEDS ACCOUNTANT CONFIRMATION`: one vs two liability accounts; the erroneous-overpayment VAT boundary; refundable security deposits (`No authoritative source located.`); opening items as non-tax-invoices.

---

## 9. Implementation consequences (per decision; nothing implemented)

| Area | Credit-note treatment (Model C, two liabilities) | Refund model (one operation) | Matching evidence | Payment / allocation identity | Migration + OBE |
| --- | --- | --- | --- | --- | --- |
| Database / domain | Two system liability accounts; a *customer credit* concept with origin (credit note / receipt remainder / opening) and unallocated remainder | A payment with direction *out* and an allocation whose target is a credit | A match record: statement row ↔ payment, classification, evidence (reference token, window), actor; append-only | `payment` (party, direction, date, amount, method, bank leaf, reference) + `allocation` (source payment or credit → target document or credit, amount) | Conversion date per company; opening items (non-invoice), opening credits, OBE system account, migration state |
| Accounting engine | Credit-note posting branches on the referenced invoice's open remainder; allocation moves deposit → AR | Dr the credit's liability / Cr bank leaf through the seam; precondition: credit note exists for a tax-invoiced advance | No posting from a match; a match only *links*; a DETERMINISTIC backfill match may set D-3's A2 evidence — via D-3's cut-over, never by writing attributions from D-4 | One writer per effect (existing pay paths become allocation-aware); no posting without bank identity | `source = opening` entries; OBE non-posting except by the opening/clearing paths; balance-sheet-only validation |
| AR | Receivable reflects only open invoices net of applied credit notes | Unaffected | Unaffected | Invoice paid status = Σ allocations | Opening items are receivables with ageing dates |
| Customer statements | Deposits and credit balances as distinct lines with origin | "Refund of <origin>" line settling the credit | Unaffected | Every allocation as a line under its payment | Opening items appear as the first lines |
| Ageing | Credits not in buckets; a "credits available" figure beside the ageing | Unaffected | Unaffected | Partial allocations reduce the aged amount from the allocation date | Opening items age from their original due dates |
| Bank reconciliation | Unaffected | Refund rows are money-out candidates | The four classes drive what is proposed; direction and bank identity are filters; `pairOneToOne` everywhere | Matching is per payment, never per invoice | Bank openings reconciled to statements with uncleared items listed |
| GL | Two liability accounts under one caption | Cash out on the bank leaf | None | AR movements via allocations, deposits via unallocated remainders | Opening journal + clearing journal, both dated and locked |
| VAT | Advance tax invoice on classified deposits; credit-note period rule; unclassified-receipt exception list on the return page | Credit note precondition for tax-invoiced advances; nothing for erroneous overpayments | None (documents file; matching reconciles) | None | Opening items carry no VAT and never enter e-invoicing |
| Audit | Origin preserved on every credit; corrections by new records | Reason + evidence on the refund; approval event | Match records with actor and evidence; unmatch = new record | Allocation and de-allocation are dated records | Migration state and both journals as evidence; the three-way reconciliation result stored |
| Permissions | Existing invoice/credit-note permissions | A refund permission = the pay permission, approval engine per company | A reconcile permission (existing review permission) | Allocate = the pay permission | A migration permission (admin) |
| Idempotency | Credit-note posting is once per document | One refund per (credit, request); duplicate refusal by the credit's remainder | One match per statement row; one statement row per match; a row already matched is never a candidate | An allocation cannot exceed remainders; retries refused by remainder, not by guesswork | Opening completes once per company; reruns refuse |
| Reversal / correction | Credit note reversal = a debit note or a new credit note per Art. 54, never an edit | Refund reversal = a new receipt allocated to a new credit, never deletion | Unmatch = a new record superseding the match; the statement row returns to unmatched | De-allocation = a new record; the payment's remainder returns to deposit | Corrections after completion by new dated entries; the opening journal is never edited |
| Migration (D-4's historical backfill) | Historical credits classified by origin where records say; otherwise "credit origin unknown" — a first-class state like *bank unidentified* | None | Only DETERMINISTIC matches act without a click; AMBIGUOUS lines block exactly as D-3's do; the backfill reads bank identity through the view and never writes attributions | Historical `invoice_payments`/`bill_payments` become payments with one allocation each; Mark-Paid rows with no bank stay *bank unidentified* | — |

---

## 10. Final Batch 1B readiness gate

### READY (sufficiently decided to implement)

- The three-identity model: bank identity (D-3), payment identity, allocation identity — and the four D-3 conditions, preserved.
- The payment entity in both directions with explicit allocations; the unallocated remainder of a receipt is a customer-deposit liability (settled); credits as allocation sources with preserved origin.
- Credit notes: contra-AR to the referenced invoice's open remainder, excess to a customer-credit liability; VAT adjusted by the credit note; application later is VAT-neutral.
- Refunds: one operation settling a credit, origin-aware preconditions (credit note before refunding a tax-invoiced advance), bank leaf required, approval engine.
- Matching: the DETERMINISTIC / AMBIGUOUS / UNMATCHABLE / INCONSISTENT classes with the identifying-reference rule, direction and bank as filters, `pairOneToOne` uniqueness, human click in the live UI, automatic action only in the backfill's DETERMINISTIC class.
- The unclassified-receipt exception list on the VAT return page (a reader, not a posting) — the product's way of honouring the advance-VAT timing without deciding tax for the user.
- The migration workflow's shape (six steps) and its fail-closed validation.

### NEEDS ACCOUNTANT (genuine judgement only)

1. **One or two liability accounts** for customer credits — *Customer deposits & advances* and *Customer credit balances* (recommended) or a single *Amounts due to customers*. Changes only the chart seed and the balance-sheet caption; Batch 1B can start with two and merge later without data loss.
2. **The erroneous-overpayment VAT boundary** — confirm that an overpayment by error (no further supply intended) is not consideration and carries no VAT until applied; and the treatment of a **refundable security deposit** (no KSA source located). Default: no VAT until applied/classified as an advance.
3. **Opening AR/AP items as non-tax-invoices** — confirm they are entered as open items without tax invoices (no ICV, no e-invoice, no VAT), since the VAT was reported in the previous system. This gates the migration batch, not 1B.
4. Already with him: the OBE clearing target; the D-3 pack's §11 items.

### FUTURE PHASE (does not block Batch 1B)

- The migration/opening workflow itself (G2) — designed here, built after 1B.
- The D-4 historical payment backfill's *credit-origin* classification for old credit notes.
- Automatic classification of deposits into "advance for supply S" (the user classifies; no automation).
- Second-person approval on refunds as a per-company setting (the engine exists; the setting can follow).
- The advance-invoice/prepayment fields in the ZATCA XML standard — verify the current Implementation Standard when the advance tax invoice is built; not needed for allocations.
- Multi-currency credits and refunds (out of scope, as in D-3).

### Verdict

`BATCH 1B: READY WITH SPECIFIC ASSUMPTIONS`

The assumptions, each reversible without data loss: (a) two liability accounts for customer credits (mergeable); (b) an erroneous overpayment carries no VAT until applied; (c) matching window ±3 days and a stated small-difference tolerance as product values; (d) the four D-3 conditions hold. Nothing in this research invalidates them.
