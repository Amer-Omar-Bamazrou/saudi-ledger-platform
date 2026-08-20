# Quotations & Purchase Orders — SPECIFIED, not built

**Status (2026-08-20):** confirmed as real features by the owner, on his
accountant's advice — the same accountant whose input corrected F3/F4/F7 in
the fiscal-periods work. **Not commissioned:** the pre-AI security work
finishes first. This document records what was decided so the next session
builds against the decision rather than an inferred reading of two page
titles.

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
| Q-3 | **Partial conversion is in scope, not an edge case** — a customer may accept part of a quotation; a supplier may bill part of a PO. | "pays the amount or sub amount" (owner's relay), explicitly flagged as not-an-edge-case |
| Q-4 | **Neither document touches the ledger until converted.** They are COMMITMENTS, not transactions: no GL posting, no AR/AP, no VAT, no cash-flow effect at any stage before conversion. | Owner decision, 2026-08-20 |

### Q-4 is the load-bearing one

A quotation is an offer; a purchase order is an intention to buy. Neither is a
supply, so neither creates a receivable, a payable, output VAT, input VAT, or
any figure on the income statement, balance sheet or VAT return. This puts
them in a different class from every document the platform currently has —
and it is the reason they can be built safely without touching the accounting
core: **the existing invariants stay untouched because these rows are invisible
to every aggregate until conversion produces a real document through the
EXISTING write path** (`invoicesService.create` / `billsService.create`), which
is where approval, hash-chaining, GL posting and ZATCA already live.

🔴 Consequence to hold on to: conversion must NOT be a second posting path.
It builds the input for the existing service and calls it. One writer per
effect.

## 3. Open design questions — answer BEFORE building

These are genuinely open; a builder guessing at them would be building against
an inferred reading, which is the failure this document exists to prevent.

**On partial conversion (Q-3) — the substantive cluster:**

1. **What is the unit of partial conversion — LINES or QUANTITIES?** "Accept
   3 of the 5 line items" and "accept 100 of the 500 units on line 2" are
   different features with different data models. The accountant's "amount or
   sub amount" is ambiguous between them, and it may be both.
2. **What happens to the remainder?** Three plausible answers, all used in real
   systems: the quotation stays OPEN for the unconverted balance; it closes and
   the remainder is abandoned; or a NEW quotation is spawned for the rest. This
   decides whether a quotation has a lifecycle state machine or just a status.
3. **May a partially-converted document be converted AGAIN** (a second
   instalment), and if so, is over-conversion refused the way over-payment is
   (`invoicesService.pay` 409s)? The parallel suggests yes, but it should be
   stated, and it implies a running `convertedQuantity` per line — the
   B4-shaped question: **is the conversion history itself a dated record?**
   (B4's lesson: a running total with one date destroys the instalment
   history. Conversions look identical in shape.)
4. **Does converting a quotation FREEZE its prices?** If a quotation was issued
   at last month's price and the product's price has since changed, the invoice
   presumably uses the QUOTED price — but that must be explicit, because it
   determines whether conversion copies values or re-reads the product table.

**On the documents themselves:**

5. **Does a quotation need approval?** Invoices, bills, JEs and payroll all run
   through the M10 draft/approval engine. A quotation has no ledger effect
   (Q-4), so the engine's purpose — nothing moves before a human approves —
   does not obviously apply. But an SME may still want "the owner sees the
   price before it goes to the customer". Decide: plain status field, or the
   approval engine.
6. **Does a quotation expire?** The deleted page had an `expiryDate` field. If
   expiry exists, does it BLOCK conversion (an expired quote cannot become an
   invoice) or merely display? Blocking is a rule; displaying is a hint.
7. **Do they need document numbering with the same guarantees as invoices?**
   Invoice numbering is ZATCA-relevant and sequence-locked. Quotations and POs
   are not ZATCA documents, so a simpler scheme is probably right — but "probably"
   is exactly the word this document exists to eliminate.
8. **Arabic + the ZATCA question, stated to be dismissed explicitly:** neither
   document is a ZATCA e-invoice and neither is reported. Confirm that is
   right (it is, per the VAT Implementing Regulations — no supply has
   occurred), so nobody later "helpfully" wires them into the einvoice
   pipeline.

**On the existing pages:**

9. The held pages have **no mutation code at all**. Building this milestone
   means writing them properly, not extending them — treat the current files
   as a wireframe of intent, nothing more.

## 4. What "done" would require (the standing check, pre-applied)

- Routes mounted **and** reachable from a UI (both guards in
  `route-reachability.test.ts` must pass without a `KNOWN_UNBACKED` entry —
  deleting those two entries is part of the definition of done).
- A production **writer** for every column added (the shape-without-a-consumer
  rule), and a **reader** for the conversion history if Q-3.3 says it is dated.
- Zero-movement tests in the M10 style: **a quotation and a PO at every
  pre-conversion status move NOTHING** — income statement, balance sheet, trial
  balance, VAT return, AR/AP aging, cash flow, budgets all unchanged. That is
  Q-4 as a test rather than a promise.
- A conversion test proving the resulting invoice/bill went through the
  EXISTING service (approval state, GL posting, hash chain all behave exactly
  as a hand-created document), plus a partial-conversion test proving the
  remainder behaves per the Q-3.2 answer.
- The DB CHECK backstop for any new amount/quantity columns (migration 0049's
  posture: an invariant several writers can violate belongs at the write
  boundary).
