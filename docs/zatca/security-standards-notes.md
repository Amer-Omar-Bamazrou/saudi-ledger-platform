# ZATCA Security Features Implementation Standards v1.2 — implementation notes

Working notes for **M12.3 (cryptography)**, verified line-by-line against the
actual PDF (`specs/20230519_ZATCA_Electronic_Invoice_Security_Features_Implementation_Standards_vF.pdf`,
SHA-256 `9049935e…`, ZATCA `Last-Modified` 2023-05-19). Extract the text yourself
with `pdftotext -layout` if you need to re-check a line.

**Build M12.3 against this file, not against memory or a summary.** Two items
below are places where the spec's own wording will lead you to an implementation
that ZATCA rejects — both are called out as 🔴 TRAPS.

> ⚠️ The certificate profile table in §2.2.2 is **column-shifted** when extracted
> with `pdftotext` — values sit one row below their field names. Reconstruct
> carefully before quoting it.

---

## 🔴 TRAP 1 — the elliptic curve is secp256k1, NOT P-256

**Use `secp256k1`.** This is the single highest-consequence detail in the spec,
and the document itself points the wrong way.

**What the spec actually says.** The *normative* requirement (§2.2.1, Req 16)
names **no curve at all**:

> **16 Cryptographic algorithms**
> Hashing algorithm shall be SHA-256;
> Asymmetric key algorithm shall be ECDSA;
> Key length shall be 256.

"P-256" appears exactly once, in the §2.2.2 X.509 profile table, on the
`SubjectPublicKeyInfo` row:

> `SubjectPublicKeyInfo` → Public Key, **Key length: P-256**

But that table is **explicitly non-normative**. The spec's own preamble to it:

> "While the final certificate profile is going to be published by ZATCA in
> connection with its CA(s) service as part its CP/CPS, the following is provided
> as an **illustrative** profile for taxpayers and vendors."

**What ZATCA actually implements.** ZATCA's own official SDK writes the generated
private key to a file literally named:

```
zatca-einvoicing-sdk/Data/Certificate/ec-secp256k1-priv-key.pem
```

and the documented key-generation step is:

```bash
openssl ecparam -name secp256k1 -genkey -noout -out privatekey.pem
```

Every working implementation (`zatca-xml-js`, `SallaApp/ZATCA`, `php-zatca-xml`,
the Odoo/ERPNext modules) uses `secp256k1`. P-256 CSRs are rejected.

**Why the confusion is dangerous:** `secp256k1` (Koblitz, the Bitcoin curve) and
`P-256` / `secp256r1` / `prime256v1` (NIST) are both 256-bit, so "key length shall
be 256" is satisfied by either. They are *different curves* — a P-256 CSR fails at
the Compliance CSID call and every signature fails validation. Picking wrong is
only discovered at M12.4, after the whole crypto layer is built.

```js
crypto.generateKeyPairSync("ec", { namedCurve: "secp256k1" })  // ✅
crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" }) // ❌ rejected
```

## 🔴 TRAP 2 — invoice type goes in `title`, not `businessCategory` (CONFIRMED)

The spec's Table 1 assigns OID **2.5.4.15 (`businessCategory`) to TWO different
rows** — "Invoice Type" *and* "Industry". That is a defect in the document, and
following it literally produces a rejected CSR.

**PROVEN against ZATCA's own SDK.** Generating a CSR with the SDK's own example
config (`csr.invoice.type=1111`, `csr.industry.business.category=TST`):

```
java -jar Apps/cli-3.0.8-jar-with-dependencies.jar -csr -pem \
  -csrConfig Data/Input/csr-config-example.properties \
  -privateKey key.pem -generatedCsr out.csr -nonprod
```

and decoding the resulting subject DN yields:

```
C (2.5.4.6)                  = "SA"
OU (2.5.4.11)                = "3123456789"
O (2.5.4.10)                 = "3123456789"
CN (2.5.4.3)                 = "TST-886431145-312345678900003"
title (2.5.4.12)             = "1111"     ← INVOICE TYPE
registeredAddress (2.5.4.26) = "TST"
businessCategory (2.5.4.15)  = "TST"      ← INDUSTRY
```

| CSR field | Holds | Example |
| --- | --- | --- |
| `title` (2.5.4.12) | **Invoice type**, 4 digits over `TSCZ` | `1100` |
| `businessCategory` (2.5.4.15) | **Industry / business sector** (free text) | `Software` |

**`title` = TSCZ invoice-type flags; `businessCategory` = industry.** Settled.

Note: `organizationIdentifier` (2.5.4.97) and the EGS serial do **not** appear in
the main subject DN — they are carried in the `subjectAltName` `dirName`
(as `UID` and `SN`). Confirm that placement when building our own CSR in M12.3.

---

## Cryptographic stamp core — verified

