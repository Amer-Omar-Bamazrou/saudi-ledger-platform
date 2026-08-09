/**
 * Mint a minimal self-signed X.509 certificate over a given key pair — TEST ONLY.
 *
 * Why this exists: `activateCredential` (M12.4) refuses any certificate whose
 * public key is not the credential's own. That guard is correct — it is what
 * catches ZATCA's sandbox handing out a shared canned certificate — but it means
 * tests can no longer use a placeholder PEM. They need a REAL certificate that
 * genuinely binds the key under test.
 *
 * Built with `@peculiar/asn1-x509` (already a dependency) rather than
 * `@peculiar/x509`, which needs a `reflect-metadata` polyfill this repo does not
 * carry.
 */
import { AsnConvert } from "@peculiar/asn1-schema";
import {
  AlgorithmIdentifier,
  AttributeTypeAndValue,
  AttributeValue,
  Certificate,
  Name,
  RelativeDistinguishedName,
  SubjectPublicKeyInfo,
  TBSCertificate,
  Validity,
} from "@peculiar/asn1-x509";
import { createSign, type KeyObject } from "node:crypto";

const ECDSA_WITH_SHA256 = "1.2.840.10045.4.3.2";
const OID_CN = "2.5.4.3";

function name(commonName: string): Name {
  return new Name([
    new RelativeDistinguishedName([
      new AttributeTypeAndValue({
        type: OID_CN,
        value: new AttributeValue({ utf8String: commonName }),
      }),
    ]),
  ]);
}

export interface SelfSignedOptions {
  commonName?: string;
  notBefore?: Date;
  notAfter?: Date;
}

/** A PEM certificate whose SubjectPublicKeyInfo is exactly `publicKey`. */
export function selfSignedCertificate(
  privateKey: KeyObject,
  publicKey: KeyObject,
  options: SelfSignedOptions = {},
): string {
  const commonName = options.commonName ?? "TEST-EGS-UNIT";
  const notBefore = options.notBefore ?? new Date("2026-08-09T00:00:00Z");
  const notAfter = options.notAfter ?? new Date("2031-08-08T21:00:00Z");

  const spkiDer = publicKey.export({ type: "spki", format: "der" }) as Buffer;

  const tbs = new TBSCertificate({
    version: 2, // v3
    serialNumber: new Uint8Array([0x01]).buffer,
    signature: new AlgorithmIdentifier({ algorithm: ECDSA_WITH_SHA256 }),
    issuer: name(commonName),
    validity: new Validity({ notBefore, notAfter }),
    subject: name(commonName),
    subjectPublicKeyInfo: AsnConvert.parse(spkiDer, SubjectPublicKeyInfo),
  });

  const tbsDer = Buffer.from(AsnConvert.serialize(tbs));
  const signature = createSign("sha256").update(tbsDer).sign(privateKey);

  const cert = new Certificate({
    tbsCertificate: tbs,
    signatureAlgorithm: new AlgorithmIdentifier({ algorithm: ECDSA_WITH_SHA256 }),
    signatureValue: signature.buffer.slice(
      signature.byteOffset,
      signature.byteOffset + signature.byteLength,
    ) as ArrayBuffer,
  });

  const der = Buffer.from(AsnConvert.serialize(cert));
  const b64 = der.toString("base64").replace(/(.{64})/g, "$1\n");
  return `-----BEGIN CERTIFICATE-----\n${b64}${b64.endsWith("\n") ? "" : "\n"}-----END CERTIFICATE-----\n`;
}
