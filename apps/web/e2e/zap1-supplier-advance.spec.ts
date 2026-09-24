/**
 * Z-AP1 — THE SUPPLIER'S ADVANCE TAX INVOICE, WALKED BY CLICKING (2026-09-24).
 * Accountant answer A. Record: docs/product/phase-12-banking-reconciliation-decision-pack.md §8.
 *
 *  · 🔴 recording the supplier's advance invoice on the payment CLAIMS its
 *    input VAT in the invoice's month — the VAT return moves by exactly it;
 *  · 🔴 the final bill, created by clicking with the advance ticked, claims
 *    ONLY the rest — its month's input VAT moves by the bill's VAT minus the
 *    advance's, and the bill says what is left to pay;
 *  · Arabic / RTL and a phone: the payment's advance-invoice section.
 * Figures are read as deltas of the return, so other specs' rows in the same
 * months cannot make them vacuous or wrong.
 */
import { test, expect, request as pwRequest, type APIRequestContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { E2E, SEEDED_IDS_PATH, type SeededIds } from "./global-setup";

test.use({ storageState: E2E.storageState });

const PHONE = { width: 390, height: 844 };
const STAMP = Date.now();
const ADV_REF = `NS-ADV-${STAMP}`;
const BILL_NO = `E2E-ZAP-${STAMP}`;

let api: APIRequestContext;
let vendorId = 0, bankId = 0, paymentId = 0;

/** The amount an element ENDS with, as a number — money is asserted exactly, never by substring. */
const moneyOf = async (loc: ReturnType<Page["getByTestId"]>) => {
  const m = (await loc.innerText()).match(/(-)?[^\d-]*([\d,]+\.\d{2})\s*$/);
  return m ? (m[1] ? -1 : 1) * Number(m[2]!.replace(/,/g, "")) : NaN;
};
const inputVat = async (from: string, to: string) =>
  Number((await (await api.get(`/api/reports/vat-return?period_from=${from}&period_to=${to}`)).json()).purchasesSection.box13_recoverableInputVat);

test.beforeAll(async () => {
  api = await pwRequest.newContext({ baseURL: "http://localhost:5173", storageState: E2E.storageState });
  const ids = JSON.parse(readFileSync(SEEDED_IDS_PATH, "utf8")) as SeededIds;
  vendorId = ids.vendorId;
  bankId = ids.bankId;
  const res = await api.post("/api/supplier-payments", { data: { vendorId, bankAccountId: bankId, amount: 11_500, paidAt: "2026-02-03", classification: "advance", reference: `ZAP-PAY-${STAMP}` } });
  expect(res.ok(), await res.text()).toBe(true);
  paymentId = (await res.json()).id;
});
test.afterAll(async () => { await api.dispose(); });

test.describe.serial("Z-AP1 — the supplier's advance tax invoice", () => {
  test("🔴 recording the supplier's advance invoice claims its VAT in the invoice's month — once", async ({ page }) => {
    const feb0 = await inputVat("2026-02-01", "2026-02-28");
    await page.goto("/supplier-payments");
    await expect(page.getByTestId("page-supplier-payments")).toBeVisible();
    await page.getByTestId(`open-supplier-payment-${paymentId}`).click();
    const section = page.getByTestId("advance-invoices-section");
    await expect(section).toBeVisible();
    await expect.poll(() => moneyOf(section.getByTestId("advance-uninvoiced"))).toBe(11_500);
    await section.getByTestId("advance-invoice-ref").fill(ADV_REF);
    await section.getByTestId("advance-invoice-date").fill("2026-02-05");
    await section.getByTestId("advance-invoice-submit").click();
    await expect.poll(async () => (await (await api.get(`/api/supplier-payments/${paymentId}`)).json()).advanceOpenAmount).toBe(11_500);
    expect(await inputVat("2026-02-01", "2026-02-28") - feb0, "February claims the advance's 1,500").toBeCloseTo(1_500, 2);
    const detail = await (await api.get(`/api/supplier-payments/${paymentId}`)).json();
    expect(detail).toMatchObject({ uninvoicedAmount: 0, advanceOpenVat: 1_500 });
  });

  test("🔴 the final bill, created by clicking with the advance ticked, claims ONLY the rest", async ({ page }) => {
    const mar0 = await inputVat("2026-03-01", "2026-03-31");
    await page.goto("/bills");
    await page.getByRole("button", { name: /New Bill/i }).first().click();
    await page.getByTestId("bill-vendor").click();
    await page.getByRole("option", { name: /E2E Vendor/ }).first().click();
    await page.getByTestId("bill-number").fill(BILL_NO);
    await page.locator('input[type="date"]').first().fill("2026-03-10");
    const picker = page.getByTestId("bill-advance-picker");
    await expect(picker).toBeVisible();
    const adv = (await (await api.get(`/api/supplier-payments/${paymentId}`)).json()).advanceInvoices[0];
    await picker.getByTestId(`bill-advance-${adv.id}`).check();
    await expect.poll(() => moneyOf(picker.getByTestId("bill-advance-vat")), { message: "the page says which VAT is not claimed again" }).toBe(1_500);
    await page.getByTestId("bill-subtotal").fill("30000");
    await page.getByTestId("bill-vat").fill("4500");
    await page.getByTestId("bill-total").fill("34500");
    await page.getByTestId("bill-submit").click();
    // The bill is found through the advance it deducted: the payment's folded allocation names it.
    await expect.poll(async () => {
      const allocs = (await (await api.get(`/api/supplier-payments/${paymentId}`)).json()).allocations as Array<{ billNumber: string }>;
      return allocs.some((a) => a.billNumber === BILL_NO);
    }, { timeout: 20_000 }).toBe(true);
    const bill = ((await (await api.get(`/api/supplier-payments/${paymentId}`)).json()).allocations as Array<{ billId: number; billNumber: string }>).find((a) => a.billNumber === BILL_NO)!;
    const full = await (await api.get(`/api/bills/${bill.billId}`)).json();
    expect(full).toMatchObject({ prepaidAmount: 11_500, amountDue: 23_000 });
    expect(await inputVat("2026-03-01", "2026-03-31") - mar0, "March claims 4,500 − 1,500, never 4,500").toBeCloseTo(3_000, 2);
    expect((await (await api.get(`/api/supplier-payments/${paymentId}`)).json()).advanceOpenAmount).toBe(0);
  });

  test("Arabic / RTL and a phone: the payment's advance-invoice section", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await page.goto("/supplier-payments");
    await page.evaluate(() => localStorage.setItem("ksa_lang", "ar"));
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await page.getByTestId(`open-supplier-payment-${paymentId}`).click();
    await expect(page.getByTestId("advance-invoices-section")).toContainText("الفواتير الضريبية للدفعات المقدمة من المورد");
    const w = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(w, "no sideways page scroll on a phone").toBeLessThanOrEqual(PHONE.width + 1);
    await page.evaluate(() => localStorage.setItem("ksa_lang", "en"));
  });
});
