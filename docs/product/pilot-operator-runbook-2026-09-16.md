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

🔴 **`apps/api/.env` must have `AI_PROVIDER=none`** (pilot-safety
correction, 2026-09-16). With `groq` and a key set, the Finance Hub shows
the accountant an "Ask your books" box that answers **500** on this
machine — and CLAUDE.md forbids tenant data reaching Groq's free tier
before the Enterprise agreement. Check `http://localhost:3000/api/ask/status`
→ `{"available":false}` before he starts.

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
   address fields the page has — **building (4 digits), street, district,
   city, postal code (5 digits)**. Save. Reports default to the fiscal
   year from here. 🔴 There is **no "additional number" field** on this
   page (corrected 2026-09-16; the earlier text described one). The ZATCA
   checklist on `/zatca` requires it (KSA-23), so see step 3.
2. **`/bank-accounts`**: click **"Use on invoices"** on Main Operating
   Account; the line at the top now names it. Add a second account
   ("Payroll SAR", any bank) so the switch can be tested later.
3. **`/zatca` — DECIDED 2026-09-16 (owner): the pilot runs
   deliberately NOT onboarded.** Two reasons, recorded: (a) sandbox
   onboarding proves the integration, not the pilot's accounting; and (b)
   it is **unreachable from the UI today** — the `/zatca` checklist
   requires an *Additional number* (KSA-23, 4 digits) that Company
   Settings has no field for, so the checklist never goes green and
   **Onboard with ZATCA** stays disabled ("Complete the missing company
   details above"). Known-issues file, "ZATCA ONBOARDING UNREACHABLE FROM
   THE UI". Consequences the accountant is told (§7 item 4): every
   approved invoice still mints its ICV, hash and QR, but **no signed
   e-invoice document is built**; and the 0% rule does **not** apply —
   a 0% line issues. Do not onboard mid-pilot: it would change that
   behaviour under him.

### 3.3 The scenarios the seeder leaves for the accountant

These are entered by the accountant during the checklist (§5), not by
you — they ARE the test:

| Scenario | How |
| --- | --- |
| Overdue invoice | New invoice to Rawabi Logistics dated two months ago with a due date one month ago; approve |
| Partially paid bill | New bill from Gulf Office Supplies, bill number **`GOS-9001`**, 800.00 + 15% = 920.00; the dialog's button posts it; then **Pay 400.00** from the list. The remaining 520.00 is settled from the bank statement (below) |
| Two-person bill | 🔴 The **New Bill dialog posts in one act** — it has no "save as draft" (pilot-safety correction, 2026-09-16). The two-person flow is walked on the **PO-converted draft** instead: PO-2026-0001 → **Record bill** creates a draft carrying the PO's lines; on `/bills` **Edit** it and choose **Rent & Utilities**; then Approvals → Submit → Approve. (A bill typed straight into New Bill is single-person by design.) |
| Credit note (unpaid original) | Credit note 300.00 + 15% against INV-000003 |
| Credit note (paid original) | Credit note 200.00 + 15% against INV-000001 — the refund case |
| Debit note | 100.00 + 15% against INV-000002 |
| Journal entry | Dr Bank Charges 75 / Cr Cash and Bank 75, dated this month; post |
| Statement import | A 6-row CSV (package §3.2), each row written to exercise one matching rule — **the description decides the match** (pilot-safety correction, 2026-09-16; seed unchanged): (1) credit **11,730.00** "PAYMENT INV-2026-000002 RAWABI" → *matched by number, full*; (2) credit **10,000.00** "PAYMENT INV-2026-000003 NAJD" → *matched by number, PARTIAL* (INV-2026-000003's outstanding is 20,015.00 after the seeded 10,000.00 part-payment; a 10,000.00 credit with **no** number in its description gets NO suggestion — amount-only partials are never guessed); (3) debit **520.00** "PAYMENT GOS-9001" → *matched by number, full* (the bill's second instalment); (4) debit 3,000.00 "OFFICE RENT" → categorised Rent & Utilities, bulk-safe; (5) debit 5,000.00 **"INTERNAL TRANSFER TO PAYROLL ACCOUNT"** → `transfer`; (6) credit 250.00 "UNKNOWN DEPOSIT" → needs attention |

🔴 **The transfer row's wording is the test (pilot-safety correction,
2026-09-16).** The categoriser recognises a transfer only from an
own-money signal — `internal transfer`, `own account`, `account to
account`, `تحويل داخلي`, `تحويل بين حساب` — and deliberately NOT from a
bare "TRANSFER" (it could be a supplier payment). The earlier wording
"TRANSFER TO PAYROLL 5,000" was probed through the engine: it is booked as
**Salaries at 0.72** by the round-amount salary heuristic — an expense,
not a transfer — so the test would have "passed" for the wrong reason.
The phrase above lands as `kind: transfer`, 0.9, "Own-account transfer".
The engine was not changed.

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
10. The two-person bill (§3.3): on `/bills`, **Edit** the PO-converted
    draft from step 9 and choose **Rent & Utilities**; do not post it
    there. Approvals → Submit → Approve. Record: the queue row shows
    "→ Rent & Utilities"; the `BILL-…` entry debits Rent & Utilities,
    not Purchases.
