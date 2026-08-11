# A1 — Document capture (SPEC)

**Status: specced, not built. Present for approval before building.**

The first half of the automation wedge — *"I stopped doing data entry"* — and the
piece nothing external gates. See
[automation spec](./feature-spec-automation.md) for where it sits.

---

## 1. What this milestone actually is

**It is not "build OCR".** Document capture is roughly 80% built and runs today,
client-side. A1 adds the moat, closes an audit gap, and puts the existing work
under test.

```
 TODAY (works)                                    A1 ADDS
 ─────────────────────────────────────────────    ──────────────────────────────
 ReceiptScanner.tsx                               ① QR decode path (PRIMARY)
   Tesseract.js (WASM) in the browser                 read before OCR runs
   drag-drop JPEG/PNG/WEBP/PDF-page
        │                                         ② Persistence + provenance
        ▼                                             document retained,
 receiptParser.ts                                     per-field source recorded,
   Arabic numerals ٠-٩, Arabic decimal                bill ↔ image traceable
   separator, KSA dates, bilingual RTL
        │                                         ③ receiptParser under a
        ▼                                             REAL runner, in CI
 sessionStorage  ← lost on refresh
        │
        ▼
 ScanReview.tsx → POST /bills/:id/post
   (supplier match, JE preview, edit-before-post)
```

Three deliverables, in this order. ① is the value, ② is the correctness, ③ is
what makes ① and ② measurable.

---

## 2. ① The QR path — decode before OCR

The moat ([automation spec](./feature-spec-automation.md) §0): for a
ZATCA-compliant supplier the invoice carries **seller name, seller VAT number,
timestamp, total including VAT, total VAT** as structured TLV, and Phase 2 adds a
**cryptographic signature**.

### Flow

```
image
  │
  ├─ locate + read QR ────────────────► TLV decode ──► 5 fields, EXACT, provenance="qr"
  │      (new: QR reader lib)                │
  │                                          └─ Phase 2? verify signature
  │                                                 └─ ✅ "verified genuine"
  │                                                 └─ ❌ 🔴 warn loudly (§2.3)
  └─ no QR / unreadable ─────────────► Tesseract (existing) ──► provenance="ocr"
```

**Decode runs first and OCR is skipped entirely when it succeeds** — faster,
exact, and no WASM download.

### 2.1 What has to be built

| Piece | Notes |
| --- | --- |
| QR **reader** (image → base64 payload) | Not present. `jsQR` or `zxing-js`. Runs in the browser, same as Tesseract. |
| TLV **decoder** (payload → fields) | Logic exists in `crypto/qr.ts` but **server-side only**. Must be usable from the browser. |
| Signature **verification** (Phase 2) | Tags 7–9 carry the signature, public key and CA signature. Verification is real crypto, not parsing. |

**🔴 The TLV decoder must be SHARED, not reimplemented.** It is the single most
carefully-verified piece of code in this repository — thirteen documented
divergences, corrected twice from two wrong sources, and finally settled against
live ZATCA responses. A second browser-side implementation would be a second
place for those thirteen divergences to be got wrong, and it would drift silently
because only one of the two is covered by the ZATCA tests.

Extract the pure TLV encode/decode into a workspace package both sides import.
It has no Node dependencies — it is byte manipulation. **This is the one
structural change in A1** and it is worth doing properly.

### 2.2 Where verification happens

**Reading** the QR is client-side. **Verifying the Phase 2 signature is
server-side**, because a client-side "verified" badge is worth nothing — it can
be faked by the client, and the claim being made is about money.

So: the browser decodes and sends the payload with the document; the server
verifies and records the verdict. The **server's** verdict is what is stored and
displayed.

### 2.3 🔴 What a failed signature means, and why it must be loud

If a supplier invoice carries a Phase 2 QR whose signature does not verify, the
document is **not what it claims to be** — and the customer is about to claim an
input-VAT deduction against it. ZATCA will not accept that deduction.

This must be **prominent and blocking-by-default in `ScanReview`**, not a quiet
flag among the field warnings. It is the one case in this milestone where the
system knows something the user cannot possibly know by looking, and where being
wrong costs them money rather than time.

The user may still proceed — we do not know their supplier relationship — but the
override must be deliberate and recorded.

### 2.4 Open question — Q1

**What proportion of supplier documents carry a readable ZATCA QR today?**
Decides how much the OCR path still matters. A rough split is enough. Note it
only improves: Wave 25's 1 Feb 2027 deadline pulls effectively every
VAT-registered Saudi supplier in.

---

