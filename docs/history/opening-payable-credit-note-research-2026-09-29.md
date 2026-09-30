# A supplier credit note against an OPENING (Batch 1C) payable: can it carry VAT, and what treatment applies?

Research date: 2026-09-29. Read-only research: no repository file, database or migration was touched.

**Status (2026-09-29): research COMPLETE; nothing implemented from it. The
13B-3 refusal (`input_vat_note_opening_original`) stays as the interim
behaviour until the owner decides §4 and the accountant answers §3. Current
state authority: [CLAUDE.md §2](../../CLAUDE.md).** Record of the gate:
[`phase-13b2-credit-note-event-design.md`](../product/phase-13b2-credit-note-event-design.md) §19.14.
The working files named below (`p13b2-*.md`, `research-13b/`, `p3/`, `ocn/`)
are session research notes, not repository files.

**What this builds on.** It reuses, and cites rather than repeats:
- `p13b2-saudi-ifrs.md` (pass 1), `p13b2-pass2.md` (pass 2) and `p13b2-odoo-erpnext.md`
- `research-13b/*` (the IR in Arabic and English, the GCC Agreement in Arabic, ITD v3, INV v3)
- `p3/*`, the NFKC-normalised Arabic copies

New material retrieved this pass is in `scratchpad/ocn/`.

**Labels:**
- **AUTH**: VAT Law, IR, GCC Agreement, or the e-invoicing Resolution.
- **GUID**: a ZATCA guideline or FAQ. Guidelines state that they do not amend the IR.
- **STD**: SOCPA-endorsed IFRS.
- **ODOO / ERPNEXT**: open-source precedent only.
- **SL**: Saudi Ledger's own code and docs.
- **INT**: my interpretation, always marked.
- **SILENT**: the sources do not address the point.
- **SEC**: a secondary source (advisor or firm commentary). It is not authority.

---

## 0. The question, restated precisely

- **The original.** A supplier tax invoice issued before the tenant's cut-over. The tenant's previous system recorded it, and its input VAT was treated (claimed, not claimed, blocked, or reversed) in returns filed from that system.
- **How it sits in Saudi Ledger.** It is an opening payable: a `bills` row with `is_opening = true`, `total` equal to the **outstanding** gross amount, and `vat_amount = 0` by construction (`bills_opening_no_vat_chk`, migration 0077:247).
- **The new document.** After cut-over, the **supplier** issues a credit note against that invoice.
- **What we must decide.** What the tenant, as the customer, must do about input VAT, and what the product should do about it.

**The fact that reframes the problem (INT, strongly grounded).** The previous-system question in the Batch 1C pack (§16.14.1 / §16.14.9 item 3) concerned notes **we issue** against invoices our tenant's old e-invoicing solution issued. This case is the mirror image.
- Both the original invoice and the credit note are the **supplier's** documents, issued from the supplier's own solution and chain.
- The tenant's change of bookkeeping system is invisible to the supplier and to ZATCA's treatment of the supplier's documents.
- So nothing in the e-invoicing "previous solution" uncertainty applies here.
- The only open question is the **customer's input-tax treatment**, which is an Art. 40(6) question, not an e-invoicing one.

---

## 1. Findings table

