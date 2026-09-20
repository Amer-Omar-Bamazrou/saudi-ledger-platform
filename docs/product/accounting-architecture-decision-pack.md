# Accounting architecture decision pack — the gate before Batch 1

**Status (2026-09-16, third revision — the final decision-pack update before Batch 1): PROPOSAL. Nothing here is implemented; no schema, migration, service, test, seed or configuration was changed to write it.** Current state authority: [CLAUDE.md §2](../../CLAUDE.md). The gap register this gates: [`functional-gap-closure-plan.md`](functional-gap-closure-plan.md). Decisions D-6 (inventory valuation), D-7 (withholding / advances mechanics), D-8 (multi-currency), D-9 (branches / departments) and D-10 (company time zone) stay in that register as later-phase decisions and are not expanded here.

Every statement below is one of six kinds, and is labelled: **Current implementation fact** (verified in the repository, file named); **Proposed model** (what would be built); **Engineering judgement** (a choice engineering can make on its own); **Accounting policy — confirmed by advisor** (the accountant/advisor's stated policy for this product); **Accounting policy — advisor confirmation / company accounting policy** (a judgement that stays with the accountant and the company's own policy, never a platform constant); **Current ZATCA rule — verified from the primary text** (read in the official Arabic Regulations, cited by edition and page). Nothing labelled *engineering judgement* is presented as established accounting practice, and nothing the advisor said about this product is presented as a universal accounting rule.

| Decision | What it blocks | Proposed direction | Needs accountant confirmation |
| --- | --- | --- | --- |
| **D-1** Opening-balance landing account — 🔴 **SUPERSEDED 2026-09-20 (accountant, A5): there is NO landing account; an unbalanced opening position BLOCKS the migration — [`batch-1c-migration-opening-balances-decision-pack.md`](batch-1c-migration-opening-balances-decision-pack.md) §16.12.2** | G1 migration, G2 bank opening → GL, every opening figure in Phases 2–4 | A dedicated, system-protected equity account `OPENING_BALANCE_EQUITY` used only by migrations; **temporary** — the migration proves imported balances = posted opening journal = resulting ledger balances; a non-zero balance is visible everywhere; clearing to retained earnings / owner's equity is an explicit accounting act, never automatic | **Partly.** Confirmed: the temporary landing account. Open: the exact clearing workflow |
| **D-3 / G3** Per-bank cash GL | G4 payments (a payment must name its bank), G18 transfers, G19 reconciliation, G2 bank opening | One system-generated GL account per bank account under a non-posting "Cash and cash equivalents" header; the cut-over moves balances by a reclassification entry per company after a fail-closed, classified mapping of every historical cash line — automatic only on **deterministic source evidence**; **one-bank-only is not evidence** (confirmed) | **Partly.** Confirmed: single-bank history is NOT sufficient for automatic mapping. Open: per-bank presentation, cash on hand, the cut-over date, annotation presentation |
| **D-4 / G4** Payments, allocations, unapplied receipts | G5 credit application, G13 one subledger balance, G14 statements, aging correctness; the advance-payment gap (G11) | A `payment` entity with `allocations`; an unapplied receipt is a **liability** (Customer deposit / Unapplied cash), moved to AR on allocation; carry-forward is the default, refunds are controlled; the same mechanism serves advance payments; historical payments backfilled only where **each identity** (bank, customer, invoice, amount, date, direction, treatment) is established separately and deterministically | **Confirmed** for the liability treatment and carry-forward/refund policy. Open: refund approval workflow, unusual receipts, aging presentation, legacy aggregate rows, historical over-allocation |
| **D-5** Period states, correction and reversal dating | G15 reversal policy, G16 period states, G17 correction dating, G6 depreciation, G1 opening dates | Open → Soft close → Closed as a *technical* mechanism; accounting correction treatment is **materiality-based** (a policy, no platform threshold); VAT-return correction is a **separate tax workflow** driven by a **versioned, configurable tax rule** (Article 63 as amended: SAR 15,000 / 20 days — verified from the primary text, still never a literal in accounting logic) | **Confirmed** that correction depends on materiality. Open: the materiality policy to expose; retrospective mechanics; ZATCA details beyond the verified text (penalties) |

---

## D-1 — Opening balance landing account

### 1. Problem

