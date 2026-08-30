# Chart of accounts and cost centres — numbering, hierarchy, tenant accounts, import

**Status (2026-08-30): PROPOSAL, with the owner decisions of 2026-08-30 folded in.**
Nothing here is built. Current state authority: `CLAUDE.md` §2. Supersedes
nothing — the M13 spec (`docs/feature-spec-chart-of-accounts.md`) built the
*posting-path* chart this document proposes to give structure to.

**Decided by the owner on 2026-08-30** (recorded as decisions, not proposals):

| # | Decision |
| --- | --- |
| D1 | The **number is the tenant's identifier; the tree is our structure.** The code carries identity, the display carries the label. |
| D2 | Consistency between number and tree is a **soft check — warn, never refuse.** Import is the reason. |
| D3 | **No depth cap.** The only structural rule is that a child's number extends its parent's prefix. |
| D4 | **Posting is governed by a per-account `postable` flag**, defaulting to false on parents — not a hard leaf-only rule. |
| D5 | Cost centres are **always optional**, **one per entry** (no splitting), and **hierarchical**. |
| D6 | The import path is designed against the **soft check**, never against the seeded scheme. |
| D7 | Cost centres are a **reporting dimension only**. Approval routing is **deliberately excluded** — see §7e. |

> ⚠️ The original numbered questions were raised in an earlier session and are not
> recorded in the repository, so my numbering may not match the owner's. The
> substance is taken from the owner's messages of 2026-08-30.

---

## 1. What exists today — measured, not remembered

Measured against the live dev database and the source on 2026-08-30.

| Fact | Value |
| --- | --- |
| Accounts per organization | **40**, identical in all 3 orgs |
| Protected (`is_system = true`) | **15** — the codes `glPosting.resolveAccounts` names |
| Carry a `system_code` but are **NOT** protected | **25** |
| Accounts with no `system_code` at all | **0** |
| Hierarchy | **None.** There is no `parent_id` column |
| Account numbers | **None.** `system_code` is a text identity (`CASH`), not a number |
| Cost-centre dimension | **None.** `branches`/`departments` are empty with zero consumers (S6/S7) |
| Recursive queries anywhere in the API | **None.** This design introduces the first |

**Consumers.** Five FKs point at `categories`: `transactions.category_id`,
`products.category_id`, `journal_entry_lines.account_id`,
`fixed_assets.category_id`, `budgets.category_id`. The GL line's FK is
`ON DELETE RESTRICT`.

**How statements classify.** Every financial statement buckets on
`categories.type` — a flat five-way enum (`asset | liability | equity | income |
expense`). `reports.service.ts:512` reads `cat.type === "income" || cat.type ===
"revenue"`, so the enum value for class 4 is **`income`**; "Revenue" is a label,
not a new type value.

**Two protection tiers, and the gap between them.** `protect_system_categories()`
blocks DELETE and `type`/`system_code` changes — but **only for rows with
`is_system = true`, and only for non-owner roles**. The other 25 accounts
(`BANK_CHARGES`, `INVENTORY`, `FUEL_TRANSPORT`, …) are resolved by code from
`services/categorization/categorizer.ts` and are **deletable**. Posting fails
closed when a code will not resolve, so the damage is a refusal rather than a
mis-post — but it is a refusal the tenant caused and cannot diagnose.

🔴 **This is latent only because there is no way to reach it.** `routes/categories.ts`
mounts exactly two endpoints — `GET /` and `POST /`. There is **no update route
and no delete route**, and `categoriesService.list` returns neither `systemCode`
nor `isSystem`, so the UI cannot distinguish a protected account from an ordinary
one.

> **Everything in this document makes that reachable.** Giving tenants account
> management converts a dormant gap into a live one — the §3 rule about asking
> what a change alters the meaning of. The protection tiers in §5 are not polish;
> they are the precondition for shipping any of the rest.

---

## 2. Numbering and the tree (D1, D2, D3)

The conventional scheme, seeded:

