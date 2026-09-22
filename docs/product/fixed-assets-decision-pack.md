# Fixed Assets & Depreciation — research and decision pack

**Status (2026-09-22): FA-1 and FA-2 ANSWERED by the accountant (the Art. 17 pooled income-tax depreciation IS in scope and is computed separately from the book basis; the VAT Art. 52 annual adjustment IS computed in v1, partially-exempt tenants included) and the advance-payments VAT-period answer received and built first (advance-payments pack §17) — FA-0 is CLOSED. 🔴 **FA-A…FA-G are BUILT — §20 the foundation, §21 capitalisation and the monthly run, §22 disposal, §23 migrated assets, §24 the Art. 17 income-tax pool, §25 the VAT Art. 52 adjustment, §26 the reports and the register-to-GL reconciliation.** Current state authority: [CLAUDE.md §2](../../CLAUDE.md).**

Written under [`docs/accounting-escalation-protocol.md`](../accounting-escalation-protocol.md): every accounting claim below carries its class — `AUTHORITATIVE (Saudi)`, `STANDARD (IFRS)`, `ODOO`, `ERPNEXT`, `PRODUCT DECISION`, or `ACCOUNTANT DECISION REQUIRED` — and nothing from Odoo or ERPNext is presented as a Saudi requirement. Primary texts were fetched and read in this pass (§18); the two Saudi texts read in English are ZATCA's own translations, which state that the Arabic prevails — readings that turn on wording are marked *reasoned-not-verified*.

---

## 1. Executive summary

