# G04 — tenant-scoped references and zero-membership accounts

**Status (2026-10-07): BUILT on `fix/g04-cross-tenant-references` (migration 0122), stacked on PR #192; not merged.** Current state authority: CLAUDE.md §2.

The investigation is `docs/security-g04-cross-tenant-account-investigation.md`. It was uncommitted when this was written.

## 1. The invariant

> A row of one organization never references a row of another. A tenant-to-tenant foreign key carries `organization_id`, and the company too where the target is company-scoped. Every writer that stores a reference proves the target is its own organization's, by an explicit predicate. A foreign id and a missing id get one controlled refusal.

**Why it needed saying:** Postgres checks a foreign key outside row-level security. A plain `account_id → categories.id` key compares only the id, so:
- it accepted another tenant's account (G04: written, approved and posted);
- it failed a missing id as a raw 23503, a 500 that worked as an existence oracle.

## 2. What 0122 changed

| Reference | Before | After (validated) |
|---|---|---|
| `journal_entry_lines.account_id` | → `categories(id)` | `(organization_id, account_id)` → `categories(organization_id, id)` |
| `journal_entry_lines.customer_id` | → `customers(id)` (`jel_customer_fk`) | `(organization_id, customer_id)` → `customers(organization_id, id)` |
| `journal_entry_lines.vendor_id` | → `vendors(id)` (`jel_vendor_fk`) | `(organization_id, vendor_id)` → `vendors(organization_id, id)` |
| `invoice_items.product_id` | → `products(id)`, SET NULL | `(organization_id, product_id)` → `products(organization_id, id)`, `SET NULL (product_id)` |
| `fixed_assets.custodian_user_id` | → `users(id)` (no tenant key) | `(custodian_user_id, organization_id)` → `organization_memberships(user_id, organization_id)`, `SET NULL (custodian_user_id)` |
| `bills.capitalises_asset_id` | **no key** | `(organization_id, company_id, capitalises_asset_id)` → `fixed_assets(organization_id, company_id, id)` |

Mechanics:
- **Targets:** `UNIQUE (organization_id, id)` on categories, customers, vendors and products; `UNIQUE (organization_id, company_id, id)` on fixed assets.
- **Validation:** each key is added `NOT VALID` and then `VALIDATE`d in the same transaction.
- **Pre-check:** it counts the violating rows per column first and refuses to apply, naming the counts. It repairs, rewrites and deletes nothing.
- **Custodian:** any membership status satisfies the key. Whether a custodian must be an active member is an open owner decision. Removing a member sets the membership inactive and invalidates no asset.

## 3. Enforcement layers

| Layer | What it does |
|---|---|
| Service: manual journal create | `assertLineReferencesOwned` runs before any rule reads the accounts (`services/accounting/tenantReferences.ts`) |
| Posting seam | `postJournalEntry` proves every `accountId` and party, and trusts no caller |
| Approval | Re-proves the stored lines. Approval posts without the seam, so it is not a bypass |
| Reversal | Proves the lines it will mirror before writing the mirror |
| Invoices | Proves the line products, on create and on draft edit |
| Bills | Proves the asset to capitalise is this company's, on create and update |
| Database | The six keys above, for every writer, under RLS or as the owner |
| Error mapping | `lib/dbRefusals.ts`: a 23503 on the six keys (writing side) becomes the same 422 `reference_not_found`, never a raw 500 or a database sentence |

Ownership is an explicit `organization_id = current_setting('app.current_org_id')` predicate, not RLS visibility. Outside a tenant transaction the setting is null and nothing matches, so the check fails closed.

The custodian has no service check: the business layer may not read `organization_memberships` (CLAUDE.md §4), so the database key holds it alone.

## 4. Zero-membership accounts

