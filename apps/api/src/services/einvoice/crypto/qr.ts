/**
 * ZATCA QR code — TLV tags 1-9 (M12.3).
 *
 * ── 🔴 BUILT FROM OBSERVED BYTES, NOT THE SPEC (divergence #13) ─────────────
 * An earlier version of this module was written from the PDF's §4 table and was
 * WRONG in three of the four Phase 2 tags. The spec's description of tags 6-9
 * does not match what ZATCA emits. Decoded from a real `fatoora -sign` output,
 * with byte offsets verified:
 *
 *   tag 6   44 bytes   the BASE64 STRING of the invoice hash
 *                      (the spec says "length of hash (SHA256) is 32 bytes"
 *                       and raw digest bytes — explicitly wrong)
 *   tag 7   88 bytes   the SPKI DER public key   (spec says: signature)
 *   tag 8   32 bytes   `r` of the ECDSA signature (spec says: public key)
 *   tag 9   32 bytes   `s` of the ECDSA signature (spec says: ZATCA CA signature)
 *
 * Confirmed against the same document's `SignatureValue`:
 *
 *   3044 0220 0462621b…c4bfb7c  0220 0b15c8cc…574bd404
 *             └─ tag 8 (32B) ─┘       └─ tag 9 (32B) ─┘
 *
 * ⚠️ OPEN, FLAGGED NOT GUESSED: whether the r/s split across tags 8 and 9 is
 * deliberate or an artefact of ZATCA's TLV writer is UNVERIFIED. We emit the
 * observed bytes because ZATCA's validator accepts them; the *intent* must be
 * re-confirmed against the sandbox in M12.4 before anything relies on tag 9
 * meaning "CA signature" for simplified invoices.
 *
 * ── What the spec DID get right ─────────────────────────────────────────────
 * The encoding mechanics for tags 1-5 are correct and still apply:
 *   Tag: one byte. Length: the UTF-8 BYTE length in one byte — byte length, not
 *   character count, so an Arabic seller name must not use `String.length`.
 *   Build the complete byte array first, THEN base64 the whole array once.
 */

import { BusinessRuleError } from "../../../lib/errors";

/** Max encoded length (spec §4.1 — this part is accurate). */
export const QR_MAX_LENGTH = 700;

export interface ZatcaQrFields {
  /** Tag 1 */ sellerName: string;
  /** Tag 2 */ vatNumber: string;
  /** Tag 3 — ISO 8601, e.g. 2026-04-01T09:13:57Z */ invoiceTimestamp: string;
  /** Tag 4 — invoice total INCLUDING VAT */ totalWithVat: string;
  /** Tag 5 — VAT total (business term BT-110) */ vatTotal: string;
  /** Tag 6 — the BASE64 STRING of the invoice hash, not the raw bytes. */
  invoiceHashBase64?: string;
  /** Tag 7 — SPKI DER public key (`publicKey.export({type:"spki",format:"der"})`). */
  publicKeySpkiDer?: Buffer;
  /** Tags 8 + 9 — the DER ECDSA signature; split into r and s here. */
  signatureDer?: Buffer;
}

/** TLV length is one byte, so no field may exceed this. */
export const TLV_MAX_FIELD_BYTES = 255;

/** Human names for the text fields, used in the validation error. */
const FIELD_LABEL: Record<number, string> = {
  1: "seller name",
  2: "VAT registration number",
  3: "invoice timestamp",
  4: "invoice total",
  5: "VAT total",
};

/**
 * Validate the text fields at the INPUT BOUNDARY, before any TLV is built, so
 * the caller gets an actionable 400 naming the offending field rather than a
 * bare throw surfacing as a 500.
 *
 * The realistic trigger is an Arabic company name: UTF-8 Arabic runs ~2 bytes
 * per character (more with diacritics), and `companies.name` permits 255
 * CHARACTERS — so a legitimate name can exceed 255 BYTES. That is a real tenant
 * hitting a real limit, not an edge case, and it deserves a real message.
 */
