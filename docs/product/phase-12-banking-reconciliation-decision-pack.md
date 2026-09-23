# Phase 12 — Advanced Banking & Reconciliation: audit, research and decisions

**Status (2026-09-23): BUILT, 12A–12E — §1 audit, §2 research; 12A statements (§3), 12B reconciliation (§4), 12C transfers (§5) and 12D period reconciliation, cash position and exceptions (§6) BUILT; 12E audit (§7) DONE — two items left open, named there.**
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

**Z-AP1 remains PENDING with the accountant**; nothing in Phase 12 encodes it.
