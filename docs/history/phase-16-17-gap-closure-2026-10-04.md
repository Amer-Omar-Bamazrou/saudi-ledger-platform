# Phase 16 + 17 — closing the QA gaps that needed no decision (2026-10-04)

**Status (2026-10-04): every Phase 16/17 gap from the manual QA that did not
need an owner or accountant decision is closed on `feat/phase16-17-tax-treasury`,
each with a regression test seen RED with its fix reverted; the three HIGH
items stay decision-gated (§4, with a technical design each); PR #190 is not
merged.** Current state authority: [CLAUDE.md §2](../../CLAUDE.md). Previous
record: [`phase-16-17-manual-qa-2026-10-04.md`](phase-16-17-manual-qa-2026-10-04.md).
Decision pack: [`phase-16-17-tax-treasury-decision-pack.md`](../product/phase-16-17-tax-treasury-decision-pack.md)
§11 and §13.2 (F-26…F-36) / §13.3.

## 1. What was fixed

| Id | Was | Severity | Defect | Fix | Regression test (seen red reverted) |
|---|---|---|---|---|---|
| F-26 | D-14 / QA-15 | MEDIUM | The approvals inbox knew four entities: a bookkeeper SUBMITTED a Zakat computation, recorded a treaty relief, planned a payment — and no approver was ever told | The ONE queue (`approvalsQueue.service`) lists a submitted computation version, a pending relief and a planned payment, company-scoped, read-gated by `tax` / `treasury`; every act posts to the record's OWN route behind its own permission (no second approval system); revoke/cancel reasons typed inline; every act single-flight | API `phase16-17-gap-closure` QA-15 ×4 + isolation (M19a/b); e2e QA-15 (red with the old page) |
| F-27 | D-15 / QA-06 | LOW | A VAT period that nets to zero or to a credit had NO obligations row, so D-01's note ("periods before it are not projected") vanished exactly where a reader concludes "nothing to watch" | Every period has its row with its position — `payable · settled · nil · credit` — and the return's own figure (`returnNet`); the amount stays what is OWED (never negative): a credit is never projected as cash | API `phase16-vat-obligation-positions` (M20) |
| F-28 | D-17 / QA-04 | LOW | The Zakat classification page showed no balances; the computation's "Classify these accounts" link landed on every account | Each account carries its amount in the statement of financial position at a chosen date — the balance-sheet rows the computation reads (`reportsService.balanceSheet`; the one key rule `accountIdOfKey` moved so both read it) — and what the computation for a year ending then READS from it (`zakatReads`: the year's own Zakat accrual left out, Z-3, by the engine's own rule `withoutOwnAccrualH`, now shared); a "blocking a computation at this date" filter on that figure; the header-with-history flagged; date and filter in the URL, so the link opens the page scoped to the year and to the blockers | API QA-04 ×2 (M21, M24); e2e QA-04 (red with the old page) |
| F-29 | D-18 / QA-16 | LOW | The plans table (11 columns) scrolled sideways at 1280 AND 390 px and clipped its inline pay / edit / cancel forms | One responsive grid — six columns from `lg`, labelled cells below — nothing dropped; the act's form opens full width beneath its row | e2e (1280/390 × EN/AR, long name, 123,456,789.12) — red with the old page |
| F-30 | D-18 / QA-16, **new** | MEDIUM | The plan pay form had no WHT preview — and (found reading it) its "Not stated — the supplier's default nature applies" option SENT nothing, so the server applied the PLAN's stored nature behind a screen naming another (a tax amount and Form 06 row other than the one shown, on a record with no correction path, D-11) | The same `<WhtFields>` as the two other pay dialogs: the preview is `GET /tax/wht/preview` → `decideWithholding`, the function the payment runs; the request states exactly the declaration on screen | e2e: preview 3,000 → nature changed → 1,000 → the payment withheld 1,000 (red with the old page) |
| F-31 | D-18 / QA-16 | LOW | Obligations rows linked to `/zakat`, `/vat`, `/tax/withholding` — the destination answered a broader question than the row asked | Each link carries the row's scope (the WHT month, the VAT period, the approved computation id) and each destination READS it from the URL (WHT tab + month; VAT from/to) — back/forward, reload and a direct URL keep it | API QA-16 (M22); e2e links (red with the old pages) |
| F-32 | D-18 / D-04 family | LOW | Legal references stayed English in the Arabic UI (`Income Tax IR Art. 63(1) …`) | `legalRef` / `articleRef` (`lib/taxLabels.ts`): the regulation by its OFFICIAL Arabic title (the original), sub-paragraphs in the Arabic letters the text uses (abjad: 17(ز), 63(9)(أ)); anything not recognised in every part stays VERBATIM; the original kept as the element's title | `taxLabels.test.ts` (all seven seeded citations); e2e Arabic rates tab (red with the old page) |
| F-33 | D-19 / Q-e (UI part) | LOW | An income-tax computation of a company now declared Saudi (or a Zakat one of a company now mixed) existed and could not be seen | Existing computations are always listed (ownership is undated — a year may predate a change); starting one is not offered where the tax does not apply today | e2e Q-e (red with the old pages) |
| F-34 | D-19 / Q-d (UI part) | LOW | A treaty relief at exactly the statutory rate was accepted silently (it relieves nothing); one above it was refused only after submit | The form shows the statutory rate (the schedule's, in force on the relief's first day — the trigger's own rule) and says before submit that the rate equals it / exceeds it. Not a refusal — refusing stays the owner's call | e2e Q-d (red with the old page) |
| F-35 | F-19 class | LOW | The Approvals page (pre-existing, now hosting tax and treasury acts) was guarded by `isPending` only and used `window.prompt` for send-back notes; its tax and treasury sections sat below four often-empty document sections | `useGuarded`; notes and reasons inline; a "waiting for approval" summary at the top linking to each non-empty section | e2e (ONE approve request on a double-click) |
| F-36 | **new** (the walk, §5) | LOW | A PAID payment plan showed a WHT "estimate" re-computed with TODAY's supplier nature, relief and rate — a figure its payment never withheld, which moves whenever the supplier record changes | A paid plan carries `whtWithheld` — its payment's `wht_withholdings` row, the record; estimates exist for open plans only | API (M23a, M23b): the supplier's nature changed after payment, the record does not move |

**Accounting and calculation boundaries held:** no change to any posting, to
the VAT, Zakat, income-tax or WHT calculations, or to any database object (no
migration). Every new figure on a page is a figure the server already
computed: balances from `reportsService.balanceSheet`, the VAT position from
`reportsService.vatReturn`, the WHT preview from `decideWithholding`.

## 2. Tests

- **API:** `phase16-17-gap-closure.test.ts` (9, real HTTP: the approvals queue
  end to end — bookkeeper submit, approver send-back / approve / duplicate 409,
  reject with and without a reason, viewer read-only, audit rows — isolation
  across organisations AND across companies of one organisation with exact
  sets, a paid plan's recorded withholding against a later supplier change,
  classification balances = the balance sheet's own row and what the
  computation reads (own accrual out), the header flag, the obligation's
  computation id); `phase16-vat-obligation-positions.test.ts`
  (4, pinned date: nil, credit — never a Treasury row — payable, settled and
  part-paid).
- **Web unit:** `taxLabels.test.ts` (6).
- **Browser:** `e2e/phase16-17-gap-closure.spec.ts` (8).
- **Mutation proofs (fix reverted → red → restored, hash-checked — never a stash or a checkout):**
  - API (`mutate.mjs`): M19a the computation and relief readers off → 5 red; M19b the plan reader off → 3 red;
    M20 the VAT row back to "only while owed" → 3 of 4 red (the payable case stays green, as it should);
    M21 balance null → 2 red; M22 computation id null → 1 red; M23a the recorded withholding dropped and
    M23b estimates re-enabled for paid plans → 1 red each; M24 the page reading the raw balance instead of
    what the computation reads → 1 red.
  - Web unit: `legalRef` returning the English verbatim → the Arabic test red.
  - Browser (`r2-e2e-revert.mjs` — each group's files replaced by their COMMITTED version, `git show HEAD:…`,
    then restored from a byte copy): approvals, plans layout, plan-pay preview, obligation links,
    classification, legal references, the relief warning and computation visibility — every one red. The
    plans-layout test first passed against the old page at 1280 px: it measured the element carrying the
    test id (the table), not the box that scrolled; it now checks every ancestor and catches the old page at
    1280 px — the QA's original observation, confirmed.

## 3. Lower-stakes questions (QA §I Q-a…Q-e), researched

Research order: ZATCA / Saudi primary texts → SOCPA / standards → Odoo →
ERPNext → our code. **Regulation**, **implementation precedent** and **product
decision** are kept apart; nothing below changed accounting behaviour.

| Q | Kind | What the sources say | Done now | Open |
|---|---|---|---|---|
| Q-a (T-1) overdue receivables counted as inflow | **Product / treasury judgment** — no regulation governs an internal cash forecast (IAS 7 governs the historical statement of cash flows, not a projection) | No precedent was relied on | Nothing: the overdue bucket is already labelled as such on the page | Owner: keep, exclude, or show a second "if none of the overdue is collected" closing (a new figure — not added without a decision) |
| Q-b (W-8b) nil WHT months | **Regulatory, unconfirmed** | The rule as ZATCA's own guidance restates it ties the monthly form and payment to "the month following the month during which payment subject to withholding … was made" (IR Art. 63(9)) — read from a search extract of ZATCA's RHQ guideline, the PDF itself not read in this pass; ZATCA's WHT e-service page (eservices-043) and its monthly reminder notice (March 2026) were read and are silent on months with no payment; secondary sites (ClearTax) assert a nil form is mandatory by analogy to VAT — **not verified, and an official translation is itself secondary to the Arabic**. Precedent: Odoo 17 `l10n_sa` (`data/account_tax_report_data.xml`) defines the WHT report as a period-filtered `account.report` (`tax_report_withholding_tax`, tax-tag lines), so any month can be run and shows zeros; ERPNext not checked for a WHT return | A month with no withholding can now be OPENED (the return page takes the month from the URL and offers it) | Accountant: is a nil Form 06 required; if so, listed from which month (first withholding, go-live, fiscal year)? |
| Q-c (W-15) residency undated | **Product decision** grounded in regulation | ITL Art. 3: residency is a status judged per tax year, so it can change; Art. 68 judges a payment by the payee's status when paid. Precedent (source read): Odoo 17 `addons/account/models/partner.py` — `property_account_position_id`, a company-dependent Many2one with no date; ERPNext `buying/doctype/supplier/supplier.json` — `tax_withholding_category`, a Link with no date. Both decide the tax from the CURRENT setting and freeze it on the posted document — as `wht_withholdings` does here | Nothing (a posted withholding is already frozen; only the "possibly missed" exception view reads today's residency) | Owner/accountant: effective-dated residency (a data-model change) |
| Q-d relief at the statutory rate | **UX validation** for the warning; **product decision** for a refusal | A treaty rate below the domestic rate is what a relief is (ZATCA DTA circular §4.1); one equal to it changes nothing | F-34 — warned before submit (equal / above) | Owner: refuse it outright? (hygiene, LOW) |
| Q-e inapplicable computations | **UX defect** for the invisibility; **product decision** for a refusal | Ownership decides the tax (ITL Art. 2; Zakat Regs) but is undated here — a past year may predate a change, so refusing creation by TODAY's ownership could block a legitimate year | F-33 — existing records always visible; creation not offered where it does not apply today | Owner: refuse creation server-side, and by which year's ownership? |

