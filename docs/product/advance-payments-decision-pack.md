# Advance payments / customer deposits — gap analysis and decision pack (2026-09-20)

**Status (2026-09-20): RESEARCH ONLY. Nothing here is implemented; no schema, service, test, seed or configuration was changed to write it.** The Batch 1B payment core that this pack builds on is IMPLEMENTED and merged (`main` `a290d079`; record: known-issues file, "BATCH 1B — CLOSED 2026-09-17"). Current state authority: [CLAUDE.md §2](../../CLAUDE.md).

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
XML: lines 30,000 / tax 4,500 (full), one prepayment adjustment line (KSA-31 10,000, KSA-32 1,500, S, 15), `PrepaidAmount` 11,500, `PayableAmount` 23,000. Return: box 1 +30,000, box 6 +3,000 in this period (the 1,500 was in E2's period). Allocation row: receipt → this invoice, 11,500, folded.

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

### ACCOUNTANT — three items, one list (send as written)

> **A1 — Which receipts are "Consideration … prior to a Taxable Supply"?** Saudi Ledger will ask the user to classify every unapplied receipt as (a) an advance for a taxable supply — an advance tax invoice (type 386) is then due by the 15th of the following month; (b) an erroneous or duplicate payment — VAT-silent until applied or refunded; (c) a refundable security deposit — VAT-silent (we found NO KSA text on security deposits; the IR has no deposit article); (d) unknown — listed on the VAT-return page until classified, nothing posted. Please confirm (b) and (c) are not consideration and carry no VAT until applied, and whether "unknown" older than one tax period should be treated as (a) by default for the reminder (never for a posting).
> *Why it matters:* it decides which deposits the platform must demand a 386 for. *Evidence:* Agreement Art. 23(1); IR Art. 53(1)(a)(2); no source on security deposits. *Decision:* policy on (b)/(c) and the default for (d). *Who:* accountant (VAT).

> **A2 — The GL shape of the advance tax invoice and its adjustment.** Proposed: at the 386, `Dr Customer deposits (VAT part) / Cr VAT Payable` — the deposit then reads as the net contract liability (IFRS 15.47 excludes VAT collected for the government); at the final 388, ONE entry `Dr AR (net due) · Dr Customer deposits (net advance) / Cr Revenue (full) · Cr VAT Payable (full − advance VAT)`, with the deposit's allocation folded into that entry. The alternative is a gross 388 plus a separate allocation entry that also reverses the advance VAT. Balances are identical; the difference is which entry carries the VAT and whether the deposit is shown gross or net after the 386. Please confirm the proposed shape, or name the other.
> *Why it matters:* every reader (statement, position, return, invariants) is written to one shape. *Evidence:* IFRS 15.47/106; Odoo posts the net shape (cited above); ERPNext posts the tax on the receipt. *Decision:* presentation policy. *Who:* accountant (accounting policy).

> **A3 (low priority, not blocking) — The date of a later allocation.** Today a deposit allocated to an existing invoice posts on the day of the click. Should it instead post on the invoice date when that month is still open (the contract liability is discharged by performance, IFRS 15.106), with the click date only when the invoice month is closed? Default if unanswered: unchanged (click date).

### ZATCA — already asked, not re-asked

> **Z1** — 1C pack §16.14.9, item 2: may `PrepaidAmount` reference an advance-payment invoice issued by a PREVIOUS solution by IRN, date and time when its UUID is unknown? Until answered, a final invoice against a migrated `invoiced` advance is REFUSED with this item named (G-Z-4). **New fact for the same enquiry, not a new question:** the shipped SDK rules (2021-08-19) contain no 386/KSA-30…34 validation; the sandbox compliance endpoint is the only local proof available (AP-4).

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
| **AP-2 — the advance tax invoice (386)** | `document_type = 'advance_invoice'`; create-from-deposit (customer, receipt, amount ≤ the receipt's un-invoiced remainder, category/rate lines); approval → E2 entry, ICV, hash, QR, outbox; UBL type 386; PDF titled correctly; `documentSign` and every reader audited by grep (`document_type` sites — the standing check part 6: tests asserting three types); the receipt carries `invoicedAmount`; the statement shows the 386 as a zero-movement event; ledger invariant: Σ VAT on 386s per customer = the deposit's VAT split. | **A1, A2**; XML Standard ¶9.5 read | ~1.5 weeks |
| **AP-3 — the final invoice's adjustment + the refund precondition** | On invoice create/edit: select this customer's open 386s (and migrated `invoiced` advances — refused with Z1 named); store the adjustment per category (KSA-31…34, BT-113); approval → E3 entry + folded allocation; UBL: adjustment lines + PrepaidAmount + PayableAmount (Odoo's node shapes as the reference, validated against ¶9.5); VAT return reads 386s in their period and 388s net; `refund` refuses an invoiced advance without a cleared/reported 381 on the 386; credit note against a 386 (E5). | AP-2; **Z1** for the migrated arm only | ~1.5–2 weeks |
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
