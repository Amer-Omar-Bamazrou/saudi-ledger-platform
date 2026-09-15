# Feature inventory and browser walk — 2026-09-15

**Status (2026-09-15): a DATED artifact — the frame, the walk and the findings
as of this date. Current state authority: CLAUDE.md §2; open findings:
CLAUDE.md §5.** Record with the incidents: findings file,
"THE SECOND CORE-PATH WALK" (2026-09-15).

## 1. The frame (state it beside the number)

- **62 UI routes**, derived from `apps/web/src/App.tsx` the way
  `e2e/smoke-crawl.spec.ts` derives them — not typed by hand, so a route added
  tomorrow is in tomorrow's inventory.
- **123 API paths** in `packages/api-spec/openapi.yaml`. The mechanical
  reachability answer is `tests/route-reachability.test.ts` (green: every
  mounted route has a UI terminus except `/llm`, its one known gap). The
  string-matcher used to fill the "API it calls" column below is CRUDER than
  that test — it does not follow the approval engine's templated
  `/{entity}/{id}/{action}` calls or every generated hook — so a blank in that
  column is a limitation of the column, never a finding.
- **45 coming-soon promises** registered in `apps/web/src/lib/comingSoon.ts`
  (counted by `grep -c 'slug: "'`, 2026-09-15), each with a named blocker:
  `build` ×24, `advisorBlockC` ×4, `advisorBlockE` ×3, `cr` ×3, `groq` ×2,
  `inventory` ×2, `mailProvider` ×2, and one each of `entity`, `notDerivable`,
  `pdpl`, `productDecision`, `r1Billing`. `nav-tree.spec.ts` walks every one
  and asserts each names its blocker and work order; this inventory does not
  re-walk them.

## 2. What was walked, and what was not

**Walked (this date, local dev servers, org `e2e-smoke`, seeded by the suite's
`global-setup`):**

1. **The browser suite** — 219 tests, green, 11.9 min. The mechanical half.
2. **The route walk** — all 62 routes, desktop 1280×800 in English AND phone
   390×844 in Arabic (`ksa_lang=ar`, `dir=rtl` asserted on every page), with
   the crawl's three problem classes captured per page: **0 uncaught
   exceptions, 0 API 5xx, 0 API 404** across 124 page loads. The only console
   errors are the four expected 403s on `/operator` for a tenant admin.
3. **Hand-read screenshots** — 48 of 62 phone/Arabic pages read in full, plus
   desktop invoices, balance sheet, audit trail and users for comparison. The
   14 not hand-read are named in the table ("not hand-read"), so the absence is
   visible.
4. **The core path, clicked, in Arabic on a phone, with every mutation's
   request body and response captured** (standing rule 4): New Invoice →
   Create → Approvals: Submit → Approve → Company Settings (VAT) → Approve →
   PDF (both renderings) → Mark Paid → Record Payment → Finance Hub →
   Balance Sheet → VAT return → Journal Entries.

**Not walked:** the operator surface (needs the operator role); accept-invite
(needs a token); scan-review with a capture in hand; sign-up itself (creates a
pending org the gate then holds — L3); every control on every page (the route
walk NAVIGATES; only the core path CLICKS); Arabic-desktop and English-phone.

## 3. The core path — what the client sent and what the ledger did

