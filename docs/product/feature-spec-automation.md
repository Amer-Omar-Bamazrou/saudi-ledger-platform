# Automation — the wedge (SPEC)

**Status: specced, not built. Contains provider decisions with recurring costs
that require owner approval before they are incurred (§5).**

The pitch is **"I stopped doing data entry."** That is what a Saudi SME owner
feels daily and will pay to remove. Automation has **no navigation entry** — it
appears inside the pages where the work happens
([structure decision](./hub-structure-decision.md) §2).

---

## 1. What the SME does today, and what replaces it

| Today | After |
| --- | --- |
| Keeps a shoebox/WhatsApp folder of supplier invoices and receipts, types them into Bills at month end | Photographs one, confirms what the system read, it posts |
| Downloads a bank CSV, pastes it into `/upload`, categorises each row by hand | Bank connects once; transactions arrive categorised, they confirm the unclear ones |
| Recreates the same rent/retainer invoice every month by copying last month's | Sets it once; it issues on schedule |

Three workstreams, in the order they should be built. The order is set by
**external dependency, not by value** — the same principle that split M12.

---

## 2. A1 — Document capture (build first: nothing external gates it)

### 🔴 The key insight: for Saudi supplier invoices, don't OCR — read the QR

Every ZATCA-compliant invoice carries a QR code containing, as structured TLV
data: **seller name, seller VAT number, timestamp, total including VAT, and total
VAT**. Phase 2 adds the cryptographic signature. By Wave 25's **1 Feb 2027**
deadline that is effectively every VAT-registered Saudi business — i.e. your
customers' suppliers.

**This platform already has the decoder.** `crypto/qr.ts` builds these tags;
`tests/company-zatca-identity.test.ts` decodes a real one (tag 1 = name,
tag 2 = VAT). The work is reading rather than writing.

So the capture path is:

```
photo/PDF
   │
   ├─ QR present and decodable?  ──yes──►  TLV decode          → 5 fields, exact, FREE
   │                                        + Phase 2: verify signature
   │                                          → "this invoice is genuine"
   └─ no ──────────────────────────────►  OCR fallback         → ~$0.01/page, fuzzy
                                            (foreign, handwritten,
                                             non-compliant vendors)
```

**Why this matters beyond cost:**

- **Accuracy stops being the risk.** A decoded QR is exact. OCR accuracy on
  Arabic receipts is the single biggest delivery risk in this milestone, and this
  removes it for the majority case.
- **It does something OCR cannot at any price: proves the invoice is real.**
  Verifying the Phase 2 signature protects the customer's **input-VAT deduction**
  — ZATCA will not accept a deduction against a fake invoice. "We check your
  supplier invoices are genuine" is a claim no OCR vendor can make.
- **Competitors cannot copy it.** Xero and QuickBooks have no reason to build
  ZATCA TLV decoding. This is the Saudi-specific advantage of building here.

**Open question for the owner (§7 Q1):** how common are non-compliant supplier
receipts in practice today — small cash purchases, restaurants, foreign
suppliers? That ratio decides how much the OCR fallback matters and therefore how
much of §5's budget is real.

### The review step already exists

`apps/web/src/pages/ScanReview.tsx` is a complete, routed review UI: raw
extraction beside validated output, field-level flags, all fields editable before
anything touches the database, supplier auto-match by VAT number (exact) or name
(fuzzy), a proposed journal entry with editable debit account, and posting
through **`POST /bills/:id/post` — the same path a hand-entered bill uses.**

**Someone built the hard half and never built the extraction that feeds it.**
There is no OCR or scan endpoint anywhere in the API. A1 is largely: build the
producer for a consumer that is already waiting.

It is also exactly the shape the AI moat needs later
([structure decision](./hub-structure-decision.md) §4) — propose, show your
working, let a human commit. Generalise it; do not reinvent it.

### To build

1. `POST /documents/scan` — accepts an image or PDF, returns an extraction with
   per-field confidence and provenance (`qr` | `ocr` | `manual`).
2. **QR path**: decode TLV, verify the Phase 2 signature where present, map to the
   fields `ScanReview` expects. Reuses `crypto/qr.ts`.
3. **OCR path**: a provider behind an `Extractor` interface — provider chosen at
   deployment, never compiled in (the `KeyWrapper` / `ArchiveStore` hedge).
