# D-3 per-bank cash — the remaining policy decisions, researched (2026-09-17)

**Status (2026-09-17): RESEARCH AND RECOMMENDATION ONLY — nothing here is implemented, and nothing here is settled until the owner and the accountant confirm what §11 says still needs them. Current state authority: [CLAUDE.md §2](../../CLAUDE.md).**

Scope: the decisions that block the historical D-3 cash cut-over or shape D-4. Decision record: [`accounting-architecture-decision-pack.md`](accounting-architecture-decision-pack.md) §D-3; as-built: [`design-per-bank-cash.md`](design-per-bank-cash.md). Every conclusion carries exactly one classification: **FORMAL REQUIREMENT** · **ACCOUNTING STANDARD / PRINCIPLE** · **COMMON ACCOUNTING PRACTICE** · **PRODUCT DESIGN PRACTICE** · **ENGINEERING RECOMMENDATION** · **REQUIRES ACCOUNTANT CONFIRMATION**. Software behaviour is cited as product practice only; several products agreeing does not make a thing required. Where no authoritative source answers, it says so.

---

## 1. Executive findings

1. **Saudi law already decides the shape of any historical correction: a new, dated record — never an alteration.** The Implementing Regulations of the Law of Commercial Books require the books to be free of erasures, insertions and blanks, and an error to be corrected *by another entry dated on the day it is discovered* (§2, source S2). That is a FORMAL REQUIREMENT, and it settles three things at once: history is annotated rather than rewritten (Decision 2), an override is an appended record rather than an edit (Decision 1), and any reclassification journal — if one is ever posted — carries the discovery/cut-over date and never a historical date (Decisions 3 and 4).
2. **Not knowing which bank held the cash is not an accounting error.** Under IAS 8 / IFRS for SMEs §10 an error is a misstatement or omission in the financial statements; the statement line item is *cash and cash equivalents* (IAS 1.54(i); IFRS for SMEs 4.2(a)), and "which bank" is a component disclosed or analysed beneath it (IAS 7.45). The historical postings to "Cash and Bank" were correct when made. No restatement, no suspense, no correction journal follows from bank identity being unknown (Decisions 3 and 5).
3. **The annotation model is the standard "dimension beside the account" design**, the same shape Business Central documents as the alternative to creating a GL account per analysis need (S9). It is conceptually sound, and it is how per-bank figures can be produced without pretending history was posted per bank (Decision 2).
4. **A reclassification journal is not needed for bank-level reporting and should stay prohibited by default.** It becomes appropriate only if the accountant wants the *ledger accounts themselves* — not the readers — to carry per-bank balances for statutory presentation; then it is one dated, open-period, reversible entry per company through the seam, never backdated (Decision 3).
5. **The best evidence for a bank override is the bank's own statement line.** ISA 500's reliability hierarchy (external, documentary, original) makes the imported statement row — already in `transactions` with its bank — the strongest available evidence; an override is therefore best modelled as a *human-supplied link to a statement row* (the A2 evidence a person found), with a weaker "attestation with statement reference" form only when the statement is not in the system (Decisions 1 and 6).
6. **The evidence table as built is sufficient for the automatic cut-over and insufficient for human overrides**: it lacks actor, evidence reference, reason and a supersession mechanism (Decision 6). Nothing in it needs to change for Batch 1B; the override columns are added when the override policy is confirmed.
7. **Of the four questions with the accountant, two can be withdrawn as answered by formal sources, one should be narrowed, and one stands as a genuine judgement** (§11). One new question should be added: whether the pilot's Mark-Paid history may be attributed on the strength of a statement line alone when the payment record names no bank.
8. **D-3 is ready for Batch 1B on the accounting model, the evidence model, immutability and payment/bank identity separation.** What is not ready is the *policy* for the AMBIGUOUS lines — and Batch 1B does not depend on it, provided D-4 reads bank identity only through the view and never derives it from payment identity (§13).

---

## 2. Research sources

Primary sources were read in the original or the official translation where noted; secondary sources are marked.

