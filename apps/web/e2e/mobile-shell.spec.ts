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
  const { customerId, vendorId, migrationBatchId } = ids();
  if (route === "/migration/:id") return `/migration/${migrationBatchId}`;
  if (route === "/customers/:id") return `/customers/${customerId}`;
  if (route === "/customers/:id/statement") return `/customers/${customerId}/statement`;
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

/**
 * 🔴 MONEY IS NEVER CLIPPED OR OCCLUDED AT PHONE WIDTH (2026-09-15).
 *
 * ── What the spec above was actually asserting ──────────────────────────
 * `documentElement.scrollWidth <= clientWidth`: the PAGE does not scroll
 * sideways. It passed on every route while, on 22 of 62, a KPI card painted
 * `SAR 25,000.00` and the next card painted over its leading digits, so the
 * phone showed `5,000.00`. Nothing scrolled — the digits were simply under
 * another element — so the instrument said "fits". A guard whose assertion is
 * one layer coarser than the defect is the same class as the Arabic sweep
 * counting strings: green, and describing something else.
 *
 * ── And what the FIRST version of this block asserted ───────────────────
 * It skipped any figure inside an ancestor whose computed `overflow` matched
 * auto|scroll — meant for table wrappers, but the app's content wrapper is
 * `overflow-y-auto overflow-x-hidden`, whose computed shorthand is
 * "hidden auto". Every card on every page was skipped; only the planted
 * positive (fixed to <body>) was checked. Green on the PRE-fix pages, 58/58.
 * Caught by running the checker against the code it was meant to fail on —
 * the check that is never optional. Now: an ancestor is "a scroller" only if
 * it can actually scroll sideways (scrollWidth > clientWidth), the walk stops
 * at <main>, each figure is scrolled into view before measuring, and the
 * planted positive lives INSIDE the content wrapper.
 *
 * ── What this asserts ───────────────────────────────────────────────────
 * For every text node that LOOKS like money and is not inside a container
 * that really scrolls sideways, both ends of the RENDERED text resolve via
 * `elementFromPoint` to the text's own element. Painted-under, clipped by
 * an ancestor, and outside the viewport all fail the same way.
 */
const MONEY_CHECK = () => {
  const money = /(?:SAR|ر\.س)\s*[\d,]+\.\d{2}|(?:^|\s)[\d,]{2,}\.\d{2}(?:\s|$)/;
  const main = document.querySelector("main") ?? document.body;
  const scrollsSideways = (el: Element | null): boolean => {
    for (let n = el; n && n !== main && n !== document.body; n = n.parentElement) {
      const o = getComputedStyle(n);
      if (/(auto|scroll)/.test(o.overflowX) && n.scrollWidth > n.clientWidth + 1) return true;
    }
    return false;
  };
  const bad: string[] = [];
  const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let node: Node | null;
  while ((node = walker.nextNode())) if (money.test(node.textContent ?? "")) nodes.push(node as Text);
  for (const t of nodes) {
    const el = t.parentElement;
    if (!el || scrollsSideways(el)) continue;
    el.scrollIntoView({ block: "center", inline: "nearest" });
    const range = document.createRange();
    range.selectNodeContents(t);
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const y = rect.top + rect.height / 2;
    for (const x of [rect.left + 1, rect.right - 1]) {
      const hit = document.elementFromPoint(x, y);
      // An ANCESTOR as the hit means the text ran past its own box into a parent's
      // padding — still visible, unless an ancestor on the way CLIPS and the point
      // lies outside that ancestor's box. The first version flagged every ancestor
      // hit; on the Linux runner's wider fonts "-SAR 4,340.00" reached its card's
      // padding on three pages and was reported hidden while plainly on screen
      // (2026-09-15). The planted positive below is exactly the clipping case.
      const clippedBy = (() => {
        if (!hit || !hit.contains(el)) return null;
        for (let n: HTMLElement | null = el ? el.parentElement : null; n; n = n.parentElement) {
          const o = getComputedStyle(n);
          if (/(hidden|clip)/.test(o.overflowX) || /(hidden|clip)/.test(o.overflowY)) {
            const r = n.getBoundingClientRect();
            if (x < r.left || x > r.right || y < r.top || y > r.bottom) return n;
          }
          if (n === hit) break;
        }
        return null;
      })();
      const visible = !!hit && (hit === el || el.contains(hit) || (hit.contains(el) && !clippedBy));
      if (!visible) {
        bad.push(`${(t.textContent ?? "").trim()} — end at x=${Math.round(x)} is ${hit ? "under <" + hit.tagName.toLowerCase() + (hit.className ? "." + String(hit.className).split(" ")[0] : "") + ">" : "outside the viewport"}`);
        break;
      }
    }
  }
  return bad;
};

test.describe("L2 — money is never clipped or occluded at phone width", () => {
  const crawlable = Object.entries(EXPECTATIONS).filter(([, kind]) => kind === "app" || kind === "param");

  test("🔴 the checker SEES a hidden figure INSIDE the content wrapper (planted positive)", async ({ page }) => {
    await page.goto("/", { waitUntil: "networkidle" });
    await page.evaluate(() => {
      const host = document.querySelector("main") ?? document.body;
      const box = document.createElement("div");
      box.style.cssText = "width:80px;overflow:hidden;background:#000";
      box.innerHTML = '<div style="white-space:nowrap;font-size:24px">SAR 25,000,000.00</div>';
      host.appendChild(box);
    });
    const bad = await page.evaluate(MONEY_CHECK);
    expect(bad.some((b) => b.startsWith("SAR 25,000,000.00")), `checker must report the planted figure; got ${JSON.stringify(bad)}`).toBe(true);
  });

  for (const [route] of crawlable) {
    test(`${route} shows every figure whole`, async ({ page }) => {
      await page.goto(concrete(route), { waitUntil: "networkidle" });
      const bad = await page.evaluate(MONEY_CHECK);
      expect(bad, `${route} at ${PHONE.width}px hides part of a figure:\n  ${bad.join("\n  ")}`).toEqual([]);
    });
  }
});
