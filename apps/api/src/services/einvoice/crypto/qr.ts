/**
 * ZATCA QR code — TLV tags 1-9 (M12.3).
 *
 * Tags 1-5 have been mandatory since 4 Dec 2021 (Phase 1); tags 6-9 since
 * 1 Jan 2023 (Phase 2).
 *
 * ── The encoding rules, quoted from the spec §4.1 ───────────────────────────
 *   Tag:    the tag value stored in ONE byte.
 *   Tags 1-5 length: "the length of the byte array resulted from the UTF8
 *                     encoding of the field value", stored in one byte.
 *   Tag 6 length:    "length of hash (SHA256) is 32 bytes", and the value is
 *                    the RAW digest bytes — not hex, not base64.
 *   Order of operations: build the complete byte array FIRST, then Base64 the
 *                    whole array, then render the QR image.
 *
 * Two traps live in those rules:
 *   1. **UTF-8 BYTE length, not character count.** An Arabic seller name is
 *      multi-byte; using `String.length` produces a corrupt TLV that decodes
 *      into garbage. `Buffer.byteLength` is the only correct source.
 *   2. **Per-field base64 is wrong.** Base64 is applied once, to the finished
 *      byte array.
 */

/** Max encoded length (spec §4.1: "encoded in Base64 format with up to 700 characters"). */
export const QR_MAX_LENGTH = 700;

export interface ZatcaQrFields {
  /** Tag 1 */ sellerName: string;
  /** Tag 2 */ vatNumber: string;
  /** Tag 3 — ISO 8601, e.g. 2022-02-21T12:13:57Z */ invoiceTimestamp: string;
  /** Tag 4 — invoice total INCLUDING VAT */ totalWithVat: string;
  /** Tag 5 — VAT total (business term BT-110) */ vatTotal: string;
  /** Tag 6 — RAW 32-byte SHA-256 of the canonicalised XML */ invoiceHashBytes?: Buffer;
  /** Tag 7 — ECDSA signature over the invoice hash */ signatureBytes?: Buffer;
  /** Tag 8 — raw ECDSA public key point */ publicKeyBytes?: Buffer;
  /**
   * Tag 9 — SIMPLIFIED invoices and their notes ONLY: the ECDSA signature of
   * the cryptographic stamp issued by ZATCA's technical CA (i.e. the signature
   * over the certificate itself).
   */
  zatcaCertSignatureBytes?: Buffer;
}

/**
 * One TLV triple.
 *
 * `value` is taken as bytes. For text fields the caller passes the UTF-8 buffer
 * so the length byte is unambiguously the BYTE length.
 */
function tlv(tag: number, value: Buffer): Buffer {
  if (value.length > 255) {
    throw new Error(`QR tag ${tag} value is ${value.length} bytes; TLV length must fit in one byte.`);
  }
  return Buffer.concat([Buffer.from([tag, value.length]), value]);
}

const utf8 = (s: string) => Buffer.from(s, "utf-8");

/**
 * Build the Phase 2 QR payload.
 *
 * Tags 6-8 are omitted when their inputs are absent, which yields the Phase 1
 * (tags 1-5) payload — used only for a draft preview, never for issuance.
 */
export function buildZatcaQr(fields: ZatcaQrFields): string {
  const parts: Buffer[] = [
    tlv(1, utf8(fields.sellerName)),
    tlv(2, utf8(fields.vatNumber)),
    tlv(3, utf8(fields.invoiceTimestamp)),
    tlv(4, utf8(fields.totalWithVat)),
    tlv(5, utf8(fields.vatTotal)),
  ];

  // Tag 6 carries the RAW digest bytes (32), not a hex or base64 string.
  if (fields.invoiceHashBytes) parts.push(tlv(6, fields.invoiceHashBytes));
  if (fields.signatureBytes) parts.push(tlv(7, fields.signatureBytes));
  if (fields.publicKeyBytes) parts.push(tlv(8, fields.publicKeyBytes));
  // Tag 9 is simplified-only; the caller decides by passing it or not.
  if (fields.zatcaCertSignatureBytes) parts.push(tlv(9, fields.zatcaCertSignatureBytes));

  // Build the WHOLE byte array first, THEN base64 it — once.
  const encoded = Buffer.concat(parts).toString("base64");

  if (encoded.length > QR_MAX_LENGTH) {
    throw new Error(
      `ZATCA QR payload is ${encoded.length} characters, exceeding the ${QR_MAX_LENGTH}-character limit.`,
    );
  }
  return encoded;
}

/** Decode a TLV payload back to { tag: bytes } — used by the tests. */
export function decodeZatcaQr(base64: string): Record<number, Buffer> {
  const buf = Buffer.from(base64, "base64");
  const out: Record<number, Buffer> = {};
  let i = 0;
  while (i + 2 <= buf.length) {
    const tag = buf[i];
    const len = buf[i + 1];
    out[tag] = buf.subarray(i + 2, i + 2 + len);
    i += 2 + len;
  }
  return out;
}