| # | Source | Date | Read | Used for |
| --- | --- | --- | --- | --- |
| S1 | **Law of Commercial Books**, Royal Decree M/61 (17/12/1409H, 20 July 1989), Bureau of Experts official translation, last update 16 June 2022 (misa.gov.sa PDF) | 1989 / 2022 | Full text, primary (official translation) | Books to keep (Art. 1); electronic books allowed (Art. 2); documents corroborating entries kept in an organised manner (Art. 6); 10-year retention (Art. 8); presumption that entries are made with the merchant's knowledge (Art. 9) |
| S2 | **Implementing Regulations of the Law of Commercial Books**, Minister of Commerce Decision 699 (29/7/1410H) as amended by Decision 1110 (24/12/1410H) — as quoted in *حجية الدفاتر التجارية في نظام الإثبات*, Dr Ahmad b. Abdulaziz b. Shabib, **مجلة قضاء** issue 31, Shawwal 1444H / April 2023, pp. 99–103 (Saudi Judicial Scientific Association, peer-reviewed) | 1410H / 2023 | Primary regulation text NOT located online in full; the conditions are quoted verbatim by a Saudi judicial journal citing Reg. Arts 3–7 | The "regular books" conditions: Arabic; ministry templates; computerised keeping permitted under Reg. Art. 3 (as amended); pages numbered; **"أن تكون خالية من أي فراغ أو كتابة في الهوامش أو كشط أو تحشير، وإلا فيتم تصحيح هذا الخطأ بقيد آخر في تاريخ اكتشافه"** (free of blanks, marginal writing, erasure or insertion; an error is corrected by *another entry on the date of its discovery*). The article also notes the draft Commercial Transactions Law would repeal M/61 and regulate "accounting records" by a ministerial regulation within 180 days of publication — a change to watch, not in force. |
| S3 | **VAT Implementing Regulations**, ZATCA, Eighth Edition 04/04/1443H (09/11/2021), English translation (unofficial; Arabic prevails) — Article 66 *Records* | 2021 | Primary (translation), Art. 66 read in full | 6-year retention from the end of the tax period (66(1)); records in Arabic (66(2)); electronic records kept with access from the Kingdom and, when stored electronically: producible on request (3a), **original documents corroborating all entries in accounting books maintained** (3c), the processing system documented (3e), **security measures and controls that can be reviewed to prevent tampering** (3f), the Authority may review the systems (3g). Article 63 (return corrections) was verified from the Tenth Edition Arabic text on 2026-09-16 and is recorded in the decision pack. |
| S4 | **IFRS Foundation jurisdiction profile — Saudi Arabia**, last updated 28 July 2022 | 2022 | Primary | Publicly accountable entities: IFRS as endorsed by SOCPA; other entities: the **IFRS for SMEs** Accounting Standard as endorsed, or full IFRS applied consistently. The pilot (an establishment) is in the second group. |
| S5 | **IFRS for SMEs Accounting Standard**, third edition issued 27 February 2025, effective 1 January 2027 (2015 edition until then); **IAS 1** *Presentation of Financial Statements*; **IAS 7** *Statement of Cash Flows*; **IAS 8** *Accounting Policies, Changes in Accounting Estimates and Errors* (IFRS Foundation, as issued) | 2025 / current | Standards known; paragraph references to IAS 1.29–30, 1.41, 1.54(i); IAS 7.6, 7.45; IAS 8.5, 8.41–42; IFRS for SMEs 3.12–3.13 (reclassified comparatives), 4.2(a), 4.3, 7.20, 10.19–10.21 — paragraph numbers per the standards as issued; the online IFRS for SMEs text could not be quoted paragraph-by-paragraph through the fetch tool, so treat the SME paragraph numbers as *to be verified against the standard* while the substance is not in doubt | The balance-sheet line item is *cash and cash equivalents*; components are disclosed and reconciled (IAS 7.45); changes of presentation reclassify comparatives with disclosure (IAS 1.41 / SMEs 3.12–3.13); an *error* is an omission or misstatement from failure to use reliable information available at the time (IAS 8.5 / SMEs 10.19) |
| S6 | **ISA 500** *Audit Evidence* (extant, IAASB Handbook; A31 reliability hierarchy) and **ISA 240** *The Auditor's Responsibilities Relating to Fraud* (extant, para 33(a): testing journal entries and other adjustments); confirmed via IFAC handbook PDFs and ICAEW "Efficient journals testing" | 2009/2013 handbooks | Secondary confirmation of well-known text | Evidence is more reliable when external, documentary and original; auditors specifically test manual journal entries and post-closing adjustments |
| S7 | **Qoyod** — نموذج دليل الحسابات (chart-of-accounts template page, qoyod.com) | current | Primary (product documentation) | "حساب «البنوك» (112) هو حساب تجميعي، لا يُمكن تسجيل قيد قبض مباشرة عليه، بل يُسجَّل القيد على أحد أبنائه" — the bank header is aggregate, entries land on the per-bank child; "كل قيد يجب أن ينتهي إلى مستوى تشغيلي" |
| S8 | **Wafeq Help** — *Importing your bank account and reconciling transactions*; *Recording expenses* (wafeq.com) | current | Primary (product documentation) | Adding a bank account auto-creates a linked asset account in the chart; the bank account appears in the "Paid through" picker on invoices, bills, expenses; reconciliation is per bank account against its statement |
| S9 | **Microsoft Dynamics 365 Business Central** — *Work with dimensions to track and analyze data* (learn.microsoft.com, page date 2026-04-07) | 2026 | Primary (product documentation) | "instead of setting up separate general ledger accounts for each department and project, you can use dimensions as a basis for analysis"; an incorrect dimension on posted G/L entries can be corrected without touching the account |
| S10 | **Odoo 17 documentation** — *Bank and cash accounts* | current | Primary (product documentation) | "each bank account has a dedicated journal set to post all entries in a dedicated account"; outstanding receipts/payments are transitory accounts between a registered payment and the statement; the bank suspense account holds statement lines until reconciled |
| S11 | **ERPNext documentation** — *Banking in ERPNext* (docs.frappe.io) | current | Primary (product documentation) | "Create a Bank-type ledger account for each Company bank account"; "Do not use one Bank Account record for several real accounts"; statement side (Bank Transaction) vs book side (Payment Entry / Journal Entry) joined by reconciliation on amount, date, party, reference |
| S12 | **Xero Central** — *Manually adjust a bank account balance in Xero* | current | Secondary (search summary; the article is behind a JS shell) | A manual journal cannot be posted to a bank account; use spend/receive money, or a clearing/suspense account to move a balance |
| S13 | **QuickBooks Online Help** — *Managing your Undeposited Funds account* (Intuit) | current | Secondary (search summary of Intuit help) | "Undeposited Funds" is a temporary account for payments received but not yet deposited, so book deposits match bank deposits |

