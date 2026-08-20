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
| `KSA_VAT_Implementing_Regulations_EN.pdf` 🔴 **legal text** | **2023-08-30** (Eighth Edition) | `659fb67cc8ed6afcd4bdb5628be81e0b3c70f683b8bd8876c6631770f1215cb3` |
| `ZATCA_E-Invoicing_Implementation_Resolution_20230519_EN.pdf` 🔴 **legal text** | **2023-05-19** | `06a7ce0a3e113a142554b9293e148fd99eb058e6075f1c4c75c7d99354d16066` |

> 🔴 The two **legal text** rows matter most: C9's VAT-treatment verdicts and
> C12's invoice-numbering verdicts cite these documents clause by clause
> (`docs/tax/*.md`), so **a changed checksum here means the LAW our verdicts
> cite may have moved** — re-read the diff against the verification docs, not
> just the implementation. They were added to `fetch-specs.sh` on 2026-08-21
> but left out of this manifest for a day, which meant a ZATCA revision to the
> VAT Implementing Regulation would have passed silently — the exact failure
> this manifest exists to catch, and the same shape as a guard that matches
> nothing. Committed text extractions (`*_EN.txt`) sit beside them so every
> cited clause is greppable without a download.

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

## 🔴 CORRECTION (M12.8): storage residency — cloud is explicitly permitted

We recorded, from **2026-08-04 until M12.8**, that ZATCA requires e-invoices to be
archived on servers **inside Saudi Arabia**. **That is not in the specification.**
It came from a secondary source and was never checked against the pinned PDFs in
`specs/`, which contradict it.

**§5.5 *Data Storage and Archival*, `E-Invoicing_Detailed__Guideline.pdf`:**

> Persons subject to the E-Invoicing Regulation **may store their electronic
> invoices in a server on-premises in the KSA or in the cloud** as per their
> solution requirements and storage requirements and according to the provisions
> in VAT Law, VAT Implementing Regulation, E-Invoicing Regulation and Resolutions
> and all other relevant Laws in KSA.

and, in the same section:

> Taxpayer's E-Invoice Solutions **may reside on the cloud** in accordance with
> VAT Implementing Regulation, however additional non-tax-related regulations may
> apply to the taxpayer entity, such as **National Cybersecurity Authority**
> published laws and any other applicable regulations or controls.

**The binding constraint is accessibility, not geography:**

> As per VAT Implementing Regulations, if the data is hosted on the cloud, it
> **must be accessible through a direct link that can be made available to the
> Authority**. This requirement is **mandatory for audit purposes**.

### What this does and does not change

| | Status |
| --- | --- |
| ZATCA mandates in-country storage | ❌ **False** — not in the primary source |
| Cloud storage permitted by ZATCA | ✅ Explicitly |
| A direct audit link must be producible | ✅ **Mandatory** — a feature to build (M12.8) |
| NCA / CSP / sector rules may impose residency | ⚠️ **Unverified — a LEGAL question** |
| Hosting region decided | ❌ **Still open** |

**Do not read this as "we can host anywhere."** §5.5 defers outward to the NCA
and to "any other applicable regulations"; we have not checked those, and they
are a legal question rather than a technical one. We have established only that
**ZATCA is not the source of a residency constraint** — not that no constraint
exists.

The archive backend therefore stays **swappable behind an interface** (M12.8),
the same hedge as `KeyWrapper` in M12.5. An unverified claim is not a basis for
committing hosting, and neither is the absence of one.

### Also verified in the same reading

- **Naming convention** (§5.5): *VAT Registration (tax registration number) +
  Timestamp (**date and time at the point of invoice generation**) + Invoice
  Reference Number.* 🔴 **Generation, not clearance** — they differ, and for
  simplified invoices reporting may follow up to 24h later.
- **Immutability:** *"Once invoices are generated, they should not be deleted or
  altered by any user"*; the solution must *"protect the generated Electronic
  Invoices and Electronic Notes from any alteration or **undetected deletion**."*
  A property of the archive, not a retention duration.
- **Retention:** the guideline says only *"archived as per VAT regulations"* — the
  6-year / 11-year figures come from the VAT Implementing Regulation, not here.

### The process lesson

