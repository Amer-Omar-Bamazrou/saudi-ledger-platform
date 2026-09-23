# The accounting-logic escalation protocol

**Standing rule for every session working in this repository (owner, 2026-09-18).** Referenced from CLAUDE.md §4; this file is the full text and the single writer for it.

## Primary rule

On any accounting-logic blocker, accounting-policy ambiguity, financial-control question, or uncertainty about the correct accounting treatment: **do not guess.** Do not invent accounting behaviour because it is technically convenient; do not silently choose a behaviour from what the schema happens to allow; do not automatically copy another accounting platform. Investigate as below.

## 1. Inspect Saudi Ledger first

Before deciding anything, inspect the current schema, the accounting services, the posting seam (`postJournalEntry`), journal and subledger logic, the related migrations, the existing invariants (`apps/api/src/scripts/ledgerInvariants.ts` and the test suites), the relevant tests, and the decision packs in `docs/product/`. State exactly what Saudi Ledger currently does, with file paths.

## 2. Compare the open-source reference implementations

Reference implementations, **not** accounting authorities and **not** Saudi regulatory authorities:

- **Odoo** — https://github.com/odoo/odoo — `addons/account`, `addons/account_accountant`: `account.move`, `account.move.line`, `account.payment`, `account.partial.reconcile`, `account.full.reconcile`, `account.journal`.
- **ERPNext** — https://github.com/frappe/erpnext — `erpnext/accounts`: Journal Entry, GL Entry, Payment Entry, Payment Ledger Entry, Payment Reconciliation, Opening Invoice Creation Tool, Party Account, the `is_opening` flag on Sales Invoice / Purchase Invoice.

That either does something never means Saudi Ledger must.

## 3. How to inspect them — citation is mandatory

Inspecting the **source** is not optional. Every Odoo or ERPNext claim cites the file path and names the model, field, method or doctype. A claim that cannot be cited is not reported — say instead that it could not be located. Never describe their behaviour from memory, documentation alone, README files, screenshots, marketing pages or blog posts. Both repositories can be fetched (a blobless, sparse clone of the accounting module into the session scratchpad is enough); fetch them.

Inspect, as the question requires: journal entries; invoices; credit notes; payments; reconciliation; receivables; payables; payment allocations; customer statements; opening balances; assets; depreciation; inventory accounting; taxes; fiscal periods; reversals; corrections; bank reconciliation; financial reports. For ERPNext, attend to the separation *Source Document → GL Entry → Payment Ledger → Allocation/Reconciliation → Reports*. For Odoo, inspect models and workflows, never the UI.

## 4. Required comparison

For every genuine accounting blocker, a table: **Question | Saudi Ledger current behaviour | Odoo implementation (cited) | ERPNext implementation (cited) | Accounting or regulatory source | Proposed treatment.** Fabricate no entry. If Odoo and ERPNext disagree, say so; if they converge, say so — and say plainly that convergence between two products is evidence about software, not an accounting requirement, and never a Saudi one.

## 5. Source hierarchy

1. Saudi regulatory and tax authority: ZATCA, Saudi government regulations, SOCPA where authoritative material exists.
2. Accounting standards: IFRS, IFRS for SMEs, other authoritative standards.
3. Mature implementations: Odoo, ERPNext — implementation evidence only.
4. Professional accounting practice, from reputable sources.
5. Engineering judgement, only where the issue is genuinely architecture or product rather than an accounting requirement.

## 6. Classify every conclusion

Exactly one of: `AUTHORITATIVE REQUIREMENT` · `ESTABLISHED ACCOUNTING PRACTICE` · `ODOO IMPLEMENTATION` · `ERPNEXT IMPLEMENTATION` · `SAUDI LEDGER PRODUCT DECISION` · `ACCOUNTANT DECISION REQUIRED`. Never blur them.

## 7. When to escalate to the accountant

Escalate when the question affects accounting policy or interpretation: recognition; classification; timing; revenue; expenses; assets; liabilities; equity; VAT; tax treatment; prior-period corrections; retained earnings; opening balances; customer and supplier balances; credit and debit treatment; refunds; advances and deposits; write-offs; provisions; depreciation policy; inventory valuation; financial-period treatment.