An existing business cannot start on the platform. There is no way to state "on 1 January this company had SAR 50,000 in the bank, SAR 30,000 owed by customers, SAR 12,000 owed to suppliers and a van worth SAR 40,000" as ledger facts. Every opening figure is the far side of a balanced entry, and the near side has nowhere to land. Without a landing account either the migration invents a balancing amount (forbidden) or opening figures live outside the GL (the bank card's typed balance today — a hidden balance the statements disagree with).

### 2. Current implementation

- **Current implementation fact.** No opening-balance concept exists: no journal `source`, no `is_opening` flag on invoices/bills, no chart import. `bank_accounts.opening_balance` and `.balance` are written by `bankAccounts.service.ts` and read only for display; no journal entry is produced.
- **Current implementation fact.** The chart has 17 system codes (`packages/db/src/chartOfAccounts.ts`); no equity system account exists; tenants may create equity accounts by hand.
- **Current implementation fact.** `categories.is_system` exists and a DB trigger (`protect_system_categories`, migration 0024) refuses deleting a system account or changing its type/system code; renaming is allowed by design. `resolveAccounts` in `glPosting.ts` resolves lines by system code per organisation (`categories_org_system_code_unq`).
- **Current implementation fact.** Adding a system account requires redefining `seed_org_chart_of_accounts()` (CLAUDE.md §4; `tests/org-seed-trigger.test.ts` compares column sets).

### 3. Proposed model

- **Accounting policy — confirmed by advisor.** A dedicated **opening-balance equity** account is appropriate **as a temporary migration account**. It is reconciled and ultimately cleared to the appropriate equity account — retained earnings or owner's equity, according to the entity's accounting treatment — so that it finally reads zero. It is **not** cleared automatically merely because the migration balances.
- **Proposed model.** A system account **`OPENING_BALANCE_EQUITY`** — type `equity`, `is_system = true`, name "Opening balance equity (migration)" / "حقوق الملكية الافتتاحية (ترحيل)" — seeded for every organisation.
- Every opening figure is posted by the migration service through `postJournalEntry` as one balanced entry per migration section, dated on the opening date, with `journal_entries.source = 'opening'` and a reference to the migration record.
- **Postable only by the migration service** and by the **clearing entry** (below). Every other writer refuses it as a line account (a `MIGRATION_ONLY` system-code set checked inside the seam).
- **Not editable in place.** A wrong opening is corrected by reversing the migration (its entries through the seam; its opening documents unlinked) and re-running with corrected figures; each attempt is a new, audited migration record.
- **The migration produces a three-way reconciliation, stored on the run:** (1) the **imported opening balances** as supplied (per account, per document, per bank); (2) the **posted opening journal** (the entries actually written, per account); (3) the **resulting ledger balances** (each affected account's balance on the opening date read back from the GL). All three must agree to the halala, per account, or the commit refuses. The reconciliation is retained as audit evidence and shown on the migration record.
- **Any remaining Opening Balance Equity balance is visible.** The product treats a non-zero balance as an open item: the Finance Hub's "Are my books current?" block, the trial balance and the balance sheet flag the line ("Opening balance equity still carries SAR 91,090.00 — the migration is not yet cleared to equity"), and the migration record shows `cleared: no` until the clearing entry exists.
- **Clearing is an explicit act, never automatic.** The platform never posts the clearing entry because a migration technically balanced. The migration workflow ends with a step "Clear to equity" that an **accountant or admin** performs deliberately (choosing the equity account and the date), and only under the approved workflow for that company; until then the balance stays, flagged.

### 4. Alternatives considered

| Alternative | Trade-off |
| --- | --- |
| Land directly on retained earnings / capital | Merges "brought-forward equity" with the platform's own results and hides migration errors inside a real account; the advisor's stated policy prefers the temporary account precisely to keep the migration reconcilable before it is absorbed. |
| Let the user choose the landing account per migration | A free choice on the one entry that defines the starting position invites landing on an income account by mistake. |
| Post openings against Suspense | Suspense already means "unclassified cash" on the Finance Hub; overloading it makes the liquidity claim wrong. |
| Clear to equity automatically when the migration balances | Rejected by the advisor's guidance: clearing is an accounting judgement (which equity account, whether the migration is actually reconciled), not a consequence of arithmetic. |

### 5. Recommendation

**Engineering judgement.** A dedicated, system-protected, migration-only landing account; immutability via reversal; the migration refuses to commit unless the whole set balances and the three-way reconciliation agrees; a non-zero balance flagged as an open item on every statement that shows it; the clearing step present in the workflow but never executed by the platform on its own.

**Accounting policy — confirmed by advisor.** The temporary landing account; the eventual clearing to retained earnings / owner's equity.

**ACCOUNTING POLICY — ADVISOR CONFIRMATION.** The **final clearing treatment**: which equity account (retained earnings vs owner's equity — it may depend on the legal form, an establishment vs a company); when (immediately after reconciliation vs at the first year-end); whether one entry per migration or one per company; who signs it off; and whether a partial clearing is ever acceptable.

### 6. Journal examples (SAR)

**Bank-only opening balance** — Riyad Bank operating account held 50,000.00 on the opening date.

| Account | Dr | Cr |
| --- | --- | --- |
| Cash — Riyad Bank Operating (D-3 leaf) | 50,000.00 | |
| Opening balance equity | | 50,000.00 |

**Cash + AR** — plus two open customer invoices, 11,730.00 and 20,015.00.

| Account | Dr | Cr |
| --- | --- | --- |
| Cash — Riyad Bank Operating | 50,000.00 | |
| Accounts Receivable — party: Rawabi (INV-OPEN-0001) | 11,730.00 | |
| Accounts Receivable — party: Najd (INV-OPEN-0002) | 20,015.00 | |
| Opening balance equity | | 81,745.00 |

**Cash + AP** — 50,000.00 in the bank, 10,925.00 owed to Tamimi.

| Account | Dr | Cr |
| --- | --- | --- |
| Cash — Riyad Bank Operating | 50,000.00 | |
| Accounts Payable — party: Tamimi (BILL-OPEN-0001) | | 10,925.00 |
| Opening balance equity | | 39,075.00 |

**Cash + AR + AP + fixed asset** — a van, cost 40,000.00 with 8,000.00 accumulated depreciation.

| Account | Dr | Cr |
| --- | --- | --- |
| Cash — Riyad Bank Operating | 50,000.00 | |
| Accounts Receivable — party: Najd | 20,015.00 | |
| Fixed assets — vehicles (cost) | 40,000.00 | |
| Accumulated depreciation — vehicles | | 8,000.00 |
| Accounts Payable — party: Tamimi | | 10,925.00 |
| Opening balance equity | | 91,090.00 |

Check: Dr 110,015.00 = Cr 110,015.00.

**The three-way reconciliation the run stores for this example:**

| Account | Imported | Posted opening journal | Ledger balance read back | Agrees |
| --- | --- | --- | --- | --- |
| Cash — Riyad Bank Operating | 50,000.00 Dr | 50,000.00 Dr | 50,000.00 Dr | ✓ |
| AR — Najd | 20,015.00 Dr | 20,015.00 Dr | 20,015.00 Dr | ✓ |
| Vehicles (cost) | 40,000.00 Dr | 40,000.00 Dr | 40,000.00 Dr | ✓ |
| Accumulated depreciation — vehicles | 8,000.00 Cr | 8,000.00 Cr | 8,000.00 Cr | ✓ |
| AP — Tamimi | 10,925.00 Cr | 10,925.00 Cr | 10,925.00 Cr | ✓ |
| Opening balance equity | — (derived) | 91,090.00 Cr | 91,090.00 Cr | ✓ (flagged until cleared) |

**Clearing to equity (the accountant's explicit act, after reconciliation):**

| Account | Dr | Cr |
| --- | --- | --- |
| Opening balance equity | 91,090.00 | |
| Retained earnings (or Owner's equity — per §13) | | 91,090.00 |

Opening balance equity: 0.00; the flag clears; the migration record reads `cleared: yes, by <user> on <date>, entry JE-…`.

**Unbalanced migration** — the imported balances sum to Dr 110,015.00 and Cr 108,015.00 (the user typed the equity they believed they had, 89,090.00).

- The preview shows both totals, the difference **2,000.00 Dr**, and: "The opening figures do not balance. Nothing was posted. Correct one of the amounts above; the platform does not invent a balancing amount."
- Commit **refuses** (422 `opening_unbalanced`). No journal, no documents, no bank change. **No balancing entry is ever created to hide a migration inconsistency.**
- The platform may *display* the arithmetic ("if every other figure is right, opening equity is 91,090.00") but never applies it. **ACCOUNTING POLICY — ADVISOR CONFIRMATION:** whether even displaying the computed plug is acceptable.

### 7. Database implications (conceptual)

- System account `OPENING_BALANCE_EQUITY` (equity, system, migration-only + clearing).
- `journal_entries.source` (manual, invoice, bill, payment, transaction, payroll, opening, depreciation, adjustment, reversal, migration, clearing) — shared with D-5.
- `migrations` (company, opening_date, state draft/previewed/committed/reversed, checkpoint JSON, **reconciliation JSON** (imported / posted / ledger, per account), committed_by/at, `reconciled_at`, `clearing_journal_entry_id`, reversal refs).
- `invoices.is_opening`, `bills.is_opening` (aging/allocation only: no ICV, no e-invoice, excluded from the VAT return and from "issued" KPIs).
- `bank_accounts.opening_journal_entry_id` (D-3/G2).

### 8. Migration implications

For existing companies (pilot, rehearsal, demo): the account is seeded with a zero balance; their typed `bank_accounts.opening_balance` values are the input to G2's opening entry, run as an explicit per-company act by an admin (preview → commit), never a silent backfill. The seed-trigger rule applies.

### 9. Reporting implications

Trial balance and balance sheet: the landing account appears as an equity line **flagged while non-zero**; opening AR/AP appear on AR/AP as normal lines. Aging and statements: opening documents age from their original dates. VAT return: **excluded** (flagged rows are skipped). General ledger: the opening entry is the first line of every affected account, referenced `MIG-<n>`; the clearing entry is the last line on the landing account.

### 10. Audit implications

The migration record holds who ran it, when, the checkpoint totals, the three-way reconciliation, the entries it produced, the clearing entry and its author, and any reversal. Opening documents record `created_by = migration`. Nothing about an opening entry is editable. The typed bank opening balance is retained as the migration's *input*, never as a balance.

### 11. Permission implications

- Run/preview/commit/reverse a migration: **admin** only.
- View the migration record: admin and accountant.
- Post to the landing account manually: nobody; the **clearing entry** is the one permitted non-migration use, performed through the migration workflow's "Clear to equity" step by accountant or admin (confirm in §13 who may sign it off).

### 12. Tests required

- Service: unbalanced → 422 and zero writes; balanced → posted through the seam; the three-way reconciliation stored and asserted (change one imported figure → the commit refuses); opening AR/AP flagged, absent from the VAT return, present in aging/statement; the landing account refused on every other writer; the clearing step posts only when invoked and only against an equity account; the non-zero flag appears and disappears with the clearing entry.
- Invariant: TB balanced; balance-sheet equity includes the landing balance until cleared; each opening bank line = the bank's stated opening.
- Permission/isolation: accountant cannot commit a migration; org B cannot see org A's migration; the landing account of org A is not resolvable from org B.
- Dry-run: preview totals = committed totals. Idempotency: commit twice → one migration; a second migration refused until the first is reversed.
- e2e: the migration workspace, the refusal screen, the reconciliation view, the non-zero flag, the clearing step.

### 13. Accountant confirmation

1. **Clearing workflow:** which equity account (retained earnings vs owner's equity — does it depend on the legal form?), when (on reconciliation vs first year-end), one entry per migration or per company, and who signs it off.
2. May the platform *display* the computed equity plug on the preview (never apply it)?
3. Opening date: the last day of the prior fiscal year, or the first day of the first live period?
4. Opening AR/AP documents carry no VAT effect on the platform (filed previously) — confirm.

---

## D-3 / G3 — Per-bank cash GL architecture

> **Implementation status (2026-09-17, Batch 1A after the review's remediation):** the architecture below is BUILT (migration 0073, the seam's bank arm, the fail-closed paths, the classified dry-run and the transactional commit) — as-built record [`design-per-bank-cash.md`](design-per-bank-cash.md). Historical lines are **annotated, never rewritten**: `journal_entry_lines` keeps its posted `account_id`/`account_name` (the 2026-09-16 build's in-place remap was withdrawn by the architectural review), and the annotation lives in a separate append-only table (`cash_line_bank_attributions`, one row per line, unique on the line) rather than the `journal_entry_lines.bank_account_id` column §8 sketches — the line table stays immutable and the attribution carries its own run, rule and classification. Leaf-posted and attributed lines are resolved through ONE view (`journal_line_bank_identity`); the per-bank readers use it, the account-keyed statements do not claim a bank. **No reclassification entry is posted** (§8 step 6): its date and presentation are the open §13 (c)/(d) decisions, so history shows on "Cash and Bank" exactly as posted until they are taken. The review class is named `AMBIGUOUS_REQUIRES_REVIEW` (one-bank-only is not evidence, so there is nothing to confirm); the settlement rule A2 is a strict one-to-one pairing per document (n ↔ n with n > 1 is ambiguous — an ordering is not evidence). No override mechanism exists (§13.5 is still open), and no company has been cut over. The decisions in this section are unchanged.

### 1. Problem

Every cash movement posts to **one** GL account, "Cash and Bank" (`CASH`). A company with two bank accounts — the runbook's own setup — cannot state either bank's balance from the ledger, cannot reconcile a statement against the GL, cannot record a transfer between its own accounts as anything but a declared "kind", and cannot give an auditor a bank-by-bank position. Payments, transfers, reconciliation and bank opening balances all need this first.

### 2. Current implementation

- **Current implementation fact.** All cash lines resolve to the single system code `CASH`: invoice receipts (`invoices.service.ts:505`), bill payments (`bills.service.ts:303`), accepted bank rows (`transactionPosting.service.ts linesFor`), payroll payment (`payroll.approvable.ts`), settlements (through the two pay paths). `journal_entry_lines` carries `account_id`, `account_name`, `party_type/customer_id/vendor_id` — **no bank dimension**.
- **Current implementation fact.** `transactions.bank_account_id` exists (nullable, FK, indexed): statement imports set it when the upload names an account; manual rows and older imports may carry `NULL`. `invoice_payments` / `bill_payments` carry **no** bank account. A settlement from a bank row records the payment through `invoicesService.pay` / `billsService.pay` and links the row (`transactions.settles_invoice_id` / `settles_bill_id`), so a settlement-sourced payment's bank is recoverable through the row.
- **Current implementation fact.** `bank_accounts` has `balance`, `opening_balance`, `is_default` ("use on invoices"), no GL link.
- **Current implementation fact.** `categories` has **no hierarchy** (no parent column); `liquidity_class` classifies accounts for the Finance Hub; `is_system` + the DB trigger protect system rows; system codes are unique per organisation and resolved by code inside the seam.
- **Current implementation fact.** Reports find cash by system code / liquidity class; the cash reconciliation (`analytics/cash`) compares bank-row movement to CASH movement company-wide, not per account.

### 3. Proposed model

```
Cash and cash equivalents            (CASH — becomes a NON-POSTING header after cut-over)
├─ Cash — Riyad Bank Operating       (system-generated leaf, bank_account_id = 8105)
├─ Cash — Riyad Bank Payroll         (system-generated leaf, bank_account_id = 8106)
└─ Cash on hand                      (optional leaf, no bank_account_id — petty cash; §13)
```

There is **no "Other Bank" / "unassigned" leaf**, by design (§8).

- **One GL account per application bank account**, created by the platform when the bank account is created (and for every existing one at cut-over): `is_system = true`, `system_code = NULL`, `bank_account_id = <id>` (new, unique), `type = asset`, `liquidity_class = 'cash'`, `parent_id = CASH`. Renaming the bank account renames the leaf.
- **`parent_id` on categories** — the first hierarchy in the chart. Posting to a header is refused at the seam; reports roll children into the header.
- **Cash resolution in the seam.** A cash line is `{ bankAccountId }`, resolved to the leaf; the seam **refuses a cash line with no bank account** (the `PARTY_REQUIRED` construction). Receipts and disbursements take the bank from the payment (D-4); bank rows from `transactions.bank_account_id` (required at accept time); payroll from the run's paying account; transfers from both sides; opening entries from the bank account.
- **Transfers (G18)** post Dr leaf(B) / Cr leaf(A) once; imported rows on both sides *match* the transfer. **Bank fees** are accepted rows on the bank's leaf. **Reconciliation (G19)** is per leaf. **Opening balances (G2)** post Dr leaf / Cr Opening balance equity; `bank_accounts.balance` is read from the GL, never written.
- **Protection.** The existing trigger refuses delete and type/code change on system rows; a leaf cannot be deleted while its bank account exists; a bank account cannot be deleted while its leaf has lines (deactivate instead). `CASH` stays a system account, resolvable by code only for the reclassification entries and reports; after a company's cut-over the seam refuses new postings to it.

### 4. Alternatives considered

| Alternative | Trade-off |
| --- | --- |
| **B — one `CASH` account plus `bank_account_id` as a line dimension** (like AR/AP parties) | Least invasive, reports identical by construction, no hierarchy; but the trial balance shows one cash line and per-bank balances become a sub-report. The recorded fallback if hierarchy is deferred. |
| **C — user-created bank accounts in the chart, linked manually** | A link the user can forget; the seam could not refuse a cash line with no bank. |
| **D — remap historical lines' `account_id` to the leaves** | Rewrites posted lines — forbidden; §8's reclassification + annotation gives per-bank history without the mutation. |
| **E — infer the bank of a historical line from "the company had only one bank account then"** | **Rejected by the advisor:** the number of bank accounts is not evidence of which account a movement went through; a company with one recorded account may have moved cash through an unrecorded one, in cash, or through an owner's account. See §8. |

### 5. Recommendation

**Engineering judgement.** Option A (system-generated leaf per bank under a non-posting header; cash-line-without-bank inexpressible), cut-over by **reclassification entries** plus a **non-posting `bank_account_id` annotation** on historical lines. Option B is the fallback. Automatic historical mapping only on **deterministic source evidence**; everything else to human review.

**Accounting policy — confirmed by advisor.** Having exactly one bank account does **not** make it safe to map an old payment to that bank automatically. One-bank-only is not evidence.

**Accounting policy — advisor confirmation required.** (a) Each bank account as its own trial-balance / balance-sheet line under the header; (b) cash on hand / petty cash; (c) the cut-over reclassification's date; (d) whether historical lines annotated rather than moved is acceptable audit presentation.

### 6. Journal examples (SAR)

**Customer receipt into Riyad Operating:** Dr Cash — Riyad Bank Operating 3,450.00 / Cr Accounts Receivable — party: Najd 3,450.00.

**Supplier payment from Riyad Operating:** Dr AP — party: Tamimi 400.00 / Cr Cash — Riyad Bank Operating 400.00.

**Transfer Operating → Payroll, 5,000.00** (one entry; both imported rows match it and post nothing): Dr Cash — Riyad Bank Payroll 5,000.00 / Cr Cash — Riyad Bank Operating 5,000.00.

**Bank fee, 75.00, on Operating:** Dr Bank charges 75.00 / Cr Cash — Riyad Bank Operating 75.00.

**Accepted uncategorised row on Payroll, 250.00 credit:** Dr Cash — Riyad Bank Payroll 250.00 / Cr Suspense 250.00.

**Cut-over reclassification** (the company had CASH 61,140.50 on the header; every line resolved deterministically: Operating 61,140.50, Payroll 0.00):

| Account | Dr | Cr |
| --- | --- | --- |
| Cash — Riyad Bank Operating | 61,140.50 | |
| Cash and cash equivalents (header) | | 61,140.50 |

Header after: 0.00. Total cash before = 61,140.50 = after.

**Edge — a company with unresolved lines:** no reclassification is computed for it; it keeps working exactly as today (posting to the header) until its lines are resolved; cut-over is per company.

### 7. Database implications (conceptual)

- `categories.parent_id` (self FK, nullable), `categories.bank_account_id` (FK, unique, nullable), `categories.is_posting` (false for headers).
- `journal_entry_lines.bank_account_id` (FK, nullable) — the historical annotation and, after cut-over, a direct per-bank query key.
- `bank_accounts.gl_account_id` (FK to the leaf, unique), `bank_accounts.cut_over_journal_entry_id`, `bank_accounts.balance` retired from writes.
- `transactions.bank_account_id` required at accept time.
- `bank_transfers` (G18), `bank_reconciliations` (G19) reference leaves.
- `cash_cutover_runs` (company, dry-run report JSON, classification counts, overrides, state, committed_at, reversal ref).

### 8. Migration implications — LIVE DATA (the exact strategy)

Per company, fail-closed, two-phase: a **dry-run** that classifies every historical cash line and refuses on any blocking record, then a **transactional commit** that creates the leaves, annotates the lines, posts the reclassification and switches the seam for that company. No company is cut over implicitly.

**Two separate questions, never conflated (engineering judgement, following the advisor's guidance).**

- **Bank identity** — *which bank account did the money actually move through?* This is what the cash cut-over resolves. It establishes the **reconciliation target** for the line.
- **Payment identity** — *who paid or received the money, and which invoice/bill does it relate to?* This is D-4's question. **A bank relationship does not establish the customer, the invoice, or the accounting nature of the payment.** Two customers can pay SAR 5,000 on the same day into the same account; one deposit can cover several invoices; a partial payment need not equal an invoice total; a refund can look like a receipt; an owner's contribution can look like a customer receipt; other non-customer cash movements exist. Therefore *same bank + same amount + same date* identifies nothing about the counter-party, and resolving a line's bank never resolves its allocation.

**The automatic-mapping principle.** A historical cash line is mapped to a bank automatically **only when the bank identity is deterministically established by source evidence** — an explicit bank-account relationship on the source record, a source-system payment ID/reference, or a sufficiently unique source reference that reconciles deterministically. **Amount + date alone is never sufficient. One-bank-only is never sufficient. Nothing is guessed.** Anything short of deterministic goes to human review.

**Step 1 — discover bank accounts.** All `bank_accounts` of the company (active and inactive), with `created_at`.

**Step 2 — enumerate every historical cash line.** Every `journal_entry_lines` row whose `account_id` is the company's `CASH` account, any entry status (posted, reversed, `-REV` mirrors).

**Step 3 — classify every line.**

| Classification | Condition | Outcome |
| --- | --- | --- |
| **`DETERMINISTIC`** | the line's source carries an explicit bank relationship: (A1) a `TXN-…` posting whose transaction has `bank_account_id`; (A2) a payment posting (`GL-…-PAY-<pid>` / `BILL-…-PAY-<pid>`) whose invoice/bill is settled by a transaction with `settles_invoice_id/settles_bill_id` **and** a `bank_account_id`, with the settlement's date and amount equal to the payment row's; (A3) a `-REV` mirror or `TXN-<id>-P<n>` repost whose original is `DETERMINISTIC`; (A4) an **admin-supplied override** (`line_id → bank_account_id`, signed, with a stated basis) | mapped to that bank's leaf automatically |
| **`AMBIGUOUS_REQUIRES_REVIEW`** | no explicit bank relationship on the source, but the line is a well-formed cash movement (a Mark-Paid payment, a manual journal cash line, a manual transaction with `bank_account_id = NULL`) — **regardless of how many bank accounts the company had on that date** | **blocking**; listed for a human decision; the admin either supplies an override (→ A4) or records that the line belongs to no recorded bank (cash on hand, §13) |
| **`UNMAPPABLE`** | no valid bank relationship can be established and none can plausibly be supplied (the source record no longer exists; the line's source cannot be identified) | **blocking**; reported for remediation through the product; never assigned to any account |
| **`INCONSISTENT`** | the line's evidence contradicts itself: a `TXN-` reference whose transaction is missing; a payment entry with no payment row; a mirror whose `reversal_of` is absent; a settled transaction whose bank differs from an override; a settlement whose amount/date differ from the payment row | **blocking**; reported with both sides of the contradiction |

There is **no default-bank fallback** at any step (`is_default` is never consulted for history), **no single-bank inference**, and **no "Other Bank"**. The implementation may later refine these categories; the fail-closed principle does not change.

**Step 4 — the dry-run report** (stored on the run, downloadable), one row per cash line; for every non-deterministic row the **blocking-record fields**:

`record id (line_id) · journal entry id/number · payment id or transaction id where applicable · date · amount Dr/Cr · current GL account (CASH) · known bank account (if any) · candidate bank accounts (those existing on the date — listed for the reviewer's information, never used to decide) · mapping reason (the rule that matched, or none) · classification · blocking reason · required remediation` (e.g. "set bank_account_id on transaction 87827 through the product"; "supply an override for line 136904 stating the basis"; "source row missing — restore or mark unmappable").

Plus the plan: leaves to create; per-bank reclassification amounts (computed only over `DETERMINISTIC` lines, and shown as *provisional* while any blocking line exists); totals check (Σ CASH balance before = Σ planned leaf balances) — which by construction cannot hold while any line is unresolved, and the report says so.

**Step 5 — refusal.** The migration may proceed **only when zero `AMBIGUOUS_REQUIRES_REVIEW`, zero `UNMAPPABLE` and zero `INCONSISTENT` lines remain.** **No writes occur during a dry-run**, ever (asserted by row counts before/after). The admin remediates through the product or supplies overrides, re-runs the dry-run, and only a clean report can be committed; the commit re-runs the dry-run inside its transaction and refuses if the result differs from the stored report.

**Step 6 — transactional commit** (one Postgres transaction on the tenant connection): create the leaves and link `bank_accounts.gl_account_id`; annotate `journal_entry_lines.bank_account_id` for every historical cash line (**amounts and `account_id` untouched** — a new column filled, recorded as "annotated N lines"); post the reclassification through the seam (Dr leaf / Cr header per bank, dated on the cut-over date in an open period, `source = migration`, reference `CASH-CUTOVER-<company>`); mark the header non-posting for this company; assert the invariants below; any failure rolls back to nothing.

**Step 7 — opening balances.** Not part of the cut-over (G2 is a separate explicit act). **Step 8 — transfers.** Historical declared transfers are ordinary cash lines and classify like any other; no retro-linking. **Step 9 — reconciliation records.** None exist today; post cut-over the reconciliation runs per leaf, and for pre-cut-over history per annotated bank.

**Step 10 — proving reports are identical.** Computed by the dry-run and re-asserted by the commit: Σ(header + all leaves) after = Σ(CASH) before, to the halala, at every month-end since the first entry; trial balance total Dr/Cr before = after (+ the reclassification's equal Dr/Cr); balance-sheet cash, cash-flow net change and Finance Hub liquid assets byte-identical; every entry's Dr = Cr unchanged, proven by a checksum of `(line_id, debit, credit, account_id)` before vs after.

**Idempotency / re-run.** A committed company cannot be committed again (`gl_account_id` set → refused); dry-runs are re-runnable; a reversal of the cut-over (admin, audited) reverses the reclassification through the seam, clears `gl_account_id`, keeps the leaves and annotations, and re-enables the header — never deleting lines or entries. **Rollback on failure:** the single transaction.

**Expected consequence for the pilot's own data (worked honestly):** every Mark-Paid payment recorded on the pilot org carries no bank on its row and is not settled from a bank row, so each such cash line classifies `AMBIGUOUS_REQUIRES_REVIEW` and the pilot admin resolves them one by one with overrides (the pilot knows which account each went through) before that company can cut over. That is the intended behaviour, not a defect.

### 9. Reporting implications

Trial balance / balance sheet: header with leaves beneath; totals unchanged. General ledger / account statement: per leaf; the header shows only the reclassification and pre-cut-over history. Cash flow: unchanged in total. Reconciliation: per leaf. Aging, statements, VAT: unaffected.

### 10. Audit implications

The run record holds the classification of every line, the rule hit, every override with its author and stated basis, the leaves created, the annotation count and the reclassification entry number. Historical lines are never amended in amount or account. The reclassification is a normal posted entry undone only by its reversal.

### 11. Permission implications

Dry-run and commit: **admin**; view the report: admin and accountant; overrides: admin, each an audit row with a stated basis; create a bank account (and its leaf): **engineering judgement — narrow to admin/accountant** (it creates a GL account); delete a leaf directly: nobody; post to the header after cut-over: nobody.

### 12. Tests required

- Seam: cash line without a bank refused; resolves to the leaf; header refused after cut-over; parties untouched.
- Dry-run: one fixture per classification (A1–A4, each `AMBIGUOUS_REQUIRES_REVIEW` shape, `UNMAPPABLE`, each `INCONSISTENT` shape); **a one-bank company's Mark-Paid line classifies `AMBIGUOUS_REQUIRES_REVIEW`, not `DETERMINISTIC`** (the test that pins the advisor's rule); the report fields present per row; `blocked` when any non-deterministic line exists; **zero writes on every dry-run** (row counts asserted).
- Commit: the identical-reports assertions on a seeded two-bank company with settlements, reposts and reversals; checksum unchanged; commit twice → refused; reversal restores the header.
- Invariants: each leaf balance = Σ its lines; header + leaves = old CASH total; per-month cash unchanged.
- Permission/isolation: org B cannot dry-run org A; leaf not resolvable cross-org; accountant cannot commit.
- e2e: bank cards show GL balances; the classified report screen with the override flow; a payment choosing a bank posts to its leaf.

### 13. Accountant confirmation

1. Each bank account as its own chart account under "Cash and cash equivalents", on the trial balance and balance sheet — expected?
2. Cash on hand / petty cash: a leaf under the same header, or out of scope? (Also the resolution for an `AMBIGUOUS_REQUIRES_REVIEW` line the reviewer says went through no recorded bank.)
3. The reclassification entry dated on the migration day in the open period — acceptable, including for companies with closed months?
4. Historical lines keep "Cash and Bank" as their account and are *annotated* with the bank rather than moved — acceptable audit presentation?
5. An override's "stated basis" — is a free-text statement by the admin sufficient evidence, or should the platform require a reference (statement line, cheque number)?

---

## D-4 / G4 — Payments, allocations, unapplied receipts (and advances)

### 1. Problem

A payment today is a row on **one** invoice. A customer who pays 25,000.00 against three invoices, a customer who pays before an invoice exists, a customer who overpays, a supplier paid in one transfer for four bills — none can be recorded truthfully. Aging, statements and the customer balance describe a world in which every receipt already knows its invoice, and the refund of a credited-but-paid invoice has no path (the "refund dead end"). Advance payments — ranked second by the advisor among SME priorities — are the same fact pattern (cash in before an invoice) and must not need a second mechanism.

### 2. Current implementation

- **Current implementation fact.** `invoice_payments`: `invoice_id`, `amount`, `paid_at`, org/company — no party, no bank, no reference, no idempotency key. `bill_payments` mirrors it. `invoicesService.pay(id, {amount, paidAt})` refuses notes (409), drafts, paid invoices, non-positive amounts and `paid > outstanding` (outstanding = total − credit notes against this invoice − paid_amount); then updates `invoices.paid_amount/paid_at/status`, inserts the payment row, posts `GL-<inv>-PAY-<payment.id>` Dr CASH / Cr AR(party), audits. `billsService.pay` mirrors it (Dr AP / Cr CASH).
- **Current implementation fact.** No idempotency key on `pay`.
- **Current implementation fact.** A credit note reduces the outstanding of its **original** invoice only; no application elsewhere; no refund.
- **Current implementation fact.** B4 backfilled one **aggregate** payment row per invoice from `paid_amount` ("backfilled rows are aggregates" in `payments.ts`).
- **Current implementation fact.** Settlement from a bank row calls the same `pay` with the row's date and links the row; the bank is known through the row.
- **Current implementation fact.** Aging and the customer profile compute outstanding from `total − paid_amount` (aging also nets notes) — the denormalised column, not payment rows.

### 3. Proposed model

**Accounting policy — confirmed by advisor.** *An unapplied customer receipt is recorded as a liability (Customer deposit / Unapplied cash), not as a credit inside Accounts Receivable.* On receipt: Dr Cash / Cr Customer deposit. On later application to an invoice: Dr Customer deposit / Cr Accounts Receivable. The advisor described this as the expected KSA SME / audit practice and referenced IFRS 15's contract-liability treatment. **Scope of that reference, kept precise:** this is the advisor's recommended policy for *this product*; it does not assert that every unidentified customer receipt is a contract liability under IFRS 15 in every fact pattern — a receipt that is not consideration for a future performance obligation (a mistaken payment, a duplicate, an amount to be refunded) is a financial liability to repay rather than a contract liability, and the platform's account is a single "Customer deposits / unapplied cash" liability whose *financial-statement classification* in unusual cases is the accountant's assessment, not the platform's (**ACCOUNTING POLICY — ADVISOR CONFIRMATION / COMPANY ACCOUNTING POLICY**, §13).

**Accounting policy — confirmed by advisor.** *Carry-forward is the norm over refunding.* A customer with a credit and no open invoice keeps the credit on account by default; a refund is an explicit, controlled operation requiring authorisation and documentation; a refund settles the customer's existing credit balance; the original credit note is **never reversed** merely because a refund occurs.

**Two origins of a customer credit position, kept distinct (proposed model).** A **credit note** is a legal tax document (VAT effect at issue, ZATCA numbering, its own reversal of revenue and output VAT) whose unapplied remainder is a credit *on AR*. An **unapplied cash receipt** is a cash fact with no tax effect whose amount is a *deposit liability*. Both leave the customer in credit; they have different origins, different GL locations and different audit trails, and the platform never merges them into one "customer credit" figure without showing both parts. A refund of either is the same controlled operation, but its GL side differs (Dr AR for note credit; Dr Customer deposit for cash on account).

**Entities (Proposed model).**

- **Payment** — a receipt (customer) or a disbursement (supplier): party, direction, bank account (D-3 leaf), amount, date, method, reference, idempotency key (unique per company), source (manual, settlement row, refund, migration, legacy_aggregate), audit. On creation the platform posts **one** entry: the allocated part to the control account, the unapplied part to the deposit liability; it may be entered fully unallocated (an advance or an unidentified receipt) — the whole amount goes to the liability.
- **Payment allocation** — `(source, document, amount)`, source ∈ {payment, credit note, refund}; unique per (source, document); Σ allocations ≤ source amount; Σ allocations to a document ≤ its outstanding. An allocation of a *previously unapplied* amount **posts** Dr Customer deposit(party) / Cr AR(party); an allocation made at the moment of receipt is folded into the receipt entry.
- **Customer deposit / Unapplied cash** — a system liability account `CUSTOMER_DEPOSITS` (and `SUPPLIER_ADVANCES` on the AP side) carrying **parties**, so a party's deposit balance is a GL fact: Σ its lines. **Advance payments use exactly this account and this allocation model** — an advance is an unapplied receipt whose later allocation is to the invoice it pre-paid. (The *VAT* consequence of an advance — VAT due on the earlier of payment and invoice — is D-7 and is not designed here; the deposit line already carries the party and the date, which is what a prepayment VAT entry needs.)
- **Credit note credit** — a note is an allocation *source*: applying it to an open invoice posts nothing (the note credited AR at issue); a note's unapplied remainder is customer credit on AR. **ACCOUNTING POLICY — ADVISOR CONFIRMATION:** whether unapplied note credit should be transferred to the deposit liability when no open invoice exists (Dr AR(party) / Cr Customer deposit(party), on the accountant's action), or left on AR until applied.
- **Refund** — a controlled disbursement to a customer that settles their existing credit balance: Dr Customer deposit(party) / Cr Cash(bank) for cash on account; Dr AR(party) / Cr Cash(bank) for note credit still on AR. Requires authorisation and a documented reason (§11); allocated against the credits it returns; never reverses the note.
- **Over-payment** — the excess beyond the documents' outstanding is unapplied: Cr Customer deposit(party) at receipt; no special state.
- `POST /invoices/{id}/pay` stays as a convenience creating a payment + one allocation (the pilot's Mark Paid, settlements and existing tests keep their behaviour); it gains a bank account and an idempotency key.

**The situations, distinguished.**

| # | Situation | GL | Subledger |
| --- | --- | --- | --- |
| 1 | Receipt from a customer, no allocation yet | Dr Cash / Cr Customer deposit(party) | payment; unapplied = amount; party deposit balance up |
| 2 | Allocated to one invoice at receipt | Dr Cash / Cr AR(party) | payment + allocation; invoice outstanding down |
| 3 | Allocated across invoices at receipt | as 2, one entry | several allocations |
| 4 | Unapplied receipt (no invoice) — *including an advance* | as 1 | on-account (deposit) balance; statement shows it as a credit; **AR unaffected** |
| 5 | Over-payment | Dr Cash / Cr AR(party) [outstanding] + Cr Customer deposit(party) [excess] | allocations to outstanding; excess unapplied |
| 6 | Later allocation of an unapplied amount | Dr Customer deposit(party) / Cr AR(party) | allocation; invoice outstanding down; deposit down |
| 7 | Refund | Dr Customer deposit(party) / Cr Cash(bank) (or Dr AR(party) for note credit) | refund allocated to the credit returned; deposit/credit down |
| 8 | Credit-note application | nothing (posted at issue) | allocation from the note; invoice outstanding down; note remaining down |

**Automatic matching in future operations — the engineering principle (not implemented in Batch 1 or 2; recorded so the later matching engine is designed against it).** Automatic matching of a bank row or a receipt to a payment/allocation may occur **only when the evidence uniquely identifies the intended payment and allocation.** Signals a matching engine may combine: amount, date, bank account, customer, invoice reference, transaction reference, source-system ID, payment reference. **Amount + date alone is never sufficient.** The engine must have a **deterministic uniqueness / confidence policy** (a documented rule that says which combination of signals counts as unique, never a tunable score alone), must send every non-unique case to **human review as a suggestion the human clicks** (CLAUDE.md §9: suggestions are pre-selected, the human clicks), and must never create an allocation by nearest date, by "first matching invoice", or by amount alone. Do not build this engine now.

### 4. Alternatives considered

| Alternative | Trade-off |
| --- | --- |
| **Option A — unapplied receipt as a credit inside AR** (the register's earlier proposal) | One entry per receipt, no liability account; but AR is stated net of customer money and a customer whose credits exceed invoices shows a net credit receivable that must be reclassified at period end — **rejected by the advisor's stated policy** for this product. |
| Per-invoice "split payments" without a payment entity | Unapplied receipts still have nowhere to live; refunds have no object. |
| Treat every unapplied amount as a credit note | Conflates a legal document (VAT, ZATCA numbering) with a cash fact. |
| A separate "advance payment" document type | A second mechanism for the same fact pattern; rejected — advances are unapplied receipts with a later allocation (their VAT treatment is D-7's addition on top, not a different subledger). |

### 5. Recommendation

**Engineering judgement.** The payment/allocation entities; the deposit liability as a party-carrying system account; allocation of previously-unapplied amounts posting the deposit→AR transfer; `pay` preserved as a convenience; idempotency keys on every payment/allocation/refund; one `partyLedger` read for balance, aging and statement (G13/G14); refunds gated by authorisation and reason; the same model reused for advances and for supplier advances; the automatic-matching principle above.

**Accounting policy — confirmed by advisor.** The liability treatment of unapplied receipts; carry-forward as the default; controlled refunds that settle the credit balance without reversing the note.

**ACCOUNTING POLICY — ADVISOR CONFIRMATION / COMPANY ACCOUNTING POLICY.** Placement of unapplied note credit; the refund approval and accounting workflow (who, and above what amount a second approval); the treatment of **unusual customer receipts** (mistaken, duplicate, from a non-customer, owner contributions that arrive looking like receipts); the supplier mirror (`SUPPLIER_ADVANCES`); aging presentation (§9).

### 6. Journal examples (SAR)

Notation: `AR(N)` = Accounts Receivable, party Najd; `Dep(N)` = Customer deposits / unapplied cash, party Najd; `Bank` = Cash — Riyad Bank Operating (D-3).

**Normal receipt** — Najd pays INV-2026-000008, 3,450.00, allocated at receipt.
GL: Dr Bank 3,450.00 / Cr AR(N) 3,450.00. Subledger: P1 3,450.00 → INV-008 3,450.00; outstanding 0.00; paid.

**Partial** — Najd pays 1,000.00 against INV-008.
GL: Dr Bank 1,000.00 / Cr AR(N) 1,000.00. Subledger: P2 → INV-008 1,000.00; outstanding 2,450.00; sent (part-paid derived).

**One receipt, several invoices** — 25,000.00 for INV-003 (20,015.00 outstanding) and INV-005 (17,250.00).
GL: Dr Bank 25,000.00 / Cr AR(N) 25,000.00. Subledger: P3 → INV-003 20,015.00, → INV-005 4,985.00; INV-003 paid; INV-005 outstanding 12,265.00.

**Unapplied receipt (the advisor's example)** — a customer pays 5,000.00 without specifying an invoice.
GL: **Dr Bank 5,000.00 / Cr Dep(customer) 5,000.00.** Subledger: P4 unapplied 5,000.00; deposit balance 5,000.00; **AR unchanged**; the statement shows "Receipt on account — 5,000.00 Cr"; aging unchanged.

**Later allocation of the unapplied receipt** to INV-005 (12,265.00 outstanding).
GL: **Dr Dep(customer) 5,000.00 / Cr AR(customer) 5,000.00.** Subledger: allocation P4 → INV-005 5,000.00; outstanding 7,265.00; deposit 0.00.

**Advance payment** — Najd pays 10,000.00 on 1 Sep for work to be invoiced in October.
GL on 1 Sep: Dr Bank 10,000.00 / Cr Dep(N) 10,000.00 (identical to the unapplied receipt). On 10 Oct the invoice INV-2026-000012 (11,500.00) is issued: Dr AR(N) 11,500.00 / Cr Sales 10,000.00, Cr VAT output 1,500.00 (the normal issue entry); allocation of the advance: Dr Dep(N) 10,000.00 / Cr AR(N) 10,000.00; outstanding 1,500.00. *(Whether VAT on the 10,000.00 was due in September at receipt, and how the October invoice then presents the prepayment, is D-7 — the mechanism above does not decide it and does not prevent it.)*

**Over-payment** — Najd pays 4,000.00 against INV-008 whose outstanding is 2,450.00.
GL: Dr Bank 4,000.00 / Cr AR(N) 2,450.00 / Cr Dep(N) 1,550.00. Subledger: P5 → INV-008 2,450.00 (paid); P5 unapplied 1,550.00; deposit 1,550.00. The API never refuses the receipt; it refuses an *allocation* beyond outstanding.

**Carry-forward (default)** — Najd has 1,550.00 on deposit and no open invoice: nothing happens; the balance stays, shown on the statement and the customer profile, applied to the next invoice.

**Refund (controlled)** — the 1,550.00 is returned to Najd from the bank, authorised with a documented reason.
GL: Dr Dep(N) 1,550.00 / Cr Bank 1,550.00. Subledger: refund R1 allocated to P5's unapplied 1,550.00; deposit 0.00.

**Credit note applied against an outstanding receivable** — CN INV-2026-000010 (345.00, issued against the already-paid INV-003) applied to INV-005 (7,265.00 outstanding).
GL: nothing now (at issue: Dr Sales 300.00, Dr VAT output 45.00 / Cr AR(N) 345.00). Subledger: allocation CN-010 → INV-005 345.00; outstanding 6,920.00; note fully applied.

**Credit note with no open invoice, refunded (controlled)** — the note's 345.00 credit sits on AR(N) as a credit; refund: Dr AR(N) 345.00 / Cr Bank 345.00; the note is **not** reversed; state *refunded*.

**Supplier mirror** — one transfer of 13,064.00 pays TAM-2210 (10,925.00) and GOS-4620 (2,139.00): Dr AP(Tamimi) 10,925.00, Dr AP(Gulf) 2,139.00 / Cr Bank 13,064.00 — two payments (one party each), each fully allocated; the bank row matches both. An unapplied supplier payment would be Dr Supplier advances(party) / Cr Bank (**confirmation required**).

### 7. Database implications (conceptual)

- `payments`: id, org, company, `direction`, `party_type`, `customer_id`/`vendor_id`, `bank_account_id` (D-3 leaf), `amount`, `date`, `method`, `reference`, `idempotency_key` (unique per company), `source`, `journal_entry_id`, `source_transaction_id`, `legacy_row_id` (unique), created_by/at; immutable after creation except through allocations.
- `payment_allocations`: id, org, company, `source_type` (payment / credit_note / refund), `source_id`, `document_type` (invoice / bill / payment / credit_note), `document_id`, `amount`, `journal_entry_id` (set when the allocation posted the deposit→AR transfer), `allocated_by/at`; unique (source_type, source_id, document_type, document_id); amount > 0.
- `refunds`: id, org, company, party, `bank_account_id`, amount, date, reason, `approved_by/at`, `journal_entry_id`, idempotency key.
- System accounts `CUSTOMER_DEPOSITS` (liability, party-carrying) and `SUPPLIER_ADVANCES` (asset, party-carrying, pending confirmation) — both added to the seam's `PARTY_REQUIRED` set; seed-trigger rule.
- Derived: `invoices.paid_amount` / `bills.paid_amount` maintained as caches asserted equal to Σ allocations (dropped later).
- `invoice_payments` / `bill_payments`: retained read-only for one release as the backfill's evidence, then dropped.

### 8. Migration implications — LIVE DATA (the exact strategy)

Per company, fail-closed, two-phase. Source rows: every `invoice_payments` and `bill_payments` row. **The backfill posts no journal entries** (every legacy payment was already posted Dr Cash / Cr AR at the time; there were no unapplied receipts in the old model, so nothing lands on the new deposit account).

**Eight identities, each established separately (engineering judgement, following the advisor's guidance).** For every historical payment the dry-run must establish, independently and from source evidence — never by inference from one another:

1. **payment existence** — a source row and the GL entry it produced;
2. **bank / cash source** — which bank account (D-3's question; its classification is carried over, not re-derived);
3. **customer / supplier identity** — the party the money came from or went to;
4. **invoice / bill relationship** — the document(s) the payment settles;
5. **amount**;
6. **date**;
7. **payment direction** (receipt vs disbursement vs refund);
8. **accounting treatment** (an ordinary settlement; an advance; an over-payment; a refund; a non-customer movement).

**A successful bank mapping does not imply a successful allocation.** A record that reads *Bank = Riyad Bank Operating · Date = 2026-01-15 · Amount = SAR 5,000* establishes identity 2, 5 and 6 and **nothing else**; it is not enough to create *Customer X → Invoice Y → SAR 5,000* unless the source provides deterministic evidence for 3, 4, 7 and 8. Conversely today's `invoice_payments` row establishes 1, 3 (through the invoice), 4, 5, 6 and 7 deterministically — because the old model *stored* the invoice — while identity 2 (bank) is D-3's classification, and identity 8 is "ordinary settlement" by construction of the old model (there was no other kind).

**No guessed allocations. No nearest-date matching. No "first matching invoice". No amount-only matching. No single-bank inference.**

**Per row, the dry-run resolves, in order:**

1. **Source event.** The row and its GL entry by number (`GL-<invoiceNumber>-PAY-<row.id>` / `BILL-<billNumber>-PAY-<row.id>`); a row with no entry by that number is **`INCONSISTENT`** unless it is a B4 aggregate (8).
2. **Party.** The invoice's `customer_id` (bill's `vendor_id`) — deterministic through the stored document; NULL on a simplified/B2C invoice → party `none` (allowed, reported).
3. **Amount.** `row.amount` > 0 and equal to the entry's cash-line amount, else `INCONSISTENT`.
4. **Currency.** SAR (the write boundary); anything else `INCONSISTENT`.
5. **Date.** `row.paid_at` = the entry's date, else `INCONSISTENT`.
6. **Bank.** The D-3 classification of the entry's cash line: `DETERMINISTIC` (settlement link A2, or the D-3 annotation if the cash cut-over already ran) → carried; `AMBIGUOUS_REQUIRES_REVIEW` → **blocks this row** until an override names the bank; `UNMAPPABLE` / `INCONSISTENT` → blocks with the D-3 remediation.
7. **Document.** The row's `invoice_id` / `bill_id`; missing → `INCONSISTENT`.
8. **Create the payment** (`source = 'legacy'`, or `'legacy_aggregate'` for a B4 aggregate — carried as one payment dated on the last receipt, labelled, never split), linking `journal_entry_id`, `legacy_row_id` and the bank.
9. **Create the allocation** payment → document for the full row amount (unapplied = 0).
10. **Preserve evidence.** `legacy_row_id`, the original `paid_at`, the existing `pay` audit rows (untouched); the run record lists every created payment/allocation with its source row, its bank classification and the evidence for each of the eight identities.

**Worked example.** INV-2026-000008 total 3,450.00; one row of 1,000.00 dated 2026-09-16; entry `GL-INV-2026-000008-PAY-3442` Dr CASH 1,000.00 / Cr AR(Najd). Identities: 1 ✓ (row + entry), 3 ✓ Najd (through the invoice), 4 ✓ INV-008, 5 ✓ 1,000.00, 6 ✓ 2026-09-16, 7 ✓ receipt, 8 ✓ ordinary settlement; **2 — `AMBIGUOUS_REQUIRES_REVIEW`** (Mark Paid recorded no bank; the row was not settled from a bank row; the company having one recorded account decides nothing). Result: **this row blocks the company's backfill until the admin records the bank by override.** After the override: payment P (receipt, Najd, 1,000.00, 2026-09-16, bank = the override's account, `journal_entry_id` = that entry, `legacy_row_id` = the row); allocation P → INV-2026-000008 = 1,000.00; outstanding 2,450.00 (= before); `paid_amount` 1,000.00 (= before).

**Ambiguous or inconsistent data — none is guessed:**

| Condition | Dry-run outcome |
| --- | --- |
| Payment has no invoice reference | impossible for today's tables (NOT NULL FK); any future source → `UNMAPPABLE`, remediation "assign the document with evidence, or mark as on-account (admin override)" |
| Invoice no longer exists | `INCONSISTENT` — refuse; remediation: restore, or an admin override marking the row as an on-account deposit for the party |
| Customer cannot be resolved | B2C → party `none`, reported; otherwise `INCONSISTENT` |
| Amount ≤ 0, ≠ the entry's cash amount, or non-SAR | `INCONSISTENT` — both the row and the entry listed |
| Possible duplicate (same invoice, amount, date; two rows, two entries) | reported as a warning, not blocking by itself (two identical real receipts can exist) |
| Σ payments to a document > total − notes (historical over-allocation) | `INCONSISTENT` — refuse; the accountant decides per row which becomes an on-account deposit (override) |
| Multiple customers/invoices plausible for a future-source row | `AMBIGUOUS_REQUIRES_REVIEW` — never resolved by amount, date or "first match" |
| Bank missing | `AMBIGUOUS_REQUIRES_REVIEW` (per D-3) — never resolved by one-bank-only |
| Source records internally inconsistent (`paid_amount` ≠ Σ rows; `paid` with outstanding > 0; entry reversed but row present) | `INCONSISTENT` — both sides listed; a human decision recorded as an override |

**If the dry-run finds any blocking row: NO WRITES OCCUR.** The report is stored; the admin remediates through the product or supplies overrides; the dry-run is repeated; only a clean dry-run can be committed, and the commit re-runs it inside the transaction and refuses on any difference.

**Rollback:** one transaction per company; any invariant failure leaves no payments, no allocations, no marks. **Idempotency:** `legacy_row_id` unique → a re-run cannot create a second payment for a row; a committed company is refused a second commit; dry-runs are always re-runnable; no journal entry is ever created by the backfill, so no GL effect can double.

**Post-migration invariants (asserted inside the commit and by the suite afterwards):** Σ payments = Σ legacy rows (per company, per party); Σ allocations = Σ payments (every legacy payment fully allocated; unapplied = 0; deposit account untouched); every document's outstanding by allocations = total − notes − old `paid_amount`; statuses unchanged; GL AR control = Σ party balances; AP likewise; aging buckets identical before/after; customer/supplier balances identical; TB, balance sheet, cash flow, VAT byte-identical.

### 9. Reporting implications

- GL / trial balance / balance sheet: the deposit liability appears as its own line; AR is **gross** of customer money; an allocation of an unapplied amount moves the liability to AR.
- AR / AP: the subledger becomes the single definition (G13): a party's receivable = Σ document outstanding; the party's deposit balance is shown beside it, **not netted into AR**; the party's unapplied note credit is shown as its own figure.
- **Aging excludes the deposit liability from AR** (the advisor's requirement): aging buckets contain document outstanding only; the party's unapplied deposit is shown as a separate "on account" figure so the aging total equals GL AR. **ACCOUNTING POLICY — ADVISOR CONFIRMATION:** whether the aging report shows the on-account column, and whether net exposure (receivable − deposit) is shown as a memo figure.
- Statements (G14): receipts appear on their dates with their allocations; unapplied receipts appear as credits with a running "on account" balance; refunds appear as debits against it; the closing balance = receivable − deposit, presented as two figures and a net.
- Bank / reconciliation: a payment names its bank; a bank row matches a payment directly.
- VAT: unaffected by allocation and refunds (the note carried the VAT); the advance-payment VAT timing is D-7.

### 10. Audit implications

A payment is immutable once created; a wrong payment is reversed (a reversing payment through the seam, linked) and re-entered. Allocations are append-only acts with actor/time; unapply is a negating row, never a delete. Refunds record authorisation, reason and the credits they return, and link the note they settle without touching it. Every legacy payment carries its source row id, entry number, bank classification and the evidence for each identity. The `pay` audit rows remain the pre-migration history.

### 11. Permission implications

- Record a receipt/disbursement (posts to the GL): accountant, admin.
- Allocate / unapply: accountant, admin.
- **Refund:** requires authorisation — **engineering judgement:** created by accountant or admin and approved by a *different* admin/accountant (two-person), with a reason and the bank account named; **ACCOUNTING POLICY — ADVISOR CONFIRMATION:** whether a value threshold triggers the second approval or every refund needs it.
- Run the backfill: admin; view its report: admin, accountant. Viewer: read only.

### 12. Tests required

- Service: every example above as a fixture (GL effect, allocation rows, outstanding, status, party receivable and deposit balances, aging, statement line); over-allocation refused; allocation beyond the source refused; refund beyond the credit refused; refund without authorisation refused; the note untouched by a refund; B2C receipt with party `none`; the advance example end to end (receipt → invoice → allocation).
- Idempotency: payment/allocation/refund twice with one key → one effect.
- Invariants: GL AR(party) = Σ document outstanding(party); GL deposits(party) = Σ unapplied(party); AP likewise; `paid_amount` cache = Σ allocations.
- Backfill dry-run: one fixture per row in §8; `blocked` → zero writes; **a one-bank company's Mark-Paid row blocks (`AMBIGUOUS_REQUIRES_REVIEW`) until overridden**; clean → commit; the post-migration invariants; rerun refused; no journal entry created; **a grep-style test that the backfill and any matcher contain no nearest-date, amount-only or default-bank rule**.
- Permission/isolation: bookkeeper cannot record; refund needs two people; org B cannot allocate to org A's invoice (presence/absence/movement).
- e2e: receive-payment page (multi-invoice, unapplied remainder), advance receipt then invoice, credit application, refund with authorisation, in both languages; Mark Paid unchanged for the pilot flows.

### 13. Accountant confirmation

1. Unapplied credit-note balances: transfer to the deposit liability when no open invoice exists, or leave on AR as the party's credit until applied?
2. Refund control: two-person authorisation on every refund, or only above an amount — and if so, which amount? And the accounting workflow: reason codes, documentation retained, whether a refund may be partial.
3. Unusual customer receipts: a mistaken or duplicate payment, a receipt from a non-customer, an owner's contribution that arrives looking like a receipt — recorded on the deposit liability and reclassified by the accountant, or refused at entry until classified?
4. Supplier side: an unapplied supplier payment as an *advance to vendor* asset with party, mirror of the customer model — confirm.
5. Aging presentation: on-account deposit as a separate column, a memo net-exposure figure, or hidden from aging entirely?
6. B4 aggregate legacy rows carried as one payment dated on the last receipt, labelled — acceptable?
7. Historical over-allocation: the accountant decides per row (override) — confirm.

---

## D-5 — Period states, correction dating, and reversal dating

### 1. Problem

The platform has one binary lock per company-month enforced in one place — `checkPeriodOpen` inside `postJournalEntry`. Two paths do not go through it: the journal reversal writes rows directly, dated "today", with party columns dropped and no lock check; and the transaction correction (reverse-and-repost) dates its mirror today, leaving a ±x gap across two months' cash reconciliation. There is no "closing" state for the weeks when a month is being finalised, and the *accounting* question — where a prior-period error is corrected — has been answered by the mechanism ("today") instead of by policy.

### 2. Current implementation

- **Current implementation fact.** `period_locks` (org, company, `period` YYYY-MM, `locked_at`, `notes`), unique per company-period; `periodLocksService.lock/unlock` admin-only and audited; `checkPeriodOpen(date)` throws `PeriodLockedError` (423 `period_closed`) matched on the request's company GUC, called by `postJournalEntry` before any insert; document creation paths pre-check the period on the document date.
- **Current implementation fact.** `journalEntriesService.reverse` (`journalEntries.service.ts:276–312`): inserts the mirror via `insertEntry` + `insertLines` directly (**not** the seam), `date = businessToday()`, swaps Dr/Cr, **omits party columns**, runs **no** period check, accepts any posted entry including document-generated ones; reachable by `POST /journal-entries/{id}/reverse` (approve roles); the transaction delete and repost paths call it.
- **Current implementation fact.** `transactionPosting.repost` = `reverse` (today) then `post` on the row's own date.
- **Current implementation fact.** No representation of a **filed** VAT return exists; the VAT page computes the return from documents for any period.
- **Current implementation fact.** Tests: `period-locks`, `closed-months`, `bulk-accept-closed-period`, `manual-transaction-posts` (closed period), `transaction-delete-reverses`; none asserts the reversal's period or party.

### 3. Proposed model

**Three separate things, kept separate.** The **period state** is a technical control on *when* the ledger may change. The **accounting correction treatment** is a policy on *how* an error is corrected, and it depends on **materiality** (confirmed). The **VAT-return correction** is a *tax workflow* under the applicable ZATCA rules, and it is not the same operation as either. The platform never conflates the three: a period being open does not make a material prior-period error a current-period matter; a VAT return being filed does not by itself decide the accounting treatment; a material accounting error can require retrospective financial-statement treatment even though the VAT side follows its own process; and no correction is ever a bypass of a closed period.

**Period lifecycle (per company-month) — engineering control:**

| State | Meaning | Posting | Who changes it |
| --- | --- | --- | --- |
| **Open** | the working period | any writer the matrix permits | — |
| **Soft close** ("closing") | the month is being finalised; figures provisional | **new** documents, payments, bank acceptances dated in it are refused (423 `period_closing`); drafts dated in it cannot be approved; **corrections and reversals** through the correction workflow are allowed with a stored reason, by the roles the policy permits | admin opens / soft-closes / reopens; audited |
| **Closed** | figures final | **nothing** posts, no role, no exception; a correction is routed to the correction workflow, which chooses *current period* or *controlled reopening* by policy | admin closes; reopen is a distinct, audited administrative override with a reason, permitted only where the policy allows |

**One seam, no bypass — engineering control.** Every insert into `journal_entries`/`journal_entry_lines` goes through `postJournalEntry`, including the reversal (lines rebuilt with Dr/Cr swapped, **parties and bank carried**, `source = 'reversal'`, `reversal_of`); the seam applies the state rules. A test enumerates every writer of the two tables and asserts it is the seam. Reversal of a document-generated entry is **refused** (409 naming the document's correction route); only `source = manual` entries reverse directly.

**The accounting correction treatment — materiality.**

- **Accounting policy — confirmed by advisor.** A **material** prior-period error is corrected **retrospectively**: the prior period's figures are restated and the effect is taken to **opening retained earnings** — never simply pushed through the current period's P&L. An **immaterial** prior-period error is **reversed and re-entered in the current period** under the approved accounting workflow.
- **ACCOUNTING POLICY — ADVISOR CONFIRMATION / COMPANY ACCOUNTING POLICY.** *What is material* is an accounting judgement under the applicable framework and the company's own policy. **The platform hard-codes no universal materiality threshold.** If a per-company figure is exposed, it is the company's own setting with the accountant's sign-off, never a platform default; the alternative — a judgement prompt with no figure — is equally acceptable to engineering. Which one, and the retrospective mechanics on this platform (reopen-and-restate vs an adjusting entry against opening retained earnings dated in the current period with a documented restatement), are the accountant's to define (§13).

**The correction workflow — the routes it must distinguish (proposed model; the treatment within each is policy):**

| Route | When (policy decides) | Mechanism |
| --- | --- | --- |
| **Immaterial current-period correction** | the error is immaterial | reverse and re-enter in the **current open period**, `corrects_entry_id` naming the original; the reconciliation and statements show a named "correction of <period>" line |
| **Material prior-period correction** | the error is material | corrected **retrospectively** with the effect on opening retained earnings recorded; mechanically a controlled reopening or an adjusting entry against opening retained earnings with the restatement documented — **which, and how restated statements are presented, is the accountant's workflow (§13)** |
| **VAT-return correction** | the error changed a filed return's figures | a **separate tax workflow** (below); the platform records the filed status, evaluates the **configured tax rule**, and routes the user; it does not file |
| **Administrative override / reopening** | policy permits (e.g. statements not yet issued) | admin reopens with a reason; the period behaves as *soft close*; re-closing is a new audited act |

**VAT-return correction — the current ZATCA rule, verified from the primary text (2026-09-16).**

*Source read:* the **Implementing Regulations of the VAT Law, Tenth Edition, Shawwal 1446 / April 2025** (Arabic, the authoritative text), published by ZATCA at `https://zatca.gov.sa/ar/RulesRegulations/Taxes/Documents/Implmenting%20Regulations%20of%20the%20VAT%20Law.pdf`, consolidated through Board Resolution **(01-06-24) of 17 Jumada I 1446 / 19 November 2024** (title page lists every amending resolution). Article 63 (المادة الثالثة والستون) with its before/after amendment table is at **pp. 129–132**; footnotes 221, 223, 225 and 226 attribute the current wording of paragraphs 1, 3, 2 and 4 to Resolution 01-06-24. The secondary sources consulted (ZATCA's April 2025 *Guideline for Amendments*, §2.12; EY/PwC/Andersen/Dhruva alerts of April–May 2025) agree with the primary text; the primary text governs. *(The regulation PDF is not saved into the repository by this task — documentation-only constraint; save it beside the 2021 English edition in `docs/zatca/specs/` when the tax rule is built.)*

*What the amended Article 63 says (my reading of the Arabic; the 2021 English Eighth Edition is superseded on this article):*

| Para | Current ZATCA rule — verified from the primary text |
| --- | --- |
| **1** | A taxable person who filed a return and later finds an error by which it declared **less** than the net tax due must **notify the Authority within twenty (20) days** of becoming aware, and does so **by correcting the previously filed return**. |
| **2** | An error by which it declared **more** than the net tax due may be corrected by **deducting** the amount from the net tax due in **any subsequent return** after the discovery, subject to para 4. |
| **3** | As an exception to para 1, an understatement whose **net value is less than fifteen thousand (15,000) riyals** may be corrected by **adding** that amount to the net tax due in the return filed **for the tax period in which the error was discovered**. (The before/after table shows the threshold raised from 5,000 to 15,000 by an earlier amendment; Resolution 01-06-24 restated the paragraph with the "period of discovery" mechanism.) |
| **4** | No correction relating to an error that overstated net tax due after **five (5) years** from the end of the calendar year in which the tax period falls. |

*So the accountant's refined guidance is confirmed on the primary text:* under SAR 15,000 → the return of the discovery period ("the next return" in practice); SAR 15,000 or more → notify within 20 days by amending the original return (ZATCA e-service "VAT Return Amendment", zatca.gov.sa → E-services → VAT → Returns). **Two corrections to the informal notes, recorded so they are not repeated:** (a) the **SAR 10,000** in ZATCA's April 2025 guideline is **Example 25 under §2.12 "Provisions on Correcting VAT Returns"** — a worked understatement example below the threshold, not a registration figure; (b) the **penalty percentages** the accountant described (a base 25% of the difference, up to 50% or down to 0% by circumstances/compliance history) sit in the **VAT Law and ZATCA's penalty practice, which were not read** — they are recorded as **unverified** and are not modelled.

*Also verified from the same primary text:* **Article 54(6)** (p. 125, footnote 213 = Resolution 01-06-24): credit and/or debit notes must be issued **within fifteen (15) days of the month following** the event that requires them. This bears on the credit-note correction route: the platform surfaces the event date and this deadline (informational until the accountant confirms enforcement).

*Architecture requirement — a versioned, configurable tax workflow rule (engineering judgement; not implemented now, no configuration table now).* The VAT-correction routing is modelled as a **tax rule record**, never as `15000` in accounting logic. Conceptually the rule carries: `jurisdiction` (SA) · `tax_type` (VAT) · `rule` (return-correction routing) · `threshold` (15,000) · `comparison` (net value < threshold) · `basis` (net tax due of the period) · `correction_mechanism` (below: add to net tax due in the return for the discovery period; at/above: amend the original return) · `notification_deadline` (20 days from awareness, at/above) · `look-back limit` (5 years from the end of the calendar year, for overstatements) · `effective_from` (the resolution's effect date, 18 April 2025 per the Official Gazette publication) · `source` (Implementing Regulations Art. 63 paras 1–4) · `source_version` (Tenth Edition, April 2025; Resolution 01-06-24) · `applicable_conditions` (understatement vs overstatement; the note-issuance window of Art. 54(6) as a related rule) · `verified_by/at`. The accounting core never reads the number; the tax workflow reads the rule current on the discovery date and shows its source. When ZATCA changes the article, a new rule version is added with its own effective date; nothing in the ledger changes. **Until that rule record exists, the UI names the routes and the accountant chooses.**

*Engineering implementation decision:* the platform **represents filed status** per company and VAT period (`filed_at`, `filed_by`, the filed figures snapshot, later `correction_reported_via`) so that a correction touching a filed period is **routed** to the tax workflow ("this period's return was filed on <date>; the correction changes net tax due by SAR x — the configured rule says: <route>, source Art. 63(3), Tenth Edition"). It **never files**, never decides silently, and never treats an accounting-period correction as a VAT-return correction or vice versa.

**Correction dating rules (engineering mechanics, applied once in the seam's callers, never per page):**

- Reversal of a manual entry in an **open or soft-closed** period: dated on the original entry's date (proposed default; policy confirms).
- Correction routed to the **current period**: reversal and replacement dated the same business day, `corrects_entry_id` set, so the per-month cash gap is zero and the account movement lands, named, in the correction period (this fixes the sanity-walk ±75 case).
- `repost` of a bank row follows the same rule: both halves dated in the row's period if open/soft-closed, else both in the current period.

### 4. Alternatives considered

| Alternative | Trade-off |
| --- | --- |
| Keep the binary lock, fix only the reversal bypass | Closes the integrity hole; leaves no soft close and no correction routing. |
| Date every reversal "today" | The current behaviour; a January error corrected in February distorts both months and the reconciliation. |
| Always reopen and correct in the original period | Rewrites issued statements silently; ignores materiality. |
| Route corrections by VAT filed status alone | Rejected by the advisor: accounting correction depends on materiality; VAT filing is a separate question. |
| Hard-code `15000` in accounting logic | Rejected: a regulatory constant with an effective date and a source belongs in a versioned tax rule the tax workflow reads, never in the ledger's code; the threshold has already changed once (5,000 → 15,000). |
| Hard-code a materiality threshold | Rejected: materiality is a judgement under the accounting framework and the company's policy. |

### 5. Recommendation

**Engineering control.** Three states; every write through the one seam; `reverse` rebuilt on the seam with parties and bank; `source` on entries; document-generated entries not reversible; the correction workflow with its four routes as *distinct, named operations*; correction dating rules encoded once; filed VAT status represented; the versioned tax-rule architecture; reopening as an audited override; no tax or materiality threshold in accounting code.

**Accounting policy — confirmed by advisor.** Correction treatment depends on **materiality**: material prior-period errors are corrected retrospectively with the effect on opening retained earnings, not through current P&L; immaterial errors are reversed and re-entered in the current period. VAT-return correction is handled separately under the applicable ZATCA rules.

**Current ZATCA rule — verified from the primary text.** Article 63 as amended (Resolution 01-06-24): 20 days / SAR 15,000 / period-of-discovery return / 5 years; Article 54(6): 15 days for notes.

**ACCOUNTING POLICY — ADVISOR CONFIRMATION / COMPANY ACCOUNTING POLICY.** The materiality policy the product exposes; the retrospective mechanics on this platform; who may correct in a soft-closed month; the penalty treatment (unverified) and any other ZATCA detail not directly established by the text read.

### 6. Journal examples (SAR)

**Immaterial error, January soft-closed:** `JE-0042` 31 Jan Dr Bank charges 75.00 / Cr Cash — Operating 75.00 was a telecom bill. Reversal `JE-0042-REV` dated **31 Jan** (reason stored): Dr Cash — Operating 75.00 / Cr Bank charges 75.00; replacement `JE-0057` 31 Jan: Dr Telecommunications 75.00 / Cr Cash — Operating 75.00. January corrected in January.

**Immaterial error, January closed:** same error, found 16 Feb. `JE-0042-REV` dated **16 Feb**, `corrects_entry_id = JE-0042`; `JE-0058` dated 16 Feb. January unchanged; February carries a named reclassification; cash unchanged in both months.

**Material prior-period error (policy: retrospective):** a 180,000.00 December sale was recorded twice; found in March after the year closed. Not pushed through March P&L. Route: controlled correction against **opening retained earnings** dated in the current period with the restatement documented — Dr Retained earnings (opening) 180,000.00 / Cr AR(party) 180,000.00 — **or** reopen December and reverse the duplicate there, restating the year's statements; **which one is the accountant's workflow to define.** The VAT side is a *separate* item: the duplicate overstated December's output VAT by 27,000.00 → Art. 63(2): deduct in any subsequent return within the 5-year limit; the platform records the filed status of December's return and routes the user to that rule; it does not net the two workflows.

**VAT understatement below the threshold:** a September invoice for 60,000.00 + 9,000.00 VAT was omitted from the filed Q3 return; found in November. Net value 9,000.00 < 15,000.00 → Art. 63(3): add 9,000.00 to net tax due in the return for the period of discovery (Q4). The platform shows the rule, its source and version, and records `correction_reported_via = discovery-period return`; the accounting side (the invoice was in the books all along, or is entered now under the materiality route) is a separate decision.

**VAT understatement at or above the threshold:** the omitted invoices total 120,000.00 + 18,000.00 VAT. 18,000.00 ≥ 15,000.00 → Art. 63(1): notify within 20 days of becoming aware by amending the Q3 return. The platform shows the deadline date (awareness date + 20 days), the rule and its source; the accountant files the amendment through ZATCA's e-service; the platform records `correction_reported_via = amendment` with the date.

**Re-categorising a closed-month bank row:** row dated 14 Aug, August closed, corrected 16 Sep → `TXN-86819-REV` and `TXN-86819-P2` both dated **16 Sep**; August cash unchanged; September net zero; one named correction line on the reconciliation.

**Refused reversal:** `POST /journal-entries/{GL-INV-2026-000010's id}/reverse` → 409 "This entry was created by credit note INV-2026-000010; correct it through the document, not by reversing its entry."

**Reversal carries the party:** reversing `Dr AR(Najd) 500 / Cr Sales 500` produces `Dr Sales 500 / Cr AR(Najd) 500` with `customer_id` on the AR line.

### 7. Database implications (conceptual)

- `period_locks.state` (`soft_closed` | `closed`), an append-only `period_state_changes` (company, period, from, to, reason, by, at).
- `journal_entries.source`, `correction_reason`, `corrects_entry_id`, `correction_route` (immaterial_current / material_prior / administrative), existing `reversal_of`.
- `vat_return_filings` (company, period, filed_at, filed_by, figures snapshot, `zatca_reference`, `correction_reported_via` — discovery-period return / amendment / other — recorded, not computed; `tax_rule_version` applied).
- `tax_rules` (the versioned rule record described in §3 — **later phase, not Batch 1**; listed so the schema is designed with the foreign key in mind).
- Optional `companies.materiality_threshold` **only if** the accountant wants a per-company figure exposed (§13); never a platform default.

### 8. Migration implications

Existing `period_locks` rows → `state = 'closed'` (their meaning today). `source` is backfilled from entry-number prefixes with a dry-run listing any unrecognised prefix and refusing on it. Existing `-REV` entries that dropped parties stay as they are (immutable); the invariant suite flags any party balance they distorted so the accountant can correct with an adjusting entry — the migration does not "fix" history. No VAT filing history exists to migrate; `vat_return_filings` starts empty and the VAT page offers "mark as filed" for past periods the accountant confirms.

### 9. Reporting implications

A closed month's figures cannot move; a soft-closed month's can, with reasons visible. The reconciliation gains named "correction of <period>" and "prior-period restatement" lines. VAT: a filed period's snapshot is preserved beside the live computation, so a divergence is visible and routed rather than silent; corrections reported through a later return appear in that return's "corrections" figure (its own box in the platform's return view once the filed-status model exists — the return mechanics are D-7/G7 territory and not designed here). Financial statements: immutable once closed; a restatement is an explicit, documented act.

### 10. Audit implications

Every state change is a row with actor, time and reason; every correction stores its route and reason; every reversal links its original and, when dated elsewhere, names it; document-generated entries are never reversed directly; filed VAT status, the tax-rule version applied and any later reporting route are recorded with who and when. The `source` backfill report is stored.

### 11. Permission implications

Open / soft-close / close / reopen: **admin**. Correct in a soft-closed month: admin; accountant if confirmed. Material prior-period correction: accountant or admin, with a documented restatement, and (engineering judgement) a second approver. Reverse a manual entry: approve roles, through the seam. Reverse a document-generated entry: nobody. Mark a VAT period as filed and record its correction route: accountant or admin. Edit a tax rule (later phase): platform operator only, with source and effective date; never a tenant. Bookkeeper / viewer: no posting in any non-open state.

### 12. Tests required

- The posting-path enumeration test (one writer of the two tables).
- Seam × state matrix for every writer (invoice approve/pay, bill post/pay, transaction post/repost/delete, payroll, manual approve, reversal, opening, depreciation, allocation transfer, refund) × open / soft-closed / closed.
- Reversal: refused per document source; carries parties and bank; dated per the rules; repost pair dated together; per-month cash gap = 0.
- Correction routes: each route creates the right entries with `correction_route`, `corrects_entry_id`, reason; the material route never touches current-period P&L accounts.
- Filed status: a correction touching a filed period is routed (the response names the filed date and the changed figures) and never auto-decides; **a test greps the accounting core for any literal tax or materiality threshold and fails on one**; when the tax-rule record exists, the routing test reads the rule and asserts both sides of the threshold (14,999.99 → discovery-period return; 15,000.00 → amendment + 20-day deadline) and that changing the rule version changes the route without touching any ledger figure.
- Reopen: audited; refused where policy says so.
- Migration: `source` backfill dry-run; locks → closed.
- Permission/isolation: accountant cannot close; org B cannot change org A's state; the seam reads the request company's state.
- e2e: closed-months page with three states and reasons; the correction workflow's route choice; the VAT filed marker.

### 13. Accountant confirmation

1. **The materiality policy to expose in the UI:** a per-company threshold the accountant sets, a judgement prompt with no default, or both?
2. Retrospective correction mechanics on this platform: reopen-and-restate the prior period, or an adjusting entry against opening retained earnings dated in the current period with a documented restatement — and how the restated statements should be presented?
3. Who may correct in a soft-closed month: admin only, or accountant too?
4. May a period whose VAT return is marked filed be reopened for a *material* accounting restatement, with the VAT side handled through the tax workflow?
5. Reversal of a manual entry in an open period: dated on the original (proposed) or on the reversal day?
6. Penalties for an incorrect return / an amendment that lowers tax due: the percentages described are unverified — should the platform show *any* penalty information, or only the route and the deadline?
7. The 15-day note-issuance window (Art. 54(6), verified): informational now — should the platform *enforce* it (refuse a note dated outside the window) or warn?

---

## Batch 1 implementation prerequisites

### Can be decided by engineering
- D-1: the system-protected, migration-only landing account; immutability by reversal; refusal on imbalance; the three-way reconciliation; the non-zero flag; the clearing step present but never automatic; `source` on entries.
- D-3: Option A (leaf per bank under a non-posting header) with Option B as fallback; the four classifications (`DETERMINISTIC` / `AMBIGUOUS_REQUIRES_REVIEW` / `UNMAPPABLE` / `INCONSISTENT`); bank identity separated from payment identity; reclassification + annotation instead of remapping; per-company two-phase cut-over; the invariant set.
- D-4: the payment/allocation/refund entities; the party-carrying deposit liability; one entry at receipt, a posted transfer on later allocation; `pay` kept; idempotency keys; two-person refunds; the eight-identity backfill with its refusals; advances on the same mechanism; the automatic-matching principle for later.
- D-5: three states; the single seam; `reverse` on the seam with parties/bank; document sources not reversible; the four correction routes as distinct operations; filed VAT status represented; the versioned tax-rule architecture; no threshold in accounting code.

### Must be confirmed by accountant/advisor
- D-1 §13 1–4 (blocks G1/G2): the exact clearing workflow; the plug display; the opening date; opening documents' VAT treatment.
- D-3 §13 1–5 (blocks G3 — Batch 1): per-bank presentation; cash on hand; cut-over date; annotation presentation; what an override must cite.
- D-4 §13 1–7 (blocks G4 — Batch 2): note-credit placement; refund workflow; unusual receipts; supplier advances; aging presentation; aggregate rows; over-allocation handling.
- D-5 §13 1–7 (blocks G15/G16/G17): the materiality policy; retrospective mechanics; soft-close roles; reopening a filed period; reversal dating; penalty display; the 15-day note window.

### Must be verified by migration dry-run (before any commit, per company)
- D-3: every historical cash line classified; zero `AMBIGUOUS_REQUIRES_REVIEW` / `UNMAPPABLE` / `INCONSISTENT`; Σ cash before = Σ leaves after at every month-end; line checksum unchanged.
- D-4: every legacy payment row's eight identities established or the row listed; Σ payments = Σ rows; every legacy payment fully allocated; outstanding, aging and balances identical; no journal entry created.
- D-1: imported = posted = ledger, per account.
- D-5: every entry assigned a `source`; unknown prefixes refused.

### Must be verified by automated tests
- The invariant suite (Dr = Cr; AR/AP control = subledger; deposits(party) = Σ unapplied; each bank leaf = its lines; header + leaves = old cash; TB balanced; statement closing = party figures).
- The posting-path enumeration (one writer). The seam × period-state matrix; reversal source refusals and party/bank carriage; correction routes.
- Dry-run zero-writes on `blocked`; commit idempotency; reversal of each migration; the one-bank Mark-Paid line classifying `AMBIGUOUS_REQUIRES_REVIEW`.
- No literal tax or materiality threshold in accounting code; no nearest-date / amount-only / default-bank rule anywhere in a migration or matcher.
- Permission/isolation for every new endpoint (presence, absence, movement across two organisations).
- The existing 1,416 API tests, 58 DB tests and 282 browser tests stay green; none weakened.

---

## Batch 1 Decision Status

### Confirmed by accountant/advisor
1. **D-1** — Opening Balance Equity is appropriate as a temporary migration landing account, reconciled and ultimately cleared to the appropriate equity account by an explicit accounting act.
2. **D-4** — Unapplied customer receipts are held as a customer-deposit / unapplied-cash **liability**, not as an AR credit (Dr Cash / Cr Customer deposit; later Dr Customer deposit / Cr AR).
3. **D-4** — Customer credits normally carry forward; a controlled, authorised, documented refund is supported, settles the existing credit balance, and never reverses the original credit note.
4. **D-5** — Prior-period accounting correction depends on **materiality** (material → retrospective, opening retained earnings; immaterial → reverse and re-enter in the current period), not on whether VAT has been filed.
5. **D-3** — Single-bank history is **NOT** sufficient evidence for automatic payment mapping.

### Verified from the primary ZATCA text (not a policy — a rule with a source and a version)
- Article 63 as amended by Resolution 01-06-24 (19 Nov 2024; Tenth Edition, April 2025): understatement → notify within 20 days by amending the return; **< SAR 15,000** → add to net tax due in the return of the discovery period; overstatement → deduct in any subsequent return within 5 years. Article 54(6): notes within 15 days of the following month.

### Engineering judgement
1. Fail-closed migration.
2. Dry-run before writes (zero writes, asserted).
3. Transactional migration with rollback.
4. Deterministic source evidence required for any automatic migration mapping.
5. Bank identity separated from payment / customer / invoice identity; a bank mapping never implies an allocation.
6. No amount/date-only automatic matching; no nearest-date, first-match or default-bank rule; ambiguous records to human review.
7. Idempotent payment backfill (`legacy_row_id` unique; no journal entries created).
8. Versioned / configurable tax-rule architecture; no regulatory constant in accounting logic.
9. Accounting correction workflow separated from the VAT-return correction workflow; filed status represented for routing.
10. Explicit period states with one posting seam and no bypass; reversal carries parties and bank; document-generated entries not reversible.
11. Migration reconciliation and audit provenance on every migrated record.

### Still requires accountant/advisor confirmation
1. **D-1** — the exact final clearing workflow for Opening Balance Equity (which equity account, when, one entry or per migration, who signs off; whether the computed plug may be displayed).
2. **D-5** — the exact materiality policy to expose in the product, and the retrospective-correction mechanics on this platform.
3. **D-4** — the exact treatment of unusual customer receipts (mistaken, duplicate, non-customer, owner contributions) and their financial-statement classification.
4. **D-4** — the exact refund approval / accounting workflow (two-person always or above an amount; reasons; partial refunds); placement of unapplied note credit; aging presentation; supplier advances.
5. **D-3** — per-bank presentation, cash on hand, the cut-over date, annotation presentation, what an override must cite.
6. **ZATCA** — any implementation detail not directly established by the text read: penalty treatment (the 25% / 50% / 0% description is unverified), enforcement vs warning for the 15-day note window, and re-verification of the tax rule against the Official Gazette text when the rule record is built.

---

## Batch 1 readiness conclusion

The accounting architecture is now sufficiently specified to begin the Batch 1 engineering work (D-3 per-bank cash GL and its cut-over, with the D-1 landing account and D-5 seam hardening it depends on) **only after the remaining policy confirmations above are answered and the ZATCA rule is re-verified at implementation time against the current official text.** Batch 2 (D-4) follows on the same condition.

The migration remains fail-closed throughout. The implementation must never:

- guess a customer;
- guess an invoice;
- infer payment identity from one-bank-only;
- allocate on amount and date alone;
- silently move an ambiguous record;
- create a balancing entry to hide a migration inconsistency;
- overwrite or delete historical audit evidence.

Any ambiguous historical record is surfaced for human remediation — with its record id, the evidence it has, the evidence it lacks and the remediation required — before any migration commits.

---

## Advisor-informed priority signal for later phases (not an engineering ranking)

The accountant's stated general SME priority order was: **1. Opening balances / migration · 2. Advance payments · 3. Fixed assets / depreciation · 4. Withholding tax · 5. Inventory** — described by the accountant explicitly as a **general SME priority, not KSA-specific**. It is recorded here as an input to sequencing, not as a product requirement or a market ranking; the gap register's phase order (G1 → G6 → G10/G11 → G12) already broadly follows it, and D-4's design deliberately makes advance payments (rank 2) a property of the payment model rather than a new build.

The accountant's stated **first-week abandonment risks** — migration friction; an unbalanced trial balance; fear of VAT mismatches; accounting-jargon overload; the lack of a simple profit view — are recorded as **product research signals, not factual market claims**. They bear on this pack in two places: the migration's refusal screens must say what to fix in plain words (D-1 §6, D-3 §8), and the filed-status/correction routing (D-5) must present VAT differences as routed, named items with their rule and source rather than alarms.
