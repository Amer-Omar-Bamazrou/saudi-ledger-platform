/**
 * scanReviewStore.ts
 *
 * Thin sessionStorage bridge between the ReceiptScanner dialog (Bills.tsx)
 * and the ScanReview page. Lives outside ScanReview.tsx so that file can
 * export only a React component — required for Vite Fast Refresh to work.
 */
import type { ParsedReceipt } from "@/lib/receiptParser";
import type { ExtractionSource } from "@/lib/qrCapture";

const SCAN_KEY = "ksa_ledger_scan_review";

/**
 * What the review page receives.
 *
 * 🔴 `source` is the A1 provenance requirement in its smallest form: the actual
 * question a disputed figure raises is **"was this decoded, read by OCR, or
 * typed?"**, and until now nothing recorded it.
 *
 * ⚠️ This is still `sessionStorage` — a refresh loses it, no document is
 * retained, and a posted bill cannot be traced to its source image. Persisting
 * it server-side is A1 deliverable ②; this carries provenance through the
 * existing handoff so the UI can act on it now.
 */
export interface ScanPayload {
  parsed: ParsedReceipt;
  source: ExtractionSource;
  /** Tags 6–9 present ⇒ the server can attempt signature verification. */
  isPhase2?: boolean;
  /** Phase 1 fields the QR did not carry. */
  missing?: string[];
  /** Raw TLV payload, forwarded for server-side verification. */
  payloadBase64?: string;
}

export function storeScanData(data: ScanPayload): void {
  sessionStorage.setItem(SCAN_KEY, JSON.stringify(data));
}

export function loadAndClearScanData(): ScanPayload | null {
  try {
    const raw = sessionStorage.getItem(SCAN_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(SCAN_KEY);
    const v = JSON.parse(raw) as ScanPayload | ParsedReceipt;
    // Tolerate the pre-A1 shape (a bare ParsedReceipt) so an in-flight session
    // across a deploy does not land on an empty review page.
    return "parsed" in (v as ScanPayload)
      ? (v as ScanPayload)
      : { parsed: v as ParsedReceipt, source: "ocr" };
  } catch {
    return null;
  }
}