Before escalating, state what the research settled and what genuinely remains his. **If Odoo and ERPNext converge, the reasoning is sound, and the question carries no Saudi, VAT, ZATCA or company-accounting-policy consequence, adopt it as a `SAUDI LEDGER PRODUCT DECISION`, say plainly that you are proceeding, and do not escalate.**

He is one person doing us a favour. A question that could have been answered by reading their source is not spent on him. Several questions in one batch go as a single short list, not separately. Where the question turns on Saudi law, VAT, ZATCA or company accounting policy, it goes to him regardless of what Odoo and ERPNext do — and the affected work stops.

## 8. Blocker report format

When a blocker is found, stop the affected implementation and report exactly:

```
ACCOUNTING BLOCKER
- Question — one sentence.
- Why it matters — which workflow or accounting consequence depends on it.
- Saudi Ledger current behaviour — what the code does now.
- Odoo — module, model or service, treatment, cited file path.
- ERPNext — doctype or module, treatment, cited file path.
- Accounting and regulatory sources — each with source, version or date, relevant section, and what it establishes.
- Where they agree.
- Where they differ.
- Proposed options — the legitimate ones, without pretending there is an accounting answer where there is not.
- Recommended engineering default, if one exists that makes no accounting-policy decision. Otherwise: ACCOUNTANT DECISION REQUIRED.
- Exact question for the accountant — short enough to send as written.
- Implementation impact — exactly what is blocked.
```

## 9. Do not block unnecessarily

Engineering decisions stay engineering: component structure; API naming; index strategy; UI layout; pagination; caching; loading states; test structure; internal service boundaries. But an engineering decision that changes the accounting meaning of a transaction is escalated.

## 10. Do not copy blindly

Learn from mature implementations while designing Saudi Ledger's own Saudi-first model. Do not copy database structures, business rules, tax behaviour, country-specific assumptions or workflows merely because they exist; never treat vendor implementation as law. Take the idea, not the implementation, and never introduce their abstractions into our posting seam — ours is built and tested. Ask "how have mature systems modelled this?", then decide "what should Saudi Ledger do, given Saudi requirements, accounting principles and our architecture?"

## 11. When the accountant answers

Record the decision in the relevant decision pack. Convert it into an explicit accounting invariant. Implement it. Add regression tests. Validate the journal effect, the subledger effect, the reports, the audit trail and the UI. Browser-test the complete workflow by clicking. Commit and push. Never leave his answer as an informal chat-only decision. Where his answer contradicts Odoo or ERPNext, his answer wins, and the divergence is recorded with the reason.

## 12. Final principle

Real-world accounting question → Saudi Ledger's current implementation → Odoo inspection → ERPNext inspection → authoritative Saudi and accounting sources → compare → engineering decision or accountant decision → document → implement → test → browser workflow → accounting invariants.

The objective is not to make Saudi Ledger identical to Odoo or ERPNext. It is to make Saudi Ledger accounting-correct, Saudi-appropriate, auditable, operationally usable and technically robust.

## Applications of the protocol (index)

