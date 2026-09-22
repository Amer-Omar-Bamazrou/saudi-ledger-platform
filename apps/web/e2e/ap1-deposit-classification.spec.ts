/**
 * AP-1 — DEPOSIT CLASSIFICATION AND THE VAT REVIEW LIST, WALKED BY CLICKING
 * (2026-09-20). Decision record: docs/product/advance-payments-decision-pack.md §9.
 *
 * Every flow drives the real page — the receipt dialog, the classify dialog's
 * Radix selects, the VAT page's panel — and reads the effect back from the
 * API (the receipt's classification, the review list's state, the return's
 * summary). The claims: an unclassified deposit is VISIBLE on the VAT page as
 * needing review; classifying it changes the server's state (advance → the
 * Art. 53(1)(b) deadline; erroneous → no VAT expected); the existing
 * allocation and refund flows still work on a classified receipt and the
 * classification survives them; nothing posts. English desktop, then a
 * phone, then Arabic under dir=rtl on both.
 */
import { test, expect, request as pwRequest, type APIRequestContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { E2E, SEEDED_IDS_PATH, type SeededIds } from "./global-setup";

test.use({ storageState: E2E.storageState });

const PHONE = { width: 390, height: 844 };

type Classification = { classification: string; vatCategory: string | null; note: string | null } | null;
type Payment = { id: number; amount: number; unappliedAmount: number; allocatedAmount: number; refundedAmount: number; classification: Classification; journalEntryId: number };
type ReviewItem = { paymentId: number; reviewState: string; needsReview: boolean; deadline: string | null; overdue: boolean; classification: string; unappliedAmount: number };
type Review = { asOf: string; today: string; items: ReviewItem[]; needsReviewCount: number; needsReviewAmount: number; overdueCount: number };
type VatReturn = { depositReview: { asOf: string; needsReviewCount: number; needsReviewAmount: number; overdueCount: number }; salesSection: { box6_vatOnStandardRatedSales: number } };

let api: APIRequestContext;
let ids: SeededIds;

const toast = (page: Page, title: string) => page.getByText(title, { exact: true }).first();
async function pickOption(page: Page, trigger: ReturnType<Page["getByTestId"]>, optionText: RegExp) {
  await trigger.click();
  await page.getByRole("option", { name: optionText }).click();
}
const payment = async (id: number): Promise<Payment> => (await api.get(`/api/payments/${id}`)).json();
const review = async (): Promise<Review> => (await api.get(`/api/payments/deposit-review`)).json();
const vatReturn = async (): Promise<VatReturn> => (await api.get(`/api/reports/vat-return`)).json();
const reviewItem = async (id: number) => (await review()).items.find((i) => i.paymentId === id);
const journalCount = async (): Promise<number> => ((await (await api.get(`/api/journal-entries?limit=1`)).json()) as { page: { total: number } }).page.total;

async function expectFits(dialog: ReturnType<Page["getByTestId"]>, width: number, message: string) {
  await expect(dialog).toBeVisible();
  await expect.poll(async () => {
    const box = await dialog.boundingBox();
    return !!box && box.x >= 0 && box.x + box.width <= width + 1;
  }, { message, timeout: 5_000 }).toBe(true);
}
const noSidewaysScroll = async (page: Page, width: number, what: string) => {
  const w = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(w, `${what}: no sideways page scroll`).toBeLessThanOrEqual(width + 1);
};

test.beforeAll(async () => {
  api = await pwRequest.newContext({ baseURL: "http://localhost:5173", storageState: E2E.storageState });
  ids = JSON.parse(readFileSync(SEEDED_IDS_PATH, "utf8")) as SeededIds;
});
test.afterAll(async () => { await api.dispose(); });

/** Record a receipt on account from the customer page, optionally classifying it in the dialog, and return its id. */
async function recordReceipt(page: Page, amount: number, lang: "en" | "ar", classify?: { option: RegExp; vat?: RegExp }): Promise<number> {
  const reference = `AP1-RCPT-${Date.now()}`;
  await page.getByTestId("record-receipt").click();
  const dialog = page.getByTestId("receive-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByTestId("receive-amount").fill(String(amount));
  await pickOption(page, dialog.getByTestId("receive-bank-account"), /E2E Current Account/);
  await dialog.getByTestId("receive-reference").fill(reference);
  if (classify) {
    await pickOption(page, dialog.getByTestId("receive-classification"), classify.option);
    if (classify.vat) await pickOption(page, dialog.getByTestId("receive-vat-category"), classify.vat);
  }
  await dialog.getByTestId("receive-submit").click();
  await expect(toast(page, lang === "ar" ? "تم تسجيل الإيصال" : "Receipt recorded")).toBeVisible();
  await expect(dialog).toBeHidden();
  const list: Array<{ id: number; reference: string | null }> = await (await api.get(`/api/payments?customer_id=${ids.customerId}&limit=200`)).json();
  const p = list.find((x) => x.reference === reference);
  if (!p) throw new Error("e2e: the recorded receipt was not listed");
  return p.id;
}

async function openReceipt(page: Page, paymentId: number) {
  await page.goto(`/customers/${ids.customerId}`, { waitUntil: "networkidle" });
  const toggle = page.getByTestId(`payment-toggle-${paymentId}`);
  await expect(toggle).toBeVisible();
  await toggle.click();
  const detail = page.getByTestId(`payment-detail-${paymentId}`);
  await expect(detail).toBeVisible();
  return detail;
}

/** Classify through the detail card's dialog; returns after the toast. */
async function classify(page: Page, detail: ReturnType<Page["getByTestId"]>, paymentId: number, option: RegExp, lang: "en" | "ar", opts: { vat?: RegExp; note?: string } = {}) {
  await detail.getByTestId(`classify-${paymentId}`).click();
  const dialog = page.getByTestId("classify-dialog");
  await expect(dialog).toBeVisible();
  await pickOption(page, dialog.getByTestId("classify-select"), option);
  if (opts.vat) await pickOption(page, dialog.getByTestId("classify-vat-category"), opts.vat);
  if (opts.note) await dialog.getByTestId("classify-note").fill(opts.note);
  await dialog.getByTestId("classify-submit").click();
  await expect(toast(page, lang === "ar" ? "تم تصنيف العربون" : "Deposit classified")).toBeVisible();
  await expect(dialog).toBeHidden();
  return dialog;
}

test.describe("AP-1 — English desktop", () => {
  test("🔴 an unclassified deposit is VISIBLE on the VAT page as needing review; classify → advance (deadline) → erroneous (no VAT); the return's summary follows; nothing posts", async ({ page }) => {
    await page.goto(`/customers/${ids.customerId}`, { waitUntil: "networkidle" });
    const journalsBefore = await journalCount();
    const id = await recordReceipt(page, 500, "en"); // "Decide later" is the default
    const p0 = await payment(id);
    expect(p0.classification, "no statement yet").toBeNull();
    await expect(page.getByTestId(`classification-${id}`)).toHaveAttribute("data-classification", "unknown");
    await expect(page.getByTestId(`classification-${id}`)).toContainText("Not yet classified");

    // The VAT page: the deposit is listed, flagged, and counted in the return's own summary.
    await page.goto("/vat", { waitUntil: "networkidle" });
    const card = page.getByTestId("deposit-review-card");
    await expect(card).toContainText("Customer deposits held");
    const row = page.getByTestId(`deposit-review-${id}`);
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute("data-review-state", "unclassified");
    await expect(row).toHaveAttribute("data-needs-review", "1");
    await expect(row).toContainText("Needs classification");
    await expect(row).toContainText("500.00");
    const listed = await review();
    const item = listed.items.find((i) => i.paymentId === id)!;
    expect(item.reviewState).toBe("unclassified");
    expect(item.needsReview).toBe(true);
    const ret = await vatReturn();
    expect(ret.depositReview.needsReviewCount, "the return carries the list's own count").toBe(listed.needsReviewCount);
    expect(ret.depositReview.needsReviewAmount).toBe(Math.round(listed.needsReviewAmount * 100) / 100);
    await expect(page.getByTestId("deposit-review-summary")).toContainText(`Needs review: ${listed.needsReviewCount}`);
    const countBefore = listed.needsReviewCount;

    // Classify as an ADVANCE (S) — the state and the deadline are the server's.
    const detail = await openReceipt(page, id);
    await expect(detail.getByTestId(`deposit-classification-${id}`)).toContainText("Nobody has said what this money is yet");
    await classify(page, detail, id, /Advance for a supply/, "en", { vat: /standard rate/, note: "30% on order PO-77" });
    await expect(page.getByTestId(`classification-${id}`).first()).toContainText("Advance for a supply · S");
    await expect(detail.getByTestId(`deposit-classification-${id}`)).toContainText("30% on order PO-77");
    const p1 = await payment(id);
    expect(p1.classification).toMatchObject({ classification: "advance", vatCategory: "S", note: "30% on order PO-77" });
    const adv = (await reviewItem(id))!;
    expect(adv.reviewState).toBe("advance_not_invoiced");
    expect(adv.needsReview).toBe(true);
    expect(adv.deadline).toMatch(/^\d{4}-\d{2}-15$/);
    await page.goto("/vat", { waitUntil: "networkidle" });
    await expect(page.getByTestId(`deposit-review-${id}`)).toContainText("Advance — tax invoice not yet issued");
    await expect(page.getByTestId(`deposit-review-deadline-${id}`)).toContainText(`Advance tax invoice due by ${adv.deadline}`);
    await expect(page.getByTestId(`deposit-review-${id}`)).toContainText("Advance for a supply · S");

    // Reclassify as ERRONEOUS — still listed (the money is still held), no longer needing review; the count moves down by one.
    const detail2 = await openReceipt(page, id);
    await expect(detail2.getByTestId(`classify-${id}`)).toContainText("Reclassify");
    await classify(page, detail2, id, /Erroneous/, "en");
    const err = (await reviewItem(id))!;
    expect(err.reviewState).toBe("vat_silent");
    expect(err.needsReview).toBe(false);
    expect(err.deadline).toBeNull();
    expect((await review()).needsReviewCount).toBe(countBefore - 1);
    await page.goto("/vat", { waitUntil: "networkidle" });
    await expect(page.getByTestId(`deposit-review-${id}`)).toHaveAttribute("data-needs-review", "0");
    await expect(page.getByTestId(`deposit-review-${id}`)).toContainText("No VAT expected");
    await expect(page.getByTestId("deposit-review-summary")).toContainText(`Needs review: ${countBefore - 1}`);

    // Nothing posted: the receipt's own entry is the only journal this flow created; box 6 unchanged.
    expect(await journalCount(), "the receipt's entry and the reclassification (2026-09-22: a classification that changes the liability moves the balance by ONE entry), nothing else").toBe(journalsBefore + 2);
    expect((await vatReturn()).salesSection.box6_vatOnStandardRatedSales).toBe(ret.salesSection.box6_vatOnStandardRatedSales);
  });

  test("🔴 existing flows unchanged on a classified receipt: allocate keeps the classification and the remainder stays listed; refund the rest → it leaves the list", async ({ page }) => {
    await page.goto(`/customers/${ids.customerId}`, { waitUntil: "networkidle" });
    const id = await recordReceipt(page, 500, "en", { option: /Erroneous/ });
    expect((await payment(id)).classification?.classification, "classified at receipt").toBe("erroneous");

    const detail = await openReceipt(page, id);
    await detail.getByTestId(`allocate-${id}`).click();
    const dialog = page.getByTestId("allocate-dialog");
    await dialog.getByTestId("allocate-row-E2E-INV-003").getByRole("spinbutton").fill("300");
    await dialog.getByTestId("allocate-submit").click();
    await expect(toast(page, "Payment allocated")).toBeVisible();
    const p = await payment(id);
    expect(p.allocatedAmount).toBe(300);
    expect(p.unappliedAmount).toBe(200);
    expect(p.classification?.classification, "the classification survives an allocation").toBe("erroneous");
    expect((await reviewItem(id))?.unappliedAmount).toBe(200);

    const detail2 = await openReceipt(page, id);
    await detail2.getByTestId(`refund-deposit-${id}`).click();
    const rd = page.getByTestId("refund-dialog");
    await rd.getByTestId("refund-amount").fill("200");
    await pickOption(page, rd.getByTestId("refund-bank-account"), /E2E Current Account/);
    await rd.getByTestId("refund-reason").fill("Duplicate payment returned");
    await rd.getByTestId("refund-continue").click();
    await rd.getByTestId("refund-confirm").click();
    await expect(toast(page, "Refund recorded")).toBeVisible();
    expect((await payment(id)).unappliedAmount).toBe(0);
    expect(await reviewItem(id), "nothing held → not on the list").toBeUndefined();
    await page.goto("/vat", { waitUntil: "networkidle" });
    await expect(page.getByTestId(`deposit-review-${id}`)).toHaveCount(0);
  });

  test("the Payments page shows the classification column and the detail dialog can classify", async ({ page }) => {
    await page.goto(`/customers/${ids.customerId}`, { waitUntil: "networkidle" });
    const id = await recordReceipt(page, 120, "en");
    await page.goto("/payments", { waitUntil: "networkidle" });
    await expect(page.getByTestId(`payment-row-${id}`).getByTestId(`classification-${id}`)).toContainText("Not yet classified");
    await page.getByTestId(`payment-open-${id}`).click();
    const detail = page.getByTestId(`payment-detail-${id}`);
    await classify(page, detail, id, /Refundable security deposit/, "en");
    expect((await payment(id)).classification?.classification).toBe("security_deposit");
    expect((await reviewItem(id))?.reviewState).toBe("vat_silent");
  });
});

test.describe("AP-1 — English phone", () => {
  test.use({ viewport: PHONE });
  test("🔴 classify from a phone: the dialog fits; the VAT panel renders without sideways scroll", async ({ page }) => {
    await page.goto(`/customers/${ids.customerId}`, { waitUntil: "networkidle" });
    const id = await recordReceipt(page, 90, "en");
    const detail = await openReceipt(page, id);
    await detail.getByTestId(`classify-${id}`).click();
    const dialog = page.getByTestId("classify-dialog");
    await expectFits(dialog, PHONE.width, "the classify dialog fits the phone");
    await pickOption(page, dialog.getByTestId("classify-select"), /Advance for a supply/);
    await dialog.getByTestId("classify-submit").click();
    await expect(toast(page, "Deposit classified")).toBeVisible();
    expect((await reviewItem(id))?.reviewState).toBe("advance_not_invoiced");
    await page.goto("/vat", { waitUntil: "networkidle" });
    await expect(page.getByTestId(`deposit-review-${id}`)).toBeVisible();
    await noSidewaysScroll(page, PHONE.width, "VAT page on a phone");
  });
});

async function switchToArabic(page: Page) {
  await page.getByRole("button", { name: /^ع$/ }).click();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
}
async function switchToArabicOnPhone(page: Page) {
  await page.getByTestId("nav-hamburger").click();
  const drawer = page.getByTestId("nav-drawer");
  await drawer.getByRole("button", { name: /^ع$/ }).click();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await drawer.getByRole("button", { name: "إغلاق القائمة" }).click();
  await expect(drawer).toHaveCount(0);
}

test.describe("AP-1 — Arabic / RTL desktop", () => {
  test("🔴 the same flow in Arabic under dir=rtl: labels, the classify dialog, the VAT panel", async ({ page }) => {
    await page.goto(`/customers/${ids.customerId}`, { waitUntil: "networkidle" });
    await switchToArabic(page);
    const id = await recordReceipt(page, 75, "ar");
    await expect(page.getByTestId(`classification-${id}`)).toContainText("غير مصنف بعد");
    const detail = await openReceipt(page, id);
    await detail.getByTestId(`classify-${id}`).click();
    const dialog = page.getByTestId("classify-dialog");
    await expect(dialog.getByRole("heading", { name: "ما هذا العربون؟" })).toBeVisible();
    await pickOption(page, dialog.getByTestId("classify-select"), /دفعة مقدمة لتوريد/);
    await pickOption(page, dialog.getByTestId("classify-vat-category"), /النسبة الأساسية/);
    await dialog.getByTestId("classify-submit").click();
    await expect(toast(page, "تم تصنيف العربون")).toBeVisible();
    await expect(page.getByTestId(`classification-${id}`).first()).toContainText("دفعة مقدمة لتوريد · S");
    await page.goto("/vat", { waitUntil: "networkidle" });
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.getByTestId("deposit-review-card")).toContainText("عرابين العملاء المحتفظ بها");
    await expect(page.getByTestId(`deposit-review-${id}`)).toContainText("دفعة مقدمة — لم تصدر فاتورتها الضريبية بعد");
    await expect(page.getByTestId(`deposit-review-deadline-${id}`)).toContainText("الفاتورة الضريبية للدفعة المقدمة مستحقة بحلول");
    await expect(page.getByTestId("deposit-review-summary")).toContainText("تحتاج إلى مراجعة");
  });
});

test.describe("AP-1 — Arabic / RTL phone", () => {
  test.use({ viewport: PHONE });
  test("🔴 Arabic on a phone: the classify dialog fits and works; the VAT panel renders RTL without sideways scroll", async ({ page }) => {
    await page.goto(`/customers/${ids.customerId}`, { waitUntil: "networkidle" });
    await switchToArabicOnPhone(page);
    const id = await recordReceipt(page, 60, "ar", { option: /دفعة خاطئة/ });
    expect((await payment(id)).classification?.classification).toBe("erroneous");
    const detail = await openReceipt(page, id);
    await detail.getByTestId(`classify-${id}`).click();
    const dialog = page.getByTestId("classify-dialog");
    await expectFits(dialog, PHONE.width, "the Arabic classify dialog fits the phone");
    await pickOption(page, dialog.getByTestId("classify-select"), /تأمين قابل للاسترداد/);
    await dialog.getByTestId("classify-submit").click();
    await expect(toast(page, "تم تصنيف العربون")).toBeVisible();
    expect((await payment(id)).classification?.classification).toBe("security_deposit");
    await page.goto("/vat", { waitUntil: "networkidle" });
    await expect(page.getByTestId(`deposit-review-${id}`)).toContainText("لا ضريبة متوقعة");
    await noSidewaysScroll(page, PHONE.width, "VAT page in Arabic on a phone");
  });
});
