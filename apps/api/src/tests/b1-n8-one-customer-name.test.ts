/**
 * 🔴 Carry-over Batch 1, N-8 (the owner, 2026-11-07): one customer, one name per language.
 *  - ONE rule, `displayName` in @workspace/shared: Arabic → the Arabic name when set (not blank, not the translation
 *    sentinel), else the English; English → the English name, else the Arabic. The web app's `n()` and the invoice
 *    document both call it.
 *  - An ISSUED invoice names its buyer from the snapshot taken at issue (G32), never the live customer: after the
 *    customer is renamed, the issued invoice keeps its names (list and detail) and a draft follows the customer.
 *  - The responses carry `customerNameAr` beside `customerName` (invoice, customer ledger), so a screen can apply the rule.
 *
 * The rule's cases run without a database; the HTTP cases are DB-backed (sl_test / CI) and skip on the placeholder.
 */
process.env.PORT ??= "3272";
process.env.SESSION_SECRET ??= "b1-n8-one-customer-name-secret1";
process.env.CORS_ALLOWED_ORIGINS ??= "http://localhost:5173";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TRANSLATION_SENTINEL, displayName } from "@workspace/shared";
import { renderInvoiceHtml, type InvoiceDocModel } from "../services/invoiceDocument/renderInvoiceHtml";
import { g04Harness } from "./helpers/g04Harness";

describe("N-8 — the one name rule", () => {
  it("Arabic: the Arabic name when set; blank or the sentinel falls back to the English", () => {
    expect(displayName("Gamma Client", "عميل جاما", "ar")).toBe("عميل جاما");
    expect(displayName("Gamma Client", "  ", "ar")).toBe("Gamma Client");
    expect(displayName("Gamma Client", null, "ar")).toBe("Gamma Client");
    expect(displayName("Gamma Client", TRANSLATION_SENTINEL, "ar")).toBe("Gamma Client");
  });

  it("🔴 English: the English name when set, else the Arabic (never the sentinel)", () => {
    expect(displayName("Gamma Client", "عميل جاما", "en")).toBe("Gamma Client");
    expect(displayName("", "عميل جاما", "en")).toBe("عميل جاما");
    expect(displayName("  ", "عميل جاما", "en")).toBe("عميل جاما");
    expect(displayName("", TRANSLATION_SENTINEL, "en")).toBe("");
  });

  const doc = (lang: "ar" | "en", buyer: { name: string; nameAr: string | null }): string => {
    const model: InvoiceDocModel = {
      lang, documentType: "invoice", invoiceNumber: "INV-N8-1", originalInvoiceNumber: null,
      dateGregorian: "2026-11-07", dateHijri: "1448-05-27 هـ", dueDate: "2026-11-30",
      seller: { name: "N8 Seller Co", nameAr: "شركة البائع", vatNumber: "310123456700003", crNumber: "1010101010", address: null },
      buyer: { ...buyer, vatNumber: null, crNumber: null, address: null },
      lines: [{ productCode: null, description: "Work", descriptionAr: "عمل", quantity: "1", unitPrice: "100", vatRate: "15", vatAmount: "15", total: "115" }],
      subtotal: "100", vatAmount: "15", total: "115", paidAmount: "0",
      qrDataUrl: "data:image/png;base64,iVBORw0KGgo=", logoDataUrl: null, termsAndConditions: null, bankDetails: null, noteReason: null,
    };
    return renderInvoiceHtml(model);
  };

  it("🔴 the invoice document applies the same rule: the English document falls back to the Arabic name", () => {
    expect(doc("ar", { name: "Gamma Client", nameAr: "عميل جاما" })).toContain("عميل جاما");
    expect(doc("en", { name: "Gamma Client", nameAr: "عميل جاما" })).toContain("Gamma Client");
    const en = doc("en", { name: "", nameAr: "عميل جاما" });
    expect(en, "an English document with no English buyer name prints the Arabic one").toContain("عميل جاما");
  });
});

const url = process.env.DATABASE_URL;
const REAL_DB = !!url && !url.includes("placeholder");
const describeMaybe = REAL_DB ? describe : describe.skip;
const PW = "B1N8OneCustomerName1!";
const EN = "N8 English Trading";
const AR = "شركة ن ثمانية";
const EN_LATER = "N8 Renamed Trading";
const AR_LATER = "شركة الاسم الجديد";

describeMaybe("N-8 — issued invoices keep their issue-time names; the responses carry both names", () => {
  const h = g04Harness("b1n8names");
  let customerId = 0, issuedId = 0, draftId = 0;

  beforeAll(async () => {
    await h.cleanup();
    const orgId = await h.mkOrg("org");
    await h.mkCompany(orgId, "N8 Co", "399999999999973");
    await h.mkUser("admin", PW, orgId, "admin");
    await h.start();
    expect(await h.login("admin", h.email("admin"), PW)).toBe(200);
    const body = (r: { status: number; body: any }, what: string) => { expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r.body; };
    customerId = body(await h.api("admin", "POST", "/customers", { name: EN, nameAr: AR }), "customer").id;
    body(await h.api("admin", "POST", "/bank-accounts", { name: "N8 Bank", bankName: "SNB", currency: "SAR", isDefault: true }), "bank");
    const invoice = (n: string) => ({ invoiceNumber: n, date: "2026-11-01", dueDate: "2026-11-30", customerId, items: [{ description: "N8 work", quantity: 1, unitPrice: 1000, vatRate: 15 }] });
    issuedId = body(await h.api("admin", "POST", "/invoices", invoice("N8-ISSUED-1")), "to issue").id;
    body(await h.api("admin", "POST", `/invoices/${issuedId}/approve`), "issue");
    draftId = body(await h.api("admin", "POST", "/invoices", invoice("N8-DRAFT-1")), "draft").id;
  }, 120_000);

  afterAll(async () => { await h.stop(); await h.cleanup(); });

  const names = async (id: number) => {
    const r = await h.api("admin", "GET", `/invoices/${id}`);
    expect(r.status).toBe(200);
    return [r.body.customerName, r.body.customerNameAr];
  };
  const listed = async (id: number) => {
    const r = await h.api("admin", "GET", "/invoices?limit=200");
    expect(r.status).toBe(200);
    const row = (r.body.items ?? r.body).find((i: any) => i.id === id);
    return [row?.customerName, row?.customerNameAr];
  };

  it("both names on the detail and in the list, for an issued invoice and a draft", async () => {
    for (const id of [issuedId, draftId]) {
      expect(await names(id)).toEqual([EN, AR]);
      expect(await listed(id)).toEqual([EN, AR]);
    }
  });

  it("🔴 after the customer is renamed, the issued invoice keeps its issue-time names; the draft follows", async () => {
    const r = await h.api("admin", "PATCH", `/customers/${customerId}`, { name: EN_LATER, nameAr: AR_LATER });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await names(issuedId), "issued, detail: the snapshot").toEqual([EN, AR]);
    expect(await listed(issuedId), "issued, list: the snapshot").toEqual([EN, AR]);
    expect(await names(draftId), "draft, detail: the live customer").toEqual([EN_LATER, AR_LATER]);
    expect(await listed(draftId), "draft, list: the live customer").toEqual([EN_LATER, AR_LATER]);
  });

  it("the customer ledger carries the Arabic name beside the English", async () => {
    const r = await h.api("admin", "GET", "/reports/customer-ledger");
    expect(r.status).toBe(200);
    const customers = r.body.customers ?? r.body;
    const row = customers.find((c: any) => c.customerId === customerId);
    expect([row?.customerName, row?.customerNameAr]).toEqual([EN_LATER, AR_LATER]);
  });
});
