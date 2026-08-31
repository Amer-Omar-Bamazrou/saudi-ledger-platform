# §4 navigation tree — reconciled, entry by entry

**Status (2026-08-31): APPROVED AND BUILT.** This began as the review artefact
the owner asked for before any code; the tree was approved on 2026-08-31 with
all four questions answered, and built in the order the owner set — filters
renamed → `valid_until` derivation → Coming Soon pages → the navigation →
`e2e/nav-tree.spec.ts`. It is now the RECORD of what was decided, not a
proposal. Current state authority: [CLAUDE.md §2](../../CLAUDE.md).

🔴 **Two things the build found that this document could not**, both recorded
in full in [`findings-and-lessons.md`](../history/findings-and-lessons.md):

1. **Five real report pages are absent from the §4 spec** — account statement,
   account summary, owner's equity, tax journal entries, activity. Reconciling
   the spec entry by entry cannot see a page the spec never listed, so all five
   would have become unreachable in the commit that made the navigation
   "complete". They are in the tree under Operational Reports.
2. **The agreed EXPIRED predicate names `declined`/`closed` as `status`
   values**, which that column cannot hold — they live on `outcome`. It is
   right anyway, because a CHECK constraint means every declined quotation is
   also `approved`; the two terms are dead weight rather than a defect, and
   become load-bearing the moment that constraint is relaxed.

🔴 **One question is left open rather than defaulted:** the predicate as agreed
lets a **DRAFT** quotation expire, where the invoice precedent goes the other
way (`OVERDUE` excludes drafts, on the ground that an unissued document cannot
be late). Both readings are defensible; the instruction was followed as written
rather than silently swapped for the sibling rule. Changing it is one line in
`quotations.repository.ts` and nowhere else.

**Source:** [`frontend-implementation-spec.pdf`](frontend-implementation-spec.pdf)
§4.1 "Sidebar Menu – Full Hierarchy", PDF pages 6–18, copied into the repo
2026-08-31 so this no longer depends on a path on one machine
(sha256 `5d49a72b…0027f`; the two copies in Downloads were byte-identical).

**Owner decision, 2026-08-31:** the earlier rejection of §4 as navigation is
**withdrawn**. The full tree is built, including entries for features that do
not exist, so the product's scope is legible from the navigation.

## The four markers

| Marker | Meaning |
| --- | --- |
| **BUILT** | A real page exists today. Route named. |
| **FILTER-OF** | Not a destination — a filter on a list that exists. Deep-links with the filter applied, and the destination must reflect it. The real status is named; where the spec's label does not match a status any writer produces, it is renamed, not invented. |
| **COMING SOON** | A real feature that does not exist. Gets a real placeholder page saying what it will do and that it is not ready. Never a dead click, a blank screen, or a 404. |
| **DROPPED** | Points at nothing and cannot be renamed into something real. Reason given for every one. |

**Reconciliation rules applied** (owner, agreed before this pass): rename filters
to real statuses rather than dropping them where a real status exists; drop
anything pointing at nothing; Coming Soon entries get a real page.

> ## 🔴 THE FOURTH RULE — ASSERT BOTH DIRECTIONS
>
> **Added permanently, 2026-08-31, because this pass proved it the hard way.**
>
> The three rules above all point one way: *does every entry in the spec point
> at something real?* That question was answered carefully, entry by entry,
> across ~250 rows — and it is, by construction, incapable of noticing a real
> page the spec never listed.
>
> Five did not appear here: **account statement, account summary, owner's
> equity, tax journal entries, activity.** All five work, all five are crawled
> by the browser suite, none is in the §4 specification. Building the
> navigation from this document alone would have made every one of them
> unreachable **in the same commit that made the navigation "complete"** — and
> they would have gone on passing every test in the repository while no user
> could reach them.
>
> **The rule, for every future reconciliation of one map against another** —
> a route table, a permission matrix, a chart of accounts, a status vocabulary,
> a config schema:
>
> 1. **Every entry points at something.** (The forward direction. The one
>    people check, because it is what the new map is *for*.)
> 2. **Everything is pointed at.** (The reverse. Where the losses are, because
>    a thing that falls out of a map leaves no trace *in* the map.)
>
> Rule 2 cannot be satisfied by reading the document — there is nothing in the
> input to read. It needs an enumeration of the real thing, taken from the
> code, compared mechanically. Here that is `every crawlable route is reachable
> from the navigation` in `e2e/nav-tree.spec.ts`, with an EXEMPT list where
> each exemption carries a reason.