| Digits | Level | Example |
| --- | --- | --- |
| 1 | Class | `1` Assets · `2` Liabilities · `3` Equity · `4` Revenue · `5` Expenses |
| 2 | Group | `11` Current assets · `12` Non-current assets |
| 4 | Account | `1101` Cash · `1102` Bank · `1201` Buildings |
| 6+ | Sub-account | `110101` Cash — Riyadh till |

Class digit → `type`: `1→asset`, `2→liability`, `3→equity`, `4→income`,
`5→expense`.

**There is no digit-count rule.** The seeded chart uses 1/2/4/6 as its own
convention; nothing enforces those widths, and an imported chart may use any.

### 2a. What is enforced, and what only warns

| Rule | Level | Why |
| --- | --- | --- |
| `parent_id` is the structural truth | **Hard** | The tree is ours (D1) |
| **No cycles** — an account is not its own ancestor | 🔴 **Hard, DB-level** | See below |
| Class digit ↔ `type` agree | **Hard (DB CHECK)** | One fact stored twice; drift is silent |
| A child's number extends its parent's prefix | **Soft — warn** | D2, D3, D6 |
| Depth | **Unbounded** | D3 |

**Why the class digit stays hard.** The first digit and `type` are two
representations of one fact — CLAUDE.md §3's *"two id spaces with no forcing
function diverge invisibly"*. An account numbered `4200` with `type = 'expense'`
would read as Revenue to every human who sees the number while landing in
Expenses in every statement, because the code buckets on `type` and never reads
the number. A silent wrong answer that looks authoritative. Enforced in the
database, not the service — five writers already, plus an import path.

**Why the prefix rule only warns.** It is a coherence check *between* the number
and the tree, not a derivation of one from the other. Hard-enforcing it would
make the number the source of structural truth, which contradicts D1 and would
reject most real incoming charts — the migration path refusing the charts it
exists to accept (D6).

🔴 **With the depth cap gone, the cycle guard becomes load-bearing.** A cap
bounded recursion implicitly; without one, a cycle means a report that never
terminates. The guard must be a database constraint (a trigger validating the
ancestor chain on insert/update of `parent_id`), never a service-layer check —
this is the write-boundary rule, and a hung report is the failure mode.

**Where the rule is enforced by construction instead.** In our own UI, creating a
child *generates* the next free number under the parent, so a violation is not
expressible — the "make the wrong thing inexpressible" rule. The soft warning
therefore fires almost exclusively on imported charts, which is exactly where it
should be advisory.

---

## 3. Posting: the `postable` flag (D4)

**The owner's decision replaces my earlier recommendation, and is better.**

My previous draft argued that tenants must nest under seeded *group* nodes rather
than under seeded *posting* accounts, because `glPosting.resolveAccounts()`
resolves a system code to exactly one account id, and a strict leaf-only rule
would stop `1101 Cash` being postable the moment it gained a child — breaking
every invoice, bill and payroll run.

**A per-account `postable` flag dissolves that problem.** `1101 Cash` keeps
`postable = true` whether or not it has children, so the posting path is
untouched and tenants get what was actually asked for: **their own sub-accounts
directly under seeded parents**. The workaround is withdrawn.

