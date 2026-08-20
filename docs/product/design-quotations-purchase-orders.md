# Quotations & Purchase Orders (M21) — ✅ BUILT (all three stages merged)

**Status (2026-08-21): M21 is complete** — M21.1/M21.2/M21.3 merged (PRs
#59–#62), including the owner-review corrections (drafts-only conversion,
no-undo surfaced, discount rule verified with the accountant). §8 records each
decision with its reasoning; §10–§12 are the as-built records. Current state
authority: CLAUDE.md §2.

**Build order (owner-directed):**

| Stage | Scope | Gate |
| --- | --- | --- |
| M21.1 | Quotations: schema, CRUD, approval, numbering, UI. **No conversion.** | ✅ **BUILT** (PR #59). |
| M21.2 | Quotation → invoice conversion, partial by quantity, dated records. | ✅ **BUILT.** 🔴 **OWNER REVIEW** before M21.3 |
| M21.3 | Purchase orders: the mirror, incl. PO → bill matching. | ✅ **BUILT.** |

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


## 10. M21.2 as built (2026-08-20)

**Conversion is not a posting path.** `quotationConversion.service.ts` builds
an invoice body and calls `invoicesService.create` — the same function the
manual form calls — so approval, GL posting, the hash chain, ICV and ZATCA all
behave identically. There is no `postJournalEntry` in that file and there must
never be one. Proven behaviourally rather than structurally: a test approves a
converted invoice and a hand-typed invoice of the same value, and asserts both
move AR by **exactly 575.00**.

**The conversion record is DATED EVENTS, not a running total** (migration
0052). `quotation_conversions` + `quotation_conversion_items`, append-only at
the grants (SELECT + INSERT, verified against `role_table_grants`). Converted
quantity is `SUM` over the item rows — **no `converted_quantity` column exists
anywhere**, so there is no aggregate to drift from the lines. A test converts
4 units in September and 6 later, and asserts BOTH dates survive; a running
total would have kept only the second.

🔴 **A defect this surfaced, worth keeping in mind for M21.3.** The edit path
originally replaced lines wholesale (delete all, insert all) — harmless until
a conversion exists, then fatal twice over: the converted line's delete hits
the `RESTRICT` FK as a raw 500, and had it succeeded the line would come back
with a NEW id, orphaning the record of what the customer accepted. Editing now
**reconciles lines by id**. The old behaviour was re-injected and the
id-stability test went red, so the guard is known to bite.

**Other decisions as built:**

- **Over-conversion → 409**, the `invoicesService.pay` overpay posture.
- **Freeze rule**: a line with any conversion cannot be re-priced or removed;
  untouched lines stay editable. Both directions re-injected and confirmed red
  without the check.
- **Discount is SCALED to the converted proportion** — a 100 SAR discount on 10
  units carries 40 when 4 are invoiced. Not scaling it would undercharge the
  first conversion and overcharge the rest.
- **Expiry never blocks** — an expired quotation converts, with a warning.
- **A converted quotation cannot be deleted** (named 409, not the FK's 500).
- `autoApprove` is resolved from **`invoices:approve`**, not
  `quotations:approve`: the document being issued is an invoice, so authority
  over invoices is what matters. A bookkeeper may convert and gets a draft.
- Invoice numbers for converted invoices are allocated **server-side**
  (`INV-{YYYY}-{NNNN}`). 🔴 Honest scope: `invoices.invoice_number` still has
  no unique constraint (**C12**), so unlike the quotation allocator this one
  has no backstop — a lost race duplicates rather than failing. It reduces
  C12's blast radius; it does not close it.


## 11. Owner review of M21.1/M21.2 (2026-08-20) — two corrections, one open

### 11.1 CORRECTED: conversion is DRAFTS ONLY, for every role

The first cut resolved issuance from the caller's `invoices:approve` grant, so
an admin's conversion issued a legal tax invoice in one click. **Reverted to
the design's own position**, which §6 had already stated and the build had
quietly overridden:

> agreeing a quotation in March is not authority to issue a legal invoice in
> November

The owner's reasoning, recorded because it is the general rule and not a
preference about this screen:

> issuance consumes an ICV irreversibly, conversion can't be undone, and a
> mis-click becomes a credit note

There is now **no `autoApprove` parameter on `quotationConversionService.convert`
at all**, so a future caller cannot reintroduce one without editing the
signature — and the controller has no `can(...)` check, which is the point
rather than an omission. A test converts as an org admin holding every grant
and asserts the result is a draft that consumed no ICV.

🔴 **M21.3 inherits this**: PO → bill conversion produces a DRAFT bill.

### 11.2 KEPT, but SURFACED BEFORE THE ACT: no undo

Append-only conversions stand. The owner's condition:

> surface it before the act, not after — the confirmation should say plainly
> that a conversion cannot be reversed and a mistake is corrected by credit
> note

The convert dialog now states, before the button: the conversion cannot be
reversed, a mistake is corrected by a credit note against the invoice, and the
invoice arrives as a draft so nothing reaches the ledger until approved. The
button reads **"Create draft invoice"**, not "Convert". Neutral styling — this
is a fact about what the button does, not a warning that something is wrong.

### 11.3 ✅ ANSWERED by the accountant (2026-08-20): proportional, and EXACT

> "the invoice should reflect the exact math on the quotation"

So a line-level discount is **proportional to the quantity converted** — 100
SAR on 10 units contributes 40 when 4 are invoiced. Recorded as
**verified-by-accountant, not reasoned**. The alternatives considered and
rejected: the whole discount on the FIRST conversion, on the LAST, or refusing
to convert a discounted line partially. Each would make an intermediate tax
invoice misstate what was agreed, and every one of those documents is real.

🔴 **The rounding half is the part that would actually have bitten**, and the
owner flagged it: a scaled discount is exactly where halalas drift between a
quotation and its invoices. Scaling each conversion independently and rounding
each result gives, for three equal conversions of a 100.00 discount,
`33.33 × 3 = 99.99` — the quotation says 100.00 and the invoices in aggregate
say 99.99, which is precisely the "exact math" the answer rules out.

`allocateLineDiscount` therefore allocates on the **cumulative** quantity and
subtracts what was already allocated, so the parts telescope to the quoted
total by construction (33.33 + 33.34 + 33.33 = 100.00). It is the same
discipline as `header = Σ rounded lines`: round at the finest grain and derive
the rest. Both the three-way and a seven-way split are pinned as tests, and
the naive implementation was re-injected to confirm they go red (99.99 and
10.01 respectively).

The rule lives in ONE function (`services/conversionArithmetic.ts`) so M21.3's
PO → bill conversion uses the identical arithmetic rather than a second copy.


## 12. M21.3 as built (2026-08-20)

The mirror of M21.1 + M21.2, with the matching half that has no quotation
equivalent. Everything inherited: two orthogonal axes, derived conversion
state, dated append-only events, the freeze rule, line reconciliation by id,
drafts-only conversion, zero movement at every status.

### 🔴 Three differences from the mirror, each VERIFIED not assumed

**1. No discount anywhere on a purchase order.** `bill_items` has no
`discount` column and neither does `bills` — checked against
`information_schema`, not inferred from symmetry (invoices have both). A
discount on a PO would therefore be **silently dropped at conversion**, which
is the "partial data is not lenient data" failure: never return part of a
value as the whole value. A supplier discount belongs in the agreed unit
price.

🔴 **This corrects something stated during M21.2**: the claim that both
conversion directions need the identical discount rule. They do not. The
accountant's proportional-allocation answer governs quotation→invoice only.
`allocateLineDiscount` is therefore used by one caller today — which is still
the right home for it, but the reason recorded on the module has been narrowed
to the truth.

**2. No `tax_category_code`.** Same check, same reason: `bill_items` has none.
Bills carry VAT as rate + amount, and input-VAT treatment is decided by the
categoriser and `vat_basis`.

**3. `cancelled`, not `declined`.** A quotation is DECLINED by the customer; a
purchase order is CANCELLED by us. Reusing the quotation's word would assert
that the supplier refused — a fact we have no way to know. Enforced by DB
CHECK, and a test proves `'declined'` is rejected at the database.

### The matching rules as built

**THE BILL IS THE TRUTH; THE PO IS THE EXPECTATION** (owner-ratified).

| Case | Behaviour |
| --- | --- |
| Supplier's price ≠ ordered price | **Recorded, never refused or reconciled.** The bill carries the supplier's price; the PO keeps the ordered one; the difference is a `priceVariance` with both figures and its date. The billed price is STORED per event, so the variance survives a later bill edit. |
| Supplier bills less than ordered | Ordinary partial billing; the remainder stays un-billed. |
| Supplier bills MORE than remains | **409 by default**, with `allowOverBilling` as an explicit override — refusing outright would mean refusing to record a real liability, which the governing principle forbids. |
| A line that was never ordered | **Allowed** (freight, surcharges, substituted parts). It simply has no conversion row, which is what makes it identifiable as unordered. |
| No PO at all | Unchanged — ordinary bill entry. POs are optional. |

Variances are reported as neutral facts with both numbers, never as a status
colour: whether a variance is acceptable is a judgment, and the palette is
reserved for things that ARE the case.

### 🔴 The two-way limitation is on the screen

There is no goods-receipt concept, so we cannot distinguish "shipped half"
from "billed half". Per the owner's instruction, that is stated in the UI
rather than buried: the billing dialog says the platform records what the
supplier has BILLED and does not know what was delivered. Every progress word
in the presenter and the page is billing — `partially_billed`,
`unbilledQuantity`, "Un-billed" — and there is no "received", "delivered" or
"outstanding" anywhere in the feature.

### The façade era is over

`KNOWN_UNBACKED` in `tests/route-reachability.test.ts` is now **empty**. It
held these two pages; each entry was deleted by the stage that built it,
rather than reworded. An empty allowlist means there is no parking space for a
new one — the inverse guard fails the moment any page calls an unmounted
route.
