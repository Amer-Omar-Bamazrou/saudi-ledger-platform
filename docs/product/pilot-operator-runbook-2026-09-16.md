# Controlled pilot — the operator's runbook

**Status (2026-09-16): a DATED artifact, written against main at `dd1a7f7`
after the whole procedure below was REHEARSED end to end on a throwaway
organization on the local stack. Every step names the screen or command
that was actually used, and every claim about what exists afterwards was
read back from the database. Companion to
[`pilot-package-2026-09-16.md`](pilot-package-2026-09-16.md), which holds
the rationale, the boundaries and the issue format; this file holds the
sequence.**

Environment: Option A of the package — a machine you control, development
mode, local Postgres. Nothing here touches production infrastructure or
application code.

---

## What was rehearsed, and what it proved

The sequence signup → operator approval → admin login → sample seed →
fiscal year → default bank → accountant user → accountant login →
permission probes → an issued invoice's PDF was run once on the
organization **"Rehearsal Trading Est."** (slug allocated by signup,
org id `4ab88e98-…`). Results, each read back:

- Signup created the org in `pending_review`, its company, the admin and
  an active admin membership. The operator's approve returned `approved`.
  The admin then reached business routes and found **40 seeded accounts**.
- The sample seeder populated that org (it found the tenant by the admin's
  email) and reported `invoices=5, quotations=1, purchase_orders=1` from a
  separate connection.
- The accountant role, probed live: create / submit / approve / pay all
  **200**; delete a record, lock a period, read the audit trail, manage
  users, update company settings, onboard with ZATCA all **403**.
- The invoice the accountant issued rendered a PDF/A with the Arabic legal
  name, the VAT and CR, the customer's VAT, the QR, the paid and remaining
  lines, and **the default bank account's details**.

That organization is still in the local database, prepared, and can be
used AS the pilot company if you prefer not to repeat the steps. Its
credentials are in §4. Otherwise repeat §1–§3 for a fresh one; the seeder
keys on the admin's email, so use a NEW admin email per company.

Two things the rehearsal corrected in the package's expectations:

1. **The seeded invoices carry no due date, so none is overdue.** The
   overdue scenario must be entered by hand (§3, step 6).
2. **The seeder does not set the bank account as the invoice default**,
   and it **overwrites the company's VAT and CR** with its own valid-format
   test numbers (`399999999999993` / `1010101010`). Both are handled in §3.

---

## 1. Start the environment (you, once per session)

```powershell
cd C:\Users\lenovo\saudi-ledger-platform
supabase start                                              # local Postgres — already running if it says so
$env:DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
pnpm --filter @workspace/db run migrate                    # idempotent; 74 applied today
```

Two terminals, left open for the whole session:

```powershell
pnpm --filter @workspace/api-server run dev                 # API on :3000
pnpm --filter @workspace/bookkeeping run dev                # web on :5173
```

Check: `http://localhost:3000/api/healthz` → `{"status":"ok"}`;
`http://localhost:5173` → the login page. Today both are running.

**The platform operator** exists already — seeded during preparation:
`pilot-operator@local.dev`. Its password is in your scratch file
`pilot-operator-password.txt` (I generated it; it was never printed into
the repository). If you ever need another operator, the seed creates one
and never overwrites an existing user's password:

```powershell
$env:SEED_OPERATOR_EMAIL = "<new email>"; $env:SEED_OPERATOR_PASSWORD = "<12+ chars>"
pnpm --filter @workspace/db run seed
```

---

## 2. Create the pilot company (you, in the browser)

1. **`http://localhost:5173/signup`.** Fill in: organization name (e.g.
   "Pilot Trading Est."), CR number (10 digits), VAT number (15 digits,
   starts and ends with 3), your full name, the **admin email** (new, used
   nowhere else — the seeder keys on it), a password ≥ 8 characters.
   Submit. The page tells you the account awaits review.
2. **Sign out. Sign in as the operator** (`pilot-operator@local.dev`).
   Open **`http://localhost:5173/operator`**. The new organization is
   listed as pending. **Approve** it.
3. **Sign out. Sign in as the pilot admin.** The dashboard opens; every
   page answers. The chart of accounts already holds the 40 system
   accounts.

