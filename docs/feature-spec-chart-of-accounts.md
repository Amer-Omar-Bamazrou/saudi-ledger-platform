# M13 — Chart of Accounts & GL classification

**Status: ✅ BUILT.** Design approved and implemented; see the "as built" notes at the end for what the implementation added or corrected. Money-touching; changes the posting path
every invoice, bill and payroll run goes through.

Fixes the HIGH finding recorded since M12.1b: *invoice revenue is misclassified in
the income statement*.

---

## 1. What is actually wrong — larger than recorded

The recorded finding is that `postJournalEntry` writes `accountId: l.accountId ?? null`
and the invoice path never supplies one, so the income statement's
`cat?.type ?? "expense"` files the Sales Revenue **credit** under expenses. That
is true. Two further facts, established by reading the code and the database,
change the shape of the fix.

### 🔴 1a. There is no chart of accounts at all

**`categories` contains zero rows, and nothing ever creates any.** Not the seed,
not signup, not org creation. Every category in the system is hand-typed by a
user on the Categories page.

So "resolve `account_id` from `categories`" has **nothing to resolve against**.
This is not a wiring fix; the milestone must first *create* the thing being wired
to. It is another instance of the named failure mode — `categories` is a shape
whose consumer (the income statement) exists, but whose producer never did.

Measured on the local stack:

```
categories:  0
journal_entry_lines:  24 total, 24 with account_id IS NULL
  8 × "Accounts Receivable"   8 × "Sales Revenue"   8 × "VAT Payable"
```

### 🔴 1b. Setting `account_id` naively would DOUBLE-COUNT AR on the balance sheet

This is the trap, and it is why the AR question below is not optional.

`balanceSheet()` today does two things that only coexist because classification
is broken:

1. It buckets GL lines by `cat.type`. With `account_id` NULL the type is `""`,
   which matches **no** branch — so invoice GL lines contribute **nothing**.
2. It then adds `arBalance`, computed independently from the `invoices` table,
   straight into `totalAssets`.

The moment an AR line resolves to an `asset` category it lands in `assetItems`
**and** `arBalance` is still added — assets overstated by the full AR balance and
`balanced` goes false. The same applies to AP.

**Consequence: switching the balance sheet to GL-derived AR/AP is forced, not
optional.** Answered in §5.

---

## 2. Where `account_id` comes from — a system code, not a name

**Rejected: lookup by `account_name` at posting time.** The names in the posting
path (`"Sales Revenue"`, `"Accounts Receivable"`, …) are English literals in
code. A tenant renaming an account, translating it, or creating a near-duplicate
would silently break resolution — and silent breakage is the bug we are fixing.

**Chosen: a stable system code.** `categories` gains:

| Column | Purpose |
| --- | --- |
| `system_code` (text, nullable) | Stable identity: `AR`, `AP`, `SALES`, `VAT_OUTPUT`, `VAT_INPUT`, `PURCHASES`, `CASH`, `SALARIES`, `SALARIES_PAYABLE`, `GOSI_EXPENSE`, `GOSI_PAYABLE`. Unique per organization where not null. |
| `is_system` (boolean) | Protected: cannot be deleted, and its `type` cannot be changed. The name/`name_ar` REMAIN editable — the code is the identity, the name is a label. |

Postings name a code; a per-request resolver maps code → `category.id` for the
active organization. Renaming is safe. Deleting is refused.

**A default chart of accounts is seeded per organization** — at signup, at
`seedAdminUser`, and back-filled for existing orgs in the migration. Scope: the
~11 system accounts above plus a small set of ordinary expense accounts. It is
deliberately minimal; a full Saudi CoA template is a separate, larger piece of
work and is NOT this milestone.

**Org-scoped, not company-scoped.** `categories` has no `company_id` and the
schema comment already anticipates the question. A shared CoA across a
multi-company org is the correct default (it is a template, and consolidated
reporting needs common accounts). Noted as a future decision, not opened here.

---

## 3. Unresolvable account ⇒ FAIL CLOSED

**Decision: throw at posting time. Do not write a NULL.**

The argument, since it was asked for:

- **A NULL `account_id` IS the bug.** It does not fail — it silently misfiles
  revenue as a negative expense, on the primary financial statement, for every
  invoice ever issued, undetected for the life of the product. The failure mode
  we are replacing is precisely "carry on with a NULL".
- **It matches the platform's posture.** `requireIssuanceSeller` refuses a
  placeholder VAT number; the assembler refuses an ambiguous tax category; M12.8
  refuses to issue for an onboarded company it cannot build a document for. In
  each case the reasoning was that a wrong financial/legal record is worse than a
  refused one.
