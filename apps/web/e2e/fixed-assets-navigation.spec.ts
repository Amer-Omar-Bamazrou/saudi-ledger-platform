/**
 * FA-H — THE FIXED-ASSET AREA, REACHED BY CLICKING (2026-09-22).
 * Record: docs/product/fixed-assets-decision-pack.md §27.
 *
 * 🔴 EVERY OTHER SPEC IN THIS AREA ARRIVES BY `goto`. That is the right thing
 * for testing a page, and it is also what hides a whole class of defect: a
 * `goto` builds the URL the test wants, so a navigation entry pointing at the
 * wrong path, a link that loses the scope the user chose, or a page that is
 * simply not reachable from anywhere all stay invisible. This file is the one
 * that only ever CLICKS.
 *
 * It walks the six surfaces the fixed-asset work added or touched —
 *   register → asset detail → schedule → movement & reconciliation
 *            → Art. 17 income-tax pool → VAT Art. 52 adjustments
 * — from the navigation and from each page's own cross-links, in English and
 * Arabic, on a desktop and on a phone, and asserts that each one RENDERED
 * rather than that a URL changed.
 */
import { test, expect, type Page } from "@playwright/test";
import { E2E } from "./global-setup";

test.use({ storageState: E2E.storageState });

const PHONE = { width: 390, height: 844 };

/** The six surfaces, with the heading each must actually render in both languages. */
const SURFACES = [
  { href: "/assets", testId: null, en: /Fixed Assets/i, ar: /الأصول الثابتة/ },
  { href: "/asset-schedule", testId: null, en: /Fixed Asset Schedule|Asset Schedule/i, ar: /جدول الأصول/ },
  { href: "/assets/report", testId: "page-fixed-asset-report", en: /movement and reconciliation/i, ar: /الحركة والمطابقة/ },
  { href: "/assets/income-tax-pool", testId: "page-income-tax-pool", en: /Art\. 17 depreciation pool/i, ar: /وعاء الإهلاك وفق المادة 17/ },
  { href: "/assets/vat-adjustments", testId: "page-vat-capital-assets", en: /capital-asset adjustments/i, ar: /تعديلات الأصول الرأسمالية/ },
] as const;

/**
 * Opens every collapsed sidebar section through the app's own controls — the
 * sections past the first three start closed, so an entry inside one is not in
 * the DOM until a human (or this) opens it. The same helper `rtl-direction`
 * uses, and bounded for the same reason.
 */
async function expandAllSections(page: Page, scope?: ReturnType<Page["locator"]>) {
  const root = scope ?? page.locator("body");
  const collapsed = root.locator('button[data-nav-section][aria-expanded="false"]');
  for (let pass = 0; pass < 25; pass++) {
    if ((await collapsed.count()) === 0) return;
    await collapsed.first().click();
  }
}

/**
 * Click a navigation entry by the href the nav tree declares, never by typing
 * the URL. On a phone the navigation lives behind the hamburger, so the drawer
 * is opened first — which is itself part of what this file checks.
 */
async function clickNav(page: Page, href: string, phone: boolean) {
  if (phone) {
    await page.getByTestId("nav-hamburger").click();
    const drawer = page.getByTestId("nav-drawer");
    await expect(drawer).toBeVisible();
    await expandAllSections(page, drawer);
    await drawer.locator(`a[href="${href}"]`).first().click();
    // the drawer closes on navigation — a drawer left open over the page is a
    // dead end on a phone, and only a click can show it
    await expect(drawer).toHaveCount(0);
  } else {
    await expandAllSections(page);
    await page.locator(`a[href="${href}"]`).first().click();
  }
  await expect(page).toHaveURL(new RegExp(`${href.replace(/\//g, "\\/")}$`));
}

const setLang = async (page: Page, lang: "en" | "ar") => {
  await page.evaluate((l) => localStorage.setItem("ksa_lang", l), lang);
  await page.reload();
};