## 4. The three HIGH items — decision-gated, with a technical design each

Nothing below is implemented. Each names where the change would land, so the
build is mechanical once the decision exists.

### HIGH-1 · W-13 / D-11 — correcting a WHT-bearing payment

**Where it lands.** The pay paths `services/bills.payment.ts` (`payBill`; the
plan path calls it) and `services/accounting/supplierPayments.service.ts`; the
record `wht_withholdings` (append-only; CHECK `wht_amount = round(base × rate)`);
its entry's owner `wht_withholding` (refused by the generic reverse —
`journalEntries.service` `ownedEntryRefusal`); the WHT_PAYABLE two-writer
trigger (`wht_payable_line_owned` / `wht_payable_unowned`); the remittance cap
(`wht_remittances_admit`: Σ remitted ≤ Σ withheld per month); what a bill owes
(`repositories/billPosition`, the one definition).

**Shape once decided.** A `wht_withholding_reversals` record modelled on the
existing `wht_remittance_reversals` (append-only, one per withholding, a
reason, the mirroring entry); a payment-reversal marker on `bill_payments`
that `billPosition` reads; the WHT_PAYABLE trigger admits a third owner (the
reversal); W1 becomes GL = Σ withheld − Σ reversed − Σ remitted; the return
shows the reversal in the month the decision names.