## 3. ② Persistence and provenance — an audit gap, not a UX one

Today the handoff is `sessionStorage`. **Refresh the page and the extraction is
gone.** No document image is retained, so a posted bill cannot be traced to the
picture it came from, and nothing records whether a figure was decoded, read by
OCR, or typed by a human.

That last part is the real gap. When a VAT figure is questioned — by the owner,
their accountant, or ZATCA — **"where did this number come from?" must be
answerable.** Today it is not.

### To build

1. **`POST /documents/capture`** — accepts the image plus the client-side
   extraction. Stores the document, verifies any QR signature, persists the
   extraction, returns a `captureId`.
2. **Store the document via `ArchiveStore`.** Already built, already swappable,
   already append-only, already deployment-agnostic on region — the M12.8 seam
   was designed for exactly this reuse. **Do not add a second storage mechanism.**
3. **`captured_documents`** — tenant-scoped, RLS, one row per capture: storage
   path, sha256, source (`qr` | `ocr` | `manual`), **per-field provenance**, the
   signature verdict, and the resulting `bill_id` once posted.
4. **`ScanReview` loads from `captureId`**, not `sessionStorage`. A refresh
   resumes; a half-finished capture can be returned to.
5. **Audit** the capture and the posting, through the existing `auditService`.
6. **Link the bill to its source document**, and show it on the bill.

### 3.1 ✅ Retention — inbound is retained to the same standard (conservative default)

A supplier invoice is a **purchase** record supporting an input-VAT deduction,
and ZATCA's retention obligations (6 years, 11 for some cases) are about the
taxpayer's records generally, not only the invoices they issue.

M12.8 built retention for **outbound** documents. **Decision: captured inbound
documents are retained to the same standard, with `retain_until` set.**

🔴 **This is a CONSERVATIVE DEFAULT, not a settled reading of the obligation.**
The asymmetry decides it: storage is capable either way, so setting `retain_until`
costs almost nothing — while **not** setting it and being wrong means the evidence
supporting a deduction is gone at exactly the moment it is asked for. Recorded in
the pre-production queue as a question for whoever handles tax advice; if the
answer comes back narrower, shortening a retention window is easy and lengthening
one retroactively is impossible.

---

## 4. ③ Put `receiptParser` under a real runner — inside A1

`receiptParser.test.ts` is 352 lines with ~60 assertions of careful Arabic
parsing work — and **nothing runs it.** It is a hand-rolled script
(`npx tsx receiptParser.test.ts`, its own `expect()`, `process.exit(1)`). There
is no web test runner and CI runs API tests only.

This is fixed **inside A1**, not noted: the bake-off in §5 measures this parser,
and a measurement of something that can regress silently proves nothing.

### 🔴 The flagged risk, answered: NO, it is not bigger than it sounds

The concern would be that a web test runner drags in jsdom, `@testing-library`,
component-testing conventions and a CI job — a milestone of its own. **It does
not, provided it is scoped to pure functions.** Checked:

- **`receiptParser.ts` has ZERO imports and touches no DOM.** It is
  `string → object`. It needs `environment: "node"` — **no jsdom, no
  `@testing-library`, no React test setup.**
- **Vitest 4.1.10 is already the monorepo standard** (`apps/api`,
  `packages/db`). Same version, same conventions, no new tooling decision.
- The work is: add `vitest` to `apps/web`, a ~10-line config, a `test` script,
  convert the script's `expect(label, got, expected)` calls to `it()` +
  `expect().toEqual()`, and extend the existing CI test job.

**The trap to avoid is scope creep into component testing.** Testing
`ScanReview.tsx` or `ReceiptScanner.tsx` *would* need jsdom and
`@testing-library/react`, and that **is** a bigger change. **A1 does not do
that.** If component tests are wanted later they are a separate decision, taken
on their own merits.

**Additionally:** add tests for the **QR decode path** in the shared package —
pure byte manipulation, trivially testable, and it is the moat.

---

## 5. The OCR bake-off — deferred purchase, measurable question

**Buy nothing yet.** Tesseract.js already ships, costs nothing, and sends
nothing anywhere.

**The question is "is Tesseract good enough on real Saudi receipts?"** — not
"which vendor?". Run it on **30–50 real documents** customers would actually
submit, scoring field-level accuracy, with Tesseract as the incumbent and Google
Document AI and Azure Document Intelligence as contenders only if it fails.

**The decision rule, agreed in advance so the result is not argued after:**

