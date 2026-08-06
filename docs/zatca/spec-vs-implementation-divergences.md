# ZATCA: where the PDFs and the implementation disagree

**Operating principle: ZATCA's binaries are the specification. The PDFs are an
unreliable narrator.**

Every divergence below was found by running ZATCA's own SDK, not by reading
their documentation. Each one would have failed at M12.4 (Compliance CSID) with
a rejection and no useful diagnostic. **Where the two disagree, we follow the
implementation and record it here.**

If ZATCA ever updates either the PDF or the SDK, this file says which one we
tracked and why. The SDK is checksum-pinned in
[`sdk-manifest.md`](sdk-manifest.md) so a change is detectable.

---

## 1. The elliptic curve — `secp256k1`, not P-256

| | |
| --- | --- |
| **PDF says** | The normative Req 16 names no curve ("key length shall be 256"). The §2.2.2 certificate profile table says **`P-256`**. |
| **Implementation** | **`secp256k1`.** |
| **Evidence** | SDK ships `Data/Certificates/ec-secp256k1-priv-key.pem`; `com/zatca/sdk/util/ECDSAUtil.class` contains the literal string `secp256k1`; the shipped key's DER carries OID **1.3.132.0.10** and not `1.2.840.10045.3.1.7`. |
| **We follow** | Implementation. |

The PDF's own table is labelled *"illustrative"*, so this is arguably a
misreading trap rather than an error — but it points the wrong way, and P-256 is
what a careful reader would pick.

## 2. CSR — invoice type goes in `title`, not `businessCategory`

| | |
| --- | --- |
| **PDF says** | Table 1 assigns OID **2.5.4.15 (`businessCategory`)** to *two different rows*: "Invoice Type" **and** "Industry". |
| **Implementation** | `title` (**2.5.4.12**) = invoice type; `businessCategory` (2.5.4.15) = industry. |
| **Evidence** | `fatoora -csr` from ZATCA's own `csr-config-example.properties` (`csr.invoice.type=1111`, `csr.industry.business.category=TST`) decodes to `title = "1111"`, `businessCategory = "TST"`. |
| **We follow** | Implementation. |

## 3. CSR — the subject DN has only FOUR attributes

| | |
| --- | --- |
| **PDF says** | Table 1 reads as though every field is a subject-DN attribute. |
| **Implementation** | Subject DN = **`C`, `OU`, `O`, `CN`** only. `title`, `registeredAddress`, `businessCategory`, the VAT number and the EGS serial all live in the **`subjectAltName` `dirName`**. |
| **Evidence** | Structural parse of a `fatoora -csr` output. |
| **We follow** | Implementation. |

SAN `dirName` field order (ours matches byte-for-byte):

```
2.5.4.4                    surname           → EGS serial  1-<Mfr>|2-<Model>|3-<Serial>
0.9.2342.19200300.100.1.1  UID               → 15-digit VAT number
2.5.4.12                   title             → invoice type (TSCZ)
2.5.4.26                   registeredAddress → location
2.5.4.15                   businessCategory  → industry
```

## 4. CSR — the EGS serial uses `surname` (2.5.4.4), not `serialNumber` (2.5.4.5)

| | |
| --- | --- |
| **PDF says** | Calls the field "EGS Serial Number". |
| **Implementation** | OID **2.5.4.4 (`surname`)**. |
| **Evidence** | Same structural parse. |
| **We follow** | Implementation. |

## 5. CSR — an undocumented certificate-template extension is REQUIRED

| | |
| --- | --- |
| **PDF says** | Nothing. |
| **Implementation** | Extension **`1.3.6.1.4.1.311.20.2`** (Microsoft certificate-template-name), a bare DER `UTF8String`. |
| **Values** | Production `ZATCA-Code-Signing` · Sandbox/simulation **`TSTZATCA-Code-Signing`** |
| **Evidence** | Present in every `fatoora -csr` output; `-nonprod` toggles the `TST` prefix. |
| **We follow** | Implementation. |

## 6. XAdES — the SignedProperties `Reference/@Type`

| | |
| --- | --- |
| **PDF says** | `http://uri.etsi.org/01903#SignedProperties` |
| **Implementation** | **`http://www.w3.org/2000/09/xmldsig#SignatureProperties`** |
| **Evidence** | ZATCA's own XAdES template, `xml/ubl.xml` inside the SDK jar. |
| **We follow** | Implementation. |

## 7. XAdES — `SigningCertificate`, not `SigningCertificateV2`

| | |
| --- | --- |
| **PDF says** | `SigningCertificateV2`, with references to **every** certificate in the path including the trust anchor. |
| **Implementation** | **`xades:SigningCertificate`** (v1) with a **single** `xades:Cert`, and a **single** `ds:X509Certificate` in `KeyInfo`. |
| **Evidence** | `xml/ubl.xml`. |
| **We follow** | Implementation. |

## 8. XAdES — two required properties are absent