- **The usual objection does not apply here.** Fail-closed normally trades
  availability for correctness. But *we* control the chart of accounts: it is
  seeded at org creation and system accounts cannot be deleted, so an
  unresolvable code is only reachable if our own seeding failed. Fail-closed
  therefore costs nothing in normal operation and catches exactly the case we
  could not otherwise see.

Order matters: **seeding and delete-protection must land before the throw**, or
we ship a guard that fires in production. Sub-milestone order in §8 reflects that.

**Manual journal entries — a real behavioural change.** JE lines currently allow
a null account. A line with no account cannot be classified, so it is invisible
to the income statement and balance sheet in exactly the way this milestone
exists to fix. Proposal: **require an account on new manual JE lines**, leaving
existing rows to the backfill. This is a UI-visible change and is called out
rather than slipped in.

---

## 4. Backfill — yes, and it changes historical statements

Every automated GL line ever written has `account_id = NULL`. The posted account
names are a **closed set of 12 strings** emitted from our own code, so the
backfill is deterministic:

```sql
UPDATE journal_entry_lines l SET account_id = c.id
  FROM categories c
 WHERE c.organization_id = l.organization_id
   AND c.system_code = <mapping from l.account_name>
   AND l.account_id IS NULL;
```

Applied per organization, after that org's CoA is seeded, in the same migration.

**🔴 Historical reports will change, and that is the point.** A user who exported
an income statement last month and re-runs it will see revenue where there was
none and lower expenses. Net profit will not move. This is a correction of a
wrong figure, not a restatement of a right one — but it is user-visible and
should be communicated, not discovered.

Lines that match no system name (hand-typed manual JE accounts) keep
`account_id = NULL` and remain unclassified, exactly as today. They are reported
as a count so the residue is known rather than assumed.

---

## 5. AR from the GL — IN SCOPE, because §1b forces it

Not a follow-up: leaving the bolt-on in place while classification starts working
double-counts AR and AP.

**Change:** the balance sheet's `accountsReceivable` / `accountsPayable` come from
the GL (`system_code IN ('AR','AP')`), and the `allInvoices()` / `allBills()`
bolt-on is removed from `balanceSheet()`.

**Explicitly NOT moved to the GL:** AR/AP **aging**, customer statements and
customer balances. Those need a per-customer dimension that journal entry lines
do not carry. They stay invoice/bill-derived. Only the balance-sheet *total*
moves.

**The agreement test is the deliverable, not a nicety.** A permanent test asserts
GL-derived AR **equals** invoice-derived AR (and AP likewise) across a fixture
covering invoices, credit notes, debit notes, partial payments and full
settlement. A divergence means something posted to AR that no invoice explains,
or an invoice that never posted — which is a genuine reconciliation defect worth
catching. Worth considering as a runtime warning on the balance sheet later; not
in this milestone.

---

## 6. Income statement — before and after

A single 1,000 SAR invoice at 15% VAT (Dr AR 1,150 / Cr Sales 1,000 / Cr VAT 150):

| | Before | After |
| --- | --- | --- |
| Revenue | **0** (nothing classifies as income) | **1,000** — Sales Revenue |
| Expenses | **−1,000** (the Sales credit filed as a negative expense) | **0** |
| Net profit | 1,000 ✅ | 1,000 ✅ |

Net profit is right in both — which is exactly why this survived. The composition
is wrong, and composition is most of what an income statement is for.

**The acceptance test:** issue an invoice through the real approval path, then
assert through the real report service that `revenue` contains Sales Revenue at
the net amount, that `expenses` does **not** contain it, and that VAT is in
neither (it is a liability, not income). Written to the M10 zero-movement
standard — real ledger rows, not fixtures.

---

## 7. Blast radius — what a user sees move

| Report | Change |
| --- | --- |
| **Income statement** | Revenue appears (was 0); expenses fall by the same amount. **Net profit unchanged.** Affects every period containing invoices. |
| **Balance sheet** | AR/AP become GL-derived (totals should be identical — that is the §5 test). **VAT Payable appears as a real liability** for the first time. **Retained earnings changes**, because income/expense lines now classify. Totals should not move; `balanced` must hold. |
| **Trial balance** | Rows gain a real `type` instead of `"other"`; grouping key moves from account *name* to account *id*. Debits/credits unchanged. |
| **GL report / journal report** | Unchanged amounts; lines now carry an account reference. |
| **Cash flow, VAT return, Zakat, dashboard summary** | **Unaffected** — they read `transactions`, not the GL. Verified, and a test should pin it so this milestone cannot quietly move a tax figure. |
| **AR/AP aging, customer statement, customer balance** | **Unaffected** — still invoice/bill-derived (§5). |

