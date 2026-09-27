# Phase 12 — Advanced Banking & Reconciliation: audit, research and decisions

**Status (2026-09-23): BUILT, 12A–12E — §1 audit, §2 research; 12A statements (§3), 12B reconciliation (§4), 12C transfers (§5) and 12D period reconciliation, cash position and exceptions (§6) BUILT; 12E audit (§7) DONE; Z-AP1 answered (A) and built (§8); the bank lock researched and classified as a product control (§9); final review (§10).**
Current state authority: [CLAUDE.md §2](../../CLAUDE.md).

Written under [`docs/accounting-escalation-protocol.md`](../accounting-escalation-protocol.md).
Every claim carries its class — `AUTHORITATIVE (Saudi)`, `STANDARD (IFRS)`,
`PRACTICE`, `ERPNEXT`, `ODOO`, `PRODUCT DECISION`, or
`ACCOUNTANT DECISION REQUIRED`. Nothing from Odoo or ERPNext is presented as
a Saudi requirement.

🔴 **Z-AP1 (input VAT on a supplier's advance tax invoice) was PENDING with the
accountant while 12A–12E were built** (Phase 11 pack §17.8), and nothing in
12A–12E decided, assumed or encoded it. **Answered 2026-09-24: A — built in §8.**

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

## 5. 12C — transfers between the business's own banks (BUILT, 2026-09-23)

### 5.1 The model

A transfer is a **document** (`bank_transfers`), and it posts **one** entry
with **two** cash lines — Dr the destination bank's leaf, Cr the source
bank's leaf. No P&L line, no VAT, no clearing account: both sides are known
when it is recorded, and the money never left the business. The banks'
statement legs are then **reconciled** to those two lines (`bank_statement_links`,
method `transfer`); they are never accepted to post, and 12B's acceptance
guard is what makes a second posting unsayable.

The path that already existed stays and means something different: a
statement leg accepted as an **own-account transfer** posts cash against
Transfer clearing, and the other leg nets it. That is a movement *seen on a
statement*; a `bank_transfers` row is a movement *recorded by a person*. 12C
refuses to let one movement be both.

| Decision | Class | Evidence / why |
| --- | --- | --- |
| **One document, one entry, both bank legs.** | `PRODUCT DECISION` — ERPNext's shape | ERPNext: one Payment Entry of type *Internal Transfer* posts both legs (`payment_entry.py` L1582–1615). Odoo pairs two payments through a liquidity transfer account (`account_payment.py` L932–958) — two documents for one movement, which this product's one-writer rule avoids. |
| 🔴 **A possible duplicate is refused unless confirmed WITH a reason**, kept on the row: a live transfer between the same banks for the same amount within ±3 days, or a statement leg already posted through Transfer clearing on either bank. | `PRODUCT DECISION` | The brief's "no duplicate cash". Refusing outright would block two genuine same-amount top-ups; accepting silently would double the cash. Serialised per bank pair (advisory lock) so two clicks cannot both pass the check. |
| Transfer legs link with method **`transfer`** (set by the service when a person links to a transfer's cash line). | `PRODUCT DECISION` | Evidence of what the link is, for the reports (12D). |
| 🔴 **Reversal is a superseding record** + a mirror in an OPEN period, through the one reversal writer (`journalEntriesService.reverse`); refused while either cash line is reconciled; **refused from the generic journal path** (a transfer's entry is reversed through the transfer, so the document carries its reversal). | `PRODUCT DECISION` | A reversed entry behind a live document is a document that lies. |
| 🔴 **The database refuses reversing ANY entry a statement line is reconciled to** (trigger on `journal_entries`, all sources except the line's own posting). The service refuses first, in words. | `PRODUCT DECISION` — found building 12C | `journal_line_bank_identity` carries no status filter, so a reversed entry's cash line went on "reconciling" a statement line whose money the books now cancel. 0100's comment claimed the opposite; corrected. |
| 🔴 **The entry's SHAPE is the database's**: a transfer row must name a posted entry of exactly two lines — Dr its destination bank / Cr its source bank for its amount — and every referenced row (entry, both banks) must be the row's own company. A reversal row must name its transfer's own mirror. | `PRODUCT DECISION` | FK checks run outside RLS (§3 index): a plain FK is a cross-tenant edge, so the trigger checks company. |
| Pre-N3 bill payments (`BILL-<n>-PAY`, no payment id) are linked to their entry where UNAMBIGUOUS: one payment on the bill, one entry with that number in the company, a cash line crediting exactly the payment's amount. Anything else stays NULL. | `PRODUCT DECISION` | Closes §4.3's left-over. On dev at migration time: 1 unlinked, 1 unambiguous (test cleanups had removed the other 44). |
| Recording and reversing a transfer need the **`transactions`** permission. | `PRODUCT DECISION` | The same authority that accepts statement lines, which also posts cash. |

No Saudi or VAT consequence is expected: money moved between the business's
own accounts involves no other party, so no supply and no consideration.
`REASONED — no primary text was read for this point, and it is not verified
with the accountant.` No VAT line is written either way, so a different answer
would ADD a line, not change one.

### 5.2 Also closed while building 12C

- **`link()` read a bank's entire cash history** to validate a link; it now
  reads only the named lines.
- **A multi-line link request dropped its idempotency key** (it was kept only
  when one line was named); the key now rides on the first link.

### 5.3 🔴 Found, recorded for 12E — NOT fixed here

The generic `POST /journal-entries/:id/reverse` accepts **any** posted entry —
an invoice's, a bill's, a payment's, a supplier payment's — and the owning
document then reads as live while its entry is cancelled. 12C closes it for
transfers only. The class (entries owned by a document, reversed behind the
document's back) is on the 12E audit list.

**Tests** — `phase12c-bank-transfers.test.ts` (9, real rows: both banks
asserted before/after and nothing else moving; both legs reconciled with
method `transfer`, acceptance refused, nothing posted; reversal refused by
the transfer, the generic path and the database — the DB assertion proven RED
against a dropped trigger; the supplier-payment case of the same trigger with
movement after undo; duplicates by transfer and by an own-account clearing
leg the product's own categorizer classified; reversal with reason, mirror
date and balances restored; same bank, closed month (423, nothing written),
idempotency; append-only grants and the entry-shape/company triggers;
isolation with presence, absence, movement). `e2e/phase12-banking.spec.ts` 12C
(3, by clicking: both banks' ledger balances; the duplicate explained on
screen, recorded only with a reason; the leg reconciled in the workbench to a
candidate labelled *Bank transfer*, and the reconciled transfer's reversal
refused in words; AR/RTL and a phone).

## 6. 12D — reconciliation as of a date, the lock, cash position, exceptions (BUILT, 2026-09-23)

### 6.1 The identity — and no plug

For one bank as of a date *D*:

    the bank's closing balance  =  ledger balance at D
                                   − ledger-only   (in the books, not on the statement by D:
                                                    outstanding payments, deposits in transit)
                                   + statement-only (on the statement by D, not in the books:
                                                    a charge nobody has recorded)

Every term is read from the two single definitions — a bank's ledger is
`journal_line_bank_identity` over entries IN THE BOOKS (`posted` + `reversed`),
and what reconciles is `bank_line_reconciliation`. A cash line counts as
answered at *D* only by statement lines dated on or before *D* (and the other
way round), so a cheque that cleared after *D* is outstanding AT *D*.

| Decision | Class | Evidence / why |
| --- | --- | --- |
| 🔴 **Completed only at a zero difference** — recomputed under the company's reconciliation lock at the moment of recording; `CHECK (difference = 0)` on the row. **No adjustment account, no tolerance beyond the halala.** | `PRODUCT DECISION` — the brief's "no plugs, no unexplained differences" | A difference is something to FIND. How ERPNext and Odoo treat a closing difference was **not read from source for this point** (`UNVERIFIED` — §2.3 covers matching and transfers only); the decision rests on the brief, not on them. |
| A missing statement balance yields difference **NULL**, never 0. | `PRODUCT DECISION` | §3 index: a confident zero reads as an answer. |
| **Chronological**: a new reconciliation must be dated after the bank's last active one. | `PRODUCT DECISION` | A chain with no holes is what makes "reconciled through" a fact. |
| 🔴 **The lock**: through the latest active reconciliation's date, the database refuses — a statement line added, changed (its money, date, bank or own posting) or deleted; a link or match undone; a cash line posted to that bank (by insert, by a draft becoming posted, or by a cut-over attribution). **New links are allowed** (clearing an outstanding item is what the next period does), and so is posting after the date. | `PRODUCT DECISION` | Without it, a back-dated payment silently falsifies a completed reconciliation (the "hides the result" leg of the triage check). Whether ERPNext or Odoo lock per bank was not read from source (`UNVERIFIED`). The upload refuses in words first; an error-boundary mapping turns every trigger refusal into a 409 `bank_reconciled_through`. |
| **Reopening** is a superseding row with a reason, **latest first**; the lock moves back to the one before. | `PRODUCT DECISION` | Append-only, as every Phase 12 record. |
| The reconciliation row names only its own company's bank and (if any) a statement of that bank closing on its date — checked by trigger. | `PRODUCT DECISION` | FK checks run outside RLS. |

### 6.2 Cash position

Per bank: the **ledger balance** (the one definition), the latest statement
that states a closing balance beside the ledger AT that statement's date (the
gross gap before reconciling items), unreconciled and partial line counts with
the money outstanding each way, and "reconciled through". Where no statement
states a balance, the comparison reads **not known**. The total covers active
SAR banks only.

🔴 **The Bank Accounts page headlined the TYPED `bank_accounts.balance`** — a
number entered by hand that no posting ever updates — and totalled it as
"Total Cash". It now headlines the ledger balance (the same figure as the cash
position and every report), shows the typed figure beneath it labelled for
what it is, and a missing ledger figure makes the total not known rather than
smaller. (Found in the §1 audit; the only reader of the typed column.)

### 6.3 Exceptions

Continuity breaks (12A), statement lines unreconciled > 30 days or partial,
Transfer clearing that does not net to zero (an own-account leg without its
partner), recorded transfers > 30 days without both legs reconciled, and
ledger cash lines > 30 days no statement answers. Each list is capped at 200
and carries its **true total**; the page shows 25 and says so.

### 6.4 Found and fixed while building 12D

- 🔴 **The AP reference pass classified only the newest 500 pending lines and
  ran a candidate query per line.** Found by the FULL browser run (hundreds of
  lines accumulated by earlier specs): the page's button waited longer than 10
  s and stayed disabled. Never visible to a small fixture. Now one candidate
  read per bank and direction over every pending line; a volume test seeds 600
  lines with the identifiable one OLDEST, and was proven red on the old code
  (`expected 500 to be ≥ 601`).

**Tests** — `phase12d-bank-reconciliation.test.ts` (8, real rows written
through the product's own paths: every term of the identity and the cheque
outstanding at 06-30 but not 07-31; no plug — refused with the difference,
nothing recorded; the lock across import, unlink, unmatch, posting and delete,
with posting after the date and a clearing link allowed — proven RED against
dropped triggers; reopening latest-first; the cash position against the GL;
exceptions appearing and leaving; append-only, company and zero-difference
checks at the database; isolation with presence, absence, movement).
`e2e/phase12-banking.spec.ts` 12D (4, by clicking: a wrong balance shows −5.00
and cannot complete, the right one completes and the month is locked; reopen
needs a reason and unlocks; the cash position and the Bank Accounts headline
show the API's ledger balance and say "not known" where no statement states
one; AR/RTL and a phone).

## 7. 12E — the cross-module audit (2026-09-23)

Frame: every Phase 12 file (schema, migrations 0099–0102, repositories,
services, controllers, routes, the error boundary, the six pages) plus the
Phase 12 edits to `transactions`, `statementMatching`, `journalEntries`,
`reconciliation`, `bills`. Two readers: the author's walk, and an independent
read-only review against the brief's checklist. Every finding was reproduced
before it was fixed; each fix carries a test proven able to fail.

| # | Finding | Where found | Status |
| --- | --- | --- | --- |
| 1 | 🔴 **A recorded transfer's statement leg could still be ACCEPTED** (e.g. as an own-account transfer through clearing): duplicate cash. The create-time duplicate check had no mirror at acceptance. | independent review | **Fixed** — one predicate `OPEN_TRANSFER_LEG` in both acceptance modes; named acceptance refused in words (409 `line_is_recorded_transfer_leg`), bulk leaves it pending. Test with movement. |
| 2 | 🔴 **Reconciling a statement line the categorizer had marked an own-account transfer FAILED** (a CHECK allows `transfer_direction` only on `kind = 'transfer'`, and matching set `kind = 'matched'` without clearing it) — a 500 on the intended 12C workflow. | the test for #1 | **Fixed** — `setMatched` clears the transfer declaration with the category and VAT fields. |
| 3 | 🔴 **The generic journal reverse could cancel a statement line's OWN posting**, leaving the line reading "reconciled". | independent review | **Fixed** — `journalEntriesService.reverse` refuses entries a Phase 12 document owns (a transfer, a statement line's own posting) unless the owning path calls it. Test with movement (delete still reverses). |
| 4 | Cash Position rendered the raw continuity enum and the English detail to Arabic readers. | independent review | **Fixed** — the register's labels; detail shown in English only, as on the register. |
| 5 | The 409 mapping of the banking triggers depended on the triggers' message text with nothing pinning the two. | independent review | **Fixed** — the 12C/12D suites feed the real database error through `errorHandler` and assert the 409 and its code. |
| 6 | 🔴 The AP reference pass read only 500 lines, one query each (timed out the page at volume). | the full browser run | **Fixed** — §6.4. |
| 7 | A browser assertion `toContainText("0.00")` passed on "2,500.00" while nothing had been reconciled (the test then left the page and aborted the request). | the author, on a red run | **Fixed** — every single-figure money assertion in the spec reads the number exactly. |
| 7b | 🔴 **Every Phase 12 read probed the reconciliation view once PER ROW** (correlated subqueries: the unreconciled filter, candidates, position, the workbench list, cash position, exceptions) — quadratic. The full browser run failed on it twice (11–25 s responses). | the full browser run | **Fixed** — each read aggregates the view ONCE as a `MATERIALIZED` CTE (evaluated once whatever the planner estimates — a fresh bulk import leaves the statistics stale, which once turned `position` into 35 s) or a hashed `NOT IN`; plus entry indexes on the five document tables (migration 0103). Measured on a seeded 2,500 payments × 2,500 lines, immediately after the bulk insert: the reference pass 4,000 ms → 540 ms (at 800 × 800: → 190 ms), `position` → 260 ms, every other read ≤ 220 ms. The 12B volume test now bounds the pass at 5 s. |
| 8 | 🔴 **OPEN — the generic journal reverse accepts entries owned by invoices, bills, payments, supplier payments** (pre-existing; the document then reads as live while its entry is cancelled). | 12C (§5.3) | Recorded in CLAUDE.md §5; not fixed here — it spans modules Phase 12 does not own. |
| 9 | OPEN — the Phase D AR classifier still runs a query per row (its page size is a declared parameter, not a silent cap). | 12D | Recorded; same shape as #6, lower consequence. |

**Checked and clean** (search shape stated): tenant scoping — the N1
company predicate on every raw query in the four new repositories/services;
FK edges from new tables to banks, entries and statements checked by trigger
for company; append-only — `role_table_grants` for the seven new tables show
SELECT+INSERT only for `authenticated` (verified on a FRESH migration, below);
Dr/Cr — a statement credit is a debit to the bank's cash line in the link
trigger, the transfer entry trigger and the identity; period locks —
`checkPeriodOpen` before every new posting path (transfer create, and
reverse through the one reversal writer); audit — every state-changing
service method records; idempotency — keys on links (first link of a
request), transfers; races — the company advisory lock shared by link/match
triggers and reconciliation completion, the per-bank-pair lock on transfers;
contract — the new response schemas match the services field for field.

**Fresh migration == dev.** A new database migrated from zero was diffed
against dev over the Phase 12 objects (2 views, 11 functions, 16 triggers, 117
columns, 70 constraints, 14 table grants, 1 column grant, 52 indexes, 7
policies — re-run after 0103): **0 differences**; the diff was then shown able to see two planted differences.
(0100 had been edited after it was applied to dev.)

**Z-AP1 was PENDING with the accountant when this audit ran** (2026-09-23); nothing in 12A–12E encoded it. Answered 2026-09-24 (A) — §8.

## 8. Z-AP1 — the supplier's advance tax invoice (ANSWERED and BUILT, 2026-09-24)

**Accountant decision: A — claim input VAT in the supplier advance tax
invoice's applicable VAT period, with controls preventing duplicate claim when
the final invoice is issued.** (The question as sent is in the Phase 11 pack
§17.8.)

### 8.1 Sources — each layer separately

| Layer | What was read | What it establishes |
| --- | --- | --- |
| `AUTHORITATIVE (Saudi / GCC)` | GCC Common VAT Agreement (ZATCA-hosted PDF, English translation — Arabic prevails): **Art. 23(1)** tax due "upon partial or full receipt of the Consideration … to the extent of the received amount"; **Art. 44(2)** "the right to make a deduction arises when a Deductible Tax is due"; **Art. 48(1)(a)** the buyer must hold "the Tax Invoice received". KSA VAT Implementing Regulations (repo text copy, English; article numbers placed by heading): **Art. 49(7)** (L1507–1509) deduction only with evidence of the input tax; **Art. 49(8)** (L1521–1525) deduction "may be made … in a Tax Period subsequent", within five calendar years; **Art. 53(1)(a)(2)** (L1739–1742) a tax invoice is required where consideration is received before the supply; **Art. 40(6)** (L1137–1141) the customer corrects input tax in the period the credit/debit note is issued. XML Implementation Standard v1.2 **§9.5** and its worked example (L809–891): the 386 is a full tax invoice; the final 388's `TaxInclusiveAmount` carries VAT on the FULL base, the prepayment appears only in `PrepaidAmount` (BT-113) and the adjustment line's KSA-31/KSA-32. | The advance invoice is the evidence for an input-VAT claim that arises when the supplier's tax point does (our payment) — the decision's first half. Because the final invoice's document VAT (BT-110) is GROSS, a buyer who claimed it as it stands would claim the advance's VAT twice — the second half (netting by KSA-32) is effectively required, not merely prudent. |
| `AUTHORITATIVE`, NOT FOUND | ZATCA's *Input Tax Deduction* guideline URL now returns a 404; no VAT-return filing guideline was readable. | 🔴 No official text read addresses the BUYER side of an advance invoice or which return box it files in. The claim files where every standard-rated purchase does (box 9 / box 13 in this product). `UNVERIFIED` beyond the texts above. |
| `STANDARD (IFRS)` | IAS 32 **AG11** (prepayments for goods are non-financial assets); IAS 2 **¶11** and IAS 16 **¶16(a)** (recoverable taxes are not part of cost) — ifrs.org, 2024 issued standards. SOCPA's endorsement wording itself `NOT VERIFIED`. | The advance asset holds the NET prepayment; recoverable input VAT is a separate receivable. Hence the advance invoice's entry Dr Input VAT / Cr Supplier advances. |
| `ODOO` 18.0 | `purchase/wizard/bill_to_po_wizard.py` L43–70 (down-payment line carries the down-payment bill's taxes, L61); `purchase_order_line.py` L138–158, L571–590; `purchase_order.py` L659–690; `tests/test_purchase_downpayment.py` L37–42 (final bill has a −1 down-payment line). | The down-payment bill carries tax; the final bill deducts it with a negative line bearing the same taxes, so its net tax excludes what was billed — the same netting built here. (Odoo books the down payment to an expense account in that test, not a prepayment asset.) |
| `ERPNEXT` version-15 | `purchase_invoice.py` L1973–2069 and `tax_withholding_category.py` L520–541: `advance_tax` is withholding tax (TDS) only. No Purchase Invoice code nets VAT posted on an advance (search: `advance_tax`, "Advance Taxes and Charges" in `purchase_invoice.py`, `accounts_controller.py`, `tax_withholding_category.py`). | No precedent either way. |

**Qualifications the texts impose, and how the build meets them:**
(1) Timing is a PERMISSION: IR Art. 49(8) also allows a later period. The
decision takes the earliest; the product claims in the advance invoice's own
date, which the user enters as the supplier's issue date. (2) A refund or a
price change is a CREDIT (or debit) NOTE in the note's period (Art. 40(6)),
never netting — built as the supplier's `advance_credit_note`. (3) The netted
amount should be the SUPPLIER'S KSA-32 — the prepayment input accepts the
supplier's stated tax, checked to the halala against the rate; a full
deduction copies what is open exactly.

### 8.2 What was built

Inspected first: AP-2/AP-3 (the customer-side 386/388, `invoice_prepayments`,
the VAT return's net filing) and Phase 11 Part 2 (supplier advances as an
asset, allocations, `billPosition`). The purchase side now mirrors AP-2:

| Event | Document | Entry | VAT return |
| --- | --- | --- | --- |
| Advance paid 11,500 | supplier payment, `advance` (Phase 11, unchanged) | Dr Supplier advances / Cr Bank | nothing |
| Supplier's advance invoice 10,000 + 1,500 | `bills` row, `document_type = 'advance_invoice'`, `advance_supplier_payment_id` | **Dr Input VAT 1,500 / Cr Supplier advances 1,500** | its period: box 9 +10,000, box 13 **+1,500** |
| Final invoice 30,000 + 4,500 deducting it | `bills` row (`bill`) + one `bill_prepayments` row (amount 11,500 = KSA-31 10,000 + KSA-32 1,500) | **Dr Expense 30,000 · Dr Input VAT 3,000 / Cr AP 23,000 · Cr Supplier advances 10,000**, plus the folded allocation (payment → bill, 11,500) naming this entry | its period: box 9 +20,000, box 13 **+3,000** — lines in full, prepayment rows deducted |
| Supplier's credit note against the advance invoice | `bills` row, `advance_credit_note` | Dr Supplier advances / Cr Input VAT | its period: negative |

🔴 **THE SAME INPUT VAT IS NEVER CLAIMED TWICE** — held at four places:

1. The final bill's entry nets the prepaid tax.
2. The VAT return deducts the finalised prepayment rows (the same rows).
3. The database freezes an approved bill's rows (trigger `check_bill_prepayment`), and joins a row only to an advance invoice of the same company and supplier.
4. A new ledger invariant, `advance_invoice_vat_overused`, fails whenever Σ deducted + credited VAT (or amount) on an advance invoice exceeds what it claimed.

`ap_on_account_gl_vs_subledger` now nets the open advance-invoice VAT from the advance balance.

**Controls.** The invoiced part of an advance can leave only through the final bill or the supplier's credit note:

- A plain allocation or a refund may spend only the *un-invoiced* part (`refund_exceeds_available`).
- Reclassifying an invoiced advance is refused (`advance_invoiced_cannot_reclassify`).
- A folded deduction cannot be undone (`prepayment_adjustment_immutable`); a correction is a B7 credit note on the final bill.
- An advance document is not payable, not an allocation target, owes nothing, and bills nothing: `billPosition` gives it sign 0 and outstanding 0, and the supplier statement's event and count arms exclude it.
- Closed periods are refused at entry and again at approval (423, nothing posted).
- Concurrency: every act takes the advance payment's row lock (in id order for a final bill deducting several).

Not built, stated:

- A final bill that also capitalises a fixed asset cannot deduct an advance (`prepayment_on_capitalised_bill`).
- An advance invoice carries one rate, 15% or 0%.
- Migrated (opening) supplier advances remain unbuilt, as in the Phase 11 pack §16.

Migration **0104**. UI:

- The supplier payment shows the advance's invoiced / deducted / open / not-yet-invoiced figures. It records the supplier's advance invoice (claim) and their credit note (reversal).
- The New Bill form offers the supplier's open advance invoices, and states the VAT it will NOT claim again (the server's figure).

**Tests.**

- `zap1-supplier-advance-vat.test.ts` (9, real rows, each scenario in its own months):
  1. The claim in its period (return + GL).
  2. The final bill claims only the rest, and the total over both periods is once.
  3. Partial application across two final bills, whose deductions sum to the advance's VAT to the halala.
  4. Two advances deducted by one bill.
  5. Corrections: the supplier's credit note reverses in its own period and unlocks the refund; a B7 note on the final bill; the folded deduction is refused.
  6. Closed periods, at entry and at approval.
  7. The database freeze and wrong joins.
  8. The invariants script SEES a planted double claim.
  9. Isolation.
- Proven RED against three mutants:
  - The VAT-return deduction removed: 3 tests fail.
  - The entry's netting removed: 1 test fails.
  - The freeze trigger dropped: 2 tests fail.
- `e2e/zap1-supplier-advance.spec.ts` (3, clicked):
  - Recording the advance invoice moves the month's input VAT by exactly 1,500.
  - The final bill made in the New Bill form with the advance ticked moves its month by exactly 3,000, and reads prepaid 11,500 / due 23,000.
  - AR/RTL on a phone.

## 9. The bank-reconciliation lock — researched and classified (2026-09-24)

The rule built in 12D: once a bank reconciliation is completed as of a date, that bank's statement lines and cash postings dated on or before it are locked until the reconciliation is reopened with a reason.

### 9.1 What each source says

| Layer | What was read | Finding |
| --- | --- | --- |
| `AUTHORITATIVE (Saudi)` | **Law of Commercial Books** (نظام الدفاتر التجارية), Royal Decree M/61 of 17/12/1409H — the ARABIC original on the BOE portal (laws.boe.gov.sa). No newer Commercial Books Law was found; the 1443H decree M/132 is the Companies Law. | Art. 2 delegates the integrity rules for computer records to the Implementing Regulations; Art. 3 daily entries; Art. 7 numbered pages; Art. 8 ten-year retention. Nothing on banks, reconciliation or locking (the text was searched for كشط, فراغ and تصحيح: none). |
| `AUTHORITATIVE (Saudi)`, secondary only | That law's **Implementing Regulations** (1410H). The primary text could NOT be opened (eastlaws 403; qanoniah rendered no article text). | Secondary sources attribute a rule against blanks and erasures, with an error corrected by a NEW entry on the date it is found. `NOT VERIFIED`. If accurate, it favours correction by new entry; it does not require a reconciliation-triggered lock. |
| `AUTHORITATIVE (Saudi)` | **VAT Implementing Regulations, the records article (Art. 66)**, ZATCA's official ENGLISH translation. The Arabic original was not read, and the article number was placed by heading. | Para 1: six-year retention. Para 3(f): "take the necessary security measures and adequate controls … to prevent tampering with … electronic records". A general tamper-control duty; bank reconciliation is not mentioned. |
| `AUTHORITATIVE (Saudi)` | **SOCPA**: a site search only. | No standard or guidance on bank reconciliation or record locking was found. `NOT VERIFIED` beyond the search. |
| `STANDARD (IFRS)` | IAS 7, IAS 8 ¶41–49, the Conceptual Framework — from knowledge, NOT re-read this session. | No IFRS addresses bank reconciliation or ledger locking. IAS 8 governs correcting prior-period errors in the financial statements (reporting), not how the ledger is controlled. |
| `ERPNEXT` version-15 | `bank_transaction.py` (~L138, L226–260), `bank_clearance.py` (~L92–136), `bank_reconciliation_tool.py` (L38), `general_ledger.py` `check_freezing_date` (~L783–806), `validate_accounting_period` (~L144–171), `validate_against_pcv` (~L822–840). | Reconciling locks nothing; links and clearance dates are cleared freely. The locks that exist are global or per company (a frozen-up-to date with a role exemption, accounting periods, the period closing voucher), none tied to reconciliation, none with a reason to reopen. |
| `ODOO` 17.0 | `account_bank_statement.py` (`is_complete`, `is_valid`), `account_bank_statement_line.py` (~L402–413), `account_move_line.py` `_check_reconciliation` (~L1373–1377, applied on protected-field write ~L1681 and unlink ~L1777), `company.py` lock dates (~L59–72), `account_move.py` (~L1996–2005). | A reconciled journal item cannot be modified until it is unreconciled (no reason required). Lock dates exist per COMPANY (period / fiscal-year / tax), not per bank journal. |

### 9.2 Classification

**D — no identified source requires, prohibits or prescribes a different control for this exact behaviour.**

🔴 **Completed bank reconciliation locking is an internal Saudi Ledger control/product decision, not an identified Saudi statutory/accounting requirement.** Nothing here may present it as a regulatory requirement.

The rationale is a product one:

- A reconciliation that later silently stops being true is worse than none. A back-dated payment would falsify it with nothing visible — the "hides the result" leg of the triage check.
- The lock keeps the completed result true; reopening makes a change visible and attributable (who, when, why).
- Posted history stays immutable; corrections go through correction/reversal documents dated in the open period.

The one Saudi-adjacent design constraint the research surfaced is correction by new entry. The lock honours it by construction: it refuses only movements DATED ON OR BEFORE the reconciled date, and a correction posts after it. It is also arguably supportive of VAT IR Art. 66(3)(f)'s tamper-control duty — a reading, not a requirement.

The control is **stricter than both reference products**: per bank, and with a reason to reopen. That is deliberate and stated, not claimed as practice.

### 9.3 Final lock behaviour — unchanged, and why each part is covered

The research found no reason to change the 12D implementation. Its scope follows ONE test: *does it change a term of the completed identity at its date?* (statement balance = ledger − ledger-only + statement-only).

| # | Target | Locked? | Why |
| --- | --- | --- | --- |
| 1 | Bank statement lines dated ≤ D (add, change amount/date/bank/own posting, delete) | Yes | They are the statement-only terms. |
| 2 | Reconciliation matches and links on those lines (undo) | Yes | Undoing moves a line between terms. A NEW link is allowed — clearing an item that was outstanding at D is what the next period does. |
| 3 | Underlying bank postings: any cash line on THAT bank's leaf dated ≤ D (insert; draft → posted; cut-over attribution) | Yes | They are the ledger balance at D. |
| 4–8 | Manual journals, payments, refunds, transfers, corrections/reversals | Only through #3 | Only when they would put a cash line on that bank dated ≤ D. A reversal's mirror dated today posts freely. Non-cash postings and other banks are never touched. |

Nothing broader: no company-wide or period-wide lock, and no effect on non-bank accounts (the VAT period locks remain the separate, company-scoped mechanism they were).

## 10. Phase 12 — final review (2026-09-24)

| Risk | Where it is held | Evidence |
| --- | --- | --- |
| Double bank posting / accepting a reconciled line | `kind = 'matched'` (CHECK: posts nothing); acceptance filters the view (hashed `NOT IN`); named acceptance refused (409 `line_reconciled`) | 12B tests, the defect test proven red on the old code |
| Transfer lines posting twice | One entry per transfer; `OPEN_TRANSFER_LEG` in both acceptance modes (409 `line_is_recorded_transfer_leg`); possible duplicates need a reason | 12C tests |
| Incorrect / over-reconciliation, duplicate matching | Caps across every source in DB triggers under the company advisory lock; invariants `bank_line_reconciled_twice`, `bank_line_over_reconciled`, `cash_line_over_reconciled`, `matched_line_not_reconciled` | 12B/12D tests, planted positives |
| Wrong bank attribution / Dr-Cr direction | Link trigger: same bank, direction (credit ↔ debit to the leaf); transfer entry-shape trigger | 12B/12C tests |
| Stale balances / incorrect cash position | ONE ledger definition (`journal_line_bank_identity`, JE_IN_BOOKS) and ONE reconciliation definition, aggregated once per read (`MATERIALIZED`); the Bank Accounts headline moved off the typed balance | 12D tests; volume benchmark §7 #7b |
| Reopening / locked-period behaviour | Latest-first reopening with a reason; the lock (§9.3); period locks unchanged | 12D tests, lock proven red against dropped triggers |
| Concurrent payment/reconciliation operations | Company advisory lock (links, matches, completion); per-pair lock (transfers); payment row locks (AP, Z-AP1) | Reasoned from Postgres semantics; no deterministic race test (as the Phase 11 pack §17.7 already records) |
| Tenant/company isolation | RLS with the N1 company arm on every new table; the N1 query predicate; FK-company triggers (FK checks run outside RLS) | Isolation tests with presence/absence/movement in 12A–12D and Z-AP1 |
| Immutable posted records / audit / provenance | SELECT+INSERT-only grants (verified on a fresh migration); superseding reversals and reopenings; audit records on every state change | Append-only tests; fresh-migrate diff |
| Idempotency | Keys on links (first link of a request) and transfers | 12B/12C tests |
| Readers without writers / writers without readers | Every new column has its writer and reader (the standing check); the one gap found — `bank_accounts.balance`'s only reader was the headline — was closed in 12D | §6.2 |
| Stale API/client contracts | Every new response schema generated and consumed through the generated client; the Z-AP1 bill fields added to `Bill` | typecheck; conformance suites in the gate |

**Fresh migration == dev, re-run after 0104** (2026-09-24): 0 differences over 378 objects (views, 13 functions, 18 triggers, 158 columns, 101 constraints, 18 grants, 59 indexes, 8 policies), by the same diff previously shown able to see planted differences.

**Still open, and outside Phase 12's batch:**

- 🔴 The generic journal "reverse" can reverse entries belonging to invoices, bills (including the supplier's advance documents), payments and supplier payments, leaving the originating document apparently live. CLAUDE.md §5 rank 2.
- Phase 12 guards it where Phase 12 workflows depend on it:
  - a bank transfer's entry and a statement line's own posting are refused;
  - any entry a statement line is reconciled to is refused at the database;
  - any cash posting under a completed reconciliation is refused.

  The wider redesign is not silently expanded here.
- The Phase D AR classifier's per-row queries (§7 #9).
- 🔴 **A guard's blind spot, found by the gate (2026-09-24):** `tests/state-machine-reachability.test.ts` recognises a caller only by a LITERAL path in `apps/web`, so a route called through the GENERATED client (which CLAUDE.md prefers) reads as unreachable. The Z-AP1 credit-note call was switched to a literal path, as its customer-side mirror already is; teaching the guard to read the generated client's URL builders is a separate change to a guard, recorded here rather than made in passing.
