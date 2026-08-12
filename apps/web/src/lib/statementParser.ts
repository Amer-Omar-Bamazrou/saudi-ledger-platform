/**
 * Bank-statement row parser (M15) — what real Saudi exports actually look like.
 *
 * The old `parseRawRows` accepted only what OUR template produces: ISO dates,
 * positive amounts, an explicit `type` column. Real exports have none of those:
 *
 *   - amounts are SIGNED in a single column (debits negative), or split across
 *     separate Debit/Credit columns;
 *   - dates come as DD/MM/YYYY, DD-MM-YYYY, DD-MMM-YY — and from Al Rajhi and
 *     SNB, commonly as HIJRI dates (Umm al-Qura calendar);
 *   - numbers use Arabic-Indic digits (١٢٣٤), the Arabic decimal separator
 *     (٫) and thousands marks (٬), or European format (1.234,56);
 *   - Arabic descriptions live in their own column, or ARE the description.
 *
 * A genuine Al Rajhi export therefore failed to import wholesale — and worse,
 * European decimals were silently wrong by 1000x ("1.234,56" became 1.234 after
 * the old strip-commas-then-parseFloat).
 *
 * Digit normalisation is REUSED from `receiptParser` (the same Arabic handling,
 * already under test) rather than reimplemented — one implementation per rule.
 */
import { normalizeDigits } from "./receiptParser";

export interface ParsedStatementRow {
  date: string; // YYYY-MM-DD (Gregorian)
  description: string;
  descriptionAr?: string;
  amount: number; // always positive; direction is in `type`
  type: "debit" | "credit";
  currency: string;
  /** Populated when the row could not be understood. The row is NOT dropped. */
  error?: string;
  /** How the date was read — surfaced so a Hijri conversion is visible. */
  dateSource?: "gregorian" | "hijri";
}

// ── amounts ─────────────────────────────────────────────────────────────────

/**
 * Parse a statement amount.
 *
 * Handles: "1,234.56" · "1.234,56" (European) · Arabic digits and separators ·
 * "(431.25)" (accounting negative) · "-431.25" · "431.25-" (trailing sign,
 * seen in some bank exports) · currency letters mixed in ("SAR 1,150.00").
 *
 * 🔴 The European case is the dangerous one: the old parser stripped commas and
 * parseFloat'd, so "1.234,56" became 1.234 — wrong by 1000x with NO error. A
 * silently wrong amount is the truncation lesson again: worse than a rejected
 * one, because it gets used.
 */
export function parseAmount(raw: string): { value: number; negative: boolean } | null {
  let s = normalizeDigits(String(raw ?? ""))
    .replace(/٬/g, ",") // Arabic thousands separator
    .replace(/[A-Za-z؀-ۿ]/g, "") // currency words/letters
    .trim();
  if (!s) return null;

  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (s.startsWith("-")) {
    negative = true;
    s = s.slice(1);
  }
  if (s.endsWith("-")) {
    negative = true;
    s = s.slice(0, -1);
  }
  s = s.trim();

  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");

  if (lastComma > -1 && lastDot > -1) {
    // Both present: the RIGHTMOST is the decimal separator.
    s =
      lastComma > lastDot
        ? s.replace(/\./g, "").replace(",", ".") // 1.234,56 -> 1234.56
        : s.replace(/,/g, ""); // 1,234.56 -> 1234.56
  } else if (lastComma > -1) {
    // Only commas. ",NN" (one or two trailing digits) is a European decimal;
    // groups of exactly three are thousands.
    const after = s.length - lastComma - 1;
    if (after === 1 || after === 2) {
      s = s.replace(/,(\d{1,2})$/, ".$1").replace(/,/g, "");
    } else {
      s = s.replace(/,/g, "");
    }
  } else {
    // Only dots. More than one dot = European thousands ("1.234.567").
    const dots = s.match(/\./g);
    if (dots && dots.length > 1) s = s.replace(/\./g, "");
  }

  const value = Number.parseFloat(s);
  if (!Number.isFinite(value)) return null;
  return { value: Math.abs(Math.round(value * 100) / 100), negative };
}

