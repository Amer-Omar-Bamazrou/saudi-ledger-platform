/**
 * ZATCA XAdES signature (M12.3).
 *
 * ── 🔴 BUILT AGAINST ZATCA'S BINARIES, NOT THE PDF ──────────────────────────
 * Structure comes from ZATCA's own template (`xml/ubl.xml` inside their SDK
 * jar); the digest and signature inputs come from decompiling
 * `SigningServiceImpl` and `DigitalSignatureServiceImpl`. Four behaviours here
 * are NOT what the specification describes, and a standards-correct XMLDSig
 * implementation is WRONG in every one of them. Full record in
 * `docs/zatca/spec-vs-implementation-divergences.md` (#6-#12).
 *
 *   #10  `SignatureValue` is SHA256withECDSA over the RAW 32-BYTE INVOICE
 *        DIGEST — `ds:SignedInfo` is never signed. ZATCA computes the signature
 *        BEFORE the SignedProperties digest exists, so it cannot cover it.
 *   #11  The SignedProperties digest is taken over dom4j's `asXML()` output —
 *        source indentation preserved, per-element namespace declarations, and
 *        NO canonicalisation of any kind.
 *   #12  `CertDigest` hashes the BASE64 CERTIFICATE STRING, not its DER.
 *   #9   Three digests, two encodings: the invoice reference is
 *        `base64(raw digest)`; SignedProperties and CertDigest are
 *        `base64(hex string of digest)`.
 *
 * Do not "fix" any of these toward the standard. Each is verified against a real
 * `fatoora -sign` output and pinned by the blocking differential test.
 */
import { createSign, createHash, X509Certificate, type KeyObject } from "crypto";
import { computeInvoiceHash } from "./invoiceHash";

/** `base64( hex string of sha256(input) )` — ZATCA's double encoding (#9). */
function base64OfHexDigest(input: Buffer | string): string {
  const hex = createHash("sha256")
    .update(input as any)
    .digest("hex");
  return Buffer.from(hex, "utf-8").toString("base64");
}