4. Wire `ScanReview` to real data (it currently has no producer).
5. Storage for the source document, so a bill links to the image it came from.
   **Reuse `ArchiveStore`** — swappable, already built, already append-only.
6. **Audit**: extraction provenance recorded per field. When a figure is later
   disputed, "where did this number come from" must be answerable.

### Explicitly out of scope

Bulk/batch intake, an email-in address, WhatsApp ingestion. All are firm-shaped
or volume-shaped; the SME photographs one document at a time.

---

## 3. A2 — Bank connectivity (gated by a regulated third party)

### 🔴 This is a licensing dependency before it is a cost

Saudi open banking left SAMA's sandbox in **March 2026** and is now a formal
licensing regime. Two routes exist and only one is viable:

| Route | Reality |
| --- | --- |
| **Own AISP licence** | **SAR 1,000,000 minimum capital**, ~6-month process. A corporate undertaking, not a line item. **Rejected.** |
| **Consume a SAMA-licensed provider** | Licensed today: **Lean Technologies** (first, Mar 2026), **Malaa** (Jul 2026), **Tamawal** (aggregation). **This is the route.** |

**What that means, stated plainly:** bank connectivity becomes a dependency on a
regulated third party whose pricing, bank coverage and uptime you do not control.
It is the same shape as the ZATCA dependency — and it is why **A1 ships before
A2**. Nothing external gates document capture; a licensed provider gates this.

**None of them publish pricing.** It is a sales conversation. §5 lists what to
ask so the answer is comparable across vendors.

### To build

1. `BankFeed` interface — `listInstitutions`, `beginConnection`, `fetchAccounts`,
   `fetchTransactions`, `refresh`. Provider behind it, chosen at deployment.
2. Consent lifecycle. **SAMA consent is time-bounded and must be re-granted**;
   an expired consent that silently stops syncing is the same quiet-neglect
   failure as the ZATCA outbox. Treat expiry as an alarm, not a status field.
3. Ingest into `transactions` — the existing operational feed.
4. **Deduplication against manual entry.** A user who pasted a CSV and then
   connects the bank must not get every transaction twice. Match on
   amount + date + reference within a window; surface probable duplicates for
   confirmation rather than merging silently.
5. Categorisation on arrival, reusing the existing rules-based `categorizer`.

### 🔴 A pre-existing consequence that gets much worse here

`transactions` is **not approval-gated** (the documented M10 limitation) and it
feeds the **dashboard, VAT return, Zakat base, cash flow and budget actuals**.
Today a human types those rows, so volume is small and errors are self-inflicted.

**A bank feed makes an external system the author of rows that move tax figures**,
at a volume no one reviews line by line. That is a materially different risk, and
it should be decided before A2 is built, not discovered after.

**Owner question (§7 Q3).** Options, with how others handle it: QuickBooks and
Xero both land bank data in a **holding area** ("For Review" / bank statement
lines) that is explicitly *not* the ledger until a human accepts it — the user
sees the transaction immediately but nothing hits the books unattended. That is
the industry default and it exists precisely because feeds are noisy.

---

## 4. A3 — Recurring documents (no provider, no model, no dependency)

Rent, retainers, subscriptions. **The cheapest of the three and the only one with
zero external dependency** — worth considering first if A1's provider decision
stalls.

- A recurring rule is a property of an invoice or bill: *"repeat monthly on the
  1st until stopped."* Created from the document, on the document's page.
- Generates a **draft**, never an issued document. The M10 approval workflow
  already exists and this must not bypass it: an invoice that issues itself
  consumes an ICV and a ZATCA chain position unattended.
- Runs on the **M12.8 job scheduler**, which is built. A fourth job.
- The rules list lives in **Settings** — a list, not a hub.
- Skips a locked period rather than failing (M13 made period locks
  company-scoped, so this behaves correctly in a multi-company org).

---

## 5. 🔴 Provider decisions and recurring costs — APPROVAL REQUIRED

Nothing here is committed. These are the bills, named before they are incurred.

### Decision 1 — OCR fallback provider

Only relevant for documents **without** a readable ZATCA QR (§2). Prices are
public and current as of August 2026.