---

## 1. 📊 DASHBOARD

| Entry | Marker | Notes |
| --- | --- | --- |
| Overview (Main Dashboard) | **BUILT** | `/` |
| Quick Actions | **DROPPED** | Not a destination — it is a widget already on the dashboard. A nav entry to a panel of a page you are already on teaches a place that does not exist. |
| Financial Health | **BUILT** | `/finance-hub` — same thing under the product's own name. |
| My Tasks | **BUILT** | `/approvals` — the approvals worklist IS "my tasks". Renamed to the existing surface rather than duplicated. |

---

## 2. 💰 FINANCE (The Ledger)

| Entry | Marker | Notes |
| --- | --- | --- |
| **Chart of Accounts** | **BUILT** | `/categories` |
| ├ Tree View | **COMING SOON** | Hierarchy is designed, not built — `design-chart-of-accounts-structure.md`, blocked on advisor Block E. |
| ├ List View | **BUILT** | The current `/categories` IS the list view. |
| ├ Import Accounts | **COMING SOON** | Designed (CoA §6), not built. |
| └ Account Types Management | **DROPPED** | `routes/categories.ts` mounts only `GET /` and `POST /` — there is **no update and no delete route**, and `isSystem` is not in the API. A management screen would be a form with nowhere to submit. Revisit when the CoA build lands. |
| **Journal Entries** | **BUILT** | `/journal-entries` |
| ├ All Entries | **FILTER-OF** | no filter (the default list) |
| ├ New Entry | **BUILT** | in-page create action |
| ├ Drafts | **FILTER-OF** | `status=draft` |
| ├ Pending Approval | **DROPPED** | 🔴 Journal entries have **no `submitted` state** — `journalEntries.approvable.ts` documents `draft → posted → reversed` and notes a JE is approved directly. A "Pending Approval" filter would return a permanently empty set. |
| ├ Posted | **FILTER-OF** | `status=posted` |
| ├ Reversed | **FILTER-OF** | `status=reversed` — real here, unlike on invoices and bills. |
| ├ Recurring Templates | **BUILT** | `/recurring` |
| └ Import Journal Entries | **COMING SOON** | No JE import exists; `/upload` is bank-statement import only. |
| **General Ledger** | **BUILT** | `/reports/general-ledger` |
| ├ By Account · By Period · By Journal Type | **FILTER-OF** | in-page controls on the GL report |
| **Trial Balance** | **BUILT** | `/trial-balance` |
| ├ Summary View · Detail View · Period Comparison | **FILTER-OF** | in-page controls |
| **Period Management** | **BUILT** | `/closed-months` |
| ├ Current Period · Period Lock/Unlock · Period Closure · Period Reopen | **FILTER-OF** | actions on `/closed-months`, not separate places |
| **Cost Centers / Projects** | **COMING SOON** | 🔴 Zero code — grep for `cost_cent`/`costCent` returns nothing. Designed in CoA §7 (including the decision that the cost centre lives on the **journal entry header**). |
| ├ Manage · Assign to Entries · Cost Center Reports | **COMING SOON** | Children of the above; one placeholder covers them. |

---

## 3. 💰 SALES

