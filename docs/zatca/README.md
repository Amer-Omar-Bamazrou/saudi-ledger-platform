# ZATCA Phase 2 — reference specifications

Source material for the **M12 ZATCA Phase 2 (Fatoora) integration** workstream.

The PDFs themselves live in `specs/` and are **gitignored** (large vendor binaries).
This file is the manifest: fetch them with `./fetch-specs.sh`, then verify against
the checksums below. If a checksum no longer matches, **ZATCA has revised the
document** — read the diff before assuming our implementation is still correct.

## Why the dates matter

ZATCA revises these documents without changing their URLs. The `Last-Modified`
column is the authoritative publication date taken from ZATCA's own server (not
the date printed inside the PDF, which is often the original release). Verified
**4 Aug 2026**.

| Document | Last-Modified (ZATCA server) | SHA-256 |
| --- | --- | --- |
| `E-invoicing-Detailed-Technical-Guideline.pdf` | **2022-11-27** | `313393cc506191449fab44e2db1a930801676d172f214533e1995ca91e2487ab` |
| `20230519_ZATCA_Electronic_Invoice_Security_Features_Implementation_Standards_vF.pdf` | **2023-05-19** (v1.2) | `9049935ee34f9d491c592151506984944d036b5f946f77b443321bf580e704d4` |
| `E-Invoicing_Detailed__Guideline.pdf` | **2023-08-14** | `55b7dfb481b8732078ee8fa6264a42a7293ac555b0682a8458a75f634e4ff2e4` |
| `Fatoora_Portal_User_Manual_English.pdf` | 2023-06-07 (PDF creation) | `6fec08254aac8f3aab2247f96bd7b4ac2dc3558fb48c2a4b598dde564ad14c52` |
| `sandbox_Developer_Portal_User_Manual.pdf` | **2026-07-07** ← most recently updated | `5d66f4e4502dba499a1936ac3174ba10041ded87ca0e8d1dc518c5fcbcd26e49` |
| `QRCodeCreation.pdf` | 2021-11-22 (Phase 1 era) | `a27159ab6f6e7ba024f8bdda41a1e3ddfe232c5738a93076ec7523f719361092` |

**The two that govern our implementation:**

- **Detailed Technical Guideline** (Nov 2022) — onboarding flow, the compliance /
  clearance / reporting APIs, invoice types, EGS units. Despite the age, this is
  still the current published version.
- **Security Features Implementation Standards v1.2** (May 2023) — the
  cryptography: ECDSA `secp256k1`, XAdES-BES, C14N canonicalization, the invoice
  hash, the PIH chain, CSR fields, and QR tags 1–9. **This is the spec M12.3 is
  built against.**

The **sandbox Developer Portal manual is the freshest document ZATCA publishes**
(7 Jul 2026) and is the best guide to the sandbox APIs specifically.

## Compliance & Enablement Toolbox (SDK) — obtained ✅

**Publicly downloadable — no account, no login, no VAT registration.** Fetch with
`./fetch-sdk.sh`; full inventory in [`sdk-manifest.md`](sdk-manifest.md).

Carries the **UBL 2.1 XSD schemas**, the **55 `BR-KSA-*` schematron rules**, an
**offline validator/signer CLI** (Java), a **test certificate + secp256k1 private
key**, and the **genesis PIH**. It is the authoritative local check for M12.2 and
M12.3 — and it proved the `secp256k1` curve three separate ways.

⚠️ It does **not** contain sample invoice XMLs, and its ruleset is dated 2021 —
necessary but not sufficient. See the manifest's "Impact on M12.2".

## Environments

| Environment | URL | Access requirement |
| --- | --- | --- |
| **Sandbox** (Developer Portal) | <https://sandbox.zatca.gov.sa/> | **Email registration only — no VAT/CR needed.** Confirmed live, HTTP 200, 4 Aug 2026. |
| **Simulation** | <https://fatoora.zatca.gov.sa/> | **ERAD credentials — a real, active Saudi VAT registration.** ⚠️ Blocks M12.7. |
| **Production** | <https://fatoora.zatca.gov.sa/> | Real VAT registration; each tenant onboards their own EGS via OTP. |

## 🔴 OPEN: ZATCA's API hosts are unreachable (observed 2026-08-07)

**M12.4 is blocked on this.** Not a crypto failure — nothing reached an
application at all.

| Host | DNS | TCP 443 |
| --- | --- | --- |
| `gw-fatoora.zatca.gov.sa` | resolves (185.117.128.50, .129.50) | **no connection** |
| `sandbox.zatca.gov.sa` | resolves (185.117.129.147, .128.147) | **no connection** |
| `zatca.gov.sa` (control) | resolves | **OPEN**, HTTP 302 |

Both API/sandbox hosts resolve but refuse TCP on 443, while the main site on the
same domain connects normally. Network layer — not TLS, not auth, not a rejected
request.

**Evidence gathered:**

- Confirmed unreachable from **two independent networks** — home broadband and
  5G mobile data — so it is not a local ISP or router problem.
- The reporter is **in Saudi Arabia**. This substantially weakens the
  geo-restriction hypothesis: in-region traffic would be permitted, and a Saudi
  taxpayer unable to reach ZATCA's own developer sandbox would be very odd.
- **`sandbox.zatca.gov.sa` returned HTTP 200 on 2026-08-04** during M12.0, from
  the same machine. So this is a change, not a standing condition.

**Current reading:** more likely an outage or maintenance window than IP
allowlisting. **Retry in 24-48h before treating it as structural.**

**If it persists:**

- The M12.0 note about a **static egress IP / NAT gateway** stops being a
  "verify this" item and becomes a **hard deployment requirement**.
- Check ZATCA's developer forum for reports:
  <https://zatca1.discourse.group>

## Enforcement timeline (as of 4 Aug 2026)

| Wave | Threshold (VAT-taxable revenue, 2022/23/24) | Deadline |
| --- | --- | --- |
| 23 | > SAR 750,000 | 31 Mar 2026 — passed |
| 24 | > SAR 375,000 | 30 Jun 2026 — **enforcement live since 1 Jul 2026** |
| 25 | > SAR 187,500 | **1 Feb 2027** (announced 24 Jul 2026) |

Fines: SAR 5,000–50,000 per violation category. ZATCA's fines-exemption
initiative currently runs to **31 Dec 2026** — do not assume a further extension.
