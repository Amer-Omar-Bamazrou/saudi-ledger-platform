# Phase 2 — ZATCA Phase 2 / Fatoora (M12): as-built record, decisions and landmines

> Moved verbatim out of `CLAUDE.md` at the CLAUDE.md restructure
> (2026-08-13, post-M16.2). This is the historical record; the current
> operating summary lives in [`CLAUDE.md`](../../CLAUDE.md).
>
> Related: the cross-milestone findings and named failure modes live in [`findings-and-lessons.md`](findings-and-lessons.md); the divergence log is [`../zatca/spec-vs-implementation-divergences.md`](../zatca/spec-vs-implementation-divergences.md).

## Phase 2 — Milestone 12: ZATCA Phase 2 (Fatoora) Integration (IN PROGRESS)

> **📄 Status summary:** [`docs/zatca/m12-status.md`](../zatca/m12-status.md) —
> what is done, **what is verified against the live API versus only locally**,
> what M12.7/M12.9 need, and the full pre-production queue. Read that first; this
> section is the narrative behind it.

Transmitting invoices to ZATCA. M11.6 fixed the invoice **data** (each invoice
carries the tenant's real VAT number and company name, verified by decoding the
TLV QR and recomputing the hash); M12 builds the **integration** — UBL 2.1 XML,
XAdES-BES cryptographic stamping, per-tenant certificates, and the clearance /
reporting APIs. Research report and decision: see `docs/zatca/README.md` for the
specifications, environments and enforcement timeline.

**Why now:** ZATCA Wave 24 entered enforcement 1 Jul 2026; Wave 25 (announced
24 Jul 2026) drops the threshold to **SAR 187,500** with a **1 Feb 2027**
deadline — effectively every VAT-registered Saudi business. Phase 2 is no longer
a feature, it is the price of entry for the product.

### ⚠️ THE SCOPE SPLIT — READ THIS BEFORE CONTINUING M12

**M12 is deliberately built in two halves, separated by a real-world business
dependency that does not yet exist.**

| | Sub-milestones | Gating requirement |
| --- | --- | --- |
| **IN SCOPE NOW — ✅ ALL COMPLETE** | **M12.0 → M12.6 _and_ M12.8** | Sandbox only. **Email registration, nothing else.** |
| **BLOCKED, DO NOT START** | **M12.7 and M12.9** | **A registered Saudi company entity with an active ZATCA VAT registration and ERAD credentials.** |

**M12.4 stays IN SCOPE — it is not an external dependency.** The 2026-08-07
outage that stopped it cleared on 2026-08-09, and the sandbox has since **issued a
real CCSID against our CSR without any account, VAT number or OTP validity**. The
gating requirement for M12.7/M12.9 is a *taxpayer registration*; M12.4 never
needed one. Do not move it into the blocked row.

**The company entity and its Saudi VAT/ERAD registration DO NOT EXIST YET.** That
is a real-world business step the owner will take **after the platform is
complete** — it is not a signup form and cannot be worked around. ZATCA's
**Simulation** environment (`fatoora.zatca.gov.sa`) requires ERAD credentials,
i.e. a real active taxpayer account, and production requires the same. The
**Sandbox** (`sandbox.zatca.gov.sa`) requires only an email.

The split is therefore **by external dependency, not by sequence number**: build
everything that does not need a real taxpayer account, which is *everything
except* the two milestones that literally submit to a live ZATCA environment.
**M12.8 (archival, residency design, PCSID renewal reminders, operator
visibility) is fully buildable today** and is deliberately NOT deferred despite
its number — it needs no ZATCA credentials.

Only **M12.7** (simulation end-to-end) and **M12.9** (production pilot) wait.
When the entity exists they resume with no rework — sandbox exercises the
identical API surface.

**Do not** attempt to "finish" M12 by mocking simulation, and **do not** onboard
any real tenant to production until M12.7 and M12.9 have actually run against a
real VAT registration.

### 🔴 OPERATING PRINCIPLE: **LIVE API > SDK > PDF**

**Revised in M12.4.** The original principle — *binaries beat PDFs* — was right
but **incomplete**. There is a third tier above the SDK, and it cost a full
rewrite to find:

| Source | Trust | Why |
| --- | --- | --- |
| **Live compliance API** | 🟢 **authoritative** | it is what actually gates real invoices |
| **SDK / decompiled binaries** | 🟡 useful offline signal | ZATCA's bundled SDK is a **stale 2021-era writer** |
| **PDF specification** | 🔴 unreliable narrator | fourteen documented divergences |

**The proof.** `crypto/qr.ts` was written from the PDF and was wrong in 3 of 4
tags. It was then rewritten from decoded SDK bytes — and was **STILL WRONG**, in
tags 3, 7, 8 and 9. It only became correct when determined from live
`/compliance/invoices` responses.

**The M12.3 SDK differential passed byte-for-byte the entire time.** It proved
only that we matched a stale writer — **necessary but NOT sufficient**. Worse,
its green status was actively misleading: it read as validation.

So: **a green SDK differential is NOT evidence of compliance. Only a live PASS
is.** Keep the SDK differential — it is a genuinely useful fast offline check
that needs no network — but never treat it as the gate. The gate is
`tests/zatca-compliance-live.test.ts`.

The three most counter-intuitive divergences (#10 `SignatureValue` not over
`SignedInfo`, #11 SignedProperties digest over dom4j `asXML()`, #12 `CertDigest`
over the base64 string) were **decompilation-only until M12.4** and are now
confirmed against reality — a standard invoice would not clear if any were wrong.

### The older framing, retained: ZATCA's BINARIES beat the PDFs

**Whenever ZATCA's documentation and ZATCA's shipped software disagree, follow
the software** — and record the divergence in
[`docs/zatca/spec-vs-implementation-divergences.md`](../zatca/spec-vs-implementation-divergences.md)
with what the PDF claims, what the binary does, and which we track.

This is not a stylistic preference. **TWELVE divergences have been found so far,
every one of them by running or DECOMPILING ZATCA's SDK rather than reading their
PDF**, and every one would have failed at M12.4 with a rejection and no useful
diagnostic: the elliptic curve, three separate CSR-structure errors, an entirely
undocumented required certificate extension, three XAdES property errors, a
signature that uses *two different digest encodings in the same document*, a
`SignatureValue` that is **not computed over `SignedInfo` at all**, a
SignedProperties digest taken over **dom4j `asXML()` rather than any
canonicalisation**, and a `CertDigest` over the **base64 certificate string
rather than its DER**.

#### ✅ VALIDATION STATUS — #1–#12 confirmed against ZATCA; #13 CORRECTED

**M12.4 ran all six compliance documents against the live API.** Every divergence
is now checked against reality rather than against a decompiled binary.

| Divergence | Area | Status |
| --- | --- | --- |
| **#1–#5** | curve, CSR structure, template extension | ✅ confirmed (CCSID issued, binds our key) |
| **#6–#12** | XAdES properties, digests, `SignatureValue`, `CertDigest` | ✅ **confirmed** — standard invoice + debit note returned `PASS` / `CLEARED` |
| **#13** | QR tags 3, 6–9 | 🔴 **WAS WRONG, now corrected and pinned** |