| Entry | Marker | Notes |
| --- | --- | --- |
| **Invoices** | **BUILT** | `/invoices` |
| ├ All Invoices | **FILTER-OF** | no filter |
| ├ New Invoice | **BUILT** | in-page create |
| ├ Drafts | **FILTER-OF** | `status=draft` |
| ├ Pending Approval | **FILTER-OF** | `status=submitted` ← renamed |
| ├ Issued | **FILTER-OF** | `status=sent` ← renamed. The state machine calls `sent` the issued state (hashed, QR, AR/revenue/VAT posted). |
| ├ Sent | **DROPPED** | 🔴 Duplicate of Issued. `sent` is one status; the spec lists it twice under two names. Keeping both would be two entries filtering identically — the "surface that collapses two real rows into one", inverted. |
| ├ Paid | **FILTER-OF** | `status=paid` |
| ├ Overdue | **FILTER-OF** | **derived**, not a status — `COALESCE(due_date, date) < today AND unpaid`. The stored value was deleted 2026-08-31 because nothing wrote it. The API already answers `?status=overdue` from the dates. |
| ├ Reversed | **DROPPED** | 🔴 Invoices have no `reversed` status. An invoice that must not stand is reversed by a **credit note** — the ZATCA-correct mechanism, which is live. This filter would return a permanently empty set, which is the exact defect removed on 2026-08-31. |
| └ Invoice Templates | **COMING SOON** | On the roadmap. (The 11 `template` hits in the repo are `system_account_templates` — a different thing.) |
| **Credit Notes** | **BUILT** | `/credit-notes` |
| ├ All · New · History | **FILTER-OF** / **BUILT** | list, in-page create, list |
| **Debit Notes** | **COMING SOON** | 🔴 The **capability is live and correct** (a debit note posts like an invoice); only the standalone page was deleted 2026-08-20. So this is a page to rebuild, not a feature to invent — the placeholder should say exactly that. |
| **Quotations** | **BUILT** | `/quotations` |
| ├ All · New | **FILTER-OF** / **BUILT** | |
| ├ Converted to Invoice | **FILTER-OF** | conversion state is real (`conversionTotals`) |
| ├ Expired | **NEEDS A DECISION** | Quotation statuses are `draft, submitted, approved, declined, closed`. "Expired" is not among them. If it means *past its validity date*, it is derivable like Overdue; if it means `closed`, rename. **Not marked until you say which.** |
| └ Quotation Templates | **COMING SOON** | roadmap |
| **Customers** | **BUILT** | `/customers` |
| ├ All · New · Customer Detail | **BUILT** | `/customers`, in-page create, `/customers/:id` (built 2026-08-31) |
| ├ Customer Statements | **BUILT** | `/reports/customer-ledger` — reached from the detail page's "Open statement", which now carries the customer. |
| ├ Customer Aging | **BUILT** | `/ar-aging` |
| └ Customer Groups | **COMING SOON** | Zero code. On the roadmap. |
| **AR Aging** | **BUILT** | `/ar-aging` |
| ├ Summary · Detail · Aging Report | **FILTER-OF** | in-page views; `/reports/aging` also exists |
| **Sales Reports** | | |
| ├ Sales by Customer | **BUILT** | `/reports/customer-ledger` |
| ├ Sales by Product | **COMING SOON** | Needs products to carry cost — follows inventory. |
| ├ Sales by Region | **DROPPED** | 🔴 Nothing in the schema records a region. Customers have `city`; a "by region" report would be inventing a dimension the data does not have. Raise it as a roadmap item if you want it. |
| └ Sales Trends | **BUILT** | `/analytics` |

---

## 4. 🛒 PURCHASES

| Entry | Marker | Notes |
| --- | --- | --- |
| **Bills** | **BUILT** | `/bills` |
| ├ All · New | **FILTER-OF** / **BUILT** | |
| ├ Drafts | **FILTER-OF** | `status=draft` |
| ├ Pending Approval | **FILTER-OF** | `status=submitted` ← renamed |
| ├ Paid | **FILTER-OF** | `status=paid` |
| ├ Overdue | **FILTER-OF** | derived, as for invoices |
| └ Reversed | **DROPPED** | Bills have no `reversed` status — same reasoning as invoices. |
| **Purchase Orders** | **BUILT** | `/purchase-orders` |
| ├ All · New | **FILTER-OF** / **BUILT** | |
| ├ Converted to Bill | **FILTER-OF** | billing state is real (`billingTotals`) |
| └ PO Templates | **COMING SOON** | roadmap |
| **Vendors** | **BUILT** | `/vendors` |
| ├ All · New · Vendor Detail | **BUILT** | `/vendors`, in-page create, `/vendors/:id` |
| ├ Vendor Statements | **COMING SOON** | 🔴 Asymmetry, deliberate today: `/reports/customer-ledger` exists, the vendor equivalent does not. `VendorDetail.tsx` records this in a comment and omits the button rather than linking to nothing. |
| └ Vendor Aging | **BUILT** | `/ap-aging` |
| **AP Aging** | **BUILT** | `/ap-aging` |
| ├ Summary · Detail · Aging Report | **FILTER-OF** | in-page views |
| **Purchase Reports** | | |
| ├ Purchases by Vendor | **COMING SOON** | The vendor-side equivalent of the customer ledger. |
| ├ Purchases by Product | **COMING SOON** | Follows inventory. |
| └ Purchase Trends | **BUILT** | `/analytics` |

