import { describe, expect, it } from "vitest";
import {
  QR_TAG,
  base64ToBytes,
  bytesToBase64,
  concatBytes,
  decodeTlv,
  missingPhase1Fields,
  readPhase1,
  tlv,
  utf8Bytes,
  utf8String,
} from "./index";

/**
 * The shared TLV codec — the moat's decoder.
 *
 * This layout was wrong twice, from two different sources, before live ZATCA
 * responses settled it. These tests exist so the ONE implementation both
 * runtimes share cannot drift.
 */

/** Build a payload the way a compliant ZATCA solution would. */
function buildPayload(fields: { tag: number; value: Uint8Array }[]): string {
  return bytesToBase64(concatBytes(fields.map((f) => tlv(f.tag, f.value))));
}

const phase1 = [
  { tag: QR_TAG.SELLER_NAME, value: utf8Bytes("مؤسسة الرياض للتجارة") },
  { tag: QR_TAG.VAT_NUMBER, value: utf8Bytes("399999999999993") },
  { tag: QR_TAG.TIMESTAMP, value: utf8Bytes("2026-08-12T10:15:30") },
  { tag: QR_TAG.TOTAL_WITH_VAT, value: utf8Bytes("1150.00") },
  { tag: QR_TAG.VAT_TOTAL, value: utf8Bytes("150.00") },
];

describe("TLV codec", () => {
  it("round-trips a Phase 1 payload", () => {
    const decoded = decodeTlv(buildPayload(phase1));
    expect(readPhase1(decoded)).toEqual({
      sellerName: "مؤسسة الرياض للتجارة",
      vatNumber: "399999999999993",
      invoiceTimestamp: "2026-08-12T10:15:30",
      totalWithVat: "1150.00",
      vatTotal: "150.00",
    });
    expect(decoded.isPhase2).toBe(false);
    expect(missingPhase1Fields(decoded)).toEqual([]);
  });

  it("🔴 survives ARABIC seller names, which are multi-byte", () => {
    // TLV length is a BYTE count, not a character count. An Arabic name is
    // ~2 bytes per character, so a length taken from `.length` would truncate
    // every Arabic supplier — i.e. most of them.
    const arabic = "شركة تقنية المعلومات المحدودة";
    const decoded = decodeTlv(buildPayload([{ tag: QR_TAG.SELLER_NAME, value: utf8Bytes(arabic) }]));
    expect(utf8String(decoded.tags.get(QR_TAG.SELLER_NAME)!)).toBe(arabic);
    expect(utf8Bytes(arabic).length).toBeGreaterThan(arabic.length);
  });

  it("detects a Phase 2 payload — which is what makes verification possible", () => {
    const decoded = decodeTlv(
      buildPayload([
        ...phase1,
        { tag: QR_TAG.INVOICE_HASH, value: utf8Bytes("hOsjRxnRA7Kk4T3TQu3kJ0iPPz3sJEnTdW+8wjJ8s5A=") },
        { tag: QR_TAG.SIGNATURE, value: utf8Bytes("MEUCIQD...") },
        { tag: QR_TAG.PUBLIC_KEY, value: new Uint8Array([0x30, 0x56, 0x30, 0x10]) },
        { tag: QR_TAG.CERTIFICATE_SIGNATURE, value: new Uint8Array([0x30, 0x44, 0x02, 0x20]) },
      ]),
    );
    expect(decoded.isPhase2).toBe(true);
    expect(decoded.order).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("🔴 keeps tags 8 and 9 as RAW BYTES, not text", () => {
    // Divergence #13: tags 6 and 7 are base64 STRINGS, 8 and 9 are RAW BYTES.
    // Decoding them as UTF-8 corrupts them, and this was wrong in two separate
    // implementations before live responses settled it.
    const der = new Uint8Array([0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0xff, 0xfe]);
    const decoded = decodeTlv(buildPayload([{ tag: QR_TAG.PUBLIC_KEY, value: der }]));
    expect(Array.from(decoded.tags.get(QR_TAG.PUBLIC_KEY)!)).toEqual(Array.from(der));
  });

  it("🔴 is LENIENT: a truncated payload yields what it can, and does not throw", () => {
    // These payloads come from every other vendor's software in the Kingdom. An
    // exception would abandon the fields that WERE readable and fail capture
    // entirely, when falling back to OCR was available.
    const full = base64ToBytes(buildPayload(phase1));
    const truncated = bytesToBase64(full.subarray(0, full.length - 4));

    const decoded = decodeTlv(truncated);
    // Everything before the damage is still readable — that is the leniency.
    expect(decoded.tags.get(QR_TAG.SELLER_NAME)).toBeDefined();
    expect(decoded.tags.get(QR_TAG.VAT_NUMBER)).toBeDefined();

    // 🔴 But the truncated MONEY field is reported ABSENT, never as a partial
    // value. "150.00" clipped to "15" is a plausible amount that is wrong by a
    // factor of ten, and the user has no way to know. This is the assertion
    // that caught the decoder returning one.
    expect(decoded.truncated).toContain(QR_TAG.VAT_TOTAL);
    expect(decoded.tags.has(QR_TAG.VAT_TOTAL)).toBe(false);
    expect(missingPhase1Fields(decoded)).toContain("VAT total");
  });

  it("does not throw on an unknown tag, or on rubbish", () => {
    expect(() => decodeTlv(buildPayload([{ tag: 42, value: utf8Bytes("x") }]))).not.toThrow();
    expect(() => decodeTlv("")).not.toThrow();
    expect(() => decodeTlv("bm90LWEtdGx2LXBheWxvYWQ=")).not.toThrow();
  });

  it("reports exactly which Phase 1 fields are missing", () => {
    const decoded = decodeTlv(buildPayload([phase1[0], phase1[1]]));
    expect(missingPhase1Fields(decoded)).toEqual([
      "invoice timestamp",
      "total including VAT",
      "VAT total",
    ]);
  });

  it("refuses to encode a field longer than one length byte", () => {
    expect(() => tlv(1, new Uint8Array(256))).toThrow(/one byte/);
    expect(() => tlv(1, new Uint8Array(255))).not.toThrow();
  });

  it("returns the timestamp VERBATIM — never parsed", () => {
    // Divergence #13 bit twice on timestamp formatting. Another vendor's
    // timestamp is the caller's to interpret, with the raw value in hand.
    for (const stamp of ["2026-08-12T10:15:30", "2026-08-12T10:15:30Z", "2026-08-12 10:15:30"]) {
      const decoded = decodeTlv(buildPayload([{ tag: QR_TAG.TIMESTAMP, value: utf8Bytes(stamp) }]));
      expect(readPhase1(decoded).invoiceTimestamp).toBe(stamp);
    }
  });

  it("base64 round-trips bytes that are not valid UTF-8", () => {
    const raw = new Uint8Array([0x00, 0xff, 0xfe, 0x80, 0x7f]);
    expect(Array.from(base64ToBytes(bytesToBase64(raw)))).toEqual(Array.from(raw));
  });
});
