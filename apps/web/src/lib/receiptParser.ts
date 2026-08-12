/**
 * receiptParser.ts
 *
 * Parses raw OCR text from a Saudi receipt / tax invoice into structured fields.
 * Handles English and Arabic numerals, common KSA date formats, and ZATCA-style
 * bilingual (Arabic/English) layout including right-to-left column ordering.
 *
 * All fixes documented — see receiptParser.test.ts for exhaustive scenarios.
 */

export interface ParsedReceipt {
  vendorName: string;        // English name (or transliteration)
  vendorNameAr?: string;     // Arabic name — populated when OCR detects Arabic script in vendor line
  vendorReference: string;
  supplierVatNumber: string; // ZATCA 15-digit VAT registration number
  date: string;              // YYYY-MM-DD or ""
  subtotal: number;
  vatAmount: number;
  total: number;
  notes: string;
  rawText: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

export function normalizeDigits(s: string): string {
  return s
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/\u066B/g, "."); // Arabic decimal separator U+066B
}

/**
 * Parse a numeric token into a float.
 * Standard (1,234.56), European (1.234,56), decimal-comma (100,00),
 * thousands-only comma (1,000), double-dot OCR artefact (1.150.00).
 * NEVER put "." inside a character class — it strips all dots.
 */
function parseAmount(raw: string): number {
  let s = normalizeDigits(raw).trim();
  s = s.replace(/\bSAR\b/gi, "");
  s = s.replace(/\bSR\b/gi, "");
  s = s.replace(/ريال/g, "");
  s = s.replace(/ر\s*\.\s*س/g, ""); // ر.س — dot must be escaped outside char class
  s = s.trim();

  const commaLast = s.lastIndexOf(",");
  const dotLast   = s.lastIndexOf(".");

  if (commaLast !== -1 && dotLast !== -1) {
    s = commaLast > dotLast
      ? s.replace(/\./g, "").replace(",", ".") // European: 1.234,56
      : s.replace(/,/g, "");                   // Standard:  1,234.56
  } else if (commaLast !== -1) {
    const afterComma = s.slice(commaLast + 1).replace(/\D/g, "");
    s = afterComma.length <= 2
      ? s.replace(",", ".")  // decimal comma: 100,00
      : s.replace(/,/g, ""); // thousands:     1,000
  } else if (dotLast !== -1 && s.indexOf(".") !== dotLast) {
    const parts = s.split(".");   // double-dot OCR: 1.150.00
    const dec = parts.pop()!;
    s = parts.join("") + "." + dec;
  }

  const n = parseFloat(s.replace(/[^\d.]/g, ""));
  return isNaN(n) ? 0 : Math.round(n * 100) / 100;
}