---

## 5. 🏦 BANKING

| Entry | Marker | Notes |
| --- | --- | --- |
| **Bank Accounts** | **BUILT** | `/bank-accounts` |
| ├ All · New · Account Detail | **BUILT** / **COMING SOON** | list and create exist; a per-account detail page does not |
| └ Account Reconciliation | **BUILT** | M16 reconciliation, reached from `/review` |
| **Bank Statements** | | |
| ├ All Statements · Statement History | **COMING SOON** | Import exists; a statement *register* does not |
| ├ Import Statement | **BUILT** | `/upload` |
| ├ Statement Review Queue | **BUILT** | `/review` |
| ├ Categorisation | **BUILT** | `/categorize` |
| └ Bulk Accept | **BUILT** | on `/review` |
| **Transfers** | **COMING SOON** | 🔴 The capability is live (`kind: transfer`, posts to the GL since 2026-08-17) but there is **no transfers page** — they are visible only inside `/transactions`. A page to build, not a feature to invent. |
| ├ All · New · Internal · External | **COMING SOON** | children of the above |
| **Reconciliation** | **BUILT** | `/review` |
| ├ Unreconciled · Suggestions · Manual Matching · History | **FILTER-OF** | in-page states of the review flow |
| **Live Bank Feeds (Coming Soon)** | **COMING SOON** | 🔴 The spec already marks this Coming Soon and it is honest: A2 is blocked on a SAMA-licensed provider, which needs the CR. |
| ├ Connect Bank · Connected Banks · Sync Schedule · Transaction Feed | **COMING SOON** | children |
| **Banking Reports** | | |
| ├ Cash Flow | **BUILT** | `/cash-flow` |
| ├ Bank Balance History | **BUILT** | `/analytics` |
| └ Transfer Reports | **COMING SOON** | with Transfers |

---

## 6. 📋 TAX

| Entry | Marker | Notes |
| --- | --- | --- |
| **VAT** → VAT Return | **BUILT** | `/vat` |
| ├ Generate Return · VAT Boxes · Bilingual Display · VAT Reconciliation View | **FILTER-OF** | in-page controls on `/vat` (all real: the return is box-structured and bilingual) |
| └ Submit VAT Return | **DROPPED** | 🔴 There is no VAT submission API — ZATCA e-invoicing is not VAT-return filing, and the platform does not file returns. An entry here would promise a submission that cannot happen. |
| **VAT Reconciliation** | **BUILT** | on `/vat` |
| ├ Documents vs Bank · Blocked Input VAT · VAT Treatment Verification | **FILTER-OF** | all real (`taxTreatment`, input-VAT blocked flag) |
| **VAT Reports** (Sales/Purchase/Net) | **FILTER-OF** | views of `/vat` |
| **ZATCA E-Invoicing** | **BUILT** | `/zatca` |
| ├ Phase 1 · Phase 2 · Cryptographic Signing · Onboarding · Compliance Dashboard · Reports | **BUILT** / **FILTER-OF** | all live; onboarding is `ZatcaOnboarding.tsx` |
| └ Production Submission | **COMING SOON** | 🔴 Never called in any environment. Blocked on the entity (M12.9). The placeholder must say *blocked on registration*, not *not built*. |
| **Zakat (Coming Soon)** | **BUILT (partial)** | `/zakat` exists; M17.3/M17.4 are **held on advisor Block C**. Keep the entry, mark the unbuilt children. |
| ├ Zakat Calculation · Zakat Base | **COMING SOON** | held on the advisor |
| ├ Fiscal Calendar | **BUILT** | M17.2 |
| └ Zakat Reports | **COMING SOON** | |
| **Withholding Tax (Coming Soon)** | **COMING SOON** | Zero code. Honest in the spec. |

