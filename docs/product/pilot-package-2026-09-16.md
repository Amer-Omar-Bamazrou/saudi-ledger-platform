# Controlled accountant pilot — the package

**Status (2026-09-16): a DATED artifact for one supervised pilot, written
against main at `80f3ee8` (PR #160 merged). Current state authority:
CLAUDE.md §2; the audit behind the boundaries: findings file, "THE
SEVEN-WORKFLOW AUDIT"; the five closed blockers: known-issues file, "THE
FIVE PILOT BLOCKERS — CLOSED 2026-09-15".** Nothing in this document is a
new feature or a new setup mechanism; every step names the existing
screen, script or route that performs it.

Scope: one accountant, one company, supervised, on synthetic data. Not a
deployment decision, not Part 2, not a backlog.

---

## 0. Where the pilot runs — the decision you have to make first

Nothing is deployed today. Two options exist in the repository as it
stands; both are real, and they differ in cost and in what the accountant
experiences.

### Option A — a machine you control, in development mode

The accountant sits at (or remotes into) a laptop running the stack the
way `docs/local-setup.md` describes: local Postgres via the Supabase CLI,
the API on :3000, the web app on :5173, `NODE_ENV=development`. This is
exactly the environment every verification in this repository has run in.

What it requires: the machine, the four prerequisites in `local-setup.md`
§1 (Node 24, pnpm 11, Docker, Supabase CLI), and your presence — the pilot
is supervised, and in this mode you are also the operator. What it does
not require: a domain, a mail provider, a KMS key, an alert webhook, or any
account with a third party. Sandbox ZATCA onboarding works here (it needs
no account and accepts any OTP — CLAUDE.md §4).

What the accountant loses: nothing in the workflows. What you lose: the
"send" leg of an invoice (there is no email provider in development, and
the send button waits on one — §5 L1), invitation emails (the invite link
is returned on screen instead and you hand it over), and the deployment
evidence that a hosted run would give you.

**This is the recommended shape for a first, supervised pilot.** It is
the only environment in which the exact code that passed the gate has
been exercised end to end, and it needs nothing you do not already have.

### Option B — hosted, on Railway, from the existing Dockerfile

The repository carries a multi-stage `Dockerfile` (builds the API and the
web app, serves the built frontend from the API process via
`SERVE_WEB_DIST`), a `railway.json` (Dockerfile build, migrations as the
pre-deploy command, `/api/healthz` as the health check), and a step-by-step
runbook written for the demo:
[`docs/product/demo-deployment-runbook.md`](demo-deployment-runbook.md).
That runbook is for the DEMO tenant (`DEMO_MODE=true`, a weekly reset);
for a pilot you would set `DEMO_MODE=false` and create the pilot company
as in §1 below. Everything else in it applies.

What it requires, because `NODE_ENV=production` REFUSES to boot without
them (`packages/config/src/env.ts`, the production refinements):

| Requirement | Why the boot refuses without it | You have it? |
| --- | --- | --- |
| A mail provider — Resend or Postmark — with a verified sending domain: `MAIL_PROVIDER`, `MAIL_API_KEY`, `MAIL_FROM` | `none` is refused in production: renewal reminders and invitations must be deliverable | **Yes** (mail and a domain are now available) |
| An alert destination: `ALERT_PROVIDER=webhook`, `ALERT_WEBHOOK_URL` (a Slack incoming webhook is the fastest) | `none` is refused: an unwired alarm is the thing B2 exists to prevent | A webhook to create |
| A real AWS KMS key: `ZATCA_KMS_PROVIDER=aws-kms`, `ZATCA_KMS_KEY_ID`, region and credentials | `local-dev` is refused: it would wrap tenant signing keys with a value from a file | An AWS account and one symmetric key (~$1/month) |
| `SESSION_SECRET` ≥ 32 chars, `CORS_ALLOWED_ORIGINS` = the app's URL, a Railway Postgres | Ordinary boot requirements | Railway account |
| `ZATCA_WORKER_ENABLED=false` (the default) | Transmission needs a real entity; sandbox onboarding still works | — |
| `AI_PROVIDER=none` (the default) | Groq is refused in production until the Enterprise agreement is attested | — |

Three deployment-time items from CLAUDE.md §5 also apply the moment this
is public: the real `TRUST_PROXY_HOPS`, the KMS policy verification (C3),
and the archive directory being inside the container and lost on
redeploy (the runbook says so; `ZATCA_ARCHIVE_PROVIDER=local-fs`).

What Option B costs you beyond Option A: the three accounts above, the
runbook's six verification checks, and the fact that the hosted build has
NOT been exercised end to end by anyone yet — the runbook was written for
the demo and its checks were designed, not run. The mail leg and
invitations then work.

**Recommendation:** run this first pilot as Option A. Take Option B when
you want a second accountant, remote access, or the mail leg — the
runbook is the path, and the three accounts are the whole cost.

---

## 1. Creating the pilot company

There is no "create organization" screen for an operator. Two supported
mechanisms create a tenant; use the first.

### 1.1 The signup gate (the product's own path — use this)

1. Open the app, **Sign up** (`/signup`). Enter the company name, the CR
   number (10 digits) and the VAT number (15 digits, starting and ending
   with 3 — a valid-format test number is fine, e.g. `300000000000003`),
   your full name, the admin email and a password. This creates the
   organization, its first company, the admin user and an active admin
   membership, with the organization in **`pending_review`**
   (`signup.service.ts`).
2. Approve it. The verification gate 403s every business route until a
   **platform operator** approves the application. Seed an operator once
   (this is the only step that touches the shell):

   ```powershell
   $env:DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
   $env:SEED_OPERATOR_EMAIL = "operator@yourdomain"; $env:SEED_OPERATOR_PASSWORD = "<12+ chars>"
   pnpm --filter @workspace/db run seed
   ```

   The seed is idempotent. Log in as the operator, open **`/operator`**,
   and approve the pilot application. (The operator is a platform-level
   identity in `platform_operators`, not a member of any tenant.)
3. Log in as the pilot admin. The organization is approved; every route
   answers.

### 1.2 Company settings (`/company` — Company Settings)

Set these before any invoice is issued. Issuance **fails closed** on a
missing VAT number (the walk of 2026-09-15 hit exactly that 400), and the
ZATCA checklist wants the rest:

- Legal name, **Arabic legal name** (required on the e-invoice).
- **VAT registration number**, **CR number** (both entered at signup; confirm).
- **Fiscal calendar** (Gregorian) and **fiscal year start** (month). Set it:
  every dated report defaults to the fiscal year, and the pages say "you
  have not set your fiscal year" until you do.
- **Ownership type** — needed only for the Zakat page's applicability
  message; the Zakat module is held (§5 C10), so this is cosmetic here.
- National address: building number (4 digits), street, district, city,
  postal code (5 digits). 🔴 The ZATCA onboarding checklist ALSO requires
  an **additional number** (KSA-23), and Company Settings has **no field
  for it** — so the checklist cannot go green from the UI (known-issues
  file, "ZATCA ONBOARDING UNREACHABLE FROM THE UI", 2026-09-16).
- **Logo** (optional): PNG/JPG/SVG up to 2 MB; prints on the PDF.

### 1.3 Chart of accounts (`/categories`)

Seeded automatically for every new organization by the org-seed trigger:
40 system accounts (AR, AP, Cash and Bank, Sales, Purchases, VAT input
and output, GOSI, the transfer accounts, and the expense families) with
Arabic names. **Nothing to do** unless the accountant wants extra accounts:
the Categories page creates an account of any type (income, expense,
asset, liability, equity). There is no rename or delete (§5 traps; the
coming-soon "Chart of Accounts settings" says so). The chart has **no
owner-equity or retained-earnings account by default** — the seeded
equity account is the external-transfers one. If the accountant wants an
opening entry, create an "Owner Equity" account here first (type equity).

### 1.4 Branch or department

**Not required and not usable.** `branches` and `departments` are tables
with no consumer (CLAUDE.md §5, S6/S7). Nothing in the product reads them.

### 1.5 Bank accounts (`/bank-accounts`)

Create at least two (the pilot needs to switch the default): name, bank,
IBAN, account number, SAR only (the API refuses any other currency),
opening balance. Then click **"Use on invoices"** on the one whose details
should print on the PDF; the page states which account invoices show.
One effective default is enforced on the server (#160, item 5).

Know this before the accountant does: the card's balance is the typed
opening figure. Imports and postings never move it, and the opening
balance never reaches the ledger (audit; §8 below).

### 1.6 ZATCA onboarding (`/zatca`) — sandbox

🔴 **Pilot decision (owner, 2026-09-16): NOT onboarded.** Runbook §3.2
step 3 records why; the paragraphs below describe what onboarding does
when it is reachable. Today it is not: the checklist needs an additional
number the company form cannot set.

Optional, but the pilot should do it to exercise the chain. Once the
company details above are complete, the page's checklist goes green;
click **Onboard with ZATCA** and enter any OTP (the sandbox accepts any).
That runs the six compliance documents against the live sandbox and
stores a credential. From then on every approved invoice mints an ICV, a
hash and a QR **and** builds a signed e-invoice document into the outbox.
The outbox worker is off (`ZATCA_WORKER_ENABLED=false`), so nothing is
transmitted — which is correct: transmission needs a real entity.

🔴 Onboarding changes one behaviour the accountant must know (see §8):
once a credential exists, an invoice line at **0% VAT cannot be issued
from the UI**, because the form has no tax-category picker and the
e-invoice builder refuses a zero-rated line whose category (Z/E/O) is
unstated. Before onboarding the same invoice issues, with no e-invoice.

### 1.7 What NOT to use

- `pnpm --filter @workspace/db run seed` with `SEED_ADMIN_*` creates the
  admin in the **`default`** organization — the developer tenant with
  months of mixed data. Do not put the pilot there.
- `seed:sample` fills the admin's org with a fixed dataset (§3); usable
  ONLY if you choose it deliberately as the pilot's starting data — see §3.
- `DEMO_MODE` and the demo seed create the `demo` organization with a
  weekly reset. Not for the pilot.

---

## 2. The accountant's user, role and permissions

**The role: `accountant`.** Verified in `packages/db/src/permissions.ts`,
the four-role model (admin · accountant · bookkeeper · viewer) seeded as
the permission matrix and enforced by `requirePermission` on every
business route. `accountant` holds:

- **read** on everything a tenant can see;
- **create** and **update** on customers, vendors, products, invoices,
  bills, quotations, purchase orders, journal entries, transactions,
  employees, assets, bank accounts, budgets, categories, recurring rules;
- **approve** — the activation authority: post, approve, pay, reject,
  reverse — on invoices, bills, quotations, purchase orders, journal
  entries, transactions, payroll.

What `accountant` does **not** hold, and should not for a pilot:

- **delete** on any record — admin only. (Drafts can still be sent back
  or rejected; a posted transaction's delete reverses its entry — #160.)
- **period locks** — lock and unlock are admin only. The pilot's period
  test (§4.5) therefore needs YOU as admin to lock the month, or the
  accountant to hold admin for that step. Recommendation: keep the
  accountant on `accountant`, and perform the lock yourself as the admin
  while they watch; then they attempt the closed-period mutation.
- **company settings update**, **ZATCA onboarding**, **users**, and the
  **audit trail** (`audit_logs` read is admin only) — so the accountant
  cannot read the audit trail themselves. For the audit-trail evidence
  in §4.5 you open `/audit-trail` as admin.

**Membership:** users belong to an **organization** through
`organization_memberships` (role + status); the company is resolved per
request from the org's active company. There is no per-company or
per-branch membership and none is needed.

**How to create the user:** as the pilot admin, **`/users`** → **Add
User** — email, full name, temporary password, role `accountant`. This
creates the user and the membership in one act (no email needed). The
alternative, **Invitations** on the same page, returns the accept link on
screen when no mail provider is configured (Option A), so you can hand it
over; with mail (Option B) it is emailed.

Do not create a new role. Do not give the accountant `admin` for the whole
pilot: the delete and lock authority would let a wrong click erase
evidence the pilot exists to produce.

---

## 3. Sample data — the minimum that exercises the product

Two ways to get it. Choose one.

### 3.1 Let the existing sample seeder do it (fast, fixed, already verified)

```powershell
$env:SEED_ADMIN_EMAIL = "<the pilot admin's email>"
pnpm --filter @workspace/api-server run seed:sample
```

It reads `apps/api/.env`, finds the admin's organization, and writes
**through the product's own services** (every invoice created as a draft
then approved, so GL, VAT and audit rows are real). It sets the company's
VAT and CR to valid-format test numbers. It creates: 2 customers (Najd
Contracting, Rawabi Logistics), 2 vendors (Gulf Office Supplies, Tamimi
Facilities), 1 bank account (Main Operating Account, Al Rajhi), **5 issued
invoices** dated June–August 2026 (one paid in full, one part-paid, the
rest open — the June/July ones are **overdue** today), **3 approved bills**
(one paid), **5 accepted bank transactions** (uncategorised on purpose, so
they sit in SUSPENSE until reviewed), 1 approved quotation, 1 approved
purchase order. Re-running is a no-op. It does **not** create: a credit
note, a partially paid bill, a manual journal entry, a pending (unmatched)
statement import, a second bank account, or a 0%-VAT document. Those the
accountant creates in §4, which is the point.

Caveat: it runs against `apps/api/.env`'s database and names the admin by
email — it is the pilot org only if the pilot admin's email is the one
you pass.

### 3.2 Or the accountant enters it (slower, and it IS the test)

The dataset below is what §4 needs. Entering it through the screens is
itself the first half of the pilot. Amounts are small and round so the
figures can be checked by hand.

| Master data | Detail |
| --- | --- |
| Customer **A** "Al-Wadi Trading" | VAT number `310000000000003`; the payment and allocation customer |
| Customer **B** "Sahara Consulting" | For the overdue invoice and the credit note |
| Supplier **P** "Desert Office Supplies" | For the partial-payment bill |
| Supplier **Q** "Riyadh Facilities" | For the PO → bill conversion |
| Products | **Not required.** Invoice and bill lines are free text with quantity, unit price and VAT rate; the product picker is optional. Skip, or add one "Consulting hour, 500.00" to exercise the picker |
| Accounts | None beyond the seeded chart, plus one "Owner Equity" (type equity) if an opening entry is wanted |
| Bank accounts | Two: "Main SAR" (the invoice default) and "Payroll SAR" — the second exists to prove the default switches |

| Documents | Detail |
| --- | --- |
| Quotation Q1 to customer A, 2 lines, 15% | Submit → approve → **convert** to invoice I1 |
| Invoice I1 (from Q1) | Approve; PDF both languages; pay in full |
| Invoice I2 to customer A, 1 line 3,000.00 + 15% | Approve; **pay 1,000.00** (partial) → stays `sent`, aging shows the residual |
| Invoice I3 to customer B, dated two months ago, due one month ago | Approve → **overdue** in the list and aging |
| Invoice I4 to customer B, 500.00 + 15% | Approve; **pay in full**; then credit note **CN1** for 200.00 + 15% against it → the refund case (a negative receivable, see §8) |
| Credit note **CN2** for 300.00 + 15% against I2 (unpaid part) | Approve → I2's outstanding drops; VAT return box 6 drops |
| Debit note **DN1** for 100.00 + 15% against I1 | Approve → posts like an invoice |
| Purchase order PO1 to supplier Q, 1,500.00 + 15% | Submit → approve → **Record bill** (the page's conversion control) → bill B1 |
| Bill B1 (from PO1) | Choose the expense account (e.g. Rent & Utilities) at entry; submit; approve from **Approvals** as a second act → posts to the chosen account (#160 item 4) |
| Bill B2 from supplier P, 800.00 + 15% | Post; **pay 400.00** → stays `received`, AP aging shows 520.00 remaining; then pay the rest |
| Journal entry J1 | 2 lines, e.g. Dr Bank Charges 75 / Cr Cash and Bank 75, dated this month; post |
| Bank statement S1 (CSV upload) | 6 rows, each worded for one matching rule (the runbook §3.3 has the exact amounts; corrected 2026-09-16 to what the seeded data actually matches): a credit with the paid invoice's number in the description (matched by number, full); a 10,000.00 credit with **INV-2026-000003's number** in the description (matched by number, **partial** — an amount-only partial is never suggested); a 520.00 debit with the partial bill's number (matched by number, full — its second instalment); a debit "OFFICE RENT 3,000" (categorised); a debit "INTERNAL TRANSFER TO PAYROLL ACCOUNT 5,000" (recognised as a transfer by the `internal transfer` rule — a bare "TRANSFER TO PAYROLL" is booked as Salaries by the round-amount heuristic, probed 2026-09-16; declare as own-account after accepting); and a credit "UNKNOWN DEPOSIT 250" (accept uncategorised → SUSPENSE) |
| Manual transaction M1 | The Upload page's **Manual Entry** tab submits through the IMPORT path, so a typed row lands in Review as pending like any statement row — accept it there. The immediately-posting manual create (#160 item 2) is API-only today: no page calls it. Exercise it by API if you want the evidence, or leave it out |

VAT scenarios the product supports from the UI: standard 15% lines;
mixed-rate lines on one document; a 0% line — which issues on a company
that is NOT ZATCA-onboarded and is refused at approval on one that is
(§8). Exempt and out-of-scope categories are not selectable in the form.

---

## 4. The accountant's workflow checklist

Record, for every step: the document number, the screen, the figure
shown, and what the ledger shows (Journal Entries page, or Trial Balance
for the total). "Evidence" means a screenshot or the number written down
at the time — not a recollection.

### 4.1 Sales

1. **Customer** (`/customers` → New): create A and B. Evidence: the row,
   the VAT number shown.
2. **Quotation** (`/quotations` → New): Q1 to A. Submit, approve (Approvals
   page or the quotation's own controls). Evidence: status `approved`;
   nothing appears in any report (a quotation moves nothing).
3. **Convert** Q1 → invoice (the quotation's Convert control). Evidence:
   invoice I1 exists as a **draft** with Q1's lines and a
   server-allocated number; the quotation shows its conversion.
4. **Approve** I1 from **Approvals** (`/approvals`): Submit, then Approve.
   Evidence: status `sent`; on the invoice row the PDF (ع) and EN links
   appear; the Journal Entries page shows `GL-<number>` — Dr AR / Cr Sales
   / Cr VAT Payable; if onboarded, the invoice detail shows an ICV.
5. **PDF**: open both renderings. Evidence: the Arabic tax invoice shows
   the Hijri and Gregorian dates, seller VAT and CR, the customer's VAT,
   the line, 15% VAT, the QR, and the **bank details of the default
   account**. Switch the default on `/bank-accounts`, reopen the PDF:
   the details change.
6. **ZATCA** (if onboarded): `/zatca` shows the credential; the invoice
   has a document in the outbox (status pending — the worker is off).
   Evidence: the ICV increments by one per approved document, credit
   notes included.
7. **Payment**: Mark Paid on I1 (full) → status `paid`; on I2 pay 1,000
   → status stays `sent`. Evidence: `GL-<number>-PAY-<id>` entries, Dr
   Cash and Bank / Cr AR; I2's row shows 1,000 paid.
8. **AR**: `/ar-aging` — I2's residual, I3 overdue with its days, I4 at
   −230 after CN1 with **0 days** (a credit owed is not overdue).
   Evidence: the aging total equals the balance sheet's AR line.
9. **Customer statement**: customer A → **Open statement**. Evidence: I1,
   I2, DN1 listed; note what it does NOT show (§8: it is an open-items list
   by invoice date, not a dated statement).
10. **VAT return** (`/vat`): box 1 sales, box 6 output VAT, net after the
    credit notes. Evidence: box 6 moves by exactly the VAT of each approved
    document, sign included.

### 4.2 Purchases

1. **Supplier** (`/vendors` → New): P and Q, with VAT numbers.
2. **PO** PO1 to Q: submit, approve, then **Record bill** on the PO (the
   conversion control; the page calls it billing, not converting).
   Evidence: B1 as a draft carrying PO1's lines, vendor and VAT, and the PO's
   billing state moving to fully billed.
3. **Bill B1 — the two-person path**: on the draft choose the expense
   account (the picker on the New/Edit Bill dialog), **submit**, then as a
   second act **approve from Approvals** — the queue row shows "B1 →
   <account>". Evidence: `BILL-<number>` posts Dr <chosen account> / Dr
   Input VAT / Cr AP, not Purchases.
4. **Bill B2 — one-person path**: New Bill, post directly, choosing an
   account in the post-review dialog. Evidence: the same shape.
5. **Partial payment**: pay 400 on B2 → status `received`, `/ap-aging`
   shows 520 remaining with its days. Pay 520 → `paid`, drops out of
   aging. Evidence: two `-PAY-` entries with distinct numbers.
6. **AP and VAT**: balance sheet AP equals AP aging; VAT return box 13
   (input VAT) moves by each posted bill's VAT; drafts move nothing.

### 4.3 Credit notes

1. **CN2 against I2** (`/credit-notes` → New credit note, pick I2, reason,
   lines): approve from Approvals. Evidence: `GL-<CN number>` — Dr Sales /
   Dr VAT Payable / Cr AR; I2's outstanding = total − paid − credited; box
   6 reduced; aging nets it; the statement lists it as a negative row.
2. **DN1 against I1**: approve. Evidence: posts in the invoice direction;
   box 6 increases.
3. **CN1 against the PAID I4**: approve. Evidence: aging shows I4 at −230,
   0 days; the balance sheet AR still equals aging. Then note the boundary:
   there is no screen to pay the customer back or apply the credit to the
   next invoice (§8).
4. **Negative cases — record these deliberately:**
   - On a credit note row (status `sent`) there is **no Mark Paid**. Try
     the API if you like: `POST /invoices/<cn id>/pay` → 409 "A credit or
     debit note cannot be paid". Evidence: no payment row, no journal entry,
     status unchanged (#160 item 1).
   - The same for a debit note.
   - Paying more than I2's credit-aware outstanding → 409.
5. **Reports**: income statement revenue net of the credit note; VAT
   return; the customer statement.

### 4.4 Banking

1. **Upload S1** (`/upload`, CSV tab, the page's template columns). Evidence:
   6 rows land in **Review** (`/review`) as pending; nothing has moved yet
   (the trial balance is unchanged — record it before and after).
2. **Matching**: rows referencing I1's number and I2's 1,000 show a
   suggestion; **Settle** each against its invoice. Evidence: the invoice's
   paid amount moves; the row becomes a settlement; NO new `TXN-` entry
   (the cash effect belongs to the pay path).
3. **Categorise** "OFFICE RENT" to Rent & Utilities and accept. Evidence:
   `TXN-<id>` Dr Rent & Utilities / Cr Cash and Bank.
4. **Uncategorised** "UNKNOWN DEPOSIT": accept without a category.
   Evidence: posts to **Suspense**, not to income; the Finance Hub's
   liquidity note mentions the suspense balance.
5. **Transfer**: accept "INTERNAL TRANSFER TO PAYROLL ACCOUNT"; on
   `/transactions` declare where it went (own account). Evidence: the
   posting moves from Transfers awaiting declaration to Transfer clearing;
   the P&L is untouched. 🔴 A row the engine does NOT recognise as a
   transfer is accepted uncategorised (→ Suspense) and logged as feedback
   — never forced into an expense or revenue category to continue.
6. **Reconciliation** (`/analytics`, the cash section): bank movement vs
   ledger cash, itemised; `unexplained` = 0. Evidence: the figure.
7. **Correction**: re-categorise the rent row → the original entry is
   reversed and a new one posted. **Delete** a mis-imported accepted row
   (admin only — you do it): its entry is reversed, cash returns, the
   trail stays (#160 item 3).

### 4.5 Accounting controls

1. **Manual journal entry** J1 (`/journal-entries` → New Entry): two lines,
   balanced, real accounts; **Post**. Evidence: it appears in the trial
   balance; an unbalanced entry is refused.
2. **Manual transaction** M1: the Upload page's Manual Entry tab is an
   import (the row lands in Review, pending) — accept it and record the
   `TXN-<id>` entry. The direct manual-create route (#160 item 2) has no
   page; it is API-only and is not part of the accountant's checklist.
3. **Approval separation**: as `accountant`, create a bill and approve it
   from the queue; as a **bookkeeper** (create a second user with that role
   for this step) try to approve → 403. Evidence: the refusal toast.
4. **Period lock** (you, as admin, on `/closed-months` or the Finance Hub):
   lock last month. Then the accountant attempts, in that month: a new
   invoice, a new bill, a journal entry, a payment with a paid-at date in
   it (a payment cannot be dated from the UI — it is always dated the day
   it is recorded), and a bank row dated in it accepted from Review — one
   at a time and with **Accept ready** beside an open-month row. Evidence: each is
   refused with the closed-month dialog (423); the batch accepts the open
   row and names the refused one in a red notice, and the refused row
   stays in Review with no entry (fixed 2026-09-16; it used to return
   success and post nothing). 🔴 Lock the PREVIOUS month, never the
   current one — the pilot's own entries live there.
5. **Correction route**: for a wrong invoice, a credit note in the open
   month (works); for a wrong journal entry **the accountant created
   themselves**, **Reverse** on the Journal Entries page. Evidence: the
   reversal is dated **today**, the original stays in the books marked
   `reversed` (§8 on the dating). 🔴 The accountant must not reverse a
   document-generated entry (any number starting `GL-`, `BILL-` or
   `TXN-`, including their `-PAY-` entries) even though the control is
   offered: the document stays
   approved while its ledger effect is undone. The dating stays a policy
   question; nothing in code changed.
6. **Audit trail** (`/audit-trail`, admin): every create, approve, pay,
   lock, unlock and reverse above has a row with the actor. Evidence: the
   rows for one document from create to pay.
7. **Permissions**: as accountant, `/users` and `/audit-trail` are not
   offered; a direct request is 403.

### 4.6 The comparison, at the end

Record these on one sheet and reconcile them by hand:

| Figure | Where | Must equal |
| --- | --- | --- |
| AR | Balance sheet, AR line | AR aging total; Σ customer statement balances |
| AP | Balance sheet, AP line | AP aging total |
| Cash | Balance sheet, Cash and Bank | Trial balance cash; the reconciliation's ledger cash |
| Output VAT | Balance sheet, VAT Payable | VAT return box 6 − box 13 (net, for the period) |
| Revenue | Income statement | Σ approved invoices' subtotals − credit notes + debit notes (for the period) |
| Trial balance | Debits = credits, non-zero | — |

Any pair that disagrees is a **blocking** issue (§7). Note: the trial
balance has no opening column, so for a period that starts after the
first entry it will not tie to the balance sheet's cumulative lines (§8).

---

## 5. What is safe to test

**Safe and supported** — every step has a control, a writer, a reader and
a test on real rows:
sales (customer → quotation → convert → approve → PDF both languages →
full and partial payment → AR aging → VAT return); purchases (supplier →
PO → convert → bill with a chosen expense account by either path → full
and partial payment → AP aging → VAT); credit and debit notes against
unpaid or part-paid invoices (GL, VAT, aging, ZATCA 381/383, PDF); bank
statement import → review → categorise / suspense / settle / declare
transfer → the cash reconciliation; manual journal entries and their
reversal; the approval separation; period lock and
its refusals on every posting path; the audit trail; sandbox ZATCA
onboarding and the ICV chain; the statements and the VAT return on the
above.

**Supported, with limitations the accountant must be told** (§8 has each
one): the customer statement's shape; a credit note against a paid
invoice; the reversal's dating; 0% VAT once onboarded; the bank card's
balance; the trial balance's missing opening column; converted-bill
numbering.

**Not ready — must not be presented as pilot-ready:** fixed assets
(register only; nothing reaches the GL; capitalisation from a bill is
impossible); migration of a business with history (no opening flag; a
journal entry to AR is invisible to aging); Zakat (held on the advisor);
payroll (approves and posts, but the run is dated by approval, not by
period, and the module has not been walked for this pilot); withholding
tax and advance payments (unbuilt, legal exposures on the owner's ranking);
live bank feeds; anything on the coming-soon list; ZATCA transmission,
simulation or production; emailing an invoice.

---

## 6. Reset and recovery

**There is no reset for a real tenant.** Stating it plainly:

- No delete-organization route exists. `orgs.ts` deletes members and
  invitations only.
- The demo reset (`demoReset.service.ts`) **refuses** to run on a database
  that holds any organization other than `demo` — by design, and it is
  the right refusal.
- The e2e suite's `global-setup.ts` wipes and recreates the `e2e-smoke`
  org by slug, deriving the table set from `information_schema` — a
  wipe mechanism, but pinned to that one slug and to the test database.
  Do not point it at the pilot.

What exists, in order of preference:

1. **Correct through the product.** Wrong draft → edit or delete it (drafts
   only). Wrong issued invoice → a credit note. Wrong posted journal entry
   → Reverse. Wrong accepted bank row → re-categorise (reverses and
   re-posts) or, as admin, delete (reverses). Wrong bill → there is no
   correction document (§8); reverse its journal entry from the Journal
   Entries page and record the bill as the residue. This is also what the
   pilot is measuring, so prefer it.
2. **Start a fresh pilot company.** Sign up a new organization (§1.1),
   approve it, re-enter or re-seed. The old one stays in the database,
   isolated by RLS, invisible to the new tenant. Cheap, clean, and the
   recommended recovery when the data is beyond correction. Disposable
   pilot companies are the reset mechanism.
3. **Reset the whole local database** (Option A only, and only if nothing
   else on it matters): `supabase db reset` rebuilds Postgres from the
   migrations; then re-seed the operator and sign the pilot up again.
   Destroys the `default` and `e2e-smoke` orgs too. Not for Option B.

No mechanism deletes a single company's data in place, and none should be
built for this pilot.

---

## 7. Issue capture

One row per issue, in whatever tool you use; the fields are the contract.

| Field | Content |
| --- | --- |
| **Id** | `P1-001` … sequential |
| **Workflow** | sales · purchases · credit-note · banking · controls · reporting · setup |
| **Trying to do** | One sentence, the accountant's intent |
| **Steps** | Numbered, from the screen they started on, with the document numbers |
| **Expected** | What an accountant expects the system to do or show |
| **Actual** | What it did or showed, verbatim where there is a message |
| **Accounting impact** | none · wrong figure on a report · wrong ledger entry · missing ledger entry · irreversible record · unclear |
| **Severity** | **blocking** (cannot continue, or the books are wrong) · **major** (a wrong figure or a workaround needed) · **minor** (cosmetic with no figure affected) · **UX** (confusing but correct) |
| **Kind** | accounting-correctness · workflow gap · UX · missing feature · accounting-policy question |
| **Evidence** | Screenshot(s); the journal entry number(s); the trial balance before and after if a figure moved |
| **Comments** | Anything else, including "this is in §8" if it is a known limitation observed |

Rules: an observed §8 limitation is still logged, marked as known, so the
pilot produces a count of how often each one bites. A policy question is
logged as a question, never answered on the form.

---

## 8. Limitations to disclose before they start

Only those that a pilot on the §3 data will actually meet. Each carries
its handling.

| Limitation | What the accountant will see | Handling |
| --- | --- | --- |
| **The customer statement is an open-items list** by invoice date with a lifetime paid column; payments are not dated lines; no opening balance; a row's outstanding ignores credit notes while aging nets them | A statement for a month does not show that month's receipts against earlier invoices; a credited invoice's row and the total disagree | **Safe to work around**: use AR aging and the invoice list for balances; treat the statement as "open items as of now". Not a period statement. |
| **A credit note against a paid invoice has no refund path** | I4 shows −230 in aging, 0 days, forever; nothing pays it out or applies it to the next invoice; a manual journal entry would fix the GL and leave aging at −230 | **Should be avoided** beyond the one deliberate test in §4.3; do not "fix" it with a journal entry during the pilot |
| **Reversals are dated today**, not the original's date | Reversing a journal entry (or re-categorising / deleting a posted bank row) moves the correction into the current month; the original month keeps the figure | **Accounting-policy question** — record it, do not decide it: *when a posted entry is reversed, should the reversal carry the original date, today's date, or a chosen date, and what does the closed-period rule then mean for it?* The current behaviour is "today", which is what makes a closed month uncorrectable for its own entries. |
| **0% VAT lines cannot be issued once ZATCA-onboarded** | Approving an invoice with a 0% line fails with the issuance-blocked message; the same invoice issues on a non-onboarded company | **Not implemented** (no Z/E/O picker in the form). Keep pilot invoices at 15%, or test 0% before onboarding and record it. |
| **The bank card's balance is the typed opening figure** and the opening balance never reaches the ledger | The bank page shows one number, the trial balance another; the reconciliation is movement against movement, not statement against ledger | **Safe to work around**: read cash from the balance sheet; the reconciliation's `unexplained` is the check |
| ~~**Bulk-accepting a row dated in a closed month returns success** while the row stays unposted~~ **FIXED 2026-09-16** | A single row's Accept raises the closed-month dialog; a batch accepts the open rows, names the refused ones, and leaves them in Review with no entry (known-issues file, "BULK ACCEPT INTO A CLOSED MONTH — CLOSED 2026-09-16") | **Safe to test** as a refusal. The earlier claim that single-row acceptance refused correctly was wrong — it took the same swallowed path |
| **The trial balance has no opening column** | A period that starts after the first entry does not tie to the balance sheet's cumulative lines | **Safe to work around**: run the trial balance from the fiscal year start |
| **A converted bill takes the supplier's reference as our bill number** | Two suppliers quoting the same reference make the second conversion fail with a server error | **Safe to work around**: type a bill number on conversion |
| **A bill has no correction document** | A wrong posted bill can only be reversed at the journal level; the bill stays `received` | **Not implemented**; correct at the journal level and log it |
| **Overdue counts fully credited invoices and issued notes** | An invoice fully credited but never "paid" stays overdue; a past-date credit note counts as overdue | **Safe to work around**: read overdue from aging, which nets credits |
| **The customer page's own aging** is total − paid | Disagrees with `/ar-aging` on a credited invoice | **Safe to work around**: `/ar-aging` is authoritative |
| **Payroll posts under the approval date** | If the pilot approves a run, its entry lands in the approval month | **Should be avoided**: payroll is outside this pilot |
| **Invoice "send" and invitation email** need a mail provider | The send control waits; the invite link is shown on screen | Option A: hand the PDF and the link over; Option B: works |
| **Deleting is admin-only; the audit trail is admin-only** | The accountant cannot delete or read the trail | **By design**; you perform those steps |

Two more questions to put to the accountant or the advisor, not to answer
here: *(a)* should input VAT on a bill expensed to a blocked category
(meals, entertainment) be claimed — the product claims it on every posted
bill today; *(b)* does Saudi practice permit any exception to "a correction
posts in the open period" — the recorded closed-period policy is
reasoned, not verified (known-issues file, "INVOICE DATING INTO CLOSED
MONTHS").

---

## 9. What stays outside the pilot

Fixed assets · migration and opening balances · Zakat · payroll and GOSI ·
withholding tax · advance payments · multi-currency · live bank feeds and
the payment gateways · ZATCA simulation, production and transmission ·
the AI features (dark by construction) · document capture and OCR (built,
not walked for this pilot) · recurring rules (drafts only; leave off) ·
every coming-soon page · billing (does not exist) · the operator's
verification-document review (you approve; nothing else is exercised).

---

## 10. Genuine blockers to starting

**None in the code.** Every step in §1–§4 names an existing screen or
script. What must exist before the first session:

- A decision on §0 (Option A needs your machine and about an hour of
  setup; Option B needs the three accounts and the runbook's checks).
- The operator seeded once (§1.1 step 2) — without it the pilot
  organization cannot be approved out of `pending_review`.
- A fiscal year start set on the company before the first report.
- The accountant told §8 before, not after.

---

*Written against `80f3ee8`. Every screen, route and script named here was
read in that tree; nothing was modified to write this.*