**#13 was wrong twice, from two different sources.** Written from the PDF →
wrong; rewritten from decoded SDK bytes → **still wrong**; correct only from live
responses. The verified layout: tag 3 has **no trailing `Z`**, tags 6 and 7 are
base64 **strings**, tags 8 and 9 are **raw bytes**, and tag 9 comes from the
CERTIFICATE (the CA's signature), not from our signature. The M12.3 note flagging
the `r`/`s` split as "intent UNVERIFIED" is what stopped this shipping — it was
an artefact of ZATCA's TLV writer.

**How the fault was isolated:** standard documents passed while both simplified
ones failed with QR-only errors. Standard invoices are cleared by ZATCA, which
generates their QR itself — so that clean split localised the bug to the QR and
exonerated the whole signature chain in a single run.

Full evidence, with the exact error codes per tag:
[`docs/zatca/spec-vs-implementation-divergences.md`](../zatca/spec-vs-implementation-divergences.md).

**🔴 Sandbox traps — a green sandbox run is NOT validation:**

- **The sandbox accepts ANY OTP** (`123456`, `123345`, `111222` all issue). It
  says **nothing** about whether the real OTP path works.
- **`requestID` from the compliance endpoint is the constant stub
  `1234567890123`.** Never build reconciliation logic on it.
- **The sandbox PCSID is a SHARED CANNED CERTIFICATE**
  (`CN=TST-886431145-399999999900003`, "Maximum Speed Tech Supply LTD", issued
  Jan 2024, VAT `399999999900003`) — **not bound to our key**. Signing with it
  would sign as another taxpayer. `activateCredential` now verifies the returned
  certificate's public key against the stored private key and **refuses** a
  mismatch (`CertificateMismatchError`); the check is correct in every
  environment and catches this automatically.
- **PCSID issuance is NOT a compliance gate in sandbox** — a PCSID is issued even
  when compliance documents FAIL. So compliance results must be **asserted
  directly** from `/compliance/invoices`, never inferred from "we got a
  certificate".

**Decompile early.** Several were invisible to black-box testing — ~30
canonicalisation variants were tried and failed before decompiling
`SigningServiceImpl` answered it in minutes. CFR (`cfr.jar`) works on the SDK
jar; the packages are `com.zatca.sdk.*` and `com.gazt.einvoicing.*`.

**The natural experiment — the strongest evidence for this principle.** M12.3
produced a clean controlled comparison, entirely by accident:

| Module | Written from | Correct? |
| --- | --- | --- |
| `crypto/invoiceHash.ts` | verified against ZATCA's binaries | ✅ |
| `crypto/csr.ts` | verified against ZATCA's binaries | ✅ |
| `crypto/xades.ts` | verified against ZATCA's binaries | ✅ |
| `crypto/qr.ts` | **the PDF alone** | ❌ **wrong in 3 of 4 Phase 2 tags** |

Same engineer, same session, same care. The only variable was the source. The
three modules checked against binaries were right; the one written from the
specification was wrong — its docstring even confidently explained the PDF's
(incorrect) rule that tag 6 carries raw digest bytes.

**So: anything written from the PDF is SUSPECT until a binary confirms it.** And
note *how* it stayed hidden — M12.2's `[QR] PASSED` was validating ZATCA's *own*
signed output, not ours. **A differential must compare OUR output against
ZATCA's**, or it proves nothing about our code.

The PDFs are not uniformly wrong (the transform chain, QR TLV rules and
algorithm identifiers all check out) — they are **unreliable**, which is worse,
because it means you cannot tell which parts to trust without checking.

**So, concretely:**
- Verify against the SDK **before** building, not after. `fatoora -csr`,
  `-generateHash`, `-sign` and `-validate` are ground truth.
- ZATCA's own XAdES template lives inside their jar at **`xml/ubl.xml`** — it is
  the real XAdES specification.
- Differentials against the SDK are **blocking tests**, not investigative ones.
  A correct hash with a structurally wrong signature passes a hash check and
  still fails at M12.4.
- The SDK is checksum-pinned so a ZATCA-side change is detectable.

### Decision: BUILD DIRECT (not a certified provider)

ZATCA's own Solution Providers Directory states the list is *"a guiding list
(non-legally binding to taxpayers)"* and that taxpayers *"have the option to get
E-invoicing services from any company, as long as the Solution used ... complies
to E-invoicing requirements."* **There is no certification gate** — compliance
attaches to the solution and is proven by passing ZATCA's own compliance checks.

Building directly was chosen because (a) ZATCA compliance **is** the product for a
Saudi accounting platform, not a side integration; (b) every provider prices
**per taxpayer** (SAR 99–299/month at SME tier) while we are a multi-tenant
platform with N taxpayers — the economics do not close; (c) the credible
providers (Wafeq, ClearTax, Qoyod) sell **competing** accounting software.

Two hedges are **mandatory**, not optional:

1. **Use a maintained open-source library for the cryptographic and XML
   primitives** (`zatca-xml-js` or equivalent). **Do NOT hand-write C14N, XAdES,
   or the CSR template.** Read the source, pin the version, own the orchestration
   / multi-tenancy / state ourselves.
2. **Build behind a swappable `EInvoiceProvider` interface from day one**, so a
   certified provider can be slotted in per-tenant later without re-architecting.

### Three pre-existing platform bugs fixed as part of M12

These are real bugs today, independent of ZATCA; Phase 2 merely escalates them
from latent to compliance-breaking. They are fixed in the milestone where they
belong, not ad hoc:

- **[M12.1] The hash chain is org-scoped, not company-scoped.**
  `getPreviousInvoiceHash` (`services/accounting/zatca.ts`) orders by
  `invoices.id` across the whole organization. ZATCA's chain and ICV are per EGS
  unit / per VAT registration, so a multi-company org **interleaves two chains
  into one** — invalid.
- **[M12.1] `sellerIdentity` resolves the wrong company.**
  `requireIssuanceSeller` uses `companiesRepository.findActive()` (the org's
  *first-created* company) and ignores the invoice's own `companyId`. Under Phase
  2 this signs the invoice **with the wrong company's certificate**.
- **[M12.6] The per-request tenant transaction cannot survive a synchronous
  external API call.** `resolveTenant` holds a Postgres transaction open for the
  whole request with `idle_in_transaction_session_timeout='15s'`; clearance is a
  blocking outbound call to ZATCA inside `issueInvoice()`. This **forces the
  outbox/worker redesign** in M12.6 (which also delivers the retry that reporting
  requires anyway).

### Sub-milestones

- **M12.0 (done): external dependency kickoff.** Specs pulled and pinned
  (`docs/zatca/`, with `fetch-specs.sh` + SHA-256 manifest — PDFs gitignored);
  sandbox confirmed live and email-only; hosting/residency established as an open
  deployment decision rather than a migration — though the *premise* recorded
  then (in-country storage mandated) was corrected in M12.8: see the residency
  correction. Sandbox account registration is a manual owner step (see
  `docs/zatca/README.md`). **The Compliance & Enablement Toolbox (SDK) is
  PUBLIC — no account needed** (`fetch-sdk.sh` +
  [`docs/zatca/sdk-manifest.md`](../zatca/sdk-manifest.md)): UBL 2.1 XSDs, 55
  `BR-KSA-*` schematron rules, an offline validator/signer CLI, a test cert +
  secp256k1 key, and the genesis PIH. It **proved the `secp256k1` curve three
  ways** (see M12.3). It ships **no sample invoices**, and its ruleset is dated
  2021 — a locally-clean invoice can still fail M12.4.
- **M12.1a (done): Phase 2 data model + the two multi-company bug fixes.**
  Migration `0016_m12_1a_zatca_phase2_fields` — additive and nullable throughout;
  existing invoices are pre-ZATCA legacy and deliberately **not** backfilled with
  `uuid`/`icv` (the ZATCA chain starts fresh at first onboarding, so NULL is the
  correct representation).
  - **`invoices`**: `zatca_uuid`, `icv`, `issued_at`, `document_type`. **`issued_at`
    is NOT `date`** — `date` is the accounting date the ledger and reports use;
    `issued_at` is the real issuance instant ZATCA needs and the 24-hour
    simplified-reporting clock runs off. Issuance previously fed a fabricated
    `${date}T00:00:00Z` into the QR. **Unique index on `(company_id, icv)`** — the
    DB is the real guarantee against a reused counter under concurrent approvals.
  - **`einvoice_documents`** (NEW, tenant-scoped **business** table with RLS +
    app-role grants — *not* owner-only; the tenant is legally required to retain
    their own cleared XML). Holds the Phase 2 artifacts (`invoice_hash` =
    base64 SHA-256 of canonical XML, `previous_invoice_hash`, 9-tag `qr_code`,
    `signed_xml`, `cleared_xml`) **and** the transmission state (`flow`,
    `status`, attempts, `next_attempt_at`, ZATCA warnings/errors). Split from
    `invoices` on identity-vs-transmission lines: M12.6 churns this row hard with
    retries and it carries large XML blobs, neither of which belongs on the row
    the accounting core reads. **This is where M12.6's outbox lives.**
  - **`invoice_items`**: `tax_category_code` (S/Z/E/O), exemption reason
    code+text, `unit_code` (default `PCE`). **The 15% → `'S'` backfill is
    deliberately partial**: a `vat_rate = 0` line is genuinely ambiguous between
    zero-rated (Z) and exempt (E) — different tax treatments the existing data
    cannot distinguish — so those stay NULL and issuance will **fail closed**
    demanding an explicit answer rather than the migration guessing a tax fact
    (same principle as M11.6's seller VAT).
  - **`customers`**: structured buyer national short address (building/street/
    district/postal). Nullable — only STANDARD (B2B) invoices require it.
    Free-text `address` retained for display.
  - **`companies`**: `egs_serial_number` + `zatca_onboarding_status`. Key
    material is NOT here — it lands in M12.5's owner-only encrypted vault.
  - **BUG 1 FIXED — the hash chain was org-scoped.** `getPreviousInvoiceHash(db,
    invoicesTable)` is gone from `services/accounting/zatca.ts`; it is now
    **`invoicesRepository.previousInvoiceHash(companyId)`** — filtered to ONE
    company and moved into the repository layer where Drizzle access belongs
    (that it lived in the accounting layer behind `any` params is exactly why the
    missing filter was invisible).
  - **BUG 2 FIXED — seller identity came from the first-created company.**
    `requireIssuanceSeller` now takes the **invoice's own `companyId`** as a
    required argument. A second layer had to be fixed too: `resolveDraftSeller`
    stamped the draft via `findActive()`, and because issuance honors the stamped
    values as an override, that wrong identity survived approval — it now uses
    the new `companiesRepository.findCurrent()` (the `app.current_company_id`
    GUC, i.e. the company whose id the row actually gets).
  - **Test** `tests/multi-company-invoice-identity.test.ts` — one org, two
    companies. Proves interleaved issuance keeps each chain separate
    (`A1 → B1 → A2` links A2 to **A1**, not B1), one genesis root **per company**,
    a company-B invoice carries B's VAT, drafts still consume no sequence number,
    and the DB rejects a reused ICV within a company while allowing it across
    companies. **Verified failing against the pre-fix code.**
  - **Also fixed (pre-existing, unrelated): a genuinely non-deterministic audit
    test.** `audit.test.ts` destructured `const [createLog, updateLog] = rows`
    from an `ORDER BY created_at` query. **Postgres `now()` is the TRANSACTION
    timestamp**, so the create and the update — written in one request
    transaction — carry an *identical* `created_at` and the sort had no tiebreak.
    Latent flakiness the `customers` column addition exposed by shifting physical
    row order. **`audit_logs.id` is a random uuid, not a sequence, so ordering by
    it does not fix this** (a first attempt did exactly that, passed locally by
    luck, and failed in CI). The test now selects rows **by `action`** and
    asserts their content — ordering was never the property under test. The other
    four transition tests use `toContain` and are order-insensitive; their
    `ORDER BY` is incidental and was left alone.
    **If you ever need true audit ordering, `audit_logs` has no monotonic
    sequence column — add one rather than ordering by `id`.**
- **M12.1b (done): credit & debit notes as first-class documents.** Notes are
  `invoices` rows carrying `document_type` — ZATCA requires them in the SAME
  per-EGS hash chain and ICV sequence, so a separate table would be wrong.
  - **🔴 A CREDIT note reverses; a DEBIT note does NOT.** A debit note is an
    ADDITIONAL charge (undercharge, price correction upward), so it posts in the
    same direction as an invoice: Dr AR / Cr Sales + VAT. Only the credit note
    reverses. Treating both as reversals understates AR and output VAT.
  - **🔴 AMOUNTS ARE STORED POSITIVE; the direction lives in `document_type`.**
    Negative storage was evaluated and rejected because it FAILS SILENTLY in two
    of the four invoice reports while working in the other two — which is what
    makes it dangerous:
    - **AR aging** skips them (`if (outstanding < 0.01) continue`), so it drifts
      from balance-sheet AR with nothing to show it;
    - **the VAT return** misroutes them — a negative `vat_amount` fails the
      `> 0` guard, computes a rate of 0, lands in the ZERO-RATED box and **never
      reduces output VAT**. A silent filing error against ZATCA.
    Every consumer applies **`documentSign()`** (`reports.repository.ts`)
    explicitly, so forgetting it is a visible omission. Six consumers: AR aging,
    balance-sheet AR, VAT return, customer ledger, customer balance, and the GL.
  - **The note→original reference is a REAL FK** (`invoices.original_invoice_id`,
    migration `0020`) with a CHECK constraint: an invoice has neither reference
    nor reason; a note must have BOTH. ZATCA's `cac:BillingReference` carries the
    original's NUMBER but it is DERIVED from the referenced row, so it can never
    drift. `note_reason` is in the constraint because **BR-KSA-17** requires it.
  - **Closed periods: the NOTE'S OWN date governs.** Correcting an invoice from a
    closed period is legitimate and is NOT blocked — the correction posts in the
    current open period, which is standard practice. Dating the note *into* the
    closed period is refused by the existing `checkPeriodOpen`. Consequence worth
    knowing: the closed period's VAT return does not change; the adjustment lands
    in the note's period.
  - **Over-crediting is refused (409)** naming the invoice total, what is already
    credited and what remains. Checked at create AND re-checked at approval,
    because a concurrent note can consume the remaining credit while one sits in
    the queue. Debit notes have no equivalent ceiling.
  - **Zero-movement proven** (`tests/credit-notes-zero-movement.test.ts`) to the
    M10 standard: a draft AND submitted note move zero across AR aging,
    balance-sheet AR, the VAT return and the customer balance; approval posts the
    correct direction.
  - **Fixed here (pre-existing, in scope):** `customers.repository` had **no
    status filter at all**, so DRAFT invoices inflated every customer balance — a
    gap M10 left when it added `approvedInvoicesOnly()` to the reports but not to
    that path.
- **M12.2 (done): UBL 2.1 XML generation + the `EInvoiceProvider` seam.**
  - **`EInvoiceProvider`** (`services/einvoice/provider.ts`) is declared in FULL
    now — `onboard` / `renewCertificate` / `buildDocument` / `submit` — with the
    unbuilt methods throwing a typed `NotImplementedError` naming their
    milestone, so a caller can never mistake "not built" for "succeeded with
    nulls". The interface is deliberately **coarse**, matching what a vendor
    actually sells (invoice data in, finished artifacts out); an interface shaped
    around our internal steps could not be implemented by any provider, which
    would defeat the seam. Selection is **per company** (`resolveProvider`), since
    ZATCA identity is per EGS unit. Ours is `zatca-direct`.
  - **The generator is OURS, the crypto is not.** `buildInvoiceXml` is a pure
    function (`EInvoiceInput` → XML string, no DB/context/clock) built on
    `xmlbuilder2`. UBL generation is domain-model→schema mapping; the library
    reservation applies to **C14N, XAdES and the CSR template** in M12.3.
  - **The M12.2/M12.3 boundary is read off the spec, not invented.** The ZATCA
    transform excludes exactly `ext:UBLExtensions`, `cac:Signature` and
    `cac:AdditionalDocumentReference[cbc:ID='QR']` — precisely what M12.3
    injects. Everything M12.2 emits IS signed content, **including the ICV and
    PIH references**. A test asserts those three are absent, so the boundary
    can't silently drift.
  - **VALIDATED AGAINST ZATCA'S OWN SDK** (`tests/ubl-zatca-validator.test.ts`):
    generate → `-sign` → `-validate`. **Standard and simplified invoices both
    pass XSD, EN 16931 and all 55 `BR-KSA-*` rules** (simplified also passes QR).
    The SDK ships no sample invoices, so there is no golden file — this IS the
    authority. Skips **loudly** (a prominent banner) when Java or the SDK is
    absent; **CI now installs Java 17 and caches the SDK by its pinned
    checksum**, with the fetch `continue-on-error` so a SharePoint outage can't
    red-build unrelated work.
  - **🔴 The signature stage is deliberately NOT asserted.** The SDK's bundled
    `cert.pem` **expired 18 Apr 2024** and its subject VAT isn't our fixture's
    seller, so `[SIGNATURE] FAILED` is guaranteed regardless of what we generate
    — it says nothing about our document. Real signature verification is M12.3
    (our keys) and M12.4 (a sandbox CSID). Do not "fix" this by chasing the
    signature result.
  - **🔴 TWO schematron requirements the rule text does not state.** Both found by
    running the validator, not by reading the spec — the reason the CI investment
    was worth it:
    - **BR-KSA-09 (seller)** needs `cbc:PlotIdentification` — the National
      Address **additional number** (KSA-23). Added as `companies.additional_number`.
      (Only a *warning*.)
    - **BR-KSA-10 (buyer)** is a hard **error** and additionally asserts
      **`cbc:CountrySubentity`** and `cbc:CitySubdivisionName`, while its message
      names only "street, city, postal code, country code". Added as
      `customers.province`. **A regression test pins this**, so deleting the
      field fails loudly instead of silently breaking every B2B invoice.
    - Also noted: `cbc:BuildingNumber` is capped at **4 characters** (BR-CL-KSA-17).
    - Migration `0017_m12_2_national_address_fields` (additive, nullable — the
      fields are not required for simplified invoices).
  - **`cac:AccountingCustomerParty` is MANDATORY in UBL even for an anonymous B2C
    sale** — omitting it fails XSD before any KSA rule is reached. BR-KSA-10
    exempts simplified invoices from the buyer *address*, not from the element.
  - **Assembler** (`einvoiceInput.assembler.ts`) is the only DB-aware piece and
    **fails closed** on anything that would mint a legally-invalid document:
    a NULL line tax category (the ambiguous 0%-VAT case M12.1a left unbackfilled),
    a non-standard category with no exemption reason, or a missing company VAT /
    UUID / ICV. Standard-vs-simplified is derived from whether the **buyer** is
    VAT-registered.
  - **Test-infra fix:** the Java subprocesses starved other suites' `beforeAll`
    hooks at the 10s default, failing four unrelated DB-backed suites. Fixed with
    `hookTimeout: 60_000`. **Do NOT "fix" it with `fileParallelism: false`** —
    that is several times slower AND couples suites to each other's leftover
    state (`operator.test.ts` fails under that ordering while passing alone).
- **M12.3: cryptography** — ECDSA **`secp256k1`** keygen, CSR, XAdES signing, QR
  tags 6–9, and **replacing `computeInvoiceHash`** (see the landmine below).
  **Build against [`docs/zatca/security-standards-notes.md`](../zatca/security-standards-notes.md)**
  — spec-verified notes with two 🔴 traps that a plain reading of ZATCA's own
  document gets wrong: the curve is **`secp256k1`, NOT P-256** (P-256 appears only
  in an explicitly *illustrative* table; ZATCA's SDK emits
  `ec-secp256k1-priv-key.pem`), and the CSR **invoice type goes in `title`, not
  `businessCategory`** (the spec assigns OID 2.5.4.15 to two different rows).
  Both fail only at M12.4, after the whole crypto layer is built.
- **M12.4 (done): sandbox onboarding + compliance checks — THE CRYPTOGRAPHY IS
  NOW PROVEN AGAINST ZATCA.** CSR → CCSID → the six compliance documents → PCSID.
  - **All six compliance documents PASS** against the live sandbox — standard and
    simplified, invoice / credit note / debit note — with zero errors and zero
    warnings, plus a zero-rated (0% VAT) invoice. This is the milestone that
    validates divergences **#6–#12** and corrected **#13** (see the validation
    status above). The connectivity block that stopped it cleared on 2026-08-09.

    **🔴 SCOPE OF THAT PASS — read before citing it.** It came from
    `POST /compliance/invoices`, which validates **document CONSTRUCTION**: the
    UBL, the XAdES signature, the digests, the QR, the chain. It is an
    *onboarding gate* — "can this EGS unit produce valid documents?"
    **It is NOT submission.** `POST /invoices/clearance/single` and
    `POST /invoices/reporting/single` — the production path — have **never been
    called, in any environment**, and appear only in `liveZatcaClient.ts`.
    So the response shapes `errorMapping.ts` interprets, the `Clearance-Status`
    header, where `clearedXml` actually arrives, and real ZATCA error codes are
    all **unverified**. Do not read this green result as end-to-end proof; it is
    finding **#6** in the standing-check table, and M12.7's first task.
  - **🔴 `tests/zatca-compliance-live.test.ts` is now THE GATE**, replacing the
    SDK differential as the authoritative check. The SDK differential is KEPT as
    a fast offline signal but it is no longer evidence of compliance — it passed
    byte-for-byte while the QR was rejected by the live API. It now asserts the
    **deliberate divergences** from the SDK (tags 3, 7, 8, 9), so a future SDK
    release that changes to match the live API fails loudly instead of silently.
    The live test **skips loudly** when ZATCA is unreachable so an outage cannot
    red-build unrelated work — a green run without it proves much less.
  - **QR corrected** (`crypto/qr.ts`): tag 7 = base64 signature STRING, tag 8 =
    raw SPKI public key, tag 9 = the CA's signature over the CERTIFICATE. Tag 6
    (base64 string) was the one part of the old reading that held.
    `splitEcdsaDer` was **deleted**, not left unused, so the disproven `r`/`s`
    split cannot be reached for again.
  - **A second, independent QR bug found and fixed: the timestamp.** QR tag 3
    carried a trailing `Z` that disagreed with UBL's `cbc:IssueTime` (which has
    no timezone designator), warning `invoiceTimeStamp_QRCODE_INVALID`.
    **Stripping milliseconds was NOT the fix** — that was tested separately and
    still warned. The real bug was that the same fact had **two independent
    formatters**, so `services/einvoice/issuedAt.ts` is now the single source and
    `assembleSignedInvoice` takes `issuedAt: Date` rather than a preformatted
    string. That makes the drift impossible rather than fixing one instance.
  - **Onboarding flow** (`services/einvoice/onboarding/`): prerequisites → CSR →
    CCSID → six documents → PCSID → activate, plugged into M12.5's
    `createCredential`/`activateCredential`. The six documents are signed inside
    ONE scoped `withCredentialKey` callback, so the key is never in memory during
    a network call.
  - **The OTP boundary:** the tenant generates the OTP in their OWN Fatoora
    portal and pastes it in. We never see, store or proxy their ERAD
    credentials; the OTP is trimmed, used once, and never persisted (asserted by
    a test).
  - **Prerequisites checklist** surfaced BEFORE onboarding starts (the M11.6
    fields: VAT, CR, Arabic name, and the full national address including the
    `additionalNumber` that only schematron reveals). Onboarding fails closed
    with `zatca_prerequisites_missing` naming each gap, so a tenant fixes it in
    Company Settings rather than hitting an opaque ZATCA rejection mid-flow.
  - **Compliance failure blocks activation**: if any document is rejected, the
    production CSID is **not requested**, the credential is revoked, and the
    per-document ZATCA errors are returned to the UI. Asserted directly rather
    than inferred from PCSID issuance — because in sandbox a PCSID is issued even
    when documents FAIL.
  - **UI** (`/zatca`): prerequisites checklist, OTP paste, per-document
    compliance results, certificate status and expiry with a T-90 warning banner.
    RBAC: `zatca_onboarding` read = all roles, **create = admin only**.
  - **New finding, pinned in the REJECTING direction:** `VATEX-SA-EDU` /
    `VATEX-SA-HEA` require a buyer **national ID** (BR-KSA-49) and buyer **name**
    (BR-KSA-25), so they cannot appear on an anonymous simplified invoice at all.
    Found by submitting one. The assembler should eventually fail closed on this
    rather than letting ZATCA reject it.
  - **⚠️ COVERAGE GAP (closes with M12.1b):** the compliance credit/debit notes
    are built from **directly-constructed inputs**, not from the database. They
    are test artifacts that never post to the ledger, so M12.1b was NOT a
    prerequisite — the note XML (`InvoiceTypeCode` 381/383 + `cac:BillingReference`)
    has existed since M12.2. But `einvoiceInput.assembler.ts` still hardcodes
    `billingReference: null`, so **a note assembled from real ledger rows has
    never been validated by ZATCA.** Close this when M12.1b lands.