---

## 7. 📈 REPORTS

| Entry | Marker | Notes |
| --- | --- | --- |
| **Financial Statements** → P&L | **BUILT** | `/income-statement` |
| ├ Current Period · Comparison · Monthly Breakdown · YTD | **FILTER-OF** | M20 fiscal-period controls, all real |
| **Balance Sheet** | **BUILT** | `/balance-sheet` |
| ├ Current/Non-current Split · Liquidity Classification · Comparison | **FILTER-OF** | all real |
| **Cash Flow Statement** | **BUILT** | `/cash-flow` |
| ├ Operating · Investing · Financing | **FILTER-OF** | real sections |
| └ Direct/Indirect Method | **NEEDS A DECISION** | Only one method is implemented. Rename to the one we do, or mark the other Coming Soon — **not marked until you say which we produce.** |
| **Trial Balance** | **BUILT** | `/trial-balance` |
| **Aging Reports** | **BUILT** | `/reports/aging` |
| ├ AR/AP by Customer/Vendor/Bucket/Summary | **FILTER-OF** | in-page |
| └ Aging Trends | **COMING SOON** | 🔴 `Analytics.tsx` states explicitly that a historical overdue split **cannot be derived** — payment dates are not kept per instalment. The placeholder must say that, not promise it. |
| **Analytics** | **BUILT** | `/analytics` |
| ├ Trends · Decomposition · Invoiced vs Collected · Liquidity Ratios · Financial Health | **BUILT** | all live |
| **Tax Reports** (VAT/VAT Recon/ZATCA) | **BUILT** | `/vat`, `/zatca` |
| **Operational Reports** | **BUILT** | `/reports/journal-report`, `/reports/general-ledger`, `/audit-trail` |
| **Custom Reports (Coming Soon)** | **COMING SOON** | Report builder, saved, scheduled. Zero code. |

---

## 8. 🤖 AI & AUTOMATION

🔴 **This section contradicts `hub-structure-decision.md`, which `Layout.tsx`
cites in comments.** That decision says Automation and AI get **no navigation
entry at all** and appear inside the flows they serve. The owner is **reversing
it deliberately** (2026-08-31) — recorded in that file with the date and reason,
so nobody later reads the code comments as current.

| Entry | Marker | Notes |
| --- | --- | --- |
| **AI Assistant** → Chat Interface (CFO) | **COMING SOON** | 🔴 AI-6a is **built but dark by construction** — the boot boundary refuses tenant data until the Groq Enterprise agreement is signed (owner action 3). The placeholder must say *blocked on a contract*, not *not built*. |
| ├ Financial Analysis · Variance Explanation · Trend Analysis · Assumption Management | **COMING SOON** | same gate |
| **Findings Engine** → All Findings | **BUILT** | `/findings` |
| ├ Duplicate Detection · Overdue Items · Gaps · Stale Drafts · Undeclared Transfers · Exception Items | **FILTER-OF** | real finding `kind` values |
| ├ Findings Lifecycle (New/Acknowledged/Resolved/Dismissed) | **FILTER-OF** | real statuses |
| └ Escalation (Quarterly/Monthly/Rules) | **BUILT** | AI-5 scheduled findings |
| **Receipt Capture** | **BUILT** | `/scan-review` |
| ├ Camera Capture · ZATCA QR Decode · OCR Fallback · Supplier Auto-Match · Review & Post · Image Storage | **BUILT** | A1, all live |
| **Recurring Transactions** | **BUILT** | `/recurring` |
| ├ Recurring Invoices/Bills · Create Rule · Draft Generation · Failed Run Recording · Run History | **BUILT** | A3, drafts-only by design |
| └ Recurring Journal Entries (Coming Soon) | **COMING SOON** | honest in the spec |
| **Vision Model (Coming Soon)** | **COMING SOON** | AI-4 — needs the receipt corpus (owner action 4) **and** the Groq agreement. |

---

