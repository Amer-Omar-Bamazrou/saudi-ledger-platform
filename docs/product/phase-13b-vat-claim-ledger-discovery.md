# Phase 13B — VAT claim ledger: discovery and decision pack

**Status (2026-09-28): DISCOVERY ONLY — nothing designed here is built. No
code, schema, migration, VAT-return or accounting behaviour was changed.
Accepted by the owner as the research baseline; a SECOND verification pass
(§28) re-examined K2, K3, partial claims, notes on partly claimed VAT,
pre-filing invoices and return placement, and supersedes the first pass where
they differ. **Accountant and tax-advisor answers received 2026-09-28 are
recorded as ADVICE in §29, verified in §30 (the advisers' first SAR 5,000 is the
superseded Art. 63(3) figure — the current rule is SAR 15,000, since confirmed
by the accountant); the final clarifications (M1–M3, M+12) are in §31; the
FINAL decision matrix is §32; the BUILD GATE is §33 — status: READY FOR
ARCHITECTURE, NOT READY TO IMPLEMENT (one accounting item open, M1b).**
Current state authority: [CLAUDE.md §2](../../CLAUDE.md).**

Base: `main` @ `e6999148` (Phase 13A + 13C live; DEF-1 fixed). Research order
per the owner's rule (2026-09-28): ZATCA/Saudi → SOCPA/IFRS → Odoo → ERPNext →
Saudi Ledger. Classification of every conclusion:

**A** Authoritative Saudi/ZATCA requirement · **B** Accounting standard/practice ·
**C** Odoo implementation precedent · **D** ERPNext implementation precedent ·
**E** Saudi Ledger product/architecture decision (proposed unless marked LIVE) ·
**F** Accountant (or tax-advisor) decision required. Also used: **SILENT** (no
source addresses it) and **INTERPRETATION** (reasoned from a source, not stated
by it).

Full research reports with verbatim quotes, URLs, file paths and line numbers
(scratchpad, not committed): `research-13b/{saudi,ifrs,odoo,erpnext}.md`.

---

## READ FIRST

### R1. Unrecorded decisions already in production

The accountant's answers (received 2026-09-26) are **not recorded verbatim
anywhere in the repository**. What exists:
[`phase-13-expenses-accountant-questions.md` §Answers](phase-13-expenses-accountant-questions.md)
is a *paraphrase table*; the only record closer to the source is the owner's
relayed bullet summary (chat, 2026-09-25), itself not in the repo. The
accountant's own wording survives in one fragment only: "debit VAT payable,
credit the VAT asset".

