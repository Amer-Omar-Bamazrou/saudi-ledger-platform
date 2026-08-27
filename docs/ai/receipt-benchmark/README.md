# The receipt vision benchmark — how to feed it

**Status (2026-08-27): harness BUILT, corpus SEEDED (3 of a target 50–150).**
🔴 One correction found on review of the first batch: `receipt-001`'s date,
total and VAT were all labelled with values the paper does not print (the
vendor was right). Corrected against the photograph. **A wrong ground-truth row
does not fail loudly — it silently scores a correct model as wrong**, which is
the measuring-instrument defect this project has now hit three times. Worth one
re-read of each row against its photo before the batch grows.

**Previously (2026-08-21): harness BUILT, corpus EMPTY.** The owner is
photographing the receipts (his own purchases — no tenant's documents, which
is what keeps the corpus legal on the Groq free tier under §12b). The harness
runs today and reports **NOT RUN — no fixtures** loudly until images exist;
it will never silently pass on an empty corpus.

## What to photograph

Aim for **50–150 receipts**, deliberately varied — the benchmark's value is
exactly the variety a synthetic generator can't produce:

- **Thermal POS receipts** (supermarket, fuel, restaurant) — including faded ones
- **Printed tax invoices** with a ZATCA QR code (these do double duty: real
  third-party TLV payloads for `qr-fixture-collection.md`)
- **Handwritten** or part-handwritten receipts
- **Bad photos on purpose**: crumpled, skewed, low light, glare — the phone
  reality the capture feature actually faces
- A mix of **Arabic-only, English-only, and mixed** layouts

## Where files go

```
docs/ai/receipt-benchmark/
  images/           ← receipt-001.jpg, receipt-002.png … (jpg/png/webp)
  labels.csv        ← the ground truth, one row per image
```

`images/` contents are **gitignored** (photos of real receipts stay local);
`labels.csv` is committed. Keep filenames stable — the label row is the link.

## labels.csv format

```csv
file,vendor,date,total,vat,language,kind
receipt-001.jpg,Panda,2026-07-14,86.25,11.25,ar,thermal
receipt-002.jpg,Aldrees,2026-07-20,150.00,19.57,mixed,thermal
receipt-003.png,مؤسسة النخيل للتجارة,2026-08-02,1150.00,150.00,ar,tax_invoice
```

- `date` — `YYYY-MM-DD` as printed on the receipt
- `total` — the gross total as printed, 2dp
- `vat` — the VAT amount as printed, 2dp; empty if not shown
- `language` — `ar` | `en` | `mixed` (drives the separate §2a scoring)
- `kind` — `thermal` | `tax_invoice` | `handwritten` | `other` (free text ok)

**Label what the paper SAYS, not what is true.** If the receipt's printed
total is wrong, the ground truth is the wrong printed number — the model is
being measured on reading, not on auditing.

🔴 **Which cuts both ways: the label must be READ OFF the paper, not computed.**
The first batch's `receipt-001` carried a date, total and VAT that were
internally consistent at 15% VAT and matched nothing on the receipt. A label
derived by arithmetic looks exactly like a label read from paper, and it fails
in the worst direction — the harness reports a correct model as wrong, with no
error anywhere. Transcribe each field from the image, then check the arithmetic
only as a *smell test*, never as a source.

🔴 **The schema captures four fields — so a document's other anomalies are not
tested by it.** `receipt-003` carries a line with quantity 0 that still bears a
price and VAT, and line sums that disagree with the printed totals by a halala
(43.30 + 47.30 = 90.60 against a printed 90.61; 6.50 + 7.10 = 13.60 against a
printed 13.59). Labelling the printed totals is right, and those anomalies are
genuinely valuable — but they are invisible to a scorer that only reads
vendor/date/total/vat. If they are to be *tested* rather than merely present,
that needs a `notes` column or its own fixture list. Recorded so the value is
not assumed to be captured.

## Running

```bash
AI_PROVIDER=groq GROQ_API_KEY=gsk_... \
  pnpm --filter @workspace/api-server run benchmark:vision
# compare models:  ... run benchmark:vision --models model-a,model-b
```

Scores per field (vendor / date / total / vat) and per language, with the
Arabic-gate verdict stated explicitly, plus measured token consumption from
the `ai_usage` meter. Reports land in `docs/ai/benchmarks/`.