## 9. 🔌 INTEGRATIONS (NEW) — 🔴 THE WHOLE SECTION IS A DECISION, NOT A MARKING

**Every entry here is COMING SOON or DROPPED, and the section as a whole was
already CUT** by `frontend-spec-reconciliation.md` §5.3: *"the extensibility need
is an `EInvoiceProvider`-shaped code seam, not a screen."*

**That cut has not been reversed** — the owner's 2026-08-31 reversal covered the
navigation tree and the AI section explicitly, and said nothing about §5.3. So
this section is presented for decision rather than marked as settled.

| Entry | If built | Notes |
| --- | --- | --- |
| Integration Dashboard | COMING SOON | a screen for a thing §5.3 says should be a code seam |
| Payment Gateways (MyFatoorah / PayTabs / HyperPay) | COMING SOON | 🔴 CR-gated. MyFatoorah is **UNCOSTED** (§5.2); SiFi was corrected — **it is not a payment gateway** (§5.1, owner correction). |
| Live Bank Feeds → 7 named banks | COMING SOON | duplicates the BANKING section's entry; keep one |
| ZATCA Fatoora | **DROPPED here** | Duplicate — it is already the TAX section's ZATCA entry, which is BUILT. |
| E-Commerce (Shopify / WooCommerce) | COMING SOON | roadmap |
| POS Systems · ERP Systems | COMING SOON | roadmap |
| Open Banking Aggregators (Lean / Tarabut) | COMING SOON | CR-gated, same as A2 |
| Email Providers (SMTP / templates / test) | **COMING SOON — and closest to real** | B1's mailer code is done; only provider wiring is missing. A settings screen here is genuinely buildable once the provider is chosen. |
| Integration Logs | COMING SOON | nothing to log yet |

---

## 10. ⚙️ SETTINGS

| Entry | Marker | Notes |
| --- | --- | --- |
| **Company Settings** → Profile · Fiscal · Document Settings | **BUILT** | `/company`; fiscal calendar is M17.2; numbering is server-side since 2026-08-30 |
| ├ Currency → Base Currency · Exchange Rates | **COMING SOON** | single-currency today |
| └ Multi-Currency (Coming Soon) | **COMING SOON** | honest in the spec; zero code |
| **Chart of Accounts Settings** (numbering / defaults / types) | **COMING SOON** | the CoA design, blocked on Block E |
| **Tax Settings** → VAT · ZATCA | **BUILT** | `/company`, `/zatca` |
| └ Zakat Settings (Coming Soon) | **COMING SOON** | held on Block C |
| **Users & Roles** → All · New · Detail · Roles · Permissions Matrix · Invitations | **BUILT** | `/users`; the four roles and the matrix are real |
| └ Session Security | **COMING SOON** | no session-management surface exists |
| **Preferences** → Theme · Language · Date Format · Number Format | **BUILT** / **COMING SOON** | Language and Hijri/Gregorian are real; **Theme is a live open question** (D-2: the `.dark` block has no consumer) |
| ├ Notification Preferences · Dashboard Layout · Keyboard Shortcuts | **COMING SOON** | none exist |
| **Security** → Password Reset | **COMING SOON** | 🔴 Rank 1 in the queue: no self-service flow exists, and the *which* (operator reset vs email) is an open product decision |
| ├ Two-Factor Authentication (Coming Soon) · IP Restrictions (Coming Soon) | **COMING SOON** | zero code; honest in the spec |
| ├ Session Management | **COMING SOON** | |
| └ Login History | **BUILT** | `/audit-trail` |
| **Audit Trail** → Business Audit · Security Audit | **BUILT** | `/audit-trail` (M23) |
| └ Data Export | **COMING SOON** | 🔴 Touches C8/PDPL. Do not build ahead of the advisor. |
| **Organisation Verification** → Status · Document Upload | **BUILT** | `/verification` |
| ├ Operator Review · Approval/Reject | **DROPPED** | 🔴 These are the **platform operator's** surface, not the tenant's. Putting them in the tenant sidebar is the spec's item 10 error. `/operator` exists and is correctly separate. |
| **Billing & Subscription** (Plan / Upgrade / Payment / History / Invoice) | **COMING SOON** | 🔴 R1 — the platform cannot take money. Undesigned; the proposal is in PR #100. |
| **System** → API Keys · Webhooks · Health Check · System Logs | **COMING SOON** | `/api/health` exists but has no UI; the rest is zero code |

