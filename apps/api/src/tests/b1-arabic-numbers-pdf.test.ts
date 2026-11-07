/**
 * 🔴 Carry-over Batch 1, W-21 (the owner, 2026-11-07; the first walk's finding): the Arabic invoice document printed its
 * VAT percentage as "٪١٥", in Eastern digits, while every other number on it, and in the app, is Latin. It follows the
 * app's convention: "15%", as the web app already writes "ضريبة القيمة المضافة 15%".
 */
import { describe, expect, it } from "vitest";
import { renderInvoiceHtml, type InvoiceDocModel } from "../services/invoiceDocument/renderInvoiceHtml";

const model = (lang: "ar" | "en"): InvoiceDocModel => ({
  lang, documentType: "invoice", invoiceNumber: "INV-W21-1", originalInvoiceNumber: null,
  dateGregorian: "2026-11-07", dateHijri: "1448-05-27 هـ", dueDate: "2026-11-30",
  seller: { name: "W21 Seller Co", nameAr: "شركة البائع", vatNumber: "310123456700003", crNumber: "1010101010", address: null },
  buyer: { name: "W21 Buyer", nameAr: "المشتري", vatNumber: null, crNumber: null, address: null },
  lines: [{ productCode: null, description: "Work", descriptionAr: "عمل", quantity: "1", unitPrice: "100", vatRate: "15", vatAmount: "15", total: "115" }],
  subtotal: "100", vatAmount: "15", total: "115", paidAmount: "0",
  qrDataUrl: "data:image/png;base64,iVBORw0KGgo=", logoDataUrl: null, termsAndConditions: null, bankDetails: null, noteReason: null,
});

describe("W-21 — the document's VAT percentage follows the app's digits", () => {
  it("🔴 the Arabic document prints the VAT rate in Latin digits", () => {
    const ar = renderInvoiceHtml(model("ar"));
    expect(ar).toContain("ضريبة القيمة المضافة 15%");
    expect(ar).not.toContain("١٥");
  });

  it("the English document is unchanged", () => {
    expect(renderInvoiceHtml(model("en"))).toContain("VAT 15%");
  });
});
