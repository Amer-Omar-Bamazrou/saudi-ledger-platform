# Phase 13B-2 — Credit notes in the input-VAT event ledger (B-1 design)

**Status (2026-09-29): B-1 CLOSED (§19.11) — O-1…O-6 APPROVED; D-4a APPROVED;
D-4b DEFERRED TO G1; CN-1…CN-8 NOT settled by any source (refused by name);
13B-3 UNBLOCKED, to start after the D-4a corrective patch (§19.12) is reviewed.**
This document is design; the only code it led to is 13B-1a (merged) and the
D-4a patch (uncommitted, awaiting review). Base: `main` @ `6279f192`.
Current state authority: [CLAUDE.md §2](../../CLAUDE.md).

> **OWNER DECISION GATE (2026-09-29).**
> - **O-1 — APPROVED, strictly bounded:** credit notes may become append-only
>   input-VAT events **only for the settled cases** of §6. The implementation
>   must NOT silently resolve CN-1, CN-2, CN-3, CN-5, CN-6, defective or
>   missing credit-note evidence, debit-note timing, or ITD Example 29 /
>   Art. 40(10); those stay refused until their own decision gate (§12 NI-4).
> - **O-2 — PENDING.** Not approved as a complete behaviour change until
>   "what is left on the original" is defined in every state and tied to the
>   unresolved allocation rule. §10A now gives that definition as a
>   cumulative invariant that does NOT choose the CN-2/CN-3 allocation; the
>   owner decides O-2 on it.
> - **B-1 — OPEN** until O-2 is decided (§17 lists every 13B-3 prerequisite).
> - D-1…D-6 are triaged in §16A; **D-2 is a Phase 13B-1 scope defect** and is
>   not deferred silently.

Inputs: [`phase-13b-vat-claim-ledger-architecture.md`](phase-13b-vat-claim-ledger-architecture.md)
(§13 credit notes, §24 B-1/B-2, §25 the 13B-1 foundation),
[`phase-13b-vat-claim-ledger-discovery.md`](phase-13b-vat-claim-ledger-discovery.md)
(D13B-11, ADV-11, §28.4), [`phase-13-expenses-decision-pack.md`](phase-13-expenses-decision-pack.md)
§9.3 (X3), migration 0107, and three read-only investigations made for this
batch (Saudi/IFRS sources; Odoo and ERPNext; the live code). The research
order is the owner's (ZATCA/Saudi → SOCPA/IFRS → Odoo → ERPNext → Saudi
Ledger), per [`accounting-escalation-protocol.md`](../accounting-escalation-protocol.md).
(`docs/product/phase-13b-accountant-questions.md`, named in the brief, does
not exist; the 13B questions live in the discovery pack §29–§31 and in §16
below.)

**Labels used for every finding.** AUTH — ZATCA law / Implementing
Regulations / GCC Agreement (Arabic prevails). GUID — ZATCA guideline (they
state they do not amend the regulations). STD — IFRS/SOCPA. ODOO / ERPNEXT —
implementation precedent, never authority. SL — Saudi Ledger's current code
or a product decision. INT — reasoned interpretation, not a source.
SILENT — no source settles it. OPEN — a decision someone still has to make.

---

## 1. Executive decision

**B-1 is resolvable for everything the product can produce today, and is
designed here; it is not fully closed, because two approvals and the
interaction cases remain.**