11. The partial bill (§3.3, `GOS-9001`): the dialog posts it; **Pay
    400.00**. Record: `/ap-aging` shows 520.00 remaining; status
    `received`. Leave the 520.00 — the statement settles it on Day 3.
12. Credit note against INV-2026-000003 (the unpaid part), on **Credit
    Notes** (the page is titled "Credit & debit notes"; New note → type
    Credit note). Record: the note is numbered **in the invoice series**
    (`INV-2026-…` — one sequence for invoices and notes is the ZATCA
    rule) and its entry is **`GL-INV-2026-…`**; aging nets it; box 6
    drops. The PDF is titled إشعار دائن and names the original.
13. Debit note against INV-2026-000002 — same page, New note → type
    **Debit note** (the sidebar's "Debit Notes" entry is a coming-soon
    page; ignore it). Record: posts in the invoice direction.
14. Credit note against the **paid** INV-000001. Record: aging shows a
    negative balance at 0 days; note that nothing on any screen pays it
    out (package §8).
15. **Negative cases:** on a credit-note row there is **no Mark Paid**;
    the same for a debit note; paying more than the credit-aware
    outstanding on INV-000003 is refused. Record each refusal.

**Day 3 — banking and controls**
16. The five seeded suspense rows are **accepted** (§3.1), so they are
    NOT on `/review` — that page lists only rows awaiting a decision.
    Categorise them on **`/transactions`** (the pencil on each row):
    STC to Telecommunications, bank charges to Bank Charges, the salary
    transfer to Salaries and Wages; leave the POS settlement and the Najd
    deposit. Record: each re-categorisation reverses and re-posts (two
    entries). 🔴 The picker does not offer Accounts Receivable or
    Accounts Payable — a customer or supplier movement is settled against
    its document from Review, never categorised (a refusal names this if
    tried by API).
17. Upload the 6-row CSV (§3.3) on `/upload`. Record: 6 rows pending;
    the trial balance unchanged; on `/review`, rows 1–3 show a
    suggestion line ("settles INV-… — matched by number", row 2 marked
    *partial*); rows 4–5 sit under "Ready to accept", row 6 under
    "Needs attention".
18. **Accept & settle** rows 1–3 against their documents. Record:
    INV-2026-000002 → `paid`; INV-2026-000003's outstanding falls by
    10,000.00 (still `sent`); GOS-9001 → `paid`; no `TXN-` entry for a
    settlement (the payment entries are `GL-…-PAY-…` / `BILL-…-PAY-…`).
19. Categorise "OFFICE RENT"; accept "UNKNOWN DEPOSIT" with no category
    (→ Suspense); accept "INTERNAL TRANSFER TO PAYROLL ACCOUNT" (it shows
    the `transfer` badge and no category) then on `/transactions` declare
    it own-account. Record: the postings.
    🔴 **If an imported row is NOT recognised as a transfer** (no badge,
    no category), do not pick an expense or revenue category for it just
    to continue the test — accept it with no category so it stays in
    **Suspense**, and log it as feedback (§8) with the exact description.
    A forced category would turn an unknown movement into a confident
    expense on the P&L and VAT return; Suspense is the truthful answer.