- Stamp = ECDSA digital signature over the document hash.
- **SHA-256** hashing, **ECDSA**, key length **256** → **`secp256k1`** (Trap 1).
- Key pair generated per **FIPS 186**; suitability validated via **ECC Full or
  Partial Public Key Validation Routine** (spec cites "NIST SP 56A: Revision 2",
  i.e. SP 800-56A Rev 2, §§5.6.2.3.2 / 5.6.2.3.3).
- Keys **must be marked non-exportable**, to prohibit export from the security
  module where generated. **Hardware or software module both acceptable** —
  an HSM is not required.
- Certificate (CSID) issued **per EGS unit** by ZATCA's technical CA.
  `NotAfter` = generation time **+ up to 60 months (5 years)**.

## Onboarding / lifecycle — verified

- EGS generates a **PKCS#10 CSR** including **at least the CN and public key**,
  **signed with the private key as proof-of-possession** (Req 7).
- Taxpayer portal validates → ZATCA CA issues CSID → installed on the EGS.
- **Renewal (§2.1.2):** the CA "validates that the existing certificate is not
  revoked or renewed before, **then revokes the existing certificate**" and issues
  a new one. Taxpayers get an expiry reminder from the portal beforehand.
- **Revocation triggers (§2.1.3)** — quoted:
  - "If the taxpayer believes that the private key (or the EGS) was stolen or
    otherwise compromised"
  - "if the EGS has been damaged, decommissioned or transferred to business unit"
  - "If the taxpayer discovers that the information in the digital certificate is
    not accurate"
- **Revocation status via CRL or OCSP. CRLs valid seven (7) days**, which "would
  allow EGSs to work fully offline for seven (7) days" before refreshing (Req 14).
- Validity **must be checked before using the certificate for stamping** (Req 15).

## CSR subject fields (Table 1) — verified

| Field | Value | Notes |
| --- | --- | --- |
| `CN` | Solution unit name / asset tracking number | Free text, **manual** |
| EGS serial → `x509.alternative_names` (GUID) | `1-<Manufacturer>\|2-<Model>\|3-<Serial>` | **Format is validated.** In practice emitted as `SN` inside a `subjectAltName` `dirName` |
| `organizationIdentifier` (2.5.4.97) | VAT / group VAT registration number | **15 digits, begins with 3 and ends with 3** |
| `OU` (`organizational_unit`) | Branch name; for **VAT groups**, the **10-digit TIN** of the member being onboarded | VAT group is indicated by the **11th digit of the organization identifier being `1`** |
| `O` (`organization`) | Taxpayer name | Free text |
| `C` (`country`) | ISO 3166 **alpha-2** | |
| **`title`** (2.5.4.12) | **Invoice type** — 4 digits over `TSCZ` | See Trap 2 |
| `registeredAddress` (2.5.4.26) | Branch / device location | Saudi National Address **short address** preferred |
| `businessCategory` (2.5.4.15) | **Industry / sector** | See Trap 2 |

**Invoice-type flags — `TSCZ`, in that order**, `0` = not supported, `1` =
supported:

- `T` = Tax invoice (**Standard**, B2B)
- `S` = **Simplified** tax invoice (B2C)
- `C`, `Z` = "for future use"

So `1100` = standard **and** simplified; `1000` = standard only; `0100` =
simplified only. ⚠️ Some third-party guides state this backwards ("B2B=0100") —
the spec is authoritative: **T comes first**.

**Certificate extensions:** `KeyUsage` = `digitalSignature, keyEncipherment`
(**critical**); `ExtendedKeyUsage` = `clientAuth`; plus CRL Distribution Points,
Authority Key Identifier, Subject Key Identifier (both **160-bit SHA-1** of the
respective `subjectPublicKey` BIT STRING, per RFC 5280), Authority Information
Access, and Certificate Policies.

## Signature format — verified

- **XML → XAdES, enveloped**, ETSI **EN 319 132-1**, level **B-B** (Req 10, 11, 15).
- **PDF/A-3 → PAdES**, ETSI **EN 319 142-1**, level **B-B**;
  Signature Dictionary `SubFilter` = **`ETSI.CAdES.detached`**.
- **Data signed = the whole XML content EXCEPT the QR-code data element** (Req 12).
- **≥ 2 `ds:Reference`**: one to the invoice data, one to `SignedProperties` with
  `Type="http://uri.etsi.org/01903#SignedProperties"`.
- Required signed properties: **`SigningTime`**, **`SigningCertificateV2`**,
  **`SignaturePolicyIdentifier`**, and `SignedDataObjectProperties` →
  `DataObjectFormat` → **`MimeType` = `text/xml`** ("that will be always").
- **`SigningCertificateV2` must reference the signing certificate FIRST**, then
  all certificates in the path **including the trust anchor**, each as a digest +
  algorithm identifier. The **full chain must be embedded** in the signature
  (Req 17).
- **Signing time is the claimed time from the EGS/platform clock** (Req 13) —
  **no TSA timestamp**.

