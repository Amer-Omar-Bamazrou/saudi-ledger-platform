import { describe, expect, it } from "vitest";
import { parseReceiptText } from "./receiptParser";

/**
 * receiptParser — Arabic-aware Saudi receipt parsing.
 *
 * 🔴 CONVERTED IN A1 FROM A SCRIPT NOTHING RAN. This file held ~60 assertions of
 * careful work — Arabic-Indic digits, the Arabic decimal separator, KSA date
 * formats, bilingual RTL layouts, OCR artefacts — behind a hand-rolled harness
 * (`npx tsx receiptParser.test.ts`, its own `expect()`, `process.exit(1)`). There
 * was no web test runner, so CI never executed a single one of them.
 *
 * That mattered because A1's OCR bake-off MEASURES this parser, and measuring
 * something that can regress silently proves nothing. The assertions are
 * preserved verbatim; only the harness changed.
 */

/** Preserves the original call shape: check(label, got, expected). */
function check(label: string, got: unknown, expected: unknown): void {
  expect(got, label).toEqual(expected);
}

describe("A: Standard ZATCA English receipt", () => {
  it("parses the receipt correctly", () => {
      const r = parseReceiptText(`
    AlNoor Trading Co
    Tax Invoice
    Date: 15/07/2026
    Invoice No: INV-20240715
    VAT Reg No: 310122445500031

    Subtotal:       SAR 1,000.00
    VAT (15%):      SAR   150.00
    Total Amount:   SAR 1,150.00
    `);
      check("A subtotal",  r.subtotal,  1000);
      check("A vatAmount", r.vatAmount, 150);
      check("A total",     r.total,     1150);
      check("A date",      r.date,      "2026-07-15");
      check("A vendorRef", r.vendorReference, "INV-20240715");
  });
});


// ── B: Total (incl. VAT) — VAT embedded mid-line ──────────────────────────────
describe("B: 'Total (incl. VAT)' — VAT embedded mid-line", () => {
  it("parses the receipt correctly", () => {
      const r = parseReceiptText(`
    Quick Mart
    Date: 2026-03-10
    VAT Amount:       SAR 13.04
    Total (incl. VAT): SAR 100.00
    `);
      check("B vatAmount", r.vatAmount, 13.04);
      check("B total",     r.total,     100);
      check("B subtotal",  r.subtotal,  86.96);
  });
});


// ── C: Arabic-Indic digits ────────────────────────────────────────────────────
describe("C: Arabic-Indic digits", () => {
  it("parses the receipt correctly", () => {
      const r = parseReceiptText(`
    مطعم السلام
    التاريخ: ١٥/٠٧/٢٠٢٦
    المبلغ قبل الضريبة:   ٨٦٫٩٦
    ضريبة القيمة المضافة: ١٣٫٠٤
    الإجمالي:             ١٠٠٫٠٠
    `);
      check("C subtotal",  r.subtotal,  86.96);
      check("C vatAmount", r.vatAmount, 13.04);
      check("C total",     r.total,     100);
  });
});


// ── D: European decimal format ────────────────────────────────────────────────
describe("D: European decimal (1.234,56 style)", () => {
  it("parses the receipt correctly", () => {
      const r = parseReceiptText(`
    Euro Style Shop
    Subtotal:   1.000,00
    VAT:          150,00
    Total:      1.150,00
    `);
      check("D subtotal",  r.subtotal,  1000);
      check("D vatAmount", r.vatAmount, 150);
      check("D total",     r.total,     1150);
  });
});


// ── E: 2-digit comma decimal ──────────────────────────────────────────────────
describe("E: 2-digit comma decimal (100,00)", () => {
  it("parses the receipt correctly", () => {
      const r = parseReceiptText(`
    Corner Store
    Subtotal:  86,96
    VAT:       13,04
    Total:    100,00
    `);
      check("E subtotal",  r.subtotal,  86.96);
      check("E vatAmount", r.vatAmount, 13.04);
      check("E total",     r.total,     100);
  });
});


// ── F: ZATCA VAT reg number not captured ──────────────────────────────────────
describe("F: ZATCA VAT registration number not mistaken for amount", () => {
  it("parses the receipt correctly", () => {
      const r = parseReceiptText(`
    Al Rajhi Foods
    VAT Registration No: 310122445500031
    Subtotal: 500.00
    VAT:       75.00
    Total:    575.00
    `);
      check("F vatAmount", r.vatAmount, 75);
      check("F total",     r.total,     575);
  });
});