**Decisions it needs.** (1) Is the correction reported in the ORIGINAL month
(an amended Form 06) or the month it is made? (2) Is it allowed after the
month is remitted — and after the form is filed — and if so is the
over-remitted tax a refund claim or a credit carried forward (the remittance
cap would otherwise refuse it)? (3) Does a correction move cash (a supplier
refund) or only replace a mistaken record? (4) How does a closed-period
correction (CLAUDE.md §4: posted in the current open period) square with the
month the return attributes it to?

### HIGH-2 · W-14 / D-12 — WHT on deposits, erroneous and unidentified payments

**Where it lands.** `supplierPayments.service.ts` calls `decideWithholding`
for every classification (`advance`, `security_deposit`, `erroneous`,
`unknown`); the not-subject reasons are fixed by CHECK
`wht_withholdings_not_subject_chk` (`goods`, `not_kingdom_source`); the
refund refusal `wht_refund_unsupported` (W-12); reclassification
(`supplierPayments.service.classify`).

**Shape once decided.** Either (A) a deposit / erroneous / unidentified
payment is not withheld when paid — recorded not-subject with a new reason
(a migration extending the CHECK; the Form 06 excluded list) — and withholds
when it is reclassified as consideration (an advance), dated then; or (B) it
keeps withholding and W-12's recovery is designed (the refund returns the
supplier's part; the withheld part through HIGH-1's reversal).

