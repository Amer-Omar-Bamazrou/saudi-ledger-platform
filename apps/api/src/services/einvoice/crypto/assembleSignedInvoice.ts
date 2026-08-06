/**
 * Assemble the signed ZATCA invoice (M12.3).
 *
 * Injects the three elements M12.2 deliberately left out — the ones ZATCA's
 * transform excludes from the signature:
 *
 *   ext:UBLExtensions                              (first child of Invoice)
 *   cac:AdditionalDocumentReference[cbc:ID='QR']   (after ICV and PIH)
 *   cac:Signature                                  (immediately before
 *                                                   cac:AccountingSupplierParty)
 *
 * Placement is taken from a real `fatoora -sign` output, not guessed. The
 * UBLExtensions block is ZATCA's own `xml/ubl.xml` template with values filled
 * in; its indentation is preserved because the SignedProperties digest is
 * computed over that exact text (divergence #11).
 */
import { buildSignedProperties, signInvoice, certificateBase64, javaIssuerName } from "./xades";
import { buildZatcaQr } from "./qr";
import { X509Certificate, type KeyObject } from "crypto";

const C14N_URI = "http://www.w3.org/2006/12/xml-c14n11";
const XPATH_URI = "http://www.w3.org/TR/1999/REC-xpath-19991116";
const SHA256_URI = "http://www.w3.org/2001/04/xmlenc#sha256";
const ECDSA_URI = "http://www.w3.org/2001/04/xmldsig-more#ecdsa-sha256";

/** ZATCA's UBLExtensions block, matching `xml/ubl.xml` including indentation. */
function ublExtensions(v: {
  invoiceDigest: string;
  signedPropertiesDigest: string;
  signatureValue: string;
  certificateBase64: string;
  signedProperties: string;
}): string {
  return `<ext:UBLExtensions>
    <ext:UBLExtension>
        <ext:ExtensionURI>urn:oasis:names:specification:ubl:dsig:enveloped:xades</ext:ExtensionURI>
        <ext:ExtensionContent>
            <sig:UBLDocumentSignatures xmlns:sig="urn:oasis:names:specification:ubl:schema:xsd:CommonSignatureComponents-2" xmlns:sac="urn:oasis:names:specification:ubl:schema:xsd:SignatureAggregateComponents-2" xmlns:sbc="urn:oasis:names:specification:ubl:schema:xsd:SignatureBasicComponents-2">
                <sac:SignatureInformation>
                    <cbc:ID>urn:oasis:names:specification:ubl:signature:1</cbc:ID>
                    <sbc:ReferencedSignatureID>urn:oasis:names:specification:ubl:signature:Invoice</sbc:ReferencedSignatureID>
                    <ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#" Id="signature">
                        <ds:SignedInfo>
                            <ds:CanonicalizationMethod Algorithm="${C14N_URI}"/>
                            <ds:SignatureMethod Algorithm="${ECDSA_URI}"/>
                            <ds:Reference Id="invoiceSignedData" URI="">
                                <ds:Transforms>
                                    <ds:Transform Algorithm="${XPATH_URI}">
                                        <ds:XPath>not(//ancestor-or-self::ext:UBLExtensions)</ds:XPath>
                                    </ds:Transform>
                                    <ds:Transform Algorithm="${XPATH_URI}">
                                        <ds:XPath>not(//ancestor-or-self::cac:Signature)</ds:XPath>
                                    </ds:Transform>
                                    <ds:Transform Algorithm="${XPATH_URI}">
                                        <ds:XPath>not(//ancestor-or-self::cac:AdditionalDocumentReference[cbc:ID='QR'])</ds:XPath>
                                    </ds:Transform>
                                    <ds:Transform Algorithm="${C14N_URI}"/>
                                </ds:Transforms>
                                <ds:DigestMethod Algorithm="${SHA256_URI}"/>
                                <ds:DigestValue>${v.invoiceDigest}</ds:DigestValue>
                            </ds:Reference>
                            <ds:Reference Type="http://www.w3.org/2000/09/xmldsig#SignatureProperties" URI="#xadesSignedProperties">
                                <ds:DigestMethod Algorithm="${SHA256_URI}"/>
                                <ds:DigestValue>${v.signedPropertiesDigest}</ds:DigestValue>
                            </ds:Reference>
                        </ds:SignedInfo>
                        <ds:SignatureValue>${v.signatureValue}</ds:SignatureValue>
                        <ds:KeyInfo>
                            <ds:X509Data>
                                <ds:X509Certificate>${v.certificateBase64}</ds:X509Certificate>
                            </ds:X509Data>
                        </ds:KeyInfo>
                        <ds:Object>
                            <xades:QualifyingProperties xmlns:xades="http://uri.etsi.org/01903/v1.3.2#" Target="signature">
                                ${v.signedProperties}
                            </xades:QualifyingProperties>
                        </ds:Object>
                    </ds:Signature>
                </sac:SignatureInformation>
            </sig:UBLDocumentSignatures>
        </ext:ExtensionContent>
    </ext:UBLExtension>
</ext:UBLExtensions>`;
}

