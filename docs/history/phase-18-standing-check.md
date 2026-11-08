# Phase 18 — the standing check, run on the phase (AC-13)

Status (2026-11-03): the six parts of CLAUDE.md §3's standing check, run once over the whole of Phase 18 and recorded here. Current state authority: CLAUDE.md §2.

**The criterion (owner, 2026-11-01, memo §3):** "AC-13: write the phase's standing check (all six parts) as one document." The contract's AC-13 adds that the tests which asserted the closed gaps (its §16.3) are re-pointed in the commits that closed them. Scope: register §11.125, written before this document.

**Measured on** `e3f463f0`: main `78e91e4e` with R-14's registry. Main carries the same tree as `ffb887ea` (#294's merge; `git diff` empty). Each part's scripts and raw outputs are kept in the round's evidence folder `2026-11-03-r15-ac13-standing-check/`: `tools/callers-census.ts`, `tools/writers.mjs` and `tools/tables.mjs`, with `part1-callers-v3.json`, `part2-writers-v2.json` and `part6-sweep-hits.txt`. The superseded first-pass outputs are kept beside them.

## The frame

- **The phase's capabilities are the controls in the registry,** `apps/api/src/controls/registry.ts` (R-14, AC-1): **65 controls**. Their enforcement points are 38 triggers, 75 named CHECKs and 72 code points.
- **Every count below states its own frame.** A part that could not be run mechanically says what it read by hand and how.
- **Outside the frame:**
  - controls built before Phase 18;
  - the phase's documents and decisions themselves (the register is their record);
  - the browser suite's walks, which are evidence of reachability but are not re-run here.

## Part 1 — every capability has a production caller, ending at a named terminus

**Method.** The call graph is R-11c's (`tests/helpers/postingRouteCensus.ts`), generalised from posting units to every registry code point:
- **A unit** is any function. A call is an edge to its callee. So is a function that is nested in a unit, or referenced by it (a callback it passes may run).
- **The approval engine's verbs** reach the one adapter member each runs. **An interface member** reaches every implementation.
- **Entries:** 428 routes (mounted as `routes/index.ts` and nested routers mount them), 14 request middlewares, the 2 job files, and 25 boot-time calls.
- **A route counts as called by the web** when `apps/web/src` imports the generated client operation for its method and path, or names the path as a literal.
- **A code point's target** is its own function, or every unit that references it when it is a constant.