export function assertQrFieldLengths(fields: ZatcaQrFields): void {
  const texts: [number, string][] = [
    [1, fields.sellerName],
    [2, fields.vatNumber],
    [3, fields.invoiceTimestamp],
    [4, fields.totalWithVat],
    [5, fields.vatTotal],
  ];
  for (const [tag, value] of texts) {
    const bytes = Buffer.byteLength(value ?? "", "utf-8");
    if (bytes > TLV_MAX_FIELD_BYTES) {
      throw new BusinessRuleError(400, {
        error:
          `The ${FIELD_LABEL[tag]} is ${bytes} bytes long, exceeding the ${TLV_MAX_FIELD_BYTES}-byte ` +
          "limit ZATCA's QR code allows for a single field. Note the limit is on BYTES, not " +
          "characters — Arabic text uses roughly two bytes per character. Shorten it in Company Settings.",
        code: "qr_field_too_long",
      });
    }
  }
}

function tlv(tag: number, value: Buffer): Buffer {
  if (value.length > TLV_MAX_FIELD_BYTES) {
    throw new Error(`QR tag ${tag} value is ${value.length} bytes; TLV length must fit in one byte.`);
  }
  return Buffer.concat([Buffer.from([tag, value.length]), value]);
}

const utf8 = (s: string) => Buffer.from(s, "utf-8");

/**
 * Split a DER ECDSA signature into its `r` and `s` components, **verbatim**.
 *
 * DER: `30 <len> 02 <rlen> <r> 02 <slen> <s>`.
 *
 * ⚠️ The integer contents are copied EXACTLY as DER encodes them — sign padding
 * included, length NOT normalised to 32. A DER INTEGER whose high bit is set
 * carries a leading `0x00`, so `r` and `s` are 32 **or 33** bytes depending on
 * the signature.
 *
 * This is not a stylistic choice: ZATCA emits the raw DER integer bytes. An
 * earlier version normalised to a fixed 32 bytes and produced a QR whose tag 8
 * was one byte short of ZATCA's whenever the high bit was set — caught by the
 * tag-for-tag differential against a real ZATCA QR, which is precisely the check
 * that comparing against the PDF would never have made.
 */
export function splitEcdsaDer(der: Buffer): { r: Buffer; s: Buffer } {
  if (der[0] !== 0x30) throw new Error("Not a DER SEQUENCE ECDSA signature.");
  let o = 2;
  // Long-form length on the outer SEQUENCE.
  if (der[1] & 0x80) o = 2 + (der[1] & 0x7f);

  const read = (): Buffer => {
    if (der[o] !== 0x02) throw new Error("Expected a DER INTEGER in the ECDSA signature.");
    const len = der[o + 1];
    const v = der.subarray(o + 2, o + 2 + len);
    o += 2 + len;
    return v;
  };
  return { r: read(), s: read() };
}

/**
 * Build the QR payload.
 *
 * Tags 6-9 are emitted only when their inputs are present; omitting them yields
 * the Phase 1 (tags 1-5) payload, which is valid only for a draft preview and
 * never for issuance.
 */
export function buildZatcaQr(fields: ZatcaQrFields): string {
  assertQrFieldLengths(fields);

  const parts: Buffer[] = [
    tlv(1, utf8(fields.sellerName)),
    tlv(2, utf8(fields.vatNumber)),
    tlv(3, utf8(fields.invoiceTimestamp)),
    tlv(4, utf8(fields.totalWithVat)),
    tlv(5, utf8(fields.vatTotal)),
  ];

  // Tag 6 is the base64 STRING, encoded as UTF-8 text like tags 1-5.
  if (fields.invoiceHashBase64) parts.push(tlv(6, utf8(fields.invoiceHashBase64)));
  if (fields.publicKeySpkiDer) parts.push(tlv(7, fields.publicKeySpkiDer));
  if (fields.signatureDer) {
    const { r, s } = splitEcdsaDer(fields.signatureDer);
    parts.push(tlv(8, r));
    parts.push(tlv(9, s));
  }

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
