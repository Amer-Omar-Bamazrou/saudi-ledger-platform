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
5. 🔴 **A PLACEHOLDER MUST BLOCK THE DOCUMENT — the builder REFUSES, it does
   not print.** `nameAr` (or `descriptionAr`) still holding
   `"(not yet translated)"` means the Arabic rendering of that row is
   incomplete, and Arabic is the mandatory language. Printing the placeholder
   would put the literal string "(not yet translated)" into a legal artifact
   that carries a ZATCA stamp and cannot afterwards be edited or deleted.

   So the document builder raises a **blocking condition on the document** —
   named rows, named fields, and what to fill in — rather than falling back
   silently. This is §3's **withhold a number that would mean nothing**,
   applied to a compliance field: the honest output is a refusal that says
   which translations are missing, not a document that looks complete and is
   not. 🔴 It is a *refusal that teaches the next step*, not a hidden control
   (AUD-7): the message names the rows and links to them.

   Consequences to build with:
   - The check runs at **artifact build**, not at approval — an approved
     invoice is already legally issued; blocking there would be too late and
     would strand a valid document.
   - It is a **document-level** condition, so one untranslated line blocks the
     whole artifact rather than printing a half-Arabic page.
   - The seller's own registered Latin-script name is **not** a placeholder and
     must not trip it (rule 3 above) — the test is the literal default value,
     not "is this Arabic script".

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

### 🔴 DECIDED (owner, 2026-09-02)