**Decisions it needs.** Whether such a payment is a "payment" subject under
ITL Art. 68 / IR Art. 63 at all (the pack's own reading of IR 63(7) — "other
payments" are services — points against), and the timing on reclassification.

### HIGH-3 · A-6 / D-13 — migrated fixed assets after a migration reversal

**Where it lands.** `migrationCommit.service.reverse()` mirrors only the
opening journal and marks invoices, bills and deposits (Policy C);
`reversalPreview()` lists the blockers; `fixed_assets.migration_batch_id`
(set by `assets/migratedAssets.service`) is not consulted; depreciation runs
select in-service assets; the register's FA_COST / FA_ACCUMULATED controls,
the Zakat non-current-asset lines and the Art. 17 pool all read the register.

**Shape once decided.** Either (A) MARK the batch's assets reversed (columns
+ trigger, never a delete — the A4/A5 pattern), exclude them from runs and the
register, and mirror the depreciation already posted on them (otherwise the
GL keeps depreciation of an asset that never existed); or (B) add a
`reversalPreview` blocker while any of the batch's assets is in service — but
no path exists to withdraw a migrated asset without posting a disposal gain or
loss, so (B) also needs one.

**Decisions it needs.** Which policy (A or B) — an A4/A5-family accounting
decision — and how depreciation already posted on a migrated asset is
unwound.

