# The receipt vision benchmark — how to feed it

**Status (2026-08-21): harness BUILT, corpus EMPTY.** The owner is
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

## Running

```bash
AI_PROVIDER=groq GROQ_API_KEY=gsk_... \
  pnpm --filter @workspace/api-server run benchmark:vision
# compare models:  ... run benchmark:vision --models model-a,model-b
```

Scores per field (vendor / date / total / vat) and per language, with the
Arabic-gate verdict stated explicitly, plus measured token consumption from
the `ai_usage` meter. Reports land in `docs/ai/benchmarks/`.
