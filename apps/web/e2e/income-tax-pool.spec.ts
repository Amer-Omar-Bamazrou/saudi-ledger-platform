/**
 * FA-E — THE ART. 17 INCOME-TAX POOL, WALKED BY CLICKING (2026-09-22).
 * Record: docs/product/fixed-assets-decision-pack.md §24.
 *
 * What only a browser can show:
 *   · the page REFUSES before it computes, and the refusal names a control
 *     that exists — the share of the company subject to income tax, which is
 *     then declared in Company Settings and takes the refusal away;
 *   · the anchor form is reachable from the refusal itself, and declaring the
 *     opening position turns the same page into a working paper;
 *   · the figures rendered are the server's, checked against the API;
 *   · the elections are OFFERED and not taken until clicked;
 *   · Arabic under dir=rtl, and a phone at 390 px, neither scrolling sideways.
 *
 * 🔴 The walk RESTORES the company's declarations at the end. The seeded
 * company is shared by every spec in this project, and a Zakat spec that finds
 * it FOREIGN would fail for a reason that has nothing to do with Zakat.
 */
import { test, expect, request as pwRequest, type APIRequestContext, type Page } from "@playwright/test";
import { E2E } from "./global-setup";

test.use({ storageState: E2E.storageState });

const PHONE = { width: 390, height: 844 };

let api: APIRequestContext;
let original: { ownershipType: string | null; foreignOwnershipPct: number | null; fiscalYearStart: number | null } =
  { ownershipType: null, foreignOwnershipPct: null, fiscalYearStart: null };

const noSidewaysScroll = async (page: Page, width: number, what: string) => {
  const w = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(w, `${what}: no sideways page scroll`).toBeLessThanOrEqual(width + 1);
};

test.beforeAll(async () => {
  api = await pwRequest.newContext({ baseURL: "http://localhost:5173", storageState: E2E.storageState });
  const c = await (await api.get("/api/companies/current")).json();
  original = { ownershipType: c.ownershipType ?? null, foreignOwnershipPct: c.foreignOwnershipPct ?? null, fiscalYearStart: c.fiscalYearStart ?? null };
});
test.afterAll(async () => {
  // Withdraw the declarations this walk made, so a second run starts from the
  // same undeclared company it found — and so the DELETE route has a caller.
  const decls = await (await api.get("/api/assets/income-tax-pool/declarations")).json();
  for (const d of decls.items as Array<{ id: number }>) {
    await api.delete(`/api/assets/income-tax-pool/declarations/${d.id}`);
  }
  expect((await (await api.get("/api/assets/income-tax-pool/declarations")).json()).items).toEqual([]);

  // Put the shared company back exactly as it was. The share must be cleared
  // BEFORE the structure, or companies_foreign_ownership_pct_chk refuses the
  // intermediate pair — the same rule the service explains.
  await api.patch("/api/companies/current", { data: { foreignOwnershipPct: null } });
  await api.patch("/api/companies/current", { data: { ownershipType: original.ownershipType, fiscalYearStart: original.fiscalYearStart } });
  if (original.foreignOwnershipPct !== null) {
    await api.patch("/api/companies/current", { data: { foreignOwnershipPct: original.foreignOwnershipPct } });
  }
  await api.dispose();
});

