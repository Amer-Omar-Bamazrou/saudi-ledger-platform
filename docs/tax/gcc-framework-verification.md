# C11 — GOVT_FEES / GOVT_GRANTS / GOSI: verified against the primary texts

**Status (2026-08-23): CLOSED — desk research in the C9/C12 shape. Current
state authority: CLAUDE.md §2.**

The three O ("outside the scope") defaults that C9 deliberately left assumed
because "the sovereign-capacity and no-supply rules live in the GCC VAT
Framework Agreement (Art. 9 area), which was NOT read." That sentence turned
out to be wrong in BOTH halves — which is exactly why the owner's rule
(verify against the text, never reason) exists.

## Sources (all read directly, in full or as cited)

1. **Common VAT Agreement of the States of the GCC** — ZATCA's own hosted
   copy (zatca.gov.sa → GCC VAT Agreement PDF, published Um Al-Qura issue
   4667, Royal Decree M/51). **All 78 articles read.** Watermarked
   "Unofficial Translation" — the Arabic original (executed 27/2/1438H)
   prevails; the C12-D2 caveat applies.
2. **KSA Law of Value Added Tax, Royal Decree M/113 (25 July 2017)** —
   Bureau of Experts at the Council of Ministers, Official Translation
   Department (laws.boe.gov.sa). Chapters 1–14 read. "The governing text is
   the Arabic text."
3. **KSA VAT Implementing Regulations, Eighth Edition (09/11/2021G)** —
   zatca.gov.sa official English PDF (the same document C9 read). TOC and
   the scope/supply articles re-read for this pass (Arts. 14–19).
4. **ZATCA Guideline on the IR amendments per Board Resolution 01-06-24
   (19 Nov 2024), Issue 1, April 2025** — zatca.gov.sa; quotes the amended
   regulation text verbatim. (The consolidated post-amendment English IR is
   not yet published as one document; the guideline is ZATCA's own statement
   of the amended text.)

## 🔴 Finding zero: the delegation chain — and C9's location guess corrected

- The Agreement's **Article 9 is "Receiving Goods and Services"** (the
  reverse-charge article). It has nothing to do with government bodies.