Not found: a primary online copy of the Commercial Books Implementing Regulations (S2 is quoted through a peer-reviewed Saudi judicial journal); a SOCPA pronouncement on cash sub-account presentation (none appears to exist — presentation follows the endorsed IFRS/IFRS for SMEs texts); any ZATCA guidance on how a taxpayer's internal cash ledger must be structured (none; ZATCA's requirements are about records, corroboration, tamper-controls and retention, not chart design).

---

## 3. Decision 1 — historical Mark-Paid and manual cash lines (overrides)

Context: payments marked paid with no bank, manual journal cash lines with no bank identity, no deterministic evidence. D-3 classifies them AMBIGUOUS_REQUIRES_REVIEW and stops.

**1A. May an accountant or admin establish the bank manually after reviewing bank statements and supporting evidence?** Yes. Establishing a fact about an entry from its corroborating documents is the ordinary duty the law imposes (S1 Art. 6; S3 66(3)(c)): the documents exist precisely so the entries can be verified. Nothing in S1–S6 forbids it; S2 dictates only its *form* (a new dated record). **COMMON ACCOUNTING PRACTICE**, with its form a FORMAL REQUIREMENT.

**1B. Recorded as an attribution rather than by changing the original journal account?** Yes — and this is not a preference. S2 forbids altering an entry and requires correction by *another entry on the discovery date*; S3 66(3)(f) requires controls that prevent tampering with records; and under S5 the original account was not wrong (the line item is cash; the bank is a component), so there is nothing to "correct" in the GL at all. The attribution is the "other entry": appended, dated on the day it is made, referencing the line it explains. **FORMAL REQUIREMENT** (form) + **ACCOUNTING STANDARD / PRINCIPLE** (no error to correct).

**1C. What evidence should be required?** Rank the candidates by S6's reliability hierarchy. The bank's own statement is external, documentary and (when imported) original; everything else is internal. The sensible minimum is therefore *the statement line itself*:

| Candidate | Verdict | Why |
| --- | --- | --- |
| Bank account | **Required** | It is the fact being established |
| Statement line — as the imported `transactions` row (bank, date, amount, description already on it) | **Required when the statement is in the system** (the strong form) | External, documentary, already reconcilable; the override then *is* the A2 evidence a human found, and the system can check date/amount agreement mechanically |
| Statement reference + statement date (typed) | **Required when the statement is not in the system** (the weak form) | The same external evidence, cited rather than linked; must be flagged as the weaker form in reports |
| Date and amount agreement with the journal line | **Required as a check** (system-performed; a disagreement needs a stated reason, e.g. one deposit settling several receipts) | It is what makes the link evidence rather than assertion |
| Reviewer identity, timestamp | **Required** (system-supplied) | S1 Art. 9 presumes entries are made with the merchant's knowledge; the record must say by whom |
| Reason / note | **Required** (short free text) | An auditor testing "other adjustments" (ISA 240 ¶33) needs the basis in words |
| Supporting document / attachment | Optional | The statement line is the support; an attachment helps when the weak form is used |
| External reference (payer reference, cheque no.) | Optional | Useful, not evidence of the bank |
| Second-person approval | Not required by any source (see 1D) | — |

**ENGINEERING RECOMMENDATION** grounded in S6; no source prescribes a list, so the minimum above is reasoned, not mandated. This is the part of accountant question (1) that research narrows: *the evidence is the bank statement line; the only open point is whether a typed statement reference (weak form) is acceptable for the pilot's history or whether the statement must be imported first.*

**1D. Role, approval, period, permission, audit event.**
- **A distinct permission** (not "admin" by accident): establishing a fact about history is a different act from posting. PRODUCT DESIGN PRACTICE (the platform already scopes acts by permission).
- **Which role** holds it is the entity's internal-control decision. No Saudi source mandates a role for a small establishment; segregation of duties is a control principle, and the pilot has one finance user. **REQUIRES ACCOUNTANT CONFIRMATION** only in the narrow sense of "who at the pilot" — the *default* should be: the accountant role, and the admin role where no accountant exists.
- **Second-person approval**: not required by any source found. Auditors test manual adjustments (ISA 240 ¶33) whoever made them. Recommendation: not required now; the approval engine can gate it later when a company has two finance users. PRODUCT DESIGN PRACTICE.
- **Open period**: not required. An attribution posts nothing; period locks guard postings. Requiring an open period would be a category error. ENGINEERING RECOMMENDATION.
- **Immutable audit event**: required. S3 66(3)(f) (tamper controls) and S2 (no alteration) both point at an append-only row plus an `audit_logs` event. FORMAL REQUIREMENT (in substance).