| # | Claim | Class | Source |
|---|---|---|---|
| F1 | A credit note is due whenever an Art. 40(1) event occurs **after a tax invoice has been issued** and the tax charged exceeds the tax due. "Tax invoice" means any Art. 53 invoice. Nothing restricts the original to one issued or recorded in a particular system. | AUTH | IR-AR Art. 54(1) (amended Res. 21-2-7, 09/10/2021), `p3/ir-ar-norm.txt.nfkc` Art. 54; IR-EN 8th ed. Art. 53(11), 54(1) (1C pack §16.14.1) |
| F2 | The note must reference the original invoice(s). The form of the reference is delegated to ZATCA and is the original's number (text). That is the **supplier's** obligation when issuing. | AUTH + delegated GUID | IR 54(4) «وفقاً لما تحدده الهيئة»; Resolution Annex 2 field 13.1; EDG v2 §4.3 (pass 2, CN-8; 1C pack §16.14.1) |
| F3 | **The customer must correct its input tax** "so that it reflects the tax calculated at the change in consideration", **in the tax period in which the note was issued**. This binds a customer who «يكون شخصاً خاضعاً للضريبة أو كان كذلك في تاريخ التوريد» (is a taxable person, or was one at the supply date). The text has **no condition** about where or how the original was recorded, and no "if deducted" condition. | AUTH | IR-AR Art. 40(6), `p3/ir-ar-norm.txt.nfkc` l.1159 (40(6) was not amended in 2024; pass 1) |
| F4 | The trigger for 40(6) is the "cases referred to in paragraph 2": the **supplier** issued a tax invoice and computed tax that no longer reflects the Art. 40(1) event. These are facts about the supplier's documents, not about the customer's books. | AUTH | IR-AR 40(2)(أ),(ب), l.1123–1130 |
| F5 | The customer's **return** correction is keyed to a **prior deduction**. The input tax adjusted is «ضريبة المدخلات التي خصمها» (the input tax it deducted), when it exceeds or falls short of the amount available to deduct; cause (ب) is a later reduction of consideration. | AUTH | GCC Agreement Art. 47(1), `p3/gcc-ar-uae.txt.nfkc` l.323 |
| F6 | ZATCA guidance: "when the supply value is adjusted, the deductible input tax must be adjusted", and "if the customer … **deducted** input tax on the original consideration, it must adjust this deduction in line with the adjustment". Example 28: the customer deducted in the supply period and the goods were returned under a credit note, so the customer must adjust. | GUID | ITD v3 AR §10.1, `p3/itd3-ar.txt.nfkc` l.1259–1263, Ex. 28 |
| F7 | Invoicing guidance: the customer, «وقام بخصم ضريبة المدخلات مسبقاً» (having previously deducted the input tax), must correct its input tax to reflect the tax calculated on the adjustment. That is a **delta**, written for the full-deduction case. | GUID | INV v3 AR §7.1.1 (pass 1, Q1/Q2) |
| F8 | **Claimed original:** the customer reduces input tax in the **note's issue period** by the tax on the change. Nothing in F3–F7 makes this depend on which accounting system recorded the original deduction. | AUTH (F3) + GUID (F6, F7). The "no system distinction" point is an absence of any condition in the text, so it rests on F3's wording (INT, minimal). | as above |
| F9 | **Never-claimed original** (no deduction taken): no return correction is due. If the original is later deducted, the deduction is the **net** amount (the invoice as corrected by the note). This was already adopted for in-system held VAT as ADV-11 / D13B-11. | GUID (F6, F7 conditionals) + AUTH (F5, 49(7), GCC 57); the "net later" limb is INT | pass 1 Q2; IR 49(7); GCC 57 |
| F10 | **Art. 50 blocked original:** nothing was deducted, so there is no return correction. The note's VAT reduces the cost that absorbed it. | INT, consistent with AUTH/GUID (F5–F7); cost treatment STD | pass 1 Q6; IAS 2.11, IAS 16.16(a) |
| F11 | **An original reversed under 40(10)** (unpaid for more than 12 months) **in the previous system**, followed by a note: how the note applies is not addressed (this is CN-2/CN-3). | SILENT | pass 2 CN-2/CN-3 (every ITD3 §10 example and AMD Ex. 18–19 checked) |
| F12 | **Partly deducted original** (a partial claim, Art. 51 apportionment): level reading (GCC 47(1)) or delta reading (INV3 §7.1.1)? | SILENT at IR level; GCC 47(1) supports the level reading (INT) | pass 1 Q1 |
| F13 | **A supply made before VAT took effect (before 1 Jan 2018):** the date of supply stays the original date. The adjustment **takes the tax treatment of the original supply**, and credit/debit notes on such supplies **should not include any VAT**: «وينبغي أن يُطبق على التعديل المعاملة الضريبية المطبقة على التوريد الأصلي … لا ينبغي أن تتضمن الإشعارات الدائنة أو الإشعارات المدينة التي تعكس التعديلات على التوريدات التي تمت قبل تاريخ 1 يناير 2018م أي ضريبة قيمة مضافة». Example 4: a note issued on 4 Jan 2018 for December 2017 goods carries no VAT. | GUID | ZATCA «الدليل الإرشادي للأحكام الانتقالية», §4.2 and Ex. 4, pp. 12–13 (retrieved 2026-09-29 from zatca.gov.sa, `ocn/trans-ar.pdf`; read as page images because the text layer does not extract). The same principle sits in AUTH GCC Art. 79 / IR Art. 79 for the transition, but was not re-read here. |
| F14 | **A supply taxed at 5% before 1 July 2020, with a note issued after that date:** commentary says the note is linked to the original tax invoice and the **original rate (5%)** applies, including after the transitional period ended on 30 June 2021. | SEC only. The primary ZATCA rate-increase guideline text on notes was **not retrieved**: the ZATCA PDF located is the 2018 guideline, and the "Transitional Provisions Guidelines of VAT Rate Increase to 15%" copy retrieved (`ocn/rate15-en.txt`) is a slide summary with no note content. It is consistent with F13's principle (INT). | Search-result extract of PwC, "Saudi Arabia: End of the Transitional Period for VAT rate increase" (2021; the PDF returned 403, so it was not read directly) |
| F15 | **Pre-registration purchases:** a taxable person may deduct input tax on services received in the 6 months before registration, and on goods held at registration, under conditions. A pre-registration invoice may therefore have been deducted (at registration) or not. | AUTH | IR Art. 49(2)–(4) (IR-EN 8th ed., `research-13b/ir-en-live.txt` l.1464–1490) |
| F16 | **A tenant not a taxable person at the supply date** but taxable when the note is issued is still within 40(6)'s scope («يكون شخصاً خاضعاً للضريبة», present tense). Under F5–F7, whether there is a return effect then depends on whether a deduction was taken (F15). | AUTH scope + INT effect | IR 40(6); 49(2)–(3) |
| F17 | Deduction window: input tax may not be deducted in any period more than five years after the supply year. A reduction (a credit note) is a current-period duty, not a deduction, so 49(8) does not bar it. | AUTH (49(8)); INT (that it does not bar reductions) | IR-AR 49(8), `p3/ir-ar-norm.txt.nfkc` l.1523; pass 1 Q7 |
| F18 | **Cap:** the total VAT on credit notes against an invoice cannot exceed that invoice's VAT (tax due cannot be negative). For an opening original, that invoice VAT is the **historical** VAT, not the 0 stored on the opening row. | AUTH trigger + INT cap | IR 54(1) (pass 2) |
| F19 | A price reduction or return is not an error correction. It is a current-period event. Discounts and rebates reduce cost of purchase, and the recoverable-VAT part is not cost. | STD | IAS 2.11; IAS 16.16(a); IAS 8.5, 8.34–8.37 (from `research-13b/ifrs.md`) |
| F20 | The reduction of the payable is a partial extinguishment ("discharged or cancelled"). | STD. Quoted from knowledge of IFRS 9 3.3.1; **not re-retrieved this pass** | IFRS 9 ¶3.3.1 |
| F21 | The opening origin of the liability changes nothing under IFRS. A change of bookkeeping system is not a first-time adoption and not an IAS 8 event. The note is recognised when granted, in the current period, against the current carrying amounts. If the related expense sat in a prior (closed) year, the reduction goes to current-period profit or loss. | INT on STD | IAS 8.5/8.36; IFRS 1 not applicable |
| F22 | **Odoo:** a vendor refund (`in_refund`) may be **standalone**: `reversed_entry_id` is optional, and `_refunds_origin_required()` returns False. Its tax is **recomputed from the refund's own lines**, using the tax's refund repartition. It is never copied from, or capped by, the original bill's tax lines. The opening position is one journal entry (`res.company.account_opening_move_id`) with no bills behind it, so a refund against a migrated balance is naturally a standalone refund reconciled to the opening payable line. | ODOO | 18.0 @ `935210ad`: `account/models/account_tax.py:2408-2453`; `account/models/account_move.py:581-589, 6675-6686`; `account/models/company.py:165, 870`; test `test_account_move_in_invoice.py:1189-1250` (from `p13b2-odoo-erpnext.md` §1, re-checked) |
| F23 | **ERPNext:** a Purchase Invoice return against an opening invoice (`is_opening = "Yes"`) is **not prevented**. `validate_return_against` checks existence, party, company, posting time and exchange rate, and **never reads `is_opening`**. Opening invoices are created **with no taxes** ("the outstanding amount is entered inclusive of tax, so taxes must not be added on top of it", `dont_auto_add_taxes`). `make_return_doc` copies the (empty) taxes table. `is_opening` has no `no_copy`, so the return **inherits `is_opening = "Yes"`** (inferred from the mapper). Such a return is excluded from the regional VAT audit report, which filters `is_opening == "No"`. The user may still edit taxes or `is_opening` on the draft return. In practice ERPNext's default makes the return VAT-free, as an opening document, with no rule about the original's deduction. | ERPNEXT (inferred; not executed) | v15 @ `4aee12e1`: `erpnext/controllers/sales_and_purchase_return.py:21-83, 381-432`; `accounts/doctype/opening_invoice_creation_tool/opening_invoice_creation_tool.py:219, 285-287`; `purchase_invoice.json` field `is_opening` (no `no_copy`); `regional/report/vat_audit_report/vat_audit_report.py:76` |
| F24 | **SL before 13B-3 (`main`):** a credit note against an opening payable took `inputVatTreatment(…, {state: original.inputVatState})`. The opening row's state is NULL, which reads as `'claimed'`. So the note posted **Dr AP (gross) / Cr expense (net) / Cr VAT_INPUT (note VAT)**. The note's own row got `input_vat_state = 'claimed'` and `input_vat_claimed_on = note.date`, so the VAT return netted its VAT out of recoverable input VAT **in the note's period**. There was no VAT cap (the only cap was for held VAT); the ceiling was the gross `credit_exceeds_bill` against the opening total, which is the *outstanding* amount. **In effect it assumed "the original was claimed", silently.** | SL | `git show main:apps/api/src/services/bills.approvable.ts` l.342–367, 434–436; `purchaseEvidence/vatEvidence.ts:111-116`; `repositories/reports.repository.ts:73-75, 469-484` |
| F25 | **SL now (13B-3, uncommitted):** `input_vat_note_refusal` step 0 refuses **any VAT-bearing** note whose original `is_opening` (`input_vat_note_opening_original`), before the CI-1 cap. `assertNoteAdmissible` asks it only when the note's VAT > 0. **A VAT-free note against an opening payable is admitted** and posts Dr AP / Cr expense. The user-facing words say "record the note outside the system for now and keep it for the accountant". | SL | `packages/db/migrations/0109_phase13b3_vat_event_writer.sql:108-114, 393`; `services/accounting/inputVatLedger.service.ts:101-146`; test `phase13b3-vat-event-writer.test.ts:360-368`; architecture §26.3, §26.7 #1 |
| F26 | **What the SL migration knows about an opening payable's VAT:** staging `migration_open_items.historical_vat` is optional JSON `{category, rate, taxableAmount, amount, reportedPeriod, …bad-debt fields}`. It is accepted for AP items and never posted. There is **no field for the deduction state** (claimed / not claimed / blocked / 40(10)-reversed). `originalAmount` is staged, but the ledger row carries only the outstanding amount. `bills.migration_open_item_id` links the row back to staging. A precedent exists for reading staging VAT facts at transaction time: `badDebt.service.ts:93-107` reads `historicalVat.rate` for an Art. 40(9) recovery. | SL | `packages/db/src/schema/migrationBatches.ts:263`; `services/migrationStaging.service.ts:64, 469-490`; `services/migrationCommit.service.ts:269-273` |
| F27 | The Batch 1C pack already records the accountant's answer that a migrated bill keeps its original supply date so that 40(10)/(11) can apply (A1-AP). It also records that "a credit/debit note it issues (Art. 54, Art. 40(1)–(6))" is a new VAT event created by the platform, and that importing or allocating a migrated item never is. | SL (accountant decision + pack) | 1C pack §15.1 A1-AP, §15.2 C, §16.14.4 |