- **The Agreement contains NO sovereign-capacity article at all** (verified
  by reading all 78 articles, not by search). The only mentions of
  government in the Agreement are: **Art. 30** (a Member State MAY relieve
  or refund "Government bodies specified by each State" **as customers** —
  about the government's own purchases, not its supplies), **Art. 26(6)(b)**
  (subsidies — below), and Art. 69 (foreign governments' refunds).
- The out-of-scope question therefore delegates: Agreement (definitions
  only) → **KSA VAT Law Art. 8**: *"The Regulations shall determine the
  transactions in which the supply of goods and services falls outside the
  scope of tax"* → **IR Article 17**, which is titled "Transactions not
  falling within the scope of tax" and covers ONLY the transfer of an
  economic activity (TOGC). **No KSA instrument enumerates sovereign
  supplies as in- or out-of-scope.** The scope is carried entirely by the
  definitional chain: Agreement Art. 1 (Supply = "for consideration";
  Taxable Person = "conducting an Economic Activity **independently for the
  purpose of generating income**"; Economic Activity = "ongoing and regular
  ... commercial, industrial, agricultural or professional activities") +
  Art. 2 (tax imposed on Taxable Supplies **by a Taxable Person**) + Law
  Art. 2 + IR Art. 14 (tax on supplies "made by a Taxable Person in the
  Kingdom **in the course of carrying on their Economic Activity**").

**Search shape (standing check part 5):** what would have falsified "no
sovereign provision exists" — an article in any of the three instruments
making government supplies taxable, exempt, or out-of-scope. Searched: the
Agreement's full 78 articles (read); the Law's full TOC and chapters 1–14
(read); the IR Eighth Edition's complete article TOC plus Arts. 14–19 in
full; the 2024-amendments guideline's complete TOC (§2.1–§2.14). None
exists.

## Verdicts

| Category | Default | Verdict | Basis |
| --- | --- | --- | --- |
| **GOVT_FEES** | O | ✅ **VERIFIED for sovereign/statutory charges** — the class the category's engine rules actually match (traffic fines via SADAD, license/permit/visa fees, Qiwa/Muqeem/Najiz/Etimad charges). | The definitional chain above: a government body collecting a statutory fee or fine is not "conducting an Economic Activity independently **for the purpose of generating income**" (Agr. Art. 1), so no Taxable Supply arises (Agr. Art. 2; Law Art. 2; IR Art. 14) and the payer bears no VAT to extract. A fine additionally involves **no supply for consideration at all**. Error direction if ever wrong: O on an expense claims NO input VAT — the safe direction. |
| **GOVT_GRANTS** | O | ✅ **VERIFIED for true subsidies — with a 🔴 CONDITION now in positive law** (below). | **Agr. Art. 26(6)(b)**: "The value of the Supply is reduced by ... the value of subsidies granted by the Member State to the Supplier" — the Agreement's own arithmetic places a genuine state subsidy OUTSIDE the taxable value. |
| **GOSI_EXPENSE** | O | ✅ **VERIFIED by the same chain that verified SALARIES in C9** — with the honest note that **no text names GOSI**. | Employer contributions are compulsory statutory levies under the Social Insurance Law: no Supply "for consideration" (Agr. Art. 1) is made to the employer, and GOSI does not collect them "independently for the purpose of generating income" in an "ongoing and regular commercial, industrial, agricultural or professional" activity. The same plain-text application of Art. 1/Art. 2 that C9 recorded as VERIFIED for SALARIES ("employment is not independent"). Not commercial insurance, so IR Art. 29 (financial services / insurance exemption) is not the basis and is not needed. |
| **GOSI_PAYABLE** | (no treatment) | ✅ **VERIFIED as correctly treatment-less** — a liability account records the obligation, not a supply; the expense side carries the (O) classification. | Structural; no supply exists on either reading. |

## 🔴 The GOVT_GRANTS condition — IR Art. 39(2), and it cuts the UNSAFE way

The November 2024 amendments (BoD Resolution 01-06-24) added **Paragraph (2)
of Article 39** of the Regulations, quoted verbatim in ZATCA's April 2025
guideline (§2.8):

> "Amounts paid by a government entity to a supplier are not considered
> subsidies if they constitute full or partial compensation for the supply
> of goods or services to the government entity."

ZATCA's own reading, same section: if the paid amount (or part of it)
corresponds to supplies benefiting the government **directly or
indirectly**, it is **taxable consideration**, not a subsidy — their Example
17 treats "financial support covering all infrastructure costs" as
consideration for a supply of infrastructure.

**Why this matters more than the verdict:** every other O in this pass sits
on the SAFE error side (an expense misread as O claims no input VAT). A
grant-labeled receipt that is really consideration, booked as O, **omits
output VAT from the filing figure** — the unsafe direction, the FOOD_MEALS
shape mirrored onto income. The category default stays O (the true-subsidy
case), and the condition is recorded here and on the migration: **a
GOVT_GRANTS row where the government received anything identifiable in
return is 'S' per IR Art. 39(2)** — that is a per-row fact about the grant
agreement, answerable by the tenant, not a category-level rule the platform
can decide. The review surface's per-row treatment override is the existing
mechanism.

## What this pass deliberately does NOT do

- No advisor question is created. The texts answered all three; the one
  conditional (grants) is a per-row fact, not an ambiguity.
- No engine or UI change. The defaults were already O; this pass verifies
  them (`treatment_verified`, migration 0057) and records the grants
  condition. If GOVT_GRANTS volume ever becomes real, a UI prompt on that
  category ("did the government receive anything in return?") is the
  design-shaped follow-up — noted, not built.
- The standing caveat: all three English texts are translations; the Arabic
  prevails (explicit in all three documents). The load-bearing words here —
  "for consideration", "independently for the purpose of generating income",
  "compensation for the supply" — are central enough to the scheme that a
  translation error in all of them at once is unlikely, but the caveat is
  the same D2 recorded for C12.
