# Phase 13 — Expenses and expense-document evidence: decision and as-built record

**Status (2026-09-27): 13A (evidence integrity), 13C (expenses) and 13E
(regulatory text) BUILT on `feat/phase13-expenses-document-intelligence`,
with the accountant's answers X1–X5 APPLIED (§9) — held VAT now POSTS into a
holding account, blocked VAT into cost, and the return counts input VAT only
when claimed (a narrow guard, §9.4). 13B (the VAT claim ledger) and 13D (the
VAT return) NOT built — they wait on the official return layout (known-issues
P13-N1). Current state authority: [CLAUDE.md §2](../../CLAUDE.md).**

The open questions are in
[`phase-13-expenses-accountant-questions.md`](phase-13-expenses-accountant-questions.md);
the defects this phase closes are in
[`known-issues-and-audit-findings.md`](../history/known-issues-and-audit-findings.md)
(P13-D1, P13-D3, P13-N2 closed; P13-D2 narrowed; P13-N1, P13-N3 open).

## §1 The invariant

🔴 **INSUFFICIENT EVIDENCE → NO INPUT-VAT CLAIM.** Since the accountant's
answers (2026-09-27, §9) the document is NOT kept a draft: it posts, and the
evidence decides only where its VAT goes —

| Verdict | Where the VAT goes | On a VAT return |
| --- | --- | --- |
| evidenced / nothing to claim | `VAT_INPUT` | in the document's own period |
| awaiting evidence | `VAT_AWAITING_EVIDENCE` (an asset) | NOT — until the evidence entry (Dr `VAT_INPUT` / Cr holding) claims it, dated the day the evidence is held: that period's return (IR Art. 49(8), five calendar years at most) |
| not deductible (Art. 50, 0 %-recovery asset) | the cost | never as input VAT |

~~(2026-09-24) The document stays a draft until the evidence is sufficient,
because where unclaimable VAT belongs was the accountant's question.~~
Superseded by §9: that question is answered.

Held is expected to be common: a bill claimed its VAT on approval whatever the
evidence before this phase. That is the point, not a regression — and it is
why the held list is a real list (filter by reason, search, set-wide counts,
posted rows given their evidence in place, drafts opened and fixed).

## §2 The verdict — one definition

`apps/api/src/services/purchaseEvidence/vatEvidence.ts` (pure). Statuses:
`not_required` · `evidenced` · `awaiting_evidence` · `not_deductible`
(+ `not_evaluated` for rows older than Phase 13). Reasons are structured codes
(the UI words them in both languages, `apps/web/src/lib/vatEvidence.ts`).

| Rule | Source | Classification |
| --- | --- | --- |
| Deduction only while holding the tax invoice, or a correctly issued simplified invoice | IR Art. 49(7)(a), 53(11) | Saudi statutory |
| A tax invoice carries the supplier's VAT number and a sequential number | IR Art. 53(5)(b)–(c) | Saudi statutory |
| A simplified invoice: date, supplier name/address/VAT number, description, consideration, tax — no buyer details | IR Art. 53(8) | Saudi statutory |
| A simplified invoice to a business only below SAR 1,000 | IR Art. 53(1)(c) (**Arabic**; the English says "summary") | Saudi statutory |
| …measured on the document's **total** | the text does not settle before/after VAT | 🔴 **Saudi Ledger interpretation, CONSERVATIVE** — between the two readings the VAT is held, never over-claimed. An advisor question if it matters. |
| A simplified invoice carries a ZATCA QR; manual invoices are not eligible | E-Invoicing Detailed Guideline §4.2, §7.1 | ZATCA requirement |
| A simplified invoice's QR must be READ from an attached document | the QR is the only machine-checkable proof it was generated electronically | Saudi Ledger product decision |
| A full tax invoice may be ATTESTED (stated, figures entered) without a document; attaching one raises the basis | the platform cannot see paper | Saudi Ledger product decision |
| A decoded QR is compared with the bill (supplier VAT number, total, VAT); a FAILED signature holds | server-side check (A1) | Saudi Ledger product decision |
| OCR is never evidence | — | Saudi Ledger product decision |
| Art. 50 blocked expense account → `not_deductible`, VAT in the expense's cost | IR Art. 50; accountant X5 | statutory + accountant |
| The existing fixed-asset treatment (0 % recovery → VAT capitalised, none claimed) stays postable | fixed-assets pack §3 A1 | existing, preserved |
| A credit note needs no evidence (it reduces a claim) | IR Art. 40(6) | Saudi statutory |

Where it is enforced: every draft write persists it (`vatEvidenceService.refresh`
— create, update, evidence attached, a supplier's VAT number changed, a
document discarded); the approval re-decides it authoritatively on the entry
as it will post and routes the VAT by it (`inputVatTreatment`, §9); and the
database trigger `bills_vat_evidence_gate` (rewritten in migration 0106) ties
the posted `input_vat_state` to the stored verdict and admits exactly one later
change — held → claimed, with the evidence, inside the window. Only a
supplier's ADVANCE tax invoice is still refused for its evidence (422
`input_vat_evidence_insufficient`): it is a VAT-only document. 🔴 **Limit,
stated:** the trigger guards UPDATEs; a row INSERTED already posted (migration
opening items, test fixtures) never passes through approval and carries no
state, which the return reads as claimed on its own date.