---

## 2. Answers to (a)–(d)

### (a) Can a supplier credit note validly reference a pre-cut-over (opening) invoice?

**Yes. This is SETTLED by AUTH (F1, F2, F4).**
- The obligation, the trigger and the reference all attach to the supplier's tax invoice, with no condition about the recipient's bookkeeping system.
- The supplier issues both documents from its own solution, so our tenant's cut-over has no bearing on the note's validity (INT, minimal: it follows from the absence of any such condition).
- Saudi Ledger already treats the opening bill as a legitimate original: `assertPurchaseNote` accepts it, and D-6 compares against its preserved original date.

### (b) Must the tenant reduce input tax, whatever system recorded the original? Does the original's treatment matter?

**The text binds the tenant regardless of system, and the treatment of the original DOES matter.**
1. **Regardless of system: SETTLED (AUTH F3/F4).** 40(6) binds the customer in the note's issue period. Nothing in 40(6), 54, GCC 47 or the guidelines refers to where the original was recorded.
2. **Claimed original: SETTLED for a full deduction (AUTH F3 + GUID F6/F7; F8).** The tenant must reduce input VAT in the return for the note's issue period by the note's VAT. That return is prepared by Saudi Ledger.
3. **Never-claimed original: no return correction (F9).** This is GUID + AUTH-consistent. The "later claim is net" limb is INT.
4. **Art. 50 blocked original: no return correction (F10).** INT, consistent with AUTH/GUID; the cost reduction is STD.
5. **Reversed under 40(10) in the previous system: SILENT (F11).**
6. **Partly deducted: SILENT (F12).**