| Node | `postable` | Note |
| --- | --- | --- |
| `1` Class, `11` Group (seeded structural) | `false` | Rollup only |
| `1101` Cash (seeded, carries the code) | **`true`** | Stays true even with children |
| `1150` Petty cash (tenant leaf) | `true` (default) | |
| A tenant node used purely for grouping | `false` (tenant's choice) | |

**Defaulting.** Seeded structural nodes are created `false`; seeded posting
accounts and new tenant accounts are created `true`. 🔴 **Adding a child never
silently mutates the parent's flag** — a hidden state change triggered by
creating something else is precisely the class of side effect that bites later,
and for a system account it would break posting. Instead, posting to an account
that has children raises a **warning**, not a refusal.

### 🔴 The consequence that must be designed, not discovered

A parent that is both **postable and has children** carries two different numbers:
its **own** balance and its **rolled-up** total. If a statement shows one and a
user reads it as the other, the figure is wrong in the way nothing surfaces.

So every report that renders a tree node must render **both, labelled** — never a
single ambiguous figure. The rollup is `node_total = own_postings +
Σ(children_totals)`, each counted exactly once. This is the "two correct
assertions with a gap between them" shape: own-balance and rolled-up-total can
each be right while the displayed one is the wrong one for the question asked.

---

## 4. Rollup with unbounded depth

D3 removes the cap, so rollup is genuinely recursive. Consequences, stated
plainly because the cap was my argument against it:

- **`WITH RECURSIVE` enters the codebase for the first time.** No API query uses
  recursion today. It lands in the statement builders, the budget aggregates and
  the Finance Hub — and in the cost-centre reports of §7.
- **Index `parent_id`** on both trees; recursion walks it once per level.
- **The cycle guard is the termination guarantee** (§2a). It is not defence in
  depth; it is the only thing standing between a malformed tree and a hung
  report.
- **Materialisation is available later if needed** (a stored ancestor path or a
  closure table) without changing the model — the tree is already the truth.
  Not proposed now: it is a second representation of the same fact, and this
  document has already rejected one of those.

---

## 5. Protection tiers — three, not two

Today's boolean cannot express what is actually true, and the 25-account gap in
§1 is the evidence.

| Tier | Column state | Delete | Change `type` / number | Rename | Add children |
| --- | --- | --- | --- | --- | --- |
| **Structural** — classes and groups | `is_system`, no code | Never | Never | Yes (label) | Yes |
| **Posting** — the 15 resolved codes | `is_system` + `system_code` | Never | Never | Yes | **Yes** (D4) |
| **Resolvable** — the 25 categorizer codes | `system_code`, protected | Never | Never | Yes | Yes |
| **Tenant** | neither | Yes, if no GL history | Yes | Yes | Yes |

The change: promote the 25 code-carrying accounts out of the unprotected tier.
They are resolved by code at runtime; deleting one is a fail-closed break the
tenant cannot diagnose. Protection follows **"does anything resolve this by
code"** — a checkable property — rather than `is_system`, which today means "was
in the M13 list".

`categoriesService.list` must also return `systemCode`, `isSystem`, `postable`,
`accountNumber` and `parentId` — the UI cannot render "you may not delete this"
from fields the API does not send. That is the `apiFetch` class from §3, and
`tests/list-response-shape.test.ts` already exists to catch it.

**Deletion is FK-bounded regardless.** `journal_entry_lines.account_id` is
`ON DELETE RESTRICT`, so any account ever posted to cannot be deleted by anyone.
The product should say so in those words rather than surfacing a 23503.

---

## 6. Import (D6)

The migration path for a tenant with books elsewhere.

### 6a. Designed against the soft check, not the seeded scheme

🔴 **The import validator must not know the seeded chart's shape.** It enforces
only the hard rules of §2a — parseable, unique numbers, resolvable parents, no
cycles, class digit agrees with `type` — and **warns** on everything else: a
different digit width, a prefix that does not extend the parent, a depth we
would not have chosen.

An incoming chart with 5-digit codes, six levels, or numbers that ignore our
prefix convention **imports cleanly, with warnings**. This is the whole point of
D2 and D6: a convention that blocks the migration it was meant to serve is worse
than no convention.

### 6b. Coexist or replace — 🔴 replace is not offerable

**Import ADDS and MAPS. It never replaces, and "replace" must not appear in the
UI**, because the database will refuse to honour it:

- the 15 posting accounts cannot be deleted (`protect_system_categories`), and
- **any** account with GL history cannot be deleted (`ON DELETE RESTRICT`).

"Replace my chart" is a promise that fails for every organization that has posted
anything — which is every organization worth migrating.

**The real feature is MAPPING.** The incoming chart almost certainly contains the
tenant's own cash, AR, AP, sales and VAT accounts, which we already have as
protected system accounts. Import must let the tenant say *"my 1101 is your
CASH"* — which **renumbers and renames our account** (both permitted on a
protected account; only `type`, `system_code` and deletion are frozen) instead of
creating a duplicate. Unmapped rows are created as tenant accounts. The result is
one chart in the tenant's own numbering, still wired to the posting path.

