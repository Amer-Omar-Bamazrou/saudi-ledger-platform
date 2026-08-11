/**
 * Read a ZATCA QR from a captured image — the moat (A1).
 *
 * ── Why this runs BEFORE OCR ────────────────────────────────────────────────
 * A ZATCA-compliant supplier invoice carries seller name, VAT number, timestamp,
 * total and VAT as structured TLV. Decoding it is **exact, free, instant, and
 * never leaves the device** — where OCR is probabilistic, slow on a phone, and
 * (if it were a cloud provider) would ship a customer's document abroad.
 *
 * By Wave 25's 1 Feb 2027 deadline effectively every VAT-registered Saudi
 * supplier issues one of these, so this is the majority path, not the clever
 * case. OCR is what happens when this fails.
 *
 * ── What is deliberately NOT here ───────────────────────────────────────────
 * **Signature verification.** Tags 6–9 are extracted and passed on, but whether
 * they VERIFY is decided server-side. A client-side "verified" badge is worth
 * nothing — it can be faked by the client, and the claim being made is about
 * whether the customer's input-VAT deduction will survive ZATCA. See the A1
 * spec §2.2.
 *
 * The TLV codec is imported from `@workspace/zatca-tlv`, shared with the server.
 * It is NOT reimplemented here: it carries thirteen documented divergences that
 * were wrong twice before live ZATCA responses settled them, and a second copy
 * would drift silently.
 */
import jsQR from "jsqr";
import {
  QR_TAG,
  bytesToBase64,
  decodeTlv,
  missingPhase1Fields,
  readPhase1,
} from "@workspace/zatca-tlv";
import type { ParsedReceipt } from "./receiptParser";

/** How a field's value was obtained. Recorded per capture, not per session. */
export type ExtractionSource = "qr" | "ocr" | "manual";

export interface QrCaptureResult {
  /** Fields in the same shape OCR produces, so `ScanReview` needs no new branch. */
  parsed: ParsedReceipt;
  /** Raw payload, forwarded to the server for signature verification. */
  payloadBase64: string;
  /** Tags 6–9 present ⇒ the server can attempt verification. */
  isPhase2: boolean;
  /** Phase 1 fields the payload did not carry, by human name. */
  missing: string[];
  /** Tags whose declared length overran the payload — see the codec. */
  truncated: number[];
}

/** Decode an image to raw pixels. Canvas is the only way in a browser. */
async function imagePixels(file: File): Promise<ImageData | null> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("could not read image"));
      el.src = url;
    });

    // A phone photo can be 4000px wide; jsQR is O(pixels) and a QR remains
    // findable at a fraction of that. Cap the long edge so decoding stays fast
    // on a mid-range Android — the device this feature exists for.
    const MAX = 1600;
    const scale = Math.min(1, MAX / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Map decoded TLV onto the shape `ScanReview` already consumes.
 *
 * 🔴 `subtotal` is DERIVED (total − VAT), not read: ZATCA's QR carries the total
 * and the VAT, never the net. Deriving it is exact arithmetic on two exact
 * numbers, unlike OCR where all three are guesses that may not reconcile.
 *
 * 🔴 The timestamp is passed through `dateOnly` rather than parsed into a Date.
 * Divergence #13 bit twice on timestamp formatting; taking the leading `YYYY-MM-DD`
 * makes no assumption about what follows it.
 */
export function mapQrToReceipt(
  fields: Partial<ReturnType<typeof readPhase1>>,
  rawPayload: string,
): ParsedReceipt {
  const num = (v: string | undefined): number => {
    const n = Number(String(v ?? "").replace(/,/g, ""));
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
  };
  const total = num(fields.totalWithVat);
  const vatAmount = num(fields.vatTotal);
  const subtotal = Math.round((total - vatAmount) * 100) / 100;

  const stamp = String(fields.invoiceTimestamp ?? "");
  const dateOnly = /^\d{4}-\d{2}-\d{2}/.test(stamp) ? stamp.slice(0, 10) : "";

  const name = String(fields.sellerName ?? "");
  const isArabic = /[؀-ۿ]/.test(name);

  return {
    vendorName: isArabic ? "" : name,
    vendorNameAr: isArabic ? name : undefined,
    vendorReference: "",
    supplierVatNumber: String(fields.vatNumber ?? ""),
    date: dateOnly,
    subtotal,
    vatAmount,
    total,
    notes: "",
    rawText: rawPayload,
  };
}

/**
 * Try to read a ZATCA QR from the image. Returns `null` when there is none —
 * the caller then falls back to OCR.
 *
 * Never throws: a supplier's odd document must degrade to OCR, not fail capture.
 */
export async function readZatcaQr(file: File): Promise<QrCaptureResult | null> {
  try {
    const pixels = await imagePixels(file);
    if (!pixels) return null;

    const found = jsQR(pixels.data, pixels.width, pixels.height, {
      inversionAttempts: "attemptBoth",
    });
    if (!found?.data) return null;

    const decoded = decodeTlv(found.data);

    // A QR that is not a ZATCA payload — a payment link, a vendor's own
    // tracking code. Tag 1 and tag 2 are the minimum that makes this OUR kind
    // of QR; without them, fall back rather than present nonsense as extraction.
    if (!decoded.tags.has(QR_TAG.SELLER_NAME) || !decoded.tags.has(QR_TAG.VAT_NUMBER)) {
      return null;
    }

    const phase1 = readPhase1(decoded);
    return {
      parsed: mapQrToReceipt(phase1, found.data),
      payloadBase64: found.data,
      isPhase2: decoded.isPhase2,
      missing: missingPhase1Fields(decoded),
      truncated: decoded.truncated,
    };
  } catch {
    // Decoding another vendor's document is best-effort by nature.
    return null;
  }
}

/** Re-export so callers need not depend on the codec directly. */
export { bytesToBase64 };