You have now created: the organization (approved), one company, the
admin user, its admin membership, and the seeded chart. No branch or
department exists or is needed.

---

## 3. Seed the data, then finish the company (you)

### 3.1 The sample seeder — the exact command

```powershell
cd C:\Users\lenovo\saudi-ledger-platform
$env:SEED_ADMIN_EMAIL = "<the pilot admin's email from step 2.1>"
pnpm --filter @workspace/api-server run seed:sample
```

It reads `apps/api/.env` for the database, finds the admin's earliest
active membership, and writes everything **through the product's own
services** (drafts created and then approved, so every journal entry,
VAT line and audit row is real). Re-running is a no-op. Expect:

```
[sample] tenant: <org> / <company>
[sample] verified from a separate connection: invoices=5, quotations=1, purchase_orders=1
```

**What exists after it** (read back on the rehearsal org):

| Data | Exactly |
| --- | --- |
| Company | VAT set to `399999999999993`, CR to `1010101010` (the seeder overwrites what signup entered — fine for a pilot; both are valid-format test numbers) |
| Customers | **Najd Contracting Co.** (VAT `310000000000003`) — the payment and allocation customer; **Rawabi Logistics** (`311111111111113`) |
| Suppliers | **Gulf Office Supplies** (`300000000000003`); **Tamimi Facilities** (`301111111111113`) |
| Chart of accounts | The seeded 40; nothing added |
| Bank account | **Main Operating Account**, Al Rajhi, IBAN `SA0380000000608010167519`, opening balance 50,000.00 — **not** yet the invoice default |
| Sales invoices | 5 issued, ICV 1–5, dated June–August 2026, **no due dates**: INV-000001 20,700.00 **paid**; INV-000002 11,730.00 open; INV-000003 30,015.00 **part-paid** (10,000.00); INV-000004 13,685.00 open; INV-000005 17,250.00 open |
| Bills | 3 posted: GOS-4471 2,760.00 **paid**; TAM-2210 10,925.00 received; GOS-4620 2,139.00 received. All posted to Purchases (no account chosen) |
| Quotation / PO | QUO-2026-0001 40,250.00 approved; PO-2026-0001 20,585.00 approved (neither converted) |
| Bank transactions | 5 **accepted, posted to Suspense, uncategorised** (Aug 2026): POS settlement 4,820.50 cr; STC 640.00 dr; salary transfer 28,000.00 dr; bank charges 75.00 dr; customer deposit Najd 12,000.00 cr |
| Journal entries | 16 posted, all document-generated |
| Not created | credit or debit notes; a partially paid bill; a hand-entered journal entry; a pending (unmatched) statement; a second bank account; an overdue invoice; a period lock; ZATCA onboarding |

### 3.2 Finish the company in the UI (as the pilot admin)

1. **`/company`**: set the **Arabic legal name**, the **fiscal calendar**
   (Gregorian) and **fiscal year start** (January), and the national
   address fields (building 4 digits, street, district, city, postal 5
   digits, additional 4 digits). Save. Reports default to the fiscal year
   from here.
2. **`/bank-accounts`**: click **"Use on invoices"** on Main Operating
   Account; the line at the top now names it. Add a second account
   ("Payroll SAR", any bank) so the switch can be tested later.
3. **`/zatca`** (optional, recommended): the checklist is green once step 1
   is complete; **Onboard with ZATCA**, any OTP. This stores a sandbox
   credential and, from then on, every approved invoice also builds a
   signed e-invoice document. Read the package §8 first: after onboarding,
   a **0% VAT line cannot be issued**.

### 3.3 The scenarios the seeder leaves for the accountant

These are entered by the accountant during the checklist (§5), not by
you — they ARE the test:

| Scenario | How |
| --- | --- |
| Overdue invoice | New invoice to Rawabi Logistics dated two months ago with a due date one month ago; approve |
| Partially paid bill | New bill from Gulf Office Supplies 800.00 + 15%; post; pay 400.00 |
| Two-person bill | New bill from Tamimi Facilities, choose **Rent & Utilities** in the dialog, do NOT post; then Approvals → Submit → Approve |
| Credit note (unpaid original) | Credit note 300.00 + 15% against INV-000003 |
| Credit note (paid original) | Credit note 200.00 + 15% against INV-000001 — the refund case |
| Debit note | 100.00 + 15% against INV-000002 |
| Journal entry | Dr Bank Charges 75 / Cr Cash and Bank 75, dated this month; post |
| Statement import | A 6-row CSV (package §3.2): one credit matching INV-000002's total with the number in the description, one credit of 10,000.00 (matches INV-000003 by amount), one debit of 400.00 (the bill), "OFFICE RENT 3,000" debit, "TRANSFER TO PAYROLL 5,000" debit, "UNKNOWN DEPOSIT 250" credit |

---

## 4. Accounts and roles

| Who | Account | Role | Used for |
| --- | --- | --- | --- |
| **You, as operator** | `pilot-operator@local.dev` | platform operator (not a tenant member) | Approving the signup; nothing else |
| **You, as administrator** | the admin email from step 2.1 | `admin` membership | Company settings, ZATCA onboarding, the default bank, creating the accountant, **locking and unlocking periods**, **deleting** records, reading the **audit trail** |
| **The accountant** | created by you (below) | `accountant` membership | Everything in the checklist |

**Create the accountant** (as admin): **`/users` → Add User**: email,
full name, a temporary password (≥ 8), role **Accountant**. The page does
two things — registers the user and adds the membership. (Doing only the
first by hand leaves a user who can log in and is refused everywhere;
the page handles it.) Tell them to change the password on first login
(`/change-password`).

**Rehearsal credentials, if you use that org:** admin
`rehearsal-admin@local.dev` / `rehearsal-admin-pw-2026`; accountant
`rehearsal-accountant@local.dev` / `rehearsal-acct-pw-2026`. Both are
throwaway strings for a local machine; change them if the machine is
shared.

**What the accountant CAN do** (probed live, all 200): read every page
and report; create and edit customers, suppliers, products, invoices,
bills, quotations, purchase orders, journal entries, bank accounts,
transactions; **submit, approve, post, pay, reverse** — the activation
authority.

**What the accountant CANNOT do** (probed live, all 403), and should not
for this pilot: delete any record; lock or unlock a period; read the
audit trail; manage users; update company settings; onboard with ZATCA.
Steps in the checklist that need these are marked **(admin)** and you
perform them while they watch.

Do not give the accountant `admin`. Do not create a new role.

---

## 5. The accountant's sequence

Give them the package's §4 as the reference; this is the order, with the
evidence to capture at each step. "Record" means a screenshot and the
figure written down at the time.

**Day 1 — orientation and sales**
1. Log in, change password, switch the language to Arabic if preferred.
   Record: the dashboard.
2. Open the seeded data: `/customers`, `/vendors`, `/invoices`,
   `/bills`, `/bank-accounts`, `/categories`. Record: the invoice list's
   four KPI figures and the trial balance total (`/trial-balance`, from
   1 Jan) — these are the baseline.
3. Quotation → convert → invoice → Approvals (Submit, Approve) → PDF both
   languages → Mark Paid in full. Record: the `GL-…` entry on
   `/journal-entries`, the ICV on the invoice, the PDF showing the bank
   details.
4. New invoice to Najd, 3,000 + 15%; approve; **pay 1,000**. Record:
   status stays `sent`; `/ar-aging` shows the residual.
5. Switch the invoice bank account on `/bank-accounts`; reopen a PDF.
   Record: the details changed. Switch it back.
6. The overdue invoice (§3.3). Record: overdue in the list and in aging
   with its days.
7. Customer statement: `/customers` → Najd → **Open statement**. Record
   what it shows, and note the package §8 limitation (open items, not a
   dated statement).
8. `/vat`: record boxes 1, 6 and the net.

**Day 2 — purchases and credit notes**
9. PO-2026-0001 → **Record bill** → bill B1 draft with the PO's lines.
   Record.
10. The two-person bill (§3.3): choose Rent & Utilities, submit,
    approve from Approvals. Record: the queue row shows "→ Rent &
    Utilities"; the `BILL-…` entry debits Rent & Utilities, not Purchases.
11. The partial bill (§3.3): post, pay 400. Record: `/ap-aging` shows
    520 remaining; status `received`. Pay the rest. Record: `paid`.