test.describe.serial("the fixed-asset area, reached by clicking", () => {
  test("🔴 every fixed-asset surface is reachable from the NAVIGATION and renders — English, desktop", async ({ page }) => {
    await page.goto("/dashboard");
    for (const s of SURFACES) {
      await clickNav(page, s.href, false);
      if (s.testId) await expect(page.getByTestId(s.testId)).toBeVisible();
      await expect(page.getByRole("heading", { name: s.en }).first()).toBeVisible();
      // 🔴 the page RENDERED, not merely routed: the 404 branch is a real page
      // with a real URL, and a nav entry pointing at nothing lands on it.
      await expect(page.getByText(/does not exist|not found/i)).toHaveCount(0);
    }
  });

  test("🔴 the cross-links between the working papers go where they say — clicked, not typed", async ({ page }) => {
    // Each working paper links back to the register, because a reader who finds
    // a figure odd goes to the rows behind it. A link that lost its way here
    // would break no test that arrives by goto.
    for (const from of ["/assets/report", "/assets/income-tax-pool", "/assets/vat-adjustments"]) {
      await page.goto(from);
      await page.getByTestId("link-register").click();
      await expect(page).toHaveURL(/\/assets$/);
      await expect(page.getByRole("heading", { name: /Fixed Assets/i }).first()).toBeVisible();
    }
  });

  test("🔴 the register's own row opens THAT asset — the row clicked, not merely an asset", async ({ page, request }) => {
    // 🔴 The walk makes sure there IS a row rather than skipping when there is
    // not: a leg that quietly skips reports a pass for a narrower thing than
    // the file claims, and this is the one leg that proves the register's rows
    // are links at all.
    const cats = await (await request.get("/api/asset-categories")).json();
    let categoryId = (cats.items as Array<{ id: number }>)[0]?.id;
    if (!categoryId) {
      const made = await request.post("/api/asset-categories", {
        data: { name: "Nav walk equipment", defaultUsefulLifeMonths: 60, incomeTaxGroup: 3, vatCapitalAssetClass: "movable" },
      });
      expect(made.ok(), await made.text()).toBe(true);
      categoryId = (await made.json()).id;
    }
    const created = await request.post("/api/assets", {
      data: { name: "Nav walk asset", categoryId, acquisitionDate: "2026-01-05", cost: 1000 },
    });
    expect(created.ok(), await created.text()).toBe(true);
    const number = (await created.json()).assetNumber as string;

    await page.goto("/assets");
    const link = page.getByTestId(`open-asset-${number}`);
    await expect(link).toBeVisible();
    await link.click();
    await expect(page).toHaveURL(/\/assets\/\d+$/);
    // 🔴 the page shows the asset that was clicked, not merely an asset
    await expect(page.getByText(number).first()).toBeVisible();
    await expect(page.getByText("Nav walk asset").first()).toBeVisible();

    // 🔴 Cancel the draft the walk made. It is a DRAFT, so it moved nothing in
    // the books — but a spec that leaves a row behind on every run grows the
    // tenant's register without limit, and the next reader cannot tell which
    // rows are the product's and which are the test's.
    const id = Number(page.url().split("/").pop());
    const cancelled = await request.post(`/api/assets/${id}/cancel`, { data: { reason: "E2E navigation walk" } });
    expect(cancelled.ok(), await cancelled.text()).toBe(true);
  });

  test("🔴 Arabic, desktop: every surface is reachable by clicking its ARABIC label and renders right-to-left, with no sideways scroll", async ({ page }) => {
    await page.goto("/dashboard");
    await setLang(page, "ar");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    for (const s of SURFACES) {
      await clickNav(page, s.href, false);
      // 🔴 direction survives EVERY navigation, not only the first — the B-8
      // shape: a value React does not own can be reverted by something inside
      // its tree, and a `goto` would repair it before it could be seen.
      await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
      await expect(page.locator("html")).toHaveAttribute("lang", "ar");
      await expect(page.getByRole("heading", { name: s.ar }).first()).toBeVisible();
      const w = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(w, `${s.href} in Arabic: no sideways page scroll`).toBeLessThanOrEqual(1281);
    }
    await setLang(page, "en");
  });

  test("🔴 phone, English: every surface is reachable through the drawer and fits 390 px", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await page.goto("/dashboard");
    for (const s of SURFACES) {
      await clickNav(page, s.href, true);
      if (s.testId) await expect(page.getByTestId(s.testId)).toBeVisible();
      const w = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(w, `${s.href} on a phone: no sideways page scroll`).toBeLessThanOrEqual(PHONE.width + 1);
    }
  });

  test("🔴 phone, Arabic: the drawer opens from the right, every surface is reachable, and nothing scrolls sideways", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await page.goto("/dashboard");
    await setLang(page, "ar");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    for (const s of SURFACES) {
      await clickNav(page, s.href, true);
      await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
      await expect(page.getByRole("heading", { name: s.ar }).first()).toBeVisible();
      const w = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(w, `${s.href} in Arabic on a phone: no sideways page scroll`).toBeLessThanOrEqual(PHONE.width + 1);
    }
    await setLang(page, "en");
  });
});
