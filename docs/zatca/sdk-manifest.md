# ZATCA Compliance & Enablement Toolbox (SDK) — inventory

**✅ Publicly downloadable. No sandbox account, no login, no VAT registration.**

Fetch with `./fetch-sdk.sh`. The archive and extracted tree are **gitignored**
(~40 MB / ~90 MB); this file is the committed manifest.

| | |
| --- | --- |
| File | `zatca-envoice-sdk-203.zip` |
| Size | 40,884,034 bytes |
| SHA-256 | `1a7df6d91fd34968ad59a97087f637f56504fdf92c42050916b838be20fc5ae3` |
| SDK version | 2.0.3 (CLI jar reports **3.0.8**) |
| Retrieved | 4 Aug 2026 |
| Landing page | <https://zatca.gov.sa/en/E-Invoicing/SystemsDevelopers/ComplianceEnablementToolbox/Pages/DownloadSDK.aspx> |
| Direct link | ZATCA SharePoint (`sadzit.sharepoint.com`) → `ZATCA Library/zatca-envoice-sdk-203.zip` |

> **Download gotcha:** SharePoint returns **403 to a plain `curl`**. A browser
> `User-Agent` *and* a cookie jar are both needed — the first request sets a
> session cookie the file redirect requires. `fetch-sdk.sh` handles this and
> fails loudly if it gets a short error page instead of the archive.

## What's inside — 37 files

### ✅ XSD schemas — `Data/Schemas/xsds/UBL2.1/xsd/`

Complete UBL 2.1 set. `maindoc/UBL-Invoice-2.1.xsd` is the entry point
(referenced by `Configuration/defaults.json`), plus 14 common schemas including
`UBL-XAdESv132-2.1.xsd`, `UBL-XAdESv141-2.1.xsd`, and
`UBL-xmldsig-core-schema-2.1.xsd`.

**→ M12.2 validates generated XML against these.**

### ✅ Schematron business rules — `Data/Rules/schematrons/`

Compiled to XSLT, not raw `.sch`:

| File | Size | Contents |
| --- | --- | --- |
| `20210819_ZATCA_E-invoice_Validation_Rules.xsl` | 253 KB | **55 distinct `BR-KSA-*` rules** (BR-KSA-02 … BR-KSA-*) |
| `CEN-EN16931-UBL.xsl` | 212 KB | European EN 16931 base rules |

⚠️ **The ZATCA ruleset is dated 19 Aug 2021** and the files are stamped May 2022.
The SDK is not refreshed on the same cadence as the live platform — treat it as
**necessary but not sufficient**. Passing locally does not guarantee the
Compliance CSID checks (M12.4) pass.

### ✅ Offline validator + CLI — `Apps/`

`cli-3.0.8-jar-with-dependencies.jar` + `fatoora` launcher (**requires Java**).
Commands (`Configuration/usage.txt`):

| Flag | Purpose |
| --- | --- |
| `-csr` / `-pem` | Generate CSR + private key (`-csrConfig <file>`) |
| `-sign` | Sign an invoice → `-signedInvoice <out>` |
| `-validate` | **Validate against XSD + both schematrons** |
| `-qr` | Generate the QR code |
| `-generateHash` | Compute the invoice hash |
| `-invoiceRequest` | Build the ZATCA API JSON request |
| `-nonprod` | Use non-production cert/key |

**→ This is the authoritative offline check for M12.2 and M12.3.**

### ✅ Test certificate + key — `Data/Certificates/`

`cert.pem` and **`ec-secp256k1-priv-key.pem`** (`certPassword: 123456789`).
Lets M12.3 exercise the full sign→validate loop with **zero ZATCA access**.

### ✅ Genesis PIH — `Data/PIH/pih.txt`

```
NWZlY2ViNjZmZmM4NmYzOGQ5NTI3ODZjNmQ2OTZjNzljMmRiYzIzOWRkNGU5MWI0NjcyOWQ3M2EyN2ZiNTdlOQ==
```