| Rule | Where |
|---|---|
| An account is created with its first membership, in one transaction | `/auth/register` (`userAdminRepository.createWithFirstMembership`); signup; invitation acceptance; the seeds |
| `/auth/register` requires `organizationId` and proves it: an approved organization the caller actively administers | One 403 for every other value; nothing is created on a refusal |
| `POST /orgs/:id/members` never creates a membership | It re-roles or re-activates an existing member. An unknown id, an operator, another organization's member and a no-membership account all get the same 422 `invitation_required` |
| An existing account joins another organization only by invitation → acceptance → membership | Acceptance is atomic: account, claim and membership commit together |
| Confinement is not vacuous | An account with no membership is administrable by no tenant admin |
| Operators keep zero memberships | G01 is unchanged; the attempt on an operator is still recorded |

`tests/account-creation-writers.test.ts` names every production writer of `users`, and each must insert on a transaction handle.

## 5. Organization-scoped vs company-scoped (the sharing model, unchanged)

**Organization-scoped:** every company of the organization shares them.
- Accounts (`categories`), customers, vendors, products.
- Zakat account classifications, which are keyed on the organization's accounts.

**Company-scoped:**
- Fixed assets and asset categories.
- Bank accounts.
- Periods (`period_locks`).
- Fiscal year (`companies.fiscal_year_start` and `fiscal_calendar`).
- Tax settings (`companies.vat_number` and `vat_tax_period`, tax computations, treasury settings).

**Platform-scoped:** the WHT rate schedule.

## 6. Existing data

- **A fresh database:** 0000→0122 applies cleanly. CI and any future production database start fresh.
- **The local dev database:** 0122 refuses to apply, with `journal_entry_lines.account_id 8, .customer_id 4`.
  - These are two journal entries (`MIG-184-OPEN`, `MIG-184-OPEN-REV`) whose organization, accounts and customer were deleted by a test cleanup with foreign keys switched off.
  - They are orphans, not cross-tenant references. The owner decided to leave them untouched (2026-10-07).
  - The class behind them: test-suite notes, the section on replica-mode cleanups.

## 7. The ratchet, and the conversion order

`tests/tenant-foreign-key-ratchet.test.ts` reads the catalog:
- every tenant-to-tenant key must pair `organization_id` with `organization_id`;
- the 213 that do not yet are pinned by constraint name;
- a new plain key fails the test, and a converted key must leave the list.

**Frame:**
- **Not counted:** keys whose columns are only `organization_id`/`company_id`, keys to `users`/`organizations`, and id columns with no key at all.
- **One pre-existing duplicate:** `migration_assets.batch_id` carries two identical keys.

Proposed order: first the references a client can name in a request body, then the targets the ledger posts to.

| # | Batch | Plain keys | Why this position |
|---|---|---|---|
| 1 | The other references **to accounts** (bill expense account, asset-category accounts, budget lines, tax adjustments, recognition schedules, transaction category, Zakat classification) | 17 | The G04 class itself; service-protected today (the sweep proves each) |
| 2 | References **to customers and vendors** (invoices, bills, payments, supplier payments, refunds, quotations, purchase orders) | 15 | Body ids; the sweep planted `invoices.customer_id` below the service and the database accepted it |
| 3 | References **to bank accounts**, keyed with the company | 19 | Company-scoped cash; D-3's `bankIdentity` guards the services |
| 4 | **Purchases / AP / input VAT** document links | 53 | Allocations, prepayments, notes→originals, VAT events; key with the company |
| 5 | **Sales / AR / e-invoicing** document links | 46 | As 4, on the sales side |
| 6 | **Banking and reconciliation** links | 24 | Statement links and matches |
| 7 | **Tax** (WHT, Zakat, computations) | 25 | Much of it is already guarded by `*_tenant` triggers (0113–0117) |
| 8 | **Fixed assets**, **migration**, **budgets, treasury, payroll, other** | 14 + 24 + 11 | Internal links, written only by their own services |

Batches 1–3 overlap batches 4–8 by source table. A batch converts all of its keys and shrinks the pinned list in the same commit.

## 8. Open decisions

1. **Active custodian.** Must a custodian be an active member? Today any membership status satisfies the key.
2. **Local leftovers.** Rebuild or clean the local dev database's ~9.5k orphaned rows; this is local-only.
3. **The remaining keys.** Approve the conversion order in §7, or a different one.