So "claimed vs not claimed vs blocked" is exactly the fact that decides the treatment (F5–F7). The rule itself is not in doubt. What is in doubt is **the fact**, because the ledger does not hold it (F26).

### (c) Does the historical nature change the treatment?

**The opening nature itself: no.** No source distinguishes it (F3/F4 AUTH; F21 INT on STD). Specific historical facts do change the *outcome*, through the ordinary rules:
- **Pre-2018 supply:** the note carries no VAT and there is no input-VAT adjustment. **GUID (F13).**
- **Pre-1 July 2020 supply at 5%:** the note's VAT is at the original supply's rate. This rests on the F13 principle (GUID, stated for 2018) and on secondary commentary for 2020 (F14 SEC). **No primary 2020 text was read.** So the principle is reasoned, not verified, for 2020.
- **Pre-registration purchase:** the effect depends on whether it was deducted under 49(2)/(3). **AUTH scope (F15/F16), INT effect.**
- **Old invoice:** 49(8) limits deductions, not reductions (F17). The duty to reduce is not time-barred by 49(8); that step is INT.
- **40(10) history in the previous system:** SILENT (F11).
- **Cap:** the note's VAT is capped by the **historical** invoice VAT (F18). The opening row's 0 is a representation, not the fact (this agrees with §26.3 "T(D) = 0 by representation, not by fact").

