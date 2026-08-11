/**
 * ZATCA QR TLV — the shared encoder/decoder (A1).
 *
 * ── 🔴 WHY THIS IS A SHARED PACKAGE AND NOT COPIED ─────────────────────────
 * This layout is the single most carefully-verified thing in this repository.
 * It was written from the specification and was **wrong in three of four Phase 2
 * tags**. It was rewritten from decoded SDK bytes and was **still wrong**, in
 * tags 3, 7, 8 and 9. It only became correct when determined from live
 * `/compliance/invoices` responses. See
 * `docs/zatca/spec-vs-implementation-divergences.md` — thirteen divergences,
 * every one found by running or decompiling ZATCA's software rather than reading
 * their PDF.
 *
 * A1 needs to DECODE these payloads in the browser (reading a supplier's invoice
 * QR) as well as ENCODE them on the server (issuing our own). Copying the logic
 * browser-side would create a second place for those thirteen divergences to be
 * got wrong — and it would drift **silently**, because only the server copy is
 * covered by the ZATCA compliance tests. One implementation, both sides.
 *
 * ── Portability: Uint8Array, not Buffer ────────────────────────────────────
 * `Buffer` is Node-only. Everything here is expressed in `Uint8Array` and
 * `TextEncoder`/`TextDecoder`, which exist in both runtimes. A Node caller may
 * pass a `Buffer` — it IS a `Uint8Array` — and gets plain `Uint8Array` back.
 * There are deliberately no dependencies.
 */

/** ZATCA caps the base64 QR payload. */
export const QR_MAX_LENGTH = 700;

/** TLV length is one byte, so no field may exceed this. */
export const TLV_MAX_FIELD_BYTES = 255;

/**
 * The nine tags.
 *
 * 1–5 are Phase 1 and are always present. 6–9 are Phase 2 and appear only on a
 * cryptographically stamped document — which is what makes tag 7's presence the
 * signal that a supplier invoice can be VERIFIED rather than merely read.
 */
export const QR_TAG = {
  SELLER_NAME: 1,
  VAT_NUMBER: 2,
  TIMESTAMP: 3,
  TOTAL_WITH_VAT: 4,
  VAT_TOTAL: 5,
  INVOICE_HASH: 6,
  SIGNATURE: 7,
  PUBLIC_KEY: 8,
  CERTIFICATE_SIGNATURE: 9,
} as const;

export const QR_TAG_LABEL: Record<number, string> = {
  1: "seller name",
  2: "VAT registration number",
  3: "invoice timestamp",
  4: "total including VAT",
  5: "VAT total",
  6: "invoice hash",
  7: "cryptographic signature",
  8: "public key",
  9: "certificate signature",
};

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: false });

export const utf8Bytes = (s: string): Uint8Array => encoder.encode(s);
export const utf8String = (b: Uint8Array): string => decoder.decode(b);

