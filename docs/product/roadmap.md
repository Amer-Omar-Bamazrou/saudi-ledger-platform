# Product roadmap — what the platform should eventually do

**Status (2026-08-31): this file lists work that does NOT exist yet.**
Current state authority: [CLAUDE.md §2](../../CLAUDE.md). Nothing here is built,
scheduled, or promised to anyone; when an item is built, its record moves to
`docs/history/` and its row leaves this file.

## Why this file exists

It was opened on 2026-08-31 to hold the half of the inherited frontend spec's
§4 navigation tree that was **accepted** — see
[`frontend-spec-reconciliation.md`](frontend-spec-reconciliation.md) §4.4. That
tree was rejected as a sidebar hierarchy and accepted as a statement of what the
product should eventually do, and the accepted half needed somewhere to live
that is not the navigation.

🔴 **A roadmap is not a navigation plan.** The entries below have no sidebar
presence and must not acquire one before the capability exists. A nav entry is a
promise the product then has to keep; an entry pointing at a page that pretends
is precisely what was deleted in August 2026. **The entry point moves with the
capability, never ahead of it.**

## The list

Ordered by nothing. Sequencing lives in the build order
([`frontend-spec-reconciliation.md`](frontend-spec-reconciliation.md) §6), not
here, so this file cannot drift into a second schedule.

| Item | What it is | Known dependencies |
| --- | --- | --- |
| **Inventory** | Stock items, quantities, movements, and the COGS posting that follows from them | 🔴 The **COGS / chart-of-accounts account decision** (build order step 1b), which is with the advisor as Block E. This is the owner's stated #1 |
| **Templates** | Reusable document templates — invoices, quotations, purchase orders | None known. Distinct from A3 recurring, which repeats a *document*; a template repeats a *shape* |
| **Customer groups** | Grouping customers for pricing, terms, or reporting | None known |
| **Product reporting** | Sales and margin by product — which needs products to carry cost, so it follows inventory | Inventory |
| **Live feeds** | Real-time account/document activity | Overlaps **A2 bank feeds**, which is entity-gated. Scope the two against each other before either is built |
| **E-commerce** | Storefront or marketplace integration | Payment gateways, which are CR-gated (see §5 of the reconciliation) |

## What is deliberately NOT here

- **Anything that already exists.** Debit notes, recurring documents, and the
  categorization engine are live; the spec's §4 listed them as new because it
  described a different platform in places (reconciliation §3.2).
- **The integrations hub** — cut outright (reconciliation §5.3). The
  extensibility need is an `EInvoiceProvider`-shaped code seam, not a screen.
- **Filters wearing the clothes of features.** *Drafts / Pending / Issued /
  Sent / Paid* are one page with a status filter. They are not roadmap items and
  they are not destinations.