- **M12.5 (done): credential vault.** Per-company ZATCA signing keys, stored
  encrypted and reachable only through one narrow service. Full design:
  [`docs/zatca/m12-5-credential-vault-design.md`](../zatca/m12-5-credential-vault-design.md).
  - **`zatca_credentials` (migration `0019`) — owner-only, no RLS, no app-role
    grants.** The sixth table on that pattern, but for a different reason than
    the first five: not "keep identity data out of tenant scope" but **blast
    radius under app-role compromise**. RLS answers "can org A read org B's row";
    it does NOT stop a SQL-injection flaw in any of the ~18 business domains from
    reading the *current* tenant's signing key, because the app role is acting as
    that tenant. With no grants at all, no business route is on the attack path.
  - **🔴 The migration REVOKEs explicitly — do not delete that block.** Creating a
    table is not sufficient: Supabase's base `ALTER DEFAULT PRIVILEGES` silently
    grants `REFERENCES, TRIGGER, TRUNCATE` on every new table to
    `anon`/`authenticated`/`service_role` (verified locally — all five existing
    owner-only tables carry exactly those three). **`TRUNCATE` needs no DELETE
    privilege and bypasses RLS**, so without the REVOKE the app role could wipe
    every tenant's signing keys in one statement — unrecoverable, since each
    tenant would have to re-onboard. The REVOKE is guarded per role (CI
    bootstraps only `authenticated`). This is the platform-wide MEDIUM finding,
    fixed for the one table where destruction is catastrophic.
  - **Envelope encryption: ONE platform CMK + per-company DEKs.** AES-256-GCM
    under a per-company data key; the DEK is wrapped by the master key. The
    plaintext DEK is never stored. **`KeyWrapper`** (`signing/keyWrapper.ts`) is
    the seam — `LocalDevKeyWrapper` for dev/CI, `AwsKmsKeyWrapper` for
    deployment. `@aws-sdk/client-kms` is **deliberately not a dependency**: the
    specifier is a runtime variable so neither tsc nor esbuild pulls it into the
    build graph, and installing it is a deployment step.
  - **`local-dev` cannot reach production, checked twice independently:**
    `loadEnv` refuses the provider at boot, and the signing service refuses any
    row whose stored `kms_provider` is `local-dev` when `NODE_ENV=production`.
    Shipping fake cryptography is the failure that would stay invisible until
    ZATCA rejected everything.
  - **The narrow signing service** (`signing/signing.service.ts`) is the only code
    that decrypts. There is **no `getPrivateKey()`** — callers pass a callback
    (`withSigningKey`, `withTransportCredentials`) and only its return value
    escapes; plaintext lives in Buffers zeroed in a `finally`, never a PEM string.
    Seven enforcement layers: no key field on any exported type; the vault
    repository is outside `repositories/` with a **test that fails the build** on
    outside imports; `toJSON()` **throws**; nothing key-bearing reaches a logger;
    every error is re-thrown as `SigningError` with a **fixed** message (because
    `errorHandler` puts `err.message` on the wire and an OpenSSL/KMS error can
    quote key bytes); and no HTTP route returns key material.
  - **`ownerDb` is now exported from `@workspace/db`** — owner-only tables must
    state the connection they mean rather than relying on the tenant proxy
    failing.
  - **The CSID `secret` is encrypted like the private key.** ZATCA returns it in
    the same JSON body as the certificate so it reads like metadata; it is the
    password half of the transport's Basic auth.
  - **Both M12.3 prerequisites landed first** (before anything persisted a key):
    `privateKeyPem` is **removed** from `generateZatcaKeyPair`'s return type — not
    made lazy, since a getter still yields an unzeroable string — and
    `assertZatcaCurve` now runs its DER check on the **derived public key**, same
    OID assurance with no private-key copy.
  - **Lifecycle:** `pending_csr → active → superseded | revoked`, with rotation
    superseding the old credential in one transaction and a **partial unique
    index** making the DB the guarantee of one active credential per (company,
    environment). Superseded rows are retained (past invoices were signed under
    them; the archive must stay verifiable for 6–11 years); revocation
    **crypto-shreds** the key while keeping metadata and the public certificate.
  - **Tests** (`tests/zatca-credential-vault.test.ts`, 19 + 7 DB-boundary in
    `packages/db`): the valuable ones are negative — the app role cannot
    SELECT/INSERT/UPDATE/DELETE/**TRUNCATE** the table, serialisation throws,
    errors leak nothing (including when decryption itself fails), one company
    cannot sign as another, and revocation makes signing impossible. All run with
    **no KMS**. **They do NOT prove the AWS IAM/key policy is correct** — that is
    deployment verification, the same shape as the known M11.4 storage gap.
  - **NOT built here — the per-tenant onboarding FLOW** (the OTP paste UI and the
    route that drives CSR → CCSID → PCSID). The vault deliberately ships first
    and standalone: it is the storage and access boundary, and it is complete and
    tested on its own. The flow that *fills* it calls ZATCA's compliance
    endpoints, so it belongs with **M12.4**, which now has a live sandbox to
    build against. `createCredential` / `activateCredential` are the seam it
    plugs into.
- **M12.6: clearance & reporting transport** — outbox + worker (see the M12.6 bug
  above), retry, idempotency, status model, ZATCA error-code surfacing.
- **M12.8 (done): archival, residency, renewal, operator visibility — AND the
  milestone that finally CONNECTED the ZATCA pipeline to the product.**
  - **🔴 The outbox had no producer.** Closing that was agreed into M12.8 scope
    because the two halves are inseparable: fixing the chain ordering alone
    corrects a chain nothing writes to, and wiring the enqueue alone activates a
    fork in the chain ZATCA legally validates, on real customer invoices. The
    disconnection was *masking a live compliance defect*. See the
    three-occurrences table below.
  - **BUG FIXED — the fork was still live in the ZATCA chain.**
    `zatcaPreviousInvoiceHash` ordered by `einvoice_documents.invoice_id DESC`:
    the same row-id defect M12.1b fixed for the homegrown chain, in the same
    file, left on the chain that legally matters. It had **neither** mechanism —
    wrong ordering AND read outside `lockCompanySequence` (the loader resolved it
    at assembly time). Now ordered `icv DESC NULLS LAST, id DESC` and read inside
    the lock. `loadEInvoiceInput` takes `previousInvoiceHash` as a **required
    parameter** so the read cannot drift back outside the critical section.
    Proven by `tests/einvoice-enqueue.test.ts`, whose headline case is
    **strictly sequential** (approve 3 → 1 → 2, no concurrency) because that is
    the ordinary approver behaviour a race-shaped fix would have missed.
  - **Enqueue-on-issuance** (`services/einvoice/outbox/enqueue.ts`), called from
    `issueInvoice` inside the sequence lock and the tenant transaction, so the
    queued row commits atomically with the ledger effect. It **builds and signs
    there**, because the worker's contract is that it never mints a hash or
    signature — that is what makes a retry byte-identical. Two failure policies,
    deliberately different: **not onboarded ⇒ skip silently** (every existing
    tenant must still be able to invoice), **onboarded but unbuildable ⇒ throw**
    and roll the approval back (an invoice ZATCA never learns about would consume
    an ICV and leave a permanent gap in a legally-required sequence — refusing to
    issue is recoverable, a gap is not). An onboarded company's invoice also gets
    the **Phase-2 (9-tag) QR** written over the Phase-1 one.
  - **`ZATCA_WORKER_ENABLED` finally declared** in `@workspace/config` (it was
    referenced in two comments and existed nowhere), plus the **live
    clearance/reporting client** (`zatca/liveZatcaClient.ts`) — without it an
    instantiated worker would have thrown on every send.
    🔴 The flag uses a strict `booleanFlag`, **not `z.coerce.boolean()`**:
    `Boolean("false")` is `true`, so coercion would turn an explicit
    `=false` into ON for a flag that starts transmissions to a government API.
  - **First background-job infrastructure in the repo** (`jobs/scheduler.ts`).
    One loop, three jobs (outbox, archive sweep, renewal check) sharing it rather
    than each inventing a timer. Each exposes `runOnce()` separately from the
    schedule, so tests drive them deterministically and an operator can run any
    of them on demand **with the worker off**. Self-rescheduling `setTimeout`
    (not `setInterval`) so a slow ZATCA response cannot stack up submissions.
  - **Archive** — `ArchiveStore` is a swappable interface (`local-fs` for
    dev/CI/on-prem, `supabase-storage` for cloud), chosen at deployment like
    M12.5's `KeyWrapper`. 🔴 **It has no `delete` method, by design**: ZATCA §5.5
    forbids deletion or alteration of generated invoices, so the interface cannot
    express it. `einvoice_archive` (migration `0022`) is tenant-scoped with RLS
    and **GRANT SELECT, INSERT only** — with UPDATE/DELETE/**TRUNCATE**/
    REFERENCES/TRIGGER revoked, because TRUNCATE bypasses RLS and would erase
    every tenant's index in one statement. Pinned by a DB boundary test.
    Filenames follow §5.5 exactly: **VAT + GENERATION timestamp + invoice
    reference** — 🔴 generation (`invoices.issued_at`), never clearance.
    The sweep is a **separate pass from submission** so a storage outage cannot
    turn a document ZATCA already accepted into a failed submission.
  - **Renewal reminders** at T-90/30/7, driven off real `not_after` data,
    idempotent via a **unique index** on (credential, threshold) rather than a
    scheduling assumption. An already-expired certificate still reports —
    silence after expiry is the worst case. 🔴 A bug caught by its own test:
    searching the descending `[90,30,7]` returns the WIDEST crossed window, so a
    certificate with 5 days left would have been announced as a T-90 notice;
    the search is now explicitly ascending.
  - **Operator visibility** — `GET /operator/zatca/{health,overdue,needs-review,
    certificates,onboarding}` + `POST /operator/zatca/jobs/:name/run`, rendered
    in `OperatorZatcaPanel.tsx`. Metadata only: queue depth, ages, expiry dates,
    onboarding state. Never a tenant's financial data, never XML, never key
    material — the M11.3 rule is unchanged. Onboarding status is derived from
    `zatca_credentials.status`; **`companies.zatca_onboarding_status` was DROPPED**
    (migration `0022`) because nothing ever wrote it, so every row read
    `not_started` forever.
  - **Residency: the recorded requirement was wrong.** See the correction below —
    ZATCA §5.5 explicitly permits cloud storage; the binding constraint is
    ACCESSIBILITY (a direct link for the Authority), which is why
    `ArchiveStore.directLink` is part of the interface. The backend stays
    swappable regardless.
  - **Flagged, not taken on: email delivery.** `lib/mailer.ts` is still
    `noopMailer` (`delivered: false`), so reminders reach a human only in-app and
    through the operator panel. The row records whether email actually went, and
    an absent reminder is worse than a late one here because renewal needs the
    tenant's own OTP. Integrating SES/Resend/Postmark (~$0–20/month) is the
    dependency to close before go-live.