/** One TLV triplet: tag, one-byte length, value. */
export function tlv(tag: number, value: Uint8Array): Uint8Array {
  if (value.length > TLV_MAX_FIELD_BYTES) {
    throw new Error(`QR tag ${tag} value is ${value.length} bytes; TLV length must fit in one byte.`);
  }
  const out = new Uint8Array(2 + value.length);
  out[0] = tag;
  out[1] = value.length;
  out.set(value, 2);
  return out;
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// ── base64, without Buffer ──────────────────────────────────────────────────
// `btoa`/`atob` exist in browsers and in modern Node. Node's Buffer is faster
// but is not available in the browser, and correctness matters more than speed
// for a payload capped at 700 characters.

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return typeof btoa === "function"
    ? btoa(bin)
    : // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).Buffer.from(bytes).toString("base64");
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin =
    typeof atob === "function"
      ? atob(b64)
      : // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (globalThis as any).Buffer.from(b64, "base64").toString("binary");
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/** A decoded payload: raw bytes per tag, plus the tag order as encountered. */
export interface DecodedQr {
  tags: Map<number, Uint8Array>;
  /** Tags in the order they appeared — a malformed or reordered payload is visible. */
  order: number[];
  /** True when tags 6–9 are present, i.e. a cryptographically stamped document. */
  isPhase2: boolean;
  /**
   * Tags whose declared length ran past the end of the payload.
   *
   * 🔴 These are EXCLUDED from `tags` on purpose. A truncated value is not a
   * shorter value — `"150.00"` clipped to `"15"` is a perfectly plausible
   * amount that is wrong by a factor of ten. Returning it would put a silently
   * incorrect money figure in front of a user who has no way to know. Better to
   * report the field as absent and fall back to OCR.
   */
  truncated: number[];
}

/**
 * Decode a base64 TLV payload.
 *
 * 🔴 **Lenient by design, and it must report rather than throw.** This decodes
 * documents produced by OTHER people's software — every ZATCA solution vendor in
 * Saudi Arabia. A payload that is truncated, padded, or carries an unknown tag
 * must yield what it can with the problem visible, not an exception that loses
 * the fields that WERE readable. The caller decides what a partial read means.
 *
 * Throwing here would mean a single odd supplier invoice fails capture entirely
 * rather than falling back to OCR.
 */
export function decodeTlv(base64: string): DecodedQr {
  const buf = base64ToBytes(base64);
  const tags = new Map<number, Uint8Array>();
  const order: number[] = [];

  const truncated: number[] = [];

  let i = 0;
  while (i + 2 <= buf.length) {
    const tag = buf[i];
    const len = buf[i + 1];
    const end = i + 2 + len;

    if (end > buf.length) {
      // 🔴 The declared length runs past the payload. Record the tag as
      // truncated and DO NOT expose a partial value — see `DecodedQr.truncated`.
      // Earlier tags already read stay readable, which is the leniency that
      // matters; handing back half a number is not leniency, it is a wrong
      // answer wearing a right answer's shape.
      if (!truncated.includes(tag)) truncated.push(tag);
      break;
    }

    if (!tags.has(tag)) order.push(tag);
    tags.set(tag, buf.subarray(i + 2, end));
    i = end;
  }

  return {
    tags,
    order,
    isPhase2: tags.has(QR_TAG.INVOICE_HASH) && tags.has(QR_TAG.SIGNATURE),
    truncated,
  };
}

/** The five Phase 1 fields, as text. */
export interface ZatcaQrPhase1 {
  sellerName: string;
  vatNumber: string;
  /** ZATCA's timestamp, verbatim — deliberately NOT parsed here (see below). */
  invoiceTimestamp: string;
  totalWithVat: string;
  vatTotal: string;
}

/**
 * Read the Phase 1 fields from a decoded payload.
 *
 * 🔴 `invoiceTimestamp` is returned VERBATIM and is not parsed into a Date.
 * Timestamp formatting is where ZATCA divergence #13 bit twice — a trailing `Z`
 * that disagreed with `cbc:IssueTime` produced `invoiceTimeStamp_QRCODE_INVALID`,
 * and stripping milliseconds was NOT the fix. Interpreting another vendor's
 * timestamp is the caller's decision, made with the raw value in hand.
 */
export function readPhase1(decoded: DecodedQr): Partial<ZatcaQrPhase1> {
  const text = (tag: number): string | undefined => {
    const v = decoded.tags.get(tag);
    return v === undefined ? undefined : utf8String(v);
  };
  return {
    sellerName: text(QR_TAG.SELLER_NAME),
    vatNumber: text(QR_TAG.VAT_NUMBER),
    invoiceTimestamp: text(QR_TAG.TIMESTAMP),
    totalWithVat: text(QR_TAG.TOTAL_WITH_VAT),
    vatTotal: text(QR_TAG.VAT_TOTAL),
  };
}

/**
 * Which of the five Phase 1 fields are missing.
 *
 * Used to decide whether a decode was good enough to skip OCR: a payload with
 * a seller name and nothing else is a QR, but it is not a usable extraction.
 */
export function missingPhase1Fields(decoded: DecodedQr): string[] {
  const required = [
    QR_TAG.SELLER_NAME,
    QR_TAG.VAT_NUMBER,
    QR_TAG.TIMESTAMP,
    QR_TAG.TOTAL_WITH_VAT,
    QR_TAG.VAT_TOTAL,
  ];
  return required.filter((t) => !decoded.tags.has(t)).map((t) => QR_TAG_LABEL[t]);
}