---

## 11. 👤 USER PROFILE

| Entry | Marker | Notes |
| --- | --- | --- |
| My Profile → Personal Information | **COMING SOON** | no profile page exists |
| ├ Preferences · Security Settings | **BUILT** | `/change-password`; preferences as above |
| My Activity → Recent Actions · Login History · Audit Trail | **BUILT** | `/audit-trail` |
| My Tasks → Approvals | **BUILT** | `/approvals` |
| ├ Assignments · Notifications | **COMING SOON** | neither exists |
| Account → Logout | **BUILT** | in the shell |
| └ Switch Organisation | **BUILT** | multi-org switching is live |

---

## Proportions

Counting leaf entries that would become nav items (≈250 in the spec; grouped
children counted once where a single placeholder covers them):

| Marker | Approx. count | Share |
| --- | --- | --- |
| **BUILT** | ~95 | ~38% |
| **FILTER-OF** | ~55 | ~22% |
| **COMING SOON** | ~85 | ~34% |
| **DROPPED** | ~13 | ~5% |
| **NEEDS A DECISION** | 2 | <1% |

🔴 **About a third of the tree is Coming Soon.** That is the honest shape of the
decision: the navigation will show roughly as many unbuilt features as built
ones. The placeholder convention is what keeps that from being a facade — but it
is worth seeing the proportion before it ships, which is why this document
exists.

## The DROPPED list, for argument

Thirteen entries, each pointing at nothing that can be renamed into something
real:

1. **Dashboard → Quick Actions** — a widget on a page you are already on.
2. **CoA → Account Types Management** — no update or delete route exists.
3. **Journal Entries → Pending Approval** — JEs have no `submitted` state.
4. **Invoices → Sent** — duplicate of Issued; one status, two labels.
5. **Invoices → Reversed** — no `reversed` status; reversal is a credit note.
6. **Bills → Reversed** — same.
7. **Sales → Sales by Region** — nothing records a region.
8. **VAT → Submit VAT Return** — no return-filing API; ZATCA ≠ VAT filing.
9. **Verification → Operator Review** — operator surface, not the tenant's.
10. **Verification → Approval/Reject** — same.
11. **Integrations → ZATCA Fatoora** — duplicate of the TAX section's entry.
12–13. *(the two duplicate Live Bank Feeds entries, if the INTEGRATIONS section
    is kept — one in BANKING, one in INTEGRATIONS.)*

## Owner answers — 2026-08-31

All four open items are settled. Recorded here so the build has no inherited
defaults.

### 1. Quotations → Expired = DERIVED from `valid_until`

Same reasoning as Overdue: dates hold the truth, and a stored status is a second
representation to keep in sync.

✅ **This is a small change, not a bigger one.** `quotations.valid_until` already
exists (`schema/quotations.ts:81`, nullable) and its comment already states the
semantics this needs: *"NULL = no expiry was stated, a first-class state."* So
no column is added, and the NULL case is already decided — a quotation with no
stated expiry never expires, rather than expiring immediately.

The predicate mirrors the invoice one, defined once in the repository and used
by both the count and the filter:

    valid_until IS NOT NULL
      AND valid_until::date < CURRENT_DATE
      AND status NOT IN ('approved','declined','closed')

### 2. Cash Flow = the DIRECT method

**We produce the direct method.** `reports.service.ts:268` walks transactions and
classifies actual cash movements into operating / investing / financing by
`kind`. There is no net-income-plus-adjustments chain — the `netIncome` nearby
belongs to the owner-equity report, a different computation.

**The indirect method is not built and is not being built.** It goes to
[`roadmap.md`](roadmap.md); the nav shows only what we produce, so there is no
"Direct/Indirect" toggle offering a choice of one.

### 3. INTEGRATIONS — kept, and §5.3 is overridden deliberately