### (d) Permanent refusal, or a controlled treatment?

**What authority settles:**
- **Permanent refusal is not supported.** For a claimed original, 40(6) (AUTH) plus ITD §10.1 and INV §7.1.1 (GUID) require the reduction in the note's period.
  - A product that can never record it forces the tenant's return, which Saudi Ledger computes, to overstate recoverable input VAT for that period.
  - The alternative is a manual adjustment outside the system, which the current refusal wording tells the user to make.
- **Blanket acceptance with an assumed "claimed" state (the pre-13B-3 behaviour, F24) is not supported either.** For a never-claimed or blocked original it reduces input VAT that was never deducted (F9/F10), which over-states the tax due. It also has no VAT cap.

**What authority does NOT settle:**
- how the product learns the original's treatment, and what evidence is enough (SILENT: no source addresses a bookkeeping system's knowledge of a previous system's return);
- the 40(10)-reversed and partly-deducted cases (F11/F12);
- the 2020-rate point at primary level (F14);
- return placement (box or column) for the customer (pass 1 Q3; 13D / P13-N1).

**A controlled treatment follows from the above (INT; not a settled product design):**
- The note is admitted only when the original's historical VAT position is a **stated fact**, not a default.
- The stated position then selects the treatment the authority already dictates for that state:
  - **claimed** → reduce input VAT (Cr VAT_INPUT) in the note's period;
  - **not claimed** → no VAT_INPUT effect;
  - **blocked** → the note's VAT reduces cost;
  - **pre-VAT supply** → the note must carry no VAT;
  - **40(10)-reversed / partly deducted** → still refused by name until the accountant answers.
