# Invoice numbering (C12) — primary-source verdict and citations

**Method (2026-08-20), the C9 standard.** Every verdict below is checked
against the **primary legal text**, not a guideline and not a secondary
summary. Two documents, both downloaded from zatca.gov.sa and read directly:

| # | Document | Edition | Local copy |
| --- | --- | --- | --- |
| **[R]** | **Controls, Requirements, Technical Specifications and Procedural Rules for Implementing the Provisions of the E-Invoicing Regulation** ("the Resolution") | 19 May 2023, 35 pp. | `docs/zatca/specs/ZATCA_E-Invoicing_Implementation_Resolution_20230519_EN.pdf` |
| **[V]** | **Implementing Regulations of the Value Added Tax Law** ("the VAT IR") | Eighth Edition, 04/04/1443H / 09/11/2021G | `docs/zatca/specs/KSA_VAT_Implementing_Regulations_EN.pdf` |

🔴 **Both are ZATCA's own English translations and both carry the disclaimer
that the ARABIC version is the official one and prevails on any discrepancy.**
Every verdict here is therefore verified against the English text and carries
that residual caveat; nothing below turns on a fine shade of wording.

🔴 **The instruction this work was given, and why it mattered:** *do not infer
the invoice-number rule from how the ICV rules work — they may differ.* They
do. Conflating them would have produced a materially more complex allocator
than the law requires, and would have missed that the year-reset in the
existing code is the part that is actually unsupported.

---

## 1. The delegation chain (this is what makes the answer findable)

The Resolution does **not** state the numbering rule itself. Annex (2), field
**2.1**, defines the invoice-number field and delegates:

> **[R] Annex (2), field 2.1 — "Invoice Identifiers"**
> *"Invoice Reference Number (IRN): A unique, sequential note number, issued
> by taxpayer, **as per Article 53(5)(b) of the VAT Implementing
> Regulation**."*
> (Marked **Required** for Tax Invoices and **Mandatory** for Simplified.)

So the operative rule is in the VAT IR, and it is one clause:

> **[V] Article 53(5)(b)** — "A Tax Invoice must include the following details
> in Arabic … **b) a sequential number which uniquely identifies the Tax
> Invoice**"

That is the entire legal requirement for the invoice number: **sequential**,
and **uniquely identifying**.

Two supporting facts about the shape of the obligation:

- **[V] Art. 53(8)** lists the mandatory contents of a **Simplified** Tax
  Invoice — date, supplier name/address/TIN, description, consideration, tax —
  and **does not include a sequential number at all.** The IRN becomes
  mandatory for simplified *e-invoices* only through **[V] Art. 53(9)**, which
  empowers the Governor to "specify any additional details … for the purposes
  of applying the provisions of the electronic billing regulation" — the hook
  the Resolution's Annex (2) hangs on.
- **[R] Annex (2)** lists the IRN (2.1) and the **tamper-resistant counter
  value (2.5)** as *separate fields*. They are not the same thing and are not
  governed by the same rule.

---

## 2. ✅ ANSWER 1 — Does ZATCA permit GAPS in invoice numbering?

### Verdict: the regulation requires SEQUENTIAL + UNIQUE. It does NOT require an unbroken series, and it does not prohibit gaps.

**What the text says:** "a sequential number which uniquely identifies the Tax
Invoice" ([V] 53(5)(b)).

**What the text does not say — checked, not assumed.** Neither document
contains the words *unbroken*, *without gap*, *gapless*, or *consecutive* in
connection with invoice numbering (the single hit for "consecutive" in [V] is
an unrelated twelve-month registration period at p. 539 of the extract).
Neither document contains *cancel* or *void* in a numbering context at all.

### 🔴 The decisive internal evidence: ZATCA DID write a gapless rule — for the other field

> **[R] Section 7 (E-Invoice Generation Solution requirements)** — *"The
> Compliant E-Invoice solution must have a tamper-resistant Electronic Invoice
> **counter that cannot be reset or reformatted**. The counter **must increment
> for each generated Electronic Invoice** or associated note…"*

And in the **Prohibited Functionalities** table, *"Electronic Invoice counter
reset"* is listed as prohibited outright.

So ZATCA knows how to require an unbroken, non-resettable series, and did so
explicitly — for the **ICV counter**, a different field, in a different
section. It wrote no such words for the IRN. The contrast is the argument: had
the IRN been intended to be gapless, the Resolution that spells that out for
2.5 would not have left it unsaid for 2.1.

### What this means for the design

**A simple counter plus a unique constraint is sufficient.** The reservation
discipline the ICV chain needs — the advisory lock covering the read and the
write, so no value is ever skipped — is **not required by the regulation for
the invoice number**, and adopting it would be building to an inferred rule
rather than the written one.

Uniqueness is enforced by the database. Sequentiality is satisfied by
allocating `max + 1`. A gap can arise only if an allocated number is discarded
(a rolled-back transaction or a deleted draft) — and the regulation does not
forbid that.

