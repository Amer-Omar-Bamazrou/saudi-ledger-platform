/**
 * scanReviewStore.ts
 *
 * Thin sessionStorage bridge between the ReceiptScanner dialog (Bills.tsx)
 * and the ScanReview page. Lives outside ScanReview.tsx so that file can
 * export only a React component — required for Vite Fast Refresh to work.
 */
import type { ParsedReceipt } from "@/lib/receiptParser";

const SCAN_KEY = "ksa_ledger_scan_review";

export function storeScanData(data: ParsedReceipt): void {
  sessionStorage.setItem(SCAN_KEY, JSON.stringify(data));
}

export function loadAndClearScanData(): ParsedReceipt | null {
  try {
    const raw = sessionStorage.getItem(SCAN_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(SCAN_KEY);
    return JSON.parse(raw) as ParsedReceipt;
  } catch {
    return null;
  }
}