/** ZATCA's SigningTime format: ISO 8601 seconds precision, `Z`. */
function formatSigningTime(when: Date): string {
  return when.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Strip PEM armour, leaving the base64 body ZATCA hashes and embeds. */
export function certificateBase64(certPem: string): string {
  return certPem.replace(/-----[^-]+-----/g, "").replace(/\s/g, "");
}

const XADES_NS = "http://uri.etsi.org/01903/v1.3.2#";
const DS_NS = "http://www.w3.org/2000/09/xmldsig#";
const SHA256_URI = "http://www.w3.org/2001/04/xmlenc#sha256";

/**
 * Build the `xades:SignedProperties` block.
 *
 * Indentation is ZATCA's own (32/36/40/44/48/52 spaces) and is LOAD-BEARING:
 * the digest is taken over this exact text, so reformatting changes the hash.
 * Returned in two forms from one source of truth:
 *
 *   `document` — as embedded (namespaces come from ancestors)
 *   `digestInput` — dom4j `asXML()` equivalent: `xmlns:xades` on the root
 *                   element BEFORE `Id`, `xmlns:ds` on every `ds:*` element
 */
export function buildSignedProperties(params: {
  signingTime: string;
  certDigest: string;
  issuerName: string;
  serialNumber: string;
}): { document: string; digestInput: string } {
  const { signingTime, certDigest, issuerName, serialNumber } = params;

  const document =
    `<xades:SignedProperties Id="xadesSignedProperties">\n` +
    `                                    <xades:SignedSignatureProperties>\n` +
    `                                        <xades:SigningTime>${signingTime}</xades:SigningTime>\n` +
    `                                        <xades:SigningCertificate>\n` +
    `                                            <xades:Cert>\n` +
    `                                                <xades:CertDigest>\n` +
    `                                                    <ds:DigestMethod Algorithm="${SHA256_URI}"/>\n` +
    `                                                    <ds:DigestValue>${certDigest}</ds:DigestValue>\n` +
    `                                                </xades:CertDigest>\n` +
    `                                                <xades:IssuerSerial>\n` +
    `                                                    <ds:X509IssuerName>${issuerName}</ds:X509IssuerName>\n` +
    `                                                    <ds:X509SerialNumber>${serialNumber}</ds:X509SerialNumber>\n` +
    `                                                </xades:IssuerSerial>\n` +
    `                                            </xades:Cert>\n` +
    `                                        </xades:SigningCertificate>\n` +
    `                                    </xades:SignedSignatureProperties>\n` +
    `                                </xades:SignedProperties>`;

  // dom4j declares each namespace on the element that uses it, immediately
  // after the tag name and BEFORE any other attribute.
  const digestInput = document
    .replace("<xades:SignedProperties ", `<xades:SignedProperties xmlns:xades="${XADES_NS}" `)
    .replace(/<ds:([A-Za-z0-9]+)/g, `<ds:$1 xmlns:ds="${DS_NS}"`)
    // The closing tags must not gain a declaration.
    .replace(/<\/ds:([A-Za-z0-9]+) xmlns:ds="[^"]*"/g, "</ds:$1");

  return { document, digestInput };
}

export interface SignInvoiceInput {
  /** The UBL XML from M12.2 — WITHOUT UBLExtensions/Signature/QR. */
  xml: string;
  /** Signing certificate, PEM. */
  certificatePem: string;
  privateKey: KeyObject;
  /** Defaults to now. Injectable so the differential can pin ZATCA's value. */
  signingTime?: Date;
}

export interface SignedInvoice {
  /** The document with UBLExtensions + Signature + QR placeholder injected. */
  signedXml: string;
  /** base64(sha256(canonicalised xml)) — the PIH of the next invoice. */
  invoiceHash: string;
  /** Raw 32 digest bytes — QR tag 6. */
  invoiceHashBytes: Buffer;
  /** base64(DER ECDSA) — QR tag 7. */
  signatureValue: string;
  signatureBytes: Buffer;
  signedPropertiesDigest: string;
  certDigest: string;
  signingTime: string;
}

/**
 * Produce the XAdES signature material for an invoice.
 *
 * Returns the parts rather than a finished document so the caller can assemble
 * UBLExtensions and the QR reference in one pass (the QR needs the signature,
 * and the signature must not cover the QR).
 */
export function signInvoice(input: SignInvoiceInput): Omit<SignedInvoice, "signedXml"> {
  // 1. The invoice digest — the ONLY thing that is actually signed (#10).
  const { base64: invoiceHash, bytes: invoiceHashBytes } = computeInvoiceHash(input.xml);

  // 2. #10: SHA256withECDSA over the RAW DIGEST BYTES, not over SignedInfo.
  //    `createSign("sha256")` hashes its input then signs, exactly matching
  //    Java's `Signature.getInstance("SHA256withECDSA").update(digest)`.
  const signatureBytes = createSign("sha256").update(invoiceHashBytes).sign(input.privateKey);
  const signatureValue = signatureBytes.toString("base64");

  // 3. #12: CertDigest hashes the BASE64 CERTIFICATE STRING, not the DER.
  const certB64 = certificateBase64(input.certificatePem);
  const certDigest = base64OfHexDigest(certB64);

  const cert = new X509Certificate(input.certificatePem);
  const signingTime = formatSigningTime(input.signingTime ?? new Date());

  // 4. #11 + #9: digest dom4j's asXML() form, encoded base64-of-hex.
  const { digestInput } = buildSignedProperties({
    signingTime,
    certDigest,
    issuerName: javaIssuerName(cert),
    serialNumber: BigInt(`0x${cert.serialNumber}`).toString(10),
  });
  const signedPropertiesDigest = base64OfHexDigest(Buffer.from(digestInput, "utf-8"));

  return {
    invoiceHash,
    invoiceHashBytes,
    signatureValue,
    signatureBytes,
    signedPropertiesDigest,
    certDigest,
    signingTime,
  };
}

/**
 * Java's `X509Certificate.getIssuerDN().getName()` format: RDNs in REVERSE
 * order, comma-space separated — e.g.
 * `CN=TSZEINVOICE-SubCA-1, DC=extgazt, DC=gov, DC=local`.
 *
 * Node exposes the issuer as newline-separated RDNs in forward order, so this
 * reverses and rejoins them.
 */
export function javaIssuerName(cert: X509Certificate): string {
  return cert.issuer.split("\n").map((s) => s.trim()).filter(Boolean).reverse().join(", ");
}
