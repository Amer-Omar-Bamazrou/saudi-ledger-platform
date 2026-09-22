/**
 * FA-F — THE ART. 52 CAPITAL-ASSET ADJUSTMENT, WALKED BY CLICKING (2026-09-22).
 * Record: docs/product/fixed-assets-decision-pack.md §7, §25.
 *
 * What only a browser can show:
 *   · the page refuses while the VAT tax period is undeclared, and the control
 *     it names exists — in Company Settings, where declaring it takes the
 *     refusal away;
 *   · the twelve-month windows and the RETURN each adjustment belongs to are
 *     rendered, and they are the server's figures;
 *   · an adjustment of nil carries its reason: Art. 52(6) where the use did not
 *     change, "not established" where nobody has said what the use was — the
 *     two zeros are visibly different on the page;
 *   · stating a use through the dialog moves the window and only that window;
 *   · Arabic under dir=rtl, and a phone at 390 px, neither scrolling sideways.
 *
 * 🔴 The walk restores the shared company's tax period and withdraws the use
 * records it made, so a second run starts where the first did.
 */
import { test, expect, request as pwRequest, type APIRequestContext, type Page } from "@playwright/test";
import { E2E } from "./global-setup";

test.use({ storageState: E2E.storageState });

const PHONE = { width: 390, height: 844 };

let api: APIRequestContext;
let originalTaxPeriod: string | null = null;
/**
 * 🔴 The walk SEEDS its own capital asset rather than hoping the tenant has
 * one. A walk that skips its own assertions when the fixture is absent reports
 * a pass for a narrower thing than it claims — and the two legs that matter
 * most here (the two different zeros, and a per-window override) are exactly
 * the ones a missing asset would silently remove.
 */
let assetNumber = "";
let assetId = 0;

const noSidewaysScroll = async (page: Page, width: number, what: string) => {
  const w = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(w, `${what}: no sideways page scroll`).toBeLessThanOrEqual(width + 1);
};

const post = async (path: string, data: unknown) => {
  const res = await api.post(`/api${path}`, { data });
  if (!res.ok()) throw new Error(`${path} → ${res.status()} ${(await res.text()).slice(0, 300)}`);
  return res.json();
};

test.beforeAll(async () => {
  api = await pwRequest.newContext({ baseURL: "http://localhost:5173", storageState: E2E.storageState });
  const c = await (await api.get("/api/companies/current")).json();
  originalTaxPeriod = c.vatTaxPeriod ?? null;

  // A movable capital asset with input tax, bought and capitalised through the
  // product's OWN paths (a draft asset, then a vendor bill that names it).
  // Dated two years back so several windows have already ended.
  const year = new Date().getUTCFullYear() - 2;
  const cats = await (await api.get("/api/asset-categories")).json();
  let cat = (cats.items as Array<{ id: number; name: string; vatCapitalAssetClass: string }>).find((x) => x.vatCapitalAssetClass === "movable");
  if (!cat) {
    cat = await post("/asset-categories", { name: "VAT walk equipment", defaultUsefulLifeMonths: 120, incomeTaxGroup: 3, vatCapitalAssetClass: "movable" });
  }
  const asset = await post("/assets", {
    name: "Art. 52 walk machine", categoryId: cat!.id,
    acquisitionDate: `${year}-05-20`, availableForUseDate: `${year}-05-20`,
    // 🔴 The accounting life is stated HERE rather than inherited from whichever
    // category the tenant happens to have: the assertion below is about Art.
    // 52(2) capping a 10-year asset at six years, and a category default of 48
    // months would turn it into an assertion about the category instead.
    cost: 100000, vatInputTaxAmount: 15000, usefulLifeMonths: 120,
  });
  assetId = asset.id;
  assetNumber = asset.assetNumber;
  const vendors = await (await api.get("/api/vendors?limit=1")).json();
  const bill = await post("/bills", {
    billNumber: `BILL-VATWALK-${Date.now()}`, date: `${year}-05-20`, vendorId: (vendors.items ?? vendors)[0].id,
    subtotal: 100000, vatAmount: 15000, total: 115000, capitalisesAssetId: assetId,
    items: [{ description: "Machine", quantity: 1, unitPrice: 100000 }],
  });
  await post(`/bills/${bill.id}/approve`, {});
});
test.afterAll(async () => {
  const recs = await (await api.get("/api/assets/vat-adjustments/use-records")).json();
  for (const r of recs.items as Array<{ id: number }>) {
    await api.delete(`/api/assets/vat-adjustments/use-records/${r.id}`);
  }
  await api.patch("/api/companies/current", { data: { vatTaxPeriod: originalTaxPeriod } });
  await api.dispose();
});