1. **The settled cases become events, recording live behaviour — no new
   treatment.** A supplier credit note reduces the original document's VAT in
   the bucket it is in at the note's date: HELD (no return effect), CLAIMED
   (return reduction in the note's issue period), BLOCKED (reduces cost). All
   three are what the product posts today; the sources support them (§3).
2. **The event belongs to the ORIGINAL document** (its VAT position is what
   changes), names the note as `related_document_id`, and references the
   **note's own** posted entry (`BILLCN-` / `BILLADVCN-`). This needs a small,
   designed amendment to the 13B-1 foundation (§18, A-B1-1…7): migration 0107
   as merged would refuse such an event.
3. **The interaction cases stay OPEN (G3 / B-2):** a note before, after, or
   partly after an Art. 40(10) reversal (CN-1…CN-3), a note against
   corrected-blocked or lapsed VAT (CN-5, CN-6). The database refuses a note
   event on a document that has EVER recorded a reversal, restoration,
   correction or lapse (history, not balance — so CN-4 is not admitted
   either until confirmed). **That refusal cannot be reached until 13B-6 / 13B-8 exist**
   (no such event can be written before then), so it blocks nothing in
   13B-3…13B-5 and chooses no treatment.
4. **O-1 is APPROVED; O-2 is PENDING; B-1 stays OPEN.** 13B-3 is NOT yet
   unblocked: §17 lists its exact prerequisites (O-2, the D-1 and D-6
   guards, the D-2 corrective patch, O-3/O-4/O-6, the A-B1 amendments).
   B-2 and G3 still block 13B-6 onward, unchanged.

A research finding the reviewers must see: the level reading of Art. 40(6),
which the Arabic GCC Agreement Art. 47(1) supports (§3 Q4), **conflicts** with
the D13B-11 edge proposal ("a note after a partial 40(10) reversal reduces
unreversed CLAIMED VAT first"). That proposal was already NOT approved
(AD-10); this document records the conflict and does not resolve it.

## 2. Current Saudi Ledger behaviour (SL — traced in the code, 2026-09-29)

A supplier note is a `bills` row (`document_type` `credit_note`,
`debit_note`, `advance_credit_note`) linked by `credit_note_against_bill_id`
(FK + CHECK + trigger `check_bill_references`: same company and vendor, the
target must be a `bill`; a note against a note is refused). Posting:
`postBillToGL` (`services/bills.approvable.ts`), which locks the original row
first.

| Case | Journal (the note's own entry, dated the NOTE's date) | Rows written | VAT return today |
|---|---|---|---|
| **Credit note, original HELD** | `BILLCN-<note>`: Dr AP / Cr expense (net) / **Cr `VAT_AWAITING_EVIDENCE`** | original `input_vat_pending` −= note VAT; note row `awaiting_evidence`. Refused above the held amount (`credit_note_exceeds_held_vat`, 422) | none at the note's date. When the evidence arrives, `claimHeldVat` claims the **net** (`VATEV-<orig>` Dr VAT_INPUT / Cr holding) and `claimNotesFollowing` marks each held note `claimed` on the claim date — the return shows +original −note in the claim period, i.e. the net. The evidence date may not precede the latest held note (`evidence_date_before_credit_note`) |
| **Credit note, original CLAIMED** | `BILLCN-`: Dr AP / Cr expense / **Cr `VAT_INPUT`** | note row `claimed` on its own date; original untouched | −note VAT in the note's own period |
| **Credit note, original BLOCKED** (Art. 50 / 0 %-recovery asset) | `BILLCN-`: Dr AP / Cr expense (net + VAT), no VAT line; credited account = the NOTE's expense account, else PURCHASES | note row `not_deductible` | none |
| **Debit note** | ordinary bill path: `BILL-<note>`, its own evidence verdict, its own held/claimed state and `VATEV-` | as a bill | as a bill |
| **Advance credit note** (Z-AP1) | `BILLADVCN-<note>`: Dr `SUPPLIER_ADVANCES` / Cr `VAT_INPUT` (no AP) | row `claimed` on its own date; capped at what is open on the advance | −VAT in its own period |
| **Applying a credit note** to a bill | **posts nothing** (a `supplier_payment_allocations` row with no entry); VAT untouched | allocation row | none |

Treatment is per DOCUMENT: no bill carries two VAT treatments at once (a
partial-recovery asset above 0 % claims its whole VAT — FA pack). A note
carries its own VAT amount; notes have no line-level link to the original.

**Live defects found by this trace (SL — reported, NOT fixed; §16 O-5):**

| # | Finding | Consequence |
|---|---|---|
| D-1 | Outside the HELD case nothing caps a note's VAT: `credit_exceeds_bill` checks TOTALS, only at create, counting posted notes only; PATCH and approval never re-check; two drafts can together over-credit | a note's VAT can exceed the original's VAT — which Art. 54(1) excludes (§3 Q5). Once note events exist, the bucket invariant would refuse at approval what today posts |
| D-2 | `BILLADV-` / `BILLADVCN-` entries are not matched by `input_vat_journal_owner()` (`'BILLADV-…'` is not `LIKE 'BILL-%'`) | a supplier advance invoice's VAT claim, and an advance credit note, can still be reversed generically — the class A-5 closed for bills |
| D-3 | `note_against_capitalised_bill` checks the NOTE's `capitalises_asset_id`, not the original's | a normal credit note against a capitalised bill credits PURCHASES and leaves the asset register untouched (G1 territory) |
| D-4 | A debit note ignores the original's state | a debit note can CLAIM VAT on a supply whose original VAT was Art. 50-blocked |
| D-5 | `heldSql` has no `document_type` filter | held credit notes probably appear in the held-for-evidence list (not verified in the UI) |
| D-6 | No check compares a B7 note's date with its original's | a note dated before its invoice posts; the 13B-1 admission trigger would refuse its event |

## 3. Regulatory and accounting research

| Q | Finding | Class | Source |
|---|---|---|---|
| Who adjusts under 40(6), when | BOTH parties. The customer «يجب على العميل أن يصحح ضريبة مدخلاته … في الفترة الضريبية التي أصدر فيها الإشعار» — in the period the note was **issued**, not received, not the original period | AUTH | IR 40(6) (Arabic 2025 ed.; same text in the earlier edition) |
| Supplier vs customer period | supplier's decrease: the later of the event period and the issue period (40(5)); customer: always the issue period — the two sides can fall in different periods | AUTH | IR 40(4)–(6) |
| Level vs delta | «عند التغيير» is ambiguous. Guidance reads it as the tax on the adjustment (delta); GCC 47(1) compares tax deducted with tax «المتاح له خصمها» (level). **They agree whenever the full VAT was deducted** | GUID vs AUTH; SILENT where they differ | Invoicing guideline v3 §7.1.1; GCC Agreement 47(1) |
| Note while VAT is HELD | no return adjustment: the duty attaches to a prior deduction; the later deduction is the NET | GUID + AUTH + INT | Invoicing v3 §7.1.1 («وقام بخصم … مسبقاً»); ITD v3 §10.1; GCC 47(1) («التي خصمها»); IR 49(7) (evidence of tax paid or payable) + GCC 57 (a note is treated as the invoice) |
| Note after deduction | reduction in the note's issue period; return box for the customer | AUTH (period); SILENT (box → 13D) | IR 40(6) |
| Note received after its issue period's return was filed | — | SILENT | — |
| Partial / multiple notes | allowed; each corrected in its own issue period; a note references its invoice(s), one note over several invoices states the amount per invoice | AUTH + GUID | IR 40(1)(أ),(د) («كلياً أو جزئياً»); IR 54(4); invoicing v3 §7.2.1 |
| Upper bound | a note arises where the tax charged «يتجاوز الضريبة المستحقة» — so Σ note VAT ≤ invoice VAT by construction | AUTH | IR 54(1) |
| Note against BLOCKED (Art. 50) VAT | nothing was deducted → no return effect; the note reduces the cost that absorbed the VAT (same for lapsed and corrected-blocked VAT) | INT, consistent with AUTH/GUID | — |
| Note before/after an Art. 40(10) reversal | no text addresses the interaction | SILENT | — (§11) |
| Time limits | 40(12) refers to the Law/IR limits without naming one; a reduction is a current-period duty — 49(8) limits deductions, not reductions; a debit-note INCREASE is plausibly bounded by 49(8) | AUTH (40(12)); INT; SILENT | IR 40(12), 49(8) |
| Evidence for a note | a note must carry the Art. 53 particulars + the invoice reference and is treated as a tax invoice. A debit note's extra deduction needs it as evidence; a credit note's reduction applies whatever its form (a reduction cannot create an over-claim) — INT. Whether a defective credit note may be ignored: SILENT | AUTH + INT + SILENT | IR 53, 54(4); GCC 57 |
| IFRS | recoverable VAT (held or claimed): the note reduces the VAT asset, no P&L effect; non-recoverable VAT (blocked, lapsed, reversed-to-cost): the note's VAT reduces the same cost as its net amount; current-period, prospective (not an error correction). Inventory / fixed assets: reduce cost (IAS 16 has no explicit rule for later price cuts — SILENT) | STD | IAS 2.11; IAS 16.16(a); IAS 38.27(a); IAS 8.36–37 (by analogy); IAS 10.9(c) |
| ITD Example 29 | a pending judicial dispute stops the 40(10) reversal; the IR mentions disputes only in the financing exception — guidance exceeds the IR (the IR prevails, ADV-13) | GUID vs AUTH | ITD v3 Ex. 29 (a B-2 matter, recorded) |

## 4. Odoo precedent (ODOO — 18.0 @ `935210ad`; not authority)

- A vendor refund (`in_refund`) is a **new document dated on its own date**;
  the bill's tax lines are never edited. Its tax line credits the same input
  VAT account with the refund tag (`-7` in `l10n_sa`) — box 7 reads net, in the
  refund's period (`account_tax.py:2408-2411`; `l10n_sa` `account.tax-sa.csv`).
- `reversed_entry_id` is an optional read-only link; a linked refund is
  auto-reconciled with the bill (`account_move.py:5258-5265`).
- Partial and multiple refunds are allowed; **nothing caps** a refund's tax
  against the bill's tax (searched `exceed|already reversed|reversal_move_ids`
  in `account_move*.py`, `account_partial_reconcile.py`, `wizard/*.py`).
- Cash-basis taxes: a refund against a partly exigible bill cancels the part
  **still waiting** and leaves the part already released — by **new dated
  entries**; undoing posts a reversal, never a deletion
  (`account_partial_reconcile.py:277-302`; `test_in_refund_reverse_caba`).
  This is the same NET effect as Saudi Ledger's held-note path.
- Non-deductible share (a repartition line without an account) credits the
  expense on a refund, using the split in force at refund time
  (`account_tax.py:2451`).
- **No** logic for a refund against a bill whose input tax was reversed for
  non-payment (searched `bad.?debt|irrecoverable|doubtful|input.?(tax|vat).*(revers|adjust)`
  over `account`, `l10n_sa`, `l10n_ae`, `l10n_gcc_invoice`; the search found
  the doubtful-debts chart account, so it can see matches).

## 5. ERPNext precedent (ERPNEXT — version-15 @ `4aee12e1`; not authority)

- A return Purchase Invoice (`is_return=1`, `return_against`) is a new
  document; its negative tax debit is flipped into a **credit to input VAT**
  dated the return's posting date (`general_ledger.py:348`).
- Outstanding is DERIVED from the Payment Ledger; by default
  (`update_outstanding_for_self = 1`) the return keeps its own negative
  balance rather than reducing the bill's.
- Returned **quantity** is capped per line against the original minus all
  submitted returns (`sales_and_purchase_return.py:188-330`) — partial and
  multiple returns work; there is **no amount or tax cap** on purchase
  returns, and a return with no `return_against` skips return validation.
- **No** non-payment input-VAT logic (searched `bad.?debt|irrecoverable|doubtful|input.?(tax|vat).{0,20}(revers|adjust)`
  over `erpnext/`; only chart files hit). Regional: v15 has no KSA module;
  the UAE VAT 201 report has no return logic (an inferred defect: a debit
  note would ADD to recoverable VAT).

**What the precedents establish:** a note is a new, dated fact that never
edits the original (both systems) — the same shape as the append-only
ledger. What they do NOT establish: any cap (Saudi Ledger's bound comes from
AUTH 54(1)), or any interaction with a non-payment reversal (neither has one).

## 6. Credit-note lifecycle matrix (cases A–H of the brief)

"Event" = what the 13B-3 writer would record; "Return" = what the event
tells 13D (the current return is not changed). Journal = the entry that
ALREADY posts today; no new journal entry is designed for any settled case.

| Case | Status | Event(s) | Bucket transfer | Cause | Period (occurred = posting) | Journal | Return | Remaining VAT |
|---|---|---|---|---|---|---|---|---|
| **A** held, note before the claim | **SETTLED** (GUID + AUTH + INT; ADV-11; X3 live) | `reduced_by_note` on the original; later `claimed` of the whole remaining HELD | HELD → NONE (note VAT); later HELD → CLAIMED (net) | the note (`related_document_id`, `cause_type='credit_note'`) | note date; claim on the evidence date | note's `BILLCN-` (Cr `VAT_AWAITING_EVIDENCE`) | none at the note; the claim is the net in the evidence period | HELD − note VAT, claimable once evidenced |
| **B** claimed, then note | **SETTLED** (AUTH 40(6); ADV-11) | `reduced_by_note` | CLAIMED → NONE | the note | note's **issue** date | note's `BILLCN-` (Cr `VAT_INPUT`) | −note VAT in the note's issue period (box: 13D) | CLAIMED − note VAT |
| **C** VAT partly/fully out of the deduction by earlier events, then note | **OPEN** — CN-2/CN-3 (after 40(10)), CN-5 (corrected-blocked), CN-6 (lapsed) | none until decided | — | — | — | — | — | — |
| **D** note larger than the remaining VAT in its bucket | **SETTLED as a refusal** (AUTH 54(1) bounds Σ notes ≤ invoice VAT; SL bucket invariant) | none — refused | would make the bucket negative | — | — | — | — | — |
| **E** several notes on one bill | **SETTLED** (AUTH 40(1), 54(4)) | one `reduced_by_note` per note, in note-date order | each from the bucket the VAT is in at its date | each note | each note's issue date | each note's own entry | per note (B) or none (A) | cumulative, never below zero |
| **F** note on a bill whose VAT was reversed under 40(10) | **OPEN** — CN-2 (B-2 / G3) | — | — | — | — | — | — | — |
| **G** note, then payment / 40(11) restoration | **OPEN** — CN-1 (note BEFORE the 40(10) trigger changes the unpaid base) and CN-3 (after partial restoration); CN-4 (after FULL restoration): candidate convergent, **not admitted** until Q-B1-2 confirms — see §11 | — | — | — | — | — | — | — |
| **H** note on part of the purchase | **SETTLED** (AUTH 40(1)(د), 54) | `reduced_by_note` for the NOTE's VAT amount | as A or B by bucket | the note | note date | note's entry | as A or B | reduced by the note's VAT only |
| (blocked) note on Art. 50 / 0 %-recovery VAT | **SETTLED** (INT consistent with AUTH/GUID; X5 live) | `reduced_by_note` | BLOCKED → NONE | the note | note date | note's `BILLCN-` (no VAT line; cost credited) | none | BLOCKED − note VAT |
| (advance) note on a supplier advance invoice | **SETTLED** (Z-AP1 live; AUTH 40(6)) | `reduced_by_note` on the ADVANCE document | CLAIMED → NONE | the advance credit note | note date | `BILLADVCN-` (Cr `VAT_INPUT`) | −VAT in its period | advance CLAIMED − note VAT |

Answers to the brief's 15 questions for the settled rows, in one place:
(1) the document's bucket falls by the note's VAT; (2) one `reduced_by_note`
per note on the original; (3) HELD/CLAIMED/BLOCKED → NONE; (4) cause = the
note, `related_document_id`; (5) the note's issue date; (6) HELD falls
(A); (7) CLAIMED falls (B); (8) REVERSED_UNPAID: not touched — OPEN (§11);
(9) BLOCKED falls (blocked row); (10) stays in its bucket, claimable or not as
before; (11) the note's own live entry — nothing new; (12) none — no
adjustment account is involved in a settled case; (13) HELD: no return
effect, the later claim is net; CLAIMED: a reduction in the note's issue
period; BLOCKED: none — box placement is 13D; (14) the event and its entry,
both immutable (13B-1 guards); (15) bucket non-negativity plus one event per
note (§12).

## 7. Event / bucket model

- **Keyed on the ORIGINAL** document (`document_id`), because its VAT position
  is what changes; `related_document_id` = the note. (Keying on the note
  fails: the note's own balance row is zero and the transfer would go
  negative.)
- **Credit notes and advance credit notes:** `reduced_by_note`, from
  HELD / CLAIMED / BLOCKED to NONE — the transitions 0107 already lists,
  today NOT admitted.
- **Debit notes: their OWN documents** (proposal, O-3). The live code already
  treats a debit note as a bill: its own evidence verdict, its own held or
  claimed state, its own `BILL-` entry and `VATEV-` claim. Its events are the
  ordinary `recognised_*` / `claimed` on the DEBIT NOTE document. The
  transitions `increased_by_note` stay NOT admitted (retired in favour of this
  model). D-4 (a debit note claiming VAT on a blocked supply) is an accountant
  question (Q-B1-6), not a modelling one.
- **Admission rule for note events (designed, A-B1-2; tightened at the owner
  gate):** admitted only while the original has **never** recorded a
  `reversed_unpaid`, `restored_on_payment`, `corrected_blocked`,
  `lapsed_expired` or `lapsed_written_off` event (HISTORY, not balance — a
  balance rule would admit CN-4, which is not yet confirmed). Otherwise
  refused by name (`input_vat_note_interaction_undecided`). **Dormant until
  13B-6/13B-8** — no such event can exist before then.
- **A held note reduces HELD; the later claim is the whole REMAINING HELD**
  (D13B-05 unchanged). If notes bring HELD to zero, no `claimed` event is
  written (an event moves a positive amount): a document whose buckets are all
  zero has no VAT position, and the cache's `claimed` label for it is a
  presentation rule 13B-3 states (A-B1-6).
- **Held notes "following the original into the claim period"** (the live
  return mechanics) are a cache/return-query artefact of today's columns; the
  events carry the same totals (net claim in the evidence period), so the
  projection 13D consumes agrees in total. The line-level presentation
  (+original −note vs net) is 13D's.

## 8. Journal-entry model

**No new journal entry for any settled case.** The event references the
entry the note ALREADY posts:

| Note | Entry referenced | Amount rule the database checks (A-B1-4) |
|---|---|---|
| credit note on HELD VAT | `BILLCN-<note>` | the entry's **credit** on `VAT_AWAITING_EVIDENCE` = event amount |
| credit note on CLAIMED VAT | `BILLCN-<note>` | the entry's **credit** on `VAT_INPUT` = event amount |
| credit note on BLOCKED VAT | `BILLCN-<note>` | no VAT line exists: event amount = the note's `vat_amount` (exact — the note states its own VAT) |
| advance credit note | `BILLADVCN-<note>` | the entry's credit on `VAT_INPUT` = event amount |

No VAT adjustment account (`VAT_ADJ_NONPAYMENT`, `VAT_ADJ_BLOCKED`) is used by
any settled case. Journals for the OPEN cases (e.g. whether a note after a
40(10) reversal debits `VAT_ADJ_NONPAYMENT`) are **not designed** — they
depend on Q-B1-2.

## 9. Period / date rules

- `occurred_on` = `posting_date` = the note's **issue** date (AUTH 40(6)) —
  the date the note already posts on. Equality is already enforced by 0107.
- The note's date must be on or after the original's (the 0107 admission
  trigger already refuses an event dated before its document). **No service
  checks this today (D-6)**; 13B-3 adds the refusal at the note's approval so
  the posting and the event agree (O-4).
- A held credit note precedes the claim (live rule
  `evidence_date_before_credit_note`, kept).
- The note's period must be open (the posting path already refuses a closed
  period, 423). A note whose issue period's **return was already filed**:
  SILENT (Q-B1-3) — the period lock is the filed-return proxy, so today the
  product refuses it; that refusal is recorded, not endorsed.