Auto-suggest mappings, never auto-apply — suggestions are pre-selected, the human
clicks.

### 6c. Format

**CSV, UTF-8, BOM tolerated** — what every accounting package exports and what
Excel produces in Arabic locales.

| Column | Required | Notes |
| --- | --- | --- |
| `account_number` | ✅ | Unique within the file. Any width. |
| `name` | ✅ | |
| `name_ar` | — | Falls back to `name`; flagged, because Arabic is a launch requirement |
| `type` **or** `class` | ✅ | Enum or class digit; must agree with the number's first digit |
| `parent_number` | — | Empty ⇒ infer from prefix; an explicit value always wins |
| `postable` | — | Defaults true for leaves, false for nodes with children in the file |
| `description` | — | |
| `vat_applicable`, `default_tax_treatment` | — | Imports **unverified** (`treatment_verified = false`), per C9 |

🔴 **Opening balances are OUT OF SCOPE and must not be a column.** A balance
import writes to the ledger: it needs a date, an open period, a balancing entry
and an audit trail. It is a posting path, and accepting it here would create a
second writer to the GL — forbidden by §4 outright. Separate milestone, and the
import screen says so rather than letting the tenant discover their balances did
not come across.

### 6d. Validation, partial and conflicting input

Follows the pattern the codebase already uses for bank statements — `upload →
staged preview → accept` — and the M16 principle that **accepting the preview IS
the review**.

**Stage 1 — structural. Whole file rejected, nothing written.** Only the hard
rules: unparseable CSV, missing required column, duplicate `account_number`, a
`parent_number` that exists nowhere, a cycle, a class digit contradicting `type`.

Whole-file because a chart is a *structure*: importing the half that parsed
produces orphans and a tree the tenant did not design. The response lists every
failing row with its line number — not the first failure.

**Stage 2 — staged preview**, carrying warnings (§6a) and a disposition per row:

| Disposition | When |
| --- | --- |
| **Create** | Number is free |
| **Map onto existing** | Matches a system account by suggestion or tenant choice |
| **Conflict — needs a decision** | Number already used by an unrelated account |
| **Skip** | Tenant's choice |

**Stage 3 — accept. One transaction, all-or-nothing.** A partial commit leaves a
chart that is neither the old nor the new one, with no way to tell which rows
landed. The import gets an id and an audit record; conflicts must be resolved
before accept is offered.

🔴 **Scope disclosure.** The accept button names the true counts — *"create 84
accounts, renumber 6 existing, skip 3"* — before the click, not after. The
acted-on set must match the set the user was shown.

---

## 7. Cost centres (D5)

The accountant's answer settles the shape: **always optional, one per entry, no
splitting, hierarchical.**

### 7a. Model

**A new `cost_centres` table** — org-scoped, with `parent_id`, `code`, `name`,
`name_ar`, and an `assignable` flag. It reuses the §2a/§4 tree rules verbatim:
hard cycle guard, unbounded depth, soft prefix check.

🔴 **`branches` and `departments` are dropped in the same migration.** They are
empty in every organization with zero consumers (S6/S7 says build a consumer or
drop them), carry no hierarchy, and are company-scoped rather than org-scoped.
Repurposing a table named "department" for a thing called "project" is the
*"a name says who processed a movement, not what it was"* confusion. Dropping
them costs nothing — there are no rows — and closes S6/S7.

### 7b. 🔴 The cost centre lives on the JOURNAL ENTRY HEADER

`journal_entries` already has a header row. A **nullable `cost_centre_id` there**
makes *"one entry, one cost centre"* **inexpressible to violate** — the §3 rule
about finding the representation in which the wrong thing cannot be said.