- The note's VAT is capped by the stated historical VAT.
- **Not stated → refused, naming the missing fact.** This matches the platform's fail-closed posture (CLAUDE.md §3: "a named gap beats a silent default"). It is a product choice, not law.
- **Who approves it.** Whether the tenant's statement is enough evidence, and whether "not claimed" should then make the net deduction available to claim later, are accountant questions (Q2, Q5 below).

**An adjacent risk (SL, triage "hides the result").** Today a VAT-bearing note is refused while a **VAT-free** note against the same opening payable is admitted (F25).
- The easiest workaround for a user is to enter the supplier's note with VAT 0.
- That posts the whole gross amount against the expense or cost and **silently omits** the 40(6) reduction for a claimed original.
- The refusal therefore steers users toward the one entry that hides the error.

---

## 3. Questions for the accountant / tax advisor

Each can be answered yes/no or by a choice. Fold them into the existing advisor package; Q4 and Q7 are the existing CN-2 and level-vs-delta items applied to opening originals.

- **Q-OP-1 (confirm F8).** The tenant receives a supplier credit note dated after its cut-over to Saudi Ledger. The note is against a supplier tax invoice issued before cut-over, whose input VAT the tenant **deducted in full** in a return filed from its previous system. Must the tenant reduce input VAT by the note's VAT in the return for the **note's issue period** (IR 40(6)), which is a return Saudi Ledger prepares? **Yes / No.**
- **Q-OP-2.** If the tenant **never deducted** that invoice's input VAT, is there **no** return adjustment for the note? **Yes / No.** And if the tenant later deducts it (within 49(8)), is the deduction limited to the invoice's VAT **net** of the note? **Yes / No.**
- **Q-OP-3.** If the invoice's VAT was **blocked under Art. 50** (never deductible), is there **no** return adjustment, with the note's VAT reducing the cost or expense instead? **Yes / No.**
- **Q-OP-4 (CN-2 applied).** If the previous system **reversed** the deduction under 40(10) because the invoice was unpaid after 12 months, is the note's effect:
  - (a) no return entry, reducing only the reversed amount and the amount restorable later;
  - (b) a reduction of input VAT by the note's VAT; or
  - (c) something else?
- **Q-OP-5 (evidence).** To apply Q-OP-1, Q-OP-2 or Q-OP-3, is it enough that the user **states** how the original's VAT was treated (deducted in period X / not deducted / blocked / reversed under 40(10)), with that statement recorded on the note? Or must the product require supporting evidence, such as the original invoice, or the return or period in which it was deducted? **Choose: statement suffices / statement + original invoice / statement + deduction period / other.**
- **Q-OP-6 (rate and pre-VAT).**
  - (i) For a supply taxed at **5%** (supply date before 1 July 2020), is the note's VAT computed at **5%**, and is the input-tax reduction the note's stated VAT? **Yes / No.**
  - (ii) For a supply made **before 1 January 2018**, does the note carry **no VAT** and cause **no** input-tax adjustment (ZATCA transitional guideline §4.2)? **Yes / No.**
- **Q-OP-7 (partial deduction).** If only part of the invoice's VAT was deducted (a partial claim, or apportionment under Art. 51), is the note's reduction:
  - (a) the full note VAT; or
  - (b) limited so that the deduction left equals the tax on the revised consideration that remains deductible (the level reading, GCC 47(1))?
- **Q-OP-8 (pre-registration).** For a purchase made before the tenant's VAT registration:
  - if its VAT was deducted under 49(2)/(3), does Q-OP-1 apply?
  - if it was not deducted, does Q-OP-2 apply? **Yes / No for each.**

## 4. Product decisions for the owner

Each is a choice. A recommendation appears only where authority settles it.

- **OD-1. Permanent refusal vs controlled treatment.**
  - **Options:**
    - (a) keep the refusal permanently;
    - (b) replace it with a controlled treatment once Q-OP-1 and Q-OP-5 are answered;
    - (c) a controlled treatment now, restricted to the states authority settles (claimed-in-full, pre-VAT), with everything else refused by name.
  - **What authority says:** (a) is not supported for a claimed original (F3, F6–F8).
  - **What is interpretation:** the choice between (b) and (c) is a risk decision. Q-OP-1 is the accountant's confirmation of an AUTH/GUID-settled reading.
