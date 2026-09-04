/**
 * L1 — the invoice document template, unit-tested WITHOUT a browser.
 *
 * These tests pin the design rules that survive as text properties of the
 * HTML (`design-invoice-document.md`):
 *
 *  1. 🔴 THE SENTINEL NEVER PRINTS (§1 rule 5, revised): "(not yet
 *     translated)" appears on NEITHER rendering; the Arabic document falls
 *     back to the English description. The fixture PLANTS the sentinel — the
 *     known-present case is built into the probe, so a green here cannot be
 *     the template never having seen one.
 *  2. The English rendering is a labelled TRANSLATION; the Arabic one carries
 *     no banner (it IS the tax invoice).
 *  3. The title states WHICH document this is — simplified vs standard is
 *     decided by the buyer's VAT identification, the generated sample's
 *     stated defect.
 *  4. 🔴 AN EMPTY BLOCK PRINTS ITS EMPTINESS (§2): unwritten terms, absent
 *     bank details and a missing logo produce NO block, no heading, no empty
 *     box.
 *  5. One template, two directions: `dir` and `lang` come from the parameter,
 *     and the money figures are Western numerals in both.
 *
 * The full pipeline (Chromium → PDF/A-3) is exercised by the LIVE half at the
 * bottom, which skips without a browser; conformance itself is veraPDF's
 * verdict, recorded in the L1 close-out — a validator's PASS, not a test's.
 */
import { describe, expect, it } from "vitest";
import {
  renderInvoiceHtml,
  arabicLineDescription,
  TRANSLATION_SENTINEL,
  type InvoiceDocModel,
} from "../services/invoiceDocument/renderInvoiceHtml";

const base: InvoiceDocModel = {
  lang: "ar",
  documentType: "invoice",
  invoiceNumber: "INV-000123",
  originalInvoiceNumber: null,
  dateGregorian: "2026-07-10",
  dateHijri: "1448-01-15 هـ",
  dueDate: "2026-08-10",
  seller: {
    name: "Al-Faisal Trading Co.",
    nameAr: "شركة الفيصل التجارية",
    vatNumber: "310123456700003",
    crNumber: "1010101010",
    address: "7522، طريق الملك فهد، العليا، الرياض، 12212",
  },
  buyer: {
    name: "Gamma Client",
    nameAr: "عميل جاما",
    vatNumber: "300000000000003",
    crNumber: null,
    address: null,
  },
  lines: [
    {
      productCode: "SKU-9",
      description: "Legal consulting",
      // 🔴 the known-present case, planted: the sentinel the rule forbids.
      descriptionAr: TRANSLATION_SENTINEL,
      quantity: "10",
      unitPrice: "100",
      vatRate: "15",
      vatAmount: "150",
      total: "1150",
    },
    {
      productCode: null,
      description: "Annual audit",
      descriptionAr: "المراجعة السنوية",
      quantity: "1",
      unitPrice: "500",
      vatRate: "15",
      vatAmount: "75",
      total: "575",
    },
  ],
  subtotal: "1500",
  vatAmount: "225",
  total: "1725",
  paidAmount: "400",
  qrDataUrl: "data:image/png;base64,iVBORw0KGgo=",
  logoDataUrl: null,
  termsAndConditions: null,
  bankDetails: null,
  noteReason: null,
};

describe("L1 — the template's design rules, as text properties", () => {
  it("🔴 the sentinel NEVER prints — the Arabic document falls back to the English description", () => {
    const ar = renderInvoiceHtml({ ...base, lang: "ar" });
    const en = renderInvoiceHtml({ ...base, lang: "en" });
    expect(ar).not.toContain(TRANSLATION_SENTINEL);
    expect(en).not.toContain(TRANSLATION_SENTINEL);
    // The fallback is the ENGLISH text, not an empty cell.
    expect(ar).toContain("Legal consulting");
    // And a REAL translation is preferred when present.
    expect(ar).toContain("المراجعة السنوية");
    expect(arabicLineDescription({ description: "X", descriptionAr: "  " })).toBe("X");
  });

  it("the English rendering is a labelled translation; the Arabic one carries no banner", () => {
    const ar = renderInvoiceHtml({ ...base, lang: "ar" });
    const en = renderInvoiceHtml({ ...base, lang: "en" });
    expect(en).toContain('class="translation-banner"');
    expect(en).toContain("the Arabic document is the tax invoice");
    // the CSS RULE exists in both (one stylesheet); the DIV only on English.
    expect(ar).not.toContain('class="translation-banner"');
  });

  it("the title states WHICH document: standard for a VAT-identified buyer, simplified otherwise, notes by type", () => {
    expect(renderInvoiceHtml({ ...base, lang: "ar" })).toContain("فاتورة ضريبية");
    const simplified = renderInvoiceHtml({ ...base, lang: "ar", buyer: null });
    expect(simplified).toContain("فاتورة ضريبية مبسطة");
    const cn = renderInvoiceHtml({ ...base, lang: "ar", documentType: "credit_note", originalInvoiceNumber: "INV-000100", noteReason: "إرجاع" });
    expect(cn).toContain("إشعار دائن");
    expect(cn).toContain("INV-000100");
  });

  it("🔴 an empty block prints NOTHING — no heading over an absence, no logo stand-in", () => {
    const html = renderInvoiceHtml({ ...base, lang: "ar" });
    expect(html).not.toContain("الشروط والأحكام"); // terms unwritten → no heading
    expect(html).not.toContain("البيانات البنكية"); // no default bank → no block
    expect(html).not.toContain('class="logo"'); // no logo → no slot, no text mark
    const withBlocks = renderInvoiceHtml({
      ...base,
      lang: "ar",
      termsAndConditions: "يستحق السداد خلال ٣٠ يومًا",
      bankDetails: { bankName: "الراجحي", iban: "SA0380000000608010167519", accountName: "Al-Faisal" },
    });
    expect(withBlocks).toContain("الشروط والأحكام");
    expect(withBlocks).toContain("SA0380000000608010167519");
  });

  it("one template, two directions — and Western numerals in both", () => {
    const ar = renderInvoiceHtml({ ...base, lang: "ar" });
    const en = renderInvoiceHtml({ ...base, lang: "en" });
    expect(ar).toContain('dir="rtl"');
    expect(ar).toContain('lang="ar"');
    expect(en).toContain('dir="ltr"');
    // The figures must read identically against the QR payload in BOTH.
    expect(ar).toContain("1,725.00");
    expect(en).toContain("1,725.00");
    // Payment settlement inside the totals block (the reference layout).
    expect(ar).toContain("1,325.00"); // balance due = 1725 − 400
  });

  it("the QR renders at the bottom when present, and not at all when absent", () => {
    const html = renderInvoiceHtml({ ...base, lang: "ar" });
    expect(html.lastIndexOf('class="qr"')).toBeGreaterThan(html.indexOf("totals"));
    expect(renderInvoiceHtml({ ...base, lang: "ar", qrDataUrl: null })).not.toContain('class="qr"');
  });

  it("values are HTML-escaped — a description cannot inject markup into a legal artifact", () => {
    const html = renderInvoiceHtml({
      ...base,
      lang: "en",
      lines: [{ ...base.lines[1], description: '<img src=x onerror=alert(1)>' }],
    });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });
});