// ── G: Phone number not captured ──────────────────────────────────────────────
describe("G: Phone number not captured as amount", () => {
  it("parses the receipt correctly", () => {
      const r = parseReceiptText(`
    Quick Bites
    Tel: 0501234567
    Subtotal:  200.00
    VAT:        30.00
    Total:     230.00
    `);
      check("G total",     r.total,     230);
      check("G vatAmount", r.vatAmount, 30);
  });
});


// ── H: Year not captured as total ─────────────────────────────────────────────
describe("H: Year (2026) not captured as last-resort total", () => {
  it("parses the receipt correctly", () => {
      const r = parseReceiptText(`
    City Centre Mall
    Date: 2026-01-01
    Invoice: CI-0042
    Total: 85.50
    `);
      check("H total", r.total, 85.50);
  });
});


// ── I: Label on one line, amount on next ──────────────────────────────────────
describe("I: Label on one line, amount on next line", () => {
  it("parses the receipt correctly", () => {
      const r = parseReceiptText(`
    BookShop
    Subtotal
    86.96
    VAT
    13.04
    Total
    100.00
    `);
      check("I subtotal",  r.subtotal,  86.96);
      check("I vatAmount", r.vatAmount, 13.04);
      check("I total",     r.total,     100);
  });
});


// ── J: Percentage not captured ────────────────────────────────────────────────
describe("J: '15%' percentage not captured as VAT amount", () => {
  it("parses the receipt correctly", () => {
      const r = parseReceiptText(`
    Pharmacy Plus
    VAT 15%
    Subtotal:   200.00
    VAT Amount:  30.00
    Total:      230.00
    `);
      check("J vatAmount", r.vatAmount, 30);
      check("J total",     r.total,     230);
  });
});


// ── K: Zero-rated receipt ─────────────────────────────────────────────────────
describe("K: Zero-rated receipt — no VAT estimation", () => {
  it("parses the receipt correctly", () => {
      const r = parseReceiptText(`
    Medical Clinic
    Items (VAT exempt / zero-rated)
    Total: 500.00
    `);
      check("K total",     r.total,     500);
      check("K vatAmount", r.vatAmount, 0);
  });
});


// ── L: Double-dot OCR artefact ────────────────────────────────────────────────
describe("L: Double-dot OCR artefact (1.150.00)", () => {
  it("parses the receipt correctly", () => {
      const r = parseReceiptText(`
    Supermarket
    Subtotal:  1.000.00
    VAT:         150.00
    Total:     1.150.00
    `);
      check("L subtotal",  r.subtotal,  1000);
      check("L total",     r.total,     1150);
  });
});


// ── M: Only total present — derive ───────────────────────────────────────────
describe("M: Only total present — derive subtotal + VAT at 15%", () => {
  it("parses the receipt correctly", () => {
      const r = parseReceiptText(`
    Fuel Station
    Total Amount: 115.00
    `);
      check("M total",     r.total,     115);
      check("M vatAmount", r.vatAmount, 15);
      check("M subtotal",  r.subtotal,  100);
  });
});


// ── N: Large thousands-separated amounts ──────────────────────────────────────
describe("N: Large amounts with thousands separators", () => {
  it("parses the receipt correctly", () => {
      const r = parseReceiptText(`
    Furniture Palace
    Subtotal:    10,000.00
    VAT (15%):    1,500.00
    Grand Total: 11,500.00
    `);
      check("N subtotal",  r.subtotal,  10000);
      check("N vatAmount", r.vatAmount, 1500);
      check("N total",     r.total,     11500);
  });
});


// ── O: Swapped subtotal / total rows ─────────────────────────────────────────
describe("O: Swapped subtotal / total rows", () => {
  it("parses the receipt correctly", () => {
      const r = parseReceiptText(`
    Mixed Up Store
    Subtotal:  1,150.00
    VAT:         150.00
    Total:     1,000.00
    `);
      check("O total >= subtotal", r.total >= r.subtotal, true);
      check("O total",    r.total,   1150);
      check("O subtotal", r.subtotal, 1000);
  });
});


// ── P: SAR prefix on every amount ─────────────────────────────────────────────
describe("P: SAR prefix on every amount", () => {
  it("parses the receipt correctly", () => {
      const r = parseReceiptText(`
    Al Meera
    Net Amount:  SAR 86.96
    VAT Amount:  SAR 13.04
    Total:       SAR 100.00
    `);
      check("P subtotal",  r.subtotal,  86.96);
      check("P vatAmount", r.vatAmount, 13.04);
      check("P total",     r.total,     100);
  });
});


