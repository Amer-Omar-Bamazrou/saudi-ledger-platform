/**
 * PHASE 13B-3 — A SUPPLIER CREDIT NOTE THE VAT LEDGER REFUSES, BY CLICKING (2026-09-29).
 * Records: docs/product/phase-13b2-credit-note-event-design.md §19.4 (O-2), §16A (D-6);
 *          docs/product/phase-13b-vat-claim-ledger-architecture.md §26.
 *
 * 13B-3 records every supplier credit note as an event of the bill it
 * corrects, and refuses — BEFORE anything posts — a note whose VAT exceeds what
 * the bill charged less its other notes (O-2 rule 1, IR Art. 54(1); D-1 posted
 * these before) and a note dated before its bill (D-6). What only a browser
 * shows: 🔴 the refusal REACHES THE USER from the page's own Post button (a
 * server refusal nobody surfaces is indistinguishable from a frozen screen),
 * the note stays a draft, and a note the ledger admits still posts — in
 * English and Arabic (dir=rtl), on a desktop and on a 390 px phone.
 */
import { test, expect, request as pwRequest, type APIRequestContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { E2E, SEEDED_IDS_PATH, type SeededIds } from "./global-setup";

test.use({ storageState: E2E.storageState });

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };
const STAMP = Date.now();
const BILL_NO = `E2E-13B3-B-${STAMP}`;

let api: APIRequestContext;
let billId = 0, overId = 0, earlyId = 0, okId = 0;

const noSidewaysScroll = async (page: Page, width: number, what: string) => {
  const w = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(w, `${what}: no sideways page scroll`).toBeLessThanOrEqual(width + 1);
};
const statusOf = async (id: number) => (await (await api.get(`/api/bills/${id}`)).json()).status as string;
const note = async (number: string, date: string, subtotal: number, vatAmount: number) => {
  const res = await api.post("/api/bills", {
    data: { documentType: "credit_note", creditNoteAgainstBillId: billId, billNumber: number, vendorReference: `SUP-${number}`, date, subtotal, vatAmount, total: subtotal + vatAmount, items: [] },
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).id as number;
};

test.beforeAll(async () => {
  api = await pwRequest.newContext({ baseURL: "http://localhost:5173", storageState: E2E.storageState });
  const ids = JSON.parse(readFileSync(SEEDED_IDS_PATH, "utf8")) as SeededIds;
  // One claimed bill: 1,000 net, VAT 150, the supplier's tax invoice.
  const draft = await (await api.post("/api/bills", {
    data: {
      billNumber: BILL_NO, date: "2026-06-10", dueDate: "2026-07-10", vendorId: ids.vendorId, vendorReference: `SUP-${BILL_NO}`,
      supplierDocumentKind: "tax_invoice", items: [{ description: "E2E 13B-3 supply", quantity: 1, unitPrice: 1000, vatRate: 15 }],
    },
  })).json();
  const posted = await (await api.post(`/api/bills/${draft.id}/approve`, { data: {} })).json();
  billId = posted.id;
  expect(Number(posted.vatAmount)).toBe(150);
  // Three drafts: VAT 200 on a bill that charged 150 (the total, 210, is within the bill's 1,150 — so the
  // old create-time cap, which bounds TOTALS, lets it through); one dated the day before the bill; one fine.
  overId = await note(`E2E-13B3-OVER-${STAMP}`, "2026-06-20", 10, 200);
  earlyId = await note(`E2E-13B3-EARLY-${STAMP}`, "2026-06-09", 100, 15);
  okId = await note(`E2E-13B3-OK-${STAMP}`, "2026-06-21", 100, 15);
});
test.afterAll(async () => { await api.dispose(); });

test.describe.serial("Phase 13B-3 — the ledger's refusals reach the user", () => {
  for (const [lang, viewport, label] of [
    ["en", DESKTOP, "EN desktop"],
    ["en", PHONE, "EN phone"],
    ["ar", DESKTOP, "AR desktop"],
    ["ar", PHONE, "AR phone"],
  ] as const) {
    test(`🔴 ${label}: posting an OVER-CREDIT note is refused with the reason in view; the note stays a draft`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto("/supplier-credit-notes");
      await page.evaluate((l) => localStorage.setItem("ksa_lang", l), lang);
      await page.reload();
      await expect(page.locator("html")).toHaveAttribute("dir", lang === "ar" ? "rtl" : "ltr");
      await expect(page.getByTestId("page-supplier-credit-notes")).toBeVisible();
      if (lang === "ar") await expect(page.getByRole("heading", { name: /إشعارات الدائن من الموردين/ }).first()).toBeVisible();

      await page.getByTestId(`approve-note-${overId}`).click();
      const toast = page.getByRole("status").filter({ hasText: lang === "ar" ? "مرفوض" : "Refused" });
      await expect(toast, `${label}: the refusal is shown`).toBeVisible();
      await expect(toast).toContainText(/cannot credit more VAT than the invoice charged/);
      await expect(toast).toContainText(/only 150\.00 of the 150\.00 VAT charged on/);
      await noSidewaysScroll(page, viewport.width, `${label} with the refusal in view`);
      expect(await statusOf(overId), "nothing posted").toBe("draft");
      await expect(page.getByTestId(`note-status-${overId}`)).toHaveText(/draft|مسودة/);
      await page.evaluate(() => localStorage.setItem("ksa_lang", "en"));
    });
  }

  test("🔴 D-6: a note dated BEFORE its bill is refused, in words, from the page (EN desktop and AR phone)", async ({ page }) => {
    for (const [lang, viewport] of [["en", DESKTOP], ["ar", PHONE]] as const) {
      await page.setViewportSize(viewport);
      await page.goto("/supplier-credit-notes");
      await page.evaluate((l) => localStorage.setItem("ksa_lang", l), lang);
      await page.reload();
      await page.getByTestId(`approve-note-${earlyId}`).click();
      const toast = page.getByRole("status").filter({ hasText: lang === "ar" ? "مرفوض" : "Refused" });
      await expect(toast).toBeVisible();
      await expect(toast).toContainText(/dated 2026-06-09, before/);
      expect(await statusOf(earlyId)).toBe("draft");
    }
    await page.evaluate(() => localStorage.setItem("ksa_lang", "en"));
  });

  test("🔴 a note the ledger ADMITS still posts by clicking — and afterwards the over-credit is still refused (the bound counts the posted note)", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto("/supplier-credit-notes");
    await page.getByTestId(`approve-note-${okId}`).click();
    await expect(page.getByRole("status").filter({ hasText: "Note posted" })).toBeVisible();
    await expect(page.getByTestId(`note-status-${okId}`)).not.toHaveText("draft");
    expect(await statusOf(okId)).not.toBe("draft");
    await page.reload();
    await page.getByTestId(`approve-note-${overId}`).click();
    await expect(page.getByRole("status").filter({ hasText: "Refused" })).toContainText(/only 135\.00 of the 150\.00 VAT charged on/);
  });
});
