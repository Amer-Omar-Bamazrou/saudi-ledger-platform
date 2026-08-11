# ZATCA Phase 2 (M12) — status summary

**As of 2026-08-11.** M12 is complete except **M12.7** and **M12.9**, both blocked
on a real Saudi taxpayer registration. This is the keepable summary; the full
narrative lives in `CLAUDE.md`.

---

## 1. What is done

| Sub-milestone | Delivers |
| --- | --- |
| **M12.0** | Specs pinned + SHA-256 manifest; ZATCA SDK obtained (public, no account); sandbox confirmed email-only |
| **M12.1a** | Phase-2 data model (`einvoice_documents`, invoice/customer/company fields). Fixed two multi-company bugs: org-scoped hash chain, and seller identity from the wrong company |
| **M12.1b** | Credit & debit notes as first-class documents in the same chain and ICV sequence. **A credit note reverses; a debit note does not.** Amounts stored positive, direction in `document_type` |
| **M12.2** | UBL 2.1 XML generation + the `EInvoiceProvider` seam. Validated against ZATCA's own SDK validator (XSD + EN 16931 + 55 `BR-KSA-*`) |
| **M12.3** | Cryptography: `secp256k1` keys, CSR, XAdES-BES signing, QR tags 1–9, the real ZATCA invoice hash |
| **M12.4** | Sandbox onboarding CSR → CCSID → six compliance documents → PCSID, against the live API |
| **M12.5** | Credential vault — per-company keys, envelope-encrypted, owner-only table, scoped-callback access, no `getPrivateKey()` |
| **M12.6** | Outbox + worker: claiming, backoff, idempotency, ambiguous-failure handling, error mapping |
| **M12.8** | Enqueue-on-issuance, archival, PCSID renewal reminders, operator visibility, first background-job scheduler — **and the milestone that connected the pipeline to the product** |

**Scale:** 449 API tests + 36 DB tests, typecheck and build clean.

---

## 2. 🔴 Verified against the LIVE ZATCA API vs verified only LOCALLY

This is the distinction that matters most, and it is easy to overstate. **Two**
test files ever talk to ZATCA: `zatca-compliance-live.test.ts` and
`credit-notes-zatca-live.test.ts`. Everything else is local.

### ✅ Confirmed against the live sandbox

