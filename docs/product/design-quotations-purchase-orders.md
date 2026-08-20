# Quotations & Purchase Orders (M21) — DECIDED, building

**Status (2026-08-20):** design **APPROVED by the owner**; all five
load-bearing questions answered and every safe default accepted. §8 records
each answer with its reasoning as given. Building in reviewable stages, with
an **owner review gate between quotations and purchase orders** so the second
is not built on an unreviewed pattern.

**Build order (owner-directed):**

| Stage | Scope | Gate |
| --- | --- | --- |
| M21.1 | Quotations: schema, CRUD, approval, numbering, UI. **No conversion.** | — |
| M21.2 | Quotation → invoice conversion, partial by quantity, dated records. | 🔴 **OWNER REVIEW** before M21.3 |
| M21.3 | Purchase orders: the mirror, incl. PO → bill matching. | — |

## 1. Why this document exists at all

Both pages **already existed** as UI: `Quotations.tsx` and
`PurchaseOrders.tsx` rendered forms whose Save button showed a success toast
and persisted nothing, against API routes that were never mounted. The
2026-08-20 audit found them among six such façades; the other four were
deleted. These two were **HELD** by owner instruction — not because the code
was salvageable (it is not; the pages have no mutation at all) but because
the *features* are real and wanted.

Until they are built, the lie is contained rather than hidden: the pages carry
a `🔴 HELD` note in `App.tsx`, and `tests/route-reachability.test.ts`'s
`KNOWN_UNBACKED` lists both paths with the reason. The inverse guard fails the
moment someone adds a third.

## 2. What the accountant specified