## §3 The scan workflow (13A)

Capture → extraction (browser: ZATCA QR first, OCR fallback; a **PDF** is
stored and its fields typed) → review → **SAVE AS DRAFT** (`POST /bills` with
`captureId`) → the ordinary approval. The review page no longer posts, and the
client-side "Post anyway" is gone: the verdict it shows is the server's
(`POST /bills/evidence-preview`). The capture is linked to the DRAFT as its
evidence (still deletable staging — the purge job leaves a linked capture
alone) and promoted to the immutable archive when the bill posts. Deleting a
draft unlinks its staged capture; discarding a draft's document re-decides the
draft. `fieldSources` is now sent and persisted (values checked: `qr`,
`qr_derived`, `ocr`, `manual`); the reviewer's changes are stored as
`captured_documents.review_corrections` BESIDE the untouched extraction.

Files: PDF, JPEG, PNG and **WEBP**, by magic bytes, through a capture-only
allow-list (`CAPTURE_ALLOWED_MIME`) — the onboarding verification-document
path keeps its own list. The SHA-256, malware and magic-byte checks are
unchanged.

**Duplicates — WARN, never refuse** (owner decision): the same file (SHA-256),
the same supplier (or a supplier record sharing its VAT number) with the same
supplier invoice number, the same supplier/date/total. Scoped to the company
by an explicit predicate (and to the organisation by RLS); on an org-wide
connection the check returns NOTHING rather than every company's documents.

## §4 Expenses (13C)

**BILL** — the supplier's document creates a payable, paid later.
**EXPENSE** — a purchase already paid when it is recorded.

An expense is a **bill** that states `recorded_as_expense`, the bank it was
paid from and the date (both REQUIRED, never defaulted; only a plain bill).
Its **approval posts it and pays it** through `payBill` — the bill-payment
path moved unchanged out of `billsService.pay` so both callers run one
function (row lock, `billPosition`'s outstanding, the named bank, the period
lock, the dated `bill_payments` row, its entry). In ONE transaction: if the
payment cannot post (its month closed), the posting rolls back with it. The
Expenses page READS these bills (`GET /expenses`) — no second table, no second
source of truth. A draft bill can become an expense before it is posted
("reuse"). Employee reimbursement is not built (no employee party, payable or
payment model).

## §5 13E — regulatory text

The Art. 63(3) refusal now states SAR 15,000 and the discovery-period return
(P13-N2, closed, with its lesson); the stale English IR is documented in
`docs/zatca/README.md` and not replaced (P13-N3).

## §6 What was NOT built, deliberately

- **13B** the VAT claim ledger (append-only claim events). §9 records a claim
  as a state and an entry on the document, not as ledger events.
- **13D** the VAT return: its layout, numbering and boxes are untouched and
  still ours, not ZATCA's (P13-N1). The ONE change is the narrow guard (§9.4):
  input VAT counts only when claimed, in its claim period.
- Capitalised-VAT RECOVERY (§9.6).
- Employee reimbursement, petty cash, corporate cards, server-side or AI
  extraction, Art. 40(10)–(11).

## §7 Found on the way

- The demo seed passed `vatNumber` to the vendor service (the field is
  `taxNumber`), hidden by an `as never` cast, so the demo's suppliers never had
  a VAT number — fixed for vendors. 🔴 **The demo's CUSTOMERS have the same
  defect** (`customersService.create({ vatNumber })`), NOT fixed here: it
  would change how the demo issues its invoices, outside this phase.
- `tests/cross-company-isolation.test.ts`: `bills` left the company-blind list
  because the file now carries explicit company predicates — on its NEW
  queries only; its older queries still rely on RLS's company arm.
- A mutation run showed the duplicate check's company predicate was
  INVISIBLE to the first isolation test (RLS already isolated); the test now
  asserts the org-wide case, where only the predicate withholds.

## §8 Verification

Tests: `phase13-vat-evidence.test.ts` (24: the verdict, pure, and real rows),
`phase13-expenses.test.ts` (6), `e2e/phase13-evidence-expenses.spec.ts`
(clicked, EN/AR, desktop/phone). Each protection was removed in a temporary
run and its test went RED, then restored: the approval gate, the database
trigger, the expense payment at approval, the purge exclusion, the duplicate
company predicate, the SAR 1,000 rule. Existing fixtures that approve VAT
bills now state the supplier document they hold and give the supplier a VAT
number — what a real bill needs; no assertion was weakened.

## §9 The accountant's answers, applied (2026-09-27)

**Record of the answers and their verification:**
[`phase-13-expenses-accountant-questions.md`](phase-13-expenses-accountant-questions.md)
(the accountant numbered five items; §"Answers" there maps them to the three
questions asked). Owner-approved implementation: 13A + 13C only, with ONE
narrow change to the return's input-VAT source.

### 9.1 X1 — VAT awaiting evidence

