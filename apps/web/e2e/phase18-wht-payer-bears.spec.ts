/**
 * 🔴 PHASE 18 G4c-1 — THE PAYER BEARS THE WHT, WALKED BY CLICKING (owner
 * decision 15, 2026-10-27; register §11.44, §11.45).
 *
 * What only a browser can show:
 *   · the WHT page's Contracts tab OPENS — and so does the Refund claims tab,
 *     which #257 added but left out of the page's known tabs (it fell back to
 *     Months, so no screen reached the claims);
 *   · a contract is recorded there, and only once its confirmation is ticked;
 *   · Bills → Pay: naming the net-of-tax contract, the SERVER's preview shows
 *     the grossed-up base, the tax the company bears and the full amount as
 *     cash — and the payment records exactly that;
 *   · Treasury → pay a plan: the contract chosen travels with the payment (that
 *     request body is built field by field — the TR-1 shape).
 */
import { test, expect, request as pwRequest, type APIRequestContext, type Page } from "./fixtures";
import { businessToday } from "@workspace/shared";
import { E2E } from "./global-setup";

test.use({ storageState: E2E.storageState });

const TODAY = businessToday();
const STAMP = Date.now();
const REF = `E2E-NET-${STAMP}`;

let api: APIRequestContext;
let vendorId = 0, billId = 0, planBillId = 0;

const json = async <T,>(p: Promise<{ ok(): boolean; status(): number; text(): Promise<string> }>, what: string): Promise<T> => {
  const r = await p;
  const text = await r.text();
  if (!r.ok()) throw new Error(`${what} → ${r.status()} ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : undefined) as T;
};
const pick = async (page: Page, trigger: ReturnType<Page["getByTestId"]>, option: RegExp | string) => {
  await trigger.click();
  await page.getByRole("option", { name: option }).first().click();
};
const bill = async (amount: number, n: string) => {
  const b = await json<{ id: number }>(api.post("/api/bills", { data: {
    supplierDocumentKind: "tax_invoice", vendorReference: `NET-${n}-${STAMP}`, billNumber: `E2E-NET-${n}-${STAMP}`, date: TODAY, dueDate: TODAY, vendorId,
    items: [{ description: "Consulting services", quantity: 1, unitPrice: amount, vatRate: 0 }],
  } }), "bill");
  await json(api.post(`/api/bills/${b.id}/approve`, { data: {} }), "approve bill");
  return b.id;
};

test.beforeAll(async () => {
  api = await pwRequest.newContext({ baseURL: "http://localhost:5173", storageState: E2E.storageState });
  const v = await json<{ id: number }>(api.post("/api/vendors", { data: { name: `E2E Dublin Advisory ${STAMP}`, residency: "non_resident", country: "IE", whtDefaultPaymentType: "technical_consulting" } }), "vendor");
  vendorId = v.id;
  billId = await bill(1000, "A");
  planBillId = await bill(2000, "B");
});
test.afterAll(async () => { await api.dispose(); });

test.describe.serial("Phase 18 G4c-1 — the payer bears the WHT", () => {
  test("🔴 the Contracts tab and the Refund claims tab both OPEN — each by its link and by its tab", async ({ page }) => {
    await page.goto("/tax/withholding?tab=claims");
    await expect(page.getByTestId("wht-claims")).toBeVisible();
    await page.getByTestId("wht-tab-contracts").click();
    await expect(page.getByTestId("wht-contracts")).toBeVisible();
    await expect(page).toHaveURL(/tab=contracts/);
    await page.getByTestId("wht-tab-claims").click();
    await expect(page.getByTestId("wht-claims")).toBeVisible();
  });

  test("🔴 a contract is recorded on the Contracts tab — only once its confirmation is ticked", async ({ page }) => {
    await page.goto("/tax/withholding?tab=contracts");
    const form = page.getByTestId("wht-contract-form");
    await pick(page, form.getByTestId("wht-contract-vendor"), `E2E Dublin Advisory ${STAMP}`);
    await form.getByTestId("wht-contract-reference").fill(REF);
    await form.getByTestId("wht-contract-bearing-net_of_tax").check();
    await expect(form.getByTestId("wht-contract-submit")).toBeDisabled();
    await form.getByTestId("wht-contract-confirm").check();
    await form.getByTestId("wht-contract-submit").click();
    await expect(page.getByTestId("wht-contracts")).toContainText(REF);
    const list = await json<Array<{ id: number; reference: string; taxBearing: string }>>(api.get(`/api/tax/wht/contracts?vendorId=${vendorId}`), "contracts");
    expect(list.map((c) => [c.reference, c.taxBearing])).toEqual([[REF, "net_of_tax"]]);
  });

  test("🔴 Bills → Pay under the net-of-tax contract: the server's preview grosses up — and the payment records it: cash 1,000.00, WHT 52.63 borne", async ({ page }) => {
    await page.goto("/bills");
    await page.getByTestId(`pay-bill-${billId}`).click();
    await expect(page.getByTestId("wht-fields")).toBeVisible();
    await expect(page.getByTestId("wht-preview-withheld")).toContainText("50.00"); // no contract named: withheld from the payment
    await pick(page, page.getByTestId("wht-contract"), new RegExp(REF));
    await expect(page.getByTestId("wht-preview-base")).toContainText("1,052.63");
    await expect(page.getByTestId("wht-preview-withheld")).toContainText("52.63");
    await expect(page.getByTestId("wht-preview-cash")).toContainText("1,000.00");
    await page.getByTestId("pay-bank-account").click();
    await page.getByRole("option").first().click();
    await page.getByRole("button", { name: "Record Payment" }).click();
    await expect.poll(async () => {
      const ps = await json<Array<{ withheld?: number | null; cashPaid?: number | null }>>(api.get(`/api/bills/${billId}/payments`), "payments");
      return ps.map((p) => [p.withheld, p.cashPaid]);
    }, { message: "the payment carries the borne tax and the full cash" }).toEqual([[52.63, 1000]]);
  });

  test("🔴 Treasury → pay a plan under the contract: the contract chosen travels with the payment", async ({ page }) => {
    const planned = new Date(`${TODAY}T00:00:00Z`); planned.setUTCDate(planned.getUTCDate() + 5);
    const plan = await json<{ id: number }>(api.post("/api/treasury/payment-plans", { data: { billId: planBillId, amount: 2000, plannedDate: planned.toISOString().slice(0, 10) } }), "plan");
    await json(api.post(`/api/treasury/payment-plans/${plan.id}/approve`, { data: {} }), "approve the plan");
    await page.goto("/treasury?tab=plans");
    await page.getByTestId(`treasury-plan-pay-${plan.id}`).click();
    const form = page.getByTestId(`treasury-plan-pay-form-${plan.id}`);
    await pick(page, form.getByTestId("wht-contract"), new RegExp(REF));
    await expect(form.getByTestId("wht-preview-base")).toContainText("2,105.26");
    await form.getByTestId("treasury-plan-pay-bank").click();
    await page.getByRole("option").first().click();
    await form.getByTestId("treasury-plan-pay-submit").click();
    await expect(page.getByTestId(`treasury-plan-status-${plan.id}`)).toContainText("Paid");
    const pays = await json<Array<{ withheld?: number | null; cashPaid?: number | null }>>(api.get(`/api/bills/${planBillId}/payments`), "payments");
    expect(pays.map((x) => [x.withheld, x.cashPaid]), "2,000 ÷ 0.95 = 2,105.26; 5 % of it borne; the supplier paid in full").toEqual([[105.26, 2000]]);
  });
});