20. `/analytics`, cash section: record `unexplained` (expect 0).
21. Journal entry (§3.3): create, post. Try an unbalanced one: refused.
    Then **Reverse** the posted one. Record: the reversal is dated today;
    the original stays, marked reversed.
    🔴 **Reversal safety (pilot-safety correction, 2026-09-16):** the
    accountant reverses **only journal entries they created themselves
    during the pilot** (the entry from this step). They must **not**
    reverse an entry the system generated from a document — any entry
    whose number starts `GL-` (an invoice, a credit or debit note, and
    their `-PAY-` payment entries), `BILL-` (a bill and its payments) or
    `TXN-` (an accepted bank row).
    The Reverse control is offered on those too; using it leaves the
    document approved while its ledger effect is undone, and aging keeps
    the receivable. A wrong **sale** is corrected with a **credit note**
    (step 12); a wrong bank row is deleted by you as admin (its entry
    reverses with it); a wrong bill is logged as feedback (no bill
    correction document exists — §6). The reversal's DATING stays the
    policy question in §7 item 3 and is **not changed in code**.
22. **(admin)** Lock **the previous month — never the current month** —
    on `/closed-months` (the current month holds the pilot's own entries;
    locking it would refuse the rest of the checklist). Then the
    accountant attempts, dated in the locked month: a new invoice, a bill,
    a journal entry. Record: each refused with the closed-month dialog.
    (A payment is always dated the day it is recorded — the Record
    Payment dialog has no date field — so a payment cannot be dated into
    the locked month from the UI; it is refused only if TODAY is locked,
    which is why the current month is never the one you lock.) Also accept a statement row dated in
    that month from Review — one row with its **Accept**, and then with
    **Accept ready** alongside an open-month row: the single row raises
    the same closed-month dialog; the batch accepts the open row and
    shows a red notice naming the closed month, and the closed row stays
    in Review with no entry (fixed 2026-09-16 — this was the "reports
    success and posts nothing" gap; it is now a refusal to record as a
    pass). **(admin)** Unlock.
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
their reversal (of the accountant's own entries only — §7 item 6); the
approval separation; period lock and its refusals, including bulk accept
into a closed month; the audit trail; sandbox ZATCA onboarding and the
ICV chain; every report on the above.

**SAFE TO TEST WITH LIMITATIONS** (disclose §7 first) — the customer
statement; a credit note against a paid invoice; reversal dating; 0% VAT
once onboarded; the bank card's balance; the trial balance without an
opening column; converting a PO whose supplier reference collides.

**DO NOT TEST YET** — fixed assets; migration and opening balances;
**inventory and cost of goods sold** (product and stock accounting is
outside this pilot and is not being validated — a product line on an
invoice is a price and a description, not a stock movement); Zakat;
payroll; withholding tax; advance payments; multi-currency; live bank
feeds; ZATCA simulation, production or transmission; emailing an invoice;
recurring rules; document capture; anything on a coming-soon page.

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
   interact with a closed month? Tell us what you would expect. (Nothing
   about reversal dating was changed in code for this pilot; it is a
   policy question, and your answer is the input.)
4. **This company is not registered with ZATCA for the pilot — on
   purpose.** Your invoices still get their ZATCA counter, hash and QR,
   but no signed e-invoice document is produced and nothing is sent to
   ZATCA. A 0% VAT line issues normally during the pilot (once a company
   IS registered, a 0% line cannot be issued in this version — that rule
   does not apply here). Keep pilot invoices at 15% unless a scenario
   calls for 0%.
5. **The bank account card shows the opening balance you typed**, not a
   live balance. Cash lives on the balance sheet.
6. **Reverse only the journal entries you created yourself in this
   pilot.** Do not reverse an entry the system created from an invoice, a
   bill, a payment or a bank row (their numbers start `GL-`, `BILL-` or
   `TXN-`) even though the button is there — the document would stay
   approved with its ledger effect undone. To correct a sale, raise a
   credit note; for anything else, tell us.
7. **The trial balance shows only the period you pick**, with no opening
   column, so run it from the start of the fiscal year.
10. **A bank credit is matched to an invoice only when the description
    carries the invoice number, or the amount equals exactly one open
    document's outstanding balance.** A part-payment with no number in
    the description is never guessed — accept it uncategorised (Suspense)
    and tell us. Credit and debit notes are numbered in the invoice
    series (`INV-2026-…`) — that is the ZATCA one-sequence rule, not a
    mistake — and are created on the Credit Notes page.
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
- [x] ZATCA: **deliberately not onboarded** (owner, 2026-09-16; §3.2
      step 3). `/zatca` shows "No certificate yet"; §7 item 4 disclosed.
      `ZATCA_WORKER_ENABLED` is unset/false, so nothing transmits.
- [ ] `AI_PROVIDER=none` in `apps/api/.env`; `/api/ask/status` answers
      `{"available":false}`; the Finance Hub shows no "Ask your books" box.
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