The alternative — a column on `journal_entry_lines` — would let two lines of one
entry carry different centres, which is exactly the splitting the accountant
ruled out. It would be a convention enforced by review rather than an invariant
enforced by shape.

The value is captured on the source document (transaction, bill, invoice, manual
JE) and **stamped onto the entry at posting time**, so it flows through the
existing posting path without a second writer.

**A bill spanning two projects is two bills.** That is the accountant's
simplification, and it is what buys a single nullable FK instead of an allocation
table with its own rounding rules.

### 7c. Assignable mirrors postable — deliberately

The owner asked that the two dimensions match unless there is a real reason not
to. **I looked for one and did not find it.**

| | Accounts | Cost centres |
| --- | --- | --- |
| Flag | `postable` | `assignable` |
| Default on a node with children | `false` | `false` |
| Can a parent carry entries directly? | Yes, if flagged | Yes, if flagged |
| Auto-mutated when a child appears? | **Never** | **Never** |
| Rollup | own + Σ(children) | own + Σ(children) |

The one asymmetry worth noting: cost centres have **no seeded set**, so the
escape hatch D4 exists for — a system account that must stay postable after
gaining children — has no counterpart here. That makes the flag *less* necessary
for cost centres, not differently shaped. Keeping them identical costs one unused
degree of freedom; diverging costs a rule someone has to remember. Symmetry wins.

### 7d. 🔴 Unassigned is a line, not an omission

Cost centres are optional, so most ledgers will have entries with none. A
per-project report that silently drops them shows a total that does not
reconcile to the income statement, and nothing on the page says why.

**"Unassigned" is a first-class row in every cost-centre report**, with the same
discipline as SUSPENSE: a visible figure somebody can act on, never a silent
exclusion. The project breakdown must sum to the unfiltered total, and a test
should assert exactly that — the reconciliation is the property, not the
individual figures.

This also makes adoption legible: a tenant starting to use cost centres watches
"Unassigned" shrink, which is a better signal than a number that was complete
from day one because the incomplete part was hidden.

---

### 7e. 🔴 Approval routing is deliberately excluded (D7)

**A cost centre never affects who approves anything.** It is a reporting
dimension and nothing else.

Recorded with its reasoning so that it reads as a decision rather than a gap,
and is not re-proposed later as an oversight:

1. **The engine it would change is the one every document workflow runs through.**
   Approval routing is not a cost-centre feature; it is a change to the shared
   approval engine that invoices, bills, journal entries, payroll and quotations
   all pass through. The blast radius is every approvable entity, not this one.
2. **It is a materially larger milestone** than the dimension itself, and it
   would arrive bundled inside a reporting change where nobody would be looking
   for it.
3. **Nobody has asked for it.** The accountant asked for **expense tracking by
   project** — not for project owners approving their own spend. Those are
   different requirements, and the second one was inferred rather than
   requested.

If it is ever wanted, it is its own design with its own review — starting from
the separation-of-duties question, since "the project owner approves their own
project's spend" is a control decision before it is a routing decision.

---

## 8. What we rejected, and why

Per CONTRIBUTING §3b. Entries marked ↩︎ were proposed in the 2026-08-30 draft and
**reversed by owner decision** — recorded so the reversal is durable too.