- **M12.7 and M12.9: BLOCKED** on the Saudi entity — simulation end-to-end, and
  the production pilot. Nothing else in M12 is blocked.

### 🔴 RESIDENCY CORRECTION — "must be stored inside Saudi Arabia" was NEVER in the specification

**A recorded requirement that shaped hosting thinking for three milestones turns
out not to be a ZATCA requirement at all.** It was believed until M12.8, when the
primary source was actually read.

**What the primary source says.** §5.5 (*Data Storage and Archival*) of the
E-Invoicing Detailed Guideline — the pinned PDF in `docs/zatca/specs/` — states
that taxpayers *"may store their electronic invoices in a server **on-premises in
the KSA or in the cloud** as per their solution requirements."* The same section
adds that *"Taxpayer's E-Invoice Solutions **may reside on the cloud** in
accordance with VAT Implementing Regulation."* Cloud storage is **explicitly
permitted**, not tolerated.

**The binding constraint is ACCESSIBILITY, not location:** *"if the data is
hosted on the cloud, it must be **accessible through a direct link that can be
made available to the Authority**. This requirement is mandatory for audit
purposes."* That is a capability we must build — see the M12.8 design — and it is
a materially different obligation from a geography.

**Where the wrong claim came from, and why it survived.** A secondary source
(vendor/blog material of the kind that summarises this area) asserted in-country
storage; it was recorded here as fact and never checked against the PDF. Note the
irony: this repository's own operating principle is that **ZATCA's PDFs are an
unreliable narrator** — but that principle was formulated about the PDFs being
*wrong where a binary disagrees*. It was never a licence to skip reading them. A
secondary source is strictly worse than an unreliable primary one, and here the
primary source was not merely more reliable, it was **the opposite of what we
believed**. Add the tier explicitly: **LIVE API > SDK > PDF > anything else.**