- 2026-09-18 — Batch 1C, the three questions with the accountant (opening invoices/bills, a party balance with no detail, mid-year YTD P&L): [`docs/product/batch-1c-migration-opening-balances-decision-pack.md`](product/batch-1c-migration-opening-balances-decision-pack.md) §13.
- 2026-09-18 — Batch 1C, the accountant's decisions verified (12-month input-VAT rule confirmed from IR Art. 40(10)–(11); historical VAT and advances confirmed; the first-PIH-after-solution-change claim NOT confirmed → ZATCA question, no default encoded); chart-of-accounts mapping compared against Odoo and ERPNext source: the same pack, §15.
- 2026-09-19 — Batch 1C, the correction policy: SOCPA/ZATCA primary texts, Odoo and ERPNext source (cited), two questions escalated in the §8 format: the same pack, §16.
- 2026-09-20 — Batch 1C, both answered (A4 Policy C with NEW replacement numbers; A5 an unbalanced opening BLOCKS, no landing account) and converted into invariants; the pre-answer build's violations named and corrected in two commits; one new question (a partly-settled opening item) stated and NOT built past: the same pack, §16.12. 🔴 The worked example of §11: the answer overruled a consequence the research had already recorded (§16.8's number reuse) — the record keeps the reasoning and says why it lost.
- 2026-09-20 — Advance payments / customer deposits: the gap analysis (accounting side BUILT in Batch 1B/1C; VAT and ZATCA side NOT built); GCC Agreement Art. 23, IR Art. 53(1)/(7) and Detailed Guideline §8 read as primary texts; Odoo `l10n_sa_edi`/`sale` and ERPNext `payment_entry` cited from source; three accountant items bundled, one ZATCA item reused: [`docs/product/advance-payments-decision-pack.md`](product/advance-payments-decision-pack.md) §8. Research only.
- 2026-09-21 — Advance payments, the accountant's A1/A2/A3 ANSWERED and built as AP-2 (the 386 and the final invoice's prepayment adjustment): the XML Implementation Standard v1.2 ¶9.5 fetched and read as the primary text for the UBL (it had been a named gap); the accountant's receipt entry reconciled with the existing two-document flow and STATED rather than silently re-shaped; the research pack's own E3 return line found inconsistent with its entry and corrected at the build; the shipped SDK found OLDER than the standard (386 rejected by its 2021 code list) — pinned, not worked around; Z1 left with ZATCA and kept out of the build: the same pack, §8, §14. No new accountant question.
- 2026-09-21 — AP-3, the credit note against a 386 and the refund it unlocks: built from the pack's own E5 and §7 rows and the accountant's A1/A2/A3 as answered; the XML Standard's BR-KSA-56/BR-KSA-17 read for what the note needs of the 386 (its number and a reason — nothing else); Odoo's down-payment reversal and ERPNext's payment-entry return recorded as implementation evidence, not followed; partial cancellation taken from the pack's E4/§7 model, not invented. No new accountant question; the live sandbox (AP-4) stays the open gate: the same pack, §15.
- 2026-09-21 — AP-4, the compliance validation: no accounting question raised and none answered; the as-built entries (§14/§15) asserted unchanged from the journal; the sandbox evidence recorded as bearing NOT AT ALL on the open receipt-period-vs-issuance-period question, which stays with the accountant: the same pack, §16.5.
- 2026-09-21 — Fixed assets, one research pass (nothing built): IAS 16 read from the IFRS Foundation text; VAT IR Art. 52/66, Income Tax Law Art. 17/18 (WTO-deposited English), the 2024 Zakat Regulations Art. 9/17/26/48/49/63 read as primary texts; Odoo 11 `account_asset` and ERPNext `assets` read as implementations. Two genuine accountant decisions found and STOPPED at — FA-1 (is the income-tax Art. 17 pooled basis in scope for any tenant?) and FA-2 (the VAT capital-asset regime: v1 computation scope and two readings of the translation): `docs/product/fixed-assets-decision-pack.md` §15. Everything else classified decided-by-text or product policy with a stated default.
- 2026-09-22 — The accountant's answers on advance payments (1(a), 1(b), 2, 3, 4, 5) applied as authoritative input; IR Art. 63 (return corrections) and Art. 40(7)–(9) (bad-debt relief and recovery) read from the primary text before building the locked-period and recovery paths — no conflict found between the answers and the text; the one product decision named as one (an unstated receipt is presumed a deposit); the recovery document's BT-115 recorded reasoned-not-verified. No new accountant question: advance-payments pack §17.
- 2026-09-22 — The migration follow-ups (answers 3 and 5) built inside Batch 1C's Policy C: the correction's other side is retained earnings (answer 5, no OBE); a credit note against a previous-system invoice through Fatoora once its identity is stated (answer 3). The partly-settled item (1C pack §16.12.5) stays with the accountant and is refused by name; whether ZATCA accepts a BillingReference to a previous-system number stays with ZATCA (reasoned-not-verified). Record: 1C pack §17.
- 2026-09-22 — Fixed assets FA-A (the foundation): FA-1 and FA-2 answered by the accountant (the Art. 17 pool in scope, computed separately; the Art. 52 adjustment in v1) and applied as authoritative input; the pack's decided-by-text items (IAS 16.16–20, 50–55, 68; Zakat Regs Art. 48/63(2); VAT IR Art. 52(2) for the adjustment period) built as recorded; the depreciation conventions (full month, last row absorbs rounding) are product policy with a stated default. No new accountant question: the pack, §20.
- 2026-09-22 — **Phase 11, deep accounting + deep AP.** The audit came FIRST and found two defects in SHIPPED code before any gap: a journal REVERSAL never called `checkPeriodOpen` (it writes its mirror through the repository, not `postJournalEntry`, so a reversal could post into a CLOSED month), and both ageing reports bucketed on `new Date()` rather than the business day. A2/A3 built on **IAS 37.11** read as the primary text: accruals are liabilities for what has been received "but have NOT been paid, INVOICED or formally agreed", trade payables are what HAS been invoiced — so 🔴 **an accrual posts to ACCRUED_LIABILITIES and never to AP**, refused by name, because a payable in AP that no supplier statement can match and no payment can settle is worse than no accrual. SOCPA’s IFRS endorsement (IFRS for SMEs since 2018) confirmed as the governing frame; **no Saudi tax or ZATCA consequence attaches to the recognition itself**, and that is stated so a later reader does not go looking for one. ERPNext cited from source (`deferred_revenue.py:397` the purchase-side direction, `:238` the prorate factor, `:249` the cap); 🔴 **Odoo could NOT be cited** — `addons/account` has no deferred implementation (it ships in Enterprise), so nothing is asserted about it. B7 researched and NOT built: 🔴 **the purchase side is not a mirror of the sales side** — IR Credit and Debit Notes ¶1 makes the note the SUPPLIER’s document (we receive it: no ICV, no QR, no chain position) and **Art. 40(6)** puts the CUSTOMER’s input-tax correction in the period the note was ISSUED. B8 (WHT) researched to its integration points and STOPPED: its accounting event is in the supplier-payment path, which does not yet exist in the form it needs. No new accountant question from what was built; the questions that would need him attach to work not started. Record: [`docs/product/phase-11-deep-accounting-ap-decision-pack.md`](product/phase-11-deep-accounting-ap-decision-pack.md).
- 2026-09-23 — **Phase 11 Part 2, AP as a subledger (B3–B7, B8's foundation), and the audit of it after it was built.** `AUTHORITATIVE (Saudi)`: VAT IR **Art. 49(7)** (input tax needs the SUPPLIER's tax invoice — so no AP payment path deducts VAT), the Credit and Debit Notes provision and **Art. 40(6)** (a purchase note is the supplier's document; the customer corrects its INPUT tax in the period the note was ISSUED — so the return's purchase side is now signed), Income Tax Law **Art. 68** (WHT turns on the payee's residency — recorded as a fact, no rate applied). `STANDARD (IFRS)`: **IAS 32 AG11**, fetched from the IFRS Foundation text — a prepayment whose benefit is the goods is a NON-financial asset, a refundable cash deposit a financial one; that is why the advance and the deposit are separate accounts, not only that their exits differ. `ERPNEXT`/`ODOO`, cited from `version-15`/`17.0` source for every B3/B4 decision: 🔴 **neither holds a supplier advance as an asset by default** (both leave it as a debit on the payable); ERPNext's opt-in `book_advance_payments_in_separate_party_account` does, with a new GL row per allocation — the shape built here — so the record argues from the standard and names ERPNext as evidence, not authority. The post-build audit found the build correct inside its files and wrong at its EDGES (a pay path that could settle a bill twice, a note-application reversal that posted a phantom advance, eight readers of `total − paid_amount`): fixed, and `repositories/billPosition` made the one definition. One genuine question raised and STOPPED at — **Z-AP1**, input VAT on the supplier's ADVANCE tax invoice (neither product has core logic for it either). Record: [`docs/product/phase-11-deep-accounting-ap-decision-pack.md`](product/phase-11-deep-accounting-ap-decision-pack.md) §9–§17.