| | |
| --- | --- |
| **PDF says** | `SignaturePolicyIdentifier` (cardinality 1) and `SignedDataObjectProperties` → `DataObjectFormat` → `MimeType = text/xml` are mandatory. |
| **Implementation** | **Neither appears.** |
| **Evidence** | `xml/ubl.xml`. |
| **We follow** | Implementation. |

## 9. 🔴 XAdES — THREE digests, TWO different encodings

The strangest one, and invisible from the PDF.

| Digest | Encoding |
| --- | --- |
| `ds:Reference[@Id='invoiceSignedData']/ds:DigestValue` | `base64(RAW 32 digest bytes)` |
| `ds:Reference[@URI='#xadesSignedProperties']/ds:DigestValue` | **`base64(HEX STRING of the digest)`** |
| `xades:CertDigest/ds:DigestValue` | **`base64(HEX STRING of the digest)`** |

Verified by decoding a real `fatoora -sign` output:

```
NRhTmCMYV0J6wdcHbrDwKll5Wm7i+/lL+7gg3IXKIXk=   → 32 raw bytes
MTQ5ZWM3MTllMDk5ZWZjOTBjZjc1NDdkYTcwYjEzMmNk…  → "149ec719e099efc90cf7547da70b132c…"
NjlhOTVmYzIzN2I0MjcxNGRjNDQ1N2EzM2I5NGNjNDUy…  → "69a95fc237b42714dc4457a33b94cc45…"
```

**We follow the implementation** — raw for the invoice reference, hex-then-base64
for the other two. Note this is the same double-encoding as the genesis PIH
(`base64` of the *hex string* of `SHA-256("0")`), so it is at least internally
consistent with ZATCA's habits.

## 10. 🔴 XAdES — `SignatureValue` is NOT computed over `SignedInfo`

**The single most consequential divergence found so far.** A standards-correct
XMLDSig implementation is *wrong* here and would be rejected.

Decompiled from `com.gazt.einvoicing.digitalsignature.service.impl.DigitalSignatureServiceImpl`:

```java
public DigitalSignature getDigitalSignature(String xmlDocument, PrivateKey privateKey, String xmlHashing) {
    byte[] xmlHashingBytes = Base64.getDecoder().decode(xmlHashing.getBytes(UTF_8));  // raw 32 digest bytes
    byte[] digitalSignatureBytes = this.signECDSA(privateKey, xmlHashingBytes);
    ...
}
byte[] signECDSA(PrivateKey privateKey, byte[] messageHash) {
    Signature signature = Signature.getInstance("SHA256withECDSA");
    signature.initSign(privateKey);
    signature.update(messageHash);      // <-- the RAW INVOICE DIGEST, not SignedInfo
    return signature.sign();
}
```

| | |
| --- | --- |
| **XMLDSig / the PDF imply** | Sign the canonicalised `ds:SignedInfo`. |
| **Implementation** | **`SignatureValue = base64( DER-ECDSA( SHA256withECDSA over the RAW 32-byte invoice digest ) )`.** `SignedInfo` is never signed. |
| **Corroboration** | In `SigningServiceImpl.signDocument`, `getDigitalSignature(...)` is called **before** `populateSignedSignatureProperties(...)` computes the SignedProperties digest — the signature cannot cover a `SignedInfo` whose contents do not yet exist. |
| **We follow** | Implementation. |

Note `SHA256withECDSA` hashes its input again, so the 32-byte digest is itself
SHA-256'd before signing.

## 11. 🔴 XAdES — the `SignedProperties` digest input is dom4j `asXML()`, not C14N

The problem that blocked the signer. Resolved by decompiling
`SigningServiceImpl.populateSignedSignatureProperties`:

```java
String signedSignatureElement = this.getNodeXmlValue(document, nameSpacesMap, ".../xades:SignedProperties");
return this.encodeBase64(this.bytesToHex(this.hashStringToBytes(
        signedSignatureElement.getBytes(StandardCharsets.UTF_8))).getBytes(StandardCharsets.UTF_8));
```

`getNodeXmlValue` returns **`node.asXML()`** — dom4j's plain serialiser. **There is
no canonicalisation at all.** The exact input is the SignedProperties subtree
with its source indentation preserved, plus dom4j's per-element namespace
declarations:

- `xmlns:xades="http://uri.etsi.org/01903/v1.3.2#"` on `<xades:SignedProperties>`,
  **before** the `Id` attribute
- `xmlns:ds="http://www.w3.org/2000/09/xmldsig#"` on **every** `ds:*` descendant
  element (`DigestMethod`, `DigestValue`, `X509IssuerName`, `X509SerialNumber`),
  each immediately after its tag name

Verified: running dom4j's `asXML()` over the reference document's
SignedProperties and hashing produces
`149ec719e099efc90cf7547da70b132cdcfe1588144b774cbdbd16bf2eedd1ec` — an exact
match for ZATCA's emitted `DigestValue`.