function toIso(day: string, month: string, year: string): string {
  const d = normalizeDigits(day).padStart(2, "0");
  const y = normalizeDigits(year);
  const mm: Record<string, string> = {
    jan:"01",feb:"02",mar:"03",apr:"04",may:"05",jun:"06",
    jul:"07",aug:"08",sep:"09",oct:"10",nov:"11",dec:"12",
  };
  const m = isNaN(Number(month))
    ? (mm[month.toLowerCase().slice(0, 3)] ?? "01")
    : normalizeDigits(month).padStart(2, "0");
  return `${y.length === 2 ? `20${y}` : y}-${m}-${d}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Amount extraction
// ─────────────────────────────────────────────────────────────────────────────

const MAX_AMOUNT = 9_999_999;

// Noise patterns stripped before numeric extraction
const DATE_RE   = /\b(?:20|19)\d{2}[/\-]\d{1,2}[/\-]\d{1,2}\b|\b\d{1,2}[/\-]\d{1,2}[/\-](?:20|19)\d{2}\b/g;
const TIME_RE   = /\b\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?\b/gi;
const PCT_RE    = /\b\d+(?:\.\d+)?%/g;

function stripNoise(s: string): string {
  return s
    .replace(DATE_RE, " ")
    .replace(TIME_RE, " ")
    .replace(PCT_RE, " ")
    .replace(/\bSAR\b/gi, " ")
    .replace(/\bSR\b/gi, " ")
    .replace(/ريال/g, " ")
    .replace(/ر\s*\.\s*س/g, " ")
    .trim();
}

/** All plausible monetary amounts in a string, in document order */
function extractNums(s: string): number[] {
  const NUM_RE = /([\d]{1,3}(?:[,.]\d{3})*(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)/g;
  const out: number[] = [];
  for (const m of s.matchAll(NUM_RE)) {
    const after = s.slice((m.index ?? 0) + m[0].length).trimStart();
    if (after.startsWith("%")) continue;
    const noComma = m[0].replace(/,/g, "");
    if (/^\d{4}$/.test(noComma) && !m[0].includes(".")) {
      const yr = parseInt(noComma, 10);
      if (yr >= 1990 && yr <= 2100) continue;
    }
    const v = parseAmount(m[0]);
    if (v > 0 && v <= MAX_AMOUNT) out.push(v);
  }
  return out;
}

/** Collect {index, value} for every ريال/SAR-tagged amount in a string */
function taggedAmounts(s: string): Array<{ idx: number; v: number }> {
  const out: Array<{ idx: number; v: number }> = [];
  for (const m of s.matchAll(/([\d][,.\d]*)\s*(?:ريال|SAR|SR)\b/gi)) {
    const v = parseAmount(m[1]);
    if (v > 0 && v <= MAX_AMOUNT) out.push({ idx: m.index ?? 0, v });
  }
  for (const m of s.matchAll(/\b(?:SAR|SR)\s+([\d][,.\d]*)/gi)) {
    const idx = (m.index ?? 0) + m[0].indexOf(m[1]);
    const v = parseAmount(m[1]);
    if (v > 0 && v <= MAX_AMOUNT) out.push({ idx, v });
  }
  return out;
}

/**
 * Find the best monetary amount associated with a label that matched at
 * [labelIdx, labelEnd) on `line`.
 *
 * Strategy:
 *   1. Look for ريال/SAR-tagged amounts AFTER the label (English style: label then amount).
 *      Return the LEFTMOST (first) tagged amount found after.
 *   2. Look for ريال/SAR-tagged amounts BEFORE the label (Arabic/RTL style).
 *      Return the RIGHTMOST (closest to label) tagged amount found before.
 *   3. Fallback to denoised numeric scan, same left-then-right preference.
 */
function amountNearLabel(line: string, labelIdx: number, labelEnd: number): number {
  // After label
  const afterSeg  = line.slice(labelEnd);
  const afterTags = taggedAmounts(afterSeg);
  if (afterTags.length) {
    afterTags.sort((a, b) => a.idx - b.idx); // leftmost first
    return afterTags[0].v;
  }

  // Before label — rightmost (closest to label)
  const beforeSeg  = line.slice(0, labelIdx);
  const beforeTags = taggedAmounts(beforeSeg);
  if (beforeTags.length) {
    beforeTags.sort((a, b) => b.idx - a.idx); // rightmost first
    return beforeTags[0].v;
  }

  // Fallback: denoised scan
  const afterNums = extractNums(stripNoise(afterSeg));
  if (afterNums.length) return afterNums[0];

  const beforeNums = extractNums(stripNoise(beforeSeg));
  if (beforeNums.length) return beforeNums[beforeNums.length - 1]; // rightmost

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

  // ── 2. Sanitise lines ──────────────────────────────────────────────────────
  const cleanLines = lines.map((l) =>
    l
      .replace(/\b3\d{14}\b/g, " ") // ZATCA VAT reg (15 digits starting with 3)
      .replace(/\b\d{9,}\b/g, " ")  // Other long numeric IDs
  );

  // ── 3. Invoice reference ──────────────────────────────────────────────────
  let vendorReference = "";
  const refPats: RegExp[] = [
    /(?:invoice|receipt|bill|tax invoice|فاتورة|وصل|رقم الفاتورة)[: \t#no.]*([A-Z0-9][-A-Z0-9/]{2,20})/i,
    /(?:inv|rcpt|ref)[.:\s#]*([A-Z0-9][-A-Z0-9/]{2,20})/i,
    /\bno[.:\s#]+([A-Z0-9][-A-Z0-9/]{2,20})/i,
    /\b([A-Z]{2,6}[-/]\d{4,10})\b/,
  ];
  outer: for (const pat of refPats) {
    for (const line of lines) {
      const m = line.match(pat);
      if (m?.[1]) { vendorReference = m[1].trim(); break outer; }
    }
  }

  // ── 4. Labelled amount search ─────────────────────────────────────────────
  let total = 0, vatAmount = 0, subtotal = 0;

  /**
   * Words that make a label a qualifier rather than a standalone label.
   * e.g. "Total with VAT" — "with" before "vat" means it's not the VAT line.
   * e.g. "غير شامل الضريبة" — "غير" before "شامل" means "without tax" (subtotal).
   */
  const CONNECTORS = /^(?:with|incl\.?|including|شامل|بدون|without|غير|excl\.?)$/i;

  /**
   * Find the first cleanLine that contains a label from `labels` in a valid
   * position, then return the best monetary amount near that label.
   *
   * Label validity rules (checked at every match position):
   *   1. Char immediately BEFORE the label must not be a letter
   *      (prevents matching "total" inside "Subtotal")
   *   2. The word immediately BEFORE the label must not be a CONNECTOR
   *      (prevents "vat" in "Total with vat" from matching the VAT label,
   *       and "شامل" in "غير شامل الضريبة" from matching the TOTAL label)
   *
   * Amount is extracted relative to the label position using amountNearLabel().
   *
   * Next-line fallback (only when label is at the start of the line):
   *   If no amount is found on the label line AND the next line begins with a
   *   digit, try the next line.  This handles "VAT:\n13.04" layouts without
   *   the risk of "VAT Reg No:\nSubtotal: 100" assigning 100 to vatAmount.
   */
  function findAmount(labels: string[]): number {
    const escaped = labels.map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const pat = new RegExp(`(?:${escaped.join("|")})`, "ig");

    for (let i = 0; i < cleanLines.length; i++) {
      const line = cleanLines[i];
      let m: RegExpExecArray | null;
      pat.lastIndex = 0;

      while ((m = pat.exec(line)) !== null) {
        const matchIdx = m.index;
        const matchEnd = matchIdx + m[0].length;

        // ── Rule 1: no letter immediately before ──────────────────────────
        if (matchIdx > 0 && /[a-zA-Z\u0600-\u06FF]/.test(line[matchIdx - 1])) continue;

        // ── Rule 2: preceding word must not be a connector ─────────────────
        const wordBefore = line.slice(Math.max(0, matchIdx - 15), matchIdx).trimEnd().split(/[\s/,.:()]+/).pop() ?? "";
        if (CONNECTORS.test(wordBefore)) continue;

        // ── Extract amount relative to label ──────────────────────────────
        let v = amountNearLabel(line, matchIdx, matchEnd);

        // ── Next-line fallback (START layout only) ─────────────────────────
        if (v === 0 && matchIdx <= 3 && i + 1 < cleanLines.length) {
          const nxt = cleanLines[i + 1];
          const nxtStripped = nxt.replace(/\b(?:SAR|SR)\b/gi, "").replace(/ريال/g, "").trimStart();
          if (/^\d/.test(nxtStripped)) {
            const nxtTags = taggedAmounts(nxt);
            v = nxtTags.length
              ? nxtTags[0].v
              : (extractNums(stripNoise(nxt))[0] ?? 0);
          }
        }

        if (v > 0) return v;
      }
    }
    return 0;
  }

  // Most-specific labels searched first so short aliases ("total", "vat") do
  // not steal lines intended for longer, more specific patterns.
  total = findAmount([
    "total amount", "grand total", "amount due", "total due", "total payable",
    "total with vat", "total with tax", "total incl", "total including",
    "الإجمالي المستحق", "المبلغ الإجمالي", "الإجمالي شامل الضريبة", "الإجمالي",
    "شامل الضريبة",
  ]);
  if (total === 0) total = findAmount(["total"]);

  vatAmount = findAmount([
    "vat amount", "tax amount",
    "قيمة ضريبة القيمة المضافة", "ضريبة القيمة المضافة", "ضريبة",
    "vat (15%)", "vat(15%)", "vat 15%", "vat",
  ]);

  subtotal = findAmount([
    "total without vat", "total without tax", "total excl",
    "subtotal", "sub total", "net amount",
    "amount before vat", "amount before tax",
    "المبلغ قبل الضريبة", "المبلغ الخاضع للضريبة",
    "غير شامل الضريبة",
  ]);

  // ── 5. Derive missing fields ───────────────────────────────────────────────
  if (total > 0 && vatAmount > 0 && subtotal === 0)
    subtotal = Math.round((total - vatAmount) * 100) / 100;
  if (total > 0 && subtotal > 0 && vatAmount === 0)
    vatAmount = Math.round((total - subtotal) * 100) / 100;
  if (vatAmount > 0 && subtotal > 0 && total === 0)
    total = Math.round((subtotal + vatAmount) * 100) / 100;

  // Sanity: subtotal must not exceed total (swap if OCR mixed up rows)
  if (total > 0 && subtotal > total) {
    [subtotal, total] = [total, subtotal];
    vatAmount = Math.round((total - subtotal) * 100) / 100;
  }

  // Cross-validate: total < vatAmount means total was wrong
  if (total > 0 && vatAmount > 0 && total < vatAmount) {
    let best = 0;
    for (const line of cleanLines) {
      const tags = taggedAmounts(line);
      for (const { v } of tags) { if (v > best && v <= MAX_AMOUNT) best = v; }
    }
    if (best >= vatAmount) {
      total = best;
      if (total > vatAmount) subtotal = Math.round((total - vatAmount) * 100) / 100;
    }
  }

  // ── 6. Last-resort: largest tagged/denoised amount in the document ─────────
  if (total === 0) {
    let best = 0;
    for (const line of cleanLines) {
      const tags = taggedAmounts(line);
      for (const { v } of tags) { if (v > best && v <= MAX_AMOUNT) best = v; }
      if (!tags.length) {
        const nums = extractNums(stripNoise(line));
        for (const v of nums) { if (v > best && v <= MAX_AMOUNT) best = v; }
      }
    }
    if (best > 0) total = best;
  }

  // ── 7. VAT estimation ──────────────────────────────────────────────────────
  const isZeroRated = cleanLines.some((l) =>
    /\b(?:exempt|zero.?rated|0%|معفاة|صفري)\b/i.test(l)
  );
  if (total > 0 && vatAmount === 0 && !isZeroRated) {
    vatAmount = Math.round((total / 1.15) * 0.15 * 100) / 100;
    if (subtotal === 0) subtotal = Math.round((total - vatAmount) * 100) / 100;
  }

  // ── 8. Supplier VAT registration number ───────────────────────────────────
  // Extract BEFORE cleanLines (which strips ZATCA numbers).
  // ZATCA format: 15 digits starting with 3.
  const vatRegMatch = text.match(/\b(3\d{14})\b/);
  const supplierVatNumber = vatRegMatch?.[1] ?? "";

  // ── 9. Vendor name ─────────────────────────────────────────────────────────
  //
  // Script detection: a line is "Arabic" when ≥30 % of its non-space
  // characters fall inside the Arabic Unicode block (U+0600–U+06FF).
  // This threshold catches fully Arabic names and bilingual Arabic-first
  // lines while ignoring isolated Arabic currency markers (ريال / ر.س)
  // that can appear on otherwise-English lines.
  function arabicRatio(s: string): number {
    const chars = s.replace(/\s/g, "");
    if (!chars.length) return 0;
    const ar = (chars.match(/[\u0600-\u06FF]/g) ?? []).length;
    return ar / chars.length;
  }

  const skipRe = /^(receipt|invoice|tax invoice|فاتورة|ضريبية|date|total|vat|page|copy)/i;
  const vendorLine = lines.find((l) => l.length > 3 && !skipRe.test(l) && !/^\d/.test(l));

  let vendorName = "";
  let vendorNameAr: string | undefined;

  if (vendorLine) {
    const ratio = arabicRatio(vendorLine);

    if (ratio >= 0.7) {
      // Predominantly Arabic — the whole line is the Arabic name
      vendorNameAr = vendorLine;
      // Look for an English name on a nearby line
      const enLine = lines.find(
        (l) => l !== vendorLine && l.length > 3 && !skipRe.test(l) &&
               !/^\d/.test(l) && arabicRatio(l) < 0.1
      );
      vendorName = enLine ?? "";
    } else if (ratio >= 0.1) {
      // Mixed bilingual line — split on the boundary between scripts.
      // Example: "ACME Corp  شركة أكمي" → English left, Arabic right.
      const arMatch = vendorLine.match(/[\u0600-\u06FF][\u0600-\u06FF\s\u064B-\u065F]*/);
      const enPart  = vendorLine.replace(/[\u0600-\u06FF\s\u064B-\u065F]+/g, " ").trim();
      vendorName   = enPart.length > 2 ? enPart : "";
      vendorNameAr = arMatch?.[0].trim();
    } else {
      // Purely English / transliterated — leave vendorNameAr undefined
      vendorName = vendorLine;
    }
  }

  const notes = `Scanned receipt${vendorReference ? ` · Ref: ${vendorReference}` : ""}`;
  return { vendorName, vendorNameAr, vendorReference, supplierVatNumber, date, subtotal, vatAmount, total, notes, rawText: raw };
}
