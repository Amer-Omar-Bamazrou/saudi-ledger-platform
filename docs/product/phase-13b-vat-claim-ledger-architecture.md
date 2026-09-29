# Phase 13B — VAT claim ledger: architecture

**Status (2026-09-28): ARCHITECTURE APPROVED IN PRINCIPLE (A-0) AND LOCKED;
13B-1 SPECIFIED (§25) — NOT STARTED. Nothing here is built. No code, schema,
migration, API, UI, test or accounting behaviour was changed. 13B-1 begins
only on the owner's explicit approval of §25. Current state authority:
[CLAUDE.md §2](../../CLAUDE.md).**

- **Decision record (accounting):** [`phase-13b-vat-claim-ledger-discovery.md`](phase-13b-vat-claim-ledger-discovery.md)
  — its §32 matrix D13B-01…D13B-18 and the M1b resolution in §33. This
  document never re-decides an accounting question; where one is open it is
  marked **GATED** and not designed around.
- **Architecture decisions:** AD-1…AD-14 and approvals A-0…A-5, as decided
  by the owner on 2026-09-28 (§1–§4 below record the outcome of each).
- **Base:** `main` @ `e6999148`.
- **Research order** (owner, 2026-09-28): ZATCA/Saudi → SOCPA/IFRS → Odoo →
  ERPNext → Saudi Ledger, per [`accounting-escalation-protocol.md`](../accounting-escalation-protocol.md);
  Odoo/ERPNext are implementation precedent, never authority.

Terms: **document** = a purchase document in `bills` (bill, expense, supplier
credit/debit note, supplier advance tax invoice). **VAT** = the input VAT the
document carries. **Event** = one immutable row recording a change in where
that VAT is. **Bucket** = a place the VAT can be (§6).

---

## 1. Final approved decisions

**Accounting decisions (settled in the discovery pack — not reopened):**
supply-year start and 31/12/(Y+5) end of the deduction window (D13B-01);
late evidence is a normal later-period claim (D13B-02); advances use the
advance date until the supply date is known (D13B-03); a pre-filing claim in
the original open period (D13B-04); no voluntary partial claims (D13B-05);
40(10) mandatory at the end of M+12 on the unpaid share (D13B-06); 40(11)
optional, proportional, within the window (D13B-07); a separate adjustment
account for 40(10)/(11) (D13B-08); inventory VAT follows inventory cost —
Phase 14 (D13B-09); fixed-asset VAT increases cost, depreciation prospective
(D13B-10, accounting only — its build is gated, §3); credit notes: claimed →
reversed in the note's period, never claimed → no return adjustment
(D13B-11, main rule only); Art. 50 correction Dr cost / Cr `VAT Adjustment –
Blocked (Art. 50)`, never `VAT_INPUT` (D13B-12 + M1b); SAR 15,000 routing
(D13B-13); correction ≠ late claim (D13B-14); propose-then-post (D13B-16);
append-only event history (D13B-17).

**Architecture decisions (owner, 2026-09-28):**

| # | Decision | Where designed |
|---|---|---|
| **AD-1** ✅ | Bucket model; the database enforces the allowed transitions and refuses negative buckets, double claims, double reversals, restoration beyond reversed VAT, claiming blocked VAT and any other transition | §5, §6 |
| **AD-2** ✅ | ONE append-only event table for the 13B ledger; events are never updated or deleted | §5, §22 |
| **AD-3** ✅ | 40(10) reversals and 40(11) restorations share ONE dedicated adjustment account; the event ledger records each reversal and restoration separately (amount, date, actor, journal) | §7 |
| **AD-4 / A-1** ✅ | Dedicated adjustment accounts, with the exact English and Arabic names in §7.1 — **used verbatim and consistently** in the chart, the UI and exports (created in 13B-1, not before) | §7 |
| **AD-5** ✅ | Supply date + its source (explicit · defaulted from invoice date · backfilled · advance-date stand-in); the UI marks any date the user did not state | §9 |
| **AD-8** ✅ | The current VAT return is **not changed** in 13B; the ledger is shaped for 13D to consume | §14 |
| **AD-9** ✅ | Statutory reversals/corrections go proposal → review → approval-level posting, mapped onto the EXISTING role/permission model — no new role | §8.3 |
| **AD-11** ✅ disabled | `correction_withdrawn` exists as a reserved, **disabled** event type — never exposed or generated until its return treatment is defined | §5, §12 |
| **AD-12** ✅ | Proposals computed from current event state on read; a scheduled alarm flags overdue mandatory 40(10) reversals; **not** the AI findings pipeline — AI is never the authority for a tax event | §11 |
| **AD-13** ✅ | Do not redefine `seed_org_chart_of_accounts()` merely because an earlier draft suggested it; use the existing seeding mechanism, documented accurately | §7.3 |
| **AD-14** ✅ | Staged build order, revised for every gate and dependency | §24 |
| **A-0** ✅ | The Phase 13B architecture is approved in principle | this document |
| **A-2** ✅ (recorded) | Seeding follows the repository's ACTUAL mechanism; no seed-function redefinition to satisfy CLAUDE.md §4's broader wording; CLAUDE.md is not changed here; the discrepancy is recorded | §7.3 |
| **A-4** ✅ | The existing evidence claim keeps its current permission/action model (`create`) until a later approved decision changes it | §8.3 |
| **A-5** ✅ | EVERY journal entry referenced by a VAT event is protected from the generic journal reversal; the same guard closes the live hole for bill (`BILL-`), supplier-note (`BILLCN-`) and evidence-claim (`VATEV-`) entries | §19 |

**Critical requirements added by the owner:** R3 backfill provenance (§15),
R5 cache consistency (§14), R6 generic journal reversal protection (§19).

## 2. Rejected / not-approved proposals

| Proposal (earlier draft) | Outcome | What the architecture does instead |
|---|---|---|
| **AD-7** — a window expiry whose date falls in a closed period posts on the first open date, carrying the expiry date as `effective_from` | **NOT APPROVED** | The lapse event always carries the **real expiry date**. If that date's period is closed, the treatment is **UNRESOLVED** (§10.4); the event is not posted and nothing is moved to another date |
| **AD-10** — "a credit note reduces unreversed claimed VAT first" after a partial 40(10) reversal | **NOT APPROVED** | Recorded as an unresolved accounting/tax interaction with its cases enumerated (§13); nothing is hard-coded |
| **A-3** — an interim behaviour for notes hitting CN-1…CN-6 (refuse / hold / delay) | **NOT APPROVED** | No interim treatment is chosen. **No Phase 13B credit-note integration** until G3 is formally decided (§13) |
| Earlier draft — `advance_deducted` as a transfer out of the advance's CLAIMED | **CORRECTED** (modelling error, 2026-09-28) | Z-AP1 netting posts only the non-prepaid VAT on the final bill, so the advance's VAT stays claimed: `advance_deducted` is an **annotation** linking the final bill to the advance, moving no bucket (§5.2) |
| Earlier wording — "an event whose cost side is a balance-sheet account is refused" | **CLARIFIED** | Only VAT cost adjustments that need the gated/deferred fixed-asset or inventory accounting are refused; normal supported VAT events are unaffected (§8.2) |
| Earlier AD-8 option — feed events into our current return's figures now (e.g. the hard-coded adjustments figure, `reports.service.ts:977`) | **REJECTED** (AD-8 chose "do not change") | The current return keeps reading the document columns it reads today; 13D consumes the event ledger |
| Earlier §6 plan note / pack D13B-08 note — redefine `seed_org_chart_of_accounts()` for the new account rows | **Superseded** by AD-13 | §7.3 |

## 3. Gated decisions

A gated item needs accounting/tax research or a decision before its
**architecture** is finalised. Nothing in **13B-1** depends on any of them; G3
blocks 13B-3 onward through open blocker B-1 (§13, §24).

| # | Item | Gate | Owner of the answer | Until then |
|---|---|---|---|---|
| **G1 (AD-6 / A-6)** | **Fixed-asset VAT cost adjustment** — how 40(10), 40(11), Art. 50 corrections and lapses change an in-service asset's cost. Not built: the asset cost-adjustment act, depreciation recalculation, disposed-asset treatment, negative-carrying-amount treatment | **R1**: effect of a later VAT cost adjustment on the Saudi income-tax depreciation pool (and in which year). **R2**: the asset already disposed of; an adjustment that would push the carrying amount below zero | R1: tax/Zakat advisor via the escalation protocol. R2: owner (product) with the accountant where it is a booking question | A VAT cost adjustment that needs fixed-asset cost accounting is **refused with an explanation** (§8.2). Only the **extension point** is defined (§8.4) |
| **G2 (A-7)** | Window expiry whose expiry date's period is **closed** (§10.4) | Accounting/tax treatment of a statutory lapse dated in a closed period | Accountant | Lapse not posted; never auto-posted on the first open date; the real expiry date (`occurred_on`) stays distinct from any posting date (§5.1) |
| **G3 (A-3)** | Credit notes interacting with 40(10)/(11), corrections and lapses — CN-1…CN-6 (§13) | Accounting/tax treatment per case | Accountant / tax advisor | **No credit-note integration in 13B**; note transitions are not admitted by the database (§25.2) |

## 4. Deferred decisions

| Item | Deferred to | Note |
|---|---|---|
| VAT return integration — what the return reads, and the official box/column for 40(10)/(11), late claims and Art. 50 corrections (M4, D13B-18) | **Phase 13D** (P13-N1) | 13B stores each event's classification so 13D can map it |
| Filed-return snapshots; amended-return presentation for the ≥ SAR 15,000 route | 13D | 13B records the route and the affected original period |
| Tax-period / filing-frequency model | 13D | No filing frequency is stored anywhere today; 13B derives periods from dates only |
| VAT settlement/closing entry | 13D or later | None exists today; the adjustment accounts accumulate |
| Aggregation rule for the SAR 15,000 comparison (net understatement per period) | 13D | 13B records each correction's own amount and chosen route |
| **Correction withdrawal** (`correction_withdrawn`, formerly G4) — its return treatment | **Phase 13D** decision set (AD-11 / A-11) | Event type reserved and **disabled** at the database |
| Inventory-specific behaviour (inventory cost vs COGS) | **Phase 14** (D13B-09) | VAT cost adjustments needing inventory accounting are refused while deferred (§8.2) |
| Import VAT, reverse-charge purchase documents | when such documents exist (D13B-15) | No such purchase document exists today |
| Art. 51 apportionment, Art. 52 annual adjustments, capitalised-VAT recovery beyond 40(11) ([Phase 13 pack §9.6](phase-13-expenses-decision-pack.md)) | not in 13B | — |

## 5. Event model

### 5.1 The event row — `input_vat_events` (proposed; not created)