| Leg | Client → server (captured) | Result |
|---|---|---|
| Create | `POST /invoices` `{customerId, date, items:[{qty 2, unit 100, vat 15}]}` — **no `status` field**, although the form's Status select was set to `sent` | 201, `status: "draft"`, total 230.00 |
| Submit | `POST /invoices/115173/submit` | 200 → `submitted` |
| Approve (1st) | `POST /invoices/115173/approve` | **400 `company_vat_missing`** — "set it in Company Settings before approving" (fail-closed, next step named) |
| Company Settings | `PATCH /companies/current` `{vatNumber: "300000000000003", crNumber: "1010101010", …}` | 200 |
| Approve (2nd) | `POST /invoices/115173/approve` | 200 → `sent`; `invoice_hash`, `previous_hash = GENESIS`, `qr_code`, **`icv = 1`**, `issued_at` set; **`einvoice_documents` = 0** (no active credential → skipped, as designed) |
| GL | — | `GL-INV-2026-000003`: AR 230 / Sales 200 / VAT Payable 30 |
| Document | `GET /invoices/115173/document?lang=ar` and `?lang=en` | 200 `application/pdf`, `%PDF-`, 63,406 / 56,175 bytes; the Arabic rendering shows Hijri + Gregorian dates, seller VAT/CR, buyer VAT, the line, VAT 15%, QR |
| Pay | `POST /invoices/115173/pay` `{amount: 230, paidAt: "2026-09-15"}` (amount PRE-FILLED to the balance) | 200 → `paid`; `GL-…-PAY-3065`: Cash 230 / AR 230 |
| Balance sheet | — | assets 230 (cash 230, AR 0) = liabilities 30 (VAT) + equity 200 (RE) — from all-zero before |
| VAT return | — | box 1: 5,900 → 6,100; output VAT: 885 → 915; net payable 705 → 735 |
| Finance hub | — | liquid assets 230 / due within a year 30 / working capital 200 |

**Verdict: the path works end to end, and every figure moved by exactly the
walk's amounts.** The findings below are what was SEEN on the way.

## 4. Findings, ranked by the triage check (posts? uncorrectable? hidden?)

1. **🔴 Money is clipped on every phone KPI card.** 4- and 5-card grids at
   390px cut the leading digits: `SAR 25,000.00` reads `5,000.00`
   (bank accounts), `12,000.00` reads `000.00` (assets), `4,635.00` reads
   `,635.00`; the invoice list's amount column shows `,000.00` for 1,000.00.
   Present on 22 of the 62 routes. Nothing posts and nothing is wrong in the
   books, but a number is SHOWN that does not describe the value — the "partial
   data is not lenient data" class, rendered. `mobile-shell.spec.ts` cannot see
   it: it asserts no page-level sideways scroll, and the card clips INSIDE its
   box. Countermeasure shape: assert in the browser that every rendered money
   cell's `scrollWidth <= clientWidth`.
2. **🔴 The invoice create form offers a Status select (draft / sent / paid)
   that the client never sends and the server would ignore** (`status` forced
   to `draft` on create and update, by the H1 allow-list). A DECOY control: a
   user who picks `paid` gets a draft and learns nothing. Same class as the
   2026-09-04 "controls offered where they can only fail" finding. Remove the
   select.
3. **🔴 The tax-journal-entries report classifies a tax line by a NAME
   pattern** (`/vat|tax|ضريبة|زكاة/i` over `account_name`, `reports.service.ts`
   ~632) while the posting path resolves accounts by `system_code` — two
   definitions of "this is a tax account" with no forcing function. It found
   the walk's VAT Payable line today; it will also find "Taxi expenses" and
   miss a tenant's renamed VAT account. Key it on `system_code` (VAT_OUTPUT /
   VAT_INPUT / ZAKAT_*).
4. **The Approvals page** is the one unstyled surface: inline table, hard-coded
   `textAlign: "left"` in RTL, raw English `draft` / `submitted` statuses in
   the Arabic UI, and a success toast that interpolates the raw action name
   (`تم: approve`). Functionally correct — every click on the core path went
   through it — but it is where issuing happens, and it reads as unfinished.
5. **Untranslated blocks in the Arabic UI, beyond the sweep's per-string
   count:** the ZATCA onboarding checklist (nine items with descriptions), the
   AP-aging table headers, the owner's-equity statement's five line labels,
   the Users page KPI labels, status/type badges (`Approved`, `Credit`,
   `Service`, `unit`, `invoice`, `monthly`, `straight-line`), the period
   shortcuts (`3m … 24m`), and every date (en-US `Sep 15, 2026`). The date
   class alone touches every list page; it is one formatter, not 60 strings.
