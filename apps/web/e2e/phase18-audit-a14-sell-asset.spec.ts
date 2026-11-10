/**
 * 🔴 Phase 18 audit (2026-11-09), finding A14 — an asset can be SOLD from the screens.
 *
 * The asset screen's scrap dialog says a sale "is a tax invoice that names this asset" (FA-C: the invoice's
 * `disposesAssetId` — its revenue line credits the disposal gain/loss account, and approval derecognises the asset).
 * No screen could create that invoice: `disposesAssetId` had no writer in the web (standing rule 1 — correct is not
 * connected). The asset screen now offers "Sell", which opens the New Invoice form naming the asset; the invoice it
 * creates names the asset, and its approval disposes of it.
 *
 * Driven by clicks; the API is used for the fixture (an in-service asset, capitalised by a bill) and to read results.
 */
import { expect, test, type APIRequestContext } from "@playwright/test";
import { E2E } from "./global-setup";

test.use({ storageState: E2E.storageState });

async function json<T>(r: Promise<import("@playwright/test").APIResponse>, what: string): Promise<T> {
  const res = await r;
  expect(res.ok(), `${what}: ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as T;
}

async function inServiceAsset(request: APIRequestContext) {
  const stamp = Date.now();
  const cats = await json<{ items: Array<{ id: number }> }>(request.get("/api/asset-categories"), "categories");
  let categoryId = cats.items[0]?.id;
  if (!categoryId) {
    categoryId = (await json<{ id: number }>(request.post("/api/asset-categories", {
      data: { name: "A14 sale equipment", defaultUsefulLifeMonths: 60, incomeTaxGroup: 3, vatCapitalAssetClass: "movable" },
    }), "category")).id;
  }
  const asset = await json<{ id: number; assetNumber: string }>(request.post("/api/assets", {
    data: { name: `A14 sale asset ${stamp}`, categoryId, acquisitionDate: "2026-01-05", availableForUseDate: "2026-01-05", cost: 1000 },
  }), "asset");
  const vendors = await json<{ items: Array<{ id: number; name: string }> }>(request.get("/api/vendors?limit=200"), "vendors");
  const vendor = vendors.items.find((v) => /E2E Vendor/.test(v.name)) ?? vendors.items[0]!;
  const bill = await json<{ id: number }>(request.post("/api/bills", {
    data: {
      vendorId: vendor.id, billNumber: `A14-CAP-${stamp}`, supplierDocumentKind: "tax_invoice", vendorReference: `A14-SUP-${stamp}`,
      date: "2026-01-05", dueDate: "2026-02-05", subtotal: 1000, vatAmount: 150, total: 1150, items: [], capitalisesAssetId: asset.id,
    },
  }), "capitalising bill");
  await json(request.post(`/api/bills/${bill.id}/approve`, { data: {} }), "approve bill");
  await expect.poll(async () => (await json<{ status: string }>(request.get(`/api/assets/${asset.id}`), "asset")).status, { timeout: 20_000 }).toBe("in_service");
  return asset;
}

test("🔴 A14: Sell on the asset screen opens the New Invoice form naming the asset; the invoice names it, and approving it disposes of the asset", async ({ page, request }) => {
  test.setTimeout(120_000);
  const asset = await inServiceAsset(request);

  await page.goto(`/assets/${asset.id}`, { waitUntil: "networkidle" });
  await page.getByTestId("sell-asset").click();
  await expect(page).toHaveURL(new RegExp(`/invoices\\?sellAsset=${asset.id}$`));
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("invoice-sells-asset")).toContainText(asset.assetNumber);

  await dialog.locator("button[role=combobox]").first().click();
  await page.getByRole("option", { name: /E2E Customer/ }).click();
  await dialog.getByPlaceholder("Description").first().fill(`Sale of ${asset.assetNumber}`);
  await dialog.getByPlaceholder("Unit price").first().fill("500");
  await dialog.getByRole("button", { name: "Create Invoice" }).click();
  await expect(dialog).toBeHidden();

  const drafts = await json<{ items: Array<{ id: number; disposesAssetId: number | null }> }>(request.get("/api/invoices?status=draft&limit=50"), "drafts");
  const sale = drafts.items.find((i) => i.disposesAssetId === asset.id);
  expect(sale, "the invoice the form created names the asset it sells").toBeTruthy();

  await json(request.post(`/api/invoices/${sale!.id}/approve`, { data: {} }), "approve the sale");
  await expect.poll(async () => (await json<{ status: string }>(request.get(`/api/assets/${asset.id}`), "asset")).status, { timeout: 20_000 }).toBe("disposed");
});
