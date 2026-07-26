/**
 * receiptParser.test.ts
 * Run: npx tsx receiptParser.test.ts
 */
import { parseReceiptText } from "./receiptParser";

let passed = 0, failed = 0;
function expect(label: string, got: unknown, expected: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else    { failed++; console.error(`  ✗ ${label}\n    got      ${JSON.stringify(got)}\n    expected ${JSON.stringify(expected)}`); }
}
function section(name: string) { console.log(`\n── ${name} ─`); }

// ── A: Standard ZATCA English receipt ────────────────────────────────────────
section("A: Standard ZATCA English receipt");
{
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
  expect("A subtotal",  r.subtotal,  1000);
  expect("A vatAmount", r.vatAmount, 150);
  expect("A total",     r.total,     1150);
  expect("A date",      r.date,      "2026-07-15");
  expect("A vendorRef", r.vendorReference, "INV-20240715");
}

// ── B: Total (incl. VAT) — VAT embedded mid-line ──────────────────────────────
section("B: 'Total (incl. VAT)' — VAT embedded mid-line");
{
  const r = parseReceiptText(`
Quick Mart
Date: 2026-03-10
VAT Amount:       SAR 13.04
Total (incl. VAT): SAR 100.00
`);
  expect("B vatAmount", r.vatAmount, 13.04);
  expect("B total",     r.total,     100);
  expect("B subtotal",  r.subtotal,  86.96);
}

// ── C: Arabic-Indic digits ────────────────────────────────────────────────────
section("C: Arabic-Indic digits");
{
  const r = parseReceiptText(`
مطعم السلام
التاريخ: ١٥/٠٧/٢٠٢٦
المبلغ قبل الضريبة:   ٨٦٫٩٦
ضريبة القيمة المضافة: ١٣٫٠٤
الإجمالي:             ١٠٠٫٠٠
`);
  expect("C subtotal",  r.subtotal,  86.96);
  expect("C vatAmount", r.vatAmount, 13.04);
  expect("C total",     r.total,     100);
}

// ── D: European decimal format ────────────────────────────────────────────────
section("D: European decimal (1.234,56 style)");
{
  const r = parseReceiptText(`
Euro Style Shop
Subtotal:   1.000,00
VAT:          150,00
Total:      1.150,00
`);
  expect("D subtotal",  r.subtotal,  1000);
  expect("D vatAmount", r.vatAmount, 150);
  expect("D total",     r.total,     1150);
}

// ── E: 2-digit comma decimal ──────────────────────────────────────────────────
section("E: 2-digit comma decimal (100,00)");
{
  const r = parseReceiptText(`
Corner Store
Subtotal:  86,96
VAT:       13,04
Total:    100,00
`);
  expect("E subtotal",  r.subtotal,  86.96);
  expect("E vatAmount", r.vatAmount, 13.04);
  expect("E total",     r.total,     100);
}

// ── F: ZATCA VAT reg number not captured ──────────────────────────────────────
section("F: ZATCA VAT registration number not mistaken for amount");
{
  const r = parseReceiptText(`
Al Rajhi Foods
VAT Registration No: 310122445500031
Subtotal: 500.00
VAT:       75.00
Total:    575.00
`);
  expect("F vatAmount", r.vatAmount, 75);
  expect("F total",     r.total,     575);
}

// ── G: Phone number not captured ──────────────────────────────────────────────
section("G: Phone number not captured as amount");
{
  const r = parseReceiptText(`
Quick Bites
Tel: 0501234567
Subtotal:  200.00
VAT:        30.00
Total:     230.00
`);
  expect("G total",     r.total,     230);
  expect("G vatAmount", r.vatAmount, 30);
}

// ── H: Year not captured as total ─────────────────────────────────────────────
section("H: Year (2026) not captured as last-resort total");
{
  const r = parseReceiptText(`
City Centre Mall
Date: 2026-01-01
Invoice: CI-0042
Total: 85.50
`);
  expect("H total", r.total, 85.50);
}

// ── I: Label on one line, amount on next ──────────────────────────────────────
section("I: Label on one line, amount on next line");
{
  const r = parseReceiptText(`
BookShop
Subtotal
86.96
VAT
13.04
Total
100.00
`);
  expect("I subtotal",  r.subtotal,  86.96);
  expect("I vatAmount", r.vatAmount, 13.04);
  expect("I total",     r.total,     100);
}

// ── J: Percentage not captured ────────────────────────────────────────────────
section("J: '15%' percentage not captured as VAT amount");
{
  const r = parseReceiptText(`
Pharmacy Plus
VAT 15%
Subtotal:   200.00
VAT Amount:  30.00
Total:      230.00
`);
  expect("J vatAmount", r.vatAmount, 30);
  expect("J total",     r.total,     230);
}

// ── K: Zero-rated receipt ─────────────────────────────────────────────────────
section("K: Zero-rated receipt — no VAT estimation");
{
  const r = parseReceiptText(`
Medical Clinic
Items (VAT exempt / zero-rated)
Total: 500.00
`);
  expect("K total",     r.total,     500);
  expect("K vatAmount", r.vatAmount, 0);
}