**1E/1F. Reversible? Removed, superseded, or a new correction event?** Reversible only by *supersession*: a new attribution row that names the one it replaces, with its own actor, date, evidence and reason; the superseded row stays. Deletion is exactly the alteration S2 forbids, and "status = superseded" written onto the old row would be an UPDATE on an append-only table — so the supersession pointer lives on the *new* row and the resolver picks the latest. Whether a supersession may also clear the bank (a "we were wrong, it is unidentified again" event) — yes, as a supersession to NULL with a reason, never by deleting. **FORMAL REQUIREMENT** (form) + ENGINEERING RECOMMENDATION (mechanism).

**1G. When the bank genuinely cannot be established.** Leave the line where it is, on "Cash and Bank", with an explicit *bank unidentified* status, and stop. No suspense, no correction journal, no guess. See Decision 5 for the accounting distinction. **ACCOUNTING STANDARD / PRINCIPLE**.

---

## 4. Decision 2 — what the historical attribution is

**Is the hybrid sound?** Yes. Separate two identities that the platform already separates:

- the **accounting identity** of a line — its GL account, which determines the financial-statement line item (cash and cash equivalents) and is immutable once posted;
- the **bank identity** of a cash line — which bank's money moved — an *analytical dimension* on the line, obtained either from the leaf (new postings, where the account and the dimension coincide by construction) or from the attribution (history, where the account is the header and the dimension is recorded beside it).

This is the dimension design S9 documents as the alternative to "separate general ledger accounts for each" analysis need, and the subledger idea in general: the GL carries the control balance, the sub-analysis explains it. It is safe for financial reporting because the statement line item is the *total* (S5: IAS 1.54(i)); the bank split is a component analysis (IAS 7.45), and the view guarantees the components sum to the total (every cash line has exactly one bank or none). **ACCOUNTING STANDARD / PRINCIPLE** (line item vs components) + **PRODUCT DESIGN PRACTICE** (dimension beside account).

**Should bank-account balances include attributed historical lines?** Yes, necessarily. A bank's ledger balance exists to be reconciled with that bank's statement (S8, S10, S11 all reconcile per bank account); excluding attributed history would make the ledger balance a figure no statement can match. The split (`ledgerBalanceOnLeaf` + `attributedHistory`) stays visible so the reader can tie the bank figure to the two balance-sheet rows. **COMMON ACCOUNTING PRACTICE**.

**How reconciliation should use it:** per bank, through the view — the bank's accepted statement rows against the bank's leaf lines plus its attributed header lines. Unidentified header lines appear as a named reconciling item ("bank unidentified"), never silently in one bank. ENGINEERING RECOMMENDATION.

**How the readers display the lines:**

| Reader | Display | Change needed? |
| --- | --- | --- |
| Trial balance / balance sheet | Account-keyed: leaves as their own rows, "Cash and Bank" carrying history, all under one *Cash and cash equivalents* subtotal. History is shown as it was posted. | None for Batch 1B. Presenting the subtotal explicitly (one line "Cash and cash equivalents" with the accounts beneath) is the correct statutory shape (S5) and answers accountant question (4) — see §11. |
| General ledger / account statement (header) | Account-keyed as today; add a *Bank* column (attributed bank or "unidentified") and a bank filter on the header's statement so a user can see the history of one bank without a reclassification. | CHANGE LATER (small, reader-only) |
| Bank accounts page / API | `ledgerBalance` = leaf + attributed history, both parts shown. | None |
| Bank reconciliation | Per bank via the view; unidentified as a reconciling line. | CHANGE LATER (the reconciling line) |

**Should a historical line appear under Cash and Bank only, or also in a bank-specific view?** Both — under Cash and Bank in every account-keyed reader (that is where it was posted), and in the bank's view labelled as attributed. The label carries the distinction the user needs: **"Posted to: Cash and Bank · Bank: Riyad Bank — Main Operating (attributed 2026-09-17 by <user>, evidence: statement line #1234)"** versus **"Posted to: Riyad Bank — Main Operating"** for a leaf line. The first says *where the entry sits in the books and how we know the bank*; the second says the two coincide. PRODUCT DESIGN PRACTICE.

---

## 5. Decision 3 — reclassification journal

**Is a reclassification required to enable bank-level historical reporting?** No. The dimension answers "which bank" for every reader (S9's stated purpose of dimensions). Requiring a journal to *report* would be the confusion §3's triage check warns about — a posting in the service of a display.

**When appropriate:** when the entity wants the ledger accounts themselves, not merely the analysis, to carry per-bank balances — for example because its auditor reconciles each bank confirmation to a ledger *account* and the entity prefers that over a sub-analysis, or because a statutory ledger print must show per-bank accounts from a date. In that case one entry per company, Dr each leaf / Cr the header for that bank's attributed balance, dated on the cut-over (activation) date in an open period, `source = migration`, reversible through the seam. **COMMON ACCOUNTING PRACTICE** (a balance move is a reclassification, S12's shape) — whether the accountant wants it is judgement.

**When inappropriate:** (a) backdated into closed periods — S2 requires the correction entry to carry the discovery date, and the platform's period rule already forbids re-dating; (b) as a substitute for evidence — a reclassification can only move what is *attributed*; an unattributed balance cannot be reclassified without guessing; (c) at transaction level — moving each historical line individually re-creates the remap the review withdrew.

**Does the answer depend on whether the records carried bank identity, or on the historical GL using one account?** On the latter. Where the source records carried the bank (A0–A2), attribution is complete and a reclassification is purely presentational. Where the GL used one account and the records are silent, no journal can be posted at all until an override supplies the bank.