6. **The e2e seed inserts rows the product cannot produce** — journal lines
   with no `account_id` (the server refuses them at create), an asset whose
   `cost ≠ book + accumulated` (asset 146). Consequence today: the balance
   sheet silently EXCLUDES the seed's cash/equity lines (all-zero statements on
   an org whose trial balance shows 5,000 / 5,000) and the income statement
   lists them under EXPENSES with a 0.00 total. Neither is a product defect —
   both are the statements meeting impossible rows — but the crawl's
   "rows expected" coverage of the statements is being satisfied by rows the
   product would never write. Seed through the product's own write path, or
   with account ids.
7. **Aging shows a paid invoice with a credit note as a −115.00 receivable
   that is also "77 days overdue".** The negative balance is the deliberate
   post-fix representation (reports.service.ts ~549); the overdue label on a
   negative balance is the part to look at.
8. Small: the VAT page's period picker is clipped at the top on phone; the pay
   dialog rendered shifted off-screen once on phone (not reproduced on the
   New Invoice dialog, same component); the audit-trail action badge clips
   (`eate`) and the time runs into the date; the journal-entries description
   column is cut at the left edge; the Company Settings file input is a native
   English control.

## 5. The route table

Kind and rows-expected come from `e2e/routes.ts`. "Walk" is the mechanical
result per viewport (problem classes + rendered text length). "Hand-read
verdict" is what a reader saw on the phone/Arabic screenshot; "not hand-read"
is stated where it applies.