**Logo — uploaded, stored, and ABSENT when there is none.**
One upload in Company Settings (PNG/JPG/SVG, size-capped, magic-byte sniffed —
M-5's rule applies to it), kept through the existing storage seam. **No
fallback mark.** When a tenant has no logo the header carries the registered
name alone.

> *"A text mark is a fake logo, and a stand-in that looks designed is worse on
> a legal document than an empty space."*

That is the omit-rather-than-promise rule (the dead Export buttons, the
VendorDetail precedent) applied to branding: an absence that looks like a
decision is worse than an absence that looks like an absence.

**The four level-2 toggles, with their defaults:**

| Block | Default | Why |
| --- | --- | --- |
| Bank details | **ON** for invoices, **OFF** for credit notes | A customer paying an invoice needs somewhere to pay; a credit note is money going the other way |
| Terms & conditions footer | **OFF** until the tenant writes one | — |
| Signature / stamp area | **OFF** | — |
| Amount in words | **OFF** | Twice in the generated sample, absent from the real invoice |

🔴 **The last three share a shape, and it governs every optional block added
later: AN EMPTY BLOCK PRINTS ITS EMPTINESS.** An unwritten terms footer prints
a heading with nothing under it; an unused stamp area prints an empty bordered
box on a PDF nobody will ever physically stamp. Both look like something went
wrong, on a document a customer keeps. **So an optional block defaults OFF and
turns itself on only when it has content** — the placeholder problem in
document form, and the same rule as the `nameAr` refusal in §1: do not print a
space where a value should be.

**PDF/A-3 is v1, not a follow-up** — see §4. If it materially changes the
renderer choice, that is a decision to bring back rather than absorb.

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

### 🔴 It DOES change the renderer choice — and the binding constraint is Arabic, not PDF/A

Reported before picking anything, because the two requirements pull in
opposite directions and no single library satisfies both:

| | Arabic shaping | PDF/A-3 + embedded XML |
| --- | --- | --- |
| `pdf-lib`, `PDFKit`, `pdfmake` | ❌ no contextual shaping or bidi — Arabic comes out as disconnected letters in visual order unless we pre-shape with harfbuzzjs and reorder with a bidi library ourselves | ⚠️ can attach files and write metadata |
| Chromium (Puppeteer/Playwright) | ✅ correct — HarfBuzz shaping and bidi, the same engine the app is already rendered in | ❌ print-to-PDF writes no PDF/A metadata and cannot attach files |
| Ghostscript | n/a (converter) | ✅ real PDF/A conversion, at the cost of a heavy native binary in the deployment |

🔴 **Arabic shaping is the harder constraint, and it is the one we cannot get
wrong** — §1 makes Arabic mandatory on the document, and hand-rolled shaping on
a legal artifact is exactly the class of work that looks right in a sample and
is wrong for some tenant's name.

**The shape that satisfies both is two-stage:** render with Chromium (correct
Arabic, and the layout is HTML/CSS we already know how to write), then
post-process with a PDF library to attach the signed XML and add the PDF/A-3
XMP metadata and OutputIntent.

### ✅ VERIFIED BY SPIKE (2026-09-02) — veraPDF says PASS

```
PASS  stage2-pdfa3.pdf  3b
isCompliant="true"   passedRules="146"   failedRules="0"
```

**The verdict is the validator's, not the script's** — the spike script only
produces files and says so in its own output.

**The first run FAILED, and the two failures were worth having:**

| ISO 19005-3 | veraPDF's words | Fix |
| --- | --- | --- |
| 6.2.4.3 | *"DeviceRGB colour space is used without RGB output intent profile"* | embed an sRGB ICC profile as the PDF/A OutputIntent |
| 6.1.3 | *"Missing or empty ID in the document trailer"* | write a file identifier — pdf-lib does not |

🔴 **144 of 146 passed on that first run, including every font-embedding rule** —
the one class that could have killed the approach. Neither failure touched
Arabic. After both fixes: 146/146.

**Arabic survives as real text, not pixels.** `pdftotext` on the Chromium
output returns «فاتورة ضريبية», «شركة الفيصل التجارية», «د. الجوهرة بنت عبدالله»
— correctly shaped, correctly ordered, selectable Unicode. So the choice
between correct Arabic and conformant PDF/A-3 does not have to be made; the
two-stage pipeline gives both.

Also confirmed by decompressing the object streams: `AFRelationship`,
`invoice.xml`, `GTS_PDFA1` and `OutputIntents` are all present, the embedded
XML is recoverable, and the QR is a real 300×300 image on page 1.

### 🔴 The one thing the spike did NOT settle: which ICC profile ships

The mechanism is proven; **the artefact is not.** The spike embedded
`C:\Windows\System32\spool\drivers\color\sRGB Color Space Profile.icm` —
**Copyright © 1998 Hewlett-Packard**, licensed to Windows users and **NOT
redistributable by us**. It proved the OutputIntent works and must never ship.

**Chosen source: Debian's `icc-profiles-free` package** (owner, 2026-09-03),
taken over a browser-driven fetch from the ICC registry. Three registry URLs
returned HTML rather than a profile to `curl` — a build step that needs a
JS-capable client to download a licence-bearing binary fails quietly later,
whereas a packaged artefact can carry a **pinned checksum**, which is the same
discipline as the ZATCA manifest.

The ICC's own terms, for the record, are met by shipping the file unmodified:

> "…permission to use, copy and distribute this file for any purpose is hereby
> granted without fee, provided that the file is not changed including the ICC
> copyright notice tag, and that the name of ICC shall not be used in
> advertising or publicity…"

### v1 dependencies, named rather than discovered later

| Dependency | Why it is v1 |
| --- | --- |
| Chromium (via Playwright) | The only renderer that shapes Arabic correctly. 🔴 **~150 MB added to the deployment** — a C6 hosting line, not a footnote |
| `pdf-lib` | Attaches the signed XML, writes the PDF/A-3 XMP, OutputIntent and trailer ID |
| **A QR image library** (e.g. `qrcode`) | 🔴 **A simplified invoice's QR exists to be PRESENTED, so a document without a rendered QR fails its own purpose.** We have had the TLV payload (`packages/zatca-tlv`) and the crypto (`einvoice/crypto/qr.ts`) for months and never the image — the artifact half of a compliance feature, absent because nothing consumed it |
| An sRGB ICC profile | Required by ISO 19005-3 6.2.4.3; see the licensing note above |

**Also missing today, found while scoping this:** nothing in the codebase
renders the QR as an IMAGE. `packages/zatca-tlv` produces the base64 TLV
payload and `einvoice/crypto/qr.ts` builds it, but no QR image library exists in
either app. The artifact needs one, and it is a v1 dependency rather than a
detail — a simplified invoice's QR exists to be *presented*.

---

## 5. What is NOT decided here
- The PDF generation library and whether it runs in-process or as a job.
- Where the artifact is stored and whether it is archived (`ArchiveStore` has
  no `delete` by design — §4).
- Sending (B1's mail provider is a deployment-time item).