test.describe.serial("the Art. 17 income-tax pool, end to end", () => {
  const ANCHOR_YEAR = new Date().getUTCFullYear() - 2;

  test("🔴 with the share undeclared the page refuses, and says so as an explanation rather than an empty table", async ({ page }) => {
    await api.patch("/api/companies/current", { data: { foreignOwnershipPct: null } });
    await api.patch("/api/companies/current", { data: { ownershipType: null, fiscalYearStart: null } });
    await page.goto("/assets/income-tax-pool");
    await expect(page.getByTestId("page-income-tax-pool")).toBeVisible();
    await expect(page.getByTestId("pool-status")).toHaveText("regime_not_declared");
    await expect(page.getByTestId("pool-reason")).toContainText("Company Settings");
    // 🔴 no figures at all — a zeroed table would read like a company with no assets
    await expect(page.getByTestId("anchor-form")).toHaveCount(0);
    await expect(page.locator('[data-testid^="pool-year-"]')).toHaveCount(0);
    // the frame is stated even with nothing computed
    await expect(page.getByTestId("pool-frame")).toContainText("17(a)");
  });

  test("🔴 the control the refusal names EXISTS: declare the share in Company Settings by typing it, and the refusal moves on to the NEXT missing input", async ({ page }) => {
    await page.goto("/company");
    // The structure first — the two are one statement (Income Tax Law Art. 2),
    // and the server refuses a pair that says two different things.
    await page.selectOption("#ownershipType", "MIXED");
    await page.getByTestId("input-foreign-ownership-pct").fill("40");
    await page.getByTestId("button-save-company").click();
    await expect(page.getByTestId("input-foreign-ownership-pct")).toHaveValue("40");

    // it round-tripped through the server, not merely the DOM
    let c = await (await api.get("/api/companies/current")).json();
    expect([c.ownershipType, c.foreignOwnershipPct]).toEqual(["MIXED", 40]);

    // 🔴 The refusal MOVES ON rather than disappearing: the seeded company has
    // no fiscal year, and Art. 22 computes the pool per taxable year. Each state
    // names the next act, and each act is a control on a page the tenant can
    // reach — which is the property this walk exists to check.
    await page.goto("/assets/income-tax-pool");
    await expect(page.getByTestId("pool-status")).toHaveText("fiscal_year_not_declared");

    await page.goto("/company");
    await page.selectOption("#fiscalYearStart", "1");
    await page.getByTestId("button-save-company").click();
    await expect(page.locator("#fiscalYearStart")).toHaveValue("1");
    c = await (await api.get("/api/companies/current")).json();
    expect(c.fiscalYearStart).toBe(1);

    await page.goto("/assets/income-tax-pool");
    await expect(page.getByTestId("pool-status")).toHaveText("anchor_not_declared");
    await expect(page.getByTestId("anchor-form")).toBeVisible();
  });

  test("🔴 declaring the opening position turns the refusal into a working paper, and the figures are the server's", async ({ page }) => {
    await page.goto("/assets/income-tax-pool");
    await page.getByTestId("anchor-balance").fill("80000");
    await page.getByTestId("anchor-additions").fill("20000");
    await page.getByTestId("anchor-disposals").fill("0");
    await page.getByTestId("anchor-year").fill(String(ANCHOR_YEAR));
    await page.getByTestId("anchor-submit").click();

    // group 3 is now anchored; the other four still are not, so the page still refuses
    await expect(page.getByTestId("pool-status")).toHaveCount(0);
    const firstYear = ANCHOR_YEAR + 1;
    await expect(page.getByTestId(`pool-year-${firstYear}`)).toBeVisible();
    await expect(page.getByTestId("pool-anchor")).toContainText(String(ANCHOR_YEAR));
    await expect(page.getByTestId("pool-anchor")).toContainText("40%");

    // 🔴 the rendered figures ARE the server's: 80,000 opening + 50 % of the
    // anchor year's 20,000 = 90,000 × 25 % = 22,500.
    const report = await (await api.get("/api/assets/income-tax-pool")).json();
    const g3 = report.years.find((y: { taxYear: number }) => y.taxYear === firstYear).groups.find((g: { group: number }) => g.group === 3);
    expect([g3.openingBalance, g3.additionsHalf, g3.depreciationDeduction]).toEqual([80_000, 10_000, 22_500]);
    await expect(page.getByTestId(`pool-deduction-${firstYear}-3`)).toContainText("22,500");
    await expect(page.getByTestId(`pool-add-${firstYear}-3`)).toContainText("10,000");

    // Art. 18 repairs are UNDECLARED, and the page says that rather than 0.00
    await expect(page.getByTestId(`pool-repairs-undeclared-${firstYear}-3`)).toBeVisible();

    // the declaration is listed as what the taxpayer stated
    await expect(page.getByTestId(`declaration-3-${ANCHOR_YEAR}`)).toContainText("80,000");
  });

  test("🔴 declaring the year's Art. 18 repairs by clicking moves BOTH the pool and the deduction, by the amount the Law gives", async ({ page }) => {
    const firstYear = ANCHOR_YEAR + 1;
    await page.goto("/assets/income-tax-pool");
    const before = await (await api.get("/api/assets/income-tax-pool")).json();
    const g3Before = before.years.find((y: { taxYear: number }) => y.taxYear === firstYear).groups.find((g: { group: number }) => g.group === 3);

    await page.getByTestId(`pool-declare-${firstYear}-3`).click();
    await expect(page.getByTestId("declaration-dialog")).toBeVisible();
    await page.getByTestId("declare-repairs").fill("10000");
    await page.getByTestId("declare-submit").click();
    await expect(page.getByTestId("declaration-dialog")).toHaveCount(0);

    // cap = 4 % of 90,000 = 3,600 ⇒ 6,400 joins the pool ⇒ the deduction rises by 25 % of that
    const after = await (await api.get("/api/assets/income-tax-pool")).json();
    const g3After = after.years.find((y: { taxYear: number }) => y.taxYear === firstYear).groups.find((g: { group: number }) => g.group === 3);
    expect(g3After.repairs).toEqual({ declared: 10_000, capBase: 90_000, cap: 3_600, deductibleAsExpense: 3_600, addedToPool: 6_400 });
    expect(g3After.balanceBeforeDeduction).toBe(g3Before.balanceBeforeDeduction + 6_400);
    expect(g3After.depreciationDeduction).toBe(g3Before.depreciationDeduction + 1_600);
    await expect(page.getByTestId(`pool-repairs-undeclared-${firstYear}-3`)).toHaveCount(0);
    await expect(page.getByTestId(`pool-deduction-${firstYear}-3`)).toContainText("24,100");
  });

  test("Arabic / RTL: the working paper reads right-to-left with Arabic labels, and nothing scrolls sideways", async ({ page }) => {
    await page.goto("/assets/income-tax-pool");
    await page.evaluate(() => localStorage.setItem("ksa_lang", "ar"));
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.getByRole("heading", { name: /وعاء الإهلاك وفق المادة 17/ })).toBeVisible();
    await expect(page.getByTestId("pool-frame")).toContainText("الإطار جزء من الرقم");
    await noSidewaysScroll(page, 1280, "ar income-tax pool");
    await page.evaluate(() => localStorage.setItem("ksa_lang", "en"));
  });

  test("phone width: the working paper and the declaration dialog both fit 390 px", async ({ page }) => {
    const firstYear = ANCHOR_YEAR + 1;
    await page.setViewportSize(PHONE);
    await page.goto("/assets/income-tax-pool");
    await expect(page.getByTestId(`pool-year-${firstYear}`)).toBeVisible();
    await noSidewaysScroll(page, PHONE.width, "phone income-tax pool");
    await page.getByTestId(`pool-declare-${firstYear}-3`).click();
    await expect(page.getByTestId("declaration-dialog")).toBeVisible();
    await noSidewaysScroll(page, PHONE.width, "phone declaration dialog");
  });
});