**What is NOT settled, and must not be treated as settled.** §5.5 defers outward:
*"additional non-tax-related regulations may apply to the taxpayer entity, such
as **National Cybersecurity Authority** published laws and any other applicable
regulations or controls."* So residency pressure may still exist — from NCA / CSP
cloud controls or sector regulation (e.g. financial-sector rules), **not from
ZATCA**. That is a **LEGAL question we have not verified**, and it must not be
acted on as though we had. We have neither established that KSA hosting is
required nor that it is unnecessary.

**Therefore the engineering position is unchanged, for a better reason.** The
storage backend stays **swappable behind an interface**, exactly as planned — not
because a KSA host is required, but because **an unverified claim is not a basis
for committing hosting, and neither is the absence of one.** The interface is
what lets the legal answer arrive late without costing a rewrite. Do not "simplify"
it away on the strength of this correction.

**Verified in the same reading, and safe to build to:**
- **Naming convention** — *"VAT Registration (tax registration number) +
  Timestamp (date and time **at the point of invoice generation**) + Invoice
  Reference Number."* 🔴 **GENERATION, not clearance.** These differ (clearance
  is later, and for simplified invoices reporting can be up to 24h later), and
  the inversion is easy to make and invisible once made.
- **Immutability** — *"Once invoices are generated, they should not be deleted or
  altered by any user"*, and the solution must *"protect the generated Electronic
  Invoices ... from any alteration or undetected deletion."* This is a **property
  of the archive, not a retention duration** — enforce it the way `audit_logs`
  and `security_audit_logs` already do (DB-level REVOKE + a boundary test), not
  by convention.