| # | Decision | Live since | Where it is recorded | Verbatim accountant text? |
|---|---|---|---|---|
| U1 | **X1 holding account** — held VAT posts to `VAT_AWAITING_EVIDENCE` (asset); evidence entry is **Dr `VAT_INPUT` / Cr `VAT_AWAITING_EVIDENCE`** | 0106, PR #180 | Paraphrase: questions doc §Answers; pack §9.1. The **Dr `VAT_INPUT`** reading is an **owner** decision (2026-09-27), made because the accountant's "debit VAT payable" would debit `VAT_OUTPUT` (a liability) | ❌ only the "debit VAT payable…" fragment |
| U2 | **X3 held-VAT credit notes** — a note on held VAT credits the holding account (naming the original's supplier), reduces the original's `input_vat_pending`, is refused above the held amount, and follows the original into its claim period | 0106, PR #180 | Paraphrase ("Account for the net; claim only the net VAT"). The mechanics (holding-account credit, over-held refusal, follow-into-claim-period) are **engineering** choices never put to the accountant | ❌ |
| U3 | **X5 blocked VAT into cost** — Art. 50 VAT posts into the expense line; nothing held or claimed | PR #180 | Paraphrase ("Excluded from input VAT; capitalised into cost — expenses, inventory and fixed assets alike") | ❌ |
| U4 | SAR 1,000 simplified-invoice limit measured on the **VAT-inclusive total** | PR #180 | Pack §9.5, recorded as a conservative product interpretation; accountant did not confirm | n/a (E, not an accountant answer) |

**Recommendation (E):** obtain the accountant's written answers and store them
verbatim beside the paraphrase before 13B builds on U1–U3 (§26 F1).

### R2. CONFLICTS between the research and live code

None of these is designed around below; each needs a decision before or during
13B.

| # | Live behaviour | What the source says | Class | Severity |
|---|---|---|---|---|
| **K1** | The 49(8) window is computed from `bills.date` — the **supplier's invoice date** (`withinClaimWindow`, `vatEvidence.ts:118`; trigger `bills_vat_evidence_gate`, 0106). Bills store **no supply date**. | 49(8) runs from «السنة التقويمية التي وقع فيها التوريد» — the calendar year of the **supply**, not the invoice or receipt date (AR-IR 49(8), printed p. 43). The supply date is set by GCC Art. 23(2) (English only). | A vs LIVE | Medium: diverges only when supply year ≠ invoice year |
| **K2** | The window ends **31/12/(Y+5)** (`year(claim) − year(date) ≤ 5`). | **Second pass (§28.1): CONFLICT, unresolved.** Y+5 is supported by the unofficial English IR and by every ZATCA paraphrase 2020/2021/2026 in both languages; Y+4 only by drafting contrast — 49(8) is the ONLY time limit in the Arabic IR that says «من السنة» and not «من نهاية السنة». No official example computes a 49(8) deadline. A second route (late claim treated as a 63(2) correction) is barred by 63(4) at 31/12/(Y+5). | A (conflicting readings) → **F-A1/F-A2** — **closed by ADV-4 (31/12/(Y+5)), §30** | Closed: live end point kept (D13B-03); K1 still open |
| **K3** | A claimed input VAT can never change state again (trigger admits only `awaiting_evidence → claimed`). No purchase-side payment ageing. | **AR-IR 40(10) (amended 19/11/2024) is MANDATORY** («أن يعدل»): a taxable person who deducted input tax on a supply received and has not paid in full «بعد فترة اثني عشر شهراً من الشهر التالي للشهر الذي تم فيه التوريد» adjusts by the tax on the consideration unpaid at that date, in the return «الخاص بالشهر الذي انتهت فيه مدة الاثني عشر شهراً». Long credit terms are caught (archived Arabic ITD v2 §10.2). Exception (2024): goods under licensed financing contracts, all four conditions incl. the supplier's written certificate. 40(11): restoration is **optional** («يجوز») and **proportional** to the consideration paid, in the payment period or any later one. The month count is ambiguous (§28.2). | A vs LIVE (missing event) | **High** — a statutory reversal the product cannot express |
| **K4** | No path to correct a wrong past claim. | AR-IR 63 (all ¶ amended 2024): 63(1) over-claim → notify within 20 days by correcting the filed return; 63(2) under-claim by error → deductible in any later return; 63(3) understatement < SAR 15,000 → in the return of the discovery period; 63(4) 5-year bar from the end of the period's calendar year; 63(5) per-period detail + reason. | A vs LIVE (missing path) | Medium (manual today) |
| **K5** | Claim history lives in **mutable columns** on `bills` (`input_vat_state/pending/claimed_on/claim_entry_id`, overwritten), reconstructable only from `audit_logs` JSON + journal entries. | Commercial Books Implementing Regulations Art. 6 (Arabic, mc.gov.sa): an error «يتم تصحيح هذا الخطأ بقيد آخرٍ في تاريخ اكتشافه» — corrected by another entry at the date of discovery; books free of erasure. AR-IR 66(3)(ج)–(و): documented processing + reviewable tamper controls. | A (books) — LIVE GL complies (entries are new rows); the **claim record** does not | Medium — the reason 13B exists |
| **K6** | The return's input VAT is read from **document columns** (`vat_amount` filtered by `input_vat_claimed_on`, `reports.repository.ts:479+`), not from the `VATEV-`/`BILL-` entries; the invariant sweep checks the holding account vs documents only (`vat_awaiting_evidence_gl_vs_bills`), **not `VAT_INPUT` vs the return**. | AR-IR 62(2)(ب) (per-period deducted input tax), 66(3) (records support the return). | E (internal consistency) | Medium |
| **K7** | `bills_vat_evidence_gate` guards the **state** against the **stored verdict** but not the verdict column or posted figures (acceptance OBS-2: a direct two-step DB write forged a claim; not app-reachable). | 66(3)(و) tamper controls; Commercial Books IR Art. 3 (computerised books: tamper prevention). | A/E | Low (defence in depth) |

### R3. Open defects on `main` (rule 5)

The 2026-09-28 acceptance findings were **not fixed**: after acceptance only
DEF-1 (`65b7735b`) and PR #180 merged (`git log --since=2026-09-28 main`).
None is recorded in `known-issues-and-audit-findings.md` yet.

| # | Defect | Severity |
|---|---|---|
| DEF-2 | A posted supplier credit note on held VAT is listed on `/vat-evidence` as its own held document ("Held SAR 0.00", "Supply evidence"); counts inflated (Documents held, Posted — VAT held) | Medium |
| DEF-3 | Review page for a PDF with nothing read claims "recognised from the image" / "Source photograph stored" | Low |
| DEF-4 | `PATCH /api/bills/:id` with only non-settable fields → HTTP 500 ("No values to set") | Low (pre-existing) |
| UI-3 | Phone: `/upload` auto-categorise switch and "Excel Template" pushed off-screen (EN) — unreachable | Low |
| UI-6 | Phone: `/scan-review` "Discard photograph" pushed off-screen (AR + EN) — unreachable | Low |
| UI-1/2/4/5, OBS-1 | RTL select direction in dialogs; RTL date padding; credit-note dialog keeps stale values; Expenses list English account names in Arabic; raw "HTTP 422 …" toast prefix | Low |

DEF-2 and UI-4 touch 13B's surface (held-VAT credit notes) — 13B's history
view would supersede DEF-2's list shape; they should be fixed or explicitly
folded into 13B.

### R4. Reused, not re-researched

Cited as settled (Phase 13 research report 2026-09-24 and
[`phase-13-expenses-decision-pack.md`](phase-13-expenses-decision-pack.md)):
IR 49(7) (deduct only while holding evidence) and 49(8) (later period, five-year
bar); ZATCA *Input Tax Deduction* guideline (2020 edition, archived) §9.1 and
**Example 26** (late invoice → claimed in the next return, no amendment) — the
guideline now has a live 3rd version (May 2026, §28.0) whose example numbering
was not re-mapped to the 2020 citations; GCC
Agreement 44(2); IR 40(6) (note corrects input tax in the note's period); IR
53(1)(c), 53(8), 53(11) (simplified invoice evidence; SAR 1,000); current Art. 50
(19/11/2024); Art. 63(3) SAR 15,000; X1 analysis (IAS 8.10–11, IAS 37.31–33,
IFRIC Jan 2019); IAS 2.11 / 16.16(a) / 38.27(a).

**Researched here because the above leaves them open:** partial deductions;
the supply date and exact end of the 49(8) window; what happens at expiry; Art.
63 corrections in full (amended text); credit notes on partly/never-deducted
VAT; **Art. 40(10)–(11) non-payment reversal**; filed-return finality and
assessment limits; record retention and form (Art. 66, Commercial Books Law);
evidence-date rules; IFRS on write-off at expiry, error correction, partial
recovery, offsetting; Odoo and ERPNext ledger/period/reversal patterns.

**Source note (P13-N3 applies):** the Arabic IR read is the 2025 edition
incorporating Res. 01-06-24 of 19/11/2024 (zatca.gov.sa PDF, read from page
images; the earlier text extraction was unusable — it had lost its Arabic
glyphs). In the FIRST pass the GCC Agreement and VAT Law were read **in English
only** (marked "EN only" in §3); the SECOND pass read the Arabic VAT Law
(ZATCA compiled, Jan 2025) and the Arabic Agreement (2016 text) for the
provisions it relies on (§28.0). The live English IR on zatca.gov.sa is still
the pre-amendment 8th edition (09/11/2021) and was not relied on.

---

## 1. Executive summary

- **What 13B is for.** Today a purchase document carries ONE mutable claim
  state. The law requires more events than that state can express: late claims
  (49(8)), note corrections in the note's period (40(6)), a **mandatory
  non-payment reversal and its restoration (40(10)–(11))**, error corrections on
  their own clock (63), and loss of the right at expiry (49(8)). The books law
  requires corrections as new entries at discovery (Commercial Books IR Art. 6).
  13B replaces "a state on the document" with **an append-only event ledger per
  purchase document**, from which state, balances and the return's input-VAT
  figure are derived.
- **Recommended model (E):** event-sourced, document-anchored (§17): every event
  names its document, its tax-effective date, its amount (signed), its
  evidence/cause, its journal entry and its actor; nothing is updated or
  deleted; current state is a projection; `bills.input_vat_*` becomes a
  verified cache.
- **Precedent:** Odoo's cash-basis mechanism (tax waits in a transition
  account; a dated event row moves it with a new linked entry; undo = reversal
  entry) is the closest analogue to what 13A already does (C). ERPNext's
  immutable-mode Payment Ledger (balances = sums of append-only rows; reversals
  dated in the open period) is the closest ledger pattern (D). **Neither
  records "claimed in return period P" or "on which evidence"** — 13B must add
  both.
- **Conflicts with live code: K1–K7** (R2). K2 and K3 are the serious ones.
- **Open questions (final, after the second pass):** four for the accountant
  (F-B0–F-B3), ten for the tax advisor (F-A1–F-A10), six owner decisions
  (E1–E6) — none that an authoritative source answers (§26). K2's end point,
  the late-claim route, advance timing, pre-filing invoices and the 40(10)
  month count remain CONFLICTS between official sources, recorded without
  choosing (§28).

## 2. Current implementation (LIVE on `main` @ `e6999148`)

**Tables/columns (0105, 0106).**
- `bills` (bills, supplier credit notes, supplier advance invoices share it):
  `supplier_document_kind` (tax_invoice | simplified_tax_invoice |
  no_tax_invoice), `vat_evidence_status` (not_evaluated | not_required |
  evidenced | awaiting_evidence | not_deductible), `vat_evidence_basis`
  (qr_signature_verified | qr_unsigned | document_attached | attested),
  `vat_evidence_flags` (jsonb), `vat_evidence_checked_at`;
  `input_vat_state` (claimed | awaiting_evidence | not_deductible | NULL =
  posted outside approval), `input_vat_pending` numeric, `input_vat_claimed_on`
  (YYYY-MM-DD), `input_vat_claim_entry_id`; expense columns
  (`recorded_as_expense`, `expense_paid_from_bank_account_id`,
  `expense_paid_at`). CHECKs: `bills_input_vat_state_chk`,
  `bills_input_vat_pending_chk` (pending > 0 only when held),
  `bills_input_vat_claimed_on_chk` (claimed ⇔ date).
- `captured_documents`: sha256, source, field_sources, extraction, qr_payload,
  signature_status, `review_corrections`, `bill_id`, status (staged →
  promotion_pending → promoted), `captured_at`.
- System account `VAT_AWAITING_EVIDENCE` ("Input VAT awaiting evidence", asset,
  current) seeded for every org (0106).
- **No** supply-date column; **no** table of filed returns; **no** purchase-side
  payment-age tracking for 40(10).

**Trigger** `bills_vat_evidence_gate` (0106): at approval ties the posted
`input_vat_state` to the verdict (claimed ← evidenced/not_required; held ←
awaiting_evidence/not_required; not_deductible ← not_deductible/not_required);
after posting admits only **held → claimed**, with verdict evidenced (or a note
following its original), pending = 0, claim date ≥ `date` and
`year(claim) − year(date) ≤ 5`. Does not guard INSERTed posted rows, the
verdict column, or figures (K7).

**Entries.**
| Event | Entry | Writer |
|---|---|---|
| Evidenced bill approved | `BILL-…` Dr expense / **Dr VAT_INPUT** / Cr AP, on `bills.date` | `bills.approvable.ts` (`inputVatTreatment`) |
| Held bill approved | `BILL-…` Dr expense / **Dr VAT_AWAITING_EVIDENCE** (vendor party) / Cr AP | same |
| Art. 50 bill approved | `BILL-…` Dr expense **gross** / Cr AP (no VAT line) | same |
| 0 %-recovery fixed asset | VAT capitalised in asset cost (no VAT line) | `capitalisation.service` |
| Evidence supplied later | `VATEV-…` **Dr VAT_INPUT / Cr VAT_AWAITING_EVIDENCE** (pending), dated the evidence day (≤ today, ≥ `date`, ≥ latest held-note date, within K1/K2 window; period must be open via `postJournalEntry` → `checkPeriodOpen`) | `vatEvidenceService.claimHeldVat` |
| Note on claimed VAT | `BILLCN-…` Cr VAT_INPUT on the note's date (Art. 40(6), B7) | `bills.approvable.ts` |
| Note on held VAT | `BILLCN-…` Cr VAT_AWAITING_EVIDENCE (original's supplier); original `input_vat_pending −= vat` (in place); refused above held (`credit_note_exceeds_held_vat`) | same |
| Supplier advance tax invoice (Z-AP1) | Dr VAT_INPUT / Cr Supplier advances on its date; final bill claims only the non-prepaid VAT; advance credit note Cr VAT_INPUT | `supplierAdvanceInvoices.service.ts:334/360` |
| Expense (13C) | the bill entry above + `BILL-…-PAY-n` Dr AP / Cr bank, one transaction (`payBill`) | `bills.approvable.ts` |

**Return.** `reports.repository.ts` `billsClaimedInRange` /
`billLinesClaimedInRange` / `billPrepaymentsClaimedInRange` select documents by
`coalesce(input_vat_claimed_on, date)` where `coalesce(input_vat_state,'claimed')
= 'claimed'`; the purchase **base** still comes from the document-date set (pack
§9.4) → a held purchase's base and its VAT fall in different periods (P13-N1
open). Input VAT = document `vat_amount` by claim date (K6).

**Audit.** `auditService.record('input_vat_claimed', before/after JSON)` on the
claim; create/approve rows on documents. **Invariants:**
`vat_awaiting_evidence_gl_vs_bills` (holding GL by vendor = Σ pending),
`advance_invoice_vat_overused`.

**Period locks.** Company-scoped; every entry through `postJournalEntry` is
refused (423) in a closed month; a correction posts in the open period
(CLAUDE.md §4). The evidence date cannot be re-dated into a closed month —
the user must choose an open date.

**What 13B must add:** an append-only event ledger; the 40(10)/(11) reversal and
restoration; Art. 63 corrections; expiry/write-off; the supply date (K1); a
derived return figure checked against the GL; a history view.

## 3. Regulatory research (A unless marked)

| # | Question | Answer | Source |
|---|---|---|---|
| Q1 | When is input VAT deductible? | The right arises when the tax is due (GCC 44(2), EN only); it may be **exercised** only while holding the evidence (IR 49(7); ITD guideline §9.1 "cannot be exercised until…"). | R4 |
| Q2 | Evidence required | Tax invoice per Art. 53, or a correctly issued simplified invoice (<SAR 1,000 to a business, 53(1)(c)); since 04/12/2021 an electronically generated e-invoice (EIG §7.1); ZATCA discretion 49(7)(c) not automated. | R4 |
| Q3 | Controlling date | **Supply date** anchors eligibility and the 49(8) clock (AR 49(8); GCC 23(2) defines supply date, EN only). **Holding the evidence** conditions exercise (49(7)). The **return period** is the one in which the deduction is taken — the supply period or any later one within 49(8). The **invoice date** and **accounting posting date** have no statutory role in the claim period (INTERPRETATION). The **evidence-received date** is not named by any text (SILENT). | AR-IR 49(7)(8) |
| Q4 | Representation of VAT awaiting evidence | Saudi law is silent on booking (SILENT); only "not deducted" matters. | R4 |
| Q5 | Evidence after the purchase period | A current-period 49(8) deduction in a later return, not an Art. 63 correction (Example 26). | R4 |
| Q6 | Five-year rule — exact scope | AR 49(8): «ولا يجوز خصم ضريبة المدخلات في أي فترة تقع بعد خمس سنوات من السنة التقويمية التي وقع فيها التوريد». **Start: the supply's calendar year** (A) — "date of supply" is defined only in the Arabic GCC Agreement 23(2), separate from the tax point 23(1); IR Art. 20 merges them only for continuous supplies, utilities, government contracts and deemed supplies. An invoice dated or received in a later year does not move the clock (A). **End: CONFLICT** Y+5 vs Y+4 (§28.1). **Advance payments: CONFLICT** — Agreement 23 / IR 79(1) keep the supply date separate (clock from delivery year) vs the Arabic Tax Invoicing guideline (May 2026): «يعتبر التوريد أنه حدث في تاريخ الدفعة المستلمة» (clock from the advance's year). | §28.1 |
| Q7a | Credit note, VAT not yet claimed | IR silent; ZATCA guidance attaches the correction duty to a prior deduction (Invoicing & Records §7.1.1; ITD §10.1) → no return entry; any later claim is on the revised consideration (INTERPRETATION). | saudi.md Q5 |
| Q7b | VAT already claimed | Corrected in the period the note is issued (IR 40(6)). | R4 |
| Q7c | Partly claimed | **SILENT** as to the amount (the period is settled: the note's period, 40(6)). «تعكس قيمة الضريبة المحسوبة عند التغيير» reads either as the recalculated level or as the delta; all guidance assumes a full prior deduction; Art. 54 is silent on the customer side. The Arabic Agreement 47(1) compares tax deducted with tax «المتاح له خصمها» (available to deduct) — on that basis a note that leaves available ≥ deducted reverses nothing and only lowers the unclaimed remainder (INTERPRETATION). | §28.4 |
| Q8 | Partial claims | **SILENT** (second pass confirmed): 49(8) says «ضريبة المدخلات» with no quantifier; ZATCA's "partial deduction" means Art. 51 apportionment; Art. 52 is a statutory re-measurement; 15(8) concerns extent, not timing; the return reports only totals (62(2)(ب)). The only per-invoice split across periods ZATCA shows is **forced by payment** (40(10)/(11); ITD guideline v3 May 2026 Example 31: re-deduct 3,750 of 7,500 in the payment period "or later periods") — not a voluntary split. | §28.3 |
| Q9 | Reversals | Statutory reversals post in the current period by design: 40(4)–(6), **40(10)** (mandatory non-payment reversal of the tax on the UNPAID consideration only), 51(7), 52(5). 40(11): restoration **optional** («يجوز») and **proportional** («تعكس الضريبة المحسوبة على المقابل الذي قد تم سداده»), in the payment period or any later one; 40(12): subject to the Law/IR time limits (whether that means 49(8) is INTERPRETATION). Month count ambiguous (§28.2). Imports/reverse charge: SILENT. Whether "unpaid" includes the VAT itself: SILENT. | §28.2 |
| Q10 | Evidence never arrives | No deduction; nothing to report (49(7)). | R4 |
| Q11 | At the five-year expiry | The right is **lost** (49(8) is a prohibition, «لا يجوز»). Art. 69 refunds do not cover it. 64(10) (new 2024) lets ZATCA examine beyond the limitation period with consent — not a claim route; whether it could revive a deduction is SILENT. | saudi.md Q3 |
| Q12 | Period locks / filed returns | A return is a self-assessment (62(1)); a filed period changes only by an Art. 63 correction, a ZATCA assessment, or current-period statutory adjustments. No text declares a filed period final (SILENT). Assessment limits: 64(3) 5 years from the end of the calendar year; 64(4) 20 years (intent/non-registration); 69(7) (new) ZATCA may examine any period with a refund request within one year. | saudi.md Q6 |
| Q13 | Audit/provenance to retain | AR 66(1): invoices, records, accounting documents **≥ 6 years from the end of the tax period**; capital assets: adjustment period + 5 years (11 movable / 15 immovable); real estate 15 years (GCC 59, EN only). 66(2) Arabic; 66(3) in the Kingdom (or accessible from it); originals; documented processing; reviewable tamper controls; 66(3)(ح) e-invoices in the prescribed format (XML or PDF/A-3 with XML). Commercial Books Law Art. 8: **≥ 10 years**; IR Art. 6: no erasure, corrections by a new entry at discovery; IR Art. 3: computerised books with tamper controls and re-extractable outputs. | saudi.md Q7; ifrs.md Q6 |
| Q14 | Immutable events | Follows from Commercial Books IR Art. 6 + AR 66(3): recorded entries are corrected by new entries, never erased (A → E for the event ledger). | as Q13 |
| Q15 | A past claim found wrong | Art. 63 (all ¶ amended 2024) — see K4. Penalty: VAT Law Art. 42(1) 50 % of the difference (EN only); 42(2) waiver possible. | saudi.md Q4 |
| Q16 | Distinctions | **Late claim**: a first deduction in a later period (49(8)); not an error. **Credit-note reduction**: a change in consideration, corrected in the note's period (40(6)). **Statutory reversal**: 40(10) (non-payment), restored by 40(11); 51(7), 52(5). **Correction of a claim**: an Art. 63 error correction with its own clocks (20 days for over-claims; 5 years from year-end for under-claims) and 63(5) detail. **Accounting error**: IAS 8 (B, §4) — independent of the tax correction. | synthesis |
| — | Evidence date | 49(7) / Agreement 48(1) («حائزاً»): the right is exercised while possessing the evidence; no text ties deduction to the receipt date (SILENT). An invoice received after period end but **before filing**: law SILENT; **guidance CONFLICT across languages** (§28.5) → **F-A4**. Claiming in a later period is permitted by every source (A). | §28.5 |
| — | Purchaser records ZATCA expects | No prescribed input-VAT ledger format (SILENT). Required: per-period totals of deducted input tax, Art. 51/52 adjustments and corrections shown separately (62(2)(ب),(ط),(ي)); per-correction detail (63(5)); evidence per claim; records producible on request (64(6),(8)); ZATCA's expected-documents list (Invoicing & Records §8.2, guidance). | saudi.md Q9 |

## 4. Accounting research (B unless marked)

- **Holding asset while evidence is outstanding** — defensible reading (a) of
  the prior research; applied (U1). Moving it to the VAT receivable on evidence
  is **asset → asset, no P&L** (CF 4.68–4.69), except reversing a prior
  write-down, which is income (IAS 8.36).
- **Irrecoverable held VAT** (never evidenced / window lapsed): no standard fits
  cleanly (IAS 36 is for non-monetary assets; IFRS 9 excluded, the right is
  statutory — IAS 32 AG12). Model: **derecognition** when it no longer meets the
  asset definition (CF 5.26, 5.28(a)); write down when recovery is no longer
  reasonably expected (CF 6.7(c); IFRS 9 5.4.4 by analogy); a **change in
  estimate**, prospective (IAS 8.34, 8.36–37, 8.48); IAS 10.9(b) adjusting
  event. **Where the loss goes: SILENT** — to the related asset/inventory cost if
  still held (by analogy IAS 2.11, 16.16(a), 38.27(a), IAS 8.37, IFRIC 1.5),
  otherwise P&L; expensing everything (IAS 1.88) also defensible → **F**.
- **Wrong past claim** — IAS 8.42/8.46: material prior-period error restated
  retrospectively; immaterial may be corrected currently (IAS 8.8, 8.41; IAS
  1.7); a claim reasonable at the time is not an error (IAS 8.5). **The tax
  correction (Art. 63) and the financial-statement correction are separate**
  (IAS 8.41 governs statements only) — INTERPRETATION. Neither erases entries.
- **Credit note on held VAT** — price reduction lowers cost (IAS 2.11, 16.16(a),
  38.27(a)); the tax on the reduction: SILENT; reducing the holding asset is
  INTERPRETATION (and LIVE, U2).
- **Partial recovery** — SILENT for VAT; the Framework supports splitting (CF
  4.48 unit of account; CF 5.26 "all or part"; CF 5.28(b); IFRS 9 5.4.4
  "a portion").
- **Offsetting** — IAS 1.32 forbids offsetting unless an IFRS permits; by
  analogy (IAS 12.71–72, IAS 32.42) recoverable input VAT may be shown net of
  the same period's output VAT; **held VAT is shown gross** (no enforceable
  right yet) — INTERPRETATION. Presentation only; not GL keeping. (IFRS 18
  replaces IAS 1 from 2027; the paragraph mapping was not verified.)