| What | Evidence |
| --- | --- |
| CSR structure, `secp256k1` curve, the undocumented template extension | A CCSID was issued that binds our key (divergences #1–#5) |
| XAdES properties, both digest encodings, `SignatureValue` not over `SignedInfo`, `CertDigest` over the base64 string | Six compliance documents returned `PASS`/`CLEARED` with zero errors and zero warnings (divergences #6–#12) |
| QR tags 1–9, including tag 3's missing `Z` and tags 8/9 as raw bytes | Corrected **from live responses** after being wrong from both the PDF and the SDK (divergence #13) |
| Standard + simplified × invoice / credit note / debit note, plus a zero-rated invoice | The six M12.4 compliance documents |
| **The ledger → ZATCA path** — documents built from real Postgres rows | `credit-notes-zatca-live.test.ts` (M12.1b) |
| PCSID validity is exactly 5 years, no grace period | Observed on the issued certificate, 2026-08-09 |

### ⚠️ Verified LOCALLY ONLY — never seen by ZATCA

| What | Why it matters |
| --- | --- |
| **🔴 The clearance and reporting SUBMISSION endpoints have NEVER been called.** `/invoices/clearance/single` and `/invoices/reporting/single` appear only in `liveZatcaClient.ts`. M12.4 used `/compliance/invoices`, which is a different endpoint. | The client is written from the base URL and auth M12.4 established, but **no ZATCA response has ever come back from it.** This is the single largest untested surface, and it is the first thing M12.7 must exercise. |
| The outbox transport (claiming, backoff, retries, ambiguity) | Proven against a **mock** at the HTTP boundary — excellent tests, but they prove behaviour, not that a transport works |
| The archive | `local-fs` only. The `supabase-storage` backend has never run against a real bucket |
| Renewal reminders | Synthetic `not_after` values, not a real expiring certificate |
| M12.8's enqueue path | Signs with a **self-signed** test certificate, not a ZATCA-issued PCSID |
| The SDK differential | Offline, and **explicitly not evidence of compliance** — it passed byte-for-byte while the QR was being rejected by the live API |

**The rule this earns:** a green SDK differential and a green mock-based suite
are necessary and not sufficient. Only a live `PASS` is evidence.

---

## 3. What the remaining two milestones need

### The blocker (shared)

**A registered Saudi company entity with an active ZATCA VAT registration and
ERAD credentials.** This does not exist and is not a technical step. VAT
registration is mandatory above SAR 375,000 revenue and voluntary above
SAR 187,500. The Simulation environment requires ERAD credentials, i.e. a real
active taxpayer account; production requires the same. Nothing unblocks this
except the owner registering the entity.

### M12.7 — simulation end-to-end

- Onboard a real EGS unit against `fatoora.zatca.gov.sa` with a real OTP
  (the sandbox accepts **any** OTP, so that path is genuinely unproven)
- **Exercise clearance and reporting for real** — the gap named above
- Confirm the PCSID binds our key in an environment where it is not a shared
  canned certificate
- Verify the 24-hour reporting window behaviour end-to-end
- Confirm whether ZATCA IP whitelisting is real (still unverified; constrains
  serverless hosting if true)

### M12.9 — production pilot

- Everything in M12.7 against production, with one real tenant
- Requires the whole **pre-production queue** below to be closed first

**No rework is expected:** sandbox exercises the identical API surface, and the
provider seam (`EInvoiceProvider`) plus the environment enum already carry the
distinction.

---

## 4. Pre-production queue

### 🔴 B — Blocking for ZATCA: a reminder that reaches nobody

| | Item |
| --- | --- |
| **B1** | **Email delivery.** `lib/mailer.ts` is still `noopMailer` — the renewal reminder exists as a row and in the UI and **is sent to no one**. Its entire value is lead time for an action only the tenant can take (a fresh CSR + an OTP from their own Fatoora portal). Implement `Mailer.send` and swap the export. **AWS SES** ~$0.10/1,000 · **Resend** free to 3,000/mo then ~$20/mo · **Postmark** ~$15/mo. |
| **B2** | **Visibility is not alerting.** The operator panel surfaces the outbox age alarm and PCSID expiry, but **nothing pages a human**. Both failures are quiet neglect, not loud rejection — nobody watches a panel that is usually green. Wire `listOverdue()` and `renewalService` to real alerting. |

### A — One migration closes these (grants/config)

| | Item |
| --- | --- |
| A1 | `REVOKE TRUNCATE/REFERENCES/TRIGGER` on every business table from the app role (**TRUNCATE bypasses RLS**) |
| A2 | Same REVOKE on the five remaining owner-only tables (`einvoice_archive`, `zatca_credentials` already done) |
| A3 | M-1 — RLS on `organizations`/`users`/`organization_memberships`, or a CI guard |
| A4 | `checkPeriodOpen` ignores `company_id` — company A's closed period blocks company B |

### C — Verification and coverage gaps

| | Item |
| --- | --- |
| C1 | HIGH-2 — one trusted proxy overwriting `X-Forwarded-For`; Redis-backed rate limiters before scaling out |
| C2 | CI storage gap — the M11.4 document tests skip in CI |
| C3 | KMS deployment verification — IAM/key policy, 30-day deletion window, break-glass on `ScheduleKeyDeletion`, CloudTrail alarm, multi-region replica |
| C4 | AV scanning on uploaded verification documents |
| C5 | Fail-closed diagnosability — a blocked issuance must give an actionable message, not an opaque 500 |
| C6 | **Data residency / hosting region** — open, now for the right reason (see below). Choose host and KMS region together |

---

## 5. Two corrections worth remembering

**Residency: ZATCA does NOT mandate in-KSA storage.** §5.5 explicitly permits
"on-premises in the KSA **or in the cloud**"; the binding constraint is
**accessibility** — "a direct link that can be made available to the Authority".
Our "must be in KSA" came from a secondary source and was never checked against
the primary. NCA/CSP/sector rules may still impose residency — an unverified
legal question. The archive backend is swappable either way, because an
unverified claim is not a basis for committing hosting and neither is its absence.

**Five instances of correct-but-not-connected**, all within M12: a pipeline
unreachable from real rows, a loader fed the wrong chain, an outbox nothing
enqueued into, a field nothing wrote, and a client that was only ever a mock.
Hence the three-part standing check in `CLAUDE.md`: before marking a milestone
complete, verify every capability has a production **caller**, every field it
depends on has a production **writer**, and every client it depends on has a real
**implementation** — not an interface plus a mock.