**Result: 72 code points.**
- **59** reach at least one route the web calls.
- **10** are request middleware or the values it uses, crossed by every request: G02, G04's key table, G45, DR-06, DR-27's gate, DR-22's refused-reference record, O-6.
- **1** is a script run by hand on a demo database (G71's refusal comes before its first query).
- **2** reach only routes the web never calls:
  - **G43** (`llmRoutesDeterministicOnly`): the four `/llm/*` routes, listed in `route-reachability.test.ts`'s `KNOWN_UNREACHABLE`. The AI layer is dark by construction. The control is what keeps it so, and it is proven by its own test.
  - **G60** (`runItemFailure`): the depreciation run and the recognition run. This is **finding F-1** below.
- Seven code points reach some routes the web calls and some it does not. Each has a web terminus.
- **One route file has no mount,** `routes/documentHttp.ts`. It holds shared helpers, not routes.

**Database points.** A trigger or CHECK has no caller: it fires on every write to its table, so its reach is its table's writers.
- For `journal_entries` and `journal_entry_lines`, the writers are named by AC-3's census (R-13: the posting seam and the five writers outside it) and AC-9's (R-11c: the 47 routes that can post).
- For the tables Phase 18 created or extended, part 2 names every column's writer.

**The method found its own blind spots, and they were closed before this result was taken.** The first pass reported 12 code points with no caller, and more routes than now with no web call. Four defects in the census, not in the product, explained them:
- methods inside a repository object were not resolved;
- a function passed as a value was not an edge;
- routers mounted inside sub-routers were not mounted;
- the generated client writes `method: 'POST'` with single quotes, so every mutation read as a GET.

The corrected pass (`part1-callers-v3.json`) resolves all 12. The routes it still found without a web call were then searched for by hand in `apps/web/src` (F-1 and F-2 below).

| Control | Code point | Terminus |
| --- | --- | --- |
| G02 | `lib/auth.ts` `SESSION_ABSOLUTE_LIFETIME_MS` | request middleware |
| G02 | `lib/auth.ts` `endEndedSessions` | request middleware |
| G03 | `repositories/members.repository.ts` `withLastAdminGuard` | 4 routes (4 called by the web) |
| G03 | `services/members.service.ts` `lastAdminRefusal` | 4 routes (4 called by the web) |
| G04 | `services/accounting/tenantReferences.ts` `assertLineReferencesOwned` | 51 routes (49 called by the web) · scheduled jobs |
| G04 | `lib/dbRefusals.ts` `TENANT_REFERENCE_KEYS` | request middleware |
| G43 | `services/categorization/llmCategorizer.ts` `llmRoutesDeterministicOnly` | 4 routes (0 called by the web) |
| G45 | `lib/csrf.ts` `refuseCrossSiteWrites` | request middleware · server boot |
| G45 | `lib/csrf.ts` `CSRF_REFUSAL` | request middleware · server boot |
| DR-06 | `lib/auth.ts` `refuseUntilPasswordChanged` | request middleware |
| DR-27 | `services/operator.service.ts` `BREAK_GLASS_WINDOW_MS` | 1 route (1 called by the web) |
| DR-27 | `lib/auth.ts` `refuseUntilPasswordChanged` | request middleware |
| DR-27 | `routes/auth.ts` `recordSignInEvent` | 2 routes (2 called by the web) |
| DR-26 | `lib/rbac.ts` `requireReadOf` | 1 route (1 called by the web) |
| DR-26 | `services/reporting/reportExport.service.ts` `EXPORT_NATIVE_RESOURCE` | 1 route (1 called by the web) |
| G71 | `scripts/src/demo-seed.mts` `refuseOutsideDemoMode` | a script run by hand |
| DR-22 | `routes/auth.ts` `recordSignInEvent` | 2 routes (2 called by the web) |
| DR-22 | `services/bankAccounts.service.ts` `recordClearedDefaults` | 4 routes (4 called by the web) · scheduled jobs |
| DR-22 | `services/einvoice/onboarding/zatcaOnboarding.service.ts` `zatcaOnboardingService.recordCredentialAct` | 2 routes (1 called by the web) |
| DR-22 | `services/audit.service.ts` `auditService.postedEntry` | 47 routes (45 called by the web) · scheduled jobs |
| DR-22 | `middleware/referenceRefusals.ts` `recordReferenceRefusal` | request middleware |
| DR-14 | `services/controlFlags.service.ts` `controlFlagsService.flagIfSamePerson` | 24 routes (24 called by the web) · scheduled jobs |
| DR-15 | `services/journalEntries.service.ts` `correctionAttributionOf` | 6 routes (6 called by the web) |
| DR-33 | `packages/shared/src/protectedAccounts.ts` `protectedAccountRule` | 6 routes (6 called by the web) · scheduled jobs |
| DR-33 | `services/journalEntries.service.ts` `journalEntriesService.create` | 2 routes (2 called by the web) · scheduled jobs |
| DR-33 | `services/transactions.service.ts` `assertCategoryExists` | 3 routes (3 called by the web) |
| DR-34 | `repositories/journalEntries.repository.ts` `documentOwner` | 6 routes (6 called by the web) |
| DR-34 | `services/journalEntries.service.ts` `ownedEntryRefusal` | 6 routes (6 called by the web) |
| DR-32 | `services/journalEntries.service.ts` `journalEntriesService.reverse` | 6 routes (6 called by the web) |
| DR-32 | `services/transactionPosting.service.ts` `transactionPostingService.repost` | 1 route (1 called by the web) |
| G18 | `packages/shared/src/businessDate.ts` `isCalendarDate` | 81 routes (79 called by the web) · scheduled jobs |
| G18 | `lib/writeGuards.ts` `assertDateString` | 45 routes (44 called by the web) · scheduled jobs |
| G60 | `lib/savepoint.ts` `withSavepoint` | 26 routes (21 called by the web) · scheduled jobs |
| G60 | `lib/runItemFailure.ts` `runItemFailure` | 2 routes (0 called by the web) |
| O-6 | `lib/responseCommit.ts` `COMMIT_ROLLED_BACK_BODY` | request middleware |
| O-6 | `packages/db/src/index.ts` `CommitRolledBackError` | request middleware |
| G08 | `repositories/journalEntries.repository.ts` `updateEntryIfStatus` | 17 routes (17 called by the web) · scheduled jobs |
| G08 | `repositories/bills.repository.ts` `updateIfStatus` | 14 routes (14 called by the web) |
| G08 | `repositories/invoices.repository.ts` `updateUnissued` | 14 routes (14 called by the web) |
| G08 | `repositories/payroll.repository.ts` `updateRunIfStatus` | 26 routes (26 called by the web) · scheduled jobs |
| DR-17 | `services/tax/taxComputations.service.ts` `taxComputationVersionApprovable` | 4 routes (4 called by the web) |
| DR-17 | `services/quotations.service.ts` `quotationsService.update` | 1 route (1 called by the web) |
| DR-17 | `services/purchaseOrders.service.ts` `purchaseOrdersService.update` | 1 route (1 called by the web) |
| DR-18 | `services/approvalsQueue.service.ts` `approvalsQueueService.pending` | 1 route (1 called by the web) |
| G50 | `services/einvoice/einvoiceInput.loader.ts` `loadEInvoiceInput` | 11 routes (11 called by the web) · scheduled jobs |
| G58 | `services/invoices.approvable.ts` `issueInvoice` | 11 routes (11 called by the web) · scheduled jobs |
| G58 | `services/creditNotes.ts` `assertNoteIsValid` | 13 routes (13 called by the web) · scheduled jobs |
| DR-36 | `repositories/invoices.repository.ts` `openForSettlement` | 1 route (1 called by the web) |
| DR-37 | `services/invoices.approvable.ts` `noteOnAssetSale` | 11 routes (11 called by the web) · scheduled jobs |
| G59 | `services/payments.service.ts` `paymentsService.unallocate` | 1 route (1 called by the web) |
| G36 | `lib/idempotency.ts` `replayOrRefuse` | 21 routes (21 called by the web) · scheduled jobs |
| G37 | `lib/idempotency.ts` `idempotencyOf` | 6 routes (6 called by the web) |
| G40 | `lib/idempotency.ts` `replayOrRefuse` | 21 routes (21 called by the web) · scheduled jobs |
| G40 | `lib/idempotency.ts` `keyReusedRefusal` | 21 routes (21 called by the web) · scheduled jobs |
| G64 | `services/reconciliation.service.ts` `reconciliationService.settle` | 1 route (1 called by the web) |
| G65 | `services/bills.service.ts` `billsService.update` | 1 route (1 called by the web) |
| G66 | `services/accounting/supplierPayments.service.ts` `supplierPaymentsService.validateAllocations` | 4 routes (4 called by the web) |
| G53 | `services/accounting/tenantReferences.ts` `assertProductsOwned` | 10 routes (10 called by the web) · scheduled jobs |
| G53 | `services/accounting/tenantReferences.ts` `assertVendorOwned` | 1 route (1 called by the web) |
| G55 | `services/accounting/tenantReferences.ts` `assertBankLeavesInCompany` | 48 routes (46 called by the web) · scheduled jobs |
| G38 | `repositories/transactions.repository.ts` `lockBankImport` | 1 route (1 called by the web) |
| G38 | `services/accounting/bankStatements.service.ts` `prepareStatement` | 1 route (1 called by the web) |
| DR-24 | `services/purchaseEvidence/duplicates.service.ts` `duplicatesService.forBill` | 5 routes (5 called by the web) · scheduled jobs |
| DR-23 | `services/bankDetailChanges.service.ts` `bankDetailChangesService` | 5 routes (5 called by the web) · scheduled jobs |
| DR-19 | `services/companyControls.service.ts` `companyControlsService` | 3 routes (3 called by the web) |
| G68 | `services/payroll.approvable.ts` `payrollAccrualDate` | 14 routes (14 called by the web) · scheduled jobs |
| DR-41 | `services/payroll.service.ts` `payrollService.pay` | 1 route (1 called by the web) |
| DR-41 | `repositories/payroll.repository.ts` `openPayableOf` | 4 routes (4 called by the web) |
| G2b | `services/accounting/vatFilingClearing.ts` `postVatFilingClearing` | 1 route (1 called by the web) |
| DR-38 | `services/purchaseEvidence/vatEvidence.service.ts` `vatEvidenceService.claimHeldVat` | 2 routes (2 called by the web) |
| DR-45 | `services/tax/whtCorrection.service.ts` `assertCashKept` | 1 route (1 called by the web) |
| DR-45 | `services/accounting/wht.ts` `refuseLateWithholdingOnReentry` | 16 routes (16 called by the web) · scheduled jobs |

## Part 2 — every field it depends on has a production writer

**Frame:** every column the Phase 18 migrations (`0121`–`0155`) added, by `ALTER TABLE … ADD COLUMN` or in `CREATE TABLE`. That is **224 columns on 31 tables**.

**Writer evidence, strongest first:**
- **a database default** (a timestamp, or the tenant's organisation and company read from the connection);
- **a migration's trigger** assigning `NEW.column`, or SQL writing it;
- **SQL text** in `apps/api` or `scripts` inserting or updating it;
- **the Drizzle field** as a key of an object passed to `.values(`, `.set(` or a write-named function, in a file that touches that table or calls its repository.

The table restriction was added after a sample showed generic names (`description`, `createdBy`) credited from unrelated files. The first pass is kept.

**Result: no Phase 18 column is without a writer.**
- **204 columns:** found by the census.
- **20 columns:** found by hand. Each is built into an object away from the call that writes it, so the census could not see it:
  - `employees.gosi_regime`, `_basis`, `_set_by`, `_set_at`: `gosiRegimeFields` (`services/employees.service.ts:46`), spread into create (`:134`) and update (`:153`);
  - the ten GOSI columns of `payroll_items`: the items `payroll.service` builds (`:166`–`:173`), inserted by `insertItems` (`:194`);
  - `invoices.charge_substance`, `charge_event_date`: the create allowlist (`services/invoices.service.ts:178`);
  - the five `journal_entries.origin_*` columns: `correctionAttributionOf` (`services/journalEntries.service.ts:49`), spread onto the mirror (`:619`).
- **36 columns are written only by their database default.**
  - 33 are by design: timestamps, and the tenant columns filled from the connection.
  - 3 are flags a service also sets: `employees.gosi_in_kind_housing` and `_exempt` (the employees allowlist, `:22`), and `payroll_items.gosi_hazards_floor_open` (`payroll.service.ts:170`).

| Table | Migration(s) | Columns added | Database writes (default, trigger) | Code writes found by the census | Read by hand |
| --- | --- | --- | --- | --- | --- |
| `asset_disposals` | 0136 | 2 | 0 | 2 | — |
| `bank_detail_change_requests` | 0151 | 13 | 6 | 9 | — |
| `bill_payments` | 0124 | 2 | 0 | 2 | — |
| `bills` | 0136 | 5 | 0 | 5 | — |
| `company_control_settings` | 0143 | 6 | 4 | 3 | — |
| `control_flags` | 0154 | 11 | 11 | 6 | — |
| `customer_refunds` | 0152 | 1 | 0 | 1 | — |
| `employees` | 0127, 0128 | 6 | 2 | 0 | `gosi_regime`, `gosi_regime_basis`, `gosi_regime_set_at`, `gosi_regime_set_by` |
| `invoice_rejections` | 0134 | 10 | 4 | 7 | — |
| `invoices` | 0121, 0133, 0134, 0136 | 10 | 0 | 8 | `charge_event_date`, `charge_substance` |
| `journal_entries` | 0129, 0130, 0146 | 12 | 0 | 7 | `origin_authorised_by`, `origin_authorised_on`, `origin_fiscal_year_end`, `origin_fiscal_year_start`, `origin_vat_filing_reference` |
| `payment_allocations` | 0152 | 1 | 0 | 1 | — |
| `payroll_items` | 0127, 0128, 0135 | 10 | 1 | 0 | `gosi_employee_rate`, `gosi_employer_rate`, `gosi_in_kind_housing`, `gosi_pension_floor_wage`, `gosi_period_days`, `gosi_regime`, `gosi_service_days`, `gosi_wage_base`, `gosi_wage_fixed_period` |
| `payroll_runs` | 0127, 0135 | 3 | 0 | 3 | — |
| `period_lock_events` | 0130 | 8 | 4 | 4 | — |
| `period_locks` | 0130 | 3 | 0 | 3 | — |
| `statement_authorisations` | 0130 | 10 | 4 | 6 | — |
| `supplier_deposit_forfeitures` | 0142 | 13 | 4 | 10 | — |
| `supplier_payment_allocations` | 0152 | 2 | 0 | 2 | — |
| `supplier_refunds` | 0152 | 2 | 0 | 2 | — |
| `tax_computation_versions` | 0145 | 1 | 0 | 1 | — |
| `users` | 0144, 0147 | 2 | 1 | 2 | — |
| `vat_corrections` | 0137 | 10 | 4 | 6 | — |
| `vat_return_filings` | 0130 | 12 | 5 | 8 | — |
| `wht_contracts` | 0141 | 9 | 4 | 6 | — |
| `wht_instalment_request_events` | 0140 | 10 | 4 | 6 | — |
| `wht_instalment_requests` | 0140 | 11 | 4 | 7 | — |
| `wht_refund_claim_events` | 0140 | 12 | 4 | 8 | — |
| `wht_refund_claims` | 0140 | 12 | 4 | 8 | — |
| `wht_withholdings` | 0141 | 3 | 0 | 3 | — |
| `zakat_income_tax_filings` | 0130 | 12 | 5 | 8 | — |

## Part 3 — every client it depends on has a real implementation

**Search shape:** every exported interface or type in `apps/api/src` named for an external client (`…Transport|Provider|Store|Vault|Scanner|Mailer|Alerter|Client|Signer|Kms`). Nine were found. The registry's code-point files were also checked for direct imports of any of them: only `llmCategorizer.ts` calls `fetch` (G43).

| Client | Real implementation (non-test) | Phase 18 controls that depend on it | What remains |
| --- | --- | --- | --- |
| `Alerter` | `lib/alerter.ts` (a webhook; the no-op is refused in production) | O-6 pages on a rolled-back commit (`lib/tenant.ts`) | B1/B2: `ALERT_WEBHOOK_URL` wired at deployment |
| `Mailer` | `lib/mailer.ts` | None. DR-06's and G72's notification halves are not built (BLOCKED INFRA). | B1: a mail provider |
| `EInvoiceProvider` | `zatcaDirectProvider.ts` | The issue path the freeze and identity controls guard (G29, G49, G50, G58, T1c, DR-37) | — |
| `ZatcaHttpClient` | `liveZatcaClient.ts` | G41's half (a ZATCA 400 goes to `needs_review`) | The production endpoints have never been called (CLAUDE.md §2) |
| `ZatcaOnboardingClient` | `zatcaOnboardingClient.ts` | DR-22's record of an onboarding or renewal | M12.7/M12.9 (the entity) |
| `KmsProvider` | `aws-kms` and `local-dev` (`signing/keyWrapper.ts`) | The signing step of the issue path | C3: the AWS SDK and key policy at deployment |
| `AiProvider` | `services/ai/provider.ts` | G43 keeps it dark | C6: the Groq agreement |
| `ArchiveStore` | `localFsArchiveStore.ts`, `supabaseArchiveStore.ts` | None | — |
| `MalwareScanner` | `lib/malwareScanner.ts` | None | C4: the clamd sidecar |

Every client a Phase 18 control touches has a real implementation in non-test code. What is missing is deployment wiring, already on CLAUDE.md §5's list, not code.

## Part 4 — every live external result is recorded with its endpoint

**None is claimed.** Phase 18 made no live call to ZATCA, a bank, GOSI or any other external service.

**Search shape:**
- the Phase 18 test files, for the live ZATCA client, ZATCA hosts, or any `https://` URL (the only hits are `example.com`/`example.sa` origins in G43's and G45's tests);
- the register, for "sandbox" and "live" claims. One hit names its own stand-ins: a self-signed certificate under the local-dev KMS, and no ZATCA call.

The phase's ZATCA-facing controls (G41's routing, DR-22's outbox and credential records) attest our handling of an answer, proven against stubs. CLAUDE.md §2's "NOT verified — we have never submitted an invoice to ZATCA" stands unchanged.

The regulatory figures the phase built from (GOSI rates, VAT and WHT articles) come from primary texts and the accountant, not from an endpoint. Their sources are in the register entries that decided them.

## Part 5 — every claim of absence carries its search shape

**Frame:** the absence claims in the register's §11 entries. They were found by a scan for "not reproduced", "already true on main", "no … exists/writer/caller/path/route", "nothing writes/reads/calls" and "has no UI/caller/writer", together with the census entries, and each was read by hand. Claims in design notes outside the register were not re-read.

| Claim | Where | Search shape | Would be falsified by |
| --- | --- | --- | --- |
| No register identifier records the suspense rule | §11.2 | Stated: the terms searched | A DR-, N- or S- entry naming it |
| Code that can still run after its request's transaction has ended | §11.17, §11.18 (B-O6) | The commit-site census | A commit site outside it |
| Nothing reads `joiningDate` (GO-02) | §11.19 | File references, no grep shape | A reader. Since closed: GOSI added the regime and reads the joining date for proration |
| Nothing writes the `rejected` e-invoice status (RJ-02) | §11.19 | File references, no grep shape | A writer. **Still true:** both readers filter `needs_review` or `rejected` together, so neither reads a zero |
| A manual journal is never created posted (DR-11, DR-12 "already true on main") | §11.47 | The create allowlist read | A create path inserting `posted`. AC-3's writer census (§11.120) later covered every journal writer and found none |
| No test asserts the break-glass behaviour R-1 changed | §11.83 | Stated: the grep over both test trees | A test asserting an unexpiring temporary password |
| No product writer wrote a zero source id | §11.90 | Stated | A writer of `source_id = 0` |
| Source types with no dedicated correction path | §11.109, §11.110 (R-10) | Per type, in the matrix test | A correction path for a type marked `allowed` |
| Pages with a submit route and no Submit control | §11.118 | Stated: routes, hooks, generated functions, `apiFetch`, and each page read | A submit route whose page has no control |
| Journal writers outside the posting seam | §11.120 | Stated: every insert, update and delete on the journal tables | A write the census does not list |
| Routes that can post | §11.111, §11.117 (R-11c) | Derived by the census and compared both ways with the test's table | A posting route outside the 47 |
| Triggers and CHECKs outside the registry; DDL stated as a string | §11.121, §11.123 (R-14) | The migration parser, with known-present cases; `EXECUTE` statements measured | A Phase 18 guard the two-way test does not see |
| **F-1, F-2 (this document): routes with no web caller** | Part 1 | Generated operations imported by `apps/web/src`, and path literals | A hook or `apiFetch` naming the path |

Two of these claims carry file references but no search shape (§11.19, GO-02 and RJ-02). They were written in the GOSI and rejection research of 2026-10-26, before the round's rule. They are marked here rather than rewritten.

## Part 6 — tests asserting absence are re-pointed when the absence ends

### The contract's §16.3 list (the tests that asserted a gap)

| Test | Asserted | Gap | Now |
| --- | --- | --- | --- |
| `approval.test.ts` "approves straight from draft (self-approve on create)" | Self-approval | G05 / DR-14 | **Unchanged, by decision.** DR-14 records a flag and never refuses (owner, §11.82); the flag is proven by `phase18-r11a-dr14-control-flags.test.ts`. The test's adapter names no maker, so it raises none |
| `reversal-party.test.ts`, the receipt and payment reversals | Generic reversal of payment entries | G14 / DR-34 | **Unchanged, by decision.** R-10's matrix records `customer_payment` and `bill_payment` as `allowed`: no dedicated correction path (AC-6's explicit "none") |
| `phase13b1-reversal-guard.test.ts` "planted positives … a bill PAYMENT still reverse" | The same | The same | **Unchanged,** for the same reason |
| `phase11-reversal-and-ageing.test.ts` "A4 — a reason is OPTIONAL" | An optional reversal reason | G12 | **Unchanged.** G12 is deferred by the memo (§3). Reopening a month does require a reason (T1e) |
| `quotations.test.ts` "an APPROVED quotation is still editable" | Edit after approval | G10 / DR-17 | **Re-pointed** in `30dc9604`, merged with the closing PR #275 (`28f5d83a`): an approved quotation is refused an edit |
| `g04-tenant-keys-database.test.ts` "deleting a product still works …" | A product delete clears posted lines' reference | G34 | **Unchanged.** G34 is deferred by the memo (§3) |
| `g30-issued-invoice-bank-details.test.ts` premise: a bookkeeper's IBAN PATCH answers 200 | A bookkeeper changes the IBAN | DR-23 | **The premise still holds, by decision.** Dual control applies only where two usable admins exist, and this organisation has one. Its IBAN fixtures were re-pointed to valid IBANs in `98482327` (#267, H-8). The two-admin case is `phase18-r6-dr23-dual-control.test.ts` |
| `g04-zero-membership.test.ts` "CONTROL: re-activating an existing INACTIVE member returns 201 …" | An unguarded `assign` | G03 | **Unchanged and still valid.** G03's guard (#212) refuses only what would leave no usable admin, and this control case does not; the guard is proven by `g03-last-admin-guard.test.ts` |
| `zatca-renewal-and-sweep.test.ts` `retain_until = issuedAt + 6 years` | Six-year retention | G48 | **Unchanged.** G48 is blocked on the advisor (C7) |
| `credit-note-not-payable.test.ts` "paying a DEBIT NOTE is refused the same way" | A debit note cannot be settled | G62 / DR-36 | **Re-pointed** in `de89bf8e`, merged with the closing PR #263 (`51e27628`): a debit note is collected like an invoice |
| `tax-journal-entries-keying.test.ts`, a manual `VAT_OUTPUT` line | A manual VAT line is allowed | DR-33 | **Re-pointed** in `2f64e61f`, merged with the closing PR #277 (`15f953b9`). Its fixture then took the product's own path in `66d85c29` (#280, R-3) |
| `fixed-assets-report.test.ts`, a manual journal on the asset accounts | A manual protected-account line | DR-33 | **Re-pointed** in `2f64e61f` (#277), per §11.78's old → new list |
| `phase16-17-audit-fixes.test.ts` MG-2, manual bank-leaf and retained-earnings lines | The same | DR-33 | **Re-pointed** in `2f64e61f` (#277) |

**Result:**
- Every row whose gap closed was re-pointed in the commit set of the PR that closed it.
- Every unchanged row is unchanged because its gap is still open by an owner decision. That decision is named in its row.

### The register's record of pinned-assertion and fixture changes

**Frame:** a scan of the register's §11 entries for "re-pointed", "pinned assertion", "assertion(s) change(d)", "old → new", "was:" and "obsolete". It finds **49 entries**, listed in `part6-register-sections.txt`.

The round's own changes were each written before the commit that made them, old → new:
- G16: §11.10, §11.11, §11.13;
- H-17: §11.70, §11.72;
- H-19: §11.78, §11.79;
- R-2: §11.87, §11.88;
- R-3: §11.91;
- R-6, R-9, R-11a: §11.100, §11.107, §11.112;
- the four approvals-queue assertions: §11.59–§11.60, applied by #292.

The other entries the scan finds are D-4 statements that name the tests a change would touch, and build records that report what changed.

### A fresh sweep of both test trees

**Search shape:** `apps/api/src/tests` and `apps/web/e2e`, for `NotImplementedError`, "not implemented", "not yet built/implemented/enforced/refused", `KNOWN_GAP`, "still accepts/allowed/editable/reverses/posts/succeeds/works/passes", "documents/pins/asserts the gap", "the gap stays", "gap is open", and "until G../DR-..".

**Result: 49 hits, each read. None asserts a gap Phase 18 closed.** They are:
- control cases that prove a guard narrows without breaking (most of them);
- comments recording an assertion already re-pointed (`quotations`, `quotation-conversion`, `ubl-generation`);
- the empty `KNOWN_GAPS` lists of `state-machine-reachability`;
- G34's product-delete test, whose gap is deferred.

The list is `part6-sweep-hits.txt`.

**The limit, stated:**
- An assertion that contradicted a closed gap on the path the gap's fix changed would fail in CI, and main's runs are green.
- What no sweep can see is an absence asserted on a path the fix did not touch. The sweep reads the tests' words, not their semantics.

## Findings for the owner (carried to R-16's report)

- **F-1: the depreciation run and the recognition run have no way to start from the product.**
  - `POST /assets/depreciation-runs` and `POST /recognition-schedules/runs` have generated client operations (`runAssetDepreciation`, `runRecognitionPeriod`). `apps/web/src` imports neither, names neither path, and no job schedules either.
  - The Assets page's own header says running depreciation "arrives with the next FA phases".
  - G60's run-item seam (`runItemFailure`) is reached only through these two routes. The control is correct (proven over the service by `g60-run-item-savepoint.test.ts`), but no user can start a run for it to guard.
  - This predates Phase 18, and it is not new: the master plan's **N-G** carries the 2026-10-15 inventory's "run endpoints with no UI/job caller". It is unchanged on main.
  - `route-reachability.test.ts` passes because it checks each mount (`/assets`, `/recognition-schedules`), not each route.
  - **Closed 2026-11-08 (carry-over Batch 3, PR #315).** A "Run depreciation" screen on the Assets page and a "Run the month" screen on the accruals page call the two generated operations. Each shows the month and the count (assets in service; active schedules), says no preview exists, and confirms naming both. It lists every posted and skipped item, each skip explained by its code. The per-route block that #314 added to `route-reachability.test.ts` now finds both callers, and their gap entries are gone.
- **F-2: the dedicated ZATCA certificate renewal route has no web caller.**
  - `POST /zatca/onboarding/renew` has no generated client operation, and `apps/web/src` never names the path.
  - The onboarding page calls only `POST /zatca/onboarding`. Its copy tells the tenant that renewal needs a new OTP.
  - Whether running onboarding again serves as a renewal was not traced here.
  - DR-22's record of a renewal is therefore reached only from the API.
  - This predates Phase 18 (M12), and it bears on CLAUDE.md §5's B1: renewal needs the tenant's own OTP, so the tenant needs a way to act on it.
- **Neither is a defect in a Phase 18 control.** Both are reachability gaps the per-route terminus found and the per-mount guard could not. They are recorded, not fixed (the round's scope rule).
