# VAT treatment verification (C9) — verdicts and citations

**Method (2026-08-19):** every verdict below was checked against the
**primary source** — the official English PDF of the KSA VAT Implementing
Regulations, downloaded from zatca.gov.sa and read page by page (the file is
image-based; pages were rendered and read visually). Article citations refer
to that document. Per the standing trust order, no verdict rests on a
secondary summary; per the owner's rule, anything genuinely ambiguous stays
`assumed` with **what would settle it** recorded, rather than being resolved
by reasoning.

A structural note on method: the KSA VAT system taxes at the standard rate
BY DEFAULT and enumerates its exceptions (Chapter 5 exempt, Chapter 6
zero-rated). Verifying 'S' therefore means verifying that **no enumerated
exception plausibly covers the category** — that is the verification, not a
shortcut around it.

## 🔴 The third axis: `input_vat_blocked`

Recoverability is neither treatment nor basis (owner decision, 2026-08-19 —
recorded on the column in `categories.ts` and migration 0048). Art. 50 lists
expenditure classes whose input VAT a taxable person may not deduct even
though it was charged and paid. The flag lives on the category; readers of
the recoverable-input-VAT estimate exclude it; the paid-VAT fact stays on
the transaction; the excluded amount is returned as `vatBlocked`, never
silently dropped.

## ✅ VERIFIED (treatment_verified = true)

| Category | Treatment | Basis of verification |
| --- | --- | --- |
| **FOOD_MEALS** | S, **input_vat_blocked = TRUE** | Art. 50(1)(a) (any form of entertainment, sporting or cultural services) and 50(1)(b) ("catering services in hotels, restaurants and similar venues") — input tax not deductible; the supply itself is standard-rated. 🔴 **This was a LIVE WRONG DEFAULT**: the engine counted meal VAT as recoverable. Corrected at the read side (migration 0048 + summary exclusion). Exception preserved by the law: onward taxable supply (Art. 50(4)) — a restaurant buying catering for resale deducts; that tenant overrides per row. |
| BANK_CHARGES | S | Art. 29(1): financial services exempt "except in cases where the Consideration payable... is by way of an explicit fee, commission or commercial discount" — bank fees are explicit fees. (M16.2's verification, citation now attached.) |
| INSURANCE | S | Art. 29: life insurance/takaful exempt (29(8) definition); non-life is not enumerated → standard-rated. (M16.2's verification, citation attached.) |
| SALARIES | O | Art. 2: a Taxable Person "conducts an Economic Activity **independently**" — employment is not independent, so salaries are outside the scope. |
| INVESTMENTS | E | Art. 29(1) + 29(2)(a): "the issue, transfer or receipt of, or any dealing with, money, any security for money" — exempt financial services. |
| MARKETING, IT_SOFTWARE | S (+ `vat_basis` mechanism) | Standard-rated by the enumerated-exceptions structure when supplied by a resident. For non-resident suppliers, Art. 47(1) verified verbatim: the taxable customer pays "by way of the Reverse Charge Mechanism," reporting output and input tax in the return — so the bank debit carries NO KSA VAT and extraction from it would invent input VAT. The engine's `vat_basis = reverse_charge` behavior is the correct implementation of Art. 47(1). 🔴 The per-supplier list stays ASSUMED — see below. |
| SALES, SERVICE_INCOME | S | Enumerated-exceptions structure; domestic supplies standard-rated. Exports are Z per line (Art. 32, goods; Art. 33, services to non-GCC residents) — handled line-level via `tax_category_code`, not by the category default. |
| TELECOM, OFFICE_SUPPLIES, REPAIRS, PROFESSIONAL_FEES, PURCHASES, FIXED_ASSETS | S | Enumerated-exceptions structure; no exemption or zero-rating plausibly covers these classes. |
| RENT_UTILITIES | S | Art. 30 (as amended 01/10/2020) exempts only (1)(a) real-estate **ownership transfers** and (1)(b) **residential** lease/license; a business's commercial premises lease and utilities are standard-rated. Edge recorded: staff residential housing rent would be exempt — per-row override. |
| FUEL_TRANSPORT | S | Fuel is standard-rated (no enumerated exception). Two nuances recorded, neither changing the default: Art. 50(1)(e) blocks input VAT on fuel for **Restricted Motor Vehicles** only (vehicles available for private use, Art. 50(2)) — conditional per vehicle, so `input_vat_blocked` stays FALSE for the category; Art. 34 zero-rates **international** transport — per-line Z, not the category default. |

## 🟡 STAYS ASSUMED — with what would settle each

| Category | Current default | Why it stays assumed | What would settle it |
| --- | --- | --- | --- |
| RENTAL_INCOME | S | The LAW is clear (commercial lease S; residential lease E, Art. 30(1)(b)); the CATEGORY conflates both. | A product decision, not a legal one: split the category or rely on per-row overrides. No advisor needed. |
| TRAVEL | S | Mixes standard-rated hotels, zero-rated international passenger transport (Art. 34(2)), and Art. 50(1)(a)-blocked entertainment. | Product decision on granularity; the legal positions are already verified above. |
| LOANS | O | Principal movements are money flows, not supplies (O); interest is an exempt financial service (Art. 29(2)). Bank repayment rows bundle both. | Advisor confirmation that treating bundled repayment rows as O (with interest identified per row where visible) is acceptable practice — **advisor Block A/D**. |
| INVESTMENT_INCOME | E | Interest is exempt (Art. 29); dividends are arguably outside scope entirely (no supply) → O. Mixed. | Advisor: correct default for a mixed investment-income category — **advisor**. |
| ~~GOVT_FEES, GOVT_GRANTS, GOSI_EXPENSE/PAYABLE~~ | O | ✅ **RESOLVED by C11 (2026-08-23)** — and this row's premise was wrong in both halves: the Agreement's Art. 9 is REVERSE CHARGE, and no sovereign-capacity article exists anywhere in the Agreement/Law/IR chain (verified by reading all 78 Agreement articles, not by search). The O verdicts are verified from the definitional scope chain; 🔴 GOVT_GRANTS carries the IR Art. 39(2) condition (a grant compensating supplies benefiting the government is taxable consideration — the UNSAFE error direction). | [`gcc-framework-verification.md`](gcc-framework-verification.md) + migration 0057. |
| INVENTORY, OTHER_EXPENSES, OTHER_INCOME | S / null | Catch-alls with no single rule to verify against. | Nothing external — these are honest unknowns by design. |
| 🔴 **The foreign-digital-supplier list** (`vat_basis = reverse_charge` flags for Google, Meta, AWS, Microsoft, Adobe…) | assumed | Several platforms have KSA VAT registrations on some product lines; whether a given supplier charges KSA VAT is a fact about THAT supplier's current billing entity. | **An actual invoice from each supplier** to a KSA business — verifiable the day a real tenant uploads one; not verifiable from web pages that may lag the billing reality. Error direction if wrong: UNDER-claims input VAT (safe direction). |

## What changed on the dev organization (measured)

Two accepted FOOD_MEALS rows carried extracted VAT (Al Baik 37.50, Panda
56.84). **SAR 94.34 of non-deductible meal VAT was counting toward the
recoverable-input-VAT estimate** and no longer does; it now appears as the
named `vatBlocked` figure with the Art. 50 explanation on the VAT page.