- **Retention** — 6 years, 11 for certain cases. The e-invoicing guideline itself
  only says *"archived as per VAT regulations"*; the durations come from the VAT
  Implementing Regulation, not from this document.

### 🔴 The chain forked because `previousInvoiceHash` ordered by ROW ID

`invoices.id` is assigned at CREATE; the chain position is assigned at APPROVAL.
Those orders differ whenever documents are approved out of the order they were
created. Ordering by `id` selected "the highest-numbered row that happens to be
hashed", so several approvals read the SAME head. Reproduced with 8 parallel
approvals: **three documents shared one predecessor.** A forked chain is not
repairable after the fact and is exactly what ZATCA's chain exists to detect.

**🔴 THIS IS NOT PURELY A CONCURRENCY BUG. Do not file it as one.** An approver
working a queue out of creation order forks the chain **sequentially, one request
at a time, with no parallelism anywhere**: approve invoice #7 before invoice #5,
and #5 chains to #7's predecessor instead of to #7. That is ordinary,
correct-by-any-other-measure approver behaviour — an approver is free to work
their queue in any order, and nothing about the product suggests otherwise.
Concurrency is how it was *reproduced*, not the condition it requires. A fix
reasoned about purely as a race (isolation levels, a serialisable transaction)
would leave the common case broken.

**🔴 `unique(company_id, icv)` COULD NEVER HAVE CAUGHT THIS.** Anyone reading
"we have a unique constraint on ICV" will assume the sequence is protected. It
is not, and the shape of the failure is the reason: **a fork produces no
duplicate value and therefore no error.** Two documents pointing at the same
predecessor still get distinct, dense, gapless ICVs — the constraint sees nothing
wrong because nothing it checks *is* wrong. Precisely that was observed: **ICVs
were dense and unique for the entire time the chain was forking.** A constraint
on the counter says nothing about the *link*, and the link is where the chain
lives. Uniqueness and chain integrity are different properties; only one of them
was enforced.

Two separate mechanisms are needed, and only one of them existed:

- **Allocation** is serialised by a per-company **transaction-scoped advisory
  lock** (`lockCompanySequence`), covering the ICV read AND the chain-head read
  in one critical section. `unique(company_id, icv)` remains the **backstop**,
  not the mechanism — it can turn a duplicate ICV into an error, but per the
  above it cannot see a fork at all, let alone unfork one. The lock was working
  the whole time.
- **Ordering** must follow the SEQUENCE, not the row id:
  `ORDER BY icv DESC NULLS LAST, id DESC`. This is the half that fixes the
  sequential out-of-order case, which no amount of locking would have.
  `NULLS LAST` keeps pre-M12.1b rows (hashed, no ICV) behind ICV-bearing ones so
  a company with legacy invoices continues its chain rather than starting a
  second genesis root.

Proven in `tests/invoice-icv-concurrency.test.ts` under real parallel
transactions — the way the M12.6 outbox claiming was proven, rather than by
reasoning about isolation levels.

### 🔴 LANDMINE — our hash chain is NOT ZATCA's hash chain

`services/accounting/zatca.ts` is titled *"Phase 2 hash chaining"*. **It is not.**

```
Ours    computeInvoiceHash()   sha256_HEX( "num|date|vat|total|vatAmount|prevHash" )
ZATCA                          BASE64( sha256( C14N-canonicalised UBL XML ) )
```

These share nothing. Our genesis is the literal string `"GENESIS"`; ZATCA's is a
defined constant. It is a homegrown tamper-evidence mechanism, and it must be
**replaced in M12.3, not extended**. The `invoice_hash` / `previous_hash`
**columns** are reusable as storage, but **every value currently in them is
meaningless to ZATCA** — the real chain starts fresh at first onboarding.
Likewise the QR (`generateZatcaQr`) emits Phase 1 tags **1–5 only**; Phase 2
needs **1–9**.

### Prerequisites tracked for M12.7+ (surface early, do not rediscover)

- **🔴🔴 Saudi company entity + active ZATCA VAT registration + ERAD credentials.
  NOW BLOCKS TWO WORKSTREAMS, NOT ONE.** The longest-lead item in the programme,
  and its urgency went up in A1.

  | Workstream | What the entity gates |
  | --- | --- |
  | **ZATCA M12.7 / M12.9** | Simulation and production both require ERAD credentials, i.e. a real active taxpayer account. |
  | **A2 bank connectivity** | Contracting with a **SAMA-licensed** open-banking provider (Lean, Malaa, Tamawal) almost certainly requires a **Saudi commercial registration**. |

  🔴 **The distinction that matters for sequencing: conversations remain useful
  without the entity; SIGNATURES do not.** Pricing, bank coverage, our
  obligations under a provider's licence, and sandbox access are all answerable
  today — which is why the A2 outreach
  ([`docs/product/a2-provider-outreach.md`](../product/a2-provider-outreach.md))
  is framed as exploratory. What cannot happen without the entity is a signed
  agreement, and therefore a launch.

  So the entity is no longer "the thing that unblocks the last two ZATCA
  milestones". It is **on the critical path of two independent workstreams**, and
  nothing technical shortens it. VAT registration is mandatory above SAR 375,000
  revenue and **voluntary above SAR 187,500**. VAT registration is mandatory above SAR 375,000 revenue and
  **voluntary above SAR 187,500**. Nothing technical unblocks this.
- **Data residency — 🔴 THE EARLIER CLAIM HERE WAS WRONG. See the correction
  below before making any hosting decision.** This entry previously read *"ZATCA
  requires e-invoices archived on servers inside Saudi Arabia."* That came from a
  **secondary source and is NOT supported by the primary specification.** What
  remains true and verified: retention **6 years (11 for certain services)** and
  the file naming convention (see the corrected section below). What is open: the
  hosting location. There is still *no hosted Supabase project* — the database is
  local Supabase CLI (`127.0.0.1:54322`) and `SUPABASE_URL` is unset — so this
  stays an **open deployment decision, not a migration**, and the archive backend
  is built swappable regardless.
