/**
 * receiptParser.ts
 *
 * Parses raw OCR text from a Saudi receipt / tax invoice into structured fields.
 * Handles English and Arabic numerals, common KSA date formats, and ZATCA-style
 * layout (vendor name top, VAT registration number, totals at the bottom).
 *
 * Bugs fixed (see receiptParser.test.ts for exhaustive scenarios):
 *  A. parseAmount: character class [ر\.س] stripped ALL dots → amounts x100
 *  B. Thousands-comma ambiguity: "1,000" vs "100,00" vs "1.234,56"
 *  C. Double-dot OCR artefact: "1.150.00" parsed as 1.15
 *  D. Arabic decimal dot U+066B not normalised
 *  E. "VAT" embedded mid-line ("Total incl. VAT") mistaken for VAT label
 *  F. ZATCA 15-digit VAT reg number captured as monetary amount
 *  G. Phone/CR numbers (9+ digits) captured as amounts
 *  H. Year (2026) captured as last-resort total
 *  I. VAT label on one line, amount on the next line
 *  J. Percentage "15%" captured as amount
 *  K. Zero-rated receipts getting spurious 15% VAT estimation
 *  L. subtotal > total after bad derivation order
 *  M. Ref pattern crossing newlines ("Tax Invoice\nDate:..." -> ref="Date")
 *  N. Label suffix matching: "Subtotal" matched when searching for "total"
 */

export interface ParsedReceipt {
  vendorName: string;
  vendorReference: string;
  date: string;       // YYYY-MM-DD or ""
  subtotal: number;
  vatAmount: number;
  total: number;
  notes: string;
  rawText: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Normalise Arabic-Indic digits (٠-٩) and Arabic decimal separator (٫ U+066B) */
function normalizeDigits(s: string): string {
  return s
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/\u066B/g, "."); // Arabic decimal separator -> "."
}

/**
 * Parse a raw numeric token into a JavaScript float.
 * Handles:
 *   Standard   1,234.56  -> 1234.56
 *   European   1.234,56  -> 1234.56
 *   2-digit ,  100,00    -> 100.00  (decimal comma, not thousands)
 *   Thousands  1,000     -> 1000
 *   Double-dot 1.150.00  -> 1150.00 (OCR artefact)
 *
 * NEVER put "." inside a character class -- it strips ALL dots.
 */
function parseAmount(raw: string): number {
  let s = normalizeDigits(raw).trim();

  // Strip currency markers WITHOUT touching decimal dots.
  // Use word/string patterns outside character classes so "." is never removed.
  s = s.replace(/\bSAR\b/gi, "");
  s = s.replace(/\bSR\b/gi, "");
  s = s.replace(/ريال/g, "");
  s = s.replace(/ر\s*\.\s*س/g, ""); // ر.س  abbreviation (dot is escaped, not in a class)
  s = s.trim();

  const commaLast = s.lastIndexOf(",");
  const dotLast   = s.lastIndexOf(".");

  if (commaLast !== -1 && dotLast !== -1) {
    if (commaLast > dotLast) {
      // European: 1.234,56 -> strip dots (thousands sep), swap comma to dot
      s = s.replace(/\./g, "").replace(",", ".");
    } else {
      // Standard: 1,234.56 -> strip commas (thousands sep)
      s = s.replace(/,/g, "");
    }
  } else if (commaLast !== -1) {
    // Only commas present
    const afterComma = s.slice(commaLast + 1).replace(/\D/g, "");
    if (afterComma.length <= 2) {
      // Decimal comma: 100,00 -> 100.00
      s = s.replace(",", ".");
    } else {
      // Thousands comma: 1,000 -> 1000
      s = s.replace(/,/g, "");
    }
  } else if (dotLast !== -1 && s.indexOf(".") !== dotLast) {
    // Multiple dots (OCR artefact): 1.150.00 -> keep last dot as decimal
    const parts = s.split(".");
    const dec = parts.pop()!;
    s = parts.join("") + "." + dec;
  }

  const n = parseFloat(s.replace(/[^\d.]/g, ""));
  return isNaN(n) ? 0 : Math.round(n * 100) / 100;
}