| Outcome | Action |
| --- | --- |
| Tesseract adequate | **Buy nothing.** Likely for clean printed tax invoices — which is what a VAT-registered supplier issues. |
| Adequate on invoices, poor on thermal/handwritten receipts | Tesseract for invoices, paid provider for the tail. Smallest bill. |
| Inadequate broadly | Then buy — with a baseline to beat. |

**Run the bake-off AFTER ① ships.** The QR path removes the majority case from
OCR entirely, so measuring OCR first would measure the wrong population.

⚠️ Both paid providers send customer documents outside the Kingdom, against an
open residency question. Tesseract and the QR path send nothing anywhere.

---

## 6. Firms: what A1 must not foreclose

Per Q2 = **SME first, firms later**
([structure decision](./hub-structure-decision.md) §3), A1 builds the
one-document-at-a-time SME flow — but must not design bulk out:

- **Extraction is a function of a DOCUMENT, not of a request.** `POST /documents/capture`
  handles one; the pipeline behind it takes a document and returns an
  extraction. Fifty is then a loop, not a rewrite.
- **`captured_documents` carries its own `company_id`**, resolved from the
  request tenant — never "the org's first company" (the M12.1a bug, twice).
- **No screen assumes a single company.**

Not built: bulk upload, email-in, WhatsApp ingestion. **Deferred, not excluded.**

---

## 7. Build order

1. **Shared TLV package** — extract from `crypto/qr.ts`, with tests. Nothing
   depends on it yet.
2. **Web test runner + `receiptParser` converted** — the guard, before anything
   it protects changes.
3. **QR reader in `ReceiptScanner`**, decode-before-OCR. Value ships here.
4. **`POST /documents/capture` + `captured_documents` + `ArchiveStore`**,
   server-side signature verification.
5. **`ScanReview` loads from `captureId`**; signature warning surfaced.
6. **Bake-off** on real documents (§5).

Steps 1–2 are groundwork with no user-visible change; step 3 is where the wedge
becomes visible.

---

## 8. Open questions

| # | Question | Why it matters |
| --- | --- | --- |
| **Q1** | What share of supplier documents carry a readable ZATCA QR **today**? | Sizes the OCR path. Rough split is enough. |
| **Q2** | ✅ **ANSWERED — PHONE CAMERA.** | Not close. The wedge is "stop typing", and the moment that delivers it is photographing a receipt **at the till**. File upload presupposes someone already got the receipt onto a computer — which is the friction being sold away. **Cheaper is not the criterion when what is being cut is the reason people switch.** See §9. |
| **Q3** | On a **failed signature**, block or warn? | §2.3. Proposed: warn prominently, allow a recorded override. |
| **Q4** | ✅ **ANSWERED — RETAIN inbound to the same standard, set `retain_until`.** | Conservative default, **not** a settled reading of the obligation. A supplier invoice is the evidence for an input-VAT deduction; if ZATCA queries it, the document is what answers. Storage is capable either way, and **not setting it and being wrong means the evidence is gone.** Flagged in the pre-production queue for whoever handles tax advice. |
| **Q5** | Should a correction **teach** the system (remember this supplier's layout)? | Where automation starts becoming the AI moat. **Not in A1** — but if yes, provenance must be captured now, which §3 does anyway. |


---

## 9. ✅ Q2 ANSWERED — phone camera, and what follows

**The capture surface is the phone camera**, not a file picker. The wedge is
delivered at the till, not at a desk: a file upload presupposes the receipt is
already on a computer, which is the friction being sold away.

**What this changes:**

- **Capture must work on a phone browser.** `<input type="file" accept="image/*"
  capture="environment">` opens the camera directly on iOS and Android — cheap,
  no native app, no new dependency. File selection remains available as a
  secondary path (a PDF emailed by a supplier is still a real case).
- **`ScanReview` must be usable one-handed on a phone.** It was built as a
  desktop review screen. This is the one place A1 touches layout, and it is
  load-bearing: a review step that is painful on a phone undoes the capture step
  that made the phone worth using.
- **The QR path gets better, not worse, on a phone.** A camera frame is exactly
  what a QR reader wants, and decode succeeds or fails immediately — so the user
  learns instantly whether this is the exact path or the fuzzy one.
- **Tesseract in a phone browser is the honest risk.** WASM OCR on a mid-range
  Android over a photographed (not scanned) receipt is slower and less accurate
  than on a desktop scan. **This raises the stakes of the §5 bake-off** and it
  must be run on **phone-captured photographs**, not clean desktop scans, or it
  measures the wrong thing.

**Explicitly NOT in scope:** a native mobile app. The camera is reachable from
the browser; a native app is a separate product decision with its own
distribution, review and release cost.
