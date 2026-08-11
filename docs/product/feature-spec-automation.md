# Automation — the wedge (SPEC)

**Status: specced, not built. Contains provider decisions with recurring costs
that require owner approval before they are incurred (§5).**

The pitch is **"I stopped doing data entry."** That is what a Saudi SME owner
feels daily and will pay to remove. Automation has **no navigation entry** — it
appears inside the pages where the work happens
([structure decision](./hub-structure-decision.md) §2).

---

## 0. 🔴 THE MOAT: decode, don't OCR

**Read this first. It is the most valuable thing in this document and it changes
what gets built.**

Every ZATCA-compliant invoice carries a QR code holding, as structured TLV data:
**seller name, seller VAT number, timestamp, total including VAT, total VAT.**
Phase 2 adds the **cryptographic signature**.

So for a compliant Saudi supplier, capturing a purchase invoice is a **decode,
not an OCR call**:

|  | OCR | ZATCA QR decode |
| --- | --- | --- |
| Accuracy | Probabilistic; Arabic receipts are the hard case | **Exact** |
| Cost | ~$10 / 1,000 pages | **Zero** |
| Data leaves the country | Yes | **No** |
| Proves the invoice is genuine | **Impossible** | **Yes** (Phase 2 signature) |

**Three things make this a moat rather than an optimisation:**

1. **The decoder already exists here.** `crypto/qr.ts` builds these tags and
   `tests/company-zatca-identity.test.ts` decodes a real one. This falls out of
   work already done for M12 — it is not new capability, it is reuse.
2. **It does something OCR cannot at any price: proves the invoice is real.**
   ZATCA will not accept an input-VAT deduction against a fake invoice.
   Verifying the Phase 2 signature protects the customer's **money**, not their
   time. No OCR vendor can offer that.
3. **Foreign competitors have no reason to build it.** Xero and QuickBooks will
   never implement ZATCA TLV decoding, because it is worthless outside Saudi
   Arabia. This is the advantage of building here rather than localising
   something built elsewhere.

And the coverage is not niche: by **Wave 25's 1 Feb 2027 deadline** the QR is on
effectively every invoice issued by every VAT-registered Saudi business — which
is to say, on your customers' supplier invoices.

**Consequence for the build: QR decode is the PRIMARY path and ships first. OCR
is the fallback**, for foreign, handwritten and non-compliant documents. That
inverts the usual cost model and removes the biggest delivery risk in this
milestone (Arabic OCR accuracy) from the majority case.

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

### The capture path

Per §0, decode is primary and OCR is the fallback:

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

**Open question for the owner (§7 Q1):** how common are non-compliant supplier
receipts in practice today — small cash purchases, restaurants, foreign
suppliers? That ratio decides how much the OCR fallback matters and therefore how
much of §5's budget is real.

### 🔴 CORRECTION: OCR already exists, client-side. It is ~80% built.

An earlier reading of this codebase reported "there is no OCR endpoint at all"
and concluded the extraction feeding `ScanReview` did not exist. **The first half
was true and the conclusion was wrong** — inferring the absence of *extraction*
from the absence of an *endpoint*. The pipeline is client-side and it runs today:

```
ReceiptScanner.tsx      drag-drop JPEG/PNG/WEBP/PDF-page
   │                    Tesseract.js (WASM) IN THE BROWSER
   ▼
receiptParser.ts        Arabic numerals (٠-٩), Arabic decimal separator,
   │                    KSA date formats, bilingual RTL column ordering
   ▼
scanReviewStore.ts      sessionStorage handoff
   ▼
ScanReview.tsx          review → supplier match → JE preview → POST /bills/:id/post
```

**What this changes about §5 Decision 1 (the OCR provider):**

- **There is a working, zero-cost baseline.** Tesseract.js is free and runs in
  the browser. There is no per-page bill and **no cloud provider to buy**.
- **The residency concern disappears for this path.** Nothing leaves the
  browser — not the country, not even your servers.
- **The purchase decision becomes deferrable and, more importantly,
  MEASURABLE.** The bake-off is no longer "which vendor should we buy?" but
  **"is the thing we already have good enough on real Saudi receipts?"** Only if
  the answer is no does a paid provider become a question — and then with a
  baseline to beat rather than a vendor table to guess from.

**What is genuinely missing** is narrower than "OCR":

1. **The QR decode path — the moat (§0). Not built at all.** No QR reader in the
   web dependencies; the TLV decoder exists only server-side in `crypto/qr.ts`.
2. **Nothing is persisted.** The handoff is `sessionStorage`: refresh the page
   and the extraction is gone. No document image is retained, so a posted bill
   cannot be traced back to the picture it came from, and there is no extraction
   provenance or audit.
