/**
 * AP-2 — THE ADVANCE TAX INVOICE (386) AND THE FINAL INVOICE'S PREPAYMENT
 * ADJUSTMENT, WALKED BY CLICKING (2026-09-21). Decision record:
 * docs/product/advance-payments-decision-pack.md §14.
 *
 * The workflow the accountant approved (A1/A2/A3), driven through the real
 * pages — the receipt dialog, the receipt card's "Issue advance tax invoice"
 * dialog, its Approve control, the New Invoice dialog's prepayment picker —
 * and every effect read back from the API: the 386's status, split and ICV;
 * the receipt's invoiced / open / un-invoiced figures; the VAT return's boxes
 * moving ONCE (the 386 in its period, the 388 net); the final invoice's
 * PrepaidAmount and amount due; the deposit review state. English desktop,
 * then a phone, then Arabic under dir=rtl on both.
 */
import { test, expect, request as pwRequest, type APIRequestContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { E2E, SEEDED_IDS_PATH, type SeededIds } from "./global-setup";
import { businessToday } from "@workspace/shared";

test.use({ storageState: E2E.storageState });

const PHONE = { width: 390, height: 844 };

type Payment = {
  id: number; amount: number; unappliedAmount: number; allocatedAmount: number; refundedAmount: number;
  classification: { classification: string; vatCategory: string | null } | null;
  advanceInvoicedAmount: number; advanceAdjustedAmount: number; advanceOpenAmount: number; uninvoicedAmount: number;
  advanceInvoices: Array<{ id: number; invoiceNumber: string; status: string; total: number; vatAmount: number; openAmount: number; adjustedAmount: number }>;
};
type Invoice = { id: number; invoiceNumber: string; status: string; documentType: string; total: number; subtotal: number; vatAmount: number; paidAmount: number; icv: number | null; advancePaymentId: number | null; prepaidAmount: number; amountDue: number; prepayments: Array<{ advanceInvoiceId: number; amount: number; taxAmount: number; allocationId: number | null }> };
type VatReturn = { salesSection: { box1_standardRatedDomesticSales: number; box6_vatOnStandardRatedSales: number }; depositReview: { needsReviewCount: number } };
type ReviewItem = { paymentId: number; reviewState: string; needsReview: boolean; uninvoicedAmount: number; advanceOpenAmount: number };

let api: APIRequestContext;
let ids: SeededIds;

const toast = (page: Page, title: string) => page.getByText(title, { exact: true }).first();
async function pickOption(page: Page, trigger: ReturnType<Page["getByTestId"]>, optionText: RegExp) {
  await trigger.click();
  await page.getByRole("option", { name: optionText }).click();
}
const payment = async (id: number): Promise<Payment> => (await api.get(`/api/payments/${id}`)).json();
const invoice = async (id: number): Promise<Invoice> => (await api.get(`/api/invoices/${id}`)).json();
const vatReturn = async (period: string): Promise<VatReturn> => (await api.get(`/api/reports/vat-return?period_from=${period}&period_to=${period}`)).json();
const reviewItem = async (id: number): Promise<ReviewItem | undefined> => (((await (await api.get(`/api/payments/deposit-review`)).json()) as { items: ReviewItem[] }).items).find((i) => i.paymentId === id);
const box = async (period: string) => { const r = await vatReturn(period); return { box1: Number(r.salesSection.box1_standardRatedDomesticSales), box6: Number(r.salesSection.box6_vatOnStandardRatedSales) }; };

/**
 * An instrument names its evidence: on failure the verdict carries the box it
 * measured and the state of the nearest sideways scroller, so a CI-only
 * failure (fonts, scroll position) can be read from the log instead of
 * guessed at.
 */
async function expectFits(el: ReturnType<Page["getByTestId"]>, width: number, message: string) {
  await expect(el).toBeVisible();
  let last = "";
  try {
    await expect.poll(async () => {
      const b = await el.boundingBox();
      const scroller = await el.evaluate((node) => {
        const sc = (node as HTMLElement).closest(".overflow-x-auto") as HTMLElement | null;
        const r = (node as HTMLElement).getBoundingClientRect();
        return { rect: { x: r.x, w: r.width }, scrollLeft: sc?.scrollLeft ?? null, scrollWidth: sc?.scrollWidth ?? null, clientWidth: sc?.clientWidth ?? null, dir: document.documentElement.dir, docScrollWidth: document.documentElement.scrollWidth };
      }).catch(() => null);
      last = JSON.stringify({ box: b, scroller });
      // 🔴 The tolerance is SYMMETRIC, and 1px is the tolerance the far edge
      // always had. CI measured this card at x = -1 in RTL (a sticky element
      // rounding inside a sideways scroller: box 350 wide in a 390 viewport,
      // document scrollWidth 390 — nothing off-screen, nothing scrollable).
      // A one-sided bound called that a failure while admitting the same
      // rounding at the other edge; the claim is "it fits the phone", and
      // the page-level noSidewaysScroll check is what proves nothing spills.
      return !!b && b.x >= -1 && b.x + b.width <= width + 1;
    }, { message, timeout: 5_000 }).toBe(true);
  } catch (err) {
    throw new Error(`${message} — measured ${last}
${(err as Error).message}`);
  }
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

/**
 * Leave the seeded customer as found: later specs (Batch 1B) assert the
 * customer's deposit balance as an exact figure. The un-invoiced part is
 * refunded (allowed); an open 386 balance is applied on a final invoice for
 * exactly that amount (the only door for it) — every amount in this spec is a
 * multiple of 1.15 so the invoice total equals the open balance to the halala.
 */
async function settleReceipt(id: number) {
  const p = await payment(id);
  if (p.uninvoicedAmount > 0.005) {
    const r = await api.post(`/api/payments/refunds`, { data: { customerId: ids.customerId, origin: "deposit", paymentId: id, amount: p.uninvoicedAmount, bankAccountId: ids.bankId, reason: "e2e settle" } });
    if (!r.ok()) throw new Error(`e2e settle: refund failed ${r.status()} ${await r.text()}`);
  }
  for (const a of p.advanceInvoices.filter((x) => x.openAmount > 0.005)) {
    const net = Math.round((a.openAmount / 1.15) * 100) / 100;
    const c = await api.post(`/api/invoices`, { data: { date: TODAY, customerId: ids.customerId, items: [{ description: "e2e settle", quantity: 1, unitPrice: net, vatRate: 15 }], prepayments: [{ advanceInvoiceId: a.id, amount: a.openAmount }] } });
    if (!c.ok()) throw new Error(`e2e settle: invoice failed ${c.status()} ${await c.text()}`);
    const inv = (await c.json()) as Invoice;
    const ap = await api.post(`/api/invoices/${inv.id}/approve`);
    if (!ap.ok()) throw new Error(`e2e settle: approve failed ${ap.status()} ${await ap.text()}`);
  }
  const after = await payment(id);
  if (after.unappliedAmount > 0.005) throw new Error(`e2e settle: ${after.unappliedAmount} still on account`);
}

/** The month the walk's receipts and invoices are dated in — this month, so nothing is closed and the return is read for it. */
// The BUSINESS day (Asia/Riyadh), never the runner's UTC date: between 21:00 and 00:00 UTC they differ, and a document dated the UTC day sorts BEFORE a receipt the product dated the Riyadh day — the night window (findings file), seen as a −5 deposit on main's CI statement.
const TODAY = businessToday();
const PERIOD = TODAY.slice(0, 7);

/** Record a receipt on account classified as an ADVANCE (S) in the receipt dialog; returns its id. */
async function recordAdvance(page: Page, amount: number, lang: "en" | "ar"): Promise<number> {
  const reference = `AP2-RCPT-${Date.now()}`;
  await page.getByTestId("record-receipt").click();
  const dialog = page.getByTestId("receive-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByTestId("receive-amount").fill(String(amount));
  await pickOption(page, dialog.getByTestId("receive-bank-account"), /E2E Current Account/);
  await dialog.getByTestId("receive-reference").fill(reference);
  await pickOption(page, dialog.getByTestId("receive-classification"), lang === "ar" ? /دفعة مقدمة لتوريد/ : /Advance for a supply/);
  await pickOption(page, dialog.getByTestId("receive-vat-category"), lang === "ar" ? /النسبة الأساسية/ : /standard rate/);
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

/** Issue a 386 from the receipt card: the dialog (draft), then Approve & issue on the row. Returns the 386. */
async function issueAdvanceFromCard(page: Page, paymentId: number, lang: "en" | "ar", amount?: number): Promise<Invoice> {
  const detail = await openReceipt(page, paymentId);
  const section = detail.getByTestId(`advance-invoices-${paymentId}`);
  await expect(section).toBeVisible();
  await section.getByTestId(`issue-advance-${paymentId}`).click();
  const dialog = page.getByTestId("advance-invoice-dialog");
  await expect(dialog).toBeVisible();
  if (amount != null) await dialog.getByTestId("advance-amount").fill(String(amount));
  await expect(dialog.getByTestId("advance-split")).toBeVisible();
  await dialog.getByTestId("advance-submit").click();
  await expect(toast(page, lang === "ar" ? "أُنشئت مسودة الفاتورة الضريبية للدفعة المقدمة" : "Advance tax invoice drafted")).toBeVisible();
  await expect(dialog).toBeHidden();
  const p = await payment(paymentId);
  const draft = p.advanceInvoices.find((a) => a.status === "draft");
  if (!draft) throw new Error("e2e: no draft 386 on the receipt after the dialog");
  expect(p.advanceInvoicedAmount, "a draft declares nothing").toBe(0);
  // the separate act: approve on the document
  await page.getByTestId(`approve-advance-${draft.id}`).click();
  await expect(toast(page, lang === "ar" ? "صدرت الفاتورة الضريبية للدفعة المقدمة" : "Advance tax invoice issued")).toBeVisible();
  await expect(page.getByTestId(`advance-invoice-${draft.id}`)).toHaveAttribute("data-status", "sent");
  return invoice(draft.id);
}

/** Create the FINAL invoice from the Invoices page, ticking the 386 in the prepayment picker; approve it from Approvals. */
async function createFinalWithPrepayment(page: Page, net: number, advanceId: number, lang: "en" | "ar", partial?: number): Promise<Invoice> {
  await page.goto("/invoices", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: lang === "ar" ? "فاتورة جديدة" : "New Invoice" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const customerTrigger = dialog.locator("button[role=combobox]").first();
  await customerTrigger.click();
  await page.getByRole("option", { name: /E2E Customer/ }).click();
  await dialog.getByPlaceholder(lang === "ar" ? "الوصف" : "Description").first().fill("Consulting project");
  await dialog.getByPlaceholder(lang === "ar" ? "سعر الوحدة" : "Unit price").first().fill(String(net));
  const section = dialog.getByTestId("prepayments-section");
  await expect(section).toBeVisible();
  await dialog.getByTestId(`prepayment-check-${advanceId}`).check();
  if (partial != null) await dialog.getByTestId(`prepayment-amount-${advanceId}`).fill(String(partial));
  await expect(dialog.getByTestId("prepayment-summary")).toBeVisible();
  await dialog.getByRole("button", { name: lang === "ar" ? "إنشاء فاتورة" : "Create Invoice" }).click();
  await expect(toast(page, lang === "ar" ? "تم إنشاء الفاتورة" : "Invoice created")).toBeVisible();
  await expect(dialog).toBeHidden();
  const list = ((await (await api.get(`/api/invoices?status=draft&limit=50`)).json()) as { items: Invoice[] }).items;
  const draft = list.find((i) => i.prepayments.some((p) => p.advanceInvoiceId === advanceId));
  if (!draft) throw new Error("e2e: the draft with the prepayment was not listed");
  await api.post(`/api/invoices/${draft.id}/approve`);
  return invoice(draft.id);
}

test.describe("AP-2 — English desktop", () => {
  test("🔴 advance → 386 (draft, approve) → the VAT return files it → the final invoice applies it (PrepaidAmount, amount due) and files NET → the deposit is cleared", async ({ page }) => {
    await page.goto(`/customers/${ids.customerId}`, { waitUntil: "networkidle" });
    const before = await box(PERIOD);
    const reviewBefore = (await vatReturn(PERIOD)).depositReview.needsReviewCount;
    const id = await recordAdvance(page, 1150, "en");
    expect((await reviewItem(id))?.reviewState).toBe("advance_not_invoiced");

    // the receipt card shows the advance section with the un-invoiced figure; issue the 386
    const detail = await openReceipt(page, id);
    await expect(detail.getByTestId(`advance-uninvoiced-${id}`)).toContainText("1,150.00");
    const adv = await issueAdvanceFromCard(page, id, "en");
    expect(adv.documentType).toBe("advance_invoice");
    expect(adv.status).toBe("sent");
    expect(adv.icv).not.toBeNull();
    expect(adv.total).toBe(1150);
    expect(adv.subtotal).toBe(1000);
    expect(adv.vatAmount).toBe(150);
    expect(adv.advancePaymentId).toBe(id);
    const p1 = await payment(id);
    expect(p1.advanceInvoicedAmount).toBe(1150);
    expect(p1.advanceOpenAmount).toBe(1150);
    expect(p1.uninvoicedAmount).toBe(0);
    expect(p1.unappliedAmount).toBe(1150);
    await expect(page.getByTestId(`advance-open-${id}`)).toContainText("1,150.00");
    await expect(page.getByTestId(`advance-uninvoiced-${id}`)).toContainText("0.00");
    // the Allocate / Refund controls are gone — nothing un-invoiced remains to move that way
    await expect(page.getByTestId(`allocate-${id}`)).toHaveCount(0);
    // the return: box 1 +1,000, box 6 +150 in this period; the deposit no longer needs review
    const after386 = await box(PERIOD);
    expect(after386.box1).toBeCloseTo(before.box1 + 1000, 2);
    expect(after386.box6).toBeCloseTo(before.box6 + 150, 2);
    expect((await reviewItem(id))?.reviewState).toBe("advance_invoiced");
    expect((await vatReturn(PERIOD)).depositReview.needsReviewCount).toBe(reviewBefore);
    await page.goto("/vat", { waitUntil: "networkidle" });
    await expect(page.getByTestId(`deposit-review-${id}`)).toContainText("Advance — tax invoice issued, awaiting the final invoice");
    await expect(page.getByTestId(`deposit-review-${id}`)).toHaveAttribute("data-needs-review", "0");

    // the final invoice: 3,000 + 450, applying the 386 → PrepaidAmount 1,150, amount due 2,300; the return moves by the REST only
    const inv = await createFinalWithPrepayment(page, 3000, adv.id, "en");
    expect(inv.status).toBe("sent");
    expect(inv.total).toBe(3450);
    expect(inv.prepaidAmount).toBe(1150);
    expect(inv.amountDue).toBe(2300);
    expect(inv.paidAmount).toBe(1150);
    expect(inv.prepayments[0]?.allocationId).not.toBeNull();
    const afterFinal = await box(PERIOD);
    expect(afterFinal.box1).toBeCloseTo(after386.box1 + 2000, 2);
    expect(afterFinal.box6).toBeCloseTo(after386.box6 + 300, 2);
    const p2 = await payment(id);
    expect(p2.unappliedAmount).toBe(0);
    expect(p2.advanceAdjustedAmount).toBe(1150);
    expect(p2.advanceOpenAmount).toBe(0);
    // the Invoices page: the 386 carries its type badge and no amount due; the 388 says an advance was applied and is due 2,300
    await page.goto("/invoices", { waitUntil: "networkidle" });
    await expect(page.getByTestId(`type-advance-${adv.id}`)).toContainText("Advance tax invoice");
    await expect(page.getByTestId(`due-${adv.id}`)).toContainText("—");
    await expect(page.getByTestId(`type-prepaid-${inv.id}`)).toContainText("1,150.00");
    await expect(page.getByTestId(`due-${inv.id}`)).toContainText("2,300.00");
    // the receipt card: applied 1,150, awaiting 0; the allocation row is the folded one, not unallocatable
    const detail2 = await openReceipt(page, id);
    await expect(detail2.getByTestId(`advance-adjusted-${id}`)).toContainText("1,150.00");
    await expect(detail2.getByTestId(`advance-open-${id}`)).toContainText("0.00");
    const allocations = ((await (await api.get(`/api/payments/${id}`)).json()) as { allocations: Array<{ id: number; invoiceId: number }> }).allocations;
    const folded = allocations.find((a) => a.invoiceId === inv.id);
    expect(folded, "the folded allocation names the final invoice").toBeTruthy();
    const unallocate = await api.post(`/api/payments/allocations/${folded!.id}/unallocate`, { data: { reason: "oops" } });
    expect(unallocate.status(), "the folded adjustment is immutable").toBe(409);
    expect((await unallocate.json()).code).toBe("prepayment_adjustment_immutable");
  });

  test("🔴 a PARTIAL 386 leaves the rest un-invoiced and reviewable; the final invoice may apply part of a 386; the 386 stays open for the next one", async ({ page }) => {
    await page.goto(`/customers/${ids.customerId}`, { waitUntil: "networkidle" });
    const id = await recordAdvance(page, 2300, "en");
    const adv = await issueAdvanceFromCard(page, id, "en", 1150);
    expect(adv.total).toBe(1150);
    const p = await payment(id);
    expect(p.uninvoicedAmount).toBe(1150);
    expect((await reviewItem(id))?.reviewState).toBe("advance_not_invoiced");
    expect((await reviewItem(id))?.uninvoicedAmount).toBe(1150);
    // the un-invoiced half can still be allocated the D-4 way (the Allocate control is offered for it)
    await expect(page.getByTestId(`allocate-${id}`)).toBeVisible();
    // apply 575 of the 386 on a 1,150 invoice (net 1,000): the 386 keeps 575 open
    const inv = await createFinalWithPrepayment(page, 1000, adv.id, "en", 575);
    expect(inv.prepaidAmount).toBe(575);
    expect(inv.amountDue).toBe(575);
    expect(inv.status).toBe("sent");
    const p2 = await payment(id);
    expect(p2.advanceAdjustedAmount).toBe(575);
    expect(p2.advanceOpenAmount).toBe(575);
    expect(p2.uninvoicedAmount).toBe(1150);
    expect(p2.unappliedAmount).toBe(1725);
    const open = (await (await api.get(`/api/customers/${ids.customerId}/advance-invoices`)).json()) as Array<{ id: number; openAmount: number }>;
    expect(open.find((o) => o.id === adv.id)?.openAmount).toBe(575);
    await settleReceipt(id);
  });

  test("an erroneous deposit is refused a 386 by the server with the reason named on the page", async ({ page }) => {
    await page.goto(`/customers/${ids.customerId}`, { waitUntil: "networkidle" });
    const id = await recordAdvance(page, 100, "en");
    await api.post(`/api/payments/${id}/classify`, { data: { classification: "erroneous" } });
    const detail = await openReceipt(page, id);
    // no advance section for an erroneous deposit — the control is not offered
    await expect(detail.getByTestId(`advance-invoices-${id}`)).toHaveCount(0);
    const res = await api.post(`/api/payments/${id}/advance-invoices`, { data: { amount: 100 } });
    expect(res.status()).toBe(409);
    expect((await res.json()).code).toBe("advance_invoice_requires_advance_classification");
    await settleReceipt(id);
  });
});

test.describe("AP-2 — English phone", () => {
  test.use({ viewport: PHONE });
  test("🔴 issue a 386 from a phone: the dialog and the advance section fit; the invoice picker fits", async ({ page }) => {
    await page.goto(`/customers/${ids.customerId}`, { waitUntil: "networkidle" });
    const id = await recordAdvance(page, 230, "en");
    const detail = await openReceipt(page, id);
    const section = detail.getByTestId(`advance-invoices-${id}`);
    await expectFits(section, PHONE.width, "the advance section fits the phone");
    await section.getByTestId(`issue-advance-${id}`).click();
    const dialog = page.getByTestId("advance-invoice-dialog");
    await expectFits(dialog, PHONE.width, "the advance invoice dialog fits the phone");
    await dialog.getByTestId("advance-submit").click();
    await expect(toast(page, "Advance tax invoice drafted")).toBeVisible();
    await expect(dialog).toBeHidden();
    await noSidewaysScroll(page, PHONE.width, "customer page with the advance section on a phone");
    const draft = (await payment(id)).advanceInvoices.find((a) => a.status === "draft")!;
    await page.getByTestId(`approve-advance-${draft.id}`).click();
    await expect(toast(page, "Advance tax invoice issued")).toBeVisible();
    await noSidewaysScroll(page, PHONE.width, "customer page after issue on a phone");
    await page.goto("/invoices", { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "New Invoice" }).click();
    const inv = page.getByRole("dialog");
    await inv.locator("button[role=combobox]").first().click();
    await page.getByRole("option", { name: /E2E Customer/ }).click();
    await expectFits(inv.getByTestId("prepayments-section"), PHONE.width, "the prepayment picker fits the phone");
    await expect(inv.getByTestId(`prepayment-check-${draft.id}`)).toBeVisible();
    await page.keyboard.press("Escape");
    await settleReceipt(id);
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

test.describe("AP-2 — Arabic / RTL desktop", () => {
  test("🔴 the same workflow in Arabic under dir=rtl: the receipt card, the 386 dialog, the invoice picker, the VAT panel state", async ({ page }) => {
    await page.goto(`/customers/${ids.customerId}`, { waitUntil: "networkidle" });
    await switchToArabic(page);
    const id = await recordAdvance(page, 1150, "ar");
    const detail = await openReceipt(page, id);
    await expect(detail.getByTestId(`advance-invoices-${id}`)).toContainText("الفواتير الضريبية للدفعات المقدمة");
    const adv = await issueAdvanceFromCard(page, id, "ar");
    expect(adv.status).toBe("sent");
    await expect(page.getByTestId(`advance-invoice-${adv.id}`)).toContainText("صادرة");
    await page.goto("/vat", { waitUntil: "networkidle" });
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.getByTestId(`deposit-review-${id}`)).toContainText("دفعة مقدمة — صدرت فاتورتها الضريبية، بانتظار الفاتورة النهائية");
    const inv = await createFinalWithPrepayment(page, 2000, adv.id, "ar");
    expect(inv.prepaidAmount).toBe(1150);
    expect(inv.amountDue).toBe(1150);
    await page.goto("/invoices", { waitUntil: "networkidle" });
    await expect(page.getByTestId(`type-advance-${adv.id}`)).toContainText("فاتورة دفعة مقدمة");
    await expect(page.getByTestId(`type-prepaid-${inv.id}`)).toContainText("طُبّقت دفعة مقدمة");
    await expect(page.getByTestId(`due-${inv.id}`)).toContainText("1,150.00");
  });
});

test.describe("AP-2 — Arabic / RTL phone", () => {
  test.use({ viewport: PHONE });
  test("🔴 Arabic on a phone: the 386 dialog fits and issues; the receipt card renders RTL without sideways scroll", async ({ page }) => {
    await page.goto(`/customers/${ids.customerId}`, { waitUntil: "networkidle" });
    await switchToArabicOnPhone(page);
    const id = await recordAdvance(page, 460, "ar");
    const detail = await openReceipt(page, id);
    const section = detail.getByTestId(`advance-invoices-${id}`);
    await expectFits(section, PHONE.width, "the Arabic advance section fits the phone");
    await section.getByTestId(`issue-advance-${id}`).click();
    const dialog = page.getByTestId("advance-invoice-dialog");
    await expectFits(dialog, PHONE.width, "the Arabic advance invoice dialog fits the phone");
    await expect(dialog.getByRole("heading", { name: "إصدار فاتورة ضريبية عن دفعة مقدمة" })).toBeVisible();
    await dialog.getByTestId("advance-submit").click();
    await expect(toast(page, "أُنشئت مسودة الفاتورة الضريبية للدفعة المقدمة")).toBeVisible();
    await expect(dialog).toBeHidden();
    const draft = (await payment(id)).advanceInvoices.find((a) => a.status === "draft")!;
    await page.getByTestId(`approve-advance-${draft.id}`).click();
    await expect(toast(page, "صدرت الفاتورة الضريبية للدفعة المقدمة")).toBeVisible();
    await noSidewaysScroll(page, PHONE.width, "customer page in Arabic on a phone after the 386");
    expect((await payment(id)).advanceOpenAmount).toBe(460);
    await page.goto("/vat", { waitUntil: "networkidle" });
    await expect(page.getByTestId(`deposit-review-${id}`)).toContainText("صدرت فاتورتها الضريبية");
    await noSidewaysScroll(page, PHONE.width, "VAT page in Arabic on a phone");
    await settleReceipt(id);
  });
});