**Figures that move:** revenue (0 → real), expenses (down by the same), VAT
Payable (absent → real), retained earnings.
**Figures that must NOT move:** net profit, total assets, total liabilities +
equity, every tax figure. Each gets an assertion.

---

## 8. Multi-company: fold in `checkPeriodOpen` (queue A4) — YES, adjacent

`checkPeriodOpen` is called by `postJournalEntry` — the exact function this
milestone rewrites — and the fix is to add `company_id` to one `WHERE` clause.
`journal_entries` already carries `company_id`. Same file, same call path, one
test. Genuinely adjacent, so it is folded in.

**Not folded in:** the period-lock *routes* scoping by period alone (a separate
LOW finding in the routes layer), and company-scoping the chart of accounts (§2).
Those are not adjacent and stay queued.

---

## 9. Build order

Ordered so no step ships a guard that can fire:

1. **Schema + seeding** — `system_code`/`is_system`, seed a CoA per org, protect
   system accounts from delete and type-change. Nothing depends on it yet.
2. **Backfill** — map the 12 known names to codes; report the unmatched residue.
3. **Resolution + fail-closed** — `postJournalEntry` takes a system code and
   throws when it cannot resolve. Safe only because 1 and 2 landed.
4. **Balance sheet AR/AP from the GL** + the agreement test (§5).
5. **`checkPeriodOpen` company scoping** (§8).
6. **Acceptance + blast-radius tests** (§6, §7).

## 10. Open questions for the owner

1. **Manual JE lines** — require an account going forward (§3)? It is the
   consistent choice and a UI-visible change.
2. **Historical restatement** — anything beyond a release note? Past exported
   statements will not match a re-run.
3. **CoA depth** — minimal system set now (proposed), or a fuller Saudi template?
   The latter is its own milestone.


---

## 11. As built — what changed from the design

The design held. Four things the build added or corrected, all recorded because
they were found by the work rather than anticipated by it.

### 🔴 The fail-closed guard immediately found the real hole

Migration `0024` seeded the chart for every organization existing at that moment,
and signup seeds new ones. **That covers two paths and misses every other** —
the seed script, the test fixtures, and any future code creating an organization
with a plain INSERT. All 22 DB-backed suites failed instantly with
`Chart of accounts is incomplete`, which is the guard doing exactly its job.

Rather than ask every call site to remember, migration `0025` makes it
structural: a **DB trigger seeds the chart on `INSERT INTO organizations`**, so
an organization cannot exist without one. Same discipline as append-only
`audit_logs` — if it matters, the database guarantees it, not a convention.

Two consequences followed:
- **One canonical template.** The account list lived in TypeScript *and* in
  0024's SQL. It is now a `system_account_templates` table that both the
  backfill and the trigger read from, with a test asserting it agrees with
  `chartOfAccounts.ts`.
- **`categories` cascades on organization delete.** Every org now owns 11 rows
  it never asked for, so `DELETE FROM organizations` failed the FK and broke
  every teardown path. Cascading is also correct: the chart is created with the
  org and is meaningless without it.

### The system-account guard protects the APP ROLE, not the owner

The first trigger blocked every delete including the owner connection, which
broke legitimate teardown and protects nothing real (the owner runs migrations).
It now applies to non-owner roles only — the same owner/app-role boundary used
everywhere else. `name` and `name_ar` remain editable; `type`, `system_code` and
deletion do not.

### Bills: the one line whose account the USER chooses

A bill's `debitAccount` is free text supplied per bill. Resolving it **by name**
is correct here — it is the user naming their own account, which is a different
thing from resolving our hardcoded literals. If it matches an account in their
chart we honour it; otherwise the line still classifies correctly as an expense
via `PURCHASES`, keeping their text as the label. `GLLine` is therefore a union:
`systemCode` (ours) **or** `accountId` (theirs), never neither — the type system
makes a NULL account unrepresentable.

### 🔴 A correction to §7: the VAT return does NOT read `transactions`

§7 said cash flow, VAT and Zakat all read `transactions` and were therefore
unaffected. **Wrong about the VAT return** — it is computed from INVOICES and
BILLS. The conclusion still holds (M13 does not touch invoices), but for a
different reason than stated.

This is exactly why the guard was written as a **property** rather than a fixed
figure: the test posts a GL-only journal entry with no invoice, bill or
transaction behind it and asserts every VAT box, the Zakat base and cash flow are
byte-identical, then asserts the income statement DID move so the check is not
vacuous. It isolates the ledger as the only variable, survives fixture changes,
and fails for exactly one reason — a tax report started reading the GL.