| Rejected | The property that lost it |
| --- | --- |
| **Enforcing prefix-parenthood as a DB constraint** | Makes most real incoming charts unimportable; the migration path would refuse the charts it exists to accept. |
| **Leaving the class digit as convention too** | The digit and `type` are one fact stored twice with no forcing function; drift is invisible and produces a statement contradicting the number a human reads. |
| **Deriving `type` from the number and dropping the column** | `type` is load-bearing in five FKs, every statement and a DB CHECK on `liquidity_class`. A large refactor of working code to delete a column that is not the problem. |
| ↩︎ **A hard depth cap of 4** | *Reversed (D3).* A cap is a number requiring justification, and someone always needs one level more. Cost: recursion enters the codebase (§4) and the cycle guard becomes load-bearing. |
| ↩︎ **Tenants nesting only under seeded GROUP nodes** | *Reversed (D4).* The workaround existed only to avoid a hard leaf-only rule. A `postable` flag removes the need for both. |
| ↩︎ **Hard leaf-only posting** | *Reversed (D4).* A rule we already knew we would break for the seeded chart is not a rule. |
| **A `postable` flag that auto-flips when a child is added** | A hidden state change triggered by creating something else; on a system account it would break posting silently. Warn on the posting instead. |
| **"Replace my chart" on import** | The database refuses it: protected accounts and posted-to accounts cannot be deleted. A feature that cannot keep its promise for any real tenant. |
| **Opening balances as an import column** | A write to the GL — a second posting path for an effect that already has one. |
| **Cost centres as an account-number segment** | Dissolves a dimension into an identifier: the chart multiplies, reports fragment, and it can never be re-sliced. |
| **Cost centre on `journal_entry_lines`** | Lets one entry carry two centres — the splitting the accountant ruled out — making the rule a convention instead of a shape. |
| **An allocation table splitting one entry across centres** | Solves a problem the accountant explicitly does not have, and brings rounding rules, a second writer and a reconciliation surface with it. |
| **Repurposing `branches`/`departments` as cost centres** | No hierarchy, wrong scope, and a name that describes an org unit rather than a project. |
| **Dropping cost centres from an unassigned-filtered report** | Produces a breakdown that does not reconcile to the income statement, with nothing on the page saying why. |
| **Applying an import partially** | Leaves a chart that is neither the old nor the new one, with no way to tell which rows landed. |
| **XLSX as a first-class second format** | Two parsers means two validators and two sets of bugs for one capability; XLSX becomes a converter feeding the same CSV validator. |
| **A materialised closure table now** | A second representation of a fact the tree already holds — the thing this document rejects elsewhere. Available later if measurement demands it. |
| **Cost-centre approval routing** (D7, §7e) | Changes the shared approval engine every document workflow runs through, for a requirement nobody made: the accountant asked for expense tracking by project, not for project owners approving their own spend. |

---

## 9. Open questions — for the owner, before any build

1. **Do the 25 categorizer accounts become permanent?** Promoting them to
   protected (§5) says the platform's category set is *ours*, not the tenant's.
   The alternative is letting tenants delete unused ones and teaching the
   categorizer to degrade — a bigger change than the promotion.
2. **May a tenant renumber a protected system account?** §6b's mapping needs it
   (`CASH` becomes `1101`). Safe — the code, not the number, is the identity —
   but it means the seeded numbering is a default, and two tenants' charts will
   not match.
3. **Is per-company chart scoping wanted?** `categories.organization_id` is
   org-scoped with a schema comment reserving `company_id` "later", while GL
   lines and entries are already company-scoped. Cost centres inherit the same
   question. 🔴 **Measured 2026-08-30: every organization has exactly one
   company, and `routes/companies.ts` exposes only `GET/PATCH /current` — there
   is no route that creates a second company.** Multi-company is schema-deep and
   product-shallow, so this is a question about a capability that does not yet
   exist. Much cheaper to decide before import exists than after.
4. **How many accounts we seed** — moved to the advisor package as **Block E**
   (owner decision, 2026-08-30). It is Saudi accounting-practice content, not a
   design question, and this project does not reason tax content from general
   knowledge. 🔴 **The build is not held for it:** the structure in §2 works for
   40 seeded accounts or 400, so seeding more is additive data, not a redesign.

---

## 9b. 🔴 CROSS-MILESTONE DEPENDENCY — this design and M17.3 share a table

**Recorded as a dependency, not a question** (owner instruction, 2026-08-30), so
it is visible before the advisor's answer arrives rather than surfacing as a
collision during the build.

**Neither milestone currently knows about the other.**