1. **The register that exists is not accounting.** `fixed_assets` / `depreciation_entries` hold a cost, a life and a running book value; `depreciate()` mutates two columns and inserts a row; **nothing posts to the GL**, there is no accumulated-depreciation or depreciation-expense account, a bill line can only debit an *expense* account (so a purchased asset is expensed in full), and a second "Depreciate" click for the same month books the month twice (no `(asset_id, period)` uniqueness). The ERPNext comparison recorded this as finding #6 ("fixed assets never reach the GL"). Everything in §3 replaces that model; nothing of it is worth keeping except the two table names.
2. **Book depreciation is IFRS (IAS 16 / IFRS for SMEs §17) and it is what Zakat uses.** The 2024 Zakat Collection Regulations rely on the SOCPA-endorsed standards (Art. 9), take values "as shown in the financial statements" (Art. 17), deduct **net fixed assets at their net value in the financial statements** from the Zakat base (Art. 26(4), 48(1)(b), 49) and accept the **annual depreciation installment** as an expense of the adjusted net profit (Art. 63(2)) — with **no reference to the income-tax rates**. For a Zakat payer there is ONE basis: the book basis. *(§8)*
3. **Income-tax depreciation is a different regime — pooled, declining-balance, by group** (Income Tax Law Art. 17: 5 groups at 5/10/25/20/10 %, the group balance rolled with 50 % of the year's additions and disposals, a SAR 1,000 write-off, Art. 18's 4 % repair cap). It applies only to persons subject to the Income Tax Law (non-Saudi/non-GCC shareholdings, non-residents' PEs) — **the Zakat Regulations exclude them (Art. 6(1))**. Whether any Saudi Ledger tenant is such a person is the scope question the task anticipated; it is **ACCOUNTANT DECISION FA-1**. The data-model consequence is small and taken now regardless: every asset category carries its Article 17 **group**, and the pool computation (a report over cost base, additions and disposal proceeds the register already holds) is built only if FA-1 says a tenant needs it. *(§8, §13)*
4. **Saudi VAT has a capital-assets input-tax adjustment regime** (VAT Implementing Regulations Art. 52): 6 years for movable, 10 for immovable capital assets (or the accounting life if shorter), an annual adjustment `initial deduction ÷ adjustment period × (actual − intended use)` at the end of each 12-month period, **no adjustment in a year the use does not change** (52(6)), an adjustment for the remainder on sale (52(7)), a **nominal supply** when the asset leaves the taxable activity (52(8), with a formula), and records kept for **the adjustment period + 5 years from acquisition** (Art. 66(1)). For a fully-taxable SME nothing is ever *adjusted*, but the regime still fixes what the register must **store from day one**: acquisition date, purchase value, input tax deducted, initial recovery %, movable/immovable, and each capital improvement as its own adjustable item. *(§7)* The reading of 52(7) for a fully-taxable asset sold as a taxable supply (adjustment = nil) and the v1 scope of partially-exempt tenants are **ACCOUNTANT DECISION FA-2**.
5. **Proposed model (§3):** an asset **category** bound to three accounts (asset cost, accumulated depreciation, depreciation expense) plus its Article 17 group and VAT class; an asset **master** with the IAS 16 facts (cost, residual, useful life, method, available-for-use date) and the VAT Art. 52 facts; a generated, stored **depreciation schedule** (one row per month, posted rows immutable); every effect **posted through `postJournalEntry`** (capitalisation, depreciation, disposal), one writer each; disposal through the existing invoice path for a sale (a 388, VAT at 15 %, gain/loss never in revenue — IAS 16.68) and a disposal document for scrapping; **migration through Batch 1C's opening journal** (cost and accumulated depreciation as opening lines, no plug — A5). Straight-line first; declining-balance and units-of-production representable, not built (§12).
6. **Readiness (§19):** research complete; data model and accounting model ready subject to FA-1/FA-2; implementation NOT to start until FA-1, FA-2 and the Advance Payments VAT-period answer are in, in that order of dependency.

---

## 2. Current Saudi Ledger foundation

| What | Where | State |
| --- | --- | --- |
| Register tables | `packages/db/src/schema/assets.ts`: `fixed_assets` (cost, salvage, `useful_life_years`, `depreciation_method` `straight-line \| declining`, `accumulated_depreciation`, `current_book_value`, `status` `active \| fully-depreciated \| disposed \| sold`, `disposal_date/value`, `category_id` → `categories`) and `depreciation_entries` (`asset_id`, `period` text `YYYY-MM`, `amount`, `book_value_after`) | Tenant-scoped (`organization_id`, `company_id`, RLS). No `(asset_id, period)` uniqueness; `depreciation_method = declining` is stored but never computed. |
| Service | `apps/api/src/services/assets.service.ts` | `create` (allowlisted fields, book value = cost), `depreciate(id, period)` (one rounded straight-line addend, min with remaining depreciable amount; mutates the asset; inserts a row; audit `updated`). **No `postJournalEntry`, no `checkPeriodOpen`**, no disposal, no reversal, no schedule. |
| Routes / UI | `routes/assets.ts` (`GET /`, `GET /:id`, `POST /`, `POST /:id/depreciate`); `pages/Assets.tsx`, `pages/AssetSchedule.tsx`; nav marks `/assets` **built** | Reachable and clickable; the KPI is clipped on phone (feature inventory 2026-09-15). |
| Chart of accounts | `system_account_templates`: **one** account, `FIXED_ASSETS` (asset, `liquidity_class = non_current`, VAT-applicable, default treatment S). **No** accumulated depreciation, **no** depreciation expense, **no** gain/loss on disposal, **no** CWIP | The categorizer maps bank/manual transactions to `FIXED_ASSETS` (so a paid-by-bank purchase lands on the asset account at gross with no register row); a **bill line can only debit an expense account** (`bills.approvable.ts` `resolveExpenseLine` refuses `type !== "expense"`), so a purchase through AP is expensed. |
| Period locks | `services/accounting/periodLock.ts` `checkPeriodOpen(date)` — company-scoped; a correction to a closed month posts in the open month (CLAUDE.md §4) | Not consulted by the register. |
| Journal reversal | `journalEntries.service.reverse` — mirror entry dated today, original marked `reversed`, `JE_IN_BOOKS` includes both | The seam a depreciation correction must use. |
| Migration | Batch 1C (`migration_batches`, opening journal through `postJournalEntry`, **A5: no `OPENING_BALANCE_EQUITY`, an unbalanced position is refused**; **A4: committed rows never deleted, corrected by reversal + replacement**) | Has no asset step; the opening TB can map a balance to `FIXED_ASSETS` but produces no register rows. |
| Zakat | M17.3/M17.4 HELD on C10; the base will deduct "deductible long-term assets" from the GL (design-zakat-module §4) | Needs the asset cost and accumulated-depreciation accounts to exist as GL balances — which this design provides. |
| Audit trail | `auditService` (`created`/`updated`/…), append-only `audit_logs` | Used by the register for create and depreciate. |

**What the foundation dictates:** the redesign is additive to the chart (three system accounts + a disposal account, seeded by the trigger with the column-set guard `tests/org-seed-trigger.test.ts`), replaces the two tables' semantics (no customers — CLAUDE.md §2 "cheap now"), and threads every effect through `postJournalEntry` and `checkPeriodOpen`.

---

## 3. Proposed Fixed Asset accounting model

`PRODUCT DECISION`, built on `STANDARD (IFRS)`; the Saudi requirements of §7 and §8 are folded in.

**Accounts (per company, seeded system accounts):** `FIXED_ASSETS` (exists — becomes a *header* under which per-category cost accounts sit, or stays the single cost account for v1), `ACCUMULATED_DEPRECIATION` (contra-asset, `non_current`), `DEPRECIATION_EXPENSE` (expense), `ASSET_DISPOSAL_GAIN_LOSS` (other income/expense — never `SALES`, IAS 16.68), `CWIP` (asset; deferred unless FA-scope needs assets under construction — §12). A **category** binds an asset to exactly one triple (cost / accumulated / expense), the way ERPNext's `Asset Category Account` (fixed_asset_account, accumulated_depreciation_account, depreciation_expense_account, capital_work_in_progress_account — per company) and Odoo 11's `account.asset.category` (account_asset_id, account_depreciation_id, account_depreciation_expense_id, journal) both do.

**Entries — one writer per effect, all through `postJournalEntry` after `checkPeriodOpen`:**

| # | Event | Entry | Date | Notes |
| --- | --- | --- | --- | --- |
| A1 | Acquisition through a **bill** (AP) | `Dr Asset cost (category)` net · `Dr VAT_INPUT` deductible VAT · `Cr AP` gross | bill date | The bill's own posting path, extended so a line may debit an **asset-type** account **and** create the register row (§5). Non-deductible VAT (Art. 50 — restricted vehicles) is capitalised: `Dr Asset cost` gross, no `VAT_INPUT`. |
| A2 | Acquisition through a **bank/manual transaction** | `Dr Asset cost` · `Cr Bank` — the transaction posting path, unchanged | transaction date | The register row is created from the transaction (a "capitalise this transaction" act), or the transaction is coded to `FIXED_ASSETS` and reconciled to a register row created separately — §5 chooses the first. |
| A3 | Directly attributable costs after the purchase (freight, installation — IAS 16.16(b)) | `Dr Asset cost` · `Cr AP/Bank` | cost date | An **addition** row on the asset (its own VAT Art. 52 adjustment period — 52(3)); it raises the depreciable amount from the next period. |
| D | **Monthly depreciation** | `Dr DEPRECIATION_EXPENSE` · `Cr ACCUMULATED_DEPRECIATION` | last day of the month (or the run date inside the month) | One entry per asset per period from the stored schedule row; the row records `journal_entry_id`; a period is posted **once** (`unique(asset_id, period)`). A run for a closed month is refused (§15). |
| E1 | **Sale** (taxable supply) | Through the existing invoice path: `Dr AR` gross · `Cr VAT_OUTPUT` · `Cr ASSET_DISPOSAL_GAIN_LOSS` net proceeds — plus the derecognition: `Dr ACCUMULATED_DEPRECIATION` (accumulated to date) · `Dr ASSET_DISPOSAL_GAIN_LOSS` (carrying amount) · `Cr Asset cost` (cost) | invoice date | Net of the two: the account holds `proceeds − carrying amount` = the IAS 16.71 gain/loss. Depreciation is run up to the disposal date first (§9). |
| E2 | **Scrap / write-off** (no proceeds) | `Dr ACCUMULATED_DEPRECIATION` · `Dr ASSET_DISPOSAL_GAIN_LOSS` (carrying amount) · `Cr Asset cost` | disposal date | A disposal document, not an invoice; VAT: a nominal supply may arise if the asset leaves the taxable activity while still having value (Art. 52(8) / Art. 9) — §7, §9. |
| M | **Migration** (opening asset) | Inside Batch 1C's opening journal: `Dr Asset cost` (original cost) · `Cr ACCUMULATED_DEPRECIATION` (opening accumulated) — balanced by the rest of the opening position, **no plug** (A5) | opening date | The register row carries `opening_accumulated_depreciation` and `opening_periods_booked`; the schedule starts after the opening date (§10). |

**Never:** a second posting path (no direct GL write from the register), an entry from a draft, a change to a posted schedule row, a delete of an issued asset.

---

## 4. Asset lifecycle

`PRODUCT DECISION`, informed by ERPNext's `Asset.status` (Draft · Submitted · Partially Depreciated · Fully Depreciated · Sold · Scrapped · Capitalized · Work In Progress …, derived in `get_status()` from `value_after_depreciation` vs `expected_value_after_useful_life`) and Odoo 11's three states (`draft` · `open` "Running" · `close`).

| State | Meaning | Books | Enters from | Leaves to |
| --- | --- | --- | --- | --- |
| `draft` | Register row exists; cost, category, dates entered; nothing posted | nothing | create | `in_service` (capitalise), `cancelled` (delete — a draft is deletable) |
| `in_service` | Capitalised: cost posted (A1/A2 or M); available for use; depreciating from `available_for_use_date` | cost on the asset account | `draft`; migration commit | `fully_depreciated`, `disposed` |
| `fully_depreciated` | Carrying amount = residual value; still in service, still on the balance sheet (IAS 16.55 — depreciation does not cease when idle; it ceases only when the depreciable amount is exhausted) | cost − accumulated = residual | `in_service` (derived, not an act) | `disposed` |
| `disposed` | Derecognised (sold or scrapped); E1/E2 posted; terminal | zero | `in_service`, `fully_depreciated` | — |

**Derived, not stored:** `fully_depreciated` is a fact of the figures (as in ERPNext); storing it as a status invites the drift the current `status` column already shows. Store `draft | in_service | disposed | cancelled`; render "fully depreciated" from `accumulated = cost − residual`.

**Not states:** "acquired", "capitalised" and "depreciating" (the task's list) collapse into `in_service` — in this model an asset is capitalised the moment its cost is posted, and depreciation is a schedule, not a state. "Retired" = `disposed` with no proceeds. A held-for-sale state (IFRS 5) is out of scope (§12).

**Transitions that are ACTS (audited, permission-gated):** capitalise, add cost, run depreciation, change estimate (useful life / residual / method — prospective, §6), transfer (§12 — location/department only), dispose (sale or scrap), reverse a depreciation run (a correction, §15).

---

## 5. Acquisition and capitalisation

| Point | Class | Source | Saudi Ledger |
| --- | --- | --- | --- |
| Recognise when future benefits are probable and cost is measurable | STANDARD | IAS 16.7 | A register row is created from the purchase document (bill / transaction) or by hand; a **capitalisation threshold** (below which an item is expensed) is not in IAS 16 — it is a materiality policy. `PRODUCT DECISION`: a per-company setting, default SAR 0 (everything the user marks as an asset is one); the UI suggests, never decides. |
| Cost = purchase price incl. import duties and **non-refundable purchase taxes**, less discounts, + directly attributable costs (site prep, delivery, installation, professional fees, testing) + dismantling estimate | STANDARD | IAS 16.16–17 | Cost = net price + non-deductible VAT (restricted motor vehicles, Art. 50(1)(c)) + attributable costs posted as **additions** (A3). Deductible VAT is `VAT_INPUT`, never cost. Dismantling provisions: out of scope (§12). |
| Not cost: opening a facility, launching a product, training, admin overheads | STANDARD | IAS 16.19 | Expensed through the ordinary bill path — the same bill can carry an asset line and an expense line. |
| Capitalisation ceases when the asset is in the location and condition to operate; costs of using or redeploying are not cost | STANDARD | IAS 16.20 | Additions after `available_for_use_date` need a reason (improvement/enhancement — Art. 52(3) treats them as new capital expenditure with their own VAT adjustment period). Repairs are expensed. |
| In-service date | STANDARD | IAS 16.55 — depreciation begins when **available for use** | `available_for_use_date` is mandatory at capitalisation and may differ from the purchase date (ERPNext: `available_for_use_date`; Odoo 11 uses the asset `date` with `prorata`). |
| Purchase through AP | PRODUCT | — | The bill line gains an **asset-type account** option (today refused) and a "creates an asset" flag; approval posts A1 and creates the register row in `draft` or `in_service` (in service when the available-for-use date is on the bill). ERPNext links `purchase_invoice`/`purchase_receipt` to the asset and validates quantities (`validate_linked_purchase_documents`). |
| Purchase through a bank transaction / manual entry | PRODUCT | — | A "capitalise" act on a transaction coded to the asset account creates the row (A2). A register row with no posting document is possible only through migration. |
| Partial payment | PRODUCT | — | Irrelevant to capitalisation: the asset is recognised on the bill (accrual), AP is paid by D-4 paths as usual. |
| Assets under construction | STANDARD (IAS 16.16 applies to self-constructed assets) / Zakat Art. 49(5) lists "projects under construction" as deductible | — | Deferred (§12): a `CWIP` account and a "transfer to asset on completion" act. The model must allow it later (a category whose cost account is CWIP and a completion act) — nothing in v1 prevents it. |
| VAT treatment on purchase | AUTHORITATIVE (Saudi) | VAT IR Art. 49 (deduction), Art. 50 (blocked: restricted motor vehicles, private use), Art. 52(3) (initial deduction per **intended use**) | The bill's VAT line is deductible by default (`S`); the register stores **`vat_input_tax_amount`** and **`vat_initial_recovery_pct`** (100 for a fully-taxable business; 0 for a blocked vehicle; the proportional-deduction % for a mixed business — Art. 51) — §7. |

---

## 6. Book depreciation

| Point | Class | Source | Saudi Ledger (v1) |
| --- | --- | --- | --- |
| Systematic allocation of the depreciable amount over useful life | STANDARD | IAS 16.50 | Straight-line, monthly. |
| Depreciable amount = cost − residual value | STANDARD | IAS 16.53 | `residual_value` (default 0), may not exceed cost. |
| Methods: straight-line, diminishing balance, units of production; the method must reflect the consumption pattern; revenue-based methods prohibited | STANDARD | IAS 16.60, 62 (and the 2014 amendment) | **v1: straight-line only.** `declining_balance` and `units_of_production` are enum values the schema admits and the engine refuses (`depreciation_method_unsupported`) until built — §12. ERPNext offers Straight Line / Written Down Value / Double Declining Balance / Manual (`Asset Finance Book.depreciation_method`); Odoo 11 offers linear / degressive with a factor. |
| Begins when available for use; does not cease when idle; ceases at held-for-sale or derecognition | STANDARD | IAS 16.55 | Schedule starts in the month containing `available_for_use_date`; runs through disposal; an idle asset keeps depreciating. |
| Partial first period | STANDARD allows any systematic basis | — | `PRODUCT DECISION`: **full-month convention** — the first period is the month of `available_for_use_date` in full, the last is the month before the life ends; total periods = `useful_life_months`. Simple, deterministic, and what ERPNext's non-prorata path does (`get_fixed_depr_amount`: depreciable value ÷ pending periods). A **daily-prorata** option (ERPNext `daily_prorata_based`; Odoo `prorata` — first month by days remaining) is representable by a per-company setting later and is NOT built in v1. The accountant may set a tenant's policy either way; it is a policy, not a legal question. |
| Monthly amount and rounding | — | — | `amount = round2((cost − residual − opening_accumulated) ÷ remaining_periods)` computed once at schedule generation; the **last row absorbs the rounding residue** so Σ rows = depreciable amount exactly (Odoo 11 `_compute_board_amount`: the last sequence takes `residual_amount`). One rounded addend per row (`lib/money.ts`, CLAUDE.md §4 N2). |
| Review of residual value and useful life at least each year-end; a change is a **change in estimate** (IAS 8), applied prospectively | STANDARD | IAS 16.51, 61 | A "change estimate" act re-generates **only the unposted** rows from the remaining carrying amount over the remaining (new) life — posted rows are never touched; the act is audited with old/new values (§17). ERPNext: `increase_in_asset_life`, schedule regenerated for future rows. |
| Fully depreciated | STANDARD | IAS 16.55 | Carrying amount = residual; no further rows; stays on the balance sheet until disposed. |
| Impairment | STANDARD | IAS 16.63 → IAS 36 | Out of scope (§12). |

**Depreciation for Zakat purposes uses these book figures** (§8) — there is no second schedule for a Zakat payer.

---

## 7. Saudi VAT — the capital-assets adjustment regime

`AUTHORITATIVE (Saudi)` — VAT Implementing Regulations (ZATCA Board resolution 3839 as amended; Eighth Edition, 09/11/2021, English translation — the Arabic prevails), read from the pinned text `docs/zatca/specs/KSA_VAT_Implementing_Regulations_EN.txt`.

| Question | Answer | Article |
| --- | --- | --- |
| Does a capital-asset adjustment regime exist? | **Yes.** "A Taxable Person shall adjust previously deducted Input Tax in relation to a Capital Asset in cases where the Taxable Person's Input Tax decreases or increases as a result of a change in the way the Taxable Person uses the Asset, or a change in the VAT status of such use." | Art. 52(1) |
| Scope / definition | "Capital Asset" is a defined term of the GCC Unified VAT Agreement (assets allocated for long-term use as a business instrument or means of investment); the Regulations distinguish **movable tangible or intangible** and **immovable (permanently attached to land or real estate)** capital assets. No monetary threshold appears in the Regulations. | Art. 52(2); Agreement Art. 1 *(definition reasoned-not-verified — the Regulations' definitions chapter defers to the Agreement)* |
| Adjustment period | **6 years** movable, **10 years** immovable, **from the date of purchase**; if the accounting life is shorter, the adjustment period is the accounting life, part years counting as one. | Art. 52(2) |
| Initial deduction | Per the **intended use** at acquisition. | Art. 52(3) |
| Capital expenditure on an owned asset (construct, enhance, improve) | Counts as (additional) acquisition expenditure with **its own adjustment period from completion of the works**. | Art. 52(3) |
| Annual mechanism | At the end of each 12-month period: potentially adjustable amount = **initial input tax deduction ÷ adjustment period**; adjust it "based on the actual use of the Capital Asset during that year"; the first 12-month period starts at the **start of the tax period of acquisition**; the adjustment goes in the return for the **last tax period falling in that 12-month period**. | Art. 52(4), (5) |
| No change of use | **No adjustment that year.** | Art. 52(6) |
| Sale or disposal | A permanent change of use: adjust the deduction **for the remainder of the adjustment period** in the tax period of sale. **No** adjustment if the asset is destroyed, stolen, or ends its life earlier than accounted for. | Art. 52(7) |
| Withdrawal from taxable activity | No adjustment; instead a **Nominal Supply** valued at `purchase value × initial recovery % × remaining useful life ÷ adjustment period`. | Art. 52(8) |
| Blocked input tax | Restricted motor vehicles (and their repair/fuel), entertainment, private use — no deduction; a restricted vehicle's later sale is **not** in the course of economic activity. | Art. 50(1)–(3) |
| Sale of a used asset | A supply of goods by a taxable person — taxable at the standard rate (the Regulations exclude capital-asset supplies only from the **registration threshold** computation, which presupposes they are taxable supplies). Requires a tax invoice (ZATCA 388) — the existing invoice path. | Art. 3(5); Art. 50(3) for the exception |
| Assets held at registration | Input tax recoverable as if the **net book value** were the consideration. | Art. 15(3)(b), (4) |
| Records | **Adjustment period + 5 years from acquisition** (i.e. 11 / 15 years) — longer than the general 6-year rule. | Art. 66(1) |

**What must be stored from day one (the minimum, regardless of whether v1 computes an adjustment):** `acquisition_date` (the adjustment clock — Art. 52(2), (5)); `purchase_value` (52(8)); `vat_input_tax_amount` deducted initially and `vat_initial_recovery_pct` (52(3), (4), (8)); `vat_capital_asset_class` `movable | immovable | not_capital` (52(2)); the accounting useful life (52(2) — shortens the period); each **addition/improvement** as its own row with its own completion date (52(3)); the **disposal date and kind** (52(7)); a per-asset **use-history** table for the actual-use % by 12-month period — needed only by partially-exempt tenants, but the table exists so the annual adjustment can be computed and evidenced (52(4)–(5)); retention until `acquisition + adjustment period + 5 years` (Art. 66) — i.e. **asset rows are never hard-deleted**.

**Does the register have to track anything beyond cost/depreciation?** Yes: the input-tax facts and the use history above, and the *VAT* adjustment period (6/10/life) which is **not** the accounting life. The two clocks differ by construction (a 4-year laptop has a 4-year VAT period; a 25-year building has a 10-year one).

**What does NOT follow from the text and is left to FA-2 (§15):** whether v1 must **compute** the annual adjustment (only tenants with exempt supplies ever have one — Art. 51) and the reading that a fully-recovered asset **sold as a taxable supply** needs no 52(7) adjustment (its use stays 100 % taxable through the remainder). Both are readings of an unofficial translation with a direct return consequence.

---

## 8. Book vs Zakat vs income-tax depreciation

### 8.1 IFRS book depreciation (§6) — `STANDARD`
SOCPA-endorsed IFRS (full IFRS for listed entities; IFRS for SMEs for others) is the basis of Saudi financial statements; the Zakat Regulations adopt "the standards endorsed by the Saudi Organization for Chartered Accountants" (Art. 9).

### 8.2 Zakat — `AUTHORITATIVE (Saudi)`
Implementing Regulations for Zakat Collection, Minister of Finance Decision 1007 (19/08/1445H) as amended by 1248 (11/10/1446H), English text from zatca.gov.sa (the Arabic prevails):

| Point | Article | Consequence |
| --- | --- | --- |
| Values are those **shown in the financial statements** at the Zakat year-end | Art. 17 | The GL balances are the Zakat inputs — no separate valuation. |
| **Net fixed assets** (and their equivalents) are **deducted** from the Zakat base | Art. 26(4), Art. 49 (list: net fixed assets, payments for purchasing fixed assets, spare parts not for sale, finance-lease/BOT assets, capital constructions and projects under construction for use in the activity, non-current right-of-use assets, non-current investment property, raw land used in the activity …) | Cost − accumulated depreciation, per category, is a base deduction. Assets held for **resale** are not deductible (Art. 48(1)(a), 51(2)). |
| Deducted at the **net value shown in the financial statements** | Art. 48(1)(b) | Book NBV — not a tax-depreciated value. |
| **Annual depreciation installment** is an accepted expense in the adjusted net profit, for assets meeting Art. 48 | Art. 63(2) | Book depreciation is accepted **as booked**; the Regulations contain **no cap tied to the Income Tax Law's rates** (searched: no reference to those rates anywhere in the text). |
| Minimum Zakat base = adjusted net profit (with the undeducted-assets rule) | Art. 27 | Depreciation expense reduces adjusted net profit and therefore the floor — the C10 question (design-zakat-module §4) already holds this. |
| Persons subject to the Income Tax Law are **not subject** to the Zakat Regulations, for the share subject to income tax | Art. 6(1) | Mixed companies: the Saudi/GCC share → Zakat (book basis); the foreign share → income tax (Art. 17 basis). |

**Finding:** for a Zakat payer there is **one basis — the book basis**. No second schedule, no deferred-tax computation (Zakat is levied on the base, not on profit; IAS 12 deferred tax arises for income-tax payers only).

### 8.3 Income tax — `AUTHORITATIVE (Saudi)`
Income Tax Law (Royal Decree M/1, 15/1/1425H), Article 17 "Depreciation" (English text as deposited with the WTO; the Arabic prevails):

| Rule | Text (condensed) |
| --- | --- |
| Scope | Depreciation may be deducted for depreciable tangible/intangible assets (**except land**) used wholly or partly to generate taxable income. 17(a) |
| **Groups and rates** | (1) stationary buildings **5 %**; (2) movable industrial and agricultural buildings **10 %**; (3) factories, machines, engines, hardware and software, equipment incl. passenger and cargo vehicles **25 %**; (4) geological surveying/exploration expenditure **20 %**; (5) all other tangible and intangible depreciable assets — furniture, planes, ships, trains, goodwill — **10 %**. 17(b) |
| **Pooled declining balance** | The deduction per group = rate × the **group balance at year-end**; the balance = prior year-end balance after depreciation + **50 % of the cost base of assets added in the current and previous year** − **50 % of the compensation for assets disposed of in the current and previous year**, never negative. 17(d)–(e) |
| Conversion to personal use / ceasing to generate taxable income | Deemed disposal at market value. 17(f) |
| Disposals exceeding the balance | Balance to zero; excess is taxable income. 17(g) |
| Small balance | A year-end balance below **SAR 1,000** may be deducted. 17(h) |
| All assets of a group disposed | The remaining balance is deducted. 17(i) |
| Land with buildings | Apportion to value the construction separately. 17(j) |
| Partial business use | Depreciation only on the business part. 17(k) |
| BOT / BOOT | Over the contract period. 17(l) |
| Repairs and improvements | Deductible up to **4 % of the group's year-end balance**; the excess is added to the group balance. Art. 18 |
| Transitional | Assets acquired before the Law enter the group at cost less depreciation previously allowed. Art. 81(a) |

**Does tax depreciation differ materially from book depreciation?** Yes, structurally: pooled by group (no per-asset schedule), declining-balance at statutory rates, the half-year convention on additions and disposals, no residual value, disposal effects run through the pool (no per-asset gain/loss). A per-asset IFRS register cannot *be* the tax computation; the tax computation is a **report over the register**: for each group, the opening balance, Σ cost of additions (current + prior year) × 50 %, Σ proceeds of disposals (current + prior year) × 50 %, × rate — every input the register holds if each asset carries its **group** and its **disposal proceeds**.

**Who it applies to:** Art. 2 of the Law — resident capital companies for the non-Saudi/non-GCC share, non-residents with a PE, persons in oil/hydrocarbons; wholly Saudi/GCC-owned companies pay Zakat only (Zakat Regs Art. 6(1) mirrors this). A tenant's regime is a **company fact** (`tax_regime: zakat | income_tax | mixed(share %)`), not universal. Whether any target tenant is an income-tax payer — and therefore whether the pool report and the deferred-tax consequence (IAS 12 for those tenants) are v1 — is **FA-1**.

### 8.4 Consequence for the data model (the decision the task asked for)
- **Book basis**: stored per asset (cost, residual, life, method, schedule) — always.
- **Tax basis**: **not** a second per-asset schedule. What must be captured **from the beginning** so it can never be retrofitted wrongly: the **Article 17 group** on every asset category (a 5-value enum, mandatory), the **cost base** at acquisition, **additions by date**, **disposal proceeds by date**, and the company's **tax regime**. The pool report itself is built only if FA-1 says a tenant needs it. This is cheaper than a "tax basis" column and more correct: a pool balance is a per-group, per-year figure, not a per-asset one.
- **Zakat basis**: = book basis; nothing extra beyond the Art. 48/49 eligibility flags a category already implies (held for use, not for resale).

---

## 9. Disposal

| Point | Class | Source | Saudi Ledger |
| --- | --- | --- | --- |
| Derecognise on disposal or when no future benefit | STANDARD | IAS 16.67 | `dispose` act (sale or scrap) — terminal. |
| Gain/loss = net proceeds − carrying amount, in profit or loss, **not revenue** | STANDARD | IAS 16.68, 71 | `ASSET_DISPOSAL_GAIN_LOSS` account; the income statement shows it below gross profit ("other income/expense"), never in `SALES`. |
| Depreciation up to disposal | STANDARD (IAS 16.55: ceases at derecognition) | — | The disposal act first posts the schedule rows up to the disposal month (full-month convention: the disposal month is depreciated in full — `PRODUCT DECISION`, consistent with §6; ERPNext books a final depreciation on disposal — `make_depreciation_entry_on_disposal`), then derecognises. |
| **Sale** | AUTHORITATIVE (VAT) | taxable supply → a 388 (§7) | The existing invoice path with a line whose revenue account is `ASSET_DISPOSAL_GAIN_LOSS` (an invoice line-level income account is a **prerequisite** — today every invoice line credits `SALES`, `invoices.approvable.ts:485`) and an `asset_id` link; on approval the asset's E1 derecognition posts in the same transaction. VAT at 15 % on the price; ZATCA document as any invoice. **Restricted motor vehicle** bought without deduction: the sale is outside the economic activity (Art. 50(3)) — the invoice line is out-of-scope (`O`) and the reason must be recorded. |
| **Scrap / write-off** | STANDARD; VAT Art. 52(7) (no adjustment when destroyed/stolen) vs 52(8) (nominal supply when withdrawn while still usable) | — | A disposal document with `kind: scrapped | stolen | destroyed | withdrawn`; E2 posts; for `withdrawn` the VAT nominal-supply value is computed by the Art. 52(8) formula and shown, and the return leg is **FA-2** (§15). |
| Proceeds below carrying amount / partial disposal | STANDARD | — | Loss to the same account; partial disposal (part of a component) is out of scope (§12). |
| Documentation | AUTHORITATIVE (VAT Art. 66 records) + audit | — | The disposal row stores proceeds, counterparty (customer on a sale), the invoice/document id, the reason, the accumulated depreciation and carrying amount at disposal, the VAT consequence recorded. |
| Undo | PRODUCT (Policy C / A4) | — | A disposal is corrected by **reversal + a new act**, never edited. ERPNext: `restore_asset` cancels the scrap JE (its `Cancelled` docstatus); Saudi Ledger has no cancel — reversal is the mechanism. |

---

## 10. Migration (migrated fixed assets)

`PRODUCT DECISION` built on Batch 1C's decided invariants (A4, A5) and IAS 16.

| Fact | Where it lives | How it enters the books |
| --- | --- | --- |
| Original cost, acquisition date, available-for-use date, category, method, useful life, residual | the register row (`source: migration`, batch id, source reference — the 1C provenance pattern) | the migration's asset step (a new 1C step beside parties/open items/advances) |
| Accumulated depreciation to the opening date | `opening_accumulated_depreciation`; `opening_periods_booked` | **the opening journal**: `Dr Asset cost` (per category cost account) · `Cr ACCUMULATED_DEPRECIATION` — two lines of the same balanced opening position (A5: refused if it does not balance; no equity plug) |
| Net book value | derived (cost − opening accumulated), reconciled to the mapped opening TB balances (R-rules) | a new reconciliation rule: Σ register cost = opening `FIXED_ASSETS`-class balances; Σ opening accumulated = opening `ACCUMULATED_DEPRECIATION` |
| Remaining useful life | `useful_life_months − opening_periods_booked` — **continue the original schedule** (an estimate change is a separate, audited act) | schedule generated from the first period **after** the opening date; the depreciable amount = cost − residual − opening accumulated (ERPNext: `opening_accumulated_depreciation` + `opening_number_of_booked_depreciations`; Odoo 11 has no opening fields — a migrated asset is entered with `value` and the board recomputed) |
| A fully-depreciated migrated asset | same row, no schedule | still deducted for Zakat at NBV = residual |
| VAT Art. 52 facts | `acquisition_date`, `vat_input_tax_amount`, recovery %, class — **required on import when the asset is inside its adjustment period** (≤ 6/10 years old), optional otherwise | none |
| Correction after commit | A4: reversal + replacement row with a new asset number, provenance to the original | reversal of the opening lines through the batch reversal |

**No artificial plug:** the opening asset lines are part of the single balanced opening journal; if the source's NBV does not reconcile to the source TB, the migration is blocked (A5), exactly as for AR/AP.

---

## 11. Reporting and reconciliation

| Report | Content | Source of truth |
| --- | --- | --- |
| **Asset register** | every asset: number, name (AR/EN), category, location, cost, additions, accumulated, NBV, status, in-service date, method, life, residual, Art. 17 group, VAT class | register + schedule |
| **Depreciation schedule** | per asset, per month: planned, posted (with `journal_entry_id`), remaining | schedule table |
| **Asset movement** (IAS 16.73(e) roll-forward) | per category: opening cost / additions / disposals / closing cost; opening accumulated / charge / disposals / closing; NBV | register events |
| **Depreciation expense** by period and category | GL | GL |
| **Additions / disposals** listing with proceeds and gain/loss | register + invoices/disposal docs | register |
| **Asset-to-GL reconciliation** (`ledgerInvariants.ts` rule) | Σ register cost per category = cost account balance; Σ accumulated per category = accumulated account; Σ posted schedule amounts = depreciation-expense postings; a disposed asset contributes zero | GL vs register — the forcing function the current model lacks |
| **Book vs tax** (only when FA-1 says yes) | Art. 17 pool report per group and year: opening balance, 50 % additions (2 years), 50 % disposals (2 years), rate, deduction, closing; the book-vs-tax difference per year | register |
| **VAT capital-asset schedule** | per capital asset: acquisition date, adjustment period end, input tax deducted, recovery %, use history, adjustments made, retention-until date | register + use history |
| **Zakat feed** | net fixed assets per category (Art. 49) — a GL figure once the accounts exist | GL |

---

## 12. Scope: included vs deferred

| Item | v1 | Why | Future compatibility |
| --- | --- | --- | --- |
| Category-bound accounts; asset master; straight-line monthly schedule; capitalisation via bill and via transaction; additions; estimate changes; disposal by sale (invoice) and scrap; reversal-based correction; period locks; migration step; register/schedule/movement/reconciliation reports; VAT Art. 52 facts stored; Art. 17 group stored; audit | **IN** | the accounting core of the module | — |
| Declining balance | OUT | IAS 16.62 allows it; no Saudi requirement for Zakat payers; ERPNext WDV/DDB and Odoo degressive exist | `depreciation_method` enum admits it; engine refuses; add the formula (rate × opening carrying amount per year, monthly ÷ 12 — ERPNext `get_wdv_depr_amount`) later |
| Units of production | OUT | IAS 16.62 allows; needs usage capture | enum value + a future `asset_usage` table; nothing in v1 blocks it |
| Daily prorata first/last period | OUT | policy, not law | per-company setting later; schedule generator takes the convention as a parameter |
| Component depreciation | OUT | **IAS 16.43 requires** separate depreciation of significant parts under full IFRS (IFRS for SMEs 17.6 likewise). For the SME scope, a significant-part split is rare (buildings' roofs/lifts, aircraft engines). | **Required compatibility:** a nullable `parent_asset_id` (self-reference) so a component is an asset with its own schedule under a parent; the movement report groups by parent. No column in v1 (no consumer — CLAUDE.md §3), added with the feature. |
| Revaluation model | OUT | IAS 16.31 is a **policy choice**, not a requirement; Zakat Art. 18 takes fair-value results if the statements show them; SMEs on the cost model are the target | a future `asset_revaluations` event table (surplus to OCI/equity); the model's event-sourced register accommodates it |
| Impairment | OUT | IAS 16.63/IAS 36 — a year-end judgement; no Saudi mechanical rule | an `impairment` event (Dr loss / Cr accumulated impairment) — same event table pattern |
| Assets under construction (CWIP) | OUT | Zakat Art. 49(5) deducts them; IFRS capitalises construction cost | a `CWIP` cost account on a category + a "complete → transfer to asset" act; v1 category model allows it |
| Inter-company / company transfer | OUT | an inter-company sale in substance (VAT, price) — accounting complexity the task warned against | a disposal in one company + acquisition in the other, by documents |
| Location / department / custodian transfer | IN (non-accounting) | audit and register value; ERPNext `Asset Movement` | a `asset_transfers` event table |
| Leases (IFRS 16 right-of-use) | OUT | a separate standard; Zakat Art. 49(6) mentions ROU assets | a category kind later |
| Held for sale (IFRS 5) | OUT | rare in scope | a status later |
| Asset insurance/maintenance | OUT | not accounting | — |

---

## 13. Data-model implications (design — NOT a migration)

Tenancy exactly as everything else: `organization_id` + `company_id` NOT NULL with defaults from the GUCs, RLS `tenant_isolation` with the N1 company arm, owner-only REVOKE pattern, system accounts seeded by the trigger (redefine `seed_org_chart_of_accounts()` — CLAUDE.md §4).

**`asset_categories`** (per company): `name`, `name_ar`, `cost_account_id`, `accumulated_depreciation_account_id`, `depreciation_expense_account_id` (each an FK into `categories` of the right type; a category cannot be saved without all three), `default_useful_life_months`, `default_method`, `default_residual_pct`, **`income_tax_group`** `1..5` (Art. 17(b), mandatory), **`vat_capital_asset_class`** `movable | immovable | not_capital` (Art. 52(2)), `is_active`.

**`fixed_assets`** (replaces the current columns): identity (`asset_number` unique per company, `name`, `name_ar`, `serial_number`, `description`); classification (`category_id` → `asset_categories`, `location`, `department`, `custodian_user_id` — all optional); dates (`acquisition_date` mandatory, `available_for_use_date` mandatory at capitalisation, `disposal_date`); money (`cost` at capitalisation, `residual_value` default 0, `useful_life_months`, `depreciation_method` enum, `opening_accumulated_depreciation`, `opening_periods_booked`); VAT (`vat_input_tax_amount`, `vat_initial_recovery_pct`, `vat_adjustment_period_years` derived 6/10/life, `vat_non_deductible_reason` nullable); tax (`income_tax_group` copied from the category at capitalisation — the group is a fact at acquisition, the category may change later); provenance (`source: bill | transaction | manual | migration`, `bill_id` / `transaction_id` / `migration_batch_id` / `source_reference`); state (`status: draft | in_service | disposed | cancelled`); `journal_entry_id` of the capitalisation entry. **Derived, never stored:** accumulated depreciation, NBV, "fully depreciated" (computed from posted schedule rows — the two-value-spaces defect of the current table, removed by construction).

**`asset_cost_additions`**: `asset_id`, `date`, `amount`, `description`, `source` (bill line / transaction), `vat_input_tax_amount`, `vat_recovery_pct`, `completion_date` (Art. 52(3) — its own adjustment clock), `journal_entry_id`.

**`asset_depreciation_schedule`** (replaces `depreciation_entries`): `asset_id`, `period` (`YYYY-MM`), `sequence`, `amount`, `accumulated_after`, `carrying_after`, `journal_entry_id` nullable (NULL = planned; set once = posted), **`unique(asset_id, period)`**; a trigger refuses UPDATE/DELETE on a row whose `journal_entry_id` is set (the invoice-prepayments freeze pattern, migration 0083).

**`asset_events`** (append-only): `asset_id`, `kind: capitalised | addition | depreciated | estimate_changed | transferred | disposed | reversed | vat_use_recorded | vat_adjusted`, `occurred_on`, `payload` (old/new values), `journal_entry_id`, `document ref`, `user_id` — the audit spine (§17), beside `audit_logs`.

**`asset_disposals`**: `asset_id`, `date`, `kind: sold | scrapped | destroyed | stolen | withdrawn`, `proceeds`, `invoice_id` (sale), `carrying_amount_at_disposal`, `accumulated_at_disposal`, `gain_loss`, `vat_treatment` (`taxable | out_of_scope_restricted_vehicle | nominal_supply`), `nominal_supply_value` (52(8)), `journal_entry_id`.

**`asset_vat_use_periods`**: `asset_id`, `period_no` (1..adjustment period), `period_start`, `period_end`, `actual_use_pct`, `adjustment_amount`, `return_period`, `journal_entry_id` — empty for fully-taxable tenants; the table exists so the Art. 52(4) computation has a home (FA-2 decides whether v1 computes it).

**Invoice line prerequisite:** `invoice_items` needs an optional **income account** (`account_id` of type income/other-income) and an optional `asset_id`, so a sale line credits `ASSET_DISPOSAL_GAIN_LOSS` and links the disposal — today every invoice line credits `SALES`. **Bill line prerequisite:** `bill_items.debit_account_id` may be an **asset-type** account with `creates_asset: true` (today refused unless expense).

**Company:** `tax_regime: zakat | income_tax | mixed` + `income_tax_share_pct` — a company fact the pool report and the Zakat feed both read.

**Chart:** four new system accounts (`ACCUMULATED_DEPRECIATION`, `DEPRECIATION_EXPENSE`, `ASSET_DISPOSAL_GAIN_LOSS`, and — deferred with CWIP — `CWIP`), Arabic names, `liquidity_class`, seeded by the trigger; `tests/org-seed-trigger.test.ts` compares column sets, not names.

**What is deliberately absent (no consumer in v1):** `parent_asset_id` (components), `revaluation`/`impairment` events, `usage` rows — each named in §12 with the shape it will take.

---

## 14. Accounting decision matrix

| # | Question | Authoritative source | Accounting treatment | Saudi Ledger treatment | Accountant decision required? | Data-model impact |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | What is an asset's cost? | IAS 16.16–20 | price + non-refundable taxes + directly attributable costs; not training/overheads | as IFRS; non-deductible VAT capitalised; additions as rows | No — **decided** | `cost`, `asset_cost_additions` |
| 2 | When does depreciation start? | IAS 16.55 | when available for use | `available_for_use_date`, full-month convention | No — decided (policy default; tenant may adopt daily prorata later) | `available_for_use_date` |
| 3 | Which methods in v1? | IAS 16.60–62 | SL / diminishing / UoP all permitted | straight-line only; others representable | No — decided | enum |
| 4 | Residual value and life changes | IAS 16.51 (IAS 8) | prospective estimate change | regenerate unposted rows; audited act | No — decided | `asset_events` |
| 5 | Zakat basis | Zakat Regs Art. 9, 17, 26(4), 48(1)(b), 49, 63(2) | book NBV deducted; book depreciation accepted | book basis only | No — **decided by the primary text** | none beyond §13 |
| 6 | Income-tax basis | Income Tax Law Art. 17, 18; Zakat Regs Art. 6(1) | pooled declining balance by group | group captured per category; pool report if needed | **YES — FA-1** (scope/eligibility of tenants; deferred-tax consequence) | `income_tax_group` (now); pool report (later) |
| 7 | VAT capital-asset regime — what to store | VAT IR Art. 52, 66 | adjustment period 6/10/life; annual adjustment on change of use; records +5 years | store all Art. 52 facts from day one; never hard-delete | No — decided by the primary text | §13 VAT columns, `asset_vat_use_periods` |
| 8 | VAT capital-asset regime — what to compute in v1; the sale-of-a-fully-recovered-asset reading; the nominal supply on withdrawal | VAT IR Art. 52(4)–(8), Art. 9 | as the Arabic text says | compute nothing in v1 for fully-taxable tenants; show the 52(8) value | **YES — FA-2** | whether `asset_vat_use_periods` gets a writer in v1 |
| 9 | Sale of an asset — VAT and revenue | VAT IR Art. 3(5), 50(3); IAS 16.68 | taxable supply; gain not revenue | invoice path with a disposal income account | No — decided | invoice line account + `asset_id` |
| 10 | Disposal month depreciation | IAS 16.55 | depreciate to derecognition | full month of disposal | No — decided (policy, consistent with #2) | — |
| 11 | Migrated assets | IAS 16; Batch 1C A4/A5 | opening cost + accumulated; continue schedule | opening journal lines; no plug; provenance | No — decided (A4/A5 already recorded) | opening columns, 1C asset step |
| 12 | Closed-period depreciation | CLAUDE.md §4 period locks | correction posts in the open period | refuse the run; catch-up in the open month, dated in the open month, labelled | No — decided by existing policy | schedule `period` vs entry `date` may differ (recorded) |
| 13 | Capitalisation threshold | none in IFRS (materiality) | policy | per-company setting, default 0 | No — decided | company setting |
| 14 | Component depreciation | IAS 16.43 | required when parts are significant | deferred; parent link later | No — decided (scope) | future `parent_asset_id` |
| 15 | Revaluation / impairment | IAS 16.31, 63 | optional policy / year-end judgement | deferred | No — decided (scope) | future event kinds |

"Decided" above means the primary text or an already-recorded accountant decision supports it; #6 and #8 are the only genuine open decisions found.

---

## 15. Accountant decisions required — and the Advance Payments dependency

🔴 **ACCOUNTANT DECISION REQUIRED — FA-1: the income-tax basis.** Do any of Saudi Ledger's target tenants (now or in the launch cohort) fall under the Income Tax Law — non-Saudi/non-GCC shareholdings (mixed companies), or non-residents' permanent establishments? If **yes**: v1 must produce the Article 17 group pool computation (per group: opening balance, 50 % of two years' additions and disposals, statutory rate, the SAR 1,000 write-off, Art. 18's 4 % repair cap) and the book-vs-tax difference, and the accountant must confirm (a) that the register's per-asset group assignment (Art. 17(b)) is the practice for the pool's composition and (b) whether deferred tax (IAS 12) is expected in the tenant's statements. If **no**: the group is still captured per category (cheap, from the law's list) and the pool report is deferred; Zakat payers use the book basis (Art. 63(2)) with no cap. *The research settles the treatment; only the eligibility of the customer base — and with it the v1 scope — is open.*

🔴 **ACCOUNTANT DECISION REQUIRED — FA-2: the VAT capital-assets regime in v1.** The Regulations (Art. 52) are read from ZATCA's English translation. Please confirm against the Arabic and practice: (a) for a **fully-taxable** business (no exempt supplies, recovery 100 %), no annual adjustment ever arises (52(6)) and the **sale** of a capital asset as a taxable supply requires **no** 52(7) adjustment (the use stays taxable through the remainder); (b) an asset **withdrawn** from the business while still usable is a **nominal supply** valued by the 52(8) formula, declared as output VAT in that period; (c) whether **partially-exempt** tenants (Art. 51 proportional deduction — e.g. residential lessors, financial services) are in Saudi Ledger's scope, which decides whether v1 must compute the annual adjustment or only store the facts. *The register stores every Art. 52 fact either way (§7); the decision is what v1 computes and files.*

**No other accountant decision was found.** Depreciation conventions (#2, #10, #13) are policies with stated defaults, recorded as product decisions the accountant may override per tenant; they do not block design.

🔴 **ADVANCE PAYMENTS — ACCOUNTANT DECISION PENDING (blocks Fixed Assets IMPLEMENTATION, not this research).** The question with the accountant: *if a taxable advance is received on one date and the Type 386 is issued later, which VAT return period carries the VAT, and what date should the 386 carry?* As built (advance-payments pack §14.1, §16.5): the Batch 1B receipt entry is unchanged and the VAT posts in the 386's own entry at the 386's date; the return files the 386 in its period. If the answer moves the VAT (or the 386's date) to the receipt's period, AP-2's posting date / return reading changes — **that correction is implemented before any Fixed Assets implementation begins.** The remaining migration/security-deposit questions (1C §16.14.9; advance-payments pack Z1) stay open and do not touch this module.

---

## 16. Implementation phases (proposed — not started)

| Phase | Scope | Gate |
| --- | --- | --- |
| **FA-0 — decisions** | FA-1, FA-2 answered; the AP VAT-period answer received and, if it changes AP-2, that correction merged first | owner + accountant |
| **FA-A — foundation** | the four system accounts (trigger, seed, column-set guard); `asset_categories`; the new `fixed_assets` shape; schedule table with the uniqueness and freeze trigger; `asset_events`; the invariant `assets_gl_vs_register`; the migration of the two existing tables (no customers — drop and recreate is acceptable; the e2e seed's impossible asset rows go with it) | `pnpm run verify`; zero-movement test for a draft asset |
| **FA-B — capitalise + depreciate** | bill line → asset (asset-type account + `creates_asset`); transaction → asset; manual asset; additions; schedule generation; monthly run (per asset and per company, idempotent, period-locked); estimate change; UI (register, asset page with schedule, run dialog) EN/AR × desktop/phone | tests §17 rows 1–8, 11–13, 16–17 |
| **FA-C — disposal** | invoice line income account + `asset_id`; sale through the invoice (VAT 15 %, gain/loss account, E1); scrap/write-off document (E2, VAT kinds); reversal-based correction | tests rows 9–10, 12 |
| **FA-D — migration** | the 1C asset step (opening cost + accumulated in the opening journal; reconciliation rule; VAT facts required inside the adjustment period) | tests row 14; a walked 1C migration with assets |
| **FA-E — reports** | register, schedule, movement, additions/disposals, asset-to-GL, VAT capital-asset schedule; Zakat feed wiring (when M17.3 lands) | contract-conformance on real rows |
| **FA-F — conditional** | Art. 17 pool report + book/tax reconciliation (if FA-1 yes); Art. 52 annual adjustment computation and return leg (if FA-2 says v1) | tests rows 5, 15, 18 |

Each phase closes with the standing check (CLAUDE.md §3) and a §2 status line; the record lives in this pack.

---

## 17. Audit trail (what must be immutable / auditable) and the future test matrix

**Immutable once posted:** the capitalisation entry and cost; every posted schedule row (trigger); every disposal; every opening asset line (A4). **Auditable acts** (each an `asset_events` row with old/new + `audit_logs`): acquisition/capitalisation, each addition, each depreciation run (asset, period, amount, entry), useful-life / residual / method changes (with the regenerated schedule's first affected period), transfers (location/department/custodian), disposal (kind, proceeds, gain/loss, VAT treatment), reversals (which entry, why), tax-group changes (only on a draft; after capitalisation the group is frozen — a change is a new act with reason), VAT use-period records and adjustments. Nothing is ever hard-deleted (Art. 66 retention).

**Test matrix (to be written with the implementation; expected results stated now):**

| # | Test | Expected accounting result |
| --- | --- | --- |
| 1 | Create a draft asset | nothing posts; every report unmoved (zero-movement standard) |
| 2 | Capitalise via a bill (net 100,000 + VAT 15,000) | `Dr Asset cost 100,000 · Dr VAT_INPUT 15,000 / Cr AP 115,000`; register cost 100,000; NBV 100,000; input-tax facts stored (15,000, 100 %) |
| 3 | Capitalise a restricted motor vehicle (VAT blocked) | `Dr Asset cost 115,000 / Cr AP 115,000`; `vat_input_tax_amount 0`, reason recorded |
| 4 | Capitalise via a bank transaction | `Dr Asset cost / Cr Bank(named account — D-3)`; one register row linked to the transaction |
| 5 | VAT capital-asset facts | adjustment period = min(6 or 10, accounting life in whole years); retention date = acquisition + period + 5 y; a use-period row per 12 months exists with `actual_use_pct` defaulting to the initial %; (FA-2) the annual adjustment = 0 when unchanged, ≠ 0 when the use changes, posted in the last tax period of the 12-month window |
| 6 | Straight-line schedule (100,000, residual 10,000, 48 months, in service 15 Mar) | 48 rows, Mar Y1 … Feb Y5, 47 × 1,875.00 and a last row absorbing rounding; Σ = 90,000; carrying after the last row = 10,000 |
| 7 | Monthly run | per asset per period: `Dr DEPRECIATION_EXPENSE / Cr ACCUMULATED_DEPRECIATION` amount; the row's `journal_entry_id` set; a second run for the same period **refused** (409) with nothing posted; the invariant `Σ posted rows = expense postings` holds |
| 8 | Partial-period / migrated asset (opening accumulated 30,000, 16 periods booked) | schedule starts the month after the opening date with 32 rows over the remaining 60,000 depreciable amount |
| 9 | Full depreciation | after the last row: accumulated = cost − residual; further runs refused (`asset_fully_depreciated`); status derived "fully depreciated"; still on the balance sheet |
| 10 | Disposal by sale (proceeds 25,000 + VAT 3,750; carrying 20,000) | invoice: `Dr AR 28,750 / Cr VAT_OUTPUT 3,750 · Cr GAIN_LOSS 25,000`; derecognition: `Dr ACCUMULATED 80,000 · Dr GAIN_LOSS 20,000 / Cr Asset cost 100,000`; net gain 5,000 in **other income**, `SALES` unmoved; VAT return box 1 +25,000 / box 6 +3,750; a 388 from real rows PASSES the sandbox |
| 11 | Scrap (carrying 20,000, no proceeds) | `Dr ACCUMULATED 80,000 · Dr GAIN_LOSS 20,000 / Cr Asset cost 100,000`; loss 20,000; `withdrawn` kind computes the 52(8) nominal-supply value and (FA-2) its VAT |
| 12 | Closed period | a run, a capitalisation or a disposal dated into a closed month → 423 with nothing posted; the catch-up run posts in the open month, dated in the open month, the schedule `period` unchanged and the entry labelled |
| 13 | Correction / reversal | reversing a posted run: mirror entry today, the row's amount re-planned (a new row for the same period is allowed only after the reversal); accumulated and NBV move back; the audit chain names both entries |
| 14 | Migration | opening journal carries `Dr Asset cost 100,000 / Cr ACCUMULATED 30,000` within a balanced position; no equity plug; an unbalanced position is refused; the register reconciles to the mapped TB (R-rule) |
| 15 | Tax basis (if FA-1) | group 3 pool: opening 0; year-1 additions 100,000 → balance 50,000 × 25 % = 12,500; year-2: (37,500 + 50,000) × 25 % …; a disposal for 25,000 reduces the pool by 12,500 in each of two years; a balance < 1,000 written off |
| 16 | Multi-company / tenant isolation | presence in company A, absence in company B, and B showing its own asset (movement); RLS on every new table; FK existence-oracle audit |
| 17 | Audit trail | every act above leaves an `asset_events` row and an `audit_logs` row naming the entry |
| 18 | GL reconciliation | `ledgerInvariants` `assets_gl_vs_register` passes after every scenario and FAILS on a planted mismatch |
| 19 | Book/tax reconciliation (if FA-1) | book depreciation vs pool deduction per year, the difference explained to the halala |

---

## 18. Sources

**Authoritative — Saudi (primary texts read in this pass):**
- VAT Implementing Regulations (ZATCA Board resolution 3839, Eighth Edition 09/11/2021, ZATCA English translation — Arabic prevails): Art. 3(5), 15(3)–(4), 49–52, 66 — `docs/zatca/specs/KSA_VAT_Implementing_Regulations_EN.txt` (checksum-pinned, `docs/zatca/README.md`).
- Income Tax Law (Royal Decree M/1, 15/1/1425H), Articles 2, 17, 18, 81 — English text as deposited by KSA with the WTO: https://www.wto.org/english/thewto_e/acc_e/sau_e/wtaccsau59a2_leg_8.pdf (the ZATCA-hosted Implementing Regulations PDF, https://zatca.gov.sa/en/RulesRegulations/Taxes/Documents/Regulations_of_Income_Tax.pdf, is Arabic with a non-extractable font — not read; a reading of its Article 9 depreciation clarifications is a follow-up for FA-1 if it says yes).
- Implementing Regulations for Zakat Collection 1445H (Minister of Finance Decision 1007 dated 19/08/1445H, amended by 1248 dated 11/10/1446H), ZATCA English text: https://zatca.gov.sa/en/RulesRegulations/Documents/ZAKAT%20COLLECTION.pdf — Art. 6, 9, 15, 17, 18, 20, 26, 27, 48–52, 63.
- ZATCA guideline PDFs "Zakat General Simplified Guideline" and "Modification of the Activity Result for Zakat Purposes" — linked from search but **404 on 2026-09-21**; not read.

**Standard (IFRS):** IAS 16 *Property, Plant and Equipment* (IFRS Foundation 2021 issued text, https://www.ifrs.org/content/dam/ifrs/publications/pdf-standards/english/2021/issued/part-a/ias-16-property-plant-and-equipment.pdf) ¶7, 16–20, 29–31, 43–44, 50–55, 60–63, 67–68, 71, 73; IAS 8 (estimates), IAS 36 (impairment), IFRS 5 (held for sale), IAS 12 (deferred tax) — cited by name, not read in this pass; IFRS for SMEs §17 — cited by name (SOCPA endorsement), not read.

**Odoo (`github.com/odoo/odoo`):** `account_asset` exists in the community repository up to branch **11.0** (removed from 12.0 onward — Enterprise only): `addons/account_asset/models/account_asset.py` (11.0) — `account.asset.category` (three accounts + journal, `method linear|degressive`, `method_number`, `method_period`, `prorata`, `open_asset`), `account.asset.asset` (`state draft|open|close`, `salvage_value`, `_compute_board_amount` — prorata by days in the first month/year, the **last line takes the residual**, `set_to_close` — disposal by posting the full residual as one final depreciation line, i.e. no proceeds/gain-loss computation in the community module).

**ERPNext (`github.com/frappe/erpnext`, `develop`):** `erpnext/assets/doctype/asset/asset.json` (fields incl. `available_for_use_date`, `opening_accumulated_depreciation`, `opening_number_of_booked_depreciations`, `finance_books`, `status` options); `asset/asset.py` (`get_status`, `validate_*`); `asset/depreciation.py` (`post_depreciation_entries` scheduled, JE per asset `Dr expense / Cr accumulated` via `get_credit_and_debit_accounts`, frozen-date handling via `accounts_frozen_till_date`, `scrap_asset`/`restore_asset`, `get_gl_entries_on_asset_disposal`: credit cost, debit accumulated, gain/loss = proceeds − value after depreciation to the company `disposal_account`); `asset_depreciation_schedule/depreciation_methods.py` (straight line = depreciable value ÷ pending periods; `daily_prorata_based`; WDV/DDB yearly rate × pending amount ÷ 12 per month); `asset_category_account.json` (fixed_asset, accumulated_depreciation, depreciation_expense, CWIP per company); `asset_finance_book.json` (method, total depreciations, frequency, start date, expected value after useful life, rate, `daily_prorata_based`, `shift_based`) — **the Finance Book is ERPNext's "second basis" mechanism**; the module also carries `asset_movement`, `asset_value_adjustment`, `asset_repair`, `asset_capitalization`, `asset_shift_allocation`.

**Saudi Ledger:** `packages/db/src/schema/assets.ts`; `apps/api/src/services/assets.service.ts`; `bills.approvable.ts` (`resolveExpenseLine`); `invoices.approvable.ts` (`SALES` lines); `services/accounting/periodLock.ts`; `journalEntries.service.reverse`; `docs/history/erpnext-comparison-2026-09-03.md` §6; `docs/product/design-zakat-module.md` §4; `docs/product/batch-1c-migration-opening-balances-decision-pack.md` §16.12 (A4/A5); `docs/product/advance-payments-decision-pack.md` §14, §16.

---

## 19. FIXED ASSETS IMPLEMENTATION STATUS

- **Research complete:** YES — one pass; §18 lists what was read and the two ZATCA guideline PDFs that were not (404).
- **Data model ready:** YES, subject to FA-1 (whether the pool report and a company tax-regime fact are v1) and FA-2 (whether `asset_vat_use_periods` gets a writer in v1) — both are additive to the §13 shape, which stores every required fact from day one either way.
- **Accounting model ready:** YES (§3 entries; IAS 16 + Zakat Regs; disposal through the invoice path with a line-level income account as the one prerequisite change to an existing document).
- **Saudi VAT requirements established:** YES for what must be stored (Art. 52, 66); the v1 computation scope and two readings of the translation are FA-2.
- **Book/tax depreciation treatment established:** YES — Zakat = book basis (Art. 48, 63(2)); income tax = Art. 17 pooled groups; the customer-eligibility question is FA-1.
- **Accountant decisions outstanding:** ~~FA-1, FA-2~~ — **both ANSWERED 2026-09-22**: FA-1 YES (the Art. 17 pool is computed separately — groups, rates, additions, disposals, the 50 % rules, the movement and the report; the Zakat base stays the book basis); FA-2 YES (the Art. 52 annual adjustment is computed in v1 — 12-month periods, positive and negative adjustments, disposal and deemed supply, partially-exempt tenants; improvements as separate adjustment clocks; reproducible).
- **Implementation blocked by those decisions:** NO — FA-0 closed 2026-09-22; FA-A built (§20).

~~**ADVANCE PAYMENTS — ACCOUNTANT DECISION PENDING.**~~ Answered 2026-09-22 (the tax point is the receipt; AP-2's 386 is dated at the receipt) and built first — advance-payments pack §17. Fixed Assets implementation began after it.

---

## 20. FA-A — the foundation as built (2026-09-22)

**Status (2026-09-22): BUILT on `feat/fixed-assets-foundation` (migrations `0087` + `0088`). Current state authority: [CLAUDE.md §2](../../CLAUDE.md).**

### 20.1 What exists

- **Three system accounts** (`ACCUMULATED_DEPRECIATION` asset/non-current · `DEPRECIATION_EXPENSE` expense · `ASSET_DISPOSAL_GAIN_LOSS` income — IAS 16.68, never `SALES`) in the one TypeScript definition, the SQL template, the org-seed trigger (new orgs) and the backfill (every existing org). The cost account is the category's own choice (the M15 default `FIXED_ASSETS` or any asset-type posting account).
- **`asset_categories`** — the account triple (typed and checked at the service: cost and accumulated are asset accounts, expense an expense account, headers refused) + `income_tax_group` 1–5 (Art. 17(b); the rate is one definition, `INCOME_TAX_GROUPS`) + `vat_capital_asset_class` (Art. 52(2)) + the defaults (life, method, residual %). A category's identity (group, class, accounts) changes only while nothing is under it (`asset_category_in_use`).
- **`fixed_assets`** — the §13 shape: identity, classification, dates (`acquisition_date` the Art. 52 clock; `available_for_use_date` mandatory at capitalisation), the book basis (cost, residual, life in MONTHS, method), the migrated opening position, the VAT facts (`vat_input_tax_amount`, `vat_initial_recovery_pct`, class, `vat_non_deductible_reason` — required when a capital asset's recovery is 0 %), the Art. 17 group copied from the category, provenance (`manual | bill | transaction | migration` + ids), `status` (`draft | in_service | disposed | cancelled`), the capitalisation entry. **Derived, never stored:** accumulated depreciation, carrying amount, "fully depreciated" — computed from the POSTED schedule rows + the opening position, in one SQL expression the list, the detail and the totals share.
- **`asset_depreciation_schedule`** — one row per (asset, period) (`unique`), `journal_entry_id` NULL = planned / set = posted; the trigger `refuse_posted_depreciation_change` freezes a posted row (no UPDATE; DELETE refused for every role but the table owner, whose only legitimate delete is purging an organisation); a planned row may be re-planned or removed.
- **`asset_events`** — the append-only audit spine (the app role holds neither UPDATE nor DELETE; the owner is bound against UPDATE); every act writes a row beside `audit_logs`.
- **Frozen facts of record** — `refuse_capitalised_asset_fact_change`: once in service the cost, dates, provenance, group, class, VAT facts, category, number and entry cannot change (descriptive fields and the estimate may; the estimate-change act of FA-B regenerates the unposted tail); a cancelled draft and a disposed asset are frozen whole. `fixed_assets_state_chk` ties `in_service` to an available-for-use date and a posted entry, `disposed` to a disposal date.
- **The schedule engine** (`services/assets/depreciationSchedule.ts`, pure): straight-line monthly, full-month convention, ONE rounded addend per row, the last row absorbs the residue (Σ exact, carrying after the last row = residual); a migrated asset resumes its life the month after the opening date; `declining_balance` / `units_of_production` admitted by the schema and REFUSED by name (`depreciation_method_unsupported`).
- **`companies.foreign_ownership_pct`** — the income-tax share, read WITH `ownership_type` (the existing Zakat-gate fact — one fact, not two): SAUDI_GCC ⇒ 0, FOREIGN ⇒ 100, MIXED ⇒ strictly between, NULL = not declared (a CHECK pins it). The Art. 17 pool report (FA-F) reads it.
- **API** — `GET/POST /asset-categories`, `PUT /asset-categories/{id}`; `GET /assets` (page + totals over every asset, derived), `POST /assets` (a DRAFT — the zero-movement standard), `GET /assets/{id}` (schedule, the PLANNED preview of a draft, events), `PUT /assets/{id}`, `POST /assets/{id}/cancel`. The pre-FA `POST /assets/{id}/depreciate` (a register-only mutation that never touched the GL) is GONE; the run returns in FA-B through `postJournalEntry`.
- **Ledger invariants** — `asset_schedule_entry_shape` (a posted row IS its entry: Dr the category's expense / Cr its accumulated, the row's amount, nothing else) and `asset_state_evidence` (an asset in the books carries a posted capitalisation entry; every asset carries its `created` event).
- **UI** — the register and the schedule pages read the new shape (derived figures, the Art. 17 group and rate, the Art. 52 class and period); a category dialog and a draft-asset dialog. The clicked walk in four modes is FA-B's, when there is an act to click.

### 20.2 Verified

`tests/fixed-assets-foundation.test.ts` (10): the schedule arithmetic (pack §17 rows 6 and 8, the rounding case), the system accounts on a new and every old org, the category defaults and refusals, the draft's zero movement (trial balance and income statement unchanged; totals count a draft, not cost), the DB guards exercised AS THE APP ROLE with raw SQL (unique period → 23505; posted row frozen on UPDATE and DELETE → `depreciation_posted_frozen`; planned row re-plannable; `posted_at`/`journal_entry_id` travel together; events 42501; register never hard-deleted 42501), the frozen facts (eight statements refused by name; descriptive and estimate allowed), cancel-never-delete (the number stays taken), the company share CHECK. `ledger-contract-conformance.test.ts` parses every new response against the generated Zod on real rows. `pnpm run verify` green.

### 20.3 What this did not do (FA-B onwards)

Capitalisation from a bill line, a transaction or by hand (the entry, the stored schedule, `in_service`); the monthly run per asset and per company; the estimate change; additions; disposal (invoice-line income account + `asset_id`); the migration step; the Art. 17 pool and the Art. 52 engine; the reports; the four-mode walk. The pre-FA register's rows were DROPPED (no customers; §16 FA-A gate) — the e2e seed now creates a category and a draft.

---

## 21. FA-B — capitalisation, the monthly run and the estimate change, as built (2026-09-22)

**Status (2026-09-22): BUILT on `feat/fixed-assets-capitalisation` (migration `0089`). Current state authority: [CLAUDE.md §2](../../CLAUDE.md).**

### 21.1 Capitalisation runs on the BILL (entry A1)

`bills.capitalises_asset_id` names the DRAFT asset a vendor bill buys. At approval — inside the bill's own transaction, through its own `postJournalEntry` call — the debit line becomes the asset CATEGORY's cost account (labelled with that account's own NAME, never a literal: the balance sheet groups by the label, and a literal would file the cost under a name the chart does not have — caught by the balance-sheet assertion in the suite), and the asset becomes `in_service` on that entry with its whole schedule stored and a `capitalised` event. **One writer, one effect**: there is no second path to the cost account, and if the capitalisation throws, the bill does not post.

**Non-deductible input VAT is CAPITALISED** (IAS 16.16, VAT IR Art. 50): when the asset's recovery is 0 % — a restricted motor vehicle — the bill posts `Dr cost (gross) / Cr AP` with **no** `VAT_INPUT` line. The asset's recovery %, not the bill, decides this.

Refused by name, with nothing posted: `asset_not_draft` (an asset in service takes ADDITIONS, not a second capitalisation — FA-C), `available_for_use_date_required` (IAS 16.55: without it there is no first period), `asset_cost_mismatch` (the asset's declared cost and what the bill capitalises must state the same amount — the message prints both), `depreciation_method_unsupported`.

### 21.2 The monthly run (entry D)

`POST /assets/{id}/depreciate` posts one schedule row: `Dr <category expense> / Cr <category accumulated>` for the ROW's amount, dated the period's last day, and marks the row posted (`journal_entry_id` set once — then frozen by FA-A's trigger). `POST /assets/depreciation-runs` does a whole period for the company: one entry per asset, and every asset that did not post is **reported with its refusal's own code and sentence** — never a silent skip.

- **A period is depreciated ONCE** — `depreciation_already_posted` (the table's unique is the backstop).
- **In order** — `depreciation_out_of_order`: the accumulated figure each row states is the figure in the books, so the rows post in sequence.
- **A closed month FAILS CLOSED** (423 `period_closed`) with nothing posted. The catch-up passes an explicit `postingDate` in an OPEN month: the same amount, the schedule row's period unchanged, and the entry's description saying which period it depreciates — CLAUDE.md §4's standing rule (never re-date into a closed period, never silently skip). A catch-up dated BEFORE its period is refused. A company-wide run stops whole on a lock (it is one act on one company's books).

### 21.3 The estimate change (IAS 16.51, IAS 8)

`POST /assets/{id}/estimate` changes the residual value, the useful life or the method **prospectively**: the posted rows are never touched (the DB would refuse it anyway), the unposted tail is deleted and regenerated from the remaining carrying amount over the remaining life, and the act is audited with old and new plus the first affected period. A life at or below what is already booked is refused (`useful_life_below_booked` — that is an impairment or a disposal, not an estimate change); a residual above the remaining carrying amount is refused; an unchanged estimate is refused. Nothing posts.

### 21.4 Verified

`tests/fixed-assets-capitalisation.test.ts` (7, real rows, the pack's own §17 expectations): row 2 (the bill's three lines exactly, the expense accounts unmoved, 48 rows stored, the asset in service on that entry, and three named refusals leaving nothing posted), row 3 (the restricted vehicle's VAT capitalised, `VAT_INPUT` unmoved), row 7 (the run's two lines, the derived figures moving, the second run and the out-of-order run refused with the entry count unchanged, and Σ posted rows = the expense postings), row 12 (423 with nothing posted, then the catch-up in an open month naming the period), the estimate change (posted rows byte-identical, the tail 34 rows, Σ still the depreciable amount, the event's payload), the company-wide run (one entry per asset, the income statement moving by exactly the run's total, a second run posting nothing), and row 9 (carrying = residual, fully depreciated, a further run refused, both accounts still on the balance sheet).

`e2e/fixed-assets.spec.ts` (6) walks it by CLICKING in four modes: the category and the draft (which moves nothing), the bill that capitalises it (the entry's lines read back from the API), the run (the row reads posted and links to its entry), the estimate change, Arabic/RTL, and a 390-px phone. `pnpm run verify`: green.

### 21.5 What this did not do

Additions to an asset in service (a further cost with its own Art. 52(3) adjustment clock); capitalisation from a bank transaction or by hand (the pack's A2 — a bill is the one path today, and an asset with no document is possible only through migration); disposal (FA-C); the migration step (FA-D); the reports (FA-E); the Art. 17 pool and the Art. 52 engine (FA-F, both now in scope by the accountant's answers). `declining_balance` and `units_of_production` remain refused by name.

---

## 22. FA-C — disposal, as built (2026-09-22)

**Status (2026-09-22): BUILT on `feat/fixed-assets-disposal` (migration `0090`). Current state authority: [CLAUDE.md §2](../../CLAUDE.md).**

### 22.1 Two doors, one derecognition

A **SALE** is an ordinary tax invoice of this product that NAMES the asset (`invoices.disposes_asset_id`). Its revenue line credits `ASSET_DISPOSAL_GAIN_LOSS` instead of `SALES` — IAS 16.68: the result of a disposal is not revenue — and approval derecognises the asset **on that same entry**:

```
Dr Accounts receivable        gross
   Cr Disposal gain/loss      net proceeds
   Cr VAT payable             the VAT (a taxable supply, Art. 3(5))
Dr Accumulated depreciation   everything posted to date
Dr Disposal gain/loss         the carrying amount
   Cr Asset cost              the cost
```

Net of the two, the account holds `proceeds − carrying amount` (IAS 16.71). **`SALES` does not move** — asserted.

A **SCRAP / DESTRUCTION / THEFT / WITHDRAWAL** is `POST /assets/{id}/dispose`: the derecognition alone, no proceeds, the carrying amount a loss.

**Depreciation runs up to the disposal month FIRST** (IAS 16.55 — it ceases at derecognition, not before): each outstanding period posts its own entry through the ordinary run, under its own period lock, and the act reports them. A closed month therefore stops a disposal, by the same rule and with the same remedy. Afterwards the unposted tail is gone, and the invariant `asset_no_depreciation_after_disposal` holds it.

### 22.2 The Saudi VAT consequence is a fact of the KIND

| kind | `vat_treatment` | text |
| --- | --- | --- |
| sold | `taxable_supply` | Art. 3(5) — an ordinary taxable supply on its own tax invoice |
| sold, a restricted motor vehicle bought without deduction | `out_of_scope_restricted_vehicle` | Art. 50(3) — not in the course of an economic activity. 🔴 A VAT-bearing invoice for such an asset is **REFUSED** (`restricted_vehicle_sale_out_of_scope`) with nothing posted; at zero VAT it sells and `VAT_OUTPUT` does not move. |
| scrapped · destroyed · stolen | `no_adjustment` | Art. 52(7) — "no adjustment … if the Capital Asset is destroyed, stolen, or ends its life earlier than accounted for" |
| withdrawn while still usable | `nominal_supply` | Art. 52(8) — a nominal supply valued `purchase value × initial recovery % × remaining useful life ÷ adjustment period`, in WHOLE years (52(2): part years count as one). The value is **computed and stored**; whether v1 declares it is the Art. 52 engine's business (FA-2), and storing a number is not declaring it. |

### 22.3 Terminal by construction

`asset_disposals` holds one row per asset (unique), never updated or deleted by the app (REVOKE) and frozen against the owner's UPDATE by trigger; the asset becomes `disposed` and FA-A's freeze then refuses every change to it. A second disposal is refused by name. A correction is a REVERSAL of the entry and a new act — never an edit. The `invoices_disposes_asset_unq` index binds ISSUED invoices only: a draft that names an asset has disposed of nothing, and a refused approval must leave the corrected invoice enterable.

### 22.4 Verified

`tests/fixed-assets-disposal.test.ts` (5, real rows): the Art. 52(8) arithmetic (including the whole-year rule, a zero past the period, a zero recovery and a non-capital asset); pack §17 row 10 — the sale's SIX lines in one entry, `SALES` unmoved, the disposal account holding the 5,000 gain, the VAT return filing 95,000 in box 1 and 14,250 in box 6, then the terminal refusals and the two frozen rows; row 11 — the scrap, its three lines, the 57,000 loss, `VAT_OUTPUT` unmoved, the three periods depreciated first and the event chain; the withdrawal storing 12,000 of nominal supply with the act-level refusals; and the restricted vehicle refused with VAT (nothing posted) then sold out of scope.

`e2e/fixed-assets.spec.ts` grew a seventh leg: the scrap walked by clicking, the hint that a withdrawal is a nominal supply, the derecognition's lines read back, and the acts disappearing once the asset is terminal. Invariants: `asset_disposal_shape` and `asset_no_depreciation_after_disposal`. `pnpm run verify`: green.

### 22.5 What this did not do

Partial disposal of a component (out of scope, §12); the Art. 52(7) adjustment ARITHMETIC on a sale inside the adjustment period (the FA-2 engine, now in scope by the accountant's answer — the facts it needs are all stored); the nominal supply's own VAT declaration; a disposal of a MIGRATED asset (FA-D brings those into the register first).

---

## 23. FA-D — migrated fixed assets, as built (2026-09-22)

**Status (2026-09-22): BUILT on `feat/fixed-assets-migration` (migration `0091`). Current state authority: [CLAUDE.md §2](../../CLAUDE.md).**

### 23.1 A staging set beside the others — and NO journal line

`migration_assets` joins parties, open items and advances as a Batch 1C staging set: the previous system's assets with their original cost, the accumulated depreciation it had booked, over how many periods, the life and method, the VAT Art. 52 facts and an EXISTING asset category by name (which carries the accounts, the Art. 17 group and the Art. 52 class).

🔴 **A migrated asset posts nothing of its own.** Its cost and accumulated depreciation are already in the staged trial balance — A5: one balanced opening position, never a plug — so the register **reconciles** to the accounts its categories name, exactly as open items reconcile to AR/AP:

- **`FIXED_ASSETS_CONTROL`** — Σ register cost = the mapped cost accounts, Σ opening accumulated = the mapped accumulated accounts. Its detail names both figures and says a migrated asset adds no line, so the remedy is to stage the missing asset or correct the chart row, never a balancing entry.
- **`FIXED_ASSETS_WELL_FORMED`** — the category exists and is active, the asset was in service by the opening date (one that entered service later is BOUGHT in the product, not migrated), the method is computable, and an asset still inside its Art. 52 adjustment period carries its input-tax facts (or the adjustment could never be computed).

🔴 **The control fires when EITHER side is non-zero.** Gating it on "some asset is staged" made the dangerous case — asset balances in the trial balance with an EMPTY register — silent, and a silent control reads as a pass. Found by the browser walk, whose first act is to validate before staging anything: the same confident-zero shape the mapped side had, when it derived the account set from the staged rows instead of from every asset category.

### 23.2 At commit

Each staged asset becomes a register row: `source = migration`, the batch and source id as provenance, `in_service` with the **opening journal** as its capitalisation entry, its opening accumulated depreciation and periods recorded, and its schedule **resuming the month after the opening date** over the remaining life at the right sequence (a 50-month asset with 20 booked resumes at sequence 21 with 30 rows). A `capitalised` event records the migration's own facts. Nothing is depreciated retrospectively, and no second journal entry exists.

### 23.3 A defect this phase surfaced in the migration mapper

The chart mapper's two doors disagreed with the server: `map_to_system` **offered** accounts the server refuses (a seeded default that merely carries a code, such as `FIXED_ASSETS`), while `merge_into` **hid** exactly those accounts, which the server accepts. An old "Equipment at cost" row therefore had no reachable target at all — a control that leads only to a refusal, and a capability with no control. Fixed at the source: the categories read now states `isPlatformSystemAccount` (computed from `SYSTEM_ACCOUNTS`, one definition), and both client filters key on it.

### 23.4 Verified

`tests/fixed-assets-migration.test.ts` (3, real rows): the control passing on the true position, FAILING when the register understates it, and passing again — presence, absence and movement — with no opening-balance-equity account anywhere; the named refusals (in service after the opening date, an unknown category, inside the adjustment period without its VAT facts, accumulated above the depreciable amount, a 0 % recovery with no Art. 50 reason); and pack §17 row 14 end to end — the opening journal's two asset lines from the trial balance, the register row in service on that entry, the schedule resuming at sequence 25 of 48, the next monthly run posting it, and the staging row frozen afterwards.

The migration workspace walk gained the whole leg: the chart now carries asset balances, the control is seen FAILING before the assets are staged, the section imports them, and after the commit the register row is read back (in service, on the opening entry, 30 planned periods, sequence 21). `pnpm run verify`: green.

### 23.5 What this did not do

A migrated asset's DISPOSAL inside the same batch's reversal (the batch reversal mirrors the opening journal; the register rows it created are not yet reversed with it — recorded here as the next FA-D follow-up); assets under construction; the Art. 52 use-history rows for a partially exempt tenant (FA-F); the pool report's opening balances for a migrated tenant (FA-F reads the register, which now holds them).

**A gap this phase EXPOSED, not caused (recorded, not fixed here).** The mapper
regression was caught by a unit test, not by the compiler: `apps/web`'s
`tsconfig.json` excludes `**/*.test.ts`, so **the web unit tests are outside
`pnpm run typecheck`**. Adding a required field to a response type therefore
cannot fail a web test file that builds a fixture without it — the fixture just
carries `undefined` and the function under test returns a confident empty list.
Probed on 2026-09-22 by typechecking with the exclusion removed: the backlog is
in `openInvoice.test.ts`, `statementParser.test.ts` and their neighbours (string
literals where the generated types now say `number`), which is why the exclusion
is still there. Closing it is a standalone cleanup, and it belongs on the queue
rather than inside a fixed-assets PR.

---

## 24. FA-E — the Income Tax Law Art. 17 pool, as built (2026-09-22)

`AUTHORITATIVE (Saudi)` for every rule; `PRODUCT DECISION` for how the missing
inputs are obtained. Accountant FA-1: the pooled income-tax depreciation **is**
in scope and is computed **separately** from the book basis.

### 24.1 The primary text was read in this pass, and it settled the open question

The Income Tax Law (Royal Decree M/1, 15/1/1425H) was fetched and read directly
— the English text as deposited with the WTO, whose Arabic prevails. Art. 17(e)
answers the one question §8.3 left implicit, in terms:

> "…and fifty percent (50%) of the cost base of assets **in use** added to the
> group in the current and previous taxable years after the deduction of fifty
> percent (50%) of the compensation received from the assets disposed of during
> the current and previous taxable years, provided that the balance does not
> become in the negative."

**"assets IN USE added"** — so an asset enters its pool in the tax year it became
**available for use**, not the year it was bought, which Art. 17(a) corroborates
("wholly or partly used in the generation of taxable income"). The register has
stored both dates since FA-A, so the two readings are distinguishable and this
one is the text's. A fixture whose purchase and in-service dates straddle a year
end pins it (`income-tax-pool.test.ts`).

Three further precisions the condensed §8.3 table did not carry:

| Article | What the text actually says | Consequence here |
| --- | --- | --- |
| 17(h) | the balance is compared to SAR 1,000 **"after allowing for the deduction in accordance with paragraph (d)"** | the threshold is tested on the POST-deduction balance, not the year-end balance |
| 17(h), 17(i) | both say the amount **"MAY be deducted"** | they are ELECTIONS. The engine computes what is available and does **not** take it |
| 17(g) | "regardless of the amount of such compensation, the value of the group shall be reduced to zero and the excess is included in the taxpayer's taxable income" | the excess is an income figure, reported by name — never a negative pool and never a deduction |

### 24.2 A report over the register, with exactly two declared inputs

Nothing about the pool is stored, for the reason the VAT return is not stored: a
second value space beside the rows that produce it drifts. `computePoolYear`
(`services/assets/incomeTaxPool.ts`) is **pure** — every input is passed in — and
`incomeTaxPool.service.ts` is the part that knows about companies, fiscal years
and rows. The tax year is the company's own fiscal year through `lib/fiscalYear.ts`
(Art. 22(a)–(b) takes the taxpayer's twelve-month period); there is no second
definition of a year.

Two inputs are **not** in the register, and `asset_tax_pool_declarations` is
where the taxpayer states them. Neither is ever assumed:

1. **The opening ANCHOR.** A group's balance at the end of an already-filed year
   is a fact of the taxpayer's own return — a declining-balance figure no book
   register can produce, and Art. 81(a) puts pre-Law assets in at cost less
   depreciation previously allowed. Without one the report returns
   `anchor_not_declared` and computes nothing. A company with no pool history
   declares a **nil** anchor, which is an ACT and is audited as one. The anchor
   carries its own year's additions and disposals too, because Art. 17(e) reaches
   back one year — and derivation then starts strictly AFTER the anchor year, so
   the same addition can never be counted twice.
2. **Art. 18 repairs.** Repair and improvement expenditure is deductible up to
   4 % of the group's year-end balance and the excess is ADDED to the pool. The
   platform cannot attribute repair expense to an Art. 17 group — it is ordinary
   expense in the GL, not an asset — so the taxpayer declares the year's figure
   per group and the engine does the Art. 18 arithmetic. **Undeclared reads
   UNDECLARED**, never zero, on the report and on the page.

**Order of operations, and why.** 17(e)/17(g) first (the balance, or the excess);
then Art. 18; then 17(d)'s rate; then the elections, because 17(h) is defined on
the post-(d) balance. Art. 18(b)'s cap is "4 % of the balance … at the end of
that year", which is circular once 18(c)'s excess is added to that balance — so
the cap is taken on the Art. 17(e) balance **before** the add-back. *Reasoned-
not-verified*: the alternative reading yields a slightly larger cap and is not
derivable from the English text, so the smaller, non-circular base is used and
the choice is stated on the report itself.

### 24.3 Four refusals, each naming the act that resolves it

| `status` | When | Why not a figure |
| --- | --- | --- |
| `regime_not_declared` | the non-Saudi/non-GCC share is NULL | Art. 17 applies only to persons subject to the Income Tax Law (Art. 2; Zakat Regs Art. 6(1) mirrors it). Assuming 0 hides the regime from a taxpayer who owes it; assuming otherwise invents a tax for a Zakat payer |
| `not_applicable` | the share is 0 % | a Zakat payer has ONE basis and it is the book basis (Zakat Regs Art. 48(1)(b), 63(2)) |
| `fiscal_year_not_declared` | no fiscal year | there is no taxable year to compute over (Art. 22) |
| `anchor_not_declared` | no anchor | §24.2 |

### 24.4 🔴 A column with no writer, found by its own reader

`companies.foreign_ownership_pct` has existed since FA-A and **nothing wrote
it**. The pool READS it — so the refusal above would have told the tenant to
declare the share in Company Settings, where no such control existed: a refusal
that hides the control, which is worse than no refusal. FA-E adds the writer
(Company Settings, `PATCH /companies/current`, spec + generated types), and it
is checked **against** `ownershipType` because the Law reads them together:
SAUDI_GCC means 0 %, FOREIGN means 100 %, MIXED is strictly between. A pair
stating two different facts is refused with a sentence rather than merged —
the same rule `companies_foreign_ownership_pct_chk` has pinned at the write
boundary since migration 0088, which until now no service explained.

### 24.5 🔴 The frame is part of the count

`frameLimits` travels with the figures, in the API and on the page, because five
things Art. 17 contemplates are outside what the register can see: 17(a) land is
not depreciable and the register has no land marker; 17(f) a conversion to
personal use is a deemed disposal AT MARKET VALUE, which no disposal kind
captures (each such disposal is listed with a `deemedValueMissing` flag rather
than contributing a silent zero); 17(k) partial business use; 17(j) land bought
or sold with constructions on it; 17(l) BOT/BOOT contracts.

### 24.6 Verified

`tests/income-tax-pool-arithmetic.test.ts` (10, pure): the five rates; the
half-year convention across three years with the property that the cost base
enters **exactly once**; disposals moving the balance DOWN by the stated amount;
17(g) at the boundary (equal is not an excess); Art. 18 over and under the cap,
and undeclared distinguished from a declared zero; 17(h) and 17(i) OFFERED and
not taken, unavailable elections changing nothing when elected, and the two never
both applied; every group at its own rate on identical facts; and the pool
behaving as a pool (two assets are indistinguishable in it).

`tests/income-tax-pool.test.ts` (7, real rows): the four refusals in sequence on
one company; three named declaration refusals with nothing stored; the chain
computed from the anchor with an asset bought **2025-12-20** and in service
**2026-01-05** entering the 2026 pool and leaving 2025 unchanged; a scrap taking
no compensation out while making Art. 17(i) available at 5,400 and not taking it;
Art. 18 moving the pool and the deduction together by the amounts the Law gives;
an anchor correction re-computing the chain as ONE row, not two; and the
company-scoped isolation with presence, absence AND movement — the other org's
asset capitalised through its own bill path so its 500,000 really moves while
ours stays 200,000.

`tests/zakat-scope.test.ts` gains four (the share's writer): the round-trip and
its withdrawal, the consistency refusal in all four directions with the refused
value never landing, the range refusal, and the DB CHECK refusing the same pairs.

`e2e/income-tax-pool.spec.ts` (6, clicked): the page refusing with no figures at
all; the refusal MOVING ON as each named control is used (the share, then the
fiscal year, both in Company Settings); the anchor form turning the same page
into a working paper with figures checked against the API; Art. 18 declared
through the dialog moving both figures; Arabic under `dir=rtl`; and a phone at
390 px. The walk restores the shared company and withdraws its declarations, so
a second run starts where the first did.

`pnpm run verify`: green.

### 24.7 What this did not do

The pool is a **working paper** and posts nothing — no deferred tax (IAS 12),
and no apportionment of the result to the taxed share: the whole pool is
computed and the share is STATED, because apportioning is a tax-computation step
beyond the register. Art. 17(f)'s market value is not captured (§24.5). The
report's endpoints are reachable from the new page only; the Art. 52 VAT engine
is FA-F.

---

## 25. FA-F — the VAT Art. 52 capital-asset adjustment, as built (2026-09-22)

`AUTHORITATIVE (Saudi)` throughout, read from the pinned primary text
`docs/zatca/specs/KSA_VAT_Implementing_Regulations_EN.txt` (Eighth Edition
English translation; the Arabic prevails, so readings that turn on wording are
marked *reasoned-not-verified*). Accountant **FA-2**: the annual adjustment IS
computed in v1, partially exempt tenants included.

### 25.1 🔴 Three clocks, never substituted for one another

| Clock | Runs on | Set by |
| --- | --- | --- |
| **Depreciation** | the accounting useful life, monthly | the register (FA-A/FA-B) |
| **Art. 52 adjustment** | 6 y movable / 10 y immovable, or the accounting life if shorter (part years count as one), in twelve-month windows **from the start of the TAX PERIOD of acquisition** | 52(2), 52(5) |
| **Art. 51 fraction** | the **calendar** year | 51(4) |

The company's **fiscal** year — which the Art. 17 pool uses — is a fourth and
matches none of them. A 120-month machine depreciates over ten years and adjusts
over six; the walk asserts exactly that, because a category default of 48 months
had quietly turned the first version of the assertion into a statement about the
category rather than about Art. 52(2).

### 25.2 What the engine computes

`vatCapitalAsset.ts` is pure and carries the quoted text beside each rule:

- **52(4)** potentially adjustable = `initial input tax deduction ÷ adjustment period`; the adjustment is that amount × (actual use − initial recovery).
- **52(5)** each window, and the **return** its adjustment belongs to — the last tax period falling inside it. Monthly and quarterly give different windows *and* different returns for the same purchase, which is why the tax period is declared rather than inferred from turnover (Art. 58's threshold is not the only way a period is assigned).
- **52(6)** "no change in use" is reported as its **own flag**, apart from an adjustment that merely computes to zero. 🔴 They are arithmetically identical and legally different, and a window whose use is neither declared nor derivable reports `unavailable`, nil, and **not** 52(6) — nobody established that the use did not change, and a relief the platform never checked must not be evidenced as one.
- **52(7)** at a sale that is a taxable supply, the remaining windows are treated as 100 % taxable use and the unrecovered share is adjusted in the tax period of sale. Destruction, theft and an early end of life are excluded in terms; each gets nil **with its own sentence**, because four zeros that cannot be told apart evidence nothing. (The first version of the engine gave destruction and theft one shared sentence; its own test caught it.)
- **52(8)** a withdrawal is not an adjustment but a Nominal Supply, valued at the disposal by FA-C.
- **50(3)** a restricted motor vehicle reaches the engine with a 0 % initial recovery, so its potentially adjustable amount is 0 and the figure **falls out of the arithmetic** rather than being special-cased.
- **66(1)** the retention date (acquisition + adjustment period + 5 years) travels with each asset.

### 25.3 The actual use: derived by default, declared where it must be

Art. 52(4) adjusts "based on the actual use … during that year". For a tenant
whose asset follows the business as a whole, Art. 51(4) gives exactly that
figure, and the engine **derives** it: taxable supplies over taxable plus exempt
in the window's calendar year. Two details of the text are load-bearing and both
are implemented:

- **Zero-rated supplies are TAXABLE**, not exempt — a Z line belongs in the numerator. Getting this wrong would understate every partially exempt tenant's recovery.
- **51(5)(a) excludes supplies of capital assets** from the fraction. FA-C made that possible: a disposal sale is an invoice that NAMES the asset (`invoices.disposes_asset_id`), so the exclusion has a marker to key on. Without it a tenant selling a building would see its recovery rate lurch for a year.

`asset_vat_use_records` holds the cases the derivation cannot reach, and
**overrides the derived figure for the window it names and no other**: an asset
used exclusively in one activity, an alternative method approved under
51(8)–(10), or the 51(7) year-end true-up. A window outside the asset's
adjustment period is refused rather than stored where nothing could show it.

🔴 `proportionalDeductionPct` returns **null** when a year has no taxable and no
exempt supplies. Returning 0 there would read as "wholly exempt", the opposite
of what an empty year means.

### 25.4 🔴 A second column with no writer, again found by its reader

`companies.vat_tax_period` is new, and the pattern of §24.4 was applied before
it could repeat: the report reads it, so the same commit adds the **writer**
(Company Settings, `PATCH /companies/current`, spec + generated types + a DB
CHECK admitting only `monthly`, `quarterly` and NULL). The refusal names a
control that exists, and the walk proves it by using it.

### 25.5 Verified

`tests/vat-capital-asset-arithmetic.test.ts` (9, pure): the 6/10/life cap with
part years; the tax-period start differing between monthly and quarterly for the
same purchase; twelve-month windows with the right return each (including a leap
February); the 51(4) fraction with an empty year returning **null**; the
adjustment in both directions; 52(6) as a reason distinguished from an unknown;
52(7) at a sale, when already fully recovered, and after the period has run out;
four zeros with four different sentences plus the Art. 50(3) vehicle; and the
property that the initial deduction plus every annual adjustment never exceeds
the input tax charged.

`tests/vat-capital-asset.test.ts` (6, real rows): the refusal with no windows at
all; an asset bought through the product's own bill path getting its Art. 52(2)
period, its windows and its Art. 66 retention date; an **exempt** supply moving
the fraction and the adjustment with it (presence, absence and movement in one
window) while a **zero-rated** supply does not; a declared use overriding one
window and not its neighbours, four named refusals with nothing stored, and the
withdrawal falling the window back to the derived figure; Art. 51(5)(a) keeping
a capital-asset disposal out of the fraction; and the narrowed working paper
being byte-identical to that asset's part of the full one.

`e2e/vat-capital-assets.spec.ts` (6, clicked): the refusal; the tax period
declared in Company Settings taking it away; the windows rendered; **the two
different zeros visible as different things on the page**; a use stated through
the dialog moving that window and leaving the others byte-identical; Arabic
`dir=rtl`; 390 px. 🔴 The walk **seeds its own capital asset** through the
product's own paths — the first version skipped its two most important legs when
the tenant happened to have none, which is a pass reported for a narrower thing
than the file claims.

`pnpm run verify`: green.

### 25.6 What this did not do

Nothing posts: the adjustment is a working paper figure and does not reach the
VAT return's boxes or the GL — wiring it into the return is its own step, and it
needs the accountant's word on which box carries it. Art. 52(3)'s **additional**
adjustment period for capital expenditure on an owned asset is not built (FA-B
has no additions yet — pack §21.5). The alignment of tax periods to the calendar
year is *reasoned-not-verified* and stated on the report. Art. 51(6) (estimated
values for a taxpayer not registered in the previous year) and 51(7)'s own
year-end true-up of the fraction are the taxpayer's, and are offered as a
declared `year_end_true_up` basis rather than computed.

---

## 26. FA-G — the reports, and the reconciliation that is the point of them (2026-09-22)

`STANDARD (IFRS)` for the roll-forward; `PRODUCT DECISION` for the controls.
Pack §11 listed nine reports; this section says which now exist, where, and
which deliberately do not.

### 26.1 🔴 The reconciliation is the forcing function the old register lacked

Before FA-A the register stored a cost and a book value **beside** the rows that
produced them — two value spaces with nothing joining them — and its
depreciation never reached the GL at all. FA-A removed the stored figures. This
report removes the remaining way the two could drift unnoticed, by asking the
question out loud, per category:

| Control | Register side | Ledger side |
| --- | --- | --- |
| `FA_COST` | Σ cost of the assets **in service** | the category's cost account |
| `FA_ACCUMULATED` | Σ accumulated depreciation of those assets | the accumulated account |
| `FA_EXPENSE` | Σ **posted** schedule rows, all time | the depreciation expense account |

🔴 **The ledger side is the WHOLE account, not only the lines the register
produced.** The categorizer can map a bank transaction straight onto a
fixed-asset account, and a difference arriving from outside the register is
exactly what the control exists to surface — netting it out would make the
control pass while the books disagreed. A failing control reports **both**
figures, their difference and the account's own name, because the reader's next
act is to open that account; a bare "does not reconcile" sends them looking for
the number itself.

The ledger side reads `JE_IN_BOOKS` (`posted` + `reversed`), so a reversal pair
nets to zero rather than double-negating — the standing rule, applied here.

### 26.2 The roll-forward is built on EVENTS, not on two snapshots

IAS 16.73(e) per category: opening cost, additions, disposals, closing; opening
accumulated, the charge, disposals, closing; and the net book value. Every
figure is an **event inside the window** — opening is what was in service before
it opened, additions are what was capitalised inside it, disposals what was
disposed inside it.

🔴 A roll-forward assembled from two balance snapshots **cannot show an asset
bought and disposed of within the window at all**, and that is the movement a
reader most needs to see. The test's fixture contains exactly such an asset, and
asserts it appears in both additions and disposals and in neither opening nor
closing — plus that both roll-forwards add up.

### 26.3 What else the report carries

- **Additions and disposals listed** — the rows behind the figures, each linking to its asset and carrying its journal entry.
- **The disposal result** (IAS 16.71), stated with the reminder that it is never revenue.
- 🔴 **The Zakat feed**: net fixed assets per category. Zakat reads the **book** figures (Zakat Regulations Art. 48(1)(b), 49, 63(2)), so it is the *same* closing net book value the movement table shows, **stated once** rather than recomputed — the Zakat working paper and this report cannot disagree about "net fixed assets". Income tax uses an entirely different basis; the page says so and links to the Art. 17 pool.

### 26.4 Verified

`tests/fixed-assets-report.test.ts` (5, real rows): the event-based roll-forward
with an asset bought and scrapped inside the window, both roll-forwards adding
up, and the disposal listed with a loss that is not revenue; a **narrower window
giving a different answer on the same rows**; every control passing on books the
product wrote with **non-zero figures on both sides**, so the pass is not
vacuous; 🔴 the `FA_COST` control **failing** after a journal entry posts to the
cost account from outside the register — with both figures, the difference and
the account named, and only that control moving — then **passing again** once
the entry is reversed; and a disposed asset contributing to neither side while
still being in the register as a disposed row.

`e2e/fixed-asset-report.spec.ts` (5, clicked): the roll-forward rendering and
adding up against the API; the verdict at the top; 🔴 the walk **breaking the
books on purpose** through the product's own journal-entry path to see the
failure rendered, then reversing it; the window changed by typing dates giving a
different answer; Arabic `dir=rtl` and 390 px. The teardown always reverses the
breaking entry, so a failed leg cannot leave the tenant's books broken for every
later spec.

`pnpm run verify`: green.

### 26.5 What this did not do

The **depreciation expense by period and category** report of §11 is the income
statement's own job and is not duplicated here. There is no export (CSV/PDF) —
the page is a working paper, and an export is its own decision about what a
downloaded figure asserts. The reconciliation does not yet run in
`scripts/ledgerInvariants.ts` alongside the D-4 invariants; it is the same three
questions and belongs there, which is the next mechanical step rather than part
of this one.
