# Phase 12 — Advanced Banking & Reconciliation: audit, research and decisions

**Status (2026-09-23): IN PROGRESS — §1 audit, §2 research; 12A statements (§3) and 12B reconciliation (§4) BUILT; 12C transfers, 12D period reconciliation and reports, 12E audit to come.**
Current state authority: [CLAUDE.md §2](../../CLAUDE.md).

Written under [`docs/accounting-escalation-protocol.md`](../accounting-escalation-protocol.md).
Every claim carries its class — `AUTHORITATIVE (Saudi)`, `STANDARD (IFRS)`,
`PRACTICE`, `ERPNEXT`, `ODOO`, `PRODUCT DECISION`, or
`ACCOUNTANT DECISION REQUIRED`. Nothing from Odoo or ERPNext is presented as
a Saudi requirement.

🔴 **Z-AP1 (input VAT on a supplier's advance tax invoice) is PENDING with the
accountant** (Phase 11 pack §17.8). Nothing in Phase 12 decides, assumes or
encodes it: banking moves money that is already classified; it never decides
what a payment IS for VAT.

---

## 1. The audit, before anything was built

🔴 A great deal exists. Phase 12 extends it; it rebuilds none of it.

| Area | What EXISTS | What is MISSING |
| --- | --- | --- |
| **Statement lines** | `transactions` is the bank line: bank-scoped (D-3, required), `pending_review` until a human accepts, and ACCEPTANCE POSTS (`transactionPosting.post`) — Dr/Cr the bank's own GL leaf. Import (`POST /transactions/upload`) dedupes by MULTIPLICITY per bank (re-import ⇒ nothing; a genuine repeat ⇒ every copy). SAR only; a foreign-currency row is refused, not mis-summed. | **No statement entity.** An import leaves only its lines: no file identity, no period, no opening/closing balance, no continuity between statements — so nothing can prove a statement is complete, or reconcile the ledger to the balance the bank stated. |
| **Per-bank cash (D-3)** | One GL leaf per bank; every cash line carries a bank identity through the view `journal_line_bank_identity` (leaf, or cut-over attribution). `bankAccountsRepository.glSummary` derives each bank's ledger balance from it. | `bank_accounts.balance` is a TYPED, mutable figure that the ledger-derived balance sits beside (§6, the audit). |
| **Matching** | Phase D (Batch 1B): a deterministic, reference-based engine (`statementMatching.service`) linking ONE statement row to ONE AR receipt or customer refund; append-only matches + superseding reversals; one active match per row/target enforced by a DB trigger. | 🔴 **AR only.** Supplier payments and refunds (Phase 11), legacy bill payments, manual journals and transfers cannot be matched. 🔴 **One-to-one only** — no partial, no multi-document. 🔴 **A matched row stays `pending_review`**, and acceptance does not look for a match — see §5, the defect. |
| **Settlement** | From Review, a bank row can settle an invoice or bill through the EXISTING pay paths (one writer per effect); the row becomes `kind = settlement`. | The bill side leaves no link from the row to the pay path's journal entry (`bill_payments` has no `journal_entry_id`). |
| **Transfers** | A statement row of `kind = transfer` posts through Transfer clearing (own account) / External transfers / Transfer suspense (undeclared). | No bank-to-bank transfer DOCUMENT; nothing pairs the two legs; nothing stops a transfer being recorded twice. |
| **Cash** | `cash.service.reconciliation`: ledger cash vs bank movement per month, gap itemised, `unexplained` returned. | No reconciliation to a STATEMENT BALANCE at a date; no outstanding items; nothing completes or locks a reconciliation. |

## 2. Research

### 2.1 Saudi — `AUTHORITATIVE (Saudi)`

No Saudi text governs the MECHANICS of bank reconciliation. Searched: the VAT
Law and Implementing Regulations (the repo's primary text), the ZATCA
e-invoicing resolution, the Zakat regulations — none addresses matching bank
lines to ledger entries. What does bind this work comes from rules the
platform already enforces: every cash line names its bank (D-3, a product
invariant); input VAT follows the supplier's DOCUMENT, never a payment
(IR Art. 49(7), read from the primary text in Phase 11) — so no banking act
in Phase 12 creates or moves VAT.

### 2.2 Accounting — `STANDARD (IFRS)` / `PRACTICE`

IAS 7 defines cash and cash equivalents; it does not prescribe
reconciliation. Bank reconciliation is an INTERNAL-CONTROL practice: the
balance per bank at a date and the balance per books at the same date are
explained by named, dated items (outstanding payments and deposits in the
books, lines on the statement not yet in the books), and the unexplained
difference is zero. That identity is §7's.

### 2.3 ERPNext and Odoo — read from SOURCE (ERPNext `version-15`, Odoo `17.0`, 2026-09-23)

| Question | `ERPNEXT` | `ODOO` |
| --- | --- | --- |
| **The statement line** | `Bank Transaction`, submittable, with `allocated_amount` / `unallocated_amount` and a `payment_entries` child table (`accounts/doctype/bank_transaction/bank_transaction.py` L24–46). 🔴 **Posts nothing**: "There will be no gl entry for a Bank Transaction" (L362). | `account.bank.statement.line` `_inherits` an `account.move` (`account/models/account_bank_statement_line.py` L15, L46–51) and **posts immediately**, bank against the journal's SUSPENSE account (L387–398, L599–646). |
| **Reconciling — partial, multi** | One transaction allocates across many vouchers (`min(allocable, remaining)`, bt.py L199–214); one voucher across many transactions (its allocable = its bank-GL amount − Σ allocations on all submitted transactions, L401–405, L455–498). Vouchers: Payment Entry, Journal Entry, Purchase/Sales Invoice (`hooks.py` L511–516). | The widget is **Enterprise** (not in community 17.0). Community: reconciled = the suspense line's residual is zero (L291–318). |
| **Unreconciling** | The link row is **deleted** and the voucher's `clearance_date` set to NULL (bt.py L225–241). | Partials unlinked and the POSTED move **rewritten in place** under `force_delete` (L437–450). |
| **Import duplicates** | **None** in `Bank Statement Import` (a generic importer); only the Plaid integration checks `transaction_id`. | No import in community 17.0 (moved to Enterprise). Historically (13.0) `unique_import_id` with a SQL UNIQUE — "can be imported only once". |
| **Statement balances** | No stored statement balances; the tool is a single form. | `balance_start` / `balance_end_real`; `is_complete` (lines sum to the stated end) and `is_valid` (start = previous end) are **computed flags, not constraints** (`account_bank_statement.py` L86–231). |
| **Own-account transfer** | **One** Payment Entry, `payment_type = "Internal Transfer"`, posting BOTH bank legs (`payment_entry.py` L1582–1615). | Two payments paired through a transfer account (`account_payment.py` L932–958). |
| **The reconciliation report** | Balance per GL − outstanding debits + outstanding credits + amounts not reflected = calculated bank balance (`report/bank_reconciliation_statement/…py` L38–58). | (Enterprise.) |

**Where this leaves Saudi Ledger.** Our model is ERPNext's in SHAPE — a
statement line posts nothing until it is accepted or reconciled to a
source — and stricter in three places, each a `PRODUCT DECISION`:
undoing a reconciliation writes a SUPERSEDING record (both products delete);
a file that contradicts its own stated balances is REFUSED (Odoo flags it); a
re-imported file is refused by its hash (ERPNext has no guard).

---

## 3. 12A — bank statements as records (BUILT, 2026-09-23)

| Decision | Class | Why |
| --- | --- | --- |
| A statement upload records `bank_statements` (bank, period, opening/closing balance — both or neither, source, file name, SHA-256, line count and the file's credit/debit totals); every imported line carries `bank_statement_id`. | `PRODUCT DECISION` | Provenance: which file a line came from, and what the bank said about the period — the balance 12D reconciles to. |
| 🔴 A statement is imported **whole or not at all**: every row is validated before the first is written; a bad row, a line outside the period, or a lone balance refuses the whole statement (422, nothing written). | `PRODUCT DECISION` | A statement's balances describe EVERY line; importing part of it makes them describe lines the books do not have. Without a statement block the upload keeps its old per-row behaviour (proven by the test's movement half). |
| 🔴 **A file that does not add up to its own balances is REFUSED** (`statement_does_not_balance`, with the difference). | `PRODUCT DECISION` — stricter than Odoo | Odoo computes the same test (`is_complete`) as a flag and imports anyway. A self-contradicting file is a truncated export; importing it defers the failure to a reconciliation nobody can then explain. |
| 🔴 **The same file for the same bank is refused by its hash** (409, naming the first statement). | `PRODUCT DECISION` — stricter than ERPNext | ERPNext's statement import has no duplicate guard. The line-level multiplicity dedupe (M15/2026-08-28) stays: a re-exported period (a different file) records its statement and imports no line twice. |
| **Continuity is REPORTED, not refused** — `first · continuous · gap · overlap · balance_break · unknown`, per bank, on every read. | `PRODUCT DECISION` — as Odoo (`is_valid` is a flag) | A missing statement is a fact to see and fix by importing it; refusing the next statement would only hide it. |
| Imported/duplicate counts are **DERIVED** (lines carrying the statement), never stored. | `PRODUCT DECISION` | One definition; a stored counter would be a second writer of the same fact. |
| **Append-only at the database**: SELECT/INSERT only; a line's statement is fixed once set and must name the statement's bank (trigger). | `PRODUCT DECISION` | The same rule as every posted record in this product. |

Only the FILE tab of the import page records a statement (its SHA-256 is
computed in the browser from the exact bytes); paste and manual entry are not
the bank's file and stay line entry. A file with unreadable rows is not
imported as a partial statement — the page says so and imports nothing.

**Tests** — `phase12a-bank-statements.test.ts` (8, real rows: the recorded
statement; the three refusals each with nothing written; the legacy path's
movement; the re-exported period; continuity across four statements;
append-only and fixed provenance at the DB with a positive control; isolation
with presence, absence and movement — two tenants importing the SAME hash).
`e2e/phase12-banking.spec.ts` 12A (4, by clicking: the refusal with its
difference on screen, the import, the refused re-import, the register, four
modes). One defect the tests caught before it shipped: a `format: date` field
in a zod-parsed response serialised as a TIMESTAMP (`2026-06-01T00:00:00.000Z`);
the statement's dates are plain strings in the contract (the other parsed
responses were swept — only `date-time` fields remain, which serialise
unchanged).

---

## 4. 12B — reconciling statement lines to the ledger (BUILT, 2026-09-23)

### 4.1 🔴 The defect the audit found first

`PRODUCT DEFECT (shipped)`. Phase D (Batch 1B) matched a statement line to a
receipt and **left the line `pending_review`**; acceptance never asked whether
a line was matched. So a matched line could be categorised and accepted —
posting Dr bank a second time for money the receipt had already debited. Phase
D also classified lines that had ALREADY been accepted and posted as their own
income, and could match those too: the same money in the ledger twice, either
way round. Proven by a test written to fail on the old code (red on a mutant
that restores the three missing guards).

**Fixed by construction, three layers:** a fully reconciled line leaves review
as `kind = 'matched'` (accepted, no entry, no category, no VAT — a DB CHECK);
acceptance excludes any line the view reconciles (and naming one is a 409 that
says why); and a trigger on `statement_matches` refuses a match on a line — or
a receipt — already reconciled another way. Lines still pending with an active
match were moved out of review by the migration; a line accepted AND matched
before 12B cannot be repaired by a migration (its entry is posted) and is named
by the invariant `bank_line_reconciled_twice` (zero on the dev database).

### 4.2 🔴 One definition: `bank_line_reconciliation`

| Source | Writer | Amount |
| --- | --- | --- |
| `posted` | acceptance (`transactionPosting`) — the line's own entry | the cash line |
| `ar_match` | Phase D matcher (receipt / customer refund) | the smaller of line and cash line |
| `ar_settlement` | Review settlement of an invoice (receipt created FROM the line) | the smaller |
| `link` | the workbench, the AP reference pass, a bill settled from Review, a transfer leg (12C) | as stated |

Every reader — the workbench, acceptance, Phase D's classifier, the
invariants, the reconciliation report (12D) — reads the VIEW; none re-derives
reconciliation from the source tables. Each source keeps its own single writer.

### 4.3 The decisions

| Decision | Class | Evidence / why |
| --- | --- | --- |
| A statement line reconciles to **existing GL cash lines**, for stated amounts — **partial** (a line only partly answered) and **multi-document** (one line, several payments; one payment, several lines). Nothing posts. | `PRODUCT DECISION` — ERPNext's model in shape | ERPNext allocates a Bank Transaction across vouchers and a voucher across transactions (`bank_transaction.py` L199–214, L401–498). Odoo posts every line to suspense first — a model this product does not use: a statement line posts nothing until it is accepted or reconciled. |
| 🔴 **The caps are the database's**: a line never beyond its amount, a cash line never beyond its own, across EVERY source; the cash line must be on the line's bank, moving money the same way, in a POSTED entry; a line that posted its own entry takes no link. A company-wide advisory lock serialises reconciliation writes. | `PRODUCT DECISION` | ERPNext enforces the per-voucher cap in the tool (L196–214); a future writer that forgets a service check is refused here too. |
| 🔴 **Undo is a SUPERSEDING record** (a reversal row; the link stays), reason required. | `PRODUCT DECISION` — stricter than both | ERPNext deletes the link row and NULLs `clearance_date` (bt.py L225–241); Odoo unlinks partials and rewrites the posted move in place (L437–450). The record of what was reconciled, and why it was undone, is kept. |
| **Deterministic AP links** use Phase D's policy unchanged — reference + exact amount + same bank/direction + ±3 days + one candidate + one-to-one (`matchingPolicy`, `referenceTokens`, `pairOneToOne` imported, not restated). Recording them is an explicit act. | `PRODUCT DECISION` | One definition of the matching rule for AR and AP. Never amount alone, amount+date, nearest date. |
| A **manual** link to a ledger line dated beyond the window needs a **reason**. | `PRODUCT DECISION` | Evidence a person must answer for, as Phase D's override. |
| A **bill settled from Review** is linked to its payment's cash line; `bill_payments.journal_entry_id` is written by the pay path (a COLUMN-level grant, set once — the table stays append-only) and back-filled from the N3 entry number. | `PRODUCT DECISION` | The bill side had only an entry-number convention. 45 pre-N3 dev payments (`BILL-x-PAY`, no id) are not linked by convention — left for 12C's migration where unambiguous. |
| Reconciled lines cannot be edited (beyond notes), deleted, or accepted. | `PRODUCT DECISION` | Each would move or orphan money the ledger holds. |

No Saudi or VAT consequence attaches to reconciliation: it records WHICH
ledger movement a bank line is and creates or moves no VAT (pack §2.1).

**Tests** — `phase12b-reconciliation.test.ts` (11, real rows: the defect with
presence/absence/movement; the AP reference pass posting nothing; multi and
partial; the caps in words and at the database, bypassing the service;
evidence; undo; Review bill settlement; edit/delete/accept refused;
idempotency; append-only; the invariants script SEEING a planted double
reconciliation, then removing it; isolation). `e2e/phase12-banking.spec.ts`
12B (4, by clicking: the reference pass and the 409 on accepting a reconciled
line; two payments against one debit; a partial with its remainder shown; undo
refused without a reason then done; AR/RTL and a phone). Regression: the
receipt-matching, Review, bulk-accept, D-3, navigation and crawl walks (176)
pass unchanged.