Verified: this is Base64 of the **hex string** `5feceb66…57e9`, which is
`SHA-256("0")`. Note the double encoding — it is *not* Base64 of the raw digest
bytes. **This is the first invoice's PIH**, replacing our `"GENESIS"` literal.

### ✅ CSR config — `Data/Input/csr-config-example.properties`

ZATCA's own example, verbatim:

```properties
csr.common.name=TST-886431145-312345678900003
csr.serial.number=1-TST|2-TST|3-ed22f1d8-e6a2-1118-9b58-d9a8f11e445f
csr.organization.identifier=312345678900003
csr.organization.unit.name=3123456789
csr.organization.name=3123456789
csr.country.name=SA
csr.invoice.type=1111
csr.location.address=TST
csr.industry.business.category=TST
```

### ❌ NOT included — sample invoices

`Data/Input/` contains **only** the two CSR `.properties` files. **There are no
sample invoice XMLs anywhere in the SDK** (zero `.xml` files outside the schemas).

This corrects the M12.0 report, which assumed the SDK carried ZATCA's samples.
See "Impact on M12.2" below.

---

## 🔴 Trap 1 CONFIRMED — `secp256k1`, from ZATCA's own binaries

Three independent proofs, all from the SDK itself:

1. **`Configuration/defaults.json`** → `"privateKeyPath": "../Data/Certificates/ec-secp256k1-priv-key.pem"`
2. **`com/zatca/sdk/util/ECDSAUtil.class`** contains the literal string `secp256k1`
   (and the bundled `com.starkbank.ellipticcurve` library is secp256k1-only).
   **No `prime256v1` / `P-256` string anywhere in the ZATCA classes.**
3. **The shipped private key's DER** contains OID **`1.3.132.0.10` (secp256k1)**
   and does **not** contain `1.2.840.10045.3.1.7` (prime256v1/P-256) — decoded
   and verified.

The spec's "P-256" is an error in a table it labels *illustrative*. Settled.

## 🟡 Trap 2 — partially confirmed

`csr.invoice.type` and `csr.industry.business.category` are **two separate config
keys**, which confirms invoice type and industry are distinct fields — the spec's
Table 1 wrongly assigns OID 2.5.4.15 to both.

The SDK abstracts the OID mapping behind these keys, so the archive does not
*prove* invoice type → `title` (2.5.4.12). **Confirm in M12.4** by generating a
CSR with `Apps/fatoora -csr` and decoding the output. Cheap, and it needs no
ZATCA access — do it before writing our own CSR builder.

---

## Impact on M12.2 — we are NOT building blind

| Need | Have | Source |
| --- | --- | --- |
| Structural validity (XSD) | ✅ | SDK XSDs |
| KSA business rules | ✅ 55 `BR-KSA-*` | SDK schematron (⚠️ 2021 vintage) |
| Signature correctness | ✅ | SDK test cert + key, `-sign` then `-validate` |
| PIH chain genesis | ✅ | `pih.txt`, verified |
| Curve | ✅ | Proven three ways |
| **A known-good reference invoice** | ❌ | **Not in the SDK** |

**Verdict: M12.2 has a real authoritative check.** The validator answers "is our
XML valid?" — which is the question that matters — so the two traps that
motivated this investigation are covered.

What's missing is a *golden file*: a ZATCA-blessed invoice to diff against, which
would answer "is our XML shaped the way ZATCA expects?" Without one, the M12.2
plan changes from **"diff against ZATCA's samples"** to **"generate → run
`fatoora -validate` → iterate until clean"**. Slower, and it won't catch choices
that are valid but unidiomatic.

**Mitigation:** the reference implementations (`zatca-xml-js`, `SallaApp/ZATCA`,
`php-zatca-xml`) ship their own test invoices derived from ZATCA materials. Use
one as an informal golden file, with the SDK validator as the authority. Do not
treat a third-party sample as normative.

**Residual risk, stated plainly:** a locally-clean invoice can still fail the
Compliance CSID checks at M12.4, because the SDK ruleset is from 2021 and the
live platform has moved on. M12.4 remains the real proof — that was already true,
and it is why M12.4 is sequenced where it is.