- **Record keeping** — IFRS/SOCPA prescribe none (SILENT); the Commercial Books
  Law governs (§3 Q13).

## 5. Odoo findings (C — `odoo/odoo` 18.0 @ `935210ad`; prior `2802e2b7`)

| Pattern | Where | Verdict |
|---|---|---|
| Tax lines carry `tax_repartition_line_id` / `tax_line_id`, `tax_base_amount`, `tax_tag_ids` (signed return boxes); the report sums journal lines by tag over the line date | `account_move_line.py:192-241`; `account_report.py:545-570, 823-846` | PATTERN (amount → rule → box); ANTI-PATTERN: no "claimed in period P" |
| **Cash basis**: tax waits in a **transition account** with no report tags; a reconciliation (`account.partial.reconcile`) creates a **new posted entry** dated `max(settlement, lock+1)`, linked to the event (`tax_cash_basis_rec_id`) and origin (`tax_cash_basis_origin_move_id`), moving `partial/total` of the tax; rounding true-up on full payment; undo = reversal entry; these entries cannot be reset to draft | `account_tax.py:4699-4708, 2427, 2499`; `account_partial_reconcile.py:100-135, 509-670`; `account_move.py:5681-5687` | **Strongest PATTERN** — the shape 13A already has; 13B adds the event row and evidence link |
| **Tax lock date**: late entries touching tax are **re-dated to the first open period** (`_get_accounting_date`, "register the invoice at the last date of the first open period"); invoice date kept separately; posted tax fields frozen in closed tax periods (`_check_tax_lock_date`) | `account_move.py:5235-5239, 6016-6064`; `account_move_line.py:1382-1399` | PATTERN (invoice date ≠ accounting date); DIFFERENCE: we refuse, not re-date; ANTI-PATTERN: soft locks can be lowered; date decided in two places |
| Reversal = new move with `reversed_entry_id`; original untouched | `account_move.py:5030-5073` | PATTERN |
| Posted entries can be reset to draft unless hashed/locked | `account_move.py:5605-5690` | ANTI-PATTERN |
| Opt-in SHA-256 hash chain per sequence; **tax fields not hashed** | `account_move.py:4251-4284` | ANTI-PATTERN (partial coverage) |
| No `account.return` / closing entry in Community (searched `account\.return|tax_closing|account_tax_return` — only `use_in_tax_closing` hooks) | — | Gap |
| Audit trail: one-way switch; posted entries undeletable; chatter tracked | `company.py:310-315`; `account_move.py:3567-3576`; `mail_message.py:148-170` | PATTERN idea; off by default |

## 6. ERPNext findings (D — `frappe/erpnext` version-15 @ `4aee12e1`; `frappe/frappe` @ `8f801ade`)