12. Credit note against INV-000003 (unpaid part). Record: the `GL-CN…`
    entry (Dr Sales / Dr VAT Payable / Cr AR), aging nets it, box 6 drops.
13. Debit note against INV-000002. Record: posts in the invoice direction.
14. Credit note against the **paid** INV-000001. Record: aging shows a
    negative balance at 0 days; note that nothing on any screen pays it
    out (package §8).
15. **Negative cases:** on a credit-note row there is **no Mark Paid**;
    the same for a debit note; paying more than the credit-aware
    outstanding on INV-000003 is refused. Record each refusal.

**Day 3 — banking and controls**
16. Review the five seeded suspense rows on `/review`: categorise STC to
    Telecommunications, bank charges to Bank Charges, the salary transfer
    to Salaries and Wages; leave the POS settlement and the Najd deposit.
    Record: each re-categorisation reverses and re-posts (two entries).
17. Upload the 6-row CSV (§3.3) on `/upload`. Record: 6 rows pending;
    the trial balance unchanged.
18. Settle the two matched credits and the 400 debit against their
    documents. Record: the documents' paid amounts move; no `TXN-` entry
    for a settlement.
19. Categorise "OFFICE RENT"; accept "UNKNOWN DEPOSIT" with no category
    (→ Suspense); accept "TRANSFER TO PAYROLL" then on `/transactions`
    declare it own-account. Record: the postings.
20. `/analytics`, cash section: record `unexplained` (expect 0).
21. Journal entry (§3.3): create, post. Try an unbalanced one: refused.
    Then **Reverse** the posted one. Record: the reversal is dated today;
    the original stays, marked reversed.
22. **(admin)** Lock last month on `/closed-months`. Then the accountant
    attempts, dated in that month: a new invoice, a bill, a journal entry,
    a payment with a paid-at in it. Record: each refused with the
    closed-month dialog. Also try accepting a statement row dated in that
    month from Review in **bulk**: record what happens (package §8 — it
    reports success and posts nothing; this is a known gap to observe, not
    a pass). **(admin)** Unlock.
23. **(admin)** `/audit-trail`: record the rows for one invoice from
    create to pay, and the lock/unlock rows.
24. Permissions: the accountant confirms `/users` and `/audit-trail` are
    not offered.

**Close — the comparison** (package §4.6): on one sheet, AR = aging total;
AP = AP aging total; cash on the balance sheet = trial-balance cash =
the reconciliation's ledger cash; VAT Payable on the balance sheet vs the
VAT return's net; revenue on the P&L vs the approved documents. Any pair
that disagrees is **blocking**.

---

## 6. Safe / with limitations / not yet

**SAFE TO TEST** — sales end to end (quotation, invoice, approval, PDF,
full and partial payment, AR aging, VAT return); purchases end to end
(PO, bill by either path with a chosen account, full and partial payment,
AP aging, VAT); credit and debit notes against unpaid or part-paid
invoices; statement import, review, categorise, suspense, settle,
transfer declaration, the cash reconciliation; manual journal entries and
their reversal; the approval separation; period lock and its refusals;
the audit trail; sandbox ZATCA onboarding and the ICV chain; every report
on the above.

**SAFE TO TEST WITH LIMITATIONS** (disclose §7 first) — the customer
statement; a credit note against a paid invoice; reversals; 0% VAT once
onboarded; the bank card's balance; bulk-accept in a closed month; the
trial balance without an opening column; converting a PO whose supplier
reference collides.

**DO NOT TEST YET** — fixed assets; migration and opening balances;
Zakat; payroll; withholding tax; advance payments; multi-currency; live
bank feeds; ZATCA simulation, production or transmission; emailing an
invoice; recurring rules; document capture; anything on a coming-soon
page.

---

## 7. What to tell the accountant before they start

Plain language, no internals. Give them these nine, in this form:

1. **The customer statement lists open invoices, not a dated statement.**
   It will not show a payment received this month against an older
   invoice. Use AR aging and the invoice list for balances.
2. **If you credit an invoice the customer already paid, the system shows
   the credit owed but has no screen to pay it back or apply it to the
   next invoice.** Do it once (it is in the list), then leave it.
