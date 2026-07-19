/**
 * receiptParser.ts
 *
 * Parses raw OCR text from a Saudi receipt / tax invoice into structured fields.
 * Handles English and Arabic numerals, common KSA date formats, and ZATCA-style
 * layout (vendor name top, VAT registration number, totals at the bottom).
 */

export interface ParsedReceipt {
  vendorName: string;
  vendorReference: string; // invoice / receipt number from the document
  date: string;            // YYYY-MM-DD or ""
  subtotal: number;
  vatAmount: number;
  total: number;
  notes: string;
  rawText: string;
}

// ── helpers ────────────────────────────────────────────────────────────────────

/** Convert Arabic-Indic digits (٠١٢٣٤٥٦٧٨٩) to Western digits */
function normalizeDigits(s: string): string {
  return s.replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660));
}

/** Strip thousands separators and normalise decimal comma → point */
function parseAmount(raw: string): number {
  const s = normalizeDigits(raw).replace(/,(?=\d{3})/g, "").replace(",", ".");
  const n = parseFloat(s.replace(/[^\d.]/g, ""));
  return isNaN(n) ? 0 : Math.round(n * 100) / 100;
}

/** Try to parse a date string into ISO YYYY-MM-DD */
function toIso(day: string, month: string, year: string): string {
  const d = normalizeDigits(day).padStart(2, "0");
  const y = normalizeDigits(year);
  // month can be numeric or short English name
  const monthMap: Record<string, string> = {
    jan:"01",feb:"02",mar:"03",apr:"04",may:"05",jun:"06",
    jul:"07",aug:"08",sep:"09",oct:"10",nov:"11",dec:"12",
  };
  const m = isNaN(Number(month))
    ? (monthMap[month.toLowerCase().slice(0, 3)] ?? "01")
    : normalizeDigits(month).padStart(2, "0");
  const fullYear = y.length === 2 ? `20${y}` : y;
  return `${fullYear}-${m}-${d}`;
}

// ── main parser ────────────────────────────────────────────────────────────────

export function parseReceiptText(raw: string): ParsedReceipt {
  const text = normalizeDigits(raw);
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  // ── 1. Date ──────────────────────────────────────────────────────────────────
  let date = "";

  // YYYY-MM-DD or YYYY/MM/DD
  const isoMatch = text.match(/\b(20\d{2})[-/](0?[1-9]|1[0-2])[-/](0?[1-9]|[12]\d|3[01])\b/);
  if (isoMatch) {
    date = toIso(isoMatch[3], isoMatch[2], isoMatch[1]);
  }

  // DD/MM/YYYY or DD-MM-YYYY
  if (!date) {
    const dmyMatch = text.match(/\b(0?[1-9]|[12]\d|3[01])[-/](0?[1-9]|1[0-2])[-/](20\d{2}|\d{2})\b/);
    if (dmyMatch) date = toIso(dmyMatch[1], dmyMatch[2], dmyMatch[3]);
  }

  // DD Month YYYY (e.g. "15 January 2026" or "15 Jan 2026")
  if (!date) {
    const longMatch = text.match(
      /\b(0?[1-9]|[12]\d|3[01])\s+(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(20\d{2})\b/i
    );
    if (longMatch) date = toIso(longMatch[1], longMatch[2], longMatch[3]);
  }

  // ── 2. Invoice / receipt number ───────────────────────────────────────────────
  let vendorReference = "";
  const refPatterns = [
    /(?:invoice|receipt|bill|tax invoice|فاتورة|وصل|رقم الفاتورة)[:\s#no.]*([A-Z0-9][-A-Z0-9/]{2,20})/i,
    /(?:inv|rcpt|ref|no)[.:\s#]*([A-Z0-9][-A-Z0-9/]{2,20})/i,
    /\b([A-Z]{2,6}[-/]?\d{4,10})\b/,
  ];
  for (const pat of refPatterns) {
    const m = text.match(pat);
    if (m?.[1]) { vendorReference = m[1].trim(); break; }
  }

  // ── 3. Amounts ────────────────────────────────────────────────────────────────
  let total = 0, vatAmount = 0, subtotal = 0;

  // Strip VAT registration / CR numbers BEFORE amount parsing so the
  // 15-digit ZATCA VAT ID (e.g. 310122445500003) is never mistaken for a
  // monetary value.  Saudi VAT numbers are exactly 15 digits starting with 3.
  // Also strip other long digit sequences (≥10 digits) that are clearly IDs.
  const textForAmounts = text
    .replace(/\b3\d{14}\b/g, "VATID")              // ZATCA VAT reg number
    .replace(/\b\d{10,}\b/g, "REFNO");              // any other long ID

  // Look for labelled amounts — order matters (most specific first).
  // Sanity-cap: receipt line totals should never exceed 9,999,999 SAR.
  const MAX_RECEIPT_AMOUNT = 9_999_999;
  const amountLine = (labels: string[]): number => {
    const pat = new RegExp(
      `(?:${labels.join("|")})[^\\d\\n]{0,30}([\\d,]+\\.?\\d{0,2})`,
      "i"
    );
    const m = textForAmounts.match(pat);
    if (!m) return 0;
    const v = parseAmount(m[1]);
    return v <= MAX_RECEIPT_AMOUNT ? v : 0;
  };

  total = amountLine(["total amount", "grand total", "amount due", "total due", "total payable", "المبلغ الإجمالي", "الإجمالي", "total"]);
  vatAmount = amountLine(["vat amount", "tax amount", "vat", "ضريبة القيمة المضافة", "ضريبة", "tax"]);
  subtotal = amountLine(["subtotal", "net amount", "amount before vat", "amount before tax", "المبلغ قبل الضريبة", "sub total"]);

  // Derive missing values
  if (total > 0 && vatAmount > 0 && subtotal === 0) subtotal = Math.round((total - vatAmount) * 100) / 100;
  if (total > 0 && subtotal > 0 && vatAmount === 0) vatAmount = Math.round((total - subtotal) * 100) / 100;
  if (vatAmount > 0 && subtotal > 0 && total === 0) total = Math.round((subtotal + vatAmount) * 100) / 100;

  // Last-resort: grab the largest number in the document as total
  if (total === 0) {
    const nums = [...text.matchAll(/\b(\d{1,6}(?:[.,]\d{2,3})*)\b/g)]
      .map(m => parseAmount(m[1]))
      .filter(n => n > 0 && n < 10_000_000);
    if (nums.length) total = Math.max(...nums);
  }

  // If we have total but no VAT, estimate at 15% (standard KSA VAT rate)
  if (total > 0 && vatAmount === 0) {
    vatAmount = Math.round((total / 1.15) * 0.15 * 100) / 100;
    if (subtotal === 0) subtotal = Math.round((total - vatAmount) * 100) / 100;
  }

  // ── 4. Vendor name ────────────────────────────────────────────────────────────
  // Heuristic: the first non-empty line that isn't a date, number, or common header
  const skipWords = /^(receipt|invoice|tax invoice|فاتورة|ضريبية|date|total|vat|page|copy|\d)/i;
  const vendorLine = lines.find(l => l.length > 3 && !skipWords.test(l) && !/^\d/.test(l));
  const vendorName = vendorLine ?? "";

  // ── 5. Notes ─────────────────────────────────────────────────────────────────
  const notes = `Scanned receipt${vendorReference ? ` · Ref: ${vendorReference}` : ""}`;

  return { vendorName, vendorReference, date, subtotal, vatAmount, total, notes, rawText: raw };
}
