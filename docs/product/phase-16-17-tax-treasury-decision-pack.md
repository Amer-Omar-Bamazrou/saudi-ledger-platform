# Phase 16 + Phase 17 — Saudi Tax Expansion; Treasury

**Status (2026-10-05): decisions written BEFORE the code, from the research in
§1; built on branch `feat/phase16-17-tax-treasury` (from `main` @ `447106a6`)
— as built §12, the joint audit §13, the accountant's answers to the three
HIGH items §14. The PR stays OPEN for the owner's review; nothing is merged.**
Current state authority: [CLAUDE.md §2](../../CLAUDE.md).

Every rule below carries exactly one label (the escalation protocol §6, in the
owner's 2026-10-04 vocabulary):

| Label | Meaning |
|---|---|
| **REQUIRED** | An `AUTHORITATIVE REQUIREMENT` — a Saudi primary text (the Arabic prevails) or a standard, read and cited. |
| **PRACTICE** | `ESTABLISHED ACCOUNTING PRACTICE` from a reputable secondary source. |
| **PRECEDENT** | `ODOO IMPLEMENTATION` / `ERPNEXT IMPLEMENTATION` — evidence about software, never law. |
| **PRODUCT** | `SAUDI LEDGER PRODUCT DECISION` — no Saudi, VAT, ZATCA or accounting-policy consequence, or a fail-closed default that makes none. |
| **OPEN** | `ACCOUNTANT DECISION REQUIRED` — listed once in §11; the build takes the fail-closed default named beside it and builds NOTHING interpretive past it. |
| **LIMITATION** / **FUTURE** | What is deliberately not built, and why. |

---

## 0. Referent check — the scope anchors and what the repository had already decided

The owner's 2026-10-04 instruction names **Phase 16 — Saudi Tax Expansion**
(WHT full workflow, Zakat, income tax where applicable, tax adjustments, tax
reports, Saudi statutory reporting) and **Phase 17 — Treasury** (cash
position, liquidity, forecasting, expected inflows/outflows, payment
scheduling, funding requirements, a treasury dashboard). The repository does
not contain that roadmap; these names are taken from the instruction, as
Phase 14/15 did (their pack §0).

What the repository had already decided, and how this pack treats it:

| Prior record | What it says | Treatment here |
|---|---|---|
| `design-zakat-module.md` Q1 (owner, 2026-08-15) | A **Zakat Base Working Paper**; the platform does **not** submit to ZATCA | KEPT |
| Q2 | 100 % Saudi/GCC-owned entities only in v1 | KEPT (and §3.6: the split itself is now text-settled, its mechanics are not) |
| Q3 | Hijri and Gregorian years; Gregorian rate `2.5 % × days ÷ 354` | KEPT as the owner's decision; the text says "the days of the Hijri year" (§3.4) — C3 stays OPEN |
| Q4 | The base is built from balance-sheet accounts; the income statement is a **cross-check** | 🔴 **CORRECTED BY THE PRIMARY TEXT** — Arts 23(3), 27 and 28 make adjusted and book net profit **inputs**. Recorded for the owner (§3.2); building to Q4 would compute a figure the Regulations do not define |
| Q5 | An interactive, period-locked worksheet with non-ledger adjustments | KEPT — built as versioned, approved computations (§5) |
| Q6 | Classification moves to the chart of accounts | KEPT — an org-level classification per account (§3.3) |
| Q7 / Q8 | "Under construction" now; an annual report under Tax & Compliance | Q7 retired by the build; Q8 KEPT |
| M17.3 / M17.4 HELD on C10 | "the tax content is unverified"; ask C1 first | The reason was VERIFIED this time from the Arabic text (§3.1): C1 and C4 are settled, C2 is settled but for one residue, C3 is half-settled. 🔴 A queue entry records what someone believed then — the hold's REASON is what was re-checked, not the entry |
| Phase 11 B8 | "WHT is a residency fact only"; blocked on B3 (the supplier-payment path) and on rates-by-nature being an accountant judgment | B3 has since been BUILT. Rates by nature are not a judgment the PLATFORM makes: the user declares the payment's nature, the regulation fixes its rate (§2.3) |
| CLAUDE.md §5 | "Withholding tax (LEGAL exposure) awaits the OWNER'S RANKING" | The 2026-10-04 instruction is that ranking |

---

## 1. Sources (read 2026-10-04)

Primary texts were fetched and read in the session scratchpad; none is
committed (the VAT texts in `docs/zatca/specs/` remain the only pinned
copies — FUTURE: pin these the same way).

| # | Source | Version / date | Read in |
|---|---|---|---|
| S1 | **Income Tax Law**, Royal Decree M/1 (15/1/1425H) — BOE consolidated text https://laws.boe.gov.sa/BoeLaws/Laws/LawDetails/23576008-1ce4-4685-ac3e-a9a700f2cb02/1 | status **ساري (in force)** on 2026-10-04; amendments to M/153 (5/11/1441H) | Arabic (+ BOE official English, PDF 2026-01-25) |
| S2 | **Income Tax Implementing Regulations**, ZATCA consolidated | through MoF Resolution 25 (08/01/1445H); PDF 2024-10-13 | Arabic |
| S3 | **MoF Resolution 25** (amending IR Art. 63) — Umm al-Qura https://www.uqn.gov.sa/details?p=23667 and amendment table p=23668 | published 27/02/1445H = **12-09-2023**, in force from publication (KPMG, secondary, says 15 Sep — unresolved, immaterial) | Arabic |
| S4 | **Implementing Regulations for Zakat Collection**, MoF Decision 1007 (19/08/1445H) as amended by 1248 (11/10/1446H) — https://zatca.gov.sa/ar/RulesRegulations/Taxes/Documents/ZakatRegulation_1445.pdf | Arabic PDF 2025-06-17 (sha256 834e69a5…); English PDF 2026-02-03 (sha256 ae0c746b…) | **Arabic** for every article cited; English in full |
| S5 | Decision 1007 itself — Umm al-Qura https://www.uqn.gov.sa/details?p=24721 | published 21-03-2024; applies to fiscal years starting **on or after 1/1/2024** | Arabic |
| S6 | ZATCA Tax Circular "Implementation of WHT under the Double Taxation Agreement" v1 | Jan 2025 | English |
| S7 | ZATCA user manual "Submit Withholding Tax Return" (Form 06) | PDF 2026-08-26 | English (screens rendered) |
| S8 | SOCPA **Zakat Accounting Standard (Revised)**, board decision 16842/2016 | 19/9/2016; with IFRS from 2017, IFRS for SMEs from 2018 | Arabic (page images) |
| S9 | **Companies Law**, Royal Decree M/132 (1/12/1443H) — BOE; and its Implementing Regulations (Umm al-Qura p=21325, 18-01-2023) | in force | Arabic |
| S10 | Qawaem — qawaem.bc.gov.sa (About, Items, QawaemSM) | read 2026-10-04 | Arabic/English |
| S11 | VAT Implementing Regulations, 2021 English edition (pinned: `docs/zatca/specs/KSA_VAT_Implementing_Regulations_EN.txt`) — "PAYMENT OF TAX" l.2015–2018 | 8th ed. 09/11/2021 (P13-N3: superseded for Arts 40, 50, 53, 54, 63 — not this article) | English |
| S12 | **IAS 7** paras 6–9, 46–50 (IFRS Foundation text, ICAB reproduction) and **IFRS for SMEs 7.2** (3rd ed., Feb 2025, IFRS Foundation module 7) | — | English |
| S13 | IFRS Foundation jurisdiction profile — Saudi Arabia | updated 28 Jul 2022 | English |
| P1 | **Odoo** 17.0 @87bb9321 and 18.0 @7f553b66: `addons/l10n_sa/data/template/account.tax-sa.csv`, `addons/account/models/account_tax.py`, `addons/l10n_account_withholding_tax` (18.0), `account_move.py`, `account_payment.py`, `account_journal_dashboard.py` | 2026-10-03 | source |
| P2 | **ERPNext** version-15 @4cea6a7f (v15.121.6): `tax_withholding_category`, `tax_withholding_rate`, `purchase_invoice.py`, `payment_entry.py`, `payment_order`, `payment_request`, `accounts_receivable.py`, `bank_reconciliation_statement.py` | 2026-09-30 | source |
| P3 | OCA `mis_builder_cash_flow` 17.0 (`report_mis_cash_flow.py`, `models_mis_cash_flow_forecast_line.py`) | — | source |

Withdrawn / not current, recorded so it is not mistaken for authority: ZATCA's
2021 English WHT Guideline v1.0 (withdrawn from zatca.gov.sa ~March 2023;
read from the Wayback copy, it calls itself non-binding); the October 2023
**draft** new Income Tax Law and the September 2023 draft Art. 68 amendment
(**NOT IN FORCE** — the BOE text still shows the 1425H law and the original
68(أ)).

---

## 2. Phase 16A — Withholding tax (WHT)

### 2.1 The rule (REQUIRED)

| Rule | Source |
|---|---|
| Every **resident, whether or not a taxpayer**, and every PE of a non-resident, that pays an amount to a **non-resident** from a source in the Kingdom withholds tax from the amount paid. A fully Saudi-owned, Zakat-only company is a resident non-taxpayer and **must withhold**. | S1 Art. 68(أ) with Art. 1 definitions |
| Residency: a company formed under the Companies Law or centrally managed in KSA (Art. 3). Source: Art. 5 (activity, property, rent of movables used in KSA, royalties, dividends and management fees from a resident company, services paid by a resident performed wholly or partly in KSA…); the place of payment is irrelevant (5(B)). | S1 Arts 3, 5 |
| The trigger in the text is **PAYMENT**: remit "within the first 10 days of the month following the month of payment to the beneficiary". | S1 Art. 68(B)(1); S2 Art. 63(9)(أ) |
| The base is "the gross amount" — "the full amount paid to the non-resident regardless of any expense incurred to earn it". | S2 Art. 63(1), 63(8) |
| A monthly withholding statement on ZATCA's form within the first 10 days of the following month; an annual withholding information return within **120 days** of fiscal year-end (partnerships 60). | S2 Art. 63(9)(أ),(ب) |
| Give the beneficiary a certificate of the amount paid and the tax withheld; at year-end give ZATCA each beneficiary's name, address and registration number if available. | S1 Art. 68(B)(2),(3) |
| Records: beneficiary name and address, payment type, amount, tax withheld, supporting documents — kept at least **10 years after payment**. | S2 Art. 63(9)(ج) |
| Delay fine: **1 % of unpaid tax for every 30 days** of delay, from the due date; no fine for a delay under 30 days. The withholder is **personally liable** for tax it failed to withhold or remit. | S1 Arts 68(C), 77(A); S2 Art. 68(1)(هـ), 68(2) |
| WHT cannot be paid in instalments. | S2 Art. 65(1)(ج) |
| A treaty prevails over the Law (except anti-avoidance). Relief **at source** requires a ZATCA **approval** obtained on the portal (residency certificate, request form, authentication, the Q/7C undertaking); otherwise withhold at the domestic rate and claim a refund. | S1 Art. 35; S6 §§4.1–4.2 |

### 2.2 The rates — versioned, never a literal in code (REQUIRED)

IR Art. 63(1) as amended by **Resolution 25, in force 12-09-2023** (S2, S3):

| Code | Payment (IR 63(1)) | Rate | Form 06 row |
|---|---|---|---|
| `rent` | Rent | 5 % | 01 |
| `royalty` | Royalty or proceeds | 15 % | 02 |
| `management_fee` | Management fees (63(2): management-service contracts) | 20 % | 03 |
| `air_tickets_or_air_freight` | International travel tickets departing KSA, or air freight (63(4)) | 5 % | 04 |
| `sea_freight` | Sea freight (63(4)) | 5 % | 05 |
| `intl_telecom` | International telephone services (63(5): excluding interconnection, transit, roaming — Res. 484) | 5 % | 06 |
| `dividends` | Dividends (63(6)) | 5 % | 09 |
| `technical_consulting` | Technical or consulting services (63(3)) — **whoever receives them** since Res. 25 | 5 % | 10 |
| `loan_returns` | Loan returns | 5 % | 11 |
| `insurance_premiums` | Insurance or reinsurance premium | 5 % | 12 |
| `other_payments` | Any other payments — services not listed (63(7)) | 15 % | 13 |

- Stored in a **global, effective-dated reference table `wht_rates`**
  (`effective_from = 2023-09-12`, `effective_to` open), seeded by migration,
  readable by tenants, writable by nobody but the owner role. Every
  withholding stores the **rate it applied and the rate row's id** — a later
  rate change never rewrites history. (PRECEDENT: ERPNext
  `Tax Withholding Rate` from/to dates with overlap refusal.)
- 🔴 **A payment dated before 2023-09-12 is refused** (`wht_rate_not_loaded`):
  the pre-Resolution-25 schedule had a 15 % related-party band for technical
  services that this product does not model. PRODUCT (fail-closed).
- Form rows 07/08 (services to head office / associated company) survive on
  the form though Res. 25 removed their separate band → **OPEN W-4**; the
  return groups by the codes above and says so.

### 2.3 Classification is the USER's declaration; the rate is the regulation's (PRODUCT)

The Phase 11 pack stopped at "classifying a payment's nature is an accounting
judgment this platform must not guess". It does not guess: a payment to a
**non-resident** supplier must carry **a declared nature** — chosen per
payment, or taken from the supplier's own **declared default**
(`vendors.wht_default_payment_type`, set by a person, shown and changeable in
the pay dialog) — exactly as a bill line carries a declared VAT category.
Neither declared → **422 `wht_classification_required`**, never a default rate.

- **Not subject, by name** (each recorded with the reason, rate 0, in the
  return's excluded list): `goods` — a payment for goods (Art. 68 lists no
  goods; IR 63(7) "other payments" are SERVICES) — REQUIRED by text; and
  `not_kingdom_source` (Art. 5) with a mandatory written explanation.
- **Treaty relief** (`vendor_wht_treaty_reliefs`): a reduced rate for one
  supplier and one payment nature, valid only with a recorded **ZATCA
  approval reference** and residency-certificate reference, inside its
  validity window, and only once **approved by an approver** in this product.
  The refund route is outside the product (LIMITATION).
- **Residency `unknown`** (the default since B8): the payment proceeds with
  **no** withholding, and the payment is listed as a **WHT exception** —
  "paid without a residency declaration" — with the true count, on the WHT
  page. PRODUCT, and its reason: refusing every payment to an undeclared
  supplier would block the whole existing AP flow on a fact most suppliers
  (residents) do not change; leaving it silent would hide a legal exposure
  (Art. 68(C)). 🔴 *Who finds out?* — the exception list does. A supplier
  later re-declared `non_resident` surfaces every past payment to it with no
  withholding as **"possibly missed withholding"**.
- Residency `resident` → no WHT (no WHT between residents — S1 Art. 68(أ)).
- A non-resident's bill in a currency other than SAR is refused
  (`wht_currency_unsupported`; Art. 30(B) SAMA rate on "the date of the
  transaction" → OPEN W-11).

### 2.4 The accounting event — at the existing pay paths, never a third (REQUIRED trigger; PRODUCT entry shape)

**One writer per effect:** WHT is computed INSIDE the two existing supplier pay
paths — `payBill` (`services/bills.payment.ts`) and
`supplierPaymentsService.create` — through one shared function
(`services/tax/wht.ts`). No new payment path exists.

```
Bill payment of A (the AP amount settled), WHT w = round2(A × rate):
  Dr Accounts Payable (vendor)   A
    Cr <the bank's cash account>      A − w
    Cr WHT_PAYABLE                    w
Supplier payment of A to a non-resident (allocations + on account):
  Dr AP (allocated part) / Dr <on-account asset> (rest)    A
    Cr <bank>  A − w   ·   Cr WHT_PAYABLE  w
```

- `bill_payments.amount` / `bills.paid_amount` / `supplier_payments.amount`
  keep their meaning — **what the SUPPLIER is credited with** — so
  `billPosition`, the supplier statement and the subledger invariants are
  untouched. The **cash** that left is `A − w` and is the bank line.
  (PRECEDENT: ERPNext Purchase Invoice "Deduct" row reduces the payable to
  the supplier; Odoo 18 `l10n_account_withholding_tax` withholds on the
  payment. Odoo 17 `l10n_sa` books WHT on the BILL as payer-borne expense — a
  different, payer-borne model, NOT followed.)
- A WHT record `wht_withholdings` per event: source (bill payment | supplier
  payment), supplier, payment date, period `YYYY-MM` of the payment date,
  nature, base, rate, rate row, treaty relief (if any), WHT, journal entry,
  status `withheld` | `not_subject` (+ reason). Append-only at the database.
- 🔴 **`WHT_PAYABLE` has exactly two writers** — a withholding and a
  remittance (and the reversal of a remittance). A deferred trigger refuses
  at COMMIT any journal line on a `WHT_PAYABLE` account whose entry no WHT
  record owns. A manual journal entry or a categorised bank line can no
  longer move it, so **GL `WHT_PAYABLE` = Σ withheld − Σ remitted, exactly**
  (invariant W1) by construction, not by hope.
- The generic journal reverse refuses an entry a withholding or remittance
  owns (the 0107 owner mechanism, extended).
- An advance paid to a non-resident is withheld at the payment (the trigger is
  payment); its later allocation to a bill withholds nothing again.
- **Refunding on-account money from a payment that bore WHT is refused**
  (`wht_refund_unsupported`): the supplier returns what it received, and the
  withheld part is a claim on ZATCA, not on the supplier → OPEN W-12.
- **Payer-borne WHT / gross-up is NOT built** → OPEN W-2. Only "withheld from
  the payment" exists; the pay dialog says so.

### 2.5 Remittance, reversal, return (REQUIRED dates; PRODUCT workflow)

- **Remit a month** (`POST /tax/wht/periods/:period/pay`, approver authority):
  amount ≤ the month's unremitted WHT; optional **delay fine actually paid**
  posted to `TAX_PENALTIES` (an expense — a fine is a cost, not a tax);
  `Dr WHT_PAYABLE / Dr TAX_PENALTIES / Cr bank`, period-lock-checked, naming
  the bank (D-3). Due date = **the 10th of the following month** (S2 63(9)(أ)).
- **Reverse a remittance** (`POST /tax/wht/remittances/:id/reverse`, reason
  required): a mirror entry; refused while a bank statement line is
  reconciled to it (the transfer rule, Phase 12C).
- **The monthly return** (`GET /tax/wht/returns/:period`): rows per Form 06
  line (payment total, tax withheld), the per-beneficiary schedule (name,
  country, registration number, nature, base, rate, WHT, date, document),
  excluded payments with their reasons, remitted, outstanding, due date,
  status (`not_due` · `due` · `overdue` · `remitted`) and the **statutory
  delay-fine estimate** (1 % per full 30 days on the unpaid tax — an
  estimate, never posted). CSV/PDF export.
- **The annual information** (`GET /tax/wht/annual?fiscal_year=`): per
  beneficiary totals by nature; due 120 days after the fiscal year-end.
- **The beneficiary statement** (Art. 68(B)(2)): per supplier and month, the
  amounts paid and withheld — CSV/PDF. Labelled a statement from the payer;
  ZATCA's own certificate is issued by its e-service after filing (S7).
- Not filed with ZATCA from here (no API exists for it; LIMITATION).

---

## 3. Phase 16B — Zakat

### 3.1 C10, verdict by verdict (Arabic text, S4)

| C10 item | Verdict | Article |
|---|---|---|
| **C1** minimum base | **SETTLED BY TEXT** — Art. 27 (an alternative minimum, on the results of the activity) and Art. 28 (a maximum). No percentage cap on any deduction. | 27, 28 |
| **C2** what composes the base | **SETTLED BY TEXT** (Arts 23–56) — residue **OPEN Z-2**: whether contra-asset allowances (ECL, obsolescence, impairment) are "provisions and equivalents" under Art. 24 | 21, 23–26, 29 |
| **C3** Gregorian rate | Formula **SETTLED** (Art. 15(2)): `rate = (2.5 % ÷ days of the Hijri year) × days of the payer's year`. The divisor's value (fixed 354 vs that year's 354/355) and any rounding rule are **NOT in the text** → **OPEN Z-1**; owner decision Q3 (÷ 354) applies meanwhile | 15 |
| **C4** nisab | **SETTLED BY ABSENCE** (validated search: نصاب / ذهب / الحول / nisab → 0 hits; known-present الحد الأدنى → 13) | 15(1) |
| **C5** mixed ownership | Split **SETTLED** (Zakat on the Saudi/GCC share, income tax on the rest; ownership measured at year-end, Art. 13(4)); mechanics (Art. 27/28 before or after the split) **OPEN Z-5**; v1 keeps Q2 | 3(3), 6(1), 13(4) |

### 3.2 🔴 Q4 corrected (REQUIRED, recorded for the owner)

Q4 made the income statement a cross-check. The text makes it an input in
three places: **Art. 23(3)** adds the difference between adjusted and book
net profit; **Art. 27** floors the base on adjusted net profit; **Art. 28**
caps it with equity plus that difference. The worksheet therefore computes
**book net profit** (the Phase 14 income statement for the fiscal year — one
seam) and **adjusted net profit** (book + the declared Art. 62–65
adjustments). Q4 is superseded by the Regulations it was trying to follow;
the owner is told, not asked (§11).

### 3.3 The account classification — the user's, by article (REQUIRED structure; PRODUCT mechanism)

Art. 9: SOCPA-endorsed standards govern classification; Art. 17: values as
shown in the year-end statement of financial position. Every balance-sheet
account carrying a balance at the year-end gets ONE class (org-level, on the
chart — Q6):

| Class | Article | Notes |
|---|---|---|
| `equity` | 23(1), 36–41 | Equity-type accounts are `equity` automatically (Art. 9: the account's own SOCPA type). Partners' loans meeting Art. 30's conditions, declared-unpaid dividends (Art. 36) — the user classifies them here |
| `provision_as_equity` | 24 | Provisions at the closing balance — except end-of-service and statutory-leave provisions |
| `noncurrent_liability` | 29(1) | Incl. end-of-service/leave provisions (Art. 24), deferred tax liability, lease and contract liabilities |
| `current_liability` | 29(2) | |
| `noncurrent_asset_deducted` | 26(1)–(5), (7)–(10); 43–51, 55, 56 | Net fixed assets and equivalents (Art. 49 list), intangibles not for trading (50), qualifying investments (43–45 — the user asserts the conditions), deferred tax assets. Contra accounts (accumulated depreciation) take the class of their asset so the deduction is NET (Art. 48(1)(b)) |
| `noncurrent_asset_not_deducted` | 42, 48 | e.g. held-for-trading, assets held for resale |
| `current_asset_deducted` | 26(6), 32, 52 | Raw materials not for sale, qualifying overdue government receivables |
| `current_asset_not_deducted` | 26 (residual), 42, 52 | Cash, receivables, inventory for sale… |

- **Unclassified accounts with a balance BLOCK the computation, named**
  (`zakat_unclassified_accounts`) — never a default class.
- **Suggestions** are offered only for system accounts whose class follows
  from their system role (e.g. `AR` → `current_asset_not_deducted`), pre-
  selected and **confirmed by a person** (the M16 "accepting is the review"
  principle). Nothing is classified without a person.
- Leaf accounts only (the M17.3 grain question: "no silent mode").

### 3.4 The computation (REQUIRED formulas; each step shown with its article)

Inputs, all as of the fiscal year-end, from the Phase 14 balance sheet and
income statement (one seam; migrated opening amounts included as Phase 14
includes them):

```
E   = Σ equity (incl. the computed prior-years and current-year result)  [23(1)]
P   = Σ provision_as_equity                                               [24]
NCA = NCA_d + NCA_n ;  CA = CA_d + CA_n ;  NCL ;  CL
D   = NCA_d + CA_d                                     (deductions)       [26]
NCL_excl  = Σ over each undeducted non-current account u : min(u, u ÷ NCA × NCL)   [25(1)]
CL_add_a  = Σ over each deducted current account d     : min(d, d ÷ CA × CL)       [25(2), 29(2)(a)]
CL_add_b  = max(0, CL − CA)                                                         [29(2)(b)]
L_added   = min(D, (NCL − NCL_excl) + CL_add_a + CL_add_b)                          [23(2), 25(4)]
Diff      = adjusted NP − book NP                                                   [23(3)]
Base_m    = E + P + L_added + Diff − D                                              [21]
Undeducted assets = total assets − D                                                [Art. 1]
Floor  [27]: if adjusted NP > 0 and Base_m < adjusted NP → base = min(adjusted NP, Undeducted + Diff)
             if adjusted NP ≤ 0 and Base_m < 0           → no base (0)          [27(3)]
             if adjusted NP ≤ 0 and Base_m ≥ 0           → base = Base_m        [27(4)]
Ceiling [28]: base ≤ E + P + Diff
Zakat = round_half_up_to_halala( base × 2.5 % )                         (Hijri year)
      = round_half_up_to_halala( base × 2.5 % ÷ 354 × days of the year ) (Gregorian; Q3, Z-1 OPEN)
```

- The Art. 25 / 29(2) combination (`CL_add_a` + `CL_add_b`, then the 25(4)
  cap) is the text applied clause by clause; whether ZATCA combines them so
  is **OPEN Z-6**, and every term is on the page so an adviser can check it.
- **The computation's own accrual is excluded from its inputs** (the
  current-year Zakat charge is not in E or book NP when the base is
  computed) — the only deterministic reading of an otherwise circular
  definition; **OPEN Z-3** asks whether ZATCA expects otherwise.
- Rounding: once, on the final amount, half-up to the halala (the product's
  money seam, `lib/money.ts`); no rounding of the rate. PRODUCT.
- Scope: `zakatScopeFor(ownership_type)` must be `eligible` — 🔴 the M17.1
  obligation finally has its production caller. A declared fiscal year is
  required (M20 F8). A fiscal year starting before 1/1/2024 is refused
  (`zakat_regulations_not_in_force` — Decision 1007 item ثالثاً). Short
  first/final periods (Art. 15(3)–(4)) are not modelled: a budget-style
  frozen 12-month fiscal year only (LIMITATION).
- 🔴 **The arbitrary basis (ZP-AA, Arts 82–91)** applies to a payer with no
  financial statements and no obligation to issue them; this product keeps a
  full ledger, so it computes the base method only; whether a sole-
  proprietorship tenant is nonetheless ZP-AA → **OPEN Z-8**.

### 3.5 Recognition (REQUIRED — SOCPA Zakat Standard, S8)

- Zakat is an **expense**, measured and recognised for each financial period
  (paras 4, intro 6), presented as **a separate line in the income statement**
  (para 6) — so `ZAKAT_EXPENSE` is presented in its own section,
  "Zakat and income tax", below "Profit before Zakat and income tax"; differences
  on final assessment are recognised under IAS 8 (para 5).
- On approval of a computation version: `Dr ZAKAT_EXPENSE / Cr ZAKAT_PAYMENT`
  (the existing liability that bank lines categorised "zakat" already settle
  — promoted to a protected system account, displayed "Zakat payable"),
  for the **difference** between this version's Zakat and what earlier
  versions of the same computation accrued. Dated the fiscal year-end if that
  period is open; otherwise the current business day, recorded as a change
  in estimate (S8 para 5; IAS 8.36) — **never re-dated into a closed
  period, never silently skipped**.
- Payment: the existing paths (a bank line categorised to Zakat payable, or a
  journal entry). Due **120 days** after year-end (Art. 102(1); a holiday
  moves it to the next working day — not modelled, LIMITATION).

### 3.6 Not built (LIMITATION / FUTURE)

Mixed and foreign ownership (Q2, Z-5); ZP-AA; consolidated returns (Art. 16);
filing (Q1); the Art. 25 placement for a single asset across classes; real-
estate Art. 73 (Decision 1248); disclosure note generation (S8 para 7 lists
it — the working paper carries the components, the note is FUTURE).

---

## 4. Phase 16C — Income tax, where applicable

| Rule | Label | Source |
|---|---|---|
| Resident capital companies are taxed on the shares **owned by non-Saudis** (GCC treated as Saudi); the base is "the non-Saudi partners' shares of its taxable income". | REQUIRED | S1 Arts 2(a), 6(a); S2 Art. 1(1)(a) |
| Rate **20 %** (Art. 7); natural gas 20 %, oil/hydrocarbons 85 % — **not supported** (no tenant flag; refused by name). | REQUIRED / LIMITATION | S1 Art. 7 |
| Depreciation deductible is the **Art. 17 pool**, not book depreciation — the product already computes the pool (FA-1). | REQUIRED | S1 Art. 17; fixed-assets pack §24 |
| Non-deductible items (Art. 13 / Regs 10), provisions (Art. 15, Regs 9(6)), bad debts (Art. 14) — **the user declares** them as adjustments with their article; the platform cannot know which expense fails. | REQUIRED rules; PRODUCT mechanism | S1 Arts 12–15; S2 Arts 9–10 |
| Losses carried forward indefinitely, deduction ≤ **25 %** of the year's profit; only losses in audited statutory accounts; a ≥ 50 % ownership change blocks them. | REQUIRED | S1 Art. 21; S2 Art. 11 |
| Return and payment within **120 days** of year-end; CPA certification above SAR 1m. | REQUIRED | S1 Arts 60(b), 69 |

The computation (versioned and approved like Zakat, §5):

```
Profit before Zakat and income tax (FY, Phase 14 income statement, the tax lines added back)
+ book depreciation (the fixed-asset register's depreciation for the FY)
− Art. 17 tax depreciation (the pool engine, for the FY; a pool that cannot compute BLOCKS, named)
± declared adjustments (each with reason and article)
= taxable income
− loss carried forward used = min(declared available losses, 25 % × taxable income)   (taxable income > 0)
× the non-Saudi share (companies.foreign_ownership_pct; FOREIGN = 100)
× 20 %   → round half-up to the halala
```

- Scope: `FOREIGN`, or `MIXED` with a declared share. 🔴 **MIXED with
  declared losses is refused** (`income_tax_mixed_losses_open`): whether the
  25 % cap and the losses apply before or after the share → **OPEN I-1**.
  `SAUDI_GCC` → not applicable (Zakat applies).
- Recognition on approval: `Dr INCOME_TAX_EXPENSE / Cr INCOME_TAX_PAYABLE`,
  the same difference-and-dating rule as Zakat (§3.5). Current tax only.
  🔴 **Deferred tax (IAS 12 / IFRS for SMEs s.29) is NOT computed** — an
  income-tax payer's statements are not complete in that respect
  (LIMITATION, stated on the computation page).
- Advance payments (Art. 70) — the text's threshold wording was not settled
  in this pass → FUTURE.
- IT Regs Art. 56(2)(a) ("the computer located in the Kingdom") bears on
  hosting for income-tax tenants → OPEN for the OWNER (queue C6), not built
  around.

---

## 5. Phase 16D — Tax adjustments: one model, versioned with the computation

- `tax_computations` (company × kind `zakat`|`income_tax` × the **frozen**
  fiscal year — calendar, start month, label, start and end dates, as budgets
  freeze theirs) → `tax_computation_versions` (draft → submitted → approved →
  superseded, through the ONE approval engine) → `tax_adjustments`.
- An adjustment has: **target** (`adjusted_net_profit` or `zakat_base` for
  Zakat; `taxable_income` for income tax), **effect** (`increase` |
  `decrease`), a positive **amount**, a **reason** (required), a **legal
  reference** (required — the article), optional source document reference
  and GL account (for drill-down), who and when. Its **effective period** is
  the computation's fiscal year.
- 🔴 **Adjustments never touch the ledger** — they move only the computation;
  the ONLY ledger effect of a computation is its approval's accrual (§3.5),
  posted forward, never rewriting history.
- Locked at the DATABASE when the version is not a draft (the budget-lines
  trigger pattern); a revision copies them into a new draft.
- On approval the version stores its **snapshot** (every input per account,
  every intermediate, the adjustments, the rate and days) and the
  fingerprint of its inputs; an approved version is shown FROM the snapshot,
  with a live recomputation beside it — **"the ledger has changed since
  approval"** when they differ (a verification is a claim about a moment).

## 6. Phase 16E — Tax reports

All derive from the ledger, the WHT ledger and the approved snapshots —
nothing re-keyed:

| Report | Source | Filters | Export |
|---|---|---|---|
| WHT monthly return | `wht_withholdings` + remittances | period, company scope | CSV / PDF |
| WHT annual information | same | fiscal year | CSV / PDF |
| WHT beneficiary statement | same | supplier, period | CSV / PDF |
| WHT exceptions | payments × residency | — | screen |
| Zakat working paper | balance sheet + income statement + classification + adjustments | fiscal year, version | CSV / PDF |
| Income-tax computation | income statement + register + pool + adjustments | fiscal year, version | CSV / PDF |
| Tax obligations calendar | WHT months, Zakat/income-tax payables, VAT (§8.4) | as of today | screen (feeds Treasury) |

Every figure drills to its source (a withholding to its payment and journal
entry; an account line to the general ledger for the year).

## 7. Phase 16F — Statutory reporting: what is, and is not, established

| Finding | Label | Source |
|---|---|---|
| Every company prepares annual financial statements **per the accounting standards adopted in the Kingdom** and deposits them within **six months** of year-end. | REQUIRED | S9 Art. 17(2) |
| Deposit is **electronic, via Qawaem** (the Saudi Business Center), in **XBRL**; micro/small audit-exempt companies (2 of 3: revenue ≤ 10m, assets ≤ 10m, ≤ 49 staff) fill an online form instead. | REQUIRED (channel/format) | S9 Regs Arts 5, 7; S10 |
| An **auditor** is mandatory except micro/small companies (Art. 19). | REQUIRED | S9 Arts 18–19 |
| The Companies Law prescribes **no layout**; "statutory" means statements under SOCPA-endorsed IFRS / IFRS for SMEs (with SOCPA's added disclosures). | REQUIRED (reading) | S9 Art. 17; S13 |
| SOCPA requires Zakat as a **separate income-statement line** and a Zakat note (components of the base, provision roll-forward, assessments). | REQUIRED | S8 paras 6–7 |

**Determination:** 🔴 nothing this product produces is labelled "statutory".
Its statements (Phase 14) are management statements from the ledger; the
statutory set is the audited IFRS statements filed in XBRL through Qawaem,
which the product does not produce (LIMITATION; whether Qawaem's line-item
lists bind software → OPEN S-1). What IS built because it IS required: the
Zakat and income-tax line presented separately (SOCPA para 6) in the income
statement, and the working paper that carries the Zakat-base components the
SOCPA note needs (para 7).

---

## 8. Phase 17 — Treasury

### 8.1 Authority position

**No Saudi requirement** for a private company's treasury report or cash
forecast was found (search shape in the research record: Companies Law,
CMA OSCO, SAMA liquidity rules — the last binds finance companies only).
IAS 7 supplies the **definition of cash** (paras 6–9: cash on hand and demand
deposits; cash equivalents ≤ ~3 months; an overdraft repayable on demand and
integral to cash management may form part of cash — a judgment disclosed as
policy, para 46) and nothing else; "committed" has no IAS 7 meaning. **Every
Phase 17 decision is therefore PRODUCT, informed by PRECEDENT** (P2: ERPNext
Payment Order/Request post no GL; P1: Odoo 17 has no scheduled payment; P3:
the OCA cash-flow forecast is a typed, non-stored view of ledger residuals
plus a manual-lines table).

### 8.2 D17-01 — Cash position: the ledger, never a second balance

- Per bank: `bankReconciliationsRepository.ledgerBalance(bank, as_of)` — the
  ONE per-bank definition (the view `journal_line_bank_identity`, entries in
  the books, dated ≤ as_of). Beside it, never netted into it: the latest
  statement's closing balance dated ≤ as_of, and reconciled-through.
- 🔴 **Cash not attributed to a bank** — pre-D-3 history still on the `CASH`
  header — is its own line, so **Σ banks + unattributed = every
  `liquidity_class = 'cash'` account = the balance sheet's cash** (invariant
  T1, exact). The per-bank total alone would understate cash while the cut-
  over is blocked (CLAUDE.md §5).
- Transfers in transit (`TRANSFER_CLEARING`, class `quick`) are shown beside
  cash, never in it (IAS 7.9: movements between cash items are not flows,
  and money in transit is not in a bank).
- A negative bank balance is shown negative and stays in the total, as the
  balance sheet does; the page states the policy (IAS 7.8/46). PRODUCT.
- `as_of` is today or earlier; a future `as_of` is **refused** (a position is
  actual; the future is the forecast — the ageing reports' rule).

### 8.3 D17-02 — Expected flows come from the subledgers' own definitions

| Kind | Source (single definition) | Date |
|---|---|---|
| Receipts EXPECTED | open receivables per document, through the customer statement's OWN predicates (`IN_BOOKS`, `RECEIVABLE_DOC`) — pinned by a test to Σ customer positions | `COALESCE(due_date, date)` |
| Payments EXPECTED | open bills through **`billPosition`** — minus what a payment plan already covers | due date, or the plan's date |
| Payments COMMITTED | **approved** payment plans, capped at what the bill still owes | planned date |
| Payments EXPECTED (plan) | planned, not yet approved | planned date |
| Tax EXPECTED | WHT unremitted per month; Zakat and income-tax payables; VAT (§8.4) | statutory due dates |
| FORECAST | active recurring rules (A3): each projected run in the horizon (`nextOccurrence`) — invoice templates in, bill templates out, at the run date + the party's numeric payment terms | projected |
| MANUAL ASSUMPTION | `treasury_forecast_entries` — dated, signed, described, never posted | entered |
| Undated obligations | payroll payables (`SALARIES_PAYABLE`, `GOSI_PAYABLE` — no payroll payment path exists) | none |

- 🔴 **Overdue and undated items go to their own bucket**, "Overdue and
  undated", before week 1 — never silently re-dated to today (P2 ages them;
  P3 lumps them into "current"; both evidence, the separate bucket is the
  product's).
- **Budgets are not a forecast input** (PRODUCT): they are accrual P&L amounts
  (Phase 15 D15-06), and once billed would double-count with AR/AP.
- Purchase orders, journal-entry recurring templates and draft documents are
  not inputs (nothing in the books; JE templates carry no cash meaning) —
  stated on the page.

### 8.4 VAT as a treasury obligation (REQUIRED date; PRODUCT amount)

Payment is due "by the last day of the month following the end of that Tax
Period" (S11, "PAYMENT OF TAX"). Amount: the VAT return's net VAT due for the
last completed period (documents file, M16 Q0), less VAT payments booked
after that period ended (presumed for it — labelled); the current period to
date is shown as its own EXPECTED line. Without a declared VAT period
(`companies.vat_tax_period` NULL) the VAT obligation is undated. No VAT
payment path is built (Phase 13D, P13-N1 stay open).

### 8.5 D17-03 — The forecast

- Horizon in weeks (1–52, default 13 — the conventional 13-week cash
  forecast; PRODUCT), weekly buckets from today.
- Opening = **ACTUAL** cash today (D17-01). Each bucket: inflows and outflows
  by kind, every row typed `actual` · `committed` · `expected` · `forecast` ·
  `manual` and carrying its source reference; closing = opening + in − out.
  🔴 A forecast figure is never labelled cash; the page states "projection".
- Exact in halalas; no tolerance.

### 8.6 D17-04 — Liquidity and funding requirement

- **Available** = actual cash − committed (approved plans not yet paid).
- Next 30 days expected in / out; overdue receivables / payables; undated
  obligations; the **liquidity gap** per bucket = max(0, minimum buffer −
  projected closing).
- **Funding requirement** = the largest gap in the horizon, the first week it
  occurs, and the buffer it was measured against (`treasury_settings
  .minimum_cash_balance`, approver-set; NULL → measured against zero and the
  page says "no buffer declared").
- 🔴 Three things kept apart: the **calculation** (the figures), the
  **recommendation** (words: "arrange funding of X before week W") and the
  **actual funding transaction** — which this product never creates. A loan
  is booked by the user through the ledger when it exists.
- Neutral treatment, no status palette (CLAUDE.md §4: a gap against a
  self-chosen buffer is a judgment, not a state).

### 8.7 D17-05 — Payment plans (scheduling)

- `scheduled_payments`: one bill, a planned date (≥ today when set), an
  amount (≤ what the bill owes, and Σ open plans for a bill ≤ what it owes —
  checked under the bill's row lock), a planned bank, a priority
  (`high`/`normal`/`low`), a note.
- Lifecycle: `planned` → `approved` (approver) → `paid` (approver executes) |
  `cancelled` (reason). Cancelling — a planned or an approved plan — is an
  approver's act (`…/reject`), and deleting a never-approved plan is an
  admin's: the platform rule, applied without exception (a bookkeeper edits a
  plan while it is planned; §13 D-06). Edits only while `planned`; an approved
  plan is immutable at the database. 🔴 A plan on an opening bill the
  migration REVERSED is refused at creation and approval (service and
  database, 0115), and a batch reversal is refused while an opening bill has an
  open plan (§13 F-01).
- 🔴 The WHT declaration made AT PAYMENT governs: a not-subject reason, or an
  explicit nature, replaces the nature the plan was made with (§13 F-06).
- 🔴 **Execution is the EXISTING pay path**: `POST …/pay` calls `payBill`
  (with WHT, §2.4) for the plan's amount, from the named bank, dated today
  (or an earlier stated date — never a future one), and links the
  `bill_payments` row. **No bank instruction is sent anywhere**; nothing
  executes on a schedule (no automatic bank payments exist or are approved).
- A plan larger than what the bill now owes (paid another way) is shown as
  such and refused at execution, by name — never silently trimmed.
- Cash availability: the plan list shows the projected closing of the
  plan's week and whether it falls below the buffer.

### 8.8 D17-06 — The dashboard

`/treasury`: cash position by bank (with the unattributed line and
in-transit beside), available liquidity, the forecast closing by week (one
money axis; the buffer as a reference line in the same unit — no dual axis),
inflows and outflows by kind, upcoming obligations (30 days), liquidity gap
and funding requirement, payment plans, manual assumptions, settings. Every
figure drills to its source. EN/AR, RTL, 390 px.

---

## 9. Data model (migrations 0113 Phase 16, 0114 Phase 17)

| Table | Scope | Notes |
|---|---|---|
| `wht_rates` | **global** reference, read-only to tenants | effective-dated; seeded §2.2 |
| `vendor_wht_treaty_reliefs` | org + company, RLS | approval-gated; append-only except approve/revoke |
| `wht_withholdings` | org + company, RLS | append-only; admit trigger (same tenant; the payment exists) |
| `wht_remittances`, `wht_remittance_reversals` | org + company, RLS | append-only |
| `zakat_account_classifications` | org (the chart is org-level), RLS org arm | audited |
| `tax_computations`, `tax_computation_versions`, `tax_adjustments` | org + company, RLS | frozen fiscal year; DB lifecycle lock (the 0112 pattern) |
| `treasury_settings` | org + company, RLS | one row per company |
| `scheduled_payments` | org + company, RLS | DB lifecycle lock |
| `treasury_forecast_entries` | org + company, RLS | never posts |

- `vendors` gains `wht_default_payment_type`, `foreign_tax_id` (the Art.
  68(B)(3) registration number); `country` already exists.
- System accounts: `ZAKAT_EXPENSE`, `INCOME_TAX_EXPENSE`,
  `INCOME_TAX_PAYABLE`, `TAX_PENALTIES`; `ZAKAT_PAYMENT` promoted to a
  protected system liability ("Zakat payable"); `WHT_PAYABLE` gains its
  ownership guard.
- Permissions: `tax` (read all · create/update write · approve approver ·
  delete admin), `treasury` (read all · create/update write · approve
  approver · **delete admin** — 0114 had granted delete to WRITE, against the
  platform rule that delete is an admin's and a bookkeeper never holds approve
  or delete; migration 0115 corrected it, §13 F-02), `treasury_settings` (read
  all · update approver). The settings route is guarded INSIDE the treasury
  router by its own resource (both guards must pass), not as a second nested
  mount (§13 F-07).
- Every tenant table: `organization_id` + `company_id` NOT NULL with GUC
  defaults, RLS `tenant_isolation` with the company arm, admit triggers
  answering a foreign id exactly like a missing one, explicit grants and the
  REVOKE TRUNCATE/REFERENCES/TRIGGER pattern.

## 10. Invariants (each a test on rows the product wrote)

| Id | Invariant |
|---|---|
| W1 | GL `WHT_PAYABLE` (company) = Σ withheld − Σ remitted + Σ remittance reversals, **exact** |
| W2 | A bill payment to a non-resident: AP debit = base; bank credit = base − WHT; WHT = round2(base × applied rate) |
| W3 | A line on `WHT_PAYABLE` no WHT record owns is refused at COMMIT |
| W4 | The monthly return's totals = Σ that month's withholdings; remitted + outstanding = withheld |
| W5 | Rate by date: the applied rate is the `wht_rates` row in force on the payment date; none → refused |
| Z1 | The working paper's Σ classified assets = the balance sheet's total assets at year-end, and the same for liabilities and equity |
| Z2 | Book NP = the income statement for the fiscal year; the BS current-year result = the same figure |
| Z3 | Floor/ceiling: each Art. 27/28 branch on a fixture built to reach it |
| Z4 | Approval posts the difference only; Σ accruals of a computation = its approved Zakat |
| Z5 | Nothing affects the books before approval (zero-movement) |
| T1 | Treasury cash total = Σ banks + unattributed = balance-sheet cash, exact, as of any past date; a future-dated entry is excluded |
| T2 | Forecast expected receipts = Σ customer positions' receivable; expected + planned + committed payments = Σ `billPosition` outstanding (no double count) |
| T3 | closing(week n) = closing(n−1) + in − out, exact; opening = T1 today |
| T4 | Executing a plan moves the books exactly as `payBill` does, once |
| P | Isolation (presence, absence, movement) for every new table and report |

## 11. 🔴 OPEN — the questions (one list), and the default the build takes

**For the accountant / tax adviser** (one short list; each default builds
nothing interpretive):

| # | Question | Build default |
|---|---|---|
| Z-1 (C3) | Is the Art. 15(2) divisor a fixed 354 or that Hijri year's 354/355; is any rounding prescribed? | Owner Q3 (÷ 354); one rounding of the final amount |
| Z-2 (C2) | Are contra-asset allowances (ECL, obsolescence, impairment) "provisions and equivalents" under Art. 24? | The user classifies the account; the page cites the question |
| Z-3 | Is the current year's own Zakat charge excluded from equity and book profit when computing that year's base? Art. 63(10): Zakat "paid" — the cash in the year or the charge? | Excluded; adjustments carry any Art. 63(10) item the user declares |
| Z-4 | Does ZATCA's practice match the reading of Art. 27 shown (incl. a negative base with positive adjusted profit) and Art. 28 applied after it? | As shown, every term on the page |
| Z-5 (C5) | Mixed ownership: is the Saudi share's base = the whole-entity base × the share, and are Arts 27/28 applied before or after the split? | Mixed not computed (Q2) |
| Z-6 | Art. 25 and 29(2)(a)/(b): are the two current-liability additions cumulative before the 25(4) cap? | Cumulative, then capped — shown |
| Z-7 | Must an audit-exempt micro/small company attach audited statements to its Zakat return under the 1445H regime? | Not modelled (nothing filed) |
| Z-8 | Is a sole-proprietorship tenant an account-holding payer or ZP-AA? | Base method only |
| W-1 | Do accruals, set-offs and intercompany book entries trigger WHT now the 2021 guideline is withdrawn? | Only the cash pay paths withhold |
| W-2 | When the payer bears the WHT, is the base the contract amount or grossed up? | Payer-borne not built |
| W-3 | Is WHT computed excluding reverse-charge VAT; and on a VAT-registered non-resident's VAT-inclusive invoice? | Base = the amount settled with the supplier |
| W-4 | After Res. 25, which Form 06 row (07/08 or its nature's row) carries a related-party service? | Its nature's row; rows 07/08 unused, stated |
| W-5 | Is WHT due on payments to a non-resident's Saudi PE (IR 63(1) 1427H amendment vs ZATCA's 2026 RHQ guidance)? | No PE exemption offered |
| W-6 | Does a late monthly WHT form attract an Art. 76 fine on top of the 1 %? | Only the 1 % estimate is shown |
| W-8 | Is a nil monthly WHT return required? | Months with no withholding are listed as nil |
| W-9 | Which fields does Form 06's per-beneficiary schedule require? | Name, country, registration no., nature, base, rate, WHT, date |
| W-10 | Must the treaty approval predate the payment; does one approval cover repeated payments? | The approval's recorded validity window governs |
| W-11 | For a foreign-currency payment, which date's SAMA rate? | Non-SAR refused |
| W-12 | A refund of an advance from which WHT was withheld — how is the withheld part recovered? | Refused |
| I-1 | Mixed income tax: is the 25 % loss cap applied before or after the non-Saudi share? | Mixed with losses refused |
| S-1 | Are Qawaem's XBRL line-item lists a binding mapping software must produce? | Nothing labelled statutory |
| W-13 (QA-08) | How is a WHT-bearing payment entered in error corrected — in its own month or the next; before and after the month is remitted and its Form 06 filed? | **ANSWERED 2026-10-05 (Q1) — built §14.1**: reversal + re-entry; unfiled → its own month; filed → the person's stated treatment |
| W-13b | For a correction of a FILED Form 06 month: when does ZATCA require amending that month and when may a later month carry it — and does remittance change the answer? | Both offered; the person states which; recorded on the correction (§14.1) |
| W-17 | A month left in credit by a correction (tax remitted exceeds what its return now carries): refund claim, or offset against a later month? | Shown as `credit`; never netted, never remitted again, never refunded by the product (§14.1) |
| W-14 (QA-09) | Is a refundable security deposit, an erroneous payment or an unidentified payment to a non-resident subject to WHT when paid? If it was withheld, how is its return recorded (W-12)? | **ANSWERED 2026-10-05 (Q2) — built §14.2**: not subject; unidentified = pending |
| W-16 | Money paid to a non-resident with nothing withheld (unidentified, or a deposit) and identified LATER as taxable consideration: is the tax recovered from the supplier or borne by the payer (grossed up — W-2), and in which month's return? | Refused by name (`wht_late_withholding_open`), the exposure stated; the payment stays pending (§14.2) |
| W-18 | Should every non-resident payment carry an explicit Art. 5 source determination, rather than a presumption a person rebuts by declaring `not_kingdom_source`? | The presumption, labelled `presumed` on every determination (§14.2) |
| A-6 (QA-14) | On a migration batch reversal, are its migrated fixed assets marked reversed (out of the register and depreciation), or is the reversal refused while they are in service? | **ANSWERED 2026-10-05 (Q3) — built §14.3**: marked reversed, depreciation since the cutover mirrored, no disposal; whole batch only |
| A-7 | A migrated asset DISPOSED of after the cutover: how is its disposal (entry, sale invoice, Art. 52(8) nominal supply) unwound when its batch is reversed? | The reversal is refused by name while it stands (§14.3) |
| W-8b | Nil WHT months: is a nil Form 06 required (ZATCA's pages read are silent; secondary sites say yes by analogy to VAT — unverified), and if so listed from which month (first withholding, go-live, fiscal year)? | Only months with records are LISTED; any month can be OPENED by its URL (D-16) |
| W-15 | Should residency be effective-dated, so a payment is judged by the residency in force when it was made? | Current residency judges every payment |
| T-1 | Should the forecast count overdue receivables as cash coming in (it does, in the overdue bucket)? A product judgment — no regulation governs an internal forecast | Counted, labelled as overdue (D-20) |
| Q-d | Refuse a treaty relief at exactly the statutory rate (it relieves nothing)? | Accepted, with a warning before submit (F-34) |
| Q-e | Refuse creating a computation the company's TODAY ownership does not take (income tax for a Saudi company; Zakat for a mixed one) — and judged by which year's ownership, since ownership is undated? | Accepted by the API; never offered by the UI; an existing one always listed (F-33) |
| ZK-1 (final audit) | Should the Zakat and income-tax accounts accept postings ONLY from a computation (a manual Zakat provision is accepted today, and the approval then accrues the full amount on top: expense and payable counted twice), or should the paper name any other tax expense it finds? | Unchanged: manual entries accepted; the paper shows them among its inputs (§15) |
| TR-2 (final audit) | Should the forecast net a customer's deposit on account against that customer's open invoices (it is in opening cash AND projected as a receipt), and a supplier advance against bills? | Not netted (§15) — a treasury product decision |
| MG-3 (final audit) | A migration reversal's mirror is dated the opening date: what of months CLOSED since the cutover that it restates? Today only the opening month's lock and the months holding depreciation to unwind block it | Unchanged (pre-existing Batch 1C behaviour) — for the accountant |

**For the OWNER** (not the accountant):

- **Q4 is superseded by the text** (§3.2) — informed, not asked.
- **IT Regs Art. 56(2)(a)** — books of income-tax payers kept on a computer
  located in the Kingdom → hosting, queue C6.
- The advisor file `advisor-questions.md` Block C is updated with the C10
  verdicts (C1, C4 closed by text; C2 residue, C3 divisor, C5 mechanics
  remain).

## 12. As built

**Status (2026-10-04): built on `feat/phase16-17-tax-treasury`; the PR stays
OPEN for the owner's review.** Current state authority:
[CLAUDE.md §2](../../CLAUDE.md).

**Database.** `0113_phase16_saudi_tax` (the WHT, Zakat, income-tax and
adjustment tables, the rate schedule, the system accounts, the `WHT_PAYABLE`
ownership trigger, the lifecycle locks, RLS, grants, `tax` permissions),
`0114_phase17_treasury` (settings, payment plans, assumptions, `treasury` /
`treasury_settings` permissions), `0115_phase16_17_hardening` (the audit's
database fixes: treasury `delete` admin-only; a plan never names, nor is
approved on, a reversed opening bill; a header carrying entries of its own —
the `CASH` header's pre-D-3 history — is classifiable for Zakat). Migrated from zero on a fresh database;
`drizzle-kit check` clean; no schema drift.

**API** (`/tax/*`, `/treasury/*`, OpenAPI-first): WHT — rates, preview,
overview, monthly return, annual return, beneficiary statement, exceptions,
remit / reverse, treaty reliefs; Zakat classification; computations
(Zakat and income tax: create, versions, adjustments, losses, submit /
approve / send back / reject / revise); the obligations calendar; Treasury —
position, forecast, dashboard, payment plans (create / edit / approve / pay
/ cancel / delete), assumptions, settings. Every response parses under its
generated schema on real rows (the conformance checks in the three suites;
the reconciliation and the approved snapshot are typed, not open maps).

**Integration — one writer per effect.** WHT is decided inside the two
existing pay paths (`payBill`, `supplierPaymentsService.create`); a plan is
paid through `payBill`. The income statement presents "Zakat and income
tax" in its own section below "Profit before Zakat and income tax" (SOCPA
para 6; `totalExpenses` keeps its meaning). The cash flow statement shows
Zakat and income tax paid on their OWN operating line `zakat_income_tax`
(IAS 7.35 as endorsed by SOCPA: separately disclosed); VAT and WHT stay on
`taxes`; a tax fine (`TAX_PENALTIES`) is an operating expense paid, not a
tax; `VAT_PAYMENT` now reaches the tax line. Exports: `wht-return`,
`wht-annual`, `tax-computation` (an approved version exports its FROZEN
paper), `treasury-forecast`.

**Web** (EN/AR, RTL, 390 px): `/zakat` (scope, the Zakat year, computations —
off the hand-written-interface ratchet), `/zakat/classification`,
`/tax/income-tax`, `/tax/computations/:id` (versions, blockers named by code,
the working paper with every step and article, Z1/Z2, the frozen snapshot
beside the live paper, adjustments, losses, export), `/tax/withholding`
(months, return, annual with incomplete beneficiaries flagged, exceptions,
treaty reliefs, rates; the tab in the URL), `/tax/obligations`, `/treasury`
(position, liquidity, funding, forecast with one money axis and the buffer
as a reference line, payment plans with each plan's projected week against
the buffer, assumptions, settings; the tab in the URL). WHT fields with the
server's live preview in the bill pay and supplier payment dialogs; the
supplier record's residency, default nature, country and registration
number. Navigation: the four Zakat placeholders and the WHT placeholder are
retired (the Zakat reports are the approved papers with their exports; the
Zakat settings are the ownership and fiscal-year declarations plus the
classification); Treasury joins Banking; the stale `advisorBlockC` blocker
is removed.

**Tests.** API: `phase16-wht` (16), `phase16-zakat-income-tax` (19),
`phase17-treasury` (9), `phase16-17-opening-reversal` (6),
`phase16-17-http` (6), `phase16-17-audit` (8),
`phase16-vat-obligation-overdue` (2), and the extended
`phase14-cash-flow-classification` (9). Browser: `phase16-tax` (7),
`phase17-treasury` (6), plus the route inventory, the nav tree and the smoke
crawl (a seeded computation makes `/tax/computations/:id` crawlable). The
invariants of §10: W1–W5 (`phase16-wht`, `phase16-17-audit`), Z1–Z5
(`phase16-zakat-income-tax`), T1–T4 (`phase17-treasury`), P (every suite's
isolation test; `phase16-17-http` over the wire).

## 13. Audit

**Status (2026-10-04): the joint audit of both phases, run adversarially after
the build; every CRITICAL/HIGH finding is fixed, each with a regression test
proven RED by a mutation (the change reverted, the test failing, the file
restored by hash); MEDIUM/LOW findings are fixed or listed below.** A manual
product QA followed (2026-10-04, a disposable database, three tenants, real
clicks, every figure reconciled to the GL): F-16…F-25 and D-11…D-22 below;
record [`phase-16-17-manual-qa-2026-10-04.md`](../history/phase-16-17-manual-qa-2026-10-04.md).
The gaps that needed no decision were then closed (F-26…F-36; D-14, D-15,
D-17, D-18 closed, D-16 and D-19 in part); the three HIGH items stay open with
a technical design each — record
[`phase-16-17-gap-closure-2026-10-04.md`](../history/phase-16-17-gap-closure-2026-10-04.md).

### 13.1 Areas and verdicts

| # | Area | Verdict | Evidence |
|---|---|---|---|
| 1 | WHT arithmetic | Sound: halala round-half-up, rate by payment date, treaty window | `phase16-wht` (pure + real rows) |
| 2 | WHT ledger ↔ GL (W1) | Exact; enforced at COMMIT (two writers) | `phase16-wht` W1/W3, `phase16-17-audit` A-2 |
| 3 | Zakat calculation | Hand-worked fixture to the halala (9,373.39; 3,866.53) | `phase16-zakat-income-tax`, `phase16-17-audit` A-5 |
| 4 | Income tax | Pool replaces book depreciation; 25 % loss cap; MIXED-with-losses refused | `phase16-zakat-income-tax` |
| 5 | Tax adjustments | Locked when not a draft (DB); copied into a revision; never touch the ledger | `phase16-zakat-income-tax` |
| 6 | Accrual and revision | Posts the difference only; Σ accruals = approved | Z4 |
| 7 | Tax obligations | Fixed F-04 (overdue VAT); one-period VAT lookback documented D-01 | `phase16-vat-obligation-overdue` |
| 8 | Reversed opening rows | Fixed F-01 | `phase16-17-opening-reversal`, mutations M1–M5 |
| 9 | Tax reporting / exports | CSV carries the screen's figures; frozen paper exported | the three suites |
| 10 | Cash position (T1) | = Σ banks + unattributed = balance-sheet cash, any past date | `phase17-treasury` T1, e2e |
| 11 | Liquidity | Available = cash − committed; neutral treatment | `phase17-treasury` |
| 12 | Forecasting (T2, T3) | No double count (plans displace due dates); closing chains exact | `phase17-treasury` |
| 13 | Payment scheduling (T4) | One writer (payBill); Σ open plans ≤ owed under the bill lock | `phase17-treasury`, `phase16-17-audit` A-4 |
| 14 | Funding requirement | Calculation, words, never a transaction | `phase17-treasury`, e2e |
| 15 | Treasury dashboard | Every figure the API's; one money axis | e2e `phase17-treasury` |
| 16 | Date boundaries | Future as-of refused; plan date ≥ today; pay date ≤ today; remit not before its month | the suites |
| 17 | Period locks | Remit into a closed month refused, writes nothing; accrual into a closed year-end posts today (change in estimate) | `phase16-17-audit` A-5 |
| 18 | Company isolation | Presence, absence, movement for every table and report | every suite; `cross-company-isolation` |
| 19 | RLS and grants | Tenant policy with the company arm; append-only tables; REVOKE pattern | `rls-coverage`, migrations |
| 20 | Permissions | Fixed F-02; F-07 | `phase16-17-http`, `permission-seed-grants`, M6 |
| 21 | Concurrency | Remittance race and plan race hold at the DATABASE (deterministic T1/T2 race) | `phase16-17-audit` A-2, A-2b, A-4 |
| 22 | Idempotency | A keyed retry replays; concurrent same key refused (D-03) | `phase16-17-audit` A-3 |
| 23 | Report reconciliation | Zakat Z1/Z2 shown; cash flow reconciles to the GL after tax payments | `phase16-zakat-income-tax`, `phase16-wht` |
| 24 | Cash-flow classification | Fixed F-03 | `phase14-cash-flow-classification`, M7/M8 |
| 25 | Contract (OpenAPI) | Fixed F-08; conformance on real rows | the three suites |
| 26 | Arabic / RTL / 390 px | Sweep clean on every new page; e2e both languages, both widths | `scripts/arabic-sweep.mjs`, e2e |
| 27 | Migrations | From zero clean; check clean; no drift | §12 |
| 28 | Performance | Every hot path has an index the planner uses (WHT by company+period, plans by bill, assumptions by company+date, cash via the D-3 view) | EXPLAIN with seqscan off |
| 29 | Secrets | gitleaks, full history (CI's own invocation) | the PR |

### 13.2 Findings — fixed

| Id | Severity | Finding | Fix | Test (mutation) |
|---|---|---|---|---|
| F-01 | HIGH | A reversed opening bill (Batch 1C Policy C) could be planned and approved; the plan list showed it as owing; the forecast mislabelled it; a batch reversal was not blocked by an open plan. The tax and treasury repositories did not consume the one reversed-row predicate. | Predicate in both repositories; `assertNotReversedOpening` in every plan writer; the DB admit/guard refuse it (0115); the batch reversal names an open plan as a blocker | `phase16-17-opening-reversal` (M1–M5) |
| F-02 | HIGH | `treasury.delete` granted to the accountant and the bookkeeper | SPEC + 0115: admin-only | `phase16-17-http`, `permission-seed-grants` (M6) |
| F-14 | HIGH | A Zakat blocker nobody could clear: pre-D-3 cash history on the NON-POSTING `CASH` header (every local company until the cut-over, CLAUDE.md §5) is a balance the paper reads and blocks on — but the classification page listed posting accounts only and the database admitted posting accounts only. Found by the first CI browser run (the walk) and proven red first | A non-posting account that carries lines of its own is listed, classifiable (service) and admitted (DB, 0115 §3); a true header (no lines) stays refused — the leaf grain holds | `phase16-17-audit` A-6 (M13 the list; M14 the database) |
| F-03 | MEDIUM | Zakat and income tax folded into the VAT/WHT cash-flow line (IAS 7.35 as endorsed: separately disclosed); a tax fine classified as a tax | Own line `zakat_income_tax`; the fine by its type | `phase14-cash-flow-classification`, `phase16-zakat-income-tax`, `phase16-wht` (M7, M8) |
| F-04 | MEDIUM | An unpaid VAT period vanished from the obligations calendar — and Treasury — the day it became overdue (every quarterly filer, two months in three) | Listed while unpaid, flagged overdue | `phase16-vat-obligation-overdue` (M10) |
| F-05 | MEDIUM | A confident zero: a Zakat or income-tax year with nothing in the books computed 0.00 and could be approved | Blockers `zakat_no_books`, `income_tax_no_books` | `phase16-17-audit` A-1 (M11) |
| F-06 | MEDIUM | A plan made with a WHT nature could never be paid as not subject (the stored nature won; the pay path refused the conflict) | The declaration at payment governs | `phase17-treasury` (M9) |
| F-07 | MEDIUM | `/treasury/settings` was a second, NESTED mount — mount order decided which guard ran; the surface map could not see it | One mount; the settings guard inside the router | `privilege-surface-map`, `phase16-17-http` |
| F-08 | MEDIUM | The computation's reconciliation and approved snapshot were open maps in the spec — a page would have needed a hand-written type | Typed schemas; conformance on real rows | the three suites |
| F-09 | LOW | Treaty reliefs named suppliers by id; the client lookup went through a capped vendor list | The server names the supplier | `phase16-wht` |
| F-10 | LOW | The WHT and Treasury tabs were not in the URL (a nav deep link lost its scope) | `?tab=` read and written | e2e |
| F-11 | LOW | Untranslated strings (liquidity codes, placeholders, "(to date)") | Bilingual; liquidity labels one shared definition | Arabic sweep |
| F-12 | LOW | Every plan action re-read ALL plans to return one | `plans({ id })` | — |
| F-13 | LOW | The annual WHT return did not flag a non-resident recorded in "SA" or without a registration number (Art. 68(B)(3)) | Flagged on the page | — |
| F-15 | LOW | The Treasury dashboard (Overview) lacked the forecast closing by week that §8.8 lists — it was on the Forecast tab only. Found by the first CI browser run | The chart on the Overview too (one money axis, the buffer in the same unit) | e2e `phase17-treasury` |
| F-16 | MEDIUM | None of the 55 Phase 16/17 trigger refusals was mapped: a remittance race or a treaty rate above the statutory one answered 500 (the service tests saw only "refused" — verified below the layer that had the bug) | `lib/dbRefusals.ts`: one translation by constraint, an exact allow-list, shared by the error handler and the commit path | `phase16-17-qa-fixes` (M15) |
| F-17 | MEDIUM | A journal line on WHT_PAYABLE — the DEFERRED W3 trigger — answered 500 `commit_failed` ("try again") and paged a critical database-health alert | The commit path answers a recognised refusal with its 422 and logs it | `commit-before-response`, `phase16-17-qa-fixes` (M16) |
| F-18 | MEDIUM | The remittance entry number carried `Date.now()`: two in one millisecond collided (500) before the trigger decided | Random suffix; `journal_entries_company_number_unq` → 409 (ten pre-existing clock-numbered entry types too) | `phase16-17-qa-fixes` (M18, clock pinned) |
| F-19 | MEDIUM | Every tax/treasury action was guarded by `isPending` only: a double-click added a Zakat adjustment twice (the Zakat rose), created two plans, fired two remittances | `useGuarded` (`lib/singleSubmit.ts`) on all 28 mutations; the remittance carries an idempotency key | `singleSubmit.test.ts`; e2e `phase16-17-qa-fixes` (red with the guard off) |
| F-20 | MEDIUM | The treaty-relief rate was pre-filled "0" — a full exemption one approval away | Empty; a typed fraction required | e2e (red reverted) |
| F-21 | MEDIUM | The bill pay dialog had no date: a payment entered late was dated today and its WHT fell into the wrong month's return | A "Paid on" date (≤ today) into the request and the preview | e2e (red reverted) |
| F-22 | LOW | A plan's WHT estimate ignored the supplier's default nature and an approved relief | The pay path's own `decideWithholding` | `phase16-17-qa-fixes` (M17) |
| F-23 | LOW | A new computation pre-selected the OLDEST offered year | The latest completed fiscal year | `taxYears.test.ts` |
| F-24 | LOW | Company Settings called foreign and mixed ownership "out of scope" | Says which tax applies | e2e |
| F-25 | LOW | Raw money in the funding sentence; raw category codes in the forecast | Formatted; labelled | `phase16-17-qa-fixes` |
| F-26 | MEDIUM | (was D-14) The approvals inbox never showed a submitted computation, a pending relief or a planned payment — a bookkeeper "submitted" and no approver was told | The ONE queue lists them (company-scoped, read-gated by `tax`/`treasury`); every act posts to the record's own route; reasons inline; single-flight | `phase16-17-gap-closure` (M19a/b); e2e |
| F-27 | LOW | (was D-15) A VAT period netting to zero or to a credit had no row, so D-01's note vanished | Every period listed with its position (payable · settled · nil · credit) and the return's own figure; owed stays ≥ 0 — a credit is never projected as cash | `phase16-vat-obligation-positions` (M20) |
| F-28 | LOW | (was D-17) The classification page showed no balances; the blocker link landed on every account | Balances at a chosen date from the balance-sheet rows the computation reads, and what it READS (own accrual left out, Z-3 — one shared rule); a "blocking" filter on that; date and filter in the URL; the link scoped to the year | `phase16-17-gap-closure` (M21, M24); e2e |
| F-29 | LOW | (D-18) The plans table scrolled sideways at 1280 and 390 px and clipped its forms | One responsive grid, nothing dropped; forms full width beneath the row | e2e (red with the old page) |
| F-30 | MEDIUM | (D-18, and NEW) The plan pay form had no WHT preview, and its "Not stated — the supplier's default applies" option sent nothing, so the server applied the PLAN's stored nature behind a screen naming another | The shared `<WhtFields>`: the preview is `decideWithholding` via `/tax/wht/preview`; the request states the declaration on screen | e2e: preview → payment withheld the same (red with the old page) |
| F-31 | LOW | (D-18) Obligations links dropped their period | The row's scope in the link (WHT month, VAT period, the approved computation); the WHT and VAT pages read it from the URL | `phase16-17-gap-closure` (M22); e2e |
| F-32 | LOW | (D-18, D-04 family) Legal references stayed English in Arabic | `legalRef`/`articleRef`: official Arabic titles, abjad sub-paragraphs, verbatim when not fully recognised | `taxLabels.test.ts`; e2e |
| F-33 | LOW | (D-19, part) An existing computation was invisible when today's ownership does not take its tax | Always listed; creation not offered there (refusal open — §11) | e2e |
| F-34 | LOW | (D-19, part) A relief at the statutory rate was accepted silently | Warned before submit (equal / above), from the rate in force on its first day | e2e |
| F-35 | LOW | The Approvals page (now hosting tax/treasury acts) was `isPending`-guarded and prompted with `window.prompt` | `useGuarded`; inline notes; a "waiting" summary at the top | e2e |
| F-36 | LOW | (NEW, the walk) A PAID plan showed a WHT estimate re-computed with today's supplier, relief and rate — not what its payment withheld | `whtWithheld` from the payment's `wht_withholdings` row; estimates for open plans only | `phase16-17-gap-closure` (M23a/b) |

### 13.3 Documented — not fixed

| Id | Severity | What | Why it stands |
|---|---|---|---|
| D-01 | MEDIUM | VAT obligations look back ONE completed period (plus the current one); an older unpaid period is not projected | Payments name no period; attributing them is a guess. The row says so; the VAT return answers per period |
| D-02 | LOW | The Zakat classification is org-level (owner Q6): a change moves every company's computations | By decision; an approved paper keeps its figure and shows "inputs changed" |
| D-03 | LOW | Two CONCURRENT remittances with the same idempotency key: one lands, the other is refused, not replayed | No money effect (the DB race test); the platform's pattern (supplier payments) |
| D-04 | LOW | An Arabic export of a computation prints class, step and target codes in English; blocker notes are the server's English | Exports are bilingual in titles/notes; the codes need a server-side label map |
| D-05 | LOW | The plan bill picker reads the 200 most recent bills | Says so, with a supplier filter; an open-payables endpoint would remove the cap |
| D-06 | LOW | A bookkeeper edits a plan but cannot cancel or delete it | The platform rule (cancel = approve, delete = admin) |
| D-07 | LOW | The supplier-payment detail does not show the WHT withheld | The response carries no WHT fields (the WHT pages do) |
| D-08 | LOW | The spec types WHT natures as `string`, not the enum | The server validates; generated types are wider than the rule |
| D-09 | LOW | The direct cash flow shows a supplier payment gross of WHT (the counterpart method); the WHT shows on the tax line when withheld (+) and remitted (−) | The Phase 14 model; totals reconcile |
| D-10 | INFO | The engine approves from `draft` (no forced submit) | Platform-wide approval semantics |
| D-11 | HIGH | **No correction path for a WHT-bearing payment**: the generic reverse refuses a withholding-owned entry (right, for W1) and payments have no reversal — a wrong nature, rate, amount, bank, date or supplier is permanent on the return (QA-08) | **Closed 2026-10-05 → §14.1** (accountant Q1) |
| D-12 | HIGH | **Every non-resident payment withholds whatever its classification** — a refundable deposit, an erroneous or unidentified payment too — and its refund is then refused for any amount (W-12): the money cannot be recovered in the product (QA-09) | **Closed 2026-10-05 → §14.2** (accountant Q2) |
| D-13 | HIGH | (pre-existing, Batch 1C × FA-D) A migration reversal leaves the batch's fixed assets in service; a replacement adds a second copy and every depreciation run depreciates both (register ≠ GL; feeds Zakat and income tax) (QA-14) | **Closed 2026-10-05 → §14.3** (accountant Q3, Option A) |
| D-14 | MEDIUM | The approvals inbox never shows a submitted computation, a pending relief or a planned payment (QA-15) | **Closed 2026-10-04 → F-26** |
| D-15 | LOW | When the last completed VAT period nets ≤ 0 there is no VAT row, so D-01's note never shows (QA-06) | **Closed 2026-10-04 → F-27** |
| D-16 | LOW | Nil WHT months are not listed (W-8's default) (QA-10) | A nil month can now be OPENED by its URL (F-31); whether a nil form is required, and from which month, is open — §11 W-8b |
| D-17 | LOW | The classification page shows no balances; the blocker's link lands on every account (QA-04) | **Closed 2026-10-04 → F-28** |
| D-18 | LOW | The plans table scrolls sideways at 1280 and 390 px, clipping its inline forms; the plan pay form shows no WHT preview; obligations links drop their period; legal-reference strings stay English in Arabic | **Closed 2026-10-04 → F-29…F-32** (D-04's export codes remain) |
| D-19 | LOW | A relief at exactly the statutory rate is accepted; residency is undated; an inapplicable computation can be created (invisible in the UI for a Saudi company's income tax) | The UI parts closed (F-33 visible; F-34 warned); refusing either, and dated residency, stay open — §11 Q-d, Q-e, W-15 |
| D-20 | LOW | The forecast's overdue bucket counts overdue receivables as inflow — the lowest closing assumes they are collected | A treasury judgment — §11 |
| D-21 | INFO | (pre-existing) the invoice pay dialog also hard-codes today (no WHT effect); the sidebar shows "VIEWER" for an org admin; an operator can approve with no documents | Outside Phase 16/17 |
| D-22 | INFO | A bookkeeper may classify Zakat accounts and add adjustments (the `tax` WRITE grant); the approver sees both on the paper before approving | The platform's maker/checker split |
| D-23 | LOW | (Q1) A payment plan paid by a bill payment that a WHT correction later reversed still reads `paid`; the reversal shows on the bill's payment history and the correction, and the bill owes again (the forecast follows billPosition) | The plan is a schedule, closed by its payment; reopening it is a product decision |

The pre-existing `batch-1c-migration-staging` 30-second timeout seen once in a
loaded full run was diagnosed (every test in that file ran 10–17× slower under
the load; 7.5 s alone) and did not recur in the following full runs — a harness
bound, not a regression (`docs/test-suite-notes.md` #5).


---

## 14. The accountant's answers to the three HIGH items (2026-10-05) — as decided, as built

**Status (2026-10-05): answered by the accountant/adviser; built on
`feat/phase16-17-tax-treasury`; the PR stays OPEN.** Current state
authority: [CLAUDE.md §2](../../CLAUDE.md).

The three items §13.3 left decision-gated — D-11 (W-13), D-12 (W-14) and D-13
(A-6) — were answered as Q1, Q2 and Q3. Each answer is recorded as the
accountant gave it, then checked against the sources of §1 before it was
built: where the answer and the text agree the build follows both; where the
text is silent the build implements the product control and names the
regulatory branch it does NOT decide (escalation protocol §6 — nothing is
guessed). Labels as in the header table.

### 14.1 Q1 — correcting a WHT-bearing payment (D-11 / W-13)

**The answer (accountant, 2026-10-05).** Correct through reversal and
re-entry; keep the original transaction permanently in the audit trail; link
the original, the reversal and the corrected transaction; never mutate a
posted or remitted WHT transaction directly. Before monthly filing the
correction is reflected in the applicable filing; after filing, the
accountant recommends a subsequent-period correction rather than a
retroactive change to the filed return.

**Checked against the text — and the branch the text does not settle.** S2
Art. 63(9)(a) fixes the monthly statement and payment; S7 (ZATCA's Form 06
user manual) is the filing route, and ZATCA's portal supports amending a
filed return. The sources of §1 do **not** say when a WHT correction must be
an amendment of the filed month and when a later month may carry it, nor how
an over-remitted month is recovered. So the product does not hard-code
"after filing = next period": it records **whether the month is filed** and
makes the person **state the treatment** for a filed month — `subsequent_period`
(the accountant's recommendation, offered first, never preselected) or
`amendment` — and records the choice on the correction. **OPEN W-13b**
(below). **REQUIRED** (the record and its retention, 63(9)(c)) · **PRODUCT**
(the mechanism).

**The four states, held explicitly** (the instruction's a–d):

| State | Where it lives | What it does |
|---|---|---|
| posted, unfiled | `wht_withholdings.return_period` with no filing for that month | a correction is reported in that same month's return (`reversal_return_period` = the original's) |
| FILED | `wht_return_filings` — a person records Form 06 filed (date, ZATCA reference); the snapshot of the return is written **by the database** from the ledger, never typed (append-only) | a correction or a payment dated in it is refused (409 `wht_month_filed`) until the treatment is stated |
| remitted | `wht_remittances` (unchanged) | allowed; the month's remitted amount at the moment of correction is recorded on the correction **by the database**; a month left below what was remitted reads `credit` and is never netted elsewhere nor remitted again (OPEN W-17) |
| amended / corrected | a correction row per corrected withholding; an `amendment` filing amending the latest | the original row reads "corrected — reported in M"; a filed month whose ledger figure no longer equals the filed snapshot reads `amendment_due` until an amendment is recorded, then `amended` |

**The mechanism (migration 0117; `services/tax/whtCorrection.service.ts`).**
One act, one transaction, approver authority (`POST
/tax/wht/withholdings/:id/reverse`):

1. **The original stays.** The withholding row and the payment are
   append-only and untouched; the payment's entry is marked `reversed` beside
   its mirror (the `JE_IN_BOOKS` rule) — and only because a correction exists
   (`journal_entries_tax_reversal_guard` admits it for nothing else).
2. **The reversal** — the mirror of the payment's own entry through the ONE
   mirror writer (`journalEntriesService.reverse`, owner `wht_withholding`,
   with a pre-flip hook so the record exists before the original is marked),
   and the `wht_corrections` row: reason (≥ 10 chars), date, who, the mirror,
   the month whose return carries it, the treatment, and the original's state
   (its filing; what of its month was remitted — both written by the database).
   One correction per withholding (unique index); a double-click waits on an
   advisory lock and is answered by name; a retried request with its
   idempotency key is replayed.
3. **The subledger side** — a bill payment leaves `bills.paid_amount` (the
   counter is Σ live bill payments, so `billPosition` is untouched); a
   supplier payment's own allocations are superseded by the same mirror, and
   the payment then holds nothing on account (`repositories/paymentReversal`,
   the one predicate every on-account reader imports).
4. **The corrected transaction** — optional — a NEW payment through the
   existing pay path (`payBill` / `supplierPaymentsService.create`): wrong
   rate, amount, supplier (another bill), date or category are all just the
   corrected facts. Its withholding names the correction (`correction_id`) and
   the correction names it — original → reversal → corrected, both ways.

**WHT_PAYABLE gets its third writer** — a correction's reversal — and W1
becomes GL = opening + Σ withheld − Σ corrected − Σ remitted + Σ remittance
reversals, still exact by construction (`wht_payable_line_owned` owns the
mirror and checks its amount). **One definition of a month's return**,
`wht_return_tax()` / `wht_return_base()` (Σ withholdings whose return month it
is − Σ corrections whose reversal it carries), read by the remittance cap, the
filing snapshot and — pinned by tests — every report.

**Refused, never approximated:** a payment acted on since (a later allocation,
a refund, a moved balance, an advance invoice); a cash line reconciled to the
bank (undo the reconciliation first); a correction or re-entry dated in a
closed period (423, nothing written); a correction of a record a
reclassification superseded; a second correction.

**What it found in the code it relied on.** Probing the supplier-payment leg
on real rows showed the Phase 11 **supplier statement double-counted every
reversed allocation**: the allocation's event was filtered out AND its
unallocation added, so payable and on-account were each overstated by the
amount while the net — the only figure the self-check compared — agreed. The
as-of AP ageing replays the same events, so it aged such a bill at more than
it owed. Fixed in this commit (a superseded allocation stays in the history,
answered by its unallocation, as the customer statement already did), and the
self-check now compares every component. Regression test with a mutation.

**What this does NOT decide — named, not guessed:**

- **W-13b (NEW) — subsequent period vs amendment.** Which ZATCA requires (or
  permits) for a correction of a filed Form 06 month, and whether the answer
  differs before and after remittance. The product records the person's
  choice; it does not choose.
- **W-17 (NEW) — a month left in credit** (a correction reduced tax already
  remitted): refund claim, or offset against a later month? Shown as
  `credit`; never netted, never refunded by the product.
- A payment plan (Phase 17) paid by a corrected bill payment still reads
  `paid`; its payment's reversal is on the bill and on the correction (LOW,
  §13.3 D-23).

**Tests** (`phase16-wht-correction`, 14; `phase16-wht-correction-http`, 4):
wrong rate · wrong amount · wrong supplier · wrong payment date · wrong WHT
category · unfiled (same month) · filed → subsequent period (refused without a
treatment, nothing written; the filed return untouched; September carries
−old +new) · filed → amendment (amendment due, then amended; the original
filing preserved) · remitted (the state recorded; the month in credit; no
further remittance) · already corrected · double-click (replay) · concurrent
(one winner, the loser named) · period lock (nothing written) · a supplier
payment (statement and GL tie agree on every component; a touched payment
refused) · the statement after an ordinary allocation reversal and the as-of
AP ageing · the database keeps the record (no edit, no delete, no generic
reverse of the mirror, a filed month not written silently) · isolation ·
over HTTP: correct and file are an approver's acts (viewer and bookkeeper 403,
nothing written), the lineage is a read, a body too short is a 400, a filed
month is a 409 naming both choices, another organisation gets 404.

**Mutations, each proven red then restored:** M5 the service ignoring the
filing — the database refused (`wht_month_filed`); M6 the service AND the
database gate — red on the figure (the filed May return rewritten); M7 the
bill payment's counter not reduced — red; M8 the statement filtering
superseded allocations again — red; M9 no advisory lock — the race loser
answered with the wrong code (one correction still, by the unique index); M10
the return definition ignoring corrections — two tests red, one of them the
remittance cap admitting an over-remittance.

### 14.2 Q2 — WHT scope: the determination is category-aware (D-12 / W-14)

**The answer (accountant, 2026-10-05).** WHT is not triggered merely because
the supplier is non-resident; the nature/category of the payment decides. A
refundable deposit: no WHT. An erroneous payment: no WHT. An unidentified
payment: pending identification, never withheld automatically. Genuine
services, royalties and the other taxable categories: WHT at the applicable
category's rate. A nature is required for a non-resident payment where needed;
an exemption or inapplicable treatment is kept with its audit trail.

**Checked against the text.** S1 Art. 68(أ) obliges a resident payer to
withhold from "an amount paid to a non-resident from a source in the Kingdom",
at the rate S2 Art. 63(1) fixes for the payment's NATURE (rent, royalty,
management fees, technical/consulting services, … "other payments" — 63(7):
services not listed). A refundable deposit is money the supplier holds and
owes back, and an erroneous payment is not consideration for anything: neither
is an amount paid FOR a supply of any 63(1) nature — the pack's own §2.3
reading of 63(7). The answer and the text agree. **REQUIRED** (the four
conditions) · **PRODUCT** (the mechanism below).

**The guardrail, made structural.** Neither "non-resident = WHT" nor "a
taxable nature = WHT" is expressible. The determination has four dimensions,
read in order, none deciding alone (`services/accounting/wht.ts`
`decideWithholding` — the one engine; the preview and a plan's estimate call
it too):

| # | Dimension | Rule | Where enforced |
|---|---|---|---|
| 1 | Recipient | only a supplier declared **non-resident** is judged; resident → not WHT; undeclared → listed (the existing §2.3 exception), never assumed | engine; DB admit `wht_withholding_residency` (0113) |
| 2 | Source | in the Kingdom **unless a person declares otherwise** with the reason (`not_kingdom_source`, Art. 5) — a rebuttable presumption, shown as one (`kingdomSource: presumed`); a declared non-Kingdom source keeps the nature it has and is not WHT | engine; DB CHECK `wht_withholdings_note_chk` |
| 3 | What the money WAS | **consideration** (a bill payment, an advance, a supplier payment wholly allocated to bills) is judged by its nature; a **refundable deposit** → not WHT `refundable_deposit`; an **erroneous** payment → not WHT `erroneous_payment`; money whose purpose is **not identified** → `pending`: nothing withheld, nothing claimed, listed | engine (the class gate runs BEFORE a nature is read); DB admit `wht_withholding_class` (0116) derives the class from the supplier payment's own classification and allocations and admits only the determination that class allows |
| 4 | Rate | the `wht_rates` row in force on the payment date for the declared nature, or an approved treaty relief covering it — unchanged | engine; DB admit `wht_withholding_rate` / `_relief` (0113) |

The supplier's declared default nature applies to **consideration only** —
never to a deposit, an erroneous or an unidentified payment (that was D-12:
every on-account class withheld at the default nature).

**Outcomes** (`WhtDetermination`, the one description a preview and a posted
record share): `taxable_wht` (the statutory rate) · `exempt_relief` (an
approved treaty relief applied — the only relief the existing system supports
in law, §2.3) · `not_wht` (goods; not a Kingdom source; refundable deposit;
erroneous payment; a resident recipient) · `pending_classification` (purpose
not identified; residency undeclared). No category and no rate was added: the
eleven natures and their rates are §2.2's, unchanged.

**Provenance frozen with the record (migration 0116).** Every new
`wht_withholdings` row states `payment_class` (what the money was) and
`nature_basis` (declared on the payment · the supplier's default · from the
class); the admit refuses a row without them. With the rate row, the relief
row and the nature already stored, a later change to the supplier's default
nature, its residency, a relief's revocation or the rate schedule rewrites
nothing posted (rows written before 0116 keep NULL provenance — what was
decided then is not re-derived).

**Reclassification keeps the lineage.** A non-resident's pending or
not-subject record is **superseded** when the payment is classified (a
deposit, an erroneous payment, an advance for goods …): a new record names
the one it replaces (`supersedes_withholding_id`, one per record), and the
replaced row stays. Readers show the live one. A record that WITHHELD tax is
never superseded — it is corrected (§14.1).

**One payment, one purpose.** A payment to a non-resident that settles bills
AND leaves a deposit, an erroneous or an unidentified amount on account would
need its one base split between a withheld and a not-subject part; it is
refused (`wht_mixed_payment_unsupported`) and recorded as two payments.

**What this does NOT decide — named, not guessed:**

- 🔴 **W-16 (NEW) — tax on money paid with nothing withheld, identified LATER
  as taxable consideration** (an unidentified payment or a deposit that turns
  out to be an advance for a royalty). Art. 68(C) makes the payer liable; the
  booking — recovered from the supplier, or borne by the payer and grossed up
  (the W-2 question) — is the adviser's. The build refuses that
  reclassification by name (`wht_late_withholding_open`, 409, stating the
  exposure at the payment date's rate) and records nothing; the payment stays
  pending and listed. The database refuses a superseding WITHHOLDING
  (`wht_late_withholding`) for any path.
- **W-18 (NEW) — the source presumption.** Should every non-resident payment
  carry an explicit Art. 5 source determination rather than a presumption
  rebuttable by declaration? The build keeps §2.3's presumption, labels it as
  one on every determination, and records the declaration when made.
- W-5 (a non-resident's Saudi PE) stays open: no PE status is modelled, and
  the determination says `recipient: non_resident` without a PE claim.
- W-12 (recovery of tax withheld on an advance later refunded) is narrowed,
  not closed: a deposit or an erroneous payment no longer withholds, so its
  refund is no longer refused; a refund of money that DID bear WHT is still
  refused (`wht_refund_unsupported`) — its route is the correction of §14.1.

**Tests** (`phase16-wht-determination`, 16, real rows through the product's
pay paths): non-resident + taxable service · + royalty (supplier default) · +
goods · refundable deposit (default nature royalty — withholds nothing,
refunded in full) · erroneous payment · unidentified (pending, listed; a
nature on it refused) · pending → taxable advance refused (W-16, the exposure
named, nothing changed) · pending → goods / deposit superseded, lineage kept ·
a withheld advance is never reclassified away · one payment, one purpose ·
nature never bypasses recipient or source · treaty relief at 0 % and at a
reduced rate (`exempt_relief`) · history frozen after the default nature,
residency and a relief change · GL ↔ ledger ↔ return (W1, W4) · the preview
judges what the pay path will · the database refuses the same rows (with a
planted positive) · isolation (presence, absence, movement).

**Mutations, each proven red then restored (source by hash, the database
function by `pg_get_functiondef` hash):** M1 the supplier-payment path
judging every payment as an advance — three tests red, the database refusing
`wht_withholding_class`; M2 the database gate reverted to 0113 AND M1 — red on
the FIGURE (the bank paid 17,000 for a 20,000 deposit: 3,000 withheld, the
D-12 defect); M3 the database gate reverted alone — the raw-insert test red;
M4 a declared nature overriding a not-Kingdom-source declaration — red.

### 14.3 Q3 — migration reversal and migrated assets (D-13 / A-6)

**The answer (accountant, 2026-10-05) — Option A.** When a migration batch is
reversed, the fixed assets it created are marked reversed/inactive: out of the
active register, depreciation stopped, lineage kept. The same principle holds
for every opening item the batch created — receivables, payables, inventory,
provisions and the rest. NOT a disposal sale, no disposal gain or loss; the
asset is not left active, depreciation does not continue, and a replacement
migration never creates a second ACTIVE copy. A partial reversal is refused
unless it can be made deterministic; depreciation and reversal journals are
never duplicated; no reversal crosses companies.

**Checked against the record.** The answer is Policy C (1C pack §16.12,
accountant A4/A5) carried to the asset register: a committed migration's rows
are never deleted — the opening journal is MIRRORED and the rows it created
are MARKED; a replacement is new rows with provenance to the old. A disposal
(IAS 16.67–.71) is an event of the ASSET — it leaves the entity, and the
difference is a gain or loss; a reversed migration is the withdrawal of an
opening position these books recorded, so the disposal path is the wrong tool
by construction. No return is engaged: the opening position is not a VAT,
Zakat or income-tax filing, and a tax computation already saved is a versioned
snapshot (§5) the reversal does not rewrite — the next computation reads the
restored books. **REQUIRED** (the accountant's answer) · **PRODUCT** (the
mechanism below).

**As built (migration 0118; `migrationCommitService.reverse`).**

| # | Element | Rule | Where enforced |
|---|---|---|---|
| 1 | Whole batch | a request naming anything to scope the reversal (asset ids, items, a scope) is refused `migration_partial_reversal_unsupported` (422) — a balanced opening position has no deterministic part; read from the RAW body (the contract strips unknown keys, which would silently widen a partial request to the whole) | service `assertWholeBatchReversal` + the controller before parsing |
| 2 | The preview names it all | every asset with each POSTED depreciation entry; every balance the opening journal carried (inventory, provisions and every other line) | `reversalPreview` (`wouldReverse.assets`, `.openingBalances`); the commit page lists both |
| 3 | Blockers, named | a migrated asset DISPOSED of since (its disposal posted proceeds and a gain or loss, and no path reverses a disposal — A-7 below); a depreciation entry in a month closed since (its mirror is dated as it was — reopen the month deliberately; never re-dated, §4 period locks) | preview → 422 `migration_reversal_blocked` |
| 4 | Depreciation unwound | each depreciation entry posted on a batch asset since the cutover is mirrored on its OWN date, through the one journal reverse — no second posting path; the opening mirror (dated the opening date) already removed cost and opening accumulated depreciation | `journalEntriesService.reverse` |
| 5 | The asset MARKED | `status = reversed`, `reversed_at`, `reversed_by_migration_batch_id`; an event `reversed` naming both mirrors and the entries unwound; schedule, events and rows kept as history; carrying amount 0. No disposal record, no gain/loss line | DB: `refuse_capitalised_asset_fact_change` admits `in_service → reversed` only from its own COMMITTED batch and changing nothing else (`asset_reversal_marker`), then freezes the row (`asset_frozen`); nothing is born reversed (`fixed_assets_birth_admit`); CHECKs `fixed_assets_state_chk`, `fixed_assets_reversed_marker_chk` |
| 6 | Out of every run | the run selects assets in service; the act refuses `asset_not_in_service`; the DATABASE refuses planting or posting a schedule row of an asset reversed, disposed or cancelled | trigger `depreciation_refused_out_of_books` (`depreciation_asset_out_of_books`) |
| 7 | Out of every reader | register, movement, income-tax pool and VAT Art. 52 read `in_service`/`disposed`; the reconciliation's register charge excludes a reversed asset (its charge was mirrored), so `FA_EXPENSE` ties; a VAT use record on a reversed asset is refused (`asset_reversed`) | `assets.repository`; `vatCapitalAssetService.declareUse` |
| 8 | Replacement, one live copy | a replacement batch's asset names the reversed asset it replaces, by source id (`replaces_asset_id`; admitted only for a reversed migrated asset of the same company — `asset_replacement_link`); ONE live migrated asset per company and source id | unique index `fixed_assets_migrated_source_live_unq`; lineage both ways in the API (`replacesAssetId`, `replacedByAssetId`) and on the asset page |
| 9 | Every other opening item | receivables, payables and deposits: Policy C unchanged (marked; numbers occupied). Inventory, provisions and every other balance have NO subledger in this product (search shape: `packages/db/src/schema` for invent\|provision\|stock — none; the seeded chart has an `Inventory` ACCOUNT): they are lines of the opening journal, reversed by its mirror, each listed in the preview | the mirror; `migrationRepository.openingBalances` |
| 10 | Once, and only once | the batch row is locked (`FOR UPDATE`); a reversed batch answers itself, writing nothing; a concurrent second caller waits and gets that answer | `findBatchForUpdate` |
| 11 | Permissions, isolation | reverse is ADMIN only (accountant reads the preview — 403 on reverse); company-scoped by RLS — another company or organization gets 404 | rbac; RLS company arm |
| 12 | The sweep | `asset_reversed_unwound` — a reversed asset with a posted depreciation entry not mirrored, or whose batch is not reversed | `scripts/ledgerInvariants.ts` |

**Found on the way, fixed:** a migrated asset never recorded the `created`
event the fixed-assets pack requires of EVERY asset ("Ledger invariants",
`asset_state_evidence`), so the sweep flagged every migrated asset — an alarm
that always fires hides the one that matters. The materialisation now records
it (FA-D's test had encoded the gap: `["capitalised"]`).

**Open — not decided by the build:**
- **A-7 (NEW) — a migrated asset disposed of after the cutover.** The answer
  covers an asset that is still in service. One that was sold, scrapped or
  withdrawn carries a disposal entry, possibly a sale invoice and an Art. 52(8)
  nominal supply; unwinding those is a tax question, not a register one. The
  build REFUSES the reversal by name while such an asset stands — never
  approximates it.
- An Art. 52 use record already declared on a batch asset stays as history
  (a declaration, no entry); the report no longer shows the asset.

**Tests** (`phase16-17-migration-asset-reversal`, 12, real rows; three
companies of one organization and a second organization): one asset (no
depreciation) · two assets with two months of depreciation BEFORE the reversal
· the run and the act AFTER it (the database refusing a planted and a posted
row) · a replacement migration (lineage both ways; one live asset per source,
a planted duplicate refused by the index; the replacement depreciates and the
register ties) · AR, AP, inventory and provision opening balances (zero at
every date) · unrelated post-migration activity intact (a machine bought on a
bill, its depreciation untouched) · repeated and CONCURRENT reversal (one
mirror each) · a locked month and a disposed asset (named blockers) · a
partial request refused (service; HTTP in `batch-1c-migration-http`, where
the accountant's 403 is) · cross-company and cross-organization 404 · the
balance sheet line by line EQUAL to a never-migrated control company's at four
dates (and different by exactly the migrated position before) · asset register
↔ GL and depreciation register ↔ expense, equal to the control's · the sweep
clean, and seeing a planted unmirrored depreciation.

**Mutations, each proven red then restored (source by hash, the database by
its definition):** M11 the depreciation unwind removed · M12 the marking
removed · M13 the service's whole-batch check removed · M13b the controller's
raw-body check removed (HTTP suite red) · M14 the register charge counting
reversed assets · M15 the out-of-books trigger dropped · M16 the one-live-copy
index dropped · M17 the closed-month blocker removed · M18 the replacement link
dropped · M19 the sweep's invariant neutered · M20 a reversed asset no longer
frozen · M21 the disposed-asset blocker removed.

## 15. Final audit and fix pass (2026-10-05)

**Status (2026-10-05): the final comprehensive audit found four blockers and five
recommended fixes; all nine are fixed on `feat/phase16-17-tax-treasury`; the PR
stays OPEN.** Current state authority: [CLAUDE.md §2](../../CLAUDE.md).

The audit: six independent read-only reviews of the Phase 16/17 diff, and about
ninety soft checks on real rows (scenarios A–E, period-lock and concurrency
attacks, cross-company and cross-organisation probes, the cross-ledger
reconciliations), every material claim confirmed on rows before it was ranked.
Each fix below has a regression test on real rows whose expected figure comes
from the fixture, never from a second call to the code under test, and a
mutation proven red. The findings that need a decision are §11 rows (ZK-1,
TR-2, MG-3) — not fixed, by instruction.

| Id | Finding (confirmed) | Fix | Enforced at |
|---|---|---|---|
| OB-1 | The VAT obligation passed full DATES to the month-based return → `"2026-07-01-01"`; document dates are text, so every day-1 document fell out (obligation 300, return 450; to date 0 where 75 was owed) | One computation over a date window, `reportsService.vatReturnBetween`; the month API (`vatReturn`) delegates to it and REFUSES anything that is not a month (the spec's own pattern, never enforced); the obligations call the date window | service (both entry points validate) |
| WHT-1 | Settling a non-resident's bill from a bank line treated the line's CASH as the gross (9,500 line: AP 9,500, WHT 475, bank 9,025) | The line is cash: the bill is settled by the gross whose cash it is — the pay path's arithmetic inverted (`wht.ts` `baseForCash`, the same rate and rounding), the pay path re-deciding on the gross; the cash it moves must equal the line or nothing is written (`settlement_cash_mismatch`); a halala tie no outstanding decides is refused (`settlement_wht_gross_ambiguous`) | service |
| WHT-2 | An expense's approval (which also pays) paid a non-resident with no declaration or preview | The canonical decision judges the payment BEFORE anything is written; a payment it would withhold on, or cannot judge without a nature, is refused by name (`expense_wht_requires_bill_payment`) — pay it from the bill | service |
| MG-2 | The generic journal reverse accepted a migration's opening journal and its mirrors (a reversed batch's position re-imposed while the batch and asset read reversed) | A mirror is never reversed (`journal_mirror_not_reversible`); a migration's own entries are withdrawn only by its batch reversal (`journal_migration_owned`) | service + database (0119 `journal_entries_mirror_admit`, with one answer for another tenant's entry and a missing one) |
| SEC-1 | `wht_return_tax`, `wht_return_base`, `wht_unremitted` ran as their owner and were callable by the app: another company's figures for its id | SECURITY INVOKER — RLS decides what they read (the `input_vat_journal_owner` contract: another tenant's id answers 0); the definer triggers that call them are unchanged | database (0119) |
| MG-1 | A depreciation could commit while a migration reversal was in flight → a reversed asset with an unmirrored charge | The reversal locks the batch's assets FOR UPDATE before reading what was depreciated; a posting reads its asset FOR SHARE (0119 trigger, now caller's rights — SEC-2 too); the refusal is a mapped 409 | service + database |
| TR-1 | The Treasury plan-pay dialog dropped the filed-month treatment → every plan paid into a filed month was refused | The dialog sends the treatment chosen on the screen, as the bill's pay dialog does (the API always took it) | web |
| SEC-4 | A repeated filing recorded a permanent false amendment | The same ZATCA reference is the same filing: an exact replay writes nothing; the same reference on another date is refused (`wht_filing_reference_reused`); a genuine amendment carries its own | service + database (0119 unique index) |
| IT-1 | The income-tax add-back read only the system `DEPRECIATION_EXPENSE`; a category's own expense account escaped it (book depreciation deducted beside the pool) | Plus the register's depreciation on any category account — only lines of entries the register posted (or their mirrors), so another expense on that account is never added back | repository |

**Tests:** `phase16-17-audit-fixes` (13, real rows) and
`phase16-17-audit-fixes-vat` (4, pinned date, day 1 / middle / last day /
prior period / current period, quarterly and monthly); seven callers moved
from full dates to the month contract they always declared (six API suites and
one browser spec — two of them found only by CI on `be6617fe`: the first sweep
matched LITERAL full dates, not variables, so its "none left" was a negative
from an unvalidated probe; every caller was then checked by the value its
argument holds); `d3-cash-cutover` plants its orphan reversal with triggers
off, as the legacy data 0119 now refuses to write; `phase16-17-accountant-answers`
gains the TR-1 walk.

**Mutations, each proven red then restored (source by hash, the database by
its definition):** OB-M1 the obligation on the month API with dates, unvalidated (the original bug) · OB-M2b both period validations removed
(OB-M2, the month check alone, is an EQUIVALENT mutant — the date window's own check still refuses) · WHT1-M1 the cash settled as the gross ·
WHT1-M2 that and no cash check (the original defect) · WHT1-M3 the inverse a halala off (the cash check refuses it) · WHT2-M the expense guard
removed · MG2-M1 the service guard removed (the database still refuses) · MG2-M2 the mirror admit trigger dropped · MG1-M1 the reversal's
up-front lock removed (it then mirrors July and misses August — found only after the first version of the test, which held a lock but posted
nothing, let this mutant survive) · MG1-M2 the trigger without FOR SHARE · SEC1-M `wht_return_tax` back to SECURITY DEFINER · SEC4-M1 the
service replay removed · SEC4-M2 the reference index dropped · IT1-M the custom-account add-back removed. Fourteen red, one equivalent.

**Documented, not fixed in this pass (non-blocking):** RPT-1 (the WHT return
export omits corrections and the filing state), ZK-2 (approval not bound to the
reviewed fingerprint), IT-2 (undeclared repairs read as 0), SEC-3 (an
idempotency key reused on another target answers `replayed`), PERF-1…3,
TQ-1…5, RTL-1…7, and the LOW items of the audit register (WHT-3…9, SEC-5,
SEC-10, IT-3/4, ZK-3/4, AD-1, OB-2/3, TR-3…5, RPT-2/3, UI-1/2, MG-4…8).