// ── dates ───────────────────────────────────────────────────────────────────

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Convert an Umm al-Qura (Hijri) date to Gregorian EXACTLY, by searching the
 * runtime's own islamic-umalqura calendar.
 *
 * 🔴 Why not a tabular approximation: the tabular Islamic calendar drifts a day
 * or two from Umm al-Qura, and a statement date off by one day can change which
 * VAT period a transaction lands in. `Intl` ships the real Umm al-Qura tables,
 * so the conversion is searched against them rather than approximated.
 */
const hijriFmt = new Intl.DateTimeFormat("en-u-ca-islamic-umalqura", {
  // 🔴 Pinned to UTC. Without it the formatter reads the LOCAL calendar day
  // while the return path extracts the UTC one — and in Riyadh (UTC+3) a
  // timestamp near midnight sits on different days in the two views, so the
  // search converged on a date one day off from the one returned. Found by the
  // round-trip property test, which is exactly what property tests are for.
  timeZone: "UTC",
  year: "numeric",
  month: "numeric",
  day: "numeric",
});

function hijriOf(d: Date): { y: number; m: number; d: number } {
  const parts = hijriFmt.formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return { y: get("year"), m: get("month"), d: get("day") };
}

export function hijriToGregorian(hy: number, hm: number, hd: number): string | null {
  // Rough anchor: Hijri epoch 622-07-19, one Hijri year ~ 354.367 days.
  let t = Date.UTC(622, 6, 19) + Math.round((hy - 1 + (hm - 1) / 12) * 354.367 * 86400000);
  for (let i = 0; i < 800; i += 1) {
    const cur = hijriOf(new Date(t));
    if (cur.y === hy && cur.m === hm && cur.d === hd) {
      const g = new Date(t);
      return `${g.getUTCFullYear()}-${pad(g.getUTCMonth() + 1)}-${pad(g.getUTCDate())}`;
    }
    const diff = (cur.y - hy) * 354 + (cur.m - hm) * 29.5 + (cur.d - hd);
    const step = Math.max(1, Math.abs(Math.round(diff)));
    t -= step * Math.sign(diff || 1) * 86400000;
  }
  return null;
}

/**
 * Parse a statement date to Gregorian YYYY-MM-DD.
 *
 * Accepts ISO, DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY, DD-MMM-YY(YY), and Hijri
 * (detected by year 1300-1499, in either digit order). DD/MM is assumed over
 * MM/DD: Saudi exports are day-first, and the ambiguous case (both parts <= 12)
 * is resolved the Saudi way, not the US way.
 */
export function parseStatementDate(
  raw: string,
): { date: string; source: "gregorian" | "hijri" } | null {
  const s = normalizeDigits(String(raw ?? "")).trim();
  if (!s) return null;

  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) {
    const y = Number(m[1]);
    if (y >= 1300 && y < 1500) {
      const g = hijriToGregorian(y, Number(m[2]), Number(m[3]));
      return g ? { date: g, source: "hijri" } : null;
    }
    return { date: `${y}-${pad(Number(m[2]))}-${pad(Number(m[3]))}`, source: "gregorian" };
  }

  m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/);
  if (m) {
    const d = Number(m[1]);
    const mo = Number(m[2]);
    const y = Number(m[3]);
    if (y >= 1300 && y < 1500) {
      const g = hijriToGregorian(y, mo, d);
      return g ? { date: g, source: "hijri" } : null;
    }
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return { date: `${y}-${pad(mo)}-${pad(d)}`, source: "gregorian" };
  }

  m = s.match(/^(\d{1,2})[/\- ]([A-Za-z]{3})[/\- ](\d{2}|\d{4})$/);
  if (m) {
    const mo = MONTHS[m[2].toLowerCase()];
    if (!mo) return null;
    const yy = Number(m[3]);
    const y = yy < 100 ? 2000 + yy : yy;
    return { date: `${y}-${pad(mo)}-${pad(Number(m[1]))}`, source: "gregorian" };
  }

  return null;
}

// ── rows ────────────────────────────────────────────────────────────────────

const ARABIC = /[؀-ۿ]/;

