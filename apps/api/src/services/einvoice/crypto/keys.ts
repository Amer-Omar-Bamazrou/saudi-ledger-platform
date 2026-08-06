/**
 * ECDSA key material for ZATCA (M12.3).
 *
 * ── 🔴 THE CURVE IS secp256k1, NOT P-256 ────────────────────────────────────
 * The Security Standards PDF's *normative* requirement names no curve ("key
 * length shall be 256"); "P-256" appears only in a table the spec itself labels
 * **illustrative**. ZATCA's actual implementation is `secp256k1`, proven three
 * ways from their own binaries: their SDK ships `ec-secp256k1-priv-key.pem`,
 * `com/zatca/sdk/util/ECDSAUtil.class` contains the literal string
 * `secp256k1`, and the shipped key's DER carries OID **1.3.132.0.10**. A P-256
 * CSR is rejected — and only at M12.4, after the whole crypto layer is built.
 *
 * ── Why node:crypto and not WebCrypto ───────────────────────────────────────
 * **WebCrypto does not support secp256k1** (`Unrecognized namedCurve`), which
 * rules out `@peculiar/x509`'s high-level generators. Node's classic `crypto`
 * API does support it, so keys are generated and signatures produced there,
 * while ASN.1/DER encoding is left to `@peculiar/asn1-*`.
 *
 * ── 🔴 KEYS ARE NEVER PERSISTED IN M12.3 ────────────────────────────────────
 * This module generates and returns key material in memory only. There is
 * deliberately NO storage path until the M12.5 KMS-encrypted, owner-only vault
 * exists — a signer with nowhere to put keys is safer than keys in a
 * provisional home, because provisional homes become permanent.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from "crypto";

/** The one curve ZATCA accepts. */
export const ZATCA_CURVE = "secp256k1";
/** OID 1.3.132.0.10 — used to verify a key really is on the right curve. */
const SECP256K1_OID_DER = Buffer.from([0x2b, 0x81, 0x04, 0x00, 0x0a]);

export interface ZatcaKeyPair {
  privateKey: KeyObject;
  publicKey: KeyObject;
  /** PEM (PKCS#8) — for handing to the M12.5 vault. Never log this. */
  privateKeyPem: string;
  publicKeyPem: string;
}

/** Generate a fresh secp256k1 key pair. */
export function generateZatcaKeyPair(): ZatcaKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: ZATCA_CURVE });
  return {
    privateKey,
    publicKey,
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

/** Load a private key from PEM and assert it is on the ZATCA curve. */
export function loadPrivateKey(pem: string): KeyObject {
  const key = createPrivateKey(pem);
  assertZatcaCurve(key);
  return key;
}

export function publicKeyFromPrivate(privateKey: KeyObject): KeyObject {
  return createPublicKey(privateKey);
}

/**
 * Fail loudly if a key is not on secp256k1.
 *
 * Checks the DER-encoded curve OID rather than trusting
 * `asymmetricKeyDetails.namedCurve`, so an alias or a differently-labelled
 * P-256 key cannot slip through and produce signatures ZATCA silently rejects.
 */
export function assertZatcaCurve(key: KeyObject): void {
  const named = key.asymmetricKeyDetails?.namedCurve;
  const der = key.export({ type: key.type === "private" ? "pkcs8" : "spki", format: "der" }) as Buffer;
  if (named !== ZATCA_CURVE || !der.includes(SECP256K1_OID_DER)) {
    throw new Error(
      `Refusing to use a non-${ZATCA_CURVE} key (got "${named ?? "unknown"}"). ` +
        "ZATCA requires secp256k1; P-256 keys are rejected by their CA. " +
        "See services/einvoice/crypto/keys.ts.",
    );
  }
}

/**
 * The raw 64-byte (r‖s) public key point, minus the 0x04 uncompressed prefix —
 * the form QR **tag 8** carries.
 */
export function publicKeyRawBytes(publicKey: KeyObject): Buffer {
  const der = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  // The SPKI BIT STRING payload ends with the uncompressed point (0x04 ‖ X ‖ Y).
  const idx = der.lastIndexOf(0x04, der.length - 65);
  return der.subarray(idx + 1);
}
