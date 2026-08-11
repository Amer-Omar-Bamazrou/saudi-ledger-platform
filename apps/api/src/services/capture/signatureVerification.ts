/**
 * Verify a supplier invoice's ZATCA Phase 2 signature (A1).
 *
 * ── 🔴 WHY THIS IS SERVER-SIDE, AND WHY IT MATTERS MORE THAN IT LOOKS ──────
 * A ZATCA Phase 2 QR carries the invoice hash (tag 6), the signature (tag 7),
 * the signing public key (tag 8) and the CA's signature over the certificate
 * (tag 9). Together they let us answer a question OCR cannot answer at any
 * price: **is this supplier invoice genuine?**
 *
 * That question is about the customer's **money**, not their time. ZATCA will
 * not accept an input-VAT deduction against a fabricated invoice, so a forged
 * or altered document that the customer books in good faith becomes a rejected
 * deduction and a penalty — discovered months later, at audit.
 *
 * It is server-side because **a client-side verdict is worth nothing**: it can
 * be faked by anyone who can edit a request, and it would be the platform
 * asserting something about money on the strength of the claimant's own
 * arithmetic.
 *
 * ── What a FAILED verification means ───────────────────────────────────────
 * The document is not what it claims to be. That is the one case in document
 * capture where the system knows something the user **cannot possibly know by
 * looking** — the invoice looks perfectly normal. So it is surfaced
 * prominently, not as one flag among many.
 *
 * The user may still proceed: we do not know their supplier relationship, and a
 * verification failure can have dull causes (a re-printed copy, a vendor's
 * broken implementation). But the override is deliberate and recorded.
 */
import { createHash, createPublicKey, createVerify } from "node:crypto";
import { QR_TAG, decodeTlv, utf8String } from "@workspace/zatca-tlv";

export type SignatureStatus = "unsigned" | "verified" | "failed" | "error";

export interface SignatureVerdict {
  status: SignatureStatus;
  /** Human-readable, safe to show. Never contains key material. */
  detail: string;
}

/**
 * Verify the ECDSA signature over the invoice hash.
 *
 * Deliberately narrow: it proves the signature in tag 7 was produced by the key
 * in tag 8 over the hash in tag 6.
 *
 * 🔴 What it does NOT prove, stated so nobody over-reads a "verified":
 *   - that the KEY belongs to the supplier it claims to (that needs the CA
 *     chain in tag 9 checked against ZATCA's root, which we do not hold);
 *   - that the invoice was actually cleared or reported to ZATCA.
 * It proves the document is internally consistent and unaltered since signing —
 * which is what catches a tampered total, the realistic fraud.
 */
export function verifyQrSignature(payloadBase64: string): SignatureVerdict {
  try {
    const decoded = decodeTlv(payloadBase64);

    if (!decoded.isPhase2) {
      return {
        status: "unsigned",
        detail:
          "This invoice carries a Phase 1 QR code, which has no signature. Nothing to verify — " +
          "that is normal for suppliers who have not yet moved to ZATCA Phase 2.",
      };
    }

    const hashB64 = decoded.tags.get(QR_TAG.INVOICE_HASH);
    const sigB64 = decoded.tags.get(QR_TAG.SIGNATURE);
    const spki = decoded.tags.get(QR_TAG.PUBLIC_KEY);
    if (!hashB64 || !sigB64 || !spki) {
      return { status: "error", detail: "The QR code is missing one of the signature fields." };
    }

    // Tags 6 and 7 are base64 STRINGS; tag 8 is RAW BYTES. Divergence #13 —
    // getting this wrong is why the QR was rejected twice before live responses
    // settled it. The shared codec preserves the distinction; this must too.
    const invoiceHash = Buffer.from(utf8String(hashB64), "base64");
    const signature = Buffer.from(utf8String(sigB64), "base64");

    const publicKey = createPublicKey({
      key: Buffer.from(spki),
      format: "der",
      type: "spki",
    });

    // ZATCA signs the invoice hash with ECDSA/SHA-256. The hash is already the
    // digest, so it is verified as the message — matching how it was signed.
    const verifier = createVerify("SHA256");
    verifier.update(invoiceHash);
    verifier.end();

    const ok = verifier.verify({ key: publicKey, dsaEncoding: "der" }, signature);

    return ok
      ? {
          status: "verified",
          detail:
            "The supplier's cryptographic signature is valid: this invoice has not been altered " +
            "since it was issued.",
        }
      : {
          status: "failed",
          detail:
            "The supplier's cryptographic signature does NOT match this invoice. The document may " +
            "have been altered after it was issued, or it may not be a genuine e-invoice.",
        };
  } catch (err) {
    // Never throw: a supplier's odd document must not fail the whole capture.
    return {
      status: "error",
      detail: `The signature could not be checked (${err instanceof Error ? err.name : "unknown error"}).`,
    };
  }
}

/** SHA-256 of the stored bytes — detects later alteration of the file itself. */
export function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