// ── L: Double-dot OCR artefact ────────────────────────────────────────────────
section("L: Double-dot OCR artefact (1.150.00)");
{
  const r = parseReceiptText(`
Supermarket
Subtotal:  1.000.00
VAT:         150.00
Total:     1.150.00
`);
  expect("L subtotal",  r.subtotal,  1000);
  expect("L total",     r.total,     1150);
}

// ── M: Only total present — derive ───────────────────────────────────────────
section("M: Only total present — derive subtotal + VAT at 15%");
{
  const r = parseReceiptText(`
Fuel Station
Total Amount: 115.00
`);
  expect("M total",     r.total,     115);
  expect("M vatAmount", r.vatAmount, 15);
  expect("M subtotal",  r.subtotal,  100);
}

// ── N: Large thousands-separated amounts ──────────────────────────────────────
section("N: Large amounts with thousands separators");
{
  const r = parseReceiptText(`
Furniture Palace
Subtotal:    10,000.00
VAT (15%):    1,500.00
Grand Total: 11,500.00
`);
  expect("N subtotal",  r.subtotal,  10000);
  expect("N vatAmount", r.vatAmount, 1500);
  expect("N total",     r.total,     11500);
}

// ── O: Swapped subtotal / total rows ─────────────────────────────────────────
section("O: Swapped subtotal / total rows");
{
  const r = parseReceiptText(`
Mixed Up Store
Subtotal:  1,150.00
VAT:         150.00
Total:     1,000.00
`);
  expect("O total >= subtotal", r.total >= r.subtotal, true);
  expect("O total",    r.total,   1150);
  expect("O subtotal", r.subtotal, 1000);
}

// ── P: SAR prefix on every amount ─────────────────────────────────────────────
section("P: SAR prefix on every amount");
{
  const r = parseReceiptText(`
Al Meera
Net Amount:  SAR 86.96
VAT Amount:  SAR 13.04
Total:       SAR 100.00
`);
  expect("P subtotal",  r.subtotal,  86.96);
  expect("P vatAmount", r.vatAmount, 13.04);
  expect("P total",     r.total,     100);
}

// ── Q: No labels — last-resort ────────────────────────────────────────────────
section("Q: No labels — last-resort picks largest monetary number");
{
  const r = parseReceiptText(`
Simple Cafe
86.96
13.04
100.00
`);
  expect("Q total", r.total, 100);
}

// ── R: Mixed Arabic/English ───────────────────────────────────────────────────
section("R: Mixed Arabic/English");
{
  const r = parseReceiptText(`
Al-Futtaim
الرقم الضريبي: 310122445500031
Date: 10/06/2026
المبلغ قبل الضريبة: 1,000.00
VAT 15%:             150.00
Total Amount:      1,150.00
`);
  expect("R subtotal",  r.subtotal,  1000);
  expect("R vatAmount", r.vatAmount, 150);
  expect("R total",     r.total,     1150);
}

// ── S: Real ZATCA simplified invoice with date in total row ───────────────────
// Mirrors the actual receipt from the user screenshot.
// OCR of this kind of receipt produces the date "2025/11/02" on the same
// line as "Total with vat" because of the multi-column table layout.
section("S: Real ZATCA receipt — date digits in total row, ريال-tagged amounts");
{
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
  expect("S subtotal",  r.subtotal,  124);
  expect("S vatAmount", r.vatAmount, 18);
  expect("S total",     r.total,     142);
  expect("S date",      r.date,      "2025-11-02");
}

// ── T: Date on same line as total label, amount after label ───────────────────
section("T: Date embedded in total line — amount must not be the date's day");
{
  const r = parseReceiptText(`
Shop Name
Date: 2026-07-02
VAT:  SAR 15.00
Total with VAT 2026/07/02: SAR 115.00
`);
  expect("T total",     r.total,     115);
  expect("T vatAmount", r.vatAmount, 15);
}

// ── U: ريال after each amount (Arabic receipt style) ─────────────────────────
section("U: ريال-tagged amounts — Arabic style");
{
  const r = parseReceiptText(`
المطعم الذهبي
التاريخ: 2026/07/15
غير شامل الضريبة: 86.96 ريال
ضريبة القيمة المضافة: 13.04 ريال
شامل الضريبة: 100.00 ريال
`);
  expect("U subtotal",  r.subtotal,  86.96);
  expect("U vatAmount", r.vatAmount, 13.04);
  expect("U total",     r.total,     100);
}

// ── V: "Total without vat" correctly goes to subtotal ────────────────────────
section("V: 'Total without vat' label mapped to subtotal");
{
  const r = parseReceiptText(`
Electronics Store
Total without vat: 200.00
Vat (15%):          30.00
Total with vat:    230.00
`);
  expect("V subtotal",  r.subtotal,  200);
  expect("V vatAmount", r.vatAmount, 30);
  expect("V total",     r.total,     230);
}

// ── summary ──────────────────────────────────────────────────────────────────
console.log(`\n══ Results: ${passed} passed, ${failed} failed ══`);
if (failed > 0) process.exit(1);
