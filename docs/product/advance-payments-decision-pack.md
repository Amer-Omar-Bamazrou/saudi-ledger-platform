# Advance payments / customer deposits — gap analysis and decision pack (2026-09-20)

**Status (2026-09-21): §1–§12 are the research and decision record (not re-argued). AP-1 (§13), AP-2 (§14 — the advance tax invoice type 386, its E2 entry, the final invoice's prepayment adjustment with the E3 entry, the ¶9.5 UBL, the return reading both) and AP-3 (§15 — the credit note against a 386 with the E5 entry, and the Batch 1B refund it unlocks) are BUILT: AP-2 on `feat/ap-2-advance-tax-invoice` (`0b00b70c`), AP-3 on `feat/ap-3-advance-credit-note-refund` on top of it; both pushed, neither merged; AP-4 (§16 — the compliance validation) RUN on `feat/ap-4-advance-compliance` on top of AP-3. 🔴 A1, A2 and A3 are RESOLVED by the accountant (2026-09-21; §8 carries the answers verbatim); Z1 stays OPEN with ZATCA. 🔴 **AP-4 SANDBOX VALIDATION: PASSED 2026-09-21** — the 386, the 388 with its prepayment adjustment and the 381 against the 386, built from real ledger rows, all `PASS` / `CLEARED` at `POST /compliance/invoices` with zero warnings, on an instrument shown to flag every prepayment rule it was fed (§16). What that does NOT cover: simulation and production (M12.7/M12.9 — behind the Saudi entity, for every document type), and the VAT-period question that stays with the accountant (§16.5).** The Batch 1B payment core that this pack builds on is IMPLEMENTED and merged (`main` `a290d079`; record: known-issues file, "BATCH 1B — CLOSED 2026-09-17"). The live exposure AP-1 made visible and AP-2 closes at the document is recorded where a future session will look: known-issues file, "ADVANCE VAT UNDER-DECLARATION". Current state authority: [CLAUDE.md §2](../../CLAUDE.md).

**Protocol.** Written under [`docs/accounting-escalation-protocol.md`](../accounting-escalation-protocol.md): Saudi Ledger inspected first (file paths cited), Odoo and ERPNext inspected from SOURCE (sparse clones at today's heads — Odoo `c55c82d`, ERPNext `db6e089`, both 2026-09-19 — every claim cites a path and line), primary Saudi texts read, every conclusion classified with exactly one of `AUTHORITATIVE REQUIREMENT` · `ESTABLISHED ACCOUNTING PRACTICE` · `ODOO IMPLEMENTATION` · `ERPNEXT IMPLEMENTATION` · `SAUDI LEDGER PRODUCT DECISION` · `ACCOUNTANT DECISION REQUIRED`. Where earlier research already settled a point it is REUSED and cited, not reopened.

**Reads first, settled and not re-argued here:** [`batch-1b-decision-pack.md`](batch-1b-decision-pack.md) §1 (the three credit positions, Model C, the journals), §2 (refunds by origin), §4 (the three identities); [`batch-1c-migration-opening-balances-decision-pack.md`](batch-1c-migration-opening-balances-decision-pack.md) §15.2 D (historical advances: VERIFIED, the two facts that matter) and §16.14.9 (the ZATCA enquiry, item 2); [`design-per-bank-cash.md`](design-per-bank-cash.md) (no cash line without a bank).

---

## 0. The verdict in one screen

| | |
| --- | --- |
| **Accounting side (cash → deposit liability → allocation → AR → statement → ageing → refund → correction → locked periods → migrated advances)** | **BUILT and correct** in Batch 1B/1C. Nothing in it needs to change; §2 lists what must NOT be touched. |
| **VAT side (the tax point at receipt; the advance tax invoice; the VAT return; the refund's credit note)** | **NOT BUILT.** The platform records the cash correctly and files NOTHING for it: a taxable advance received in January is under-declared in January's return, and the platform has no document to declare it with. This is the LEGAL exposure the ERPNext comparison ranked (findings file, "Advance payments — a VAT tax point we cannot represent"), still open. |
| **ZATCA side (Invoice Type Code 386; the final invoice's prepayment adjustment — `PrepaidAmount` BT-113, KSA-30…34; the credit note on refund)** | **NOT BUILT.** The UBL builder emits 388/381/383 only; `PrepaidAmount` is wired to `invoices.paid_amount` (always 0.00 at issuance today, and the wrong fact if it were ever non-zero). |
| **Blocking decisions** | **Three for the accountant, bundled as one list (§8); one already with ZATCA (§8, Z1).** Everything else is a `SAUDI LEDGER PRODUCT DECISION` stated here and proceeded with. |
| **Proposed build** | Four phases (§9): AP-1 classification + the VAT-return exception list (no accounting change, no decision needed); AP-2 the advance tax invoice (type 386) — after the accountant answers; AP-3 the final invoice's prepayment adjustment + the refund precondition; AP-4 the UI walk and the sandbox compliance pass. |

---

## 1. Current state — what Saudi Ledger does today, with file paths

### 1.1 The cash and the liability

- **A receipt is a `payments` row with a posted journal entry** (`packages/db/src/schema/payments.ts` L129–195: `journal_entry_id NOT NULL`, append-only for the app role, `amount > 0`, `direction ∈ {in, out}`, `source ∈ {manual, invoice_pay, settlement, opening}`). The three identities — bank, payment, allocation — are kept apart by construction (the file header, L105–128).
- **`paymentsService.receive`** (`apps/api/src/services/payments.service.ts` L329–417): Dr *bank leaf* / Cr *AR(customer)* for the allocated part / Cr *`CUSTOMER_DEPOSITS`(customer)* for the rest, one entry, N allocations; the allocation list is optional (none ⇒ the whole amount is a deposit); `allocated > amount` is refused with `allocation_exceeds_payment` (L350–352); an unapplied amount with no customer is refused with `customer_required_for_unapplied` (L361–367) — a deposit is owed TO someone.
- **Where the liability lives** is one map: `apps/api/src/services/accounting/customerCreditPolicy.ts` — `deposit → CUSTOMER_DEPOSITS`, `credit_note → CUSTOMER_CREDITS`; the file states that VAT is deliberately NOT decided there ("the advance tax invoice is a document the user issues (Part 2 surfaces the exception list)"). Both accounts are seeded current liabilities (`packages/db/src/chartOfAccounts.ts` L165).
- **Party on the line:** every control-account line carries the customer (`partyOf`, payments.service L306–308), so a customer's deposit balance is a GL fact — Σ its `CUSTOMER_DEPOSITS` lines — and the ledger invariant `deposits_gl_vs_subledger` (`apps/api/src/scripts/ledgerInvariants.ts` L82–90) proves GL = subledger per customer.

### 1.2 Allocation, partial, multiple, over-payment

- **Later allocation** — `allocate` (L420–473): Dr `CUSTOMER_DEPOSITS`(customer) / Cr AR(customer), its own entry `ALLOC-<id>` **dated `businessToday()`** (L449), under the payment's row lock; `requested > available` refused (L439–441).
- **`lockAndCheckTargets`** (L211–290) is the one validator every allocation passes: the target exists in this tenant, is not a note, is in the books (`isReceivableInBooks` from `@workspace/shared` — an opening receivable qualifies, Batch 1C Issue 1), belongs to the paying customer (`allocation_party_mismatch`), and has the outstanding (`total − paid − credited`); one ACTIVE allocation per (source, invoice) (L219–231).
- **Partial** = an allocation below the outstanding; **several invoices** = several allocations from one payment (tested: `tests/d4-payment-core.test.ts` L235); **several advances against one invoice** = several sources each with its own active allocation to the same invoice (allowed by construction: the uniqueness is per (source, invoice) — L219–231; tested for receipts-with-allocation at L219, NOT yet for two deposits allocated later — §10).
- **Over-payment** — the API never refuses a receipt for exceeding the invoice; it refuses an ALLOCATION beyond the outstanding, so 6,000 against a 5,000 invoice is one receipt, one 5,000 allocation and a 1,000 deposit with the receipt as its origin (tested L305). 🔴 The **Invoices page's "Mark Paid"** refuses `paid > outstanding` (`apps/api/src/services/invoices.service.ts` L491–496) and the **"Record receipt on account" dialog sends `allocations: []`** (`apps/web/src/components/payments/ReceiveDialog.tsx` L50) — so in the UI an over-payment is TWO acts (record on account, then allocate), never one. Correct, and a usability gap (§3, G-UI-1).

### 1.3 Corrections, refunds, locked periods

- **Unallocation** — `unallocate` (L562–664): a superseding `payment_allocation_reversals` row (UNIQUE per allocation — one correction, concurrent attempts serialise) with its own entry `UNALLOC-<id>` dated today, Dr AR / Cr the origin's liability; the original allocation is never edited; a credit note's settlement of its own original is immutable (L590–604).
- **Refund** — `refund` (L682–773): settles a NAMED source (a receipt's unapplied remainder, or an issued note's unconsumed balance), Dr the origin's liability / Cr the bank leaf, reason required, `refund_exceeds_balance` guarded; **no VAT is posted or altered**, and the comment at L671–681 names the exact place a credit-note precondition goes "when advance invoices exist".
- **Locked periods** — every entry goes through `postJournalEntry`, which enforces the period lock (`apps/api/src/services/accounting/glPosting.ts` L360): a receipt or refund dated into a closed month is refused with the structured 423 (tested: `d4-payment-core.test.ts` L476; `d4-corrections-refunds.test.ts` L260, L380); an allocation or correction is dated today, so a closed month is never re-dated into.
- **Permissions** — `payments: { read: READ_ALL, create: APPROVE, approve: APPROVE }` (`packages/db/src/permissions.ts` L105–109); `allocate`/`apply`/`unallocate` resolve to `approve` (`apps/api/src/lib/rbac.ts` L58); `POST /payments/refunds` resolves to `create`, which is the same approver set. RLS `tenant_isolation` on all four tables (migrations 0074 L125–140, 0075 L65–80); company scope in the query layer (`customerStatement.repository.ts` L35).

### 1.4 What the customer sees

- **Position** — ONE definition (`apps/api/src/repositories/customerStatement.repository.ts` L1–25, `positions` L78–…): `receivable ≥ 0`, `creditBalance ≥ 0`, `depositBalance ≥ 0`, `netPosition` derived; never a negative receivable.
- **Statement** — eight event kinds incl. `receipt`, `allocation`, `unallocation`, `refund` (L47), three running balances, `reconciled` verdict; **AR ageing** shows `liabilities.customerDeposits` beside the buckets, never folded in (`reports.service.ts` `arAging`; tested `d4-customer-statement.test.ts` L361).
- **UI** — `/payments`, the customer page's position tiles and Payments section (allocate / unallocate / refund deposit), `/customers/:id/statement`, `/ar-aging` (record: known-issues file, "BATCH 1B — CLOSED", Phase F). Walked by clicking in EN/AR × desktop/phone.

### 1.5 Migrated advances (Batch 1C)

- Staged as `migration_advances` with `vat_position ∈ {invoiced, unknown}`, the old advance-invoice number/date/time and `vat_category`/`vat_rate`/`vat_amount` (`packages/db/src/schema/migration.ts` L311–326; `invoiced` requires the number by CHECK).
- Committed as `payments` rows with `source = 'opening'`, each a deposit line of the opening journal (`apps/api/src/services/migrationCommit.service.ts` L287–304); R10 asserts every advance has a VAT position (L470). Policy C: a reversed migrated deposit is history — never allocated or refunded (`assertDepositNotReversed`, payments.service L144–153).
- 🔴 **The stored advance-invoice reference has NO reader.** Nothing computes a `PrepaidAmount` adjustment from it (by design until the ZATCA answer — 1C pack §15.2 D), and nothing in the invoice path can consume it today (§3, G-Z-4).

### 1.6 What the VAT and ZATCA paths do with a deposit: nothing

- **VAT return** (`apps/api/src/services/reports.service.ts` `vatReturn` L726–…): reads `invoices` and `bills` by line `tax_category_code`; `payments` are not read; no exception list, no "unclassified receipts" figure. Search shape: `grep -rni "unapplied|deposit|unclassified|advance" apps/api/src/services/vat*.ts apps/api/src/services/reports.service.ts apps/web/src/pages/VatReturn.tsx` → nothing relevant.
- **E-invoice type codes**: `TYPE_CODE = { invoice: "388", debit_note: "383", credit_note: "381" }` (`apps/api/src/services/einvoice/ubl/buildInvoiceXml.ts` L47) — **no 386**.
- **`PrepaidAmount`** — `einvoiceInput.assembler.ts` L348–349: `prepaidAmount: money(invoice.paidAmount)`, `payableAmount: total − paidAmount`. At issuance `paid_amount` is always 0 (`invoices.service.pay` refuses a draft/submitted invoice, L460–462, and the document is built at approval), so the field is `0.00` on every document ever built — **vacuous today, and wrong-by-construction if it were ever non-zero**: Guideline §8(c) says BT-113 "should be populated ONLY if the taxpayer has issued a separate invoice at the time of receiving payment in advance and not otherwise" — it is the ADVANCE-INVOICED amount, never the cash received. Recorded as G-Z-1.
- **Validation rules shipped in the SDK** (`docs/zatca/sdk/…/20210819_ZATCA_E-invoice_Validation_Rules.xsl`, 85 `BR-KSA-*` ids, dated 2021-08-19) contain **no prepayment rule and no sample with 386 / KSA-30…34** (search shape: `grep -in "prepaid|prepayment|386|KSA-3[0-4]"` → only the generic amount-format template at L2600/L2857). The 386 mechanism post-dates the shipped rules; only the live compliance endpoint can validate it (CLAUDE.md §4, trust order).
- **A related open hole, not new:** `POST /journal-entries/:id/reverse` (`journalEntries.service.ts` L289–…) reverses ANY posted entry, including `RCPT-`/`ALLOC-`/`UNALLOC-`/`REFUND-` entries, leaving the payment subledger contradicting the GL ("journal reversal bypasses the posting seam" — known-issues file, pilot runbook item 2, still open; the invariant sweep would catch it after the fact). Composes with everything below; not reopened here.

---

## 2. What already satisfies the accountant, and MUST NOT change

`ESTABLISHED ACCOUNTING PRACTICE` unless marked; each was accountant-confirmed for Batch 1B (1B pack, "Settled by the accountant").

1. **An unapplied receipt is a customer-deposit LIABILITY, never a credit inside AR** (IFRS 15.106 contract liability; `customerCreditPolicy.ts`). Keep.
2. **Two liability accounts by origin** (`CUSTOMER_DEPOSITS` contract liability; `CUSTOMER_CREDITS` refund liability) — the accountant may still merge them; the change is in ONE file. Keep.
3. **Allocation is an explicit, dated, human act; never inferred** (CLAUDE.md §9). Keep — and the advance tax invoice must not become a back door to automatic allocation (§5, step 5).
4. **A refund settles the existing credit from a NAMED source; it never reverses the receipt** (1B pack §2). Keep; AP-3 only ADDS a precondition.
5. **Corrections are superseding records; nothing is edited or deleted** (Phase A). Keep.
6. **No cash line without a bank** (D-3). Keep.
7. **A migrated advance carries the VAT position the previous system gave it; migration triggers no VAT** (1C pack §15.2 D — `AUTHORITATIVE REQUIREMENT`, accountant-confirmed A1). Keep.
8. **Documents FILE; transactions RECONCILE** (CLAUDE.md §4). The VAT return will read a DOCUMENT for an advance (the advance tax invoice), never the receipt — which is exactly why the deposit itself must stay VAT-silent (§4).
9. **The three-component position and its derived net; the ageing excludes liabilities** (Phase E). Keep.

---

## 3. Gaps — complete, incomplete, missing

Frame: the lifecycle in §5, walked leg by leg against the code in §1. "Works" = built, tested, walked; "incomplete" = built but a leg is missing; "missing" = no writer, no reader.

### 3.1 Works (no change proposed)

| Leg | Evidence |
| --- | --- |
| Customer payment → bank account → unapplied receipt → deposit liability | `receive` L329–417; tests L257, L277; walked (1B Phase F) |
| Invoice created → allocate deposit → AR reduced | `allocate` L420–473; test L282; walked |
| Partial allocation; one receipt across several invoices | tests L199, L235; e2e "reallocate 200 + 100 across two invoices" |
| Over-payment → the excess is a deposit with its origin | test L305 |
| Unallocation as a superseding record; re-allocation to the same invoice | `d4-corrections-refunds.test.ts` L155–233 |
| Refund of a deposit (partial then full), from the named receipt | L313; e2e refund flow |
| Closed month: receipt/refund refused 423; allocation/correction dated today | L476; L260, L380 |
| Statement, position, ageing with the deposit shown apart | `d4-customer-statement.test.ts` L219–361 |
| Migrated advances as opening deposits, Policy C reversal | 1C §16.12; `batch-1c-opening-receivable-collection.test.ts` |
| Isolation (org and company), permissions, append-only, idempotency | L420–476 |

### 3.2 Incomplete

| # | Gap | Where | Why it matters |
| --- | --- | --- | --- |
| **G-UI-1** | An over-payment cannot be recorded in ONE act from the UI (Mark Paid refuses > outstanding; the on-account dialog takes no allocations) | `invoices.service.ts` L491–496; `ReceiveDialog.tsx` L50 | Usability only — the API supports it (`receive` with allocations); the walk found the two-step path works. |
| **G-ACC-1** | A deposit has no **classification**: *advance for a taxable supply* / *erroneous or duplicate payment* / *refundable security deposit* / *unknown*. `payments` carries `method` and `reference` only | `schema/payments.ts` L129–195 | Without it the platform cannot tell which deposits owe an advance tax invoice (§4) — the one fact the VAT timing rule needs. 1B pack §1.6 designed it ("push A toward B … within the tax period"); Part 2 never built it. |
| **G-TEST-1** | Two deposits allocated LATER to one invoice is untested (mechanism allows it) | `d4-payment-core.test.ts` | Breadth is seeded, never hoped for (CLAUDE.md §3). |
| **G-ACC-2** | The allocation entry is dated at the CLICK (`businessToday()`), never at the invoice date | `allocate` L449 | A deposit allocated on 5 Nov to an invoice issued 10 Oct leaves October's balance sheet showing both the gross receivable and the deposit. Balances net the same; presentation differs. Non-blocking policy point — §8, A3 (low). |

### 3.3 Missing

| # | Gap | Consequence today | Authority |
| --- | --- | --- | --- |
| **G-VAT-1** | **No advance tax invoice document.** No `document_type` for it (`invoice`/`credit_note`/`debit_note` only), no approval path, no ICV/hash/QR/outbox for it | A taxable advance received in period P is not in P's return: box 1/6 understated; the tax invoice Art. 53(1)(a)(2) requires is never issued | `AUTHORITATIVE REQUIREMENT` — §4 |
| **G-VAT-2** | **The VAT return reads no deposit.** No "unclassified / un-invoiced receipts" exception figure on the return page (designed 1B pack §1.4, §10 READY; not built) | The under-declaration is INVISIBLE — the composition that turns a wrong record into an unnoticed one (CLAUDE.md §3 triage, item 3) | `SAUDI LEDGER PRODUCT DECISION` (a reader, no posting) |
| **G-VAT-3** | **No VAT posting when an advance is invoiced** (Cr `VAT_OUTPUT` for the advance's VAT) and **no net-of-advance VAT on the final invoice** | The GL's output VAT cannot equal the return's (documents file) once advances exist | `AUTHORITATIVE REQUIREMENT` (timing) + `ACCOUNTANT DECISION REQUIRED` (the entry's shape — §8, A2) |
| **G-Z-1** | **`PrepaidAmount` wired to `paid_amount`** (vacuous today; wrong fact) | Latent: the first document built after any path that sets `paid_amount` before issuance would carry a false BT-113 | Guideline §8(c) |
| **G-Z-2** | **No Invoice Type Code 386**, no prepayment-adjustment line (KSA-30…34, `DocumentReference` to the advance invoice), no `PayableAmount = TaxInclusive − Prepaid` computed from advance invoices | The final invoice cannot be issued net of the advance per the standard; the Resolution's fields 7.13–7.15 / 8.7 stay unpopulated | Resolution Annex 2 fields 7.13–7.15, 8.7, 8.9; Guideline §8(b)(c) |
| **G-Z-3** | **Refund of a tax-invoiced advance has no credit-note precondition** (the hook location is named in `refund`, L671–681) | Once advance invoices exist, a refund would return cash while the advance invoice's VAT stays declared | IR Art. 40(1)(a), 54(1); Guideline §8(g) |
| **G-Z-4** | **Migrated advances' old advance-invoice references have no reader** | A final invoice against a migrated `invoiced` deposit cannot adjust; the platform must REFUSE rather than guess until ZATCA answers | 1C §15.2 D; ZATCA enquiry item 2 (§8, Z1) |
| **G-VAT-4** | **B2C advances**: a receipt with no identified customer cannot be a deposit (`customer_required_for_unapplied`), so a B2C advance is unrepresentable; IR Art. 53(7)(a)(2)+(b) requires a SIMPLIFIED tax invoice at receipt for it | Out of scope for this pack (the deposit model is party-based by design); recorded so the absence is not mistaken for coverage | `AUTHORITATIVE REQUIREMENT` |
| **G-AP-1** | **Supplier advances (AP side)** — no `SUPPLIER_ADVANCES` account or path (search shape: `grep -rn SUPPLIER_ADVANCES packages apps` → none) | Out of scope here; the mirror image of this pack, after it | — |

---

## 4. Saudi VAT treatment — verified from primary texts, layered

Sources read for this pack (all primary unless marked): **S1** GCC Common VAT Agreement, ZATCA-hosted PDF (`zatca.gov.sa/ar/RulesRegulations/Taxes/Documents/GCC VAT Agreement.pdf`, downloaded 2026-09-20, unofficial translation — Arabic prevails), Art. 23. **S2** KSA VAT Implementing Regulations, 8th ed., the repo's text copy (`docs/zatca/specs/KSA_VAT_Implementing_Regulations_EN.txt`): Art. 20 (L532–572), Art. 53(1) (L1731–1752), Art. 53(7) (L1782–1800); Art. 40 and Art. 54 as read for Batch 1B (S1 there). **S3** E-Invoicing Implementation Resolution (2023-05-19), the repo's text copy, Annex 2 fields 7.13–7.15, 8.7, 8.9 (L921–931, L962–981). **S4** ZATCA *Detailed Guideline* Version 2, §8 "Advance Payments" pp. 39–42 (downloaded 2026-09-20 from the URL in `docs/zatca/fetch-specs.sh`; quoted below). **S5** IFRS 15 ¶47, ¶105–106 (standard as issued; reused from 1B). The 1B pack's S2 was a SECONDARY quote of the Agreement (ClearTax); **it is now confirmed against the primary text** — the reading stands.

### 4.1 Accounting treatment — `ESTABLISHED ACCOUNTING PRACTICE` (settled)

A receipt before performance is a **contract liability** (IFRS 15.106), measured at the consideration the entity expects to be entitled to, which **excludes amounts collected on behalf of third parties** (IFRS 15.47) — the VAT in an advance is a VAT payable, not part of the contract liability. Performance (the supply, in practice the final invoice) derecognises the liability against the receivable/revenue. Saudi Ledger already holds the deposit as a liability; what is missing is only the VAT split once the advance is invoiced (§6).

### 4.2 VAT treatment — `AUTHORITATIVE REQUIREMENT`

| Text | As read | Establishes |
| --- | --- | --- |
| **Agreement Art. 23(1)** (S1, verbatim): "Tax becomes due on the date of the supply of Goods or Services, the date of issuance of the tax invoice or upon partial or full receipt of the Consideration, whichever comes first, and to the extent of the received amount." | The receipt of consideration is a TAX POINT, to the extent received. | VAT on a taxable advance is due in the period of RECEIPT, on the amount received (VAT-inclusive: 1,150 received ⇒ 1,000 + 150). |
| **Art. 23(3)**: for supplies "of a repetitive nature", tax is due on the payment date specified in the invoice or the actual payment date, whichever first, at least once in 12 months; **IR Art. 20(1)–(2)** mirrors it for continuous supplies ("to the extent of the amount invoiced or paid"). | Instalment and continuous contracts follow the same earlier-of rule per instalment. | No separate mechanism: each instalment received before its supply is an advance. |
| **IR Art. 53(1)(a)(2)**: a Tax Invoice must be issued "where the Taxable Person receives Consideration in respect of and prior to making a Taxable Supply"; **(1)(b)**: no later than the 15th of the month following the month "in which the Supply took place". | The advance itself requires a TAX INVOICE. Read with Art. 23(1), the deemed supply date for the advance is the receipt, so the window closes on the 15th of the month after receipt. | The advance tax invoice is a legal obligation of the SUPPLIER; the platform's job is to make issuing it possible and its absence visible (§5, §7). |
| **IR Art. 53(7)(a)(2)+(b)** (added 2021): the same for a SIMPLIFIED tax invoice (B2C), "on the earliest of the date of the supply and the date of receipt of Consideration". | B2C advances are tax points too. | G-VAT-4 (out of scope here, recorded). |
| **IR Art. 40(1)(a), 54(1)** (1B pack): a credit note where the supply is cancelled after tax was charged; **Art. 40(5)**: the output-tax decrease taken in the later of the event's period and the note's period. | Refunding a tax-invoiced advance is a cancellation: a credit note referencing the advance invoice is required. | The refund precondition (G-Z-3). |
| **No text located** on a *refundable security deposit* that is not consideration (re-checked: the IR has no deposit article; the Agreement's Art. 23 speaks only of Consideration). | Whether such a deposit is "Consideration" is a fact question per contract. | `ACCOUNTANT DECISION REQUIRED` (A1). |

### 4.3 ZATCA / e-invoicing — `AUTHORITATIVE REQUIREMENT`

Guideline v2 §8 (S4), quoted: "receipt of payment in advance towards taxable supplies necessitates issuance of a tax Invoice" (§8.1). **(a)** the advance invoice "must have Invoice Type Code (BT-3) as a fixed value '386'"; the subsequent invoice(s) "should have Invoice Type Code '388'". **(b)** the subsequent invoice references the prepayment invoice by IRN (BT-1), issue date (BT-2), issue time (KSA-25), UUID (KSA-1, "currently optional but it shall be mandated in future"), and an invoice-line document reference with "Prepayment Document Type Code (KSA-30)" = 386. **(c)** `<cbc:PrepaidAmount>` (BT-113) "as the Amount inclusive of VAT … populated only if the taxpayer has issued a separate invoice at the time of receiving payment in advance and not otherwise"; once populated, ONE consolidated adjustment line per VAT category and rate: KSA-31 taxable amount, KSA-32 tax amount, KSA-33 category code, KSA-34 rate ("may also be 5%" for pre-2020 advances). **(d)** real-time checks: KSA-32 = KSA-31 × KSA-34 / 100; BT-113 = Σ(KSA-31 + KSA-32); "no real-time cross-check between data of Advance Payment Invoice that is adjusted from subsequent invoices" — backend analytics may audit. **(e)** two-decimal rounding on BT-113, KSA-31, KSA-32. **(g)** if the advance exceeds the final invoice, BT-113 may carry the full advance (negative Amount Due) or be limited to the invoice; "if the full value … has to be refunded back to the customer, then a Credit Note … has to be issued. Such Credit Note should also be sent for Clearance / Reporting." **(h)** UBL usage is in "paragraph 9.5 of the XML Implementation Standard" — 🔴 **not in the repo's spec set; must be fetched and read before AP-2 is built** (CLAUDE.md §3, "read the primary text"). The Resolution's Annex 2 (S3) carries the same fields as conditional-mandatory: 7.13–7.15 ("Required, if populated … To be filled only if prepayment is used"), 8.7 "Advanced payment adjustment amount (inclusive of VAT) — Adjustment towards Advanced payment on which VAT is charged by a separate invoice", 8.9 Amount due for payment (mandatory when 7.13 or 8.7 is used).

**What this fixes for the design, without any decision:** the advance tax invoice is a REAL tax invoice (its own IRN/ICV, hash chain, QR, clearance/reporting) with type 386; the final invoice is a 388 whose XML shows the FULL supply lines plus consolidated prepayment adjustment lines and `PrepaidAmount`, and whose `PayableAmount` is net; the VAT the final invoice adds to the return is the invoice's tax MINUS the adjusted advance tax (Art. 23(1) "to the extent"); refunding an invoiced advance needs a cleared/reported credit note.

### 4.4 Saudi Ledger product behaviour today, against the above

| Requirement | Today |
| --- | --- |
| Tax point at receipt, to the extent received | Recorded as a liability, declared NOWHERE (G-VAT-1/2/3) |
| Advance tax invoice, type 386, by the 15th of the next month | No document; no reminder; no exception list |
| Final invoice net of the advance; prepayment adjustment lines | No fields; `PrepaidAmount` mis-wired (G-Z-1/2) |
| Credit note before refunding an invoiced advance | No advance invoices exist, so none is owed; the hook is named (G-Z-3) |
| Migrated advance: old reference stored, adjustment refused until ZATCA answers | Stored; nothing reads it; nothing can be built against it (G-Z-4) — consistent with fail-closed |

### 4.5 Unresolved accountant / ZATCA questions — the honest list

Only three reach the accountant (§8); one is already with ZATCA. Everything else above is settled by the texts.

---

## 5. The complete intended lifecycle

Legend: **[B]** built and unchanged · **[AP-n]** proposed phase · **[A-n]** waits on accountant answer n.

```
1. Customer pays  ─►  2. Bank account (leaf)  ─►  3. Receipt with zero/partial allocation     [B]
                                                      Dr Bank / Cr Customer deposits(customer)
        │
        ▼
4. CLASSIFY the deposit (user act; default UNKNOWN)                                            [AP-1]
   advance for a taxable supply (S / Z / E category chosen) · erroneous or duplicate payment
   · refundable security deposit · unknown
   ─ the VAT-return page lists every deposit older than its period that is UNKNOWN or
     ADVANCE-NOT-YET-INVOICED, with the 15th-of-next-month deadline                            [AP-1]
        │
        ├─ erroneous / security deposit ──► stays a VAT-silent deposit; refund or allocate   [B]  [A-1]
        │
        ▼ advance for a taxable supply
5. ISSUE the ADVANCE TAX INVOICE (type 386) for the deposit, in whole or in part            [AP-2] [A-2]
   a document the user creates and approves (approval engine, ICV, hash, QR, outbox);
   its lines: the prepayment per VAT category/rate; it consumes NO revenue;
   GL (proposed, §6): Dr Customer deposits(customer) [VAT part] / Cr VAT_OUTPUT
   ─ the deposit now reads: net contract liability + declared output VAT
   ─ the advance invoice is NOT a receivable (the cash already arrived) — see §6 and A-2
        │
        ▼
6. The supply happens; the FINAL INVOICE (388) is created                                     [AP-3]
   the user SELECTS which advance invoice(s) of this customer it adjusts (human act);
   the document stores the adjustment: per category KSA-31/32/33/34 and BT-113;
   XML: full lines + consolidated prepayment adjustment lines + PrepaidAmount + net Payable
   GL at approval (proposed, §6): Dr AR(customer) [net payable] · Dr Customer deposits(customer)
   [net advance] / Cr Revenue [full] · Cr VAT_OUTPUT [full − advance VAT]
   ─ one allocation row (source = the advance's receipt, target = this invoice,
     journal_entry_id NULL: folded into the issue entry, exactly as "allocated at receipt")
   ─ the VAT return adds this invoice's VAT NET of the adjusted advance VAT
        │
        ▼
7. AR reduced; remaining balance collected by any D-4 path                                    [B]
   partial: the advance covers part; several advances: several 386 references (many-to-one,
   Guideline §8(h)); over-advance: BT-113 limited to the invoice (§8(g), option 2) and the
   remainder stays a deposit on the receipt — OR the full advance with a credit note (§8(g))
        │
        ├─ 8. Refund of an INVOICED advance ──► credit note (381) referencing the 386,      [AP-3]
        │     cleared/reported, THEN the D-4 refund (Dr deposits / Cr bank)                  [B]
        ├─ 9. Unallocation / correction ──► superseding record as today;                    [B]
        │     an allocation folded into a 388's issue entry is corrected by a credit note
        │     on that invoice (the tax document's own effect — the Phase A rule)
        ├─ 10. Locked periods ──► the 386 and 388 are dated documents under the period lock; [B]
        │     an advance received in a closed month is invoiced in the open one (Art. 53(1)(b)
        │     timing is the supplier's duty; the platform shows the deadline, never re-dates)
        └─ 11. Migrated advance (vat_position = invoiced) ──► step 6 references the OLD       [AP-3, Z1]
              advance invoice by number/date/time; REFUSED with the ZATCA item open
              (vat_position = unknown ──► never adjustable; a fresh 386 is a NEW tax point)
12. Statement and ageing: the advance invoice appears as an event that moves NOTHING in the
    three components (a VAT reclassification inside the deposit); the final invoice as today   [AP-3]
```

---

## 6. Accounting entries (SAR; VAT 15%; the customer pays what the invoice says)

Accounts: *Bank — Riyad Main* (leaf); *AR*; *Customer deposits and advances* (`CUSTOMER_DEPOSITS`); *VAT Payable* (`VAT_OUTPUT`); *Revenue*. Every line carries the customer party.

**E1 — receipt on account 11,500 [B].** `Dr Bank 11,500 / Cr Customer deposits 11,500`.

**E2 — advance tax invoice 386 for 10,000 + 1,500 [AP-2, A-2].** `Dr Customer deposits 1,500 / Cr VAT_OUTPUT 1,500`. Deposit now 10,000 (net contract liability, IFRS 15.47) + VAT declared 1,500. No AR, no revenue. The receipt's `unappliedAmount` stays 11,500 for allocation purposes (the cash is all still the customer's until performance); the invoiced-but-not-adjusted advance is a separate figure on the receipt.

**E3 — final invoice 388: supply 30,000 + 4,500, adjusting the 11,500 advance [AP-3].**
```
Dr AR — Customer                        23,000.00     (34,500 − 11,500 = Amount due, BT-115)
Dr Customer deposits and advances       10,000.00     (the net advance released on performance)
    Cr Revenue                                         30,000.00
    Cr VAT Payable                                      3,000.00   (4,500 − 1,500 already declared)
```
XML: lines 30,000 / tax 4,500 (full), one prepayment adjustment line (KSA-31 10,000, KSA-32 1,500, S, 15), `PrepaidAmount` 11,500, `PayableAmount` 23,000. Return: **box 1 +20,000, box 6 +3,000** in this period (10,000 + 1,500 were in E2's period — Art. 23(1) "to the extent of the received amount": the 388 files NET of the adjusted advance per category, which is what KSA-31/32 exist for; 🔴 the 2026-09-20 draft of this line read "box 1 +30,000", inconsistent with its own box 6 and with the GL entry above — corrected at the AP-2 build, §14.1). Allocation row: receipt → this invoice, 11,500, folded.

**E3′ — the same, gross-then-allocate shape (the alternative the accountant may prefer, A-2):** `Dr AR 34,500 / Cr Revenue 30,000 / Cr VAT 4,500`, then the allocation `Dr Customer deposits 10,000 · Dr VAT Payable 1,500 / Cr AR 11,500`. Same balances, two entries, the VAT reversal sitting in the allocation. Recommended engineering default: **E3** (one writer, one document, matches what the XML says and what Odoo posts — §7); the difference is which entry carries the 1,500, not the balances.

**E4 — over-advance: final invoice 9,200 (8,000 + 1,200) against the 11,500 advance [AP-3].** Option (§8(g) 2): BT-113 limited to 9,200 → `Dr Customer deposits 8,000 / Cr Revenue 8,000` and `Cr VAT 0` after adjustment of 1,200 (the invoice's own 1,200 − adjusted 1,200); 2,300 stays on the receipt as a deposit, of which 300 is declared VAT awaiting its supply or a credit note. Option 1 (full 11,500, negative Amount Due −2,300) requires the credit note of §8(g) — offered only together with it.

**E5 — refund of an invoiced, unadjusted advance [AP-3 then B].** Credit note 381 referencing the 386: `Dr VAT Payable 1,500 / Cr Customer deposits 1,500` (the VAT returns to the deposit — the note's own entry; Art. 40(5) period rule), then the D-4 refund `Dr Customer deposits 11,500 / Cr Bank 11,500`.

**E6 — erroneous overpayment refunded [B].** `Dr Customer deposits / Cr Bank`; no document (1B pack §2.1 B) — subject to A-1.

**E7 — migrated advance, vat_position = invoiced (old 386 of 11,500) [1C, B].** At cutover: inside the opening journal, `Cr Customer deposits 11,500` (the old system already declared the 1,500). At the final invoice: the E3 shape, referencing the OLD invoice — refused until Z1 is answered.

---

## 7. Edge cases, with the treatment and its class

| Case | Treatment | Class |
| --- | --- | --- |
| Partial advance (30% up front) | E1 → E2 for 30% → E3 adjusting it; the 70% is AR | AUTHORITATIVE (Art. 23(1) "to the extent") |
| Several invoices settled from one advance | Each 388 adjusts a PART of the same 386 (several lines referencing the same IRN); Σ adjustments ≤ the 386's total, enforced at the write boundary | Guideline §8(h) "one-to-one and many-to-one" covers advances→one invoice; one advance→many invoices is not illustrated — 🔴 read XML Standard ¶9.5 before assuming; refuse if unsupported |
| Several advances against one invoice | Several adjustment lines, one per 386 (many-to-one) | Guideline §8(h) |
| Advance exceeds the invoice | §8(g): limit BT-113 to the invoice (default) or full + credit note | AUTHORITATIVE (both valid) — product default: limit |
| Advance received, supply cancelled | Credit note on the 386, then refund (E5) | AUTHORITATIVE (Art. 40(1)(a), 54; §8(g)) |
| Advance received, VAT rate changes before supply | KSA-34 carries the advance's rate ("may also be 5%") | AUTHORITATIVE (§8(c)) |
| Advance for a mixed S/Z supply | The 386 carries one line per category; the user states the split | AUTHORITATIVE (§8(c) "per VAT Category and per rate") |
| Deposit never classified by period end | Listed on the return page's exception list; nothing posts; the platform never decides tax | SAUDI LEDGER PRODUCT DECISION (1B pack §1.4) |
| Erroneous / duplicate payment | VAT-silent; refund or allocate | ACCOUNTANT (A-1); default: no VAT until applied |
| Refundable security deposit | VAT-silent pending A-1; **no KSA text located** | ACCOUNTANT (A-1) |
| Unallocation of an advance applied at issue (folded into the 388) | Not unallocatable — corrected by a credit note on the 388 (the Phase A immutability rule, L590–604) | SAUDI LEDGER PRODUCT DECISION (existing) |
| Advance received in a closed month | The 386 is dated in the open month; the deadline (15th of the next month) is shown; late issuance is the supplier's compliance fact, recorded, never hidden | SAUDI LEDGER PRODUCT DECISION |
| Migrated advance `unknown` | Never adjustable; a new 386 from Saudi Ledger is a NEW tax point (double declaration risk) — refused with the reason | 1C §15.2 D (fail-closed) |
| Migrated advance `invoiced` | Adjustable only after Z1; until then refused with the ZATCA item named | 1C §16.14.9 |
| B2C advance (no customer) | Unrepresentable today (G-VAT-4); out of scope | AUTHORITATIVE (Art. 53(7)) — recorded |
| Journal reversal of `RCPT-`/`ALLOC-` entries | Known open hole; unchanged | known-issues file, runbook item 2 |

---

## 8. Decisions — only what genuinely blocks

### Odoo and ERPNext, from source (implementation evidence only — never a requirement, never Saudi)

| Question | Saudi Ledger today | Odoo (`c55c82d`) | ERPNext (`db6e089`) | Source/authority | Proposed |
| --- | --- | --- | --- | --- | --- |
| Is the advance a DOCUMENT or a receipt attribute? | Receipt only; no document | A **down-payment INVOICE** (`sale/wizard/sale_make_invoice_advance.py` L138–197 `_create_invoices`: percentage/fixed; `_prepare_down_payment_lines`), a real `account.move` with tax; `_is_downpayment` = every sale line is a down payment (`sale/models/account_move.py` L171–174) | A **Payment Entry** with `unallocated_amount` (`payment_entry.py` L1091–1130) and, optionally, "Advance Taxes and Charges" rows that post the TAX on the receipt (`services/gl_composer.py` L210–274 `add_tax_gl_entries`: on Receive, Cr tax account with the counter-entry on the bank via `get_party_account_for_taxes` L1455–1459) | Art. 53(1)(a)(2) requires a TAX INVOICE; Guideline §8 defines it (386) | **Document** (Odoo's shape), because ZATCA requires one and the return reads documents |
| Where does the advance sit in the GL? | `CUSTOMER_DEPOSITS` liability, party on the line | Company `downpayment_account_id`, domain income / income_other / **liability_current** (`sale/models/res_company.py` L50–58); falls back to the product's income account (`sale_make_invoice_advance.py` L243–251) | With `book_advance_payments_in_separate_party_account` (set from Company, `payment_entry.py` L240–275) the advance sits in a separate party account and is RECLASSIFIED to the invoice's receivable on allocation (`add_advance_gl_for_reference` L1384–1420, dated `reconcile_effect_on`) | IFRS 15.106 (settled with the accountant) | Keep `CUSTOMER_DEPOSITS`; the two products DIVERGE (income vs liability); ours is the liability the accountant chose |
| How does the final invoice deduct the advance? | Allocation entry Dr deposits / Cr AR after issue | Negative down-payment lines on the final invoice, `quantity = −1.0`, tax reversed with them (`sale/models/sale_order.py` L1575–1615) — GL NET | Invoice "Advances" table populated from open advances, allocation capped at the grand total (`accounts/services/advances.py` L27–60), reconciled through `update_against_document_in_jv` (`controllers/accounts_controller.py` L1085–…); an invoice-side reversal of the advance TAX was **not located** in this tree (search shape: `grep -rn "advance_tax\|allocate_advance_taxes" erpnext/accounts erpnext/controllers` → the Payment Entry import, `report/utils.py` L390–409, `hooks.py` only) | Guideline §8(c): the XML shows full lines + adjustment lines; the accounting shape is not prescribed | **E3** (net at issue, one writer) — A-2 confirms |
| What does the ZATCA XML carry? | 388 with `PrepaidAmount = paid_amount` | `l10n_sa_edi/models/account_edi_xml_ubl_21_zatca.py`: type 386 when `_is_downpayment()` (L160); on the final invoice the down-payment lines are filtered OUT of the base lines (L53–58) and the down-payment moves collected (L63–74); `PrepaidAmount` = Σ (base + tax) of those moves, `PayableAmount = TaxInclusive − Prepaid` (L341–349, L360–363); one prepayment line per 386 with `DocumentReference` {ID, IssueDate, IssueTime, DocumentTypeCode 386}, `TaxTotal/TaxSubtotal` per category (KSA-31/32), `LineExtensionAmount` 0, `Price` 0 (L488–538); the document `TaxTotal` stays the FULL tax of the supply lines (L323–329) | ERPNext's Saudi module is not in this tree (`erpnext/regional/saudi_arabia` absent at `db6e089`; moved out of core) — **not inspected, not claimed** | Guideline §8(b)(c)(d)(h); Resolution 7.13–7.15, 8.7, 8.9 | Odoo's node shapes are consistent with the Guideline and are the reference for AP-3's builder; ¶9.5 of the XML Standard is still to be read |

Convergence note (protocol §4): Odoo and ERPNext AGREE that an advance is its own dated record carrying its own tax event and that the final invoice adjusts it; they DIFFER on document-vs-payment and on income-vs-liability. That convergence is evidence about software; the Saudi requirement comes from Art. 23(1)/53(1)(a)(2)/Guideline §8, which settle the document question on their own.

### ACCOUNTANT — three items, one list (sent 2026-09-20; 🔴 ANSWERED 2026-09-21 — the answers, verbatim, follow each question)

> **A1 — Which receipts are "Consideration … prior to a Taxable Supply"?** Saudi Ledger will ask the user to classify every unapplied receipt as (a) an advance for a taxable supply — an advance tax invoice (type 386) is then due by the 15th of the following month; (b) an erroneous or duplicate payment — VAT-silent until applied or refunded; (c) a refundable security deposit — VAT-silent (we found NO KSA text on security deposits; the IR has no deposit article); (d) unknown — listed on the VAT-return page until classified, nothing posted. Please confirm (b) and (c) are not consideration and carry no VAT until applied, and whether "unknown" older than one tax period should be treated as (a) by default for the reminder (never for a posting).
> *Why it matters:* it decides which deposits the platform must demand a 386 for. *Evidence:* Agreement Art. 23(1); IR Art. 53(1)(a)(2); no source on security deposits. *Decision:* policy on (b)/(c) and the default for (d). *Who:* accountant (VAT).

🔴 **A1 — RESOLVED (accountant, 2026-09-21).** "Only a genuine advance payment for a future taxable supply triggers VAT advance-payment treatment and requires a Type 386 advance Tax Invoice. (1) Genuine taxable advance: VAT-relevant, Type 386 required. (2) Erroneous/accidental overpayment: no advance VAT treatment; hold in suspense; refund or reclassify when determined. (3) Security deposit: no VAT treatment unless it is contractually applied to a taxable supply. (4) Unknown/unclassified receipt: must NOT trigger Type 386; park in Customer Deposits Suspense; no VAT recognized until the nature is identified. The existing AP-1 classification model should be used rather than creating a second classification mechanism." **Built as:** `advanceInvoicesService.createFromReceipt` refuses (2), (3) and (4) by code `advance_invoice_requires_advance_classification` (the current AP-1 record decides; nothing is inferred); the default for an unknown deposit older than a period is NOT "treat as an advance" — it stays flagged for review (the accountant's (4)). "Customer Deposits Suspense" is the existing `CUSTOMER_DEPOSITS` liability the deposit already sits in (§1.1); no second account was added.

> **A2 — The GL shape of the advance tax invoice and its adjustment.** Proposed: at the 386, `Dr Customer deposits (VAT part) / Cr VAT Payable` — the deposit then reads as the net contract liability (IFRS 15.47 excludes VAT collected for the government); at the final 388, ONE entry `Dr AR (net due) · Dr Customer deposits (net advance) / Cr Revenue (full) · Cr VAT Payable (full − advance VAT)`, with the deposit's allocation folded into that entry. The alternative is a gross 388 plus a separate allocation entry that also reverses the advance VAT. Balances are identical; the difference is which entry carries the VAT and whether the deposit is shown gross or net after the 386. Please confirm the proposed shape, or name the other.
> *Why it matters:* every reader (statement, position, return, invariants) is written to one shape. *Evidence:* IFRS 15.47/106; Odoo posts the net shape (cited above); ERPNext posts the tax on the receipt. *Decision:* presentation policy. *Who:* accountant (accounting policy).

🔴 **A2 — RESOLVED (accountant, 2026-09-21).** "When a taxable advance is received: Dr Bank / Cash · Cr Customer Deposit Liability · Cr Output VAT. When the final invoice is issued: Dr Customer Deposit Liability — clear the advance · Dr Accounts Receivable — remaining amount, if any · Cr Revenue — total supply value · Cr Output VAT — total VAT less VAT already recognized on the advance. Final invoice presentation: use the required PrepaidAmount field; PrepaidAmount is inclusive of VAT; reference the relevant Type 386 advance invoice, including required identifiers such as IRN/date/UUID where applicable; the final invoice must properly represent the advance adjustment rather than treating the advance as an ordinary payment made after invoicing." **Reconciled with what exists, stated rather than silently chosen:** the accountant's receipt entry is the COMBINED position of two dated documents in this product — the Batch 1B receipt (`Dr Bank / Cr Customer deposits`, gross; built, unchanged) and the 386's own entry E2 (`Dr Customer deposits [VAT part] / Cr VAT Payable`), which together equal exactly `Dr Bank / Cr Deposit (net) / Cr Output VAT`. The final invoice is E3 as proposed (one entry, dated as the document, the deposit's net part released, VAT net of the 386's), with the allocation row folded into it. The GL deposit is therefore the NET contract liability (IFRS 15.47) from the 386 on, and the deposits invariant reads `GL = subledger − open advance-invoice VAT` (§14.3).

> **A3 (low priority, not blocking) — The date of a later allocation.** Today a deposit allocated to an existing invoice posts on the day of the click. Should it instead post on the invoice date when that month is still open (the contract liability is discharged by performance, IFRS 15.106), with the click date only when the invoice month is closed? Default if unanswered: unchanged (click date).

🔴 **A3 — RESOLVED (accountant, 2026-09-21).** "Use the ACTUAL ALLOCATION DATE. Do not backdate the allocation to the original receipt date or the invoice date. The allocation date is the date the deposit is actually applied to the invoice. This must respect period locking, AR ageing, audit trail, correction/reversal mechanics. VAT from the Type 386 advance is already recognized at advance-invoice issuance; allocation itself must not incorrectly create duplicate VAT." **Built as:** the D-4 later allocation stays dated `businessToday()` (unchanged; asserted); the advance applied AT the final invoice's issue is the invoice's own entry (A2's shape — the act of application IS the issuance, so its date is the document's posting date, not a backdating); the folded allocation is immutable and creates no VAT of its own; a 386-invoiced remainder cannot be applied by a plain allocation at all (§14.2, G-Z-3).

### ZATCA — already asked, not re-asked

> **Z1** — 1C pack §16.14.9, item 2: may `PrepaidAmount` reference an advance-payment invoice issued by a PREVIOUS solution by IRN, date and time when its UUID is unknown? Until answered, a final invoice against a migrated `invoiced` advance is REFUSED with this item named (G-Z-4). 🔴 **Still OPEN at the AP-2 build (2026-09-21): AP-2 deliberately touches no migrated advance** — a 386 cannot be issued from an opening deposit (`opening_deposit_not_advance_invoiced`: it would declare the previous system's VAT a second time) and a prepayment selection can name only a 386 this system issued (§14.2). **New fact for the same enquiry, not a new question:** the shipped SDK rules (2021-08-19) contain no 386/KSA-30…34 validation; the sandbox compliance endpoint is the only local proof available (AP-4).

### Proceeded with as `SAUDI LEDGER PRODUCT DECISION` (stated, not escalated — protocol §7 last paragraph)

1. The advance tax invoice is a DOCUMENT of the existing `invoices` table (a new `document_type`), through the existing approval engine, ICV, hash chain, QR, outbox and archive — never a second issuance path (CLAUDE.md §4 "one writer per effect").
2. It is created FROM a classified deposit (or a part of one) and never from nothing: no cash, no 386 (Art. 53(1)(a)(2) is about consideration RECEIVED). It is not a receivable and moves none of the three position components.
3. Adjusting an advance on a final invoice is a HUMAN selection on the document, recorded as an allocation folded into the issue entry; nothing is auto-applied (CLAUDE.md §9).
4. Over-advance default: BT-113 limited to the invoice (§8(g) option 2); option 1 only together with its credit note.
5. `PrepaidAmount` is computed from ADJUSTED ADVANCE INVOICES only; the `paid_amount` wiring is removed (G-Z-1) in the first code phase that touches the assembler.
6. The VAT-return exception list is a READER (no posting), and the deadline shown is the 15th of the month after receipt.
7. Refund of an invoiced advance requires a cleared/reported credit note referencing the 386 first — the precondition named in `refund` L671–681.

---

## 9. Proposed implementation phases (nothing started)

| Phase | Scope | Waits on | Size |
| --- | --- | --- | --- |
| **AP-1 — classification + the exception list** | `payments.classification ∈ {advance, erroneous, security_deposit, unknown}` (+ `vat_category` for `advance`), set at receipt or later by a dated act (append-only: a `payment_classifications` record, never an UPDATE); the VAT-return page's "receipts not yet invoiced" list with counts, amounts and the deadline; the customer page shows the classification. No accounting change; no VAT posted. | Nothing (A1 refines the default only) | ~2–3 days |
| **AP-2 — the advance tax invoice (386)** ✅ BUILT 2026-09-21 (§14) — and, moved in from AP-3 at the owner's scoping: the final invoice's prepayment adjustment (E3, ¶9.5 UBL, the return net) and A3's allocation date | `document_type = 'advance_invoice'`; create-from-deposit (customer, receipt, amount ≤ the receipt's un-invoiced remainder, category/rate lines); approval → E2 entry, ICV, hash, QR, outbox; UBL type 386; PDF titled correctly; `documentSign` and every reader audited by grep (`document_type` sites — the standing check part 6: tests asserting three types); the receipt carries `invoicedAmount`; the statement shows the 386 as a zero-movement event; ledger invariant: Σ VAT on 386s per customer = the deposit's VAT split. | **A1, A2**; XML Standard ¶9.5 read | ~1.5 weeks |
| **AP-3 — the credit note against a 386 (E5) and the refund it unlocks** ✅ BUILT 2026-09-21 (§15) | `document_type = 'advance_credit_note'` (381) referencing the 386: `Dr VAT Payable / Cr Customer deposits`; the receipt's un-invoiced remainder rises by the credited part and the D-4 refund returns it. An ordinary note against a 386 stays refused by name. The migrated `invoiced` arm stays behind **Z1**. | AP-2 ✅; **Z1** for the migrated arm only | — |
| **AP-4 — the walk and the sandbox** | The clicked walk in four modes (§11); the sandbox compliance pass for a 386 and a 388-with-adjustment (the M12 compliance gate, `tests/zatca-compliance-live.test.ts` pattern) — recorded with the endpoint and what it attests (CLAUDE.md §3 rule 1). | AP-3; the sandbox | ~3 days |

Not in these phases: supplier advances (G-AP-1), B2C advances (G-VAT-4), the journal-reversal hole, second-person approval of refunds (1B FUTURE PHASE).

---

## 10. Test strategy

Every rule below asserts presence, absence AND movement (CLAUDE.md §3), on rows produced by the product's own write path.

- **AP-1:** classification is append-only and dated; the exception list shows a deposit older than its period and NOT a classified-erroneous one, and the figure MOVES when a 386 is issued (planted positive); a classification cannot be set on another org's receipt (isolation: presence/absence/movement).
- **AP-2:** E2 posts exactly `Dr deposits VAT / Cr VAT_OUTPUT` and nothing else (the three position components unchanged before/after — the zero-movement standard for a new approvable entity, CLAUDE.md §11); a 386 consumes an ICV and chains (PIH read inside the sequence lock); refused for: no receipt, amount > un-invoiced remainder, a reversed opening deposit, a closed month, a draft receipt-less customer; the VAT return's box 6 moves by the 386's VAT in ITS period and not in the next; the XML carries `InvoiceTypeCode 386`; `documentSign`/ageing/statement/position readers each assert the 386 is absent from receivables; the existing tests asserting three document types are found and re-read (standing check 6).
- **AP-3:** E3 balances and the figure compared two ways: Σ(386 VAT) + Σ(388 net VAT) = GL `VAT_OUTPUT` movement (non-zero); over-advance default limits BT-113; many-to-one (two 386s on one 388) and partial adjustment; the folded allocation is not unallocatable (409 with the code); refund of an invoiced advance is refused without the 381 and allowed after it; migrated `invoiced` advance refused with `zatca_question_open`-shaped code; `unknown` refused; unchanged Batch 1B suites stay green (regression: the four d4 suites, 1C collection suite, ledger invariants on kept fixtures).
- **Contract:** every new response parsed against the generated schema (the conformance pattern); the hand-written interface ratchet must not grow.
- **Artifact:** the built bundle renders the 386 PDF (P5).
- **Live:** the sandbox compliance endpoint accepts a 386 and a 388 with adjustment lines — recorded as "what that endpoint attests" (construction, not clearance).

## 11. Clicked-walk strategy (AP-4)

Four modes (EN/AR × desktop/phone), the product's own servers, identity-only seeding: record a receipt on account → classify it as an advance (S) → the return page lists it with the deadline → issue the 386 from the receipt → approve → the return page's list empties and box 6 moves → create the final invoice, select the 386, see the net amount due → approve → the customer page shows AR net, deposit 0, the statement in chronology → collect the remainder by Mark Paid → a second scenario: cancel — credit note on a 386 → refund → statement closes at zero. Defect hunt on: number formats, RTL arrows, phone tables, the 409 texts, the PDF title. Report in the pack §16-style table.

## 12. Risks

1. **The tax mechanism is built before the accountant answers A1/A2** — the Batch 1C lesson (a build corrected in two commits after the answer). Mitigation: AP-1 only until answered.
2. **XML Standard ¶9.5 not yet read** — the Guideline names it as the authority for the UBL tags and "mandatory tags with fixed value zero". Building from Odoo's shapes alone would be a secondary source. Mitigation: fetch and read before AP-2's builder; record it in `docs/zatca/`.
3. **The shipped SDK cannot validate a 386** — a local green proves nothing (CLAUDE.md §4 "a green SDK differential is NOT evidence"). Mitigation: the sandbox compliance pass in AP-4 is the gate.
4. **A new `document_type` touches every reader** — `documentSign`, the return, ageing, statement, position, the invoice list, the PDF, credit-note pickers, Batch 1C's `isReceivableInBooks`. Mitigation: grep the sites with the search shape recorded, and the standing check part 6 for tests asserting three types.
5. **Double declaration** — a migrated `unknown` advance re-invoiced as a new 386 declares VAT twice. Mitigation: refused by construction (§7).
6. **The journal-reversal hole** now composes with four more entry kinds (386, 388-net, 381-on-386, folded allocation). Unchanged, named.
7. **Z1 stays unanswered** — migrated advances cannot be adjusted; customers with history keep a manual workaround. Named in the ZATCA enquiry; no default encoded.

---

# 13. AP-1 — deposit classification and the VAT-review list: as built (2026-09-20)

**Status (2026-09-20): BUILT on `feat/ap-1-deposit-classification` (on top of the research commit `079a2b6`), NOT merged. Implements §9 AP-1 only; nothing from A1/A2 is decided or encoded. Current state authority: [CLAUDE.md §2](../../CLAUDE.md).**

## 13.1 What exists

- **The classification record** — `payment_classifications` (migration `0082_ap1_payment_classifications`; schema in `packages/db/src/schema/payments.ts`): one row per statement, `classification ∈ {advance, erroneous, security_deposit, unknown}` (CHECK), `vat_category ∈ {S, Z, E}` only with `advance` (CHECK), `note`, `created_by`, `created_at`; RLS `tenant_isolation` (org + N1 company arm), SELECT + INSERT only for the app role, owner-only REVOKE of TRUNCATE/REFERENCES/TRIGGER, UPDATE/DELETE revoked — verified from `information_schema.role_table_grants` after the migration (authenticated: INSERT, SELECT). The CURRENT classification is the newest row (`paymentsRepository.latestClassifications`, one grouped query); the history stays readable (`GET /payments/{id}/classifications`). No default row: a receipt with no statement reads as `unknown`.
- **The write** — `POST /payments/{id}/classify` (`paymentsService.classify`): approver-level (POST → `create` = admin, accountant in the matrix); idempotent per key; refuses a receipt with no customer (`classification_requires_customer`, 422), a migrated opening deposit (`opening_deposit_classified_by_migration`, 409 — its VAT position is the MIGRATION's record, one definition never two), a reversed opening deposit (`opening_item_reversed`), and a receipt that was fully allocated when recorded (`no_deposit_to_classify`, 409 — it was never a deposit); a VAT category on a non-advance is `vat_category_requires_advance` (422). Audited as action `classify` with before/after. `POST /payments` accepts `classification` / `vatCategory` / `classificationNote` so the statement can be made AT receipt, in the same transaction; refused when nothing is unapplied.
- **What is NOT decided from it** — nothing posts and no VAT is read from a classification anywhere (asserted with a planted positive, §13.2). `customerCreditPolicy.ts` is untouched; every Batch 1B write path is untouched except `receive` accepting the optional statement and `view` carrying it.
- **The review list** — `GET /payments/deposit-review?period_to=YYYY-MM|as_of=YYYY-MM-DD&customer_id` (`services/depositReview.service.ts`, `paymentsRepository.depositsHeld`): every live receipt (direction in, a customer, not a reversed opening deposit) received on or before the frame date whose unapplied remainder (amount − ACTIVE allocations − deposit refunds) is positive NOW, with a server-decided state — `unclassified` (needs review), `advance_not_invoiced` (needs review; `deadline` = the 15th of the month after receipt, IR Art. 53(1)(b); `overdue` once today is past it), `vat_silent` (erroneous / security deposit — no VAT expected; A1 pending), `migrated_invoiced` (the previous system declared it), `migrated_unknown` (needs review, fail-closed) — and totals (`needsReviewCount/Amount`, `overdueCount`, `byState`). Every role reads it. The frame is stated on the response (`asOf`, `today`).
- **The return carries the summary** — `GET /reports/vat-return` now returns `depositReview { asOf, needsReviewCount, needsReviewAmount, overdueCount }` computed by the SAME function for the window's end (one definition, two readers); the boxes are unchanged.
- **UI** — the receipt dialog asks "What is this money?" (default *Decide later* → no record); the payment detail card shows the classification with its consequence in words and a *Classify / Reclassify* control (disabled with the reason for non-approvers; the server judges); the Payments page and the customer page carry the badge; `/vat` gains the panel "Customer deposits held — may carry VAT the boxes do not show" with the list, the deadline per advance, the summary badge, and the sentence that the platform cannot issue the advance tax invoice yet. Every string through `t()`; the Arabic sweep on the changed files reports 0 new user-facing English.
- **Contract** — `packages/api-spec/openapi.yaml`: `PaymentClassification`, `DepositClassification`, `ClassifyPaymentInput`, `DepositReview*`, `CustomerPayment.classification`, `ReceivePaymentInput.classification/vatCategory/classificationNote`, `VatReturn.depositReview`, the three paths; `CustomerPayment.source` gains `opening` (it was already written by Batch 1C and missing from the enum). Client and Zod regenerated; the web consumes the generated `useGetDepositReview` and input types (the hand-written-interface ratchet is unchanged).

## 13.2 Tests

- `apps/api/src/tests/ap1-deposit-classification.test.ts` (16): the pure helpers (deadline across a year end, end of month, the state map); all four values store and read back through get/list/history with each change a NEW row; a statement at receipt; the refusals by code (unknown value 400, VAT category outside S/Z/E 400, category on a non-advance 422, unknown receipt 404, fully-allocated-at-receipt 409); idempotency (same key = one record; key reused elsewhere = 409); 🔴 **classifying posts NOTHING and moves no VAT, AR or deposit — while an invoice approval on the same instrument DOES move `VAT_OUTPUT` by exactly 150** (planted positive); the review list with presence, absence AND movement (unclassified → advance with the deadline → erroneous still listed but not needing review → allocated away and gone → partly corrected and back, the classification surviving the round trip); the receipt-date frame and the customer filter; the return's summary equals the list's for the period end and moves by exactly a new deposit's amount while no box moves; a migrated deposit follows its migration VAT position (invoiced → no review, unknown → review) and refuses classification; org isolation with movement on the other side only; permissions; append-only (UPDATE/DELETE → 42501); every journal balances.
- `apps/web/e2e/ap1-deposit-classification.spec.ts` (6, by clicking; effects read back from the API): English desktop — record on account with *Decide later* → the badge → `/vat` lists it as needing review and the return's summary carries the same count → classify as advance (S, note) → the state, the deadline and the badge → reclassify erroneous → no VAT expected, the count down by one → the journal count moved by ONE (the receipt) and box 6 not at all; the existing allocate and refund flows on a classified receipt (the classification survives, the remainder stays listed, a full refund removes it); the Payments page column and detail dialog. English phone (dialog fits; no sideways scroll on `/vat`); Arabic RTL desktop; Arabic RTL phone.
- Regression: the four D-4 suites, D-3, the three Batch 1C suites, route reachability, the party and report contract-conformance suites, identity-table boundary, privilege surface map, the ratchet, the org-seed trigger — green. One Batch 1C test compared the WHOLE return before/after collecting an opening receivable; its excess deposit now legitimately moves `depositReview`, so the comparison was narrowed to the boxes (the claim it makes), with the reason in the test.

## 13.3 The clicked walk — record

Run twice on the product's own servers against the e2e database: by the Playwright spec above (real keystrokes and clicks on the dialogs' Radix selects), and by hand in Chrome for the defect hunt — the desktop modes in a 1280-px window, the phone modes in a 390-px same-origin frame (the automation window would not resize; a viewport, not a device):

| Mode | Workflow | Result |
| --- | --- | --- |
| English / desktop | `/vat` panel: four unclassified deposits flagged, the summary "Needs review: 4 · SAR 580.00" equal to `GET /reports/vat-return`'s `depositReview` → customer page → RCPT-31's detail card ("Erroneous / duplicate payment" with its sentence, *Reclassify*) → *Allocate* 300 to E2E-INV-003 → on account 850, the classification kept, still listed → *Refund deposit* 850 (the two-step confirmation) → on account 0, gone from the list, the count unchanged at 4 | pass |
| English / phone (390 px) | `/vat` panel and the customer page in the frame → RCPT-27 detail → *Classify* → the dialog inside the frame (8…378 of 386) → "Refundable security deposit" → saved; badge updated | pass, 1 defect → fixed |
| Arabic / RTL / desktop | customer page → *تسجيل إيصال* 1,150 with "دفعة مقدمة لتوريد" chosen AT receipt (the VAT-category select appears with the Arabic hint) → RCPT-31 "دفعة مقدمة لتوريد · Z" → `/vat`: the row "دفعة مقدمة — لم تصدر فاتورتها الضريبية بعد", the deadline 2026-10-15, summary "تحتاج إلى مراجعة: 5 · SAR 1,730.00", `dir=rtl`, no sideways scroll → detail → *إعادة التصنيف* → "دفعة خاطئة / مكررة" → "لا ضريبة متوقعة", the count 5 → 4, the history `[advance, erroneous]` | pass, 1 defect → fixed |
| Arabic / RTL / phone | both frames RTL, no sideways scroll; the panel with an overdue advance ("كانت الفاتورة الضريبية … مستحقة بحلول 2026-09-15" in red); RCPT-27's card "تأمين قابل للاسترداد" with its sentence | pass, 1 defect → fixed |

Defects found by hand and fixed before commit (the spec had not seen them because it asserts text, not geometry): (1) on a phone the panel's table clipped its STATUS column inside the card — the receipt number now sits under the customer below `sm`, the cells lose padding and the status wraps (table = its container, overflow 0 at 386 px); (2) under RTL the deadline date broke across lines by bidi ("-10-2026 / 15") — an LTR span; (3) the detail card's consequence sentence ran past the card on a phone — width bounded to the viewport. The spec was re-run after the fixes (6/6).

## 13.4 Remaining blockers — exactly what is still required

| Item | Who | Blocks | Question as it stands |
| --- | --- | --- | --- |
| **A1** — which receipts are consideration | accountant | AP-2's demand for a 386; the default for `unknown` | §8 A1 verbatim. Until answered, `erroneous` and `security_deposit` read as "no VAT expected (the accountant's confirmation is pending)" in the UI hint, and nothing posts either way. |
| **A2** — the GL shape of the 386 and the net final invoice | accountant | AP-2 (E2) and AP-3 (E3) | §8 A2 verbatim. |
| **A3** — the date of a later allocation | accountant (low) | nothing | §8 A3; default unchanged. |
| **XML Implementation Standard ¶9.5** | engineering (read before AP-2) | AP-2's UBL for a 386 and AP-3's adjustment lines | Guideline §8(h) names it as the authority for the tags and the "mandatory tags with fixed value zero". Not in the repo's spec set; fetch and read. |
| **Z1** — PrepaidAmount referencing a previous solution's advance invoice | ZATCA (asked, 1C §16.14.9 item 2) | AP-3's migrated arm only | Unchanged; `migrated_unknown` and `migrated_invoiced` are shown, never adjusted. |

**AP-2 readiness: BLOCKED** — on A1, A2 and ¶9.5. AP-1 needs none of them and is complete.

## 13.5 Files changed (AP-1)

`packages/db/src/schema/payments.ts` · `packages/db/migrations/0082_ap1_payment_classifications.sql` (+ `meta/`) · `packages/api-spec/openapi.yaml` · the regenerated `packages/api-zod` and `packages/api-client-react` · `apps/api/src/repositories/payments.repository.ts` · `apps/api/src/services/payments.service.ts` · `apps/api/src/services/depositReview.service.ts` (new) · `apps/api/src/services/reports.service.ts` · `apps/api/src/controllers/payments.controller.ts` · `apps/api/src/routes/payments.ts` · `apps/api/src/tests/ap1-deposit-classification.test.ts` (new) · `apps/api/src/tests/batch-1c-opening-receivable-collection.test.ts` (the boxes comparison) · `apps/web/src/components/payments/{shared,ClassifyDialog (new),PaymentDetail,ReceiveDialog}.tsx` · `apps/web/src/pages/{VatReport,Payments,CustomerDetail}.tsx` · `apps/web/e2e/ap1-deposit-classification.spec.ts` (new) · `docs/history/known-issues-and-audit-findings.md` ("ADVANCE VAT UNDER-DECLARATION") · `CLAUDE.md` §2 · this pack.

---

# 14. AP-2 — the advance tax invoice (386) and the final invoice's prepayment adjustment: as built (2026-09-21)

**Status (2026-09-21): BUILT on `feat/ap-2-advance-tax-invoice` (on top of `feat/ap-1-deposit-classification`), NOT merged. Implements the accountant's A1/A2/A3 as answered (§8) and the XML Implementation Standard ¶9.5 as read (the primary text, fetched 2026-09-21 — `docs/zatca/specs/`). Current state authority: [CLAUDE.md §2](../../CLAUDE.md).**

## 14.1 The trace — business event → document → entry → account → VAT → AR/deposit → audit

| # | Business event | Document | Journal entry (date) | VAT effect (return) | AR / deposit effect | Audit |
| --- | --- | --- | --- | --- | --- | --- |
| E1 | Customer pays 11,500 before the supply | `payments` receipt RCPT-n, classified `advance · S` (AP-1) | `RCPT-n` (receipt date): Dr Bank 11,500 / Cr Customer deposits(customer) 11,500 — **Batch 1B, unchanged** | none — a receipt files nothing | deposit +11,500 (subledger and GL) | `create`, `unapplied`, `classify` |
| E2 | The advance tax invoice is issued | `invoices` row, `document_type = 'advance_invoice'`, `advance_payment_id = n`, one line (10,000 @ S 15% = 1,500; total 11,500), ICV + hash + QR + e-invoice via the one issuance path | `GL-<386 number>` (the 386's date — default the receipt date, the tax point): **Dr Customer deposits(customer) 1,500 / Cr VAT Payable 1,500** (a Z/E advance: no entry) | box 1 +10,000, box 6 +1,500 in the 386's period (the return reads it as any invoice row) | AR 0; subledger deposit unchanged 11,500 (cash on account); GL deposit 10,000 (net contract liability, IFRS 15.47); the receipt now reads `advanceInvoiced 11,500 · open 11,500 · uninvoiced 0` | `create` (with the receipt and the classification id), `approve` |
| E3 | The supply is invoiced: 30,000 + 4,500, applying the 386 | `invoices` row 388 with one `invoice_prepayments` row (amount 11,500 = KSA-31 10,000 + KSA-32 1,500, S, 15.00); UBL: full lines + one ¶9.5 adjustment line referencing the 386 (number, UUID, issue date, issue time, 386), `PrepaidAmount` 11,500, `PayableAmount` 23,000 | `GL-<388 number>` (the 388's date): **Dr AR(customer) 23,000 · Dr Customer deposits(customer) 10,000 / Cr Sales 30,000 · Cr VAT Payable 3,000** — plus the allocation row RCPT-n → 388 for 11,500 naming this entry (`paid_amount` +11,500) | box 1 +20,000, box 6 +3,000 in the 388's period (the lines file in full, the finalised prepayment rows are deducted per category — the base and the VAT declared ONCE over the two periods) | AR +23,000 (outstanding = 34,500 − 11,500 paid); deposit −11,500 subledger, −10,000 GL; the 386 reads adjusted 11,500 / open 0 | `create` (with the selection), `approve`; the prepayment row is frozen by trigger once issued |
| — | Full advance (386 = the whole 388) | as E3 with `amountDue` 0 | no AR line; status `paid` at issue | as E3 | AR 0 | as E3 |
| — | The remainder is collected | any D-4 path (Mark Paid, receipt with allocation) | unchanged Batch 1B entries | none | AR −23,000 | unchanged |
| — | A later D-4 allocation of an UN-invoiced part | `payment_allocations` | `ALLOC-<id>` dated **today** (A3), Dr deposits / Cr AR | none | as Batch 1B | `allocate`; correctable by `unallocate` (superseding record) |

**Correction to the research (§6 E3):** the draft pack's return line for E3 read "box 1 +30,000, box 6 +3,000" — inconsistent with itself and with the entry. Built and asserted as +20,000 / +3,000: Art. 23(1) makes the advance's base and VAT due "to the extent of the received amount" in the receipt's period, and the standard's KSA-31/32 fields carry exactly what the final invoice must not declare again.

## 14.2 What exists

- **Schema (migration `0083_ap2_advance_tax_invoice`)** — `invoices.advance_payment_id` (FK `payments`, RESTRICT; CHECK `invoices_advance_reference_chk`: NOT NULL exactly when `document_type = 'advance_invoice'`); the 0020 note-pairing CHECK widened so an `advance_invoice` row can exist (no original, no reason — like an invoice); `invoice_prepayments` (one row per (final invoice, 386): `amount` = `taxable_amount` + `tax_amount` by CHECK, `tax_category_code`, `vat_rate`, `allocation_id` set at approval; RLS `tenant_isolation` with the N1 company arm; app role SELECT/INSERT/UPDATE/DELETE — a draft's selection is edited like its lines; owner-only REVOKE of TRUNCATE/REFERENCES/TRIGGER; trigger `refuse_issued_prepayment_change` freezes every row of an ISSUED invoice except the approval's own `allocation_id NULL → id`, once). `@workspace/shared` `documentTypes.ts` is the one definition of the four types and of `NON_RECEIVABLE_DOCUMENT_TYPES = ['credit_note','advance_invoice']`.
- **The 386** — `POST /payments/{id}/advance-invoices` (`advanceInvoicesService.createFromReceipt`; approver-level): a DRAFT for a VAT-inclusive amount ≤ the receipt's un-invoiced remainder, dated the receipt date when its month is open (else today; never before the receipt; never into a closed month), one line split at the deposit's classified category (`splitGross`: taxable + VAT = amount to the halala and VAT = taxable × rate within a halala, else 422 `advance_amount_does_not_split`; Z/E need an exemption reason). Refused by name: erroneous / security deposit / unknown (`advance_invoice_requires_advance_classification` — A1), no VAT category, a migrated opening deposit (`opening_deposit_not_advance_invoiced` — Z1), a reversed one, beyond the remainder, before the receipt. Approval re-checks all of it under the receipt's advisory lock BEFORE the ICV is consumed (a reclassified deposit, a concurrent 386 → refused, nothing minted), then the one issuance path (ICV, hash, QR, e-invoice enqueue) and E2. `POST /invoices` refuses the type (`advance_invoice_via_receipt`); a draft 386's lines and customer are not editable (`advance_invoice_line_derived`); a 386 is not payable (`advance_invoice_not_payable`), not an allocation target, and not correctable by a credit note yet (`note_original_is_advance_invoice` — AP-3).
- **The final invoice** — `prepayments: [{ advanceInvoiceId, amount? }]` on create and update (`preparePrepayments`: each 386 issued, this customer's, open ≥ amount; Σ ≤ the invoice total — over-advance default, Guideline §8(g) option 2; a full adjustment copies the 386's stored split exactly, a partial one is split the same way); a draft reserves nothing; approval re-checks under the 386 rows' and receipts' locks, posts E3, writes ONE allocation per receipt naming the entry, sets `allocation_id`, bumps `paid_amount` (status `paid` when nothing is due). `GET /customers/{id}/advance-invoices` lists the open 386s (the picker). `unallocate` refuses the folded allocation (`prepayment_adjustment_immutable`); D-4 `allocate` and `refund` refuse anything beyond the un-invoiced remainder (`advance_invoiced_requires_prepayment_adjustment` — G-Z-3 fail-closed; the credit note that releases it is AP-3).
- **The UBL** — `advance_invoice → InvoiceTypeCode 386` (subtype 01/02 as for an invoice, XML Standard §11.2.1); on a 388 the assembler builds ONE adjustment line per (category, rate) consolidating its prepayment rows, each 386 referenced by number, UUID, issue date and issue time with `DocumentTypeCode 386` (¶9.5, BR-KSA-73…82), every principal value fixed at zero, `PrepaidAmount` = Σ(KSA-31 + KSA-32), `PayableAmount` = TaxInclusive − Prepaid; **`PrepaidAmount` is no longer wired to `paid_amount`** (G-Z-1 closed). The PDF titles a 386 "Advance Payment Tax Invoice / فاتورة ضريبية عن دفعة مقدمة" (simplified variant by the buyer test), shows the receipt and no amount due; a 388 shows each advance invoice deducted and the amount due.
- **Every reader, swept** (the §3 rule "a new document type touches every reader"): invoice list totals and OVERDUE (`invoices.repository`), the customer position and statement (`customerStatement.repository` — the 386 is a zero-movement `advance_invoice` event, and the statement reconciles), AR ageing, the customer ledger (the 386 is not listed — it is not owed), top customers by billed (`analytics.repository`), `openForSettlement`/`isReceivableInBooks` (already keyed on `invoice`), the findings engine (keyed on `invoice`), the ledger invariant `deposits_gl_vs_subledger` (now `GL = subledger − open advance-invoice VAT`). The VAT return files the 386 in its period through the existing line path and deducts the finalised prepayment rows per category from the 388's period.
- **The deposit review (AP-1)** gains `advance_invoiced` (fully covered — VAT declared, no review) and reports `advanceOpenAmount` / `uninvoicedAmount`; an advance's reviewed figure is its un-invoiced remainder. The receipt (`CustomerPayment`) carries `advanceInvoicedAmount`, `advanceAdjustedAmount`, `advanceOpenAmount`, `uninvoicedAmount` and `advanceInvoices[]`; the invoice carries `advancePaymentId`, `prepayments[]`, `prepaidAmount`, `amountDue`.
- **UI** — the receipt card's "Advance tax invoices (386)" section (the four figures, the list with status / PDF, *Issue advance tax invoice* → the dialog → a draft, *Approve & issue* as the separate act; Allocate / Refund offered for the un-invoiced part only); the New Invoice dialog's "Apply advance tax invoices" picker (tick, optional partial amount, the prepaid and amount-due summary), prefilled when editing a draft; the Invoices list's type badge, "Advance applied" badge and a Due column; the statement's event label; the VAT panel's `advance_invoiced` state and its corrected sentence. Every string through `t()`.
- **Contract** — `openapi.yaml`: `Invoice.documentType` enum + `advancePaymentId` / `prepayments` / `prepaidAmount` / `amountDue`; `InvoicePrepayment`, `PrepaymentInput`, `CreateAdvanceInvoiceInput`, `OpenAdvanceInvoice`, `ReceiptAdvanceInvoice`; `CreateInvoiceInput.prepayments`, `UpdateInvoiceInput.prepayments`; `CustomerPayment`'s five fields; `DepositReviewState.advance_invoiced` + the two item fields; the two paths. Client and Zod regenerated; the web consumes the generated types (the hand-written-interface ratchet is unchanged).

## 14.3 Tests

- `apps/api/src/tests/ap2-advance-tax-invoice.test.ts` (16, real rows): `splitGross` over a sweep (exact or refused, never inconsistent); the review states; the genuine advance → 386 draft/issued with E2 and NOTHING else moving (AR, revenue, bank, the three position components) and the receipt's figures; erroneous / security deposit / unknown / no category / opening deposit REFUSED by name and the front door refusing the type; the VAT = gross × 15/115 and the return moving in the 386's period only (a Z advance: no entry); the 386's UBL from real rows; PARTIAL advance (draft reserves nothing → E3 exactly → box 1 +20,000 / box 6 +3,000 → the folded allocation → the XML's reference and `PrepaidAmount` → Mark Paid closes it); FULL advance (no AR line, `paid` at issue, VAT_OUTPUT unmoved); several 386s on one 388 folding into ONE allocation, partial adjustment leaving the 386 open, over-advance (422), re-adjustment (409), a second draft refused at approval with nothing minted; D-4 allocate and refund refused beyond the un-invoiced remainder and allowed within it (dated today — A3); the 386 not payable / not a target / not credit-notable / lines not editable / draft deletable; approval re-checks (reclassified, concurrent, dated before the receipt, another org's receipt or 386); closed month (386 refused and re-dated, 388-with-adjustment refused with nothing posted, the 386 still open); the folded allocation immutable (409) with the row frozen by the trigger against raw UPDATE/DELETE, and a D-4 allocation corrected by a superseding record with the audit intact; every AR reader unmoved by a 386 while VAT and the return move (planted positive), the statement's zero-movement event, reconciled, and the review states; every journal balanced and no 386 ever carrying AR, revenue or a bank line; the deposits invariant after every scenario.
- `invoice-document-render.test.ts` (+1): the 386 titled "فاتورة ضريبية عن دفعة مقدمة" / "Advance Payment (Simplified) Tax Invoice", naming its receipt, with no balance-due block; the final invoice showing each advance deducted and the amount due, in both languages.
- `ubl-generation.test.ts` (+4): 386 type code and subtypes; a 386 carries no prepayment fields; the ¶9.5 adjustment line exactly (zero principal values, the reference's five elements in order, KSA-31/32, `PrepaidAmount`/`PayableAmount`, element order inside the line); two advances of one category consolidating into one line with two references. `ubl-zatca-validator.test.ts` (+2, the SDK on disk): the 388-with-adjustment PASSES XSD, EN 16931 and the shipped BR-KSA rules; the 386 passes XSD and EN and is refused by the SHIPPED 2021 BR-KSA-05 code list — PINNED as the only error (divergences log §15; the live sandbox is the gate — AP-4).
- 🔴 **A defect the suite caught on its first run:** drizzle renders `${table.column}` UNQUALIFIED inside a select list, so a correlated subquery over `invoice_prepayments` resolved `"id"` to its OWN id and every adjustment read as 0.00 — the movement assertion found it; the repository names the outer row as `${table}."id"` and says why.
- Regression: AP-1 (16), the four D-4 suites, D-3, the four Batch 1C suites, invoices-approval-zero-movement, money-kpi-consistency, route reachability, the hand-written-interface ratchet, the document / report / party contract-conformance suites, cross-company isolation, the Policy C reader sweep (the new repository consumes the predicate), invoice-document-render, einvoice-enqueue, hash-chain continuity — green; `pnpm run verify` — see the delivery report.
- `apps/web/e2e/ap2-advance-tax-invoice.spec.ts` (6, by clicking; effects read back from the API): English desktop — advance recorded and classified in the receipt dialog → the receipt card's advance section (un-invoiced 1,150) → *Issue advance tax invoice* → the draft (declares nothing) → *Approve & issue* → the 386 (ICV, split, the receipt named) → the receipt's figures and the Allocate/Refund controls gone → box 1 +1,000 / box 6 +150 → the VAT panel's `advance_invoiced` → the New Invoice dialog's picker → the 388 (PrepaidAmount 1,150, due 2,300) → box 1 +2,000 / box 6 +300 → the Invoices list's badges and Due column → the folded allocation immutable (409); a PARTIAL 386 (the rest reviewable, Allocate still offered, a partial adjustment leaving the 386 open); an erroneous deposit refused; English phone (the section and the dialog fit; no sideways scroll; the picker fits); Arabic RTL desktop; Arabic RTL phone.

## 14.4 The clicked walk — record

Run on the product's own servers against the e2e database by the Playwright spec above (real keystrokes and clicks on the dialogs' Radix selects and the picker's checkboxes), desktop in a 1280-px window, phone at 390 px:

| Mode | Workflow | Result |
| --- | --- | --- |
| English / desktop | receipt on account 1,150 classified advance · S → card: "Not yet invoiced 1,150.00" → *Issue advance tax invoice* → dialog (taxable 1,000.00 · VAT 15% 150.00) → *Create draft* → row "Draft" · *Approve & issue* → "Issued", open 1,150.00, un-invoiced 0.00, no Allocate/Refund → `/vat`: "Advance — tax invoice issued, awaiting the final invoice" → `/invoices` New Invoice: customer → "Apply advance tax invoices" → tick → summary "Prepaid 1,150.00 · Amount due 2,300.00" → create → approve → list: "Advance tax invoice" badge, Due "—"; "Advance applied 1,150.00", Due 2,300.00 → card: applied 1,150.00, awaiting 0.00 | pass |
| English / phone (390 px) | the same issue flow; the receipt card's advance section and the dialog inside the viewport; no sideways scroll; the picker inside the New Invoice dialog | pass, **2 defects → fixed** |
| Arabic / RTL / desktop | «تسجيل إيصال» classified «دفعة مقدمة لتوريد · S» → «إصدار فاتورة ضريبية عن الدفعة المقدمة» → «إنشاء المسودة» → «اعتماد وإصدار» → «صادرة» → `/vat` «دفعة مقدمة — صدرت فاتورتها الضريبية، بانتظار الفاتورة النهائية» → «فاتورة جديدة» with the picker → «فاتورة دفعة مقدمة» / «طُبّقت دفعة مقدمة» badges, due 1,150.00, `dir=rtl` | pass |
| Arabic / RTL / phone | the dialog «إصدار فاتورة ضريبية عن دفعة مقدمة» fits and issues; the card and `/vat` render RTL without sideways scroll | pass |

Defects found by the walk and fixed before commit: (1) on a phone the receipt card sat inside the payments table's sideways scroll, so after the row's *Details* tap the whole card (the advance section with it) was off the visible edge — the table now drops the date column below `sm` (the date is on the card) and fits 390 px with no sideways scroll, and the card is pinned to the inline-start edge and bounded to the viewport; (2) the same in Arabic. The spec was re-run after the fixes (6/6).

## 14.5 Files changed (AP-2)

`packages/shared/src/documentTypes.ts` (new) + `index.ts` · `packages/db/src/schema/{invoices,invoicePrepayments (new),index}.ts` · `packages/db/migrations/0083_ap2_advance_tax_invoice.sql` (+ `meta/`) · `packages/api-spec/openapi.yaml` · the regenerated `packages/api-zod` and `packages/api-client-react` · `apps/api/src/repositories/{advanceInvoices (new),customerStatement,invoices,reports,analytics,payments}.repository.ts` · `apps/api/src/services/{advanceInvoices (new),invoices,invoices.approvable,invoices.presenter,payments,depositReview,creditNotes,reports}.service.ts` (`.ts` where not a service) · `apps/api/src/services/einvoice/{types,einvoiceInput.assembler,einvoiceInput.loader,ubl/buildInvoiceXml,__fixtures__/sampleInput,onboarding/complianceDocuments}.ts` · `apps/api/src/services/invoiceDocument/{labels,renderInvoiceHtml,invoiceDocument.service}.ts` · `apps/api/src/controllers/{payments,customers}.controller.ts` · `apps/api/src/routes/{payments,customers}.ts` · `apps/api/src/scripts/ledgerInvariants.ts` · `apps/api/src/tests/{ap2-advance-tax-invoice (new),ubl-generation,ubl-zatca-validator,invoice-document-render}.test.ts` · `apps/web/e2e/batch-1b-payment-flows.spec.ts` (one absolute deposit figure made a movement — it read a customer AP-1's spec also writes to) · `apps/web/src/components/payments/{AdvanceInvoiceDialog (new),PaymentDetail,shared}.tsx` · `apps/web/src/pages/{Invoices,CustomerDetail,CustomerStatement,VatReport}.tsx` · `apps/web/e2e/ap2-advance-tax-invoice.spec.ts` (new) · `docs/zatca/{README.md,fetch-specs.sh,spec-vs-implementation-divergences.md}` + `specs/…XML_Implementation_Standard_vTrack.txt` (new; the PDF is gitignored like the others) · `docs/history/known-issues-and-audit-findings.md` · `CLAUDE.md` §2 · this pack.

## 14.6 What is still required — exactly

| Item | Who | Blocks | Question as it stands |
| --- | --- | --- | --- |
| **AP-4 — the live sandbox pass** | ✅ RUN 2026-09-21 (§16) | — | The 386 and the 388-with-adjustment from real rows: `PASS` / `CLEARED`, zero warnings; the endpoint and what it attests are in §16.2. |
| **AP-3 — the credit note against a 386, and the refund it unlocks** | ✅ BUILT 2026-09-21 (§15) | — | The ordinary-note door stays shut by name; the controlled door is `POST /invoices/{386}/advance-credit-notes`. |
| **Z1** — a previous system's advance invoice as a PrepaidAmount reference | ZATCA (asked, 1C §16.14.9 item 2) | the migrated `invoiced` arm | Unchanged; a migrated deposit gets no 386 here and cannot be selected on a final invoice. |
| **Supply date on a 386 (KSA-5)** | engineering — a product question, small | nothing today | The builder emits the issue date as `ActualDeliveryDate` for every document (pre-existing). For a 386 the tax point is the RECEIPT date; whether KSA-5 should carry it is not stated in ¶9.5 or the Guideline §8 and is left as the existing behaviour, recorded so it is not mistaken for a decision. |
| **B2C advances (G-VAT-4)**, **supplier advances (G-AP-1)** | — | out of scope, unchanged | §3.3. |

---

# 15. AP-3 — the credit note against an advance tax invoice, and the refund it unlocks: as built (2026-09-21)

**Status (2026-09-21): BUILT on `feat/ap-3-advance-credit-note-refund` (on top of AP-2 `0b00b70c`), pushed, NOT merged. Implements pack §6 E5 and §7 "Advance received, supply cancelled" as the accountant's A1/A2/A3 leave them; nothing new was asked of the accountant. Z1 untouched. AP-4 NOT done. Current state authority: [CLAUDE.md §2](../../CLAUDE.md).**

## 15.1 What the sources establish, and what was decided

| Point | Class | Source | What was built |
| --- | --- | --- | --- |
| Refunding an invoiced advance requires a credit note against the advance invoice, sent for clearance/reporting | AUTHORITATIVE REQUIREMENT | Detailed Guideline v2 §8(g); IR Art. 40(1)(a), 54(1) | The receipt's 386-covered part cannot be refunded or allocated (AP-2's guard, unchanged); only an ISSUED `advance_credit_note` releases it, by exactly what it credited. |
| A credit note (381) must carry the billing reference ID (BT-25 — the original's number) and the reason (KSA-10) | AUTHORITATIVE REQUIREMENT | XML Implementation Standard v1.2 BR-KSA-56, BR-KSA-17; `IssueDate` in the reference is optional (BR-KSA-F-01 governs its format when present); no UUID / issue-time requirement for BT-25 | The note's `original_invoice_id` is the 386 (a real FK); the assembler resolves the 386's NUMBER from the row for `cac:BillingReference/cac:InvoiceDocumentReference/cbc:ID`, and `cbc:InstructionNote` carries the reason. 🔴 **What the note needs of the 386 it points at is its NUMBER only** — which the 386 as built carries (its own sequence number); the 386's UUID / issue time are NOT part of the note's reference. |
| The output-tax decrease is taken in the later of the event's and the note's period | AUTHORITATIVE REQUIREMENT | IR Art. 40(5) | The note is dated when the cancellation happens, never before the 386 (`advance_credit_note_before_advance`); the return reads its line NEGATIVE in the note's period (`documentSign` −1). |
| The entry: the advance's declared VAT returns to the deposit; the cash stays the receipt's deposit until refunded | ESTABLISHED ACCOUNTING PRACTICE (the mirror of E2 under A2) | pack §6 E5; IFRS 15.47/106 | E5 at approval: `Dr VAT Payable [credited VAT] / Cr Customer deposits(customer) [credited VAT]`; no AR, no revenue, no allocation, no Model C credit balance. The refund is then Batch 1B's own `Dr Customer deposits / Cr bank` — unchanged. |
| Partial cancellation | ESTABLISHED PRACTICE + the pack's own model | pack §6 E4 ("2,300 stays on the receipt … awaiting its supply or a credit note"), §7; the existing partial credit-note mechanism (over-crediting guard) | A note may credit part of the 386's OPEN balance (issued − applied on final invoices − already credited); Σ notes ≤ open, enforced at create and at approval under the 386's row lock. An APPLIED part is corrected by a note on the final invoice that applied it, never here. |
| Odoo | ODOO IMPLEMENTATION | `sale`: a down-payment invoice is reversed by a credit note on that invoice (`account.move` reversal), which returns the down-payment account and its tax | Consistent: a note against the advance document, reversing its tax. Odoo's down-payment account may be income; ours is the liability the accountant chose (§8), so the reversal lands on the deposit. |
| ERPNext | ERPNEXT IMPLEMENTATION | `payment_entry`: an advance's tax rows are reversed by a return/cancel of the Payment Entry — no document-level 386 exists there | Not applicable to a document model; recorded, not followed. |
| Its own document type, `advance_credit_note`, rather than `credit_note` with a flag | SAUDI LEDGER PRODUCT DECISION | §3's "make the wrong thing inexpressible" | A Model C `credit_note` is a REFUND LIABILITY (Customer credit balances) that can be applied to invoices or refunded as a note; a note against a 386 is neither. With its own type, every reader that sums `credit_note` (position, credits invariant, applications, note refunds, analytics) excludes it by construction, and `isNoteType` includes it wherever a note is a note (the assembler's billing reference, the PDF, the approval re-check). |
| A fully-credited advance reads as an un-invoiced advance again | SAUDI LEDGER PRODUCT DECISION | A1 (the classification is a dated statement the note does not touch); §7 | The review list shows `advance_not_invoiced` with the receipt's deadline; the business either refunds (the unlocked door) or issues a NEW 386 (a new tax point — the old one stays credited and closed). No default is encoded. |

## 15.2 The trace — business event → document → entry → account → VAT → deposit → refund → audit

| # | Business event | Document | Journal entry (date) | VAT effect (return) | Deposit / receipt effect | Refund effect | Audit |
| --- | --- | --- | --- | --- | --- | --- | --- |
| E1 | Customer pays 11,500 before the supply | receipt RCPT-n, classified `advance · S` | `RCPT-n`: Dr Bank / Cr Customer deposits 11,500 — Batch 1B | none | deposit 11,500 | refund refused once a 386 covers it | `create`, `classify` |
| E2 | The advance tax invoice is issued | 386 (AP-2) | Dr Customer deposits 1,500 / Cr VAT Payable 1,500 | +10,000 / +1,500 in the 386's period | GL deposit 10,000 (net); `advanceOpen 11,500 · uninvoiced 0` | **refused**: `advance_invoiced_requires_prepayment_adjustment` | `create`, `approve` |
| E5 | The supply is cancelled; the advance is credited | `advance_credit_note` (381), `original_invoice_id` = the 386, `note_reason`, one line at the 386's category/rate (11,500 = 10,000 + 1,500) — via `POST /invoices/{386}/advance-credit-notes`, then approval (ICV, hash, QR, e-invoice — a legal document consumes a counter) | `GL-<note>` (the note's date): **Dr VAT Payable 1,500 / Cr Customer deposits(customer) 1,500** | −10,000 / −1,500 in the NOTE's period (Art. 40(5)) | GL deposit 11,500 (gross again); the 386 reads `credited 11,500 · open 0`; the receipt reads `uninvoiced 11,500` | **unlocked** for the credited part | `create` (with the 386, the receipt and the open balance before), `approve` |
| — | The cash is returned | `customer_refunds` (origin deposit, the receipt named) — Batch 1B's own path, unchanged | `REFUND-<id>`: Dr Customer deposits 11,500 / Cr Bank 11,500 | none — the VAT reversal was the note's | deposit 0; receipt `refunded 11,500 · unapplied 0` | done | `refund` |
| — | Partial: 4,600 of 11,500 credited | note total 4,600 (4,000 + 600) | Dr VAT 600 / Cr deposits 600 | −4,000 / −600 | `open 6,900 · uninvoiced 4,600` | up to 4,600; the open 6,900 still applies on a final invoice (E3) | as above |

The 386 is never edited: its number, ICV, hash and status are asserted unchanged after the note and the refund. The receipt is never edited (append-only). The note is a new row. The chain is readable on the receipt card (386 → its credit notes), on the statement (receipt → `advance_invoice` → `advance_credit_note` at zero movement → refund, reconciled) and in the audit log (create/approve per document, refund).

## 15.3 What exists

- **Migration `0084_ap3_advance_credit_note`** — the 0020 note-pairing CHECK widened so `advance_credit_note` sits in the NOTE arm (original + reason NOT NULL). Nothing else: the chain 386 → note → refund was already representable (`invoices.original_invoice_id`; `customer_refunds.payment_id`). No new table, no new column, no RLS change (the note is an `invoices` row); the 386 stays frozen by the existing issuance rules (no edit/delete of an issued row).
- **`@workspace/shared` `documentTypes.ts`** — `advance_credit_note` added to `DOCUMENT_TYPES` and `NON_RECEIVABLE_DOCUMENT_TYPES`; `isAdvanceCreditNoteType`, `isAdvanceDocumentType`.
- **The door** — `POST /invoices/{id}/advance-credit-notes` (`advanceInvoicesService.creditAdvance`; create-level, approval approver-level): the 386 locked (`FOR UPDATE`), issued, its open balance ≥ amount (`openBalances`: issued − adjusted − credited), a reason (`note_reason_required`), a date ≥ the 386's and in an open month; one line — a full credit copies the 386's stored split, a partial one is `splitGross` at the 386's rate. Refused by name: not a 386 (`advance_credit_note_original_not_advance`), a draft 386 (`note_original_not_issued`), beyond the open part (`advance_credit_note_exceeds_open`), dated before the 386 (`advance_credit_note_before_advance`); `POST /invoices` refuses the type (`advance_credit_note_via_advance`); an ORDINARY credit/debit note against a 386 stays refused (`note_original_is_advance_invoice`, now naming the controlled door); the draft's lines and customer are not editable. Approval re-validates under the 386's lock (`assertNoteIsValid`, the advance branch) before the ICV is consumed, then E5 (a Z/E advance: a document with no entry).
- **The unlock** — none by code: `advanceInvoicesService.assertWithinUninvoiced` already reads `open = invoiced − adjusted − credited`, so an issued note raises `uninvoicedAmount` and the existing D-4 refund (and allocation) admit exactly that part. `applyCreditNote` / `refund(origin credit_note)` require `credit_note` and so never see an advance note.
- **Readers, swept for the new type** — position and statement (`RECEIVABLE_DOC` excludes both advance types; a zero-movement `advance_credit_note` event referencing the 386), list totals and OVERDUE, AR ageing and the customer ledger (`isAdvanceDocumentType`), `documentSign` (−1), analytics, the deposits invariant (`GL = subledger − (386 VAT − adjusted VAT − credited VAT)`), the credits invariants (keyed on `credit_note`, untouched), `openForCustomer` (open net of credits), the receipt view (`creditedAmount`, `creditNotes[]` under each 386).
- **UBL** — `advance_credit_note → 381`; the assembler treats it as a note (billing reference + instruction note required); no prepayment fields. **PDF** — "Credit Note — Advance Payment / إشعار دائن — دفعة مقدمة", the original and the reason.
- **UI** — the receipt card: each issued 386 with an open part carries *Credit note* → `AdvanceCreditNoteDialog` (amount ≤ open, the VAT that returns to the deposit, the ZATCA reason required, date) → a draft row under the 386 → *Approve & issue*; the 386's badge reads Issued · open / Cancelled / Applied; the open-part hint names the note as the way to a refund; *Refund deposit* appears for the un-invoiced part only (unchanged rule — it now appears once the note issues). Invoices list badge; statement label. The customer page's invoice table and aging now consume the shared receivable predicate (the AP-2 gap: a 386 would have sat there as outstanding — closed here).
- **Contract** — `Invoice.documentType` enum; `CreateAdvanceCreditNoteInput`; `ReceiptAdvanceInvoice.creditedAmount/creditNotes`; `AdvanceCreditNoteSummary`; `OpenAdvanceInvoice.creditedAmount`; the statement kind; the path. Client and Zod regenerated.

## 15.4 Tests

- `apps/api/src/tests/ap3-advance-credit-note-refund.test.ts` (10, real rows): the door shut before the note (refund and allocation 409, nothing moved); the ordinary note refused by name and the advance note refused against an ordinary invoice / a draft 386 / without a reason / before the 386 / from another org; the full lifecycle (draft posts nothing and unlocks nothing → issue: E5 exactly and NOTHING else — AR, revenue, credit balance, bank unmoved; the return −10,000/−1,500 in the note's period and unmoved in the 386's; the position unchanged; the receipt's figures; the 386 no longer open → the Batch 1B refund's own entry → the receipt at zero; the 386's number/ICV/hash/status and the receipt preserved; the audit chain and the statement chain, reconciled; the review list empty); the note's UBL from real rows (381, BillingReference = the 386's number, the reason, no prepayment fields); PARTIAL (4,600 of 11,500: E5 for 600, refund capped at 4,600, a second note beyond the open balance refused, two concurrent drafts refused at approval with nothing minted after a final invoice took the rest, a fully-applied 386 not creditable); a credited advance reads as un-invoiced again and a NEW 386 can be issued while the old stays closed; closed months (note refused at create and at approval, nothing posted; the refund refused into a closed month — Batch 1B); door A (an erroneous deposit refunds with no note) and door B (an applied 386 issues a paid final invoice) unchanged, the AP-1 classification history untouched; Z1 shut; every journal balanced and no advance note ever on AR/SALES/CUSTOMER_CREDITS/bank; the deposits invariant after every scenario.
- `ubl-generation.test.ts` (+1), `ubl-zatca-validator.test.ts` (+1: the credit note against an advance PASSES XSD, EN 16931 and the shipped BR-KSA rules — the 381 code is in the 2021 list; the divergence is only the 386 it references), `invoice-document-render.test.ts` (+1). 🔴 An observation about the LOCAL harness, not the document: the SDK's `-sign` step on this Windows machine mangles a non-ASCII reason (an em dash) into an XSD-invalid file while the same unsigned document validates PASSED — a Java default-charset artefact; the fixture's reason is ASCII and the product's own signer is UTF-8.
- Regression: AP-1 (16), AP-2 (16), the D-4 / D-3 / Batch 1C suites and every other suite through `pnpm run verify` — see the delivery report.
- `apps/web/e2e/ap3-advance-credit-note-refund.spec.ts` (5, by clicking): English desktop (no refund door and the hint → *Credit note* → the dialog with the reason required → draft → *Approve & issue* → Cancelled / Issued / un-invoiced 1,150 → the refund dialog → zero; the 386 untouched; the statement chain; the list badge; the ordinary note still refused), PARTIAL (575 of 1,150), English phone, Arabic RTL desktop, Arabic RTL phone.

## 15.5 The clicked walk — record

| Mode | Workflow | Result |
| --- | --- | --- |
| English / desktop | receipt 1,150 classified advance → 386 issued (API) → card: "Issued · open", no *Refund deposit*, the hint "…first cancel the advance with a credit note" → *Credit note* → dialog: open 1,150.00 · taxable 1,000.00 · VAT returned 150.00 · reason required (submit disabled until typed) → *Create credit note draft* → row "↳ Credit note INV-… · Order cancelled −1,150.00 · Draft" → *Approve & issue* → 386 "Cancelled", credited 1,150.00, "Not yet invoiced 1,150.00", no *Credit note* control → *Refund deposit* → the two-step refund → on account 0.00 → `/invoices`: "Credit note — advance" badge, Due "—" | pass |
| English / phone (390 px) | the advance section and the credit-note dialog inside the viewport; the refund control inside the viewport; no sideways scroll after the note and after the refund | pass, **2 layout defects → fixed** |
| Arabic / RTL / desktop | «إشعار دائن» → «إلغاء الدفعة المقدمة — إشعار دائن» → «إنشاء مسودة الإشعار الدائن» → «اعتماد وإصدار» → «مُلغاة» / «صادرة» → «ردّ العربون» → `/invoices` «إشعار دائن — دفعة مقدمة», `dir=rtl` | pass |
| Arabic / RTL / phone | the dialog fits; the note issues; the refund follows; no sideways scroll | pass |

Defects found by hand on the phone screenshots and fixed before commit: (1) the 386 row's status and action were clipped inside the card's inner table — the Applied/Credited columns and the note's date now hide below `sm` (the four figures above carry them); (2) in Arabic the *Refund deposit* control ran off the card's edge beside *Allocate* — the control group wraps.

## 15.6 What is still required — exactly

| Item | Who | Blocks | Question as it stands |
| --- | --- | --- | --- |
| **AP-4 — the live sandbox pass** | ✅ RUN 2026-09-21 (§16) | — | The 381 whose billing reference names a 386, built from real rows: `PASS` / `CLEARED`, zero warnings — and the 386 it references likewise. The inherited-defect caveat is discharged for the sandbox; simulation/production stay behind the entity for every document type. |
| **Z1** — a previous system's advance invoice | ZATCA (asked) | the migrated `invoiced` arm | Unchanged; a migrated deposit gets no 386 here, so no note and no unlocked refund. |
| **KSA-5 on a 386** | engineering | nothing | Unchanged from §14.6; not silently changed. |

---

# 16. AP-4 — the compliance validation: as run (2026-09-21)

**Status (2026-09-21): RUN on `feat/ap-4-advance-compliance` (on top of AP-3 `46e36657`), NOT merged. Nothing was built or redesigned; no accounting decision changed; Z1 untouched. Current state authority: [CLAUDE.md §2](../../CLAUDE.md).**

## 16.1 What was validated, and how the instrument was validated first

`apps/api/src/tests/ap4-advance-zatca-live.test.ts` (27 tests, all green on 2026-09-21; the record file is written by `AP4_RECORD_OUT`):

- **Part 1 — the three shapes at the live sandbox**, directly-constructed fixtures: the 386 (standard), the 388 with a ¶9.5 prepayment adjustment line, the 381 against the 386, and — informational only, B2C advances being out of scope (§3.3) — a simplified 386. **Beside them, seven PLANTED-WRONG documents**, one per rule the sandbox could plausibly skip: BR-KSA-73 (BT-113 given, no adjustment line), BR-KSA-74 (KSA-30 = 388), BR-KSA-75 (KSA-30 given, KSA-31…34 removed), BR-KSA-79 (KSA-32 ≠ KSA-31 × KSA-34), BR-KSA-80 (BT-113 ≠ Σ KSA-31 + KSA-32), BR-KSA-56 (a 381 with no billing reference) and BR-CO-16 (the payable arithmetic, as a control). The suite asserts the sandbox NAMES each rule — a PASS on the correct documents is evidence only because the wrong ones were flagged (CLAUDE.md §3, the unvalidated-probe rule and "external validators check the weakest property they plausibly could").
- **Part 2 — the lifecycle from REAL ROWS**: through the product's own services — receipt (classified `advance · S`) → 386 → 388 adjusting the whole 386 (chain 1: 11,500 → 30,000 + 4,500, prepaid 11,500, payable 23,000); receipt → 386 → 388 adjusting 4,600 of it (chain 2: 20,000 + 3,000, prepaid 4,600, payable 18,400) → 381 against that 386 for the open 6,900 → the Batch 1B refund of 6,900. Each of the five documents is read back out of Postgres and built the way issuance builds it (the production chain-head read included), asserted field by field (§16.3), then signed with a compliance CSID bound to our key and submitted. The as-built accounting is asserted from the journal (§16.5). Z1 is asserted shut.
- **Part 3 — the shipped SDK on the same real-row documents** (§16.4).

## 16.2 The exact sandbox result

Endpoint: `POST https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal/compliance/invoices`, `Accept-Version: V2`, authenticated with a compliance CSID issued the same run by `POST …/compliance` (CSR `invoiceType 1100`; the sandbox accepts any OTP). **What it attests:** that ZATCA's current validation rule set accepts the document's construction — XSD, EN 16931, the BR-KSA rules INCLUDING the prepayment rules (proven present by the planted negatives), the signature and the QR. **What it does not attest:** the production clearance/reporting endpoints (never called, in any environment), PIH continuity (a genesis PIH is accepted on every document), simulation/production behaviour, or anything about the ledger.

| Document | HTTP | `validationResults.status` | `clearanceStatus` | `reportingStatus` | Messages beyond `XSD_ZATCA_VALID` |
| --- | --- | --- | --- | --- | --- |
| 386 advance tax invoice (standard, fixture) | 200 | PASS | CLEARED | — | none |
| 388 with the prepayment adjustment line (fixture) | 200 | PASS | CLEARED | — | none |
| 381 credit note against the 386 (fixture) | 200 | PASS | CLEARED | — | none |
| 386 simplified (fixture, informational) | 200 | PASS | — | REPORTED | none |
| **386-1 (real rows)** | 200 | **PASS** | **CLEARED** | — | none |
| **388-1, full adjustment (real rows)** | 200 | **PASS** | **CLEARED** | — | none |
| **386-2 (real rows)** | 200 | **PASS** | **CLEARED** | — | none |
| **388-2, partial adjustment (real rows)** | 200 | **PASS** | **CLEARED** | — | none |
| **381-2 against 386-2 (real rows)** | 200 | **PASS** | **CLEARED** | — | none |
| planted BR-KSA-73 | 202 | WARNING | CLEARED | — | WARNING BR-KSA-73, WARNING BR-KSA-80 |
| planted BR-KSA-74 | 400 | ERROR | NOT_CLEARED | — | ERROR BR-KSA-74, WARNING BR-KSA-80 |
| planted BR-KSA-75 | 202 | WARNING | CLEARED | — | WARNING BR-KSA-75, WARNING BR-KSA-80 |
| planted BR-KSA-79 | 202 | WARNING | CLEARED | — | WARNING BR-KSA-79 |
| planted BR-KSA-80 | 202 | WARNING | CLEARED | — | WARNING BR-KSA-80 |
| planted BR-KSA-56 | 202 | WARNING | CLEARED | — | WARNING BR-KSA-56 |
| planted BR-CO-16 | 202 | WARNING | CLEARED | — | WARNING BR-CO-16 |

Two things the negatives teach, recorded so they are not re-learned: (1) **the sandbox CLEARS a document that breaks a prepayment rule** — every one of BR-KSA-73/75/79/80/56 and BR-CO-16 is a WARNING with `clearanceStatus: CLEARED`; only BR-KSA-74 is an ERROR — so a check that reads `CLEARED` alone would pass a wrong document, and every assertion here reads `status: PASS` with an empty warning list; (2) **the live rule set carries BR-KSA-73…80**, which the shipped SDK's 2021 schematron does not — the direction the divergences log §15 predicted, now observed rather than reasoned.

## 16.3 The field matrix, on the real-row documents

| Field | 386 | 388 (full / partial) | 381 against the 386 |
| --- | --- | --- | --- |
| `InvoiceTypeCode` / `@name` | 386 / 0100000 | 388 / 0100000 | 381 / 0100000 |
| `UUID`, `ID`, `IssueDate`, `IssueTime` | the row's `zatca_uuid`, number, `issued_at` split (UTC) | as the row | as the row |
| `BillingReference` | none | none | `InvoiceDocumentReference/ID` = the 386's number (BR-KSA-56); `InstructionNote` = the reason (BR-KSA-17) |
| Tax category / rate | S 15.00 | S 15.00 (supply); KSA-33 S, KSA-34 15.00 (adjustment) | S 15.00 |
| Taxable / VAT / inclusive | 10,000 / 1,500 / 11,500 | 30,000 / 4,500 / 34,500 · 20,000 / 3,000 / 23,000 — the FULL supply in the tax totals | 6,000 / 900 / 6,900 |
| `PrepaidAmount` | 0.00 | 11,500 · 4,600 = Σ(KSA-31 + KSA-32) | 0.00 |
| `PayableAmount` | 11,500 | 23,000 · 18,400 = inclusive − prepaid | 6,900 |
| The adjustment line | — | line 2: quantity 0, extension 0, tax 0, rounding 0, price 0; `DocumentReference` KSA-26 number · UUID · KSA-28 date · KSA-29 time · KSA-30 386; KSA-31 10,000 · KSA-32 1,500 (partial: 4,000 · 600) | — |
| Seller / buyer | VAT `310123456789013`, "Al-Rashid Trading Est." / VAT `311987654321003`, "Beta Logistics Co." with the full national address (standard, BR-KSA-10) | same | same |
| ICV / hash | issued in order, none reused, hash present on every row | | |

The arithmetic the sandbox enforces is also computed from each document itself in the suite: KSA-32 = KSA-31 × KSA-34 / 100, BT-113 = Σ(KSA-31 + KSA-32), BT-115 = BT-112 − BT-113.

## 16.4 The shipped SDK, on the real-row documents

| Document | XSD | EN 16931 | BR-KSA (2021 set) | Errors |
| --- | --- | --- | --- | --- |
| 386-1 | PASSED | PASSED | FAILED | `BR-KSA-05` only — the pinned divergence (divergences log §15), now measured on the artefact |
| 388-1 with the adjustment | PASSED | PASSED | PASSED | none (the set has no prepayment rule; the sandbox, above, has) |
| 381-2 against 386-2 | PASSED | PASSED | PASSED | none |

🔴 **A harness defect diagnosed and fixed here, not a document defect:** on this Windows machine the SDK's own `-sign` rewrote any document containing non-ASCII text (the product's "Credit of advance — …" line) into an XSD-invalid file — Java 17's default charset is the ANSI code page. The same bytes are accepted by the sandbox. Both SDK harnesses (`ubl-zatca-validator.test.ts`, the AP-4 suite) now run the JVM with `-Dfile.encoding=UTF-8`, under which the same document passes XSD/EN/KSA. The AP-3 note in §15.4 is superseded by this paragraph; the AP-3 fixture's ASCII reason stays as it is (harmless).

## 16.5 The accounting check — against the AS-BUILT shape, unchanged

Asserted from the journal in the same run, against §14/§15 and NOT against a single-entry receipt form: **E1** the receipt `Dr Bank 11,500 / Cr Customer deposits 11,500`, gross, dated the receipt (Batch 1B, unchanged); **E2** the 386's SEPARATE entry `GL-<386>`: `Dr Customer deposits 1,500 / Cr VAT Payable 1,500`; **E3** the 388: `Dr AR 23,000 · Dr deposits 10,000 / Cr Sales 30,000 · Cr VAT 3,000` (partial: `AR 18,400 · deposits 4,000 / Sales 20,000 · VAT 2,400`); **E5** the note: `Dr VAT Payable 900 / Cr Customer deposits 900`, dated the note; the refund `Dr Customer deposits 6,900 / Cr Bank 6,900`; every entry balanced. Nothing in AP-4 changed any of it.

🔴 **The open accountant question — whether the advance's VAT belongs to the receipt's period or to the 386's issuance period — and where the sandbox evidence bears on it: NOWHERE.** The compliance endpoint validates a document's construction; its response carries no reference to the receipt date, the ledger, a VAT period or a return. The only date it reads is the 386's own `IssueDate`/`IssueTime` (and, on the 388, the same two copied into KSA-28/29), which it accepted as built (issuance instant, UTC). Nothing observed constrains the answer in either direction; the question stays with the accountant, and the as-built split (E1 at the receipt, E2 at the 386) stands until they answer.

## 16.6 What remains — exactly

| Item | Who | Status |
| --- | --- | --- |
| **Simulation and production** (M12.7 / M12.9) for these three shapes | the owner (the entity) | Blocked as for every document type — a registered Saudi entity with ERAD credentials does not exist. The sandbox exercises the same API surface; no rework is expected, and none is assumed. |
| **PIH continuity across a 386 → 388 → 381 sequence** | — | Not attested by the compliance endpoint (it accepts a genesis PIH on every document); guarded locally by the hash-chain suite as for every document. |
| **The VAT-period question** | the accountant | Open (§16.5). No evidence from AP-4 either way. |
| **Z1** | ZATCA | Unchanged and asserted shut. |
| **KSA-5 on a 386** | engineering | Unchanged (§14.6); the sandbox accepted the issue date as `ActualDeliveryDate` on every 386 submitted — which says it is VALID, not that it is the intended supply date. |
| **B2C advances (G-VAT-4)** | — | Out of scope; the simplified 386 was REPORTED by the sandbox (informational only). |
