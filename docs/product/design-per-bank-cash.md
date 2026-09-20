# Per-bank cash GL (D-3 / G3) — as built, Batch 1A

**Status (2026-09-17): IMPLEMENTED in the working tree, uncommitted, awaiting owner review; the 2026-09-16 architectural review's blockers remediated 2026-09-17 (history is ANNOTATED, never rewritten — §4). Historical cut-over: NOT committed on any local company — every company is blocked by history that names no bank (see §7). Current state authority: [CLAUDE.md §2](../../CLAUDE.md).**

Decision record: [`accounting-architecture-decision-pack.md`](accounting-architecture-decision-pack.md) §D-3 (the classification table, the blocking-record fields, the refusal rule, the confirmed "one-bank-only is not evidence"). Gap register: [`functional-gap-closure-plan.md`](functional-gap-closure-plan.md) G3. This document is the as-built record: what exists, where it lives, what it deliberately does not do.

## 1. The model

```
Cash and Bank  (CASH, system code)        ← a HEADER since 0073: is_posting = false, accepts no line
├─ <bank account 8105's own account>      ← categories.bank_account_id = 8105, parent_id = CASH
├─ <bank account 8106's own account>      ← one leaf per bank account, UNIQUE
└─ …
```

| Fact | Where | Property |
| --- | --- | --- |
| The bank → GL relationship | `categories.bank_account_id` (unique, FK → `bank_accounts` ON DELETE CASCADE) | **Explicit and rename-proof.** Never resolved by name, bank name or label. The leaf's `name`/`name_ar` follow the bank account's `name` (trigger). |
| The relationship is constructed | trigger `ensure_bank_gl_account` AFTER INSERT / UPDATE OF name ON `bank_accounts`; backfill in 0073 for every existing bank | A bank account without a GL account **cannot be said**, whichever writer inserted the bank (service, seed, raw SQL). 0073 refuses to finish if any bank is left without a leaf. |
| The leaf's shape | CHECK `categories_bank_leaf_shape_chk` | `type='asset'`, `is_system`, `system_code IS NULL`, `liquidity_class='cash'`, `parent_id IS NOT NULL`, `is_posting`. Cash-classified so every existing cash reader (`liquidity_class = 'cash'`) sums it unchanged. |
| Tenant binding | trigger `categories_bank_link_chk` BEFORE INSERT/UPDATE ON `categories` | The bank and the parent must belong to the leaf's own organization — closes the FK-outside-RLS edge (CLAUDE.md §3). |
| Company binding | `resolveBankLeaves` in `glPosting.ts` (INNER JOIN `bank_accounts`) + `assertBankAccount` (RLS-scoped lookup) | A company cannot post to another company's bank: the write boundary returns 422 `reference_not_found`; the seam beneath throws `BankAccountUnresolvedError` (500) if reached directly. |
| Protection | trigger `protect_system_categories` (redefined in 0073) | App role: a leaf cannot be deleted while its bank exists (it goes only with the bank's cascade), `bank_account_id` is immutable once set, `parent_id`/`is_posting` immutable on system rows, plus the M13 rules. Owner bypass kept (migrations, teardown), as in 0025. |
| Bank deletion | `bankAccountsService.remove` | A bank whose leaf carries ledger lines → **409** ("mark it inactive"). Without lines → the bank deletes and the leaf cascades away. |
| The header accepts no line | seam: `NonPostingAccountError` (422 `account_not_posting`) on both the systemCode and accountId arms; manual-JE service: 422 `account_not_posting` with `lines[i].accountId`; DB trigger `refuse_non_posting_account_line` BEFORE INSERT / UPDATE OF account_id ON `journal_entry_lines` (no owner bypass) | The one exception: a **reversal mirror** (`journal_entries.reversal_of IS NOT NULL`) of a line still on the header — a mirror must name the account it cancels. |
| Minimum hierarchy | `categories.parent_id` (self FK) | **Only** the bank-leaf → CASH relationship uses it. No depth, no roll-up API, no user-managed parents, no report grouping by parent. Recorded as an architectural limitation (§8). |

## 2. Posting behaviour — every cash effect names a bank

The seam gained a third line arm: `{ bankAccountId }` resolves to the bank's leaf (`glPosting.ts`, `resolveBankLeaves`), and the line carries the leaf's current name. `{ systemCode: "CASH" }` is refused by the seam even though the type still admits it.

| Path | Bank identity | Without one |
| --- | --- | --- |
| `invoicesService.pay` / `billsService.pay` | `body.bankAccountId` (required; `PaymentInput.bankAccountId`) — recorded on `invoice_payments.bank_account_id` / `bill_payments.bank_account_id` | 422 `bank_account_required` (after the amount check, before any write) |
| Statement import (`transactionsService.upload`) | `TransactionUpload.bankAccountId` (required) | 422 `bank_account_required` |
| Manual row (`POST /transactions`) | `TransactionInput.bankAccountId` (required on create) | 422 `bank_account_required` |
| Acceptance (`acceptPending` → `transactionPosting.post`) | `transactions.bank_account_id` | the row goes **back to pending**, reported with `code: "bank_account_required"` (like `period_closed`); a batch with nothing accepted is the 422 itself |
| Settlement from review | the row's `bank_account_id`, passed to `pay` | 422 `bank_account_required` naming the row |
| Transfers, bank fees, reposts | the row's `bank_account_id` (same seam) | as acceptance |
| Manual journal entry | the user picks the bank's leaf (picker hides non-posting accounts) | header line → 422 `account_not_posting` |
| Reversal | copies `account_id` — a leaf line mirrors on the leaf, a header line mirrors on the header; a mirror of an ATTRIBUTED header line receives the same bank attribution at the moment of reversal (`copyBankAttributions`, rule `A3_mirror_of_attributed`), so a reversal can never strand a line the cut-over already answered | — |

One shared check, one definition: `services/accounting/bankIdentity.ts` (`assertBankAccount`). `PATCH /transactions/{id}` accepts `bankAccountId` **only while the row has none** (409 otherwise) — the remediation path for history imported or typed before a bank was required; it never reposts (a never-posted row is posted by acceptance; a header-era posting is ATTRIBUTED by the cut-over, §4).

**Not done, by design:** no default-bank fallback, no "Other Bank", no inference from the number of bank accounts — **on the server or in the UI** (the pay dialog pre-selects the account the user MARKED default and nothing else; "there is only one" pre-selects nothing, 2026-09-17), no generic cash account. `bank_accounts.is_default` remains a presentation setting (which account prints on invoices; pre-selected in the pay dialog for the human to confirm). An INACTIVE bank cannot carry a new movement (422 `bank_account_inactive`, the minimum guard; its history, leaf and attributions stay). A bank's leaf cannot be used as a transaction CATEGORY (422 `category_is_bank_account`; the picker hides it) — the counter-account of a movement is never a cash account.

## 3. Reporting — where bank identity is resolved, reader by reader

Two sources of bank identity exist by construction — a line posted to a bank's LEAF (new postings) and a header line ATTRIBUTED to a bank by the cut-over (history, §4). That is the two-definitions class (CLAUDE.md §3), so the resolution has ONE definition: the view **`journal_line_bank_identity`** (migration 0073, `security_invoker = true` so RLS applies to the caller): for every `liquidity_class = 'cash'` line, `bank_account_id = COALESCE(leaf.bank_account_id, attribution.bank_account_id)` and `identity_source ∈ {leaf, attribution, NULL}`. **Every reader that answers "which bank" joins that view; no reader re-derives it.** Readers keyed by ACCOUNT do not answer "which bank" at all and are unchanged — stated plainly below so the two kinds are not confused.

| Reader | Keyed by | Resolves bank identity? | How it shows per-bank cash |
| --- | --- | --- | --- |
| Trial balance | account | **No** — account-keyed, unchanged | each leaf is its own row (postings since 0073); "Cash and Bank" shows pre-per-bank history exactly as it was posted. It does NOT pretend history was posted per bank. |
| Balance sheet | account | **No** — unchanged | same: leaf rows + the header's history; the cash total is the class sum and is conserved by construction (every leaf and the header are `liquidity_class = 'cash'`). |
| General ledger / account statement | account | **No** — unchanged | a leaf's statement is that bank's postings since 0073; the header's statement is the history. |
| `GET /bank-accounts`, `/bank-accounts/{id}` (`glSummary`) | bank | **Yes — the view** | `ledgerBalance = ledgerBalanceOnLeaf + attributedHistory`, both parts returned (`identity_source = 'leaf'` / `'attribution'`, in-books entries), so the reader can see why this figure and the balance sheet's two lines differ and that they sum. |
| `GET /analytics/cash?bankAccountId=` → bank reconciliation (`monthlyLedgerCash`) | bank | **Yes — the view** | the one bank's leaf postings + its attributed history, month by month, against its accepted rows. The whole-company figure (no bank) is the same view without the bank arm, i.e. the plain class sum. |
| Finance hub / liquidity, cash position, every whole-company cash figure | liquidity class | **No** — sums every cash account | unchanged and conserved: attribution adds nothing to and removes nothing from any account. |
| `GET /categories` | account | — | `parentId`, `bankAccountId`, `isPosting`. |

No reader disagrees: the per-bank readers share the view; the account-keyed readers do not claim a bank. A per-bank figure on the bank accounts page and the same bank's reconciliation are therefore the same number by construction, not by coincidence.

## 4. The cut-over — `services/accounting/cashCutover.service.ts`, `scripts/cashCutover.ts`

Per **company**, two phases, fail-closed, following the decision pack §D-3 §8. Run: `DATABASE_URL=… npx tsx src/scripts/cashCutover.ts [--company <uuid>] [--json out.json]` (dry-run) and `--commit`. There is no `--force`.

**Classification** of every line still on the header, by source evidence only:

| Class | Rules | Outcome |
| --- | --- | --- |
| `DETERMINISTIC` | A0 the payment record names its bank (`invoice_payments/bill_payments.bank_account_id`); A1 the transaction linked to the entry (`journal_entry_id`) or named by the entry number (`TXN-<id>[-P<n>]`) carries `bank_account_id`; A2 **one-to-one pairing** (`evidencePairing.ts`, `pairOneToOne`): within a document, the payment records and the settlement rows that name the document AND a bank are grouped by `(paidAt, amount)`; a group of exactly ONE record and ONE row pairs, and a settlement row pairs at most once across the whole document (the document is the identity; date+amount only partition the closed set — never an identity on their own); a legacy `GL-<doc>-PAY` entry is the document's single payment record of that amount, then paired the same way; A3 a reversal mirror of a line resolved by A0–A2, or already attributed | attributed automatically |
| `AMBIGUOUS_REQUIRES_REVIEW` | a well-formed movement whose source names no bank: a transaction with `bank_account_id NULL` (**whatever the number of bank accounts**), a Mark-Paid payment with no settlement row, a legacy `GL-x-PAY` entry that cannot be tied to one payment record, **any pairing group other than 1 ↔ 1** (2 payments + 1 settlement; 1 + 2; 2 + 2 — an ordering is not evidence; a settlement disagreeing on date or amount is simply not in the group), a manual `JE-` line, an unrecognised entry shape | blocks |
| `UNMAPPABLE` | a deleted transaction (entry reversed, row gone) — no source record can name the bank | blocks |
| `INCONSISTENT` | a POSTED entry naming a transaction that does not exist; a payment entry with no payment record; an entry whose amount differs from its transaction/payment; a mirror with no matching original; a bank with no leaf | blocks |

Every blocking record carries: `lineId`, `journalEntryId`, `entryNumber`, `date`, Dr/Cr, `currentAccountId/Name`, `sourceKind`, `transactionId`/`paymentId`/`invoiceId`/`billId`, `knownBankAccountId`, `candidateBankAccountIds` (banks recorded on the platform by that date — **for the reviewer; never used to decide**), `classification`, `reason`, `requiredRemediation`.

**Dry-run:** classifies only the header lines not yet attributed (`attributedBefore` reports the rest); writes nothing to the books (asserted by test: every accounting table's row count and a line digest that INCLUDES `account_id`/`account_name` are unchanged); the script records the run as evidence in `cash_cutover_runs`. **Refusal:** any non-deterministic line → `CashCutoverBlockedError` (409), nothing changes — a company is attributed whole or not at all.

**Commit — ANNOTATION, never a rewrite** (inside one tenant transaction): take `pg_advisory_xact_lock(hashtext('cash-cutover:' || company_id))` so two commits for one company serialise; re-classify; if nothing is unattributed return `state: "nothing_to_do"` (a rerun is a no-op, not an error); refuse if blocked; insert the run row (`cash_cutover_runs`: counts, full report, cash before/after) and **one `cash_line_bank_attributions` row per deterministic line** — `line_id` UNIQUE (per-line idempotency: a duplicate is a `23505` hard failure, never a second move), the posted `account_id`/`account_name` (the accounting identity, unchanged), `bank_account_id`/`gl_account_id` (the bank identity), classification, rule, run — then assert the line checksum `(id, entry, account_id, account_name, debit, credit)` unchanged, Σ cash unchanged, zero unattributed header lines; then an `audit_logs` row (`action = 'cash_cutover'`). Any failure rolls the company back. Both evidence tables are append-only for the app role (INSERT/SELECT only; UPDATE/DELETE/TRUNCATE revoked) under the same org + company RLS arm.

**Not one journal line changes.** `journal_entry_lines` keeps its posted `account_id` and `account_name`: the balance sheet, trial balance and general ledger show history exactly as it was posted, and the per-bank readers (§3) read the bank through the view. There is no reverse cut-over because there is nothing to reverse — the attribution table can be dropped and every statement is unchanged.

**Why annotation, not remapping (2026-09-17):** the first Batch 1A build rewrote `account_id`/`account_name` in place with a move row per line. The architectural review found that this mutates a posted line's identity (the platform's own immutability claim, and the decision pack's promise that history is not rewritten), has no reverse path, and was racing a reversal that could re-post a header line after the "nothing left" check. Annotation carries the bank as an explicit dimension beside the posted account without touching it; the reversal path copies the attribution to the mirror at the moment of reversal; `nothing_to_do` + the unique `line_id` + the advisory lock make reruns and concurrency safe. The evidence table is separate from `journal_entry_lines` (no new column there) because that table is immutable and the attribution has its own lifecycle (a run, a rule, a classification) — the reasons are on the schema header in `packages/db/src/schema/cashCutover.ts`.

## 5. Tests

- `apps/api/src/tests/d3-per-bank-cash-gl.test.ts` (15): construction, rename, one-to-one, tenant binding at the trigger, DB protection (delete / reassign / reopen / move), bank deletion with and without history, posting to the named bank with its name, header refused by code / id / raw SQL / manual-JE service, every path fails closed (payment, bill payment, import, manual row, settlement) and nothing posts, acceptance puts the row back with `bank_account_required` and remediation through PATCH, company boundary at the write boundary and at the seam, tenant isolation (presence, absence, movement), per-bank reconciliation; **an inactive bank refused for a payment and an import (leaf and history untouched, works again once reactivated); a bank's leaf refused as a transaction category on create and update.**
- `apps/api/src/tests/d3-cash-cutover.test.ts` (19): six pure `pairOneToOne` cases; every classification shape with its rule; **the mandatory regression** (one bank, unidentified payment → `AMBIGUOUS_REQUIRES_REVIEW`, the one bank only listed); **A2 one-to-one**: A (2 payments + 1 settlement → both AMBIGUOUS), B (1 + 2 → AMBIGUOUS), C (2 + 2 with distinct date/amount → both DETERMINISTIC to distinct settlement ids — no reuse), D (a settlement disagreeing on date, another on amount → AMBIGUOUS), E (legacy `GL-<doc>-PAY` DETERMINISTIC when the document has one record of that amount, AMBIGUOUS when two), F (INCONSISTENT mirrors: no original / amount mismatch); dry-run zero writes (org-wide snapshot incl. payments; digest with account columns); blocked commit refused whole; remediation through the product (digest unchanged); **clean commit as annotation** — digest equal, header lines unchanged, one attribution per line with `account_id = header`, trial balance and balance sheet `toEqual` before/after (the header still on the TB), the bank's `ledgerBalance` = attributed history + 0 on the leaf, the per-bank reconciliation carries it, run row, audit row, isolation; **idempotency** (second commit `nothing_to_do`, snapshot equal, a raw duplicate attribution is `23505`); **no straggler** (a service reversal copies the attribution to the mirror; a raw mirror inserted after the commit is attributed by the next run through A3; attributions stay distinct); rollback inside the caller's transaction leaves nothing; **concurrency** (two commits in parallel → exactly one `committed` and one `nothing_to_do`, one attribution per line, one run); **a pre-0073 draft with a line on the header is refused at approval** (422 `account_not_posting`); tenant isolation of the dry-run.
- `apps/web/e2e/d3-bank-flows.spec.ts` (6, **clicked**, English and Arabic/RTL): invoice → Record Payment (picker present, EMPTY with one non-default bank, submit disabled until a bank is chosen, the chosen bank's ledger balance moves by the amount); bill → Record Payment (same, cash leaves that bank); statement upload (no bank → refused before any request is sent; with a bank → imported, the row carries it); transactions edit (no bank field on a banked row; the bank leaf and the header absent from the category picker); bank accounts page shows the moved figure; the Arabic flow with the RTL layout check and the Arabic refusal on upload.
- Existing suites adapted (fixtures now name a bank; cash assertions name the bank's leaf): 34 files; no assertion weakened — where a test asserted `code: "CASH"` on the cash leg it now asserts `BANK:<id>`, a stronger claim.

## 6. UI (minimum)

Invoices / Bills "Record Payment": a bank-account select, required; pre-selected ONLY to the account the user marked default (never to "the only one"). Data import: the bank account is required (refused client-side and by the server). Bank accounts page: "Ledger balance · GL account" beside the typed balance, plus "of which on Cash and Bank (pre-per-bank history)" when the bank has attributed history. Journal entry form: the picker hides non-posting accounts. Transactions: the category picker hides bank leaves and the header; the edit dialog offers a bank select only for a row that has none (pre-0073 history — the product can no longer write such a row). Review: a `bank_account_required` refusal is named in a toast with the fix. No redesign; no override/review UI (§7).

## 7. What is deliberately NOT built, and why

- **No override mechanism and no migration-review UI.** What an override must cite is an open accountant decision (decision pack §D-3 §13). The dry-run's report (CLI, JSON) exposes every blocking record without deciding that policy. Until it is decided, the only remediation is the product path for transactions (`PATCH bankAccountId`); Mark-Paid payments and manual entries stay on the header.
- **No cut-over has been committed.** Local dry-run under the one-to-one pairing rules, 2026-09-17: `default` 51 lines (39 deterministic, 12 ambiguous), `pilot-trading-est` 8 (0 / 8), `rehearsal-trading-est` 20 (5 / 15); 0 unmappable, 0 inconsistent; `e2e-smoke` is re-seeded per run and has no header lines. The pilot's 8 are 3 Mark-Paid payments (override policy pending) and 5 manual rows typed before a bank was required (remediable through PATCH by the pilot admin). Not forced.
- **No column on `journal_entry_lines`** — new postings are identified by the leaf; history by `cash_line_bank_attributions`; both resolved through the one view (§3). The line table stays immutable.
- **`bank_accounts.balance` still typed** — retiring it is G2.
- **No transfer entity, no per-bank reconciliation records** — G18/G19.
- **Payroll** posts to Salaries Payable and touches no cash — unchanged.

## 8. Architectural limitations recorded

- `parent_id` is a single-purpose relationship, not a chart hierarchy: no roll-up in reports, no depth, no API to manage parents.
- The chart is per organization while bank accounts are per company; the header is org-wide non-posting, the cut-over is per company. A multi-company org therefore keeps header history until every company is cut over — visible, not hidden.
- The dry-run's `candidateBankAccountIds` reads `bank_accounts.created_at`, i.e. when the bank was recorded on the platform, which for seeded/backdated data can be later than the line's date. It is informational.
- Reversal of a header-era line is the one new write the header accepts (its attribution, if any, is copied to the mirror); D-5 (reversal through the seam, correction routes) is where that path is re-cut.
- A multi-company org's history is attributed company by company; until a company is cut over, its per-bank readers show only leaf postings, and the balance sheet's "Cash and Bank" line is the visible remainder.

## 9. Runbook impact

Recording a payment (Mark Paid) and importing a statement now require choosing the bank account. The pilot's runbook step for "Mark Paid" gains the bank picker; see [`pilot-operator-runbook-2026-09-16.md`](pilot-operator-runbook-2026-09-16.md).
