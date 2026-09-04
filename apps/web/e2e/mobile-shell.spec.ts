import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { E2E, SEEDED_IDS_PATH, type SeededIds } from "./global-setup";
import { EXPECTATIONS } from "./routes";

/**
 * L2 — THE RESPONSIVE SHELL, ASSERTED AS A PROPERTY, PER ROUTE.
 *
 * The launch blocker: `Layout.tsx` had zero breakpoints, so on a phone the
 * app was a horizontal-scroll desktop page for a mobile-first customer. The
 * fix has two halves and each gets its own kind of assertion:
 *
 *  1. 🔴 NO ROUTE SCROLLS THE PAGE SIDEWAYS AT PHONE WIDTH — checked against
 *     the SAME route inventory the smoke crawl uses, so a new page cannot
 *     ship un-checked (the frame is the inventory, not a walk). Wide content
 *     scrolls inside its own container; the PAGE does not. The tolerance is
 *     1px for scrollbar rounding.
 *  2. The drawer IS the navigation on a phone: the hamburger opens it, a nav
 *     click navigates AND dismisses it, and in Arabic the same drawer opens
 *     from the inline-start side purely via `dir` (logical properties — no
 *     RTL override layer involvement).
 *
 * iPhone-13-class viewport; the number is stated so a future reader knows
 * what "phone" meant when this was written.
 */

const PHONE = { width: 390, height: 844 };

function ids(): SeededIds {
  return JSON.parse(readFileSync(SEEDED_IDS_PATH, "utf8")) as SeededIds;
}

function concrete(route: string): string {
  const { customerId, vendorId } = ids();
  if (route === "/customers/:id") return `/customers/${customerId}`;
  if (route === "/vendors/:id") return `/vendors/${vendorId}`;
  if (route === "/coming-soon/:slug") return "/coming-soon/transfers";
  return route;
}

test.use({ storageState: E2E.storageState, viewport: PHONE });

test.describe("L2 — no page scrolls sideways at phone width", () => {
  const crawlable = Object.entries(EXPECTATIONS).filter(([, kind]) => kind === "app" || kind === "param");

  test("the inventory is not vacuous", () => {
    expect(crawlable.length).toBeGreaterThan(20);
  });

  for (const [route] of crawlable) {
    test(`${route} fits`, async ({ page }) => {
      await page.goto(concrete(route), { waitUntil: "networkidle" });
      const { scrollWidth, clientWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(
        scrollWidth,
        `${route} scrolls the PAGE sideways at ${PHONE.width}px — wide content must scroll inside its own container (wrap the table/chart in overflow-x-auto)`,
      ).toBeLessThanOrEqual(clientWidth + 1);
    });
  }
});

test.describe("L2 — the drawer is the phone's navigation", () => {
  test("🔴 hamburger opens the drawer; a nav click navigates AND dismisses it", async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });

    // Below md the desktop aside is gone and the hamburger is the way in.
    await expect(page.getByTestId("nav-hamburger")).toBeVisible();
    await expect(page.getByTestId("nav-drawer")).toHaveCount(0);

    await page.getByTestId("nav-hamburger").click();
    const drawer = page.getByTestId("nav-drawer");
    await expect(drawer).toBeVisible();

    // The SAME nav tree renders here — click a real destination.
    await drawer.getByRole("link", { name: /invoices/i }).first().click();
    await expect(page).toHaveURL(/\/invoices/);
    // Navigating IS the dismissal — a drawer left open over the new page
    // would make every navigation a two-step chore.
    await expect(page.getByTestId("nav-drawer")).toHaveCount(0);
  });

  test("Escape and the backdrop both dismiss", async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });
    await page.getByTestId("nav-hamburger").click();
    await expect(page.getByTestId("nav-drawer")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("nav-drawer")).toHaveCount(0);

    await page.getByTestId("nav-hamburger").click();
    await expect(page.getByTestId("nav-drawer")).toBeVisible();
    await page.getByTestId("nav-drawer-backdrop").click({ position: { x: PHONE.width - 10, y: 400 } });
    await expect(page.getByTestId("nav-drawer")).toHaveCount(0);
  });

  test("in Arabic the drawer opens from the inline-start side — logical properties, no override", async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });
    // Switch language via localStorage the way LanguageContext persists it,
    // then reload so dir is set before first paint (the index.html script).
    await page.evaluate(() => localStorage.setItem("ksa_lang", "ar"));
    await page.reload({ waitUntil: "networkidle" });
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");

    await page.getByTestId("nav-hamburger").click();
    const box = await page.getByTestId("nav-drawer").boundingBox();
    expect(box, "drawer must render").not.toBeNull();
    // In RTL, inline-start is the RIGHT edge: the drawer hugs it.
    expect(Math.abs(box!.x + box!.width - PHONE.width)).toBeLessThanOrEqual(2);
  });
});