3. **When you reverse a posted entry, the reversal is dated today**, not
   the original's date. So a correction to last month lands in this
   month. *Question for you, not a rule:* should a reversal carry the
   original date, today's date, or a date you choose — and how should that
   interact with a closed month? Tell us what you would expect.
4. **Zero-rated invoices cannot be issued once the company is registered
   with ZATCA in this version.** Keep pilot invoices at 15%.
5. **The bank account card shows the opening balance you typed**, not a
   live balance. Cash lives on the balance sheet.
6. **Accepting several statement rows at once in a month that is closed
   says "done" and posts nothing.** Accepting rows one at a time refuses
   correctly. We know; please note when you see it.
7. **The trial balance shows only the period you pick**, with no opening
   column, so run it from the start of the fiscal year.
8. **Deleting records and closing months are the administrator's** —
   ask, and it will be done while you watch. The audit trail is likewise
   read by the administrator.
9. **Invoices are not emailed from this environment**; download the PDF
   and send it yourself.

Two questions to bring back (policy, not defects): should input VAT be
claimed on bills expensed to meals or entertainment (the system claims it
today); and does Saudi practice allow any exception to "corrections post
in the open period"?

---

## 8. Capturing issues

**What they send you per issue** (the package's §7 format, compressed for
them): what they were doing (one sentence), the steps with document
numbers, what they expected, what happened (the exact message if there
was one), and screenshots of the screen and, if a figure moved, of
`/journal-entries` before and after.

**Severity, as you record it:** *blocking* — cannot continue, or a figure
on a report is wrong; *major* — a wrong figure with a workaround, or a
dead end with one; *minor* — cosmetic, no figure affected; *UX* —
confusing but correct.

**Recording an accounting discrepancy:** write down the two figures that
disagree, where each is shown, and the journal entry numbers involved;
then run the §5 comparison sheet again and attach it. A discrepancy is
blocking until it is explained.

**Bug or feature request:** a *bug* is a step that exists and produces a
wrong or missing result (wrong figure, missing entry, an error on a valid
input, a refusal that should have been an acceptance). A *feature
request* is a step that does not exist (no screen, no control) — check
§6's "with limitations" and "not yet" lists first; if it is there, log it
as "known, observed" so the pilot counts how often it bites. A *policy
question* is anything where the correct accounting answer is not
settled — log it as a question with the accountant's opinion.

---

## 9. Pilot-start checklist (you)

- [ ] `supabase status` shows the database up; migrations applied (74).
- [ ] API answers on :3000 (`/api/healthz`), web on :5173, both left
      running in their terminals.
- [ ] Operator login works (`pilot-operator@local.dev`).
- [ ] Pilot organization signed up with a **new** admin email, approved by
      the operator, admin login reaches the dashboard.
- [ ] `seed:sample` run with that admin email; output shows
      `invoices=5, quotations=1, purchase_orders=1`.
- [ ] Company settings: Arabic name, fiscal year start, national address
      saved; VAT/CR present (the seeder's test numbers are fine).
- [ ] Bank: Main Operating Account set **"Use on invoices"**; a second
      account exists.
- [ ] ZATCA: decided — either onboarded to the sandbox (checklist green,
      credential shown on `/zatca`) or deliberately not; the 0% rule
      disclosed accordingly. `ZATCA_WORKER_ENABLED` is unset/false, so
      nothing transmits.
- [ ] Accountant user created on `/users` with role Accountant; their
      login works; a probe confirms `/users` is refused to them.
- [ ] §7 disclosed to the accountant; §8 format agreed.
- [ ] Backup: this is a disposable local database. If the accountant's
      data is beyond correction, sign up a fresh organization and re-seed
      — that is the reset (package §6). Nothing deletes a company in place.
- [ ] Test data marked disposable: the org name contains "Pilot" or
      "Rehearsal"; the VAT/CR are the seeder's test numbers; no real
      counterparty data was entered.

---

## 10. Anything that prevents starting

Nothing. Every step above was executed on this machine today against
main `dd1a7f7`, and the environment it produced is running now.

What I did NOT do, on your instruction: I did not send anything to the
accountant, did not create an invitation, and did not change the
application. The only things created were data on the local database
(the operator, the rehearsal organization and its users) and this file.