### Transform chain — quoted verbatim, order matters

```xml
<ds:Transforms>
  <ds:Transform Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116">
    <ds:XPath>not(//ancestor-or-self::ext:UBLExtensions)</ds:XPath>
  </ds:Transform>
  <ds:Transform Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116">
    <ds:XPath>not(//ancestor-or-self::cac:Signature)</ds:XPath>
  </ds:Transform>
  <ds:Transform Algorithm="http://www.w3.org/TR/1999/REC-xpath-19991116">
    <ds:XPath>not(//ancestor-or-self::cac:AdditionalDocumentReference[cbc:ID='QR'])</ds:XPath>
  </ds:Transform>
  <ds:Transform Algorithm="http://www.w3.org/2006/12/xml-c14n11"/>
</ds:Transforms>
```

Canonicalization is **C14N 1.1** (`http://www.w3.org/2006/12/xml-c14n11`) — *not*
exclusive C14N.

## Previous invoice hash (PIH) — §3, verified

> "The hash of the previous invoice is generated by applying **the same transform
> as is used for the cryptographic stamp** and as specified in section 2.3.3 and
> taking the **sha256** algorithm."

Same three XPath exclusions + C14N11, then SHA-256. **This is what replaces our
homegrown `computeInvoiceHash`** — see the LANDMINE note in CLAUDE.md.

## QR code — §4, verified

- **TLV → Base64**, **up to 700 characters**.
- **Tags 1–5** enforced **from 4 December 2021**; **tags 6–9** **from 1 January 2023**.

| Tag | Content |
| --- | --- |
| 1 | Seller's name |
| 2 | Seller's VAT registration number |
| 3 | Invoice timestamp, **ISO 8601** (e.g. `2022-02-21T12:13:57Z`) |
| 4 | Invoice total (**with VAT**) |
| 5 | VAT total (**business term `BT-110`**) |
| 6 | Hash of XML invoice |
| 7 | ECDSA signature of the XML hash |
| 8 | ECDSA public key extracted from the signing private key |
| 9 | **Simplified invoices and their notes only** — ECDSA signature of the cryptographic stamp issued by ZATCA's technical CA |

**Encoding rules — quoted:**

- Tag: "the tag value … stored in **one byte**".
- **Tags 1–5** — Length: "the length of the byte array resulted from the **UTF8
  encoding** of the field value. The length shall be stored in **one byte**."
  Value: the UTF-8 byte array.
- **Tag 6** — Length: "length of hash (SHA256) is **32 bytes**". Value: the raw
  32-byte hash (**not** a hex or base64 string).

**Order of operations (§4.1):** build the complete byte array first → **then**
Base64-encode the whole array → **then** render the QR image. Do not Base64 each
field individually.

## API authentication — §5, verified

**OAuth 2.0 Basic Authentication** (RFC 6749):

- **Client ID = the digital certificate** issued during onboarding.
- **Secret** issued alongside it during onboarding.
- "It is important that the secret value is stored securely and not disclosed to
  third parties" → both go in the M12.5 encrypted credential vault.

## Two workflows — §2.2.1 Req 1.1 / 1.2, verified

- **Standard e-invoices** are **cleared** — ZATCA's centralized platform digitally
  stamps the invoice.
- **Simplified e-invoices** are **stamped locally by the taxpayer's EGS** and
  reported afterwards.

---

## Corrections applied to the working summary this doc replaces

| Claim | Verdict |
| --- | --- |
| "key length 256 (**P-256**)" | ❌ **WRONG — use `secp256k1`.** P-256 appears only in the explicitly *illustrative* profile table; ZATCA's own SDK emits `ec-secp256k1-priv-key.pem`. See Trap 1. |
| "**businessCategory** (2.5.4.15) = invoice type, 4 digits TSCZ" | ❌ **WRONG in practice — invoice type goes in `title`**; `businessCategory` holds the industry. The spec assigns 2.5.4.15 to both rows. See Trap 2. |
| "validated via NIST SP 800-56A" | ⚠️ Correct, but the spec cites it as "NIST SP 56A: Revision 2". |
| "SAN (GUID) — EGS serial, format `1-…\|2-…\|3-…`, format validated" | ✅ Correct. In practice emitted as `SN` within a `subjectAltName` `dirName`. |
| Everything else (validity ≤60 months, PKCS#10 + PoP, CRL/OCSP 7-day offline, revocation triggers, XAdES/PAdES B-B, data signed except QR, ≥2 `ds:Reference`, `SignedProperties` Type URI, `SigningTime` / `SigningCertificateV2` / `SignaturePolicyIdentifier`, `MimeType=text/xml`, transform chain + C14N11, claimed signing time, full chain embedded, PIH same transform + SHA-256, QR ≤700 chars / tag lengths / build-then-Base64, OAuth 2.0 Basic with cert as client ID, clearance vs local-stamp workflows) | ✅ **Verified accurate against the PDF.** |