- **OD-2. Where the historical VAT position is recorded.**
  - **Options:**
    - (a) at migration: extend staging `historicalVat` for AP with a deduction state (and the invoice's VAT and rate), carried to the opening bill;
    - (b) per note, stated at the note's approval;
    - (c) both, with (a) pre-filling (b).
  - F26 shows (a) has no field today, though `historicalVat.amount` / `rate` already exist.
- **OD-3. When the position is not stated.** Refuse, naming the missing fact? **Yes / No.** Recommended yes on product posture; not law.
- **OD-4. The VAT cap for an opening original.**
  - **Options:**
    - (a) the stated historical invoice VAT (T(D) = `historicalVat.amount`, less other notes); refuse when it is not stated;
    - (b) no VAT cap.
  - IR 54(1) implies a cap exists (F18, INT on AUTH).
- **OD-5. The VAT-free asymmetry (F25).**
  - **Options:**
    - (a) leave it;
    - (b) require an explicit statement that the supplier's note carries no VAT before a VAT-free note posts against an opening payable;
    - (c) apply the same refusal to all notes against opening payables until OD-1 is decided.
  - This is a risk decision, not law. The risk is described at the end of §2(d).
- **OD-6. The refusal wording.** "Record the note outside the system" directs the user to an off-ledger VAT adjustment. Change it to name the missing fact and the next step? **Yes / No.**
- **OD-7 (engineering, once OD-1 = b/c).** How the ledger represents it. There is no CLAIMED bucket for an opening document. Options:
  - (a) a stated `recognised_claimed` / `recognised_blocked` event on the opening original, provenance `stated`, recorded at the note's date (the event admission today forbids any event on an opening payable);
  - (b) a note-level event outside the document's bucket ledger.

  This is not an accounting question.

## 5. Adjacent findings (SL; not asked, reported)

1. **A note on a pre-cut-over invoice that was already paid in full cannot be recorded at all.** No opening payable exists, and `assertPurchaseNote` requires a bill to reference. The same 40(6) duty applies (AUTH F3).
2. **The gross ceiling is the outstanding amount.** `credit_exceeds_bill` uses the opening row's `total`, which is the **outstanding** amount, not the invoice's original gross. A legitimate note covering an already-paid part of a partly-paid invoice is therefore refused.
   - IR 54(1) caps VAT by what the invoice charged, not by what is still owed.
   - This belongs with the 1C pack's partly-settled item (§16.12.5).
3. **The 0109 backfill.** It RAISES on any posted note that O-2 refuses (D-1).
   - Any database holding a VAT-bearing note posted against an opening payable before 13B-3 (F24 shows the product could write one) would stop migration 0109.
   - No database was queried; whether such rows exist is unverified.

## 6. Search shape (what was looked for; what would have falsified "SILENT")

- **Saudi texts:**
  - IR-AR 2025 consolidation: Arts. 40, 49, 50, 54, 63, 79.
  - IR-EN 8th edition: Art. 49(1)–(4).
  - GCC-AR Arts. 47, 57, 79 (79 not re-read).
  - ITD v3 AR §10.1–10.2 with Examples 28–31.
  - INV v3 AR §7.1.1.
- **The transitional guideline** «الأحكام الانتقالية» (zatca.gov.sa, 38 pp.): ToC and §4.1–4.2.
- **The rate-increase material:**
  - the slide-guide copy (`ocn/rate15-en.txt`, searched for credit, debit and note: one irrelevant hit);
  - web searches in Arabic and English for ZATCA text on notes against 5% supplies. Only secondary commentary was found; PwC's PDFs returned 403, and Deloitte's alert has no note content.
- **What would have falsified the points marked SILENT:**
  - any text conditioning 40(6) on the recording system, or on the original having been recorded by the current system;
  - any text treating a migrated or opening payable specially;
  - any example of a note after a 40(10) reversal.

  None was found.
- **Not retrieved:** the primary ZATCA 2020 rate-increase guideline text on notes; IFRS 9 3.3.1 (quoted from knowledge).