/** Header aliases seen across Saudi bank exports and our own template. */
const HEADERS = {
  date: ["date", "transaction_date", "value_date", "التاريخ", "تاريخ", "تاريخ_العملية"],
  description: [
    "description", "desc", "details", "narrative", "transaction_details",
    "الوصف", "وصف", "البيان", "التفاصيل",
  ],
  descriptionAr: ["description_ar", "arabic_description", "الوصف_عربي"],
  amount: ["amount", "المبلغ", "مبلغ"],
  debit: ["debit", "debit_amount", "withdrawal", "مدين"],
  credit: ["credit", "credit_amount", "deposit", "دائن"],
  type: ["type", "النوع", "نوع"],
  currency: ["currency", "العملة", "عملة"],
} as const;

function pick(keys: Record<string, string>, names: readonly string[]): string | undefined {
  for (const n of names) {
    if (keys[n] !== undefined && String(keys[n]).trim() !== "") return String(keys[n]);
  }
  return undefined;
}

/**
 * Parse one raw CSV row. Never throws; problems land in `error` so the preview
 * shows the row with its reason instead of dropping it.
 */
export function parseStatementRow(r: Record<string, string>): ParsedStatementRow {
  const keys = Object.keys(r).reduce<Record<string, string>>((acc, k) => {
    acc[k.toLowerCase().trim().replace(/\s+/g, "_")] = r[k];
    return acc;
  }, {});

  const errors: string[] = [];

  const rawDate = pick(keys, HEADERS.date) ?? "";
  const parsedDate = parseStatementDate(rawDate);
  if (!parsedDate) errors.push(`unrecognised date "${rawDate}"`);

  const debitCol = pick(keys, HEADERS.debit);
  const creditCol = pick(keys, HEADERS.credit);
  const amountCol = pick(keys, HEADERS.amount);
  const typeCol = (pick(keys, HEADERS.type) ?? "").toLowerCase().trim();

  let amount = 0;
  let type: "debit" | "credit" = "debit";

  if (debitCol !== undefined || creditCol !== undefined) {
    // Separate Debit / Credit columns: exactly one should carry a value.
    const d = debitCol !== undefined ? parseAmount(debitCol) : null;
    const c = creditCol !== undefined ? parseAmount(creditCol) : null;
    if (d && d.value > 0 && c && c.value > 0) {
      errors.push("both debit and credit carry a value");
    } else if (d && d.value > 0) {
      amount = d.value;
      type = "debit";
    } else if (c && c.value > 0) {
      amount = c.value;
      type = "credit";
    } else {
      errors.push("no amount in debit or credit column");
    }
  } else if (amountCol !== undefined) {
    const a = parseAmount(amountCol);
    if (!a || a.value === 0) {
      errors.push(`invalid amount "${amountCol}"`);
    } else {
      amount = a.value;
      // 🔴 A signed single column is the bank convention: negative = money out.
      // An explicit type column, when present, wins over the sign.
      if (typeCol === "credit" || typeCol === "دائن") type = "credit";
      else if (typeCol === "debit" || typeCol === "مدين") type = "debit";
      else if (a.negative) type = "debit";
      else if (typeCol) type = "debit";
      else {
        // Unsigned amount AND no type column: direction is genuinely unknown.
        // Flagged rather than guessed — a debit booked as a credit inverts the
        // books. (Our own template always carries `type`, so this only fires on
        // foreign exports.)
        type = "credit";
        errors.push("direction unknown: no sign and no type column");
      }
    }
  } else {
    errors.push("no amount column found");
  }

  let description = (pick(keys, HEADERS.description) ?? "").trim();
  let descriptionAr = (pick(keys, HEADERS.descriptionAr) ?? "").trim() || undefined;
  if (!descriptionAr && ARABIC.test(description)) {
    // The description IS Arabic: carry it in BOTH fields so the categorizer's
    // Arabic patterns see it. Pre-M15, descriptionAr was never extracted and
    // Arabic-described rows matched far worse than their English twins.
    descriptionAr = description;
  }
  if (!description) errors.push("missing description");

  const currency = (pick(keys, HEADERS.currency) ?? "SAR").trim().toUpperCase() || "SAR";

  return {
    date: parsedDate?.date ?? "",
    description,
    descriptionAr,
    amount,
    type,
    currency,
    dateSource: parsedDate?.source,
    error: errors.length ? errors.join("; ") : undefined,
  };
}