const QR_REFERENCE = (qr: string) => `<cac:AdditionalDocumentReference>
    <cbc:ID>QR</cbc:ID>
    <cac:Attachment>
        <cbc:EmbeddedDocumentBinaryObject mimeCode="text/plain">${qr}</cbc:EmbeddedDocumentBinaryObject>
    </cac:Attachment>
</cac:AdditionalDocumentReference>`;

const SIGNATURE_REFERENCE = `<cac:Signature>
    <cbc:ID>urn:oasis:names:specification:ubl:signature:Invoice</cbc:ID>
    <cbc:SignatureMethod>urn:oasis:names:specification:ubl:dsig:enveloped:xades</cbc:SignatureMethod>
</cac:Signature>`;

export interface AssembleInput {
  /** The unsigned UBL from M12.2. */
  xml: string;
  certificatePem: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
  /** QR tags 1-5 come from the invoice, not re-derived from the XML. */
  qr: { sellerName: string; vatNumber: string; timestamp: string; totalWithVat: string; vatTotal: string };
  signingTime?: Date;
}

export interface AssembledInvoice {
  signedXml: string;
  invoiceHash: string;
  qrCode: string;
  signatureValue: string;
  signingTime: string;
}

/** Sign an unsigned UBL invoice and return the complete signed document. */
export function assembleSignedInvoice(input: AssembleInput): AssembledInvoice {
  const signed = signInvoice({
    xml: input.xml,
    certificatePem: input.certificatePem,
    privateKey: input.privateKey,
    signingTime: input.signingTime,
  });

  const cert = new X509Certificate(input.certificatePem);
  const certB64 = certificateBase64(input.certificatePem);

  // Rebuild the document form of SignedProperties with the same inputs the
  // digest was taken over, so the two cannot drift.
  const { document: signedProperties } = buildSignedProperties({
    signingTime: signed.signingTime,
    certDigest: signed.certDigest,
    issuerName: javaIssuerName(cert),
    serialNumber: BigInt(`0x${cert.serialNumber}`).toString(10),
  });

  // Divergence #13: tag 6 is the base64 STRING, tag 7 the SPKI DER public key,
  // tags 8/9 the r and s of the signature.
  const qrCode = buildZatcaQr({
    sellerName: input.qr.sellerName,
    vatNumber: input.qr.vatNumber,
    invoiceTimestamp: input.qr.timestamp,
    totalWithVat: input.qr.totalWithVat,
    vatTotal: input.qr.vatTotal,
    invoiceHashBase64: signed.invoiceHash,
    publicKeySpkiDer: input.publicKey.export({ type: "spki", format: "der" }) as Buffer,
    signatureDer: signed.signatureBytes,
  });

  const extensions = ublExtensions({
    invoiceDigest: signed.invoiceHash,
    signedPropertiesDigest: signed.signedPropertiesDigest,
    signatureValue: signed.signatureValue,
    certificateBase64: certB64,
    signedProperties,
  });

  // ── Injection, in ZATCA's confirmed order ────────────────────────────────
  let xml = input.xml;

  // 1. UBLExtensions as the FIRST child of <Invoice>.
  xml = xml.replace(/(<Invoice[^>]*>)/, `$1${extensions}`);

  // 2. The QR reference AFTER the PIH AdditionalDocumentReference.
  const pihEnd = xml.indexOf("</cac:AdditionalDocumentReference>", xml.indexOf("<cbc:ID>PIH</cbc:ID>"));
  const insertAt = pihEnd + "</cac:AdditionalDocumentReference>".length;
  xml = xml.slice(0, insertAt) + QR_REFERENCE(qrCode) + xml.slice(insertAt);

  // 3. cac:Signature immediately before cac:AccountingSupplierParty.
  xml = xml.replace("<cac:AccountingSupplierParty>", `${SIGNATURE_REFERENCE}<cac:AccountingSupplierParty>`);

  return {
    signedXml: xml,
    invoiceHash: signed.invoiceHash,
    qrCode,
    signatureValue: signed.signatureValue,
    signingTime: signed.signingTime,
  };
}