- A new system account **`VAT_AWAITING_EVIDENCE`** ("Input VAT awaiting
  evidence", asset, `current` — not `quick`: it may never be recovered;
  migration 0106 seeds it for every organisation).
- A held document posts `Dr expense / Dr VAT_AWAITING_EVIDENCE / Cr AP`; the
  bill records `input_vat_state = awaiting_evidence` and the held amount
  (`input_vat_pending`).
- **The evidence entry** (`vatEvidenceService.claimHeldVat`, reached by
  `POST /bills/:id/evidence` on a posted held bill — the VAT evidence page's
  "Supply evidence"): the verdict is re-decided; when it now supports the
  claim, `Dr VAT_INPUT / Cr VAT_AWAITING_EVIDENCE` for the held amount, dated
  the evidence day (default today, never in the future). The accountant's
  wording "debit VAT payable" was checked against our chart: "VAT Payable" is
  `VAT_OUTPUT`, a liability, and debiting it would put input VAT where output
  VAT lives; the owner settled it as `Dr VAT_INPUT` (2026-09-27).
- Only EVIDENCE facts change on a posted document (the document kind, the
  supplier's number, the document itself) — never a figure.

### 9.2 X2 — the late claim

The claim period is the evidence entry's date: a later return, never a
prior-period correction. `withinClaimWindow` (and the trigger) refuse a claim
before the supply or more than five calendar years after its year (IR Art.
49(8)): a 2026 supply may be claimed through 31 Dec 2031.

### 9.3 X3 — a credit note before the claim

A supplier credit note follows the original it corrects (`inputVatTreatment`).
On HELD VAT it credits `VAT_AWAITING_EVIDENCE` (naming the original's supplier)
and reduces the original's held amount; nothing reaches `VAT_INPUT` or a
return; a note larger than what is held is refused
(`credit_note_exceeds_held_vat`). When the evidence arrives the NET is claimed,
and the notes follow the original into that period. On blocked VAT the note
reduces the cost; on claimed VAT it is the existing Art. 40(6) path.

### 9.4 The narrow return guard

`reports.repository` `billsClaimedInRange` / `billLinesClaimedInRange` /
`billPrepaymentsClaimedInRange` select the same documents as the existing
bill-date queries, by `coalesce(input_vat_claimed_on, date)` and only where
`coalesce(input_vat_state, 'claimed') = 'claimed'`. The return's purchase
rules run once over each set (`purchasesOf`): the bill-date set gives the
purchase AMOUNTS (unchanged), the claim set gives INPUT VAT. So held VAT is on
no return, blocked and capitalised VAT are never input VAT (this closes
P13-D2's remaining half), and an evidenced document is exactly where it was.
**Not changed:** the layout, the numbering, the boxes, the output side.
🔴 **Stated consequence:** a held purchase's BASE is in box 9 of its own
period while its VAT is in box 13 of the claim period — which box carries a
late claim is P13-N1's open question.

### 9.5 X4, X5

- **X4** — no change: a correctly issued simplified invoice supports a B2B
  deduction; below SAR 1,000 on the VAT-inclusive total (our conservative
  reading; whether the threshold is before or after VAT is NOT settled by any
  source read — ZATCA's Tax Invoicing guideline v3, May 2026, says "value of
  the supply"); at or above it the VAT is held and a standard invoice is
  asked for. Buyer details do not reclassify; ZATCA's Art. 49(7)(c)
  discretion is not automated.
- **X5** — Art. 50 VAT posts into the expense line (`Dr expense gross / Cr
  AP`); a 0 %-recovery fixed asset already capitalised its VAT. Neither is held
  or listed. A blocked bill that deducts a supplier advance invoice (whose VAT
  was already claimed) is refused, `blocked_vat_claimed_on_advance`.

### 9.6 NOT built — capitalised-VAT recovery (future capability)

VAT put into cost that later becomes recoverable (an Art. 52 use change, a
late evidence for a document once judged non-recoverable): the accountant
proposed `Dr VAT_INPUT / Cr inventory or asset`, profit or loss once sold or
fully depreciated. IAS 2 and IAS 16 do not address it; IAS 8.37 and IFRIC 1
by analogy support it; prospective vs catch-up, the cap at carrying amount
and the partly-sold split are not confirmed. There is no inventory ledger,
and a fixed asset's cost is frozen with no cost-adjustment act — so nothing
is built.

### 9.7 Verification

`phase13-vat-evidence.test.ts` (the verdict and its mapping, pure; on real
rows: posting into the holding account, the evidence entry and its period,
still-insufficient evidence, the claim window, the credit note on held VAT,
invalid QR, Art. 50 into cost, the trigger, and the ledger sweep's
`vat_awaiting_evidence_gl_vs_bills` with a planted divergence);
`phase13-expenses.test.ts` (a held expense posts AND pays, its VAT held; an
Art. 50 expense posts and pays with its VAT in cost);
`fixed-assets-capitalisation.test.ts` row 3 (capitalised VAT absent from the
return, the laptop's present); `e2e/phase13-evidence-expenses.spec.ts`
(clicked).