| Pattern | Where | Verdict |
|---|---|---|
| Purchase tax GL on the invoice posting date; no claim record, period or evidence; reports derive input tax either from GL accounts or from the tax child table | `purchase_invoice.py:1499-1525`; `uae_vat_201.py:202-279`; `vat_audit_report.py:113-128` | DIFFERENCE; two derivations = drift risk |
| `account_head` editable after submit → **repost** rebuilds the invoice's GL at its original date | `purchase_invoice.py:874-885` | ANTI-PATTERN |
| **Payment Ledger Entry**: signed `amount`, `against_voucher`, `delinked`, `voucher_detail_no`; **outstanding derived** by summing live rows, cached on the invoice | `utils.py:1818-1923, 2050-2200, 1949` | **Strongest PATTERN** (derived balance, cached projection) |
| Cancellation, immutable mode (`enable_immutable_ledger`): originals untouched, live mirror dated today in the open period | `general_ledger.py:703-709, 773-775`; `utils.py:1935-1940, 2513` | PATTERN (off by default) |
| Cancellation, default mode: flags flipped on originals, mirror dated at the original date, both hidden | `general_ledger.py:738-771`; `utils.py:2003` | ANTI-PATTERN |
| Repost Accounting/Payment Ledger delete and regenerate | `repost_accounting_ledger.py:289-345`; `repost_payment_ledger.py:16-20` | ANTI-PATTERN |
| Accounting Period (per company, per document type) blocks saving and GL writing — **blocked, never moved**; frozen-upto with role override; Period Closing Voucher hard block | `accounting_period.py:107-145`; `general_ledger.py:144-171, 783-840` | PATTERN (refuse, don't re-date) |
| Debit notes: returnable quantity derived from submitted returns; original rows untouched | `sales_and_purchase_return.py:295-330` | PATTERN (bound by sum over submitted rows) |
| Deferred expense: later GL pairs per source line (`voucher_detail_no`), amount-already-moved = Σ GL rows | `deferred_revenue.py:272-525` | PATTERN; ANTI-PATTERN: silently moves into next open month (`:369-371`) |
| `reversal_of` one-way link; reversing a reversal refused | `journal_entry.py:1921-1945` | PATTERN |
| `Tax Withheld Vouchers`: which earlier vouchers a later deduction covered | TDS | PATTERN ("this event covers these rows") |
| Draft → submitted → cancelled; submitted undeletable; amendment = new doc (`amended_from`) | frappe `document.py:880-918`, `delete_doc.py:263-273` | PATTERN; cancelled docs deletable (anti) |

Nothing in ERPNext models evidence, claimable-vs-claimed, or a return-period
column.

## 7. Proposed domain model (E, proposed)

**Unit of account:** the input VAT of **one purchase document** (bill, expense,
supplier advance tax invoice), with supplier credit/debit notes linked to their
original. (Line-level tax categories are 13D/N5; 13B stays document-level, with
a nullable `bill_item_id` reserved.)

**Aggregate:** `input_vat_ledger` — the document's append-only event stream.
Derived projections (never stored as truth):

- `vat_total` — the document's VAT (from the document, signed by type).
- `held` — Σ held − Σ released from held (claimed, reduced, written off).
- `claimed_net` — Σ claimed − Σ reductions/reversals of claimed + Σ restored.
- `claimed_in(period)` — Σ claim-affecting events whose `tax_date` falls in the
  period (the return's input-VAT figure, K6).
- `state` — held | claimed | partially claimed (if ever allowed) | not
  deductible | expired — equal to today's `bills.input_vat_state`, which becomes
  a **cache verified by an invariant** (ERPNext PLE pattern, D).

## 8. Proposed event model (E, names provisional)

| Event | Meaning | Amount | Entry | Authority |
|---|---|---|---|---|
| `recognised` | Document posted; VAT identified with its disposition (claim / hold / block / capitalise) | VAT | the document's own entry | 49(7), 50, 52 |
| `held` | VAT awaiting evidence | + held | Dr VAT_AWAITING_EVIDENCE (in the document entry) | 49(7); U1 |
| `claimed` | Deduction taken — at posting (evidenced) or later on evidence | + claimed | at posting: in the document entry; later: `VATEV` Dr VAT_INPUT / Cr holding | 49(7), 49(8), Ex. 26 |
| `reduced_by_note` | Supplier credit note reduces the VAT (on held: reduces held; on claimed: reduces claimed in the note's period) | − | the note's entry | 40(6); U2 |
| `increased_by_note` | Supplier debit note | + | the note's entry | 40(6) |
| `blocked` | Art. 50 / 51(2) non-deductible → cost | 0 claimable | in the document entry | 50, 51 |
| `reversed_unpaid` | **Mandatory** 40(10) reversal: unpaid 12 months after the month following the supply month | − claimed (unpaid share) | new entry, current period; account **F** | 40(10) |
| `restored_on_payment` | 40(11) restoration on later payment | + | new entry | 40(11) |
| `correction` | Art. 63 correction of a wrong claim (over/under), with path 63(1)/(2)/(3), affected period, reason | ± | new entry dated the discovery date | 63; Books IR Art. 6 |
| `written_off` | Held VAT judged irrecoverable before expiry (policy) | − held | new entry; destination **F** | CF 5.26; F |
| `expired` | 49(8) window closed with VAT still held | − held | new entry; destination **F** | 49(8) |
| `advance_deducted` | A final bill deducts VAT already claimed on a supplier advance invoice (Z-AP1) | − (on the final bill's claim) | existing Z-AP1 netting | 53(1)(a)(2); Z-AP1 |

Every event row: `id`, `organization_id`, `company_id`, `document_id`,
`related_document_id` (note → original), `type`, `amount` (numeric(15,2),
signed), `tax_date` (the date it belongs to a return period), `recorded_at`,
`journal_entry_id`, `evidence` (capture id, document kind, basis, verdict +
flags **snapshot**), `cause` (e.g. payment id for 40(11); correction reference),
`reason` (required for corrections/write-offs), `actor_user_id`,
`idempotency_key`, `supersedes_event_id` (for corrections only, one-way).

## 9. State transitions (E)

```
            ┌────────── reduced_by_note ─────────┐
recognised ─┼─ held ──── claimed (on evidence) ──┼── reversed_unpaid ⇄ restored_on_payment
            │    └── written_off / expired        │
            ├─ claimed (at posting) ──────────────┤── correction (± , Art. 63)
            └─ blocked (Art. 50) / capitalised (0 % FA)
```
Allowed from **held**: claimed, reduced_by_note, written_off, expired.
From **claimed**: reduced_by_note, increased_by_note, reversed_unpaid,
correction. From **reversed_unpaid**: restored_on_payment. **blocked** is
terminal except by `correction` (e.g. wrong expense account) — F confirms. No
event ever edits another; a correction references the event it corrects.

## 10. Date semantics

| Date | Source | Role |
|---|---|---|
| Supply date | **new** field, defaulting to the invoice date, overridable (K1) | Starts the 49(8) clock (A); drives the 40(10) 12-month count (A) |
| Invoice (issue) date | `bills.date` | Evidence content (53); the document's posting date |
| Evidence-received date | `captured_at` / user-stated | Earliest date a later claim may be dated; SILENT in law; recorded for audit |
| Accounting/posting date | journal entry date | Must be in an open period |
| Claim date (`tax_date` of `claimed`) | posting date (evidenced at posting) or evidence date | Decides the return period (A: 49(8)) |
| VAT return period | derived from `tax_date` and the company's filing frequency | Owned by 13D (N1) |
| Discovery date | user-stated on `correction` | Dates the correcting entry (Books IR Art. 6); 63(3) period |

## 11. Partial claims

Law: SILENT, confirmed on the second pass (§28.3) — no text reaches a voluntary
split, and the only split ZATCA illustrates is the payment-forced one of
40(10)/(11) (ITD v3 Example 31). Framework allows splitting a unit (B).
Recommendation (E): **the ledger supports multiple `claimed` events per
document (it must — 40(11) restorations are proportional and may come in
several payments); the product forbids VOLUNTARY splits** of held VAT (a held
amount is claimed whole), because forbidding is safe under silence and allowing
relies on it. Advisor question F-A7.

## 12. Credit notes

- On claimed VAT: `reduced_by_note` in the note's period, Cr VAT_INPUT (A,
  40(6); LIVE).
- On held VAT: reduces held, no return effect; later claim is the net (U2,
  LIVE; guidance-consistent).
- On **partly claimed** VAT (possible once 40(10)/(11) or partial claims
  exist): the **period** is the note's (A, 40(6)); the **allocation is SILENT**
  (§28.4). The Arabic Agreement 47(1) ("deducted vs available to deduct")
  supports reducing the **unclaimed part first**, reversing claimed VAT only
  when the reduced available amount falls below what was deducted
  (INTERPRETATION) — the same net effect as Odoo's refund against a partly
  exigible bill (C, §28.6). Proposed (E) pending advisor F-A8.
- On blocked VAT: reduces cost (U3, LIVE).
- Over-reduction is refused (LIVE for held; to be generalised: Σ reductions ≤
  VAT, D pattern "bound by sum over submitted rows").

## 13. Late claims

A `claimed` event on a held document, dated in an **open** period, on or after
the supply date and after the evidence is held, within the 49(8) window (K1/K2
fixed to the supply date and the settled end point). Classified as a 49(8)
current-period deduction per ITD Example 26 (2020 edition) — **but the Nov-2024
examination guideline Example 9 treats unclaimed input tax as a 63(2)
correction** (Box 14 < SAR 15,000, else the Adjustment columns), with its own
63(4) bar. Which route governs is a **CONFLICT** (§28.7) → F-A2. The ledger
records the fact (`claimed`, late, reason "evidence received") either way;
the route and the box are 13D's once F-A2 is answered.

## 14. Five-year expiry

At the window end, remaining held VAT can no longer be deducted (A). Proposed
(E): an `expired` event is **proposed by the system** (a findings-style list of
documents approaching expiry from the start of the final year — the Saudi
research suggests a warning from Y+4) and **posted by a human** (AI proposes,
never posts). Entry destination: **F-B1**. The trigger's hard stop must use the
settled end point (K2).

## 15. Reversals

Two different things, kept apart:
- **Statutory reversal** (40(10)) — **mandatory**, for the tax on the
  consideration still unpaid at the trigger date, in the return for the month
  in which the 12 months end (A); the month count is ambiguous (§28.2, F-A5).
  Restoration (40(11)) is **optional and proportional** to what is later paid,
  possibly across several payments (A) — so restoration is a human act the
  product PROPOSES, never posts on its own (E, consistent with "AI proposes").
  Requires purchase-side payment ageing (`billPosition` + `bill_payments`) and
  the financing-contract exception (goods only; four conditions incl. the
  supplier's written certificate) (A). Book entry: **F-B2**. Return box:
  SILENT (§28.7, F-A6).
- **Accounting reversal** (undoing a wrongly posted document/entry) — a new
  mirror entry in the open period (CLAUDE.md §4; C/D reversal patterns); the
  ledger records a `correction` linked to the reversed event. The generic
  journal "reverse" accepting document-owned entries is already open (CLAUDE.md
  §5 rank 2) and must be closed for VAT-bearing entries before 13B relies on
  entries as the ledger's money trail.

## 16. Corrections

`correction` event, dated the **discovery date** (Books IR Art. 6, A), with
63(5) detail (period(s) corrected, input tax corrected per period, reason) and
the path (63(1) over-claim: correcting the filed return within 20 days; 63(2)
under-claim: any later return within 63(4); 63(3) understatement < SAR 15,000:
discovery-period return). The ledger records the fact and the path; **which
return figure/box it lands in is 13D**. The financial-statement treatment (IAS
8) is separate (B).

## 17. Ledger shape — document, event or state?

**Recommendation (E): event-based, document-anchored, with a verified state
cache.** State alone (today) cannot express 40(10)/(11), 63, expiry or partial
amounts, and loses history (K5). Pure document-based cannot answer "when was it
claimed". Events answer all nine questions in the brief; the document anchor
keeps every event findable from the supplier's document; the cached state keeps
13A/13C's readers working unchanged.

## 18. Period locks

Every event with a journal entry is dated in an **open** period; a closed
period is **refused with the next step named, never silently re-dated** (D
pattern; Odoo's re-dating is the C contrast). Filed returns: no record exists
today → 13D should record a filed-return snapshot; until then the period lock
is the only freeze (E). Events without an entry (e.g. `recognised` annotations)
carry `tax_date` and obey the same rule.

## 19. Audit/provenance (retain permanently)

Per event: actor, recorded_at, tax_date, amount, type, document and related
document, journal entry, evidence snapshot (capture id + sha256, document kind,
basis, verdict and flags **as decided at that moment**), cause, reason,
supersedes link. Retention: **permanent, no delete** — the simplest design
satisfying AR 66 (6/11/15 years), Books Law Art. 8 (10 years), 63(4) and 64(4)
(20 years). Arabic presentation of the history (66(2)) and in-Kingdom access
(66(3)) are deployment concerns (C6).

## 20. Idempotency

- Machine events (posting, note posting, 40(10) proposal): unique
  `(document_id, type, cause)`.
- Human events (claim, correction, write-off, expiry): an `idempotency_key` per
  request; the document row lock (LIVE pattern in `claimHeldVat`) serialises
  events on one document.
- A retried request returns the original event, never a second one.

## 21. Security/integrity controls

- **Append-only at the database**: triggers refusing UPDATE/DELETE; REVOKE on
  the app role (owner-only pattern, CLAUDE.md §4); RLS `tenant_isolation`;
  `organization_id` NOT NULL; company predicate.
- **Sum constraints** checked at the write boundary: held ≥ 0; Σ claimed ≤
  vat_total; Σ reductions ≤ vat_total; restore ≤ reversed.
- **Invariant sweep** (new): per document, events ⇄ GL (`VAT_INPUT`,
  `VAT_AWAITING_EVIDENCE`) ⇄ cached `bills.input_vat_*`; per period, return
  input VAT = Σ events (closes K6).
- **Verdict/figure guard** (K7): the gate trigger also refuses changes to
  `vat_evidence_status` and VAT figures on posted rows except through the
  evidence path.
- One writer per effect: the event ledger is written only by the existing
  posting paths plus the new explicit acts; no second path to `VAT_INPUT`.

## 22. Migration considerations

- **Backfill** events from live rows, marked `source='backfill'`: claimed at
  posting (bills, expenses, advance invoices), held + later `VATEV` claims,
  held/claimed notes, blocked, 0 %-FA capitalised, NULL-state opening items
  (claimed on their date, flagged).
- **Reconcile before cut-over**: backfilled events must reproduce, per document,
  the GL `VAT_INPUT`/holding lines and the current return figures exactly; any
  difference stops the migration (no rewriting to make it pass).
- Existing `bills.input_vat_*` columns stay as the cache (no reader breaks); the
  trigger evolves to check the cache against the events.
- Supply date (K1): new column defaulting to `date` for existing rows, marked
  "defaulted".
- `seed_org_chart_of_accounts()` redefinition only if 13B adds system accounts
  (CLAUDE.md §4 rule) — e.g. a 40(10) account if F-B2 requires one.

## 23. Future VAT-return integration boundary

13B **provides**: `claimed_in(period)` per company (and per document for drill
-down), the late-claim flag, 40(10)/(11) adjustments, and Art. 63 corrections
with their paths — each classified. 13B does **not** decide box numbers,
columns (Amount/Adjustment/VAT) or layout — that is 13D/P13-N1. What official
sources DO establish (second pass, §28.7), for 13D to consume: Art. 63(1) by
electronic amendment of the original return (portal "amend return", Arabic
user guide Aug 2023); 63(2) in any later return — Box 14 under SAR 15,000,
otherwise the Adjustment columns of the matching boxes (examination guideline
Nov 2024 §5.1.1; amendments guideline Example 26); 63(3) Box 14 of the
discovery period's return (amendments guideline Example 25). **Not
established:** the late-claim box (CONFLICT), the 40(10)/40(11) box (SILENT),
Art. 50 reporting (open since P13-N1).

## 24. Test strategy

- Real rows through the product paths (standing rule 2): each event type,
  each transition, each refusal.
- **Reconstruction test**: replay events → equals cached state, GL and return
  figure, for every document in the fixture.
- **Append-only**: direct UPDATE/DELETE refused as the app role and the owner
  role (planted positive).
- **Mutation runs**: remove each guard (sum constraint, window, trigger, lock
  check) and watch its test fail.
- Date-edge tables: supply-year boundaries for K2 both readings; 40(10) month
  counting under both Reading A and Reading B (ZATCA Example 19 = B), until
  F-A5 is answered; quarterly filers with quarter-end supply months.
- Backfill test on a copy of a populated database: reconcile to the cent.
- Invariant sweep with planted divergences.

## 25. Browser acceptance strategy

By clicking (P5), EN/AR, desktop and phone (real phone viewport, not a frame):
the document's **VAT history timeline** (each event, its evidence, its entry,
its period); supply evidence late; credit note on held; closed-period refusal
naming the next step; 40(10) proposal list and a human posting it; expiry
list; correction with reason; accessibility of every control at 390 px (the
UI-3/UI-6 class). Real-size evidence files (≥ 1 MB; DEF-1 lesson).

## 26. Final question list — only what no authoritative source answers

> **Answered 2026-09-28** (§29): F-A1–F-A10 and F-B1–F-B3. Verification in
> §30; the follow-up clarifications (M1–M3, M+12) are §31; what remains open
> is in the build gate, §33 (M1b; M4 deferred to 13D; owner items; F-B0). The table
> below is kept as the record of what was asked.

Revised after the second pass (§28). **Removed as answered by authority:**
supply year vs invoice date (supply year, A); an invoice received later is
claimable in any later period and does not move the deadline (A); 40(10) is
mandatory and reverses only the unpaid share (A); 40(11) is optional and
proportional (A); the credit-note correction period (the note's, 40(6), A);
Art. 63 placement (63(1) amend the return; 63(2) later return — Box 14 < SAR
15,000 else Adjustment columns; 63(3) Box 14 of the discovery period, A);
pass-1's "Example 19 translation discrepancy" (both language versions say
September 2026 — the open point is the regulation's count, F-A5).

### Tax advisor (F-A) — legal readings the texts leave open

| # | Question | Why no source settles it | Blocks |
|---|---|---|---|
| F-A1 | IR 49(8) end point: may input tax on a supply made in year Y be deducted in periods up to 31/12/(Y+5), or only up to 31/12/(Y+4)? | CONFLICT: ZATCA's paraphrases (2020/2021/2026, both languages) and the unofficial English say "not exceeding 5 years after the year" (→ Y+5); the Arabic 49(8) alone among the IR's time limits omits «نهاية» (→ Y+4 possible). No official example computes it. | K2 hard stop |
| F-A2 | Is a claim made late because the evidence was not held (ITD Example 26, 2020) a 49(8) current-period deduction (the later period's purchases, Box 7) — or a 63(2) correction (Box 14 < SAR 15,000, else the Adjustment columns; bar 63(4)), as the Nov-2024 examination guideline Example 9 treats unclaimed input tax? Does the answer differ between "evidence not held" and "missed by error"? | CONFLICT between two official ZATCA guides; the Dec-2024 simplified filing guide (p. 6) points to the purchases entries without naming a column. | late-claim event classification; 13D box |
| F-A3 | For an advance payment taxed before the supply (Agreement 23(1)), does the 49(8) clock start in the year of the advance or of the actual supply? | CONFLICT: Agreement 23(2) / IR 79(1) keep "date of supply" separate from the tax point; the Arabic Tax Invoicing guideline (May 2026) says the supply is treated as occurring on the payment date to the extent paid. | K1 for Z-AP1 advance invoices |
| F-A4 | May an invoice for a supply in period P, received after P ends but before P's return is filed, be claimed in P's return? | Law SILENT (Agreement 48(1) "possessing"); the May-2026 Tax Invoicing guideline differs by language (Arabic: issued in the period of deduction and held → yes; English: "available during the relevant tax period" → no); the Arabic ITD example says only «تعدّت فترة الإقرار». | the earliest permitted claim date |
| F-A5 | IR 40(10) count: for a supply in month M, does the adjustment belong to the return for month M+12 (Reading A: 12 months starting with the following month) or M+13 (Reading B: 12 months counted from the following month, ZATCA Example 19's answer)? And is Example 19's attribution of the adjustment to Company B (the supplier) a drafting error? | The Arabic text supports both counts; ZATCA's English explanation implies A while its result (both languages) is B; the example names the wrong party. Differs for every monthly filer and for quarterly filers when M is a quarter-end month. | 40(10) trigger date |
| F-A6 | On the official return, where do a 40(10) reversal and a 40(11) restoration go (Box 7 Adjustment column?) | SILENT: no official source names a box; nearest analogues (Adjustment column "for a change in circumstances"; non-deductible input tax in Box 7 Adjustment, Dec-2024 guide) are analogy only. | 13D |
| F-A7 | May one invoice's input VAT be deducted voluntarily in parts across periods (within 49(8))? | SILENT: no quantifier in 49(8); ZATCA illustrates only the payment-forced split of 40(10)/(11). | whether the product ever allows voluntary splits |
| F-A8 | A supplier credit note against a partly deducted invoice (e.g. VAT 150, 100 deducted, note −30): is the reduction taken first from the undeducted part (nothing reversed while deducted ≤ available — Agreement 47(1) reading) or from the deducted part? | SILENT: 40(6) settles only the period; guidance assumes full prior deduction; Art. 54 is silent on the customer. | note allocation rule |
| F-A9 | Is a 40(11) restoration bounded by the 49(8) five-year bar (via 40(12))? Does 40(10) apply to reverse-charge / imported supplies? | 40(12) refers only generally to "time limits in the Law and IR"; 40(10) is silent on reverse charge. | restoration window; scope |
| F-A10 | The Dec-2024 simplified filing guide (p. 9) appears to state 63(1) and 63(2) the other way round from the amended IR. Confirm the IR governs. | CONFLICT guidance vs regulation (reported, not resolved). | correction UX copy |

### Accountant (F-B) — book treatment only

| # | Question | Why |
|---|---|---|
| F-B0 | Please provide your X1, X3 and X5 answers in writing, to be stored verbatim (R1). | Provenance of decisions already in production |
| F-B1 | Held VAT that will not be recovered (no evidence, or the 49(8) window closed): (a) expense in profit or loss, or (b) the cost of the related inventory/fixed asset if still held, else profit or loss? Recognised when recovery stops being reasonably expected, or only at legal expiry? | IFRS: derecognition/change in estimate (B); destination SILENT |
| F-B2 | The mandatory 40(10) reversal of deducted VAT on the unpaid consideration: Dr (a) "Input VAT awaiting evidence", (b) a separate "Input VAT reversed — unpaid" asset, or (c) expense — / Cr Input VAT? And the optional, proportional 40(11) restoration on payment: the mirror entry? | Law says the tax effect, not the booking |
| F-B3 | A document claimed as deductible and later found to be Art. 50 blocked (wrong expense account): does the correction move the VAT into that expense's cost, dated the discovery date? | Books IR Art. 6 fixes the DATE (discovery, A); the account is the accountant's |

### Owner (E) — product/architecture decisions

| # | Decision | Options |
|---|---|---|
| E1 | Interim K2 behaviour until F-A1 | keep Y+5 (matches ZATCA's own paraphrases, live) with a warning during year Y+5; or hard-stop at Y+4 (safe under both readings, but refuses claims ZATCA's guidance allows) |
| E2 | Supply date on purchase documents (K1) | new field defaulting to the invoice date, editable, marked "defaulted" |
| E3 | 40(10) (K3) | build the reversal/restoration events in 13B, or record K3 as a blocking known issue and build later |
| E4 | DEF-2 / UI-4 | fix now, or fold into 13B's history view |
| E5 | Voluntary partial claims | forbid until F-A7 (recommended) |
| E6 | 40(11) restoration | proposed by the system, posted by a human (recommended; the right is optional) |

## 27. Explicit non-goals

Not in 13B: the official VAT return layout or box numbering (13D, P13-N1);
capitalised-VAT recovery (pack §9.6); changes to the SAR 1,000 rule; redesign
of 13A evidence handling or 13C expenses; pricing; inventory/Phase 14;
employee reimbursement; server-side/AI extraction; ZATCA submission of
purchase data (none exists); editing the accounting escalation protocol.

## 28. Second verification pass (2026-09-28)

Scope: K2, K3, partial claims, notes on partly claimed VAT, pre-filing
invoices, return placement — nothing else was reopened. Full reports:
`research-13b/pass2-deadline-partial.md`, `pass2-40-10-return.md`,
`pass2-odoo-erpnext.md` (scratchpad; downloaded PDFs in `research-13b/p2/`).

### 28.0 New or re-read sources (all official unless marked)

| Source | Version / date | Access |
|---|---|---|
| Implementing Regulations, **Arabic**, incl. Res. 01-06-24 (19/11/2024) | 2025 edition | zatca.gov.sa (live; page images) |
| Implementing Regulations, Arabic, **pre-amendment** | 2022 (printed p. 26) | zatca.gov.sa `VAT%20Implementing%20Regulations_AR_6.pdf` |
| Implementing Regulations, **English** | 8th edition 09/11/2021 — **still the live English file; pre-amendment** (English readers get the old 40(10)/(11)) | zatca.gov.sa |
| **Input Tax Deduction guideline, 3rd version** (AR + EN; Arabic prevails) | May 2026 | live: `/ar/HelpCenter/guidelines/Documents/Guideline-on-Input-Tax-Deduction-under-VAT-Provisions.pdf` (same under `/en/`) |
| Input Tax Deduction guideline, Arabic 2nd version | Nov 2021 | Internet Archive (live 404) |
| **Tax Invoicing and Records guideline, 3rd version** (AR + EN; Arabic prevails) | May 2026 | live |
| Amendments-to-the-IR guideline, **Arabic** edition (and English) | created 23/04/2025 | live `/ar/…/Amendments-to-the-Implementing-Regulation-of-(VAT).PDF` |
| Examination, Assessment, Correction and Objection guideline (Arabic) | Nov 2024 (pre-dates the amendment in force) | Internet Archive (live 404) |
| Simplified VAT filing guide (Arabic) | Dec 2024 | live |
| "Amend VAT return" e-service user guide (Arabic) | Aug 2023 | live |
| VAT Law, **Arabic** (ZATCA compiled) | Jan 2025 | zatca.gov.sa |
| GCC Unified VAT Agreement, **Arabic** | 2016 text | UAE FTA site (ZATCA's Arabic URL serves the English "Unofficial Translation"; pass 1's "Arabic" copy was English) |
| GCC Agreement amendment, Royal Decree M/280 | published 05/06/2026 | **primary text not read**; secondary reports say Arts. 12, 13, 25, 64, 71 change — not 23, 44, 47, 48 |
| Effective date of the 2024 IR amendments (18/04/2025) | — | **secondary only** (EY, KPMG) |

Not found: a ZATCA VAT FAQ (the FAQ PDF found is Zakat); the amending
resolution as a separate document (read through the consolidated footnotes).

### 28.1 K2 — the 49(8) deadline

- **Start: the supply's calendar year — authoritative.** "Date of supply" is
  defined only in the Arabic Agreement 23(2) and kept separate from the tax
  point 23(1); IR Art. 20 merges them only for continuous supplies, utilities,
  government contracts and deemed supplies. A later-dated or later-received
  invoice does not move the clock.
- **End: CONFLICT (unresolved).** Y+5 — the unofficial English ("more than
  five calendar years after the calendar year") and every ZATCA paraphrase in
  2020, 2021 and 2026, in both languages («ألّا تتجاوز (5) سنوات بعد السنة التي
  تم بها التوريد»). Y+4 — only the drafting contrast: 49(8) is the only time
  limit in the Arabic IR saying «من السنة»; 63(4), 64(3), 64(4), 66(1), 69(2) and
  73(8) all say «من نهاية/انتهاء». No official example computes a 49(8)
  deadline (the Nov-2024 examination table is for 64(3), which says "end").
- **A second route exists:** the Nov-2024 examination guideline Example 9
  treats unclaimed input tax as a 63(2) correction, barred by 63(4) at
  31/12/(Y+5) — which route governs is unaddressed (F-A2).
- **Advance payments: CONFLICT** (F-A3): Agreement 23 / IR 79(1) (clock from the
  delivery year) vs the Arabic Tax Invoicing guideline May 2026 «يعتبر التوريد
  أنه حدث في تاريخ الدفعة المستلمة» (from the advance's year, to the extent
  paid).
- **Live code** matches the Y+5 reading ZATCA's guidance uses, but counts from
  the invoice date (K1).

### 28.2 K3 — Articles 40(10) and 40(11)

- **Trigger (A):** a taxable person who deducted input tax on «توريد استلمه» and
  has not paid in full «بعد فترة اثني عشر شهراً من الشهر التالي للشهر الذي تم فيه
  التوريد». **Mandatory** («أن يعدل»). **Amount:** the tax on the consideration
  unpaid «في ذلك التاريخ» — only the unpaid part. **Return:** «الخاص بالشهر الذي
  انتهت فيه مدة الاثني عشر شهراً».
- **What changed in 2024 (A):** pre-amendment: "12 months from the date of
  supply", «يخفض خصم», no return named. New exception: **goods** under
  financing contracts (lease finance, murabaha, lease-to-own) from a licensed
  financier with periodic instalments; all four conditions including the
  supplier's written certificate.
- **Long credit terms are caught** — stated only in the archived Arabic ITD v2
  §10.2 («…إذا تم منح فترة سماح إضافية للسداد»); the amended text is silent on
  due dates.
- **SILENT:** imports / reverse charge; whether "unpaid consideration"
  includes the VAT.
- **Month count — UNRESOLVED (ambiguous text), with a ZATCA-internal
  CONFLICT:** Reading A (the following month is month 1 → ends in M+12) vs
  Reading B (12 months from the following month → M+13). **Example 19 (supply
  August 2025) says "September 2026" in BOTH the English and the Arabic
  guideline** (reading B) — pass 1's "the Arabic gives August" was one reading,
  not a translation discrepancy, and is withdrawn. ZATCA's English explanation
  ("the 12-month period following the month of supply") reads as A while its
  answer is B. Example 19 also makes **Company B, the supplier,** adjust the
  "value of the supply", whereas 40(10) binds the customer — a second CONFLICT
  with the regulation (its arithmetic, 95,833.30, is right).
- **40(11) (A):** restoration **optional** («يجوز»), **proportional** («تعكس
  الضريبة المحسوبة على المقابل الذي قد تم سداده»), in the payment period «أو أي
  فترة ضريبية لاحقة»; that part-payments qualify is implied, not stated. Time
  limit: only 40(12)'s general reference (49(8) applying is INTERPRETATION).
- **Precedent (C/D):** neither Odoo nor ERPNext automates an unpaid-bill
  reversal (searched `l10n_sa`, `l10n_ae`, `l10n_gcc_*`, `account`, ERPNext
  `erpnext/` incl. regional); both leave it to a manual entry or a typed field.

### 28.3 Partial claims

SILENT, and why: 49(8) uses «ضريبة المدخلات» with no quantifier; "partial
deduction" in ZATCA usage means Art. 51 apportionment (extent, not timing);
Art. 52 is a statutory re-measurement; 15(8) concerns extent; the return shows
only totals (62(2)(ب)). The only per-invoice cross-period split ZATCA
illustrates is payment-forced (40(10)/(11); ITD v3 May 2026 Example 31:
re-deduct 3,750 of 7,500 in the payment period "or later periods"). Precedent:
neither Odoo nor ERPNext supports a voluntary split (C/D).

### 28.4 Credit notes against partly claimed VAT

Period settled (40(6), note's period — A). Amount SILENT: «تعكس قيمة الضريبة
المحسوبة عند التغيير» reads as level or delta; guidance assumes a full prior
deduction; Art. 54 is silent on the customer. Arabic Agreement 47(1) (deducted
vs «المتاح له خصمها») supports reducing the undeducted part first
(INTERPRETATION). Odoo's refund against a partly exigible bill has the same net
effect: it cancels the part still waiting and leaves the released part
untouched, by new dated entries undone only by mirror entries (C).

### 28.5 Invoice received after period end, before filing

Law SILENT (Agreement 48(1) «حائزاً», possessing). **Guidance CONFLICT across
languages:** May-2026 Tax Invoicing guideline — Arabic: the invoice
«تم إصدارها خلال الفترة الضريبية محل الخصم» and held (fits claiming in the
original period); English: "available during the relevant tax period" (does
not). The English ITD example assumes the return was already filed; the
prevailing Arabic says only «تعدّت فترة الإقرار الضريبي لشهر مارس». A later
period is permitted by every source (A).

### 28.6 Odoo / ERPNext (C/D, precedent only)

No automatic 40(10)-style reversal or restoration in either; no voluntary
split other than Odoo's payment-driven cash basis; Odoo's refund-vs-partly
-exigible-bill behaviour as in 28.4; return adjustments are hand-typed values
(Odoo `l10n_sa` "Net VAT Due", `l10n_ae` line 8) or user fields (ERPNext UAE
"recoverable") — nothing derives adjustments from data.

### 28.7 Return placement — only what sources establish

| Item | Established? | Source |
|---|---|---|
| 63(1) over-claim | **Yes** — electronic amendment of the original return via the portal; ZATCA issues a new assessment | IR 63(1); examination guideline §5.2; Arabic user guide Aug 2023 |
| 63(2) under-claim (error) | **Yes** — any later return; Box 14 under SAR 15,000, otherwise the Adjustment columns | IR 63(2); examination guideline §5.1.1; amendments guideline Ex. 26 |
| 63(3) understatement < SAR 15,000 | **Yes** — Box 14 of the discovery period's return | IR 63(3); amendments guideline Ex. 25 |
| Late 49(8) claim | **No — CONFLICT** — Dec-2024 simplified guide p. 6: add to the purchases entries (Box 7, column unnamed) vs examination guideline Ex. 9: a 63(2) correction | F-A2 |
| 40(10) reversal / 40(11) restoration | **No — SILENT** — nearest analogues point to the Box 7 Adjustment column (analogy only) | F-A6 |
| Guidance vs IR on 63(1)/(2) | **CONFLICT** — Dec-2024 simplified guide p. 9 appears to invert them | F-A10 |

Nothing here changes the return; 13D consumes it.

## 29. Accountant and tax-advisor answers (received 2026-09-28) — recorded as given

🔴 **These are PROFESSIONAL ADVICE, not law.** Recorded exactly as relayed by
the owner on 2026-09-28 (the owner's transcription of the advisers' answers;
the advisers' own written text was not provided). Each is verified in §30;
where advice and the current authoritative text differ, §30 says so and does
not choose silently. They answer the §26 questions as mapped in the last
column. **F-B0 (the X1/X3/X5 answers in writing) is NOT among them** — R1
stands.

| ID | From | Answer as relayed | Answers |
|---|---|---|---|
| ACC-1 | Accountant | "Irrecoverable VAT: Transfer to cost/expense in the period it becomes non-recoverable. For Article 40(10) non-payment, report it in the return for the month the 12-month period ends." | F-B1 |
| ACC-2 | Accountant | "Article 40(10)/(11) journal entries: Reversal: Dr Cost/Expense, Cr Input VAT adjustment. Restoration: Dr Input VAT adjustment, Cr Cost/Expense when payment is made." | F-B2 |
| ACC-3 | Accountant | "Blocked Article 50 VAT: Dr Cost/Expense, Cr Input VAT reversal. If the error exceeds SAR 5,000, amend the original return." | F-B3 |
| ADV-4 | Tax advisor | "Five-year deadline: Ends after 5 calendar years following the supply year." | F-A1 |
| ADV-5 | Tax advisor | "Late claim: Normal later-period claim if within 5 years. Article 63 correction only if the error exceeds SAR 5,000." | F-A2 |
| ADV-6 | Tax advisor | "Advance invoice: The period starts from the supply year, not invoice issuance." | F-A3 |
| ADV-7 | Tax advisor | "Late invoice before filing: Yes, claim in the original period if the supply belongs there." | F-A4 |
| ADV-8 | Tax advisor | "Article 40(10) 12 months: Starts the month after supply and ends on the last day of the 12th month. Adjustment is made in that month's return." | F-A5 |
| ADV-9 | Tax advisor | "Return box: Use the Input VAT adjustment line, not standard domestic purchases." | F-A6 |
| ADV-10 | Tax advisor | "Partial claims: No. Claim the whole invoice in one period. Non-payment is handled through Article 40(10)." | F-A7 |
| ADV-11 | Tax advisor | "Credit note: Already claimed → reverse. Never claimed → no adjustment." | F-A8 |
| ADV-12 | Tax advisor | "Restoration: Subject to the 5-year limit. Applies to imports/reverse charge." | F-A9 |
| ADV-13 | Tax advisor | "Conflicting guidance: Implementing Regulations prevail over ZATCA guidance." | F-A10 |

## 30. Verification of each answer

> **Superseded in part by §31 (2026-09-28):** M1 (adjustment account), M2
> (inventory/fixed assets), M3 (SAR 15,000 confirmed) and the M+12/M+13 count
> are now answered; the "open" statuses below are kept as the record of that
> step. The operative decisions are the §32 matrix.

Categories used in this section (distinct from the A–F letters above):
**AUTHORITATIVE** (current Saudi law/ZATCA text settles it) · **ADVICE**
(accountant or tax advisor; recorded, not law) · **PRECEDENT** (Odoo/ERPNext) ·
**PRODUCT** (Saudi Ledger decision) · **UNRESOLVED**.

### 30.1 🔴 The SAR 5,000 vs SAR 15,000 conflict — RESOLVED BY AUTHORITY: SAR 15,000

| Question | Finding | Source (version) | Category |
|---|---|---|---|
| Current threshold | **SAR 15,000.** An understatement of net tax whose net value is less than 15,000 riyals may be corrected by adding it to the net tax due in the return filed **for the tax period in which the error was discovered**. | IR Art. 63(3), **Arabic, Tenth Edition (Shawwal 1446 / April 2025), consolidated through Res. 01-06-24 of 19/11/2024, pp. 129–132**, footnotes 221–226 (read from the primary PDF 2026-09-16, recorded in [`accounting-architecture-decision-pack.md` D-5](accounting-architecture-decision-pack.md); reconfirmed by the second pass, §28.7) | AUTHORITATIVE |
| Where SAR 5,000 comes from | The **superseded** Art. 63(3): "less than five thousand (5,000) SAR … may correct that error by adjusting the Net Tax in its next Tax Return" — set by BoD Resolution (2-4-17) of 28/12/2017. The article's before/after table in the Tenth Edition shows the raise from 5,000 to 15,000. | English IR **8th edition 09/11/2021**, Art. 63(3), fn 39 — `docs/zatca/specs/KSA_VAT_Implementing_Regulations_EN.txt:2146`; **this is still the live English file on zatca.gov.sa** (§28.0), so an English-only reader gets 5,000 | AUTHORITATIVE (as superseded text) |
| Verdict on the advisers' SAR 5,000 | **Outdated**: it matches the pre-amendment English text exactly (threshold and "next return" mechanism). It does not match any current provision found. | as above | AUTHORITATIVE |
| What the threshold governs | Only the **mechanism for an UNDERSTATEMENT of net tax** (e.g. input VAT over-claimed, blocked VAT wrongly deducted): **≥ SAR 15,000** → notify within 20 days by correcting the previously filed return (63(1)); **< SAR 15,000** → may instead be added to the discovery period's return (63(3); Box 14, amendments guideline Ex. 25). An **overstatement** (input VAT under-claimed by error) → any later return, no threshold on the route (63(2), bar 63(4); guidance: Box 14 < 15,000, else Adjustment columns). | IR 63(1)–(4) (Arabic 2025); examination guideline Nov 2024 §5.1.1 | AUTHORITATIVE |
| Does it apply to a late claim (evidence not held)? | **No.** A claim delayed because the evidence was not held is a current-period deduction under 49(8) (ITD Example 26), not an error; Art. 63 and its threshold do not arise. (Second-pass CONFLICT F-A2 — Example 9 of the examination guideline treating unclaimed input tax as 63(2) — concerns tax **missed by error**; ADV-5 resolves the evidence case as a normal later-period claim.) | IR 49(8); ITD 2020 Ex. 26; ADV-5 | AUTHORITATIVE + ADVICE |
| Does it apply to ACC-3 (blocked VAT found wrongly deducted)? | **Yes** — that is an understatement of net tax: ≥ SAR 15,000 → amend the original return within 20 days; < SAR 15,000 → may be added to the discovery period's return. ACC-3's direction ("amend the original return" above the threshold) matches 63(1); its **number does not**. | IR 63(1), 63(3) | AUTHORITATIVE |
| Live code | The Art. 63 refusal message was corrected in 13E to SAR 15,000 / discovery period (P13-N2, closed). **It must NOT be changed back to 5,000** on the strength of the advice. | `advanceInvoices.service.ts` (13E) | PRODUCT (live, correct) |

**Consequence:** ACC-3's and ADV-5's SAR 5,000 are recorded as advice
referring to superseded text; the implemented rule is **SAR 15,000 (Art.
63(3) as amended)**. A confirmation from both advisers was requested (M3) —
the accountant has since confirmed SAR 15,000 (§31, FIN-ACC-3),
not because the law is unclear, but so their advice and the product agree.

### 30.2 Answer by answer

| ID | Verification | Category | Status |
|---|---|---|---|
| ACC-1 | **Timing** ("in the period it becomes non-recoverable") matches IFRS: derecognition when it no longer meets the asset definition (CF 5.26, 5.28(a)); a change in estimate, prospective (IAS 8.34, 8.36–37). **Legal point of non-recoverability** for held VAT: the right is lost when the 49(8) window closes (AUTHORITATIVE, "لا يجوز"). **Destination** "cost/expense": IFRS silent (B); accountant's decision. ⚠️ For purchases capitalised into inventory or a fixed asset, "cost" can mean the asset's carrying amount — no cost-adjustment act exists for a fixed asset (pack §9.6) → clarify (M2). **40(10) return timing** in ACC-1 matches IR 40(10) (AUTHORITATIVE). | ADVICE (+ consistent with IFRS / IR) | Accepted; M2 open |
| ACC-2 | Law specifies the **tax** adjustment and its return, not the booking (SILENT) → accountant's decision. **Amount**: the tax on the consideration unpaid at the trigger date (IR 40(10), AUTHORITATIVE); restoration **proportional** to what is paid and **optional** (40(11)). ⚠️ "**Input VAT adjustment**" is not an account in our chart (we have `VAT_INPUT` "Input VAT Receivable", `VAT_AWAITING_EVIDENCE`, `VAT_OUTPUT`): either the credit is to `VAT_INPUT` itself, or to a new input-VAT contra account that the return reads with `VAT_INPUT`. Same wording hazard as X1's "VAT payable" (U1) → clarify (M1). ⚠️ "Cost/Expense" for inventory/fixed-asset purchases → M2. Precedent: neither Odoo nor ERPNext automates this; Odoo's SA/AE charts only provide a manual "Tax Adjustments" journal (PRECEDENT). | ADVICE | Accepted in principle; M1, M2 open |
| ACC-3 | Book entry: accountant's decision (law silent on booking). **Date**: the discovery date (Commercial Books IR Art. 6, AUTHORITATIVE). "**Input VAT reversal**" account: same ambiguity as ACC-2 (M1). **Threshold: CONFLICT → SAR 15,000 governs (§30.1).** | ADVICE + AUTHORITATIVE correction | Accepted with threshold corrected; M1, M3 |
| ADV-4 | End of window = 31/12/(Y+5). Consistent with every ZATCA paraphrase (2020/2021/2026, both languages) and the English text; the drafting-contrast reading (Y+4) is not adopted by the advisor. ZATCA states it applies its guideline treatments (ITD AR v2 Nov 2021, front matter) — consistent. **Matches live code's end point.** Start = the **supply** year (AUTHORITATIVE) — live code still uses the invoice date (K1). | ADVICE resolving an ambiguity (+ consistent with ZATCA guidance) | Accepted; K2 closed, K1 open |
| ADV-5 | First sentence consistent with IR 49(8) and ITD Example 26 (AUTHORITATIVE/guidance) — resolves F-A2 for **late evidence** in favour of the 49(8) route. Second sentence: **threshold outdated** (§30.1), and the framing is inexact — Art. 63 applies to *errors* of any size; the threshold only selects the mechanism for *understatements*; an under-claim by error is 63(2) with no threshold. | ADVICE (part outdated) | Accepted for late evidence; M3 open |
| ADV-6 | Consistent with Agreement 23(2) and IR 79(1), which keep the date of supply separate from the tax point (AUTHORITATIVE reading); contrary to the May-2026 Arabic Tax Invoicing guideline, which treats the supply as occurring at the payment — ADV-13 resolves guideline-vs-regulation in favour of the regulation. Effect: the clock for an advance's input VAT starts in the (later) supply year — the window can only lengthen. | ADVICE (+ consistent with IR) | Accepted |
| ADV-7 | Law SILENT; consistent with the prevailing **Arabic** May-2026 Tax Invoicing guideline (invoice issued in the period and held), inconsistent with its English version; the Arabic prevails by the guideline's own statement. "If the supply belongs there": the period must still be open for claims — we hold no record of filed returns, so the period lock is the proxy (PRODUCT). | ADVICE (+ consistent with Arabic guidance) | Accepted |
| ADV-8 | Reading A (month after supply = month 1 → the 12th month is M+12; adjust in M+12's return). **CONFLICT with ZATCA's own Example 19 (M+13), both language versions.** The IR text allows both counts; ADV-13 (regulation prevails) does not by itself settle an *ambiguous* regulation, and ZATCA says it applies its guideline treatments. Effect of A vs B: A reverses **one month earlier** than ZATCA's example — the tax is paid earlier, never understated (INTERPRETATION). Recorded, not silently resolved. | ADVICE vs ZATCA guidance | Accepted as the product rule; conflict documented; residual assessment-risk note |
| ADV-9 | **No line of that name exists on the official return**: boxes 1–16, purchases boxes 7–11 each with Amount / Adjustment / VAT columns, Box 14 "corrections from previous periods" (N1 record; §28.7). "Not standard domestic purchases" excludes Box 7 — which would also exclude Box 7's Adjustment column, the nearest official analogue; Box 14 is for error corrections, which a 40(10) adjustment is not. → **UNRESOLVED as worded**; clarify which official box/column (M4). Blocks 13D, not 13B. | ADVICE, unmappable as worded | Open (M4) |
| ADV-10 | Consistent with the law's silence (the safe reading, §28.3). Resolves F-A7. | ADVICE | Accepted |
| ADV-11 | "Already claimed → reverse": IR 40(6), in the note's period (AUTHORITATIVE). "Never claimed → no adjustment": consistent with ZATCA guidance attaching the duty to a prior deduction (Invoicing & Records §7.1.1; ITD §10.1) — ADVICE. With ADV-10 (no partial claims) the partly-claimed case arises only after a partial 40(10) reversal (see D13B-11). **Live code consistent**: a note on held VAT reduces the holding account and touches no return. | AUTHORITATIVE + ADVICE | Accepted |
| ADV-12 | Restoration bounded by 49(8): consistent with 40(12)'s general reference (INTERPRETATION → now ADVICE). Imports / reverse charge: IR 40(10) text SILENT ("a supply received"); ADVICE. **No import or reverse-charge purchase document exists in the product** (reverse charge appears only as a bank-line categorisation basis, `categorizer.ts`) → no consumer today. | ADVICE | Accepted; scope note |
| ADV-13 | **AUTHORITATIVE** by ZATCA's own text: the Arabic Input Tax Deduction guideline (v2, Nov 2021, front matter): «ولا يعد محتوى هذا الدليل بمثابة تعديل على أي من أحكام الأنظمة واللوائح المعمول بها في المملكة» (its content does not amend any law or regulation). The same paragraph says ZATCA applies the guideline's explanatory treatments where applicable → where a regulation is *ambiguous* and the guideline *interprets* it (ADV-8), assessment risk remains. Resolves F-A10 (the Dec-2024 filing guide's apparent inversion of 63(1)/(2) yields to the IR). | AUTHORITATIVE | Settled |

## 31. Final clarifications (received 2026-09-28) — recorded as given, verified

🔴 **Professional advice, not legislation.** Relayed by the owner on
2026-09-28 (the owner's transcription; the advisers' own written text was not
provided). They close M1–M3 and the M+12/M+13 question from the earlier
must-answer list (superseded by §33).

| ID | From | Answer as relayed | Closes | What kind of question it answers | Verification |
|---|---|---|---|---|---|
| FIN-ACC-1 | Accountant | "VAT account for Article 40(10)/(11): Create a separate VAT adjustment account. Do not use the standard Input VAT Receivable account. The separate account should allow the reversal/restoration to be tracked independently for ERP audit trails." | M1 (for 40(10)/(11)) | **Accounting / product implementation** — the law prescribes the tax adjustment and its return, not the account (SILENT on booking) | No conflict with any source. Consistent with Commercial Books IR Art. 3/6 (identifiable corrections) and IR 66(3) (documented processing) — those require traceability, not a particular account. PRECEDENT: Odoo's SA/AE charts keep a separate manual "Tax Adjustments" journal (C). ⚠️ The answer names **only 40(10)/(11)**; the account for an Art. 63 / Art. 50 **correction** (ACC-3's "Input VAT reversal") is not stated → residual **M1b** (§33). |
| FIN-ACC-2 | Accountant | "Inventory / fixed assets: Non-recoverable VAT follows the underlying inventory/fixed-asset cost rather than being posted directly to P&L. Inventory: If still held: increase inventory cost. If already sold: increase cost of goods sold. Fixed asset: Increase the fixed asset book value. Adjust future depreciation accordingly." | M2 | **Accounting treatment** (IFRS is silent on the destination; the accountant chooses) | Consistent with the first-pass IFRS analysis (§4): non-refundable taxes are cost (IAS 2.11, 16.16(a), 38.27(a)); a change is prospective (IAS 8.36–37; IFRIC 1 by analogy) — B. **Product gaps (verified in code):** no inventory module, no inventory/COGS accounts in the chart; fixed assets have a prospective re-estimate act (`capitalisation.service.ts` `changeEstimate`: residual value, useful life, method) but **no cost-adjustment act**. |
| FIN-ACC-3 | Accountant | "VAT correction threshold: The current threshold is SAR 15,000. SAR 5,000 is outdated. Below SAR 15,000: correct through the next return/net adjustment. At or above SAR 15,000: amend the original return within 20 days of discovery." | M3 | **Confirms the law** (the rule itself is AUTHORITATIVE, §30.1) | Agrees with IR 63(1)/(3) (Arabic, Tenth Edition, amended through 19/11/2024). Nuance, stated not resolved away: the IR's words for the < 15,000 case are the return **"for the tax period in which the error was discovered"**; "the next return" is the same return in practice (D-5), but where they differ **the IR's wording governs** (ADV-13). |
| FIN-ADV-4 | Tax advisor | "Article 40(10) timing: Use M+12, not M+13. The 12-month period starts in the month following the supply month and ends at the end of Month +12. The reversal is included in the VAT return for the period in which that 12-month period ends. Example: Supply in January → 12-month period runs February through January of the following year → reversal in the following January return." | M+12 vs M+13 | **Legal reading of an ambiguous provision** (the advisor's professional reading; the text supports both counts, §28.2) | Adopted as the product rule. ZATCA's own amendments-guideline Example 19 (both languages) uses M+13 — **the conflict is documented, not erased**. Effect: M+12 reverses one month *earlier* than ZATCA's example — tax paid earlier, never understated (INTERPRETATION). |

## 32. Final Phase 13B decision matrix

**Basis columns:** **A** authoritative legal/regulatory basis · **B**
accountant/tax-advisor advice (not law) · **C** Odoo/ERPNext implementation
precedent · **D** Saudi Ledger product decision. **Status:** SETTLED (A
decides it) · ADOPTED (B or D decides a question A leaves open; recorded as
such) · OPEN · DEFERRED. Nothing in this table is implemented.

| ID | Decision | A — authoritative | B — advice | C — precedent | D — product | Status | Implementation consequence (when 13B is authorised) |
|---|---|---|---|---|---|---|---|
| **D13B-01** Supply date & five-year deadline | Deduction window runs from the **supply's calendar year** to **31/12 of year+5** | IR 49(8) (Arabic): start = supply year. End: text ambiguous (§28.1) | ADV-4: end = 31/12/(Y+5) | — | Add a supply date to purchase documents (default = invoice date, editable, flagged "defaulted"); live end point kept | Start SETTLED; end ADOPTED (B) | New column + backfill (= `date`, flagged); window check and trigger move from `date` to supply date (closes K1, K2) |
| **D13B-02** Late VAT claims | A claim delayed for lack of evidence is a normal deduction in the later period in which the evidence is held — **not** an Art. 63 correction | IR 49(7)–(8); ITD 2020 Example 26 (guidance) | ADV-5 (first sentence) | — | Keep live evidence-date behaviour | SETTLED + ADOPTED | `claimed` event dated the evidence date, classified `late` for 13D |
| **D13B-03** Advance invoices | The 49(8) clock for an advance's input VAT starts in the **supply** year, not the advance's | Agreement 23(2), IR 79(1) (supply date ≠ tax point); IR prevails over the 2026 invoicing guideline (ITD AR v2 front matter) | ADV-6 | — | Until the supply is known, use the advance date (earlier ⇒ stricter, never over-permissive) | ADOPTED (B, consistent with A) | Z-AP1 advance invoices carry the eventual supply date; interim default = advance date |
| **D13B-04** Invoice received before filing | May be claimed in the supply period if the supply belongs there and that period is still open | Law SILENT; prevailing Arabic Tax Invoicing guideline v3 (May 2026) supports it | ADV-7 | — | Period lock is the filed-return proxy until 13D records filings | ADOPTED (B) | Allow a claim date inside the supply period while unlocked (live already allows) |
| **D13B-05** Whole-invoice claim | No voluntary partial claims: one invoice's VAT is claimed whole in one period; non-payment is handled by 40(10) | Law SILENT (§28.3) | ADV-10 | Neither Odoo nor ERPNext supports a voluntary split | Refuse voluntary splits of held VAT | ADOPTED (B) | Guard on the claim act; the ledger remains multi-event (40(10)/(11), notes) |
| **D13B-06** Art. 40(10) reversal | **Mandatory** reversal of the tax on the consideration still unpaid; trigger at the end of month **M+12** (the month after the supply month is month 1); reported in the return for the period in which M+12 falls; financing-contract exception (goods; four conditions incl. the supplier's written certificate) | IR 40(10) (Arabic 2025, amended 19/11/2024): the duty, the amount, the return, the exception. The month count is ambiguous in the text; ZATCA Example 19 counts M+13 (CONFLICT, documented) | FIN-ADV-4: M+12 | Neither Odoo nor ERPNext automates it (manual adjustment journal / typed field) | System proposes, a human posts (D13B-16) | Duty SETTLED; count ADOPTED (B) | `reversed_unpaid` event; purchase-side payment ageing from `billPosition`/`bill_payments`; exception flag + certificate evidence; date tables for monthly and quarterly filers |
| **D13B-07** Art. 40(11) restoration | **Optional**, proportional to the consideration later paid, in the payment period or any later one, within the 49(8) window | IR 40(11) («يجوز», proportional); 40(12) general time-limit reference | ADV-12: bounded by the 5-year limit | — | Proposed on payment, posted by a human | SETTLED (optional, proportional) + ADOPTED (5-year bound) | `restored_on_payment` events, possibly several per document |
| **D13B-08** Separate VAT adjustment account | 40(10) reversals and 40(11) restorations post to a **separate input-VAT adjustment account**, never to `VAT_INPUT` ("Input VAT Receivable") | Law SILENT on booking; traceability duties (Books IR Art. 3/6; IR 66(3)) | FIN-ACC-1 (accounting/ERP-audit decision) | Odoo: separate manual "Tax Adjustments" journal | New system account; the return reads it as input-VAT adjustment (placement: 13D) | ADOPTED (B) | New `system_account_templates` row → **`seed_org_chart_of_accounts()` must be redefined in the same migration** (CLAUDE.md §4) + org backfill; invariant: account balance = Σ(reversals − restorations) by document |
| **D13B-09** Inventory treatment | Non-recoverable VAT on inventory: still held → **increase inventory cost**; already sold → **increase cost of goods sold** | IAS 2.11 (non-recoverable taxes are cost) — B-standard; destination SILENT | FIN-ACC-2 (accounting decision) | — | No inventory module or inventory/COGS accounts exist | ADOPTED (B) — **no consumer until Phase 14** | None in 13B; record as a Phase 14 requirement (inventory must accept a VAT cost adjustment and route sold quantities to COGS) |
| **D13B-10** Fixed-asset treatment | Non-recoverable VAT on a fixed asset **increases its book value**; **future depreciation is adjusted** prospectively | IAS 16.16(a); IAS 8.36–37 (prospective); IFRIC 1 by analogy — B-standard | FIN-ACC-2 (accounting decision) | — | Needs a new audited **fixed-asset cost-adjustment act** (reason required, prospective recalculation reusing the `changeEstimate` machinery); disposed assets → P&L (the asset no longer exists) — PRODUCT sub-decision, to confirm at architecture review | ADOPTED (B); act NOT built | New FA act in the FA module (not a second posting path); the 13B event (`expired`/`written_off`/`reversed_unpaid` on an asset bill) calls it |
| **D13B-11** Credit notes | Claimed VAT → reversed in the note's period; never-claimed VAT → no return adjustment (held amount reduced in the books); after a partial 40(10) reversal, the note reduces the unreversed claimed part first | IR 40(6) (period; claimed case); guidance §7.1.1 / ITD §10.1 (duty follows a prior deduction) | ADV-11 | Odoo refund vs partly exigible bill: same net effect | Edge-case allocation rule (after partial reversal) | SETTLED (claimed) + ADOPTED (never claimed) + D (edge) | Live behaviour kept; `reduced_by_note` events; general Σ-reductions ≤ VAT guard |
| **D13B-12** Art. 50 blocked VAT | At posting: VAT in the expense/asset cost, never claimed (LIVE). Found **later** after being claimed: correction **Dr cost / Cr (account per M1b)**, dated the discovery date, reported by the Art. 63 route (D13B-13) | IR Art. 50 (amended 19/11/2024); Books IR Art. 6 (discovery date); IR 63 | ACC-3 (entry shape); FIN-ACC-2 (asset/inventory destination) | Odoo: non-deductible share posts to the line's account | — | Posting SETTLED + LIVE; correction entry **OPEN on the credit account (M1b)** | `correction` event with 63(5) detail; journal waits for M1b |
| **D13B-13** SAR 15,000 correction threshold | Understatement of net tax (e.g. over-claimed input VAT): **≥ SAR 15,000** → notify within 20 days by correcting the original return; **< SAR 15,000** → may be added to the return for the tax period in which the error was discovered. Overstatement (under-claimed by error) → any later return, 5-year bar | IR 63(1)–(4) (Arabic, Tenth Edition, amended through 19/11/2024). SAR 5,000 = superseded 2017 text, still in ZATCA's English file | FIN-ACC-3 confirms (its "next return" wording yields to the IR's "discovery period") | — | Threshold held as a versioned, configurable tax rule (D-5 requirement), value 15,000; the live 13E message already says 15,000 | **SETTLED (A)** | Correction routing reads the rule record; never hard-code 15,000; never revert the 13E message |
| **D13B-14** Correction vs late claim | A **late claim** (evidence not held) is a normal later-period deduction; a **correction** is an Art. 63 error correction with its own route, 20-day and 5-year clocks and 63(5) detail; the SAR 15,000 threshold selects the correction **mechanism**, not whether Art. 63 applies | IR 49(8), 63(1)–(5); ITD Ex. 26 | ADV-5 (read with FIN-ACC-3) | — | Two event types, never merged | SETTLED + ADOPTED | `claimed` (late) vs `correction` events, each classified for 13D |
| **D13B-15** Imports / reverse charge | 40(10)/(11) apply to imports and reverse-charge supplies | IR 40(10) text SILENT ("a supply received") | ADV-12 | — | No import or reverse-charge **purchase document** exists (reverse charge is only a bank-line categorisation basis, `categorizer.ts`) | ADOPTED (B) — **no consumer today** | Applies when such documents are built; no 13B work |
| **D13B-16** Propose-then-post | The system **proposes** 40(10) reversals, 40(11) restorations and 49(8) expiries; a **human posts** them | 40(11) is optional (a choice exists); 40(10) is mandatory (the proposal list is the alarm) | — | Neither Odoo nor ERPNext automates these (manual) | CLAUDE.md §4 "AI proposes; it never posts"; "who finds out?" — an unposted mandatory reversal must be visible, not silent | ADOPTED (D) | Proposal lists with due dates; an overdue mandatory 40(10) proposal is surfaced as an alarm, never auto-posted |
| **D13B-17** Append-only VAT claim history | One append-only event stream per purchase document; state, balances and the return's input-VAT figure are derived; `bills.input_vat_*` becomes a verified cache | Books IR Art. 6 (corrections by new entries at discovery) and Art. 3 (tamper controls); IR 66(3)(ج)–(و); IR 62(2)(ب),(ط),(ي) and 63(5) (what must be reportable) | — | ERPNext Payment Ledger (derived balances; immutable-mode reversals); Odoo cash-basis (dated event + linked entry; mirror undo) | Event model §8; DB append-only guard; RLS; invariant sweep; backfill reconciled to the cent | ADOPTED (D, grounded in A) | New table, append-only triggers + REVOKE, projection, invariants (events ⇄ GL ⇄ cache ⇄ return), backfill; closes K5–K7 |
| **D13B-18** Return-box mapping (M4) | Exact box/column for 40(10) reversals and 40(11) restorations (and the late-claim placement) | Not established: no official source names the box (§28.7); "Input VAT adjustment line" is not an official line as worded | ADV-9 (unmappable as worded) | — | 13B stores the event classification only | **DEFERRED to 13D** (P13-N1) | None in 13B |

## 33. PHASE 13B BUILD GATE

**Settled or adopted (A, or B/D where A is silent):** D13B-01 to D13B-11,
D13B-13 to D13B-17 — the supply-date clock and its end point, late claims,
advance invoices, pre-filing invoices, whole-invoice claims, the mandatory
40(10) reversal at M+12 and the optional proportional 40(11) restoration, the
separate adjustment account for 40(10)/(11), the inventory and fixed-asset
treatment, credit notes, the SAR 15,000 correction rule, the correction-vs-late
distinction, the imports scope, propose-then-post, and the append-only ledger.

> **M1b RESOLVED (accountant, relayed by the owner 2026-09-28 — ADVICE, an
> accounting/booking decision; the law is silent on booking):** "For Article 50
> non-deductible VAT that was already claimed: Dr Relevant Cost/Expense or
> Inventory Cost or Fixed Asset Cost / Cr VAT Adjustment – Blocked (Art. 50).
> Use a dedicated VAT Adjustment account. Do NOT credit Input VAT Receivable.
> Reason: Input VAT Receivable represents deductible/recoverable VAT. Article
> 50 VAT is non-deductible and should not remain represented as recoverable
> VAT." → **D13B-12's correction entry is settled**: credit a dedicated
> `VAT Adjustment – Blocked (Art. 50)` account, distinct from the 40(10)/(11)
> adjustment account (D13B-08). The architecture that follows from this pack
> is [`phase-13b-vat-claim-ledger-architecture.md`](phase-13b-vat-claim-ledger-architecture.md),
> whose §24 is now the operative gate.

> **ARCHITECTURE DECISIONS LOCKED (owner, 2026-09-28)** — full outcome in the
> architecture document §1–§4. Two effects on THIS pack's rows, recorded here
> so the rows are not read as settled beyond what they are:
> - **D13B-11, edge rule** ("after a partial 40(10) reversal, the note reduces
>   the unreversed claimed part first") — **NOT APPROVED (AD-10)**. It stays a
>   proposal; the credit-note interactions are an unresolved accounting/tax
>   question (architecture §13, CN-1…CN-6). D13B-11's main rule is unaffected.
> - **D13B-08, implementation note** ("`seed_org_chart_of_accounts()` must be
>   redefined in the same migration") — **superseded by AD-13**: new template
>   rows use the existing mechanism (template row + existing-org backfill, as
>   migrations 0088 and 0106 did); see architecture §7.3.
> - Also not approved: posting a lapse whose expiry period is closed on the
>   first open date (AD-7) — architecture §10.4. Fixed-asset branch gated
>   (AD-6) on the income-tax pool question and the disposed-asset /
>   negative-carrying-amount decision.
>
> **FINAL LOCK (owner, 2026-09-28):** the architecture is **approved in
> principle (A-0)**; the account names are approved as proposed (A-1); the
> seeding discrepancy is recorded and the actual mechanism used (A-2); the
> evidence claim keeps its current authority (A-4); every VAT-event, bill,
> supplier-note and evidence-claim entry is protected from the generic
> reversal (A-5). **Not approved / gated:** any interim credit-note behaviour
> (A-3 — no Phase 13B credit-note integration; CN-1…CN-6 stay unresolved),
> the fixed-asset branch (A-6), the closed-period lapse (A-7).
> **Deferred to 13D:** return integration, box mapping, correction withdrawal
> (A-11). **Phase 14:** inventory. 13B-1's exact scope is the architecture
> document's §25; it has **not** started.

**Was unresolved at this point — materially affects the ledger (now resolved above):**

| # | Question | To | Why it is material |
|---|---|---|---|
| **M1b** | For an Art. 63 / Art. 50 **correction** of VAT previously claimed (ACC-3: "Dr Cost/Expense, Cr Input VAT reversal"), is the credit to (a) the new separate VAT adjustment account (FIN-ACC-1 named it only for 40(10)/(11)), (b) `VAT_INPUT`, or (c) a further correction account? | Accountant | Determines the journal of every `correction` event (D13B-12, D13B-14) and the account set the invariants reconcile |

**Still to confirm (product/architecture, owner) — not accounting:**
supply-date field UX and the "defaulted" flag (D13B-01); the fixed-asset
cost-adjustment act's shape and the disposed-asset rule (D13B-10); the
post-partial-reversal note allocation (D13B-11); DEF-2 / UI-4 (fix now, or
fold into 13B's history view).

**Recommended, not blocking:** F-B0 — the accountant's X1/X3/X5 answers in
writing, stored verbatim (R1), since 13B builds on those live decisions.

**Deferred to Phase 13D:** M4 / D13B-18 — the official box/column for 40(10)
reversals and 40(11) restorations, the late-claim placement, Art. 50
reporting; the official return layout (P13-N1); filed-return snapshots.

**Deferred to Phase 14 (inventory):** D13B-09 — inventory cost / COGS
adjustment for non-recoverable VAT.

**Gate status (at the end of discovery): 🔶 READY FOR ARCHITECTURE — NOT READY TO IMPLEMENT.** Superseded by the architecture document's §24 gate after M1b was answered.
Every accounting decision that shapes the event model, the 40(10)/(11)
journals, the adjustment account, the asset treatment and the correction
routing is settled **except M1b**, which fixes the credit side of the
`correction` event's journal. Architecture (schema, event model, projections,
invariants, backfill plan, the FA cost-adjustment act) may proceed now; the
gate moves to **ready to implement** when M1b is answered and the owner has
confirmed the four product items above. No 13D or Phase 14 item blocks 13B.