| Provider | Invoice/receipt model | Plain OCR | Arabic | Verdict |
| --- | --- | --- | --- | --- |
| **Google Document AI** | ~$10 / 1,000 pages | ~$1.50 / 1,000 | 200+ languages | **Strongest on language breadth** |
| **Azure Document Intelligence** | ~$10 / 1,000 pages | ~$1.50 / 1,000 | 100+ languages | Close second |
| **AWS Textract** | ~$15–50 / 1,000 pages | ~$1.50 / 1,000 | **6 printed languages** | 🔴 **Disqualified** — Arabic not realistically covered |

**What it actually costs.** At 200 documents/month per tenant with **70% carrying
a readable QR**, the OCR fallback is ~60 pages/month → **under $1 per tenant per
month.** Even at 100% OCR it is ~$2. **This is not a meaningful cost.** The
decision is about *accuracy and data residency*, not price.

🔴 **The real risk is Arabic accuracy on real Saudi receipts, and no published
benchmark will settle it.** Language *support* is not the same as being good at
thermal-printed Arabic receipts. **Do not pick from this table.** Run a bake-off:
30–50 real documents your customers would actually submit, both providers, score
field-level accuracy. That is a day of work and it de-risks the wedge.

⚠️ **Residency interaction:** both send customer documents outside the Kingdom.
That collides with the open KSA residency question. Note the QR path never leaves
your infrastructure — another reason it is the primary path.

### Decision 2 — Bank aggregation provider

**No public pricing.** Candidates: **Lean Technologies**, **Malaa**, **Tamawal**.

Ask each, so answers are comparable:

1. **Pricing model** — per connected account per month, per API call, per tenant,
   or platform fee? (Per-account-per-month is the common shape and the one that
   scales with your revenue rather than against it.)
2. **Bank coverage** — specifically Al Rajhi, SNB, Riyad Bank, SAB, Alinma. A
   provider missing Al Rajhi is unusable for an SME product.
3. **What our obligations are** as a consumer of their licence — are we a
   sub-participant, do we need SAMA registration, what do we carry
   contractually?
4. **Consent lifecycle** — duration, re-consent UX, what happens on expiry.
5. **Historical depth** on first connect — 12 months matters for a new customer's
   first close; 30 days does not.
6. **Sandbox** — can we build and test without a signed commercial agreement?

**Expect this to be the largest recurring line item in the product**, and the one
that scales directly with customer count. Get numbers before A2 is scheduled.

### Decision 3 — AI

**None. Parked**, per the [structure decision](./hub-structure-decision.md) §4.
Nothing in this spec requires a model: QR decoding is deterministic, OCR is a
document API, categorisation reuses the existing rules engine. **Automation as
specced here incurs no AI cost at all**, which is the point of building it first.

---

## 6. Sequencing

| | Ships | Gate | Recurring cost |
| --- | --- | --- | --- |
| **A1 Document capture** | First | None — provider choice is ours | <$1/tenant/month |
| **A3 Recurring documents** | With or before A1 | None at all | Zero |
| **A2 Bank connectivity** | Last | 🔴 A licensed third party | Unknown — get numbers first |

A1 first because it is the visible "stop typing" moment and nothing external
gates it. A3 is nearly free and can fill any wait. A2 last because a regulated
dependency should not block the wedge — the same reasoning that split M12.

---

## 7. Open questions for the owner

1. **How many supplier receipts lack a ZATCA QR today?** Decides whether OCR is a
   fallback or a main path, and therefore how much §5 Decision 1 matters. A rough
   split is enough.
2. **Photograph, or upload a file?** Phone camera capture is the "stop typing"
   moment but implies a mobile-friendly capture surface; file upload is cheaper
   and less magical. This is the difference between a feature and the wedge.
3. **🔴 Should bank-feed transactions land in the ledger, or in a holding area?**
   Bank data drives VAT, Zakat and cash flow, and `transactions` is not
   approval-gated. QuickBooks and Xero both use a holding area that is explicitly
   not the books until accepted. Load-bearing, and cheaper to decide now.
4. **How much history on first bank connect?** Drives cost and the new customer's
   first experience.
5. **What does the SME do when extraction is wrong?** `ScanReview` lets them fix
   it — should a correction *teach* the system (remember this supplier's layout)?
   That is where automation starts becoming the AI moat.