/** ISO date from day/month/year strings */
function toIso(day: string, month: string, year: string): string {
  const d = normalizeDigits(day).padStart(2, "0");
  const y = normalizeDigits(year);
  const monthMap: Record<string, string> = {
    jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
    jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
  };
  const m = isNaN(Number(month))
    ? (monthMap[month.toLowerCase().slice(0, 3)] ?? "01")
    : normalizeDigits(month).padStart(2, "0");
  const fullYear = y.length === 2 ? `20${y}` : y;
  return `${fullYear}-${m}-${d}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Amount extraction from a single line
// ─────────────────────────────────────────────────────────────────────────────

const MAX_AMOUNT = 9_999_999;

/**
 * Pull the rightmost monetary amount from a line.
 * - Strips SAR/SR currency prefix/suffix (never the decimal dot)
 * - Rejects numbers immediately followed by % (percentages)
 * - Rejects bare 4-digit years (1990-2100)
 * - Rejects result > MAX_AMOUNT
 */
function extractAmountFromLine(line: string): number {
  // Strip currency markers (never dots)
  const clean = line
    .replace(/\bSAR\b/gi, " ")
    .replace(/\bSR\b/gi, " ")
    .replace(/ريال/g, " ")
    .replace(/ر\s*\.\s*س/g, " ")
    .trim();

  // Match all number-like tokens (supports thousands + decimal in any locale)
  const NUM_RE = /([\d]{1,3}(?:[,.]\d{3})*(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)/g;
  const matches = [...clean.matchAll(NUM_RE)];
  if (!matches.length) return 0;

  // Walk right-to-left — rightmost number is the amount column
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i];
    const after = clean.slice((m.index ?? 0) + m[0].length).trimStart();

    // Reject percentages
    if (after.startsWith("%")) continue;

    // Reject bare 4-digit integers that look like years
    const noComma = m[0].replace(/,/g, "");
    if (/^\d{4}$/.test(noComma) && !m[0].includes(".")) {
      const yr = parseInt(noComma, 10);
      if (yr >= 1990 && yr <= 2100) continue;
    }

    const v = parseAmount(m[0]);
    if (v > 0 && v <= MAX_AMOUNT) return v;
  }
  return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main parser
// ─────────────────────────────────────────────────────────────────────────────

export function parseReceiptText(raw: string): ParsedReceipt {
  const text  = normalizeDigits(raw);
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  // ── 1. Date ────────────────────────────────────────────────────────────────
  let date = "";

  const isoM = text.match(/\b(20\d{2})[-/](0?[1-9]|1[0-2])[-/](0?[1-9]|[12]\d|3[01])\b/);
  if (isoM) date = toIso(isoM[3], isoM[2], isoM[1]);

  if (!date) {
    const dmyM = text.match(/\b(0?[1-9]|[12]\d|3[01])[-/](0?[1-9]|1[0-2])[-/](20\d{2}|\d{2})\b/);
    if (dmyM) date = toIso(dmyM[1], dmyM[2], dmyM[3]);
  }

  if (!date) {
    const longM = text.match(
      /\b(0?[1-9]|[12]\d|3[01])\s+(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(20\d{2})\b/i
    );
    if (longM) date = toIso(longM[1], longM[2], longM[3]);
  }

  // ── 2. Sanitise lines for amount extraction ────────────────────────────────
  // Remove numeric IDs so they can never be captured as amounts.
  //   - Saudi ZATCA VAT reg: exactly 15 digits starting with 3
  //   - Phone/CR/barcode: 9+ digit sequences
  const cleanLines = lines.map((l) =>
    l
      .replace(/\b3\d{14}\b/g, " ") // ZATCA VAT registration number
      .replace(/\b\d{9,}\b/g, " ")  // Other long numeric IDs
  );

  // ── 3. Invoice / receipt reference ────────────────────────────────────────
  // Run each pattern line-by-line (never across newlines) to prevent
  // "Tax Invoice\nDate: ..." from capturing "Date" as the reference.
  let vendorReference = "";
  const refPatterns: RegExp[] = [
    /(?:invoice|receipt|bill|tax invoice|فاتورة|وصل|رقم الفاتورة)[: \t#no.]*([A-Z0-9][-A-Z0-9/]{2,20})/i,
    /(?:inv|rcpt|ref)[.:\s#]*([A-Z0-9][-A-Z0-9/]{2,20})/i,
    /\bno[.:\s#]+([A-Z0-9][-A-Z0-9/]{2,20})/i,
    /\b([A-Z]{2,6}[-/]\d{4,10})\b/,
  ];
  outer: for (const pat of refPatterns) {
    for (const line of lines) {
      const m = line.match(pat);
      if (m?.[1]) { vendorReference = m[1].trim(); break outer; }
    }
  }

  // ── 4. Amount labelled-line search ────────────────────────────────────────
  let total = 0, vatAmount = 0, subtotal = 0;

  /**
   * Search cleanLines for the first line whose label starts within startMax
   * chars of the line beginning AND is not a suffix of a longer word.
   * Falls back to the immediately following line when the matched line has no
   * numeric content (handles "VAT:\n13.04" split-line layouts).
   */
  function findAmount(labels: string[], startMax = 4): number {
    const escaped = labels.map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const pat = new RegExp(`(?:${escaped.join("|")})`, "i");

    for (let i = 0; i < cleanLines.length; i++) {
      const m = pat.exec(cleanLines[i]);
      if (!m || m.index > startMax) continue;

      // Reject if the label is a suffix of a longer word.
      // e.g. "total" at index 3 in "Subtotal" — char before is "b" (letter) -> skip.
      if (m.index > 0 && /[a-zA-Z\u0600-\u06FF]/.test(cleanLines[i][m.index - 1])) continue;

      // Try the matched line first
      let v = extractAmountFromLine(cleanLines[i]);

      // Next-line fallback: label-only line followed by a pure-amount line
      if (v === 0 && i + 1 < cleanLines.length) {
        const nxt = cleanLines[i + 1];
        // Accept next line only if it consists entirely of digits, punctuation, SAR
        if (/^[\d\s,.\u0660-\u066B]+$/i.test(nxt.replace(/\b(?:SAR|SR)\b/gi, ""))) {
          v = extractAmountFromLine(nxt);
        }
      }

      if (v > 0) return v;
    }
    return 0;
  }

  // Most-specific labels first so short labels ("total", "vat") do not steal
  // lines that belong to longer patterns.
  total = findAmount([
    "total amount", "grand total", "amount due", "total due", "total payable",
    "الإجمالي المستحق", "المبلغ الإجمالي", "الإجمالي شامل الضريبة", "الإجمالي",
  ]);
  if (total === 0) total = findAmount(["total"]);

  vatAmount = findAmount([
    "vat amount", "tax amount",
    "قيمة ضريبة القيمة المضافة", "ضريبة القيمة المضافة", "ضريبة",
    "vat (15%)", "vat(15%)", "vat 15%", "vat",
  ]);

  subtotal = findAmount([
    "subtotal", "sub total", "net amount",
    "amount before vat", "amount before tax",
    "المبلغ قبل الضريبة", "المبلغ الخاضع للضريبة",
  ]);

  // ── 5. Derive missing fields ───────────────────────────────────────────────
  if (total > 0 && vatAmount > 0 && subtotal === 0)
    subtotal = Math.round((total - vatAmount) * 100) / 100;
  if (total > 0 && subtotal > 0 && vatAmount === 0)
    vatAmount = Math.round((total - subtotal) * 100) / 100;
  if (vatAmount > 0 && subtotal > 0 && total === 0)
    total = Math.round((subtotal + vatAmount) * 100) / 100;

  // Sanity: subtotal must not exceed total (swap if OCR mixed up the rows)
  if (total > 0 && subtotal > total) {
    [subtotal, total] = [total, subtotal];
    vatAmount = Math.round((total - subtotal) * 100) / 100;
  }

  // ── 6. Last-resort: largest decimal number in the document ─────────────────
  // Only fires when no labelled total was found.
  if (total === 0) {
    let best = 0;
    for (const line of cleanLines) {
      const v = extractAmountFromLine(line);
      if (v > best && v <= MAX_AMOUNT) best = v;
    }
    if (best > 0) total = best;
  }

  // ── 7. VAT estimation ──────────────────────────────────────────────────────
  // Only estimate when no VAT line was found AND receipt is not zero-rated/exempt.
  const isZeroRated = cleanLines.some((l) =>
    /\b(?:exempt|zero.?rated|0%|معفاة|صفري)\b/i.test(l)
  );
  if (total > 0 && vatAmount === 0 && !isZeroRated) {
    vatAmount = Math.round((total / 1.15) * 0.15 * 100) / 100;
    if (subtotal === 0) subtotal = Math.round((total - vatAmount) * 100) / 100;
  }

  // ── 8. Vendor name ─────────────────────────────────────────────────────────
  const skipRe = /^(receipt|invoice|tax invoice|فاتورة|ضريبية|date|total|vat|page|copy)/i;
  const vendorLine = lines.find((l) => l.length > 3 && !skipRe.test(l) && !/^\d/.test(l));
  const vendorName = vendorLine ?? "";

  const notes = `Scanned receipt${vendorReference ? ` · Ref: ${vendorReference}` : ""}`;

  return { vendorName, vendorReference, date, subtotal, vatAmount, total, notes, rawText: raw };
}