// ── Q: No labels — last-resort ────────────────────────────────────────────────
describe("Q: No labels — last-resort picks largest monetary number", () => {
  it("parses the receipt correctly", () => {
      const r = parseReceiptText(`
    Simple Cafe
    86.96
    13.04
    100.00
    `);
      check("Q total", r.total, 100);
  });
});


// ── R: Mixed Arabic/English ───────────────────────────────────────────────────
describe("R: Mixed Arabic/English", () => {
  it("parses the receipt correctly", () => {
      const r = parseReceiptText(`
    Al-Futtaim
    الرقم الضريبي: 310122445500031
    Date: 10/06/2026
    المبلغ قبل الضريبة: 1,000.00
    VAT 15%:             150.00
    Total Amount:      1,150.00
    `);
      check("R subtotal",  r.subtotal,  1000);
      check("R vatAmount", r.vatAmount, 150);
      check("R total",     r.total,     1150);
  });
});


// ── S: Real ZATCA simplified invoice with date in total row ───────────────────
// Mirrors the actual receipt from the user screenshot.
// OCR of this kind of receipt produces the date "2025/11/02" on the same
// line as "Total with vat" because of the multi-column table layout.
describe("S: Real ZATCA receipt — date digits in total row, ريال-tagged amounts", () => {
  it("parses the receipt correctly", () => {
      const r = parseReceiptText(`
    مؤسسة ركن اختيارك للمقاولات
    Mobile: 0506597255-0509505861
    سجل تجاري: 1010129179
    VAT: 300486802400003

    Simplified tax invoice / فاتورة ضريبية مبسطة

    Invoice no / 3426-2025 رقم الفاتورة
    Customer/ العميل
    Mobile: 00966567017044

    Customer tax number / 312166697700003 الرقم الضريبي للعميل
    Date/ 04:48 2025/11/02 PM التاريخ

    الاجمالي/Total   السعر / unit price   الكمية / Quantity   المنتج / Product name
    120              12                   Pc(s) 10             BOSA MAHABAS , 147654 1/2
    4                4                   Pc(s) 1              10CM NAGGAS , 148356

    2025/11/02 142   Cash   11   ك /Quantitys الاجمالية
    142 ريال   المبلغ / Amount paid المدفوع   124 ريال   Total without vat / ح غير شامل الضريبة:
    (+) 18 ريال   Vat (ضريبة القيمة المضافة):
    142 ريال   / Total with vat / ح شامل الضريبة:
    (one hundred forty-two)
    `);
      check("S subtotal",  r.subtotal,  124);
      check("S vatAmount", r.vatAmount, 18);
      check("S total",     r.total,     142);
      check("S date",      r.date,      "2025-11-02");
  });
});


// ── T: Date on same line as total label, amount after label ───────────────────
describe("T: Date embedded in total line — amount must not be the date's day", () => {
  it("parses the receipt correctly", () => {
      const r = parseReceiptText(`
    Shop Name
    Date: 2026-07-02
    VAT:  SAR 15.00
    Total with VAT 2026/07/02: SAR 115.00
    `);
      check("T total",     r.total,     115);
      check("T vatAmount", r.vatAmount, 15);
  });
});


// ── U: ريال after each amount (Arabic receipt style) ─────────────────────────
describe("U: ريال-tagged amounts — Arabic style", () => {
  it("parses the receipt correctly", () => {
      const r = parseReceiptText(`
    المطعم الذهبي
    التاريخ: 2026/07/15
    غير شامل الضريبة: 86.96 ريال
    ضريبة القيمة المضافة: 13.04 ريال
    شامل الضريبة: 100.00 ريال
    `);
      check("U subtotal",  r.subtotal,  86.96);
      check("U vatAmount", r.vatAmount, 13.04);
      check("U total",     r.total,     100);
  });
});


// ── V: "Total without vat" correctly goes to subtotal ────────────────────────
describe("V: 'Total without vat' label mapped to subtotal", () => {
  it("parses the receipt correctly", () => {
      const r = parseReceiptText(`
    Electronics Store
    Total without vat: 200.00
    Vat (15%):          30.00
    Total with vat:    230.00
    `);
      check("V subtotal",  r.subtotal,  200);
      check("V vatAmount", r.vatAmount, 30);
      check("V total",     r.total,     230);
  });
});