Our operating principle is **LIVE API > SDK > PDF**, formulated because ZATCA's
PDFs are wrong wherever their binaries disagree. That was never a licence to skip
reading them. A **secondary source ranks below all three**, and here the primary
source was not merely more reliable than the belief we held — it said the
opposite. Extend the ladder: **LIVE API > SDK > PDF > anything else.**

## ✅ RESOLVED: the API-host outage cleared (2026-08-09)

The connectivity block recorded on 2026-08-07 was **transient — an outage, not IP
allowlisting**, exactly as the leading hypothesis predicted. **M12.4 is no longer
blocked.**

| Host | 2026-08-07 | 2026-08-09 |
| --- | --- | --- |
| `gw-fatoora.zatca.gov.sa` | TCP 443 refused | **HTTP 200 to the API** |
| `sandbox.zatca.gov.sa` | TCP 443 refused | TLS OK; `403` at `/` (Cloudflare edge) |
| `zatca.gov.sa` (control) | open | open |

**The A records changed.** On 07 Aug the hosts resolved to `185.117.128.x`; they
now resolve via `*.cdn.cloudflare.net` (`82.197.55.4/.5`, `84.235.57.230`). ZATCA
appears to have moved these hosts behind Cloudflare, which plausibly explains both
the outage window and the changed edge behaviour.

**No corroborating outage report was found** on
<https://zatca1.discourse.group> for Aug 2026 — the connection-reset and
DNS-failure threads there are from Apr/Aug/Nov **2025**. So the forum neither
confirms nor contradicts; the direct retry settled it.

### What the retry proved — the FIRST validation against a real ZATCA response

A CSR built by `crypto/csr.ts` was submitted to the sandbox compliance endpoint
and **ZATCA's CA issued a certificate**:

```
POST https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal/compliance
  headers: OTP, Accept-Version: V2      body: {"csr": base64(PEM)}
→ 200 {"requestID":…, "dispositionMessage":"ISSUED", "binarySecurityToken":…, "secret":…}
```

Decoding the returned certificate confirms it binds **our** key and **our** CSR
fields:

| Property | Value returned by ZATCA |
| --- | --- |
| subject | `C=SA, OU=Head Office, O=…, CN=SLP-EGS-TEST-001` |
| issuer | `CN=eInvoicing` |
| key | `ec`, **`namedCurve: secp256k1`**, byte-identical to the key we generated |
| SAN | `SN=1-SLP\|2-Platform\|3-EGS001, UID=300000000000003, title=1100, registeredAddress=…, businessCategory=Software` |
| validity | 2026-08-09 → **2031-08-08 (5 years)** |

**This validates divergences #1–#5 against reality** (the `secp256k1` curve; the
invoice type in `title` with `businessCategory` carrying the sector separately;
the four-attribute subject DN; `surname` for the EGS serial; the undocumented
template extension). Had any been wrong, the CA would have rejected the CSR.

**It does NOT validate #6–#13** (XAdES structure and the QR tags). Those are only
exercised when a *signed invoice* is submitted to the compliance checks — the next
step of M12.4 — so they remain unverified against ZATCA.

**Sandbox observations worth knowing:**

- The sandbox **accepts any OTP** — `123456`, `123345` and `111222` all returned
  `ISSUED`. Do not read a successful sandbox OTP as evidence the OTP path works.
- `requestID` is the constant `1234567890123` in sandbox — a stub, not a real id.
- **No account or email registration was needed** for this endpoint.
- The 5-year validity is the **PCSID expiry** M12.8's renewal reminders must track.

**Still unverified:** whether production requires **egress IP allowlisting**
(the M12.0 open question). Sandbox did not, but that says nothing about
production — confirm before go-live.

## Enforcement timeline (as of 4 Aug 2026)

| Wave | Threshold (VAT-taxable revenue, 2022/23/24) | Deadline |
| --- | --- | --- |
| 23 | > SAR 750,000 | 31 Mar 2026 — passed |
| 24 | > SAR 375,000 | 30 Jun 2026 — **enforcement live since 1 Jul 2026** |
| 25 | > SAR 187,500 | **1 Feb 2027** (announced 24 Jul 2026) |

Fines: SAR 5,000–50,000 per violation category. ZATCA's fines-exemption
initiative currently runs to **31 Dec 2026** — do not assume a further extension.
