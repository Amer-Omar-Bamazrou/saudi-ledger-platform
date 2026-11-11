/**
 * 🔴 Phase 18 audit (2026-11-09), finding A17 — a submitted quotation and a submitted purchase order reach the
 * Approvals page, and are approved from it.
 *
 * G11's control is "queue completeness". Quotations, purchase orders and budget versions each have a submitted state
 * and their own approve route, and none was in the approvals queue: a preparer submitted and no approver was shown
 * it. The fixture is made through the API (a quotation and a purchase order, each submitted); the act is a click.
 */
import { expect, test, type APIRequestContext } from "@playwright/test";
import { E2E } from "./global-setup";

test.use({ storageState: E2E.storageState });

async function json<T>(r: Promise<import("@playwright/test").APIResponse>, what: string): Promise<T> {
  const res = await r;
  expect(res.ok(), `${what}: ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}
async function submitted(request: APIRequestContext) {
  const customers = await json<{ items: Array<{ id: number; name: string }> }>(request.get("/api/customers?limit=200"), "customers");
  const vendors = await json<{ items: Array<{ id: number; name: string }> }>(request.get("/api/vendors?limit=200"), "vendors");
  const customer = customers.items.find((c) => /E2E Customer/.test(c.name)) ?? customers.items[0]!;
  const vendor = vendors.items.find((v) => /E2E Vendor/.test(v.name)) ?? vendors.items[0]!;
  const items = [{ description: "A17 queue walk", quantity: 1, unitPrice: 250, vatRate: 15 }];
  const q = await json<{ id: number }>(request.post("/api/quotations", { data: { customerId: customer.id, items } }), "quotation");
  await json(request.post(`/api/quotations/${q.id}/submit`, { data: {} }), "submit quotation");
  const po = await json<{ id: number }>(request.post("/api/purchase-orders", { data: { vendorId: vendor.id, items } }), "purchase order");
  await json(request.post(`/api/purchase-orders/${po.id}/submit`, { data: {} }), "submit purchase order");
  return { quotationId: q.id, orderId: po.id };
}

test("🔴 A17: a submitted quotation and purchase order are on the Approvals page, and Approve there approves each", async ({ page, request }) => {
  const { quotationId, orderId } = await submitted(request);
  await page.goto("/approvals", { waitUntil: "networkidle" });

  await expect(page.getByTestId("approvals-quotations")).toBeVisible();
  await expect(page.getByTestId(`approval-quotations-${quotationId}`)).toBeVisible();
  await expect(page.getByTestId(`approval-purchase-orders-${orderId}`)).toBeVisible();

  await page.getByTestId(`approval-approve-quotations-${quotationId}`).click();
  await expect.poll(async () => (await json<{ status: string }>(request.get(`/api/quotations/${quotationId}`), "quotation")).status).toBe("approved");
  await expect(page.getByTestId(`approval-quotations-${quotationId}`)).toHaveCount(0);

  await page.getByTestId(`approval-approve-purchase-orders-${orderId}`).click();
  await expect.poll(async () => (await json<{ status: string }>(request.get(`/api/purchase-orders/${orderId}`), "purchase order")).status).toBe("approved");
  await expect(page.getByTestId(`approval-purchase-orders-${orderId}`)).toHaveCount(0);
});