| | This design | M17.3 (Zakat classification) |
| --- | --- | --- |
| Table it alters | `categories` | `categories` |
| Columns added | `account_number`, `parent_id`, `postable` | `zakat_classification` |
| Seeded vs tenant | Seeded structure, tenant extends | "Seeded for system accounts, editable per tenant" |
| Needs `system_account_templates` + trigger redefined | ✅ | ✅ |

Three concrete couplings, in increasing order of how easily they are missed:

1. **Same migration surface.** Both add columns to `categories`, and both
   therefore trip the CLAUDE.md §4 rule: `system_account_templates` gains the
   matching column and `seed_org_chart_of_accounts()` is redefined, guarded by
   `tests/org-seed-trigger.test.ts`. Whichever lands second must not assume the
   trigger still looks the way its author last saw it.

2. **Same source accounts.** The Zakat base is built from **balance-sheet
   accounts** (Zakat design Q4). The seeded chart is what supplies them. If the
   seeded chart lacks an account the worksheet needs, the worksheet cannot
   express the base — which is Block E's question E2.

3. 🔴 **Hierarchy creates a grain question M17.3 does not have today, and was
   not designed against.** M17.3 was specified when the chart was **flat**, so
   "which worksheet line does this account feed" had exactly one possible grain:
   per account. Once the chart is a tree, a new question exists — **does
   `zakat_classification` attach to a leaf, or to a group and inherit downward?**

   Inheritance is attractive (classify `12 Non-current assets` once, not each
   child) and it is exactly how a wrong answer gets in: an inherited
   classification on a tenant-created child nobody reviewed would put an account
   into the Zakat base **silently**. Attaching only to leaves is more typing and
   has no silent mode.

   **This design does not decide it** — it is M17.3's decision. It is recorded
   here because M17.3 cannot make it without knowing the chart became a tree,
   and nothing else would have told it.

**Sequencing consequence.** If M17.3 lands first, it lands against a flat chart
and its grain question is answered by default rather than by decision — the
worst of the three outcomes. Either this design lands first, or M17.3's author
reads this section before starting.

---

## 10. Build order, if approved

Each step ships and is verifiable alone; nothing here is started.

1. **Protection tiers + expose the missing fields in the API** (§5). Closes the
   live gap first, before anything makes it reachable.
2. **`account_number`, `parent_id`, `postable`** on `categories`, the class-digit
   CHECK, and 🔴 **the cycle-guard trigger** (§2a — load-bearing, not optional).
   Adding columns here **requires redefining `seed_org_chart_of_accounts()` and
   adding matching columns to `system_account_templates`** — the CLAUDE.md §4
   rule, guarded by `tests/org-seed-trigger.test.ts`, which compares the two
   tables' column sets. Seeded parents need a two-pass insert.
3. **Number and re-parent the existing 40 accounts** — additive: no id changes,
   no `type` changes, so all five FKs and every existing statement are untouched.
4. **Account management UI**: create, rename, reparent, set `postable`,
   delete-if-unposted, with refusals that explain themselves (the AUD-7 rule).
5. **Recursive rollup** in the statements, rendering own vs rolled-up distinctly
   (§3).
6. **Import**: validator → staged preview → accept, with mapping (§6).
7. **Cost centres** (§7): table + tree, drop `branches`/`departments`,
   `cost_centre_id` on the entry header, capture on documents, then the
   per-project report with its Unassigned row.

**Standing-check notes.**

- **Step 3** changes what every statement *groups* by while leaving totals
  identical — the "two correct assertions with a gap between them" shape. Assert
  both that class totals are unchanged **and** that the grouping did move, or the
  migration passes by doing nothing.
- **Step 5** needs a fixture with a postable parent that has children, or the
  own-vs-rolled-up distinction is never exercised.
- **Step 7** needs a test that the per-project breakdown **sums to the
  unfiltered total** with Unassigned included (§7d).
- 🔴 **Every tree test needs a deliberately degenerate fixture** — a deep chain,
  a wide fan-out, and an attempted cycle. Our fixtures are all small and
  well-formed, which is the blind spot `tests/scale-and-collision.test.ts` exists
  for; an unbounded tree is exactly where it would bite.