### 🔴 What stays ASSUMED, with what would settle it

The verified fact is that **the text imposes no gapless requirement**. Whether
ZATCA's *audit practice* would question a gap in a taxpayer's IRN series is an
enforcement question the text cannot answer.

**What would settle it:** a ZATCA ruling or the C7/C8/C10 advisor. It is worth
asking, but it does not gate this fix — because the fix as designed produces
gaps only in the cases the regulation is silent about (a discarded draft), and
never a duplicate, which is the part the regulation *does* speak to.

---

## 3. ✅ ANSWER 2 — What is the numbering SCOPE?

### Verdict: per COMPANY (the taxpayer), ONE series covering invoices and their notes together. NOT per document type, and NOT restarted per year.

**Per taxpayer, not per organization.** [V] 53(5)(b) requires the number to
"uniquely identify the Tax Invoice" among the supplier's invoices. In this
platform the taxpayer is the **company** — it carries the VAT registration and
is the EGS unit — which is why the ICV is already company-scoped. The
constraint is therefore `UNIQUE (company_id, invoice_number)`.

**One series, covering notes too — and multiple concurrent series are
PROHIBITED:**

> **[R] Section 2** — *"The Compliant E-Invoice solution **must not be able to
> generate more than one sequence of Electronic Invoices and Electronic
> Notes** issued through each of the units within the E-Invoice Solution
> used."*

> **[R] Prohibited Functionalities table** — *"Multiple Electronic Invoice
> sequences: Allow ability to generate more than one Electronic Invoice
> sequence at any given time"* — listed as **prohibited**.

Note the phrase "Electronic Invoices **and** Electronic Notes" — one sequence
spans both. So a separate series per `documentType` (one for invoices, one for
credit notes) is **not** available. Our schema already stores notes as rows in
`invoices`, so a single per-company series is the natural fit.

🔴 **Honest scoping of this citation:** [R] §2 defines "Unit" by reference to
hashing and stamping, so it is written about the *chain* sequence. It is
therefore direct authority against multiple **chain** sequences and strong —
but not conclusive — authority about the IRN series. The conclusion does not
rest on it alone: [V] 53(5)(b)'s "uniquely identifies" already establishes the
taxpayer as the uniqueness scope, and nothing anywhere authorises a second
concurrent series.

### 🔴 The year-reset is the part that is NOT supported — and we were doing it

M21.2 introduced a server-side allocator producing `INV-{YYYY}-{NNNN}` with the
counter **restarting each January**. Nothing in either document authorises a
per-year restart, and a restart is the one arrangement that sits awkwardly
against both "sequential" and "not more than one sequence": after 1 January the
series stops ascending and begins again.

It is probably tolerated in practice — a year-prefixed number is still unique,
and the practice is common internationally — but "probably tolerated" is
exactly what this document exists to eliminate. **The counter therefore becomes
monotonic per company and never resets.** The year stays in the *display*
prefix for human readability, but it no longer resets the count:

```
INV-2026-000045
INV-2026-000046
INV-2027-000047      ← the year changes; the series does not restart
```

This is unambiguously sequential, unambiguously unique, one series per company,
and readable. It costs nothing to prefer it over the reading that needs an
argument.

---

## 4. What was wrong before this (the C12 defect, restated with the law behind it)

| Defect | Verified against |
| --- | --- |
| The number was minted **in the browser** as `` INV-${Date.now().toString().slice(-6)} `` (`Invoices.tsx:36`) — a truncated millisecond clock, and any client could POST any string | [V] 53(5)(b): the number must be *sequential*. A truncated clock is neither sequential nor guaranteed unique. |
| **No unique constraint existed** on `invoices.invoice_number` anywhere | [V] 53(5)(b): the number must *uniquely identify* the invoice. Nothing enforced it. |
| M21.2's server-side allocator **restarted each year** | §3 above — unsupported by the text. |

**Why it mattered more than a UX wart:** the number is written straight into
**`cbc:ID`** (`ubl/…:183`) — the invoice's legal identifier in the transmitted
ZATCA document — and into the **`BillingReference`** a credit or debit note
uses to name the invoice it corrects (`:201`). A collision therefore meant two
ZATCA documents sharing an identifier, and a note whose reference was ambiguous
— while `original_invoice_id` (the real FK) stayed correct, so **the database
and the transmitted document would disagree about which invoice was
corrected.**

## 5. What this does NOT settle

- **Whether ZATCA questions gaps in audit practice** (§2 above) — advisor/ruling.
- **Arabic-version discrepancies.** Both texts are ZATCA's unofficial English
  translations; the Arabic prevails. Nothing here turns on fine wording, but
  the caveat is real.
- **Historical duplicates in a real tenant's data.** The dev database has none
  (checked), so the constraint applies cleanly today. A tenant migrating
  legacy invoices could carry duplicates, and the migration is written to fail
  loudly rather than silently rename anything.
