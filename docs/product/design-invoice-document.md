# The invoice document (L1) — design

**Status (2026-09-02): DESIGN AGREED, not built.** Current state authority:
CLAUDE.md §2. This document is the single writer for the invoice artifact's
design decisions; L1 in CLAUDE.md §5 points here and does not restate them.

L1 is the launch blocker named by the first core-path walk: the invoice cannot
leave the product. The signed XML and the QR are minted at approval and reach
nobody, and a simplified invoice's QR exists **to be presented to the
customer**. This is the design for the artifact that presents it.

---

## 1. Language — SETTLED against the primary Arabic text (2026-09-02)

🔴 **This clause is why the section exists: the whole language design rests on
it, and it was previously carried on two secondary sources that agreed with
each other and with neither the Arabic nor each other's emphasis.**

**Source read:** *اللائحة التنفيذية لنظام ضريبة القيمة المضافة*, seventh
edition as amended 3 October 2021, from ZATCA's own site — the **Arabic**
version, which prevails over any English translation (ZATCA states this on
every page of its own translations).
`zatca.gov.sa/ar/RulesRegulations/Taxes/Documents/VAT Implementing Regulations_AR_As amended on October 3 2021_Seventh Edition.pdf`

**Article 53 (الفواتير الضريبية), the clause introducing the required details
(p. 43):**

> «يجب أن تكون الفاتورة الضريبية **باللغة العربية بالإضافة لأي لغة اخرى قد
> تصدر بها**، ومتضمنة التفاصيل الآتية:»
>
> *The tax invoice must be in the Arabic language, in addition to any other
> language it may be issued in, and include the following details:*

**Record-keeping article (p. 54) — a second, independent statement of the same
rule, and broader:**

> «يجب مسك السجلات باللغة العربية، ويجب **اصدار جميع الفواتير باللغة العربية**
> بالإضافة لأي لغة اخرى قد تصدر بها»
>
> *Records must be kept in Arabic, and all invoices must be issued in Arabic in
> addition to any other language they may be issued in.*

### What this settles

| Claim | Verdict |
| --- | --- |
| A wholly **English** invoice | ❌ **Not compliant.** Arabic is mandatory. |
| A wholly **Arabic** invoice | ✅ Compliant. |
| **Bilingual** (Arabic + another language) | ✅ Explicitly contemplated — "in addition to any other language it may be issued in". |

🔴 **The English translations understate it.** The widely-quoted English
rendering — "must include the following *details* in Arabic … also shown on the
Tax Invoice *as a translation*" — differs from the Arabic in two ways: the
Arabic says the **invoice** must be in Arabic (not merely its details), and it
carries **no "as a translation" qualifier**. Do not design from the English.

### The rule for this template

1. **Every label is Arabic.** Always, in every rendering.
2. **Every value renders in Arabic wherever we hold an Arabic form** —
   `customers.nameAr`, `products.descriptionAr`, `categories.nameAr`,
   `companies` seller identity. The schema already carries these.
3. **Stored script is the fallback**, and only where no Arabic value exists (a
   registered Latin-script company name is the common real case — the sample
   from a Riyadh law firm carries its seller name in Latin inside an otherwise
   Arabic document).
4. **A second language may sit alongside**, and side-by-side bilingual is the
   observed Saudi convention. It is a presentation choice, not a compliance one.
5. 🔴 **`nameAr` holding the `"(not yet translated)"` default is a COMPLIANCE
   signal, not a cosmetic one** — it means the Arabic rendering of that row is
   incomplete. The document builder must surface it rather than print the
   placeholder into a legal artifact.

**Superseded rule, recorded as a correction rather than quietly replaced:** the
owner's earlier ruling was that a document must be *wholly* Arabic or *wholly*
English. That was wrong in both directions — wholly English is not compliant,
and bilingual is the case the regulation names. Incident:
[`findings-and-lessons.md`](../history/findings-and-lessons.md), 2026-09-02.

---

## 2. Customisation — levels 1 and 2 only, and WHY that is a product decision

🔴 **ZATCA does not constrain the layout.** From the *Controls, Requirements,
Technical Specifications and Procedural Rules* (Decision 62738, 23/11/1443H),
Annex 1, "Invoice and Credit/Debit Note Format":

> "**No required format as long as the required data are present** in the
> invoices and notes."

What the Resolution *does* constrain: the mandated **field set** (Annex 2), a
printed copy of a Simplified Tax Invoice **must be presented to the customer**,
and the QR **must be generated and printed**.

**So the standard Saudi invoice look is a CONVENTION, not a regulation.**

🔴 **The correction this records** (owner, 2026-09-02): the reasoning first
offered for restricting customisation was that ZATCA constrains the structure.
It does not. That matters more than the conclusion it supported:

- If layout were regulated, level 3 (layout editing) would be **forbidden**,
  and nobody would ever revisit it — a compliance wall built out of a
  convention.
- Because it is not regulated, level 3 is **unnecessary, not forbidden**: a
  product judgement about demand, **revisable the day a tenant needs something
  levels 1–2 cannot express.** The door is left open deliberately.

### The shape to build

**A fixed mandatory core that cannot be edited or switched off**, plus:

- **Level 1 — branding:** logo, accent colour, the seller block's presentation.
- **Level 2 — optional blocks and fields:** each on/off, with a default.

| Region | Editable? | Contents |
| --- | --- | --- |
| **Mandatory core** | ❌ never | The ZATCA field set; the QR; the document type in the title; the totals, **derived** |
| Level 1 | ✅ branding | Logo, colour, fonts |
| Level 2 | ✅ on/off | Bank details, terms footer, stamp area, amount in words, product codes, customer code, purchase-order reference |

Making the compliance-critical region **inexpressible to break** is §3's
"make the wrong thing inexpressible, not forbidden", applied here.

### Evidence the two levels are enough
Across both reference documents, every tenant-specific difference is either
**data** (logo, registered name, bank, customer/product codes) or **a block
present or absent**. Neither rearranges anything. If a tenant ever needs a
layout these cannot express, that is the signal to reconsider level 3 — not a
hypothesis to build against now.

---

## 3. Reference layout

**Primary reference:** a real Saudi tax invoice from a Riyadh law firm
(Arabic-first, RTL), supplied by the owner's accountant. **Secondary:** a
generated bilingual sample, used only where the real one is silent.

🔴 **The reference document itself is NOT in this repository, deliberately.**
It is a real client invoice carrying a named individual, two VAT registration
numbers, addresses and a payment reference. Committing it would put a third
party's identity into an append-only history for a layout reference — the
PDPL question in §5's C8, self-inflicted. Everything the design needs from it
is described below in prose; the file stays outside the repo.

### Take from the real invoice
- **Header is a label/value table, not prose blocks:** invoice number,
  description, issue date, due date, **supply date**, location, **creation
  date/time (to the second)**, **special-transaction code** (the ZATCA
  invoice-subtype flags, printed on the human-readable copy).
- **Document type is in the title.** «فاتورة ضريبية» for a standard invoice,
  «فاتورة ضريبية مبسطة» for a simplified one. That is the whole of the
  type-visibility requirement — no separate badge needed.
- **QR at the BOTTOM**, large and standalone — not a header corner.
- **Payment settlement inside the totals block** ("paid by receipt PYT42, Al
  Inma current account"), with **amount due as the final row**.
- **The Saudi Riyal symbol as a glyph**, not the text "SAR" (the reference
  embeds `saudi_riyalregular`).
- **Product code above the description** on each line.
- Seller and customer blocks as «مفوتر من» / «مفوتر إلى», each carrying VAT
  number, CR, address, and a customer code.

### Take from the generated sample only where the real one is silent
Bank details block, terms-and-conditions footer, signature/stamp area.

### 🔴 Defects in the generated sample — do not inherit
1. **The arithmetic did not reconcile** (lines summed 15,410; the summary said
   9,545). 🔴 **The summary is DERIVED from the lines. Never carry both as
   independent values** — that is the header-versus-lines class §4 already
   closes at the write boundary, and it must not reappear at the presentation
   boundary.
2. **The amount in words appeared twice**, with different casing and wording.
   One field, one rendering — and see below.
3. **It did not state whether it was a Simplified or Standard tax invoice.**
   The real document settles this in its title.

### Amount in words
Twice in the generated sample; **absent entirely from the real one**. It is
therefore a **level-2 toggle, default OFF** — not a required field wearing the
appearance of one.

---

## 4. Format target — PDF/A-3 with embedded XML

The Resolution names the human-readable formats directly (Clause Third, A):

> "…generate invoices and their associated notes in the **XML format or PDF/A-3
> format (with embedded XML)**…"
> "Persons subject to E-Invoicing Regulation **must present to their customers a
> printed copy of the Simplified Tax Invoice**…"

🔴 **Target PDF/A-3 with embedded XML from the start** (owner, 2026-09-02).
Building a plain PDF now and converting later is the same mistake as building
the navigation before the features: the embedding constraint shapes the
generator, and retrofitting it means rewriting it.

---

## 5. What is NOT decided here
- The PDF generation library and whether it runs in-process or as a job.
- Where the artifact is stored and whether it is archived (`ArchiveStore` has
  no `delete` by design — §4).
- Sending (B1's mail provider is a deployment-time item).