- **Possible ZATCA IP whitelisting.** Secondary sources indicate server IPs may
  need whitelisting. **Unverified against official docs** — confirm in M12.4. If
  true it means static egress IPs (NAT gateway) and constrains serverless hosting.
- **KMS** for envelope-encrypting tenant private keys (M12.5). **ONE platform CMK
  (~$1/month) + a per-company data key — NOT a CMK per tenant.** An earlier note
  here read "~$1/key/month", which if applied per tenant implies **$1,000/month at
  1,000 tenants for identical isolation**. Per-company DEKs give the same blast
  radius (one DEK compromised ⇒ one company) at flat cost; requests are
  $0.03/10,000, i.e. cents. Self-hosted Vault avoids per-key cost but adds a
  service to operate.
  **The provider is chosen at DEPLOYMENT, behind the `KeyWrapper` interface** —
  the same hedge as M12.8's storage backend, because the hosting-region question
  is still open (see the residency correction — the constraint is not what we
  thought, but it is not resolved either) and picking a KMS partially pre-decides
  the hosting provider.
- **ZATCA itself charges nothing** — CSIDs, sandbox, simulation and API access are
  all free. The cost of the build-direct path is engineering time only.

### 🔴 DELIBERATE BEHAVIOURAL DECISION (M12.8): issuance FAILS CLOSED for onboarded companies

**Decided and approved, not incidental — and flagged for revisit before a real
taxpayer is onboarded.**

For a company with an active ZATCA credential, if the document cannot be built
or signed, `enqueueEInvoice` **throws and the whole approval rolls back**. No
invoice is issued. Causes include a KMS outage, a revoked credential, or invoice
data too incomplete to assemble (a NULL tax category, a missing buyer address on
a B2B sale).

**Why blocking is the correct choice for a compliance platform.** The alternative
is issuing invoices that cannot reach ZATCA — and the tenant then discovers the
problem **from the tax authority rather than from us**, after the fact, with
penalties attached and no way to repair the record. Worse, a silently-issued
invoice would consume an ICV and a chain position that can never be filled,
leaving a permanent gap in a legally-required sequence. Refusing to issue is
recoverable in minutes; a gap is not recoverable at all.

It is also consistent with the posture chosen everywhere else that touches
statutory identity: `requireIssuanceSeller` (M11.6) fails closed rather than
stamping a placeholder VAT number, and the assembler fails closed on an ambiguous
tax category rather than guessing a tax fact.

**What it costs, stated plainly:** a KMS or vault outage stops invoicing for
onboarded tenants. That is a real availability trade, accepted knowingly.

**Not affected:** a company with **no** active credential is skipped silently and
issues exactly as before. Every existing tenant and every pre-M12.8 test depends
on that, and it is what keeps the platform usable for non-Phase-2 businesses.

**🔴 REVISIT BEFORE ONBOARDING A REAL TAXPAYER.** The decision is right in
principle; what has not been tested is how it *feels* under a real outage. Before
go-live, confirm the failure surfaces to the user as an actionable message
(which field, which company, what to fix) rather than an opaque 500 — a
fail-closed guard that cannot be diagnosed is a fail-closed guard people work
around.

### 🔴 PRE-PRODUCTION REQUIREMENT: real alerting on the e-invoice outbox

**🔴 CORRECTED IN M12.8.** This section previously read *"M12.6 surfaces overdue
documents via `listOverdue()` and the operator UI"*. **That was false in both
halves.** `listOverdue()` had **zero production callers** — only a test — and
there was **no operator UI for it at all**. A capability was recorded as
delivered on the strength of the function existing. See the standing check
below.

**As of M12.8 the claim is now true:** `listOverdue()` is surfaced by
`operatorZatca.service.health()` at `GET /operator/zatca/health` and rendered in
`OperatorZatcaPanel.tsx`, which reports the OLDEST waiting document rather than
just a count (age is what matters against a 24-hour deadline).

**But there is still NO ACTUAL ALERTING**, and that remains the pre-production
requirement. Visibility is not alerting: the operator panel only helps a human
who is already looking at it.

Why it matters more than it looks: **the dangerous failure is not a loud
rejection, it is quiet neglect.** A rejected document is visible and someone acts
on it. A simplified invoice that silently misses ZATCA's **24-hour reporting
deadline** looks like nothing is wrong — and it is legal exposure for the tenant,
with fines from SAR 5,000. Nothing in the current design pages a human when the
queue stops draining.

Wire `listOverdue()` to real alerting before go-live — queue item **B2**, which
covers this and PCSID expiry together, because they are the same failure shape.

### 🔴 PRE-PRODUCTION REQUIREMENT: PCSID expiry — 5 years, NO grace period

**The same failure shape as the outbox gap above, and it must be treated with the
same seriousness.** Confirmed empirically on 2026-08-09: ZATCA's sandbox CA issued
a certificate valid **2026-08-09 → 2031-08-08**, exactly 5 years, with no grace
period.

At expiry, signing **stops dead**: the tenant cannot clear or report invoices, and
therefore cannot legally invoice at all. Nothing looks wrong beforehand — this is
**quiet neglect**, not a loud rejection, which is precisely why it needs an alarm
rather than a dashboard.

It is worse than the outbox case in one respect: **renewal requires the TENANT's
own action** (a fresh CSR plus an OTP they obtain from Fatoora), so a reminder
that fires late cannot be fixed by us alone. Lead time is the whole point.

**✅ BUILT IN M12.8, with one gap that is still a go-live blocker.**
Reminders at **T-90 / T-30 / T-7** run off `zatca_credentials.not_after`
(`services/einvoice/renewal/renewal.service.ts`), are idempotent through a unique
index on (credential, threshold), still fire for an already-expired certificate,
and are surfaced to the operator alongside the windows that passed *unannounced*.

**🔴 THE REMAINING GAP: the reminder cannot actually reach the tenant.**
`lib/mailer.ts` is still `noopMailer` — it logs and returns `delivered: false`.
So a reminder exists as a row and appears in-app and in the operator panel, but
**no message is sent to anyone**. For this alarm specifically that is close to
useless on its own: the whole point is lead time for an action *only the tenant
can take*, and a tenant who does not open the app does not learn anything.

Integrating an email provider (SES / Resend / Postmark, ~$0–20/month) is
therefore a **hard prerequisite for onboarding a real taxpayer**, not a polish
item. `Mailer` is the seam — implement `send` and swap the export; nothing else
changes.

### 🔴 DEPLOYMENT REQUIREMENTS: protecting the KMS master key (M12.5)

**If the CMK is deleted, every wrapped data key becomes undecryptable and every
tenant's private key is permanently lost.** Already-issued invoices and their
archived signed XML survive (they are already signed and stored) — what is lost is
the ability to sign NEW ones, and recovery means re-onboarding every tenant with a
fresh key, CSR and OTP. That needs action from each tenant, so it is a business
event, not merely an outage.

These are **deployment configuration requirements**, not code:

- **30-day deletion window** — set KMS's mandatory waiting period to the maximum.
- **`kms:ScheduleKeyDeletion` restricted to a break-glass role** via key policy;
  no routine role may hold it.
- **CloudTrail alarm on any deletion attempt** — it must page a human.
- **Multi-region CMK replica.**

Note what is safe and needs no action: **automatic annual key rotation.** KMS
retains prior key versions and the ciphertext blob names its own version, so
wrapped DEKs stay decryptable. That holds only while the CMK is never deleted.
Migrating to a *different* CMK is a re-wrap job (unwrap with old, re-wrap with
new, update `wrapped_data_key` + `kms_key_id`); the invoice keys are untouched.

### M12.3 review — carried forward

**Key-handling items to address WHEN THE M12.5 VAULT IS BUILT** (not exploitable
now — nothing persists or transmits keys — but M12.5 is when the blast radius
changes):

- `crypto/keys.ts` `generateZatcaKeyPair()` eagerly exports `privateKeyPem` on
  every call, materialising the key as an immutable, unzeroable JS string even
  when only the `KeyObject` is needed. Make it a lazy accessor at the vault
  boundary.
- `crypto/keys.ts` `assertZatcaCurve()` exports the private key to DER purely to
  check the curve OID, creating a second in-memory copy per validation. The
  `namedCurve` check on the same line already covers the normal case; decide
  whether the DER round-trip earns its keep or should be restricted to public
  keys.

Verified clean in the same review: no logging anywhere in `services/einvoice/`,
no serialisation of credentials, nothing key-related on any returned type, and
`errorHandler` emits only `err.message` / a generic 500 — never a stack or
object dump.

**Surface the M12.3 differentials DO NOT reach** — they exercise one invoice, one
key, one certificate, one signing time. M12.1b and M12.4 should extend coverage
to:

- **credit and debit notes** (`documentType` other than `invoice`) — untested
  end-to-end through signing
- **zero-value lines and zero-VAT invoices**
- **certificates with unusual issuer DNs** — `issuerName` comes from ZATCA's CA,
  and only one CA's format has ever been seen
- **invoices with no PIH** — now guarded with a throw rather than silent QR
  misplacement, but never exercised against ZATCA
- **multi-byte item descriptions** in the XML body (lower risk — M12.2's
  generator escapes via `xmlbuilder2`)
- **the tag 8/9 `r`/`s` split**, whose *intent* is still unverified (divergence
  #13) — re-confirm against the sandbox


---

## Appendix: the CLAUDE.md "Current State" block as it stood at the M12 close-out

> Preserved verbatim when CLAUDE.md was restructured (2026-08-13). The hubs
> warning below was SUPERSEDED on 2026-08-12 by
> [`../product/hub-structure-decision.md`](../product/hub-structure-decision.md).

## 2. Current State

> **This block is the answer to "where are things?". Everything below it in this
> section is the historical record of how we got here — accurate, but long.
> Keep this block current; if it disagrees with reality, fix it first.**

**Last updated: 2026-08-11 (M12 close-out).**

### Where we are

| Phase | Status |
| --- | --- |
| **Phase 0** — Platform Foundation (M1–M10) | ✅ **Complete.** Multi-tenancy + RLS, auth/session hardening, RBAC, layering, CI/CD, audit logging, draft/approval workflow + 4-role model. |
| **Phase 1** — Onboarding & Multi-Company (M11.1–M11.7) | ✅ **Complete.** Self-service signup behind a verification gate, platform operators, document upload, company/ZATCA identity, invitations. Includes the M11.5.1 CRITICAL security hotfix. |
| **Phase 2** — ZATCA Phase 2 / Fatoora (M12) | 🟡 **Closed except M12.7 + M12.9**, which are blocked on a real Saudi taxpayer registration. Everything buildable without ZATCA credentials is done. |
| **Next** | The rest of the platform — no ZATCA work is unblocked. |

### 🔴 What is verified LIVE vs only LOCALLY

Full detail: [`docs/zatca/m12-status.md`](../zatca/m12-status.md). The
one-paragraph version:

**Confirmed against the live ZATCA sandbox:** the CSR and `secp256k1` curve, the
XAdES properties and both digest encodings, all nine QR tags, six compliance
documents (standard + simplified × invoice / credit note / debit note, plus
zero-rated), and the ledger→ZATCA path built from real Postgres rows. Divergences
#1–#13 are checked against reality, not against a decompiled binary.

**🔴 NOT verified — we have never submitted an invoice to ZATCA.** The compliance
pass covers document **CONSTRUCTION** (`POST /compliance/invoices`, an onboarding
gate). The production path — `POST /invoices/{clearance,reporting}/single` — has
**never been called in any environment**. Also local-only: the outbox transport
(proven against a mock), the archive (`local-fs` only; the Supabase backend has
never touched a real bucket), renewal reminders (synthetic dates), and M12.8's
enqueue path (a self-signed certificate, not a real PCSID).

### What is blocked, and on what

**M12.7 (simulation) and M12.9 (production pilot)** need a **registered Saudi
company entity with an active ZATCA VAT registration and ERAD credentials.** That
does not exist, is not a technical step, and nothing unblocks it except the owner
registering the entity. No rework is expected when it arrives — sandbox exercises
the same API surface. **Do not** mock simulation to "finish" M12, and **do not**
onboard a real tenant to production before both have actually run.

### Pre-production queue — three groups

Nothing here blocks ordinary platform work; all of it blocks onboarding a real
taxpayer. Full detail in the consolidated queue later in this file.

- **B — BLOCKING (3 items).** **B3** is new and is *not* a ZATCA item: staged
  captures cannot be deleted on a cloud backend, which is the **PDPL problem in
  concrete form** — B3, C7 and C8 are one question in three parts and must be
  worked together. The other two are both halves of *a reminder that reaches
  nobody*: **B1** email delivery (`mailer` is still a no-op, so renewal reminders
  are sent to no one — and their whole value is lead time for an action only the
  tenant can take); **B2** real alerting (visibility is not alerting — the
  operator panel only helps someone already looking, and both the outbox age
  alarm and PCSID expiry fail by quiet neglect).
- **A — ✅ CLOSED in M13/M14.** The revokes turned out to cover **35 tables**,
  not "business tables plus five", and narrowing `ALTER DEFAULT PRIVILEGES` is
  what stops the next `CREATE TABLE` re-granting them. M-1 closed with a **build
  guard rather than RLS** (policies there would be exercised by no traffic — see
  M-1). Period locks are company-scoped in both the posting path and the routes;
  the route bug was the serious one — one company's unlock deleted every other
  company's lock, silently reopening closed books.
- **C — VERIFICATION GAPS (6 items).** Trusted proxy + Redis rate limiters, the
  CI storage gap, KMS deployment verification, AV scanning, fail-closed
  diagnosability, and the hosting/residency decision.

### Open findings from the retroactive sweep (not yet fixed)

A backwards application of the standing check found **seven** more
schema-or-interface-without-a-consumer cases (S1–S7, detailed later in this
file). None is exploitable; all are documentation claiming a capability that does
not exist. The one that matters: **S1 — the `EInvoiceProvider` seam is only
~1/3 wired** (`buildDocument` only; `onboard`/`renewCertificate`/`submit` still
throw and the real paths bypass the seam), and that seam is one of the two
mandatory hedges behind the build-direct decision. The rest are `Redis` (listed
in the stack, used nowhere), a stale layout section, an empty `packages/auth`,
and `feature_flags`/`branches`/`departments` (tables with no consumer).

### 🔴 THE FOUR HUBS ARE NOT SPECIFIED — do not build against a reading of them

The project is described as an "AI-powered Accounting & Finance Operating
Platform", and the roadmap is spoken of in terms of a **Finance Hub, Automation
Hub, AI Hub, Analytics** and **integrations**. **None of those is defined
anywhere in this repository.** There is no spec, no scope, no acceptance
criteria — `docs/architecture-blueprint.md` covers architecture and tenancy only.

Any list of what those hubs "contain" that a session produces from the current
codebase — including the orientation given at the M12 close-out (treasury,
collections, recurring invoices, bank feeds, OCR, anomaly detection,
natural-language reporting, …) — is **a reading of the gap between what exists
and the stated ambition. It is not a specification and must not be treated as
one.** It was inferred, not recovered.

**Defining them is its own piece of work**, to be done deliberately with the
owner before anything is built against them. A future session that starts
implementing "the Automation Hub" from an inferred list will be building
someone's guess.

The one constraint that IS real and recorded: **AI proposes, it never posts**
(§5.6). That governs the AI Hub whatever it turns out to contain.

### Context that changes the risk calculus: THERE ARE NO CUSTOMERS YET

Confirmed by the owner, 2026-08-12. Nothing is in production and no tenant
depends on this platform.

**What that makes cheap right now, and expensive later:** schema changes,
breaking API changes, renaming things, changing defaults, reversing a decision.
There is no migration burden, no support load, and no one to notify.

**Concretely:** M13's release note about historical income statements changing is
correct and worth keeping, but it currently has **no audience** — it is written
for the first customer, not for an existing one. Do not let it imply caution that
is not yet required.

**What it does NOT excuse:** correctness in anything that will be hard to
retrofit — tenant isolation, the ZATCA chain, audit trails, append-only
guarantees, the fail-closed posture. Those are cheap now precisely because
nobody depends on them, which is the argument for getting them right *now*
rather than for deferring them.

**Revisit when the first tenant onboards.** At that point this note becomes
false and several decisions it makes cheap become expensive.

### Three standing rules earned the hard way

1. **[Six instances] Correct is not connected.** Before recording a milestone
   done, verify every capability has a production **caller**, every field a
   production **writer**, every client a real **implementation** (not an
   interface plus a mock), and every live external result is recorded with **the
   endpoint that produced it and what that endpoint attests**.
2. **Validate from real ledger rows.** Fixtures test the code you wrote; only
   real rows test the code you forgot to write.
3. **Re-run the LIVE VERIFICATION PASS at the end of every milestone touching
   the ingestion/tax path (owner-mandated for all of M16; keep it beyond).**
   Same fixture, live path (real HTTP → engine → Postgres), OBSERVED values —
   not test results. The M15 pass proved why: the VAT arithmetic was fixed and
   test-verified, and the live path still recorded SAR 260.87 of phantom input
   VAT on an ATM withdrawal, because a different rule (bare bank-name match)
   produced the same wrong outcome through a path no test asserted. A fix
   verified by tests can still be wrong in the live path; only observing the
   live path shows the composed behaviour.

---