## 5. The adversarial walk (Part 4) — after the fixes

The QA database of the manual QA (`saudi_ledger_qa_1004`), servers built from
this branch, real clicks in Chrome, every figure checked against the GL.

| Area | What was done | Result |
|---|---|---|
| Approvals | The bookkeeper's queue (and an Approve the server refused with its words); the accountant sent the submitted Zakat v3 back with an inline note (the note shows on the paper), the bookkeeper re-submitted, the accountant DOUBLE-CLICKED Approve; approved one planned payment, cancelled its double-click duplicate (QA-02) with a reason; in Arabic, revoked a relief with an Arabic reason | ONE approve request; ONE accrual difference (−128.88, dated today — 2025-12 is locked); the Zakat paper, the forecast and the obligations moved at once (no stale figure) |
| Isolation | A pending relief in each of two organisations; the second organisation's admin approving the first's | Each queue shows only its own; the cross-tenant act is a 404 with no existence oracle |
| WHT preview | Paid the approved plan from the new form | Preview 5 % technical consulting = 750 → the payment withheld exactly 750 (`wht_withholdings`) |
| F-30, confirmed | A plan with a stored royalty nature, paid by a request that states no nature (what the OLD form sent for "Not stated") | The old screen's preview said 750 (the supplier default); the server withheld 2,250 (royalty) — the defect was real |
| Obligations links | WHT → October's return (back / forward keep the month); VAT → the Q3 return (net 35,550 = the row); Zakat → the computation; the current VAT quarter reads "nil" in English and Arabic | All scoped; the totals reconcile |
| Classification | Balances at 31 Dec 2025 against the balance sheet | 10 of 10 equal. **Found a defect in this pass's own new feature**: the page called the Zakat payable (12,927.08 — FY2025's own accrual) a blocker the computation never raises (Z-3). Fixed before commit — `zakatReads`, by the engine's own rule (M24) |
| Arabic legal references | Computation steps, the WHT rates tab, the Art. 17 pool's frame | Arabic throughout; the English citation kept on each cell's title (11 of 11) |
| Period locks | Paid an approved plan dated 15 Dec 2025 (locked) | 423 `period_closed`, nothing written, the plan stays approved |
| Paid plans | The plans list after payment | F-36 found and fixed (above) |
| Reconciliation | The QA's recon script, re-run | TB 3,953,021.50 = 3,953,021.50; cash 726,550 in all five places; AR 193,250 = forecast; AP 1,000 = forecast; WHT 11,150 = ledger = page; Zakat payable 13,313.74 = Σ accruals = obligations; the cash flow reconciles |
| Console | Every changed page | No errors |

Not walked by hand: the 390 px layouts (the browser window would not shrink
below desktop width) — the browser suite asserts them, in both languages.

## 6. What else this pass found

- **F-30** (above) — a screen/server mismatch on the plan pay form, found by
  reading the code being replaced, and confirmed on the QA database (§5): the
  same request withheld 2,250 where the old screen said 750.
- **F-36** (above) — a paid plan's re-estimated WHT, found on the walk.
- **A defect in this pass's own work, found by the walk before commit** — the
  classification page's first "blocking" count read the raw balance, so it
  called the year's own Zakat payable a blocker (§5); fixed with `zakatReads`
  (M24). Recorded because it is exactly the class the walk exists to catch:
  correct numbers, wrong conclusion drawn from them.
- Budgets (Phase 15) share the approvals-inbox gap (a submitted budget
  version never reaches the queue). Same shape, outside Phase 16/17 — not
  changed here; one adapter's worth of work if the owner wants it.