| Column group | Columns | Notes |
|---|---|---|
| Identity & tenancy | `id`, `organization_id`, `company_id` | NOT NULL; derived from the locked document, never from input (§22); RLS `tenant_isolation` |
| Subject | `document_id` → `bills`, `related_document_id` (note → original, final bill → advance) | `ON DELETE RESTRICT` |
| Movement | `event_type`, `from_bucket`, `to_bucket`, `amount` (> 0, `numeric(15,2)`) | CHECK against the allowed-transition table (§6.1) |
| Dates | `occurred_on` (YYYY-MM-DD — the **statutory/real** date of the fact: evidence date, end of M+12, payment date, discovery date, **expiry date**), `posting_date` (YYYY-MM-DD — the accounting date; equals the linked journal entry's date), `recorded_at` (timestamptz the row was written) | The two dates are **distinct columns**: a real expiry date can never be overwritten by a posting date. CHECK `posting_date >= occurred_on`; **equality is enforced** for every type whose posting-date rule is not decided otherwise — including both lapse types, so moving a lapse to another date is unexpressible until G2 is decided. Only `restored_on_payment` may differ (40(11): "or any later tax period"). Neither is ever changed (§16) |
| Cause | `reason` (required for human events), `cause_type`, `cause_id` (payment, note, proposal, approval), `follows_event_id` | e.g. restoration → its reversal |
| Evidence | `evidence_capture_id`, `evidence_snapshot` (kind, basis, verdict, flags, capture sha256) | verdict as it was when the event was made |
| Journal | `journal_entry_id` (money-moving types), `journal_role` (`own_entry` for a `recognised_*` event inside the document's entry, `event_entry` otherwise) | §8 |
| Statutory detail | `correction_route`, `affected_period_start/end`, `rule_version` (corrections); `trigger_month` (40(10)) | |
| Actor | `actor_user_id` (NULL only for system identities), `actor_system` (e.g. `approval:bills`, `migration:<id>`) | CHECK exactly one |
| **Provenance (R3)** | `provenance` ∈ {`recorded`, `reconstructed`}, `backfill_migration`, `backfill_source`, `source_record_ref` | §15 |
| Idempotency | `idempotency_key` | `UNIQUE (organization_id, idempotency_key)` |
| Self-description | `buckets_after` (the document's bucket balances after this event) | written by the writer; checked by the invariant (§14) |

### 5.2 Event types

"Return" = whether the event would change a period's input-VAT figure (13D
consumes it; the current return is unchanged, AD-8). "Authority" = the
permission action under AD-9 (§8.3).

| Event type | Transfer | Meaning / basis | `occurred_on` | Journal | Return | Authority | Status |
|---|---|---|---|---|---|---|---|
| `recognised_claimed` | ∅ → CLAIMED | Posted with sufficient evidence | document date | inside the document's `BILL-` entry | + | the document's approval (`approve`) | READY |
| `recognised_held` | ∅ → HELD | Posted awaiting evidence (49(7)) | document date | inside `BILL-` | — | approval | READY |
| `recognised_blocked` | ∅ → BLOCKED | Art. 50 / 0 %-recovery at posting | document date | inside `BILL-` (VAT in cost) | — | approval | READY |
| `claimed` | HELD → CLAIMED | Evidence held later — a normal later-period claim (D13B-02); whole amount (D13B-05) | evidence date | `VATEV-` Dr `VAT_INPUT` / Cr `VAT_AWAITING_EVIDENCE` (live shape) | + | live: `create`, kept (A-4) | READY |
| `reduced_by_note` | CLAIMED / HELD / BLOCKED → ∅ | Supplier credit note (§13) | note date | the note's `BILLCN-` entry (live) | − only from CLAIMED | note approval | **NOT ADMITTED — no credit-note integration in 13B (A-3 / G3)** |
| `increased_by_note` | ∅ → the original's bucket | Supplier debit note | note date | the note's entry | + if into CLAIMED | note approval | **NOT ADMITTED** (with the credit-note set) |
| `advance_deducted` | **none (annotation)** — amount recorded, no bucket moves | Z-AP1: the final bill deducts VAT already claimed on the supplier's advance tax invoice; the advance's VAT **stays claimed**, and the final bill's `recognised_claimed` carries only the non-prepaid VAT (live netting) | final bill date | inside the final bill's entry | — | approval | READY |
| `reversed_unpaid` | CLAIMED → REVERSED_UNPAID | **Mandatory** 40(10) (D13B-06) | last day of M+12 | `VATADJ-` Dr cost / Cr `VAT_ADJ_NONPAYMENT` | − | `approve` | READY (non-asset cost only) |
| `restored_on_payment` | REVERSED_UNPAID → CLAIMED | **Optional** 40(11) (D13B-07) | payment date or a later open date | `VATADJ-` Dr `VAT_ADJ_NONPAYMENT` / Cr cost | + | `approve` | READY (non-asset cost only) |
| `corrected_blocked` | CLAIMED → CORRECTED_BLOCKED | Claimed VAT found non-deductible (Art. 50; Art. 63 route) | discovery date | `VATCOR-` Dr cost / Cr `VAT_ADJ_BLOCKED` | − (route §12) | `approve` | READY (non-asset cost only) |
| `lapsed_expired` | HELD → LAPSED | 49(8) window closed with VAT still held (ACC-1) | **the real expiry date**, 31/12/(Y+5) | `VATLAP-` Dr cost / Cr `VAT_AWAITING_EVIDENCE` | — | `approve` | READY when the period is open; **GATED (G2)** when closed |
| `lapsed_written_off` | HELD → LAPSED | Held VAT judged irrecoverable before expiry (ACC-1) | judgement date | as above | — | `approve` | READY (non-asset cost only) |
| `supply_date_changed` | none | Annotation: supply date corrected (§9) | change date | none | — | `update` on bills | READY |
| `exception_recorded` / `exception_withdrawn` | none | 40(10) financing-contract exception (four conditions + supplier certificate) | recording date | none | — | `approve` (it suppresses a mandatory duty) | READY |
| `correction_withdrawn` | CORRECTED_BLOCKED → CLAIMED | **Reserved, DISABLED (AD-11)** — refused by the database until enabled by a later migration | — | — | undefined — **13D** | — | DISABLED |

Not defined, deliberately: import VAT, reverse-charge self-assessment,
Art. 51/52. A future type adds a transition row and a journal mapping; no
part of §6 assumes the list is closed.

## 6. Bucket / state machine

### 6.1 Buckets

| Bucket | Meaning | GL home |
|---|---|---|
| `HELD` | awaiting evidence | `VAT_AWAITING_EVIDENCE` |
| `CLAIMED` | deducted | `VAT_INPUT` net of the two adjustment accounts |
| `REVERSED_UNPAID` | reversed under 40(10); restorable | `VAT_ADJ_NONPAYMENT` (credit) |
| `BLOCKED` | non-deductible from the start | in the expense/asset cost |
| `CORRECTED_BLOCKED` | claimed, then corrected as non-deductible | `VAT_ADJ_BLOCKED` (credit) |
| `LAPSED` | held VAT that became irrecoverable | in the expense cost |

A document's VAT is always fully allocated across the buckets; every event is a
transfer between two of them (or into/out of existence for recognition and
notes).

```
recognised_claimed ─▶ CLAIMED ─reversed_unpaid─▶ REVERSED_UNPAID ─restored_on_payment─▶ CLAIMED
                        ▲   └─corrected_blocked─▶ CORRECTED_BLOCKED   (terminal; correction_withdrawn DISABLED)
                        │ claimed
recognised_held ────▶ HELD ─lapsed_expired / lapsed_written_off─▶ LAPSED (terminal)
recognised_blocked ─▶ BLOCKED (terminal)
reduced_by_note / increased_by_note: defined, NOT ADMITTED in 13B (§13, A-3)
advance_deducted: annotation — no bucket moves
```

### 6.2 Database enforcement (AD-1)

- **Allowed transitions** are rows of a reference table
  (`event_type`, `from_bucket`, `to_bucket`, `enabled`); a FK plus CHECK makes
  any other triple unwritable. `correction_withdrawn` is present with
  `enabled = false`, and an insert trigger refuses disabled types.
- **Non-negative buckets:** an insert trigger locks the document's balance
  row (one `input_vat_balances` row per document, maintained only by that
  trigger) and refuses the insert if the source bucket would fall below zero.
  The balance row is itself a projection of the events and is checked by the
  sweep (§14).

| Refused | Mechanism |
|---|---|
| Double claim | `claimed` moves the whole HELD balance; a second finds HELD = 0; plus key `claimed:<document>` |
| Double reversal | CLAIMED ≥ amount; key `reversed_unpaid:<document>:<trigger_month>` |
| Restoration without / beyond a reversal | REVERSED_UNPAID ≥ amount |
| Claiming blocked, corrected or lapsed VAT | no transition row out of BLOCKED / CORRECTED_BLOCKED (enabled) / LAPSED into CLAIMED |
| Claim after the window | the insert trigger refuses `claimed` / `restored_on_payment` whose `occurred_on` or `posting_date` is after the window end — computed from `bills.date` exactly as the live gate does until 13B-5, then from `bills.supply_date` |
| Edit or delete | `BEFORE UPDATE OR DELETE` trigger raises; `UPDATE`, `DELETE`, `TRUNCATE` revoked from the app role |

## 7. GL account model

### 7.1 Accounts

| Code | English name (approved, A-1) | Arabic name (approved as proposed, A-1 — preserved verbatim) | Type / balance | Purpose |
|---|---|---|---|---|
| `VAT_INPUT` (live) | Input VAT Receivable | ضريبة القيمة المضافة على المشتريات | asset, Dr | deductible input VAT claimed |
| `VAT_AWAITING_EVIDENCE` (live, 0106) | Input VAT awaiting evidence | ضريبة مدخلات بانتظار الإثبات | asset, Dr | VAT held until evidence |
| `VAT_ADJ_NONPAYMENT` | VAT Adjustment – Non-Payment (Art. 40(10)) | تعديل ضريبة المدخلات – عدم السداد (المادة 40(10)) | asset (contra), **Cr** | input VAT reversed because the consideration stayed unpaid at the end of M+12, net of 40(11) restorations — i.e. VAT still out of the deduction for non-payment. Kept apart from `VAT_INPUT` because that account represents recoverable VAT (FIN-ACC-1) |
| `VAT_ADJ_BLOCKED` | VAT Adjustment – Blocked (Art. 50) | تعديل ضريبة المدخلات – غير قابلة للخصم (المادة 50) | asset (contra), **Cr** | input VAT that was claimed and later corrected as non-deductible under Art. 50. Nothing restores it (M1b) |

- **Why "asset (contra)":** the chart has no contra type; the live precedent
  is `ACCUMULATED_DEPRECIATION`, typed `asset` with a credit balance
  (migration 0088). Both accounts: `is_system`, `vat_applicable = false`,
  treatment `O`, `liquidity_class = 'current'`, sorted beside the VAT
  accounts, protected from edit/delete like the other system VAT accounts.
- **Arabic wording:** «تعديل» mirrors the regulation's verb in 40(10)
  («أن يعدل»). **Approved (A-1)** — used verbatim and consistently.
- **Net input VAT** = `VAT_INPUT` − `VAT_ADJ_NONPAYMENT` − `VAT_ADJ_BLOCKED`.
  How a return presents it is 13D.

### 7.2 Reconciliation to the buckets

Per document: HELD = `VAT_AWAITING_EVIDENCE` lines; REVERSED_UNPAID =
`VAT_ADJ_NONPAYMENT` credit balance (Σ reversals − Σ restorations, which is
D13B-08's invariant); CORRECTED_BLOCKED = `VAT_ADJ_BLOCKED` credit balance;
CLAIMED = `VAT_INPUT` − those two. Reversal and restoration stay separately
auditable as events (AD-3).

### 7.3 Seeding — the ACTUAL current mechanism (AD-13)

- `system_account_templates` holds one row per system account.
  `seed_org_chart_of_accounts()` (last redefined in migration 0073) runs from
  the org-seed trigger and copies every template row into `categories` for a
  **new** organisation, **column by column**.
- A migration that adds an account therefore does two things: `INSERT` the
  template row (`ON CONFLICT (code) DO NOTHING`), and `INSERT … SELECT` the
  category row for **every existing** organisation (`ON CONFLICT
  (organization_id, system_code) DO NOTHING`). This is exactly what migration
  0106 did for `VAT_AWAITING_EVIDENCE`, and 0088 for the fixed-asset accounts.
  Neither redefined the function.
- The function needs redefinition when a migration changes the **columns** of
  either table — plpgsql resolves the copied column list at execution time.
  `tests/org-seed-trigger.test.ts` guards exactly that (it compares column
  sets). 13B adds no column to either table.
- 🔶 **Recorded discrepancy (A-2, decided):** CLAUDE.md §4 states the rule
  more broadly — "a migration that touches `categories` OR
  `system_account_templates` must redefine `seed_org_chart_of_accounts()`" —
  while merged migrations 0088 and 0106 added template rows without
  redefining it, and the function's own mechanism (column-by-column copy)
  only needs redefinition when a **column** changes. **Decision:** 13B-1
  follows the actual mechanism and does **not** redefine the function; the
  implementing PR records this discrepancy in its description and history
  record. CLAUDE.md is not changed in this task; clarifying its wording is a
  separate, owner-approved edit.

## 8. Journal integration

### 8.1 Posting

- Every money-moving event posts exactly one journal entry through
  `postJournalEntry` (`services/accounting/glPosting.ts`) **in the same
  transaction** as the event insert; amounts through `lib/money.ts`
  (`round2` / `money2`). Period checks through `checkPeriodOpen`
  (`periodLock.ts`) and the seam's own refusal.
- Entry prefixes: live `BILL-`, `BILLCN-`, `VATEV-`; new `VATADJ-` (40(10)/(11)),
  `VATCOR-` (Art. 50 correction), `VATLAP-` (lapse).
- The entry carries `journal_entries.source = 'input_vat_event'` (the existing
  provenance column, Batch 1C) and `reference` = the document number; the event
  carries `journal_entry_id`. The link is **two-way**: the event names its
  entry; the entry's source names the class; the sweep proves both agree (§19).
  The column is guarded by `journal_entries_source_chk` (latest form:
  migration 0086 — `NULL` or `opening` / `opening_reversal` /
  `opening_correction`), so 13B-1's migration widens that CHECK. Every current reader matches
  specific values (`migration.repository.ts`, `scripts/ledgerInvariants.ts`;
  searched for `source IS NULL`, `journalEntriesTable.source`, `e.source`),
  so a new value changes no existing figure.
- **Three journal roles** (`journal_role`), each with its own exact linkage
  rule, checked by the database (§25.6):
  - `own_entry` — `recognised_*` and `advance_deducted` reference the
    document's own posting entry, which the approval posts as today. `bills`
    has **no** journal-entry column: the link is the entry number
    `BILL-<bill_number>` / `BILLCN-<bill_number>` in the same company, made
    exact by `bills_company_number_unq` and `journal_entries_company_number_unq`.
  - `claim_entry` — `claimed` references the live `VATEV-` entry, which
    must equal `bills.input_vat_claim_entry_id`.
  - `event_entry` — the new `VATADJ-` / `VATCOR-` / `VATLAP-` entries,
    `source = 'input_vat_event'`, referenced by exactly one event.
- No event may reference an entry whose `source` is `opening`,
  `opening_reversal` or `opening_correction`: the Batch 1C migration
  reversal (`migration.repository.ts`) sets those entries to `reversed`
  legitimately, and the reversal guard (§19) must never obstruct it.

### 8.2 The "cost" side

**What the restriction means — and does not mean.** Phase 13B refuses **VAT
cost adjustments that require unsupported fixed-asset or inventory
accounting while those branches are gated/deferred.** It does **not** refuse
VAT events because a balance-sheet account is involved: every supported event
touches balance-sheet accounts (`VAT_INPUT`, `VAT_AWAITING_EVIDENCE`, the two
adjustment accounts, AP) and works normally — recognition, evidence claims,
and the 40(10)/(11), Art. 50 and lapse adjustments whose cost side is an
expense.

The restriction applies only to the **cost side** of a *cost adjustment*
(`reversed_unpaid`, `restored_on_payment`, `corrected_blocked`,
`lapsed_*`) — the account that must absorb or release the VAT. That account
is the one the original document line posted to:

| The cost adjustment would have to debit/credit | Behaviour |
|---|---|
| An expense account | READY |
| A fixed-asset cost account (the asset's cost would change) | **Refused with an explanation — GATED (G1)**: needs the asset cost-adjustment act |
| An inventory-type or other non-expense cost account whose treatment is the inventory rule (D13B-09; there is no inventory module) | **Refused with an explanation — DEFERRED to Phase 14** |

A document whose lines span a supported and an unsupported class has that
cost adjustment refused as a whole (no partial adjustment is invented); its
other, supported events are unaffected.

### 8.3 Authority — mapped onto the existing model (AD-9)

The live model (`lib/rbac.ts`, `packages/db/src/permissions.ts`):
`requirePermission(resource)` resolves a POST whose path ends in
`post|approve|pay|reverse|…` to the **`approve`** action; `bills` grants
`approve` to **admin + accountant only** (bookkeeper excluded). No new role or
resource is needed:

| Step | Route shape (proposed) | Action resolved | Who |
|---|---|---|---|
| Read proposals / history | `GET /bills/vat-adjustments`, `GET /bills/:id/vat-events` | `read` | all roles |
| Prepare (optional draft with reason, reviewable) | `POST /bills/:id/vat-adjustments` | `create` | admin, accountant, bookkeeper |
| **Post** a statutory event (40(10), 40(11), Art. 50 correction, lapse, exception) | `POST /bills/:id/vat-adjustments/:proposal/post` | **`approve`** | admin, accountant |

Reading a proposal never writes anything (AD-12); only the `…/post` act
creates the event and its journal. Observation, not changed: the live evidence
claim (`POST /bills/:id/evidence`) resolves to `create`, so a bookkeeper can
post today's `VATEV-` claim entry. **Kept as is (A-4)** until a later approved
decision changes it.

### 8.4 Fixed-asset extension point (G1 — interface only)

What is known, so the core does not block the future branch:

- An in-service asset's cost is frozen by `refuse_capitalised_asset_fact_change`
  (migration 0088): a change must be a **new act**, never an edit.
- The core's contract to that future act: a money-moving event whose cost side
  is a fixed asset will call one function, `assetVatCostAdjustment(assetId,
  signedAmount, causeEventId, taxDate)`, inside the event transaction, and use
  the entry it returns as the event's `journal_entry_id`. Until G1 is answered
  that function does not exist and the event is refused (§8.2).
- Known readers of asset cost that the future act must satisfy (from the
  code, for the gate's research): `services/assets/capitalisation.service.ts`
  (schedule; `changeEstimate` regenerates prospectively),
  `disposal.service.ts`, `incomeTaxPool.service.ts`, the fixed-asset report,
  and `asset_disposal_shape` in `scripts/ledgerInvariants.ts`.
- **Nothing** about the table shape, effective-cost rule, disposed-asset or
  negative-carrying-amount handling is decided here.

## 9. Supply-date architecture (AD-5)

- `bills.supply_date` (YYYY-MM-DD) and `bills.supply_date_source` ∈
  {`explicit`, `defaulted_invoice_date`, `backfilled_invoice_date`,
  `advance_date_stand_in`} (CHECK). NOT NULL after the backfill.
- **Default (D13B-01):** no `supplyDate` from the client → `date`, source
  `defaulted_invoice_date`. **Advance (D13B-03):** `advance_date_stand_in`
  until the real supply date is recorded.
- **UI:** every non-`explicit` date shows a visible marker ("defaulted from the
  invoice date" / "reconstructed" / "advance date — supply not yet known") in
  English and Arabic, wherever a deadline derived from it is shown.
- **Change after events exist:** only through a dedicated act that writes a
  `supply_date_changed` event (reason required) and updates the column in one
  transaction. Consequences (window end, 40(10) trigger month) are re-derived;
  a posted claim that now falls outside the window raises a review item, never
  an automatic correction. A change that would move an **already-posted**
  40(10) trigger month is refused while that event stands.
- No existing field is removed; `bills.date` keeps its meaning.

## 10. Five-year expiry architecture

### 10.1 Rule and computation

`window_end(supply_date) = (year(supply_date) + 5)-12-31` (D13B-01). One pure
function beside `withinClaimWindow` (`services/purchaseEvidence/vatEvidence.ts`),
mirrored in the event insert trigger; a test fails if the two disagree
(CLAUDE.md §3, two definitions of one fact). All dates are business dates in
`Asia/Riyadh` through `@workspace/shared` `businessDate.ts`; calendar-year
ends make leap years irrelevant.

### 10.2 Change from today

Live code and the `bills_vat_evidence_gate` trigger count from `bills.date`
(the invoice date). 13B moves both to `supply_date` (closes K1); the end point
(Y+5) is unchanged.

### 10.3 Detection and alarms

- **Pre-expiry alarm (READY):** held VAT whose window ends within a
  configurable lead time appears in the proposals list and the alarm job, so
  evidence can be obtained or a write-off considered **while the period is
  open**. This is an alarm, not an accounting rule.
- **Expired:** from 1 January of Y+6, a `lapsed_expired` proposal exists for
  each document still holding VAT. Claims are refused by the trigger.

### 10.4 Posting a lapse — AD-7 NOT approved

- The `lapsed_expired` event's `occurred_on` is **always the real expiry date**, and the database forces `posting_date = occurred_on` (§5.1) until G2 is decided.
- Expiry period **open** → posted on that date (ACC-1: expensed in the period
  it becomes non-recoverable). READY.
- Expiry period **closed** → **UNRESOLVED (G2)**. The event is not posted; the
  proposal reads "the expiry date's period is closed — the treatment of this
  case is not yet decided". It is not re-dated, not skipped silently, and not
  forced into an open period.
- 🔶 **Why this is not an edge case:** the lapse can only be proposed after
  31 December has passed, so whenever December of Y+5 has been closed by
  then, the case is G2. Two existing texts bear on it and neither settles it:
  CLAUDE.md §4 "a correction to a closed period posts in the current open
  period" (whether a statutory lapse is a *correction* is not established);
  Commercial Books IR Art. 6 (corrections by a new entry at discovery). The
  question goes to the accountant with G2.

## 11. Article 40(10)/(11) architecture

**Proposal (derived on read, AD-12).** For each posted document with
CLAIMED > 0, not a note, no active exception: `trigger_date` = last day of
(supply month + 12) (D13B-06; the month after supply is month 1). Due when
business-today ≥ `trigger_date` and consideration is unpaid at `trigger_date`.

**Unpaid amount** from the one definition `repositories/billPosition.ts`
(never `total − paid_amount`; `tests/bill-position-reader-sweep.test.ts`),
counting payments dated ≤ `trigger_date`. VAT to reverse = CLAIMED ×
unpaid ÷ consideration, via `lib/money.ts`. Whether "unpaid consideration"
includes VAT is silent (pack §28.2); the ratio is the same either way.
Credit notes change this base — see §13 (G3).

**Alarm (AD-12).** A deterministic job beside `JOB_ALARMS` /
`JOB_SCHEDULED_FINDINGS` (`jobs/index.ts`) raises an alarm for each
**overdue mandatory** reversal. It reads events and payments only; it does not
use `services/findings.service.ts` or any AI path, and it never writes an
event.

**Review → post (AD-9).** An approver opens the proposal, which shows trigger
date, unpaid amount, VAT, and the return period it belongs to; posting locks
the document row, recomputes at `trigger_date`, checks the period, and writes
the event + `VATADJ-` entry in one transaction.

**Exception.** `exception_recorded` (four conditions, supplier certificate as
a captured document) suppresses the proposal; `exception_withdrawn` restores
it. Both approve-level.

**Restoration (40(11)).** Each later payment makes a proportional restoration
available: reversed × newly paid ÷ unpaid-at-trigger, capped by
REVERSED_UNPAID; dated the payment date or any later open date the approver
chooses; refused after the window end. One event per payment.

**Period locks.** A reversal whose `trigger_date` period is closed is
**refused** with the next step named (reopen the period, or treat it as an
Art. 63 correction); never re-dated.

**Return.** The current return is untouched (AD-8); events carry the
classification 13D needs.

## 12. Article 50 correction architecture

- **Lifecycle:** CLAIMED → `corrected_blocked` (reason, Art. 50 ground,
  discovery date) → `VATCOR-` entry **Dr the original cost account / Cr
  `VAT_ADJ_BLOCKED`** (M1b) → CORRECTED_BLOCKED rises.
- **M1b guard:** an insert-time constraint trigger joins the event to its
  entry lines and refuses a `corrected_blocked` event whose entry credits
  `VAT_INPUT`.
- **Art. 63 route (D13B-13/14):** the event stores `correction_route`
  (`63_3_discovery_period` / `63_1_amend_original`), the affected original
  period, the 63(5) detail, and `rule_version` pointing at a versioned
  threshold record (SAR 15,000; never a literal in code). The journal is
  always dated the discovery date (Books IR Art. 6). Presentation of an
  amended return is 13D.
- **Asset / inventory cost side:** gated / deferred (§8.2).
- **Withdrawal:** `correction_withdrawn` reserved and disabled (AD-11); its
  return treatment is deferred to 13D. A mistaken correction cannot be undone
  in 13B.
- **Authority:** approve-level (§8.3).

## 13. Credit-note unresolved cases (AD-10 and A-3 not approved)

**No Phase 13B credit-note integration** (A-3 / G3): the note event types
exist in the model but the database does **not admit** them, and no 13B
writer produces them. Live note posting (`BILLCN-`, `bills.approvable.ts`) is
unchanged. The accounting rows below that the pack settled stay settled;
they are simply not wired into the event ledger in 13B.

Settled accounting (live behaviour, unchanged):

| Case | Treatment | Basis |
|---|---|---|
| VAT never claimed (HELD) | reduce HELD; no return adjustment | D13B-11 / ADV-11 — LIVE |
| VAT claimed (CLAIMED), no 40(10) history | reduce CLAIMED, in the note's period | IR 40(6) — LIVE |
| VAT blocked at posting (BLOCKED) | reduce BLOCKED (lowers cost) | X5 — LIVE |
| Note larger than the bucket it reduces | refused (live `credit_note_exceeds_held_vat`, generalised) | pack guard |

**UNRESOLVED — accounting/tax interactions (G3). Nothing is hard-coded.**

| # | Case | What is unresolved |
|---|---|---|
| CN-1 | **Note before 40(10)** (note dated before the trigger month ends; the invoice is still partly unpaid) | The note's own entry is settled (40(6)); what is not: whether the note reduces the PAID or the UNPAID part of the consideration, and so what "consideration unpaid" and the reversal ratio are at M+12 |
| CN-2 | **Note after a 40(10) reversal** (CLAIMED and REVERSED_UNPAID both > 0, or only REVERSED_UNPAID) | Which bucket the note reduces; whether the part reducing reversed VAT has any return effect; the journal for reducing `VAT_ADJ_NONPAYMENT` |
| CN-3 | **Note after a partial restoration** | As CN-2, plus whether the remaining restorable amount shrinks and how |
| CN-4 | **Note after full restoration** (VAT back in CLAIMED) | Whether the reversal/restoration history changes the ordinary 40(6) treatment at all — believed not, but not established |
| CN-5 | Note against CORRECTED_BLOCKED VAT | Whether it reduces the corrected amount (and `VAT_ADJ_BLOCKED`) |
| CN-6 | Note against LAPSED VAT | Whether it reduces the lapsed cost |

No interim behaviour is chosen (A-3 not approved): the architecture does not
decide whether such a note reduces unreversed claimed VAT, is held, is
refused, or is treated otherwise.

🔶 **Consequence the owner must see (OPEN BLOCKER B-1, §24):** a posted note
moves `VAT_INPUT` / `VAT_AWAITING_EVIDENCE` through its live `BILLCN-`
entry. With no note events, the event ledger **cannot reconcile to the GL**
for any document that has a note, so it cannot be the authoritative source
(§14) for those documents, and the backfill reconciliation (§15) would
refuse. This does **not** affect 13B-1 (no events are written). It blocks
13B-3 onward until the owner decides one of: (a) admit the note transitions
**only in the settled rows above** (no 40(10)/Art. 50/lapse history on the
document) — which is live behaviour recorded as events, not a new treatment;
or (b) keep all notes out and exclude documents with notes from the ledger
until G3 — which creates a second source of truth for those documents.

## 14. Projection / cache architecture (R5)

**One source of truth: the event ledger.** Everything else is derived.

| Field | Role under 13B |
|---|---|
| `input_vat_events` | **authoritative** history and balances |
| `input_vat_balances` (one row per document) | trigger-maintained balance projection used for the non-negative check (§6.2) |
| `bills.input_vat_state`, `input_vat_pending`, `input_vat_claimed_on`, `input_vat_claim_entry_id` | **cache** for live readers (13A/13C, the gate trigger, the current return queries) |
| `bills.vat_evidence_*`, `supplier_document_kind` | authoritative for the **current evidence verdict** (not a VAT position); snapshotted into each event |

- **Who writes the cache:** only the event writer, in the same transaction as
  the event. **Direct writes are never allowed:** a deferred constraint
  trigger on `bills` compares, at commit, each changed cache column with the
  value the document's events produce, and refuses the transaction on any
  difference. (Today's code paths that set these columns directly —
  `bills.approvable.ts`, `claimHeldVat` — are funnelled through the writer
  in the same batch that turns the trigger on.)
- **Rebuild:** a deterministic function recomputes a document's cache and
  balance row from its events. It is an operator act (audited), used only
  after a proven divergence; it never reads the cache to repair the events.
- **Detection:** (1) the commit-time trigger, per write; (2) the ledger
  invariant sweep (`pnpm --filter @workspace/api-server run
  invariants:ledger`, `scripts/ledgerInvariants.ts`) comparing events ⇄ cache
  ⇄ balance rows ⇄ GL per document and account, extending the live
  `vat_awaiting_evidence_gl_vs_bills` check.
- **On disagreement:** the write is refused; a sweep finding is a failure
  that alarms — the **events win**, and the discrepancy is investigated before
  any rebuild. The current return keeps reading the cache (AD-8), so a
  divergence would be visible there; that is why both checks exist.

## 15. Backfill provenance (R3)

The backfill **reconstructs** events from today's columns and journals. It must
never read as if an event ledger existed before 13B.

| Field | Backfilled value |
|---|---|
| `provenance` | `reconstructed` (every live write after 13B is `recorded`) |
| `backfill_migration` | the migration identifier that wrote it |
| `backfill_source` | the columns/rows read, e.g. `bills.input_vat_state+input_vat_claimed_on; journal_entries VATEV-…` |
| `source_record_ref` | the original record(s): document id, journal entry id |
| `recorded_at` | the **backfill** timestamp — never a historical time |
| `actor_system` | `migration:<identifier>`; `actor_user_id` NULL |
| `occurred_on` / `posting_date` | the historical dates taken from the source record (the document date, the `VATEV-` entry date) |
| `evidence_snapshot` | copied from the current `vat_evidence_*`, marked `snapshot_source = 'current_at_backfill'` — the verdict at the time was never recorded |
| `reason` | `reconstructed at Phase 13B introduction` |
| `idempotency_key` | `backfill:<type>:<document>` (re-runnable) |

Mapping from live data: claimed at posting → `recognised_claimed`; held then
claimed → `recognised_held` + `claimed`; still held → `recognised_held`;
not-deductible → `recognised_blocked`; posted notes → **depends on open
blocker B-1** (§13: note transitions are not admitted in 13B); Z-AP1 → the
advance's `recognised_claimed` + an `advance_deducted` annotation on each
final bill; NULL-state legacy rows → `recognised_claimed` with
`backfill_source` naming them; opening (Batch 1C) documents → linked to no
opening journal (§8.1); every document → `supply_date = date`, source
`backfilled_invoice_date` (with the supply-date batch, §24).

**When:** the full backfill and reconciliation are **13B-4**, not 13B-1 —
13B-1's schema needs no backfilled row (the ledger is empty until a writer
exists; §25.16).

**Reconciliation gate (in the migration; refuses on any difference, the 0080
pattern):** per document and account, reconstructed balances = GL = cache;
per period, the reconstructed claims equal the current return's input-VAT
figure. The adjustment accounts start at zero. UI and exports label
reconstructed events as such.

## 16. Period-lock behaviour

| Case | Behaviour |
|---|---|
| Event `posting_date` in an open period | posted |
| Late claim (original period closed) | dated the evidence date in the open period — the law's own rule (49(8)); nothing re-dated |
| Art. 50 correction | dated the discovery date; route records the affected original period |
| 40(10) due in a now-closed period | **refused**; proposal names the next step |
| 40(11) restoration | payment date or any later **open** date |
| Lapse, expiry period open | posted on the real expiry date |
| Lapse, expiry period closed | **UNRESOLVED (G2)** — not posted, not re-dated (AD-7 rejected) |
| Changing any event's date | impossible (append-only); a new event answers a wrong one |

## 17. Audit trail

Each event row is itself the accounting audit record (§5.1): subject, related
document, evidence and its snapshot, actor (user or named system identity),
`recorded_at`, `occurred_on`, `posting_date`, reason, cause, `follows_event_id`, journal entry,
statutory detail, provenance and `buckets_after`. `auditService`
(`services/audit.service.ts`) continues to log the user act (who pressed
what). Every event type and reason has an Arabic label in the UI and exports
(IR 66(2)). Reconstructed events are labelled (§15).

## 18. Idempotency / concurrency

- Every writer takes `billsRepository.lockForUpdate` on the document (and on
  the original, for a note — the live pattern in `bills.approvable.ts`) before
  reading balances; the balance-row lock in the insert trigger is the
  database backstop.
- `UNIQUE (organization_id, idempotency_key)`; a retried key returns the stored
  event and entry, never a second journal.

| Operation | Key |
|---|---|
| Claim | `claimed:<document>` |
| 40(10) reversal | `reversed_unpaid:<document>:<trigger_month>` |
| 40(11) restoration | `restored_on_payment:<document>:<payment_id>` |
| Note | `reduced_by_note:<note>` / `increased_by_note:<note>` |
| Correction | `corrected_blocked:<document>:<client Idempotency-Key>` |
| Lapse | `lapsed_expired:<document>` / `lapsed_written_off:<document>` |
| Backfill | `backfill:<type>:<document>` |

## 19. Generic journal reversal protection (R6)

**The hole (live, and wider than 13B):** `POST /journal-entries/:id/reverse`
(`journalEntries.service.ts` `reverse`) refuses only entries owned by a bank
transfer or a statement line (`journalEntriesRepository.documentOwner`, Phase
12C) plus the reconciled-line trigger from migration 0101. **Today's `VATEV-`
claim entries — and every `BILL-`/`BILLCN-` entry — can already be reversed
generically**, leaving the bill reading "claimed" while its entry is
cancelled (CLAUDE.md §5 rank 2).

**Identification (A-5 approved) — protected if ANY of these holds, none of
which depends on the backfill having run:**

1. an `input_vat_events` row references the entry (`journal_entry_id`) —
   every VAT-event journal, including the future `VATADJ-`/`VATCOR-`/
   `VATLAP-` entries (`source = 'input_vat_event'`);
2. it is a posted bill's or supplier note's **own entry**: its
   `entry_number` is `BILL-<n>` or `BILLCN-<n>` and a `bills` row in the
   same company has `bill_number = <n>` (exact: both numbers are unique per
   company);
3. it is a bill's **evidence-claim entry**: `bills.input_vat_claim_entry_id`
   names it (`VATEV-`).

Out of scope, stated so it is not assumed covered: invoice and payment
entries (the rest of CLAUDE.md §5 rank 2). Entries with an opening
`source` are never protected by this guard, so the Batch 1C migration
reversal keeps working (§8.1).

**Search shape behind "nothing legitimately reverses these today":** callers of
`journalEntriesService.reverse` (the generic route and
`bankTransfersService`, which passes its own owner) and every write of
`status: "reversed"` / `'reversed'` in `apps/api/src` outside tests — the only
other writer is `migration.repository.ts` (opening journals). Posted bills
are corrected by credit notes, never by reversing their entry. What would
falsify this: any other code path setting an entry's status to `reversed`;
the implementing batch re-runs this search.

**Blocking — two layers, the 0101 pattern:**

1. **Service:** `journalEntriesRepository.documentOwner` (extended, not
   duplicated) gains the owners `bill`, `supplier_note` and
   `input_vat_event`; the generic reverse refuses them with words naming the
   next step (for a bill: "This entry is bill <no>'s own posting. Correct a
   posted bill with a supplier credit note."; for a VAT event: "This entry
   records a VAT movement on bill <no>. VAT movements change only through a
   new VAT event.").
2. **Database (the boundary):** a `BEFORE UPDATE OF status ON journal_entries`
   trigger refuses `posted → reversed` for any entry matching 1–3 above. No
   caller — service, script or future path — can reach the effect without it.

**Legitimate change.** VAT-event entries are never reversed. A change in the
VAT position is always a **new event** with its own entry (40(10), 40(11),
correction, note, lapse); a document's own entry (`BILL-`) keeps being
changed only through that document's own paths. There is therefore no
"approved" route through the generic reverse.

**Consistency (sweep).** Every event with a journal has an entry that exists,
is `posted`, belongs to the same company, and whose VAT-account lines equal
the event amount; every entry with `source = 'input_vat_event'` is referenced
by exactly one event.

**Mutation-proof requirements.** A test reverses, through the real HTTP route,
a `BILL-`, a `BILLCN-` and a `VATEV-` entry produced by the product's own
paths, and an event-referenced entry, and asserts refusal, the entry still
`posted`, and the bill's columns unchanged; then (a) with the service guard
removed, the trigger still refuses; (b) with the trigger removed, the service
still refuses; (c) with both removed, the test goes red. Planted positives: a
manual journal entry still reverses; a bank-transfer entry still reverses
through its transfer; a committed migration still reverses (Batch 1C).

## 20. Migration sequence (proposed; none written)

| # | Migration | Batch | Gate |
|---|---|---|---|
| M1 | Adjustment accounts: template rows + existing-org `INSERT … SELECT` (§7.3) | **13B-1** | — |
| M2 | Transition reference table, `input_vat_events`, `input_vat_balances`, RLS, grants/REVOKE, append-only / transition / non-negative / uniqueness / linkage / tenancy triggers; widen `journal_entries_source_chk` | **13B-1** | — |
| M3 | Generic-reversal trigger on `journal_entries` (§19) | **13B-1** | — |
| M4 | Cache consistency trigger on `bills` (§14), switched on in the same release as the writer | 13B-3 | B-1 |
| M5 | Reconstructed backfill + reconciliation gate (§15) | 13B-4 | B-1 |
| M6 | `supply_date`, `supply_date_source`, CHECK, backfill, NOT NULL; window trigger moved to the supply date | 13B-5 | — |
| — | *(gated)* fixed-asset act | — | G1 |

13B-1's M1–M3 ship as **one** migration file (§25.10).

## 21. Test architecture (to be written with implementation — none now)

| Layer | Must prove |
|---|---|
| Unit | window function (Y+5, boundaries, stand-in), M+12 for every month, proportional reversal/restoration rounding via `lib/money.ts`, transition table |
| Database | append-only (app role and owner), allowed/disabled transitions, non-negative buckets, window refusal, M1b guard, idempotency uniqueness, generic-reverse trigger — each with a planted positive |
| Journal | each entry shape on real rows through the product paths; buckets ⇄ accounts before and after |
| State machine | every allowed transition; every refusal in §6.2 |
| Authority (AD-9) | bookkeeper refused `…/post` (403), accountant/admin allowed; reading proposals writes nothing |
| Period lock | every row of §16, including the refused 40(10) and the unposted G2 lapse |
| Idempotency / concurrency | retried keys; raced parallel claims/reversals/restorations → one succeeds |
| Cache (R5) | a direct cache write refused at commit; sweep detects a planted divergence |
| Backfill (R3) | on a populated copy: provenance fields set, balances = GL = cache = return figure, a planted difference stops the migration |
| Reversal guard (R6) | §19 mutation matrix |
| Isolation | presence, absence and movement across two orgs and two companies |
| Mutation-proof | remove each guard and watch its test fail |
| Browser | EN; AR RTL desktop; AR RTL on a real phone viewport; real-size evidence files |

## 22. Security / integrity

| Threat | Protection |
|---|---|
| Changing claimed VAT | append-only events; cache writes refused unless events explain them (§14) |
| Changing the evidence verdict to unlock a claim | the claim re-decides the verdict server-side (live); the verdict on a posted document changes only through the evidence act |
| Editing or deleting event history | triggers + REVOKE (app role); the triggers also refuse the owner role |
| Cross-tenant | RLS; tenant columns derived from the locked document; plain FKs audited as cross-tenant edges (CLAUDE.md §3) |
| Duplicate events | keys + UNIQUE + row locks |
| Unauthorised statutory posting | `approve` action on `bills` (admin, accountant) — §8.3 |
| AI-created tax events | none: proposals and alarms are deterministic and never write (AD-12) |
| Bypassing period locks | `checkPeriodOpen` + `postJournalEntry`; no re-dating path exists |
| Generic reversal of VAT journals | §19 |

## 23. Risks

| # | Risk | Level | Handling |
|---|---|---|---|
| R1 | Income-tax pool effect of fixed-asset VAT cost adjustments | Blocking for G1 only | gated (§3) |
| R2 | Disposed asset / negative carrying amount | Blocking for G1 only | gated |
| R3 | Reconstructed history misread as recorded history | High | provenance fields, labels, reconciliation gate (§15) |
| R4 | No inventory module | Medium | refused; Phase 14 |
| R5 | Cache/event divergence while live readers use the cache | High | same-transaction writer, commit-time trigger, sweep (§14) |
| R6 | Generic journal reverse cancels VAT-event entries (live today for `VATEV-`) | High | §19, before any event-linked entry ships |
| R7 | Lapses mostly land in closed periods (G2) | Medium | pre-expiry alarm; G2 to the accountant |
| R8 | ZATCA Example 19 counts M+13; product uses M+12 (advice) | Low | recorded in the pack |
| R9 | No tax-period model | Medium | 13D |
| R10 | Mandatory 40(10) relies on an approver acting on the alarm | Medium | overdue alarm; proposals list |
| R11 | Credit notes: no 13B integration (A-3 / G3) — the ledger cannot reconcile documents with notes | **High** for 13B-3 onward | open blocker B-1 (§13, §24) |
| R12 | CLAUDE.md §4 seed-rule wording vs actual mechanism | Low | A-2 |
| R13 | Performance of per-document balances on large lists | Low | balance rows + cache serve lists |

## 24. Final implementation gate

🔴 **The architecture is APPROVED IN PRINCIPLE (A-0) and LOCKED. No batch has
started.** Each batch begins only on the owner's explicit approval; 13B-1's
exact boundary is §25.

### APPROVED

Bucket model (AD-1) · one append-only event table (AD-2) · one shared
40(10)/(11) adjustment account with separately recorded events (AD-3) ·
dedicated adjustment accounts with the exact names in §7.1 (AD-4/A-1) ·
supply-date provenance (AD-5) · current VAT return untouched (AD-8) · the
existing permission model, statutory posting at `approve` (AD-9), evidence
claim unchanged at `create` (A-4) · proposal/alarm model outside the AI
pipeline (AD-12) · event/journal integrity and generic-reversal protection
for every VAT-event, bill, supplier-note and evidence-claim entry (R6/A-5) ·
the actual seeding mechanism, discrepancy recorded (AD-13/A-2) · the staged
build order below (AD-14).

### Build order

| Batch | Content | Status |
|---|---|---|
| **13B-1** | Foundation: accounts, event schema, transitions, bucket invariants, provenance, linkage, tenancy, generic-reversal guard (§25) | **READY — awaiting explicit approval to start** |
| 13B-2 | *(merged into 13B-1 — the schema and its invariants ship together)* | — |
| 13B-3 | Event writer + projections: live paths write `recognised_*` / `claimed` / `advance_deducted`; cache funnelled through the writer; cache-consistency trigger | READY after 13B-1, **blocked by B-1** |
| 13B-4 | Backfill with provenance + reconciliation gate | after 13B-3, **blocked by B-1** |
| 13B-5 | Evidence/claim lifecycle on events; supply date + source (AD-5); window moved to the supply date; history API + UI | after 13B-4 |
| 13B-6 | Article 40(10): proposals, alarm job, exception, approve-level posting (expense cost side) | after 13B-5; **B-2** |
| 13B-7 | Article 40(11) restoration | after 13B-6 |
| 13B-8 | Article 50 correction; lapse proposals, pre-expiry alarm, lapse/write-off posting where the period is open | after 13B-5 |
| 13B-9 | Audit/integrity: sweep checks, mutation matrix, isolation | after 13B-6…8 |
| 13B-10 | Browser acceptance EN / AR RTL desktop / AR RTL phone | last |

### GATED

- **G1 (AD-6/A-6)** — fixed-asset VAT cost adjustment: R1 (income-tax pool),
  R2 (disposed asset; carrying amount below zero). Not built: the asset
  cost-adjustment act, depreciation recalculation, disposed-asset and
  negative-carrying-amount treatment. Extension point only (§8.4).
- **G2 (AD-7/A-7)** — lapse whose expiry period is closed: never auto-posted
  on the first open date; `occurred_on` (real expiry date) stays distinct
  from any posting date.
- **G3 (AD-10/A-3)** — credit-note interactions CN-1…CN-6: no credit-note
  integration in 13B.

### DEFERRED

- **Phase 13D:** VAT return integration; return box/column mapping;
  correction withdrawal (`correction_withdrawn`, disabled); filed-return
  snapshots and amended returns; tax-period model; VAT settlement; SAR
  15,000 aggregation.
- **Phase 14:** inventory-specific behaviour.
- Import / reverse-charge purchase documents; Art. 51/52.

### OPEN BLOCKERS (none blocks 13B-1)

| # | Blocker | Blocks | Why it is genuine |
|---|---|---|---|
| **B-1** | Whether the note transitions may be admitted **for the settled cases only** (live behaviour recorded as events), or all notes stay out (§13). **Designed 2026-09-29** in [`phase-13b2-credit-note-event-design.md`](phase-13b2-credit-note-event-design.md): O-1, O-3, O-4, O-5 (13B-1a merged), O-6 APPROVED 2026-09-29; O-2 **APPROVED** 2026-09-29 (that document §19.8); D-4a APPROVED and D-4b deferred to G1 (§19.11); **B-1 CLOSED 2026-09-29**; 13B-3 unblocked after the D-4a corrective patch; CN-1…CN-8 unsettled by any source and refused by name; 13B-3 unblocked (owner, 2026-09-29) | 13B-3, 13B-4 and everything after | With no note events, a document with a posted note cannot reconcile events ⇄ GL, so the ledger cannot be authoritative for it and the backfill gate refuses |
| **B-2** | 40(10) on a document that has a credit note (CN-1) — the reversal base is unresolved (G3) | the 40(10) proposal for such documents in 13B-6 | 40(10) is **mandatory**; the architecture cannot silently skip those documents, nor compute a base the accountant has not settled |

## 25. 13B-1 Implementation Specification

**Status (2026-09-28): IMPLEMENTED ON BRANCH `feat/phase13b1-vat-event-ledger` (migration 0107) — AWAITING THE OWNER'S REVIEW; NOT MERGED.** The specification below is kept as written; §25.20 records every point where the build departs from it, and why. Current state authority: CLAUDE.md §2.
13B-1 establishes the foundation only. It has **no production writer of
events by design** (the first producer is 13B-3), so under the standing check
(CLAUDE.md §3, parts 1–2) 13B-1 must never be recorded as a delivered VAT
capability. The one part with an immediate production effect is the
generic-reversal guard (A-5), whose caller is the existing
`POST /journal-entries/:id/reverse` route.

### 25.1 Files expected to change

| File | Change |
|---|---|
| `packages/db/src/schema/inputVatLedger.ts` | **new** — Drizzle definitions of the three tables (§25.2) |
| `packages/db/src/schema/index.ts` | export the new schema file |
| `packages/db/src/chartOfAccounts.ts` | the two system codes, with the purpose comment beside each |
| `packages/db/migrations/0107_phase13b1_vat_event_ledger.sql` | **new** — generated by `pnpm --filter @workspace/db run generate`, then the hand-written section appended (the 0106 pattern: drizzle does not track CHECKs, triggers, grants or template rows). Number = next free at implementation time |
| `packages/db/migrations/meta/_journal.json`, `meta/0107_snapshot.json` | generated with the migration |
| `apps/api/src/repositories/journalEntries.repository.ts` | extend `documentOwner` (§25.15) |
| `apps/api/src/services/journalEntries.service.ts` | the refusal messages for the new owners |
| `packages/api-spec/openapi.yaml` | the reverse route's `409` description widened to "owned by a document" (spec-first; no schema change, so codegen output should not change — verified by running codegen) |
| `apps/api/src/scripts/ledgerInvariants.ts` | the linkage/balance checks of §25.14 |
| tests (at implementation only) | §25.17 |
| `CLAUDE.md` §2 / §4, `docs/history/…` | close-out: one status line, one invariant line, the as-built record (budget test applies) |

**Not expected to change:** `bills.approvable.ts`, `purchaseEvidence/vatEvidence.service.ts`,
`vatEvidence.ts`, `reports.service.ts`, `reports.repository.ts`, any
`apps/web` file, the permission matrix, `seed_org_chart_of_accounts()`.

### 25.2 New tables

**(a) `input_vat_event_transitions`** — global reference data (no
`organization_id`), seeded by the migration, read-only to the app role.

| Column | Type | Meaning |
|---|---|---|
| `event_type` | text | the event type |
| `from_bucket`, `to_bucket` | text NULL | NULL = out of / into existence; both NULL = annotation |
| `journal_role` | text NULL | `own_entry` / `claim_entry` / `event_entry` / NULL (none) |
| `admitted` | boolean | the **database** accepts this transition |
| `enabled_in` | text | the batch whose writer first produces it (documentation only) |
| `basis` | text | the decision it rests on (D13B-xx / AD-xx) |

Primary key `(event_type, coalesce(from_bucket,''), coalesce(to_bucket,''))` via a unique index.

**Event type ≠ bucket ≠ transition ≠ feature.** A *bucket* is a place VAT can
be; an *event type* is what happened; a *transition* is the (type, from, to)
triple; *admitted* is whether the database accepts that triple; *enabled* is
whether a production writer produces it. **In 13B-1 no event type is
enabled** (no writer exists).

| Event type | from → to | journal_role | Admitted in 13B-1 | Enabled in |
|---|---|---|---|---|
| `recognised_claimed` | ∅ → CLAIMED | own_entry | yes | 13B-3 |
| `recognised_held` | ∅ → HELD | own_entry | yes | 13B-3 |
| `recognised_blocked` | ∅ → BLOCKED | own_entry | yes | 13B-3 |
| `claimed` | HELD → CLAIMED | claim_entry | yes | 13B-3 / 13B-5 |
| `advance_deducted` | none (annotation) | own_entry | yes | 13B-3 |
| `reversed_unpaid` | CLAIMED → REVERSED_UNPAID | event_entry | yes | 13B-6 |
| `restored_on_payment` | REVERSED_UNPAID → CLAIMED | event_entry | yes | 13B-7 |
| `corrected_blocked` | CLAIMED → CORRECTED_BLOCKED | event_entry | yes | 13B-8 |
| `lapsed_written_off` | HELD → LAPSED | event_entry | yes | 13B-8 |
| `lapsed_expired` | HELD → LAPSED | event_entry | yes (posting_date = occurred_on forced) | 13B-8 |
| `exception_recorded`, `exception_withdrawn` | none (annotation) | NULL | yes | 13B-6 |
| `supply_date_changed` | none (annotation) | NULL | **no** (the column arrives in 13B-5) | 13B-5 |
| `reduced_by_note`, `increased_by_note` | CLAIMED/HELD/BLOCKED → ∅; ∅ → bucket | own_entry | **no** (A-3 / G3 / B-1) | — |
| `correction_withdrawn` | CORRECTED_BLOCKED → CLAIMED | event_entry | **no** (AD-11; 13D) | — |

Admitting a transition before its writer exists is deliberate: it lets 13B-1's
tests prove every invariant against the real database, and a later batch then
adds only a writer, never a schema change. Nothing in the application can
produce an admitted-but-not-enabled type, because no writer exists.

**(b) `input_vat_events`** — the ledger.

| Column | Type / constraint |
|---|---|
| `id` | serial PK |
| `organization_id`, `company_id` | integer NOT NULL, FK |
| `document_id` | integer NOT NULL → `bills(id)` ON DELETE RESTRICT |
| `related_document_id` | integer NULL → `bills(id)` RESTRICT |
| `event_type`, `from_bucket`, `to_bucket` | text; FK to the transitions table |
| `amount` | numeric(15,2) NULL; > 0 when a bucket moves or for `advance_deducted`; NULL only for the other annotations |
| `occurred_on` | text `YYYY-MM-DD` NOT NULL (the repo stores business dates as text — `bills.date`, `journal_entries.date`) |
| `posting_date` | text `YYYY-MM-DD` NOT NULL |
| `recorded_at` | timestamptz NOT NULL DEFAULT now() |
| `trigger_month` | text `YYYY-MM` NULL (40(10) only) |
| `reason` | text NULL (NOT NULL when `actor_user_id` is set) |
| `cause_type`, `cause_id` | text / integer NULL |
| `follows_event_id` | integer NULL → `input_vat_events(id)` |
| `evidence_capture_id` | integer NULL → `captured_documents(id)` |
| `evidence_snapshot` | jsonb NULL |
| `journal_entry_id` | integer NULL → `journal_entries(id)` ON DELETE RESTRICT |
| `journal_role` | text NULL (must equal the transition's) |
| `correction_route`, `affected_period_start`, `affected_period_end`, `rule_version` | NULL (corrections) |
| `actor_user_id` | integer NULL; `actor_system` text NULL — exactly one set |
| `provenance` | text NOT NULL ∈ {`recorded`, `reconstructed`} |
| `backfill_migration`, `backfill_source`, `source_record_ref` | text NULL |
| `idempotency_key` | text NOT NULL |
| `buckets_after` | jsonb NOT NULL — **set by the insert trigger**, never by the caller |

**(c) `input_vat_balances`** — one row per document, maintained only by the
event trigger: `organization_id`, `company_id`, `document_id` (PK),
`held`, `claimed`, `reversed_unpaid`, `blocked`, `corrected_blocked`,
`lapsed` numeric(15,2) NOT NULL DEFAULT 0 with `CHECK (… >= 0)` on each,
`last_event_id`, `updated_at`.

### 25.3 New columns

**None on existing tables.** `bills.supply_date` / `supply_date_source` are
13B-5 (the batch that consumes them — a column with no reader is not
shipped early). The `bills.input_vat_*` cache is untouched in 13B-1.

### 25.4 New indexes

- `input_vat_events`: `UNIQUE (organization_id, idempotency_key)`;
  `(company_id, document_id, id)`; `(company_id, posting_date)`;
  `(follows_event_id)`; `UNIQUE (journal_entry_id) WHERE journal_role IN ('claim_entry','event_entry')`.
- Partial uniques that make double acts unwritable:
  `UNIQUE (document_id) WHERE event_type LIKE 'recognised_%'` (one recognition);
  `UNIQUE (document_id) WHERE event_type = 'claimed'` (no double claim);
  `UNIQUE (document_id, trigger_month) WHERE event_type = 'reversed_unpaid'` (no double reversal);
  `UNIQUE (document_id, cause_id) WHERE event_type = 'restored_on_payment'` (one per payment);
  `UNIQUE (document_id) WHERE event_type IN ('lapsed_expired','lapsed_written_off')`.
- `input_vat_balances`: PK `document_id`; `(company_id)`.
- Unique index on the transitions table (§25.2a).

### 25.5 New constraints (CHECK / FK)

- Bucket values ∈ {HELD, CLAIMED, REVERSED_UNPAID, BLOCKED, CORRECTED_BLOCKED, LAPSED}.
- `(event_type, from_bucket, to_bucket)` references the transitions table.
- `amount` rule as §25.2b; `posting_date >= occurred_on`; both match
  `^\d{4}-\d{2}-\d{2}$`.
- Exactly one of `actor_user_id`, `actor_system`; `reason` required with a user.
- Provenance: `recorded` ⇒ the three backfill fields NULL; `reconstructed` ⇒
  all three NOT NULL **and** `actor_system LIKE 'migration:%'`.
- `journal_role` NOT NULL ⇔ `journal_entry_id` NOT NULL.
- `journal_entries_source_chk` widened to add `input_vat_event`.

### 25.6 New triggers

| # | Trigger | Rule |
|---|---|---|
| T1 | `input_vat_events_immutable` — BEFORE UPDATE OR DELETE (row) and BEFORE TRUNCATE (statement) | always raises — the app role **and** the owner role |
| T2 | `input_vat_events_admit` — BEFORE INSERT | transition admitted; `journal_role` matches the transition; **tenancy**: the document, related document, capture, followed event and journal entry all belong to `NEW.organization_id` / `NEW.company_id`; document status ∈ the posted set (`approved`, `paid` — confirmed against the live claim rule at implementation); **dates**: `posting_date = occurred_on` for every type except `restored_on_payment`; claim window refused past 31/12/(Y+5) — anchored on `bills.date` exactly as the live `bills_vat_evidence_gate` is until 13B-5 moves both to the supply date; `claimed` must move the **whole** HELD balance (no partial claims); `restored_on_payment.follows_event_id` must be a `reversed_unpaid` of the same document; locks the document's balance row (created on first use), refuses any bucket < 0, and writes `NEW.buckets_after` |
| T3 | `input_vat_events_apply` — AFTER INSERT, `SECURITY DEFINER`, pinned `search_path` | applies the transfer to `input_vat_balances` (the app role has no write grant on that table) |
| T4 | `input_vat_events_journal_link` — CONSTRAINT TRIGGER AFTER INSERT, DEFERRABLE INITIALLY DEFERRED | at commit: the entry exists, same company, `status = 'posted'`, `date = posting_date`, `source` not in the opening set; role rules — `own_entry`: `entry_number` = `BILL-`/`BILLCN-` + the document's `bill_number`; `claim_entry`: equals `bills.input_vat_claim_entry_id`; `event_entry`: `source = 'input_vat_event'`; **amount**: `claim_entry` = the entry's `VAT_INPUT` debit; `event_entry` = its lines on the bucket's adjustment/holding account; `own_entry` = the entry's `VAT_INPUT` (claimed) or `VAT_AWAITING_EVIDENCE` (held) debit, or `bills.vat_amount` (blocked) — this last rule must be proven on product-written rows, including a Z-AP1 netted final bill |
| T5 | `journal_entries_input_vat_link` — CONSTRAINT TRIGGER AFTER INSERT ON `journal_entries`, DEFERRABLE INITIALLY DEFERRED, `WHEN (NEW.source = 'input_vat_event')` | at commit, exactly one event references the entry |
| T6 | `journal_entries_vat_reversal_guard` — BEFORE UPDATE OF status ON `journal_entries` (the 0101/0102 pattern) | refuses `posted → reversed` for an entry that §19 rules 1–3 protect |
| T7 | `journal_entry_lines_vat_guard` — BEFORE UPDATE OR DELETE ON `journal_entry_lines` | refuses changing or deleting a line of an entry §19 protects. **Why:** the search for database immutability of posted entries found only status-transition and insert guards (0101, 0102, 0073) — a protected entry's lines are otherwise mutable in the database, which would break journal linkage silently. Scoped to protected entries only, so no other path changes |

### 25.7 New accounts

| Field | `VAT_ADJ_NONPAYMENT` | `VAT_ADJ_BLOCKED` |
|---|---|---|
| `name` | VAT Adjustment – Non-Payment (Art. 40(10)) | VAT Adjustment – Blocked (Art. 50) |
| `name_ar` | تعديل ضريبة المدخلات – عدم السداد (المادة 40(10)) | تعديل ضريبة المدخلات – غير قابلة للخصم (المادة 50) |
| `type` / balance | `asset`, credit (contra; `ACCUMULATED_DEPRECIATION` precedent) | same |
| `is_system` / `vat_applicable` / treatment / `treatment_verified` | true / false / `O` / false | same |
| `liquidity_class` | `current` | same |
| `sort_order` | beside `VAT_AWAITING_EVIDENCE` (31) — next free values, confirmed at implementation | same |

The names are used **verbatim** (A-1) — the implementation copies these
strings, including the en dash and the Arabic, rather than retyping them.
Nothing posts to either account until 13B-6/13B-8; they exist at zero.
Seeding: §7.3 (template rows + existing-org `INSERT … SELECT`; no function
redefinition — A-2).

### 25.8 Existing services to reuse

`postJournalEntry` (`services/accounting/glPosting.ts`), `checkPeriodOpen`
(`periodLock.ts`), `lib/money.ts`, `billsRepository.lockForUpdate`,
`repositories/billPosition.ts`, `auditService`, `@workspace/shared`
`businessDate.ts`, `withinClaimWindow` (`purchaseEvidence/vatEvidence.ts`),
`journalEntriesRepository.documentOwner`, `scripts/ledgerInvariants.ts`, the
0101/0102 trigger patterns, the 0106 account-seeding pattern, the 0101
RLS/grant/REVOKE block. (In 13B-1 only the last five are exercised; the rest
are the seams 13B-3+ must use.)

### 25.9 Existing services that must NOT be duplicated

No second posting path (only `postJournalEntry`); no second "what a bill owes"
(only `billPosition`); no second rounding; no second business date; no second
claim-window definition (the trigger mirrors `withinClaimWindow`, with a test
that fails when they drift); no second document-owner lookup or reversal
guard (extend `documentOwner` and the existing trigger family); no second
findings/alarm pipeline, and nothing through the AI findings path; no second
account-seeding mechanism.

### 25.10 Migration sequence (one file)

1. Template rows for the two accounts + existing-organisation `INSERT … SELECT`.
2. Widen `journal_entries_source_chk`.
3. Create and seed `input_vat_event_transitions`.
4. Create `input_vat_events`, `input_vat_balances`, FKs, CHECKs, indexes.
5. Functions and triggers T1–T5.
6. RLS (`tenant_isolation`, the 0101 form with the company GUC) on both
   tenant tables; GRANT `SELECT, INSERT` on events and `SELECT` on balances and
   transitions to `authenticated`; the 0101 `REVOKE UPDATE, DELETE, TRUNCATE,
   REFERENCES, TRIGGER` loop.
7. T6 and T7 on the journal tables.

**Fresh-database compatibility:** the file must apply on an empty database
(migrate from 0000: the org backfill selects zero rows, the transitions seed
is static) **and** on a populated one (the triggers touch no existing row; no
existing data is rewritten). No `CREATE INDEX CONCURRENTLY` or anything else
that cannot run inside the migrator's transaction.

### 25.11 Transaction boundaries

- **Migration:** applied atomically by the migrator; a failure leaves no part
  applied (verified by running it twice and on a copy of a populated DB).
- **Events (for 13B-3+, fixed now):** document row lock → `postJournalEntry`
  (when the role is `event_entry`) → insert event → T2/T3 inside the
  statement → T4/T5 at commit. One transaction; any refusal rolls back the
  entry too.
- **Reversal guard (live in 13B-1):** the service refuses before any mirror
  is posted; if the service guard were bypassed, T6 aborts the request's
  transaction, so no orphan mirror entry survives (asserted by the mutation
  test).

### 25.12 Tenant isolation

RLS on `input_vat_events` and `input_vat_balances` (the data-driven
`rls-coverage.test.ts` and `destructive-grants.test.ts` then cover them with
no edit); `organization_id` / `company_id` NOT NULL; T2 checks every
referenced row's tenant, because an FK check runs outside RLS (CLAUDE.md §3);
the transitions table carries no tenant data. No new repository is added in
13B-1; `documentOwner` keys on an entry id and reads within the RLS-scoped
transaction.

### 25.13 Idempotency

`UNIQUE (organization_id, idempotency_key)` plus the partial uniques of
§25.4, so a retried insert fails on the key and a *different* key cannot
repeat a claim, a reversal for the same trigger month, a restoration for the
same payment, or a second recognition. The writer contract (13B-3): on a key
conflict return the stored event and its entry, never post a second journal.

### 25.14 Journal linkage

T4 (event → entry) and T5 (entry → event) at commit; T6/T7 keep protected
entries intact afterwards. The sweep adds: every event's entry still exists,
is `posted`, belongs to the same company and matches the
amount rule; every `input_vat_event` entry is referenced once; balances rows
equal the sum of events.

### 25.15 Generic reversal guard

- **Service:** `documentOwner` returns `bill` / `supplier_note` /
  `input_vat_event` (in addition to `bank_transfer` / `statement_line`) per
  §19 rules 1–3; `reverse` refuses them with the §19 wording (409, the
  existing `ConflictError`).
- **Database:** T6 (status) + T7 (lines).
- **Unchanged:** manual entries, bank transfers (through their own path),
  statement lines, and the Batch 1C migration reversal (opening entries are
  never protected).

### 25.16 Backfill requirements

**No VAT event backfill in 13B-1** — the schema does not need one: the ledger
may be empty, balance rows are created on first use, and the reversal guard
identifies bill, note and claim entries without events (§19 rules 2–3). The
only data written is the two accounts' category rows for existing
organisations (chart seeding, not VAT history). The full backfill is 13B-4;
its provenance rules are already enforced by §25.5, so a row reconstructed
later cannot omit them.

### 25.17 Tests 13B-1 will require (none written now)

| Test | Proves |
|---|---|
| Migration: fresh DB from 0000; populated DB copy; re-run | compatibility; atomicity; no existing row changed |
| Accounts | both accounts exist for a new org (seed trigger) and for every existing org; exact EN/AR strings; `org-seed-trigger.test.ts` still green |
| Immutability | UPDATE/DELETE/TRUNCATE refused as `authenticated` **and** as owner |
| Transitions | every admitted triple accepted; every non-admitted triple (notes, `supply_date_changed`, `correction_withdrawn`) and every invented triple refused |
| Buckets | negative refused for each bucket; double claim, double reversal, restoration > reversed, claim from BLOCKED/CORRECTED_BLOCKED/LAPSED refused; `claimed` of less than the whole HELD refused; `buckets_after` cannot be supplied by the caller |
| Dates | `posting_date ≠ occurred_on` refused for a lapse; claim past the window refused; malformed dates refused |
| Provenance | `reconstructed` without migration/source/reference or with a user actor refused; `recorded` with backfill fields refused |
| Idempotency | same key refused; concurrent duplicate inserts → exactly one row |
| Linkage | each role's rule on **product-written** entries (a posted bill, an evidence claim, a Z-AP1 netted final bill); wrong company, draft entry, date mismatch, opening entry, amount mismatch each refused at commit; an `input_vat_event` entry with no event refused |
| Tenancy | presence / absence / movement across two orgs and two companies; FK to another tenant's bill refused by T2 |
| Reversal guard | the §19 mutation matrix through the real HTTP route; planted positives (manual entry, bank transfer, migration reversal); no orphan mirror |
| Line guard | UPDATE/DELETE of a protected entry's line refused; an unprotected entry's lines unaffected |
| Window mirror | trigger rule and `withinClaimWindow` agree on the same boundary dates |
| Invariants script | green on a populated DB; red on a planted divergence |
| Suite | `pnpm run verify` green; `rls-coverage`, `destructive-grants`, `route-reachability`, `privilege-surface-map` green |

### 25.18 Explicitly out of scope for 13B-1

Any event **writer** or production caller that inserts events; 40(10)
proposals and posting; 40(11) restoration; Art. 50 correction workflow;
credit-note integration (any note event); lapse/expiry proposals or posting;
supply-date columns and UI; moving the window to the supply date; the
`bills.input_vat_*` cache-consistency trigger (it would refuse every live bill
approval until the 13B-3 writer exists); the VAT event backfill and
reconciliation; fixed-asset cost adjustment; inventory; VAT return changes;
13D; `correction_withdrawn`; any UI; any AI; scheduled alarms or jobs; any
change to the permission matrix or the evidence-claim authority (A-4);
redefining `seed_org_chart_of_accounts()`; editing CLAUDE.md beyond the
close-out status/invariant lines.

### 25.19 Acceptance criteria

1. One migration applies cleanly on an empty database and on a populated
   copy, and changes no existing row other than adding the two accounts'
   category rows.
2. Both accounts exist in every organisation with the exact §25.7 strings.
3. Every §25.17 test passes, and each guard's test goes red when that guard
   is removed (mutation-proof), with its planted positive still green.
4. The generic reverse refuses real `BILL-`, `BILLCN-` and `VATEV-` entries
   through the HTTP route with the §19 wording; manual entries, bank
   transfers and migration reversals still reverse.
5. `pnpm run verify` is green, read from `Test Files` and the exit code; the
   ledger-invariants script is green on a populated database.
6. The standing check is recorded honestly: **no production writer of events
   exists yet** (first producer 13B-3); the only new production behaviour is
   the reversal guard, terminus `POST /journal-entries/:id/reverse` reached
   from the journal-entry page (`apps/web/src/pages/JournalEntries.tsx`).
7. The A-2 seeding discrepancy is stated in the PR description and the
   history record.
8. No file in §25.18's list is touched.

### 25.20 As built — departures from this specification (2026-09-28)

Each is a correction found while building, recorded rather than silently
applied. None changes an accounting decision.

| # | Specified | Built | Why |
|---|---|---|---|
| 1 | "out of / into existence" as a NULL bucket | a `NONE` sentinel bucket | A composite FK is not checked when any column is NULL (MATCH SIMPLE), so a NULL bucket would have let recognition events bypass the transitions FK |
| 2 | a unique index on the transitions table | a composite PRIMARY KEY | drizzle emits FKs before indexes; the events FK needs the key to exist in the same migration |
| 3 | `UNIQUE (document_id) WHERE event_type IN ('lapsed_expired','lapsed_written_off')` | **dropped** | It would have decided that a partial write-off cannot be followed by an expiry of the rest — not a decided rule. HELD bounds every lapse; nothing more is imposed |
| 4 | the owner predicate inside the guard | ONE SQL definition, `input_vat_journal_owner()` (caller's rights, under RLS, granted to the app — the service's refusal reads it), and `input_vat_journal_protected()` (`SECURITY DEFINER` wrapper for the guards, EXECUTE revoked from PUBLIC) | The service must name the owner in its refusal; restating the predicate in TypeScript would have been a second definition (CLAUDE.md §3) |
| 5 | `own_entry` amount = the entry's VAT line, or `bills.vat_amount` (blocked) | exact for `recognised_claimed` (VAT_INPUT) and `recognised_held` (VAT_AWAITING_EVIDENCE) — proven on a real acceptance bill; **bounded** (≤ `bills.vat_amount`) for `recognised_blocked` and `advance_deducted` | A partial-recovery asset and a Z-AP1 netted final bill make "blocked = vat_amount" untrue; the exact rule is defined with the 13B-3 writer that produces these events |
| 6 | T7 refuses UPDATE or DELETE of a protected entry's lines | UPDATE refused for every protected entry; DELETE refused only for an **event-referenced** entry | ~50 existing test cleanups delete bill entries without `session_replication_role = replica`; refusing DELETE for bill entries would have changed that behaviour. Recorded gap: deleting a bill's own entry row (DELETE, not reversal) is outside this guard |
| 7 | (not stated) | the two accounts are in `TAX_ACCOUNT_SYSTEM_CODES` | They hold input-VAT adjustments, so their lines are tax lines (the `VAT_AWAITING_EVIDENCE` precedent). Nothing posts to them in 13B-1, so no report figure moves |
| 8 | (implicit) | every event: `occurred_on` ≥ the document's date; `lapsed_written_off` ≤ the window end; `restored_on_payment` must name its payment (`cause_id`) and follow a `reversed_unpaid` of the same document | Direct consequences of the event definitions in §5.2; each is a refusal, never a computed treatment |
| 9 | "a retried key returns the stored event" | under the balance lock, a key already recorded **skips** the balance-dependent checks; the idempotency index then decides (ON CONFLICT DO NOTHING swallows it; a plain INSERT gets 23505) | Independent review (HIGH): a retried whole-held claim was judged against the balance its first attempt had already moved, and refused as a "partial claim" |
| 10 | (not stated) | trigger `input_vat_events_one_per_statement` (statement-level, transition table): at most ONE event per document per INSERT statement | Independent review (HIGH): row AFTER triggers fire at the END of a statement, so a second row for the same document was admitted against a stale balance — a silent lost update. A writer records one event per document per statement |
| 11 | (not stated) | partial index `bills_input_vat_claim_entry_idx` | Independent review: the owner predicate scanned `bills` on every generic reversal (the 0106 hand-written-index precedent) |
| 12 | (not stated) | trigger `journal_entries_input_vat_source_frozen`: `source` cannot change to or from `input_vat_event` after the entry is written | Independent review: the one-event-per-entry check runs at INSERT; a later UPDATE of `source` would have escaped it |

**Proven:** 21 tests in `phase13b1-vat-event-ledger.test.ts` and
`phase13b1-reversal-guard.test.ts`; each of the eight triggers dropped in turn — and the retry short-circuit removed from
the admission function — turns its tests red and green again when restored; the migration applies on
an empty database (108 migrations) and on a populated acceptance copy (only
the two template rows and two category rows change); the ledger-invariant
sweep passes there and fails on a planted divergence.

**Still open, unchanged by 13B-1:** B-1 and B-2 (§24); G1, G2, G3; the 13D
and Phase 14 deferrals. 13B-1 has **no production writer of events**.