3. **`receiptParser.test.ts` never runs.** It is 352 lines with ~60 assertions —
   real, careful work on Arabic parsing — but it is a **hand-rolled script**
   (`npx tsx receiptParser.test.ts`, its own `expect()`, `process.exit(1)`), not
   a Vitest suite. There is no web test runner and CI runs API tests only. The
   parser at the centre of the wedge is **unguarded**.

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

### Deferred, NOT excluded

Bulk/batch intake, an email-in address, WhatsApp ingestion. The SME photographs
one document at a time, so none of these is built now.

🔴 But the customer decision is **SME first, firms later** — so these must not be
designed *out*. Concretely: `POST /documents/scan` handles one document, but the
extraction pipeline behind it must be a **function of a document**, not a
function of a request, so processing fifty is a loop rather than a rewrite. That
costs nothing today and is the difference between adding bulk intake in a week
and re-architecting for it.

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

### ✅ DECIDED: imported rows land in a HOLDING AREA, not the ledger

Settled by the owner, for the reason above: a feed changes both the volume and
the **authorship** of rows that move tax figures. Imported transactions land
somewhere explicitly **not the books** until a human accepts them. The user sees
them immediately; nothing reaches VAT, Zakat or cash flow unattended. Same reason
QuickBooks ("For Review") and Xero (bank statement lines) both do it — feeds are
noisy, and it is not an accident that the two largest products in this category
converged on the same answer.

🔴 **"Holding area" is itself a design question, owned by the A2 spec.** It must
be designed **against the existing M10 approval workflow, not as a parallel
one.** The platform already has a draft → submitted → approved engine with
adapters, audit and a worklist UI; a second, differently-shaped review queue
beside it would be two mechanisms for one idea — and the M10 engine was
deliberately built generic so entities plug in rather than fork it. Whether an
imported transaction becomes an `Approvable`, or whether the un-gated
`transactions` table finally gets the status column M10 deferred, is the actual
question. Do not answer it inside an implementation ticket.

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

### Decision 1 — OCR fallback provider — 🔴 DEFERRED, and possibly unnecessary

**Do not buy anything yet.** A working zero-cost baseline already ships in the
product: Tesseract.js in the browser (§2 correction). It costs nothing, sends
nothing anywhere, and is already wired to a parser that handles Arabic numerals
and bilingual layouts.

So the sequence is: **measure the baseline first, buy only if it fails.** The
table below stays because it is the answer *if* the baseline proves inadequate on
real Saudi receipts — not because a purchase is scheduled.

Prices are public and current as of August 2026.

| Provider | Invoice/receipt model | Plain OCR | Arabic | Verdict |
| --- | --- | --- | --- | --- |
| **Google Document AI** | ~$10 / 1,000 pages | ~$1.50 / 1,000 | 200+ languages | **Strongest on language breadth** |
| **Azure Document Intelligence** | ~$10 / 1,000 pages | ~$1.50 / 1,000 | 100+ languages | Close second |
| **AWS Textract** | ~$15–50 / 1,000 pages | ~$1.50 / 1,000 | **6 printed languages** | 🔴 **Disqualified** — Arabic not realistically covered |

**What it would cost.** At 200 documents/month per tenant with **70% carrying a
readable QR**, a paid fallback is ~60 pages/month → **under $1 per tenant per
month.** Even at 100% it is ~$2. **Price is not the decision.**

🔴 **The decision is Arabic accuracy, and the bake-off now has a baseline.** Run
it on **30–50 real documents your customers would actually submit**, scoring
field-level accuracy, with **three** contenders: Tesseract (free, local, already
built), Google, and Azure. Three outcomes:

- **Tesseract is good enough** → buy nothing. Best case, and not unlikely for
  clean printed tax invoices, which is what a VAT-registered supplier issues.
- **Tesseract fails only on receipts** (thermal, handwritten, poor light) → use
  it for invoices and a paid provider for the hard tail. Smallest bill.
- **Tesseract fails broadly** → then, and only then, buy from the table.

⚠️ **Residency:** Tesseract sends nothing anywhere; the QR path sends nothing
anywhere. **Both paid providers send customer documents outside the Kingdom**,
which collides with the open KSA residency question. That is another reason to
establish whether the local baseline suffices before committing.

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
3. ✅ **ANSWERED — holding area.** See §3. The remaining question is not
   *whether* but *how*: it must be designed against the M10 approval engine
   rather than beside it.
4. **How much history on first bank connect?** Drives cost and the new customer's
   first experience.
5. **What does the SME do when extraction is wrong?** `ScanReview` lets them fix
   it — should a correction *teach* the system (remember this supplier's layout)?
   That is where automation starts becoming the AI moat.
