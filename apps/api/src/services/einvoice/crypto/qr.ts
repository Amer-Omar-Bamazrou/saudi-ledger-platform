/**
 * ZATCA QR code — TLV tags 1-9.
 *
 * ── 🔴 VERIFIED AGAINST THE LIVE COMPLIANCE API (M12.4) ─────────────────────
 * This module has now been wrong twice, from two different sources, and is
 * finally pinned by ZATCA's own validator returning PASS with zero errors and
 * zero warnings. Read this history before changing anything here.
 *
 *   1. M12.3 first wrote tags 6-9 from the PDF          → WRONG (3 of 4 tags)
 *   2. M12.3 then rewrote them from decompiled SDK bytes → ALSO WRONG (7/8/9)
 *   3. M12.4 determined them from live API responses     → PASS
 *
 * The SDK differential in step 2 passed byte-for-byte against `fatoora -sign`,
 * which proved only that we matched a **stale 2021-era writer**. The live API is
 * the authority: LIVE API > SDK > PDF.
 *
 * ── The layout, each element pinned by a live rejection ─────────────────────
 *
 *   tag 3   19 bytes   `YYYY-MM-DDTHH:MM:SS` — 🔴 NO trailing `Z`.
 *                      A `Z` warns `invoiceTimeStamp_QRCODE_INVALID` because it
 *                      disagrees with the XML's `cbc:IssueTime`, which carries no
 *                      timezone designator. Stripping milliseconds is NOT enough;
 *                      that was tested separately and still warned.
 *   tag 6   44 bytes   the BASE64 STRING of the invoice hash.
 *                      (The PDF says raw 32-byte digest — genuinely wrong; this
 *                       is the one part of the old reading that held.)
 *   tag 7   96 bytes   the BASE64 STRING of the signature — the same value the
 *                      document carries in `SignatureValue`.
 *                      Raw DER here → `INVOICE_SIGNATURE_VALUE_QRCODE_INVALID`.
 *   tag 8   88 bytes   the SPKI DER public key, RAW BYTES.
 *                      base64 here → `publicKey_QRCODE_INVALID`.
 *   tag 9   ~71 bytes  the CA's signature over the certificate
 *                      (`Certificate.signatureValue`), RAW BYTES.
 *                      base64 here → `CERTIFICATE_SIGNATURE_QRCODE_INVALID`.
 *
 * Note ZATCA mixes encodings deliberately: tags 6 and 7 are base64 STRINGS while
 * 8 and 9 are raw bytes. That is not a mistake in this file — it was verified in
 * both directions, and the "consistent" all-base64 variant fails.
 *
 * 🔴 tag 9 is NOT part of our signature. The old reading put `s` there; it is the
 * ZATCA CA's signature on the certificate, so it comes from the cert, not the key.
 *
 * ── Encoding mechanics (tags 1-5, unchanged and correct) ────────────────────
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
  /** Tag 7 — the BASE64 STRING of the signature (the document's SignatureValue). */
  signatureBase64?: string;
  /** Tag 8 — SPKI DER public key, RAW (`publicKey.export({type:"spki",format:"der"})`). */
  publicKeySpkiDer?: Buffer;
  /** Tag 9 — the CA's signature over the certificate, RAW. Not ours to compute. */
  certificateSignature?: Buffer;
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
 * 🔴 `splitEcdsaDer` was DELETED in M12.4, deliberately.
 *
 * It existed only to split the signature into `r`/`s` for tags 8 and 9 — a
 * layout ZATCA's live validator rejects (`publicKey_QRCODE_INVALID` +
 * `CERTIFICATE_SIGNATURE_QRCODE_INVALID`). Tag 8 is the public key and tag 9 is
 * the CA's signature over the certificate; neither is derived from our
 * signature. The helper is gone rather than left unused so the disproven
 * approach cannot be reintroduced by someone reaching for a convenient utility.
 */

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

  // Tags 6 and 7 are base64 STRINGS (UTF-8 text, like tags 1-5); tags 8 and 9
  // are RAW bytes. The mixed encoding is ZATCA's, and was verified both ways.
  if (fields.invoiceHashBase64) parts.push(tlv(6, utf8(fields.invoiceHashBase64)));
  if (fields.signatureBase64) parts.push(tlv(7, utf8(fields.signatureBase64)));
  if (fields.publicKeySpkiDer) parts.push(tlv(8, fields.publicKeySpkiDer));
  if (fields.certificateSignature) parts.push(tlv(9, fields.certificateSignature));

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