**Would it change financial statements unnecessarily?** It changes no total: cash to cash, no P&L, no retained earnings, no VAT figure (Article 63 is not engaged because no return figure moves). It changes the *rows* under the cash subtotal for the period in which it is posted and after. Comparatives are not restated (it is a presentation change from a date, disclosed if material — IAS 1.41 / SMEs 3.12–3.13). **ACCOUNTING STANDARD / PRINCIPLE**.

**Closed periods and filed VAT periods:** untouched. The entry is dated in the open period on the activation date; filed returns are unaffected because no taxable figure changes. **FORMAL REQUIREMENT** (S2 date rule) + ACCOUNTING PRINCIPLE.

**Audit implications:** it is a manual "other adjustment" of the kind ISA 240 ¶33 tests; the run record, the attribution rows it summarises, and the entry's `source = migration` make it explainable line by line.

**Should it be prohibited by default?** Yes. There is no writer today and there should be none until the accountant asks for ledger-level per-bank balances. **ENGINEERING RECOMMENDATION**.

**Does Saudi Ledger need one for D-3?** No. Batch 1B does not depend on it, the readers do not need it, and the law does not ask for it.

---

## 6. Decision 4 — cut-over date

With annotation, there is no single "cut-over date". The five meanings separate cleanly, and only two of them exist as dates today:

| Meaning | Exists? | What it is in this system | Recommendation |
| --- | --- | --- | --- |
| Technical migration timestamp | Yes | When migration 0073 was applied to the database | Keep as a deployment fact; not an accounting date |
| **Activation date** — from which bank-leaf posting is mandatory | Yes, implicitly | The same moment: since 0073 the header is non-posting and every cash path requires a bank, for every company at once | Make it explicit as a *recorded fact* (the date 0073 went live per environment), not a per-company setting; nothing is inferred from it |
| Reporting boundary | No | Readers resolve by *identity* (leaf or attribution), never by date | Do not create one |
| Reclassification date | Only if Decision 3 posts an entry | The open-period date chosen when posting | Defined then, per company, never historical |
| Audit event date | Yes | `cash_cutover_runs.created_at` per company run; each attribution's `created_at`; each override's `created_at` | Keep; these are the S2 "discovery dates" |

**Is an accounting cut-over date needed at all?** No. Historical attribution preserves the original accounting date of every line (nothing is re-dated); the migration is a technical event; leaf posting is mandatory from activation onward. That is the safest model and it is the one already built. **ENGINEERING RECOMMENDATION** consistent with S2 (corrections dated at discovery; originals untouched).

---

## 7. Decision 5 — unattributed historical cash

**The distinction.** *Accounting uncertainty* is not knowing what an entry *is* — whether cash was really received, what the counter-account should be, whether the amount is right. Suspense accounts, correction journals and IAS 8 exist for that. *Bank-identity uncertainty* is knowing exactly what the entry is (cash received on a settled invoice) and not knowing which of the entity's own accounts held it. The line item is unaffected (it is cash either way — IAS 7.6 defines cash as cash on hand and demand deposits without regard to which bank); only a component analysis is incomplete. **ACCOUNTING STANDARD / PRINCIPLE**.

**Therefore:**
- **Keep them on "Cash and Bank" with an explicit "bank unidentified" status** — this is the view's `identity_source IS NULL`, surfaced as a named bucket in every per-bank reader so the per-bank figures plus "unidentified" always equal total cash. Recommended.
- **A dedicated analytical bucket** — that *is* the NULL identity; no new account, no new table. Recommended as presentation of the same fact.
- **Suspense** — wrong: suspense signals accounting uncertainty and invites a clearing entry that would have to guess. Rejected.
- **Correction journal** — wrong: there is nothing to correct. Rejected.

**One caveat that belongs to D-4, not D-3.** A Mark-Paid payment with no bank and no statement row carries a second, different uncertainty: whether the cash was received at all (payment identity). D-3's "unidentified bank" must not be read as "cash confirmed". D-4's backfill and the bank reconciliation are where that question gets answered — a Mark-Paid with no statement row is an unreconciled receipt, and it stays one until a statement line is matched to it (which, when it happens, is also the D-3 evidence).

---

## 8. Decision 6 — audit and evidence model

Minimum conceptual model of an attribution, and what the table as built supplies:

| Field | Required? | As built (`cash_line_bank_attributions`) | Verdict |
| --- | --- | --- | --- |
| journal line (`line_id`, `journal_entry_id`) | Yes | Present, `line_id` unique | KEEP |
| posted account (`account_id`, `account_name`) | Yes — pins what the line said when attributed, proves nothing moved | Present | KEEP |
| bank (`bank_account_id`) and its leaf (`gl_account_id`) | Yes | Present | KEEP |
| classification, rule | Yes — the basis (A0/A1/A2/A3, later A4 human link / A5 attestation) | Present | KEEP |
| run (`run_id`) | Yes for cut-over rows; NULL for reversal mirrors and human overrides | Present, nullable | KEEP |
| created_at | Yes — the S2 discovery date | Present | KEEP |
| **created_by** | Yes for any human act; system runs carry it on `cash_cutover_runs.created_by` | **Absent on the row** | CHANGE LATER (with overrides) |
| **evidence reference** — the statement row (`evidence_transaction_id`, FK) or a typed statement reference + date | Yes for A4/A5 | **Absent** (A0–A3 evidence is in the run's report JSON — adequate for automatic rows) | CHANGE LATER (with overrides) |
| **reason** | Yes for A4/A5 and for every supersession | Absent | CHANGE LATER |
| **supersedes_id** (+ the unique index on `line_id` becomes "unique among active", resolved as latest) | Yes if overrides are reversible (Decision 1E) | Absent; the unique `line_id` currently makes supersession inexpressible | CHANGE LATER — REQUIRES POLICY first (whether overrides exist) |
| status | Not as a mutable column — status is derived (latest row wins; a NULL-bank supersession = unidentified again) | — | NOT NEEDED as a column |
| approval | Not required by any source | — | NOT NEEDED now |
| attachment | Optional | — | NOT NEEDED now |

**Is the table as built sufficient?** For the automatic cut-over, the reversal copy and the readers — **yes**: every row has its line, its account, its bank, its rule, its run and its date, and the run holds the full classification report. For human overrides — **no**, by the four rows marked CHANGE LATER, and none of them should be added before the override policy is confirmed (adding them now would be a shape without a consumer). **ENGINEERING RECOMMENDATION**.

---

## 9. Decision 7 — D-4 dependencies

**The rule first:** BANK IDENTITY is which of *our* accounts carried the cash; PAYMENT IDENTITY is who paid, for which document, for what economic event. D-4 must never use one as the other: "same bank, same date, same amount" is not a payer; "same customer, same invoice" is not a bank. The one-to-one pairing in `evidencePairing.ts` is the shape D-4 inherits *because* it refuses both substitutions.

| D-4 element | Depends on D-3 for | Must not do |
| --- | --- | --- |
| Payment entity | Carries `bank_account_id` (bank identity) **and** party + allocations (payment identity); the cash leg posts to the bank's leaf through the seam | Infer the bank from the party's history, or the party from the bank row |
| Unapplied receipts / on-account | The cash leg still names a bank (the money is in a bank); only the allocation is open | Park cash on the header because the invoice is unknown — the header is closed; an "unapplied" state lives on the payment, not on the cash account |
| Partial payments, overpayments | Nothing new — bank identity per receipt, allocations per document | — |
| Refunds | Cash out through a bank leaf; the refund's payment identity links to the original receipt/credit note | Reuse the original receipt's bank by assumption; the refund names its own bank |
| Cheques / cash received but not yet banked | Not a bank at all — if D-4 supports it, it is a *cash on hand / cheques in hand* account (a cash leaf that is not a bank), the "Undeposited Funds" idea (S13, S10's outstanding accounts) | Model it as an unattributed bank line |
| Customer statements, AR/AP ageing | Payment identity only | Show or need a bank |
| Bank reconciliation | Bank identity only, through the view; statement rows ↔ payments by the same 1↔1 pairing | Match on amount alone |
| Historical payment backfill | Reads bank identity from the view (leaf or attribution) and payment identity from `invoice_payments`/`bill_payments`; reuses `pairOneToOne` for statement↔payment; inherits AMBIGUOUS blocking; an unattributed line is "bank unidentified", not a backfill failure | Re-derive a bank from a payment record, or write to `cash_line_bank_attributions` (only D-3's cut-over, the reversal copy and — once policy allows — the override path write it) |

**Which D-3 decisions affect D-4:** Decision 2 (bank identity resolves only through the view), Decision 5 (unidentified is a first-class state D-4 must display), Decision 6 (if overrides get an evidence link to a statement row, D-4's reconciliation match and D-3's override are the same act — design them as one), Decision 1C (the strong form of evidence is the statement row, which is D-4's reconciliation object). Decisions 3 and 4 do not affect D-4.

---

## 10. Decision matrix

| Decision | Research conclusion | Classification | Recommended behaviour | Needs accountant confirmation | Blocks 1B |
| --- | --- | --- | --- | --- | --- |
| 1A Manual establishment of historical bank | Permitted; the documents exist to corroborate entries | COMMON ACCOUNTING PRACTICE | Allow, under a distinct permission | No (form settled by law) | No |
| 1B Attribution vs changing the account | Alteration forbidden; correction is a new dated record; the account was not wrong | FORMAL REQUIREMENT | Attribution only; never rewrite | No | No |
| 1C Evidence minimum | Bank statement line is the strongest evidence; date/amount agreement checked; actor, date, reason | ENGINEERING RECOMMENDATION | Strong form: link to the imported statement row; weak form: typed statement reference + date, flagged | **Yes — whether the weak form is acceptable for the pilot's history** | No |
| 1D Role / approval / period / audit | No source mandates a role or two-person approval; open period irrelevant; immutable audit event required in substance | PRODUCT DESIGN PRACTICE (role, approval) · FORMAL REQUIREMENT (audit) | Distinct permission; default accountant→admin; no second approval now; no period gate; append-only + audit_logs | **Yes — who at the pilot may do it** (narrow) | No |
| 1E/1F Reversibility | Only by supersession with its own evidence; never deletion | FORMAL REQUIREMENT (form) | Supersession row; NULL-bank supersession returns the line to unidentified | No | No |
| 1G Cannot be established | Not an error; stays on the header, unidentified | ACCOUNTING STANDARD / PRINCIPLE | "Bank unidentified" status; no suspense, no journal | No | No |
| 2 Attribution model | Dimension beside the account; line item is the total, bank is a component | ACCOUNTING STANDARD / PRINCIPLE + PRODUCT DESIGN PRACTICE | Keep the view as the one resolver; bank balances include attributed history; add Bank column/filter on the header's ledger later | No | No |
| 3 Reclassification journal | Not required for reporting; optional for ledger-level presentation; dated at activation, open period; no totals move | COMMON ACCOUNTING PRACTICE (optional) · FORMAL REQUIREMENT (date) | Prohibited by default; build only if asked; one per company through the seam, reversible | **Yes — does the accountant want ledger-level per-bank balances** (judgement, not blocking) | No |
| 4 Cut-over date | No accounting cut-over date; activation is the 0073 moment; audit dates per run | ENGINEERING RECOMMENDATION | Record the activation date as a fact; never re-date history | No | No |
| 5 Unattributed cash | Bank-identity uncertainty ≠ accounting uncertainty | ACCOUNTING STANDARD / PRINCIPLE | Unidentified bucket in per-bank readers; header untouched | No | No |
| 6 Evidence model | Sufficient for automatic rows; overrides need actor, evidence ref, reason, supersession | ENGINEERING RECOMMENDATION | Add the four columns only with the override policy | No (follows 1C/1D) | No |
| 7 D-4 separation | Bank identity via the view only; payment identity via records only; pairing shared | ENGINEERING RECOMMENDATION | Confirmed as a rule for D-4 | No | No — it is the condition 1B must satisfy |

---

## 11. Accountant confirmation — reconciled against the four questions already with him

| # | Question as sent | Verdict | Why |
| --- | --- | --- | --- |
| (1) | What evidence a person must point at before establishing the bank on a historical payment, and which roles may do it | **Rephrase and narrow.** The evidence is answered by the reliability hierarchy and the record-keeping rules: the bank statement line. Ask only: *"May the bank on a historical payment be established from a bank statement line that agrees on date and amount, recorded as a dated note beside the entry with the reviewer's name and reason? If the statement is not yet imported, is a typed statement reference acceptable, or must the statement be imported first? Who at the pilot may do this — the accountant only, or the admin too?"* | The research settles form and evidence class; the accountant decides the weak-form tolerance and the person. Proposed default: strong form when the statement exists, weak form permitted with a flag; accountant role, admin where none. Alternative: import-first only. |
| (2) | Whether history stays on "Cash and Bank" with the bank recorded alongside, or a reclassification entry is posted | **Withdraw as a question; replace with a statement and one optional preference.** The law's correction rule and the standards' line-item/component distinction make "recorded alongside" the correct default; a reclassification is optional presentation. Tell him: *"History stays on Cash and Bank with the bank recorded beside each line; per-bank figures come from that record. If you want the ledger accounts themselves to show per-bank balances, we can post one reclassification per company on the activation date — do you want that?"* | Only the preference is judgement. Proposed default: no reclassification. Alternative: one dated entry per company. |
| (3) | What date a reclassification would carry, and whether it may land in a closed period | **Withdraw — answered by formal sources.** If ever posted: the activation (discovery) date, in an open period; never a closed period, never historical dates (S2; the platform's own period rule). Nothing to ask. | — |
| (4) | Whether two kinds of cash row on the balance sheet is acceptable during the pilot | **Withdraw as a standalone question; fold into (2).** The statement line item is *cash and cash equivalents* (one total); the rows beneath it are components. Two rows under one subtotal are acceptable presentation under the standards; the only thing he could object to is the ledger-level split, which is question (2)'s preference. Confirm in passing: *"The balance sheet shows Cash and Bank (history) and each bank's account (since activation) under one Cash and cash equivalents total — acceptable for the pilot?"* | Proposed default: yes. Alternative: post the optional reclassification so the history moves under the bank rows. |
| **NEW** | *"For the pilot's three Mark-Paid receipts that name no bank and have no matching statement row: may they be attributed from the bank statement once it is imported and a line agrees on date and amount — or do you want them left as 'bank unidentified' until you review them yourself?"* | **Add.** This is the concrete instance the policy will first be applied to; asking it on the real rows gets a usable answer. | Proposed default: attribute from the statement line under the strong form. Alternative: leave unidentified pending his review. |

Nothing else needs him. In particular: the annotation model, the immutability of posted lines, the absence of suspense/correction journals for unidentified banks, the cut-over date semantics and the D-4 identity separation are settled by formal requirements, standards or engineering, not by judgement.

---

## 12. Implementation consequences

| Component | Verdict | Note |
| --- | --- | --- |
| `cash_line_bank_attributions` (table, RLS, grants) | **KEEP** | Sufficient for cut-over rows and reversal mirrors |
| — actor, evidence reference, reason, `supersedes_id` | **REQUIRES POLICY** → then CHANGE LATER | Added together with the override path, not before; the unique `line_id` index becomes "unique among active" then |
| `journal_line_bank_identity` (view) | **KEEP** | Stays the one resolver. When supersession exists: resolve the latest active attribution (a `NOT EXISTS (newer)` arm), still one definition |
| Cut-over service (classification, advisory lock, `nothing_to_do`, whole-company refusal) | **KEEP** | Add rule codes `A4_human_link` / `A5_human_attestation` only when overrides exist; a human-attributed line is simply no longer unattributed |
| `evidencePairing.ts` (`pairOneToOne`) | **KEEP** | D-4's statement↔payment matching reuses it unchanged |
| Per-bank readers (`glSummary`, `monthlyLedgerCash`) | **KEEP**; **CHANGE LATER** to surface the *unidentified* bucket as a named reconciling line | Reader-only |
| General ledger / account statement on the header | **CHANGE LATER** | A Bank column and filter (attributed bank or "unidentified"); no posting change |
| Balance sheet | **KEEP**; **CHANGE LATER** to show the explicit *Cash and cash equivalents* subtotal above the cash rows | Presentation; closes accountant question (4) visibly |
| Bank-account balances (`ledgerBalance` = leaf + attributed) | **KEEP** | Required by reconciliation |
| Bank reconciliation | **KEEP** (per bank via the view); **CHANGE LATER** for the unidentified reconciling line | — |
| Reversal attribution copying (`A3_mirror_of_attributed`) | **KEEP** | With supersession: copy the *active* attribution |
| Reclassification entry writer | **NOT NEEDED** (prohibited by default) | Build only on the accountant's request under Decision 3; one per company, dated at activation, open period, `source = migration`, reversible |
| Cut-over date / activation setting | **NOT NEEDED** as a setting | Record the activation date as a documented fact per environment |
| Audit trail (`cash_cutover_runs`, `audit_logs` `cash_cutover`) | **KEEP**; **CHANGE LATER** to add an `audit_logs` action for each override/supersession | — |
| UI remediation for AMBIGUOUS lines | **REQUIRES POLICY** | No override UI until §11's confirmations arrive; the dry-run report remains the reviewer's list |

**Technical defects found during this research that must be reported separately (not fixed here):** none new. One design gap is recorded above rather than as a defect: the unique index on `line_id` makes reversible overrides inexpressible today — correct for the current append-only contract, and the reason the supersession design is stated now, before any override is built.

---

## 13. D-3 readiness for Batch 1B

Judged on the model, not the suite.

| Aspect | Ready? | Basis |
| --- | --- | --- |
| Accounting model — one leaf per bank under a non-posting header; history on the header untouched | **Yes** | Matches the law's correction rule (S2), the standards' line-item/component distinction (S5), and the Saudi products' own chart shape (S7, S8) |
| Evidence model — automatic rows | **Yes** | Every attribution carries line, posted account, bank, rule, run, date; the run holds the report |
| Evidence model — human overrides | **Not built, and correctly so** | Needs §11 (1) and NEW answered; the columns and rule codes are specified in §8 |
| Historical attribution | **Yes for what evidence supports; blocked for the rest by design** | 44 of 79 local header lines deterministic; the rest wait on policy, not on code |
| Payment-identity / bank-identity separation | **Yes** | Enforced in the pairing and stated as D-4's rule (§9) |
| Bank identity resolution | **Yes** | One view; per-bank readers use it; account-keyed readers make no bank claim |
| Migration safety | **Yes** | No journal line changes, checksum-asserted; whole-company refusal; per-line idempotency; advisory lock; rollback proven |
| Unresolved policy | **Named exactly**: (a) the weak-form evidence tolerance and who may attribute at the pilot (§11 (1)); (b) whether the accountant wants ledger-level per-bank balances (§11 (2), optional); (c) the pilot's three Mark-Paid receipts (§11 NEW) | None of these is a dependency of Batch 1B |

**Verdict:** Batch 1A may be committed and Batch 1B may start. Batch 1B must (i) read bank identity only through `journal_line_bank_identity`, (ii) treat *bank unidentified* as a first-class state in anything it displays or backfills, (iii) reuse `pairOneToOne` for statement↔payment matching, and (iv) not write `cash_line_bank_attributions`. The override path is a separate small batch after the accountant answers §11.

---

## 14. Recommended next sequence

1. **Commit Batch 1A** as it stands (annotation model; excluding the foreign `ai-provider.test.ts` diff, `.env`, local DB state), with this document linked from the decision pack's D-3 status note.
2. **Send the accountant the reconciled list in §11**: withdraw (3) and (4); replace (2) with the statement plus the optional preference; narrow (1); add NEW about the pilot's three receipts.
3. **Start Batch 1B (D-4 payment entity and allocations)** under the four conditions in §13; do not build the historical payment backfill's *bank* side beyond reading the view.
4. **When §11 (1) and NEW are answered — a small "historical bank attribution" batch:** the four evidence columns and supersession (§8), rule codes A4/A5, one permission, the audit event, a minimal reviewer surface fed by the dry-run report; then re-run the pilot's dry-run and commit its cut-over when clean.
5. **Only if §11 (2) is answered "yes, ledger-level":** the one-per-company reclassification writer under Decision 3's constraints, reversible, dated at activation.
6. **Reader polish, any time, no policy needed:** the *Cash and cash equivalents* subtotal on the balance sheet; the Bank column/filter on the header's ledger; the "unidentified" reconciling line on the bank reconciliation.