- No time bar on a credit-note reduction (INT, §3); a debit note's increase
  follows the debit note's own claim window (as a bill).

## 10. Partial and multiple notes

- Each note is one event for **its own VAT amount** (AUTH 40(1)(د), 54). No
  proportional computation; notes carry no line-level link and need none.
- Several notes: one event each, applied in note-date order (then note id),
  each from the bucket the VAT is in at that date.
- **Cumulative bound:** Σ reductions ≤ the bucket at each event (bucket
  non-negativity, live since 0107), which realises AUTH 54(1) (Σ note VAT ≤
  invoice VAT). D-1 (today's missing cap) becomes a refusal **at the note's
  approval** once 13B-3 records the event in the same transaction — a
  behaviour change the owner approves (O-2).
- One event per note: `UNIQUE (related_document_id) WHERE event_type =
  'reduced_by_note'` (A-B1-5).

## 10A. O-2 — "what is left on the original", defined without choosing an allocation

O-2 is **PENDING** (owner, 2026-09-29). The reason: a refusal limit is only
enforceable once its meaning is fixed in every state, and in some states the
meaning would depend on the CN-2/CN-3 allocation, which is undecided. This
section separates the two: a **document-level** quantity that no allocation
policy affects, and the **bucket-level** allocation that stays OPEN.

### The quantities

For an original document *D* (a bill, or a supplier advance invoice):

- **T(D)** — the VAT charged on the supply: `bills.vat_amount` of *D*.
  (Whether T(D) also includes the VAT of debit notes against *D* depends on
  O-3 and Q-B1-7 — see CN-8 below; until decided, T(D) is *D*'s own VAT only,
  the stricter value.)
- **N(D)** — the VAT of every POSTED credit note against *D*:
  Σ `vat_amount` of the notes with `credit_note_against_bill_id` = *D*
  (and advance credit notes against an advance invoice).
- **R(D) = T(D) − N(D)** — the VAT left on the original that a further credit
  note may still reduce.

### The cumulative invariant (enforceable now, allocation-independent)

**CI-1. For every original D: N(D) ≤ T(D)** — equivalently, a new note *n*
is admissible only if `vat(n) ≤ R(D)` at its approval.

- **Basis:** IR Art. 54(1) — a credit note arises where the tax charged
  «يتجاوز الضريبة المستحقة» (exceeds the tax due), so the total VAT credited
  can never exceed the VAT charged (AUTH, by construction); partial and
  multiple notes are allowed within it (AUTH 40(1)).
- **Why it is independent of the allocation:** reversals (40(10)),
  restorations (40(11)), Art. 50 corrections and lapses move VAT **between
  buckets** of *D*; none of them changes T(D) or N(D). So R(D) is the same
  number whatever happened to *D*'s buckets, and whatever order a future
  policy uses to allocate a note among them.
- **Bucket non-negativity (CI-2, live since 0107)** remains separately in
  force; it is not a substitute for CI-1 (a bucket can hold less than R(D) —
  see CN-7, CN-8).

### What "left" means in every state

"Allocation" = which bucket(s) of *D* the note reduces.

| # | State of D | R(D) (CI-1 limit) | Allocation | Status |
|---|---|---|---|---|
| 1 | HELD only | T − N | HELD | SETTLED (§6 A) |
| 2 | CLAIMED only, no reversal history | T − N | CLAIMED | SETTLED (§6 B; AUTH 40(6)) |
| 3 | REVERSED_UNPAID > 0 (with or without CLAIMED) | T − N (unchanged by the reversal) | UNDECIDED — CN-2 | REFUSED by NI-4 until Q-B1-2 |
| 4 | BLOCKED only | T − N | BLOCKED | SETTLED (§6 blocked row) |
| 5 | CORRECTED_BLOCKED > 0 | T − N | UNDECIDED — CN-5 | REFUSED by NI-4 until Q-B1-4 |
| 6 | LAPSED > 0 | T − N | UNDECIDED — CN-6 | REFUSED by NI-4 until Q-B1-4 |
| 7 | Combinations | T − N | Among HELD / CLAIMED / BLOCKED, two cannot be non-zero at once for an admitted document (treatment is per document, claims are whole — D13B-05); every combination involving REVERSED_UNPAID, CORRECTED_BLOCKED or LAPSED is UNDECIDED | REFUSED by NI-4 |
| 8 | After previous notes | T − ΣN (every posted note counts) | the single non-zero bucket | SETTLED for states 1, 2, 4 |
| 9 | Partial note | the note's own VAT is tested against R(D) | as the state | SETTLED for states 1, 2, 4 |
| 10a | Note BEFORE the 40(10) trigger | T − N | CLAIMED (state 2) — the note itself is settled; its effect on the later 40(10) base is CN-1 | note SETTLED; CN-1 OPEN (blocks 13B-6, B-2) |
| 10b | Note AFTER a 40(10) reversal | T − N | UNDECIDED — CN-2 | REFUSED by NI-4 |
| 11a | After a PARTIAL restoration | T − N | UNDECIDED — CN-3 | REFUSED by NI-4 |
| 11b | After a FULL restoration | T − N | candidate CLAIMED (CN-4 convergent reading) — unconfirmed | REFUSED by NI-4 (history rule) until Q-B1-2 |

### The allocation rule — explicitly UNRESOLVED

For states 3, 5, 6, 7 (mixed), 10b, 11a and 11b, **how a note's VAT is split
among CLAIMED, REVERSED_UNPAID, CORRECTED_BLOCKED and LAPSED is NOT
decided.** Two readings exist (§11 CN-2): the level reading (GCC 47(1) —
reduce the non-deducted part first, no return effect) and the D13B-11 edge
proposal (reduce CLAIMED first, NOT approved). Nothing in this design picks
one. Two further cross-document cases are added:

| # | Case | Why the allocation is open | Status |
|---|---|---|---|
| **CN-7** | a credit note against a FINAL bill that deducted a supplier advance (Z-AP1) whose note VAT exceeds the final bill's own CLAIMED bucket (the prepaid VAT sits on the ADVANCE document) | whether the excess reduces the advance's claimed VAT. (A note WITHIN the final bill's bucket is attributed to the final bill because the note names it — IR 54(4), AUTH — not by an allocation choice.) | **OPEN** (Q-B1-9) |
| **CN-8** | a credit note against *D* after debit notes against *D* (debit notes are their own documents under O-3) whose VAT exceeds *D*'s own bucket | whether the excess reduces the debit note's VAT | **OPEN** (Q-B1-7/O-3) |

In both, CI-1 may hold while the single bucket is too small; the event would
be refused by bucket non-negativity. **That refusal must be a named
"allocation undecided" refusal, never an "over-credit" one** — the note is
not proven excessive.

### O-2 as the owner will decide it (proposal — PENDING)

At a credit note's approval, in the same transaction as its event:

1. **Refuse as OVER-CREDIT** when `vat(n) > R(D)` — CI-1, AUTH 54(1). Applies
   in every state, because R(D) does not depend on the allocation.
2. **Refuse as ALLOCATION-UNDECIDED** when *D*'s history contains a
   reversal / restoration / correction / lapse (NI-4), or when
   `R(D) ≥ vat(n) >` the single non-zero bucket (CN-7, CN-8).
3. **Otherwise** record `reduced_by_note` from the single non-zero bucket
   (states 1, 2, 4) — live behaviour.

Only rule 1 is new behaviour for CLAIMED and BLOCKED originals (it closes
D-1); rules 2 and 3 cannot be reached by anything the product records before
13B-6 / 13B-8, except CN-7 / CN-8, which the owner should weigh as the one
rule-2 case reachable at 13B-3.

## 11. Art. 40(10) / 40(11) interaction

| # | Case | What the sources say | Status |
|---|---|---|---|
| CN-1 | note BEFORE the 40(10) trigger | SILENT. INT: "unpaid consideration" = revised price − payments; a note **set off** against the payable reduces UNPAID, a cash refund reduces PAID. In Saudi Ledger a credit note is only ever **applied** (a set-off, posts nothing) — there is no cash-refund path for B7 notes (SL) | **OPEN** (Q-B1-1) — B-2 |
| CN-2 | note AFTER a (partial) reversal | SILENT. Level reading (GCC 47(1), INT): the note first reduces REVERSED_UNPAID with no return effect; delta reading can drive the deduction negative (e.g. VAT 150, 100 reversed, note cancels 60 of the unpaid: 50 − 60 = −10). **Conflicts with the D13B-11 edge proposal** (reduce CLAIMED first) — already not approved | **OPEN** (Q-B1-2) — B-2 / G3 |
| CN-3 | note after a PARTIAL restoration | as CN-2, plus how the restorable ceiling shrinks | **OPEN** (Q-B1-2) |
| CN-4 | note after FULL restoration | both readings coincide when the full VAT is deducted again, so the ordinary 40(6) treatment (row B) would follow from either — but whether the reversal/restoration history itself changes anything is SILENT | **OPEN (candidate: convergent)** — NOT admitted: the §7 history rule refuses it until Q-B1-2 confirms |
| CN-5 | note on CORRECTED_BLOCKED VAT | no return effect (INT); the journal (reduce cost vs `VAT_ADJ_BLOCKED`) is undesigned | **OPEN** (Q-B1-4) — 13B-8 |
| CN-6 | note on LAPSED VAT | no return effect (INT); reduces the lapsed cost | **OPEN** (Q-B1-4) — 13B-8 |
| — | ITD Example 29 (a dispute suspends 40(10)) vs the IR | GUID exceeds AUTH | **OPEN** (Q-B1-8) — B-2 |

The mirror guard for 13B-6 (a 40(10) reversal on a document with note
history, CN-1) is B-2's to design; nothing here builds it.

## 12. Database invariants (designed for 13B-3; 0107 is not modified)

Carried from 13B-1 (unchanged): append-only events, non-negative buckets,
tenancy of every referenced row, `occurred_on` ≥ the document's date, journal
linkage at commit, one event per document per statement, idempotency.

New, for note events:

| # | Invariant |
|---|---|
| NI-1 | `reduced_by_note` requires `related_document_id` = a POSTED note (`credit_note` or `advance_credit_note`) whose `credit_note_against_bill_id` = `document_id` |
| NI-2 | its journal is the NOTE's own entry — a new journal role `note_entry`: `entry_number` = `'BILLCN-'||note.bill_number` or `'BILLADVCN-'||note.bill_number`, same company, posted, dated the event |
| NI-3 | amount = the note entry's credit on the bucket's account (HELD → `VAT_AWAITING_EVIDENCE`, CLAIMED → `VAT_INPUT`); BLOCKED → the note's `vat_amount` |
| NI-4 | admitted only while the original has NO `reversed_unpaid` / `restored_on_payment` / `corrected_blocked` / `lapsed_*` event in its history (§7), refused by name otherwise |
| NI-8 | **the cumulative invariant CI-1** (§10A) — checked at admission, independent of any allocation |
| NI-5 | one event per note (`UNIQUE (related_document_id) WHERE event_type = 'reduced_by_note'`); a note entry is referenced by one event |
| NI-6 | `occurred_on` = the note's date ≥ the original's date (already implied; stated) |
| NI-7 | recognition of an advance document references `BILLADV-` (the `own_entry` rule is extended to the advance prefixes) |

The ledger-invariant sweep gains: every posted credit/advance-credit note has
exactly one `reduced_by_note` event once 13B-3 writes and 13B-4 backfills; the
events reconcile to `VAT_AWAITING_EVIDENCE` / `VAT_INPUT` per document through
the notes (closing the reconciliation gap B-1 named).

## 13. Idempotency

- Key `reduced_by_note:<note id>`; retried approvals are no-ops (13B-1's
  short-circuit).
- NI-5 makes a second event for the same note unwritable even under a
  different key.
- The note's approval and its event are ONE transaction (the note posting
  already locks the original row), so a note can never be posted without its
  event, or the reverse.

## 14. Tenant isolation

- The 13B-1 admission trigger already checks the related document's
  organisation and company against the event's; `check_bill_references`
  already requires a note to share the original's company and vendor.
- NI-2 adds the note entry's company check. No new table, no new RLS surface.

## 15. Audit and provenance

- Recorded at the note's approval: `provenance = 'recorded'`, actor = the
  approver, `cause_type = 'credit_note'`, `cause_id` = the note,
  `related_document_id` = the note; the evidence snapshot is the note's own
  verdict (`not_required`).
- 13B-4 backfill: every posted note becomes a `reconstructed` event
  (`backfill_source` = `bills.credit_note_against_bill_id` + the note entry;
  `source_record_ref` = note id + entry id), in note-date order between the
  original's recognition and its claim. No backfilled note can meet NI-4's
  refusal: no reversed/corrected/lapsed balance exists before 13B-6/8.
- The history can always answer: VAT originally held; claimed; reduced by
  which note, when; reversed; restored; remaining — each a separate event.

## 16. Open questions and approvals

**Owner — product / architecture (approve or amend):**

| # | Decision | Proposed |
|---|---|---|
| **O-1** | B-1 option (a): note events recorded for the settled cases only; interaction cases refused by name at the database (dormant until 13B-6/8), treatment still undecided | **APPROVED 2026-09-29** — strictly bounded: CN-1, CN-2, CN-3, CN-5, CN-6, defective/missing note evidence, debit-note timing and ITD Ex. 29 / 40(10) stay refused until their own gate |
| **O-2** | At a note's approval: refuse as over-credit when the note's VAT exceeds R(D) (CI-1, AUTH 54(1)); refuse as allocation-undecided in the NI-4, CN-7 and CN-8 cases; otherwise record from the single bucket — §10A | **PENDING.** Reason: the limit had no defined meaning in the multi-bucket states; §10A now defines it allocation-independently, and the owner decides on that definition. Behaviour change for claimed/blocked originals (closes D-1) |
| **O-3** | Debit notes are their own documents in the ledger; `increased_by_note` retired | **APPROVED 2026-09-29** — never modelled as credit-note events |
| **O-4** | Refuse a note dated before its original (closes D-6) | **APPROVED 2026-09-29** — a required guard for the credit-note writer; not built yet |
| **O-5** | Authorise the D-2 corrective patch (§16A) as a separate Phase 13B-1 correction BEFORE 13B-3 | **APPROVED 2026-09-29** — "13B-1a", **merged** (PR #184, `6279f192`; post-merge CI 5/5) |
| **O-6** | The all-zero document (notes consumed all held VAT): no `claimed` event; the cache labels it as today | **APPROVED 2026-09-29** |

**Accountant / tax advisor (one list):**

| # | Question |
|---|---|
| **Q-B1-1** (CN-1) | A credit note dated before the Art. 40(10) trigger: does it reduce the PAID or the UNPAID consideration? In Saudi Ledger a credit note is applied as a set-off against the bill (never a cash refund) — does that make it reduce the unpaid base? |
| **Q-B1-2** (CN-2/3/4) | A credit note after input VAT was partly or fully reversed under 40(10): which amount is reduced first — reversed-unpaid (no return effect, the GCC 47(1) level reading) or claimed (the delta reading, which can make the deduction negative)? How does a later restoration's ceiling change? After a FULL restoration, is the ordinary 40(6) treatment correct (both readings agree)? |
| **Q-B1-3** | A supplier credit note whose issue period's return is already filed (or whose month the business has closed): report the reduction where? |
| **Q-B1-4** (CN-5/6) | A credit note against VAT that was claimed and later corrected as non-deductible (Art. 50), or against held VAT that lapsed: confirm no return effect, and what the journal reduces (cost vs `VAT_ADJ_BLOCKED`). |
| **Q-B1-5** | May the customer ignore a defective supplier credit note (missing Art. 53/54 particulars), and what if the supplier never issues one after a price reduction? |
| **Q-B1-6** (D-4) | A debit note on a supply whose original VAT was blocked under Art. 50: is the extra VAT blocked too? |
| **Q-B1-7** | Is a debit-note increase bounded by Art. 49(8) from the original supply's year? |
| **Q-B1-8** | ITD v3 Example 29 (a pending dispute suspends the 40(10) reversal) goes beyond the IR — which does the product follow? |
| **Q-B1-9** (CN-7) | A supplier credit note against a final invoice that deducted an advance tax invoice, for more VAT than the final invoice itself claimed: does the excess reduce the advance's claimed VAT? |

## 16A. Live defects D-1…D-6 — triage (owner gate, 2026-09-29)

None is fixed in this batch. Search shapes are stated so each finding is reviewable.

| # | Defect | Classification | Disposition | Owner of the fix |
|---|---|---|---|---|
| **D-1** | Outside HELD, nothing caps a note's VAT (`credit_exceeds_bill` checks totals, at create only, posted notes only) | Product control gap that contradicts AUTH 54(1) (total note VAT ≤ invoice VAT) | **A 13B-3 PREREQUISITE.** Once the writer records the event in the note's approval transaction, CI-1 / bucket non-negativity would refuse an over-credit as a raw database error; the product must refuse first, in words, with O-2's rule 1. Its exact rule is O-2 — so O-2 is a prerequisite too. Existing data is audited before the 13B-4 backfill (a read-only query; the local acceptance database has one note, within bounds) | 13B-3, after O-2 |
| **D-2** | `BILLADV-` / `BILLADVCN-` entries escape the 13B-1 generic-reversal guard (`'BILLADV-…'` is not `LIKE 'BILL-%'`) | **A Phase 13B-1 scope defect**: A-5 covered bill and supplier-note entries; an advance invoice IS a bill and an advance credit note IS a supplier note — and both carry VAT claims | **A SEPARATE CORRECTIVE PATCH BEFORE 13B-3** (proposed "13B-1a", owner to authorise — O-5). Why not inside 13B-3: it is a live protection gap in merged code, independent of every open accounting question and of O-2, and small (extend `input_vat_journal_owner()` to the two prefixes, with the 13B-1 mutation-proof tests); bundling it would hold a live gap hostage to 13B-3's approvals and mix a correctness patch into a feature batch. Why not an untracked follow-up: that is the silent deferral the owner excluded. Search shape: every `entryNumber:` template built from a bill number in `apps/api/src` (non-test) — `BILL-`, `BILLCN-`, `VATEV-` (guarded), `BILL-…-PAY-` (a payment — outside A-5, CLAUDE.md §5 rank 2), `BILLADV-`, `BILLADVCN-` (unguarded: the only two) | 13B-1a — **O-5 APPROVED 2026-09-29; built on branch `fix/phase13b1a-advance-vat-reversal-guard` (migration 0108) — MERGED (PR #184, `6279f192`)** |
| **D-3** | A normal credit note against a capitalised bill credits PURCHASES and leaves the asset register untouched (the guard reads the NOTE's `capitalises_asset_id`) | Fixed-asset integration gap | **Kept behind G1.** The architecture has no safe treatment: an asset's cost is frozen and the cost-adjustment act is G1. Not implemented | G1 |
| **D-4** | A debit note ignores its original's state, so it can CLAIM VAT on a supply whose original VAT was Art. 50-blocked | Product/accounting control gap | Required invariant, conditional on Q-B1-6: *a debit note against an original whose VAT is BLOCKED takes the BLOCKED treatment* (if the advisor confirms). Not implemented | 13B-3 (debit-note recognition), after Q-B1-6 |
| **D-5** | Held credit notes appear in the held-for-evidence list | **CONFIRMED at runtime** (2026-09-29, a throwaway database, the product's own services): one held bill (VAT 150) + one credit note (VAT 15) → the list returns BOTH rows (`total = 2`) while held VAT correctly reads 135. Cause: a held note's row carries the original's `awaiting_evidence` state (a cache the return queries use to make notes follow their original), and `heldSql` has no `document_type` filter | **A server-side query defect rooted in that state-inheritance model** — not UI-only (the page renders the server's list), and not an expected consequence (a note needs no evidence of its own: its verdict is `not_required`). Not fixed | the ledger's cache work (13B-3) or a UI/query batch — owner to route |
| **D-6** | No check that a note is not dated before its original | Product control gap | **Rule: a credit note's issue date must not precede its original document's date** (a note corrects an invoice already issued, IR 54(4) — INT on the date consequence). Recorded as a **required guard for the credit-note writer**, and a 13B-3 prerequisite: the 0107 admission trigger already refuses such an event, so without the guard the note's approval would fail with a raw error. Not implemented | 13B-3 (O-4) |

## 17. Implementation boundary for 13B-3 — and what still blocks it

### 17.1 Exact prerequisites before 13B-3 may start

| # | Prerequisite | Status (2026-09-29) |
|---|---|---|
| P-1 | O-1 approved | ✅ APPROVED (strictly bounded) |
| P-2 | **O-2 decided** — the note limit, on §10A's allocation-independent definition | ✅ APPROVED (§19.8) |
| P-3 | **D-2 corrected** by a separate 13B-1a patch (O-5), merged before 13B-3 | ✅ merged (PR #184, `6279f192`) |
| P-4 | D-1's refusal specified by O-2 (ships in 13B-3 with the writer) | ✅ specified (O-2 rule 1) |
| P-5 | D-6's note-date guard approved (O-4) (ships in 13B-3 with the writer) | ✅ approved |
| P-6 | O-3 (debit notes as their own documents) and O-6 (the all-zero document) approved | ✅ approved |
| P-7 | A-B1-1…7 accepted as the 13B-3 migration's design (0107 is never edited) | ✅ (with O-2) |
| P-8 | D-4's rule: either Q-B1-6 answered, or the owner accepts that 13B-3 records debit notes with today's behaviour and D-4 stays an open, recorded deviation | ✅ D-4a APPROVED; D-4b deferred to G1 (§19.11) |

**13B-3 is UNBLOCKED (owner, 2026-09-29)** — to start after the D-4a
corrective patch (§19.12) is reviewed.

### 17.2 In 13B-3 (once 17.1 is met)

The event writer for `recognised_*`, `claimed`, `advance_deducted` and
**`reduced_by_note` for the settled cases only** (credit notes and advance
credit notes; states 1, 2, 4 of §10A), in the same transaction as each
posting; debit notes through the ordinary recognition path; the cache
funnelled through the writer; the cache-consistency trigger; a NEW migration
carrying A-B1-1…7 and CI-1; the over-credit refusal (O-2 rule 1, closes D-1),
the named allocation-undecided refusal (O-2 rule 2) and the note-date guard
(D-6).

**Not in 13B-3:** any treatment for CN-1…CN-8; `increased_by_note`;
40(10)/(11); Art. 50 corrections; lapses; the backfill (13B-4, which first
runs the D-1/D-6 data audit); supply date (13B-5); return changes (13D);
D-3 (G1); D-5 (unless the owner routes it here).

### 17.3 Still blocking 13B-6 / 13B-7 / 13B-8

| Batch | Blocked by |
|---|---|
| **13B-6** (Art. 40(10)) | **B-2**; Q-B1-1 (CN-1: a note before the trigger — paid vs unpaid base); Q-B1-2 (CN-2: a note after a reversal — allocation, level vs delta, the conflict with D13B-11's edge proposal); Q-B1-8 (ITD Ex. 29 vs the IR); Q-B1-9 (CN-7) where advances are involved |
| **13B-7** (Art. 40(11)) | 13B-6; Q-B1-2 (CN-3 after a partial restoration; CN-4 after a full one — candidate convergent, unconfirmed) |
| **13B-8** (Art. 50 correction; lapse) | Q-B1-4 (CN-5 corrected-blocked, CN-6 lapsed); **G2** (a lapse whose expiry period is closed); G1 for asset cost sides |
| any batch touching fixed-asset cost | **G1** (and D-3) |

## 18. Decision log and architecture amendments

| # | Entry | Kind |
|---|---|---|
| DL-1 | Settled note cases A, B, E, H, blocked and advance are recorded as events of the ORIGINAL document, referencing the note's own entry — live behaviour, no new treatment | design (awaits O-1) |
| DL-2 | Held-note net claim confirmed by guidance + regulation (ITD v3 §10.1; GCC 47(1); IR 49(7)) — strengthens X3, whose mechanics were engineering choices (discovery U2) | research |
| DL-3 | Conflict recorded: the level reading (GCC 47(1)) vs the D13B-11 edge proposal (already not approved) | conflict → Q-B1-2 |
| DL-4 | CN-4 is a candidate convergent case (both readings agree after full restoration) — NOT admitted: the history rule refuses it until the accountant confirms (Q-B1-2) | question |
| DL-5 | Debit notes are their own documents; `increased_by_note` retired | design (awaits O-3) |
| DL-6 | Live defects D-1…D-6 recorded, none fixed; triaged in §16A (D-2: a 13B-1 scope defect, corrective patch proposed before 13B-3; D-5 confirmed at runtime) | findings + triage |
| DL-7 | **Owner gate 2026-09-29:** O-1 APPROVED (strictly bounded); O-2 PENDING; B-1 OPEN | owner decision |
| DL-9 | **Owner gate 2026-09-29 (second):** O-3, O-4, O-5, O-6 APPROVED; O-2 still PENDING; B-1 still OPEN; 13B-1a authorised and built | owner decision |
| DL-8 | CI-1 (N(D) ≤ T(D)) defined as the allocation-independent limit; the CN-2/CN-3 allocation left explicitly UNRESOLVED; CN-7 and CN-8 added; the NI-4 guard made history-based so CN-4 is not admitted until confirmed | design (awaits O-2) |

**Architecture amendments designed (to be built by 13B-3's migration):**

| # | Amendment to the 13B-1 foundation |
|---|---|
| A-B1-1 | admit `reduced_by_note` from HELD, CLAIMED, BLOCKED (0107 lists them NOT admitted) |
| A-B1-2 | NI-4 guard (`input_vat_note_interaction_undecided`) |
| A-B1-3 | new journal role `note_entry` (NI-2); the role's uniqueness (NI-5) |
| A-B1-4 | amount mapping for note events (NI-3) |
| A-B1-5 | shape rule: `related_document_id` is a posted note against the document (NI-1), one event per note |
| A-B1-6 | cache mapping for the all-zero document (O-6) |
| A-B1-7 | `own_entry` and `input_vat_journal_owner()` extended to `BILLADV-` / `BILLADVCN-` (NI-7; D-2) |

**B-1 status (owner gate, 2026-09-29):** the accounting for every case the
product can produce today is settled and designed; **O-1 is APPROVED; O-2 is
PENDING, so B-1 remains OPEN.** The interaction cases stay under B-2 / G3.
**13B-3 is NOT unblocked** — §17.1 lists every prerequisite. 13B-6 onward stays
blocked as §17.3 states.


## 19. Final O-2 accounting decision gate (2026-09-29)

### 19.1 The second research pass — what it found

A second, targeted search (full notes: session research file `p13b2-pass2.md`)
covered the Arabic IR Arts. 40, 49, 53, 54, 63; VAT Law Art. 1; the Arabic GCC
Agreement Arts. 1, 27, 45, 47, 57; ITD v3 §10 in full (AR/EN) and ITD 2021;
the invoicing guideline v3 §7; the amendments, examination and simplified
filing guidelines; the ZATCA e-invoicing XML Implementation Standard v1.2,
both detailed e-invoicing guidelines, the 2023 e-invoicing Implementation
Resolution (Arabic and English); the contracting-sector VAT guideline; the
simplified debit/credit-note guide; the archived General Guide. Falsifiers
sought: any example combining a note with a 40(10)/40(11) event, blocked or
lapsed VAT, or an advance/final pair; any definition of unpaid consideration
net of notes; any rule on referencing a debit note or an advance invoice.
**None exists.** Three findings change the framing:

| # | Finding | Class | Source |
|---|---|---|---|
| F-1 | Art. 54(1) is a **trigger**, not a written cap: a note arises where the tax charged «في تلك الفاتورة الضريبية يتجاوز الضريبة المستحقة عن التوريد». "Σ note VAT ≤ the invoice's VAT" follows because the tax due cannot be negative — an inference from AUTH. It compares a per-INVOICE figure with a per-SUPPLY figure and never says how the excess splits when one supply spans several documents — the root of CN-7 and CN-8 | AUTH + INT | IR 54(1) (Arabic) |
| F-2 | Art. 40(6) corrects «ضريبة مدخلاته» — the tax the customer **bore** (the GCC Art. 1 definition, applied through VAT Law Art. 1(2)); 40(10)/(11) adjust «ضريبة المدخلات القابلة للخصم» — the **deductible** amount. This supports the level reading of CN-2, but no text puts the two paragraphs together | AUTH + INT | IR 40(6), 40(10)–(11); GCC Art. 1 |
| F-3 | **ZATCA's own texts conflict** on what a final invoice after an advance "charges": the XML standard §9.5 example carries the FULL supply VAT on the final invoice and deducts the advance from the amount payable; the contracting guideline §4 taxes the progress invoice «بعد خصم النسبة المحددة» (net). **Saudi Ledger follows the XML-standard (gross) representation** — a final bill's `vat_amount` is the full supply VAT; the prepaid VAT is checked against it and only the ENTRY nets (`supplierAdvanceInvoices.service.ts`, `preparePrepayments`) | GUID vs GUID; SL | XML standard §9.5; contracting guideline §4, Ex. 2 |

Also: one note may adjust several invoices, each referenced «بالإضافة إلى
المبلغ المعدل» (AUTH 54(4) «الفواتير»; GUID invoicing v3 §7.2.1; XML
standard BR-KSA-56); the form of the reference is delegated to ZATCA (54(4)
«وفقاً لما تحدده الهيئة»), whose Resolution field 13.1 refers to «الفاتورة
الصادرة عن التوريد المبدئي» — the invoice of the ORIGINAL supply (GUID).
Saudi Ledger lets a credit note reference exactly ONE document of type
`bill` (trigger `check_bill_references`, migration 0104) — never a debit
note, and (for an ordinary credit note) never an advance invoice.

### 19.2 CN-1 … CN-8 — final status

| # | Question | Status | Why (classification) |
|---|---|---|---|
| CN-1 | note before the 40(10) trigger — paid vs unpaid base | **UNRESOLVED** | SILENT. "Consideration" is the reduced consideration after a discount (AUTH 40(1)(ج)); ITD v3 §10.2 decouples the customer's adjustment from the supplier's bad-debt relief (GUID); GCC 27 / 47(1) treat price reduction and non-payment as separate causes, never ordered |
| CN-2 | note after a (partial) 40(10) reversal — which bucket first | **UNRESOLVED** | SILENT; F-2 supports the level reading (reduce the non-deducted part first) over a mechanical delta, but no text joins 40(6) and 40(10) — **the documented conflict with the D13B-11 edge proposal (not approved) stands** |
| CN-3 | note after a partial 40(11) restoration | **UNRESOLVED** | SILENT; follows CN-2 |
| CN-4 | note after a FULL restoration | **UNRESOLVED (candidate: ordinary 40(6))** | SILENT; after a full restoration the position cannot be told apart from one never reversed — INT only. Needs the accountant's confirmation; none has been given and none is assumed here |
| CN-5 | note on corrected-blocked VAT | **UNRESOLVED** (return treatment and journal) | SILENT; F-2: 40(6) reaches tax borne, while the return correction is tied to a prior deduction only by GCC 47(1) «التي خصمها» (AUTH) and guidance (GUID) |
| CN-6 | note on lapsed VAT | **UNRESOLVED** | as CN-5 |
| CN-7 | note on a final bill that deducted an advance, beyond the final bill's own claimed VAT | **UNRESOLVED** | SILENT, and **ZATCA's texts conflict (F-3)**. A note within the final bill's own bucket is attributed to it because it names it (AUTH 54(4)); the excess — whether it reaches the advance-invoiced VAT, and what it must reference — is open |
| CN-8 | note after debit notes on the same supply | **UNRESOLVED** | SILENT on whether the note must reference the debit note: GCC 57 + Resolution 13.1 favour the ORIGINAL invoice (reading a); GCC 57 also treats a note as a tax invoice in its own right (reading b). Saudi Ledger cannot reference a debit note at all (0104 trigger) — a product gap either way |

**Not one of CN-1…CN-8 is settled, and none is decided here.**

### 19.3 O-2 — the exact invariant (hard, database-level)

**CI-1 (conservative form).** For every original document *D*:

> **N(D) ≤ T(D)**, where **N(D)** = Σ `vat_amount` of every POSTED credit
> note (`credit_note` / `advance_credit_note`) whose
> `credit_note_against_bill_id` = *D*, and **T(D)** = *D*'s own
> `vat_amount` — the VAT stated on the document the note references.

- **Is it sufficient as the hard database invariant?** As a *ceiling*, yes:
  it can only ever refuse a note that exceeds the VAT stated on the invoice
  it names — which F-1 excludes under every reading, including the gross/net
  conflict of F-3 (a final bill's own `vat_amount` is the gross figure, the
  highest any reading allows). It decides no allocation. **It is not
  sufficient on its own for the writer**, which also needs the allocation
  rule below and the existing bucket non-negativity (CI-2).
- **Why T(D) is D's own VAT only** (not D plus its debit notes, nor the net
  final-invoice figure): it is the only figure every reading agrees is an
  upper bound for a note that references *D*. Whether a larger bound
  (CN-8, reading a) or a smaller one (CN-7, the net reading) applies is
  unresolved. The conservative form refuses nothing any reading would allow
  **except** a note that, under CN-8 reading (a), would reduce a debit
  note's VAT through the original — which Saudi Ledger cannot record today
  anyway (it cannot reference a debit note). That exception is named, not
  hidden.

### 19.4 The exact credit-note allocation rule for the 13B-3 writer

At a credit note's approval, in the same transaction as its event, in order:

1. **CI-1:** if `vat(n) > T(D) − N(D)` → refuse as **over-credit**
   (`credit_note_exceeds_invoice_vat`).
2. **History guard (NI-4):** if *D* has ever recorded a `reversed_unpaid`,
   `restored_on_payment`, `corrected_blocked` or `lapsed_*` event → refuse as
   **allocation undecided** (`input_vat_note_interaction_undecided`) —
   CN-1…CN-6 (unreachable before 13B-6 / 13B-8).
3. **Single-bucket rule:** exactly one of HELD / CLAIMED / BLOCKED is
   non-zero for *D* (or all are zero). If `vat(n)` ≤ that bucket → record
   `reduced_by_note` from it (settled: §6 A, B and the blocked row; live
   behaviour).
4. **Otherwise** (`vat(n)` fits under CI-1 but exceeds the single bucket —
   CN-7, and CN-8's variants) → refuse as **allocation undecided**
   (`input_vat_note_allocation_undecided`). The note is NOT called
   excessive.

No rule above picks a bucket order for a multi-bucket state, or a
cross-document allocation. Rules 1, 3 and the refusal in 4 are the only ones
that can fire at 13B-3.

**Consequence the owner must weigh before approving O-2:** rules 1 and 4 can
refuse a supplier credit note that posts today (rule 1: an over-credit, D-1 —
a note the regulation excludes anyway; rule 4: a note on a final bill
reaching into advance-invoiced VAT, or a note of the CN-8 shape). A refused
note cannot be recorded until its question is answered — Saudi Ledger has no
other path (an ordinary credit note cannot reference an advance invoice or a
debit note).

### 19.5 Owner decision table

| # | Decision | Status | Justification |
|---|---|---|---|
| **O-1** | Credit notes become events only for the settled cases | **APPROVED** (owner, 2026-09-29) | settled by AUTH/GUID + live behaviour (§6); boundary as recorded |
| **O-2** | §19.3 invariant + §19.4 rule | **APPROVED** (owner, 2026-09-29 — the final B-1 decision; recorded verbatim in §19.8) | Fully defined and choosing no accounting treatment: the ceiling is allocation-independent; the allocation is limited to the settled single-bucket case; every other case is refused by name. The owner accepted that rules 1 and 4 change live behaviour. CN-1…CN-8 stay open exactly as documented |
| **O-3** | Debit notes are their own documents | **APPROVED** (owner, 2026-09-29) | live behaviour; never modelled as credit-note events |
| **O-4** | A credit note's issue date must not precede its original's | **APPROVED** (owner, 2026-09-29) | a note corrects an issued invoice (IR 54(4)); a required guard for the writer |
| **O-5** | 13B-1a corrective patch for D-2 | **APPROVED — DONE** (PR #184 merged as `6279f192`; post-merge CI 5/5) | a 13B-1 scope defect, closed |
| **O-6** | All-zero document: no `claimed` event | **APPROVED** (owner, 2026-09-29) | an event moves a positive amount |

### 19.6 B-1 — status

**B-1 is OPEN. 13B-3 remains PROHIBITED.** Remaining prerequisites:

| # | Prerequisite | Status |
|---|---|---|
| P-2 | O-2 decided on §19.3 / §19.4 | ✅ APPROVED |
| P-3 | D-2 corrected (13B-1a) | ✅ merged |
| P-4 | D-1's refusal = O-2 rule 1 | ✅ (with O-2) |
| P-5 | D-6 date guard (O-4) | ✅ approved |
| P-6 | O-3, O-6 | ✅ approved |
| P-7 | A-B1-1…7 + CI-1 + the two named refusals as the 13B-3 migration design | ✅ (with O-2) |
| P-8 | D-4: Q-B1-6 answered, or the owner accepts D-4 as a recorded deviation in 13B-3 | ✅ D-4a APPROVED; D-4b deferred to G1 (§19.11) |

B-1 closes when P-2, P-4, P-7 and P-8 are met. **CN-1…CN-8 do not need to be
answered to close B-1** — the design refuses every one of them by name — but
they block 13B-6 / 13B-7 / 13B-8 (§17.3) and, for CN-7 / CN-8, decide whether
the rule-4 refusal can ever be lifted.

### 19.7 What must be asked (accountant / tax advisor) — no answer is assumed

| # | Exact question |
|---|---|
| **CN-1** | A supplier credit note dated BEFORE our Art. 40(10) trigger (the end of the 12 months after the month following supply): does it reduce the PAID or the UNPAID consideration when we compute the VAT to reverse? In our product a credit note is applied as a set-off against the bill, never refunded in cash. |
| **CN-2 / CN-3** | After we have reversed input VAT under Art. 40(10) — fully or partly, and possibly partly restored under 40(11) — a supplier credit note arrives. Which amount does it reduce first: the reversed-unpaid VAT (no return effect — the level reading, supported by 40(6) acting on tax borne and by GCC 47(1)) or the VAT still deducted (the delta reading)? How does the remaining restorable amount change? |
| **CN-4** | After a FULL 40(11) restoration, is a credit note treated exactly as on a document never reversed (reduced in the note's issue period)? |
| **CN-5 / CN-6** | A credit note against VAT that was claimed and later corrected as non-deductible (Art. 50), or held VAT that lapsed: confirm no return effect, and say what the journal reduces (the cost, or the `VAT Adjustment – Blocked (Art. 50)` account). |
| **CN-7** | A supplier's final invoice deducted our advance tax invoice. A credit note against the FINAL invoice carries more VAT than the final invoice itself claimed. Does the excess reduce the advance-invoiced VAT? Must the note reference the advance invoice too? (ZATCA's XML standard §9.5 and contracting guideline §4 disagree on whether a final invoice "charges" gross or net VAT.) |
| **CN-8** | After a debit note increased the VAT on a supply, a credit note reduces it: must the credit note reference the debit note (a tax invoice in its own right, GCC 57) or the original invoice (Resolution 13.1)? |
| Q-B1-3, Q-B1-5 … Q-B1-8 | unchanged (§16) |


### 19.8 O-2 — APPROVED (owner, 2026-09-29), as recorded

The owner approved O-2 with the exact invariant and rules of §19.3–§19.4:

1. **Hard invariant: N(D) ≤ T(D)** — N(D) = cumulative VAT of posted credit
   notes against the original document; T(D) = VAT charged on the original
   document (its own `vat_amount`, §19.3).
2. A credit note exceeding **T(D) − N(D)** is refused as **over-credit**.
3. **No bucket-priority allocation** is invented or imposed for unresolved
   multi-bucket cases.
4. A document that has recorded a reversal, restoration, correction or lapse:
   the note is refused as **allocation undecided**.
5. Exactly one of HELD / CLAIMED / BLOCKED non-zero and the note fits in it:
   the settled-case event may be recorded.
6. Within the cumulative ceiling but not safely allocable to the single
   applicable bucket: refused as **allocation undecided**, never as
   over-credit.
7. CN-1…CN-8 stay unresolved exactly as documented (§19.2, §19.7). No
   unresolved accounting question is reinterpreted.

### 19.9 D-4 decision gate — Q-B1-6 (a debit note against blocked VAT)

**Question.** A purchase's input VAT was blocked under IR Art. 50 (booked into
cost). The supplier issues a debit note increasing the consideration and VAT
on that supply. Is the extra VAT recoverable, or blocked?

**Evidence (full notes: session research file `p13b2-qb16.md`).**

| # | Point | Finding | Class | Source |
|---|---|---|---|---|
| E-1 | What Art. 50 attaches to | the **expenditure** — «النفقات المتعلقة بالسلع أو الخدمات التالية»; «لا يسمح له بخصم ضريبة المدخلات المتعلقة بتلك النفقات». Blocked "in all cases" because of "the nature of these expenditures" (guidance) | **AUTH** (+ GUID) | IR Art. 50(1) (Arabic, as amended 19/11/2024 — the live English copy predates the amendment); VAT Law Art. 22(2); GCC Agreement Art. 45(1) («لغير غايات النشاط الاقتصادي»); ITD v3 §7.2 |
| E-2 | Does a debit note belong to the same supply | yes — it must reference the original invoice | **AUTH** | IR 54(4); invoicing guideline (a note relates to a prior supply) — GUID |
| E-3 | Does 40(6) grant a deduction | no — it fixes the customer's correction's amount and **period** (the period the debit note is issued); deductibility remains Art. 49/50's | **AUTH** | IR 40(6) «في الفترة الضريبية التي أصدر فيها الإشعار الدائن أو المدين»; ITD v3 §10.1 (the adjustment follows the original deduction) — GUID |
| E-4 | Therefore: the debit note's extra VAT on an Art. 50 expenditure | **blocked — not recoverable input VAT** | **AUTH rule + one short interpretation step** (E-1 + E-2: the same expenditure); **no source states the debit-note case explicitly (SILENT as an example)** | — |
| E-5 | Accounting | blocked VAT is **cost** — it follows the net increase (P&L, inventory, or the asset); recognised in the period the obligation arises | **STD** (+ INT on timing) | IAS 2.11; IAS 16.16(a); IAS 38.27(a); IAS 8.36–37 by analogy; IAS 10.9(c) |
| E-6 | Variant: the original was a fixed asset capitalised at **0 % recovery** (Art. 51/52, not Art. 50) | "same asset, same intended use → same 0 %" | **INT only — SILENT** on this exact case | IR 52(3) («الاستخدام المقصود») |
| E-7 | Odoo 18.0 | a debit note copies the bill (`account_debit_note`, `debit_origin_id`); a non-deductible split follows only if the same tax is copied/chosen — nothing is inherited from the original | ODOO (precedent) | `account_debit_note`; `account_tax.py:2453` |
| E-8 | ERPNext v15 | no purchase-side debit-note flag; an upward note is a new Purchase Invoice; the only non-recoverable mechanism (tax category "Valuation") is not inherited | ERPNEXT (precedent) | `buying_controller.py:207-209` |
| E-9 | Saudi Ledger today | a debit note's treatment comes from ITS OWN expense account; the original's blocked state is ignored (`bills.approvable.ts:270` sets `isNote` for credit notes only; `inputVatTreatment` decides from the note's account). The link exists (`credit_note_against_bill_id` is required on a debit note, 0096 / 0104) but is not read | SL | — |

**What the evidence settles.** For an original whose VAT was blocked under
**Art. 50**, the debit note's additional VAT is **blocked** (not recoverable),
recognised in the debit note's issue period, and booked into the same cost as
the net increase. This rests on AUTH (Art. 50 attaches to the expenditure;
54(4) ties the note to that supply; 40(6) grants no deduction) plus one short
interpretive step; the precedents (E-7, E-8) inherit nothing and are no
authority either way.

**What the evidence does NOT settle.** The **0 %-recovery capitalised-asset**
variant (E-6) — interpretation only; it is also a fixed-asset cost change,
which is G1.

**Live consequence (recorded, not fixed).** E-9 contradicts E-4: a debit note
posted to an unblocked account against an Art. 50-blocked original **claims**
input VAT the regulation blocks — an over-claim that reaches the VAT return.
It exists today, independent of 13B.

**Proposed D-4 (for the owner):**

- **D-4a (Art. 50):** a debit note against an original whose VAT is BLOCKED
  under Art. 50 takes the **blocked** treatment — its VAT is cost, never
  VAT_INPUT and never the return; its event is `recognised_blocked` on the
  debit-note document (O-3). Basis: E-1…E-5.
- **D-4b (0 %-recovery capitalised original):** **UNRESOLVED** — routed with
  G1 (a debit note that changes an asset's cost); recorded as **D-7**: today
  a debit note against a 0 %-recovery capitalised bill is neither refused nor
  capitalised (the capitalised-bill guard applies to credit notes only).
  Advisor confirmation required (Q-B1-6b).
- **When:** the owner decides whether D-4a is corrected as its own patch
  before 13B-3 (it is a live over-claim) or inside 13B-3.

**Accountant / tax-advisor confirmation still useful (not blocking D-4a):**

| # | Exact question |
|---|---|
| Q-B1-6 | Confirm: a supplier debit note on a supply whose input VAT is blocked under Art. 50 carries VAT that is also blocked (Art. 50 attaches to the expenditure; the note references the same supply, IR 54(4)). |
| **Q-B1-6b** | A supplier debit note on a fixed asset whose VAT was capitalised at 0 % recovery: is the extra VAT also 0 % recoverable (IR 52(3) intended use), and added to the asset's cost? |

### 19.10 Gate after this decision

| Item | Status |
|---|---|
| **O-2** | **APPROVED** (§19.8) |
| **D-4** | **PENDING the owner** — D-4a is supported by AUTH + one short interpretive step and proposed for approval; D-4b is UNRESOLVED (G1 / Q-B1-6b) |
| **B-1** | **OPEN** — its last prerequisite P-8 is D-4. It closes when the owner approves D-4a and accepts D-4b as routed to G1 (a refusal or a recorded deviation, the owner's choice) |
| **13B-3** | **BLOCKED** until B-1 is CLOSED |


### 19.11 D-4 decided — B-1 CLOSED (owner, 2026-09-29)

| Item | Status |
|---|---|
| **D-4a** | **APPROVED.** A debit note against an Art. 50-blocked original inherits the blocked treatment: its VAT never posts to `VAT_INPUT`, never enters the VAT return as deductible input VAT, and is recorded (by the 13B-3 writer) as `recognised_blocked` on the debit note itself. Basis: AUTH (IR 50(1), 54(4), 40(6)) plus one short interpretive step — kept distinct (§19.9) |
| **D-4b** | **DEFERRED TO G1** — a debit note against a 0 %-recovery capitalised asset: unresolved; no asset-cost treatment is implemented or invented; an open G1 dependency (with D-3 and D-7) |
| **B-1** | **CLOSED** — every 13B-3 prerequisite (P-1…P-8) is met; D-4b does not block it |
| **13B-3** | **UNBLOCKED** — to start only after the D-4a corrective patch (§19.12) is reviewed |

### 19.12 D-4a corrective patch (branch `fix/d4a-debit-note-art50-blocked`; journal confirmed by the owner, 2026-09-29)

- **Server-side:** `vatEvidence.service.ts` reads a DEBIT note's original; when it
  is posted `not_deductible` on an expense (not capitalised), the verdict
  (`vatEvidence.ts`) is `not_deductible` with flag `art50_blocked_original`,
  whatever the note's own account or evidence. The existing gate trigger and
  the existing X5 posting do the rest. A capitalised original (D-4b) and an
  unposted original are deliberately NOT matched.
- **Journal — CONFIRMED by the owner (2026-09-29).** Where the Art.
  50-blocked original's VAT was NEVER deducted, the debit note uses the
  existing blocked-bill posting (X5):

  | Dr / Cr | Account | Amount |
  |---|---|---|
  | Dr | the relevant expense / cost | gross (net + VAT) |
  | Cr | Accounts Payable | gross |

  **No `VAT_INPUT` line; no deductible input-VAT movement on the return; no
  `VAT Adjustment – Blocked (Art. 50)` credit.** Claim-then-correct is NOT
  used for D-4a.
- **The distinction, recorded.** The entry **Dr cost / Cr `VAT Adjustment –
  Blocked (Art. 50)`** (M1b, D13B-12) is the **correction** of input VAT that
  was previously CLAIMED and must be reversed. It does not apply to a
  never-claimed Art. 50-blocked debit note: that note's VAT is owed to the
  supplier, so crediting the adjustment account would understate AP by the
  VAT and leave an unoffset credit in a contra account. (An earlier draft of
  this instruction proposed that entry for D-4a; the owner redirected it.)
- **What rests on what.** That the debit note's VAT is blocked rests on AUTH
  (IR 50(1), 54(4), 40(6)) plus one short interpretive step (§19.9). That it
  is booked into cost, gross, rests on STD (IAS 2.11, IAS 16.16(a)) and the
  settled X5 product treatment — a product/accounting decision, not a
  regulatory text. D-4b stays deferred to G1.

### 19.13 13B-3 built on this design (2026-09-29; uncommitted, awaiting the owner's review)

The settled cases are recorded as `reduced_by_note` events of the ORIGINAL,
referencing the note's own entry (A-B1-1…7); O-2 is ONE SQL function read by
the admission trigger and by the writer before a note posts; D-6 is refused in
both; debit notes are their own documents (O-3); O-6 writes no `claimed`
event. As-built record, including the decisions taken conservatively while
building (a credit note against an OPENING payable refused by name; the
held-only cap replaced by CI-1, which contains it):
[`phase-13b-vat-claim-ledger-architecture.md`](phase-13b-vat-claim-ledger-architecture.md) §26.
CN-1…CN-8 remain unresolved and refused by name.

### 19.14 Credit notes against OPENING (Batch 1C) payables — research gate (2026-09-29)

Owner instruction (2026-09-29): the 13B-3 refusal of a VAT-bearing credit
note against an opening payable must not be decided from the absence of a
ledger event. Research, in the mandatory order, with every finding classified:
[`opening-payable-credit-note-research-2026-09-29.md`](../history/opening-payable-credit-note-research-2026-09-29.md).

| Point | Finding | Class |
|---|---|---|
| Can a supplier note reference a pre-cut-over invoice? | Yes — the obligation, trigger and reference attach to the SUPPLIER's tax invoice, with no condition about the customer's bookkeeping system | AUTH (IR 54(1), 54(4), 40(2)) |
| Must the tenant reduce input VAT whatever system recorded the original? | 40(6) binds the customer in the note's issue period, with no system condition | AUTH (IR 40(6)) |
| Original deducted in full (in the previous system) | reduce input VAT by the note's VAT in the note's period — a return Saudi Ledger prepares | AUTH + GUID (ITD v3 §10.1 Ex. 28; INV v3 §7.1.1) |
| Original never deducted | no return adjustment (a later claim is the net — INT) | GUID + AUTH (GCC 47(1) «التي خصمها») |
| Original blocked (Art. 50) | no return adjustment; the note's VAT reduces cost | INT consistent with AUTH/GUID; STD |
| Original reversed under 40(10) in the old system; partly deducted | not addressed | SILENT (= CN-2 / level vs delta) |
| Pre-2018 supply | the note carries no VAT | GUID (transitional-provisions guideline §4.2, Ex. 4) |
| 5 % supply before 1 July 2020 | note at 5 % | SEC only — primary 2020 text not found |
| Cap | the invoice's HISTORICAL VAT, not the opening row's 0 | AUTH trigger + INT |
| The opening nature itself | changes nothing (IAS 8: a current-period event; IAS 2.11 / 16.16(a)) | STD / INT |
| Odoo; ERPNext | a standalone refund with its own tax / a return inheriting the opening invoice's no-tax default; neither knows the original's deduction | ODOO / ERPNEXT (precedent only) |
| Saudi Ledger before 13B-3 | silently treated the original as CLAIMED (Cr VAT_INPUT), no VAT cap | SL |

**Conclusion.** Authority SETTLES that neither permanent refusal (wrong for a
deducted original — the tenant's return would overstate recoverable VAT) nor
the old silent "claimed" default (wrong for a never-deducted or blocked
original) is correct: the treatment follows the ORIGINAL's historical VAT
position. Authority does NOT settle how the product learns that position or
what evidence suffices — the ledger does not hold it (staging's
`historicalVat` records rate, amount and period, not whether it was
deducted). **Nothing is implemented; the refusal stays as the interim
behaviour.**

**For the accountant** (research file §3, each yes/no or a choice): Q-OP-1
deducted → reduce in the note's period; Q-OP-2 never deducted → no
adjustment, later claim net; Q-OP-3 blocked → no adjustment, cost reduced;
Q-OP-4 reversed under 40(10) in the old system → which treatment; Q-OP-5
**is the user's recorded statement of the original's treatment sufficient
evidence, or what must support it**; Q-OP-6 5 % / pre-2018 rates; Q-OP-7
partial deduction; Q-OP-8 pre-registration purchases.

**For the owner** (research file §4): keep the refusal vs a controlled
treatment once Q-OP-1 and Q-OP-5 are answered (or now for the settled cases
only); capture the historical VAT position at migration, per note, or both;
refuse when unstated; cap at the historical VAT; the adjacent risk that a
user enters the supplier's note with VAT 0 to get past the refusal (it posts,
silently omitting a required reduction for a deducted original); the refusal
wording (it currently says to record the note outside the system).