### Search space already ruled out — do not repeat

Before decompiling, ~30 candidates were tested against the target and **all
failed**. Recorded so a future session doesn't retrace them:

- the raw substring exactly as it appears in the signed document
- C14N 1.0 of the node (which does add `xmlns:xades` and preserve `Id`)
- `xmlns:ds` added, in both orderings relative to `xmlns:xades`
- leading indentation of 0, 4, 8, 12, 16, 20, 24, 28, 32, 36 spaces (with and
  without the namespace)
- de-indenting children by 4, 8, 12, 16, 20, 24
- CRLF→LF, stray-CR stripping

The lesson: it was never a canonicalisation variant, so no amount of searching within
canonicalisation would have found it. **Decompile earlier.**

## 12. XAdES — `CertDigest` hashes the base64 certificate STRING, not the DER

```java
String certificateHashing = this.encodeBase64(this.bytesToHex(this.hashStringToBytes(
        certificateAsString.getBytes(StandardCharsets.UTF_8))).getBytes(StandardCharsets.UTF_8));
```

`certificateAsString` is the **base64 text** of the certificate (the PEM body),
not its decoded DER bytes. The PDF's Req 17 speaks of a digest "computed over the
entire DER encoded certificate", which is the opposite.

Related, from the same method:
- `ds:X509IssuerName` = Java's `certificate.getIssuerDN().getName()` —
  e.g. `CN=TSZEINVOICE-SubCA-1, DC=extgazt, DC=gov, DC=local` (reversed RDN
  order, comma-space separated)
- `ds:X509SerialNumber` = `certificate.getSerialNumber().toString()` — decimal

## 13. 🔴 QR — tags 6-9 are NOT what the spec describes

The spec's §4 table and its encoding rules are both wrong about tags 6-9.
Established by decoding the QR from a real `fatoora -sign` output (byte offsets
verified, not inferred):

| Tag | PDF says | Bytes ZATCA actually emits |
| --- | --- | --- |
| 6 | "Hash of XML invoice", length "**32 bytes**", raw digest | **44 bytes — the BASE64 STRING** `NRhTmCMYV0J6…` |
| 7 | ECDSA signature of the hash | **88 bytes — the SPKI DER public key** (`3056301006072a8648ce3d0201…`) |
| 8 | ECDSA public key | **32 bytes** — the `r` of the ECDSA signature |
| 9 | ZATCA CA signature (simplified only) | **32 bytes** — the `s` of the ECDSA signature |

The `r`/`s` reading is confirmed against the document's own `SignatureValue`:

```
SignatureValue DER = 3044 0220 0462621b…c4bfb7c  0220 0b15c8cc…574bd404
                              └─ tag 8 (32B) ─┘        └─ tag 9 (32B) ─┘
```

Two corrections that matter most:

1. **Tag 6 carries the 44-character base64 STRING, not the raw 32 digest bytes.**
   The spec is explicit and explicit*ly wrong*: *"Length: length of hash (SHA256)
   is 32 bytes"*. Implementing the documented rule yields a QR ZATCA's own
   validator will not recognise.
2. **Tag 7 is the public key, tag 8/9 are the signature** — i.e. the spec's tag
   7 and 8 are effectively swapped, and its tag 9 is not a CA signature at all.

⚠️ **Open question, flagged rather than guessed:** whether the `r`/`s` split
across tags 8 and 9 is deliberate or an artefact of ZATCA's TLV writer. It is
what their SDK emits and what their validator accepts (our M12.2 simplified
invoice passed the `[QR]` stage), so **we follow the observed bytes** — but the
*intent* is unverified. Re-confirm against the sandbox in M12.4 before relying on
tag 9 semantics for simplified invoices.

**We follow** the observed bytes. `crypto/qr.ts`'s original tag semantics were
written from the PDF and are wrong; they are corrected to match.

## 14. Canonicalisation — C14N 1.1 declared, and genuinely used

Not a divergence, recorded because it was investigated at length: ZATCA declares
`http://www.w3.org/2006/12/xml-c14n11` **and** bundles Apache Santuario
including a real `Canonicalizer11`. They are not quietly using a 1.0 engine.

Our C14N 1.0 engine is byte-identical to it for ZATCA invoices — proven
structurally, by schema, and empirically. Full record:
[`c14n-decision.md`](c14n-decision.md).

---

## Also verified CORRECT in the PDF

So the PDF is not uniformly wrong — these matched the implementation exactly:

- The three XPath transform exclusions, verbatim and in order
- `ecdsa-sha256` signature method, `sha256` digest method
- The QR TLV encoding rules (tag byte, UTF-8 **byte** length for tags 1–5, raw
  32 bytes for tag 6, build-then-base64, 700-char cap)
- Tags 1–9 semantics and their enforcement dates
- Certificate validity ≤ 60 months; CRL 7-day offline window
- OAuth 2.0 Basic with the certificate as client ID
