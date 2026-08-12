import { describe, expect, it } from "vitest";
import {
  hijriToGregorian,
  parseAmount,
  parseStatementDate,
  parseStatementRow,
} from "./statementParser";

/**
 * M15 — real-export parsing. Every case here failed, or was silently wrong,
 * before the statement parser existed.
 */

describe("parseAmount", () => {
  it("🔴 European decimals are not wrong by 1000x", () => {
    // The old parser stripped commas then parseFloat'd: "1.234,56" -> 1.234.
    // Silently wrong by three orders of magnitude, on a money field.
    expect(parseAmount("1.234,56")).toEqual({ value: 1234.56, negative: false });
    expect(parseAmount("1.234.567,89")).toEqual({ value: 1234567.89, negative: false });
  });

  it("standard and thousands formats", () => {
    expect(parseAmount("1,234.56")).toEqual({ value: 1234.56, negative: false });
    expect(parseAmount("431.25")).toEqual({ value: 431.25, negative: false });
    expect(parseAmount("1,234")).toEqual({ value: 1234, negative: false });
  });

  it("🔴 signed amounts — the bank convention for debits", () => {
    expect(parseAmount("-431.25")).toEqual({ value: 431.25, negative: true });
    expect(parseAmount("(431.25)")).toEqual({ value: 431.25, negative: true });
    expect(parseAmount("431.25-")).toEqual({ value: 431.25, negative: true });
  });

  it("🔴 Arabic-Indic digits and separators", () => {
    // Reuses receiptParser's normalisation — the old path produced NaN.
    expect(parseAmount("١٢٣٤")).toEqual({ value: 1234, negative: false });
    expect(parseAmount("١٬٢٣٤٫٥٦")).toEqual({ value: 1234.56, negative: false });
  });

  it("currency letters mixed into the cell", () => {
    expect(parseAmount("SAR 1,150.00")).toEqual({ value: 1150, negative: false });
  });

  it("rubbish is null, not NaN and not zero", () => {
    expect(parseAmount("")).toBeNull();
    expect(parseAmount("N/A")).toBeNull();
  });
});

describe("parseStatementDate", () => {
  it("ISO and Saudi day-first forms", () => {
    expect(parseStatementDate("2026-07-15")).toEqual({ date: "2026-07-15", source: "gregorian" });
    expect(parseStatementDate("15/07/2026")).toEqual({ date: "2026-07-15", source: "gregorian" });
    expect(parseStatementDate("15-07-2026")).toEqual({ date: "2026-07-15", source: "gregorian" });
    expect(parseStatementDate("15-Jul-26")).toEqual({ date: "2026-07-15", source: "gregorian" });
  });

  it("🔴 DD/MM wins over MM/DD in the ambiguous case", () => {
    // 03/07 is 3 July in Saudi exports, not 7 March.
    expect(parseStatementDate("03/07/2026")).toEqual({ date: "2026-07-03", source: "gregorian" });
  });

  it("🔴 Hijri dates convert EXACTLY via Umm al-Qura", () => {
    // 1 Muharram 1448 = 16 June 2026 per the runtime's own Umm al-Qura tables
    // (verified with Intl directly). The first draft of this test asserted
    // "26 June" from a hand-derived anchor and FAILED — the code was right and
    // the constant was wrong. Which is the recorded lesson: assert the
    // PROPERTY (the round-trip below) when the number rests on reasoning you
    // have not verified. The fixed point is kept, but sourced from the tables
    // rather than from arithmetic.
    expect(hijriToGregorian(1448, 1, 1)).toBe("2026-06-16");
    // Round-trip property: convert back through Intl and compare.
    const g = hijriToGregorian(1447, 9, 15);
    expect(g).toBeTruthy();
    const parts = new Intl.DateTimeFormat("en-u-ca-islamic-umalqura", {
      timeZone: "UTC", year: "numeric", month: "numeric", day: "numeric",
    }).formatToParts(new Date(`${g}T00:00:00Z`));
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    expect([get("year"), get("month"), get("day")]).toEqual([1447, 9, 15]);
  });

  it("Hijri detected in day-first order too", () => {
    const r = parseStatementDate("01/01/1448");
    expect(r?.source).toBe("hijri");
    expect(r?.date).toBe("2026-06-16");
  });

  it("Arabic-Indic digits in dates", () => {
    expect(parseStatementDate("١٥/٠٧/٢٠٢٦")).toEqual({ date: "2026-07-15", source: "gregorian" });
  });

  it("rubbish is null", () => {
    expect(parseStatementDate("banana")).toBeNull();
    expect(parseStatementDate("15/13/2026")).toBeNull();
  });
});

describe("parseStatementRow", () => {
  it("🔴 a signed single-column export (the real bank shape) parses", () => {
    const row = parseStatementRow({ Date: "15/07/2026", Description: "POS PANDA", Amount: "-431.25" });
    expect(row.error).toBeUndefined();
    expect(row).toMatchObject({ date: "2026-07-15", amount: 431.25, type: "debit" });
  });

  it("🔴 separate Debit/Credit columns parse", () => {
    const d = parseStatementRow({ Date: "15/07/2026", Details: "SUPPLIER TRANSFER", Debit: "12,650.00", Credit: "" });
    expect(d).toMatchObject({ amount: 12650, type: "debit" });
    const c = parseStatementRow({ Date: "16/07/2026", Details: "CUSTOMER PAYMENT", Debit: "", Credit: "34,500.00" });
    expect(c).toMatchObject({ amount: 34500, type: "credit" });
  });

  it("🔴 an Arabic description reaches the categorizer's Arabic patterns", () => {
    // Pre-M15 descriptionAr was never extracted, so Arabic rows matched far
    // worse than their English twins — Arabic support existed in the rules and
    // was unreachable from the data.
    const row = parseStatementRow({ التاريخ: "15/07/2026", الوصف: "تحويل راتب - فاطمة العتيبي", المبلغ: "-6500" });
    expect(row.descriptionAr).toBe("تحويل راتب - فاطمة العتيبي");
    expect(row.type).toBe("debit");
  });

  it("both debit and credit filled is an error, not a guess", () => {
    const row = parseStatementRow({ Date: "15/07/2026", Details: "X", Debit: "100", Credit: "200" });
    expect(row.error).toMatch(/both debit and credit/);
  });

  it("unsigned amount with no type column is flagged, not guessed", () => {
    // A debit booked as a credit inverts the books; direction must never be
    // invented. Our own template always carries `type`, so this only fires on
    // foreign exports.
    const row = parseStatementRow({ Date: "15/07/2026", Description: "X", Amount: "500" });
    expect(row.error).toMatch(/direction unknown/);
  });

  it("a malformed row reports its reasons and is not dropped", () => {
    const row = parseStatementRow({ Date: "banana", Description: "", Amount: "N/A" });
    expect(row.error).toMatch(/unrecognised date/);
    expect(row.error).toMatch(/invalid amount|no amount/);
    expect(row.error).toMatch(/missing description/);
  });
});