**Owner decision, 2026-08-31.** §5.3 cut the integrations hub ("the extensibility
need is an `EInvoiceProvider`-shaped code seam, not a screen"). That cut is
**reversed**: the reversal covers the navigation tree as a whole, and
Integrations is part of it — recorded with a date and a reason so nobody later
treats §5.3 as current, exactly as with the AI section.

**Scoped to three things.** Everything else in that subtree is Coming Soon or
dropped:

| Entry | Marker | Notes |
| --- | --- | --- |
| **MyFatoorah** | **COMING SOON** | Payment acceptance. UNCOSTED (§5.2) and CR-gated. |
| **SiFi** | **COMING SOON** | 🔴 **NOT under Payment Gateways.** §5.1 (owner correction, 2026-08-30): SiFi is a SAMA-licensed **EMI doing spend management** — corporate cards, expense management, vendor payments. It does not accept a customer payment against an invoice. The integration is **outbound** and sits **adjacent to A2 (bank connectivity)**. Filing it beside MyFatoorah would repeat the error §5.1 exists to correct. |
| **Add integration** | **BUILT (as a slot)** | The extensibility affordance — an empty state that says what an integration is and how to ask for one. This is the part §5.3 was right about: the seam is code, but the *slot* is a legible place for it. |
| PayTabs · HyperPay · Shopify · WooCommerce · POS · ERP · Lean · Tarabut · Integration Logs | **DROPPED** | Not in the agreed scope. They return when someone asks for them, with a design and an estimate. |
| Email Providers | **COMING SOON** | B1's mailer code is done; only provider wiring is missing. Genuinely buildable once a provider is chosen. |
| Live Bank Feeds | **COMING SOON** | Kept in **BANKING** only — the duplicate here is dropped. |
| ZATCA Fatoora | **DROPPED** | Duplicate of the TAX section's entry, which is BUILT. |

### 4. The COMING SOON convention — and the reason it has a rule

🔴 **A placeholder that says "coming soon" when the truth is "waiting on a
commercial agreement" is less honest than it could be** (owner, 2026-08-31).

**The rule, stated so future placeholders follow it rather than copying the
table below:**

> **Every COMING SOON page names what it is waiting on, and names it
> specifically.** Where the blocker is not build effort — a contract, a
> registration, an advisor's answer, a legal question, an undesigned decision —
> the page says which, by name.

**Why it is a rule and not a nicety:** *"Not built" invites someone to build it;
"waiting on a contract" tells them why they must not.* A generic placeholder is
an open invitation to spend effort on something that cannot ship, and the person
most likely to accept that invitation is a future contributor with time and no
context — which is exactly who a placeholder is written for. The blocker's name
is the part that does the work.

**Corollary:** when the blocker clears, the page's own text says so, so the
placeholder becomes the work order. A page reading *"waiting on the Groq
Enterprise agreement"* is a queue item the day that agreement is signed.


🔴 **A placeholder that says "coming soon" when the truth is "waiting on a
commercial agreement" is less honest than it could be** (owner, 2026-08-31).
Where a feature is blocked on something other than build effort, the page says
what:

| Feature | The page says it is waiting on |
| --- | --- |
| AI Assistant, AI Explanations, Vision Model | **the Groq Enterprise agreement** (owner action 3) — the code is built and dark by construction |
| ZATCA Production Submission | **a registered Saudi entity with VAT + ERAD** (owner action 1, M12.9) |
| Zakat Calculation, Zakat Base, Zakat Settings | **advisor Block C** — the mechanism is decided, the tax content is not |
| Billing & Subscription | **R1 is undesigned** — provider, plan shape, and what a plan gates |
| Data Export | **advisor Block C8 (PDPL)** — do not build ahead of the answer |
| Live Bank Feeds, SiFi, MyFatoorah, Open Banking | **the CR** — signatures need the entity |
| Inventory / COGS | **advisor Block E** — the account decision gates it |

The distinction matters: *not built* invites someone to build it. *Waiting on a
contract* tells them why they must not.

## Open questions — NONE REMAIN

All four were answered by the owner on 2026-08-31; see **Owner answers** above,
which is the single writer for those decisions. This heading is kept so a reader
arriving from an older link does not conclude the questions are still open.