| # | Requirement | Verbatim / source |
| --- | --- | --- |
| Q-1 | A **quotation converts to an invoice** when the customer agrees. | "a quotation converts to an invoice when the customer agrees" |
| Q-2 | A **purchase order converts to a bill** when the supplier's bill arrives. | "a purchase order converts to a bill when the supplier's bill arrives" |
| Q-3 | **Partial conversion is in scope, not an edge case.** | "pays the amount or sub amount" (owner's relay), explicitly flagged as not-an-edge-case |
| Q-4 | **Neither document touches the ledger until converted.** | Owner decision, 2026-08-20 |

### Q-4 is the load-bearing one

A quotation is an offer; a purchase order is an intention to buy. Neither is a
supply, so neither creates a receivable, a payable, output VAT, input VAT, or
any figure on the income statement, balance sheet or VAT return.

🔴 Consequence: conversion must NOT be a second posting path. It builds the
input for the existing service and calls it. One writer per effect.

**The precedent already exists and should be copied literally.** A3's recurring
generator does exactly this shape — `generation.service.ts:96` calls
`invoicesService.create(body, rule.createdBy, { autoApprove: false })`, claims
the occurrence *before* doing the work so a concurrent runner cannot double-
generate, and records the produced `documentId`. Conversion is the same
machine with a different trigger.

## 3. What was verified in the code (grounding, 2026-08-20)

Facts this design rests on, each checked rather than assumed:

| Fact | Where | Consequence for this design |
| --- | --- | --- |
| Report/aggregate queries read `invoices`/`bills`/`transactions`/`journal_entries` by table | repositories | New tables are invisible to every aggregate **by construction**, not by a filter someone must remember. This is what makes Q-4 cheap. |
| The approval engine is entity-agnostic (`Approvable<TEntity>`) | `services/approval/approvable.ts` | Quotations/POs can join it without touching it. `onApprove` need not touch a ledger — the contract does not require one. |
| `invoicesService.create` takes `{ autoApprove }` from the RBAC matrix | `invoices.service.ts:55` | The "approver issues in one click, junior's queues" pattern is already built and should be reused, not reinvented. |
| Line totals: round each line, then sum | `invoices.service.ts:88-128` | Quotation lines must use the SAME arithmetic, or a converted quotation and its invoice will disagree by halalas. |
| `tax_category_code`: positive rate → `'S'`, 0% → NULL (fail closed at issuance) | `invoices.service.ts:121` | A quotation must NOT fail closed (it is not issued to ZATCA). The single tax gate stays at invoice creation. |
| RLS coverage is a permanent catalog-driven test | `tests/rls-coverage.test.ts` | New tables missing `organization_id`/policy **fail CI automatically**. No new guard needed. |
| Permissions are seeded `role:resource:action` rows, fail-closed | `lib/rbac.ts` | New resources need SEED grants or every route 403s. The audit flagged the permission-matrix seeds as unaudited — so seed *and* test. |
| `APPROVE_ROUTE` regex maps `/approve`, `/reject`, `/send-back` to the `approve` action | `lib/rbac.ts` | A `/convert` route needs an explicit decision about which action it requires (see 8.6). |

🔴 **Adjacent finding — now queue item C12, NOT part of this milestone.**
Invoice numbers are generated **client-side** as
``INV-${Date.now().toString().slice(-6)}`` (`Invoices.tsx:36`) and there is **no
uniqueness constraint** on `invoice_number` anywhere (the table's only unique
index is `invoices_company_icv_unq`), so duplicates are accepted silently. The
number is written straight into **`cbc:ID`** — the invoice's legal identifier
in the ZATCA document — and into the **`BillingReference`** a credit/debit note
uses to name what it corrects. **Careful about the claim:** the code path and
the missing constraint are verified; the exact ZATCA/EN-16931 wording on
uniqueness *and sequentiality* is **not** — that needs C9's primary-source
treatment before the fix is designed, and must not be restated as fact until
it has been. M21 deliberately does not copy this pattern (§8.6).

## 4. The shape: two orthogonal axes

The single most important structural decision, and the one a naive build gets
wrong: **approval state and conversion state are different axes and must not
be collapsed into one `status` string.**

```
  APPROVAL AXIS (the existing engine, unchanged)
  draft ──submit──▶ submitted ──approve──▶ approved   ("may go to the customer")
    ▲                   │  │
    └────send-back──────┘  └────reject────▶ (hard delete)

  CONVERSION AXIS (DERIVED, never stored)
  none converted            → open
  0 < converted < ordered   → partially_converted
  converted == ordered      → converted

  TERMINAL USER ACTS (explicit, never inferred)
  declined  (the customer said no)      closed (remainder abandoned)
```

A single status field cannot express "approved **and** partially converted",
which is the normal state of a partially-accepted quotation. Collapsing them
produces exactly the M20.0 disease — a field that asserts something the tenant
never said.

**The conversion axis is derived, not stored.** See §5.

## 5. Data model (proposed)

Four new tables per side; eight total. Shown for quotations — purchase orders
are the mirror (`vendor_id`, converts to a bill).

```
quotations
  id, organization_id, company_id,          -- RLS + company scope, as every table
  quotation_number    text NOT NULL,        -- UNIQUE(company_id, quotation_number)
  customer_id         → customers(id) RESTRICT
  date                text NOT NULL,
  valid_until         text NULL,            -- NULL = no expiry stated (§8.4)
  status              text NOT NULL,        -- APPROVAL axis only: draft|submitted|approved
  outcome             text NULL,            -- terminal user act: declined|closed. NULL = live
  subtotal, vat_amount, discount, total     numeric(15,2)
  currency, notes, terms_and_conditions, review_note, created_by, created_at

quotation_items
  id, organization_id, company_id, quotation_id → quotations(id) CASCADE,
  product_id, description, description_ar,
  quantity numeric(15,3), unit_price numeric(15,2),
  vat_rate, vat_amount, discount, total, tax_category_code, unit_code

quotation_conversions                       -- the DATED record (B4's lesson)
  id, organization_id, company_id,
  quotation_id  → quotations(id) RESTRICT,
  invoice_id    → invoices(id)   RESTRICT,  -- the document this produced
  converted_on  text NOT NULL,              -- the DATE, not just created_at
  converted_by  integer, created_at

quotation_conversion_items
  id, organization_id, company_id,
  conversion_id      → quotation_conversions(id) CASCADE,
  quotation_item_id  → quotation_items(id) RESTRICT,
  quantity           numeric(15,3) NOT NULL CHECK (quantity > 0)
```

### Why converted quantity is DERIVED, not a column

The obvious design is `quotation_items.converted_quantity`, incremented on each
conversion. **That is B4's defect, in advance.** B4's backfill lost every
instalment date because a running total carries one date; the fix was one dated
row per event. Conversions are the same shape — "we accepted 100 units in
March and 400 in June" is a fact the business will want, and a running total
destroys it the moment the second conversion lands.

It is also the **header ≠ Σ lines** corollary in §4 of CLAUDE.md: when
line-level truth exists, a stored aggregate is a second computation of the same
fact and *will* drift. So:

> `convertedQuantity(line) = Σ quotation_conversion_items.quantity for that line`

computed in the repository, never stored. The conversion rows are the truth;
the status is arithmetic over them.

**Append-only at the grants**, like `invoice_payments` (B4): `SELECT` +
`INSERT` only, asserted against `role_table_grants`. The record of what was
agreed and when is exactly the row someone would want to quietly fix.

## 6. Conversion, in both directions

### Quotation → Invoice

1. User picks quantities per line (defaulted to the full remaining quantity —
   the common case is one click).
2. Service validates: quotation is `approved`, `outcome` is NULL, each
   requested quantity ≤ remaining. **Over-conversion → 409**, the same posture
   as `invoicesService.pay`'s overpay refusal.
3. Build the invoice body from the quotation lines **at the quoted prices**
   (see 8.3) and call `invoicesService.create(body, userId, { autoApprove })` —
   the existing path, with approval, hash chain, GL posting and ZATCA all
   behaving exactly as for a hand-typed invoice.
4. Write the `quotation_conversions` + `..._items` rows **in the same tenant
   transaction** as the invoice, so a rolled-back invoice cannot leave a
   conversion record claiming it exists.

### Purchase Order → Bill

Same machine, but the matching question is real (§7).

🔴 **Conversion is not an approval.** Converting produces a **draft** invoice
unless the caller holds approve rights, exactly as recurring generation does.
An act about a document is not an act about a pattern: agreeing a quotation in
March is not authority to issue a legal invoice in November.

## 7. What a PO matches against, and what happens when it doesn't match

The genuinely hard half, and the one where the wrong instinct is expensive.

**A three-way match (PO / goods receipt / invoice) is NOT possible** — the
platform has no goods-receipt concept. v1 is a **two-way match: PO ↔ bill.**

🔴 **This limitation is a UI REQUIREMENT, not a footnote** (owner instruction,
2026-08-20). We cannot distinguish "the supplier shipped half" from "the
supplier billed half", and:
> pretending otherwise would be a confident wrong answer.

So a partially-converted PO says **"partially billed"** — never "partially
received", "partially delivered", or anything implying knowledge of goods
movement. The remaining quantity is labelled **un-billed**, not outstanding.
A reviewer of this milestone should read the PO screen for any word that
claims delivery knowledge; there must not be one.

🔴 **THE GOVERNING PRINCIPLE, owner-ratified 2026-08-20 — record it as such:
THE BILL IS THE TRUTH; THE PO IS THE EXPECTATION.**
The supplier's bill is what creates the payable and carries the input VAT.
Refusing to record a real liability because it disagrees with our order would
be a worse error than recording a variance. So conversion pre-fills from the
PO, the user may edit before the bill is created, and the bill is linked to
the PO with the ACTUAL figures.

| Mismatch | Proposed behaviour |
| --- | --- |
| Bill price ≠ PO price | **Allowed, variance recorded and shown.** The bill carries the supplier's price; the PO keeps its own. Never silently reconciled. |
| Bill quantity < PO quantity | Normal partial billing. Remainder stays open. |
| Bill quantity > PO remaining | **Refused (409) with an explicit override**, because this is the case where the supplier may simply be wrong and a human should look. (§8.7 — refuse-with-override vs allow-and-flag is a real choice.) |
| Bill line not on the PO at all | **Allowed**, marked `unordered` on the link. Freight and surcharges are real and common. |
| Bill arrives with no PO | Unchanged — ordinary bill entry. POs are optional. |

🔴 Whatever is chosen, the variance is a **neutral, worded fact, never a status
colour.** CLAUDE.md §4 reserves good/warning/serious/critical for real states; a
price variance is a judgment, and rendering it as a verdict would be the
liquidity-ratio mistake in a new place.

## 8. The decisions (ANSWERED 2026-08-20 by the owner)

Each answer is recorded with the owner's own reasoning, because the reasoning
is what stops a later session re-litigating the choice.

### Load-bearing

**8.1 — Unit of partial conversion: QUANTITIES PER LINE.** ✅
> "the amount or sub amount" — that's partial quantity, not partial line
> selection. Quantities subsumes lines anyway.

Line-subset is the degenerate case where a line converts quantity 0, so one
model serves both.

**8.2 — Remainder STAYS OPEN; the tenant closes it explicitly.** ✅ Splitting
into a new quotation is **rejected**:
> fabricating a document the customer never saw is the platform asserting
> something on their behalf.

Same family as M17.1/M20.0: the platform does not answer a question only the
tenant can.

**8.3 — Conversion FREEZES the quoted price.** ✅
> A quoted price is a commitment; re-reading `products.unit_price` would
> silently honour a different price than the one agreed.

So conversion COPIES line values; it never re-reads the product table.

**8.4 — Editing after conversion: the freeze rule as proposed.** ✅
- A line with **any** conversion against it is frozen (quantity and price).
- Lines with **zero** conversions stay editable.
- 🔴 **No cascade to a produced invoice, ever.** Corrections go through credit
  notes — the existing mechanism. Do not build a cascade.
- **Revisions ("Quote v2"): NOT in v1**, and recorded as a real feature to
  revisit rather than dismissed — the observation that real systems have them
  was accepted as correct.

**8.5 — The APPROVAL ENGINE, with `autoApprove` from the RBAC matrix.** ✅ The
counter-argument (`onApprove` only flips a status here) was weighed and
rejected on cost:
> a second lifecycle vocabulary beside the engine is the worse cost, and an org
> wanting price oversight gets it free.

### Safe defaults — ALL ACCEPTED ✅

**8.6 — Numbering.** Server-generated `QUO-{YYYY}-{NNNN}` / `PO-{YYYY}-{NNNN}`,
per company, with **`UNIQUE (company_id, number)` as the real guarantee** and
allocation inside the creating transaction. Explicitly NOT ZATCA machinery (no
ICV, no hash chain, no borrowing `lockCompanySequence` — that lock exists for
the legally meaningful chain). Explicitly NOT the client-side timestamp pattern
invoices use; that is now **queue item C12**, not a model to copy.
`/convert` requires the `create` action, not `approve` — it produces a draft,
which is a bookkeeper's work. So `convert` is deliberately NOT added to
`APPROVE_ROUTE`.

**8.7 — Over-billing a PO: refused (409) with an explicit override.**

**8.8 — Expiry displayed and warned on, but NOT blocking.** A customer
accepting a lapsed quote is a commercial decision, not a software error.
`valid_until` NULL = no expiry stated, a first-class state.

**8.9 — No ZATCA wiring.** Neither document is an e-invoice; no supply has
occurred. Recorded so nobody later "helpfully" connects them.

**8.10 — VAT shown on quotations**, same round-then-sum arithmetic as invoices,
but the **single tax gate stays at invoice creation** — a quotation never fails
closed on `tax_category_code`.

**8.11 — Currency as invoices handle it today** (a column, no FX machinery).

## 9. What "done" requires (the standing check, pre-applied)

- Routes mounted **and** reachable from a UI; **deleting both `KNOWN_UNBACKED`
  entries is part of the definition of done**, and the inverse guard proves it.
- A production **writer** for every column added, and a **reader** for the
  conversion history (it is dated precisely so someone can read it).
- **Zero-movement tests**, M10 style: a quotation and a PO at every status —
  including `partially_converted` — move NOTHING on the income statement,
  balance sheet, trial balance, VAT return, AR/AP aging, cash flow or budgets.
  That is Q-4 as a test rather than a promise. 🔴 Assert the property, not a
  number: prove the figures do not move AND that the conversion DID move
  something.
- A conversion test proving the produced invoice/bill went through the
  **existing** service (approval state, GL posting, hash chain identical to a
  hand-created document), plus a partial-conversion test for the §8.2 answer
  and an over-conversion test proving the 409.
- **Permission seed grants** for the new resources, with a test — the audit
  recorded that the permission matrix's seeds are unaudited, so this milestone
  should not add to that gap.
- DB CHECKs at the write boundary for quantities/amounts (migration 0049's
  posture), and `rls-coverage.test.ts` passing without new exemptions.
- Standing-check part 6: grep for tests asserting these features are absent
  (`KNOWN_UNBACKED`, the façade notes in `App.tsx`) — each expires the day this
  ships.