test.describe.serial("the Art. 52 capital-asset adjustment, end to end", () => {
  test("🔴 with the tax period undeclared the page refuses, and says why a window cannot even be placed", async ({ page }) => {
    await api.patch("/api/companies/current", { data: { vatTaxPeriod: null } });
    await page.goto("/assets/vat-adjustments");
    await expect(page.getByTestId("page-vat-capital-assets")).toBeVisible();
    await expect(page.getByTestId("vat-status")).toHaveText("tax_period_not_declared");
    await expect(page.getByTestId("vat-reason")).toContainText("Art. 52(5)");
    await expect(page.getByTestId("vat-reason")).toContainText("Company Settings");
    // 🔴 nothing is rendered as if it were a figure
    await expect(page.getByTestId("vat-fraction")).toHaveCount(0);
    await expect(page.locator('[data-testid^="vat-asset-"]')).toHaveCount(0);
  });

  test("🔴 the control the refusal names EXISTS: declare the tax period in Company Settings, and the working paper appears", async ({ page }) => {
    await page.goto("/company");
    await page.selectOption("#vatTaxPeriod", "quarterly");
    await page.getByTestId("button-save-company").click();
    await expect(page.locator("#vatTaxPeriod")).toHaveValue("quarterly");
    const c = await (await api.get("/api/companies/current")).json();
    expect(c.vatTaxPeriod).toBe("quarterly");

    await page.goto("/assets/vat-adjustments");
    await expect(page.getByTestId("vat-status")).toHaveCount(0);
    // the Art. 51 fraction is shown so the derived use can be checked
    await expect(page.getByTestId("vat-fraction")).toBeVisible();

    const report = await (await api.get("/api/assets/vat-adjustments")).json();
    expect(report.status).toBe("computed");
    const assets = report.assets as Array<{ assetNumber: string; adjustmentPeriodYears: number; windows: unknown[] }>;
    const mine = assets.find((x) => x.assetNumber === assetNumber)!;
    expect(mine, "the walk's own capital asset is in the working paper").toBeTruthy();
    await expect(page.getByTestId(`vat-asset-${assetNumber}`)).toBeVisible();
    // 🔴 A 120-month machine: six windows (the statutory movable period),
    // NOT ten (the accounting life). The two clocks are different.
    expect(mine.adjustmentPeriodYears).toBe(6);
    await expect(page.locator(`[data-testid^="vat-window-${assetNumber}-"]`)).toHaveCount(mine.windows.length);
    expect(mine.windows.length).toBe(mine.adjustmentPeriodYears);
  });

  test("🔴 an adjustment of nil carries its REASON — Art. 52(6) and 'not established' are visibly different on the page", async ({ page }) => {
    await page.goto("/assets/vat-adjustments");
    const report = await (await api.get("/api/assets/vat-adjustments")).json();
    const a = (report.assets as Array<{ assetNumber: string; windows: Array<{ periodIndex: number; adjustment: number; noChangeOfUse: boolean; actualUseSource: string }> }>)
      .find((x) => x.assetNumber === assetNumber)!;

    const noChange = a.windows.find((w) => w.noChangeOfUse);
    const unknown = a.windows.find((w) => w.actualUseSource === "unavailable");
    // 🔴 The seeded tenant is wholly standard-rated, so early windows reach
    // 52(6) and later ones (no supplies yet) are simply unestablished. Both
    // shapes have to exist for the assertion to mean anything.
    expect(noChange, "a 52(6) window").toBeTruthy();
    expect(unknown, "an unestablished window").toBeTruthy();
    expect(noChange!.adjustment).toBe(0);
    expect(unknown!.adjustment).toBe(0);

    await expect(page.getByTestId(`vat-no-change-${assetNumber}-${noChange!.periodIndex}`)).toBeVisible();
    await expect(page.getByTestId(`vat-use-unavailable-${assetNumber}-${unknown!.periodIndex}`)).toBeVisible();
    // …and neither marker is on the other row
    await expect(page.getByTestId(`vat-no-change-${assetNumber}-${unknown!.periodIndex}`)).toHaveCount(0);
    await expect(page.getByTestId(`vat-use-unavailable-${assetNumber}-${noChange!.periodIndex}`)).toHaveCount(0);
  });

  test("🔴 stating a use through the dialog moves THAT window and no other", async ({ page }) => {
    await page.goto("/assets/vat-adjustments");
    const before = await (await api.get("/api/assets/vat-adjustments")).json();
    const a0 = (before.assets as Array<{ assetNumber: string; potentiallyAdjustable: number; initialRecoveryPct: number; windows: Array<{ periodIndex: number; adjustment: number }> }>)
      .find((x) => x.assetNumber === assetNumber)!;
    const target = a0.windows[0]!.periodIndex;
    const others = a0.windows.filter((w) => w.periodIndex !== target).map((w) => w.adjustment);

    await page.getByTestId(`vat-declare-${assetNumber}-${target}`).click();
    await expect(page.getByTestId("vat-use-dialog")).toBeVisible();
    await page.getByTestId("vat-use-pct").fill("40");
    await page.getByTestId("vat-use-note").fill("Half the plant ran on exempt output");
    await page.getByTestId("vat-use-submit").click();
    await expect(page.getByTestId("vat-use-dialog")).toHaveCount(0);

    const after = await (await api.get("/api/assets/vat-adjustments")).json();
    const a1 = (after.assets as typeof before.assets)
      .find((x: { assetNumber: string }) => x.assetNumber === assetNumber)!;
    const w = a1.windows.find((x: { periodIndex: number }) => x.periodIndex === target)!;
    expect(w.actualUseSource).toBe("declared");
    expect(w.actualUsePct).toBe(40);
    // 40 % against an initial recovery of 100 % ⇒ the potentially adjustable
    // amount is repaid at 60 %, and the sign is the direction.
    expect(w.adjustment).toBe(Math.round(a0.potentiallyAdjustable * (40 - a0.initialRecoveryPct)) / 100);
    expect(w.adjustment).toBeLessThan(0);
    // 🔴 and the other windows are BYTE-identical — one statement is one window
    expect(a1.windows.filter((x: { periodIndex: number }) => x.periodIndex !== target).map((x: { adjustment: number }) => x.adjustment)).toEqual(others);

    await expect(page.getByTestId(`vat-window-${assetNumber}-${target}`)).toContainText("40%");
  });

  test("Arabic / RTL: the working paper reads right-to-left with Arabic labels, and nothing scrolls sideways", async ({ page }) => {
    await page.goto("/assets/vat-adjustments");
    await page.evaluate(() => localStorage.setItem("ksa_lang", "ar"));
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.getByRole("heading", { name: /تعديلات الأصول الرأسمالية/ })).toBeVisible();
    await noSidewaysScroll(page, 1280, "ar vat capital assets");
    await page.evaluate(() => localStorage.setItem("ksa_lang", "en"));
  });

  test("phone width: the working paper and the use dialog both fit 390 px", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await page.goto("/assets/vat-adjustments");
    await expect(page.getByTestId("page-vat-capital-assets")).toBeVisible();
    await noSidewaysScroll(page, PHONE.width, "phone vat capital assets");
    await page.getByTestId(`vat-declare-${assetNumber}-1`).click();
    await expect(page.getByTestId("vat-use-dialog")).toBeVisible();
    await noSidewaysScroll(page, PHONE.width, "phone vat use dialog");
  });
});