| Route | Kind | Rows expected | API it calls (page + one level of components) | e2e specs naming it | Walk 2026-09-15 (desktop-en / phone-ar) | Hand-read verdict |
|---|---|---|---|---|---|---|
| `/login` | anonymous |  | `useGetDeploymentBanner` | nav-tree | clean 164ch / clean 175ch (rtl/ar) | OK. |
| `/signup` | anonymous |  | `/auth/signup` | nav-tree | clean 330ch / clean 304ch (rtl/ar) | OK; the turnaround promise is gone (2026-09-15). |
| `/accept-invite` | anonymous |  | `/invitations/{x}` `/invitations/{x}/accept` | nav-tree | clean 79ch / clean 73ch (rtl/ar) | NOT WALKED — needs an invitation token; renders its no-token state. |
| `/verification` | authenticated-no-shell |  | — | nav-tree | clean 65ch / clean 56ch (rtl/ar) | OK (approved state; the pending copy no longer names a turnaround). |
| `/operator` | operator |  | — | nav-tree, smoke-crawl | console 4 34ch / console 4 34ch (rtl/ar) | NOT WALKED — tenant admin gets 403 ×4 (expected); needs the platform-operator role. |
| `/` | app |  | `/findings/status` | deep-link-scope, mobile-shell, nav-tree, rtl-direction, smoke-crawl | clean 482ch / clean 435ch (rtl/ar) | OK — a launcher, no figures by design. |
| `/transactions` | app | yes | `useListCategories` `useListFiscalYears` `useListTransactions` `useUpdateTransaction` | — | clean 350ch / clean 373ch (rtl/ar) | OK. |
| `/review` | app |  | `/transactions/review` `/transactions/review/accept` `/transactions/review/counts` `/transactions/{x}` `/transactions/{x}/settle` `useListFiscalYears` | — | clean 347ch / clean 361ch (rtl/ar) | OK; three held rows with per-row accept. |
| `/recurring` | app | yes | `/recurring` `/recurring/{x}` `/recurring/{x}/runs` `/recurring/{x}/{x}` `useListFiscalYears` | — | clean 212ch / clean 218ch (rtl/ar) | OK; `invoice` / `monthly` badges are raw English; next-run 2099 is seed data. |
| `/findings` | app |  | `/findings` `/findings/run` `/findings/schedule` `/findings/status` `/findings/{x}/acknowledge` `useListFiscalYears` | — | clean 390ch / clean 377ch (rtl/ar) | OK. |
| `/categorize` | app |  | `useGetSummary` `useRunCategorization` | — | clean 266ch / clean 287ch (rtl/ar) | OK. |
| `/upload` | app |  | `/bank-accounts` `useUploadTransactions` | — | clean 515ch / clean 462ch (rtl/ar) | OK; column-reference keys are English by design (CSV headers). |
| `/customers` | app | yes | `/customers` | deep-link-scope, mobile-shell, rtl-direction, smoke-crawl | clean 320ch / clean 348ch (rtl/ar) | 🔴 KPI values clipped at 390px (leading digits lost). |
| `/customers/:id` | param |  | `/customers/{x}` | mobile-shell, nav-tree, smoke-crawl | clean 976ch / clean 1045ch (rtl/ar) | Rendered (1,045 chars); not hand-read. |
| `/quotations` | app | yes | `/quotations` `/quotations/{x}` `/quotations/{x}/conversions` `/quotations/{x}/convert` `/quotations/{x}/{x}` `useListFiscalYears` | nav-tree | clean 339ch / clean 353ch (rtl/ar) | OK; valid-until 2999 is seed data. |
| `/invoices` | app | yes | `/invoices` `/invoices/{x}` `/invoices/{x}/pay` `/recurring` `/{x}/{x}/payments` `useListFiscalYears` | invoice-document, invoice-double-submit, nav-tree, rtl-direction | clean 996ch / clean 1048ch (rtl/ar) | 🔴 KPI values clipped; amount column shows `,000.00` for 1,000.00; create dialog offers a Status select (draft/sent/paid) the server ignores — a DECOY; dates en-US in Arabic. |
| `/credit-notes` | app | yes | `/invoices` `useListFiscalYears` | — | clean 314ch / clean 374ch (rtl/ar) | OK; `Credit` type badge English; description column cut. |
| `/scan-review` | app |  | `/bills` `/bills/{x}/post` `/capture/{x}` `/capture/{x}/discard` `/vendors` `/vendors/match` | — | clean 555ch / clean 650ch (rtl/ar) | Redirects to /bills with no capture in hand (correct); the review itself needs a scan. |
| `/vendors` | app | yes | `/vendors` | mobile-shell, smoke-crawl | clean 281ch / clean 330ch (rtl/ar) | 🔴 KPI values clipped. |
| `/vendors/:id` | param |  | `/vendors/{x}` | mobile-shell, nav-tree, smoke-crawl | clean 616ch / clean 679ch (rtl/ar) | Rendered (679 chars); not hand-read. |
| `/purchase-orders` | app | yes | `/purchase-orders` `/purchase-orders/{x}` `/purchase-orders/{x}/conversions` `/purchase-orders/{x}/convert` `/purchase-orders/{x}/{x}` `useListFiscalYears` | nav-tree | clean 331ch / clean 325ch (rtl/ar) | OK. |
| `/bills` | app | yes | `/bills` `/bills/{x}` `/bills/{x}/pay` `/bills/{x}/post` `/capture` `/{x}/{x}/payments` `useGetDeploymentBanner` `useListFiscalYears` | form-optional-blank, nav-tree, rtl-direction | clean 555ch / clean 650ch (rtl/ar) | 🔴 KPI values clipped. |
| `/ar-aging` | app | yes | `/reports/ar-aging` `useListFiscalYears` | — | clean 547ch / clean 590ch (rtl/ar) | 🔴 five KPI cards clipped to fragments; `Total Outstanding:` English; a paid invoice with a credit note shows as −115.00 and 77 days overdue. |
| `/invoice-summary` | app | yes | `/invoices` `useListFiscalYears` | — | clean 1078ch / clean 1105ch (rtl/ar) | 🔴 KPI clipped; `Outstanding` label English. |
| `/ap-aging` | app | yes | `/reports/ap-aging` `useListFiscalYears` | — | clean 283ch / clean 329ch (rtl/ar) | 🔴 KPI clipped; table headers (OUTSTANDING / BUCKET / DUE / VENDOR / BILL) untranslated. |
| `/payroll-report` | app |  | `/payroll` `useListFiscalYears` | — | clean 471ch / clean 498ch (rtl/ar) | 🔴 KPI clipped. |
| `/asset-schedule` | app |  | `/assets` `useListFiscalYears` | — | clean 420ch / clean 461ch (rtl/ar) | 🔴 KPI clipped; `straight-line` / `4y` English. |
| `/reports` | app |  | — | rtl-direction | clean 323ch / clean 347ch (rtl/ar) | OK. |
| `/finance-hub` | app |  | `/ask` `/ask/status` `useGetBooksStatus` `useGetLiquidity` `useGetTaxCompliance` `useListFiscalYears` `useListPeriodLocks` | — | clean 1062ch / clean 1010ch (rtl/ar) | OK — the walk's cash and VAT liability appear; liquidity ratio narrated, not coloured. |
| `/analytics` | app |  | `/ask` `/ask/status` `useGetCashReconciliation` `useGetDecomposition` `useGetReceivablesBridge` `useGetSummary` `useGetTrend` `useListBudgets` | rtl-direction | clean 2617ch / clean 2365ch (rtl/ar) | OK; 3m/6m/12m/24m English. |
| `/reports/journal-report` | app | yes | `/reports/journal-report` `useListFiscalYears` | — | clean 521ch / clean 504ch (rtl/ar) | OK. |
| `/reports/account-statement` | app |  | `/categories` `/reports/account-statement` `useListFiscalYears` | — | clean 315ch / clean 281ch (rtl/ar) | Empty until Generate; not hand-read past that. |
| `/reports/account-summary` | app | yes | `/reports/account-summary` `useListFiscalYears` | — | clean 502ch / clean 486ch (rtl/ar) | `OTHER` group label English (from the fixture's account-less lines). |
| `/reports/general-ledger` | app | yes | `/categories` `/reports/general-ledger` `useListFiscalYears` | — | clean 318ch / clean 309ch (rtl/ar) | OK (empty until Generate). |
| `/reports/customer-ledger` | app | yes | `/reports/customer-ledger` `useListFiscalYears` | deep-link-scope | clean 882ch / clean 895ch (rtl/ar) | 🔴 KPI clipped; otherwise OK. |
| `/reports/owner-equity` | app |  | `/reports/owner-equity` `useListFiscalYears` | — | clean 792ch / clean 769ch (rtl/ar) | 🔴 KPI clipped; the statement's five line labels are English in the Arabic UI. |
| `/reports/tax-journal-entries` | app |  | `/reports/tax-journal-entries` `useListFiscalYears` | — | clean 424ch / clean 413ch (rtl/ar) | 🔴 KPI clipped; the hint says lines are keyed on account NAMES containing VAT/Tax — see the walk record. |
| `/reports/activity` | app |  | `/reports/activity` `useListFiscalYears` | — | clean 216ch / clean 229ch (rtl/ar) | Rendered (229 chars); not hand-read. |
| `/reports/aging` | app | yes | `/reports/ap-aging` `/reports/ar-aging` `useListFiscalYears` | — | clean 771ch / clean 829ch (rtl/ar) | 🔴 KPI clipped; same negative-overdue line as /ar-aging. |
| `/journal-entries` | app | yes | `/categories` `/journal-entries` `/journal-entries/{x}` `/journal-entries/{x}/post` `/journal-entries/{x}/reverse` `useListFiscalYears` | nav-tree | clean 284ch / clean 295ch (rtl/ar) | Description column cut at the left edge. |
| `/trial-balance` | app | yes | `/reports/trial-balance` `useListFiscalYears` | — | clean 465ch / clean 470ch (rtl/ar) | Credit column cut; `Other` type English (fixture lines). |
| `/income-statement` | app |  | `/reports/income-statement` `useListFiscalYears` | — | clean 571ch / clean 601ch (rtl/ar) | 🔴 KPI clipped; the fixture's account-less Cash/Owner Equity lines are listed under EXPENSES with a 0.00 total. |
| `/balance-sheet` | app |  | `/reports/balance-sheet` `useListFiscalYears` | — | clean 497ch / clean 526ch (rtl/ar) | Correct after the walk (cash 230 / VAT 30 / RE 200); the fixture's account-less lines are silently excluded. |
| `/cash-flow` | app |  | `/reports/cash-flow` `useListFiscalYears` | — | clean 524ch / clean 545ch (rtl/ar) | 🔴 KPI clipped. |
| `/vat` | app | yes | `useGetVatReturn` `useGetVatSummary` `useListFiscalYears` | — | clean 1652ch / clean 1740ch (rtl/ar) | Period picker clipped at the top on phone; boxes moved by exactly the walk's 200 / 30. |
| `/zakat` | app |  | `/companies/current` | — | clean 262ch / clean 250ch (rtl/ar) | OK — the not-implemented state is explained and points at Company Settings. |
| `/employees` | app | yes | `/employees` `useListFiscalYears` | form-optional-blank | clean 523ch / clean 597ch (rtl/ar) | 🔴 KPI clipped. |
| `/payroll` | app | yes | `/payroll` `/payroll/{x}` `/payroll/{x}/approve` | — | clean 308ch / clean 345ch (rtl/ar) | `Approved` badge clipped and English; period labels raw `2026-07`. |
| `/assets` | app | yes | `/assets` `/assets/{x}/depreciate` `useListFiscalYears` | — | clean 391ch / clean 416ch (rtl/ar) | 🔴 KPI clipped. |
| `/products` | app | yes | `/products` | — | clean 275ch / clean 328ch (rtl/ar) | `Service` / `unit` English. |
| `/bank-accounts` | app | yes | `/bank-accounts` | — | clean 174ch / clean 208ch (rtl/ar) | 🔴 KPI clipped (25,000.00 reads 5,000.00). |
| `/budgets` | app | yes | `/budgets` `/budgets/{x}` `/categories` | — | clean 351ch / clean 390ch (rtl/ar) | 🔴 KPI clipped. |
| `/categories` | app | yes | `useCreateCategory` `useListCategories` | — | clean 2962ch / clean 3120ch (rtl/ar) | OK (long list; Arabic names present). |
| `/approvals` | app |  | `/approvals/pending` `/{x}/{x}/{x}` | — | clean 488ch / clean 514ch (rtl/ar) | 🔴 Unstyled inline table, hard-coded `textAlign: left` in RTL, raw English statuses, success toast reads `تم: approve`. |
| `/company` | app |  | `/companies/current` `/companies/current/fiscal-years` `/companies/current/logo` | — | clean 1247ch / clean 1138ch (rtl/ar) | OK; native file input is English. |
| `/closed-months` | app | yes | `/period-locks` `/period-locks/{x}` `useListFiscalYears` | — | clean 539ch / clean 489ch (rtl/ar) | OK. |
| `/audit-trail` | app | yes | `/audit-logs` `useListFiscalYears` | — | clean 501ch / clean 501ch (rtl/ar) | Action badge clipped (`eate`); time runs into the date. |
| `/zatca` | app |  | `/zatca/onboarding` | — | clean 1341ch / clean 1308ch (rtl/ar) | 🔴 the nine-item 'before you start' checklist is entirely English in the Arabic UI. |
| `/users` | app |  | `/auth/register` `/auth/users` `/auth/users/{x}` `/auth/users/{x}/reset-password` `/orgs` `/orgs/{x}/invitations` `/orgs/{x}/invitations/{x}` `/orgs/{x}/invitations/{x}/resend` `/orgs/{x}/members` `/orgs/{x}/members/{x}` | — | clean 424ch / clean 433ch (rtl/ar) | 🔴 KPI labels English AND clipped; role select English. |
| `/change-password` | app |  | `/auth/change-password` | — | clean 193ch / clean 237ch (rtl/ar) | OK. |
| `/integrations` | app |  | — | — | clean 1125ch / clean 867ch (rtl/ar) | OK. |
| `/coming-soon/:slug` | param |  | — | mobile-shell, nav-tree, smoke-crawl | clean 879ch / clean 715ch (rtl/ar) | Rendered (715 chars); not hand-read. |


## 6. How to re-run

The scripts are throwaway (scratchpad), deliberately not in the repo — the
durable countermeasures are the suite and the guards named above. The recipe:
start both dev servers, run the browser suite once (it writes
`e2e/.auth/state.json` and `ids.json`), then a Playwright script that opens a
context on that storage state, sets `ksa_lang` in an init script, and
screenshots every route derived from `App.tsx` at 1280×800 and 390×844. The
core path is the same context clicking the Arabic control labels, with
`page.on("request"/"response")` filtered to non-GET `/api/` calls.
