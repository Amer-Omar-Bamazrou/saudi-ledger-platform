# Collecting real supplier-invoice QR fixtures (finding #9)

**Why:** every payload the TLV decoder has ever seen was encoded by our own
`tlv()`. The test suite proves our codec **round-trips our own output** — it does
not prove it can read what Qoyod, Wafeq, ClearTax or a POS terminal produce,
which is the decode path's entire job.

The format is simple and our *encoder* was validated against live ZATCA
responses, so this is unlikely to be badly wrong. The risk is in the edges
another implementation produces and ours never does: tag ordering, optional tags
present or absent, padding, whitespace, a vendor writing tag 3 in a different
timestamp shape (divergence #13's territory).

---

## What I need from you

**Six real supplier invoices or receipts, from six DIFFERENT vendors**, each
carrying a ZATCA QR code.

### Choose for variety, not tidiness

The point is coverage of *other people's implementations*, so spread across:

- **Different kinds of business** — a supermarket, a restaurant, a petrol
  station, a telecoms bill, a wholesaler, a services invoice. Different sectors
  buy different software.
- **Different print formats** — a thermal till receipt, an A4 printed invoice, a
  PDF from an email. Thermal receipts are the hardest and the most common.
- **Arabic-only, English-only, and bilingual** seller names if you can. Arabic
  names are multi-byte, and TLV length is a **byte** count — a vendor
  miscounting that is exactly the class of bug worth finding.

**Do not curate for quality.** A slightly crumpled, glare-affected thermal
receipt photographed at an angle is *more* valuable than a flat clean scan,
because that is what customers will actually submit.

### How to capture them

- **Photograph with your phone**, as a customer would. Not a scanner.
- **Include the whole QR code** with a little white space around it. Don't crop
  tight and don't zoom in on the QR alone — I need to know jsQR can *find* it in
  a full-frame photo, not just decode it once located.
- One photo per document. JPEG or PNG. No editing, no filters, no rotation
  correction.
- If a document has **no QR code at all**, send it anyway and label it — that is
  useful evidence for how large the OCR fallback population really is (spec Q1).

### How to hand them over

Put them in a folder on this machine and tell me the path — for example
`C:\Users\lenovo\qr-fixtures\`. Name each file for the vendor type rather than
the business:

```
01-supermarket.jpg
02-restaurant-thermal.jpg
03-petrol-station.jpg
04-telecoms-a4.jpg
05-wholesaler-arabic.jpg
06-services-bilingual.jpg
```

If the invoice shows which software produced it (Qoyod, Wafeq, a POS brand),
mention it — knowing *whose* implementation exposed a quirk is more useful than
knowing that one exists.

---

## 🔴 What I will and will not commit

**A ZATCA QR payload is real commercial data about a real business**: the
supplier's legal name, their VAT registration number, a timestamp, and what you
paid them. The photograph carries more still. Git history is effectively
permanent.

So — consistent with the PDPL question we just put in the pre-production queue
(**C8**), and it would be poor form to raise that concern and then commit a
folder of real invoices:

**Not committed:**
- the photographs;
- the raw payloads;
- any real seller name, VAT number or amount.

**Committed:**
- **anonymised fixtures that reproduce each structural quirk found** — same tag
  order, same presence/absence of optional tags, same timestamp format, similar
  field lengths, but synthetic names, VAT numbers and amounts. The structure is
  what the decoder is being tested against; the values are not.
- a short note per vendor recorded as "vendor A / thermal receipt / tag order
  1,2,3,4,5" — no business identified.

If a quirk genuinely cannot be reproduced without real data, I will describe it
in the test and skip the fixture rather than commit the document.

---

## What I will do with them

1. Run each photo through `readZatcaQr` end to end — does jsQR **find** the code
   in a real full-frame photograph, and does the TLV decode.
2. Record per-vendor structure: tag order, which optional tags appear, timestamp
   format, byte lengths, anything unexpected.
3. **Fix the decoder** if any real payload defeats it — that is the point of the
   exercise, and finding it here rather than at a customer is the entire value.
4. Add anonymised fixtures reproducing every quirk, so the next change cannot
   silently break a vendor that works today.
5. Report back: which vendors decoded cleanly, which needed a fix, and what
   proportion carried a QR at all — that last figure feeds spec Q1 and sizes the
   OCR fallback.

**Six is enough to be useful and small enough to do in an afternoon.** If two
different vendors both decode without incident, that is already meaningful
evidence; if one fails, that is worth more than all the passing ones.
